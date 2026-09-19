//=============================================================================
// transcodeService.ts — Gom toàn bộ nghiệp vụ transcode/puller/capture ra khỏi
// server.ts (file đó chỉ còn định tuyến HTTP + lifecycle tsp).
// Giữ 1 TranscodeManager + 1 PresetStore + chính sách restart/alert/probe.
// Triết lý restart (docs/16 §9): crash → Telegram + hẹn restart (delay 2s,
// crash-guard >3 lần/5 phút thì dừng hẳn); stop tay thì không restart.
//=============================================================================

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TranscodeManager } from '../core/TranscodeManager.js';
import {
  assertEngineAvailable,
  buildCaptureArgs,
  buildFfmpegArgs,
  buildPullerArgs,
  checkOutputPresetRefs,
  checkRecordPresetId,
  normalizeChannelTranscode,
  normalizeSourceCapture,
  normalizeSourcePuller,
  parseCapture,
  parseOutput,
  parsePreset,
  parsePuller,
  parseSecretsEnv,
  parseTcStartDelayMs,
  TranscodeError,
} from '../core/TranscodeConfigGenerator.js';
import type {
  ChannelConfig,
  ChannelTranscode,
  SourceConfig,
} from '../core/types.js';
import { logger } from '../core/logger.js';
import { PresetStore } from './presetStore.js';
import { Store, type SourceRecord } from './store.js';
import { TelegramNotifier } from '../jobs/notify.js';
import { defaultPresets } from '../core/TranscodeConfigGenerator.js';

export interface TranscodeServiceOptions {
  /** Lệnh ffmpeg (mặc định env VTC_FFMPEG_BIN hay "ffmpeg"). */
  ffmpegBin?: string | undefined;
  /** Lệnh srt-live-transmit cho nút srt-test (mặc định env VTC_SRT_BIN). */
  srtBin?: string | undefined;
  /** Ms chờ auto-restart ffmpeg sau crash (mặc định 2000, docs/16 §9.2). */
  tcRestartDelayMs?: number | undefined;
  /** Ms chờ tsp ổn định trước khi spawn ffmpeg (mặc định 1000, docs/16 §2.2). */
  tcStartDelayMs?: number | undefined;
  /** Ms im lặng progress thì coi stale (mặc định 15000, docs/16 §9.3). */
  tcProgressMs?: number | undefined;
  /** File JSON persist presets (server tính từ storeFile). */
  presetFile: string;
  /** Tắt persist (test). */
  persistEnabled: boolean;
  /** Map ref→passphrase SRT (mặc định parse env VTC_SRT_PASSPHRASES). */
  srtSecrets?: Record<string, string> | undefined;
  /** RAMDisk live (ghi output HLS) + HDD captures (ghi sau-encode). */
  liveDir: string;
  captureDir: string;
  store: Store;
  notifier: TelegramNotifier;
}

/** Key so sánh tầng endpoint (preset/output/engine/record) — đổi là hot-restart ffmpeg. */
export function transcodeEndpointKey(t: ChannelTranscode | undefined): string {
  const n = normalizeChannelTranscode(t);
  if (n === undefined || !n.enabled) return '';
  return JSON.stringify({ p: n.presetIds, o: n.outputs, e: n.engine ?? 'cpu', r: n.recordPresetId ?? '' });
}

/** Key so sánh cấu hình puller — đổi là hot-restart puller (không động tsp). */
export function pullerCfgKey(p: SourceRecord['puller']): string {
  const n = normalizeSourcePuller(p);
  return n === undefined ? '' : JSON.stringify(n);
}

/** Key so sánh cấu hình capture — đổi là hot-restart agent (không động tsp). */
export function captureCfgKey(p: SourceRecord['capture']): string {
  const n = normalizeSourceCapture(p);
  return n === undefined ? '' : JSON.stringify(n);
}

export class TranscodeService {
  readonly presetStore = new PresetStore();
  readonly tm: TranscodeManager;
  private readonly store: Store;
  private readonly notifier: TelegramNotifier;
  private readonly presetFile: string;
  private readonly persistEnabled: boolean;
  private readonly srtSecrets: Record<string, string>;
  private readonly srtBin: string;
  private readonly ffmpegBin: string;
  private readonly tcRestartDelayMs: number;
  private readonly tcStartDelayMs: number;
  private readonly tcProgressMs: number;
  private readonly liveDir: string;
  private readonly captureDir: string;
  private readonly noRestartTc = new Set<string>();
  private readonly pendingTcRestarts = new Map<string, NodeJS.Timeout>();
  private readonly pendingTcStarts = new Map<string, NodeJS.Timeout[]>();
  private encodersCache: string | null = null;

