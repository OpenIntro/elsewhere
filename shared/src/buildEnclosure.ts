/**
 * Built interiors: the room of player-built pieces a point stands in (pure,
 * render-only — the client opens that room up for its own player, like the
 * town's walk-in cutaway). Geometric only: pieces of any owner count, since
 * nothing here changes what anybody may do.
 *
 * A room is either
 *  (a) "roofed": the union of the footprints of the roofs / upper floors over
 *      the point (house roofs, legacy roof tiles, upper floor tiles), grown
 *      across overlapping covers and across touching ones that no wall
 *      separates (so an L house with two roofs is one room, but two huts that
 *      share a wall stay two), or
 *  (b) "walled": with nothing over the point, the rectangle of walls around it
 *      (rays to the nearest wall line on each side, ≥ 3 sides at least 70%
 *      walled, like the roof tool's `detectRoofSpan`).
 * Either way at most 12 × 12 m (the largest house roof).
 */
import { CONFIG } from './config.js';
import { PIECES, WALL_KINDS, footprintOf, type PieceIndex, type PieceKind, type PieceLike, type Rect } from './building.js';
import type { Vec2 } from './math.js';

/** Largest room (metres, each side) — the house-roof maximum span. */
export const ENCLOSURE_MAX_SPAN = CONFIG.building.roof.maxSpan;
/** Enter a room once this far inside it (metres)… */
export const ENCLOSURE_ENTER = 0.3;
/** …and leave it only once this far outside it again. */
export const ENCLOSURE_LEAVE = 0.6;
/** Boundary tolerance: wall pieces within this of the room's outline belong to it. */
const EDGE = 0.5;
/** Share of a side that must be walled for a roofless room. */
const SIDE_COVER = 0.7;

export interface EnclosureWall {
  id: string;
  kind: PieceKind;
  /** Outward normals (unit, axis-aligned) of the room's outline at this piece; empty for a wall inside the room. */
  normals: Vec2[];
}

export interface Enclosure {
  kind: 'roofed' | 'walled';
  /** Bounding rectangle of the room (wall centre lines). */
  rect: Rect;
  /** The rectangles whose union is the room (one per cover for a roofed room; one for a walled room). */
  parts: Rect[];
  /** The storey the point stands on (0 = ground). */
  storey: number;
  /** Wall-type pieces of that storey on the room's outline (±0.5 m), with their outward normals. */
  walls: EnclosureWall[];
  /** Wall-type pieces of that storey standing inside the room (partitions). */
  inner: EnclosureWall[];
  /** Every piece above that storey inside the room (roofs, upper floors and walls, their mounts…). */
  above: string[];
}

type P3 = Vec2 & { y?: number };

const WALL_SET: ReadonlySet<PieceKind> = new Set(WALL_KINDS);
/** Long wall-shaped pieces that bound a roofless room (pillars and half walls do not). */
const BOUNDING: ReadonlySet<PieceKind> = new Set<PieceKind>(['wall', 'wall_window', 'doorway']);

function isCover(p: PieceLike, storey: number): boolean {
  return p.level > storey && (PIECES[p.kind].layer === 'roof' || (p.kind === 'floor' && p.level > 0));
}
function within(r: Rect, p: Vec2, m = 0): boolean {
  return p.x >= r.minX - m && p.x <= r.maxX + m && p.z >= r.minZ - m && p.z <= r.maxZ + m;
}
function inParts(parts: readonly Rect[], p: Vec2, m = 0): boolean {
  return parts.some((r) => within(r, p, m));
}
function bbox(parts: readonly Rect[]): Rect {
  return {
    minX: Math.min(...parts.map((r) => r.minX)),
    maxX: Math.max(...parts.map((r) => r.maxX)),
    minZ: Math.min(...parts.map((r) => r.minZ)),
    maxZ: Math.max(...parts.map((r) => r.maxZ)),
  };
}
const spanOk = (r: Rect) => r.maxX - r.minX <= ENCLOSURE_MAX_SPAN + 1e-6 && r.maxZ - r.minZ <= ENCLOSURE_MAX_SPAN + 1e-6 && r.maxX - r.minX >= CONFIG.building.roof.minSpan - 1e-6 && r.maxZ - r.minZ >= CONFIG.building.roof.minSpan - 1e-6;

