/**
 * Feet on the boards: characters standing on a ground-level floor tile or a
 * step are drawn on its top instead of sinking into it. Visual only — the
 * server's movement rules are unchanged (floors and steps never block).
 */
import { groundHeight, walkSurfaceAt } from '@elsewhere/shared';
import { pieces } from './store.js';

export function standHeight(x: number, z: number, ground: number = groundHeight(x, z)): number {
  if (pieces.index.size === 0) return ground;
  const s = walkSurfaceAt(pieces.index, { x, z });
  return s !== null && s > ground ? s : ground;
}
