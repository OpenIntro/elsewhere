/**
 * Building-activity rule data: stations and keepers placed on real, reachable
 * spots inside their buildings; keeper routes are straight, collision-free
 * walks; opening hours; daily rotations deterministic; keeper lines only
 * ever quote real numbers they were given.
 */
import { describe, expect, it } from 'vitest';
import {
  CURIOSITIES,
  DRINKS,
  INTERACTABLES,
  ITEMS,
  KEEPERS,
  OPENING_HOURS,
  POLLS,
  PROJECTS,
  STATIONS,
  buildingLocal,
  curiositiesForDay,
  getBuilding,
  getInteractable,
  interiorAnchor,
  interiorAt,
  isOpenAt,
  isWalkable,
  keeperLine,
  pollForDay,
  specialForDay,
  type KeeperContext,
} from '../src/index.js';

describe('activities data', () => {
  it('every station and keeper is an interactable inside its own building, used from a walkable spot', () => {
    for (const st of STATIONS) {
      const it = getInteractable(st.id);
      expect(it?.kind, st.id).toBe('station');
      expect(interiorAt(it!.position)?.id, st.id).toBe(st.interiorId);
      expect(isWalkable(interiorAnchor(st.interiorId, st.anchor).position), st.id).toBe(true);
    }
    for (const k of KEEPERS) {
      const it = getInteractable(k.interactableId);
      expect(it?.kind, k.id).toBe('keeper');
      expect(interiorAt(it!.position)?.id, k.id).toBe(k.interiorId);
      expect(isWalkable(interiorAnchor(k.interiorId, k.talkAnchor).position), k.id).toBe(true);
    }
    // Stations / keepers keep no synced object state (their state is in state.activities).
    expect(INTERACTABLES.filter((i) => (i.kind === 'station' || i.kind === 'keeper') && i.synced)).toEqual([]);
  });

  it('one keeper per public building; routes are straight, collision-free walks inside the building', () => {
    expect(new Set(KEEPERS.map((k) => k.interiorId))).toEqual(new Set(['cafe', 'general_store', 'town_hall', 'workshop']));
    expect(Object.keys(OPENING_HOURS).sort()).toEqual(['cafe', 'general_store', 'town_hall', 'workshop']);
    for (const k of KEEPERS) {
      const b = getBuilding(k.interiorId);
      const pts = k.route.map((s) => (s.anchor ? interiorAnchor(k.interiorId, s.anchor).position : buildingLocal(b, s.at![0], s.at![1])));
      expect(pts.length, k.id).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const q = pts[(i + 1) % pts.length]!;
        const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.05);
        for (let j = 0; j <= n; j++) {
          const at = { x: p.x + ((q.x - p.x) * j) / n, z: p.z + ((q.z - p.z) * j) / n };
          expect(isWalkable(at, 0.3), `${k.id} stop ${i}→${(i + 1) % pts.length} at ${j}/${n}`).toBe(true);
          expect(interiorAt(at)?.id, k.id).toBe(k.interiorId);
        }
      }
    }
  });

  it('opening hours follow the world clock; homes and the boathouse have no hours', () => {
    expect(isOpenAt('cafe', 7)).toBe(true);
    expect(isOpenAt('cafe', 23)).toBe(false);
    expect(isOpenAt('general_store', 7.5)).toBe(false);
    expect(isOpenAt('general_store', 12)).toBe(true);
    expect(isOpenAt('town_hall', 26)).toBe(false); // 02:00
    expect(isOpenAt('house_1', 3)).toBe(true);
  });

  it('daily rotations are deterministic and valid', () => {
    for (let d = 0; d < 40; d++) {
      const c = curiositiesForDay(d);
      expect(c).toEqual(curiositiesForDay(d));
      expect(new Set(c).size).toBe(3);
      for (const id of c) expect(CURIOSITIES).toContain(id);
      expect(specialForDay(d).name.length).toBeGreaterThan(0);
      const p = pollForDay(d);
      expect(p.startDay).toBeLessThanOrEqual(d);
      expect(p.endDay).toBeGreaterThan(d);
      expect(p.poll.options.length).toBeGreaterThanOrEqual(2);
    }
    expect(pollForDay(4, 2).key).toBe(pollForDay(5, 2).key);
    expect(pollForDay(5, 2).key).not.toBe(pollForDay(6, 2).key);
    for (const id of [...CURIOSITIES, ...DRINKS.map((d) => d.item)]) expect(ITEMS[id]).toBeDefined();
    expect(new Set(POLLS.map((p) => p.id)).size).toBe(POLLS.length);
    expect(new Set(PROJECTS.map((p) => p.id)).size).toBe(PROJECTS.length);
  });

  it('keeper lines quote only the real state they are given (no invented activity)', () => {
    const base: KeeperContext = { open: true, hours: 9, day: 3, fountainStage: 0, pollVotes: 0, pollQuestion: 'Q?', project: null, projectsDone: 0, special: 'Fig cake', inside: 1 };
    const lines = new Set<string>();
    for (const k of KEEPERS) for (let h = 0; h < 24; h++) for (const votes of [0, 1, 7]) lines.add(keeperLine(k, { ...base, hours: h, pollVotes: votes, project: { name: 'Lanterns', stage: 2, stages: 3 }, projectsDone: votes }));
    for (const l of lines) {
      // Any number in a line is one of the numbers in the context (stage, votes, hours…), never a made-up crowd.
      for (const n of l.match(/\d+/g) ?? []) expect(['0', '1', '2', '3', '7', '06', '08', '07', '30', '00'], l).toContain(n);
      expect(l).not.toMatch(/(people|players|everyone|folks|crowd) (are|were|have)/i);
    }
    expect(keeperLine(KEEPERS[0]!, { ...base, open: false })).toMatch(/Closed/);
    expect(keeperLine(KEEPERS.find((k) => k.id === 'keeper_clerk')!, { ...base, hours: 9 })).toBeTruthy();
    const clerkLines = Array.from({ length: 24 }, (_, h) => keeperLine(KEEPERS.find((k) => k.id === 'keeper_clerk')!, { ...base, hours: h, pollVotes: 0 }));
    expect(clerkLines.some((l) => l.includes('No votes yet'))).toBe(true);
  });
});
