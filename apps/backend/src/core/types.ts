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
}

/** 1 nguồn tín hiệu (VD TS8 = 1 IP multicast chứa N kênh). */
export interface SourceConfig {
  /** ID nguồn, dùng làm tên file conf + thư mục catchup (VD DEMO). */
  id: string;
  /** Chuỗi sau `-I`, VD "ip 239.69.69.10:1234" hay "file /tmp/a.ts --repeat". */
  input: string;
  /** Các kênh thuộc nguồn này. */
  channels: ChannelConfig[];
  /** true = ghi MPTS tổng ra đĩa (`-O hls --live 0`), false = `-O drop`. */
  recordAll: boolean;
  /** Số ngày lưu chiểu của cả MPTS (GC dùng chung — xem BRAINSTORM §2.4). */
  retentionDays?: number;
  /** Tăng mỗi lần regen để debug/rollback (Phase 2 lưu vào DB). */
  confRev?: number;
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
