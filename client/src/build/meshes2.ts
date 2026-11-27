/**
 * Round-2 piece geometry: the parametric house roof (built with the town's
 * own roof kit so it reads like the houses: scalloped clay courses, ridge
 * cap, bargeboards, closed gable ends), the chimney, facade name signs and
 * the furnishings. Same conventions as meshes.ts (local frame: origin at the
 * footprint centre on the piece's base, +Z = front; wall mounts: origin at
 * the wall's centre line, the face at +Z = WALL_HALF) and a tight triangle
 * budget: small parts are plain boxes, spheres are low-segment.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Matrix4, Quaternion, Vector3 } from 'three';
import { CONFIG, PIECES, ROOF_OVERHANG, WALL_HALF, parseRoofParams, roofRise, type PieceKind, type RoofParams } from '@elsewhere/shared';
import { gableEnds, roof } from '../world/arch/kit.js';
import { GeoBuilder, T, box, cone, cyl, rbox, sphere as sphereHi, type AddOpts, type ColorLike } from '../world/geom.js';

type C = Readonly<Record<string, string>>;
const FLAT: AddOpts = { ao: false, jitter: 0.03 };
const SOFT: AddOpts = { ao: false, jitter: 0.05, grad: 0.12 };
const shade = (c: ColorLike, k: number) => new Color(c as Color).multiplyScalar(k);
const mixc = (a: ColorLike, b: ColorLike, t: number) => new Color(a as Color).lerp(new Color(b as Color), t);
const rb = (w: number, h: number, d: number, r = 0.08) => (r < 0.045 ? box(w, h, d) : rbox(w, h, d, r));
const sphere = (r: number) => sphereHi(r, r < 0.15 ? 6 : 8, r < 0.15 ? 4 : 6);
const IRON = '#3f3f42';
const LEAF = '#6f8f52';
const LEAF2 = '#8fac62';
const CREAM = '#ecdfc7';
const BRASS = '#b8925a';

function put(B: GeoBuilder, geo: ReturnType<typeof box>, color: ColorLike, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, opts: AddOpts = SOFT, bucket: 'solid' | 'glass' | 'glow' = 'solid'): void {
  B.add(bucket, geo, color, T(x, y, z, ry, rx, rz), opts);
}
/** Base-anchored box from y0 to y1. */
function slab(B: GeoBuilder, w: number, y0: number, y1: number, d: number, color: ColorLike, x = 0, z = 0, r = 0.04, opts: AddOpts = SOFT): void {
  put(B, rb(w, y1 - y0, d, r), color, x, (y0 + y1) / 2, z, 0, 0, 0, opts);
}
function legs(B: GeoBuilder, w: number, d: number, h: number, t: number, color: ColorLike): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) slab(B, t, 0, h, t, color, sx * (w / 2 - t / 2 - 0.03), sz * (d / 2 - t / 2 - 0.03), 0.02, FLAT);
}
/** Lantern-like glow (lamp glass / fire): drawn in the 'glow' bucket, coloured by the clock. */
function glow(B: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number): void {
  B.add('glow', box(w, h, d), new Color(1, 1, 1), T(x, y, z), { ao: false, jitter: 0 });
}

// ---------------------------------------------------------------------------
// House roof (parametric) + chimney
// ---------------------------------------------------------------------------

export function houseRoof(B: GeoBuilder, c: C, params: string | undefined): void {
  const r = parseRoofParams(params) ?? { w: 4, d: 4, style: 'gable' as const, pitch: 1 as const, overhang: ROOF_OVERHANG };
  const rise = roofRise(r);
  const color = c.main!;
  // Wall plate / fascia band over the wall tops so the eaves meet the walls cleanly.
  slab(B, r.w + 0.3, -0.02, 0.12, r.d + 0.3, shade(c.trim!, 0.92), 0, 0, 0.03, FLAT);
  if (r.style === 'hip') {
    hipRoof(B, r, color);
    return;
  }
  // Ridge along local Z, like the town's gable roofs; closed gable ends in plaster at both ends.
  roof(B, { span: r.w, rise, length: r.d + r.overhang * 1.4, color, tiles: 'scallop', courses: Math.max(5, Math.round(r.w * 1.35)), overhang: r.overhang, curve: 0.1 });
  gableEnds(B, r.w, rise, r.d + 0.14, mixc(CREAM, c.accent!, 0.08));
  // A little round vent in each gable.
  for (const s of [-1, 1]) {
    put(B, cyl(0.16, 0.16, 0.06, 12), shade(c.trim!, 0.9), 0, rise * 0.45, s * (r.d / 2 + 0.06), 0, Math.PI / 2, 0, FLAT);
    B.add('glass', cyl(0.11, 0.11, 0.07, 12), new Color(0.7, 0.5, 0.3), T(0, rise * 0.45, s * (r.d / 2 + 0.07), 0, Math.PI / 2, 0), { ao: false, jitter: 0 });
  }
}

// --- Hip roof (player houses only; the town's kit `pavilionRoof` is left as it is) ---------
//
// The roof surface is lofted from rings: every point at run distance s from
// the nearest eave sits at the same height, so the four facets meet exactly
// along the hips and the ridge (they share the ring corners). The slope is
// slightly convex like the gable's (`roof` curve 0.1). Same footprint, eave
// datum and ridge height as the earlier hip: eaves W x D = (w, d) + 2 x
// overhang at y = HIP_EAVE_Y, ridge at HIP_EAVE_Y + roofRise along the longer
// side. Tiles, caps and the fascia sit on that surface.

/** Height of the eave line above the piece base (the earlier hip's datum). */
export const HIP_EAVE_Y = 0.05;
const HIP_CURVE = 0.1;
const HIP_BANDS = 6;
/** Hip cap radius (the earlier hip's, so its eave corners reach as far out). */
const HIP_CAP_R = 0.11;
/** Tile size along a course and its course pitch on the slope (as the gable's scallops). */
const TILE_SEG = 0.36;
const COURSE_PITCH = 0.58;

