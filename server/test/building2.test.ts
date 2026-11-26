/**
 * Building round 2 on the server: house roofs (persisted params, legacy
 * tiles still load), clearing bushes / rocks (range, protection, caps, rate
 * limit, collision, regrowth, admin restore, persistence), facade signs
 * (moderation, owner edit), built seats (sit, occupancy, removal while
 * occupied, stand-up exit).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONFIG, PIECES, TREES, isWalkable, natureItem, type BuildPlacePayload, type BuildResultPayload, type PieceKind } from '@elsewhere/shared';
import { createPersistence } from '../src/persistence/index.js';
import { makeWorld, type World } from './helpers.js';

const H = { x0: -20, z0: -1, x1: -16, z1: 3 };
const STAND = { x: -18, z: 5.5 };
const gen = { capacity: 1000, refillPerSecond: 1000 };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

let req = 0;
function lastResult(w: World, sid: string): BuildResultPayload {
  const all = w.received(sid, 'build_result') as BuildResultPayload[];
  return all[all.length - 1]!;
}
async function place(w: World, sid: string, kind: PieceKind, x: number, z: number, rot = 0, level = 0, extra: Partial<BuildPlacePayload> = {}): Promise<BuildResultPayload> {
  await w.building!.place(w.ctx, sid, { reqId: ++req, kind, variant: PIECES[kind].variants[0]!.id, x, z, rot, level, ...extra });
  return lastResult(w, sid);
}
async function clear(w: World, sid: string, id: string): Promise<BuildResultPayload> {
  await w.building!.clear(w.ctx, sid, { reqId: ++req, id });
  return lastResult(w, sid);
}
async function walls(w: World, sid: string, level = 0): Promise<void> {
  for (let x = H.x0 + 1; x < H.x1; x += 2) {
    expect((await place(w, sid, 'wall', x, H.z0, 0, level)).ok).toBe(true);
    expect((await place(w, sid, x === H.x0 + 1 && level === 0 ? 'doorway' : 'wall', x, H.z1, 0, level)).ok).toBe(true);
  }
  for (let z = H.z0 + 1; z < H.z1; z += 2) {
    expect((await place(w, sid, 'wall', H.x0, z, 1, level)).ok).toBe(true);
    expect((await place(w, sid, 'wall', H.x1, z, 1, level)).ok).toBe(true);
  }
}
const roofParams = { w: 4, d: 4, style: 'gable', pitch: 1 };

describe('house roofs on the server', { timeout: 60_000 }, () => {
  it('one roof piece with its params, broadcast and persisted; legacy roof tiles still load', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-b2-'));
    dirs.push(dir);
    const w = await makeWorld({ persistence: createPersistence({ dataDir: dir }), building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    await walls(w, a);
    const r = await place(w, a, 'house_roof', -18, 1, 1, 1, { params: roofParams });
    expect(r).toMatchObject({ ok: true });
    const view = (w.received(a, 'build_placed').at(-1) as { piece: { params?: string } }).piece;
    expect(JSON.parse(view.params!)).toEqual({ w: 4, d: 4, s: 'gable', p: 1 });
    expect(await place(w, a, 'house_roof', -18, 1, 0, 1, { params: { ...roofParams, w: 40 } })).toMatchObject({ ok: false, reason: 'bad_params' });
    // A legacy roof tile row written by the first version (no params column value).
    await w.persistence.sql.write(
      `INSERT INTO build_pieces (world_id, id, kind, variant, x2, z2, rot, level, y, owner_id, owner_name, text, created_at) VALUES ('default','legacy1','roof_slope','terracotta',-40,40,0,1,5.2,'someone','Old',NULL,1)`,
    );
    await w.persistence.flush();
    await w.close();
    const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), building: { rate: gen } });
    const pieces = [...w2.building!.index.all()];
    expect(pieces.find((p) => p.kind === 'house_roof')?.params).toBe(JSON.stringify({ w: 4, d: 4, s: 'gable', p: 1 }));
    expect(pieces.find((p) => p.id === 'legacy1')).toMatchObject({ kind: 'roof_slope', x: -20, z: 20, level: 1 });
    const late = await w2.join('Late', STAND.x, STAND.z);
    const chunk = (w2.received(late, 'build_snapshot') as { pieces: unknown[][] }[])[0]!;
    expect(chunk.pieces.some((row) => row[10] === JSON.stringify({ w: 4, d: 4, s: 'gable', p: 1 }))).toBe(true);
    await w2.close();
  });
});

describe('clearing bushes and rocks', { timeout: 60_000 }, () => {
  it('clears within range on open land only; refuses trees, protected plants, repeats; caps per day; rate limited', async () => {
    const w = await makeWorld({ building: { rate: { capacity: 7, refillPerSecond: 0.001 }, clearDaily: 2 }, keepNature: true });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const tree = TREES.find((t) => Math.hypot(t.position.x - STAND.x, t.position.z - STAND.z) < 9)!;
    expect(await clear(w, a, tree?.id ?? TREES[0]!.id)).toMatchObject({ ok: false, reason: 'not_clearable' });
    expect(await clear(w, a, 'bush_64')).toMatchObject({ ok: false, reason: 'not_clearable' });
    expect(await clear(w, a, 'rock_21')).toMatchObject({ ok: false, reason: 'too_far' });
    expect(await clear(w, a, 'bush_37')).toMatchObject({ ok: true, action: 'clear' });
    expect(w.received(a, 'nature_cleared').at(-1)).toEqual({ ids: ['bush_37'], by: a });
    expect(await clear(w, a, 'bush_37')).toMatchObject({ ok: false, reason: 'already_cleared' });
    // Second clear of the day is fine, the third hits the daily cap.
    w.move(a, -20, 15);
    const near = ['bush_5', 'bush_79', 'bush_59'];
    expect(await clear(w, a, near[0]!)).toMatchObject({ ok: true });
    expect(await clear(w, a, near[1]!)).toMatchObject({ ok: false, reason: 'clear_cap' });
    // The bucket (shared with place/remove) is empty now.
    expect(await clear(w, a, near[2]!)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(w.building!.clearedList().map((c) => c.natureId).sort()).toEqual(['bush_37', 'bush_5']);
    expect(w.building!.clearedList()[0]!.profileId).toBe(w.ctx.getProfile(a)!.id);
    await w.close();
  });

  it('a cleared rock stops blocking movement on the server; the snapshot carries the cleared set', async () => {
    const w = await makeWorld({ building: { rate: gen }, keepNature: true });
    const rock = natureItem('rock_21')!;
    const a = await w.join('Ash', rock.position.x + 2, rock.position.z + 2);
    expect(isWalkable(rock.position, CONFIG.movement.playerRadius, w.collision)).toBe(false);
    expect(await clear(w, a, 'rock_21')).toMatchObject({ ok: true });
    expect(isWalkable(rock.position, CONFIG.movement.playerRadius, w.collision)).toBe(true);
    const late = await w.join('Late', rock.position.x + 3, rock.position.z + 2);
    expect((w.received(late, 'build_snapshot')[0] as { cleared: string[] }).cleared).toEqual(['rock_21']);
    await w.close();
  });

  it('regrows after the time unless something is built there; admin restores one or all of a profile; survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-b2n-'));
    dirs.push(dir);
    const regrowMs = 60 * 60_000;
    const w = await makeWorld({ persistence: createPersistence({ dataDir: dir }), building: { rate: gen, regrowMs }, keepNature: true });
    const a = await w.join('Ash', -18, -4);
    expect((await clear(w, a, 'bush_37')).ok).toBe(true);
    expect((await clear(w, a, 'bush_30')).ok).toBe(false); // too far from here
    w.move(a, -20, 15);
    expect((await clear(w, a, 'bush_5')).ok).toBe(true);
    expect((await clear(w, a, 'bush_79')).ok).toBe(true);
    // Build over bush_37's spot: it must not regrow there.
    w.move(a, -18, -4);
    expect((await place(w, a, 'wall', -16, -2, 1)).ok).toBe(true);
    expect(await w.building!.regrow()).toEqual([]); // too early
    w.clock.advance(regrowMs + 1000);
    const back = await w.building!.regrow();
    expect(back.sort()).toEqual(['bush_5', 'bush_79']);
    expect(w.received(a, 'nature_restored').at(-1)).toEqual({ ids: back, by: 'regrow' });
    expect(w.building!.clearedList().map((c) => c.natureId)).toEqual(['bush_37']);
    // Restart: bush_37 is still cleared.
    await w.persistence.flush();
    await w.close();
    const w2 = await makeWorld({ persistence: createPersistence({ dataDir: dir }), building: { rate: gen, regrowMs }, keepNature: true });
    expect(w2.building!.clearedList().map((c) => c.natureId)).toEqual(['bush_37']);
    // Admin: restore by id, then by profile.
    const b = await w2.join('Birch', -20, 15);
    expect((await clear(w2, b, 'bush_5')).ok).toBe(true);
    expect((await clear(w2, b, 'bush_79')).ok).toBe(true);
    expect(await w2.building!.adminRestoreNature({ ids: ['bush_5'] })).toEqual(['bush_5']);
    expect(await w2.building!.adminRestoreNature({ profileId: w2.ctx.getProfile(b)!.id })).toEqual(['bush_79']);
    expect(w2.received(b, 'nature_restored').at(-1)).toEqual({ ids: ['bush_79'], by: 'admin' });
    expect(await w2.building!.adminRestoreNature({ ids: ['nope'] })).toEqual([]);
    await w2.close();
  });
});

describe('facade name signs', { timeout: 60_000 }, () => {
  it('mount on your wall, are moderated, and only the owner edits the words', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    const b = await w.join('Birch', STAND.x + 1, STAND.z);
    await walls(w, a);
    expect(await place(w, a, 'name_board', -19, 3, 0, 0)).toMatchObject({ ok: false, reason: 'text_required' });
    expect(await place(w, a, 'name_board', -19, 3, 0, 0, { text: 'x'.repeat(25) })).toMatchObject({ ok: false, reason: 'text_too_long' });
    expect(await place(w, a, 'name_board', -19, 3, 1, 0, { text: 'Crooked' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await place(w, b, 'name_board', -19, 3, 0, 0, { text: 'Mine now' })).toMatchObject({ ok: false, reason: 'not_your_support' });
    const r = await place(w, a, 'name_board', -19, 3, 0, 0, { text: 'Shit  Shack' });
    expect(r.ok).toBe(true);
    expect(w.building!.index.get(r.pieceId!)!.text).toBe('S*** Shack');
    // Edit: owner yes (filtered, length-checked), others no.
    await w.building!.editText(w.ctx, b, { reqId: ++req, id: r.pieceId!, text: 'Birch was here' });
    expect(lastResult(w, b)).toMatchObject({ ok: false, reason: 'not_owner' });
    await w.building!.editText(w.ctx, a, { reqId: ++req, id: r.pieceId!, text: 'y'.repeat(30) });
    expect(lastResult(w, a)).toMatchObject({ ok: false, reason: 'text_too_long' });
    await w.building!.editText(w.ctx, a, { reqId: ++req, id: r.pieceId!, text: 'Fern Cottage' });
    expect(lastResult(w, a)).toMatchObject({ ok: true, action: 'edit' });
    expect((w.received(b, 'build_updated').at(-1) as { piece: { text: string } }).piece.text).toBe('Fern Cottage');
    expect((await w.persistence.sql.query<{ text: string }>('SELECT text FROM build_pieces WHERE id = $1', [r.pieceId!]))[0]!.text).toBe('Fern Cottage');
    const wall = await place(w, a, 'crate', -18.5, 7.5);
    expect(wall.ok).toBe(true);
    await w.building!.editText(w.ctx, a, { reqId: ++req, id: wall.pieceId!, text: 'Crate' });
    expect(lastResult(w, a)).toMatchObject({ ok: false, reason: 'not_text' });
    await w.moderation.sanction({ profileId: w.ctx.getProfile(a)!.id, kind: 'chat_mute', minutes: 5, reason: 't', createdBy: 'test' });
    await w.building!.editText(w.ctx, a, { reqId: ++req, id: r.pieceId!, text: 'Quiet' });
    expect(lastResult(w, a)).toMatchObject({ ok: false, reason: 'muted' });
    await w.close();
  });

  it('a named, roofed house with a doorway is news (World Memory), once', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', STAND.x, STAND.z);
    await walls(w, a);
    expect((await place(w, a, 'house_roof', -18, 1, 0, 1, { params: roofParams })).ok).toBe(true);
    expect((await place(w, a, 'name_board', -19, 3, 0, 0, { text: 'Fern Cottage' })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const named = (await w.memory.list({ limit: 50 })).filter((e) => e.kind === 'building_named');
    expect(named).toHaveLength(1);
    expect(named[0]!.data).toMatchObject({ name: 'Fern Cottage' });
    await w.close();
  });
});

describe('sitting on built seats', { timeout: 60_000 }, () => {
  it('sit, occupancy, no removal while occupied, admin removal stands them up, standing up exits beside it', async () => {
    const w = await makeWorld({ building: { rate: gen } });
    const a = await w.join('Ash', -18, 4);
    const b = await w.join('Birch', -17, 4.5);
    const c = await w.join('Cedar', -19, 4.5);
    const chair = await place(w, a, 'chair', -18, 6, 2);
    expect(chair.ok).toBe(true);
    const id = `bp:${chair.pieceId}`;
    const r1 = await w.interact(b, id);
    expect(r1).toMatchObject({ ok: true });
    const pb = w.ctx.getPlayer(b)!;
    expect(pb.seat).toBe(`${id}#0`);
    expect(pb.anim).toBe('sit');
    // One seat: Cedar is refused; the owner cannot remove it while Birch sits.
    expect(await w.interact(c, id)).toMatchObject({ ok: false, error: 'occupied' });
    await w.building!.remove(w.ctx, a, { reqId: ++req, id: chair.pieceId! });
    expect(lastResult(w, a)).toMatchObject({ ok: false, reason: 'occupied' });
    // Stand up (the existing stand path) → beside the chair, walkable.
    await w.interactions.stand(w.ctx, b);
    expect(pb.seat).toBe('');
    expect(isWalkable({ x: pb.x, z: pb.z }, CONFIG.movement.playerRadius, w.collision)).toBe(true);
    // Sit again; a moderator removes the chair: Birch is stood up.
    expect((await w.interact(b, id)).ok).toBe(true);
    await w.building!.adminRemove([chair.pieceId!]);
    expect(pb.seat).toBe('');
    expect(pb.anim).not.toBe('sit');
    // A bench seats two different people.
    const bench = await place(w, a, 'bench', -18, 7.5, 2);
    expect((await w.interact(b, `bp:${bench.pieceId}`)).ok).toBe(true);
    expect((await w.interact(c, `bp:${bench.pieceId}`)).ok).toBe(true);
    expect(new Set([w.ctx.getPlayer(b)!.seat, w.ctx.getPlayer(c)!.seat]).size).toBe(2);
    await w.close();
  });
});
