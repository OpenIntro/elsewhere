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
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { OrthographicCamera as ThreeOrtho } from 'three';
import { WORLD_BOUNDS, clamp, groundHeight } from '@elsewhere/shared';
import { registerDebugSection } from '../net/index.js';
import { runtime } from '../state/runtime.js';
import { ELEVATION, cameraRuntime, freeRectFor, tweenYaw, lookAtForShift, runtimeFocus, shiftForFree, useCameraStore, viewportScaleFor, type ScreenRect } from './camera.js';

/** Distance from focus to camera (orthographic: only affects clipping). */
const DISTANCE = 70;
/** Kept for backwards compatibility (the default offset direction). */
export const ISO_OFFSET = { x: 30, y: 30, z: 30 } as const;
/** Free camera may wander at most this far from the player. */
const FREE_MAX_DISTANCE = 45;
/** How often the UI's cover rects are re-read (ms, wall clock). */
const COVER_POLL_MS = 120;
/** Focus-shift easing rate (1/s): ~90% of the way in 0.4 s. */
const SHIFT_RATE = 6;
/** Phone layouts (same breakpoints as ui.css): the only place the focus shift applies. */
const PHONE_QUERY = '(max-width: 720px), (max-height: 500px) and (orientation: landscape)';
/** Top bar height kept out of the free rect (phones). */
const TOP_INSET = 56;
const lookOut = { x: 0, z: 0 };
const lastCover: { free: ScreenRect | null; covers: number } = { free: null, covers: 0 };

/** Read the UI's cover rects and set the shift target (zero on desktop layouts or with nothing covering). */
function updateShiftTarget(width: number, height: number): void {
  let tx = 0;
  let ty = 0;
  lastCover.free = null;
  lastCover.covers = 0;
  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches) {
    const rects: ScreenRect[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-camera-cover]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    lastCover.covers = rects.length;
    if (rects.length) {
      const free = freeRectFor(width, height, rects, TOP_INSET);
      lastCover.free = free;
      const s = shiftForFree(width, height, free, TOP_INSET);
      tx = s.x;
      ty = s.y;
    }
  }
  cameraRuntime.shiftTargetX = tx;
  cameraRuntime.shiftTargetY = ty;
}

