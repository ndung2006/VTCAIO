//=============================================================================
 // server.ts — HTTP API Phase 2a (node:http thuần).
 // Public (không cần login): /health, /api/auth/login, forgot, reset, logout.
 // Còn lại dưới /api/*: bắt buộc JWT trong HttpOnly Cookie (verifyAuth).
 // 401 khi thiếu/sai/hết hạn token — chặn trước khi spawn hay chạm đĩa.
 // Endpoints auth: xem docs/07-AUTH.md.
 //=============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { generateConfText, writeConfFile, DEFAULT_CONF_DIR, ConfigError } from '../core/ConfigGenerator.js';
import { ProcessManager } from '../core/ProcessManager.js';
import { Store, type SourceRecord } from './store.js';
import { snapshot } from './system.js';
import {
  JWT_COOKIE,
  RESET_TTL_MS,
  checkPassword,
  hashPassword,
  jwtClearCookie,
  jwtSetCookie,
  newResetToken,
  parseCookies,
  signToken,
  verifyToken,
} from './auth.js';
import { DEFAULT_RETENTION_DAYS, runGarbageCollector } from '../jobs/garbageCollector.js';
import { TelegramNotifier, processAlertText } from '../jobs/notify.js';
import {
  clampHlsTtl,
  signHlsToken,
  signPullToken,
  verifyHlsToken,
  verifyPartnerKey,
  verifyPullToken,
} from './hlsToken.js';
import { buildTimeshiftPlaylist, probeProgramCount, TimeshiftError } from '../timeshift/timeshift.js';
import { sendResetMail } from './mailer.js';
import { logger } from '../core/logger.js';
import { checkHlsHealth } from '../jobs/healthcheck.js';
import { Exporter, ExportError } from '../exporter/exporter.js';
import { EpgClient, EpgError } from '../epg/client.js';
import { EpgStore } from '../epg/store.js';
import { syncNow, vnToday, type SyncMapping, type SyncStats } from '../epg/sync.js';
import type { SourceConfig } from '../core/types.js';

export interface ApiOptions {
  port?: number;
  confDir?: string;
  captureDir?: string;
  exportsDir?: string;
  liveDir?: string;
  tspBin?: string;
  /** Secret ký JWT (Prod bắt buộc VTC_JWT_SECRET). */
  jwtSecret?: string;
  /** Ms chờ auto-restart sau crash (mặc định 5000, test truyền nhỏ). */
  restartDelayMs?: number;
  /** Admin seed lúc boot (dev). */
  adminUser?: string;
  adminPass?: string;
  adminEmail?: string;
  /** File JSON persist danh sách sources (mặc định <confDir>/sources.db.json). */
  storeFile?: string;
  /** Tắt persist (test truyền false để isolation). Mặc định true, trừ khi VTC_PERSIST=0. */
  persist?: boolean;
  /** Tự start lại các source đã RUNNING trước khi restart container. Mặc định true. */
  autoStart?: boolean;
  /** Inject fetch cho EPG client (test). Mặc định dùng fetch thật. */
  epgFetchFn?: typeof fetch;
}

/** Message chung cho login sai (không lộ user nào tồn tại). */
const LOGIN_FAIL = 'sai tên đăng nhập hoặc mật khẩu';
/** Message chung cho forgot (chống enumerate email). */
const FORGOT_MSG = 'Nếu email hợp lệ, hệ thống đã gửi một đường link khôi phục. Vui lòng kiểm tra hộp thư.';

const JSON_CT = 'application/json; charset=utf-8';

function send(res: ServerResponse, code: number, body: unknown): void {
  const txt = JSON.stringify(body);
  res.writeHead(code, { 'content-type': JSON_CT, 'content-length': Buffer.byteLength(txt) });
  res.end(txt);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      if (buf.length > 1_000_000) reject(new Error('body quá lớn'));
    });
    req.on('end', () => {
      if (buf === '') return resolve({});
      try {
        resolve(JSON.parse(buf) as unknown);
      } catch {
        reject(new Error('JSON không hợp lệ'));
      }
    });
  });
}

function checkSourceBody(b: unknown): SourceConfig {
  const o = b as Partial<SourceConfig>;
  if (typeof o.id !== 'string' || o.id === '') throw new Error('thiếu id');
  if (typeof o.input !== 'string' || o.input === '') throw new Error('thiếu input');
  if (!Array.isArray(o.channels)) throw new Error('thiếu channels[]');
  if (typeof o.recordAll !== 'boolean') throw new Error('thiếu recordAll (boolean)');
  return o as SourceConfig;
}

/**
 * Tên kênh phải duy nhất toàn hệ thống: thư mục HLS live là
 * `<LIVE_BASE>/<channelName>` — trùng tên là hai nguồn đè playlist của nhau.
 * Trả về câu lỗi hoặc null.
 */
function duplicateChannelName(all: SourceConfig[]): string | null {
  const seen = new Map<string, string>();
  for (const s of all) {
    if (!Array.isArray(s.channels)) continue;
    for (const c of s.channels) {
      const name = (c as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') continue;
      const prev = seen.get(name);
      if (prev !== undefined) {
        return prev === s.id
          ? `tên kênh "${name}" bị trùng trong cùng nguồn ${s.id} (thư mục HLS sẽ đè nhau)`
          : `tên kênh "${name}" bị trùng giữa ${prev} và ${s.id} (thư mục HLS sẽ đè nhau)`;
      }
      seen.set(name, s.id);
    }
  }
  return null;
}

/**
 * partnerChannelId (map lịch EPG) nếu có phải là số nguyên ≥1 và duy nhất toàn
 * hệ thống (1 ID đối tác trỏ 2 kênh local là mơ hồ). Trả câu lỗi hoặc null.
 */
export function checkPartnerMapping(all: SourceConfig[]): string | null {
  const seen = new Map<number, string>();
  for (const s of all) {
    if (!Array.isArray(s.channels)) continue;
    for (const c of s.channels) {
      const pid = (c as { partnerChannelId?: unknown }).partnerChannelId;
      if (pid === undefined || pid === null) continue;
      if (!Number.isInteger(pid) || (pid as number) < 1) {
        return `partnerChannelId của kênh "${(c as { name?: string }).name}" phải là số nguyên ≥1`;
      }
      const prev = seen.get(pid as number);
      if (prev !== undefined) {
        return `partnerChannelId ${pid} bị map trùng (${prev} và ${s.id})`;
      }
      seen.set(pid as number, s.id);
      const pub = (c as { published?: unknown }).published;
      if (pub !== undefined && pub !== null && typeof pub !== 'boolean') {
        return `published của kênh "${(c as { name?: string }).name}" phải là boolean`;
      }
    }
  }
  return null;
}

/** Timeshift xem lại tối đa 6h/lần (chung lý do với Exporter: bảo vệ I/O). */
const TIMESIFT_MAX_HOURS = 6;

/**
 * Token kênh gắn trên URL có hợp lệ cho 2 route timeshift không (miễn gate).
 * Playlist: channel nằm ở path; chunks: channel nằm ở query. Handler kiểm chặt lại.
 */
function hasValidTimeshiftToken(url: URL, seg: string[]): boolean {
  if (seg[1] !== 'timeshift') return false;
  const q = url.searchParams;
  if (seg[2] === 'chunks' && seg.length === 3) {
    const channel = q.get('channel') ?? '';
    const pull = q.get('pull');
    if (pull !== null) return verifyPullToken(channel, pull);
    const token = q.get('token') ?? '';
    const exp = Number(q.get('exp') ?? '');
    return verifyHlsToken(channel, exp, token);
  }
  if (seg.length === 3) {
    const channel = decodeURIComponent(seg[2] ?? '');
    const pull = q.get('pull');
    if (pull !== null) return verifyPullToken(channel, pull);
    const token = q.get('token') ?? '';
    const exp = Number(q.get('exp') ?? '');
    return verifyHlsToken(channel, exp, token);
  }
  return false;
}

/** ISO string, chuỗi số epoch hoặc epoch ms → epoch ms (NaN nếu không parse được). */
function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    const p = Date.parse(t);
    return Number.isNaN(p) ? NaN : p;
  }
  return NaN;
}

