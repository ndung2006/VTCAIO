//=============================================================================
// TranscodeManager.ts — Quản lý 1 ffmpeg process / 1 kênh transcode.
// Đúng chuẩn docs/16 §9:
//  - PGID RIÊNG, độc lập với tsp (crash RTMP/SRT không được kéo chết ghi).
//    Chỉ lệnh Stop/đổi cấu trúc chủ động mới kill cả cụm (tsp + ffmpeg).
//  - stdio ['ignore','pipe','pipe']: stdout cho `-progress pipe:1` (fps,
//    bitrate), stderr cho log lỗi. KHÔNG ignore stdout như ProcessManager.
//  - KHÔNG tự restart mù: caller (server.ts ở T2) nghe 'exit' và quyết định,
//    dùng recentCrashes() để chặn vòng lặp (>3 crash/5 phút thì dừng hẳn).
//  - isStale(): fps từng có rồi im lặng quá timeout (mặc định 15s) → restart.
//=============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SourceStatus } from './types.js';
import { envNonEmpty } from './TranscodeConfigGenerator.js';

/** 1 ffmpeg đang quản lý. Key = `${sourceId}/${channelName}`. */
interface ManagedTranscode {
  child: ChildProcess;
  pid: number; // đồng thời là PGID vì detached:true
  intentionalStop: boolean;
  /** Ms epoch lúc spawn — suy "waiting" khi quá lâu chưa có progress. */
  startedAtMs: number;
  /** Mốc crash không chủ đích (ms epoch) — caller dùng chống lặp restart. */
  crashes: number[];
  lastFps: number | null;
  lastBitrateKbps: number | null;
  lastProgressAt: number | null;
  stdoutBuf: string;
  /** Dòng stderr cuối kèm giờ xuất hiện (giữ tối đa 200 dòng để UI cuộn xem). */
  stderrLines: string[];
  /** Phần stderr chưa đủ 1 dòng (chunk lẻ). */
  stderrTail: string;
}

export interface TranscodeManagerOptions {
  /** Lệnh ffmpeg (mặc định "ffmpeg", test dùng script fake). */
  ffmpegBin?: string;
  /** Ms chờ SIGTERM trước khi SIGKILL (mặc định 5000). */
  killTimeoutMs?: number;
  /** Ms im lặng progress thì coi là stale (mặc định 15000, docs/16 §9.3). */
  progressTimeoutMs?: number;
}

export interface TranscodeManagerEvents {
  onStatus(key: string, status: SourceStatus): void;
  onExit(key: string, code: number | null, signal: string | null): void;
}

export interface TranscodeSnapshot {
  key: string;
  pid: number;
  running: boolean;
  lastFps: number | null;
  lastBitrateKbps: number | null;
  lastProgressAt: number | null;
  crashCount: number;
  /** Ms epoch lúc spawn (endpoint suy waiting khi quá lâu chưa có progress). */
  startedAtMs: number;
  /** Vài dòng stderr cuối (lỗi ffmpeg/output như RTMP handshake fail) — để UI hiện. */
  lastError: string | null;
}

/** Giờ HH:MM:SS (giờ container, Prod đặt TZ Asia/Ho_Chi_Minh). */
function clockNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Dòng progress của `ffmpeg -progress pipe:1`: "fps=25.00",
// "bitrate=2048.0kbits/s", "out_time_ms=123456", "progress=continue".
const FPS_RE = /^fps=\s*([\d.]+)/;
const BITRATE_RE = /^bitrate=\s*([\d.]+)kbits\/s/;

export class TranscodeManager extends EventEmitter {
  private readonly procs = new Map<string, ManagedTranscode>();
  /** Log crash sống sót sau khi process chết — caller dùng chống lặp restart. */
  private readonly crashLog = new Map<string, number[]>();
  private readonly ffmpegBin: string;
  private readonly killTimeoutMs: number;
  private readonly progressTimeoutMs: number;
  private handlers: TranscodeManagerEvents | undefined;

  constructor(opts: TranscodeManagerOptions = {}) {
    super();
    this.ffmpegBin = opts.ffmpegBin ?? envNonEmpty('VTC_FFMPEG_BIN', 'ffmpeg');
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;
    this.progressTimeoutMs = opts.progressTimeoutMs ?? 15000;
  }

  setHandlers(h: TranscodeManagerEvents): void {
    this.handlers = h;
  }

  isRunning(key: string): boolean {
    return this.procs.has(key);
  }

