// api.test.ts — Test integration qua HTTP thật (fetch + port ngẫu nhiên).
// Fake tsp = script exec sleep để start/stop nhanh, không cần TSDuck.
// Mọi /api/* (trừ /api/auth/*) cần cookie login — đúng gate Prod.
// Chạy: npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createApi } from './server.js';
import { setLogDir } from '../core/logger.js';

const fakeTsp = '/tmp/vtc-fake-api-tsp.sh';
const confDir = '/tmp/vtc-test-conf';
const capsDir = '/tmp/vtc-test-caps';
const expsDir = '/tmp/vtc-test-exps';

before(() => {
  setLogDir('/tmp/vtc-test-api-logs'); // logger không ghi vào repo
  // Fake tsp 3 chế độ: chứa 'tables' → in PAT giả (1 program, hoặc 2 nếu
  // VTC_FAKE_PROGRAMS=2) rồi exit 0 (cho timeshift probe); arg cuối *.ts → ghi
  // output + exit 0 (export); ngược lại exec sleep (start/stop dài hạn).
  writeFileSync(
    fakeTsp,
    '#!/bin/sh\ncase "$*" in *tables*) echo "* PAT, TID 0x00"; echo "    Program:     1 (0x0001)  PID:   32"; if [ "$VTC_FAKE_PROGRAMS" = "2" ]; then echo "    Program:     2 (0x0002)  PID:   33"; fi; exit 0;; esac\nout=""; for a in "$@"; do out="$a"; done\ncase "$out" in *.ts) echo fake-ts > "$out"; exit 0;; esac\nexec sleep 60\n',
    'utf8',
  );
  chmodSync(fakeTsp, 0o755);
  mkdirSync(confDir, { recursive: true });
  mkdirSync(expsDir, { recursive: true });
});

