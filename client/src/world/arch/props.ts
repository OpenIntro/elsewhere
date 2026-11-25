/**
 * Static bodies for every interactable, prop and deck in the shared data.
 * `buildInteractable` is an exhaustive switch over InteractableKind, and every
 * call records the id in `B.represented`, so World can verify (dev) that each
 * INTERACTABLES entry has a visible object at its data position.
 * Dynamic parts (door leaves, bell, bulbs, pickups, runes glow, fountain
 * water, portal) are anchored here or rendered by their own systems.
 */
import {
  DECKS,
  PROPS,
  STANDING_STONES,
  archPillars,
  groundHeight,
  terrainHeight,
  type Deck,
  type Interactable,
  type LightInteractable,
  type Prop,
} from '@elsewhere/shared';
import { cone, cyl, ico, quad, rbox, sphere, T, torus, type GeoBuilder } from '../geom.js';
import { signUV } from '../signs.js';
import { anchors, barrel, crate, flowerPatch, lanternCage, lanternPost, P, shade, shrub, signBoard, streetlamp, worldPoint } from './kit.js';

const SIGN_KEYS: Record<string, string> = {
  sign_welcome: 'welcome',
  sign_notice_board: 'notice',
  sign_cafe_menu: 'menu',
  sign_store_hours: 'store_hours',
  sign_town_hall: 'hall_sign',
  sign_workshop: 'workshop_sign',
  sign_residential: 'residential',
  sign_trailhead: 'woods',
  sign_unknown: 'unknown',
  sign_dock: 'dock',
};

const HOUSE_MAILBOX_COLORS: Record<string, string> = {
  house_1: '#a65e4b',
  house_2: '#5f7c74',
  house_3: '#8a6a4a',
  house_4: '#6b5568',
  house_5: '#58697a',
};

function at(B: GeoBuilder, x: number, z: number, yaw: number, fn: () => void, y?: number): void {
  B.at(T(x, y ?? groundHeight(x, z), z, yaw), fn);
}

function board(B: GeoBuilder, key: string, w: number, frame: string = P.woodDark): void {
  signBoard(B, key, w, w / 4, signUV(key), quad, frame, true);
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------
export function bench(B: GeoBuilder, wood = '#a67c55', iron = '#3f4447'): void {
  for (let i = 0; i < 4; i++) B.add('solid', rbox(2.1, 0.06, 0.12, 0.025), shade(wood, 0.95 + (i % 2) * 0.07), T(0, 0.45, -0.18 + i * 0.13), { jitter: 0.04 });
  for (let i = 0; i < 3; i++) B.add('solid', rbox(2.1, 0.1, 0.05, 0.025), shade(wood, 0.95 + (i % 2) * 0.07), T(0, 0.62 + i * 0.14, -0.28 - i * 0.035, 0, -0.18), { jitter: 0.04 });
  for (const s of [-1, 1]) {
    const x = s * 0.92;
    B.add('solid', rbox(0.08, 0.45, 0.08, 0.03), iron, T(x, 0.22, 0.16));
    B.add('solid', rbox(0.08, 0.95, 0.08, 0.03), iron, T(x, 0.47, -0.25, 0, -0.12));
    B.add('solid', rbox(0.07, 0.07, 0.52, 0.03), iron, T(x, 0.42, -0.03));
    B.add('solid', rbox(0.09, 0.06, 0.5, 0.03), iron, T(x, 0.68, 0.0));
    B.add('solid', torus(0.07, 0.018, 4, 10), iron, T(x, 0.68, 0.24, Math.PI / 2));
  }
}

function chair(B: GeoBuilder): void {
  const iron = '#4f6f66';
  B.add('solid', cyl(0.24, 0.24, 0.05, 16), '#b98f66', T(0, 0.45, 0));
  B.add('solid', torus(0.235, 0.022, 5, 18), iron, T(0, 0.45, 0, 0, Math.PI / 2));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    B.add('solid', cyl(0.018, 0.018, 0.47, 5), iron, T(Math.cos(a) * 0.17, 0.22, Math.sin(a) * 0.17, 0, Math.sin(a) * 0.12, -Math.cos(a) * 0.12));
  }
  B.add('solid', torus(0.2, 0.025, 5, 14, Math.PI), iron, T(0, 0.73, -0.2, 0, 0, 0));
  for (const s of [-1, 1]) B.add('solid', cyl(0.018, 0.018, 0.32, 5), iron, T(s * 0.2, 0.6, -0.2));
  B.add('solid', cyl(0.018, 0.018, 0.25, 5), iron, T(0, 0.78, -0.2));
}

