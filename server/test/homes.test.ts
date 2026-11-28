/**
 * Homes service (server/src/homes) over the real building service and an
 * in-memory PGlite: one home per profile, forged requests refused with a
 * reason, upkeep after the owner's own changes (and only theirs), per-viewer
 * pin filtering (blocks, build bans), the rate limit, restart reload and
 * migration 6.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PIECES, type BuildPlacePayload, type BuildResultPayload, type HomeChangedPayload, type HomeResultPayload, type HomesPayload, type HomeWire, type PieceKind, type RateLimitRule } from '@elsewhere/shared';
import { buildArticles } from '../src/gazette/index.js';
import { createHomes, linkModeration, type HomesService } from '../src/homes/index.js';
import { openDb } from '../src/persistence/db.js';
import { createPersistence, type PersistenceService } from '../src/persistence/index.js';
import { MIGRATIONS, migrate } from '../src/persistence/migrations.js';
import { FakeClock, makeWorld, type World } from './helpers.js';

const gen = { capacity: 1000, refillPerSecond: 1000 };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The 4 × 4 hut of the roof tests: wall lines x −20..−16, z −1..3, doorway (−19, 3), window (−17, 3). */
const HUT = { x0: -20, z0: -1, x1: -16, z1: 3, x: -18, z: 1 };
const STAND = { x: -18, z: 5.5 };
/** A second hut of the same size on the meadow 17 m south (wall lines z 16..20). */
const HUT2 = { x0: -20, z0: 16, x1: -16, z1: 20, x: -18, z: 18 };
const STAND2 = { x: -18, z: 22.5 };

let req = 0;
async function place(w: World, sid: string, kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<BuildPlacePayload> = {}): Promise<BuildResultPayload> {
  await w.building!.place(w.ctx, sid, { reqId: ++req, kind, variant: PIECES[kind].variants[0]!.id, x, z, rot, level, ...extra });
  const all = w.received(sid, 'build_result') as BuildResultPayload[];
  return all[all.length - 1]!;
}
async function remove(w: World, sid: string, id: string): Promise<BuildResultPayload> {
  await w.building!.remove(w.ctx, sid, { reqId: ++req, id });
  const all = w.received(sid, 'build_result') as BuildResultPayload[];
  return all[all.length - 1]!;
}
const pieceAt = (w: World, kind: PieceKind, x: number, z: number) => [...w.building!.index.all()].find((p) => p.kind === kind && p.x === x && p.z === z)!;

/** Walls (doorway at the south-west, window at the south-east), then a house roof. Returns the piece ids by role. */
async function hut(w: World, sid: string, b = HUT, opts: { roof?: boolean } = {}) {
  const segs: [PieceKind, number, number, number][] = [
    ['wall', b.x0 + 1, b.z0, 0],
    ['wall', b.x0 + 3, b.z0, 0],
    ['wall', b.x0, b.z0 + 1, 1],
    ['wall', b.x0, b.z0 + 3, 1],
    ['wall', b.x1, b.z0 + 1, 1],
    ['wall', b.x1, b.z0 + 3, 1],
    ['doorway', b.x0 + 1, b.z1, 0],
    ['wall_window', b.x0 + 3, b.z1, 0],
  ];
  for (const [k, x, z, rot] of segs) {
    const r = await place(w, sid, k, x, z, rot);
    expect(r, `${k} ${x},${z}: ${r.message}`).toMatchObject({ ok: true });
  }
  if (opts.roof !== false) {
    const r = await place(w, sid, 'house_roof', b.x, b.z, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } });
    expect(r, `roof: ${r.message}`).toMatchObject({ ok: true });
  }
  return { door: pieceAt(w, 'doorway', b.x0 + 1, b.z1).id, east: pieceAt(w, 'wall', b.x1, b.z0 + 1).id, roof: opts.roof === false ? '' : pieceAt(w, 'house_roof', b.x, b.z).id };
}

