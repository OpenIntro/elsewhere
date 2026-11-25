/**
 * Trees, rocks and bushes. Generated deterministically (fixed seed) at module
 * load, avoiding paths, the creek, buildings, decks, interactables and the
 * built-up location pads, so client and server get identical lists. The
 * world worker may replace generation with hand-placed data later as long as
 * the exported shapes stay the same.
 */
import { dist, distanceToPolyline, mulberry32, type Vec2 } from '../math.js';
import { BUILDINGS } from './buildings.js';
import { INTERACTABLES } from './interactables.js';
import { LOCATIONS, getLocation } from './locations.js';
import { DECKS, PATHS } from './paths.js';
import { FOUNTAIN, PROPS, STANDING_STONES } from './structures.js';
import { DECOR_OBSTACLES } from './decor.js';
import { CREEK_BANK_HALF_WIDTH, CREEK_POINTS, inlandDistance, terrainHeight } from './terrain.js';

export type TreeKind = 'pine' | 'oak' | 'birch' | 'fruit';

export interface Tree {
  id: string;
  kind: TreeKind;
  position: Vec2;
  /** Overall scale (1 ≈ 5–6 units tall). */
  scale: number;
  /** Visual yaw for variety. */
  yaw: number;
  /** Trunk collider radius. */
  trunkRadius: number;
}

export interface Rock {
  id: string;
  position: Vec2;
  scale: number;
  yaw: number;
  radius: number;
}

export interface Bush {
  id: string;
  position: Vec2;
  scale: number;
  kind: 'shrub' | 'fern' | 'flowers' | 'reeds';
}

interface Obstacle {
  p: Vec2;
  r: number;
}

function staticObstacles(): Obstacle[] {
  const out: Obstacle[] = [];
  for (const b of BUILDINGS) out.push({ p: b.position, r: Math.hypot(b.width, b.depth) / 2 + 2.5 });
  for (const i of INTERACTABLES) out.push({ p: i.position, r: 2.4 });
  for (const s of STANDING_STONES) out.push({ p: s.position, r: 2.2 });
  for (const pr of PROPS) out.push({ p: pr.position, r: 2 });
  for (const d of DECKS) out.push({ p: d.center, r: Math.max(d.halfLength, d.halfWidth) + 2 });
  out.push({ p: FOUNTAIN.position, r: FOUNTAIN.basinRadius + 4 });
  for (const o of DECOR_OBSTACLES) out.push(o);
  return out;
}

function clearOf(p: Vec2, obstacles: Obstacle[], pathClearance: number): boolean {
  for (const o of obstacles) if (dist(p, o.p) < o.r) return false;
  for (const path of PATHS) if (distanceToPolyline(p, path.points) < path.width / 2 + pathClearance) return false;
  if (distanceToPolyline(p, CREEK_POINTS) < CREEK_BANK_HALF_WIDTH + 0.8) return false;
  return true;
}

function insidePad(p: Vec2, scale = 1): boolean {
  for (const l of LOCATIONS) {
    if (!l.flatten) continue;
    if (dist(p, l.center) < l.radius * scale) return true;
  }
  return false;
}

function generate(): { trees: Tree[]; rocks: Rock[]; bushes: Bush[] } {
  const rnd = mulberry32(0xe15e);
  const obstacles = staticObstacles();
  const trees: Tree[] = [];
  const rocks: Rock[] = [];
  const bushes: Bush[] = [];
  const spacingOk = (p: Vec2, min: number) => trees.every((t) => dist(t.position, p) >= min) && rocks.every((r) => dist(r.position, p) >= min * 0.8);

  const addTree = (p: Vec2, kind: TreeKind, scale: number) => {
    trees.push({ id: `tree_${trees.length + 1}`, kind, position: p, scale, yaw: rnd() * Math.PI * 2, trunkRadius: 0.32 * scale + 0.1 });
  };

  // Dense woods (+ the promontory approach to The Unknown).
  const woods = getLocation('woods');
  const unknown = getLocation('the_unknown');
  for (let attempt = 0; attempt < 4000 && trees.length < 115; attempt++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * (woods.radius + 6);
    const p = { x: woods.center.x + Math.cos(a) * r, z: woods.center.z + Math.sin(a) * r };
    if (inlandDistance(p.x, p.z) < 2.5 || terrainHeight(p.x, p.z) < 0.4) continue;
    if (dist(p, unknown.center) < unknown.radius + 2) continue;
    if (insidePad(p, 1.05)) continue;
    if (!clearOf(p, obstacles, 1.4)) continue;
    if (!spacingOk(p, 2.5)) continue;
    const roll = rnd();
    addTree(p, roll < 0.72 ? 'pine' : roll < 0.9 ? 'birch' : 'oak', 0.8 + rnd() * 0.6);
  }

  // Scattered trees across the rest of the island.
  for (let attempt = 0; attempt < 4000 && trees.length < 175; attempt++) {
    const p = { x: -60 + rnd() * 122, z: -66 + rnd() * 116 };
    if (inlandDistance(p.x, p.z) < 4 || terrainHeight(p.x, p.z) < 0.4) continue;
    if (dist(p, woods.center) < woods.radius + 6) continue;
    if (insidePad(p, 1.3)) continue; // keep plazas and their edges open
    if (!clearOf(p, obstacles, 2.2)) continue;
    if (!spacingOk(p, 5)) continue;
    const nearRes = dist(p, getLocation('residential').center) < 26;
    const roll = rnd();
    addTree(p, nearRes && roll < 0.35 ? 'fruit' : roll < 0.55 ? 'oak' : roll < 0.8 ? 'birch' : 'pine', 0.8 + rnd() * 0.5);
  }

  // Rocks: some on beaches, some in the woods and near The Unknown.
  for (let attempt = 0; attempt < 3000 && rocks.length < 40; attempt++) {
    const p = { x: -62 + rnd() * 126, z: -76 + rnd() * 128 };
    const inland = inlandDistance(p.x, p.z);
    if (inland < 0.3 || inland > 30) continue;
    if (insidePad(p, 0.95)) continue;
    if (!clearOf(p, obstacles, 1.5)) continue;
    if (!spacingOk(p, 3)) continue;
    const scale = 0.5 + rnd() * 1.1;
    rocks.push({ id: `rock_${rocks.length + 1}`, position: p, scale, yaw: rnd() * Math.PI * 2, radius: 0.55 * scale });
  }

  // Bushes / ferns / flowers / reeds: decorative only (no collision).
  for (let attempt = 0; attempt < 3000 && bushes.length < 140; attempt++) {
    const p = { x: -62 + rnd() * 126, z: -76 + rnd() * 128 };
    const inland = inlandDistance(p.x, p.z);
    if (inland < 0.5) continue;
    if (!clearOf(p, obstacles.map((o) => ({ p: o.p, r: o.r * 0.6 })), 0.4)) continue;
    const inWoods = dist(p, woods.center) < woods.radius + 4;
    const nearCreek = distanceToPolyline(p, CREEK_POINTS) < CREEK_BANK_HALF_WIDTH + 2.5;
    const kind: Bush['kind'] = nearCreek ? 'reeds' : inWoods ? 'fern' : rnd() < 0.4 ? 'flowers' : 'shrub';
    bushes.push({ id: `bush_${bushes.length + 1}`, position: p, scale: 0.6 + rnd() * 0.7, kind });
  }

  return { trees, rocks, bushes };
}

const generated = generate();
export const TREES: readonly Tree[] = generated.trees;
export const ROCKS: readonly Rock[] = generated.rocks;
export const BUSHES: readonly Bush[] = generated.bushes;
