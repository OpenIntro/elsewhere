/**
 * Interior furnishings for walk-in buildings, built from the shared FURNITURE
 * list (positions, facing and collision footprints come from interiors.ts —
 * what you bump into is what you see) plus per-room dressing that has no
 * collision: wall pictures, shelves of jars, pendant lamps, rugs, books.
 * Same handmade clay/painted-wood language as the outside.
 *
 * Lamps register as `interior_<id>` light anchors (on with the street lights,
 * warm pools on the floor, part of the point-light budget near the focus).
 */
import { getInterior, groundHeight, type Building, type FurniturePiece, type Interior } from '@elsewhere/shared';
import { box, cone, cyl, quad, rbox, sphere, T, torus, type ColorLike, type GeoBuilder } from '../geom.js';
import { signUV } from '../signs.js';
import { cutSlot } from '../cutaway.js';
import { anchors, barrel, crate, mix, P, shade, shrub, worldPoint } from './kit.js';
import { innerFace } from './walkin.js';

const BOOKS = ['#8a4a3c', '#4f6f66', '#c89b52', '#5a4c5c', '#a7856a', '#6b7f86', '#b0563d', '#d9c4a0', '#3f5a52'];
const JARS = ['#c9a23f', '#b8453a', '#6f8f52', '#e9dcc8', '#a7856a', '#8fb0b4'];

function lightId(it: Interior): string {
  return `interior_${it.id}`;
}

/** Small warm glow (candle, embers, lamp bulb) tied to the interior's lights. */
function glow(B: GeoBuilder, it: Interior, x: number, y: number, z: number, size = 0.06, kind: 0 | 1 = 1): void {
  anchors.glows.push({ lightId: lightId(it), position: worldPoint(B, x, y, z), size, kind });
}

function candle(B: GeoBuilder, it: Interior, x: number, y: number, z: number): void {
  B.add('solid', cyl(0.05, 0.06, 0.03, 10), P.brass, T(x, y + 0.015, z), { ao: false });
  B.add('solid', cyl(0.025, 0.025, 0.12, 8), '#f4efe6', T(x, y + 0.09, z), { ao: false });
  glow(B, it, x, y + 0.18, z, 0.035);
}

function books(B: GeoBuilder, x0: number, x1: number, y: number, z: number, depth = 0.22, seed = 0): void {
  let x = x0;
  let k = seed;
  while (x < x1 - 0.06) {
    const w = 0.05 + ((k * 7) % 4) * 0.012;
    const h = 0.22 + ((k * 5) % 5) * 0.025;
    const lean = k % 9 === 4 ? 0.25 : 0;
    B.add('solid', box(w, h, depth), BOOKS[k % BOOKS.length]!, T(x + w / 2, y + h / 2, z, 0, 0, lean), { ao: false, jitter: 0.06 });
    x += w + 0.008 + (lean ? 0.06 : 0);
    k++;
  }
}

function jarsRow(B: GeoBuilder, x0: number, x1: number, y: number, z: number, seed = 0): void {
  const n = Math.max(2, Math.floor((x1 - x0) / 0.2));
  for (let i = 0; i < n; i++) {
    const x = x0 + ((i + 0.5) / n) * (x1 - x0);
    const c = JARS[(i + seed) % JARS.length]!;
    if ((i + seed) % 3 === 0) {
      B.add('glazed', cyl(0.065, 0.07, 0.2, 10), '#cfe0dc', T(x, y + 0.1, z), { ao: false });
      B.add('solid', cyl(0.05, 0.055, 0.12, 10), c, T(x, y + 0.07, z), { ao: false });
      B.add('solid', cyl(0.07, 0.07, 0.03, 10), P.brass, T(x, y + 0.215, z), { ao: false });
    } else if ((i + seed) % 3 === 1) {
      B.add('solid', rbox(0.13, 0.17, 0.1, 0.02), c, T(x, y + 0.085, z), { ao: false });
    } else {
      B.add('glazed', cyl(0.06, 0.05, 0.09, 10), '#f4efe6', T(x, y + 0.045, z), { ao: false });
      B.add('solid', torus(0.035, 0.012, 4, 8), '#f4efe6', T(x + 0.07, y + 0.05, z), { ao: false });
    }
  }
}

function shelfBoard(B: GeoBuilder, w: number, y: number, depth: number, color: ColorLike): void {
  B.add('solid', rbox(w, 0.05, depth, 0.015), color, T(0, y, depth / 2 + 0.01), { ao: false });
  for (const sx of [-1, 1]) B.add('solid', rbox(0.04, 0.14, depth * 0.8, 0.01), shade(color, 0.8), T(sx * (w / 2 - 0.12), y - 0.08, depth * 0.45), { ao: false });
}

function picture(B: GeoBuilder, w: number, h: number, frame: ColorLike, a: ColorLike, b: ColorLike, c: ColorLike): void {
  B.add('solid', rbox(w + 0.1, h + 0.1, 0.05, 0.02), frame, T(0, 0, 0.025), { ao: false });
  B.add('solid', box(w, h, 0.02), mix(a, '#f2ead6', 0.3), T(0, 0, 0.05), { ao: false });
  // a painted landscape: sky, hills, a sun
  B.add('solid', box(w * 0.98, h * 0.38, 0.012), b, T(0, -h * 0.28, 0.062), { ao: false });
  B.add('solid', sphere(w * 0.22, 10, 6), c, T(-w * 0.12, -h * 0.12, 0.05, 0, 0, 0, 1.7, 0.7, 0.12), { ao: false });
  B.add('solid', cyl(w * 0.08, w * 0.08, 0.01, 12), '#f1d27a', T(w * 0.25, h * 0.22, 0.062, 0, Math.PI / 2), { ao: false });
}

function plant(B: GeoBuilder, f: FurniturePiece): void {
  const pot = ['#b5704f', '#7b8e8a', '#c9a87c'][f.variant % 3]!;
  B.add('solid', cyl(0.24, 0.18, 0.4, 14), pot, T(0, 0.2, 0));
  B.add('solid', torus(0.235, 0.03, 6, 16), shade(pot, 0.85), T(0, 0.4, 0, 0, Math.PI / 2));
  B.add('solid', cyl(0.21, 0.21, 0.03, 12), P.soil, T(0, 0.39, 0), { ao: false });
  if (f.variant % 3 === 1) {
    // fiddle-leaf: a stem with big leaves
    B.add('solid', cyl(0.025, 0.03, f.height - 0.5, 6), P.woodDark, T(0, 0.4 + (f.height - 0.5) / 2, 0));
    for (let k = 0; k < 9; k++) {
      const a = k * 2.3;
      const y = 0.7 + (k / 9) * (f.height - 0.6);
      B.add('plant', sphere(0.15, 8, 6), mix(P.leaf, P.leafLight, (k % 3) / 3), T(Math.cos(a) * 0.15, y, Math.sin(a) * 0.15, a, 0.5, 0, 1, 0.3, 1.4), { ao: false });
    }
  } else B.at(T(0, 0.38, 0), () => shrub(B, 0.32 + f.height * 0.08, f.variant % 3 === 2 ? '#7f9a5c' : P.leaf, f.variant % 3 === 2 ? 4 : 0));
}

function rug(B: GeoBuilder, f: FurniturePiece): void {
  const palettes: [string, string, string][] = [
    ['#9c4a3c', '#e3c99a', '#4f6f66'],
    ['#4f6f66', '#e9dcc0', '#b0563d'],
    ['#6a5a6e', '#d9c39a', '#8a4a3c'],
    ['#8a6a4a', '#efe3c8', '#5f7c74'],
    ['#7a3f36', '#f1d27a', '#3f5a52'],
    ['#5f7c74', '#efe3cf', '#a65e4b'],
  ];
  const [base, border, mid] = palettes[f.variant % palettes.length]!;
  const big = f.variant === 2;
  const w = big ? 3.6 : f.variant === 3 ? 2.4 : 2.6;
  const d = big ? 6.8 : f.variant === 3 ? 1.8 : 1.9;
  B.add('solid', rbox(w, 0.025, d, 0.012), border, T(0, 0.0125, 0), { ao: false });
  B.add('solid', rbox(w - 0.22, 0.03, d - 0.22, 0.012), base, T(0, 0.016, 0), { ao: false });
  B.add('solid', rbox(w - 0.6, 0.034, d - 0.6, 0.012), mid, T(0, 0.018, 0), { ao: false });
  B.add('solid', rbox(w - 0.9, 0.037, d - 0.9, 0.012), base, T(0, 0.019, 0), { ao: false });
  for (const s of [-1, 1]) for (let k = 0; k < Math.round(w / 0.12); k++) B.add('solid', box(0.025, 0.012, 0.09), border, T(-w / 2 + 0.06 + k * 0.12, 0.006, s * (d / 2 + 0.04)), { ao: false });
}

function cafeTable(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  B.add('solid', cyl(0.28, 0.34, 0.05, 14), P.iron, T(0, 0.025, 0));
  B.add('solid', cyl(0.05, 0.06, 0.7, 8), P.iron, T(0, 0.38, 0));
  B.add('solid', cyl(0.5, 0.48, 0.06, 22), '#a57b55', T(0, 0.73, 0));
  B.add('solid', torus(0.49, 0.025, 5, 24), shade('#a57b55', 0.8), T(0, 0.73, 0, 0, Math.PI / 2));
  B.add('glazed', cyl(0.06, 0.05, 0.1, 10), '#f4efe6', T(0.18, 0.81, 0.08), { ao: false });
  B.add('solid', cyl(0.045, 0.045, 0.01, 10), '#5a3d2e', T(0.18, 0.86, 0.08), { ao: false });
  B.add('glazed', cyl(0.06, 0.05, 0.1, 10), '#f4efe6', T(-0.2, 0.81, -0.06), { ao: false });
  B.add('glazed', cyl(0.035, 0.045, 0.14, 8), '#8fb0b4', T(0, 0.83, -0.18), { ao: false });
  B.add('plant', sphere(0.06, 8, 6), P.petals[f.variant % P.petals.length]!, T(0, 0.93, -0.18), { ao: false });
  B.add('plant', sphere(0.05, 8, 6), '#e7a0a6', T(0.04, 0.95, -0.16), { ao: false });
  candle(B, it, -0.05, 0.76, 0.2);
}

