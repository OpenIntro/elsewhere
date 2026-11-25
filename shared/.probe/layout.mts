import { BUILDINGS, PATHS, INTERACTABLES, TREES, ROCKS, DECOR, FENCES, PROPS, terrainHeight, distanceToPolyline, rotateOffset } from '../src/index.js';
const NEW: Record<string, [number, number]> = { cafe: [11, 8.5], general_store: [10.5, 8.5], town_hall: [15, 12], workshop: [11.5, 9], house_1: [7.6, 6.8], house_2: [7.6, 6.8], boathouse: [7.5, 6.5] };
for (const b of BUILDINGS) {
  const nd = NEW[b.id]; if (!nd) continue;
  const [w, d] = nd;
  const shift = (d - b.depth) / 2;
  const o = rotateOffset({ x: 0, z: -shift }, b.yaw);
  const c = { x: b.position.x + o.x, z: b.position.z + o.z };
  const loc = (p: {x:number;z:number}) => { const dx = p.x - c.x, dz = p.z - c.z, cs = Math.cos(b.yaw), sn = Math.sin(b.yaw); return { x: dx * cs - dz * sn, z: dx * sn + dz * cs }; };
  const inside = (p: {x:number;z:number}, m: number) => { const l = loc(p); return Math.abs(l.x) < w / 2 + m && Math.abs(l.z) < d / 2 + m; };
  const hits: string[] = [];
  for (const p of PATHS) for (let i = 0; i < 200; i++) { /* sample */ }
  for (let lx = -w / 2 - 1; lx <= w / 2 + 1; lx += 0.5) for (let lz = -d / 2 - 1; lz <= d / 2 + 0.2; lz += 0.5) {
    const q = rotateOffset({ x: lx, z: lz }, b.yaw); const p = { x: c.x + q.x, z: c.z + q.z };
    for (const pa of PATHS) if (distanceToPolyline(p, pa.points) < pa.width / 2 && !hits.includes('path ' + pa.id)) hits.push('path ' + pa.id);
  }
  for (const i of INTERACTABLES) if (inside(i.position, 0.8)) hits.push(`int ${i.id} ${JSON.stringify(loc(i.position))}`);
  for (const t of TREES) if (inside(t.position, 0.8)) hits.push('tree ' + t.id);
  for (const t of ROCKS) if (inside(t.position, 0.8)) hits.push('rock ' + t.id);
  for (const t of DECOR) if (inside(t.position, 0.8)) hits.push('decor ' + t.id);
  for (const t of PROPS) if (inside(t.position, 0.8)) hits.push('prop ' + t.id);
  for (const f of FENCES) if (inside(f.a, 0.5) || inside(f.b, 0.5)) hits.push('fence ' + f.id);
  for (const o2 of BUILDINGS) if (o2.id !== b.id && Math.hypot(o2.position.x - c.x, o2.position.z - c.z) < (Math.hypot(w, d) + Math.hypot(o2.width, o2.depth)) / 2 + 1) hits.push('bld ' + o2.id);
  let hmin = 1e9, hmax = -1e9;
  for (let lx = -w / 2; lx <= w / 2; lx += 0.5) for (let lz = -d / 2; lz <= d / 2; lz += 0.5) { const q = rotateOffset({ x: lx, z: lz }, b.yaw); const h = terrainHeight(c.x + q.x, c.z + q.z); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
  console.log(b.id, 'center', c.x.toFixed(2), c.z.toFixed(2), 'yaw', b.yaw.toFixed(3), 'hc', terrainHeight(c.x, c.z).toFixed(2), 'range', hmin.toFixed(2), hmax.toFixed(2), '\n   ', hits.join('\n    '));
}
