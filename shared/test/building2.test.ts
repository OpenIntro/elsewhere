/**
 * Building round 2 rules: the house roof (parametric), wall mounts, table
 * tops, clearing bushes / rocks, stacking and run helpers, built seats.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  PIECES,
  PieceIndex,
  ROCKS,
  TREES,
  canRegrow,
  clearableNature,
  collidesAt,
  createCollisionWorld,
  detectRoofSpan,
  directDependents,
  footprintOf,
  getSeat,
  natureBlocking,
  natureItem,
  nextInRun,
  pieceSeatInteractable,
  registerInteractableResolver,
  roofParamsFor,
  roofSpanFromCorners,
  stackOnto,
  validateClear,
  validatePlacement,
  type PieceLike,
  type PlaceRequest,
} from '../src/index.js';

/** Open meadow west of the Town Square (scripts/lib/plans2.mjs HOUSE). */
const H = { x0: -20, z0: -1, x1: -16, z1: 3 };
const ME = 'me';
const ALL = new Set(clearableNature().keys());
let seq = 0;

function ctx(index: PieceIndex, builderId = ME, cleared: ReadonlySet<string> = ALL) {
  return { index, builderId, builderPos: null, players: [], cleared };
}
function req(kind: string, x: number, z: number, rot = 0, level = 0, extra: Partial<PlaceRequest> = {}): PlaceRequest {
  const k = kind as keyof typeof PIECES;
  return { kind, variant: PIECES[k]?.variants[0]!.id ?? 'x', x, z, rot, level, ...extra };
}
function put(ix: PieceIndex, r: PlaceRequest, owner = ME): PieceLike {
  const v = validatePlacement(r, ctx(ix, owner));
  if (!v.ok) throw new Error(`refused ${v.reason} ${v.label ?? ''} for ${JSON.stringify(r)}`);
  const p: PieceLike = { id: `t${++seq}`, kind: v.kind, x: v.x, z: v.z, rot: v.rot, level: v.level, y: v.y, ownerId: owner, ...(v.params ? { params: v.params } : {}) };
  ix.add(p);
  return p;
}
const reason = (ix: PieceIndex, r: PlaceRequest, owner = ME) => {
  const v = validatePlacement(r, ctx(ix, owner));
  return v.ok ? 'ok' : v.reason;
};
/** Walls of the rectangle H at `level` (2 m segments), optionally leaving sides out. */
function walls(ix: PieceIndex, level = 0, skip: ('n' | 's' | 'w' | 'e')[] = [], owner = ME, r = H): PieceLike[] {
  const out: PieceLike[] = [];
  for (let x = r.x0 + 1; x < r.x1; x += 2) {
    if (!skip.includes('n')) out.push(put(ix, req('wall', x, r.z0, 0, level), owner));
    if (!skip.includes('s')) out.push(put(ix, req(x === r.x0 + 1 && level === 0 ? 'doorway' : 'wall', x, r.z1, 0, level), owner));
  }
  for (let z = r.z0 + 1; z < r.z1; z += 2) {
    if (!skip.includes('w')) out.push(put(ix, req('wall', r.x0, z, 1, level), owner));
    if (!skip.includes('e')) out.push(put(ix, req('wall', r.x1, z, 1, level), owner));
  }
  return out;
}
const roof = (x: number, z: number, level: number, w: number, d: number, rot = 0, style = 'gable', pitch = 1) => req('house_roof', x, z, rot, level, { params: { w, d, style, pitch } });

