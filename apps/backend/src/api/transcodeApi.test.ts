// transcodeApi.test.ts — T2: preset CRUD + lifecycle ffmpeg qua HTTP thật.
// Fake ffmpeg: `-encoders` → in libx264 (KHÔNG có h264_nvenc để test block
// nvenc), còn lại exec sleep. Fake srt-live-transmit: sleep (pass) hoặc
// exit 1 khi VTC_FAKE_SRT_FAIL=1 (fail).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApi } from './server.js';
import { setLogDir } from '../core/logger.js';

const fakeTsp = '/tmp/vtc-fake-tc-tsp.sh';
const fakeFfmpeg = '/tmp/vtc-fake-tc-ffmpeg.sh';
const fakeSrt = '/tmp/vtc-fake-tc-srt.sh';
const confDir = '/tmp/vtc-test-tc-conf';
const capsDir = '/tmp/vtc-test-tc-caps';
const expsDir = '/tmp/vtc-test-tc-exps';
const liveDir = '/tmp/vtc-test-tc-live';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

before(() => {
  setLogDir('/tmp/vtc-test-tc-logs');
  writeFileSync(fakeTsp, '#!/bin/sh\nexec sleep 60\n', 'utf8');
  chmodSync(fakeTsp, 0o755);
  writeFileSync(
    fakeFfmpeg,
    '#!/bin/sh\ncase "$*" in *-encoders*) echo " Encoders:"; echo " V..... libx264 libx264 H.264"; exit 0;; esac\nif [ "$VTC_FAKE_PROGRESS_ONCE" = "1" ]; then printf "fps= 25.00\\nbitrate= 2048.0kbits/s\\nprogress=continue\\n"; fi\nexec sleep 60\n',
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
      liveDir,
      tspBin: fakeTsp,
      ffmpegBin: fakeFfmpeg,
      srtBin: fakeSrt,
      tcStartDelayMs: 50,
      tcRestartDelayMs: 100,
      tcProgressMs: 400,
      tcWatchdogMs: 300,
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

  it('srt-test srt-caller: bắt tay tới listener phía họ (fake 127.0.0.1)', async () => {
    // Thêm output caller vào kênh (endpoint tier, source đang RUNNING → hot-restart ffmpeg)
    const add = await req(
      '/api/sources/TC1/channels/tcv1/transcode',
      putJson({
        transcode: {
          enabled: true,
          loopbackPort: 6001,
          presetIds: ['p720'],
          outputs: [
            { type: 'srt-listen', presetId: 'p720', enabled: true, port: 9002 },
            { type: 'srt-caller', presetId: 'p720', enabled: true, host: '127.0.0.1', port: 9101 },
          ],
        },
      }),
    );
    assert.equal(add.status, 200);
    let r = await req('/api/sources/TC1/channels/tcv1/srt-test', json({ port: 9101 }));
    assert.equal(r.status, 200);
    assert.match(((await r.json()) as { detail: string }).detail, /127\.0\.0\.1:9101/);
    process.env['VTC_FAKE_SRT_FAIL'] = '1';
    try {
      r = await req('/api/sources/TC1/channels/tcv1/srt-test', json({ port: 9101 }));
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

  it('PUT sources đổi endpoint → hot-restart ffmpeg, tsp giữ nguyên pid', async () => {
    const src = (await (await req('/api/sources/TC1')).json()) as {
      pid: number;
      channels: { name: string; serviceId: number; isLive: boolean; transcode: { outputs: { port: number }[] } }[];
    };
    const ff0 = (await (await req('/api/transcode/status')).json()) as { pid: number; waiting: boolean }[];
    assert.equal(ff0.length, 1);
    assert.equal(typeof ff0[0]?.waiting, 'boolean'); // endpoint có trường waiting
    const ch = src.channels.find((c) => c.name === 'tcv1');
    assert.ok(ch !== undefined);
    const outputs = ch.transcode.outputs.map((o) => ({ ...o, port: 9003 }));
    const r = await req('/api/sources/TC1', putJson({ channels: [{ ...ch, transcode: { ...ch.transcode, outputs } }] }));
    assert.equal(r.status, 200);
    const src2 = (await (await req('/api/sources/TC1')).json()) as { pid: number };
    assert.equal(src2.pid, src.pid); // tsp KHÔNG restart
    const ff1 = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
    assert.equal(ff1.length, 1);
    assert.notEqual(ff1[0]?.pid, ff0[0]?.pid); // ffmpeg đã hot-restart
  });

    it('tạo/sửa source trỏ preset lạ → 400 ngay, không đợi start', async () => {    const bad = {
      id: 'TCBAD',
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: true,
      channels: [
        {
          name: 'tcbad',
          serviceId: 99,
          isLive: true,
          transcode: { enabled: true, loopbackPort: 6009, presetIds: ['khong-co'], outputs: [] },
        },
      ],
    };
    let r = await req('/api/sources', json(bad));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /không tồn tại/);
    // PUT cũng chặn
    r = await req('/api/sources/TC1', putJson({ channels: [{ name: 'tcv1', serviceId: 11, isLive: true, transcode: { enabled: true, loopbackPort: 6001, presetIds: ['khong-co'], outputs: [] } }] }));
    assert.equal(r.status, 400);
  });

  it('crash-guard: crash liên tục → dừng hẳn, không restart vô hạn', async () => {
    // Giết ffmpeg lặp lại: mỗi crash +1 trong window 5 phút (test crash trước
    // đã tích 1). Tới crash thứ 4 tổng thì guard chặn restart → status trống.
    // Vòng lặp tối đa 6 lần để không phụ thuộc số crash tích lũy trước đó.
    for (let i = 0; i < 6; i++) {
      const s = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
      if (s.length === 0) break; // đã dừng hẳn (guard kích hoạt hoặc chưa restart)
      process.kill(s[0]?.pid ?? 0, 'SIGKILL');
      // Chờ restart (nếu còn cho phép) rồi giết tiếp
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await sleep(200);
        const cur = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
        if (cur.length === 0) break; // guard chặn → khỏi chờ thêm
        if (cur[0]?.pid !== s[0]?.pid) break; // đã restart → vòng tiếp
      }
    }
    // Chốt: sau đủ crash phải dừng hẳn (không restart vô hạn)
    await sleep(600);
    const fin = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(fin.length, 0);
  });

  it('puller RTMP: tạo source + start → puller chạy trước tsp; stop → diệt', async () => {
    const body = {
      id: 'TC2',
      input: 'ip 127.0.0.1:6101',
      recordAll: false,
      channels: [{ name: 'tcrtmp', serviceId: 21, isLive: true }],
      puller: { rtmpUrl: 'rtmp://127.0.0.1:1935/live', streamKey: 'tcrtmp', udpPort: 6101 },
    };
    let r = await req('/api/sources', json(body));
    assert.equal(r.status, 201);
    r = await req('/api/sources/TC2/start', { method: 'POST' });
    assert.equal(r.status, 200);
    await sleep(300);
    const s = (await (await req('/api/transcode/status')).json()) as { key: string }[];
    assert.ok(s.some((x) => x.key === 'pull/TC2'), 'puller phải chạy sau start');
    r = await req('/api/sources/TC2/stop', { method: 'POST' });
    assert.equal(r.status, 200);
    const s2 = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(s2.length, 0); // stop diệt luôn puller
  });

  it('puller hot-update khi RUNNING (tsp giữ pid); puller sai → 400', async () => {
    await req('/api/sources/TC2/start', { method: 'POST' });
    await sleep(300);
    const src = (await (await req('/api/sources/TC2')).json()) as { pid: number };
    const p0 = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
    const pull0 = p0.find((x) => x.key === 'pull/TC2');
    assert.ok(pull0 !== undefined);
    const r = await req(
      '/api/sources/TC2',
      putJson({ puller: { rtmpUrl: 'rtmp://127.0.0.1:1935/live', streamKey: 'doi-key', udpPort: 6101 } }),
    );
    assert.equal(r.status, 200);
    const src2 = (await (await req('/api/sources/TC2')).json()) as { pid: number };
    assert.equal(src2.pid, src.pid); // tsp KHÔNG restart
    const p1 = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
    const pull1 = p1.find((x) => x.key === 'pull/TC2');
    assert.ok(pull1 !== undefined && pull1.pid !== pull0.pid); // puller đã hot-restart
    const bad = await req('/api/sources/TC2', putJson({ puller: { rtmpUrl: '', streamKey: 'k', udpPort: 6101 } }));
    assert.equal(bad.status, 400);
    await req('/api/sources/TC2/stop', { method: 'POST' });
  });

  it('puller crash → auto-restart', async () => {
    await req('/api/sources/TC2/start', { method: 'POST' });
    await sleep(300);
    const s0 = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
    const pull = s0.find((x) => x.key === 'pull/TC2');
    assert.ok(pull !== undefined);
    process.kill(pull.pid, 'SIGKILL');
    const deadline = Date.now() + 4000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(200);
      const cur = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
      const p = cur.find((x) => x.key === 'pull/TC2');
      if (p !== undefined && p.pid !== pull.pid) {
        ok = true;
        break;
      }
    }
    assert.equal(ok, true);
    await req('/api/sources/TC2/stop', { method: 'POST' });
    await req('/api/sources/TC2', { method: 'DELETE' });
  });

  it('backup/restore gồm presets: xóa rồi phục hồi lại được', async () => {    // config-restore đòi stop hết source RUNNING
    await req('/api/sources/TC1/stop', { method: 'POST' });
    const px = { id: 'px-dr', name: 'DR', video: null, audio: { codec: 'aac', bitrateKbps: 64, sampleRate: 48000, channels: 2 } };
    let r = await req('/api/presets', json(px));
    assert.equal(r.status, 201);
    const bak = (await (await req('/api/admin/config-backup')).json()) as { sources: unknown[]; presets: { id: string }[] };
    assert.ok(bak.presets.some((p) => p.id === 'px-dr'), 'backup phải gồm preset custom');
    r = await req('/api/presets/px-dr', { method: 'DELETE' });
    assert.equal(r.status, 200);
    r = await req('/api/admin/config-restore', json({ sources: bak.sources, presets: bak.presets }));
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { presets: number }).presets, bak.presets.length);
    const list = (await (await req('/api/presets')).json()) as { id: string }[];
    assert.ok(list.some((p) => p.id === 'px-dr'), 'restore phải dựng lại preset');
    // Dọn + kiểm tra backup cũ (không có presets) vẫn restore được sources
    await req('/api/presets/px-dr', { method: 'DELETE' });
    r = await req('/api/admin/config-restore', json({ sources: bak.sources }));
    assert.equal(r.status, 200);
  });

  it('trùng loopbackPort / srt-listen / multicast toàn hệ → 400', async () => {
    // TC1/tcv1 đang giữ loopback 6001 + srt 9003 (từ test hot-update).
    const mkSrc = (id: string, ch: unknown): unknown => ({
      id,
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: true,
      channels: [ch],
    });
    const mkCh = (name: string, sid: number, loop: number, outputs: unknown[]): unknown => ({
      name,
      serviceId: sid,
      isLive: true,
      transcode: { enabled: true, loopbackPort: loop, presetIds: ['p720'], outputs },
    });
    const srtOut = (port: number): unknown => ({ type: 'srt-listen', presetId: 'p720', enabled: true, port });
    let r = await req('/api/sources', json(mkSrc('TC3', mkCh('tcv3', 31, 6001, [srtOut(9011)]))));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /loopbackPort 6001 bị trùng/);
    r = await req('/api/sources', json(mkSrc('TC3', mkCh('tcv3', 31, 6002, [srtOut(9003)]))));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /srt-listen 9003 bị trùng/);
    // Multicast: TC3 giữ 236.30.233.1:7001 OK, TC4 trùng thì 400
    const mcast = { type: 'udp-mcast', presetId: 'p720', enabled: true, group: '236.30.233.1', port: 7001, localAddr: '192.168.20.200' };
    r = await req('/api/sources', json(mkSrc('TC3', mkCh('tcv3', 31, 6002, [mcast]))));
    assert.equal(r.status, 201);
    r = await req('/api/sources', json(mkSrc('TC4', mkCh('tcv4', 32, 6003, [mcast]))));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /multicast.*bị trùng/);
    // PUT-transcode kênh khác trỏ cổng đã dùng cũng 400
    r = await req(
      '/api/sources',
      json(mkSrc('TC4', mkCh('tcv4', 32, 6003, [srtOut(9012)]))),
    );
    assert.equal(r.status, 201);
    const clash = await req(
      '/api/sources/TC4/channels/tcv4/transcode',
      putJson({ transcode: { enabled: true, loopbackPort: 6003, presetIds: ['p720'], outputs: [srtOut(9003)] } }),
    );
    assert.equal(clash.status, 400);
    await req('/api/sources/TC3', { method: 'DELETE' });
    await req('/api/sources/TC4', { method: 'DELETE' });
  });

  it('trùng cổng puller toàn hệ → 400', async () => {
    const mkPull = (id: string, port: number): unknown => ({
      id,
      input: `ip 127.0.0.1:${port}`,
      recordAll: false,
      channels: [{ name: `ch-${id.toLowerCase()}`, serviceId: 40, isLive: true }],
      puller: { rtmpUrl: 'rtmp://127.0.0.1:1935/live', streamKey: 'k', udpPort: port },
    });
    let r = await req('/api/sources', json(mkPull('TC5', 6101)));
    assert.equal(r.status, 201);
    r = await req('/api/sources', json(mkPull('TC6', 6101)));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /cổng puller 6101 bị trùng/);
    await req('/api/sources/TC5', { method: 'DELETE' });
  });

  it('config-restore validate transcode: preset lạ / trùng cổng → 400', async () => {
    const badPreset = {
      id: 'TCB',
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: true,
      channels: [
        { name: 'tcb', serviceId: 41, isLive: true, transcode: { enabled: true, loopbackPort: 6009, presetIds: ['khong-co'], outputs: [] } },
      ],
    };
    let r = await req('/api/admin/config-restore', json({ sources: [badPreset] }));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /không tồn tại/);
    const dupLoop = {
      id: 'TCB',
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: true,
      channels: [
        { name: 'tcb', serviceId: 41, isLive: true, transcode: { enabled: true, loopbackPort: 6001, presetIds: ['p720'], outputs: [] } },
        { name: 'tcc', serviceId: 42, isLive: true, transcode: { enabled: true, loopbackPort: 6001, presetIds: ['p720'], outputs: [] } },
      ],
    };
    r = await req('/api/admin/config-restore', json({ sources: [dupLoop] }));
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /loopbackPort 6001 bị trùng/);
  });

  it('sửa retention giữ nguyên transcode, không restart tsp lẫn ffmpeg', async () => {
    await req('/api/sources/TC1/start', { method: 'POST' });
    await sleep(600);
    const before = (await (await req('/api/sources/TC1')).json()) as {
      pid: number;
      channels: { name: string; serviceId: number; isLive: boolean; transcode?: unknown }[];
    };
    const ff0 = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
    assert.equal(ff0.length, 1);
    // Giả lập form /sources: gửi lại channels Y HỆT + đổi retention
    const r = await req('/api/sources/TC1', putJson({ retentionDays: 31, channels: before.channels }));
    assert.equal(r.status, 200);
    const after = (await (await req('/api/sources/TC1')).json()) as {
      pid: number;
      retentionDays: number;
      channels: { name: string; transcode?: { enabled: boolean } }[];
    };
    assert.equal(after.retentionDays, 31);
    assert.equal(after.pid, before.pid); // tsp không restart
    assert.equal(after.channels.find((c) => c.name === 'tcv1')?.transcode?.enabled, true); // transcode còn nguyên
    const ff1 = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
    assert.equal(ff1.length, 1);
    assert.equal(ff1[0]?.pid, ff0[0]?.pid); // ffmpeg không restart
    await req('/api/sources/TC1/stop', { method: 'POST' });
  });

  it('start rồi stop ngay trước delay spawn → ffmpeg không mọc lén sau stop', async () => {
    // tcStartDelayMs=50ms trong suite: stop ngay sau start phải hủy hẹn spawn.
    // Hẹn rò rỉ là ffmpeg xuất hiện sau khi đã stop (mồ côi, không ai quản).
    await req('/api/sources/TC1/start', { method: 'POST' });
    await req('/api/sources/TC1/stop', { method: 'POST' });
    await sleep(800);
    const s = (await (await req('/api/transcode/status')).json()) as unknown[];
    assert.equal(s.length, 0);
  });

  it('stale (có progress rồi im) → watchdog restart; chưa từng progress thì tha', async () => {
    // Watchdog suite: progressTimeout 400ms, quét mỗi 300ms.
    await req('/api/sources/TC1/start', { method: 'POST' });
    await sleep(500);
    // Fake mặc định im thin thít → chưa từng progress → KHÔNG stale → watchdog tha
    let s = (await (await req('/api/transcode/status')).json()) as { pid: number; stale: boolean }[];
    assert.equal(s.length, 1);
    const pidQuiet = s[0]?.pid;
    await sleep(1200);
    s = (await (await req('/api/transcode/status')).json()) as { pid: number; stale: boolean }[];
    assert.equal(s.length, 1);
    assert.equal(s[0]?.pid, pidQuiet); // không restart oan tiến trình đang chờ
    // Start lại với 1 dòng progress rồi im → stale → watchdog restart
    await req('/api/sources/TC1/channels/tcv1/transcode-stop', { method: 'POST' });
    process.env['VTC_FAKE_PROGRESS_ONCE'] = '1';
    try {
      await req('/api/sources/TC1/channels/tcv1/transcode-start', { method: 'POST' });
    } finally {
      delete process.env['VTC_FAKE_PROGRESS_ONCE'];
    }
    const s0 = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
    const deadline = Date.now() + 5000;
    let restarted = false;
    while (Date.now() < deadline) {
      await sleep(200);
      const cur = (await (await req('/api/transcode/status')).json()) as { pid: number }[];
      if (cur.length === 1 && cur[0]?.pid !== s0[0]?.pid) {
        restarted = true;
        break;
      }
    }
    assert.equal(restarted, true); // watchdog đã restart tiến trình stale
    await req('/api/sources/TC1/stop', { method: 'POST' });
  });

  it('SDI guard: sai input/không encoded → 400 ngay', async () => {
    const base = {
      id: 'SDBAD',
      inputKind: 'sdi',
      liveCatchupFrom: 'encoded',
      input: 'ip 127.0.0.1:6201',
      recordAll: true,
      channels: [{ name: 'sdbad', serviceId: 51, isLive: true }],
    };
    let r = await req('/api/sources', json({ ...base, input: 'ip 239.1.1.1:5000' }));
    assert.equal(r.status, 400);
    r = await req('/api/sources', json({ ...base, liveCatchupFrom: 'ingest' }));
    assert.equal(r.status, 400);
  });

  it('capture agent: tạo SDI + start → cap chạy; hot-update giữ pid tsp; crash restart', async () => {
    const body = {
      id: 'SDI1',
      inputKind: 'sdi',
      liveCatchupFrom: 'encoded',
      input: 'ip 127.0.0.1:6201',
      recordAll: true,
      channels: [{ name: 'sdi1', serviceId: 52, isLive: true }],
      capture: { device: 'Fake Card 0', udpPort: 6201 },
    };
    let r = await req('/api/sources', json(body));
    assert.equal(r.status, 201);
    r = await req('/api/sources/SDI1/start', { method: 'POST' });
    assert.equal(r.status, 200);
    await sleep(300);
    let st = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
    const cap0 = st.find((x) => x.key === 'cap/SDI1');
    assert.ok(cap0 !== undefined, 'capture agent phải chạy sau start');
    const src = (await (await req('/api/sources/SDI1')).json()) as { pid: number };
    // Hot-update capture (đổi device) khi RUNNING → agent restart, tsp giữ nguyên
    r = await req('/api/sources/SDI1', putJson({ capture: { device: 'Fake Card 1', udpPort: 6201 } }));
    assert.equal(r.status, 200);
    const src2 = (await (await req('/api/sources/SDI1')).json()) as { pid: number };
    assert.equal(src2.pid, src.pid);
    st = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
    const cap1 = st.find((x) => x.key === 'cap/SDI1');
    assert.ok(cap1 !== undefined && cap1.pid !== cap0.pid, 'agent đã hot-restart');
    // Capture sai → 400
    r = await req('/api/sources/SDI1', putJson({ capture: { device: '', udpPort: 6201 } }));
    assert.equal(r.status, 400);
    // Crash → auto-restart
    process.kill(cap1.pid, 'SIGKILL');
    const deadline = Date.now() + 4000;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(200);
      const cur = (await (await req('/api/transcode/status')).json()) as { key: string; pid: number }[];
      const p = cur.find((x) => x.key === 'cap/SDI1');
      if (p !== undefined && p.pid !== cap1.pid) {
        ok = true;
        break;
      }
    }
    assert.equal(ok, true);
    await req('/api/sources/SDI1/stop', { method: 'POST' });
    await req('/api/sources/SDI1', { method: 'DELETE' });
  });
  it('timeshift ?src=after đọc thư mục after-<kênh>; sub lạ → 400', async () => {
    const TCA = {
      id: 'TCA',
      input: 'file /tmp/vtc-demo/input.ts --repeat',
      recordAll: false,
      channels: [
        {
          name: 'tca',
          serviceId: 81,
          isLive: true,
          transcode: {
            enabled: true,
            loopbackPort: 6008,
            presetIds: ['p720'],
            outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9028 }],
            recordPresetId: 'p720',
          },
        },
      ],
    };
    mkdirSync(join('/tmp/vtc-test-tc-caps', 'TCA', 'after-tca'), { recursive: true });
    const now = Date.now();
    writeFileSync(join('/tmp/vtc-test-tc-caps', 'TCA', 'after-tca', 'after-20260101-120000.ts'), 'x'.repeat(100));
    let r = await req('/api/sources', json(TCA));
    assert.equal(r.status, 201);
    const inMs = now - 3600000;
    const outMs = now + 60000; // tương lai: file vừa ghi có mtime ≈ now vẫn lọt
    r = await req(`/api/timeshift/tca?in=${inMs}&out=${outMs}&src=after`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes('#EXTM3U') && body.includes('after-20260101-120000.ts'), 'playlist liệt kê chunk after');
    assert.ok(body.includes('sub=after-tca'), 'segment URI giữ sub');
    // Kênh chưa bật ghi sau → 404 rõ ràng
    r = await req('/api/timeshift/tcv1?in=1&out=2&src=after');
    assert.equal(r.status, 404);
    // sub không khớp kênh → 400 (lấy URI thật rồi sửa sub)
    const badUri = body
      .split('\n')
      .find((l) => l.startsWith('/api/timeshift/chunks'))
      ?.replace('sub=after-tca', 'sub=after-xxx');
    assert.ok(badUri !== undefined);
    r = await req(badUri);
    assert.equal(r.status, 400);
  });

  it('export src=after ra job; kênh chưa bật ghi → 400', async () => {
    const now = Date.now();
    let r = await req(
      '/api/exports',
      json({ channelName: 'tca', sourceId: 'TCA', serviceId: 81, inPoint: now - 3600000, outPoint: now + 60000, src: 'after' }),
    );
    assert.equal(r.status, 200);
    const job = (await r.json()) as { id: string; status: string };
    assert.match(job.id, /^exp_/);
    r = await req(
      '/api/exports',
      json({ channelName: 'tcv1', sourceId: 'TC1', serviceId: 11, inPoint: now - 3600000, outPoint: now + 60000, src: 'after' }),
    );
    assert.equal(r.status, 400);
    await req('/api/sources/TCA', { method: 'DELETE' });
  });
});


