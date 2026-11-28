/**
 * Built interiors, the client half: which walls of the room drop to stubs
 * for a camera yaw (the four rotations and one in between), the mounts that
 * go with them, and that far walls, floor furniture and table tops stay.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, PieceIndex, enclosureAt, roofParamsString, type PieceKind, type PieceLike } from '@elsewhere/shared';
import { cameraFacingWalls, mountsOn, planCutaway } from '../src/build/builtCutaway.js';

const H = CONFIG.building.storeyHeight;
const Q = Math.PI / 2;

function piece(kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<PieceLike> = {}): PieceLike {
  return { id: `${kind}@${x},${z}`, kind, x, z, rot, level, y: level * H, ownerId: 'ivy', ...extra };
}
const wall = (x: number, z: number, rot: number, kind: PieceKind = 'wall') => piece(kind, x, z, rot);
const roof = (x: number, z: number, w: number, d: number, rot: number) => piece('house_roof', x, z, rot, 1, { params: roofParamsString({ w, d, style: 'gable', pitch: 1 }) });

/** The 4 × 4 hut: wall lines x 0..4, z 0..4; doorway + window south (+Z), roof, furnished. */
const HUT: PieceLike[] = [
  wall(1, 0, 0), wall(3, 0, 0), // north (−Z)
  wall(1, 4, 0, 'doorway'), wall(3, 4, 0, 'wall_window'), // south (+Z)
  wall(0, 1, 1), wall(0, 3, 1), // west (−X)
  wall(4, 1, 1), wall(4, 3, 1), // east (+X)
  roof(2, 2, 4, 4, 0),
  piece('bed', 2.5, 1, 1),
  piece('rug', 2, 2.5),
  piece('table', 1.5, 2.5),
  piece('table_lamp', 1.5, 2.5, 0, 0, { y: 0.78 }),
  piece('picture', 3, 4, 2), // inner face of the south (window) wall — camera side at yaw 0
  piece('picture', 1, 0, 0, 0, { id: 'picture@far' }), // inner face of the north wall
  piece('name_board', 1, 4, 0), // over the door, outside
];

/** The L house (plans2 lHouse at c = 0, 0): main x −3..3 z −2..2, wing x −1..3 z 2..6. */
const L: PieceLike[] = [
  wall(-2, -2, 0), wall(0, -2, 0), wall(2, -2, 0), // main north
  wall(-2, 2, 0, 'doorway'), // main south, west of the wing
  wall(-3, -1, 1), wall(-3, 1, 1), // main west
  wall(3, -1, 1), wall(3, 1, 1), // main east
  wall(0, 6, 0, 'wall_window'), wall(2, 6, 0), // wing south
  wall(-1, 3, 1), wall(-1, 5, 1), // wing west
  wall(3, 3, 1), wall(3, 5, 1, 'wall_window'), // wing east
  roof(0, 0, 4, 6, 1),
  roof(1, 3, 4, 6, 0),
];

function ix(list: PieceLike[]): PieceIndex {
  const i = new PieceIndex();
  for (const p of list) i.add(p);
  return i;
}