describe('house roof (one parametric piece)', () => {
  it('spans a walled rectangle in both styles and pitches; rot turns the ridge', () => {
    const ix = new PieceIndex();
    walls(ix);
    for (const style of ['gable', 'hip'])
      for (const pitch of [0, 1])
        for (const rot of [0, 1]) {
          const v = validatePlacement(roof(-18, 1, 1, 4, 4, rot, style, pitch), ctx(ix));
          expect(v.ok, `${style} ${pitch} ${rot}`).toBe(true);
          if (v.ok) expect(v.y).toBeCloseTo(Math.max(...[...ix.all()].map((p) => p.y)) + CONFIG.building.storeyHeight, 1);
        }
    const p = put(ix, roof(-18, 1, 1, 4, 4));
    expect(footprintOf(p)).toEqual({ minX: -20, maxX: -16, minZ: -1, maxZ: 3 });
    expect(JSON.parse(p.params!)).toEqual({ w: 4, d: 4, s: 'gable', p: 1 });
  });
  it('refuses bad params, bad rotation, unsupported and someone else’s walls', () => {
    const ix = new PieceIndex();
    walls(ix);
    expect(reason(ix, roof(-18, 1, 1, 13, 4))).toBe('bad_params');
    expect(reason(ix, roof(-18, 1, 1, 1, 4))).toBe('bad_params');
    expect(reason(ix, roof(-18, 1, 1, 4.5, 4))).toBe('bad_params');
    expect(reason(ix, req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'dome', pitch: 1 } }))).toBe('bad_params');
    expect(reason(ix, req('house_roof', -18, 1, 0, 1))).toBe('bad_params');
    expect(reason(ix, roof(-18, 1, 1, 4, 4, 2))).toBe('bad_rotation');
    expect(reason(ix, roof(-18, 1, 0, 4, 4))).toBe('bad_level');
    // Only two sides walled → unsupported.
    const ix2 = new PieceIndex();
    walls(ix2, 0, ['s', 'e']);
    expect(reason(ix2, roof(-18, 1, 1, 4, 4))).toBe('unsupported');
    // Three sides → fine (an open porch side).
    const ix3 = new PieceIndex();
    walls(ix3, 0, ['s']);
    expect(reason(ix3, roof(-18, 1, 1, 4, 4))).toBe('ok');
    // Someone else's walls.
    const ix4 = new PieceIndex();
    walls(ix4, 0, [], 'other');
    expect(reason(ix4, roof(-18, 1, 1, 4, 4))).toBe('not_your_support');
  });
  it('overlap: no duplicate roof, no roof through an upper wall, but an L-shaped cross gable may intersect', () => {
    const ix = new PieceIndex();
    walls(ix);
    put(ix, roof(-18, 1, 1, 4, 4));
    expect(reason(ix, roof(-18, 1, 1, 4, 4, 1))).toBe('overlap');
    // Wing: 4 wide (x -20..-16), running south from the main ridge (z 1) to z 7 → shares a third of its area.
    for (const x of [-19, -17]) put(ix, req('wall', x, 7, 0));
    for (const z of [4, 6]) {
      put(ix, req('wall', -20, z, 1));
      put(ix, req('wall', -16, z, 1));
    }
    expect(reason(ix, roof(-18, 4, 1, 4, 6, 0))).toBe('ok');
    // A wall on the roof's storey inside its span clashes with the roof.
    const ix2 = new PieceIndex();
    walls(ix2);
    put(ix2, roof(-18, 1, 1, 4, 4));
    expect(reason(ix2, req('wall', -18, 1, 0, 1))).not.toBe('ok');
  });
  it('protected zones count the eaves too', () => {
    // House 1's protected zone (+1 m) starts just west of x = -23: the walls fit, the roof's eaves do not.
    const ix = new PieceIndex();
    const r = { x0: -23, z0: 5, x1: -21, z1: 7 };
    walls(ix, 0, [], ME, r);
    const v = validatePlacement(roof(-22, 6, 1, 2, 2), ctx(ix));
    expect(v.ok ? 'ok' : v.reason).toBe('protected');
  });
  it('detects the walled rectangle (and refuses an L) for the roof tool; two corners as the fallback', () => {
    const ix = new PieceIndex();
    const ws = walls(ix, 0);
    const span = detectRoofSpan(ix, ws[0] as never)!;
    expect(span).toEqual({ x: -18, z: 1, sx: 4, sz: 4, level: 1 });
    expect(roofParamsFor({ sx: 6, sz: 4 }, 0, 'gable', 1)).toEqual({ w: 6, d: 4, style: 'gable', pitch: 1 });
    expect(roofParamsFor({ sx: 6, sz: 4 }, 1, 'hip', 0)).toEqual({ w: 4, d: 6, style: 'hip', pitch: 0 });
    // An L of walls: no clean rectangle.
    const ixL = new PieceIndex();
    walls(ixL, 0, ['s']);
    const extra = [put(ixL, req('wall', -21, 3, 0)), put(ixL, req('wall', -22, 4, 1))];
    expect(detectRoofSpan(ixL, extra[0] as never)).toBeNull();
    expect(roofSpanFromCorners({ x: -20.2, z: -1.1 }, { x: -16.1, z: 2.9 }, 1)).toEqual({ x: -18, z: 1, sx: 4, sz: 4, level: 1 });
    expect(roofSpanFromCorners({ x: 0, z: 0 }, { x: 0.4, z: 3 }, 1)).toBeNull();
  });
});

