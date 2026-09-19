// lib/transcode.ts — Types + validate (zod, mirror backend) + API client
// cho Transcode SRT/RTMP/UDP-mcast (docs/16 §8). Form dùng useState thuần
// (khớp style repo — không thêm react-hook-form).

import { z } from 'zod';

export type TranscodeEngine = 'cpu' | 'nvenc' | 'qsv' | 'vaapi';
export type TranscodeOutputType = 'srt-listen' | 'srt-caller' | 'rtmp-push' | 'rtmp-in' | 'udp-mcast' | 'hls';

export interface TranscodePreset {
  id: string;
  name: string;
  video: { codec: 'h264'; width: number; height: number; bitrateKbps: number; fps: number; gop: number; preset: string } | null;
  audio: { codec: 'aac'; bitrateKbps: number; sampleRate: number; channels: number };
}

export interface TranscodeOutput {
  type: TranscodeOutputType;
  presetId: string;
  enabled: boolean;
  port?: number;
  host?: string;
  url?: string;
  streamKey?: string;
  streamId?: string;
  passphraseRef?: string;
  group?: string;
  localAddr?: string;
  ttl?: number;
}

export interface ChannelTranscode {
  enabled: boolean;
  loopbackPort: number;
  presetIds: string[];
  outputs: TranscodeOutput[];
  engine?: TranscodeEngine;
  /** Rendition ghi sau-encode ra đĩa (chunk 60s, Timeshift/Export đọc được). */
  recordPresetId?: string;
}

export interface SourcePuller {
  rtmpUrl: string;
  streamKey: string;
  udpPort: number;
}

/** Loại đầu vào source (docs/16 §18) — sdi/hdmi giữ chỗ cho phase Encode sau. */
export type SourceInputKind = 'ip' | 'sdi' | 'hdmi';

/** Điểm trích Live/GHI: ingest (IP, Phase 1) hay encoded (Encode bắt buộc sau-encode). */
export type SourceLiveCatchupFrom = 'ingest' | 'encoded';

export interface SourceCapture {
  device: string;
  cardIndex?: number;
  connection?: string;
  formatCode?: string;
  udpPort: number;
  presetId?: string;
  engine?: TranscodeEngine;
}

export const captureSchema = z.object({
  device: z.string().min(1, 'thiếu tên card (ffmpeg thấy)').max(256),
  cardIndex: z.number().int().min(0).max(15).optional(),
  connection: z.string().max(16).optional(),
  formatCode: z.string().max(16).optional(),
  udpPort: z.number().int().min(6200).max(6299),
  presetId: z.string().min(1).max(64).optional(),
  engine: z.enum(['cpu', 'nvenc', 'qsv', 'vaapi']).optional(),
});

/** Validate capture → message lỗi hoặc null. undefined = không capture (qua). */
export function validateCapture(p: SourceCapture | undefined): string | null {
  if (p === undefined) return null;
  const r = captureSchema.safeParse(p);
  if (r.success) return null;
  const first = r.error.issues[0];
  return first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'capture sai';
}

export const pullerSchema = z.object({
  rtmpUrl: z.string().min(1, 'thiếu URL RTMP (VD rtmp://127.0.0.1:1935/live)').max(512),
  streamKey: z.string().min(1, 'thiếu stream key').max(256),
  udpPort: z.number().int().min(6100).max(6199),
});

/** Validate puller → message lỗi hoặc null. undefined = nguồn trực tiếp (qua). */
export function validatePuller(p: SourcePuller | undefined): string | null {
  if (p === undefined) return null;
  const r = pullerSchema.safeParse(p);
  if (r.success) return null;
  const first = r.error.issues[0];
  return first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'puller sai';
}