describe('API', { concurrency: false }, () => {
  let base = '';
  let close = async (): Promise<void> => {};
  let cookie = '';

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
    });

  // Mock API EPG đối tác (shape thật): 1 kênh 809 + lịch theo date trong query.
  const fakeEpgFetch = (async (url: string) => {
    if (url.includes('/channels?')) {
      return new Response(
        JSON.stringify({ channels: [{ id: 809, name: 'VTV1', description: '' }], total: 1 }),
        { status: 200 },
      );
    }
    const m = /\/channels\/(\d+)\/epg\?date=([\d-]+)/.exec(url);
    const pid = m !== null ? Number(m[1]) : 0;
    const date = m !== null ? (m[2] ?? '') : '';
    return new Response(
      JSON.stringify({
        channelId: pid,
        date,
        timezone: '+07:00',
        programs: [
          {
            id: `${pid}-${date}-0`,
            channelId: pid,
            title: 'CT-Test',
            description: '',
            startTime: `${date}T00:00:00+07:00`,
            endTime: `${date}T00:30:00+07:00`,
            updatedAt: `${date}T08:00:00+07:00`,
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  before(async () => {
    const api = createApi({
      port: 0,
      confDir,
      captureDir: capsDir,
      exportsDir: expsDir,
      tspBin: fakeTsp,
      jwtSecret: 'test-secret',
      adminPass: 'test-admin-123',
      persist: false,
      autoStart: false,
      epgFetchFn: fakeEpgFetch,
    });
    const s = await api.listen(0);
    base = `http://127.0.0.1:${s.port}`;
    close = s.close;
    // Login lấy cookie cho các test sau.
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-admin-123' }),
    });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /vtc_token=.+;.*HttpOnly/);
    cookie = setCookie.split(';')[0] ?? '';
  });

  after(async () => {
    await close();
  });

  const body = {
    id: 'API1',
    input: 'file /tmp/vtc-demo/input.ts --repeat',
    recordAll: true,
    channels: [
      { name: 'demo4', serviceId: 4, isLive: true },
      { name: 'demo5', serviceId: 5, isLive: true },
    ],
  };

  it('health OK (public)', async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
  });

  it('không cookie → 401, không chạm được nghiệp vụ', async () => {
    const r = await fetch(`${base}/api/sources`);
    assert.equal(r.status, 401);
    const r2 = await fetch(`${base}/api/sources/API1/start`, { method: 'POST' });
    assert.equal(r2.status, 401);
  });

  it('login sai → 401 message chung', async () => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'sai-hoan-toan' }),
    });
    assert.equal(r.status, 401);
  });

  it('CRUD source', async () => {
    let r = await req('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 201);

    r = await req('/api/sources');
    const list = (await r.json()) as unknown[];
    assert.equal(list.length, 1);

    r = await req('/api/sources/API1');
    assert.equal(r.status, 200);
  });

  it('preview-conf khớp logic ConfigGenerator', async () => {
    const r = await req('/api/sources/API1/preview-conf');
    assert.equal(r.status, 200);
    const j = (await r.json()) as { conf: string; liveCount: number };
    assert.equal(j.liveCount, 2);
    assert.match(j.conf, /tsp -P zap 4 -O hls/);
  });

  it('start rồi stop (fake tsp, kill nhóm thật)', async () => {
    let r = await req('/api/sources/API1/start', { method: 'POST' });
    assert.equal(r.status, 200);
    const started = (await r.json()) as { pid: number };
    assert.ok(started.pid > 0);
    // Start phải tự tạo thư mục output (TSDuck không tự mkdir — thiếu là chết ngay).
    const { existsSync: ex } = await import('node:fs');
    assert.ok(ex(`${capsDir}/API1`), 'captures/<id> phải được tạo khi Start');
    assert.ok(ex('storage/ramdisk/demo4'), 'live/<kenh> phải được tạo khi Start');

    r = await req('/api/sources/API1');
    const cur = (await r.json()) as { status: string };
    assert.equal(cur.status, 'RUNNING');

    r = await req('/api/sources/API1/stop', { method: 'POST' });
    assert.equal(r.status, 200);
  });

  it('đổi mật khẩu: sai hiện tại → 401, đúng → login lại được', async () => {
    let r = await req('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'sai', newPassword: 'newpass-123', confirmPassword: 'newpass-123' }),
    });
    assert.equal(r.status, 401);

    r = await req('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'test-admin-123', newPassword: 'short', confirmPassword: 'short' }),
    });
    assert.equal(r.status, 400); // < 8 ký tự

    r = await req('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'test-admin-123',
        newPassword: 'newpass-123',
        confirmPassword: 'newpass-123',
      }),
    });
    assert.equal(r.status, 200);

    // Login bằng MK mới OK, MK cũ fail.
    const ok = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newpass-123' }),
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-admin-123' }),
    });
    assert.equal(bad.status, 401);
  });

  it('forgot-password luôn message chung (kể cả email lạ)', async () => {
    for (const email of ['admin@vtc.local', 'khong-ton-tai@x.y']) {
      const r = await fetch(`${base}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(r.status, 200);
      const j = (await r.json()) as { message: string };
      assert.match(j.message, /Nếu email hợp lệ/);
    }
  });

  it('admin gc + hls-health cần auth', async () => {
    const noAuth = await fetch(`${base}/api/admin/gc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noAuth.status, 401);

    const r = await req('/api/admin/gc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { deleted: string[]; dryRun: boolean };
    assert.equal(j.dryRun, true);
    assert.ok(Array.isArray(j.deleted));

    const h = await req('/api/admin/hls-health');
    assert.equal(h.status, 200);
  });

  it('admin notify + backup/restore cần auth, roundtrip đúng', async () => {
    const noAuth = await fetch(`${base}/api/admin/notify-test`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    let r = await req('/api/admin/notify-status');
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { configured: boolean }).configured, false);

    r = await req('/api/admin/notify-test', { method: 'POST' });
    assert.equal(r.status, 200);
    const nt = (await r.json()) as { result: string };
    assert.equal(nt.result, 'logged'); // chưa cấu hình Telegram → log

    r = await req('/api/admin/config-backup');
    assert.equal(r.status, 200);
    const bak = (await r.json()) as { sources: { id: string }[] };
    assert.ok(Array.isArray(bak.sources) && bak.sources.length >= 1);

    // Body sai → 400
    r = await req('/api/admin/config-restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [{ id: 'Xấu!!' }] }),
    });
    assert.equal(r.status, 400);

    // Restore đúng → thay toàn bộ, backup cũ vẫn phục hồi được
    r = await req('/api/admin/config-restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: [
          {
            id: 'RSB',
            input: 'file /tmp/x.ts',
            recordAll: false,
            channels: [{ name: 'c9', serviceId: 9, isLive: true }],
          },
        ],
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { count: number }).count, 1);
    let list = (await (await req('/api/sources')).json()) as { id: string }[];
    assert.deepEqual(list.map((s) => s.id), ['RSB']);

    r = await req('/api/admin/config-restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: bak.sources }),
    });
    assert.equal(r.status, 200);
    list = (await (await req('/api/sources')).json()) as { id: string }[];
    assert.ok(list.some((s) => s.id === 'API1'));
  });

  it('exports: submit → poll SUCCESS → download → delete', async () => {
    // Seed 1 chunk catchup cho S1 phủ thời điểm hiện tại.
    const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
    mk(`${capsDir}/S1`, { recursive: true });
    wr(`${capsDir}/S1/catchup_00001.ts`, 'chunk');

    const noAuth = await fetch(`${base}/api/exports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noAuth.status, 401);

    const now = Date.now();
    let r = await req('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelName: 'demo4',
        sourceId: 'S1',
        serviceId: 4,
        inPoint: new Date(now - 120_000).toISOString(),
        outPoint: new Date(now).toISOString(),
      }),
    });
    assert.equal(r.status, 200);
    const created = (await r.json()) as { id: string; status: string };
    assert.ok(created.id.startsWith('exp_'));

    // Poll tới trạng thái cuối (fake tsp xong trong ms).
    let job: { status: string; fileName: string } = { status: created.status, fileName: '' };
    for (let i = 0; i < 100 && (job.status === 'QUEUED' || job.status === 'PROCESSING'); i++) {
      await new Promise((rr) => setTimeout(rr, 50));
      const g = await req(`/api/exports/${created.id}`);
      job = (await g.json()) as typeof job;
    }
    assert.equal(job.status, 'SUCCESS');

    // Download stream: header attachment + đúng tên file.
    r = await req(`/api/exports/${created.id}/download`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="demo4_.*\.ts"/);
    assert.match(await r.text(), /fake-ts/);

    // Xóa: file vật lý mất + record mất.
    r = await req(`/api/exports/${created.id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await req(`/api/exports/${created.id}`);
    assert.equal(r.status, 404);
  });

  it('exports: quá 6h bị chặn 400', async () => {
    const now = Date.now();
    const r = await req('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channelName: 'demo4',
        sourceId: 'S1',
        serviceId: 4,
        inPoint: new Date(now - 7 * 3600_000).toISOString(),
        outPoint: new Date(now).toISOString(),
      }),
    });
    assert.equal(r.status, 400);
    const j = (await r.json()) as { error: string };
    assert.match(j.error, /tối đa 6 tiếng/);
  });

  it('từ chối config xấu ngay lúc tạo (400, không đợi tới start)', async () => {
    const r = await req('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, id: 'BAD', channels: [{ name: 'ten xau', serviceId: 1, isLive: true }] }),
    });
    assert.equal(r.status, 400);
  });

  it('tên kênh trùng (trong/cross-source) → 400, tên lạ → 201', async () => {
    const post = (id: string, channels: unknown): Promise<Response> =>
      req('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, input: 'file /tmp/x.ts', recordAll: true, channels }),
      });
    // API1 đã có kênh demo4/demo5 (đã restore ở test backup trước đó).
    let r = await post('DUP1', [{ name: 'demo4', serviceId: 40, isLive: true }]);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /trùng/);

    r = await post('DUP2', [
      { name: 'kenhmoi', serviceId: 41, isLive: true },
      { name: 'kenhmoi', serviceId: 42, isLive: true },
    ]);
    assert.equal(r.status, 400);

    // PUT gây trùng với nguồn khác cũng 400.
    r = await post('TMPOK', [{ name: 'tamok', serviceId: 43, isLive: true }]);
    assert.equal(r.status, 201);
    r = await req('/api/sources/API1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ name: 'tamok', serviceId: 4, isLive: true }] }),
    });
    assert.equal(r.status, 400);

    // Tên duy nhất thì qua, rồi dọn.
    r = await post('UNIQ1', [{ name: 'kenhdocnhat', serviceId: 44, isLive: true }]);
    assert.equal(r.status, 201);
    for (const id of ['TMPOK', 'UNIQ1']) {
      const d = await req(`/api/sources/${id}`, { method: 'DELETE' });
      assert.equal(d.status, 200);
    }
  });

  it('hls-tokens: 401 khi chưa login, 404 kênh lạ, 200 + clamp TTL', async () => {
    const noAuth = await fetch(`${base}/api/hls-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'demo4' }),
    });
    assert.equal(noAuth.status, 401);

    let r = await req('/api/hls-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'khong-co-kenh-nay' }),
    });
    assert.equal(r.status, 404);

    r = await req('/api/hls-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'demo4', ttlMinutes: 100000 }),
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { token: string; exp: number; url: string };
    assert.match(j.token, /^[0-9a-f]{64}$/);
    const ttlMin = Math.round((j.exp - Date.now()) / 60000);
    assert.ok(ttlMin <= 1440 && ttlMin >= 1430, `TTL phải kẹp 1440, được ${ttlMin}`);
    assert.match(j.url, /^\/hls\/demo4\/index\.m3u8\?token=[0-9a-f]{64}&exp=\d+$/);
  });

  it('pull-tokens + public/channels: Bearer đối tác đi được, lạ thì 401', async () => {
    process.env['VTC_PARTNER_KEYS'] = 'vtvgo:KEYDOI-TAC-123';
    try {
      const anon = await fetch(`${base}/api/public/channels`);
      assert.equal(anon.status, 401);
      await anon.body?.cancel().catch(() => {});

      // Bearer sai + không cookie → 401 (dùng fetch trần vì helper req tự gắn cookie login).
      const bad = await fetch(`${base}/api/public/channels`, { headers: { authorization: 'Bearer sai' } });
      assert.equal(bad.status, 401);
      await bad.body?.cancel().catch(() => {});

      const authed = (path: string, init?: RequestInit): Promise<Response> =>
        req(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: 'Bearer KEYDOI-TAC-123' } });

      // Bearer đi qua gate tới cả API thường.
      let r = await authed('/api/sources');
      assert.equal(r.status, 200);

      r = await authed('/api/pull-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'khong-co' }),
      });
      assert.equal(r.status, 404);

      r = await authed('/api/pull-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'demo4' }),
      });
      assert.equal(r.status, 200);
      const pt = (await r.json()) as { pull: string; url: string };
      assert.match(pt.pull, /^[0-9a-f]{64}$/);
      assert.match(pt.url, /^\/hls\/demo4\/index\.m3u8\?pull=[0-9a-f]{64}$/);
      // Pull token verify được bằng cùng secret (không hạn).
      const { verifyPullToken } = await import('./hlsToken.js');
      assert.equal(verifyPullToken('demo4', pt.pull), true);

      r = await authed('/api/public/channels');
      assert.equal(r.status, 200);
      const list = (await r.json()) as {
        generatedAt: string;
        channels: { name: string; hls: string; live: boolean }[];
      };
      assert.ok(typeof list.generatedAt === 'string');
      const demo4 = list.channels.find((c) => c.name === 'demo4');
      assert.ok(demo4 !== undefined && demo4.live === true);
      assert.match(demo4.hls, /\/hls\/demo4\/index\.m3u8\?pull=[0-9a-f]{64}$/);
    } finally {
      delete process.env['VTC_PARTNER_KEYS'];
    }
  });

  it('epg mapping: id sai/trùng → 400, đúng → 201', async () => {
    const post = (id: string, channels: unknown): Promise<Response> =>
      req('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, input: 'file /tmp/x.ts', recordAll: true, channels }),
      });
    let r = await post('EPGBAD', [{ name: 'k1', serviceId: 60, isLive: false, partnerChannelId: 0 }]);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /số nguyên/);

    r = await post('EPGMAP', [{ name: 'kenhEpg', serviceId: 61, isLive: false, partnerChannelId: 809 }]);
    assert.equal(r.status, 201);

    r = await post('EPGDUP', [{ name: 'k2', serviceId: 62, isLive: false, partnerChannelId: 809 }]);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /trùng/);

    r = await req('/api/sources/API1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channels: [
          { name: 'demo4', serviceId: 4, isLive: true },
          { name: 'demo5', serviceId: 5, isLive: true, partnerChannelId: -5 },
        ],
      }),
    });
    assert.equal(r.status, 400);
  });

  it('epg sync + schedule + public epgId (mock fetch)', async () => {
    delete process.env['VTC_EPG_API_KEY'];
    let r = await req('/api/admin/epg-sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 400); // chưa key thì từ chối rõ ràng

    process.env['VTC_EPG_API_KEY'] = 'K-TEST';
    try {
      r = await req('/api/epg/partner-channels?search=VTV');
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { total: number }).total, 1);

      r = await req('/api/epg/status');
      assert.equal(r.status, 200);
      const st = (await r.json()) as { configured: boolean; mappings: { partnerChannelId: number }[] };
      assert.equal(st.configured, true);
      assert.ok(st.mappings.some((x) => x.partnerChannelId === 809));

      r = await req('/api/admin/epg-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(r.status, 200);
      const stats = (await r.json()) as { updated: number; errors: unknown[] };
      assert.ok(stats.updated >= 1);
      assert.deepEqual(stats.errors, []);

      const { vnToday } = await import('../epg/sync.js');
      const today = vnToday();
      r = await req(`/api/epg/schedule?channel=demo4&date=${today}`);
      assert.equal(r.status, 404); // demo4 chưa map
      r = await req('/api/epg/schedule?channel=kenhEpg&date=15/09/2026');
      assert.equal(r.status, 400);
      r = await req(`/api/epg/schedule?channel=kenhEpg&date=${today}`);
      assert.equal(r.status, 200);
      const day = (await r.json()) as { programs: { title: string }[]; localName: string };
      assert.equal(day.programs.length, 1);
      assert.equal(day.programs[0]?.title, 'CT-Test');
      assert.equal(day.localName, 'kenhEpg');

      r = await req('/api/public/channels');
      const pub = (await r.json()) as { channels: { name: string; epgId: number | null }[] };
      assert.equal(pub.channels.find((c) => c.name === 'kenhEpg')?.epgId, 809);
      assert.equal(pub.channels.find((c) => c.name === 'demo4')?.epgId, null);

      const d = await req('/api/sources/EPGMAP', { method: 'DELETE' });
      assert.equal(d.status, 200);
    } finally {
      delete process.env['VTC_EPG_API_KEY'];
    }
  });

  it('timeshift SPTS: playlist ảo + chunks (mock chunk + fake PAT)', async () => {
    const { mkdirSync: mk, writeFileSync: wr, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    mk(join(capsDir, 'TMS'), { recursive: true });
    const now = Date.now();
    const files: [string, number][] = [
      ['catchup_00001.ts', now - 300_000],
      ['catchup_00002.ts', now - 60_000],
      ['catchup_00003.ts', now],
    ];
    for (const [n, mt] of files) {
      const p = join(capsDir, 'TMS', n);
      wr(p, `chunk-${n}`);
      utimesSync(p, new Date(mt), new Date(mt));
    }
    let r = await req('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'TMS',
        input: 'file /tmp/x.ts',
        recordAll: true,
        channels: [{ name: 'tsShift', serviceId: 70, isLive: false }],
      }),
    });
    assert.equal(r.status, 201);

    const q = `inPoint=${now - 400_000}&outPoint=${now}`;
    r = await req(`/api/timeshift/tsShift?${q}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /mpegurl/);
    const pl = await r.text();
    assert.ok(pl.includes('#EXT-X-MEDIA-SEQUENCE:1'));
    assert.ok(pl.includes('#EXT-X-DISCONTINUITY')); // gap 240s giữa chunk 1-2
    assert.ok(pl.includes('/api/timeshift/chunks?source=TMS&file=catchup_00002.ts&channel=tsShift&token='));
    assert.ok(pl.trimEnd().endsWith('#EXT-X-ENDLIST'));

    // Chunk không cookie nhưng token trong URL vẫn 200 (miễn gate đúng).
    const m = /token=[0-9a-f]{64}&exp=\d+/.exec(pl);
    assert.ok(m !== null);
    const noCookie = await fetch(`${base}/api/timeshift/chunks?source=TMS&file=catchup_00002.ts&channel=tsShift&${m[0]}`);
    assert.equal(noCookie.status, 200);
    assert.equal(await noCookie.text(), 'chunk-catchup_00002.ts');

    // Token sai nhưng đã login (cookie) → qua gate, rớt ở handler: 403.
    const bad = await req(
      `/api/timeshift/chunks?source=TMS&file=catchup_00002.ts&channel=tsShift&token=${'0'.repeat(64)}&exp=9999999999999`,
    );
    assert.equal(bad.status, 403);
    await bad.body?.cancel().catch(() => {});
    // Thiếu hẳn auth → gate chặn: 401.
    const naked = await fetch(`${base}/api/timeshift/chunks?source=TMS&file=catchup_00002.ts&channel=tsShift`);
    assert.equal(naked.status, 401);
    await naked.body?.cancel().catch(() => {});

    // Traversal + khoảng sai + quá 6h + kênh lạ + hết retention.
    for (const [path, want] of [
      [`/api/timeshift/chunks?source=TMS&file=../x.ts&channel=tsShift&${m[0]}`, 400],
      [`/api/timeshift/tsShift?inPoint=${now}&outPoint=${now - 1000}`, 400],
      [`/api/timeshift/tsShift?inPoint=${now - 7 * 3600_000}&outPoint=${now}`, 400],
      [`/api/timeshift/khongco?inPoint=${now - 1000}&outPoint=${now}`, 404],
      [`/api/timeshift/tsShift?inPoint=1577836800000&outPoint=1577836900000`, 404],
    ] as [string, number][]) {
      const rr = await req(path);
      assert.equal(rr.status, want, path);
      await rr.body?.cancel().catch(() => {});
    }

    const d = await req('/api/sources/TMS', { method: 'DELETE' });
    assert.equal(d.status, 200);
  });

  it('timeshift MPTS: báo thẳng dùng Trích xuất (fake PAT 2 programs)', async () => {
    const { mkdirSync: mk, writeFileSync: wr } = await import('node:fs');
    const { join } = await import('node:path');
    mk(join(capsDir, 'TMM'), { recursive: true });
    wr(join(capsDir, 'TMM', 'catchup_00001.ts'), 'mpts');
    let r = await req('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'TMM',
        input: 'file /tmp/x.ts',
        recordAll: true,
        channels: [{ name: 'tsMulti', serviceId: 71, isLive: false }],
      }),
    });
    assert.equal(r.status, 201);
    process.env['VTC_FAKE_PROGRAMS'] = '2';
    try {
      const now = Date.now();
      r = await req(`/api/timeshift/tsMulti?inPoint=${now - 120_000}&outPoint=${now}`);
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /MPTS.*Trích xuất/);
    } finally {
      delete process.env['VTC_FAKE_PROGRAMS'];
    }
    const d = await req('/api/sources/TMM', { method: 'DELETE' });
    assert.equal(d.status, 200);
  });

  it('SSE cần auth + trả event', async () => {
    const noAuth = await fetch(`${base}/api/system/stream`);
    assert.equal(noAuth.status, 401);
    await noAuth.body?.cancel().catch(() => {});

    const ctrl = new AbortController();
    const res = await req('/api/system/stream', { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const { value } = await reader.read();
    const txt = new TextDecoder().decode(value);
    assert.match(txt, /^data: /);
    const payload = JSON.parse(txt.replace(/^data: /, '')) as { cpu: number };
    assert.equal(typeof payload.cpu, 'number');
    ctrl.abort();
    await reader.cancel().catch(() => {});
  });
});

