/**
 * Player building, server-authoritative.
 *
 *  - State: every piece of the world lives in an in-memory PieceIndex
 *    (loaded from `build_pieces` at boot) and in the shared dynamic collider
 *    layer, so movement validation (WorldRoom → resolveMovement) treats solid
 *    ground-level pieces like walls of the static world.
 *  - Sync: pieces are NOT part of the Colyseus schema (a few thousand entries
 *    would bloat every full-state encode and patch). A joining client gets
 *    S2C.buildSnapshot in compact chunks (CONFIG.building.snapshotChunk rows
 *    of tuples + an owner table); afterwards only deltas (S2C.buildPlaced /
 *    S2C.buildRemoved) are broadcast to every room instance of the world.
 *  - Validation: shared validatePlacement (grid, rotation, level, bounds,
 *    protected zones, slope, static obstacles, overlap, support, players in
 *    the way, range) plus here: enabled switch, bans/build bans, per-profile
 *    rate limit, per-player and per-world caps, sign text (filterText + length,
 *    muted players can't write), and blocks (no building within
 *    BLOCK_RADIUS of pieces owned by someone you blocked / who blocked you).
 *  - Ownership: only the owner removes a piece, and not while other pieces
 *    rest on it. Admins remove anything (with everything resting on it).
 *  - Memory: first_build per profile, world milestones of pieces ever
 *    placed, structure_roofed when a roof closes a structure of walls with a
 *    doorway. Only real events.
 */
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  CONFIG,
  PIECES,
  PIECE_KINDS,
  PieceIndex,
  S2C,
  cascadeRemoval,
  defaultCollisionWorld,
  directDependents,
  findNearestWalkable,
  footprint,
  locationAt,
  pickSpawnPoint,
  pieceColliders,
  refusalText,
  resolveMovement,
  validatePlacement,
  variantIndex,
  type BuildPlacePayload,
  type BuildRefusal,
  type BuildRemovePayload,
  type BuildResultPayload,
  type BuildSnapshotPayload,
  type CollisionWorld,
  type LocationId,
  type PieceRecord,
  type PieceView,
  type PieceWire,
  type RateLimitRule,
  type Vec2,
} from '@elsewhere/shared';
import type { MemoryService } from '../memory/index.js';
import type { ModerationService } from '../moderation/index.js';
import { RateLimiter } from '../moderation/rateLimit.js';
import { filterText, sanitizeText } from '../moderation/text.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';
import { createPieceRepository, type PieceRepository } from './repository.js';

/** Pieces of a profile within this distance are off-limits to anyone with a block relation to it. */
export const BLOCK_RADIUS = 4;
const STRUCTURE_SEARCH_LIMIT = 300;

export interface BuildingOptions {
  enabled: boolean;
  range: number;
  maxPerPlayer: number;
  maxPerWorld: number;
  rate: RateLimitRule;
}

export const DEFAULT_BUILDING_OPTIONS: BuildingOptions = {
  enabled: true,
  range: CONFIG.building.range,
  maxPerPlayer: CONFIG.building.maxPiecesPerPlayer,
  maxPerWorld: CONFIG.building.maxPiecesPerWorld,
  rate: CONFIG.rateLimits.build,
};

export interface BuildingDeps {
  persistence: PersistenceService;
  memory: MemoryService;
  moderation: ModerationService;
  worldId?: string;
  now?: () => number;
  options?: Partial<BuildingOptions>;
  /** Collision world whose dynamic layer receives piece colliders (default: the process-wide one). */
  collision?: CollisionWorld;
}

export interface BuildStats {
  pieces: number;
  owners: number;
  placedTotal: number;
  validation: { count: number; avgMs: number; maxMs: number };
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  /** Micro-benchmark: resolveMovement next to pieces (µs per call). */
  moveResolveUs?: number;
  snapshotBytes: number;
}

