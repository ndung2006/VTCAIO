// TranscodeManager.test.ts — fake script thay ffmpeg thật (không cần ffmpeg).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TranscodeManager } from './TranscodeManager.js';
import type { SourceStatus } from './types.js';

let dir = '';
let tm: TranscodeManager;

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

function waitFor(em: TranscodeManager, ev: string, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout chờ ${ev}`)), timeoutMs);
    em.once(ev, (...a: unknown[]) => {
      clearTimeout(t);
      resolve(a);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vtc-tc-'));
  tm = new TranscodeManager({ ffmpegBin: '/bin/true', killTimeoutMs: 1000, progressTimeoutMs: 250 });
});

afterEach(async () => {
  for (const k of ['a', 'b', 'c']) {
    try {
      await tm.stop(k);
    } catch {
      /* bỏ qua */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('TranscodeManager', () => {
  it('start fake progress → snapshot có fps/bitrate, stop diệt sạch PGID', async () => {
    const bin = script('ff.sh', 'printf "fps= 25.00\\nbitrate= 2048.0kbits/s\\nprogress=continue\\n"\nexec sleep 60');
    const m = new TranscodeManager({ ffmpegBin: bin, killTimeoutMs: 1000, progressTimeoutMs: 10000 });
    const pid = m.start('a', []);
    assert.ok(pid > 0);
    assert.equal(m.isRunning('a'), true);
    await sleep(300); // chờ stdout flush
    const s = m.snapshot('a');
    assert.equal(s?.lastFps, 25);
    assert.equal(s?.lastBitrateKbps, 2048);
    assert.equal(m.isStale('a'), false);
    await m.stop('a');
    assert.equal(m.isRunning('a'), false);
    assert.throws(() => process.kill(pid, 0), /ESRCH/); // chết thật, không zombie
  });

  it('chưa có progress thì không stale; im lặng quá timeout thì stale', async () => {
    const bin = script('sleep.sh', 'exec sleep 60');
    const m = new TranscodeManager({ ffmpegBin: bin, killTimeoutMs: 1000, progressTimeoutMs: 200 });
    m.start('b', []);
    assert.equal(m.isStale('b'), false); // mới spawn đang probe → không stale
    const bin2 = script('once.sh', 'printf "fps=25.00\\n"\nexec sleep 60');
    const m2 = new TranscodeManager({ ffmpegBin: bin2, killTimeoutMs: 1000, progressTimeoutMs: 200 });
    m2.start('c', []);
    await sleep(300);
    assert.equal(m2.snapshot('c')?.lastFps, 25);
    await sleep(400); // im lặng > 200ms
    assert.equal(m2.isStale('c'), true);
    await m.stop('b');
    await m2.stop('c');
  });

  it('crash exit 1 → ERROR + recentCrashes đếm được sau khi process chết', async () => {
    const bin = script('die.sh', 'exit 1');
    const m = new TranscodeManager({ ffmpegBin: bin, killTimeoutMs: 500, progressTimeoutMs: 10000 });
    const statuses: SourceStatus[] = [];
    m.setHandlers({
      onStatus: (_k, s) => statuses.push(s),
      onExit: () => {},
    });
    m.start('a', []);
    await waitFor(m, 'exit');
    assert.ok(statuses.includes('ERROR'));
    assert.equal(m.isRunning('a'), false);
    assert.equal(m.recentCrashes('a', 5 * 60 * 1000), 1);
    assert.equal(m.recentCrashes('a', 1000, Date.now() + 60_000), 0); // window cũ hơn tuổi crash → 0 + prune
    assert.equal(m.recentCrashes('a', 5 * 60 * 1000), 0); // đã prune ở trên
  });

  it('crash tích lũy qua nhiều lần restart (guard đếm được, không reset về 1)', async () => {
    const bin = script('die.sh', 'exit 1');
    const m = new TranscodeManager({ ffmpegBin: bin, killTimeoutMs: 500, progressTimeoutMs: 10000 });
    m.setHandlers({ onStatus: () => {}, onExit: () => {} });
    for (let i = 0; i < 3; i++) {
      m.start('a', []);
      await waitFor(m, 'exit');
    }
    assert.equal(m.recentCrashes('a', 5 * 60 * 1000), 3);
  });

  it('double start ném lỗi; stop key lạ resolve im lặng', async () => {
    const bin = script('sleep.sh', 'exec sleep 60');
    const m = new TranscodeManager({ ffmpegBin: bin, killTimeoutMs: 500, progressTimeoutMs: 10000 });
    m.start('a', []);
    assert.throws(() => m.start('a', []), /đang RUNNING/);
    await m.stop('khong-co'); // không ném
    await m.stop('a');
  });

  it("VTC_FFMPEG_BIN rỗng → fallback 'ffmpeg' (không spawn rỗng)", async () => {
    // Bug thật Prod 19/09/2026: .env có VTC_FFMPEG_BIN= trống → spawn('')
    // nổ "The argument 'file' cannot be empty" khi bấm Start ffmpeg.
    process.env['VTC_FFMPEG_BIN'] = '';
    try {
      const m = new TranscodeManager({ killTimeoutMs: 500, progressTimeoutMs: 10000 });
      m.setHandlers({ onStatus: () => {}, onExit: () => {} });
      let threwSync: unknown = null;
      try {
        m.start('envtest', []);
      } catch (e) {
        threwSync = e;
      }
      assert.equal(threwSync, null);
      await m.stop('envtest');
    } finally {
      delete process.env['VTC_FFMPEG_BIN'];
    }
  });
});