export interface HipFrame {
  /** Half extents of the eave rectangle (local X / Z). */
  hw: number;
  hd: number;
  rise: number;
  /** Horizontal run from any eave to the ridge (= the shorter half extent). */
  run: number;
  /** Ridge half-length along X (ridge along X) or Z. */
  rl: number;
  rd: number;
}
export function hipFrame(r: RoofParams): HipFrame {
  const hw = r.w / 2 + r.overhang;
  const hd = r.d / 2 + r.overhang;
  const run = Math.min(hw, hd);
  return { hw, hd, rise: roofRise(r), run, rl: hw - run, rd: hd - run };
}
/** Height above the eave datum at fraction u of the run (0 eave, 1 ridge) and its slope dy/ds. */
function hipProfile(f: HipFrame, u: number): { y: number; slope: number } {
  return { y: HIP_EAVE_Y + f.rise * u + 2 * u * (1 - u) * HIP_CURVE, slope: (f.rise + 2 * HIP_CURVE * (1 - 2 * u)) / f.run };
}
/** The four facets: outward normal (nx, nz), rotation about Y from the +Z facet, eave distance, half-length at the eave. */
function hipFacets(f: HipFrame): { nx: number; nz: number; ry: number; eave: number; half: number }[] {
  return [
    { nx: 0, nz: 1, ry: 0, eave: f.hd, half: f.hw },
    { nx: 1, nz: 0, ry: Math.PI / 2, eave: f.hw, half: f.hd },
    { nx: 0, nz: -1, ry: Math.PI, eave: f.hd, half: f.hw },
    { nx: -1, nz: 0, ry: -Math.PI / 2, eave: f.hw, half: f.hd },
  ];
}
/** A point on a facet: run distance s in from its eave, v along it (+v = the facet's local +X). */
function facetPoint(fc: { nx: number; nz: number; eave: number }, s: number, v: number, y: number): [number, number, number] {
  // Local +X of the facet is the +Z facet's +X turned by ry: (cos ry, -sin ry) = (nz, -nx).
  return [fc.nx * (fc.eave - s) + fc.nz * v, y, fc.nz * (fc.eave - s) - fc.nx * v];
}

