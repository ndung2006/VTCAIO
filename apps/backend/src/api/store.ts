//=============================================================================
// store.ts — Lưu trữ in-memory cho Phase 2a (thay bằng Prisma+Postgres ở Phase 2b).
// Giữ API nhỏ, rõ ràng để thay store sau này không phải sửa server.ts.
//=============================================================================

import type { SourceConfig } from '../core/types.js';
import { normalizeChannelTranscode, normalizeSourcePuller } from '../core/TranscodeConfigGenerator.js';
import type { UserRecord } from './auth.js';

/** Bản ghi Source kèm rev + trạng thái (DB thật sẽ thêm pid, createdAt...). */
export interface SourceRecord extends SourceConfig {
  confRev: number;
  status: 'RUNNING' | 'STOPPED' | 'ERROR';
  pid?: number;
}

export class Store {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly users = new Map<string, UserRecord>();

  listSources(): SourceRecord[] {
    return [...this.sources.values()];
  }

  getSource(id: string): SourceRecord | undefined {
    return this.sources.get(id);
  }

  /** Tạo mới (id duy nhất). confRev bắt đầu từ 1. */
  createSource(s: SourceConfig): SourceRecord {
    if (this.sources.has(s.id)) {
      throw new Error(`Source ${s.id} đã tồn tại`);
    }
    const rec: SourceRecord = { ...s, confRev: 1, status: 'STOPPED' };
    this.sources.set(s.id, rec);
    return rec;
  }

  /** Sửa cấu hình (đổi input/channels/recordAll) → tăng confRev. */
  updateSource(id: string, patch: Partial<SourceConfig>): SourceRecord {
    const cur = this.sources.get(id);
    if (cur === undefined) throw new Error(`Source ${id} không tồn tại`);
    if (cur.status === 'RUNNING') {
      throw new Error(`Source ${id} đang RUNNING — stop trước khi sửa (cần restart graceful)`);
    }
    const next: SourceRecord = {
      ...cur,
      ...patch,
      id: cur.id, // không cho đổi id
      confRev: cur.confRev + 1,
      status: 'STOPPED' as const,
    };
    this.sources.set(id, next);
    return next;
  }

  /**
   * Sửa meta KHÔNG ảnh hưởng conf (retentionDays, partnerChannelId): giữ nguyên
   * confRev/status/pid, chạy được cả khi RUNNING mà không đụng tiến trình.
   * Đổi input/recordAll/tên/SID/live vẫn phải đi updateSource (đòi STOPPED).
   */
  updateMeta(
    id: string,
    patch: { retentionDays?: number | undefined; channels?: SourceConfig['channels']; puller?: SourceConfig['puller'] },
  ): SourceRecord {
    const cur = this.sources.get(id);
    if (cur === undefined) throw new Error(`Source ${id} không tồn tại`);
    const clean: { retentionDays?: number | undefined; channels?: SourceConfig['channels']; puller?: SourceConfig['puller'] } = {};
    if (patch.retentionDays !== undefined) clean.retentionDays = patch.retentionDays;
    if (patch.channels !== undefined) clean.channels = patch.channels;
    if (patch.puller !== undefined) clean.puller = normalizeSourcePuller(patch.puller);
    const next: SourceRecord = { ...cur, ...clean, id: cur.id };
    this.sources.set(id, next);
    return next;
  }

  deleteSource(id: string): void {
    const cur = this.sources.get(id);
    if (cur === undefined) throw new Error(`Source ${id} không tồn tại`);
    if (cur.status === 'RUNNING') {
      throw new Error(`Source ${id} đang RUNNING — stop trước khi xóa`);
    }
    this.sources.delete(id);
  }

  /**
   * Thay toàn bộ danh sách (dùng cho config-restore).
   * Ném lỗi nếu bất kỳ source nào đang RUNNING (kể cả trong store lẫn bản mới).
   */
  replaceAll(records: SourceConfig[]): void {
    for (const s of this.sources.values()) {
      if (s.status === 'RUNNING') {
        throw new Error(`Source ${s.id} đang RUNNING — stop hết trước khi phục hồi cấu hình`);
      }
    }
    const next = new Map<string, SourceRecord>();
    for (const s of records) {
      if (next.has(s.id)) throw new Error(`trùng id ${s.id} trong file phục hồi`);
      next.set(s.id, { ...s, confRev: 1, status: 'STOPPED' });
    }
    this.sources.clear();
    for (const [k, v] of next) this.sources.set(k, v);
  }

