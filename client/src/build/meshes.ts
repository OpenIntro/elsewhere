/**
 * Code-built geometry for every buildable piece, in the world's handcrafted
 * miniature style: soft rounded forms, painted wood and plaster, baked
 * vertex colours (one template per kind + variant, merged per material
 * bucket and drawn with instancing).
 *
 * Local frame: origin = footprint centre at the piece's base height, +Y up,
 * width along local X, depth along local Z (rotation is applied per instance).
 *
 * Buckets: 'solid' (matte clay/wood), 'glass' (window panes, glow at night),
 * 'glow' (lamp glass, warm emissive at night).
 */
import { Color, Shape, type BufferGeometry } from 'three';
import { CONFIG, PIECES, type PieceKind } from '@elsewhere/shared';
import { GeoBuilder, T, box, cone, cyl, extrude, rbox, sphere as sphereHi, gableRoof, type AddOpts, type ColorLike } from '../world/geom.js';

export type Bucket = 'solid' | 'glass' | 'glow';
export type Template = Map<Bucket, BufferGeometry>;

const H = CONFIG.building.storeyHeight;
const cache = new Map<string, Template>();

/**
 * Triangle budget: a world may hold thousands of pieces, so tiny parts (trim,
 * slats, mullions, tiles) are plain boxes — a bevel under ~4.5 cm is invisible
 * at the iso camera's distance — and small spheres are low-segment.
 */
function rb(w: number, h: number, d: number, r = 0.08) {
  return r < 0.045 ? box(w, h, d) : rbox(w, h, d, r);
}
const sphere = (r: number, ws = 8, hs = 6) => sphereHi(r, Math.min(ws, r < 0.15 ? 6 : 8), Math.min(hs, r < 0.15 ? 4 : 6));
const shade = (c: ColorLike, k: number) => new Color(c as Color).multiplyScalar(k);
const mixc = (a: ColorLike, b: ColorLike, t: number) => new Color(a as Color).lerp(new Color(b as Color), t);

const STONE = '#b9ae9b';
const STONE_DARK = '#968b78';
const SOIL = '#6a5341';
const LEAF = '#6f8f52';
const LEAF_LIGHT = '#8fac62';
const IRON = '#3f3f42';
const CREAM = '#e9dcc4';

const SOFT: AddOpts = { ao: false, jitter: 0.05, grad: 0.12 };
const FLAT: AddOpts = { ao: false, jitter: 0.03 };

function put(B: GeoBuilder, geo: BufferGeometry, color: ColorLike, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, opts: AddOpts = SOFT, bucket: Bucket = 'solid'): void {
  B.add(bucket, geo, color, T(x, y, z, ry, rx, rz), opts);
}

/** Box from y0 to y1 (base-anchored). */
function slab(B: GeoBuilder, w: number, y0: number, y1: number, d: number, color: ColorLike, x = 0, z = 0, r = 0.05, opts: AddOpts = SOFT): void {
  put(B, rb(w, y1 - y0, d, r), color, x, (y0 + y1) / 2, z, 0, 0, 0, opts);
}

/** Fieldstone footing under walls (hides the base on gentle slopes). */
function footing(B: GeoBuilder, w: number, d: number): void {
  slab(B, w + 0.06, -0.45, 0.12, d + 0.1, STONE_DARK, 0, 0, 0.04, FLAT);
  // A few rounder stones along the course.
  const n = Math.max(1, Math.round(w / 0.5));
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (i + 0.5) * (w / n) + (B.random() - 0.5) * 0.08;
    put(B, rb(w / n - 0.06, 0.15, d + 0.14, 0.04), mixc(STONE, STONE_DARK, B.random() * 0.6), x, 0.05, 0, 0, 0, 0, FLAT);
  }
}

