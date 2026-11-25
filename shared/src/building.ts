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
import { INTERACTABLES } from './world/interactables.js';
import { protectedZoneAt } from './world/interiors.js';
import { LOCATIONS } from './world/locations.js';
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
] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

/**
 * Occupancy layer. base = floor slabs/steps, surface = rugs, solid = walls and
 * furniture, roof = roof slabs, gable = triangular end walls under a roof.
 */
export type PieceLayer = 'base' | 'surface' | 'solid' | 'roof' | 'gable';
export type PieceCategory = 'structure' | 'roof' | 'garden' | 'furnishing';

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

/** Posts at both ends of a 2 m span, leaving a walkable gap in the middle. */
const POSTS_2M = [
  { x: -0.85, z: 0, hw: 0.15, hd: 0.12 },
  { x: 0.85, z: 0, hw: 0.15, hd: 0.12 },
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
  roof_flat: def({ kind: 'roof_flat', name: 'Flat roof', category: 'roof', w: 2, d: 2, h: 0.3, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'Sits on top of walls.' }),
  roof_slope: def({ kind: 'roof_slope', name: 'Roof slope', category: 'roof', w: 2, d: 2, h: 1.25, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'Two facing each other make a gable roof.' }),
  roof_peak: def({ kind: 'roof_peak', name: 'Peaked roof', category: 'roof', w: 2, d: 2, h: 1.0, layer: 'roof', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: ROOF, hint: 'A small pitched roof with closed ends.' }),
  gable: def({ kind: 'gable', name: 'Gable', category: 'roof', w: 2, d: 0.24, h: 1.25, layer: 'gable', solid: false, structural: false, minLevel: 1, maxLevel: ML, variants: PLASTER, hint: 'Closes the end under a roof slope.' }),
  steps: def({ kind: 'steps', name: 'Steps', category: 'structure', w: 2, d: 1, h: 0.36, layer: 'base', solid: false, structural: false, maxLevel: 0, variants: FLOOR, hint: 'A low stone step up to a door.' }),
  fence: def({ kind: 'fence', name: 'Fence', category: 'garden', w: 2, d: 0.16, h: 0.95, layer: 'solid', solid: true, structural: false, maxLevel: 0, variants: WOOD, hint: 'A picket fence, 2 m.' }),
  gate: def({ kind: 'gate', name: 'Gate', category: 'garden', w: 2, d: 0.16, h: 0.95, layer: 'solid', solid: true, structural: false, maxLevel: 0, colliders: POSTS_2M, variants: WOOD, hint: 'An open garden gate.' }),
  table: def({ kind: 'table', name: 'Table', category: 'furnishing', w: 1.4, d: 0.9, h: 0.78, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A sturdy farmhouse table.' }),
  bench: def({ kind: 'bench', name: 'Bench', category: 'furnishing', w: 1.6, d: 0.5, h: 0.85, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A garden bench.' }),
  chair: def({ kind: 'chair', name: 'Chair', category: 'furnishing', w: 0.6, d: 0.6, h: 0.95, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'A ladder-back chair.' }),
  lamp: def({ kind: 'lamp', name: 'Lamp', category: 'garden', w: 0.4, d: 0.4, h: 2.1, layer: 'solid', solid: true, structural: false, snap: 0.5, light: true, variants: IRON, hint: 'Lights itself at dusk.' }),
  planter: def({ kind: 'planter', name: 'Planter', category: 'garden', w: 1, d: 0.5, h: 0.75, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: FLOWERS, hint: 'A box of flowers.' }),
  crate: def({ kind: 'crate', name: 'Crate', category: 'furnishing', w: 0.8, d: 0.8, h: 0.72, layer: 'solid', solid: true, structural: false, snap: 0.5, variants: WOOD, hint: 'For keeping things in.' }),
  rug: def({ kind: 'rug', name: 'Rug', category: 'furnishing', w: 2, d: 1.4, h: 0.03, layer: 'surface', solid: false, structural: false, snap: 0.5, variants: RUG, hint: 'Woven, soft underfoot.' }),
  sign: def({ kind: 'sign', name: 'Sign', category: 'garden', w: 0.8, d: 0.3, h: 1.35, layer: 'solid', solid: true, structural: false, snap: 0.5, text: true, maxLevel: 0, variants: WOOD, hint: 'A little signpost with your words.' }),
};

export const PIECE_CATEGORIES: readonly { id: PieceCategory; name: string }[] = [
  { id: 'structure', name: 'Build' },
  { id: 'roof', name: 'Roofs' },
  { id: 'garden', name: 'Garden' },
  { id: 'furnishing', name: 'Home' },
];

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
    this.cellRange(footprint(p.kind, p.x, p.z, p.rot), (k) => {
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
    this.cellRange(footprint(p.kind, p.x, p.z, p.rot), (k) => {
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
    for (const p of seen) if (rectsOverlap(footprint(p.kind, p.x, p.z, p.rot), q, 0)) out.push(p);
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
    const name = buildingName.get(pz.buildingId) ?? 'a building';
    return { code: 'protected', label: pz.kind === 'door_apron' ? `the ${name} doorway` : name };
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
  | 'supports_others';

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
      return 'Needs something underneath';
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
      return `Signs hold up to ${CONFIG.building.signMaxLength} characters`;
    case 'muted':
      return 'You can’t write signs while muted';
    case 'not_found':
      return 'That piece is already gone';
    case 'not_owner':
      return 'You can only remove your own pieces';
    case 'supports_others':
      return 'Remove what rests on it first';
  }
}

export interface PlaceRequest {
  kind: unknown;
  variant: unknown;
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
}

export type PlacementResult =
  | { ok: true; kind: PieceKind; variant: string; x: number; z: number; rot: number; level: number; y: number }
  | { ok: false; reason: BuildRefusal; label?: string };

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
};

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
  for (const c of collision.grid.query({ x: cx, z: cz }, rad, new Set())) if (rectHitsCollider(r, c, 0.05)) return c;
  return null;
}

/** Pieces that hold `p` up (empty for ground-level pieces). */
export function supportsOf<P extends PieceLike>(index: PieceIndex<P>, p: Pick<PieceLike, 'kind' | 'x' | 'z' | 'rot' | 'level'> & { id?: string }, exclude?: ReadonlySet<string>): P[] {
  if (p.level <= 0) return [];
  const d = PIECES[p.kind];
  const fp = footprint(p.kind, p.x, p.z, p.rot);
  const out: P[] = [];
  const below = (q: P) => q.level === p.level - 1 && PIECES[q.kind].structural;
  const floorHere = (q: P) => q.level === p.level && q.kind === 'floor' && rectContains(footprint(q.kind, q.x, q.z, q.rot), { x: p.x, z: p.z }, -0.01);
  for (const q of index.query(fp, 0.15)) {
    if (q.id === p.id || exclude?.has(q.id)) continue;
    const qfp = footprint(q.kind, q.x, q.z, q.rot);
    if (d.layer === 'base' || d.layer === 'roof') {
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

/** Base height for a piece at a level, given its supports (server stores the result). */
export function baseHeightFor<P extends PieceLike>(index: PieceIndex<P>, kind: PieceKind, x: number, z: number, rot: number, level: number, supports: readonly P[]): number {
  if (level > 0) {
    let y = -Infinity;
    for (const s of supports) y = Math.max(y, s.kind === 'floor' ? s.y : pieceTop(s));
    return y;
  }
  const fp = footprint(kind, x, z, rot);
  let ground = -Infinity;
  for (const s of footprintSamples(fp)) ground = Math.max(ground, terrainHeight(s.x, s.z));
  const d = PIECES[kind];
  if (!d.structural && d.layer !== 'base') {
    // Furniture / rugs on a ground floor tile rest on its top.
    for (const q of index.query(fp)) {
      if (q.level === 0 && q.kind === 'floor' && rectContains(footprint(q.kind, q.x, q.z, q.rot), { x, z }, -0.01)) ground = Math.max(ground, pieceTop(q));
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
  if (!isNum(req.level) || !Number.isInteger(req.level) || req.level < d.minLevel || req.level > d.maxLevel || req.level > CONFIG.building.maxLevel) return { ok: false, reason: 'bad_level' };
  const x = req.x;
  const z = req.z;
  const rot = req.rot;
  const level = req.level;

  if (ctx.builderPos) {
    const range = ctx.range ?? CONFIG.building.range;
    if (Math.hypot(ctx.builderPos.x - x, ctx.builderPos.z - z) > range) return { ok: false, reason: 'too_far' };
  }

  const fp = footprint(kind, x, z, rot);
  // Where: every sample point of the footprint must be buildable land.
  let minH = Infinity;
  let maxH = -Infinity;
  for (const s of footprintSamples(fp)) {
    const b = buildableAt(s);
    if (b.code !== 'ok') return b.label !== undefined ? { ok: false, reason: b.code, label: b.label } : { ok: false, reason: b.code };
    const h = terrainHeight(s.x, s.z);
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
  }
  if (level === 0 && maxH - minH > CONFIG.building.maxSlope) return { ok: false, reason: 'too_steep' };
  if (level === 0 && staticObstacleAt(fp, ctx.collision)) return { ok: false, reason: 'obstructed' };

  // Overlap with existing pieces on the same level. Slim pieces (walls, fences, pillars) may share
  // corners and T-junctions: they only clash when they overlap by more than SLIM_JOINT on both axes.
  const clash = LAYER_CLASH[d.layer];
  for (const q of ctx.index.query(fp)) {
    if (q.level !== level) continue;
    if (!clash.includes(PIECES[q.kind].layer)) continue;
    const shrink = isSlim(kind) && isSlim(q.kind) ? SLIM_JOINT : 0.02;
    if (rectsOverlap(fp, footprint(q.kind, q.x, q.z, q.rot), shrink)) return { ok: false, reason: 'overlap' };
  }

  // Support (stacking).
  let supports: P[] = [];
  if (level > 0) {
    supports = supportsOf(ctx.index, { kind, x, z, rot, level });
    if (!supports.length) return { ok: false, reason: 'unsupported' };
    if (supports.some((s) => s.ownerId !== ctx.builderId)) return { ok: false, reason: 'not_your_support' };
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

  const y = Math.round(baseHeightFor(ctx.index, kind, x, z, rot, level, supports) * 100) / 100;
  return { ok: true, kind, variant, x, z, rot, level, y };
}

/** Pieces that would lose all support (directly) if `id` were removed. */
export function directDependents<P extends PieceLike>(index: PieceIndex<P>, id: string): P[] {
  const p = index.get(id);
  if (!p) return [];
  const gone = new Set([id]);
  const out: P[] = [];
  const fp = footprint(p.kind, p.x, p.z, p.rot);
  for (const q of index.query(fp, 0.2)) {
    if (q.id === id) continue;
    if (q.level > 0 && (q.level === p.level + 1 || q.level === p.level)) {
      const before = supportsOf(index, q);
      if (!before.some((s) => s.id === id)) continue;
      if (supportsOf(index, q, gone).length === 0) out.push(q);
    } else if (q.level === 0 && p.level === 0 && p.kind === 'floor' && PIECES[q.kind].layer !== 'base' && !PIECES[q.kind].structural) {
      // Furniture resting on a ground floor tile.
      if (q.y > p.y + 0.05 && rectContains(fp, { x: q.x, z: q.z }, -0.01)) {
        const others = index.query(footprint(q.kind, q.x, q.z, q.rot)).some((o) => o.id !== id && o.id !== q.id && o.kind === 'floor' && o.level === 0 && rectContains(footprint(o.kind, o.x, o.z, o.rot), { x: q.x, z: q.z }, -0.01));
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
    if (!rectContains(footprint(q.kind, q.x, q.z, q.rot), p, -0.01)) continue;
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
