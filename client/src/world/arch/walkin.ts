/**
 * Walk-in buildings: the same façades as before, built as real shells.
 *
 *  - Hollow walls (WALL_THICKNESS, from shared interiors.ts) in two skins:
 *    façade colour outside, plaster + wood wainscot inside, with a real door
 *    gap and a lintel; windows on both faces (the inner glass shows the sky).
 *  - Every wall face is split at STUB height: the stub never fades, the upper
 *    wall, its windows, trims and façade dressing carry that face's cutaway
 *    slot; roofs, gables, chimneys and towers carry the roof slot; corner posts
 *    their corner slot (see ../cutaway.ts).
 *  - Floors (planks / flagstones) sit flush with `floorY`; a stone doorstep
 *    ramp matches the shared ramp in groundHeight.
 * Footprints and openings come from the shared data, so what you see is what
 * client prediction and the server collide with.
 */
import { Matrix4 } from 'three';
import { HALL_TOWER_X, WALL_THICKNESS, rampHalfWidth, rampLength, terrainHeight, type Building } from '@elsewhere/shared';
import { archFrame, archPanel, box, cone, cyl, gableWall, quad, rbox, sphere, T, torus, type ColorLike, type GeoBuilder } from '../geom.js';
import { signUV } from '../signs.js';
import { cutSlot, type CutPart } from '../cutaway.js';
import {
  anchors,
  awning,
  barrel,
  chimney,
  crate,
  doorway,
  flowerPatch,
  gableEnds,
  mix,
  onFace,
  P,
  pavilionRoof,
  roof,
  shade,
  shrub,
  signBoard,
  stovepipe,
  windowUnit,
  worldPoint,
  type Face,
  type WindowOpts,
} from './kit.js';
import { buildInteriorFurnishings } from './furniture.js';

const TW = WALL_THICKNESS;
/** Height of the wall stub that stays when a face is cut away (above the floor). */
export const STUB = 0.95;

export interface ShellStyle {
  /** Floor height above the base terrain (= building.floorLift). */
  y0: number;
  /** Outer wall colour (upper) and of the outer stub. */
  outer: ColorLike;
  outerStub?: ColorLike;
  /** Interior plaster and wainscot. */
  inner: ColorLike;
  wainscot: ColorLike;
  /** Rail on top of the stub, inside. */
  rail?: ColorLike;
  floor: 'planks' | 'flags';
  floorColor: ColorLike;
  /** Door opening height. */
  doorH: number;
  /** Round the wall boxes a little (stone vs timber). */
  round?: number;
}

const FACES: Face[] = ['front', 'back', 'left', 'right'];

function S(b: Building, part: CutPart): number {
  return cutSlot(b.id, part);
}

/** Transform onto the INNER surface of a wall face, +Z pointing into the room. */
export function innerFace(b: Building, face: Face, u: number, y: number, inset = 0): Matrix4 {
  return onFace(face, b.width, b.depth, u, y, -TW - inset).multiply(T(0, 0, 0, Math.PI));
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function plinthWalkIn(B: GeoBuilder, b: Building, color: ColorLike): void {
  const { width: w, depth: d, floorLift: y0 } = b;
  const top = y0 - 0.04;
  B.add('solid', rbox(w + 0.36, top + 0.5, d + 0.36, 0.12), color, T(0, top / 2 - 0.25, 0), { grad: 0.25 });
  // stone course ring just outside the walls (not across the floor)
  const c = shade(color, 1.08);
  B.add('solid', rbox(w + 0.44, 0.1, 0.24, 0.04), c, T(0, top, -(d / 2 + 0.1)));
  const gap = rampHalfWidth(b) + 0.25;
  const seg = (w + 0.44) / 2 - gap;
  for (const s of [-1, 1]) {
    B.add('solid', rbox(seg, 0.1, 0.24, 0.04), c, T(s * (gap + seg / 2), top, d / 2 + 0.1));
    B.add('solid', rbox(0.24, 0.1, d - 0.04, 0.04), c, T(s * (w / 2 + 0.1), top, 0));
  }
}

function floorPlanks(B: GeoBuilder, b: Building, color: ColorLike): void {
  const iw = b.width - 2 * TW + 0.04;
  const id = b.depth - 2 * TW + 0.04;
  const y0 = b.floorLift;
  const bw = 0.26;
  const rows = Math.ceil(id / bw);
  for (let r = 0; r < rows; r++) {
    const z = -id / 2 + (r + 0.5) * (id / rows);
    // staggered joints: two or three boards per row
    const split = 0.25 + ((r * 0.37) % 0.5);
    const parts = r % 3 === 0 ? [split, 1] : [split * 0.6, split + 0.25, 1];
    let a = 0;
    for (const p of parts) {
      const len = (p - a) * iw;
      if (len > 0.05) {
        const k = 0.88 + (((r * 7 + Math.round(p * 13)) % 9) / 9) * 0.2;
        B.add('solid', box(len - 0.012, 0.05, id / rows - 0.012), shade(color, k), T(-iw / 2 + (a * iw + len / 2), y0 - 0.025, z), { ao: false, jitter: 0.03 });
      }
      a = p;
    }
  }
  // door threshold
  B.add('solid', rbox(b.doorWidth + 0.1, 0.05, TW + 0.06, 0.02), P.woodDark, T(0, y0 - 0.02, b.depth / 2 - TW / 2), { ao: false });
}

function floorFlags(B: GeoBuilder, b: Building, color: ColorLike): void {
  const iw = b.width - 2 * TW + 0.04;
  const id = b.depth - 2 * TW + 0.04;
  const y0 = b.floorLift;
  // grout bed
  B.add('solid', box(iw, 0.04, id), shade(color, 0.62), T(0, y0 - 0.05, 0), { ao: false });
  const cols = Math.round(iw / 0.95);
  const rows = Math.round(id / 0.95);
  const cw = iw / cols;
  const rw = id / rows;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = 0.9 + (((r * 5 + c * 3) % 7) / 7) * 0.16;
      const tint = (r + c) % 5 === 0 ? mix(color, '#b9a98e', 0.35) : color;
      B.add('solid', box(cw - 0.05, 0.04, rw - 0.05), shade(tint, k), T(-iw / 2 + (c + 0.5) * cw, y0 - 0.02, -id / 2 + (r + 0.5) * rw), { ao: false, jitter: 0.03 });
    }
  B.add('solid', rbox(b.doorWidth + 0.1, 0.05, TW + 0.06, 0.02), shade(color, 0.85), T(0, y0 - 0.02, b.depth / 2 - TW / 2), { ao: false });
}