function counterCafe(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 2;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.36;
  const W = hw * 2;
  const D = hd * 2;
  const teal = '#4f6f66';
  B.add('solid', rbox(W, 0.98, D, 0.05), '#6f5440', T(0, 0.49, 0), { grad: 0.15 });
  // panelled front (towards the room)
  const n = Math.round(W / 0.7);
  for (let k = 0; k < n; k++) B.add('solid', rbox(W / n - 0.12, 0.62, 0.03, 0.02), teal, T(-W / 2 + (k + 0.5) * (W / n), 0.48, D / 2 + 0.01), { ao: false });
  B.add('solid', rbox(W + 0.1, 0.07, D + 0.12, 0.025), '#ece6da', T(0, 1.01, 0.02), { ao: false });
  B.add('solid', rbox(W, 0.06, 0.06, 0.02), P.brass, T(0, 0.12, D / 2 + 0.08), { ao: false });
  // espresso machine (right end): chrome body, brass dome, two group heads, cups on top
  B.at(T(W / 2 - 0.55, 1.05, -0.05), () => {
    B.add('solid', rbox(0.7, 0.42, 0.42, 0.06), '#b9c2c4', T(0, 0.21, 0));
    B.add('solid', rbox(0.72, 0.06, 0.44, 0.02), P.brass, T(0, 0.43, 0), { ao: false });
    B.add('solid', sphere(0.15, 12, 8), P.brass, T(0, 0.5, -0.05, 0, 0, 0, 1, 0.7, 1), { ao: false });
    B.add('solid', sphere(0.04, 8, 6), '#7a3f36', T(0, 0.62, -0.05), { ao: false });
    for (const sx of [-1, 1]) {
      B.add('solid', cyl(0.05, 0.05, 0.1, 10), '#45474b', T(sx * 0.17, 0.12, 0.25), { ao: false });
      B.add('solid', rbox(0.04, 0.03, 0.18, 0.01), '#2e2a2a', T(sx * 0.17, 0.08, 0.36), { ao: false });
      B.add('glazed', cyl(0.045, 0.04, 0.07, 10), '#f4efe6', T(sx * 0.17, -0.0, 0.25), { ao: false });
    }
    B.add('solid', cyl(0.012, 0.012, 0.25, 6), '#c9ccce', T(0.32, 0.18, 0.22, 0, 0.4), { ao: false });
    for (let k = 0; k < 6; k++) B.add('glazed', cyl(0.04, 0.035, 0.05, 8), k % 2 ? '#efe4cf' : '#b8d0cc', T(-0.24 + k * 0.1, 0.48, 0.12), { ao: false });
  });
  // pastry case (left end): glass dome over a tiered stand of buns
  B.at(T(-W / 2 + 0.6, 1.05, 0.02), () => {
    B.add('solid', rbox(0.8, 0.06, 0.5, 0.02), '#6f5440', T(0, 0.03, 0));
    for (let k = 0; k < 7; k++) B.add('solid', sphere(0.07, 10, 7), k % 3 ? '#c98a4b' : '#e0b07a', T(-0.28 + (k % 4) * 0.18, 0.1, k < 4 ? -0.1 : 0.1), { ao: false, jitter: 0.08 });
    B.add('solid', cyl(0.14, 0.14, 0.02, 14), '#f4efe6', T(0.15, 0.2, 0), { ao: false });
    B.add('solid', cyl(0.12, 0.13, 0.08, 14), '#e9c5a8', T(0.15, 0.25, 0), { ao: false });
    B.add('solid', sphere(0.025, 6, 5), '#b8453a', T(0.15, 0.31, 0), { ao: false });
    B.add('glazed', rbox(0.78, 0.36, 0.48, 0.05), '#dfeceb', T(0, 0.23, 0), { ao: false });
  });
  // register, tip jar, menu stand
  B.add('solid', rbox(0.34, 0.2, 0.28, 0.03), '#7a3f36', T(0.15, 1.15, 0.0), { ao: false });
  B.add('solid', rbox(0.3, 0.1, 0.06, 0.02), '#2e3431', T(0.15, 1.26, -0.12, 0, -0.5), { ao: false });
  B.add('glazed', cyl(0.07, 0.07, 0.16, 10), '#dfeceb', T(0.55, 1.13, 0.18), { ao: false });
  for (let k = 0; k < 4; k++) B.add('solid', cyl(0.03, 0.03, 0.006, 8), P.brass, T(0.55 + (k - 1.5) * 0.02, 1.07 + k * 0.012, 0.18), { ao: false });
  candle(B, it, -0.4, 1.045, 0.25);
}

function backShelf(B: GeoBuilder, it: Interior, f: FurniturePiece, b: Building): void {
  // wall-mounted: open shelves from 1.4 m up (never in anyone's way)
  const W = f.variant === 1 ? 3.2 : 4.0;
  const wood = f.variant === 1 ? '#7d6a50' : '#6f5440';
  B.withCut(cutSlot(b.id, 'back'), () => {
    for (const [k, y] of [1.45, 1.86, 2.27].entries()) {
      shelfBoard(B, W, y, 0.28, wood);
      if (f.variant === 1) {
        // general goods: tins, boxes, folded cloth
        for (let i = 0; i < 10; i++) {
          const x = -W / 2 + 0.25 + i * ((W - 0.5) / 9);
          const c = JARS[(i + k * 2) % JARS.length]!;
          if ((i + k) % 3 === 0) B.add('solid', cyl(0.07, 0.07, 0.16, 10), c, T(x, y + 0.105, 0.15), { ao: false });
          else if ((i + k) % 3 === 1) B.add('solid', rbox(0.2, 0.14, 0.16, 0.02), shade(c, 0.95), T(x, y + 0.095, 0.15), { ao: false });
          else B.add('solid', rbox(0.24, 0.08, 0.2, 0.03), mix(c, '#efe3cf', 0.4), T(x, y + 0.065, 0.15), { ao: false });
        }
      } else jarsRow(B, -W / 2 + 0.15, W / 2 - 0.15, y + 0.025, 0.15, k * 2);
    }
    if (f.variant !== 1) {
      // hanging mugs on hooks under the lowest shelf
      for (let i = 0; i < 8; i++) B.add('glazed', cyl(0.045, 0.04, 0.08, 8), i % 2 ? '#efe4cf' : '#b8d0cc', T(-1.6 + i * 0.45, 1.3, 0.12), { ao: false });
      // a little sign above
      B.add('solid', rbox(1.4, 0.34, 0.04, 0.02), '#2f4a44', T(-0.6, 2.62, 0.04), { ao: false });
      B.addUV('sign', quad(1.24, 0.31), signUV('cafe'), T(-0.6, 2.62, 0.065));
    }
  });
  void it;
}

function chalkboard(B: GeoBuilder, b: Building): void {
  B.withCut(cutSlot(b.id, 'back'), () => {
    B.add('solid', rbox(1.3, 1.0, 0.05, 0.02), P.woodDark, T(0, 1.9, 0.025), { ao: false });
    B.add('solid', box(1.16, 0.86, 0.02), '#2e3431', T(0, 1.9, 0.05), { ao: false });
    B.addUV('sign', quad(1.0, 0.25), signUV('menu'), T(0, 2.17, 0.062));
    for (let k = 0; k < 4; k++) B.add('solid', box(0.6 + ((k * 3) % 4) * 0.08, 0.025, 0.005), '#e6e2d6', T(-0.1, 1.95 - k * 0.14, 0.062), { ao: false });
    B.add('solid', box(0.1, 0.05, 0.005), '#f1d27a', T(0.38, 1.6, 0.062), { ao: false });
    B.add('solid', rbox(1.1, 0.04, 0.08, 0.01), P.woodDark, T(0, 1.4, 0.07), { ao: false });
  });
}

function piano(B: GeoBuilder, it: Interior): void {
  const wood = '#4a3328';
  B.add('solid', rbox(1.5, 1.25, 0.5, 0.05), wood, T(0, 0.65, -0.08), { grad: 0.15 });
  B.add('solid', rbox(1.56, 0.07, 0.6, 0.03), shade(wood, 1.15), T(0, 1.3, -0.06));
  // keyboard
  B.add('solid', rbox(1.42, 0.08, 0.3, 0.02), shade(wood, 0.9), T(0, 0.72, 0.24));
  B.add('solid', box(1.3, 0.025, 0.16), '#f4efe6', T(0, 0.77, 0.28), { ao: false });
  for (let k = 0; k < 18; k++) if (k % 7 !== 2 && k % 7 !== 6) B.add('solid', box(0.035, 0.03, 0.09), '#2e2a2a', T(-0.62 + k * 0.073, 0.795, 0.25), { ao: false });
  B.add('solid', rbox(1.3, 0.36, 0.04, 0.02), shade(wood, 1.1), T(0, 0.98, 0.18, 0, 0.12), { ao: false });
  // music stand + sheets, candle holders
  B.add('solid', rbox(0.6, 0.3, 0.02, 0.005), '#f2ead6', T(0, 1.0, 0.205, 0, 0.12), { ao: false });
  for (const sx of [-1, 1]) {
    B.add('solid', cyl(0.012, 0.012, 0.18, 5), P.brass, T(sx * 0.62, 1.05, 0.2, 0, 0.6), { ao: false });
    candle(B, it, sx * 0.62, 1.1, 0.27);
  }
  for (const sx of [-1, 1]) B.add('solid', rbox(0.08, 0.7, 0.4, 0.02), shade(wood, 0.85), T(sx * 0.7, 0.35, 0.05));
  B.add('solid', cyl(0.06, 0.06, 0.18, 10), '#b5704f', T(-0.45, 1.42, -0.1), { ao: false });
  B.add('plant', sphere(0.12, 8, 6), P.leaf, T(-0.45, 1.58, -0.1), { ao: false });
  books(B, 0.1, 0.65, 1.335, -0.15, 0.18, 3);
}

function micStand(B: GeoBuilder): void {
  B.add('solid', cyl(0.14, 0.16, 0.03, 12), P.iron, T(0, 0.015, 0));
  B.add('solid', cyl(0.015, 0.015, 1.35, 6), P.iron, T(0, 0.7, 0));
  B.add('solid', sphere(0.05, 10, 8), '#9aa2a4', T(0, 1.42, 0.03, 0, 0, 0, 1, 1.3, 1), { ao: false });
}

function bookshelf(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.6;
  const W = hw * 2;
  const H = f.height;
  const wood = f.variant === 2 ? '#7a5c46' : '#6a4f3e';
  B.add('solid', rbox(W, H, 0.36, 0.03), shade(wood, 0.75), T(0, H / 2, -0.03));
  for (const sx of [-1, 1]) B.add('solid', rbox(0.06, H, 0.4, 0.02), wood, T(sx * (W / 2 - 0.03), H / 2, 0));
  const rows = Math.max(3, Math.round(H / 0.42));
  for (let r = 0; r <= rows; r++) {
    const y = 0.05 + (r * (H - 0.1)) / rows;
    B.add('solid', rbox(W - 0.04, 0.04, 0.38, 0.01), wood, T(0, y, 0), { ao: false });
    if (r < rows) books(B, -W / 2 + 0.08, W / 2 - 0.08 - (r === 1 ? 0.3 : 0), y + 0.02, 0.02, 0.24, r * 5 + f.variant);
    if (r === 1) B.add('solid', sphere(0.09, 10, 8), '#c9a87c', T(W / 2 - 0.2, y + 0.11, 0.03), { ao: false });
  }
  B.add('solid', rbox(W + 0.06, 0.06, 0.44, 0.02), shade(wood, 1.1), T(0, H, 0));
}

