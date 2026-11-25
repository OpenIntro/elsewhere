/**
 * Remote-player snapshot interpolation, tuned for 20 Hz schema patches.
 *
 *  - pushSnapshot(): timestamped (receive-time) poses into a short ordered
 *    buffer per remote. Snapshot objects are recycled (no steady-state
 *    allocation). Unchanged poses only refresh a "still here" time; when a
 *    player starts moving after standing still a synthetic hold sample is
 *    inserted one patch interval earlier so motion does not creep in over
 *    the whole idle period.
 *  - Large jumps (faster than anyone can run between two patches) bump
 *    `teleportSeq` and are never interpolated across: the sampler snaps.
 *  - sampleBuffer(): renders `interpolationDelayMs` in the past, lerping
 *    between the bracketing pair; past the newest sample it extrapolates
 *    along the last velocity for at most EXTRAPOLATE_MS (only while the
 *    remote is in a locomotion anim), then holds.
 */
import { CONFIG, angleDelta } from '@elsewhere/shared';
import { runtime, type Pose, type PoseSnapshot, type RemoteRuntime } from '../state/runtime.js';

const MAX_BUFFER = 24;
const PATCH_MS = 1000 / CONFIG.network.patchRateHz;
/** Max time we extrapolate past the newest snapshot. */
export const EXTRAPOLATE_MS = 100;
/** A jump larger than this between consecutive snapshots is a teleport. */
export const TELEPORT_DISTANCE = 4;
/** Minimum spacing between consecutive snapshot stamps (bunched arrivals are spread out). */
const MIN_SPACING_MS = PATCH_MS * 0.9;
/** A smoothed stamp may run at most this far ahead of the real receive time. */
const MAX_LEAD_MS = PATCH_MS * 6;
/** Segments may not imply moving faster than gait speed × this (see pushInto). */
const MAX_SPEED_FACTOR = 1.25;
/** Identical patches for at least this long mean the remote was standing still. */
const STILL_CONFIRM_MS = PATCH_MS * 2.5;
/** No update at all for this long (moving senders send at 15 Hz) also means it had stopped. */
const QUIET_GAP_MS = 400;

/** Extra bookkeeping kept alongside RemoteRuntime (module private). */
interface Track {
  pool: PoseSnapshot[];
  /** Last time a patch confirmed the newest pose is still current. */
  confirmedAt: number;
}
const tracks = new WeakMap<RemoteRuntime, Track>();

function trackOf(r: RemoteRuntime): Track {
  let t = tracks.get(r);
  if (!t) tracks.set(r, (t = { pool: [], confirmedAt: 0 }));
  return t;
}

function take(t: Track, src: PoseSnapshot): PoseSnapshot {
  const s = t.pool.pop() ?? { t: 0, x: 0, y: 0, z: 0, rot: 0 };
  s.t = src.t;
  s.x = src.x;
  s.y = src.y;
  s.z = src.z;
  s.rot = src.rot;
  return s;
}

export function ensureRemote(id: string): RemoteRuntime {
  let r = runtime.remotes.get(id);
  if (!r) runtime.remotes.set(id, (r = { buffer: [], anim: 'idle', teleportSeq: 0 }));
  return r;
}

/** Push a pose received at `snap.t` (performance.now()). `snap` is copied; callers may reuse it. */
export function pushSnapshot(id: string, snap: PoseSnapshot): void {
  pushInto(ensureRemote(id), snap);
}

