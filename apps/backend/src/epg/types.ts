//=============================================================================
// epg/types.ts — Kiểu EPG đối tác (khớp API-DOI-TAC.md, đã verify live 16/09/2026).
// programs sắp xếp tăng dần startTime; updatedAt đồng nhất cả ngày (mức lô).
//=============================================================================
export interface EpgProgram {
  id: string;
  channelId: number;
  title: string;
  description: string;
  /** RFC 3339 +07:00. */
  startTime: string;
  endTime: string;
  updatedAt: string;
}

export interface EpgDay {
  partnerChannelId: number;
  /** YYYY-MM-DD. */
  date: string;
  timezone: string;
  /** Mốc lô (mọi program chung 1 mốc) — chìa so sánh đồng bộ. */
  updatedAt: string;
  fetchedAt: string;
  programs: EpgProgram[];
}

export interface PartnerChannel {
  id: number;
  name: string;
  description: string;
}

/** 1 mapping local <-> đối tác (partnerChannelId nằm trong ChannelConfig). */
export interface ChannelMapping {
  localName: string;
  sourceId: string;
  serviceId: number;
  partnerChannelId: number;
  partnerName?: string;
}
