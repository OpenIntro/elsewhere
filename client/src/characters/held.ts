/**
 * Small carried props keyed by item id (procedural, vertex-coloured, cached).
 * Unknown ids fall back to a wrapped parcel. Origin = where the hand grips.
 */
import { Color, LatheGeometry, Vector2, type BufferGeometry } from 'three';
import { ITEMS } from '@elsewhere/shared';
import { GeoBuilder, T, capsule, cylinder, roundedBox, shadeColor, sphere, torus } from './geometry.js';

type ItemBuilder = (b: GeoBuilder, color: Color) => void;

const c = (hex: string) => new Color(hex);

export const HELD_BUILDERS: Record<string, ItemBuilder> = {
  apple(b, col) {
    b.add(sphere('mid'), 0, T(0, 0.075, 0, 0, 0, 0, 0.078, 0.07, 0.078), col, { gloss: 0.6, shade: 0.25 });
    b.add(capsule(0.007, 0.03, 5), 0, T(0, 0.15, 0, 0, 0, 0.25), c('#6a4a30'));
    b.add(sphere('lo'), 0, T(0.025, 0.155, 0, 0, 0, -0.6, 0.03, 0.012, 0.018), c('#7fae5c'), { gloss: 0.3 });
  },
  wrench(b, col) {
    b.add(capsule(0.016, 0.16, 6), 0, T(0, 0.08, 0), col, { gloss: 0.7 });
    b.add(torus(0.035, 0.016, Math.PI * 1.45, 6, 12), 0, T(0, 0.2, 0, 0, 0, -Math.PI * 0.22), col, { gloss: 0.7 });
    b.add(capsule(0.02, 0.06, 6), 0, T(0, 0.02, 0), c('#b0463a'), { gloss: 0.2 });
  },
  wildflower(b, col) {
    b.add(capsule(0.007, 0.18, 5), 0, T(0, 0.09, 0), c('#6f9a4f'));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.add(sphere('lo'), 0, T(Math.cos(a) * 0.03, 0.2, Math.sin(a) * 0.03, 0, -a, 0, 0.032, 0.012, 0.02), col, { shade: 0.05 });
    }
    b.add(sphere('lo'), 0, T(0, 0.205, 0, 0, 0, 0, 0.018), c('#f2cd5c'), { gloss: 0.3 });
    b.add(sphere('lo'), 0, T(0.03, 0.09, 0, 0, 0, -0.7, 0.035, 0.012, 0.02), c('#7fae5c'));
  },
  smooth_pebble(b, col) {
    b.add(sphere('mid'), 0, T(0, 0.04, 0, 0, 0.4, 0, 0.065, 0.035, 0.05), col, { gloss: 0.35, shade: 0.3 });
  },
  pinecone(b, col) {
    for (let i = 0; i < 5; i++) {
      const r = 0.045 * Math.sin(((i + 0.7) / 5.4) * Math.PI);
      b.add(sphere('lo'), 0, T(0, 0.03 + i * 0.028, 0, 0, i * 0.7, 0, r + 0.012, 0.022, r + 0.012), shadeColor(col, 0.85 + i * 0.05), { shade: 0.3 });
    }
  },
  seashell(b, col) {
    for (let i = -2; i <= 2; i++) b.add(sphere('lo'), 0, T(i * 0.018, 0.06, 0, 0, 0, i * 0.28, 0.022, 0.06, 0.018), shadeColor(col, 1 - Math.abs(i) * 0.05), { gloss: 0.4, shade: 0.2 });
    b.add(sphere('lo'), 0, T(0, 0.01, 0, 0, 0, 0, 0.025, 0.015, 0.016), shadeColor(col, 0.85));
  },
  paper_lantern(b, col) {
    const pts: Vector2[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      pts.push(new Vector2(Math.sin(a) * 0.06 + 0.005, -Math.cos(a) * 0.075));
    }
    b.add(new LatheGeometry(pts, 12), 0, T(0, 0.02, 0), col, { shade: 0.1 });
    for (const y of [-0.07, 0.11]) b.add(cylinder(0.03, 0.03, 0.015, 10), 0, T(0, y + 0.02, 0), c('#5a3a2a'));
    b.add(torus(0.035, 0.005, Math.PI, 4, 10), 0, T(0, 0.13, 0), c('#5a3a2a'));
  },
  parcel(b) {
    const kraft = c('#c49a6c');
    const twine = c('#efe4cf');
    b.add(roundedBox(0.16, 0.12, 0.13, 0.025), 0, T(0, 0.06, 0), kraft, { shade: 0.2 });
    b.add(roundedBox(0.165, 0.125, 0.02, 0.008), 0, T(0, 0.06, 0), twine);
    b.add(roundedBox(0.02, 0.125, 0.135, 0.008), 0, T(0, 0.06, 0), twine);
    for (const s of [1, -1]) b.add(sphere('lo'), 0, T(s * 0.022, 0.13, 0, 0, 0, s * 0.5, 0.025, 0.014, 0.012), twine);
  },
};

const cache = new Map<string, BufferGeometry>();

export function heldGeometry(id: string): BufferGeometry {
  const key = Object.prototype.hasOwnProperty.call(HELD_BUILDERS, id) ? id : 'parcel';
  let g = cache.get(key);
  if (!g) {
    const b = new GeoBuilder();
    const def = (ITEMS as Record<string, { color: string } | undefined>)[id];
    HELD_BUILDERS[key]!(b, new Color(def?.color ?? '#c49a6c'));
    g = b.build(false);
    g.computeBoundingSphere();
    cache.set(key, g);
  }
  return g;
}
