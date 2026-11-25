/**
 * Procedural geometry kit. Every static piece of the world (architecture,
 * props, interactable bodies) is composed from soft primitives and merged by
 * material "bucket" into a handful of BufferGeometries, with colour baked into
 * vertex colours and a cheap ground-contact ambient occlusion baked in.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  type ExtrudeGeometryOptions,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { groundHeight, mulberry32, smoothstep } from '@elsewhere/shared';

export type ColorLike = string | number | Color;

const cache = new Map<string, BufferGeometry>();
function cached(key: string, make: () => BufferGeometry): BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = make();
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array((g.attributes.position as BufferAttribute).count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    cache.set(key, g);
  }
  return g;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// --- primitives (unit-ish, centred) ------------------------------------------

export function rbox(w: number, h: number, d: number, radius = 0.08, seg?: number): BufferGeometry {
  const r = Math.max(0.001, Math.min(radius, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
  // Small parts get a single bevel segment; only big, close-up forms get smoother corners.
  seg ??= Math.max(w, h, d) > 2.5 && r > 0.1 ? 2 : 1;
  return cached(`rb${r3(w)},${r3(h)},${r3(d)},${r3(r)},${seg}`, () => new RoundedBoxGeometry(w, h, d, seg, r));
}
export function cyl(rt: number, rb: number, h: number, seg = 16, open = false): BufferGeometry {
  return cached(`cy${r3(rt)},${r3(rb)},${r3(h)},${seg},${open}`, () => new CylinderGeometry(rt, rb, h, seg, 1, open));
}
export function cone(r: number, h: number, seg = 12): BufferGeometry {
  return cached(`co${r3(r)},${r3(h)},${seg}`, () => new ConeGeometry(r, h, seg));
}
export function sphere(r: number, ws = 14, hs = 10): BufferGeometry {
  return cached(`sp${r3(r)},${ws},${hs}`, () => new SphereGeometry(r, ws, hs));
}
export function ico(r: number, detail = 1): BufferGeometry {
  return cached(`ic${r3(r)},${detail}`, () => new IcosahedronGeometry(r, detail));
}
export function torus(r: number, tube: number, rs = 8, ts = 24, arc = Math.PI * 2): BufferGeometry {
  return cached(`to${r3(r)},${r3(tube)},${rs},${ts},${r3(arc)}`, () => new TorusGeometry(r, tube, rs, ts, arc));
}
/** Lathe around Y from [radius, y] pairs. */
export function lathe(key: string, pts: readonly [number, number][], seg = 24): BufferGeometry {
  return cached(`la${key},${seg}`, () => new LatheGeometry(pts.map(([x, y]) => new Vector2(x, y)), seg));
}
export function extrude(key: string, shape: () => Shape, opts: ExtrudeGeometryOptions): BufferGeometry {
  return cached(`ex${key}`, () => {
    const g = new ExtrudeGeometry(shape(), opts);
    // Centre on depth so callers place it like a box.
    g.translate(0, 0, -((opts.depth ?? 1) / 2));
    return g;
  });
}

/** Soft gable roof: a thick slab bent over a ridge, with bevelled edges. Ridge along local Z. */
export function gableRoof(width: number, rise: number, length: number, thickness = 0.28, overhang = 0.45, curve = 0.12): BufferGeometry {
  const hw = width / 2 + overhang;
  return extrude(`gable${r3(width)},${r3(rise)},${r3(length)},${r3(thickness)},${r3(overhang)},${r3(curve)}`, () => {
    const s = new Shape();
    const dropOuter = (overhang / (width / 2)) * rise;
    // Outer silhouette (slightly convex slopes), then inner offset.
    s.moveTo(-hw, -dropOuter);
    s.quadraticCurveTo(-hw * 0.5, rise * 0.5 + curve - dropOuter * 0.5, 0, rise);
    s.quadraticCurveTo(hw * 0.5, rise * 0.5 + curve - dropOuter * 0.5, hw, -dropOuter);
    s.lineTo(hw - thickness * 0.6, -dropOuter - thickness * 0.5);
    s.quadraticCurveTo(hw * 0.5, rise * 0.5 + curve - dropOuter * 0.5 - thickness, 0, rise - thickness * 1.3);
    s.quadraticCurveTo(-hw * 0.5, rise * 0.5 + curve - dropOuter * 0.5 - thickness, -hw + thickness * 0.6, -dropOuter - thickness * 0.5);
    s.closePath();
    return s;
  }, { depth: length, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.07, bevelSegments: 2, curveSegments: 10 });
}

/** Solid gable infill (the triangular wall under a gable roof). Ridge along Z, centred. */
export function gableWall(width: number, rise: number, thick: number): BufferGeometry {
  return extrude(`gwall${r3(width)},${r3(rise)},${r3(thick)}`, () => {
    const s = new Shape();
    s.moveTo(-width / 2, 0);
    s.lineTo(width / 2, 0);
    s.lineTo(0, rise);
    s.closePath();
    return s;
  }, { depth: thick, bevelEnabled: false });
}

/** Arched window/door panel shape (rounded top), extruded along Z. */
export function archPanel(w: number, h: number, depth: number, bevel = 0.03): BufferGeometry {
  return extrude(`arch${r3(w)},${r3(h)},${r3(depth)},${r3(bevel)}`, () => {
    const s = new Shape();
    const r = w / 2;
    s.moveTo(-r, 0);
    s.lineTo(r, 0);
    s.lineTo(r, h - r);
    s.absarc(0, h - r, r, 0, Math.PI, false);
    s.lineTo(-r, 0);
    return s;
  }, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 12 });
}

