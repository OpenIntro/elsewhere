/**
 * Walk-in interiors. Every `enterable` building (see buildings.ts) is a hollow
 * shell in the SAME world space as the island: four walls of WALL_THICKNESS
 * with a real door gap on the front face, a raised floor (`floorY`, reached by
 * a short ramp over the doorstep) and furniture with collision footprints.
 *
 * This file is the single source of truth for:
 *  - wall + furniture colliders (colliders.ts derives them from here),
 *  - floor heights (ground.ts → groundHeight: floor, door ramps, platforms),
 *  - indoor seats (interactables.ts turns INTERIOR_SEATS into chair/bench interactables),
 *  - the typed interior description other systems build on (INTERIORS: rooms,
 *    doors, named anchor points with facing) and the building "protected
 *    zones" (footprint + door apron) that player building must keep clear.
 *
 * Local frames follow buildings.ts: +Z = out of the front (door) face,
 * +X = to your right when standing outside looking at the façade.
 * Pure data + functions (no DOM / Node); client and server compute the same.
 */
import { rotateOffset, type Vec2 } from '../math.js';
import { BUILDINGS, buildingLocal, type Building } from './buildings.js';
import { setInteriorLocator, type LocationId } from './locations.js';
import { terrainHeight } from './terrain.js';

/** Wall thickness of enterable buildings (visual and collider). */
export const WALL_THICKNESS = 0.28;
/** Depth of the protected apron in front of every door (player building keeps it clear). */
export const DOOR_APRON_DEPTH = 3.2;
/** Extra half width of the apron on each side of the door opening. */
export const DOOR_APRON_SIDE = 1.1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Oriented rectangle on the ground plane (world space). */
export interface RectZone {
  center: Vec2;
  /** Half extent along the zone's local X. */
  halfWidth: number;
  /** Half extent along the zone's local Z. */
  halfDepth: number;
  yaw: number;
}

export type InteriorPurpose = 'cafe' | 'store' | 'hall' | 'workshop' | 'home' | 'boathouse';

/** A named spot inside a building: where a character stands to use something, facing it. */
export interface InteriorAnchor {
  name: string;
  /** Walkable standing point (world). */
  position: Vec2;
  /** Facing while using the anchor (forward(yaw) points at the thing). */
  yaw: number;
  /** Floor height at the anchor (character feet). */
  y: number;
}

export interface InteriorDoor {
  /** Door interactable id (synced open/closed state). */
  id: string;
  buildingId: string;
  /** Centre of the opening on the outer wall face (world). */
  position: Vec2;
  /** Outward facing (forward(yaw) points out of the building). */
  yaw: number;
  /** Clear opening width. */
  width: number;
  /** Clear zone in front of the door (no building / clutter). */
  apron: RectZone;
  /** A walkable point just inside the door and one just outside the doorstep ramp. */
  inside: Vec2;
  outside: Vec2;
}

export interface InteriorRoom {
  id: string;
  name: string;
  bounds: RectZone;
}

export type FurnitureKind =
  | 'counter'
  | 'pastry_case'
  | 'back_shelf'
  | 'cafe_table'
  | 'piano'
  | 'bookshelf'
  | 'plant'
  | 'rug'
  | 'store_counter'
  | 'shelf'
  | 'display_table'
  | 'crate_stack'
  | 'barrel'
  | 'sacks'
  | 'stove'
  | 'lectern'
  | 'archive_shelf'
  | 'notice_board'
  | 'meeting_table'
  | 'tower_base'
  | 'banner'
  | 'workbench'
  | 'tool_wall'
  | 'kiln'
  | 'lumber_rack'
  | 'boat_frame'
  | 'anvil'
  | 'bed'
  | 'hearth'
  | 'dining_table'
  | 'kitchen'
  | 'dresser'
  | 'oar_rack'
  | 'net_wall'
  | 'chalkboard'
  | 'mic_stand';

export type FurnitureShape = { type: 'circle'; radius: number } | { type: 'box'; halfWidth: number; halfDepth: number };

export interface FurniturePiece {
  id: string;
  interiorId: string;
  kind: FurnitureKind;
  /** World position / yaw (front of the piece faces forward(yaw)). */
  position: Vec2;
  yaw: number;
  /** Same, in the building's local frame. */
  local: Vec2;
  localYaw: number;
  /** Collision footprint; null = walk-through (rugs, wall-mounted, overhead). */
  shape: FurnitureShape | null;
  /** Visual height (also what pickups rest on). */
  height: number;
  /** Renderer variation (colour/style pick). */
  variant: number;
}

/** Low walkable dais (café stage, hall speaker's platform): raises groundHeight. */
export interface InteriorPlatform {
  id: string;
  zone: RectZone;
  /** Height above the floor. */
  height: number;
}

export interface InteriorLight {
  /** World position; y = height above the floor. */
  position: Vec2;
  y: number;
  color: string;
}

export interface InteriorSeatSpec {
  id: string;
  kind: 'chair' | 'bench';
  /** Display name ("Chair", "Piano stool", "Hall bench"). */
  name: string;
  /** Renderer style. */
  style: 'wood_chair' | 'stool' | 'armchair' | 'pew' | 'cafe_chair';
  interiorId: string;
  locationId: LocationId;
  position: Vec2;
  yaw: number;
  /** Chairs only: where the character stands up (walkable). Benches stand up in front. */
  exit: Vec2;
}

