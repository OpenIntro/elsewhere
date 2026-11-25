/**
 * Admin REST tools, gated by the ADMIN_TOKEN env (Authorization: Bearer <ADMIN_TOKEN>
 * or X-Admin-Token). When ADMIN_TOKEN is unset every admin route answers 404.
 *
 *   GET    /api/admin/reports?limit=50
 *   GET    /api/admin/sanctions?active=1
 *   POST   /api/admin/sanctions        { profileId, kind: 'chat_mute'|'ban', minutes?, reason }
 *   DELETE /api/admin/sanctions/:id
 *   POST   /api/admin/kick             { profileId? , sessionId?, reason? }
 *   GET    /api/admin/players
 *   POST   /api/admin/gazette/compile  { periodStart?, periodEnd? }
 *   GET    /api/admin/build/pieces?owner=&limit=   placed pieces, newest first
 *   DELETE /api/admin/build/pieces/:id             remove a piece (+ what rests on it)
 *   DELETE /api/admin/build/profiles/:profileId    remove every piece of a profile
 *   GET    /api/admin/build/stats?bench=1&reset=1  counts, validation/collision timing, event-loop delay (reset: new window)
 *   GET    /api/admin/notes?board=&limit=          notices / guest-book / tide-log entries (removed included)
 *   DELETE /api/admin/notes/:id                    remove one entry (moderation)
 * Sanction kinds: chat_mute | ban | build_ban (may play and chat, may not build).
 */
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { API } from '@elsewhere/shared';
import { ENV } from '../env.js';
import { roomRegistry } from '../rooms/RoomContext.js';
import { services } from '../services.js';
import { ApiFailure } from './errors.js';

function isAdmin(req: Request): boolean {
  const expected = ENV.adminToken;
  if (!expected) return false;
  const h = req.headers.authorization;
  const given = h?.startsWith('Bearer ') ? h.slice(7) : typeof req.headers['x-admin-token'] === 'string' ? req.headers['x-admin-token'] : '';
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  if (!ENV.adminToken) return next(new ApiFailure('not_found', 'Unknown API route'));
  if (!isAdmin(req)) return next(new ApiFailure('unauthorized', 'Admin token required'));
  fn(req, res).then((body) => {
    if (!res.headersSent) res.json(body);
  }, next);
};

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

export function createAdminRouter(): Router {
  const r = express.Router();

  r.get(
    API.adminReports,
    route(async (req) => {
      const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit ?? '50'), 10) || 50));
      return { reports: await services().persistence.reports.list(limit) };
    }),
  );

  r.get(
    API.adminSanctions,
    route(async (req) => {
      const p = services().persistence;
      return { sanctions: req.query.active ? await p.sanctions.active(Date.now()) : await p.sanctions.list(200) };
    }),
  );

  r.post(
    API.adminSanctions,
    route(async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const profileId = str(b.profileId, 80);
      const kind = b.kind === 'ban' || b.kind === 'chat_mute' || b.kind === 'build_ban' ? b.kind : undefined;
      if (!profileId || !kind) throw new ApiFailure('bad_request', 'profileId and kind (chat_mute|ban|build_ban) required');
      if (!(await services().persistence.profiles.get(profileId))) throw new ApiFailure('not_found', 'No such profile');
      const minutes = b.minutes === undefined || b.minutes === null ? null : Number(b.minutes);
      if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) throw new ApiFailure('bad_request', 'minutes must be a positive number (omit for permanent)');
      const sanction = await services().moderation.sanction({ profileId, kind, minutes, reason: str(b.reason, 300) ?? 'admin action', createdBy: 'admin' });
      return { sanction };
    }),
  );

  r.delete(
    API.adminSanction,
    route(async (req) => {
      const ok = await services().moderation.revokeSanction(String(req.params.id));
      if (!ok) throw new ApiFailure('not_found', 'No active sanction with that id');
      return { ok: true };
    }),
  );

  r.post(
    API.adminKick,
    route(async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const profileId = str(b.profileId, 80);
      const sessionId = str(b.sessionId, 80);
      if (!profileId && !sessionId) throw new ApiFailure('bad_request', 'profileId or sessionId required');
      let kicked = 0;
      for (const ctx of roomRegistry) {
        const sid = sessionId && ctx.getPlayer(sessionId) ? sessionId : profileId ? ctx.sessionForProfile(profileId) : undefined;
        if (sid) {
          ctx.kick(sid, str(b.reason, 200) ?? 'kicked');
          kicked++;
        }
      }
      return { kicked };
    }),
  );

  r.get(
    API.adminPlayers,
    route(async () => {
      const players: { roomId: string; sessionId: string; profileId: string; name: string; location: string }[] = [];
      for (const ctx of roomRegistry) {
        for (const sid of ctx.sessionIds()) {
          const p = ctx.getPlayer(sid);
          if (p) players.push({ roomId: ctx.roomId, sessionId: sid, profileId: p.profileId, name: p.name, location: p.location });
        }
      }
      return { players };
    }),
  );

  r.post(
    API.adminGazetteCompile,
    route(async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const g = services().gazette;
      const start = Number(b.periodStart);
      const end = Number(b.periodEnd);
      const issue = Number.isFinite(start) && start > 0 ? await g.compileIssue(start, Number.isFinite(end) && end > start ? end : Date.now()) : await g.compileDue();
      return { issue };
    }),
  );

  r.get(
    API.adminBuildPieces,
    route(async (req) => {
      const b = services().building;
      const owner = str(req.query.owner, 80);
      const limit = Math.min(5000, Math.max(1, Number.parseInt(String(req.query.limit ?? '200'), 10) || 200));
      return { total: b.index.size, pieces: b.list({ ...(owner ? { ownerId: owner } : {}), limit }) };
    }),
  );

  r.delete(
    API.adminBuildPiece,
    route(async (req) => {
      const removed = await services().building.adminRemove([String(req.params.id)]);
      if (!removed.length) throw new ApiFailure('not_found', 'No such piece');
      return { removed };
    }),
  );

  r.delete(
    API.adminBuildProfile,
    route(async (req) => ({ removed: await services().building.adminRemoveProfile(String(req.params.profileId)) })),
  );

  r.get(
    API.adminNotes,
    route(async (req) => {
      const limit = Math.min(500, Math.max(1, Number.parseInt(String(req.query.limit ?? '100'), 10) || 100));
      return { notes: await services().activities.listNotes(str(req.query.board, 60), limit) };
    }),
  );

  r.delete(
    API.adminNote,
    route(async (req) => {
      const ok = await services().activities.adminRemoveNote(String(req.params.id));
      if (!ok) throw new ApiFailure('not_found', 'No such entry (or already removed)');
      return { ok: true };
    }),
  );

  r.get(
    API.adminBuildStats,
    route(async (req) => services().building.stats(req.query.bench === '1', req.query.reset === '1')),
  );

  return r;
}