export function CameraRig() {
  const cam = useRef<ThreeOrtho>(null);
  const size = useThree((s) => s.size);
  const focus = useRef({ x: 0, y: 0, z: 0, lx: 0, lz: 0, init: false });
  const covers = useRef({ at: 0, last: 0, mix: 0, sx: 0, sz: 0 });

  useEffect(() => {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    registerDebugSection('cameraShift', () => ({
      shift: { x: r1(cameraRuntime.shiftX), y: r1(cameraRuntime.shiftY) },
      target: { x: r1(cameraRuntime.shiftTargetX), y: r1(cameraRuntime.shiftTargetY) },
      free: lastCover.free ? { left: Math.round(lastCover.free.left), top: Math.round(lastCover.free.top), right: Math.round(lastCover.free.right), bottom: Math.round(lastCover.free.bottom) } : null,
      covers: lastCover.covers,
      subject: cameraRuntime.coverSubject,
    }));
  }, []);

  // runtime.view must be valid before the first frame and immediately after a resize
  // (shadow / culling consumers may run before this rig's useFrame in a frame).
  useLayoutEffect(() => {
    const v = runtime.view;
    cameraRuntime.viewportScale = viewportScaleFor(size.width, size.height);
    const zoom = cameraRuntime.zoom * cameraRuntime.viewportScale;
    v.zoom = zoom;
    v.halfWidth = size.width / 2 / zoom;
    v.halfHeight = size.height / 2 / zoom / Math.sin(ELEVATION);
    v.yaw = cameraRuntime.yaw;
    const lp = runtime.localPlayer;
    if (!focus.current.init && lp.ready) {
      v.focusX = lp.x;
      v.focusY = lp.y;
      v.focusZ = lp.z;
    }
  }, [size.width, size.height]);

  useFrame((_, rawDt) => {
    const c = cam.current;
    if (!c) return;
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const lp = runtime.localPlayer;
    const cs = useCameraStore.getState();
    const f = focus.current;

    // Rotation tween.
    // A live drag / twist turns the view directly; otherwise the eased 90° tween.
    cameraRuntime.yaw = cameraRuntime.dragYaw ?? tweenYaw(cameraRuntime.yawFrom, cameraRuntime.yawTo, cameraRuntime.yawStart, cameraRuntime.yawMs, now);

    // Zoom: ease in log space so zooming feels uniform at every level.
    const zk = 1 - Math.exp(-dt * 12);
    cameraRuntime.zoom = Math.exp(Math.log(cameraRuntime.zoom) + (Math.log(cs.zoom) - Math.log(cameraRuntime.zoom)) * zk);
    cameraRuntime.viewportScale = viewportScaleFor(size.width, size.height);
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

    // Phone focus shift: frame what we follow in the part of the screen the UI leaves free. Eased on
    // wall-clock time (not the capped frame dt) so it settles in ~0.5 s even at a few frames a second.
    if (now - covers.current.at > COVER_POLL_MS) {
      covers.current.at = now;
      updateShiftTarget(size.width, size.height);
    }
    const realDt = covers.current.last ? Math.min(0.5, (now - covers.current.last) / 1000) : 0;
    covers.current.last = now;
    const sk = 1 - Math.exp(-realDt * SHIFT_RATE);
    cameraRuntime.shiftX += (cameraRuntime.shiftTargetX - cameraRuntime.shiftX) * sk;
    cameraRuntime.shiftY += (cameraRuntime.shiftTargetY - cameraRuntime.shiftY) * sk;
    if (Math.abs(cameraRuntime.shiftX - cameraRuntime.shiftTargetX) < 0.25) cameraRuntime.shiftX = cameraRuntime.shiftTargetX;
    if (Math.abs(cameraRuntime.shiftY - cameraRuntime.shiftTargetY) < 0.25) cameraRuntime.shiftY = cameraRuntime.shiftTargetY;

    const yaw = cameraRuntime.yaw;
    // What is framed: the followed point, or the midpoint with the thing being used (piano, …).
    const subj = cameraRuntime.coverSubject;
    const sm = covers.current;
    const useSubj = !!subj && lp.ready && !cs.free && Math.hypot(subj.x - f.x, subj.z - f.z) < 6;
    if (useSubj) {
      sm.sx = subj.x;
      sm.sz = subj.z;
    }
    sm.mix += ((useSubj ? 1 : 0) - sm.mix) * sk;
    if (sm.mix < 0.002) sm.mix = 0;
    const px = f.x + (sm.sx - f.x) * 0.5 * sm.mix;
    const pz = f.z + (sm.sz - f.z) * 0.5 * sm.mix;
    const sx = cameraRuntime.shiftX;
    const sy = cameraRuntime.shiftY;
    const look = sx || sy || sm.mix ? lookAtForShift(px, pz, sx, sy, yaw, zoom, lookOut) : null;
    const lx = look ? look.x : f.x;
    const lz = look ? look.z : f.z;
    const hd = Math.cos(ELEVATION) * DISTANCE;
    c.position.set(lx + Math.sin(yaw) * hd, f.y + Math.sin(ELEVATION) * DISTANCE, lz + Math.cos(yaw) * hd);
    c.lookAt(lx, f.y, lz);
    if (Math.abs(c.zoom - zoom) > 1e-4) {
      c.zoom = zoom;
      c.updateProjectionMatrix();
    }

    runtimeFocus.x = f.x;
    runtimeFocus.z = f.z;
    const v = runtime.view;
    // runtime.view is what is actually on screen (shadow frustum, culling): the shifted look-at.
    v.focusX = lx;
    v.focusY = f.y;
    v.focusZ = lz;
    v.yaw = yaw;
    v.zoom = zoom;
    v.halfWidth = halfW;
    v.halfHeight = halfH;
    v.free = cs.free;
  });

  return <OrthographicCamera ref={cam} makeDefault near={1} far={220} zoom={cameraRuntime.zoom} position={[30, 30, 30]} />;
}
