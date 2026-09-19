// exporter.test.ts — Test Exporter với fake tsp (không cần TSDuck thật).
// Chạy: npm test
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Exporter, ExportError, exportFileName } from './exporter.js';

const HOUR = 3600 * 1000;

describe('Exporter', () => {
  let root = '';
  let caps = '';
  let exps = '';
  let fakeOk = '';
  let fakeFail = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vtc-exp-'));
    caps = join(root, 'captures');
    exps = join(root, 'exports');
    // Fake tsp thành công: ghi output = arg cuối rồi exit 0.
    fakeOk = join(root, 'fake-ok.sh');
    writeFileSync(fakeOk, '#!/bin/sh\nout=""; for a in "$@"; do out="$a"; done\necho fake-ts > "$out"\nexit 0\n', 'utf8');
    // Fake tsp thất bại: tạo file dở rồi exit 1 (mô phỏng OOM-kill).
    fakeFail = join(root, 'fake-fail.sh');
    writeFileSync(fakeFail, '#!/bin/sh\nout=""; for a in "$@"; do out="$a"; done\necho partial > "$out"\nexit 1\n', 'utf8');
    chmodSync(fakeOk, 0o755);
    chmodSync(fakeFail, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Đặt 3 chunk 60s liên tiếp cho source S1, chunk giữa phủ `at`. */
  function seedChunks(source = 'S1', at = Date.now()): void {
    mkdirSync(join(caps, source), { recursive: true });
    [-1, 0, 1].forEach((k, i) => {
      const p = join(caps, source, `catchup_0000${i}.ts`);
      writeFileSync(p, 'chunk');
      const t = new Date(at + k * 60_000);
      utimesSync(p, t, t);
    });
  }

  const baseReq = { channelName: 'THVL1', sourceId: 'S1', serviceId: 100, createdBy: 'admin' };

  it('validate: Out<=In và quá 6h bị chặn', async () => {
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: fakeOk });
    const now = Date.now();
    await assert.rejects(ex.submit({ ...baseReq, inPoint: now, outPoint: now }), ExportError);
    await assert.rejects(ex.submit({ ...baseReq, inPoint: now, outPoint: now + 7 * HOUR }), ExportError);
  });

  it('không có chunk trong khoảng → 400, không tạo job', async () => {
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: fakeOk });
    const past = Date.now() - 30 * 86400_000; // 30 ngày trước, cửa sổ 1h (trong giới hạn 6h)
    await assert.rejects(
      ex.submit({ ...baseReq, inPoint: past, outPoint: past + 3600_000 }),
      /Không có dữ liệu/,
    );
    assert.equal(ex.list().length, 0);
  });

  it('SUCCESS khi exit 0, file tồn tại', async () => {
    seedChunks();
    const now = Date.now();
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: fakeOk });
    const job = await ex.submit({ ...baseReq, inPoint: now - 60_000, outPoint: now + 60_000 });
    assert.ok(['QUEUED', 'PROCESSING'].includes(job.status)); // trả ngay, chưa xong
    const done = await waitFor(ex, job.id);
    assert.equal(done.status, 'SUCCESS');
    assert.equal(existsSync(done.filePath), true);
    assert.match(done.fileName, /^THVL1_\d{8}_\d{4}-\d{4}\.ts$/);
  });

  it('ERROR + xóa file dở khi exit != 0 (chống thành công giả)', async () => {
    seedChunks();
    const now = Date.now();
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: fakeFail });
    const job = await ex.submit({ ...baseReq, inPoint: now - 60_000, outPoint: now + 60_000 });
    const done = await waitFor(ex, job.id);
    assert.equal(done.status, 'ERROR');
    assert.equal(existsSync(done.filePath), false); // file dở bị dọn
  });

  it('queue: tối đa 1 concurrent, job sau QUEUED rồi chạy', async () => {
    seedChunks();
    // Fake chậm: ngủ 1s rồi ghi file.
    const slow = join(root, 'slow.sh');
    writeFileSync(slow, '#!/bin/sh\nsleep 1\nout=""; for a in "$@"; do out="$a"; done\necho x > "$out"\nexit 0\n', 'utf8');
    chmodSync(slow, 0o755);
    const now = Date.now();
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: slow, maxConcurrent: 1 });
    const j1 = await ex.submit({ ...baseReq, inPoint: now - 60_000, outPoint: now + 60_000 });
    const j2 = await ex.submit({ ...baseReq, inPoint: now - 60_000, outPoint: now + 60_000 });
    assert.equal(ex.get(j2.id)?.status, 'QUEUED');
    assert.equal((await waitFor(ex, j1.id)).status, 'SUCCESS');
    assert.equal((await waitFor(ex, j2.id)).status, 'SUCCESS');
  });

  it('remove: xóa file vật lý trước rồi mới xóa record', async () => {
    seedChunks();
    const now = Date.now();
    const ex = new Exporter({ captureDir: caps, exportsDir: exps, tspBin: fakeOk });
    const job = await ex.submit({ ...baseReq, inPoint: now - 60_000, outPoint: now + 60_000 });
    const done = await waitFor(ex, job.id);
    assert.equal(existsSync(done.filePath), true);
    await ex.remove(job.id);
    assert.equal(existsSync(done.filePath), false);
    assert.equal(ex.get(job.id), undefined);
  });

  it('tên file đúng mẫu PRD', () => {
    // 07:00–12:00 ngày 17/04/2026 giờ VN.
    const a = Date.parse('2026-04-16T24:00:00Z'); // 07:00 +07
    const b = Date.parse('2026-04-17T05:00:00Z'); // 12:00 +07
    assert.equal(exportFileName('THVL1', a, b), 'THVL1_17042026_0700-1200.ts');
  });
});

