//=============================================================================
// ProcessManager.ts — Quản lý 1 tsp process / Source, diệt sạch Zombie.
// Đúng chuẩn PRD §3.2:
//  - spawn với detached:true (tạo Process Group riêng cho cả nhánh -P fork).
//  - stop bằng kill(-pid, SIGTERM) — dấu TRỪ là bắt buộc để kill cả nhóm.
//  - stdout=ignore (tránh đầy pipe treo process), stderr=pipe để parse CC-error.
//  - auto-restart sau 5s nếu crash không chủ đích.
//=============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CcErrorEvent, SourceStatus } from './types.js';
import { envNonEmpty } from './TranscodeConfigGenerator.js';

/** Thông tin 1 process đang quản lý. */
interface Managed {
  child: ChildProcess;
  pid: number; // = child.pid (đồng thời là PGID vì detached:true)
  intentionalStop: boolean;
  restarts: number;
  status: SourceStatus;
  stderrBuf: string;
}

export interface ProcessManagerOptions {
  /** Lệnh tsp (mặc định "tsp", test có thể dùng "sleep"). */
  tspBin?: string;
  /** Ms chờ restart sau crash (mặc định 5000). */
  restartDelayMs?: number;
  /** Ms chờ SIGTERM trước khi SIGKILL (mặc định 5000). */
  killTimeoutMs?: number;
}

export interface ProcessManagerEvents {
  onStatus(sourceId: string, status: SourceStatus): void;
  onCcError(ev: CcErrorEvent): void;
  onExit(sourceId: string, code: number | null, signal: string | null): void;
}

// Regex khớp dòng warning của plugin vtcmonitor:
// "vtcmonitor: CC error pid=0x5 (5) expected=3 got=7 total-errors=1"
const CC_RE = /CC error pid=0x([0-9A-Fa-f]+) \((\d+)\) expected=(\d+) got=(\d+)/;

export class ProcessManager extends EventEmitter {
  private readonly procs = new Map<string, Managed>();
  private readonly tspBin: string;
  private readonly restartDelayMs: number;
  private readonly killTimeoutMs: number;
  private handlers: ProcessManagerEvents | undefined;

  constructor(opts: ProcessManagerOptions = {}) {
    super();
    this.tspBin = opts.tspBin ?? envNonEmpty('VTC_TSP_BIN', 'tsp');
    this.restartDelayMs = opts.restartDelayMs ?? 5000;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;
  }

  /** Gắn handler UI/alert (SSE, Telegram ở Phase 3). */
  setHandlers(h: ProcessManagerEvents): void {
    this.handlers = h;
  }

  isRunning(sourceId: string): boolean {
    return this.procs.has(sourceId);
  }

  getPid(sourceId: string): number | undefined {
    return this.procs.get(sourceId)?.pid;
  }

  /**
   * Start 1 source: `tsp @confPath` trong process group riêng.
   * Nếu source đang chạy thì ném lỗi (muốn đổi cấu hình: stop rồi start lại).
   */
  start(sourceId: string, confPath: string): number {
    if (this.procs.has(sourceId)) {
      throw new Error(`Source ${sourceId} đang RUNNING (pid ${this.procs.get(sourceId)?.pid})`);
    }
    const child = spawn(this.tspBin, [`@${confPath}`], {
      detached: true, // BẮT BUỘC: tạo PGID riêng để kill(-pid) diệt cả fork con.
      stdio: ['ignore', 'ignore', 'pipe'], // ignore stdout, chỉ pipe stderr.
    });
    if (child.pid === undefined) {
      throw new Error('spawn thất bại: không có pid');
    }
    const m: Managed = {
      child,
      pid: child.pid,
      intentionalStop: false,
      restarts: 0,
      status: 'RUNNING',
      stderrBuf: '',
    };
    this.procs.set(sourceId, m);
    this.emitStatus(sourceId, 'RUNNING');

    child.stderr?.on('data', (chunk: Buffer) => {
      this.onStderr(sourceId, m, chunk.toString('utf8'));
    });
    child.on('exit', (code, signal) => {
      this.onExit(sourceId, m, code, signal);
    });
    child.on('error', () => {
      // 'exit' sẽ theo sau 'error' — xử lý tập trung ở onExit để khỏi double-restart.
    });
    return m.pid;
  }