export interface Interior {
  /** Same as the building id. */
  id: string;
  buildingId: string;
  name: string;
  locationId: LocationId;
  purpose: InteriorPurpose;
  /** Footstep surface of the floor. */
  floor: 'wood' | 'stone';
  /** Outer wall rectangle (world). */
  footprint: RectZone;
  /** Clear room inside the walls (world). */
  inner: RectZone;
  /** Floor height (character feet) inside. */
  floorY: number;
  /** Terrain height the building stands on (bottom of the doorstep ramp). */
  baseY: number;
  wallThickness: number;
  /** Wall height above the floor. */
  wallHeight: number;
  doors: readonly InteriorDoor[];
  rooms: readonly InteriorRoom[];
  /** Named anchor points (standing spots with facing) — see the table in docs/ARCHITECTURE.md. */
  anchors: Readonly<Record<string, InteriorAnchor>>;
  furniture: readonly FurniturePiece[];
  platforms: readonly InteriorPlatform[];
  /** Ids of indoor seat interactables (chairs / benches). */
  seatIds: readonly string[];
  /** Ceiling lamps (warm, on with the street lights). */
  lights: readonly InteriorLight[];
}

// ---------------------------------------------------------------------------
// Specs (local frame)
// ---------------------------------------------------------------------------

type L = [number, number];
interface FurnSpec {
  kind: FurnitureKind;
  at: L;
  /** Local yaw (0 = facing out of the front of the building, PI = facing the back wall). */
  yaw?: number;
  /** [halfWidth, halfDepth] box, or radius; omitted = no collider. */
  box?: L;
  r?: number;
  h: number;
  v?: number;
  id?: string;
}
interface SeatSpecLocal {
  id: string;
  kind: 'chair' | 'bench';
  name: string;
  style: InteriorSeatSpec['style'];
  at: L;
  yaw: number;
  exit?: L;
}
interface AnchorSpec {
  at: L;
  /** Face towards this local point. */
  face: L;
}
interface PlatformSpec {
  id: string;
  /** Local rect: centre + half extents (axis aligned in the building frame). */
  at: L;
  half: L;
  h: number;
}
interface InteriorSpec {
  purpose: InteriorPurpose;
  floor: 'wood' | 'stone';
  rooms: { id: string; name: string; at: L; half: L }[];
  furniture: FurnSpec[];
  seats: SeatSpecLocal[];
  anchors: Record<string, AnchorSpec>;
  platforms?: PlatformSpec[];
  lights: [number, number, number][];
}

const PI = Math.PI;
const BACK = PI; // facing the back wall
const RIGHT = PI / 2; // facing local +X
const LEFT = -PI / 2;

const CAFE: InteriorSpec = {
  purpose: 'cafe',
  floor: 'wood',
  rooms: [
    { id: 'cafe_floor', name: 'Café floor', at: [0, 0.6], half: [5.2, 3.4] },
    { id: 'cafe_stage', name: 'Piano corner', at: [-3.9, -2.8], half: [1.3, 1.15] },
    { id: 'cafe_bar', name: 'Behind the counter', at: [3.0, -3.15], half: [2.2, 0.8] },
  ],
  furniture: [
    { id: 'counter', kind: 'counter', at: [3.05, -2.02], yaw: 0, box: [2.17, 0.36], h: 1.05 },
    { id: 'back_shelf', kind: 'back_shelf', at: [3.0, -3.86], yaw: 0, h: 2.6 },
    { id: 'chalkboard', kind: 'chalkboard', at: [-0.4, -3.9], yaw: 0, h: 2.4 },
    { id: 'piano', kind: 'piano', at: [-4.3, -3.55], yaw: 0, box: [0.78, 0.34], h: 1.3 },
    { id: 'mic', kind: 'mic_stand', at: [-2.95, -2.2], yaw: 0, h: 1.5 },
    { id: 'table_1', kind: 'cafe_table', at: [-3.3, 1.55], r: 0.5, h: 0.76 },
    { id: 'table_2', kind: 'cafe_table', at: [3.25, 1.45], r: 0.5, h: 0.76 },
    { id: 'table_3', kind: 'cafe_table', at: [-1.15, -0.55], r: 0.5, h: 0.76 },
    { id: 'bookshelf', kind: 'bookshelf', at: [-5.0, -0.3], yaw: RIGHT, box: [0.7, 0.2], h: 1.9 },
    { id: 'plant_1', kind: 'plant', at: [-4.8, 3.55], r: 0.32, h: 1.4, v: 0 },
    { id: 'plant_2', kind: 'plant', at: [4.85, 3.55], r: 0.32, h: 1.2, v: 1 },
    { id: 'plant_3', kind: 'plant', at: [-1.95, -3.62], r: 0.28, h: 1.1, v: 2 },
    { id: 'rug', kind: 'rug', at: [-1.2, -0.2], h: 0.02, v: 0 },
  ],
  seats: [
    { id: 'chair_cafe_in_1a', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [-4.25, 1.55], yaw: RIGHT, exit: [-4.15, 2.6] },
    { id: 'chair_cafe_in_1b', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [-2.35, 1.55], yaw: LEFT, exit: [-2.25, 2.6] },
    { id: 'chair_cafe_in_2a', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [2.3, 1.45], yaw: RIGHT, exit: [2.2, 2.55] },
    { id: 'chair_cafe_in_2b', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [4.2, 1.45], yaw: LEFT, exit: [4.1, 2.55] },
    { id: 'chair_cafe_in_3a', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [-1.15, 0.4], yaw: BACK, exit: [-0.05, 0.6] },
    { id: 'chair_cafe_in_3b', kind: 'chair', name: 'Chair', style: 'cafe_chair', at: [-1.15, -1.5], yaw: 0, exit: [-0.05, -1.3] },
    { id: 'stool_cafe_piano', kind: 'chair', name: 'Piano stool', style: 'stool', at: [-4.3, -2.8], yaw: BACK, exit: [-3.3, -2.75] },
  ],
  anchors: {
    entrance: { at: [0, 3.2], face: [0, 0] },
    counter: { at: [2.4, -1.05], face: [2.4, -2.0] },
    barista: { at: [2.6, -3.15], face: [2.6, -2.0] },
    espresso: { at: [4.1, -3.15], face: [4.1, -2.0] },
    stage: { at: [-3.3, -2.35], face: [0, 0.6] },
    piano: { at: [-4.3, -2.8], face: [-4.3, -3.6] },
    table_1: { at: [-3.3, 2.6], face: [-3.3, 1.55] },
    table_2: { at: [3.25, 2.55], face: [3.25, 1.45] },
    table_3: { at: [0.0, -0.55], face: [-1.15, -0.55] },
    bookshelf: { at: [-4.2, -0.3], face: [-5.0, -0.3] },
  },
  platforms: [{ id: 'stage', at: [-3.9, -2.83], half: [1.32, 1.14], h: 0.12 }],
  lights: [[-2.2, 0.6, 2.7], [2.6, -1.0, 2.7], [-3.9, -2.6, 2.6]],
};

