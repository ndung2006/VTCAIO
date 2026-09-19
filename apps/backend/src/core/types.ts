//=============================================================================
// types.ts — Kiểu dùng chung cho ConfigGenerator + ProcessManager.
// Giữ tối giản Phase 1: đủ để sinh .conf theo Source và quản lý 1 process.
//=============================================================================

/** 1 kênh trong MPTS (VD Đồng Nai 1 HD, sid 2004). */
export interface ChannelConfig {
  /** Tên kênh, dùng làm thư mục HLS — không dấu cách (VD demo4). */
  name: string;
  /** Service ID để `-P zap` (VD 2004). */
  serviceId: number;
  /** true = sinh nhánh HLS live cho kênh này. */
  isLive: boolean;
  /** ID kênh trên hệ EPG đối tác (VD 809 = VTV1) — để map lịch phát sóng. */
  partnerChannelId?: number | null;
  /**
   * true = cho lên danh mục public VTVgo (`GET /api/public/channels`).
   * Mặc định tắt: không tích là đối tác không thấy, chống lộ kênh nội bộ.
   */
  published?: boolean;
  /**
   * Transcode SRT/RTMP/UDP-out của kênh (docs/16).
   * undefined = không transcode (mặc định, tương thích DB cũ).
   * Bật/tắt là thay đổi CẤU TRÚC (đổi conf tsp) — phải stop source trước.
   * Đổi endpoint bên trong là hot-update (chỉ restart ffmpeg) — xem docs/16 §8.2.
   */
  transcode?: ChannelTranscode | undefined;
}

/** Loại đầu vào của source — chốt kiến trúc Encode vs Transcode (docs/16 §18). */
export type SourceInputKind =
  /** IP (multicast/SRT/RTMP/file): transcode luồng nén có sẵn — chạy được ngay. */
  | 'ip'
  /** SDI (baseband qua card capture): encode từ raw — phase sau (cần phần cứng). */
  | 'sdi'
  /** HDMI (baseband qua card capture/USB): encode từ raw — phase sau. */
  | 'hdmi';

/**
 * Điểm trích Live HLS + GHI catchup (docs/16 §0, §18).
 * - ingest: lấy từ luồng ingest (TRƯỚC transcode) — mặc định + khóa cứng cho IP ở Phase 1.
 * - encoded: lấy từ luồng ĐÃ encode (SAU encode/transcode) — mặc định bắt buộc cho Encode (SDI/HDMI),
 *   vì baseband raw không thể ra HLS/GHI trực tiếp. Với capture-agent pattern, TSDuck ingest
 *   luồng đã encode nên GHI/Live tự nhiên là sau-encode.
 */
export type SourceLiveCatchupFrom = 'ingest' | 'encoded';

/**
 * Thông số capture baseband cho nguồn sdi/hdmi (Encode — docs/16 §18).
 * Capture agent = 1 ffmpeg riêng: đọc card (`-f decklink`) → encode mezzanine
 * (preset + engine dưới đây) → UDP localhost dải 6200–6299 cho tsp ingest.
 */
export interface SourceCapture {
  /** Tên thiết bị ffmpeg thấy (VD UltraStudio Mini Recorder, DeckLink Mini Recorder 4K). */
  device: string;
  /** Index card khi nhiều card cùng máy (mặc định 0 — ffmpeg decklink tự đánh số). */
  cardIndex?: number | undefined;
  /** Cổng vào ffmpeg (`-video_input`): sdi | hdmi | ... (mặc định sdi). */
  connection?: string | undefined;
  /**
   * Mã format ffmpeg decklink (`-format_code`, VD Hi50 = 1080i50, Hp25 = 1080p25).
   * Trống = card tự nhận (khuyên khóa cố định ở Prod).
   */
  formatCode?: string | undefined;
  /** Cổng UDP localhost agent phát ra = cổng tsp nghe (dải 6200–6299). */
  udpPort: number;
  /** Preset mezzanine để encode (mặc định p1080). */
  presetId?: string | undefined;
  /** Engine encode agent (mặc định cpu). */
  engine?: TranscodeEngine | undefined;
}

