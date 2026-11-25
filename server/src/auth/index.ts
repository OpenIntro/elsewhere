/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Sessions and accounts. Tokens are opaque bearer strings carried in REST
 * `Authorization: Bearer <token>` and in JoinOptions.token.
 *
 * Foundation stub: guest sessions are kept in memory (random tokens);
 * register/login are not implemented. Replace with signed tokens (ENV.sessionSecret)
 * and password hashing (node:crypto scrypt) — never store plaintext passwords.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  randomAppearance,
  randomDisplayName,
  sanitizeAppearance,
  validateDisplayName,
  type GuestSessionRequest,
  type LoginRequest,
  type ProfileSummary,
  type RegisterRequest,
  type SessionResponse,
} from '@elsewhere/shared';
import { notImplemented } from '../http/errors.js';
import type { PersistenceService, StoredProfile } from '../persistence/index.js';

export interface AuthIdentity {
  profileId: string;
  kind: 'guest' | 'registered';
}

export interface AuthService {
  createGuestSession(req: GuestSessionRequest): Promise<SessionResponse>;
  register(req: RegisterRequest): Promise<SessionResponse>;
  login(req: LoginRequest): Promise<SessionResponse>;
  logout(token: string): Promise<void>;
  /** Resolve a token to an identity, or null if invalid/expired. */
  verify(token: string | undefined): Promise<AuthIdentity | null>;
}

export function toProfileSummary(p: StoredProfile): ProfileSummary {
  return {
    profileId: p.id,
    name: p.displayName,
    appearance: p.appearance,
    kind: p.kind,
    discoveries: p.discoveries,
    firstVisitAt: p.createdAt,
    visits: p.visits,
  };
}

export function newGuestProfile(name?: string, appearance?: unknown): StoredProfile {
  const v = validateDisplayName(name);
  const now = Date.now();
  return {
    id: `g_${randomUUID()}`,
    kind: 'guest',
    displayName: v.ok ? v.name : randomDisplayName(),
    appearance: appearance ? sanitizeAppearance(appearance) : randomAppearance(),
    createdAt: now,
    lastSeenAt: now,
    visits: 0,
    discoveries: [],
    blocked: [],
    muted: [],
  };
}

export function createAuth(persistence: PersistenceService): AuthService {
  const tokens = new Map<string, AuthIdentity>();
  return {
    async createGuestSession(req) {
      const existing = req.token ? tokens.get(req.token) : undefined;
      if (existing && req.token) {
        const p = await persistence.profiles.get(existing.profileId);
        if (p) return { token: req.token, profile: toProfileSummary(p) };
      }
      const profile = newGuestProfile(req.name, req.appearance);
      await persistence.profiles.save(profile);
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, { profileId: profile.id, kind: 'guest' });
      return { token, profile: toProfileSummary(profile) };
    },
    async register() {
      throw notImplemented('Registration');
    },
    async login() {
      throw notImplemented('Login');
    },
    async logout(token) {
      tokens.delete(token);
    },
    async verify(token) {
      return token ? (tokens.get(token) ?? null) : null;
    },
  };
}
