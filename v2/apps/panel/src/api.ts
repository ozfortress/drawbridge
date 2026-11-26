export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? '') : undefined;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (MUTATING.has(method)) {
    const csrf = readCookie('drawbridge_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const response = await fetch(path, { ...init, method, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

export interface Me {
  user: {
    id: string;
    discordId: string;
    displayName: string;
    tier: 'root' | 'admin' | 'helper' | 'user' | 'guest';
    status: string;
  };
  csrfToken: string;
  globalCapabilities: string[];
  lastLoginAt: string | null;
}

export interface League {
  id: string;
  guildId: string;
  citadelLeagueId: number;
  name: string;
  shortcode: string;
  status: string;
  timezone: string;
  createdAt: string;
}

export interface LeagueRole {
  id: string;
  rank: number;
  name: string;
  capabilities: string[];
}

export interface LeagueDetail {
  league: League;
  access: { tier: string; leagueRank: number | null; capabilities: string[] };
  roles: LeagueRole[];
}

export interface UserRow {
  id: string;
  discordId: string;
  displayName: string;
  globalRole: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  actorDiscordId: string | null;
  targetType: string | null;
  targetId: string | null;
  leagueId: string | null;
}

export interface PreviewEntry {
  citadelRosterId: string;
  citadelTeamId: string;
  name: string;
  roleName: string;
  channelName: string;
}

export interface PreviewDivision {
  name: string;
  categoryName: string;
  roleName: string;
  entries: PreviewEntry[];
}

export interface PreviewWarning {
  code: string;
  subject: string;
  message: string;
}

export interface PreviewCaptain {
  citadelTeamId: string;
  citadelUserId: string;
  name: string;
  discordId: string | null;
  division: string;
  entryName: string;
  status: 'will-assign' | 'not-linked';
  roleNames: string[];
}

export interface PreviewCapacity {
  status: 'fit' | 'refused' | 'split';
  roleCount: number;
  channelCount: number;
  categoryCount: number;
  refusals: Array<{ scope: string; limit: number; actual: number; message: string }>;
  splits: Array<{
    name: string;
    parts: Array<{ name: string; channelCount: number }>;
  }>;
}

export interface LeaguePreview {
  previewId: string;
  planHash: string;
  plan: {
    divisions: PreviewDivision[];
    counts: {
      divisions: number;
      entries: number;
      categories: number;
      roles: number;
      channels: number;
      steps: number;
    };
  };
  warnings: PreviewWarning[];
  capacity: PreviewCapacity;
  captains: PreviewCaptain[];
}

export interface PreviewVerification {
  previewId: string;
  planHash: string;
  livePlanHash: string;
  changed: boolean;
  changedPaths: string[];
}

export interface CitadelKeyStatus {
  leagueId: string;
  configured: boolean;
  label: string | null;
  status: 'missing' | 'active' | 'revoked';
  lastVerifiedAt: string | null;
  createdAt?: string;
}

export const getMe = () => api<Me>('/api/v1/me');
export const getLeagues = () => api<{ leagues: League[] }>('/api/v1/leagues');
export const getLeague = (id: string) => api<LeagueDetail>(`/api/v1/leagues/${id}`);
export const getUsers = () => api<{ users: UserRow[] }>('/api/v1/users');
export const getAudit = () => api<{ entries: AuditEntry[] }>('/api/v1/audit?limit=100');
export const createLeaguePreview = (leagueId: string) =>
  api<LeaguePreview>(`/api/v1/leagues/${leagueId}/preview`, { method: 'POST' });
export const verifyLeaguePreview = (previewId: string) =>
  api<PreviewVerification>(`/api/v1/previews/${previewId}/verify`, { method: 'POST' });
export const getCitadelKey = (leagueId: string) =>
  api<CitadelKeyStatus>(`/api/v1/leagues/${leagueId}/citadel-key`);
export const setCitadelKey = (leagueId: string, key: string, label: string) =>
  api<CitadelKeyStatus>(`/api/v1/leagues/${leagueId}/citadel-key`, {
    method: 'PUT',
    body: JSON.stringify({ key, ...(label ? { label } : {}) }),
  });
export const revokeCitadelKey = (leagueId: string) =>
  api<CitadelKeyStatus>(`/api/v1/leagues/${leagueId}/citadel-key`, { method: 'DELETE' });
