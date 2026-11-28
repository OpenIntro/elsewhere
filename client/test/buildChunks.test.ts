/**
 * Chunked build instancing (client/src/build/BuildLayer.tsx): every instanced group is split by a
 * square spatial cell so frustum culling can skip the cells out of view. The grouping is pure
 * (`planRegroup`); these tests drive it the way BuildLayer's rebuild does.
 */
import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, Vector3 } from 'three';
import { roofParamsString, type PieceKind, type PieceRecord } from '@elsewhere/shared';
import { BUILD_CHUNK_M, BUILD_SPLIT_MIN_TRIS, baseKey, chunkOf, fitGroupSphere, groupKey, planRegroup, type GroupSlots, type RegroupOptions } from '../src/build/BuildLayer.js';

let nextId = 0;
function piece(kind: PieceKind, x: number, z: number, extra: Partial<PieceRecord> = {}): PieceRecord {
  return { id: `p${++nextId}`, kind, variant: 'oak', x, z, rot: 0, level: 0, y: 0, ownerId: 'o', ownerName: 'O', ...extra };
}

/** What BuildLayer keeps per group, driven by planRegroup exactly as rebuild() applies it. */
class Groups {
  /** Default: every template split by cell (the threshold has its own test). */
  constructor(readonly opts: RegroupOptions = { minTris: 0 }) {}
  readonly map = new Map<string, GroupSlots & { list: PieceRecord[]; fade: Float32Array; cut: Float32Array }>();
  apply(all: PieceRecord[], dirty: Set<PieceKind> | null) {
    const plan = planRegroup(this.map, all, dirty, this.opts);
    for (const key of plan.emptied) {
      const g = this.map.get(key)!;
      g.list = [];
    }
    for (const [key, f] of plan.fill) {
      const g = this.map.get(key) ?? { kind: f.list[0]!.kind, list: [], fade: new Float32Array(0), cut: new Float32Array(0) };
      const cap = Math.max(g.fade.length, f.list.length);
      g.fade = new Float32Array(cap);
      g.cut = new Float32Array(cap);
      g.fade.set(f.fade);
      g.cut.set(f.cut);
      g.list = f.list;
      this.map.set(key, g);
    }
    return plan;
  }
  /** piece id → every (group, index) it occupies. */
  slots(): Map<string, { key: string; index: number }[]> {
    const out = new Map<string, { key: string; index: number }[]>();
    for (const [key, g] of this.map) g.list.forEach((p, index) => out.set(p.id, [...(out.get(p.id) ?? []), { key, index }]));
    return out;
  }
}

