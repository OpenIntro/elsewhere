#!/usr/bin/env node
/**
 * Cross-feature end to end: walk-in interiors × player building × building
 * activities, with two REAL browser clients against the REAL production build
 * (Playwright; global install loaded with createRequire).
 *
 *   npm run build && npm run e2e:combined
 *
 * Spawns its own production server (`node server/dist/index.js`, PORT
 * $COMB_PORT or 2636, fresh DATA_DIR in the OS temp dir unless
 * $COMB_DATA_DIR), restarts it once mid-run on the same DATA_DIR. Client A:
 * desktop 1440×900 (mouse + keyboard). Client B: Pixel 7 emulation (touch),
 * resized to 390×844 and 844×390 for the mobile layout check. Both join with
 * `?autojoin=1` and low graphics (headless WebGL is software-rendered; this
 * changes rendering cost only).
 *
 * Server env: DAY_LENGTH_MINUTES=480 so the world clock (a fresh world starts
 * at 07:12) stays inside the keepers' opening hours for the whole run — the
 * checks need a barista on duty. Everything else uses the defaults.
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  0. both clients join the same world; online count 2 on both
 *  1. build mode refuses interiors, door aprons, keeper routes and activity
 *     stations with a visible reason (and never sends them); the server
 *     refuses the same spots from a modified client; the shared rulebook has
 *     no buildable point in any footprint / apron / keeper route / station
 *  2. a player-built wall line near (legally outside) the Café door apron does
 *     not seal it: click-to-move (client A*) routes A in and out, the script's
 *     A* (with the pieces) too; keepers (server-moved) keep their route; no
 *     door of any building can be sealed by any legal placement (rulebook)
 *  3. inside the Café with the cutaway open: the barista is drawn with its
 *     KEEPER tag, B's name tag and speech bubble show on A, and the online
 *     count is exactly 2 on both while keepers are on duty
 *  4. build mode toggled indoors: the ghost is refused with a visible reason,
 *     nothing is sent, E does nothing; leaving build mode restores E on the
 *     barista (keeper panel opens)
 *  5. holding a café drink, A enters build mode, places a piece outdoors and
 *     leaves: the drink is still in hand (sippable) or cleanly gone, nothing stuck
 *  6. server restart with built pieces, a pinned notice, workshop progress and
 *     a lit hearth: both clients reload and everything is back; the fresh DB
 *     holds exactly migrations 1-5. (6b, only with $COMB_LEGACY_DATA_DIR: a DB
 *     made by an older server boots, migrates to 1-5 and resumes its profile.)
 *  7. mobile 390×844 and 844×390: bottom nav, Build button, build dock, chat
 *     preview, joystick, drink chip and the keeper panel do not block each
 *     other's controls (hit-tested); screenshots to $COMB_SHOTS
 *  8. zero console / page errors in both clients
 *
 * Env: COMB_PORT, COMB_DATA_DIR, COMB_SHOTS (screenshot dir, default
 * docs/screenshots/combined; "0" disables), COMB_LEGACY_DATA_DIR (+ optional
 * qa-token.txt / qa-profile.txt / qa-secret.txt inside it), COMB_VERBOSE=1, COMB_ONLY=<ids> (debugging:
 * only those checks; such a run exits 1).
 *
 * Nothing here simulates players: every action is a real input in a real page.
 * The forged messages in check 1 come from a protocol client holding A's own
 * session token — exactly what a modified client could send.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@colyseus/sdk';
import {
  CONFIG,
  INTERIORS,
  KEEPERS,
  PIECES,
  PieceIndex,
  ROOM_NAME,
  STATIONS,
  buildableAt,
  buildingLocal,
  defaultCollisionWorld,
  getBuilding,
  getInteractable,
  getInterior,
  interiorAnchor,
  interiorAt,
  isWalkable,
  pieceColliders,
  snapToGrid,
  validatePlacement,
  zoneContains,
} from '@elsewhere/shared';
import { keyboardRoute, route } from './lib/browser.mjs';
import { createServer } from './lib/server.mjs';
import { resultFile, shotsDir } from './lib/report.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.COMB_PORT ?? 2636);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.COMB_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-combined-'));
const SHOTS = shotsDir(process.env.COMB_SHOTS, 'docs/screenshots/combined', ROOT);
const SECRET = randomBytes(32).toString('hex');
const SERVER_ENV = { NODE_ENV: 'production', DATA_DIR, SESSION_SECRET: SECRET, DAY_LENGTH_MINUTES: '480' };
const T = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[combined]', ...a);
const results = [];
const resultOut = resultFile('combined', () => pageErrors);
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  resultOut.add(name, ok, detail);
  console.log(`[combined] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
let a = null;
let b = null;
/** Debugging aid: COMB_ONLY="6b,8" runs only those checks (such a run never counts as a pass). */
const ONLY = process.env.COMB_ONLY ? new Set(process.env.COMB_ONLY.split(',').map((x) => x.trim())) : null;
async function check(name, fn) {
  if (ONLY && !ONLY.has(name.split('.')[0])) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
    for (const [label, p] of [['A', a], ['B', b]]) if (p) await shot(p, `fail-${name.split('.')[0]}-${label}`);
    await settle(a);
    await settle(b);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function makeServer(port, env) {
  return createServer({ port, env, label: 'combined', verbose: !!process.env.COMB_VERBOSE, logPrefix: `[server:${port}] ` });
}
const server = makeServer(PORT, SERVER_ENV);

/** Migration ids recorded in a (stopped) server's PGlite database. */
async function migrationsIn(dataDir) {
  const { PGlite } = await import(pathToFileURL(createRequire(path.join(ROOT, 'server/package.json')).resolve('@electric-sql/pglite')).href);
  const db = await PGlite.create(path.join(dataDir, 'pglite'));
  try {
    const r = await db.query('SELECT id, name FROM schema_migrations ORDER BY id');
    return r.rows.map((x) => ({ id: Number(x.id), name: x.name }));
  } finally {
    await db.close();
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
const pageErrors = [];
let restarting = false;
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // The planned server restart: the websocket drops and reconnect attempts fail until it is back.
    if (restarting && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|Failed to fetch|net::|matchmake|reconnect|\[net\]/i.test(t)) return;
    pageErrors.push(`${label} console.error: ${t}`);
  });
}
const snap = (page) => page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
const query = (page, name, ...args) => page.evaluate(([n, x]) => window.__ELSEWHERE__.query(n, ...x), [name, args]);
async function waitSnap(page, pred, label, timeout = T) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}; last local ${JSON.stringify(last?.local)} interior ${JSON.stringify(last?.interior)} build ${JSON.stringify(last?.build ? { mode: last.build.mode, ghost: last.build.ghost } : null)}`);
}
async function waitFor(fn, label, timeout = T) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn().catch((e) => `error ${e.message}`);
    if (last === true) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (${JSON.stringify(last)})`);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 70, scale: 'css' }).catch((e) => log('screenshot failed', name, e.message));
}
const where = (p) => interiorAt(p)?.id ?? 'outdoors';
const posOf = (s, id) => s.players.find((p) => p.id === id);
async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
}
async function screenOf(page, x, z, y) {
  const p = await query(page, 'worldToScreen', x, z, y);
  assert(p, `no screen point for (${x.toFixed(1)}, ${z.toFixed(1)})`);
  const vp = page.viewportSize();
  assert(p.x > 8 && p.y > 8 && p.x < vp.width - 8 && p.y < vp.height - 8, `(${x.toFixed(1)}, ${z.toFixed(1)}) is off screen at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
  assert(await onCanvas(page, p.x, p.y), `UI covers ${p.x.toFixed(0)},${p.y.toFixed(0)} (world ${x.toFixed(1)}, ${z.toFixed(1)})`);
  return p;
}
async function tapOrClick(page, x, y) {
  if (page.__touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
async function closePanel(page) {
  const btn = await page.$('[data-testid=sheet-close]');
  if (btn) await btn.click().catch(() => undefined);
  await sleep(250);
}
const online = async (page) => Number((await page.textContent('[data-testid=player-count]').catch(() => '0')) ?? '0');
async function statusOf(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=build-status]');
    return el ? { text: el.textContent ?? '', tone: el.getAttribute('data-tone') } : null;
  });
}
/** Let the script's own route planner (A*) see the built pieces, like the client's nav grid does. */
function learnPieces(list) {
  const dyn = defaultCollisionWorld().dynamic;
  dyn.clear();
  for (const p of list) dyn.set(p.id, pieceColliders(p));
}

/** Click/tap-to-move in hops towards a target (the camera follows), until close (or `reached`). */
async function hop(page, target, near = 1.2, timeout = 180_000, reached = null) {
  const vp = page.viewportSize();
  const t0 = Date.now();
  let stuck = 0;
  let prev = null;
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (Math.hypot(s.local.x - target.x, s.local.z - target.z) < near || (reached && reached(s))) return s;
    if (await page.$('[data-testid=sheet-close]')) await closePanel(page);
    if (prev && Math.hypot(s.local.x - prev.x, s.local.z - prev.z) < 0.2) stuck++;
    else stuck = 0;
    prev = { x: s.local.x, z: s.local.z };
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    const tp = await query(page, 'worldToScreen', target.x, target.z);
    let x = tp.x;
    let y = tp.y;
    const m = 0.2;
    const inside = (px, py) => px > vp.width * m && px < vp.width * (1 - m) && py > vp.height * m && py < vp.height * (1 - m);
    if (!inside(x, y)) {
      let k = 1;
      for (; k > 0.05; k -= 0.05) if (inside(me.x + (tp.x - me.x) * k, me.y + (tp.y - me.y) * k)) break;
      x = me.x + (tp.x - me.x) * k;
      y = me.y + (tp.y - me.y) * k;
    }
    if (stuck > 3) {
      await keyboardRoute(page, [target], { timeout: 90_000 }).catch(() => undefined);
      stuck = 0;
      continue;
    }
    if (!(await onCanvas(page, x, y))) y -= 40;
    for (let k = 0; k < 6; k++) {
      const pk = await query(page, 'pick', x, y, page.__touch ? 'touch' : 'mouse');
      if (!pk) break;
      x += (k % 2 ? -1 : 1) * (40 + k * 25);
      y -= 15;
    }
    await tapOrClick(page, x, y);
    await sleep(300);
    await waitSnap(page, (q) => !q.motion?.path && q.local.speed < 0.05, 'hop finished', 40_000);
  }
  const last = (await snap(page))?.local;
  throw new Error(`could not hop to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}); at (${last?.x?.toFixed(2)}, ${last?.z?.toFixed(2)}) in ${where(last ?? { x: 0, z: 0 })}`);
}
/** Walk like a person: into / out of a building through its door first, then to the spot. */
async function walkTo(page, target, near = 1.2, timeout = 240_000) {
  const to = interiorAt(target);
  const s = await snap(page);
  const from = interiorAt(s.local);
  if (from && from.id !== to?.id) {
    const door = from.doors[0];
    await keyboardRoute(page, [door.inside, door.outside], { timeout: 90_000 });
  }
  if (to && interiorAt((await snap(page)).local)?.id !== to.id) {
    const door = to.doors[0];
    const inside = (q) => interiorAt(q.local)?.id === to.id;
    const front = [3, 2, 1.2, 0].map((d) => ({ x: door.outside.x + Math.sin(door.yaw) * d, z: door.outside.z + Math.cos(door.yaw) * d })).find((p) => isWalkable(p, 0.5)) ?? door.outside;
    await hop(page, front, 2.5, timeout / 2, inside);
    if (!inside(await snap(page))) await keyboardRoute(page, [door.outside, door.inside], { timeout: 90_000 }).catch(() => undefined);
  }
  return hop(page, target, near, timeout);
}
/** Walk next to an interactable and click / tap it; wait for its panel (or `done`). */
async function useThing(page, id, { panel = null, approach = null, done = null, timeout = 60_000 } = {}) {
  const it = getInteractable(id);
  assert(it, `no interactable ${id}`);
  const interior = it.interiorId ? getInterior(it.interiorId) : null;
  await walkTo(page, approach ?? it.position, 1.3);
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeout) {
    if (panel && (await page.$(`[data-testid=${panel}]`))) return;
    const y = (interior?.floorY ?? 0) + 0.7;
    const p = await query(page, 'worldToScreen', it.position.x, it.position.z, y);
    if (p && (await onCanvas(page, p.x, p.y))) {
      const pick = await query(page, 'pick', p.x, p.y, page.__touch ? 'touch' : 'mouse');
      if (pick?.id === id) {
        await tapOrClick(page, p.x, p.y);
        if (done) {
          const t1 = Date.now();
          while (Date.now() - t1 < 12_000) {
            if (await done(await snap(page))) return;
            await sleep(400);
          }
          lastErr = 'no effect yet';
          continue;
        }
        if (!panel) return;
        try {
          await page.waitForSelector(`[data-testid=${panel}]`, { timeout: 25_000 });
          return;
        } catch {
          lastErr = `panel ${panel} did not open`;
        }
      } else lastErr = `pick ${JSON.stringify(pick)}`;
    } else lastErr = 'not on screen';
    await sleep(600);
  }
  throw new Error(`could not use ${id}: ${lastErr}`);
}

/**
 * Record (in A's page, from now on) when the bubble with `text` is visible over actor `id`, and when the
 * chat line arrives — a MutationObserver plus a rAF sampler, so a short-lived bubble is never missed
 * between two polls of the test.
 */
async function watchBubble(page, id, text) {
  await page.evaluate(([id, text]) => {
    const rec = { id, text, seenAt: null, goneAt: null, chatAt: null, t0: performance.now() };
    window.__bubbleRec = rec;
    const look = () => {
      const el = document.querySelector(`[data-actor="${id}"] .ew-bubble`);
      const on = !!el && !el.classList.contains('ew-off') && (el.textContent ?? '').includes(text) && Number(getComputedStyle(el.parentElement).opacity) > 0.05;
      const t = performance.now();
      if (on && rec.seenAt === null) rec.seenAt = t;
      if (!on && rec.seenAt !== null && rec.goneAt === null) rec.goneAt = t;
      if (rec.chatAt === null && (window.__ELSEWHERE__.snapshot().ui?.rawChat ?? []).some((m) => m.text === text)) rec.chatAt = t;
    };
    const mo = new MutationObserver(look);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['class', 'style'] });
    const tick = () => {
      look();
      if (performance.now() - rec.t0 < 30_000) requestAnimationFrame(tick);
      else mo.disconnect();
    };
    requestAnimationFrame(tick);
  }, [id, text]);
}
async function bubbleSeen(page, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await page.evaluate(() => window.__bubbleRec);
    if (r?.seenAt !== null && r?.seenAt !== undefined) {
      await sleep(200);
      const r2 = await page.evaluate(() => window.__bubbleRec);
      return { text: r2.text, afterMs: r2.chatAt !== null ? Math.round(r2.seenAt - r2.chatAt) : null, visibleMs: r2.goneAt !== null ? Math.round(r2.goneAt - r2.seenAt) : null };
    }
    await sleep(150);
  }
  return null;
}
async function zoomOut(page, steps = 2) {
  for (let i = 0; i < steps; i++) {
    const z0 = (await snap(page)).view.zoom;
    if (page.__touch) await page.click('button[aria-label="Zoom out"]');
    else await page.keyboard.press('Minus');
    await waitSnap(page, (s) => s.view.zoom < z0 - 0.5, 'zoomed out', 10_000).catch(() => undefined);
  }
}
/** Put a page back to plain play (no build mode, panel or chat) so one failed check cannot cascade. */
async function settle(page) {
  if (!page) return;
  try {
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    const s = await snap(page);
    if (s?.build?.mode && s.build.mode !== 'off' && (await page.$('[data-testid=build-done]'))) await page.click('[data-testid=build-done]');
    if (await page.$('[data-testid=sheet-close]')) await page.click('[data-testid=sheet-close]');
    if (await page.$('[data-testid=chat-close]')) await page.click('[data-testid=chat-close]');
  } catch {
    /* best effort */
  }
}

// Build UI (same real inputs as scripts/e2e-build.mjs).
async function openBuildKey(page) {
  if (!(await page.$('[data-testid=build-dock]'))) {
    if (page.__touch) await page.locator('[data-testid=nav-build]').tap();
    else await page.keyboard.press('KeyB');
  }
  await page.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
  await waitSnap(page, (s) => s.build?.synced && s.build.mode !== 'off', 'build mode on + synced', 30_000);
}
async function leaveBuild(page, how = 'done') {
  if (how === 'escape') await page.keyboard.press('Escape');
  else if (await page.$('[data-testid=build-done]')) {
    if (page.__touch) await page.locator('[data-testid=build-done]').tap();
    else await page.click('[data-testid=build-done]');
  }
  await waitSnap(page, (s) => s.build?.mode === 'off', 'build mode off', 15_000);
  await page.waitForSelector('[data-testid=nav-build]', { timeout: 10_000 });
}
async function choosePiece(page, kind, variant) {
  const st = (await snap(page)).build;
  if (st.mode !== 'place') await page.click('[data-testid=build-tool-remove]');
  await page.click(`[data-testid=build-tab-${PIECES[kind].category}]`);
  await page.click(`[data-testid=build-piece-${kind}]`);
  if (variant) await page.click(`[data-testid=build-variant-${variant}]`);
  await waitSnap(page, (s) => s.build?.kind === kind && s.build.mode === 'place', `piece ${kind} chosen`, 10_000);
}
async function rotateTo(page, rot) {
  for (let i = 0; i < 4; i++) {
    const st = (await snap(page)).build;
    if (st.rot === rot) return;
    await page.keyboard.press('KeyR');
    await waitSnap(page, (s) => s.build?.rot === (st.rot + 1) % 4, 'rotated', 10_000);
  }
  throw new Error(`could not rotate to ${rot}`);
}
/** Hover (mouse) the screen point of world (x, z) at height y; wait for a ghost near it. */
async function aimAt(page, x, z, y) {
  const p = await screenOf(page, x, z, y);
  if (page.__touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.move(p.x, p.y, { steps: 2 });
  return waitSnap(page, (s) => s.build?.ghost && Math.hypot(s.build.ghost.x - x, s.build.ghost.z - z) < 0.76, `ghost near (${x.toFixed(2)}, ${z.toFixed(2)})`, 20_000);
}
async function placeAt(page, x, z) {
  const s0 = await aimAt(page, x, z);
  assert(s0.build.ghost.ok && s0.build.ghost.x === x && s0.build.ghost.z === z, `ghost at (${x}, ${z}) not valid: ${JSON.stringify(s0.build.ghost)}`);
  const before = new Set(s0.build.pieces.map((p) => p.id));
  const okBefore = s0.build.stats.results.ok;
  if (page.__touch) await page.click('[data-testid=build-place]');
  else {
    const p = await screenOf(page, x, z);
    await page.mouse.click(p.x, p.y);
  }
  const s1 = await waitSnap(page, (s) => s.build.stats.results.ok > okBefore || (s.build.refusal && s.build.stats.results.refused > s0.build.stats.results.refused), 'server answer', 20_000);
  const added = s1.build.pieces.filter((p) => !before.has(p.id));
  assert(added.length === 1, `expected one new piece, got ${added.length}; refusal ${JSON.stringify(s1.build.refusal)}`);
  return added[0];
}
const sentCount = (s) => s.build.stats.results.ok + s.build.stats.results.refused + (s.build.pending ?? 0);

/** A protocol client joined with an existing session token (a "modified client"). */
async function forger(token, port = PORT) {
  const room = await new Client(`http://localhost:${port}`).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, token });
  const results = [];
  let welcome = null;
  room.onMessage('build_result', (m) => results.push(m));
  room.onMessage('welcome', (m) => (welcome = m));
  room.onMessage('*', () => undefined);
  let req = 5000;
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
  return { room, ask, welcome: () => welcome };
}