/** One wall run along a face: [u0, u1] along the face, from y0 to y1, both skins. */
function wallRun(B: GeoBuilder, b: Building, face: Face, u0: number, u1: number, ya: number, yb: number, outer: ColorLike, inner: ColorLike, r: number): void {
  const len = u1 - u0;
  if (len <= 0.01 || yb - ya <= 0.01) return;
  const um = (u0 + u1) / 2;
  const h = yb - ya;
  const half = TW / 2;
  B.at(onFace(face, b.width, b.depth, um, ya + h / 2, -half / 2), () => B.add('solid', rbox(len, h, half, Math.min(r, half / 2 - 0.005), 1), outer, undefined, { grad: 0.06 }));
  B.at(onFace(face, b.width, b.depth, um, ya + h / 2, -half - half / 2), () => B.add('solid', rbox(len, h, half + 0.002, Math.min(r, half / 2 - 0.005), 1), inner, undefined, { ao: false, jitter: 0.02 }));
}

/**
 * Hollow walls with a door gap in the front face. Side walls run the full depth;
 * front/back walls sit between them (no coplanar overlaps).
 */
export function shellWalls(B: GeoBuilder, b: Building, s: ShellStyle): void {
  const { width: w, depth: d, height: h } = b;
  const y0 = s.y0;
  const ys = y0 + STUB;
  const r = s.round ?? 0.03;
  const gap = b.doorWidth / 2;
  const sideHalf = d / 2;
  const fbHalf = w / 2 - TW;
  const outerStub = s.outerStub ?? s.outer;
  for (const face of FACES) {
    const runs: [number, number][] = face === 'front' ? [[-fbHalf, -gap], [gap, fbHalf]] : face === 'back' ? [[-fbHalf, fbHalf]] : [[-sideHalf, sideHalf]];
    for (const [u0, u1] of runs) {
      wallRun(B, b, face, u0, u1, y0 - 0.04, ys, outerStub, s.wainscot, r);
      B.withCut(S(b, face), () => wallRun(B, b, face, u0, u1, ys, h, s.outer, s.inner, r));
      // wainscot rail on the stub, inside
      const len = u1 - u0;
      B.at(innerFace(b, face, (u0 + u1) / 2, ys), () => {
        B.add('solid', rbox(len, 0.07, 0.07, 0.02), s.rail ?? shade(s.wainscot, 0.8), T(0, -0.02, 0.02), { ao: false });
        B.add('solid', box(len, 0.1, 0.02), shade(s.wainscot, 0.88), T(0, -STUB + 0.06, 0.012), { ao: false });
      });
    }
  }
  // lintel over the door (front slot)
  B.withCut(S(b, 'front'), () => wallRun(B, b, 'front', -gap, gap, y0 + s.doorH, h, s.outer, s.inner, r));
  // inner door jambs (the wall ends) get a plain wooden lining
  for (const sx of [-1, 1]) B.add('solid', box(0.04, Math.min(STUB, s.doorH), TW), P.woodDark, T(sx * (gap + 0.02), y0 + Math.min(STUB, s.doorH) / 2, d / 2 - TW / 2), { ao: false });
  B.withCut(S(b, 'front'), () => {
    for (const sx of [-1, 1]) B.add('solid', box(0.04, s.doorH - STUB, TW), P.woodDark, T(sx * (gap + 0.02), y0 + STUB + (s.doorH - STUB) / 2, d / 2 - TW / 2), { ao: false });
    B.add('solid', box(gap * 2 + 0.08, 0.05, TW), P.woodDark, T(0, y0 + s.doorH, d / 2 - TW / 2), { ao: false });
  });
  // the floor is part of the interior chunk (drawn with the furnishings, see buildWalkIn)
  floorStyles.set(b.id, { kind: s.floor, color: s.floorColor });
}

const floorStyles = new Map<string, { kind: 'planks' | 'flags'; color: ColorLike }>();

/** Interior floor (planks / flagstones), in the building frame. */
export function buildFloor(B: GeoBuilder, b: Building): void {
  const f = floorStyles.get(b.id);
  if (!f) return;
  placeAt(B, b, () => (f.kind === 'planks' ? floorPlanks(B, b, f.color) : floorFlags(B, b, f.color)));
}

/** Corner posts: lower part always, upper part fades with its corner. */
export function corners(B: GeoBuilder, b: Building, size: number, color: ColorLike, y0: number, top: number): void {
  const { width: w, depth: d } = b;
  const ys = y0 + STUB;
  const parts: [number, number, CutPart][] = [[-1, 1, 'cornerFL'], [1, 1, 'cornerFR'], [-1, -1, 'cornerBL'], [1, -1, 'cornerBR']];
  for (const [sx, sz, part] of parts) {
    B.add('solid', rbox(size, ys - y0, size, 0.05), color, T((sx * w) / 2, y0 + (ys - y0) / 2, (sz * d) / 2));
    B.withCut(S(b, part), () => B.add('solid', rbox(size, top - ys, size, 0.05), color, T((sx * w) / 2, ys + (top - ys) / 2, (sz * d) / 2)));
  }
}

/** A horizontal trim band around the outside at height y (per face, so each fades with its wall). */
export function band(B: GeoBuilder, b: Building, y: number, t: number, color: ColorLike, out = 0.06): void {
  const { width: w, depth: d } = b;
  const cutFor = (face: Face) => (y > b.floorLift + STUB - 0.02 ? S(b, face) : 0);
  B.withCut(cutFor('front'), () => B.add('solid', rbox(w + out * 2, t, out * 2, Math.min(0.04, t / 2 - 0.005)), color, T(0, y, d / 2)));
  B.withCut(cutFor('back'), () => B.add('solid', rbox(w + out * 2, t, out * 2, Math.min(0.04, t / 2 - 0.005)), color, T(0, y, -d / 2)));
  B.withCut(cutFor('left'), () => B.add('solid', rbox(out * 2, t, d - out * 2, Math.min(0.04, t / 2 - 0.005)), color, T(-w / 2, y, 0)));
  B.withCut(cutFor('right'), () => B.add('solid', rbox(out * 2, t, d - out * 2, Math.min(0.04, t / 2 - 0.005)), color, T(w / 2, y, 0)));
}

/** Horizontal clapboard lines / vertical battens on the upper walls (per face). */
function siding(B: GeoBuilder, b: Building, color: ColorLike, y0: number, spacing: number, vertical: boolean): void {
  const { width: w, depth: d, height: h } = b;
  const dk = shade(color, 0.86);
  const ys = y0 + STUB;
  for (const face of FACES) {
    const len = face === 'front' || face === 'back' ? w : d;
    B.withCut(S(b, face), () => {
      if (vertical) {
        const n = Math.floor(len / spacing);
        for (let i = 1; i < n; i++) {
          const u = -len / 2 + i * spacing;
          if (face === 'front' && Math.abs(u) < b.doorWidth / 2 + 0.2) continue;
          B.add('solid', box(0.035, h - ys - 0.15, 0.03), dk, onFace(face, w, d, u, ys + (h - ys) / 2, 0.005), { jitter: 0.02 });
        }
      } else {
        for (let y = ys + spacing; y < h - 0.05; y += spacing) {
          if (face === 'front') {
            const seg = len / 2 - b.doorWidth / 2 - 0.15;
            for (const sx of [-1, 1]) B.add('solid', box(seg, 0.035, 0.03), dk, onFace(face, w, d, sx * (b.doorWidth / 2 + 0.15 + seg / 2), y, 0.005), { jitter: 0.015 });
          } else B.add('solid', box(len - 0.1, 0.035, 0.03), dk, onFace(face, w, d, 0, y, 0.005), { jitter: 0.015 });
        }
      }
    });
  }
  void cone;
}

