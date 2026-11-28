/**
 * TRANSIENT per-frame data. Not React state: mutate in place, read inside
 * useFrame. Nothing here triggers re-renders.
 *
 *  - localPlayer: written by player/ (prediction) and net/ (corrections),
 *    read by camera rig, audio listener, interaction targeting, debug hook.
 *  - remotes: snapshot buffers written by net/, sampled by the remote player
 *    renderer via sampleRemote().
 */
import type { AnimState, LocomotionAnim } from '@elsewhere/shared';

export interface LocalPlayerRuntime {
  ready: boolean;
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Locomotion anim predicted locally. */
  anim: LocomotionAnim;
  /** Last move seq sent. */
  seq: number;
  /** performance.now() of the last correction applied. */
  lastCorrectionAt: number;
  /** Current ground velocity (m/s), written by player/LocalPlayer. */
  vx?: number;
  vz?: number;
  /** |velocity| (m/s). */
  speed?: number;
}

export interface PoseSnapshot {
  /** performance.now() when received. */
  t: number;
  x: number;
  y: number;
  z: number;
  rot: number;
}

export interface RemoteRuntime {
  buffer: PoseSnapshot[];
  anim: AnimState;
  /** Incremented by net/ when a snapshot jumps too far to interpolate (teleport/respawn): renderers snap instead of blending. */
  teleportSeq?: number;
  /** What the remote renderer drew this frame (game/RemotePlayers). Read by overlays, targeting, audio. */
  render?: RemoteRenderState;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  rot: number;
}

/** Rendered pose of a remote this frame (written by game/RemotePlayers). */
export interface RemoteRenderState extends Pose {
  /** Smoothed ground speed (m/s) of the interpolated motion. */
  speed: number;
  /** False until the first sample / while fully faded out. */
  visible: boolean;
}

/**
 * Camera view this frame (written by player/CameraRig). Use it to centre
 * view-dependent work (shadow camera, culling, LOD) on what is actually on
 * screen — in free-camera mode that is NOT the player.
 */
export interface ViewRuntime {
  /** Ground point the camera looks at. */
  focusX: number;
  focusY: number;
  focusZ: number;
  /** Camera orbit yaw (radians, three.js convention; default π/4 = camera at +X+Z). */
  yaw: number;
  /** Effective orthographic zoom (pixels per world unit). */
  zoom: number;
  /** Half the visible ground extent in world units (≈ horizontal, vertical). */
  halfWidth: number;
  halfHeight: number;
  /** True while the free camera is detached from the player. */
  free: boolean;
}

/** A keeper's authoritative pose (net/) and what the renderer drew (activities/Keepers). World characters, not players. */
export interface KeeperRuntime {
  x: number;
  z: number;
  rot: number;
  render?: RemoteRenderState;
}

export const runtime = {
  localPlayer: { ready: false, x: 0, y: 0, z: 0, rot: 0, anim: 'idle', seq: 0, lastCorrectionAt: 0 } as LocalPlayerRuntime,
  remotes: new Map<string, RemoteRuntime>(),
  /** Keepers (activities.ts): positions from room state, NOT players (never in `remotes`). */
  keepers: new Map<string, KeeperRuntime>(),
  view: { focusX: 0, focusY: 0, focusZ: 0, yaw: Math.PI / 4, zoom: 38, halfWidth: 12, halfHeight: 8, free: false } as ViewRuntime,
};

export function resetRuntime(): void {
  Object.assign(runtime.localPlayer, { ready: false, x: 0, y: 0, z: 0, rot: 0, anim: 'idle', seq: 0, lastCorrectionAt: 0 });
  runtime.remotes.clear();
  runtime.keepers.clear();
}
