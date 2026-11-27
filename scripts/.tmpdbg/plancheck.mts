import { PIECES, PieceIndex, validatePlacement, roofSpanAt, fitRoof, refusalText, type PieceLike } from '@elsewhere/shared';
import { ROOF_HOUSES, ROOF_REFUSALS } from '../lib/roofPlans.mjs';
const ix = new PieceIndex(); const cleared = new Set<string>(); let n = 0;
const owner = (o: string) => (o === 'B' ? 'pb' : 'pa');
for (const h of [...ROOF_HOUSES, ...ROOF_REFUSALS]) for (const w of h.build(h.box)) {
  let r = validatePlacement({ ...w }, { index: ix, builderId: owner(w.owner), builderPos: null, players: [], cleared });
  if (!r.ok && r.natureId) { cleared.add(r.natureId); r = validatePlacement({ ...w }, { index: ix, builderId: owner(w.owner), builderPos: null, players: [], cleared }); }
  if (!r.ok) { console.log('WALL REFUSED', h.id, w.kind, w.x, w.z, w.level, r.reason, r.label ?? ''); continue; }
  ix.add({ id: 'p' + n++, kind: r.kind, x: r.x, z: r.z, rot: r.rot, level: r.level, y: r.y, ownerId: owner(w.owner) } as PieceLike);
}
console.log('clear first:', [...cleared].join(','));
for (const h of [...ROOF_HOUSES, ...ROOF_REFUSALS]) {
  const c = { x: (h.box.x0 + h.box.x1) / 2, z: (h.box.z0 + h.box.z1) / 2 };
  const span = roofSpanAt(ix, 'pa', [c]) ?? roofSpanAt(ix, 'pa', [c], 2);
  if (!span) { console.log(h.id, 'NO SPAN'); continue; }
  const r = fitRoof(span, 0, 'gable', 1, PIECES.house_roof.variants[0]!.id, { index: ix, builderId: 'pa', builderPos: (h as { far?: boolean }).far ? { x: c.x, z: c.z + 13 } : null, players: [], cleared });
  console.log(h.id, `${span.sx}x${span.sz} L${span.level}`, r.ok ? `OK ${r.params}` : `${r.reason} "${refusalText(r.reason, r.label)}"`);
}
