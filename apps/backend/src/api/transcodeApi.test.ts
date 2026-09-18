// transcodeApi.test.ts — T2: preset CRUD + lifecycle ffmpeg qua HTTP thật.
// Fake ffmpeg: `-encoders` → in libx264 (KHÔNG có h264_nvenc để test block
// nvenc), còn lại exec sleep. Fake srt-live-transmit: sleep (pass) hoặc
// exit 1 khi VTC_FAKE_SRT_FAIL=1 (fail).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createApi } from './server.js';
import { setLogDir } from '../core/logger.js';

const fakeTsp = '/tmp/vtc-fake-tc-tsp.sh';
const fakeFfmpeg = '/tmp/vtc-fake-tc-ffmpeg.sh';
const fakeSrt = '/tmp/vtc-fake-tc-srt.sh';
const confDir = '/tmp/vtc-test-tc-conf';
const capsDir = '/tmp/vtc-test-tc-caps';
const expsDir = '/tmp/vtc-test-tc-exps';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(() => {
  setLogDir('/tmp/vtc-test-tc-logs');
  writeFileSync(fakeTsp, '#!/bin/sh\nexec sleep 60\n', 'utf8');
  chmodSync(fakeTsp, 0o755);
  writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\ncase "$*" in *-encoders*) echo " Encoders:"; echo " V..... libx264 libx264 H.264 / AVC"; exit 0;; esac\nexec sleep 60\n',
    'utf8',
  );
  chmodSync(fakeFfmpeg, 0o755);
  writeFileSync(
    fakeSrt,
    '#!/bin/sh\nif [ "$VTC_FAKE_SRT_FAIL" = "1" ]; then echo "connection refused" >&2; exit 1; fi\nexec sleep 60\n',
    'utf8',
  );
  chmodSync(fakeSrt, 0o755);
  mkdirSync(confDir, { recursive: true });
  mkdirSync(capsDir, { recursive: true });
  mkdirSync(expsDir, { recursive: true });
});

