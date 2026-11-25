/**
 * The nine named places of The Commons. Centers/radii are used for: map labels,
 * "you are entering…" toasts, proximity events, terrain flattening pads, World
 * Memory attribution (`locationId`) and the Gazette.
 */
import type { Vec2 } from '../math.js';

export type LocationId =
  | 'town_square'
  | 'cafe'
  | 'general_store'
  | 'residential'
  | 'town_hall'
  | 'workshop'
  | 'woods'
  | 'the_unknown'
  | 'waterfront';

export interface Location {
  id: LocationId;
  name: string;
  center: Vec2;
  /** Rough extent; membership test is distance <= radius. */
  radius: number;
  description: string;
  /** Flatten terrain within this location to a level pad (buildings sit on it). */
  flatten: boolean;
  /** Ambience key the audio system should crossfade to while inside. */
  ambience: AmbienceKey;
}

export type AmbienceKey = 'town' | 'cafe' | 'indoor_shop' | 'garden' | 'hall' | 'workshop' | 'forest' | 'ancient' | 'shore';

export const LOCATIONS: readonly Location[] = [
  {
    id: 'town_square',
    name: 'Town Square',
    center: { x: 0, z: 2 },
    radius: 13,
    description: 'The heart of The Commons: a stone fountain, benches, and the warm glow of streetlights.',
    flatten: true,
    ambience: 'town',
  },
  {
    id: 'cafe',
    name: 'The Café',
    center: { x: 19, z: -9 },
    radius: 9,
    description: 'A small café with a striped awning and a scatter of outdoor tables.',
    flatten: true,
    ambience: 'cafe',
  },
  {
    id: 'general_store',
    name: 'General Store',
    center: { x: -19, z: -7 },
    radius: 8,
    description: 'Shelves of everything and nothing. The public post box stands out front.',
    flatten: true,
    ambience: 'indoor_shop',
  },
  {
    id: 'residential',
    name: 'Residential District',
    center: { x: -34, z: 16 },
    radius: 16,
    description: 'A curving lane of little houses, each with a mailbox and a patch of garden.',
    flatten: true,
    ambience: 'garden',
  },
  {
    id: 'town_hall',
    name: 'Town Hall',
    center: { x: 2, z: -26 },
    radius: 11,
    description: 'A modest civic building on a rise, with a bell that anyone may ring.',
    flatten: true,
    ambience: 'hall',
  },
  {
    id: 'workshop',
    name: 'The Workshop',
    center: { x: 32, z: 13 },
    radius: 9,
    description: 'Sawdust, tools, and half-finished projects. Something is always being built here.',
    flatten: true,
    ambience: 'workshop',
  },
  {
    id: 'woods',
    name: 'The Woods',
    center: { x: -32, z: -32 },
    radius: 20,
    description: 'Winding trails under tall trees. People say things are hidden here.',
    flatten: false,
    ambience: 'forest',
  },
  {
    id: 'the_unknown',
    name: 'The Unknown',
    center: { x: -10, z: -61 },
    radius: 10,
    description: 'At the edge of the island, a ring of ancient stones surrounds a dormant arch.',
    flatten: true,
    ambience: 'ancient',
  },
  {
    id: 'waterfront',
    name: 'Waterfront',
    center: { x: 12, z: 43 },
    radius: 12,
    description: 'A sandy shore, a wooden dock reaching into the sea, and benches facing the sunset.',
    flatten: true,
    ambience: 'shore',
  },
];

const BY_ID = new Map(LOCATIONS.map((l) => [l.id, l]));

export function getLocation(id: LocationId): Location {
  const l = BY_ID.get(id);
  if (!l) throw new Error(`Unknown location ${id}`);
  return l;
}

let interiorLocator: ((p: Vec2) => LocationId | null) | null = null;
/** interiors.ts registers this: a point inside a walk-in building belongs to that building's location. */
export function setInteriorLocator(fn: (p: Vec2) => LocationId | null): void {
  interiorLocator = fn;
}

/**
 * The location containing p (the building's location when inside one; else the
 * closest center among those whose radius contains it), or null when out in-between places.
 */
export function locationAt(p: Vec2): Location | null {
  const inside = interiorLocator?.(p);
  if (inside) return BY_ID.get(inside) ?? null;
  let best: Location | null = null;
  let bestScore = Infinity;
  for (const l of LOCATIONS) {
    const d = Math.hypot(p.x - l.center.x, p.z - l.center.z);
    if (d <= l.radius) {
      const score = d / l.radius;
      if (score < bestScore) {
        bestScore = score;
        best = l;
      }
    }
  }
  return best;
}