/** The roof's facets as one non-indexed geometry (position, normal, uv). Exported for tests. */
export function hipSurface(r: RoofParams): BufferGeometry {
  const f = hipFrame(r);
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const fc of hipFacets(f)) {
    for (let k = 0; k < HIP_BANDS; k++) {
      const u0 = k / HIP_BANDS;
      const u1 = (k + 1) / HIP_BANDS;
      const s0 = f.run * u0;
      const s1 = f.run * u1;
      const p0 = hipProfile(f, u0);
      const p1 = hipProfile(f, u1);
      const l0 = fc.half - s0;
      const l1 = Math.max(0, fc.half - s1);
      const a = facetPoint(fc, s0, -l0, p0.y);
      const b = facetPoint(fc, s0, l0, p0.y);
      const c = facetPoint(fc, s1, l1, p1.y);
      const d = facetPoint(fc, s1, -l1, p1.y);
      // Smooth along the slope within a facet, sharp across the hips.
      const n = (sl: number) => {
        const k2 = 1 / Math.hypot(1, sl);
        return [fc.nx * sl * k2, k2, fc.nz * sl * k2];
      };
      const n0 = n(p0.slope);
      const n1 = n(p1.slope);
      pos.push(...a, ...b, ...c);
      nrm.push(...n0, ...n0, ...n1);
      if (l1 > 1e-6) {
        pos.push(...a, ...c, ...d);
        nrm.push(...n0, ...n1, ...n1);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

/** Tiles of the same-size gable (its scallop loop in kit `roof`, as houseRoof calls it). */
function gableTileCount(r: RoofParams): number {
  const n = Math.max(5, Math.round(r.w * 1.35));
  const len = r.d + r.overhang * 1.4;
  const count = Math.max(2, Math.round(len / 0.36));
  const seg = len / count;
  let tiles = 0;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < count; k++) {
      const z = -len / 2 + (k + 0.5) * seg + ((i % 2) - 0.5) * seg * 0.5;
      if (Math.abs(z) <= len / 2 - seg * 0.45) tiles++;
    }
  return tiles * 2;
}

interface HipTile {
  facet: number;
  /** Run fraction of the course, the tile centre along it and its length. */
  u: number;
  v: number;
  len: number;
  dark: boolean;
}
/**
 * Scalloped courses on every facet, staggered like the gable's, cut where
 * they meet a hip (the hip cap covers the cut). Coarsened if needed so the
 * hip never has more tile triangles than the same-size gable.
 */
export function hipTiles(r: RoofParams): HipTile[] {
  const f = hipFrame(r);
  const slopeLen = Math.hypot(f.run, f.rise);
  const budget = Math.floor((gableTileCount(r) * 12) / HIP_TILE_TRIS);
  let scale = 1;
  let out: HipTile[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    out = [];
    const n = Math.max(4, Math.round(slopeLen / (COURSE_PITCH * scale)));
    const facets = hipFacets(f);
    facets.forEach((fc, fi) => {
      for (let i = 0; i < n; i++) {
        const u = (i + 0.35) / n;
        const half = fc.half - f.run * u - 0.05;
        if (half < 0.06) continue;
        const count = Math.max(1, Math.round((half * 2) / (TILE_SEG * scale)));
        const seg = (half * 2) / count;
        const off = ((i % 2) - 0.5) * seg * 0.5;
        for (let k = -1; k <= count; k++) {
          const c = -half + (k + 0.5) * seg + off;
          const lo = Math.max(-half, c - seg * 0.46);
          const hi = Math.min(half, c + seg * 0.46);
          if (hi - lo < 0.1) continue;
          out.push({ facet: fi, u, v: (lo + hi) / 2, len: hi - lo, dark: (k + i + fi) % 4 === 0 });
        }
      }
    });
    if (out.length <= budget) break;
    scale *= Math.sqrt(out.length / budget) * 1.02;
  }
  return out;
}

/** One tile: a box (1 x 0.085 x 0.2; x along the course, z down the slope) without its hidden underside. */
let tileGeo: BufferGeometry | null = null;
const HIP_TILE_TRIS = 10;
function hipTileGeometry(): BufferGeometry {
  if (tileGeo) return tileGeo;
  const box3 = new BoxGeometry(1, 0.085, 0.2).toNonIndexed();
  // BoxGeometry faces in order +x, -x, +y, -y, +z, -z (6 vertices each once non-indexed): drop -y.
  const keep = [0, 1, 2, 4, 5];
  const g = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const src = box3.getAttribute(name);
    const size = src.itemSize;
    const arr = new Float32Array(keep.length * 6 * size);
    keep.forEach((face, j) => arr.set((src.array as Float32Array).subarray(face * 6 * size, (face + 1) * 6 * size), j * 6 * size));
    g.setAttribute(name, new BufferAttribute(arr, size));
  }
  box3.dispose();
  return (tileGeo = g);
}

function hipRoof(B: GeoBuilder, r: RoofParams, color: ColorLike): void {
  const f = hipFrame(r);
  // Same colouring as the gable roof of the same variant (kit `roof`).
  const col = mixc(color, '#8a8078', 0.24);
  const dark = shade(col, 0.84);
  const cap = shade(col, 0.82);
  const NO_AO: AddOpts = { ao: false };
  B.add('solid', hipSurface(r), col, undefined, { ao: false, grad: 0.12 });
  // Fascia: the earlier hip's eave band, top flush with the eave line so the first course laps over it.
  B.add('solid', rbox(f.hw * 2 + 0.1, 0.17, f.hd * 2 + 0.1, 0.07), shade(col, 0.72), T(0, HIP_EAVE_Y - 0.085, 0), NO_AO);
  // Tile courses.
  const facets = hipFacets(f);
  const tile = hipTileGeometry();
  for (const t of hipTiles(r)) {
    const fc = facets[t.facet]!;
    const p = hipProfile(f, t.u);
    const ang = Math.atan(p.slope);
    const [x, y, z] = facetPoint(fc, f.run * t.u, t.v, p.y);
    // Lift the tile off the surface along its normal, as the gable's scallops sit on its slab.
    const lift = 0.035;
    const nx = fc.nx * Math.sin(ang) * lift;
    const nz = fc.nz * Math.sin(ang) * lift;
    B.add('solid', tile, t.dark ? dark : col, T(x + nx, y + Math.cos(ang) * lift, z + nz, fc.ry, ang, 0, t.len * 0.999, 1, 1), { ao: false, jitter: 0.07 });
  }
  // Hip caps: a rounded cap in short pieces following each (gently curved) hip, then the ridge.
  const up = 0.05;
  const corner = (sx: number, sz: number, u: number): Vector3 => {
    const s = f.run * u;
    return new Vector3(sx * Math.max(0, f.hw - s), hipProfile(f, u).y + up, sz * Math.max(0, f.hd - s));
  };
  const Y = new Vector3(0, 1, 0);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    for (let k = 0; k < HIP_BANDS; k++) {
      const a = corner(sx, sz, k / HIP_BANDS);
      const b = corner(sx, sz, (k + 1) / HIP_BANDS);
      const dir = b.clone().sub(a);
      const len = dir.length();
      const q = new Quaternion().setFromUnitVectors(Y, dir.normalize());
      // Pieces overlap a little so the cap reads as one (never past the eave corner); the eave end is closed.
      const lo = k > 0 ? 0.03 : 0;
      const mid = a.clone().add(b).multiplyScalar(0.5).addScaledVector(dir, (0.03 - lo) / 2);
      B.add('solid', cyl(HIP_CAP_R, HIP_CAP_R, len + 0.03 + lo, 6, k > 0), cap, new Matrix4().compose(mid, q, new Vector3(1, 1, 1)), NO_AO);
    }
  }
  const top = HIP_EAVE_Y + f.rise;
  const ridge = Math.max(f.rl, f.rd);
  if (ridge > 0.01) B.add('solid', cyl(0.12, 0.12, ridge * 2 + 0.04, 10, true), cap, T(0, top + 0.06, 0, f.rl > f.rd ? 0 : Math.PI / 2, 0, Math.PI / 2), NO_AO);
  // A small finial at each ridge end (one at the peak of a square roof).
  const ends: [number, number][] = ridge > 0.01 ? [[f.rl, f.rd], [-f.rl, -f.rd]] : [[0, 0]];
  for (const [ex, ez] of ends) B.add('solid', sphereHi(0.14, 8, 6), shade(cap, 0.95), T(ex, top + 0.08, ez), NO_AO);
}

function chimneyPiece(B: GeoBuilder, c: C): void {
  const h = PIECES.chimney.h;
  slab(B, 0.66, 0, h, 0.66, c.main!, 0, 0, 0.06);
  for (let i = 0; i < 5; i++) slab(B, 0.68, 0.35 + i * 0.45, 0.38 + i * 0.45, 0.68, shade(c.main!, 0.82), 0, 0, 0.01, FLAT);
  slab(B, 0.82, h - 0.02, h + 0.14, 0.82, c.trim!, 0, 0, 0.05, FLAT);
  put(B, cyl(0.13, 0.15, 0.26, 8), '#6b5e57', 0.12, h + 0.27, 0.08, 0, 0, 0, FLAT);
}

// ---------------------------------------------------------------------------
// Facade name signs (wall mounts) — the lettering is a canvas texture (BuildLayer)
// ---------------------------------------------------------------------------

