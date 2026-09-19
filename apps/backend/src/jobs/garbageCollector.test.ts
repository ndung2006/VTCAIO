// garbageCollector.test.ts — Test trên thư mục tmp thật (không chạm captures Prod).
// Chạy: npm test
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGarbageCollector } from './garbageCollector.js';

const DAY = 24 * 3600 * 1000;

describe('garbageCollector', () => {
  let root = '';
  let caps = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vtc-gc-'));
    caps = join(root, 'captures');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true }); // best-effort dọn tmp
  });

  function put(source: string, name: string, ageMs: number, size = 10): string {
    mkdirSync(join(caps, source), { recursive: true });
    const p = join(caps, source, name);
    writeFileSync(p, 'x'.repeat(size));
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  }

  it('xóa file quá retention, giữ file còn hạn', async () => {
    const oldF = put('S1', 'catchup_00001.ts', 40 * DAY);
    const newF = put('S1', 'catchup_00002.ts', 5 * DAY);
    const r = await runGarbageCollector({ captureDir: caps, diskPercentOverride: 10 });
    assert.equal(r.expiredCount, 1);
    assert.equal(existsSync(oldF), false);
    assert.equal(existsSync(newF), true);
  });

  it('retention theo từng source', async () => {
    const f30 = put('A', 'catchup_00001.ts', 40 * DAY); // quá 30
    const f90 = put('B', 'catchup_00001.ts', 40 * DAY); // còn trong 90
    const r = await runGarbageCollector({
      captureDir: caps,
      diskPercentOverride: 10,
      getRetentionDays: (id) => (id === 'B' ? 90 : 30),
    });
    assert.equal(existsSync(f30), false);
    assert.equal(existsSync(f90), true);
    assert.equal(r.expiredCount, 1);
  });

  it('disk vượt ngưỡng → ép xóa file cũ (trừ file đang ghi <1h)', async () => {
    const oldF = put('S1', 'catchup_00001.ts', 5 * DAY);
    const hotF = put('S1', 'catchup_00002.ts', 10 * 60 * 1000); // 10 phút → đang ghi
    const r = await runGarbageCollector({ captureDir: caps, diskPercentOverride: 95 });
    assert.equal(existsSync(oldF), false);
    assert.equal(existsSync(hotF), true); // được bảo vệ
    assert.equal(r.forcedCount, 1);
  });

  it('dryRun liệt kê nhưng không xóa', async () => {
    const oldF = put('S1', 'catchup_00001.ts', 40 * DAY);
    const r = await runGarbageCollector({ captureDir: caps, diskPercentOverride: 10, dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.deleted.length, 1);
    assert.equal(existsSync(oldF), true);
  });

  it('bỏ qua file không phải .ts (playlist, segment live)', async () => {
    mkdirSync(join(caps, 'S1'), { recursive: true });
    const keep = join(caps, 'S1', 'index.m3u8');
    writeFileSync(keep, '#m3u8');
    const t = new Date(Date.now() - 100 * DAY);
    utimesSync(keep, t, t);
    const r = await runGarbageCollector({ captureDir: caps, diskPercentOverride: 10 });
    assert.equal(existsSync(keep), true);
    assert.equal(r.expiredCount, 0);
  });
});

describe('garbageCollector after-record', () => {
  let root2 = '';
  let caps2 = '';
  const DAY2 = 24 * 3600 * 1000;

  // Ghi đè root/caps riêng cho describe này (tránh lẫn beforeEach ngoài)
  function setup(): void {
    root2 = mkdtempSync(join(tmpdir(), 'vtc-gc-after-'));
    caps2 = join(root2, 'captures');
  }
  function teardown(): void {
    rmSync(root2, { recursive: true, force: true });
  }
  function putAfter(source: string, ch: string, name: string, ageMs: number): string {
    const d = join(caps2, source, `after-${ch}`);
    mkdirSync(d, { recursive: true });
    const p = join(d, name);
    writeFileSync(p, 'x'.repeat(10));
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  }

  it('file after-* quá retention của source thì xóa, còn hạn thì giữ', async () => {
    setup();
    try {
      const oldF = putAfter('S1', 'dn1', 'after-20260101-120000.ts', 40 * DAY2);
      const newF = putAfter('S1', 'dn1', 'after-20260101-130000.ts', 5 * DAY2);
      const r = await runGarbageCollector({ captureDir: caps2, diskPercentOverride: 10 });
      assert.equal(existsSync(oldF), false);
      assert.equal(existsSync(newF), true);
      assert.equal(r.expiredCount, 1);
    } finally {
      teardown();
    }
  });
});