const STORE: InteriorSpec = {
  purpose: 'store',
  floor: 'wood',
  rooms: [
    { id: 'store_floor', name: 'Shop floor', at: [0, 0.4], half: [4.8, 3.5] },
    { id: 'store_counter', name: 'Behind the counter', at: [2.6, -3.15], half: [2.2, 0.75] },
  ],
  furniture: [
    { id: 'counter', kind: 'store_counter', at: [2.55, -1.95], yaw: 0, box: [1.75, 0.36], h: 1.0 },
    { id: 'wall_shelf_back', kind: 'back_shelf', at: [2.6, -3.78], yaw: 0, h: 2.7, v: 1 },
    { id: 'shelf_1', kind: 'shelf', at: [-4.52, -2.2], yaw: RIGHT, box: [0.95, 0.24], h: 2.2, v: 0 },
    { id: 'shelf_2', kind: 'shelf', at: [-4.52, 0.35], yaw: RIGHT, box: [0.95, 0.24], h: 2.2, v: 1 },
    { id: 'shelf_3', kind: 'shelf', at: [-1.75, -3.62], yaw: 0, box: [1.2, 0.24], h: 2.2, v: 2 },
    { id: 'display', kind: 'display_table', at: [-1.9, 0.75], yaw: 0, box: [0.75, 0.5], h: 0.85 },
    { id: 'crates', kind: 'crate_stack', at: [3.7, 1.25], yaw: 0.15, box: [0.62, 0.45], h: 0.95 },
    { id: 'barrel', kind: 'barrel', at: [4.25, 3.3], r: 0.4, h: 0.95 },
    { id: 'sacks', kind: 'sacks', at: [1.9, 3.35], yaw: 0.2, box: [0.5, 0.32], h: 0.6 },
    { id: 'stove', kind: 'stove', at: [-4.15, 3.2], r: 0.42, h: 1.2 },
    { id: 'rug', kind: 'rug', at: [-2.6, 2.6], h: 0.02, v: 1 },
  ],
  seats: [
    { id: 'chair_store_stove', kind: 'chair', name: 'Chair by the stove', style: 'wood_chair', at: [-2.9, 2.55], yaw: -2.2, exit: [-2.2, 1.95] },
  ],
  anchors: {
    entrance: { at: [0, 3.1], face: [0, 0] },
    counter: { at: [2.2, -1.0], face: [2.2, -1.95] },
    shopkeeper: { at: [2.4, -3.1], face: [2.4, -1.95] },
    shelf_1: { at: [-3.6, -2.2], face: [-4.6, -2.2] },
    shelf_2: { at: [-3.6, 0.35], face: [-4.6, 0.35] },
    shelf_3: { at: [-1.75, -2.6], face: [-1.75, -3.6] },
    display: { at: [-1.9, 1.75], face: [-1.9, 0.75] },
    crates: { at: [2.6, 1.6], face: [3.7, 1.25] },
    stove: { at: [-3.1, 1.9], face: [-4.15, 3.2] },
  },
  lights: [[-1.6, 0.8, 2.8], [2.5, -1.6, 2.8]],
};

