import { describe, expect, it } from 'vitest';
import { createMemory } from '../src/memory/index.js';
import { createPersistence } from '../src/persistence/index.js';

describe('memory seam (in-memory persistence)', () => {
  it('records attributed events with sortable ids and lists newest first', async () => {
    const p = createPersistence();
    const m = createMemory(p);
    const a = await m.record({ kind: 'bell_rung', actors: [{ profileId: 'p1', name: 'Fern' }], locationId: 'town_hall', significance: 1, ts: 1000 });
    const b = await m.record({ kind: 'secret_found', actors: [{ profileId: 'p2', name: 'Moth' }], locationId: 'woods', significance: 2, ts: 2000 });
    expect(a.id < b.id).toBe(true);
    expect((await m.list({})).map((e) => e.id)).toEqual([b.id, a.id]);
    expect((await m.list({ locationId: 'woods' })).map((e) => e.id)).toEqual([b.id]);
    expect((await m.list({ before: b.id })).map((e) => e.id)).toEqual([a.id]);
  });
});