function storeCounter(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.7;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.36;
  const W = hw * 2;
  const D = hd * 2;
  B.add('solid', rbox(W, 0.92, D, 0.05), '#8a6a4c', T(0, 0.46, 0), { grad: 0.15 });
  for (let k = 0; k < Math.round(W / 0.15); k++) B.add('solid', box(0.02, 0.8, 0.02), shade('#8a6a4c', 0.8), T(-W / 2 + 0.08 + k * 0.15, 0.46, D / 2 + 0.005), { ao: false });
  B.add('solid', rbox(W + 0.12, 0.07, D + 0.1, 0.025), '#6f5440', T(0, 0.95, 0.02));
  // brass scale
  B.at(T(-W / 2 + 0.45, 0.99, 0), () => {
    B.add('solid', rbox(0.3, 0.05, 0.2, 0.02), P.brass, T(0, 0.025, 0), { ao: false });
    B.add('solid', cyl(0.02, 0.02, 0.3, 6), P.brass, T(0, 0.2, 0), { ao: false });
    B.add('solid', rbox(0.5, 0.02, 0.03, 0.01), P.brass, T(0, 0.35, 0), { ao: false });
    for (const sx of [-1, 1]) B.add('solid', cyl(0.1, 0.07, 0.03, 12), P.brass, T(sx * 0.24, 0.22, 0), { ao: false });
    B.add('solid', sphere(0.06, 8, 6), '#b8453a', T(-0.24, 0.27, 0), { ao: false });
  });
  // cash register
  B.at(T(0.2, 0.99, -0.05), () => {
    B.add('solid', rbox(0.46, 0.26, 0.36, 0.04), '#5a4c5c', T(0, 0.13, 0));
    B.add('solid', rbox(0.4, 0.14, 0.04, 0.02), P.brass, T(0, 0.33, -0.1), { ao: false });
    for (let k = 0; k < 6; k++) B.add('solid', cyl(0.025, 0.025, 0.03, 8), '#f4efe6', T(-0.15 + (k % 3) * 0.15, 0.27, 0.05 + Math.floor(k / 3) * 0.08), { ao: false });
  });
  // glass candy jars
  for (let k = 0; k < 3; k++) {
    const x = W / 2 - 0.35 - k * 0.24;
    B.add('glazed', cyl(0.09, 0.09, 0.26, 12), '#dfeceb', T(x, 1.12, 0.05), { ao: false });
    B.add('solid', cyl(0.07, 0.07, 0.14, 10), ['#e7a0a6', '#f1d27a', '#9fc0e8'][k]!, T(x, 1.06, 0.05), { ao: false });
    B.add('solid', sphere(0.05, 8, 6), P.woodDark, T(x, 1.27, 0.05), { ao: false });
  }
  // ledger + pencil
  B.add('solid', rbox(0.34, 0.03, 0.26, 0.01), '#f2ead6', T(0.75, 1.0, 0.12, 0.2), { ao: false });
  B.add('solid', cyl(0.008, 0.008, 0.18, 4), '#c9a23f', T(0.8, 1.02, 0.15, 0.9, 0, Math.PI / 2), { ao: false });
  candle(B, it, -0.3, 0.985, 0.22);
}

function shelfUnit(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.9;
  const W = hw * 2;
  const H = f.height;
  const wood = '#7d6a50';
  B.add('solid', rbox(W, H, 0.12, 0.03), shade(wood, 0.8), T(0, H / 2, -0.17));
  for (const sx of [-1, 1]) B.add('solid', rbox(0.07, H, 0.46, 0.02), wood, T(sx * (W / 2 - 0.035), H / 2, 0));
  const rows = 4;
  for (let r = 0; r <= rows; r++) {
    const y = 0.12 + (r * (H - 0.2)) / rows;
    B.add('solid', rbox(W - 0.05, 0.05, 0.46, 0.015), wood, T(0, y, 0), { ao: false });
    if (r === rows) break;
    const n = Math.round(W / 0.22);
    for (let i = 0; i < n; i++) {
      const x = -W / 2 + 0.18 + (i * (W - 0.36)) / Math.max(1, n - 1);
      const k = i + r * 3 + f.variant * 5;
      const c = JARS[k % JARS.length]!;
      const kind = (f.variant + r) % 4;
      if (kind === 0) B.add('solid', cyl(0.075, 0.075, 0.18, 10), c, T(x, y + 0.115, 0.05), { ao: false, jitter: 0.07 });
      else if (kind === 1) B.add('solid', rbox(0.18, 0.22, 0.2, 0.02), mix(c, '#efe3cf', 0.25), T(x, y + 0.135, 0.04), { ao: false, jitter: 0.07 });
      else if (kind === 2) {
        B.add('glazed', cyl(0.06, 0.07, 0.24, 10), '#cfe0dc', T(x, y + 0.145, 0.05), { ao: false });
        B.add('solid', cyl(0.05, 0.06, 0.14, 10), c, T(x, y + 0.1, 0.05), { ao: false });
      } else B.add('solid', cyl(0.08, 0.08, 0.2, 10), mix(c, '#efe3cf', 0.5), T(x, y + 0.13, 0.04, 0, 0, Math.PI / 2), { ao: false });
    }
  }
  B.add('solid', rbox(W + 0.08, 0.08, 0.5, 0.02), shade(wood, 1.1), T(0, H, 0));
  // a hand-lettered label board on top
  B.add('solid', rbox(W * 0.6, 0.22, 0.04, 0.02), '#e8dcc2', T(0, H + 0.15, 0.1), { ao: false });
  B.add('solid', box(W * 0.45, 0.03, 0.005), '#5a4636', T(0, H + 0.15, 0.123), { ao: false });
}

