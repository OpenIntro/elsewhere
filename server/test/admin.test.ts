/**
 * Admin tools end-to-end: a real Colyseus server (WorldRoom + REST) on an
 * ephemeral port, real @colyseus/sdk clients, in-memory PGlite.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type Room } from '@colyseus/sdk';
import { CONFIG, INTERACTABLES, ROOM_NAME, isSeatInteractable, type ChatMessage } from '@elsewhere/shared';

const ADMIN = 'test-admin-token-0123456789';
process.env.ADMIN_TOKEN = ADMIN;

let base = '';
let stop: () => Promise<void> = async () => {};

beforeAll(async () => {
  // Import after setting env: ENV is read once at module load.
  const { defineRoom, defineServer } = await import('@colyseus/core');
  const { WebSocketTransport } = await import('@colyseus/ws-transport');
  const { createApiRouter } = await import('../src/http/api.js');
  const { WorldRoom } = await import('../src/rooms/WorldRoom.js');
  const { initServices } = await import('../src/services.js');
  const { createPersistence } = await import('../src/persistence/index.js');
  const svc = await initServices({ persistence: createPersistence({ dataDir: 'memory://' }) });
  const transport = new WebSocketTransport();
  const server = defineServer({ rooms: { [ROOM_NAME]: defineRoom(WorldRoom) }, transport, greet: false, gracefullyShutdown: false, express: (app) => app.use(createApiRouter()) });
  await server.listen(0);
  base = `http://localhost:${(transport.server!.address() as AddressInfo).port}`;
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

interface P {
  token: string;
  profileId: string;
  room: Room;
  left: Promise<number>;
  chat: ChatMessage[];
  notices: { code?: string }[];
}
async function player(name: string, token?: string): Promise<P> {
  const s = token ? { body: { token, profile: { profileId: '' } } } : await rest('/api/session/guest', { method: 'POST', body: { name } });
  const tok = token ?? s.body.token;
  const room = await new Client(base).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token: tok });
  const p: P = { token: tok, profileId: s.body.profile.profileId, room, left: new Promise((r) => room.onLeave((code) => r(code))), chat: [], notices: [] };
  room.onMessage('chat', (m: ChatMessage) => p.chat.push(m));
  room.onMessage('notice', (m: { code?: string }) => p.notices.push(m));
  room.onMessage('*', () => undefined);
  await new Promise((r) => setTimeout(r, 300));
  return p;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('admin tools (ADMIN_TOKEN)', { timeout: 60_000 }, () => {
  it('rejects missing or wrong admin tokens', async () => {
    expect((await rest('/api/admin/reports')).status).toBe(401);
    expect((await rest('/api/admin/reports', { token: 'nope' })).status).toBe(401);
    expect((await rest('/api/admin/reports', { token: ADMIN })).status).toBe(200);
  });

  it('kick disconnects exactly that player immediately (no reconnection grace)', async () => {
    const a = await player('Kicked');
    const b = await player('Stays');
    const before = await rest('/api/admin/players', { token: ADMIN });
    expect(before.body.players.map((x: { profileId: string }) => x.profileId)).toEqual(expect.arrayContaining([a.profileId, b.profileId]));
    const r = await rest('/api/admin/kick', { method: 'POST', token: ADMIN, body: { profileId: a.profileId, reason: 'test' } });
    expect(r.body).toEqual({ kicked: 1 });
    expect(await a.left).toBe(4003);
    await sleep(300);
    const after = (await rest('/api/admin/players', { token: ADMIN })).body.players.map((x: { profileId: string }) => x.profileId);
    expect(after).not.toContain(a.profileId);
    expect(after).toContain(b.profileId);
    expect(b.room.connection.isOpen).toBe(true);
    await b.room.leave();
  });

  it('ban kicks the player, refuses session resume and room join; revoking lifts it', async () => {
    const a = await player('Banned');
    const s = await rest('/api/admin/sanctions', { method: 'POST', token: ADMIN, body: { profileId: a.profileId, kind: 'ban', minutes: 30, reason: 'test ban' } });
    expect(s.status).toBe(200);
    expect(s.body.sanction).toMatchObject({ kind: 'ban', profileId: a.profileId });
    expect(s.body.sanction.expiresAt - s.body.sanction.createdAt).toBe(30 * 60_000);
    expect(await a.left).toBe(4003);
    expect((await rest('/api/session/guest', { method: 'POST', body: { token: a.token } })).status).toBe(403);
    await expect(new Client(base).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token: a.token })).rejects.toThrow(/suspended/);
    const active = await rest('/api/admin/sanctions?active=1', { token: ADMIN });
    expect(active.body.sanctions.some((x: { id: string }) => x.id === s.body.sanction.id)).toBe(true);
    expect((await rest(`/api/admin/sanctions/${s.body.sanction.id}`, { method: 'DELETE', token: ADMIN })).status).toBe(200);
    const again = await player('Banned', a.token);
    expect(again.room.connection.isOpen).toBe(true);
    await again.room.leave();
  });

  it('timed chat-mute via admin silences chat server-side for its duration', async () => {
    const a = await player('Muted');
    const b = await player('Listener');
    const s = await rest('/api/admin/sanctions', { method: 'POST', token: ADMIN, body: { profileId: a.profileId, kind: 'chat_mute', minutes: 1, reason: 'cool down' } });
    expect(s.body.sanction.expiresAt - s.body.sanction.createdAt).toBe(60_000);
    a.room.send('chat', { channel: 'global', text: 'can you hear me' });
    await sleep(400);
    expect(b.chat.map((m) => m.text)).not.toContain('can you hear me');
    expect(a.notices.some((n) => n.code === 'chat_muted')).toBe(true);
    await a.room.leave();
    await b.room.leave();
  });

  it('validates sanction input', async () => {
    expect((await rest('/api/admin/sanctions', { method: 'POST', token: ADMIN, body: { profileId: 'nobody', kind: 'ban' } })).status).toBe(404);
    expect((await rest('/api/admin/sanctions', { method: 'POST', token: ADMIN, body: { kind: 'ban' } })).status).toBe(400);
    expect((await rest('/api/admin/kick', { method: 'POST', token: ADMIN, body: {} })).status).toBe(400);
  });
});

describe('emotes while seated (live server, two clients)', { timeout: 60_000 }, () => {
  it('a seated player can wave; the other client sees wave then sit; the seat stays held; dance is refused', async () => {
    const a = await player('Sitter');
    const b = await player('Watcher');
    const me = () => a.room.state.players.get(a.room.sessionId);
    const seen = () => b.room.state.players.get(a.room.sessionId);
    // Walk (server-validated moves) halfway to the nearest seat, then sit.
    const start = { x: me().x, z: me().z };
    const seat = INTERACTABLES.filter(isSeatInteractable).sort((p, q) => Math.hypot(p.position.x - start.x, p.position.z - start.z) - Math.hypot(q.position.x - start.x, q.position.z - start.z))[0]!;
    for (let k = 1; k <= 10; k++) {
      const t = (k / 10) * 0.5;
      a.room.send('move', { x: start.x + (seat.position.x - start.x) * t, z: start.z + (seat.position.z - start.z) * t, rot: 0, anim: 'walk', seq: k });
      await sleep(70);
    }
    await sleep(200);
    const results: { id: string; ok: boolean; error?: string }[] = [];
    a.room.onMessage('interact_result', (r: { id: string; ok: boolean; error?: string }) => results.push(r));
    const errors: { code: string; inResponseTo?: string }[] = [];
    a.room.onMessage('error', (e: { code: string; inResponseTo?: string }) => errors.push(e));
    a.room.send('interact', { id: seat.id });
    await sleep(400);
    expect(results.at(-1)).toMatchObject({ id: seat.id, ok: true });
    expect(seen().anim).toBe('sit');
    const seatRef = seen().seat;
    expect(seatRef).toMatch(new RegExp(`^${seat.id}#\\d$`));

    // Record what B observes for A's anim.
    // Sample the baseline synchronously BEFORE sending: the first interval tick
    // fires 20 ms later, and a 20 Hz patch can already carry 'wave' by then.
    const observed: string[] = [];
    const sample = () => {
      const anim = seen()?.anim;
      if (anim && observed.at(-1) !== anim) observed.push(anim);
    };
    sample();
    const t0 = Date.now();
    const poll = setInterval(sample, 20);
    a.room.send('emote', { emote: 'wave' });
    await sleep(CONFIG.emotes.waveDurationMs + 500);
    clearInterval(poll);
    expect(observed).toEqual(['sit', 'wave', 'sit']);
    expect(seen().seat).toBe(seatRef);
    expect(Date.now() - t0).toBeGreaterThan(CONFIG.emotes.waveDurationMs);

    a.room.send('emote', { emote: 'dance' });
    await sleep(300);
    expect(errors.at(-1)).toMatchObject({ code: 'forbidden', inResponseTo: 'emote' });
    expect(seen().anim).toBe('sit');
    expect(seen().seat).toBe(seatRef);

    // Standing up, a wave reverts to idle.
    a.room.send('stand', {});
    await sleep(300);
    expect(seen().seat).toBe('');
    a.room.send('emote', { emote: 'wave' });
    await sleep(150);
    expect(seen().anim).toBe('wave');
    await sleep(CONFIG.emotes.waveDurationMs + 300);
    expect(seen().anim).toBe('idle');
    await a.room.leave();
    await b.room.leave();
  });
});
