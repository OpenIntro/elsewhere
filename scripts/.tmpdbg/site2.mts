import { buildableAt, terrainHeight, WORLD_BOUNDS, staticObstacleAt } from '@elsewhere/shared';
const out: [number, number, number][] = [];
for (let cx = Math.ceil(WORLD_BOUNDS.minX); cx < WORLD_BOUNDS.maxX; cx += 1) for (let cz = Math.ceil(WORLD_BOUNDS.minZ); cz < WORLD_BOUNDS.maxZ; cz += 1) {
  let ok = true; let lo = Infinity, hi = -Infinity;
  for (let x = cx - 2.4; x <= cx + 2.4 && ok; x += 0.4) for (let z = cz - 2.4; z <= cz + 2.4 && ok; z += 0.4) { if (buildableAt({ x, z }).code !== 'ok') ok = false; const h = terrainHeight(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  if (!ok || hi - lo > 0.45) continue;
  if (staticObstacleAt({ minX: cx - 2.2, maxX: cx + 2.2, minZ: cz - 2.2, maxZ: cz + 2.2 })) continue;
  out.push([cx, cz, Math.hypot(cx + 4.5, cz + 0.6)]);
}
out.sort((a, b) => a[2] - b[2]);
// greedy non-overlapping picks (centres ≥ 7 m apart)
const pick: typeof out = [];
for (const s of out) if (pick.every((p) => Math.hypot(p[0] - s[0], p[1] - s[1]) >= 7)) pick.push(s);
console.log(pick.slice(0, 20).map((p) => `${p[0]},${p[1]} (${p[2].toFixed(0)} m)`).join('\n'));
