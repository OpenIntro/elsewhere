import { INTERIORS, PATHS, zoneLocal, TREES, LOCATIONS } from '../src/index.js';
for (const i of INTERIORS) for (const p of PATHS) {
  let worst = Infinity;
  for (let k = 0; k + 1 < p.points.length; k++) { const a = p.points[k]!, c = p.points[k + 1]!; for (let t = 0; t <= 1; t += 0.01) { const q = { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t }; const l = zoneLocal(i.footprint, q); const ex = Math.max(Math.abs(l.x) - i.footprint.halfWidth, 0), ez = Math.max(Math.abs(l.z) - i.footprint.halfDepth, 0); worst = Math.min(worst, Math.hypot(ex, ez) - p.width / 2); } }
  if (worst < 0.3) console.log(i.id, p.id, worst.toFixed(2));
}
const w = LOCATIONS.find((l) => l.id === 'woods')!;
console.log('woods trees', TREES.filter((t) => Math.hypot(t.position.x - w.center.x, t.position.z - w.center.z) < w.radius).length);
console.log('total trees', TREES.length, 'tree ids in woods idx<=115', TREES.filter((t, i) => i < 115 && Math.hypot(t.position.x - w.center.x, t.position.z - w.center.z) < w.radius).length);
