/**
 * Spawn points: a ring around the fountain in Town Square, facing outwards
 * toward the camera-ish side. Server picks one (see pickSpawnPoint) and then
 * nudges to the nearest walkable free spot.
 */
import { yawFromDirection, type Vec2 } from '../math.js';

export interface SpawnPoint {
  id: string;
  position: Vec2;
  yaw: number;
}

const CENTER: Vec2 = { x: 0, z: 2 };
// Angles chosen between the square's benches and path mouths.
const ANGLES_DEG = [-150, -90, -30, 20, 80, 140, 200, 250];

export const SPAWN_POINTS: readonly SpawnPoint[] = ANGLES_DEG.map((deg, i) => {
  const a = (deg * Math.PI) / 180;
  const position = { x: CENTER.x + Math.cos(a) * 5.2, z: CENTER.z + Math.sin(a) * 5.2 };
  return { id: `spawn_${i + 1}`, position, yaw: yawFromDirection(position.x - CENTER.x, position.z - CENTER.z) };
});

/** Deterministic pick given an index (e.g. join counter); wraps around. */
export function pickSpawnPoint(index: number): SpawnPoint {
  const n = SPAWN_POINTS.length;
  return SPAWN_POINTS[((index % n) + n) % n]!;
}
