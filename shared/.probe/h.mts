import { BUILDINGS, terrainHeight, rotateOffset } from '../src/index.js';
const NEW: Record<string, [number, number]> = { cafe: [11, 8.5], general_store: [10.5, 8.5], town_hall: [15, 12], workshop: [11.5, 9], house_1: [7.6, 6.8], house_2: [7.6, 6.8], boathouse: [7.5, 6.5] };
for (const b of BUILDINGS) {
  for (const [tag, w, d, shift] of [['old', b.width, b.depth, 0], ['new', ...(NEW[b.id] ?? [b.width, b.depth]), ((NEW[b.id]?.[1] ?? b.depth) - b.depth) / 2]] as [string, number, number, number][]) {
    const c = (() => { const o = rotateOffset({ x: 0, z: -shift }, b.yaw); return { x: b.position.x + o.x, z: b.position.z + o.z }; })();
    const h = (lx: number, lz: number) => { const q = rotateOffset({ x: lx, z: lz }, b.yaw); return terrainHeight(c.x + q.x, c.z + q.z).toFixed(2); };
    console.log(b.id, tag, 'C', h(0, 0), 'F', h(0, d / 2 + 1), 'B', h(0, -d / 2), 'FL', h(-w / 2, d / 2), 'FR', h(w / 2, d / 2), 'BL', h(-w / 2, -d / 2), 'BR', h(w / 2, -d / 2));
  }
}
