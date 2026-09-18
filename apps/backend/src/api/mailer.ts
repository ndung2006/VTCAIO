//=============================================================================
// mailer.ts — Gửi mail khôi phục mật khẩu qua SMTP (Nodemailer).
// Chưa cấu hình VTC_SMTP_HOST → trả 'logged' (giữ hành vi cũ: log link).
// Cấu hình: VTC_SMTP_HOST/PORT/USER/PASS/FROM, VTC_PUBLIC_BASE_URL.
// Không bao giờ ném lỗi — forgot-password luôn trả message chung.
//=============================================================================
import { logger } from '../core/logger.js';

export type MailResult = 'sent' | 'logged' | 'error';

export function resetLink(token: string): string {
  const base = (process.env['VTC_PUBLIC_BASE_URL'] ?? 'https://catchup.vtctech.xyz').replace(/\/$/, '');
  return `${base}/reset-password?token=${token}`;
}

export function smtpConfigured(): boolean {
  return (process.env['VTC_SMTP_HOST'] ?? '') !== '';
}

export async function sendResetMail(email: string, token: string): Promise<MailResult> {
  const link = resetLink(token);
  if (!smtpConfigured()) {
    logger.info(`reset link cho ${email}: ${link}`);
    return 'logged';
  }
  try {
    const { default: nodemailer } = await import('nodemailer');
    const port = Number(process.env['VTC_SMTP_PORT'] ?? 587);
    const transporter = nodemailer.createTransport({
      host: process.env['VTC_SMTP_HOST'],
      port: Number.isFinite(port) ? port : 587,
      secure: (process.env['VTC_SMTP_SECURE'] ?? '') === '1',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      auth:
        process.env['VTC_SMTP_USER'] !== undefined
          ? { user: process.env['VTC_SMTP_USER'], pass: process.env['VTC_SMTP_PASS'] ?? '' }
          : undefined,
    });
    await transporter.sendMail({
      from: process.env['VTC_SMTP_FROM'] ?? 'VTCAIO <no-reply@vtctech.xyz>',
      to: email,
      subject: 'Khôi phục mật khẩu VTCAIO',
      text: `Link khôi phục (hiệu lực 15 phút, dùng 1 lần):\n${link}`,
    });
    logger.info(`đã gửi mail reset cho ${email}`);
    return 'sent';
  } catch (e) {
    logger.warn(`gửi mail reset cho ${email} thất bại: ${e instanceof Error ? e.message : 'lỗi không rõ'}`);
    return 'error';
  }
}