/** Timber frame around a 2 m wall panel: sill, head beam and corner posts. */
function frame(B: GeoBuilder, w: number, h: number, d: number, trim: ColorLike): void {
  slab(B, w + 0.02, h - 0.14, h, d + 0.06, trim, 0, 0, 0.035);
  slab(B, w + 0.02, 0.1, 0.24, d + 0.06, trim, 0, 0, 0.035);
  for (const sx of [-1, 1]) slab(B, 0.16, 0.1, h, d + 0.08, shade(trim, 0.96), sx * (w / 2 - 0.08), 0, 0.04);
}

/** Plaster panel between x0..x1, y0..y1. */
function panel(B: GeoBuilder, x0: number, x1: number, y0: number, y1: number, d: number, color: ColorLike): void {
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return;
  put(B, rb(x1 - x0, y1 - y0, d, 0.035), color, (x0 + x1) / 2, (y0 + y1) / 2, 0);
}

function variantColors(kind: PieceKind, variant: string): Readonly<Record<string, string>> {
  const def = PIECES[kind];
  return (def.variants.find((v) => v.id === variant) ?? def.variants[0]!).colors;
}

// ---------------------------------------------------------------------------

function floor(B: GeoBuilder, c: Readonly<Record<string, string>>, variant: string, upper: boolean): void {
  const h = PIECES.floor.h;
  if (!upper) slab(B, 1.98, -0.5, 0.02, 1.98, shade(c.trim!, 0.85), 0, 0, 0.04, FLAT);
  slab(B, 2, upper ? -h : 0.0, upper ? 0 : h - 0.04, 2, c.trim!, 0, 0, 0.04, FLAT);
  const top = upper ? 0 : h - 0.04;
  if (variant === 'planks') {
    for (let i = 0; i < 5; i++) {
      const col = shade(c.main!, 0.92 + B.random() * 0.16);
      put(B, rb(0.38, 0.05, 1.96, 0.02), col, -0.8 + i * 0.4, top + 0.02, 0, 0, 0, 0, FLAT);
    }
  } else if (variant === 'flagstone') {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const col = mixc(c.main!, c.accent!, B.random() * 0.7);
      put(B, rb(0.6 + B.random() * 0.02, 0.05, 0.6, 0.05), col, -0.65 + i * 0.65 + (B.random() - 0.5) * 0.03, top + 0.02, -0.65 + j * 0.65 + (B.random() - 0.5) * 0.03, (B.random() - 0.5) * 0.06, 0, 0, FLAT);
    }
  } else {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const col = (i + j) % 2 ? c.main! : mixc(c.main!, c.accent!, 0.45);
      put(B, rb(0.47, 0.045, 0.47, 0.03), shade(col, 0.95 + B.random() * 0.1), -0.75 + i * 0.5, top + 0.02, -0.75 + j * 0.5, 0, 0, 0, FLAT);
    }
  }
}

function wallPlain(B: GeoBuilder, c: Readonly<Record<string, string>>, h = H): void {
  footing(B, 2, 0.24);
  panel(B, -0.92, 0.92, 0.2, h - 0.12, 0.22, c.main!);
  frame(B, 2, h, 0.22, c.trim!);
  // A diagonal brace: a little timber-frame character.
  if (h > 2) {
    const len = Math.hypot(1.5, h - 0.5);
    put(B, rb(0.1, len, 0.25, 0.03), shade(c.trim!, 1.03), -0.2, h / 2, 0, 0, 0, Math.atan2(1.5, h - 0.5) * 0.5);
  }
}

