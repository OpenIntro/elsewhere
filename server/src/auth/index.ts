/**
 * Sessions and accounts. Tokens are opaque bearer strings carried in REST
 * `Authorization: Bearer <token>` and in JoinOptions.token.
 *
 * Token format: `es1.<32 random bytes b64url>.<HMAC-SHA256(secret, random) first 16 bytes b64url>`.
 * The HMAC lets us reject forged/garbled tokens without a DB hit; the DB stores
 * only sha256(random) (a leaked DB cannot be replayed as tokens). Sessions are
 * persisted, so a returning guest resumes their profile after a server restart.
 *
 * Passwords: scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte salt), compared
 * with timingSafeEqual. Never stored or logged in plaintext.
 *
 * Optional Supabase auth (cannot be exercised in CI here): when
 * SUPABASE_JWT_SECRET (HS256) and/or SUPABASE_URL (JWKS for RS256/ES256) are
 * set, a Supabase access token is accepted wherever a session token is. Its
 * `sub` maps to a registered profile (externalId `supabase:<sub>`), created on
 * first sight. `exp`, `nbf`, and (when SUPABASE_URL is set) `iss` are checked.
 */
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  CONFIG,
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
import { ApiFailure } from '../http/errors.js';
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
  /** Resolve a token to an identity, or null if invalid/expired/revoked. */
  verify(token: string | undefined): Promise<AuthIdentity | null>;
}

export interface AuthOptions {
  secret: string;
  supabaseJwtSecret?: string | undefined;
  supabaseUrl?: string | undefined;
  now?: () => number;
}

export function toProfileSummary(p: StoredProfile): ProfileSummary {
  const s: ProfileSummary = {
    profileId: p.id,
    name: p.displayName,
    appearance: p.appearance,
    kind: p.kind,
    discoveries: [...p.discoveries],
    firstVisitAt: p.createdAt,
    visits: p.visits,
    inventory: [...(p.inventory ?? [])],
    stats: { ...(p.stats ?? {}) },
  };
  if (p.username) s.username = p.username;
  return s;
}

export function newGuestProfile(name?: unknown, appearance?: unknown): StoredProfile {
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
    inventory: [],
    lastPosition: null,
    stats: {},
    blocked: [],
    muted: [],
  };
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password, Buffer.from(salt, 'base64url'), Number(N), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A fixed dummy hash so unknown-username logins cost the same as wrong-password ones.
let dummyHash: Promise<string> | null = null;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateUsername(raw: unknown): { ok: true; username: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'Username required' };
  const u = raw.trim().toLowerCase();
  const { usernameMin, usernameMax } = CONFIG.auth;
  if (u.length < usernameMin || u.length > usernameMax) return { ok: false, message: `Username must be ${usernameMin}-${usernameMax} characters` };
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(u)) return { ok: false, message: 'Username may contain letters, digits, _ . -' };
  return { ok: true, username: u };
}

export function validatePassword(raw: unknown): { ok: true; password: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'Password required' };
  const { passwordMin, passwordMax } = CONFIG.auth;
  if (raw.length < passwordMin) return { ok: false, message: `Password must be at least ${passwordMin} characters` };
  if (raw.length > passwordMax) return { ok: false, message: `Password must be at most ${passwordMax} characters` };
  return { ok: true, password: raw };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = 'es1';
const DAY = 24 * 60 * 60 * 1000;
const LOGIN_FAILS_MAX = 6;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;

