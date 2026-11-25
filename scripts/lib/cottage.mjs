/**
 * Build plans used by the browser scripts. Coordinates are piece centres on
 * the build grid; `y: 'top'` aims at the top of the storey below (walls),
 * so the UI puts the piece on the next storey.
 *
 * The site (centre -18, 1) is open meadow ~18 m west of the Town Square
 * spawn, verified buildable by shared/test/building.test.ts.
 */
export const SITE = { x: -18, z: 1 };

/** A small 4 x 2 m hut: floor, walls, a doorway (south), a window, a peaked roof. */
export function hutPlan(c = SITE) {
  const x0 = c.x - 1;
  const x1 = c.x + 1;
  return [
    { kind: 'floor', x: x0, z: c.z, variant: 'planks' },
    { kind: 'floor', x: x1, z: c.z, variant: 'planks' },
    { kind: 'wall', x: x0, z: c.z - 1, rot: 0, variant: 'cream' },
    { kind: 'wall', x: x1, z: c.z - 1, rot: 0, variant: 'cream' },
    { kind: 'wall', x: c.x - 2, z: c.z, rot: 1, variant: 'cream' },
    { kind: 'wall', x: c.x + 2, z: c.z, rot: 1, variant: 'cream' },
    { kind: 'doorway', x: x0, z: c.z + 1, rot: 0, variant: 'cream' },
    { kind: 'wall_window', x: x1, z: c.z + 1, rot: 0, variant: 'cream' },
    { kind: 'roof_peak', x: x0, z: c.z, rot: 1, level: 1, variant: 'terracotta', top: true },
    { kind: 'roof_peak', x: x1, z: c.z, rot: 1, level: 1, variant: 'terracotta', top: true },
  ];
}

/** A 6 x 4 m cottage with a pitched gable roof, porch lamp, sign, planter and bench. */
export function cottagePlan(c = SITE) {
  const xs = [c.x - 2, c.x, c.x + 2];
  const zn = c.z - 2;
  const zs = c.z + 2;
  const out = [];
  for (const x of xs) for (const z of [c.z - 1, c.z + 1]) out.push({ kind: 'floor', x, z, variant: 'planks' });
  out.push({ kind: 'wall', x: xs[0], z: zn, rot: 0, variant: 'cream' });
  out.push({ kind: 'wall_window', x: xs[1], z: zn, rot: 2, variant: 'cream' });
  out.push({ kind: 'wall', x: xs[2], z: zn, rot: 0, variant: 'cream' });
  out.push({ kind: 'wall_window', x: xs[0], z: zs, rot: 0, variant: 'cream' });
  out.push({ kind: 'doorway', x: xs[1], z: zs, rot: 0, variant: 'cream' });
  out.push({ kind: 'wall_window', x: xs[2], z: zs, rot: 0, variant: 'cream' });
  out.push({ kind: 'wall', x: c.x - 3, z: c.z - 1, rot: 1, variant: 'cream' });
  out.push({ kind: 'wall_window', x: c.x - 3, z: c.z + 1, rot: 3, variant: 'cream' });
  out.push({ kind: 'wall', x: c.x + 3, z: c.z - 1, rot: 1, variant: 'cream' });
  out.push({ kind: 'wall_window', x: c.x + 3, z: c.z + 1, rot: 1, variant: 'cream' });
  // Gable roof, ridge along X: north slopes face north (rot 2), south slopes face south (rot 0).
  for (const x of xs) out.push({ kind: 'roof_slope', x, z: c.z - 1, rot: 2, level: 1, variant: 'terracotta', top: true });
  for (const x of xs) out.push({ kind: 'roof_slope', x, z: c.z + 1, rot: 0, level: 1, variant: 'terracotta', top: true });
  // Gable ends (each half rises towards the ridge).
  out.push({ kind: 'gable', x: c.x - 3, z: c.z - 1, rot: 3, level: 1, variant: 'cream', top: true });
  out.push({ kind: 'gable', x: c.x - 3, z: c.z + 1, rot: 1, level: 1, variant: 'cream', top: true });
  out.push({ kind: 'gable', x: c.x + 3, z: c.z - 1, rot: 3, level: 1, variant: 'cream', top: true });
  out.push({ kind: 'gable', x: c.x + 3, z: c.z + 1, rot: 1, level: 1, variant: 'cream', top: true });
  // Porch and garden.
  out.push({ kind: 'steps', x: c.x, z: zs + 0.5, rot: 0, variant: 'flagstone' });
  out.push({ kind: 'lamp', x: c.x + 1.5, z: zs + 1.5, variant: 'iron' });
  out.push({ kind: 'sign', x: c.x - 2, z: zs + 2, rot: 0, variant: 'oak', text: 'Fern Cottage' });
  out.push({ kind: 'planter', x: c.x + 2.5, z: zs + 0.5, variant: 'marigold' });
  out.push({ kind: 'rug', x: c.x, z: c.z, variant: 'madder' });
  out.push({ kind: 'table', x: c.x + 1.5, z: c.z - 0.5, variant: 'walnut' });
  out.push({ kind: 'chair', x: c.x + 1.5, z: c.z + 0.5, rot: 2, variant: 'walnut' });
  return out;
}