function wallWindow(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  footing(B, 2, 0.24);
  const x0 = -0.42;
  const x1 = 0.42;
  const y0 = 0.95;
  const y1 = 1.95;
  panel(B, -0.92, 0.92, 0.2, y0, 0.22, c.main!);
  panel(B, -0.92, 0.92, y1, H - 0.12, 0.22, c.main!);
  panel(B, -0.92, x0, y0, y1, 0.22, c.main!);
  panel(B, x1, 0.92, y0, y1, 0.22, c.main!);
  frame(B, 2, H, 0.22, c.trim!);
  // Window: glass, frame, cross mullions, sills, shutters, a flower box.
  B.add('glass', rb(x1 - x0, y1 - y0, 0.04, 0.01), new Color(0.85, 0.5, 0.4), T(0, (y0 + y1) / 2, 0), { ao: false, jitter: 0 });
  const fr = shade(CREAM, 0.98);
  for (const sz of [-1, 1]) {
    put(B, rb(x1 - x0 + 0.12, 0.08, 0.06, 0.02), fr, 0, y1 + 0.02, sz * 0.12);
    put(B, rb(x1 - x0 + 0.2, 0.07, 0.12, 0.02), fr, 0, y0 - 0.02, sz * 0.14);
    for (const sx of [-1, 1]) put(B, rb(0.07, y1 - y0, 0.06, 0.02), fr, sx * ((x1 - x0) / 2 + 0.02), (y0 + y1) / 2, sz * 0.12);
    put(B, rb(0.04, y1 - y0, 0.05, 0.01), fr, 0, (y0 + y1) / 2, sz * 0.03);
    put(B, rb(x1 - x0, 0.04, 0.05, 0.01), fr, 0, (y0 + y1) / 2 + 0.08, sz * 0.03);
  }
  const shutter = c.shutter ?? c.trim!;
  for (const sx of [-1, 1]) {
    put(B, rb(0.4, y1 - y0 + 0.04, 0.05, 0.02), shutter, sx * 0.66, (y0 + y1) / 2, 0.15);
    for (let k = 0; k < 4; k++) put(B, rb(0.34, 0.03, 0.03, 0.01), shade(shutter, 0.85), sx * 0.66, y0 + 0.15 + k * 0.24, 0.18, 0, 0, 0, FLAT);
  }
  // Flower box (outside, +Z).
  put(B, rb(0.86, 0.18, 0.2, 0.04), shade(c.trim!, 1.05), 0, y0 - 0.16, 0.25);
  for (let k = 0; k < 7; k++) {
    const fx = -0.36 + k * 0.12 + (B.random() - 0.5) * 0.04;
    put(B, sphere(0.075, 8, 6), k % 2 ? LEAF : LEAF_LIGHT, fx, y0 - 0.04, 0.26 + (B.random() - 0.5) * 0.05, 0, 0, 0, FLAT);
    if (k % 2 === 0) put(B, sphere(0.05, 8, 6), ['#e7a0a6', '#f1d27a', '#f4efe6'][k % 3]!, fx, y0 + 0.03, 0.3, 0, 0, 0, FLAT);
  }
}

function doorway(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const half = 0.7;
  const top = 2.1;
  slab(B, 2.06, -0.45, 0.12, 0.34, STONE_DARK, 0, 0, 0.05, FLAT);
  panel(B, -0.92, -half, 0.2, H - 0.12, 0.22, c.main!);
  panel(B, half, 0.92, 0.2, H - 0.12, 0.22, c.main!);
  panel(B, -half, half, top, H - 0.12, 0.22, c.main!);
  frame(B, 2, H, 0.22, c.trim!);
  // Door frame (jambs + lintel), threshold stone.
  for (const sx of [-1, 1]) slab(B, 0.12, 0.12, top, 0.3, c.trim!, sx * (half - 0.04), 0, 0.03);
  slab(B, 2 * half + 0.16, top - 0.02, top + 0.14, 0.32, shade(c.trim!, 0.95), 0, 0, 0.04);
  slab(B, 2 * half, 0.0, 0.1, 0.5, STONE, 0, 0, 0.04, FLAT);
  // The door leaf stands open against the inside wall.
  const leaf = c.shutter ?? c.trim!;
  B.at(T(-half + 0.06, 0, -0.16, Math.PI / 2), () => {
    put(B, rb(1.15, top - 0.16, 0.06, 0.02), leaf, 0.6, top / 2, 0.02);
    for (let k = 0; k < 4; k++) put(B, rb(0.02, top - 0.3, 0.07, 0.008), shade(leaf, 0.85), 0.18 + k * 0.28, top / 2, 0.02, 0, 0, 0, FLAT);
    put(B, sphere(0.04, 8, 6), '#c89b52', 1.05, 1.0, 0.08, 0, 0, 0, FLAT);
  });
  // A small lamp bracket by the door.
  put(B, rb(0.05, 0.05, 0.22, 0.01), IRON, half + 0.2, top + 0.15, 0.2, 0, 0, 0, FLAT);
}

