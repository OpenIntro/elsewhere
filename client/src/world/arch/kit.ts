/**
 * Architectural kit: window units, doorways, roofs with tile courses, chimneys,
 * awnings, fences, lamp posts. All pieces are composed into a GeoBuilder in the
 * current transform (local +Z = outward from a wall face / front of object).
 * Dynamic anchors (doors, smoke, lamp bulbs, bell, spinners) are recorded in
 * `anchors` for the animated systems.
 */
import { BufferAttribute, BufferGeometry, Color, Matrix4, Quaternion, Vector3 } from 'three';
import { archFrame, archPanel, cone, cyl, gableRoof, gableWall, rbox, sphere, T, torus, type ColorLike, type GeoBuilder } from '../geom.js';

// ---------------------------------------------------------------------------
// Dynamic anchors collected while building
// ---------------------------------------------------------------------------

export interface DoorAnchor {
  id: string;
  /** World transform of the doorway (origin = threshold centre, +Z outward). */
  frame: Matrix4;
  width: number;
  height: number;
  color: string;
  double: boolean;
  /** Panel style. */
  style: 'plank' | 'panel' | 'glass' | 'barn' | 'round';
}

export interface GlowAnchor {
  /** Interactable id of the light that powers it. */
  lightId: string;
  position: Vector3;
  size: number;
  /** 0 bulb (solid sphere), 1 tiny string bulb. */
  kind: 0 | 1;
}

export interface LampAnchor {
  lightId: string;
  position: Vector3;
  color: string;
  range: number;
  intensity: number;
}

export const anchors = {
  doors: [] as DoorAnchor[],
  smoke: [] as Vector3[],
  glows: [] as GlowAnchor[],
  lamps: [] as LampAnchor[],
  bell: null as Matrix4 | null,
  clock: [] as Matrix4[],
  spinners: [] as { matrix: Matrix4; kind: 'gear' | 'vane' | 'windmill'; speed: number; size: number }[],
  sparkles: [] as { id: string; position: Vector3; subtle: boolean }[],
};

export function resetAnchors(): void {
  anchors.doors.length = 0;
  anchors.smoke.length = 0;
  anchors.glows.length = 0;
  anchors.lamps.length = 0;
  anchors.bell = null;
  anchors.clock.length = 0;
  anchors.spinners.length = 0;
  anchors.sparkles.length = 0;
}