/** Where a text piece's lettering goes (local frame). `back` = also on the reverse. */
export const TEXT_FACES: Partial<Record<PieceKind, { width: number; height: number; y: number; z: number; back?: boolean; font: number }>> = {
  name_board: { width: 1.6, height: 0.38, y: 2.33, z: WALL_HALF + 0.085, font: 64 },
  name_hanging: { width: 0.72, height: 0.34, y: 1.96, z: WALL_HALF + 0.597, back: true, font: 56 },
  name_plaque: { width: 0.52, height: 0.22, y: 1.62, z: WALL_HALF + 0.055, font: 52 },
};

function nameBoard(B: GeoBuilder, c: C): void {
  const m = PIECES.name_board.mount!;
  const z = WALL_HALF + m.depth / 2;
  slab(B, 1.76, m.y0, m.y1, m.depth, c.trim!, 0, z, 0.03);
  slab(B, 1.64, m.y0 + 0.05, m.y1 - 0.05, m.depth + 0.01, c.main!, 0, z, 0.02, FLAT);
  for (const sx of [-1, 1]) put(B, sphere(0.025), BRASS, sx * 0.8, (m.y0 + m.y1) / 2, z + m.depth / 2 + 0.01, 0, 0, 0, FLAT);
}

function nameHanging(B: GeoBuilder, c: C): void {
  const z0 = WALL_HALF;
  // Wall plate + bracket arm with a little scroll.
  slab(B, 0.12, 2.22, 2.5, 0.04, IRON, 0, z0 + 0.02, 0.01, FLAT);
  put(B, box(0.04, 0.04, 0.7), IRON, 0, 2.42, z0 + 0.37, 0, 0, 0, FLAT);
  put(B, box(0.03, 0.03, 0.42), IRON, 0, 2.3, z0 + 0.2, 0, -0.5, 0, FLAT);
  put(B, cyl(0.05, 0.05, 0.03, 8), IRON, 0, 2.42, z0 + 0.73, 0, 0, Math.PI / 2, FLAT);
  // Two chains and the board, parallel to the wall so it reads from the street.
  for (const sx of [-1, 1]) put(B, box(0.015, 0.16, 0.015), IRON, sx * 0.32, 2.32, z0 + 0.56, 0, 0, 0, FLAT);
  slab(B, 0.82, 1.74, 2.2, 0.06, c.trim!, 0, z0 + 0.56, 0.02);
  slab(B, 0.76, 1.78, 2.16, 0.07, c.main!, 0, z0 + 0.56, 0.02, FLAT);
}

function namePlaque(B: GeoBuilder, c: C): void {
  const m = PIECES.name_plaque.mount!;
  const z = WALL_HALF + m.depth / 2;
  slab(B, 0.62, m.y0, m.y1, m.depth, BRASS, 0, z, 0.02, FLAT);
  slab(B, 0.56, m.y0 + 0.03, m.y1 - 0.03, m.depth + 0.008, c.main!, 0, z, 0.01, FLAT);
}

// ---------------------------------------------------------------------------
// Furnishings
// ---------------------------------------------------------------------------

function bed(B: GeoBuilder, c: C): void {
  const wood = '#8a6648';
  slab(B, 1.3, 0.1, 0.42, 2.1, wood, 0, 0, 0.05); // frame
  legs(B, 1.3, 2.1, 0.12, 0.1, shade(wood, 0.85));
  slab(B, 1.3, 0.42, 1.05, 0.1, wood, 0, -1.0, 0.05); // headboard
  slab(B, 1.3, 0.42, 0.62, 0.08, wood, 0, 1.01, 0.04); // footboard
  slab(B, 1.22, 0.4, 0.56, 1.96, CREAM, 0, 0, 0.06); // mattress
  slab(B, 1.26, 0.5, 0.6, 1.3, c.main!, 0, 0.32, 0.06); // quilt
  slab(B, 1.28, 0.52, 0.56, 0.2, c.accent!, 0, -0.35, 0.03, FLAT); // turned-down sheet
  for (const sx of [-1, 1]) slab(B, 0.5, 0.56, 0.7, 0.32, '#f2ebdc', sx * 0.3, -0.78, 0.06); // pillows
}

function sofa(B: GeoBuilder, c: C): void {
  slab(B, 1.8, 0.1, 0.42, 0.85, c.main!, 0, 0, 0.08);
  legs(B, 1.8, 0.85, 0.1, 0.08, c.trim!);
  slab(B, 1.8, 0.42, 0.85, 0.22, shade(c.main!, 0.94), 0, -0.32, 0.09); // back
  for (const sx of [-1, 1]) slab(B, 0.2, 0.42, 0.66, 0.85, shade(c.main!, 0.97), sx * 0.8, 0, 0.08); // arms
  for (const sx of [-1, 1]) slab(B, 0.68, 0.4, 0.5, 0.6, mixc(c.main!, c.accent!, 0.15), sx * 0.35, 0.08, 0.06); // cushions
  slab(B, 0.34, 0.5, 0.78, 0.12, c.accent!, -0.52, -0.18, 0.05); // throw cushion
}

function armchair(B: GeoBuilder, c: C): void {
  slab(B, 0.9, 0.1, 0.42, 0.85, c.main!, 0, 0, 0.08);
  legs(B, 0.9, 0.85, 0.1, 0.07, c.trim!);
  slab(B, 0.9, 0.42, 0.9, 0.22, shade(c.main!, 0.94), 0, -0.32, 0.09);
  for (const sx of [-1, 1]) slab(B, 0.18, 0.42, 0.66, 0.85, shade(c.main!, 0.97), sx * 0.36, 0, 0.07);
  slab(B, 0.56, 0.4, 0.5, 0.6, mixc(c.main!, c.accent!, 0.15), 0, 0.08, 0.06);
}