describe('Transcode HLS output', () => {
  it('start tạo thư mục live/<kênh>/tc-<preset> cho output hls', async () => {
    // Dùng server phụ với liveDir riêng để assert thư mục (server chính dùng chung liveDir suite)
    setLogDir('/tmp/vtc-test-tc-hls-logs');
    const live2 = '/tmp/vtc-test-tc-live2';
    const api2 = createApi({
      port: 0,
      confDir: '/tmp/vtc-test-tc-conf2',
      captureDir: '/tmp/vtc-test-tc-caps2',
      exportsDir: '/tmp/vtc-test-tc-exps2',
      liveDir: live2,
      tspBin: '/tmp/vtc-fake-tc-tsp.sh',
      ffmpegBin: '/tmp/vtc-fake-tc-ffmpeg.sh',
      jwtSecret: 'test-secret-tc',
      adminPass: 'test-admin-123',
      persist: false,
      autoStart: false,
    });
    const s = await api2.listen(0);
    const b = `http://127.0.0.1:${s.port}`;
    try {
      const login = await fetch(`${b}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'test-admin-123' }),
      });
      const ck = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const hdrs = { 'content-type': 'application/json', cookie: ck };
      const mkBody = {
        id: 'TCHLS',
        input: 'file /tmp/vtc-demo/input.ts --repeat',
        recordAll: false,
        channels: [
          {
            name: 'tchls',
            serviceId: 71,
            isLive: true,
            transcode: {
              enabled: true,
              loopbackPort: 6009,
              presetIds: ['p720'],
              outputs: [{ type: 'hls', presetId: 'p720', enabled: true }],
            },
          },
        ],
      };
      let r = await fetch(`${b}/api/sources`, { method: 'POST', headers: hdrs, body: JSON.stringify(mkBody) });
      assert.equal(r.status, 201);
      r = await fetch(`${b}/api/sources/TCHLS/start`, { method: 'POST', headers: hdrs });
      assert.equal(r.status, 200);
      assert.equal(existsSync(join(live2, 'tchls', 'tc-p720')), true);
      await fetch(`${b}/api/sources/TCHLS/stop`, { method: 'POST', headers: hdrs });
      await fetch(`${b}/api/sources/TCHLS`, { method: 'DELETE', headers: hdrs });
    } finally {
      await s.close();
    }
  });
});

describe('Preset dùng cho ghi sau-encode', () => {
  it('không xóa được preset đang là recordPresetId', async () => {
    // Tạo preset riêng + source dùng nó CHỈ để ghi (không tick serve)
    const px = { id: 'px-rec', name: 'REC', video: { codec: 'h264', width: 640, height: 360, bitrateKbps: 800, fps: 25, gop: 50, preset: 'veryfast' }, audio: { codec: 'aac', bitrateKbps: 128, sampleRate: 48000, channels: 2 } };
    // Dùng server phụ như test HLS (tránh lẫn state suite chính)
    setLogDir('/tmp/vtc-test-tc-rec-logs');
    const api2 = createApi({
      port: 0,
      confDir: '/tmp/vtc-test-tc-rec-conf',
      captureDir: '/tmp/vtc-test-tc-rec-caps',
      exportsDir: '/tmp/vtc-test-tc-rec-exps',
      liveDir: '/tmp/vtc-test-tc-rec-live',
      tspBin: '/tmp/vtc-fake-tc-tsp.sh',
      ffmpegBin: '/tmp/vtc-fake-tc-ffmpeg.sh',
      jwtSecret: 'test-secret-tc',
      adminPass: 'test-admin-123',
      persist: false,
      autoStart: false,
    });
    const s = await api2.listen(0);
    const b = `http://127.0.0.1:${s.port}`;
    try {
      const login = await fetch(`${b}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'test-admin-123' }),
      });
      const ck = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const hdrs = { 'content-type': 'application/json', cookie: ck };
      let r = await fetch(`${b}/api/presets`, { method: 'POST', headers: hdrs, body: JSON.stringify(px) });
      assert.equal(r.status, 201);
      r = await fetch(`${b}/api/sources`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          id: 'TCR',
          input: 'file /tmp/vtc-demo/input.ts --repeat',
          recordAll: false,
          channels: [
            {
              name: 'tcr',
              serviceId: 91,
              isLive: true,
              transcode: {
                enabled: true,
                loopbackPort: 6007,
                presetIds: ['p720'],
                outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9027 }],
                recordPresetId: 'px-rec',
              },
            },
          ],
        }),
      });
      // recordPresetId không trong presetIds → 400 ngay
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /chưa tick chọn/);
      // Tick thêm px-rec rồi tạo lại → 201, và không xóa được preset đang ghi
      r = await fetch(`${b}/api/sources`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          id: 'TCR',
          input: 'file /tmp/vtc-demo/input.ts --repeat',
          recordAll: false,
          channels: [
            {
              name: 'tcr',
              serviceId: 91,
              isLive: true,
              transcode: {
                enabled: true,
                loopbackPort: 6007,
                presetIds: ['p720', 'px-rec'],
                outputs: [{ type: 'srt-listen', presetId: 'p720', enabled: true, port: 9027 }],
                recordPresetId: 'px-rec',
              },
            },
          ],
        }),
      });
      assert.equal(r.status, 201);
      r = await fetch(`${b}/api/presets/px-rec`, { method: 'DELETE', headers: hdrs });
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /ghi sau-encode/);
      await fetch(`${b}/api/sources/TCR`, { method: 'DELETE', headers: hdrs });
    } finally {
      await s.close();
    }
  });
});