/** 1 nguồn tín hiệu (VD TS8 = 1 IP multicast chứa N kênh). */
export interface SourceConfig {
  /** ID nguồn, dùng làm tên file conf + thư mục catchup (VD DEMO). */
  id: string;
  /**
   * Loại đầu vào (mặc định ip khi bỏ trống — tương thích DB cũ).
   * sdi/hdmi: model đã có, ConfigGenerator báo "phase sau" rõ ràng.
   */
  inputKind?: SourceInputKind | undefined;
  /** Chuỗi sau `-I`, VD "ip 239.69.69.10:1234" hay "file /tmp/a.ts --repeat". */
  input: string;
  /** Các kênh thuộc nguồn này. */
  channels: ChannelConfig[];
  /** true = ghi MPTS tổng ra đĩa (`-O hls --live 0`), false = `-O drop`. */
  recordAll: boolean;
  /** Số ngày lưu chiểu của cả MPTS (GC dùng chung — xem BRAINSTORM §2.4). */
  retentionDays?: number | undefined;
  /** Tăng mỗi lần regen để debug/rollback (Phase 2 lưu vào DB). */
  confRev?: number;
  /**
   * Puller RTMP→UDP (docs/16 §5, T3-wiring). TSDuck không đọc được RTMP nên
   * 1 ffmpeg puller remux (`-c copy`) RTMP từ MediaMTX ra UDP localhost, còn
   * source này ingest UDP đó như nguồn thường (`input: "ip 127.0.0.1:61xx"`).
   * undefined = nguồn trực tiếp (multicast/file), không puller.
   * Đổi puller là hot-update (chỉ restart puller, không động tsp).
   * Chỉ dùng với inputKind ip (sdi/hdmi có đường capture riêng — docs/16 §18).
   */
  puller?: SourcePuller | undefined;
  /** Thông số capture cho sdi/hdmi (phase sau — docs/16 §18). */
  capture?: SourceCapture | undefined;
  /**
   * Điểm trích Live HLS + GHI (thiếu = ingest, tương thích DB cũ).
   * - ip: bắt buộc ingest ở Phase 1 (khóa "sau transcode" — xem docs/16 §0).
   * - sdi/hdmi: bắt buộc encoded (baseband raw không ra HLS/GHI trực tiếp được).
   */
  liveCatchupFrom?: SourceLiveCatchupFrom | undefined;
}

/**
 * Cấu hình puller RTMP của 1 source.
 * Yêu cầu nội dung RTMP là H.264 + AAC (puller chỉ remux `-c copy`, nhẹ CPU).
 * Codec lạ thì ingest xong dùng transcode kênh để chuyển (đường thường).
 */
export interface SourcePuller {
  /** URL app RTMP trên MediaMTX (VD rtmp://127.0.0.1:1935/live). */
  rtmpUrl: string;
  /** Stream key đối tác push (phần sau URL). */
  streamKey: string;
  /** Cổng UDP localhost puller phát ra = cổng tsp nghe (dải 6100–6199). */
  udpPort: number;
}

/** Kết quả sinh conf. */
export interface GeneratedConf {
  /** Nội dung file .conf (truyền cho `tsp @file`). */
  content: string;
  /** Số kênh live (số nhánh fork). */
  liveCount: number;
  /** Đường dẫn file đã ghi (nếu có ghi đĩa). */
  filePath?: string;
}

/** Trạng thái 1 source đang quản lý. */
export type SourceStatus = 'RUNNING' | 'STOPPED' | 'ERROR';

/** 1 dòng CC-error parse từ stderr (để bắn Telegram ở Phase 3). */
export interface CcErrorEvent {
  sourceId: string;
  pid: number;
  expected: number;
  got: number;
  at: Date;
}

//=============================================================================
// Transcode (docs/16) — Phase 1: preset + output SRT/RTMP/UDP-mcast.
// GHI + Live HLS vẫn đi đường gốc (trước transcode), khóa cứng ở Phase 1.
//=============================================================================

