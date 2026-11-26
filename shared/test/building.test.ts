import { describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  CONFIG,
  PIECES,
  PIECE_KINDS,
  PROTECTED_ZONES,
  PieceIndex,
  autoLevel,
  buildableAt,
  cascadeRemoval,
  createCollisionWorld,
  directDependents,
  doorPosition,
  footprint,
  isWalkable,
  pieceColliders,
  refusalText,
  resolveMovement,
  snapToGrid,
  validatePlacement,
  walkSurfaceAt,
  zoneContains,
  type PieceLike,
  type PlacementContext,
  type PlaceRequest,
} from '../src/index.js';

/** A flat, open meadow by the Residential District lane (probed: every 2 m tile in x -19..-11, z 15..23 is buildable). */
const SITE = { x: -17, z: 17 };
const ME = 'me';
const OTHER = 'other';

function ctx(index: PieceIndex, extra: Partial<PlacementContext> = {}): PlacementContext {
  return { index, builderId: ME, builderPos: null, players: [], ...extra };
}
function req(kind: string, x: number, z: number, rot = 0, level = 0, variant?: string): PlaceRequest {
  const v = variant ?? (PIECE_KINDS.includes(kind as never) ? PIECES[kind as keyof typeof PIECES].variants[0]!.id : 'x');
  return { kind, variant: v, x, z, rot, level };
}
let seq = 0;
/** Place (asserting success) and add to the index. */
function put(index: PieceIndex, r: PlaceRequest, owner = ME): PieceLike {
  const v = validatePlacement(r, ctx(index, { builderId: owner }));
  if (!v.ok) throw new Error(`placement refused: ${v.reason} ${v.label ?? ''} for ${JSON.stringify(r)}`);
  const p: PieceLike = { id: `t${++seq}`, kind: v.kind, x: v.x, z: v.z, rot: v.rot, level: v.level, y: v.y, ownerId: owner };
  index.add(p);
  return p;
}
const refusal = (index: PieceIndex, r: PlaceRequest, extra: Partial<PlacementContext> = {}) => {
  const v = validatePlacement(r, ctx(index, extra));
  return v.ok ? 'ok' : v.reason;
};

