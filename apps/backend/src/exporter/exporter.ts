//=============================================================================
// exporter.ts — Trích xuất lưu chiểu bất đồng bộ (PRD §6 + §17).
//  - Validate: Out > In, thời lượng ≤ 6h (FE + BE chặn cứng).
//  - Async: nhận job → PROCESSING/QUEUED → trả ngay, spawn tsp chạy ngầm:
//      tsp -I file <chunk...> -P zap <SID> -O file <out>
//  - Chỉ SUCCESS khi exit code === 0; fail → ERROR + xóa file dở (không rác đĩa).
//  - Hàng đợi: tối đa 2 job cùng chạy (tránh nghẽn I/O), còn lại QUEUED.
//  - Chặn job mới khi disk exports > 90%.
//=============================================================================
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { diskPercentAt } from '../api/system.js';

/** Giới hạn cứng mỗi lần trích xuất (giờ). */
export const MAX_EXPORT_HOURS = 6;
/** Số job chạy đồng thời tối đa. */
export const MAX_CONCURRENT = 2;
/** Độ dài 1 chunk catchup (`-O hls --duration 60`) — dùng để map In/Out → file. */
export const CAPTURE_CHUNK_MS = 60 * 1000;

export type ExportStatus = 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'ERROR';

export interface ExportRequest {
  channelName: string;
  sourceId: string;
  serviceId: number;
  /** Epoch ms. */
  inPoint: number;
  outPoint: number;
  createdBy: string;
  /**
   * Thư mục con ghi sau-encode (VD `after-DN1`) — trích từ bản encode thay vì GHI gốc.
   * Bắt buộc khớp `after-<channelName>` (route kiểm tra, chống xem ké kênh khác).
   */
  subdir?: string | undefined;
}

export interface ExportJob extends ExportRequest {
  id: string;
  status: ExportStatus;
  /** Tên file tải về (Content-Disposition). */
  fileName: string;
  filePath: string;
  size: number | null;
  error?: string;
  createdAt: number;
}

export interface ExporterOptions {
  captureDir: string;
  exportsDir: string;
  tspBin?: string;
  maxConcurrent?: number;
  maxHours?: number;
  chunkMs?: number;
  getDiskPercent?: () => Promise<number | null>;
  /** Persist lịch sử jobs ra JSON (mặc định true, trừ khi VTC_PERSIST=0). */
  persist?: boolean;
  /** File persist (mặc định <exportsDir>/exports.db.json). */
  persistFile?: string;
}

export class ExportError extends Error {}