/** Window on a face: the outside unit (lit at night) and the inside reveal with sky glass. */
export function win(B: GeoBuilder, b: Building, face: Face, u: number, y: number, w: number, h: number, o: WindowOpts & { curtains?: ColorLike } = {}): void {
  B.withCut(y + h > b.floorLift + STUB ? S(b, face) : 0, () => {
    B.at(onFace(face, b.width, b.depth, u, y), () => windowUnit(B, w, h, { lit: 1, ...o }));
    B.at(innerFace(b, face, u, y), () => innerWindow(B, w, h, o));
  });
}

function innerWindow(B: GeoBuilder, w: number, h: number, o: WindowOpts & { curtains?: ColorLike }): void {
  const tint = B.random();
  const frame = P.woodLight;
  if (o.round) {
    const r = w / 2;
    B.addRaw('window', cyl(r, r, 0.04, 20), [0, tint, 1], T(0, r, -0.01, 0, Math.PI / 2));
    B.add('solid', torus(r, 0.05, 6, 20), frame, T(0, r, 0.02), { ao: false });
    return;
  }
  if (o.arched) {
    B.addRaw('window', archPanel(w, h, 0.03, 0), [0, tint, 1], T(0, 0, -0.005));
    B.add('solid', archFrame(w, h, 0.07, 0.06), frame, T(0, 0, 0.02), { ao: false });
  } else {
    B.addRaw('window', rbox(w, h, 0.03, 0.01), [0, tint, 1], T(0, h / 2, -0.005));
    for (const sx of [-1, 1]) B.add('solid', rbox(0.07, h + 0.07, 0.06, 0.02), frame, T(sx * (w / 2 + 0.035), h / 2, 0.02), { ao: false });
    B.add('solid', rbox(w + 0.14, 0.07, 0.06, 0.02), frame, T(0, h + 0.035, 0.02), { ao: false });
    B.add('solid', rbox(0.04, h, 0.03, 0.01), frame, T(0, h / 2, 0.02), { ao: false });
    B.add('solid', rbox(w, 0.04, 0.03, 0.01), frame, T(0, h * 0.55, 0.02), { ao: false });
  }
  // deep sill (a little shelf) inside
  B.add('solid', rbox(w + 0.24, 0.06, 0.2, 0.02), shade(frame, 1.05), T(0, -0.02, 0.09), { ao: false });
  if (o.curtains) {
    for (const sx of [-1, 1]) {
      B.add('solid', rbox(w * 0.22, h * 0.92, 0.05, 0.025), o.curtains, T(sx * (w / 2 - w * 0.06), h * 0.52, 0.07), { ao: false, jitter: 0.04 });
      B.add('solid', rbox(w * 0.2, 0.05, 0.06, 0.02), shade(o.curtains, 0.8), T(sx * (w / 2 - w * 0.06), h * 0.35, 0.09), { ao: false });
    }
    B.add('solid', cyl(0.018, 0.018, w + 0.3, 6), P.brass, T(0, h + 0.1, 0.08, 0, 0, Math.PI / 2), { ao: false });
  }
}

/** Stone doorstep ramp from the floor down to the ground (matches the shared ramp). */
function stoop(B: GeoBuilder, b: Building, color: ColorLike): void {
  const rl = rampLength(b);
  const y0 = b.floorLift;
  const half = rampHalfWidth(b);
  const len = Math.hypot(rl, y0);
  const pitch = Math.atan2(y0, rl);
  const z = b.depth / 2 + rl / 2;
  B.at(T(0, y0 / 2, z, 0, pitch), () => {
    B.add('solid', rbox(half * 2, 0.14, len + 0.04, 0.04), color, T(0, -0.07, 0), { grad: 0.1 });
    // worn treads
    const n = Math.max(2, Math.round(rl / 0.38));
    for (let k = 0; k < n; k++) B.add('solid', box(half * 2 - 0.12, 0.012, 0.05), shade(color, 0.82), T(0, 0.002, -len / 2 + ((k + 0.5) / n) * len), { ao: false });
  });
  // cheeks (low stone wing walls) that hide the ramp's sides
  for (const sx of [-1, 1]) {
    B.at(T(sx * (half + 0.12), 0, z), () => {
      B.add('solid', rbox(0.26, y0 + 0.18, rl + 0.05, 0.06), shade(color, 0.92), T(0, (y0 + 0.18) / 2 - 0.08, 0, 0, 0), { grad: 0.2 });
      B.add('solid', rbox(0.3, 0.08, rl + 0.1, 0.03), shade(color, 1.06), T(0, y0 + 0.1, 0, 0, pitch * 0.0));
    });
  }
}

function placeAt(B: GeoBuilder, b: Building, fn: () => void): void {
  const y = terrainHeight(b.position.x, b.position.z);
  B.at(T(b.position.x, y, b.position.z, b.yaw), fn);
}

function sign(B: GeoBuilder, key: string, w: number, m: Matrix4, frame: string = P.woodDark, both = false): void {
  B.at(m, () => signBoard(B, key, w, w / 4, signUV(key), quad, frame, both));
}

/** A face-dressing helper: fn runs in the face transform with that face's cut slot (above the stub). */
function onFaceCut(B: GeoBuilder, b: Building, face: Face, u: number, y: number, out: number, fn: () => void, lowY = y): void {
  B.withCut(lowY > b.floorLift + STUB - 0.1 ? S(b, face) : 0, () => B.at(onFace(face, b.width, b.depth, u, y, out), fn));
}

