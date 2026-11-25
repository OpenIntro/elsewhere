#!/usr/bin/env node
/**
 * Multi-client server integration test (Node + @colyseus/sdk, no browser).
 * Runs against an ALREADY RUNNING server started with an admin token and
 * small fountain thresholds (the portal needs no override: the default
 * CONFIG.collective.portalRunesRequired is 2), e.g.:
 *
 *   PORT=2601 DATA_DIR=/tmp/elsewhere-it ADMIN_TOKEN=integration-admin-token \
 *   FOUNTAIN_STAGES=2,4 FOUNTAIN_STAGE_DISTINCT=2,3 \
 *   npx tsx --conditions=source server/src/index.ts
 *
 *   node scripts/server-integration.mjs [url] [--save state.json]
 *   node scripts/server-integration.mjs [url] --verify-restart state.json
 *
 * Requires shared/dist (npm run typecheck or npm run build -w shared) for the
 * collision helpers used by the path-finding walker.
 *
 * Phase 1 demonstrates: global chat delivered; proximity delivered in range and
 * NOT out of range; whisper private; blocked sender not delivered; seat
 * conflict; bell broadcast; fountain NOT advanced by one player spamming but
 * advanced by distinct players; portal awakened by two clients at the runes;
 * a Gazette issue built from those real events. With --save, writes what the
 * restart check needs. Phase 2 (--verify-restart) checks everything persisted.
 */
import fs from 'node:fs';
import { Client } from '@colyseus/sdk';
import { C2S, CONFIG, ROOM_NAME, S2C, getInteractable, isWalkable } from '@elsewhere/shared';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a) => /^https?:/.test(a)) ?? process.env.IT_URL ?? 'http://localhost:2601';
const adminToken = process.env.ADMIN_TOKEN ?? 'integration-admin-token';
const savePath = flag('--save');
const verifyPath = flag('--verify-restart');