const HALL: InteriorSpec = {
  purpose: 'hall',
  floor: 'stone',
  rooms: [
    { id: 'main_hall', name: 'Main hall', at: [0, -0.6], half: [4.0, 5.1] },
    { id: 'archive', name: 'Archive', at: [-5.6, -1.4], half: [1.6, 4.3] },
    { id: 'meeting_room', name: 'Meeting corner', at: [5.6, -2.7], half: [1.6, 3.0] },
  ],
  furniture: [
    { id: 'tower_base', kind: 'tower_base', at: [5.7, 4.52], box: [1.62, 1.62], h: 5 },
    { id: 'lectern', kind: 'lectern', at: [0, -4.15], yaw: 0, box: [0.38, 0.3], h: 1.2 },
    { id: 'archive_shelf_1', kind: 'archive_shelf', at: [-6.92, -2.9], yaw: RIGHT, box: [1.05, 0.28], h: 2.6, v: 0 },
    { id: 'archive_shelf_2', kind: 'archive_shelf', at: [-6.92, -0.2], yaw: RIGHT, box: [1.05, 0.28], h: 2.6, v: 1 },
    { id: 'archive_shelf_3', kind: 'archive_shelf', at: [-6.92, 2.5], yaw: RIGHT, box: [1.05, 0.28], h: 2.6, v: 2 },
    { id: 'notice_board', kind: 'notice_board', at: [7.1, -4.4], yaw: LEFT, h: 2.2 },
    { id: 'meeting_table', kind: 'meeting_table', at: [5.5, -1.8], yaw: 0, box: [1.35, 0.55], h: 0.78 },
    { id: 'banner_1', kind: 'banner', at: [-2.6, -5.62], yaw: 0, h: 3.6, v: 0 },
    { id: 'banner_2', kind: 'banner', at: [2.6, -5.62], yaw: 0, h: 3.6, v: 1 },
    { id: 'plant_1', kind: 'plant', at: [-2.2, 5.2], r: 0.34, h: 1.5, v: 0 },
    { id: 'plant_2', kind: 'plant', at: [2.3, 5.2], r: 0.34, h: 1.5, v: 1 },
    { id: 'plant_3', kind: 'plant', at: [-6.75, 5.1], r: 0.34, h: 1.3, v: 2 },
    { id: 'rug', kind: 'rug', at: [0, -0.4], h: 0.02, v: 2 },
  ],
  seats: [
    { id: 'bench_hall_1', kind: 'bench', name: 'Hall bench', style: 'pew', at: [-2.4, -1.2], yaw: BACK },
    { id: 'bench_hall_2', kind: 'bench', name: 'Hall bench', style: 'pew', at: [2.4, -1.2], yaw: BACK },
    { id: 'bench_hall_3', kind: 'bench', name: 'Hall bench', style: 'pew', at: [-2.4, 1.1], yaw: BACK },
    { id: 'bench_hall_4', kind: 'bench', name: 'Hall bench', style: 'pew', at: [2.4, 1.1], yaw: BACK },
    { id: 'chair_hall_meet_1', kind: 'chair', name: 'Chair', style: 'wood_chair', at: [4.85, -2.75], yaw: 0, exit: [4.85, -3.75] },
    { id: 'chair_hall_meet_2', kind: 'chair', name: 'Chair', style: 'wood_chair', at: [6.15, -2.75], yaw: 0, exit: [6.15, -3.75] },
    { id: 'chair_hall_meet_3', kind: 'chair', name: 'Chair', style: 'wood_chair', at: [4.85, -0.85], yaw: BACK, exit: [4.85, 0.15] },
    { id: 'chair_hall_meet_4', kind: 'chair', name: 'Chair', style: 'wood_chair', at: [6.15, -0.85], yaw: BACK, exit: [6.15, 0.15] },
  ],
  anchors: {
    entrance: { at: [0, 4.9], face: [0, 0] },
    lectern: { at: [0, -5.0], face: [0, 0] },
    stage: { at: [-1.2, -4.6], face: [0, 0] },
    audience: { at: [0, 0], face: [0, -4.2] },
    notice_board: { at: [6.1, -4.4], face: [7.2, -4.4] },
    archive: { at: [-5.6, -4.0], face: [-5.6, -4.9] },
    archive_shelves: { at: [-5.9, -0.2], face: [-6.95, -0.2] },
    meeting_table: { at: [5.5, 0.25], face: [5.5, -1.8] },
  },
  platforms: [{ id: 'dais', at: [0, -4.75], half: [2.3, 0.98], h: 0.18 }],
  lights: [[0, -0.5, 4.0], [-5.4, -1.2, 3.6], [5.2, -2.2, 3.6]],
};

