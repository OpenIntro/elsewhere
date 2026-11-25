/**
 * Footstep timing (pure): cadence from ground speed, step phase accumulation,
 * teleport/stop handling. Unit-tested; used by <AudioDirector/>.
 */
import { CONFIG } from '@elsewhere/shared';

/** Steps per second at a ground speed (walk ≈ 2.3/s, run ≈ 2.9/s). */
export function stepCadence(speed: number): number {
  return Math.min(3.2, 1.6 + 0.22 * speed);
}

export interface StepTracker {
  x: number;
  z: number;
  phase: number;
  init: boolean;
}

/** Advance a footstep tracker; returns true when a step should sound. */
export function advanceSteps(tr: StepTracker, x: number, z: number, dt: number, reportedSpeed?: number): boolean {
  if (!tr.init) {
    Object.assign(tr, { x, z, phase: 0.6, init: true });
    return false;
  }
  const d = Math.hypot(x - tr.x, z - tr.z);
  tr.x = x;
  tr.z = z;
  if (dt <= 0) return false;
  const speed = reportedSpeed ?? d / dt;
  if (d / dt > CONFIG.movement.runSpeed * 3) return false; // teleport / correction snap
  if (speed < 0.6) {
    tr.phase = 0.6; // first step comes quickly when we start moving again
    return false;
  }
  tr.phase += stepCadence(speed) * dt;
  if (tr.phase >= 1) {
    tr.phase -= Math.floor(tr.phase);
    return true;
  }
  return false;
}

