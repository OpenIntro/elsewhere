import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  DECKS,
  FOUNTAIN,
  collidesAt,
  createCollisionWorld,
  dist,
  findNearestWalkable,
  getBuilding,
  getInteractable,
  isGroundWalkable,
  isWalkable,
  resolveMovement,
  type Collider,
  type Vec2,
} from '../src/index.js';

const R = CONFIG.movement.playerRadius;

describe('resolveMovement — synthetic world', () => {
  const circle: Collider = { id: 'c', shape: 'circle', source: 'structure', x: 0, z: 0, radius: 1 };
  const box: Collider = { id: 'b', shape: 'box', source: 'building', x: 10, z: 0, halfWidth: 2, halfDepth: 1, yaw: Math.PI / 4 };
  const w = createCollisionWorld([circle, box], (p) => Math.abs(p.x) < 50 && Math.abs(p.z) < 50);

  it('moves freely in open space', () => {
    const end = resolveMovement({ x: -10, z: -10 }, { x: -12, z: -9 }, R, w);
    expect(end.x).toBeCloseTo(-12, 6);
    expect(end.z).toBeCloseTo(-9, 6);
  });

  it('stops at a circle collider instead of entering it', () => {
    const end = resolveMovement({ x: -5, z: 0 }, { x: 0, z: 0 }, R, w);
    expect(dist(end, { x: 0, z: 0 })).toBeGreaterThanOrEqual(1 + R - 1e-6);
    expect(collidesAt(end, R, w)).toBeNull();
  });

  it('slides around a circle when moving tangentially into it', () => {
    const end = resolveMovement({ x: -3, z: 0.3 }, { x: 3, z: 0.3 }, R, w);
    // Should get past the obstacle rather than stopping dead behind it.
    expect(end.x).toBeGreaterThan(0.5);
    expect(collidesAt(end, R, w)).toBeNull();
  });

  it('does not tunnel through an oriented box on a long move', () => {
    const end = resolveMovement({ x: 5, z: -5 }, { x: 15, z: 5 }, R, w);
    expect(collidesAt(end, R, w)).toBeNull();
    // Box is rotated 45°, blocking the diagonal; we must end on the near side.
    expect(end.x + end.z).toBeLessThan(10 + 0.01);
  });

  it('respects the ground predicate (world edge) and slides along it', () => {
    const end = resolveMovement({ x: 48, z: 0 }, { x: 52, z: 3 }, R, w);
    expect(end.x).toBeLessThan(50);
    expect(end.z).toBeCloseTo(3, 1); // the Z component survives (slide)
  });

  it('is deterministic', () => {
    const a = resolveMovement({ x: -3, z: 0.3 }, { x: 3, z: 0.7 }, R, w);
    const b = resolveMovement({ x: -3, z: 0.3 }, { x: 3, z: 0.7 }, R, w);
    expect(a).toEqual(b);
  });

  it('escapes when starting inside a collider', () => {
    const end = resolveMovement({ x: 0.2, z: 0 }, { x: 0.3, z: 0 }, R, w);
    expect(collidesAt(end, R, w)).toBeNull();
  });

  it('handles NaN input by staying put', () => {
    const end = resolveMovement({ x: 1, z: 20 }, { x: Number.NaN, z: 0 }, R, w);
    expect(end).toEqual({ x: 1, z: 20 });
  });
});

describe('resolveMovement — The Commons', () => {
  it('cannot walk into the fountain basin', () => {
    const end = resolveMovement({ x: 0, z: -6 }, FOUNTAIN.position, R);
    expect(dist(end, FOUNTAIN.position)).toBeGreaterThanOrEqual(FOUNTAIN.basinRadius + R - 1e-6);
  });

  it('cannot walk through Town Hall', () => {
    const hall = getBuilding('town_hall');
    const end = resolveMovement({ x: hall.position.x, z: hall.position.z + 9 }, { x: hall.position.x, z: hall.position.z - 12 }, R);
    expect(end.z).toBeGreaterThan(hall.position.z + hall.depth / 2);
  });

  it('cannot walk off the beach into the sea, but can walk the dock', () => {
    // East of the dock, straight out to sea.
    const offBeach = resolveMovement({ x: 22, z: 44 }, { x: 22, z: 70 }, R);
    expect(isGroundWalkable(offBeach)).toBe(true);
    expect(offBeach.z).toBeLessThan(55);

    const dock = DECKS.find((d) => d.id === 'deck_dock')!;
    const start = { x: dock.center.x, z: dock.center.z - dock.halfLength + 0.5 };
    const end = resolveMovement(start, { x: dock.center.x, z: 62 }, R);
    expect(end.z).toBeCloseTo(62, 3);
    expect(isWalkable(end)).toBe(true);
  });

  it('cannot wade across the creek, but can cross the Mossy Bridge', () => {
    const bridge = DECKS.find((d) => d.id === 'deck_mossy_bridge')!;
    // Upstream of the bridge, straight across the creek (north/south).
    const wade = resolveMovement({ x: -36, z: -41 }, { x: -36, z: -50 }, R);
    expect(wade.z).toBeGreaterThan(-45);

    const fwd = { x: Math.sin(bridge.yaw), z: Math.cos(bridge.yaw) };
    const a: Vec2 = { x: bridge.center.x - fwd.x * (bridge.halfLength + 1.5), z: bridge.center.z - fwd.z * (bridge.halfLength + 1.5) };
    const b: Vec2 = { x: bridge.center.x + fwd.x * (bridge.halfLength + 1.5), z: bridge.center.z + fwd.z * (bridge.halfLength + 1.5) };
    expect(isWalkable(a)).toBe(true);
    expect(isWalkable(b)).toBe(true);
    const crossed = resolveMovement(a, b, R);
    expect(dist(crossed, b)).toBeLessThan(0.05);
  });

  it('findNearestWalkable nudges out of colliders', () => {
    const p = findNearestWalkable(FOUNTAIN.position, R, 8);
    expect(p).not.toBeNull();
    expect(isWalkable(p!)).toBe(true);
  });

  it('seats are reachable: every seat exit is walkable', () => {
    for (const id of ['bench_square_1', 'chair_cafe_1a', 'bench_dock_end', 'bench_garden']) {
      const it = getInteractable(id)!;
      expect('seats' in it).toBe(true);
      if ('seats' in it) for (const s of it.seats) expect(isWalkable(s.exit), `${id} exit`).toBe(true);
    }
  });
});
