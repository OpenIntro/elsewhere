import { describe, expect, it } from 'vitest';
import { BUILDINGS, CONFIG, FENCES, INTERACTABLES, INTERIORS, INTERIOR_SEATS, SPAWN_POINTS, buildingLocal, createCollisionWorld, getInteractable, interiorAt, isWalkable, type Collider, type CollisionWorld, type Vec2 } from '@elsewhere/shared';
import { NavGrid, findPath, pathLength } from '../src/player/pathfinding.js';

const R = CONFIG.movement.playerRadius;

/** Every point along the polyline (sampled every 0.1 m) must be walkable. */
function assertWalkable(from: Vec2, points: readonly Vec2[], world?: CollisionWorld): void {
  let prev = from;
  for (const p of points) {
    const len = Math.hypot(p.x - prev.x, p.z - prev.z);
    const n = Math.max(1, Math.ceil(len / 0.1));
    for (let i = 1; i <= n; i++) {
      const q = { x: prev.x + ((p.x - prev.x) * i) / n, z: prev.z + ((p.z - prev.z) * i) / n };
      expect(isWalkable(q, R, world), `(${q.x.toFixed(2)}, ${q.z.toFixed(2)}) walkable`).toBe(true);
    }
    prev = p;
  }
}

describe('pathfinding (synthetic world)', () => {
  // 40×40 field, a 10×6 "building" in the middle, a lake strip on the east with an islet beyond it.
  const building: Collider = { id: 'b', shape: 'box', source: 'building', x: 0, z: 0, halfWidth: 5, halfDepth: 3, yaw: 0 };
  const ground = (p: Vec2) => Math.abs(p.x) <= 20 && Math.abs(p.z) <= 20 && !(p.x > 12 && p.x < 16);
  const world = createCollisionWorld([building], ground);
  const grid = new NavGrid({ bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 }, world }).build();

  it('walks around a building to reach a point behind it', () => {
    const from = { x: 0, z: -8 };
    const to = { x: 0, z: 8 };
    const res = findPath(grid, from, to)!;
    expect(res).not.toBeNull();
    expect(res.exact).toBe(true);
    expect(res.goal).toEqual(to);
    expect(res.points.at(-1)).toEqual(to);
    // Straight line is 16 m and blocked; the detour must be longer and clear.
    expect(pathLength(from, res.points)).toBeGreaterThan(17);
    assertWalkable(from, res.points, world);
    // Smoothing keeps it to a handful of corners.
    expect(res.points.length).toBeLessThanOrEqual(5);
  });

  it('takes a straight line when nothing is in the way', () => {
    const from = { x: -15, z: -15 };
    const to = { x: -15, z: 15 };
    const res = findPath(grid, from, to)!;
    expect(res.points).toEqual([to]);
  });

  it('a target inside a collider resolves to the nearest reachable point', () => {
    const from = { x: 0, z: -8 };
    const to = { x: 1, z: 0.5 }; // inside the building
    const res = findPath(grid, from, to)!;
    expect(res.exact).toBe(false);
    expect(isWalkable(res.goal, R, world)).toBe(true);
    // Nearest edge of the building from (1, 0.5) is its north/south face at |z| = 3 (+ radius + margin).
    expect(Math.hypot(res.goal.x - to.x, res.goal.z - to.z)).toBeLessThan(3.6);
    assertWalkable(from, res.points, world);
  });

  it('an unreachable target (islet across water) goes to the nearest reachable shore, never through water', () => {
    const from = { x: 0, z: -8 };
    const to = { x: 18, z: 0 }; // islet: walkable ground but disconnected
    const res = findPath(grid, from, to)!;
    expect(res.exact).toBe(false);
    expect(res.goal.x).toBeLessThan(12);
    expect(res.goal.x).toBeGreaterThan(10.5);
    assertWalkable(from, res.points, world);
    for (const p of res.points) expect(p.x).toBeLessThan(12);
  });

  it('targets in the water resolve to the shore', () => {
    const res = findPath(grid, { x: 0, z: -8 }, { x: 14, z: -8 })!;
    expect(res.exact).toBe(false);
    expect(res.goal.x).toBeLessThan(12);
    expect(ground(res.goal)).toBe(true);
  });

  it('a start slightly inside a wall still finds a path', () => {
    const res = findPath(grid, { x: 0, z: -3.2 }, { x: 0, z: -10 });
    expect(res).not.toBeNull();
    expect(res!.exact).toBe(true);
  });
});