  constructor(opts: TranscodeServiceOptions) {
    this.store = opts.store;
    this.notifier = opts.notifier;
    this.presetFile = opts.presetFile;
    this.persistEnabled = opts.persistEnabled;
    this.srtSecrets = opts.srtSecrets ?? parseSecretsEnv(process.env['VTC_SRT_PASSPHRASES'] ?? '');
    this.srtBin = opts.srtBin ?? TranscodeService.envNonEmpty('VTC_SRT_BIN', 'srt-live-transmit');
    this.ffmpegBin = opts.ffmpegBin ?? TranscodeService.envNonEmpty('VTC_FFMPEG_BIN', 'ffmpeg');
    this.tcRestartDelayMs = opts.tcRestartDelayMs ?? 2000;
    // Env trống/chữ/số âm → về default 1000 (Number('')=0 sẽ giết delay chống sốc UDP).
    this.tcStartDelayMs = opts.tcStartDelayMs ?? parseTcStartDelayMs(process.env['VTC_TC_START_DELAY_MS']);
    this.tcProgressMs = opts.tcProgressMs ?? 15000;
    this.liveDir = opts.liveDir;
    this.captureDir = opts.captureDir;
    this.tm = new TranscodeManager({ ffmpegBin: this.ffmpegBin, progressTimeoutMs: opts.tcProgressMs ?? 15000 });
    this.setupHandlers();
  }

  tcKey(sourceId: string, channel: string): string {
    return `${sourceId}/${channel}`;
  }

  pullKey(sourceId: string): string {
    return `pull/${sourceId}`;
  }

  capKey(sourceId: string): string {
    return `cap/${sourceId}`;
  }