  /** Mọi key ffmpeg đang quản lý (cho endpoint status). */
  keys(): string[] {
    return [...this.procs.keys()];
  }

  getPid(key: string): number | undefined {
    return this.procs.get(key)?.pid;
  }

  snapshot(key: string): TranscodeSnapshot | undefined {
    const m = this.procs.get(key);
    if (m === undefined) return undefined;
    // Lấy tối đa 40 dòng stderr cuối (đã gắn giờ lúc nhận) để UI cuộn xem.
    const lines = [...m.stderrLines];
    if (m.stderrTail.trim() !== '') lines.push(`[${clockNow()}] ${m.stderrTail.trim()}`);
    const tail = lines.slice(-40).join('\n');
    return {
      key,
      pid: m.pid,
      running: true,
      lastFps: m.lastFps,
      lastBitrateKbps: m.lastBitrateKbps,
      lastProgressAt: m.lastProgressAt,
      crashCount: m.crashes.length,
      startedAtMs: m.startedAtMs,
      lastError: tail === '' ? null : tail.slice(-4000),
    };
  }

  /**
   * true = từng có progress rồi im lặng quá progressTimeoutMs.
   * Chưa có progress nào thì KHÔNG stale (ffmpeg mới spawn đang probe input).
   */
  isStale(key: string, now: number = Date.now()): boolean {
    const m = this.procs.get(key);
    if (m === undefined || m.lastProgressAt === null) return false;
    return now - m.lastProgressAt > this.progressTimeoutMs;
  }

  /**
   * Số crash không chủ đích trong windowMs gần nhất.
   * Sống sót sau khi process chết (đọc từ crashLog) để caller chặn vòng lặp:
   * quy ước docs/16 §9.2 là >3 crash/5 phút thì dừng hẳn + Telegram.
   */
  recentCrashes(key: string, windowMs: number, now: number = Date.now()): number {
    const all = this.crashLog.get(key);
    if (all === undefined) return 0;
    const fresh = all.filter((t) => now - t <= windowMs);
    if (fresh.length === 0) {
      this.crashLog.delete(key);
      return 0;
    }
    if (fresh.length !== all.length) this.crashLog.set(key, fresh);
    return fresh.length;
  }

