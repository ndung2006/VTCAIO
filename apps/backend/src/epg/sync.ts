//=============================================================================
// epg/sync.ts — Đồng bộ lịch đã duyệt về store (chạy worker 10 phút + tay).
// So batch updatedAt theo cặp kênh+ngày; mới hơn thì thay cả ngày.
//=============================================================================
import type { EpgClient } from './client.js';
import type { EpgStore } from './store.js';

export interface SyncMapping {
  partnerChannelId: number;
  localName: string;
}

export interface SyncStats {
  startedAt: string;
  mappings: number;
  days: number;
  updated: number;
  skipped: number;
  errors: { partnerChannelId: number; date: string; error: string }[];
}

/** YYYY-MM-DD hôm nay theo giờ VN (lịch đối tác theo ngày VN). */
export function vnToday(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shift(date: string, days: number): string {
  // UTC thuần túy (ngày YYYY-MM-DD không gắn TZ): getDate()/setDate() theo TZ
  // máy host sẽ lệch biên khi chạy ở múi giờ khác +07:00.
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86400000;
  const dt = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export function syncWindow(today: string, pastDays: number, futureDays: number): string[] {
  const out: string[] = [];
  for (let i = -pastDays; i <= futureDays; i++) out.push(shift(today, i));
  return out;
}

export async function syncNow(opts: {
  store: EpgStore;
  client: EpgClient;
  mappings: SyncMapping[];
  pastDays: number;
  futureDays: number;
  today?: string;
}): Promise<SyncStats> {
  const today = opts.today ?? vnToday();
  const dates = syncWindow(today, opts.pastDays, opts.futureDays);
  const stats: SyncStats = {
    startedAt: new Date().toISOString(),
    mappings: opts.mappings.length,
    days: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (const m of opts.mappings) {
    for (const date of dates) {
      stats.days++;
      try {
        const day = await opts.client.getSchedule(m.partnerChannelId, date);
        if (opts.store.setDay(day)) stats.updated++;
        else stats.skipped++;
      } catch (e) {
        stats.errors.push({
          partnerChannelId: m.partnerChannelId,
          date,
          error: e instanceof Error ? e.message : 'lỗi không rõ',
        });
      }
    }
  }
  opts.store.pruneOlderThan(shift(today, -opts.pastDays));
  opts.store.save();
  return stats;
}