/** Epoch ms → "DDMMYYYY_HHmm" theo giờ VN (tên file tải về). */
export function vnStamp(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('day')}${get('month')}${get('year')}_${get('hour')}${get('minute')}`;
}

/** Tên file an toàn cho Content-Disposition (VD THVL1_17042026_0700-1200.ts). */
export function exportFileName(channel: string, inMs: number, outMs: number): string {
  const safe = channel.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'KENH';
  return `${safe}_${vnStamp(inMs)}-${vnStamp(outMs).slice(-4)}.ts`;
}

export class Exporter extends EventEmitter {
  private readonly jobs = new Map<string, ExportJob>();
  private readonly queue: string[] = [];
  private running = 0;
  private seq = 0;
  private readonly captureDir: string;
  private readonly exportsDir: string;
  private readonly tspBin: string;
  private readonly maxConcurrent: number;
  private readonly maxHours: number;
  private readonly chunkMs: number;
  private readonly getDiskPercent: (() => Promise<number | null>) | undefined;
  private readonly persistEnabled: boolean;
  private readonly persistFile: string;

  constructor(opts: ExporterOptions) {
    super();
    this.captureDir = opts.captureDir;
    this.exportsDir = opts.exportsDir;
    this.tspBin = opts.tspBin ?? process.env['VTC_TSP_BIN'] ?? 'tsp';
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT;
    this.maxHours = opts.maxHours ?? MAX_EXPORT_HOURS;
    this.chunkMs = opts.chunkMs ?? CAPTURE_CHUNK_MS;
    this.getDiskPercent = opts.getDiskPercent;
    this.persistEnabled = opts.persist ?? process.env['VTC_PERSIST'] !== '0';
    this.persistFile = opts.persistFile ?? join(opts.exportsDir, 'exports.db.json');
    mkdirSync(this.exportsDir, { recursive: true });
    this.loadPersisted();
  }

  /** Nạp lịch sử đã lưu; job dở dang (QUEUED/PROCESSING) hạ về ERROR do restart. */
  private loadPersisted(): void {
    if (!this.persistEnabled) return;
    try {
      if (!existsSync(this.persistFile)) return;
      const arr = JSON.parse(readFileSync(this.persistFile, 'utf8')) as unknown;
      if (!Array.isArray(arr)) return;
      for (const r of arr.slice(-500)) {
        const j = r as ExportJob;
        if (typeof j.id !== 'string' || typeof j.filePath !== 'string') continue;
        if (j.status === 'QUEUED' || j.status === 'PROCESSING') {
          j.status = 'ERROR';
          j.error = 'Gián đoạn do server restart — vui lòng gửi lại yêu cầu';
        }
        if (typeof j.size !== 'number') j.size = null;
        this.jobs.set(j.id, j);
      }
    } catch {
      // file hỏng thì bắt đầu trắng
    }
  }

  private savePersisted(): void {
    if (!this.persistEnabled) return;
    try {
      const arr = this.list().slice(0, 500);
      const tmp = `${this.persistFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
      renameSync(tmp, this.persistFile);
    } catch {
      // không chặn nghiệp vụ
    }
  }

  list(): ExportJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ExportJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Nhận yêu cầu → validate → tạo job → trả ngay (HTTP 200 theo PRD).
   * @throws ExportError khi validate fail (API map thành 400).
   */
  async submit(req: ExportRequest): Promise<ExportJob> {
    if (!Number.isFinite(req.inPoint) || !Number.isFinite(req.outPoint)) {
      throw new ExportError('In-point và Out-point phải là thời gian hợp lệ');
    }
    if (!(req.outPoint > req.inPoint)) {
      throw new ExportError('Thời gian Out-point phải lớn hơn In-point');
    }
    if (req.outPoint - req.inPoint > this.maxHours * 3600 * 1000) {
      throw new ExportError(
        `Hệ thống chỉ hỗ trợ trích xuất tối đa ${this.maxHours} tiếng mỗi lần để đảm bảo an toàn tài nguyên I/O máy chủ. Vui lòng chia nhỏ khoảng thời gian.`,
      );
    }
    if (req.subdir !== undefined && !/^after-[A-Za-z0-9_-]+$/.test(req.subdir)) {
      throw new ExportError('thư mục nguồn trích xuất không hợp lệ');
    }
    if (req.subdir !== undefined && req.subdir !== `after-${req.channelName}`) {
      throw new ExportError('thư mục nguồn phải khớp kênh (chống xem ké kênh khác)');
    }
    const disk = this.getDiskPercent
      ? await this.getDiskPercent()
      : await diskPercentAt(this.exportsDir);
    if (disk !== null && disk > 90) {
      throw new ExportError(`Ổ đĩa exports đã ${disk}% — tạm dừng nhận trích xuất mới, hãy dọn rác trước.`);
    }
    const chunks = await this.resolveChunks(req.sourceId, req.inPoint, req.outPoint, req.subdir);
    if (chunks.length === 0) {
      throw new ExportError('Không có dữ liệu lưu chiểu trong khoảng thời gian đã chọn');
    }
    const id = `exp_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const baseName = exportFileName(req.channelName, req.inPoint, req.outPoint);
    // Hậu tố -after để phân biệt file trích từ bản sau-encode.
    const fileName = req.subdir !== undefined ? baseName.replace(/\.ts$/, '-after.ts') : baseName;
    const job: ExportJob = {
      ...req,
      id,
      status: 'QUEUED',
      fileName,
      filePath: join(this.exportsDir, `${id}_${fileName}`),
      size: null,
      createdAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.savePersisted();
    this.pump();
    return job;
  }

  /**
   * Xóa job: unlink file vật lý TRƯỚC, rồi mới xóa bản ghi (PRD §6.E).
   * File không tồn tại vẫn xóa record (idempotent).
   */
  async remove(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) throw new ExportError(`Tác vụ ${id} không tồn tại`);
    if (job.status === 'QUEUED' || job.status === 'PROCESSING') {
      throw new ExportError('Tác vụ đang xử lý — không thể xóa lúc này');
    }
    try {
      await unlink(job.filePath);
    } catch {
      /* file đã mất — vẫn xóa record */
    }
    this.jobs.delete(id);
    this.savePersisted();
  }

  /** Map khoảng In/Out → danh sách chunk vật lý (theo mtime overlap). */
  async resolveChunks(sourceId: string, inMs: number, outMs: number, subdir?: string): Promise<string[]> {
    const base = subdir !== undefined && subdir !== '' ? join(this.captureDir, sourceId, subdir) : join(this.captureDir, sourceId);
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      return [];
    }
    const hits: { path: string; mtime: number }[] = [];
    for (const n of names) {
      if (!n.endsWith('.ts')) continue;
      const p = join(base, n);
      try {
        const st = await stat(p);
        if (st.isFile() && st.mtimeMs < outMs && st.mtimeMs + this.chunkMs > inMs) {
          hits.push({ path: p, mtime: st.mtimeMs });
        }
      } catch {
        continue;
      }
    }
    return hits.sort((a, b) => a.mtime - b.mtime).map((h) => h.path);
  }

  //-- Nội bộ ---------------------------------------------------------------

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (job === undefined) continue;
      this.running++;
      job.status = 'PROCESSING';
      this.emit('status', job);
      this.savePersisted();
      void this.execute(job).finally(() => {
        this.running--;
        this.emit('status', job);
        this.savePersisted();
        this.pump();
      });
    }
  }

  private execute(job: ExportJob): Promise<void> {
    return new Promise((resolve) => {
      void (async () => {
        const chunks = await this.resolveChunks(job.sourceId, job.inPoint, job.outPoint, job.subdir);
        if (chunks.length === 0) {
          this.fail(job, 'Dữ liệu lưu chiểu đã bị dọn trước khi trích xuất chạy');
          return resolve();
        }
        // tsp -I file <chunk...> -P zap <SID> -O file <out>
        const child = spawn(this.tspBin, ['-I', 'file', ...chunks, '-P', 'zap', String(job.serviceId), '-O', 'file', job.filePath], {
          detached: false, // job ngắn hạn, không fork — không cần PGID
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr?.on('data', () => {}); // drain chống đầy pipe
        child.on('error', () => {
          this.fail(job, 'Không khởi chạy được tsp');
          resolve();
        });
        child.on('exit', (code) => {
          void (async () => {
            if (code === 0) {
              try {
                const st = await stat(job.filePath);
                job.size = st.size;
                job.status = 'SUCCESS';
              } catch {
                this.fail(job, 'tsp báo thành công nhưng không thấy file đầu ra');
              }
            } else {
              this.fail(job, `tsp thoát với mã ${String(code)} (có thể do nghẽn I/O)`);
            }
            resolve();
          })();
        });
      })();
    });
  }

  /** Mark ERROR + xóa file dở (chống "thành công giả", PRD §17.C). */
  private async fail(job: ExportJob, error: string): Promise<void> {
    job.status = 'ERROR';
    job.error = error;
    this.savePersisted();
    try {
      await unlink(job.filePath);
    } catch {
      /* chưa có file dở */
    }
  }
}
