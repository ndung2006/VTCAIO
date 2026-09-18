//=============================================================================
// TranscodeConfigGenerator.ts — Dịch preset + output thành argv ffmpeg.
// Thuần túy (không spawn, không chạm đĩa) để unit test không cần ffmpeg thật.
//
// Mô hình (docs/16 §1–§3): 1 ffmpeg / 1 kênh, decode 1 lần, encode N lần.
//   ffmpeg -f mpegts -i "udp://127.0.0.1:60xx?..." -filter_complex "..."
//     -map [v0] -map 0:a <encode 1080p> -f mpegts "srt://...?mode=listener"
//     -map [v1] -map 0:a <encode 720p>  -f mpegts "udp://236.x:700x?..."
//     -map 0:a -vn <encode audio>       -f mpegts "srt://...?mode=listener"
//   -progress pipe:1 (TranscodeManager đọc stdout — KHÔNG được ignore stdout).
//
// Input UDP dạng URL query là chuẩn của UDP protocol (đã chốt sau review):
//   overrun_nonfatal=1 (không thoát khi đầy đệm) + fifo_size + buffer_size.
//=============================================================================

import { z } from 'zod';
import type { ChannelTranscode, TranscodeEngine, TranscodeOutput, TranscodePreset } from './types.js';

export class TranscodeError extends Error {}

//-- Dải chuẩn docs/16 §10 -----------------------------------------------------

export const LOOPBACK_PORT_MIN = 6000;
export const LOOPBACK_PORT_MAX = 6099;
export const SRT_PORT_MIN = 9000;
export const SRT_PORT_MAX = 9199;
export const MCAST_OUT_PORT_MIN = 7000;
export const MCAST_OUT_PORT_MAX = 7099;

//-- Preset seed (docs/16 §3.1: 4 video + 1 audio-only, 25fps CBR GOP 2s) ------

/** 5 preset seed — thứ tự này cũng là thứ tự encode mặc định. */
export function defaultPresets(): TranscodePreset[] {
  const audio = (bitrateKbps: number): TranscodePreset['audio'] => ({
    codec: 'aac',
    bitrateKbps,
    sampleRate: 48000,
    channels: 2,
  });
  return [
    { id: 'p1080', name: '1080p', video: { codec: 'h264', width: 1920, height: 1080, bitrateKbps: 4000, fps: 25, gop: 50, preset: 'veryfast' }, audio: audio(192) },
    { id: 'p720', name: '720p', video: { codec: 'h264', width: 1280, height: 720, bitrateKbps: 2000, fps: 25, gop: 50, preset: 'veryfast' }, audio: audio(128) },
    { id: 'p480', name: '480p', video: { codec: 'h264', width: 854, height: 480, bitrateKbps: 1200, fps: 25, gop: 50, preset: 'veryfast' }, audio: audio(128) },
    { id: 'p360', name: '360p', video: { codec: 'h264', width: 640, height: 360, bitrateKbps: 800, fps: 25, gop: 50, preset: 'veryfast' }, audio: audio(128) },
    { id: 'paudio', name: 'Audio-Only', video: null, audio: audio(128) },
  ];
}

//-- Validate địa chỉ IP --------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIPv4(s: string): [number, number, number, number] | null {
  const m = IPV4_RE.exec(s.trim());
  if (m === null) return null;
  const parts = [m[1], m[2], m[3], m[4]].map((x) => Number.parseInt(x ?? '', 10));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

/** true = IPv4 multicast 224.0.0.0–239.255.255.255. */
export function isMulticastIPv4(s: string): boolean {
  const p = parseIPv4(s);
  return p !== null && p[0] >= 224 && p[0] <= 239;
}

/** true = nhóm output hợp lệ: multicast nhưng KHÔNG thuộc dải ingest 239.x. */
export function isValidOutputGroup(s: string): boolean {
  const p = parseIPv4(s);
  return p !== null && p[0] >= 224 && p[0] <= 238;
}

export function isIPv4(s: string): boolean {
  return parseIPv4(s) !== null;
}

//-- zod schema (share BE↔FE ở T2) ----------------------------------------------

const presetSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  video: z
    .object({
      codec: z.literal('h264'),
      width: z.number().int().min(160).max(3840),
      height: z.number().int().min(90).max(2160),
      bitrateKbps: z.number().int().min(100).max(50000),
      fps: z.number().int().min(1).max(60),
      gop: z.number().int().min(1).max(600),
      preset: z.string().min(1).max(32),
    })
    .nullable(),
  audio: z.object({
    codec: z.literal('aac'),
    bitrateKbps: z.number().int().min(32).max(512),
    sampleRate: z.literal(48000),
    channels: z.literal(2),
  }),
});

