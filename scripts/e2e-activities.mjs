#!/usr/bin/env node
/**
 * Building activities, end to end: two REAL browser clients against the REAL
 * production build (Playwright; global install loaded with createRequire).
 *
 *   npm run build && npm run e2e:activities
 *
 * Spawns its own production server (`node server/dist/index.js`, port
 * $ACT_PORT or 2633, fresh DATA_DIR in the OS temp dir unless $ACT_DATA_DIR),
 * restarts it once mid-run on the same DATA_DIR. Client A: desktop 1440×900
 * (mouse + keyboard). Client B: Pixel 7 emulation (touch). Both join with
 * `?autojoin=1` and low graphics (headless WebGL is software-rendered).
 *
 * LOWERED THRESHOLDS (server env, so two people can finish a town project in one run):
 *   WORKSHOP_STAGE_CONTRIBUTIONS=2,2  WORKSHOP_STAGE_DISTINCT=2,2  (2 stages; each needs 2 pieces of work by 2 different people)
 * Everything else uses the defaults.
 *
 * Every action is a real input (click / tap / key) on the real UI; state is read back through
 * window.__ELSEWHERE__.snapshot() (read-only) and the DOM. Nothing is simulated: no fake players.
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *   1. both clients join; online count is 2 on both
 *   2. both see the same keeper state (present, task, position) and keepers are not players
 *   3. A lights the hearth in House 1; B sees it lit
 *   4. A signs House 1's guest book; B opens the guest book and reads it
 *   5. A pins a notice at the Town Hall; B opens the notice board and reads it
 *   6. both vote in the town poll; both see the real tally (2)
 *   7. A orders a drink from the barista; B sees A holding it
 *   8. A plays piano notes; B receives them and B's audio graph plays them
 *   9. both work on the town project: both see the stage advance and the finished project appear outside
 *  10. online count stays exactly 2 while keepers are on duty
 *  11. server restart: notice, vote tally, workshop progress + finished project, guest book still there
 *  12. zero console / page errors in both clients
 *
 * Env: ACT_PORT, ACT_DATA_DIR, ACT_SHOTS (screenshot dir; default none), ACT_VERBOSE=1.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, KEEPERS, getInteractable, getInterior, interiorAnchor, interiorAt, isWalkable } from '@elsewhere/shared';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ACT_PORT ?? 2633);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.ACT_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-activities-'));
const SHOTS = process.env.ACT_SHOTS ? path.resolve(ROOT, process.env.ACT_SHOTS) : null;
const SECRET = randomBytes(32).toString('hex');
const SERVER_ENV = { NODE_ENV: 'production', PORT: String(PORT), DATA_DIR, SESSION_SECRET: SECRET, WORKSHOP_STAGE_CONTRIBUTIONS: '2,2', WORKSHOP_STAGE_DISTINCT: '2,2' };
const T = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[activities]', ...a);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[activities] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
/** Debugging aids: ACT_ONLY="5,6" runs only those checks (the run then does not count as a pass). */
const ONLY = process.env.ACT_ONLY ? new Set(process.env.ACT_ONLY.split(',').map((x) => x.trim())) : null;
async function check(name, fn) {
  if (ONLY && !ONLY.has(name.split('.')[0])) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
    if (SHOTS) for (const [label, p] of [['A', a], ['B', b]]) await shot(p, `fail-${name.split('.')[0]}-${label}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
let server = null;
let serverExit = null;
async function startServer() {
  assert(existsSync(path.join(ROOT, 'server/dist/index.js')) && existsSync(path.join(ROOT, 'client/dist/index.html')), 'production build missing: run `npm run build` first');
  server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], { cwd: ROOT, env: { ...process.env, ...SERVER_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((r) => server.once('exit', r));
  server.stdout.on('data', (d) => process.env.ACT_VERBOSE && process.stdout.write(`[server] ${d}`));
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
// Page helpers (same steering as scripts/e2e-interiors.mjs)
// ---------------------------------------------------------------------------
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // The planned server restart: the websocket drops and reconnect attempts fail until it is back.
    if (restarting && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|net::|reconnect/i.test(t)) return;
    pageErrors.push(`${label} console.error: ${t}`);
  });
}
let restarting = false;
const snap = (page) => page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
const act = async (page) => (await snap(page))?.activities ?? null;
const query = (page, name, ...args) => page.evaluate(([n, a]) => window.__ELSEWHERE__.query(n, ...a), [name, args]);
async function waitSnap(page, pred, label, timeout = T) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}; last local ${JSON.stringify(last?.local)} activities ${JSON.stringify(last?.activities ?? null).slice(0, 400)}`);
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
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 78, scale: 'css' }).catch((e) => log('screenshot failed', name, e.message));
}
const where = (p) => interiorAt(p)?.id ?? 'outdoors';
async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
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