function stool(B: GeoBuilder, c: C): void {
  put(B, cyl(0.21, 0.21, 0.06, 12), c.main!, 0, 0.6, 0, 0, 0, 0, FLAT);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    put(B, box(0.04, 0.6, 0.04), c.trim!, Math.sin(a) * 0.14, 0.3, Math.cos(a) * 0.14, 0, Math.cos(a) * 0.1, -Math.sin(a) * 0.1, FLAT);
  }
  put(B, cyl(0.15, 0.15, 0.02, 10), c.trim!, 0, 0.22, 0, 0, 0, 0, FLAT);
}

function desk(B: GeoBuilder, c: C): void {
  const h = PIECES.desk.h;
  slab(B, 1.3, h - 0.05, h, 0.65, c.main!, 0, 0, 0.03);
  legs(B, 1.3, 0.65, h - 0.05, 0.07, c.trim!);
  slab(B, 0.45, h - 0.26, h - 0.05, 0.58, shade(c.main!, 0.95), 0.38, 0, 0.02, FLAT); // drawer unit
  put(B, sphere(0.025), BRASS, 0.38, h - 0.15, 0.3, 0, 0, 0, FLAT);
  slab(B, 0.3, h, h + 0.03, 0.22, '#efe6d2', -0.25, 0.05, 0.01, FLAT); // papers
}

function diningTable(B: GeoBuilder, c: C): void {
  const h = PIECES.dining_table.h;
  slab(B, 1.8, h - 0.06, h, 1.0, c.main!, 0, 0, 0.04);
  slab(B, 1.6, h - 0.15, h - 0.06, 0.82, c.trim!, 0, 0, 0.02, FLAT);
  legs(B, 1.8, 1.0, h - 0.06, 0.09, c.trim!);
  slab(B, 1.2, h, h + 0.01, 0.34, mixc(CREAM, c.accent!, 0.3), 0, 0, 0.005, FLAT); // runner
}

function bookshelf(B: GeoBuilder, c: C): void {
  const h = PIECES.bookshelf.h;
  slab(B, 1.2, 0, h, 0.06, shade(c.main!, 0.85), 0, -0.17, 0.02, FLAT); // back
  for (const sx of [-1, 1]) slab(B, 0.06, 0, h, 0.4, c.main!, sx * 0.57, 0, 0.02, FLAT);
  const books = ['#8a4d3e', '#55627e', '#6f7f58', '#c4a061', '#7d5a73', '#a8705a'];
  for (let k = 0; k < 4; k++) {
    const y = 0.04 + k * 0.46;
    slab(B, 1.14, y, y + 0.04, 0.38, c.trim!, 0, 0, 0.01, FLAT);
    let x = -0.5;
    let i = k * 3;
    while (x < 0.44 && k < 4) {
      const w = 0.06 + B.random() * 0.05;
      const bh = 0.24 + B.random() * 0.12;
      if (B.random() > 0.15) put(B, box(w, bh, 0.26), books[i++ % books.length]!, x + w / 2, y + 0.04 + bh / 2, 0.02, 0, 0, 0, FLAT);
      x += w + 0.01;
    }
  }
  slab(B, 1.24, h - 0.04, h + 0.02, 0.44, c.trim!, 0, 0, 0.02, FLAT);
}

function dresser(B: GeoBuilder, c: C): void {
  const h = PIECES.dresser.h;
  slab(B, 1.1, 0.08, h - 0.04, 0.5, c.main!, 0, 0, 0.04);
  legs(B, 1.1, 0.5, 0.1, 0.07, c.trim!);
  slab(B, 1.16, h - 0.05, h, 0.54, c.trim!, 0, 0, 0.02, FLAT);
  for (let k = 0; k < 3; k++) {
    const y = 0.22 + k * 0.24;
    slab(B, 1.0, y - 0.09, y + 0.09, 0.02, shade(c.main!, 1.05), 0, 0.25, 0.01, FLAT);
    for (const sx of [-1, 1]) put(B, sphere(0.022), BRASS, sx * 0.25, y, 0.27, 0, 0, 0, FLAT);
  }
}

function kitchenCounter(B: GeoBuilder, c: C): void {
  const h = PIECES.kitchen_counter.h;
  slab(B, 1.16, 0.06, h - 0.05, 0.6, c.main!, 0, -0.02, 0.03);
  slab(B, 1.2, h - 0.05, h, 0.65, c.accent!, 0, 0, 0.02, FLAT); // stone top
  slab(B, 1.12, 0, 0.08, 0.54, shade(c.trim!, 0.8), 0, -0.04, 0.01, FLAT); // plinth
  for (const sx of [-1, 1]) {
    slab(B, 0.5, 0.14, h - 0.12, 0.02, shade(c.main!, 1.04), sx * 0.28, 0.29, 0.01, FLAT);
    put(B, box(0.02, 0.12, 0.02), c.trim!, sx * 0.08, h - 0.25, 0.31, 0, 0, 0, FLAT);
  }
}

function stove(B: GeoBuilder, c: C): void {
  const h = PIECES.stove.h;
  slab(B, 0.78, 0.08, h - 0.06, 0.62, c.main!, 0, 0, 0.05);
  legs(B, 0.78, 0.62, 0.1, 0.06, c.trim!);
  slab(B, 0.82, h - 0.06, h, 0.66, shade(c.main!, 0.8), 0, 0, 0.02, FLAT);
  for (const sx of [-1, 1]) put(B, cyl(0.12, 0.12, 0.03, 10), '#2f2f31', sx * 0.18, h + 0.015, 0, 0, 0, 0, FLAT);
  slab(B, 0.44, 0.24, 0.56, 0.03, c.trim!, 0, 0.31, 0.01, FLAT); // fire door
  glow(B, 0.32, 0.2, 0.02, 0, 0.4, 0.325); // fire window
  put(B, cyl(0.06, 0.06, 0.9, 8), '#2f2f31', 0.22, h + 0.45, -0.2, 0, 0, 0, FLAT); // flue
}

