/**
 * Deterministic island terrain. Pure functions of (x, z) so the client mesh,
 * client prediction and server validation all agree exactly.
 *
 *  - `shoreRadius(theta)`: organic coastline in polar form around the origin.
 *  - `terrainHeight(x, z)`: ground height (water level is WATER_LEVEL = 0).
 *    Rolling hills, a wooded hill, a raised Town Hall, a promontory under The
 *    Unknown, flat pads under built-up locations, and a creek through The Woods.
 *  - `groundHeight(x, z)`: what a character stands on (terrain or a deck/bridge).
 */
import { clamp, distanceToPolyline, lerp, smoothstep, type Vec2 } from '../math.js';
import { BUILDINGS } from './buildings.js';
import { LOCATIONS } from './locations.js';

export const WATER_LEVEL = 0;
/** Ground must be this far above water to be walkable (unless on a deck). */
export const WALKABLE_MIN_HEIGHT = WATER_LEVEL + 0.12;
/** Axis-aligned bounds that fully contain the island (+ some sea), for meshes/minimaps. */
export const WORLD_BOUNDS = { minX: -80, maxX: 80, minZ: -90, maxZ: 75 } as const;

interface AngularBump {
  /** Angle (radians, atan2(z, x)). */
  theta: number;
  /** Angular half-width (radians). */
  width: number;
  /** Radius delta (units). */
  amount: number;
}

const SHORE_BASE = 57;
const SHORE_HARMONICS: readonly [amp: number, freq: number, phase: number][] = [
  [3.2, 3, 0.5],
  [2.1, 5, 2.0],
  [1.2, 7, 4.1],
  [0.6, 11, 1.3],
];
const SHORE_BUMPS: readonly AngularBump[] = [
  // Promontory reaching north-north-west towards The Unknown.
  { theta: Math.atan2(-61, -10), width: 0.28, amount: 17 },
  // Gentle bay at the Waterfront so the dock reaches open water.
  { theta: Math.atan2(43, 12), width: 0.35, amount: -6 },
  // Western shoulder for the Residential District gardens.
  { theta: Math.atan2(16, -34), width: 0.45, amount: 3 },
  // A little eastern headland past the Workshop.
  { theta: Math.atan2(10, 50), width: 0.25, amount: 4 },
];

