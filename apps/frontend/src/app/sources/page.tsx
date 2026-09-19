'use client';
// Trang /sources: CRUD đầy đủ nguồn tín hiệu + điều khiển Start/Stop + xem conf.
// Backend đã có API (POST/PUT/DELETE/start/stop/preview-conf), persist JSON nên
// restart container không mất cấu hình.
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { RequireAdmin } from '@/lib/role';
import { api, type Source, type SourceInput } from '@/lib/api';
import { tcApi, validateCapture, validatePuller, type ChannelTranscode, type SourceCapture, type SourceInputKind, type SourcePuller, type TcStatus } from '@/lib/transcode';

interface ChannelDraft {
  name: string;
  serviceId: string;
  isLive: boolean;
  /** Giữ nguyên qua form sửa (form không edit các field này — mất là bay cấu hình). */
  transcode?: ChannelTranscode;
  partnerChannelId?: number | null;
  published?: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const EMPTY_CHANNEL: ChannelDraft = { name: '', serviceId: '', isLive: true };

function statusColor(s: Source['status']): string {
  if (s === 'RUNNING') return 'text-green-600';
  if (s === 'ERROR') return 'text-red-600';
  return 'text-slate-500';
}

export default function SourcesPage(): React.JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [tcStatus, setTcStatus] = useState<TcStatus[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  // Form thêm/sửa
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fId, setFId] = useState('');
  const [fInputKind, setFInputKind] = useState<SourceInputKind>('ip');
  // Capture baseband (Encode SDI/HDMI — docs/16 §18).
  const [fCapDevice, setFCapDevice] = useState('');
  const [fCapUdpPort, setFCapUdpPort] = useState('6201');
  const [fCapFormat, setFCapFormat] = useState('');
  const [fCapConnection, setFCapConnection] = useState('sdi');
  const [fInput, setFInput] = useState('ip 239.1.1.1:5000');
  const [fRecordAll, setFRecordAll] = useState(true);
  const [fRetention, setFRetention] = useState('30');
  const [fChannels, setFChannels] = useState<ChannelDraft[]>([{ ...EMPTY_CHANNEL }]);
  // Puller RTMP→UDP (docs/16 §5): nguồn RTMP qua MediaMTX, tsp ingest UDP localhost.
  const [fPullerOn, setFPullerOn] = useState(false);
  const [fRtmpUrl, setFRtmpUrl] = useState('rtmp://127.0.0.1:1935/live');
  const [fStreamKey, setFStreamKey] = useState('');
  const [fUdpPort, setFUdpPort] = useState('6101');
  // Preview conf + xóa
  const [preview, setPreview] = useState<{ id: string; conf: string; liveCount: number } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Source | null>(null);
  // Quét luồng (PAT/SDT → sổ chọn kênh, khỏi gõ SID tay)
  const [scanning, setScanning] = useState(false);
  const [scanProgs, setScanProgs] = useState<{ serviceId: number; name: string | null }[]>([]);
  const [scanSel, setScanSel] = useState<number[]>([]);
  const [scanMsg, setScanMsg] = useState('');

