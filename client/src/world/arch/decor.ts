/**
 * Renders the shared solid set dressing (shared/world/decor.ts): garden fences
 * with gate posts and the waist-high clutter pieces, at exactly the positions
 * the colliders use.
 */
import { DECOR, FENCES, groundHeight, type DecorPiece } from '@elsewhere/shared';
import { box, cone, cyl, rbox, sphere, T, torus, type GeoBuilder } from '../geom.js';
import { birdbath, wheelbarrow } from './buildings.js';
import { barrel, crate, flowerPatch, P, shade } from './kit.js';

const FENCE_COLORS: Record<string, string> = { house_2: '#e8ebe4', house_5: '#e8ebe4' };

export function buildFences(get: (key: string) => GeoBuilder): void {
  for (const f of FENCES) {
    const B = get(f.buildingId ? `res_${f.buildingId}` : 'misc');
    const color = FENCE_COLORS[f.buildingId] ?? '#efe6d4';
    const len = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    const yaw = Math.atan2(f.b.x - f.a.x, f.b.z - f.a.z);
    const n = Math.max(2, Math.round(len / 0.22));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = f.a.x + (f.b.x - f.a.x) * t;
      const z = f.a.z + (f.b.z - f.a.z) * t;
      const g = groundHeight(x, z);
      const end = i === 0 || i === n;
      if (end) {
        B.add('solid', rbox(0.16, f.height + 0.22, 0.16, 0.04), color, T(x, g + (f.height + 0.22) / 2, z, yaw));
        B.add('solid', sphere(0.1, 8, 6), color, T(x, g + f.height + 0.3, z));
      } else {
        B.add('solid', box(0.09, f.height, 0.05), color, T(x, g + f.height / 2, z, yaw), { jitter: 0.05 });
        B.add('solid', cone(0.065, 0.1, 4), color, T(x, g + f.height + 0.05, z, yaw + Math.PI / 4), { jitter: 0.05 });
      }
    }
    const mx = (f.a.x + f.b.x) / 2;
    const mz = (f.a.z + f.b.z) / 2;
    const gm = groundHeight(mx, mz);
    for (const y of [0.32, 0.75]) B.add('solid', box(0.04, 0.06, len), shade(color, 0.9), T(mx, gm + f.height * y, mz, yaw));
  }
}