/**
 * Mobile layout: every visible control must be hit-testable at its centre
 * (not covered by another control). Controls under an open panel sheet are
 * listed separately (a sheet is modal by design).
 */
async function layoutReport(page) {
  return page.evaluate(() => {
    const sel = {
      nav: 'nav.nav',
      navBuild: '[data-testid=nav-build]',
      buildDock: '[data-testid=build-dock]',
      buildPanel: '[data-testid=build-dock] .build-panel',
      buildPlace: '[data-testid=build-place]',
      buildDone: '[data-testid=build-done]',
      buildRotate: '[data-testid=build-rotate]',
      buildStatus: '[data-testid=build-status]',
      chatPeek: '[data-testid=chat-peek]',
      joystick: '[data-testid=joystick]',
      touchAction: '[data-testid=touch-action]',
      drink: '[data-testid=drink-sip]',
      count: '[data-testid=player-count]',
      zoomOut: 'button[aria-label="Zoom out"]',
      sheet: '.sheet',
      sheetClose: '[data-testid=sheet-close]',
      order: '[data-testid=order-coffee]',
    };
    const vis = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return null;
      return r;
    };
    const found = {};
    for (const [k, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      const r = vis(el);
      if (r) found[k] = { el, r: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    }
    const sheet = found.sheet?.el ?? null;
    const blocked = [];
    const underSheet = [];
    const offscreen = [];
    const W = innerWidth;
    const H = innerHeight;
    for (const [k, f] of Object.entries(found)) {
      if (k === 'sheet' || k === 'nav' || k === 'buildDock' || k === 'buildPanel') continue; // containers
      const { r } = f;
      if (r.x < -1 || r.y < -1 || r.x + r.w > W + 1 || r.y + r.h > H + 1) offscreen.push(k);
      // the visible part's centre
      const cx = Math.min(Math.max(r.x + r.w / 2, 1), W - 1);
      const cy = Math.min(Math.max(r.y + r.h / 2, 1), H - 1);
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || f.el === hit || f.el.contains(hit)) continue;
      if (sheet && sheet.contains(hit) && !sheet.contains(f.el)) underSheet.push(k);
      else {
        const by = hit.closest('[data-testid]')?.getAttribute('data-testid') ?? hit.className?.toString().slice(0, 40) ?? hit.tagName;
        blocked.push(`${k} by ${by}`);
      }
    }
    // Geometric overlaps between separate controls (the round thumb controls as circles), 3 px tolerance.
    const cams = [...document.querySelectorAll('button[aria-label^="Turn view"], button[aria-label^="Zoom"]')].map((el) => vis(el)).filter(Boolean);
    const shapes = [];
    const add = (k, r, round = false) => r && shapes.push({ k, r, round });
    add('joystick', found.joystick?.r, true);
    add('touchAction', found.touchAction?.r, true);
    add('drink', found.drink?.r);
    add('chatPeek', found.chatPeek?.r);
    // the dock container is a tall flex column (status pill + panel): its visible panel is what counts
    add(found.buildPanel ? 'buildPanel' : 'nav', (found.buildPanel ?? found.nav)?.r);
    add('buildStatus', found.buildStatus?.r);
    cams.forEach((r, i) => add(`camera${i}`, { x: r.x, y: r.y, w: r.width, h: r.height }));
    const overlap = (a, b) => {
      const t = 3;
      if (a.round || b.round) {
        const [c, o] = a.round ? [a, b] : [b, a];
        const cx = c.r.x + c.r.w / 2;
        const cy = c.r.y + c.r.h / 2;
        const R = c.r.w / 2 - t;
        if (o.round) return Math.hypot(cx - (o.r.x + o.r.w / 2), cy - (o.r.y + o.r.h / 2)) < R + o.r.w / 2 - t;
        const nx = Math.max(o.r.x, Math.min(cx, o.r.x + o.r.w));
        const ny = Math.max(o.r.y, Math.min(cy, o.r.y + o.r.h));
        return Math.hypot(cx - nx, cy - ny) < R;
      }
      return a.r.x + t < b.r.x + b.r.w && b.r.x + t < a.r.x + a.r.w && a.r.y + t < b.r.y + b.r.h && b.r.y + t < a.r.y + a.r.h;
    };
    const overlaps = [];
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) if (overlap(shapes[i], shapes[j])) overlaps.push(`${shapes[i].k}×${shapes[j].k}`);
    const rects = Object.fromEntries(Object.entries(found).map(([k, f]) => [k, f.r]));
    return { W, H, rects, blocked, underSheet, offscreen, overlaps, scrollW: document.documentElement.scrollWidth };
  });
}

