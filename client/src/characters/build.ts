/**
 * Appearance → one rigid-skinned toy geometry.
 *
 * Every catalog option of every slot maps to a builder in the records below
 * (`RENDER_MAPPING`); `Record<Id, …>` makes the TypeScript compiler enforce
 * exhaustiveness and a test checks it at runtime too. Unknown ids (old saves,
 * future catalog entries) fall back to the default builder of that slot.
 */
import { Color, Matrix4, Quaternion, SphereGeometry, Vector3, type BufferGeometry } from 'three';
import {
  CLOTHING_COLORS,
  DEFAULT_APPEARANCE,
  HAIR_COLORS,
  SKIN_TONES,
  type Appearance,
  type BackId,
  type BodyId,
  type ClothingColorId,
  type ColorOption,
  type EyewearId,
  type FaceId,
  type HairColorId,
  type HairStyleId,
  type HatId,
  type NeckId,
  type PantsStyleId,
  type ShirtStyleId,
  type ShoeStyleId,
  type SkinToneId,
} from '@elsewhere/shared';
import { GeoBuilder, T, capsule, cylinder, hairShell, lathe, type HairlineSpec, mix, onSurface, roundedBox, shadeColor, sphere, sphereCap, superHead, torus } from './geometry.js';
import { B, BODY_PROPORTIONS, BONE_COUNT, BONE_PARENT, headFront, headNormal, layoutFor, type Proportions, type RigLayout } from './rig.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface BuiltCharacter {
  geometry: BufferGeometry;
  /** Rest local positions per bone (BONE_COUNT * 3), face bones included. */
  rest: Float32Array;
  layout: RigLayout;
  /** Hand anchor positions, local to the elbow bones. */
  handL: [number, number, number];
  handR: [number, number, number];
  /** Highest point (hair / hat included) in rest pose. */
  topY: number;
  vertexCount: number;
}

interface Ctx {
  a: Appearance;
  b: GeoBuilder;
  L: RigLayout;
  p: Proportions;
  R: number; // head rx
  hc: Vector3; // head centre in head-bone space
  skin: Color;
  hair: Color;
  shirt: Color;
  pants: Color;
  shoe: Color;
  accent: Color;
  hasHat: boolean;
  /** Hat dome scale required to clear the hair cap. */
  capScale: number;
  rnd: () => number;
  eye: { x: number; y: number };
  /** Head-space y of the highest hair point (for hats that sit on top of hair). */
  hairTop: number;
  /** Head-space positions of face anchors (filled by the face builder). */
  anchors: Partial<Record<number, Vector3>>;
}

const EYE_INK = new Color('#2a201d');
const WHITE = new Color('#fbf6ee');
const MOUTH_DARK = new Color('#5a2723');
const TONGUE = new Color('#d9787a');
const BLUSH = '#e8857a';
const GOLD = new Color('#d1a54c');
const LEATHER = new Color('#8b5a3c');
const STRAW = new Color('#e4c98f');
const SOLE = new Color('#f1ebe0');
const DARK_SOLE = new Color('#3a302b');

/** Complementary accent for small accessories, keyed by shirt colour. */
const ACCENT: Record<ClothingColorId, ClothingColorId> = {
  cream: 'rust',
  oat: 'teal',
  terracotta: 'mustard',
  rust: 'cream',
  mustard: 'plum',
  olive: 'mustard',
  sage: 'terracotta',
  teal: 'mustard',
  slate: 'rose',
  plum: 'oat',
  rose: 'slate',
  charcoal: 'mustard',
};

function hexOf(cat: readonly ColorOption[], id: string, fallback: string): Color {
  const o = cat.find((c) => c.id === id) ?? cat.find((c) => c.id === fallback);
  return new Color(o?.hex ?? '#888888');
}

