/**
 * Player building: the catalog (pure data) and the placement rulebook shared by
 * the server (authoritative validation) and the client (ghost preview), so the
 * two always agree.
 *
 *  - Grid: piece centres are multiples of CONFIG.building.grid (0.5 m);
 *    rotation is quarter turns (0..3). The UI snaps structural pieces to 1 m.
 *  - Levels: 0 = ground. Walls/pillars/doorways are one storey tall
 *    (CONFIG.building.storeyHeight). Floors and roofs at level L sit on top of
 *    structural pieces of level L-1; walls at L sit on walls of L-1 or on a
 *    floor at L; furniture at L >= 1 needs a floor at L. Pieces above ground
 *    may only rest on the builder's OWN pieces (nobody can build on, and so
 *    pin, someone else's house).
 *  - Overlap: pieces on the same level conflict when their footprints overlap
 *    and their layers clash (see LAYER_CLASH): a rug may lie on a floor, a
 *    table on a rug, but two walls may not cross.
 *  - Where: `buildableAt()` / `isBuildable()` — the ONE function that knows
 *    the protected zones: building footprints + door aprons (the official
 *    PROTECTED_ZONES / protectedZoneAt from world/interiors.ts, grown by
 *    PROTECTED_MARGINS.building), paths, the Town Square, a radius around
 *    every interactable (seats included) and spawn point, landmarks, decks,
 *    water and off-island.
 *  - Collision: only ground-level (level 0) solid pieces block movement; their
 *    colliders (`pieceColliders`) go into the shared dynamic collider layer
 *    (collision.ts) on both server and client. Doorways and gates are two
 *    posts with a walkable gap.
 */
import { CONFIG } from './config.js';
import { defaultCollisionWorld, penetration, type CollisionWorld } from './collision.js';
import { distanceToPolyline, rotateOffset, type Vec2 } from './math.js';
import { BUILDINGS } from './world/buildings.js';
import type { BoxCollider, Collider } from './world/colliders.js';
import { INTERACTABLES, type Seat, type SeatInteractable } from './world/interactables.js';
import { groundHeight } from './world/ground.js';
import { protectedZoneAt } from './world/interiors.js';
import { LOCATIONS, locationAt } from './world/locations.js';
import { BUSHES, ROCKS, TREES } from './world/nature.js';
import { DECKS, PATHS, deckAt } from './world/paths.js';
import { SPAWN_POINTS } from './world/spawn.js';
import { FOUNTAIN, PORTAL_ARCH, STANDING_STONES } from './world/structures.js';
import { WALKABLE_MIN_HEIGHT, WORLD_BOUNDS, isOnIsland, terrainHeight } from './world/terrain.js';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const PIECE_KINDS = [
  'floor',
  'wall',
  'wall_window',
  'doorway',
  'half_wall',
  'pillar',
  'roof_flat',
  'roof_slope',
  'roof_peak',
  'gable',
  'steps',
  'fence',
  'gate',
  'table',
  'bench',
  'chair',
  'lamp',
  'planter',
  'crate',
  'rug',
  'sign',
  // Round 2: the house-roof tool, chimney, facade name signs, furnishings.
  'house_roof',
  'chimney',
  'name_board',
  'name_hanging',
  'name_plaque',
  'bed',
  'sofa',
  'armchair',
  'stool',
  'desk',
  'dining_table',
  'bookshelf',
  'dresser',
  'kitchen_counter',
  'stove',
  'sink',
  'fireplace',
  'bathtub',
  'chest',
  'barrel',
  'floor_lamp',
  'table_lamp',
  'plant_tall',
  'plant_small',
  'wall_shelf',
  'picture',
  'wall_clock',
  'mirror',
  'curtains',
  'rug_round',
  'shop_counter',
  'record_player',
] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

/**
 * Occupancy layer. base = floor slabs/steps, surface = rugs, solid = walls and
 * furniture, roof = roof slabs, gable = triangular end walls under a roof
 * (and chimneys), mount = hung on a wall face, top = small things that stand
 * on a table / counter (or on the floor).
 */
export type PieceLayer = 'base' | 'surface' | 'solid' | 'roof' | 'gable' | 'mount' | 'top';
export type PieceCategory = 'structure' | 'roof' | 'garden' | 'living' | 'bedbath' | 'kitchen' | 'decor' | 'sign';

/** Hung on a wall face: stored at the wall's centre (x, z, level) with rot = the face's outward direction. */
export interface MountSpec {
  /** Vertical band above the wall's base (metres): two mounts on one face may not share height. */
  y0: number;
  y1: number;
  /** How far it stands out from the wall face. */
  depth: number;
  /** Only on a wall with a window (curtains). */
  windowOnly?: boolean;
}

/** A seat on a piece, in its local frame (facing = local yaw, +Z forward). */
export interface PieceSeatSpec {
  x: number;
  z: number;
  /** Seat surface above the piece's base. */
  h: number;
  /** Extra local yaw (0 = facing local +Z). */
  yaw: number;
}

export interface PieceVariant {
  id: string;
  name: string;
  /** Named colours the renderer reads (main, trim, accent…), CSS hex, warm and muted. */
  colors: Readonly<Record<string, string>>;
}

export interface PieceDef {
  kind: PieceKind;
  name: string;
  category: PieceCategory;
  /** Footprint along local X (width) and local Z (depth), metres, before rotation. */
  w: number;
  d: number;
  /** Visual height above the base (metres). */
  h: number;
  layer: PieceLayer;
  /** Blocks movement at ground level. */
  solid: boolean;
  /** Can hold floors/roofs/walls above it (one full storey tall). */
  structural: boolean;
  /** Local collision boxes (default: the whole footprint when solid). */
  colliders?: readonly { x: number; z: number; hw: number; hd: number }[];
  minLevel: number;
  maxLevel: number;
  /** UI snap step for the piece centre (server only requires CONFIG.building.grid). */
  snap: number;
  /** Carries player-written text (signs). */
  text?: boolean;
  /** Lights up at night. */
  light?: boolean;
  /** Longest text (characters) for text pieces (default CONFIG.building.signMaxLength). */
  textMax?: number;
  /** Wall-mounted (see MountSpec). */
  mount?: MountSpec;
  /** Can stand on top of a `surface` piece (table lamp, small plant). */
  top?: boolean;
  /** Offers its top (at height h) to `top` pieces. */
  surface?: boolean;
  /** Seats (sit interaction). */
  seats?: readonly PieceSeatSpec[];
  /** Parametric piece (house roof): size/style come with the piece (PieceLike.params). */
  param?: 'roof';
  /** Not offered in the palette any more (kept so existing worlds still load and render). */
  legacy?: boolean;
  variants: readonly PieceVariant[];
  /** One-line description for the palette. */
  hint: string;
}

const H = CONFIG.building.storeyHeight;
const ML = CONFIG.building.maxLevel;

const WOOD: readonly PieceVariant[] = [
  { id: 'oak', name: 'Oak', colors: { main: '#b48a63', trim: '#8a6648', accent: '#d9c3a2' } },
  { id: 'walnut', name: 'Walnut', colors: { main: '#7d5a43', trim: '#5c4233', accent: '#c9ab86' } },
  { id: 'driftwood', name: 'Driftwood', colors: { main: '#b7ab98', trim: '#8f8574', accent: '#e3dccd' } },
];
const PLASTER: readonly PieceVariant[] = [
  { id: 'cream', name: 'Cream plaster', colors: { main: '#e9dcc4', trim: '#9a7656', accent: '#c9b48e', shutter: '#6f8a7a' } },
  { id: 'rose', name: 'Rose plaster', colors: { main: '#e2c4b6', trim: '#8a6450', accent: '#c99f8c', shutter: '#5f7082' } },
  { id: 'sage', name: 'Sage plaster', colors: { main: '#c9d2bd', trim: '#6e6a52', accent: '#a9b596', shutter: '#9a6a52' } },
  { id: 'stone', name: 'Fieldstone', colors: { main: '#c8bfae', trim: '#857b6b', accent: '#a79d8b', shutter: '#5f6f6a' } },
];
const ROOF: readonly PieceVariant[] = [
  { id: 'terracotta', name: 'Terracotta', colors: { main: '#b0634a', trim: '#7e4636', accent: '#cf8a6c' } },
  { id: 'slate', name: 'Slate', colors: { main: '#66707a', trim: '#474e56', accent: '#8a939b' } },
  { id: 'moss', name: 'Moss', colors: { main: '#6f7f58', trim: '#4f5a40', accent: '#93a274' } },
  { id: 'thatch', name: 'Thatch', colors: { main: '#c4a46a', trim: '#93784a', accent: '#dcc390' } },
];
const FLOOR: readonly PieceVariant[] = [
  { id: 'planks', name: 'Planks', colors: { main: '#b08860', trim: '#8a6a4c', accent: '#c9a67e' } },
  { id: 'flagstone', name: 'Flagstone', colors: { main: '#bdb3a2', trim: '#958b7a', accent: '#d3cabb' } },
  { id: 'terracotta', name: 'Tiles', colors: { main: '#c48a6a', trim: '#9a6a52', accent: '#dcae90' } },
];
const RUG: readonly PieceVariant[] = [
  { id: 'madder', name: 'Madder red', colors: { main: '#a9564a', trim: '#e8cfa8', accent: '#6f3a34' } },
  { id: 'indigo', name: 'Indigo', colors: { main: '#55627e', trim: '#e2d6bb', accent: '#39425a' } },
  { id: 'ochre', name: 'Ochre', colors: { main: '#c79a4f', trim: '#f0e2c2', accent: '#8a6634' } },
];
const FLOWERS: readonly PieceVariant[] = [
  { id: 'rose', name: 'Roses', colors: { main: '#9a7656', trim: '#6f8f52', accent: '#e7a0a6' } },
  { id: 'marigold', name: 'Marigolds', colors: { main: '#8a6a4c', trim: '#6f8f52', accent: '#f1c46a' } },
  { id: 'lavender', name: 'Lavender', colors: { main: '#b7ab98', trim: '#7d9a63', accent: '#b9a2d8' } },
];
const IRON: readonly PieceVariant[] = [
  { id: 'iron', name: 'Black iron', colors: { main: '#4a4a4c', trim: '#2f2f31', accent: '#ffcf8a' } },
  { id: 'brass', name: 'Brass', colors: { main: '#a88550', trim: '#6e5634', accent: '#ffd59a' } },
  { id: 'green', name: 'Garden green', colors: { main: '#4e6150', trim: '#34423a', accent: '#ffcf8a' } },
];