describe('pathfinding (real island)', () => {
  const grid = new NavGrid().build();

  it('builds a grid with a large connected island', () => {
    let walk = 0;
    for (const w of grid.walk) walk += w;
    expect(walk).toBeGreaterThan(20_000);
  });

  it('walks from the plaza to behind the Town Hall without clipping it', () => {
    const hall = BUILDINGS.find((b) => b.id === 'town_hall')!;
    const behind = buildingLocal(hall, 0, -hall.depth / 2 - 2.5);
    expect(isWalkable(behind)).toBe(true);
    const from = { x: 0, z: -12 };
    const t0 = performance.now();
    const res = findPath(grid, from, behind)!;
    const ms = performance.now() - t0;
    expect(res).not.toBeNull();
    expect(res.exact).toBe(true);
    assertWalkable(from, res.points);
    expect(pathLength(from, res.points)).toBeGreaterThan(Math.hypot(behind.x - from.x, behind.z - from.z) + 2);
    expect(ms).toBeLessThan(250);
  });

  it('clicking out at sea walks to the beach', () => {
    const from = { x: 0, z: -12 };
    const res = findPath(grid, from, { x: 0, z: 74 })!;
    expect(res.exact).toBe(false);
    expect(isWalkable(res.goal)).toBe(true);
    assertWalkable(from, res.points);
  });

  it('reaches every building door from the plaza (cottages through their garden gates)', () => {
    const from = { x: 0, z: -9 };
    const failures: string[] = [];
    for (const b of BUILDINGS) {
      const door = INTERACTABLES.find((i) => i.id === b.doorId);
      expect(door, `${b.id} door`).toBeDefined();
      const radius = (door!.radius ?? CONFIG.interaction.radius) - 0.35;
      const res = findPath(grid, from, door!.position);
      if (!res) {
        failures.push(`${b.id}: no path`);
        continue;
      }
      const end = res.points.at(-1) ?? from;
      const d = Math.hypot(end.x - door!.position.x, end.z - door!.position.z);
      if (d > radius) failures.push(`${b.id}: path ends ${d.toFixed(2)} m from the door (needs <= ${radius.toFixed(2)})`);
      assertWalkable(from, res.points);
    }
    expect(failures).toEqual([]);
  });

  it('treats 2 m fence gate gaps as passable (grid cells in the gate are walkable)', () => {
    let gates = 0;
    for (const b of BUILDINGS) {
      if (!FENCES.some((f) => f.buildingId === b.id)) continue;
      gates++;
      // Gate centre on the front fence line (decor.ts: front run at local z = depth/2 + 3, gap |x| < 1).
      const mid = buildingLocal(b, 0, b.depth / 2 + 3.0);
      expect(isWalkable(mid), `${b.id} gate centre walkable`).toBe(true);
      expect(grid.walkableAt(mid.x, mid.z), `${b.id} gate centre on the nav grid`).toBe(true);
      // Walking straight through the gate (outside → inside the garden) is possible on the grid.
      const outside = buildingLocal(b, 0, b.depth / 2 + 4.5);
      const inside = buildingLocal(b, 0, b.depth / 2 + 1.5);
      if (isWalkable(outside) && isWalkable(inside)) expect(grid.lineOfSight(outside.x, outside.z, inside.x, inside.z), `${b.id} straight through the gate`).toBe(true);
    }
    expect(gates).toBeGreaterThan(0);
  });

  it('click-to-move routes through doors: plaza → every interior anchor and indoor seat → back out', () => {
    const from = SPAWN_POINTS[0]!.position;
    const failures: string[] = [];
    for (const it of INTERIORS) {
      const targets: [string, Vec2][] = Object.values(it.anchors).map((a) => [a.name, a.position]);
      for (const s of INTERIOR_SEATS.filter((x) => x.interiorId === it.id)) {
        const seat = getInteractable(s.id);
        if (seat && 'seats' in seat) seat.seats.forEach((q, k) => targets.push([`${s.id}#${k}`, q.exit]));
      }
      for (const [name, to] of targets) {
        const res = findPath(grid, from, to);
        // Exact, or (tight spots near furniture on the 0.5 m grid) ending right next to it.
        const miss = res ? Math.hypot(res.goal.x - to.x, res.goal.z - to.z) : Infinity;
        if (!res || miss > 0.45) {
          failures.push(`${it.id}.${name}: ${res ? `ends ${miss.toFixed(2)} m away` : 'no path'}`);
          continue;
        }
        if (interiorAt(res.goal)?.id !== it.id) failures.push(`${it.id}.${name}: ends outside`);
        assertWalkable(from, res.points);
        // the path enters through the door opening (passes within the door's width of its centre)
        const d = it.doors[0]!;
        const near = [from, ...res.points].some((p, i, arr) => {
          if (i === 0) return false;
          const a = arr[i - 1]!;
          for (let t = 0; t <= 1; t += 0.05) if (Math.hypot(a.x + (p.x - a.x) * t - d.position.x, a.z + (p.z - a.z) * t - d.position.z) < d.width / 2 + 0.2) return true;
          return false;
        });
        if (!near) failures.push(`${it.id}.${name}: path does not use the door`);
      }
      // and back out to the plaza from inside
      const back = findPath(grid, it.anchors.entrance!.position, from);
      if (!back || !back.exact) failures.push(`${it.id}: no way back out`);
      else assertWalkable(it.anchors.entrance!.position, back.points);
    }
    expect(failures).toEqual([]);
  });

  it('clicking an indoor seat from outside walks in through the door to its stand-up spot', () => {
    const chair = getInteractable('chair_cafe_in_2b')!;
    expect(interiorAt(chair.position)?.id).toBe('cafe');
    const res = findPath(grid, { x: 10, z: -6 }, INTERIOR_SEATS.find((s) => s.id === chair.id)!.exit)!;
    expect(res.exact).toBe(true);
    expect(interiorAt(res.points.at(-1)!)?.id).toBe('cafe');
    assertWalkable({ x: 10, z: -6 }, res.points);
  });
});
