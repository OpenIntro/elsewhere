/**
 * Footstep surface under a world point, derived purely from shared world data
 * (decks, paths, coastline, the square's plaza, the Woods). No DOM; unit-tested.
 *
 * Priority: indoor floor (wood boards / hall flagstones) > deck (wood) > path
 * ribbon (its `surface`) > town-square plaza (stone) > beach strip near the
 * coast (sand) > Woods floor (leaves) > grass.
 */
import { DECKS, FOUNTAIN, LOCATIONS, PATHS, closestPointOnSegment, deckAt, inlandDistance, interiorAt, terrainHeight, type PathSurface, type Vec2 } from '@elsewhere/shared';

export type Surface = 'grass' | 'leaves' | 'stone' | 'gravel' | 'dirt' | 'sand' | 'wood';
export const SURFACES: readonly Surface[] = ['grass', 'leaves', 'stone', 'gravel', 'dirt', 'sand', 'wood'];

const PATH_SURFACE: Record<PathSurface, Surface> = { cobble: 'stone', gravel: 'gravel', dirt: 'dirt', sand: 'sand', boardwalk: 'wood' };

/** Paved plaza around the fountain (Town Square is a flattened pad). */
export const PLAZA_RADIUS = 9.5;
/** Beach: within this many metres of the coastline and low-lying. */
export const BEACH_WIDTH = 6;
export const BEACH_MAX_HEIGHT = 1.3;

const WOODS = LOCATIONS.find((l) => l.id === 'woods')!;

// Precompute path segments with bounding boxes for a cheap reject.
interface Seg {
  a: Vec2;
  b: Vec2;
  half: number;
  surface: Surface;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const SEGS: Seg[] = [];
for (const path of PATHS) {
  const half = path.width / 2 + 0.1;
  for (let i = 0; i + 1 < path.points.length; i++) {
    const a = path.points[i]!;
    const b = path.points[i + 1]!;
    SEGS.push({
      a,
      b,
      half,
      surface: PATH_SURFACE[path.surface],
      minX: Math.min(a.x, b.x) - half,
      maxX: Math.max(a.x, b.x) + half,
      minZ: Math.min(a.z, b.z) - half,
      maxZ: Math.max(a.z, b.z) + half,
    });
  }
}

/** Surface of the path ribbon covering p, or null. */
export function pathSurfaceAt(p: Vec2): Surface | null {
  let best: Surface | null = null;
  let bestD = Infinity;
  for (const s of SEGS) {
    if (p.x < s.minX || p.x > s.maxX || p.z < s.minZ || p.z > s.maxZ) continue;
    const d = closestPointOnSegment(p, s.a, s.b).distance;
    if (d <= s.half && d < bestD) {
      bestD = d;
      best = s.surface;
    }
  }
  return best;
}

export function surfaceAt(x: number, z: number): Surface {
  const p = { x, z };
  const inside = interiorAt(p);
  if (inside) return inside.floor === 'stone' ? 'stone' : 'wood';
  if (deckAt(p)) return 'wood';
  const path = pathSurfaceAt(p);
  if (path) return path;
  if (Math.hypot(x - FOUNTAIN.position.x, z - FOUNTAIN.position.z) <= PLAZA_RADIUS) return 'stone';
  if (inlandDistance(x, z) < BEACH_WIDTH && terrainHeight(x, z) < BEACH_MAX_HEIGHT) return 'sand';
  if (Math.hypot(x - WOODS.center.x, z - WOODS.center.z) <= WOODS.radius + 4) return 'leaves';
  return 'grass';
}

/** Exposed for tests: a point known to be on each deck. */
export const DECK_CENTERS: readonly Vec2[] = DECKS.map((d) => d.center);