/** Video của 1 rendition trong preset (Phase 1 chỉ H.264 CBR, 25fps, GOP 2s). */
export interface TranscodeVideo {
  codec: 'h264';
  width: number;
  height: number;
  /** Kbps video (VD 4000 = 4 Mbps). CBR: maxrate = bitrate, bufsize = 2×. */
  bitrateKbps: number;
  fps: number;
  /** GOP theo frames (VD 50 = 2s @25fps). */
  gop: number;
  /** x264 preset (VD veryfast). */
  preset: string;
}

/** Audio của 1 rendition (Phase 1 chỉ AAC-LC 48kHz stereo). */
export interface TranscodeAudio {
  codec: 'aac';
  bitrateKbps: number;
  sampleRate: number;
  channels: number;
}

/**
 * 1 preset encode = 1 rendition (seed sẵn 5 dòng, sửa preset không ảnh
 * hưởng kênh đang chạy vì argv snapshot lúc start).
 * video = null nghĩa là Audio-Only (ffmpeg `-vn`, nghe nền mobile/radio).
 */
export interface TranscodePreset {
  id: string;
  name: string;
  video: TranscodeVideo | null;
  audio: TranscodeAudio;
}

/** Loại đầu ra transcode (docs/16 §4–§6). */
export type TranscodeOutputType = 'srt-listen' | 'srt-caller' | 'rtmp-push' | 'rtmp-in' | 'udp-mcast';

/**
 * 1 đầu ra: LUÔN gắn đúng 1 rendition qua presetId.
 * Quy ước Phase 1: 1 port = 1 rendition = 1 kết nối tại 1 thời điểm.
 */
export interface TranscodeOutput {
  type: TranscodeOutputType;
  /** Rendition áp dụng (id trong TranscodePreset). Bắt buộc. */
  presetId: string;
  enabled: boolean;
  /** srt-listen: cổng mở. srt-caller: cổng phía họ. udp-mcast: cổng nhóm nhận. */
  port?: number | undefined;
  /** srt-caller: IP/host phía họ. */
  host?: string | undefined;
  /** rtmp-push: URL app (VD rtmp://ip-ho/live). */
  url?: string | undefined;
  /** rtmp-push / rtmp-in: stream key. */
  streamKey?: string | undefined;
  /** SRT streamid (bỏ trống = mặc định tên kênh lúc spawn). */
  streamId?: string | undefined;
  /** Ref tới passphrase — KHÔNG lưu secret vào DB, resolve lúc spawn. */
  passphraseRef?: string | undefined;
  /** udp-mcast: nhóm multicast (dải 236.x — cấm dải ingest 239.x). */
  group?: string | undefined;
  /** udp-mcast: IP card phát ra (cấm bỏ trống khi máy nhiều NIC). */
  localAddr?: string | undefined;
  /** udp-mcast: TTL (mặc định 1 — giữ trong LAN). */
  ttl?: number | undefined;
}

/**
 * Engine transcode (docs/16 §3.2).
 * - cpu: libx264 — MẶC ĐỊNH, chạy mọi máy, tốn 3–5 core/kênh 4 renditions.
 * - nvenc: h264_nvenc (NVIDIA) — cần driver + ffmpeg build có nvenc
 *   (ffmpeg stock Ubuntu KHÔNG có → image GPU riêng ở phase sau).
 * - qsv / vaapi (Intel): giữ chỗ trong type, generator báo chưa hỗ trợ ở Phase 1.
 * Engine là thuộc tính của MÁY (node có GPU hay không) nên nằm ở tầng kênh,
 * không nằm trong preset (preset dùng chung nhiều máy).
 */
export type TranscodeEngine = 'cpu' | 'nvenc' | 'qsv' | 'vaapi';

/**
 * Cấu hình transcode của 1 kênh.
 * Đổi presetIds/outputs/engine bên trong là hot-update (chỉ restart ffmpeg).
 */
export interface ChannelTranscode {
  enabled: boolean;
  /** Port UDP loopback tsp→ffmpeg (dải 6000–6099, 1 kênh 1 port). */
  loopbackPort: number;
  presetIds: string[];
  outputs: TranscodeOutput[];
  /** Engine encode (mặc định cpu khi bỏ trống — tương thích DB cũ). */
  engine?: TranscodeEngine | undefined;
}
