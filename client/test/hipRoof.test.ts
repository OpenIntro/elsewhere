/**
 * The player house's hip roof (client/src/build/meshes2.ts): watertight
 * facets, the same ridge height, eave datum and footprint as the earlier hip
 * (the town kit's `pavilionRoof`, which houseRoof used before), and never more
 * triangles than the gable of the same size.
 */
import { Box3, BufferGeometry, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ROOF_OVERHANGS, parseRoofParams, roofParamsString, roofRise, type RoofParams } from '@elsewhere/shared';
import { templateFor, templateTriangles } from '../src/build/meshes.js';
import { HIP_EAVE_Y, hipSurface, hipTiles } from '../src/build/meshes2.js';
import { pavilionRoof } from '../src/world/arch/kit.js';
import { GeoBuilder, T, box } from '../src/world/geom.js';

const SPANS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
/** Every size 2x2 .. 12x12 (both orientations: w x d and d x w), both pitches, default eaves. */
const CASES: RoofParams[] = [];
for (const w of SPANS) for (const d of SPANS) for (const pitch of [0, 1] as const) CASES.push({ w, d, style: 'hip', pitch, overhang: ROOF_OVERHANGS[0]! });
/** The shortened eaves the roof tool uses next to protected land, on a spread of sizes. */
for (const overhang of ROOF_OVERHANGS.slice(1)) for (const [w, d] of [[2, 2], [4, 6], [6, 4], [12, 3], [12, 12]]) for (const pitch of [0, 1] as const) CASES.push({ w: w!, d: d!, style: 'hip', pitch, overhang });
const label = (r: RoofParams) => `${r.w}x${r.d} pitch ${r.pitch} eaves ${r.overhang}`;

function bounds(t: Map<string, BufferGeometry>): Box3 {
  const b = new Box3();
  for (const g of t.values()) {
    g.computeBoundingBox();
    b.union(g.boundingBox!);
  }
  return b;
}
/** The hip as houseRoof drew it before (wall plate + the town kit's pavilionRoof). */
function legacyHipBounds(r: RoofParams): Box3 {
  const B = new GeoBuilder(1);
  B.add('solid', box(r.w + 0.3, 0.14, r.d + 0.3), '#888', T(0, 0.05, 0));
  pavilionRoof(B, r.w, r.d, roofRise(r), '#888', r.overhang);
  return bounds(B.build());
}
const tpl = (r: RoofParams, style = r.style) => templateFor('house_roof', 'slate', false, roofParamsString({ ...r, style }));

describe('hip roof', () => {
  it('facets meet along the hips and the ridge (only the eave line is open)', () => {
    const q = (n: number) => Math.round(n * 1000); // 1 mm
    for (const r of CASES) {
      const g = hipSurface(r);
      const p = g.getAttribute('position');
      const key = (i: number) => `${q(p.getX(i))},${q(p.getY(i))},${q(p.getZ(i))}`;
      const edges = new Map<string, { n: number; a: number; b: number }>();
      for (let t = 0; t < p.count; t += 3)
        for (const [i, j] of [[t, t + 1], [t + 1, t + 2], [t + 2, t]] as const) {
          const ka = key(i);
          const kb = key(j);
          if (ka === kb) continue;
          const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          const e = edges.get(k) ?? { n: 0, a: i, b: j };
          e.n++;
          edges.set(k, e);
        }
      const hw = r.w / 2 + r.overhang;
      const hd = r.d / 2 + r.overhang;
      let open = 0;
      for (const e of edges.values()) {
        expect(e.n, `${label(r)}: an edge shared by ${e.n} triangles`).toBeLessThanOrEqual(2);
        if (e.n === 2) continue;
        open++;
        // A free edge must be an eave: both ends on the eave line at the datum.
        for (const i of [e.a, e.b]) {
          expect(Math.abs(p.getY(i) - HIP_EAVE_Y), `${label(r)}: free edge above the eave`).toBeLessThan(0.001);
          const onEdge = Math.abs(Math.abs(p.getX(i)) - hw) < 0.001 || Math.abs(Math.abs(p.getZ(i)) - hd) < 0.001;
          expect(onEdge, `${label(r)}: free edge inside the roof at (${p.getX(i)}, ${p.getZ(i)})`).toBe(true);
        }
      }
      expect(open, label(r)).toBe(4); // one per eave
    }
  });

  it('reaches roofRise above the eave datum, no higher than the earlier hip, within its footprint', () => {
    for (const r of CASES) {
      const s = hipSurface(r);
      s.computeBoundingBox();
      expect(Math.abs(s.boundingBox!.max.y - HIP_EAVE_Y - roofRise(r)), `${label(r)} ridge height`).toBeLessThanOrEqual(0.02);
      expect(Math.abs(s.boundingBox!.min.y - HIP_EAVE_Y), `${label(r)} eave datum`).toBeLessThanOrEqual(0.001);
      const now = bounds(tpl(r));
      const before = legacyHipBounds(r);
      for (const a of ['x', 'z'] as const) {
        expect(Math.abs(now.max[a] - before.max[a]), `${label(r)} max ${a}: ${now.max[a]} vs ${before.max[a]}`).toBeLessThanOrEqual(0.02);
        expect(Math.abs(now.min[a] - before.min[a]), `${label(r)} min ${a}: ${now.min[a]} vs ${before.min[a]}`).toBeLessThanOrEqual(0.02);
      }
      // Caps and finials never stand above the earlier hip's (the cutaway's clip heights are unchanged).
      expect(now.max.y, `${label(r)} top`).toBeLessThanOrEqual(before.max.y + 0.02);
    }
  });

  it('has tile courses on all four facets and never more triangles than the same-size gable', () => {
    const rows: string[] = [];
    for (const r of CASES) {
      const facets = new Set(hipTiles(r).map((t) => t.facet));
      expect(facets.size, `${label(r)} facets with tiles`).toBe(4);
      const hip = templateTriangles(tpl(r));
      const gable = templateTriangles(tpl(r, 'gable'));
      expect(hip, `${label(r)}: hip ${hip} vs gable ${gable}`).toBeLessThanOrEqual(gable);
      if (r.overhang === ROOF_OVERHANGS[0] && ((r.w === 4 && r.d === 6) || (r.w === 12 && r.d === 12))) rows.push(`${label(r)}: hip ${hip}, gable ${gable}`);
    }
    expect(rows.length).toBe(4);
  });

  it('reads roofs stored before this change (no migration): the same params string renders', () => {
    // As stored by roofParamsString since round 2 (default eaves left out) and with shortened eaves.
    for (const stored of ['{"w":4,"d":6,"s":"hip","p":0}', '{"w":2,"d":2,"s":"hip","p":1,"o":0.25}']) {
      const r = parseRoofParams(stored)!;
      expect(r.style).toBe('hip');
      const t = templateFor('house_roof', 'clay', false, stored);
      expect(templateTriangles(t)).toBeGreaterThan(0);
      const b = bounds(t);
      expect(b.getSize(new Vector3()).x).toBeGreaterThan(r.w);
    }
  });
});
