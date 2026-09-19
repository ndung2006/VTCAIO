//=============================================================================
// garbageCollector.ts — Dọn file catchup/export quá hạn + giữ disk < ngưỡng.
// Chạy mỗi giờ (cron/interval) theo PRD §3.3, watermark §6 ý tưởng 5:
//   75% warn (notify), 85% GC gấp, 90% critical + chặn export mới (Phase 5).
// An toàn:
//  - Chỉ xóa *.ts trong captures/<SOURCE>/ và exports/.
//  - Chế độ ép dung lượng (disk > max): bỏ qua file mới hơn 1h (chunk đang ghi).
//=============================================================================
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { diskPercentAt } from '../api/system.js';

export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_EXPORT_RETENTION_DAYS = 7;
export const DEFAULT_MAX_DISK_PERCENT = 85;
/** File mới hơn mức này không bao giờ bị ép xóa (chunk đang ghi). */
export const PROTECT_RECENT_MS = 60 * 60 * 1000;

export interface GcOptions {
  captureDir: string;
  exportsDir?: string;
  /** Số ngày giữ theo source (mặc định 30). */
  getRetentionDays?: (sourceId: string) => number;
  defaultRetentionDays?: number;
  exportsRetentionDays?: number;
  /** Ngưỡng disk % bắt đầu ép xóa (mặc định 85). */
  maxDiskPercent?: number;
  /** Ghi đè % disk (cho test). */
  diskPercentOverride?: number | null;
  /** true = chỉ liệt kê, không xóa. */
  dryRun?: boolean;
  now?: number;
}

export interface GcResult {
  deleted: string[];
  freedBytes: number;
  expiredCount: number;
  forcedCount: number;
  diskBefore: number | null;
  diskAfter: number | null;
  dryRun: boolean;
}

interface FileEntry {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Liệt kê *.ts dưới captures/<SOURCE>/ + thư mục ghi sau-encode
 *  (captures/<SOURCE>/after-<kênh>/*.ts) — cùng retention với GHI gốc (docs/16 §8.6). */
async function listTsFiles(dir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  let sources: string[];
  try {
    sources = await readdir(dir);
  } catch {
    return out; // thư mục chưa có → không có gì để dọn
  }
  const pushFile = async (p: string): Promise<void> => {
    try {
      const st = await stat(p);
      if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // file biến mất giữa chừng (đang ghi) → bỏ qua
    }
  };
  const pushDir = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith('.ts')) continue;
      await pushFile(join(d, n));
    }
  };
  for (const s of sources) {
    await pushDir(join(dir, s));
    let names: string[];
    try {
      names = await readdir(join(dir, s));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith('after-')) continue;
      try {
        const st = await stat(join(dir, s, n));
        if (st.isDirectory()) await pushDir(join(dir, s, n));
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** Liệt kê *.ts phẳng trong exports/ (không chia source). */
async function listExportFiles(dir: string | undefined): Promise<FileEntry[]> {
  if (dir === undefined) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const n of names) {
    if (!n.endsWith('.ts')) continue;
    const p = join(dir, n);
    try {
      const st = await stat(p);
      if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      continue;
    }
  }
  return out;
}

function sourceOf(captureDir: string, filePath: string): string {
  const rel = filePath.slice(captureDir.length + 1);
  return rel.split('/')[0] ?? '';
}

/**
 * Chạy 1 vòng GC. Luôn an toàn khi gọi lại (idempotent).
 */
export async function runGarbageCollector(opts: GcOptions): Promise<GcResult> {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const maxDisk = opts.maxDiskPercent ?? DEFAULT_MAX_DISK_PERCENT;
  const defRet = opts.defaultRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const expRet = opts.exportsRetentionDays ?? DEFAULT_EXPORT_RETENTION_DAYS;

  const res: GcResult = {
    deleted: [],
    freedBytes: 0,
    expiredCount: 0,
    forcedCount: 0,
    diskBefore: null,
    diskAfter: null,
    dryRun,
  };

  const remove = async (f: FileEntry): Promise<void> => {
    res.deleted.push(f.path);
    res.freedBytes += f.size;
    if (!dryRun) {
      try {
        await unlink(f.path);
      } catch {
        /* đã bị xóa bởi vòng khác */
      }
    }
  };

  //-- Pass 1: xóa file quá hạn ------------------------------------------------
  const caps = await listTsFiles(opts.captureDir);
  for (const f of caps) {
    const ret = opts.getRetentionDays?.(sourceOf(opts.captureDir, f.path)) ?? defRet;
    if (now - f.mtimeMs > ret * 24 * 3600 * 1000) {
      await remove(f);
      res.expiredCount++;
    }
  }
  const exps = await listExportFiles(opts.exportsDir);
  for (const f of exps) {
    if (now - f.mtimeMs > expRet * 24 * 3600 * 1000) {
      await remove(f);
      res.expiredCount++;
    }
  }

  //-- Pass 2: disk vượt ngưỡng → ép xóa file cũ nhất (trừ file đang ghi) ------
  res.diskBefore =
    opts.diskPercentOverride !== undefined ? opts.diskPercentOverride : await diskPercentAt(opts.captureDir);
  if (res.diskBefore !== null && res.diskBefore > maxDisk) {
    const deletedSet = new Set(res.deleted);
    const rest = [...(await listTsFiles(opts.captureDir)), ...(await listExportFiles(opts.exportsDir))]
      .filter((f) => !deletedSet.has(f.path))
      .filter((f) => now - f.mtimeMs > PROTECT_RECENT_MS) // không đụng chunk đang ghi
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // cũ nhất trước
    for (const f of rest) {
      await remove(f);
      res.forcedCount++;
    }
    // Ghi chú: vòng này xóa hết file đủ cũ trong 1 lần (GC gấp khi disk vượt
    // ngưỡng). File đang ghi (< 1h) luôn được giữ. Vòng giờ sau đo lại disk.
  }

  res.diskAfter =
    opts.diskPercentOverride !== undefined ? opts.diskPercentOverride : await diskPercentAt(opts.captureDir);
  return res;
}
