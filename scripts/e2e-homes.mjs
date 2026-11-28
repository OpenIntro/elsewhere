#!/usr/bin/env node
/**
 * Homes ("Make this my home"), end to end: real browsers against the REAL
 * production build; every piece and every home action goes through the real UI.
 *
 *   npm run build && npm run e2e:homes
 *
 * Spawns its own production server (scripts/lib/server.mjs; port $HOMES_PORT
 * or 2671, fresh temp DATA_DIR unless $HOMES_DATA_DIR). Client A: desktop
 * 1440x900 (mouse). Client B: Pixel 7 emulation (touch only; it walks by
 * tap-to-move). Client C: a late desktop joiner after the restart. Low
 * graphics (headless WebGL is software-rendered).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. A builds a 4 x 4 hut through the UI (walls, a doorway, a window, a house roof, a name board "Fern Cottage")
 *     and makes it home from the selection card; both snapshots list the home
 *  2. B walks up by tap-to-move and sees "Fern Cottage · <A>’s home · 1 inside" while A stands inside,
 *     and no count once A has left
 *  3. B's map has no pin by default; A switches "Show my home on the map" on; B's map shows the pin within 2 s
 *  4. B blocks A (player card): B's map loses the pin; B unblocks A (Settings): the pin is back
 *  5. A removes the roof: the home is cleared on both and A sees the notice
 *  6. A re-roofs and makes it home again (pin on); after a server restart the home and pin are intact,
 *     and a late joiner C sees the label and the pin
 *  7. a forged homeSet from B (B's own session token) on A's house, and one on B's bare floor tile, are refused with reasons
 *  8. zero console / page errors on every page
 *
 * Env: HOMES_PORT, HOMES_DATA_DIR, HOMES_SHOTS (default docs/screenshots/homes; 0 = none),
 * HOMES_CLIENT_DIST (serve another client build), HOMES_VERBOSE=1, E2E_RESULT.
 * Nothing here simulates players. The forged messages in check 7 come from a
 * protocol client holding B's own session token — exactly what a modified
 * client could send.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@colyseus/sdk';
import { CONFIG, PIECES, PieceIndex, ROOM_NAME, defaultCollisionWorld, homeLabel, validatePlacement } from '@elsewhere/shared';
import { assert, aimGhost, buildState, choosePiece, closeBuild, hopToward, openBuild, placeHere, press, query, rotateTo, screenOf, sleep, snap, tapOrClick, waitSnap, zoomOut, onCanvas } from './lib/browser.mjs';
import { closePanel } from './lib/phone.mjs';
import { createServer } from './lib/server.mjs';
import { resultFile, shotsDir } from './lib/report.mjs';
import { HUT, interiorScene } from './e2e-built-interiors.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HOMES_PORT ?? 2671);
const SHOTS = shotsDir(process.env.HOMES_SHOTS, 'docs/screenshots/homes', ROOT);
const env = process.env.HOMES_CLIENT_DIST ? { CLIENT_DIST: path.resolve(process.env.HOMES_CLIENT_DIST) } : {};
const server = createServer({ port: PORT, env, label: 'homes', verbose: !!process.env.HOMES_VERBOSE, tmpPrefix: 'elsewhere-homes-', ...(process.env.HOMES_DATA_DIR ? { dataDir: process.env.HOMES_DATA_DIR } : {}) });
const BASE = server.url;

const log = (...x) => console.log('[homes]', ...x);
const pageErrors = [];
const out = resultFile('homes', () => pageErrors);
const results = [];
let a;
let b;
let c;
let restarting = false;
let ctxC = null;
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  out.add(name, ok, detail);
  console.log(`[homes] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
    for (const [label, page] of [['A', a], ['B', b], ['C', c]]) {
      if (!page) continue;
      await shot(page, `fail-${name.split('.')[0]}-${label}`);
      if (await page.locator('[data-testid=build-done]').isVisible().catch(() => false)) await press(page, '[data-testid=build-done]').catch(() => undefined);
      await closePanel(page).catch(() => undefined);
    }
  }
}
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
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 82 }).catch((e) => log('screenshot failed', name, e.message));
}

const scene = interiorScene();
const NAME = 'Fern Cottage';
const BOARD = { kind: 'name_board', x: -19, z: 3, rot: 0, level: 0, variant: PIECES.name_board.variants[0].id, text: NAME };
const STAND = { x: -19.5, z: 5.5 };
const INSIDE_A = { x: -18.6, z: 1.7 };
const OUTSIDE_B = { x: -12.5, z: 6.5 };
/** B's spot on approach: 3 m south of the hut's front wall, beside the door. */
const APPROACH = { x: -17.6, z: 6.0 };
/** In front of the door, clear of the board and the doorstep (click-to-move routes in and out from here). */
const DOORSTEP = { x: -18.8, z: 5.4 };
/** Where A goes once it leaves (well outside the room). */
const AWAY_A = { x: -13.5, z: 4.5 };
/** B's own floor tile for the forged request: the first spot near B that the shared rules accept (open meadow). */
function floorSpotNear(p, pieces) {
  const index = new PieceIndex();
  for (const q of pieces) index.add(q);
  const variant = PIECES.floor.variants[0].id;
  const cands = [];
  for (let dx = -5; dx <= 5; dx += 2) for (let dz = -5; dz <= 5; dz += 2) cands.push({ x: Math.round(p.x) + dx + (Math.round(p.x) % 2 === 0 ? 1 : 0), z: Math.round(p.z) + dz + (Math.round(p.z) % 2 === 0 ? 1 : 0) });
  cands.sort((u, v) => Math.hypot(u.x - p.x, u.z - p.z) - Math.hypot(v.x - p.x, v.z - p.z));
  for (const c of cands) {
    if (Math.hypot(c.x - p.x, c.z - p.z) < 2) continue; // not under B's feet
    const v = validatePlacement({ kind: 'floor', variant, x: c.x, z: c.z, rot: 0, level: 0 }, { index, builderId: 'B', builderPos: p, players: [p], collision: defaultCollisionWorld() });
    if (v.ok) return { kind: 'floor', x: c.x, z: c.z, variant };
  }
  throw new Error(`no buildable floor spot near (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
}
const findPiece = (pieces, p) => pieces.find((q) => q.kind === p.kind && q.x === p.x && q.z === p.z && q.level === (p.level ?? 0) && (p.rot === undefined || q.rot === p.rot));
const homesOf = (s) => s?.homes?.homes ?? [];
const nameOf = (s, sid) => s.players.find((p) => p.id === sid)?.name;
let idA = '';
let pidA = '';
let nameA = '';
let doorId = '';

async function build(page, item, opts = {}) {
  await choosePiece(page, item.kind, { category: PIECES[item.kind].category, variant: item.variant });
  if (!PIECES[item.kind].mount && PIECES[item.kind].param !== 'roof') await rotateTo(page, item.rot ?? 0);
  const p = await placeHere(page, item.x, item.z, opts.y, { level: item.level ?? 0, aim: opts.aim });
  assert(p.kind === item.kind && p.x === item.x && p.z === item.z && p.level === (item.level ?? 0) && (item.rot === undefined || p.rot === item.rot), `placed ${JSON.stringify(p)} for ${JSON.stringify(item)}`);
  return p;
}
async function buildRoof(page, roof) {
  await choosePiece(page, 'house_roof', { category: 'roof', variant: roof.variant });
  await press(page, '[data-testid=build-roof-gable]');
  await press(page, '[data-testid=build-pitch-1]');
  const st0 = await buildState(page);
  if (st0.rot % 2 !== roof.rot % 2) await press(page, '[data-testid=build-rotate]');
  const below = st0.pieces.filter((p) => p.level === roof.level - 1 && PIECES[p.kind].structural && Math.abs(p.x - roof.x) <= roof.params.w / 2 + 0.5 && Math.abs(p.z - roof.z) <= roof.params.d / 2 + 0.5);
  const top = Math.max(...below.map((p) => p.y)) + CONFIG.building.storeyHeight;
  const g = await aimGhost(page, roof.x, roof.z, top, { level: roof.level });
  const params = JSON.parse(g.build.ghost.params);
  assert(g.build.ghost.ok && params.w === roof.params.w && params.d === roof.params.d, `roof ghost ${JSON.stringify(g.build.ghost)}`);
  return placeHere(page, roof.x, roof.z, top, { level: roof.level });
}
/** The name board on the doorway's outside face (pointed at above the door, as a player would). */
async function hangBoard(page) {
  await choosePiece(page, BOARD.kind, { category: 'sign', variant: BOARD.variant });
  await page.fill('[data-testid=build-sign-text]', BOARD.text);
  const door = findPiece((await buildState(page)).pieces, { kind: 'doorway', x: BOARD.x, z: BOARD.z, level: 0 });
  const pt = await screenOf(page, door.x, door.z + 0.13, door.y + 2.35);
  await page.mouse.move(pt.x, pt.y, { steps: 2 });
  const g = await waitSnap(page, (x) => x.build.ghost && x.build.ghost.x === door.x && x.build.ghost.z === door.z && x.build.ghost.rot === BOARD.rot, 'board ghost on the doorway face', 15_000);
  assert(g.build.ghost.ok, `board ghost refused: ${g.build.ghost.message}`);
  const ok0 = g.build.stats.results.ok;
  await page.mouse.click(pt.x, pt.y);
  const st = await waitSnap(page, (x) => x.build.stats.results.ok > ok0, 'board placed', 20_000);
  const p = st.build.pieces.find((q) => q.kind === BOARD.kind);
  assert(p && p.text === NAME && p.x === door.x && p.z === door.z, `board ${JSON.stringify(p)}`);
  return p;
}
/** Remove tool → pick one of your house's pieces (desktop click) → the selection card. */
async function selectOwn(page, piece, yUp) {
  if ((await buildState(page)).mode !== 'remove') await press(page, '[data-testid=build-tool-remove]');
  await waitSnap(page, (s) => s.build.mode === 'remove', 'remove tool', 10_000);
  const pt = await screenOf(page, piece.x, piece.z, piece.y + yUp);
  await tapOrClick(page, pt.x, pt.y);
  await page.waitForSelector('[data-testid=build-selected][data-owner=me]', { timeout: 15_000 });
  const sel = (await buildState(page)).selected;
  return sel;
}
/** The make-home flow through the selection card. Resolves with A's home as A's snapshot lists it. */
async function makeHome(page, piece, yUp) {
  const sel = await selectOwn(page, piece, yUp);
  await page.waitForSelector('[data-testid=home-make]', { timeout: 15_000 });
  await press(page, '[data-testid=home-make]');
  const s = await waitSnap(page, (x) => x.homes?.mine && x.homes.result?.ok, 'home made', 20_000);
  await page.waitForSelector('[data-testid=home-is-yours]', { timeout: 10_000 });
  return { home: s.homes.mine, selected: sel };
}
async function openHomePanel(page) {
  if (!(await page.$('[data-testid=panel-home]'))) await press(page, '[data-testid=nav-home]');
  await page.waitForSelector('[data-testid=home-panel]', { timeout: 15_000 });
}
async function openMap(page) {
  if (!(await page.$('[data-testid=panel-map]'))) await press(page, '[data-testid=nav-map]');
  await page.waitForSelector('[data-testid=panel-map]', { timeout: 20_000 });
}
const pinSel = (pid) => `[data-testid=map-home-${pid}]`;
async function promptText(page) {
  return ((await page.textContent('[data-testid=build-name-prompt]').catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
}
/** Tap (touch) / click another player's character until their player card opens. */
async function openPlayerCard(page, sessionId) {
  const kind = page.__touch ? 'touch' : 'mouse';
  for (let i = 0; i < 30; i++) {
    const s = await snap(page);
    const p = s.players.find((q) => q.id === sessionId);
    assert(p, `no player ${sessionId} in B's room state`);
    const at = await query(page, 'worldToScreen', p.x, p.z);
    if (at) {
      for (const dy of [30, 40, 20, 50, 12, 60]) {
        const pk = await query(page, 'pick', at.x, at.y - dy, kind);
        if (pk?.kind === 'player' && pk.id === sessionId && (await onCanvas(page, at.x, at.y - dy))) {
          await tapOrClick(page, at.x, at.y - dy);
          if (await page.waitForSelector('[data-testid=player-card]', { timeout: 6000 }).then(() => true, () => false)) return;
          break;
        }
      }
    }
    await sleep(500);
  }
  throw new Error(`could not open the player card of ${sessionId}`);
}
/** A protocol client holding an existing session token (a "modified client"). */
async function forger(token) {
  const room = await new Client(BASE).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token });
  const got = [];
  room.onMessage('home_result', (m) => got.push(m));
  room.onMessage('*', () => undefined);
  const ask = async (type, payload) => {
    const n = got.length;
    room.send(type, payload);
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000) {
      if (got.length > n) return got[n];
      await sleep(50);
    }
    throw new Error(`no answer to forged ${type}`);
  };
  return { room, ask };
}

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`server ${BASE}${env.CLIENT_DIST ? `; client ${env.CLIENT_DIST}` : ''}; shots ${SHOTS ?? 'none'}`);
await server.start();
log(`data dir ${server.dataDir}`);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
await ctxA.addInitScript(LOW_GFX);
await ctxB.addInitScript(LOW_GFX);
a = await ctxA.newPage();
b = await ctxB.newPage();
b.__touch = true;
watch(a, 'A(desktop)');
watch(b, 'B(phone)');

