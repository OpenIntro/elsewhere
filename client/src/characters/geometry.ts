/**
 * Procedural part builder: accumulates many small smooth primitives into ONE
 * vertex-coloured, rigidly-skinned BufferGeometry.
 *
 * Per-vertex attributes: position, normal, color (linear), skinIndex/skinWeight
 * (rigid), `gloss` (0 = matte clay, 1 = glossy paint; read by the toy material).
 */
import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  LatheGeometry,
  Matrix3,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  CylinderGeometry,
  Vector2,
  Vector3,
  Euler,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface PartOptions {
  /** Glossiness 0..1. */
  gloss?: number;
  /** Baked bottom-to-top darkening (fake AO) amount, default 0.14. */
  shade?: number;
}

const _v = new Vector3();
const _n = new Vector3();
const _nm = new Matrix3();

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private skin: number[] = [];
  private gl: number[] = [];
  private idx: number[] = [];
  private bones: Matrix4[];
  /** Track max world Y per tag (e.g. hair top) for stacking accessories. */
  maxY = -Infinity;

  constructor(boneWorld: Matrix4[] = [new Matrix4()]) {
    this.bones = boneWorld;
  }

  /**
   * Add a geometry skinned to `bone`. `m` is the part transform in the space of
   * `space` (defaults to `bone`), i.e. vertex = boneWorld[space] · m · v.
   */
  add(g: BufferGeometry, bone: number, m: Matrix4, color: Color, opts: PartOptions = {}, space = bone): this {
    const world = new Matrix4().multiplyMatrices(this.bones[space] ?? this.bones[0]!, m);
    _nm.getNormalMatrix(world);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const base = this.pos.length / 3;
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const h = Math.max(1e-6, bb.max.y - bb.min.y);
    const shade = opts.shade ?? 0.14;
    const gloss = opts.gloss ?? 0;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      const t = (_v.y - bb.min.y) / h;
      _v.applyMatrix4(world);
      if (_v.y > this.maxY) this.maxY = _v.y;
      _n.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      const f = (1 - shade * (1 - t)) * (1 - 0.1 * Math.max(0, -_n.y));
      this.col.push(color.r * f, color.g * f, color.b * f);
      this.skin.push(bone);
      this.gl.push(gloss);
    }
    const index = g.getIndex();
    // Mirrored transforms flip winding; fix it so front faces stay front.
    const flip = world.determinant() < 0;
    const count = index ? index.count : p.count;
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      if (flip) this.idx.push(base + a, base + c, base + b);
      else this.idx.push(base + a, base + b, base + c);
    }
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(skinned = true): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('gloss', new BufferAttribute(new Float32Array(this.gl), 1));
    if (skinned) {
      const n = this.skin.length;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        si[i * 4] = this.skin[i]!;
        sw[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new BufferAttribute(sw, 4));
    }
    const n = this.pos.length / 3;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    return g;
  }
}

// ---------------------------------------------------------------------------
// Transform helpers
// ---------------------------------------------------------------------------

const _q = new Quaternion();
const _e = new Euler();

/** Compose translate · rotate(XYZ euler) · scale. */
export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new Matrix4().compose(new Vector3(x, y, z), _q.clone(), new Vector3(sx, sy, sz));
}

/** Place a part at `pos` oriented so its local +Z points along `normal` (keeps local +Y roughly up), then apply local transform. */
export function onSurface(pos: readonly number[], normal: readonly number[], local: Matrix4 = new Matrix4()): Matrix4 {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(normal[0], normal[1], normal[2]).normalize());
  return new Matrix4().compose(new Vector3(pos[0], pos[1], pos[2]), q, new Vector3(1, 1, 1)).multiply(local);
}

// ---------------------------------------------------------------------------
// Primitive cache (unit-ish shapes reused across builds)
// ---------------------------------------------------------------------------

const prim = new Map<string, BufferGeometry>();
// ---------------------------------------------------------------------------
// Detail levels (same silhouettes, fewer segments). Set for the duration of a build.
// ---------------------------------------------------------------------------

export type Detail = 'high' | 'medium' | 'low';
export const DETAILS: readonly Detail[] = ['high', 'medium', 'low'];
let DETAIL: Detail = 'high';
export function currentDetail(): Detail {
  return DETAIL;
}
export function withDetail<T>(d: Detail, fn: () => T): T {
  const prev = DETAIL;
  DETAIL = d;
  try {
    return fn();
  } finally {
    DETAIL = prev;
  }
}
/** Pick a value per detail level. */
export function byDetail<T>(high: T, medium: T, low: T): T {
  return DETAIL === 'high' ? high : DETAIL === 'medium' ? medium : low;
}

