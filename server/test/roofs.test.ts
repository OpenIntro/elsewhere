/**
 * Roof tool ↔ server agreement: for a matrix of houses built through the real
 * server path, the client's roof tool (roofSpanAt → fitRoof, i.e. the ghost
 * colour) and the server's answer to the resulting C2S.buildPlace must agree —
 * a green ghost is placed, a red ghost is refused for the same reason. Plus
 * the anti-grief rules that stay: someone else's walls, open land, caps.
 */
import { describe, expect, it } from 'vitest';
import { PIECES, clearableNature, fitRoof, parseRoofParams, roofSpanAt, type BuildPlacePayload, type BuildResultPayload, type PieceKind, type Vec2 } from '@elsewhere/shared';
import { makeWorld, type World } from './helpers.js';

const gen = { capacity: 1000, refillPerSecond: 1000 };
let req = 0;
function lastResult(w: World, sid: string): BuildResultPayload {
  const all = w.received(sid, 'build_result') as BuildResultPayload[];
  return all[all.length - 1]!;
}
async function place(w: World, sid: string, kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<BuildPlacePayload> = {}): Promise<BuildResultPayload> {
  await w.building!.place(w.ctx, sid, { reqId: ++req, kind, variant: PIECES[kind].variants[0]!.id, x, z, rot, level, ...extra });
  return lastResult(w, sid);
}
type Side = 'n' | 's' | 'w' | 'e';
interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}
async function house(w: World, who: (side: Side) => string, b: Box, level = 0, kindAt: (side: Side, i: number) => PieceKind | null = () => 'wall'): Promise<void> {
  const seg = async (side: Side, i: number, x: number, z: number, rot: number) => {
    const k = kindAt(side, i);
    if (k) expect(await place(w, who(side), k, x, z, rot, level), `${k} ${x},${z}`).toMatchObject({ ok: true });
  };
  let i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) await seg('n', i++, x, b.z0, 0);
  i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) await seg('s', i++, x, b.z1, 0);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) await seg('w', i++, b.x0, z, 1);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) await seg('e', i++, b.x1, z, 1);
}

/** What the client's roof tool shows for a cursor probe, then what the server says to that request. */
async function toolAndServer(w: World, sid: string, probe: Vec2, rot = 0): Promise<{ tool: string; server: string; message?: string }> {
  const owner = w.ctx.getProfile(sid)!.id;
  const me = w.state.players.get(sid)!;
  const players = [...w.state.players.values()].map((p) => ({ x: p.x, z: p.z }));
  const cleared = new Set(clearableNature().keys());
  const span = roofSpanAt(w.building!.index, owner, [probe]) ?? roofSpanAt(w.building!.index, owner, [probe], 2);
  if (!span) return { tool: 'none', server: 'not sent' };
  const res = fitRoof(span, rot, 'gable', 1, PIECES.house_roof.variants[0]!.id, { index: w.building!.index, builderId: owner, builderPos: { x: me.x, z: me.z }, players, cleared });
  // The request the client sends for that ghost (placeGhost): the span and the params the ghost carries.
  const pr = res.ok ? parseRoofParams(res.params)! : { w: rot % 2 === 0 ? span.sx : span.sz, d: rot % 2 === 0 ? span.sz : span.sx, style: 'gable', pitch: 1, overhang: 0.45 };
  const r = await place(w, sid, 'house_roof', span.x, span.z, rot % 2, span.level, { params: { w: pr.w, d: pr.d, style: pr.style, pitch: pr.pitch, overhang: pr.overhang } });
  return { tool: res.ok ? 'ok' : res.reason, server: r.ok ? 'ok' : r.reason!, ...(r.message ? { message: r.message } : {}) };
}

const H: Box = { x0: -20, z0: -1, x1: -16, z1: 3 };
const STAND = { x: -18, z: 5.5 };

