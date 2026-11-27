import { PIECES, PieceIndex, validatePlacement, roofSpanAt, fitRoof, refusalText, buildableAt, clearableNature, type PieceLike } from '@elsewhere/shared';
const CLEARED = new Set(clearableNature().keys());
type W = { kind: string; x: number; z: number; rot: number; level: number; owner?: string };
// Walls of a rectangle x0..x1, z0..z1 (even sizes) at a level; opts: door/window per side, gaps
function rect(x0: number, z0: number, x1: number, z1: number, level = 0, kindAt: (side: string, i: number) => string | null = () => 'wall'): W[] {
  const out: W[] = [];
  let i = 0;
  for (let x = x0 + 1; x < x1; x += 2) { const k = kindAt('n', i++); if (k) out.push({ kind: k, x, z: z0, rot: 0, level }); }
  i = 0; for (let x = x0 + 1; x < x1; x += 2) { const k = kindAt('s', i++); if (k) out.push({ kind: k, x, z: z1, rot: 0, level }); }
  i = 0; for (let z = z0 + 1; z < z1; z += 2) { const k = kindAt('w', i++); if (k) out.push({ kind: k, x: x0, z, rot: 1, level }); }
  i = 0; for (let z = z0 + 1; z < z1; z += 2) { const k = kindAt('e', i++); if (k) out.push({ kind: k, x: x1, z, rot: 1, level }); }
  return out;
}
function build(ws: W[], index = new PieceIndex()) {
  let n = 0; const refused: string[] = [];
  for (const w of ws) {
    const owner = w.owner ?? 'me';
    const r = validatePlacement({ kind: w.kind, variant: PIECES[w.kind as 'wall'].variants[0]!.id, x: w.x, z: w.z, rot: w.rot, level: w.level }, { index, builderId: owner, builderPos: null, players: [], cleared: CLEARED });
    if (!r.ok) { refused.push(`${w.kind}@${w.x},${w.z}L${w.level}:${r.reason}`); continue; }
    index.add({ id: `p${n++}${Math.random()}`, kind: r.kind, x: r.x, z: r.z, rot: r.rot, level: r.level, y: r.y, ownerId: owner } as PieceLike);
  }
  return { index, refused };
}
function tryRoof(name: string, ws: W[], seedPick: (idx: PieceIndex) => PieceLike | undefined, builderPos: { x: number; z: number } | null, extra?: (idx: PieceIndex) => void) {
  const { index, refused } = build(ws);
  extra?.(index);
  const seed = seedPick(index);
  if (!seed) return console.log(name, 'NO SEED', refused);
  const me = (seed as PieceLike).ownerId;
  const span = roofSpanAt(index, me, [{ x: seed.x, z: seed.z }]) ?? roofSpanAt(index, me, [{ x: seed.x, z: seed.z }], 2);
  if (!span) return console.log(`${name}: no span`, refused.length ? refused : '');
  for (const rot of [0, 1]) {
    const r = fitRoof(span, rot, 'gable', 1, PIECES.house_roof.variants[0]!.id, { index, builderId: me, builderPos, players: [], cleared: CLEARED });
    console.log(`${name}: span ${span.sx}x${span.sz}@(${span.x},${span.z}) L${span.level} rot${rot} -> ${r.ok ? `OK ${r.params}` : `${r.reason} "${refusalText(r.reason, r.label)}"`}`, refused.length ? refused : '');
  }
}
const top = (idx: PieceIndex) => { let b: PieceLike | undefined; for (const p of idx.all()) if (PIECES[p.kind].structural && (!b || p.level > b.level)) b = p; return b; };
const low = (idx: PieceIndex) => { for (const p of idx.all()) if (PIECES[p.kind].structural && p.level === 0) return p; };
// site: house at HOUSE (-20..-16, -1..3)
const X0 = -20, Z0 = -1;
tryRoof('A 4x4 one storey', rect(X0, Z0, X0 + 4, Z0 + 4), top, null);
tryRoof('B 2x2', rect(X0, Z0, X0 + 2, Z0 + 2), top, null);
tryRoof('C 4x2', rect(X0, Z0, X0 + 4, Z0 + 2), top, null);
tryRoof('D 6x4', rect(X0 - 2, Z0, X0 + 4, Z0 + 4), top, null);
tryRoof('E doors+windows every side', rect(X0, Z0, X0 + 4, Z0 + 4, 0, (s, i) => (i === 0 ? 'doorway' : 'wall_window')), top, null);
tryRoof('F one segment missing', rect(X0, Z0, X0 + 4, Z0 + 4, 0, (s, i) => (s === 'n' && i === 1 ? null : 'wall')), top, null);
tryRoof('G whole side open (porch)', rect(X0, Z0, X0 + 4, Z0 + 4, 0, (s) => (s === 's' ? null : 'wall')), top, null);
tryRoof('H two storeys, seed upper', [...rect(X0, Z0, X0 + 4, Z0 + 4), ...rect(X0, Z0, X0 + 4, Z0 + 4, 1)], top, null);
tryRoof('I two storeys, seed LOWER wall (cursor on ground floor)', [...rect(X0, Z0, X0 + 4, Z0 + 4), ...rect(X0, Z0, X0 + 4, Z0 + 4, 1)], low, null);
tryRoof('J garden wall attached at corner', [...rect(X0, Z0, X0 + 4, Z0 + 4), { kind: 'wall', x: X0 + 4, z: Z0 - 1, rot: 1, level: 0 }], low, null);
tryRoof('K fence attached at corner', [...rect(X0, Z0, X0 + 4, Z0 + 4), { kind: 'fence', x: X0 + 5, z: Z0 + 4, rot: 0, level: 0 }], low, null);
tryRoof('L 3x4 (odd side → gap)', rect(X0, Z0, X0 + 3, Z0 + 4), low, null);
tryRoof('M mixed owners (one side theirs)', rect(X0, Z0, X0 + 4, Z0 + 4).map((w) => (w.rot === 0 && w.z === Z0 ? { ...w, owner: 'them' } : w)), (idx) => [...idx.all()].find((p) => p.ownerId === 'me'), null);
tryRoof('N mixed owners (two sides theirs)', rect(X0, Z0, X0 + 4, Z0 + 4).map((w) => (w.rot === 0 ? { ...w, owner: 'them' } : w)), (idx) => [...idx.all()].find((p) => p.ownerId === 'me'), null);
tryRoof('O ceiling floors at level 1', [...rect(X0, Z0, X0 + 4, Z0 + 4), { kind: 'floor', x: X0 + 1, z: Z0 + 1, rot: 0, level: 1 }, { kind: 'floor', x: X0 + 3, z: Z0 + 1, rot: 0, level: 1 }, { kind: 'floor', x: X0 + 1, z: Z0 + 3, rot: 0, level: 1 }, { kind: 'floor', x: X0 + 3, z: Z0 + 3, rot: 0, level: 1 }], low, null);
tryRoof('P 8x8 player outside 2 m from a side', rect(X0 - 4, Z0 - 2, X0 + 4, Z0 + 6), low, { x: X0 - 4 - 2, z: Z0 + 2 });
tryRoof('Q 6x6 player outside at a corner', rect(X0 - 2, Z0 - 2, X0 + 4, Z0 + 4), low, { x: X0 + 5.5, z: Z0 + 5.5 });
tryRoof('R pillars at corners + walls', [...rect(X0, Z0, X0 + 4, Z0 + 4), { kind: 'pillar', x: X0, z: Z0, rot: 0, level: 0 }], low, null);
tryRoof('S half walls one side', rect(X0, Z0, X0 + 4, Z0 + 4, 0, (s) => (s === 's' ? 'half_wall' : 'wall')), low, null);
console.log('--- big site');
const BX = -22, BZ = 17;
tryRoof('P2 8x8 player 1 m outside a side', rect(BX, BZ, BX + 8, BZ + 8), low, { x: BX - 1, z: BZ + 4 });
tryRoof('Q2 8x8 player at outside corner', rect(BX, BZ, BX + 8, BZ + 8), low, { x: BX - 1, z: BZ - 1 });
tryRoof('Q3 6x6 player at outside corner', rect(BX, BZ, BX + 6, BZ + 6), low, { x: BX - 1, z: BZ - 1 });
tryRoof('Q4 8x6 player inside at far end', rect(BX, BZ, BX + 8, BZ + 6), low, { x: BX + 0.8, z: BZ + 3 });