const outputSchema = z
  .object({
    type: z.enum(['srt-listen', 'srt-caller', 'rtmp-push', 'rtmp-in', 'udp-mcast']),
    presetId: z.string().min(1),
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().min(1).max(253).optional(),
    url: z.string().min(1).max(512).optional(),
    streamKey: z.string().min(1).max(256).optional(),
    streamId: z.string().max(512).optional(),
    passphraseRef: z.string().min(1).max(128).optional(),
    group: z.string().min(7).max(15).optional(),
    localAddr: z.string().min(7).max(15).optional(),
    ttl: z.number().int().min(1).max(255).optional(),
  })
  .superRefine((o, ctx) => {
    const need = (cond: boolean, field: string, msg: string): void => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: msg });
    };
    switch (o.type) {
      case 'srt-listen':
        need(o.port !== undefined, 'port', 'srt-listen bắt buộc có port');
        if (o.port !== undefined) need(o.port >= SRT_PORT_MIN && o.port <= SRT_PORT_MAX, 'port', `srt-listen port phải ${SRT_PORT_MIN}..${SRT_PORT_MAX}`);
        break;
      case 'srt-caller':
        need(o.host !== undefined && o.host !== '', 'host', 'srt-caller bắt buộc có host phía họ');
        need(o.port !== undefined, 'port', 'srt-caller bắt buộc có port phía họ');
        break;
      case 'rtmp-push':
        need(o.url !== undefined && o.url !== '', 'url', 'rtmp-push bắt buộc có url (VD rtmp://ip-ho/live)');
        need(o.streamKey !== undefined && o.streamKey !== '', 'streamKey', 'rtmp-push bắt buộc có streamKey');
        break;
      case 'rtmp-in':
        need(o.streamKey !== undefined && o.streamKey !== '', 'streamKey', 'rtmp-in bắt buộc có streamKey trên MediaMTX');
        break;
      case 'udp-mcast':
        need(o.group !== undefined && isValidOutputGroup(o.group), 'group', 'udp-mcast group phải multicast 224.x–238.x (dải 239.x đặt trước cho ingest)');
        if (o.port !== undefined) need(o.port >= MCAST_OUT_PORT_MIN && o.port <= MCAST_OUT_PORT_MAX, 'port', `udp-mcast port phải ${MCAST_OUT_PORT_MIN}..${MCAST_OUT_PORT_MAX}`);
        else need(false, 'port', 'udp-mcast bắt buộc có port');
        need(o.localAddr !== undefined && isIPv4(o.localAddr), 'localAddr', 'udp-mcast bắt buộc nhập IP card phát ra (cấm bỏ trống khi máy nhiều NIC)');
        break;
    }
    if (o.group !== undefined && o.type !== 'udp-mcast') {
      need(false, 'group', 'group chỉ dùng cho udp-mcast');
    }
  });

/** Parse + validate 1 preset (ném TranscodeError thay vì ZodError cho gọn). */
export function parsePreset(u: unknown): TranscodePreset {
  const r = presetSchema.safeParse(u);
  if (!r.success) throw new TranscodeError(`preset sai: ${r.error.issues.map((i) => i.message).join('; ')}`);
  const p = r.data;
  if (p.video !== null && (p.video.width % 2 !== 0 || p.video.height % 2 !== 0)) {
    throw new TranscodeError(`preset ${p.id}: width/height phải chẵn (x264 yêu cầu)`);
  }
  return { id: p.id, name: p.name, video: p.video, audio: p.audio };
}

