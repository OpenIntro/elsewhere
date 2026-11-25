/**
 * Non-building, non-interactable built features the renderer must draw and
 * collision must respect: the fountain basin, the portal arch, standing
 * stones, café tables, crates, workbench, garden beds.
 */
import { rotateOffset, yawFromDirection, type Vec2 } from '../math.js';
import { buildingLocal, getBuilding } from './buildings.js';
import { CAFE_TABLES, getInteractable } from './interactables.js';

export interface Fountain {
  position: Vec2;
  /** Outer basin radius (collider). */
  basinRadius: number;
  basinHeight: number;
}

export const FOUNTAIN: Fountain = { position: { x: 0, z: 2 }, basinRadius: 3.0, basinHeight: 0.7 };

export interface PortalArch {
  position: Vec2;
  yaw: number;
  /** Distance between the pillar centres. */
  span: number;
  pillarRadius: number;
  height: number;
}

const portal = getInteractable('portal_arch')!;
export const PORTAL_ARCH: PortalArch = { position: portal.position, yaw: portal.yaw, span: 3.4, pillarRadius: 0.55, height: 4.6 };

export function archPillars(a: PortalArch = PORTAL_ARCH): [Vec2, Vec2] {
  const o = rotateOffset({ x: a.span / 2, z: 0 }, a.yaw);
  return [
    { x: a.position.x + o.x, z: a.position.z + o.z },
    { x: a.position.x - o.x, z: a.position.z - o.z },
  ];
}

export interface StandingStone {
  id: string;
  position: Vec2;
  radius: number;
  height: number;
  yaw: number;
  /** Lean in radians, purely visual. */
  lean: number;
}

const UNKNOWN_CENTER: Vec2 = { x: -10, z: -61 };
const ENTRANCE_DEG = 146; // towards the Stone Trail
export const STANDING_STONES: readonly StandingStone[] = Array.from({ length: 7 }, (_, i) => {
  const deg = ENTRANCE_DEG + (i + 1) * (360 / 8);
  const rad = (deg * Math.PI) / 180;
  const position = { x: UNKNOWN_CENTER.x + Math.cos(rad) * 7.6, z: UNKNOWN_CENTER.z + Math.sin(rad) * 7.6 };
  return {
    id: `standing_stone_${i + 1}`,
    position,
    radius: 0.75,
    height: 2.6 + ((i * 37) % 10) / 10,
    yaw: yawFromDirection(UNKNOWN_CENTER.x - position.x, UNKNOWN_CENTER.z - position.z),
    lean: (((i * 53) % 7) - 3) * 0.03,
  };
});

export interface Prop {
  id: string;
  kind: 'cafe_table' | 'crate' | 'workbench' | 'garden_bed' | 'barrel' | 'planter';
  position: Vec2;
  yaw: number;
  /** Collision footprint. */
  shape: { type: 'circle'; radius: number } | { type: 'box'; halfWidth: number; halfDepth: number };
  height: number;
}

/** A point relative to a building's FRONT face: lx along it, dz out from it. */
const front = (b: ReturnType<typeof getBuilding>, lx: number, dz: number): Vec2 => buildingLocal(b, lx, b.depth / 2 + dz);
const store = getBuilding('general_store');
const workshop = getBuilding('workshop');
const cafe = getBuilding('cafe');

export const PROPS: readonly Prop[] = [
  ...CAFE_TABLES.map((t): Prop => ({ id: t.id, kind: 'cafe_table', position: t.position, yaw: 0, shape: { type: 'circle', radius: t.radius }, height: 0.75 })),
  { id: 'crate_store_1', kind: 'crate', position: front(store, 2.35, 0.65), yaw: store.yaw, shape: { type: 'box', halfWidth: 0.5, halfDepth: 0.5 }, height: 0.8 },
  { id: 'barrel_store', kind: 'barrel', position: front(store, -2.4, 0.55), yaw: 0, shape: { type: 'circle', radius: 0.45 }, height: 1 },
  // (The Workshop's workbenches are indoors now: interiors.ts furniture.)
  { id: 'crate_workshop', kind: 'crate', position: front(workshop, 4.6, 0.5), yaw: workshop.yaw + 0.3, shape: { type: 'box', halfWidth: 0.5, halfDepth: 0.5 }, height: 0.8 },
  { id: 'garden_bed', kind: 'garden_bed', position: { x: -36, z: 17 }, yaw: 0, shape: { type: 'box', halfWidth: 2, halfDepth: 1.2 }, height: 0.35 },
  { id: 'planter_cafe_1', kind: 'planter', position: front(cafe, -4.7, 1.8), yaw: cafe.yaw, shape: { type: 'box', halfWidth: 0.4, halfDepth: 0.4 }, height: 0.6 },
  { id: 'planter_cafe_2', kind: 'planter', position: front(cafe, 4.7, 1.8), yaw: cafe.yaw, shape: { type: 'box', halfWidth: 0.4, halfDepth: 0.4 }, height: 0.6 },
];
