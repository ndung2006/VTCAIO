'use client';
// TranscodePanel — Tab "Truyền dẫn" của 1 kênh (docs/16 §8.4).
// Bật/tắt + engine + loopback + preset multi-select + bảng outputs
// (SRT listen/caller, RTMP push, UDP multicast) + nút Test + trạng thái live.
// Hai tầng backend: đổi enabled/loopbackPort khi RUNNING bị 400 (stop source
// trước); đổi endpoint thì hot-restart ffmpeg.
import { useCallback, useEffect, useState } from 'react';
import {
  tcApi,
  validateChannelTranscode,
  validateOutput,
  type ChannelTranscode,
  type TcStatus,
  type TranscodeEngine,
  type TranscodeOutput,
  type TranscodeOutputType,
  type TranscodePreset,
} from '@/lib/transcode';

const OUTPUT_TYPES: { v: TranscodeOutputType; label: string }[] = [
  { v: 'srt-listen', label: 'SRT Listener — mở cổng, ngoài kéo ta (mặc định VTCAIO)' },
  { v: 'srt-caller', label: 'SRT Caller — ta đẩy sang họ (chỉ khi đối tác yêu cầu)' },
  { v: 'rtmp-push', label: 'RTMP đẩy đi' },
  { v: 'udp-mcast', label: 'UDP multicast (kiểm tra LAN)' },
];

const ENGINES: { v: TranscodeEngine; label: string }[] = [
  { v: 'cpu', label: 'CPU — libx264 (mặc định)' },
  { v: 'nvenc', label: 'GPU NVIDIA — h264_nvenc' },
  { v: 'qsv', label: 'Intel QSV (giữ chỗ)' },
  { v: 'vaapi', label: 'VAAPI (giữ chỗ)' },
];

