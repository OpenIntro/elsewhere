#!/usr/bin/env node
/**
 * Player building, round 2, end to end: two real browsers against the REAL
 * production build, through the real build UI.
 *
 *   npm run build && npm run e2e:build2
 *
 * Spawns its own production server (`node server/dist/index.js`, PORT
 * $BUILD2_PORT or 2634, fresh DATA_DIR in the OS temp dir unless
 * $BUILD2_DATA_DIR). Client A: desktop 1440x900 (mouse + keyboard). Client
 * B: Pixel 7 emulation (touch; keyboard for walking). Client C: a late
 * desktop joiner. Low graphics (headless WebGL is software-rendered).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. A and B join the same world
 *  2. a wall blocked only by a bush says so and offers "Clear bush"; A clears it from the offer and builds the wall; B's client loses the bush
 *  3. A builds the ground floor of a 4 x 4 house (floors, walls, a doorway, windows)
 *  4. stacking snaps onto the wall under the cursor (same line, one storey up, highlighted) at all four camera rotations
 *  5. A builds the second storey: by aiming at the wall below, by the run (ghost moves on; Enter), and with the storey control (locked "Storey 2")
 *  6. A covers the house with ONE gable roof from the roof tool (span auto-detected from the walls)
 *  7. A hangs a name board over the door (snaps to the doorway's face) and the name is on it
 *  8. A walks in and furnishes it: bed, table, chair, wall shelf, picture, a table lamp ON the table, fireplace
 *  9. B sees every piece identically; the building's name shows to B on approach ("<name> · built by <A>")
 * 10. B sits on A's chair (touch action button); A sees B seated on it; B stands up
 * 11. B cannot clear a tree or a protected plant: the clear tool offers nothing there, and B's forged clears are refused by the server
 * 12. A clears a small rock; B walks onto where it was (server positions)
 * 13. B by touch: builds a little hut, stacks a wall on it, and places a roof on it with the roof tool; A sees them
 * 14. after a server restart both reload: every piece (roof params, sign name, levels) and the cleared bush / rock are still so
 * 15. a third, late-joining client receives every piece and the cleared plants
 * 16. zero console / page errors in every client
 *
 * Env: BUILD2_PORT, BUILD2_DATA_DIR, BUILD2_SHOTS (screenshot dir), BUILD2_VERBOSE=1.
 * Every UI action is a real input in a real page. Check 11's forged clears
 * come from a protocol client holding B's own session token.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@colyseus/sdk';
import { CONFIG, PIECES, ROOM_NAME, TREES, clearableNature, defaultCollisionWorld, natureItem, pieceColliders } from '@elsewhere/shared';
import { BUSH_WALL, HOUSE, twoStoreyHouse } from './lib/plans2.mjs';
import { aimGhost, assert, buildState, choosePiece, hopToward, keyboardRoute, openBuild, placeHere, press, query, rotateTo, screenOf, sleep, snap, tapOrClick, waitSnap, zoomOut } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BUILD2_PORT ?? 2634);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.BUILD2_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-build2-'));
const SHOTS = process.env.BUILD2_SHOTS ? path.resolve(ROOT, process.env.BUILD2_SHOTS) : null;
const NAME = 'Fern Cottage';

const log = (...a) => console.log('[build2]', ...a);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[build2] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
    // Leave build mode on every client so a failure does not leave later checks tapping a ghost.
    for (const page of [a, b]) {
      if (await page.locator('[data-testid=build-done]').isVisible().catch(() => false)) await press(page, '[data-testid=build-done]').catch(() => undefined);
    }
  }
}

// --- server ------------------------------------------------------------------
let server = null;
let serverExit = null;
const SECRET = randomBytes(32).toString('hex');
async function startServer() {
  assert(existsSync(path.join(ROOT, 'server/dist/index.js')) && existsSync(path.join(ROOT, 'client/dist/index.html')), 'production build missing: run `npm run build` first');
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR, SESSION_SECRET: SECRET };
  server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((r) => server.once('exit', r));
  server.stdout.on('data', (d) => process.env.BUILD2_VERBOSE && process.stdout.write(`[server] ${d}`));
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

// --- helpers -----------------------------------------------------------------
const pageErrors = [];
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
const sig = (list) => list.map((p) => `${p.id}|${p.kind}|${p.variant}|${p.x}|${p.z}|${p.rot}|${p.level}|${p.y}|${p.ownerId}|${p.text ?? ''}|${p.params ?? ''}`).sort();
function sameSets(a, b) {
  const sa = sig(a);
  const sb = sig(b);
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}
function learn(list, cleared = []) {
  const w = defaultCollisionWorld();
  w.dynamic.clear();
  for (const p of list) w.dynamic.set(p.id, pieceColliders(p));
  w.disabled.clear();
  for (const id of cleared) {
    const c = natureItem(id)?.colliderId;
    if (c) w.disabled.add(c);
  }
}
async function statusOf(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=build-status]');
    return el ? { text: el.textContent ?? '', tone: el.getAttribute('data-tone') } : null;
  });
}
const visible = (page, id) => page.evaluate((i) => window.__ELSEWHERE__.query('natureVisible', i), id);
const findPiece = (st, p) => st.pieces.find((q) => q.kind === p.kind && q.x === p.x && q.z === p.z && q.level === (p.level ?? 0) && (p.rot === undefined || q.rot === p.rot));
/** Place a planned piece through the UI (palette, style, rotation, words, aim, click / Place). */
async function build(page, item, opts = {}) {
  await choosePiece(page, item.kind, { category: PIECES[item.kind].category, variant: item.variant });
  if (!PIECES[item.kind].mount && PIECES[item.kind].param !== 'roof') await rotateTo(page, item.rot ?? 0);
  if (item.text) await page.fill('[data-testid=build-sign-text]', item.text);
  const p = await placeHere(page, item.x, item.z, opts.y, { level: item.level ?? 0, aim: opts.aim });
  assert(p.kind === item.kind && p.x === item.x && p.z === item.z && p.level === (item.level ?? 0) && (item.rot === undefined || p.rot === item.rot), `placed ${JSON.stringify(p)} for ${JSON.stringify(item)}`);
  return p;
}
async function forger(token) {
  const room = await new Client(BASE).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token });
  const res = [];
  room.onMessage('build_result', (m) => res.push(m));
  room.onMessage('*', () => undefined);
  let req = 5000;
  const ask = async (type, payload) => {
    const reqId = ++req;
    room.send(type, { reqId, ...payload });
    for (let i = 0; i < 200; i++) {
      const r = res.find((x) => x.reqId === reqId);
      if (r) return r;
      await sleep(50);
    }
    throw new Error(`no answer to forged ${type}`);
  };
  return { room, ask };
}

