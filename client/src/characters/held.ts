/**
 * Small carried props keyed by item id (procedural, vertex-coloured, cached).
 * Unknown ids fall back to a wrapped parcel. Origin = where the hand grips.
 */
import { Color, LatheGeometry, Vector2, type BufferGeometry } from 'three';
import { ITEMS } from '@elsewhere/shared';
import { GeoBuilder, T, capsule, cylinder, roundedBox, shadeColor, sphere, torus } from './geometry.js';

type ItemBuilder = (b: GeoBuilder, color: Color) => void;

const c = (hex: string) => new Color(hex);

/** A small handled cup: body colour, drink colour, radius, height. */
function cup(b: GeoBuilder, col: Color, drink: Color, r: number, h: number): void {
  b.add(cylinder(r, r * 0.86, h, 14), 0, T(0, h / 2, 0), col, { gloss: 0.55, shade: 0.12 });
  b.add(cylinder(r * 0.88, r * 0.88, 0.006, 14), 0, T(0, h - 0.008, 0), drink, { gloss: 0.7 });
  b.add(torus(r * 0.42, 0.007, Math.PI * 1.2, 5, 10), 0, T(r * 1.02, h * 0.5, 0, 0, 0, -Math.PI * 0.6), col, { gloss: 0.55 });
}

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
  // --- Café drinks (steam is drawn by the activities layer) ---
  cup_coffee: (b, col) => cup(b, col, c('#3a2418'), 0.05, 0.075),
  cup_tea: (b, col) => cup(b, col, c('#b07a3a'), 0.052, 0.07),
  cup_cocoa: (b, col) => cup(b, col, c('#6b3d26'), 0.062, 0.085),
  cup_special: (b, col) => {
    cup(b, col, c('#d8b98a'), 0.048, 0.08);
    b.add(sphere('lo'), 0, T(0, 0.1, 0, 0, 0, 0, 0.032, 0.018, 0.032), c('#f4efe6'), { shade: 0.1 });
  },
  // --- General Store curiosities ---
  postcard(b, col) {
    b.add(roundedBox(0.16, 0.11, 0.008, 0.004), 0, T(0, 0.06, 0), col, { shade: 0.1 });
    b.add(roundedBox(0.07, 0.05, 0.01, 0.003), 0, T(-0.035, 0.07, 0.002), c('#7fa0b4'));
    b.add(roundedBox(0.03, 0.035, 0.012, 0.003), 0, T(0.055, 0.085, 0.002), c('#b0563d'));
  },
  brass_key(b, col) {
    b.add(torus(0.028, 0.009, Math.PI * 2, 6, 12), 0, T(0, 0.14, 0), col, { gloss: 0.8 });
    b.add(capsule(0.008, 0.1, 5), 0, T(0, 0.07, 0), col, { gloss: 0.8 });
    b.add(roundedBox(0.03, 0.012, 0.01, 0.003), 0, T(0.015, 0.03, 0), col, { gloss: 0.8 });
    b.add(roundedBox(0.022, 0.012, 0.01, 0.003), 0, T(0.012, 0.05, 0), col, { gloss: 0.8 });
  },
  tin_whistle(b, col) {
    b.add(cylinder(0.012, 0.012, 0.22, 8), 0, T(0, 0.11, 0), col, { gloss: 0.8 });
    b.add(cylinder(0.014, 0.014, 0.04, 8), 0, T(0, 0.22, 0), c('#3e3b3a'));
    for (let i = 0; i < 4; i++) b.add(sphere('lo'), 0, T(0, 0.05 + i * 0.03, 0.011, 0, 0, 0, 0.004), c('#3e3b3a'));
  },
  glass_marble(b, col) {
    b.add(sphere('mid'), 0, T(0, 0.04, 0, 0, 0, 0, 0.04), col, { gloss: 0.9, shade: 0.1 });
    b.add(sphere('lo'), 0, T(0.01, 0.05, 0.02, 0, 0, 0, 0.012), c('#ffffff'), { gloss: 0.9 });
  },
  ribbon(b, col) {
    b.add(cylinder(0.04, 0.04, 0.035, 14), 0, T(0, 0.04, 0, Math.PI / 2), col, { shade: 0.15 });
    b.add(cylinder(0.012, 0.012, 0.04, 8), 0, T(0, 0.04, 0, Math.PI / 2), c('#f4efe6'));
    b.add(roundedBox(0.03, 0.08, 0.004, 0.002), 0, T(0.02, -0.005, 0.02, 0, 0, 0.3), col);
  },
  seed_packet(b, col) {
    b.add(roundedBox(0.09, 0.13, 0.014, 0.004), 0, T(0, 0.07, 0), col, { shade: 0.1 });
    b.add(sphere('lo'), 0, T(0, 0.08, 0.008, 0, 0, 0, 0.022, 0.022, 0.006), c('#f1d27a'));
  },
  spinning_top(b, col) {
    b.add(sphere('mid'), 0, T(0, 0.06, 0, 0, 0, 0, 0.05, 0.035, 0.05), col, { gloss: 0.5 });
    b.add(cylinder(0.01, 0.002, 0.04, 6), 0, T(0, 0.02, 0), c('#6a4a30'));
    b.add(cylinder(0.008, 0.008, 0.05, 6), 0, T(0, 0.11, 0), c('#6a4a30'));
    b.add(torus(0.05, 0.006, Math.PI * 2, 4, 16), 0, T(0, 0.06, 0, Math.PI / 2), c('#efe4cf'));
  },
  pressed_leaf(b, col) {
    b.add(sphere('lo'), 0, T(0, 0.08, 0, 0, 0, 0, 0.05, 0.075, 0.006), col, { shade: 0.15 });
    b.add(capsule(0.003, 0.12, 4), 0, T(0, 0.06, 0.004), c('#8a6a3a'));
  },
  candle_stub(b, col) {
    b.add(cylinder(0.028, 0.03, 0.07, 12), 0, T(0, 0.035, 0), col, { shade: 0.1 });
    b.add(capsule(0.003, 0.015, 4), 0, T(0, 0.08, 0), c('#3e3b3a'));
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