// ---------------------------------------------------------------------------
// Signs
// ---------------------------------------------------------------------------
function signFor(B: GeoBuilder, i: Interactable): void {
  const key = SIGN_KEYS[i.id] ?? 'welcome';
  switch (i.id) {
    case 'sign_welcome': {
      for (const s of [-1, 1]) {
        B.add('solid', rbox(0.18, 2.3, 0.18, 0.05), P.woodDark, T(s * 1.25, 1.15, 0));
        B.add('solid', sphere(0.13, 8, 6), P.woodDark, T(s * 1.25, 2.35, 0));
      }
      B.at(T(0, 1.75, 0), () => board(B, key, 2.3, P.woodDark));
      B.add('solid', torus(1.25, 0.06, 6, 20, Math.PI), P.woodDark, T(0, 2.0, 0));
      B.at(T(0, 0, 0.1), () => {
        B.add('solid', rbox(2.9, 0.22, 0.55, 0.08), P.stone, T(0, 0.11, 0));
        B.at(T(0, 0.22, 0), () => flowerPatch(B, 2.6, 0.35, 14));
      });
      return;
    }
    case 'sign_notice_board': {
      for (const s of [-1, 1]) B.add('solid', rbox(0.14, 2.2, 0.14, 0.04), P.woodDark, T(s * 0.85, 1.1, 0));
      B.add('solid', rbox(1.8, 1.1, 0.1, 0.04), '#a07a52', T(0, 1.35, 0));
      B.add('solid', rbox(1.6, 0.9, 0.04, 0.02), '#c9a87c', T(0, 1.32, 0.05));
      B.at(T(0, 1.98, 0.02), () => signBoard(B, 'notice', 1.1, 0.27, signUV('notice'), quad, P.woodDark, true));
      B.at(T(-0.4, 1.32, 0.08, 0, 0, 0.06), () => B.addUV('sign', quad(0.62, 0.36), signUV('paper1')));
      B.at(T(0.38, 1.25, 0.08, 0, 0, -0.08), () => B.addUV('sign', quad(0.56, 0.32), signUV('paper2')));
      B.add('solid', rbox(0.35, 0.42, 0.02, 0.01), '#f4efe6', T(0.05, 1.55, 0.075, 0, 0, 0.12));
      B.add('solid', rbox(2.1, 0.08, 0.5, 0.03), P.wood, T(0, 2.25, 0, 0, 0, 0));
      B.add('solid', rbox(2.1, 0.08, 0.36, 0.03), shade(P.wood, 0.9), T(0, 2.3, -0.05, 0, 0.35));
      return;
    }
    case 'sign_cafe_menu': {
      // A-frame chalkboard
      for (const s of [-1, 1]) {
        B.at(T(0, 0.55, s * 0.17, 0, s * 0.2), () => {
          B.add('solid', rbox(0.62, 1.05, 0.05, 0.03), P.woodDark);
          B.addUV('sign', quad(0.52, 0.78), signUV('menu'), T(0, 0.02, s * 0.03, s > 0 ? 0 : Math.PI));
        });
      }
      return;
    }
    case 'sign_store_hours': {
      B.add('solid', rbox(0.1, 1.2, 0.1, 0.03), P.woodDark, T(0, 0.6, 0));
      B.at(T(0, 1.15, 0.06), () => board(B, key, 1.0, '#5f6f5a'));
      return;
    }
    case 'sign_trailhead': {
      B.add('solid', cyl(0.09, 0.11, 2.3, 8), '#6a5040', T(0, 1.15, 0));
      B.at(T(0, 1.85, 0.08, 0, 0, 0.05), () => board(B, key, 1.3, '#4b3a2e'));
      B.at(T(0.1, 1.3, 0.08, -0.5, 0, -0.06), () => {
        B.add('solid', rbox(0.95, 0.24, 0.07, 0.03), '#a98a62', T(0, 0, 0));
        B.add('solid', cone(0.16, 0.24, 3), '#a98a62', T(0.56, 0, 0, 0, 0, -Math.PI / 2, 1, 1, 0.3));
      });
      B.add('solid', sphere(0.35, 10, 8), P.leaf, T(0.35, 0.2, 0.2), { grad: 0.3 });
      return;
    }
    case 'sign_unknown': {
      B.add('solid', rbox(1.1, 1.5, 0.3, 0.12), '#8a8578', T(0, 0.72, 0, 0, 0.04, 0.03), { grad: 0.3 });
      B.addUV('sign', quad(0.9, 0.28), signUV('unknown'), T(0, 1.0, 0.16, 0, 0.04, 0.03));
      B.addUV('sign', quad(0.9, 0.28), signUV('unknown'), T(0, 1.0, -0.16, Math.PI, -0.04, 0.03));
      B.add('plant', sphere(0.25, 8, 6), '#6f8a4c', T(-0.45, 0.1, 0.2));
      return;
    }
    case 'sign_town_hall': {
      B.add('solid', rbox(1.7, 0.5, 0.4, 0.1), P.stone, T(0, 0.25, 0));
      for (const s of [-1, 1]) B.add('solid', rbox(0.12, 1.0, 0.12, 0.04), '#5a4c5c', T(s * 0.72, 0.9, 0));
      B.at(T(0, 1.15, 0), () => board(B, key, 1.45, '#5a4c5c'));
      return;
    }
    default: {
      B.add('solid', rbox(0.12, 1.6, 0.12, 0.04), P.woodDark, T(0, 0.8, 0));
      B.add('solid', cone(0.1, 0.12, 4), P.woodDark, T(0, 1.66, 0, Math.PI / 4));
      B.at(T(0, 1.25, 0.07), () => board(B, key, 1.2, i.id === 'sign_dock' ? '#3f4e57' : P.woodDark));
    }
  }
}

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------
function lightFor(B: GeoBuilder, i: LightInteractable): void {
  const { color, range, intensity, height } = i.light;
  if (i.kind === 'streetlight') return streetlamp(B, i.id, height, color, range, intensity);
  if (i.id === 'lantern_cafe') return stringLightPole(B, i);
  if (i.id.startsWith('lantern_bridge')) return lanternPost(B, i.id, height, color, range, intensity, P.stone, 'stone');
  if (i.id.startsWith('lantern_dock')) return lanternPost(B, i.id, height, color, range, intensity, '#6b5444', 'wood');
  return lanternPost(B, i.id, height, color, range, intensity);
}

/** Café string lights: a tall pole, strings to the café front and to the parasol. */
function stringLightPole(B: GeoBuilder, i: LightInteractable): void {
  const top = 3.0;
  B.add('solid', cyl(0.07, 0.09, top, 8), P.woodDark, T(0, top / 2, 0));
  B.add('solid', sphere(0.08, 8, 6), P.brass, T(0, top + 0.05, 0));
  const start = worldPoint(B, 0, top - 0.1, 0);
  anchors.lamps.push({ lightId: i.id, position: worldPoint(B, 0, top - 0.6, 0), color: i.light.color, range: i.light.range, intensity: i.light.intensity });
  stringTargets.push({ lightId: i.id, from: start });
}
const stringTargets: { lightId: string; from: import('three').Vector3 }[] = [];