describe('stacking and runs (all four orientations)', () => {
  it('stackOnto keeps the line and the orientation, one storey up', () => {
    for (const rot of [0, 1, 2, 3]) {
      const w = { kind: 'wall' as const, x: 3, z: -2, rot, level: 0 };
      expect(stackOnto(w, 'wall_window')).toEqual({ x: 3, z: -2, rot, level: 1 });
      expect(stackOnto({ ...w, level: 1 }, 'doorway')).toEqual({ x: 3, z: -2, rot, level: 2 });
    }
    expect(stackOnto({ kind: 'floor', x: 0, z: 0, rot: 0, level: 0 }, 'wall')).toBeNull();
    expect(stackOnto({ kind: 'wall', x: 0, z: 0, rot: 0, level: 0 }, 'table')).toBeNull();
  });
  it('nextInRun continues along the wall line, in the direction of the run', () => {
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 0 })).toEqual({ x: 2, z: 0 });
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 1 })).toEqual({ x: 0, z: -2 });
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 2 })).toEqual({ x: -2, z: 0 });
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 3 })).toEqual({ x: 0, z: 2 });
    // Coming from the other side → keep going that way.
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 0 }, { x: 2, z: 0 })).toEqual({ x: -2, z: 0 });
    expect(nextInRun({ kind: 'wall', x: 0, z: 0, rot: 1 }, { x: 0, z: -2 })).toEqual({ x: 0, z: 2 });
  });
});

describe('wall mounts (facade signs, pictures, shelves, curtains)', () => {
  it('hang on your wall faces only, in their height band, never through a window or a door', () => {
    const ix = new PieceIndex();
    const plain = put(ix, req('wall', -19, -1, 0));
    put(ix, req('wall_window', -17, -1, 0));
    put(ix, req('doorway', -19, 3, 0));
    expect(reason(ix, req('picture', -19, -1, 0))).toBe('ok');
    expect(reason(ix, req('picture', -19, -1, 2))).toBe('ok'); // the other face
    expect(reason(ix, req('picture', -19, -1, 1))).toBe('unsupported'); // across the wall
    expect(reason(ix, req('picture', -17, -1, 0))).toBe('mount_blocked'); // window
    expect(reason(ix, req('curtains', -17, -1, 0))).toBe('ok');
    expect(reason(ix, req('curtains', -19, -1, 0))).toBe('mount_blocked'); // no window there
    expect(reason(ix, req('name_board', -19, 3, 0, 0, { text: 'x' }))).toBe('ok'); // above the door
    expect(reason(ix, req('name_plaque', -19, 3, 0))).toBe('mount_blocked'); // at door height
    expect(reason(ix, req('picture', -15, -1, 0))).toBe('unsupported'); // no wall
    // Two on one face share no height; different bands are fine.
    put(ix, req('picture', -19, -1, 0));
    expect(reason(ix, req('mirror', -19, -1, 0))).toBe('overlap');
    expect(reason(ix, req('wall_clock', -19, -1, 0))).toBe('ok');
    // On someone else's wall.
    const ix2 = new PieceIndex();
    put(ix2, req('wall', -19, -1, 0), 'other');
    expect(reason(ix2, req('picture', -19, -1, 0))).toBe('not_your_support');
    // Removing the wall takes what hangs on it.
    expect(directDependents(ix, plain.id).map((p) => p.kind)).toEqual(['picture']);
  });
  it('the mount sits on the face: its footprint is off the wall line', () => {
    const f = footprintOf({ kind: 'name_board', x: 0, z: 0, rot: 0 });
    expect(f.minZ).toBeCloseTo(0.12, 5);
    expect(f.maxZ).toBeCloseTo(0.2, 5);
    const g = footprintOf({ kind: 'name_board', x: 0, z: 0, rot: 1 });
    expect(g.minX).toBeCloseTo(0.12, 5);
  });
});

describe('table tops', () => {
  it('stand on a table / counter at its height, or on the floor; never inside furniture', () => {
    const ix = new PieceIndex();
    const t = put(ix, req('table', -18, 1));
    const lamp = put(ix, req('table_lamp', -18, 1));
    expect(lamp.y).toBeCloseTo(t.y + PIECES.table.h, 5);
    expect(reason(ix, req('plant_small', -18, 1))).toBe('overlap'); // one top thing per spot
    expect(reason(ix, req('plant_small', -17.5, 1))).toBe('ok');
    expect(directDependents(ix, t.id).map((p) => p.kind)).toEqual(['table_lamp']);
    // On the floor next to it is fine; inside a wall is not.
    expect(reason(ix, req('table_lamp', -16, 3))).toBe('ok');
    put(ix, req('wall', -19, -1, 0));
    expect(reason(ix, req('table_lamp', -19, -1))).toBe('overlap');
  });
});

