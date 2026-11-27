/**
 * Homes: which of an owner's pieces make a house that can be a home
 * (shared/src/homes.ts). Only the owner's own pieces ever count.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, HOME_REFUSAL_TEXT, checkHouse, homeLabel, houseFor, insideHome, roofParamsString, type HomePiece, type PieceKind } from '@elsewhere/shared';

const H = CONFIG.building.storeyHeight;

function piece(kind: PieceKind, x: number, z: number, rot = 0, level = 0, ownerId = 'ivy', extra: Partial<HomePiece> = {}): HomePiece {
  return { id: `${ownerId}:${kind}@${x},${z},${level}${rot % 2 ? 'v' : ''}${rot >= 2 ? 'r' : ''}`, kind, x, z, rot, level, y: level * H, ownerId, ...extra };
}
function roof(x: number, z: number, w: number, d: number, rot = 0, level = 1, ownerId = 'ivy'): HomePiece {
  return piece('house_roof', x, z, rot, level, ownerId, { params: roofParamsString({ w, d, style: 'gable', pitch: 1 }), id: `${ownerId}:roof@${x},${z},${level}` });
}
function walls(x0: number, z0: number, x1: number, z1: number, opts: { owner?: string; kinds?: Record<string, PieceKind>; open?: ('n' | 's' | 'w' | 'e')[]; skip?: string[] } = {}): HomePiece[] {
  const out: HomePiece[] = [];
  const add = (x: number, z: number, rot: number) => {
    const k = `${x},${z}`;
    if (opts.skip?.includes(k)) return;
    out.push(piece(opts.kinds?.[k] ?? 'wall', x, z, rot, 0, opts.owner ?? 'ivy'));
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
/** 4 × 4 hut, wall lines x 0..4, z 0..4; doorway (1,4) + window (3,4) on the south side; floor tiles; one house roof. */
function hut(owner = 'ivy', opts: { roof?: boolean; door?: boolean } = {}): HomePiece[] {
  const kinds: Record<string, PieceKind> = { '3,4': 'wall_window' };
  if (opts.door !== false) kinds['1,4'] = 'doorway';
  const out = walls(0, 0, 4, 4, { owner, kinds });
  for (const [x, z] of [[1, 1], [3, 1], [1, 3], [3, 3]] as const) out.push(piece('floor', x, z, 0, 0, owner));
  if (opts.roof !== false) out.push(roof(2, 2, 4, 4, 0, 1, owner));
  return out;
}
const id = (list: HomePiece[], kind: PieceKind, x?: number, z?: number) => list.find((p) => p.kind === kind && (x === undefined || p.x === x) && (z === undefined || p.z === z))!.id;