const ROOF_HOUSE: readonly PieceVariant[] = [
  { id: 'clay', name: 'Clay tiles', colors: { main: '#b4644c', trim: '#7e4636', accent: '#cf8a6c' } },
  { id: 'slate', name: 'Slate', colors: { main: '#66707a', trim: '#474e56', accent: '#8a939b' } },
  { id: 'moss', name: 'Moss', colors: { main: '#6f7f58', trim: '#4f5a40', accent: '#93a274' } },
  { id: 'thatch', name: 'Thatch', colors: { main: '#c4a46a', trim: '#93784a', accent: '#dcc390' } },
];
const BRICK: readonly PieceVariant[] = [
  { id: 'brick', name: 'Brick', colors: { main: '#a8705a', trim: '#7e5242', accent: '#c4917a' } },
  { id: 'stone', name: 'Fieldstone', colors: { main: '#a59a89', trim: '#7d7364', accent: '#c2b8a6' } },
  { id: 'plaster', name: 'Plaster', colors: { main: '#e3d6bd', trim: '#9a7656', accent: '#c9b48e' } },
];
const BOARD: readonly PieceVariant[] = [
  { id: 'oak', name: 'Oak & cream', colors: { main: '#b48a63', trim: '#6f5038', accent: '#f1e6cf', ink: '#4a3627' } },
  { id: 'green', name: 'Garden green', colors: { main: '#5f7a66', trim: '#3f5246', accent: '#e9e0c6', ink: '#f3ead2' } },
  { id: 'navy', name: 'Harbour blue', colors: { main: '#55627e', trim: '#39425a', accent: '#e2d6bb', ink: '#f1e8d2' } },
  { id: 'red', name: 'Madder', colors: { main: '#9a5448', trim: '#6f3a34', accent: '#ecd9b8', ink: '#f6ead0' } },
];
const FABRIC: readonly PieceVariant[] = [
  { id: 'sage', name: 'Sage', colors: { main: '#8d9c7e', trim: '#7d5a43', accent: '#e6dcc6' } },
  { id: 'rose', name: 'Dusty rose', colors: { main: '#c49a8f', trim: '#6f5038', accent: '#efe2cf' } },
  { id: 'ochre', name: 'Ochre', colors: { main: '#c4a061', trim: '#5c4233', accent: '#efe4cc' } },
  { id: 'blue', name: 'Cornflower', colors: { main: '#7d8fa8', trim: '#5c4233', accent: '#e8e0cf' } },
];
const KITCHEN: readonly PieceVariant[] = [
  { id: 'cream', name: 'Cream', colors: { main: '#e6dac2', trim: '#8a6648', accent: '#b9ae9b' } },
  { id: 'sage', name: 'Sage', colors: { main: '#a7b39a', trim: '#6e6a52', accent: '#c8bfae' } },
  { id: 'blue', name: 'Duck egg', colors: { main: '#a9bcc0', trim: '#5f6f6a', accent: '#d3cabb' } },
];
const IRONWARE: readonly PieceVariant[] = [
  { id: 'iron', name: 'Black iron', colors: { main: '#4a4a4c', trim: '#2f2f31', accent: '#c87c4a' } },
  { id: 'enamel', name: 'Cream enamel', colors: { main: '#e2d6bd', trim: '#5c4233', accent: '#c87c4a' } },
  { id: 'green', name: 'Bottle green', colors: { main: '#55705e', trim: '#2f3d35', accent: '#c87c4a' } },
];
const POTS: readonly PieceVariant[] = [
  { id: 'terracotta', name: 'Terracotta pot', colors: { main: '#b8735a', trim: '#6f8f52', accent: '#8fac62' } },
  { id: 'glazed', name: 'Glazed pot', colors: { main: '#6f8a8a', trim: '#6f8f52', accent: '#a6bd74' } },
  { id: 'cream', name: 'Cream pot', colors: { main: '#e2d6bd', trim: '#5d7d4a', accent: '#8fac62' } },
];
const PICTURES: readonly PieceVariant[] = [
  { id: 'meadow', name: 'Meadow', colors: { main: '#8a6648', trim: '#a8b97f', accent: '#cfe0e6' } },
  { id: 'harbour', name: 'Harbour', colors: { main: '#5c4233', trim: '#7d93a8', accent: '#e6d6b4' } },
  { id: 'flowers', name: 'Flowers', colors: { main: '#b48a63', trim: '#e7a0a6', accent: '#efe6d2' } },
];
const BRASS_WOOD: readonly PieceVariant[] = [
  { id: 'oak', name: 'Oak', colors: { main: '#b48a63', trim: '#8a6648', accent: '#e9dcc0' } },
  { id: 'walnut', name: 'Walnut', colors: { main: '#7d5a43', trim: '#5c4233', accent: '#d9c3a2' } },
  { id: 'painted', name: 'Painted', colors: { main: '#8d9c7e', trim: '#5c4233', accent: '#efe4cc' } },
];
const RUGS2: readonly PieceVariant[] = [
  { id: 'wool', name: 'Undyed wool', colors: { main: '#d9cdb4', trim: '#9a8468', accent: '#b9a586' } },
  { id: 'indigo', name: 'Indigo', colors: { main: '#55627e', trim: '#e2d6bb', accent: '#39425a' } },
  { id: 'rose', name: 'Rose', colors: { main: '#b77e74', trim: '#efdfc6', accent: '#8a5a50' } },
];

/**
 * Posts at both ends of a 2 m span, leaving a 1.64 m walkable gap: wide enough that the
 * click-to-move nav grid (0.5 m cells, radius + 0.1 m clearance) always has a cell row through it.
 */
const POSTS_2M = [
  { x: -0.91, z: 0, hw: 0.09, hd: 0.12 },
  { x: 0.91, z: 0, hw: 0.09, hd: 0.12 },
] as const;

const def = (d: Omit<PieceDef, 'minLevel' | 'maxLevel' | 'snap'> & Partial<Pick<PieceDef, 'minLevel' | 'maxLevel' | 'snap'>>): PieceDef => ({
  minLevel: 0,
  maxLevel: ML - 1,
  snap: 1,
  ...d,
});

