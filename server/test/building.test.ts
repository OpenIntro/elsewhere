import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG, PIECES, PROTECTED_ZONES, isWalkable, resolveMovement, type BuildPlacePayload, type BuildResultPayload, type BuildSnapshotPayload, type PieceKind } from '@elsewhere/shared';
import { newGuestProfile } from '../src/auth/index.js';
import { buildArticles } from '../src/gazette/index.js';
import { createPersistence } from '../src/persistence/index.js';
import { makeWorld, type World } from './helpers.js';

/** Flat open meadow (see shared/test/building.test.ts). */
const SITE = { x: -17, z: 17 };
const STAND = { x: SITE.x + 1, z: SITE.z - 3 };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let req = 0;
function payload(kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<BuildPlacePayload> = {}): BuildPlacePayload {
  return { reqId: ++req, kind, variant: PIECES[kind]?.variants[0]!.id ?? 'none', x, z, rot, level, ...extra };
}
function lastResult(w: World, sid: string): BuildResultPayload {
  const all = w.received(sid, 'build_result') as BuildResultPayload[];
  return all[all.length - 1]!;
}
async function place(w: World, sid: string, kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<BuildPlacePayload> = {}): Promise<BuildResultPayload> {
  await w.building!.place(w.ctx, sid, payload(kind, x, z, rot, level, extra));
  return lastResult(w, sid);
}
async function remove(w: World, sid: string, id: string): Promise<BuildResultPayload> {
  await w.building!.remove(w.ctx, sid, { reqId: ++req, id });
  return lastResult(w, sid);
}
const gen = { capacity: 1000, refillPerSecond: 1000 };

