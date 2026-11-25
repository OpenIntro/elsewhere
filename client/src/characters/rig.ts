/**
 * Skeleton layout + body proportions.
 *
 * Every character is ONE rigidly-skinned mesh (each vertex weighted 1.0 to a
 * single bone), so a whole toy is a single draw call while still animating as a
 * transform-driven group hierarchy of bones (hips → spine → head → face, arms,
 * legs). Face features are bones too: blinking / expression swaps are bone
 * scales, never geometry rebuilds.
 */
import type { BodyId } from '@elsewhere/shared';

export const B = {
  root: 0,
  hips: 1,
  spine: 2,
  head: 3,
  eyeL: 4,
  eyeR: 5,
  eyeHappyL: 6,
  eyeHappyR: 7,
  browL: 8,
  browR: 9,
  mouth: 10,
  mouthHappy: 11,
  mouthO: 12,
  hairBack: 13,
  shoulderL: 14,
  elbowL: 15,
  shoulderR: 16,
  elbowR: 17,
  hipL: 18,
  kneeL: 19,
  hipR: 20,
  kneeR: 21,
} as const;
export type BoneIndex = (typeof B)[keyof typeof B];
export const BONE_COUNT = 22;

export const BONE_PARENT: readonly number[] = [
  -1, // root
  B.root, // hips
  B.hips, // spine
  B.spine, // head
  B.head, B.head, B.head, B.head, // eyes
  B.head, B.head, // brows
  B.head, B.head, B.head, // mouths
  B.head, // hairBack
  B.spine, B.shoulderL, // left arm
  B.spine, B.shoulderR, // right arm
  B.hips, B.hipL, // left leg
  B.hips, B.hipR, // right leg
];

export interface Proportions {
  /** Head half-extents (x/z radius and y radius) + superellipse exponent of the lathe profile. */
  headRx: number;
  headRy: number;
  headN: number;
  /** Torso lathe: height and radii (bottom, belly, shoulder, neck). */
  torsoH: number;
  rBot: number;
  rMid: number;
  rSh: number;
  rNeck: number;
  /** Front/back squash of the torso & pelvis. */
  depth: number;
  thigh: number;
  shin: number;
  legR: number;
  hipX: number;
  upperArm: number;
  foreArm: number;
  armR: number;
  handR: number;
  ankle: number;
  /** Shoe size multiplier. */
  foot: number;
}

const P: Record<BodyId, Proportions> = {
  // Soft pear / mochi: wide head, belly, stubby limbs.
  round: {
    headRx: 0.45, headRy: 0.4, headN: 2.25,
    torsoH: 0.4, rBot: 0.26, rMid: 0.3, rSh: 0.2, rNeck: 0.09, depth: 0.9,
    thigh: 0.15, shin: 0.14, legR: 0.085, hipX: 0.12,
    upperArm: 0.17, foreArm: 0.15, armR: 0.066, handR: 0.075, ankle: 0.06, foot: 1.0,
  },
  // Lanky bean: egg head, long noodle limbs.
  tall: {
    headRx: 0.36, headRy: 0.38, headN: 2.15,
    torsoH: 0.5, rBot: 0.18, rMid: 0.19, rSh: 0.2, rNeck: 0.075, depth: 0.85,
    thigh: 0.23, shin: 0.23, legR: 0.068, hipX: 0.095,
    upperArm: 0.24, foreArm: 0.21, armR: 0.055, handR: 0.068, ankle: 0.06, foot: 1.0,
  },
  // Chibi: enormous bun head on a tiny body.
  small: {
    headRx: 0.44, headRy: 0.38, headN: 2.45,
    torsoH: 0.28, rBot: 0.19, rMid: 0.205, rSh: 0.16, rNeck: 0.075, depth: 0.9,
    thigh: 0.1, shin: 0.1, legR: 0.075, hipX: 0.09,
    upperArm: 0.13, foreArm: 0.11, armR: 0.058, handR: 0.068, ankle: 0.055, foot: 0.92,
  },
  // Broad-shouldered fridge with a squarish head.
  sturdy: {
    headRx: 0.39, headRy: 0.37, headN: 2.9,
    torsoH: 0.44, rBot: 0.24, rMid: 0.27, rSh: 0.31, rNeck: 0.1, depth: 0.82,
    thigh: 0.16, shin: 0.16, legR: 0.1, hipX: 0.135,
    upperArm: 0.2, foreArm: 0.18, armR: 0.085, handR: 0.088, ankle: 0.065, foot: 1.12,
  },
};

