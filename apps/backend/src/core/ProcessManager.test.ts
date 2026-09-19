// ProcessManager.test.ts — Test vòng đời Start/Stop, KHÔNG cần tsp thật.
// Dùng `sleep` làm process giả (có PGID thật để kiểm chứng kill nhóm).
// Chạy: npm test
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync } from 'node:fs';
import { ProcessManager } from './ProcessManager.js';

// Fake long-lived process: bỏ qua mọi arg (kể cả @conf), ngủ 60s.
// Dùng `exec` để không tạo grandchild mồ côi (xem chú thích ở test CC-error).
const fakeSleep = '/tmp/vtc-fake-sleep.sh';
before(() => {
  writeFileSync(fakeSleep, '#!/bin/sh\nexec sleep 60\n', 'utf8');
  chmodSync(fakeSleep, 0o755);
});

describe('ProcessManager', () => {
  it('start rồi stop sạch (kill cả nhóm PGID, không còn process)', async () => {
    const pm = new ProcessManager({ tspBin: fakeSleep, killTimeoutMs: 2000 });
    const pid = pm.start('UT1', '/tmp/does-not-matter.conf');
    assert.ok(pid > 0);
    assert.equal(pm.isRunning('UT1'), true);
    // Process thật sự còn sống trước khi stop (kill -0 thăm dò, không gửi signal).
    assert.doesNotThrow(() => process.kill(pid, 0));
    await pm.stop('UT1');
    assert.equal(pm.isRunning('UT1'), false);
    // Sau stop, pid không còn (hoặc đã là zombie chờ init reap — ESRCH là đạt).
    await new Promise((r) => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it('start 2 lần cùng id phải lỗi (tránh double-spawn)', async () => {
    const pm = new ProcessManager({ tspBin: fakeSleep });
    pm.start('UT2', '/tmp/x.conf');
    assert.throws(() => pm.start('UT2', '/tmp/x.conf'), /đang RUNNING/);
    await pm.stop('UT2');
  });

  it('parse CC-error từ stderr thành event (fake tsp script)', async () => {
    // Fake tsp: bỏ qua arg @conf, in 1 dòng CC-error ra stderr rồi ngủ.
    // Chứng minh ProcessManager drain stderr + emit 'cc-error' (dùng cho Telegram Phase 3).
    const { writeFileSync, chmodSync } = await import('node:fs');
    const fake = '/tmp/vtc-fake-tsp.sh';
    writeFileSync(
      fake,
      '#!/bin/sh\n' +
        `echo 'vtcmonitor: CC error pid=0x5 (5) expected=3 got=7 total-errors=1' >&2\n` +
        // exec để sleep thay thế shell: không còn grandchild mồ côi về PID 1.
        // (Chính là cơ chế Zombie trong PRD: fork-con-cháu mồ côi khi cha giữa chết.)
        'exec sleep 30\n',
      'utf8',
    );
    chmodSync(fake, 0o755);

    const pm = new ProcessManager({ tspBin: fake, killTimeoutMs: 2000 });
    const got = new Promise((resolve) => pm.once('cc-error', resolve));
    pm.start('UT3', '/tmp/does-not-matter.conf');
    const ev = (await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout chờ cc-error')), 5000)),
    ])) as { pid: number; expected: number; got: number };
    assert.equal(ev.pid, 5);
    assert.equal(ev.expected, 3);
    assert.equal(ev.got, 7);
    await pm.stop('UT3');
    assert.equal(pm.isRunning('UT3'), false);
  });

  it('stop id không tồn tại resolve lặng lẽ', async () => {
    const pm = new ProcessManager({ tspBin: fakeSleep });
    await pm.stop('NOPE');
  });
});

describe('ProcessManager stop-timeout race', () => {
  it('process lì SIGTERM: stop() timeout vẫn dọn entry, start ngay được', async () => {
    // Bug thật Prod 19/09: stop() resolve mà entry còn (exit event tới sau) →
    // start() ngay báo RUNNING oan, watchdog restart thất bại.
    const stubborn = '/tmp/vtc-fake-stubborn.sh';
    writeFileSync(stubborn, '#!/bin/sh\ntrap "" TERM\nexec sleep 60\n', 'utf8');
    chmodSync(stubborn, 0o755);
    const pm = new ProcessManager({ tspBin: stubborn, killTimeoutMs: 200 });
    pm.start('UTR', '/tmp/x.conf');
    await pm.stop('UTR'); // SIGTERM bị lờ → timeout → SIGKILL → dọn entry ngay
    assert.equal(pm.isRunning('UTR'), false);
    const pid2 = pm.start('UTR', '/tmp/x.conf'); // trước fix: ném "đang RUNNING"
    assert.ok(pid2 > 0);
    await pm.stop('UTR');
  });
});