// ---------------------------------------------------------------------------
// Café — cream walls over a teal wainscot, big shop windows, striped awning, terracotta tiles.
// ---------------------------------------------------------------------------
function cafe(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    const teal = '#4f6f66';
    plinthWalkIn(B, b, P.stoneMid);
    shellWalls(B, b, { y0, outer: b.wallColor, outerStub: teal, inner: '#f2e6cf', wainscot: '#5f8277', rail: '#e9dcc0', floor: 'planks', floorColor: '#a57b55', doorH: 2.3 });
    band(B, b, y0 + STUB + 0.02, 0.1, P.trim);
    band(B, b, h - 0.05, 0.2, P.trim);
    corners(B, b, 0.22, P.trim, y0, h);
    for (const s of [-1, 1]) {
      win(B, b, 'front', s * 3.15, y0 + 0.95, 2.3, 1.75, { frame: teal, mullions: 'grid', sill: true, curtains: '#efe4cf' });
      onFaceCut(B, b, 'front', s * 3.15, y0 + 0.95, 0, () => B.add('solid', rbox(2.2, 0.42, 0.04, 0.02), '#efe4cf', T(0, 0.35, 0.03)));
    }
    B.withCut(S(b, 'front'), () => B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 2.3, { frame: teal, color: '#4f6f66', style: 'glass', double: true, hood: null, step: false, walkIn: true })));
    onFaceCut(B, b, 'front', 0, 0, 0, () => awning(B, w - 0.6, h - 0.55, 1.35, '#b0563d', '#efe3cf', 0.55), h);
    B.withCut(S(b, 'front'), () => sign(B, 'cafe', 2.2, onFace('front', w, d, 0, h + 0.55, 0.12), '#2f4a44'));
    // sides & back: arched shuttered windows
    for (const u of [2.0, -2.8]) win(B, b, 'left', u, y0 + 1.25, 0.85, 1.5, { arched: true, shutters: '#6d8b7f', flowers: true, curtains: '#d9c4a0' });
    for (const u of [-1.5, 0.4]) win(B, b, 'right', u, y0 + 1.25, 0.85, 1.5, { arched: true, shutters: '#6d8b7f', flowers: true, curtains: '#d9c4a0' });
    win(B, b, 'back', 3.6, y0 + 1.55, 0.9, 1.15, { shutters: '#6d8b7f' });
    // roof (ridge along X) — roof slot
    B.withCut(S(b, 'roof'), () => {
      B.at(T(0, h, 0, Math.PI / 2), () => {
        roof(B, { span: d, rise: 2.4, length: w + 0.9, color: b.roofColor, tiles: 'scallop', courses: 8, overhang: 0.55 });
        gableEnds(B, d, 2.4, w, b.wallColor);
      });
      for (const s of [-1, 1]) B.at(T(s * (w / 2 + 0.02), h + 0.85, 0, (s * Math.PI) / 2), () => windowUnit(B, 0.7, 0.7, { round: true, frame: P.trim, lit: 0.9 }));
      chimney(B, 3.6, h + 0.7, -2.4, 2.0, '#a8705a');
    });
    // potted bay trees flanking the door, beside the ramp
    for (const s of [-1, 1]) {
      const x = s * (rampHalfWidth(b) + 0.62);
      B.add('solid', cyl(0.26, 0.2, 0.42, 12), '#b5704f', T(x, 0.21, d / 2 + 0.42));
      B.add('solid', cyl(0.04, 0.04, 0.5, 6), P.woodDark, T(x, 0.65, d / 2 + 0.42));
      B.add('plant', sphere(0.34, 12, 9), P.leaf, T(x, 1.05, d / 2 + 0.42), { grad: 0.3 });
    }
    stoop(B, b, P.stoneMid);
    // little bistro bench against the right wall outside
    B.at(onFace('right', w, d, 2.2, 0, 0.35), () => {
      B.add('solid', rbox(1.6, 0.08, 0.4, 0.03), P.wood, T(0, 0.45, 0));
      for (const s of [-1, 1]) B.add('solid', rbox(0.06, 0.45, 0.35, 0.02), P.iron, T(s * 0.7, 0.22, 0));
    });
  });
}

// ---------------------------------------------------------------------------
// General Store — clapboard with a stepped false front, display windows, green awning.
// ---------------------------------------------------------------------------
function store(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    const green = '#5f6f5a';
    plinthWalkIn(B, b, P.stoneDark);
    shellWalls(B, b, { y0, outer: b.wallColor, inner: '#efe4cc', wainscot: '#7d6a50', floor: 'planks', floorColor: '#9b7550', doorH: 2.3 });
    siding(B, b, b.wallColor, y0, 0.3, false);
    // clapboard lines on the stub too (never cut)
    for (const face of FACES) {
      const len = face === 'front' || face === 'back' ? w : d;
      for (let y = y0 + 0.3; y < y0 + STUB - 0.05; y += 0.3) {
        if (face === 'front') {
          const seg = len / 2 - b.doorWidth / 2 - 0.15;
          for (const sx of [-1, 1]) B.add('solid', box(seg, 0.035, 0.03), shade(b.wallColor, 0.86), onFace(face, w, d, sx * (b.doorWidth / 2 + 0.15 + seg / 2), y, 0.005));
        } else B.add('solid', box(len - 0.1, 0.035, 0.03), shade(b.wallColor, 0.86), onFace(face, w, d, 0, y, 0.005));
      }
    }
    corners(B, b, 0.24, '#efe6d2', y0, h);
    band(B, b, h - 0.05, 0.16, P.trim);
    // false front (front slot)
    const ff = '#e3d3b2';
    B.withCut(S(b, 'front'), () => {
      B.add('solid', rbox(w + 0.3, 2.0, 0.32, 0.08), ff, T(0, h + 0.75, d / 2 - 0.02), { ao: false });
      B.add('solid', rbox(3.2, 0.7, 0.32, 0.08), ff, T(0, h + 2.0, d / 2 - 0.02), { ao: false });
      B.add('solid', rbox(w + 0.5, 0.16, 0.44, 0.05), P.trim, T(0, h + 1.78, d / 2), { ao: false });
      B.add('solid', rbox(3.4, 0.14, 0.44, 0.05), P.trim, T(0, h + 2.38, d / 2), { ao: false });
      B.add('solid', sphere(0.14, 10, 8), P.trim, T(0, h + 2.55, d / 2));
      sign(B, 'store', 4.4, onFace('front', w, d, 0, h + 0.95, 0.18), green);
      B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 2.3, { frame: green, color: '#6f5440', style: 'glass', double: true, step: false, walkIn: true }));
    });
    for (const s of [-1, 1]) {
      win(B, b, 'front', s * 3.0, y0 + 0.75, 2.2, 1.65, { frame: green, mullions: 'vertical' });
      onFaceCut(B, b, 'front', s * 3.0, y0 + 0.75, 0, () => B.add('solid', rbox(2.1, 0.3, 0.18, 0.03), P.woodDark, T(0, -0.25, 0.12)));
    }
    onFaceCut(B, b, 'front', 0, 0, 0, () => awning(B, w - 0.4, h - 0.45, 1.25, green, '#eee5d0', 0.5), h);
    // board porch either side of the ramp
    const rh = rampHalfWidth(b) + 0.3;
    for (let i = 0; i < 9; i++) {
      const zz = d / 2 + 0.14 + i * 0.23;
      const seg = w / 2 + 0.3 - rh;
      for (const sx of [-1, 1]) B.add('solid', rbox(seg, 0.06, 0.22, 0.02), shade(P.woodLight, 0.92 + (i % 3) * 0.04), T(sx * (rh + seg / 2), 0.03, zz), { jitter: 0.04 });
    }
    stoop(B, b, P.stoneMid);
    for (const face of ['left', 'right'] as Face[]) for (const u of [-1.6, 1.8]) win(B, b, face, u, y0 + 1.2, 1.0, 1.25, { shutters: green, flowers: face === 'right' });
    for (const u of [-2.6, 2.6]) win(B, b, 'back', u, y0 + 1.55, 0.9, 1.0, {});
    B.withCut(S(b, 'roof'), () => {
      B.at(T(0, h, -0.15), () => {
        roof(B, { span: w, rise: 1.9, length: d + 0.6, color: b.roofColor, tiles: 'strips', overhang: 0.4 });
        gableEnds(B, w, 1.9, d + 0.2, b.wallColor);
      });
      stovepipe(B, -3.6, h + 0.6, -2.4, 1.8);
    });
  });
}