let failures = 0;
const log = (...a) => console.log('[it]', ...a);
const check = (cond, label, extra) => {
  if (cond) console.log(`  PASS ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rest(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ---------------------------------------------------------------------------
// Player wrapper: inbox per message type + an A* walker over shared collision.
// ---------------------------------------------------------------------------

class Player {
  constructor(name) {
    this.name = name;
    this.inbox = new Map();
    this.seq = 0;
  }
  async connect(token) {
    const session = await rest('/api/session/guest', { method: 'POST', body: token ? { token } : { name: this.name } });
    this.token = session.token;
    this.profileId = session.profile.profileId;
    this.client = new Client(url);
    this.room = await this.client.joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token: this.token, name: this.name });
    for (const type of Object.values(S2C)) this.room.onMessage(type, (p) => this.push(type, p));
    this.welcome = await this.next(S2C.welcome, () => true, 5000);
    this.sid = this.welcome.sessionId;
    await this.until(() => this.me(), 'own player state');
    return this;
  }
  push(type, p) {
    if (!this.inbox.has(type)) this.inbox.set(type, []);
    this.inbox.get(type).push(p);
    if (type === S2C.correction && this.pos) this.pos = { x: p.x, z: p.z };
  }
  got(type, pred = () => true) {
    return (this.inbox.get(type) ?? []).filter(pred);
  }
  clear(type) {
    this.inbox.delete(type);
  }
  async next(type, pred = () => true, timeout = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const hit = this.got(type, pred)[0];
      if (hit) return hit;
      await sleep(25);
    }
    return null;
  }
  async until(fn, label, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(25);
    }
    throw new Error(`${this.name}: timed out waiting for ${label}`);
  }
  me() {
    return this.room.state.players?.get(this.sid);
  }
  obj(id) {
    return this.room.state.objects?.get(id);
  }
  send(type, payload) {
    this.room.send(type, payload);
  }
  async interact(id, action, retry = true) {
    this.clear(S2C.interactResult);
    this.send(C2S.interact, action === undefined ? { id } : { id, action });
    const r = await this.next(S2C.interactResult, (x) => x.id === id, 3000);
    if (retry && r?.error === 'too_far') {
      // The walker's view can lag the server by a patch; step closer once and retry.
      log(`   (${this.name}: ${id} too far, stepping closer)`);
      await this.walkToInteractable(id, 0.8);
      return this.interact(id, action, false);
    }
    return r;
  }
  /** Walk (server-validated moves) until within `range` of the target point. */
  async walkTo(target, range = 1.2) {
    const me = this.me();
    this.pos = { x: me.x, z: me.z };
    const path = findPath(this.pos, target, range);
    if (!path) throw new Error(`${this.name}: no path to ${JSON.stringify(target)}`);
    const step = 0.38; // 0.38 m @ 15 Hz ≈ 5.7 m/s (< run speed)
    for (const wp of path) {
      for (let guard = 0; guard < 400; guard++) {
        const dx = wp.x - this.pos.x;
        const dz = wp.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.05) break;
        const k = Math.min(1, step / d);
        this.pos = { x: this.pos.x + dx * k, z: this.pos.z + dz * k };
        this.send(C2S.move, { x: this.pos.x, z: this.pos.z, rot: Math.atan2(dx, dz), anim: 'run', seq: ++this.seq });
        await sleep(1000 / 15);
      }
    }
    this.send(C2S.move, { x: this.pos.x, z: this.pos.z, rot: 0, anim: 'idle', seq: ++this.seq });
    await sleep(250);
    const now = this.me();
    return Math.hypot(now.x - target.x, now.z - target.z);
  }
  async walkToInteractable(id, margin = 0.3) {
    const it = getInteractable(id);
    const r = (it.radius ?? CONFIG.interaction.radius) - margin;
    const d = await this.walkTo(it.position, r);
    if (d > r + CONFIG.interaction.serverSlack) throw new Error(`${this.name}: could not reach ${id} (d=${d.toFixed(2)})`);
  }
  async leave() {
    await this.room.leave(true).catch(() => undefined);
  }
}

/** A* on a 0.5 m grid using the shared collision world (same rules as the server). */
function findPath(from, to, range) {
  const G = 0.5;
  const key = (i, j) => `${i},${j}`;
  const cell = (p) => [Math.round(p.x / G), Math.round(p.z / G)];
  const pt = (i, j) => ({ x: i * G, z: j * G });
  const radius = CONFIG.movement.playerRadius + 0.12;
  const walk = new Map();
  const ok = (i, j) => {
    const k = key(i, j);
    if (!walk.has(k)) walk.set(k, isWalkable(pt(i, j), radius));
    return walk.get(k);
  };
  const [si, sj] = cell(from);
  const h = (i, j) => Math.hypot(i * G - to.x, j * G - to.z);
  const open = [[h(si, sj), 0, si, sj]];
  const came = new Map([[key(si, sj), null]]);
  const cost = new Map([[key(si, sj), 0]]);
  let iter = 0;
  while (open.length && iter++ < 400_000) {
    let bi = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[bi][0]) bi = n;
    const [, g, i, j] = open.splice(bi, 1)[0];
    if (h(i, j) <= range) {
      const out = [];
      for (let k = key(i, j); k; k = came.get(k)) {
        const [a, b] = k.split(',').map(Number);
        out.unshift(pt(a, b));
      }
      return out;
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (!ok(ni, nj) || (di && dj && (!ok(i + di, j) || !ok(i, j + dj)))) continue;
      const ng = g + Math.hypot(di, dj) * G;
      const k = key(ni, nj);
      if (ng < (cost.get(k) ?? Infinity)) {
        cost.set(k, ng);
        came.set(k, key(i, j));
        open.push([ng + h(ni, nj), ng, ni, nj]);
      }
    }
  }
  return null;
}

const chatTexts = (p, channel) => p.got(S2C.chat, (m) => !channel || m.channel === channel).map((m) => m.text);

// ---------------------------------------------------------------------------

async function phaseOne() {
  const world = await rest('/api/world');
  const fountainRule = world.rules.find((r) => r.id === 'fountain');
  log('server rules:', JSON.stringify(fountainRule.stages), 'fountain stage now', world.fountainStage, 'portal awakenings', world.portalAwakenings);
  if (fountainRule.stages[world.fountainStage]?.distinct > 2) throw new Error('Start the server with FOUNTAIN_STAGES=2,4 FOUNTAIN_STAGE_DISTINCT=2,3 (see header)');

  const A = await new Player('Alder').connect();
  const B = await new Player('Birch').connect();
  log(`joined: ${A.name}=${A.sid} ${B.name}=${B.sid}`);

  log('1. global chat + proximity in range');
  A.send(C2S.chat, { channel: 'global', text: 'hello island @Birch' });
  const g = await B.next(S2C.chat, (m) => m.text === 'hello island @Birch');
  check(!!g && g.channel === 'global' && g.mentions.includes('birch'), 'global chat delivered to B (with mention)');
  A.send(C2S.chat, { channel: 'proximity', text: 'near the fountain' });
  check(!!(await B.next(S2C.chat, (m) => m.text === 'near the fountain')), 'proximity chat delivered to B within radius');

  log('2. fountain: one player spamming does not advance it');
  const stage0 = A.obj('fountain').value;
  await A.walkToInteractable('fountain');
  for (let i = 0; i < 6; i++) {
    await A.interact('fountain');
    await sleep(350);
  }
  await sleep(300);
  check(A.obj('fountain').value === stage0, `fountain stays at stage ${stage0} after 6 touches by ${A.name}`, A.obj('fountain').value);
  log('   ...a second distinct player touches it');
  await B.walkToInteractable('fountain');
  A.clear(S2C.worldEvent);
  await B.interact('fountain');
  const fe = await A.next(S2C.worldEvent, (e) => e.event.kind === 'fountain_transformed', 4000);
  await A.until(() => A.obj('fountain').value === stage0 + 1, 'fountain stage in synced state', 2000).catch(() => null);
  check(A.obj('fountain').value === stage0 + 1, `fountain advanced to stage ${stage0 + 1} via distinct players`, A.obj('fountain').value);
  check(!!fe && fe.event.actors.some((x) => x.name === 'Alder') && fe.event.actors.some((x) => x.name === 'Birch'), 'fountain_transformed world event credits both players', fe?.event);

  log('3. sitting conflict');
  await A.walkToInteractable('chair_cafe_1a');
  await B.walkToInteractable('chair_cafe_1a');
  const sitA = await A.interact('chair_cafe_1a');
  await A.until(() => A.me().seat === 'chair_cafe_1a#0', 'A seated in synced state', 2000).catch(() => null);
  const sitB = await B.interact('chair_cafe_1a');
  check(sitA?.ok === true && A.me().seat === 'chair_cafe_1a#0', 'A sits on the chair', sitA);
  check(sitB?.ok === false && sitB.error === 'occupied', 'B is refused: occupied', sitB);
  A.send(C2S.stand, {});
  await A.until(() => A.me().seat === '' && A.obj('chair_cafe_1a').value === 0, 'A stands');
  check(A.obj('chair_cafe_1a').value === 0, 'seat freed after standing');

  log('4. bell broadcast');
  await A.walkToInteractable('bell_town_hall');
  B.clear(S2C.objectEvent);
  const ring = await A.interact('bell_town_hall');
  const heard = await B.next(S2C.objectEvent, (e) => e.kind === 'bell_rung' && e.by === A.sid);
  check(ring?.ok === true && !!heard, 'B receives bell_rung object event from A', heard);
  check((await A.interact('bell_town_hall'))?.error === 'cooldown', 'immediate re-ring is on cooldown');

  log('5. portal: two players light two runes together');
  await Promise.all([A.walkToInteractable('rune_1'), B.walkToInteractable('rune_2')]);
  const r1 = await A.interact('rune_1');
  await A.until(() => A.obj('rune_1').active, 'rune_1 lit in synced state', 2000).catch(() => null);
  check(r1?.ok === true && A.obj('rune_1').active === true && A.obj('rune_1').holder === A.sid, 'rune_1 lit by A (synced active + holder)');
  check(!A.obj('portal_arch').active, 'portal still dormant with one rune');
  A.clear(S2C.worldEvent);
  const r2 = await B.interact('rune_2');
  check(r2?.ok === true, 'rune_2 lit by B');
  await A.until(() => A.obj('portal_arch').active, 'portal awake in synced state', 3000).catch(() => null);
  check(A.obj('portal_arch').active === true, 'portal_arch.active = true for everyone');
  const pe = await A.next(S2C.worldEvent, (e) => e.event.kind === 'portal_awakened', 3000);
  check(!!pe && pe.event.actors.length === 2, 'portal_awakened world event credits both players', pe?.event);

  log('6. B steps through the arch → far away; proximity out of range');
  await B.walkToInteractable('portal_arch');
  const arch = getInteractable('portal_arch');
  log(`   B at (${B.me().x.toFixed(2)}, ${B.me().z.toFixed(2)}), arch at (${arch.position.x.toFixed(2)}, ${arch.position.z.toFixed(2)}), d=${Math.hypot(B.me().x - arch.position.x, B.me().z - arch.position.z).toFixed(2)}`);
  const through = await B.interact('portal_arch');
  await B.until(() => B.me().z > 50, 'B carried to the dock', 3000).catch(() => null);
  check(through?.ok === true && !through.ui, 'awake arch accepts B (no dormant text)', through);
  const d = Math.hypot(A.me().x - B.me().x, A.me().z - B.me().z);
  check(d > CONFIG.chat.proximityRadius, `players now ${d.toFixed(0)} m apart (> ${CONFIG.chat.proximityRadius})`);
  B.clear(S2C.chat);
  A.send(C2S.chat, { channel: 'proximity', text: 'can anyone hear me out here' });
  await sleep(600);
  check(!chatTexts(B).includes('can anyone hear me out here'), 'proximity chat NOT delivered out of range');
  check(chatTexts(A).includes('can anyone hear me out here'), 'sender still sees own proximity line');

  log('7. whisper privacy + block');
  const C = await new Player('Cedar').connect();
  await sleep(300);
  A.send(C2S.whisper, { to: B.sid, text: 'secret for birch' });
  check(!!(await B.next(S2C.chat, (m) => m.text === 'secret for birch' && m.channel === 'private')), 'whisper delivered to B');
  await sleep(300);
  check(!chatTexts(C).includes('secret for birch'), 'whisper NOT delivered to C');
  B.send(C2S.block, { target: A.sid });
  check(!!(await B.next(S2C.moderation, (m) => m.action === 'blocked')), 'B blocked A (ack)');
  B.clear(S2C.chat);
  C.clear(S2C.chat);
  await sleep(2100); // chat bucket refill
  A.send(C2S.chat, { channel: 'global', text: 'is anyone listening' });
  check(!!(await C.next(S2C.chat, (m) => m.text === 'is anyone listening')), 'global from A delivered to C');
  await sleep(300);
  check(!chatTexts(B).includes('is anyone listening'), 'global from blocked A NOT delivered to B');
  A.send(C2S.whisper, { to: B.sid, text: 'let me in' });
  check((await A.next(S2C.error, (e) => e.code === 'blocked'))?.code === 'blocked', 'whisper to a blocker is refused');

  log('8. gazette compiled from these real events');
  const { issue } = await rest('/api/admin/gazette/compile', { method: 'POST', token: adminToken, body: {} });
  check(!!issue, 'admin compile produced an issue');
  const memory = await rest('/api/memory?limit=200');
  const realIds = new Set(memory.events.map((e) => e.id));
  const allIds = issue ? issue.articles.flatMap((a) => a.eventIds) : [];
  check(allIds.length > 0 && allIds.every((id) => realIds.has(id)), 'every article eventId is a real World Memory event');
  const tpl = issue ? issue.articles.map((a) => a.templateId) : [];
  check(tpl.includes('fountain_transformed'), 'issue reports the fountain transformation', tpl);
  check(tpl.some((t) => t.startsWith('portal_awakened')), 'issue reports the portal awakening', tpl);
  const body = issue ? issue.articles.map((a) => `${a.headline}: ${a.body}`).join('\n') : '';
  check(/Alder/.test(body) && /Birch/.test(body), 'articles name the real participants');
  if (issue) log(`   ${issue.title}\n   ` + body.split('\n').join('\n   '));

  const me = await rest('/api/profile', { token: A.token });
  const state = {
    tokens: { A: A.token, B: B.token },
    profileIds: { A: A.profileId, B: B.profileId },
    names: { A: A.name, B: B.name },
    fountainStage: A.obj('fountain').value,
    portalAwake: A.obj('portal_arch').active,
    portalAwakenings: A.obj('portal_arch').value,
    bellRings: A.obj('bell_town_hall').value,
    eventCount: memory.events.length,
    latestEventId: memory.events[0]?.id,
    gazetteIssueId: issue?.id,
    clockEpoch: A.room.state.clockEpoch,
    dayLengthMs: A.room.state.dayLengthMs,
    serverTime: Date.now(),
    lastPosition: { x: A.me().x, z: A.me().z },
    profileA: me.profile,
  };
  await Promise.all([A.leave(), B.leave(), C.leave()]);
  if (savePath) {
    fs.writeFileSync(savePath, JSON.stringify(state, null, 2));
    log(`saved state for the restart check → ${savePath}`);
  }
  log('BEFORE restart:', JSON.stringify({ fountainStage: state.fountainStage, portalAwake: state.portalAwake, portalAwakenings: state.portalAwakenings, bellRings: state.bellRings, events: state.eventCount, gazette: state.gazetteIssueId, clockEpoch: state.clockEpoch, profileA: { id: me.profile.profileId, name: me.profile.name, visits: me.profile.visits, inventory: me.profile.inventory } }));
}

async function phaseTwo(file) {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  log('verifying persistence after restart, using', file);
  const resumed = await rest('/api/session/guest', { method: 'POST', body: { token: before.tokens.A } });
  check(resumed.profile.profileId === before.profileIds.A, 'guest token resumes the same profile', resumed.profile.profileId);
  const A = await new Player(before.names.A).connect(before.tokens.A);
  check(A.welcome.profile.profileId === before.profileIds.A && A.welcome.profile.name === before.names.A, 'joined room as the same profile/name');
  check(A.welcome.profile.visits > before.profileA.visits, `visits continued (${before.profileA.visits} → ${A.welcome.profile.visits})`);
  const dPos = Math.hypot(A.me().x - before.lastPosition.x, A.me().z - before.lastPosition.z);
  check(dPos < 1.5, `spawned at last position (Δ ${dPos.toFixed(2)} m)`);
  check(A.obj('fountain').value === before.fountainStage && A.welcome.world.fountainStage === before.fountainStage, `fountain stage persisted (${before.fountainStage})`);
  check(A.obj('portal_arch').active === before.portalAwake && A.obj('portal_arch').value === before.portalAwakenings, `portal state persisted (awake=${A.obj('portal_arch').active}, awakenings=${A.obj('portal_arch').value})`);
  check(A.obj('bell_town_hall').value === before.bellRings, `bell ring count persisted (${A.obj('bell_town_hall').value})`);
  check(A.room.state.clockEpoch === before.clockEpoch, `clock epoch persisted (${before.clockEpoch}) → world time continues`);
  const memory = await rest('/api/memory?limit=200');
  check(memory.events.some((e) => e.id === before.latestEventId) && memory.events.length >= before.eventCount, `world events persisted (${before.eventCount} → ${memory.events.length})`);
  const g = await rest(`/api/gazette/${before.gazetteIssueId}`);
  check(g.issue?.id === before.gazetteIssueId, `gazette issue persisted (${g.issue?.title})`);
  log('AFTER restart:', JSON.stringify({ fountainStage: A.obj('fountain').value, portalAwake: A.obj('portal_arch').active, portalAwakenings: A.obj('portal_arch').value, bellRings: A.obj('bell_town_hall').value, events: memory.events.length, gazette: g.issue?.id, clockEpoch: A.room.state.clockEpoch, profileA: { id: A.welcome.profile.profileId, name: A.welcome.profile.name, visits: A.welcome.profile.visits, inventory: A.welcome.profile.inventory } }));
  await A.leave();
}

try {
  if (verifyPath) await phaseTwo(verifyPath);
  else await phaseOne();
} catch (err) {
  failures++;
  console.error('[it] ERROR', err);
}
console.log(failures ? `[it] ${failures} check(s) FAILED` : '[it] all checks passed');
process.exit(failures ? 1 : 0);