async function setup(opts: { persistence?: PersistenceService; clock?: FakeClock; rate?: RateLimitRule } = {}) {
  const w = await makeWorld({ building: { rate: gen }, ...(opts.persistence ? { persistence: opts.persistence } : {}), ...(opts.clock ? { clock: opts.clock } : {}) });
  const homes = createHomes({ persistence: w.persistence, memory: w.memory, moderation: w.moderation, building: w.building!, now: w.clock.now, rate: opts.rate ?? gen });
  linkModeration(w.moderation, homes);
  w.hooks.push(homes);
  await homes.onRoomCreate!(w.ctx);
  return { w, homes };
}
const results = (w: World, sid: string) => w.received(sid, 'home_result') as HomeResultPayload[];
const lastResultOf = (w: World, sid: string) => results(w, sid)[results(w, sid).length - 1]!;
async function homeSet(w: World, h: HomesService, sid: string, pieceId: unknown) {
  await h.set(w.ctx, sid, { pieceId } as { pieceId: string });
  return lastResultOf(w, sid);
}
/** The latest view `sid` has of `owner`'s home: from the last S2C.homes and every later homeChanged. */
function viewOf(w: World, sid: string, owner: string): HomeWire | null {
  let v: HomeWire | null = null;
  for (const s of w.sent) {
    if (s.to !== sid) continue;
    if (s.type === 'homes') v = (s.payload as HomesPayload).homes.find((x) => x.profileId === owner) ?? null;
    if (s.type === 'home_changed') {
      const c = s.payload as HomeChangedPayload;
      if ('home' in c && c.home.profileId === owner) v = c.home;
      if ('cleared' in c && c.profileId === owner) v = null;
    }
  }
  return v;
}
const pid = (w: World, sid: string) => w.ctx.getProfile(sid)!.id;

