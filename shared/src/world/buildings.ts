/**
 * Buildings: footprints (become box colliders), style hints for the procedural
 * renderer, and their front door. A building's "front" is its local +Z
 * (forward(yaw)); the door sits centred on the front face.
 */
import { rotateOffset, yawFromDirection, type Vec2 } from '../math.js';
import type { LocationId } from './locations.js';

export type BuildingStyle = 'cafe' | 'store' | 'hall' | 'workshop' | 'cottage' | 'boathouse';

export interface Building {
  id: string;
  name: string;
  locationId: LocationId;
  style: BuildingStyle;
  position: Vec2;
  yaw: number;
  /** Local X extent. */
  width: number;
  /** Local Z extent. */
  depth: number;
  /** Wall height (roof sits above). */
  height: number;
  /** Palette hints (CSS hex) — the renderer may tune. */
  wallColor: string;
  roofColor: string;
  /** Id of the door interactable on the front face. */
  doorId: string;
  /** Optional tower (Town Hall bell tower). */
  tower?: { height: number; size: number };
}

const facing = (from: Vec2, to: Vec2): number => yawFromDirection(to.x - from.x, to.z - from.z);

const RES_CENTER: Vec2 = { x: -36, z: 18 };

function cottage(n: number, position: Vec2, wallColor: string, roofColor: string, faceTo: Vec2 = RES_CENTER): Building {
  return {
    id: `house_${n}`,
    name: `House ${n}`,
    locationId: 'residential',
    style: 'cottage',
    position,
    yaw: facing(position, faceTo),
    width: 6,
    depth: 5.5,
    height: 3.4,
    wallColor,
    roofColor,
    doorId: `door_house_${n}`,
  };
}

export const BUILDINGS: readonly Building[] = [
  {
    id: 'cafe',
    name: 'The Café',
    locationId: 'cafe',
    style: 'cafe',
    position: { x: 23, z: -13.5 },
    // Faces south-south-west (door, awning and terrace visible from the isometric camera), towards Café Walk.
    yaw: facing({ x: 23, z: -13.5 }, { x: 19.5, z: -3.5 }),
    width: 8,
    depth: 6,
    height: 4,
    wallColor: '#e8d8bd',
    roofColor: '#b0563d',
    doorId: 'door_cafe',
  },
  {
    id: 'general_store',
    name: 'General Store',
    locationId: 'general_store',
    style: 'store',
    position: { x: -22.5, z: -10 },
    yaw: facing({ x: -22.5, z: -10 }, { x: 0, z: 2 }),
    width: 8,
    depth: 6.5,
    height: 4,
    wallColor: '#c9b48e',
    roofColor: '#5f6f5a',
    doorId: 'door_store',
  },
  {
    id: 'town_hall',
    name: 'Town Hall',
    locationId: 'town_hall',
    style: 'hall',
    position: { x: 2, z: -27.5 },
    yaw: 0,
    width: 13,
    depth: 9,
    height: 5.5,
    wallColor: '#ddd2c0',
    roofColor: '#6a5a6e',
    doorId: 'door_hall',
    tower: { height: 10, size: 3.2 },
  },
  {
    id: 'workshop',
    name: 'The Workshop',
    locationId: 'workshop',
    style: 'workshop',
    position: { x: 34.5, z: 11 },
    // Faces south-south-west so its big doors read from the isometric camera.
    yaw: facing({ x: 34.5, z: 11 }, { x: 31, z: 22 }),
    width: 9,
    depth: 7,
    height: 4.2,
    wallColor: '#a7856a',
    roofColor: '#4d4a47',
    doorId: 'door_workshop',
  },
  cottage(1, { x: -29, z: 5.5 }, '#e9d6c4', '#a65e4b'),
  cottage(2, { x: -40.5, z: 6 }, '#d7dccb', '#5f7c74'),
  cottage(3, { x: -48, z: 15 }, '#efe0b9', '#8a6a4a'),
  // Houses 4 and 5 turn their fronts towards the south/east so doors read from the isometric camera.
  cottage(4, { x: -46.5, z: 26 }, '#d9c6d0', '#6b5568', { x: -36, z: 30 }),
  cottage(5, { x: -35.5, z: 30.5 }, '#cfd8dd', '#58697a', { x: -28, z: 38 }),
  {
    id: 'boathouse',
    name: 'Boathouse',
    locationId: 'waterfront',
    style: 'boathouse',
    position: { x: 4, z: 45 },
    yaw: Math.PI / 2,
    width: 6,
    depth: 5,
    height: 3.2,
    wallColor: '#8fa3a8',
    roofColor: '#3f4e57',
    doorId: 'door_boathouse',
  },
];

/** World position of a point given in a building's local frame (+Z = out of the front face). */
export function buildingLocal(b: Building, lx: number, lz: number): Vec2 {
  const o = rotateOffset({ x: lx, z: lz }, b.yaw);
  return { x: b.position.x + o.x, z: b.position.z + o.z };
}

/** Door position: just outside the front face. */
export function doorPosition(b: Building): Vec2 {
  return buildingLocal(b, 0, b.depth / 2 + 0.05);
}

export function getBuilding(id: string): Building {
  const b = BUILDINGS.find((x) => x.id === id);
  if (!b) throw new Error(`Unknown building ${id}`);
  return b;
}