function displayTable(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.75;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.5;
  B.add('solid', rbox(hw * 2, 0.08, hd * 2, 0.03), '#8a6a4c', T(0, 0.8, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(0.08, 0.78, 0.08, 0.02), '#6f5440', T(sx * (hw - 0.1), 0.39, sz * (hd - 0.1)));
  B.add('solid', rbox(hw * 2 - 0.1, 0.04, hd * 2 - 0.1, 0.01), '#7d6a50', T(0, 0.22, 0));
  // baskets of produce + stacked postcards + string spools
  for (const [x, z, c] of [[-0.42, -0.18, '#b8453a'], [0.0, 0.15, '#c9a23f'], [0.42, -0.15, '#6f8f52']] as const) {
    B.add('solid', cyl(0.2, 0.15, 0.14, 12), '#c49a6a', T(x, 0.91, z));
    B.add('solid', torus(0.2, 0.025, 5, 14), shade('#c49a6a', 0.8), T(x, 0.98, z, 0, Math.PI / 2));
    for (let k = 0; k < 5; k++) B.add('solid', sphere(0.07, 8, 6), c, T(x + Math.cos(k * 1.3) * 0.08, 1.0 + (k % 2) * 0.03, z + Math.sin(k * 1.3) * 0.08), { ao: false, jitter: 0.08 });
  }
  for (let k = 0; k < 4; k++) B.add('solid', rbox(0.16, 0.012, 0.11, 0.004), ['#9fc0e8', '#e7a0a6', '#f1d27a', '#f4efe6'][k]!, T(0.45, 0.85 + k * 0.012, 0.3, k * 0.15), { ao: false });
  for (let k = 0; k < 3; k++) B.add('solid', cyl(0.05, 0.05, 0.1, 10), ['#e3c99a', '#9c4a3c', '#4f6f66'][k]!, T(-0.5 + k * 0.12, 0.89, 0.32), { ao: false });
  // under-shelf sacks
  B.add('solid', sphere(0.2, 10, 8), '#d9c4a0', T(-0.3, 0.42, 0, 0, 0, 0, 1.2, 0.8, 1), { ao: false });
  B.add('solid', sphere(0.18, 10, 8), '#c9b285', T(0.3, 0.4, 0.05, 0, 0, 0, 1.1, 0.8, 1), { ao: false });
}

function crateStack(B: GeoBuilder, f: FurniturePiece): void {
  const store = f.interiorId === 'general_store';
  B.at(T(-0.25, 0, 0, 0.05), () => crate(B, 0.6, '#b58f62'));
  B.at(T(0.32, 0, 0.05, -0.1), () => crate(B, 0.55, '#a98a62'));
  B.at(T(-0.15, 0.6, 0.02, 0.2), () => crate(B, 0.45, '#c49a6a'));
  if (store) {
    for (let k = 0; k < 9; k++) B.add('solid', sphere(0.1, 10, 8), k % 3 ? '#b8453a' : '#c9a23f', T(-0.3 + (k % 3) * 0.16, 1.1, -0.12 + Math.floor(k / 3) * 0.14), { ao: false, jitter: 0.08 });
    for (let k = 0; k < 5; k++) B.add('solid', sphere(0.09, 8, 6), '#e98a3b', T(0.22 + (k % 2) * 0.15, 0.62, -0.1 + k * 0.06), { ao: false, jitter: 0.08 });
  } else {
    B.add('solid', torus(0.16, 0.05, 6, 8), P.iron, T(0.3, 0.6, 0, 0, Math.PI / 2));
    B.add('solid', rbox(0.3, 0.1, 0.12, 0.02), '#a8705a', T(-0.1, 1.1, 0, 0.4));
  }
}

function sacks(B: GeoBuilder): void {
  for (const [x, z, s, c] of [[-0.25, 0, 1, '#d9c4a0'], [0.22, 0.05, 0.9, '#c9b285'], [0.0, -0.05, 0.8, '#e3d3b2']] as const) {
    B.add('solid', sphere(0.26 * s, 12, 9), c, T(x, 0.24 * s, z, 0, 0, 0, 1, 1.1, 0.85), { grad: 0.2 });
    B.add('solid', cyl(0.07 * s, 0.1 * s, 0.1, 8), shade(c, 0.9), T(x, 0.52 * s, z), { ao: false });
    B.add('solid', torus(0.08 * s, 0.015, 4, 10), '#8a6a4c', T(x, 0.5 * s, z, 0, Math.PI / 2), { ao: false });
  }
}

function stove(B: GeoBuilder, it: Interior, b: Building): void {
  B.add('solid', rbox(0.9, 0.06, 0.9, 0.02), '#8e8574', T(0, 0.03, 0), { ao: false });
  B.add('solid', cyl(0.3, 0.26, 0.7, 16), P.iron, T(0, 0.5, 0), { grad: 0.2 });
  B.add('solid', torus(0.3, 0.035, 6, 18), shade(P.iron, 1.3), T(0, 0.5, 0, 0, Math.PI / 2));
  for (let k = 0; k < 3; k++) B.add('solid', cyl(0.03, 0.04, 0.18, 6), P.iron, T(Math.cos(k * 2.1) * 0.2, 0.09, Math.sin(k * 2.1) * 0.2));
  B.add('solid', cyl(0.32, 0.3, 0.08, 16), P.iron, T(0, 0.88, 0));
  B.add('solid', rbox(0.22, 0.16, 0.04, 0.03), '#e98a3b', T(0, 0.5, 0.27), { ao: false });
  glow(B, it, 0, 0.5, 0.3, 0.1, 0);
  B.add('solid', cyl(0.09, 0.09, 0.4, 10), P.iron, T(0, 1.1, 0));
  B.withCut(cutSlot(b.id, 'roof'), () => B.add('solid', cyl(0.08, 0.08, b.height - b.floorLift, 10), P.iron, T(0, 1.3 + (b.height - b.floorLift - 1.3) / 2 + 0.6, 0)));
  B.add('solid', cyl(0.13, 0.11, 0.16, 10), '#5f6f5a', T(0.12, 0.98, 0.05), { ao: false });
  B.add('solid', cyl(0.015, 0.015, 0.14, 4), P.iron, T(0.24, 1.0, 0.05, 0, 0, 1.2), { ao: false });
}

function lectern(B: GeoBuilder, it: Interior): void {
  const wood = '#6a4f3e';
  B.add('solid', rbox(0.7, 0.1, 0.55, 0.03), shade(wood, 0.9), T(0, 0.05, 0));
  B.add('solid', rbox(0.5, 1.0, 0.36, 0.04), wood, T(0, 0.55, -0.02), { grad: 0.15 });
  B.add('solid', rbox(0.72, 0.06, 0.5, 0.02), shade(wood, 1.12), T(0, 1.1, 0.02, 0, -0.3));
  B.add('solid', rbox(0.5, 0.04, 0.34, 0.01), '#f2ead6', T(0, 1.15, 0.03, 0, -0.3), { ao: false });
  B.add('solid', box(0.02, 0.05, 0.34), '#8a4a3c', T(0, 1.16, 0.03, 0, -0.3), { ao: false });
  B.add('solid', rbox(0.34, 0.42, 0.03, 0.01), '#6a5a6e', T(0, 0.62, 0.17), { ao: false });
  B.add('solid', torus(0.08, 0.02, 5, 14), P.brass, T(0, 0.66, 0.19), { ao: false });
  candle(B, it, 0.3, 1.14, 0.15);
}

function archiveShelf(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.0;
  const W = hw * 2;
  const H = f.height;
  const wood = '#4f3a2e';
  B.add('solid', rbox(W, H, 0.1, 0.03), shade(wood, 0.8), T(0, H / 2, -0.22));
  for (const sx of [-1, 1]) B.add('solid', rbox(0.08, H, 0.56, 0.02), wood, T(sx * (W / 2 - 0.04), H / 2, 0));
  const rows = 5;
  for (let r = 0; r <= rows; r++) {
    const y = 0.1 + (r * (H - 0.2)) / rows;
    B.add('solid', rbox(W - 0.06, 0.05, 0.54, 0.015), wood, T(0, y, 0), { ao: false });
    if (r === rows) break;
    if ((r + f.variant) % 3 === 2) {
      // scroll cubbies
      for (let k = 0; k < 7; k++) B.add('solid', cyl(0.06, 0.06, 0.42, 8), k % 2 ? '#efe3c8' : '#e3d3b2', T(-W / 2 + 0.2 + k * ((W - 0.4) / 6), y + 0.09, 0.02, 0, Math.PI / 2), { ao: false });
    } else books(B, -W / 2 + 0.1, W / 2 - 0.1, y + 0.025, 0.02, 0.32, r * 4 + f.variant * 9);
  }
  B.add('solid', rbox(W + 0.12, 0.12, 0.62, 0.03), shade(wood, 1.15), T(0, H + 0.02, 0));
  // brass label plates
  for (let r = 0; r < rows; r++) B.add('solid', box(0.14, 0.05, 0.01), P.brass, T(0, 0.17 + (r * (H - 0.2)) / rows, 0.275), { ao: false });
  if (f.variant === 1) {
    // library ladder leaning on it
    for (const sx of [-1, 1]) B.add('solid', rbox(0.05, H * 0.95, 0.05, 0.015), '#8a6a4c', T(0.5 + sx * 0.2, H * 0.46, 0.45, 0, -0.18));
    for (let k = 0; k < 6; k++) B.add('solid', cyl(0.02, 0.02, 0.4, 5), '#8a6a4c', T(0.5, 0.3 + k * 0.38, 0.52 - k * 0.07, 0, 0, Math.PI / 2));
  }
}

function noticeBoard(B: GeoBuilder, b: Building): void {
  B.withCut(cutSlot(b.id, 'right'), () => {
    B.add('solid', rbox(1.7, 1.15, 0.06, 0.02), '#7a5c46', T(0, 1.65, 0.03), { ao: false });
    B.add('solid', box(1.54, 0.98, 0.02), '#c9a87c', T(0, 1.65, 0.065), { ao: false });
    B.addUV('sign', quad(0.56, 0.32), signUV('paper1'), T(-0.4, 1.8, 0.08, 0, 0, 0.05));
    B.addUV('sign', quad(0.52, 0.3), signUV('paper2'), T(0.38, 1.55, 0.08, 0, 0, -0.07));
    for (const [x, y, r, c] of [[0.35, 1.95, 0.1, '#f4efe6'], [-0.35, 1.45, -0.08, '#efe2c9'], [0.0, 1.62, 0.02, '#e9dcc8']] as const) B.add('solid', box(0.34, 0.24, 0.005), c, T(x, y, 0.08, 0, 0, r), { ao: false });
    for (const [x, y] of [[-0.4, 1.95], [0.38, 1.69], [0.35, 2.06], [-0.35, 1.56]] as const) B.add('solid', sphere(0.02, 6, 4), '#b8453a', T(x, y, 0.09), { ao: false });
    B.addUV('sign', quad(0.9, 0.22), signUV('notice'), T(0, 2.4, 0.04));
  });
}

function meetingTable(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.35;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.55;
  const wood = '#6a4f3e';
  B.add('solid', rbox(hw * 2, 0.08, hd * 2, 0.03), wood, T(0, 0.74, 0));
  for (const sx of [-1, 1]) {
    B.add('solid', rbox(0.12, 0.7, hd * 2 - 0.3, 0.03), shade(wood, 0.85), T(sx * (hw - 0.3), 0.36, 0));
    B.add('solid', rbox(0.3, 0.06, hd * 2 - 0.1, 0.02), shade(wood, 0.8), T(sx * (hw - 0.3), 0.04, 0));
  }
  B.add('solid', rbox(hw * 2 - 0.8, 0.06, 0.08, 0.02), shade(wood, 0.8), T(0, 0.25, 0));
  // runner, papers, inkwell, jug, candles
  B.add('solid', box(hw * 2 - 0.4, 0.01, 0.34), '#6a5a6e', T(0, 0.785, 0), { ao: false });
  for (let k = 0; k < 4; k++) B.add('solid', box(0.22, 0.008, 0.3), '#f2ead6', T(-hw + 0.45 + k * 0.62, 0.79, (k % 2 ? 1 : -1) * 0.3, (k - 1.5) * 0.15), { ao: false });
  B.add('glazed', cyl(0.07, 0.09, 0.22, 12), '#8fb0b4', T(0.1, 0.89, 0), { ao: false });
  B.add('solid', cyl(0.04, 0.04, 0.05, 8), '#2e2a2a', T(-0.5, 0.81, 0.1), { ao: false });
  B.add('solid', cone(0.02, 0.25, 4), '#f4efe6', T(-0.47, 0.92, 0.1, 0, 0.4), { ao: false });
  candle(B, it, 0.55, 0.78, 0);
  candle(B, it, -0.85, 0.78, 0);
}

function banner(B: GeoBuilder, b: Building, f: FurniturePiece): void {
  const [c1, c2] = f.variant ? ['#4f6f66', '#c89b52'] : ['#7a3f36', '#e3c99a'];
  B.withCut(cutSlot(b.id, 'back'), () => {
    B.add('solid', cyl(0.025, 0.025, 1.2, 6), P.brass, T(0, 3.6, 0.08, 0, 0, Math.PI / 2), { ao: false });
    for (const sx of [-1, 1]) B.add('solid', sphere(0.04, 6, 5), P.brass, T(sx * 0.62, 3.6, 0.08), { ao: false });
    B.add('solid', box(0.9, 1.6, 0.03), c1, T(0, 2.78, 0.07), { ao: false });
    B.add('solid', cone(0.45, 0.3, 3), c1, T(0, 1.86, 0.07, 0, 0, Math.PI, 1, 1, 0.07), { ao: false });
    B.add('solid', box(0.78, 0.05, 0.035), c2, T(0, 3.4, 0.075), { ao: false });
    B.add('solid', torus(0.2, 0.04, 6, 18), c2, T(0, 2.8, 0.09), { ao: false });
    B.add('solid', sphere(0.08, 8, 6), c2, T(0, 2.8, 0.09, 0, 0, 0, 1, 1, 0.4), { ao: false });
    for (let k = 0; k < 5; k++) B.add('solid', box(0.05, 0.12, 0.02), c2, T(-0.36 + k * 0.18, 2.0, 0.08), { ao: false });
  });
}

function workbench(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.2;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.5;
  const top = '#b58f62';
  B.add('solid', rbox(hw * 2, 0.12, hd * 2, 0.04), top, T(0, 0.86, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(0.12, 0.82, 0.12, 0.03), '#7a5c46', T(sx * (hw - 0.15), 0.41, sz * (hd - 0.12)));
  B.add('solid', rbox(hw * 2 - 0.2, 0.06, hd * 2 - 0.15, 0.02), '#8a6a4c', T(0, 0.22, 0));
  // vise, plane, mallet, saw, clamps, shavings
  B.add('solid', rbox(0.3, 0.2, 0.25, 0.04), P.iron, T(-hw + 0.3, 1.0, hd - 0.1));
  B.add('solid', cyl(0.02, 0.02, 0.4, 5), P.iron, T(-hw + 0.3, 0.98, hd + 0.1, 0, Math.PI / 2));
  B.add('solid', rbox(0.3, 0.08, 0.09, 0.02), '#8a5a3c', T(0.2, 0.96, 0.1, 0.3), { ao: false });
  B.add('solid', rbox(0.12, 0.05, 0.05, 0.01), P.iron, T(0.2, 1.01, 0.1, 0.3), { ao: false });
  B.add('solid', cyl(0.045, 0.045, 0.16, 8), '#a8705a', T(0.6, 0.96, -0.15, 0, 0, Math.PI / 2), { ao: false });
  B.add('solid', cyl(0.014, 0.014, 0.3, 5), P.woodLight, T(0.6, 0.96, 0.03, 0, Math.PI / 2), { ao: false });
  B.add('solid', rbox(0.5, 0.01, 0.12, 0.003), '#c9ccce', T(-0.3, 0.925, -0.2, 0.2), { ao: false });
  B.add('solid', rbox(0.13, 0.05, 0.26, 0.02), P.woodDark, T(-0.0, 0.94, -0.22, 0.2), { ao: false });
  for (let k = 0; k < 12; k++) B.add('solid', torus(0.04, 0.012, 3, 6), '#e2c99e', T(-hw + 0.5 + ((k * 0.37) % 1) * (hw * 2 - 0.8), 0.93, -hd + 0.15 + ((k * 0.61) % 1) * (hd * 2 - 0.3), k), { ao: false });
  for (let k = 0; k < 10; k++) B.add('solid', torus(0.05, 0.014, 3, 6), '#d9bf92', T(-hw + ((k * 0.43) % 1) * hw * 2, 0.012, -hd - 0.3 + ((k * 0.77) % 1) * (hd * 2 + 0.6), k * 1.3), { ao: false });
  if (f.variant === 0) {
    // the half-built birdhouse (inspect_workbench) + a jar of nails + lamp
    B.add('solid', rbox(0.3, 0.3, 0.3, 0.03), '#c49a6a', T(0.75, 1.07, 0.05));
    B.add('solid', cone(0.3, 0.2, 4), '#8a5a3c', T(0.75, 1.32, 0.05, Math.PI / 4));
    B.add('solid', cyl(0.05, 0.05, 0.02, 10), '#3a2c22', T(0.75, 1.09, 0.21, 0, Math.PI / 2), { ao: false });
    B.add('glazed', cyl(0.06, 0.06, 0.12, 10), '#cfe0dc', T(1.0, 0.98, -0.25), { ao: false });
    B.at(T(-0.9, 0.92, -0.3), () => {
      B.add('solid', cyl(0.08, 0.1, 0.03, 10), P.iron, T(0, 0.015, 0), { ao: false });
      B.add('solid', cyl(0.012, 0.012, 0.4, 5), P.iron, T(0, 0.2, 0, 0, 0.3), { ao: false });
      B.add('solid', cone(0.1, 0.12, 10), '#4f6f66', T(0, 0.42, 0.1, 0, 0.9), { ao: false });
      glow(B, it, 0, 0.36, 0.14, 0.05);
    });
  } else if (f.variant === 1) {
    // a chair being glued up in clamps
    B.at(T(-0.4, 0.92, 0.05, 0.4), () => {
      B.add('solid', rbox(0.4, 0.04, 0.4, 0.01), '#c49a6a', T(0, 0.3, 0), { ao: false });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', cyl(0.018, 0.02, 0.3, 6), '#b58f62', T(sx * 0.16, 0.15, sz * 0.16), { ao: false });
      B.add('solid', rbox(0.06, 0.18, 0.5, 0.01), P.iron, T(0.25, 0.3, 0), { ao: false });
    });
  } else {
    // boathouse bench: rope coil, lantern, tackle box
    B.add('solid', torus(0.14, 0.04, 6, 14), '#d2bf98', T(0.3, 0.95, 0.05, 0, Math.PI / 2), { ao: false });
    B.add('solid', rbox(0.34, 0.14, 0.2, 0.03), '#a44a3f', T(-0.25, 0.99, 0.05), { ao: false });
  }
}

function toolWall(B: GeoBuilder, b: Building): void {
  B.withCut(cutSlot(b.id, 'back'), () => {
    B.add('solid', rbox(2.6, 1.2, 0.04, 0.02), '#c9a87c', T(0, 1.8, 0.02), { ao: false });
    for (let r = 0; r < 5; r++) for (let c = 0; c < 12; c++) B.add('solid', box(0.02, 0.02, 0.01), '#8a6a4c', T(-1.2 + c * 0.22, 1.32 + r * 0.24, 0.045), { ao: false });
    // hammer, saw, wrench outlines + tools hanging
    B.add('solid', rbox(0.05, 0.4, 0.04, 0.01), P.woodDark, T(-1.0, 1.85, 0.06), { ao: false });
    B.add('solid', rbox(0.18, 0.07, 0.05, 0.01), P.iron, T(-1.0, 2.06, 0.06), { ao: false });
    B.add('solid', rbox(0.55, 0.16, 0.012, 0.004), '#c9ccce', T(-0.45, 1.9, 0.055, 0, 0, -0.1), { ao: false });
    B.add('solid', rbox(0.12, 0.16, 0.05, 0.02), P.woodDark, T(-0.15, 1.92, 0.06, 0, 0, -0.1), { ao: false });
    B.add('solid', rbox(0.04, 0.34, 0.03, 0.01), P.iron, T(0.25, 1.85, 0.06), { ao: false });
    B.add('solid', torus(0.05, 0.02, 4, 10, Math.PI * 1.5), P.iron, T(0.25, 2.04, 0.06), { ao: false });
    B.add('solid', torus(0.13, 0.03, 6, 12), '#b8453a', T(0.6, 1.8, 0.06), { ao: false });
    for (let k = 0; k < 4; k++) B.add('solid', rbox(0.03, 0.2 + k * 0.04, 0.03, 0.01), ['#a8705a', P.iron, '#4f6f66', P.woodLight][k]!, T(0.9 + k * 0.08, 1.62, 0.06), { ao: false });
    B.add('solid', rbox(2.7, 0.06, 0.24, 0.02), '#7a5c46', T(0, 1.2, 0.12), { ao: false });
    jarsRow(B, -1.2, 1.2, 1.23, 0.12, 4);
  });
}

function kiln(B: GeoBuilder, it: Interior, b: Building): void {
  const brick = '#a8705a';
  B.add('solid', cyl(0.92, 0.95, 0.2, 18), '#8e8574', T(0, 0.1, 0));
  B.add('solid', cyl(0.8, 0.85, 0.9, 18), brick, T(0, 0.65, 0), { grad: 0.2 });
  B.add('solid', sphere(0.82, 18, 10), brick, T(0, 1.1, 0, 0, 0, 0, 1, 0.65, 1), { grad: 0.1 });
  for (let k = 0; k < 4; k++) B.add('solid', torus(0.83 - k * 0.02, 0.025, 4, 22), shade(brick, 0.8), T(0, 0.35 + k * 0.22, 0, 0, Math.PI / 2), { ao: false });
  // arched glowing mouth facing the room (the kiln faces local +x towards the bench: fine either way, glow both)
  for (const a of [Math.PI * 1.2]) {
    B.at(T(Math.sin(a) * 0.78, 0, Math.cos(a) * 0.78, a), () => {
      B.add('solid', rbox(0.62, 0.62, 0.2, 0.06), shade(brick, 0.7), T(0, 0.62, 0));
      B.add('solid', rbox(0.42, 0.4, 0.05, 0.05), '#f0a050', T(0, 0.6, 0.08), { ao: false });
      B.add('solid', rbox(0.3, 0.12, 0.06, 0.03), '#ffd27a', T(0, 0.5, 0.1), { ao: false });
      glow(B, it, 0, 0.6, 0.18, 0.14, 0);
    });
  }
  B.add('solid', cyl(0.14, 0.16, 0.5, 10), shade(brick, 0.9), T(0, 1.75, 0));
  B.withCut(cutSlot(b.id, 'roof'), () => B.add('solid', cyl(0.12, 0.12, b.height - b.floorLift - 1.9, 10), P.iron, T(0, 2.0 + (b.height - b.floorLift - 1.9) / 2, 0)));
  // pots waiting by the kiln
  for (const [x, z, s] of [[-0.9, 0.55, 1], [-1.05, 0.2, 0.8], [-0.8, 0.85, 0.7]] as const) {
    B.add('solid', cyl(0.12 * s, 0.09 * s, 0.24 * s, 12), '#c98a6a', T(x, 0.12 * s, z));
    B.add('solid', torus(0.1 * s, 0.02, 4, 12), '#b5704f', T(x, 0.24 * s, z, 0, Math.PI / 2), { ao: false });
  }
}

function lumberRack(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.4;
  for (const sx of [-1, 0, 1]) B.add('solid', rbox(0.1, 1.9, 0.5, 0.02), '#5e4636', T(sx * (hw - 0.1), 0.95, 0));
  for (let r = 0; r < 4; r++) {
    const y = 0.25 + r * 0.45;
    B.add('solid', rbox(hw * 2, 0.05, 0.08, 0.01), '#5e4636', T(0, y, 0.22), { ao: false });
    for (let k = 0; k < 4 - (r % 2); k++) B.add('solid', box(hw * 2 - 0.1 - (k % 2) * 0.3, 0.06, 0.16), shade('#c49a6a', 0.9 + ((k + r) % 3) * 0.06), T(((k % 2) - 0.5) * 0.15, y + 0.06 + k * 0.065, 0.02), { ao: false, jitter: 0.05 });
  }
  // offcuts on the floor + a broom
  B.add('solid', box(0.6, 0.05, 0.12), '#c49a6a', T(0.3, 0.03, 0.45, 0.4), { ao: false });
  B.add('solid', cyl(0.018, 0.018, 1.3, 5), P.woodLight, T(-hw + 0.25, 0.68, 0.38, 0, 0.18), { ao: false });
  B.add('solid', cone(0.12, 0.25, 8), '#c9b285', T(-hw + 0.25, 0.1, 0.5), { ao: false });
}

function boatFrame(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 1.5;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 0.6;
  const along = hw > hd; // keel runs along the piece's local X when wider than deep
  B.at(T(0, 0, 0, along ? 0 : Math.PI / 2), () => {
    const L = Math.max(hw, hd) * 2;
    const Wd = Math.min(hw, hd) * 2;
    // trestles
    for (const sx of [-1, 1]) {
      B.add('solid', rbox(0.1, 0.06, Wd + 0.1, 0.02), '#7a5c46', T(sx * L * 0.3, 0.5, 0));
      for (const sz of [-1, 1]) B.add('solid', rbox(0.06, 0.55, 0.06, 0.02), '#7a5c46', T(sx * L * 0.3, 0.25, sz * Wd * 0.4, 0, sz * 0.15));
    }
    if (f.variant === 1) {
      // an upturned clinker rowboat being re-painted: hull, strakes, keel, gunwale
      const hull = '#a65e4b';
      B.add('solid', sphere(1, 20, 10, ), hull, T(0, 0.56, 0, 0, 0, 0, L * 0.5, 0.42, Wd * 0.5), { grad: 0.25 });
      for (let k = 1; k <= 3; k++) {
        const t = k / 4;
        B.add('solid', torus(1, 0.022, 4, 28, Math.PI), k === 2 ? '#efe3cf' : shade(hull, 0.85), T(0, 0.56 + 0.42 * Math.sin(t * Math.PI * 0.5) * 0.98, 0, 0, Math.PI / 2, 0, L * 0.5 * Math.cos(t * Math.PI * 0.5), Wd * 0.5 * Math.cos(t * Math.PI * 0.5), 1), { ao: false });
      }
      B.add('solid', rbox(L * 0.92, 0.07, 0.1, 0.03), '#6a4f3e', T(0, 0.99, 0), { ao: false });
      B.add('solid', torus(1, 0.04, 5, 30), '#6a4f3e', T(0, 0.56, 0, 0, Math.PI / 2, 0, L * 0.5, Wd * 0.5, 1), { ao: false });
      // paint pot + brush on the floor
      B.add('solid', cyl(0.09, 0.08, 0.14, 10), '#e8e4d8', T(L * 0.38, 0.07, Wd * 0.55 + 0.25), { ao: false });
      B.add('solid', cyl(0.08, 0.08, 0.01, 10), hull, T(L * 0.38, 0.145, Wd * 0.55 + 0.25), { ao: false });
      B.add('solid', cyl(0.012, 0.012, 0.3, 4), P.woodDark, T(L * 0.38, 0.2, Wd * 0.55 + 0.3, 0, 0.4), { ao: false });
      return;
    }
    // keel, stem, ribs: a boat skeleton
    B.add('solid', rbox(L * 0.95, 0.1, 0.1, 0.03), '#a98a62', T(0, 0.58, 0));
    B.add('solid', torus(0.5, 0.05, 6, 12, Math.PI / 2), '#a98a62', T(L * 0.42, 0.6, 0, 0, Math.PI / 2, 0), { ao: false });
    const ribs = 7;
    for (let k = 0; k < ribs; k++) {
      const t = (k + 0.5) / ribs - 0.5;
      const r = (Wd * 0.5 + 0.05) * (1 - Math.abs(t) * 1.2);
      B.add('solid', torus(r, 0.03, 5, 14, Math.PI), '#c49a6a', T(t * L * 0.9, 0.6 + r, 0, Math.PI / 2, 0, Math.PI), { ao: false });
    }
    for (const sz of [-1, 1]) B.add('solid', box(L * 0.7, 0.03, 0.04), '#b58f62', T(-0.05, 1.05, sz * Wd * 0.42), { ao: false });
  });
}

function sawhorses(B: GeoBuilder): void {
  for (const sx of [-1, 1]) {
    B.at(T(sx * 0.65, 0, 0), () => {
      B.add('solid', rbox(0.1, 0.08, 0.85, 0.02), '#a98a62', T(0, 0.62, 0));
      for (const sz of [-1, 1]) for (const lx of [-1, 1]) B.add('solid', rbox(0.06, 0.66, 0.06, 0.015), '#8a6a4c', T(lx * 0.12, 0.31, sz * 0.32, 0, 0, lx * 0.18));
    });
  }
  // a plank being sawn, the saw left in the cut, offcut on the floor
  B.add('solid', box(2.0, 0.05, 0.3), '#c49a6a', T(0, 0.685, 0.05), { jitter: 0.03 });
  B.add('solid', rbox(0.5, 0.14, 0.012, 0.004), '#c9ccce', T(0.25, 0.76, 0.05, 0.1, 0, -0.5), { ao: false });
  B.add('solid', rbox(0.12, 0.12, 0.05, 0.02), P.woodDark, T(0.47, 0.9, 0.05, 0.1, 0, -0.5), { ao: false });
  B.add('solid', box(0.45, 0.05, 0.3), '#c49a6a', T(1.25, 0.025, 0.35, 0.6), { ao: false });
  for (let k = 0; k < 14; k++) B.add('solid', torus(0.05, 0.014, 3, 6), '#e2c99e', T(-0.4 + ((k * 0.37) % 1) * 1.3, 0.012, -0.3 + ((k * 0.61) % 1) * 0.8, k), { ao: false });
}

function tackle(B: GeoBuilder, it: Interior): void {
  // rope coils, cork floats, a lobster pot, fishing rods leaning in the corner, a lantern
  B.add('solid', torus(0.26, 0.07, 6, 18), '#d2bf98', T(0.1, 0.07, 0.1, 0, Math.PI / 2), { ao: false });
  B.add('solid', torus(0.18, 0.06, 6, 16), '#c9b285', T(0.12, 0.18, 0.08, 0, Math.PI / 2), { ao: false });
  for (let k = 0; k < 5; k++) B.add('solid', sphere(0.09, 8, 6), k % 2 ? '#e98a6b' : '#f1d27a', T(-0.35 + (k % 3) * 0.12, 0.09, -0.25 + Math.floor(k / 3) * 0.14), { ao: false });
  B.at(T(0.35, 0, -0.3, 0.4), () => {
    B.add('solid', cyl(0.24, 0.26, 0.04, 12), '#8a6a4c', T(0, 0.02, 0));
    for (let k = 0; k < 5; k++) B.add('solid', torus(0.24, 0.012, 4, 14, Math.PI), '#8a6a4c', T(0, 0.02, 0, (k / 5) * Math.PI, Math.PI / 2), { ao: false });
  });
  for (let k = 0; k < 3; k++) B.add('solid', cyl(0.012, 0.008, 2.0, 4), P.woodDark, T(-0.3 + k * 0.08, 1.0, -0.42, 0, -0.18, 0.05 * k), { ao: false });
  B.at(T(-0.1, 0, 0.35), () => {
    B.add('solid', cyl(0.09, 0.1, 0.03, 10), P.iron, T(0, 0.015, 0), { ao: false });
    B.add('glazed', cyl(0.07, 0.07, 0.16, 10), '#f4e2b8', T(0, 0.11, 0), { ao: false });
    B.add('solid', cone(0.1, 0.08, 10), P.iron, T(0, 0.23, 0), { ao: false });
    glow(B, it, 0, 0.11, 0, 0.06, 0);
  });
}

function anvil(B: GeoBuilder): void {
  B.add('solid', cyl(0.3, 0.34, 0.5, 14), '#7a5c46', T(0, 0.25, 0));
  B.add('solid', cyl(0.28, 0.28, 0.02, 14), '#c7a77e', T(0, 0.505, 0), { ao: false });
  B.add('solid', rbox(0.24, 0.12, 0.18, 0.03), P.iron, T(0, 0.57, 0));
  B.add('solid', rbox(0.46, 0.12, 0.22, 0.04), P.iron, T(0.04, 0.7, 0));
  B.add('solid', cone(0.1, 0.25, 8), P.iron, T(0.37, 0.7, 0, 0, 0, -Math.PI / 2), { ao: false });
  B.add('solid', cyl(0.02, 0.02, 0.3, 5), P.woodDark, T(-0.1, 0.78, 0.16, 0.8, 0, Math.PI / 2), { ao: false });
  B.add('solid', rbox(0.1, 0.06, 0.06, 0.02), P.iron, T(-0.22, 0.78, 0.1), { ao: false });
}

function bed(B: GeoBuilder, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.8;
  const hd = f.shape?.type === 'box' ? f.shape.halfDepth : 1.0;
  const wood = '#7a5c46';
  const quilt = f.variant === 2 ? ['#5f7c74', '#e9dcc0', '#b0563d'] : ['#a65e4b', '#efe3c8', '#5f7c74'];
  // head at -z (against the back wall)
  B.add('solid', rbox(hw * 2, 0.3, hd * 2, 0.05), wood, T(0, 0.2, 0));
  B.add('solid', rbox(hw * 2 + 0.06, 0.95, 0.1, 0.04), wood, T(0, 0.48, -hd + 0.02));
  B.add('solid', rbox(hw * 2 + 0.06, 0.6, 0.1, 0.04), wood, T(0, 0.33, hd - 0.02));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', sphere(0.06, 8, 6), shade(wood, 1.15), T(sx * (hw + 0.02), sz < 0 ? 0.98 : 0.66, sz * (hd - 0.02)), { ao: false });
  B.add('solid', rbox(hw * 2 - 0.08, 0.16, hd * 2 - 0.2, 0.07), '#f4efe6', T(0, 0.42, 0.0));
  // patchwork quilt
  const n = 4;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < 4; j++) B.add('solid', rbox((hw * 2) / n - 0.01, 0.05, (hd * 1.3) / 4 - 0.01, 0.02), quilt[(i + j) % 3]!, T(-hw + (i + 0.5) * ((hw * 2) / n), 0.52, -hd * 0.25 + (j + 0.5) * ((hd * 1.3) / 4)), { ao: false, jitter: 0.05 });
  for (const sx of [-1, 1]) B.add('solid', rbox(hw * 0.8, 0.14, 0.34, 0.07), '#efe7d6', T(sx * hw * 0.45, 0.55, -hd + 0.32), { ao: false });
  // bedside lamp on a little stool
  B.at(T(hw + 0.3, 0, -hd + 0.3), () => {
    B.add('solid', cyl(0.16, 0.16, 0.5, 10), shade(wood, 1.1), T(0, 0.25, 0));
    B.add('solid', cyl(0.05, 0.07, 0.2, 8), '#efe7d6', T(0, 0.6, 0), { ao: false });
    B.add('solid', cone(0.13, 0.16, 12), '#e9c5a8', T(0, 0.75, 0), { ao: false });
  });
}

function hearth(B: GeoBuilder, it: Interior, f: FurniturePiece, b: Building): void {
  const stone = f.variant === 2 ? '#9a8f84' : '#a8705a';
  B.add('solid', rbox(1.7, 1.35, 0.62, 0.08), stone, T(0, 0.67, -0.05), { grad: 0.2 });
  B.add('solid', rbox(1.0, 0.75, 0.3, 0.1), '#2e2620', T(0, 0.45, 0.14), { ao: false });
  B.add('solid', rbox(1.9, 0.1, 0.72, 0.03), '#6a4f3e', T(0, 1.38, 0.02));
  B.add('solid', rbox(1.5, 0.1, 0.5, 0.03), shade(stone, 0.85), T(0, 0.05, 0.4), { ao: false });
  // logs + flames
  for (const s of [-1, 1]) B.add('solid', cyl(0.06, 0.07, 0.6, 8), '#6a4f3e', T(s * 0.08, 0.16, 0.18, 0.4 * s, 0, Math.PI / 2), { ao: false });
  B.add('solid', cone(0.16, 0.34, 8), '#f0a050', T(0, 0.34, 0.2), { ao: false });
  B.add('solid', cone(0.09, 0.22, 8), '#ffd27a', T(0.03, 0.32, 0.25), { ao: false });
  glow(B, it, 0, 0.35, 0.3, 0.16, 0);
  // mantel things: clock, candles, a jar of dried flowers
  B.add('solid', rbox(0.24, 0.26, 0.12, 0.04), '#5a4c5c', T(0, 1.56, 0.04), { ao: false });
  B.add('solid', cyl(0.07, 0.07, 0.02, 12), '#f4efe6', T(0, 1.58, 0.105, 0, Math.PI / 2), { ao: false });
  candle(B, it, -0.6, 1.43, 0.05);
  candle(B, it, 0.6, 1.43, 0.05);
  B.add('glazed', cyl(0.05, 0.06, 0.16, 10), '#8fb0b4', T(0.35, 1.51, 0.05), { ao: false });
  for (let k = 0; k < 5; k++) B.add('solid', sphere(0.03, 6, 5), P.petals[k % P.petals.length]!, T(0.35 + Math.cos(k) * 0.05, 1.66, 0.05 + Math.sin(k) * 0.05), { ao: false });
  B.add('solid', rbox(0.9, 0.7, 0.04, 0.02), '#6a4f3e', T(0, 2.2, -0.3), { ao: false });
  B.withCut(cutSlot(b.id, 'back'), () => B.at(T(0, 2.2, -0.27), () => picture(B, 0.76, 0.56, '#6a4f3e', '#cfe0e8', '#7f9a5c', '#6f8f52')));
  B.add('solid', torus(0.25, 0.02, 4, 12), P.iron, T(-0.95, 0.5, 0.15, 0, 0, Math.PI / 2), { ao: false });
}

function diningTable(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const cloth = f.variant === 2 ? '#e9eee2' : '#efe3c8';
  B.add('solid', cyl(0.5, 0.5, 0.06, 22), '#8a6a4c', T(0, 0.73, 0));
  B.add('solid', cyl(0.53, 0.56, 0.12, 22, true), cloth, T(0, 0.7, 0), { ao: false });
  B.add('solid', cyl(0.52, 0.52, 0.01, 22), cloth, T(0, 0.765, 0), { ao: false });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    B.add('solid', cyl(0.035, 0.03, 0.72, 6), '#7a5c46', T(Math.cos(a) * 0.36, 0.36, Math.sin(a) * 0.36));
  }
  // teapot, cups, bread
  B.add('glazed', sphere(0.1, 12, 9), f.variant === 2 ? '#5f7c74' : '#a65e4b', T(0.1, 0.85, -0.08, 0, 0, 0, 1, 0.85, 1), { ao: false });
  B.add('glazed', cyl(0.02, 0.03, 0.1, 6), f.variant === 2 ? '#5f7c74' : '#a65e4b', T(0.21, 0.86, -0.08, 0, 0, -0.8), { ao: false });
  for (const [x, z] of [[-0.25, 0.1], [0.28, 0.22]] as const) B.add('glazed', cyl(0.045, 0.04, 0.07, 10), '#f4efe6', T(x, 0.81, z), { ao: false });
  B.add('solid', sphere(0.1, 10, 7), '#c98a4b', T(-0.15, 0.8, -0.2, 0.5, 0, 0, 1.5, 0.6, 1), { ao: false });
  candle(B, it, 0.0, 0.77, 0.2);
}