export interface TcStatus {
  key: string;
  pid: number | null;
  running: boolean;
  fps: number | null;
  bitrateKbps: number | null;
  lastProgressAt: number | null;
  stale: boolean;
  /** Sống quá 30s chưa có frame: thường đang chờ caller SRT đầu tiên. */
  waiting: boolean;
  crashes: number;
  /** Vài dòng stderr cuối của ffmpeg (lỗi output như RTMP handshake fail). */
  lastError: string | null;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function ipv4Parts(s: string): number[] | null {
  const m = IPV4_RE.exec(s.trim());
  if (m === null) return null;
  const p = [m[1], m[2], m[3], m[4]].map((x) => Number.parseInt(x ?? '', 10));
  return p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}
const isIPv4 = (s: string): boolean => ipv4Parts(s) !== null;
// Nhóm output: multicast 224–238 (dải 239.x đặt trước cho ingest).
const isOutputGroup = (s: string): boolean => {
  const p = ipv4Parts(s);
  return p !== null && (p[0] ?? 0) >= 224 && (p[0] ?? 0) <= 238;
};

export const presetSchema = z.object({
  id: z.string().min(1, 'thiếu id').max(64).regex(/^[A-Za-z0-9_-]+$/, 'id chỉ cho chữ/số/_/-'),
  name: z.string().min(1, 'thiếu tên').max(64),
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
    .nullable()
    .refine((v) => v === null || (v.width % 2 === 0 && v.height % 2 === 0), 'width/height phải chẵn (x264)'),
  audio: z.object({
    codec: z.literal('aac'),
    bitrateKbps: z.number().int().min(32).max(512),
    sampleRate: z.literal(48000),
    channels: z.literal(2),
  }),
});

export const outputSchema = z
  .object({
    type: z.enum(['srt-listen', 'srt-caller', 'rtmp-push', 'rtmp-in', 'udp-mcast', 'hls']),
    presetId: z.string().min(1, 'output phải gắn 1 rendition (presetId)'),
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().max(253).optional(),
    url: z.string().max(512).optional(),
    streamKey: z.string().max(256).optional(),
    streamId: z.string().max(512).optional(),
    passphraseRef: z.string().max(128).optional(),
    group: z.string().max(15).optional(),
    localAddr: z.string().max(15).optional(),
    ttl: z.number().int().min(1).max(255).optional(),
  })
  .superRefine((o, ctx) => {
    const need = (cond: boolean, field: string, msg: string): void => {
      if (!cond) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: msg });
    };
    // Đã tick Mã hóa (ref khác undefined) mà ref trống → chặn ngay ở form
    // (backend cũng chặn lúc spawn — fail-fast 2 lớp).
    if ((o.type === 'srt-listen' || o.type === 'srt-caller') && o.passphraseRef !== undefined) {
      need(o.passphraseRef !== '', 'passphraseRef', 'đã bật mã hóa nhưng ref trống — điền ref hoặc bỏ tick');
    }
    switch (o.type) {
      case 'srt-listen':
        need(o.port !== undefined && o.port >= 9000 && o.port <= 9199, 'port', 'srt-listen port 9000..9199');
        break;
      case 'srt-caller':
        need(!!o.host, 'host', 'srt-caller cần host phía họ');
        need(o.port !== undefined, 'port', 'srt-caller cần port phía họ');
        break;
      case 'rtmp-push':
        need(!!o.url, 'url', 'rtmp-push cần url (VD rtmp://ip-ho/live)');
        break;
      case 'rtmp-in':
        need(!!o.streamKey, 'streamKey', 'rtmp-in cần streamKey trên MediaMTX');
        break;
      case 'udp-mcast':
        need(o.group !== undefined && isOutputGroup(o.group), 'group', 'group phải 224.x–238.x (239.x là dải ingest)');
        need(o.port !== undefined && o.port >= 7000 && o.port <= 7099, 'port', 'udp-mcast port 7000..7099');
        need(o.localAddr !== undefined && isIPv4(o.localAddr), 'localAddr', 'cần IP card phát ra');
        break;
      case 'hls':
        // HLS sau transcode: không cần field phụ (đường ghi suy từ kênh+preset).
        break;
    }
  });

export const channelTranscodeSchema = z.object({
  enabled: z.boolean(),
  loopbackPort: z.number().int().min(6000).max(6099),
  presetIds: z.array(z.string().min(1)),
  outputs: z.array(outputSchema),
  engine: z.enum(['cpu', 'nvenc', 'qsv', 'vaapi']).optional(),
  recordPresetId: z.string().min(1).max(64).optional(),
});

