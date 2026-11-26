#!/usr/bin/env node
/**
 * Player building, end to end: real browser clients against the REAL
 * production build (Playwright; global install loaded with createRequire).
 *
 *   npm run build && npm run e2e:build
 *
 * Spawns its own production server (`node server/dist/index.js`, PORT
 * $BUILD_PORT or 2634, fresh DATA_DIR in the OS temp dir unless
 * $BUILD_DATA_DIR). Client A: desktop 1440x900 (mouse + keyboard). Client B:
 * Pixel 7 emulation (touch; keyboard for walking). Client C: a late desktop
 * joiner. All join with `?autojoin=1` and low graphics (headless WebGL is
 * software-rendered; this changes rendering cost only).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. A and B join the same world
 *  2. A walks to the site, opens build mode with B; the palette lists the catalog
 *  3. A builds a hut through the UI (floor, walls, a doorway, a window, a peaked roof, a lamp, a sign with text); B sees every piece at the same place
 *  4. a protected spot and a spot where B stands are refused on A's screen with a visible reason (and never sent)
 *  5. B cannot remove A's piece (the remove tool offers Report, not Remove); forged remove/place messages with B's own session are refused by the server
 *  6. B is blocked by A's wall and walks in through A's doorway (server-side positions)
 *  7. B builds by touch (tap to aim, Place button); A sees it
 *  8. A removes the lamp with the remove tool; B sees it go
 *  9. after a server restart both reload and every piece is still there
 * 10. a third, late-joining client receives every piece
 * 11. zero console / page errors in every client
 *
 * Env: BUILD_PORT, BUILD_DATA_DIR, BUILD_SHOTS (screenshot dir; default none), BUILD_VERBOSE=1.
 * Nothing here simulates players: every UI action is a real input in a real
 * page (check 6's push into the wall sends each two-key combination as one
 * pair of DOM keyboard events, so a slow frame never sees half of it). Check
 * 5's forged messages come from a protocol client holding B's own session
 * token — exactly what a modified client could send.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@colyseus/sdk';
import { CONFIG, PIECES, PIECE_KINDS, ROOM_NAME, buildableAt, defaultCollisionWorld, pieceColliders } from '@elsewhere/shared';
import { SITE, hutPlan } from './lib/cottage.mjs';
import { aimGhost, assert, buildState, choosePiece, hopToward, keyboardRoute, keyboardWalk, openBuild, placeHere, rotateTo, screenOf, sleep, snap, tapOrClick, waitSnap, zoomOut } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BUILD_PORT ?? 2634);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.BUILD_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-build-'));
const SHOTS = process.env.BUILD_SHOTS ? path.resolve(ROOT, process.env.BUILD_SHOTS) : null;

const log = (...a) => console.log('[build]', ...a);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[build] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
  }
}

// ---------------------------------------------------------------------------
// Server (production build)
// ---------------------------------------------------------------------------
let server = null;
let serverExit = null;
const SECRET = randomBytes(32).toString('hex');
async function startServer() {
  assert(existsSync(path.join(ROOT, 'server/dist/index.js')) && existsSync(path.join(ROOT, 'client/dist/index.html')), 'production build missing: run `npm run build` first');
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR, SESSION_SECRET: SECRET };
  server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((r) => server.once('exit', r));
  server.stdout.on('data', (d) => process.env.BUILD_VERBOSE && process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error('server did not become healthy');
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  const done = await Promise.race([serverExit.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) {
    server.kill('SIGKILL');
    await serverExit;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const pageErrors = [];
/** True only while check 9 deliberately takes the server down (connection errors are expected then). */
let restarting = false;
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (restarting && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|Failed to fetch|net::|matchmake|reconnect|\[net\]/i.test(m.text())) return;
    pageErrors.push(`${label} console.error: ${m.text()}`);
  });
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 78 }).catch((e) => log('screenshot failed', name, e.message));
}
const posOf = (s, id) => s.players.find((p) => p.id === id);
/** Comparable piece list (as a client's build debug section lists them). */
const sig = (list) => list.map((p) => `${p.id}|${p.kind}|${p.variant}|${p.x}|${p.z}|${p.rot}|${p.level}|${p.y}|${p.ownerId}|${p.text ?? ''}`).sort();
function sameSets(a, b) {
  const sa = sig(a);
  const sb = sig(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
/** Let the script's own route planner (A*) see the built pieces, like the client's nav grid does. */
function learnPieces(list) {
  const dyn = defaultCollisionWorld().dynamic;
  dyn.clear();
  for (const p of list) dyn.set(p.id, pieceColliders(p));
}
async function statusOf(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=build-status]');
    return el ? { text: el.textContent ?? '', tone: el.getAttribute('data-tone') } : null;
  });
}
/** Hold the camera-relative W/A/S/D combination that walks in world direction `dir` for `ms`. */
async function holdToward(page, dir, ms) {
  const yaw = (await snap(page)).view.yaw;
  const mx = dir.x * Math.cos(yaw) - dir.z * Math.sin(yaw);
  const my = -(dir.x * Math.sin(yaw) + dir.z * Math.cos(yaw));
  const keys = [];
  if (mx > 0.38) keys.push('KeyD');
  if (mx < -0.38) keys.push('KeyA');
  if (my > 0.38) keys.push('KeyW');
  if (my < -0.38) keys.push('KeyS');
  // Both keys go down (and up) in the same task: pressed one after the other, a slow headless frame can
  // sample just one of them and walk diagonally for that frame.
  const send = (type) => page.evaluate(([t, ks]) => { for (const code of ks) window.dispatchEvent(new KeyboardEvent(t, { code, key: code.replace('Key', '').toLowerCase(), bubbles: true })); }, [type, keys]);
  await send('keydown');
  await sleep(ms);
  await send('keyup');
}
/** A protocol client joined with an existing session token (a "modified client"). */
async function forger(token) {
  const room = await new Client(BASE).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token });
  const results = [];
  room.onMessage('build_result', (m) => results.push(m));
  room.onMessage('*', () => undefined);
  let req = 1000;
  const ask = async (type, payload) => {
    const reqId = ++req;
    room.send(type, { reqId, ...payload });
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      const r = results.find((x) => x.reqId === reqId);
      if (r) return r;
      await sleep(50);
    }
    throw new Error(`no answer to forged ${type}`);
  };
  return { room, ask };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`data dir ${DATA_DIR}; server ${BASE}`);
