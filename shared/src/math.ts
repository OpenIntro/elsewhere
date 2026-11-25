/**
 * Small, dependency-free math helpers shared by client and server.
 *
 * Coordinate conventions (used everywhere in Elsewhere):
 *  - World units are metres-ish. The ground plane is X/Z; Y is up.
 *  - +X is east, +Z is south (towards the default isometric camera), -Z is north.
 *  - Yaw / rotation is radians around +Y. A yaw of 0 faces +Z (south).
 *    forward(yaw) = { x: sin(yaw), z: cos(yaw) }  (matches three.js Object3D.rotation.y)
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function vec2(x: number, z: number): Vec2 {
  return { x, z };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(dist2(a, b));
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.z);
}

/** Unit vector a yaw faces. */
export function forwardFromYaw(yaw: number): Vec2 {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/** Yaw that faces along (dx, dz). */
export function yawFromDirection(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

/** Shortest signed difference b - a between two angles. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Rotate a local-space offset by yaw into world space. */
export function rotateOffset(local: Vec2, yaw: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Local +Z maps to forward(yaw); local +X maps to the object's local X axis (three.js convention).
  return { x: local.x * c + local.z * s, z: -local.x * s + local.z * c };
}

/** Distance from point p to segment ab, plus the closest point. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; distance: number; t: number } {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1) : 0;
  const point = { x: a.x + abx * t, z: a.z + abz * t };
  return { point, distance: dist(p, point), t };
}

/** Distance from p to a polyline. */
export function distanceToPolyline(p: Vec2, points: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = closestPointOnSegment(p, points[i]!, points[i + 1]!).distance;
    if (d < best) best = d;
  }
  return best;
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit string hash (FNV-1a). Handy for seeding per-id randomness. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
