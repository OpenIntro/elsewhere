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
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  rot: number;
}

export const runtime = {
  localPlayer: { ready: false, x: 0, y: 0, z: 0, rot: 0, anim: 'idle', seq: 0, lastCorrectionAt: 0 } as LocalPlayerRuntime,
  remotes: new Map<string, RemoteRuntime>(),
};

export function resetRuntime(): void {
  Object.assign(runtime.localPlayer, { ready: false, x: 0, y: 0, z: 0, rot: 0, anim: 'idle', seq: 0, lastCorrectionAt: 0 });
  runtime.remotes.clear();
}
