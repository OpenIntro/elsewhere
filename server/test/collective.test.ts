import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ObjectEvent } from '@elsewhere/shared';
import { createPersistence } from '../src/persistence/index.js';
import { DAY_MS, makeWorld } from './helpers.js';

describe('collective reality', { timeout: 60_000 }, () => {
  it('fountain: one player spamming never advances it; distinct players do; per world-day dedupe; persists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-coll-'));
    try {
      const persistence = createPersistence({ dataDir: dir });
      const w = await makeWorld({ persistence }); // stages: 3 contributions & 2 distinct, then 6 & 4
      const a = await w.join('Alice', 0, 10);
      for (let i = 0; i < 25; i++) await w.interact(a, 'fountain');
      expect(w.state.objects.get('fountain')!.value).toBe(0);
      expect(w.collective.facts().fountainContributors).toBe(1);
      // Same player on a later world-day counts once more, but distinct is still 1.
      w.clock.advance(DAY_MS);
      await w.interact(a, 'fountain');
      w.clock.advance(DAY_MS);
      await w.interact(a, 'fountain');
      expect(w.state.objects.get('fountain')!.value).toBe(0); // 3 contributions, 1 distinct
      const b = await w.join('Bob', 0, 10);
      await w.interact(b, 'fountain');
      await w.interact(b, 'fountain');
      expect(w.state.objects.get('fountain')!.value).toBe(1);
      expect(w.collective.facts().fountainStage).toBe(1);
      const [ev] = await w.memory.list({ kind: 'fountain_transformed' });
      expect(ev!.actors.map((x) => x.name).sort()).toEqual(['Alice', 'Bob']);
      expect(ev!.data).toMatchObject({ stage: 1, distinct: 2 });
      expect(w.received(a, 'world_event').length).toBe(1);
      expect((w.received(a, 'object_event') as ObjectEvent[]).some((e) => e.kind === 'fountain_stage')).toBe(true);
      // Only counted contributions leave a trail (no spam in memory).
      expect((await w.memory.list({ kind: 'fountain_touched', limit: 100 })).length).toBe(4);
      await w.close();

      const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }) });
      expect(w2.collective.facts().fountainStage).toBe(1);
      expect(w2.state.objects.get('fountain')!.value).toBe(1);
      await w2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('portal: needs N distinct players lighting different runes within the window; persists awake + attribution', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-portal-'));
    try {
      const w = await makeWorld({ persistence: createPersistence({ dataDir: dir }) }); // portalRunesRequired: 2
      const a = await w.join('Alice', -10, -61);
      const b = await w.join('Bob', -10, -61);
      // One player touching two runes: their light moves, the portal stays dormant.
      await w.interact(a, 'rune_1');
      await w.interact(a, 'rune_2');
      expect(w.state.objects.get('rune_1')!.active).toBe(false);
      expect(w.state.objects.get('rune_2')!.active).toBe(true);
      expect(w.state.objects.get('portal_arch')!.active).toBe(false);
      // Someone else's lit rune is occupied.
      expect(await w.interact(b, 'rune_2')).toMatchObject({ ok: false, error: 'occupied' });
      // Too slow: rune fades before the second player lights another.
      w.clock.advance(21_000);
      expect(w.state.objects.get('rune_2')!.active).toBe(false);
      await w.interact(b, 'rune_3');
      expect(w.state.objects.get('portal_arch')!.active).toBe(false);
      // Together within the window: it wakes.
      await w.interact(a, 'rune_1');
      expect(w.state.objects.get('portal_arch')!.active).toBe(true);
      expect(w.state.objects.get('portal_arch')!.value).toBe(1);
      const [ev] = await w.memory.list({ kind: 'portal_awakened' });
      expect(ev!.actors.map((x) => x.name).sort()).toEqual(['Alice', 'Bob']);
      expect(ev!.data).toMatchObject({ first: true, awakenings: 1 });
      // Touching the awake arch carries you elsewhere.
      const res = await w.interact(a, 'portal_arch');
      expect(res.ok).toBe(true);
      expect(w.state.players.get(a)!.z).toBeGreaterThan(50);
      await w.close();

      // Restart while awake → still awake.
      const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), clock: w.clock });
      expect(w2.state.objects.get('portal_arch')!.active).toBe(true);
      w2.clock.advance(61_000);
      await new Promise((r) => setTimeout(r, 50));
      expect(w2.state.objects.get('portal_arch')!.active).toBe(false);
      expect((await w2.memory.list({ kind: 'portal_slept' })).length).toBe(1);
      await w2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bell chorus: several distinct ringers close together, not one player alone', async () => {
    const w = await makeWorld(); // bellChorusPlayers: 3
    const ids = [await w.join('A', 0, 0), await w.join('B', 0, 0), await w.join('C', 0, 0)];
    const chorus = () => (w.received(ids[0]!, 'object_event') as ObjectEvent[]).filter((e) => e.kind === 'bell_chorus');
    for (let i = 0; i < 4; i++) {
      await w.interact(ids[0]!, 'bell_town_hall');
      w.clock.advance(4_100);
    }
    expect(chorus().length).toBe(0); // one player alone, many rings
    w.clock.advance(9_000);
    await w.interact(ids[1]!, 'bell_town_hall');
    w.clock.advance(1000);
    await w.interact(ids[2]!, 'bell_town_hall');
    expect(chorus().length).toBe(0); // A's last ring is outside the 8s window: only 2 voices
    w.clock.advance(1000);
    await w.interact(ids[0]!, 'bell_town_hall');
    expect(chorus()[0]?.data).toMatchObject({ voices: 3 });
    expect((await w.memory.list({ kind: 'bell_chorus' }))[0]!.actors.length).toBe(3);
    await w.close();
  });

  it('resident milestone and popular-place rule are data-driven and deduped', async () => {
    const w = await makeWorld();
    const a = await w.join('First', 0, 10);
    await w.collective.signal(w.ctx, { type: 'first_visit', sessionId: a, profileId: w.ctx.getProfile(a)!.id });
    await w.collective.signal(w.ctx, { type: 'first_visit', sessionId: a, profileId: w.ctx.getProfile(a)!.id });
    const ms = await w.memory.list({ kind: 'milestone' });
    expect(ms.length).toBe(1);
    expect(ms[0]).toMatchObject({ data: { milestone: 'residents', contributions: 1 }, actors: [{ name: 'First' }] });
    const r = await w.collective.signal(w.ctx, { type: 'location_entered', sessionId: a, profileId: w.ctx.getProfile(a)!.id, locationId: 'cafe' });
    const r2 = await w.collective.signal(w.ctx, { type: 'location_entered', sessionId: a, profileId: w.ctx.getProfile(a)!.id, locationId: 'cafe' });
    expect(r.counted).toBe(true);
    expect(r2.counted).toBeFalsy();
    expect(w.collective.describe().counters['rule:popular_place:cafe:contributions']).toBe(1);
    await w.close();
  });

  it('transient state is room-scoped: runes and bell rings in another room instance never combine; persistent facts reach every room', async () => {
    const w = await makeWorld(); // portalRunesRequired: 2, bellChorusPlayers: 3
    const r2 = await w.openRoom('second');
    expect(w.collective.roomCount()).toBe(2);
    const a = await w.join('Alice', -10, -61);
    const b = await r2.join('Bob', -10, -61);
    await w.interact(a, 'rune_1');
    await r2.interact(b, 'rune_2');
    // Each room sees only its own lit rune; together they would have woken the portal if state were shared.
    expect(w.state.objects.get('rune_1')!.active).toBe(true);
    expect(w.state.objects.get('rune_2')!.active).toBe(false);
    expect(r2.state.objects.get('rune_2')!.active).toBe(true);
    expect(r2.state.objects.get('rune_1')!.active).toBe(false);
    expect(w.state.objects.get('portal_arch')!.active).toBe(false);
    expect(r2.state.objects.get('portal_arch')!.active).toBe(false);
    // rune_1 in room 2 is free (it is lit only in room 1).
    const c = await r2.join('Cara', -10, -61);
    expect(await r2.interact(c, 'rune_1')).toMatchObject({ ok: true });
    // Two distinct players in the SAME room wake it — and the persistent fact shows in every room of the world.
    expect(r2.state.objects.get('portal_arch')!.active).toBe(true);
    expect(w.state.objects.get('portal_arch')!.active).toBe(true);
    expect(w.state.objects.get('portal_arch')!.value).toBe(1);
    expect((await w.memory.list({ kind: 'portal_awakened' }))[0]!.actors.map((x) => x.name).sort()).toEqual(['Bob', 'Cara']);

    // Bell: three ringers split across rooms → no chorus.
    const d = await w.join('Dan', 0, 0);
    await w.interact(a, 'bell_town_hall');
    await w.interact(d, 'bell_town_hall');
    await r2.interact(b, 'bell_town_hall');
    expect((await w.memory.list({ kind: 'bell_chorus' })).length).toBe(0);
    // The ring total is a world fact shared by both rooms.
    expect(r2.state.objects.get('bell_town_hall')!.value).toBe(3);

    await r2.dispose();
    expect(w.collective.roomCount()).toBe(1);
    await w.close();
  });
});
