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
/** If the previous sample is older than this when movement resumes, insert a hold sample. */
const STALE_GAP_MS = PATCH_MS * 1.6;

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
  if (last) {
    if (snap.t < last.t) return; // out of order (shouldn't happen with receive stamps)
    if (last.x === snap.x && last.z === snap.z && last.y === snap.y && last.rot === snap.rot) {
      t.confirmedAt = snap.t;
      return;
    }
    const jump = Math.hypot(snap.x - last.x, snap.z - last.z);
    if (jump > TELEPORT_DISTANCE) {
      // Never interpolate across: drop history and start fresh at the new pose.
      for (const s of b) t.pool.push(s);
      b.length = 0;
      r.teleportSeq = (r.teleportSeq ?? 0) + 1;
    } else if (snap.t - last.t > STALE_GAP_MS) {
      // Resumed after standing still: hold the old pose until one patch before this sample.
      const holdT = snap.t - PATCH_MS;
      if (holdT > last.t) {
        const hold = take(t, last);
        hold.t = holdT;
        b.push(hold);
      }
    }
  }
  b.push(take(t, snap));
  t.confirmedAt = snap.t;
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