const WORKSHOP: InteriorSpec = {
  purpose: 'workshop',
  floor: 'wood',
  rooms: [{ id: 'workshop_floor', name: 'Workshop floor', at: [0, 0], half: [5.4, 4.1] }],
  furniture: [
    { id: 'workbench_1', kind: 'workbench', at: [-2.4, -3.32], yaw: 0, box: [1.25, 0.5], h: 0.92, v: 0 },
    { id: 'workbench_2', kind: 'workbench', at: [1.7, 0.1], yaw: 0, box: [1.25, 0.5], h: 0.92, v: 1 },
    { id: 'tool_wall', kind: 'tool_wall', at: [0.9, -4.12], yaw: 0, h: 2.4 },
    { id: 'kiln', kind: 'kiln', at: [4.35, -3.1], r: 0.9, h: 1.7 },
    { id: 'anvil', kind: 'anvil', at: [2.9, -1.75], yaw: 0.4, box: [0.38, 0.22], h: 0.8 },
    { id: 'lumber_rack', kind: 'lumber_rack', at: [-5.08, 0.6], yaw: RIGHT, box: [1.45, 0.34], h: 1.9 },
    { id: 'boat_frame', kind: 'boat_frame', at: [-2.6, 2.2], yaw: 0, box: [1.55, 0.62], h: 0.95 },
    { id: 'crates', kind: 'crate_stack', at: [4.8, 3.4], yaw: -0.2, box: [0.55, 0.45], h: 0.9 },
    { id: 'barrel', kind: 'barrel', at: [4.95, 1.9], r: 0.38, h: 0.95 },
    { id: 'rug', kind: 'rug', at: [1.6, 2.4], h: 0.02, v: 3 },
  ],
  seats: [
    { id: 'stool_workshop_1', kind: 'chair', name: 'Stool', style: 'stool', at: [-1.7, -2.4], yaw: BACK, exit: [-0.8, -2.2] },
    { id: 'stool_workshop_2', kind: 'chair', name: 'Stool', style: 'stool', at: [1.3, 1.05], yaw: BACK, exit: [0.2, 1.3] },
  ],
  anchors: {
    entrance: { at: [0, 3.3], face: [0, 0] },
    workbench_1: { at: [-2.9, -2.35], face: [-2.9, -3.3] },
    workbench_2: { at: [2.4, 1.1], face: [2.4, 0.1] },
    tool_wall: { at: [0.9, -3.2], face: [0.9, -4.2] },
    kiln: { at: [3.0, -3.0], face: [4.35, -3.1] },
    anvil: { at: [2.9, -0.8], face: [2.9, -1.75] },
    project_1: { at: [-2.6, 3.4], face: [-2.6, 2.2] },
    lumber_rack: { at: [-4.1, 0.6], face: [-5.1, 0.6] },
  },
  lights: [[-2.0, -1.0, 3.2], [2.4, 0.6, 3.2]],
};

function homeSpec(n: 1 | 2): InteriorSpec {
  const m = n === 1 ? 1 : -1; // house 2 is mirrored
  const X = (x: number): number => x * m;
  const yawM = (y: number): number => (m === 1 ? y : -y);
  return {
    purpose: 'home',
    floor: 'wood',
    rooms: [
      { id: `house_${n}_living`, name: 'Living room', at: [X(1.2), 0.3], half: [2.3, 2.8] },
      { id: `house_${n}_bedroom`, name: 'Bed nook', at: [X(-2.3), -1.4], half: [1.2, 1.7] },
    ],
    furniture: [
      { id: 'bed', kind: 'bed', at: [X(-2.55), -2.0], yaw: 0, box: [0.82, 1.05], h: 0.7, v: n },
      { id: 'dresser', kind: 'dresser', at: [X(-3.22), 0.75], yaw: yawM(RIGHT), box: [0.55, 0.26], h: 1.0, v: n },
      { id: 'hearth', kind: 'hearth', at: [X(1.7), -2.82], yaw: 0, box: [0.85, 0.32], h: 1.6, v: n },
      { id: 'kitchen', kind: 'kitchen', at: [X(3.18), 1.0], yaw: yawM(LEFT), box: [0.95, 0.32], h: 0.95, v: n },
      { id: 'table', kind: 'dining_table', at: [X(0.9), 1.25], r: 0.5, h: 0.76, v: n },
      { id: 'bookshelf', kind: 'bookshelf', at: [X(-0.45), -2.9], yaw: 0, box: [0.55, 0.2], h: 1.7, v: n },
      { id: 'plant', kind: 'plant', at: [X(-3.1), 2.75], r: 0.28, h: 1.1, v: n },
      { id: 'rug', kind: 'rug', at: [X(0.9), 0.2], h: 0.02, v: 3 + n },
    ],
    seats: [
      { id: `chair_house_${n}_a`, kind: 'chair', name: 'Chair', style: 'wood_chair', at: [X(-0.05), 1.25], yaw: yawM(RIGHT), exit: [X(-0.3), 2.25] },
      { id: `chair_house_${n}_b`, kind: 'chair', name: 'Chair', style: 'wood_chair', at: [X(1.85), 1.25], yaw: yawM(LEFT), exit: [X(1.9), 2.3] },
      { id: `armchair_house_${n}`, kind: 'chair', name: 'Armchair', style: 'armchair', at: [X(1.1), -1.45], yaw: yawM(2.6), exit: [X(0.0), -1.0] },
    ],
    anchors: {
      entrance: { at: [0, 2.5], face: [0, 0] },
      table: { at: [X(0.9), 2.25], face: [X(0.9), 1.25] },
      hearth: { at: [X(1.7), -1.9], face: [X(1.7), -2.85] },
      bed: { at: [X(-1.2), -1.9], face: [X(-2.55), -2.0] },
      kitchen: { at: [X(2.3), 1.0], face: [X(3.3), 1.0] },
      bookshelf: { at: [X(-0.45), -2.0], face: [X(-0.45), -2.9] },
    },
    lights: [[X(0.9), 0.6, 2.6], [X(-2.3), -1.6, 2.5]],
  };
}

