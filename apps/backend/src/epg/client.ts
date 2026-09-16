//=============================================================================
// epg/client.ts — Client API EPG đối tác (X-API-Key, phân trang, retry 429/5xx).
// Không bao giờ ném lỗi mạng thô ra ngoài: bọc thành EpgError có status.
//=============================================================================
import type { EpgDay, PartnerChannel } from './types.js';

export class EpgError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export interface EpgClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Ms chờ khi 429 không kèm Retry-After (mặc định 30s). */
  retryAfterMs?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class EpgClient {
  readonly baseUrl: string;
  private readonly apiKeyOpt: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly retryAfterMs: number;

  constructor(opts: EpgClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['VTC_EPG_BASE_URL'] ?? 'https://nhaplieu.vtctech.xyz/api/v1').replace(
      /\/$/,
      '',
    );
    this.apiKeyOpt = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retryAfterMs = opts.retryAfterMs ?? 30_000;
  }

  /** Đọc env mỗi lần (xoay key/test không cần dựng lại client). */
  get apiKey(): string {
    return this.apiKeyOpt ?? process.env['VTC_EPG_API_KEY'] ?? '';
  }

  get configured(): boolean {
    return this.apiKey !== '';
  }

  private async call<T>(path: string, attempt = 0): Promise<T> {
    if (!this.configured) throw new EpgError('chưa cấu hình VTC_EPG_API_KEY');
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, { headers: { 'X-API-Key': this.apiKey } });
    } catch (e) {
      if (attempt >= 2) throw new EpgError(`không gọi được API EPG: ${e instanceof Error ? e.message : 'lỗi mạng'}`);
      await new Promise((r) => setTimeout(r, 2000));
      return this.call<T>(path, attempt + 1);
    }
    if (res.status === 429) {
      const retrySec = Number(res.headers.get('retry-after') ?? '');
      const waitMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : this.retryAfterMs;
      await new Promise((r) => setTimeout(r, waitMs));
      if (attempt >= 1) throw new EpgError('API EPG giới hạn tần suất (429), thử lại sau', 429);
      return this.call<T>(path, attempt + 1);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new EpgError(body.message ?? `API EPG lỗi HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  async listChannels(page = 0, limit = 20, search = ''): Promise<{ channels: PartnerChannel[]; total: number }> {
    const q = new URLSearchParams({ page: String(page), limit: String(Math.min(200, Math.max(1, limit))) });
    if (search !== '') q.set('search', search);
    const j = await this.call<{ channels: PartnerChannel[]; total: number }>(`/channels?${q.toString()}`);
    return { channels: j.channels ?? [], total: j.total ?? 0 };
  }

  async listAllChannels(): Promise<PartnerChannel[]> {
    const out: PartnerChannel[] = [];
    let page = 0;
    for (;;) {
      const { channels, total } = await this.listChannels(page, 200);
      out.push(...channels);
      if (out.length >= total || channels.length === 0) break;
      page++;
    }
    return out;
  }

  async getSchedule(partnerChannelId: number, date: string): Promise<EpgDay> {
    if (!DATE_RE.test(date)) throw new EpgError(`ngày phải YYYY-MM-DD (nhận "${date}")`);
    const j = await this.call<{
      channelId: number;
      date: string;
      timezone: string;
      programs: EpgDay['programs'];
    }>(`/channels/${partnerChannelId}/epg?date=${date}`);
    const programs = [...(j.programs ?? [])].sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    const updatedAt = programs.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), '');
    return {
      partnerChannelId: j.channelId,
      date: j.date,
      timezone: j.timezone ?? '+07:00',
      updatedAt,
      fetchedAt: new Date().toISOString(),
      programs,
    };
  }
}