describe('clearing bushes and small rocks', () => {
  it('only bushes and small rocks on open land; never trees, big rocks or protected plants', () => {
    const tree = TREES[0]!;
    expect(validateClear(tree.id, { builderPos: null })).toMatchObject({ ok: false, reason: 'not_clearable', label: 'a tree' });
    const big = ROCKS.find((r) => r.radius > CONFIG.building.clear.maxRockRadius)!;
    expect(validateClear(big.id, { builderPos: null })).toMatchObject({ ok: false, reason: 'not_clearable' });
    // bush_64 grows by the Town Square path (protected).
    expect(natureItem('bush_64')).toBeDefined();
    expect(validateClear('bush_64', { builderPos: null })).toMatchObject({ ok: false, reason: 'not_clearable' });
    expect(validateClear('nope', { builderPos: null })).toMatchObject({ ok: false, reason: 'not_found' });
    const b = natureItem('bush_37')!;
    expect(validateClear('bush_37', { builderPos: { x: b.position.x + 20, z: b.position.z } })).toMatchObject({ ok: false, reason: 'too_far' });
    expect(validateClear('bush_37', { builderPos: { x: b.position.x + 2, z: b.position.z } })).toMatchObject({ ok: true });
    expect(validateClear('bush_37', { builderPos: null, cleared: new Set(['bush_37']) })).toMatchObject({ ok: false, reason: 'already_cleared' });
    expect(clearableNature().size).toBeGreaterThan(50);
    for (const n of clearableNature().values()) expect(n.kind).not.toBe('tree');
  });
  it('a bush blocks placement until cleared, and says which', () => {
    const ix = new PieceIndex();
    const v = validatePlacement(req('wall', -16, -2, 1), ctx(ix, ME, new Set()));
    expect(v).toMatchObject({ ok: false, reason: 'nature', natureId: 'bush_37', label: 'a bush' });
    expect(natureBlocking(footprintOf({ kind: 'wall', x: -16, z: -2, rot: 1 }))?.id).toBe('bush_37');
    expect(validatePlacement(req('wall', -16, -2, 1), ctx(ix, ME, new Set(['bush_37']))).ok).toBe(true);
  });
  it('a cleared rock stops colliding (shared collision, disabled set)', () => {
    const rock = natureItem('rock_21')!;
    expect(clearableNature().has('rock_21')).toBe(true);
    const w = createCollisionWorld();
    expect(collidesAt(rock.position, CONFIG.movement.playerRadius, w)).not.toBeNull();
    w.disabled.add(rock.colliderId!);
    expect(collidesAt(rock.position, CONFIG.movement.playerRadius, w)).toBeNull();
  });
  it('regrows only when nothing is built close by and nobody stands on it', () => {
    const n = natureItem('bush_37')!;
    const ix = new PieceIndex();
    expect(canRegrow(ix, n, [])).toBe(true);
    expect(canRegrow(ix, n, [{ x: n.position.x, z: n.position.z }])).toBe(false);
    put(ix, req('wall', -16, -2, 1));
    expect(canRegrow(ix, n, [])).toBe(false);
  });
});

describe('built seats', () => {
  it('chairs, benches, sofas and beds are seat interactables with seats that face the right way', () => {
    const chair: PieceLike = { id: 'c1', kind: 'chair', x: 1, z: 2, rot: 1, level: 0, y: 3, ownerId: ME };
    const it = pieceSeatInteractable(chair)!;
    expect(it).toMatchObject({ id: 'bp:c1', kind: 'chair', synced: false });
    expect(it.seats).toHaveLength(1);
    expect(it.seats[0]!.yaw).toBeCloseTo(Math.PI / 2, 5);
    const bench = pieceSeatInteractable({ ...chair, id: 'b1', kind: 'bench', rot: 0 })!;
    expect(bench.kind).toBe('bench');
    expect(bench.seats).toHaveLength(2);
    const bed = pieceSeatInteractable({ ...chair, id: 'd1', kind: 'bed', rot: 0 })!;
    expect(bed.seats.map((s) => Math.sign(s.yaw))).toEqual([-1, 1]); // sit on either edge, facing out
    for (const s of bed.seats) expect(Math.abs(s.exit.x - 1)).toBeGreaterThan(1); // stand up beside the bed
    expect(pieceSeatInteractable({ ...chair, kind: 'table' })).toBeNull();
    expect(pieceSeatInteractable({ ...chair, level: 1 })).toBeNull();
    // The resolver makes getSeat work for "bp:" seat refs.
    registerInteractableResolver((id) => (id === 'bp:c1' ? it : undefined));
    expect(getSeat('bp:c1#0')).toEqual(it.seats[0]);
    registerInteractableResolver(null);
  });
});
