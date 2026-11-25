/**
 * Paths (visual + navigation hints) and walkable decks (dock, bridge).
 *
 * Paths are polylines; the world renderer draws them as ribbons of `width`
 * following terrainHeight. They do not affect collision. Decks DO affect
 * walkability: a point on a deck is walkable even over water, and the
 * character stands at the deck's `y` (see groundHeight in ./ground.ts).
 */
import { yawFromDirection, type Vec2 } from '../math.js';
import type { LocationId } from './locations.js';
import { terrainHeight } from './terrain.js';

export type PathSurface = 'cobble' | 'gravel' | 'dirt' | 'sand' | 'boardwalk';

export interface WorldPath {
  id: string;
  name?: string;
  surface: PathSurface;
  width: number;
  points: readonly Vec2[];
  /** Locations this path connects (for wayfinding / signposts). */
  connects: readonly LocationId[];
}

const p = (x: number, z: number): Vec2 => ({ x, z });

export const PATHS: readonly WorldPath[] = [
  {
    id: 'path_square_cafe',
    surface: 'cobble',
    width: 2.6,
    points: [p(5.5, -2.5), p(9.5, -5.2), p(13.5, -6.8), p(16.6, -6.4)],
    connects: ['town_square', 'cafe'],
  },
  {
    id: 'path_square_store',
    surface: 'cobble',
    width: 2.6,
    points: [p(-5.8, -1.5), p(-10.5, -4.2), p(-15, -6.5)],
    connects: ['town_square', 'general_store'],
  },
  {
    id: 'path_square_hall',
    name: 'Bell Walk',
    surface: 'cobble',
    width: 3,
    points: [p(0.5, -9.5), p(3, -13.5), p(2.2, -17.5), p(2, -21)],
    connects: ['town_square', 'town_hall'],
  },
  {
    id: 'path_square_residential',
    name: 'Garden Lane',
    surface: 'gravel',
    width: 2.4,
    points: [p(-7.5, 7), p(-13, 10.5), p(-19, 10.5), p(-24, 12), p(-28.5, 12.8)],
    connects: ['town_square', 'residential'],
  },
  {
    id: 'path_residential_loop',
    surface: 'gravel',
    width: 2.2,
    points: [p(-28.5, 12.8), p(-32.5, 10.8), p(-38.5, 11.2), p(-42.6, 15.5), p(-42, 21.6), p(-36.5, 24.8), p(-31, 22.4), p(-28.5, 17.5), p(-28.5, 12.8)],
    connects: ['residential'],
  },
  {
    id: 'path_square_workshop',
    surface: 'gravel',
    width: 2.4,
    points: [p(7.5, 7.5), p(13.5, 10.5), p(20, 10.2), p(25.5, 11.6), p(29.5, 15.2), p(33.2, 15.6)],
    connects: ['town_square', 'workshop'],
  },
  {
    id: 'path_square_waterfront',
    name: 'Shore Road',
    surface: 'cobble',
    width: 2.8,
    points: [p(1.5, 11.5), p(4.5, 18.5), p(3.5, 25.5), p(7.5, 31.5), p(10.5, 37.5), p(13, 42), p(14, 46.5)],
    connects: ['town_square', 'waterfront'],
  },
  {
    id: 'path_coastal',
    name: 'Coastal Walk',
    surface: 'sand',
    width: 2.2,
    points: [p(-31, 25.5), p(-24, 31.5), p(-15, 35.5), p(-5, 38.5), p(4, 41.5), p(9.5, 42.5)],
    connects: ['residential', 'waterfront'],
  },
  {
    id: 'path_house_4',
    surface: 'gravel',
    width: 1.8,
    points: [p(-40.4, 28.4), p(-38.9, 26.0), p(-37.2, 24.4)],
    connects: ['residential'],
  },
  {
    id: 'path_house_5',
    surface: 'gravel',
    width: 1.8,
    points: [p(-31.0, 34.9), p(-27.4, 33.6), p(-24, 31.5)],
    connects: ['residential', 'waterfront'],
  },
  {
    id: 'path_workshop_waterfront',
    surface: 'dirt',
    width: 2,
    points: [p(30.5, 16.4), p(30.2, 19.5), p(28.5, 26.5), p(23, 34), p(17, 40)],
    connects: ['workshop', 'waterfront'],
  },
  {
    id: 'path_cafe_hall',
    surface: 'gravel',
    width: 2,
    points: [p(15.4, -10.6), p(14.0, -14.8), p(11.6, -19.2), p(8.5, -22)],
    connects: ['cafe', 'town_hall'],
  },
  {
    id: 'path_store_woods',
    surface: 'dirt',
    width: 2,
    points: [p(-21.5, -12), p(-24.5, -14.5), p(-28, -16.8)],
    connects: ['general_store', 'woods'],
  },
  {
    id: 'trail_hall_woods',
    name: 'Old Trail',
    surface: 'dirt',
    width: 2,
    points: [p(-4.5, -24.5), p(-9, -28.5), p(-12.5, -33), p(-15, -38.5)],
    connects: ['town_hall', 'woods'],
  },
  {
    id: 'trail_woods_loop',
    name: 'Fern Loop',
    surface: 'dirt',
    width: 1.8,
    points: [
      p(-15, -38.5), p(-22.5, -36.5), p(-30.5, -33.5), p(-37.5, -30), p(-42, -24), p(-38, -17.5),
      p(-30.5, -17), p(-24.5, -21), p(-19, -26.5), p(-14.5, -32.5), p(-15, -38.5),
    ],
    connects: ['woods'],
  },
  {
    id: 'trail_woods_unknown',
    name: 'Stone Trail',
    surface: 'dirt',
    width: 1.8,
    points: [p(-15, -38.5), p(-20, -40.8), p(-23.4, -42.2), p(-24.6, -48.2), p(-22.5, -52.5), p(-18, -56), p(-14.5, -57.3)],
    connects: ['woods', 'the_unknown'],
  },
];

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