  const reload = useCallback(async () => {
    try {
      setSources(await api.sources());
    } catch {
      setSources([]);
    }
    try {
      setTcStatus(await tcApi.tcStatus());
    } catch {
      setTcStatus([]);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [reload]);

  const resetScan = (): void => {
    setScanProgs([]);
    setScanSel([]);
    setScanMsg('');
  };

  const openCreate = (): void => {
    setEditingId(null);
    setFId('');
    setFInputKind('ip');
    setFCapDevice('');
    setFCapUdpPort('6201');
    setFCapFormat('');
    setFCapConnection('sdi');
    setFInput('ip 239.1.1.1:5000');
    setFRecordAll(true);
    setFRetention('30');
    setFChannels([{ ...EMPTY_CHANNEL }]);
    setFPullerOn(false);
    setFRtmpUrl('rtmp://127.0.0.1:1935/live');
    setFStreamKey('');
    setFUdpPort('6101');
    setMsg('');
    resetScan();
    setShowForm(true);
  };

  const openEdit = (s: Source): void => {
    if (s.status === 'RUNNING') {
      setMsg(`Source ${s.id} đang RUNNING — Stop trước khi sửa.`);
      return;
    }
    setEditingId(s.id);
    setFId(s.id);
    setFInputKind(s.inputKind ?? 'ip');
    setFCapDevice(s.capture?.device ?? '');
    setFCapUdpPort(s.capture !== undefined ? String(s.capture.udpPort) : '6201');
    setFCapFormat(s.capture?.formatCode ?? '');
    setFCapConnection(s.capture?.connection ?? 'sdi');
    setFInput(s.input);
    setFRecordAll(s.recordAll);
    setFRetention(s.retentionDays !== undefined ? String(s.retentionDays) : '30');
    setFChannels(
      s.channels.length > 0
        ? s.channels.map((c) => ({
            name: c.name,
            serviceId: String(c.serviceId),
            isLive: c.isLive,
            transcode: c.transcode,
            partnerChannelId: c.partnerChannelId,
            published: c.published,
          }))
        : [{ ...EMPTY_CHANNEL }],
    );
    setFPullerOn(s.puller !== undefined);
    setFRtmpUrl(s.puller?.rtmpUrl ?? 'rtmp://127.0.0.1:1935/live');
    setFStreamKey(s.puller?.streamKey ?? '');
    setFUdpPort(s.puller !== undefined ? String(s.puller.udpPort) : '6101');
    setMsg('');
    resetScan();
    setShowForm(true);
  };

  /** Tên SDT (có dấu/cách) → tên kênh hợp lệ [A-Za-z0-9_-]; rỗng thì kenh-<sid>. */
  const sanitizeName = (raw: string | null, sid: number): string => {
    const clean = (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    return clean === '' ? `kenh-${sid}` : clean;
  };

  const doScan = async (): Promise<void> => {
    if (fInput.trim() === '' || scanning) return;
    setScanning(true);
    setScanMsg('Đang quét luồng (~6s, tốn 1 tiến trình tsp tạm)…');
    try {
      const r = await api.streamScan(fInput.trim());
      setScanProgs(r.programs);
      const have = new Set(fChannels.map((c) => Number(c.serviceId)).filter((n) => Number.isInteger(n)));
      setScanSel(r.programs.filter((p) => !have.has(p.serviceId)).map((p) => p.serviceId));
      setScanMsg(
        r.programs.length === 0
          ? 'Không thấy chương trình nào — kiểm tra input đúng nhóm multicast đang có tín hiệu.'
          : `Thấy ${r.programs.length} chương trình (${(r.elapsedMs / 1000).toFixed(1)}s) — luồng ` +
            `${r.programs.length === 1 ? 'đơn chương trình (SPTS)' : 'đa chương trình (MPTS)'}. ` +
            `Tích chọn rồi bấm "Thêm kênh đã chọn".`,
      );
    } catch (err) {
      setScanProgs([]);
      setScanSel([]);
      setScanMsg(err instanceof Error ? err.message : 'Quét thất bại');
    } finally {
      setScanning(false);
    }
  };

  const addSelected = (): void => {
    const haveSid = new Set(fChannels.map((c) => Number(c.serviceId)));
    const haveName = new Set(fChannels.map((c) => c.name.trim()).filter((n) => n !== ''));
    const rows: ChannelDraft[] = [];
    for (const sid of scanSel) {
      const p = scanProgs.find((x) => x.serviceId === sid);
      if (p === undefined || haveSid.has(sid)) continue;
      let name = sanitizeName(p.name, sid);
      if (haveName.has(name)) name = `${name}-${sid}`;
      haveSid.add(sid);
      haveName.add(name);
      rows.push({ name, serviceId: String(sid), isLive: true });
    }
    if (rows.length === 0) return;
    setFChannels((prev) => {
      const onlyEmpty = prev.length === 1 && prev[0]?.name.trim() === '' && prev[0]?.serviceId.trim() === '';
      return onlyEmpty ? rows : [...prev, ...rows];
    });
    setScanSel([]);
  };

  const validate = (): SourceInput | null => {
    const id = editingId ?? fId.trim();
    if (!ID_RE.test(id)) {
      setMsg('ID nguồn chỉ cho phép chữ/số/_/- (VD mux-1).');
      return null;
    }
    if (fInput.trim() === '') {
      setMsg('Input không được rỗng (VD "ip 239.1.1.1:5000").');
      return null;
    }
    const channels = [];
    for (let i = 0; i < fChannels.length; i++) {
      const c = fChannels[i];
      if (c === undefined) continue;
      if (!ID_RE.test(c.name.trim())) {
        setMsg(`Kênh #${i + 1}: tên chỉ cho phép chữ/số/_/- (không dấu cách).`);
        return null;
      }
      const sid = Number(c.serviceId);
      if (!Number.isInteger(sid) || sid < 1 || sid > 65535) {
        setMsg(`Kênh ${c.name}: Service ID phải là số nguyên 1..65535 (0 đặt trước cho NIT).`);
        return null;
      }
      // Giữ nguyên transcode/mapping/published khi sửa (form không edit các field này).
      channels.push({
        name: c.name.trim(),
        serviceId: sid,
        isLive: c.isLive,
        transcode: c.transcode,
        partnerChannelId: c.partnerChannelId,
        published: c.published,
      });
    }
    if (channels.length === 0) {
      setMsg('Cần ít nhất 1 kênh.');
      return null;
    }
    const names = channels.map((c) => c.name);
    const dupInForm = names.find((n, i) => names.indexOf(n) !== i);
    if (dupInForm !== undefined) {
      setMsg(`Tên kênh "${dupInForm}" bị trùng trong form (thư mục HLS sẽ đè nhau).`);
      return null;
    }
    const clash = sources.find(
      (s) => (editingId === null || s.id !== editingId) && s.channels.some((c) => names.includes(c.name)),
    );
    if (clash !== undefined) {
      const bad = channels.find((c) => clash.channels.some((x) => x.name === c.name))?.name ?? '';
      setMsg(`Tên kênh "${bad}" đã có ở nguồn ${clash.id} — tên kênh phải duy nhất toàn hệ thống.`);
      return null;
    }
    const liveCount = channels.filter((c) => c.isLive).length;
    if (liveCount === 0 && !fRecordAll) {
      setMsg('Cấu hình vô nghĩa: 0 kênh live + không ghi catchup (recordAll=false). Hãy bật ít nhất 1 kênh live hoặc bật ghi catchup.');
      return null;
    }
    // Tắt ghi đĩa (chỉ live) thì số ngày lưu chiểu vô nghĩa — bỏ qua, không gửi.
    const retention = !fRecordAll || fRetention.trim() === '' ? undefined : Number(fRetention);
    if (retention !== undefined && (!Number.isInteger(retention) || retention < 1 || retention > 365)) {
      setMsg('Số ngày lưu chiểu phải 1..365 (để trống = mặc định hệ thống).');
      return null;
    }
    let puller: SourcePuller | undefined;
    if (fPullerOn) {
      puller = { rtmpUrl: fRtmpUrl.trim(), streamKey: fStreamKey.trim(), udpPort: Number(fUdpPort) };
      const perr = validatePuller(puller);
      if (perr !== null) {
        setMsg(`Puller RTMP: ${perr}.`);
        return null;
      }
    }
    const body: SourceInput = { id, inputKind: fInputKind, input: fInput.trim(), channels, recordAll: fRecordAll };
    if (fInputKind === 'sdi' || fInputKind === 'hdmi') {
      const cap: SourceCapture = {
        device: fCapDevice.trim(),
        connection: fCapConnection.trim() === '' ? undefined : fCapConnection.trim(),
        formatCode: fCapFormat.trim() === '' ? undefined : fCapFormat.trim(),
        udpPort: Number(fCapUdpPort),
      };
      const cerr = validateCapture(cap);
      if (cerr !== null) {
        setMsg(`Capture ${fInputKind.toUpperCase()}: ${cerr} (input phải là UDP agent 6200..6299).`);
        return null;
      }
      body.capture = cap;
    }
    if (retention !== undefined) body.retentionDays = retention;
    if (puller !== undefined) body.puller = puller;
    return body;
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const body = validate();
    if (body === null) return;
    setBusy('save');
    setMsg('');
    try {
      if (editingId === null) {
        await api.createSource(body);
        setMsg(`Đã tạo nguồn ${body.id}. Nhấn Start để chạy TSDuck.`);
      } else {
        const { id: _omit, ...patch } = body;
        await api.updateSource(editingId, patch);
        setMsg(`Đã cập nhật nguồn ${editingId}.`);
      }
      setShowForm(false);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Lưu thất bại');
    } finally {
      setBusy('');
    }
  };

  const doStart = async (s: Source): Promise<void> => {
    setBusy(`start:${s.id}`);
    setMsg('');
    try {
      await api.startSource(s.id);
      setMsg(`Đã Start ${s.id} (pid mới).`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Start thất bại');
    } finally {
      setBusy('');
    }
  };

  const doStop = async (s: Source): Promise<void> => {
    setBusy(`stop:${s.id}`);
    setMsg('');
    try {
      await api.stopSource(s.id);
      setMsg(`Đã Stop ${s.id}.`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Stop thất bại');
    } finally {
      setBusy('');
    }
  };

  const doPreview = async (s: Source): Promise<void> => {
    setMsg('');
    try {
      const p = await api.previewConf(s.id);
      setPreview({ id: s.id, conf: p.conf, liveCount: p.liveCount });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Không xem được conf');
    }
  };

  const doDelete = async (): Promise<void> => {
    if (confirmDel === null) return;
    setBusy(`del:${confirmDel.id}`);
    try {
      await api.deleteSource(confirmDel.id);
      setMsg(`Đã xóa nguồn ${confirmDel.id} (kèm dừng process nếu đang chạy).`);
      setConfirmDel(null);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Xóa thất bại');
    } finally {
      setBusy('');
    }
  };

  const setChannel = (i: number, patch: Partial<ChannelDraft>): void => {
    setFChannels((prev) => prev.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };

  return (
    <RequireAdmin>
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold">NGUỒN TÍN HIỆU</h1>
            <button onClick={openCreate} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
              + Thêm nguồn
            </button>
          </div>
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

          {sources.length === 0 && (
            <p className="rounded-xl bg-white p-4 text-sm text-slate-500 shadow">
              Chưa có nguồn nào. Nhấn “Thêm nguồn” để khai báo luồng Multicast đầu tiên (VD input “ip
              239.1.1.1:5000”, kênh VTV1 serviceId 101).
            </p>
          )}
          {sources.map((s) => (
            <div key={s.id} className="rounded-xl bg-white p-4 shadow">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">
                  {s.id}{' '}
                  <span className={`text-sm ${statusColor(s.status)}`}>
                    ({s.status}
                    {s.pid !== undefined ? ` · pid ${s.pid}` : ''} · rev {s.confRev})
                  </span>
                </p>
                <div className="ml-auto flex flex-wrap gap-2">
                  {s.status === 'RUNNING' ? (
                    <button
                      onClick={() => void doStop(s)}
                      disabled={busy !== ''}
                      className="rounded bg-amber-500 px-3 py-1 text-sm text-white disabled:opacity-50"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={() => void doStart(s)}
                      disabled={busy !== ''}
                      className="rounded bg-green-600 px-3 py-1 text-sm text-white disabled:opacity-50"
                    >
                      Start
                    </button>
                  )}
                  <button
                    onClick={() => void doPreview(s)}
                    className="rounded bg-slate-200 px-3 py-1 text-sm"
                  >
                    Xem conf
                  </button>
                  <button onClick={() => openEdit(s)} className="rounded bg-slate-200 px-3 py-1 text-sm">
                    Sửa
                  </button>
                  <button
                    onClick={() => setConfirmDel(s)}
                    className="rounded bg-red-100 px-3 py-1 text-sm text-red-700"
                  >
                    Xóa
                  </button>
                </div>
              </div>
              <p className="mt-1 font-mono text-sm text-slate-600">-I {s.input}</p>
              {s.inputKind !== undefined && s.inputKind !== 'ip' && (
                <p className="font-mono text-sm text-violet-700">
                  ⏺ Encode {s.inputKind.toUpperCase()}
                  {s.capture !== undefined ? ` (${s.capture.device} → udp 127.0.0.1:${s.capture.udpPort})` : ''} · Live/GHI sau encode
                </p>
              )}
              {s.puller !== undefined && (
                <p className="font-mono text-sm text-sky-700">
                  ⤓ puller RTMP {s.puller.rtmpUrl}/{s.puller.streamKey} → udp 127.0.0.1:{s.puller.udpPort}{' '}
                  {(() => {
                    const st = tcStatus.find((x) => x.key === `pull/${s.id}`);
                    if (st === undefined) return <span className="text-slate-400">○ chưa chạy</span>;
                    if (st.waiting) return <span className="text-sky-600">◌ chờ input RTMP</span>;
                    return <span className="text-green-600">● chạy{st.fps !== null ? ` fps ${st.fps}` : ''}</span>;
                  })()}
                </p>
              )}
              {s.capture !== undefined && (
                <p className="font-mono text-sm text-violet-700">
                  ⏺ capture {s.capture.device} → udp 127.0.0.1:{s.capture.udpPort}{' '}
                  {(() => {
                    const st = tcStatus.find((x) => x.key === `cap/${s.id}`);
                    if (st === undefined) return <span className="text-slate-400">○ chưa chạy</span>;
                    if (st.waiting) return <span className="text-sky-600">◌ chờ tín hiệu card</span>;
                    return <span className="text-green-600">● chạy{st.fps !== null ? ` fps ${st.fps}` : ''}</span>;
                  })()}
                </p>
              )}
              <p className="text-sm">
                Kênh:{' '}
                {s.channels.map((c) => `${c.name}(sid ${c.serviceId}${c.isLive ? '' : ', no-live'})`).join(', ') || '—'}
              </p>
              <p className="text-sm text-slate-500">
                {s.recordAll ? (
                  <>
                    Ghi catchup toàn luồng · Lưu {s.retentionDays ?? 'mặc định'} ngày
                  </>
                ) : (
                  'Chỉ live — không lưu chiểu (xem trực tiếp bình thường, trích xuất/timeshift báo không có dữ liệu)'
                )}
              </p>
            </div>
          ))}

          {showForm && (
            <form onSubmit={submit} className="space-y-3 rounded-xl bg-white p-4 shadow">
              <h2 className="font-semibold">{editingId === null ? 'Thêm nguồn mới' : `Sửa nguồn ${editingId}`}</h2>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  ID nguồn
                  <input
                    value={fId}
                    onChange={(e) => setFId(e.target.value)}
                    disabled={editingId !== null}
                    placeholder="mux-1"
                    className="mt-1 w-full rounded border px-3 py-2 font-mono"
                  />
                </label>
                <label className="text-sm">
                  Số ngày lưu chiểu (1..365, trống = mặc định)
                  <input
                    value={fRetention}
                    onChange={(e) => setFRetention(e.target.value)}
                    placeholder="30"
                    disabled={!fRecordAll}
                    className="mt-1 w-full rounded border px-3 py-2 disabled:bg-slate-100 disabled:text-slate-400"
                  />
                </label>
              </div>
              <label className="block text-sm">
                <span className="flex items-center gap-2">
                  Loại đầu vào
                  <select
                    value={fInputKind}
                    onChange={(e) => setFInputKind(e.target.value as SourceInputKind)}
                    className="rounded border px-2 py-1 text-sm"
                  >
                    <option value="ip">IP — Transcode luồng nén (chạy ngay)</option>
                    <option value="sdi">SDI — Encode baseband qua card capture</option>
                    <option value="hdmi">HDMI — Encode baseband qua card capture</option>
                  </select>
                </span>
                Input TSDuck (phần sau -I — VD &quot;ip 239.1.1.1:5000&quot;, không dán link udp:// của VLC)
                <div className="mt-1 flex gap-2">
                  <input
                    value={fInput}
                    onChange={(e) => {
                      setFInput(e.target.value);
                      resetScan();
                    }}
                    placeholder="ip 239.1.1.1:5000"
                    className="flex-1 rounded border px-3 py-2 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => void doScan()}
                    disabled={scanning || fInput.trim() === '' || fInputKind !== 'ip'}
                    title={fInputKind !== 'ip' ? 'Quét luồng chỉ dùng cho nguồn IP' : undefined}
                    className="shrink-0 rounded bg-sky-700 px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    {scanning ? 'Đang quét…' : 'Quét luồng'}
                  </button>
                </div>
              </label>
              {(fInputKind === 'sdi' || fInputKind === 'hdmi') && (
                <div className="rounded border border-violet-200 bg-violet-50 p-3">
                  <p className="text-sm font-semibold">
                    Capture {fInputKind.toUpperCase()} — agent encode mezzanine → UDP localhost
                  </p>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <label className="text-sm">
                      Tên card (ffmpeg thấy)
                      <input
                        value={fCapDevice}
                        onChange={(e) => setFCapDevice(e.target.value)}
                        placeholder="UltraStudio Mini Recorder"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <label className="text-sm">
                      Cổng UDP agent→tsp (6200–6299)
                      <input
                        value={fCapUdpPort}
                        onChange={(e) => setFCapUdpPort(e.target.value)}
                        inputMode="numeric"
                        placeholder="6201"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <label className="text-sm">
                      Cổng vào card (trống = SDI)
                      <input
                        value={fCapConnection}
                        onChange={(e) => setFCapConnection(e.target.value)}
                        placeholder="sdi"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <label className="text-sm">
                      Mã format (trống = tự nhận, VD Hi50 = 1080i50)
                      <input
                        value={fCapFormat}
                        onChange={(e) => setFCapFormat(e.target.value)}
                        placeholder="Hi50"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Input ở trên phải là UDP của agent (VD “ip 127.0.0.1:6201”). Mezzanine mặc định
                    p1080/cpu (đổi preset/engine qua API). Live + GHI lấy sau encode (mặc định).
                  </p>
                </div>
              )}
              {(scanMsg !== '' || scanProgs.length > 0) && (
                <div className="rounded border border-sky-200 bg-sky-50 p-3 text-sm">
                  {scanMsg !== '' && <p className="mb-2 text-slate-700">{scanMsg}</p>}
                  {scanProgs.length > 0 && (
                    <>
                      <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">
                        {scanProgs.map((p) => (
                          <label
                            key={p.serviceId}
                            className="flex items-center gap-1.5 rounded bg-white px-2 py-1 shadow-sm"
                          >
                            <input
                              type="checkbox"
                              checked={scanSel.includes(p.serviceId)}
                              onChange={(e) =>
                                setScanSel((sel) =>
                                  e.target.checked
                                    ? [...sel, p.serviceId]
                                    : sel.filter((x) => x !== p.serviceId),
                                )
                              }
                            />
                            <span className="font-mono font-semibold">{p.serviceId}</span>
                            <span className="text-slate-600">{p.name ?? '(chưa rõ tên)'}</span>
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={addSelected}
                        disabled={scanSel.length === 0}
                        className="mt-2 rounded bg-slate-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        Thêm {scanSel.length} kênh đã chọn (tên tự điền từ SDT, tick Live)
                      </button>
                    </>
                  )}
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={fRecordAll} onChange={(e) => setFRecordAll(e.target.checked)} />
                Ghi catchup toàn bộ luồng ra đĩa (khuyên bật)
              </label>
              <div className="rounded border p-3">
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" checked={fPullerOn} onChange={(e) => setFPullerOn(e.target.checked)} />
                  Nguồn RTMP qua puller (MediaMTX → UDP localhost → tsp)
                </label>
                {fPullerOn && (
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <label className="text-sm">
                      URL app RTMP
                      <input
                        value={fRtmpUrl}
                        onChange={(e) => setFRtmpUrl(e.target.value)}
                        placeholder="rtmp://127.0.0.1:1935/live"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <label className="text-sm">
                      Stream key (đối tác push)
                      <input
                        value={fStreamKey}
                        onChange={(e) => setFStreamKey(e.target.value)}
                        placeholder="ten-kenh"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <label className="text-sm">
                      Cổng UDP puller→tsp (6100–6199)
                      <input
                        value={fUdpPort}
                        onChange={(e) => setFUdpPort(e.target.value)}
                        inputMode="numeric"
                        placeholder="6101"
                        className="mt-1 w-full rounded border px-3 py-2 font-mono"
                      />
                    </label>
                    <p className="text-xs text-slate-500 md:col-span-3">
                      Input TSDuck ở trên phải là UDP puller nghe (VD “ip 127.0.0.1:6101”). Puller chỉ remux
                      `-c copy` (nhẹ CPU) — yêu cầu nội dung RTMP là H.264 + AAC. Đổi puller khi source đang
                      chạy = hot-restart mỗi puller, không động tsp.
                    </p>
                  </div>
                )}
              </div>
              {!fRecordAll && (
                <p className="text-sm text-amber-600">
                  Tắt ghi đĩa = kênh chỉ live (xem trực tiếp qua RAM bình thường, không tốn ổ). Trích
                  xuất/timeshift các kênh này sẽ báo không có dữ liệu — muốn lưu chiểu thì bật lại.
                </p>
              )}
              <div className="space-y-2">
                <p className="text-sm font-semibold">Danh sách kênh trong luồng</p>
                {fChannels.map((c, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded border p-2">
                    <input
                      value={c.name}
                      onChange={(e) => setChannel(i, { name: e.target.value })}
                      placeholder="vtv1"
                      className="w-32 rounded border px-2 py-1 font-mono text-sm"
                    />
                    <input
                      value={c.serviceId}
                      onChange={(e) => setChannel(i, { serviceId: e.target.value })}
                      placeholder="SID 101"
                      inputMode="numeric"
                      className="w-24 rounded border px-2 py-1 text-sm"
                    />
                    <label className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        checked={c.isLive}
                        onChange={(e) => setChannel(i, { isLive: e.target.checked })}
                      />
                      Live
                    </label>
                    <button
                      type="button"
                      onClick={() => setFChannels((prev) => prev.filter((_, idx) => idx !== i))}
                      disabled={fChannels.length <= 1}
                      className="rounded bg-slate-200 px-2 py-1 text-sm disabled:opacity-50"
                    >
                      Bỏ
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setFChannels((prev) => [...prev, { ...EMPTY_CHANNEL }])}
                  className="rounded bg-slate-200 px-3 py-1 text-sm"
                >
                  + Thêm kênh
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy === 'save'}
                  className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {editingId === null ? 'Tạo nguồn' : 'Lưu thay đổi'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded bg-slate-200 px-4 py-2 text-sm"
                >
                  Hủy
                </button>
              </div>
            </form>
          )}
        </main>
      </div>

      {preview !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow">
            <p className="text-sm font-semibold">
              Conf {preview.id} ({preview.liveCount} nhánh live)
            </p>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-900 p-3 font-mono text-xs text-green-200">
              {preview.conf}
            </pre>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setPreview(null)} className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white">
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDel !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-xl bg-white p-5 shadow">
            <p className="text-sm font-semibold">Xóa nguồn {confirmDel.id}?</p>
            <p className="mt-1 text-sm text-slate-600">
              Hệ thống sẽ dừng process TSDuck (nếu đang chạy) rồi xóa cấu hình. Dữ liệu catchup đã ghi
              trên đĩa được giữ lại.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="rounded bg-slate-200 px-4 py-1.5 text-sm">
                Hủy
              </button>
              <button onClick={doDelete} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white">
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </RequireAdmin>
  );
}