// ---------------------------------------------------------------------------
// Town Hall — pale stone civic hall with portico, pediment, pavilion roof and a
// clock + bell tower at the front-right corner (above the bell rope).
// ---------------------------------------------------------------------------
function quoins(B: GeoBuilder, b: Building, color: ColorLike, y0: number, top: number): void {
  const { width: w, depth: d } = b;
  const n = Math.floor((top - y0) / 0.5);
  const parts: [number, number, CutPart][] = [[-1, 1, 'cornerFL'], [1, 1, 'cornerFR'], [-1, -1, 'cornerBL'], [1, -1, 'cornerBR']];
  for (const [sx, sz, part] of parts)
    for (let i = 0; i < n; i++) {
      const y = y0 + 0.25 + i * 0.5;
      B.withCut(y > y0 + STUB ? S(b, part) : 0, () => {
        const big = i % 2 === 0;
        B.add('solid', rbox(big ? 0.62 : 0.4, 0.42, 0.2, 0.06), color, T((sx * w) / 2 - sx * (big ? 0.2 : 0.1), y, (sz * d) / 2 + sz * 0.02));
        B.add('solid', rbox(0.2, 0.42, big ? 0.4 : 0.62, 0.06), color, T((sx * w) / 2 + sx * 0.02, y, (sz * d) / 2 - sz * (big ? 0.1 : 0.2)));
      });
    }
}