const _v = new Vector3();
/** World position of a local point under the builder's current transform. */
export function worldPoint(B: GeoBuilder, x: number, y: number, z: number): Vector3 {
  return _v.set(x, y, z).applyMatrix4(B.matrix).clone();
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const P = {
  stone: '#cfc4b0',
  stoneMid: '#b3a893',
  stoneDark: '#8e8574',
  trim: '#f0e7d4',
  woodLight: '#b98f66',
  wood: '#93704f',
  woodDark: '#64493a',
  iron: '#45474b',
  brass: '#c89b52',
  glassDark: '#3a4656',
  soil: '#6a5341',
  leaf: '#6f8f52',
  leafLight: '#8fac62',
  petals: ['#e7a0a6', '#f1d27a', '#b9a2d8', '#f4efe6', '#e98a6b', '#9fc0e8'] as const,
};

export function shade(c: ColorLike, k: number): Color {
  return new Color(c as Color).multiplyScalar(k);
}
export function mix(a: ColorLike, b: ColorLike, t: number): Color {
  return new Color(a as Color).lerp(new Color(b as Color), t);
}

// ---------------------------------------------------------------------------
// Faces of a box building: returns a transform onto the face (origin on the wall surface, +Z outward)
// ---------------------------------------------------------------------------

export type Face = 'front' | 'back' | 'left' | 'right';
export function onFace(face: Face, w: number, d: number, u: number, y: number, out = 0): Matrix4 {
  switch (face) {
    case 'front':
      return T(u, y, d / 2 + out, 0);
    case 'back':
      return T(-u, y, -d / 2 - out, Math.PI);
    case 'right':
      return T(w / 2 + out, y, -u, Math.PI / 2);
    case 'left':
      return T(-w / 2 - out, y, u, -Math.PI / 2);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export interface WindowOpts {
  arched?: boolean;
  frame?: ColorLike;
  shutters?: ColorLike | null;
  flowers?: boolean;
  /** 0..1 how lit at night. */
  lit?: number;
  mullions?: 'cross' | 'grid' | 'none' | 'vertical';
  sill?: boolean;
  round?: boolean;
}

/** Window centred horizontally at origin, bottom at y=0, on a wall face (+Z out). */
export function windowUnit(B: GeoBuilder, w: number, h: number, o: WindowOpts = {}): void {
  const frame = o.frame ?? P.trim;
  const lit = o.lit ?? (B.random() < 0.75 ? 0.6 + B.random() * 0.4 : 0.15);
  const tint = B.random();
  if (o.round) {
    const r = w / 2;
    B.addRaw('window', cyl(r, r, 0.06, 20), [lit, tint, 0], T(0, r, 0.02, 0, Math.PI / 2));
    B.add('solid', torus(r, 0.075, 8, 24), frame, T(0, r, 0.06));
    B.add('solid', rbox(0.06, w, 0.05, 0.02), frame, T(0, r, 0.07));
    B.add('solid', rbox(w, 0.06, 0.05, 0.02), frame, T(0, r, 0.07));
    return;
  }
  if (o.arched) {
    B.addRaw('window', archPanel(w, h, 0.04, 0), [lit, tint, 0], T(0, 0, 0.01));
    B.add('solid', archFrame(w, h, 0.1, 0.1), frame, T(0, 0, 0.05));
  } else {
    B.addRaw('window', rbox(w, h, 0.05, 0.015), [lit, tint, 0], T(0, h / 2, 0.01));
    const f = 0.09;
    B.add('solid', rbox(w + f * 2, f, 0.1, 0.03), frame, T(0, h + f / 2, 0.05));
    B.add('solid', rbox(w + f * 2, f, 0.1, 0.03), frame, T(0, -f / 2 + 0.02, 0.05));
    B.add('solid', rbox(f, h, 0.1, 0.03), frame, T(-w / 2 - f / 2, h / 2, 0.05));
    B.add('solid', rbox(f, h, 0.1, 0.03), frame, T(w / 2 + f / 2, h / 2, 0.05));
    // lintel / hood
    B.add('solid', rbox(w + 0.36, 0.14, 0.2, 0.05), shade(frame, 0.92), T(0, h + 0.14, 0.08));
  }
  const m = o.mullions ?? 'cross';
  const mc = shade(frame, 0.97);
  const hh = o.arched ? h - w / 2 : h;
  if (m === 'cross' || m === 'grid' || m === 'vertical') B.add('solid', rbox(0.05, o.arched ? h - 0.05 : h, 0.04, 0.015), mc, T(0, (o.arched ? h - 0.05 : h) / 2, 0.06));
  if (m === 'cross') B.add('solid', rbox(w, 0.05, 0.04, 0.015), mc, T(0, hh * 0.55, 0.06));
  if (m === 'grid') {
    B.add('solid', rbox(w, 0.04, 0.04, 0.015), mc, T(0, hh * 0.36, 0.06));
    B.add('solid', rbox(w, 0.04, 0.04, 0.015), mc, T(0, hh * 0.7, 0.06));
    B.add('solid', rbox(0.04, hh, 0.04, 0.015), mc, T(-w / 4, hh / 2, 0.06));
    B.add('solid', rbox(0.04, hh, 0.04, 0.015), mc, T(w / 4, hh / 2, 0.06));
  }
  if (o.sill ?? true) B.add('solid', rbox(w + 0.32, 0.09, 0.24, 0.035), shade(frame, 0.9), T(0, -0.06, 0.1));
  if (o.shutters) {
    const sw = w * 0.52;
    for (const s of [-1, 1]) {
      const x = s * (w / 2 + sw / 2 + 0.1);
      B.add('solid', rbox(sw, hh * 0.98, 0.06, 0.025), o.shutters, T(x, hh / 2, 0.05));
      for (let k = 1; k < 5; k++) B.add('solid', rbox(sw * 0.84, 0.035, 0.03, 0.01), shade(o.shutters, 0.82), T(x, (hh * k) / 5, 0.09));
    }
  }
  if (o.flowers) flowerBox(B, w + 0.2);
}

export function flowerBox(B: GeoBuilder, w: number): void {
  B.add('solid', rbox(w, 0.24, 0.28, 0.06), P.woodDark, T(0, -0.22, 0.2));
  B.add('solid', rbox(w - 0.08, 0.06, 0.22, 0.02), P.soil, T(0, -0.09, 0.2));
  const n = Math.max(3, Math.round(w * 4));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + 0.1 + ((i + 0.5) / n) * (w - 0.2);
    B.add('plant', sphere(0.1 + B.random() * 0.04, 8, 6), P.leaf, T(x, -0.02, 0.2 + (B.random() - 0.5) * 0.1), { ao: false });
    if (B.random() < 0.75) B.add('solid', sphere(0.055, 7, 5), P.petals[Math.floor(B.random() * P.petals.length)]!, T(x + 0.03, 0.08, 0.26), { ao: false, jitter: 0.1 });
  }
}

// ---------------------------------------------------------------------------
// Doorways (frame + dark interior + step). The leaf itself is dynamic (Doors.tsx).
// ---------------------------------------------------------------------------

export function doorway(B: GeoBuilder, id: string, w: number, h: number, o: { frame?: ColorLike; color: string; double?: boolean; style?: DoorAnchor['style']; arched?: boolean; step?: boolean; hood?: ColorLike | null }): void {
  const frame = o.frame ?? P.trim;
  // Interior (lit softly at night through the open door / glass).
  // Interior seen when the leaf swings out: sits on the wall surface, under the leaf.
  B.addRaw('window', rbox(w, h, 0.03, 0.01), [0.55, 0.6, 0], T(0, h / 2, 0.006));
  B.add('solid', rbox(w + 0.02, 0.04, 0.1, 0.01), P.woodDark, T(0, 0.02, 0.03));
  if (o.arched) {
    B.add('solid', archFrame(w, h, 0.14, 0.14), frame, T(0, 0, 0.04));
  } else {
    const f = 0.14;
    B.add('solid', rbox(f, h + f, 0.16, 0.04), frame, T(-w / 2 - f / 2, (h + f) / 2, 0.04));
    B.add('solid', rbox(f, h + f, 0.16, 0.04), frame, T(w / 2 + f / 2, (h + f) / 2, 0.04));
    B.add('solid', rbox(w + f * 2 + 0.1, f + 0.04, 0.2, 0.05), frame, T(0, h + f / 2, 0.05));
  }
  if (o.step ?? true) B.add('solid', rbox(w + 0.7, 0.14, 0.55, 0.05), P.stoneMid, T(0, 0.07, 0.3));
  if (o.hood) {
    B.add('solid', rbox(w + 0.9, 0.12, 0.85, 0.05), o.hood, T(0, h + 0.42, 0.38, 0, 0.18));
    for (const s of [-1, 1]) B.add('solid', rbox(0.08, 0.5, 0.08, 0.03), shade(frame, 0.9), T(s * (w / 2 + 0.3), h + 0.18, 0.12, 0, -0.6));
  }
  const frameM = B.matrix.clone();
  anchors.doors.push({ id, frame: frameM, width: w, height: h, color: o.color, double: o.double ?? false, style: o.style ?? 'plank' });
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------

function bez(p0: number, p1: number, p2: number, s: number): number {
  return (1 - s) * (1 - s) * p0 + 2 * (1 - s) * s * p1 + s * s * p2;
}

export interface RoofOpts {
  span: number;
  rise: number;
  length: number;
  color: ColorLike;
  overhang?: number;
  curve?: number;
  thickness?: number;
  courses?: number;
  /** Tile-course style: strips (shingles) or scallops (round tiles). */
  tiles?: 'strips' | 'scallop' | 'ribs' | 'none';
  ridgeColor?: ColorLike;
}

/** Gable roof with ridge along local Z, eaves at y=0 (place at wall top). */
export function roof(B: GeoBuilder, o: RoofOpts): void {
  const ov = o.overhang ?? 0.45;
  const curve = o.curve ?? 0.14;
  const th = o.thickness ?? 0.3;
  o = { ...o, color: mix(o.color, '#8a8078', 0.24) };
  B.add('solid', gableRoof(o.span, o.rise, o.length, th, ov, curve), o.color, undefined, { ao: false, grad: 0.12 });
  const hw = o.span / 2 + ov;
  const drop = (ov / (o.span / 2)) * o.rise;
  const cy = o.rise * 0.5 + curve - drop * 0.5;
  const tiles = o.tiles ?? 'strips';
  const n = o.courses ?? Math.round(o.span * 1.1);
  const dark = shade(o.color, 0.84);
  if (tiles !== 'none') {
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const s = (i + 0.35) / n;
        const x = side * (hw - bez(0, hw * 0.5, hw, s));
        const y = bez(-drop, cy, o.rise, s);
        const dy = 2 * (1 - s) * (cy + drop) + 2 * s * (o.rise - cy);
        const ang = -side * Math.atan2(dy, hw);
        if (tiles === 'ribs') continue;
        if (tiles === 'scallop') {
          const count = Math.max(2, Math.round(o.length / 0.36));
          const seg = o.length / count;
          for (let k = 0; k < count; k++) {
            const z = -o.length / 2 + (k + 0.5) * seg + ((i % 2) - 0.5) * seg * 0.5;
            if (Math.abs(z) > o.length / 2 - seg * 0.45) continue;
            B.add('solid', rbox(0.2, 0.085, seg * 0.92, 0.04), (k + i) % 4 === 0 ? dark : o.color, T(x, y + 0.035, z, 0, 0, ang), { ao: false, jitter: 0.07 });
          }
        } else {
          B.add('solid', rbox(0.14, 0.07, o.length - 0.04, 0.03), i % 2 ? dark : shade(o.color, 0.93), T(x, y + 0.02, 0, 0, 0, ang), { ao: false, jitter: 0.05 });
        }
      }
    }
    if (tiles === 'ribs') {
      const count = Math.round(o.length / 0.5);
      for (let k = 0; k <= count; k++) {
        const z = -o.length / 2 + 0.1 + (k / count) * (o.length - 0.2);
        for (const side of [-1, 1]) {
          const ang = Math.atan2(o.rise + drop, hw) * -side;
          const len = Math.hypot(hw, o.rise + drop);
          B.add('solid', rbox(len, 0.06, 0.06, 0.025), dark, T((side * hw) / 2, (o.rise - drop) / 2 + 0.04 + curve * 0.5, z, 0, 0, ang), { ao: false });
        }
      }
    }
  }
  // Ridge cap.
  B.add('solid', cyl(0.14, 0.14, o.length + 0.1, 10), o.ridgeColor ?? shade(o.color, 0.8), T(0, o.rise + 0.02, 0, 0, Math.PI / 2), { ao: false });
  // Bargeboards (trim along the gable edges) at both ends.
  for (const zs of [-1, 1]) {
    for (const side of [-1, 1]) {
      const ang = Math.atan2(o.rise + drop, hw) * -side;
      const len = Math.hypot(hw, o.rise + drop);
      B.add('solid', rbox(len, 0.2, 0.1, 0.04), shade(o.color, 0.72), T((side * hw) / 2, (o.rise - drop) / 2 + curve * 0.4, zs * (o.length / 2 + 0.06), 0, 0, ang), { ao: false });
    }
  }
}

/** Gable infill triangles at both ends (front/back) — ridge along Z. */
export function gableEnds(B: GeoBuilder, span: number, rise: number, length: number, color: ColorLike): void {
  for (const s of [-1, 1]) B.add('solid', gableWall(span - 0.05, rise * 0.98, 0.16), color, T(0, 0, s * (length / 2 - 0.1)));
}

/** Hip roof with a ridge (w along X, d along Z), eaves at y=0, tile courses on every face. */
export function pavilionRoof(B: GeoBuilder, w: number, d: number, rise: number, color: ColorLike, overhang = 0.5): void {
  const W = w + overhang * 2;
  const D = d + overhang * 2;
  const along = W >= D;
  const hw = W / 2;
  const hd = D / 2;
  const short = Math.min(hw, hd);
  const rl = along ? hw - short : 0; // ridge half-length along X
  const rd = along ? 0 : hd - short; // or along Z
  const v = (x: number, y: number, z: number) => [x, y, z];
  const A = v(-hw, 0, hd), Bp = v(hw, 0, hd), Cp = v(hw, 0, -hd), Dp = v(-hw, 0, -hd);
  const R1 = v(-rl, rise, -rd), R2 = v(rl, rise, rd);
  const tris: number[][] = along
    ? [A, Bp, R2, A, R2, R1, Cp, Dp, R1, Cp, R1, R2, Bp, Cp, R2, Dp, A, R1]
    : [A, Bp, R2, Bp, Cp, R1, Bp, R1, R2, Cp, Dp, R1, Dp, A, R2, Dp, R2, R1];
  const g = new BufferGeometry();
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((p, i) => pos.set(p, i * 3));
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(tris.length * 2), 2));
  g.computeVertexNormals();
  const col = mix(color, '#8a8078', 0.18);
  B.add('solid', g, col, T(0, 0.05, 0), { ao: false, grad: 0.18 });
  B.add('solid', rbox(W + 0.1, 0.24, D + 0.1, 0.09), shade(col, 0.72), T(0, 0.0, 0), { ao: false });
  // Tile courses on each face.
  const n = Math.max(4, Math.round(rise * 3.2));
  const dark = shade(col, 0.86);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.45) / n;
    const y = rise * t + 0.07;
    const c = i % 2 ? dark : shade(col, 0.95);
    // front/back faces (slope towards ±Z)
    const zf = hd * (1 - t) * (along ? 1 : 1) - (along ? 0 : 0);
    const xHalfF = along ? hw - t * short : hw * (1 - t);
    const angF = Math.atan2(rise, short);
    for (const s of [1, -1]) B.add('solid', rbox(Math.max(0.2, xHalfF * 2 - 0.1), 0.07, 0.16, 0.03), c, T(0, y, s * (along ? short * (1 - t) : zf)).multiply(T(0, 0, 0, 0, s * angF)), { ao: false, jitter: 0.04 });
    const zHalfS = along ? hd * (1 - t) : hd - t * short;
    for (const s of [1, -1]) B.add('solid', rbox(0.16, 0.07, Math.max(0.2, zHalfS * 2 - 0.1), 0.03), c, T(s * (along ? hw - t * short : short * (1 - t)), y, 0).multiply(T(0, 0, 0, 0, 0, -s * angF)), { ao: false, jitter: 0.04 });
  }
  // Ridge + hip caps.
  const cap = shade(col, 0.7);
  if (along) B.add('solid', cyl(0.13, 0.13, rl * 2 + 0.2, 8), cap, T(0, rise + 0.06, 0, 0, 0, Math.PI / 2), { ao: false });
  else B.add('solid', cyl(0.13, 0.13, rd * 2 + 0.2, 8), cap, T(0, rise + 0.06, 0, 0, Math.PI / 2), { ao: false });
  for (const [cx, cz, rx, rz] of [[hw, hd, rl, rd], [-hw, hd, -rl, rd], [hw, -hd, rl, -rd], [-hw, -hd, -rl, -rd]] as const) {
    const a = new Vector3(cx, 0.05, cz);
    const b = new Vector3(along ? rx : 0, rise + 0.06, along ? 0 : rz);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    B.add('solid', cyl(0.11, 0.11, len, 8), cap, new Matrix4().compose(mid, q, new Vector3(1, 1, 1)), { ao: false });
  }
  for (const s of [-1, 1]) B.add('solid', sphere(0.2, 10, 8), cap, T(along ? s * rl : 0, rise + 0.08, along ? 0 : s * rd), { ao: false });
}

