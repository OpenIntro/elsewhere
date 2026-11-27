/**
 * Built interiors: the room a point stands in (roofed union / walled
 * rectangle), its outline walls, what is above its storey, and the doorway
 * hysteresis.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, ENCLOSURE_ENTER, ENCLOSURE_LEAVE, NO_ENCLOSURE, PieceIndex, enclosureAt, enclosureDepth, enclosureHysteresis, roofParamsString, trackEnclosure, type PieceKind, type PieceLike } from '@elsewhere/shared';

const H = CONFIG.building.storeyHeight;

function piece(kind: PieceKind, x: number, z: number, rot = 0, level = 0, ownerId = 'ivy', extra: Partial<PieceLike> = {}): PieceLike {
  return { id: `${kind}@${x},${z},${level}${rot % 2 ? 'v' : ''}`, kind, x, z, rot, level, y: level * H, ownerId, ...extra };
}
function roof(x: number, z: number, w: number, d: number, rot = 0, level = 1, ownerId = 'ivy'): PieceLike {
  return piece('house_roof', x, z, rot, level, ownerId, { params: roofParamsString({ w, d, style: 'gable', pitch: 1 }), id: `roof@${x},${z},${level}` });
}
/** Walls around x0..x1 × z0..z1 (2 m pieces), with optional replacements by position ("x,z" → kind) and sides left open. */
function walls(x0: number, z0: number, x1: number, z1: number, opts: { level?: number; owner?: string; kinds?: Record<string, PieceKind>; open?: ('n' | 's' | 'w' | 'e')[]; skip?: string[] } = {}): PieceLike[] {
  const out: PieceLike[] = [];
  const lv = opts.level ?? 0;
  const add = (x: number, z: number, rot: number) => {
    const k = `${x},${z}`;
    if (opts.skip?.includes(k)) return;
    out.push(piece(opts.kinds?.[k] ?? 'wall', x, z, rot, lv, opts.owner ?? 'ivy'));
  };
  for (let x = x0 + 1; x < x1; x += 2) {
    if (!opts.open?.includes('n')) add(x, z0, 0);
    if (!opts.open?.includes('s')) add(x, z1, 0);
  }
  for (let z = z0 + 1; z < z1; z += 2) {
    if (!opts.open?.includes('w')) add(x0, z, 1);
    if (!opts.open?.includes('e')) add(x1, z, 1);
  }
  return out;
}
function index(...lists: (PieceLike | PieceLike[])[]): PieceIndex {
  const ix = new PieceIndex();
  for (const l of lists) for (const p of Array.isArray(l) ? l : [l]) ix.add(p);
  return ix;
}
const ids = (l: readonly { id: string }[]) => l.map((w) => w.id).sort();

/** 4 × 4 hut, wall lines x 0..4, z 0..4; doorway + window on the south side; one house roof. */
function hut(ox = 0, oz = 0, owner = 'ivy', withRoof = true): PieceLike[] {
  const out = walls(ox, oz, ox + 4, oz + 4, { owner, kinds: { [`${ox + 1},${oz + 4}`]: 'doorway', [`${ox + 3},${oz + 4}`]: 'wall_window' } });
  if (withRoof) out.push(roof(ox + 2, oz + 2, 4, 4, 0, 1, owner));
  return out;
}

/** The L house of scripts/lib/plans2.mjs at c = (0, 0): main block x -3..3 z -2..2, wing x -1..3 z 2..6, two crossing roofs. */
function lHouse(): PieceLike[] {
  const out = walls(-3, -2, 3, 2, { kinds: { '-2,2': 'doorway' }, skip: ['0,2', '2,2'] });
  out.push(...walls(-1, 2, 3, 6, { open: ['n'], kinds: { '0,6': 'wall_window', '3,5': 'wall_window' } }));
  out.push(roof(0, 0, 4, 6, 1), roof(1, 3, 4, 6, 0));
  return out;
}

