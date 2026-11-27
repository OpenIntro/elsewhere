/**
 * The house-roof tool must put a roof on any ordinary house in one action.
 * Each block here pins one root cause found by building houses by hand (see
 * README "Building" → roofs):
 *  - the old detector took the bounding box of EVERY connected wall and
 *    wanted all four sides ≥ 70 % walled, so a garden wall touching a corner,
 *    one wall left out, an odd 3 m side (which always has a 1 m gap) or an
 *    open porch never got a roof;
 *  - pointing at the ground floor of a two-storey house aimed the roof at the
 *    first floor (overlapping the upper walls);
 *  - eaves had to be fully on buildable land, so legal walls next to a
 *    protected zone could not be roofed;
 *  - an attic floor at the roof's level clashed with the roof;
 *  - the range was measured to the roof's centre;
 *  - the refusals said "A roof needs walls along at least three sides" /
 *    "You can only build on top of your own pieces" without saying which.
 * And the matrix: for every house shape, every probe point a cursor can give
 * finds the same roof, and the roof the tool offers is valid by the SAME
 * predicate the server runs (validatePlacement).
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  PIECES,
  PieceIndex,
  ROOF_OVERHANG,
  clearableNature,
  findRoofSpan,
  fitRoof,
  footprintOf,
  parseRoofParams,
  refusalText,
  roofParamsString,
  roofSpanAt,
  validatePlacement,
  type PieceLike,
  type PlaceRequest,
  type RoofSpan,
  type Vec2,
} from '../src/index.js';

const ME = 'me';
const ALL = new Set(clearableNature().keys());
let seq = 0;
const VARIANT = PIECES.house_roof.variants[0]!.id;

function ctx(index: PieceIndex, builderId = ME, builderPos: Vec2 | null = null) {
  return { index, builderId, builderPos, players: [], cleared: ALL };
}
function req(kind: string, x: number, z: number, rot = 0, level = 0, extra: Partial<PlaceRequest> = {}): PlaceRequest {
  const k = kind as keyof typeof PIECES;
  return { kind, variant: PIECES[k]?.variants[0]!.id ?? 'x', x, z, rot, level, ...extra };
}
function put(ix: PieceIndex, r: PlaceRequest, owner = ME): PieceLike {
  const v = validatePlacement(r, ctx(ix, owner));
  if (!v.ok) throw new Error(`refused ${v.reason} ${v.label ?? ''} for ${JSON.stringify(r)}`);
  const p: PieceLike = { id: `r${++seq}`, kind: v.kind, x: v.x, z: v.z, rot: v.rot, level: v.level, y: v.y, ownerId: owner, ...(v.params ? { params: v.params } : {}) };
  ix.add(p);
  return p;
}

type Side = 'n' | 's' | 'w' | 'e';
interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
/** The walls of a rectangle (2 m segments; an odd side ends in a 1 m gap), kind per side/segment (null = left out). */
function house(ix: PieceIndex, b: Box, level = 0, kindAt: (side: Side, i: number) => string | null = () => 'wall', owner: (side: Side) => string = () => ME): PieceLike[] {
  const out: PieceLike[] = [];
  const seg = (side: Side, i: number, x: number, z: number, rot: number) => {
    const k = kindAt(side, i);
    if (k) out.push(put(ix, req(k, x, z, rot, level), owner(side)));
  };
  let i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) seg('n', i++, x, b.z0, 0);
  i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) seg('s', i++, x, b.z1, 0);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) seg('w', i++, b.x0, z, 1);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) seg('e', i++, b.x1, z, 1);
  return out;
}
const spanOf = (b: Box, level = 1): RoofSpan => ({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, sx: b.x1 - b.x0, sz: b.z1 - b.z0, level });

