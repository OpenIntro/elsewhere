/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * The Elsewhere Gazette: every CONFIG.gazette.issueIntervalMs, compile an
 * issue from REAL World Memory events in the period using templates
 * (server/src/gazette/templates.ts — to be written). Articles must list the
 * eventIds they were generated from. Never invent events.
 *
 * Foundation stub: lists whatever persistence holds; compileIssue not implemented.
 */
import type { GazetteIssue } from '@elsewhere/shared';
import { notImplemented } from '../http/errors.js';
import type { PersistenceService } from '../persistence/index.js';

export interface GazetteService {
  list(limit: number, before?: string): Promise<GazetteIssue[]>;
  get(id: string): Promise<GazetteIssue | null>;
  /** Compile (and persist) an issue covering [periodStart, periodEnd). Returns null if nothing happened. */
  compileIssue(periodStart: number, periodEnd: number): Promise<GazetteIssue | null>;
  /** Begin the periodic compile schedule. */
  start(): void;
  stop(): void;
}

export function createGazette(persistence: PersistenceService): GazetteService {
  return {
    list: (limit, before) => persistence.gazette.list(Math.min(50, Math.max(1, limit)), before),
    get: (id) => persistence.gazette.get(id),
    async compileIssue() {
      throw notImplemented('Gazette compilation');
    },
    start() {},
    stop() {},
  };
}
