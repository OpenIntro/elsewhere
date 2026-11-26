/**
 * Drives the dollhouse cutaway (./cutawayRuntime.ts) every frame from the camera
 * focus — the local player, or the free camera's focus — and the camera yaw,
 * and adds a soft warm fill light inside the open building (one light, always
 * mounted so no shader recompiles when you walk in or out).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { PointLight } from 'three';
import { registerDebugSection } from '../net/index.js';
import { runtime } from '../state/runtime.js';
import { cutaway, updateCutaway } from './cutawayRuntime.js';
import { devOverrides, env } from './env.js';

/** `fill`: mount the warm fill light (not on low quality: one more light in every shader). */
export function Cutaway({ fill: withFill }: { fill: boolean }) {
  const fill = useRef<PointLight>(null);
  useEffect(() => {
    registerDebugSection('interior', () => ({ active: cutaway.active?.id ?? null, amount: Math.round(cutaway.amount * 100) / 100 }));
  }, []);
  useFrame((_, dt) => {
    const v = runtime.view;
    const lp = runtime.localPlayer;
    let fx = v.focusX;
    let fz = v.focusZ;
    let yaw = v.yaw;
    const cam = devOverrides.cam;
    if (cam) {
      fx = cam.x;
      fz = cam.z;
      yaw = cam.yaw ?? Math.PI / 4;
    } else if (!v.free && lp.ready) {
      fx = lp.x;
      fz = lp.z;
    }
    cutaway.force = devOverrides.inside;
    updateCutaway(fx, fz, yaw, dt);
    const l = fill.current;
    if (!l) return;
    const it = cutaway.active;
    const k = cutaway.amount;
    if (!it || k < 0.01) {
      l.intensity = 0;
      return;
    }
    l.position.set(it.inner.center.x, it.floorY + it.wallHeight * 0.85, it.inner.center.z);
    l.distance = Math.max(it.inner.halfWidth, it.inner.halfDepth) * 2.6;
    // Warm room light: gentle by day (the sun comes in), the main light at night.
    l.intensity = k * (0.8 + 2.6 * env.night) * (it.purpose === 'hall' ? 1.25 : 1);
  });
  return withFill ? <pointLight ref={fill} color="#ffd2a0" intensity={0} distance={12} decay={1.1} /> : null;
}