function cached(rawKey: string, make: () => BufferGeometry): BufferGeometry {
  const key = `${DETAIL}:${rawKey}`;
  let g = prim.get(key);
  if (!g) {
    g = make();
    prim.set(key, g);
  }
  return g;
}

/** Unit sphere (radius 1). Detail: 'hi' | 'mid' | 'lo'. */
export function sphere(detail: 'hi' | 'mid' | 'lo' = 'mid'): BufferGeometry {
  const [w, h] =
    detail === 'hi' ? byDetail([28, 18], [18, 12], [12, 8]) : detail === 'mid' ? byDetail([12, 9], [10, 7], [7, 5]) : byDetail([8, 6], [7, 5], [5, 4]);
  return cached(`sphere-${detail}`, () => new SphereGeometry(1, w, h));
}

/** Partial sphere (theta from the top). */
export function sphereCap(thetaLength: number, detail: 'hi' | 'mid' = 'mid'): BufferGeometry {
  const [w, h] = detail === 'hi' ? byDetail([26, 9], [18, 6], [12, 4]) : byDetail([16, 6], [12, 5], [9, 3]);
  return cached(`cap-${thetaLength.toFixed(3)}-${detail}`, () => new SphereGeometry(1, w, h, 0, Math.PI * 2, 0, thetaLength));
}

/** Capsule along Y, centred, radius r, straight length len. */
export function capsule(r: number, len: number, radial = 8): BufferGeometry {
  const rad = byDetail(radial, Math.max(6, radial - 2), Math.max(5, radial - 3));
  const capSeg = byDetail(3, 2, 2);
  return cached(`caps-${r.toFixed(4)}-${len.toFixed(4)}-${radial}`, () => new CapsuleGeometry(r, len, capSeg, rad));
}

/** Torus in the XY plane. */
export function torus(r: number, tube: number, arc = Math.PI * 2, radial = 6, tubular = 18): BufferGeometry {
  // tubular 4 = deliberate square rim; keep it.
  const rad = byDetail(radial, Math.max(4, radial - 1), Math.max(3, radial - 2));
  const tub = tubular <= 4 ? tubular : byDetail(tubular, Math.max(6, Math.round(tubular * 0.75)), Math.max(5, Math.round(tubular * 0.55)));
  return cached(`torus-${r.toFixed(4)}-${tube.toFixed(4)}-${arc.toFixed(3)}-${radial}-${tubular}`, () => new TorusGeometry(r, tube, rad, tub, arc));
}

export function cylinder(rt: number, rb: number, h: number, radial = 14): BufferGeometry {
  const rad = byDetail(radial, Math.max(8, Math.round(radial * 0.75)), Math.max(6, Math.round(radial * 0.55)));
  return cached(`cyl-${rt.toFixed(4)}-${rb.toFixed(4)}-${h.toFixed(4)}-${radial}`, () => new CylinderGeometry(rt, rb, h, rad, 1, false));
}

export function roundedBox(w: number, h: number, d: number, r: number): BufferGeometry {
  const seg = byDetail(2, 2, 1);
  return cached(`rbox-${w}-${h}-${d}-${r}`, () => new RoundedBoxGeometry(w, h, d, seg, r));
}

/** Lathe from (radius, y) pairs, smoothed with a Catmull-Rom pass. */
export function lathe(key: string, pts: readonly (readonly [number, number])[], segmentsHigh = 18, samplesHigh = 2): BufferGeometry {
  const segments = byDetail(segmentsHigh, Math.max(12, Math.round(segmentsHigh * 0.75)), Math.max(10, Math.round(segmentsHigh * 0.55)));
  const samples = byDetail(samplesHigh, samplesHigh, 1);
  return cached(`lathe-${key}`, () => {
    const out: Vector2[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
      for (let s = 0; s < samples; s++) {
        const t = s / samples;
        const t2 = t * t;
        const t3 = t2 * t;
        const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push(new Vector2(Math.max(0, cr(p0[0], p1[0], p2[0], p3[0])), cr(p0[1], p1[1], p2[1], p3[1])));
      }
    }
    const last = pts[pts.length - 1]!;
    out.push(new Vector2(last[0], last[1]));
    return new LatheGeometry(out, segments);
  });
}

/** Superellipse lathe "mochi" head of radii (rx, ry), exponent n, centred at origin. */
export function superHead(rx: number, ry: number, n: number): BufferGeometry {
  return cached(`head-${rx}-${ry}-${n}`, () => {
    const pts: Vector2[] = [];
    const steps = byDetail(20, 14, 10);
    for (let i = 0; i <= steps; i++) {
      // parameter angle from bottom (-pi/2) to top (pi/2)
      const a = -Math.PI / 2 + (Math.PI * i) / steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const y = ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      pts.push(new Vector2(Math.max(0, x), y));
    }
    return new LatheGeometry(pts, byDetail(30, 22, 16));
  });
}

