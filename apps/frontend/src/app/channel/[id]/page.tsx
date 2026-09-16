'use client';
// Trang kênh — split-view (PRD §7.2): trái player Live cố định, phải timeline EPG.
// - Live: link token 4 giờ, tự cấp lại khi hết hạn.
// - Timeline: date picker + now-playing highlight + Xem (timeshift SPTS, one-click)
//   + Trích xuất (prefill sang /exports) + Xuất EPG (tải JSON ngày).
// - Kênh chưa map EPG: chỉ hiện player (không báo lỗi).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { LivePlayer } from '@/components/LivePlayer';
import { CopyButton } from '@/components/CopyButton';
import { api, timeshiftUrl, type EpgDayView } from '@/lib/api';

function fmtT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
}

export default function ChannelPage({ params }: { params: { id: string } }): React.JSX.Element {
  const name = decodeURIComponent(params.id);
  const router = useRouter();
  const [found, setFound] = useState<boolean | null>(null);
  const [link, setLink] = useState('');
  const [linkErr, setLinkErr] = useState('');
  const [msg, setMsg] = useState('');
  const retries = useRef(0);
  // EPG split-view
  const [mapped, setMapped] = useState(false);
  const [dates, setDates] = useState<{ date: string; count: number }[]>([]);
  const [viewDate, setViewDate] = useState('');
  const [day, setDay] = useState<EpgDayView | null>(null);
  // Player 2 chế độ: live mặc định, vod khi Xem từ EPG.
  const [vod, setVod] = useState<{ url: string; title: string } | null>(null);

  const retriesRef = retries;
  const mint = useCallback(async () => {
    setLinkErr('');
    try {
      const [ss, tok] = await Promise.all([
        api.sources(),
        api.hlsToken(name, 240).catch(() => null),
      ]);
      setFound(ss.some((s) => s.channels.some((c) => c.name === name)));
      if (tok === null) {
        setLinkErr('Không cấp được link xem (kênh chưa có hoặc chưa đăng nhập).');
        return;
      }
      setLink(`${window.location.origin}${tok.url}`);
    } catch {
      setFound(false);
      setLinkErr('Không tải được thông tin kênh.');
    }
  }, [name]);

  useEffect(() => {
    retriesRef.current = 0;
    setLink('');
    setVod(null);
    void mint();
  }, [mint, retriesRef]);

  // Nạp index ngày có lịch của kênh. Mặc định HÔM NAY (không tự nhảy tới tương
  // lai xa); hôm nay trống thì lùi về ngày gần nhất có lịch, rồi mới tới tương lai.
  useEffect(() => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const today = `${get('year')}-${get('month')}-${get('day')}`;
    api
      .epgStatus()
      .then((st) => {
        const m = st.mappings.find((x) => x.localName === name);
        if (m === undefined) return;
        setMapped(true);
        setDates(m.dates);
        const ds = m.dates.map((d) => d.date).sort();
        const past = ds.filter((d) => d <= today);
        const fut = ds.filter((d) => d > today);
        const pick = ds.includes(today) ? today : (past.at(-1) ?? fut[0] ?? today);
        setViewDate(pick);
        if (pick !== today) {
          setMsg(`Hôm nay chưa có lịch đã duyệt — đang hiện ngày ${pick.split('-').reverse().join('/')} gần nhất có lịch.`);
        }
        api
          .epgSchedule(name, pick)
          .then(setDay)
          .catch(() => setDay(null));
      })
      .catch(() => {});
  }, [name]);

  const handleFatal = useCallback(() => {
    if (retriesRef.current >= 2) return;
    retriesRef.current += 1;
    void mint();
  }, [mint, retriesRef]);

  const loadDay = async (): Promise<void> => {
    if (viewDate === '') return;
    setMsg('');
    try {
      setDay(await api.epgSchedule(name, viewDate));
    } catch (err) {
      setDay(null);
      setMsg(err instanceof Error ? err.message : 'Không tải được lịch');
    }
  };

  const watchProgram = async (title: string, startIso: string, endIso: string): Promise<void> => {
    setMsg('');
    const a = Date.parse(startIso);
    const b = Date.parse(endIso);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return setMsg('Giờ chương trình không hợp lệ.');
    const url = timeshiftUrl(name, a, b);
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        return setMsg(j.error ?? `Không xem được (HTTP ${r.status})`);
      }
      await r.body?.cancel().catch(() => {});
      setVod({ url, title });
    } catch {
      setMsg('Không gọi được API timeshift.');
    }
  };

  const exportProgram = (title: string, startIso: string, endIso: string): void => {
    const q = new URLSearchParams({ channel: name, in: startIso, out: endIso, title });
    router.push(`/exports?${q.toString()}`);
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

  const isNow = (startIso: string, endIso: string): boolean => {
    const t = Date.now();
    return Date.parse(startIso) <= t && t < Date.parse(endIso);
  };

  return (
    <div className="flex">
      <Sidebar />
      <div className="flex-1">
        <Header onMenu={() => {}} />
        <main className="space-y-4 p-4">
          <h1 className="text-xl font-bold uppercase">Kênh truyền hình {name}</h1>
          <div className="flex items-center gap-2 rounded-xl bg-white p-3 shadow">
            <code className="flex-1 truncate text-sm text-slate-600">
              {link === '' ? 'Đang cấp link xem…' : link}
            </code>
            {link !== '' && <CopyButton text={link} />}
          </div>
          <p className="text-xs text-slate-500">
            Link có hạn dùng 4 giờ — hết hạn thì trình phát tự cấp lại, link đã copy đi thì hết hiệu lực.
          </p>
          {linkErr !== '' && <p className="text-sm text-red-600">{linkErr}</p>}
          {found === false && (
            <p className="text-sm text-amber-600">Kênh chưa có trong cấu hình — kiểm tra /sources.</p>
          )}
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

          {vod === null ? (
            link !== '' && <LivePlayer streamUrl={link} onFatal={handleFatal} />
          ) : (
            <div className="space-y-2 rounded-xl bg-white p-4 shadow">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">Đang xem lại: {vod.title}</p>
                <button onClick={() => setVod(null)} className="ml-auto rounded bg-slate-200 px-3 py-1 text-sm">
                  Về Live
                </button>
              </div>
              <LivePlayer key={vod.url} streamUrl={vod.url} mode="vod" />
            </div>
          )}

          {mapped && (
            <div className="rounded-xl bg-white p-4 shadow">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">Lịch phát sóng</h2>
                <input
                  type="date"
                  value={viewDate}
                  onChange={(e) => setViewDate(e.target.value)}
                  className="rounded border px-3 py-1.5 text-sm"
                />
                <button onClick={loadDay} className="rounded bg-slate-200 px-3 py-1.5 text-sm">
                  Xem ngày
                </button>
                <div className="ml-auto flex gap-2">
                  <Link href="/epg" className="rounded bg-slate-200 px-3 py-1.5 text-sm">
                    Quản lý EPG
                  </Link>
                  {day !== null && (
                    <button onClick={downloadDay} className="rounded bg-slate-200 px-3 py-1.5 text-sm">
                      Xuất EPG
                    </button>
                  )}
                </div>
              </div>
              {day === null ? (
                <p className="text-sm text-slate-500">Chưa có lịch ngày này (chỉ hiện lịch đã duyệt).</p>
              ) : day.programs.length === 0 ? (
                <p className="text-sm text-amber-600">Ngày này chưa có lịch đã duyệt.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {day.programs.map((p) => {
                      const now = isNow(p.startTime, p.endTime);
                      return (
                        <tr key={p.id} className={`border-t ${now ? 'bg-green-50' : ''}`}>
                          <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-slate-500">
                            {fmtT(p.startTime)} → {fmtT(p.endTime)}
                            {now && <span className="ml-2 text-xs font-bold text-green-600">ĐANG PHÁT</span>}
                          </td>
                          <td>
                            <span className="font-semibold">{p.title}</span>
                          </td>
                          <td className="space-x-2 whitespace-nowrap pl-2 text-right">
                            <button
                              onClick={() => void watchProgram(p.title, p.startTime, p.endTime)}
                              className="rounded bg-green-600 px-3 py-1 text-white"
                            >
                              Xem
                            </button>
                            <button
                              onClick={() => exportProgram(p.title, p.startTime, p.endTime)}
                              className="rounded bg-slate-900 px-3 py-1 text-white"
                            >
                              Trích xuất
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
