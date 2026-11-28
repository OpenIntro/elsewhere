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
  getSeat,
  canRegrow,
  footprintOf,
  isPieceKind,
  natureItem,
  pieceIdOfInteract,
  pieceSeatInteractable,
  registerInteractableResolver,
  seatRef,
  parseSeatRef,
  validateClear,
  locationAt,
  pickSpawnPoint,
  pieceColliders,
  refusalText,
  resolveMovement,
  validatePlacement,
  variantIndex,
  type BuildClearPayload,
  type BuildEditTextPayload,
  type BuildPlacePayload,
  type InteractResult,
  type Interactable,
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
import { createPieceRepository, type ClearedRecord, type PieceRepository } from './repository.js';

/** Pieces of a profile within this distance are off-limits to anyone with a block relation to it. */
export const BLOCK_RADIUS = 4;
const STRUCTURE_SEARCH_LIMIT = 300;

export interface BuildingOptions {
  enabled: boolean;
  range: number;
  maxPerPlayer: number;
  maxPerWorld: number;
  rate: RateLimitRule;
  /** Clears (bushes / small rocks) one profile may make per real day. */
  clearDaily: number;
  /** Cleared plants grow back after this long (ms) unless built over. */
  regrowMs: number;
}

export const DEFAULT_BUILDING_OPTIONS: BuildingOptions = {
  enabled: true,
  range: CONFIG.building.range,
  maxPerPlayer: CONFIG.building.maxPiecesPerPlayer,
  maxPerWorld: CONFIG.building.maxPiecesPerWorld,
  rate: CONFIG.rateLimits.build,
  clearDaily: CONFIG.building.clear.dailyPerPlayer,
  regrowMs: CONFIG.building.clear.regrowMs,
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

/** What changed in one place / remove / edit / admin removal (homes re-check their rooms from it). */
export interface PieceChange {
  added: readonly PieceRecord[];
  removed: readonly PieceRecord[];
  /** Pieces whose text changed (sign edits). */
  updated: readonly PieceRecord[];
}

export interface BuildingService extends RoomHooks {
  readonly index: PieceIndex<PieceRecord>;
  /** Called after every committed change (after its broadcast). Returns an unsubscribe. */
  onChange(fn: (change: PieceChange) => void): () => void;
  /** Called right after the snapshot went to one client (join, or C2S.buildSync). Returns an unsubscribe. */
  onSnapshotSent(fn: (ctx: RoomContext, sessionId: string) => void): () => void;
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
  /** The compact snapshot (cached until the next change). */
  snapshotChunks(): BuildSnapshotPayload[];
  /** Send the whole snapshot to one client (join, or C2S.buildSync after a reconnection). */
  sendSnapshot(ctx: RoomContext, sessionId: string): void;
  /** Counters and timings; `reset` starts a new measurement window (validation + event-loop histograms). */
  stats(benchmark?: boolean, reset?: boolean): BuildStats;
  /** Clear a bush / small rock (C2S.buildClear). */
  clear(ctx: RoomContext, sessionId: string, payload: BuildClearPayload): Promise<void>;
  /** Owner edits the words on a sign / name board (C2S.buildEditText). */
  editText(ctx: RoomContext, sessionId: string, payload: BuildEditTextPayload): Promise<void>;
  /** Sit on / stand up from a built seat ("bp:<pieceId>" interactables, routed by WorldRoom.handleInteract). */
  interact(ctx: RoomContext, sessionId: string, target: Interactable): InteractResult;
  /** Ids of cleared bushes / rocks, with who cleared them. */
  clearedList(opts?: { profileId?: string }): ClearedRecord[];
  /** Regrow cleared plants whose time has come (also runs from the room tick). Returns the ids that grew back. */
  regrow(force?: boolean): Promise<string[]>;
  /** Admin: restore cleared plants (by id, or every one a profile cleared). Returns restored ids. */
  adminRestoreNature(opts: { ids?: readonly string[]; profileId?: string }): Promise<string[]>;
}

export function toView(p: PieceRecord): PieceView {
  const v: PieceView = { id: p.id, kind: p.kind, variant: p.variant, x: p.x, z: p.z, rot: p.rot, level: p.level, y: p.y, ownerId: p.ownerId, ownerName: p.ownerName };
  if (p.text) v.text = p.text;
  if (p.params) v.params = p.params;
  return v;
}

function getSeatSafe(ref: string) {
  try {
    return getSeat(ref);
  } catch {
    return null;
  }
}
const rectNear = (a: { minX: number; maxX: number; minZ: number; maxZ: number }, b: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
  a.minX - 0.3 < b.maxX && b.minX - 0.3 < a.maxX && a.minZ - 0.3 < b.maxZ && b.minZ - 0.3 < a.maxZ;

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

  /** Snapshot chunks, rebuilt lazily after any change (joins never re-encode an unchanged world). */
  let snapCache: BuildSnapshotPayload[] | null = null;
  /** Cleared bushes / rocks (nature id → who and when). */
  const cleared = new Map<string, ClearedRecord>();
  /** Clear timestamps per profile (daily cap; survives regrowth, not restarts — rows still count after a restart). */
  const clearLog = new Map<string, number[]>();
  let lastRegrowCheck = 0;
  const applyCleared = (id: string, on: boolean) => {
    snapCache = null;
    const col = natureItem(id)?.colliderId;
    if (col) {
      if (on) collision.disabled.add(col);
      else collision.disabled.delete(col);
    }
  };
  const clearedSet = () => new Set(cleared.keys()) as ReadonlySet<string>;
  const changeListeners = new Set<(c: PieceChange) => void>();
  const snapshotListeners = new Set<(ctx: RoomContext, sid: string) => void>();
  const changed = (c: Partial<PieceChange>) => {
    const change: PieceChange = { added: c.added ?? [], removed: c.removed ?? [], updated: c.updated ?? [] };
    for (const fn of changeListeners) {
      try {
        fn(change);
      } catch (err) {
        console.error('[building] change listener failed', err);
      }
    }
  };
  // Built seats resolve as interactables ("bp:<pieceId>") everywhere the seat flow looks them up.
  registerInteractableResolver((id) => {
    const pid = pieceIdOfInteract(id);
    const p = pid ? index.get(pid) : undefined;
    return p ? (pieceSeatInteractable(p) ?? undefined) : undefined;
  });
  /** Sessions seated on a piece, in every room of the world. */
  const seatedOn = (pieceId: string): { ctx: RoomContext; sid: string; seat: number }[] => {
    const out: { ctx: RoomContext; sid: string; seat: number }[] = [];
    for (const ctx of rooms)
      for (const sid of ctx.sessionIds()) {
        const ref = ctx.getPlayer(sid)?.seat;
        const r = ref ? parseSeatRef(ref) : null;
        if (r && pieceIdOfInteract(r.interactableId) === pieceId) out.push({ ctx, sid, seat: r.seatIndex });
      }
    return out;
  };
  /** Stand someone up from a built seat (piece removed by a moderator). */
  const standUp = (ctx: RoomContext, sid: string) => {
    const p = ctx.getPlayer(sid);
    if (!p || !p.seat) return;
    const seat = getSeatSafe(p.seat);
    p.seat = '';
    if (p.anim === 'sit') p.anim = 'idle';
    if (seat) {
      const exit = findNearestWalkable(seat.exit, CONFIG.movement.playerRadius, 4, collision) ?? seat.exit;
      ctx.teleport(sid, exit.x, exit.z);
    }
  };
  const addLive = (p: PieceRecord) => {
    snapCache = null;
    index.add(p);
    const cols = pieceColliders(p);
    if (cols.length) collision.dynamic.set(p.id, cols);
  };
  const removeLive = (id: string) => {
    snapCache = null;
    index.remove(id);
    collision.dynamic.remove(id);
  };

  const result = (ctx: RoomContext, sid: string, reqId: number, action: BuildResultPayload['action'], reason: BuildRefusal | null, extra: { label?: string; pieceId?: string } = {}) => {
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
  async function blockedNear(builderId: string, piece: { kind: BuildPlacePayload['kind']; x: number; z: number; rot: number; params?: string }): Promise<boolean> {
    const owners = new Set<string>();
    for (const q of index.query(footprintOf(piece), BLOCK_RADIUS)) if (q.ownerId !== builderId) owners.add(q.ownerId);
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
    for (const q of index.query(footprintOf(p), 0.25)) if (q.level === p.level - 1 && structural(q)) queue.push(q);
    while (queue.length && seen.size < STRUCTURE_SEARCH_LIMIT) {
      const q = queue.shift()!;
      if (seen.has(q.id)) continue;
      seen.set(q.id, q);
      for (const n of index.query(footprintOf(q), 0.2)) if (!seen.has(n.id) && structural(n) && Math.abs(n.level - q.level) <= 1) queue.push(n);
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
    // A name on a finished building (walls + doorway + roof): the island learns its name, once per sign.
    if (PIECES[p.kind].mount && PIECES[p.kind].text && p.text) {
      const wall = index.get(directSupportId(p) ?? '');
      if (wall) {
        const s = structureAround({ ...wall, level: wall.level + 1 });
        const walls = s.filter((q) => q.kind === 'wall' || q.kind === 'wall_window' || q.kind === 'doorway');
        const roofed = [...index.ownedBy(p.ownerId)].some((q) => PIECES[q.kind].layer === 'roof' && s.some((w) => w.level === q.level - 1 && rectNear(footprintOf(q), footprintOf(w))));
        if (walls.length >= 4 && walls.some((q) => q.kind === 'doorway') && roofed && (await ws.addToSet('named_buildings', p.id))) {
          await memory.announce(ctx, { kind: 'building_named', actors: [actor], ...where, objectId: p.id, significance: 2, data: { name: p.text } }, `${p.ownerName} named their house “${p.text}”`);
        }
      }
    }
  }

  function directSupportId(p: PieceRecord): string | null {
    for (const q of index.query(footprintOf(p), 0.4)) if (q.x === p.x && q.z === p.z && q.level === p.level && q.id !== p.id && !PIECES[q.kind].mount) return q.id;
    return null;
  }

  function wireRow(p: PieceRecord, ownerIdx: number): PieceWire {
    const row: PieceWire = [p.id, PIECE_KINDS.indexOf(p.kind), Math.max(0, variantIndex(p.kind, p.variant)), Math.round(p.x * 2), Math.round(p.z * 2), p.rot, p.level, Math.round(p.y * 100), ownerIdx, p.text ?? ''];
    if (p.params) row.push(p.params);
    return row;
  }

  const service: BuildingService = {
    index,

    async load() {
      for (const p of index.all()) collision.dynamic.remove(p.id);
      index.clear();
      snapCache = null;
      for (const p of await repo.loadAll()) addLive(p);
      placedTotal = Math.max(index.size, (await ws.getKv<number>('build:placedTotal')) ?? 0);
      for (const id of cleared.keys()) applyCleared(id, false);
      cleared.clear();
      for (const c of await repo.loadCleared()) {
        if (!natureItem(c.natureId)) continue;
        cleared.set(c.natureId, c);
        applyCleared(c.natureId, true);
      }
    },

    onRoomCreate(ctx) {
      rooms.add(ctx);
    },
    onRoomDispose(ctx) {
      rooms.delete(ctx);
    },
    onPlayerJoin(ctx, sid) {
      service.sendSnapshot(ctx, sid);
    },

    sendSnapshot(ctx, sid) {
      for (const chunk of service.snapshotChunks()) ctx.send(sid, S2C.buildSnapshot, chunk);
      for (const fn of snapshotListeners) {
        try {
          fn(ctx, sid);
        } catch (err) {
          console.error('[building] snapshot listener failed', err);
        }
      }
    },

    onChange(fn) {
      changeListeners.add(fn);
      return () => void changeListeners.delete(fn);
    },
    onSnapshotSent(fn) {
      snapshotListeners.add(fn);
      return () => void snapshotListeners.delete(fn);
    },

    snapshotChunks() {
      if (snapCache) return snapCache;
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
        const chunk: BuildSnapshotPayload = { reset: i === 0, done: i + size >= all.length, total: all.length, owners, pieces: rows };
        if (i === 0) chunk.cleared = [...cleared.keys()];
        chunks.push(chunk);
      }
      snapCache = chunks;
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
      if (isPieceKind(m.kind) && PIECES[m.kind].text) {
        const clean = sanitizeText(m.text);
        if (!clean) return fail('text_required');
        const max = PIECES[m.kind].textMax ?? CONFIG.building.signMaxLength;
        if ([...clean].length > max) return fail('text_too_long', String(max));
        if (moderation.chatMutedFor(profile.id) > 0) return fail('muted');
        text = filterText(clean);
      }

      const t0 = performance.now();
      const v = validatePlacement(m, { index, builderId: profile.id, builderPos: { x: player.x, z: player.z }, range: opts.range, players: playerPositions(), collision, cleared: clearedSet() });
      const dt = performance.now() - t0;
      vstats.count++;
      vstats.total += dt;
      vstats.max = Math.max(vstats.max, dt);
      if (!v.ok) {
        if (v.natureId) {
          const payload: BuildResultPayload = { reqId, action: 'place', ok: false, reason: v.reason, message: refusalText(v.reason, v.label), natureId: v.natureId };
          return ctx.send(sid, S2C.buildResult, payload);
        }
        return fail(v.reason, v.label);
      }
      if (await blockedNear(profile.id, v)) return fail('blocked');

      // Re-validate after the async checks (another request may have landed meanwhile), then commit synchronously.
      const again = validatePlacement(m, { index, builderId: profile.id, builderPos: { x: player.x, z: player.z }, range: opts.range, players: playerPositions(), collision, cleared: clearedSet() });
      if (!again.ok) return fail(again.reason, again.label);
      if (index.size >= opts.maxPerWorld) return fail('world_cap');
      if (index.countFor(profile.id) >= opts.maxPerPlayer) return fail('player_cap');
      const piece: PieceRecord = { id: pieceId(now()), kind: again.kind, variant: again.variant, x: again.x, z: again.z, rot: again.rot, level: again.level, y: again.y, ownerId: profile.id, ownerName: profile.displayName, createdAt: now() };
      if (text) piece.text = text;
      if (again.params) piece.params = again.params;
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
      changed({ added: [piece] });
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
      if (seatedOn(p.id).length) return fail('occupied');
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
      changed({ removed: [p] });
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

    async clear(ctx, sid, m) {
      const reqId = typeof m.reqId === 'number' && Number.isFinite(m.reqId) ? m.reqId : 0;
      const fail = (r: BuildRefusal, label?: string) => result(ctx, sid, reqId, 'clear', r, label !== undefined ? { label } : {});
      const player = ctx.getPlayer(sid);
      const profile = ctx.getProfile(sid);
      if (!player || !profile) return;
      if (!opts.enabled) return fail('disabled');
      if (limiter.take(profile.id, 'build') > 0) return fail('rate_limited');
      const v = validateClear(m.id, { builderPos: { x: player.x, z: player.z }, range: opts.range, cleared: clearedSet() });
      if (!v.ok) return fail(v.reason, v.label);
      if (await isBuildBanned(profile.id)) return fail('banned');
      const t = now();
      const day = 86_400_000;
      const log = (clearLog.get(profile.id) ?? []).filter((x) => t - x < day);
      const persisted = [...cleared.values()].filter((c) => c.profileId === profile.id && t - c.clearedAt < day && !log.includes(c.clearedAt)).length;
      if (log.length + persisted >= opts.clearDaily) return fail('clear_cap');
      if (cleared.has(v.item.id)) return fail('already_cleared');
      const rec: ClearedRecord = { natureId: v.item.id, profileId: profile.id, profileName: profile.displayName, clearedAt: t };
      cleared.set(rec.natureId, rec);
      applyCleared(rec.natureId, true);
      try {
        await repo.insertCleared(rec);
      } catch (err) {
        cleared.delete(rec.natureId);
        applyCleared(rec.natureId, false);
        console.error('[building] clear failed', err);
        ctx.error(sid, 'internal', 'Could not clear that', 'build_clear');
        return;
      }
      log.push(t);
      clearLog.set(profile.id, log);
      broadcastAll((c) => c.broadcast(S2C.natureCleared, { ids: [rec.natureId], by: c === ctx ? sid : '' }));
      result(ctx, sid, reqId, 'clear', null, { pieceId: rec.natureId });
    },

    async editText(ctx, sid, m) {
      const reqId = typeof m.reqId === 'number' && Number.isFinite(m.reqId) ? m.reqId : 0;
      const fail = (r: BuildRefusal, label?: string) => result(ctx, sid, reqId, 'edit', r, label !== undefined ? { label } : {});
      const profile = ctx.getProfile(sid);
      if (!profile) return;
      if (limiter.take(profile.id, 'build') > 0) return fail('rate_limited');
      const p = typeof m.id === 'string' ? index.get(m.id) : undefined;
      if (!p) return fail('not_found');
      if (p.ownerId !== profile.id) return fail('not_owner');
      if (!PIECES[p.kind].text) return fail('not_text');
      if (await isBuildBanned(profile.id)) return fail('banned');
      const clean = sanitizeText(m.text);
      if (!clean) return fail('text_required');
      const max = PIECES[p.kind].textMax ?? CONFIG.building.signMaxLength;
      if ([...clean].length > max) return fail('text_too_long', String(max));
      if (moderation.chatMutedFor(profile.id) > 0) return fail('muted');
      const text = filterText(clean);
      const before = p.text;
      p.text = text;
      snapCache = null;
      try {
        await repo.updateText(p.id, text);
      } catch (err) {
        if (before === undefined) delete p.text;
        else p.text = before;
        console.error('[building] edit failed', err);
        ctx.error(sid, 'internal', 'Could not save that', 'build_edit_text');
        return;
      }
      const view = toView(p);
      broadcastAll((c) => c.broadcast(S2C.buildUpdated, { piece: view }));
      result(ctx, sid, reqId, 'edit', null, { pieceId: p.id });
      changed({ updated: [p] });
    },

    interact(ctx, sid, target) {
      const pid = pieceIdOfInteract(target.id);
      const piece = pid ? index.get(pid) : undefined;
      const it = piece ? pieceSeatInteractable(piece) : null;
      const p = ctx.getPlayer(sid);
      if (!it || !p || !piece) return { id: target.id, ok: false, error: 'not_found' };
      // Already on it: stand up (to the seat's exit).
      const mine = p.seat ? parseSeatRef(p.seat) : null;
      if (mine && mine.interactableId === it.id) {
        standUp(ctx, sid);
        return { id: target.id, ok: true };
      }
      const taken = new Set(seatedOn(piece.id).map((s) => s.seat));
      const free = it.seats.map((s, i) => ({ s, i })).filter(({ i }) => !taken.has(i));
      if (!free.length) return { id: target.id, ok: false, error: 'occupied' };
      free.sort((a, b) => Math.hypot(a.s.position.x - p.x, a.s.position.z - p.z) - Math.hypot(b.s.position.x - p.x, b.s.position.z - p.z));
      const choice = free[0]!;
      if (p.seat) p.seat = '';
      p.seat = seatRef(it.id, choice.i);
      p.anim = 'sit';
      p.rot = choice.s.yaw;
      ctx.teleport(sid, choice.s.position.x, choice.s.position.z, 'seated');
      return { id: target.id, ok: true };
    },

    clearedList(o = {}) {
      return [...cleared.values()].filter((c) => !o.profileId || c.profileId === o.profileId).sort((a, b) => b.clearedAt - a.clearedAt);
    },

    async regrow(force = false) {
      const t = now();
      const players = playerPositions();
      const due = [...cleared.values()].filter((c) => force || t - c.clearedAt >= opts.regrowMs);
      const back: string[] = [];
      for (const c of due) {
        const n = natureItem(c.natureId);
        if (n && canRegrow(index, n, players)) back.push(c.natureId);
      }
      if (!back.length) return [];
      await repo.removeCleared(back);
      for (const id of back) {
        cleared.delete(id);
        applyCleared(id, false);
      }
      broadcastAll((c) => c.broadcast(S2C.natureRestored, { ids: back, by: 'regrow' }));
      return back;
    },

    async adminRestoreNature(o) {
      const ids = (o.ids ?? [...cleared.values()].filter((c) => c.profileId === o.profileId).map((c) => c.natureId)).filter((id) => cleared.has(id));
      if (!ids.length) return [];
      await repo.removeCleared(ids);
      for (const id of ids) {
        cleared.delete(id);
        applyCleared(id, false);
      }
      broadcastAll((c) => c.broadcast(S2C.natureRestored, { ids, by: 'admin' }));
      return ids;
    },

    tick() {
      // Regrowth check twice a minute (the first room's tick drives it).
      const t = now();
      if (t - lastRegrowCheck < 30_000) return;
      lastRegrowCheck = t;
      void service.regrow().catch((err) => console.error('[building] regrow failed', err));
    },

    async adminRemove(ids) {
      const known = ids.filter((id) => index.get(id));
      if (!known.length) return [];
      const all = cascadeRemoval(index, known);
      for (const id of all) for (const s of seatedOn(id)) standUp(s.ctx, s.sid);
      await repo.remove(all);
      const gone = all.map((id) => index.get(id)).filter((p): p is PieceRecord => !!p);
      for (const id of all) removeLive(id);
      broadcastAll((c) => c.broadcast(S2C.buildRemoved, { ids: all, by: 'admin' }));
      changed({ removed: gone });
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

    stats(benchmark = false, reset = false) {
      const owners = new Set([...index.all()].map((p) => p.ownerId)).size;
      const out: BuildStats = {
        pieces: index.size,
        owners,
        placedTotal,
        validation: { count: vstats.count, avgMs: vstats.count ? vstats.total / vstats.count : 0, maxMs: vstats.max },
        eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
        snapshotBytes: service.snapshotChunks().reduce((n, c) => n + JSON.stringify(c).length, 0),
      };
      if (reset) {
        loop.reset();
        vstats.count = vstats.total = vstats.max = 0;
      }
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