describe('cameraFacingWalls', () => {
  const hut = ix(HUT);
  const e = enclosureAt(hut, { x: 2, z: 2 })!;
  // Camera sits at +(sin yaw, cos yaw) from the focus: yaw 0 looks from +Z.
  const cases: [string, number, string[]][] = [
    ['yaw 0 (from +Z)', 0, ['doorway@1,4', 'wall_window@3,4']],
    ['yaw π/2 (from +X)', Q, ['wall@4,1', 'wall@4,3']],
    ['yaw π (from −Z)', 2 * Q, ['wall@1,0', 'wall@3,0']],
    ['yaw 3π/2 (from −X)', 3 * Q, ['wall@0,1', 'wall@0,3']],
    ['yaw π/4 (the default view, between +Z and +X)', Q / 2, ['doorway@1,4', 'wall@4,1', 'wall@4,3', 'wall_window@3,4']],
    ['yaw −π/4 (between +Z and −X)', -Q / 2, ['doorway@1,4', 'wall@0,1', 'wall@0,3', 'wall_window@3,4']],
  ];
  for (const [name, yaw, want] of cases) it(`4x4 hut, ${name}`, () => expect(cameraFacingWalls(e, yaw)).toEqual(want));

  it('a camera a few degrees off an axis still cuts only the one face', () => {
    expect(cameraFacingWalls(e, 0.12)).toEqual(['doorway@1,4', 'wall_window@3,4']);
    expect(cameraFacingWalls(e, 2 * Q - 0.12)).toEqual(['wall@1,0', 'wall@3,0']);
  });

  const lx = ix(L);
  const el = enclosureAt(lx, { x: 1, z: 4.5 })!;
  const lcases: [string, number, string[]][] = [
    ['yaw 0', 0, ['doorway@-2,2', 'wall@2,6', 'wall_window@0,6']],
    ['yaw π/2', Q, ['wall@3,-1', 'wall@3,1', 'wall@3,3', 'wall_window@3,5']],
    ['yaw π', 2 * Q, ['wall@-2,-2', 'wall@0,-2', 'wall@2,-2']],
    ['yaw 3π/2', 3 * Q, ['wall@-1,3', 'wall@-1,5', 'wall@-3,-1', 'wall@-3,1']],
    ['yaw 5π/4 (between −Z and −X)', 2.5 * Q, ['wall@-1,3', 'wall@-1,5', 'wall@-2,-2', 'wall@-3,-1', 'wall@-3,1', 'wall@0,-2', 'wall@2,-2']],
  ];
  for (const [name, yaw, want] of lcases) it(`L house, ${name}`, () => expect(cameraFacingWalls(el, yaw)).toEqual(want));

  it('a partition between the player and the camera is cut, one behind the player is not', () => {
    const rooms = ix([...HUT.filter((p) => p.kind !== 'picture' && p.kind !== 'name_board'), wall(2, 1, 1, 'wall'), wall(2, 3, 1, 'doorway')]);
    const er = enclosureAt(rooms, { x: 1, z: 2 })!;
    // With the partition at x = 2 this is a roofed room (one roof), the partition inside it.
    expect(er.inner.map((w) => w.id).sort()).toEqual(['doorway@2,3', 'wall@2,1']);
    expect(cameraFacingWalls(er, Q, rooms, { x: 1, z: 2 })).toEqual(['doorway@2,3', 'wall@2,1', 'wall@4,1', 'wall@4,3']);
    expect(cameraFacingWalls(er, Q, rooms, { x: 3, z: 2 })).toEqual(['wall@4,1', 'wall@4,3']);
  });
});

describe('planCutaway', () => {
  const hut = ix(HUT);
  const e = enclosureAt(hut, { x: 2, z: 2 })!;

  it('mounts on cut walls go (inside and outside faces), far-wall mounts and all furniture stay', () => {
    const plan = planCutaway(hut, e, 0);
    expect(plan.cut).toEqual(['doorway@1,4', 'wall_window@3,4']);
    expect(plan.hidden).toEqual(['house_roof@2,2', 'name_board@1,4', 'picture@3,4']);
    for (const keep of ['bed@2.5,1', 'rug@2,2.5', 'table@1.5,2.5', 'table_lamp@1.5,2.5', 'picture@far']) {
      expect(plan.hidden, keep).not.toContain(keep);
      expect(plan.cut, keep).not.toContain(keep);
    }
  });

  it('turning the camera half way round swaps which picture hides', () => {
    const plan = planCutaway(hut, e, 2 * Q);
    expect(plan.cut).toEqual(['wall@1,0', 'wall@3,0']);
    expect(plan.hidden).toEqual(['house_roof@2,2', 'picture@far']);
  });

  it('mountsOn finds only mounts hung on those exact walls', () => {
    expect(mountsOn(hut, ['wall_window@3,4'])).toEqual(['picture@3,4']);
    expect(mountsOn(hut, ['doorway@1,4'])).toEqual(['name_board@1,4']);
    expect(mountsOn(hut, ['wall@4,1', 'wall@4,3'])).toEqual([]);
  });
});