/** Lay out catenary string lights between world points (called after props are built). */
export function stringLights(B: GeoBuilder, lightId: string, a: import('three').Vector3, b: import('three').Vector3, sag = 0.5, count = 12): void {
  const len = a.distanceTo(b);
  const n = Math.max(3, Math.round(len * 2.2));
  let prev = a.clone();
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t);
    const mid = prev.clone().add(p).multiplyScalar(0.5);
    const dir = p.clone().sub(prev);
    const yaw = Math.atan2(dir.x, dir.z);
    const pitch = -Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
    B.add('solid', cyl(0.012, 0.012, dir.length(), 4), '#3a3a3a', T(mid.x, mid.y, mid.z, yaw, pitch + Math.PI / 2), { ao: false });
    prev = p;
  }
  for (let k = 1; k < count; k++) {
    const t = k / count;
    const p = a.clone().lerp(b, t);
    p.y -= sag * 4 * t * (1 - t) + 0.06;
    anchors.glows.push({ lightId, position: p, size: 0.06, kind: 1 });
  }
}

// ---------------------------------------------------------------------------
// Others
// ---------------------------------------------------------------------------
function mailbox(B: GeoBuilder, i: Interactable & { owner: string }): void {
  if (i.owner === 'public') {
    const red = '#a44a3f';
    B.add('solid', cyl(0.3, 0.34, 0.12, 16), shade(red, 0.8), T(0, 0.06, 0));
    B.add('solid', cyl(0.26, 0.27, 1.15, 16), red, T(0, 0.67, 0), { grad: 0.15 });
    B.add('solid', sphere(0.29, 16, 10, ), red, T(0, 1.25, 0, 0, 0, 0, 1, 0.55, 1));
    B.add('solid', torus(0.27, 0.03, 6, 18), shade(red, 0.8), T(0, 1.24, 0, 0, Math.PI / 2));
    B.add('solid', rbox(0.3, 0.05, 0.06, 0.02), '#2e2a2a', T(0, 1.0, 0.25));
    B.add('solid', rbox(0.2, 0.14, 0.04, 0.02), '#f0e7d4', T(0, 0.7, 0.26));
    return;
  }
  const c = HOUSE_MAILBOX_COLORS[i.owner] ?? '#6b7f86';
  B.add('solid', rbox(0.1, 1.0, 0.1, 0.03), P.wood, T(0, 0.5, 0));
  B.add('solid', rbox(0.32, 0.26, 0.5, 0.06), c, T(0, 1.08, 0.05));
  B.add('solid', cyl(0.16, 0.16, 0.5, 12, false), c, T(0, 1.2, 0.05, 0, Math.PI / 2));
  B.add('solid', rbox(0.03, 0.26, 0.05, 0.01), '#c0473a', T(0.18, 1.25, -0.05));
  B.add('solid', rbox(0.03, 0.1, 0.14, 0.01), '#c0473a', T(0.18, 1.35, -0.1));
}

function newsstand(B: GeoBuilder): void {
  const c = '#7a3f36';
  B.add('solid', rbox(1.2, 1.05, 0.7, 0.08), c, T(0, 0.52, 0));
  B.add('solid', rbox(1.1, 0.06, 0.6, 0.02), '#f0e7d4', T(0, 1.07, 0.05, 0, 0.25));
  for (let k = 0; k < 4; k++) B.add('solid', rbox(0.24, 0.02, 0.32, 0.005), '#eee6d4', T(-0.4 + k * 0.27, 1.12 + k * 0.004, 0.08, 0.05 * k, 0.25), { ao: false });
  for (const s of [-1, 1]) B.add('solid', cyl(0.03, 0.03, 1.3, 6), P.iron, T(s * 0.55, 1.65, -0.25));
  B.add('solid', rbox(1.5, 0.08, 1.0, 0.03), '#efe3cf', T(0, 2.3, 0.0, 0, 0.12), { ao: false });
  for (let k = 0; k < 6; k++) B.add('solid', rbox(0.25, 0.09, 1.02, 0.03), k % 2 ? c : '#efe3cf', T(-0.625 + k * 0.25, 2.31, 0.0, 0, 0.12), { ao: false });
  B.at(T(0, 1.75, -0.24), () => board(B, 'gazette', 1.1, c));
  B.add('solid', rbox(1.25, 0.06, 0.75, 0.02), shade(c, 0.8), T(0, 0.03, 0));
}

function archiveCabinet(B: GeoBuilder): void {
  const wood = '#6a4f3e';
  B.add('solid', rbox(1.1, 1.6, 0.55, 0.06), wood, T(0, 0.8, -0.05));
  B.addRaw('window', rbox(0.9, 1.2, 0.03, 0.01), [0.6, 0.3, 0], T(0, 0.95, 0.23));
  for (let s = 0; s < 3; s++)
    for (let k = 0; k < 6; k++) B.add('solid', rbox(0.1, 0.28 + ((k * 7) % 3) * 0.03, 0.3, 0.01), ['#8a4a3c', '#4f6f66', '#c89b52', '#5a4c5c', '#a7856a'][(k + s) % 5]!, T(-0.33 + k * 0.13, 0.55 + s * 0.38, 0.0), { ao: false });
  B.add('solid', rbox(1.3, 0.12, 0.75, 0.04), shade(wood, 0.9), T(0, 1.66, 0));
  B.add('solid', cone(0.85, 0.42, 4), '#6a5a6e', T(0, 1.92, 0, Math.PI / 4, 0, 0, 1, 1, 0.65));
  // lectern with an open ledger in front
  B.add('solid', cyl(0.06, 0.09, 0.9, 8), wood, T(0.75, 0.45, 0.35));
  B.add('solid', rbox(0.5, 0.05, 0.4, 0.02), wood, T(0.75, 0.95, 0.35, 0, 0.35));
  B.add('solid', rbox(0.44, 0.03, 0.32, 0.01), '#f2ead6', T(0.75, 0.985, 0.36, 0, 0.35), { ao: false });
}

function bellPost(B: GeoBuilder): void {
  B.add('solid', rbox(0.5, 0.25, 0.5, 0.08), P.stone, T(0, 0.12, 0));
  B.add('solid', cyl(0.07, 0.08, 1.2, 8), P.iron, T(0, 0.85, 0));
  B.add('solid', torus(0.09, 0.025, 6, 12), P.brass, T(0, 1.45, 0, 0, Math.PI / 2));
  B.add('solid', rbox(0.28, 0.05, 0.05, 0.02), P.brass, T(0, 1.1, 0.07));
  B.add('solid', cyl(0.05, 0.03, 0.22, 8), '#c9b18a', T(0.0, 1.32, 0.1));
}