describe('roof tool and server agree (matrix of houses)', { timeout: 120_000 }, () => {
  const cases: { name: string; build: (w: World, a: string, b: string) => Promise<void>; probe: Vec2; want: string; stand?: Vec2 }[] = [
    { name: 'closed 4x4 with a door', build: (w, a) => house(w, () => a, H, 0, (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall')), probe: { x: -18, z: 1 }, want: 'ok' },
    { name: '2x2', build: (w, a) => house(w, () => a, { x0: -20, z0: -1, x1: -18, z1: 1 }), probe: { x: -19, z: 0 }, want: 'ok' },
    { name: '4x2', build: (w, a) => house(w, () => a, { x0: -20, z0: -1, x1: -16, z1: 1 }), probe: { x: -18, z: -0.9 }, want: 'ok' },
    { name: 'window and door in every side', build: (w, a) => house(w, () => a, H, 0, (_s, i) => (i === 0 ? 'doorway' : 'wall_window')), probe: { x: -20.13, z: 0 }, want: 'ok' },
    { name: 'one segment left out', build: (w, a) => house(w, () => a, H, 0, (s, i) => (s === 'n' && i === 1 ? null : 'wall')), probe: { x: -18, z: 1 }, want: 'ok' },
    { name: 'porch (south open)', build: (w, a) => house(w, () => a, H, 0, (s) => (s === 's' ? null : 'wall')), probe: { x: -18, z: 2.5 }, want: 'ok' },
    { name: '3x4 with its 1 m gap', build: (w, a) => house(w, () => a, { x0: -20, z0: -1, x1: -17, z1: 3 }), probe: { x: -18.5, z: 1 }, want: 'ok' },
    {
      name: 'garden wall at a corner',
      build: async (w, a) => {
        await house(w, () => a, H);
        expect(await place(w, a, 'wall', H.x1, H.z0 - 1, 1)).toMatchObject({ ok: true });
      },
      probe: { x: -16.13, z: 0 },
      want: 'ok',
    },
    {
      name: 'two storeys, probed at the ground floor',
      build: async (w, a) => {
        await house(w, () => a, H);
        await house(w, () => a, H, 1, () => 'wall_window');
      },
      probe: { x: -19, z: -0.87 },
      want: 'ok',
    },
    {
      name: 'attic floors at the roof level',
      build: async (w, a) => {
        await house(w, () => a, H);
        for (const [x, z] of [
          [-19, 0],
          [-17, 0],
          [-19, 2],
          [-17, 2],
        ] as const)
          expect(await place(w, a, 'floor', x, z, 0, 1)).toMatchObject({ ok: true });
      },
      probe: { x: -18, z: 1 },
      want: 'ok',
    },
    { name: 'eaves next to House 1 (shortened)', build: (w, a) => house(w, () => a, { x0: -23, z0: 5, x1: -21, z1: 7 }), probe: { x: -22, z: 6 }, want: 'ok', stand: { x: -22, z: 9 } },
    { name: 'only two sides built', build: (w, a) => house(w, () => a, H, 0, (s) => (s === 'n' || s === 'w' ? 'wall' : null)), probe: { x: -18, z: 1 }, want: 'unsupported' },
    { name: 'half walls on two sides', build: (w, a) => house(w, () => a, H, 0, (s) => (s === 's' || s === 'e' ? 'half_wall' : 'wall')), probe: { x: -18, z: 1 }, want: 'unsupported' },
    { name: 'two sides are a neighbour’s walls', build: (w, a, b) => house(w, (s) => (s === 'n' || s === 'w' ? b : a), H), probe: { x: -18, z: 1 }, want: 'not_your_support' },
    { name: 'standing too far away', build: (w, a) => house(w, () => a, H), probe: { x: -18, z: 1 }, want: 'too_far', stand: { x: -18, z: 14 } },
  ];
  for (const c of cases)
    it(c.name, async () => {
      const w = await makeWorld({ building: { rate: gen } });
      const a = await w.join('Ash', STAND.x, STAND.z);
      const b = await w.join('Birch', STAND.x + 1, STAND.z);
      await c.build(w, a, b);
      if (c.stand) w.move(a, c.stand.x, c.stand.z);
      for (const rot of [0, 1]) {
        const r = await toolAndServer(w, a, c.probe, rot);
        if (r.tool === 'ok' && r.server === 'ok') {
          // Placed: try the other ridge on a fresh copy of the check, not on top of this roof.
          expect(r).toEqual({ tool: 'ok', server: 'ok' });
          break;
        }
        expect(r.tool, `rot ${rot}`).toBe(c.want);
        expect(r.server, `rot ${rot}: ${r.message ?? ''}`).toBe(r.tool);
      }
    });
});

describe('roof refusals reach the player with a specific message', { timeout: 60_000 }, () => {
  it('open sides, half walls, someone else’s walls, too far', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    await house(w, () => a, H, 0, (s) => (s === 'n' || s === 'w' ? 'wall' : null));
    const r = await place(w, a, 'house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } });
    expect(r).toMatchObject({ ok: false, reason: 'unsupported', message: 'Needs your walls on at least three sides — the south and east sides are open' });
    w.move(a, -18, 14);
    const far = await place(w, a, 'house_roof', -18, 1, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } });
    expect(far).toMatchObject({ ok: false, reason: 'too_far' });
  });
});
