//=============================================================================
// ConfigGenerator.ts — Sinh tsp .conf theo Source (MPTS), đúng PRD §3.1.
// Logic PORT 1-1 từ scripts/gen-conf.sh để shell và Node không lệch nhau.
//
// ĐỊNH DẠNG FILE (bài học 15/09/2026, đo trên TSDuck 3.44 thật):
// `@file` của TSDuck KHÔNG tách khoảng trắng kiểu shell — mỗi DÒNG là 1 argv.
// Ghi `-I ip ...` chung dòng là tsp nhai từng ký tự ("unknown option -2...").
// Vì vậy: mỗi argument 1 dòng, KHÔNG comment (# chưa kiểm chứng, không liều),
// KHÔNG dấu ngoặc kép (chuỗi fork là 1 dòng = 1 argv, tương đương shell quote).
//
// Công thức (mỗi dòng 1 arg):
//   -I / <input...> / -P / vtcmonitor / [-P / fork / "<tsp...>" ]... / -O / hls|drop ...
//
// Nguyên tắc vàng (bài học 19k Zombie):
//  - KHÔNG bao giờ sinh --max-duration. Cắt chunk = -O hls --live 0.
//  - Mỗi Source đúng 1 file .conf = 1 process `tsp @file` 24/7.
//=============================================================================

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GeneratedConf, SourceConfig, SourceInputKind } from './types.js';
import { loopbackForkLine, envNonEmpty } from './TranscodeConfigGenerator.js';

/** Thư mục mặc định chứa .conf (Prod: /opt/vtc/conf/sources). */
export const DEFAULT_CONF_DIR = envNonEmpty('VTC_CONF_DIR', 'storage/conf');

/** RAMDisk HLS live (Prod: /media/ramdisk/live). */
export const LIVE_BASE = envNonEmpty('VTC_LIVE_DIR', '/media/ramdisk/live');

/** HDD catchup (Prod: /mnt/Data/catchup/captures). */
export const CAPTURE_BASE = envNonEmpty('VTC_CAPTURE_DIR', '/mnt/Data/catchup/captures');

export class ConfigError extends Error {}

/** Chuẩn hóa loại đầu vào (DB cũ thiếu → ip; lạ → ném để lộ cấu hình hỏng). */
export function normalizeInputKind(k: SourceConfig['inputKind']): SourceInputKind {
  if (k === undefined) return 'ip';
  if (k === 'ip' || k === 'sdi' || k === 'hdmi') return k;
  throw new ConfigError(`inputKind "${k}" không hợp lệ (ip|sdi|hdmi)`);
}

/** Kiểm tra 1 channel, ném ConfigError nếu sai. */
function assertChannel(c: SourceConfig['channels'][number], index: number): void {
  if (!/^[A-Za-z0-9_-]+$/.test(c.name)) {
    throw new ConfigError(`channel[${index}].name "${c.name}" chỉ cho [A-Za-z0-9_-] (tránh tách fork sai)`);
  }
  // SID 0 đặt trước cho NIT — zap 0 là vô nghĩa, tsp thoát ngay.
  if (!Number.isInteger(c.serviceId) || c.serviceId < 1 || c.serviceId > 65535) {
    throw new ConfigError(`channel[${index}] serviceId phải 1..65535 (0 đặt trước cho NIT)`);
  }
}

/**
 * Card multicast mặc định cho MỌI input `ip` (VD eth0 172.37.0.200).
 * Đặt VTC_MULTICAST_IFACE 1 lần là mọi nguồn tự join đúng card — khỏi sửa
 * từng nguồn, nguồn cũ Start lại là ăn theo (conf sinh lại mỗi lần Start).
 * Input nào đã ghi --local-address thì giữ nguyên (explicit thắng).
 */
export function defaultIfaceArgs(input: string): string[] {
  if (input.trim().split(/\s+/)[0] !== 'ip' || input.includes('--local-address')) return [];
  const iface = (process.env['VTC_MULTICAST_IFACE'] ?? '').trim();
  return iface === '' ? [] : ['--local-address', iface];
}