function stump(B: GeoBuilder, r: number, h: number): void {
  B.add('solid', cyl(r, r * 1.25, h, 14), '#7a5c46', T(0, h / 2, 0));
  B.add('solid', cyl(r * 0.96, r * 0.96, 0.03, 14), '#c7a77e', T(0, h + 0.005, 0), { ao: false });
  for (let k = 1; k < 5; k++) B.add('solid', torus(r * (k / 5.2), 0.012, 3, 16), '#9a7b5a', T(0, h + 0.02, 0, 0, Math.PI / 2), { ao: false });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    B.add('solid', cyl(0.08, 0.16, r * 1.3, 6), '#6f533f', T(Math.cos(a) * r * 1.05, 0.08, Math.sin(a) * r * 1.05, -a + Math.PI / 2, 0, Math.PI / 2 - 0.2));
  }
  B.add('plant', sphere(r * 0.5, 8, 6), '#6f8a4c', T(r * 0.7, 0.12, r * 0.4, 0, 0, 0, 1, 0.4, 1));
}

function telescope(B: GeoBuilder): void {
  B.add('solid', cyl(0.18, 0.24, 0.12, 10), P.iron, T(0, 0.06, 0));
  B.add('solid', cyl(0.06, 0.07, 1.0, 8), P.iron, T(0, 0.6, 0));
  B.add('solid', rbox(0.28, 0.22, 0.26, 0.05), '#5f7c74', T(0, 1.15, 0));
  B.add('solid', cyl(0.09, 0.12, 0.8, 12), P.brass, T(0, 1.32, 0.3, 0, Math.PI / 2 - 0.25));
  B.add('solid', cyl(0.13, 0.13, 0.06, 12), shade(P.brass, 0.8), T(0, 1.42, 0.68, 0, Math.PI / 2 - 0.25));
}

/** Rune stone body (the glyph glow is dynamic). */
export function runeStone(B: GeoBuilder): void {
  B.add('solid', ico(0.75, 1), '#8e8a7e', T(0, 0.35, 0, 0, 0, 0, 0.75, 0.45, 0.65), { grad: 0.3 });
  B.add('solid', rbox(0.7, 1.15, 0.42, 0.16), '#9a9588', T(0, 0.72, 0, 0, -0.06), { grad: 0.3 });
  B.add('solid', rbox(0.76, 0.14, 0.48, 0.06), '#a8a395', T(0, 1.32, -0.02, 0, -0.06));
  B.add('plant', sphere(0.22, 8, 6), '#6f8a4c', T(-0.3, 1.36, 0.0, 0, 0, 0, 1, 0.35, 1.1));
  B.add('solid', rbox(0.48, 0.62, 0.03, 0.04), '#77736a', T(0, 0.78, 0.2, 0, -0.06));
}

function hiddenFor(B: GeoBuilder, i: Interactable): void {
  switch (i.id) {
    case 'hidden_mossy_coin':
      B.add('plant', sphere(0.35, 8, 6), '#6f8a4c', T(0.1, 0.02, 0, 0, 0, 0, 1, 0.3, 1));
      B.add('solid', cyl(0.07, 0.07, 0.02, 12), '#b39a4f', T(-0.05, 0.1, 0.12, 0, 0.5, 0.3), { ao: false });
      break;
    case 'hidden_carved_owl':
      stump(B, 0.32, 0.4);
      B.add('solid', sphere(0.16, 10, 8), '#9a7b5a', T(0, 0.55, 0, 0, 0, 0, 1, 1.2, 0.9));
      B.add('solid', sphere(0.12, 10, 8), '#9a7b5a', T(0, 0.78, 0.01));
      for (const s of [-1, 1]) {
        B.add('solid', sphere(0.035, 6, 5), '#3a2c22', T(s * 0.05, 0.8, 0.1), { ao: false });
        B.add('solid', cone(0.03, 0.08, 4), '#9a7b5a', T(s * 0.07, 0.9, 0));
      }
      break;
    case 'hidden_music_box':
      B.add('solid', rbox(0.22, 0.14, 0.16, 0.03), '#7a3f36', T(0, 0.07, 0, 0.4));
      B.add('solid', rbox(0.22, 0.03, 0.16, 0.01), P.brass, T(0, 0.15, -0.04, 0.4, -0.5));
      B.add('plant', sphere(0.3, 8, 6), '#5f7a4b', T(0.3, 0.05, -0.15, 0, 0, 0, 1, 0.5, 1));
      break;
    case 'hidden_old_compass':
      B.add('solid', cyl(0.09, 0.09, 0.04, 14), P.brass, T(0, 0.03, 0, 0, 0.15), { ao: false });
      B.add('solid', cyl(0.07, 0.07, 0.01, 14), '#efe7d6', T(0, 0.055, 0, 0, 0.15), { ao: false });
      B.add('plant', sphere(0.28, 8, 6), '#6f8a4c', T(-0.25, 0.05, 0.1, 0, 0, 0, 1, 0.6, 1));
      break;
    case 'hidden_message_bottle':
      B.add('glazed', cyl(0.07, 0.08, 0.32, 10), '#6f9a86', T(0, 0.04, 0, 0.6, 1.35));
      B.add('glazed', cyl(0.025, 0.04, 0.12, 8), '#6f9a86', T(0.17, 0.09, -0.08, 0.6, 1.35));
      B.add('solid', rbox(0.06, 0.18, 0.06, 0.02), '#efe3c8', T(-0.02, 0.05, 0.01, 0.6, 1.35), { ao: false });
      break;
    case 'hidden_stone_inscription':
      // Carved on the inward face of the standing stone that stands here (see StandingStones).
      break;
    default:
      B.add('solid', sphere(0.1, 8, 6), '#b39a4f', T(0, 0.08, 0));
  }
  anchors.sparkles.push({ id: i.id, position: worldPoint(B, 0, 0.25, 0), subtle: true });
}