/** Validate 1 output → message lỗi đầu tiên (hoặc null = đạt). */
export function validateOutput(o: TranscodeOutput): string | null {
  const r = outputSchema.safeParse(o);
  if (r.success) return null;
  const first = r.error.issues[0];
  return first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'output sai';
}

/** Validate cả khối transcode của kênh. */
export function validateChannelTranscode(t: ChannelTranscode, presets?: TranscodePreset[]): string | null {
  const r = channelTranscodeSchema.safeParse(t);
  if (!r.success) {
    const first = r.error.issues[0];
    return first !== undefined ? `${first.path.join('.')}: ${first.message}` : 'cấu hình sai';
  }
  if (t.enabled && t.presetIds.length === 0) return 'bật transcode nhưng chưa chọn preset nào';
  if (t.enabled && !t.outputs.some((o) => o.enabled)) return 'bật transcode nhưng chưa có output nào enabled';
  const picked = new Set(t.presetIds);
  const dangling = t.outputs.find((o) => o.enabled && !picked.has(o.presetId));
  if (dangling !== undefined) return `output ${dangling.type} trỏ rendition "${dangling.presetId}" chưa tick chọn ở danh sách preset`;
  const ports = t.outputs.filter((o) => o.enabled && o.type === 'srt-listen').map((o) => o.port);
  if (new Set(ports).size !== ports.length) return 'cổng srt-listen bị trùng (1 port = 1 rendition)';
  if (t.recordPresetId !== undefined) {
    if (!picked.has(t.recordPresetId)) return `ghi sau-encode trỏ rendition "${t.recordPresetId}" chưa tick chọn ở danh sách preset`;
    const p = presets?.find((x) => x.id === t.recordPresetId);
    if (presets !== undefined && p === undefined) return `ghi sau-encode trỏ preset "${t.recordPresetId}" không tồn tại`;
    if (p !== undefined && p.video === null) return 'ghi sau-encode cần preset video (không ghi Audio-Only ra đĩa)';
  }
  return null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const tcApi = {
  presets: () => fetch('/api/presets', { credentials: 'include' }).then((r) => json<TranscodePreset[]>(r)),
  createPreset: (p: TranscodePreset) => fetch('/api/presets', post(p)).then((r) => json<TranscodePreset>(r)),
  updatePreset: (id: string, p: TranscodePreset) =>
    fetch(`/api/presets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    }).then((r) => json<TranscodePreset>(r)),
  deletePreset: (id: string) =>
    fetch(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  updateChannelTranscode: (sourceId: string, channel: string, transcode: ChannelTranscode) =>
    fetch(`/api/sources/${encodeURIComponent(sourceId)}/channels/${encodeURIComponent(channel)}/transcode`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcode }),
    }).then((r) => json<{ ok: boolean; restarted: boolean }>(r)),
  tcStart: (sourceId: string, channel: string) =>
    fetch(`/api/sources/${encodeURIComponent(sourceId)}/channels/${encodeURIComponent(channel)}/transcode-start`, {
      method: 'POST',
      credentials: 'include',
    }).then((r) => json<{ ok: boolean; pid: number }>(r)),
  tcStop: (sourceId: string, channel: string) =>
    fetch(`/api/sources/${encodeURIComponent(sourceId)}/channels/${encodeURIComponent(channel)}/transcode-stop`, {
      method: 'POST',
      credentials: 'include',
    }).then((r) => json<{ ok: boolean }>(r)),
  tcStatus: () => fetch('/api/transcode/status', { credentials: 'include' }).then((r) => json<TcStatus[]>(r)),
  srtTest: (sourceId: string, channel: string, port: number) =>
    fetch(`/api/sources/${encodeURIComponent(sourceId)}/channels/${encodeURIComponent(channel)}/srt-test`, post({ port })).then(
      (r) => json<{ ok: boolean; detail: string }>(r),
    ),
};