function hall(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    const tw = b.tower!;
    const ts = tw.size;
    const tx = HALL_TOWER_X;
    const tz = d / 2 - ts / 2 + 0.12;
    plinthWalkIn(B, b, P.stoneMid);
    shellWalls(B, b, { y0, outer: b.wallColor, inner: '#efe7d8', wainscot: '#6a5a6e', rail: '#d8cdb9', floor: 'flags', floorColor: '#cbbfa8', doorH: 2.75, round: 0.05 });
    quoins(B, b, '#c8bca6', y0, h - 0.4);
    band(B, b, y0 + 2.35, 0.16, '#c8bca6');
    band(B, b, h - 0.1, 0.3, '#efe7d6');
    B.withCut(S(b, 'roof'), () => B.add('solid', rbox(w + 0.5, 0.16, d + 0.5, 0.06), '#c8bca6', T(0, h + 0.08, 0)));
    // ramp up to the door (the old steps' footprint) + portico: 4 columns, entablature, pediment
    stoop(B, b, P.stone);
    const colX = [-3.9, -2.3, 2.3, 3.9];
    const ch = h - 0.4;
    for (const x of colX) {
      B.add('solid', rbox(0.7, 0.3, 0.7, 0.06), P.stone, T(x, y0 + 0.15, d / 2 + 0.25));
      B.withCut(S(b, 'front'), () => {
        B.add('solid', cyl(0.24, 0.28, ch - y0 - 0.6, 16), '#efe8da', T(x, y0 + 0.3 + (ch - y0 - 0.6) / 2, d / 2 + 0.25));
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          B.add('solid', rbox(0.04, ch - y0 - 0.8, 0.04, 0.015), '#ddd4c2', T(x + Math.cos(a) * 0.25, y0 + 0.3 + (ch - y0 - 0.6) / 2, d / 2 + 0.25 + Math.sin(a) * 0.25));
        }
        B.add('solid', rbox(0.66, 0.3, 0.66, 0.08), P.stone, T(x, ch - 0.15, d / 2 + 0.25));
      });
    }
    // portico floor (under the columns, beside the ramp)
    for (const sx of [-1, 1]) B.add('solid', rbox(3.0, y0 + 0.02, 0.9, 0.06), P.stone, T(sx * (rampHalfWidth(b) + 0.25 + 1.5), (y0 + 0.02) / 2 - 0.02, d / 2 + 0.3), { grad: 0.15 });
    B.withCut(S(b, 'front'), () => {
      B.add('solid', rbox(8.8, 0.5, 1.2, 0.08), '#e8e0cf', T(0, ch + 0.25, d / 2 + 0.2), { ao: false });
      B.at(T(0, ch + 0.5, d / 2 + 0.25), () => roof(B, { span: 9.0, rise: 1.6, length: 1.3, color: b.roofColor, tiles: 'strips', overhang: 0.3, thickness: 0.24, curve: 0.02, courses: 5 }));
      B.add('solid', gableWall(8.8, 1.52, 0.2), '#e8e0cf', T(0, ch + 0.5, d / 2 + 0.82));
      B.at(T(0, ch + 1.0, d / 2 + 0.92), () => windowUnit(B, 0.62, 0.62, { round: true, frame: '#c8bca6', lit: 0.9 }));
      B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 2.75, { frame: '#c8bca6', color: '#5a4636', double: true, style: 'panel', arched: true, step: false, walkIn: true }));
      sign(B, 'hall', 2.6, onFace('front', w, d, 0, y0 + 3.25, 0.05), '#c8bca6');
    });
    // tall arched windows (avoid the tower corner)
    for (const u of [-5.6, -4.3]) win(B, b, 'front', u, y0 + 0.9, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid' });
    for (const u of [-4.2, -1.4, 1.4, 4.2]) win(B, b, 'back', u, y0 + 1.25, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid' });
    for (const u of [-3.4, -0.4]) win(B, b, 'left', u, y0 + 1.25, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid' });
    for (const u of [0.4, 3.4]) win(B, b, 'right', u, y0 + 1.25, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid' });
    B.withCut(S(b, 'roof'), () => {
      B.at(T(0, h + 0.15, 0), () => pavilionRoof(B, w, d, 4.0, b.roofColor, 0.45));
      chimney(B, -5.0, h + 1.0, -2.8, 1.6, '#b9ad98', true);
    });

    // ---------------- tower (front-right corner; its base is solid inside) ----------------
    B.at(T(tx, 0, tz), () => {
      B.add('solid', rbox(ts + 0.3, y0 + 0.5, ts + 0.3, 0.1), P.stoneMid, T(0, y0 / 2 - 0.25, 0));
      const by = 7.25;
      // lower shaft up to the stub is always there; the rest fades with the roof
      B.add('solid', rbox(ts, STUB + 0.04, ts, 0.12), '#e3d9c7', T(0, y0 + (STUB + 0.04) / 2, 0), { grad: 0.1 });
      B.add('solid', rbox(ts + 0.06, 0.08, ts + 0.06, 0.03), '#d8cdb9', T(0, y0 + STUB + 0.02, 0));
      // inside the hall the tower base reads as the stair-tower: a little door and a lantern on the stub top
      B.at(onFace('left', ts, ts, -0.4, y0, 0.01), () => {
        B.add('solid', rbox(0.9, 0.85, 0.06, 0.03), '#5a4636', T(0, 0.45, 0.02), { ao: false });
        for (let k = 0; k < 3; k++) B.add('solid', box(0.02, 0.8, 0.02), shade('#5a4636', 0.8), T(-0.3 + k * 0.3, 0.45, 0.06), { ao: false });
        B.add('solid', sphere(0.035, 6, 5), P.brass, T(0.32, 0.45, 0.07), { ao: false });
      });
      B.add('solid', cyl(0.18, 0.2, 0.08, 10), P.iron, T(-0.6, y0 + STUB + 0.1, -0.6), { ao: false });
      B.add('solid', cyl(0.14, 0.12, 0.4, 10), '#5f7c74', T(-0.6, y0 + STUB + 0.35, -0.6), { ao: false });
      B.add('plant', sphere(0.32, 10, 8), P.leaf, T(-0.6, y0 + STUB + 0.7, -0.6), { grad: 0.3 });
      B.withCut(S(b, 'roof'), () => {
        B.add('solid', rbox(ts, by - y0 - STUB, ts, 0.14, 3), '#e3d9c7', T(0, y0 + STUB + (by - y0 - STUB) / 2, 0), { grad: 0.1 });
        const tb = { ...b, width: ts, depth: ts };
        void tb;
        for (const yy of [h - 0.1, 7.15, tw.height - 0.1]) B.add('solid', rbox(ts + 0.12, yy === h - 0.1 ? 0.3 : 0.22, ts + 0.12, 0.05), '#efe7d6', T(0, yy, 0));
        B.at(onFace('front', ts, ts, 0, 1.6), () => windowUnit(B, 0.55, 1.4, { arched: true, frame: '#efe7d6', mullions: 'vertical', lit: 0.6 }));
        B.at(onFace('right', ts, ts, 0, 1.6), () => windowUnit(B, 0.55, 1.4, { arched: true, frame: '#efe7d6', mullions: 'vertical', lit: 0.6 }));
        for (const face of ['front', 'right', 'left'] as Face[]) {
          B.at(onFace(face, ts, ts, 0, 6.25, 0.02), () => {
            B.add('solid', cyl(0.95, 0.95, 0.12, 28), '#efe7d6', T(0, 0, 0.04, 0, Math.PI / 2), { ao: false });
            B.add('solid', torus(0.92, 0.08, 8, 32), P.brass, T(0, 0, 0.1), { ao: false });
            B.add('solid', cyl(0.8, 0.8, 0.05, 28), '#f7f1e3', T(0, 0, 0.11, 0, Math.PI / 2), { ao: false });
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * Math.PI * 2;
              B.add('solid', rbox(0.06, k % 3 === 0 ? 0.2 : 0.12, 0.03, 0.01), '#4a4148', T(Math.sin(a) * 0.66, Math.cos(a) * 0.66, 0.14, 0, 0, -a), { ao: false });
            }
            anchors.clock.push(B.matrix.clone().multiply(T(0, 0, 0.16)));
            anchors.clockCut.push(B.cut);
          });
        }
        const bh = tw.height - by - 0.2;
        B.add('solid', rbox(ts - 0.1, 0.2, ts - 0.1, 0.06), '#d8cdb9', T(0, by + 0.1, 0));
        for (const face of FACES) {
          B.at(onFace(face, ts, ts, 0, by + 0.2, -0.18), () => {
            B.add('solid', archFrame(1.55, bh - 0.35, 0.42, 0.34), '#e3d9c7', T(0, 0, 0));
            B.add('solid', rbox(1.7, 0.12, 0.4, 0.04), '#efe7d6', T(0, 0.02, 0.05));
          });
        }
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(0.55, bh, 0.55, 0.08), '#e3d9c7', T((sx * ts) / 2 - sx * 0.27, by + bh / 2, (sz * ts) / 2 - sz * 0.27));
        B.add('solid', rbox(ts + 0.4, 0.3, ts + 0.4, 0.1), '#efe7d6', T(0, tw.height, 0), { ao: false });
        B.add('solid', cone(ts * 0.62 * Math.SQRT2 * 0.5 + 0.9, 3.0, 4), b.roofColor, T(0, tw.height + 1.65, 0, Math.PI / 4), { ao: false, grad: 0.15 });
        B.add('solid', sphere(0.22, 10, 8), P.brass, T(0, tw.height + 3.2, 0), { ao: false });
        B.add('solid', cyl(0.03, 0.03, 0.9, 6), P.iron, T(0, tw.height + 3.7, 0), { ao: false });
        anchors.spinners.push({ matrix: B.matrix.clone().multiply(T(0, tw.height + 3.95, 0)), kind: 'vane', speed: 0.2, size: 1, cut: B.cut });
        anchors.bell = B.matrix.clone().multiply(T(0, by + bh - 0.35, 0));
        anchors.bellCut = B.cut;
        B.add('solid', rbox(ts - 0.6, 0.14, 0.18, 0.04), P.woodDark, T(0, by + bh - 0.2, 0));
      });
    });
    // bell rope from the tower down to the rope post (the bell interactable spot)
    B.withCut(S(b, 'roof'), () => B.add('solid', cyl(0.025, 0.025, 7.2 - 1.3, 6), '#c9b18a', T(tx - 0.05, 1.3 + (7.2 - 1.3) / 2, d / 2 + 0.5, 0, -0.08)));
    // flower bed along the front-left
    B.at(T(-5.4, 0, d / 2 + 0.75), () => {
      B.add('solid', rbox(2.6, 0.3, 0.7, 0.1), P.stone, T(0, 0.15, 0));
      B.add('solid', rbox(2.4, 0.06, 0.55, 0.03), P.soil, T(0, 0.31, 0));
      B.at(T(0, 0.3, 0), () => flowerPatch(B, 2.2, 0.45, 16, ['#e7a0a6', '#f4efe6', '#b9a2d8']));
    });
  });
}