try {
  await check('setup: A and B join; the Home panel says how to make a home (desktop and phone)', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.homes?.synced && s.navReady, 'A ready');
    await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.homes?.synced && s.navReady, 'B ready');
    idA = sa.sessionId;
    nameA = nameOf(sa, idA);
    for (const [page, label] of [[a, 'desktop'], [b, 'phone']]) {
      await openHomePanel(page);
      assert((await page.getAttribute('[data-testid=home-panel]', 'data-has-home')) === 'no', `${label}: panel claims a home`);
      const how = (await page.textContent('[data-testid=home-howto]')) ?? '';
      assert(/Make this my home/.test(how), `${label}: no how-to (${how})`);
      const planned = await page.$$eval('[data-testid=home-planned] li', (els) => els.map((e) => e.textContent ?? ''));
      assert(planned.length === 5 && planned.every((t) => t.startsWith('Planned')) && !planned.some((t) => /A home of your own/.test(t)), `${label}: planned cards ${JSON.stringify(planned)}`);
      await shot(page, `home-panel-none-${label}`);
      await closePanel(page);
    }
    return `A=${idA} (${nameA}); both panels: how-to + ${5} Planned cards (no "A home of your own")`;
  });

  await check('1. A builds a hut through the real UI and makes it home; both snapshots list the home', async () => {
    await hopToward(b, OUTSIDE_B, 1.2);
    await hopToward(a, STAND, 1.0);
    await zoomOut(a, 2);
    await openBuild(a);
    const order = [...scene.hutWalls.north, ...scene.hutWalls.west, ...scene.hutWalls.east, ...scene.hutWalls.south];
    for (const w of order) await build(a, w);
    const roof = await buildRoof(a, scene.hutRoof);
    const board = await hangBoard(a);
    const st = await buildState(a);
    const win = findPiece(st.pieces, scene.hutWalls.south[1]);
    const { home } = await makeHome(a, win, 1.4);
    pidA = home.profileId;
    doorId = home.doorPieceId;
    const door = findPiece(st.pieces, scene.hutWalls.south[0]);
    assert(doorId === door.id && home.name === NAME && home.ownerName === nameA && home.pinned === false, `A's home ${JSON.stringify(home)}`);
    assert(JSON.stringify(home.rect) === JSON.stringify({ minX: HUT.x0, maxX: HUT.x1, minZ: HUT.z0, maxZ: HUT.z1 }), `rect ${JSON.stringify(home.rect)}`);
    await shot(a, 'make-home-card-desktop');
    await closeBuild(a);
    const sb = await waitSnap(b, (s) => homesOf(s).some((h) => h.profileId === pidA), 'B lists A’s home', 20_000);
    const hb = homesOf(sb).find((h) => h.profileId === pidA);
    const sa = await snap(a);
    assert(homesOf(sa).length === 1 && homesOf(sb).length === 1, `homes: A ${homesOf(sa).length}, B ${homesOf(sb).length}`);
    assert(hb.doorPieceId === doorId && hb.name === NAME && hb.ownerName === nameA && hb.pinned === false && JSON.stringify(hb.rect) === JSON.stringify(home.rect), `B sees ${JSON.stringify(hb)}`);
    // The Home panel now shows the home (desktop).
    await openHomePanel(a);
    assert((await a.getAttribute('[data-testid=home-panel]', 'data-has-home')) === 'yes', 'A panel: no home');
    const nm = (await a.textContent('[data-testid=home-name]')) ?? '';
    const place = (await a.textContent('[data-testid=home-place]')) ?? '';
    assert(nm.trim() === NAME && /4 × 4 m/.test(place), `A panel "${nm}" / "${place}"`);
    assert((await a.getAttribute('[data-testid=home-pin]', 'aria-checked')) === 'false', 'pin is on by default');
    await shot(a, 'home-panel-home-desktop');
    // The same panel at phone width (A's page at 412 x 915), then back.
    await a.setViewportSize({ width: 412, height: 915 });
    await sleep(600);
    await shot(a, 'home-panel-home-phone');
    await a.setViewportSize({ width: 1440, height: 900 });
    await sleep(400);
    await closePanel(a);
    return `${order.length} walls + roof ${roof.id} + board ${board.id}; selected the window wall → home door ${doorId}, "${home.name}", rect ${home.rect.minX}..${home.rect.maxX} × ${home.rect.minZ}..${home.rect.maxZ}; listed on A and B (pinned false)`;
  });

  await check('2. B walks up by tap-to-move and sees "· A’s home · 1 inside" while A stands inside, and no count once A leaves', async () => {
    // A walks in through the doorway (click-to-move); server position inside the room.
    await hopToward(a, DOORSTEP, 1.0);
    await hopToward(a, INSIDE_A, 0.45, 120_000);
    const inA = (await snap(a)).players.find((p) => p.id === idA);
    assert(inA.x > HUT.x0 && inA.x < HUT.x1 && inA.z > HUT.z0 && inA.z < HUT.z1, `A (server) not inside: ${inA.x}, ${inA.z}`);
    await hopToward(b, APPROACH, 0.9);
    const want = `${homeLabel(NAME, nameA)} · 1 inside`;
    await b.waitForSelector('[data-testid=build-name-prompt]', { timeout: 20_000 });
    const t0 = Date.now();
    let label = '';
    while (Date.now() - t0 < 15_000) {
      label = await promptText(b);
      if (label === want) break;
      await sleep(200);
    }
    assert(label === want, `B's prompt "${label}", want "${want}"`);
    const sb = await snap(b);
    assert(homesOf(sb).find((h) => h.profileId === pidA)?.inside === 1, `B's count ${JSON.stringify(homesOf(sb))}`);
    await shot(b, 'approach-label-phone');
    // A leaves: the count goes (nothing shown for 0).
    await hopToward(a, DOORSTEP, 1.0, 120_000);
    await hopToward(a, AWAY_A, 0.9);
    const bare = homeLabel(NAME, nameA);
    const t1 = Date.now();
    while (Date.now() - t1 < 15_000) {
      label = await promptText(b);
      if (label === bare) break;
      await sleep(200);
    }
    assert(label === bare, `after A left B's prompt "${label}", want "${bare}"`);
    return `with A inside: "${want}"; A outside: "${label}"`;
  });

  await check('3. B’s map has no pin by default; A switches it on; B’s map shows the pin within 2 s', async () => {
    await openMap(b);
    await sleep(500);
    assert(!(await b.$('[data-testid^=map-home-]')), 'B sees a pin before A switched it on');
    await openHomePanel(a);
    // Latency measured in the pages (one machine, one clock): A's click on the toggle → the pin in B's DOM.
    await a.evaluate(() => {
      window.__homePinClickAt = 0;
      document.querySelector('[data-testid=home-pin]').addEventListener('click', () => (window.__homePinClickAt = Date.now()), { capture: true, once: true });
    });
    await b.evaluate((sel) => {
      window.__homePinSeenAt = 0;
      const look = () => {
        if (!window.__homePinSeenAt && document.querySelector(sel)) window.__homePinSeenAt = Date.now();
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true });
    }, pinSel(pidA));
    await a.click('[data-testid=home-pin]');
    await b.waitForSelector(pinSel(pidA), { timeout: 15_000 });
    const clickAt = await a.evaluate(() => window.__homePinClickAt);
    const seenAt = await b.evaluate(() => window.__homePinSeenAt);
    assert(clickAt > 0 && seenAt > 0, `timestamps click ${clickAt} seen ${seenAt}`);
    const ms = seenAt - clickAt;
    assert(ms <= 2000, `pin appeared on B ${ms} ms after A's click (limit 2000 ms)`);
    const label = await b.getAttribute(pinSel(pidA), 'data-label');
    assert(label === `${NAME} · ${nameA}`, `pin label "${label}"`);
    assert((await a.getAttribute('[data-testid=home-pin]', 'aria-checked')) === 'true', 'A toggle not on');
    await shot(b, 'map-pin-phone');
    await closePanel(a);
    return `no pin before; pin "${label}" on B ${ms} ms after A's click (in-page clocks)`;
  });

  await check('4. B blocks A: B’s map loses the pin; B unblocks A: the pin is back', async () => {
    await closePanel(b);
    await openPlayerCard(b, idA);
    await press(b, '[data-testid=player-card] .action:has-text("Block")');
    await press(b, '[data-testid=confirm-block]');
    await b.waitForSelector('[data-testid=player-card] .action:has-text("Unblock")', { timeout: 10_000 });
    await closePanel(b);
    await waitSnap(b, (s) => homesOf(s).find((h) => h.profileId === pidA)?.pinned === false, 'B: A’s home unpinned', 10_000);
    await openMap(b);
    await sleep(500);
    assert(!(await b.$(pinSel(pidA))), 'pin still on B’s map after blocking');
    // A still sees its own pin on.
    assert(homesOf(await snap(a)).find((h) => h.profileId === pidA)?.pinned === true, 'A lost its own pin');
    await closePanel(b);
    // Unblock from Settings (the blocked list), as a player would.
    await press(b, '[data-testid=nav-settings]');
    await b.waitForSelector('[data-testid=list-blocked]', { timeout: 15_000 });
    await press(b, '[data-testid=list-blocked] button:has-text("Unblock")');
    await b.waitForSelector('[data-testid=list-blocked]', { state: 'detached', timeout: 10_000 });
    await closePanel(b);
    await openMap(b);
    await b.waitForSelector(pinSel(pidA), { timeout: 10_000 });
    await closePanel(b);
    return 'blocked → no pin on B (A’s own pin stays on); unblocked in Settings → pin back';
  });

  await check('5. A removes the roof: the home is cleared on both and A sees the notice', async () => {
    await hopToward(a, STAND, 1.0);
    await openBuild(a);
    const roof = (await buildState(a)).pieces.find((p) => p.kind === 'house_roof');
    await selectOwn(a, roof, 1.0);
    const toast = a.waitForSelector('[data-testid=toast]:has-text("no longer your home")', { timeout: 20_000 });
    await a.click('[data-testid=build-remove]');
    const t = await toast;
    const text = ((await t.textContent()) ?? '').trim();
    assert(/roof/.test(text), `notice "${text}"`);
    await waitSnap(a, (s) => !s.homes?.mine && !homesOf(s).length && !s.build.pieces.some((p) => p.id === roof.id), 'A: home cleared', 20_000);
    await waitSnap(b, (s) => !homesOf(s).some((h) => h.profileId === pidA), 'B: home cleared', 20_000);
    await closeBuild(a);
    return `roof ${roof.id} removed; A notice "${text}"; cleared on A and B`;
  });

  await check('6. A re-roofs and makes it home again; after a server restart the home and pin are intact; late joiner C sees label and pin', async () => {
    await openBuild(a);
    const roof = await buildRoof(a, scene.hutRoof);
    const { home } = await makeHome(a, roof, 1.0);
    assert(home.doorPieceId === doorId && home.pinned === false, `home again ${JSON.stringify(home)} (a new home starts unpinned)`);
    await closeBuild(a);
    await openHomePanel(a);
    await a.click('[data-testid=home-pin]');
    await waitSnap(a, (s) => s.homes?.mine?.pinned === true, 'A pin on', 10_000);
    await waitSnap(b, (s) => homesOf(s).find((h) => h.profileId === pidA)?.pinned === true, 'B sees it pinned', 10_000);
    await closePanel(a);
    // Restart.
    restarting = true;
    await server.restart();
    await a.reload();
    await b.reload();
    const ready = (s) => s.connection === 'connected' && s.build?.synced && s.homes?.synced;
    const sa = await waitSnap(a, (s) => ready(s) && s.homes.mine, 'A home after restart', 90_000);
    const sb = await waitSnap(b, (s) => ready(s) && homesOf(s).some((h) => h.profileId === pidA), 'B home after restart', 90_000);
    restarting = false;
    const ha = sa.homes.mine;
    const hb = homesOf(sb).find((h) => h.profileId === pidA);
    // A guest that reloads with ?autojoin=1 may come back under a new random name: the home follows its owner's current name.
    const before = nameA;
    nameA = nameOf(sa, sa.sessionId);
    idA = sa.sessionId;
    await waitSnap(b, (s) => homesOf(s).find((h) => h.profileId === pidA)?.ownerName === nameA, `B sees the owner name ${nameA}`, 20_000);
    assert(ha.ownerName === nameA, `A's home owner name ${ha.ownerName}, A is now ${nameA}`);
    assert(ha.doorPieceId === doorId && ha.pinned && ha.name === NAME, `A after restart ${JSON.stringify(ha)}`);
    assert(hb.doorPieceId === doorId && hb.pinned && hb.name === NAME, `B after restart ${JSON.stringify(hb)}`);
    // Late joiner.
    ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxC.addInitScript(LOW_GFX);
    c = await ctxC.newPage();
    watch(c, 'C(late)');
    await c.goto(`${BASE}/?autojoin=1`);
    const sc = await waitSnap(c, (s) => s.local?.ready && ready(s) && s.navReady && homesOf(s).some((h) => h.profileId === pidA), 'C has the home', 90_000);
    const hc = homesOf(sc).find((h) => h.profileId === pidA);
    assert(hc.pinned && hc.doorPieceId === doorId && hc.ownerName === nameA, `C sees ${JSON.stringify(hc)}`);
    await openMap(c);
    await c.waitForSelector(pinSel(pidA), { timeout: 10_000 });
    await shot(c, 'map-pin-desktop');
    await closePanel(c);
    await hopToward(c, { x: -16.4, z: 6.2 }, 1.0);
    const want = homeLabel(NAME, nameA);
    const t0 = Date.now();
    let label = '';
    while (Date.now() - t0 < 20_000) {
      label = await promptText(c);
      if (label === want) break;
      await sleep(200);
    }
    assert(label === want, `C's prompt "${label}", want "${want}"`);
    await shot(c, 'approach-label-desktop');
    // C's part is done: close it (three software-rendered pages at once starve the phone page).
    await ctxC.close();
    c = null;
    return `re-roofed (${roof.id}); home + pin intact on A and B after restart (owner name ${before === nameA ? 'unchanged' : `${before} → ${nameA} on both`}); C: pin on map, prompt "${label}"`;
  });

  await check('7. a forged homeSet from B on A’s house, and one on a bare floor tile, are refused with reasons', async () => {
    if (ctxC) {
      await ctxC.close().catch(() => undefined);
      ctxC = null;
      c = null;
    }
    // B lays a floor tile by touch (its own piece, no house), on open land beside it.
    await openBuild(b);
    const sb0 = await snap(b);
    const B_FLOOR = floorSpotNear(sb0.local, sb0.build.pieces);
    await choosePiece(b, B_FLOOR.kind, { category: PIECES.floor.category, variant: B_FLOOR.variant });
    const floor = await placeHere(b, B_FLOOR.x, B_FLOOR.z, undefined, { level: 0 });
    await press(b, '[data-testid=build-done]');
    const token = await b.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
    assert(token, 'no session token in B');
    const f = await forger(token);
    let r1;
    let r2;
    try {
      r1 = await f.ask('home_set', { pieceId: doorId });
      r2 = await f.ask('home_set', { pieceId: floor.id });
    } finally {
      await f.room.leave().catch(() => undefined);
    }
    assert(r1 && !r1.ok && r1.reason === 'not_owner' && r1.text, `forged set on A's house: ${JSON.stringify(r1)}`);
    assert(r2 && !r2.ok && r2.reason === 'not_a_house' && r2.text, `forged set on a floor tile: ${JSON.stringify(r2)}`);
    await sleep(800);
    const sa = await snap(a);
    assert(sa.homes.mine?.doorPieceId === doorId && homesOf(sa).length === 1, `homes changed: ${JSON.stringify(homesOf(sa))}`);
    return `on A's door → ${r1.reason} ("${r1.text}"); on B's floor ${floor.id} → ${r2.reason} ("${r2.text}"); A's home unchanged, nobody else has one`;
  });

  await check('8. zero console / page errors on every page', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  record('script', false, String(err?.stack ?? err));
} finally {
  if (ctxC) await ctxC.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`[homes] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
