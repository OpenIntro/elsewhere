/**
 * Pure 2D (X/Z) movement collision used by BOTH client prediction and server
 * validation, so the two agree. Characters are circles of `radius`.
 *
 *   resolveMovement(from, to, radius) -> where you actually end up
 *   isWalkable(p, radius)             -> can a character stand here?
 *
 * Rules:
 *  - Static colliders (world/colliders.ts) push the character out; movement
 *    slides along surfaces rather than stopping dead.
 *  - Ground must be walkable (land above the waterline, or a deck/bridge).
 *    If the full step would leave walkable ground, the X-only and Z-only
 *    components are tried (sliding along shores), else the step is dropped.
 *  - Long moves are sub-stepped so you cannot tunnel through thin things.
 */
import { CONFIG } from './config.js';
import type { Vec2 } from './math.js';
import { COLLIDERS, colliderBoundingRadius, type Collider } from './world/colliders.js';
import { isGroundWalkable } from './world/ground.js';

// ---------------------------------------------------------------------------
// Broad phase: uniform grid over collider bounding circles.
// ---------------------------------------------------------------------------

const CELL = 4;

class ColliderGrid {
  private cells = new Map<number, Collider[]>();
  constructor(colliders: readonly Collider[]) {
    for (const c of colliders) {
      const r = colliderBoundingRadius(c);
      const x0 = Math.floor((c.x - r) / CELL);
      const x1 = Math.floor((c.x + r) / CELL);
      const z0 = Math.floor((c.z - r) / CELL);
      const z1 = Math.floor((c.z + r) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = key(x, z);
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(c);
        }
      }
    }
  }
  query(p: Vec2, radius: number, out: Set<Collider>): Set<Collider> {
    out.clear();
    const x0 = Math.floor((p.x - radius) / CELL);
    const x1 = Math.floor((p.x + radius) / CELL);
    const z0 = Math.floor((p.z - radius) / CELL);
    const z1 = Math.floor((p.z + radius) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(key(x, z));
        if (list) for (const c of list) out.add(c);
      }
    }
    return out;
  }
}

function key(x: number, z: number): number {
  // Grid spans well within ±2^15 cells.
  return ((x + 32768) << 16) | ((z + 32768) & 0xffff);
}

/**
 * Mutable collider layer on top of the static world (player-built pieces).
 * Colliders are grouped under an owner key (e.g. a piece id) so they can be
 * replaced/removed together. Both client prediction and server validation
 * consult it through the same CollisionWorld, so they stay in agreement as
 * long as both apply the same changes.
 */
export class DynamicColliderLayer {
  private cells = new Map<number, Set<Collider>>();
  private byOwner = new Map<string, { colliders: readonly Collider[]; keys: number[] }>();
  /** Increments on every change (consumers such as nav grids can cache against it). */
  version = 0;

  get size(): number {
    return this.byOwner.size;
  }

  set(owner: string, colliders: readonly Collider[]): void {
    this.remove(owner, false);
    if (!colliders.length) {
      this.version++;
      return;
    }
    const keys: number[] = [];
    for (const c of colliders) {
      const r = colliderBoundingRadius(c);
      const x0 = Math.floor((c.x - r) / CELL);
      const x1 = Math.floor((c.x + r) / CELL);
      const z0 = Math.floor((c.z - r) / CELL);
      const z1 = Math.floor((c.z + r) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = key(x, z);
          let set = this.cells.get(k);
          if (!set) this.cells.set(k, (set = new Set()));
          set.add(c);
          keys.push(k);
        }
      }
    }
    this.byOwner.set(owner, { colliders, keys });
    this.version++;
  }

  remove(owner: string, bump = true): void {
    const e = this.byOwner.get(owner);
    if (!e) return;
    const own = new Set(e.colliders);
    for (const k of e.keys) {
      const set = this.cells.get(k);
      if (!set) continue;
      for (const c of own) set.delete(c);
      if (set.size === 0) this.cells.delete(k);
    }
    this.byOwner.delete(owner);
    if (bump) this.version++;
  }

  clear(): void {
    this.cells.clear();
    this.byOwner.clear();
    this.version++;
  }

  /** Adds colliders near p to `out` (does not clear it). */
  queryInto(p: Vec2, radius: number, out: Set<Collider>): void {
    if (this.cells.size === 0) return;
    const x0 = Math.floor((p.x - radius) / CELL);
    const x1 = Math.floor((p.x + radius) / CELL);
    const z0 = Math.floor((p.z - radius) / CELL);
    const z1 = Math.floor((p.z + radius) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const set = this.cells.get(key(x, z));
        if (set) for (const c of set) out.add(c);
      }
    }
  }
}