// ---------------------------------------------------------------------------
// Workshop — timber barn with corrugated roof, big double doors, gear emblem.
// ---------------------------------------------------------------------------
function workshop(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    const beam = '#5e4636';
    plinthWalkIn(B, b, P.stoneDark);
    shellWalls(B, b, { y0, outer: b.wallColor, inner: '#cdb593', wainscot: '#7a5c46', floor: 'planks', floorColor: '#8e6c4c', doorH: 3.05 });
    siding(B, b, b.wallColor, y0, 0.34, true);
    corners(B, b, 0.3, beam, y0, h);
    band(B, b, y0 + 0.1, 0.2, beam);
    band(B, b, h - 0.1, 0.24, beam);
    for (const face of ['left', 'right', 'back'] as Face[]) {
      const len = face === 'back' ? w : d;
      for (const s of [-1, 1]) onFaceCut(B, b, face, (s * len) / 3.0, y0 + (h - y0) / 2 + 0.3, 0.02, () => B.add('solid', rbox(0.16, (h - y0 - STUB) * 1.12, 0.08, 0.03), beam, T(0, 0, 0, 0, 0, s * 0.55)));
    }
    B.withCut(S(b, 'front'), () => {
      B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 3.05, { frame: beam, color: '#8a5a3c', double: true, style: 'barn', step: false, walkIn: true }));
      anchors.spinners.push({ matrix: B.matrix.clone().multiply(T(0, h + 0.85, d / 2 + 0.15)), kind: 'gear', speed: 0.35, size: 0.75, cut: B.cut });
      sign(B, 'workshop', 2.4, onFace('front', w, d, 0, h - 0.5, 0.08), beam);
      // pegboard with tool silhouettes beside the doors
      B.at(onFace('front', w, d, 3.9, y0 + 2.35, 0.03), () => {
        B.add('solid', rbox(1.4, 0.55, 0.05, 0.02), '#c9a87c', T(0, 0, 0));
        B.add('solid', rbox(0.06, 0.45, 0.04, 0.01), P.iron, T(-0.45, 0, 0.05));
        B.add('solid', rbox(0.3, 0.06, 0.04, 0.01), P.iron, T(-0.45, 0.18, 0.05));
        B.add('solid', torus(0.13, 0.03, 6, 12), P.iron, T(0.05, 0, 0.05));
        B.add('solid', rbox(0.5, 0.08, 0.04, 0.01), '#a8705a', T(0.4, 0.05, 0.05, 0, 0, 0.4));
      });
    });
    for (const u of [-3.9, 3.9]) win(B, b, 'front', u, y0 + 1.1, 1.3, 1.1, { frame: beam, mullions: 'grid' });
    for (const u of [-2.2, 2.2]) {
      win(B, b, 'left', u, y0 + 1.25, 1.2, 1.2, { frame: beam, mullions: 'grid' });
      win(B, b, 'right', u, y0 + 1.25, 1.2, 1.2, { frame: beam, mullions: 'grid' });
    }
    win(B, b, 'back', -3.6, y0 + 1.6, 1.2, 1.0, { frame: beam, mullions: 'grid' });
    stoop(B, b, P.stoneDark);
    B.withCut(S(b, 'roof'), () => {
      B.at(T(0, h, 0), () => {
        roof(B, { span: w, rise: 2.9, length: d + 0.7, color: b.roofColor, tiles: 'ribs', overhang: 0.5, curve: 0.25 });
        gableEnds(B, w, 2.9, d + 0.3, mix(b.wallColor, '#7a5c48', 0.3).getStyle());
        B.add('solid', rbox(1.1, 1.0, 0.1, 0.04), '#8a5a3c', T(0, 0.85, d / 2 + 0.12));
        B.add('solid', rbox(0.12, 0.12, 1.4, 0.04), beam, T(0, 1.75, d / 2 + 0.5));
        B.add('solid', cyl(0.05, 0.05, 0.12, 8), P.iron, T(0, 1.65, d / 2 + 1.1, 0, Math.PI / 2));
        for (const z of [-1.8, 1.8]) B.addRaw('window', rbox(0.9, 0.05, 1.1, 0.02), [0.8, 0.4, 0], T(-2.3, 1.3, z, 0, 0, 0.5));
      });
      stovepipe(B, 4.35, h + 1.0, -3.1, 2.0);
      anchors.spinners.push({ matrix: B.matrix.clone().multiply(T(-3.4, h + 2.6, 0.5)), kind: 'windmill', speed: 1.4, size: 0.7, cut: B.cut });
      B.add('solid', cyl(0.04, 0.05, 1.0, 6), P.iron, T(-3.4, h + 1.95, 0.3));
    });
  });
}

// ---------------------------------------------------------------------------
// Homes — lived-in cottages (the closed ones stay in buildings.ts).
// ---------------------------------------------------------------------------
const HOME_VARIANTS: Record<number, { roof: 'steep' | 'pavilion'; shutters: string; door: string; trim: string; chimneyX: number; porch: boolean; timber: boolean; flowers: string; inner: string; wainscot: string; floor: string; curtains: string }> = {
  1: { roof: 'steep', shutters: '#8a5a48', door: '#7a3f36', trim: '#f2e9d8', chimneyX: 1.7, porch: false, timber: true, flowers: '#e7a0a6', inner: '#f3e5d2', wainscot: '#8a5a48', floor: '#a9805a', curtains: '#e7c7b8' },
  2: { roof: 'pavilion', shutters: '#5f7c74', door: '#3f5a52', trim: '#f2ede2', chimneyX: -1.7, porch: true, timber: false, flowers: '#f1d27a', inner: '#e9eee2', wainscot: '#5f7c74', floor: '#b08a62', curtains: '#f1e2b0' },
};

