/**
 * Dollhouse cutaway for walk-in buildings.
 *
 * Every walk-in building owns SLOTS_PER_BUILDING consecutive "cut slots"
 * (roof, the four wall faces, the four corners, spare). Architecture geometry
 * is tagged per vertex with `cut = slot + 1` (GeoBuilder.cut; 0 = never cut)
 * and the cut-aware materials (materials.ts, also the shadow depth material)
 * dissolve a part with a dithered discard as its slot's fade goes 0 → 1.
 * No transparency sorting, no extra draw calls, no z-fighting.
 *
 * Each frame `updateCutaway` picks the building containing the focus (the
 * local player, or the free camera's focus) with hysteresis, fades its roof
 * and the wall faces that face the camera (all four 90° rotations), and eases
 * every slot (≈0.35 s). Lower wall "stubs" are untagged, so the room outline
 * stays readable.
 */
import { Vector4 } from 'three';
import { INTERIORS, interiorAt, zoneContains, type Interior } from '@elsewhere/shared';

export const SLOTS_PER_BUILDING = 10;
export const MAX_CUT_BUILDINGS = 8;
export const CUT_VEC4S = (SLOTS_PER_BUILDING * MAX_CUT_BUILDINGS) / 4;

export type CutPart = 'roof' | 'front' | 'back' | 'left' | 'right' | 'cornerFL' | 'cornerFR' | 'cornerBL' | 'cornerBR';
const PART_OFFSET: Record<CutPart, number> = { roof: 0, front: 1, back: 2, left: 3, right: 4, cornerFL: 5, cornerFR: 6, cornerBL: 7, cornerBR: 8 };

if (INTERIORS.length > MAX_CUT_BUILDINGS) throw new Error('cutaway: raise MAX_CUT_BUILDINGS');
const INDEX = new Map(INTERIORS.map((it, i) => [it.id, i]));

/** Vertex attribute value for a part of a walk-in building (0 when the building is not walk-in). */
export function cutSlot(buildingId: string, part: CutPart): number {
  const i = INDEX.get(buildingId);
  return i === undefined ? 0 : i * SLOTS_PER_BUILDING + PART_OFFSET[part] + 1;
}

/** Shared uniform (the same object is bound into every cut-aware program). */
export const cutUniform = { value: Array.from({ length: CUT_VEC4S }, () => new Vector4()) };

const fades = new Float32Array(SLOTS_PER_BUILDING * MAX_CUT_BUILDINGS);
const targets = new Float32Array(SLOTS_PER_BUILDING * MAX_CUT_BUILDINGS);

export const cutaway = {
  /** Building whose cutaway is (becoming) open, or null. */
  active: null as Interior | null,
  /** Roof fade of the active building 0..1 (UI/audio may read it). */
  amount: 0,
  /** Override for tests/screenshots: force a building open (id) or closed (''). */
  force: null as string | null,
};

const FACE_YAW: Record<'front' | 'back' | 'left' | 'right', number> = { front: 0, back: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 };

/**
 * Which building should be cut open for this focus. Enter when the focus is
 * inside the outer walls (the doorway counts); leave only once it is clearly
 * back outside (hysteresis keeps the doorstep from flickering).
 */
function pickActive(fx: number, fz: number): Interior | null {
  if (cutaway.force !== null) return INTERIORS.find((i) => i.id === cutaway.force) ?? null;
  const p = { x: fx, z: fz };
  const cur = cutaway.active;
  if (cur && zoneContains(cur.footprint, p, 0.45)) return cur;
  return interiorAt(p, -0.05);
}

export function updateCutaway(fx: number, fz: number, cameraYaw: number, dt: number): void {
  const active = pickActive(fx, fz);
  cutaway.active = active;
  targets.fill(0);
  if (active) {
    const base = INDEX.get(active.id)! * SLOTS_PER_BUILDING;
    const cx = Math.sin(cameraYaw);
    const cz = Math.cos(cameraYaw);
    const faceCut = (face: keyof typeof FACE_YAW): boolean => {
      const a = active.footprint.yaw + FACE_YAW[face];
      return Math.sin(a) * cx + Math.cos(a) * cz > 0.08;
    };
    const f = faceCut('front');
    const b = faceCut('back');
    const l = faceCut('left');
    const r = faceCut('right');
    targets[base + PART_OFFSET.roof] = 1;
    targets[base + PART_OFFSET.front] = f ? 1 : 0;
    targets[base + PART_OFFSET.back] = b ? 1 : 0;
    targets[base + PART_OFFSET.left] = l ? 1 : 0;
    targets[base + PART_OFFSET.right] = r ? 1 : 0;
    targets[base + PART_OFFSET.cornerFL] = f || l ? 1 : 0;
    targets[base + PART_OFFSET.cornerFR] = f || r ? 1 : 0;
    targets[base + PART_OFFSET.cornerBL] = b || l ? 1 : 0;
    targets[base + PART_OFFSET.cornerBR] = b || r ? 1 : 0;
  }
  const k = 1 - Math.exp(-Math.min(dt, 0.1) * 8);
  const u = cutUniform.value;
  for (let i = 0; i < fades.length; i++) {
    let v = fades[i]! + (targets[i]! - fades[i]!) * k;
    if (Math.abs(v - targets[i]!) < 0.004) v = targets[i]!;
    fades[i] = v;
    u[i >> 2]!.setComponent(i & 3, v);
  }
  cutaway.amount = active ? fades[INDEX.get(active.id)! * SLOTS_PER_BUILDING]! : 0;
}

/** Current fade (0..1) of a building's roof. */
export function roofFade(buildingId: string): number {
  const i = INDEX.get(buildingId);
  return i === undefined ? 0 : fades[i * SLOTS_PER_BUILDING]!;
}

/**
 * True when (x, z) is inside a walk-in building whose roof is closed for this
 * viewer: characters there are hidden by the roof, so their name tags /
 * bubbles / pick targets should be too.
 */
export function isHiddenIndoors(x: number, z: number): boolean {
  const it = interiorAt({ x, z }, -0.15);
  if (!it) return false;
  return roofFade(it.id) < 0.5;
}
