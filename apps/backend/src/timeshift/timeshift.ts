//=============================================================================
// timeshift.ts — Xem lại theo EPG cho luồng SPTS (playlist ảo, không tsp).
// Ranh giới sản phẩm: chunk SPTS phát trực tiếp được; chunk MPTS (đa chương
// trình) thì KHÔNG — báo thẳng "chỉ hỗ trợ Trích xuất", không cố phát bừa.
// Phân biệt bằng PAT thật (probe tsp), không tin cấu hình.
//=============================================================================
import { spawn } from 'node:child_process';

export class TimeshiftError extends Error {}

/** Trích program_number từ output `tsp -P tables --pid 0` (dòng "Program: N"). */
export function parsePatPrograms(output: string): number[] {
  const ids = new Set<number>();
  for (const m of output.matchAll(/Program:\s+(\d+)/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

/**
 * Đếm chương trình trong chunk mới nhất của 1 source (đọc PAT thật).
 * @throws TimeshiftError khi không chunk / tsp lỗi / timeout / không PAT.
 */
export async function probeProgramCount(
  tspBin: string,
  chunkPath: string,
  timeoutMs = 15000,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (msg: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* đã chết */
      }
      reject(new TimeshiftError(msg));
    };
    const child = spawn(tspBin, ['-I', 'file', chunkPath, '-P', 'tables', '--pid', '0', '-O', 'drop'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => fail(`đọc PAT quá ${timeoutMs / 1000}s`), timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.length > 256_000) out = out.slice(-256_000);
    });
    child.stderr?.on('data', () => {}); // drain chống đầy pipe
    child.on('error', () => fail('không khởi chạy được tsp để đọc PAT'));
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) return fail('tsp đọc PAT thất bại (file chunk hỏng?)');
      const ids = parsePatPrograms(out);
      if (ids.length === 0) return fail('không thấy PAT/program trong chunk');
      resolve(ids);
    });
  });
}

export interface TimeshiftSegment {
  /** URI segment (tên file trần hoặc URL endpoint đầy đủ). */
  file: string;
  mtimeMs: number;
}

/**
 * Dựng m3u8 ảo trong RAM từ chunk SPTS (không tsp, không file tạm).
 * - MEDIA-SEQUENCE lấy từ số chunk (catchup-NNNNNN.ts), thiếu thì đếm tiếp.
 * - Khoảng trống > 1.5 chunk giữa 2 file (restart/gap) → DISCONTINUITY.
 * - Khoảng quá khứ đóng → ENDLIST (player hiện seekbar tua được).
 */
export function buildTimeshiftPlaylist(
  segments: TimeshiftSegment[],
  query: string,
  chunkMs = 60000,
): string {
  if (segments.length === 0) throw new TimeshiftError('không có chunk trong khoảng đã chọn');
  const sorted = [...segments].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const seqOf = (file: string, fallback: number): number => {
    // Số chunk trong tên file (kể cả khi là URL endpoint ...file=catchup-12.ts&...).
    const n = Number(/(\d+)\.ts(\?|&|$)/.exec(file)?.[1]);
    return Number.isFinite(n) ? n : fallback;
  };
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.round(chunkMs / 1000)}`];
  const first = sorted[0];
  if (first === undefined) throw new TimeshiftError('không có chunk trong khoảng đã chọn');
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${seqOf(first.file, 0)}`);
  let prev: TimeshiftSegment | null = null;
  for (const s of sorted) {
    if (prev !== null && s.mtimeMs - prev.mtimeMs > chunkMs * 1.5) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXTINF:${(chunkMs / 1000).toFixed(1)},`);
    lines.push(`${s.file}${s.file.includes('?') ? '&' : '?'}${query}`);
    prev = s;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