export interface CollisionWorld {
  colliders: readonly Collider[];
  grid: ColliderGrid;
  /** Ground predicate; defaults to the island + decks. */
  groundWalkable: (p: Vec2) => boolean;
  /** Player-built pieces (mutable). Every collision query consults it too. */
  dynamic: DynamicColliderLayer;
  /** Static collider ids switched off (cleared rocks). Every query skips them. */
  disabled: Set<string>;
}

/** Build a collision world (tests can pass custom colliders / ground). Each world has its own empty dynamic layer. */
export function createCollisionWorld(colliders: readonly Collider[] = COLLIDERS, groundWalkable: (p: Vec2) => boolean = isGroundWalkable): CollisionWorld {
  return { colliders, grid: new ColliderGrid(colliders), groundWalkable, dynamic: new DynamicColliderLayer(), disabled: new Set() };
}

let defaultWorld: CollisionWorld | null = null;
function world(w?: CollisionWorld): CollisionWorld {
  if (w) return w;
  if (!defaultWorld) defaultWorld = createCollisionWorld();
  return defaultWorld;
}

/** The process-wide default collision world (static island + its dynamic layer). */
export function defaultCollisionWorld(): CollisionWorld {
  return world();
}

/** Static + dynamic colliders near p. */
function queryAll(cw: CollisionWorld, p: Vec2, radius: number, out: Set<Collider>): Set<Collider> {
  cw.grid.query(p, radius, out);
  if (cw.disabled.size) for (const c of out) if (cw.disabled.has(c.id)) out.delete(c);
  cw.dynamic.queryInto(p, radius, out);
  return out;
}

// ---------------------------------------------------------------------------
// Narrow phase
// ---------------------------------------------------------------------------

const EPS = 1e-4;
/** Push slightly past contact so the resolved position is robustly non-overlapping. */
const SKIN = 1e-3;

/** Returns the push vector needed to separate a circle at p from collider c, or null if not overlapping. */
export function penetration(p: Vec2, radius: number, c: Collider): Vec2 | null {
  if (c.shape === 'circle') {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const min = c.radius + radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return null;
    const d = Math.sqrt(d2);
    if (d < EPS) return { x: min + SKIN, z: 0 };
    const k = (min - d + SKIN) / d;
    return { x: dx * k, z: dz * k };
  }
  // Oriented box: work in local space (inverse of rotateOffset).
  const cs = Math.cos(c.yaw);
  const sn = Math.sin(c.yaw);
  const wx = p.x - c.x;
  const wz = p.z - c.z;
  const lx = wx * cs - wz * sn;
  const lz = wx * sn + wz * cs;
  const cx = Math.max(-c.halfWidth, Math.min(c.halfWidth, lx));
  const cz = Math.max(-c.halfDepth, Math.min(c.halfDepth, lz));
  let px: number;
  let pz: number;
  const ox = lx - cx;
  const oz = lz - cz;
  const od2 = ox * ox + oz * oz;
  if (od2 > EPS * EPS) {
    if (od2 >= radius * radius) return null;
    const d = Math.sqrt(od2);
    const k = (radius - d + SKIN) / d;
    px = ox * k;
    pz = oz * k;
  } else {
    // Centre inside the box: push out along the axis of least penetration.
    const penX = c.halfWidth - Math.abs(lx) + radius + SKIN;
    const penZ = c.halfDepth - Math.abs(lz) + radius + SKIN;
    if (penX < penZ) {
      px = (lx >= 0 ? 1 : -1) * penX;
      pz = 0;
    } else {
      px = 0;
      pz = (lz >= 0 ? 1 : -1) * penZ;
    }
  }
  // Back to world space (rotateOffset).
  return { x: px * cs + pz * sn, z: -px * sn + pz * cs };
}