function inspectFor(B: GeoBuilder, i: Interactable): void {
  switch (i.id) {
    case 'inspect_cafe_window': {
      // A sleeping cat on the sill inside the café window.
      B.add('solid', sphere(0.16, 10, 8), '#5a4c48', T(0, 1.4, -0.35, 0, 0, 0, 1.4, 0.8, 1));
      B.add('solid', sphere(0.1, 10, 8), '#5a4c48', T(0.18, 1.48, -0.32));
      for (const s of [-1, 1]) B.add('solid', cone(0.04, 0.08, 4), '#5a4c48', T(0.18 + s * 0.05, 1.58, -0.32));
      B.add('solid', torus(0.12, 0.03, 5, 10, Math.PI), '#5a4c48', T(-0.15, 1.33, -0.25, 0, Math.PI / 2));
      return;
    }
    case 'inspect_workbench': {
      // half-built birdhouse on the bench
      B.add('solid', rbox(0.3, 0.3, 0.3, 0.03), '#c49a6a', T(0, 1.05, -0.6));
      B.add('solid', cone(0.3, 0.2, 4), '#8a5a3c', T(0, 1.3, -0.6, Math.PI / 4));
      B.add('solid', cyl(0.05, 0.05, 0.02, 10), '#3a2c22', T(0, 1.07, -0.44, 0, Math.PI / 2));
      return;
    }
    case 'inspect_old_stump': {
      stump(B, 0.85, 0.65);
      B.add('solid', sphere(0.06, 8, 6), '#9a6a3a', T(0.1, 0.72, 0.05, 0, 0, 0, 1, 1.25, 1));
      B.add('solid', sphere(0.045, 8, 6), '#6a4a2a', T(0.1, 0.79, 0.05, 0, 0, 0, 1.2, 0.6, 1.2));
      return;
    }
    case 'inspect_telescope':
      return telescope(B);
    case 'inspect_garden_bed':
      // The garden bed prop sits here; add a little hand-painted label stake.
      B.add('solid', rbox(0.04, 0.5, 0.04, 0.01), P.wood, T(1.6, 0.6, 1.05));
      B.add('solid', rbox(0.34, 0.2, 0.03, 0.01), '#efe6d2', T(1.6, 0.85, 1.07));
      return;
    default:
      B.add('solid', sphere(0.15, 8, 6), P.stoneMid, T(0, 0.15, 0));
  }
}

export function buildInteractable(B: GeoBuilder, i: Interactable): void {
  B.represented.add(i.id);
  const x = i.position.x;
  const z = i.position.z;
  switch (i.kind) {
    case 'bench':
      return at(B, x, z, i.yaw, () => bench(B, i.locationId === 'waterfront' ? '#9c7a5a' : '#a67c55'));
    case 'chair':
      return at(B, x, z, i.yaw, () => chair(B));
    case 'door':
      return; // doorway frames are part of the buildings; leaves are dynamic (Doors.tsx)
    case 'sign':
      return at(B, x, z, i.yaw, () => signFor(B, i));
    case 'bell':
      return at(B, x, z, i.yaw, () => bellPost(B));
    case 'streetlight':
    case 'lantern':
      return at(B, x, z, 0, () => lightFor(B, i));
    case 'mailbox':
      return at(B, x, z, i.yaw, () => mailbox(B, i));
    case 'pickup':
      return; // dynamic (Pickups.tsx)
    case 'hidden':
      return at(B, x, z, i.yaw, () => hiddenFor(B, i));
    case 'fountain':
      return; // Fountain.tsx
    case 'portal':
      return; // Unknown.tsx (pillars are static below)
    case 'rune':
      return at(B, x, z, i.yaw, () => runeStone(B));
    case 'inspect':
      return at(B, x, z, i.yaw, () => inspectFor(B, i));
    case 'newsstand':
      return at(B, x, z, i.yaw, () => newsstand(B));
    case 'archive':
      return at(B, x, z, i.yaw, () => archiveCabinet(B));
    default: {
      const never: never = i;
      void never;
    }
  }
}