// ---------------------------------------------------------------------------
// Geometry for the checks (shared data, computed once)
// ---------------------------------------------------------------------------
const cafe = getInterior('cafe');
const cafeDoor = cafe.doors[0];
const barista = KEEPERS.find((k) => k.id === 'keeper_barista');
const keeperStop = (k, s) => (s.anchor ? interiorAnchor(k.interiorId, s.anchor).position : buildingLocal(getBuilding(k.interiorId), s.at[0], s.at[1]));
const baristaRoute = barista.route.map((s) => keeperStop(barista, s));
/** Where A stands to build by the Café: between the door apron and the wall line, outdoors. */
const STAND_A = { x: 21, z: -4.6 };
/** A line of walls 4-6 m in front of the Café door apron (legal: the apron + 1 m, paths, café tables and signs are protected). */
const WALL_LINE = [
  { x: 20, z: -3, rot: 0 },
  { x: 22, z: -3, rot: 0 },
  { x: 24, z: -3, rot: 0 },
  { x: 18, z: -4, rot: 0 },
];
/** Beyond the wall line, outdoors: B walks out of the Café to here and the route has to go round the walls. */
const BEYOND = { x: 21, z: -1.2 };

/** Static rulebook sweep: nothing protected for interiors / activities is buildable. */
function protectedSweep() {
  let n = 0;
  const bad = [];
  const test = (p, what) => {
    n++;
    if (buildableAt(p).code === 'ok') bad.push(`${what} (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
  };
  for (const k of KEEPERS) {
    const pts = k.route.map((s) => keeperStop(k, s));
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % pts.length];
      for (let t = 0; t <= 1.0001; t += 0.05) test({ x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t }, `${k.id} route`);
    }
    test(getInteractable(k.interactableId).position, `${k.id} talk spot`);
  }
  for (const s of STATIONS) test(getInteractable(s.id).position, s.id);
  for (const it of INTERIORS)
    for (const z of [it.footprint, ...it.doors.map((d) => d.apron)])
      for (let u = -1; u <= 1.0001; u += 0.1)
        for (let v = -1; v <= 1.0001; v += 0.1) {
          const lx = u * z.halfWidth;
          const lz = v * z.halfDepth;
          test({ x: z.center.x + lx * Math.cos(z.yaw) + lz * Math.sin(z.yaw), z: z.center.z - lx * Math.sin(z.yaw) + lz * Math.cos(z.yaw) }, `${it.id} zone`);
        }
  return { n, bad };
}
/**
 * Worst case for every door: treat EVERY buildable point as solid and flood-fill (player radius) from
 * the door's outside point. If the fill still escapes 14 m, no legal placement can seal that door.
 */
function sealAnalysis() {
  const G = 0.25;
  const R = 14;
  const r = CONFIG.movement.playerRadius + 0.06;
  const out = [];
  const free = (x, z) => {
    if (!isWalkable({ x, z }, r)) return false;
    for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) if (buildableAt({ x: x + ox, z: z + oz }).code === 'ok') return false;
    return true;
  };
  for (const it of INTERIORS)
    for (const d of it.doors) {
      const s = d.outside;
      const key = (i, j) => `${i},${j}`;
      const seen = new Set([key(Math.round(s.x / G), Math.round(s.z / G))]);
      const q = [[Math.round(s.x / G), Math.round(s.z / G)]];
      let escaped = false;
      while (q.length && !escaped) {
        const [i, j] = q.shift();
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di;
          const nj = j + dj;
          const k = key(ni, nj);
          if (seen.has(k)) continue;
          seen.add(k);
          const x = ni * G;
          const z = nj * G;
          if (Math.hypot(x - s.x, z - s.z) > R) {
            escaped = true;
            break;
          }
          if (interiorAt({ x, z })) continue;
          if (free(x, z)) q.push([ni, nj]);
        }
      }
      out.push({ door: d.id, escaped });
    }
  return out;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`data dir ${DATA_DIR}; server ${BASE}; DAY_LENGTH_MINUTES=480 (keepers on duty all run)`);
await server.start();
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
let idA = '';
let idB = '';
// User text carries an HTML/script payload: it must come back as plain text everywhere (never markup).
const XSS = '<img src=x onerror="window.__xss=1"><b>bold</b>';
const NOTICE = `Lantern walk ${XSS} at dusk ${Date.now() % 1000}`;
const SIGN_TEXT = `<i>Hi</i>${XSS}`.slice(0, CONFIG.building.signMaxLength);
let walls = [];
let crate = null;
let beforeRestart = null;

try {
  await check('0. both clients join the same world; online count 2 on both', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.navReady === true && s.build?.synced, 'A ready');
    const sb = await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.navReady === true && s.build?.synced, 'B ready');
    idA = sa.sessionId;
    idB = sb.sessionId;
    await a.mouse.click(720, 120);
    await b.touchscreen.tap(195, 140);
    await waitFor(async () => (await online(a)) === 2 && (await online(b)) === 2, 'online count 2');
    return `A=${idA}, B=${idB}`;
  });

  await check('1. build mode refuses interiors, door aprons, keeper routes and activity stations with a visible reason; never sent; the server refuses them too', async () => {
    const sweep = protectedSweep();
    assert(sweep.bad.length === 0, `buildable protected points: ${sweep.bad.slice(0, 6).join('; ')}`);
    await walkTo(a, STAND_A, 0.8);
    await zoomOut(a, 2);
    await openBuildKey(a);
    await choosePiece(a, 'crate', 'oak');
    // From outside (within BUILD_RANGE: range is checked first, so a far spot would only say "too far"):
    // the door apron and the floor just inside the door; then from the middle of the room: the
    // barista's route, its talk spot and the piano.
    const spots = [
      { what: 'Café door apron', p: cafeDoor.apron.center, label: /Café doorway/, from: 'outside' },
      { what: 'Café floor (inside the walls)', p: interiorAnchor('cafe', 'table_2').position, label: /Café/, from: 'outside' },
      { what: "barista's route (espresso machine)", p: baristaRoute[1], label: /Café/, from: 'inside' },
      { what: 'barista talk spot', p: getInteractable(barista.interactableId).position, label: /Café/, from: 'inside' },
      { what: 'piano station', p: getInteractable('station_cafe_piano').position, label: /Café/, from: 'inside' },
    ];
    const ROOM = cafe.footprint.center;
    const seen = [];
    const s0 = await snap(a);
    for (const sp of spots) {
      if (sp.from === 'inside' && where((await snap(a)).local) !== 'cafe') {
        await leaveBuild(a, 'escape');
        await walkTo(a, interiorAnchor('cafe', 'table_3').position, 1.0);
        await openBuildKey(a);
        await choosePiece(a, 'crate', 'oak');
      }
      const me = (await snap(a)).local;
      const g = snapToGrid('crate', sp.p, 0);
      assert(Math.hypot(g.x - me.x, g.z - me.z) < CONFIG.building.range - 0.3, `${sp.what} is ${Math.hypot(g.x - me.x, g.z - me.z).toFixed(1)} m from A (beyond BUILD_RANGE)`);
      const y = interiorAt(g) ? cafe.floorY : undefined;
      const s = await aimAt(a, g.x, g.z, y);
      const gh = s.build.ghost;
      assert(!gh.ok, `${sp.what}: ghost at (${gh.x}, ${gh.z}) is valid`);
      const inZone = zoneContains(cafe.footprint, gh, 1.0) || zoneContains(cafeDoor.apron, gh, 1.0);
      assert(inZone, `${sp.what}: the ghost landed at (${gh.x}, ${gh.z}), not on the Café / its apron`);
      const st = await statusOf(a);
      assert(st?.tone === 'bad' && sp.label.test(st.text), `${sp.what}: status ${JSON.stringify(st)}`);
      const p = await screenOf(a, gh.x, gh.z, y);
      await a.mouse.click(p.x, p.y); // a click on a refused ghost explains, never sends
      await sleep(500);
      const st2 = await statusOf(a);
      assert(st2?.tone === 'bad' && sp.label.test(st2.text), `${sp.what}: after the click the status is ${JSON.stringify(st2)}`);
      seen.push(`${sp.what} → "${st.text.trim()}"`);
      if (sp === spots[0]) await shot(a, 'c1-refused-apron');
      if (sp === spots[4]) await shot(a, 'c1-refused-piano-indoors');
    }
    void ROOM;
    const s1 = await snap(a);
    assert(sentCount(s1) === sentCount(s0) && s1.build.count === s0.build.count, `a request reached the server (${sentCount(s0)} → ${sentCount(s1)})`);
    // The same spots from a modified client holding A's own session.
    const token = await a.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
    assert(token, 'no session token on A');
    const f = await forger(token);
    const forged = [];
    try {
      await sleep(500);
      for (const sp of spots) {
        const g = snapToGrid('crate', sp.p, 0);
        const r = await f.ask('build_place', { kind: 'crate', variant: 'oak', x: g.x, z: g.z, rot: 0, level: 0 });
        assert(!r.ok && r.reason === 'protected', `forged place on the ${sp.what} (from inside the café): ${JSON.stringify(r)}`);
        forged.push(`${sp.what}: ${r.reason}`);
      }
    } finally {
      await f.room.leave().catch(() => undefined);
    }
    await sleep(600);
    assert((await snap(a)).build.count === 0 && (await snap(b)).build.count === 0, 'a piece appeared');
    await leaveBuild(a, 'escape');
    return `rulebook: 0 of ${sweep.n} protected sample points buildable; UI: ${seen.join('; ')}; nothing sent; server (forged, A's token): ${forged.join(', ')}`;
  });

  await check('2. a wall line near (legally outside) the Café door apron does not seal it: click-to-move routes a player in and out; keepers keep their route; no door can be sealed', async () => {
    const seal = sealAnalysis();
    const sealed = seal.filter((x) => !x.escaped);
    assert(sealed.length === 0, `doors that legal pieces could seal: ${sealed.map((x) => x.door).join(', ')}`);
    // A walks back out and builds the wall line through the UI.
    await walkTo(a, STAND_A, 0.8);
    await openBuildKey(a);
    await choosePiece(a, 'wall', 'cream');
    walls = [];
    for (const w of WALL_LINE) {
      await rotateTo(a, w.rot);
      walls.push(await placeAt(a, w.x, w.z));
    }
    const apronGap = Math.min(
      ...walls.map((w) => {
        const ap = cafeDoor.apron;
        const lx = (w.x - ap.center.x) * Math.cos(ap.yaw) - (w.z - ap.center.z) * Math.sin(ap.yaw);
        const lz = (w.x - ap.center.x) * Math.sin(ap.yaw) + (w.z - ap.center.z) * Math.cos(ap.yaw);
        return Math.hypot(Math.max(0, Math.abs(lx) - ap.halfWidth - 1), Math.max(0, Math.abs(lz) - ap.halfDepth - 0.12));
      }),
    );
    await leaveBuild(a, 'escape');
    await shot(a, 'c2-wall-line');
    const sb0 = await waitSnap(b, (s) => s.build.count === walls.length && s.build.colliders >= walls.length, 'B has the walls (and collides with them)', 30_000);
    learnPieces(sb0.build.pieces);
    // The script's A* (shared collision + the pieces) still routes square → inside → beyond the wall line.
    const routeOk = (from, to) => {
      // route() returns just [to] when it finds nothing: check the whole polyline is walkable (walls included).
      const pts = [from, ...route(from, to)];
      for (let i = 1; i < pts.length; i++) {
        const n = Math.ceil(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) / 0.1);
        for (let k = 1; k <= n; k++) if (!isWalkable({ x: pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / n, z: pts[i - 1].z + ((pts[i].z - pts[i - 1].z) * k) / n }, CONFIG.movement.playerRadius)) return null;
      }
      return pts.length - 1;
    };
    const table3 = interiorAnchor('cafe', 'table_3').position;
    const r1 = routeOk(sb0.local, table3);
    const r2 = routeOk(table3, BEYOND);
    assert(r1 && r2, `script A* found no walkable route with the walls in place (in ${r1}, out ${r2})`);
    const blocked = !isWalkable({ x: WALL_LINE[1].x, z: WALL_LINE[1].z }, CONFIG.movement.playerRadius);
    assert(blocked, 'the script’s collision does not see the walls');
    // A (desktop, standing by its walls): click-to-move — the client's own A* over its nav grid, which
    // holds the walls — in through the door...
    const start = (await snap(a)).local;
    assert(where(start) === 'outdoors' && Math.hypot(start.x - cafeDoor.position.x, start.z - cafeDoor.position.z) > 3, `A should start well outside the café, is at (${start.x.toFixed(1)}, ${start.z.toFixed(1)})`);
    let p = null;
    for (const name of ['table_3', 'table_2', 'table_1', 'counter']) {
      const q = interiorAnchor('cafe', name).position;
      p = await screenOf(a, q.x, q.z, cafe.floorY).catch(() => null);
      if (p) break;
    }
    assert(p, 'no café floor spot on A’s screen');
    await tapOrClick(a, p.x, p.y);
    await sleep(200);
    const plan = (await snap(a)).motion?.path;
    assert(plan?.goal, 'A planned no path into the café');
    const viaDoor = [start, ...plan.points].some((q, i, arr) => {
      if (!i) return false;
      const q0 = arr[i - 1];
      for (let t = 0; t <= 1; t += 0.05) if (Math.hypot(q0.x + (q.x - q0.x) * t - cafeDoor.position.x, q0.z + (q.z - q0.z) * t - cafeDoor.position.z) < cafeDoor.width / 2 + 0.3) return true;
      return false;
    });
    assert(viaDoor, `A's path does not use the door: ${JSON.stringify(plan.points)}`);
    await waitSnap(a, (s) => !s.motion?.path && where(s.local) === 'cafe', 'A inside the café', 60_000);
    await waitSnap(b, (s) => posOf(s, idA) && where(posOf(s, idA)) === 'cafe', "B's room state has A inside", 15_000);
    // ...and out to beyond the wall line (the route has to go round the walls).
    await hop(a, BEYOND, 1.0, 240_000);
    const sOut = await waitSnap(b, (s) => posOf(s, idA) && Math.hypot(posOf(s, idA).x - BEYOND.x, posOf(s, idA).z - BEYOND.z) < 1.5, 'server has A beyond the walls', 20_000);
    // Keepers are moved by the server along their route: sample the barista until it moves.
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const k = (await snap(a)).activities.keepers.keeper_barista;
      samples.push(k);
      const moved = samples.some((q) => Math.hypot(q.x - samples[0].x, q.z - samples[0].z) > 0.8);
      if (moved && samples.length > 3) break;
      await sleep(1000);
    }
    assert(samples.every((k) => k.present), 'the barista went off duty');
    assert(samples.some((q) => Math.hypot(q.x - samples[0].x, q.z - samples[0].z) > 0.8), `the barista did not move in 60 s: ${JSON.stringify(samples.at(-1))}`);
    assert(samples.every((k) => where(k) === 'cafe'), 'the barista left the café');
    const onRoute = samples.every((k) => baristaRoute.some((q, i) => {
      const q1 = baristaRoute[(i + 1) % baristaRoute.length];
      const L = Math.hypot(q1.x - q.x, q1.z - q.z) || 1;
      const t = Math.max(0, Math.min(1, ((k.x - q.x) * (q1.x - q.x) + (k.z - q.z) * (q1.z - q.z)) / (L * L)));
      return Math.hypot(q.x + (q1.x - q.x) * t - k.x, q.z + (q1.z - q.z) * t - k.z) < 0.6;
    }));
    assert(onRoute, `the barista left its route: ${JSON.stringify(samples.map((k) => [k.x?.toFixed(2), k.z?.toFixed(2)]))}`);
    const kb = (await snap(b)).activities.keepers.keeper_barista;
    const ka = (await snap(a)).activities.keepers.keeper_barista;
    assert(Math.hypot(ka.x - kb.x, ka.z - kb.z) < 1.5, `A and B disagree on the barista: ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`);
    return `${walls.length} walls placed (script A*: ${r1} legs in, ${r2} out, walls solid), nearest ${apronGap.toFixed(2)} m outside the protected apron margin; A clicked the café floor → path via the door, inside; then out to (${posOf(sOut, idA).x.toFixed(1)}, ${posOf(sOut, idA).z.toFixed(1)}) beyond the walls; barista moved along its route (${samples.length} samples); seal analysis: ${seal.length} doors, none sealable`;
  });

  await check('3. inside the Café with the cutaway open: keeper drawn with its KEEPER tag, B’s name tag and speech bubble on A, online count 2 while keepers are on duty', async () => {
    await Promise.all([walkTo(a, interiorAnchor('cafe', 'table_2').position, 1.2), walkTo(b, interiorAnchor('cafe', 'table_3').position, 1.2)]);
    await waitSnap(a, (s) => s.interior?.active === 'cafe' && s.interior.amount > 0.9, "A's cutaway open", 15_000);
    await waitSnap(b, (s) => s.interior?.active === 'cafe' && s.interior.amount > 0.9, "B's cutaway open", 15_000);
    const tag = (page, id) =>
      page.evaluate((id) => {
        const el = document.querySelector(`[data-actor="${id}"]`);
        const label = el?.querySelector('.ew-label');
        if (!el || !label) return { on: false };
        return { on: Number(getComputedStyle(el).opacity) > 0.3 && !label.classList.contains('ew-off'), kind: label.dataset.kind, text: label.textContent, badge: getComputedStyle(label, '::after').content };
      }, id);
    await waitFor(async () => (await tag(a, 'npc:keeper_barista')).on && (await tag(a, idB)).on, 'keeper tag and B tag on A', 20_000);
    const kt = await tag(a, 'npc:keeper_barista');
    assert(kt.kind === 'npc' && /keeper/i.test(kt.badge) && /Mara/.test(kt.text), `keeper tag ${JSON.stringify(kt)}`);
    const sa = await snap(a);
    assert(sa.activities.keepers.keeper_barista.present && sa.activities.keepers.keeper_barista.drawn, `barista not drawn on A: ${JSON.stringify(sa.activities.keepers.keeper_barista)}`);
    // B speaks through the real chat UI; A sees the bubble over B. A's page records the bubble from
    // BEFORE B sends (a bubble lives ~5 s; the chat UI steps on a slow page can take longer than that).
    const text = `the keeper makes good coffee ${Date.now() % 10000}`;
    await watchBubble(a, idB, text);
    if (!(await b.$('[data-testid=chat]'))) await b.locator('[data-testid=nav-chat]').tap();
    await b.locator('[data-testid=chat-tab-nearby]').tap();
    await b.fill('[data-testid=chat-input]', text);
    const tSend = Date.now();
    await b.press('[data-testid=chat-input]', 'Enter');
    if (await b.$('[data-testid=chat-close]')) await b.locator('[data-testid=chat-close]').tap({ timeout: 10_000 }).catch(() => undefined);
    const uiMs = Date.now() - tSend;
    const seen = await bubbleSeen(a, 10_000);
    assert(seen, `no bubble over B on A within 10 s of sending; A raw chat ${JSON.stringify(((await snap(a)).ui?.rawChat ?? []).slice(-1))}`);
    const bubble = seen.text;
    await shot(a, 'c3-cafe-keeper-tag-bubble');
    const onDuty = KEEPERS.filter((k) => sa.activities.keepers[k.id].present).length;
    for (const p of [a, b]) {
      assert((await online(p)) === 2, `online count ${await online(p)}`);
      const s = await snap(p);
      assert(s.players.length === 2 && s.activities.online === 2, `roster ${s.players.length} / ${s.activities.online}`);
    }
    return `keeper tag "${kt.text.trim()}" (${kt.kind}, badge ${kt.badge}); B tag shown; bubble "${bubble.trim()}" shown ${seen.afterMs} ms after the chat arrived on A, for ${seen.visibleMs ?? '≥?'} ms (B's chat UI steps took ${uiMs} ms); ${onDuty} keepers on duty; online 2 on both`;
  });

  await check('4. build mode toggled indoors: ghost refused with a visible reason, nothing sent, E does nothing; after leaving, E on the barista opens the keeper panel', async () => {
    await keyboardRoute(a, [interiorAnchor('cafe', barista.talkAnchor).position], { timeout: 60_000 });
    const s0 = await snap(a);
    await a.keyboard.press('KeyB');
    await a.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
    const sg = await waitSnap(a, (s) => s.build.mode === 'place' && s.build.ghost, 'ghost indoors', 20_000);
    assert(!sg.build.ghost.ok, `ghost indoors is valid: ${JSON.stringify(sg.build.ghost)}`);
    const st = await statusOf(a);
    assert(st?.tone === 'bad' && /Café/.test(st.text), `status ${JSON.stringify(st)}`);
    await shot(a, 'c4-build-indoors-refused');
    await a.keyboard.press('Enter'); // place → explains, never sends
    await a.keyboard.press('KeyE'); // no interacting while building
    await sleep(800);
    const s1 = await snap(a);
    assert(sentCount(s1) === sentCount(s0) && s1.build.count === s0.build.count, 'a placement was sent from indoors');
    assert(!(await a.$('[data-testid=panel-keeper]')) && s1.ui.panel === null, 'E opened a panel while building');
    await leaveBuild(a, 'escape');
    assert(!(await a.$('[data-testid=build-dock]')) && (await a.$('[data-testid=nav-build]')), 'nav not restored');
    await waitSnap(a, (s) => s.target?.kind === 'interactable' && s.target.id === barista.interactableId, 'A targets the barista', 20_000);
    await a.keyboard.press('KeyE');
    await a.waitForSelector('[data-testid=panel-keeper]', { timeout: 20_000 });
    const line = (await a.textContent('[data-testid=keeper-line]').catch(() => '')) ?? '';
    return `indoors: "${st.text.trim()}"; Enter/E while building sent nothing and opened nothing; after Esc, E → keeper panel ("${line.trim().slice(0, 60)}")`;
  });

  await check('5. holding a café drink, A enters build mode, places a piece outdoors and leaves: drink still in hand (sippable) or cleanly gone; nothing stuck', async () => {
    await a.click('[data-testid=order-coffee]');
    await waitSnap(a, (s) => s.activities?.held?.[idA] === 'cup_coffee', 'A holds the coffee', 20_000);
    await waitSnap(b, (s) => s.activities?.held?.[idA] === 'cup_coffee', 'B sees A holding the coffee', 15_000);
    await closePanel(a);
    await waitFor(async () => !!(await a.$('[data-testid=drink-sip]')), 'drink chip shown', 10_000);
    // Out of the café (keys through the door) and round the wall line to open land.
    await walkTo(a, STAND_A, 1.0);
    await walkTo(a, { x: BEYOND.x - 2, z: BEYOND.z + 0.5 }, 1.0);
    const me = (await snap(a)).local;
    // A legal crate spot near A that is on screen.
    const idx = new PieceIndex();
    for (const w of walls) idx.add(w);
    let spot = null;
    for (let r = 2; r <= 6 && !spot; r += 0.5)
      for (let k = 0; k < 16 && !spot; k++) {
        const g = snapToGrid('sign', { x: me.x + Math.cos((k / 16) * Math.PI * 2) * r, z: me.z + Math.sin((k / 16) * Math.PI * 2) * r }, 0);
        const v = validatePlacement({ kind: 'sign', variant: PIECES.sign.variants[0].id, x: g.x, z: g.z, rot: 0, level: 0, text: 'x' }, { index: idx, builderId: 'x', builderPos: me, players: [me, posOf(await snap(a), idB) ?? { x: 999, z: 999 }] });
        if (!v.ok || walls.some((w) => Math.hypot(w.x - g.x, w.z - g.z) < 1.6)) continue;
        try {
          await screenOf(a, g.x, g.z);
          spot = g;
        } catch {
          /* off screen */
        }
      }
    assert(spot, 'no legal sign spot on screen near A');
    await openBuildKey(a);
    await choosePiece(a, 'sign');
    await a.fill('[data-testid=build-sign-text]', SIGN_TEXT);
    crate = await placeAt(a, spot.x, spot.z);
    assert(!(await a.$('[data-testid=drink-sip]')), 'the sip chip is over the build dock');
    assert(crate.text === SIGN_TEXT, `sign text came back as ${JSON.stringify(crate.text)}`);
    await shot(a, 'c5-build-with-drink');
    const mid = await snap(a);
    await leaveBuild(a, 'done');
    const s = await snap(a);
    const held = s.activities.held[idA];
    assert(s.build.mode === 'off' && s.ui.panel === null && !s.ui.chatOpen, `stuck UI: build ${s.build.mode}, panel ${s.ui.panel}`);
    let drink;
    if (held === 'cup_coffee') {
      assert(await a.$('[data-testid=drink-sip]'), 'holding the coffee but no sip chip');
      const ev0 = s.activities.sound.events;
      await a.click('[data-testid=drink-sip]');
      await waitSnap(a, (x) => x.activities.sound.events > ev0 || x.activities.held[idA] === '', 'the sip happens', 10_000);
      drink = 'still in hand during and after build mode; sipped once after';
    } else {
      assert(held === '' && !(await a.$('[data-testid=drink-sip]')), `drink state ${JSON.stringify(held)} with chip ${!!(await a.$('[data-testid=drink-sip]'))}`);
      drink = 'ran out cleanly (no chip, nothing held)';
    }
    assert(mid.activities.held[idA] === 'cup_coffee' || mid.activities.held[idA] === '', `held while building: ${mid.activities.held[idA]}`);
    // Walking still works after leaving build mode.
    const s5 = await snap(a);
    learnPieces(s5.build.pieces);
    const p0 = s5.local;
    // Hold one movement key (camera-relative) towards a direction that is free for 1.5 m.
    const yaw = s5.view.yaw;
    const dirOf = { KeyD: { x: Math.cos(yaw), z: -Math.sin(yaw) }, KeyA: { x: -Math.cos(yaw), z: Math.sin(yaw) }, KeyW: { x: -Math.sin(yaw), z: -Math.cos(yaw) }, KeyS: { x: Math.sin(yaw), z: Math.cos(yaw) } };
    const key = Object.keys(dirOf).find((k) => [0.3, 0.6, 0.9, 1.2, 1.5].every((d) => isWalkable({ x: p0.x + dirOf[k].x * d, z: p0.z + dirOf[k].z * d }, CONFIG.movement.playerRadius + 0.05)));
    assert(key, 'no free direction next to A');
    await a.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await a.keyboard.down(key);
    await sleep(900);
    await a.keyboard.up(key);
    await waitSnap(a, (x) => x.local.speed < 0.05, 'A stopped', 10_000);
    const p1 = (await snap(a)).local;
    assert(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.5, `A cannot walk after leaving build mode (held ${key}: moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)} m)`);
    const sb = await waitSnap(b, (x) => x.build.pieces.some((q) => q.id === crate.id), 'B sees the crate', 15_000);
    assert(sb.activities.held[idA] === (await snap(a)).activities.held[idA], 'A and B disagree about the drink');
    assert(sb.build.pieces.find((q) => q.id === crate.id).text === SIGN_TEXT, 'B got different sign text');
    for (const p of [a, b]) assert((await p.evaluate(() => window.__xss)) === undefined, 'the sign payload ran');
    return `sign ${crate.id} (text kept literally: ${JSON.stringify(SIGN_TEXT)}) at (${crate.x}, ${crate.z}); drink ${drink}; walked ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)} m after`;
  });

  await check('7. mobile 390×844 and 844×390: nav, Build button, build dock, chat preview, joystick, drink chip and keeper panel do not block each other', async () => {
    // A says something before each HUD shot so B's chat preview (shown ~6 s per new line) has a line.
    const say = async (text) => {
      if (!(await a.$('[data-testid=chat]'))) await a.click('[data-testid=nav-chat]');
      await a.click('[data-testid=chat-tab-town]');
      await a.fill('[data-testid=chat-input]', text);
      await a.press('[data-testid=chat-input]', 'Enter');
      if (await a.$('[data-testid=chat-close]')) await a.click('[data-testid=chat-close]');
    };
    const notes = [];
    const problems = [];
    const tagOf = (w, h) => `${w}x${h}`;
    for (const [w, h] of [[390, 844], [844, 390]]) {
      await b.setViewportSize({ width: w, height: h });
      await sleep(1500);
      if (await b.$('[data-testid=chat-close]')) await b.locator('[data-testid=chat-close]').tap();
      const line = `see you at the café (${w}x${h})`;
      await b.evaluate((line) => {
        window.__peek = null;
        const mo = new MutationObserver(() => {
          const el = document.querySelector('[data-testid=chat-peek]');
          if (el && !window.__peek && (el.textContent ?? '').includes(line)) window.__peek = performance.now();
        });
        mo.observe(document.body, { subtree: true, childList: true, characterData: true });
        setTimeout(() => mo.disconnect(), 30_000);
      }, line);
      const states = [];
      const capture = async (name, settleMs = 700) => {
        await sleep(settleMs);
        const r = await layoutReport(b);
        states.push({ name, r });
        await shot(b, `c7-${tagOf(w, h)}-${name}`);
        if (r.blocked.length) problems.push(`${tagOf(w, h)} ${name}: ${r.blocked.join(', ')}`);
        if (r.overlaps.length && !r.rects.sheet) problems.push(`${tagOf(w, h)} ${name}: overlapping ${r.overlaps.join(', ')}`);
        if (r.offscreen.length) problems.push(`${tagOf(w, h)} ${name}: off screen ${r.offscreen.join(', ')}`);
        if (r.scrollW > r.W + 1) problems.push(`${tagOf(w, h)} ${name}: horizontal overflow ${r.scrollW}`);
        notes.push(`${tagOf(w, h)} ${name}: ${Object.keys(r.rects).join('/')}${r.underSheet.length ? ` (under the panel: ${r.underSheet.join(', ')})` : ''}${r.rects.sheet && r.overlaps.length ? ` (with the panel open: ${r.overlaps.join(', ')})` : ''}`);
        return r;
      };
      // Watch B while A is still sending, and take the HUD shot as soon as the preview shows (it lives
      // 6 s; A's own chat steps take seconds at a few fps).
      const hudShot = (async () => {
        await waitFor(async () => (await b.evaluate(() => {
          const el = document.querySelector('[data-testid=chat-peek]');
          return !!el && Number(getComputedStyle(el).opacity) > 0.5;
        })) || 'not (yet) visible', 'chat preview on B', 30_000); // A's own send steps alone take ~10 s at a few fps
        return capture('hud', 0);
      })();
      let hud;
      try {
        [, hud] = await Promise.all([say(line), hudShot]);
      } catch (e) {
        const d = await b.evaluate(() => ({ peekSeenAt: window.__peek, chatOpen: window.__ELSEWHERE__.snapshot().ui.chatOpen, raw: (window.__ELSEWHERE__.snapshot().ui.rawChat ?? []).slice(-2) }));
        throw new Error(`${e.message}; B: ${JSON.stringify(d)}`);
      }
      for (const need of ['nav', 'navBuild', 'joystick', 'chatPeek']) if (!hud.rects[need]) problems.push(`${tagOf(w, h)} hud: ${need} not visible`);
      // Keeper panel (tap the barista) → order a drink → the drink chip with the nav.
      await useThing(b, barista.interactableId, { panel: 'panel-keeper', approach: interiorAnchor('cafe', 'table_3').position, timeout: 90_000 });
      const panel = await capture('keeper-panel');
      if (!panel.rects.sheetClose) problems.push(`${tagOf(w, h)} keeper panel: no close button visible`);
      const held = (await snap(b)).activities.held[idB];
      if (!held) {
        await b.locator('[data-testid=order-cocoa]').tap();
        await waitSnap(b, (s) => !!s.activities.held[idB], 'B holds a drink', 20_000);
      }
      await closePanel(b);
      const chip = await capture('drink-chip');
      if (!chip.rects.drink) problems.push(`${tagOf(w, h)}: drink chip not visible`);
      // Build mode (indoors → refused ghost; the dock replaces the nav).
      await openBuildKey(b);
      const dock = await capture('build-dock');
      for (const need of ['buildDock', 'buildDone', 'buildStatus']) if (!dock.rects[need]) problems.push(`${tagOf(w, h)} build: ${need} not visible`);
      await leaveBuild(b, 'done');
    }
    await b.setViewportSize(devices['Pixel 7'].viewport);
    assert(problems.length === 0, problems.join(' | '));
    return notes.join('; ');
  });

  await check('6. server restart with built pieces, a pinned notice, workshop progress and a lit hearth: both reload and everything is back; fresh DB has migrations 1-5', async () => {
    // A pins a notice at the Town Hall, then lights House 1's hearth; B does a piece of work at the Workshop.
    const workB = async () => {
      await useThing(b, 'station_workshop_anvil', { panel: 'panel-project', approach: interiorAnchor('workshop', 'anvil').position, timeout: 90_000 });
      await waitSnap(b, (s) => (s.activities?.project?.contributions ?? 0) >= 1, 'workshop progress on B', 20_000);
      await closePanel(b);
    };
    const workA = async () => {
      await useThing(a, 'station_hall_notices', { panel: 'panel-notices', approach: interiorAnchor('town_hall', 'notice_board').position, timeout: 90_000 });
      await a.fill('[data-testid=board-input]', NOTICE);
      await a.click('[data-testid=board-submit]');
      await waitSnap(a, (s) => s.activities?.notices?.some((e) => e.text === NOTICE), 'notice synced on A', 20_000);
      await waitFor(async () => ((await a.textContent('[data-testid=board-entries]').catch(() => '')) ?? '').includes(NOTICE), 'the notice shown as text on the board', 15_000);
      const markup = await a.evaluate(() => document.querySelectorAll('[data-testid=board-entries] img, [data-testid=board-entries] b').length);
      assert(markup === 0 && (await a.evaluate(() => window.__xss)) === undefined, `the notice payload became markup (${markup} elements)`);
      await closePanel(a);
      await useThing(a, 'station_house_1_hearth', { approach: interiorAnchor('house_1', 'hearth').position, done: (x) => x.activities?.hearths?.house_1?.active === true, timeout: 90_000 });
    };
    await Promise.all([workA(), workB()]);
    await waitSnap(b, (s) => s.activities?.hearths?.house_1?.active && s.activities.notices.some((e) => e.text === NOTICE), 'B sees the hearth and the notice', 20_000);
    beforeRestart = await snap(a);
    const pieces = beforeRestart.build.pieces;
    const project = beforeRestart.activities.project;
    assert(pieces.length === walls.length + 1, `${pieces.length} pieces before the restart`);
    restarting = true;
    await server.stop();
    const migs = await migrationsIn(DATA_DIR);
    assert(JSON.stringify(migs.map((m) => m.id)) === '[1,2,3,4,5]', `schema_migrations: ${JSON.stringify(migs)}`);
    await server.start();
    await a.reload();
    await b.reload();
    const sig = (list) => list.map((p) => `${p.id}|${p.kind}|${p.variant}|${p.x}|${p.z}|${p.rot}|${p.level}|${p.ownerId}`).sort().join(',');
    for (const [label, p] of [['A', a], ['B', b]]) {
      const s = await waitSnap(p, (x) => x.connection === 'connected' && x.local?.ready && x.build?.synced && x.build.count === pieces.length && (x.activities?.notices?.length ?? 0) > 0, `${label} back after restart`, 120_000);
      assert(sig(s.build.pieces) === sig(pieces), `${label}: pieces differ after restart`);
      assert(s.activities.notices.some((e) => e.text === NOTICE), `${label}: notice missing`);
      assert(s.activities.project.projectId === project.projectId && s.activities.project.contributions === project.contributions, `${label}: project ${JSON.stringify(s.activities.project)} vs ${JSON.stringify(project)}`);
      assert(s.activities.hearths.house_1.active, `${label}: hearth out`);
    }
    restarting = false;
    await waitFor(async () => (await online(a)) === 2 && (await online(b)) === 2, 'online 2 after restart', 30_000);
    return `${pieces.length} pieces, notice (HTML payload shown as text), project ${project.projectId} at ${project.contributions} work, House 1 hearth lit — all back on both after reload; migrations ${migs.map((m) => `${m.id}:${m.name}`).join(', ')}`;
  });

  if (process.env.COMB_LEGACY_DATA_DIR) {
    await check('6b. a DB created by an older server migrates cleanly to 1-5 and its profile resumes', async () => {
      const legacy = mkdtempSync(path.join(tmpdir(), 'elsewhere-legacy-'));
      cpSync(process.env.COMB_LEGACY_DATA_DIR, legacy, { recursive: true });
      const before = await migrationsIn(legacy);
      const secretFile = path.join(process.env.COMB_LEGACY_DATA_DIR, 'qa-secret.txt');
      const env = { NODE_ENV: 'production', DATA_DIR: legacy, SESSION_SECRET: existsSync(secretFile) ? readFileSync(secretFile, 'utf8').trim() : SECRET };
      const old = makeServer(PORT + 1, env);
      await old.start();
      let resumed = 'no token given';
      try {
        const tokenFile = path.join(process.env.COMB_LEGACY_DATA_DIR, 'qa-token.txt');
        if (existsSync(tokenFile)) {
          const f = await forger(readFileSync(tokenFile, 'utf8').trim(), PORT + 1);
          await waitFor(async () => !!f.welcome(), 'welcome', 15_000);
          const w = f.welcome();
          const want = readFileSync(path.join(process.env.COMB_LEGACY_DATA_DIR, 'qa-profile.txt'), 'utf8').trim();
          const got = w.profile?.profileId ?? w.profileId ?? JSON.stringify(w).match(/"profileId":"([^"]+)"/)?.[1];
          assert(got === want, `legacy token resumed ${got}, expected ${want}`);
          resumed = `profile ${got} resumed`;
          await f.room.leave().catch(() => undefined);
        }
        const w = await (await fetch(`http://localhost:${PORT + 1}/api/world`)).json();
        assert(w && typeof w === 'object', 'no /api/world');
      } finally {
        await old.stop();
      }
      const after = await migrationsIn(legacy);
      assert(JSON.stringify(after.map((m) => m.id)) === '[1,2,3,4,5]', `after: ${JSON.stringify(after)}`);
      return `before ${JSON.stringify(before.map((m) => m.id))} → after ${JSON.stringify(after.map((m) => m.id))}; ${resumed}`;
    });
  } else log('6b skipped (not run): set COMB_LEGACY_DATA_DIR to a data dir made by an older server');

  await check('8. zero console / page errors in both clients', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  record('script', false, String(err?.stack ?? err));
} finally {
  await browser.close().catch(() => undefined);
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`[combined] ${results.length - failed.length}/${results.length} checks passed`);
if (ONLY) console.log('[combined] COMB_ONLY set: a partial run, not a pass');
process.exit(failed.length || ONLY ? 1 : 0);