describe('building catalog', () => {
  it('every kind has a def with muted variants and sane geometry', () => {
    for (const k of PIECE_KINDS) {
      const d = PIECES[k];
      expect(d.kind).toBe(k);
      expect(d.variants.length).toBeGreaterThanOrEqual(3);
      expect(d.w).toBeGreaterThan(0);
      expect(d.d).toBeGreaterThan(0);
      expect(d.minLevel).toBeLessThanOrEqual(d.maxLevel);
      for (const v of d.variants) for (const c of Object.values(v.colors)) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
    // At least two storeys of walls plus a roof.
    expect(PIECES.wall.maxLevel).toBeGreaterThanOrEqual(1);
    expect(PIECES.roof_slope.maxLevel).toBeGreaterThanOrEqual(2);
  });
  it('every refusal has text', () => {
    expect(refusalText('protected', 'the Town Square')).toContain('Town Square');
    expect(refusalText('too_far')).toMatch(/closer/);
  });
});

describe('protected zones (buildableAt)', () => {
  it('protects the Town Square, paths, buildings and their door aprons, interactables, water and the sea', () => {
    expect(buildableAt({ x: 0, z: 2 })).toMatchObject({ code: 'protected' });
    expect(buildableAt({ x: 3, z: -13.5 })).toMatchObject({ code: 'protected' }); // Bell Walk
    for (const b of BUILDINGS) {
      expect(buildableAt(b.position).code).toBe('protected');
      const door = doorPosition(b);
      expect(buildableAt(door).code).toBe('protected');
    }
    expect(buildableAt({ x: -35, z: -43.5 }).code).toBe('water'); // the creek
    expect(buildableAt({ x: 0, z: 70 }).code).toBe('out_of_bounds');
    expect(buildableAt({ x: 500, z: 0 }).code).toBe('out_of_bounds');
    expect(buildableAt(SITE).code).toBe('ok');
  });
});

describe('protected zones come from the official world export', () => {
  it('refuses every building footprint and door apron of PROTECTED_ZONES (and a margin around them)', () => {
    for (const z of PROTECTED_ZONES) {
      const r = buildableAt(z.center);
      expect(r.code, z.id).toBe('protected');
      if (z.kind === 'door_apron') expect(r.label, z.id).toMatch(/doorway$/);
      // Read mid-sentence ("Too close to …"): never "the The Café doorway", never a capital "The".
      expect(r.label, z.id).not.toMatch(/the The|^The /);
      // 0.5 m outside the zone's edge is still inside the building margin.
      const edge = { x: z.center.x + Math.sin(z.yaw) * (z.halfDepth + 0.5), z: z.center.z + Math.cos(z.yaw) * (z.halfDepth + 0.5) };
      expect(zoneContains(z, edge)).toBe(false);
      expect(buildableAt(edge).code, `${z.id} margin`).not.toBe('ok');
    }
  });
  it('names the Café naturally in refusals ("Too close to the Café doorway")', () => {
    const cafe = PROTECTED_ZONES.filter((z) => z.buildingId === 'cafe');
    expect(buildableAt(cafe.find((z) => z.kind === 'door_apron')!.center).label).toBe('the Café doorway');
    expect(buildableAt(cafe.find((z) => z.kind === 'building')!.center).label).toBe('the Café');
  });
  it('a whole piece is refused when any part of it touches a protected zone', () => {
    const door = PROTECTED_ZONES.find((z) => z.kind === 'door_apron')!;
    const v = validatePlacement(req('floor', Math.round(door.center.x), Math.round(door.center.z)), ctx(new PieceIndex()));
    expect(v.ok).toBe(false);
  });
});

describe('validatePlacement refusals', () => {
  const index = new PieceIndex();
  it('rejects malformed requests', () => {
    expect(refusal(index, req('castle', SITE.x, SITE.z))).toBe('unknown_piece');
    expect(refusal(index, req('wall', SITE.x, SITE.z, 0, 0, 'neon'))).toBe('bad_variant');
    expect(refusal(index, req('wall', SITE.x + 0.3, SITE.z))).toBe('off_grid');
    expect(refusal(index, { ...req('wall', SITE.x, SITE.z), x: Number.NaN })).toBe('off_grid');
    expect(refusal(index, req('wall', SITE.x, SITE.z, 5))).toBe('bad_rotation');
    expect(refusal(index, req('wall', SITE.x, SITE.z, 0.5))).toBe('bad_rotation');
    expect(refusal(index, req('wall', SITE.x, SITE.z, 0, -1))).toBe('bad_level');
    expect(refusal(index, req('wall', SITE.x, SITE.z, 0, CONFIG.building.maxLevel))).toBe('bad_level');
    expect(refusal(index, req('roof_flat', SITE.x, SITE.z, 0, 0))).toBe('bad_level');
    expect(refusal(index, req('fence', SITE.x, SITE.z, 0, 1))).toBe('bad_level');
  });
  it('rejects bad places', () => {
    expect(refusal(index, req('floor', 1, 3))).toBe('protected');
    expect(refusal(index, req('crate', -35, -43.5))).toBe('water');
    expect(refusal(index, req('crate', 0, 75))).toBe('out_of_bounds');
    expect(refusal(index, req('floor', -50, -18))).toBe('too_steep');
    expect(refusal(index, req('crate', 10, 19))).toBe('obstructed');
  });
  it('rejects out of range builders and players in the way', () => {
    expect(refusal(index, req('wall', SITE.x, SITE.z), { builderPos: { x: SITE.x + 20, z: SITE.z } })).toBe('too_far');
    expect(refusal(index, req('wall', SITE.x, SITE.z), { builderPos: { x: SITE.x + 2, z: SITE.z } })).toBe('ok');
    expect(refusal(index, req('wall', SITE.x, SITE.z), { players: [{ x: SITE.x + 0.5, z: SITE.z + 0.3 }] })).toBe('player_in_way');
    // A doorway may not be dropped onto someone standing in its gap either.
    expect(refusal(index, req('doorway', SITE.x, SITE.z), { players: [{ x: SITE.x, z: SITE.z }] })).toBe('player_in_way');
    // Non-solid pieces (floor, rug) are fine under a player.
    expect(refusal(index, req('floor', SITE.x, SITE.z), { players: [{ x: SITE.x, z: SITE.z }] })).toBe('ok');
  });
  it('rejects overlap by layer, allows layering', () => {
    const ix = new PieceIndex();
    put(ix, req('floor', SITE.x, SITE.z));
    expect(refusal(ix, req('floor', SITE.x + 1, SITE.z))).toBe('overlap');
    expect(refusal(ix, req('rug', SITE.x, SITE.z))).toBe('ok');
    put(ix, req('wall', SITE.x, SITE.z - 1));
    expect(refusal(ix, req('wall', SITE.x, SITE.z - 1, 0))).toBe('overlap');
    expect(refusal(ix, req('wall', SITE.x, SITE.z - 1, 1))).toBe('overlap'); // crossing
    expect(refusal(ix, req('wall', SITE.x + 2, SITE.z - 1))).toBe('ok'); // touching end to end
    expect(refusal(ix, req('wall', SITE.x - 1, SITE.z, 1))).toBe('ok'); // corner joint
    expect(refusal(ix, req('wall', SITE.x, SITE.z, 1))).toBe('ok'); // T-junction
    expect(refusal(ix, req('pillar', SITE.x + 1, SITE.z - 1))).toBe('ok'); // pillar at the wall's end
    expect(refusal(ix, req('pillar', SITE.x, SITE.z - 1))).toBe('overlap'); // pillar in the middle
    expect(refusal(ix, req('wall', SITE.x + 1, SITE.z - 1))).toBe('overlap'); // parallel, half on top
  });
});

describe('stacking and support', () => {
  it('builds two storeys of walls, an upper floor and a roof; heights stack', () => {
    const ix = new PieceIndex();
    const w0 = put(ix, req('wall', SITE.x, SITE.z - 1));
    expect(refusal(ix, req('wall', SITE.x + 4, SITE.z - 1, 0, 1))).toBe('unsupported');
    const w1 = put(ix, req('wall', SITE.x, SITE.z - 1, 0, 1));
    expect(w1.y).toBeCloseTo(w0.y + CONFIG.building.storeyHeight, 2);
    const f1 = put(ix, req('floor', SITE.x, SITE.z, 0, 1));
    expect(f1.y).toBeCloseTo(w0.y + CONFIG.building.storeyHeight, 2);
    const r2 = put(ix, req('roof_slope', SITE.x, SITE.z, 0, 2));
    expect(r2.y).toBeCloseTo(w1.y + CONFIG.building.storeyHeight, 2);
    // Furniture upstairs needs a floor at that level.
    expect(refusal(ix, req('table', SITE.x, SITE.z, 0, 1))).toBe('ok');
    expect(refusal(ix, req('table', SITE.x + 4, SITE.z, 0, 1))).toBe('unsupported');
    // A wall can stand on an upper floor too.
    expect(refusal(ix, req('wall', SITE.x, SITE.z + 0.5, 0, 1))).toBe('ok');
    // Roofs and floors clash on the same level; walls and roofs too.
    expect(refusal(ix, req('roof_flat', SITE.x, SITE.z, 0, 1))).toBe('overlap');
  });
  it('only rests on your own pieces', () => {
    const ix = new PieceIndex();
    put(ix, req('wall', SITE.x, SITE.z - 1), OTHER);
    expect(refusal(ix, req('wall', SITE.x, SITE.z - 1, 0, 1))).toBe('not_your_support');
    expect(refusal(ix, req('roof_flat', SITE.x, SITE.z, 0, 1))).toBe('not_your_support');
  });
  it('furniture on a ground floor rests on its top', () => {
    const ix = new PieceIndex();
    const f = put(ix, req('floor', SITE.x, SITE.z));
    const t = put(ix, req('table', SITE.x, SITE.z));
    expect(t.y).toBeCloseTo(f.y + PIECES.floor.h, 2);
  });
  it('auto level climbs onto your own wall and reports the useful refusal otherwise', () => {
    const ix = new PieceIndex();
    put(ix, req('wall', SITE.x, SITE.z - 1));
    const a = autoLevel({ kind: 'wall', variant: 'cream', x: SITE.x, z: SITE.z - 1, rot: 0 }, ctx(ix));
    expect(a.ok && a.level).toBe(1);
    const b = autoLevel({ kind: 'roof_flat', variant: 'slate', x: SITE.x + 4, z: SITE.z, rot: 0 }, ctx(ix));
    expect(!b.ok && b.reason).toBe('unsupported');
    const c = autoLevel({ kind: 'floor', variant: 'planks', x: 0, z: 2, rot: 0 }, ctx(ix));
    expect(!c.ok && c.reason).toBe('protected');
  });
  it('dependents and cascade removal', () => {
    const ix = new PieceIndex();
    const w0 = put(ix, req('wall', SITE.x, SITE.z - 1));
    const w0b = put(ix, req('wall', SITE.x, SITE.z + 1));
    const w1 = put(ix, req('wall', SITE.x, SITE.z - 1, 0, 1));
    const roof = put(ix, req('roof_flat', SITE.x, SITE.z, 0, 2));
    const f = put(ix, req('floor', SITE.x + 4, SITE.z + 4));
    const crate = put(ix, req('crate', SITE.x + 4, SITE.z + 4));
    expect(directDependents(ix, w0.id).map((p) => p.id)).toEqual([w1.id]);
    expect(directDependents(ix, w1.id).map((p) => p.id)).toEqual([roof.id]);
    expect(directDependents(ix, w0b.id)).toEqual([]);
    expect(directDependents(ix, f.id).map((p) => p.id)).toEqual([crate.id]);
    expect(cascadeRemoval(ix, [w0.id]).sort()).toEqual([w0.id, w1.id, roof.id].sort());
    // Cascade does not touch the index itself.
    expect(ix.size).toBe(6);
  });
  it('index keeps per-owner counts and spatial queries', () => {
    const ix = new PieceIndex();
    const a = put(ix, req('crate', SITE.x, SITE.z));
    put(ix, req('crate', SITE.x + 2, SITE.z), OTHER);
    expect(ix.countFor(ME)).toBe(1);
    expect(ix.countFor(OTHER)).toBe(1);
    expect(ix.query(footprint('crate', SITE.x, SITE.z, 0)).map((p) => p.id)).toEqual([a.id]);
    ix.remove(a.id);
    expect(ix.countFor(ME)).toBe(0);
    expect(ix.query(footprint('crate', SITE.x, SITE.z, 0))).toEqual([]);
  });
  it('snaps structural pieces to 1 m, furnishings to 0.5 m, odd spans to half metres', () => {
    expect(snapToGrid('wall', { x: 3.4, z: -1.6 }, 0)).toEqual({ x: 3, z: -2 });
    expect(snapToGrid('chair', { x: 3.4, z: -1.6 }, 0)).toEqual({ x: 3.5, z: -1.5 });
    expect(snapToGrid('steps', { x: 3.2, z: 1.2 }, 0)).toEqual({ x: 3, z: 1.5 });
    expect(snapToGrid('steps', { x: 3.2, z: 1.2 }, 1)).toEqual({ x: 3.5, z: 1 });
  });
});

describe('walk surface', () => {
  it('lifts feet onto ground floors and steps, not onto upper floors or rugs', () => {
    const ix = new PieceIndex();
    const f = put(ix, req('floor', SITE.x, SITE.z));
    expect(walkSurfaceAt(ix, { x: SITE.x + 0.5, z: SITE.z - 0.5 })).toBeCloseTo(f.y + PIECES.floor.h, 5);
    expect(walkSurfaceAt(ix, { x: SITE.x + 3, z: SITE.z })).toBeNull();
    const st = put(ix, req('steps', SITE.x + 4, SITE.z + 0.5));
    // rot 0: the upper tread is the back half (local -Z).
    expect(walkSurfaceAt(ix, { x: SITE.x + 4, z: SITE.z + 0.3 })).toBeCloseTo(st.y + 0.36, 5);
    expect(walkSurfaceAt(ix, { x: SITE.x + 4, z: SITE.z + 0.8 })).toBeCloseTo(st.y + 0.2, 5);
  });
});

describe('piece collision (dynamic layer)', () => {
  it('walls block, doorways and gates let you through, floors and upper pieces never block', () => {
    const w = createCollisionWorld();
    const mk = (id: string, kind: PieceLike['kind'], x: number, z: number, rot = 0, level = 0): PieceLike => ({ id, kind, x, z, rot, level, y: 0, ownerId: ME });
    const wall = mk('w', 'wall', SITE.x, SITE.z);
    const door = mk('d', 'doorway', SITE.x + 4, SITE.z);
    const gate = mk('g', 'gate', SITE.x + 8, SITE.z);
    for (const p of [wall, door, gate, mk('f', 'floor', SITE.x, SITE.z + 4), mk('u', 'wall', SITE.x, SITE.z + 8, 0, 1)]) {
      const c = pieceColliders(p);
      if (p.kind === 'floor' || p.level > 0) expect(c).toEqual([]);
      w.dynamic.set(p.id, c);
    }
    const cross = (x: number) => resolveMovement({ x, z: SITE.z - 1.5 }, { x, z: SITE.z + 1.5 }, CONFIG.movement.playerRadius, w);
    expect(cross(SITE.x).z).toBeLessThan(SITE.z); // wall blocks
    expect(cross(SITE.x + 4).z).toBeCloseTo(SITE.z + 1.5, 3); // doorway gap
    expect(cross(SITE.x + 8).z).toBeCloseTo(SITE.z + 1.5, 3); // open gate
    expect(isWalkable({ x: SITE.x, z: SITE.z + 4 }, CONFIG.movement.playerRadius, w)).toBe(true); // on a floor
    expect(isWalkable({ x: SITE.x, z: SITE.z + 8 }, CONFIG.movement.playerRadius, w)).toBe(true); // under an upstairs wall
    w.dynamic.remove('w');
    expect(cross(SITE.x).z).toBeCloseTo(SITE.z + 1.5, 3);
  });
});