const BOATHOUSE: InteriorSpec = {
  purpose: 'boathouse',
  floor: 'wood',
  rooms: [{ id: 'boathouse_floor', name: 'Boathouse', at: [0, 0], half: [2.9, 2.9] }],
  furniture: [
    { id: 'boat', kind: 'boat_frame', at: [-1.15, -0.55], yaw: 0, box: [0.6, 1.6], h: 0.9, v: 1 },
    { id: 'workbench', kind: 'workbench', at: [2.36, -1.2], yaw: LEFT, box: [0.85, 0.42], h: 0.92, v: 2 },
    { id: 'oar_rack', kind: 'oar_rack', at: [-2.62, 1.6], yaw: RIGHT, h: 2.2 },
    { id: 'nets', kind: 'net_wall', at: [0.9, -2.96], yaw: 0, h: 2.2 },
    { id: 'crates', kind: 'crate_stack', at: [2.3, -2.55], yaw: 0.1, box: [0.45, 0.35], h: 0.9 },
    { id: 'barrel', kind: 'barrel', at: [2.45, 2.45], r: 0.36, h: 0.9 },
  ],
  seats: [{ id: 'stool_boathouse', kind: 'chair', name: 'Stool', style: 'stool', at: [1.45, -0.6], yaw: RIGHT, exit: [1.0, 0.45] }],
  anchors: {
    entrance: { at: [0, 2.4], face: [0, 0] },
    boat: { at: [0.05, -0.4], face: [-1.15, -0.5] },
    workbench: { at: [1.45, -1.7], face: [2.4, -1.7] },
    nets: { at: [0.9, -2.0], face: [0.9, -3.0] },
  },
  lights: [[0, -0.2, 2.6]],
};

const SPECS: Record<string, InteriorSpec> = {
  cafe: CAFE,
  general_store: STORE,
  town_hall: HALL,
  workshop: WORKSHOP,
  house_1: homeSpec(1),
  house_2: homeSpec(2),
  boathouse: BOATHOUSE,
};

// ---------------------------------------------------------------------------
// Build world-space descriptions
// ---------------------------------------------------------------------------

function zone(b: Building, at: L, half: L, localYaw = 0): RectZone {
  return { center: buildingLocal(b, at[0], at[1]), halfWidth: half[0], halfDepth: half[1], yaw: b.yaw + localYaw };
}

/** Floor height of a building interior: base terrain + plinth. */
export function buildingBaseY(b: Building): number {
  return terrainHeight(b.position.x, b.position.z);
}

