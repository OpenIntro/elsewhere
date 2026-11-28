/**
 * Typed REST client for the shared API routes. Same-origin in production;
 * proxied by Vite in dev.
 */
import {
  API,
  type ApiError,
  type ErrorCode,
  type GazetteIssueResponse,
  type GazetteListQuery,
  type GazetteListResponse,
  type GuestSessionRequest,
  type HealthResponse,
  type LoginRequest,
  type MemoryListQuery,
  type MemoryListResponse,
  type ProfileResponse,
  type RegisterRequest,
  type SaveProfileRequest,
  type SessionResponse,
} from '@elsewhere/shared';

export class RestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}

function qs(params: object): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : '';
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ApiError | null)?.error;
    throw new RestError(res.status, err?.code ?? 'internal', err?.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export const rest = {
  health: () => request<HealthResponse>('GET', API.health),
  guestSession: (req: GuestSessionRequest) => request<SessionResponse>('POST', API.guestSession, req),
  register: (req: RegisterRequest) => request<SessionResponse>('POST', API.register, req),
  login: (req: LoginRequest) => request<SessionResponse>('POST', API.login, req),
  logout: () => request<{ ok: true }>('POST', API.logout, {}),
  getProfile: () => request<ProfileResponse>('GET', API.profile),
  saveProfile: (req: SaveProfileRequest) => request<ProfileResponse>('PUT', API.profile, req),
  gazette: (q: GazetteListQuery = {}) => request<GazetteListResponse>('GET', `${API.gazette}${qs(q)}`),
  gazetteIssue: (id: string) => request<GazetteIssueResponse>('GET', API.gazetteIssue.replace(':id', encodeURIComponent(id))),
  memory: (q: MemoryListQuery = {}) => request<MemoryListResponse>('GET', `${API.memory}${qs(q)}`),
};