// --- run ---------------------------------------------------------------------
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

const house = twoStoreyHouse(HOUSE, NAME);
const STAND_A = { x: HOUSE.x + 0.5, z: HOUSE.z1 + 2.5 };
const wallTop = (st, level = 0) => {
  const walls = st.pieces.filter((p) => p.level === level && PIECES[p.kind].structural);
  return Math.max(...walls.map((p) => p.y)) + CONFIG.building.storeyHeight;
};
const ROCK = 'rock_21';
const HUT = { x: -21, z: 6 };
let idA = '';
let idB = '';
let before = [];
let clearedBefore = [];
const chair = house.furniture.find((f) => f.kind === 'chair');

try {
  await check('1. A and B join the same world', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.navReady, 'A ready');
    const sb = await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.navReady, 'B ready');
    idA = sa.sessionId;
    idB = sb.sessionId;
    assert(await visible(b, BUSH_WALL.bush), `${BUSH_WALL.bush} is not drawn on B to begin with`);
    return `A=${idA}, B=${idB}`;
  });

  await check('2. a wall blocked only by a bush offers "Clear bush"; A clears it from the offer and builds; B loses the bush', async () => {
    await hopToward(a, STAND_A, 1.0);
    await zoomOut(a, 2);
    await openBuild(a);
    await choosePiece(a, 'wall', { category: 'structure', variant: BUSH_WALL.variant });
    await rotateTo(a, BUSH_WALL.rot);
    const g = await aimGhost(a, BUSH_WALL.x, BUSH_WALL.z);
    assert(!g.build.ghost.ok && g.build.ghost.natureId === BUSH_WALL.bush, `ghost ${JSON.stringify(g.build.ghost)}`);
    const st = await statusOf(a);
    assert(/bush is in the way/i.test(st.text), `status: ${st.text}`);
    await a.waitForSelector('[data-testid=build-clear-offer]', { timeout: 5_000 });
    await shot(a, 'r2-01-bush-offer');
    await a.click('[data-testid=build-clear-offer]');
    await waitSnap(a, (s) => s.build.cleared.includes(BUSH_WALL.bush), 'A: bush cleared', 15_000);
    const sb = await waitSnap(b, (s) => s.build.cleared.includes(BUSH_WALL.bush), 'B: bush cleared', 15_000);
    assert(!(await visible(b, BUSH_WALL.bush)), 'B still draws the bush');
    const w = await placeHere(a, BUSH_WALL.x, BUSH_WALL.z, undefined, { level: 0 });
    assert(w.kind === 'wall' && w.rot === BUSH_WALL.rot, `wall ${JSON.stringify(w)}`);
    return `"${st.text}" → cleared ${BUSH_WALL.bush} (B: cleared=${sb.build.cleared.join(',')}, drawn=false) → wall ${w.id} at (${w.x}, ${w.z})`;
  });

  await check('3. A builds the ground floor (floors, walls, a doorway, windows)', async () => {
    for (const f of house.floors) await build(a, f);
    for (const w of house.ground) await build(a, w);
    const st = await buildState(a);
    const ground = st.pieces.filter((p) => p.level === 0 && PIECES[p.kind].structural && p.x >= HOUSE.x0 && p.x <= HOUSE.x1 && p.z >= HOUSE.z0 && p.z <= HOUSE.z1);
    assert(ground.length === house.ground.length, `${ground.length} ground walls`);
    learn(st.pieces, st.cleared);
    return `${house.floors.length} floors, ${ground.length} walls (${ground.filter((p) => p.kind === 'doorway').length} doorway, ${ground.filter((p) => p.kind === 'wall_window').length} windows)`;
  });

  await check('4. stacking snaps onto the wall under the cursor at all four camera rotations', async () => {
    await choosePiece(a, 'wall_window', { category: 'structure', variant: 'cream' });
    const out = [];
    for (let k = 0; k < 4; k++) {
      const s0 = await snap(a);
      // A wall whose face points at the camera this rotation (the nearest-to-camera side of the house).
      const cx = Math.sin(s0.view.yaw);
      const cz = Math.cos(s0.view.yaw);
      const st = await buildState(a);
      const cands = st.pieces.filter((p) => p.level === 0 && PIECES[p.kind].structural && p.x >= HOUSE.x0 && p.x <= HOUSE.x1 && p.z >= HOUSE.z0 && p.z <= HOUSE.z1);
      cands.sort((p, q) => (q.x - HOUSE.x) * cx + (q.z - HOUSE.z) * cz - ((p.x - HOUSE.x) * cx + (p.z - HOUSE.z) * cz));
      let done = null;
      for (const w of cands.slice(0, 4)) {
        let pt;
        try {
          pt = await screenOf(a, w.x, w.z, w.y + 2.1);
        } catch {
          continue;
        }
        await a.mouse.move(pt.x, pt.y, { steps: 2 });
        const s = await waitSnap(a, (x) => x.build.ghost?.extend === w.id, `ghost extends ${w.id}`, 15_000).catch(() => null);
        if (!s) continue;
        const g = s.build.ghost;
        assert(g.x === w.x && g.z === w.z && g.level === 1 && g.rot % 2 === w.rot % 2, `rotation ${k}: ghost ${JSON.stringify(g)} on wall ${JSON.stringify(w)}`);
        done = { w, g };
        break;
      }
      assert(done, `rotation ${k} (yaw ${s0.view.yaw.toFixed(2)}): no wall face to stack on`);
      if (k === 0) await shot(a, 'r2-02-stack-highlight');
      out.push(`yaw ${(((s0.view.yaw * 180) / Math.PI) % 360).toFixed(0)}°: ${done.w.kind}(${done.w.x},${done.w.z}) → L1 rot ${done.g.rot}`);
      await a.keyboard.press('KeyQ');
      await waitSnap(a, (x) => Math.abs(x.view.yaw - s0.view.yaw) > 1.2, 'camera turned', 15_000);
    }
    return out.join('; ');
  });

  await check('5. A builds the second storey: aiming at the wall below, along the run (Enter), and with the storey control', async () => {
    const upper = house.upper;
    const st0 = await buildState(a);
    const top = wallTop(st0, 0);
    // (a) Aim at the face of the wall below: the ghost sits right on top of it.
    const first = upper[0];
    await choosePiece(a, first.kind, { category: 'structure', variant: first.variant });
    const below = findPiece(st0, { ...first, level: 0, kind: undefined, rot: undefined }) ?? st0.pieces.find((p) => p.x === first.x && p.z === first.z && p.level === 0);
    const pt = await screenOf(a, below.x, below.z, below.y + 2.1);
    await a.mouse.move(pt.x, pt.y, { steps: 2 });
    await waitSnap(a, (s) => s.build.ghost?.extend === below.id && s.build.ghost.ok, 'stack ghost on the wall below', 15_000);
    const ok0 = (await buildState(a)).stats.results.ok;
    await a.mouse.click(pt.x, pt.y);
    await waitSnap(a, (s) => s.build.stats.results.ok > ok0, 'first upper wall', 20_000);
    // (b) The run: the ghost moved on to the next segment by itself; Enter places it.
    const second = upper.find((u) => u.z === first.z && u.rot === first.rot && Math.abs(u.x - first.x) === 2);
    await choosePiece(a, second.kind, { category: 'structure', variant: second.variant });
    // Re-place the run start so the "next" is that of the right kind (choosing another kind keeps the run).
    await a.keyboard.press('KeyN');
    const sN = await waitSnap(a, (s) => s.build.ghost && s.build.ghost.x === second.x && s.build.ghost.z === second.z && s.build.ghost.level === 1, `run ghost at (${second.x}, ${second.z})`, 15_000);
    const ok1 = sN.build.stats.results.ok;
    await a.keyboard.press('Enter');
    await waitSnap(a, (s) => s.build.stats.results.ok > ok1, 'second upper wall by the run', 20_000);
    // (c) The storey control: lock Storey 2 with the ▲ button, then aim anywhere along the wall lines.
    await a.click('[data-testid=build-storey-up]');
    let ls = await waitSnap(a, (s) => s.build.lockLevel !== null, 'storey locked', 10_000);
    while (ls.build.lockLevel < 1) {
      await a.click('[data-testid=build-storey-up]');
      ls = await waitSnap(a, (s) => s.build.lockLevel >= 1, 'storey 2', 10_000);
    }
    while (ls.build.lockLevel > 1) {
      await a.click('[data-testid=build-storey-down]');
      ls = await waitSnap(a, (s) => s.build.lockLevel === 1, 'storey 2', 10_000);
    }
    const label = await a.textContent('[data-testid=build-storey-label]');
    assert(/Storey 2/.test(label) && /locked/i.test(label), `storey label "${label}"`);
    await shot(a, 'r2-03-storey-control');
    const placedUpper = [first, second];
    for (const u of upper) {
      if (placedUpper.includes(u)) continue;
      await build(a, u, { y: top });
    }
    await a.click('[data-testid=build-storey-label]'); // back to automatic
    await waitSnap(a, (s) => s.build.lockLevel === null, 'storey automatic', 10_000);
    const st = await buildState(a);
    const lvl1 = st.pieces.filter((p) => p.level === 1 && PIECES[p.kind].structural);
    assert(lvl1.length === upper.length, `${lvl1.length}/${upper.length} upper walls`);
    for (const u of upper) assert(findPiece(st, u), `missing upper ${u.kind} at (${u.x}, ${u.z})`);
    return `${lvl1.length} walls on storey 2 (1 by aiming at the wall below, 1 along the run with Enter, ${upper.length - 2} with the storey locked; label "${label.trim()}")`;
  });

  await check('6. A covers the house with ONE gable roof from the roof tool (auto-detected span)', async () => {
    await choosePiece(a, 'house_roof', { category: 'roof', variant: house.roof.variant });
    await press(a, '[data-testid=build-roof-gable]');
    await press(a, '[data-testid=build-pitch-1]');
    const st0 = await buildState(a);
    if (st0.rot % 2 !== house.roof.rot) await press(a, '[data-testid=build-rotate]');
    const top = wallTop(st0, 1);
    const g = await aimGhost(a, house.roof.x, house.roof.z, top, { level: 2 });
    assert(g.build.ghost.ok, `roof ghost refused: ${g.build.ghost.message}`);
    const params = JSON.parse(g.build.ghost.params);
    assert(params.w === 4 && params.d === 4 && params.s === 'gable' && params.p === 1, `params ${g.build.ghost.params}`);
    await shot(a, 'r2-04-roof-ghost');
    const before = (await buildState(a)).count;
    const p = await placeHere(a, house.roof.x, house.roof.z, top, { level: 2 });
    const st = await buildState(a);
    assert(st.count === before + 1 && p.kind === 'house_roof' && p.params, `roof ${JSON.stringify(p)}; count ${before} → ${st.count}`);
    return `one piece ${p.id}: ${p.params} at (${p.x}, ${p.z}) level ${p.level}, y ${p.y}`;
  });

  await check('7. A hangs a name board over the door (snaps to the doorway face) with the name on it', async () => {
    const s = house.sign;
    await choosePiece(a, s.kind, { category: 'sign', variant: s.variant });
    await a.fill('[data-testid=build-sign-text]', s.text);
    const st0 = await buildState(a);
    const door = st0.pieces.find((p) => p.kind === 'doorway' && p.level === 0);
    // Aim at the doorway's face above the door; the board snaps to that wall's outside face.
    const pt = await screenOf(a, door.x, door.z + 0.13, door.y + 2.35);
    await a.mouse.move(pt.x, pt.y, { steps: 2 });
    const g = await waitSnap(a, (x) => x.build.ghost && x.build.ghost.x === door.x && x.build.ghost.z === door.z && x.build.ghost.rot === s.rot, 'sign ghost on the doorway face', 15_000);
    assert(g.build.ghost.ok, `sign ghost refused: ${g.build.ghost.message}`);
    const ok0 = g.build.stats.results.ok;
    await a.mouse.click(pt.x, pt.y);
    const st = await waitSnap(a, (x) => x.build.stats.results.ok > ok0, 'sign placed', 20_000);
    const p = st.build.pieces.find((q) => q.kind === s.kind);
    assert(p && p.text === s.text && p.x === door.x && p.z === door.z, `sign ${JSON.stringify(p)}`);
    await shot(a, 'r2-05-name-board');
    return `"${p.text}" on the doorway at (${p.x}, ${p.z}), facing rot ${p.rot}`;
  });

  await check('8. A walks in and furnishes: bed, table, chair, wall shelf, picture, a table lamp ON the table, fireplace', async () => {
    await a.click('[data-testid=build-done]');
    const st0 = await buildState(a);
    learn(st0.pieces, st0.cleared);
    const door = st0.pieces.find((p) => p.kind === 'doorway' && p.level === 0);
    // In through the doorway by keyboard (the script's A* knows the walls, like the client's nav grid).
    await hopToward(a, { x: door.x + 0.6, z: door.z + 2.2 }, 1.0);
    // Click a spot inside: click-to-move routes in through the doorway.
    await hopToward(a, { x: HOUSE.x0 + 0.7, z: HOUSE.z1 - 0.7 }, 0.45, 120_000);
    const inside = (await snap(a)).local;
    assert(inside.x > HOUSE.x0 && inside.x < HOUSE.x1 && inside.z > HOUSE.z0 && inside.z < HOUSE.z1, `A is not inside: ${JSON.stringify(inside)}`);
    await openBuild(a);
    const placed = [];
    for (const f of house.furniture) {
      if (f.kind === 'table_lamp') {
        const table = (await buildState(a)).pieces.find((p) => p.kind === 'table');
        // Point at the table top: the lamp stands on it.
        await choosePiece(a, f.kind, { category: PIECES[f.kind].category, variant: f.variant });
        const p = await placeHere(a, f.x, f.z, table.y + PIECES.table.h, { level: 0 });
        assert(Math.abs(p.y - (table.y + PIECES.table.h)) < 0.02, `lamp y ${p.y}, table top ${table.y + PIECES.table.h}`);
        placed.push(`${p.kind}@table-top y=${p.y}`);
        continue;
      }
      const yAim = PIECES[f.kind].mount ? (await buildState(a)).pieces.find((p) => p.x === f.x && p.z === f.z && p.level === 0 && PIECES[p.kind].structural).y + 1.5 : undefined;
      // A wall mount is pointed at the wall's inner face (the side A stands on), like a player would.
      const n = f.rot % 2 === 0 ? { x: 0, z: Math.sign(HOUSE.z - f.z) } : { x: Math.sign(HOUSE.x - f.x), z: 0 };
      const aim = PIECES[f.kind].mount ? { x: f.x + n.x * 0.14, z: f.z + n.z * 0.14 } : undefined;
      const p = await build(a, f, { y: yAim, aim });
      placed.push(`${p.kind}(${p.x},${p.z} r${p.rot})`);
    }
    await shot(a, 'r2-06-furnished');
    await a.click('[data-testid=build-done]');
    return placed.join(', ');
  });

  await check('9. B sees every piece identically; the name shows to B on approach', async () => {
    const sa = await snap(a);
    const sb = await waitSnap(b, (s) => s.build.count === sa.build.count, `B has ${sa.build.count} pieces`, 30_000);
    assert(sameSets(sa.build.pieces, sb.build.pieces), 'A and B disagree on the pieces');
    learn(sb.build.pieces, sb.build.cleared);
    // B walks up to the front door.
    const door = sb.build.pieces.find((p) => p.kind === 'doorway' && p.level === 0);
    await hopToward(b, { x: door.x + 1.2, z: door.z + 2.4 }, 1.0);
    await b.waitForSelector('[data-testid=build-name-prompt]', { timeout: 20_000 });
    const label = (await b.textContent('[data-testid=build-name-prompt]')) ?? '';
    const nameA = sa.players.find((p) => p.id === idA)?.name;
    assert(label.includes(NAME) && label.includes(`built by ${nameA}`), `prompt "${label}"`);
    await shot(b, 'r2-07-name-prompt');
    return `${sb.build.count} pieces identical (incl. roof params and sign); B sees "${label.trim()}"`;
  });

  await check("10. B sits on A's chair (taps it: walks in through the doorway and sits); A sees B seated; B stands up", async () => {
    const st = await buildState(b);
    const c = findPiece(st, chair);
    assert(c, 'no chair');
    const ref = `bp:${c.id}#0`;
    // Tap the chair (its pick anchor sits 0.7 m above the ground): click-to-move routes in through the doorway.
    // If a HUD element covers the chair on the phone, zoom out (the chair moves toward the centre).
    let pt = null;
    for (let i = 0; i < 3 && !pt; i++) {
      pt = await screenOf(b, c.x, c.z, c.y + 0.7).catch(() => null);
      if (!pt) await zoomOut(b, 1);
    }
    assert(pt, 'the chair is not tappable on B’s screen');
    const pick = await query(b, 'pick', pt.x, pt.y, 'touch');
    assert(pick?.id === `bp:${c.id}`, `a tap there picks ${JSON.stringify(pick)}`);
    await b.touchscreen.tap(pt.x, pt.y);
    const sa = await waitSnap(a, (s) => posOf(s, idB)?.seat === ref, 'A sees B seated', 90_000);
    await shot(a, 'r2-08-B-seated');
    // Stand up (moving stands you up); the seat frees.
    await b.keyboard.down('KeyS');
    await sleep(700);
    await b.keyboard.up('KeyS');
    await waitSnap(a, (s) => posOf(s, idB)?.seat === '', 'B stood up', 20_000);
    return `B tapped the chair → seat ${ref}, anim ${posOf(sa, idB).anim} on A; stood up`;
  });

  await check('11. B cannot clear a tree or a protected plant (UI offers nothing; forged clears refused by the server)', async () => {
    const sb = await snap(b);
    const me = sb.local;
    // A tree on screen near B.
    // Zoom out so trees around are on screen; tap the nearest one with the clear tool: nothing is offered.
    await zoomOut(b, 2);
    const me2 = me;
    await openBuild(b);
    await press(b, '[data-testid=build-tool-clear]');
    await waitSnap(b, (s) => s.build.mode === 'clear', 'B clear tool', 10_000);
    const trees = [...TREES].sort((p, q) => Math.hypot(p.position.x - me2.x, p.position.z - me2.z) - Math.hypot(q.position.x - me2.x, q.position.z - me2.z));
    let tree = null;
    let pt = null;
    for (const t of trees.slice(0, 12)) {
      try {
        pt = await screenOf(b, t.position.x, t.position.z, 0.8);
        tree = t;
        break;
      } catch {
        /* off screen / under the UI */
      }
    }
    assert(tree && pt, 'no tree on B’s screen');
    await tapOrClick(b, pt.x, pt.y);
    await sleep(1000);
    const sel = await buildState(b);
    assert(sel.selectedNature !== tree.id, 'a tree was offered for clearing');
    const uiTree = `tapped ${tree.id} in the clear tool: offered ${sel.selectedNature ?? 'nothing'}`;
    await press(b, '[data-testid=build-done]');
    const token = await b.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
    const f = await forger(token);
    try {
      const r1 = await f.ask('build_clear', { id: tree.id });
      assert(!r1.ok && r1.reason === 'not_clearable', `tree: ${JSON.stringify(r1)}`);
      const protectedBush = ['bush_64', 'bush_88', 'bush_92'].find((id) => natureItem(id) && !clearableNature().has(id));
      const r2 = await f.ask('build_clear', { id: protectedBush });
      assert(!r2.ok && r2.reason === 'not_clearable', `protected ${protectedBush}: ${JSON.stringify(r2)}`);
      return `${uiTree}; forged: tree → ${r1.reason} ("${r1.message}"), ${protectedBush} by the Town Square → ${r2.reason}`;
    } finally {
      await f.room.leave().catch(() => undefined);
    }
  });

  await check('12. A clears a small rock; B walks onto where it was (server positions)', async () => {
    const rock = natureItem(ROCK);
    const stand = { x: rock.position.x + 1.8, z: rock.position.z + 1.6 };
    await hopToward(a, stand, 1.2, 300_000);
    await openBuild(a);
    await press(a, '[data-testid=build-tool-clear]');
    await waitSnap(a, (s) => s.build.mode === 'clear', 'A clear tool', 10_000);
    const pt = await screenOf(a, rock.position.x, rock.position.z);
    await a.mouse.click(pt.x, pt.y);
    await a.waitForSelector(`[data-testid=build-nature][data-nature=${ROCK}]`, { timeout: 15_000 });
    await shot(a, 'r2-09-clear-rock');
    await a.click('[data-testid=build-clear]');
    await waitSnap(b, (s) => s.build.cleared.includes(ROCK) && s.build.disabledColliders.includes(`col_${ROCK}`), 'B: rock cleared + collider off', 20_000);
    await a.click('[data-testid=build-done]');
    // A steps back out of B's way (from B's camera A would stand right in front of the spot).
    await hopToward(a, { x: -27.6, z: 0.1 }, 1.0, 120_000);
    // B walks onto the rock's spot (impossible before: it was a collider).
    await hopToward(b, rock.position, 0.3, 300_000);
    const sa = await waitSnap(a, (s) => posOf(s, idB) && Math.hypot(posOf(s, idB).x - rock.position.x, posOf(s, idB).z - rock.position.z) < 0.35, "A's room state has B on the rock's spot", 20_000);
    const q = posOf(sa, idB);
    return `rock ${ROCK} (r ${rock.radius.toFixed(2)}) cleared; B at server (${q.x.toFixed(2)}, ${q.z.toFixed(2)}), ${Math.hypot(q.x - rock.position.x, q.z - rock.position.z).toFixed(2)} m from its centre`;
  });

  await check('13. B by touch: a little hut, a wall stacked on it, and a roof from the roof tool; A sees them', async () => {
    await hopToward(b, { x: HUT.x + 0.5, z: HUT.z + 3.2 }, 1.0, 300_000);
    await zoomOut(b, 1);
    await openBuild(b);
    const walls = [
      { kind: 'wall', x: HUT.x, z: HUT.z - 1, rot: 0, variant: 'rose' },
      { kind: 'wall_window', x: HUT.x - 1, z: HUT.z, rot: 1, variant: 'rose' },
      { kind: 'wall', x: HUT.x + 1, z: HUT.z, rot: 1, variant: 'rose' },
      { kind: 'doorway', x: HUT.x, z: HUT.z + 1, rot: 0, variant: 'rose' },
    ];
    for (const w of walls) await build(b, w);
    // Roof over the hut: tap the walls → whole-roof ghost → Place.
    await choosePiece(b, 'house_roof', { category: 'roof', variant: 'moss' });
    let st = await buildState(b);
    const top = wallTop({ pieces: st.pieces.filter((p) => Math.abs(p.x - HUT.x) <= 1 && Math.abs(p.z - HUT.z) <= 1) }, 0);
    const rg = await aimGhost(b, HUT.x, HUT.z, top, { level: 1 });
    assert(rg.build.ghost.ok, `B roof ghost: ${rg.build.ghost.message}`);
    const roof = await placeHere(b, HUT.x, HUT.z, top, { level: 1 });
    // A garden wall by the hut, then a second storey on it: tap the wall → the ghost goes right on top → Place.
    const garden = { kind: 'wall', x: HUT.x + 3, z: HUT.z, rot: 1, variant: 'rose' };
    await build(b, garden);
    st = await buildState(b);
    const base = findPiece(st, { ...garden, level: 0 });
    const pt = await screenOf(b, base.x, base.z, base.y + 2.1);
    await b.touchscreen.tap(pt.x, pt.y);
    const g = await waitSnap(b, (s) => s.build.ghost?.extend === base.id && s.build.ghost.level === 1 && s.build.ghost.ok, 'B stack ghost', 15_000);
    const ok0 = g.build.stats.results.ok;
    await press(b, '[data-testid=build-place]');
    await waitSnap(b, (s) => s.build.stats.results.ok > ok0, 'B stacked wall', 20_000);
    await shot(b, 'r2-10-B-touch-roof');
    await press(b, '[data-testid=build-done]');
    const sa = await waitSnap(a, (s) => s.build.pieces.some((p) => p.id === roof.id), 'A sees B’s roof', 20_000);
    const stacked = sa.build.pieces.find((p) => p.x === HUT.x + 3 && p.z === HUT.z && p.level === 1);
    assert(stacked, 'A does not see the stacked wall');
    return `hut of ${walls.length} walls, stacked wall ${stacked.id} (level 1), roof ${roof.id} ${roof.params}`;
  });

  await check('14. after a server restart both reload: every piece and the cleared bush / rock are still so', async () => {
    const s0 = await snap(a);
    before = s0.build.pieces;
    clearedBefore = s0.build.cleared;
    restarting = true;
    await stopServer();
    await startServer();
    await a.reload();
    await b.reload();
    const sa = await waitSnap(a, (s) => s.connection === 'connected' && s.build?.synced && s.build.count === before.length, 'A synced after restart', 90_000);
    const sb = await waitSnap(b, (s) => s.connection === 'connected' && s.build?.synced && s.build.count === before.length, 'B synced after restart', 90_000);
    restarting = false;
    assert(sameSets(sa.build.pieces, before) && sameSets(sb.build.pieces, before), 'pieces differ after restart');
    assert(JSON.stringify(sb.build.cleared) === JSON.stringify(clearedBefore), `cleared ${sb.build.cleared} vs ${clearedBefore}`);
    await sleep(1500);
    assert(!(await visible(b, BUSH_WALL.bush)) && !(await visible(b, ROCK)), 'a cleared plant is drawn again after restart');
    assert(sb.build.disabledColliders.includes(`col_${ROCK}`), 'rock collider back after restart');
    return `${sa.build.count} pieces identical; cleared ${sb.build.cleared.join(', ')} (not drawn, rock collider off)`;
  });

  await check('15. a third, late-joining client receives every piece and the cleared plants', async () => {
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxC.addInitScript(LOW_GFX);
    const c = await ctxC.newPage();
    watch(c, 'C(late)');
    await c.goto(`${BASE}/?autojoin=1`);
    const sc = await waitSnap(c, (s) => s.connection === 'connected' && s.build?.synced && s.build.count === before.length, 'C synced');
    assert(sameSets(sc.build.pieces, before), 'C pieces differ');
    assert(JSON.stringify(sc.build.cleared) === JSON.stringify(clearedBefore), 'C cleared set differs');
    await ctxC.close();
    return `C: ${sc.build.count} pieces, cleared ${sc.build.cleared.join(', ')}, snapshot ${sc.build.stats.snapshotBytes} B`;
  });

  await check('16. zero console / page errors in every client', async () => {
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
console.log(`[build2] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
