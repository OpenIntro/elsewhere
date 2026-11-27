/**
 * Homes, server-authoritative ("Make this my home", migration 6).
 *
 *  - Rule: shared `checkHouse` over the OWNER's pieces only (a neighbour's
 *    pieces never change whether your house is a home).
 *  - State: one home per profile per world, kept in memory (profile → door
 *    piece, pin, the recomputed room) and in table `homes` (door piece only).
 *  - Messages: C2S.homeSet / homeClear / homePin, rate-limited per PROFILE
 *    (CONFIG.rateLimits.home), each answered with S2C.homeResult. Setting is
 *    refused while build-banned; only the builder of the house may set it.
 *  - Upkeep: after every committed change of the owner's pieces within 1 m of
 *    the home (own place / remove, sign edits, cascades, admin removal of
 *    pieces or of a whole profile) the room is recomputed; if it no longer
 *    qualifies the home is cleared, its row deleted and the owner told.
 *  - Sync (not in the Colyseus schema): S2C.homes to a client right after its
 *    build snapshot (join and C2S.buildSync); S2C.homeChanged to every room of
 *    the world. `pinned` is filtered per recipient: false for anyone in a
 *    block relation with the owner (either way) and for everyone while the
 *    owner is banned / build-banned; block changes and sanctions re-send at
 *    once (linkModeration), expiring sanctions within HOME_SANCTION_RECHECK_MS.
 *  - Memory: `home_made` once per profile per door piece; no location.
 */
import {
  CONFIG,
  HOME_REFUSAL_TEXT,
  S2C,
  checkHouse,
  footprintOf,
  type HomePinPayload,
  type HomeRefusal,
  type HomeResultPayload,
  type HomeSetPayload,
  type HomeWire,
  type House,
  type PieceRecord,
  type RateLimitRule,
  type Rect,
} from '@elsewhere/shared';
import type { BuildingService, PieceChange } from '../building/index.js';
import type { MemoryService } from '../memory/index.js';
import type { ModerationService } from '../moderation/index.js';
import { RateLimiter } from '../moderation/rateLimit.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';
import { createHomeRepository, type HomeRepository } from './repository.js';

/** A change of the owner's pieces this close to the home's room (metres) re-checks it. */
export const HOME_RECHECK_MARGIN = 1;
/** Sanctions that run out on their own are noticed this often. */
export const HOME_SANCTION_RECHECK_MS = 30_000;
/** Pieces further than this from a piece cannot be part of its room (largest room 12 m). */
const ROOM_REACH = CONFIG.building.roof.maxSpan + 1;

export interface HomeRecord {
  profileId: string;
  ownerName: string;
  doorPieceId: string;
  showOnMap: boolean;
  createdAt: number;
  house: House;
}

export interface HomesDeps {
  persistence: PersistenceService;
  memory: MemoryService;
  moderation: ModerationService;
  building: BuildingService;
  worldId?: string;
  now?: () => number;
  /** Rate limit of the three messages (default CONFIG.rateLimits.home). */
  rate?: RateLimitRule;
}

export interface HomesService extends RoomHooks {
  load(): Promise<void>;
  set(ctx: RoomContext, sessionId: string, payload: HomeSetPayload): Promise<void>;
  clear(ctx: RoomContext, sessionId: string): Promise<void>;
  pin(ctx: RoomContext, sessionId: string, payload: HomePinPayload): Promise<void>;
  get(profileId: string): HomeRecord | undefined;
  list(): HomeRecord[];
  /** The home as `recipientProfileId` may see it (pinned filtered). */
  wireFor(home: HomeRecord, recipientProfileId: string | undefined): HomeWire;
  /** Send every home to one client (after its build snapshot). */
  sendAll(ctx: RoomContext, sessionId: string): void;
  /** A profile blocked / unblocked someone: re-send what changes for both sides. */
  relationsChanged(profileId: string): Promise<void>;
  /** A sanction was created (for that profile) or lifted (profile unknown: every owner is re-checked). */
  sanctionsChanged(profileId?: string): Promise<void>;
  /** Await queued database writes (tests, shutdown). */
  flush(): Promise<void>;
}

const near = (a: Rect, b: Rect, m: number) => a.minX - m <= b.maxX && b.minX - m <= a.maxX && a.minZ - m <= b.maxZ && b.minZ - m <= a.maxZ;
const sameHouse = (a: House, b: House) => JSON.stringify(a) === JSON.stringify(b);

const CLEARED_TEXT: Partial<Record<HomeRefusal, string>> = {
  not_found: 'Your home’s doorway is gone, so that house is no longer your home.',
  no_roof: 'Your house lost its roof, so it is no longer your home.',
  no_doorway: 'Your house has no doorway any more, so it is no longer your home.',
};

