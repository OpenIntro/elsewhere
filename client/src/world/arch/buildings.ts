/**
 * The buildings of The Commons, one designer per style, all sharing the kit's
 * visual language: stone plinths, soft rounded walls, trims, framed windows
 * with shutters and flower boxes, tile-coursed roofs, chimneys with smoke.
 * Footprints match the shared BUILDINGS colliders exactly; decorative bits
 * that stick out stay small (trims, sills, awnings overhead).
 * Walk-in buildings (`enterable`) are built as hollow shells with interiors
 * in ./walkin.ts + ./furniture.ts; the designers here draw the closed ones.
 */
import { Matrix4 } from 'three';
import { type Building, terrainHeight } from '@elsewhere/shared';
import { archFrame, box, cone, cyl, gableWall, quad, rbox, sphere, T, torus, type GeoBuilder } from '../geom.js';
import { signUV } from '../signs.js';
import {
  anchors,
  awning,
  barrel,
  chimney,
  crate,
  doorway,
  flowerBox,
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
} from './kit.js';
import { buildWalkIn } from './walkin.js';

function plinth(B: GeoBuilder, w: number, d: number, h = 0.4, color = P.stoneMid): void {
  B.add('solid', rbox(w + 0.36, h + 0.5, d + 0.36, 0.12), color, T(0, h / 2 - 0.25, 0), { grad: 0.25 });
  // stone course blocks along the top edge
  B.add('solid', rbox(w + 0.44, 0.1, d + 0.44, 0.04), shade(color, 1.08), T(0, h, 0));
}

function walls(B: GeoBuilder, w: number, h: number, d: number, color: string, y0: number): void {
  B.add('solid', rbox(w, h, d, 0.16, 3), color, T(0, y0 + h / 2, 0), { grad: 0.12 });
}

function cornerPosts(B: GeoBuilder, w: number, h: number, d: number, color: string, y0: number, size = 0.26): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(size, h, size, 0.06), color, T((sx * w) / 2, y0 + h / 2, (sz * d) / 2));
}

function quoins(B: GeoBuilder, w: number, h: number, d: number, color: string, y0: number): void {
  const n = Math.floor(h / 0.5);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (let i = 0; i < n; i++) {
        const big = i % 2 === 0;
        B.add('solid', rbox(big ? 0.62 : 0.4, 0.42, 0.2, 0.06), color, T((sx * w) / 2 - sx * (big ? 0.2 : 0.1), y0 + 0.25 + i * 0.5, (sz * d) / 2 + sz * 0.02));
        B.add('solid', rbox(0.2, 0.42, big ? 0.4 : 0.62, 0.06), color, T((sx * w) / 2 + sx * 0.02, y0 + 0.25 + i * 0.5, (sz * d) / 2 - sz * (big ? 0.1 : 0.2)));
      }
}

function beltCourse(B: GeoBuilder, w: number, d: number, y: number, color: string, t = 0.14): void {
  B.add('solid', rbox(w + 0.12, t, d + 0.12, 0.05), color, T(0, y, 0));
}

function siding(B: GeoBuilder, w: number, h: number, d: number, color: string, y0: number, spacing = 0.32, vertical = false): void {
  const dk = shade(color, 0.86);
  if (vertical) {
    for (const face of ['front', 'back', 'left', 'right'] as Face[]) {
      const len = face === 'front' || face === 'back' ? w : d;
      const n = Math.floor(len / spacing);
      for (let i = 1; i < n; i++) {
        const u = -len / 2 + i * spacing;
        B.add('solid', box(0.035, h - 0.2, 0.03), dk, onFace(face, w, d, u, y0 + h / 2, 0).multiply(T(0, 0, 0.005)), { jitter: 0.02 });
      }
    }
    return;
  }
  const n = Math.floor(h / spacing);
  for (let i = 1; i < n; i++) {
    const y = y0 + i * spacing;
    B.add('solid', box(w + 0.03, 0.035, d + 0.03), dk, T(0, y, 0), { jitter: 0.015 });
  }
}

function placeAt(B: GeoBuilder, b: Building, fn: (y0: number) => void): void {
  const y = terrainHeight(b.position.x, b.position.z);
  B.at(T(b.position.x, y, b.position.z, b.yaw), () => fn(y));
}

function sign(B: GeoBuilder, key: string, w: number, m: ReturnType<typeof T>, frame: string = P.woodDark, both = false): void {
  B.at(m, () => signBoard(B, key, w, w / 4, signUV(key), quad, frame, both));
}

