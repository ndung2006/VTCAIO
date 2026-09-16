'use client';
// Trang /channels: tồn kho toàn bộ kênh + cấu hình + sức khỏe HLS từng kênh.
// Kênh là con của nguồn (sửa tên/SID ở trang Nguồn); ở đây cho bật/tắt Live
// nhanh (đòi nguồn STOPPED — backend chặn sửa lúc RUNNING để khỏi chớp sóng).
// Cảnh báo trùng tên kênh (2 kênh chung 1 thư mục HLS sẽ đè nhau).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { api, type Source } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';

interface Row {
  sourceId: string;
  sourceStatus: Source['status'];
  name: string;
  serviceId: number;
  isLive: boolean;
  published: boolean;
  ageSec: number | null;
  stale: boolean;
}

export default function ChannelsPage(): React.JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [health, setHealth] = useState<Map<string, { ageSec: number | null; stale: boolean }>>(new Map());
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [pullInfo, setPullInfo] = useState<{ name: string; url: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [ss, hh] = await Promise.all([api.sources(), api.hlsHealth().catch(() => [])]);
      setSources(ss);
      setHealth(new Map(hh.map((h) => [h.channel, { ageSec: h.ageSec, stale: h.stale }])));
    } catch {
      setSources([]);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);

  const rows: Row[] = useMemo(
    () =>
      sources.flatMap((s) =>
        s.channels.map((c) => ({
          sourceId: s.id,
          sourceStatus: s.status,
          name: c.name,
          serviceId: c.serviceId,
          isLive: c.isLive,
          published: c.published === true,
          ageSec: health.get(c.name)?.ageSec ?? null,
          stale: health.get(c.name)?.stale ?? false,
        })),
      ),
    [sources, health],
  );

  const dupNames = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows) count.set(r.name, (count.get(r.name) ?? 0) + 1);
    return [...count.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle === '') return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.sourceId.toLowerCase().includes(needle) ||
        String(r.serviceId).includes(needle),
    );
  }, [rows, q]);

  const liveCount = rows.filter((r) => r.isLive).length;
  const staleCount = rows.filter((r) => r.stale).length;

  const makePullLink = async (r: Row): Promise<void> => {
    setBusy(`pull:${r.sourceId}:${r.name}`);
    setMsg('');
    try {
      const j = await api.pullToken(r.name);
      setPullInfo({ name: r.name, url: `${window.location.origin}${j.url}` });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Tạo link kéo luồng thất bại');
    } finally {
      setBusy('');
    }
  };

  // Tích/bỏ tích VTVgo = meta, chạy được cả khi RUNNING (không restart).
  const togglePublish = async (r: Row): Promise<void> => {
    const src = sources.find((s) => s.id === r.sourceId);
    if (src === undefined) return;
    setBusy(`pub:${r.sourceId}:${r.name}`);
    setMsg('');
    try {
      await api.updateSource(src.id, {
        channels: src.channels.map((c) =>
          c.name === r.name ? { ...c, published: !r.published || undefined } : c,
        ),
      });
      setMsg(
        r.published
          ? `Đã gỡ ${r.name} khỏi danh mục VTVgo.`
          : `Đã đưa ${r.name} lên danh mục VTVgo.`,
      );
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Đổi cờ thất bại');
    } finally {
      setBusy('');
    }
  };

  const toggleLive = async (r: Row): Promise<void> => {
    const src = sources.find((s) => s.id === r.sourceId);
    if (src === undefined) return;
    if (src.status === 'RUNNING') {
      setMsg(`Nguồn ${src.id} đang RUNNING — Stop ở trang Nguồn trước khi đổi cấu hình kênh.`);
      return;
    }
    setBusy(`${r.sourceId}:${r.name}`);
    setMsg('');
    try {
      await api.updateSource(src.id, {
        channels: src.channels.map((c) => (c.name === r.name ? { ...c, isLive: !c.isLive } : c)),
      });
      setMsg(`Đã ${r.isLive ? 'tắt' : 'bật'} Live cho kênh ${r.name}. Nhớ Start lại nguồn để chạy.`);
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Đổi cấu hình thất bại');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold">KÊNH TRUYỀN HÌNH</h1>
            <span className="text-sm text-slate-500">
              {rows.length} kênh · {liveCount} live{staleCount > 0 && ` · ${staleCount} stale`}
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tìm tên / nguồn / SID…"
              className="ml-auto rounded border px-3 py-1.5 text-sm"
            />
          </div>
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
          {dupNames.length > 0 && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
              Trùng tên kênh (thư mục HLS sẽ đè nhau): {dupNames.join(', ')} — đổi tên ở trang Nguồn, tên
              kênh phải duy nhất toàn hệ thống.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="rounded-xl bg-white p-4 text-sm text-slate-500 shadow">
              Chưa có kênh nào. Vào trang Nguồn → Thêm nguồn (kèm danh sách kênh + Service ID).
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl bg-white shadow">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500">
                    <th className="px-3 py-2">Kênh</th>
                    <th>SID</th>
                    <th>Nguồn</th>
                    <th>Live</th>
                    <th title="Tích để đưa lên danh mục VTVgo (/api/public/channels)">VTVgo</th>
                    <th>HLS</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={`${r.sourceId}:${r.name}`} className="border-t">
                      <td className="px-3 py-2 font-mono font-semibold">{r.name}</td>
                      <td>{r.serviceId}</td>
                      <td>
                        {r.sourceId}{' '}
                        <span
                          className={
                            r.sourceStatus === 'RUNNING'
                              ? 'text-green-600'
                              : r.sourceStatus === 'ERROR'
                                ? 'text-red-600'
                                : 'text-slate-400'
                          }
                        >
                          ●
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => void toggleLive(r)}
                          disabled={busy !== ''}
                          title={r.sourceStatus === 'RUNNING' ? 'Stop nguồn trước khi đổi' : 'Bật/tắt Live'}
                          className={`rounded px-2 py-0.5 text-xs disabled:opacity-50 ${
                            r.isLive ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-500'
                          }`}
                        >
                          {r.isLive ? 'BẬT' : 'TẮT'}
                        </button>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={r.published}
                          disabled={busy !== ''}
                          onChange={() => void togglePublish(r)}
                          title="Tích để đưa lên danh mục VTVgo (lưu ngay, không restart)"
                          aria-label={`Đưa ${r.name} lên VTVgo`}
                        />
                      </td>
                      <td className={r.stale ? 'text-red-600' : 'text-slate-500'}>
                        {r.isLive ? (r.ageSec === null ? 'mất playlist' : `${r.ageSec}s`) : '—'}
                        {r.stale ? ' (stale)' : ''}
                      </td>
                      <td className="space-x-2 pr-3 text-right">
                        <button
                          onClick={() => void makePullLink(r)}
                          disabled={busy !== ''}
                          title="Tạo link kéo luồng không hết hạn (giao cho đối tác/VTVgo)"
                          className="rounded bg-slate-200 px-3 py-1 disabled:opacity-50"
                        >
                          Link kéo
                        </button>
                        <Link
                          href={`/channel/${encodeURIComponent(r.name)}`}
                          className="rounded bg-slate-900 px-3 py-1 text-white"
                        >
                          Xem
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>

      {pullInfo !== null && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-5 shadow">
            <p className="text-sm font-semibold">Link kéo luồng kênh {pullInfo.name}</p>
            <div className="mt-2 flex items-center gap-2 rounded bg-slate-100 p-3">
              <code className="flex-1 break-all text-xs text-slate-600">{pullInfo.url}</code>
              <CopyButton text={pullInfo.url} />
            </div>
            <p className="mt-2 text-sm text-slate-600">
              Link không hết hạn — đối tác lưu 1 lần, kéo mãi. Thu hồi bằng cách đổi
              VTC_HLS_SECRET (mọi link cũ vô hiệu ngay, kể cả link 4 giờ).
            </p>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setPullInfo(null)} className="rounded bg-slate-900 px-4 py-1.5 text-sm text-white">
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