/** Ring with an arched opening — window/door frame. */
export function archFrame(w: number, h: number, frame: number, depth: number): BufferGeometry {
  return extrude(`archf${r3(w)},${r3(h)},${r3(frame)},${r3(depth)}`, () => {
    const s = new Shape();
    const R = w / 2 + frame;
    s.moveTo(-R, -frame * 0.5);
    s.lineTo(R, -frame * 0.5);
    s.lineTo(R, h - w / 2);
    s.absarc(0, h - w / 2, R, 0, Math.PI, false);
    s.lineTo(-R, -frame * 0.5);
    const hole = new Shape();
    const r = w / 2;
    hole.moveTo(-r, 0);
    hole.lineTo(-r, h - r);
    hole.absarc(0, h - r, r, Math.PI, 0, true);
    hole.lineTo(r, 0);
    hole.lineTo(-r, 0);
    s.holes.push(hole);
    return s;
  }, { depth, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 12 });
}

// --- transforms --------------------------------------------------------------

const _e = new Euler();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
export function T(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = sx, sz = sx): Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// --- builder -----------------------------------------------------------------

export interface AddOpts {
  /** Bake ground-contact darkening (default true). */
  ao?: boolean;
  /** Random brightness jitter amplitude (default 0.04). */
  jitter?: number;
  /** Vertical gradient: darken bottom by this much relative to top of the part. */
  grad?: number;
}

const _c = new Color();
const _v = new Vector3();

export class GeoBuilder {
  private parts = new Map<string, BufferGeometry[]>();
  private stack: Matrix4[] = [new Matrix4()];
  private rnd: () => number;
  /** Ids of interactables this builder drew (coverage check). */
  readonly represented = new Set<string>();

  constructor(seed = 1) {
    this.rnd = mulberry32(seed);
  }

  random(): number {
    return this.rnd();
  }

  get matrix(): Matrix4 {
    return this.stack[this.stack.length - 1]!;
  }

  push(m: Matrix4): this {
    this.stack.push(this.matrix.clone().multiply(m));
    return this;
  }
  pop(): this {
    if (this.stack.length > 1) this.stack.pop();
    return this;
  }
  /** Run fn inside a pushed transform. */
  at(m: Matrix4, fn: () => void): this {
    this.push(m);
    try {
      fn();
    } finally {
      this.pop();
    }
    return this;
  }

  add(bucket: string, geo: BufferGeometry, color: ColorLike, local?: Matrix4, opts: AddOpts = {}): this {
    const g = geo.clone();
    const m = local ? this.matrix.clone().multiply(local) : this.matrix;
    g.applyMatrix4(m);
    const pos = g.attributes.position as BufferAttribute;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    _c.set(color as Color);
    const jitter = opts.jitter ?? 0.04;
    const j = 1 + (this.rnd() * 2 - 1) * jitter;
    const ao = opts.ao ?? true;
    let minY = Infinity;
    let maxY = -Infinity;
    if (opts.grad) for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    for (let i = 0; i < n; i++) {
      let f = j;
      if (ao) {
        _v.fromBufferAttribute(pos, i);
        const gy = groundHeight(_v.x, _v.z);
        const dy = _v.y - gy;
        f *= 0.62 + 0.38 * smoothstep(-0.05, 0.85, dy);
      }
      if (opts.grad && maxY > minY) f *= 1 - opts.grad * (1 - (pos.getY(i) - minY) / (maxY - minY));
      col[i * 3] = _c.r * f;
      col[i * 3 + 1] = _c.g * f;
      col[i * 3 + 2] = _c.b * f;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
    let list = this.parts.get(bucket);
    if (!list) this.parts.set(bucket, (list = []));
    list.push(g);
    return this;
  }

  /** Raw-colour add (no AO/jitter) — e.g. window glass where colour channels encode data. */
  addRaw(bucket: string, geo: BufferGeometry, rgb: [number, number, number], local?: Matrix4): this {
    const g = geo.clone();
    g.applyMatrix4(local ? this.matrix.clone().multiply(local) : this.matrix);
    const n = (g.attributes.position as BufferAttribute).count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(rgb, i * 3);
    g.setAttribute('color', new BufferAttribute(col, 3));
    let list = this.parts.get(bucket);
    if (!list) this.parts.set(bucket, (list = []));
    list.push(g);
    return this;
  }

  /** Add geometry with explicit UV rectangle remap (for atlas-textured faces). */
  addUV(bucket: string, geo: BufferGeometry, uvRect: [number, number, number, number], local?: Matrix4): this {
    const g = geo.clone();
    g.applyMatrix4(local ? this.matrix.clone().multiply(local) : this.matrix);
    const uv = g.attributes.uv as BufferAttribute;
    const [u0, v0, u1, v1] = uvRect;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    const n = uv.count;
    const col = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new BufferAttribute(col, 3));
    let list = this.parts.get(bucket);
    if (!list) this.parts.set(bucket, (list = []));
    list.push(g);
    return this;
  }

  build(): Map<string, BufferGeometry> {
    const out = new Map<string, BufferGeometry>();
    for (const [bucket, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (merged) {
        merged.computeBoundingSphere();
        merged.computeBoundingBox();
        out.set(bucket, merged);
      }
    }
    this.parts.clear();
    return out;
  }
}

/** Unit quad facing +Z (for atlas sign faces). */
export function quad(w: number, h: number): BufferGeometry {
  return cached(`qd${r3(w)},${r3(h)}`, () => {
    const g = new BufferGeometry();
    const hw = w / 2;
    const hh = h / 2;
    g.setAttribute('position', new BufferAttribute(new Float32Array([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, -hh, 0, hw, hh, 0, -hw, hh, 0]), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
    return g;
  });
}