await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
await ctxA.addInitScript(LOW_GFX);
await ctxB.addInitScript(LOW_GFX);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
b.__touch = true;
watch(a, 'A(desktop)');
watch(b, 'B(phone)');

const STAND_A = { x: SITE.x, z: SITE.z + 5.5 };
const WEST = { x: SITE.x - 4.5, z: SITE.z };
const plan = hutPlan(SITE);
const door = plan.find((p) => p.kind === 'doorway');
const westWall = plan.find((p) => p.kind === 'wall' && p.rot === 1 && p.x < SITE.x);
const LAMP = { kind: 'lamp', x: SITE.x + 2.5, z: SITE.z + 2.5, variant: 'brass' };
const SIGN = { kind: 'sign', x: SITE.x - 2.5, z: SITE.z + 2.5, variant: 'walnut', text: 'Hello from A' };
const PLANTER = { kind: 'planter', x: SITE.x - 3.5, z: SITE.z + 3.5, variant: 'lavender' };
let idA = '';
let idB = '';
let before = [];
let lampId = '';

try {
  await check('1. A and B join the same world', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced, 'A sees 2 players + build snapshot');
    const sb = await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced, 'B sees 2 players + build snapshot');
    idA = sa.sessionId;
    idB = sb.sessionId;
    await waitSnap(a, (s) => s.navReady === true, 'A nav grid ready');
    await waitSnap(b, (s) => s.navReady === true, 'B nav grid ready');
    return `A=${idA}, B=${idB}; pieces on join: ${sa.build.count}`;
  });

  await check('2. A walks to the site and opens build mode with the B key; the palette lists the catalog', async () => {
    await hopToward(a, STAND_A, 1.0);
    await zoomOut(a, 2);
    await a.keyboard.press('KeyB');
    await a.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
    const tiles = [];
    for (const cat of ['structure', 'roof', 'garden', 'furnishing']) {
      await a.click(`[data-testid=build-tab-${cat}]`);
      tiles.push(...(await a.$$eval('[data-testid^=build-piece-]', (els) => els.map((e) => e.getAttribute('data-testid').replace('build-piece-', '')))));
    }
    const missing = PIECE_KINDS.filter((k) => !tiles.includes(k));
    assert(missing.length === 0, `palette misses ${missing.join(', ')}`);
    await shot(a, 'e2e-1-palette');
    return `${tiles.length} pieces in 4 tabs`;
  });

  await check('3. A builds a hut through the UI (floor, walls, doorway, window, roof, lamp, sign); B sees every piece at the same place', async () => {
    const built = [];
    for (const item of [...plan, LAMP, SIGN]) {
      await choosePiece(a, item.kind, { category: PIECES[item.kind].category, variant: item.variant });
      await rotateTo(a, item.rot ?? 0, { key: built.length % 2 === 0 });
      if (item.text) await a.fill('[data-testid=build-sign-text]', item.text);
      let y;
      if (item.top) {
        const walls = (await buildState(a)).pieces.filter((p) => p.level === 0 && PIECES[p.kind].structural);
        y = Math.max(...walls.map((p) => p.y)) + CONFIG.building.storeyHeight;
      }
      const p = await placeHere(a, item.x, item.z, y, item.level !== undefined ? { level: item.level } : {});
      assert(p.kind === item.kind && p.x === item.x && p.z === item.z && p.rot === (item.rot ?? 0) && p.level === (item.level ?? 0), `placed ${JSON.stringify(p)} for ${JSON.stringify(item)}`);
      if (item.kind === 'lamp') lampId = p.id;
      built.push(p);
    }
    const sa = await snap(a);
    const sb = await waitSnap(b, (s) => s.build.count >= built.length, `B has ${built.length} pieces`, 30_000);
    assert(sameSets(sa.build.pieces, sb.build.pieces), `A and B disagree:\nA ${sig(sa.build.pieces).join('\n  ')}\nB ${sig(sb.build.pieces).join('\n  ')}`);
    const sign = sb.build.pieces.find((p) => p.kind === 'sign');
    assert(sign?.text === SIGN.text, `B's sign text is ${JSON.stringify(sign?.text)}`);
    assert(sb.build.colliders >= 6, `B's collision layer holds ${sb.build.colliders} pieces`);
    learnPieces(sb.build.pieces);
    await shot(a, 'e2e-2-hut-A');
    await shot(b, 'e2e-3-hut-B');
    return `${built.length} pieces (${[...new Set(built.map((p) => p.kind))].join(', ')}); identical on A and B incl. sign "${sign.text}"`;
  });

  await check('4. a protected spot and a spot where B stands are refused on A with a visible reason (and never sent)', async () => {
    // B comes over and stands still west of the hut.
    await hopToward(b, WEST, 0.8);
    await zoomOut(b, 2);
    const sa0 = await waitSnap(a, (s) => posOf(s, idB) && Math.hypot(posOf(s, idB).x - WEST.x, posOf(s, idB).z - WEST.z) < 1.2, 'A sees B west of the hut', 30_000);
    const count = sa0.build.count;
    const sent = sa0.net?.sent ?? null;
    // (a) A protected spot near A (the nearest on screen).
    await choosePiece(a, 'crate', { category: 'furnishing', variant: 'oak' });
    const me = sa0.local;
    let spot = null;
    for (let r = 2; r <= 8 && !spot; r++)
      for (let k = 0; k < 16 && !spot; k++) {
        const x = Math.round((me.x + Math.cos((k / 16) * Math.PI * 2) * r) * 2) / 2;
        const z = Math.round((me.z + Math.sin((k / 16) * Math.PI * 2) * r) * 2) / 2;
        if (buildableAt({ x, z }).code !== 'protected') continue;
        try {
          await screenOf(a, x, z);
          spot = { x, z, label: buildableAt({ x, z }).label };
        } catch {
          /* off screen / under the UI */
        }
      }
    assert(spot, 'no protected spot on screen near A');
    const g = await aimGhost(a, spot.x, spot.z);
    assert(!g.build.ghost.ok, `ghost at protected (${spot.x}, ${spot.z}) is valid`);
    const st = await statusOf(a);
    assert(st.tone === 'bad' && /Too close to|protected/.test(st.text), `status shows ${JSON.stringify(st)}`);
    await shot(a, 'e2e-4-refused-protected');
    const p = await screenOf(a, spot.x, spot.z);
    await a.mouse.click(p.x, p.y);
    await sleep(800);
    // (b) A wall on B.
    await choosePiece(a, 'wall', { category: 'structure', variant: 'cream' });
    const sb = await snap(a);
    const bPos = posOf(sb, idB);
    const wx = Math.round(bPos.x);
    const wz = Math.round(bPos.z);
    const g2 = await aimGhost(a, wx, wz);
    const st2 = await statusOf(a);
    assert(!g2.build.ghost.ok && /standing there/.test(st2.text), `wall on B: ghost ${JSON.stringify(g2.build.ghost)}, status ${JSON.stringify(st2)}`);
    await shot(a, 'e2e-5-refused-player');
    const q = await screenOf(a, wx, wz);
    await a.mouse.click(q.x, q.y);
    await sleep(800);
    const sa1 = await snap(a);
    assert(sa1.build.count === count, `a piece was placed (${count} → ${sa1.build.count})`);
    assert(sa1.build.stats.results.ok + sa1.build.stats.results.refused === sa0.build.stats.results.ok + sa0.build.stats.results.refused, 'a request reached the server');
    void sent;
    return `"${st.text}" at (${spot.x}, ${spot.z}) [${spot.label}]; "${st2.text}" at (${wx}, ${wz}) where B stands; nothing sent`;
  });

  await check("5. B cannot remove A's piece (remove tool offers Report, not Remove); forged messages with B's session are refused by the server", async () => {
    await openBuild(b);
    await b.click('[data-testid=build-tool-remove]');
    await waitSnap(b, (s) => s.build.mode === 'remove', 'B remove tool', 10_000);
    const wall = (await buildState(b)).pieces.find((p) => p.kind === 'wall' && p.x === westWall.x && p.z === westWall.z);
    const p = await screenOf(b, wall.x, wall.z, wall.y + 1.6);
    await tapOrClick(b, p.x, p.y);
    await b.waitForSelector('[data-testid=build-selected]', { timeout: 15_000 });
    const owner = await b.getAttribute('[data-testid=build-selected]', 'data-owner');
    assert(owner === 'other', `selection card says owner=${owner}`);
    assert(!(await b.$('[data-testid=build-remove]')) && (await b.$('[data-testid=build-report]')), 'B is offered Remove on A’s piece');
    await shot(b, 'e2e-6-B-cannot-remove');
    await b.click('[data-testid=build-done]');
    // Forged: B's own session token in a protocol client.
    const token = await b.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
    assert(token, 'no session token in B');
    const f = await forger(token);
    try {
      const r1 = await f.ask('build_remove', { id: wall.id });
      assert(!r1.ok && r1.reason === 'not_owner', `forged remove: ${JSON.stringify(r1)}`);
      const sq = { x: 0, z: 6 };
      const r2 = await f.ask('build_place', { kind: 'crate', variant: 'oak', x: sq.x, z: sq.z, rot: 0, level: 0 });
      assert(!r2.ok && (r2.reason === 'protected' || r2.reason === 'too_far'), `forged place in the square: ${JSON.stringify(r2)}`);
      const r3 = await f.ask('build_place', { kind: 'wall', variant: 'nope', x: 1.25, z: 0, rot: 7, level: 0 });
      assert(!r3.ok, `forged junk placement accepted: ${JSON.stringify(r3)}`);
    } finally {
      await f.room.leave().catch(() => undefined);
    }
    await sleep(800);
    const [sa, sb] = [await snap(a), await snap(b)];
    assert(sa.build.pieces.some((x) => x.id === wall.id) && sb.build.pieces.some((x) => x.id === wall.id), 'the wall is gone');
    return `card: built by someone else → Report only; forged remove → not_owner; forged place in the square / junk → refused; wall ${wall.id} still on both`;
  });

  await check("6. B is blocked by A's wall and walks in through A's doorway (server-side positions)", async () => {
    // Out of build mode, nothing focused: the keys walk.
    if (await b.$('[data-testid=build-dock]')) await b.locator('[data-testid=build-done]').tap();
    await waitSnap(b, (s) => s.build.mode === 'off', 'B out of build mode', 10_000);
    await b.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    const sb0 = await snap(b);
    // Line up with the middle of the wall by tap-to-move (exact at any frame rate), then push due east by keyboard.
    await hopToward(b, { x: westWall.x - 1.8, z: westWall.z }, 0.35);
    const lined = (await snap(b)).local;
    assert(Math.abs(lined.z - westWall.z) < 0.5, `B is not lined up with the wall: z ${lined.z.toFixed(2)}`);
    // Push due east in pulses, sampling B's SERVER position (A's room state) after each. A keyboard
    // direction is never exactly perpendicular, so B may slide along the wall: that is fine, but while
    // B is level with the wall (its z span) B must never be east of the wall's west face.
    const limit = westWall.x - 0.12 - CONFIG.movement.playerRadius + 0.05;
    const span = (z) => z > westWall.z - 1 + 0.05 && z < westWall.z + 1 - 0.05;
    const samples = [];
    for (let i = 0; i < 16; i++) {
      await holdToward(b, { x: 1, z: 0 }, 300);
      await sleep(200);
      const q = posOf(await snap(a), idB);
      samples.push({ x: q.x, z: q.z });
      if (process.env.BUILD_VERBOSE) log('push', i, 'server', q.x.toFixed(2), q.z.toFixed(2), 'local', JSON.stringify((await snap(b)).local));
      if (!span(q.z)) break;
      if (samples.length >= 3 && Math.abs(samples.at(-1).x - samples.at(-3).x) < 0.02) break;
    }
    const through = samples.find((q) => span(q.z) && q.x > limit);
    assert(!through, `B got through the wall: server (${through?.x.toFixed(2)}, ${through?.z.toFixed(2)}), wall face at ${(westWall.x - 0.12).toFixed(2)}`);
    const pressed = samples.filter((q) => span(q.z) && q.x > limit - 0.3);
    assert(pressed.length > 0, `B never reached the wall: lined up at (${lined.x.toFixed(2)}, ${lined.z.toFixed(2)}), camera yaw ${(await snap(b)).view.yaw.toFixed(3)}, server samples ${JSON.stringify(samples.map((q) => [q.x.toFixed(2), q.z.toFixed(2)]))}`);
    const bServer = pressed.reduce((m, q) => (q.x > m.x ? q : m));
    const blockedAt = bServer.x;
    void lined;
    // Round to the doorway and in.
    const outside = { x: door.x, z: door.z + 1.4 };
    const inside = { x: door.x + 0.3, z: SITE.z - 0.1 };
    await keyboardRoute(b, [outside, inside], { timeout: 120_000 });
    const sa2 = await waitSnap(a, (s) => {
      const q = posOf(s, idB);
      return q && q.x > SITE.x - 2 + 0.12 && q.x < SITE.x + 2 - 0.12 && q.z > SITE.z - 1 + 0.12 && q.z < SITE.z + 1 - 0.12;
    }, "A's room state has B inside the hut", 20_000);
    const q = posOf(sa2, idB);
    await shot(a, 'e2e-7-B-inside-hut');
    return `from (${sb0.local.x.toFixed(1)}, ${sb0.local.z.toFixed(1)}) B stopped at server x=${blockedAt.toFixed(2)} (< ${limit.toFixed(2)}); then in through the doorway to server (${q.x.toFixed(2)}, ${q.z.toFixed(2)})`;
  });

  await check('7. B builds by touch (tap to aim, Place button); A sees it', async () => {
    await keyboardRoute(b, [{ x: door.x, z: door.z + 1.4 }, { x: PLANTER.x + 1.5, z: PLANTER.z + 1.5 }], { timeout: 120_000 });
    await b.locator('[data-testid=nav-build]').tap();
    await b.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
    await waitSnap(b, (s) => s.build.mode === 'place' && s.build.synced, 'B build mode', 15_000);
    await b.locator('[data-testid=build-tab-garden]').tap();
    await b.locator('[data-testid=build-piece-planter]').tap();
    await b.locator(`[data-testid=build-variant-${PLANTER.variant}]`).tap();
    await waitSnap(b, (s) => s.build.kind === 'planter', 'planter chosen', 10_000);
    await b.locator('[data-testid=build-rotate]').tap();
    await waitSnap(b, (s) => s.build.rot === 1, 'rotated by tap', 10_000);
    await b.locator('[data-testid=build-rotate]').tap();
    await b.locator('[data-testid=build-rotate]').tap();
    await b.locator('[data-testid=build-rotate]').tap();
    await waitSnap(b, (s) => s.build.rot === 0, 'rotated back', 10_000);
    const p = await placeHere(b, PLANTER.x, PLANTER.z);
    await shot(b, 'e2e-8-B-touch-build');
    const sa = await waitSnap(a, (s) => s.build.pieces.some((x) => x.id === p.id), 'A sees B’s planter', 20_000);
    const seen = sa.build.pieces.find((x) => x.id === p.id);
    assert(seen.x === PLANTER.x && seen.z === PLANTER.z && seen.ownerId !== sa.build.pieces.find((x) => x.kind === 'lamp').ownerId, `A sees ${JSON.stringify(seen)}`);
    await b.locator('[data-testid=build-done]').tap();
    return `planter ${p.id} at (${p.x}, ${p.z}) by B; on A at (${seen.x}, ${seen.z})`;
  });

  await check('8. A removes the lamp with the remove tool; B sees it go', async () => {
    await a.click('[data-testid=build-tool-remove]');
    await waitSnap(a, (s) => s.build.mode === 'remove', 'A remove tool', 10_000);
    const lamp = (await buildState(a)).pieces.find((p) => p.id === lampId);
    const p = await screenOf(a, lamp.x, lamp.z, lamp.y + 1.2);
    await a.mouse.click(p.x, p.y);
    await a.waitForSelector('[data-testid=build-selected][data-owner=me]', { timeout: 15_000 });
    await a.click('[data-testid=build-remove]');
    await waitSnap(a, (s) => !s.build.pieces.some((x) => x.id === lampId), 'lamp gone on A', 20_000);
    await waitSnap(b, (s) => !s.build.pieces.some((x) => x.id === lampId), 'lamp gone on B', 20_000);
    before = (await snap(a)).build.pieces;
    await a.click('[data-testid=build-done]');
    return `lamp ${lampId} removed; ${before.length} pieces remain`;
  });

  await check('9. after a server restart both reload and every piece is still there', async () => {
    restarting = true;
    await stopServer();
    await startServer();
    await a.reload();
    await b.reload();
    const sa = await waitSnap(a, (s) => s.connection === 'connected' && s.build?.synced && s.build.count === before.length, 'A synced after restart', 90_000);
    const sb = await waitSnap(b, (s) => s.connection === 'connected' && s.build?.synced && s.build.count === before.length, 'B synced after restart', 90_000);
    restarting = false;
    assert(sameSets(sa.build.pieces, before), 'A: pieces differ after restart');
    assert(sameSets(sb.build.pieces, before), 'B: pieces differ after restart');
    assert(sa.build.mine === before.filter((p) => p.ownerId === sa.build.pieces.find((x) => x.kind === 'sign').ownerId).length, 'A no longer owns its pieces');
    return `${sa.build.count} pieces on A and B, identical to before the restart (ids, kinds, positions, heights, owners, sign text)`;
  });

  await check('10. a third, late-joining client receives every piece', async () => {
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxC.addInitScript(LOW_GFX);
    const c = await ctxC.newPage();
    watch(c, 'C(late)');
    const t0 = Date.now();
    await c.goto(`${BASE}/?autojoin=1`);
    const sc = await waitSnap(c, (s) => s.connection === 'connected' && s.build?.synced, 'C synced');
    const ms = Date.now() - t0;
    assert(sameSets(sc.build.pieces, before), `C has ${sc.build.count} pieces, expected ${before.length}`);
    assert(sc.build.colliders === before.filter((p) => pieceColliders(p).length).length, `C's collision layer has ${sc.build.colliders} pieces`);
    await ctxC.close();
    return `C: ${sc.build.count} pieces, ${sc.build.colliders} colliding, snapshot ${sc.build.stats.snapshotBytes} B in ${sc.build.stats.snapshotChunks} chunk(s); page load → synced ${ms} ms`;
  });

  await check('11. zero console / page errors in every client', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  record('script', false, String(err?.stack ?? err));
} finally {
  await browser.close().catch(() => undefined);
  await stopServer();
}

const failed = results.filter((r) => !r.ok);
console.log(`[build] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