describe('homes service', { timeout: 120_000 }, () => {
  it('one home per profile: set, a second set moves it; every room hears it; joiners get it after the snapshot; memory + Gazette', async () => {
    const { w, homes } = await setup();
    const other = await w.openRoom('second');
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const far = await other.join('Moth', 30, 30);
    const h1 = await hut(w, a);
    const r = await homeSet(w, homes, a, h1.east); // any piece of the house
    expect(r).toMatchObject({ action: 'set', ok: true, doorPieceId: h1.door });
    expect(homes.get(pid(w, a))).toMatchObject({ doorPieceId: h1.door, showOnMap: false, house: { rect: { minX: -20, maxX: -16, minZ: -1, maxZ: 3 } } });
    expect(viewOf(other, far, pid(w, a))).toMatchObject({ ownerName: 'Ivy', doorPieceId: h1.door, name: '', pinned: false });
    expect(await w.persistence.sql.query('SELECT profile_id, door_piece_id, show_on_map FROM homes')).toEqual([{ profile_id: pid(w, a), door_piece_id: h1.door, show_on_map: false }]);

    // A second set on another house moves the home (still one row).
    w.move(a, STAND2.x, STAND2.z);
    const h2 = await hut(w, a, HUT2);
    expect(await homeSet(w, homes, a, h2.roof)).toMatchObject({ ok: true, doorPieceId: h2.door });
    expect(homes.list()).toHaveLength(1);
    expect(viewOf(other, far, pid(w, a))?.doorPieceId).toBe(h2.door);
    expect(await w.persistence.sql.query('SELECT door_piece_id FROM homes')).toEqual([{ door_piece_id: h2.door }]);

    // A late joiner: build snapshot first, then the homes.
    const late = await w.join('Late', 40, 40);
    const types = w.sent.filter((s) => s.to === late && (s.type === 'build_snapshot' || s.type === 'homes')).map((s) => s.type);
    expect(types[types.length - 1]).toBe('homes');
    expect(types.indexOf('build_snapshot')).toBeLessThan(types.indexOf('homes'));
    expect(viewOf(w, late, pid(w, a))?.doorPieceId).toBe(h2.door);
    // buildSync re-sends both.
    w.clearSent();
    w.building!.sendSnapshot(w.ctx, late);
    expect(w.received(late, 'homes')).toHaveLength(1);

    // Memory: home_made once per profile per door (re-setting the same home does not repeat it); no location.
    await homeSet(w, homes, a, h2.door);
    await new Promise((res) => setTimeout(res, 50));
    const made = (await w.memory.list({ kind: 'home_made' })).filter((e) => e.kind === 'home_made');
    expect(made).toHaveLength(2);
    for (const e of made) expect(e.locationId).toBeUndefined();
    const arts = buildArticles(made, { epochMs: 0, dayLengthMs: 48 * 60_000 });
    expect(arts.find((x) => x.templateId === 'home_made')?.body).toBe('Ivy made the house they built their home.');
    await w.close();
  });

  it('forged homeSet on another player’s house, on a non-house, on nothing → refused with reasons; homeClear / homePin without a home too', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', STAND.x + 2, STAND.z);
    const h = await hut(w, a);
    expect(await homeSet(w, homes, b, h.door)).toMatchObject({ ok: false, reason: 'not_owner', text: expect.stringMatching(/builder/) });
    expect(await homeSet(w, homes, b, h.roof)).toMatchObject({ ok: false, reason: 'not_owner' });
    // B's bare floor tile and a lone wall: not a house.
    w.move(b, STAND2.x, STAND2.z);
    const fl = await place(w, b, 'floor', -19, 25);
    expect(fl, fl.message).toMatchObject({ ok: true });
    expect(await homeSet(w, homes, b, pieceAt(w, 'floor', -19, 25).id)).toMatchObject({ ok: false, reason: 'not_a_house', text: expect.any(String) });
    expect(await homeSet(w, homes, b, 'p_nope')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await homeSet(w, homes, b, { evil: 1 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await homeSet(w, homes, b, 'x'.repeat(500))).toMatchObject({ ok: false, reason: 'not_found' });
    await homes.clear(w.ctx, b);
    expect(lastResultOf(w, b)).toMatchObject({ action: 'clear', ok: false, reason: 'no_home' });
    await homes.pin(w.ctx, b, { on: true });
    expect(lastResultOf(w, b)).toMatchObject({ action: 'pin', ok: false, reason: 'no_home' });
    expect(homes.list()).toHaveLength(0);
    // A's house without its doorway: refused with the reason.
    const c = await w.join('Wren', STAND2.x, STAND2.z);
    const walls: [PieceKind, number, number, number][] = [
      ['wall', -19, 16, 0], ['wall', -17, 16, 0], ['wall', -20, 17, 1], ['wall', -20, 19, 1], ['wall', -16, 17, 1], ['wall', -16, 19, 1], ['wall', -19, 20, 0], ['wall', -17, 20, 0],
    ];
    for (const [k, x, z, rot] of walls) expect(await place(w, c, k, x, z, rot), `${x},${z}`).toMatchObject({ ok: true });
    expect(await place(w, c, 'house_roof', -18, 18, 0, 1, { params: { w: 4, d: 4, style: 'gable', pitch: 1 } })).toMatchObject({ ok: true });
    expect(await homeSet(w, homes, c, pieceAt(w, 'house_roof', -18, 18).id)).toMatchObject({ ok: false, reason: 'no_doorway' });
    await w.close();
  });

  it('removing walls so it no longer qualifies → cleared + notice (doorway gone; then too few walls); removing the roof too', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', 30, 30);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.east);
    // The roof rests on 8 walls, so one may go: a plain wall out → still a home (7 walls), re-sent.
    expect(await remove(w, a, h.east)).toMatchObject({ ok: true });
    await homes.flush();
    expect(homes.get(pid(w, a))?.house.wallPieceIds).toHaveLength(7);
    // The doorway out → no longer a home: cleared on every client, row deleted, the owner told why.
    expect(await remove(w, a, h.door)).toMatchObject({ ok: true });
    await homes.flush();
    expect(homes.get(pid(w, a))).toBeUndefined();
    expect(viewOf(w, b, pid(w, a))).toBeNull();
    expect(viewOf(w, a, pid(w, a))).toBeNull();
    expect((w.received(a, 'notice') as { code?: string; text: string }[]).find((n) => n.code === 'home_cleared')?.text).toMatch(/doorway/);
    expect(await w.persistence.sql.query('SELECT * FROM homes')).toEqual([]);
    expect(await homeSet(w, homes, a, h.roof)).toMatchObject({ ok: false, reason: 'no_doorway' });

    // A second hut: walls out one by one until fewer than four remain → cleared (few walls).
    w.move(a, STAND2.x, STAND2.z);
    const h2 = await hut(w, a, HUT2);
    const r2 = await homeSet(w, homes, a, h2.door);
    expect(r2, r2.text).toMatchObject({ ok: true });
    const plain = [...w.building!.index.all()].filter((p) => p.kind === 'wall' && p.z >= HUT2.z0 && p.z <= HUT2.z1).map((p) => p.id);
    let n = 0;
    for (const id of plain) {
      const r = await remove(w, a, id);
      if (!r.ok) continue; // the roof needs its last supports
      n++;
      await homes.flush();
      if (!homes.get(pid(w, a))) break;
    }
    expect(homes.get(pid(w, a)), `after ${n} removals`).toBeUndefined();
    expect((w.received(a, 'notice') as { code?: string }[]).filter((x) => x.code === 'home_cleared')).toHaveLength(2);

    // A third: removing its roof clears it (the walls carry nothing any more).
    w.move(a, STAND.x, STAND.z);
    expect(await place(w, a, 'doorway', -19, 3, 0)).toMatchObject({ ok: true });
    expect(await place(w, a, 'wall', -16, 0, 1)).toMatchObject({ ok: true });
    const door2 = pieceAt(w, 'doorway', -19, 3).id;
    const r3 = await homeSet(w, homes, a, door2);
    expect(r3, r3.reason).toMatchObject({ ok: true });
    expect(await remove(w, a, h.roof)).toMatchObject({ ok: true });
    await homes.flush();
    expect(homes.get(pid(w, a))).toBeUndefined();
    expect((w.received(a, 'notice') as { code?: string; text: string }[]).filter((x) => x.code === 'home_cleared').pop()?.text).toMatch(/roof/);
    await w.close();
  });

  it('an admin removing just the doorway (adminRemove) clears it', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.door);
    const gone = await w.building!.adminRemove([h.door]);
    expect(gone).toContain(h.door);
    await homes.flush();
    expect(homes.get(pid(w, a))).toBeUndefined();
    expect((w.received(a, 'notice') as { code?: string }[]).some((n) => n.code === 'home_cleared')).toBe(true);
    await w.close();
  });

  it('adminRemove of its roof and adminRemoveProfile → cleared', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', STAND2.x, STAND2.z);
    const ha = await hut(w, a);
    const hb = await hut(w, b, HUT2);
    await homeSet(w, homes, a, ha.door);
    await homeSet(w, homes, b, hb.door);
    expect(homes.list()).toHaveLength(2);
    await w.building!.adminRemove([ha.roof]);
    await homes.flush();
    expect(homes.get(pid(w, a))).toBeUndefined();
    expect(homes.get(pid(w, b))).toBeDefined();
    await w.building!.adminRemoveProfile(pid(w, b));
    await homes.flush();
    expect(homes.list()).toHaveLength(0);
    expect(await w.persistence.sql.query('SELECT * FROM homes')).toEqual([]);
    await w.close();
  });

  it('a neighbour’s place / remove next to it (even a roof against it and pieces touching it) leaves it unchanged', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', -21.5, 5.5);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.door);
    const before = JSON.stringify(homes.get(pid(w, a)));
    w.clearSent();
    // Rowan builds a narrow lean-to against Ivy's west wall: walls x −22..−20 without an east wall, and a roof over it.
    for (const [k, x, z, rot] of [['wall', -21, -1, 0], ['wall', -22, 0, 1], ['wall', -22, 2, 1], ['doorway', -21, 3, 0]] as [PieceKind, number, number, number][]) {
      const r = await place(w, b, k, x, z, rot);
      expect(r, `${k} ${x},${z}: ${r.message}`).toMatchObject({ ok: true });
    }
    const roofed = await place(w, b, 'house_roof', -21, 1, 0, 1, { params: { w: 2, d: 4, style: 'gable', pitch: 1 } });
    // (Whether the roof tool lets Rowan roof it is the roof rules' business; either way Ivy's home must not change.)
    expect(roofed.ok === true || typeof roofed.reason === 'string').toBe(true);
    expect(await place(w, b, 'lamp', -20.5, 4.5)).toMatchObject({ ok: true });
    const lamp = pieceAt(w, 'lamp', -20.5, 4.5);
    expect(await remove(w, b, lamp.id)).toMatchObject({ ok: true });
    await homes.flush();
    expect(JSON.stringify(homes.get(pid(w, a)))).toBe(before);
    expect(w.sent.filter((s) => s.type === 'home_changed')).toHaveLength(0);
    expect((w.received(a, 'notice') as { code?: string }[]).some((n) => n.code === 'home_cleared')).toBe(false);
    await w.close();
  });

  it('the name follows the owner’s facade sign; editing it re-sends the home', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', 30, 30);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.door);
    expect(await place(w, a, 'name_board', -19, 3, 0, 0, { text: 'Fern Cottage' })).toMatchObject({ ok: true });
    await homes.flush();
    expect(viewOf(w, b, pid(w, a))?.name).toBe('Fern Cottage');
    const board = pieceAt(w, 'name_board', -19, 3);
    await w.building!.editText(w.ctx, a, { reqId: ++req, id: board.id, text: 'Ivy House' });
    await homes.flush();
    expect(viewOf(w, b, pid(w, a))?.name).toBe('Ivy House');
    await w.close();
  });

  it('homePin toggles; a blocked viewer and a viewer who blocked the owner get pinned: false; unblocking restores it', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', 30, 30);
    const c = await w.join('Wren', 31, 30);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.door);
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(false); // off by default
    await homes.pin(w.ctx, a, { on: true });
    expect(lastResultOf(w, a)).toMatchObject({ action: 'pin', ok: true });
    for (const s of [a, b, c]) expect(viewOf(w, s, pid(w, a))?.pinned, s).toBe(true);
    expect((await w.persistence.sql.query<{ show_on_map: boolean }>('SELECT show_on_map FROM homes'))[0]?.show_on_map).toBe(true);
    await homes.pin(w.ctx, a, { on: 'yes' as unknown as boolean });
    expect(lastResultOf(w, a)).toMatchObject({ ok: false, reason: 'bad_request' });

    // B blocks A (viewer blocked the owner): B's view unpinned at once, C's not.
    await w.moderation.block(w.ctx, b, { profileId: pid(w, a) });
    await new Promise((r) => setTimeout(r, 20));
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(false);
    expect(viewOf(w, c, pid(w, a))?.pinned).toBe(true);
    await w.moderation.unblock(w.ctx, b, { profileId: pid(w, a) });
    await new Promise((r) => setTimeout(r, 20));
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(true);

    // A blocks C (a blocked viewer): C's view unpinned — also for a fresh join of C after A went offline.
    await w.moderation.block(w.ctx, a, { profileId: pid(w, c) });
    await new Promise((r) => setTimeout(r, 20));
    expect(viewOf(w, c, pid(w, a))?.pinned).toBe(false);
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(true);
    const owner = pid(w, a);
    const aProfile = w.ctx.getProfile(a)!;
    const cProfile = w.ctx.getProfile(c)!;
    await w.leave(a);
    await w.leave(c);
    const c2 = await w.join('Wren', 31, 30, cProfile);
    expect(viewOf(w, c2, owner)?.pinned).toBe(false);
    expect(viewOf(w, b, owner)?.pinned).toBe(true);
    // Pin off again: hidden for everyone.
    const a2 = await w.join('Ivy', STAND.x, STAND.z, aProfile);
    await homes.pin(w.ctx, a2, { on: false });
    expect(viewOf(w, b, pid(w, a2))?.pinned).toBe(false);
    await w.close();
  });

  it('a build-ban hides the pin at once (and refuses homeSet); lifting it shows it again', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', 30, 30);
    const h = await hut(w, a);
    await homeSet(w, homes, a, h.door);
    await homes.pin(w.ctx, a, { on: true });
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(true);
    const s = await w.moderation.sanction({ profileId: pid(w, a), kind: 'build_ban', minutes: 60, reason: 'grief', createdBy: 'admin' });
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(false);
    expect(homes.get(pid(w, a))).toBeDefined(); // the home itself stays theirs
    expect(await homeSet(w, homes, a, h.door)).toMatchObject({ ok: false, reason: 'banned' });
    // A new joiner also gets it unpinned.
    const c = await w.join('Wren', 31, 30);
    expect(viewOf(w, c, pid(w, a))?.pinned).toBe(false);
    expect(await w.moderation.revokeSanction(s.id)).toBe(true);
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(true);
    // A timed build ban that runs out on its own is noticed by the periodic check.
    await w.moderation.sanction({ profileId: pid(w, a), kind: 'build_ban', minutes: 1, reason: 'short', createdBy: 'admin' });
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(false);
    w.clock.advance(61_000);
    homes.tick!(w.ctx, 50);
    await new Promise((r) => setTimeout(r, 50));
    expect(viewOf(w, b, pid(w, a))?.pinned).toBe(true);
    await w.close();
  });

  it('a full ban hides the pin at once (the home stays the owner’s); lifting it shows it again', async () => {
    const { w, homes } = await setup();
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const b = await w.join('Rowan', 30, 30);
    const h = await hut(w, a);
    const owner = pid(w, a);
    await homeSet(w, homes, a, h.door);
    await homes.pin(w.ctx, a, { on: true });
    expect(viewOf(w, b, owner)?.pinned).toBe(true);
    const s = await w.moderation.sanction({ profileId: owner, kind: 'ban', minutes: 60, reason: 'abuse', createdBy: 'admin' });
    expect(viewOf(w, b, owner)?.pinned).toBe(false);
    expect(homes.get(owner)).toBeDefined();
    // A new joiner also gets it unpinned.
    const c = await w.join('Wren', 31, 30);
    expect(viewOf(w, c, owner)?.pinned).toBe(false);
    expect(await w.moderation.revokeSanction(s.id)).toBe(true);
    expect(viewOf(w, b, owner)?.pinned).toBe(true);
    await w.close();
  });

  it('rate limit enforced (per profile, all three messages)', async () => {
    const { w, homes } = await setup({ rate: { capacity: 3, refillPerSecond: 0.01 } });
    const a = await w.join('Ivy', STAND.x, STAND.z);
    const h = await hut(w, a);
    expect(await homeSet(w, homes, a, h.door)).toMatchObject({ ok: true });
    await homes.pin(w.ctx, a, { on: true });
    expect(lastResultOf(w, a)).toMatchObject({ ok: true });
    await homes.pin(w.ctx, a, { on: false });
    expect(lastResultOf(w, a)).toMatchObject({ ok: true });
    await homes.clear(w.ctx, a);
    expect(lastResultOf(w, a)).toMatchObject({ action: 'clear', ok: false, reason: 'rate_limited', text: expect.any(String) });
    expect(await homeSet(w, homes, a, h.door)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(homes.get(pid(w, a))).toBeDefined();
    w.clock.advance(200_000);
    await homes.clear(w.ctx, a);
    expect(lastResultOf(w, a)).toMatchObject({ action: 'clear', ok: true });
    await w.close();
  });

  it('a restart reloads homes (and pins); a home whose door piece vanished while the server was down is dropped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-homes-'));
    dirs.push(dir);
    const clock = new FakeClock();
    const p1 = createPersistence({ dataDir: dir });
    const one = await setup({ persistence: p1, clock });
    const a = await one.w.join('Ivy', STAND.x, STAND.z);
    const b = await one.w.join('Rowan', STAND2.x, STAND2.z);
    const ha = await hut(one.w, a);
    const hb = await hut(one.w, b, HUT2);
    await homeSet(one.w, one.homes, a, ha.door);
    await homeSet(one.w, one.homes, b, hb.door);
    await one.homes.pin(one.w.ctx, a, { on: true });
    const ida = pid(one.w, a);
    const idb = pid(one.w, b);
    await one.homes.flush();
    await one.w.close();

    // While the server is down, B's door piece disappears from the database.
    const p2 = createPersistence({ dataDir: dir });
    await p2.init();
    await p2.sql.write('DELETE FROM build_pieces WHERE id = $1', [hb.door]);
    await p2.close();

    const p3 = createPersistence({ dataDir: dir });
    const two = await setup({ persistence: p3, clock });
    expect(two.homes.list().map((h) => h.profileId)).toEqual([ida]);
    expect(two.homes.get(ida)).toMatchObject({ doorPieceId: ha.door, showOnMap: true, ownerName: 'Ivy', house: { rect: { minX: -20, maxX: -16, minZ: -1, maxZ: 3 } } });
    expect(two.homes.get(idb)).toBeUndefined();
    await two.homes.flush();
    expect(await two.w.persistence.sql.query('SELECT profile_id FROM homes')).toEqual([{ profile_id: ida }]);
    const late = await two.w.join('Late', 30, 30);
    expect(viewOf(two.w, late, ida)).toMatchObject({ doorPieceId: ha.door, pinned: true });
    await two.w.close();
  });
});