  savePresets(): void {
    if (!this.persistEnabled) return;
    try {
      mkdirSync(dirname(this.presetFile), { recursive: true });
      const tmp = `${this.presetFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.presetStore.listPresets(), null, 2), 'utf8');
      renameSync(tmp, this.presetFile);
    } catch {
      logger.warn(`không ghi được ${this.presetFile}`);
    }
  }

  loadPresets(): void {
    if (this.persistEnabled) {
      try {
        if (existsSync(this.presetFile)) {
          this.presetStore.replaceAll(JSON.parse(readFileSync(this.presetFile, 'utf8')) as unknown);
        }
      } catch {
        // file hỏng → seed default bên dưới
      }
    }
    this.presetStore.seedDefaults(defaultPresets());
  }

  /** Dọn mọi timer transcode (gọi ở server.close). */
  clearAllTimers(): void {
    for (const t of this.pendingTcRestarts.values()) clearTimeout(t);
    this.pendingTcRestarts.clear();
    for (const arr of this.pendingTcStarts.values()) for (const t of arr) clearTimeout(t);
    this.pendingTcStarts.clear();
    if (this.staleWatchdogTimer !== undefined) {
      clearInterval(this.staleWatchdogTimer);
      this.staleWatchdogTimer = undefined;
    }
  }

  /**
   * Watchdog stale (docs/16 §9.3): ffmpeg sống nhưng fps đứng quá progressTimeout
   * → Telegram + restart đúng config hiện tại. Crash đã có handler riêng.
   * Gọi 1 lần lúc server listen; tắt hẳn bằng VTC_TC_WATCHDOG=0.
   */
  startStaleWatchdog(intervalMs: number): void {
    if (process.env['VTC_TC_WATCHDOG'] === '0') return;
    if (this.staleWatchdogTimer !== undefined) return;
    this.staleWatchdogTimer = setInterval(() => void this.staleWatchdogTick(), intervalMs);
    this.staleWatchdogTimer.unref?.();
  }

  private staleWatchdogTimer: NodeJS.Timeout | undefined;

  private async staleWatchdogTick(): Promise<void> {
    // Restart 1 key stale: alert + stop + start lại đúng config hiện tại.
    const restartStale = async (key: string, label: string, start: () => number | null): Promise<void> => {
      void this.notifier.alert(`tc-stale:${key}`, `${label} stale (không tiến triển quá ${this.tcProgressMs}ms) — restart...`);
      this.noRestartTc.add(key);
      try {
        await this.tm.stop(key);
      } finally {
        this.noRestartTc.delete(key);
      }
      try {
        start();
      } catch (e) {
        logger.warn(`watchdog restart ${key} thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
      }
    };
    for (const key of this.tm.keys()) {
      if (!this.tm.isStale(key)) continue;
      if (key.startsWith('pull/')) {
        const sid = key.slice('pull/'.length);
        const rec = this.store.getSource(sid);
        if (rec === undefined || rec.status !== 'RUNNING' || normalizeSourcePuller(rec.puller) === undefined) continue;
        await restartStale(key, `Puller RTMP source ${sid}`, () => this.startSourcePuller(rec));
        continue;
      }
      if (key.startsWith('cap/')) {
        const sid = key.slice('cap/'.length);
        const rec = this.store.getSource(sid);
        if (rec === undefined || rec.status !== 'RUNNING' || normalizeSourceCapture(rec.capture) === undefined) continue;
        await restartStale(key, `Capture agent source ${sid}`, () => this.startSourceCapture(rec));
        continue;
      }
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const sid = key.slice(0, slash);
      const chName = key.slice(slash + 1);
      const rec = this.store.getSource(sid);
      const ch = rec?.channels.find((c) => c.name === chName);
      if (rec === undefined || rec.status !== 'RUNNING' || ch === undefined || ch.transcode?.enabled !== true) continue;
      await restartStale(key, `Transcode ${chName}`, () => this.startChannelTranscode(sid, ch));
    }
  }

  /**
   * Fail-fast lúc tạo/sửa source: preset/output/puller/capture phải hợp lệ NGAY
   * (đừng để tới lúc start mới nổ). Trả message lỗi hoặc null = đạt.
   */
  checkTranscodeRefs(s: SourceConfig): string | null {
    for (const c of s.channels) {
      const t = normalizeChannelTranscode(c.transcode);
      if (t === undefined || !t.enabled) continue;
      for (const p of t.presetIds) {
        if (this.presetStore.getPreset(p) === undefined) return `kênh ${c.name} trỏ preset "${p}" không tồn tại`;
      }
      try {
        for (const o of t.outputs) parseOutput(o);
        const refErr = checkOutputPresetRefs(t.presetIds, t.outputs);
        if (refErr !== null) throw new TranscodeError(refErr);
        const recErr = checkRecordPresetId(t.presetIds, t.recordPresetId, this.presetStore.listPresets());
        if (recErr !== null) throw new TranscodeError(recErr);
      } catch (e) {
        return `kênh ${c.name}: ${e instanceof Error ? e.message : 'output sai'}`;
      }
    }
    if (s.puller !== undefined) {
      try {
        parsePuller(s.puller);
      } catch (e) {
        return `puller: ${e instanceof Error ? e.message : 'puller sai'}`;
      }
    }
    if (s.capture !== undefined) {
      try {
        const c = parseCapture(s.capture);
        const presetId = c.presetId ?? 'p1080';
        if (this.presetStore.getPreset(presetId) === undefined) return `capture trỏ preset "${presetId}" không tồn tại`;
      } catch (e) {
        return `capture: ${e instanceof Error ? e.message : 'capture sai'}`;
      }
    }
    return null;
  }

  /**
   * Chống trùng tài nguyên transcode TOÀN HỆ (docs/16 §10): 2 kênh cùng
   * loopbackPort thì 2 fork tsp xả chung 1 cổng UDP → ffmpeg ăn rác; 2 kênh
   * cùng srt-listen port thì ffmpeg thứ 2 bind rớt lúc start. Chặn từ lúc nhập.
   */
  checkGlobalTranscodePorts(all: SourceConfig[]): string | null {
    const loop = new Map<number, string>();
    const srt = new Map<number, string>();
    const mcast = new Map<string, string>();
    const pullerPorts = new Map<number, string>();
    const capturePorts = new Map<number, string>();
    for (const s of all) {
      const p = normalizeSourcePuller(s.puller);
      if (p !== undefined) {
        const dup = pullerPorts.get(p.udpPort);
        if (dup !== undefined) return `cổng puller ${p.udpPort} bị trùng (${dup} và ${s.id}) — 1 source 1 cổng`;
        pullerPorts.set(p.udpPort, s.id);
      }
      const c = normalizeSourceCapture(s.capture);
      if (c !== undefined) {
        const dup = capturePorts.get(c.udpPort);
        if (dup !== undefined) return `cổng capture agent ${c.udpPort} bị trùng (${dup} và ${s.id}) — 1 source 1 cổng`;
        capturePorts.set(c.udpPort, s.id);
      }
      for (const ch of s.channels) {
        const t = normalizeChannelTranscode(ch.transcode);
        if (t === undefined || !t.enabled) continue;
        const who = `${s.id}/${ch.name}`;
        const dupLoop = loop.get(t.loopbackPort);
        if (dupLoop !== undefined) return `loopbackPort ${t.loopbackPort} bị trùng (${dupLoop} và ${who}) — 1 kênh 1 cổng`;
        loop.set(t.loopbackPort, who);
        for (const o of t.outputs) {
          if (!o.enabled) continue;
          if (o.type === 'srt-listen' && o.port !== undefined) {
            const dup = srt.get(o.port);
            if (dup !== undefined) return `cổng srt-listen ${o.port} bị trùng (${dup} và ${who}) — 1 port 1 rendition`;
            srt.set(o.port, who);
          }
          if (o.type === 'udp-mcast' && o.group !== undefined && o.port !== undefined) {
            const k = `${o.group}:${o.port}`;
            const dup = mcast.get(k);
            if (dup !== undefined) return `nhóm multicast ${k} bị trùng (${dup} và ${who})`;
            mcast.set(k, who);
          }
        }
      }
    }
    return null;
  }

  /** Spawn ffmpeg cho 1 kênh (ném lỗi rõ để route trả 4xx/5xx). */
  startChannelTranscode(sourceId: string, ch: ChannelConfig): number {
    const t = normalizeChannelTranscode(ch.transcode);
    if (t === undefined || !t.enabled) throw new Error(`kênh ${ch.name} chưa bật transcode`);
    if (t.presetIds.length === 0) throw new Error(`kênh ${ch.name} bật transcode nhưng chưa chọn preset nào`);
    const presets = t.presetIds.map((id) => {
      const p = this.presetStore.getPreset(id);
      if (p === undefined) throw new Error(`kênh ${ch.name} trỏ preset "${id}" không tồn tại`);
      return p;
    });
    this.checkEngineOrWarn(t.engine);
    const args = buildFfmpegArgs({
      channelName: ch.name,
      loopbackPort: t.loopbackPort,
      presets,
      outputs: t.outputs.filter((o) => o.enabled),
      engine: t.engine,
      secrets: this.srtSecrets,
      hlsDir: this.liveDir,
      record:
        t.recordPresetId !== undefined
          ? { dir: join(this.captureDir, sourceId, `after-${ch.name}`), presetId: t.recordPresetId, serviceId: ch.serviceId }
          : undefined,
    });
    return this.tm.start(this.tcKey(sourceId, ch.name), args);
  }

  /** Hẹn spawn ffmpeg sau khi tsp ổn định (chống sốc UDP loopback). */
  scheduleTcStarts(sourceId: string): void {
    this.cancelTcStarts(sourceId);
    const rec = this.store.getSource(sourceId);
    if (rec === undefined || rec.status !== 'RUNNING') return;
    const enabled = rec.channels.filter((c) => c.transcode?.enabled === true);
    if (enabled.length === 0) return;
    const timers: NodeJS.Timeout[] = enabled.map((c) => {
      const t = setTimeout(() => {
        try {
          this.startChannelTranscode(sourceId, c);
          logger.info(`transcode ${sourceId}/${c.name} đã start`);
        } catch (e) {
          void this.notifier.alert(
            `tc:${sourceId}/${c.name}`,
            `Transcode ${c.name} start thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}`,
          );
        }
      }, this.tcStartDelayMs);
      t.unref?.();
      return t;
    });
    this.pendingTcStarts.set(sourceId, timers);
  }

  cancelTcStarts(sourceId: string): void {
    const arr = this.pendingTcStarts.get(sourceId);
    if (arr !== undefined) {
      for (const t of arr) clearTimeout(t);
      this.pendingTcStarts.delete(sourceId);
    }
  }

  /** Diệt mọi ffmpeg của source (ffmpeg trước, tsp sau — docs/16 §9.1). */
  async stopSourceTranscodes(sourceId: string): Promise<void> {
    this.cancelTcStarts(sourceId);
    const rec = this.store.getSource(sourceId);
    const names = rec !== undefined ? rec.channels.map((c) => c.name) : [];
    for (const n of names) {
      const k = this.tcKey(sourceId, n);
      this.noRestartTc.add(k);
      try {
        await this.tm.stop(k);
      } finally {
        this.noRestartTc.delete(k);
      }
      const t = this.pendingTcRestarts.get(k);
      if (t !== undefined) {
        clearTimeout(t);
        this.pendingTcRestarts.delete(k);
      }
    }
  }

  /** Spawn puller cho source (ném lỗi rõ). Gọi TRƯỚC khi start tsp. */
  startSourcePuller(rec: SourceRecord): number | null {
    const p = normalizeSourcePuller(rec.puller);
    if (p === undefined) return null;
    const args = buildPullerArgs({ rtmpUrl: p.rtmpUrl, streamKey: p.streamKey, udpPort: p.udpPort });
    return this.tm.start(this.pullKey(rec.id), args);
  }

  /** Diệt puller (không động tsp). Luôn resolve. */
  async stopSourcePuller(sourceId: string): Promise<void> {
    await this.stopOne(this.pullKey(sourceId));
  }

  /**
   * Stop 1 ffmpeg key bất kỳ: chặn restart + hủy hẹn (dùng cho stop tay
   * transcode-stop và hot-update endpoint). Luôn resolve.
   */
  async stopKey(key: string): Promise<void> {
    await this.stopOne(key);
  }

  /** Spawn capture agent cho source (ném lỗi rõ). Gọi TRƯỚC khi start tsp. */
  startSourceCapture(rec: SourceRecord): number | null {
    const c = normalizeSourceCapture(rec.capture);
    if (c === undefined) return null;
    const preset = this.presetStore.getPreset(c.presetId ?? 'p1080');
    if (preset === undefined) throw new Error(`capture trỏ preset "${c.presetId ?? 'p1080'}" không tồn tại`);
    this.checkEngineOrWarn(c.engine ?? 'cpu');
    const args = buildCaptureArgs({
      device: c.device,
      cardIndex: c.cardIndex,
      connection: c.connection,
      formatCode: c.formatCode,
      udpPort: c.udpPort,
      preset,
      engine: c.engine,
    });
    return this.tm.start(this.capKey(rec.id), args);
  }

  /** Diệt capture agent (không động tsp). Luôn resolve. */
  async stopSourceCapture(sourceId: string): Promise<void> {
    await this.stopOne(this.capKey(sourceId));
  }

  /**
   * Nút Test SRT (docs/16 T2): đóng vai caller bắt tay vào listener của ta
   * (srt-listen), hoặc bắt tay tới listener phía họ (srt-caller — kiểm tra
   * tới được đối tác trước khi đẩy thật). Sống quá 8s = pass.
   * Chỉ chứng minh BẮT TAY, không chứng minh có dữ liệu (xem docs/16 §4).
   */
  probeSrtTarget(host: string, port: number, label: string): Promise<{ ok: boolean; detail: string }> {
    const srtBin = this.srtBin;
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { ok: boolean; detail: string }): void => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(srtBin, [`srt://${host}:${port}`, 'file:///dev/null'], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch {
        finish({ ok: false, detail: `không spawn được ${srtBin}` });
        return;
      }
      let err = '';
      child.stderr?.on('data', (c: Buffer) => {
        err += c.toString('utf8');
        if (err.length > 8000) err = err.slice(-8000);
      });
      child.on('error', () => finish({ ok: false, detail: `không chạy được ${srtBin} — kiểm tra VTC_SRT_BIN` }));
      child.on('exit', (code) => {
        finish({ ok: false, detail: `${label} không bắt tay được (exit ${String(code)}): ${err.trim().slice(-300)}` });
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* đã chết */
        }
        finish({ ok: true, detail: `${label} bắt tay OK (giữ kết nối 8s)` });
      }, 8000);
      timer.unref?.();
    });
  }

  //-- Nội bộ ---------------------------------------------------------------

  private static envNonEmpty(name: string, fallback: string): string {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return fallback;
    return v;
  }

  private async stopOne(key: string): Promise<void> {
    this.noRestartTc.add(key);
    try {
      await this.tm.stop(key);
    } finally {
      this.noRestartTc.delete(key);
    }
    const t = this.pendingTcRestarts.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      this.pendingTcRestarts.delete(key);
    }
  }

  private getEncodersText(): string {
    if (this.encodersCache !== null) return this.encodersCache;
    try {
      this.encodersCache = execFileSync(this.ffmpegBin, ['-hide_banner', '-encoders'], {
        timeout: 15000,
        maxBuffer: 1_000_000,
      }).toString();
    } catch {
      return '';
    }
    return this.encodersCache;
  }

  private checkEngineOrWarn(engine: ChannelTranscode['engine']): void {
    const e = engine ?? 'cpu';
    const txt = this.getEncodersText();
    if (txt === '') {
      logger.warn(`không đọc được ${this.ffmpegBin} -encoders — bỏ qua check engine ${e}`);
      return;
    }
    assertEngineAvailable(e, txt);
  }

  private setupHandlers(): void {
    this.tm.setHandlers({
      onStatus: () => {
        // Status transcode đọc trực tiếp từ tm.snapshot ở endpoint — không cần store.
      },
      onExit: (key, code, signal) => {
        if (this.noRestartTc.has(key)) return; // stop tay — không restart
        const why = signal !== null ? `signal ${signal}` : `mã ${String(code)}`;
        if (key.startsWith('pull/')) return this.onAgentExit(key, why, 'pull', 'Puller RTMP');
        if (key.startsWith('cap/')) return this.onAgentExit(key, why, 'cap', 'Capture agent');
        const slash = key.indexOf('/');
        if (slash < 0) return;
        const sid = key.slice(0, slash);
        const chName = key.slice(slash + 1);
        const rec = this.store.getSource(sid);
        const ch = rec?.channels.find((c) => c.name === chName);
        if (rec === undefined || rec.status !== 'RUNNING' || ch === undefined || ch.transcode?.enabled !== true) return;
        this.scheduleRestart(key, `Transcode ${chName}`, why, () => {
          const r2 = this.store.getSource(sid);
          const c2 = r2?.channels.find((c) => c.name === chName);
          if (r2 === undefined || r2.status !== 'RUNNING' || c2 === undefined || c2.transcode?.enabled !== true) return;
          if (this.tm.isRunning(key)) return;
          this.startChannelTranscode(sid, c2);
        });
      },
    });
  }

  private onAgentExit(
    key: string,
    why: string,
    prefix: 'pull' | 'cap',
    label: string,
  ): void {
    const sid = key.slice(prefix.length + 1);
    const rec = this.store.getSource(sid);
    const hasCfg =
      prefix === 'pull' ? normalizeSourcePuller(rec?.puller) !== undefined : normalizeSourceCapture(rec?.capture) !== undefined;
    if (rec === undefined || rec.status !== 'RUNNING' || !hasCfg) return;
    this.scheduleRestart(key, `${label} source ${sid}`, why, () => {
      const r2 = this.store.getSource(sid);
      const hasCfg2 =
        prefix === 'pull' ? normalizeSourcePuller(r2?.puller) !== undefined : normalizeSourceCapture(r2?.capture) !== undefined;
      if (r2 === undefined || r2.status !== 'RUNNING' || !hasCfg2) return;
      if (this.tm.isRunning(key)) return;
      if (prefix === 'pull') this.startSourcePuller(r2);
      else this.startSourceCapture(r2);
    });
  }

  private scheduleRestart(key: string, label: string, why: string, start: () => void): void {
    const crashes = this.tm.recentCrashes(key, 5 * 60 * 1000);
    if (crashes > 3) {
      void this.notifier.alert(`tc:${key}`, `${label} crash ${crashes} lần/5 phút (${why}) — DỪNG HẲN, chờ operator kiểm tra.`);
      return;
    }
    void this.notifier.alert(`tc:${key}`, `${label} dừng đột ngột (${why}) — restart sau ${this.tcRestartDelayMs}ms (lần ${crashes}/3).`);
    const t = setTimeout(() => {
      this.pendingTcRestarts.delete(key);
      try {
        start();
      } catch {
        // Lỗi resolve: alert ở lần crash tiếp theo, operator xem log.
      }
    }, this.tcRestartDelayMs);
    t.unref?.();
    this.pendingTcRestarts.set(key, t);
  }
}
