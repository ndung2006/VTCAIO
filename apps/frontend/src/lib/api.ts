// lib/api.ts — Gọi backend qua rewrite /api (cùng origin → cookie đi kèm).
// Dùng `credentials: 'include'` để trình duyệt gửi HttpOnly cookie vtc_token.

export interface Source {
  id: string;
  input: string;
  channels: {
    name: string;
    serviceId: number;
    isLive: boolean;
    partnerChannelId?: number | null;
    published?: boolean;
  }[];
  recordAll: boolean;
  retentionDays?: number;
  confRev: number;
  status: 'RUNNING' | 'STOPPED' | 'ERROR';
  pid?: number;
}

export interface EpgStatus {
  configured: boolean;
  lastSyncAt: string | null;
  lastStats: {
    mappings: number;
    days: number;
    updated: number;
    skipped: number;
    errors: { partnerChannelId: number; date: string; error: string }[];
  } | null;
  mappings: {
    partnerChannelId: number;
    localName: string;
    dates: { date: string; updatedAt: string; count: number }[];
  }[];
  unmappedLocal: { name: string; sourceId: string }[];
}

export interface EpgDayView {
  partnerChannelId: number;
  date: string;
  timezone: string;
  updatedAt: string;
  fetchedAt: string;
  localName: string;
  programs: { id: string; title: string; description: string; startTime: string; endTime: string; updatedAt: string }[];
}