  /**
   * Start 1 ffmpeg cho kênh: `ffmpeg <args...>` trong process group riêng.
   * args lấy từ buildFfmpegArgs() (đã validate fail-fast trước khi tới đây).
   */
  start(key: string, args: string[]): number {
    if (this.procs.has(key)) {
      throw new Error(`Transcode ${key} đang RUNNING (pid ${this.procs.get(key)?.pid})`);
    }
    const child = spawn(this.ffmpegBin, args, {
      detached: true, // PGID riêng, độc lập tsp — kill(-pid) chỉ diệt ffmpeg.
      stdio: ['ignore', 'pipe', 'pipe'], // stdout=progress, stderr=log lỗi.
    });
    if (child.pid === undefined) {
      throw new Error('spawn ffmpeg thất bại: không có pid');
    }
    const m: ManagedTranscode = {
      child,
      pid: child.pid,
      intentionalStop: false,
      startedAtMs: Date.now(),
      crashes: [],
      lastFps: null,
      lastBitrateKbps: null,
      lastProgressAt: null,
      stdoutBuf: '',
      stderrLines: [],
      stderrTail: '',
    };
    this.procs.set(key, m);
    this.emitStatus(key, 'RUNNING');

    child.stdout?.on('data', (chunk: Buffer) => {
      this.onProgress(key, m, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.onStderr(m, chunk.toString('utf8'));
    });
    child.on('exit', (code, signal) => {
      this.onExit(key, m, code, signal);
    });
    child.on('error', () => {
      // 'exit' theo sau 'error' — xử lý tập trung ở onExit.
    });
    return m.pid;
  }

  /** Stop graceful: SIGTERM cả nhóm ffmpeg → chờ → SIGKILL. Luôn resolve. */
  async stop(key: string): Promise<void> {
    const m = this.procs.get(key);
    if (m === undefined) return;
    m.intentionalStop = true;
    try {
      process.kill(-m.pid, 'SIGTERM');
    } catch {
      this.cleanup(key, 'STOPPED');
      return;
    }
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = (timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        m.child.off('exit', doneExit);
        if (timedOut && this.procs.get(key) === m) {
          this.procs.delete(key);
          this.crashLog.delete(key);
          m.crashes = [];
          this.emitStatus(key, 'STOPPED');
        }
        resolve();
      };
      const doneExit = (): void => done(false);
      const timer = setTimeout(() => {
        try {
          process.kill(-m.pid, 'SIGKILL');
        } catch {
          /* đã chết */
        }
        done(true);
      }, this.killTimeoutMs);
      timer.unref?.();
      m.child.once('exit', doneExit);
      if (!this.procs.has(key)) {
        done(false);
      }
    });
  }

  //-- Nội bộ ---------------------------------------------------------------

  private emitStatus(key: string, s: SourceStatus): void {
    this.handlers?.onStatus(key, s);
    this.emit('status', key, s);
  }

  /** Drain stderr theo dòng, gắn giờ xuất hiện từng dòng (UI hiện log). */
  private onStderr(m: ManagedTranscode, text: string): void {
    m.stderrTail += text;
    let idx: number;
    while ((idx = m.stderrTail.indexOf('\n')) >= 0) {
      const line = m.stderrTail.slice(0, idx).trim();
      m.stderrTail = m.stderrTail.slice(idx + 1);
      if (line === '') continue;
      m.stderrLines.push(`[${clockNow()}] ${line}`);
      // Giữ tối đa 200 dòng mới nhất (đủ cuộn xem, không phình RAM).
      if (m.stderrLines.length > 200) m.stderrLines.splice(0, m.stderrLines.length - 200);
    }
    if (m.stderrTail.length > 8000) m.stderrTail = m.stderrTail.slice(-8000);
  }

  /** Parse từng dòng `-progress pipe:1`, giữ fps/bitrate mới nhất. */
  private onProgress(key: string, m: ManagedTranscode, text: string): void {
    void key;
    m.stdoutBuf += text;
    let idx: number;
    while ((idx = m.stdoutBuf.indexOf('\n')) >= 0) {
      const line = m.stdoutBuf.slice(0, idx).trim();
      m.stdoutBuf = m.stdoutBuf.slice(idx + 1);
      const f = FPS_RE.exec(line);
      if (f !== null) {
        const v = Number.parseFloat(f[1] ?? 'NaN');
        if (Number.isFinite(v)) {
          m.lastFps = v;
          m.lastProgressAt = Date.now();
        }
        continue;
      }
      const b = BITRATE_RE.exec(line);
      if (b !== null) {
        const v = Number.parseFloat(b[1] ?? 'NaN');
        if (Number.isFinite(v)) {
          m.lastBitrateKbps = v;
          m.lastProgressAt = Date.now();
        }
      }
    }
    if (m.stdoutBuf.length > 64_000) m.stdoutBuf = m.stdoutBuf.slice(-8000);
  }

  private onExit(key: string, m: ManagedTranscode, code: number | null, signal: string | null): void {
    // Entry đã bị stop() timeout dọn trước → exit event tới muộn, bỏ qua hoàn
    // toàn (không đếm crash, không alert, không hẹn restart ma).
    if (this.procs.get(key) !== m) return;
    const wasIntentional = m.intentionalStop;
    if (wasIntentional) {
      // Operator can thiệp (stop tay) = reset vòng đếm crash.
      this.crashLog.delete(key);
      m.crashes = [];
    } else {
      // CỘNG DỒN vào log cũ (m.crashes là của process vừa chết — process mới
      // spawn lại từ [] nên phải đọc crashLog, không là đếm mãi = 1).
      m.crashes = [...(this.crashLog.get(key) ?? []), Date.now()];
      this.crashLog.set(key, [...m.crashes]);
    }
    const crashes = [...m.crashes];
    this.procs.delete(key);
    this.handlers?.onExit(key, code, signal);
    this.emit('exit', key, code, signal, crashes);

    if (wasIntentional) {
      this.handlers?.onStatus(key, 'STOPPED');
      this.emit('status', key, 'STOPPED' satisfies SourceStatus);
      return;
    }
    this.handlers?.onStatus(key, 'ERROR');
    this.emit('status', key, 'ERROR' satisfies SourceStatus);
    // KHÔNG tự restart: caller (server.ts T2) nghe 'exit' + crashes để quyết
    // định (delay 2s; >3 crash/5 phút thì dừng hẳn + Telegram). Tránh lặp
    // crash mù với argv sai — cùng triết lý với ProcessManager.
    void code;
    void signal;
  }

  private cleanup(key: string, s: SourceStatus): void {
    this.procs.delete(key);
    this.handlers?.onStatus(key, s);
    this.emit('status', key, s);
  }
}