describe('houseFor / checkHouse', () => {
  it('a qualifying 4x4 hut is a home: rect, door, roof, walls', () => {
    const h = hut();
    const r = checkHouse(h, id(h, 'doorway'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.house.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    expect(r.house.doorPieceId).toBe(id(h, 'doorway'));
    expect(r.house.roofPieceIds).toEqual([id(h, 'house_roof')]);
    expect(r.house.wallPieceIds).toHaveLength(8);
    expect(r.house.name).toBe('');
    expect(r.house.signPieceId).toBeUndefined();
    expect(insideHome(r.house, { x: 2, z: 2 })).toBe(true);
    expect(insideHome(r.house, { x: 2, z: 5 })).toBe(false);
  });

  it('selecting a wall, a window, the doorway, the roof or a floor tile of the same house gives the same home', () => {
    const h = hut();
    const want = houseFor(h, id(h, 'doorway'));
    expect(want).not.toBeNull();
    for (const sel of [id(h, 'wall', 0, 1), id(h, 'wall', 1, 0), id(h, 'wall', 4, 3), id(h, 'wall_window'), id(h, 'doorway'), id(h, 'house_roof'), id(h, 'floor', 1, 1), id(h, 'floor', 3, 3)]) {
      expect(houseFor(h, sel), sel).toEqual(want);
    }
  });

  it('no doorway → refused (no_doorway)', () => {
    const h = hut('ivy', { door: false });
    expect(checkHouse(h, id(h, 'house_roof'))).toEqual({ ok: false, reason: 'no_doorway' });
    expect(checkHouse(h, id(h, 'wall', 0, 1))).toEqual({ ok: false, reason: 'no_doorway' });
  });

  it('no roof → refused (no_roof)', () => {
    const h = hut('ivy', { roof: false });
    expect(checkHouse(h, id(h, 'doorway'))).toEqual({ ok: false, reason: 'no_roof' });
    expect(checkHouse(h, id(h, 'floor', 1, 1))).toMatchObject({ ok: false });
  });

  it('too few walls → refused (few_walls); a lone wall → not_a_house; an unknown piece → not_found', () => {
    const three = [...walls(0, 0, 4, 4, { kinds: { '1,4': 'doorway' }, skip: ['0,1', '0,3', '4,1', '4,3', '3,4'] }), roof(2, 2, 4, 4)];
    expect(checkHouse(three, three.find((p) => p.kind === 'house_roof')!.id)).toMatchObject({ ok: false });
    const lone = [piece('wall', 1, 0)];
    expect(checkHouse(lone, lone[0]!.id)).toEqual({ ok: false, reason: 'not_a_house' });
    expect(checkHouse(lone, 'nope')).toEqual({ ok: false, reason: 'not_found' });
    for (const r of ['not_found', 'not_a_house', 'no_roof', 'few_walls', 'no_doorway'] as const) expect(HOME_REFUSAL_TEXT[r].length).toBeGreaterThan(10);
  });

  it("another owner's roof over your walls → refused (the roof is not yours)", () => {
    const mine = hut('ivy', { roof: false });
    const theirs = roof(2, 2, 4, 4, 0, 1, 'rowan');
    const all = [...mine, theirs];
    expect(checkHouse(all, id(mine, 'doorway'))).toEqual({ ok: false, reason: 'no_roof' });
    // And Rowan cannot make it theirs either: none of the walls are Rowan's.
    expect(checkHouse(all, theirs.id)).toMatchObject({ ok: false });
  });

  it('an L house with two of your roofs is one home (the union)', () => {
    const out = walls(-3, -2, 3, 2, { kinds: { '-2,2': 'doorway' }, skip: ['0,2', '2,2'] });
    out.push(...walls(-1, 2, 3, 6, { open: ['n'], kinds: { '0,6': 'wall_window', '3,5': 'wall_window' } }));
    out.push(roof(0, 0, 4, 6, 1), roof(1, 3, 4, 6, 0));
    const a = houseFor(out, out.find((p) => p.kind === 'doorway')!.id)!;
    expect(a).not.toBeNull();
    expect(a.rect).toEqual({ minX: -3, maxX: 3, minZ: -2, maxZ: 6 });
    expect(a.parts).toHaveLength(2);
    expect(a.roofPieceIds).toHaveLength(2);
    // From the wing's window wall and from either roof: the same home.
    expect(houseFor(out, out.find((p) => p.kind === 'wall_window' && p.x === 0)!.id)).toEqual(a);
    for (const r of out.filter((p) => p.kind === 'house_roof')) expect(houseFor(out, r.id)).toEqual(a);
    expect(insideHome(a, { x: -2, z: 4 })).toBe(false);
    expect(insideHome(a, { x: 1, z: 4.5 })).toBe(true);
  });

  it('the name comes from your facade sign on an outline wall, not from someone else’s sign, nor from an inward-facing one', () => {
    const h = hut();
    const board = piece('name_board', 1, 4, 0, 0, 'ivy', { text: 'Fern Cottage' });
    expect(houseFor([...h, board], id(h, 'doorway'))).toMatchObject({ name: 'Fern Cottage', signPieceId: board.id });
    // Rowan's sign on Ivy's wall (illegal to place, but even if it were there) is ignored.
    const theirs = piece('name_plaque', 3, 4, 0, 0, 'rowan', { text: 'Rowan Was Here' });
    expect(houseFor([...h, theirs], id(h, 'doorway'))).toMatchObject({ name: '' });
    expect(houseFor([...h, board, theirs], id(h, 'house_roof'))!.name).toBe('Fern Cottage');
    // A sign facing into the room is not a facade sign.
    const inward = piece('name_plaque', 0, 1, 1, 0, 'ivy', { text: 'Inside' });
    expect(houseFor([...h, inward], id(h, 'doorway'))!.name).toBe('');
    // A free-standing signpost does not name the house either.
    expect(houseFor([...h, piece('sign', 2, 6, 0, 0, 'ivy', { text: 'Garden' })], id(h, 'doorway'))!.name).toBe('');
    // Selecting the board itself finds the house too.
    expect(houseFor([...h, board], board.id)).toMatchObject({ name: 'Fern Cottage', doorPieceId: id(h, 'doorway') });
  });

  it("a neighbour's roof built against an open side does not change your result", () => {
    const h = hut();
    const want = houseFor(h, id(h, 'doorway'));
    // Rowan builds a roofed lean-to against Ivy's east side: walls x 4..8 with no west wall, and a roof touching Ivy's.
    const lean = [...walls(4, 0, 8, 4, { owner: 'rowan', open: ['w'], kinds: { '5,4': 'doorway' } }), roof(6, 2, 4, 4, 0, 1, 'rowan')];
    // …and an overlapping roof right over Ivy's room, plus a wall through its middle.
    const grief = [roof(2, 2, 6, 6, 0, 1, 'rowan'), piece('wall', 2, 2, 1, 0, 'rowan')];
    for (const extra of [lean, grief, [...lean, ...grief]]) {
      const all = [...h, ...extra];
      for (const sel of [id(h, 'doorway'), id(h, 'house_roof'), id(h, 'floor', 3, 3)]) expect(houseFor(all, sel), sel).toEqual(want);
    }
    // Open side: Ivy's hut with its east wall missing is no house, whatever Rowan's roof does next to it.
    const open = hut().filter((p) => !(p.kind === 'wall' && p.x === 4));
    const r1 = checkHouse(open, id(open, 'doorway'));
    const r2 = checkHouse([...open, ...lean], id(open, 'doorway'));
    expect(r2).toEqual(r1);
  });

  it('a doorway shared by two of your houses: `prefer` picks the room you meant', () => {
    // Two huts side by side sharing the wall at x 4, which is a doorway between them.
    const a = hut();
    const b = [...walls(4, 0, 8, 4, { open: ['w'], kinds: { '5,4': 'doorway' } }), roof(6, 2, 4, 4)];
    const shared = a.find((p) => p.kind === 'wall' && p.x === 4 && p.z === 1)!;
    const all = [...a.filter((p) => p !== shared), { ...shared, kind: 'doorway' as const, id: 'ivy:inner-door' }, ...b];
    const left = houseFor(all, 'ivy:inner-door', { prefer: { minX: 0, maxX: 4, minZ: 0, maxZ: 4 } })!;
    const right = houseFor(all, 'ivy:inner-door', { prefer: { minX: 4, maxX: 8, minZ: 0, maxZ: 4 } })!;
    expect(left.doorPieceId).toBe('ivy:inner-door');
    expect(right.doorPieceId).toBe('ivy:inner-door');
    expect(left.rect).toEqual({ minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
    expect(right.rect).toEqual({ minX: 4, maxX: 8, minZ: 0, maxZ: 4 });
  });

  it('labels', () => {
    expect(homeLabel('Fern Cottage', 'Ivy')).toBe('Fern Cottage · Ivy’s home');
    expect(homeLabel('', 'Ivy')).toBe('Ivy’s home');
  });
});