export function createAuth(persistence: PersistenceService, options: AuthOptions): AuthService {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { identity: AuthIdentity; expiresAt: number; cachedUntil: number }>();
  const loginFails = new Map<string, number[]>();

  const sign = (raw: string) => createHmac('sha256', options.secret).update(raw).digest().subarray(0, 16).toString('base64url');
  const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

  async function issue(profile: StoredProfile): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    const t = now();
    const days = profile.kind === 'guest' ? CONFIG.auth.guestSessionDays : CONFIG.auth.accountSessionDays;
    await persistence.sessions.create({ tokenHash: hashToken(raw), profileId: profile.id, kind: profile.kind, createdAt: t, expiresAt: t + days * DAY, revokedAt: null });
    return `${TOKEN_PREFIX}.${raw}.${sign(raw)}`;
  }

  function parseToken(token: string): string | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    const [, raw, mac] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(raw)) return null;
    const a = Buffer.from(mac);
    const b = Buffer.from(sign(raw));
    return a.length === b.length && timingSafeEqual(a, b) ? raw : null;
  }

  async function verifyOwn(token: string): Promise<AuthIdentity | null> {
    const raw = parseToken(token);
    if (!raw) return null;
    const h = hashToken(raw);
    const t = now();
    const hit = cache.get(h);
    if (hit && hit.cachedUntil > t && hit.expiresAt > t) return hit.identity;
    const s = await persistence.sessions.get(h);
    if (!s || s.revokedAt !== null || s.expiresAt <= t) {
      cache.delete(h);
      return null;
    }
    // Kind comes from the profile (a guest session survives an upgrade only if not revoked).
    const p = await persistence.profiles.get(s.profileId);
    if (!p) return null;
    const identity: AuthIdentity = { profileId: p.id, kind: p.kind };
    cache.set(h, { identity, expiresAt: s.expiresAt, cachedUntil: t + 60_000 });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value as string);
    return identity;
  }

  const supabase = options.supabaseJwtSecret || options.supabaseUrl ? createSupabaseVerifier(options.supabaseJwtSecret, options.supabaseUrl, now) : null;

  async function verifySupabase(token: string): Promise<AuthIdentity | null> {
    if (!supabase) return null;
    const claims = await supabase(token);
    if (!claims || typeof claims.sub !== 'string') return null;
    const externalId = `supabase:${claims.sub}`;
    let p = await persistence.profiles.getByExternalId(externalId);
    if (!p) {
      const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
      p = newGuestProfile(meta.display_name ?? meta.name ?? meta.full_name);
      p.id = `sb_${claims.sub}`.slice(0, 64);
      p.kind = 'registered';
      p.externalId = externalId;
      await persistence.profiles.save(p);
    }
    return { profileId: p.id, kind: 'registered' };
  }

  function recordFail(key: string): void {
    const t = now();
    const arr = (loginFails.get(key) ?? []).filter((x) => t - x < LOGIN_FAIL_WINDOW_MS);
    arr.push(t);
    loginFails.set(key, arr);
  }
  function lockedOut(key: string): boolean {
    const t = now();
    const arr = (loginFails.get(key) ?? []).filter((x) => t - x < LOGIN_FAIL_WINDOW_MS);
    loginFails.set(key, arr);
    return arr.length >= LOGIN_FAILS_MAX;
  }

  async function assertNotBanned(profileId: string): Promise<void> {
    const bans = (await persistence.sanctions.active(now(), profileId)).filter((s) => s.kind === 'ban');
    if (bans.length) throw new ApiFailure('forbidden', 'This account is suspended');
  }

  const service: AuthService = {
    async createGuestSession(req) {
      const body = (req && typeof req === 'object' ? req : {}) as GuestSessionRequest;
      if (typeof body.token === 'string' && body.token.length < 4096) {
        const identity = await service.verify(body.token);
        if (identity) {
          const p = await persistence.profiles.get(identity.profileId);
          if (p) {
            await assertNotBanned(p.id);
            return { token: body.token, profile: toProfileSummary(p) };
          }
        }
      }
      if (body.name !== undefined && body.name !== null && body.name !== '') {
        const v = validateDisplayName(body.name);
        if (!v.ok) throw new ApiFailure('invalid_name', `Name rejected: ${v.reason}`);
      }
      const profile = newGuestProfile(body.name, body.appearance);
      await persistence.profiles.save(profile);
      return { token: await issue(profile), profile: toProfileSummary(profile) };
    },

    async register(req) {
      const body = (req && typeof req === 'object' ? req : {}) as RegisterRequest;
      const u = validateUsername(body.username);
      if (!u.ok) throw new ApiFailure('bad_request', u.message);
      const pw = validatePassword(body.password);
      if (!pw.ok) throw new ApiFailure('bad_request', pw.message);
      const dn = validateDisplayName(body.displayName);
      if (!dn.ok) throw new ApiFailure('invalid_name', `Name rejected: ${dn.reason}`);
      if (await persistence.profiles.getByUsername(u.username)) throw new ApiFailure('name_taken', 'That username is taken');

      let profile: StoredProfile | null = null;
      if (typeof body.guestToken === 'string') {
        const identity = await service.verify(body.guestToken);
        if (identity?.kind === 'guest') profile = await persistence.profiles.get(identity.profileId);
      }
      const upgraded = !!profile;
      if (!profile) profile = newGuestProfile(dn.name);
      await assertNotBanned(profile.id);
      profile.kind = 'registered';
      profile.username = u.username;
      profile.displayName = dn.name;
      profile.passwordHash = await hashPassword(pw.password);
      try {
        await persistence.profiles.save(profile);
      } catch (err) {
        // Unique index race on username.
        if (String(err).includes('profiles_username_uq')) throw new ApiFailure('name_taken', 'That username is taken');
        throw err;
      }
      if (upgraded) {
        // The guest token is a weaker credential for what is now an account: retire it.
        await persistence.sessions.revokeAllForProfile(profile.id, now());
        cache.clear();
      }
      return { token: await issue(profile), profile: toProfileSummary(profile) };
    },

    async login(req) {
      const body = (req && typeof req === 'object' ? req : {}) as LoginRequest;
      const u = validateUsername(body.username);
      const password = typeof body.password === 'string' && body.password.length <= CONFIG.auth.passwordMax ? body.password : '';
      if (!u.ok || !password) throw new ApiFailure('unauthorized', 'Wrong username or password');
      if (lockedOut(u.username)) throw new ApiFailure('rate_limited', 'Too many failed attempts; try again later');
      const p = await persistence.profiles.getByUsername(u.username);
      if (!p || !p.passwordHash) {
        dummyHash ??= hashPassword('dummy-password-for-timing');
        await verifyPassword(password, await dummyHash);
        recordFail(u.username);
        throw new ApiFailure('unauthorized', 'Wrong username or password');
      }
      if (!(await verifyPassword(password, p.passwordHash))) {
        recordFail(u.username);
        throw new ApiFailure('unauthorized', 'Wrong username or password');
      }
      loginFails.delete(u.username);
      await assertNotBanned(p.id);
      return { token: await issue(p), profile: toProfileSummary(p) };
    },

    async logout(token) {
      const raw = parseToken(token);
      if (!raw) return;
      const h = hashToken(raw);
      cache.delete(h);
      await persistence.sessions.revoke(h, now());
    },

    async verify(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 4096) return null;
      if (token.startsWith(`${TOKEN_PREFIX}.`)) return verifyOwn(token);
      return verifySupabase(token).catch(() => null);
    },
  };
  return service;
}

