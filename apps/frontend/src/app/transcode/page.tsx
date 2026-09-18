'use client';
// Trang /transcode: CRUD preset encode (docs/16 §3.1, §8.4).
// Sửa preset không ảnh hưởng kênh đang chạy (backend snapshot argv lúc start).
import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { RequireAdmin } from '@/lib/role';
import { presetSchema, tcApi, type TranscodePreset } from '@/lib/transcode';

interface PresetDraft {
  id: string;
  name: string;
  audioOnly: boolean;
  width: string;
  height: string;
  bitrateKbps: string;
  audioKbps: string;
}

const EMPTY: PresetDraft = { id: '', name: '', audioOnly: false, width: '1280', height: '720', bitrateKbps: '2000', audioKbps: '128' };

function toDraft(p: TranscodePreset): PresetDraft {
  return {
    id: p.id,
    name: p.name,
    audioOnly: p.video === null,
    width: p.video !== null ? String(p.video.width) : '1280',
    height: p.video !== null ? String(p.video.height) : '720',
    bitrateKbps: p.video !== null ? String(p.video.bitrateKbps) : '2000',
    audioKbps: String(p.audio.bitrateKbps),
  };
}

function toPreset(d: PresetDraft): TranscodePreset {
  return {
    id: d.id.trim(),
    name: d.name.trim(),
    video: d.audioOnly
      ? null
      : {
          codec: 'h264',
          width: Number(d.width),
          height: Number(d.height),
          bitrateKbps: Number(d.bitrateKbps),
          fps: 25,
          gop: 50,
          preset: 'veryfast',
        },
    audio: { codec: 'aac', bitrateKbps: Number(d.audioKbps), sampleRate: 48000, channels: 2 },
  };
}

function videoLabel(p: TranscodePreset): string {
  if (p.video === null) return 'Audio-Only';
  return `${p.video.width}×${p.video.height} · ${p.video.bitrateKbps}k · ${p.video.fps}fps`;
}