const scratch = new Set<Collider>();

/** First collider overlapping a circle at p, or null. */
export function collidesAt(p: Vec2, radius: number = CONFIG.movement.playerRadius, w?: CollisionWorld): Collider | null {
  const cw = world(w);
  for (const c of queryAll(cw, p, radius, scratch)) {
    if (penetration(p, radius, c)) return c;
  }
  return null;
}

/** Iteratively push p out of all overlapping colliders. */
export function pushOut(p: Vec2, radius: number, w?: CollisionWorld, iterations = 4): Vec2 {
  const cw = world(w);
  let x = p.x;
  let z = p.z;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (const c of queryAll(cw, { x, z }, radius, scratch)) {
      const pen = penetration({ x, z }, radius, c);
      if (pen) {
        x += pen.x;
        z += pen.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x, z };
}

/** Can a character of `radius` stand at p? (ground walkable and no collider overlap) */
export function isWalkable(p: Vec2, radius: number = CONFIG.movement.playerRadius, w?: CollisionWorld): boolean {
  const cw = world(w);
  return cw.groundWalkable(p) && collidesAt(p, radius, cw) === null;
}

/**
 * Move a circle from `from` toward `to`, sliding along colliders and shores.
 * Never returns a position overlapping a collider when `from` was valid.
 */
export function resolveMovement(from: Vec2, to: Vec2, radius: number = CONFIG.movement.playerRadius, w?: CollisionWorld): Vec2 {
  const cw = world(w);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  if (!Number.isFinite(len)) return { x: from.x, z: from.z };
  const maxStep = Math.max(0.05, radius * 0.5);
  const steps = Math.min(256, Math.max(1, Math.ceil(len / maxStep)));
  const sx = dx / steps;
  const sz = dz / steps;
  let pos: Vec2 = { x: from.x, z: from.z };
  // If we start somewhere invalid (spawned badly, world data changed), don't trap the player.
  const startGroundOk = cw.groundWalkable(pos);

  const tryStep = (ox: number, oz: number): Vec2 | null => {
    const cand = pushOut({ x: pos.x + ox, z: pos.z + oz }, radius, cw);
    if (collidesAt(cand, radius, cw)) return null; // pinched between colliders
    if (startGroundOk && !cw.groundWalkable(cand)) return null;
    return cand;
  };

  for (let i = 0; i < steps; i++) {
    const next = tryStep(sx, sz) ?? (Math.abs(sx) > EPS ? tryStep(sx, 0) : null) ?? (Math.abs(sz) > EPS ? tryStep(0, sz) : null);
    if (!next) continue; // blocked this sub-step; later sub-steps may still slide
    pos = next;
  }
  return pos;
}

/**
 * Nearest walkable point to p by spiral search (for spawn nudging, seat exits,
 * server corrections). Returns null if nothing within maxRadius.
 */
export function findNearestWalkable(p: Vec2, radius: number = CONFIG.movement.playerRadius, maxRadius = 8, w?: CollisionWorld): Vec2 | null {
  const cw = world(w);
  if (isWalkable(p, radius, cw)) return { x: p.x, z: p.z };
  for (let r = 0.25; r <= maxRadius; r += 0.25) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.35));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
      if (isWalkable(q, radius, cw)) return q;
    }
  }
  return null;
}