// ---------------------------------------------------------------------------
// Misc pieces
// ---------------------------------------------------------------------------

export function chimney(B: GeoBuilder, x: number, y0: number, z: number, h: number, color: ColorLike = '#a8705a', smoke = true): void {
  B.add('solid', rbox(0.75, h, 0.75, 0.08), color, T(x, y0 + h / 2, z), { ao: false, grad: 0.15 });
  B.add('solid', rbox(0.92, 0.18, 0.92, 0.06), shade(color, 0.85), T(x, y0 + h, z), { ao: false });
  B.add('solid', cyl(0.18, 0.2, 0.3, 10), '#6b5e57', T(x, y0 + h + 0.22, z), { ao: false });
  for (let i = 0; i < 3; i++) B.add('solid', rbox(0.77, 0.03, 0.77, 0.01), shade(color, 0.78), T(x, y0 + 0.3 + i * (h / 3.2), z), { ao: false });
  if (smoke) anchors.smoke.push(worldPoint(B, x, y0 + h + 0.4, z));
}

export function stovepipe(B: GeoBuilder, x: number, y0: number, z: number, h: number): void {
  B.add('solid', cyl(0.16, 0.16, h, 12), P.iron, T(x, y0 + h / 2, z), { ao: false });
  B.add('solid', cone(0.32, 0.25, 12), P.iron, T(x, y0 + h + 0.25, z), { ao: false });
  anchors.smoke.push(worldPoint(B, x, y0 + h + 0.15, z));
}

