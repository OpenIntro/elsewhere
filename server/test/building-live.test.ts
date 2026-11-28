/**
 * Player building over the wire: a real Colyseus server (WorldRoom + REST)
 * on an ephemeral port, real @colyseus/sdk clients, in-memory PGlite.
 * Covers what only the live path shows: messages are routed and answered,
 * forged requests from a modified client are refused, movement validation
 * honours walls, Unstuck, the snapshot re-sync and the ADMIN_TOKEN routes.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { CONFIG, PIECES, ROOM_NAME, type BuildPlacePayload, type BuildResultPayload, type BuildSnapshotPayload, type PieceKind } from '@elsewhere/shared';

const ADMIN = 'test-admin-token-building-0123';
process.env.ADMIN_TOKEN = ADMIN;
/** Open meadow west of the Town Square (scripts/lib/cottage.mjs SITE). */
const SITE = { x: -18, z: 1 };

let base = '';
let stop: () => Promise<void> = async () => {};
let teleport: (sid: string, x: number, z: number) => void = () => undefined;

beforeAll(async () => {
  const { defineRoom, defineServer } = await import('@colyseus/core');
  const { WebSocketTransport } = await import('@colyseus/ws-transport');
  const { createApiRouter } = await import('../src/http/api.js');
  const { WorldRoom } = await import('../src/rooms/WorldRoom.js');
  const { roomRegistry } = await import('../src/rooms/RoomContext.js');
  const { initServices } = await import('../src/services.js');
  const { createPersistence } = await import('../src/persistence/index.js');
  const svc = await initServices({ persistence: createPersistence({ dataDir: 'memory://' }) });
  const transport = new WebSocketTransport();
  const server = defineServer({ rooms: { [ROOM_NAME]: defineRoom(WorldRoom) }, transport, greet: false, gracefullyShutdown: false, express: (app) => app.use(createApiRouter()) });
  await server.listen(0);
  base = `http://localhost:${(transport.server!.address() as AddressInfo).port}`;
  // Test setup only: put a player next to the site (the room's own teleport, as Unstuck uses).
  teleport = (sid, x, z) => {
    for (const ctx of roomRegistry) if (ctx.getPlayer(sid)) ctx.teleport(sid, x, z);
  };
  stop = async () => {
    await server.gracefullyShutdown(false);
    svc.gazette.stop();
    await svc.persistence.close();
  };
}, 60_000);
afterAll(() => stop(), 60_000);

async function rest(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await sleep(25);
  }
}

interface P {
  token: string;
  profileId: string;
  room: Room;
  results: BuildResultPayload[];
  snapshots: BuildSnapshotPayload[];
  placed: { piece: { id: string; kind: string } }[];
  removed: { ids: string[]; by: string }[];
  notices: { code?: string }[];
}
async function player(name: string, token?: string): Promise<P> {
  const s = token ? null : await rest('/api/session/guest', { method: 'POST', body: { name } });
  const tok = token ?? s!.body.token;
  const room = await new Client(base).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token: tok });
  const p: P = { token: tok, profileId: s?.body.profile.profileId ?? '', room, results: [], snapshots: [], placed: [], removed: [], notices: [] };
  room.onMessage('build_result', (m: BuildResultPayload) => p.results.push(m));
  room.onMessage('build_snapshot', (m: BuildSnapshotPayload) => p.snapshots.push(m));
  room.onMessage('build_placed', (m: { piece: { id: string; kind: string } }) => p.placed.push(m));
  room.onMessage('build_removed', (m: { ids: string[]; by: string }) => p.removed.push(m));
  room.onMessage('notice', (m: { code?: string }) => p.notices.push(m));
  room.onMessage('*', () => undefined);
  await until(() => p.snapshots.some((c) => c.done));
  return p;
}
let req = 0;
async function place(p: P, kind: PieceKind, x: number, z: number, extra: Partial<BuildPlacePayload> = {}): Promise<BuildResultPayload> {
  const reqId = ++req;
  p.room.send('build_place', { reqId, kind, variant: PIECES[kind]?.variants[0]!.id ?? 'x', x, z, rot: 0, level: 0, ...extra });
  await until(() => p.results.some((r) => r.reqId === reqId));
  return p.results.find((r) => r.reqId === reqId)!;
}
async function remove(p: P, id: unknown): Promise<BuildResultPayload> {
  const reqId = ++req;
  p.room.send('build_remove', { reqId, id });
  await until(() => p.results.some((r) => r.reqId === reqId));
  return p.results.find((r) => r.reqId === reqId)!;
}
const me = (p: P) => p.room.state.players.get(p.room.sessionId) as { x: number; z: number };