// ---------------------------------------------------------------------------
// Café — cream walls over a teal wainscot, big shop windows, striped awning, terracotta tiles.
// ---------------------------------------------------------------------------
function cafe(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.35;
    plinth(B, w, d, y0);
    walls(B, w, h - y0, d, b.wallColor, y0);
    const teal = '#4f6f66';
    B.add('solid', rbox(w + 0.08, 1.0, d + 0.08, 0.1), teal, T(0, y0 + 0.5, 0));
    beltCourse(B, w, d, y0 + 1.02, P.trim, 0.1);
    cornerPosts(B, w, h - y0, d, P.trim, y0, 0.22);
    beltCourse(B, w, d, h - 0.05, P.trim, 0.2);
    // front: two shop windows + door
    for (const s of [-1, 1]) {
      B.at(onFace('front', w, d, s * 2.35, y0 + 0.95), () => {
        windowUnit(B, 2.1, 1.75, { frame: teal, mullions: 'grid', sill: true, lit: 1 });
        // café curtain rod + half-curtain
        B.add('solid', rbox(2.0, 0.42, 0.04, 0.02), '#efe4cf', T(0, 0.35, 0.03));
      });
    }
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 1.15, 2.25, { frame: teal, color: '#4f6f66', style: 'glass', hood: null }));
    // awning above windows/door
    B.at(onFace('front', w, d, 0, 0), () => awning(B, w - 0.6, h - 0.55, 1.35, '#b0563d', '#efe3cf', 0.55));
    sign(B, 'cafe', 2.2, onFace('front', w, d, 0, h + 0.55, 0.12), '#2f4a44');
    // sides & back: arched shuttered windows
    for (const face of ['left', 'right'] as Face[]) {
      for (const u of [-1.3, 1.3]) B.at(onFace(face, w, d, u, y0 + 1.25), () => windowUnit(B, 0.85, 1.5, { arched: true, shutters: '#6d8b7f', flowers: true }));
    }
    for (const u of [-2.4, 0, 2.4]) B.at(onFace('back', w, d, u, y0 + 1.3), () => windowUnit(B, 0.8, 1.2, { shutters: '#6d8b7f' }));
    // roof: ridge along X
    B.at(T(0, h, 0, Math.PI / 2), () => {
      roof(B, { span: d, rise: 2.1, length: w + 0.9, color: b.roofColor, tiles: 'scallop', courses: 7, overhang: 0.55 });
      gableEnds(B, d, 2.1, w, b.wallColor);
    });
    // round gable windows
    for (const s of [-1, 1]) B.at(T(s * (w / 2 + 0.02), h + 0.75, 0, (s * Math.PI) / 2), () => windowUnit(B, 0.7, 0.7, { round: true, frame: P.trim, lit: 0.8 }));
    chimney(B, 2.4, h + 0.6, -1.2, 1.9, '#a8705a');
    // potted bay trees flanking the door
    for (const s of [-1, 1]) {
      B.add('solid', cyl(0.26, 0.2, 0.42, 12), '#b5704f', T(s * 1.05, 0.21, d / 2 + 0.38));
      B.add('solid', cyl(0.04, 0.04, 0.5, 6), P.woodDark, T(s * 1.05, 0.65, d / 2 + 0.38));
      B.add('plant', sphere(0.34, 12, 9), P.leaf, T(s * 1.05, 1.05, d / 2 + 0.38), { grad: 0.3 });
    }
    // bicycle-ish bench under side window? → a little bistro bench against the right wall
    B.at(onFace('right', w, d, 0, 0, 0.35), () => {
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
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.3;
    plinth(B, w, d, y0, P.stoneDark);
    walls(B, w, h - y0, d, b.wallColor, y0);
    siding(B, w, h - y0, d, b.wallColor, y0, 0.3);
    cornerPosts(B, w, h - y0, d, '#efe6d2', y0, 0.24);
    // false front
    const ff = '#e3d3b2';
    B.add('solid', rbox(w + 0.3, 2.0, 0.32, 0.08), ff, T(0, h + 0.75, d / 2 - 0.02), { ao: false });
    B.add('solid', rbox(3.2, 0.7, 0.32, 0.08), ff, T(0, h + 2.0, d / 2 - 0.02), { ao: false });
    B.add('solid', rbox(w + 0.5, 0.16, 0.44, 0.05), P.trim, T(0, h + 1.78, d / 2), { ao: false });
    B.add('solid', rbox(3.4, 0.14, 0.44, 0.05), P.trim, T(0, h + 2.38, d / 2), { ao: false });
    B.add('solid', sphere(0.14, 10, 8), P.trim, T(0, h + 2.55, d / 2));
    sign(B, 'store', 4.4, onFace('front', w, d, 0, h + 0.95, 0.18), '#5f6f5a');
    // display windows
    for (const s of [-1, 1]) {
      B.at(onFace('front', w, d, s * 2.45, y0 + 0.75), () => {
        windowUnit(B, 2.2, 1.65, { frame: '#5f6f5a', mullions: 'vertical', lit: 1 });
        // goods on display shelf behind glass edge
        B.add('solid', rbox(2.1, 0.3, 0.18, 0.03), P.woodDark, T(0, -0.25, 0.12));
      });
    }
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 1.25, 2.3, { frame: '#5f6f5a', color: '#6f5440', style: 'glass' }));
    B.at(onFace('front', w, d, 0, 0), () => awning(B, w - 0.4, h - 0.45, 1.25, '#5f6f5a', '#eee5d0', 0.5));
    // board porch
    for (let i = 0; i < 9; i++) B.add('solid', rbox(w + 0.6, 0.06, 0.22, 0.02), shade(P.woodLight, 0.92 + (i % 3) * 0.04), T(0, 0.03, d / 2 + 0.14 + i * 0.23), { jitter: 0.04 });
    for (const face of ['left', 'right'] as Face[]) B.at(onFace(face, w, d, 0.6, y0 + 1.2), () => windowUnit(B, 1.0, 1.25, { shutters: '#5f6f5a', flowers: face === 'right' }));
    for (const u of [-2.2, 2.2]) B.at(onFace('back', w, d, u, y0 + 1.2), () => windowUnit(B, 0.9, 1.1, {}));
    B.at(T(0, h, -0.15), () => {
      roof(B, { span: w, rise: 1.6, length: d + 0.6, color: b.roofColor, tiles: 'strips', overhang: 0.4 });
      gableEnds(B, w, 1.6, d + 0.2, b.wallColor);
    });
    stovepipe(B, -2.6, h + 0.5, -1.8, 1.6);
  });
}

