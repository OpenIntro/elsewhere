/**
 * Small intentional set dressing (non-solid, placed clear of colliders,
 * paths and interactables): flower beds in the square, woodland oddities,
 * beach clutter, garden washing line, milestones along the paths.
 */
import {
  CREEK_POINTS,
  INTERACTABLES,
  PATHS,
  collidesAt,
  interiorAt,
  distanceToPolyline,
  getLocation,
  groundHeight,
  inlandDistance,
  mulberry32,
  terrainHeight,
  type Vec2,
} from '@elsewhere/shared';
import { cone, cyl, rbox, sphere, T, torus, type GeoBuilder } from '../geom.js';
import { anchors, crate, flowerPatch, P, shade, shrub, worldPoint } from './kit.js';

function pathDist(p: Vec2): number {
  let d = Infinity;
  for (const path of PATHS) d = Math.min(d, distanceToPolyline(p, path.points) - path.width / 2);
  return d;
}
function nearInteractable(p: Vec2, r: number): boolean {
  return INTERACTABLES.some((i) => Math.hypot(i.position.x - p.x, i.position.z - p.z) < r);
}
/** A spot that blocks nothing and covers nothing important. */
export function clearSpot(p: Vec2, r = 0.6, pathClear = 0.4): boolean {
  if (inlandDistance(p.x, p.z) < 0.5) return false;
  if (collidesAt(p, r)) return false;
  if (interiorAt(p, r + 0.3)) return false;
  if (pathDist(p) < pathClear) return false;
  if (nearInteractable(p, r + 0.9)) return false;
  return true;
}

function at(B: GeoBuilder, p: Vec2, yaw: number, fn: () => void): void {
  B.at(T(p.x, groundHeight(p.x, p.z), p.z, yaw), fn);
}

function crateGeoPlaceholder() {
  return rbox(0.45, 0.4, 0.45, 0.05);
}

function mushroom(B: GeoBuilder, s: number, cap: string): void {
  B.add('solid', cyl(0.05 * s, 0.07 * s, 0.24 * s, 8), '#efe6d2', T(0, 0.12 * s, 0));
  B.add('solid', sphere(0.16 * s, 10, 6), cap, T(0, 0.25 * s, 0, 0, 0, 0, 1, 0.6, 1), { ao: false });
  for (let k = 0; k < 4; k++) B.add('solid', sphere(0.025 * s, 5, 4), '#f6f1e6', T(Math.cos(k * 1.7) * 0.09 * s, 0.32 * s, Math.sin(k * 1.7) * 0.09 * s), { ao: false });
}

function log(B: GeoBuilder, len: number, r: number): void {
  B.add('solid', cyl(r, r * 1.05, len, 12), '#7a5c46', T(0, r, 0, 0, 0, Math.PI / 2));
  for (const s of [-1, 1]) B.add('solid', cyl(r * 0.92, r * 0.92, 0.02, 12), '#c7a77e', T((s * len) / 2, r, 0, 0, 0, Math.PI / 2), { ao: false });
  B.add('plant', sphere(r * 0.9, 8, 6), '#6f8a4c', T(len * 0.15, r * 1.7, 0, 0, 0, 0, 2.2, 0.4, 1));
}