function halfWall(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const h = PIECES.half_wall.h;
  footing(B, 2, 0.24);
  panel(B, -0.92, 0.92, 0.2, h - 0.08, 0.22, c.main!);
  for (const sx of [-1, 1]) slab(B, 0.16, 0.1, h - 0.06, 0.28, c.trim!, sx * 0.92, 0, 0.04);
  slab(B, 2.08, h - 0.1, h, 0.34, shade(c.trim!, 1.04), 0, 0, 0.04);
}

function pillar(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 0.44, -0.4, 0.18, 0.44, STONE_DARK, 0, 0, 0.06, FLAT);
  slab(B, 0.38, 0.1, 0.3, 0.38, STONE, 0, 0, 0.06, FLAT);
  slab(B, 0.24, 0.28, H - 0.22, 0.24, c.main!, 0, 0, 0.05);
  slab(B, 0.34, H - 0.24, H - 0.1, 0.34, c.trim!, 0, 0, 0.04);
  slab(B, 0.4, H - 0.1, H, 0.4, shade(c.trim!, 0.95), 0, 0, 0.04);
}

function roofFlat(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 2, 0, 0.18, 2, c.trim!, 0, 0, 0.05, FLAT);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    put(B, rb(0.46, 0.06, 0.46, 0.04), shade(mixc(c.main!, c.accent!, B.random() * 0.4), 0.95 + B.random() * 0.1), -0.75 + i * 0.5, 0.2, -0.75 + j * 0.5, 0, 0, 0, FLAT);
  }
}

function roofSlope(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const rise = PIECES.roof_slope.h;
  const angle = Math.atan2(rise, 2);
  const len = Math.hypot(2, rise);
  // Deck: low edge at local +Z (eaves, with overhang), high edge at -Z (ridge).
  B.at(T(0, rise / 2, 0, 0, angle), () => {
    put(B, rb(2, 0.14, len + 0.3, 0.04), c.trim!, 0, 0, 0.15, 0, 0, 0, FLAT);
    // Tile courses: overlapping rounded rows, the lowest one darkest.
    const rows = 6;
    for (let k = 0; k < rows; k++) {
      const z = len / 2 + 0.22 - k * ((len + 0.2) / rows);
      put(B, rb(1.99, 0.07, (len + 0.3) / rows + 0.06, 0.035), shade(mixc(c.main!, c.accent!, (k % 2) * 0.25), 0.88 + (k / rows) * 0.14 + B.random() * 0.04), 0, 0.09, z, 0, 0, 0, FLAT);
    }
  });
  // Half ridge cap on this side (two facing slopes complete the cap without overlapping).
  put(B, rb(2, 0.12, 0.16, 0.05), shade(c.trim!, 0.92), 0, rise + 0.08, -0.92);
}

function roofPeak(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const rise = PIECES.roof_peak.h;
  // Closed gable ends.
  B.at(T(0, 0, 0), () => {
    for (const sz of [-1, 1]) {
      const g = extrude(`peakend`, () => {
        const s = new Shape();
        s.moveTo(-1, 0);
        s.lineTo(1, 0);
        s.lineTo(0, rise - 0.05);
        s.closePath();
        return s;
      }, { depth: 0.16, bevelEnabled: false });
      put(B, g, CREAM, 0, 0, sz * 0.88);
    }
    slab(B, 1.9, 0, 0.12, 1.9, c.trim!, 0, 0, 0.03, FLAT);
  });
  put(B, gableRoof(2, rise, 2, 0.2, 0.18, 0.06), c.main!, 0, 0.02, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.08, 0.08, 2, 10), shade(c.trim!, 0.9), 0, rise + 0.06, 0, 0, Math.PI / 2, 0, FLAT);
}