function angularDistance(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/** Distance from origin to the coastline along angle theta = atan2(z, x). */
export function shoreRadius(theta: number): number {
  let r = SHORE_BASE;
  for (const [amp, freq, phase] of SHORE_HARMONICS) r += amp * Math.sin(freq * theta + phase);
  for (const b of SHORE_BUMPS) {
    const t = angularDistance(theta, b.theta) / b.width;
    r += b.amount * Math.exp(-t * t);
  }
  return r;
}

/** Signed distance-ish inland from the coast: >0 on land, <0 at sea (radial approximation). */
export function inlandDistance(x: number, z: number): number {
  return shoreRadius(Math.atan2(z, x)) - Math.hypot(x, z);
}

/** True if (x, z) is inside the coastline by at least `margin`. */
export function isOnIsland(x: number, z: number, margin = 0): boolean {
  return inlandDistance(x, z) >= margin;
}

/** Sampled coastline polygon (counter-clockwise), handy for rendering foam/beaches/minimap. */
export function islandOutline(segments = 256): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = -Math.PI + (i / segments) * Math.PI * 2;
    const r = shoreRadius(theta);
    out.push({ x: Math.cos(theta) * r, z: Math.sin(theta) * r });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Creek through The Woods (carved below water level; crossed by a bridge).
// ---------------------------------------------------------------------------

export const CREEK_POINTS: readonly Vec2[] = [
  { x: -19, z: -43.5 }, // spring
  { x: -24, z: -45.2 },
  { x: -30, z: -46.5 },
  { x: -37, z: -45 },
  { x: -44, z: -46.5 },
  { x: -51, z: -45.5 },
  { x: -58, z: -47 },
  { x: -68, z: -48 }, // out to sea
];
/** Half-width of the fully carved channel / of the softened banks. */
export const CREEK_CORE_HALF_WIDTH = 1.1;
export const CREEK_BANK_HALF_WIDTH = 2.8;
const CREEK_BED = -0.6;

// ---------------------------------------------------------------------------
// Height field
// ---------------------------------------------------------------------------

interface HeightBump {
  x: number;
  z: number;
  radius: number;
  amount: number;
}

const HEIGHT_BUMPS: readonly HeightBump[] = [
  { x: -38, z: -27, radius: 16, amount: 3.2 }, // wooded hill
  { x: -18, z: -36, radius: 10, amount: 1.4 },
  { x: 2, z: -28, radius: 14, amount: 1.6 }, // Town Hall rise
  { x: -10, z: -61, radius: 12, amount: 2.6 }, // The Unknown's rise
  { x: 38, z: -12, radius: 12, amount: 1.8 }, // eastern knoll
];

function rawHeight(x: number, z: number): number {
  const d = inlandDistance(x, z);
  if (d < 0) {
    // Seabed slopes away from the shore.
    return Math.max(-6, 0.25 + d * 0.5);
  }
  const shore = smoothstep(0, 10, d);
  const hills =
    0.9 * Math.sin(x * 0.07 + 1.3) * Math.cos(z * 0.06 - 0.4) +
    0.45 * Math.sin(x * 0.13 - z * 0.11 + 2.1) +
    0.2 * Math.sin(x * 0.29 + z * 0.23 + 0.7);
  let h = 0.25 + shore * (1.6 + hills);
  for (const b of HEIGHT_BUMPS) {
    const q = ((x - b.x) ** 2 + (z - b.z) ** 2) / (b.radius * b.radius);
    h += b.amount * Math.exp(-q * 2) * shore;
  }
  return h;
}

interface Pad {
  x: number;
  z: number;
  radius: number;
  height: number;
}

let padsCache: Pad[] | null = null;
function pads(): Pad[] {
  if (!padsCache) {
    padsCache = LOCATIONS.filter((l) => l.flatten).map((l) => ({
      x: l.center.x,
      z: l.center.z,
      radius: l.radius,
      height: Math.max(0.7, rawHeight(l.center.x, l.center.z)),
    }));
  }
  return padsCache;
}

/**
 * Level ground under walk-in buildings: their raised floors are flat, so the
 * terrain is levelled to the height at the building centre over the footprint
 * (+ BUILDING_PAD_MARGIN) and blended back over BUILDING_PAD_BLEND metres.
 */
const BUILDING_PAD_MARGIN = 0.9;
const BUILDING_PAD_BLEND = 3.5;
interface BuildingPad {
  x: number;
  z: number;
  c: number;
  s: number;
  hw: number;
  hd: number;
  r: number;
  height: number;
}
let buildingPadsCache: BuildingPad[] | null = null;
function buildingPads(): BuildingPad[] {
  if (!buildingPadsCache) {
    buildingPadsCache = BUILDINGS.filter((b) => b.enterable).map((b) => ({
      x: b.position.x,
      z: b.position.z,
      c: Math.cos(b.yaw),
      s: Math.sin(b.yaw),
      hw: b.width / 2 + BUILDING_PAD_MARGIN,
      hd: b.depth / 2 + BUILDING_PAD_MARGIN,
      r: Math.hypot(b.width / 2, b.depth / 2) + BUILDING_PAD_MARGIN + BUILDING_PAD_BLEND,
      height: locationPadded(b.position.x, b.position.z),
    }));
  }
  return buildingPadsCache;
}

function locationPadded(x: number, z: number): number {
  let h = rawHeight(x, z);
  const d = inlandDistance(x, z);
  if (d > 0) {
    const shoreW = smoothstep(0, 4, d);
    for (const p of pads()) {
      const dist = Math.hypot(x - p.x, z - p.z);
      if (dist < p.radius * 1.25) {
        const w = (1 - smoothstep(p.radius * 0.75, p.radius * 1.25, dist)) * shoreW;
        h = lerp(h, p.height, w);
      }
    }
  }
  return h;
}

/** Terrain height at (x, z). Deterministic and continuous. */
export function terrainHeight(x: number, z: number): number {
  let h = locationPadded(x, z);
  for (const p of buildingPads()) {
    const dx = x - p.x;
    const dz = z - p.z;
    if (dx * dx + dz * dz > p.r * p.r) continue;
    const lx = dx * p.c - dz * p.s;
    const lz = dx * p.s + dz * p.c;
    const ex = Math.max(Math.abs(lx) - p.hw, 0);
    const ez = Math.max(Math.abs(lz) - p.hd, 0);
    const w = 1 - smoothstep(0, BUILDING_PAD_BLEND, Math.hypot(ex, ez));
    if (w > 0) h = lerp(h, p.height, w);
  }
  // Creek carve.
  const dc = distanceToPolyline({ x, z }, CREEK_POINTS);
  if (dc < CREEK_BANK_HALF_WIDTH) {
    const t = 1 - smoothstep(CREEK_CORE_HALF_WIDTH, CREEK_BANK_HALF_WIDTH, dc);
    h = lerp(h, Math.min(h, CREEK_BED), t);
  }
  return h;
}

/** Approximate surface normal (unnormalized-safe: returns unit vector). */
export function terrainNormal(x: number, z: number, eps = 0.25): { x: number; y: number; z: number } {
  const hx = terrainHeight(x + eps, z) - terrainHeight(x - eps, z);
  const hz = terrainHeight(x, z + eps) - terrainHeight(x, z - eps);
  const nx = -hx;
  const ny = 2 * eps;
  const nz = -hz;
  const len = Math.hypot(nx, ny, nz);
  return { x: nx / len, y: ny / len, z: nz / len };
}

/** Clamp to world bounds (safety for untrusted coordinates). */
export function clampToWorld(p: Vec2): Vec2 {
  return {
    x: clamp(p.x, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX),
    z: clamp(p.z, WORLD_BOUNDS.minZ, WORLD_BOUNDS.maxZ),
  };
}