function kitchen(B: GeoBuilder, it: Interior, f: FurniturePiece, b: Building): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.95;
  const cab = f.variant === 2 ? '#7b8e8a' : '#c9b48e';
  B.add('solid', rbox(hw * 2, 0.86, 0.58, 0.04), cab, T(0, 0.43, -0.02), { grad: 0.15 });
  for (let k = 0; k < 3; k++) B.add('solid', rbox((hw * 2) / 3 - 0.08, 0.6, 0.03, 0.02), shade(cab, 0.9), T(-hw + (k + 0.5) * ((hw * 2) / 3), 0.42, 0.28), { ao: false });
  for (let k = 0; k < 3; k++) B.add('solid', sphere(0.025, 6, 5), P.brass, T(-hw + (k + 0.5) * ((hw * 2) / 3) + 0.15, 0.55, 0.31), { ao: false });
  B.add('solid', rbox(hw * 2 + 0.06, 0.06, 0.64, 0.02), '#e9e2d4', T(0, 0.89, 0));
  // sink basin + pump tap
  B.add('glazed', rbox(0.5, 0.06, 0.36, 0.05), '#dfe5e2', T(0.35, 0.93, 0), { ao: false });
  B.add('solid', cyl(0.02, 0.02, 0.3, 6), P.brass, T(0.35, 1.05, -0.18), { ao: false });
  B.add('solid', cyl(0.015, 0.015, 0.16, 6), P.brass, T(0.35, 1.2, -0.1, 0, Math.PI / 2), { ao: false });
  // pots + chopping board + loaf
  B.add('solid', cyl(0.13, 0.12, 0.16, 12), P.iron, T(-0.5, 1.0, 0.0), { ao: false });
  B.add('solid', cyl(0.13, 0.13, 0.02, 12), shade(P.iron, 1.2), T(-0.5, 1.09, 0.0), { ao: false });
  B.add('solid', rbox(0.3, 0.03, 0.22, 0.01), '#c49a6a', T(-0.05, 0.935, 0.08, 0.2), { ao: false });
  B.add('solid', sphere(0.08, 10, 7), '#c98a4b', T(-0.05, 0.98, 0.08, 0, 0, 0, 1.6, 0.7, 1), { ao: false });
  // open shelf above (wall-mounted, fades with its wall)
  const face = f.localYaw > 0 ? 'left' : 'right';
  B.withCut(cutSlot(b.id, face), () => {
    shelfBoard(B, hw * 2, 1.55, 0.24, '#8a6a4c');
    jarsRow(B, -hw + 0.12, hw - 0.12, 1.575, 0.13, f.variant);
    shelfBoard(B, hw * 2, 1.95, 0.24, '#8a6a4c');
    for (let k = 0; k < 5; k++) B.add('glazed', cyl(0.11, 0.11, 0.02, 14), k % 2 ? '#e9e2d4' : '#b8d0cc', T(-hw + 0.25 + k * 0.32, 2.03, 0.12, 0, 1.3), { ao: false });
  });
  void it;
}

