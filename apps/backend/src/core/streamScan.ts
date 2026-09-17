//=============================================================================
// streamScan.ts — Quét luồng multicast/file liệt kê chương trình (PAT + SDT).
// Chạy 1 tiến trình tsp TẠM (~6s) rồi tắt — CPU/IO lúc nghỉ bằng 0, chỉ tốn
// đúng lúc bấm "Quét luồng" ở UI. Không parse liên tục, không join multicast
// thường trực.
// Lệnh: tsp -I <input...> -P tables --pid 0 -P tables --pid 0x11 -P until
//   --seconds 6 -O drop   (PAT cho SID, SDT cho tên kênh)
//=============================================================================
import { spawn } from 'node:child_process';
import { parsePatPrograms } from '../timeshift/timeshift.js';

export class StreamScanError extends Error {}

export interface ScannedProgram {
  serviceId: number;
  /** Tên từ SDT (service_name), null khi luồng không phát SDT/tên. */
  name: string | null;
}

/**
 * Trích SID từ PAT (dòng "Program: N") + tên từ SDT (khối "Service: N" kèm
 * dòng service_name: "..."). SDT của TSDuck in text dạng:
 *   - Service: 807 (0x0327), ...
 *       service_name: "VTV1"
 * Tên là best-effort (có luồng không phát SDT) — caller dùng fallback.
 * PAT program 0 là con trỏ NIT, không phải kênh xem được → loại.
 */
export function parseScanPrograms(output: string): ScannedProgram[] {
  const names = new Map<number, string>();
  let current: number | null = null;
  for (const line of output.split('\n')) {
    const s = /^\s*-\s*Service:\s*(\d+)\s*\(0x[0-9a-fA-F]+\)/.exec(line);
    if (s !== null) {
      const id = Number(s[1]);
      current = Number.isInteger(id) && id >= 1 && id <= 65535 ? id : null;
      continue;
    }
    const n = /service_name:\s*"([^"]+)"/.exec(line);
    if (n !== null && current !== null && !names.has(current)) {
      names.set(current, n[1] ?? '');
    }
  }
  const ids = new Set<number>();
  for (const id of parsePatPrograms(output)) {
    if (id >= 1 && id <= 65535) ids.add(id);
  }
  for (const id of names.keys()) ids.add(id);
  return [...ids]
    .sort((a, b) => a - b)
    .map((serviceId) => ({ serviceId, name: names.get(serviceId) ?? null }));
}

/**
 * Quét 1 input (đã tách argv, chưa gồm -I) trong tối đa timeoutMs.
 * `until --seconds` cho tsp tự thoát 0 sau khi hứng đủ bảng; resolve mảng
 * (có thể rỗng = không thấy chương trình nào).
 * @throws StreamScanError khi tsp lỗi/thoát khác 0/timeout (không có tín hiệu?).
 */
export async function scanStream(
  tspBin: string,
  inputArgs: string[],
  ifaceArgs: string[],
  timeoutMs = 12000,
): Promise<ScannedProgram[]> {
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
      reject(new StreamScanError(msg));
    };
    const child = spawn(
      tspBin,
      [
        '-I',
        ...inputArgs,
        ...ifaceArgs,
        '-P',
        'tables',
        '--pid',
        '0',
        '-P',
        'tables',
        '--pid',
        '0x11',
        '-P',
        'until',
        '--seconds',
        '6',
        '-O',
        'drop',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => fail(`quét luồng quá ${timeoutMs / 1000}s (không có tín hiệu?)`), timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf8');
      if (out.length > 512_000) out = out.slice(-512_000);
    });
    child.stderr?.on('data', () => {}); // drain chống đầy pipe
    child.on('error', () => fail('không khởi chạy được tsp để quét luồng'));
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) return fail('tsp quét thất bại (input sai hoặc không có tín hiệu)');
      resolve(parseScanPrograms(out));
    });
  });
}