/** Striped awning projecting along +Z from a wall, top at y. */
export function awning(B: GeoBuilder, width: number, y: number, depth: number, colA: ColorLike, colB: ColorLike, drop = 0.55): void {
  const stripes = Math.max(4, Math.round(width / 0.5));
  const sw = width / stripes;
  const ang = Math.atan2(drop, depth);
  const len = Math.hypot(depth, drop);
  for (let i = 0; i < stripes; i++) {
    const x = -width / 2 + sw * (i + 0.5);
    const c = i % 2 ? colA : colB;
    // slightly bowed: two segments
    B.add('solid', rbox(sw + 0.005, 0.06, len * 0.55, 0.025), c, T(x, y - drop * 0.25, depth * 0.27, 0, ang * 0.75), { ao: false, jitter: 0.02 });
    B.add('solid', rbox(sw + 0.005, 0.06, len * 0.5, 0.025), c, T(x, y - drop * 0.72, depth * 0.76, 0, ang * 1.25), { ao: false, jitter: 0.02 });
    // scalloped valance
    B.add('solid', cyl(sw / 2, sw / 2, 0.05, 12, false), c, T(x, y - drop - 0.02, depth + 0.02, 0, Math.PI / 2, 0, 1, 1, 0.75), { ao: false });
  }
  // rod + brackets
  B.add('solid', cyl(0.04, 0.04, width + 0.1, 8), P.iron, T(0, y - drop + 0.02, depth, 0, 0, Math.PI / 2), { ao: false });
  for (const s of [-1, 1]) B.add('solid', rbox(0.05, 0.05, depth * 1.05, 0.02), P.iron, T(s * (width / 2 - 0.05), y - drop * 0.5, depth / 2, 0, ang), { ao: false });
}

