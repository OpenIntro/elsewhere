/**
 * Keeper simulation (server-authoritative, per room instance). Keepers are
 * WORLD characters: they live in `state.keepers`, never in `state.players`,
 * have no profile, never chat and never appear in World Memory.
 *
 * While their building is open (shared clock, activities.ts OPENING_HOURS)
 * a keeper walks its cyclic route of stops (straight, collision-checked
 * segments — see shared/test/activities.test.ts), dwelling at each with a
 * task ("wiping the counter") and a busy gesture. When the building closes
 * they go off duty (present = false; clients fade them out). `attend` makes a
 * keeper turn to a customer for a moment (taking an order).
 */
import { KEEPER_WALK_SPEED, KEEPERS, buildingLocal, getBuilding, interiorAnchor, isOpenAt, yawFromDirection, type KeeperDef, type Vec2 } from '@elsewhere/shared';
import type { KeeperState } from '../rooms/schema.js';

interface Stop {
  pos: Vec2;
  yaw: number;
  task: string;
  dwell: readonly [number, number];
  busy: boolean;
}

export interface KeeperSim {
  def: KeeperDef;
  stops: Stop[];
  index: number;
  mode: 'dwell' | 'walk';
  /** Server ms when the current dwell ends. */
  until: number;
  /** Next busy-gesture restart. */
  gestureAt: number;
  /** Attending a customer until this time (overrides the route). */
  attendUntil: number;
}

function stopsFor(def: KeeperDef): Stop[] {
  const b = getBuilding(def.interiorId);
  return def.route.map((s) => {
    const anchor = s.anchor ? interiorAnchor(def.interiorId, s.anchor) : null;
    const pos = anchor ? anchor.position : buildingLocal(b, s.at![0], s.at![1]);
    let yaw = anchor?.yaw ?? 0;
    if (s.face) {
      const f = buildingLocal(b, s.face[0], s.face[1]);
      yaw = yawFromDirection(f.x - pos.x, f.z - pos.z);
    }
    return { pos, yaw, task: s.task, dwell: s.dwell, busy: !!s.busy };
  });
}

export function createKeeperSims(now: number): KeeperSim[] {
  return KEEPERS.map((def) => ({ def, stops: stopsFor(def), index: 0, mode: 'dwell', until: now, gestureAt: now, attendUntil: 0 }));
}

const rand = (r: () => number, [a, b]: readonly [number, number]) => a + (b - a) * r();

/**
 * Advance one keeper. `hours` = world hours; `state` = its synced KeeperState.
 * Pure apart from mutating `sim` / `state`; `random` is injectable for tests.
 */
export function stepKeeper(sim: KeeperSim, state: KeeperState, hours: number, now: number, dtMs: number, random: () => number = Math.random): void {
  const open = isOpenAt(sim.def.interiorId, hours);
  if (!open) {
    if (state.present) {
      state.present = false;
      state.anim = 'idle';
      state.task = 'off duty';
    }
    // Reset so the next shift starts at the first stop.
    const home = sim.stops[0]!;
    sim.index = 0;
    sim.mode = 'dwell';
    sim.until = now;
    if (state.x !== home.pos.x || state.z !== home.pos.z) {
      state.x = home.pos.x;
      state.z = home.pos.z;
      state.rot = home.yaw;
    }
    return;
  }
  if (!state.present) {
    const home = sim.stops[0]!;
    state.present = true;
    state.x = home.pos.x;
    state.z = home.pos.z;
    state.rot = home.yaw;
    sim.index = 0;
    sim.mode = 'dwell';
    sim.until = now + rand(random, home.dwell) * 1000;
    state.task = home.task;
    state.anim = home.busy ? 'interact' : 'idle';
  }
  if (sim.attendUntil > now) return; // turned towards a customer; resumes afterwards
  const stop = sim.stops[sim.index]!;
  if (sim.mode === 'dwell') {
    if (state.task !== stop.task) state.task = stop.task;
    if (stop.busy && now >= sim.gestureAt) {
      state.anim = 'interact';
      state.animSeq = (state.animSeq + 1) % 65536;
      sim.gestureAt = now + 2600 + random() * 2400;
    } else if (!stop.busy && state.anim !== 'idle') state.anim = 'idle';
    if (now >= sim.until) {
      sim.index = (sim.index + 1) % sim.stops.length;
      sim.mode = 'walk';
      state.anim = 'walk';
    }
    return;
  }
  // Walking to the next stop.
  const next = sim.stops[sim.index]!;
  const dx = next.pos.x - state.x;
  const dz = next.pos.z - state.z;
  const d = Math.hypot(dx, dz);
  const step = (KEEPER_WALK_SPEED * dtMs) / 1000;
  if (d <= step) {
    state.x = next.pos.x;
    state.z = next.pos.z;
    state.rot = next.yaw;
    state.anim = next.busy ? 'interact' : 'idle';
    state.task = next.task;
    sim.mode = 'dwell';
    sim.until = now + rand(random, next.dwell) * 1000;
    sim.gestureAt = now + 600;
    return;
  }
  state.x += (dx / d) * step;
  state.z += (dz / d) * step;
  state.rot = yawFromDirection(dx, dz);
  if (state.anim !== 'walk') state.anim = 'walk';
  if (state.task !== 'on the way') state.task = 'on the way';
}

/** Turn a keeper towards `at` for `ms` with a busy gesture (e.g. making a drink). */
export function attend(sim: KeeperSim, state: KeeperState, at: Vec2, task: string, now: number, ms = 2600): void {
  if (!state.present) return;
  state.rot = yawFromDirection(at.x - state.x, at.z - state.z);
  state.anim = 'interact';
  state.animSeq = (state.animSeq + 1) % 65536;
  state.task = task;
  sim.attendUntil = now + ms;
  if (sim.mode === 'dwell') sim.until = Math.max(sim.until, now + ms + 1500);
}