// ---------------------------------------------------------------------------
// Town Hall — pale stone civic hall with portico, pediment, pavilion roof and a
// clock + bell tower at the front-right corner (above the bell rope).
// ---------------------------------------------------------------------------
function hall(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.55;
    plinth(B, w, d, y0, P.stoneMid);
    walls(B, w, h - y0, d, b.wallColor, y0);
    quoins(B, w, h - y0, d, '#c8bca6', y0);
    beltCourse(B, w, d, y0 + 2.35, '#c8bca6', 0.16);
    beltCourse(B, w, d, h - 0.1, '#efe7d6', 0.3);
    B.add('solid', rbox(w + 0.5, 0.16, d + 0.5, 0.06), '#c8bca6', T(0, h + 0.08, 0));
    // steps up to the door
    for (let i = 0; i < 3; i++) B.add('solid', rbox(4.6 - i * 0.5, 0.2, 0.5, 0.06), shade(P.stone, 1 - i * 0.03), T(0, 0.1 + i * 0.17, d / 2 + 0.95 - i * 0.35));
    // portico: 4 columns + entablature + pediment
    const colX = [-2.5, -0.85, 0.85, 2.5];
    const ch = h - 0.4;
    for (const x of colX) {
      B.add('solid', rbox(0.7, 0.3, 0.7, 0.06), P.stone, T(x, y0 + 0.15, d / 2 - 0.05));
      B.add('solid', cyl(0.24, 0.28, ch - y0 - 0.6, 16), '#efe8da', T(x, y0 + 0.3 + (ch - y0 - 0.6) / 2, d / 2 - 0.05));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        B.add('solid', rbox(0.04, ch - y0 - 0.8, 0.04, 0.015), '#ddd4c2', T(x + Math.cos(a) * 0.25, y0 + 0.3 + (ch - y0 - 0.6) / 2, d / 2 - 0.05 + Math.sin(a) * 0.25));
      }
      B.add('solid', rbox(0.66, 0.3, 0.66, 0.08), P.stone, T(x, ch - 0.15, d / 2 - 0.05));
    }
    B.add('solid', rbox(6.6, 0.5, 0.9, 0.08), '#e8e0cf', T(0, ch + 0.25, d / 2 - 0.05), { ao: false });
    // portico gable projecting from the façade: pediment + cornice
    B.at(T(0, ch + 0.5, d / 2 + 0.05), () => {
      roof(B, { span: 6.8, rise: 1.45, length: 1.1, color: b.roofColor, tiles: 'strips', overhang: 0.3, thickness: 0.24, curve: 0.02, courses: 5 });
    });
    B.add('solid', gableTri(6.6, 1.38), '#e8e0cf', T(0, ch + 0.5, d / 2 + 0.52));
    B.at(T(0, ch + 0.95, d / 2 + 0.62), () => windowUnit(B, 0.62, 0.62, { round: true, frame: '#c8bca6', lit: 0.9 }));
    // door
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 1.7, 2.75, { frame: '#c8bca6', color: '#5a4636', double: true, style: 'panel', arched: true, step: false }));
    sign(B, 'hall', 2.6, onFace('front', w, d, 0, y0 + 3.25, 0.05), '#c8bca6');
    // tall arched windows (avoid the tower corner)
    for (const u of [-5.0, -3.6, 3.6]) {
      if (u > 2.9) continue;
      B.at(onFace('front', w, d, u, y0 + 0.9), () => windowUnit(B, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid', lit: 0.85 }));
    }
    for (const u of [-3.6, -1.2, 1.2, 3.6]) B.at(onFace('back', w, d, u, y0 + 0.9), () => windowUnit(B, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid', lit: 0.7 }));
    for (const u of [-2.4, 0, 2.4]) {
      B.at(onFace('left', w, d, u, y0 + 0.9), () => windowUnit(B, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid', lit: 0.7 }));
      if (u < 0.5) B.at(onFace('right', w, d, u - 1.4, y0 + 0.9), () => windowUnit(B, 0.9, 2.2, { arched: true, frame: '#efe7d6', mullions: 'grid', lit: 0.7 }));
    }
    B.at(T(0, h + 0.15, 0), () => pavilionRoof(B, w, d, 3.6, b.roofColor, 0.45));
    // cupola-free roof: two chimneys
    chimney(B, -4.2, h + 0.8, -2.2, 1.6, '#b9ad98', true);

    // ---------------- tower ----------------
    const tw = b.tower!;
    const s = tw.size;
    const tx = 4.65;
    const tz = d / 2 - s / 2 + 0.12;
    const th = tw.height;
    B.at(T(tx, 0, tz), () => {
      B.add('solid', rbox(s + 0.3, y0 + 0.5, s + 0.3, 0.1), P.stoneMid, T(0, y0 / 2 - 0.25, 0));
      const by = 7.25;
      B.add('solid', rbox(s, by - y0, s, 0.14, 3), '#e3d9c7', T(0, y0 + (by - y0) / 2, 0), { grad: 0.1 });
      quoins(B, s, by - y0 - 0.4, s, '#c8bca6', y0);
      beltCourse(B, s, s, h - 0.1, '#efe7d6', 0.3);
      beltCourse(B, s, s, 7.15, '#efe7d6', 0.22);
      beltCourse(B, s, s, th - 0.1, '#efe7d6', 0.3);
      // tall narrow windows in the shaft
      B.at(onFace('front', s, s, 0, 1.4), () => windowUnit(B, 0.55, 1.4, { arched: true, frame: '#efe7d6', mullions: 'vertical', lit: 0.5 }));
      B.at(onFace('right', s, s, 0, 1.4), () => windowUnit(B, 0.55, 1.4, { arched: true, frame: '#efe7d6', mullions: 'vertical', lit: 0.5 }));
      // clock faces (front + right)
      for (const face of ['front', 'right', 'left'] as Face[]) {
        B.at(onFace(face, s, s, 0, 6.25, 0.02), () => {
          B.add('solid', cyl(0.95, 0.95, 0.12, 28), '#efe7d6', T(0, 0, 0.04, 0, Math.PI / 2), { ao: false });
          B.add('solid', torus(0.92, 0.08, 8, 32), P.brass, T(0, 0, 0.1), { ao: false });
          B.add('solid', cyl(0.8, 0.8, 0.05, 28), '#f7f1e3', T(0, 0, 0.11, 0, Math.PI / 2), { ao: false });
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            B.add('solid', rbox(0.06, k % 3 === 0 ? 0.2 : 0.12, 0.03, 0.01), '#4a4148', T(Math.sin(a) * 0.66, Math.cos(a) * 0.66, 0.14, 0, 0, -a), { ao: false });
          }
          anchors.clock.push(B.matrix.clone().multiply(T(0, 0, 0.16)));
        });
      }
      // belfry: open arches on 4 sides with posts
      const bh = th - by - 0.2;
      B.add('solid', rbox(s - 0.1, 0.2, s - 0.1, 0.06), '#d8cdb9', T(0, by + 0.1, 0));
      for (const face of ['front', 'back', 'left', 'right'] as Face[]) {
        B.at(onFace(face, s, s, 0, by + 0.2, -0.18), () => {
          B.add('solid', archFrame(1.55, bh - 0.35, 0.42, 0.34), '#e3d9c7', T(0, 0, 0));
          B.add('solid', rbox(1.7, 0.12, 0.4, 0.04), '#efe7d6', T(0, 0.02, 0.05));
        });
      }
      // hollow look: dark inner box visible through arches is the window bucket; columns at corners
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(0.55, bh, 0.55, 0.08), '#e3d9c7', T((sx * s) / 2 - sx * 0.27, by + bh / 2, (sz * s) / 2 - sz * 0.27));
      B.add('solid', rbox(s + 0.4, 0.3, s + 0.4, 0.1), '#efe7d6', T(0, th, 0), { ao: false });
      // spire
      B.add('solid', cone(s * 0.62 * Math.SQRT2 * 0.5 + 0.9, 3.0, 4), b.roofColor, T(0, th + 1.65, 0, Math.PI / 4), { ao: false, grad: 0.15 });
      B.add('solid', sphere(0.22, 10, 8), P.brass, T(0, th + 3.2, 0), { ao: false });
      B.add('solid', cyl(0.03, 0.03, 0.9, 6), P.iron, T(0, th + 3.7, 0), { ao: false });
      anchors.spinners.push({ matrix: worldMatrix(B, 0, th + 3.95, 0), kind: 'vane', speed: 0.2, size: 1 });
      // bell (dynamic): hangs in the belfry
      anchors.bell = worldMatrix(B, 0, by + bh - 0.35, 0);
      B.add('solid', rbox(s - 0.6, 0.14, 0.18, 0.04), P.woodDark, T(0, by + bh - 0.2, 0));
    });
    // bell rope from the tower down to the rope post (the bell interactable spot)
    const top = worldPoint(B, tx, 7.2, d / 2 + 0.25);
    void top;
    B.add('solid', cyl(0.025, 0.025, 7.2 - 1.3, 6), '#c9b18a', T(tx, 1.3 + (7.2 - 1.3) / 2, d / 2 + 0.55, 0, -0.1));
    // flower beds along the front
    for (const s2 of [-1, 1]) {
      B.at(T(s2 * 4.9, 0, d / 2 + 0.7), () => {
        if (s2 > 0) return;
        B.add('solid', rbox(2.6, 0.3, 0.7, 0.1), P.stone, T(0, 0.15, 0));
        B.add('solid', rbox(2.4, 0.06, 0.55, 0.03), P.soil, T(0, 0.31, 0));
        B.at(T(0, 0.3, 0), () => flowerPatch(B, 2.2, 0.45, 16, ['#e7a0a6', '#f4efe6', '#b9a2d8']));
      });
    }
  });
}

function gableTri(w: number, h: number) {
  return gableWall(w, h, 0.2);
}
function worldMatrix(B: GeoBuilder, x: number, y: number, z: number): Matrix4 {
  return B.matrix.clone().multiply(T(x, y, z));
}

// ---------------------------------------------------------------------------
// Workshop — timber barn with corrugated roof, big double doors, gear emblem.
// ---------------------------------------------------------------------------
function workshop(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.25;
    plinth(B, w, d, y0, P.stoneDark);
    walls(B, w, h - y0, d, b.wallColor, y0);
    siding(B, w, h - y0, d, b.wallColor, y0, 0.34, true);
    const beam = '#5e4636';
    cornerPosts(B, w, h - y0, d, beam, y0, 0.3);
    beltCourse(B, w, d, y0 + 0.1, beam, 0.2);
    beltCourse(B, w, d, h - 0.1, beam, 0.24);
    // diagonal braces on side walls
    for (const face of ['left', 'right', 'back'] as Face[]) {
      const len = face === 'back' ? w : d;
      for (const s of [-1, 1]) B.at(onFace(face, w, d, (s * len) / 3.2, y0 + (h - y0) / 2, 0.02), () => B.add('solid', rbox(0.16, (h - y0) * 1.15, 0.08, 0.03), beam, T(0, 0, 0, 0, 0, s * 0.55)));
    }
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 2.8, 3.05, { frame: beam, color: '#8a5a3c', double: true, style: 'barn', step: false }));
    // gear emblem above door (dynamic spinner) + sign
    anchors.spinners.push({ matrix: worldMatrix(B, 0, h + 0.85, d / 2 + 0.15), kind: 'gear', speed: 0.35, size: 0.75 });
    sign(B, 'workshop', 2.4, onFace('front', w, d, 0, h - 0.5, 0.08), beam);
    for (const u of [-3.25, 3.25]) B.at(onFace('front', w, d, u, y0 + 1.1), () => windowUnit(B, 1.3, 1.3, { frame: beam, mullions: 'grid', lit: 0.9 }));
    for (const u of [-1.6, 1.6]) {
      B.at(onFace('left', w, d, u, y0 + 1.2), () => windowUnit(B, 1.2, 1.2, { frame: beam, mullions: 'grid' }));
      B.at(onFace('right', w, d, u, y0 + 1.2), () => windowUnit(B, 1.2, 1.2, { frame: beam, mullions: 'grid' }));
    }
    // roof (ridge along Z, gable over the big doors) + hay-loft door in the gable
    B.at(T(0, h, 0), () => {
      roof(B, { span: w, rise: 2.5, length: d + 0.7, color: b.roofColor, tiles: 'ribs', overhang: 0.5, curve: 0.25 });
      gableEnds(B, w, 2.5, d + 0.3, mix(b.wallColor, '#7a5c48', 0.3).getStyle());
      B.add('solid', rbox(1.1, 1.0, 0.1, 0.04), '#8a5a3c', T(0, 0.75, d / 2 + 0.12));
      B.add('solid', rbox(0.12, 0.12, 1.4, 0.04), beam, T(0, 1.55, d / 2 + 0.5));
      B.add('solid', cyl(0.05, 0.05, 0.12, 8), P.iron, T(0, 1.45, d / 2 + 1.1, 0, Math.PI / 2));
      // skylights
      for (const z of [-1.5, 1.5]) B.addRaw('window', rbox(0.9, 0.05, 1.1, 0.02), [0.8, 0.4, 0], T(-1.8, 1.25, z, 0, 0, 0.62));
    });
    stovepipe(B, 2.6, h + 0.9, -2.0, 2.0);
    // tool wall (left of the doors): pegboard with silhouettes
    B.at(onFace('front', w, d, 3.25, y0 + 2.35, 0.03), () => {
      B.add('solid', rbox(1.4, 0.55, 0.05, 0.02), '#c9a87c', T(0, 0, 0));
      B.add('solid', rbox(0.06, 0.45, 0.04, 0.01), P.iron, T(-0.45, 0, 0.05));
      B.add('solid', rbox(0.3, 0.06, 0.04, 0.01), P.iron, T(-0.45, 0.18, 0.05));
      B.add('solid', torus(0.13, 0.03, 6, 12), P.iron, T(0.05, 0, 0.05));
      B.add('solid', rbox(0.5, 0.08, 0.04, 0.01), '#a8705a', T(0.4, 0.05, 0.05, 0, 0, 0.4));
    });
    // little windmill on the ridge (spinner)
    anchors.spinners.push({ matrix: worldMatrix(B, -2.8, h + 2.2, 0.5), kind: 'windmill', speed: 1.4, size: 0.7 });
    B.add('solid', cyl(0.04, 0.05, 1.0, 6), P.iron, T(-2.8, h + 1.55, 0.3));
  });
}