describe('building service', { timeout: 60_000 }, () => {
  it('places, broadcasts to every room of the world, persists, and refuses with reasons', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const other = await w.openRoom('second');
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await other.join('Birch', STAND.x + 30, STAND.z);
    const r = await place(w, a, 'wall', SITE.x, SITE.z);
    expect(r).toMatchObject({ ok: true, action: 'place' });
    expect(w.received(a, 'build_placed')).toHaveLength(1);
    expect(other.received(b, 'build_placed')).toHaveLength(1);
    const placed = w.received(a, 'build_placed')[0] as { piece: { id: string; y: number; ownerId: string }; by: string };
    expect(placed.by).toBe(a);
    expect(placed.piece.ownerId).toBe(w.ctx.getProfile(a)!.id);
    // In the database.
    const rows = await w.persistence.sql.query('SELECT id, world_id FROM build_pieces');
    expect(rows).toEqual([{ id: placed.piece.id, world_id: 'default' }]);
    // Refusals come back to the requester with a reason and a message, and nothing is broadcast.
    expect(await place(w, a, 'wall', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'overlap' });
    w.move(a, -4, 9);
    expect(await place(w, a, 'floor', -3, 6)).toMatchObject({ ok: false, reason: 'protected' });
    expect((await place(w, a, 'floor', -3, 6)).message).toMatch(/Town Square/);
    w.move(a, STAND.x, STAND.z);
    expect(await place(w, a, 'wall', SITE.x + 0.25, SITE.z)).toMatchObject({ ok: false, reason: 'off_grid' });
    expect(await place(w, a, 'wall', SITE.x, SITE.z, 7)).toMatchObject({ ok: false, reason: 'bad_rotation' });
    expect(await place(w, a, 'tower' as PieceKind, SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'unknown_piece' });
    expect(await place(w, a, 'wall', SITE.x, SITE.z, 0, 0, { variant: 'gold' })).toMatchObject({ ok: false, reason: 'bad_variant' });
    expect(await place(w, a, 'wall', SITE.x + 40, SITE.z)).toMatchObject({ ok: false, reason: 'too_far' });
    expect(await place(w, a, 'roof_flat', SITE.x + 2, SITE.z + 4, 0, 1)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(other.received(b, 'build_placed')).toHaveLength(1);
    await w.close();
  });

  it('refuses to place solid pieces on any player, in any room of the world', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const other = await w.openRoom('second');
    const a = await w.join('Ash', STAND.x, STAND.z);
    await other.join('Birch', SITE.x + 0.4, SITE.z + 0.2);
    expect(await place(w, a, 'wall', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'player_in_way' });
    expect(await place(w, a, 'floor', SITE.x, SITE.z + 1)).toMatchObject({ ok: true });
    await w.close();
  });

  it('walls block server-side movement for everyone; doorways do not', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    expect((await place(w, a, 'wall', SITE.x, SITE.z)).ok).toBe(true);
    expect((await place(w, a, 'doorway', SITE.x + 2, SITE.z)).ok).toBe(true);
    const r = CONFIG.movement.playerRadius;
    expect(resolveMovement({ x: SITE.x, z: SITE.z - 1.5 }, { x: SITE.x, z: SITE.z + 1.5 }, r, w.collision).z).toBeLessThan(SITE.z);
    expect(resolveMovement({ x: SITE.x + 2, z: SITE.z - 1.5 }, { x: SITE.x + 2, z: SITE.z + 1.5 }, r, w.collision).z).toBeCloseTo(SITE.z + 1.5, 3);
    expect(isWalkable({ x: SITE.x, z: SITE.z }, r, w.collision)).toBe(false);
    await w.close();
  });

  it('enforces the per-profile rate limit (across reconnects)', async () => {
    const w = await makeWorld({ building: { rate: { capacity: 3, refillPerSecond: 0.5 } } });
    const profile = newGuestProfile('Ash');
    const a = await w.join('Ash', STAND.x, STAND.z, profile);
    for (let i = 0; i < 3; i++) expect((await place(w, a, 'crate', SITE.x + i, SITE.z)).ok).toBe(true);
    expect(await place(w, a, 'crate', SITE.x + 3, SITE.z)).toMatchObject({ ok: false, reason: 'rate_limited' });
    await w.leave(a);
    const again = await w.join('Ash', STAND.x, STAND.z, profile);
    expect(await place(w, again, 'crate', SITE.x + 3, SITE.z)).toMatchObject({ ok: false, reason: 'rate_limited' });
    w.clock.advance(2100);
    expect((await place(w, again, 'crate', SITE.x + 3, SITE.z)).ok).toBe(true);
    await w.close();
  });

  it('enforces the per-player and per-world caps', async () => {
    const w = await makeWorld({ building: { rate: gen, maxPerPlayer: 2, maxPerWorld: 3 } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    expect((await place(w, a, 'crate', SITE.x, SITE.z)).ok).toBe(true);
    expect((await place(w, a, 'crate', SITE.x + 1, SITE.z)).ok).toBe(true);
    expect(await place(w, a, 'crate', SITE.x + 2, SITE.z)).toMatchObject({ ok: false, reason: 'player_cap' });
    expect((await place(w, b, 'crate', SITE.x + 2, SITE.z)).ok).toBe(true);
    expect(await place(w, b, 'crate', SITE.x + 3, SITE.z)).toMatchObject({ ok: false, reason: 'world_cap' });
    await w.close();
  });

  it('can be switched off', async () => {
    const w = await makeWorld({ building: { enabled: false } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    expect(await place(w, a, 'crate', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'disabled' });
    await w.close();
  });

  it('stacks two storeys and a roof; only your own pieces carry yours', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    expect((await place(w, a, 'wall', SITE.x, SITE.z)).ok).toBe(true);
    expect((await place(w, a, 'wall', SITE.x, SITE.z, 0, 1)).ok).toBe(true);
    expect((await place(w, a, 'roof_slope', SITE.x, SITE.z + 1, 0, 2)).ok).toBe(true);
    expect(await place(w, a, 'wall', SITE.x, SITE.z, 0, CONFIG.building.maxLevel)).toMatchObject({ ok: false, reason: 'bad_level' });
    expect((await place(w, a, 'wall', SITE.x + 4, SITE.z)).ok).toBe(true);
    expect(await place(w, b, 'roof_flat', SITE.x + 4, SITE.z + 1, 0, 1)).toMatchObject({ ok: false, reason: 'not_your_support' });
    const ys = [...w.building!.index.all()].filter((p) => p.x === SITE.x).map((p) => p.y).sort((x, y) => x - y);
    expect(ys[1]! - ys[0]!).toBeCloseTo(CONFIG.building.storeyHeight, 2);
    expect(ys[2]! - ys[1]!).toBeCloseTo(CONFIG.building.storeyHeight, 2);
    await w.close();
  });

  it('only the owner removes, never from under other pieces; a forged remove is refused', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    const base = (await place(w, a, 'wall', SITE.x, SITE.z)).pieceId!;
    const top = (await place(w, a, 'wall', SITE.x, SITE.z, 0, 1)).pieceId!;
    expect(await remove(w, b, base)).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(await remove(w, b, top)).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(await remove(w, a, 'nope')).toMatchObject({ ok: false, reason: 'not_found' });
    await w.building!.remove(w.ctx, b, { reqId: 1, id: 42 as unknown as string });
    expect(lastResult(w, b)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await remove(w, a, base)).toMatchObject({ ok: false, reason: 'supports_others' });
    expect(w.building!.index.size).toBe(2);
    expect(await remove(w, a, top)).toMatchObject({ ok: true });
    expect(await remove(w, a, base)).toMatchObject({ ok: true });
    const removed = w.received(b, 'build_removed') as { ids: string[]; by: string }[];
    expect(removed.map((r) => r.ids[0])).toEqual([top, base]);
    expect(removed[0]!.by).toBe('owner');
    expect(await w.persistence.sql.query('SELECT id FROM build_pieces')).toEqual([]);
    await w.close();
  });

  it('admins remove any piece (with what rests on it) and all pieces of a profile', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    const base = (await place(w, a, 'wall', SITE.x, SITE.z)).pieceId!;
    const top = (await place(w, a, 'wall', SITE.x, SITE.z, 0, 1)).pieceId!;
    const lone = (await place(w, a, 'crate', SITE.x + 3, SITE.z + 2)).pieceId!;
    const theirs = (await place(w, b, 'crate', SITE.x + 4, SITE.z + 3)).pieceId!;
    expect((await w.building!.adminRemove([base])).sort()).toEqual([base, top].sort());
    expect((w.received(b, 'build_removed').at(-1) as { by: string }).by).toBe('admin');
    expect(await w.building!.adminRemoveProfile(w.ctx.getProfile(a)!.id)).toEqual([lone]);
    expect([...w.building!.index.all()].map((p) => p.id)).toEqual([theirs]);
    expect((await w.persistence.sql.query<{ id: string }>('SELECT id FROM build_pieces')).map((r) => r.id)).toEqual([theirs]);
    await w.close();
  });

  it('sign text goes through the text filter, length limit and mute', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    expect(await place(w, a, 'sign', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'text_required' });
    expect(await place(w, a, 'sign', SITE.x, SITE.z, 0, 0, { text: '   ​ ' })).toMatchObject({ ok: false, reason: 'text_required' });
    expect(await place(w, a, 'sign', SITE.x, SITE.z, 0, 0, { text: 'x'.repeat(CONFIG.building.signMaxLength + 1) })).toMatchObject({ ok: false, reason: 'text_too_long' });
    const ok = await place(w, a, 'sign', SITE.x, SITE.z, 0, 0, { text: '  Welcome   to\nthe shit shack ' });
    expect(ok.ok).toBe(true);
    expect(w.building!.index.get(ok.pieceId!)!.text).toBe('Welcome to the s*** shack');
    // Text on other pieces is ignored.
    const crate = await place(w, a, 'crate', SITE.x + 2, SITE.z, 0, 0, { text: 'hello' });
    expect(w.building!.index.get(crate.pieceId!)!.text).toBeUndefined();
    await w.moderation.sanction({ profileId: w.ctx.getProfile(a)!.id, kind: 'chat_mute', minutes: 5, reason: 't', createdBy: 'test' });
    expect(await place(w, a, 'sign', SITE.x + 3, SITE.z + 2, 0, 0, { text: 'hi' })).toMatchObject({ ok: false, reason: 'muted' });
    await w.close();
  });

  it('banned and build-banned players cannot build; blocks keep builders apart', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    const c = await w.join('Cedar', STAND.x + 2, STAND.z);
    await w.moderation.sanction({ profileId: w.ctx.getProfile(c)!.id, kind: 'build_ban', minutes: 60, reason: 'grief', createdBy: 'admin' });
    expect(await place(w, c, 'crate', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'banned' });
    expect((await w.persistence.sanctions.active(w.clock.t)).map((s) => s.kind)).toContain('build_ban');
    expect((await place(w, a, 'crate', SITE.x, SITE.z)).ok).toBe(true);
    await w.moderation.block(w.ctx, a, { target: b });
    expect(await place(w, b, 'crate', SITE.x + 2, SITE.z)).toMatchObject({ ok: false, reason: 'blocked' });
    // Even if the blocker is offline.
    await w.leave(a);
    expect(await place(w, b, 'crate', SITE.x + 2, SITE.z)).toMatchObject({ ok: false, reason: 'blocked' });
    expect((await place(w, b, 'crate', SITE.x + 2, SITE.z + 6)).ok).toBe(true);
    await w.close();
  });

  it('a full ban (issued while online) refuses building too', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    await w.moderation.sanction({ profileId: w.ctx.getProfile(a)!.id, kind: 'ban', minutes: 60, reason: 'grief', createdBy: 'admin' });
    expect(await place(w, a, 'crate', SITE.x, SITE.z)).toMatchObject({ ok: false, reason: 'banned' });
    expect(w.building!.index.size).toBe(0);
    await w.close();
  });

  it('refuses water, off-island and door aprons on the server too (shared rulebook)', async () => {
    const w = await makeWorld({ building: { rate: gen, range: 1000 } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    expect(await place(w, a, 'crate', -35, -43.5)).toMatchObject({ ok: false, reason: 'water' });
    expect(await place(w, a, 'crate', 0, 75)).toMatchObject({ ok: false, reason: 'out_of_bounds' });
    const apron = PROTECTED_ZONES.find((z) => z.kind === 'door_apron')!;
    const r = await place(w, a, 'crate', Math.round(apron.center.x * 2) / 2, Math.round(apron.center.z * 2) / 2);
    expect(r).toMatchObject({ ok: false, reason: 'protected' });
    expect(r.message).toMatch(/doorway/);
    await w.close();
  });

  it('re-sends the snapshot on request (C2S.buildSync after a reconnection)', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    expect((await place(w, a, 'crate', SITE.x, SITE.z)).ok).toBe(true);
    w.building!.sendSnapshot(w.ctx, a);
    const chunks = w.received(a, 'build_snapshot') as BuildSnapshotPayload[];
    expect(chunks.at(-1)).toMatchObject({ reset: true, done: true, total: 1 });
    await w.close();
  });

  it('records real building events in World Memory and the Gazette writes them up', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const flush = () => new Promise((r) => setTimeout(r, 30));
    // A 4 x 2 m room: walls on three sides, a doorway, a roof.
    const S = SITE;
    for (const [k, x, z, rot] of [
      ['wall', S.x, S.z - 1, 0],
      ['wall', S.x + 2, S.z - 1, 0],
      ['doorway', S.x, S.z + 1, 0],
      ['wall_window', S.x + 2, S.z + 1, 0],
      ['wall', S.x - 1, S.z, 1],
      ['wall', S.x + 3, S.z, 1],
    ] as const) {
      const r = await place(w, a, k, x, z, rot);
      expect(r.ok, `${k} ${x},${z},${rot}: ${r.reason}`).toBe(true);
      await flush();
    }
    expect((await place(w, a, 'roof_flat', S.x, S.z, 0, 1)).ok).toBe(true);
    await flush();
    for (let i = 0; i < 3; i++) {
      expect((await place(w, a, 'crate', S.x - 3 + i, S.z + 4)).ok).toBe(true);
      await flush();
    }
    const kinds = (await w.memory.list({ limit: 50 })).map((e) => `${e.kind}${e.data?.milestone ? `:${e.data.milestone}:${e.data.contributions}` : ''}`);
    expect(kinds.filter((k) => k === 'first_build')).toHaveLength(1);
    expect(kinds).toContain('structure_roofed');
    expect(kinds).toContain('milestone:build_pieces:10');
    // A second roof on the same structure is not news.
    expect((await place(w, a, 'roof_flat', S.x + 2, S.z, 0, 1)).ok).toBe(true);
    await flush();
    const events = await w.memory.list({ limit: 50 });
    expect(events.filter((e) => e.kind === 'structure_roofed')).toHaveLength(1);
    const articles = buildArticles(events, { epochMs: 0, dayLengthMs: 48 * 60_000, startTimeOfDay: 0.3 });
    const ids = articles.map((x) => x.templateId);
    expect(ids).toEqual(expect.arrayContaining(['structure_roofed', 'first_build', 'build_pieces']));
    const roofed = articles.find((x) => x.templateId === 'structure_roofed')!;
    expect(roofed.body).toContain('Ash');
    expect(roofed.eventIds).toHaveLength(1);
    // Toasts went to the room for the milestone and the roof.
    expect((w.received(a, 'world_event') as { event: { kind: string } }[]).map((e) => e.event.kind)).toEqual(expect.arrayContaining(['structure_roofed', 'milestone']));
    await w.close();
  });

  it('sends late joiners the whole world in chunks', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    for (let i = 0; i < 6; i++) expect((await place(w, a, 'crate', SITE.x - 2 + i, SITE.z + 5)).ok).toBe(true);
    const late = await w.join('Late', STAND.x + 2, STAND.z);
    const chunks = w.received(late, 'build_snapshot') as BuildSnapshotPayload[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ reset: true, done: true, total: 6 });
    expect(chunks[0]!.owners).toEqual([[w.ctx.getProfile(a)!.id, 'Ash']]);
    expect(chunks[0]!.pieces.map((p) => p[0]).sort()).toEqual([...w.building!.index.all()].map((p) => p.id).sort());
    // Empty world: still one (empty) chunk, so the client knows it is in sync.
    const empty = await makeWorld({ building: true });
    const s = await empty.join('Solo', STAND.x, STAND.z);
    expect(empty.received(s, 'build_snapshot')).toEqual([{ reset: true, done: true, total: 0, owners: [], pieces: [] }]);
    await empty.close();
    await w.close();
  });

  it('chunks big worlds', async () => {
    const w = await makeWorld({ building: { rate: gen, maxPerPlayer: 5000 } });
    const pieces = w.building!.index;
    for (let i = 0; i < CONFIG.building.snapshotChunk * 2 + 7; i++) pieces.add({ id: `x${i}`, kind: 'crate', variant: 'oak', x: i, z: 100, rot: 0, level: 0, y: 0, ownerId: `o${i % 3}`, ownerName: `O${i % 3}` });
    const chunks = w.building!.snapshotChunks();
    expect(chunks.map((c) => [c.reset, c.done, c.pieces.length])).toEqual([
      [true, false, CONFIG.building.snapshotChunk],
      [false, false, CONFIG.building.snapshotChunk],
      [false, true, 7],
    ]);
    expect(chunks[2]!.owners.length).toBe(3);
    await w.close();
  });

  it('unstuck carries the player back to the Town Square', async () => {
    const w = await makeWorld({ building: true });
    const a = await w.join('Ash', STAND.x, STAND.z);
    w.building!.unstuck(w.ctx, a);
    const p = w.ctx.getPlayer(a)!;
    expect(Math.hypot(p.x, p.z - 2)).toBeLessThan(9);
    expect((w.received(a, 'notice') as { code: string }[]).some((n) => n.code === 'unstuck')).toBe(true);
    await w.close();
  });

  it('survives a restart: pieces, collision and counters come back from the database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-build-'));
    dirs.push(dir);
    const p1 = createPersistence({ dataDir: dir });
    const w1 = await makeWorld({ persistence: p1, building: { rate: gen } });
    const a = await w1.join('Ash', STAND.x, STAND.z);
    const placed: string[] = [];
    placed.push((await place(w1, a, 'wall', SITE.x, SITE.z)).pieceId!);
    placed.push((await place(w1, a, 'wall', SITE.x, SITE.z, 0, 1)).pieceId!);
    placed.push((await place(w1, a, 'sign', SITE.x + 2, SITE.z + 2, 1, 0, { text: 'Fern Cottage' })).pieceId!);
    const before = [...w1.building!.index.all()].map((p) => ({ ...p })).sort((x, y) => x.id.localeCompare(y.id));
    await new Promise((r) => setTimeout(r, 50));
    await w1.close();

    const p2 = createPersistence({ dataDir: dir });
    const w2 = await makeWorld({ persistence: p2, building: { rate: gen } });
    const after = [...w2.building!.index.all()].map((p) => ({ ...p })).sort((x, y) => x.id.localeCompare(y.id));
    expect(after).toEqual(before);
    expect(after.find((p) => p.kind === 'sign')!.text).toBe('Fern Cottage');
    expect(isWalkable({ x: SITE.x, z: SITE.z }, CONFIG.movement.playerRadius, w2.collision)).toBe(false);
    const late = await w2.join('Late', STAND.x, STAND.z);
    expect((w2.received(late, 'build_snapshot') as BuildSnapshotPayload[])[0]!.total).toBe(3);
    // The milestone counter persisted too (pieces ever placed).
    expect(w2.building!.stats().placedTotal).toBe(3);
    await w2.close();
  });
});