/** Parse + validate 1 output. */
export function parseOutput(u: unknown): TranscodeOutput {
  const r = outputSchema.safeParse(u);
  if (!r.success) throw new TranscodeError(`output sai: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { ...r.data };
}

//-- Migration default cho DB cũ (docs/16 §12) -----------------------------------

/**
 * Chuẩn hóa transcode của 1 channel đọc từ DB cũ (thiếu field mới).
 * Không ném — chỉ điền default, validate thật ở lúc start.
 */
export function normalizeChannelTranscode(t: ChannelTranscode | undefined): ChannelTranscode | undefined {
  if (t === undefined) return undefined;
  const engines: TranscodeEngine[] = ['cpu', 'nvenc', 'qsv', 'vaapi'];
  return {
    enabled: t.enabled === true,
    loopbackPort: typeof t.loopbackPort === 'number' ? t.loopbackPort : 0,
    presetIds: Array.isArray(t.presetIds) ? [...t.presetIds] : [],
    outputs: Array.isArray(t.outputs) ? [...t.outputs] : [],
    engine: t.engine !== undefined && (engines as string[]).includes(t.engine) ? t.engine : 'cpu',
  };
}

//-- Secrets (passphrase SRT resolve lúc spawn, KHÔNG persist) --------------------
// Format env VTC_SRT_PASSPHRASES: "vtvgo:mat-khau-dai-16+,kenh2:mat-khau-khac".

/** Parse "ref:value,ref2:value2" thành map (bỏ entry rỗng, value giữ nguyên). */
export function parseSecretsEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const ref = part.slice(0, i).trim();
    const val = part.slice(i + 1);
    if (ref !== '' && val !== '') out[ref] = val;
  }
  return out;
}

//-- URL input + dòng fork -------------------------------------------------------

/** URL input ffmpeg đọc từ tsp (dạng query chuẩn của UDP protocol). */
export function transcodeInputUrl(loopbackPort: number): string {
  assertLoopbackPort(loopbackPort);
  return `udp://127.0.0.1:${loopbackPort}?overrun_nonfatal=1&fifo_size=1000000&buffer_size=4000000`;
}

export function assertLoopbackPort(port: number): void {
  if (!Number.isInteger(port) || port < LOOPBACK_PORT_MIN || port > LOOPBACK_PORT_MAX) {
    throw new TranscodeError(`loopbackPort phải ${LOOPBACK_PORT_MIN}..${LOOPBACK_PORT_MAX} (UDP nội bộ tsp→ffmpeg)`);
  }
}

/** Dòng fork SPTS cho ConfigGenerator (1 dòng = 1 argv, như fork HLS). */
export function loopbackForkLine(serviceId: number, loopbackPort: number): string {
  assertLoopbackPort(loopbackPort);
  return `tsp -P zap ${serviceId} -O ip 127.0.0.1:${loopbackPort}`;
}

//-- Sinh argv ffmpeg ------------------------------------------------------------

export interface FfmpegJob {
  /** Tên kênh (dùng làm streamid mặc định + log). */
  channelName: string;
  loopbackPort: number;
  /** Preset đã resolve theo presetIds (đúng thứ tự encode). */
  presets: TranscodePreset[];
  /** Output đã lọc enabled (validate từng cái). */
  outputs: TranscodeOutput[];
  /** Engine encode (mặc định cpu). */
  engine?: TranscodeEngine | undefined;
  /**
   * Giá trị `-i` đầy đủ, đè lên URL UDP loopback mặc định.
   * Production LUÔN dùng UDP loopback (giữ giám sát CC-error tầng ingest).
   * Chỉ dùng input file ở lab/test hoặc source file của TSDuck
   * (VD `/mnt/Data/cap.ts`) — spawn argv trực tiếp nên không lo injection.
   */
  inputUrl?: string | undefined;
  /** Map ref → passphrase đã resolve từ secret store (KHÔNG persist). */
  secrets?: Record<string, string>;
}

//-- Map engine → encoder --------------------------------------------------------
// Filter (yadif/fps/scale) giữ nguyên CPU cho mọi engine ở Phase 1 (đúng, chỉ
// chưa tối ưu upload GPU — tối ưu hwupload để phase GPU sau).

/**
 * Dịch x264 preset sang NVENC preset (p1 nhanh nhất … p7 chậm nhất).
 * LƯU Ý: p-preset chỉ có từ NVENC SDK 11 / GPU Turing+ (docs/16 §3.2).
 * Card Kepler/GTX 770 không hiểu p-preset — đã loại khỏi quy hoạch.
 */
function nvencPreset(x264preset: string): string {
  const map: Record<string, string> = {
    ultrafast: 'p1',
    superfast: 'p2',
    veryfast: 'p4',
    faster: 'p5',
    fast: 'p6',
    medium: 'p6',
    slow: 'p7',
  };
  return map[x264preset] ?? 'p4';
}

/** Encoder ffmpeg mà engine yêu cầu (để check capability + test). */
export function requiredEncoder(engine: TranscodeEngine): string {
  return engine === 'nvenc' ? 'h264_nvenc' : 'libx264';
}

/**
 * Fail-fast: engine đã chọn phải có encoder trong ffmpeg thật.
 * Caller (server.ts T2) chạy `ffmpeg -hide_banner -encoders` 1 lần lúc boot
 * (hoặc trước khi start kênh GPU) rồi truyền stdout vào đây.
 * @throws TranscodeError kèm hướng dẫn image khi thiếu.
 */
export function assertEngineAvailable(engine: TranscodeEngine, encodersText: string): void {
  const need = requiredEncoder(engine);
  if (!encodersText.includes(need)) {
    if (engine === 'nvenc') {
      throw new TranscodeError(
        `engine nvenc cần encoder "${need}" nhưng ffmpeg hiện tại không có — ` +
          `deploy image GPU (Dockerfile.backend-gpu) hoặc chuyển kênh sang engine cpu`,
      );
    }
    throw new TranscodeError(`ffmpeg hiện tại thiếu encoder "${need}" cho engine ${engine}`);
  }
}

export function resolveEngine(job: FfmpegJob): TranscodeEngine {
  const e = job.engine ?? 'cpu';
  if (e !== 'cpu' && e !== 'nvenc' && e !== 'qsv' && e !== 'vaapi') {
    throw new TranscodeError(`engine "${job.engine}" không hợp lệ (cpu|nvenc|qsv|vaapi)`);
  }
  if (e === 'qsv' || e === 'vaapi') {
    throw new TranscodeError(`engine ${e} giữ chỗ ở Phase 1 — dùng cpu (mặc định) hoặc nvenc`);
  }
  return e;
}

/** Argv encode video theo engine (CBR + GOP + profile giữ nguyên mọi engine). */
function videoEncoderArgs(engine: TranscodeEngine, bitrateKbps: number, gop: number, fps: number, x264preset: string): string[] {
  const br = `${bitrateKbps}k`;
  const common = ['-b:v', br, '-maxrate', br, '-bufsize', `${bitrateKbps * 2}k`, '-g', String(gop), '-r', String(fps), '-profile:v', 'high'];
  if (engine === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', nvencPreset(x264preset), ...common];
  return ['-c:v', 'libx264', '-preset', x264preset, ...common];
}

function resolvePassphrase(o: TranscodeOutput, secrets: Record<string, string>): string | undefined {
  if (o.passphraseRef === undefined) return undefined;
  const v = secrets[o.passphraseRef];
  if (v === undefined || v === '') {
    throw new TranscodeError(`output ${o.type}/${o.presetId}: thiếu passphrase cho ref "${o.passphraseRef}"`);
  }
  if (v.length < 16) {
    throw new TranscodeError(`output ${o.type}/${o.presetId}: passphrase phải ≥16 ký tự ở Prod (test nội bộ thì bỏ ref)`);
  }
  return v;
}

function srtUrl(o: TranscodeOutput, channelName: string, secrets: Record<string, string>): string {
  const pass = resolvePassphrase(o, secrets);
  const sid = o.streamId !== undefined && o.streamId !== '' ? o.streamId : channelName;
  const q = [`streamid=${encodeURIComponent(sid)}`];
  if (pass !== undefined) q.push(`passphrase=${encodeURIComponent(pass)}`);
  if (o.type === 'srt-listen') return `srt://0.0.0.0:${o.port}?mode=listener&${q.join('&')}`;
  return `srt://${o.host}:${o.port}?mode=caller&${q.join('&')}`;
}

/**
 * Sinh argv ffmpeg hoàn chỉnh (chưa gồm tên binary).
 * @throws TranscodeError khi preset/output sai (fail-fast trước khi spawn).
 */
export function buildFfmpegArgs(job: FfmpegJob): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(job.channelName)) {
    throw new TranscodeError(`channelName "${job.channelName}" chỉ cho [A-Za-z0-9_-]`);
  }
  const inputUrl = job.inputUrl !== undefined && job.inputUrl !== '' ? job.inputUrl : transcodeInputUrl(job.loopbackPort);
  if (job.inputUrl !== undefined && job.inputUrl.trim() === '') {
    throw new TranscodeError('inputUrl rỗng');
  }
  if (job.presets.length === 0) throw new TranscodeError('transcode cần ≥1 preset');
  if (job.outputs.length === 0) throw new TranscodeError('transcode cần ≥1 output (enabled)');

  const presets = job.presets.map(parsePreset);
  const outputs = job.outputs.map(parseOutput);
  const secrets = job.secrets ?? {};
  const engine = resolveEngine(job);

  const byId = new Map(presets.map((p) => [p.id, p]));
  for (const o of outputs) {
    if (!byId.has(o.presetId)) {
      throw new TranscodeError(`output ${o.type} trỏ presetId "${o.presetId}" không tồn tại`);
    }
    if (o.type === 'rtmp-in') {
      throw new TranscodeError('rtmp-in (MediaMTX nhận push) triển khai ở T3 — Phase 1 chỉ srt/rtmp-push/udp-mcast');
    }
  }

  // Cổng srt-listen không được trùng nhau (1 port = 1 rendition = 1 kết nối).
  const listenPorts = outputs.filter((o) => o.type === 'srt-listen').map((o) => o.port);
  if (new Set(listenPorts).size !== listenPorts.length) {
    throw new TranscodeError('cổng srt-listen bị trùng (1 port = 1 rendition)');
  }

  // Đánh chỉ số video [v0],[v1]... — CHỈ cho preset có output trỏ tới.
  // ffmpeg BẮT BUỘC mọi nhánh filter_complex đều được -map (nhánh thừa →
  // "Error binding filtergraph inputs/outputs"). Preset không ai dùng thì
  // không sinh nhánh (tiết kiệm cả CPU scale thừa).
  const usedIds = new Set(outputs.map((o) => o.presetId));
  const videoPresets = presets.filter((p) => p.video !== null && usedIds.has(p.id));
  const videoIdx = new Map<string, number>();
  videoPresets.forEach((p, i) => videoIdx.set(p.id, i));

  // Dựng filter_complex: deinterlace + fps 1 lần rồi split cho N rendition.
  const filters: string[] = [];
  if (videoPresets.length === 1) {
    const p = videoPresets[0];
    if (p?.video === null || p?.video === undefined) throw new TranscodeError('lỗi nội bộ filter');
    filters.push(`[0:v]yadif,fps=25,scale=${p.video.width}:${p.video.height}[v0]`);
  } else if (videoPresets.length > 1) {
    const splits = videoPresets.map((_, i) => `[s${i}]`).join('');
    filters.push(`[0:v]yadif,fps=25,split=${videoPresets.length}${splits}`);
    videoPresets.forEach((p, i) => {
      if (p.video === null) throw new TranscodeError('lỗi nội bộ filter');
      filters.push(`[s${i}]scale=${p.video.width}:${p.video.height}[v${i}]`);
    });
  }

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-progress', 'pipe:1',
  ];
  if (job.inputUrl !== undefined && job.inputUrl !== '') {
    // Input file/lab: để ffmpeg tự detect demuxer (không ép -f mpegts).
    args.push('-i', inputUrl);
  } else {
    // Production: UDP loopback, ép demuxer mpegts để khỏi probe chờ trên UDP lossy.
    args.push('-f', 'mpegts', '-i', inputUrl);
  }
  if (filters.length > 0) args.push('-filter_complex', filters.join(';'));

  for (const o of outputs) {
    const p = byId.get(o.presetId);
    if (p === undefined) throw new TranscodeError('lỗi nội bộ preset');
    const a = p.audio;
    if (p.video === null) {
      // Audio-Only: bỏ hình.
      args.push(
        '-map', '0:a', '-vn',
        '-c:a', 'aac', '-b:a', `${a.bitrateKbps}k`, '-ar', String(a.sampleRate), '-ac', String(a.channels),
      );
    } else {
      const v = p.video;
      const vi = videoIdx.get(p.id) ?? 0;
      args.push(
        '-map', `[v${vi}]`, '-map', '0:a',
        ...videoEncoderArgs(engine, v.bitrateKbps, v.gop, v.fps, v.preset),
        '-c:a', 'aac', '-b:a', `${a.bitrateKbps}k`, '-ar', String(a.sampleRate), '-ac', String(a.channels),
      );
    }
    switch (o.type) {
      case 'srt-listen':
      case 'srt-caller':
        args.push('-f', 'mpegts', srtUrl(o, job.channelName, secrets));
        break;
      case 'rtmp-push': {
        const base = (o.url ?? '').replace(/\/+$/, '');
        args.push('-f', 'flv', `${base}/${o.streamKey}`);
        break;
      }
      case 'udp-mcast': {
        const ttl = o.ttl ?? 1;
        args.push('-f', 'mpegts', `udp://${o.group}:${o.port}?pkt_size=1316&localaddr=${o.localAddr}&ttl=${ttl}`);
        break;
      }
      case 'rtmp-in':
        throw new TranscodeError('rtmp-in triển khai ở T3');
    }
  }
  return args;
}
