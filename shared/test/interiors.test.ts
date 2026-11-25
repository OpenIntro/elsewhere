/**
 * Walk-in interiors: reachability through real door openings, walls that
 * block (client prediction and server resolution agree), floors/ramps, the
 * typed interior description and the protected zones used by player building.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  COLLIDERS,
  CONFIG,
  FURNITURE,
  INTERACTABLES,
  INTERIORS,
  INTERIOR_SEATS,
  PROTECTED_ZONES,
  SPAWN_POINTS,
  WORLD_BOUNDS,
  collidesAt,
  getInteractable,
  groundHeight,
  interiorAnchor,
  interiorAt,
  isSeatInteractable,
  isWalkable,
  locationAt,
  protectedZoneAt,
  resolveMovement,
  rotateOffset,
  sameSpace,
  zoneContains,
  zoneLocal,
  type Interior,
  type Vec2,
} from '../src/index.js';

const R = CONFIG.movement.playerRadius;
const STEP = 0.25;

// --- Flood fill of the walkable grid from the Town Square spawn ring ------------------
// Only the region around the town is needed (every building is within it).
const B = { minX: -60, maxX: 50, minZ: -45, maxZ: 60 };
const nx = Math.ceil((B.maxX - B.minX) / STEP);
const nz = Math.ceil((B.maxZ - B.minZ) / STEP);
const idx = (i: number, j: number) => j * nx + i;
const toWorld = (i: number, j: number): Vec2 => ({ x: B.minX + i * STEP, z: B.minZ + j * STEP });

function flood(): Uint8Array {
  const walk = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) walk[idx(i, j)] = isWalkable(toWorld(i, j)) ? 1 : 0;
  const seen = new Uint8Array(nx * nz);
  const s = SPAWN_POINTS[0]!.position;
  const start = idx(Math.round((s.x - B.minX) / STEP), Math.round((s.z - B.minZ) / STEP));
  expect(walk[start]).toBe(1);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx;
    const j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = idx(a, b);
      if (!seen[n] && walk[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return seen;
}

const local = (it: Interior, lx: number, lz: number): Vec2 => {
  const o = rotateOffset({ x: lx, z: lz }, it.footprint.yaw);
  return { x: it.footprint.center.x + o.x, z: it.footprint.center.z + o.z };
};

describe('interiors: reachability through doors', () => {
  const reached = flood();
  const reachableNear = (p: Vec2, r: number) => {
    for (let j = Math.floor((p.z - r - B.minZ) / STEP); j <= Math.ceil((p.z + r - B.minZ) / STEP); j++)
      for (let i = Math.floor((p.x - r - B.minX) / STEP); i <= Math.ceil((p.x + r - B.minX) / STEP); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
        const w = toWorld(i, j);
        if (Math.hypot(w.x - p.x, w.z - p.z) <= r && reached[idx(i, j)]) return true;
      }
    return false;
  };

  it('every building in the brief is enterable: café, store, town hall, workshop, ≥2 houses, the boathouse', () => {
    const ids = new Set(INTERIORS.map((i) => i.id));
    for (const id of ['cafe', 'general_store', 'town_hall', 'workshop', 'boathouse']) expect(ids.has(id), id).toBe(true);
    expect(INTERIORS.filter((i) => i.purpose === 'home').length).toBeGreaterThanOrEqual(2);
    // The closed houses say so.
    for (const b of BUILDINGS.filter((x) => !x.enterable)) {
      expect(b.futureHome, b.id).toBe(true);
      expect(getInteractable(b.doorId)?.name).toMatch(/future home/);
    }
    expect(WORLD_BOUNDS.minX).toBeLessThan(B.minX);
  });

  it('every interior anchor and every indoor seat (and its stand-up spot) is reachable from the Town Square spawn', () => {
    for (const it of INTERIORS) {
      for (const a of Object.values(it.anchors)) {
        expect(isWalkable(a.position), `${it.id}.${a.name} walkable`).toBe(true);
        expect(reachableNear(a.position, 0.2), `${it.id}.${a.name} reachable`).toBe(true);
        expect(interiorAt(a.position)?.id, `${it.id}.${a.name} indoors`).toBe(it.id);
      }
      for (const d of it.doors) {
        expect(reachableNear(d.inside, 0.2), `${d.id} inside`).toBe(true);
        expect(reachableNear(d.outside, 0.2), `${d.id} outside`).toBe(true);
      }
    }
    expect(INTERIOR_SEATS.length).toBeGreaterThanOrEqual(20);
    for (const s of INTERIOR_SEATS) {
      const i = getInteractable(s.id);
      expect(i && isSeatInteractable(i), s.id).toBe(true);
      if (!i || !isSeatInteractable(i)) continue;
      for (const seat of i.seats) {
        expect(isWalkable(seat.exit), `${s.id} exit walkable`).toBe(true);
        expect(reachableNear(seat.exit, 0.2), `${s.id} exit reachable`).toBe(true);
        expect(interiorAt(seat.exit)?.id, `${s.id} exit indoors`).toBe(s.interiorId);
      }
      // reachable within interaction range from inside the same room
      expect(reachableNear(i.position, (i.radius ?? CONFIG.interaction.radius) - 0.3), `${s.id} in reach`).toBe(true);
    }
  });

  it('every interactable that lives indoors is reachable from inside the same building', () => {
    for (const i of INTERACTABLES) {
      const inside = interiorAt(i.position);
      if (!inside || i.kind === 'door') continue;
      const r = (i.radius ?? CONFIG.interaction.radius) - 0.3;
      let ok = false;
      for (let a = 0; a < 48 && !ok; a++)
        for (let d = 0.2; d <= r && !ok; d += 0.2) {
          const p = { x: i.position.x + Math.cos((a / 48) * Math.PI * 2) * d, z: i.position.z + Math.sin((a / 48) * Math.PI * 2) * d };
          ok = interiorAt(p)?.id === inside.id && reachableNear(p, 0.15);
        }
      expect(ok, i.id).toBe(true);
    }
    // The archive, apple, workbench and wrench moved indoors; bell, mailbox, signs, fountain stayed out.
    for (const id of ['archive_town_hall', 'pickup_apple', 'inspect_workbench', 'pickup_wrench']) expect(interiorAt(getInteractable(id)!.position), id).not.toBeNull();
    for (const id of ['bell_town_hall', 'mailbox_post_office', 'sign_town_hall', 'sign_cafe_menu', 'fountain', 'sign_notice_board']) expect(interiorAt(getInteractable(id)!.position), id).toBeNull();
  });
});

describe('interiors: walls block, doors do not', () => {
  it('a straight walk into each wall is stopped (from outside and from inside)', () => {
    for (const it of INTERIORS) {
      const { halfWidth: hw, halfDepth: hd } = it.footprint;
      // Outside → through the back wall towards the centre.
      const back = resolveMovement(local(it, 0.3, -hd - 2.5), local(it, 0.3, 0), R);
      expect(zoneLocal(it.footprint, back).z, `${it.id} back wall from outside`).toBeLessThan(-hd);
      // Inside → out through each side wall and the back wall.
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1]] as const) {
        const from = local(it, 0, -0.2);
        if (!isWalkable(from)) continue;
        const end = resolveMovement(from, local(it, dx * (hw + 3), -0.2 + dz * (hd + 3)), R);
        const l = zoneLocal(it.footprint, end);
        expect(Math.abs(l.x) < hw && Math.abs(l.z) < hd, `${it.id} stays inside (${dx},${dz})`).toBe(true);
      }
      // A front wall beside the door blocks too.
      const fl = resolveMovement(local(it, -(it.doors[0]!.width / 2 + 1.0), hd + 2), local(it, -(it.doors[0]!.width / 2 + 1.0), 0), R);
      expect(zoneLocal(it.footprint, fl).z, `${it.id} front wall`).toBeGreaterThan(hd);
    }
  });

  it('the door is a real opening: walking straight in and back out works', () => {
    for (const it of INTERIORS) {
      const d = it.doors[0]!;
      const inEnd = resolveMovement(d.outside, d.inside, R);
      expect(Math.hypot(inEnd.x - d.inside.x, inEnd.z - d.inside.z), `${it.id} walk in`).toBeLessThan(0.05);
      const outEnd = resolveMovement(d.inside, d.outside, R);
      expect(Math.hypot(outEnd.x - d.outside.x, outEnd.z - d.outside.z), `${it.id} walk out`).toBeLessThan(0.05);
    }
  });

  it('server movement resolution agrees with client prediction (and corrects a move through a wall)', () => {
    // Client: integrates small per-frame steps with resolveMovement and sends the endpoint.
    // Server: resolves the claimed endpoint from its last authoritative position (WorldRoom.handleMove).
    const cafe = INTERIORS.find((i) => i.id === 'cafe')!;
    const d = cafe.doors[0]!;
    const target = cafe.anchors.counter!.position;
    let client = { ...d.outside };
    let server = { ...d.outside };
    const dirTo = (p: Vec2, q: Vec2) => {
      const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    };
    const speed = CONFIG.movement.walkSpeed;
    for (let tick = 0; tick < 200; tick++) {
      // 4 frames of prediction per network send (60 fps vs 15 Hz)
      for (let f = 0; f < 4; f++) {
        const goal = Math.hypot(client.x - d.inside.x, client.z - d.inside.z) > 0.3 && zoneLocal(cafe.footprint, client).z > zoneLocal(cafe.footprint, d.inside).z ? d.inside : target;
        const dir = dirTo(client, goal);
        client = resolveMovement(client, { x: client.x + (dir.x * speed) / 60, z: client.z + (dir.z * speed) / 60 }, R);
      }
      server = resolveMovement(server, client, R);
      expect(Math.hypot(server.x - client.x, server.z - client.z)).toBeLessThan(CONFIG.movement.correctionThreshold);
    }
    expect(interiorAt(server)?.id).toBe('cafe');
    expect(Math.hypot(server.x - target.x, server.z - target.z)).toBeLessThan(0.3);

    // A cheating client claims a spot on the far side of the back wall: the server stops it at the wall.
    const inside = cafe.anchors.barista!.position;
    const behind = local(cafe, zoneLocal(cafe.footprint, inside).x, -cafe.footprint.halfDepth - 1.5);
    const resolved = resolveMovement(inside, behind, R);
    expect(interiorAt(resolved)?.id).toBe('cafe');
    expect(Math.hypot(resolved.x - behind.x, resolved.z - behind.z)).toBeGreaterThan(CONFIG.movement.correctionThreshold);
  });

  it('indoor things are only usable from the same side of the wall', () => {
    const chair = getInteractable('chair_cafe_in_2b')!;
    const cafe = INTERIORS.find((i) => i.id === 'cafe')!;
    // A spot just outside the café's right wall is within range of the chair but outdoors.
    const l = zoneLocal(cafe.footprint, chair.position);
    const outside = local(cafe, cafe.footprint.halfWidth + 0.45, l.z);
    expect(Math.hypot(outside.x - chair.position.x, outside.z - chair.position.z)).toBeLessThan(chair.radius ?? 2.4);
    expect(sameSpace(outside, chair.position)).toBe(false);
    expect(sameSpace(cafe.anchors.table_2!.position, chair.position)).toBe(true);
    // Doors work from both sides.
    const door = getInteractable('door_cafe')!;
    expect(sameSpace(cafe.anchors.entrance!.position, door.position, true)).toBe(true);
  });
});

describe('interiors: floors, description, protected zones', () => {
  it('floors are flat at floorY with continuous doorstep ramps; platforms are low and smooth', () => {
    for (const it of INTERIORS) {
      expect(it.floorY).toBeGreaterThan(it.baseY);
      for (const a of Object.values(it.anchors)) expect(a.y).toBeCloseTo(groundHeight(a.position.x, a.position.z), 5);
      expect(groundHeight(it.inner.center.x, it.inner.center.z) - it.floorY).toBeLessThan(0.25);
      const d = it.doors[0]!;
      let prev = groundHeight(d.inside.x, d.inside.z);
      for (let t = 0.01; t <= 1.0001; t += 0.01) {
        const p = { x: d.inside.x + (d.outside.x - d.inside.x) * t, z: d.inside.z + (d.outside.z - d.inside.z) * t };
        const h = groundHeight(p.x, p.z);
        expect(Math.abs(h - prev), `${it.id} ramp step`).toBeLessThan(0.06);
        prev = h;
      }
      expect(groundHeight(d.outside.x, d.outside.z)).toBeCloseTo(it.baseY, 1);
      for (const p of it.platforms) expect(p.height).toBeLessThan(0.25);
    }
  });

  it('every interior has a door, rooms and anchors with facing; furniture sits inside the walls', () => {
    for (const it of INTERIORS) {
      expect(it.doors.length, it.id).toBeGreaterThanOrEqual(1);
      expect(it.rooms.length, it.id).toBeGreaterThanOrEqual(1);
      expect(Object.keys(it.anchors)).toContain('entrance');
      expect(Object.keys(it.anchors).length, it.id).toBeGreaterThanOrEqual(4);
      for (const a of Object.values(it.anchors)) expect(Number.isFinite(a.yaw)).toBe(true);
      expect(locationAt(it.inner.center)?.id).toBe(it.locationId);
      for (const f of it.furniture) expect(zoneContains(it.inner, f.position, 0.05), f.id).toBe(true);
      for (const s of it.seatIds) expect(getInteractable(s), s).toBeTruthy();
      expect(it.lights.length).toBeGreaterThanOrEqual(1);
    }
    expect(FURNITURE.filter((f) => f.shape).length).toBeGreaterThan(30);
    expect(interiorAnchor('cafe', 'stage').position).toBeTruthy();
    expect(() => interiorAnchor('cafe', 'nope')).toThrow();
    // named anchors the activities worker relies on
    for (const [i, a] of [['cafe', 'counter'], ['cafe', 'stage'], ['cafe', 'table_1'], ['general_store', 'counter'], ['town_hall', 'lectern'], ['town_hall', 'notice_board'], ['town_hall', 'archive'], ['workshop', 'workbench_1'], ['workshop', 'kiln'], ['house_1', 'table']] as const)
      expect(interiorAnchor(i, a).name).toBe(a);
  });

  it('protected zones: every building footprint plus a clear apron in front of each door', () => {
    for (const b of BUILDINGS) {
      expect(PROTECTED_ZONES.some((z) => z.kind === 'building' && z.buildingId === b.id), b.id).toBe(true);
      const apron = PROTECTED_ZONES.find((z) => z.kind === 'door_apron' && z.buildingId === b.id)!;
      expect(apron, b.id).toBeTruthy();
      expect(protectedZoneAt(b.position)?.buildingId).toBe(b.id);
      expect(protectedZoneAt(apron.center)?.kind).toBe('door_apron');
    }
    // The first metre and a half in front of every walk-in door is free of static colliders (wide enough to pass).
    for (const it of INTERIORS) {
      const d = it.doors[0]!;
      for (let s = 0.5; s <= 1.5; s += 0.25) {
        const p = local(it, 0, it.footprint.halfDepth + s);
        expect(collidesAt(p, R), `${it.id} door apron at ${s}`).toBeNull();
      }
      void d;
    }
    expect(COLLIDERS.some((c) => c.source === 'wall')).toBe(true);
  });
});