function luminance(col: Color): number {
  return 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rest world matrices of every bone (pure translations). */
function boneWorlds(rest: Float32Array): Matrix4[] {
  const out: Matrix4[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const local = new Matrix4().makeTranslation(rest[i * 3]!, rest[i * 3 + 1]!, rest[i * 3 + 2]!);
    const parent = BONE_PARENT[i]!;
    out.push(parent >= 0 ? new Matrix4().multiplyMatrices(out[parent]!, local) : local);
  }
  return out;
}

// Small helpers ------------------------------------------------------------

/** Ellipsoid (sphere scaled) at position with rotation. */
function blob(c: Ctx, bone: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: Color, opts: { rx?: number; ry?: number; rz?: number; gloss?: number; shade?: number; detail?: 'hi' | 'mid' | 'lo'; space?: number } = {}) {
  c.b.add(sphere(opts.detail ?? 'mid'), bone, T(x, y, z, opts.rx ?? 0, opts.ry ?? 0, opts.rz ?? 0, sx, sy, sz), color, { gloss: opts.gloss, shade: opts.shade }, opts.space ?? bone);
}

/** Head-centre coordinates → head-bone matrix. */
function H(c: Ctx, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): Matrix4 {
  return T(c.hc.x + x, c.hc.y + y, c.hc.z + z, rx, ry, rz, sx, sy, sz);
}

/** Torso radius at height y (spine space), from the same profile used for the lathe. */
function torsoProfile(p: Proportions, bulk = 1): [number, number][] {
  const h = p.torsoH;
  return [
    [0, -0.035],
    [p.rBot * 0.9 * bulk, -0.035],
    [p.rBot * bulk, 0.03],
    [p.rMid * bulk, h * 0.36],
    [((p.rMid + p.rSh) / 2) * bulk, h * 0.6],
    [p.rSh * bulk, h * 0.8],
    [p.rSh * 0.8 * bulk, h * 0.94],
    [p.rNeck * 1.2, h * 1.0],
    [0, h * 1.012],
  ];
}

function torsoRadius(p: Proportions, y: number, bulk = 1): number {
  const pts = torsoProfile(p, bulk);
  for (let i = 1; i < pts.length; i++) {
    const [r0, y0] = pts[i - 1]!;
    const [r1, y1] = pts[i]!;
    if (y <= y1 && y1 > y0) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return p.rNeck;
}

// ---------------------------------------------------------------------------
// Head + face
// ---------------------------------------------------------------------------

function buildHead(c: Ctx) {
  const { p, R } = c;
  c.b.add(superHead(p.headRx, p.headRy, p.headN), B.head, H(c, 0, 0, 0), c.skin, { shade: 0.1 });
  // neck stub
  c.b.add(cylinder(p.rNeck, p.rNeck * 1.1, 0.08, 10), B.head, T(0, 0.02, 0), shadeColor(c.skin, 0.9), { shade: 0.2 });
  // ears (slightly mismatched, on purpose)
  const earY = -p.headRy * 0.08;
  for (const s of [1, -1]) {
    const k = 1 + (c.rnd() - 0.5) * 0.18;
    const ex = s * p.headRx * 0.96;
    blob(c, B.head, c.hc.x + ex, c.hc.y + earY, c.hc.z - R * 0.04, R * 0.09 * k, R * 0.13 * k, R * 0.07, mix(c.skin, BLUSH, 0.12), { ry: s * 0.3, detail: 'lo' });
  }
  // nose: tiny rounded button
  const nY = -p.headRy * 0.1;
  const np = headFront(p, (c.rnd() - 0.5) * 0.01, nY);
  blob(c, B.head, c.hc.x + np[0], c.hc.y + np[1], c.hc.z + np[2] - R * 0.01, R * 0.075, R * 0.06, R * 0.06, mix(c.skin, BLUSH, 0.22), { detail: 'lo' });
}

interface Paint {
  /** Head-centre x/y of the feature (surface point is computed). */
  x: number;
  y: number;
  lift?: number;
  local?: Matrix4;
}

/** Add a geometry painted onto the head surface, skinned to `bone`; anchors the bone at the surface point. */
function paint(c: Ctx, bone: number, g: BufferGeometry, color: Color, f: Paint, gloss = 0) {
  const pt = headFront(c.p, f.x, f.y);
  const n = headNormal(c.p, pt[0], pt[1], pt[2]);
  const lift = f.lift ?? 0;
  const pos = [c.hc.x + pt[0] + n[0] * lift, c.hc.y + pt[1] + n[1] * lift, c.hc.z + pt[2] + n[2] * lift];
  c.b.add(g, bone, onSurface(pos, n, f.local), color, { gloss, shade: 0 }, B.head);
}

/** Surface anchor for a face bone (head-bone space). */
function anchorAt(c: Ctx, bone: number, x: number, y: number) {
  const pt = headFront(c.p, x, y);
  c.anchors[bone] = new Vector3(c.hc.x + pt[0], c.hc.y + pt[1], c.hc.z + pt[2]);
}

const S = (sx: number, sy: number, sz: number, x = 0, y = 0, z = 0, rz = 0) => T(x, y, z, 0, 0, rz, sx, sy, sz);

/** Arc (torus segment) centred on direction `dir` (radians, 0 = +X, PI/2 = up). */
function arc(c: Ctx, bone: number, x: number, y: number, r: number, tube: number, span: number, dir: number, color: Color, lift = 0, gloss = 0.6, offY = 0) {
  paint(c, bone, torus(r, tube, span, 6, 14), color, { x, y, lift, local: T(0, offY, 0, 0, 0, dir - span / 2, 1, 1, 0.7) }, gloss);
}

const FaceKit = {
  bead(c: Ctx, side: number, w: number, h: number, ink: Color = EYE_INK, highlights = 1) {
    w *= FS;
    h *= FS;
    const bone = side > 0 ? B.eyeL : B.eyeR;
    const R = c.R;
    const x = side * c.eye.x * R;
    const y = c.eye.y * c.p.headRy;
    const k = 1 + (side > 0 ? 0.03 : -0.03);
    // On deep skin tones a soft cream rim keeps painted eyes readable at small size.
    if (luminance(c.skin) < 0.12) paint(c, bone, sphere('lo'), mix(c.skin, '#f4e8d8', 0.55), { x, y, lift: -R * 0.006, local: S(w * R * k * 1.22, h * R * k * 1.16, R * 0.05) }, 0.2);
    paint(c, bone, sphere('mid'), ink, { x, y, local: S(w * R * k, h * R * k, R * 0.05) }, 1);
    paint(c, bone, sphere('lo'), WHITE, { x, y, local: S(w * R * 0.33, h * R * 0.26, R * 0.03, w * R * 0.32, h * R * 0.42, R * 0.035) }, 1);
    if (highlights > 1) paint(c, bone, sphere('lo'), WHITE, { x, y, local: S(w * R * 0.16, w * R * 0.16, R * 0.02, -w * R * 0.35, -h * R * 0.4, R * 0.035) }, 1);
  },
  lid(c: Ctx, side: number, w: number, h: number, tilt = 0) {
    w *= FS;
    h *= FS;
    const bone = side > 0 ? B.eyeL : B.eyeR;
    const R = c.R;
    const x = side * c.eye.x * R;
    const y = c.eye.y * c.p.headRy;
    const lid = shadeColor(c.skin, 0.93);
    paint(c, bone, sphere('lo'), lid, { x, y, local: T(0, h * R * 0.62, R * 0.012, 0, 0, side * tilt, w * R * 1.3, h * R * 0.72, R * 0.06) }, 0);
    paint(c, bone, capsule(R * 0.018, w * R * 1.9, 6), EYE_INK, { x, y, local: T(0, h * R * 0.02, R * 0.05, 0, 0, Math.PI / 2 + side * tilt, 1, 1, 0.7) }, 0.6);
  },
  sclera(c: Ctx, side: number, w: number, h: number, pupil: number) {
    w *= FS;
    h *= FS;
    pupil *= FS;
    const bone = side > 0 ? B.eyeL : B.eyeR;
    const R = c.R;
    const x = side * c.eye.x * R;
    const y = c.eye.y * c.p.headRy;
    paint(c, bone, sphere('mid'), WHITE, { x, y, local: S(w * R, h * R, R * 0.04) }, 0.6);
    paint(c, bone, sphere('lo'), EYE_INK, { x, y, local: S(pupil * R, pupil * R * 1.1, R * 0.03, -side * pupil * R * 0.25, -h * R * 0.12, R * 0.03) }, 1);
    paint(c, bone, sphere('lo'), WHITE, { x, y, local: S(pupil * R * 0.3, pupil * R * 0.3, R * 0.02, pupil * R * 0.25, pupil * R * 0.25, R * 0.055) }, 1);
  },
  closed(c: Ctx, side: number, bone: number, up: boolean, r = 0.12) {
    r *= FS;
    const R = c.R;
    const x = side * c.eye.x * R;
    const y = c.eye.y * c.p.headRy;
    // ∩ (happy) or ∪ (sleepy)
    arc(c, bone, x, y, r * R, R * 0.032, Math.PI * 0.8, up ? Math.PI / 2 : -Math.PI / 2, EYE_INK, 0, 0.6, up ? -r * R * 0.55 : r * R * 0.55);
  },
  brow(c: Ctx, side: number, raise: number, angle: number, len = 0.2, thick = 0.034) {
    const bone = side > 0 ? B.browL : B.browR;
    const R = c.R;
    const x = side * (c.eye.x + 0.02) * R;
    const y = c.eye.y * c.p.headRy + (0.3 + raise) * R;
    anchorAt(c, bone, x, y);
    const brow = c.a.hairStyle === 'none' ? shadeColor(c.skin, 0.55) : shadeColor(c.hair, 0.72);
    paint(c, bone, capsule(thick * R, len * R, 6), brow, { x, y, local: T(0, 0, 0, 0, 0, Math.PI / 2 + side * angle, 1, 1, 0.6) }, 0.2);
  },
  mouthArc(c: Ctx, bone: number, w: number, up: boolean, dx = 0, tilt = 0, y = -0.3) {
    const R = c.R;
    const span = Math.PI * 0.75;
    arc(c, bone, dx * R, y * c.p.headRy, w * R, R * 0.03, span, (up ? Math.PI / 2 : -Math.PI / 2) + tilt, MOUTH_DARK, 0, 0.4, up ? -w * R * 0.6 : w * R * 0.6);
  },
  mouthD(c: Ctx, bone: number, w: number, h: number, teeth = false, y = -0.28) {
    const R = c.R;
    const yy = y * c.p.headRy;
    paint(c, bone, lowerHemi(), MOUTH_DARK, { x: 0, y: yy, local: S(w * R, h * R, R * 0.04, 0, h * R * 0.25, 0) }, 0.4);
    paint(c, bone, sphere('lo'), TONGUE, { x: 0, y: yy, local: S(w * R * 0.55, h * R * 0.35, R * 0.03, 0, -h * R * 0.45, R * 0.015) }, 0.3);
    if (teeth) paint(c, bone, capsule(R * 0.03, w * R * 1.2, 6), WHITE, { x: 0, y: yy, local: T(0, h * R * 0.12, R * 0.02, 0, 0, Math.PI / 2, 1, 1, 0.6) }, 0.5);
  },
  mouthO(c: Ctx, bone: number, w: number, h: number, y = -0.31) {
    const R = c.R;
    paint(c, bone, sphere('lo'), MOUTH_DARK, { x: 0, y: y * c.p.headRy, local: S(w * R, h * R, R * 0.04) }, 0.4);
  },
  cheeks(c: Ctx, strength = 0.5, size = 1) {
    const R = c.R;
    const col = mix(c.skin, BLUSH, strength);
    for (const s of [1, -1]) paint(c, B.head, sphere('lo'), col, { x: s * (c.eye.x + 0.2) * R, y: (c.eye.y - 0.42) * c.p.headRy, lift: -R * 0.012, local: S(R * 0.14 * size, R * 0.085 * size, R * 0.04) }, 0);
  },
  freckles(c: Ctx) {
    const R = c.R;
    const col = shadeColor(mix(c.skin, '#7a4a35', 0.45), 1);
    for (const s of [1, -1])
      for (const [dx, dy] of [[0.12, -0.34], [0.24, -0.3], [0.18, -0.44]] as const)
        paint(c, B.head, sphere('lo'), col, { x: s * (c.eye.x + dx - 0.05) * R, y: (c.eye.y + dy) * c.p.headRy, lift: -R * 0.004, local: S(R * 0.022, R * 0.022, R * 0.02) }, 0);
  },
};

let _lowerHemi: BufferGeometry | null = null;
function lowerHemi(): BufferGeometry {
  return (_lowerHemi ??= new SphereGeometry(1, 12, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2));
}

type FaceBuilder = (c: Ctx) => void;

/** Eye placement (in units of headRx / headRy) per face. */
const FACE_EYES: Record<FaceId, { x: number; y: number }> = {
  smile: { x: 0.35, y: 0.1 },
  calm: { x: 0.35, y: 0.1 },
  grin: { x: 0.36, y: 0.12 },
  sleepy: { x: 0.36, y: 0.07 },
  surprised: { x: 0.35, y: 0.12 },
  wink: { x: 0.35, y: 0.1 },
  button: { x: 0.43, y: 0.05 },
  starry: { x: 0.37, y: 0.1 },
  grumpy: { x: 0.34, y: 0.08 },
};
/** Global face scale: features are painted big so they read from the iso camera. */
const FS = 1.15;

export const FACE_BUILDERS: Record<FaceId, FaceBuilder> = {
  smile(c) {
    for (const s of [1, -1]) {
      FaceKit.bead(c, s, 0.12, 0.16);
      FaceKit.brow(c, s, 0, -0.12);
    }
    FaceKit.mouthArc(c, B.mouth, 0.15, false);
    FaceKit.cheeks(c, 0.45);
  },
  calm(c) {
    for (const s of [1, -1]) {
      FaceKit.bead(c, s, 0.12, 0.14);
      FaceKit.lid(c, s, 0.12, 0.14, -0.05);
      FaceKit.brow(c, s, -0.02, 0.02, 0.22, 0.03);
    }
    FaceKit.mouthArc(c, B.mouth, 0.09, false, 0.02);
    FaceKit.cheeks(c, 0.25, 0.9);
  },
  grin(c) {
    for (const s of [1, -1]) {
      FaceKit.bead(c, s, 0.14, 0.17);
      FaceKit.brow(c, s, 0.06, -0.2);
    }
    FaceKit.mouthD(c, B.mouth, 0.2, 0.16, true);
    FaceKit.cheeks(c, 0.5);
  },
  sleepy(c) {
    for (const s of [1, -1]) {
      FaceKit.closed(c, s, s > 0 ? B.eyeL : B.eyeR, false, 0.12);
      FaceKit.brow(c, s, -0.03, 0.22, 0.2, 0.03);
    }
    FaceKit.mouthO(c, B.mouth, 0.05, 0.06);
    FaceKit.cheeks(c, 0.6, 1.15);
  },
  surprised(c) {
    for (const s of [1, -1]) {
      FaceKit.sclera(c, s, 0.15, 0.18, 0.07);
      FaceKit.brow(c, s, 0.12, -0.28, 0.18);
    }
    FaceKit.mouthO(c, B.mouth, 0.07, 0.09);
  },
  wink(c) {
    FaceKit.bead(c, 1, 0.12, 0.16);
    FaceKit.closed(c, -1, B.eyeR, true, 0.11);
    FaceKit.brow(c, 1, 0.07, -0.18);
    FaceKit.brow(c, -1, -0.04, 0.12);
    FaceKit.mouthArc(c, B.mouth, 0.13, false, 0.05, 0.25);
    FaceKit.cheeks(c, 0.5);
  },
  button(c) {
    for (const s of [1, -1]) FaceKit.bead(c, s, 0.075, 0.085);
    // ω cat mouth
    for (const s of [1, -1]) FaceKit.mouthArc(c, B.mouth, 0.06, false, s * 0.06, 0, -0.25);
    FaceKit.cheeks(c, 0.35, 0.8);
    FaceKit.freckles(c);
  },
  starry(c) {
    for (const s of [1, -1]) {
      FaceKit.bead(c, s, 0.155, 0.2, new Color('#35283f'), 2);
      FaceKit.brow(c, s, 0.08, -0.14, 0.16, 0.028);
    }
    FaceKit.mouthD(c, B.mouth, 0.11, 0.1, false, -0.3);
    FaceKit.cheeks(c, 0.55);
  },
  grumpy(c) {
    for (const s of [1, -1]) {
      FaceKit.bead(c, s, 0.11, 0.13);
      FaceKit.lid(c, s, 0.11, 0.13, 0.25);
      FaceKit.brow(c, s, -0.04, 0.42, 0.22, 0.045);
    }
    FaceKit.mouthArc(c, B.mouth, 0.12, true, -0.03, 0.12, -0.36);
  },
};

function buildFace(c: Ctx) {
  const face = (FACE_BUILDERS[c.a.face] ? c.a.face : DEFAULT_APPEARANCE.face) as FaceId;
  c.eye = FACE_EYES[face];
  const R = c.R;
  for (const [bone, side] of [[B.eyeL, 1], [B.eyeR, -1], [B.eyeHappyL, 1], [B.eyeHappyR, -1]] as const) anchorAt(c, bone, side * c.eye.x * R, c.eye.y * c.p.headRy);
  for (const [bone, side] of [[B.browL, 1], [B.browR, -1]] as const) anchorAt(c, bone, side * (c.eye.x + 0.02) * R, c.eye.y * c.p.headRy + 0.3 * R);
  anchorAt(c, B.mouth, 0, -0.3 * c.p.headRy);
  anchorAt(c, B.mouthHappy, 0, -0.28 * c.p.headRy);
  anchorAt(c, B.mouthO, 0, -0.31 * c.p.headRy);
  FACE_BUILDERS[face](c);
  // Shared expression layers: happy ^ ^ eyes + open smile, and a focused "o".
  for (const s of [1, -1]) FaceKit.closed(c, s, s > 0 ? B.eyeHappyL : B.eyeHappyR, true, 0.12);
  FaceKit.mouthD(c, B.mouthHappy, 0.17, 0.15, false);
  FaceKit.mouthO(c, B.mouthO, 0.055, 0.07);
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------

interface HairKit {
  /** Ellipsoid in head-centre coords, units of R; `top` parts are dropped under hats. */
  part(x: number, y: number, z: number, sx: number, sy: number, sz: number, o?: { top?: boolean; rx?: number; ry?: number; rz?: number; bone?: number; detail?: 'hi' | 'mid' | 'lo' }): void;
  /** Molded shell following the head with a smooth hairline. */
  cap(h: HairlineSpec): void;
}

function hairKit(c: Ctx): HairKit {
  const R = c.R;
  const col = c.hair;
  const kit: HairKit = {
    part(x, y, z, sx, sy, sz, o = {}) {
      if (o.top && c.hasHat) return;
      blob(c, o.bone ?? B.head, c.hc.x + x * R, c.hc.y + y * R, c.hc.z + z * R, sx * R, sy * R, sz * R, col, { rx: o.rx, ry: o.ry, rz: o.rz, gloss: 0.22, shade: 0.2, detail: o.detail ?? 'mid', space: B.head });
    },
    cap(h) {
      const hh = c.hasHat ? { ...h, bulk: Math.min(h.bulk ?? 0, 0.04) } : h;
      c.capScale = Math.max(c.capScale, 1 + hh.thick + (hh.bulk ?? 0) * 0.5 + 0.03);
      c.b.add(hairShell(c.p.headRx, c.p.headRy, c.p.headN, hh), B.head, H(c, 0, 0, 0), col, { gloss: 0.22, shade: 0.14 });
    },
  };
  return kit;
}

type HairBuilder = (k: HairKit, c: Ctx) => void;

export const HAIR_BUILDERS: Record<HairStyleId, HairBuilder> = {
  none() {},
  buzz(k) {
    k.cap({ front: 0.52, side: 0.05, back: -0.42, thick: 0.04 });
  },
  bob(k, c) {
    k.cap({ front: 0.5, side: -0.62, back: -0.72, thick: 0.07, bulk: 0.16 });
    k.part(0, 0.66, 0.46, 0.86, 0.26, 0.42, { top: true });
    // chunky side panels framing the face
    for (const s of [1, -1]) k.part(s * 0.86, -0.28, -0.02, 0.28, 0.5, 0.42, { rz: s * 0.08 });
  },
  bun(k) {
    k.cap({ front: 0.46, side: 0.0, back: -0.5, thick: 0.05 });
    k.part(0, 1.02, -0.32, 0.4, 0.38, 0.4, { top: true, detail: 'hi' });
    k.part(0, 0.86, -0.26, 0.3, 0.1, 0.3, { top: true });
  },
  curly(k, c) {
    k.cap({ front: 0.46, side: -0.1, back: -0.55, thick: 0.06 });
    const ry = c.p.headRy / c.R;
    const els = [-0.25, 0.1, 0.45, 0.8, 1.2];
    for (const el of els) {
      const n = el > 1 ? 3 : 7;
      for (let i = 0; i < n; i++) {
        const az = (i / n) * Math.PI * 2 + el * 1.7;
        const front = Math.cos(az); // +1 = facing forward
        if (front > 0.45 && el < 0.6) continue;
        const d = 1.0;
        const x = Math.sin(az) * Math.cos(el) * d;
        const z = Math.cos(az) * Math.cos(el) * d - 0.08;
        const y = Math.sin(el) * d * ry + 0.06;
        const r = 0.3 + ((i * 7 + Math.round(el * 10)) % 3) * 0.03;
        k.part(x, y, z, r, r, r, { top: el > 0.4, detail: 'lo' });
      }
    }
    k.part(0, 0.98 * ry + 0.08, 0.05, 0.42, 0.3, 0.42, { top: true });
    // fringe curls
    for (const s of [-1, 0, 1]) k.part(s * 0.32, 0.72, 0.56, 0.24, 0.22, 0.22, { top: true, detail: 'lo' });
  },
  long(k, c) {
    k.cap({ front: 0.52, side: -0.5, back: -0.8, thick: 0.07, bulk: 0.1 });
    k.part(0.12, 0.66, 0.44, 0.84, 0.25, 0.42, { top: true, rz: -0.18 });
    k.part(0, -0.55, -0.52, 0.95, 0.85, 0.42, { bone: B.hairBack });
    for (const s of [1, -1]) k.part(s * 0.84, -0.55, 0.02, 0.24, 0.6, 0.28, { rz: s * 0.06 });
  },
  ponytail(k) {
    k.cap({ front: 0.44, side: 0.0, back: -0.45, thick: 0.05 });
    k.part(0, 0.42, -0.98, 0.14, 0.14, 0.12);
    k.part(0, 0.32, -1.18, 0.27, 0.3, 0.27, { bone: B.hairBack });
    k.part(0, -0.08, -1.3, 0.23, 0.3, 0.23, { bone: B.hairBack });
    k.part(0, -0.44, -1.3, 0.15, 0.22, 0.15, { bone: B.hairBack });
    k.part(0.1, 0.66, 0.5, 0.6, 0.2, 0.34, { top: true, rz: -0.25 });
  },
  swoop(k) {
    k.cap({ front: 0.5, side: 0.02, back: -0.45, thick: 0.05 });
    k.part(0.2, 0.74, 0.38, 0.8, 0.34, 0.56, { top: true, rz: -0.35 });
    k.part(-0.62, 0.9, 0.2, 0.3, 0.22, 0.3, { top: true, rz: 0.5 });
  },
  spiky(k, c) {
    k.cap({ front: 0.5, side: 0.08, back: -0.4, thick: 0.05 });
    if (c.hasHat) return;
    const R = c.R;
    const ry = c.p.headRy / R;
    const dirs: [number, number][] = [
      [0, 1.35], [0.5, 1.0], [-0.5, 1.0], [1.4, 0.55], [-1.4, 0.55], [2.4, 0.6], [-2.4, 0.6], [Math.PI, 0.75], [0.25, 0.55], [-0.3, 0.6],
    ];
    const spike = lathe('spike', [[0.0, 0], [0.2, 0.0], [0.17, 0.2], [0.09, 0.42], [0.02, 0.55], [0, 0.56]], 10, 2);
    for (const [az, el] of dirs) {
      const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
      const base = new Vector3(dir.x * 0.85, dir.y * 0.85 * ry + 0.08, dir.z * 0.85 - 0.06).multiplyScalar(R);
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir);
      const mm = new Matrix4().compose(new Vector3(c.hc.x + base.x, c.hc.y + base.y, c.hc.z + base.z), q, new Vector3(R, R * 1.1, R));
      c.b.add(spike, B.head, mm, c.hair, { gloss: 0.22, shade: 0.25 });
    }
  },
  afro(k, c) {
    if (c.hasHat) {
      k.cap({ front: 0.42, side: -0.2, back: -0.55, thick: 0.06 });
      for (const s of [1, -1]) k.part(s * 0.92, -0.05, -0.25, 0.48, 0.5, 0.5, { detail: 'hi' });
      k.part(0, -0.05, -0.75, 0.6, 0.5, 0.45);
      return;
    }
    k.cap({ front: 0.42, side: -0.2, back: -0.55, thick: 0.08 });
    // a soft cloud of big puffs around the head (bumpy silhouette, face left open)
    const ry = c.p.headRy / c.R;
    for (const [el, n, d, r] of [[1.25, 1, 0.75, 0.62], [0.75, 6, 0.95, 0.5], [0.25, 7, 1.08, 0.5], [-0.25, 6, 1.05, 0.46]] as const) {
      for (let i = 0; i < n; i++) {
        const az = n === 1 ? 0 : (i / n) * Math.PI * 2 + el;
        if (Math.cos(az) > 0.35 && el < 0.6) continue;
        const x = Math.sin(az) * Math.cos(el) * d;
        const z = Math.cos(az) * Math.cos(el) * d - 0.22;
        const y = Math.sin(el) * d * ry + 0.25;
        k.part(x, y, z, r, r * 0.95, r, { detail: 'mid' });
      }
    }
  },
  pigtails(k) {
    k.cap({ front: 0.42, side: -0.15, back: -0.5, thick: 0.05 });
    k.part(0, 0.68, 0.44, 0.7, 0.2, 0.38, { top: true });
    for (const s of [1, -1]) {
      k.part(s * 0.98, 0.2, -0.28, 0.12, 0.12, 0.12);
      k.part(s * 1.24, -0.06, -0.32, 0.27, 0.36, 0.27, { rz: s * 0.45, bone: B.hairBack });
    }
  },
  mohawk(k, c) {
    if (c.hasHat) return;
    const ry = c.p.headRy / c.R;
    for (let i = 0; i < 6; i++) {
      const th = 0.35 + i * 0.42; // from front-top to back
      const y = Math.cos(th - 0.9) * 0.98 * ry + 0.05;
      const z = Math.sin(th - 0.9) * -0.98 + 0.0;
      const s = 1 - Math.abs(i - 2) * 0.12;
      k.part(0, y + 0.16 * s, z, 0.2, 0.38 * s, 0.26, { top: true, rx: -(th - 0.9) });
    }
  },
};

// ---------------------------------------------------------------------------
// Torso, arms, legs, clothes
// ---------------------------------------------------------------------------

type ShirtBuilder = (c: Ctx) => void;

function torsoBase(c: Ctx, bulk = 1, color = c.shirt) {
  const { p } = c;
  c.b.add(lathe(`torso-${c.a.body}-${bulk}`, torsoProfile(p, bulk), 20, 2), B.spine, T(0, 0, 0, 0, 0, 0, 1, 1, p.depth), color, { shade: 0.16 });
}

function ring(c: Ctx, bone: number, y: number, r: number, tube: number, color: Color, depth = c.p.depth) {
  c.b.add(torus(r, tube, Math.PI * 2, 5, 18), bone, T(0, y, 0, Math.PI / 2, 0, 0, 1, depth, 1), color, { shade: 0.05 });
}

/** Front surface z of the torso at height y. */
function frontZ(c: Ctx, y: number, bulk = 1) {
  return torsoRadius(c.p, y, bulk) * c.p.depth;
}

type Sleeve = 'short' | 'long' | 'puff' | 'none';

function arms(c: Ctx, sleeve: Sleeve, sleeveColor: Color) {
  const { p } = c;
  for (const [sh, el, side] of [[B.shoulderL, B.elbowL, 1], [B.shoulderR, B.elbowR, -1]] as const) {
    const upperCol = sleeve === 'long' || sleeve === 'short' ? sleeveColor : c.skin;
    // shoulder ball
    blob(c, sh, 0, -0.005, 0, p.armR * 1.25, p.armR * 1.25, p.armR * 1.2, sleeve === 'none' ? c.skin : sleeveColor);
    c.b.add(capsule(p.armR, p.upperArm, 10), sh, T(0, -p.upperArm / 2, 0), sleeve === 'long' ? upperCol : c.skin, { shade: 0.1 });
    if (sleeve === 'short') c.b.add(capsule(p.armR * 1.22, p.upperArm * 0.35, 10), sh, T(0, -p.upperArm * 0.22, 0), sleeveColor, { shade: 0.1 });
    if (sleeve === 'puff') blob(c, sh, side * 0.01, -p.upperArm * 0.12, 0, p.armR * 1.65, p.armR * 1.45, p.armR * 1.55, sleeveColor);
    // elbow + forearm
    blob(c, el, 0, 0, 0, p.armR * 0.98, p.armR * 0.98, p.armR * 0.98, sleeve === 'long' ? sleeveColor : c.skin, { detail: 'lo' });
    c.b.add(capsule(p.armR * 0.95, p.foreArm, 10), el, T(0, -p.foreArm / 2, 0), sleeve === 'long' ? sleeveColor : c.skin, { shade: 0.1 });
    if (sleeve === 'long') c.b.add(torus(p.armR * 1.02, p.armR * 0.32, Math.PI * 2, 6, 14), el, T(0, -p.foreArm + 0.01, 0, Math.PI / 2, 0, 0), shadeColor(sleeveColor, 0.88));
    // mitten hand + thumb
    const hy = -p.foreArm - p.handR * 0.55;
    blob(c, el, 0, hy, 0.005, p.handR, p.handR * 1.08, p.handR * 0.9, c.skin, { shade: 0.08 });
    blob(c, el, side * -p.handR * 0.15, hy + p.handR * 0.2, p.handR * 0.7, p.handR * 0.38, p.handR * 0.48, p.handR * 0.38, c.skin, { detail: 'lo', rx: 0.4 });
  }
}

export const SHIRT_BUILDERS: Record<ShirtStyleId, ShirtBuilder> = {
  tee(c) {
    const { p } = c;
    torsoBase(c);
    ring(c, B.spine, 0.0, p.rBot * 0.98, 0.022, shadeColor(c.shirt, 0.86));
    ring(c, B.spine, p.torsoH * 0.985, p.rNeck * 1.25, 0.02, shadeColor(c.shirt, 0.82));
    // little round chest badge in the accent colour
    const y = p.torsoH * 0.55;
    blob(c, B.spine, p.rMid * 0.35, y, frontZ(c, y) - 0.004, 0.045, 0.045, 0.015, c.accent, { gloss: 0.3 });
    arms(c, 'short', c.shirt);
  },
  sweater(c) {
    const { p } = c;
    torsoBase(c, 1.05);
    ring(c, B.spine, 0.0, p.rBot * 1.04, 0.032, shadeColor(c.shirt, 0.88));
    ring(c, B.spine, p.torsoH * 0.97, p.rNeck * 1.35, 0.042, shadeColor(c.shirt, 0.92));
    // knit stripe band across the chest
    const y = p.torsoH * 0.56;
    c.b.add(cylinder(torsoRadius(p, y + 0.03, 1.05) + 0.006, torsoRadius(p, y - 0.03, 1.05) + 0.006, 0.065, 22), B.spine, T(0, y, 0, 0, 0, 0, 1, 1, p.depth), c.accent, { shade: 0 });
    arms(c, 'long', c.shirt);
  },
  overalls(c) {
    const { p } = c;
    torsoBase(c);
    const y0 = p.torsoH * 0.12;
    const y1 = p.torsoH * 0.62;
    const ym = (y0 + y1) / 2;
    const w = p.rMid * 1.2;
    c.b.add(roundedBox(w, y1 - y0, 0.06, 0.02), B.spine, T(0, ym, frontZ(c, ym) - 0.018, -0.06), c.pants, { shade: 0.1 });
    // waist panel wraps around
    c.b.add(cylinder(torsoRadius(p, y0 + 0.08) + 0.008, torsoRadius(p, -0.02) + 0.01, 0.12, 22), B.spine, T(0, 0.03, 0, 0, 0, 0, 1, 1, p.depth), c.pants, { shade: 0.1 });
    // straps over the shoulders + brass buttons
    for (const s of [1, -1]) {
      c.b.add(roundedBox(0.045, p.torsoH * 0.42, 0.03, 0.012), B.spine, T(s * w * 0.36, p.torsoH * 0.78, frontZ(c, p.torsoH * 0.78) - 0.01, -0.35), c.pants);
      blob(c, B.spine, s * w * 0.36, y1 - 0.02, frontZ(c, y1) + 0.012, 0.018, 0.018, 0.01, GOLD, { gloss: 0.9, detail: 'lo' });
    }
    // front pocket
    c.b.add(roundedBox(w * 0.42, 0.06, 0.02, 0.008), B.spine, T(0, ym + 0.01, frontZ(c, ym) + 0.014, -0.06), shadeColor(c.pants, 0.86));
    arms(c, 'short', c.shirt);
  },
  jacket(c) {
    const { p } = c;
    torsoBase(c, 1.06);
    ring(c, B.spine, 0.0, p.rBot * 1.06, 0.026, shadeColor(c.shirt, 0.82));
    // inner shirt V + lapels
    const yc = p.torsoH * 0.72;
    c.b.add(roundedBox(0.09, p.torsoH * 0.42, 0.03, 0.012), B.spine, T(0, yc, frontZ(c, yc, 1.06) - 0.004, -0.2), mix(c.accent, '#efe4cf', 0.6));
    for (const s of [1, -1]) {
      c.b.add(roundedBox(0.075, p.torsoH * 0.36, 0.03, 0.012), B.spine, T(s * 0.06, yc + 0.01, frontZ(c, yc, 1.06) + 0.003, -0.22, 0, s * 0.32), shadeColor(c.shirt, 0.84));
      c.b.add(roundedBox(0.09, 0.055, 0.02, 0.008), B.spine, T(s * p.rMid * 0.5, p.torsoH * 0.22, frontZ(c, p.torsoH * 0.22, 1.06) - 0.004, -0.05), shadeColor(c.shirt, 0.86));
    }
    for (let i = 0; i < 2; i++) blob(c, B.spine, 0.0, p.torsoH * (0.32 + i * 0.15), frontZ(c, p.torsoH * (0.32 + i * 0.15), 1.06) + 0.004, 0.016, 0.016, 0.01, shadeColor(c.shirt, 0.6), { gloss: 0.7, detail: 'lo' });
    arms(c, 'long', c.shirt);
  },
  dress(c) {
    const { p } = c;
    torsoBase(c);
    // Peter Pan collar
    for (const s of [1, -1]) blob(c, B.spine, s * p.rNeck * 0.85, p.torsoH * 0.96, p.rNeck * 0.7, p.rNeck * 0.9, 0.025, p.rNeck * 0.7, WHITE, { rz: -s * 0.25, rx: 0.3 });
    // flared skirt on the hips (swings with the pelvis, not the chest)
    const L = p.thigh * 0.62 + 0.05;
    const r0 = p.rBot * 1.02;
    skirt(c, `dress-${c.a.body}`, r0, L, 1.3, c.shirt);
    arms(c, 'puff', c.shirt);
  },
};

function skirt(c: Ctx, key: string, r0: number, L: number, flare: number, color: Color) {
  // (listed bottom-up so lathe faces point outward)
  const pts: [number, number][] = [
    [r0 * (flare * 0.75), -0.02 - L + 0.015],
    [r0 * flare * 0.95, -0.02 - L - 0.012],
    [r0 * flare, -0.02 - L],
    [r0 * (1 + (flare - 1) * 0.6), -0.02 - L * 0.65],
    [r0 * 1.06, -0.02],
    [r0 * 0.95, 0.06],
    [0, 0.06],
  ];
  c.b.add(lathe(`skirt-${key}`, pts, 20, 2), B.hips, T(0, 0, 0, 0, 0, 0, 1, 1, c.p.depth + 0.05), color, { shade: 0.18 });
}

type PantsBuilder = (c: Ctx) => void;

function pelvis(c: Ctx, color: Color) {
  const { p } = c;
  const pts: [number, number][] = [
    [0, -0.135],
    [p.hipX + p.legR * 0.6, -0.13],
    [p.rBot * 0.98, -0.07],
    [p.rBot * 1.0, 0.0],
    [p.rBot * 0.95, 0.06],
    [0, 0.065],
  ];
  c.b.add(lathe(`pelvis-${c.a.body}`, pts, 18, 2), B.hips, T(0, 0, 0, 0, 0, 0, 1, 1, p.depth), color, { shade: 0.2 });
}

function legs(c: Ctx, thighCol: Color, shinCol: Color, cuff?: Color, shortsCol?: Color) {
  const { p } = c;
  for (const [hip, knee] of [[B.hipL, B.kneeL], [B.hipR, B.kneeR]] as const) {
    c.b.add(capsule(p.legR, p.thigh, 10), hip, T(0, -p.thigh / 2, 0), thighCol, { shade: 0.12 });
    if (shortsCol) c.b.add(capsule(p.legR * 1.22, p.thigh * 0.45, 10), hip, T(0, -p.thigh * 0.15, 0), shortsCol, { shade: 0.12 });
    blob(c, knee, 0, 0, 0, p.legR * 0.97, p.legR * 0.97, p.legR * 0.97, shinCol, { detail: 'lo' });
    c.b.add(capsule(p.legR * 0.93, p.shin, 10), knee, T(0, -p.shin / 2, 0), shinCol, { shade: 0.12 });
    if (cuff) c.b.add(torus(p.legR * 0.98, p.legR * 0.3, Math.PI * 2, 6, 14), knee, T(0, -p.shin + 0.02, 0, Math.PI / 2, 0, 0), cuff);
  }
}

export const PANTS_BUILDERS: Record<PantsStyleId, PantsBuilder> = {
  trousers(c) {
    pelvis(c, c.pants);
    legs(c, c.pants, c.pants, shadeColor(c.pants, 0.86));
    ring(c, B.hips, 0.045, c.p.rBot * 0.97, 0.016, shadeColor(c.pants, 0.78));
  },
  shorts(c) {
    pelvis(c, c.pants);
    legs(c, c.skin, c.skin, undefined, c.pants);
    ring(c, B.hips, 0.045, c.p.rBot * 0.97, 0.016, shadeColor(c.pants, 0.78));
  },
  skirt(c) {
    pelvis(c, c.pants);
    legs(c, c.skin, c.skin);
    skirt(c, `skirt-${c.a.body}`, c.p.rBot * 1.0, c.p.thigh * 0.5 + 0.03, 1.22, c.pants);
  },
};

type ShoeBuilder = (c: Ctx) => void;

function eachFoot(c: Ctx, fn: (knee: number, y: number, f: number) => void) {
  for (const knee of [B.kneeL, B.kneeR]) fn(knee, -c.p.shin - c.p.ankle, c.p.foot);
}

export const SHOE_BUILDERS: Record<ShoeStyleId, ShoeBuilder> = {
  sneakers(c) {
    eachFoot(c, (k, y, f) => {
      blob(c, k, 0, y + 0.055 * f, 0.04 * f, 0.095 * f, 0.065 * f, 0.135 * f, c.shoe, { shade: 0.15 });
      blob(c, k, 0, y + 0.018 * f, 0.04 * f, 0.1 * f, 0.026 * f, 0.142 * f, SOLE, { shade: 0.05 });
      blob(c, k, 0, y + 0.08 * f, 0.07 * f, 0.05 * f, 0.025 * f, 0.06 * f, mix(c.shoe, '#ffffff', 0.55), { rx: -0.4, detail: 'lo' });
    });
  },
  boots(c) {
    eachFoot(c, (k, y, f) => {
      c.b.add(cylinder(c.p.legR * 1.12, c.p.legR * 1.2, c.p.shin * 0.55 + 0.04, 14), k, T(0, y + (c.p.shin * 0.55 + 0.04) / 2 + 0.04, 0), c.shoe, { shade: 0.2, gloss: 0.25 });
      c.b.add(torus(c.p.legR * 1.14, 0.018, Math.PI * 2, 6, 14), k, T(0, y + c.p.shin * 0.55 + 0.08, 0, Math.PI / 2, 0, 0), shadeColor(c.shoe, 0.8), { gloss: 0.25 });
      blob(c, k, 0, y + 0.06 * f, 0.04 * f, 0.1 * f, 0.07 * f, 0.14 * f, c.shoe, { shade: 0.15, gloss: 0.3 });
      blob(c, k, 0, y + 0.016 * f, 0.035 * f, 0.104 * f, 0.024 * f, 0.146 * f, DARK_SOLE, { shade: 0.05 });
    });
  },
  sandals(c) {
    eachFoot(c, (k, y, f) => {
      blob(c, k, 0, y + 0.045 * f, 0.04 * f, 0.08 * f, 0.05 * f, 0.12 * f, c.skin, { shade: 0.1 });
      blob(c, k, 0, y + 0.012 * f, 0.04 * f, 0.095 * f, 0.016 * f, 0.14 * f, c.shoe, { shade: 0.05 });
      c.b.add(torus(0.075 * f, 0.014, Math.PI, 6, 10), k, T(0, y + 0.03 * f, 0.07 * f, 0, Math.PI / 2, 0, 1, 1, 1.05), c.shoe);
      c.b.add(torus(0.07 * f, 0.014, Math.PI, 6, 10), k, T(0, y + 0.03 * f, -0.01 * f, 0, Math.PI / 2, 0, 1, 1.1, 1.05), c.shoe);
    });
  },
};

// ---------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------

type AccBuilder = (c: Ctx) => void;

export const HAT_BUILDERS: Record<HatId, AccBuilder> = {
  none() {},
  beanie(c) {
    const R = c.R;
    const k = c.capScale * 1.05;
    const ry = c.p.headRy;
    const cy = 0.08 * R;
    const th = Math.PI * 0.47;
    const col = c.accent;
    c.b.add(sphereCap(th, 'hi'), B.head, H(c, 0, cy, -0.06 * R, -0.28, 0, 0, k * R, k * ry * 1.1, k * R), col, { shade: 0.18 });
    const rimY = cy + Math.cos(th) * k * ry * 1.1;
    c.b.add(torus(k * R * Math.sin(th) * 1.0, 0.1 * R, Math.PI * 2, 8, 28), B.head, H(c, 0, rimY + 0.04 * R, -0.06 * R, Math.PI / 2 - 0.28, 0, 0), shadeColor(col, 0.88));
    blob(c, B.head, c.hc.x, c.hc.y + cy + k * ry * 1.1 + 0.1 * R, c.hc.z - 0.36 * R, 0.24 * R, 0.24 * R, 0.24 * R, mix(col, '#fff6e6', 0.45), { detail: 'mid' });
  },
  cap(c) {
    const R = c.R;
    const k = c.capScale * 1.0;
    const ry = c.p.headRy;
    const cy = 0.22 * ry;
    c.b.add(sphereCap(Math.PI * 0.5, 'hi'), B.head, H(c, 0, cy, -0.04 * R, -0.12, 0, 0, k * R, 0.92 * ry * k, k * R), c.shoe, { shade: 0.15 });
    blob(c, B.head, c.hc.x, c.hc.y + cy + 0.06 * R, c.hc.z + k * R * 0.9, 0.6 * R, 0.045 * R, 0.48 * R, shadeColor(c.shoe, 0.9), { rx: 0.05 });
    blob(c, B.head, c.hc.x, c.hc.y + cy + 0.92 * ry * k - 0.03 * R, c.hc.z - 0.15 * R, 0.08 * R, 0.05 * R, 0.08 * R, shadeColor(c.shoe, 0.85), { detail: 'lo' });
  },
  sunhat(c) {
    const R = c.R;
    const k = c.capScale;
    const ry = c.p.headRy;
    const cy = 0.3 * ry;
    c.b.add(sphereCap(Math.PI * 0.5, 'hi'), B.head, H(c, 0, cy, -0.04 * R, -0.42, 0, 0, k * 0.97 * R, 0.95 * ry, k * 0.97 * R), STRAW, { shade: 0.15 });
    const brim = lathe(`sunbrim-${(k * R).toFixed(3)}`, [[k * 0.9 * R, 0.01 * R], [1.38 * R, -0.04 * R], [1.5 * R, -0.09 * R], [1.44 * R, -0.12 * R], [k * 0.9 * R, -0.04 * R]].reverse() as [number, number][], 32, 3);
    c.b.add(brim, B.head, H(c, 0, cy + 0.02 * R, -0.04 * R, -0.42, 0, 0), STRAW, { shade: 0.1 });
    c.b.add(torus(k * 0.97 * R, 0.08 * R, Math.PI * 2, 6, 28), B.head, H(c, 0, cy + 0.1 * R, -0.08 * R, Math.PI / 2 - 0.42, 0, 0), c.accent);
  },
  beret(c) {
    const R = c.R;
    const k = c.capScale;
    const ry = c.p.headRy;
    blob(c, B.head, c.hc.x + 0.12 * R, c.hc.y + 0.66 * ry * k, c.hc.z - 0.06 * R, 1.12 * k * R, 0.36 * R, 1.08 * k * R, c.accent, { rz: -0.24, rx: -0.08, detail: 'hi', shade: 0.25 });
    c.b.add(capsule(0.035 * R, 0.08 * R, 6), B.head, H(c, 0.32 * R, 0.66 * ry * k + 0.36 * R, -0.06 * R, 0, 0, -0.5), shadeColor(c.accent, 0.8));
  },
  flower(c) {
    const R = c.R;
    const petal = new Color('#ef9fb0');
    const center = new Color('#f2cd5c');
    const pos = new Vector3(0.7 * R * c.capScale, 0.56 * c.p.headRy * c.capScale, 0.42 * R);
    const n = pos.clone().normalize();
    const base = onSurface([c.hc.x + pos.x, c.hc.y + pos.y, c.hc.z + pos.z], [n.x, n.y, n.z]);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      c.b.add(sphere('lo'), B.head, base.clone().multiply(T(Math.cos(a) * 0.13 * R, Math.sin(a) * 0.13 * R, 0, 0, 0, a, 0.13 * R, 0.085 * R, 0.05 * R)), petal, { shade: 0.05 });
    }
    c.b.add(sphere('lo'), B.head, base.clone().multiply(T(0, 0, 0.03 * R, 0, 0, 0, 0.08 * R, 0.08 * R, 0.06 * R)), center, { gloss: 0.4 });
    c.b.add(sphere('lo'), B.head, base.clone().multiply(T(0.1 * R, -0.18 * R, -0.02 * R, 0, 0, -0.8, 0.12 * R, 0.05 * R, 0.03 * R)), new Color('#7fa35a'));
  },
  bucket(c) {
    const R = c.R;
    const k = c.capScale * 1.02;
    const col = mix(c.shoe, '#efe4cf', 0.35);
    const crown = lathe(`bucket-${(k * R).toFixed(3)}`, [[0, 0.5 * R], [0.78 * k * R, 0.48 * R], [0.98 * k * R, 0.05 * R], [1.32 * k * R, -0.16 * R], [1.34 * k * R, -0.21 * R], [1.26 * k * R, -0.2 * R], [0.95 * k * R, -0.02 * R]].reverse() as [number, number][], 28, 3);
    c.b.add(crown, B.head, H(c, 0, 0.62 * c.p.headRy, -0.12 * R, -0.38, 0, 0), col, { shade: 0.2 });
    c.b.add(torus(0.92 * k * R, 0.05 * R, Math.PI * 2, 6, 26), B.head, H(c, 0, 0.62 * c.p.headRy + 0.1 * R, -0.14 * R, Math.PI / 2 - 0.38, 0, 0), shadeColor(col, 0.78));
  },
  sprout(c) {
    const R = c.R;
    const green = new Color('#7fae5c');
    const top = c.hairTop + 0.0;
    const y = top - 0.03 * R;
    c.b.add(capsule(0.045 * R, 0.36 * R, 6), B.head, T(c.hc.x, y + 0.18 * R, c.hc.z, 0, 0, 0.12), shadeColor(green, 0.85));
    for (const s of [1, -1]) blob(c, B.head, c.hc.x + s * 0.26 * R - 0.03 * R, y + 0.44 * R, c.hc.z, 0.3 * R, 0.1 * R, 0.16 * R, green, { rz: s * 0.55, gloss: 0.3 });
  },
  headphones(c) {
    const R = c.R;
    const k = c.capScale;
    const band = new Color('#3e3b3a');
    const rr = 1.08 * k * R;
    c.b.add(torus(rr, 0.055 * R, Math.PI, 8, 24), B.head, H(c, 0, 0.0, -0.06 * R, 0, 0, 0, 1, (c.p.headRy * k * 1.1) / rr + 0.0, 1), band, { gloss: 0.4 });
    for (const s of [1, -1]) {
      c.b.add(cylinder(0.27 * R, 0.27 * R, 0.16 * R, 18), B.head, H(c, s * (rr + 0.02 * R), -0.08 * R, -0.06 * R, 0, 0, Math.PI / 2), c.accent, { gloss: 0.35 });
      blob(c, B.head, c.hc.x + s * (rr + 0.11 * R), c.hc.y - 0.08 * R, c.hc.z - 0.06 * R, 0.05 * R, 0.2 * R, 0.2 * R, band, { detail: 'lo' });
    }
  },
};

function eyeCentre(c: Ctx, side: number, lift: number): { pos: number[]; n: number[] } {
  const x = side * c.eye.x * c.R;
  const y = c.eye.y * c.p.headRy;
  const pt = headFront(c.p, x, y);
  const n = headNormal(c.p, pt[0], pt[1], pt[2]);
  return { pos: [c.hc.x + pt[0] + n[0] * lift, c.hc.y + pt[1] + n[1] * lift, c.hc.z + pt[2] + n[2] * lift], n: [n[0] * 0.4, n[1] * 0.4, 0.6 + n[2] * 0.4] };
}

function glassesFrame(c: Ctx, color: Color, rim: (side: number, m: Matrix4) => void) {
  const R = c.R;
  const lift = 0.09 * R;
  for (const s of [1, -1]) {
    const { pos, n } = eyeCentre(c, s, lift);
    rim(s, onSurface(pos, n));
    // temple arm back to the ear
    c.b.add(capsule(0.018 * R, 0.75 * R, 5), B.head, T(c.hc.x + s * c.p.headRx * 0.98, pos[1]! + 0.02 * R, c.hc.z + 0.32 * R, Math.PI / 2, 0, 0), color, { gloss: 0.6 });
  }
  const l = eyeCentre(c, 1, lift).pos;
  c.b.add(capsule(0.02 * R, c.eye.x * R * 0.9, 5), B.head, T(0, l[1]! + 0.03 * R, l[2]! + 0.01 * R, 0, 0, Math.PI / 2), color, { gloss: 0.6 });
}

export const EYEWEAR_BUILDERS: Record<EyewearId, AccBuilder> = {
  none() {},
  round(c) {
    const R = c.R;
    const col = new Color('#3b2a22');
    glassesFrame(c, col, (_s, m) => c.b.add(torus(0.2 * R, 0.028 * R, Math.PI * 2, 6, 20), B.head, m, col, { gloss: 0.7 }));
  },
  square(c) {
    const R = c.R;
    const col = new Color('#6b4430');
    glassesFrame(c, col, (_s, m) => c.b.add(torus(0.24 * R, 0.035 * R, Math.PI * 2, 6, 4), B.head, m.clone().multiply(T(0, 0, 0, 0, 0, Math.PI / 4, 1.12, 0.86, 1)), col, { gloss: 0.6 }));
  },
  shades(c) {
    const R = c.R;
    const col = new Color('#1c1f25');
    glassesFrame(c, col, (_s, m) => c.b.add(sphere('mid'), B.head, m.clone().multiply(T(0, 0, 0, 0, 0, 0, 0.24 * R, 0.19 * R, 0.05 * R)), col, { gloss: 1 }));
  },
  monocle(c) {
    const R = c.R;
    const { pos, n } = eyeCentre(c, -1, 0.08 * R);
    c.b.add(torus(0.21 * R, 0.03 * R, Math.PI * 2, 6, 20), B.head, onSurface(pos, n), GOLD, { gloss: 0.9 });
    for (let i = 1; i <= 4; i++) blob(c, B.head, pos[0]! - 0.04 * R * i, pos[1]! - 0.2 * R - 0.11 * R * i, pos[2]! - 0.05 * R * i, 0.022 * R, 0.022 * R, 0.022 * R, GOLD, { gloss: 0.9, detail: 'lo' });
  },
};

export const NECK_BUILDERS: Record<NeckId, AccBuilder> = {
  none() {},
  scarf(c) {
    const { p } = c;
    const y = p.torsoH * 0.96;
    const col = c.accent;
    c.b.add(torus(p.rNeck * 1.25 + 0.06, 0.085, Math.PI * 2, 8, 24), B.spine, T(0, y - 0.02, 0.01, Math.PI / 2, 0, 0, 1.12, p.depth * 1.1, 1.25), col, { shade: 0.15 });
    c.b.add(torus(p.rNeck * 1.25 + 0.03, 0.05, Math.PI * 2, 8, 24), B.spine, T(0, y + 0.06, 0.0, Math.PI / 2, 0, 0, 1.05, p.depth * 1.05, 1), shadeColor(col, 0.9), { shade: 0.1 });
    const ty = y - p.torsoH * 0.2;
    c.b.add(roundedBox(0.11, p.torsoH * 0.36, 0.045, 0.02), B.spine, T(p.rNeck * 0.8, ty, frontZ(c, ty) + 0.04, -0.18, 0, 0.18), shadeColor(col, 0.95), { shade: 0.15 });
    // fringe stripe
    c.b.add(roundedBox(0.115, 0.03, 0.05, 0.012), B.spine, T(p.rNeck * 0.8 + 0.03, ty - p.torsoH * 0.15, frontZ(c, ty) + 0.05, -0.18, 0, 0.18), shadeColor(col, 0.75));
  },
  bowtie(c) {
    const { p } = c;
    const y = p.torsoH * 0.9;
    const z = frontZ(c, y) + 0.02;
    for (const s of [1, -1]) blob(c, B.spine, s * 0.06, y, z, 0.06, 0.045, 0.03, c.accent, { rz: s * 0.15, shade: 0.1 });
    blob(c, B.spine, 0, y, z + 0.012, 0.025, 0.03, 0.025, shadeColor(c.accent, 0.8), { detail: 'lo' });
  },
  pendant(c) {
    const { p } = c;
    const y = p.torsoH * 0.98;
    c.b.add(torus(p.rNeck * 1.35, 0.008, Math.PI * 2, 4, 24), B.spine, T(0, y - 0.02, 0.02, Math.PI / 2 + 0.55, 0, 0, 1, p.depth, 1), GOLD, { gloss: 0.8 });
    const gy = p.torsoH * 0.74;
    blob(c, B.spine, 0, gy, frontZ(c, gy) + 0.02, 0.034, 0.045, 0.025, new Color('#6fb3ab'), { gloss: 1 });
    blob(c, B.spine, 0, gy + 0.045, frontZ(c, gy) + 0.016, 0.016, 0.012, 0.012, GOLD, { gloss: 0.9, detail: 'lo' });
  },
};

export const BACK_BUILDERS: Record<BackId, AccBuilder> = {
  none() {},
  backpack(c) {
    const { p } = c;
    const y = p.torsoH * 0.52;
    const w = Math.max(0.26, p.rMid * 1.3);
    const h = Math.max(0.24, p.torsoH * 0.72);
    const z = -frontZ(c, y) - 0.07;
    const col = c.accent;
    c.b.add(roundedBox(w, h, 0.17, 0.05), B.spine, T(0, y, z), col, { shade: 0.2 });
    c.b.add(roundedBox(w * 0.7, h * 0.4, 0.06, 0.025), B.spine, T(0, y - h * 0.18, z - 0.09), shadeColor(col, 0.88), { shade: 0.15 });
    c.b.add(roundedBox(w * 1.02, h * 0.3, 0.19, 0.04), B.spine, T(0, y + h * 0.38, z + 0.005, 0.1), shadeColor(col, 0.92), { shade: 0.1 });
    for (const s of [1, -1]) c.b.add(roundedBox(0.04, p.torsoH * 0.55, 0.025, 0.01), B.spine, T(s * p.rSh * 0.55, p.torsoH * 0.6, frontZ(c, p.torsoH * 0.6) + 0.004, -0.2), shadeColor(col, 0.7));
  },
  satchel(c) {
    const { p } = c;
    c.b.add(torus(p.rMid * 1.04, 0.016, Math.PI * 2, 5, 28), B.spine, T(0, p.torsoH * 0.5, 0, Math.PI / 2, 0.75, 0, 1, p.depth * 1.12, 1), shadeColor(LEATHER, 0.8), { gloss: 0.3 });
    const bx = -p.rBot * 1.05;
    c.b.add(roundedBox(0.075, 0.17, 0.22, 0.03), B.hips, T(bx - 0.02, 0.02, 0.02), LEATHER, { shade: 0.2, gloss: 0.25 });
    c.b.add(roundedBox(0.08, 0.08, 0.225, 0.025), B.hips, T(bx - 0.025, 0.07, 0.02), shadeColor(LEATHER, 0.85), { gloss: 0.3 });
    blob(c, B.hips, bx - 0.07, 0.04, 0.02, 0.012, 0.02, 0.02, GOLD, { gloss: 0.9, detail: 'lo' });
  },
};

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export const RENDER_MAPPING = {
  body: BODY_PROPORTIONS,
  skin: null, // colour slots resolve through the palette catalogs
  hairColor: null,
  shirtColor: ACCENT,
  pantsColor: null,
  shoeColor: null,
  hairStyle: HAIR_BUILDERS,
  face: FACE_BUILDERS,
  shirtStyle: SHIRT_BUILDERS,
  pantsStyle: PANTS_BUILDERS,
  shoeStyle: SHOE_BUILDERS,
  hat: HAT_BUILDERS,
  eyewear: EYEWEAR_BUILDERS,
  neck: NECK_BUILDERS,
  back: BACK_BUILDERS,
} as const;

function pick<T extends object>(rec: T, id: string, fallback: keyof T): T[keyof T] {
  return (Object.prototype.hasOwnProperty.call(rec, id) ? rec[id as keyof T] : rec[fallback]) as T[keyof T];
}

export function appearanceKey(a: Appearance): string {
  const x = a.accessories ?? DEFAULT_APPEARANCE.accessories;
  return [a.body, a.skin, a.hairStyle, a.hairColor, a.face, a.shirtStyle, a.shirtColor, a.pantsStyle, a.pantsColor, a.shoeStyle, a.shoeColor, x.hat, x.eyewear, x.neck, x.back].join('|');
}

export function buildCharacter(a: Appearance): BuiltCharacter {
  const d = DEFAULT_APPEARANCE;
  const acc = a.accessories ?? d.accessories;
  const L = layoutFor(a.body);
  const p = L.p;
  const rest = L.rest.slice();
  const hatId = (Object.prototype.hasOwnProperty.call(HAT_BUILDERS, acc.hat) ? acc.hat : 'none') as HatId;
  const c: Ctx = {
    a,
    b: new GeoBuilder(),
    L,
    p,
    R: p.headRx,
    hc: new Vector3(...L.headC),
    skin: hexOf(SKIN_TONES, a.skin as SkinToneId, d.skin),
    hair: hexOf(HAIR_COLORS, a.hairColor as HairColorId, d.hairColor),
    shirt: hexOf(CLOTHING_COLORS, a.shirtColor, d.shirtColor),
    pants: hexOf(CLOTHING_COLORS, a.pantsColor, d.pantsColor),
    shoe: hexOf(CLOTHING_COLORS, a.shoeColor, d.shoeColor),
    accent: hexOf(CLOTHING_COLORS, ACCENT[a.shirtColor as ClothingColorId] ?? 'mustard', 'mustard'),
    hasHat: hatId !== 'none' && hatId !== 'flower' && hatId !== 'sprout' && hatId !== 'headphones',
    capScale: 1.04,
    rnd: rng(hashString(appearanceKey(a))),
    eye: FACE_EYES.smile,
    hairTop: 0,
    anchors: {},
  };

  // Pass 1 (dry): face anchors decide the face bone rest positions; hair decides the hat fit + hair top.
  buildFace({ ...c, b: new GeoBuilder() });
  const anchors = c.anchors;
  // (buildFace wrote into the shared anchors object through the spread copy)
  for (const [bone, v] of Object.entries(anchors)) {
    const i = Number(bone);
    rest[i * 3] = v!.x;
    rest[i * 3 + 1] = v!.y;
    rest[i * 3 + 2] = v!.z;
  }
  const worlds = boneWorlds(rest);
  c.b = new GeoBuilder(worlds);

  buildHead(c);
  buildFace(c);
  const headWorldY = worlds[B.head]!.elements[13];
  c.b.maxY = -Infinity;
  pick(HAIR_BUILDERS, a.hairStyle, d.hairStyle)(hairKit(c), c);
  c.hairTop = Number.isFinite(c.b.maxY) ? c.b.maxY - headWorldY : c.hc.y + p.headRy;
  if (!Number.isFinite(c.b.maxY) || c.hairTop < c.hc.y + p.headRy) c.hairTop = c.hc.y + p.headRy;
  pick(SHIRT_BUILDERS, a.shirtStyle, d.shirtStyle)(c);
  pick(PANTS_BUILDERS, a.pantsStyle, d.pantsStyle)(c);
  pick(SHOE_BUILDERS, a.shoeStyle, d.shoeStyle)(c);
  c.b.maxY = -Infinity;
  HAT_BUILDERS[hatId](c);
  pick(EYEWEAR_BUILDERS, acc.eyewear, 'none')(c);
  pick(NECK_BUILDERS, acc.neck, 'none')(c);
  pick(BACK_BUILDERS, acc.back, 'none')(c);

  const geometry = c.b.build(true);
  geometry.computeBoundingBox();
  const topY = geometry.boundingBox!.max.y;
  const hy = -p.foreArm - p.handR * 0.7;
  return {
    geometry,
    rest,
    layout: L,
    handL: [0, hy, p.handR * 0.55],
    handR: [0, hy, p.handR * 0.55],
    topY,
    vertexCount: c.b.vertexCount,
  };
}

export type { BodyId };
