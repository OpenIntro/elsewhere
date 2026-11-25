/**
 * Remote-player interpolation: buffer timestamped snapshots, render slightly
 * in the past (CONFIG.network.interpolationDelayMs) and lerp between the two
 * bracketing snapshots. Pure functions over runtime.remotes.
 */
import { CONFIG, angleDelta } from '@elsewhere/shared';
import { runtime, type Pose, type PoseSnapshot, type RemoteRuntime } from '../state/runtime.js';

const MAX_BUFFER = 30;

export function pushSnapshot(id: string, snap: PoseSnapshot): void {
  let r = runtime.remotes.get(id);
  if (!r) runtime.remotes.set(id, (r = { buffer: [], anim: 'idle' }));
  const last = r.buffer[r.buffer.length - 1];
  if (last && last.x === snap.x && last.z === snap.z && last.y === snap.y && last.rot === snap.rot) {
    // Unchanged: refresh timestamp of a "hold" sample so interpolation doesn't stall on old data.
    if (snap.t - last.t > 250) r.buffer.push(snap);
  } else {
    r.buffer.push(snap);
  }
  if (r.buffer.length > MAX_BUFFER) r.buffer.splice(0, r.buffer.length - MAX_BUFFER);
}

export function removeRemote(id: string): void {
  runtime.remotes.delete(id);
}

/** Sample a buffer at renderTime (performance.now() based). Writes into `out`. Returns false if no data. */
export function sampleBuffer(r: RemoteRuntime, renderTime: number, out: Pose): boolean {
  const b = r.buffer;
  if (b.length === 0) return false;
  const first = b[0]!;
  if (b.length === 1 || renderTime <= first.t) {
    Object.assign(out, { x: first.x, y: first.y, z: first.z, rot: first.rot });
    return true;
  }
  for (let i = b.length - 1; i > 0; i--) {
    const a = b[i - 1]!;
    const c = b[i]!;
    if (renderTime >= a.t) {
      if (renderTime >= c.t) {
        Object.assign(out, { x: c.x, y: c.y, z: c.z, rot: c.rot });
        return true;
      }
      const t = (renderTime - a.t) / Math.max(1, c.t - a.t);
      out.x = a.x + (c.x - a.x) * t;
      out.y = a.y + (c.y - a.y) * t;
      out.z = a.z + (c.z - a.z) * t;
      out.rot = a.rot + angleDelta(a.rot, c.rot) * t;
      return true;
    }
  }
  return false;
}

/** Interpolated pose of a remote player for this frame. */
export function sampleRemote(id: string, out: Pose, now = performance.now()): boolean {
  const r = runtime.remotes.get(id);
  if (!r) return false;
  return sampleBuffer(r, now - CONFIG.network.interpolationDelayMs, out);
}
