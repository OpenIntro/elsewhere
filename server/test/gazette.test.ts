import { describe, expect, it } from 'vitest';
import { createGazette } from '../src/gazette/index.js';
import { createMemory } from '../src/memory/index.js';
import { createPersistence } from '../src/persistence/index.js';

const clock = () => ({ epochMs: 0, dayLengthMs: 48 * 60_000 });

describe('gazette', { timeout: 60_000 }, () => {
  it('compiles only from real recorded events in the period; quiet periods are honest; empty → no issue', async () => {
    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const m = createMemory(p);
    let now = 10_000_000;
    const g = createGazette(p, { intervalMs: 3_600_000, clock, now: () => now });

    expect(await g.compileIssue(0, now)).toBeNull();

    const before = await m.record({ kind: 'portal_awakened', actors: [{ profileId: 'x', name: 'Outsider' }], significance: 3, ts: 500, data: { awakenings: 1, first: true } });
    const f = await m.record({ kind: 'fountain_transformed', actors: [{ profileId: 'a', name: 'Alice' }, { profileId: 'b', name: 'Bob' }], locationId: 'town_square', significance: 3, ts: 2000, data: { stage: 1, contributions: 5, distinct: 3 } });
    const pa = await m.record({ kind: 'portal_awakened', actors: [{ profileId: 'a', name: 'Alice' }, { profileId: 'c', name: 'Cara' }], locationId: 'the_unknown', significance: 3, ts: 3000, data: { awakenings: 2, first: false } });
    const bell = await m.record({ kind: 'bell_rung', actors: [{ profileId: 'c', name: 'Cara' }], locationId: 'town_hall', significance: 0, ts: 3500 });
    const nv = await m.record({ kind: 'player_first_visit', actors: [{ profileId: 'd', name: 'Dan' }], significance: 1, ts: 3600 });

    const issue = (await g.compileIssue(1000, 5000))!;
    expect(issue.issueNumber).toBe(1);
    expect(issue.stats).toMatchObject({ eventsRecorded: 4, uniqueVisitors: 4, secretsFound: 0 });
    const real = new Set([f.id, pa.id, bell.id, nv.id]);
    for (const a of issue.articles) {
      for (const id of a.eventIds) expect(real.has(id)).toBe(true);
      expect(a.headline + a.body).not.toMatch(/[{}]/);
    }
    const text = JSON.stringify(issue);
    expect(text).not.toContain(before.id);
    expect(text).not.toContain('Outsider');
    expect(issue.articles[0]!.section).toBe('front_page');
    expect(issue.articles.find((a) => a.templateId === 'fountain_transformed')!.body).toMatch(/Alice and Bob/);
    expect(issue.articles.find((a) => a.templateId === 'portal_awakened')!.body).toMatch(/Alice and Cara/);
    expect(issue.articles.find((a) => a.templateId === 'newcomers')!.body).toMatch(/Dan/);
    expect((await g.list(5)).map((i) => i.id)).toEqual([issue.id]);
    expect((await g.get(issue.id))?.title).toBe(issue.title);

    // Quiet period: only trivia → one short honest article, no stats puffery.
    const t1 = await m.record({ kind: 'mail_sent', actors: [{ profileId: 'a', name: 'Alice' }], significance: 0, ts: 6000 });
    const quiet = (await g.compileIssue(5000, 7000))!;
    expect(quiet.articles).toHaveLength(1);
    expect(quiet.articles[0]).toMatchObject({ templateId: 'quiet', eventIds: [t1.id] });
    expect(quiet.issueNumber).toBe(2);

    // compileDue continues from the persisted cursor and yields nothing for an empty stretch.
    now = 8000;
    expect(await g.compileDue()).toBeNull();
    await p.close();
  });

  it('young world: the first issue appears soon after a few significant real events (not after a full interval), only once', async () => {
    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const m = createMemory(p);
    const g = createGazette(p, { intervalMs: 6 * 3_600_000, clock, memory: m, earlyEvents: 3, earlyDelayMs: 20 });
    g.start();
    const wait = () => new Promise((r) => setTimeout(r, 150));
    await m.record({ kind: 'player_first_visit', actors: [{ profileId: 'a', name: 'Alice' }], significance: 1 });
    await m.record({ kind: 'bell_rung', actors: [{ profileId: 'a', name: 'Alice' }], significance: 0 });
    await m.record({ kind: 'player_first_visit', actors: [{ profileId: 'b', name: 'Bob' }], significance: 1 });
    await wait();
    expect(await g.list(5)).toEqual([]); // 2 significant events: not yet
    const f = await m.record({ kind: 'fountain_transformed', actors: [{ profileId: 'a', name: 'Alice' }, { profileId: 'b', name: 'Bob' }], significance: 3, data: { stage: 1, contributions: 2, distinct: 2 } });
    await wait();
    const issues = await g.list(5);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.stats.eventsRecorded).toBe(4);
    expect(issues[0]!.articles.some((a) => a.eventIds.includes(f.id))).toBe(true);
    // After the first issue the normal cadence applies: no more early issues.
    for (let i = 0; i < 4; i++) await m.record({ kind: 'player_first_visit', actors: [{ profileId: `x${i}`, name: `X${i}` }], significance: 1 });
    await wait();
    expect(await g.list(5)).toHaveLength(1);
    g.stop();
    await p.close();
  });
});