function superProfile(rx: number, ry: number, n: number, steps: number): Vector2[] {
  const pts: Vector2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / steps;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pts.push(new Vector2(Math.max(0, rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / n)), ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)));
  }
  return pts;
}

export interface HairlineSpec {
  /** Hairline height (in units of the head's y radius, -1..1) at the front, the sides and the back. */
  front: number;
  side: number;
  back: number;
  /** Shell thickness as a fraction of the head radius. */
  thick: number;
  /** Extra volume towards the bottom of the shell (bobs, long hair). */
  bulk?: number;
  /** Width of the bevelled edge (v units). */
  edge?: number;
}

const ss = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Hairline height at azimuth phi (0 = front). */
export function hairlineAt(h: HairlineSpec, phi: number): number {
  const t = Math.abs(phi) / Math.PI;
  // The front level holds across the face (~±50°) before dropping to the sides: an open toy-like face window.
  return t < 0.5 ? h.front + (h.side - h.front) * ss((t * 2 - 0.3) / 0.7) : h.side + (h.back - h.side) * ss((t - 0.5) * 2);
}

/**
 * Molded hair "shell": a cap whose bottom row lies exactly on a smooth
 * hairline, with a rolled lip tucked into the head, so the edge is clean at any
 * zoom (no jagged surface intersection). Columns run from the hairline to the
 * crown along the head's superellipse profile.
 */
export function hairShell(rx: number, ry: number, n: number, h: HairlineSpec): BufferGeometry {
  const key = `shell2-${rx}-${ry}-${n}-${h.front}-${h.side}-${h.back}-${h.thick}-${h.bulk ?? 0}`;
  return cached(key, () => {
    const COLS = byDetail(40, 28, 20);
    const ROWS = byDetail(14, 9, 6);
    const pt = (phi: number, a: number, out: number) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      const r = rx * Math.pow(Math.max(0, c), 2 / n);
      const y = ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      return [Math.sin(phi) * r * out, y * out, Math.cos(phi) * r * out] as const;
    };
    const thickAt = (v: number) => h.thick + (h.bulk ?? 0) * Math.min(1, Math.max(0, (0.5 - v) / 1.3));
    const pos: number[] = [];
    const idx: number[] = [];
    // rows: 0 = tucked lip inside the skin, 1 = lip outer edge, 2..ROWS = body up to just below the crown
    const RINGS = ROWS + 2;
    for (let i = 0; i < COLS; i++) {
      const phi = -Math.PI + (i / COLS) * Math.PI * 2;
      const v0 = Math.max(-0.97, Math.min(0.95, hairlineAt(h, phi)));
      const a0 = Math.asin(Math.sign(v0) * Math.pow(Math.abs(v0), n / 2));
      const aTop = Math.PI / 2 - 0.02;
      for (let r = 0; r < RINGS; r++) {
        let a: number;
        let out: number;
        if (r === 0) {
          a = a0 - 0.02;
          out = 0.965;
        } else if (r === 1) {
          a = a0 - 0.012;
          out = 1 + thickAt(v0) * 0.55;
        } else {
          const t = (r - 1) / (RINGS - 2);
          a = a0 + 0.02 + (aTop - a0 - 0.02) * t;
          const v = Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 2 / n);
          out = 1 + thickAt(v);
        }
        pos.push(...pt(phi, a, out));
      }
    }
    const crown = COLS * RINGS;
    pos.push(0, ry * (1 + thickAt(1)), 0);
    for (let i = 0; i < COLS; i++) {
      const i2 = (i + 1) % COLS;
      for (let r = 0; r < RINGS - 1; r++) {
        const a = i * RINGS + r;
        const b = i2 * RINGS + r;
        const c = i2 * RINGS + r + 1;
        const d = i * RINGS + r + 1;
        idx.push(a, b, d, b, c, d);
      }
      idx.push(i * RINGS + RINGS - 1, i2 * RINGS + RINGS - 1, crown);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}

export const tmpColor = (hex: string) => new Color(hex);

/** Mix two colours (hex or Color) → new Color. */
export function mix(a: Color | string, b: Color | string, t: number): Color {
  const ca = typeof a === 'string' ? new Color(a) : a.clone();
  const cb = typeof b === 'string' ? new Color(b) : b;
  return ca.lerp(cb, t);
}

export function shadeColor(c: Color | string, f: number): Color {
  const cc = typeof c === 'string' ? new Color(c) : c.clone();
  return cc.multiplyScalar(f);
}