/** The storey a point stands on: the highest level whose wall-type pieces around it span its height (0 without a height). */
export function storeyAt<P extends PieceLike>(index: PieceIndex<P>, p: P3): number {
  if (p.y === undefined) return 0;
  const H = CONFIG.building.storeyHeight;
  let s = 0;
  for (const q of index.query({ minX: p.x - 6, maxX: p.x + 6, minZ: p.z - 6, maxZ: p.z + 6 })) {
    if (!PIECES[q.kind].structural || q.level <= s) continue;
    if (q.y <= p.y + 0.3 && q.y + H > p.y + 0.3) s = q.level;
  }
  return s;
}

/** Fraction of the segment (axis-aligned line `line` from a to b, horizontal = along X) covered by pieces passing `ok` at `level`. */
function lineCover<P extends PieceLike>(index: PieceIndex<P>, horizontal: boolean, line: number, a: number, b: number, level: number, ok: (k: PieceKind) => boolean): number {
  if (b - a < 1e-6) return 0;
  const q: Rect = horizontal ? { minX: a, maxX: b, minZ: line - 0.2, maxZ: line + 0.2 } : { minX: line - 0.2, maxX: line + 0.2, minZ: a, maxZ: b };
  const spans: [number, number][] = [];
  for (const p of index.query(q)) {
    if (p.level !== level || !ok(p.kind)) continue;
    const f = footprintOf(p);
    // The piece must run along the line (not merely cross it).
    if (horizontal ? f.minZ - 0.15 <= line && f.maxZ + 0.15 >= line && f.maxX - f.minX >= f.maxZ - f.minZ - 1e-6 : f.minX - 0.15 <= line && f.maxX + 0.15 >= line && f.maxZ - f.minZ >= f.maxX - f.minX - 1e-6) {
      const lo = Math.max(a, horizontal ? f.minX : f.minZ);
      const hi = Math.min(b, horizontal ? f.maxX : f.maxZ);
      if (hi > lo) spans.push([lo, hi]);
    }
  }
  spans.sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let at = a;
  for (const [lo, hi] of spans) {
    const s0 = Math.max(lo, at);
    if (hi > s0) {
      covered += hi - s0;
      at = hi;
    }
  }
  return covered / (b - a);
}

/** Shared edge of two touching rectangles (a segment), or null when they do not share one of at least `min` metres. */
function sharedEdge(a: Rect, b: Rect, min = 0.9): { horizontal: boolean; line: number; lo: number; hi: number } | null {
  const e = 0.05;
  for (const [la, lb] of [
    [a.maxX, b.minX],
    [a.minX, b.maxX],
  ] as const) {
    if (Math.abs(la - lb) < e) {
      const lo = Math.max(a.minZ, b.minZ);
      const hi = Math.min(a.maxZ, b.maxZ);
      if (hi - lo >= min) return { horizontal: false, line: la, lo, hi };
    }
  }
  for (const [la, lb] of [
    [a.maxZ, b.minZ],
    [a.minZ, b.maxZ],
  ] as const) {
    if (Math.abs(la - lb) < e) {
      const lo = Math.max(a.minX, b.minX);
      const hi = Math.min(a.maxX, b.maxX);
      if (hi - lo >= min) return { horizontal: true, line: la, lo, hi };
    }
  }
  return null;
}
function overlapping(a: Rect, b: Rect, m = 0.05): boolean {
  return a.minX + m < b.maxX && b.minX + m < a.maxX && a.minZ + m < b.maxZ && b.minZ + m < a.maxZ;
}