function piece(B: GeoBuilder, d: DecorPiece): void {
  switch (d.kind) {
    case 'flower_cart': {
      B.add('solid', rbox(1.6, 0.45, 0.9, 0.06), '#7a5c46', T(0, 0.55, 0));
      for (const s of [-1, 1]) {
        B.add('solid', torus(0.32, 0.05, 6, 16), '#5e4636', T(s * 0.85, 0.34, 0, Math.PI / 2));
        for (let k = 0; k < 4; k++) B.add('solid', box(0.04, 0.6, 0.04), '#6a5040', T(s * 0.85, 0.34, 0, Math.PI / 2, 0, (k / 4) * Math.PI));
      }
      B.add('solid', box(0.05, 0.05, 1.0), '#6a5040', T(0, 0.45, -0.85, 0, -0.25));
      for (let k = 0; k < 3; k++) {
        B.add('solid', rbox(0.46, 0.2, 0.7, 0.04), '#b98f66', T(-0.52 + k * 0.52, 0.88 + (k === 1 ? 0.12 : 0), 0));
        B.at(T(-0.52 + k * 0.52, 0.98 + (k === 1 ? 0.12 : 0), 0), () => flowerPatch(B, 0.38, 0.6, 9, [P.petals[k]!, P.petals[(k + 3) % 6]!, '#f4efe6']));
      }
      B.add('solid', cyl(0.025, 0.025, 1.6, 6), '#e8e0cf', T(0.75, 1.4, 0.35));
      for (let k = 0; k < 8; k++) B.add('solid', cone(0.9, 0.35, 3), k % 2 ? '#5f8f99' : '#efe3cf', T(0.75, 2.25, 0.35, (k / 8) * Math.PI * 2, 0, 0, 0.42, 1, 1), { ao: false });
      return;
    }
    case 'crates':
      crate(B, 0.6, '#b58f62');
      B.at(T(0.0, 0.6, 0.15, 0.3), () => crate(B, 0.5, '#a88257'));
      B.add('solid', sphere(0.32, 10, 8), '#d8c8a2', T(0.05, 0.24, -0.5, 0, 0, 0, 0.85, 0.75, 1));
      return;
    case 'ladder':
      for (const s of [-1, 1]) B.add('solid', rbox(0.06, 3.0, 0.06, 0.02), P.wood, T(0.1, 1.5, s * 0.25, 0, 0, 0.12));
      for (let i = 0; i < 7; i++) B.add('solid', box(0.05, 0.05, 0.5), P.wood, T(0.13 - i * 0.05, 0.3 + i * 0.4, 0));
      return;
    case 'lumber':
      for (let i = 0; i < 4; i++) for (let k = 0; k < 3 - (i > 2 ? 1 : 0); k++) B.add('solid', rbox(0.22, 0.18, 2.6, 0.04), shade('#c49a6a', 0.9 + B.random() * 0.15), T(-0.25 + k * 0.24, 0.1 + i * 0.19, 0));
      return;
    case 'cart_wheel':
      B.add('solid', torus(0.55, 0.06, 8, 20), P.woodDark, T(0, 0.58, 0, Math.PI / 2, -0.15));
      for (let k = 0; k < 6; k++) B.add('solid', box(0.05, 1.05, 0.05), P.wood, T(0, 0.58, 0, Math.PI / 2, -0.15, (k / 6) * Math.PI));
      return;
    case 'gear_pile':
      for (let k = 0; k < 3; k++) B.add('solid', cyl(0.42 - k * 0.09, 0.42 - k * 0.09, 0.08, 12), k % 2 ? P.brass : P.iron, T(k * 0.08, 0.05 + k * 0.09, k * 0.04));
      B.add('solid', torus(0.18, 0.05, 6, 10), P.iron, T(0.1, 0.36, 0.05, 0, Math.PI / 2));
      return;
    case 'sawhorse':
      B.add('solid', rbox(1.4, 0.12, 0.14, 0.03), P.woodLight, T(0, 0.7, 0));
      for (const s of [-1, 1]) for (const t of [-1, 1]) B.add('solid', box(0.08, 0.8, 0.08), P.wood, T(s * 0.55, 0.36, t * 0.18, 0, t * 0.25));
      B.add('solid', rbox(0.9, 0.1, 0.24, 0.03), '#c49a6a', T(0.1, 0.81, 0, 0.2));
      return;
    case 'birdbath':
      return birdbath(B);
    case 'water_barrel':
      barrel(B, 0.32, 0.7, '#7a6a55');
      B.add('glazed', cyl(0.28, 0.28, 0.04, 12), '#5f8f99', T(0, 0.66, 0));
      return;
    case 'wheelbarrow':
      return wheelbarrow(B);
    case 'net_frame':
      for (const s of [-1, 1]) B.add('solid', cyl(0.05, 0.06, 1.6, 6), P.wood, T(s * 1.0, 0.8, 0));
      for (let k = 0; k < 9; k++) B.add('solid', cyl(0.008, 0.008, 1.3, 3), '#c9b18a', T(-0.9 + k * 0.225, 0.95, 0, 0, 0, 0.05 * Math.sin(k)), { ao: false });
      for (let k = 0; k < 6; k++) B.add('solid', cyl(0.008, 0.008, 2.0, 3), '#c9b18a', T(0, 0.45 + k * 0.19 - 0.04 * Math.sin(k), 0, 0, 0, Math.PI / 2), { ao: false });
      B.add('solid', sphere(0.08, 6, 5), '#e98a6b', T(0.4, 0.7, 0.02), { ao: false });
      return;
    case 'rowboat':
      B.add('solid', sphere(1.0, 14, 8), '#5f7c74', T(0, 0.2, 0, 0, 0, 0, 0.62, 0.45, 1.6));
      B.add('solid', sphere(0.92, 14, 8), '#e8e0cf', T(0, 0.3, 0, 0, 0, 0, 0.55, 0.38, 1.5));
      B.add('solid', rbox(1.0, 0.06, 0.25, 0.02), P.woodLight, T(0, 0.48, 0));
      B.add('solid', rbox(0.06, 0.04, 2.0, 0.02), P.woodLight, T(0.3, 0.52, 0.2, 0, 0, 0.2));
      return;
    case 'toppled_stone':
      B.add('solid', rbox(0.9, 0.7, 2.6, 0.24), '#98938a', T(0, 0.3, 0, 0, 0.05, 0.08), { grad: 0.3 });
      B.add('plant', sphere(0.4, 8, 6), '#7d9a55', T(0.2, 0.62, 0.4, 0, 0, 0, 1.4, 0.35, 1.8));
      return;
    case 'ruin_block':
      B.add('solid', rbox(1.3, 0.5, 0.6, 0.14), '#a19c91', T(-0.3, 0.2, 0, 0.3, 0.1, 0.12), { grad: 0.3 });
      B.add('solid', rbox(0.6, 0.4, 0.5, 0.12), '#98938a', T(0.6, 0.15, 0.1, 1.0, 0.2, 0), { grad: 0.3 });
      return;
    case 'footprint':
      return; // drawn by its interactable
  }
}

export function buildDecorPieces(get: (key: string) => GeoBuilder): void {
  for (const d of DECOR) {
    const B = get(d.id.includes('house') ? 'residential' : d.id.includes('workshop') ? 'workshop' : d.id.includes('store') ? 'general_store' : d.id.includes('ruin') || d.id.includes('toppled') ? 'the_unknown' : d.id.includes('cart') ? 'town_square' : 'waterfront');
    B.at(T(d.position.x, groundHeight(d.position.x, d.position.z), d.position.z, d.yaw), () => piece(B, d));
  }
}
