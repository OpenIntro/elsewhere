/**
 * Click/tap-to-move state: the island NavGrid (built incrementally in the
 * background after load), the active path, and an optional "interact on
 * arrival" target. Module-level, read by LocalPlayer every frame.
 */
import { CONFIG, getInteractable, isSeatInteractable, type Interactable, type Vec2 } from '@elsewhere/shared';
import { runtime } from '../state/runtime.js';
import { NavGrid, findPath, pathLength } from './pathfinding.js';

export type ArrivalAction = { kind: 'interact'; id: string } | { kind: 'player'; sessionId: string } | null;

export interface NavState {
  /** Remaining waypoints (consumed from the front by index). */
  points: Vec2[];
  index: number;
  /** Final destination (marker position). */
  goal: Vec2 | null;
  /** Whether the target was reached exactly (false → walked to nearest reachable point). */
  exact: boolean;
  /** Run along this path (long trips). */
  run: boolean;
  /** Arrival behaviour. */
  onArrive: ArrivalAction;
  /** Stop when within this distance of `arriveNear` (interactables / players). */
  arriveNear: Vec2 | null;
  arriveRadius: number;
  /** Bumped whenever the path changes (marker animation restarts). */
  version: number;
  /** performance.now() of the last request. */
  startedAt: number;
}

export const nav: NavState = {
  points: [],
  index: 0,
  goal: null,
  exact: true,
  run: false,
  onArrive: null,
  arriveNear: null,
  arriveRadius: 0,
  version: 0,
  startedAt: 0,
};

/** Distance beyond which click-to-move automatically runs. */
export const AUTO_RUN_DISTANCE = 12;

let grid: NavGrid | null = null;
export function navGrid(): NavGrid {
  if (!grid) grid = new NavGrid();
  return grid;
}

/** Build the grid a few rows per tick so it is ready before the first click without a hitch. */
export function prebuildNavGrid(): () => void {
  const g = navGrid();
  let cancelled = false;
  const step = () => {
    if (cancelled || g.ready) return;
    const t0 = performance.now();
    while (!g.ready && performance.now() - t0 < 6) g.buildStep(8);
    if (!g.ready) setTimeout(step, 16);
  };
  setTimeout(step, 250);
  return () => {
    cancelled = true;
  };
}

export function hasPath(): boolean {
  return nav.goal !== null;
}

export function cancelPath(): void {
  if (!nav.goal && !nav.onArrive) return;
  nav.points = [];
  nav.index = 0;
  nav.goal = null;
  nav.onArrive = null;
  nav.arriveNear = null;
  nav.version++;
}

/** Walk to a ground point (pathfinding around obstacles). Returns false if no path at all. */
export function walkTo(target: Vec2, opts: { onArrive?: ArrivalAction; arriveNear?: Vec2; arriveRadius?: number; run?: boolean } = {}): boolean {
  const lp = runtime.localPlayer;
  if (!lp.ready) return false;
  const res = findPath(navGrid(), { x: lp.x, z: lp.z }, target);
  if (!res) return false;
  nav.points = res.points;
  nav.index = 0;
  nav.goal = res.goal;
  nav.exact = res.exact;
  nav.onArrive = opts.onArrive ?? null;
  nav.arriveNear = opts.arriveNear ?? null;
  nav.arriveRadius = opts.arriveRadius ?? 0;
  nav.run = opts.run ?? pathLength({ x: lp.x, z: lp.z }, res.points) > AUTO_RUN_DISTANCE;
  nav.version++;
  nav.startedAt = performance.now();
  return true;
}

/** Where to stand to use an interactable (seat front for benches/chairs, else the object itself). */
export function approachPoint(it: Interactable, from: Vec2): Vec2 {
  if (isSeatInteractable(it) && it.seats.length > 0) {
    let best = it.seats[0]!.exit;
    let bestD = Infinity;
    for (const s of it.seats) {
      const d = Math.hypot(s.exit.x - from.x, s.exit.z - from.z);
      if (d < bestD) {
        bestD = d;
        best = s.exit;
      }
    }
    return best;
  }
  return it.position;
}

/** Walk to an interactable and interact on arrival (or immediately if already in range). */
export function walkToInteract(id: string): 'now' | 'walking' | 'failed' {
  const it = getInteractable(id);
  const lp = runtime.localPlayer;
  if (!it || !lp.ready) return 'failed';
  const radius = (it.radius ?? CONFIG.interaction.radius) - 0.35;
  if (Math.hypot(lp.x - it.position.x, lp.z - it.position.z) <= radius) {
    cancelPath();
    return 'now';
  }
  const ok = walkTo(approachPoint(it, { x: lp.x, z: lp.z }), { onArrive: { kind: 'interact', id }, arriveNear: it.position, arriveRadius: radius });
  return ok ? 'walking' : 'failed';
}

/** Walk up to another player and open their context menu on arrival. */
export function walkToPlayer(sessionId: string, at: Vec2): 'now' | 'walking' | 'failed' {
  const lp = runtime.localPlayer;
  if (!lp.ready) return 'failed';
  const radius = 1.8;
  if (Math.hypot(lp.x - at.x, lp.z - at.z) <= radius) {
    cancelPath();
    return 'now';
  }
  const ok = walkTo(at, { onArrive: { kind: 'player', sessionId }, arriveNear: at, arriveRadius: radius });
  return ok ? 'walking' : 'failed';
}