function wrapYaw(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Half width of the walkable doorstep ramp (the renderer's ramp slab matches it). */
export function rampHalfWidth(b: Building): number {
  return b.doorWidth / 2 + 0.55;
}
/** Ramp height fades out over this much beside the slab (its stone cheeks). */
export const RAMP_SIDE_BLEND = 0.25;

/** Length of the doorstep ramp from the floor down to the ground. */
export function rampLength(b: Building): number {
  return Math.max(0.9, b.floorLift * 2.6);
}

function buildInterior(b: Building, spec: InteriorSpec): { interior: Interior; seats: InteriorSeatSpec[] } {
  const T = WALL_THICKNESS;
  const baseY = buildingBaseY(b);
  const floorY = baseY + b.floorLift;
  const iw = b.width / 2 - T;
  const id = b.depth / 2 - T;
  const platforms: InteriorPlatform[] = (spec.platforms ?? []).map((p) => ({ id: `${b.id}_${p.id}`, zone: zone(b, p.at, p.half), height: p.h }));
  const yAt = (lx: number, lz: number): number => {
    let y = floorY;
    for (const p of spec.platforms ?? []) {
      if (Math.abs(lx - p.at[0]) <= p.half[0] && Math.abs(lz - p.at[1]) <= p.half[1]) y = Math.max(y, floorY + p.h);
    }
    return y;
  };
  const anchors: Record<string, InteriorAnchor> = {};
  for (const [name, a] of Object.entries(spec.anchors)) {
    const p = buildingLocal(b, a.at[0], a.at[1]);
    const f = buildingLocal(b, a.face[0], a.face[1]);
    anchors[name] = { name, position: p, yaw: Math.atan2(f.x - p.x, f.z - p.z), y: yAt(a.at[0], a.at[1]) };
  }
  const furniture: FurniturePiece[] = spec.furniture.map((f, i) => {
    const localYaw = f.yaw ?? 0;
    const shape: FurnitureShape | null = f.box ? { type: 'box', halfWidth: f.box[0], halfDepth: f.box[1] } : f.r !== undefined ? { type: 'circle', radius: f.r } : null;
    return {
      id: `furn_${b.id}_${f.id ?? `${f.kind}_${i}`}`,
      interiorId: b.id,
      kind: f.kind,
      position: buildingLocal(b, f.at[0], f.at[1]),
      yaw: wrapYaw(b.yaw + localYaw),
      local: { x: f.at[0], z: f.at[1] },
      localYaw,
      shape,
      height: f.h,
      variant: f.v ?? 0,
    };
  });
  const seats: InteriorSeatSpec[] = spec.seats.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    style: s.style,
    interiorId: b.id,
    locationId: b.locationId,
    position: buildingLocal(b, s.at[0], s.at[1]),
    yaw: wrapYaw(b.yaw + s.yaw),
    exit: s.exit ? buildingLocal(b, s.exit[0], s.exit[1]) : buildingLocal(b, s.at[0], s.at[1]),
  }));
  const rl = rampLength(b);
  const door: InteriorDoor = {
    id: b.doorId,
    buildingId: b.id,
    position: buildingLocal(b, 0, b.depth / 2),
    yaw: b.yaw,
    width: b.doorWidth,
    apron: zone(b, [0, b.depth / 2 + DOOR_APRON_DEPTH / 2], [b.doorWidth / 2 + DOOR_APRON_SIDE, DOOR_APRON_DEPTH / 2]),
    inside: buildingLocal(b, 0, id - 0.7),
    outside: buildingLocal(b, 0, b.depth / 2 + rl + 0.6),
  };
  const interior: Interior = {
    id: b.id,
    buildingId: b.id,
    name: b.name,
    locationId: b.locationId,
    purpose: spec.purpose,
    floor: spec.floor,
    footprint: zone(b, [0, 0], [b.width / 2, b.depth / 2]),
    inner: zone(b, [0, 0], [iw, id]),
    floorY,
    baseY,
    wallThickness: T,
    wallHeight: b.height - b.floorLift,
    doors: [door],
    rooms: spec.rooms.map((r) => ({ id: r.id, name: r.name, bounds: zone(b, r.at, r.half) })),
    anchors,
    furniture,
    platforms,
    seatIds: seats.map((s) => s.id),
    lights: spec.lights.map(([x, z, y]) => ({ position: buildingLocal(b, x, z), y, color: '#ffc98a' })),
  };
  return { interior, seats };
}

const BUILT = BUILDINGS.filter((b) => b.enterable).map((b) => {
  const spec = SPECS[b.id];
  if (!spec) throw new Error(`Enterable building ${b.id} has no interior spec`);
  return buildInterior(b, spec);
});

/** Every walk-in interior (one per enterable building). */
export const INTERIORS: readonly Interior[] = BUILT.map((x) => x.interior);
/** Indoor seats; interactables.ts turns them into chair / bench interactables. */
export const INTERIOR_SEATS: readonly InteriorSeatSpec[] = BUILT.flatMap((x) => x.seats);
/** All indoor furniture (colliders derive from `shape`). */
export const FURNITURE: readonly FurniturePiece[] = INTERIORS.flatMap((i) => i.furniture);

const BY_ID = new Map(INTERIORS.map((i) => [i.id, i]));
export function getInterior(id: string): Interior | undefined {
  return BY_ID.get(id);
}