/**
 * Tách input ("ip 239.1.1.1:5000 --local-address 192.168.1.2") thành argv,
 * tôn trọng ngoặc kép (đường dẫn có dấu cách). KHÔNG qua shell nên không lo
 * injection — nhưng cũng vì thế mà calorie nào cũng phải tách ở đây.
 */
export function splitInputArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  const push = (): void => {
    if (cur !== '') {
      const m = /^"(.*)"$/.exec(cur) ?? /^'(.*)'$/.exec(cur);
      out.push(m !== null ? (m[1] ?? '') : cur);
      cur = '';
    }
  };
  for (const ch of input.trim()) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return out.filter((s) => s !== '');
}

/**
 * Sinh nội dung .conf từ SourceConfig (thuần túy, không chạm đĩa).
 * @throws ConfigError khi cấu hình vô nghĩa (0 live + recordAll=false).
 */
export function generateConfText(source: SourceConfig): GeneratedConf {
  if (!/^[A-Za-z0-9_-]+$/.test(source.id)) {
    throw new ConfigError(`source.id "${source.id}" chỉ cho [A-Za-z0-9_-]`);
  }
  // Encode (SDI/HDMI baseband) vs Transcode (IP) — chốt kiến trúc docs/16 §18:
  // model đã có từ bây giờ, ingest baseband triển khai phase sau (cần card
  // capture + driver). Chặn rõ ở đây để không sinh conf nửa vời.
  const kind = normalizeInputKind(source.inputKind);
  // Điểm trích Live/GHI (docs/16 §0, §18): ip khóa ingest ở Phase 1
  // (toggle "sau transcode" chưa mở); Encode bắt buộc encoded.
  const from = source.liveCatchupFrom ?? 'ingest';
  if (from !== 'ingest' && from !== 'encoded') {
    throw new ConfigError(`source ${source.id}: liveCatchupFrom "${from}" không hợp lệ (ingest|encoded)`);
  }
  if (kind === 'ip' && from === 'encoded') {
    throw new ConfigError(
      `source ${source.id}: liveCatchupFrom=encoded (sau transcode) khóa ở Phase 1 — GHI + Live IP đi đường gốc (xem docs/16 §0)`,
    );
  }
  if (kind === 'sdi' || kind === 'hdmi') {
    // Encode: baseband qua capture agent → UDP localhost, tsp ingest UDP đó.
    // Ép 2 điều kiện để khỏi cấu hình nửa vời: sau-encode + input là UDP agent.
    if (from !== 'encoded') {
      throw new ConfigError(
        `source ${source.id}: nguồn ${kind.toUpperCase()} bắt buộc liveCatchupFrom=encoded (baseband raw không ra HLS/GHI trực tiếp được)`,
      );
    }
    const parts = splitInputArgs(source.input);
    const m = parts.length >= 2 && parts[0] === 'ip' ? /^127\.0\.0\.1:(62\d\d)$/.exec(parts[1] ?? '') : null;
    const port = m !== null ? Number.parseInt(m[1] ?? '', 10) : NaN;
    if (!Number.isInteger(port) || port < 6200 || port > 6299) {
      throw new ConfigError(
        `source ${source.id}: input nguồn ${kind.toUpperCase()} phải là UDP của capture agent (VD "ip 127.0.0.1:6201", cổng 6200..6299) — ` +
          `card capture do agent đọc, tsp chỉ ingest UDP (xem docs/16 §18)`,
      );
    }
  }
  if (source.input.trim() === '') {
    throw new ConfigError('source.input rỗng');
  }
  // Bẫy thường gặp: copy link VLC (udp://@239.1.1.1:5000) vào ô input.
  // TSDuck cần TÊN PLUGIN + tham số ("ip 239.1.1.1:5000"), không ăn URL.
  if (source.input.includes('://')) {
    throw new ConfigError(
      `source.input "${source.input}" trông như URL (kiểu copy từ VLC). ` +
        `TSDuck cần tên plugin + tham số, VD "ip 239.1.1.1:5000" (bỏ "udp://" và "@").`,
    );
  }
  source.channels.forEach(assertChannel);

  const live = source.channels.filter((c) => c.isLive);
  const tcOnly = source.channels.filter((c) => !c.isLive && c.transcode?.enabled === true);
  if (live.length === 0 && !source.recordAll && tcOnly.length === 0) {
    // Conf chỉ còn `-O drop` là vô nghĩa, tốn CPU — chặn từ lúc sinh (như gen-conf.sh).
    // Kênh transcode-only (tắt live, chỉ đẩy SRT) vẫn có nghĩa nên được qua.
    throw new ConfigError(
      `Source ${source.id} vô nghĩa: 0 kênh live + recordAll=false + không kênh transcode (chỉ còn -O drop)`,
    );
  }

  // Mỗi dòng = 1 argv (xem đầu file). Không comment, không ngoặc kép.
  const args: string[] = ['-I', ...splitInputArgs(source.input), ...defaultIfaceArgs(source.input), '-P', 'vtcmonitor'];
  for (const c of live) {
    // Mỗi kênh live = 1 nhánh fork HLS 5s trên RAMDisk (tmpfs ở Prod).
    // Chuỗi lệnh fork là 1 dòng = 1 argv (tương đương shell "..." nhưng không quote).
    args.push(
      '-P',
      'fork',
      `tsp -P zap ${c.serviceId} -O hls --duration 5 --live 5 ` +
        `--playlist ${LIVE_BASE}/${c.name}/index.m3u8 ${LIVE_BASE}/${c.name}/segment.ts`,
    );
  }
  // Transcode (docs/16 §2): kênh nào bật transcode thì thêm 1 fork SPTS ra
  // UDP loopback cho ffmpeg đọc (điểm cách ly — ffmpeg KHÔNG đọc multicast
  // trực tiếp để giữ giám sát CC-error ở tầng ingest).
  // Kể cả kênh tắt Live (transcode-only, chỉ đẩy SRT): không fork là ffmpeg
  // đói input mà không báo gì — bẫy im lặng, đã vá ở đây.
  // Phương án B (mặc định): chỉ sinh khi enabled. Phương án A (luôn sinh
  // sẵn cho mọi kênh live) chốt ở T2 — xem docs/16 §2.3.
  for (const c of source.channels) {
    if (c.transcode?.enabled === true) {
      args.push('-P', 'fork', loopbackForkLine(c.serviceId, c.transcode.loopbackPort));
    }
  }
  if (source.recordAll) {
    // Lưu chiểu: KHÔNG truyền --live (mặc định VoD = giữ toàn bộ segment).
    // --live N là live stream và TSDuck TỰ XÓA segment cũ — ngược với lưu chiểu.
    // --live 0 bị cấm từ 3.44 ("must be >= 1"). Template KHÔNG phải printf:
    // TSDuck tự đánh số (catchup-000000.ts, ...); exporter đọc theo mtime.
    args.push('-O', 'hls', '--duration', '60', `${CAPTURE_BASE}/${source.id}/catchup.ts`);
  } else {
    args.push('-O', 'drop');
  }
  return { content: args.join('\n') + '\n', liveCount: live.length };
}

/**
 * Sinh + ghi file `storage/conf/<id>.conf`. Trả về nội dung + đường dẫn.
 * @param confDir thư mục chứa conf (mặc định storage/conf hoặc VTC_CONF_DIR).
 */
export function writeConfFile(source: SourceConfig, confDir: string = DEFAULT_CONF_DIR): GeneratedConf {
  const gen = generateConfText(source);
  const filePath = join(confDir, `${source.id}.conf`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, gen.content, 'utf8');
  return { ...gen, filePath };
}