function gable(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const rise = PIECES.gable.h;
  const g = extrude('gabletri', () => {
    const s = new Shape();
    s.moveTo(-1, 0);
    s.lineTo(1, 0);
    s.lineTo(1, rise - 0.04);
    s.closePath();
    return s;
  }, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1 });
  put(B, g, c.main!, 0, 0, 0);
  slab(B, 2.02, 0, 0.12, 0.26, c.trim!, 0, 0, 0.03);
  // A little round vent window.
  put(B, cyl(0.13, 0.13, 0.26, 14), c.trim!, 0.45, 0.42, 0, 0, Math.PI / 2, 0, FLAT);
  B.add('glass', cyl(0.09, 0.09, 0.27, 14), new Color(0.7, 0.5, 0.3), T(0.45, 0.42, 0, 0, Math.PI / 2, 0), { ao: false, jitter: 0 });
}

function steps(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 2, -0.4, 0.18, 1, STONE_DARK, 0, 0, 0.05, FLAT);
  slab(B, 1.96, 0.1, 0.2, 0.98, c.main!, 0, 0, 0.05, FLAT);
  slab(B, 1.9, 0.18, 0.36, 0.5, mixc(c.main!, c.accent!, 0.3), 0, -0.22, 0.05, FLAT);
}

function fence(B: GeoBuilder, c: Readonly<Record<string, string>>, gate: boolean): void {
  const h = PIECES.fence.h;
  for (const sx of [-1, 1]) {
    slab(B, 0.14, -0.2, gate ? h + 0.18 : h + 0.05, 0.14, c.trim!, sx * 0.93, 0, 0.04);
    put(B, sphere(gate ? 0.1 : 0.075, 10, 8), shade(c.trim!, 1.05), sx * 0.93, (gate ? h + 0.18 : h + 0.05) + 0.03, 0, 0, 0, 0, FLAT);
  }
  const pickets = (span: number) => {
    const n = Math.round(span / 0.2);
    for (let k = 0; k < n; k++) {
      const x = -span / 2 + (k + 0.5) * (span / n);
      const ph = h - 0.18 + (B.random() - 0.5) * 0.04;
      put(B, rb(0.1, ph, 0.045, 0.02), shade(c.main!, 0.95 + B.random() * 0.1), x, ph / 2 + 0.04, 0.03);
      put(B, cone(0.06, 0.12, 6), shade(c.main!, 1.02), x, ph + 0.1, 0.03, 0, 0, 0, FLAT);
    }
    for (const y of [0.28, h - 0.32]) put(B, rb(span, 0.07, 0.05, 0.02), c.trim!, 0, y, -0.02);
  };
  if (!gate) {
    pickets(1.72);
    return;
  }
  // Open gate leaf swung outward on its hinge.
  B.at(T(-0.84, 0, 0.05, -1.75), () => {
    B.at(T(0.76, 0, 0), () => pickets(1.5));
    put(B, rb(0.06, 0.06, 0.05, 0.01), IRON, 0.05, 0.3, 0, 0, 0, 0, FLAT);
    put(B, rb(0.06, 0.06, 0.05, 0.01), IRON, 0.05, h - 0.32, 0, 0, 0, 0, FLAT);
  });
}

function table(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const h = PIECES.table.h;
  slab(B, 1.4, h - 0.08, h, 0.9, c.main!, 0, 0, 0.035);
  slab(B, 1.24, h - 0.18, h - 0.07, 0.74, c.trim!, 0, 0, 0.02);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) slab(B, 0.09, 0, h - 0.08, 0.09, c.trim!, sx * 0.6, sz * 0.35, 0.03);
  // A jug of flowers.
  put(B, cyl(0.07, 0.09, 0.2, 12), '#d9cdb4', 0.25, h + 0.1, -0.05);
  for (let k = 0; k < 4; k++) put(B, sphere(0.05, 8, 6), k % 2 ? '#e7a0a6' : '#f1d27a', 0.25 + Math.cos(k * 1.7) * 0.06, h + 0.26 + (k % 2) * 0.03, -0.05 + Math.sin(k * 1.7) * 0.06, 0, 0, 0, FLAT);
}