/** (a) The roofed room over p: covers containing p, grown across overlaps and unwalled shared edges. */
function roofedRoom<P extends PieceLike>(index: PieceIndex<P>, p: Vec2, storey: number): Rect[] | null {
  const seeds = index.query({ minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z }, 0.01).filter((q) => isCover(q, storey) && within(footprintOf(q), p));
  if (!seeds.length) return null;
  const parts = new Map<string, Rect>();
  const queue: P[] = [];
  for (const s of seeds) {
    const f = footprintOf(s);
    if (!spanOk2(bbox([...parts.values(), f]))) continue;
    parts.set(s.id, f);
    queue.push(s);
  }
  if (!parts.size) return null;
  while (queue.length && parts.size < 64) {
    const q = queue.pop()!;
    const fq = parts.get(q.id)!;
    for (const n of index.query(fq, 0.1)) {
      if (parts.has(n.id) || !isCover(n, storey)) continue;
      const fn = footprintOf(n);
      let joins = overlapping(fq, fn);
      if (!joins) {
        const e = sharedEdge(fq, fn);
        // Touching covers join unless a wall of this storey separates them (two huts sharing a wall).
        if (e) joins = lineCover(index, e.horizontal, e.line, e.lo, e.hi, storey, (k) => BOUNDING.has(k)) < 0.5;
      }
      if (!joins || !spanOk2(bbox([...parts.values(), fn]))) continue;
      parts.set(n.id, fn);
      queue.push(n);
    }
  }
  return [...parts.values()];
}
/** Size cap only (covers smaller than the minimum span, like one roof tile, are fine). */
const spanOk2 = (r: Rect) => r.maxX - r.minX <= ENCLOSURE_MAX_SPAN + 1e-6 && r.maxZ - r.minZ <= ENCLOSURE_MAX_SPAN + 1e-6;