export function picketFence(B: GeoBuilder, x0: number, z0: number, x1: number, z1: number, color: ColorLike = '#efe7d6', h = 0.62): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(x1 - x0, z1 - z0);
  const n = Math.max(2, Math.round(len / 0.22));
  B.at(T(x0, 0, z0, yaw), () => {
    for (let i = 0; i <= n; i++) {
      const z = (i / n) * len;
      B.add('solid', rbox(0.09, h, 0.05, 0.02), color, T(0, h / 2, z), { jitter: 0.05 });
      B.add('solid', cone(0.065, 0.1, 4), color, T(0, h + 0.05, z, Math.PI / 4), { jitter: 0.05 });
    }
    B.add('solid', rbox(0.04, 0.06, len, 0.015), shade(color, 0.9), T(-0.04, h * 0.32, len / 2));
    B.add('solid', rbox(0.04, 0.06, len, 0.015), shade(color, 0.9), T(-0.04, h * 0.75, len / 2));
  });
}

/** Ornate streetlight, head at `h`. */
export function streetlamp(B: GeoBuilder, lightId: string, h: number, color: string, range: number, intensity: number): void {
  B.add('solid', cyl(0.24, 0.3, 0.32, 10), P.iron, T(0, 0.16, 0));
  B.add('solid', cyl(0.15, 0.2, 0.4, 10), shade(P.iron, 1.1), T(0, 0.5, 0));
  B.add('solid', cyl(0.06, 0.08, h - 0.9, 8), P.iron, T(0, 0.7 + (h - 0.9) / 2, 0));
  B.add('solid', torus(0.1, 0.03, 6, 12), P.brass, T(0, h * 0.55, 0, 0, Math.PI / 2));
  // head: lantern cage
  B.add('solid', cyl(0.12, 0.06, 0.2, 8), P.iron, T(0, h - 0.35, 0));
  B.add('solid', cyl(0.24, 0.16, 0.06, 8), P.iron, T(0, h - 0.23, 0));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    B.add('solid', rbox(0.03, 0.42, 0.03, 0.01), P.iron, T(Math.cos(a) * 0.17, h, Math.sin(a) * 0.17, -a));
  }
  B.add('solid', cone(0.3, 0.26, 8), P.iron, T(0, h + 0.34, 0));
  B.add('solid', sphere(0.06, 8, 6), P.brass, T(0, h + 0.5, 0));
  anchors.glows.push({ lightId, position: worldPoint(B, 0, h, 0), size: 0.2, kind: 0 });
  anchors.lamps.push({ lightId, position: worldPoint(B, 0, h, 0), color, range, intensity });
}