/** Named anchor of an interior (throws on typos so activities fail loudly in tests). */
export function interiorAnchor(interiorId: string, name: string): InteriorAnchor {
  const a = BY_ID.get(interiorId)?.anchors[name];
  if (!a) throw new Error(`Unknown interior anchor ${interiorId}.${name}`);
  return a;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** p in a zone's local frame (inverse of rotateOffset). */
export function zoneLocal(z: RectZone, p: Vec2): Vec2 {
  const dx = p.x - z.center.x;
  const dz = p.z - z.center.z;
  const c = Math.cos(z.yaw);
  const s = Math.sin(z.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

export function zoneContains(z: RectZone, p: Vec2, margin = 0): boolean {
  const l = zoneLocal(z, p);
  return Math.abs(l.x) <= z.halfWidth + margin && Math.abs(l.z) <= z.halfDepth + margin;
}

/** The four corners of a zone (world), counter-clockwise from local (-x, -z). */
export function zoneCorners(z: RectZone): Vec2[] {
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => {
    const o = rotateOffset({ x: sx! * z.halfWidth, z: sz! * z.halfDepth }, z.yaw);
    return { x: z.center.x + o.x, z: z.center.z + o.z };
  });
}

/** Interior whose outer walls contain p (doorway threshold included), or null when outdoors. */
export function interiorAt(p: Vec2, margin = 0): Interior | null {
  for (const i of INTERIORS) if (zoneContains(i.footprint, p, margin)) return i;
  return null;
}

// Inside a building you are always "at" its location (back corners may poke past the location radius).
setInteriorLocator((p) => interiorAt(p)?.locationId ?? null);

/** "Space" id of a point: the interior id, or 'outdoors'. */
export function spaceAt(p: Vec2): string {
  return interiorAt(p)?.id ?? 'outdoors';
}

/**
 * Whether something at `target` may be used from `from`: both indoors in the same
 * building or both outdoors (no interacting through walls). Doors work from either side.
 */
export function sameSpace(from: Vec2, target: Vec2, targetIsDoor = false): boolean {
  if (targetIsDoor) return true;
  return spaceAt(from) === spaceAt(target);
}

// ---------------------------------------------------------------------------
// Floor heights (used by groundHeight)
// ---------------------------------------------------------------------------

interface FloorCache {
  i: Interior;
  b: Building;
  c: number;
  s: number;
  r2: number;
  hw: number;
  hd: number;
  ramp: number;
  rampHalf: number;
  platforms: { cx: number; cz: number; hx: number; hz: number; h: number }[];
}
let floorCache: FloorCache[] | null = null;
function floors(): FloorCache[] {
  if (floorCache) return floorCache;
  floorCache = INTERIORS.map((i) => {
    const b = BUILDINGS.find((x) => x.id === i.buildingId)!;
    const ramp = rampLength(b);
    const spec = SPECS[b.id]!;
    return {
      i,
      b,
      c: Math.cos(b.yaw),
      s: Math.sin(b.yaw),
      r2: (Math.hypot(b.width / 2, b.depth / 2 + ramp) + 0.8) ** 2,
      hw: b.width / 2,
      hd: b.depth / 2,
      ramp,
      rampHalf: rampHalfWidth(b),
      platforms: (spec.platforms ?? []).map((p) => ({ cx: p.at[0], cz: p.at[1], hx: p.half[0], hz: p.half[1], h: p.h })),
    };
  });
  return floorCache;
}

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Floor height at (x, z) if it is inside an enterable building or on its
 * doorstep ramp, else null (ground.ts then uses decks / terrain).
 * `terrain` is the terrain height there (passed in to avoid recomputing).
 */
export function floorHeightAt(x: number, z: number, terrain: () => number): number | null {
  for (const f of floors()) {
    const dx = x - f.b.position.x;
    const dz = z - f.b.position.z;
    if (dx * dx + dz * dz > f.r2) continue;
    const lx = dx * f.c - dz * f.s;
    const lz = dx * f.s + dz * f.c;
    if (Math.abs(lx) <= f.hw && Math.abs(lz) <= f.hd) {
      let y = f.i.floorY;
      for (const p of f.platforms) {
        const ex = Math.abs(lx - p.cx) - p.hx;
        const ez = Math.abs(lz - p.cz) - p.hz;
        const e = Math.max(ex, ez);
        if (e < 0.18) y = Math.max(y, f.i.floorY + p.h * (1 - sstep(-0.02, 0.18, e)));
      }
      return y;
    }
    // Doorstep ramp: floor at the wall face → ground over `ramp` metres, blended at its sides.
    const v = lz - f.hd;
    if (v > 0 && v < f.ramp + 0.01) {
      const side = 1 - sstep(f.rampHalf, f.rampHalf + RAMP_SIDE_BLEND, Math.abs(lx));
      if (side > 0) {
        const t = terrain();
        const ramp = f.i.floorY + (t - f.i.floorY) * Math.min(1, v / f.ramp);
        return t + (ramp - t) * side;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Protected zones (player building must keep these clear)
// ---------------------------------------------------------------------------

export interface ProtectedZone extends RectZone {
  id: string;
  kind: 'building' | 'door_apron';
  buildingId: string;
}

/**
 * Footprint of EVERY building (enterable or not) plus the apron in front of
 * each door (DOOR_APRON_DEPTH deep, door width + 2·DOOR_APRON_SIDE wide).
 */
export const PROTECTED_ZONES: readonly ProtectedZone[] = BUILDINGS.flatMap((b): ProtectedZone[] => [
  { id: `zone_${b.id}`, kind: 'building', buildingId: b.id, ...zone(b, [0, 0], [b.width / 2, b.depth / 2]) },
  { id: `zone_${b.id}_door`, kind: 'door_apron', buildingId: b.id, ...zone(b, [0, b.depth / 2 + DOOR_APRON_DEPTH / 2], [b.doorWidth / 2 + DOOR_APRON_SIDE, DOOR_APRON_DEPTH / 2]) },
]);

/** First protected zone containing p (grown by `margin`), or null. */
export function protectedZoneAt(p: Vec2, margin = 0): ProtectedZone | null {
  for (const z of PROTECTED_ZONES) if (zoneContains(z, p, margin)) return z;
  return null;
}

/** Wall segments of an enterable building in its local frame: [centre, half extents]. Shared with the renderer. */
export function wallSegments(b: Building): { face: 'front' | 'back' | 'left' | 'right'; at: L; half: L }[] {
  const T = WALL_THICKNESS;
  const hw = b.width / 2;
  const hd = b.depth / 2;
  const gap = b.doorWidth / 2;
  const sideLen = hw - gap;
  return [
    { face: 'back', at: [0, -hd + T / 2], half: [hw, T / 2] },
    { face: 'left', at: [-hw + T / 2, 0], half: [T / 2, hd] },
    { face: 'right', at: [hw - T / 2, 0], half: [T / 2, hd] },
    { face: 'front', at: [-(gap + sideLen / 2), hd - T / 2], half: [sideLen / 2, T / 2] },
    { face: 'front', at: [gap + sideLen / 2, hd - T / 2], half: [sideLen / 2, T / 2] },
  ];
}
