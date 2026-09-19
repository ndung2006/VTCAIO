//=============================================================================
// logger.ts — Logger nhẹ zero-dep cho backend 24/7.
// Ghi đồng thời ra stdout (Coolify xem log) + file vtc.log trong VTC_LOG_DIR
// (mặc định storage/logs). Xoay file theo dung lượng: vtc.log → vtc.log.1…
// (giữ VTC_LOG_KEEP file, mặc định 5, mỗi file VTC_LOG_MAX_BYTES, mặc định 5MB).
// Dùng: logger.info/warn/error(msg). Test gọi setLogDir() để isolation.
//=============================================================================
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { envNonEmpty } from './TranscodeConfigGenerator.js';

let logDirOverride: string | undefined;

export function setLogDir(dir: string | undefined): void {
  logDirOverride = dir;
}

export function getLogDir(): string {
  return logDirOverride ?? envNonEmpty('VTC_LOG_DIR', 'storage/logs');
}

function maxBytes(): number {
  const v = Number(process.env['VTC_LOG_MAX_BYTES'] ?? 5 * 1024 * 1024);
  return Number.isFinite(v) && v > 0 ? v : 5 * 1024 * 1024;
}

function keepFiles(): number {
  const v = Number(process.env['VTC_LOG_KEEP'] ?? 5);
  return Number.isInteger(v) && v >= 1 && v <= 20 ? v : 5;
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < maxBytes()) return;
    const keep = keepFiles();
    for (let i = keep - 1; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          // file log đang bị khóa — bỏ qua vòng xoay này
        }
      }
    }
  } catch {
    // logger không bao giờ ném lỗi ra nghiệp vụ
  }
}

function write(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const t = new Date().toISOString();
  const line = `[${t}][${level}] ${msg}\n`;
  if (level === 'ERROR') {
    // eslint-disable-next-line no-console
    console.error(line.trimEnd());
  } else if (level === 'WARN') {
    // eslint-disable-next-line no-console
    console.warn(line.trimEnd());
  } else {
    // eslint-disable-next-line no-console
    console.log(line.trimEnd());
  }
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'vtc.log');
    rotateIfNeeded(file);
    appendFileSync(file, line, 'utf8');
  } catch {
    // stdout đã ghi — bỏ qua lỗi file
  }
}

export const logger = {
  info: (msg: string): void => write('INFO', msg),
  warn: (msg: string): void => write('WARN', msg),
  error: (msg: string): void => write('ERROR', msg),
};