// ---------------------------------------------------------------------------
// Cottages — five individual houses.
// ---------------------------------------------------------------------------
const COTTAGE_VARIANTS = [
  { roof: 'steep', shutters: '#8a5a48', door: '#7a3f36', trim: '#f2e9d8', chimneyX: 1.8, porch: false, timber: true, flowers: '#e7a0a6' },
  { roof: 'pavilion', shutters: '#5f7c74', door: '#3f5a52', trim: '#f2ede2', chimneyX: -1.6, porch: true, timber: false, flowers: '#f1d27a' },
  { roof: 'thatch', shutters: '#7d6a4a', door: '#6a5236', trim: '#efe3c8', chimneyX: 2.0, porch: false, timber: false, flowers: '#b9a2d8' },
  { roof: 'gambrel', shutters: '#6b5568', door: '#5a4458', trim: '#f3ece6', chimneyX: -2.0, porch: false, timber: true, flowers: '#f4efe6' },
  { roof: 'saltbox', shutters: '#58697a', door: '#3e4f60', trim: '#eef1f2', chimneyX: 1.5, porch: true, timber: false, flowers: '#9fc0e8' },
] as const;

function cottage(B: GeoBuilder, b: Building, n: number): void {
  const v = COTTAGE_VARIANTS[(n - 1) % COTTAGE_VARIANTS.length]!;
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.32;
    plinth(B, w, d, y0, P.stoneMid);
    walls(B, w, h - y0, d, b.wallColor, y0);
    cornerPosts(B, w, h - y0, d, v.trim, y0, 0.2);
    beltCourse(B, w, d, h - 0.05, v.trim, 0.16);
    if (v.timber) {
      const beam = '#6a4f3e';
      beltCourse(B, w, d, y0 + 1.25, beam, 0.12);
      for (const face of ['front', 'back', 'left', 'right'] as Face[]) {
        const len = face === 'front' || face === 'back' ? w : d;
        for (const u of [-len / 2 + 0.9, len / 2 - 0.9]) B.at(onFace(face, w, d, u, y0 + 1.25 + (h - y0 - 1.25) / 2, 0.01), () => B.add('solid', rbox(0.12, h - y0 - 1.3, 0.06, 0.02), beam));
      }
    }
    // front: door + two windows
    const roundDoor = n === 1 || n === 3;
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 1.05, 2.0, { frame: v.trim, color: v.door, style: roundDoor ? 'round' : 'plank', arched: roundDoor, hood: v.porch ? null : shade(b.roofColor, 0.95) }));
    for (const s of [-1, 1]) B.at(onFace('front', w, d, s * 1.85, y0 + 0.95), () => windowUnit(B, 0.95, 1.15, { shutters: v.shutters, flowers: true, frame: v.trim }));
    for (const face of ['left', 'right'] as Face[]) B.at(onFace(face, w, d, 0, y0 + 1.0), () => windowUnit(B, 0.9, 1.1, { shutters: v.shutters, frame: v.trim, flowers: face === 'left' }));
    B.at(onFace('back', w, d, 1.2, y0 + 1.0), () => windowUnit(B, 0.9, 1.0, { frame: v.trim }));
    // house number plaque
    sign(B, `house${n}`, 0.6, onFace('front', w, d, -0.95, y0 + 2.2, 0.06), v.trim);
    if (b.futureHome) {
      // "a future home": a little hand-painted board hung on the door
      B.at(onFace('front', w, d, 0, y0 + 1.45, 0.1), () => {
        B.add('solid', cyl(0.006, 0.006, 0.36, 3), '#6a4f3e', T(-0.16, 0.3, 0, 0, 0, -0.5), { ao: false });
        B.add('solid', cyl(0.006, 0.006, 0.36, 3), '#6a4f3e', T(0.16, 0.3, 0, 0, 0, 0.5), { ao: false });
        signBoard(B, 'future_home', 0.78, 0.26, signUV('future_home'), quad, '#6a4f3e', false);
      });
    }
    if (v.porch) {
      // little porch roof on posts (posts within the footprint edge)
      B.add('solid', rbox(2.6, 0.12, 1.0, 0.05), shade(b.roofColor, 0.95), T(0, h - 0.35, d / 2 + 0.42, 0, 0.16), { ao: false });
      for (const s of [-1, 1]) B.add('solid', cyl(0.06, 0.06, h - 0.55, 8), v.trim, T(s * 1.15, (h - 0.55) / 2, d / 2 + 0.82));
    }
    // roofs
    const rc = b.roofColor;
    if (v.roof === 'steep') {
      B.at(T(0, h, 0, Math.PI / 2), () => {
        roof(B, { span: d, rise: 2.6, length: w + 0.7, color: rc, tiles: 'scallop', overhang: 0.5, curve: 0.1, courses: 8 });
        gableEnds(B, d, 2.6, w, b.wallColor);
      });
      // front dormer
      B.at(T(0, h + 0.45, d / 2 - 0.55), () => {
        B.add('solid', rbox(1.3, 1.0, 1.1, 0.08), b.wallColor, T(0, 0.35, 0));
        B.at(T(0, 0.85, 0), () => roof(B, { span: 1.3, rise: 0.6, length: 1.3, color: rc, tiles: 'none', overhang: 0.18, thickness: 0.16 }));
        B.at(T(0, 0.0, 0.56), () => windowUnit(B, 0.6, 0.6, { frame: v.trim, sill: false }));
      });
    } else if (v.roof === 'pavilion') {
      B.at(T(0, h, 0), () => pavilionRoof(B, w, d, 2.2, rc, 0.45));
      B.at(T(0, h + 0.3, d / 2 - 0.25), () => {
        B.add('solid', rbox(1.2, 0.9, 0.8, 0.08), b.wallColor, T(0, 0.35, 0));
        B.at(T(0, 0.8, 0), () => roof(B, { span: 1.2, rise: 0.55, length: 1.0, color: rc, tiles: 'none', overhang: 0.15, thickness: 0.15 }));
        B.at(T(0, 0.05, 0.41), () => windowUnit(B, 0.55, 0.55, { frame: v.trim, sill: false }));
      });
    } else if (v.roof === 'thatch') {
      B.at(T(0, h - 0.1, 0), () => {
        roof(B, { span: w, rise: 2.3, length: d + 0.9, color: rc, tiles: 'strips', overhang: 0.7, curve: 0.45, thickness: 0.55, courses: 6 });
        gableEnds(B, w, 2.3, d + 0.2, b.wallColor);
      });
      // bay window on the front-left
      B.at(onFace('front', w, d, -1.85, y0 + 0.4, 0.35), () => {
        B.add('solid', rbox(1.5, 1.2, 0.7, 0.12), b.wallColor, T(0, 0.6, -0.2));
        B.add('solid', rbox(1.7, 0.16, 0.85, 0.06), v.trim, T(0, 1.25, -0.15));
      });
    } else if (v.roof === 'gambrel') {
      B.at(T(0, h, 0), () => {
        // lower steep skirt + upper shallow cap
        B.add('solid', rbox(w + 0.7, 1.3, d + 0.7, 0.2), rc, T(0, 0.55, 0, 0, 0, 0, 1, 1, 1), { ao: false, grad: 0.15 });
        B.at(T(0, 1.15, 0, Math.PI / 2), () => roof(B, { span: d + 0.4, rise: 1.2, length: w + 0.7, color: shade(rc, 1.05), tiles: 'strips', overhang: 0.25, curve: 0.08 }));
        for (const s of [-1, 1]) B.at(T(0, 0.55, s * (d / 2 + 0.36)), () => B.add('solid', rbox(w - 0.8, 0.9, 0.08, 0.04), b.wallColor, T(0, 0, 0)));
        B.at(T(0, 0.25, d / 2 + 0.4), () => windowUnit(B, 0.9, 0.7, { frame: v.trim, shutters: v.shutters, sill: false }));
      });
    } else {
      // saltbox: asymmetric — long back slope
      B.at(T(0, h, 0), () => {
        B.at(T(0, 0, 0, Math.PI / 2), () => {
          roof(B, { span: d, rise: 2.0, length: w + 0.7, color: rc, tiles: 'strips', overhang: 0.45, curve: 0.1 });
          gableEnds(B, d, 2.0, w, b.wallColor);
        });
        B.add('solid', rbox(w + 0.6, 0.25, 2.2, 0.08), shade(rc, 0.95), T(0, -0.55, -d / 2 - 0.4, 0, 0.5), { ao: false });
      });
    }
    chimney(B, v.chimneyX, h + 0.4, -0.8, v.roof === 'gambrel' ? 2.6 : 2.0, n % 2 ? '#a8705a' : '#9a8f84');
    for (const s of [-1, 1]) {
      B.at(T(s * 2.3, 0, d / 2 + 0.75), () => {
        B.add('solid', rbox(1.5, 0.16, 0.6, 0.06), P.soil, T(0, 0.06, 0));
        flowerPatch(B, 1.3, 0.45, 9, [v.flowers, P.petals[(n + 2) % P.petals.length]!, '#f4efe6']);
      });
    }
    // a personal touch per house
    if (n === 2) B.at(T(-2.5, 0, d / 2 + 2.3), () => shrub(B, 0.55, P.leaf, 6));
    if (n === 5) B.at(T(-2.5, 0, d / 2 + 2.3), () => shrub(B, 0.5, '#7f9a5c', 4));
    // back garden shrubs
    for (const s of [-1, 1]) B.at(T(s * 2.2, 0, -d / 2 - 0.8), () => shrub(B, 0.6 + B.random() * 0.2, P.leaf, n % 2 ? 3 : 0));
    flowerBox(B, 0.01); // keeps RNG streams stable across variants
  });
}

