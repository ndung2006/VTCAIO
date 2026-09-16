// epg.test.ts — Store + client + sync với fetch mock (shape thật từ API 16/09/2026).
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EpgClient } from './client.js';
import { EpgStore } from './store.js';
import { syncNow, syncWindow, vnToday } from './sync.js';
import type { EpgDay } from './types.js';

// 2 chương trình đúng shape thật (id/date/timezone/programs/updatedAt).
function dayFixture(partnerId: number, date: string, updatedAt: string, titles: string[]): EpgDay {
  return {
    partnerChannelId: partnerId,
    date,
    timezone: '+07:00',
    updatedAt,
    fetchedAt: new Date().toISOString(),
    programs: titles.map((title, i) => ({
      id: `${partnerId}-${date.replaceAll('-', '')}-${i}`,
      channelId: partnerId,
      title,
      description: '',
      startTime: `${date}T0${i}:00:00+07:00`,
      endTime: `${date}T0${i}:30:00+07:00`,
      updatedAt,
    })),
  };
}

describe('epg store', () => {
  it('setDay thay cả ngày khi lô mới hơn; prune xóa ngày cũ', () => {
    const s = new EpgStore();
    assert.equal(s.setDay(dayFixture(809, '2026-09-15', '2026-09-15T08:00:00+07:00', ['A'])), true);
    assert.equal(s.setDay(dayFixture(809, '2026-09-15', '2026-09-15T08:00:00+07:00', ['A'])), false); // cùng lô
    assert.equal(s.setDay(dayFixture(809, '2026-09-15', '2026-09-15T09:00:00+07:00', ['A', 'B'])), true);
    assert.equal(s.getDay(809, '2026-09-15')?.programs.length, 2); // vắng mặt = đã xoá (ghi đè)
    assert.deepEqual(s.datesOf(809).map((d) => d.date), ['2026-09-15']);
    assert.equal(s.pruneOlderThan('2026-09-16'), 1);
    assert.equal(s.getDay(809, '2026-09-15'), undefined);
  });

  it('persist file + nạp lại', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'vtc-epg-')), 'epg.db.json');
    const a = new EpgStore(f);
    a.setDay(dayFixture(809, '2026-09-15', '2026-09-15T08:00:00+07:00', ['A']));
    a.save();
    const b = new EpgStore(f);
    assert.equal(b.getDay(809, '2026-09-15')?.programs[0]?.title, 'A');
  });
});

describe('epg client', () => {
  const okFetch = (async (url: string) => {
    if (url.includes('/channels?')) {
      return new Response(JSON.stringify({ channels: [{ id: 809, name: 'VTV1', description: '' }], total: 1 }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({
        channelId: 809,
        date: '2026-09-15',
        timezone: '+07:00',
        programs: [
          {
            id: '809-20260915-0',
            channelId: 809,
            title: 'T',
            description: '',
            startTime: '2026-09-15T00:00:00+07:00',
            endTime: '2026-09-15T00:30:00+07:00',
            updatedAt: '2026-09-15T08:29:03+07:00',
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  it('list + schedule sắp xếp + batch stamp', async () => {
    const c = new EpgClient({ baseUrl: 'https://x.test/api/v1', apiKey: 'K', fetchFn: okFetch });
    assert.equal(c.configured, true);
    const all = await c.listAllChannels();
    assert.deepEqual(all.map((x) => x.id), [809]);
    const d = await c.getSchedule(809, '2026-09-15');
    assert.equal(d.programs.length, 1);
    assert.equal(d.updatedAt, '2026-09-15T08:29:03+07:00');
  });

  it('thiếu key → lỗi rõ; date sai → lỗi rõ; 429 → EpgError', async () => {
    const c = new EpgClient({ baseUrl: 'https://x.test', apiKey: '' });
    await assert.rejects(() => c.getSchedule(809, '2026-09-15'), /VTC_EPG_API_KEY/);
    const c2 = new EpgClient({ baseUrl: 'https://x.test', apiKey: 'K', fetchFn: okFetch });
    await assert.rejects(() => c2.getSchedule(809, '15/09/2026'), /YYYY-MM-DD/);
    const limited = new EpgClient({
      baseUrl: 'https://x.test',
      apiKey: 'K',
      retryAfterMs: 1,
      fetchFn: (async () => new Response('{}', { status: 429 })) as typeof fetch,
    });
    await assert.rejects(() => limited.getSchedule(809, '2026-09-15'), /429/);
  });
});

describe('epg sync', () => {
  it('đếm updated/skipped/errors + prune', async () => {
    const store = new EpgStore();
    store.setDay(dayFixture(809, '2026-09-14', '2026-09-14T08:00:00+07:00', ['Cu']));
    const fetchFn = (async (url: string) => {
      if (url.includes('/809/epg?date=2026-09-16')) {
        return new Response(JSON.stringify({ channelId: 809, date: '2026-09-16', timezone: '+07:00', programs: [] }), {
          status: 200,
        });
      }
      if (url.includes('/809/epg?')) {
        return new Response(
          JSON.stringify({
            channelId: 809,
            date: '2026-09-15',
            timezone: '+07:00',
            programs: [
              {
                id: 'x',
                channelId: 809,
                title: 'Moi',
                description: '',
                startTime: '2026-09-15T00:00:00+07:00',
                endTime: '2026-09-15T00:30:00+07:00',
                updatedAt: '2026-09-15T10:00:00+07:00',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{"message":"khong thay"}', { status: 404 });
    }) as typeof fetch;
    const client = new EpgClient({ baseUrl: 'https://x.test', apiKey: 'K', fetchFn });
    const stats = await syncNow({
      store,
      client,
      mappings: [
        { partnerChannelId: 809, localName: 'vtv1' },
        { partnerChannelId: 999, localName: 'lach' },
      ],
      pastDays: 1,
      futureDays: 0,
      today: '2026-09-16',
    });
    assert.equal(stats.mappings, 2);
    assert.ok(stats.updated >= 1);
    assert.ok(stats.errors.some((e) => e.partnerChannelId === 999));
    assert.equal(store.getDay(809, '2026-09-14'), undefined); // prune ngày ngoài cửa sổ
  });

  it('vnToday + syncWindow đúng biên', () => {
    assert.equal(vnToday(new Date('2026-09-16T00:30:00+07:00').getTime()), '2026-09-16');
    assert.deepEqual(syncWindow('2026-09-16', 1, 1), ['2026-09-15', '2026-09-16', '2026-09-17']);
  });
});