/** Shepherd's-crook post with a hanging lantern; light at height `h`. */
export function lanternPost(B: GeoBuilder, lightId: string, h: number, color: string, range: number, intensity: number, post: ColorLike = P.iron, base: 'stone' | 'wood' | 'iron' = 'iron'): void {
  if (base === 'stone') {
    B.add('solid', rbox(0.5, h * 0.55, 0.5, 0.1), P.stoneMid, T(0, h * 0.275, 0), { grad: 0.2 });
    B.add('solid', rbox(0.6, 0.12, 0.6, 0.05), P.stone, T(0, h * 0.55, 0));
    lanternCage(B, lightId, 0, h * 0.55 + 0.32, 0, color, range, intensity);
    return;
  }
  const top = h + 0.55;
  if (base === 'wood') B.add('solid', rbox(0.18, top, 0.18, 0.04), post, T(0, top / 2, 0));
  else {
    B.add('solid', cyl(0.13, 0.17, 0.25, 8), post, T(0, 0.12, 0));
    B.add('solid', cyl(0.045, 0.055, top, 8), post, T(0, top / 2, 0));
  }
  // crook arm
  B.add('solid', torus(0.22, 0.03, 6, 12, Math.PI), post, T(0.22, top - 0.02, 0));
  B.add('solid', cyl(0.012, 0.012, 0.22, 4), P.iron, T(0.44, top - 0.13, 0));
  lanternCage(B, lightId, 0.44, h, 0, color, range, intensity);
}

