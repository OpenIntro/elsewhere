/**
 * REST API (paths from shared API). Thin: validation + delegation to services.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { matchMaker } from '@colyseus/core';
import {
  API,
  ROOM_NAME,
  type GazetteIssueResponse,
  type GazetteListResponse,
  type HealthResponse,
  type MemoryListResponse,
  type ProfileResponse,
  type SessionResponse,
  type WorldEventKind,
  type LocationId,
} from '@elsewhere/shared';
import { sanitizeAppearance, validateDisplayName } from '@elsewhere/shared';
import { toProfileSummary } from '../auth/index.js';
import { ENV } from '../env.js';
import { services } from '../services.js';
import { ApiFailure } from './errors.js';

const startedAt = Date.now();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((body) => {
    if (!res.headersSent) res.json(body);
  }, next);
};

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

async function requireProfile(req: Request) {
  const s = services();
  const identity = await s.auth.verify(bearer(req));
  if (!identity) throw new ApiFailure('unauthorized', 'Missing or invalid session token');
  const profile = await s.persistence.profiles.get(identity.profileId);
  if (!profile) throw new ApiFailure('not_found', 'Profile not found');
  return profile;
}

function intParam(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function createApiRouter(): Router {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  r.get(
    API.health,
    route(async (): Promise<HealthResponse> => {
      const rooms = await matchMaker.query({ name: ROOM_NAME });
      return {
        ok: true,
        version: ENV.version,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        rooms: rooms.length,
        players: rooms.reduce((n, room) => n + room.clients, 0),
        serverTime: Date.now(),
      };
    }),
  );

  r.post(API.guestSession, route(async (req): Promise<SessionResponse> => services().auth.createGuestSession(req.body ?? {})));
  r.post(API.register, route(async (req): Promise<SessionResponse> => services().auth.register(req.body ?? {})));
  r.post(API.login, route(async (req): Promise<SessionResponse> => services().auth.login(req.body ?? {})));
  r.post(
    API.logout,
    route(async (req) => {
      const t = bearer(req);
      if (t) await services().auth.logout(t);
      return { ok: true };
    }),
  );

  r.get(API.profile, route(async (req): Promise<ProfileResponse> => ({ profile: toProfileSummary(await requireProfile(req)) })));
  r.put(
    API.profile,
    route(async (req): Promise<ProfileResponse> => {
      const profile = await requireProfile(req);
      const body = (req.body ?? {}) as { name?: unknown; appearance?: unknown };
      if (body.name !== undefined) {
        const v = validateDisplayName(body.name);
        if (!v.ok) throw new ApiFailure('invalid_name', `Name rejected: ${v.reason}`);
        profile.displayName = v.name;
      }
      if (body.appearance !== undefined) profile.appearance = sanitizeAppearance(body.appearance);
      await services().persistence.profiles.save(profile);
      return { profile: toProfileSummary(profile) };
    }),
  );

  r.get(
    API.gazette,
    route(async (req): Promise<GazetteListResponse> => {
      const limit = Math.min(50, Math.max(1, intParam(req.query.limit, 10)));
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const issues = await services().gazette.list(limit, before);
      return { issues, nextCursor: issues.length === limit ? (issues[issues.length - 1]?.id ?? null) : null };
    }),
  );
  r.get(
    API.gazetteIssue,
    route(async (req): Promise<GazetteIssueResponse> => {
      const issue = await services().gazette.get(String(req.params.id));
      if (!issue) throw new ApiFailure('not_found', 'No such issue');
      return { issue };
    }),
  );

  r.get(
    API.memory,
    route(async (req): Promise<MemoryListResponse> => {
      const limit = Math.min(200, Math.max(1, intParam(req.query.limit, 50)));
      const q = req.query;
      const events = await services().memory.list({
        limit,
        ...(typeof q.before === 'string' ? { before: q.before } : {}),
        ...(typeof q.kind === 'string' ? { kind: q.kind as WorldEventKind } : {}),
        ...(typeof q.locationId === 'string' ? { locationId: q.locationId as LocationId } : {}),
        ...(typeof q.profileId === 'string' ? { profileId: q.profileId } : {}),
      });
      return { events, nextCursor: events.length === limit ? (events[events.length - 1]?.id ?? null) : null };
    }),
  );

  r.use('/api', (_req, res) => {
    res.status(404).json(new ApiFailure('not_found', 'Unknown API route').toBody());
  });

  // Error handler (typed ApiError bodies).
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiFailure) {
      res.status(err.status).json(err.toBody());
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: unknown }).type === 'entity.parse.failed') {
      res.status(400).json(new ApiFailure('bad_request', 'Malformed JSON').toBody());
      return;
    }
    console.error('[api] unhandled error', err);
    res.status(500).json(new ApiFailure('internal', 'Internal error').toBody());
  });
  return r;
}