function bench(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  for (let k = 0; k < 3; k++) slab(B, 1.6, 0.42, 0.48, 0.13, shade(c.main!, 0.95 + k * 0.04), 0, -0.14 + k * 0.14, 0.025);
  for (const sx of [-1, 1]) {
    slab(B, 0.08, 0, 0.44, 0.38, c.trim!, sx * 0.68, 0, 0.03);
    slab(B, 0.07, 0.42, 0.85, 0.07, c.trim!, sx * 0.68, -0.2, 0.02);
    slab(B, 0.08, 0.62, 0.68, 0.42, c.trim!, sx * 0.72, 0, 0.02);
  }
  for (const y of [0.62, 0.78]) slab(B, 1.44, y, y + 0.09, 0.05, c.main!, 0, -0.21, 0.02);
}

function chair(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 0.48, 0.44, 0.5, 0.46, c.main!, 0, 0.02, 0.025);
  slab(B, 0.4, 0.5, 0.56, 0.38, c.accent!, 0, 0.03, 0.03);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) slab(B, 0.05, 0, sz < 0 ? 0.95 : 0.44, 0.05, c.trim!, sx * 0.2, sz * 0.19, 0.015);
  for (let k = 0; k < 3; k++) slab(B, 0.38, 0.62 + k * 0.1, 0.67 + k * 0.1, 0.04, c.trim!, 0, -0.19, 0.015);
}

function lamp(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 0.34, -0.2, 0.14, 0.34, STONE_DARK, 0, 0, 0.06, FLAT);
  put(B, cyl(0.09, 0.12, 0.2, 12), c.trim!, 0, 0.24, 0);
  put(B, cyl(0.045, 0.05, 1.5, 10), c.main!, 0, 1.05, 0);
  put(B, cyl(0.08, 0.06, 0.08, 10), c.trim!, 0, 1.8, 0, 0, 0, 0, FLAT);
  // Lantern head: glass between four little posts, a cap and a finial.
  B.add('glow', rb(0.2, 0.26, 0.2, 0.03), new Color(1, 1, 1), T(0, 1.97, 0), { ao: false, jitter: 0 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(B, rb(0.03, 0.3, 0.03, 0.01), c.main!, sx * 0.11, 1.97, sz * 0.11, 0, 0, 0, FLAT);
  put(B, cone(0.2, 0.14, 4), c.main!, 0, 2.18, 0, Math.PI / 4, 0, 0, FLAT);
  put(B, sphere(0.035, 8, 6), c.trim!, 0, 2.27, 0, 0, 0, 0, FLAT);
}

function planter(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 1, 0, 0.42, 0.5, c.main!, 0, 0, 0.05);
  slab(B, 1.04, 0.36, 0.46, 0.54, shade(c.main!, 1.08), 0, 0, 0.03);
  slab(B, 0.9, 0.38, 0.47, 0.4, SOIL, 0, 0, 0.03, FLAT);
  for (let k = 0; k < 9; k++) {
    const x = -0.38 + (k % 5) * 0.19 + (B.random() - 0.5) * 0.05;
    const z = (k < 5 ? -0.08 : 0.09) + (B.random() - 0.5) * 0.04;
    put(B, sphere(0.1 + B.random() * 0.03, 8, 6), k % 2 ? c.trim! : LEAF_LIGHT, x, 0.55, z, 0, 0, 0, FLAT);
    put(B, sphere(0.055, 8, 6), shade(c.accent!, 0.92 + B.random() * 0.16), x + 0.03, 0.66 + B.random() * 0.06, z, 0, 0, 0, FLAT);
  }
}

function crate(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  const h = PIECES.crate.h;
  slab(B, 0.76, 0, h - 0.02, 0.76, c.main!, 0, 0, 0.04);
  for (const y of [0.05, h - 0.07]) for (const sz of [-1, 1]) slab(B, 0.8, y - 0.04, y + 0.05, 0.05, c.trim!, 0, sz * 0.37, 0.015, FLAT);
  for (const y of [0.05, h - 0.07]) for (const sx of [-1, 1]) slab(B, 0.05, y - 0.04, y + 0.05, 0.8, c.trim!, sx * 0.37, 0, 0.015, FLAT);
  for (const sz of [-1, 1]) put(B, rb(0.06, 0.82, 0.04, 0.015), c.trim!, 0, h / 2, sz * 0.39, 0, 0, 0.72, FLAT);
}

