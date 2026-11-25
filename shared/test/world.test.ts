import { describe, expect, it } from 'vitest';
import {
  BUILDINGS,
  COLLIDERS,
  CONFIG,
  DECKS,
  INTERACTABLES,
  LOCATIONS,
  PATHS,
  SPAWN_POINTS,
  TREES,
  getInteractable,
  groundHeight,
  isOnIsland,
  isSeatInteractable,
  isWalkable,
  islandOutline,
  locationAt,
  terrainHeight,
  WATER_LEVEL,
} from '../src/index.js';

describe('island', () => {
  it('is roughly 120–160 units across', () => {
    const o = islandOutline(512);
    const w = Math.max(...o.map((p) => p.x)) - Math.min(...o.map((p) => p.x));
    const h = Math.max(...o.map((p) => p.z)) - Math.min(...o.map((p) => p.z));
    expect(Math.max(w, h)).toBeGreaterThanOrEqual(120);
    expect(Math.max(w, h)).toBeLessThanOrEqual(160);
  });

  it('terrain is deterministic, finite, has elevation changes and sea around it', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let x = -60; x <= 60; x += 3) {
      for (let z = -70; z <= 55; z += 3) {
        const h = terrainHeight(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(terrainHeight(x, z)).toBe(h);
        if (isOnIsland(x, z, 3)) {
          min = Math.min(min, h);
          max = Math.max(max, h);
        }
      }
    }
    expect(max - min).toBeGreaterThan(2.5);
    expect(terrainHeight(0, 75)).toBeLessThan(WATER_LEVEL);
    expect(terrainHeight(-80, 0)).toBeLessThan(WATER_LEVEL);
  });

  it('terrain is continuous (no cliffs > 1.2 units per 0.5 step)', () => {
    for (let x = -60; x <= 60; x += 0.5) {
      for (let z = -70; z <= 55; z += 2) {
        expect(Math.abs(terrainHeight(x + 0.5, z) - terrainHeight(x, z))).toBeLessThan(1.2);
      }
    }
  });
});

describe('locations', () => {
  it('has exactly the 9 locations', () => {
    expect(LOCATIONS.map((l) => l.id).sort()).toEqual(
      ['cafe', 'general_store', 'residential', 'the_unknown', 'town_hall', 'town_square', 'waterfront', 'woods', 'workshop'].sort(),
    );
  });
  it('every location centre is on the island and locationAt finds it', () => {
    for (const l of LOCATIONS) {
      expect(isOnIsland(l.center.x, l.center.z, 2), l.id).toBe(true);
      expect(locationAt(l.center)?.id).toBe(l.id);
    }
  });
  it('The Unknown is at the island edge', () => {
    const u = LOCATIONS.find((l) => l.id === 'the_unknown')!;
    expect(isOnIsland(u.center.x, u.center.z - u.radius - 6)).toBe(false);
  });
});

describe('interactables', () => {
  it('have unique ids and valid locations', () => {
    const ids = new Set(INTERACTABLES.map((i) => i.id));
    expect(ids.size).toBe(INTERACTABLES.length);
    const locs = new Set(LOCATIONS.map((l) => l.id));
    for (const i of INTERACTABLES) expect(locs.has(i.locationId), i.id).toBe(true);
  });

  it('cover every feature in the product brief', () => {
    const count = (k: string) => INTERACTABLES.filter((i) => i.kind === k).length;
    expect(count('fountain')).toBe(1);
    expect(count('bench')).toBeGreaterThanOrEqual(5);
    expect(count('chair')).toBeGreaterThanOrEqual(4);
    expect(count('door')).toBe(BUILDINGS.length);
    expect(count('sign')).toBeGreaterThanOrEqual(5);
    expect(count('bell')).toBe(1);
    expect(count('streetlight') + count('lantern')).toBeGreaterThanOrEqual(10);
    expect(count('mailbox')).toBeGreaterThanOrEqual(5);
    expect(count('pickup')).toBeGreaterThanOrEqual(4);
    expect(INTERACTABLES.filter((i) => i.kind === 'hidden' && i.locationId === 'woods').length).toBeGreaterThanOrEqual(4);
    expect(count('portal')).toBe(1);
    expect(count('rune')).toBeGreaterThanOrEqual(CONFIG.collective.portalRunesRequired);
    expect(DECKS.some((d) => d.kind === 'dock')).toBe(true);
    for (const b of BUILDINGS) expect(getInteractable(b.doorId)?.kind).toBe('door');
    const signs = INTERACTABLES.filter((i) => i.kind === 'sign');
    for (const s of signs) if (s.kind === 'sign') expect(s.text.length).toBeGreaterThan(10);
  });

  it('every interactable can be reached from walkable ground', () => {
    for (const i of INTERACTABLES) {
      const radius = i.radius ?? CONFIG.interaction.radius;
      let ok = false;
      for (let r = 0; r <= radius && !ok; r += 0.2) {
        for (let a = 0; a < 32 && !ok; a++) {
          const p = { x: i.position.x + Math.cos((a / 32) * Math.PI * 2) * r, z: i.position.z + Math.sin((a / 32) * Math.PI * 2) * r };
          ok = isWalkable(p);
        }
      }
      expect(ok, i.id).toBe(true);
    }
  });

  it('every seat exit is walkable', () => {
    for (const i of INTERACTABLES) if (isSeatInteractable(i)) for (const s of i.seats) expect(isWalkable(s.exit), i.id).toBe(true);
  });
});

describe('spawn, paths, colliders', () => {
  it('spawn points are walkable and in Town Square', () => {
    expect(SPAWN_POINTS.length).toBeGreaterThanOrEqual(6);
    for (const s of SPAWN_POINTS) {
      expect(isWalkable(s.position), s.id).toBe(true);
      expect(locationAt(s.position)?.id).toBe('town_square');
    }
  });
  it('path points are on land (or decks)', () => {
    for (const p of PATHS) for (const pt of p.points) expect(groundHeight(pt.x, pt.z), p.id).toBeGreaterThan(WATER_LEVEL);
  });
  it('colliders include buildings and trees; woods are wooded', () => {
    expect(COLLIDERS.filter((c) => c.source === 'building').length).toBe(BUILDINGS.length);
    const woods = LOCATIONS.find((l) => l.id === 'woods')!;
    expect(TREES.filter((t) => Math.hypot(t.position.x - woods.center.x, t.position.z - woods.center.z) < woods.radius).length).toBeGreaterThan(50);
  });
});
