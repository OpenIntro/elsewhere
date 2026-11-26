/**
 * Screen ↔ world helpers that do not raycast the scene graph:
 *  - groundFromScreen: camera ray marched against the shared groundHeight
 *    (exactly the surface collision uses), refined by bisection.
 *  - worldToScreen: projection to client pixels.
 *  - pickAt: nearest interactable / remote player under a screen point
 *    (projected anchors within a touch-friendly pixel radius).
 * The active camera + canvas are registered by PlayerSystems.
 */
import { Raycaster, Vector2, Vector3, type Camera } from 'three';
import { INTERACTABLES, groundHeight, type Interactable, type Vec2 } from '@elsewhere/shared';
import { useGameStore } from '../state/gameStore.js';
import { isHiddenIndoors } from '../world/cutawayRuntime.js';
import { runtime } from '../state/runtime.js';

export const view3d: { camera: Camera | null; canvas: HTMLElement | null } = { camera: null, canvas: null };

const ray = new Raycaster();
const ndc = new Vector2();
const tmp = new Vector3();

/** Ground point under client (x, y), or null if the ray misses (it never should on the island). */
export function groundFromScreen(clientX: number, clientY: number, out: Vec2 = { x: 0, z: 0 }): Vec2 | null {
  const cam = view3d.camera;
  const el = view3d.canvas;
  if (!cam || !el) return null;
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  const above = (t: number) => o.y + d.y * t - groundHeight(o.x + d.x * t, o.z + d.z * t);
  let t0 = 0;
  if (above(0) <= 0) return null;
  const step = 0.5;
  for (let t = step; t < 400; t += step) {
    if (above(t) <= 0) {
      let lo = t0;
      let hi = t;
      for (let i = 0; i < 10; i++) {
        const m = (lo + hi) / 2;
        if (above(m) > 0) lo = m;
        else hi = m;
      }
      out.x = o.x + d.x * hi;
      out.z = o.z + d.z * hi;
      return out;
    }
    t0 = t;
  }
  return null;
}

/** Project a world point to client pixels. Returns null when behind the camera / no camera. */
export function worldToScreen(x: number, y: number, z: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } | null {
  const cam = view3d.camera;
  const el = view3d.canvas;
  if (!cam || !el) return null;
  const r = el.getBoundingClientRect();
  tmp.set(x, y, z).project(cam);
  if (tmp.z > 1 || tmp.z < -1) return null;
  out.x = r.left + ((tmp.x + 1) / 2) * r.width;
  out.y = r.top + ((1 - tmp.y) / 2) * r.height;
  return out;
}

export type Pick = { kind: 'interactable'; target: Interactable; px: number } | { kind: 'player'; sessionId: string; at: Vec2; px: number } | null;

const scr = { x: 0, y: 0 };
/** What is under a screen point (projected anchors). Players win close ties. */
export function pickAt(clientX: number, clientY: number, pointerType: string): Pick {
  const radius = pointerType === 'touch' ? 40 : 28;
  let best: Pick = null;
  let bestD = radius;
  for (const it of INTERACTABLES) {
    if (it.kind === 'hidden') continue; // secrets are found by walking up to them, not by clicking
    if (it.kind !== 'door' && isHiddenIndoors(it.position.x, it.position.z)) continue; // under a closed roof
    const y = groundHeight(it.position.x, it.position.z) + 0.7;
    if (!worldToScreen(it.position.x, y, it.position.z, scr)) continue;
    const d = Math.hypot(scr.x - clientX, scr.y - clientY);
    if (d < bestD) {
      bestD = d;
      best = { kind: 'interactable', target: it, px: d };
    }
  }
  // Keepers (world characters): clicking one targets its talk spot across the counter.
  for (const it of INTERACTABLES) {
    if (it.kind !== 'keeper') continue;
    const p = runtime.keepers.get(it.keeperId)?.render;
    if (!p || !p.visible || isHiddenIndoors(p.x, p.z)) continue;
    for (const h of [0.9, 1.5]) {
      if (!worldToScreen(p.x, p.y + h, p.z, scr)) continue;
      const d = Math.hypot(scr.x - clientX, scr.y - clientY) - 6;
      if (d < bestD) {
        bestD = d;
        best = { kind: 'interactable', target: it, px: d };
      }
    }
  }
  const local = useGameStore.getState().sessionId;
  for (const [id, r] of runtime.remotes) {
    if (id === local) continue;
    const p = r.render;
    if (!p || !p.visible) continue;
    if (isHiddenIndoors(p.x, p.z)) continue; // inside a building whose roof is closed for us
    // Character body spans ~0..1.8 m: test the torso and the head.
    for (const h of [0.9, 1.5]) {
      if (!worldToScreen(p.x, p.y + h, p.z, scr)) continue;
      const d = Math.hypot(scr.x - clientX, scr.y - clientY) - 6;
      if (d < bestD) {
        bestD = d;
        best = { kind: 'player', sessionId: id, at: { x: p.x, z: p.z }, px: d };
      }
    }
  }
  return best;
}