async function waitFor(ex: Exporter, id: string, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const j = ex.get(id);
    if (j === undefined) throw new Error('job biến mất');
    if (j.status === 'SUCCESS' || j.status === 'ERROR') return j;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout chờ job ${id} (${j.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Exporter after-record subdir', () => {
  it('resolveChunks đọc thư mục after-<kênh>; submit subdir lạ/khác kênh thì 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vtc-exp-after-'));
    try {
      const caps = join(root, 'captures');
      const exps = join(root, 'exports');
      mkdirSync(join(caps, 'S1', 'after-dn1'), { recursive: true });
      mkdirSync(exps, { recursive: true });
      const f1 = join(caps, 'S1', 'after-dn1', 'after-20260101-120000.ts');
      writeFileSync(f1, 'x'.repeat(10));
      const ex = new Exporter({ captureDir: caps, exportsDir: exps, persist: false });
      const hits = await ex.resolveChunks('S1', Date.now() - 3600000, Date.now(), 'after-dn1');
      assert.deepEqual(hits, [f1]);
      assert.deepEqual(await ex.resolveChunks('S1', Date.now() - 3600000, Date.now(), 'after-khac'), []);
      // submit sai subdir → ExportError
      await assert.rejects(
        ex.submit({ channelName: 'dn1', sourceId: 'S1', serviceId: 807, inPoint: 1, outPoint: 2, createdBy: 't', subdir: '../x' }),
        /không hợp lệ/,
      );
      await assert.rejects(
        ex.submit({ channelName: 'dn1', sourceId: 'S1', serviceId: 807, inPoint: 1, outPoint: 2, createdBy: 't', subdir: 'after-khac' }),
        /khớp kênh/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('submit after-* đặt hậu tố -after vào tên file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vtc-exp-after2-'));
    try {
      const caps = join(root, 'captures');
      const exps = join(root, 'exports');
      mkdirSync(join(caps, 'S1', 'after-dn1'), { recursive: true });
      mkdirSync(exps, { recursive: true });
      writeFileSync(join(caps, 'S1', 'after-dn1', 'after-20260101-120000.ts'), 'x'.repeat(10));
      const ex = new Exporter({ captureDir: caps, exportsDir: exps, persist: false, tspBin: '/bin/true' });
      const job = await ex.submit({
        channelName: 'dn1', sourceId: 'S1', serviceId: 807,
        inPoint: Date.now() - 3600000, outPoint: Date.now(), createdBy: 't', subdir: 'after-dn1',
      });
      assert.match(job.fileName, /-after\.ts$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