export const PIECES: Readonly<Record<PieceKind, PieceDef>> = {
  floor: def({ kind: 'floor', name: 'Floor', category: 'structure', w: 2, d: 2, h: 0.18, layer: 'base', solid: false, structural: false, variants: FLOOR, hint: 'A 2 m tile. Upstairs it rests on walls below.' }),
  wall: def({ kind: 'wall', name: 'Wall', category: 'structure', w: 2, d: 0.24, h: H, layer: 'solid', solid: true, structural: true, variants: PLASTER, hint: 'One storey, 2 m long.' }),
  wall_window: def({ kind: 'wall_window', name: 'Window', category: 'structure', w: 2, d: 0.24, h: H, layer: 'solid', solid: true, structural: true, variants: PLASTER, hint: 'A wall with a window that glows at night.' }),
  doorway: def({ kind: 'doorway', name: 'Doorway', category: 'structure', w: 2, d: 0.24, h: H, layer: 'solid', solid: true, structural: true, colliders: POSTS_2M, variants: PLASTER, hint: 'A wall you can walk through.' }),
  half_wall: def({ kind: 'half_wall', name: 'Half wall', category: 'structure', w: 2, d: 0.24, h: 1.05, layer: 'solid', solid: true, structural: false, variants: PLASTER, hint: 'Waist-high; good for porches.' }),
  pillar: def({ kind: 'pillar', name: 'Pillar', category: 'structure', w: 0.4, d: 0.4, h: H, layer: 'solid', solid: true, structural: true, variants: WOOD, hint: 'Holds up a roof or a floor.' }),
  roof_flat: def({ kind: 'roof_flat', name: 'Flat roof tile', category: 'roof', w: 2, d: 2, h: 0.3, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'Sits on top of walls.' }),
  roof_slope: def({ kind: 'roof_slope', legacy: true, name: 'Roof slope tile', category: 'roof', w: 2, d: 2, h: 1.25, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'Two facing each other make a gable roof.' }),
  roof_peak: def({ kind: 'roof_peak', legacy: true, name: 'Peaked roof tile', category: 'roof', w: 2, d: 2, h: 1.0, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'A small pitched roof with closed ends.' }),
  gable: def({ kind: 'gable', legacy: true, name: 'Gable', category: 'roof', w: 2, d: 0.24, h: 1.25, layer: 'gable', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: PLASTER, hint: 'Closes the end under a roof slope.' }),
  steps: def({ kind: 'steps', name: 'Steps', category: 'structure', w: 2, d: 1, h: 0.36, layer: 'base', solid: false, structural: false, maxLevel: 0, variants: FLOOR, hint: 'A low stone step up to a door.' }),
  fence: def({ kind: 'fence', name: 'Fence', category: 'garden', w: 2, d: 0.16, h: 0.95, layer: 'solid', solid: true, structural: false, maxLevel: 0, variants: WOOD, hint: 'A picket fence, 2 m.' }),
  gate: def({ kind: 'gate', name: 'Gate', category: 'garden', w: 2, d: 0.16, h: 0.95, layer: 'solid', solid: true, structural: false, maxLevel: 0, colliders: POSTS_2M, variants: WOOD, hint: 'An open garden gate.' }),
  table: def({ kind: 'table', name: 'Table', category: 'kitchen', surface: true, w: 1.4, d: 0.9, h: 0.78, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A sturdy farmhouse table.' }),
  bench: def({ kind: 'bench', name: 'Bench', category: 'garden', seats: [{ x: -0.4, z: 0.04, h: 0.48, yaw: 0 }, { x: 0.4, z: 0.04, h: 0.48, yaw: 0 }], w: 1.6, d: 0.5, h: 0.85, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A garden bench.' }),
  chair: def({ kind: 'chair', name: 'Chair', category: 'kitchen', seats: [{ x: 0, z: 0.04, h: 0.5, yaw: 0 }], w: 0.6, d: 0.6, h: 0.95, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A ladder-back chair.' }),
  lamp: def({ kind: 'lamp', name: 'Lamp', category: 'garden', w: 0.4, d: 0.4, h: 2.1, layer: 'solid', solid: true, structural: false, snap: 0.5, light: true, variants: IRON, hint: 'Lights itself at dusk.' }),
  planter: def({ kind: 'planter', name: 'Planter', category: 'garden', w: 1, d: 0.5, h: 0.75, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: FLOWERS, hint: 'A box of flowers.' }),
  crate: def({ kind: 'crate', name: 'Crate', category: 'garden', surface: true, w: 0.8, d: 0.8, h: 0.72, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'For keeping things in.' }),
  rug: def({ kind: 'rug', name: 'Rug', category: 'living', w: 2, d: 1.4, h: 0.03, layer: 'surface', solid: false, structural: false, snap: 0.5, variants: RUG, hint: 'Woven, soft underfoot.' }),
  sign: def({ kind: 'sign', name: 'Signpost', category: 'sign', w: 0.8, d: 0.3, h: 1.35, layer: 'solid', solid: true, structural: false, snap: 0.5, text: true, maxLevel: 0, variants: WOOD, hint: 'A little signpost with your words.' }),
  // --- Round 2 -----------------------------------------------------------------
  house_roof: def({ kind: 'house_roof', name: 'House roof', category: 'roof', w: 4, d: 4, h: 1.6, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, snap: 0.5, param: 'roof', variants: ROOF_HOUSE, hint: 'One whole roof over your walls. Rotate turns the ridge.' }),
  chimney: def({ kind: 'chimney', name: 'Chimney', category: 'roof', w: 0.7, d: 0.7, h: 2.6, layer: 'gable', solid: false, structural: false, minLevel: 1, maxLevel: ML, snap: 0.5, variants: BRICK, hint: 'Stands on a wall top and rises through the roof.' }),
  name_board: def({ kind: 'name_board', name: 'Name board', category: 'sign', w: 1.76, d: 0.08, h: 0.5, layer: 'mount', solid: false, structural: false, snap: 1, text: true, textMax: 24, light: true, mount: { y0: 2.1, y1: 2.58, depth: 0.08 }, variants: BOARD, hint: 'Your building’s name, above the door.' }),
  name_hanging: def({ kind: 'name_hanging', name: 'Hanging sign', category: 'sign', w: 0.9, d: 0.75, h: 0.9, layer: 'mount', solid: false, structural: false, snap: 1, text: true, textMax: 18, light: true, mount: { y0: 1.62, y1: 2.5, depth: 0.75 }, variants: BOARD, hint: 'A sign on an iron bracket.' }),
  name_plaque: def({ kind: 'name_plaque', name: 'Plaque', category: 'sign', w: 0.62, d: 0.05, h: 0.34, layer: 'mount', solid: false, structural: false, snap: 1, text: true, textMax: 18, light: true, mount: { y0: 1.45, y1: 1.8, depth: 0.05 }, variants: BOARD, hint: 'A small plaque by the door.' }),
  bed: def({ kind: 'bed', name: 'Bed', category: 'bedbath', w: 1.3, d: 2.1, h: 1.0, layer: 'solid', solid: true, structural: false, snap: 0.5, seats: [{ x: -0.5, z: 0.5, h: 0.5, yaw: -Math.PI / 2 }, { x: 0.5, z: 0.5, h: 0.5, yaw: Math.PI / 2 }], variants: FABRIC, hint: 'A quilted bed. Sit on its edge.' }),
  sofa: def({ kind: 'sofa', name: 'Sofa', category: 'living', w: 1.8, d: 0.85, h: 0.85, layer: 'solid', solid: true, structural: false, snap: 0.5, seats: [{ x: -0.42, z: 0.05, h: 0.44, yaw: 0 }, { x: 0.42, z: 0.05, h: 0.44, yaw: 0 }], variants: FABRIC, hint: 'Two seats, soft cushions.' }),
  armchair: def({ kind: 'armchair', name: 'Armchair', category: 'living', w: 0.9, d: 0.85, h: 0.9, layer: 'solid', solid: true, structural: false, snap: 0.5, seats: [{ x: 0, z: 0.05, h: 0.44, yaw: 0 }], variants: FABRIC, hint: 'A deep armchair.' }),
  stool: def({ kind: 'stool', name: 'Stool', category: 'kitchen', w: 0.45, d: 0.45, h: 0.62, layer: 'solid', solid: true, structural: false, snap: 0.5, seats: [{ x: 0, z: 0, h: 0.62, yaw: 0 }], variants: WOOD, hint: 'For counters and corners.' }),
  desk: def({ kind: 'desk', name: 'Desk', category: 'living', w: 1.3, d: 0.65, h: 0.76, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: WOOD, hint: 'A writing desk with a drawer.' }),
  dining_table: def({ kind: 'dining_table', name: 'Dining table', category: 'kitchen', w: 1.8, d: 1.0, h: 0.76, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: WOOD, hint: 'Long enough for friends.' }),
  bookshelf: def({ kind: 'bookshelf', name: 'Bookshelf', category: 'living', w: 1.2, d: 0.4, h: 1.9, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'Full of well-read books.' }),
  dresser: def({ kind: 'dresser', name: 'Dresser', category: 'bedbath', w: 1.1, d: 0.5, h: 0.95, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: BRASS_WOOD, hint: 'Drawers; things can stand on top.' }),
  kitchen_counter: def({ kind: 'kitchen_counter', name: 'Counter', category: 'kitchen', w: 1.2, d: 0.65, h: 0.92, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: KITCHEN, hint: 'A kitchen counter with cupboards.' }),
  stove: def({ kind: 'stove', name: 'Stove', category: 'kitchen', w: 0.8, d: 0.65, h: 0.95, layer: 'solid', solid: true, structural: false, snap: 0.5, light: true, variants: IRONWARE, hint: 'A wood stove; it glows in the evening.' }),
  sink: def({ kind: 'sink', name: 'Sink', category: 'kitchen', w: 0.9, d: 0.6, h: 0.92, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: KITCHEN, hint: 'A deep stone sink.' }),
  fireplace: def({ kind: 'fireplace', name: 'Fireplace', category: 'living', w: 1.4, d: 0.6, h: 1.45, layer: 'solid', solid: true, structural: false, snap: 0.5, light: true, variants: BRICK, hint: 'A hearth that glows from dusk.' }),
  bathtub: def({ kind: 'bathtub', name: 'Bathtub', category: 'bedbath', w: 1.7, d: 0.8, h: 0.62, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: IRONWARE, hint: 'A roll-top tub on little feet.' }),
  chest: def({ kind: 'chest', name: 'Chest', category: 'bedbath', w: 0.9, d: 0.55, h: 0.58, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: WOOD, hint: 'A blanket chest.' }),
  barrel: def({ kind: 'barrel', name: 'Barrel', category: 'garden', w: 0.62, d: 0.62, h: 0.9, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: WOOD, hint: 'A stout barrel.' }),
  floor_lamp: def({ kind: 'floor_lamp', name: 'Floor lamp', category: 'living', w: 0.42, d: 0.42, h: 1.6, layer: 'solid', solid: true, structural: false, snap: 0.5, light: true, variants: FABRIC, hint: 'A standing lamp, lit at dusk.' }),
  table_lamp: def({ kind: 'table_lamp', name: 'Table lamp', category: 'living', w: 0.32, d: 0.32, h: 0.46, layer: 'top', solid: false, structural: false, snap: 0.5, top: true, light: true, variants: FABRIC, hint: 'Stands on a table, desk or counter.' }),
  plant_tall: def({ kind: 'plant_tall', name: 'Tall plant', category: 'decor', w: 0.6, d: 0.6, h: 1.35, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: POTS, hint: 'A leafy plant in a big pot.' }),
  plant_small: def({ kind: 'plant_small', name: 'Small plant', category: 'decor', w: 0.34, d: 0.34, h: 0.45, layer: 'top', solid: false, structural: false, snap: 0.5, top: true, variants: POTS, hint: 'A pot for a table or a sill.' }),
  wall_shelf: def({ kind: 'wall_shelf', name: 'Wall shelf', category: 'decor', w: 1.0, d: 0.24, h: 0.4, layer: 'mount', solid: false, structural: false, snap: 1, mount: { y0: 1.05, y1: 1.45, depth: 0.24 }, variants: WOOD, hint: 'A shelf with jars and books.' }),
  picture: def({ kind: 'picture', name: 'Picture', category: 'decor', w: 0.8, d: 0.05, h: 0.6, layer: 'mount', solid: false, structural: false, snap: 1, mount: { y0: 1.5, y1: 2.1, depth: 0.05 }, variants: PICTURES, hint: 'A framed painting.' }),
  wall_clock: def({ kind: 'wall_clock', name: 'Wall clock', category: 'decor', w: 0.44, d: 0.07, h: 0.44, layer: 'mount', solid: false, structural: false, snap: 1, mount: { y0: 2.12, y1: 2.56, depth: 0.07 }, variants: BRASS_WOOD, hint: 'Keeps the island’s time.' }),
  mirror: def({ kind: 'mirror', name: 'Mirror', category: 'decor', w: 0.6, d: 0.05, h: 1.0, layer: 'mount', solid: false, structural: false, snap: 1, mount: { y0: 0.9, y1: 1.9, depth: 0.05 }, variants: BRASS_WOOD, hint: 'A tall mirror.' }),
  curtains: def({ kind: 'curtains', name: 'Curtains', category: 'decor', w: 1.3, d: 0.08, h: 1.3, layer: 'mount', solid: false, structural: false, snap: 1, mount: { y0: 0.85, y1: 2.15, depth: 0.08, windowOnly: true }, variants: FABRIC, hint: 'For a wall with a window.' }),
  rug_round: def({ kind: 'rug_round', name: 'Round rug', category: 'living', w: 1.6, d: 1.6, h: 0.03, layer: 'surface', solid: false, structural: false, snap: 0.5, variants: RUGS2, hint: 'A braided round rug.' }),
  shop_counter: def({ kind: 'shop_counter', name: 'Shop counter', category: 'kitchen', w: 1.6, d: 0.6, h: 1.0, layer: 'solid', solid: true, structural: false, snap: 0.5, surface: true, variants: WOOD, hint: 'A counter with shelves behind.' }),
  record_player: def({ kind: 'record_player', name: 'Record player', category: 'living', w: 0.42, d: 0.36, h: 0.3, layer: 'top', solid: false, structural: false, snap: 0.5, top: true, variants: BRASS_WOOD, hint: 'Stands on a table or a chest.' }),
};

export const PIECE_CATEGORIES: readonly { id: PieceCategory; name: string }[] = [
  { id: 'structure', name: 'Build' },
  { id: 'roof', name: 'Roofs' },
  { id: 'sign', name: 'Signs' },
  { id: 'living', name: 'Living' },
  { id: 'kitchen', name: 'Kitchen' },
  { id: 'bedbath', name: 'Bed & bath' },
  { id: 'decor', name: 'Walls & decor' },
  { id: 'garden', name: 'Garden' },
];

/** Palette order inside each tab (the house roof first in Roofs; legacy roof tiles after it). */
export const PALETTE_ORDER: readonly PieceKind[] = (() => {
  const first: PieceKind[] = ['house_roof', 'chimney'];
  const rest = PIECE_KINDS.filter((k) => !first.includes(k));
  return [...first, ...rest];
})();

export function isPieceKind(v: unknown): v is PieceKind {
  return typeof v === 'string' && (PIECE_KINDS as readonly string[]).includes(v);
}
export function pieceDef(kind: PieceKind): PieceDef {
  return PIECES[kind];
}
export function variantIndex(kind: PieceKind, variant: string): number {
  return PIECES[kind].variants.findIndex((v) => v.id === variant);
}

// ---------------------------------------------------------------------------
// Piece geometry (axis-aligned: rotations are quarter turns)
// ---------------------------------------------------------------------------

/** The minimal description of a piece needed by the rules. */
export interface PieceLike {
  id: string;
  kind: PieceKind;
  x: number;
  z: number;
  rot: number;
  level: number;
  y: number;
  ownerId: string;
  /** Parametric pieces only (house roof): compact JSON, see RoofParams. */
  params?: string;
}

/** Axis-aligned footprint rectangle. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function yawOfRot(rot: number): number {
  return (((rot % 4) + 4) % 4) * (Math.PI / 2);
}

/** World-space footprint of a piece kind at (x, z, rot). */
export function footprint(kind: PieceKind, x: number, z: number, rot: number): Rect {
  const d = PIECES[kind];
  const odd = (((rot % 4) + 4) % 4) % 2 === 1;
  const hw = (odd ? d.d : d.w) / 2;
  const hd = (odd ? d.w : d.d) / 2;
  return { minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd };
}

// ---------------------------------------------------------------------------
// House roofs (parametric) and wall mounts
// ---------------------------------------------------------------------------

export type RoofStyle = 'gable' | 'hip';
/**
 * One whole roof over a rectangle of walls. In the piece's local frame the
 * ridge runs along local Z: `w` = span across the ridge (local X), `d` =
 * length along it (local Z), both measured between wall centre lines. rot 0 →
 * ridge along world Z, rot 1 → ridge along world X ("Rotate turns the ridge").
 */
export interface RoofParams {
  w: number;
  d: number;
  style: RoofStyle;
  /** 0 = gentle (≈ 32°), 1 = steep (≈ 42°). */
  pitch: 0 | 1;
}
export const ROOF_STYLES: readonly RoofStyle[] = ['gable', 'hip'];
/** Eave overhang beyond the wall lines on every side (metres). */
export const ROOF_OVERHANG = 0.45;
/** Rise per metre of half-span for each pitch. */
export const ROOF_PITCH_SLOPE = [0.62, 0.9] as const;

export function roofRise(r: RoofParams): number {
  return (r.w / 2) * ROOF_PITCH_SLOPE[r.pitch];
}

/** Parse/validate roof params (object from a request, or the stored JSON string). Null when invalid. */
export function parseRoofParams(v: unknown): RoofParams | null {
  let o: unknown = v;
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const { minSpan, maxSpan } = CONFIG.building.roof;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= minSpan && n <= maxSpan;
  if (!ok(r.w) || !ok(r.d)) return null;
  const style = r.style ?? r.s;
  if (style !== 'gable' && style !== 'hip') return null;
  const pitch = r.pitch ?? r.p;
  if (pitch !== 0 && pitch !== 1) return null;
  return { w: r.w, d: r.d, style, pitch };
}
export function roofParamsString(r: RoofParams): string {
  return JSON.stringify({ w: r.w, d: r.d, s: r.style, p: r.pitch });
}

/** Local frame size (w × d) of a piece: params for parametric pieces, else the catalog's. */
export function pieceSize(kind: PieceKind, params?: string | RoofParams | null): { w: number; d: number } {
  const def = PIECES[kind];
  if (def.param === 'roof') {
    const r = typeof params === 'string' || params == null ? parseRoofParams(params) : params;
    if (r) return { w: r.w, d: r.d };
  }
  return { w: def.w, d: def.d };
}

/** Kinds a mount can hang on, and whether that wall has a door / window opening. */
const MOUNT_WALLS: Partial<Record<PieceKind, 'plain' | 'window' | 'door'>> = { wall: 'plain', wall_window: 'window', doorway: 'door' };
/** Half the thickness of a wall (mounts start at the face). */
export const WALL_HALF = 0.12;

/** World centre of what a mount occupies (it hangs off the face of the wall at x, z). */
export function mountCentre(kind: PieceKind, x: number, z: number, rot: number): Vec2 {
  const m = PIECES[kind].mount!;
  const yaw = yawOfRot(rot);
  const off = WALL_HALF + m.depth / 2;
  return { x: x + Math.sin(yaw) * off, z: z + Math.cos(yaw) * off };
}

/** Footprint of any placed piece (parametric size, wall mounts off the wall face). */
export function footprintOf(p: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot'> & { params?: string | undefined }): Rect {
  const def = PIECES[p.kind];
  const { w, d } = pieceSize(p.kind, p.params);
  const odd = (((p.rot % 4) + 4) % 4) % 2 === 1;
  const hw = (odd ? d : w) / 2;
  const hd = (odd ? w : d) / 2;
  const c = def.mount ? mountCentre(p.kind, p.x, p.z, p.rot) : { x: p.x, z: p.z };
  return { minX: c.x - hw, maxX: c.x + hw, minZ: c.z - hd, maxZ: c.z + hd };
}

/**
 * Wall-mount rule: the wall a mount hangs on — one of the builder's walls at
 * the same level whose centre is (x, z) and which runs across `rot` (the
 * mount faces out of it). Doorways only take mounts above the door, window
 * walls only curtains or mounts above the window.
 */
export function mountWall<P extends PieceLike>(index: PieceIndex<P>, kind: PieceKind, x: number, z: number, rot: number, level: number): { wall: P | null; reason?: 'unsupported' | 'mount_blocked' } {
  const m = PIECES[kind].mount;
  if (!m) return { wall: null, reason: 'unsupported' };
  for (const q of index.query({ minX: x - 0.05, maxX: x + 0.05, minZ: z - 0.05, maxZ: z + 0.05 })) {
    const type = MOUNT_WALLS[q.kind];
    if (!type || q.level !== level || Math.abs(q.x - x) > 1e-6 || Math.abs(q.z - z) > 1e-6 || q.rot % 2 !== rot % 2) continue;
    if (m.windowOnly && type !== 'window') return { wall: null, reason: 'mount_blocked' };
    if (!m.windowOnly && type === 'window' && m.y0 < 1.97) return { wall: null, reason: 'mount_blocked' };
    if (type === 'door' && m.y0 < 2.1) return { wall: null, reason: 'mount_blocked' };
    return { wall: q };
  }
  return { wall: null, reason: 'unsupported' };
}

/** World pose of seat `i` of a piece (null when it has none). */
export function pieceSeat(p: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot' | 'y'>, i: number): { position: Vec2; y: number; yaw: number; exit: Vec2 } | null {
  const s = PIECES[p.kind].seats?.[i];
  if (!s) return null;
  const yaw = yawOfRot(p.rot);
  const o = rotateOffset({ x: s.x, z: s.z }, yaw);
  const facing = yaw + s.yaw;
  const out = rotateOffset({ x: s.x, z: s.z + 0.8 }, yaw);
  const sideways = Math.abs(s.yaw) > 0.1 ? rotateOffset({ x: s.x + Math.sign(s.x || 1) * 0.85, z: s.z }, yaw) : out;
  return { position: { x: p.x + o.x, z: p.z + o.z }, y: p.y + s.h, yaw: facing, exit: { x: p.x + sideways.x, z: p.z + sideways.z } };
}

function rectsOverlap(a: Rect, b: Rect, shrink = 0.02): boolean {
  return a.minX + shrink < b.maxX && b.minX + shrink < a.maxX && a.minZ + shrink < b.maxZ && b.minZ + shrink < a.maxZ;
}
function expand(r: Rect, m: number): Rect {
  return { minX: r.minX - m, maxX: r.maxX + m, minZ: r.minZ - m, maxZ: r.maxZ + m };
}
function rectContains(r: Rect, p: Vec2, inset = 0): boolean {
  return p.x >= r.minX + inset && p.x <= r.maxX - inset && p.z >= r.minZ + inset && p.z <= r.maxZ - inset;
}

/** Top of a structural piece (where floors/roofs/walls above rest). */
export function pieceTop(p: PieceLike): number {
  const d = PIECES[p.kind];
  return d.structural ? p.y + CONFIG.building.storeyHeight : p.kind === 'floor' ? p.y + (p.level === 0 ? d.h : 0) : p.y + d.h;
}

/** Collision shapes for a piece (empty unless it is a solid piece on the ground). */
export function pieceColliders(p: PieceLike): BoxCollider[] {
  const d = PIECES[p.kind];
  if (!d.solid || p.level !== 0) return [];
  const yaw = yawOfRot(p.rot);
  const boxes = d.colliders ?? [{ x: 0, z: 0, hw: d.w / 2, hd: d.d / 2 }];
  return boxes.map((b, i) => {
    const o = rotateOffset({ x: b.x, z: b.z }, yaw);
    return { id: `bp_${p.id}_${i}`, shape: 'box', source: 'structure', x: p.x + o.x, z: p.z + o.z, halfWidth: b.hw, halfDepth: b.hd, yaw };
  });
}

// ---------------------------------------------------------------------------
// Spatial index of placed pieces (server + client)
// ---------------------------------------------------------------------------

const ICELL = 4;
const ikey = (cx: number, cz: number) => `${cx},${cz}`;

export class PieceIndex<P extends PieceLike = PieceLike> {
  private byId = new Map<string, P>();
  private cells = new Map<string, Set<P>>();
  private perOwner = new Map<string, number>();

  get size(): number {
    return this.byId.size;
  }
  get(id: string): P | undefined {
    return this.byId.get(id);
  }
  all(): IterableIterator<P> {
    return this.byId.values();
  }
  countFor(ownerId: string): number {
    return this.perOwner.get(ownerId) ?? 0;
  }
  ownedBy(ownerId: string): P[] {
    return [...this.byId.values()].filter((p) => p.ownerId === ownerId);
  }

  private cellRange(r: Rect, f: (k: string) => void): void {
    const x0 = Math.floor(r.minX / ICELL);
    const x1 = Math.floor(r.maxX / ICELL);
    const z0 = Math.floor(r.minZ / ICELL);
    const z1 = Math.floor(r.maxZ / ICELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) f(ikey(x, z));
  }

  add(p: P): void {
    if (this.byId.has(p.id)) this.remove(p.id);
    this.byId.set(p.id, p);
    this.perOwner.set(p.ownerId, (this.perOwner.get(p.ownerId) ?? 0) + 1);
    this.cellRange(footprintOf(p), (k) => {
      let s = this.cells.get(k);
      if (!s) this.cells.set(k, (s = new Set()));
      s.add(p);
    });
  }

  remove(id: string): P | undefined {
    const p = this.byId.get(id);
    if (!p) return undefined;
    this.byId.delete(id);
    const n = (this.perOwner.get(p.ownerId) ?? 1) - 1;
    if (n <= 0) this.perOwner.delete(p.ownerId);
    else this.perOwner.set(p.ownerId, n);
    this.cellRange(footprintOf(p), (k) => {
      const s = this.cells.get(k);
      if (!s) return;
      s.delete(p);
      if (!s.size) this.cells.delete(k);
    });
    return p;
  }

  clear(): void {
    this.byId.clear();
    this.cells.clear();
    this.perOwner.clear();
  }

  /** Pieces whose footprint overlaps r (expanded by `margin`). */
  query(r: Rect, margin = 0): P[] {
    const q = margin ? expand(r, margin) : r;
    const seen = new Set<P>();
    this.cellRange(q, (k) => {
      const s = this.cells.get(k);
      if (s) for (const p of s) seen.add(p);
    });
    const out: P[] = [];
    for (const p of seen) if (rectsOverlap(footprintOf(p), q, 0)) out.push(p);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Protected zones — THE place to switch to an official footprint/apron export.
// ---------------------------------------------------------------------------

export type BuildableCode = 'ok' | 'out_of_bounds' | 'water' | 'protected';
export interface BuildableResult {
  code: BuildableCode;
  /** What protects it ("the Town Square", "the path", "the Café doorway"…). */
  label?: string;
}

interface CircleZone {
  x: number;
  z: number;
  r: number;
  label: string;
}
interface BoxZone {
  x: number;
  z: number;
  hw: number;
  hd: number;
  yaw: number;
  label: string;
}
interface Zones {
  circles: CircleZone[];
  boxes: BoxZone[];
  paths: { points: readonly Vec2[]; half: number; label: string }[];
}

/** Clearances (metres) around protected things. */
export const PROTECTED_MARGINS = {
  /** Around every building footprint and door apron (PROTECTED_ZONES from world/interiors.ts). */
  building: 1.0,
  path: 0.7,
  interactable: 2.2,
  spawn: 3,
  landmark: 2.5,
  deck: 1,
} as const;

let zones: Zones | null = null;
const buildingName = new Map(BUILDINGS.map((b) => [b.id, b.name]));
/**
 * Protected zones other than buildings: decks, the Town Square, The Unknown,
 * every interactable (incl. seats, signs, mailboxes), spawn points,
 * landmarks and paths. Buildings + door aprons come from the official
 * `protectedZoneAt` export (world/interiors.ts) in `buildableAt`.
 */
function protectedZones(): Zones {
  if (zones) return zones;
  const M = PROTECTED_MARGINS;
  const circles: CircleZone[] = [];
  const boxes: BoxZone[] = [];
  for (const d of DECKS) boxes.push({ x: d.center.x, z: d.center.z, hw: d.halfWidth + M.deck, hd: d.halfLength + M.deck, yaw: d.yaw, label: d.name });
  const square = LOCATIONS.find((l) => l.id === 'town_square');
  if (square) circles.push({ x: square.center.x, z: square.center.z, r: square.radius, label: square.name });
  const unknown = LOCATIONS.find((l) => l.id === 'the_unknown');
  if (unknown) circles.push({ x: unknown.center.x, z: unknown.center.z, r: unknown.radius * 0.9, label: unknown.name });
  for (const i of INTERACTABLES) circles.push({ x: i.position.x, z: i.position.z, r: M.interactable, label: i.name });
  for (const s of SPAWN_POINTS) circles.push({ x: s.position.x, z: s.position.z, r: M.spawn, label: 'a spawn point' });
  circles.push({ x: FOUNTAIN.position.x, z: FOUNTAIN.position.z, r: FOUNTAIN.basinRadius + M.landmark, label: 'the fountain' });
  circles.push({ x: PORTAL_ARCH.position.x, z: PORTAL_ARCH.position.z, r: PORTAL_ARCH.span + M.landmark, label: 'the arch' });
  for (const s of STANDING_STONES) circles.push({ x: s.position.x, z: s.position.z, r: s.radius + M.landmark, label: 'the standing stones' });
  const paths = PATHS.map((p) => ({ points: p.points, half: p.width / 2 + M.path, label: p.name ? p.name : 'the path' }));
  zones = { circles, boxes, paths };
  return zones;
}

/**
 * Can something be built at this ground point? The one protected-zone
 * predicate used by both server validation and the client preview.
 */
export function buildableAt(p: Vec2): BuildableResult {
  if (p.x < WORLD_BOUNDS.minX || p.x > WORLD_BOUNDS.maxX || p.z < WORLD_BOUNDS.minZ || p.z > WORLD_BOUNDS.maxZ || !isOnIsland(p.x, p.z, 0.5)) return { code: 'out_of_bounds' };
  if (deckAt(p)) return { code: 'protected', label: 'the dock' };
  if (terrainHeight(p.x, p.z) <= WALKABLE_MIN_HEIGHT + 0.08) return { code: 'water' };
  const pz = protectedZoneAt(p, PROTECTED_MARGINS.building);
  if (pz) {
    // Mid-sentence ("Too close to …"): "The Café" → "the Café", and never "the The Café doorway".
    const raw = buildingName.get(pz.buildingId) ?? 'a building';
    const name = raw.startsWith('The ') ? `the ${raw.slice(4)}` : raw;
    return { code: 'protected', label: pz.kind === 'door_apron' ? `${name.startsWith('the ') ? '' : 'the '}${name} doorway` : name };
  }
  const z = protectedZones();
  for (const c of z.circles) {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) return { code: 'protected', label: c.label };
  }
  for (const b of z.boxes) {
    const cs = Math.cos(b.yaw);
    const sn = Math.sin(b.yaw);
    const wx = p.x - b.x;
    const wz = p.z - b.z;
    const lx = wx * cs - wz * sn;
    const lz = wx * sn + wz * cs;
    if (Math.abs(lx) < b.hw && Math.abs(lz) < b.hd) return { code: 'protected', label: b.label };
  }
  for (const path of z.paths) if (distanceToPolyline(p, path.points) < path.half) return { code: 'protected', label: path.label };
  return { code: 'ok' };
}

export function isBuildable(p: Vec2): boolean {
  return buildableAt(p).code === 'ok';
}

/** Sample points across a footprint (corners, edges, centre, ~0.5 m spacing). */
export function footprintSamples(r: Rect, step = 0.5): Vec2[] {
  const out: Vec2[] = [];
  const nx = Math.max(1, Math.ceil((r.maxX - r.minX) / step));
  const nz = Math.max(1, Math.ceil((r.maxZ - r.minZ) / step));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) out.push({ x: r.minX + ((r.maxX - r.minX) * i) / nx, z: r.minZ + ((r.maxZ - r.minZ) * j) / nz });
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type BuildRefusal =
  | 'disabled'
  | 'unknown_piece'
  | 'bad_variant'
  | 'off_grid'
  | 'bad_rotation'
  | 'bad_level'
  | 'out_of_bounds'
  | 'water'
  | 'protected'
  | 'too_steep'
  | 'obstructed'
  | 'overlap'
  | 'unsupported'
  | 'not_your_support'
  | 'player_in_way'
  | 'too_far'
  | 'rate_limited'
  | 'player_cap'
  | 'world_cap'
  | 'banned'
  | 'blocked'
  | 'text_required'
  | 'text_too_long'
  | 'muted'
  | 'not_found'
  | 'not_owner'
  | 'supports_others'
  // Round 2
  | 'bad_params'
  | 'nature'
  | 'not_clearable'
  | 'already_cleared'
  | 'clear_cap'
  | 'mount_blocked'
  | 'not_a_seat'
  | 'occupied'
  | 'not_text';

/** Short human text for a refusal (the client shows it next to the ghost). */
export function refusalText(reason: BuildRefusal, label?: string): string {
  switch (reason) {
    case 'disabled':
      return 'Building is switched off on this island';
    case 'unknown_piece':
      return 'Unknown piece';
    case 'bad_variant':
      return 'Unknown style for that piece';
    case 'off_grid':
      return 'Not on the build grid';
    case 'bad_rotation':
      return 'Pieces turn in quarter turns';
    case 'bad_level':
      return 'That piece cannot go at this height';
    case 'out_of_bounds':
      return 'Too close to the edge of the island';
    case 'water':
      return 'Can’t build on water';
    case 'protected':
      return label ? `Too close to ${label}` : 'This spot is protected';
    case 'too_steep':
      return 'The ground is too steep here';
    case 'obstructed':
      return 'Something is in the way';
    case 'overlap':
      return 'Overlaps another piece';
    case 'unsupported':
      return label ?? 'Needs something underneath';
    case 'not_your_support':
      return 'You can only build on top of your own pieces';
    case 'player_in_way':
      return 'Someone is standing there';
    case 'too_far':
      return 'Too far away — walk closer';
    case 'rate_limited':
      return 'Slow down a little';
    case 'player_cap':
      return 'You’ve placed as many pieces as you can';
    case 'world_cap':
      return 'The island can’t hold any more pieces';
    case 'banned':
      return 'You can’t build right now';
    case 'blocked':
      return 'Too close to the build of someone you blocked (or who blocked you)';
    case 'text_required':
      return 'Write something for the sign';
    case 'text_too_long':
      return `Signs hold up to ${label ?? CONFIG.building.signMaxLength} characters`;
    case 'muted':
      return 'You can’t write signs while muted';
    case 'not_found':
      return 'That piece is already gone';
    case 'not_owner':
      return 'You can only remove your own pieces';
    case 'supports_others':
      return 'Remove what rests on it first';
    case 'bad_params':
      return `Roofs span ${CONFIG.building.roof.minSpan}–${CONFIG.building.roof.maxSpan} m between walls`;
    case 'nature':
      return label === 'a rock' ? 'A small rock is in the way — clear it first' : 'A bush is in the way — clear it first';
    case 'not_clearable':
      return label ? `${label.charAt(0).toUpperCase()}${label.slice(1)} can’t be cleared` : 'That can’t be cleared';
    case 'already_cleared':
      return 'Already cleared';
    case 'clear_cap':
      return 'You’ve cleared enough plants for today';
    case 'mount_blocked':
      return 'Not on that wall — try a plain wall';
    case 'not_a_seat':
      return 'You can’t sit on that';
    case 'occupied':
      return 'Someone is sitting there';
    case 'not_text':
      return 'That piece has no words';
  }
}

export interface PlaceRequest {
  kind: unknown;
  variant: unknown;
  /** House roof: { w, d, style, pitch } (see RoofParams). */
  params?: unknown;
  x: unknown;
  z: unknown;
  rot: unknown;
  level: unknown;
}

export interface PlacementContext<P extends PieceLike = PieceLike> {
  index: PieceIndex<P>;
  builderId: string;
  /** Builder's position (null = skip the range check, e.g. tests of pure geometry). */
  builderPos: Vec2 | null;
  range?: number;
  /** Positions of every player in the world (overlap refusal). */
  players: readonly Vec2[];
  /** Static world colliders (defaults to the island's). */
  collision?: CollisionWorld;
  /** Bushes / rocks already cleared (they no longer block). */
  cleared?: ReadonlySet<string>;
}

export type PlacementResult =
  | { ok: true; kind: PieceKind; variant: string; x: number; z: number; rot: number; level: number; y: number; params?: string }
  | { ok: false; reason: BuildRefusal; label?: string; natureId?: string };

/** Walls, fences, gables and pillars (thin in one direction). */
const isSlim = (k: PieceKind) => Math.min(PIECES[k].w, PIECES[k].d) <= 0.4;
/** How far two slim pieces may overlap at a joint (corner / T). */
const SLIM_JOINT = 0.21;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const onGrid = (v: number) => Math.abs(v / CONFIG.building.grid - Math.round(v / CONFIG.building.grid)) < 1e-6;

/** Which layers may not overlap on the same level. */
const LAYER_CLASH: Readonly<Record<PieceLayer, readonly PieceLayer[]>> = {
  base: ['base', 'roof'],
  surface: ['surface'],
  solid: ['solid', 'roof', 'gable'],
  roof: ['roof', 'base', 'solid'],
  gable: ['gable', 'solid'],
  // Mounts only clash with mounts on the same face (see mountClash); tops with tops.
  mount: [],
  top: ['top'],
};

/** Two house roofs may intersect (L-shaped houses) unless one mostly covers the other. */
const ROOF_MAX_SHARED = 0.6;
function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
}
const area = (r: Rect) => (r.maxX - r.minX) * (r.maxZ - r.minZ);

/** Rectangle vs static collider overlap (box via SAT, circle via closest point). */
function rectHitsCollider(r: Rect, c: Collider, margin: number): boolean {
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const hw = (r.maxX - r.minX) / 2 + margin;
  const hd = (r.maxZ - r.minZ) / 2 + margin;
  if (c.shape === 'circle') {
    const qx = Math.max(cx - hw, Math.min(cx + hw, c.x));
    const qz = Math.max(cz - hd, Math.min(cz + hd, c.z));
    return (qx - c.x) ** 2 + (qz - c.z) ** 2 < c.radius * c.radius;
  }
  // SAT for two 2D oriented boxes (ours is axis aligned).
  const cs = Math.cos(c.yaw);
  const sn = Math.sin(c.yaw);
  // c's local axes in world space (matching rotateOffset: local x → (cos, -sin), local z → (sin, cos)).
  const ax = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: cs, z: -sn },
    { x: sn, z: cs },
  ];
  const dx = c.x - cx;
  const dz = c.z - cz;
  for (const a of ax) {
    const ra = hw * Math.abs(a.x) + hd * Math.abs(a.z);
    const rb = c.halfWidth * Math.abs(cs * a.x - sn * a.z) + c.halfDepth * Math.abs(sn * a.x + cs * a.z);
    if (Math.abs(dx * a.x + dz * a.z) >= ra + rb) return false;
  }
  return true;
}

/** Static world colliders (trees, rocks, fences, props…) under a footprint. */
export function staticObstacleAt(r: Rect, collision: CollisionWorld = defaultCollisionWorld()): Collider | null {
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const rad = Math.hypot(r.maxX - r.minX, r.maxZ - r.minZ) / 2 + 0.2;
  for (const c of collision.grid.query({ x: cx, z: cz }, rad, new Set())) if (!collision.disabled.has(c.id) && rectHitsCollider(r, c, 0.05)) return c;
  return null;
}

/** Surface pieces (tables, counters…) at `level` whose footprint holds the point. */
function surfaceUnder<P extends PieceLike>(index: PieceIndex<P>, x: number, z: number, level: number, exclude?: ReadonlySet<string>): P | null {
  let best: P | null = null;
  for (const q of index.query({ minX: x, maxX: x, minZ: z, maxZ: z }, 0.01)) {
    if (exclude?.has(q.id) || q.level !== level || !PIECES[q.kind].surface) continue;
    if (!rectContains(footprintOf(q), { x, z }, 0.05)) continue;
    if (!best || q.y + PIECES[q.kind].h > best.y + PIECES[best.kind].h) best = q;
  }
  return best;
}

/**
 * Pieces that hold `p` up. Ground-level pieces have none, except wall mounts
 * (their wall) and table-top things standing on a surface piece.
 */
export function supportsOf<P extends PieceLike>(index: PieceIndex<P>, p: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot' | 'level'> & { id?: string; params?: string | undefined }, exclude?: ReadonlySet<string>): P[] {
  const d = PIECES[p.kind];
  if (d.mount) {
    const { wall } = mountWall(index, p.kind, p.x, p.z, p.rot, p.level);
    return wall && !exclude?.has(wall.id) && wall.id !== p.id ? [wall] : [];
  }
  if (d.top) {
    const s = surfaceUnder(index, p.x, p.z, p.level, exclude);
    if (s) return [s];
    if (p.level <= 0) return [];
  }
  if (p.level <= 0) return [];
  const fp = footprintOf(p);
  const out: P[] = [];
  const below = (q: P) => q.level === p.level - 1 && PIECES[q.kind].structural;
  const floorHere = (q: P) => q.level === p.level && q.kind === 'floor' && rectContains(footprintOf(q), { x: p.x, z: p.z }, -0.01);
  for (const q of index.query(fp, 0.25)) {
    if (q.id === p.id || exclude?.has(q.id)) continue;
    const qfp = footprintOf(q);
    if (d.param === 'roof') {
      // A house roof rests on the walls/pillars along its edges.
      if (below(q) && rectsOverlap(expand(fp, 0.2), qfp, 0) && !rectsOverlap(expand(fp, -0.2), qfp, 0)) out.push(q);
    } else if (d.layer === 'base' || d.layer === 'roof') {
      // Slabs rest on structural pieces of the storey below touching their footprint.
      if (below(q) && rectsOverlap(expand(fp, 0.15), qfp, 0)) out.push(q);
    } else if (d.structural || d.layer === 'gable') {
      if (below(q) && rectsOverlap(fp, qfp, 0.05)) out.push(q);
      else if (d.structural && floorHere(q)) out.push(q);
    } else if (floorHere(q)) {
      out.push(q);
    }
  }
  return out;
}

/**
 * House roof support rule: the walls/pillars of the storey below run along at
 * least 3 of its 4 edges — an edge counts when at least half of its length is
 * walled (a wall end merely touching a corner does not count). Returns how
 * many edges are supported.
 */
export function roofEdgesSupported(fp: Rect, supports: readonly Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot'>[]): number {
  const m = 0.2;
  const along = (horizontal: boolean, line: number, a: number, b: number) => {
    const spans: [number, number][] = [];
    for (const q of supports) {
      const f = footprintOf(q);
      if (horizontal ? f.minZ - m <= line && f.maxZ + m >= line : f.minX - m <= line && f.maxX + m >= line) {
        const lo = Math.max(a, horizontal ? f.minX : f.minZ);
        const hi = Math.min(b, horizontal ? f.maxX : f.maxZ);
        if (hi > lo) spans.push([lo, hi]);
      }
    }
    spans.sort((p, q) => p[0] - q[0]);
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
  };
  const edges = [along(true, fp.minZ, fp.minX, fp.maxX), along(true, fp.maxZ, fp.minX, fp.maxX), along(false, fp.minX, fp.minZ, fp.maxZ), along(false, fp.maxX, fp.minZ, fp.maxZ)];
  return edges.filter((c) => c >= 0.5).length;
}

/** Base height for a piece at a level, given its supports (server stores the result). */
export function baseHeightFor<P extends PieceLike>(index: PieceIndex<P>, kind: PieceKind, x: number, z: number, rot: number, level: number, supports: readonly P[], params?: string): number {
  const d = PIECES[kind];
  if (d.mount) return supports[0]?.y ?? 0;
  if (d.top && supports[0] && PIECES[supports[0].kind].surface) return supports[0].y + PIECES[supports[0].kind].h;
  if (level > 0) {
    let y = -Infinity;
    for (const s of supports) y = Math.max(y, s.kind === 'floor' ? s.y : pieceTop(s));
    return y;
  }
  const fp = footprintOf({ kind, x, z, rot, ...(params ? { params } : {}) });
  let ground = -Infinity;
  for (const s of footprintSamples(fp)) ground = Math.max(ground, terrainHeight(s.x, s.z));
  if (!d.structural && d.layer !== 'base') {
    // Furniture / rugs on a ground floor tile rest on its top.
    for (const q of index.query(fp)) {
      if (q.level === 0 && q.kind === 'floor' && rectContains(footprintOf(q), { x, z }, -0.01)) ground = Math.max(ground, pieceTop(q));
    }
  }
  return ground;
}

/**
 * Validate a placement request. Pure: no I/O, no rate limits/caps/moderation
 * (the server adds those). Returns the normalised piece incl. authoritative y.
 */
export function validatePlacement<P extends PieceLike>(req: PlaceRequest, ctx: PlacementContext<P>): PlacementResult {
  if (!isPieceKind(req.kind)) return { ok: false, reason: 'unknown_piece' };
  const kind = req.kind;
  const d = PIECES[kind];
  const variant = typeof req.variant === 'string' ? req.variant : '';
  if (!d.variants.some((v) => v.id === variant)) return { ok: false, reason: 'bad_variant' };
  if (!isNum(req.x) || !isNum(req.z) || !onGrid(req.x) || !onGrid(req.z)) return { ok: false, reason: 'off_grid' };
  if (!isNum(req.rot) || !Number.isInteger(req.rot) || req.rot < 0 || req.rot > 3) return { ok: false, reason: 'bad_rotation' };
  if (d.param === 'roof' && req.rot > 1) return { ok: false, reason: 'bad_rotation' };
  if (!isNum(req.level) || !Number.isInteger(req.level) || req.level < d.minLevel || req.level > d.maxLevel || req.level > CONFIG.building.maxLevel) return { ok: false, reason: 'bad_level' };
  const x = req.x;
  const z = req.z;
  const rot = req.rot;
  const level = req.level;
  let params: string | undefined;
  if (d.param === 'roof') {
    const r = parseRoofParams(req.params);
    if (!r) return { ok: false, reason: 'bad_params' };
    params = roofParamsString(r);
  }
  const probe = { kind, x, z, rot, level, ...(params ? { params } : {}) };

  if (ctx.builderPos) {
    const range = ctx.range ?? CONFIG.building.range;
    if (Math.hypot(ctx.builderPos.x - x, ctx.builderPos.z - z) > range) return { ok: false, reason: 'too_far' };
  }

  const fp = footprintOf(probe);
  // Where: every sample point of the footprint (a roof: including its eaves) must be buildable land.
  const whereFp = d.param === 'roof' ? expand(fp, ROOF_OVERHANG) : fp;
  let minH = Infinity;
  let maxH = -Infinity;
  for (const s of footprintSamples(whereFp)) {
    const b = buildableAt(s);
    if (b.code !== 'ok') return b.label !== undefined ? { ok: false, reason: b.code, label: b.label } : { ok: false, reason: b.code };
    const h = terrainHeight(s.x, s.z);
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
  }
  if (level === 0 && !d.mount && !d.top) {
    if (maxH - minH > CONFIG.building.maxSlope) return { ok: false, reason: 'too_steep' };
  }
  if (level === 0 && !d.mount) {
    // A clearable bush or small rock in the way: say so (the client offers "Clear").
    const n = natureBlocking(fp, ctx.cleared);
    if (n) return { ok: false, reason: 'nature', label: n.kind === 'rock' ? 'a rock' : 'a bush', natureId: n.id };
    if (staticObstacleAt(fp, ctx.collision)) return { ok: false, reason: 'obstructed' };
  }

  // Overlap with existing pieces on the same level. Slim pieces (walls, fences, pillars) may share
  // corners and T-junctions: they only clash when they overlap by more than SLIM_JOINT on both axes.
  const clash = LAYER_CLASH[d.layer];
  for (const q of ctx.index.query(fp)) {
    if (q.level !== level) continue;
    const qd = PIECES[q.kind];
    if (d.mount || qd.mount) {
      // Two mounts on the same wall face may not share height.
      if (d.mount && qd.mount && q.x === x && q.z === z && q.rot === rot && d.mount.y0 < qd.mount.y1 - 0.01 && qd.mount.y0 < d.mount.y1 - 0.01) return { ok: false, reason: 'overlap' };
      continue;
    }
    if (d.param === 'roof' && qd.param === 'roof') {
      const qfp = footprintOf(q);
      if (overlapArea(fp, qfp) > ROOF_MAX_SHARED * Math.min(area(fp), area(qfp))) return { ok: false, reason: 'overlap' };
      continue;
    }
    // A table-top thing on the floor must not stand inside furniture or walls.
    const layerClash = clash.includes(qd.layer) || (d.top && !surfaceUnder(ctx.index, x, z, level) && qd.layer === 'solid');
    if (!layerClash) continue;
    const shrink = isSlim(kind) && isSlim(q.kind) ? SLIM_JOINT : 0.02;
    if (rectsOverlap(fp, footprintOf(q), shrink)) return { ok: false, reason: 'overlap' };
  }

  // Support (stacking, wall mounts, table tops).
  let supports: P[] = [];
  if (d.mount) {
    const m = mountWall(ctx.index, kind, x, z, rot, level);
    if (!m.wall) return m.reason === 'mount_blocked' ? { ok: false, reason: 'mount_blocked' } : { ok: false, reason: 'unsupported', label: 'Hangs on one of your walls — point at a wall' };
    if (m.wall.ownerId !== ctx.builderId) return { ok: false, reason: 'not_your_support' };
    supports = [m.wall];
  } else if (d.top) {
    const s = surfaceUnder(ctx.index, x, z, level);
    if (s) {
      if (s.ownerId !== ctx.builderId) return { ok: false, reason: 'not_your_support' };
      supports = [s];
    } else if (level > 0) {
      supports = supportsOf(ctx.index, probe);
      if (!supports.length) return { ok: false, reason: 'unsupported' };
      if (supports.some((q) => q.ownerId !== ctx.builderId)) return { ok: false, reason: 'not_your_support' };
    }
  } else if (level > 0) {
    supports = supportsOf(ctx.index, probe);
    if (d.param === 'roof') {
      const own = supports.filter((q) => q.ownerId === ctx.builderId);
      if (roofEdgesSupported(fp, own) < 3) return supports.length > own.length ? { ok: false, reason: 'not_your_support' } : { ok: false, reason: 'unsupported', label: 'A roof needs walls along at least three sides' };
      supports = own;
    } else {
      if (!supports.length) return { ok: false, reason: 'unsupported' };
      if (supports.some((s) => s.ownerId !== ctx.builderId)) return { ok: false, reason: 'not_your_support' };
    }
  }

  // Never trap or overlap a player: any solid ground-level piece near a player is refused.
  if (level === 0 && d.solid) {
    const r = CONFIG.movement.playerRadius + 0.05;
    for (const pc of pieceColliders({ id: 'probe', kind, x, z, rot, level, y: 0, ownerId: ctx.builderId })) {
      for (const pl of ctx.players) if (penetration(pl, r, pc)) return { ok: false, reason: 'player_in_way' };
    }
    // Doorways/gates: their gap counts too (you may not drop a door frame onto someone).
    for (const pl of ctx.players) if (rectContains(expand(fp, r), pl)) return { ok: false, reason: 'player_in_way' };
  }

  const y = Math.round(baseHeightFor(ctx.index, kind, x, z, rot, level, supports, params) * 100) / 100;
  return params ? { ok: true, kind, variant, x, z, rot, level, y, params } : { ok: true, kind, variant, x, z, rot, level, y };
}

/** Pieces that would lose all support (directly) if `id` were removed. */
export function directDependents<P extends PieceLike>(index: PieceIndex<P>, id: string): P[] {
  const p = index.get(id);
  if (!p) return [];
  const gone = new Set([id]);
  const out: P[] = [];
  const fp = footprintOf(p);
  for (const q of index.query(fp, 0.8)) {
    if (q.id === id) continue;
    const qd = PIECES[q.kind];
    if (qd.mount || qd.top) {
      if (q.level !== p.level) continue;
      const before = supportsOf(index, q);
      if (before.some((s) => s.id === id) && supportsOf(index, q, gone).length === 0) out.push(q);
      continue;
    }
    if (q.level > 0 && (q.level === p.level + 1 || q.level === p.level)) {
      const before = supportsOf(index, q);
      if (!before.some((s) => s.id === id)) continue;
      if (supportsOf(index, q, gone).length === 0) out.push(q);
    } else if (q.level === 0 && p.level === 0 && p.kind === 'floor' && PIECES[q.kind].layer !== 'base' && !PIECES[q.kind].structural) {
      // Furniture resting on a ground floor tile.
      if (q.y > p.y + 0.05 && rectContains(fp, { x: q.x, z: q.z }, -0.01)) {
        const others = index.query(footprintOf(q)).some((o) => o.id !== id && o.id !== q.id && o.kind === 'floor' && o.level === 0 && rectContains(footprintOf(o), { x: q.x, z: q.z }, -0.01));
        if (!others) out.push(q);
      }
    }
  }
  return out;
}

/** Everything that falls if `ids` are removed (transitively), including `ids`. */
export function cascadeRemoval<P extends PieceLike>(index: PieceIndex<P>, ids: readonly string[]): string[] {
  const out = new Set<string>();
  const queue = [...ids];
  // Work on a scratch copy so supports are recomputed as pieces vanish.
  const scratch = new PieceIndex<P>();
  for (const p of index.all()) scratch.add(p);
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id) || !scratch.get(id)) continue;
    const deps = directDependents(scratch, id);
    scratch.remove(id);
    out.add(id);
    for (const d of deps) queue.push(d.id);
  }
  return [...out];
}

/** Auto level for the preview: the lowest level where the piece is valid (or the most useful refusal). */
export function autoLevel<P extends PieceLike>(req: Omit<PlaceRequest, 'level'>, ctx: PlacementContext<P>): PlacementResult {
  if (!isPieceKind(req.kind)) return { ok: false, reason: 'unknown_piece' };
  const d = PIECES[req.kind];
  let first: PlacementResult | null = null;
  for (let level = d.minLevel; level <= d.maxLevel; level++) {
    const r = validatePlacement({ ...req, level }, ctx);
    if (r.ok) return r;
    if (!first) first = r;
    // Only keep climbing while the obstacle is "something is already here / nothing below yet".
    if (r.reason !== 'overlap' && r.reason !== 'unsupported' && r.reason !== 'player_in_way' && r.reason !== 'obstructed' && r.reason !== 'too_steep') return level === d.minLevel ? r : first;
    if (r.reason === 'unsupported' && level > d.minLevel) break;
  }
  return first ?? { ok: false, reason: 'bad_level' };
}

/** Snap a cursor ground point to a piece's grid. */
export function snapToGrid(kind: PieceKind, p: Vec2, rot: number): Vec2 {
  const d = PIECES[kind];
  const s = d.snap;
  // Odd-width spans (e.g. 1 m steps across) keep their edges on grid lines.
  const odd = (((rot % 4) + 4) % 4) % 2 === 1;
  const w = odd ? d.d : d.w;
  const dd = odd ? d.w : d.d;
  const offX = s >= 1 && Math.round(w) % 2 === 1 ? 0.5 : 0;
  const offZ = s >= 1 && Math.round(dd) % 2 === 1 ? 0.5 : 0;
  const g = CONFIG.building.grid;
  const sx = Math.round((p.x - offX) / s) * s + offX;
  const sz = Math.round((p.z - offZ) / s) * s + offZ;
  return { x: Math.round(sx / g) * g, z: Math.round(sz / g) * g };
}

// ---------------------------------------------------------------------------
// Wire helpers (snapshot rows)
// ---------------------------------------------------------------------------

export interface PieceRecord extends PieceLike {
  variant: string;
  ownerName: string;
  text?: string;
  createdAt?: number;
}

// ---------------------------------------------------------------------------
// Walk surface (characters standing on a ground-level floor or step)
// ---------------------------------------------------------------------------

/**
 * Height of the top of the ground-level floor tile or step a character at `p`
 * stands on, or null when none. Purely visual (floors and steps do not block
 * and do not change the server's movement rules): renderers lift feet onto
 * the boards instead of sinking them into the slab.
 */
export function walkSurfaceAt<P extends PieceLike>(index: PieceIndex<P>, p: Vec2): number | null {
  let top: number | null = null;
  for (const q of index.query({ minX: p.x, maxX: p.x, minZ: p.z, maxZ: p.z }, 0.01)) {
    if (q.level !== 0 || (q.kind !== 'floor' && q.kind !== 'steps')) continue;
    if (!rectContains(footprintOf(q), p, -0.01)) continue;
    let h = q.y + PIECES[q.kind].h;
    if (q.kind === 'steps') {
      // Lower tread over the whole step, upper tread over the back half (local -Z).
      const yaw = yawOfRot(q.rot);
      const lz = (p.x - q.x) * Math.sin(yaw) + (p.z - q.z) * Math.cos(yaw);
      h = q.y + (lz < 0.03 ? STEP_UPPER : STEP_LOWER);
    }
    if (top === null || h > top) top = h;
  }
  return top;
}
/** Tread heights of the `steps` piece (must match the renderer). */
export const STEP_LOWER = 0.2;
export const STEP_UPPER = 0.36;

// ---------------------------------------------------------------------------
// Clearing bushes and small rocks
// ---------------------------------------------------------------------------

export interface NatureItem {
  id: string;
  kind: 'bush' | 'rock' | 'tree';
  position: Vec2;
  /** Footprint radius (placement blocking). */
  radius: number;
  /** Shared collision collider id (rocks), if any. */
  colliderId?: string;
}
/** Radius a bush covers per unit of its scale. */
export const BUSH_RADIUS = 0.42;

let natureAll: Map<string, NatureItem> | null = null;
let natureClearable: Map<string, NatureItem> | null = null;
function natureMaps(): { all: Map<string, NatureItem>; clearable: Map<string, NatureItem> } {
  if (natureAll && natureClearable) return { all: natureAll, clearable: natureClearable };
  natureAll = new Map();
  natureClearable = new Map();
  for (const t of TREES) natureAll.set(t.id, { id: t.id, kind: 'tree', position: t.position, radius: t.trunkRadius, colliderId: `col_${t.id}` });
  for (const r of ROCKS) natureAll.set(r.id, { id: r.id, kind: 'rock', position: r.position, radius: r.radius, colliderId: `col_${r.id}` });
  for (const b of BUSHES) natureAll.set(b.id, { id: b.id, kind: 'bush', position: b.position, radius: BUSH_RADIUS * b.scale });
  for (const n of natureAll.values()) {
    if (n.kind === 'tree') continue;
    if (n.kind === 'rock' && n.radius > CONFIG.building.clear.maxRockRadius) continue;
    // Never anything in protected town zones (plaza planters, path verges, by doors), on the shore or off-island.
    if (buildableAt(n.position).code !== 'ok') continue;
    natureClearable.set(n.id, n);
  }
  return { all: natureAll, clearable: natureClearable };
}
/** Every bush and small rock a player may clear (open, buildable land only). */
export function clearableNature(): ReadonlyMap<string, NatureItem> {
  return natureMaps().clearable;
}
/** Any tree, rock or bush of the island by id. */
export function natureItem(id: string): NatureItem | undefined {
  return natureMaps().all.get(id);
}

/** The first clearable bush/rock (not yet cleared) overlapping a footprint. */
export function natureBlocking(r: Rect, cleared?: ReadonlySet<string>): NatureItem | null {
  for (const n of natureMaps().clearable.values()) {
    if (cleared?.has(n.id)) continue;
    const qx = Math.max(r.minX, Math.min(r.maxX, n.position.x));
    const qz = Math.max(r.minZ, Math.min(r.maxZ, n.position.z));
    if ((qx - n.position.x) ** 2 + (qz - n.position.z) ** 2 < n.radius * n.radius) return n;
  }
  return null;
}

export type ClearResult = { ok: true; item: NatureItem } | { ok: false; reason: BuildRefusal; label?: string };
/** Can this bush/rock be cleared by a player standing at builderPos? (Caps/rate limits: the server.) */
export function validateClear(id: unknown, ctx: { builderPos: Vec2 | null; range?: number; cleared?: ReadonlySet<string> }): ClearResult {
  const n = typeof id === 'string' ? natureItem(id) : undefined;
  if (!n) return { ok: false, reason: 'not_found' };
  if (!natureMaps().clearable.has(n.id)) return { ok: false, reason: 'not_clearable', label: n.kind === 'tree' ? 'a tree' : n.kind === 'rock' ? (n.radius > CONFIG.building.clear.maxRockRadius ? 'a big rock' : 'this rock') : 'this plant' };
  if (ctx.cleared?.has(n.id)) return { ok: false, reason: 'already_cleared' };
  if (ctx.builderPos && Math.hypot(ctx.builderPos.x - n.position.x, ctx.builderPos.z - n.position.z) > (ctx.range ?? CONFIG.building.range)) return { ok: false, reason: 'too_far' };
  return { ok: true, item: n };
}

/** Regrow rule: a cleared plant comes back only if no built piece stands within the clearance and nobody stands on it. */
export function canRegrow<P extends PieceLike>(index: PieceIndex<P>, n: NatureItem, players: readonly Vec2[]): boolean {
  const c = CONFIG.building.clear.regrowClearance;
  const near = index.query({ minX: n.position.x - c, maxX: n.position.x + c, minZ: n.position.z - c, maxZ: n.position.z + c });
  for (const q of near) {
    const f = footprintOf(q);
    const qx = Math.max(f.minX, Math.min(f.maxX, n.position.x));
    const qz = Math.max(f.minZ, Math.min(f.maxZ, n.position.z));
    if (Math.hypot(qx - n.position.x, qz - n.position.z) < c) return false;
  }
  return !players.some((p) => Math.hypot(p.x - n.position.x, p.z - n.position.z) < n.radius + CONFIG.movement.playerRadius + 0.1);
}

// ---------------------------------------------------------------------------
// Building upward and along a run (UI helpers, shared so they are testable)
// ---------------------------------------------------------------------------

/** Kinds that form a storey (stack wall-on-wall). */
export const WALL_KINDS: readonly PieceKind[] = ['wall', 'wall_window', 'doorway', 'half_wall', 'pillar'];
export function isWallKind(k: PieceKind): boolean {
  return WALL_KINDS.includes(k);
}

/** Extend a wall upward: the same line and orientation, one storey higher. */
export function stackOnto(wall: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot' | 'level'>, kind: PieceKind): { x: number; z: number; rot: number; level: number } | null {
  if (!PIECES[wall.kind].structural || !isWallKind(kind)) return null;
  // Pillars are square: keep the wall's orientation only for wall-shaped pieces.
  const rot = kind === 'pillar' ? 0 : wall.kind === 'pillar' ? 0 : ((wall.rot % 4) + 4) % 4;
  return { x: wall.x, z: wall.z, rot, level: wall.level + 1 };
}

/** Next piece along a run of walls/fences: one piece-width further along its line (direction from the previous one). */
export function nextInRun(last: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot'>, prev?: Pick<PieceLike, 'x' | 'z'> | null): Vec2 {
  const w = PIECES[last.kind].w;
  const yaw = yawOfRot(last.rot);
  // Local +X in world space (rotateOffset: local x → (cos, -sin)).
  let dx = Math.cos(yaw);
  let dz = -Math.sin(yaw);
  if (prev && (prev.x - last.x) * dx + (prev.z - last.z) * dz > 0.01) {
    dx = -dx;
    dz = -dz;
  }
  const r = (v: number) => Math.round(v / CONFIG.building.grid) * CONFIG.building.grid + 0;
  return { x: r(last.x + dx * w), z: r(last.z + dz * w) };
}

// ---------------------------------------------------------------------------
// Sitting on built seats (chairs, benches, stools, sofas, armchairs, beds)
// ---------------------------------------------------------------------------

/** Interactable id of a built piece ("bp:<pieceId>"). */
export const PIECE_INTERACT_PREFIX = 'bp:';
export function pieceInteractId(pieceId: string): string {
  return `${PIECE_INTERACT_PREFIX}${pieceId}`;
}
export function pieceIdOfInteract(id: string): string | null {
  return id.startsWith(PIECE_INTERACT_PREFIX) ? id.slice(PIECE_INTERACT_PREFIX.length) : null;
}

/**
 * A built seat as a regular seat interactable, so the existing sit
 * interaction (seat refs, getSeat, stand-up exits, seated rendering) works
 * for it unchanged. Ground-level pieces only (upstairs is not walkable).
 */
export function pieceSeatInteractable(p: PieceLike): SeatInteractable | null {
  const def = PIECES[p.kind];
  if (!def.seats?.length || p.level !== 0) return null;
  const seats: Seat[] = [];
  for (let i = 0; i < def.seats.length; i++) {
    const s = pieceSeat(p, i)!;
    seats.push({ position: s.position, height: s.y - groundHeight(s.position.x, s.position.z), yaw: s.yaw, exit: s.exit });
  }
  const loc = locationAt(p);
  return {
    id: pieceInteractId(p.id),
    kind: def.seats.length > 1 ? 'bench' : 'chair',
    name: def.name,
    locationId: (loc?.id ?? 'town_square') as SeatInteractable['locationId'],
    position: { x: p.x, z: p.z },
    yaw: yawOfRot(p.rot),
    prompt: 'Sit',
    synced: false,
    radius: Math.max(1.6, Math.max(def.w, def.d) / 2 + 1.1),
    seats,
  };
}

// ---------------------------------------------------------------------------
// House-roof tool: find the rectangle of walls a roof should cover
// ---------------------------------------------------------------------------

/** A roof span in world terms: centre, extents between wall centre lines, and the storey it sits on. */
export interface RoofSpan {
  x: number;
  z: number;
  /** World X / Z extent between wall centre lines. */
  sx: number;
  sz: number;
  level: number;
}

/** Roof params for a span and a ridge choice (rot 0: ridge along world Z, rot 1: along world X). */
export function roofParamsFor(span: Pick<RoofSpan, 'sx' | 'sz'>, rot: number, style: RoofStyle, pitch: 0 | 1): RoofParams {
  return rot % 2 === 0 ? { w: span.sx, d: span.sz, style, pitch } : { w: span.sz, d: span.sx, style, pitch };
}

/**
 * The walled rectangle under `seed`: the connected top-storey walls/pillars
 * (same owner, same level), their bounding box measured between wall centre
 * lines. Null when the shape is not a clean rectangle (each side must be at
 * least 70% walled — doorways and windows count) so the UI falls back to a
 * two-corner span.
 */
export function detectRoofSpan<P extends PieceLike>(index: PieceIndex<P>, seed: P): RoofSpan | null {
  if (!PIECES[seed.kind].structural) return null;
  const comp = new Map<string, P>();
  const queue = [seed];
  while (queue.length && comp.size < 200) {
    const q = queue.pop()!;
    if (comp.has(q.id)) continue;
    comp.set(q.id, q);
    for (const n of index.query(footprintOf(q), 0.2)) if (!comp.has(n.id) && n.level === seed.level && n.ownerId === seed.ownerId && PIECES[n.kind].structural) queue.push(n);
  }
  let box: Rect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const q of comp.values()) {
    const f = footprintOf(q);
    box = { minX: Math.min(box.minX, f.minX), maxX: Math.max(box.maxX, f.maxX), minZ: Math.min(box.minZ, f.minZ), maxZ: Math.max(box.maxZ, f.maxZ) };
  }
  const x0 = Math.round(box.minX + WALL_HALF);
  const x1 = Math.round(box.maxX - WALL_HALF);
  const z0 = Math.round(box.minZ + WALL_HALF);
  const z1 = Math.round(box.maxZ - WALL_HALF);
  const sx = x1 - x0;
  const sz = z1 - z0;
  const { minSpan, maxSpan } = CONFIG.building.roof;
  if (sx < minSpan || sz < minSpan || sx > maxSpan || sz > maxSpan) return null;
  // Coverage of each side by the component's pieces.
  const cover = (horizontal: boolean, line: number, a: number, b: number) => {
    const spans: [number, number][] = [];
    for (const q of comp.values()) {
      const f = footprintOf(q);
      if (horizontal ? f.minZ - 0.15 <= line && f.maxZ + 0.15 >= line : f.minX - 0.15 <= line && f.maxX + 0.15 >= line) spans.push(horizontal ? [f.minX, f.maxX] : [f.minZ, f.maxZ]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    let covered = 0;
    let at = a;
    for (const [s0, s1] of spans) {
      const lo = Math.max(at, s0);
      const hi = Math.min(b, s1);
      if (hi > lo) {
        covered += hi - lo;
        at = hi;
      }
    }
    return covered / (b - a);
  };
  const ok = [cover(true, z0, x0, x1), cover(true, z1, x0, x1), cover(false, x0, z0, z1), cover(false, x1, z0, z1)].every((c) => c >= 0.7);
  if (!ok) return null;
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, sx, sz, level: seed.level + 1 };
}

/** Two-corner span (fallback): corners on wall centre lines (whole metres). */
export function roofSpanFromCorners(a: Vec2, b: Vec2, level: number): RoofSpan | null {
  const x0 = Math.round(Math.min(a.x, b.x));
  const x1 = Math.round(Math.max(a.x, b.x));
  const z0 = Math.round(Math.min(a.z, b.z));
  const z1 = Math.round(Math.max(a.z, b.z));
  const { minSpan, maxSpan } = CONFIG.building.roof;
  const sx = x1 - x0;
  const sz = z1 - z0;
  if (sx < minSpan || sz < minSpan || sx > maxSpan || sz > maxSpan) return null;
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, sx, sz, level };
}
