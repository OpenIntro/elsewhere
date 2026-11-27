import { buildableAt, terrainHeight, WORLD_BOUNDS, staticObstacleAt, natureBlocking, clearableNature } from '@elsewhere/shared';
const C = new Set(clearableNature().keys());
const out: string[] = [];
for (let cx = Math.ceil(WORLD_BOUNDS.minX); cx < WORLD_BOUNDS.maxX; cx += 2) for (let cz = Math.ceil(WORLD_BOUNDS.minZ); cz < WORLD_BOUNDS.maxZ; cz += 2) {
  let ok = true; let lo = Infinity, hi = -Infinity;
  for (let x = cx - 3; x <= cx + 3 && ok; x += 0.5) for (let z = cz - 3; z <= cz + 3 && ok; z += 0.5) { if (buildableAt({ x, z }).code !== 'ok') ok = false; const h = terrainHeight(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  if (!ok || hi - lo > 0.5) continue;
  const r = { minX: cx - 2.2, maxX: cx + 2.2, minZ: cz - 2.2, maxZ: cz + 2.2 };
  if (staticObstacleAt(r)) continue;
  out.push(`${cx},${cz} slope ${(hi - lo).toFixed(2)}`);
}
console.log(out.slice(0, 80).join('\n'), '\ncount', out.length);