export function proportions(body: string): Proportions {
  return P[body as BodyId] ?? P.round;
}

export const BODY_PROPORTIONS = P;

/** Derived rest-pose anchor numbers shared by the geometry builder and the animator. */
export interface RigLayout {
  p: Proportions;
  /** Hips bone height above the feet when standing. */
  hipsY: number;
  /** Head centre relative to the head (neck) bone. */
  headC: [number, number, number];
  shoulderX: number;
  shoulderY: number;
  /** Rest local positions per bone (relative to parent). */
  rest: Float32Array; // BONE_COUNT * 3
  /** Total standing height (top of the head, without hair). */
  height: number;
}

export interface FaceLayout {
  eyeL: [number, number, number];
  eyeR: [number, number, number];
  browL: [number, number, number];
  browR: [number, number, number];
  mouth: [number, number, number];
}

export function layoutFor(body: string): RigLayout {
  const p = proportions(body);
  const hipsY = p.ankle + p.shin + p.thigh + 0.05;
  const shoulderX = p.rSh * 0.92 + p.armR * 0.55;
  const shoulderY = p.torsoH * 0.8;
  const headC: [number, number, number] = [0, p.headRy * 0.93, 0.01];
  const rest = new Float32Array(BONE_COUNT * 3);
  const set = (b: number, x: number, y: number, z: number) => {
    rest[b * 3] = x;
    rest[b * 3 + 1] = y;
    rest[b * 3 + 2] = z;
  };
  set(B.root, 0, 0, 0);
  set(B.hips, 0, hipsY, 0);
  set(B.spine, 0, 0.02, 0);
  set(B.head, 0, p.torsoH, 0.005);
  // Face bones are placed by the face builder (they depend on the head surface); defaults here.
  for (const b of [B.eyeL, B.eyeR, B.eyeHappyL, B.eyeHappyR, B.browL, B.browR, B.mouth, B.mouthHappy, B.mouthO]) set(b, 0, headC[1], p.headRx);
  set(B.hairBack, 0, headC[1] + p.headRy * 0.35, -p.headRx * 0.85);
  set(B.shoulderL, shoulderX, shoulderY, 0);
  set(B.elbowL, 0, -p.upperArm, 0);
  set(B.shoulderR, -shoulderX, shoulderY, 0);
  set(B.elbowR, 0, -p.upperArm, 0);
  set(B.hipL, p.hipX, -0.05, 0);
  set(B.kneeL, 0, -p.thigh, 0);
  set(B.hipR, -p.hipX, -0.05, 0);
  set(B.kneeR, 0, -p.thigh, 0);
  const height = hipsY + 0.02 + p.torsoH + headC[1] + p.headRy;
  return { p, hipsY, headC, shoulderX, shoulderY, rest, height };
}

/** Head-local surface helpers for the superellipse lathe head (centre at origin). */
export function headRadiusAt(p: Proportions, y: number): number {
  const v = Math.min(1, Math.abs(y) / p.headRy);
  return p.headRx * Math.pow(Math.max(0, 1 - Math.pow(v, p.headN)), 1 / p.headN);
}

/** Front surface point of the head for a head-centred (x, y). */
export function headFront(p: Proportions, x: number, y: number): [number, number, number] {
  const r = headRadiusAt(p, y);
  const z = Math.sqrt(Math.max(0, r * r - x * x));
  return [x, y, z];
}

/** Outward normal of the head surface at a head-centred point (numerical gradient of the implicit form). */
export function headNormal(p: Proportions, x: number, y: number, z: number): [number, number, number] {
  const f = (px: number, py: number, pz: number) => Math.pow(Math.hypot(px, pz) / p.headRx, p.headN) + Math.pow(Math.abs(py) / p.headRy, p.headN);
  const e = 1e-4;
  const gx = (f(x + e, y, z) - f(x - e, y, z)) / (2 * e);
  const gy = (f(x, y + e, z) - f(x, y - e, z)) / (2 * e);
  const gz = (f(x, y, z + e) - f(x, y, z - e)) / (2 * e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}