export default function TranscodePresetsPage(): React.JSX.Element {
  const [presets, setPresets] = useState<TranscodePreset[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresetDraft>({ ...EMPTY });
  const [confirmDel, setConfirmDel] = useState<TranscodePreset | null>(null);

  const reload = useCallback(async () => {
    try {
      setPresets(await tcApi.presets());
    } catch {
      setPresets([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = (): void => {
    setEditingId(null);
    setDraft({ ...EMPTY });
    setMsg('');
    setShowForm(true);
  };

  const openEdit = (p: TranscodePreset): void => {
    setEditingId(p.id);
    setDraft(toDraft(p));
    setMsg('');
    setShowForm(true);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const body = toPreset(draft);
    const v = presetSchema.safeParse(body);
    if (!v.success) {
      const first = v.error.issues[0];
      setMsg(first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'Preset sai');
      return;
    }
    if (body.video !== null && (body.video.width % 2 !== 0 || body.video.height % 2 !== 0)) {
      setMsg('width/height phải chẵn (x264 yêu cầu).');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      if (editingId === null) {
        await tcApi.createPreset(body);
        setMsg(`Đã tạo preset ${body.id}.`);
      } else {
        await tcApi.updatePreset(editingId, body);
        setMsg(`Đã sửa preset ${editingId} (kênh đang chạy không ảnh hưởng).`);
      }
      setShowForm(false);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Lưu thất bại');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (confirmDel === null) return;
    setBusy(true);
    try {
      await tcApi.deletePreset(confirmDel.id);
      setMsg(`Đã xóa preset ${confirmDel.id}.`);
      setConfirmDel(null);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Xóa thất bại');
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<PresetDraft>): void => setDraft((d) => ({ ...d, ...patch }));
  const inputCls = 'mt-1 w-full rounded border px-3 py-2';

  return (
    <RequireAdmin>
      <div className="flex">
        <Sidebar />
        <div className="flex-1">
          <Header onMenu={() => {}} />
          <main className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold">PRESET TRANSCODE</h1>
              <button onClick={openCreate} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
                + Thêm preset
              </button>
            </div>
            {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
            <p className="text-sm text-slate-500">
              1 preset = 1 rendition (25fps, H.264 CBR, GOP 2s, AAC 48kHz). Kênh chọn nhiều preset để ra
              nhiều rendition. Audio-Only cho nghe nền mobile/radio.
            </p>

            <div className="overflow-auto rounded-xl bg-white shadow">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50 text-left">
                    <th className="px-3 py-2">ID</th>
                    <th className="px-3 py-2">Tên</th>
                    <th className="px-3 py-2">Video</th>
                    <th className="px-3 py-2">Audio</th>
                    <th className="px-3 py-2 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {presets.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-mono font-semibold">{p.id}</td>
                      <td className="px-3 py-2">{p.name}</td>
                      <td className="px-3 py-2 font-mono">{videoLabel(p)}</td>
                      <td className="px-3 py-2 font-mono">AAC {p.audio.bitrateKbps}k</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => openEdit(p)} className="rounded bg-slate-200 px-3 py-1 text-sm">
                          Sửa
                        </button>{' '}
                        <button
                          onClick={() => setConfirmDel(p)}
                          className="rounded bg-red-100 px-3 py-1 text-sm text-red-700"
                        >
                          Xóa
                        </button>
                      </td>
                    </tr>
                  ))}
                  {presets.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                        Chưa có preset nào.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {showForm && (
              <form onSubmit={submit} className="space-y-3 rounded-xl bg-white p-4 shadow">
                <h2 className="font-semibold">{editingId === null ? 'Thêm preset' : `Sửa preset ${editingId}`}</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-sm">
                    ID
                    <input
                      value={draft.id}
                      onChange={(e) => set({ id: e.target.value })}
                      disabled={editingId !== null}
                      placeholder="p720"
                      className={`${inputCls} font-mono disabled:bg-slate-100`}
                    />
                  </label>
                  <label className="text-sm">
                    Tên hiển thị
                    <input
                      value={draft.name}
                      onChange={(e) => set({ name: e.target.value })}
                      placeholder="720p"
                      className={inputCls}
                    />
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.audioOnly}
                    onChange={(e) => set({ audioOnly: e.target.checked })}
                  />
                  Audio-Only (bỏ hình, `-vn` — nghe nền mobile/radio)
                </label>
                {!draft.audioOnly && (
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="text-sm">
                      Rộng (px, chẵn)
                      <input value={draft.width} onChange={(e) => set({ width: e.target.value })} inputMode="numeric" className={`${inputCls} font-mono`} />
                    </label>
                    <label className="text-sm">
                      Cao (px, chẵn)
                      <input value={draft.height} onChange={(e) => set({ height: e.target.value })} inputMode="numeric" className={`${inputCls} font-mono`} />
                    </label>
                    <label className="text-sm">
                      Bitrate video (kbps)
                      <input value={draft.bitrateKbps} onChange={(e) => set({ bitrateKbps: e.target.value })} inputMode="numeric" className={`${inputCls} font-mono`} />
                    </label>
                  </div>
                )}
                <label className="block text-sm">
                  Bitrate audio AAC (kbps)
                  <input value={draft.audioKbps} onChange={(e) => set({ audioKbps: e.target.value })} inputMode="numeric" className={`${inputCls} w-40 font-mono`} />
                </label>
                <p className="text-xs text-slate-500">Cố định: 25fps · GOP 50 (2s) · x264 veryfast · CBR · AAC 48kHz stereo.</p>
                <div className="flex gap-2">
                  <button type="submit" disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
                    {editingId === null ? 'Tạo preset' : 'Lưu thay đổi'}
                  </button>
                  <button type="button" onClick={() => setShowForm(false)} className="rounded bg-slate-200 px-4 py-2 text-sm">
                    Hủy
                  </button>
                </div>
              </form>
            )}
          </main>
        </div>

        {confirmDel !== null && (
          <div className="fixed inset-0 flex items-center justify-center bg-black/40">
            <div className="w-80 rounded-xl bg-white p-5 shadow">
              <p className="text-sm font-semibold">Xóa preset {confirmDel.id}?</p>
              <p className="mt-1 text-sm text-slate-600">
                Preset đang dùng ở kênh nào sẽ bị chặn (backend báo rõ kênh). Kênh đang chạy không ảnh hưởng.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setConfirmDel(null)} className="rounded bg-slate-200 px-4 py-1.5 text-sm">
                  Hủy
                </button>
                <button onClick={doDelete} disabled={busy} className="rounded bg-red-600 px-4 py-1.5 text-sm text-white disabled:opacity-50">
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