  /**
   * Stop graceful: SIGTERM cả nhóm → chờ → SIGKILL nếu còn sống.
   * Luôn resolve (không treo dù process đã chết trước).
   */
  async stop(sourceId: string): Promise<void> {
    const m = this.procs.get(sourceId);
    if (m === undefined) return;
    m.intentionalStop = true;
    try {
      // Dấu TRỪ trước pid = kill cả process group (cha + mọi fork con).
      process.kill(-m.pid, 'SIGTERM');
    } catch {
      // Process đã chết trước khi kill — dọn luôn.
      this.cleanup(sourceId, 'STOPPED');
      return;
    }
    // Chờ process thoát, timeout thì SIGKILL cả nhóm.
    // Vá race như TranscodeManager (Prod 19/09): timeout resolve luôn trong khi
    // entry còn trong map → start() ngay sau báo RUNNING oan. Timeout thì dọn
    // entry ngay; exit event tới muộn bị onExit bỏ qua.
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = (timedOut: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        m.child.off('exit', doneExit);
        if (timedOut && this.procs.get(sourceId) === m) {
          this.procs.delete(sourceId);
          this.emitStatus(sourceId, 'STOPPED');
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
      // Nếu exit đã xảy ra trước khi đăng ký once (race), cleanup ở onExit đã chạy.
      if (!this.procs.has(sourceId)) {
        done(false);
      }
    });
  }

  //-- Nội bộ ---------------------------------------------------------------

  private emitStatus(sourceId: string, s: SourceStatus): void {
    const m = this.procs.get(sourceId);
    if (m !== undefined) m.status = s;
    this.handlers?.onStatus(sourceId, s);
    this.emit('status', sourceId, s);
  }

  /** Drain stderr theo dòng, parse CC-error để alert (tránh đầy buffer). */
  private onStderr(sourceId: string, m: Managed, text: string): void {
    m.stderrBuf += text;
    let idx: number;
    while ((idx = m.stderrBuf.indexOf('\n')) >= 0) {
      const line = m.stderrBuf.slice(0, idx);
      m.stderrBuf = m.stderrBuf.slice(idx + 1);
      const mt = CC_RE.exec(line);
      if (mt !== null) {
        const ev: CcErrorEvent = {
          sourceId,
          pid: Number.parseInt(mt[2] ?? '0', 10),
          expected: Number.parseInt(mt[3] ?? '0', 10),
          got: Number.parseInt(mt[4] ?? '0', 10),
          at: new Date(),
        };
        this.handlers?.onCcError(ev);
        this.emit('cc-error', ev);
      }
    }
    // Chặn buffer phình nếu tsp spam không xuống dòng.
    if (m.stderrBuf.length > 64_000) {
      m.stderrBuf = m.stderrBuf.slice(-8000);
    }
  }

  private onExit(sourceId: string, m: Managed, code: number | null, signal: string | null): void {
    // Entry đã bị stop() timeout dọn trước → exit event tới muộn, bỏ qua hoàn
    // toàn (không báo crash, không hẹn restart ma).
    if (this.procs.get(sourceId) !== m) return;
    const wasIntentional = m.intentionalStop;
    this.procs.delete(sourceId);
    this.handlers?.onExit(sourceId, code, signal);
    this.emit('exit', sourceId, code, signal);

    if (wasIntentional) {
      this.handlers?.onStatus(sourceId, 'STOPPED');
      this.emit('status', sourceId, 'STOPPED' satisfies SourceStatus);
      return;
    }
    // Crash không chủ đích (code != 0 hoặc signal): ERROR + hẹn restart 5s.
    this.handlers?.onStatus(sourceId, 'ERROR');
    this.emit('status', sourceId, 'ERROR' satisfies SourceStatus);
    // Lưu ý: confPath gốc không còn ở đây — caller (API Phase 2) lắng nghe
    // sự kiện 'exit' và gọi lại start() với conf mới nhất. Không tự restart
    // mù với conf cũ để tránh lặp crash khi cấu hình sai.
    void code;
    void signal;
  }

  private cleanup(sourceId: string, s: SourceStatus): void {
    this.procs.delete(sourceId);
    this.handlers?.onStatus(sourceId, s);
    this.emit('status', sourceId, s);
  }
}