function emptyOutput(presetId: string): TranscodeOutput {
  return { type: 'srt-listen', presetId, enabled: true, port: 9001 };
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function TranscodePanel(props: {
  sourceId: string;
  channelName: string;
  sourceStatus: string;
  initial: ChannelTranscode | undefined;
  onSaved: () => void;
}): React.JSX.Element {
  const { sourceId, channelName, sourceStatus, initial, onSaved } = props;
  const [presets, setPresets] = useState<TranscodePreset[]>([]);
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [engine, setEngine] = useState<TranscodeEngine>(initial?.engine ?? 'cpu');
  const [loopback, setLoopback] = useState(initial !== undefined ? String(initial.loopbackPort) : '6001');
  const [presetIds, setPresetIds] = useState<string[]>(initial?.presetIds ?? []);
  const [outputs, setOutputs] = useState<TranscodeOutput[]>(initial?.outputs ?? []);
  const [status, setStatus] = useState<TcStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [testingPort, setTestingPort] = useState<number | null>(null);

  const key = `${sourceId}/${channelName}`;
  const running = sourceStatus === 'RUNNING';

  useEffect(() => {
    setEnabled(initial?.enabled === true);
    setEngine(initial?.engine ?? 'cpu');
    setLoopback(initial !== undefined ? String(initial.loopbackPort) : '6001');
    setPresetIds(initial?.presetIds ?? []);
    setOutputs(initial?.outputs ?? []);
  }, [initial, channelName]);

  useEffect(() => {
    tcApi.presets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const reloadStatus = useCallback(async () => {
    try {
      const all = await tcApi.tcStatus();
      setStatus(all.find((s) => s.key === key) ?? null);
    } catch {
      setStatus(null);
    }
  }, [key]);

  useEffect(() => {
    void reloadStatus();
    const t = setInterval(() => void reloadStatus(), 5000);
    return () => clearInterval(t);
  }, [reloadStatus]);

  const togglePreset = (id: string): void => {
    setPresetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const setOutput = (i: number, patch: Partial<TranscodeOutput>): void => {
    setOutputs((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  };

  const save = async (): Promise<void> => {
    const body: ChannelTranscode = {
      enabled,
      loopbackPort: Number(loopback),
      presetIds,
      outputs,
      engine,
    };
    const err = validateChannelTranscode(body);
    if (err !== null) {
      setMsg(err);
      return;
    }
    setBusy('save');
    setMsg('');
    try {
      const r = await tcApi.updateChannelTranscode(sourceId, channelName, body);
      setMsg(r.restarted ? 'Đã lưu + restart ffmpeg (hot-update, không động tsp).' : 'Đã lưu.');
      onSaved();
      await reloadStatus();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Lưu thất bại');
    } finally {
      setBusy('');
    }
  };

  const doTc = async (kind: 'start' | 'stop'): Promise<void> => {
    setBusy(kind);
    setMsg('');
    try {
      if (kind === 'start') await tcApi.tcStart(sourceId, channelName);
      else await tcApi.tcStop(sourceId, channelName);
      setMsg(kind === 'start' ? 'Đã start ffmpeg.' : 'Đã stop ffmpeg (tsp vẫn chạy).');
      await reloadStatus();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Thất bại');
    } finally {
      setBusy('');
    }
  };

  const doTest = async (port: number): Promise<void> => {
    setTestingPort(port);
    setMsg('');
    try {
      const r = await tcApi.srtTest(sourceId, channelName, port);
      setMsg(r.detail);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Test thất bại');
    } finally {
      setTestingPort(null);
    }
  };

  const inputCls = 'mt-1 w-full rounded border px-2 py-1.5 text-sm';
  const firstPreset = presets[0]?.id ?? 'p720';

  return (
    <div className="space-y-3 rounded-xl bg-white p-4 shadow">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">TRUYỀN DẪN (Transcode + SRT/RTMP/UDP)</h2>
        <span className={`text-sm ${status !== null ? (status.stale ? 'text-amber-600' : status.waiting ? 'text-sky-600' : 'text-green-600') : 'text-slate-400'}`}>
          {status !== null
            ? status.waiting
              ? '◌ chờ frame đầu (thường là chờ caller SRT, hoặc input kẹt)'
              : `● ffmpeg chạy${status.stale ? ' (STALE — fps đứng)' : ''}`
            : '○ ffmpeg chưa chạy'}
        </span>
        {status !== null && (
          <span className="text-xs text-slate-500">
            fps {status.fps ?? '—'} · {status.bitrateKbps !== null ? `${status.bitrateKbps}k` : '—'} · cập nhật {fmtTime(status.lastProgressAt)}
            {status.crashes > 0 ? ` · crash ${status.crashes} lần` : ''}
          </span>
        )}
        {status?.lastError !== null && status?.lastError !== undefined && status.lastError !== '' && (
          <pre className="max-h-24 overflow-auto rounded bg-red-50 p-2 font-mono text-xs text-red-700">
            Lỗi ffmpeg/output mới nhất:{'\n'}{status.lastError}
          </pre>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={() => void doTc('start')} disabled={busy !== '' || !running} className="rounded bg-green-600 px-3 py-1 text-sm text-white disabled:opacity-50">
            Start ffmpeg
          </button>
          <button onClick={() => void doTc('stop')} disabled={busy !== ''} className="rounded bg-amber-500 px-3 py-1 text-sm text-white disabled:opacity-50">
            Stop ffmpeg
          </button>
        </div>
      </div>
      {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
      {!running && (
        <p className="text-sm text-slate-500">Source chưa RUNNING — start source thì ffmpeg tự chạy theo (sau ~1s). Nút Start ffmpeg tay chỉ dùng khi source đang chạy.</p>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Bật transcode kênh này {running && <span className="text-xs text-red-600">(đổi khi RUNNING cần stop source)</span>}
        </label>
        <label className="text-sm">
          Engine
          <select value={engine} onChange={(e) => setEngine(e.target.value as TranscodeEngine)} className={inputCls}>
            {ENGINES.map((x) => (
              <option key={x.v} value={x.v}>{x.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Cổng loopback (6000–6099)
          <input value={loopback} onChange={(e) => setLoopback(e.target.value)} inputMode="numeric" className={`${inputCls} font-mono`} />
        </label>
      </div>

      <div>
        <p className="text-sm font-semibold">Rendition (preset)</p>
        {presets.length === 0 && <p className="text-sm text-slate-500">Chưa có preset — tạo ở trang Transcode trước.</p>}
        <div className="mt-1 flex flex-wrap gap-2">
          {presets.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 rounded border px-2 py-1 text-sm">
              <input type="checkbox" checked={presetIds.includes(p.id)} onChange={() => togglePreset(p.id)} />
              <span className="font-mono font-semibold">{p.name}</span>
              <span className="text-xs text-slate-500">
                {p.video === null ? 'audio' : `${p.video.width}×${p.video.height} ${p.video.bitrateKbps}k`}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Đầu ra (1 output = 1 rendition)</p>
          <button
            onClick={() => setOutputs((prev) => [...prev, emptyOutput(firstPreset)])}
            className="rounded bg-slate-200 px-2 py-1 text-xs"
          >
            + Thêm output
          </button>
        </div>
        {outputs.map((o, i) => {
          const verr = validateOutput(o);
          return (
            <div key={i} className="space-y-2 rounded border p-2">
              <div className="grid gap-2 md:grid-cols-4">
                <label className="text-xs">
                  Loại
                  <select value={o.type} onChange={(e) => setOutput(i, { type: e.target.value as TranscodeOutputType })} className={inputCls}>
                    {OUTPUT_TYPES.map((x) => (
                      <option key={x.v} value={x.v}>{x.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  Rendition
                  <select value={o.presetId} onChange={(e) => setOutput(i, { presetId: e.target.value })} className={inputCls}>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs">
                  Cổng {o.type === 'srt-caller' ? '(phía họ)' : o.type === 'udp-mcast' ? '(nhóm nhận)' : ''}
                  <input
                    value={o.port ?? ''}
                    onChange={(e) => setOutput(i, { port: e.target.value === '' ? undefined : Number(e.target.value) })}
                    inputMode="numeric"
                    placeholder={o.type === 'srt-listen' ? '9001' : o.type === 'udp-mcast' ? '7001' : 'port'}
                    className={`${inputCls} font-mono`}
                  />
                </label>
                <div className="flex items-end gap-2">
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" checked={o.enabled} onChange={(e) => setOutput(i, { enabled: e.target.checked })} />
                    Bật
                  </label>
                  <button onClick={() => setOutputs((prev) => prev.filter((_, idx) => idx !== i))} className="rounded bg-slate-200 px-2 py-1 text-xs">
                    Bỏ
                  </button>
                  {(o.type === 'srt-listen' || o.type === 'srt-caller') && o.enabled && o.port !== undefined && (
                    <button
                      onClick={() => void doTest(o.port as number)}
                      disabled={testingPort !== null}
                      title={o.type === 'srt-caller' ? 'Bắt tay tới listener phía họ' : 'Đóng vai caller bắt tay vào cổng này'}
                      className="rounded bg-sky-700 px-2 py-1 text-xs text-white disabled:opacity-50"
                    >
                      {testingPort === o.port ? 'Đang test…' : 'Test'}
                    </button>
                  )}
                </div>
              </div>
              {(o.type === 'srt-listen' || o.type === 'srt-caller') && (
                <div className="grid gap-2 md:grid-cols-3">
                  {o.type === 'srt-caller' && (
                    <label className="text-xs">
                      Host phía họ
                      <input value={o.host ?? ''} onChange={(e) => setOutput(i, { host: e.target.value })} placeholder="203.0.113.10" className={`${inputCls} font-mono`} />
                    </label>
                  )}
                  <label className="text-xs">
                    StreamID (trống = tên kênh)
                    <input value={o.streamId ?? ''} onChange={(e) => setOutput(i, { streamId: e.target.value })} className={`${inputCls} font-mono`} />
                  </label>
                  <div className="text-xs">
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={o.passphraseRef !== undefined}
                        onChange={(e) => setOutput(i, { passphraseRef: e.target.checked ? '' : undefined })}
                      />
                      Mã hóa SRT (passphrase ≥16 ký tự ở Prod)
                    </label>
                    <input
                      value={o.passphraseRef ?? ''}
                      onChange={(e) => setOutput(i, { passphraseRef: e.target.value })}
                      disabled={o.passphraseRef === undefined}
                      placeholder="ref trong VTC_SRT_PASSPHRASES (VD vtvgo)"
                      className={`${inputCls} mt-1 font-mono disabled:bg-slate-100`}
                    />
                    {o.passphraseRef !== undefined && (
                      <p className="mt-1 text-slate-500">Ref phải có sẵn trong env backend (thêm rồi restart backend) — secret không lưu vào DB.</p>
                    )}
                  </div>
                </div>
              )}
              {o.type === 'rtmp-push' && (
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-xs">
                    URL app (VD rtmp://ip-ho/live)
                    <input value={o.url ?? ''} onChange={(e) => setOutput(i, { url: e.target.value })} className={`${inputCls} font-mono`} />
                  </label>
                  <label className="text-xs">
                    Stream key (trống = URL đã đủ, kiểu Wowza)
                    <input value={o.streamKey ?? ''} onChange={(e) => setOutput(i, { streamKey: e.target.value })} className={`${inputCls} font-mono`} />
                  </label>
                </div>
              )}
              {o.type === 'udp-mcast' && (
                <div className="grid gap-2 md:grid-cols-3">
                  <label className="text-xs">
                    Nhóm multicast (224.x–238.x)
                    <input value={o.group ?? ''} onChange={(e) => setOutput(i, { group: e.target.value })} placeholder="236.30.233.1" className={`${inputCls} font-mono`} />
                  </label>
                  <label className="text-xs">
                    IP card phát ra
                    <input value={o.localAddr ?? ''} onChange={(e) => setOutput(i, { localAddr: e.target.value })} placeholder="192.168.20.200" className={`${inputCls} font-mono`} />
                  </label>
                  <label className="text-xs">
                    TTL (mặc định 1)
                    <input value={o.ttl ?? ''} onChange={(e) => setOutput(i, { ttl: e.target.value === '' ? undefined : Number(e.target.value) })} inputMode="numeric" className={`${inputCls} font-mono`} />
                  </label>
                </div>
              )}
              {verr !== null && <p className="text-xs text-red-600">{verr}</p>}
            </div>
          );
        })}
        {outputs.length === 0 && <p className="text-sm text-slate-500">Chưa có output nào — thêm ít nhất 1 (VD SRT mở cổng 9001).</p>}
      </div>

      <div>
        <button onClick={save} disabled={busy !== ''} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          Lưu truyền dẫn
        </button>
      </div>
    </div>
  );
}