/**
 * verifyAuth: JWT trong HttpOnly Cookie, HOẶC Bearer partner key
 * (VTC_PARTNER_KEYS, cho máy-gọi-máy như VTVgo — full quyền, giữ kín như pass).
 * Gắn trước mọi API nghiệp vụ — chặn spawn/chạm đĩa khi 401.
 */function makeRequireAuth(jwtSecret: string) {
  return (req: IncomingMessage): string | null => {
    const token = parseCookies(req.headers.cookie)[JWT_COOKIE];
    if (token !== undefined) {
      try {
        return verifyToken(token, jwtSecret).sub;
      } catch {
        // cookie hỏng thì thử Bearer tiếp thay vì rớt ngay
      }
    }
    const partner = verifyPartnerKey(req.headers.authorization);
    if (partner !== null) return `partner:${partner}`;
    return null;
  };
}

export function createApi(opts: ApiOptions = {}): {
  listen: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
} {
  const store = new Store();
  const pm = opts.tspBin === undefined ? new ProcessManager() : new ProcessManager({ tspBin: opts.tspBin });
  const confDir = opts.confDir ?? DEFAULT_CONF_DIR;
  //-- Persist sources ra JSON để restart container/Coolify không mất cấu hình --
  const persistEnabled = opts.persist ?? process.env['VTC_PERSIST'] !== '0';
  const storeFile = opts.storeFile ?? `${confDir.replace(/\/$/, '')}/sources.db.json`;
  const autoStartEnabled = opts.autoStart ?? process.env['VTC_AUTOSTART'] !== '0';
  function savePersisted(): void {
    if (!persistEnabled) return;
    try {
      mkdirSync(dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.listSources(), null, 2), 'utf8');
      renameSync(tmp, storeFile);
    } catch {
      // Ghi persist thất bại thì log, không chặn nghiệp vụ chính.
      logger.warn(`không ghi được ${storeFile}`);
    }
  }
  function loadPersisted(): string[] {
    if (!persistEnabled) return [];
    try {
      if (!existsSync(storeFile)) return [];
      const raw = readFileSync(storeFile, 'utf8');
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      const wasRunning: string[] = [];
      for (const r of arr) {
        const rec = r as Parameters<Store['restore']>[0];
        if (typeof rec.id !== 'string' || rec.id === '') continue;
        if (rec.status === 'RUNNING') wasRunning.push(rec.id);
        try {
          store.restore(rec);
        } catch {
          // bản ghi hỏng thì bỏ qua
        }
      }
      return wasRunning;
    } catch {
      return [];
    }
  }
  const captureDir = opts.captureDir ?? process.env['VTC_CAPTURE_DIR'] ?? 'storage/captures';
  const exportsDir = opts.exportsDir ?? process.env['VTC_EXPORTS_DIR'] ?? 'storage/exports';
  const liveDir = opts.liveDir ?? process.env['VTC_LIVE_DIR'] ?? 'storage/ramdisk';
  const notifier = new TelegramNotifier(); // đọc VTC_TELEGRAM_* từ env, thiếu thì log
  const tspBin = opts.tspBin ?? process.env['VTC_TSP_BIN'] ?? 'tsp';
  //-- EPG đối tác (lịch đã duyệt): store JSON + client X-API-Key + worker 10p --
  const epgStoreFile = `${dirname(storeFile)}/epg.db.json`;
  const epgStore = new EpgStore(persistEnabled ? epgStoreFile : undefined);
  const epgClient =
    opts.epgFetchFn === undefined ? new EpgClient() : new EpgClient({ fetchFn: opts.epgFetchFn });
  const epgPastDays = Number(process.env['VTC_EPG_PAST_DAYS'] ?? 2);
  const epgFutureDays = Number(process.env['VTC_EPG_FUTURE_DAYS'] ?? 7);
  let epgLastSyncAt: string | null = null;
  let epgLastStats: SyncStats | null = null;
  /** Mapping local <- đối tác từ cấu hình sources (kênh có partnerChannelId). */
  function epgMappings(): SyncMapping[] {
    return store.listSources().flatMap((s) =>
      s.channels
        .filter((c) => typeof c.partnerChannelId === 'number')
        .map((c) => ({ partnerChannelId: c.partnerChannelId as number, localName: c.name })),
    );
  }
  async function runEpgSync(onlyPartnerId?: number): Promise<SyncStats> {
    const mappings = epgMappings().filter((m) => onlyPartnerId === undefined || m.partnerChannelId === onlyPartnerId);
    const stats = await syncNow({
      store: epgStore,
      client: epgClient,
      mappings,
      pastDays: Number.isFinite(epgPastDays) ? epgPastDays : 2,
      futureDays: Number.isFinite(epgFutureDays) ? epgFutureDays : 7,
    });
    epgLastSyncAt = new Date().toISOString();
    epgLastStats = stats;
    const errPart =
      stats.errors.length > 0 ? `, LỖI ${stats.errors.length} (VD: ${stats.errors[0]?.error ?? ''})` : '';
    logger.info(`epg-sync: ${stats.updated} ngày mới/${stats.days} ngày quét (${stats.mappings} kênh map)${errPart}`);
    return stats;
  }
  const exporter =
    opts.tspBin === undefined
      ? new Exporter({ captureDir, exportsDir, persist: persistEnabled })
      : new Exporter({ captureDir, exportsDir, tspBin: opts.tspBin, persist: persistEnabled });
  const jwtSecret = opts.jwtSecret ?? process.env['VTC_JWT_SECRET'] ?? 'dev-only-insecure-secret';
  if (process.env['VTC_JWT_SECRET'] === undefined && opts.jwtSecret === undefined) {
    logger.warn('dùng JWT secret mặc định — đặt VTC_JWT_SECRET ở Prod!');
  }

  // TSDuck KHÔNG tự tạo thư mục output (open file fail → process chết ngay).
  // Tạo trước mỗi lần Start: captures/<id>/ (nếu recordAll) + live/<kenh>/ live.
  // Ném lỗi để caller quyết định (Start tay → 500 rõ ràng; auto/watchdog → ERROR).
  function ensureSourceDirs(rec: SourceRecord): void {
    try {
      if (rec.recordAll) mkdirSync(join(captureDir, rec.id), { recursive: true });
      for (const c of rec.channels) {
        if (c.isLive) mkdirSync(join(liveDir, c.name), { recursive: true });
      }
    } catch (e) {
      throw new Error(`không tạo được thư mục output cho ${rec.id}: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
    }
  }

  // Đồng bộ trạng thái process → store (UI đọc 1 chỗ).
  // CC-error → Telegram (cooldown 5'/source trong notifier, PRD §15).
  // Crash không chủ đích → Telegram (Trigger 1) + auto-restart sau restartDelayMs
  // với conf mới nhất (PRD §3.2). Stop tay/xóa record thì không restart.
  const restartDelayMs = opts.restartDelayMs ?? 5000;
  const noRestart = new Set<string>(); // id đang stop tay
  const pendingRestarts = new Map<string, NodeJS.Timeout>();
  const clearPending = (id: string): void => {
    const t = pendingRestarts.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      pendingRestarts.delete(id);
    }
  };
  pm.setHandlers({
    onStatus: (id, s) => {
      store.setStatus(id, s, pm.getPid(id));
      savePersisted();
    },
    onCcError: (ev) => {
      void notifier.alert(
        `cc:${ev.sourceId}`,
        processAlertText(ev.sourceId, `CC error pid=${ev.pid} (expected ${ev.expected}, got ${ev.got})`, 'Tín hiệu có dấu hiệu packet-loss.'),
      );
    },
    onExit: (id, code, signal) => {
      if (noRestart.has(id)) return; // stop tay — không restart
      const rec = store.getSource(id);
      if (rec === undefined) return; // đã bị xóa — không restart
      const why = signal !== null ? `signal ${signal}` : `mã ${String(code)}`;
      void notifier.alert(
        `exit:${id}`,
        processAlertText(id, `Tiến trình tsp dừng đột ngột (${why})`, 'Đang tiến hành Auto-restart...'),
      );
      store.setStatus(id, 'ERROR');
      savePersisted();
      clearPending(id);
      const t = setTimeout(() => {
        pendingRestarts.delete(id);
        const r = store.getSource(id);
        if (r === undefined || r.status !== 'ERROR') return;
        try {
          ensureSourceDirs(r);
          const gen = writeConfFile({ ...r, confRev: r.confRev }, confDir);
          const pid = pm.start(id, gen.filePath ?? `${confDir}/${id}.conf`);
          store.setStatus(id, 'RUNNING', pid);
          savePersisted();
        } catch {
          // tsp missing/conf lỗi: giữ ERROR, chờ operator sửa + start tay.
        }
      }, restartDelayMs);
      t.unref?.();
      pendingRestarts.set(id, t);
    },
  });
  const requireAuth = makeRequireAuth(jwtSecret);

  // Seed admin lúc boot (in-memory; Phase 2b chuyển vào DB + migration).
  const adminUser = opts.adminUser ?? process.env['VTC_ADMIN_USER'] ?? 'admin';
  const adminEmail = opts.adminEmail ?? process.env['VTC_ADMIN_EMAIL'] ?? 'admin@vtc.local';
  const adminPass = opts.adminPass ?? process.env['VTC_ADMIN_PASS'] ?? 'admin12345';
  let seeded = false;
  async function seedAdmin(): Promise<void> {
    if (seeded) return;
    seeded = true;
    store.seedUser({
      username: adminUser,
      email: adminEmail,
      passwordHash: await hashPassword(adminPass),
      role: 'admin',
    });
    if (process.env['VTC_ADMIN_PASS'] === undefined && opts.adminPass === undefined) {
      logger.warn('dùng mật khẩu admin mặc định — đặt VTC_ADMIN_PASS ở Prod!');
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'lỗi không rõ';
      const code = /không tồn tại/.test(msg) ? 404 : /đang RUNNING|vô nghĩa|thiếu|không hợp lệ/.test(msg) ? 400 : 500;
      send(res, code, { error: msg });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = req.method ?? 'GET';
    const seg = url.pathname.split('/').filter(Boolean);

    if (m === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }

    //-- Auth routes (public) -------------------------------------------------
    if (seg[0] === 'api' && seg[1] === 'auth') {
      // POST /api/auth/login {username, password}
      if (m === 'POST' && seg[2] === 'login') {
        const b = (await readJson(req)) as { username?: unknown; password?: unknown };
        const user =
          typeof b.username === 'string' ? store.findUser(b.username) : undefined;
        const ok =
          user !== undefined &&
          typeof b.password === 'string' &&
          (await checkPassword(b.password, user.passwordHash));
        if (!ok) return send(res, 401, { error: LOGIN_FAIL });
        res.setHeader('set-cookie', jwtSetCookie(signToken(user, jwtSecret)));
        send(res, 200, { ok: true, user: { username: user.username, role: user.role } });
        return;
      }
      // POST /api/auth/logout
      if (m === 'POST' && seg[2] === 'logout') {
        res.setHeader('set-cookie', jwtClearCookie());
        send(res, 200, { ok: true });
        return;
      }
      // POST /api/auth/change-password (cần login)
      if (m === 'POST' && seg[2] === 'change-password') {
        const me = requireAuth(req);
        if (me === null) return send(res, 401, { error: 'unauthorized' });
        const b = (await readJson(req)) as {
          currentPassword?: unknown;
          newPassword?: unknown;
          confirmPassword?: unknown;
        };
        if (typeof b.newPassword !== 'string' || b.newPassword.length < 8) {
          return send(res, 400, { error: 'mật khẩu mới tối thiểu 8 ký tự' });
        }
        if (b.newPassword !== b.confirmPassword) {
          return send(res, 400, { error: 'xác nhận mật khẩu không khớp' });
        }
        const user = store.findUser(me);
        if (
          user === undefined ||
          typeof b.currentPassword !== 'string' ||
          !(await checkPassword(b.currentPassword, user.passwordHash))
        ) {
          return send(res, 401, { error: 'mật khẩu hiện tại không đúng' });
        }
        store.setPasswordHash(me, await hashPassword(b.newPassword));
        send(res, 200, { ok: true });
        return;
      }
      // POST /api/auth/forgot-password {email} — luôn message chung
      if (m === 'POST' && seg[2] === 'forgot-password') {
        const b = (await readJson(req)) as { email?: unknown };
        const user =
          typeof b.email === 'string' ? store.findUserByEmail(b.email) : undefined;
        if (user !== undefined) {
          const token = newResetToken();
          store.setResetToken(user.username, token, Date.now() + RESET_TTL_MS);
          // Có SMTP thì gửi mail, chưa có thì log link (dev/test xem log).
          await sendResetMail(user.email, token);
        }
        send(res, 200, { message: FORGOT_MSG });
        return;
      }
      // POST /api/auth/reset-password {token, newPassword}
      if (m === 'POST' && seg[2] === 'reset-password') {
        const b = (await readJson(req)) as { token?: unknown; newPassword?: unknown };
        if (typeof b.newPassword !== 'string' || b.newPassword.length < 8) {
          return send(res, 400, { error: 'mật khẩu mới tối thiểu 8 ký tự' });
        }
        const user = typeof b.token === 'string' ? store.findUserByResetToken(b.token) : undefined;
        if (user === undefined) {
          return send(res, 400, { error: 'link khôi phục không hợp lệ hoặc đã hết hạn' });
        }
        store.setPasswordHash(user.username, await hashPassword(b.newPassword));
        send(res, 200, { ok: true });
        return;
      }
      return send(res, 404, { error: 'không tìm thấy route' });
    }

    //-- Gate: mọi /api/* còn lại bắt buộc JWT hợp lệ (verifyAuth) -------------
    // Ngoại lệ: 2 route timeshift cho phép token kênh (?token=&exp= / ?pull=)
    // để VLC/app đối tác phát không cần cookie (handler kiểm chặt lại).
    if (seg[0] === 'api') {
      if (requireAuth(req) === null && !hasValidTimeshiftToken(url, seg)) {
        return send(res, 401, { error: 'unauthorized' });
      }
    }

    // SSE monitor: GET /api/system/stream (đã qua gate ở trên)
    if (m === 'GET' && url.pathname === '/api/system/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let alive = true;
      req.on('close', () => {
        alive = false;
        clearInterval(timer);
      });
      const push = async (): Promise<void> => {
        if (!alive) return;
        const s = await snapshot(captureDir);
        res.write(
          `data: ${JSON.stringify({ cpu: s.cpu, ram_used: s.ramUsedMb, ram_percent: s.ramPercent, disk_percent: s.diskPercent, network: { tx: s.network.txBytes, rx: s.network.rxBytes } })}\n\n`,
        );
      };
      const timer = setInterval(() => void push(), 2000);
      await push();
      return;
    }

    //-- Admin ops (đã qua gate) --------------------------------------------------
    // POST /api/admin/gc {dryRun?} — chạy GC ngay (cron giờ gọi endpoint này
    // hoặc bật VTC_GC_ENABLE=1 để server tự chạy mỗi giờ).
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'POST' && seg[2] === 'gc') {
      const b = (await readJson(req)) as { dryRun?: unknown };
      const r = await runGarbageCollector({
        captureDir,
        exportsDir,
        dryRun: b.dryRun === true,
        getRetentionDays: (id) => store.getSource(id)?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      });
      if (r.diskAfter !== null && r.diskAfter > 90) {
        await notifier.alert(
          'disk',
          processAlertText('DISK', `phân vùng captures đã ${r.diskAfter}% (ngưỡng 90%)`, 'Cần can thiệp dọn rác gấp.'),
        );
      }
      send(res, 200, r);
      return;
    }
    // GET /api/admin/hls-health — playlist kênh nào stale
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'GET' && seg[2] === 'hls-health') {
      send(res, 200, await checkHlsHealth(liveDir));
      return;
    }
    // GET /api/admin/notify-status — Telegram đã cấu hình chưa (không lộ secret)
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'GET' && seg[2] === 'notify-status') {
      send(res, 200, { configured: notifier.configured });
      return;
    }
    // POST /api/admin/notify-test — bắn tin thử để trực ca xác nhận nhận được
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'POST' && seg[2] === 'notify-test') {
      const result = await notifier.alert(
        'manual-test',
        processAlertText('VẬN HÀNH', 'Tin kiểm tra cảnh báo từ trang Quản trị', 'Nếu nhận được tin này, kênh cảnh báo hoạt động.'),
      );
      send(res, 200, { result, configured: notifier.configured });
      return;
    }
    // GET /api/admin/config-backup — tải toàn bộ cấu hình sources (JSON)
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'GET' && seg[2] === 'config-backup') {
      send(res, 200, { exportedAt: new Date().toISOString(), sources: store.listSources() });
      return;
    }
    // POST /api/admin/config-restore {sources: SourceConfig[]} — phục hồi cấu hình
    if (seg[0] === 'api' && seg[1] === 'admin' && m === 'POST' && seg[2] === 'config-restore') {
      const b = (await readJson(req)) as { sources?: unknown };
      if (!Array.isArray(b.sources)) return send(res, 400, { error: 'thiếu sources[]' });
      const records: SourceConfig[] = [];
      for (const s of b.sources) {
        try {
          const checked = checkSourceBody(s);
          generateConfText(checked); // validate sinh conf được
          records.push(checked);
        } catch (e) {
          if (e instanceof ConfigError) return send(res, 400, { error: `bản ghi lỗi: ${e.message}` });
          if (e instanceof Error) return send(res, 400, { error: `bản ghi lỗi: ${e.message}` });
          throw e;
        }
      }
      const dup = duplicateChannelName(records);
      if (dup !== null) return send(res, 400, { error: dup });
      const mapErr = checkPartnerMapping(records);
      if (mapErr !== null) return send(res, 400, { error: mapErr });
      try {
        store.replaceAll(records);
      } catch (e) {
        if (e instanceof Error) return send(res, 400, { error: e.message });
        throw e;
      }
      for (const r of records) {
        try {
          writeConfFile({ ...r, confRev: 1 }, confDir);
        } catch {
          // ghi conf lỗi thì Start sẽ báo — vẫn giữ record
        }
      }
      savePersisted();
      logger.info(`config-restore: phục hồi ${records.length} sources`);
      send(res, 200, { ok: true, count: records.length });
      return;
    }

    // POST /api/hls-tokens {channel, ttlMinutes?} — cấp link xem có hạn dùng
    // (đã qua gate JWT). Trả path kèm token+exp; trình phát/VLC dùng tới exp.
    if (seg[0] === 'api' && seg[1] === 'hls-tokens' && seg.length === 2 && m === 'POST') {
      const b = (await readJson(req)) as { channel?: unknown; ttlMinutes?: unknown };
      const channel = typeof b.channel === 'string' ? b.channel : '';
      const known = store.listSources().some((s) => s.channels.some((c) => c.name === channel));
      if (!known) return send(res, 404, { error: `Kênh ${channel} không tồn tại` });
      const exp = Date.now() + clampHlsTtl(b.ttlMinutes) * 60_000;
      const token = signHlsToken(channel, exp);
      const enc = encodeURIComponent(channel);
      send(res, 200, { token, exp, url: `/hls/${enc}/index.m3u8?token=${token}&exp=${exp}` });
      return;
    }

    // POST /api/pull-tokens {channel} — link kéo luồng KHÔNG hết hạn cho đối
    // tác (VTVgo lưu URL 1 lần, play mãi tới khi đổi secret). Kênh phải tồn tại.
    if (seg[0] === 'api' && seg[1] === 'pull-tokens' && seg.length === 2 && m === 'POST') {
      const b = (await readJson(req)) as { channel?: unknown };
      const channel = typeof b.channel === 'string' ? b.channel : '';
      const known = store.listSources().some((s) => s.channels.some((c) => c.name === channel));
      if (!known) return send(res, 404, { error: `Kênh ${channel} không tồn tại` });
      const pull = signPullToken(channel);
      const enc = encodeURIComponent(channel);
      send(res, 200, { channel, pull, url: `/hls/${enc}/index.m3u8?pull=${pull}` });
      return;
    }

    // GET /api/public/channels — danh mục kênh cho đối tác kéo luồng (Bearer).
    // Schema ổn định cho máy đọc: thêm field không xóa field.
    if (seg[0] === 'api' && seg[1] === 'public' && seg[2] === 'channels' && seg.length === 3 && m === 'GET') {
      const base = (process.env['VTC_PUBLIC_BASE_URL'] ?? '').replace(/\/$/, '');
      const nowIso = new Date().toISOString();
      // Opt-in: chỉ kênh được tích published mới lên danh mục đối tác.
      const channels = store
        .listSources()
        .flatMap((s) => s.channels.map((c) => ({ s, c })))
        .filter((x) => x.c.published === true)
        .map(({ s, c }) => {
          const pull = signPullToken(c.name);
          const path = `/hls/${encodeURIComponent(c.name)}/index.m3u8?pull=${pull}`;
          // Chương trình đang phát (cho app đối tác hiện now/next mà không cần gọi thêm).
          // So epoch ms (không so chuỗi: offset +07:00 vs Z khác nhau).
          let epgNow: { title: string; startTime: string; endTime: string } | null = null;
          if (typeof c.partnerChannelId === 'number') {
            const day = epgStore.getDay(c.partnerChannelId, vnToday());
            const nowMs = Date.parse(nowIso);
            const cur = day?.programs.find((p) => {
              const a = Date.parse(p.startTime);
              const b = Date.parse(p.endTime);
              return Number.isFinite(a) && Number.isFinite(b) && a <= nowMs && nowMs < b;
            });
            if (cur !== undefined) epgNow = { title: cur.title, startTime: cur.startTime, endTime: cur.endTime };
          }
          return {
            name: c.name,
            serviceId: c.serviceId,
            sourceId: s.id,
            status: s.status,
            live: c.isLive,
            epgId: c.partnerChannelId ?? null,
            epgNow,
            hls: base === '' ? path : `${base}${path}`,
          };
        });
      send(res, 200, { generatedAt: new Date().toISOString(), baseUrl: base, channels });
      return;
    }

    //-- EPG đối tác (đã qua gate) ----------------------------------------------
    // GET /api/epg/status — mapping local<->đối tác + ngày đã có + lần sync cuối.
    if (seg[0] === 'api' && seg[1] === 'epg' && seg[2] === 'status' && seg.length === 3 && m === 'GET') {
      const mappings = epgMappings();
      const partnerIds = [...new Set(mappings.map((x) => x.partnerChannelId))];
      send(res, 200, {
        configured: epgClient.configured,
        lastSyncAt: epgLastSyncAt,
        lastStats: epgLastStats,
        mappings: mappings.map((x) => ({ ...x, dates: epgStore.datesOf(x.partnerChannelId) })),
        unmappedLocal: store
          .listSources()
          .flatMap((s) => s.channels.filter((c) => c.partnerChannelId == null).map((c) => ({ name: c.name, sourceId: s.id }))),
        partnerTotal: partnerIds.length,
      });
      return;
    }
    // GET /api/epg/partner-channels?search=&page= — tra cứu ID đối tác để map.
    if (seg[0] === 'api' && seg[1] === 'epg' && seg[2] === 'partner-channels' && seg.length === 3 && m === 'GET') {
      try {
        const page = Number(url.searchParams.get('page') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 20);
        const search = url.searchParams.get('search') ?? '';
        send(res, 200, await epgClient.listChannels(page, limit, search));
      } catch (e) {
        if (e instanceof EpgError) return send(res, e.status === 429 ? 429 : 400, { error: e.message });
        throw e;
      }
      return;
    }
    // POST /api/admin/epg-sync {partnerChannelId?} — đồng bộ ngay (tay/nút UI).
    if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'epg-sync' && seg.length === 3 && m === 'POST') {
      if (!epgClient.configured) return send(res, 400, { error: 'chưa cấu hình VTC_EPG_API_KEY' });
      const b = (await readJson(req)) as { partnerChannelId?: unknown };
      const only =
        typeof b.partnerChannelId === 'number' && Number.isInteger(b.partnerChannelId) ? b.partnerChannelId : undefined;
      if (b.partnerChannelId !== undefined && only === undefined) {
        return send(res, 400, { error: 'partnerChannelId phải là số nguyên' });
      }
      const stats = await runEpgSync(only);
      send(res, 200, stats);
      return;
    }
    // GET /api/epg/schedule?channel=<localName>&date=YYYY-MM-DD — lịch 1 ngày.
    if (seg[0] === 'api' && seg[1] === 'epg' && seg[2] === 'schedule' && seg.length === 3 && m === 'GET') {
      const localName = url.searchParams.get('channel') ?? '';
      const date = url.searchParams.get('date') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'date phải YYYY-MM-DD' });
      const map = epgMappings().find((x) => x.localName === localName);
      if (map === undefined) return send(res, 404, { error: `Kênh ${localName} chưa map ID EPG đối tác` });
      const day = epgStore.getDay(map.partnerChannelId, date);
      if (day === undefined) {
        return send(res, 404, { error: `Chưa có lịch đã duyệt của ${localName} ngày ${date}` });
      }
      send(res, 200, { ...day, localName });
      return;
    }

    //-- Timeshift SPTS (playlist ảo, không tsp/file tạm) -------------------------
    // GET /api/timeshift/:channel?in=&out= — in/out ISO hoặc epoch ms.
    // Chỉ SPTS: probe PAT chunk mới nhất, >1 program → 400 "dùng Trích xuất".
    if (seg[0] === 'api' && seg[1] === 'timeshift' && seg[2] !== undefined && seg[2] !== 'chunks' && seg.length === 3 && m === 'GET') {
      const channel = decodeURIComponent(seg[2]);
      const inMs = toMs(url.searchParams.get('inPoint') ?? url.searchParams.get('in'));
      const outMs = toMs(url.searchParams.get('outPoint') ?? url.searchParams.get('out'));
      if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
        return send(res, 400, { error: 'in/out phải là thời gian hợp lệ (ISO hoặc epoch ms)' });
      }
      if (!(outMs > inMs)) return send(res, 400, { error: 'Thời gian Out phải lớn hơn In' });
      if (outMs - inMs > TIMESIFT_MAX_HOURS * 3600 * 1000) {
        return send(res, 400, { error: `Xem lại tối đa ${TIMESIFT_MAX_HOURS} tiếng mỗi lần` });
      }
      const found = store
        .listSources()
        .flatMap((s) => s.channels.map((c) => ({ s, c })))
        .find((x) => x.c.name === channel);
      if (found === undefined) return send(res, 404, { error: `Kênh ${channel} không tồn tại` });
      const chunks = await exporter.resolveChunks(found.s.id, inMs, outMs);
      if (chunks.length === 0) {
        return send(res, 404, { error: 'Không có dữ liệu lưu chiểu trong khoảng đã chọn (quá retention?)' });
      }
      let programs: number[];
      try {
        const newest = [...chunks].sort().at(-1) as string;
        programs = await probeProgramCount(tspBin, join(captureDir, found.s.id, newest));
      } catch (e) {
        if (e instanceof TimeshiftError) return send(res, 502, { error: e.message });
        throw e;
      }
      if (programs.length > 1) {
        return send(res, 400, {
          error: `Luồng đa chương trình (MPTS, ${programs.length} chương trình): timeshift không hỗ trợ — dùng Trích xuất để tải file`,
        });
      }
      // Lan auth của request xuống từng segment (trình phát không kế thừa query).
      const pull = url.searchParams.get('pull');
      const token = url.searchParams.get('token') ?? '';
      const expRaw = url.searchParams.get('exp') ?? '';
      const query =
        pull !== null
          ? `pull=${pull}`
          : token !== ''
            ? `token=${token}&exp=${expRaw}`
            : (() => {
                const exp = Date.now() + 6 * 3600 * 1000;
                return `token=${signHlsToken(channel, exp)}&exp=${exp}`;
              })();
      const segs = await Promise.all(
        chunks.map(async (p) => {
          const file = p.split('/').at(-1) as string;
          const uri =
            `/api/timeshift/chunks?source=${encodeURIComponent(found.s.id)}` +
            `&file=${encodeURIComponent(file)}&channel=${encodeURIComponent(channel)}`;
          return { file: uri, mtimeMs: (await stat(p)).mtimeMs };
        }),
      );
      const body = buildTimeshiftPlaylist(segs, query);
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    // GET /api/timeshift/chunks?source=&file=&channel=&token|pull= — stream 1 chunk.
    if (seg[0] === 'api' && seg[1] === 'timeshift' && seg[2] === 'chunks' && seg.length === 3 && m === 'GET') {
      const sourceId = url.searchParams.get('source') ?? '';
      const file = url.searchParams.get('file') ?? '';
      const channel = url.searchParams.get('channel') ?? '';
      const pull = url.searchParams.get('pull');
      const authed =
        pull !== null
          ? verifyPullToken(channel, pull)
          : verifyHlsToken(channel, Number(url.searchParams.get('exp') ?? ''), url.searchParams.get('token') ?? '');
      if (!authed) return send(res, 403, { error: 'Link xem hết hạn hoặc không hợp lệ' });
      if (!/^[A-Za-z0-9_-]+$/.test(sourceId) || !/^[A-Za-z0-9_.-]+\.ts$/.test(file)) {
        return send(res, 400, { error: 'tham số không hợp lệ' });
      }
      const full = join(captureDir, sourceId, file);
      const base = join(captureDir, sourceId) + sep;
      if (!full.startsWith(base)) return send(res, 403, { error: 'Forbidden' });
      let st: { size: number; isFile: () => boolean };
      try {
        st = await stat(full);
      } catch {
        return send(res, 404, { error: 'Chunk không còn (có thể đã bị GC dọn)' });
      }
      if (!st.isFile()) return send(res, 404, { error: 'Chunk không còn' });
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': st.size, 'cache-control': 'public, max-age=60' });
      createReadStream(full).on('error', () => res.destroy()).pipe(res);
      return;
    }

    //-- Exports (đã qua gate) --------------------------------------------------
    // POST /api/exports {channelName, sourceId, serviceId, inPoint, outPoint}
    // ISO string hoặc epoch ms. Trả 200 + job ngay (async, PRD §6.C).
    if (seg[0] === 'api' && seg[1] === 'exports' && seg.length === 2) {
      if (m === 'GET') {
        send(res, 200, exporter.list());
        return;
      }
      if (m === 'POST') {
        const b = (await readJson(req)) as {
          channelName?: unknown;
          sourceId?: unknown;
          serviceId?: unknown;
          inPoint?: unknown;
          outPoint?: unknown;
        };
        try {
          const job = await exporter.submit({
            channelName: typeof b.channelName === 'string' ? b.channelName : '',
            sourceId: typeof b.sourceId === 'string' ? b.sourceId : '',
            serviceId: typeof b.serviceId === 'number' ? b.serviceId : NaN,
            inPoint: toMs(b.inPoint),
            outPoint: toMs(b.outPoint),
            createdBy: requireAuth(req) ?? 'unknown',
          });
          send(res, 200, job);
        } catch (e) {
          if (e instanceof ExportError) return send(res, 400, { error: e.message });
          throw e;
        }
        return;
      }
    }
    if (seg[0] === 'api' && seg[1] === 'exports' && seg[2] !== undefined) {
      const expId = decodeURIComponent(seg[2]);
      // GET /api/exports/:id/download — stream file (không đọc hết vào RAM).
      if (m === 'GET' && seg[3] === 'download') {
        const job = exporter.get(expId);
        if (job === undefined) return send(res, 404, { error: `Tác vụ ${expId} không tồn tại` });
        if (job.status !== 'SUCCESS') {
          return send(res, 409, { error: `Tác vụ đang ${job.status} — chưa thể tải` });
        }
        let st: { size: number; isFile: () => boolean };
        try {
          const { stat } = await import('node:fs/promises');
          st = await stat(job.filePath);
        } catch {
          return send(res, 404, { error: 'File vật lý không còn (có thể đã bị GC dọn)' });
        }
        if (!st.isFile()) return send(res, 404, { error: 'File vật lý không còn' });
        const { createReadStream } = await import('node:fs');
        res.writeHead(200, {
          'content-type': 'video/mp2t',
          'content-length': st.size,
          'content-disposition': `attachment; filename="${job.fileName}"`,
        });
        createReadStream(job.filePath).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (m === 'GET' && seg.length === 3) {
        const job = exporter.get(expId);
        if (job === undefined) return send(res, 404, { error: `Tác vụ ${expId} không tồn tại` });
        send(res, 200, job);
        return;
      }
      // DELETE /api/exports/:id — xóa file vật lý trước, record sau.
      if (m === 'DELETE' && seg.length === 3) {
        try {
          await exporter.remove(expId);
        } catch (e) {
          if (e instanceof ExportError) return send(res, 400, { error: e.message });
          throw e;
        }
        send(res, 200, { ok: true });
        return;
      }
    }

    if (seg[0] === 'api' && seg[1] === 'sources') {
      const id = seg[2] === undefined ? undefined : decodeURIComponent(seg[2]);

      if (m === 'GET' && id === undefined) {
        send(res, 200, store.listSources());
        return;
      }
      if (m === 'POST' && id === undefined) {
        const body = checkSourceBody(await readJson(req));
        try {
          generateConfText(body); // validate conf sinh được trước khi lưu (400 thay vì 500 lúc start)
        } catch (e) {
          if (e instanceof ConfigError) return send(res, 400, { error: e.message });
          throw e;
        }
        const dup = duplicateChannelName([...store.listSources(), body]);
        if (dup !== null) return send(res, 400, { error: dup });
        const mapErr = checkPartnerMapping([...store.listSources(), body]);
        if (mapErr !== null) return send(res, 400, { error: mapErr });
        const rec = store.createSource(body);
        savePersisted();
        logger.info(`tạo source ${body.id} (${body.channels.length} kênh)`);
        send(res, 201, rec);
        return;
      }
      if (id !== undefined && seg.length === 3) {
        if (m === 'GET') {
          const r = store.getSource(id);
          if (r === undefined) return send(res, 404, { error: `Source ${id} không tồn tại` });
          return send(res, 200, r);
        }
        if (m === 'PUT') {
          const cur = store.getSource(id);
          if (cur === undefined) return send(res, 404, { error: `Source ${id} không tồn tại` });
          const patch = (await readJson(req)) as Partial<SourceConfig>;
          const merged = { ...cur, ...patch, id: cur.id };
          try {
            generateConfText(merged);
          } catch (e) {
            if (e instanceof ConfigError) return send(res, 400, { error: e.message });
            throw e;
          }
          const withMerged = store.listSources().map((s) => (s.id === id ? merged : s));
          const dup = duplicateChannelName(withMerged);
          if (dup !== null) return send(res, 400, { error: dup });
          const mapErr = checkPartnerMapping(withMerged);
          if (mapErr !== null) return send(res, 400, { error: mapErr });
          // Chỉ đổi meta (retention/mapping) → không đụng conf, RUNNING cũng sửa được.
          const confKey = (s: SourceConfig): string =>
            JSON.stringify({
              input: s.input,
              recordAll: s.recordAll,
              channels: s.channels.map((c) => [c.name, c.serviceId, c.isLive]),
            });
          if (confKey(merged) === confKey(cur)) {
            const rec = store.updateMeta(id, { retentionDays: patch.retentionDays, channels: merged.channels });
            savePersisted();
            logger.info(`sửa meta source ${id} (không restart)`);
            send(res, 200, rec);
            return;
          }
          const updated = store.updateSource(id, patch);
          savePersisted();
          logger.info(`sửa source ${id} (rev ${updated.confRev})`);
          send(res, 200, updated);
          return;
        }
        if (m === 'DELETE') {
          clearPending(id); // hủy restart đã hẹn (nếu crash trước đó)
          try {
            await pm.stop(id).catch(() => {});
          } catch {
            // chưa chạy thì thôi
          }
          store.deleteSource(id);
          savePersisted();
          logger.info(`xóa source ${id}`);
          send(res, 200, { ok: true });
          return;
        }
      }
      // GET /api/sources/:id/preview-conf
      if (id !== undefined && m === 'GET' && seg[3] === 'preview-conf') {
        const r = store.getSource(id);
        if (r === undefined) return send(res, 404, { error: `Source ${id} không tồn tại` });
        const gen = generateConfText({ ...r, confRev: r.confRev });
        send(res, 200, { conf: gen.content, liveCount: gen.liveCount, confRev: r.confRev });
        return;
      }
      // POST /api/sources/:id/start
      if (id !== undefined && m === 'POST' && seg[3] === 'start') {
        const r = store.getSource(id);
        if (r === undefined) return send(res, 404, { error: `Source ${id} không tồn tại` });
        try {
          ensureSourceDirs(r);
        } catch (e) {
          if (e instanceof Error) return send(res, 500, { error: e.message });
          throw e;
        }
        const gen = writeConfFile({ ...r, confRev: r.confRev }, confDir);
        const pid = pm.start(id, gen.filePath ?? `${confDir}/${id}.conf`);
        store.setStatus(id, 'RUNNING', pid);
        savePersisted();
        logger.info(`start source ${id} (pid ${pid})`);
        send(res, 200, { ok: true, pid, conf: gen.content });
        return;
      }
      // POST /api/sources/:id/stop
      if (id !== undefined && m === 'POST' && seg[3] === 'stop') {
        noRestart.add(id); // đánh dấu stop tay để onExit không restart
        clearPending(id);
        try {
          await pm.stop(id);
        } finally {
          noRestart.delete(id);
        }
        store.setStatus(id, 'STOPPED');
        savePersisted();
        logger.info(`stop source ${id}`);
        send(res, 200, { ok: true });
        return;
      }
    }

    send(res, 404, { error: 'không tìm thấy route' });
  }

  return {
    listen: (port = opts.port ?? 0) =>
      new Promise((resolve) => {
        void seedAdmin().then(() => {
          // Nạp cấu hình đã persist (restart container không mất sources).
          const wasRunning = loadPersisted();
          if (persistEnabled) logger.info(`nạp ${store.listSources().length} sources từ ${storeFile}`);
          if (autoStartEnabled) {
            for (const sid of wasRunning) {
              const r = store.getSource(sid);
              if (r === undefined) continue;
              try {
                ensureSourceDirs(r);
                const gen = writeConfFile({ ...r, confRev: r.confRev }, confDir);
                const pid = pm.start(sid, gen.filePath ?? `${confDir}/${sid}.conf`);
                store.setStatus(sid, 'RUNNING', pid);
              } catch {
                store.setStatus(sid, 'ERROR');
              }
            }
            if (wasRunning.length > 0) savePersisted();
          }
          // GC mỗi giờ khi bật VTC_GC_ENABLE=1 (Prod). Test không bật nên không ảnh hưởng.
          let gcTimer: NodeJS.Timeout | undefined;
          if (process.env['VTC_GC_ENABLE'] === '1') {
            gcTimer = setInterval(
              () => {
                void runGarbageCollector({
                  captureDir,
                  exportsDir,
                  getRetentionDays: (id) => store.getSource(id)?.retentionDays ?? DEFAULT_RETENTION_DAYS,
                });
              },
              60 * 60 * 1000,
            );
            gcTimer.unref?.();
          }
          // Worker EPG: poll lịch đã duyệt mỗi VTC_EPG_SYNC_MINUTES (mặc định 10).
          // Thiếu API key thì bỏ qua (dev), tay vẫn gọi được POST epg-sync.
          let epgTimer: NodeJS.Timeout | undefined;
          const epgMinutes = Number(process.env['VTC_EPG_SYNC_MINUTES'] ?? 10);
          if (Number.isFinite(epgMinutes) && epgMinutes > 0 && epgClient.configured) {
            epgTimer = setInterval(
              () => {
                void runEpgSync().catch((e: unknown) => {
                  logger.warn(`epg-sync định kỳ thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
                });
              },
              epgMinutes * 60 * 1000,
            );
            epgTimer.unref?.();
          } else if (!epgClient.configured) {
            logger.warn('chưa cấu hình VTC_EPG_API_KEY — worker EPG nghỉ, đồng bộ tay ở /admin/epg-sync');
          }
          // Watchdog HLS 30s (PRD rủi ro #4): playlist đứng >15s dù process RUNNING
          // → restart source chứa kênh stale + bắn Telegram. Cooldown 5'/source.
          // Test xong trước tick đầu (30s) nên không ảnh hưởng; tắt hẳn bằng VTC_HLS_WATCHDOG=0.
          let watchdogTimer: NodeJS.Timeout | undefined;
          const lastWatchdogRestart = new Map<string, number>();
          const watchdogEnabled = process.env['VTC_HLS_WATCHDOG'] !== '0';
          async function watchdogTick(): Promise<void> {
            let health: Awaited<ReturnType<typeof checkHlsHealth>>;
            try {
              health = await checkHlsHealth(liveDir, 15);
            } catch {
              return;
            }
            const staleChannels = new Set(health.filter((h) => h.stale).map((h) => h.channel));
            if (staleChannels.size === 0) return;
            const now = Date.now();
            const targets = store
              .listSources()
              .filter((s) => s.status === 'RUNNING' && s.channels.some((c) => staleChannels.has(c.name)));
            for (const t of targets) {
              const last = lastWatchdogRestart.get(t.id) ?? 0;
              if (now - last < 5 * 60 * 1000) continue;
              lastWatchdogRestart.set(t.id, now);
              const staleHere = t.channels.filter((c) => staleChannels.has(c.name)).map((c) => c.name);
              void notifier.alert(
                `hls:${t.id}`,
                processAlertText(
                  t.id,
                  `HLS stale (${staleHere.join(', ')}) — playlist đứng >15s`,
                  'Đang restart source để phục hồi live...',
                ),
              );
              noRestart.add(t.id);
              clearPending(t.id);
              try {
                await pm.stop(t.id).catch(() => {});
              } finally {
                noRestart.delete(t.id);
              }
              const cur = store.getSource(t.id);
              if (cur === undefined) continue;
              try {
                ensureSourceDirs(cur);
                const gen = writeConfFile({ ...cur, confRev: cur.confRev }, confDir);
                const pid = pm.start(t.id, gen.filePath ?? `${confDir}/${t.id}.conf`);
                store.setStatus(t.id, 'RUNNING', pid);
              } catch {
                store.setStatus(t.id, 'ERROR');
              }
              savePersisted();
            }
          }
          if (watchdogEnabled) {
            watchdogTimer = setInterval(() => void watchdogTick(), 30 * 1000);
            watchdogTimer.unref?.();
          }
          server.listen(port, () => {
            const addr = server.address();
            const p = typeof addr === 'object' && addr !== null ? addr.port : port;
            resolve({
              port: p,
              close: () =>
                new Promise<void>((r) => {
                  clearInterval(gcTimer);
                  clearInterval(epgTimer);
                  clearInterval(watchdogTimer);
                  for (const t of pendingRestarts.values()) clearTimeout(t);
                  pendingRestarts.clear();
                  server.close(() => r());
                }),
            });
          });
        });
      }),
  };
}