function sink(B: GeoBuilder, c: C): void {
  const h = PIECES.sink.h;
  slab(B, 0.86, 0.06, h - 0.06, 0.56, c.main!, 0, -0.02, 0.03);
  slab(B, 0.9, h - 0.12, h, 0.6, '#d6d0c4', 0, 0, 0.04); // stone basin rim
  slab(B, 0.66, h - 0.1, h + 0.005, 0.4, '#a8b4b6', 0, 0.02, 0.02, FLAT); // basin / water
  put(B, cyl(0.025, 0.025, 0.28, 8), BRASS, 0, h + 0.14, -0.24, 0, 0, 0, FLAT);
  put(B, box(0.03, 0.03, 0.16), BRASS, 0, h + 0.27, -0.17, 0, 0, 0, FLAT);
  slab(B, 0.4, 0.1, 0.5, 0.02, shade(c.main!, 1.05), 0, 0.27, 0.01, FLAT); // curtain/cupboard
}

function fireplace(B: GeoBuilder, c: C): void {
  const h = PIECES.fireplace.h;
  slab(B, 1.4, 0, h, 0.4, c.main!, 0, -0.1, 0.05); // chimney breast
  slab(B, 1.5, h - 0.08, h, 0.6, c.trim!, 0, 0, 0.03); // mantel
  slab(B, 1.5, 0, 0.08, 0.64, shade(c.main!, 0.8), 0, 0.02, 0.02, FLAT); // hearth stone
  slab(B, 0.8, 0.08, 0.78, 0.04, '#2f2a27', 0, 0.12, 0.01, FLAT); // opening
  for (let k = 0; k < 3; k++) put(B, box(0.5, 0.07, 0.07), '#6b4a36', 0, 0.14 + k * 0.03, 0.1 + (k - 1) * 0.06, (k - 1) * 0.3, 0, 0, FLAT); // logs
  glow(B, 0.5, 0.2, 0.05, 0, 0.26, 0.12); // fire
  for (let k = 0; k < 3; k++) put(B, cyl(0.04, 0.05, 0.14, 6), k % 2 ? '#c4a061' : BRASS, -0.45 + k * 0.45, h + 0.07, -0.05, 0, 0, 0, FLAT); // candlesticks/ornaments
}

function bathtub(B: GeoBuilder, c: C): void {
  const h = PIECES.bathtub.h;
  put(B, rbox(1.7, 0.46, 0.8, 0.16), c.main!, 0, h - 0.26, 0, 0, 0, 0, SOFT);
  slab(B, 1.5, h - 0.08, h - 0.04, 0.6, '#b9cbd0', 0, 0, 0.02, FLAT); // water
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(B, sphere(0.06), BRASS, sx * 0.68, 0.08, sz * 0.28, 0, 0, 0, FLAT);
  put(B, cyl(0.025, 0.025, 0.3, 8), BRASS, -0.78, h + 0.1, 0, 0, 0, 0, FLAT);
}

function chest(B: GeoBuilder, c: C): void {
  const h = PIECES.chest.h;
  slab(B, 0.9, 0, h - 0.12, 0.55, c.main!, 0, 0, 0.04);
  put(B, rbox(0.92, 0.14, 0.57, 0.06), shade(c.main!, 1.04), 0, h - 0.07, 0, 0, 0, 0, SOFT);
  for (const sx of [-1, 1]) slab(B, 0.06, 0.02, h - 0.02, 0.58, IRON, sx * 0.32, 0, 0.01, FLAT);
  put(B, box(0.1, 0.12, 0.03), BRASS, 0, h - 0.18, 0.29, 0, 0, 0, FLAT);
}

function barrel(B: GeoBuilder, c: C): void {
  const h = PIECES.barrel.h;
  put(B, cyl(0.27, 0.3, h * 0.5, 12), c.main!, 0, h * 0.25, 0, 0, 0, 0, SOFT);
  put(B, cyl(0.3, 0.27, h * 0.5, 12), c.main!, 0, h * 0.75, 0, 0, 0, 0, SOFT);
  for (const y of [0.12, h / 2, h - 0.12]) put(B, cyl(0.305, 0.305, 0.04, 12), IRON, 0, y, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.26, 0.26, 0.02, 12), shade(c.main!, 0.85), 0, h, 0, 0, 0, 0, FLAT);
}

function floorLamp(B: GeoBuilder, c: C): void {
  put(B, cyl(0.16, 0.18, 0.04, 10), c.trim!, 0, 0.02, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.02, 0.02, 1.3, 6), BRASS, 0, 0.68, 0, 0, 0, 0, FLAT);
  glow(B, 0.12, 0.1, 0.12, 0, 1.36, 0);
  put(B, cyl(0.13, 0.2, 0.26, 10, true), c.main!, 0, 1.42, 0, 0, 0, 0, FLAT);
}

function tableLamp(B: GeoBuilder, c: C): void {
  put(B, cyl(0.07, 0.09, 0.2, 10), c.accent!, 0, 0.1, 0, 0, 0, 0, FLAT);
  glow(B, 0.08, 0.07, 0.08, 0, 0.25, 0);
  put(B, cyl(0.08, 0.14, 0.18, 10, true), c.main!, 0, 0.33, 0, 0, 0, 0, FLAT);
}

function plantTall(B: GeoBuilder, c: C): void {
  put(B, cyl(0.24, 0.18, 0.42, 10), c.main!, 0, 0.21, 0, 0, 0, 0, SOFT);
  put(B, cyl(0.21, 0.21, 0.02, 10), '#5a4535', 0, 0.42, 0, 0, 0, 0, FLAT);
  for (let k = 0; k < 7; k++) {
    const a = k * 2.4;
    const y = 0.7 + (k % 4) * 0.16;
    put(B, sphere(0.2 + B.random() * 0.06), k % 2 ? c.trim! : c.accent!, Math.sin(a) * 0.15, y, Math.cos(a) * 0.15, 0, 0, 0, FLAT);
  }
  put(B, box(0.03, 0.5, 0.03), '#6b5a3a', 0, 0.65, 0, 0, 0, 0, FLAT);
}

