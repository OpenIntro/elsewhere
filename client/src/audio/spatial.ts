/**
 * Lightweight spatialisation: distance gain + stereo pan relative to the
 * isometric camera. Cheaper than HRTF PannerNodes and plenty for a top-down view.
 *
 * Camera yaw convention: the yaw of the camera's horizontal offset from its
 * focus point, i.e. offset direction = (sin yaw, cos yaw). The foundation's
 * CameraRig sits at (+30, +30, +30) → yaw = π/4 and never rotates. If a later
 * camera writes `runtime.camera.yaw` we honour it (see getCameraYaw).
 */
import type { Vec2 } from '@elsewhere/shared';

export const DEFAULT_CAMERA_YAW = Math.PI / 4;

export interface SpatialOptions {
  /** Distance at/below which gain is 1. */
  ref?: number;
  /** Distance at which the sound is fully inaudible. */
  max?: number;
  rolloff?: number;
}

export interface SpatialResult {
  gain: number;
  /** -1 (screen left) .. +1 (screen right). */
  pan: number;
  distance: number;
}

/** Screen-right unit vector on the ground plane for a camera yaw. */
export function screenRight(cameraYaw: number): Vec2 {
  return { x: Math.cos(cameraYaw), z: -Math.sin(cameraYaw) };
}

export function spatialize(listener: Vec2, source: Vec2, cameraYaw = DEFAULT_CAMERA_YAW, opts: SpatialOptions = {}): SpatialResult {
  const ref = opts.ref ?? 4;
  const max = opts.max ?? 40;
  const rolloff = opts.rolloff ?? 1;
  const dx = source.x - listener.x;
  const dz = source.z - listener.z;
  const d = Math.hypot(dx, dz);
  if (!Number.isFinite(d) || d >= max) return { gain: 0, pan: 0, distance: Number.isFinite(d) ? d : Infinity };
  let gain = ref / (ref + rolloff * Math.max(0, d - ref));
  // Smooth fade to zero over the last 40% of the range (no hard edge).
  const fadeStart = max * 0.6;
  if (d > fadeStart) {
    const f = 1 - (d - fadeStart) / (max - fadeStart);
    gain *= f * f;
  }
  const r = screenRight(cameraYaw);
  const lateral = (dx * r.x + dz * r.z) / Math.max(d, 1);
  // Close sources stay near the centre; keep a little of both ears always.
  const pan = Math.max(-1, Math.min(1, lateral * 0.8 * Math.min(1, d / 2.5)));
  return { gain: Math.max(0, Math.min(1, gain)), pan, distance: d };
}

/** Linear 1 inside `inner`, 0 beyond `outer`, cosine-smoothed between. */
export function falloff(d: number, inner: number, outer: number): number {
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const t = (d - inner) / (outer - inner);
  return 0.5 + 0.5 * Math.cos(t * Math.PI);
}