describe('auto-restart', { concurrency: false }, () => {
  it('crash → ERROR → tự RUNNING lại; stop tay thì ở yên STOPPED', async () => {
    const fakeExit = '/tmp/vtc-fake-exit3.sh';
    // Sống 0.3s rồi mới exit 3: cửa sổ RUNNING đủ rộng để poll 50ms bắt được,
    // tránh flaky khi máy tải nặng (trước đây exit ngay → RUNNING chỉ vài ms).
    writeFileSync(fakeExit, '#!/bin/sh\nsleep 0.3\nexit 3\n', 'utf8');
    chmodSync(fakeExit, 0o755);

    const api = createApi({
      port: 0,
      confDir: '/tmp/vtc-test-conf2',
      tspBin: fakeExit,
      jwtSecret: 'test-secret',
      adminPass: 'pw-restart-1',
      restartDelayMs: 150,
      persist: false,
      autoStart: false,
    });
    const s = await api.listen(0);
    const b = `http://127.0.0.1:${s.port}`;
    try {
      const login = await fetch(`${b}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'pw-restart-1' }),
      });
      const ck = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const authed = (path: string, init?: RequestInit): Promise<Response> =>
        fetch(`${b}${path}`, { ...init, headers: { ...(init?.headers ?? {}), cookie: ck } });

      await authed('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'RS1',
          input: 'file /tmp/x.ts',
          recordAll: false,
          channels: [{ name: 'c1', serviceId: 1, isLive: true }],
        }),
      });
      await authed('/api/sources/RS1/start', { method: 'POST' });

      // Fake exit 3 ngay → vòng restart 150ms đưa về RUNNING (poll tối đa 5s).
      let status = '';
      for (let i = 0; i < 100; i++) {
        const cur = (await (await authed('/api/sources/RS1')).json()) as { status: string };
        status = cur.status;
        if (status === 'RUNNING' && i > 2) break; // qua ít nhất 1 vòng crash→restart
        await new Promise((rr) => setTimeout(rr, 50));
      }
      assert.equal(status, 'RUNNING');

      // Stop tay → ở yên STOPPED (không restart nữa).
      await authed('/api/sources/RS1/stop', { method: 'POST' });
      await new Promise((rr) => setTimeout(rr, 400));
      const after = (await (await authed('/api/sources/RS1')).json()) as { status: string };
      assert.equal(after.status, 'STOPPED');
    } finally {
      await s.close();
    }
  });
});