function plantSmall(B: GeoBuilder, c: C): void {
  put(B, cyl(0.12, 0.09, 0.18, 8), c.main!, 0, 0.09, 0, 0, 0, 0, FLAT);
  for (let k = 0; k < 4; k++) put(B, sphere(0.09), k % 2 ? c.trim! : c.accent!, Math.sin(k * 1.6) * 0.06, 0.25 + (k % 2) * 0.06, Math.cos(k * 1.6) * 0.06, 0, 0, 0, FLAT);
}

function wallShelf(B: GeoBuilder, c: C): void {
  const m = PIECES.wall_shelf.mount!;
  const z = WALL_HALF + m.depth / 2;
  slab(B, 1.0, m.y0 + 0.02, m.y0 + 0.06, m.depth, c.main!, 0, z, 0.01, FLAT);
  for (const sx of [-1, 1]) put(B, box(0.04, 0.16, m.depth * 0.8), c.trim!, sx * 0.4, m.y0 - 0.06, z - 0.02, 0, 0, 0, FLAT);
  put(B, cyl(0.06, 0.06, 0.16, 8), '#b8735a', -0.3, m.y0 + 0.14, z, 0, 0, 0, FLAT);
  put(B, cyl(0.05, 0.05, 0.12, 8), '#cfe0e6', -0.13, m.y0 + 0.12, z, 0, 0, 0, FLAT);
  for (let k = 0; k < 4; k++) put(B, box(0.05, 0.22, 0.16), ['#8a4d3e', '#55627e', '#6f7f58', '#c4a061'][k]!, 0.12 + k * 0.06, m.y0 + 0.17, z, 0, 0, 0, FLAT);
}

function picture(B: GeoBuilder, c: C, variant: string): void {
  const m = PIECES.picture.mount!;
  const z = WALL_HALF + m.depth / 2;
  const cy = (m.y0 + m.y1) / 2;
  slab(B, 0.8, m.y0, m.y1, m.depth, c.main!, 0, z, 0.01, FLAT); // frame
  slab(B, 0.66, m.y0 + 0.07, m.y1 - 0.07, m.depth + 0.006, '#f1e8d6', 0, z, 0.005, FLAT); // mat
  const fz = z + m.depth / 2 + 0.006;
  // A few painted shapes, flat on the canvas.
  const p = (w: number, h: number, x: number, y: number, col: ColorLike) => put(B, box(w, h, 0.004), col, x, cy + y, fz, 0, 0, 0, FLAT);
  if (variant === 'harbour') {
    p(0.56, 0.24, 0, 0.1, c.trim!);
    p(0.56, 0.2, 0, -0.12, '#6f879c');
    p(0.12, 0.08, -0.1, -0.06, c.accent!);
    p(0.02, 0.16, -0.1, 0.04, '#5c4233');
  } else if (variant === 'flowers') {
    p(0.56, 0.44, 0, 0, '#d9cdb4');
    put(B, cyl(0.06, 0.05, 0.12, 8), '#8a9ca8', 0, cy - 0.14, fz, 0, 0, 0, FLAT);
    for (let k = 0; k < 5; k++) put(B, sphere(0.045), k % 2 ? c.trim! : '#f1d27a', -0.1 + k * 0.05, cy + 0.02 + (k % 2) * 0.05, fz + 0.01, 0, 0, 0, FLAT);
  } else {
    p(0.56, 0.22, 0, 0.11, c.accent!);
    p(0.56, 0.22, 0, -0.11, c.trim!);
    p(0.2, 0.08, 0.12, 0.02, mixc(c.trim!, '#5c6a40', 0.5));
    put(B, sphere(0.04), '#f4e3a8', -0.15, cy + 0.15, fz, 0, 0, 0, FLAT);
  }
}

/** The clock's dial (the hands are separate meshes in BuildLayer, set from the world clock). */
export const CLOCK_FACE = { y: 2.34, z: WALL_HALF + 0.075, r: 0.17 } as const;
function wallClock(B: GeoBuilder, c: C): void {
  const m = PIECES.wall_clock.mount!;
  const z = WALL_HALF + m.depth / 2;
  put(B, cyl(0.22, 0.22, m.depth, 16), c.main!, 0, CLOCK_FACE.y, z, 0, Math.PI / 2, 0, SOFT);
  put(B, cyl(0.18, 0.18, 0.01, 16), '#f3ecdc', 0, CLOCK_FACE.y, z + m.depth / 2, 0, Math.PI / 2, 0, FLAT);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    put(B, box(0.012, k % 3 === 0 ? 0.04 : 0.02, 0.006), '#4a3627', Math.sin(a) * 0.145, CLOCK_FACE.y + Math.cos(a) * 0.145, z + m.depth / 2 + 0.008, 0, 0, -a, FLAT);
  }
}

function mirror(B: GeoBuilder, c: C): void {
  const m = PIECES.mirror.mount!;
  const z = WALL_HALF + m.depth / 2;
  slab(B, 0.6, m.y0, m.y1, m.depth, c.main!, 0, z, 0.02, FLAT);
  B.add('glass', box(0.48, m.y1 - m.y0 - 0.12, 0.01), new Color(0.75, 0.82, 0.86), T(0, (m.y0 + m.y1) / 2, z + m.depth / 2 + 0.004), { ao: false, jitter: 0 });
}