/** (b) The walled rectangle around p (no roof): nearest wall lines on each side, ≥ 3 sides ≥ 70% walled. */
function walledRoom<P extends PieceLike>(index: PieceIndex<P>, p: Vec2, storey: number): Rect | null {
  const R = ENCLOSURE_MAX_SPAN + 0.5;
  // Nearest bounding wall line in each direction whose span passes p.
  const near = { minX: -Infinity, maxX: Infinity, minZ: -Infinity, maxZ: Infinity };
  for (const q of index.query({ minX: p.x - R, maxX: p.x + R, minZ: p.z - R, maxZ: p.z + R })) {
    if (q.level !== storey || !BOUNDING.has(q.kind)) continue;
    const f = footprintOf(q);
    const alongX = f.maxX - f.minX > f.maxZ - f.minZ;
    if (alongX) {
      if (p.x < f.minX - 0.05 || p.x > f.maxX + 0.05) continue;
      if (q.z < p.z - 0.05 && q.z > near.minZ) near.minZ = q.z;
      if (q.z > p.z + 0.05 && q.z < near.maxZ) near.maxZ = q.z;
    } else {
      if (p.z < f.minZ - 0.05 || p.z > f.maxZ + 0.05) continue;
      if (q.x < p.x - 0.05 && q.x > near.minX) near.minX = q.x;
      if (q.x > p.x + 0.05 && q.x < near.maxX) near.maxX = q.x;
    }
  }
  const sides = (r: Rect) => [
    lineCover(index, true, r.minZ, r.minX, r.maxX, storey, (k) => WALL_SET.has(k)),
    lineCover(index, true, r.maxZ, r.minX, r.maxX, storey, (k) => WALL_SET.has(k)),
    lineCover(index, false, r.minX, r.minZ, r.maxZ, storey, (k) => WALL_SET.has(k)),
    lineCover(index, false, r.maxX, r.minZ, r.maxZ, storey, (k) => WALL_SET.has(k)),
  ];
  const good = (r: Rect) => Number.isFinite(r.minX + r.maxX + r.minZ + r.maxZ) && spanOk(r) && sides(r).filter((c) => c >= SIDE_COVER).length >= 3;
  if (good(near)) return { ...near };
  // One open (or too far) side: close it where the two side walls end.
  const runEnd = (horizontal: boolean, line: number, from: number, dir: 1 | -1): number => {
    // Walk along the wall line from `from` while wall pieces continue (gaps up to 0.3 m).
    let at = from;
    for (let guard = 0; guard < 16; guard++) {
      let next = at;
      const probe: Rect = horizontal ? { minX: Math.min(at, at + dir * 2.4), maxX: Math.max(at, at + dir * 2.4), minZ: line - 0.2, maxZ: line + 0.2 } : { minX: line - 0.2, maxX: line + 0.2, minZ: Math.min(at, at + dir * 2.4), maxZ: Math.max(at, at + dir * 2.4) };
      for (const q of index.query(probe)) {
        if (q.level !== storey || !WALL_SET.has(q.kind)) continue;
        const f = footprintOf(q);
        if (horizontal ? f.minZ - 0.15 > line || f.maxZ + 0.15 < line : f.minX - 0.15 > line || f.maxX + 0.15 < line) continue;
        const lo = horizontal ? f.minX : f.minZ;
        const hi = horizontal ? f.maxX : f.maxZ;
        if (dir > 0 && lo <= at + 0.3 && hi > next) next = hi;
        if (dir < 0 && hi >= at - 0.3 && lo < next) next = lo;
      }
      if (next === at) break;
      at = next;
    }
    return Math.round(at);
  };
  const tries: Rect[] = [];
  if (Number.isFinite(near.minX) && Number.isFinite(near.maxX)) {
    if (Number.isFinite(near.minZ)) tries.push({ ...near, maxZ: Math.max(runEnd(false, near.minX, near.minZ, 1), runEnd(false, near.maxX, near.minZ, 1)) });
    if (Number.isFinite(near.maxZ)) tries.push({ ...near, minZ: Math.min(runEnd(false, near.minX, near.maxZ, -1), runEnd(false, near.maxX, near.maxZ, -1)) });
  }
  if (Number.isFinite(near.minZ) && Number.isFinite(near.maxZ)) {
    if (Number.isFinite(near.minX)) tries.push({ ...near, maxX: Math.max(runEnd(true, near.minZ, near.minX, 1), runEnd(true, near.maxZ, near.minX, 1)) });
    if (Number.isFinite(near.maxX)) tries.push({ ...near, minX: Math.min(runEnd(true, near.minZ, near.maxX, -1), runEnd(true, near.maxZ, near.maxX, -1)) });
  }
  const ok = tries.filter((r) => within(r, p) && good(r));
  ok.sort((a, b) => (a.maxX - a.minX) * (a.maxZ - a.minZ) - (b.maxX - b.minX) * (b.maxZ - b.minZ));
  return ok[0] ?? null;
}

