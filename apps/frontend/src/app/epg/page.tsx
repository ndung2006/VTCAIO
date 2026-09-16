'use client';
// Trang /epg (quản lý EPG đối tác — E1): map kênh local<->đối tác, đồng bộ tay,
// xem lịch ngày + xuất file. Split-view xem kèm live để dành E3.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { LivePlayer } from '@/components/LivePlayer';
import { api, timeshiftUrl, type EpgDayView, type EpgStatus, type Source } from '@/lib/api';

function fmtDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function fmtT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
}

export default function EpgPage(): React.JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState<EpgStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [partnerInputs, setPartnerInputs] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<{ id: number; name: string }[]>([]);
  const [viewChannel, setViewChannel] = useState('');
  const [viewDate, setViewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [day, setDay] = useState<EpgDayView | null>(null);
  const [tsUrl, setTsUrl] = useState('');
  const [tsTitle, setTsTitle] = useState('');

  const reload = useCallback(async () => {
    try {
      const [ss, st] = await Promise.all([api.sources(), api.epgStatus()]);
      setSources(ss);
      setStatus(st);
      const init: Record<string, string> = {};
      for (const s of ss) {
        for (const c of s.channels) init[`${s.id}:${c.name}`] = c.partnerChannelId?.toString() ?? '';
      }
      setPartnerInputs(init);
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mapped = useMemo(() => status?.mappings ?? [], [status]);

  const syncNow = async (): Promise<void> => {
    setBusy('sync');
    setMsg('Đang đồng bộ lịch đã duyệt…');
    try {
      const r = await api.epgSync();
      setMsg(`Xong: ${r.updated}/${r.days} ngày mới (${r.mappings} kênh map).`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Đồng bộ thất bại');
    } finally {
      setBusy('');
    }
  };

  const saveSource = async (s: Source): Promise<void> => {
    setBusy(`save:${s.id}`);
    setMsg('');
    try {
      const channels = s.channels.map((c) => {
        const raw = (partnerInputs[`${s.id}:${c.name}`] ?? '').trim();
        if (raw === '') {
          const { partnerChannelId: _omit, ...rest } = c;
          return rest;
        }
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid < 1) throw new Error(`ID đối tác của ${c.name} phải là số nguyên ≥1`);
        return { ...c, partnerChannelId: pid };
      });
      await api.updateSource(s.id, { channels });
      setMsg(`Đã lưu mapping nguồn ${s.id}.`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Lưu thất bại');
    } finally {
      setBusy('');
    }
  };

  const searchPartner = async (): Promise<void> => {
    try {
      const r = await api.partnerChannels(search);
      setResults(r.channels);
      if (r.channels.length === 0) setMsg('Không tìm thấy kênh đối tác.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Tìm thất bại');
    }
  };

  const loadDay = async (): Promise<void> => {
    if (viewChannel === '') return setMsg('Chọn kênh cần xem.');
    setMsg('');
    setDay(null);
    setTsUrl('');
    try {
      setDay(await api.epgSchedule(viewChannel, viewDate));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Không tải được lịch');
    }
  };

  // One-click timeshift: bấm chương trình là phát (chỉ SPTS; MPTS backend báo
  // thẳng "dùng Trích xuất" và hiện nguyên văn).
  const watchProgram = async (title: string, startIso: string, endIso: string): Promise<void> => {
    setMsg('');
    const a = Date.parse(startIso);
    const b = Date.parse(endIso);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return setMsg('Giờ chương trình không hợp lệ.');
    const url = timeshiftUrl(viewChannel, a, b);
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return setMsg(j.error ?? `Không xem được (HTTP ${r.status})`);
      }
      await r.body?.cancel().catch(() => {});
      setTsTitle(title);
      setTsUrl(url);
    } catch {
      setMsg('Không gọi được API timeshift.');
    }
  };

  const downloadDay = (): void => {
    if (day === null) return;
    const blob = new Blob([JSON.stringify(day, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `epg-${day.localName}-${day.date}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold">LỊCH PHÁT SÓNG (EPG)</h1>
            <button
              onClick={syncNow}
              disabled={busy !== ''}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
            </button>
          </div>
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
          <p className="text-sm text-slate-500">
            {status === null
              ? 'Đang tải trạng thái…'
              : status.configured
                ? ` worker ${status.lastSyncAt === null ? 'chưa chạy lần nào' : `lần cuối ${fmtDT(status.lastSyncAt)}`}`
                : 'Chưa cấu hình VTC_EPG_API_KEY — đồng bộ tay sẽ báo thiếu key.'}
          </p>
          {status?.lastStats !== null && status?.lastStats !== undefined && status.lastStats.errors.length > 0 && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              Sync lỗi {status.lastStats.errors.length} lượt — VD: [{status.lastStats.errors[0]?.partnerChannelId}{' '}
              {status.lastStats.errors[0]?.date}] {status.lastStats.errors[0]?.error} (401 = key sai/chưa kích
              hoạt, 429 = bị giới hạn tần suất).
            </p>
          )}

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Map kênh local ↔ đối tác</h2>
            {sources.map((s) => (
              <div key={s.id} className="mb-3 rounded border p-2">
                <p className="mb-1 text-sm font-semibold">
                  Nguồn {s.id} ({s.status})
                </p>
                {s.channels.map((c) => (
                  <div key={c.name} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                    <span className="w-32 font-mono">{c.name}</span>
                    <span className="text-slate-500">SID {c.serviceId}</span>
                    <input
                      value={partnerInputs[`${s.id}:${c.name}`] ?? ''}
                      onChange={(e) => setPartnerInputs((p) => ({ ...p, [`${s.id}:${c.name}`]: e.target.value }))}
                      placeholder="ID đối tác (VD 809)"
                      inputMode="numeric"
                      className="w-40 rounded border px-2 py-1 text-sm"
                    />
                    {(status?.mappings.find((m) => m.localName === c.name)?.dates.length ?? 0) > 0 && (
                      <span className="text-xs text-green-600">
                        {status?.mappings.find((m) => m.localName === c.name)?.dates.length} ngày có lịch
                      </span>
                    )}
                  </div>
                ))}
                <button
                  onClick={() => void saveSource(s)}
                  disabled={busy !== '' || s.status === 'RUNNING'}
                  title={s.status === 'RUNNING' ? 'Stop nguồn trước khi sửa' : 'Lưu mapping'}
                  className="mt-1 rounded bg-slate-200 px-3 py-1 text-sm disabled:opacity-50"
                >
                  Lưu mapping
                </button>
              </div>
            ))}
            {(status?.unmappedLocal.length ?? 0) > 0 && (
              <p className="text-sm text-slate-500">
                Chưa map: {status?.unmappedLocal.map((u) => u.name).join(', ')}
              </p>
            )}
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Tra cứu ID đối tác</h2>
            <div className="flex gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tên kênh đối tác (VD VTV1)"
                className="flex-1 rounded border px-3 py-2 text-sm"
              />
              <button onClick={searchPartner} className="rounded bg-slate-200 px-4 py-2 text-sm">
                Tìm
              </button>
            </div>
            {results.map((r) => (
              <p key={r.id} className="mt-1 font-mono text-sm">
                {r.id} — {r.name}
              </p>
            ))}
          </div>

          <div className="rounded-xl bg-white p-4 shadow">
            <h2 className="mb-2 font-semibold">Xem lịch ngày</h2>
            <div className="flex flex-wrap gap-2">
              <select value={viewChannel} onChange={(e) => setViewChannel(e.target.value)} className="rounded border px-3 py-2 text-sm">
                <option value="">— Chọn kênh đã map —</option>
                {mapped.map((m) => (
                  <option key={m.localName} value={m.localName}>
                    {m.localName} (ID {m.partnerChannelId})
                  </option>
                ))}
              </select>
              <input
                type="date"
                value={viewDate}
                onChange={(e) => setViewDate(e.target.value)}
                className="rounded border px-3 py-2 text-sm"
              />
              <button onClick={loadDay} className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
                Xem
              </button>
              {day !== null && (
                <button onClick={downloadDay} className="rounded bg-slate-200 px-4 py-2 text-sm">
                  Xuất EPG
                </button>
              )}
            </div>
            {tsUrl !== '' && (
              <div className="mt-3 rounded border p-3">
                <p className="mb-2 text-sm font-semibold">Đang xem lại: {tsTitle}</p>
                <LivePlayer key={tsUrl} streamUrl={tsUrl} mode="vod" />
              </div>
            )}
          {day !== null && (
              <div className="mt-3">
                <p className="mb-2 text-sm text-slate-500">
                  {day.localName} · {day.date} · {day.programs.length} chương trình
                  (lô {day.updatedAt === '' ? 'trống' : fmtT(day.updatedAt)})
                </p>
                {day.programs.length === 0 ? (
                  <p className="text-sm text-amber-600">Ngày này chưa có lịch đã duyệt.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {day.programs.map((p) => (
                        <tr key={p.id} className="border-t">
                          <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-slate-500">
                            {fmtT(p.startTime)} → {fmtT(p.endTime)}
                          </td>
                          <td>
                            <span className="font-semibold">{p.title}</span>
                            {p.description !== '' && <span className="text-slate-500"> — {p.description}</span>}
                          </td>
                          <td className="pl-2 text-right">
                            <button
                              onClick={() => void watchProgram(p.title, p.startTime, p.endTime)}
                              className="rounded bg-green-600 px-3 py-1 text-white"
                            >
                              Xem
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