// ---------------------------------------------------------------------------
// Props (shared PROPS: collision-matched)
// ---------------------------------------------------------------------------
export function buildProp(B: GeoBuilder, p: Prop): void {
  at(B, p.position.x, p.position.z, p.yaw, () => {
    switch (p.kind) {
      case 'cafe_table': {
        B.add('solid', cyl(0.3, 0.36, 0.06, 14), P.iron, T(0, 0.03, 0));
        B.add('solid', cyl(0.04, 0.05, 0.7, 8), P.iron, T(0, 0.38, 0));
        B.add('glazed', cyl(0.48, 0.46, 0.06, 20), '#ece6da', T(0, 0.74, 0));
        B.add('solid', torus(0.47, 0.022, 5, 22), P.brass, T(0, 0.74, 0, 0, Math.PI / 2));
        B.add('solid', cyl(0.06, 0.05, 0.12, 10), '#f4efe6', T(0.12, 0.83, 0.05), { ao: false });
        B.add('solid', cyl(0.05, 0.04, 0.03, 10), '#e9dcc8', T(-0.12, 0.78, -0.08), { ao: false });
        if (p.id === 'cafe_table_2') {
          B.add('solid', cyl(0.03, 0.03, 2.0, 6), '#e8e0cf', T(0, 1.45, 0));
          const n = 10;
          for (let k = 0; k < n; k++) {
            B.add('solid', cone(1.5, 0.55, 3, ), k % 2 ? '#b0563d' : '#efe3cf', T(0, 2.38, 0, (k / n) * Math.PI * 2, 0, 0, 0.42, 1, 1), { ao: false });
          }
          B.add('solid', sphere(0.06, 8, 6), P.brass, T(0, 2.68, 0), { ao: false });
          parasolTop = worldPoint(B, 0, 2.62, 0);
        } else {
          B.add('plant', sphere(0.07, 8, 6), '#e7a0a6', T(0, 0.9, 0), { ao: false });
          B.add('glazed', cyl(0.035, 0.04, 0.12, 8), '#8fb0b4', T(0, 0.82, 0), { ao: false });
        }
        return;
      }
      case 'crate': {
        crate(B, 0.8, p.id === 'crate_workshop' ? '#a98a62' : '#b58f62');
        if (p.id === 'crate_store_1') {
          for (let k = 0; k < 7; k++) B.add('solid', sphere(0.12, 10, 8), k % 3 ? '#b8453a' : '#c9a23f', T(-0.22 + (k % 3) * 0.22, 0.86, -0.22 + Math.floor(k / 3) * 0.2), { ao: false, jitter: 0.08 });
        } else {
          B.add('solid', torus(0.16, 0.05, 6, 8), P.iron, T(0.1, 0.84, 0, 0, Math.PI / 2));
          B.add('solid', torus(0.1, 0.04, 6, 6), P.brass, T(-0.2, 0.83, 0.15, 0, Math.PI / 2));
        }
        return;
      }
      case 'barrel': {
        barrel(B, 0.42, 1.0, '#8b6a4c');
        B.add('solid', cyl(0.38, 0.38, 0.04, 16), '#a7856a', T(0, 1.0, 0));
        for (let k = 0; k < 5; k++) B.add('solid', cone(0.04, 0.3, 5), '#c9b285', T(Math.cos(k) * 0.15, 1.15, Math.sin(k) * 0.15, 0, Math.cos(k * 2) * 0.3, Math.sin(k * 2) * 0.3), { ao: false });
        return;
      }
      case 'workbench': {
        B.add('solid', rbox(2.4, 0.12, 1.0, 0.04), '#b58f62', T(0, 0.88, 0));
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', rbox(0.12, 0.85, 0.12, 0.03), '#7a5c46', T(sx * 1.05, 0.42, sz * 0.38));
        B.add('solid', rbox(2.2, 0.06, 0.85, 0.02), '#8a6a4c', T(0, 0.22, 0));
        B.add('solid', rbox(0.3, 0.2, 0.25, 0.04), P.iron, T(-0.9, 1.02, 0.42));
        B.add('solid', cyl(0.02, 0.02, 0.4, 5), P.iron, T(-0.9, 1.0, 0.62, 0, Math.PI / 2));
        B.add('solid', rbox(0.6, 0.02, 0.14, 0.005), '#c9ccce', T(0.5, 0.95, 0.15, 0.3), { ao: false });
        B.add('solid', rbox(0.14, 0.06, 0.3, 0.02), P.woodDark, T(0.84, 0.97, 0.24, 0.3), { ao: false });
        for (let k = 0; k < 10; k++) B.add('solid', torus(0.04, 0.012, 3, 6), '#e2c99e', T(-0.4 + B.random() * 1.2, 0.95, -0.3 + B.random() * 0.5, B.random() * 3), { ao: false });
        for (let k = 0; k < 8; k++) B.add('solid', torus(0.05, 0.014, 3, 6), '#d9bf92', T(-1 + B.random() * 2, 0.02, -0.6 + B.random() * 1.2, B.random() * 3), { ao: false });
        return;
      }
      case 'garden_bed': {
        const w = p.shape.type === 'box' ? p.shape.halfWidth * 2 : 2;
        const d = p.shape.type === 'box' ? p.shape.halfDepth * 2 : 2;
        B.add('solid', rbox(w, 0.35, d, 0.06), '#8a6a4c', T(0, 0.17, 0));
        B.add('solid', rbox(w - 0.16, 0.06, d - 0.16, 0.02), P.soil, T(0, 0.34, 0));
        for (let r = 0; r < 3; r++) {
          const zz = -d / 2 + 0.4 + r * ((d - 0.8) / 2);
          for (let k = 0; k < 6; k++) {
            const xx = -w / 2 + 0.35 + k * ((w - 0.7) / 5);
            if (r === 1) {
              B.add('solid', cyl(0.015, 0.015, 0.8, 4), P.wood, T(xx, 0.75, zz));
              B.add('plant', sphere(0.18, 8, 6), '#5f8a4a', T(xx, 0.6, zz, 0, 0, 0, 0.8, 1.4, 0.8));
              B.add('solid', sphere(0.06, 6, 5), '#c0473a', T(xx + 0.08, 0.62, zz + 0.05), { ao: false });
            } else {
              B.add('plant', sphere(0.14, 8, 6), '#6f9a52', T(xx, 0.45, zz, 0, 0, 0, 1, 0.7, 1));
              B.add('solid', sphere(0.06, 6, 5), r === 0 ? '#e98a3b' : '#f1d27a', T(xx, 0.55, zz), { ao: false });
            }
          }
        }
        return;
      }
      case 'planter': {
        B.add('solid', rbox(0.8, 0.55, 0.8, 0.06), '#8a6a4c', T(0, 0.27, 0));
        B.add('solid', rbox(0.86, 0.08, 0.86, 0.03), '#a7856a', T(0, 0.55, 0));
        B.at(T(0, 0.55, 0), () => shrub(B, 0.32, P.leaf, 7));
        return;
      }
    }
  });
}
let parasolTop: import('three').Vector3 | null = null;

/** Finish deferred decorations that span several objects (café string lights). */
export function finishStrings(B: GeoBuilder, cafeFront: import('three').Vector3[]): void {
  for (const s of stringTargets) {
    for (const f of cafeFront) stringLights(B, s.lightId, s.from, f, 0.45, 10);
    if (parasolTop) {
      stringLights(B, s.lightId, s.from, parasolTop, 0.35, 10);
      if (cafeFront[1]) stringLights(B, s.lightId, parasolTop, cafeFront[1], 0.35, 10);
    }
  }
  stringTargets.length = 0;
}