function dresser(B: GeoBuilder, it: Interior, f: FurniturePiece): void {
  const hw = f.shape?.type === 'box' ? f.shape.halfWidth : 0.55;
  const wood = f.variant === 2 ? '#7d6a4a' : '#8a5a48';
  B.add('solid', rbox(hw * 2, 0.95, 0.5, 0.04), wood, T(0, 0.5, -0.02), { grad: 0.15 });
  for (let r = 0; r < 3; r++) {
    B.add('solid', rbox(hw * 2 - 0.1, 0.25, 0.03, 0.02), shade(wood, 1.1), T(0, 0.2 + r * 0.29, 0.24), { ao: false });
    for (const sx of [-1, 1]) B.add('solid', sphere(0.025, 6, 5), P.brass, T(sx * hw * 0.5, 0.2 + r * 0.29, 0.27), { ao: false });
  }
  B.add('solid', rbox(hw * 2 + 0.06, 0.05, 0.56, 0.02), shade(wood, 1.15), T(0, 0.99, 0));
  B.add('solid', cyl(0.08, 0.07, 0.16, 10), '#b5704f', T(-hw * 0.5, 1.09, 0), { ao: false });
  B.add('plant', sphere(0.12, 8, 6), P.leaf, T(-hw * 0.5, 1.24, 0), { ao: false });
  books(B, hw * 0.05, hw * 0.85, 1.015, 0.0, 0.18, 7);
  candle(B, it, hw * 0.5, 1.015, 0.15);
}