const AXES: readonly Vec2[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

/**
 * The room of built pieces containing `p` (x, z; y optional — the storey it
 * stands on, ground without), or null when it stands in none.
 */
export function enclosureAt<P extends PieceLike>(index: PieceIndex<P>, p: P3): Enclosure | null {
  const storey = storeyAt(index, p);
  let parts = roofedRoom(index, p, storey);
  let kind: Enclosure['kind'] = 'roofed';
  if (!parts) {
    const w = walledRoom(index, p, storey);
    if (!w) return null;
    parts = [w];
    kind = 'walled';
  }
  const rect = bbox(parts);
  const walls: EnclosureWall[] = [];
  const inner: EnclosureWall[] = [];
  const above: string[] = [];
  const S = 0.4;
  for (const q of index.query(rect, EDGE + 0.3)) {
    if (q.level > storey) {
      // Above this storey: inside the room when its anchor (a mount's wall centre) is within the outline,
      // or most of its footprint is.
      const f = footprintOf(q);
      const anchor = PIECES[q.kind].mount ? { x: q.x, z: q.z } : { x: (f.minX + f.maxX) / 2, z: (f.minZ + f.maxZ) / 2 };
      let inside = inParts(parts, anchor, 0.3);
      if (!inside) {
        const area = Math.max(1e-6, (f.maxX - f.minX) * (f.maxZ - f.minZ));
        let shared = 0;
        for (const r of parts) shared += Math.max(0, Math.min(f.maxX, r.maxX) - Math.max(f.minX, r.minX)) * Math.max(0, Math.min(f.maxZ, r.maxZ) - Math.max(f.minZ, r.minZ));
        inside = shared / area >= 0.5;
      }
      if (inside) above.push(q.id);
      continue;
    }
    if (q.level !== storey || !WALL_SET.has(q.kind)) continue;
    const c = { x: q.x, z: q.z };
    if (!inParts(parts, c, EDGE)) continue;
    const f = footprintOf(q);
    const square = Math.abs(f.maxX - f.minX - (f.maxZ - f.minZ)) < 1e-6;
    const alongX = f.maxX - f.minX > f.maxZ - f.minZ;
    const axes = square ? AXES : alongX ? AXES.slice(2) : AXES.slice(0, 2);
    const normals = axes.filter((n) => !inParts(parts, { x: c.x + n.x * S, z: c.z + n.z * S }, -0.01) && inParts(parts, { x: c.x - n.x * S, z: c.z - n.z * S }, -0.01));
    // A wall piece merely touching the outline from outside (a garden wall running off a corner) is not part of it.
    if (normals.length) walls.push({ id: q.id, kind: q.kind, normals });
    else if (inParts(parts, c, -0.01) && axes.every((n) => inParts(parts, { x: c.x + n.x * S, z: c.z + n.z * S }, -0.01))) inner.push({ id: q.id, kind: q.kind, normals: [] });
  }
  return { kind, rect, parts, storey, walls, inner, above };
}

/** How far p is inside the room (metres; negative outside). */
export function enclosureDepth(e: Pick<Enclosure, 'parts'>, p: Vec2): number {
  let best = -Infinity;
  for (const r of e.parts) {
    const dx = Math.min(p.x - r.minX, r.maxX - p.x);
    const dz = Math.min(p.z - r.minZ, r.maxZ - p.z);
    let d: number;
    if (dx >= 0 && dz >= 0) d = Math.min(dx, dz);
    else d = -Math.hypot(Math.min(0, dx), Math.min(0, dz));
    if (d > best) best = d;
  }
  return best;
}

/** Doorway hysteresis: active once ≥ ENCLOSURE_ENTER inside, inactive again once ≥ ENCLOSURE_LEAVE outside. */
export function enclosureHysteresis(wasActive: boolean, depth: number): boolean {
  return wasActive ? depth > -ENCLOSURE_LEAVE : depth >= ENCLOSURE_ENTER;
}

export interface EnclosureTrack {
  active: boolean;
  enclosure: Enclosure | null;
  /** Last point well inside the active room (re-finds it while the player steps out over the threshold). */
  anchor: P3 | null;
}
export const NO_ENCLOSURE: EnclosureTrack = { active: false, enclosure: null, anchor: null };

/** One step of the per-viewer tracker: the room the player is in, with hysteresis at the doorway. */
export function trackEnclosure<P extends PieceLike>(index: PieceIndex<P>, p: P3, prev: EnclosureTrack): EnclosureTrack {
  const here = enclosureAt(index, p);
  if (here && enclosureDepth(here, p) >= ENCLOSURE_ENTER) return { active: true, enclosure: here, anchor: { ...p } };
  if (prev.active && prev.anchor) {
    const room = here && enclosureDepth(here, p) >= 0 ? here : enclosureAt(index, prev.anchor);
    if (room && enclosureHysteresis(true, enclosureDepth(room, p))) return { active: true, enclosure: room, anchor: prev.anchor };
  }
  return NO_ENCLOSURE;
}