export function lanternCage(B: GeoBuilder, lightId: string, x: number, y: number, z: number, color: string, range: number, intensity: number): void {
  B.add('solid', cone(0.17, 0.14, 6), P.iron, T(x, y + 0.24, z));
  B.add('solid', torus(0.04, 0.012, 4, 8), P.iron, T(x, y + 0.34, z));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    B.add('solid', rbox(0.025, 0.3, 0.025, 0.008), P.iron, T(x + Math.cos(a) * 0.11, y, z + Math.sin(a) * 0.11));
  }
  B.add('solid', cyl(0.13, 0.13, 0.04, 8), P.iron, T(x, y - 0.16, z));
  anchors.glows.push({ lightId, position: worldPoint(B, x, y, z), size: 0.12, kind: 0 });
  anchors.lamps.push({ lightId, position: worldPoint(B, x, y, z), color, range, intensity });
}

/** Board sign with atlas face (both sides), centred at origin. */
export function signBoard(B: GeoBuilder, key: string, w: number, h: number, uv: [number, number, number, number], quadGeo: (w: number, h: number) => import('three').BufferGeometry, frame: ColorLike = P.woodDark, both = true): void {
  B.add('solid', rbox(w + 0.14, h + 0.14, 0.1, 0.04), frame);
  B.addUV('sign', quadGeo(w, h), uv, T(0, 0, 0.052));
  if (both) B.addUV('sign', quadGeo(w, h), uv, T(0, 0, -0.052, Math.PI));
  void key;
}

