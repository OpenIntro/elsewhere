/** Server environment configuration (read once at boot). See .env.example. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DEFAULT_PORT } from '@elsewhere/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

// Optional repo-root `.env` (see .env.example). Real environment variables always win
// (process.loadEnvFile never overrides them). Skipped under vitest so tests stay hermetic.
const envFile = path.resolve(here, '..', '..', '.env');
if (!process.env.VITEST && fs.existsSync(envFile)) process.loadEnvFile(envFile);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function numList(name: string, fallback: readonly number[]): readonly number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const out = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return out.length ? out : fallback;
}

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

const isProduction = process.env.NODE_ENV === 'production';
const INSECURE_SECRET = 'dev-insecure-secret-change-me';

export const ENV = {
  port: num('PORT', DEFAULT_PORT),
  isProduction,
  /** Local persistence directory (gitignored). PGlite lives in `${dataDir}/pglite`. */
  dataDir: path.resolve(str('DATA_DIR') ?? path.join(here, '..', 'data')),
  /** Real Postgres / Supabase connection string. When unset, embedded PGlite is used. */
  databaseUrl: str('DATABASE_URL'),
  /** Built client to serve (server/dist -> ../../client/dist, server/src -> same). */
  clientDist: path.resolve(str('CLIENT_DIST') ?? path.join(here, '..', '..', 'client', 'dist')),
  dayLengthMs: Math.max(1, num('DAY_LENGTH_MINUTES', CONFIG.clock.dayLengthMinutes)) * 60_000,
  /** Token signing secret (HMAC over opaque tokens). Required in production. */
  sessionSecret: process.env.SESSION_SECRET || INSECURE_SECRET,
  insecureSecret: !process.env.SESSION_SECRET,
  /** Admin REST tools are disabled unless this is set (>= 16 chars). */
  adminToken: str('ADMIN_TOKEN'),
  /** Optional Supabase auth: HS256 JWT secret and/or project URL (for JWKS asymmetric keys). */
  supabaseJwtSecret: str('SUPABASE_JWT_SECRET'),
  supabaseUrl: str('SUPABASE_URL'),
  /** Trust X-Forwarded-For (behind a reverse proxy) for per-IP rate limits. */
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  gazetteIntervalMs: num('GAZETTE_INTERVAL_MINUTES', CONFIG.gazette.issueIntervalMs / 60_000) * 60_000,
  gazetteEarlyEvents: Math.max(1, Math.round(num('GAZETTE_EARLY_EVENTS', CONFIG.gazette.earlyIssueSignificantEvents))),
  gazetteEarlyDelayMs: Math.max(0, num('GAZETTE_EARLY_DELAY_SECONDS', CONFIG.gazette.earlyIssueDelayMs / 1000)) * 1000,
  /** Collective Reality threshold overrides (testing / small communities). */
  collective: {
    fountainStages: numList('FOUNTAIN_STAGES', CONFIG.collective.fountainStages),
    fountainStageDistinct: numList('FOUNTAIN_STAGE_DISTINCT', CONFIG.collective.fountainStageDistinct),
    portalRunesRequired: Math.max(1, Math.round(num('PORTAL_RUNES_REQUIRED', CONFIG.collective.portalRunesRequired))),
    portalWindowMs: num('PORTAL_WINDOW_MS', CONFIG.collective.portalWindowMs),
    portalAwakeMs: num('PORTAL_AWAKE_MS', CONFIG.collective.portalAwakeMs),
    bellChorusPlayers: Math.max(2, Math.round(num('BELL_CHORUS_PLAYERS', CONFIG.collective.bellChorusPlayers))),
    gatheringThreshold: Math.max(2, Math.round(num('GATHERING_THRESHOLD', CONFIG.collective.gatheringThreshold))),
  },
  /** Player building (defaults in CONFIG.building / CONFIG.rateLimits.build). */
  building: {
    enabled: !(process.env.BUILD_ENABLED === '0' || process.env.BUILD_ENABLED === 'false'),
    range: Math.max(1, num('BUILD_RANGE', CONFIG.building.range)),
    maxPerPlayer: Math.max(0, Math.round(num('BUILD_MAX_PER_PLAYER', CONFIG.building.maxPiecesPerPlayer))),
    maxPerWorld: Math.max(0, Math.round(num('BUILD_MAX_PER_WORLD', CONFIG.building.maxPiecesPerWorld))),
    rate: {
      capacity: Math.max(1, num('BUILD_RATE_CAPACITY', CONFIG.rateLimits.build.capacity)),
      refillPerSecond: Math.max(0.01, num('BUILD_RATE_PER_SECOND', CONFIG.rateLimits.build.refillPerSecond)),
    },
  },
  version: process.env.npm_package_version ?? '0.1.0',
} as const;

export type BuildingTunables = (typeof ENV)['building'];

export type CollectiveTunables = (typeof ENV)['collective'];

/** Fail fast on unsafe production configuration. */
export function assertProductionSafe(): void {
  if (!ENV.isProduction) return;
  if (ENV.insecureSecret || ENV.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set (>= 32 chars) in production');
  }
  if (ENV.adminToken && ENV.adminToken.length < 16) throw new Error('ADMIN_TOKEN must be >= 16 chars');
}
