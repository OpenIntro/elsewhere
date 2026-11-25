/**
 * Solid set dressing: garden fences (with gate gaps) and waist-high clutter
 * (carts, nets, crates, ruins…). Shared so the client renders exactly what
 * client prediction and the server collide with (see colliders.ts).
 * Purely decorative low things (flowers, string lights, steps) are not here.
 *
 * Fences are generated per cottage in its local frame and clipped wherever
 * they would cross a path, a deck, another building or an interactable, so
 * paths always pass through open gaps.
 */
import { distanceToPolyline, rotateOffset, type Vec2 } from '../math.js';
import { BUILDINGS, buildingLocal, getBuilding, type Building } from './buildings.js';
import { INTERACTABLES, getInteractable } from './interactables.js';
import { getLocation } from './locations.js';
import { DECKS, PATHS, deckAt } from './paths.js';

export interface FenceSegment {
  id: string;
  /** Owning building (cottage) or '' for free-standing. */
  buildingId: string;
  a: Vec2;
  b: Vec2;
  /** Visual height. */
  height: number;
}

/** Half thickness of the fence collider. */
export const FENCE_HALF_THICKNESS = 0.12;

export type DecorKind =
  | 'flower_cart'
  | 'net_frame'
  | 'rowboat'
  | 'sawhorse'
  | 'gear_pile'
  | 'lumber'
  | 'crates'
  | 'ladder'
  | 'cart_wheel'
  | 'birdbath'
  | 'water_barrel'
  | 'wheelbarrow'
  | 'toppled_stone'
  | 'ruin_block'
  /** Invisible extra footprint for a wide interactable (its visual is the interactable). */
  | 'footprint';

export interface DecorPiece {
  id: string;
  kind: DecorKind;
  position: Vec2;
  yaw: number;
  shape: { type: 'circle'; radius: number } | { type: 'box'; halfWidth: number; halfDepth: number };
  height: number;
}

// ---------------------------------------------------------------------------
// Fences
// ---------------------------------------------------------------------------

const FENCE_CLEAR_PATH = 0.35;
const FENCE_CLEAR_INTERACTABLE = 0.75;

function blocked(p: Vec2, self: Building): boolean {
  for (const path of PATHS) if (distanceToPolyline(p, path.points) < path.width / 2 + FENCE_CLEAR_PATH) return true;
  if (deckAt(p, -0.4)) return true;
  for (const i of INTERACTABLES) {
    if (i.kind === 'door' || (i.kind === 'mailbox' && i.owner === self.id)) continue;
    if (Math.hypot(i.position.x - p.x, i.position.z - p.z) < FENCE_CLEAR_INTERACTABLE) return true;
  }
  for (const b of BUILDINGS) {
    if (b.id === self.id) continue;
    const dx = p.x - b.position.x;
    const dz = p.z - b.position.z;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    if (Math.abs(lx) < b.width / 2 + 0.6 && Math.abs(lz) < b.depth / 2 + 0.6) return true;
  }
  return false;
}

/** Split a local segment into kept world-space runs (clipped where blocked). */
function clippedRuns(b: Building, la: Vec2, lb: Vec2): [Vec2, Vec2][] {
  const len = Math.hypot(lb.x - la.x, lb.z - la.z);
  const n = Math.max(1, Math.ceil(len / 0.25));
  const runs: [Vec2, Vec2][] = [];
  let start: Vec2 | null = null;
  let last: Vec2 | null = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const w = buildingLocal(b, la.x + (lb.x - la.x) * t, la.z + (lb.z - la.z) * t);
    if (!blocked(w, b)) {
      if (!start) start = w;
      last = w;
    } else if (start && last) {
      runs.push([start, last]);
      start = last = null;
    }
  }
  if (start && last) runs.push([start, last]);
  return runs.filter(([a, c]) => Math.hypot(c.x - a.x, c.z - a.z) >= 0.8);
}

function cottageFences(): FenceSegment[] {
  const out: FenceSegment[] = [];
  for (const b of BUILDINGS) {
    if (b.style !== 'cottage') continue;
    const hx = b.width / 2 + 0.35;
    const z0 = b.depth / 2 + 0.35;
    const z1 = b.depth / 2 + 3.0;
    const gate = 1.0;
    const local: [Vec2, Vec2][] = [
      [{ x: -hx, z: z0 }, { x: -hx, z: z1 }],
      [{ x: hx, z: z0 }, { x: hx, z: z1 }],
      [{ x: -hx, z: z1 }, { x: -gate, z: z1 }],
      [{ x: gate, z: z1 }, { x: hx, z: z1 }],
    ];
    let k = 0;
    for (const [la, lb] of local) for (const [a, c] of clippedRuns(b, la, lb)) out.push({ id: `fence_${b.id}_${++k}`, buildingId: b.id, a, b: c, height: 0.62 });
  }
  return out;
}

export const FENCES: readonly FenceSegment[] = cottageFences();

// ---------------------------------------------------------------------------
// Decor pieces
// ---------------------------------------------------------------------------