function oarRack(B: GeoBuilder, b: Building): void {
  B.withCut(cutSlot(b.id, 'left'), () => {
    for (let k = 0; k < 3; k++) {
      B.add('solid', rbox(0.06, 2.1, 0.04, 0.02), P.woodLight, T(-0.4 + k * 0.4, 1.1, 0.12, 0, 0.08, (k - 1) * 0.06));
      B.add('solid', rbox(0.18, 0.5, 0.04, 0.03), shade(P.woodLight, 0.9), T(-0.4 + k * 0.4, 0.3, 0.17, 0, 0.08, (k - 1) * 0.06));
    }
    B.add('solid', torus(0.3, 0.08, 10, 18), '#e98a6b', T(0.1, 1.7, 0.1));
  });
}

function netWall(B: GeoBuilder, b: Building): void {
  B.withCut(cutSlot(b.id, 'back'), () => {
    B.add('solid', cyl(0.025, 0.025, 2.2, 6), P.woodDark, T(0, 2.1, 0.08, 0, 0, Math.PI / 2), { ao: false });
    for (let k = 0; k < 9; k++) {
      const x = -1.0 + k * 0.25;
      const sag = 0.35 * Math.sin((k / 8) * Math.PI);
      B.add('solid', box(0.012, 1.1 + sag, 0.01), '#d2bf98', T(x, 1.55 - sag / 2, 0.06), { ao: false });
    }
    for (let r = 0; r < 4; r++) B.add('solid', box(2.0, 0.012, 0.01), '#d2bf98', T(0, 1.2 + r * 0.25, 0.065), { ao: false });
    for (let k = 0; k < 5; k++) B.add('solid', sphere(0.06, 8, 6), k % 2 ? '#e98a6b' : '#f1d27a', T(-0.9 + k * 0.45, 1.05, 0.08), { ao: false });
  });
}

/** Pendant lamp hanging from the (cut-away) ceiling; the glow stays when the roof fades. */
function pendant(B: GeoBuilder, it: Interior, b: Building, x: number, y: number, z: number, top: number, style: number): void {
  B.withCut(cutSlot(b.id, 'roof'), () => {
    B.at(T(x, 0, z), () => {
      B.add('solid', cyl(0.008, 0.008, top - y - 0.2, 4), '#3a3a3a', T(0, y + 0.2 + (top - y - 0.2) / 2, 0), { ao: false });
      if (style === 0) {
        B.add('solid', cone(0.26, 0.2, 14), '#4f6f66', T(0, y + 0.12, 0), { ao: false });
      } else if (style === 1) {
        // iron ring chandelier with candles
        B.add('solid', torus(0.45, 0.025, 5, 20), P.iron, T(0, y, 0, 0, Math.PI / 2), { ao: false });
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          B.add('solid', cyl(0.02, 0.02, 0.1, 6), '#f4efe6', T(Math.cos(a) * 0.45, y + 0.06, Math.sin(a) * 0.45), { ao: false });
        }
        for (let k = 0; k < 3; k++) B.add('solid', cyl(0.006, 0.006, 0.6, 3), P.iron, T(Math.cos(k * 2.1) * 0.22, y + 0.28, Math.sin(k * 2.1) * 0.22, 0, Math.sin(k * 2.1) * 0.6, -Math.cos(k * 2.1) * 0.6), { ao: false });
      } else {
        B.add('solid', cone(0.2, 0.26, 10), '#c89b52', T(0, y + 0.15, 0), { ao: false });
        B.add('solid', cyl(0.06, 0.06, 0.06, 8), '#45474b', T(0, y + 0.29, 0), { ao: false });
      }
    });
  });
  // (no bulb glow: the fixture fades with the roof; the light, its floor pool and the candles remain)
  anchors.lamps.push({ lightId: lightId(it), position: worldPoint(B, x, y - 0.1, z), color: '#ffc98a', range: 6.5, intensity: 1.1, interiorId: it.id });
}