// ---------------------------------------------------------------------------
// Decks: the dock and the Mossy Bridge
// ---------------------------------------------------------------------------
export function buildDeck(B: GeoBuilder, d: Deck): void {
  B.at(T(d.center.x, d.y, d.center.z, d.yaw), () => {
    const W = d.halfWidth * 2;
    const L = d.halfLength * 2;
    if (d.kind === 'bridge') {
      const n = Math.round(L / 0.32);
      for (let k = 0; k < n; k++) B.add('solid', rbox(W + 0.1, 0.1, 0.28, 0.03), shade('#8a6a4c', 0.88 + ((k * 7) % 5) * 0.04), T(0, -0.05, -L / 2 + (k + 0.5) * (L / n), 0, 0, ((k % 3) - 1) * 0.015), { jitter: 0.03 });
      for (const s of [-1, 1]) {
        B.add('solid', rbox(0.2, 0.22, L + 0.4, 0.05), '#6a5040', T(s * (W / 2 + 0.02), -0.2, 0));
        for (let k = 0; k <= 4; k++) {
          const z = -L / 2 + (k / 4) * L;
          B.add('solid', rbox(0.16, 1.05, 0.16, 0.04), '#6a5040', T(s * (W / 2 + 0.05), 0.35, z));
          B.add('solid', sphere(0.1, 8, 6), '#6a5040', T(s * (W / 2 + 0.05), 0.9, z));
          // legs down into the creek
          B.add('solid', cyl(0.12, 0.14, 1.6, 8), '#5e4636', T(s * (W / 2 - 0.1), -0.95, z));
        }
        B.add('solid', rbox(0.1, 0.1, L, 0.04), '#7a5c46', T(s * (W / 2 + 0.05), 0.82, 0));
        B.add('solid', rbox(0.06, 0.06, L, 0.02), '#7a5c46', T(s * (W / 2 + 0.05), 0.45, 0));
        // moss on the rails
        for (let k = 0; k < 4; k++) B.add('plant', sphere(0.14, 7, 5), '#6f8a4c', T(s * (W / 2 + 0.05), 0.86, -L / 2 + 0.5 + k * (L / 4), 0, 0, 0, 1.8, 0.5, 1));
      }
      return;
    }
    // dock
    const n = Math.round(L / 0.36);
    for (let k = 0; k < n; k++) {
      const z = -L / 2 + (k + 0.5) * (L / n);
      B.add('solid', rbox(W + 0.06, 0.12, 0.33, 0.03), shade('#9c7a5a', 0.86 + ((k * 5) % 7) * 0.035), T(0, -0.06, z, 0, 0, ((k % 3) - 1) * 0.01), { jitter: 0.03, ao: false });
    }
    for (const s of [-1, 1]) B.add('solid', rbox(0.18, 0.28, L, 0.05), '#6b5444', T(s * (W / 2 - 0.05), -0.25, 0), { ao: false });
    const posts = Math.max(2, Math.round(L / 2.4));
    for (let k = 0; k <= posts; k++) {
      const z = -L / 2 + (k / posts) * L;
      for (const s of [-1, 1]) {
        const px = s * (W / 2 + 0.08);
        B.add('solid', cyl(0.14, 0.16, 3.4, 10), '#6b5444', T(px, -1.4, z), { ao: false, grad: 0.4 });
        B.add('solid', cyl(0.15, 0.15, 0.06, 10), '#55433a', T(px, 0.3, z), { ao: false });
        // barnacle/weed band at the waterline
        B.add('solid', cyl(0.17, 0.17, 0.18, 10), '#5f6f5a', T(px, -0.95, z), { ao: false });
        if (d.id === 'deck_dock' || Math.abs(z) > 0.5) B.add('solid', cyl(0.14, 0.14, 0.32, 10), '#6b5444', T(px, 0.12, z), { ao: false });
      }
    }
    // rope railing along the long dock
    if (d.id === 'deck_dock') {
      for (const s of [-1, 1]) {
        const px = s * (W / 2 + 0.08);
        for (let k = 0; k < posts; k++) {
          const z0 = -L / 2 + (k / posts) * L;
          const z1 = -L / 2 + ((k + 1) / posts) * L;
          const segs = 6;
          for (let q = 0; q < segs; q++) {
            const t0 = q / segs;
            const t1 = (q + 1) / segs;
            const y0 = 0.26 - 0.12 * 4 * t0 * (1 - t0);
            const y1 = 0.26 - 0.12 * 4 * t1 * (1 - t1);
            const za = z0 + (z1 - z0) * t0;
            const zb = z0 + (z1 - z0) * t1;
            B.add('solid', cyl(0.025, 0.025, Math.hypot(zb - za, y1 - y0), 4), '#d2bf98', T(px, (y0 + y1) / 2, (za + zb) / 2, 0, Math.PI / 2 - Math.atan2(y1 - y0, zb - za)), { ao: false });
          }
        }
      }
      // ladder into the water
      B.at(T(W / 2 + 0.25, 0, L / 4), () => {
        for (const s of [-1, 1]) B.add('solid', rbox(0.06, 1.6, 0.06, 0.02), P.iron, T(0, -0.6, s * 0.22));
        for (let k = 0; k < 4; k++) B.add('solid', cyl(0.02, 0.02, 0.44, 5), P.iron, T(0, -1.2 + k * 0.35, 0, 0, Math.PI / 2));
      });
    } else {
      // dock end: bollards, coiled rope, fishing spot (bucket, rod, tackle box)
      for (const s of [-1, 1]) {
        B.add('solid', cyl(0.16, 0.2, 0.42, 12), '#3f4447', T(s * (W / 2 - 0.5), 0.21, -L / 2 + 0.4));
        B.add('solid', cyl(0.24, 0.24, 0.08, 12), '#3f4447', T(s * (W / 2 - 0.5), 0.44, -L / 2 + 0.4));
      }
      B.add('solid', torus(0.22, 0.06, 6, 16), '#d2bf98', T(-W / 2 + 0.6, 0.06, 0.6, 0, Math.PI / 2));
      B.add('solid', torus(0.14, 0.06, 6, 14), '#d2bf98', T(-W / 2 + 0.6, 0.14, 0.6, 0, Math.PI / 2));
      B.at(T(W / 2 - 0.55, 0, -0.1), () => {
        B.add('solid', cyl(0.18, 0.15, 0.32, 12), '#6b7f86', T(0, 0.16, 0));
        B.add('glazed', cyl(0.16, 0.16, 0.02, 12), '#5f8f99', T(0, 0.28, 0));
        B.add('solid', rbox(0.4, 0.16, 0.24, 0.04), '#a44a3f', T(0.35, 0.08, 0.3, 0.4));
        B.add('solid', cyl(0.018, 0.012, 2.4, 5), '#6a4f3e', T(0.1, 0.55, 0.55, 0, 1.05));
        B.add('solid', cyl(0.004, 0.004, 1.6, 3), '#e8e4d8', T(0.1, 0.4, 2.0, 0, 0.1), { ao: false });
        anchors.sparkles.push({ id: 'fishing_bob', position: worldPoint(B, 0.1, -0.9, 2.05), subtle: false });
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The Unknown: standing stones, arch pillars, dais
// ---------------------------------------------------------------------------
export function buildUnknownStatics(B: GeoBuilder): void {
  for (const s of STANDING_STONES) {
    const g = terrainHeight(s.position.x, s.position.z);
    B.at(T(s.position.x, g, s.position.z, s.yaw), () => {
      B.add('solid', ico(s.radius * 1.2, 1), '#7e7a70', T(0, 0.1, 0, 0, 0, 0, 1.1, 0.35, 0.9), { grad: 0.2 });
      B.at(T(0, 0, 0, 0, s.lean, s.lean * 0.6), () => {
        // monolith: broad base tapering to a weathered, tilted crown
        B.add('solid', rbox(s.radius * 1.6, s.height * 0.62, s.radius * 1.0, 0.26, 2), '#98938a', T(0, s.height * 0.31, 0), { grad: 0.35 });
        B.add('solid', rbox(s.radius * 1.38, s.height * 0.5, s.radius * 0.9, 0.24, 2), '#a19c91', T(0.03, s.height * 0.7, 0, 0.06, 0, 0.03), { grad: 0.2 });
        B.add('solid', rbox(s.radius * 1.1, s.height * 0.16, s.radius * 0.8, 0.12), '#aaa598', T(-0.05, s.height * 0.97, 0.02, 0.1, 0.05, -0.08));
        // lichen + carved spiral
        for (let k = 0; k < 4; k++) B.add('solid', sphere(0.12 + (k % 2) * 0.06, 6, 4), k % 2 ? '#b9c08a' : '#c9c79a', T((k - 1.5) * 0.18, s.height * (0.25 + k * 0.17), s.radius * 0.5, 0, 0, 0, 1, 1, 0.25), { ao: false });
        B.add('solid', torus(0.16, 0.025, 4, 14, Math.PI * 1.6), '#7f7a70', T(0, s.height * 0.5, s.radius * 0.47), { ao: false });
        B.add('solid', torus(0.08, 0.022, 4, 10, Math.PI * 1.4), '#7f7a70', T(0.02, s.height * 0.5, s.radius * 0.48, 0, 0, 1.2), { ao: false });
        B.add('plant', sphere(s.radius * 0.6, 8, 6), '#6f8a4c', T(s.radius * 0.3, s.height - 0.05, 0, 0, 0, 0, 1.2, 0.35, 1));
        B.add('plant', sphere(s.radius * 0.45, 8, 6), '#7d9a55', T(-s.radius * 0.5, 0.25, s.radius * 0.3, 0, 0, 0, 1.2, 0.6, 1));
        if (s.id === 'standing_stone_4') {
          // the stone inscription (hidden_stone_inscription is at this stone)
          B.addUV('sign', quad(0.95, 0.5), signUV('inscription'), T(0, s.height * 0.45, s.radius * 0.49));
        }
      });
    });
  }
  // ruins: a toppled stone, lintel fragments and a ring of kerb stones around the flagstones
  const U = { x: -10, z: -61 };
  const ruins: [number, number, number][] = [[-3.2, -66.0, 0.6], [-16.6, -66.4, 2.1], [-4.0, -57.2, 1.2]];
  ruins.forEach(([x, z, yaw], k) => {
    const g = terrainHeight(x, z);
    B.at(T(x, g, z, yaw), () => {
      if (k === 0) {
        B.add('solid', rbox(0.9, 0.7, 2.6, 0.24), '#98938a', T(0, 0.3, 0, 0, 0.05, 0.08), { grad: 0.3 });
        B.add('plant', sphere(0.4, 8, 6), '#7d9a55', T(0.2, 0.62, 0.4, 0, 0, 0, 1.4, 0.35, 1.8));
      } else {
        B.add('solid', rbox(1.3, 0.5, 0.6, 0.14), '#a19c91', T(0, 0.2, 0, 0.3, 0.1, 0.12), { grad: 0.3 });
        B.add('solid', rbox(0.6, 0.4, 0.5, 0.12), '#98938a', T(0.9, 0.15, 0.4, 1.0, 0.2, 0), { grad: 0.3 });
      }
    });
  });
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * Math.PI * 2;
    const x = U.x + Math.cos(a) * 6.0;
    const z = U.z + Math.sin(a) * 6.0;
    const g = terrainHeight(x, z);
    if (k % 7 === 3) continue; // gaps worn by feet
    B.add('solid', rbox(0.9, 0.16, 0.4, 0.07), k % 2 ? '#a8a597' : '#9a958a', T(x, g + 0.03, z, -a + Math.PI / 2, 0, 0.04 * Math.sin(k * 3)), { jitter: 0.08 });
  }
  // portal pillars + dais
  const [a, b] = archPillars();
  for (const p of [a, b]) {
    const g = terrainHeight(p.x, p.z);
    B.at(T(p.x, g, p.z), () => {
      B.add('solid', rbox(1.4, 0.5, 1.4, 0.14), '#8e8a7e', T(0, 0.2, 0), { grad: 0.3 });
      for (let k = 0; k < 5; k++) B.add('solid', rbox(1.05 - k * 0.04, 0.82, 1.05 - k * 0.04, 0.16), shade('#a39e91', 0.95 + (k % 2) * 0.07), T(0, 0.5 + k * 0.85, 0, k * 0.07), { grad: 0.1 });
      B.add('plant', sphere(0.5, 8, 6), '#6f8a4c', T(0.35, 0.45, 0.3, 0, 0, 0, 1.3, 0.4, 1));
    });
  }
}