describe('building over the wire', { timeout: 60_000 }, () => {
  it('places and broadcasts; refuses forged and out-of-rules requests from a modified client', async () => {
    const a = await player('Ash');
    const b = await player('Birch');
    teleport(a.room.sessionId, SITE.x, SITE.z + 4);
    teleport(b.room.sessionId, SITE.x - 1, SITE.z + 4);
    await sleep(200);
    const wall = await place(a, 'wall', SITE.x, SITE.z);
    expect(wall).toMatchObject({ ok: true, action: 'place' });
    await until(() => b.placed.some((m) => m.piece.id === wall.pieceId));
    // B (a modified client) tries to remove A's wall, with junk, and a non-existent id.
    expect(await remove(b, wall.pieceId)).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(await remove(b, { $ne: null })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await remove(b, 'p-does-not-exist')).toMatchObject({ ok: false, reason: 'not_found' });
    // Forged placements: off grid, from too far, in the Town Square, on top of A, a fake kind.
    expect(await place(b, 'crate', SITE.x + 0.3, SITE.z + 2)).toMatchObject({ ok: false, reason: 'off_grid' });
    expect(await place(b, 'crate', SITE.x - 30, SITE.z)).toMatchObject({ ok: false, reason: 'too_far' });
    teleport(b.room.sessionId, -4, 9);
    await sleep(150);
    const sq = await place(b, 'crate', -2, 6);
    expect(sq).toMatchObject({ ok: false, reason: 'protected' });
    expect(sq.message).toMatch(/Town Square/);
    teleport(b.room.sessionId, SITE.x - 1, SITE.z + 4);
    await sleep(150);
    const onA = me(a);
    expect(await place(b, 'wall', Math.round(onA.x), Math.round(onA.z))).toMatchObject({ ok: false, reason: 'player_in_way' });
    expect(await place(b, 'castle' as PieceKind, SITE.x + 3, SITE.z)).toMatchObject({ ok: false, reason: 'unknown_piece' });
    // Nothing of that was broadcast; the wall still stands.
    expect(a.placed).toHaveLength(1);
    expect(b.removed).toHaveLength(0);
    // The owner can remove it; everyone sees it go.
    expect(await remove(a, wall.pieceId)).toMatchObject({ ok: true });
    await until(() => b.removed.some((m) => m.ids.includes(wall.pieceId!)));
    await a.room.leave();
    await b.room.leave();
  });

  it('a wall blocks server-validated movement; Unstuck carries a walled-in player to the Town Square', async () => {
    const a = await player('Mason');
    const sid = a.room.sessionId;
    teleport(sid, SITE.x - 1.2, SITE.z + 1);
    await sleep(200);
    // A ring of walls around a 2 x 2 m cell next to the player (who stands outside it).
    const w = await place(a, 'wall', SITE.x, SITE.z, { rot: 1 });
    expect(w).toMatchObject({ ok: true });
    // Walk east into the wall with real move messages: the server stops A west of it.
    const start = me(a);
    for (let k = 1; k <= 12; k++) {
      a.room.send('move', { x: start.x + k * 0.25, z: start.z, rot: Math.PI / 2, anim: 'walk', seq: 1000 + k });
      await sleep(70);
    }
    await sleep(300);
    expect(me(a).x).toBeLessThan(SITE.x - 0.12 - CONFIG.movement.playerRadius + 0.01);
    // Unstuck: back to the Town Square, with a notice.
    a.room.send('unstuck', {});
    await until(() => a.notices.some((n) => n.code === 'unstuck'));
    await sleep(150);
    expect(Math.hypot(me(a).x, me(a).z - 2)).toBeLessThan(9);
    // Rate limited: a second Unstuck right away is refused.
    a.room.send('unstuck', {});
    await sleep(300);
    expect(a.notices.filter((n) => n.code === 'unstuck')).toHaveLength(1);
    await a.room.leave();
  });

  it('build_sync re-sends the full snapshot (after an automatic reconnection)', async () => {
    const a = await player('Syncer');
    const n = a.snapshots.length;
    a.room.send('build_sync', {});
    await until(() => a.snapshots.length > n && a.snapshots.at(-1)!.done);
    const total = a.snapshots.at(-1)!.total;
    const listed = await rest('/api/admin/build/pieces?limit=5000', { token: ADMIN });
    expect(total).toBe(listed.body.total);
    await a.room.leave();
  });

  it('ADMIN_TOKEN routes: list, remove one piece (with what rests on it), remove all of a profile, stats', async () => {
    const a = await player('Ivy');
    const b = await player('Watcher');
    const S = { x: SITE.x, z: SITE.z - 4 };
    teleport(a.room.sessionId, S.x + 1.5, S.z + 2);
    teleport(b.room.sessionId, S.x + 1.5, S.z + 2.8);
    await sleep(200);
    const base0 = await place(a, 'wall', S.x, S.z);
    const top = await place(a, 'wall', S.x, S.z, { level: 1 });
    const crate = await place(a, 'crate', S.x + 2.5, S.z + 2.5);
    expect([base0, top, crate].map((r) => r.reason ?? 'ok')).toEqual(['ok', 'ok', 'ok']);
    expect((await rest('/api/admin/build/pieces')).status).toBe(401);
    const list = await rest(`/api/admin/build/pieces?owner=${a.profileId}`, { token: ADMIN });
    expect(list.body.pieces.map((p: { id: string }) => p.id).sort()).toEqual([base0.pieceId, top.pieceId, crate.pieceId].sort());
    expect((await rest('/api/admin/build/pieces/nope', { method: 'DELETE', token: ADMIN })).status).toBe(404);
    const del = await rest(`/api/admin/build/pieces/${base0.pieceId}`, { method: 'DELETE', token: ADMIN });
    expect(del.body.removed.sort()).toEqual([base0.pieceId, top.pieceId].sort());
    await until(() => b.removed.some((m) => m.by === 'admin' && m.ids.includes(top.pieceId!)));
    const all = await rest(`/api/admin/build/profiles/${a.profileId}`, { method: 'DELETE', token: ADMIN });
    expect(all.body.removed).toEqual([crate.pieceId]);
    const stats = await rest('/api/admin/build/stats?bench=1', { token: ADMIN });
    expect(stats.body).toMatchObject({ pieces: expect.any(Number), validation: { count: expect.any(Number) } });
    // A build ban (admin sanction) stops building but not playing.
    await rest('/api/admin/sanctions', { method: 'POST', token: ADMIN, body: { profileId: a.profileId, kind: 'build_ban', minutes: 5, reason: 'test' } });
    expect(await place(a, 'crate', S.x + 2.5, S.z + 2.5)).toMatchObject({ ok: false, reason: 'banned' });
    expect(a.room.connection.isOpen).toBe(true);
    await a.room.leave();
    await b.room.leave();
  });

  it('reporting a builder by profile goes through the report flow', async () => {
    const a = await player('Reported');
    const b = await player('Reporter');
    b.room.send('report', { target: '', profileId: a.profileId, reason: 'inappropriate_content', details: 'Built piece p1 (Sign) at 1,2, sign text: "rude"' });
    await sleep(400);
    const reports = await rest('/api/admin/reports?limit=5', { token: ADMIN });
    expect(reports.body.reports.some((r: { targetProfileId?: string; details?: string }) => r.targetProfileId === a.profileId && /Sign/.test(r.details ?? ''))).toBe(true);
    await a.room.leave();
    await b.room.leave();
  });
});