  setStatus(id: string, status: SourceRecord['status'], pid?: number): void {
    const cur = this.sources.get(id);
    if (cur === undefined) return;
    cur.status = status;
    if (pid === undefined) {
      delete cur.pid;
    } else {
      cur.pid = pid;
    }
  }

  /** Khôi phục bản ghi đã persist (dùng lúc boot, ghi đè nếu trùng id). */
  restore(rec: SourceRecord): void {
    const norm: SourceRecord = {
      ...rec,
      confRev: typeof rec.confRev === 'number' && rec.confRev >= 1 ? Math.floor(rec.confRev) : 1,
      status: rec.status === 'RUNNING' || rec.status === 'STOPPED' || rec.status === 'ERROR' ? rec.status : 'STOPPED',
    };
    // Migration DB cũ (docs/16 §12): channel thiếu field transcode mới thì
    // điền default (không transcode), không được crash lúc boot.
    if (Array.isArray(norm.channels)) {
      for (const c of norm.channels) {
        const t = normalizeChannelTranscode(c.transcode);
        if (t === undefined) {
          delete c.transcode;
        } else {
          c.transcode = t;
        }
      }
    }
    // Puller RTMP (docs/16 §5): sai/thiếu → undefined = nguồn trực tiếp.
    const p = normalizeSourcePuller(norm.puller);
    if (p === undefined) {
      delete norm.puller;
    } else {
      norm.puller = p;
    }
    if (norm.status === 'RUNNING') {
      // PID cũ đã chết theo container — hạ về STOPPED, boot sẽ auto-start lại.
      norm.status = 'STOPPED';
      delete norm.pid;
    }
    this.sources.set(norm.id, norm);
  }

  //-- Users (bảng users ở Phase 2b) -----------------------------------------

  /** Seed user (dùng lúc boot server). Ghi đè nếu username đã có. */
  seedUser(u: UserRecord): void {
    this.users.set(u.username, { ...u });
  }

  /** Tạo user mới (admin gọi qua API). */
  createUser(u: UserRecord): UserRecord {
    if (this.users.has(u.username)) throw new Error(`Người dùng ${u.username} đã tồn tại`);
    for (const x of this.users.values()) {
      if (x.email.toLowerCase() === u.email.toLowerCase()) throw new Error(`Email ${u.email} đã dùng`);
    }
    this.users.set(u.username, { ...u });
    return u;
  }

  /** Xóa user (cấm tự xóa chính mình — check ở API vì cần biết ai đang gọi). */
  deleteUser(username: string): void {
    if (!this.users.delete(username)) throw new Error(`Người dùng ${username} không tồn tại`);
  }

  /** Danh sách công khai (KHÔNG hash/token) cho trang quản trị. */
  listPublicUsers(): { username: string; email: string; role: string; allowedChannels: string[] }[] {
    return [...this.users.values()].map((u) => ({
      username: u.username,
      email: u.email,
      role: u.role,
      allowedChannels: u.allowedChannels ?? [],
    }));
  }

  /** Gán kênh cho nhân sự (ghi đè danh sách). */
  setAllowedChannels(username: string, channels: string[]): void {
    const u = this.users.get(username);
    if (u === undefined) throw new Error(`Người dùng ${username} không tồn tại`);
    u.allowedChannels = [...channels];
  }

  findUser(username: string): UserRecord | undefined {
    return this.users.get(username);
  }

  findUserByEmail(email: string): UserRecord | undefined {
    const want = email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === want) return u;
    }
    return undefined;
  }

  findUserByResetToken(token: string): UserRecord | undefined {
    for (const u of this.users.values()) {
      if (u.resetToken === token && (u.resetExpires ?? 0) > Date.now()) return u;
    }
    return undefined;
  }

  setResetToken(username: string, token: string, expires: number): void {
    const u = this.users.get(username);
    if (u === undefined) return;
    u.resetToken = token;
    u.resetExpires = expires;
  }

  setPasswordHash(username: string, hash: string): void {
    const u = this.users.get(username);
    if (u === undefined) return;
    u.passwordHash = hash;
    delete u.resetToken;
    delete u.resetExpires;
  }
}
