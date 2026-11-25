import { BUILDINGS, PATHS, INTERIORS, zoneContains, zoneLocal, distanceToPolyline, buildingLocal, TREES, ROCKS, DECOR, PROPS, FENCES, INTERACTABLES, LOCATIONS, terrainHeight, groundHeight, isWalkable, locationAt, FURNITURE, zoneCorners } from '../src/index.js';
for (const i of INTERIORS) {
  const b = BUILDINGS.find((x) => x.id === i.id)!;
  for (const p of PATHS) {
    let hit = 0;
    for (let k = 0; k + 1 < p.points.length; k++) { const a = p.points[k]!, c = p.points[k + 1]!; for (let t = 0; t <= 1; t += 0.02) { const q = { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t }; const l = zoneLocal(i.footprint, q); if (Math.abs(l.x) < i.footprint.halfWidth + p.width / 2 && Math.abs(l.z) < i.footprint.halfDepth + p.width / 2 - 0.0 && l.z < i.footprint.halfDepth - 0.2) hit++; } }
    if (hit) console.log('PATH', i.id, p.id, hit);
  }
  for (const t of [...TREES, ...ROCKS]) if (zoneContains(i.footprint, t.position, 1)) console.log('NATURE', i.id, t.id);
  for (const d of [...DECOR, ...PROPS]) if (zoneContains(i.footprint, d.position, 0.6)) console.log('DECOR', i.id, d.id, JSON.stringify(zoneLocal(i.footprint, d.position)));
  for (const f of FENCES) if (zoneContains(i.footprint, f.a, 0.3) || zoneContains(i.footprint, f.b, 0.3)) console.log('FENCE', i.id, f.id);
  for (const it of INTERACTABLES) { if (zoneContains(i.footprint, it.position, 0) && it.kind !== 'door') { const ok = isWalkable(it.position) || it.kind === 'archive' || it.kind==='inspect' || it.kind==='pickup' || 'seats' in it; console.log('INSIDE', i.id, it.id, ok ? '' : 'UNWALKABLE?'); } }
  // anchors
  for (const a of Object.values(i.anchors)) if (!isWalkable(a.position)) console.log('ANCHOR NOT WALKABLE', i.id, a.name);
  // location of corners
  for (const c of zoneCorners(i.footprint)) if (locationAt(c)?.id !== i.locationId) console.log('LOC', i.id, 'corner in', locationAt(c)?.id);
  // ramp continuity
  const d = i.doors[0]!;
  let prev = groundHeight(d.inside.x, d.inside.z); let maxStep = 0;
  for (let t = 0; t <= 1; t += 0.02) { const q = { x: d.inside.x + (d.outside.x - d.inside.x) * t, z: d.inside.z + (d.outside.z - d.inside.z) * t }; const h = groundHeight(q.x, q.z); maxStep = Math.max(maxStep, Math.abs(h - prev)); prev = h; }
  console.log(i.id, 'floorY', i.floorY.toFixed(2), 'base', i.baseY.toFixed(2), 'door ramp max step', maxStep.toFixed(3), 'inside walk', isWalkable(d.inside), 'outside walk', isWalkable(d.outside));
}
// terrain cliffs near buildings
let worst = 0;
for (let x = -60; x < 60; x += 0.5) for (let z = -70; z < 60; z += 0.5) { const a = terrainHeight(x, z); worst = Math.max(worst, Math.abs(terrainHeight(x + 0.5, z) - a), Math.abs(terrainHeight(x, z + 0.5) - a)); }
console.log('worst terrain step', worst.toFixed(3));
