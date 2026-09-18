'use client';
// Trang kênh — split-view (PRD §7.2): trái player Live cố định, phải timeline EPG.
// - Live: link token 4 giờ, tự cấp lại khi hết hạn.
// - Timeline: date picker + now-playing highlight + Xem (timeshift SPTS, one-click)
//   + Trích xuất (prefill sang /exports) + Xuất EPG (tải JSON ngày).
// - Kênh chưa map EPG: chỉ hiện player (không báo lỗi).
import { useCallback, useEffect, useRef, useState } from 'react';

/** Chừa ~3 dòng phía trên chương trình đang phát khi tự cuộn. */
const SCROLL_ABOVE_PX = 120;
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Header } from '@/components/Header';
import { LivePlayer } from '@/components/LivePlayer';
import { CopyButton } from '@/components/CopyButton';
import { api, timeshiftUrl, type EpgDayView } from '@/lib/api';
import { TranscodePanel } from '@/components/TranscodePanel';
import type { ChannelTranscode } from '@/lib/transcode';
import { useMe } from '@/lib/role';

function fmtT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' });
}

/** DD-MM-YYYY HH:mm (giờ VN) cho thanh khoảng giờ đã chọn. */
function fmtDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}`;
}

export default function ChannelPage({ params }: { params: { id: string } }): React.JSX.Element {
  const name = decodeURIComponent(params.id);
  const router = useRouter();
  const me = useMe();
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
  // EPG: bấm 1 chương trình để chọn → thanh dưới hiện khoảng giờ + nút Xem/Trích xuất.
  const [selId, setSelId] = useState<string | null>(null);
  // Truyền dẫn (admin): cần sourceId + trạng thái source chứa kênh này.
  const [srcInfo, setSrcInfo] = useState<{ sourceId: string; status: string; transcode: ChannelTranscode | undefined } | null>(null);
  const loadSrc = useCallback(async () => {
    try {
      const ss = await api.sources();
      for (const s of ss) {
        const c = s.channels.find((x) => x.name === name);
        if (c !== undefined) {
          setSrcInfo({ sourceId: s.id, status: s.status, transcode: c.transcode });
          return;
        }
      }
      setSrcInfo(null);
    } catch {
      setSrcInfo(null);
    }
  }, [name]);
  useEffect(() => {
    void loadSrc();
  }, [loadSrc]);
  const epgListRef = useRef<HTMLUListElement | null>(null);
  const epgItemRefs = useRef(new Map<string, HTMLLIElement>());

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
          .then(applyDay)
          .catch(() => setDay(null));
      })
      .catch(() => {});
  }, [name]);

  const handleFatal = useCallback(() => {
    if (retriesRef.current >= 2) return;
    retriesRef.current += 1;
    void mint();
  }, [mint, retriesRef]);

  // Lịch về → tự cuộn tới chương trình đang phát, chừa ~3 dòng phía trên.
  // Đầu/cuối danh sách trình duyệt tự kẹp (đầu thì hiện từ đỉnh, cuối thì tới đáy).
  useEffect(() => {
    if (day === null) return;
    const t = Date.now();
    const cur = day.programs.find((p) => Date.parse(p.startTime) <= t && t < Date.parse(p.endTime));
    if (cur === undefined) return;
    const raf = requestAnimationFrame(() => {
      const box = epgListRef.current;
      const el = epgItemRefs.current.get(cur.id);
      if (box === null || el === undefined) return;
      const dr = box.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      box.scrollTop += er.top - dr.top - SCROLL_ABOVE_PX;
    });
    return () => cancelAnimationFrame(raf);
  }, [day]);

  /** Nạp lịch ngày + tự chọn chương trình đang phát (nếu có). */
  const applyDay = (d: EpgDayView | null): void => {
    setDay(d);
    if (d === null) {
      setSelId(null);
      return;
    }
    const t = Date.now();
    const cur = d.programs.find((p) => Date.parse(p.startTime) <= t && t < Date.parse(p.endTime));
    setSelId(cur?.id ?? null);
  };

  const loadDay = async (date?: string): Promise<void> => {
    const d = date ?? viewDate;
    if (d === '') return;
    setMsg('');
    try {
      applyDay(await api.epgSchedule(name, d));
    } catch (err) {
      setDay(null);
      setSelId(null);
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
          {found === false &&
            (me !== null && me !== undefined && me.role !== 'admin' ? (
              <p className="text-sm text-amber-600">
                Kênh này không thuộc phạm vi được gán cho bạn — liên hệ quản trị để được gán thêm.
              </p>
            ) : (
              <p className="text-sm text-amber-600">Kênh chưa có trong cấu hình — kiểm tra /sources.</p>
            ))}
          {msg !== '' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
            <div>
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
            </div>

            {mapped && (
              <div className="rounded-xl bg-white p-4 shadow">
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="font-semibold">Lịch phát sóng</h2>
                  <input
                    type="date"
                    value={viewDate}
                    onChange={(e) => {
                      setViewDate(e.target.value);
                      setSelId(null);
                      void loadDay(e.target.value);
                    }}
                    className="ml-auto min-w-0 flex-1 rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                {day === null ? (
                  <p className="text-sm text-slate-500">Chưa có lịch ngày này (chỉ hiện lịch đã duyệt).</p>
                ) : day.programs.length === 0 ? (
                  <p className="text-sm text-amber-600">Ngày này chưa có lịch đã duyệt.</p>
                ) : (
                  <>
                    <ul ref={epgListRef} className="max-h-[60vh] divide-y overflow-auto">
                      {day.programs.map((p) => {
                        const now = isNow(p.startTime, p.endTime);
                        const sel = selId === p.id;
                        return (
                          <li
                            key={p.id}
                            ref={(el) => {
                              if (el === null) epgItemRefs.current.delete(p.id);
                              else epgItemRefs.current.set(p.id, el);
                            }}
                          >
                            <button
                              onClick={() => setSelId(sel ? null : p.id)}
                              className={`flex w-full items-baseline gap-3 px-1 py-2 text-left ${sel ? 'bg-sky-50' : ''}`}
                            >
                              <span className="shrink-0 font-mono text-sm font-bold text-slate-700">
                                {fmtT(p.startTime)}
                              </span>
                              <span className="min-w-0 flex-1 text-slate-600">{p.title}</span>
                              {now && (
                                <span className="shrink-0 text-xs font-bold text-green-600">ĐANG PHÁT</span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {(() => {
                      const sel = day.programs.find((p) => p.id === selId);
                      if (sel === undefined) return null;
                      return (
                        <div className="mt-2 flex items-stretch gap-2 border-t pt-2">
                          <span className="min-w-0 flex-1 truncate rounded border px-2 py-1.5 font-mono text-xs text-slate-600">
                            {fmtDT(sel.startTime)} ~ {fmtDT(sel.endTime)}
                          </span>
                          <button
                            onClick={() => void watchProgram(sel.title, sel.startTime, sel.endTime)}
                            className="shrink-0 rounded bg-green-500 px-4 py-1.5 text-sm font-semibold text-white"
                          >
                            ▶ Xem
                          </button>
                          <button
                            onClick={() => exportProgram(sel.title, sel.startTime, sel.endTime)}
                            className="shrink-0 rounded bg-sky-700 px-4 py-1.5 text-sm font-semibold text-white"
                          >
                            ⤓ Trích xuất
                          </button>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
            )}
          </div>

          {me?.role === 'admin' && srcInfo !== null && (
            <TranscodePanel
              sourceId={srcInfo.sourceId}
              channelName={name}
              sourceStatus={srcInfo.status}
              initial={srcInfo.transcode}
              onSaved={() => void loadSrc()}
            />
          )}
        </main>
      </div>
    </div>
  );
}