describe('enclosureAt', () => {
  it('a 4x4 hut with a doorway and a house roof is one roofed room with its 8 walls', () => {
    const ix = index(hut());
    const e = enclosureAt(ix, { x: 2, z: 2 })!;
    expect(e).not.toBeNull();
    expect(e.kind).toBe('roofed');
    expect(e.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    expect(e.storey).toBe(0);
    expect(e.walls.length).toBe(8);
    expect(e.walls.find((w) => w.kind === 'doorway')!.normals).toEqual([{ x: 0, z: 1 }]);
    expect(e.walls.find((w) => w.id === 'wall@0,1,0v')!.normals).toEqual([{ x: -1, z: 0 }]);
    expect(e.above).toEqual(['roof@2,2,1']);
    // In the doorway (on the wall line) still in it; a step outside not.
    expect(enclosureAt(ix, { x: 1, z: 3.9 })).not.toBeNull();
    expect(enclosureAt(ix, { x: 1, z: 4.3 })).toBeNull();
  });

  it('standing outside a house → null', () => {
    const ix = index(hut());
    expect(enclosureAt(ix, { x: 6, z: 2 })).toBeNull();
    expect(enclosureAt(ix, { x: 2, z: -1.5 })).toBeNull();
    expect(enclosureAt(ix, { x: -3, z: 7 })).toBeNull();
  });

  it('an L house with two roofs is ONE room (the union), from either leg', () => {
    const ix = index(lHouse());
    for (const p of [{ x: -2, z: 0 }, { x: 1, z: 4.5 }, { x: 1, z: 1.5 }]) {
      const e = enclosureAt(ix, p)!;
      expect(e, `at ${p.x},${p.z}`).not.toBeNull();
      expect(e.kind).toBe('roofed');
      expect(e.parts.length).toBe(2);
      expect(e.rect).toEqual({ minX: -3, maxX: 3, minZ: -2, maxZ: 6 });
      expect(e.walls.length).toBe(14);
      expect(e.above.sort()).toEqual(['roof@0,0,1', 'roof@1,3,1']);
    }
    // The L's empty corner (x -3..-1, z 2..6) is outside it.
    expect(enclosureAt(ix, { x: -2, z: 4 })).toBeNull();
  });

  it('a roofless room walled on 3 sides is a (walled) room', () => {
    const ix = index(walls(0, 0, 4, 4, { open: ['s'] }));
    const e = enclosureAt(ix, { x: 2, z: 2 })!;
    expect(e).not.toBeNull();
    expect(e.kind).toBe('walled');
    expect(e.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    expect(e.walls.length).toBe(6);
    expect(e.above).toEqual([]);
    // Fully walled and roofless: a room as well.
    expect(enclosureAt(index(walls(0, 0, 6, 4)), { x: 3, z: 2 })?.rect).toEqual({ minX: 0, maxX: 6, minZ: 0, maxZ: 4 });
    // Walled on two sides only: not a room.
    expect(enclosureAt(index(walls(0, 0, 4, 4, { open: ['s', 'e'] })), { x: 2, z: 2 })).toBeNull();
  });

  it('an open porch (3 walls + roof) is a room', () => {
    const ix = index(walls(0, 0, 4, 4, { open: ['s'] }), roof(2, 2, 4, 4));
    const e = enclosureAt(ix, { x: 2, z: 3.5 })!;
    expect(e.kind).toBe('roofed');
    expect(e.walls.length).toBe(6);
    expect(e.above).toEqual(['roof@2,2,1']);
  });

  it('a ring of fences is not a room', () => {
    const ix = new PieceIndex();
    for (const p of walls(0, 0, 4, 4)) ix.add({ ...p, kind: 'fence', id: p.id.replace('wall', 'fence') });
    expect(enclosureAt(ix, { x: 2, z: 2 })).toBeNull();
  });

  it('a 14 m walled square is too big to be a room (cap 12 m)', () => {
    expect(enclosureAt(index(walls(0, 0, 14, 14)), { x: 7, z: 7 })).toBeNull();
    expect(enclosureAt(index(walls(0, 0, 14, 14)), { x: 2, z: 2 })).toBeNull();
    expect(enclosureAt(index(walls(0, 0, 12, 12)), { x: 6, z: 6 })?.rect).toEqual({ minX: 0, maxX: 12, minZ: 0, maxZ: 12 });
  });

  it("two neighbouring huts of different owners sharing a wall: standing in one never selects the other's far walls", () => {
    for (const roofed of [true, false]) {
      // Hut A x 0..4 (Ivy), hut B x 4..8 (Rowan) — B uses A's east wall.
      const a = hut(0, 0, 'ivy', roofed);
      const b = walls(4, 0, 8, 4, { owner: 'rowan', open: ['w'], kinds: { '5,4': 'doorway' } });
      if (roofed) b.push(roof(6, 2, 4, 4, 0, 1, 'rowan'));
      const ix = index(a, b);
      const ea = enclosureAt(ix, { x: 2, z: 2 })!;
      expect(ea.rect, `roofed ${roofed}`).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
      expect(ids(ea.walls)).toEqual(ids(a.filter((p) => p.kind !== 'house_roof')));
      expect(ea.walls.find((w) => w.id === 'wall@4,1,0v')!.normals).toEqual([{ x: 1, z: 0 }]);
      expect(ea.above).toEqual(roofed ? ['roof@2,2,1'] : []);
      const eb = enclosureAt(ix, { x: 6, z: 2 })!;
      expect(eb.rect).toEqual({ minX: 4, maxX: 8, minZ: 0, maxZ: 4 });
      for (const w of eb.walls) expect(w.id.startsWith('wall@4,') || b.some((p) => p.id === w.id), w.id).toBe(true);
      expect(eb.walls.find((w) => w.id === 'wall@4,1,0v')!.normals).toEqual([{ x: -1, z: 0 }]);
    }
  });

  it('two-storey house: on the ground floor every storey-1 piece inside is listed as above', () => {
    const ground = hut(0, 0, 'ivy', false);
    const upper = walls(0, 0, 4, 4, { level: 1, kinds: { '3,4': 'wall_window' } });
    const upFloor = [piece('floor', 1, 1, 0, 1), piece('floor', 3, 1, 0, 1), piece('floor', 1, 3, 0, 1), piece('floor', 3, 3, 0, 1)];
    const mounts = [piece('picture', 1, 0, 0, 1), piece('curtains', 3, 4, 2, 1)];
    const top = roof(2, 2, 4, 4, 0, 2);
    // A neighbour's roof just east of it is not part of it.
    const neighbour = [...walls(4, 0, 8, 4, { owner: 'rowan', open: ['w'] }), roof(6, 2, 4, 4, 0, 1, 'rowan')];
    const ix = index(ground, upper, upFloor, mounts, top, neighbour);
    const e = enclosureAt(ix, { x: 2, z: 2, y: 0.18 })!;
    expect(e.storey).toBe(0);
    expect(e.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    expect(e.above.sort()).toEqual(ids([...upper, ...upFloor, ...mounts, top]));
    expect(ids(e.walls)).toEqual(ids(ground));
  });
});

describe('doorway hysteresis', () => {
  it('enters ≥ 0.3 m inside, leaves ≥ 0.6 m outside', () => {
    expect(ENCLOSURE_ENTER).toBe(0.3);
    expect(ENCLOSURE_LEAVE).toBe(0.6);
    expect(enclosureHysteresis(false, 0.29)).toBe(false);
    expect(enclosureHysteresis(false, 0.3)).toBe(true);
    expect(enclosureHysteresis(true, 0)).toBe(true);
    expect(enclosureHysteresis(true, -0.59)).toBe(true);
    expect(enclosureHysteresis(true, -0.6)).toBe(false);
    const e = enclosureAt(index(hut()), { x: 2, z: 2 })!;
    expect(enclosureDepth(e, { x: 2, z: 2 })).toBeCloseTo(2);
    expect(enclosureDepth(e, { x: 1, z: 3.6 })).toBeCloseTo(0.4);
    expect(enclosureDepth(e, { x: 1, z: 4.5 })).toBeCloseTo(-0.5);
  });

  it('a walk out through the doorway and back: one toggle each way, none while dithering on the threshold', () => {
    const ix = index(hut());
    let t = NO_ENCLOSURE;
    const seq: [number, boolean][] = [
      [5.5, false], // outside
      [4.2, false], // 0.2 m outside
      [3.85, false], // 0.15 m inside: not yet
      [3.6, true], // 0.4 m inside: in
      [3.95, true],
      [4.2, true], // 0.2 m outside: still in
      [4.5, true], // 0.5 m outside: still in
      [3.9, true],
      [4.7, false], // 0.7 m outside: out
      [4.3, false],
      [3.8, false], // 0.2 m inside: still out
      [3.6, true],
    ];
    for (const [z, want] of seq) {
      t = trackEnclosure(ix, { x: 1, z }, t);
      expect(t.active, `z ${z}`).toBe(want);
      if (want) expect(t.enclosure!.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    }
  });

  it('a roofless walled room keeps the same hysteresis', () => {
    const ix = index(walls(0, 0, 4, 4, { kinds: { '1,4': 'doorway' } }));
    let t = trackEnclosure(ix, { x: 1, z: 3 }, NO_ENCLOSURE);
    expect(t.active).toBe(true);
    t = trackEnclosure(ix, { x: 1, z: 4.4 }, t);
    expect(t.active).toBe(true);
    t = trackEnclosure(ix, { x: 1, z: 4.8 }, t);
    expect(t.active).toBe(false);
  });
});