export function birdbath(B: GeoBuilder): void {
  B.add('solid', cyl(0.18, 0.24, 0.12, 12), P.stone, T(0, 0.06, 0));
  B.add('solid', cyl(0.09, 0.12, 0.7, 10), P.stone, T(0, 0.45, 0));
  B.add('solid', cyl(0.42, 0.24, 0.16, 16), P.stone, T(0, 0.86, 0));
  B.add('glazed', cyl(0.36, 0.36, 0.02, 16), '#7fb7bb', T(0, 0.93, 0));
}

export function wheelbarrow(B: GeoBuilder): void {
  B.add('solid', rbox(0.7, 0.32, 0.9, 0.08), '#6b7f86', T(0, 0.45, 0));
  B.add('solid', torus(0.18, 0.05, 6, 14), P.iron, T(0, 0.2, 0.5, Math.PI / 2));
  for (const s of [-1, 1]) {
    B.add('solid', rbox(0.05, 0.05, 0.9, 0.02), P.wood, T(s * 0.25, 0.45, -0.55, 0, -0.15));
    B.add('solid', rbox(0.05, 0.3, 0.05, 0.02), P.wood, T(s * 0.25, 0.15, -0.2));
  }
  B.add('plant', sphere(0.22, 8, 6), P.leaf, T(0, 0.62, 0.05));
  B.add('solid', sphere(0.08, 6, 5), '#e98a6b', T(0.1, 0.78, 0.1), { ao: false });
}