export function crate(B: GeoBuilder, s: number, color: ColorLike = P.woodLight): void {
  B.add('solid', rbox(s, s, s, 0.05), color, T(0, s / 2, 0));
  const dk = shade(color, 0.75);
  for (const z of [-1, 1]) {
    B.add('solid', rbox(s + 0.02, 0.08, 0.04, 0.02), dk, T(0, s * 0.15, (z * s) / 2));
    B.add('solid', rbox(s + 0.02, 0.08, 0.04, 0.02), dk, T(0, s * 0.85, (z * s) / 2));
    B.add('solid', rbox(0.06, s * 1.0, 0.04, 0.02), dk, T(0, s / 2, (z * s) / 2, 0, 0, Math.PI / 4 - 0.12, 1, 1.25, 1));
  }
  for (const x of [-1, 1]) {
    B.add('solid', rbox(0.04, 0.08, s + 0.02, 0.02), dk, T((x * s) / 2, s * 0.15, 0));
    B.add('solid', rbox(0.04, 0.08, s + 0.02, 0.02), dk, T((x * s) / 2, s * 0.85, 0));
  }
}

export function barrel(B: GeoBuilder, r: number, h: number, color: ColorLike = P.wood): void {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push([r * (0.86 + 0.14 * Math.sin(t * Math.PI)), t * h]);
  }
  pts.unshift([0, 0]);
  pts.push([0, h]);
  B.add('solid', lathe2(`barrel${r},${h}`, pts), color);
  for (const t of [0.15, 0.5, 0.85]) B.add('solid', torus(r * (0.87 + 0.13 * Math.sin(t * Math.PI)) + 0.01, 0.025, 5, 18), P.iron, T(0, t * h, 0, 0, Math.PI / 2));
}

import { lathe } from '../geom.js';
function lathe2(key: string, pts: [number, number][]) {
  return lathe(key, pts, 16);
}

/** Small round bush made of blobs (static, merged into the plant bucket). */
export function shrub(B: GeoBuilder, r: number, color: ColorLike = P.leaf, flowers = 0): void {
  const n = 3 + Math.floor(B.random() * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + B.random();
    const rr = r * (0.55 + B.random() * 0.25);
    B.add('plant', sphere(rr, 10, 8), mix(color, P.leafLight, B.random() * 0.4), T(Math.cos(a) * r * 0.45, rr * 0.9, Math.sin(a) * r * 0.45, 0, 0, 0, 1, 0.85, 1), { grad: 0.3 });
  }
  B.add('plant', sphere(r * 0.6, 10, 8), mix(color, P.leafLight, 0.3), T(0, r * 1.05, 0), { grad: 0.3 });
  for (let i = 0; i < flowers; i++) {
    const a = B.random() * Math.PI * 2;
    const y = r * (0.5 + B.random() * 0.8);
    B.add('solid', sphere(0.06, 6, 5), P.petals[Math.floor(B.random() * P.petals.length)]!, T(Math.cos(a) * r * 0.75, y, Math.sin(a) * r * 0.75), { ao: false, jitter: 0.12 });
  }
}

export function flowerPatch(B: GeoBuilder, w: number, d: number, count: number, palette: readonly string[] = P.petals): void {
  for (let i = 0; i < count; i++) {
    const x = (B.random() - 0.5) * w;
    const z = (B.random() - 0.5) * d;
    const h = 0.18 + B.random() * 0.22;
    B.add('plant', cyl(0.012, 0.016, h, 4, true), '#6f8f4d', T(x, h / 2, z));
    B.add('plant', sphere(0.075, 6, 5), palette[Math.floor(B.random() * palette.length)]!, T(x, h, z), { ao: false, jitter: 0.1 });
    if (B.random() < 0.5) B.add('plant', sphere(0.09, 6, 5), P.leaf, T(x + 0.05, 0.06, z), { ao: false });
  }
}