function home(B: GeoBuilder, b: Building, n: number): void {
  const v = HOME_VARIANTS[n] ?? HOME_VARIANTS[1]!;
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    plinthWalkIn(B, b, P.stoneMid);
    shellWalls(B, b, { y0, outer: b.wallColor, inner: v.inner, wainscot: v.wainscot, floor: 'planks', floorColor: v.floor, doorH: 2.15 });
    corners(B, b, 0.2, v.trim, y0, h);
    band(B, b, h - 0.05, 0.16, v.trim);
    if (v.timber) {
      const beam = '#6a4f3e';
      band(B, b, y0 + 1.25, 0.12, beam);
      for (const face of FACES) {
        const len = face === 'front' || face === 'back' ? w : d;
        for (const u of [-len / 2 + 0.9, len / 2 - 0.9]) onFaceCut(B, b, face, u, y0 + 1.25 + (h - y0 - 1.25) / 2, 0.01, () => B.add('solid', rbox(0.12, h - y0 - 1.3, 0.06, 0.02), beam));
      }
    }
    const roundDoor = n === 1;
    B.withCut(S(b, 'front'), () => {
      B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 2.15, { frame: v.trim, color: v.door, style: roundDoor ? 'round' : 'plank', double: false, arched: roundDoor, hood: v.porch ? null : shade(b.roofColor, 0.95), step: false, walkIn: true }));
      sign(B, `house${n}`, 0.6, onFace('front', w, d, -1.35, y0 + 2.35, 0.06), v.trim);
    });
    for (const s of [-1, 1]) win(B, b, 'front', s * 2.35, y0 + 0.95, 0.95, 1.15, { shutters: v.shutters, flowers: true, frame: v.trim, curtains: v.curtains });
    for (const face of ['left', 'right'] as Face[]) win(B, b, face, 0.6, y0 + 1.0, 0.9, 1.1, { shutters: v.shutters, frame: v.trim, flowers: face === 'left', curtains: v.curtains });
    win(B, b, 'back', -1.6, y0 + 1.2, 0.9, 1.0, { frame: v.trim, curtains: v.curtains });
    if (v.porch) {
      B.withCut(S(b, 'front'), () => {
        B.add('solid', rbox(2.8, 0.12, 1.1, 0.05), shade(b.roofColor, 0.95), T(0, h - 0.35, d / 2 + 0.48, 0, 0.16), { ao: false });
        for (const s of [-1, 1]) B.add('solid', cyl(0.06, 0.06, h - 0.55, 8), v.trim, T(s * 1.3, (h - 0.55) / 2, d / 2 + 0.95));
      });
    }
    const rc = b.roofColor;
    B.withCut(S(b, 'roof'), () => {
      if (v.roof === 'steep') {
        B.at(T(0, h, 0, Math.PI / 2), () => {
          roof(B, { span: d, rise: 2.8, length: w + 0.7, color: rc, tiles: 'scallop', overhang: 0.5, curve: 0.1, courses: 8 });
          gableEnds(B, d, 2.8, w, b.wallColor);
        });
        B.at(T(0, h + 0.45, d / 2 - 0.55), () => {
          B.add('solid', rbox(1.3, 1.0, 1.1, 0.08), b.wallColor, T(0, 0.35, 0));
          B.at(T(0, 0.85, 0), () => roof(B, { span: 1.3, rise: 0.6, length: 1.3, color: rc, tiles: 'none', overhang: 0.18, thickness: 0.16 }));
          B.at(T(0, 0.0, 0.56), () => windowUnit(B, 0.6, 0.6, { frame: v.trim, sill: false, lit: 1 }));
        });
      } else {
        B.at(T(0, h, 0), () => pavilionRoof(B, w, d, 2.4, rc, 0.45));
        B.at(T(0, h + 0.3, d / 2 - 0.25), () => {
          B.add('solid', rbox(1.2, 0.9, 0.8, 0.08), b.wallColor, T(0, 0.35, 0));
          B.at(T(0, 0.8, 0), () => roof(B, { span: 1.2, rise: 0.55, length: 1.0, color: rc, tiles: 'none', overhang: 0.15, thickness: 0.15 }));
          B.at(T(0, 0.05, 0.41), () => windowUnit(B, 0.55, 0.55, { frame: v.trim, sill: false, lit: 1 }));
        });
      }
      // Smoke follows the hearth inside (lit by players, burns down): client/src/activities.
      chimney(B, v.chimneyX, h + 0.4, -2.82 + 0.25, 2.0, n % 2 ? '#a8705a' : '#9a8f84', false);
      anchors.hearthChimneys.push({ buildingId: b.id, position: worldPoint(B, v.chimneyX, h + 0.4 + 2.0 + 0.4, -2.82 + 0.25) });
    });
    stoop(B, b, P.stoneMid);
    for (const s of [-1, 1]) {
      B.at(T(s * 2.55, 0, d / 2 + 0.8), () => {
        B.add('solid', rbox(1.5, 0.16, 0.6, 0.06), P.soil, T(0, 0.06, 0));
        flowerPatch(B, 1.3, 0.45, 9, [v.flowers, P.petals[(n + 2) % P.petals.length]!, '#f4efe6']);
      });
    }
    if (n === 2) B.at(T(-2.9, 0, d / 2 + 2.3), () => shrub(B, 0.55, P.leaf, 6));
    for (const s of [-1, 1]) B.at(T(s * 2.4, 0, -d / 2 - 0.85), () => shrub(B, 0.6 + B.random() * 0.2, P.leaf, n % 2 ? 3 : 0));
  });
}

// ---------------------------------------------------------------------------
// Boathouse — weathered blue planks by the shore.
// ---------------------------------------------------------------------------
function boathouse(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h, floorLift: y0 } = b;
    plinthWalkIn(B, b, P.stoneDark);
    shellWalls(B, b, { y0, outer: b.wallColor, inner: '#c9d2cf', wainscot: '#4f6470', floor: 'planks', floorColor: '#8f7a62', doorH: 2.3 });
    siding(B, b, b.wallColor, y0, 0.28, true);
    corners(B, b, 0.22, '#e8e4d8', y0, h);
    band(B, b, h - 0.05, 0.16, '#e8e4d8');
    B.withCut(S(b, 'front'), () => {
      B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, b.doorWidth, 2.3, { frame: '#e8e4d8', color: '#3f4e57', double: true, style: 'barn', step: false, walkIn: true }));
      sign(B, 'boathouse', 2.0, onFace('front', w, d, 0, h - 0.3, 0.06), '#3f4e57');
    });
    for (const face of ['left', 'right'] as Face[]) win(B, b, face, 0, y0 + 1.25, 0.9, 0.9, { round: true, frame: '#e8e4d8' });
    B.withCut(S(b, 'roof'), () => {
      B.at(T(0, h, 0), () => {
        roof(B, { span: w, rise: 1.9, length: d + 0.6, color: b.roofColor, tiles: 'strips', overhang: 0.45 });
        gableEnds(B, w, 1.9, d + 0.2, b.wallColor);
      });
    });
    stoop(B, b, P.stoneDark);
    onFaceCut(B, b, 'left', 1.9, y0 + 1.5, 0.06, () => {
      B.add('solid', torus(0.32, 0.09, 10, 20), '#e98a6b', T(0, 0, 0));
      for (let k = 0; k < 4; k++) B.add('solid', torus(0.32, 0.095, 10, 4, 0.4), '#f4efe6', T(0, 0, 0, 0, 0, (k / 4) * Math.PI * 2));
    });
    B.withCut(S(b, 'right'), () => B.at(onFace('right', w, d, 1.8, 0, 0.15), () => {
      for (const s of [-1, 1]) {
        B.add('solid', rbox(0.06, 2.0, 0.04, 0.02), P.woodLight, T(s * 0.2, 1.0, 0, 0, 0, s * 0.12));
        B.add('solid', rbox(0.18, 0.5, 0.04, 0.03), P.woodLight, T(s * 0.32, 0.25, 0, 0, 0, s * 0.12));
      }
    }));
    B.at(onFace('back', w, d, 0, 0, 0.3), () => {
      crate(B, 0.55, '#8fa3a8');
      B.at(T(0.8, 0, 0.1), () => barrel(B, 0.3, 0.7, '#6b7f86'));
    });
  });
}

/**
 * Build a walk-in building: shell + façade into `B`; floor + furnished interior
 * into `I` (a separate chunk the renderer only draws when the room can be seen).
 */
export function buildWalkIn(B: GeoBuilder, b: Building, I: GeoBuilder = B): void {
  switch (b.style) {
    case 'cafe':
      cafe(B, b);
      break;
    case 'store':
      store(B, b);
      break;
    case 'hall':
      hall(B, b);
      break;
    case 'workshop':
      workshop(B, b);
      break;
    case 'cottage':
      home(B, b, Number(b.id.split('_')[1] ?? 1));
      break;
    case 'boathouse':
      boathouse(B, b);
      break;
  }
  buildFloor(I, b);
  buildInteriorFurnishings(I, b);
}
