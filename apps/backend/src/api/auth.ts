//=============================================================================
// auth.ts — Xác thực JWT + bcrypt cho VTCCatchup (PRD §4.8).
//  - Mật khẩu: bcrypt hash, saltRounds = 10. KHÔNG bao giờ lưu plaintext.
//  - Token: JWT HS256 trong HttpOnly Cookie (chống XSS), không localStorage.
//  - Quên MK: message chung chung (chống enumerate email), reset token TTL 15'.
//=============================================================================
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

/** Tên cookie chứa JWT (Frontend middleware.ts cũng đọc tên này ở Phase 4). */
export const JWT_COOKIE = 'vtc_token';
/** Salt rounds bcrypt — đúng PRD. */
export const SALT_ROUNDS = 10;
/** Reset token hiệu lực 15 phút. */
export const RESET_TTL_MS = 15 * 60 * 1000;

export interface JwtPayload {
  sub: string; // username
  role: string;
}

export interface UserRecord {
  username: string;
  email: string;
  passwordHash: string;
  role: string;
  /** Kênh được gán cho nhân sự (role user). undefined/[] = không kênh nào. */
  allowedChannels?: string[];
  resetToken?: string;
  resetExpires?: number; // epoch ms
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, SALT_ROUNDS);
}

export async function checkPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function signToken(u: Pick<UserRecord, 'username' | 'role'>, secret: string): string {
  return jwt.sign({ sub: u.username, role: u.role }, secret, { expiresIn: '7d' });
}

export function verifyToken(token: string, secret: string): JwtPayload {
  const p = jwt.verify(token, secret) as JwtPayload;
  if (typeof p.sub !== 'string') throw new Error('token thiếu sub');
  return p;
}

/** Reset token ngẫu nhiên 256-bit, hex. */
export function newResetToken(): string {
  return randomBytes(32).toString('hex');
}

/** Parse header Cookie thành map (không dùng lib ngoài). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k !== '') out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Header Set-Cookie cho JWT (HttpOnly bắt buộc; Secure khi VTC_COOKIE_SECURE=1). */
export function jwtSetCookie(token: string): string {
  const maxAge = 7 * 24 * 3600; // 7 ngày, khớp JWT expiresIn
  const secure = process.env['VTC_COOKIE_SECURE'] === '1' ? '; Secure' : '';
  return `${JWT_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

/** Header xóa cookie (logout). */
export function jwtClearCookie(): string {
  return `${JWT_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;
}
