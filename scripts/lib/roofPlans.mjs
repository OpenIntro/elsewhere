/**
 * Houses for scripts/e2e-roofs.mjs: ordinary houses as people build them
 * (one and two storeys, doors and windows in every side, a wall left out, an
 * odd 3 m side with its 1 m gap, an open porch, 2x2 / 2x3 / 6x4, a garden
 * wall touching a corner, someone else's walls, a house next to House 1) and
 * deliberately invalid ones (two sides only, half walls, mostly someone
 * else's walls). Walls only — the roofs are put on through the real UI.
 *
 * Each house: { id, box: {x0,z0,x1,z1}, walls: [{kind,x,z,rot,level,owner:'A'|'B'}], ... }.
 * Sites were found by scanning for open, buildable, gentle land near the spawn.
 */

/** Walls of a rectangle (2 m segments; an odd side ends in a 1 m gap). kindAt(side, i) → kind or null; ownerOf(side) → 'A' | 'B'. */
export function rectWalls(b, { level = 0, kindAt = () => 'wall', ownerOf = () => 'A', variant = 'cream' } = {}) {
  const out = [];
  const seg = (side, i, x, z, rot) => {
    const kind = kindAt(side, i);
    if (kind) out.push({ kind, x, z, rot, level, variant, owner: ownerOf(side) });
  };
  let i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) seg('n', i++, x, b.z0, 0);
  i = 0;
  for (let x = b.x0 + 1; x < b.x1; x += 2) seg('s', i++, x, b.z1, 0);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) seg('w', i++, b.x0, z, 1);
  i = 0;
  for (let z = b.z0 + 1; z < b.z1; z += 2) seg('e', i++, b.x1, z, 1);
  return out;
}
const box = (cx, cz, sx = 4, sz = 4) => ({ x0: cx - Math.floor(sx / 2), z0: cz - Math.floor(sz / 2), x1: cx - Math.floor(sx / 2) + sx, z1: cz - Math.floor(sz / 2) + sz });
const doorSouth = (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall');

/** Houses that must take a roof in one action. `by`: who roofs it and how; `levels`: storeys of walls. */
export const ROOF_HOUSES = [
  { id: 'one-storey', label: 'one storey 4x4, a door in the south', box: box(-19, 0), build: (b) => rectWalls(b, { kindAt: doorSouth }), by: 'A' },
  {
    id: 'two-storeys',
    label: 'two storeys 4x4 (aimed at the ground floor)',
    box: box(-8, -12),
    build: (b) => [...rectWalls(b, { kindAt: doorSouth }), ...rectWalls(b, { level: 1, kindAt: () => 'wall_window' })],
    levels: 2,
    by: 'A',
  },
  { id: 'doors-windows', label: 'a doorway and a window in every side (roofed from inside)', box: box(-4, -18), build: (b) => rectWalls(b, { kindAt: (_s, i) => (i === 0 ? 'doorway' : 'wall_window') }), by: 'A', inside: true },
  { id: 'odd-gap', label: '3x4: the odd side ends in a 1 m gap (storey lock on the wrong storey)', box: { x0: 8, z0: 13, x1: 11, z1: 17 }, build: (b) => rectWalls(b, { kindAt: doorSouth }), by: 'A', lock: true },
  { id: 'missing', label: 'one wall segment left out', box: box(17, -2), build: (b) => rectWalls(b, { kindAt: (s, i) => (s === 'n' && i === 1 ? null : doorSouth(s, i)) }), by: 'B' },
  { id: 'porch', label: 'a porch: the south side open (roofed from inside)', box: box(-15, 17), build: (b) => rectWalls(b, { kindAt: (s) => (s === 's' ? null : 'wall') }), by: 'B', inside: true },
  { id: 'small', label: '2x2 hut', box: { x0: 23, z0: -2, x1: 25, z1: 0 }, build: (b) => rectWalls(b), by: 'B' },
  {
    id: 'mixed-owner',
    label: '6x4, its west wall is a neighbour’s; a garden wall at a corner',
    box: { x0: -25, z0: 15, x1: -19, z1: 19 },
    build: (b) => [...rectWalls(b, { kindAt: doorSouth, ownerOf: (s) => (s === 'w' ? 'B' : 'A') }), { kind: 'wall', x: b.x1, z: b.z1 + 1, rot: 1, level: 0, variant: 'cream', owner: 'A' }],
    by: 'A',
  },
  { id: 'two-by-three', label: '2x3 (the 3 m sides have a gap)', box: { x0: -6, z0: 24, x1: -4, z1: 27 }, build: (b) => rectWalls(b), by: 'A' },
  { id: 'by-house-1', label: '2x2 right next to House 1 (eaves shortened)', box: { x0: -23, z0: 5, x1: -21, z1: 7 }, build: (b) => rectWalls(b), by: 'A' },
];

/** Deliberately invalid: each must show its specific reason and place nothing. */
export const ROOF_REFUSALS = [
  { id: 'two-sides', box: box(-18, 24), build: (b) => rectWalls(b, { kindAt: (s) => (s === 'n' || s === 'w' ? 'wall' : null) }), message: 'Needs your walls on at least three sides — the south and east sides are open' },
  { id: 'half-walls', box: box(-12, 29), build: (b) => rectWalls(b, { kindAt: (s) => (s === 's' || s === 'e' ? 'half_wall' : 'wall') }), message: 'Half walls are too low to hold a roof — use walls, windows or doorways' },
  { id: 'theirs', box: box(16, 24), build: (b) => rectWalls(b, { ownerOf: (s) => (s === 'n' || s === 'w' ? 'B' : 'A') }), message: 'Some of these walls are someone else’s — a roof rests on your own walls' },
  { id: 'too-far', box: box(16, -26), build: (b) => rectWalls(b, { kindAt: doorSouth }), message: 'Too far away — walk closer', far: true },
];