/**
 * (Same as scripts/e2e-interiors.mjs.) Route (A* on a 0.25 m grid over the shared collision) — what a person
 * walking by keys has in mind; keyboardWalk then steers along it.
 */
function route(from, to) {
  const G = 0.25;
  const r = CONFIG.movement.playerRadius + 0.06;
  const key = (i, j) => `${i},${j}`;
  const pt = (i, j) => ({ x: i * G, z: j * G });
  const walk = new Map();
  const ok = (i, j) => {
    const k = key(i, j);
    if (!walk.has(k)) walk.set(k, isWalkable(pt(i, j), r));
    return walk.get(k);
  };
  const si = Math.round(from.x / G);
  const sj = Math.round(from.z / G);
  const ti = Math.round(to.x / G);
  const tj = Math.round(to.z / G);
  const h = (i, j) => Math.hypot(i - ti, j - tj) * G;
  const open = [[h(si, sj), 0, si, sj]];
  const came = new Map([[key(si, sj), null]]);
  const cost = new Map([[key(si, sj), 0]]);
  for (let iter = 0; open.length && iter < 60_000; iter++) {
    let bi = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[bi][0]) bi = n;
    const [, g, i, j] = open.splice(bi, 1)[0];
    if (i === ti && j === tj) {
      const out = [];
      for (let k = key(i, j); k; k = came.get(k)) {
        const [a, b] = k.split(',').map(Number);
        out.unshift(pt(a, b));
      }
      out.push(to);
      // string-pull: from each point jump to the farthest one in clear line of sight (with margin)
      const clear = (p, q) => {
        const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.1);
        for (let k = 1; k < n; k++) if (!isWalkable({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n }, r + 0.05)) return false;
        return true;
      };
      const pulled = [];
      let at = 0;
      while (at < out.length - 1) {
        let j = out.length - 1;
        while (j > at + 1 && !clear(out[at], out[j])) j--;
        pulled.push(out[j]);
        at = j;
      }
      return pulled;
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
  return [to];
}

/** Keyboard walk along a planned route through `via` points. */
async function keyboardRoute(page, via, opts) {
  let from = (await snap(page)).local;
  const wps = [];
  for (const v of via) {
    wps.push(...route(from, v));
    from = v;
  }
  // Headless WebGL is software-rendered (2–4 fps): one frame of a held key moves ~1 m, so waypoints count as reached within 0.9 m.
  await keyboardWalk(page, wps, { reach: 0.9, ...opts });
}

/**
 * Keyboard walking towards waypoints: every 120 ms pick the camera-relative
 * key combination (W/A/S/D, diagonals) closest to the direction to the next
 * waypoint — exactly what a person steering by keys does.
 */