export function pushInto(r: RemoteRuntime, snap: PoseSnapshot): void {
  const t = trackOf(r);
  const b = r.buffer;
  const last = b[b.length - 1];
  if (!last) {
    const s = take(t, snap);
    b.push(s);
    t.confirmedAt = snap.t;
    return;
  }
  if (last.x === snap.x && last.z === snap.z && last.y === snap.y && last.rot === snap.rot) {
    t.confirmedAt = snap.t;
    return;
  }
  const dist = Math.hypot(snap.x - last.x, snap.z - last.z);
  if (dist > TELEPORT_DISTANCE) {
    // Never interpolate across: drop history and start fresh at the new pose.
    for (const s of b) t.pool.push(s);
    b.length = 0;
    r.teleportSeq = (r.teleportSeq ?? 0) + 1;
    const s = take(t, snap);
    b.push(s);
    t.confirmedAt = snap.t;
    return;
  }
  // Stamp = receive time, adjusted (adaptive jitter buffer, never more than MAX_LEAD_MS ahead of it):
  //  - bunched arrivals (busy main thread → several patches in one batch) are spaced ≥ MIN_SPACING_MS;
  //  - a segment may not imply moving faster than the remote's gait allows (a hitchy SENDER delivers
  //    0.5–1.5 m bursts every few hundred ms): its stamp is pushed later instead, so the motion plays
  //    out at a believable speed. Healthy 15–20 Hz streams never hit either rule.
  const vmax = (r.anim === 'walk' ? CONFIG.movement.walkSpeed : CONFIG.movement.runSpeed) * MAX_SPEED_FACTOR;
  const minDur = (dist / vmax) * 1000;
  const cap = snap.t + MAX_LEAD_MS;
  let stamp = Math.max(snap.t, Math.min(last.t + Math.max(MIN_SPACING_MS, minDur), cap));
  if (stamp <= last.t) stamp = last.t + 1;
  if (t.confirmedAt - last.t >= STILL_CONFIRM_MS || snap.t - Math.max(last.t, t.confirmedAt) > QUIET_GAP_MS) {
    // Resumed after standing still (identical patches confirmed it for a while, or the sender went
    // quiet): hold the old pose until the move must have started (distance at gait speed, ≥ one patch)
    // instead of creeping over the whole idle period. NOT for ordinary uneven gaps (15 Hz moves in
    // 20 Hz patches, slow senders): those interpolate linearly.
    const holdT = stamp - Math.max(PATCH_MS, minDur);
    if (holdT > last.t) {
      const hold = take(t, last);
      hold.t = holdT;
      b.push(hold);
    }
  }
  const s = take(t, snap);
  s.t = stamp;
  b.push(s);
  t.confirmedAt = stamp;
  while (b.length > MAX_BUFFER) t.pool.push(b.shift()!);
}

export function removeRemote(id: string): void {
  runtime.remotes.delete(id);
}

function copyPose(out: Pose, s: PoseSnapshot): void {
  out.x = s.x;
  out.y = s.y;
  out.z = s.z;
  out.rot = s.rot;
}

/** Sample a buffer at renderTime (performance.now() based). Writes into `out`. Returns false if no data. */
export function sampleBuffer(r: RemoteRuntime, renderTime: number, out: Pose): boolean {
  const b = r.buffer;
  const n = b.length;
  if (n === 0) return false;
  const first = b[0]!;
  if (n === 1 || renderTime <= first.t) {
    copyPose(out, first);
    return true;
  }
  const newest = b[n - 1]!;
  if (renderTime >= newest.t) {
    copyPose(out, newest);
    const ahead = renderTime - newest.t;
    const prev = b[n - 2]!;
    const span = newest.t - prev.t;
    const locomotion = r.anim === 'walk' || r.anim === 'run';
    if (locomotion && ahead > 0 && span > 0 && span < PATCH_MS * 3) {
      const k = Math.min(ahead, EXTRAPOLATE_MS) / span;
      out.x += (newest.x - prev.x) * k;
      out.z += (newest.z - prev.z) * k;
      out.y += (newest.y - prev.y) * k;
    }
    return true;
  }
  // Bracketing pair: scan from the newest end (renderTime is usually near it).
  for (let i = n - 1; i > 0; i--) {
    const a = b[i - 1]!;
    if (renderTime >= a.t) {
      const c = b[i]!;
      const t = (renderTime - a.t) / Math.max(1, c.t - a.t);
      out.x = a.x + (c.x - a.x) * t;
      out.y = a.y + (c.y - a.y) * t;
      out.z = a.z + (c.z - a.z) * t;
      out.rot = a.rot + angleDelta(a.rot, c.rot) * t;
      return true;
    }
  }
  copyPose(out, first);
  return true;
}

/** Interpolated pose of a remote player for this frame. */
export function sampleRemote(id: string, out: Pose, now = performance.now()): boolean {
  const r = runtime.remotes.get(id);
  if (!r) return false;
  return sampleBuffer(r, now - CONFIG.network.interpolationDelayMs, out);
}
