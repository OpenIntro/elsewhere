/**
 * Which pieces of the built room the local player stands in open up (pure; no
 * three.js): the walls whose outside faces the camera drop to stubs, the
 * mounts hung on those walls go with them, everything above the player's
 * storey goes. Far walls and everything on the floor stay as they are.
 */
import { PIECES, type Enclosure, type PieceIndex, type PieceLike, type Vec2 } from '@elsewhere/shared';

/** Stub height of a cut wall above its base (matches the town's walk-in cutaway). */
export const CUT_STUB = 0.95;
/** A wall faces the camera when its outward normal points this much towards it (cos ≈ 75°). */
const FACING = 0.26;

/** Horizontal unit direction from the camera focus towards the camera (camera sits at +(sin yaw, cos yaw)). */
export function cameraDir(yaw: number): Vec2 {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/**
 * The room's walls facing the camera at `yaw`: outline walls with an outward
 * normal towards the camera, plus partitions standing between the player and
 * the camera (when `player` is given). Sorted ids.
 */
export function cameraFacingWalls(e: Pick<Enclosure, 'walls' | 'inner'>, yaw: number, index?: PieceIndex<PieceLike>, player?: Vec2): string[] {
  const c = cameraDir(yaw);
  const out: string[] = [];
  for (const w of e.walls) if (w.normals.some((n) => n.x * c.x + n.z * c.z > FACING)) out.push(w.id);
  if (index && player) {
    for (const w of e.inner) {
      const p = index.get(w.id);
      if (p && (p.x - player.x) * c.x + (p.z - player.z) * c.z > 0.3) out.push(w.id);
    }
  }
  return out.sort();
}

/** Wall mounts (pictures, shelves, clock, mirror, curtains, name boards) hung on any of these walls. */
export function mountsOn<P extends PieceLike>(index: PieceIndex<P>, wallIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of wallIds) {
    const w = index.get(id);
    if (!w) continue;
    for (const q of index.query({ minX: w.x - 0.05, maxX: w.x + 0.05, minZ: w.z - 0.05, maxZ: w.z + 0.05 }, 1)) {
      if (!PIECES[q.kind].mount || q.level !== w.level || Math.abs(q.x - w.x) > 1e-6 || Math.abs(q.z - w.z) > 1e-6 || q.rot % 2 !== w.rot % 2) continue;
      out.push(q.id);
    }
  }
  return out.sort();
}

export interface CutawayPlan {
  /** Walls cut down to a stub. */
  cut: string[];
  /** Pieces gone entirely: everything above the storey, and the mounts on cut walls. */
  hidden: string[];
}

/** The whole plan for one camera yaw. */
export function planCutaway<P extends PieceLike>(index: PieceIndex<P>, e: Enclosure, yaw: number, player?: Vec2): CutawayPlan {
  const cut = cameraFacingWalls(e, yaw, index as unknown as PieceIndex<PieceLike>, player);
  const hidden = new Set(e.above);
  for (const id of mountsOn(index, cut)) hidden.add(id);
  return { cut, hidden: [...hidden].sort() };
}