function local(b: Building, lx: number, lz: number, localYaw: number): { position: Vec2; yaw: number } {
  return { position: buildingLocal(b, lx, lz), yaw: b.yaw + localYaw };
}
const box = (halfWidth: number, halfDepth: number) => ({ type: 'box' as const, halfWidth, halfDepth });
const circle = (radius: number) => ({ type: 'circle' as const, radius });

function buildDecor(): DecorPiece[] {
  const out: DecorPiece[] = [];
  const add = (id: string, kind: DecorKind, at: { position: Vec2; yaw: number }, shape: DecorPiece['shape'], height: number) => out.push({ id, kind, position: at.position, yaw: at.yaw, shape, height });

  // Town Square: flower cart at the plaza rim, facing the fountain.
  const sq = getLocation('town_square').center;
  const ca = (2 * Math.PI) / 180;
  const cart = { x: sq.x + Math.cos(ca) * 9.6, z: sq.z + Math.sin(ca) * 9.6 };
  add('decor_flower_cart', 'flower_cart', { position: cart, yaw: Math.atan2(sq.x - cart.x, sq.z - cart.z) }, box(1.05, 0.75), 1.0);

  // General Store side clutter.
  const store = getBuilding('general_store');
  add('decor_store_crates', 'crates', local(store, -store.width / 2 - 0.45, -1.6, 0), box(0.5, 0.75), 1.1);
  add('decor_store_ladder', 'ladder', local(store, store.width / 2 + 0.25, 1.8, 0), box(0.25, 0.4), 2.9);

  // Workshop yard.
  const ws = getBuilding('workshop');
  add('decor_workshop_lumber', 'lumber', local(ws, ws.width / 2 + 0.5, 1.0, 0), box(0.42, 1.32), 0.8);
  add('decor_workshop_wheel', 'cart_wheel', local(ws, -ws.width / 2 - 0.25, 1.2, 0), box(0.2, 0.65), 1.2);
  add('decor_workshop_gears', 'gear_pile', local(ws, -ws.width / 2 - 0.9, -1.6, 0), circle(0.5), 0.6);
  add('decor_workshop_sawhorse', 'sawhorse', local(ws, 6.2, 5.0, 0.3), box(0.78, 0.32), 0.85);

  // Cottage yards.
  const yard = (n: number, kind: DecorKind, lx: number, shape: DecorPiece['shape'], h: number, yaw = 0) => {
    const b = getBuilding(`house_${n}`);
    add(`decor_house_${n}_${kind}`, kind, local(b, lx, b.depth / 2 + 2.2, yaw), shape, h);
  };
  yard(5, 'water_barrel', 2.3, circle(0.36), 0.75);
  yard(4, 'wheelbarrow', 2.3, box(0.42, 0.7), 0.7, 0.4);

  // Waterfront.
  add('decor_net_frame', 'net_frame', { position: { x: -0.2, z: 46.6 }, yaw: 1.4 }, box(1.08, 0.14), 1.6);
  add('decor_rowboat', 'rowboat', { position: { x: -1.0, z: 50.2 }, yaw: 1.1 }, box(0.62, 1.5), 0.6);

  // The Unknown: ruins.
  add('decor_toppled_stone', 'toppled_stone', { position: { x: -5.5, z: -69.0 }, yaw: 0.6 }, box(0.5, 1.32), 0.7);
  add('decor_ruin_1', 'ruin_block', { position: { x: -16.6, z: -66.4 }, yaw: 2.1 }, box(1.05, 0.55), 0.6);
  add('decor_ruin_2', 'ruin_block', { position: { x: -4.0, z: -57.2 }, yaw: 1.2 }, box(1.05, 0.55), 0.6);

  // Wide interactables whose point collider undersells their body.
  const foot = (id: string, lx: number, lz: number, hw: number, hd: number, h: number) => {
    const i = getInteractable(id);
    if (!i) return;
    const o = rotateOffset({ x: lx, z: lz }, i.yaw);
    add(`footprint_${id}`, 'footprint', { position: { x: i.position.x + o.x, z: i.position.z + o.z }, yaw: i.yaw }, box(hw, hd), h);
  };
  foot('sign_welcome', 0, 0.05, 1.42, 0.3, 2.3);
  foot('sign_notice_board', 0, 0, 0.9, 0.18, 2.3);
  foot('archive_town_hall', 0.2, 0.05, 0.75, 0.4, 2.1);
  return out;
}

export const DECOR: readonly DecorPiece[] = buildDecor();

/** Keep in sync for nature generation (trees/rocks avoid these). */
export const DECOR_OBSTACLES: readonly { p: Vec2; r: number }[] = [
  ...FENCES.map((f) => ({ p: { x: (f.a.x + f.b.x) / 2, z: (f.a.z + f.b.z) / 2 }, r: Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z) / 2 + 0.8 })),
  ...DECOR.map((d) => ({ p: d.position, r: (d.shape.type === 'circle' ? d.shape.radius : Math.hypot(d.shape.halfWidth, d.shape.halfDepth)) + 0.8 })),
];

void DECKS;