// ---------------------------------------------------------------------------
// Supabase JWT verification (HS256 secret or JWKS RS256/ES256)
// ---------------------------------------------------------------------------

type Claims = Record<string, unknown> & { sub?: unknown; exp?: unknown; nbf?: unknown; iss?: unknown; aud?: unknown };

function createSupabaseVerifier(secret: string | undefined, url: string | undefined, now: () => number): (token: string) => Promise<Claims | null> {
  const issuer = url ? `${url.replace(/\/+$/, '')}/auth/v1` : undefined;
  let jwks: { at: number; keys: Map<string, { key: KeyObject; alg: string }> } | null = null;

  async function keyFor(kid: string | undefined): Promise<{ key: KeyObject; alg: string } | null> {
    if (!issuer) return null;
    if (!jwks || now() - jwks.at > 10 * 60_000) {
      const res = await fetch(`${issuer}/.well-known/jwks.json`);
      if (!res.ok) return null;
      const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
      const keys = new Map<string, { key: KeyObject; alg: string }>();
      for (const k of body.keys ?? []) {
        try {
          keys.set(String(k.kid ?? ''), { key: createPublicKey({ key: k as never, format: 'jwk' }), alg: String(k.alg ?? '') });
        } catch {
          /* skip unusable key */
        }
      }
      jwks = { at: now(), keys };
    }
    return jwks.keys.get(kid ?? '') ?? (jwks.keys.size === 1 ? ([...jwks.keys.values()][0] ?? null) : null);
  }

  return async (token) => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Claims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const signingInput = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    let ok = false;
    if (header.alg === 'HS256') {
      if (!secret) return null;
      const expected = createHmac('sha256', secret).update(signingInput).digest();
      ok = expected.length === sig.length && timingSafeEqual(expected, sig);
    } else if (header.alg === 'RS256' || header.alg === 'ES256') {
      const k = await keyFor(header.kid);
      if (!k) return null;
      ok = cryptoVerify('sha256', signingInput, header.alg === 'ES256' ? { key: k.key, dsaEncoding: 'ieee-p1363' } : k.key, sig);
    }
    if (!ok) return null;
    const t = now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp < t) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > t + 30) return null;
    if (issuer && claims.iss !== undefined && claims.iss !== issuer) return null;
    if (claims.aud !== undefined && claims.aud !== 'authenticated' && !(Array.isArray(claims.aud) && claims.aud.includes('authenticated'))) return null;
    return claims;
  };
}