export interface BuildingService extends RoomHooks {
  readonly index: PieceIndex<PieceRecord>;
  load(): Promise<void>;
  place(ctx: RoomContext, sessionId: string, payload: BuildPlacePayload): Promise<void>;
  remove(ctx: RoomContext, sessionId: string, payload: BuildRemovePayload): Promise<void>;
  /** Teleport the player to the Town Square (rate limiting is done by the caller). */
  unstuck(ctx: RoomContext, sessionId: string): void;
  /** Admin: remove pieces (and everything resting on them). Returns removed ids. */
  adminRemove(ids: readonly string[]): Promise<string[]>;
  /** Admin: remove every piece a profile owns (and what rests on them). */
  adminRemoveProfile(profileId: string): Promise<string[]>;
  list(opts?: { ownerId?: string; limit?: number }): PieceRecord[];
  snapshotChunks(): BuildSnapshotPayload[];
  stats(benchmark?: boolean): BuildStats;
}

export function toView(p: PieceRecord): PieceView {
  const v: PieceView = { id: p.id, kind: p.kind, variant: p.variant, x: p.x, z: p.z, rot: p.rot, level: p.level, y: p.y, ownerId: p.ownerId, ownerName: p.ownerName };
  if (p.text) v.text = p.text;
  return v;
}

let idCounter = 0;
function pieceId(now: number): string {
  idCounter = (idCounter + 1) % 1296;
  return `p${now.toString(36)}${idCounter.toString(36).padStart(2, '0')}${randomBytes(2).toString('hex')}`;
}

