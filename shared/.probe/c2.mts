import { INTERIORS, collidesAt, PATHS, getBuilding, zoneLocal } from '../src/index.js';
const c = INTERIORS.find((i) => i.id === 'cafe')!;
console.log(collidesAt(c.anchors.table_1!.position)?.id);
for (const id of ['general_store', 'town_hall', 'boathouse']) {
  const i = INTERIORS.find((x) => x.id === id)!;
  for (const p of PATHS) if (['path_store_woods', 'trail_hall_woods', 'path_coastal'].includes(p.id)) console.log(id, p.id, p.points.map((q) => { const l = zoneLocal(i.footprint, q); return `(${l.x.toFixed(1)},${l.z.toFixed(1)})`; }).join(' '));
  console.log(id, 'yaw', i.footprint.yaw.toFixed(2), 'half', i.footprint.halfWidth, i.footprint.halfDepth, 'center', i.footprint.center);
}