export type DeckKind = 'dock' | 'bridge';

export interface Deck {
  id: string;
  kind: DeckKind;
  name: string;
  /** Rectangle center. */
  center: Vec2;
  /** Half extent along the deck's local X (width). */
  halfWidth: number;
  /** Half extent along the deck's local Z (length, along yaw). */
  halfLength: number;
  yaw: number;
  /** Walking surface height. */
  y: number;
}

function bridgeBetween(id: string, name: string, a: Vec2, b: Vec2, halfWidth: number): Deck {
  const center = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return {
    id,
    kind: 'bridge',
    name,
    center,
    halfWidth,
    halfLength: Math.hypot(dx, dz) / 2,
    yaw: yawFromDirection(dx, dz),
    y: Math.max(terrainHeight(a.x, a.z), terrainHeight(b.x, b.z)) + 0.12,
  };
}

export const DECKS: readonly Deck[] = [
  {
    id: 'deck_dock',
    kind: 'dock',
    name: 'The Dock',
    center: { x: 14, z: 54.5 },
    halfWidth: 1.4,
    halfLength: 8.5,
    yaw: 0,
    y: 0.95,
  },
  {
    id: 'deck_dock_end',
    kind: 'dock',
    name: 'Dock End',
    center: { x: 14, z: 62.5 },
    halfWidth: 3.6,
    halfLength: 1.6,
    yaw: 0,
    y: 0.95,
  },
  bridgeBetween('deck_mossy_bridge', 'Mossy Bridge', { x: -23.45, z: -41.6 }, { x: -24.55, z: -48.6 }, 1.25),
];

/** Returns the deck under p (with optional inset margin), or null. */
export function deckAt(pt: Vec2, margin = 0): Deck | null {
  for (const d of DECKS) {
    const dx = pt.x - d.center.x;
    const dz = pt.z - d.center.z;
    const c = Math.cos(d.yaw);
    const s = Math.sin(d.yaw);
    // inverse of rotateOffset
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) <= d.halfWidth - margin && Math.abs(lz) <= d.halfLength - margin) return d;
  }
  return null;
}