export function createBuilding(deps: BuildingDeps): BuildingService {
  const { persistence, memory, moderation } = deps;
  const worldId = deps.worldId ?? 'default';
  const now = deps.now ?? Date.now;
  const opts: BuildingOptions = { ...DEFAULT_BUILDING_OPTIONS, ...deps.options };
  const collision = deps.collision ?? defaultCollisionWorld();
  const repo: PieceRepository = createPieceRepository(persistence, worldId);
  const ws = persistence.forWorld(worldId);
  const index = new PieceIndex<PieceRecord>();
  const limiter = new RateLimiter({ build: opts.rate }, now);
  const rooms = new Set<RoomContext>();
  let placedTotal = 0;
  const vstats = { count: 0, total: 0, max: 0 };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  const addLive = (p: PieceRecord) => {
    index.add(p);
    const cols = pieceColliders(p);
    if (cols.length) collision.dynamic.set(p.id, cols);
  };
  const removeLive = (id: string) => {
    index.remove(id);
    collision.dynamic.remove(id);
  };

  const result = (ctx: RoomContext, sid: string, reqId: number, action: 'place' | 'remove', reason: BuildRefusal | null, extra: { label?: string; pieceId?: string } = {}) => {
    const payload: BuildResultPayload = reason ? { reqId, action, ok: false, reason, message: refusalText(reason, extra.label) } : { reqId, action, ok: true };
    if (!reason && extra.pieceId) payload.pieceId = extra.pieceId;
    ctx.send(sid, S2C.buildResult, payload);
  };

  const broadcastAll = (fn: (ctx: RoomContext) => void) => {
    for (const ctx of rooms) {
      try {
        fn(ctx);
      } catch (err) {
        console.error('[building] broadcast failed', err);
      }
    }
  };

  /** Every player position in every room of this world. */
  const playerPositions = (): Vec2[] => {
    const out: Vec2[] = [];
    for (const ctx of rooms) {
      for (const sid of ctx.sessionIds()) {
        const p = ctx.getPlayer(sid);
        if (p) out.push({ x: p.x, z: p.z });
      }
    }
    return out;
  };

  async function isBuildBanned(profileId: string): Promise<boolean> {
    const active = await persistence.sanctions.active(now(), profileId);
    return active.some((s) => s.kind === 'ban' || s.kind === 'build_ban');
  }

  /** Block relation (either way) with the owner of any piece near the footprint. */
  async function blockedNear(builderId: string, kind: BuildPlacePayload['kind'], x: number, z: number, rot: number): Promise<boolean> {
    const owners = new Set<string>();
    for (const q of index.query(footprint(kind, x, z, rot), BLOCK_RADIUS)) if (q.ownerId !== builderId) owners.add(q.ownerId);
    for (const owner of owners) {
      if (moderation.isBlockedBetween(builderId, owner)) return true;
      const rel = await persistence.relations.list(owner);
      if (rel.blocked.includes(builderId)) return true;
      const mine = await persistence.relations.list(builderId);
      if (mine.blocked.includes(owner)) return true;
    }
    return false;
  }

  function structureAround(p: PieceRecord): PieceRecord[] {
    const seen = new Map<string, PieceRecord>();
    const queue: PieceRecord[] = [];
    const structural = (q: PieceRecord) => PIECES[q.kind].structural && q.ownerId === p.ownerId;
    for (const q of index.query(footprint(p.kind, p.x, p.z, p.rot), 0.2)) if (q.level === p.level - 1 && structural(q)) queue.push(q);
    while (queue.length && seen.size < STRUCTURE_SEARCH_LIMIT) {
      const q = queue.shift()!;
      if (seen.has(q.id)) continue;
      seen.set(q.id, q);
      for (const n of index.query(footprint(q.kind, q.x, q.z, q.rot), 0.2)) if (!seen.has(n.id) && structural(n) && Math.abs(n.level - q.level) <= 1) queue.push(n);
    }
    return [...seen.values()];
  }

  async function recordMemory(ctx: RoomContext, p: PieceRecord): Promise<void> {
    const actor = { profileId: p.ownerId, name: p.ownerName };
    const loc = locationAt(p)?.id as LocationId | undefined;
    const where = loc ? { locationId: loc } : {};
    if (await ws.addToSet('builders', p.ownerId)) {
      await memory.record({ kind: 'first_build', actors: [actor], ...where, objectId: p.id, significance: 1, data: { piece: p.kind } });
    }
    if ((CONFIG.building.milestones as readonly number[]).includes(placedTotal)) {
      await memory.announce(ctx, { kind: 'milestone', actors: [actor], ...where, objectId: p.id, significance: placedTotal >= 100 ? 2 : 1, data: { milestone: 'build_pieces', contributions: placedTotal } }, `The island's ${placedTotal}th piece was just placed`);
    }
    const layer = PIECES[p.kind].layer;
    if (layer === 'roof' && p.level >= 1) {
      const s = structureAround(p);
      const walls = s.filter((q) => q.kind === 'wall' || q.kind === 'wall_window' || q.kind === 'doorway');
      if (walls.length >= 4 && walls.some((q) => q.kind === 'doorway')) {
        const key = s.map((q) => q.id).sort()[0]!;
        if (await ws.addToSet('roofed_structures', key)) {
          await memory.announce(ctx, { kind: 'structure_roofed', actors: [actor], ...where, objectId: key, significance: 2, data: { walls: walls.length } }, `${p.ownerName} finished a roof`);
        }
      }
    }
  }

  function wireRow(p: PieceRecord, ownerIdx: number): PieceWire {
    return [p.id, PIECE_KINDS.indexOf(p.kind), Math.max(0, variantIndex(p.kind, p.variant)), Math.round(p.x * 2), Math.round(p.z * 2), p.rot, p.level, Math.round(p.y * 100), ownerIdx, p.text ?? ''];
  }

  const service: BuildingService = {
    index,

    async load() {
      index.clear();
      for (const p of await repo.loadAll()) addLive(p);
      placedTotal = Math.max(index.size, (await ws.getKv<number>('build:placedTotal')) ?? 0);
    },

    onRoomCreate(ctx) {
      rooms.add(ctx);
    },
    onRoomDispose(ctx) {
      rooms.delete(ctx);
    },
    onPlayerJoin(ctx, sid) {
      for (const chunk of service.snapshotChunks()) ctx.send(sid, S2C.buildSnapshot, chunk);
    },

    snapshotChunks() {
      const all = [...index.all()];
      const size = CONFIG.building.snapshotChunk;
      const chunks: BuildSnapshotPayload[] = [];
      for (let i = 0; i === 0 || i < all.length; i += size) {
        const owners: [string, string][] = [];
        const ownerIdx = new Map<string, number>();
        const rows = all.slice(i, i + size).map((p) => {
          let k = ownerIdx.get(p.ownerId);
          if (k === undefined) {
            k = owners.length;
            ownerIdx.set(p.ownerId, k);
            owners.push([p.ownerId, p.ownerName]);
          }
          return wireRow(p, k);
        });
        chunks.push({ reset: i === 0, done: i + size >= all.length, total: all.length, owners, pieces: rows });
      }
      return chunks;
    },

    async place(ctx, sid, m) {
      const reqId = typeof m.reqId === 'number' && Number.isFinite(m.reqId) ? m.reqId : 0;
      const fail = (r: BuildRefusal, label?: string) => result(ctx, sid, reqId, 'place', r, label !== undefined ? { label } : {});
      const player = ctx.getPlayer(sid);
      const profile = ctx.getProfile(sid);
      if (!player || !profile) return;
      if (!opts.enabled) return fail('disabled');
      if (limiter.take(profile.id, 'build') > 0) return fail('rate_limited');
      if (await isBuildBanned(profile.id)) return fail('banned');
      if (index.size >= opts.maxPerWorld) return fail('world_cap');
      if (index.countFor(profile.id) >= opts.maxPerPlayer) return fail('player_cap');

      // Sign text: sanitized, length-checked, profanity-masked; muted players can't write.
      let text: string | undefined;
      const isKind = typeof m.kind === 'string' && m.kind in PIECES;
      if (isKind && PIECES[m.kind].text) {
        const clean = sanitizeText(m.text);
        if (!clean) return fail('text_required');
        if ([...clean].length > CONFIG.building.signMaxLength) return fail('text_too_long');
        if (moderation.chatMutedFor(profile.id) > 0) return fail('muted');
        text = filterText(clean);
      }

      const t0 = performance.now();
      const v = validatePlacement(m, { index, builderId: profile.id, builderPos: { x: player.x, z: player.z }, range: opts.range, players: playerPositions(), collision });
      const dt = performance.now() - t0;
      vstats.count++;
      vstats.total += dt;
      vstats.max = Math.max(vstats.max, dt);
      if (!v.ok) return fail(v.reason, v.label);
      if (await blockedNear(profile.id, v.kind, v.x, v.z, v.rot)) return fail('blocked');

      // Re-validate after the async checks (another request may have landed meanwhile), then commit synchronously.
      const again = validatePlacement(m, { index, builderId: profile.id, builderPos: { x: player.x, z: player.z }, range: opts.range, players: playerPositions(), collision });
      if (!again.ok) return fail(again.reason, again.label);
      if (index.size >= opts.maxPerWorld) return fail('world_cap');
      if (index.countFor(profile.id) >= opts.maxPerPlayer) return fail('player_cap');
      const piece: PieceRecord = { id: pieceId(now()), kind: again.kind, variant: again.variant, x: again.x, z: again.z, rot: again.rot, level: again.level, y: again.y, ownerId: profile.id, ownerName: profile.displayName, createdAt: now() };
      if (text) piece.text = text;
      addLive(piece);
      try {
        await repo.insert(piece);
      } catch (err) {
        removeLive(piece.id);
        console.error('[building] insert failed', err);
        ctx.error(sid, 'internal', 'Could not save that piece', 'build_place');
        return;
      }
      placedTotal++;
      void ws.setKv('build:placedTotal', placedTotal).catch((err) => console.error('[building] counter save failed', err));
      profile.stats.piecesPlaced = (profile.stats.piecesPlaced ?? 0) + 1;
      const view = toView(piece);
      broadcastAll((c) => c.broadcast(S2C.buildPlaced, { piece: view, by: c === ctx ? sid : '' }));
      result(ctx, sid, reqId, 'place', null, { pieceId: piece.id });
      void recordMemory(ctx, piece).catch((err) => console.error('[building] memory failed', err));
    },

    async remove(ctx, sid, m) {
      const reqId = typeof m.reqId === 'number' && Number.isFinite(m.reqId) ? m.reqId : 0;
      const fail = (r: BuildRefusal) => result(ctx, sid, reqId, 'remove', r);
      const profile = ctx.getProfile(sid);
      if (!profile) return;
      if (limiter.take(profile.id, 'build') > 0) return fail('rate_limited');
      const p = typeof m.id === 'string' ? index.get(m.id) : undefined;
      if (!p) return fail('not_found');
      if (p.ownerId !== profile.id) return fail('not_owner');
      if (directDependents(index, p.id).length) return fail('supports_others');
      removeLive(p.id);
      try {
        await repo.remove([p.id]);
      } catch (err) {
        addLive(p);
        console.error('[building] delete failed', err);
        ctx.error(sid, 'internal', 'Could not remove that piece', 'build_remove');
        return;
      }
      broadcastAll((c) => c.broadcast(S2C.buildRemoved, { ids: [p.id], by: 'owner' }));
      result(ctx, sid, reqId, 'remove', null, { pieceId: p.id });
    },

    unstuck(ctx, sid) {
      const p = ctx.getPlayer(sid);
      if (!p) return;
      const spawn = pickSpawnPoint(Math.floor(Math.random() * 8));
      const to = findNearestWalkable(spawn.position, CONFIG.movement.playerRadius, 8, collision) ?? spawn.position;
      ctx.teleport(sid, to.x, to.z);
      p.rot = spawn.yaw;
      ctx.notice(sid, { level: 'info', code: 'unstuck', text: 'Back in the Town Square.' });
    },

    async adminRemove(ids) {
      const known = ids.filter((id) => index.get(id));
      if (!known.length) return [];
      const all = cascadeRemoval(index, known);
      await repo.remove(all);
      for (const id of all) removeLive(id);
      broadcastAll((c) => c.broadcast(S2C.buildRemoved, { ids: all, by: 'admin' }));
      return all;
    },

    async adminRemoveProfile(profileId) {
      return service.adminRemove(index.ownedBy(profileId).map((p) => p.id));
    },

    list(o = {}) {
      const all = o.ownerId ? index.ownedBy(o.ownerId) : [...index.all()];
      all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return all.slice(0, Math.max(1, Math.min(5000, o.limit ?? 200)));
    },

    stats(benchmark = false) {
      const owners = new Set([...index.all()].map((p) => p.ownerId)).size;
      const out: BuildStats = {
        pieces: index.size,
        owners,
        placedTotal,
        validation: { count: vstats.count, avgMs: vstats.count ? vstats.total / vstats.count : 0, maxMs: vstats.max },
        eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
        snapshotBytes: service.snapshotChunks().reduce((n, c) => n + JSON.stringify(c).length, 0),
      };
      if (benchmark) {
        // Walk a small loop around each of up to 200 pieces: worst-case-ish movement cost next to walls.
        const sample = [...index.all()].filter((p) => p.level === 0).slice(0, 200);
        let calls = 0;
        const t0 = performance.now();
        for (const p of sample) {
          for (let a = 0; a < 8; a++) {
            const from = { x: p.x + Math.cos(a) * 1.6, z: p.z + Math.sin(a) * 1.6 };
            resolveMovement(from, { x: p.x, z: p.z }, CONFIG.movement.playerRadius, collision);
            calls++;
          }
        }
        out.moveResolveUs = calls ? ((performance.now() - t0) * 1000) / calls : 0;
      }
      return out;
    },
  };
  return service;
}