export function createHomes(deps: HomesDeps): HomesService {
  const { persistence, memory, moderation, building } = deps;
  const worldId = deps.worldId ?? 'default';
  const now = deps.now ?? Date.now;
  const repo: HomeRepository = createHomeRepository(persistence, worldId);
  const ws = persistence.forWorld(worldId);
  const limiter = new RateLimiter({ home: deps.rate ?? CONFIG.rateLimits.home }, now);
  const homes = new Map<string, HomeRecord>();
  const rooms = new Set<RoomContext>();
  /** Owners under a ban / build ban (their pins are hidden from everyone else). */
  const restricted = new Set<string>();
  /** Owners' own block lists (they may be offline; recipients' lists are moderation's live cache). */
  const ownerBlocks = new Map<string, Set<string>>();
  let loaded: Promise<void> | null = null;
  let lastSanctionCheck = 0;

  // Database writes in order (a clear followed at once by a new set must land in that order).
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => undefined);
    return p;
  };

  const ownerPiecesNear = (ownerId: string, r: Rect): PieceRecord[] => building.index.query(r, ROOM_REACH).filter((p) => p.ownerId === ownerId);

  async function refreshRestriction(ownerId: string): Promise<boolean> {
    const active = await persistence.sanctions.active(now(), ownerId);
    const on = active.some((s) => s.kind === 'ban' || s.kind === 'build_ban');
    const before = restricted.has(ownerId);
    if (on) restricted.add(ownerId);
    else restricted.delete(ownerId);
    return before !== on;
  }
  async function refreshBlocks(ownerId: string): Promise<void> {
    ownerBlocks.set(ownerId, new Set((await persistence.relations.list(ownerId)).blocked));
  }

  function pinnedFor(h: HomeRecord, recipient: string | undefined): boolean {
    if (!h.showOnMap) return false;
    if (recipient === h.profileId) return true;
    if (restricted.has(h.profileId)) return false;
    if (!recipient) return false;
    if (moderation.isBlockedBetween(h.profileId, recipient)) return false;
    if (ownerBlocks.get(h.profileId)?.has(recipient)) return false;
    return true;
  }
  function wireFor(h: HomeRecord, recipient: string | undefined): HomeWire {
    return { profileId: h.profileId, ownerName: h.ownerName, doorPieceId: h.doorPieceId, name: h.house.name, rect: { ...h.house.rect }, pinned: pinnedFor(h, recipient) };
  }

  /** Every session of every room of the world. */
  function eachSession(fn: (ctx: RoomContext, sid: string, profileId: string | undefined) => void): void {
    for (const ctx of rooms) {
      for (const sid of ctx.sessionIds()) {
        try {
          fn(ctx, sid, ctx.getProfile(sid)?.id ?? ctx.getPlayer(sid)?.profileId);
        } catch (err) {
          console.error('[homes] send failed', err);
        }
      }
    }
  }
  function broadcastHome(h: HomeRecord): void {
    eachSession((ctx, sid, pid) => ctx.send(sid, S2C.homeChanged, { home: wireFor(h, pid) }));
  }
  function broadcastCleared(profileId: string): void {
    eachSession((ctx, sid) => ctx.send(sid, S2C.homeChanged, { profileId, cleared: true }));
  }
  function sessionsOf(profileId: string): { ctx: RoomContext; sid: string }[] {
    const out: { ctx: RoomContext; sid: string }[] = [];
    for (const ctx of rooms) {
      const sid = ctx.sessionForProfile(profileId);
      if (sid) out.push({ ctx, sid });
    }
    return out;
  }
  function sendAll(ctx: RoomContext, sid: string): void {
    const pid = ctx.getProfile(sid)?.id ?? ctx.getPlayer(sid)?.profileId;
    ctx.send(sid, S2C.homes, { homes: [...homes.values()].map((h) => wireFor(h, pid)) });
  }

  const result = (ctx: RoomContext, sid: string, action: HomeResultPayload['action'], reason: HomeRefusal | null, extra: { text?: string; doorPieceId?: string } = {}) => {
    const payload: HomeResultPayload = reason ? { action, ok: false, reason, text: HOME_REFUSAL_TEXT[reason] } : { action, ok: true, ...extra };
    ctx.send(sid, S2C.homeResult, payload);
  };

  /** Drop a home (row, state, every client) and tell its owner why. */
  async function clearHome(profileId: string, why: HomeRefusal | null): Promise<void> {
    if (!homes.delete(profileId)) return;
    broadcastCleared(profileId);
    if (why) {
      const text = CLEARED_TEXT[why] ?? 'Your house is no longer a whole house, so it is no longer your home.';
      for (const { ctx, sid } of sessionsOf(profileId)) ctx.notice(sid, { level: 'warning', code: 'home_cleared', text });
    }
    await queue(() => repo.remove(profileId)).catch((err) => console.error('[homes] delete failed', err));
  }

  /** The owner's pieces changed near the home: recompute its room. */
  async function recheck(profileId: string): Promise<void> {
    const h = homes.get(profileId);
    if (!h) return;
    const door = building.index.get(h.doorPieceId);
    const r = door && door.ownerId === profileId ? checkHouse(ownerPiecesNear(profileId, h.house.rect), h.doorPieceId, { prefer: h.house.rect }) : ({ ok: false, reason: 'not_found' } as const);
    if (!r.ok) return clearHome(profileId, r.reason);
    if (sameHouse(r.house, h.house)) return;
    const moved = r.house.doorPieceId !== h.doorPieceId;
    h.house = r.house;
    h.doorPieceId = r.house.doorPieceId;
    broadcastHome(h);
    if (moved) await queue(() => repo.upsert({ profileId, doorPieceId: h.doorPieceId, showOnMap: h.showOnMap, createdAt: h.createdAt })).catch((err) => console.error('[homes] save failed', err));
  }

  function onPieces(c: PieceChange): void {
    const owners = new Set<string>();
    for (const p of [...c.added, ...c.removed, ...c.updated]) {
      const h = homes.get(p.ownerId);
      if (h && (p.id === h.doorPieceId || near(footprintOf(p), h.house.rect, HOME_RECHECK_MARGIN))) owners.add(p.ownerId);
    }
    for (const o of owners) void recheck(o).catch((err) => console.error('[homes] recheck failed', err));
  }
  building.onChange(onPieces);
  building.onSnapshotSent((ctx, sid) => sendAll(ctx, sid));

  async function isBuildBanned(profileId: string): Promise<boolean> {
    return (await persistence.sanctions.active(now(), profileId)).some((s) => s.kind === 'ban' || s.kind === 'build_ban');
  }

  const service: HomesService = {
    async load() {
      loaded ??= (async () => {
        homes.clear();
        for (const row of await repo.loadAll()) {
          const door = building.index.get(row.doorPieceId);
          const r = door && door.ownerId === row.profileId ? checkHouse(ownerPiecesNear(row.profileId, footprintOf(door)), row.doorPieceId) : null;
          if (!r?.ok) {
            // The door piece vanished (or the house stopped qualifying) while the server was down.
            await queue(() => repo.remove(row.profileId)).catch((err) => console.error('[homes] drop failed', err));
            continue;
          }
          const profile = await persistence.profiles.get(row.profileId);
          homes.set(row.profileId, { profileId: row.profileId, ownerName: profile?.displayName ?? door!.ownerName, doorPieceId: r.house.doorPieceId, showOnMap: row.showOnMap, createdAt: row.createdAt, house: r.house });
          await refreshRestriction(row.profileId);
          await refreshBlocks(row.profileId);
        }
        lastSanctionCheck = now();
      })();
      return loaded;
    },

    async onRoomCreate(ctx) {
      rooms.add(ctx);
      await service.load();
    },
    onRoomDispose(ctx) {
      rooms.delete(ctx);
    },
    onPlayerJoin(ctx, sid) {
      // A renamed owner: everyone sees the new name on the label and pin.
      const p = ctx.getProfile(sid);
      const h = p ? homes.get(p.id) : undefined;
      if (h && p && p.displayName !== h.ownerName) {
        h.ownerName = p.displayName;
        broadcastHome(h);
      }
    },

    tick() {
      const t = now();
      if (t - lastSanctionCheck < HOME_SANCTION_RECHECK_MS) return;
      lastSanctionCheck = t;
      void service.sanctionsChanged().catch((err) => console.error('[homes] sanction check failed', err));
    },

    async set(ctx, sid, m) {
      const profile = ctx.getProfile(sid);
      if (!profile) return;
      if (limiter.take(profile.id, 'home') > 0) return result(ctx, sid, 'set', 'rate_limited');
      const pieceId = typeof m.pieceId === 'string' && m.pieceId.length <= 80 ? m.pieceId : '';
      const sel = pieceId ? building.index.get(pieceId) : undefined;
      if (!sel) return result(ctx, sid, 'set', 'not_found');
      if (sel.ownerId !== profile.id) return result(ctx, sid, 'set', 'not_owner');
      if (await isBuildBanned(profile.id)) return result(ctx, sid, 'set', 'banned');
      // Pieces may have changed during the await: decide on the current ones, then commit synchronously.
      if (!building.index.get(pieceId)) return result(ctx, sid, 'set', 'not_found');
      const r = checkHouse(ownerPiecesNear(profile.id, footprintOf(sel)), pieceId);
      if (!r.ok) return result(ctx, sid, 'set', r.reason);
      const before = homes.get(profile.id);
      const rec: HomeRecord = { profileId: profile.id, ownerName: profile.displayName, doorPieceId: r.house.doorPieceId, showOnMap: before?.showOnMap ?? false, createdAt: now(), house: r.house };
      homes.set(profile.id, rec);
      try {
        await queue(() => repo.upsert({ profileId: rec.profileId, doorPieceId: rec.doorPieceId, showOnMap: rec.showOnMap, createdAt: rec.createdAt }));
      } catch (err) {
        console.error('[homes] save failed', err);
        if (homes.get(profile.id) === rec) {
          if (before) homes.set(profile.id, before);
          else homes.delete(profile.id);
        }
        return result(ctx, sid, 'set', 'internal');
      }
      if (homes.get(profile.id) !== rec) return result(ctx, sid, 'set', 'internal');
      restricted.delete(profile.id); // not build-banned (checked above)
      await refreshBlocks(profile.id);
      broadcastHome(rec);
      result(ctx, sid, 'set', null, { text: rec.house.name ? `${rec.house.name} is your home now.` : 'This is your home now.', doorPieceId: rec.doorPieceId });
      // The island remembers it once per profile and door (no location is recorded).
      void (async () => {
        if (await ws.addToSet('homes_made', `${profile.id}|${rec.doorPieceId}`)) {
          await memory.record({ kind: 'home_made', actors: [{ profileId: profile.id, name: profile.displayName }], significance: 1, data: { name: rec.house.name } });
        }
      })().catch((err) => console.error('[homes] memory failed', err));
    },

    async clear(ctx, sid) {
      const profile = ctx.getProfile(sid);
      if (!profile) return;
      if (limiter.take(profile.id, 'home') > 0) return result(ctx, sid, 'clear', 'rate_limited');
      if (!homes.has(profile.id)) return result(ctx, sid, 'clear', 'no_home');
      await clearHome(profile.id, null);
      result(ctx, sid, 'clear', null, { text: 'That house is no longer your home.' });
    },

    async pin(ctx, sid, m) {
      const profile = ctx.getProfile(sid);
      if (!profile) return;
      if (limiter.take(profile.id, 'home') > 0) return result(ctx, sid, 'pin', 'rate_limited');
      if (typeof m.on !== 'boolean') return result(ctx, sid, 'pin', 'bad_request');
      const h = homes.get(profile.id);
      if (!h) return result(ctx, sid, 'pin', 'no_home');
      const before = h.showOnMap;
      h.showOnMap = m.on;
      try {
        await queue(() => repo.setPin(profile.id, m.on));
      } catch (err) {
        console.error('[homes] pin failed', err);
        h.showOnMap = before;
        return result(ctx, sid, 'pin', 'internal');
      }
      broadcastHome(h);
      result(ctx, sid, 'pin', null, { text: m.on ? 'Your home is on the map now.' : 'Your home is off the map.' });
    },

    get: (pid) => homes.get(pid),
    list: () => [...homes.values()],
    wireFor,
    sendAll,

    async relationsChanged(profileId) {
      if (homes.has(profileId)) await refreshBlocks(profileId);
      // What this player sees of everyone's homes…
      for (const { ctx, sid } of sessionsOf(profileId)) sendAll(ctx, sid);
      // …and what everyone sees of theirs.
      const own = homes.get(profileId);
      if (own) broadcastHome(own);
    },

    async sanctionsChanged(profileId) {
      const owners = profileId ? (homes.has(profileId) ? [profileId] : []) : [...homes.keys()];
      for (const o of owners) {
        if (await refreshRestriction(o)) {
          const h = homes.get(o);
          if (h) broadcastHome(h);
        }
      }
    },

    flush: () => chain.then(() => undefined),
  };
  return service;
}

/**
 * Route moderation changes to homes at once: block / unblock (both sides'
 * views of pins) and sanctions created or revoked (a ban or build ban hides
 * the owner's pin without waiting). Wraps the moderation service in place.
 */
export function linkModeration(moderation: ModerationService, homes: HomesService): void {
  const { block, unblock, sanction, revokeSanction } = moderation;
  const after = (ctx: RoomContext, sid: string) => {
    const pid = ctx.getProfile(sid)?.id;
    if (pid) void homes.relationsChanged(pid).catch((err) => console.error('[homes] relations update failed', err));
  };
  moderation.block = async (ctx, sid, p) => {
    await block(ctx, sid, p);
    after(ctx, sid);
  };
  moderation.unblock = async (ctx, sid, p) => {
    await unblock(ctx, sid, p);
    after(ctx, sid);
  };
  moderation.sanction = async (input) => {
    const s = await sanction(input);
    await homes.sanctionsChanged(s.profileId).catch((err) => console.error('[homes] sanction update failed', err));
    return s;
  };
  moderation.revokeSanction = async (id) => {
    const ok = await revokeSanction(id);
    if (ok) await homes.sanctionsChanged().catch((err) => console.error('[homes] sanction update failed', err));
    return ok;
  };
}