function rug(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 2, 0, 0.02, 1.4, c.trim!, 0, 0, 0.008, FLAT);
  slab(B, 1.78, 0, 0.026, 1.18, c.main!, 0, 0, 0.008, FLAT);
  slab(B, 1.3, 0, 0.03, 0.7, c.accent!, 0, 0, 0.008, FLAT);
  slab(B, 0.9, 0, 0.034, 0.32, c.trim!, 0, 0, 0.008, FLAT);
  for (const sx of [-1, 1]) put(B, rb(0.1, 0.012, 1.2, 0.004), c.trim!, sx * 1.04, 0.008, 0, 0, 0, 0, FLAT);
}

function sign(B: GeoBuilder, c: Readonly<Record<string, string>>): void {
  slab(B, 0.24, -0.15, 0.08, 0.24, STONE_DARK, 0, 0, 0.05, FLAT);
  put(B, rb(0.09, 1.3, 0.09, 0.03), c.trim!, 0, 0.65, -0.02);
  slab(B, 0.8, 0.82, 1.26, 0.07, c.main!, 0, 0, 0.03);
  slab(B, 0.84, 1.24, 1.3, 0.1, shade(c.trim!, 1.05), 0, 0, 0.02);
  for (const sx of [-1, 1]) put(B, sphere(0.02, 6, 4), IRON, sx * 0.33, 1.2, 0.04, 0, 0, 0, FLAT);
}

// ---------------------------------------------------------------------------

/** Board on which a sign's text is drawn (local frame, front face +Z). */
export const SIGN_FACE = { width: 0.72, height: 0.36, y: 1.04, z: 0.037 } as const;
/** Lantern glass centre (halo position) relative to the lamp base. */
export const LAMP_GLOW_Y = 1.97;

export function templateFor(kind: PieceKind, variant: string, upper = false): Template {
  const key = `${kind}|${variant}|${upper && kind === 'floor' ? 'u' : ''}`;
  let t = cache.get(key);
  if (t) return t;
  const B = new GeoBuilder(key.length * 131 + kind.charCodeAt(0));
  const c = variantColors(kind, variant);
  switch (kind) {
    case 'floor':
      floor(B, c, variant, upper);
      break;
    case 'wall':
      wallPlain(B, c);
      break;
    case 'wall_window':
      wallWindow(B, c);
      break;
    case 'doorway':
      doorway(B, c);
      break;
    case 'half_wall':
      halfWall(B, c);
      break;
    case 'pillar':
      pillar(B, c);
      break;
    case 'roof_flat':
      roofFlat(B, c);
      break;
    case 'roof_slope':
      roofSlope(B, c);
      break;
    case 'roof_peak':
      roofPeak(B, c);
      break;
    case 'gable':
      gable(B, c);
      break;
    case 'steps':
      steps(B, c);
      break;
    case 'fence':
      fence(B, c, false);
      break;
    case 'gate':
      fence(B, c, true);
      break;
    case 'table':
      table(B, c);
      break;
    case 'bench':
      bench(B, c);
      break;
    case 'chair':
      chair(B, c);
      break;
    case 'lamp':
      lamp(B, c);
      break;
    case 'planter':
      planter(B, c);
      break;
    case 'crate':
      crate(B, c);
      break;
    case 'rug':
      rug(B, c);
      break;
    case 'sign':
      sign(B, c);
      break;
  }
  t = B.build() as Template;
  cache.set(key, t);
  return t;
}

/** Triangle count of a template (debug / scale measurements). */
export function templateTriangles(t: Template): number {
  let n = 0;
  for (const g of t.values()) n += (g.index ? g.index.count : g.attributes.position!.count) / 3;
  return n;
}
