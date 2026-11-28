import type { Vec2 } from '../math.js';
import { floorHeightAt } from './interiors.js';
import { deckAt } from './paths.js';
import { terrainHeight, WALKABLE_MIN_HEIGHT, WORLD_BOUNDS } from './terrain.js';

/**
 * Height a character's feet rest at: the floor inside a walk-in building (and
 * its doorstep ramp / low platforms), else a deck surface, else terrain.
 */
export function groundHeight(x: number, z: number): number {
  const floor = floorHeightAt(x, z, () => terrainHeight(x, z));
  if (floor !== null) return floor;
  const deck = deckAt({ x, z });
  return deck ? deck.y : terrainHeight(x, z);
}

/**
 * Whether the ground itself permits standing at p (ignores colliders):
 * inside world bounds and either on a deck or on land above the waterline.
 */
export function isGroundWalkable(p: Vec2): boolean {
  if (p.x < WORLD_BOUNDS.minX || p.x > WORLD_BOUNDS.maxX || p.z < WORLD_BOUNDS.minZ || p.z > WORLD_BOUNDS.maxZ) return false;
  if (deckAt(p)) return true;
  return terrainHeight(p.x, p.z) > WALKABLE_MIN_HEIGHT;
}