describe('build chunks', () => {
  it('chunk assignment is deterministic and follows the piece centre', () => {
    expect(BUILD_CHUNK_M).toBeGreaterThan(0);
    expect(chunkOf(0, 0)).toBe('0,0');
    expect(chunkOf(-0.01, 0)).toBe('-1,0');
    expect(chunkOf(BUILD_CHUNK_M - 0.01, BUILD_CHUNK_M)).toBe('0,1');
    const p = piece('wall', 31, -7);
    const keys = new Set(Array.from({ length: 20 }, () => groupKey({ ...p })));
    expect(keys.size).toBe(1);
    // Same kind / style in two cells: two groups; the same cell: one.
    expect(groupKey(piece('wall', 1, 1))).toBe(groupKey(piece('wall', 2, 3)));
    expect(groupKey(piece('wall', 1, 1))).not.toBe(groupKey(piece('wall', BUILD_CHUNK_M + 1, 1)));
    // The old key parts still separate groups inside one cell.
    expect(groupKey(piece('wall', 1, 1))).not.toBe(groupKey(piece('wall', 1, 1, { variant: 'stone' })));
    expect(groupKey(piece('floor', 1, 1))).not.toBe(groupKey(piece('floor', 1, 1, { level: 1 })));
  });

  it('remove + place lands in the right chunk', () => {
    const g = new Groups();
    const a = piece('crate', 2, 2);
    const b = piece('crate', 5, 3);
    let all = [a, b];
    g.apply(all, null);
    expect(g.slots().get(a.id)![0]!.key).toBe(groupKey(a));
    // Remove b, place c two cells east.
    const c = piece('crate', 2 * BUILD_CHUNK_M + 3, 2);
    all = [a, c];
    const plan = g.apply(all, new Set<PieceKind>(['crate']));
    const s = g.slots();
    expect(s.has(b.id)).toBe(false);
    expect(s.get(c.id)).toEqual([{ key: groupKey(c), index: 0 }]);
    expect(groupKey(c)).toContain(`|${chunkOf(c.x, c.z)}`);
    expect(g.map.get(groupKey(a))!.list.map((p) => p.id)).toEqual([a.id]);
    // Removing the last piece of a cell empties that group.
    const plan2 = g.apply([c], new Set<PieceKind>(['crate']));
    expect(plan2.emptied).toEqual([groupKey(a)]);
    expect(plan.emptied).toEqual([]);
  });

  it('a 12 m roof crossing a chunk edge is in exactly one group, and its group culls by the whole roof', () => {
    const params = roofParamsString({ w: 12, d: 6, style: 'gable', pitch: 0, overhang: 1 } as never);
    const roof = piece('house_roof', BUILD_CHUNK_M + 0.5, 3, { params, level: 1, y: 2.6 });
    const g = new Groups();
    g.apply([roof, piece('wall', BUILD_CHUNK_M - 3, 3), piece('wall', BUILD_CHUNK_M + 4, 3)], null);
    const s = g.slots().get(roof.id)!;
    expect(s).toHaveLength(1);
    expect(s[0]!.key).toBe(groupKey(roof));
    // The instanced mesh of that group gets a bounding sphere around the whole 12 m roof, so it is not
    // culled while its far end (in the neighbouring cell) is on screen.
    const mesh = new InstancedMesh(new BoxGeometry(12, 2, 6), new MeshBasicMaterial(), 1);
    mesh.setMatrixAt(0, new Matrix4().makeTranslation(roof.x, roof.y, roof.z));
    mesh.computeBoundingSphere();
    const sph = mesh.boundingSphere!;
    expect(sph.center.x - sph.radius).toBeLessThanOrEqual(roof.x - 6);
    expect(sph.center.x + sph.radius).toBeGreaterThanOrEqual(roof.x + 6);
  });

  it('a light template stays one group; once its pieces add up to the threshold it splits by cell, keeping fades', () => {
    expect(BUILD_SPLIT_MIN_TRIS).toBeGreaterThan(0);
    const g = new Groups({ minTris: 1000, trisOf: () => 100 });
    const far = (i: number) => piece('lamp', i * BUILD_CHUNK_M + 1, 1);
    let all = Array.from({ length: 9 }, (_, i) => far(i));
    g.apply(all, null);
    // 9 x 100 < 1000: one group for all nine cells.
    expect(new Set([...g.slots().values()].map((s) => s[0]!.key))).toEqual(new Set([groupKey(all[0]!, BUILD_CHUNK_M, false)]));
    const one = g.map.get(groupKey(all[0]!, BUILD_CHUNK_M, false))!;
    one.fade[3] = 0.8;
    const faded = one.list[3]!;
    all = [...all, far(9)];
    const plan = g.apply(all, new Set<PieceKind>(['lamp']));
    // 10 x 100: split, one group per cell; the old whole group is emptied; the fade went with its piece.
    expect(plan.emptied).toEqual([groupKey(all[0]!, BUILD_CHUNK_M, false)]);
    const s = g.slots();
    for (const p of all) expect(s.get(p.id)).toEqual([{ key: groupKey(p), index: 0 }]);
    expect(g.map.get(groupKey(faded))!.fade[0]).toBeCloseTo(0.8, 5);
  });

  it("a group's bounding sphere holds every instance and does not depend on the instances' order", () => {
    const pts: [number, number, number, number][] = [];
    let rnd = 7;
    const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 40; i++) pts.push([rand() * BUILD_CHUNK_M, rand() * 6, rand() * BUILD_CHUNK_M, i % 4]);
    const make = (order: [number, number, number, number][]) => {
      const mesh = new InstancedMesh(new BoxGeometry(2, 2.6, 0.2), new MeshBasicMaterial(), order.length);
      order.forEach(([x, y, z, rot], i) => mesh.setMatrixAt(i, new Matrix4().makeRotationY(rot * (Math.PI / 2)).setPosition(x, y, z)));
      return mesh;
    };
    const a = fitGroupSphere(make(pts)).clone();
    const reversed = make([...pts].reverse());
    const b = fitGroupSphere(reversed);
    expect(b.center.distanceTo(a.center)).toBeLessThan(1e-9);
    expect(Math.abs(b.radius - a.radius)).toBeLessThan(1e-9);
    // Every corner of every instance is inside.
    const geo = reversed.geometry;
    geo.computeBoundingBox();
    const m = new Matrix4();
    const box = new Box3();
    const c = new Vector3();
    for (let i = 0; i < reversed.count; i++) {
      reversed.getMatrixAt(i, m);
      box.copy(geo.boundingBox!).applyMatrix4(m);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) expect(c.set(x, y, z).distanceTo(b.center)).toBeLessThanOrEqual(b.radius + 1e-9);
    }
    // three's own (grown instance by instance) is never tighter than this one.
    reversed.computeBoundingSphere();
    expect(b.radius).toBeLessThanOrEqual(reversed.boundingSphere!.radius + 1e-9);
  });

  const tris = (p: PieceRecord) => (p.kind === 'house_roof' ? 800 : 100);
  it.each([
    ['every template split', { minTris: 0 }],
    ['templates splitting and joining at a threshold', { minTris: 1500, trisOf: tris }],
  ] as [string, RegroupOptions][])('after a burst of adds and removes every piece id has exactly one (group, index), with its fade / cut slot (%s)', (_, opts) => {
    const g = new Groups(opts);
    const expectedKey = (p: PieceRecord, all: PieceRecord[]) => {
      const n = all.filter((q) => baseKey(q) === baseKey(p)).length;
      return groupKey(p, BUILD_CHUNK_M, (opts.trisOf ?? (() => 1))(p) * n >= opts.minTris!);
    };
    const kinds: PieceKind[] = ['wall', 'floor', 'crate', 'lamp', 'house_roof'];
    let rnd = 12345;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let all: PieceRecord[] = [];
    // Fade / cut the model expects per id (set like updateFade does, then carried through rebuilds).
    const want = new Map<string, [number, number]>();
    for (let round = 0; round < 60; round++) {
      const dirty = new Set<PieceKind>();
      const adds = Math.floor(rand() * 12);
      for (let i = 0; i < adds; i++) {
        const k = kinds[Math.floor(rand() * kinds.length)]!;
        const p = piece(k, (rand() - 0.5) * 150, (rand() - 0.5) * 150, k === 'house_roof' ? { params: roofParamsString({ w: 4, d: 6, style: 'hip', pitch: 1, overhang: 1 } as never) } : {});
        all.push(p);
        dirty.add(k);
      }
      const removes = Math.floor(rand() * 6);
      for (let i = 0; i < removes && all.length; i++) {
        const [gone] = all.splice(Math.floor(rand() * all.length), 1);
        want.delete(gone!.id);
        dirty.add(gone!.kind);
      }
      g.apply(all, rand() < 0.1 ? null : dirty);
      // Every live piece in exactly one slot, of the group its key names; no dead piece anywhere.
      const s = g.slots();
      expect(s.size).toBe(all.length);
      for (const p of all) {
        const at = s.get(p.id)!;
        expect(at).toHaveLength(1);
        expect(at[0]!.key).toBe(expectedKey(p, all));
        const grp = g.map.get(at[0]!.key)!;
        expect(grp.list[at[0]!.index]).toBe(p);
        const w = want.get(p.id) ?? [0, 0];
        expect(grp.fade[at[0]!.index]).toBeCloseTo(w[0], 5);
        expect(grp.cut[at[0]!.index]).toBeCloseTo(w[1], 5);
      }
      // Fade / cut some pieces (as the cutaway would) before the next burst.
      for (const p of all) {
        if (rand() < 0.3) {
          const at = s.get(p.id)![0]!;
          const grp = g.map.get(at.key)!;
          const v: [number, number] = [Math.round(rand() * 100) / 100 || 0.5, Math.round(rand() * 100) / 100];
          grp.fade[at.index] = v[0];
          grp.cut[at.index] = v[1];
          want.set(p.id, v);
        }
      }
    }
    expect(all.length).toBeGreaterThan(50);
    expect(new Set(all.map((p) => expectedKey(p, all).split('|').pop())).size).toBeGreaterThan(4);
  });
});