/** Every point a cursor can give for this house: both faces of each wall, the middle, near each corner inside. */
function probes(b: Box, ws: readonly PieceLike[]): Vec2[] {
  const out: Vec2[] = [{ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 }];
  for (const w of ws) {
    const n = w.rot % 2 === 0 ? { x: 0, z: 0.13 } : { x: 0.13, z: 0 };
    out.push({ x: w.x + n.x, z: w.z + n.z }, { x: w.x - n.x, z: w.z - n.z });
  }
  for (const [x, z] of [
    [b.x0 + 0.4, b.z0 + 0.4],
    [b.x1 - 0.4, b.z0 + 0.4],
    [b.x0 + 0.4, b.z1 - 0.4],
    [b.x1 - 0.4, b.z1 - 0.4],
  ] as const)
    out.push({ x, z });
  return out;
}

/** Open meadow west of the Town Square (scripts/lib/plans2.mjs HOUSE) and an open site north-west of it. */
const H: Box = { x0: -20, z0: -1, x1: -16, z1: 3 };
const BIG: Box = { x0: -22, z0: 17, x1: -14, z1: 25 };

interface Shape {
  name: string;
  build: (ix: PieceIndex) => { box: Box; ws: PieceLike[]; level?: number };
}
const SHAPES: Shape[] = [
  { name: '4x4, closed, a door in the south', build: (ix) => ({ box: H, ws: house(ix, H, 0, (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall')) }) },
  { name: '2x2', build: (ix) => ({ box: { x0: -20, z0: -1, x1: -18, z1: 1 }, ws: house(ix, { x0: -20, z0: -1, x1: -18, z1: 1 }) }) },
  { name: '4x2 (not square)', build: (ix) => ({ box: { x0: -20, z0: -1, x1: -16, z1: 1 }, ws: house(ix, { x0: -20, z0: -1, x1: -16, z1: 1 }) }) },
  { name: '2x4 (not square)', build: (ix) => ({ box: { x0: -20, z0: -1, x1: -18, z1: 3 }, ws: house(ix, { x0: -20, z0: -1, x1: -18, z1: 3 }) }) },
  { name: '8x6 big', build: (ix) => ({ box: { ...BIG, z1: 23 }, ws: house(ix, { ...BIG, z1: 23 }) }) },
  { name: 'a doorway and a window in every side', build: (ix) => ({ box: H, ws: house(ix, H, 0, (_s, i) => (i === 0 ? 'doorway' : 'wall_window')) }) },
  { name: 'one wall segment left out', build: (ix) => ({ box: H, ws: house(ix, H, 0, (s, i) => (s === 'n' && i === 1 ? null : 'wall')) }) },
  { name: 'porch: the south side open', build: (ix) => ({ box: H, ws: house(ix, H, 0, (s) => (s === 's' ? null : 'wall')) }) },
  { name: '3x4 (the odd side has a 1 m gap)', build: (ix) => ({ box: { x0: -20, z0: -1, x1: -17, z1: 3 }, ws: house(ix, { x0: -20, z0: -1, x1: -17, z1: 3 }) }) },
  {
    name: 'a garden wall touching a corner',
    build: (ix) => {
      const ws = house(ix, H);
      put(ix, req('wall', H.x1, H.z0 - 1, 1));
      return { box: H, ws };
    },
  },
  {
    name: 'a fence and a pillar against it',
    build: (ix) => {
      const ws = house(ix, H);
      put(ix, req('fence', H.x1 + 1, H.z1 + 0.5, 0));
      put(ix, req('pillar', H.x0, H.z0));
      return { box: H, ws };
    },
  },
  { name: 'half walls on the south side (they do not count)', build: (ix) => ({ box: H, ws: house(ix, H, 0, (s) => (s === 's' ? 'half_wall' : 'wall')).filter((p) => p.kind !== 'half_wall') }) },
  { name: 'one side is a neighbour’s wall', build: (ix) => ({ box: H, ws: house(ix, H, 0, () => 'wall', (s) => (s === 'n' ? 'them' : ME)).filter((p) => p.ownerId === ME) }) },
  {
    name: 'two storeys (probes on the ground floor too)',
    build: (ix) => {
      const lower = house(ix, H);
      const upper = house(ix, H, 1, () => 'wall_window');
      return { box: H, ws: [...lower, ...upper], level: 2 };
    },
  },
  {
    name: 'attic floors at the roof’s level',
    build: (ix) => {
      const ws = house(ix, H);
      for (const [x, z] of [
        [-19, 0],
        [-17, 0],
        [-19, 2],
        [-17, 2],
      ] as const)
        put(ix, req('floor', x, z, 0, 1));
      return { box: H, ws };
    },
  },
];

describe('roof tool: finds the house around the cursor (matrix)', () => {
  for (const shape of SHAPES)
    it(shape.name, () => {
      const ix = new PieceIndex();
      const { box, ws, level = 1 } = shape.build(ix);
      const want = spanOf(box, level);
      for (const p of probes(box, ws)) expect(roofSpanAt(ix, ME, [p]), `probe ${p.x},${p.z}`).toEqual(want);
      for (const rot of [0, 1])
        for (const style of ['gable', 'hip'] as const) {
          const res = fitRoof(want, rot, style, 1, VARIANT, ctx(ix));
          expect(res.ok, `${style} rot ${rot}: ${res.ok ? '' : refusalText(res.reason, res.label)}`).toBe(true);
          // The tool's offer is exactly what validatePlacement (the server's predicate) accepts.
          if (res.ok) expect(validatePlacement({ kind: 'house_roof', variant: VARIANT, x: res.x, z: res.z, rot: res.rot, level: res.level, params: parseRoofParams(res.params) }, ctx(ix)).ok).toBe(true);
        }
    });
});

describe('roof tool: root causes', () => {
  it('a neighbouring house of yours does not merge into this one; the cursor decides', () => {
    const ix = new PieceIndex();
    const a: Box = { x0: -22, z0: 17, x1: -18, z1: 21 };
    const b: Box = { x0: -16, z0: 17, x1: -14, z1: 21 };
    house(ix, a);
    house(ix, b);
    expect(roofSpanAt(ix, ME, [{ x: -20, z: 19 }])).toEqual(spanOf(a));
    expect(roofSpanAt(ix, ME, [{ x: -15, z: 19 }])).toEqual(spanOf(b));
    // Probes on the walls facing each other pick their own house.
    expect(roofSpanAt(ix, ME, [{ x: -18 + 0.13, z: 18 }])).toEqual(spanOf(a));
    expect(roofSpanAt(ix, ME, [{ x: -16 - 0.13, z: 18 }])).toEqual(spanOf(b));
  });
  it('an L-shaped house: the main block under the cursor gets its own roof, not one running on over open ground', () => {
    // Main block x -22..-18, z 17..21, open into a 2 m wide wing to the south (x -22..-20, z 21..25).
    const ix = new PieceIndex();
    for (const x of [-21, -19]) put(ix, req('wall', x, 17, 0));
    put(ix, req('wall', -19, 21, 0));
    for (const z of [18, 20, 22, 24]) put(ix, req('wall', -22, z, 1));
    for (const z of [18, 20]) put(ix, req('wall', -18, z, 1));
    for (const z of [22, 24]) put(ix, req('wall', -20, z, 1));
    put(ix, req('wall', -21, 25, 0));
    expect(roofSpanAt(ix, ME, [{ x: -19.5, z: 19 }])).toEqual(spanOf({ x0: -22, z0: 17, x1: -18, z1: 21 }));
    const wing = roofSpanAt(ix, ME, [{ x: -21, z: 24 }])!;
    expect(wing.sx).toBe(2);
    expect(fitRoof(wing, 0, 'gable', 1, VARIANT, ctx(ix)).ok).toBe(true);
  });
  it('separate houses whose walls line up never make one false rectangle (a porch stays its own house)', () => {
    // A porch (south open) with another house's walls 1.5 m+ away on two sides: together their lines
    // bound a bigger 4-sided rectangle, but it is not one house.
    const ix = new PieceIndex();
    const porch: Box = { x0: -17, z0: 15, x1: -13, z1: 19 };
    house(ix, porch, 0, (s) => (s === 's' ? null : 'wall'));
    house(ix, { x0: -25, z0: 15, x1: -19, z1: 19 });
    put(ix, req('wall', -19, 20, 1));
    house(ix, { x0: -20, z0: 22, x1: -16, z1: 26 }, 0, (s) => (s === 'n' || s === 'w' ? 'wall' : null));
    expect(roofSpanAt(ix, ME, [{ x: -15, z: 17 }])).toEqual(spanOf(porch));
    expect(roofSpanAt(ix, ME, [{ x: -18, z: 24 }])).toBeNull();
    expect(roofSpanAt(ix, ME, [{ x: -18, z: 24 }], 2)).toEqual(spanOf({ x0: -20, z0: 22, x1: -16, z1: 26 }));
  });
  it('pointing at the ground floor of a two-storey house roofs the top storey', () => {
    const ix = new PieceIndex();
    const lower = house(ix, H);
    house(ix, H, 1);
    expect(roofSpanAt(ix, ME, [{ x: lower[0]!.x, z: lower[0]!.z + 0.13 }])?.level).toBe(2);
    // The old behaviour (a roof on the first floor) is refused: it would cut through the upper walls.
    expect(validatePlacement(req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } }), ctx(ix))).toMatchObject({ ok: false, reason: 'overlap' });
  });
  it('eaves shorten next to a protected zone instead of refusing the roof', () => {
    // House 1's zone (+1 m) is just west of x = -23: the walls fit, full eaves do not.
    const ix = new PieceIndex();
    const b: Box = { x0: -23, z0: 5, x1: -21, z1: 7 };
    house(ix, b);
    const full = validatePlacement(req('house_roof', -22, 6, 0, 1, { params: { w: 2, d: 2, style: 'gable', pitch: 1 } }), ctx(ix));
    expect(full).toMatchObject({ ok: false, reason: 'protected' });
    const res = fitRoof(spanOf(b), 0, 'gable', 1, VARIANT, ctx(ix));
    expect(res.ok).toBe(true);
    if (res.ok) expect(parseRoofParams(res.params)!.overhang).toBeLessThan(ROOF_OVERHANG);
    // But the roof itself (between the wall lines) never goes over a protected zone.
    const ix2 = new PieceIndex();
    expect(validatePlacement(req('house_roof', -24, 6, 0, 1, { params: { w: 2, d: 2, style: 'gable', pitch: 1, overhang: 0 } }), ctx(ix2))).toMatchObject({ ok: false });
  });
  it('overhang is stored only when it is not the default; unknown overhangs are refused', () => {
    expect(roofParamsString({ w: 4, d: 4, style: 'gable', pitch: 1, overhang: ROOF_OVERHANG })).toBe('{"w":4,"d":4,"s":"gable","p":1}');
    expect(roofParamsString({ w: 4, d: 4, style: 'gable', pitch: 1, overhang: 0 })).toBe('{"w":4,"d":4,"s":"gable","p":1,"o":0}');
    expect(parseRoofParams('{"w":4,"d":4,"s":"gable","p":1}')!.overhang).toBe(ROOF_OVERHANG);
    expect(parseRoofParams({ w: 4, d: 4, style: 'gable', pitch: 1, overhang: 0.3 })).toBeNull();
    const ix = new PieceIndex();
    house(ix, H);
    expect(validatePlacement(req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1, overhang: 2 } }), ctx(ix))).toMatchObject({ ok: false, reason: 'bad_params' });
  });
  it('an attic floor and a house roof share their level (either order)', () => {
    const ix = new PieceIndex();
    house(ix, H);
    put(ix, req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } }));
    expect(validatePlacement(req('floor', -19, 0, 0, 1), ctx(ix)).ok).toBe(true);
    // A flat roof tile is still a clash.
    expect(validatePlacement(req('roof_flat', -19, 0, 0, 1), ctx(ix))).toMatchObject({ ok: false, reason: 'overlap' });
  });
  it('range: measured to the nearest point of the roof', () => {
    const ix = new PieceIndex();
    house(ix, { ...BIG, z1: 23 });
    const span = spanOf({ ...BIG, z1: 23 });
    // 2 m outside the west wall, opposite its middle: 6 m from the centre line… and 10.5 m to the far corner.
    const near: Vec2 = { x: BIG.x0 - 2, z: 20 };
    expect(fitRoof(span, 0, 'gable', 1, VARIANT, ctx(ix, ME, near)).ok).toBe(true);
    const far: Vec2 = { x: BIG.x0 - CONFIG.building.range - 0.5, z: 20 };
    expect(fitRoof(span, 0, 'gable', 1, VARIANT, ctx(ix, ME, far))).toMatchObject({ ok: false, reason: 'too_far' });
    // Other pieces keep measuring to their centre.
    expect(validatePlacement(req('wall', BIG.x1 + 1, 20, 1), ctx(ix, ME, near))).toMatchObject({ ok: false, reason: 'too_far' });
  });
  it('refusals say which sides are open, about half walls, and about someone else’s walls', () => {
    const roof = req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } });
    const text = (ix: PieceIndex) => {
      const v = validatePlacement(roof, ctx(ix));
      return v.ok ? 'ok' : refusalText(v.reason, v.label);
    };
    const a = new PieceIndex();
    house(a, H, 0, (s) => (s === 's' || s === 'e' ? null : 'wall'));
    expect(text(a)).toBe('Needs your walls on at least three sides — the south and east sides are open');
    const b = new PieceIndex();
    house(b, H, 0, (s) => (s === 'n' ? 'wall' : null));
    expect(text(b)).toBe('Needs your walls on at least three sides — the south, west and east sides are open');
    const c = new PieceIndex();
    house(c, H, 0, (s) => (s === 's' || s === 'e' ? 'half_wall' : 'wall'));
    expect(text(c)).toBe('Half walls are too low to hold a roof — use walls, windows or doorways');
    const d = new PieceIndex();
    house(d, H, 0, () => 'wall', (s) => (s === 'n' || s === 'w' ? 'them' : ME));
    expect(text(d)).toBe('Some of these walls are someone else’s — a roof rests on your own walls');
    // …and the tool shows a half-built house as that red rectangle (two sides), so the message has a place.
    expect(roofSpanAt(a, ME, [{ x: -18, z: 1 }])).toBeNull();
    expect(roofSpanAt(a, ME, [{ x: -18, z: 1 }], 2)).toEqual(spanOf(H));
  });
  it('anti-grief stays: someone else’s house is never found for you, nor roofed by you', () => {
    const ix = new PieceIndex();
    house(ix, H, 0, () => 'wall', () => 'them');
    expect(roofSpanAt(ix, ME, [{ x: -18, z: 1 }])).toBeNull();
    expect(roofSpanAt(ix, ME, [{ x: -18, z: 1 }], 2)).toBeNull();
    expect(validatePlacement(req('house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } }), ctx(ix))).toMatchObject({ ok: false, reason: 'not_your_support' });
    // No walls at all (open land): nothing to roof.
    expect(validatePlacement(req('house_roof', -18, 21, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } }), ctx(new PieceIndex()))).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it('findRoofSpan only looks at one storey and one owner', () => {
    const ix = new PieceIndex();
    house(ix, H);
    expect(findRoofSpan(ix, ME, { x: -18, z: 1 }, 1)).toBeNull();
    expect(findRoofSpan(ix, 'them', { x: -18, z: 1 }, 0)).toBeNull();
    expect(footprintOf({ kind: 'house_roof', x: -18, z: 1, rot: 0, params: roofParamsString({ w: 4, d: 4, style: 'hip', pitch: 0 }) })).toEqual({ minX: -20, maxX: -16, minZ: -1, maxZ: 3 });
  });
});
