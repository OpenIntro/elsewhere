/**
 * Connectivity (not just local walkability): flood-fill the walkable grid
 * from the spawn ring and check every interactable, door, mailbox and seat
 * exit can actually be reached — fences and solid decor must leave gates open.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, FENCES, INTERACTABLES, SPAWN_POINTS, WORLD_BOUNDS, isSeatInteractable, isWalkable } from '../src/index.js';

const STEP = 0.35;
const nx = Math.ceil((WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX) / STEP);
const nz = Math.ceil((WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ) / STEP);
const idx = (i: number, j: number) => j * nx + i;
const toWorld = (i: number, j: number) => ({ x: WORLD_BOUNDS.minX + i * STEP, z: WORLD_BOUNDS.minZ + j * STEP });

function flood(): Uint8Array {
  const walk = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) walk[idx(i, j)] = isWalkable(toWorld(i, j)) ? 1 : 0;
  const seen = new Uint8Array(nx * nz);
  const s = SPAWN_POINTS[0]!.position;
  const si = Math.round((s.x - WORLD_BOUNDS.minX) / STEP);
  const sj = Math.round((s.z - WORLD_BOUNDS.minZ) / STEP);
  const queue = [idx(si, sj)];
  seen[queue[0]!] = 1;
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = idx(a, b);
      if (!seen[n] && walk[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return seen;
}

describe('world connectivity', () => {
  const reached = flood();
  const reachableNear = (p: { x: number; z: number }, r: number) => {
    for (let j = Math.floor((p.z - r - WORLD_BOUNDS.minZ) / STEP); j <= Math.ceil((p.z + r - WORLD_BOUNDS.minZ) / STEP); j++)
      for (let i = Math.floor((p.x - r - WORLD_BOUNDS.minX) / STEP); i <= Math.ceil((p.x + r - WORLD_BOUNDS.minX) / STEP); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
        const w = toWorld(i, j);
        if (Math.hypot(w.x - p.x, w.z - p.z) <= r && reached[idx(i, j)]) return true;
      }
    return false;
  };

  it('fences exist and every interactable is reachable from the spawn ring', () => {
    expect(FENCES.length).toBeGreaterThan(8);
    for (const i of INTERACTABLES) expect(reachableNear(i.position, (i.radius ?? CONFIG.interaction.radius) - 0.2), i.id).toBe(true);
  });

  it('every seat exit is reachable', () => {
    for (const i of INTERACTABLES) if (isSeatInteractable(i)) for (const s of i.seats) expect(reachableNear(s.exit, 0.4), `${i.id} exit`).toBe(true);
  });
});
