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

export const getMe = () => api<Me>('/api/v1/me');
export const getLeagues = () => api<{ leagues: League[] }>('/api/v1/leagues');
export const getLeague = (id: string) => api<LeagueDetail>(`/api/v1/leagues/${id}`);
export const getUsers = () => api<{ users: UserRow[] }>('/api/v1/users');
export const getAudit = () => api<{ entries: AuditEntry[] }>('/api/v1/audit?limit=100');