export function buildDressing(get: (key: string) => GeoBuilder): void {
  const rnd = mulberry32(0x5eed);

  // --- Town Square: curved flower beds between benches near the plaza rim -------
  const sq = getLocation('town_square').center;
  const S = get('town_square');
  for (const deg of [-63, -122, 112, 180, 42]) {
    const a = (deg * Math.PI) / 180;
    const p = { x: sq.x + Math.cos(a) * 10.9, z: sq.z + Math.sin(a) * 10.9 };
    at(S, p, Math.atan2(sq.x - p.x, sq.z - p.z), () => {
      // concentric with the plaza: centre is at local (0, 10.9)
      const R = 10.9;
      for (const off of [-0.5, 0.5]) {
        const rr = R - off;
        for (let k = -3; k <= 3; k++) {
          const t = (k * 0.29) / rr * 2.2;
          S.add('solid', rbox(0.62, 0.2, 0.2, 0.07), P.stone, T(Math.sin(t) * rr, 0.1, R - Math.cos(t) * rr, -t), { jitter: 0.06 });
        }
      }
      S.add('solid', rbox(3.9, 0.1, 0.85, 0.05), P.soil, T(0, 0.05, 0.02));
      S.at(T(0, 0.06, 0.02), () => flowerPatch(S, 3.5, 0.65, 24));
    });
  }
  // --- Woods: mushroom rings, logs, a fairy door, a teacup, glowing caps ----------
  const W = get('woods');
  const woods = getLocation('woods');
  let placed = 0;
  for (let attempt = 0; attempt < 600 && placed < 26; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * (woods.radius + 4);
    const p = { x: woods.center.x + Math.cos(a) * r, z: woods.center.z + Math.sin(a) * r };
    if (!clearSpot(p, 0.5, 0.3)) continue;
    if (distanceToPolyline(p, CREEK_POINTS) < 3.4) continue;
    placed++;
    const kind = placed % 6;
    at(W, p, rnd() * 6.28, () => {
      if (kind === 0) {
        for (let k = 0; k < 7; k++) W.at(T(Math.cos(k * 0.9) * 0.6, 0, Math.sin(k * 0.9) * 0.6), () => mushroom(W, 0.8 + rnd() * 0.5, k % 2 ? '#b9563f' : '#c9744f'));
      } else if (kind === 1 || kind === 4) {
        for (let k = 0; k < 3; k++) W.at(T(rnd() * 0.5, 0, rnd() * 0.5), () => mushroom(W, 0.7 + rnd() * 0.6, ['#b9563f', '#d8b07a', '#e7d8c0'][k]!));
      } else if (kind === 2) {
        log(W, 1.6 + rnd(), 0.22 + rnd() * 0.08);
      } else if (kind === 3) {
        W.add('plant', sphere(0.35, 8, 6), '#5f7a4b', T(0, 0.08, 0, 0, 0, 0, 1.5, 0.4, 1.2));
        W.add('solid', sphere(0.25, 8, 6), '#8e8a7e', T(0.2, 0.12, 0.1, 0, 0, 0, 1.2, 0.7, 1));
      } else {
        // glow caps (subtle bioluminescent mushrooms)
        for (let k = 0; k < 4; k++) {
          const q = { x: rnd() * 0.6 - 0.3, z: rnd() * 0.6 - 0.3 };
          W.at(T(q.x, 0, q.z), () => mushroom(W, 0.55, '#7fb7a8'));
          anchors.sparkles.push({ id: 'glowcap', position: worldPoint(W, q.x, 0.18, q.z), subtle: true });
        }
      }
    });
  }
  // fairy door at the foot of a hill-top tree spot (fixed, findable)
  const fd = { x: -41.2, z: -33.4 };
  if (clearSpot(fd, 0.4, 0.2)) {
    at(W, fd, 0.9, () => {
      W.add('solid', rbox(0.7, 0.3, 0.3, 0.1), '#7a5c46', T(0, 0.15, -0.12));
      W.add('solid', cyl(0.18, 0.18, 0.06, 12, false), '#7a3f36', T(0, 0.2, 0.04, 0, Math.PI / 2));
      W.add('solid', rbox(0.36, 0.2, 0.06, 0.02), '#7a3f36', T(0, 0.1, 0.04));
      W.add('solid', sphere(0.02, 5, 4), P.brass, T(0.1, 0.12, 0.08), { ao: false });
      W.addRaw('window', cyl(0.04, 0.04, 0.02, 8), [1, 0.2, 0], T(-0.22, 0.24, 0.05, 0, Math.PI / 2));
      for (let k = 0; k < 3; k++) W.add('solid', rbox(0.14, 0.03, 0.1, 0.01), P.stone, T(0, 0.015, 0.18 + k * 0.12));
    });
  }
  // a teacup on a mossy rock near the loop (odd object)
  const tc = { x: -37.4, z: -21.2 };
  if (clearSpot(tc, 0.4, 0.3)) {
    at(W, tc, 0, () => {
      W.add('solid', sphere(0.32, 10, 8), '#8e8a7e', T(0, 0.18, 0, 0, 0, 0, 1.2, 0.6, 1));
      W.add('glazed', cyl(0.09, 0.06, 0.1, 12), '#efe8e2', T(0.05, 0.42, 0));
      W.add('glazed', torus(0.04, 0.012, 4, 8), '#efe8e2', T(0.15, 0.43, 0));
      W.add('glazed', cyl(0.14, 0.14, 0.015, 14), '#efe8e2', T(0.05, 0.37, 0));
    });
  }

  // --- Waterfront: rowboat pulled up, beach towel + umbrella, nets, shells ------
  const F = get('waterfront');
  const towel = { x: 22.5, z: 48.5 };
  if (clearSpot(towel, 0.8, 0.4)) {
    at(F, towel, 0.4, () => {
      F.add('solid', rbox(0.9, 0.03, 1.7, 0.01), '#e98a6b', T(0, 0.02, 0));
      for (let k = 0; k < 4; k++) F.add('solid', rbox(0.9, 0.032, 0.14, 0.01), '#f4efe6', T(0, 0.022, -0.6 + k * 0.4));
      F.add('solid', cyl(0.025, 0.025, 2.1, 6), '#e8e0cf', T(-0.7, 1.0, 0.2, 0, 0, 0.12));
      for (let k = 0; k < 8; k++) F.add('solid', cone(1.0, 0.4, 3), k % 2 ? '#5f8f99' : '#f4efe6', T(-0.58, 2.05, 0.2, (k / 8) * Math.PI * 2, 0, 0.12, 0.42, 1, 1), { ao: false });
    });
  }
  for (let k = 0; k < 16; k++) {
    const a = rnd() * Math.PI * 2;
    const r = 6 + rnd() * 10;
    const p = { x: 12 + Math.cos(a) * r, z: 46 + Math.sin(a) * r * 0.6 };
    const h = terrainHeight(p.x, p.z);
    if (h < 0.15 || h > 1.2 || !clearSpot(p, 0.2, 0.2)) continue;
    at(F, p, rnd() * 6, () => {
      if (k % 3 === 0) F.add('solid', sphere(0.08, 8, 5), '#e9cdb8', T(0, 0.03, 0, 0, 0, 0, 1, 0.5, 1.2), { ao: false });
      else F.add('solid', sphere(0.12 + rnd() * 0.1, 8, 6), '#a8a294', T(0, 0.04, 0, 0, 0, 0, 1.3, 0.5, 1), { ao: false });
    });
  }
  // --- Residential: washing line between houses 1 and 2, a garden shed ----------
  const R = get('residential');
  const l0 = { x: -33.6, z: 3.0 };
  const l1 = { x: -37.6, z: 3.4 };
  if (clearSpot(l0, 0.2, 0.2) && clearSpot(l1, 0.2, 0.2)) {
    const y0 = groundHeight(l0.x, l0.z);
    for (const p of [l0, l1]) at(R, p, 0, () => R.add('solid', cyl(0.04, 0.05, 1.9, 6), P.wood, T(0, 0.95, 0)));
    const dx = l1.x - l0.x;
    const dz = l1.z - l0.z;
    const yaw = Math.atan2(dx, dz);
    R.at(T(l0.x, y0, l0.z, yaw), () => {
      const len = Math.hypot(dx, dz);
      R.add('solid', cyl(0.008, 0.008, len, 3), '#e8e4d8', T(0, 1.75, len / 2, 0, Math.PI / 2), { ao: false });
      const cloth = ['#e7a0a6', '#f4efe6', '#9fc0e8', '#f1d27a', '#b9a2d8'];
      for (let k = 0; k < 5; k++) R.add('plant', rbox(0.04, 0.45 + (k % 2) * 0.15, 0.5, 0.02), cloth[k]!, T(0, 1.5 - (k % 2) * 0.07, 0.6 + k * 0.62), { ao: false });
    });
  }
  // stone milestones + small way-markers along the longer paths
  const M = get('misc');
  for (const path of PATHS) {
    if (path.points.length < 4) continue;
    const mid = path.points[Math.floor(path.points.length / 2)]!;
    const nxt = path.points[Math.floor(path.points.length / 2) + 1]!;
    const dir = { x: nxt.x - mid.x, z: nxt.z - mid.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const side = { x: -dir.z / len, z: dir.x / len };
    const p = { x: mid.x + side.x * (path.width / 2 + 0.7), z: mid.z + side.z * (path.width / 2 + 0.7) };
    if (!clearSpot(p, 0.35, 0.3)) continue;
    at(M, p, Math.atan2(side.x, side.z), () => {
      M.add('solid', rbox(0.32, 0.55, 0.22, 0.1), '#b3a893', T(0, 0.26, 0), { grad: 0.3 });
      M.add('solid', sphere(0.16, 8, 6), '#b3a893', T(0, 0.54, 0, 0, 0, 0, 1, 0.6, 0.7));
      M.add('plant', sphere(0.22, 8, 6), '#7d9a55', T(0.2, 0.05, 0.1, 0, 0, 0, 1, 0.5, 1));
    });
  }
  // Workshop yard: sawhorse + gear pile (non-solid, clear spots)
  const K = get('workshop');
  void shade;
}
