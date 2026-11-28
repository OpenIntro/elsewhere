/**
 * Round-2 build plans (piece lists) for the browser scripts and the
 * screenshot / scale tools. Coordinates are piece centres on the build grid;
 * `level` is the storey. Wall mounts use the wall's centre + rot = the face
 * they look out of. House roofs carry `params` ({ w, d, style, pitch }).
 */

/** Ground-floor + first-floor walls of a w × d rectangle (wall lines at x0..x1, z0..z1), doorway on the south side. */
function storeyWalls(x0, z0, x1, z1, level, opts = {}) {
  const out = [];
  const v = opts.variant ?? 'cream';
  const doorAt = opts.doorX ?? null;
  for (let x = x0 + 1; x < x1; x += 2) {
    out.push({ kind: (x - x0) % 4 === 3 && level > 0 ? 'wall_window' : 'wall', x, z: z0, rot: 0, level, variant: v });
    const south = doorAt !== null && x === doorAt ? 'doorway' : (x - x0) % 4 === 3 || level > 0 ? 'wall_window' : 'wall';
    out.push({ kind: south, x, z: z1, rot: 0, level, variant: v });
  }
  for (let z = z0 + 1; z < z1; z += 2) {
    out.push({ kind: level > 0 && (z - z0) % 4 === 1 ? 'wall_window' : 'wall', x: x0, z, rot: 1, level, variant: v });
    out.push({ kind: (z - z0) % 4 === 3 ? 'wall_window' : 'wall', x: x1, z, rot: 1, level, variant: v });
  }
  return out;
}

function floors(x0, z0, x1, z1, variant = 'planks') {
  const out = [];
  for (let x = x0 + 1; x < x1; x += 2) for (let z = z0 + 1; z < z1; z += 2) out.push({ kind: 'floor', x, z, level: 0, variant });
  return out;
}

/**
 * The e2e / showcase house: 4 × 4 m, two storeys, one gable roof, a name
 * board over the door, furnished. Centre (-18, 1): wall lines x -20..-16,
 * z -1..3 (open meadow west of the Town Square; House 1 stands 10 m west).
 */
export const HOUSE = { x: -18, z: 1, x0: -20, z0: -1, x1: -16, z1: 3 };
/** A garden wall just north-east of the house: it stands where bush_37 grows (clear the bush first). */
export const BUSH_WALL = { kind: 'wall', x: -16, z: -2, rot: 1, level: 0, variant: 'stone', bush: 'bush_37' };
export function twoStoreyHouse(c = HOUSE, name = 'Fern Cottage') {
  const { x0, z0, x1, z1 } = c;
  return {
    floors: floors(x0, z0, x1, z1),
    ground: storeyWalls(x0, z0, x1, z1, 0, { doorX: x0 + 1 }),
    upper: storeyWalls(x0, z0, x1, z1, 1),
    roof: { kind: 'house_roof', x: (x0 + x1) / 2, z: (z0 + z1) / 2, rot: 0, level: 2, variant: 'clay', params: { w: x1 - x0, d: z1 - z0, style: 'gable', pitch: 1 } },
    sign: { kind: 'name_board', x: x0 + 1, z: z1, rot: 0, level: 0, variant: 'oak', text: name },
    furniture: [
      { kind: 'bed', x: x1 - 1.5, z: z0 + 1, rot: 1, level: 0, variant: 'sage' },
      { kind: 'table', x: x0 + 2.5, z: z1 - 1, rot: 0, level: 0, variant: 'oak' },
      { kind: 'chair', x: x0 + 2.5, z: z1 - 2, rot: 0, level: 0, variant: 'oak' },
      { kind: 'fireplace', x: x0 + 0.5, z: z0 + 1, rot: 1, level: 0, variant: 'brick' },
      { kind: 'table_lamp', x: x0 + 2.5, z: z1 - 1, rot: 0, level: 0, variant: 'ochre' },
      // Mounts on the far walls' inner faces (the ones the camera looks at).
      { kind: 'wall_shelf', x: x0, z: z1 - 1, rot: 1, level: 0, variant: 'oak' },
      { kind: 'picture', x: x0 + 1, z: z0, rot: 0, level: 0, variant: 'meadow' },
    ],
  };
}

/** A single-storey hip-roofed cottage (6 × 4). */
export function hipHouse(c) {
  const x0 = c.x - 3;
  const x1 = c.x + 3;
  const z0 = c.z - 2;
  const z1 = c.z + 2;
  return [
    ...floors(x0, z0, x1, z1, 'flagstone'),
    ...storeyWalls(x0, z0, x1, z1, 0, { doorX: c.x, variant: 'sage' }),
    { kind: 'house_roof', x: c.x, z: c.z, rot: 1, level: 1, variant: 'slate', params: { w: 4, d: 6, style: 'hip', pitch: 0 } },
    { kind: 'name_hanging', x: x1, z: z0 + 1, rot: 1, level: 0, variant: 'green', text: 'The Willows' },
    { kind: 'chimney', x: x0, z: c.z - 1, rot: 0, level: 1, variant: 'stone' },
  ];
}

/**
 * An L-shaped house: a 6 × 4 main block (ridge along X) and a 4 × 4 wing to
 * the south-east (ridge along Z); the two gable roofs intersect.
 */
export function lHouse(c) {
  const out = [];
  const mx0 = c.x - 3;
  const mx1 = c.x + 3;
  const mz0 = c.z - 2;
  const mz1 = c.z + 2;
  // Main block walls, minus the south wall where the wing joins (x from c.x-1+... to mx1).
  for (const w of storeyWalls(mx0, mz0, mx1, mz1, 0, { doorX: mx0 + 1, variant: 'rose' })) {
    if (w.z === mz1 && w.x > c.x - 1) continue;
    out.push(w);
  }
  // Wing: x c.x-1 .. mx1, z mz1 .. mz1+4 (its north side is open into the main block).
  const wx0 = c.x - 1;
  const wz1 = mz1 + 4;
  for (let x = wx0 + 1; x < mx1; x += 2) out.push({ kind: x === wx0 + 1 ? 'wall_window' : 'wall', x, z: wz1, rot: 0, level: 0, variant: 'rose' });
  for (let z = mz1 + 1; z < wz1; z += 2) {
    out.push({ kind: 'wall', x: wx0, z, rot: 1, level: 0, variant: 'rose' });
    out.push({ kind: 'wall_window', x: mx1, z, rot: 1, level: 0, variant: 'rose' });
  }
  out.push({ kind: 'house_roof', x: c.x, z: c.z, rot: 1, level: 1, variant: 'clay', params: { w: 4, d: 6, style: 'gable', pitch: 1 } });
  // The wing's roof runs on to the main ridge (a cross gable): same span and pitch, so the ridges meet.
  out.push({ kind: 'house_roof', x: c.x + 1, z: mz1 + 1, rot: 0, level: 1, variant: 'clay', params: { w: 4, d: 6, style: 'gable', pitch: 1 } });
  out.push({ kind: 'name_plaque', x: c.x + 2, z: wz1, rot: 0, level: 0, variant: 'navy', text: 'Corner House' });
  return out;
}

/** Every piece of the two-storey house in build order. */
export function houseOrder(h) {
  return [...h.floors, ...h.ground, ...h.upper, h.roof, h.sign, ...h.furniture];
}
