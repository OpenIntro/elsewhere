/** Server environment configuration (read once at boot). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DEFAULT_PORT } from '@elsewhere/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const ENV = {
  port: num('PORT', DEFAULT_PORT),
  isProduction: process.env.NODE_ENV === 'production',
  /** Local persistence directory (gitignored). */
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(here, '..', 'data')),
  /** Built client to serve (server/dist -> ../../client/dist, server/src -> same). */
  clientDist: path.resolve(process.env.CLIENT_DIST ?? path.join(here, '..', '..', 'client', 'dist')),
  dayLengthMs: num('DAY_LENGTH_MINUTES', CONFIG.clock.dayLengthMinutes) * 60_000,
  /** Token signing secret; auth worker must refuse the insecure default in production. */
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  version: process.env.npm_package_version ?? '0.1.0',
} as const;