function curtains(B: GeoBuilder, c: C): void {
  const m = PIECES.curtains.mount!;
  const z = WALL_HALF + 0.05;
  put(B, cyl(0.02, 0.02, 1.3, 6), BRASS, 0, m.y1 - 0.04, z, 0, 0, Math.PI / 2, FLAT);
  for (const sx of [-1, 1]) {
    // Gathered drapes either side of the window: a few soft folds.
    for (let k = 0; k < 3; k++) put(B, box(0.1, m.y1 - m.y0 - 0.08, 0.05), shade(c.main!, 0.92 + k * 0.05), sx * (0.5 + k * 0.07), (m.y0 + m.y1) / 2 - 0.02, z - 0.01 + (k % 2) * 0.015, 0, 0, 0, FLAT);
    put(B, box(0.24, 0.04, 0.07), c.trim!, sx * 0.57, m.y0 + 0.45, z + 0.01, 0, 0, 0, FLAT); // tie-back
  }
}

function rugRound(B: GeoBuilder, c: C): void {
  put(B, cyl(0.8, 0.8, 0.02, 20), c.trim!, 0, 0.01, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.66, 0.66, 0.026, 20), c.main!, 0, 0.013, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.42, 0.42, 0.03, 18), c.accent!, 0, 0.015, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.2, 0.2, 0.034, 14), c.main!, 0, 0.017, 0, 0, 0, 0, FLAT);
}

function shopCounter(B: GeoBuilder, c: C): void {
  const h = PIECES.shop_counter.h;
  slab(B, 1.6, 0.06, h - 0.05, 0.56, c.main!, 0, 0.02, 0.04);
  slab(B, 1.66, h - 0.05, h, 0.62, c.trim!, 0, 0, 0.02, FLAT);
  for (let k = 0; k < 5; k++) slab(B, 0.02, 0.12, h - 0.1, 0.02, shade(c.main!, 0.85), -0.64 + k * 0.32, 0.3, 0.005, FLAT); // panelling
  put(B, cyl(0.12, 0.14, 0.18, 10), '#cfe0e6', 0.5, h + 0.09, 0, 0, 0, 0, FLAT); // jar
  slab(B, 0.3, h, h + 0.1, 0.2, BRASS, -0.4, -0.05, 0.02, FLAT); // little till
}

function recordPlayer(B: GeoBuilder, c: C): void {
  slab(B, 0.42, 0, 0.12, 0.36, c.main!, 0, 0, 0.02, FLAT);
  put(B, cyl(0.14, 0.14, 0.012, 16), '#26221f', -0.04, 0.128, 0, 0, 0, 0, FLAT);
  put(B, cyl(0.04, 0.04, 0.014, 8), '#b4644c', -0.04, 0.13, 0, 0, 0, 0, FLAT);
  put(B, box(0.02, 0.02, 0.2), BRASS, 0.14, 0.14, 0.02, 0.4, 0, 0, FLAT);
  put(B, cone(0.12, 0.2, 8), BRASS, 0.12, 0.32, -0.1, 0, -0.9, 0, FLAT); // horn
}

/** Build the geometry of a round-2 kind; false = not one of them. */
export function buildRound2(B: GeoBuilder, kind: PieceKind, c: C, variant: string, params?: string): boolean {
  switch (kind) {
    case 'house_roof':
      houseRoof(B, c, params);
      return true;
    case 'chimney':
      chimneyPiece(B, c);
      return true;
    case 'name_board':
      nameBoard(B, c);
      return true;
    case 'name_hanging':
      nameHanging(B, c);
      return true;
    case 'name_plaque':
      namePlaque(B, c);
      return true;
    case 'bed':
      bed(B, c);
      return true;
    case 'sofa':
      sofa(B, c);
      return true;
    case 'armchair':
      armchair(B, c);
      return true;
    case 'stool':
      stool(B, c);
      return true;
    case 'desk':
      desk(B, c);
      return true;
    case 'dining_table':
      diningTable(B, c);
      return true;
    case 'bookshelf':
      bookshelf(B, c);
      return true;
    case 'dresser':
      dresser(B, c);
      return true;
    case 'kitchen_counter':
      kitchenCounter(B, c);
      return true;
    case 'stove':
      stove(B, c);
      return true;
    case 'sink':
      sink(B, c);
      return true;
    case 'fireplace':
      fireplace(B, c);
      return true;
    case 'bathtub':
      bathtub(B, c);
      return true;
    case 'chest':
      chest(B, c);
      return true;
    case 'barrel':
      barrel(B, c);
      return true;
    case 'floor_lamp':
      floorLamp(B, c);
      return true;
    case 'table_lamp':
      tableLamp(B, c);
      return true;
    case 'plant_tall':
      plantTall(B, c);
      return true;
    case 'plant_small':
      plantSmall(B, c);
      return true;
    case 'wall_shelf':
      wallShelf(B, c);
      return true;
    case 'picture':
      picture(B, c, variant);
      return true;
    case 'wall_clock':
      wallClock(B, c);
      return true;
    case 'mirror':
      mirror(B, c);
      return true;
    case 'curtains':
      curtains(B, c);
      return true;
    case 'rug_round':
      rugRound(B, c);
      return true;
    case 'shop_counter':
      shopCounter(B, c);
      return true;
    case 'record_player':
      recordPlayer(B, c);
      return true;
    default:
      return false;
  }
}

/** Where the glowing bit (lamp glass, fire) of a light piece is, for halos and point lights (local y, z). */
export const GLOW_AT: Partial<Record<PieceKind, { y: number; z: number; size: number }>> = {
  lamp: { y: 1.97, z: 0, size: 1.3 },
  floor_lamp: { y: 1.38, z: 0, size: 0.9 },
  table_lamp: { y: 0.27, z: 0, size: 0.55 },
  fireplace: { y: 0.3, z: 0.2, size: 1.0 },
  stove: { y: 0.42, z: 0.36, size: 0.6 },
  // Signs are lit from just above the board (a halo on the lettering would wash it out).
  name_board: { y: 2.74, z: WALL_HALF + 0.26, size: 0.5 },
  name_hanging: { y: 2.42, z: WALL_HALF + 0.62, size: 0.42 },
  name_plaque: { y: 1.94, z: WALL_HALF + 0.18, size: 0.32 },
};
void CONFIG;
