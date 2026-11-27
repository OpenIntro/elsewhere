/**
 * Screen → piece picking against the instanced piece meshes (BuildLayer
 * registers them with the piece id of every instance).
 */
import { Matrix4, Raycaster, Vector2, Vector3, type BufferAttribute, type InstancedMesh, type Object3D } from 'three';
import type { Vec2 } from '@elsewhere/shared';
import { view3d } from '../player/picking.js';
import { CUT_OFFSET } from './materials.js';

export interface PickTarget {
  mesh: InstancedMesh;
  /** Piece id per instance index. */
  ids: string[];
}

export const pickTargets = new Set<PickTarget>();

const ray = new Raycaster();
const ndc = new Vector2();
const _im = new Matrix4();
const _n = new Vector3();

/**
 * Nearest piece under a screen point. Pieces dissolved for the local player
 * (roofs / upper storeys / walls thinned between camera and player) and the
 * parts of walls cut away by a built interior's cutaway are looked through —
 * you point at what you can see. `accept` narrows the hit further (e.g. only
 * walls, for wall mounts).
 */
function cast(clientX: number, clientY: number, accept?: (id: string) => boolean) {
  const cam = view3d.camera;
  const el = view3d.canvas;
  if (!cam || !el || !pickTargets.size) return null;
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const objects: Object3D[] = [];
  const byMesh = new Map<Object3D, PickTarget>();
  for (const t of pickTargets) {
    if (t.mesh.count === 0 || !t.mesh.visible) continue;
    objects.push(t.mesh);
    byMesh.set(t.mesh, t);
  }
  const hits = ray.intersectObjects(objects, false);
  for (const h of hits) {
    const t = byMesh.get(h.object);
    if (!t || h.instanceId === undefined) continue;
    const id = t.ids[h.instanceId];
    const fade = (t.mesh.geometry.getAttribute('aFade') as BufferAttribute | undefined)?.getX(h.instanceId) ?? 0;
    if (fade > 0.5) continue;
    // Above a cut (the stub of a camera-side wall in the room you are in): not there.
    const cut = (t.mesh.geometry.getAttribute('aCut') as BufferAttribute | undefined)?.getX(h.instanceId) ?? 0;
    if (cut > 0.5 && h.point.y > cut - CUT_OFFSET + 0.005) continue;
    // The materials draw both sides (for the cut caps): a back face is never what you point at.
    if (h.face) {
      t.mesh.getMatrixAt(h.instanceId, _im);
      _n.copy(h.face.normal).transformDirection(_im).transformDirection(h.object.matrixWorld);
      if (_n.dot(ray.ray.direction) > 0) continue;
    }
    if (id && accept && !accept(id)) continue;
    if (id) return { id, point: h.point, normalY: h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld).y : 0 };
  }
  return null;
}

/** Piece under a screen point: id, world hit point and the world-space normal's Y (1 = a top face). */
export function pickPieceHit(clientX: number, clientY: number, accept?: (id: string) => boolean): { id: string; point: { x: number; y: number; z: number }; normalY: number } | null {
  const h = cast(clientX, clientY, accept);
  return h ? { id: h.id, point: { x: h.point.x, y: h.point.y, z: h.point.z }, normalY: h.normalY } : null;
}

/** Piece id under a screen point (nearest to the camera), or null. */
export function pickPiece(clientX: number, clientY: number): string | null {
  return cast(clientX, clientY)?.id ?? null;
}

/** Camera ray through a screen point (origin + unit direction), or null. */
export function screenRay(clientX: number, clientY: number): { o: { x: number; y: number; z: number }; d: { x: number; y: number; z: number } } | null {
  const cam = view3d.camera;
  const el = view3d.canvas;
  if (!cam || !el) return null;
  const r = el.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, cam);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  return { o: { x: o.x, y: o.y, z: o.z }, d: { x: d.x, y: d.y, z: d.z } };
}

/** Where a camera ray crosses the horizontal plane y = h (null if parallel / behind). */
export function rayAtHeight(r: NonNullable<ReturnType<typeof screenRay>>, h: number): Vec2 | null {
  if (Math.abs(r.d.y) < 1e-4) return null;
  const t = (h - r.o.y) / r.d.y;
  if (t < 0) return null;
  return { x: r.o.x + r.d.x * t, z: r.o.z + r.d.z * t };
}
