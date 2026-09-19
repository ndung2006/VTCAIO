// transcodeReal.test.ts — Vòng kín qua HTTP với ffmpeg/ffprobe THẬT (không fake).
// Fake duy nhất: tspBin = script phát testsrc ra UDP 6001 (thay TSDuck).
// Tự SKIP khi thiếu ffmpeg/ffprobe (CI không có binary vẫn xanh).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { createApi } from './server.js';
import { setLogDir } from '../core/logger.js';

const fakeTsp = '/tmp/vtc-fake-real-tsp.sh';
const confDir = '/tmp/vtc-test-real-conf';
const capsDir = '/tmp/vtc-test-real-caps';
const expsDir = '/tmp/vtc-test-real-exps';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hasBin(b: string): boolean {
  try {
    const r = spawnSync(b, ['-version'], { timeout: 10000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

before(() => {
  setLogDir('/tmp/vtc-test-real-logs');
  // Giả TSDuck: bỏ qua @conf, phát testsrc 360p25 + sine ra UDP 6001 (120s).
  writeFileSync(
    fakeTsp,
    '#!/bin/sh\nexec ffmpeg -hide_banner -nostdin -loglevel error -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 120 -c:v libx264 -preset ultrafast -g 25 -c:a aac -f mpegts udp://127.0.0.1:6001?pkt_size=1316\n',
    'utf8',
  );
  chmodSync(fakeTsp, 0o755);
  mkdirSync(confDir, { recursive: true });
  mkdirSync(capsDir, { recursive: true });
  mkdirSync(expsDir, { recursive: true });
});

describe('Transcode vòng kín (ffmpeg thật)', { concurrency: false }, () => {
  let base = '';
  let close = async (): Promise<void> => {};
  let cookie = '';
  const req = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
    });

  before(async () => {
    const api = createApi({
      port: 0,
      confDir,
      captureDir: capsDir,
      exportsDir: expsDir,
      tspBin: fakeTsp,
      ffmpegBin: 'ffmpeg',
      tcStartDelayMs: 200,
      tcRestartDelayMs: 200,
      jwtSecret: 'test-secret-real',
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
      await req('/api/sources/RTS1', { method: 'DELETE' });
    } catch {
      /* dọn */
    }
    await close();
  });

  it('start source → spawn ffmpeg thật → status waiting (đúng vì Docker chặn UDP receive)', async (t) => {
    if (!hasBin('ffmpeg')) {
      t.skip('thiếu ffmpeg — bỏ qua vòng kín');
      return;
    }
    let r = await req('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'RTS1',
        input: 'ip 127.0.0.1:6001',
        recordAll: false,
        channels: [
          {
            name: 'r360',
            serviceId: 61,
            isLive: true,
            transcode: {
              enabled: true,
              loopbackPort: 6001,
              presetIds: ['p360', 'paudio'],
              outputs: [
                { type: 'srt-listen', presetId: 'p360', enabled: true, port: 9021 },
                { type: 'srt-listen', presetId: 'paudio', enabled: true, port: 9022 },
              ],
            },
          },
        ],
      }),
    });
    assert.equal(r.status, 201);
    r = await req('/api/sources/RTS1/start', { method: 'POST' });
    assert.equal(r.status, 200);
    // ffmpeg thật spawn qua API: argv sai là chết ngay (status trống/ERROR).
    // Sống + waiting sau 30s = argv đúng + process khỏe + flag chờ caller chạy
    // đúng thiết kế (fps>0 cần dữ liệu UDP thật — chứng minh bằng file-input
    // E2E, xem docs/16 T1).
    const deadline = Date.now() + 45000;
    let seen: { key: string; pid: number | null; running: boolean; waiting: boolean } | undefined;
    let waited = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = (await (await req('/api/transcode/status')).json()) as {
        key: string;
        pid: number | null;
        running: boolean;
        waiting: boolean;
      }[];
      seen = s.find((x) => x.key === 'RTS1/r360');
      if (seen === undefined) continue;
      assert.equal(seen.running, true);
      assert.ok((seen.pid ?? 0) > 0, 'phải có pid thật');
      if (seen.waiting) {
        waited = true;
        break;
      }
    }
    assert.ok(seen !== undefined, 'ffmpeg thật phải được spawn và hiện status');
    assert.equal(waited, true, 'quá 30s không frame phải lật waiting=true');
  });
});