describe('migration 6 (homes)', { timeout: 60_000 }, () => {
  it('applies on a fresh DB and on a DB at 1-5; the table has its keys', async () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(MIGRATIONS.find((m) => m.id === 6)?.name).toBe('homes');
    const fresh = await openDb({ dataDir: 'memory://' });
    expect(await migrate(fresh)).toEqual([1, 2, 3, 4, 5, 6]);
    await fresh.close();

    const old = await openDb({ dataDir: 'memory://' });
    expect(await migrate(old, MIGRATIONS.filter((m) => m.id <= 5))).toEqual([1, 2, 3, 4, 5]);
    expect(await migrate(old)).toEqual([6]);
    expect(await migrate(old)).toEqual([]);
    await old.query("INSERT INTO homes (profile_id, door_piece_id, created_at) VALUES ('p1', 'd1', 1)");
    expect(await old.query('SELECT world_id, show_on_map FROM homes')).toEqual([{ world_id: 'default', show_on_map: false }]);
    await expect(old.query("INSERT INTO homes (profile_id, door_piece_id, created_at) VALUES ('p1', 'd2', 2)")).rejects.toThrow();
    await expect(old.query("INSERT INTO homes (profile_id, door_piece_id, created_at) VALUES ('p2', 'd1', 2)")).rejects.toThrow();
    await old.close();
  });
});
