import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newGuestProfile } from '../src/auth/index.js';
import { createMemory } from '../src/memory/index.js';
import { MIGRATIONS, migrate } from '../src/persistence/migrations.js';
import { openDb } from '../src/persistence/db.js';
import { createPersistence } from '../src/persistence/index.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-test-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('persistence (PGlite)', { timeout: 60_000 }, () => {
  it('records attributed events with sortable ids and lists newest first with filters + cursor', async () => {
    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const m = createMemory(p);
    const a = await m.record({ kind: 'bell_rung', actors: [{ profileId: 'p1', name: 'Fern' }], locationId: 'town_hall', significance: 1, ts: 1000 });
    const b = await m.record({ kind: 'secret_found', actors: [{ profileId: 'p2', name: 'Moth' }], locationId: 'woods', significance: 2, ts: 2000 });
    const c = await m.record({ kind: 'secret_found', actors: [{ profileId: 'p1', name: 'Fern' }], locationId: 'woods', significance: 2, ts: 2000 });
    expect(a.id < b.id && b.id < c.id).toBe(true);
    expect((await m.list({})).map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect((await m.list({ locationId: 'woods' })).map((e) => e.id)).toEqual([c.id, b.id]);
    expect((await m.list({ before: b.id })).map((e) => e.id)).toEqual([a.id]);
    expect((await m.list({ profileId: 'p1' })).map((e) => e.id)).toEqual([c.id, a.id]);
    expect((await m.list({ kind: 'bell_rung' })).map((e) => e.id)).toEqual([a.id]);
    expect((await p.events.range(1500, 2001)).map((e) => e.id)).toEqual([b.id, c.id]);
    await p.close();
  });

  it('migrations are idempotent', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    expect(await migrate(db)).toEqual([1, 2, 3]);
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });

  it('migration 2 upgrades a v1 database in place: existing world rows land in the default world; worlds are isolated', async () => {
    const db = await openDb({ dataDir: 'memory://' });
    await migrate(db, MIGRATIONS.slice(0, 1));
    await db.query("INSERT INTO world_kv (key, value, updated_at) VALUES ('facts', '{\"fountainStage\":2}', 1)");
    await db.query("INSERT INTO world_sets (set_name, member, added_at) VALUES ('s', 'a', 1)");
    expect(await migrate(db)).toEqual([2, 3]);
    const rows = await db.query<{ world_id: string }>('SELECT world_id FROM world_kv');
    expect(rows.map((r) => r.world_id)).toEqual(['default']);
    await db.close();

    const p = createPersistence({ dataDir: 'memory://' });
    await p.init();
    const other = p.forWorld('second');
    await p.worldState.setKv('k', 1);
    await other.setKv('k', 2);
    expect(await p.worldState.addToSet('set', 'm')).toBe(true);
    expect(await other.addToSet('set', 'm')).toBe(true);
    await other.saveObject({ id: 'bell_town_hall', active: false, value: 9, data: {}, updatedAt: 1 });
    expect(await p.worldState.getKv('k')).toBe(1);
    expect(await other.getKv('k')).toBe(2);
    expect(await p.worldState.loadObjects()).toEqual([]);
    expect((await other.loadObjects())[0]?.value).toBe(9);
    await p.close();
  });

  it('round-trips every repository through a close/reopen of the same DATA_DIR', async () => {
    const dir = tmp();
    const p1 = createPersistence({ dataDir: dir });
    await p1.init();
    const prof = newGuestProfile('Fern');
    prof.discoveries = ['mossy_coin'];
    prof.inventory = ['apple'];
    prof.lastPosition = { x: 1.5, z: -2 };
    prof.stats = { chats: 3 };
    await p1.profiles.save(prof);
    await p1.relations.add(prof.id, 'other', 'block', 1);
    await p1.relations.add(prof.id, 'loud', 'mute', 2);
    await p1.sessions.create({ tokenHash: 'h1', profileId: prof.id, kind: 'guest', createdAt: 1, expiresAt: 9e15, revokedAt: null });
    await p1.worldState.save({ clockEpochMs: 123, fountainContributors: 2, fountainStage: 1, portalAwakenings: 1, counters: { x: 5 } });
    expect(await p1.worldState.addToSet('s', 'a')).toBe(true);
    expect(await p1.worldState.addToSet('s', 'a')).toBe(false);
    await p1.worldState.saveObject({ id: 'bell_town_hall', active: false, value: 7, data: {}, updatedAt: 5 });
    await p1.events.append({ id: 'e1', ts: 10, kind: 'portal_awakened', actors: [{ profileId: prof.id, name: 'Fern' }], significance: 3, data: { awakenings: 1 } });
    await p1.gazette.save({ id: 'gz1', issueNumber: 1, publishedAt: 20, periodStart: 0, periodEnd: 20, title: 'T', articles: [], stats: { uniqueVisitors: 1, eventsRecorded: 1, bellRings: 0, secretsFound: 0 } });
    await p1.mail.add({ id: 'n1', mailboxId: 'mailbox_post_office', fromProfileId: prof.id, fromName: 'Fern', text: 'hi', ts: 3 });
    await p1.reports.add({ id: 'r1', ts: 4, reporterProfileId: prof.id, targetProfileId: 'other', reason: 'spam', evidence: ['line'] });
    await p1.sanctions.add({ id: 'san1', profileId: 'other', kind: 'chat_mute', reason: 'x', createdAt: 1, expiresAt: 9e15, createdBy: 'admin', revokedAt: null });
    await p1.close();

    const p2 = createPersistence({ dataDir: dir });
    await p2.init();
    const back = await p2.profiles.get(prof.id);
    expect(back).toMatchObject({ displayName: 'Fern', discoveries: ['mossy_coin'], inventory: ['apple'], lastPosition: { x: 1.5, z: -2 }, stats: { chats: 3 }, blocked: ['other'], muted: ['loud'] });
    expect((await p2.sessions.get('h1'))?.profileId).toBe(prof.id);
    expect(await p2.worldState.load()).toMatchObject({ clockEpochMs: 123, fountainStage: 1, counters: { x: 5 } });
    expect(await p2.worldState.setSize('s')).toBe(1);
    expect((await p2.worldState.loadObjects())[0]).toMatchObject({ id: 'bell_town_hall', value: 7 });
    expect((await p2.events.list({}))[0]).toMatchObject({ id: 'e1', kind: 'portal_awakened', data: { awakenings: 1 } });
    expect((await p2.gazette.latest())?.id).toBe('gz1');
    expect((await p2.mail.list('mailbox_post_office', 10))[0]?.text).toBe('hi');
    expect((await p2.reports.list(10))[0]?.evidence).toEqual(['line']);
    expect((await p2.sanctions.active(100, 'other'))[0]?.kind).toBe('chat_mute');
    await p2.close();
  });
});