export interface SystemEvent {
  cpu: number;
  ram_used: number;
  ram_percent: number;
  disk_percent: number | null;
  network: { tx: number; rx: number };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface SourceInput {
  id: string;
  input: string;
  channels: {
    name: string;
    serviceId: number;
    isLive: boolean;
    partnerChannelId?: number | null;
    published?: boolean;
  }[];
  recordAll: boolean;
  retentionDays?: number;
}

export interface PreviewConf {
  conf: string;
  liveCount: number;
  confRev: number;
}

export const api = {
  sources: () => fetch('/api/sources', { credentials: 'include' }).then((r) => json<Source[]>(r)),
  source: (id: string) =>
    fetch(`/api/sources/${encodeURIComponent(id)}`, { credentials: 'include' }).then((r) => json<Source>(r)),
  createSource: (body: SourceInput) =>
    fetch('/api/sources', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Source>(r)),
  updateSource: (id: string, patch: Partial<SourceInput>) =>
    fetch(`/api/sources/${encodeURIComponent(id)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<Source>(r)),
  deleteSource: (id: string) =>
    fetch(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  startSource: (id: string) =>
    fetch(`/api/sources/${encodeURIComponent(id)}/start`, { method: 'POST', credentials: 'include' }).then((r) =>
      json<{ ok: boolean; pid: number; conf: string }>(r),
    ),
  stopSource: (id: string) =>
    fetch(`/api/sources/${encodeURIComponent(id)}/stop`, { method: 'POST', credentials: 'include' }).then((r) =>
      json<{ ok: boolean }>(r),
    ),
  previewConf: (id: string) =>
    fetch(`/api/sources/${encodeURIComponent(id)}/preview-conf`, { credentials: 'include' }).then((r) =>
      json<PreviewConf>(r),
    ),
  login: (username: string, password: string) =>
    fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then((r) => json<{ ok: boolean; user: { username: string; role: string } }>(r)),
  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then((r) => json<{ ok: boolean }>(r)),
  me: () =>
    fetch('/api/auth/me', { credentials: 'include' }).then((r) =>
      json<{ username: string; role: string; allowedChannels?: string[] }>(r),
    ),
  adminUsers: () =>
    fetch('/api/admin/users', { credentials: 'include' }).then((r) =>
      json<{ username: string; email: string; role: string; allowedChannels: string[] }[]>(r),
    ),
  adminCreateUser: (username: string, email: string, password: string, role: string, allowedChannels?: string[]) =>
    fetch('/api/admin/users', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, email, password, role, allowedChannels: allowedChannels ?? [] }),
    }).then((r) => json<{ username: string; email: string; role: string; allowedChannels: string[] }>(r)),
  adminSetChannels: (username: string, channels: string[]) =>
    fetch(`/api/admin/users/${encodeURIComponent(username)}/channels`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels }),
    }).then((r) => json<{ username: string; allowedChannels: string[] }>(r)),
  adminDeleteUser: (username: string) =>
    fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', credentials: 'include' }).then(
      (r) => json<{ ok: boolean }>(r),
    ),
  adminSetPassword: (username: string, newPassword: string) =>
    fetch(`/api/admin/users/${encodeURIComponent(username)}/password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword }),
    }).then((r) => json<{ ok: boolean }>(r)),
  changePassword: (currentPassword: string, newPassword: string, confirmPassword: string) =>
    fetch('/api/auth/change-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    }).then((r) => json<{ ok: boolean }>(r)),
  forgotPassword: (email: string) =>
    fetch('/api/auth/forgot-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }).then((r) => json<{ message: string }>(r)),
  resetPassword: (token: string, newPassword: string) =>
    fetch('/api/auth/reset-password', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    }).then((r) => json<{ ok: boolean }>(r)),
  hlsHealth: () =>
    fetch('/api/admin/hls-health', { credentials: 'include' }).then((r) =>
      json<{ channel: string; ageSec: number | null; stale: boolean }[]>(r),
    ),
  hlsToken: (channel: string, ttlMinutes = 120) =>
    fetch('/api/hls-tokens', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, ttlMinutes }),
    }).then((r) => json<{ token: string; exp: number; url: string }>(r)),
  pullToken: (channel: string) =>
    fetch('/api/pull-tokens', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel }),
    }).then((r) => json<{ channel: string; pull: string; url: string }>(r)),
  streamScan: (input: string) =>
    fetch('/api/stream-scan', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }).then((r) => json<{ programs: { serviceId: number; name: string | null }[]; elapsedMs: number }>(r)),
  publicChannels: () =>
    fetch('/api/public/channels', { credentials: 'include' }).then((r) =>
      json<{
        generatedAt: string;
        baseUrl: string;
        channels: {
          name: string;
          serviceId: number;
          sourceId: string;
          status: string;
          live: boolean;
          epgId: number | null;
          hls: string;
        }[];
      }>(r),
    ),
  epgStatus: () => fetch('/api/epg/status', { credentials: 'include' }).then((r) => json<EpgStatus>(r)),
  epgSync: (partnerChannelId?: number) =>
    fetch('/api/admin/epg-sync', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partnerChannelId === undefined ? {} : { partnerChannelId }),
    }).then((r) => json<{ mappings: number; days: number; updated: number; skipped: number }>(r)),
  partnerChannels: (search = '', page = 0, limit = 200) =>
    fetch(
      `/api/epg/partner-channels?search=${encodeURIComponent(search)}&page=${page}&limit=${limit}`,
      { credentials: 'include' },
    ).then((r) => json<{ channels: { id: number; name: string; description: string }[]; total: number }>(r)),
  epgSchedule: (channel: string, date: string) =>
    fetch(`/api/epg/schedule?channel=${encodeURIComponent(channel)}&date=${encodeURIComponent(date)}`, {
      credentials: 'include',
    }).then((r) => json<EpgDayView>(r)),
  notifyStatus: () =>
    fetch('/api/admin/notify-status', { credentials: 'include' }).then((r) =>
      json<{ configured: boolean }>(r),
    ),
  notifyTest: () =>
    fetch('/api/admin/notify-test', { method: 'POST', credentials: 'include' }).then((r) =>
      json<{ result: string; configured: boolean }>(r),
    ),
  configBackup: () =>
    fetch('/api/admin/config-backup', { credentials: 'include' }).then((r) =>
      json<{ exportedAt: string; sources: Source[] }>(r),
    ),
  configRestore: (sources: unknown[]) =>
    fetch('/api/admin/config-restore', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources }),
    }).then((r) => json<{ ok: boolean; count: number }>(r)),
};

/** URL playlist timeshift (SPTS) của 1 chương trình — backend dựng trong RAM. */
export function timeshiftUrl(channelName: string, inMs: number, outMs: number): string {
  return `/api/timeshift/${encodeURIComponent(channelName)}?in=${inMs}&out=${outMs}`;
}
