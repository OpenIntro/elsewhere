/**
 * Static collision shapes, derived from the world data so they can never
 * drift from what is rendered. Circles and oriented boxes on the X/Z plane.
 * Consumed by ../collision.ts (client prediction and server validation).
 */
import type { Vec2 } from '../math.js';
import { BUILDINGS, buildingLocal } from './buildings.js';
import { FURNITURE, wallSegments } from './interiors.js';
import { INTERACTABLES, type Interactable } from './interactables.js';
import { ROCKS, TREES } from './nature.js';
import { FOUNTAIN, PROPS, STANDING_STONES, archPillars } from './structures.js';
import { DECOR, FENCES, FENCE_HALF_THICKNESS } from './decor.js';

export type ColliderSource = 'building' | 'wall' | 'furniture' | 'tree' | 'rock' | 'structure' | 'prop' | 'interactable';

export interface CircleCollider {
  id: string;
  shape: 'circle';
  source: ColliderSource;
  x: number;
  z: number;
  radius: number;
}

export interface BoxCollider {
  id: string;
  shape: 'box';
  source: ColliderSource;
  x: number;
  z: number;
  /** Half extent along local X. */
  halfWidth: number;
  /** Half extent along local Z. */
  halfDepth: number;
  yaw: number;
}

export type Collider = CircleCollider | BoxCollider;

function circle(id: string, source: ColliderSource, p: Vec2, radius: number): CircleCollider {
  return { id, shape: 'circle', source, x: p.x, z: p.z, radius };
}

function interactableCollider(i: Interactable): Collider | null {
  switch (i.kind) {
    case 'bench':
      return { id: `col_${i.id}`, shape: 'box', source: 'interactable', x: i.position.x, z: i.position.z, halfWidth: 1.1, halfDepth: 0.3, yaw: i.yaw };
    case 'streetlight':
      return circle(`col_${i.id}`, 'interactable', i.position, 0.22);
    case 'lantern':
    case 'mailbox':
    case 'sign':
      return circle(`col_${i.id}`, 'interactable', i.position, 0.2);
    case 'rune':
      return circle(`col_${i.id}`, 'interactable', i.position, 0.45);
    case 'bell':
    case 'archive':
      return circle(`col_${i.id}`, 'interactable', i.position, 0.35);
    case 'newsstand':
      return circle(`col_${i.id}`, 'interactable', i.position, 0.5);
    default:
      // chairs, doors, pickups, hidden, inspect, fountain (basin below), portal (pillars below)
      return null;
  }
}

function build(): Collider[] {
  const out: Collider[] = [];
  for (const b of BUILDINGS) {
    if (!b.enterable) {
      out.push({ id: `col_${b.id}`, shape: 'box', source: 'building', x: b.position.x, z: b.position.z, halfWidth: b.width / 2, halfDepth: b.depth / 2, yaw: b.yaw });
      continue;
    }
    // Walk-in building: hollow walls with a door gap on the front face (see interiors.ts).
    wallSegments(b).forEach((w, k) => {
      const c = buildingLocal(b, w.at[0], w.at[1]);
      out.push({ id: `col_${b.id}_wall_${w.face}_${k}`, shape: 'box', source: 'wall', x: c.x, z: c.z, halfWidth: w.half[0], halfDepth: w.half[1], yaw: b.yaw });
    });
  }
  for (const f of FURNITURE) {
    if (!f.shape) continue;
    if (f.shape.type === 'circle') out.push(circle(`col_${f.id}`, 'furniture', f.position, f.shape.radius));
    else out.push({ id: `col_${f.id}`, shape: 'box', source: 'furniture', x: f.position.x, z: f.position.z, halfWidth: f.shape.halfWidth, halfDepth: f.shape.halfDepth, yaw: f.yaw });
  }
  out.push(circle('col_fountain', 'structure', FOUNTAIN.position, FOUNTAIN.basinRadius));
  archPillars().forEach((p, idx) => out.push(circle(`col_arch_pillar_${idx + 1}`, 'structure', p, 0.55)));
  for (const s of STANDING_STONES) out.push(circle(`col_${s.id}`, 'structure', s.position, s.radius));
  for (const pr of PROPS) {
    if (pr.shape.type === 'circle') out.push(circle(`col_${pr.id}`, 'prop', pr.position, pr.shape.radius));
    else out.push({ id: `col_${pr.id}`, shape: 'box', source: 'prop', x: pr.position.x, z: pr.position.z, halfWidth: pr.shape.halfWidth, halfDepth: pr.shape.halfDepth, yaw: pr.yaw });
  }
  for (const f of FENCES) {
    const dx = f.b.x - f.a.x;
    const dz = f.b.z - f.a.z;
    out.push({ id: `col_${f.id}`, shape: 'box', source: 'prop', x: (f.a.x + f.b.x) / 2, z: (f.a.z + f.b.z) / 2, halfWidth: FENCE_HALF_THICKNESS, halfDepth: Math.hypot(dx, dz) / 2 + 0.05, yaw: Math.atan2(dx, dz) });
  }
  for (const d of DECOR) {
    if (d.shape.type === 'circle') out.push(circle(`col_${d.id}`, 'prop', d.position, d.shape.radius));
    else out.push({ id: `col_${d.id}`, shape: 'box', source: 'prop', x: d.position.x, z: d.position.z, halfWidth: d.shape.halfWidth, halfDepth: d.shape.halfDepth, yaw: d.yaw });
  }
  for (const i of INTERACTABLES) {
    const c = interactableCollider(i);
    if (c) out.push(c);
  }
  for (const t of TREES) out.push(circle(`col_${t.id}`, 'tree', t.position, t.trunkRadius));
  for (const r of ROCKS) out.push(circle(`col_${r.id}`, 'rock', r.position, r.radius));
  return out;
}

export const COLLIDERS: readonly Collider[] = build();

/** Radius of a circle that bounds the collider (for broad-phase). */
export function colliderBoundingRadius(c: Collider): number {
  return c.shape === 'circle' ? c.radius : Math.hypot(c.halfWidth, c.halfDepth);
}
