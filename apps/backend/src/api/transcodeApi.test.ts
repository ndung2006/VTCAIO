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
});