// ---------------------------------------------------------------------------
// Boathouse — weathered blue planks on stilts by the shore.
// ---------------------------------------------------------------------------
function boathouse(B: GeoBuilder, b: Building): void {
  placeAt(B, b, () => {
    const { width: w, depth: d, height: h } = b;
    const y0 = 0.25;
    plinth(B, w, d, y0, P.stoneDark);
    walls(B, w, h - y0, d, b.wallColor, y0);
    siding(B, w, h - y0, d, b.wallColor, y0, 0.28, true);
    cornerPosts(B, w, h - y0, d, '#e8e4d8', y0, 0.22);
    beltCourse(B, w, d, h - 0.05, '#e8e4d8', 0.16);
    B.at(onFace('front', w, d, 0, y0), () => doorway(B, b.doorId, 1.9, 2.3, { frame: '#e8e4d8', color: '#3f4e57', double: true, style: 'barn', step: false }));
    sign(B, 'boathouse', 2.0, onFace('front', w, d, 0, h - 0.3, 0.06), '#3f4e57');
    for (const face of ['left', 'right'] as Face[]) B.at(onFace(face, w, d, 0, y0 + 1.2), () => windowUnit(B, 0.9, 0.9, { round: true, frame: '#e8e4d8', lit: 0.5 }));
    B.at(T(0, h, 0), () => {
      roof(B, { span: w, rise: 1.8, length: d + 0.6, color: b.roofColor, tiles: 'strips', overhang: 0.45 });
      gableEnds(B, w, 1.8, d + 0.2, b.wallColor);
    });
    // life ring, oars, net
    B.at(onFace('left', w, d, 1.6, y0 + 1.4, 0.06), () => {
      B.add('solid', torus(0.32, 0.09, 10, 20), '#e98a6b', T(0, 0, 0));
      for (let k = 0; k < 4; k++) B.add('solid', torus(0.32, 0.095, 10, 4, 0.4), '#f4efe6', T(0, 0, 0, 0, 0, (k / 4) * Math.PI * 2));
    });
    B.at(onFace('right', w, d, 1.5, 0, 0.15), () => {
      for (const s of [-1, 1]) {
        B.add('solid', rbox(0.06, 2.0, 0.04, 0.02), P.woodLight, T(s * 0.2, 1.0, 0, 0, 0, s * 0.12));
        B.add('solid', rbox(0.18, 0.5, 0.04, 0.03), P.woodLight, T(s * 0.32, 0.25, 0, 0, 0, s * 0.12));
      }
    });
    B.at(onFace('back', w, d, 0, 0, 0.3), () => {
      crate(B, 0.55, '#8fa3a8');
      B.at(T(0.8, 0, 0.1), () => barrel(B, 0.3, 0.7, '#6b7f86'));
    });
  });
}

export function buildBuilding(B: GeoBuilder, b: Building, interior?: GeoBuilder): void {
  if (b.enterable) return buildWalkIn(B, b, interior ?? B);
  switch (b.style) {
    case 'cafe':
      return cafe(B, b);
    case 'store':
      return store(B, b);
    case 'hall':
      return hall(B, b);
    case 'workshop':
      return workshop(B, b);
    case 'cottage':
      return cottage(B, b, Number(b.id.split('_')[1] ?? 1));
    case 'boathouse':
      return boathouse(B, b);
  }
}