describe('Transcode API', { concurrency: false }, () => {
  let base = '';
  let close = async (): Promise<void> => {};
  let cookie = '';

  const req = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
    });
  const json = (b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
  const putJson = (b: unknown): RequestInit => ({
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

  before(async () => {
    const api = createApi({
      port: 0,
      confDir,
      captureDir: capsDir,
      exportsDir: expsDir,
      tspBin: fakeTsp,
      ffmpegBin: fakeFfmpeg,
      srtBin: fakeSrt,
      tcStartDelayMs: 50,
      tcRestartDelayMs: 100,
      jwtSecret: 'test-secret-tc',
      adminPass: 'test-admin-123',
      persist: false,
      autoStart: false,
    });
    const s = await api.listen(0);
    base = `http://127.0.0.1:${s.port}`;
    close = s.close;
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-admin-123' }),
    });
    assert.equal(r.status, 200);
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  after(async () => {
    try {
      await req('/api/sources/TC1', { method: 'DELETE' });
    } catch {
      /* dọn */
    }
    await close();
  });

  const tcChannel = {
    name: 'tcv1',
    serviceId: 11,
    isLive: true,
    transcode: {
      enabled: true,
      loopbackPort: 6001,
      presetIds: ['p720'],
      outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9001 }],
    },
  };

  it('preset seed đủ 5 dòng lúc boot', async () => {
    const r = await req('/api/presets');
    assert.equal(r.status, 200);
    const arr = (await r.json()) as { id: string }[];
    assert.deepEqual(arr.map((p) => p.id).sort(), ['p1080', 'p360', 'p480', 'p720', 'paudio']);
  });

  it('preset CRUD: tạo → trùng 400 → sửa → xóa', async () => {
    let r = await req('/api/presets', json({ id: 'px', name: 'X', video: null, audio: { codec: 'aac', bitrateKbps: 64, sampleRate: 48000, channels: 2 } }));
    assert.equal(r.status, 201);
    r = await req('/api/presets', json({ id: 'px', name: 'X', video: null, audio: { codec: 'aac', bitrateKbps: 64, sampleRate: 48000, channels: 2 } }));
    assert.equal(r.status, 400);
    r = await req('/api/presets/px', putJson({ id: 'px', name: 'X2', video: null, audio: { codec: 'aac', bitrateKbps: 96, sampleRate: 48000, channels: 2 } }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { audio: { bitrateKbps: number } }).audio.bitrateKbps, 96);
    r = await req('/api/presets/px', { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await req('/api/presets/px', { method: 'DELETE' });
    assert.equal(r.status, 404);
  });

  it('tạo source có kênh transcode → conf sinh được fork loopback', async () => {
    const r = await req(
      '/api/sources',
      json({ id: 'TC1', input: 'file /tmp/vtc-demo/input.ts --repeat', recordAll: true, channels: [tcChannel] }),
    );
    assert.equal(r.status, 201);
    const prev = await req('/api/sources/TC1/preview-conf');
    assert.equal(prev.status, 200);
    const conf = ((await prev.json()) as { conf: string }).conf;
    assert.ok(conf.includes('tsp -P zap 11 -O ip 127.0.0.1:6001'), 'conf phải có fork loopback');
  });

  it('cấm xóa preset đang dùng', async () => {
    const r = await req('/api/presets/p720', { method: 'DELETE' });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /TC1\/tcv1/);
  });

  it('start source → ffmpeg spawn sau delay; status thấy kênh', async () => {
    const r = await req('/api/sources/TC1/start', { method: 'POST' });
    assert.equal(r.status, 200);
    await sleep(600); // tcStartDelayMs=50 + spawn
    const s = await req('/api/transcode/status');
    assert.equal(s.status, 200);
    const arr = (await s.json()) as { key: string; running: boolean }[];
    assert.deepEqual(arr.map((x) => x.key), ['TC1/tcv1']);
    assert.equal(arr[0]?.running, true);
  });

  it('bật/tắt transcode khi RUNNING → 400 (tầng cấu trúc)', async () => {
    const off = { ...tcChannel.transcode, enabled: false };
    const r = await req('/api/sources/TC1/channels/tcv1/transcode', putJson({ transcode: off }));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /stop source trước/);
  });

  it('đổi endpoint khi RUNNING → 200 + hot-restart ffmpeg', async () => {
    const changed = {
      ...tcChannel.transcode,
      outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9002 }],
    };
    const r = await req('/api/sources/TC1/channels/tcv1/transcode', putJson({ transcode: changed }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { restarted: boolean }).restarted, true);
    const s = await req('/api/transcode/status');
    assert.equal((await s.json() as { key: string }[]).length, 1);
  });

  it('srt-test: đúng port → 200; sai port → 400; listener chết → 502', async () => {
    let r = await req('/api/sources/TC1/channels/tcv1/srt-test', json({ port: 9002 }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { ok: boolean }).ok, true);
    r = await req('/api/sources/TC1/channels/tcv1/srt-test', json({ port: 9999 }));
    assert.equal(r.status, 400);
    process.env['VTC_FAKE_SRT_FAIL'] = '1';
    try {
      r = await req('/api/sources/TC1/channels/tcv1/srt-test', json({ port: 9002 }));
      assert.equal(r.status, 502);
    } finally {
      delete process.env['VTC_FAKE_SRT_FAIL'];
    }
  });

  it('engine nvenc bị chặn fail-fast (fake thiếu h264_nvenc)', async () => {
    const nvenc = { ...tcChannel.transcode, engine: 'nvenc' };
    const r = await req('/api/sources/TC1/channels/tcv1/transcode', putJson({ transcode: nvenc }));
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as { error: string }).error, /h264_nvenc/);
    // trả về cpu để các test sau chạy tiếp
    const back = await req('/api/sources/TC1/channels/tcv1/transcode', putJson({ transcode: tcChannel.transcode }));
    assert.equal(back.status, 200);
  });

  it('transcode-stop/start tay; start khi source STOPPED → 400', async () => {
    let r = await req('/api/sources/TC1/channels/tcv1/transcode-stop', { method: 'POST' });
    assert.equal(r.status, 200);
    let s = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(s.length, 0);
    r = await req('/api/sources/TC1/channels/tcv1/transcode-start', { method: 'POST' });
    assert.equal(r.status, 200);
    s = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(s.length, 1);
    await req('/api/sources/TC1/stop', { method: 'POST' });
    await sleep(200);
    s = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(s.length, 0); // stop source diệt luôn ffmpeg
    r = await req('/api/sources/TC1/channels/tcv1/transcode-start', { method: 'POST' });
    assert.equal(r.status, 400);
    // start lại source cho test crash sau
    await req('/api/sources/TC1/start', { method: 'POST' });
    await sleep(600);
  });

  it('ffmpeg crash → auto-restart sau delay', async () => {
    const s0 = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
    assert.equal(s0.length, 1);
    process.kill(s0[0]?.pid ?? 0, 'SIGKILL');
    const deadline = Date.now() + 4000;
    let running = false;
    while (Date.now() < deadline) {
      await sleep(200);
      const s = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
      if (s.length === 1 && s[0]?.pid !== s0[0]?.pid) {
        running = true;
        break;
      }
    }
    assert.equal(running, true); // đã restart với pid mới
  });
});
