/**
 * Orthographic isometric camera rig.
 *  - Smooth follow of the local player with a gentle velocity lead and
 *    damping; never lets the player leave the central part of the view.
 *  - Eased 90° orbit steps, smooth zoom (log-space easing), viewport-aware
 *    zoom scaling (phones/portrait show a comparable world extent).
 *  - Free-camera exploration: focus detaches and follows cameraRuntime.free*
 *    (input pans it); recenter() eases back.
 * Publishes the frame's view in runtime.view. Controls API: ./camera.ts.
 */
import { OrthographicCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import type { OrthographicCamera as ThreeOrtho } from 'three';
import { WORLD_BOUNDS, clamp, groundHeight } from '@elsewhere/shared';
import { runtime } from '../state/runtime.js';
import { ELEVATION, ROTATE_MS, cameraRuntime, easeInOut, runtimeFocus, useCameraStore } from './camera.js';

/** Distance from focus to camera (orthographic: only affects clipping). */
const DISTANCE = 70;
/** Kept for backwards compatibility (the default offset direction). */
export const ISO_OFFSET = { x: 30, y: 30, z: 30 } as const;
/** Free camera may wander at most this far from the player. */
const FREE_MAX_DISTANCE = 45;

export function CameraRig() {
  const cam = useRef<ThreeOrtho>(null);
  const size = useThree((s) => s.size);
  const focus = useRef({ x: 0, y: 0, z: 0, lx: 0, lz: 0, init: false });

  useFrame((_, rawDt) => {
    const c = cam.current;
    if (!c) return;
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const lp = runtime.localPlayer;
    const cs = useCameraStore.getState();
    const f = focus.current;

    // Rotation tween.
    const rt = clamp((now - cameraRuntime.yawStart) / ROTATE_MS, 0, 1);
    cameraRuntime.yaw = cameraRuntime.yawFrom + (cameraRuntime.yawTo - cameraRuntime.yawFrom) * easeInOut(rt);

    // Zoom: ease in log space so zooming feels uniform at every level.
    const zk = 1 - Math.exp(-dt * 12);
    cameraRuntime.zoom = Math.exp(Math.log(cameraRuntime.zoom) + (Math.log(cs.zoom) - Math.log(cameraRuntime.zoom)) * zk);
    const minDim = Math.max(1, Math.min(size.width, size.height));
    cameraRuntime.viewportScale = clamp(minDim / 760, 0.55, 1.35);
    const zoom = cameraRuntime.zoom * cameraRuntime.viewportScale;
    const halfW = size.width / 2 / zoom;
    const halfH = size.height / 2 / zoom / Math.sin(ELEVATION);

    // Focus target.
    let tx = f.x;
    let tz = f.z;
    if (lp.ready) {
      if (!f.init) Object.assign(f, { x: lp.x, y: lp.y, z: lp.z, init: true });
      if (cs.free) {
        // Keep the free camera on the island and within reach of the player.
        cameraRuntime.freeX = clamp(cameraRuntime.freeX, WORLD_BOUNDS.minX, WORLD_BOUNDS.maxX);
        cameraRuntime.freeZ = clamp(cameraRuntime.freeZ, WORLD_BOUNDS.minZ, WORLD_BOUNDS.maxZ);
        const dx = cameraRuntime.freeX - lp.x;
        const dz = cameraRuntime.freeZ - lp.z;
        const d = Math.hypot(dx, dz);
        if (d > FREE_MAX_DISTANCE) {
          cameraRuntime.freeX = lp.x + (dx / d) * FREE_MAX_DISTANCE;
          cameraRuntime.freeZ = lp.z + (dz / d) * FREE_MAX_DISTANCE;
        }
        tx = cameraRuntime.freeX;
        tz = cameraRuntime.freeZ;
      } else {
        // Gentle lead in the direction of travel (smoothed so it never jerks).
        const lead = 0.35;
        const lk = 1 - Math.exp(-dt * 3);
        f.lx += ((lp.vx ?? 0) * lead - f.lx) * lk;
        f.lz += ((lp.vz ?? 0) * lead - f.lz) * lk;
        tx = lp.x + f.lx;
        tz = lp.z + f.lz;
      }
    }
    const recentering = now - cameraRuntime.recenterAt < 700;
    const k = 1 - Math.exp(-dt * (cs.free ? 10 : recentering ? 6 : 4.5));
    f.x += (tx - f.x) * k;
    f.z += (tz - f.z) * k;
    if (lp.ready && !cs.free) {
      // Never lose the player: hard-limit how far the focus may lag behind.
      const maxLag = Math.min(halfW, halfH) * 0.45;
      const dx = lp.x - f.x;
      const dz = lp.z - f.z;
      const d = Math.hypot(dx, dz);
      if (d > maxLag) {
        f.x = lp.x - (dx / d) * maxLag;
        f.z = lp.z - (dz / d) * maxLag;
      }
    }
    const gy = lp.ready && !cs.free ? lp.y : groundHeight(f.x, f.z);
    f.y += (gy - f.y) * (1 - Math.exp(-dt * 4));

    const yaw = cameraRuntime.yaw;
    const hd = Math.cos(ELEVATION) * DISTANCE;
    c.position.set(f.x + Math.sin(yaw) * hd, f.y + Math.sin(ELEVATION) * DISTANCE, f.z + Math.cos(yaw) * hd);
    c.lookAt(f.x, f.y, f.z);
    if (Math.abs(c.zoom - zoom) > 1e-4) {
      c.zoom = zoom;
      c.updateProjectionMatrix();
    }

    runtimeFocus.x = f.x;
    runtimeFocus.z = f.z;
    const v = runtime.view;
    v.focusX = f.x;
    v.focusY = f.y;
    v.focusZ = f.z;
    v.yaw = yaw;
    v.zoom = zoom;
    v.halfWidth = halfW;
    v.halfHeight = halfH;
    v.free = cs.free;
  });

  return <OrthographicCamera ref={cam} makeDefault near={1} far={220} zoom={cameraRuntime.zoom} position={[30, 30, 30]} />;
}