/** Walls dressing without collision: pictures, a clock, shelves. */
function wallDressing(B: GeoBuilder, it: Interior, b: Building): void {
  const at = (face: 'back' | 'left' | 'right' | 'front', u: number, y: number, fn: () => void) => B.withCut(cutSlot(b.id, face), () => B.at(innerFace(b, face, u, y), fn));
  const y0 = b.floorLift;
  switch (it.purpose) {
    case 'cafe':
      at('left', -0.3, y0 + 2.4, () => picture(B, 0.9, 0.6, '#6f5440', '#f2d6bc', '#b0563d', '#8a6a4a'));
      at('right', 1.0, y0 + 2.3, () => picture(B, 0.7, 0.9, '#4f6f66', '#d9e8f2', '#6f8f52', '#5f7c74'));
      at('front', -4.4, y0 + 2.4, () => {
        B.add('solid', cyl(0.24, 0.24, 0.05, 20), '#efe7d6', T(0, 0, 0.03, 0, Math.PI / 2), { ao: false });
        B.add('solid', torus(0.24, 0.03, 6, 20), P.brass, T(0, 0, 0.05), { ao: false });
        B.add('solid', box(0.02, 0.16, 0.01), '#3a3236', T(0, 0.06, 0.06), { ao: false });
        B.add('solid', box(0.12, 0.02, 0.01), '#3a3236', T(0.05, 0, 0.06), { ao: false });
      });
      break;
    case 'store':
      at('right', -0.4, y0 + 1.6, () => {
        shelfBoard(B, 1.6, 0, 0.26, '#7d6a50');
        jarsRow(B, -0.7, 0.7, 0.025, 0.14, 1);
      });
      at('front', -3.2, y0 + 2.6, () => picture(B, 0.8, 0.5, '#5f6f5a', '#e9dcc0', '#9c4a3c', '#c9a23f'));
      // hanging baskets / dried herbs along the back wall over the counter
      at('back', -2.4, y0 + 2.9, () => {
        B.add('solid', cyl(0.02, 0.02, 2.0, 5), P.woodDark, T(0, 0, 0.3, 0, 0, Math.PI / 2), { ao: false });
        for (let k = 0; k < 6; k++) B.add('plant', cone(0.06, 0.3, 6), k % 2 ? '#8f9a5c' : '#b9a26a', T(-0.85 + k * 0.34, -0.18, 0.3, 0, 0, Math.PI), { ao: false });
      });
      break;
    case 'hall':
      at('left', 4.0, y0 + 2.6, () => picture(B, 1.0, 1.3, '#c8bca6', '#d9cfbd', '#6a5a6e', '#5f7c74'));
      at('right', 1.8, y0 + 2.6, () => picture(B, 1.2, 0.8, '#c8bca6', '#e8d8bd', '#5f7c64', '#6f8f52'));
      at('back', 0, y0 + 3.6, () => {
        B.add('solid', cyl(0.5, 0.5, 0.08, 24), '#efe7d6', T(0, 0, 0.04, 0, Math.PI / 2), { ao: false });
        B.add('solid', torus(0.5, 0.06, 6, 24), P.brass, T(0, 0, 0.08), { ao: false });
        B.add('solid', torus(0.25, 0.04, 5, 6), '#6a5a6e', T(0, 0, 0.1), { ao: false });
      });
      break;
    case 'workshop':
      at('left', -2.6, y0 + 2.3, () => {
        for (let k = 0; k < 3; k++) B.add('solid', torus(0.18 + k * 0.05, 0.03, 5, 16), P.iron, T(-0.4 + k * 0.4, 0, 0.06), { ao: false });
      });
      at('right', -1.2, y0 + 2.2, () => {
        B.add('solid', rbox(1.0, 0.7, 0.03, 0.01), '#e9e2d4', T(0, 0, 0.03), { ao: false });
        for (let k = 0; k < 5; k++) B.add('solid', box(0.7 - (k % 2) * 0.2, 0.02, 0.005), '#5a6f86', T(-0.05, 0.22 - k * 0.11, 0.05), { ao: false });
        B.add('solid', torus(0.12, 0.01, 4, 14), '#5a6f86', T(0.3, -0.15, 0.05), { ao: false });
      });
      break;
    case 'home':
      at('right', -1.6, y0 + 2.2, () => picture(B, 0.6, 0.45, '#6a4f3e', '#f2d6bc', '#7f9a5c', '#a65e4b'));
      at('left', 1.9, y0 + 2.1, () => picture(B, 0.45, 0.6, '#6a4f3e', '#d9e8f2', '#5f7c74', '#efe3c8'));
      at('front', 2.35, y0 + 2.35, () => {
        B.add('solid', cyl(0.18, 0.18, 0.04, 16), '#efe7d6', T(0, 0, 0.03, 0, Math.PI / 2), { ao: false });
        B.add('solid', torus(0.18, 0.025, 5, 16), '#6a4f3e', T(0, 0, 0.05), { ao: false });
      });
      break;
    case 'boathouse':
      at('right', 0.9, y0 + 2.0, () => picture(B, 0.8, 0.55, '#3f4e57', '#cfe0e8', '#5f8f99', '#e8e4d8'));
      break;
  }
}

function piece(B: GeoBuilder, it: Interior, b: Building, f: FurniturePiece): void {
  const y = groundHeight(f.position.x, f.position.z);
  B.at(T(f.position.x, y, f.position.z, f.yaw), () => {
    switch (f.kind) {
      case 'counter':
        return counterCafe(B, it, f);
      case 'pastry_case':
        return;
      case 'back_shelf':
        return backShelf(B, it, f, b);
      case 'chalkboard':
        return chalkboard(B, b);
      case 'cafe_table':
        return cafeTable(B, it, f);
      case 'piano':
        return piano(B, it);
      case 'mic_stand':
        return micStand(B);
      case 'bookshelf':
        return bookshelf(B, f);
      case 'plant':
        return plant(B, f);
      case 'rug':
        return rug(B, f);
      case 'store_counter':
        return storeCounter(B, it, f);
      case 'shelf':
        return shelfUnit(B, f);
      case 'display_table':
        return displayTable(B, f);
      case 'crate_stack':
        return crateStack(B, f);
      case 'barrel':
        barrel(B, f.shape?.type === 'circle' ? f.shape.radius : 0.4, f.height, '#8b6a4c');
        B.add('solid', cyl(0.34, 0.34, 0.04, 16), '#a7856a', T(0, f.height, 0));
        if (f.interiorId === 'general_store') for (let k = 0; k < 6; k++) B.add('solid', sphere(0.05, 6, 5), '#c9b285', T(Math.cos(k) * 0.15, f.height + 0.05, Math.sin(k) * 0.15), { ao: false });
        return;
      case 'sacks':
        return sacks(B);
      case 'stove':
        return stove(B, it, b);
      case 'lectern':
        return lectern(B, it);
      case 'archive_shelf':
        return archiveShelf(B, f);
      case 'notice_board':
        return noticeBoard(B, b);
      case 'meeting_table':
        return meetingTable(B, it, f);
      case 'tower_base':
        return;
      case 'banner':
        return banner(B, b, f);
      case 'workbench':
        return workbench(B, it, f);
      case 'tool_wall':
        return toolWall(B, b);
      case 'kiln':
        return kiln(B, it, b);
      case 'lumber_rack':
        return lumberRack(B, f);
      case 'boat_frame':
        return boatFrame(B, f);
      case 'anvil':
        return anvil(B);
      case 'sawhorses':
        return sawhorses(B);
      case 'tackle':
        return tackle(B, it);
      case 'bed':
        return bed(B, f);
      case 'hearth':
        return hearth(B, it, f, b);
      case 'dining_table':
        return diningTable(B, it, f);
      case 'kitchen':
        return kitchen(B, it, f, b);
      case 'dresser':
        return dresser(B, it, f);
      case 'oar_rack':
        return oarRack(B, b);
      case 'net_wall':
        return netWall(B, b);
    }
  });
}

/** Furniture, wall dressing, platforms and lamps of a walk-in building. */
export function buildInteriorFurnishings(B: GeoBuilder, b: Building): void {
  const it = getInterior(b.id);
  if (!it) return;
  for (const f of it.furniture) piece(B, it, b, f);
  // low platforms (café stage, hall dais): planked/stone with a lip
  for (const p of it.platforms) {
    const { center, halfWidth: hw, halfDepth: hd, yaw } = p.zone;
    B.at(T(center.x, it.floorY, center.z, yaw), () => {
      const stone = it.floor === 'stone';
      B.add('solid', rbox(hw * 2, p.height, hd * 2, Math.min(0.05, p.height / 2 - 0.005)), stone ? '#b9ad98' : '#7a5c46', T(0, p.height / 2, 0), { ao: false });
      if (!stone) for (let k = 0; k < Math.round((hd * 2) / 0.24); k++) B.add('solid', box(hw * 2 - 0.04, 0.012, 0.012), '#5e4636', T(0, p.height + 0.002, -hd + 0.12 + k * 0.24), { ao: false });
      else B.add('solid', rbox(hw * 2 - 0.3, 0.012, hd * 2 - 0.3, 0.005), '#6a5a6e', T(0, p.height + 0.004, 0), { ao: false });
    });
  }
  wallDressing(B, it, b);
  const top = b.height;
  const style = it.purpose === 'hall' ? 1 : it.purpose === 'workshop' || it.purpose === 'boathouse' ? 2 : 0;
  for (const l of it.lights) {
    const base = terrainBase(b);
    B.at(T(0, 0, 0), () => pendant(B, it, b, l.position.x, it.floorY + l.y, l.position.z, base + top, style));
  }
}

function terrainBase(b: Building): number {
  const it = getInterior(b.id)!;
  return it.baseY;
}