async function keyboardWalk(page, waypoints, { reach = 0.45, timeout = 40_000 } = {}) {
  const held = new Set();
  const press = async (keys) => {
    for (const k of [...held]) if (!keys.has(k)) {
      await page.keyboard.up(k);
      held.delete(k);
    }
    for (const k of keys) if (!held.has(k)) {
      await page.keyboard.down(k);
      held.add(k);
    }
  };
  const t0 = Date.now();
  try {
    for (const wp of waypoints) {
      let last = null;
      let stall = 0;
      let nudge = 0;
      for (;;) {
        const s = await snap(page);
        if (Date.now() - t0 > timeout) {
          const focus = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`);
          throw new Error(`keyboard walk timed out before (${wp.x.toFixed(1)}, ${wp.z.toFixed(1)}); at (${s.local.x.toFixed(2)}, ${s.local.z.toFixed(2)}) anim ${s.local.anim}, seat ${JSON.stringify(s.motion?.seat ?? null)}, focus ${focus}, connection ${s.connection}, ui ${JSON.stringify(s.ui ?? null).slice(0, 200)}`);
        }
        const dx = wp.x - s.local.x;
        const dz = wp.z - s.local.z;
        if (Math.hypot(dx, dz) < reach) break;
        // world → screen-relative (camera.ts screenToWorldDir inverse): right = (cos y, -sin y), up = -(sin y, cos y)
        const yaw = s.view.yaw;
        const mx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
        const my = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));
        const a = Math.atan2(my, mx); // 0 = right, PI/2 = up
        // Like a person: if pushing straight on gets nowhere (a table, a door jamb), veer 45° and slide round it.
        const dist = Math.hypot(dx, dz);
        const moved = last ? Math.hypot(s.local.x - last.x, s.local.z - last.z) : 1;
        last = { x: s.local.x, z: s.local.z };
        if (moved > 0.05) {
          stall = 0;
          if (nudge && moved > 0.4) nudge = 0;
        } else if (++stall >= 4) {
          nudge = nudge === 0 ? 1 : nudge > 0 ? -nudge : -nudge + 1;
          if (Math.abs(nudge) > 2) nudge = 1;
          stall = 0;
        }
        let sector = Math.round(a / (Math.PI / 4)) + nudge;
        if (sector > 4) sector -= 8;
        if (sector < -4) sector += 8;
        const combos = { 0: ['KeyD'], 1: ['KeyD', 'KeyW'], 2: ['KeyW'], 3: ['KeyA', 'KeyW'], 4: ['KeyA'], [-4]: ['KeyA'], [-3]: ['KeyA', 'KeyS'], [-2]: ['KeyS'], [-1]: ['KeyD', 'KeyS'] };
        // hold briefly, release, re-evaluate (works at any frame rate, cannot overshoot far)
        await press(new Set(combos[sector] ?? ['KeyW']));
        await sleep(Math.max(60, Math.min(450, (dist / CONFIG.movement.walkSpeed) * 1000 * 0.5)));
        await press(new Set());
      }
    }
  } finally {
    await press(new Set());
  }
}

/** Walk like a person: into the building through its door first, then to the spot (each leg by click/tap hops). */
async function hopToward(page, target, near = 1.2, timeout = 240_000) {
  const it = interiorAt(target);
  const s = await snap(page);
  if (it && interiorAt(s.local)?.id !== it.id) {
    const door = it.doors[0];
    const inside = (q) => interiorAt(q.local)?.id === it.id;
    await hop(page, door.outside, 3, timeout / 2, inside);
    // through the doorway by keys along a planned route (as a person would), unless already in
    if (!inside(await snap(page))) await keyboardRoute(page, [door.inside], { timeout: 60_000 }).catch(() => undefined);
  }
  return hop(page, target, near, timeout);
}

/** Click/tap-to-move in hops towards a target (the camera follows), until close. */
async function hop(page, target, near = 1.2, timeout = 180_000, reached = null) {
  const vp = page.viewportSize();
  const t0 = Date.now();
  let stuck = 0;
  let prev = null;
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (Math.hypot(s.local.x - target.x, s.local.z - target.z) < near || (reached && reached(s))) return s;
    // A hop click that landed on something usable opened its panel: put it away and keep walking.
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
      // Clicks keep getting nowhere (a narrow screen, a wall in the way): steer by keys along a planned route instead.
      await keyboardRoute(page, [target], { timeout: 90_000 }).catch(() => undefined);
      stuck = 0;
      continue;
    }
    if (!(await onCanvas(page, x, y))) y -= 40;
    // Don't tap a sign / seat / player on the way (that would use it instead of walking): nudge off it.
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

/** Walk next to an interactable (inside its building) and click / tap it; wait for the panel (if any). */
async function useThing(page, id, { panel = null, approach = null, done = null, timeout = 60_000 } = {}) {
  const it = getInteractable(id);
  assert(it, `no interactable ${id}`);
  const interior = it.interiorId ? getInterior(it.interiorId) : null;
  const goal = approach ?? it.position;
  await hopToward(page, goal, 1.3);
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeout) {
    // A hop click that landed on the thing itself already used it (click-to-interact).
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
const online = async (page) => Number((await page.textContent('[data-testid=player-count]').catch(() => '0')) ?? '0');

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`data dir ${DATA_DIR}; server ${BASE}; lowered thresholds WORKSHOP_STAGE_CONTRIBUTIONS=2,2 WORKSHOP_STAGE_DISTINCT=2,2`);
await startServer();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
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
const NOTICE = `Choir practice by the fountain, ${Date.now() % 1000}`;
const SIGNATURE = `Lovely hearth — A ${Date.now() % 1000}`;
let idA = '';
let idB = '';
const both = (fn) => Promise.all([fn(a), fn(b)]);

try {
  await check('1. both clients join the same world; online count 2 on both', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.navReady === true, 'A sees 2 players');
    const sb = await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.navReady === true, 'B sees 2 players');
    idA = sa.sessionId;
    idB = sb.sessionId;
    // a real gesture on each page unlocks audio (as for a person)
    await a.mouse.click(720, 120);
    await b.touchscreen.tap(195, 140);
    await waitFor(async () => (await online(a)) === 2 && (await online(b)) === 2, 'online count 2');
    return `A=${idA}, B=${idB}`;
  });

  await check('2. both see the same keeper state; keepers are not players', async () => {
    let detail = '';
    await waitFor(async () => {
      const ka = (await act(a))?.keepers;
      const kb = (await act(b))?.keepers;
      if (!ka || !kb) return 'no keepers yet';
      for (const k of KEEPERS) {
        const x = ka[k.id];
        const y = kb[k.id];
        if (!x || !y || x.present !== y.present) return `${k.id} presence differs`;
        if (x.present && Math.hypot(x.x - y.x, x.z - y.z) > 1.5) return `${k.id} position differs`;
      }
      const present = KEEPERS.filter((k) => ka[k.id].present).map((k) => `${k.id}:${ka[k.id].task}`);
      if (!present.length) return 'no keeper on duty';
      detail = present.join(', ');
      return true;
    }, 'same keeper state');
    const sa = await snap(a);
    assert(sa.players.length === 2 && !sa.players.some((p) => KEEPERS.some((k) => k.id === p.id || k.name === p.name)), `keepers in the player list: ${JSON.stringify(sa.players.map((p) => p.name))}`);
    assert((await online(a)) === 2, 'online count changed');
    return `on duty: ${detail}`;
  });

  await check('3. A lights the hearth in House 1; B sees it lit', async () => {
    await Promise.all([useThing(a, 'station_house_1_hearth', { approach: interiorAnchor('house_1', 'hearth').position, done: (x) => x.activities?.hearths?.house_1?.active === true }), hopToward(b, interiorAnchor('house_1', 'entrance').position, 1.6)]);
    await waitSnap(a, (s) => s.activities?.hearths?.house_1?.active === true, 'A sees the hearth lit', 30_000);
    await waitSnap(b, (s) => s.activities?.hearths?.house_1?.active === true, 'B sees the hearth lit', 15_000);
    await shot(a, 'e2e-hearth-A');
    return 'hearth:house_1 active on both clients';
  });

  await check('4. A signs the guest book; B opens it and reads the entry', async () => {
    await useThing(a, 'station_house_1_guestbook', { panel: 'panel-guestbook', approach: interiorAnchor('house_1', 'table').position });
    await a.fill('[data-testid=board-input]', SIGNATURE);
    await a.click('[data-testid=board-submit]');
    await waitSnap(a, (s) => s.activities?.guestbooks?.book_house_1?.some((e) => e.text === SIGNATURE), 'A sees the signature', 20_000);
    await closePanel(a);
    await useThing(b, 'station_house_1_guestbook', { panel: 'panel-guestbook', approach: interiorAnchor('house_1', 'table').position });
    await waitFor(async () => ((await b.textContent('[data-testid=board-entries]').catch(() => '')) ?? '').includes(SIGNATURE), 'B reads the signature in the panel', 20_000);
    await shot(b, 'e2e-guestbook-B');
    await closePanel(b);
    return `"${SIGNATURE}" read on B`;
  });

  await check('5. A pins a notice at the Town Hall; B reads it on the board', async () => {
    await Promise.all([useThing(a, 'station_hall_notices', { panel: 'panel-notices', approach: interiorAnchor('town_hall', 'notice_board').position }), hopToward(b, interiorAnchor('town_hall', 'audience').position, 2)]);
    await a.fill('[data-testid=board-input]', NOTICE);
    await a.click('[data-testid=board-submit]');
    await waitSnap(a, (s) => s.activities?.notices?.some((e) => e.text === NOTICE), 'notice synced on A', 20_000);
    await closePanel(a);
    await useThing(b, 'station_hall_notices', { panel: 'panel-notices', approach: interiorAnchor('town_hall', 'notice_board').position });
    await waitFor(async () => ((await b.textContent('[data-testid=board-entries]').catch(() => '')) ?? '').includes(NOTICE), 'B reads the notice', 20_000);
    await shot(b, 'e2e-notice-B');
    await closePanel(b);
    return `"${NOTICE}" read on B`;
  });

  await check('6. both vote in the town poll; both see the real tally (2)', async () => {
    await useThing(a, 'station_hall_poll', { panel: 'panel-poll', approach: interiorAnchor('town_hall', 'meeting_table').position });
    await a.click('[data-testid=vote-0]');
    await useThing(b, 'station_hall_poll', { panel: 'panel-poll', approach: interiorAnchor('town_hall', 'meeting_table').position });
    await b.tap('[data-testid=vote-1]');
    const total = (s) => (s.activities?.poll?.tallies ?? []).reduce((x, y) => x + y, 0);
    await waitSnap(a, (s) => total(s) === 2, 'A tally 2', 20_000);
    await waitSnap(b, (s) => total(s) === 2, 'B tally 2', 20_000);
    await waitFor(async () => /2 votes/.test((await a.textContent('[data-testid=poll-total]')) ?? '') && /2 votes/.test((await b.textContent('[data-testid=poll-total]')) ?? ''), 'both panels show 2 votes', 15_000);
    await shot(a, 'e2e-poll-A');
    await shot(b, 'e2e-poll-B');
    await closePanel(a);
    await closePanel(b);
    return `tallies ${JSON.stringify((await act(a)).poll.tallies)} on both`;
  });

  await check('7. A orders a drink from the barista; B sees A holding it', async () => {
    await Promise.all([useThing(a, 'keeper_barista', { panel: 'panel-keeper', approach: interiorAnchor('cafe', 'counter').position }), hopToward(b, interiorAnchor('cafe', 'table_1').position, 1.6)]);
    await a.click('[data-testid=order-coffee]');
    await waitSnap(a, (s) => s.activities?.held?.[idA] === 'cup_coffee', 'A holds the coffee', 20_000);
    await waitSnap(b, (s) => s.activities?.held?.[idA] === 'cup_coffee', 'B sees A holding the coffee', 15_000);
    await shot(a, 'e2e-cafe-order-A');
    await closePanel(a);
    return 'held cup_coffee on both clients';
  });

  await check("8. A plays piano notes; B's client receives them and its audio graph plays them", async () => {
    const before = await b.evaluate(() => ({ s: window.__ELSEWHERE__.snapshot().activities.sound.pianoNotes, a: window.__ELSEWHERE_AUDIO__?.debug() }));
    await useThing(a, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'piano').position });
    for (const n of [0, 4, 7, 12]) {
      await a.click(`[data-testid=piano-keys] [data-note="${n}"]`);
      await sleep(300);
    }
    await a.keyboard.press('KeyZ'); // desktop keys play too (C4)
    await waitFor(async () => (await b.evaluate(() => window.__ELSEWHERE__.snapshot().activities.sound.pianoNotes)) >= before.s + 5, 'B received 5 notes', 20_000);
    const after = await b.evaluate(() => window.__ELSEWHERE_AUDIO__?.debug());
    assert(after?.state === 'running', `B audio context not running: ${after?.state}`);
    const played = (after.sfxCounts.piano ?? 0) - (before.a?.sfxCounts?.piano ?? 0);
    assert(played >= 5, `B's audio graph played ${played} piano notes`);
    await shot(a, 'e2e-piano-A');
    await closePanel(a);
    return `B received and played ${played} notes (voices created ${after.stats?.voicesCreated})`;
  });

  await check('9. both work on the town project; both see the stage advance and the finished project appear outside', async () => {
    await Promise.all([useThing(a, 'station_workshop_anvil', { panel: 'panel-project', approach: interiorAnchor('workshop', 'anvil').position }), useThing(b, 'station_workshop_kiln', { panel: 'panel-project', approach: interiorAnchor('workshop', 'kiln').position })]);
    await waitSnap(a, (s) => s.activities?.project?.stage >= 1, 'stage 1 on A', 20_000);
    await waitSnap(b, (s) => s.activities?.project?.stage >= 1, 'stage 1 on B', 20_000);
    const stage1 = (await act(a)).project;
    await shot(a, 'e2e-workshop-stage1-A');
    await sleep(CONFIG.activities.projectCooldownMs + 500);
    await closePanel(a);
    await closePanel(b);
    await Promise.all([useThing(a, 'station_workshop_anvil', { panel: 'panel-project' }), useThing(b, 'station_workshop_kiln', { panel: 'panel-project' })]);
    await waitSnap(a, (s) => s.activities?.project?.completed?.includes('square_lanterns') && s.activities.outdoor.includes('square_lanterns'), 'A: finished + lanterns outside', 30_000);
    await waitSnap(b, (s) => s.activities?.project?.completed?.includes('square_lanterns') && s.activities.outdoor.includes('square_lanterns'), 'B: finished + lanterns outside', 30_000);
    await waitFor(async () => !!(await b.$('[data-testid=project-done-square_lanterns]')), 'B panel lists the finished project', 15_000);
    await shot(b, 'e2e-workshop-done-B');
    await closePanel(a);
    await closePanel(b);
    return `stage ${stage1.stage}/${stage1.stages} then finished; next: ${(await act(a)).project.projectId}`;
  });

  await check('10. online count stays exactly 2 with keepers on duty', async () => {
    const ka = (await act(a)).keepers;
    const onDuty = KEEPERS.filter((k) => ka[k.id].present).length;
    assert(onDuty > 0, 'no keeper on duty');
    for (const p of [a, b]) {
      assert((await online(p)) === 2, `online count ${await online(p)}`);
      assert((await snap(p)).players.length === 2, 'player list != 2');
      assert((await act(p)).online === 2, 'roster != 2');
    }
    return `${onDuty} keepers on duty; HUD and roster show 2 on both`;
  });

  await check('11. after a server restart: notice, vote tally, workshop progress + finished project, guest book still there', async () => {
    const before = await act(a);
    restarting = true;
    await stopServer();
    await sleep(1500);
    await startServer();
    await waitSnap(a, (s) => s.connection === 'connected' && s.players.length >= 2, 'A rejoined', 120_000);
    await waitSnap(b, (s) => s.connection === 'connected' && s.players.length >= 2, 'B rejoined', 120_000);
    restarting = false;
    for (const [label, p] of [['A', a], ['B', b]]) {
      const s = await waitSnap(p, (x) => !!x.activities?.project?.completed?.length && (x.activities.poll.tallies ?? []).length > 0, `${label} activity state after restart`, 30_000);
      const ac = s.activities;
      assert(ac.notices.some((e) => e.text === NOTICE), `${label}: notice missing`);
      assert(ac.poll.tallies.reduce((x, y) => x + y, 0) === 2 && ac.poll.key === before.poll.key, `${label}: tally ${JSON.stringify(ac.poll.tallies)}`);
      assert(ac.project.completed.includes('square_lanterns') && ac.project.projectId === before.project.projectId, `${label}: project ${JSON.stringify(ac.project)}`);
      assert(ac.guestbooks.book_house_1.some((e) => e.text === SIGNATURE), `${label}: guest book entry missing`);
      await waitSnap(p, (x) => x.activities.outdoor.includes('square_lanterns'), `${label}: lanterns outside after restart`, 20_000);
    }
    assert((await online(a)) === 2 && (await online(b)) === 2, 'online count after restart');
    return `notice, tally ${JSON.stringify(before.poll.tallies)}, project ${before.project.projectId} (completed ${before.project.completed.join(',')}), guest book: all restored`;
  });

  await check('12. zero console / page errors in both clients', async () => {
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
console.log(`[activities] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
void isWalkable;
void where;
