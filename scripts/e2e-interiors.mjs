#!/usr/bin/env node
/**
 * Walk-in interiors, end to end: two REAL browser clients against the REAL
 * production build (Playwright; global install loaded with createRequire).
 *
 *   npm run build && npm run e2e:interiors
 *
 * Spawns its own production server (`node server/dist/index.js`, PORT
 * $INT_PORT or 2631, fresh DATA_DIR in the OS temp dir unless $INT_DATA_DIR).
 * Client A: desktop 1440×900 (mouse + keyboard). Client B: Pixel 7 emulation
 * (touch + keyboard). Both join with `?autojoin=1` and low graphics (headless
 * WebGL is software-rendered; this changes rendering cost only).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. both clients in the same world
 *  2. A walks INTO the Café by click-to-move (A* through the door) — A inside, B outside: consistent state
 *  3. cutaway: open for A (inside), closed for B (outside); B does not see A's name tag through the roof
 *  4. B walks in by KEYBOARD through the door; both inside; each sees the other inside
 *  5. indoors: name tags shown, a speech bubble over B on A's screen, B gets an interaction prompt for an indoor seat
 *  6. A taps/clicks an indoor chair: walks to it and sits; B sees A seated on that chair
 *  7. walls hold: A (standing again) holds a key into the back wall — stays inside, server agrees
 *  8. A walks out by KEYBOARD, B by TAP-to-move; cutaways close for both
 *  9. zero console / page errors in both clients
 *
 * Env: INT_PORT, INT_DATA_DIR, INT_SHOTS (screenshot dir; default: none), INT_VERBOSE=1.
 * Nothing here simulates players: every action is a real input in a real page.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, getInteractable, getInterior, interiorAnchor, interiorAt, isWalkable, rotateOffset } from '@elsewhere/shared';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.INT_PORT ?? 2631);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.INT_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-interiors-'));
const SHOTS = process.env.INT_SHOTS ? path.resolve(ROOT, process.env.INT_SHOTS) : null;
const T = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[interiors]', ...a);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[interiors] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Server (production build)
// ---------------------------------------------------------------------------
let server = null;
let serverExit = null;
async function startServer() {
  assert(existsSync(path.join(ROOT, 'server/dist/index.js')) && existsSync(path.join(ROOT, 'client/dist/index.html')), 'production build missing: run `npm run build` first');
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR, SESSION_SECRET: randomBytes(32).toString('hex') };
  server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverExit = new Promise((r) => server.once('exit', r));
  server.stdout.on('data', (d) => process.env.INT_VERBOSE && process.stdout.write(`[server] ${d}`));
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
// Page helpers
// ---------------------------------------------------------------------------
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${label} console.error: ${m.text()}`);
  });
}
const snap = (page) => page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
const query = (page, name, ...args) => page.evaluate(([n, a]) => window.__ELSEWHERE__.query(n, ...a), [name, args]);
async function waitSnap(page, pred, label, timeout = T) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}; last local ${JSON.stringify(last?.local)} interior ${JSON.stringify(last?.interior)} path ${JSON.stringify(last?.motion?.path?.goal ?? null)}`);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 78, scale: 'css' }).catch((e) => log('screenshot failed', name, e.message));
}
const where = (p) => interiorAt(p)?.id ?? 'outdoors';
const posOf = (s, id) => s.players.find((p) => p.id === id);
async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
}
/** Screen point of a world point (floor height by default) that lands on the canvas. */
async function screenOf(page, x, z, y) {
  const p = await query(page, 'worldToScreen', x, z, y);
  assert(p, `no screen point for (${x.toFixed(1)}, ${z.toFixed(1)})`);
  const vp = page.viewportSize();
  assert(p.x > 10 && p.y > 10 && p.x < vp.width - 10 && p.y < vp.height - 10, `(${x.toFixed(1)}, ${z.toFixed(1)}) is off screen at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
  assert(await onCanvas(page, p.x, p.y), `UI covers ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
  return p;
}
async function tapOrClick(page, x, y) {
  if (page.__touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/**
 * Click/tap-to-move in hops towards a far target: click the on-screen point
 * along the way (the camera follows), until the target itself is on screen.
 */
async function hopToward(page, target, near = 1.5, timeout = 120_000) {
  const vp = page.viewportSize();
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (Math.hypot(s.local.x - target.x, s.local.z - target.z) < near) return s;
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    const tp = await query(page, 'worldToScreen', target.x, target.z);
    let x = tp.x;
    let y = tp.y;
    const m = 0.16;
    const inside = (px, py) => px > vp.width * m && px < vp.width * (1 - m) && py > vp.height * m && py < vp.height * (1 - m);
    if (!inside(x, y)) {
      // walk the screen ray from me towards the target until it leaves the safe box
      let k = 1;
      for (; k > 0.05; k -= 0.05) if (inside(me.x + (tp.x - me.x) * k, me.y + (tp.y - me.y) * k)) break;
      x = me.x + (tp.x - me.x) * k;
      y = me.y + (tp.y - me.y) * k;
    }
    if (!(await onCanvas(page, x, y))) y -= 40;
    await tapOrClick(page, x, y);
    await sleep(300);
    await waitSnap(page, (q) => !q.motion?.path && q.local.speed < 0.05, 'hop finished', 30_000);
  }
  throw new Error(`could not hop to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
}

/**
 * Route (A* on a 0.25 m grid over the shared collision) — what a person
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

const cafe = getInterior('cafe');
const door = cafe.doors[0];
const out = (d) => {
  const o = rotateOffset({ x: 0, z: cafe.footprint.halfDepth + d }, cafe.footprint.yaw);
  return { x: cafe.footprint.center.x + o.x, z: cafe.footprint.center.z + o.z };
};
let idA = '';
let idB = '';
try {
  await check('1. both clients join the same world', async () => {
    await a.goto(`${BASE}/?autojoin=1`);
    await b.goto(`${BASE}/?autojoin=1`);
    const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2, 'A sees 2 players');
    const sb = await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2, 'B sees 2 players');
    idA = sa.sessionId;
    idB = sb.sessionId;
    await waitSnap(a, (s) => s.navReady === true, 'A nav grid ready');
    await waitSnap(b, (s) => s.navReady === true, 'B nav grid ready');
    return `A=${idA} at (${sa.local.x.toFixed(1)}, ${sa.local.z.toFixed(1)}), B=${idB}`;
  });

  await check('2. A walks INTO the Café by click-to-move (path through the door); A inside, B outside, consistent on both clients', async () => {
    // First a click near the café terrace (in view from the square), then a click on the café floor (roof closed: the click lands on the floor under it).
    let s;
    await hopToward(a, out(2.5), 1.2);
    const target = interiorAnchor('cafe', 'table_2').position;
    const p = await screenOf(a, target.x, target.z);
    await tapOrClick(a, p.x, p.y);
    await sleep(150);
    s = await snap(a);
    const path = s.motion?.path;
    assert(path && path.goal, 'no path planned');
    // the planned polyline passes through the door opening
    const pts = [s.local, ...path.points];
    let viaDoor = false;
    for (let i = 1; i < pts.length; i++)
      for (let t = 0; t <= 1; t += 0.05) {
        const q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
        if (Math.hypot(q.x - door.position.x, q.z - door.position.z) < door.width / 2 + 0.25) viaDoor = true;
      }
    assert(viaDoor, `planned path does not use the door: ${JSON.stringify(path.points)}`);
    const sa = await waitSnap(a, (x) => !x.motion?.path && where(x.local) === 'cafe', 'A inside the café', 60_000);
    await sleep(600);
    const sb = await waitSnap(b, (x) => posOf(x, idA) && where(posOf(x, idA)) === 'cafe', "B's room state has A inside", 10_000);
    const sbSelf = sb.local;
    assert(where(sbSelf) === 'outdoors', `B should be outside, is ${where(sbSelf)}`);
    const pa = posOf(sb, idA);
    const auth = posOf(sa, idA);
    assert(Math.hypot(pa.x - auth.x, pa.z - auth.z) < 0.5, `A's position differs between clients: ${JSON.stringify(pa)} vs ${JSON.stringify(auth)}`);
    await shot(a, 'e2e-1-A-inside-cafe');
    return `A at (${sa.local.x.toFixed(2)}, ${sa.local.z.toFixed(2)}) in ${where(sa.local)}; B sees A at (${pa.x.toFixed(2)}, ${pa.z.toFixed(2)}); B is outdoors`;
  });

  await check("3. cutaway open for A (inside), closed for B (outside); B does not see A's name tag through the roof", async () => {
    const sa = await waitSnap(a, (x) => x.interior?.active === 'cafe' && x.interior.amount > 0.9, "A's café cutaway open", 10_000);
    const sb = await snap(b);
    assert(sb.interior?.active === null, `B's cutaway should be closed, is ${JSON.stringify(sb.interior)}`);
    const tag = await b.evaluate((id) => {
      const el = document.querySelector(`[data-actor="${id}"]`);
      if (!el) return 'absent';
      const label = el.querySelector('.ew-label');
      return Number(getComputedStyle(el).opacity) < 0.05 || label?.classList.contains('ew-off') ? 'hidden' : 'shown';
    }, idA);
    assert(tag !== 'shown', `A's tag is shown on B's screen while A is under the roof`);
    return `A interior ${JSON.stringify(sa.interior)}; B interior ${JSON.stringify(sb.interior)}; A's tag on B: ${tag}`;
  });

  await check('4. B walks in by KEYBOARD through the door; both inside and each sees the other inside', async () => {
    // Tap-to-move across town to the café terrace, then KEYBOARD only: door apron → doorway → inside.
    const terrace = (() => {
      const o = rotateOffset({ x: -1.4, z: 0 }, cafe.footprint.yaw);
      return { x: out(2.6).x + o.x, z: out(2.6).z + o.z };
    })();
    await hopToward(b, terrace, 1.2);
    const sb0 = await snap(b);
    await keyboardRoute(b, [out(1.2), door.inside, interiorAnchor('cafe', 'table_3').position], { timeout: 90_000 });
    const sb = await waitSnap(b, (x) => where(x.local) === 'cafe' && x.interior?.active === 'cafe' && x.interior.amount > 0.9, 'B inside with cutaway', 15_000);
    const sa = await waitSnap(a, (x) => posOf(x, idB) && where(posOf(x, idB)) === 'cafe', "A's room state has B inside", 10_000);
    await waitSnap(b, (x) => posOf(x, idA) && where(posOf(x, idA)) === 'cafe', "B's room state has A inside", 5_000);
    await shot(b, 'e2e-2-B-inside-phone');
    return `B walked from (${sb0.local.x.toFixed(1)}, ${sb0.local.z.toFixed(1)}) to (${sb.local.x.toFixed(2)}, ${sb.local.z.toFixed(2)}) by keys; A sees B at (${posOf(sa, idB).x.toFixed(2)}, ${posOf(sa, idB).z.toFixed(2)})`;
  });

  await check('5. indoors: name tags shown, a speech bubble over B on A, B gets an interaction prompt for an indoor seat', async () => {
    const tagOn = async (page, id) =>
      page.evaluate((id) => {
        const el = document.querySelector(`[data-actor="${id}"]`);
        const label = el?.querySelector('.ew-label');
        return !!el && Number(getComputedStyle(el).opacity) > 0.3 && !!label && !label.classList.contains('ew-off');
      }, id);
    const t0 = Date.now();
    while (Date.now() - t0 < 10_000 && !((await tagOn(a, idB)) && (await tagOn(b, idA)))) await sleep(250);
    assert(await tagOn(a, idB), "B's name tag not shown on A");
    assert(await tagOn(b, idA), "A's name tag not shown on B");
    // B speaks (proximity) through the real chat UI; A sees the bubble over B.
    const text = `cosy in here ${Date.now() % 10000}`;
    // A bubble lives ~5 s, and B's chat UI steps (send, close) can take longer than that on a
    // software-rendered page: A's page records the bubble from BEFORE B sends (DOM observer + rAF).
    await a.evaluate(([id, text]) => {
      const rec = { seen: '', t0: performance.now() };
      window.__bubbleRec = rec;
      const look = () => {
        const el = document.querySelector(`[data-actor="${id}"] .ew-bubble`);
        if (!rec.seen && el && !el.classList.contains('ew-off') && (el.textContent ?? '').includes(text)) rec.seen = el.textContent ?? '';
      };
      const mo = new MutationObserver(look);
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ['class'] });
      const tick = () => {
        look();
        if (!rec.seen && performance.now() - rec.t0 < 30_000) requestAnimationFrame(tick);
        else mo.disconnect();
      };
      requestAnimationFrame(tick);
    }, [idB, text]);
    if (!(await b.$('[data-testid=chat]'))) await b.click('[data-testid=nav-chat]');
    await b.click('[data-testid=chat-tab-nearby]');
    await b.fill('[data-testid=chat-input]', text);
    const t1 = Date.now();
    await b.press('[data-testid=chat-input]', 'Enter');
    if (await b.$('[data-testid=chat-close]')) await b.click('[data-testid=chat-close]', { timeout: 10_000 }).catch(() => undefined);
    let bubble = '';
    while (Date.now() - t1 < 10_000) {
      bubble = await a.evaluate(() => window.__bubbleRec?.seen ?? '');
      if (bubble.includes(text)) break;
      await sleep(200);
    }
    if (!bubble.includes(text)) bubble = await a.evaluate(() => window.__bubbleRec?.seen ?? '');
    if (!bubble.includes(text)) {
      const ra = (await snap(a)).ui?.rawChat ?? [];
      const rb = (await snap(b)).ui?.rawChat ?? [];
      throw new Error(`no bubble over B on A (got "${bubble}"); A raw chat ${JSON.stringify(ra.slice(-2))}; B raw chat ${JSON.stringify(rb.slice(-2))}`);
    }
    // Interaction prompt for an indoor seat (B stands by table 3 with its two chairs).
    const sb = await waitSnap(b, (x) => x.target?.kind === 'interactable' && where(getInteractable(x.target.id)?.position ?? { x: 0, z: 0 }) === 'cafe', 'B targets an indoor interactable', 10_000);
    // desktop: the HUD prompt; touch: the thumb action button carries it
    const prompt = await b.evaluate(() => {
      const el = document.querySelector('[data-testid=interact-prompt]') ?? document.querySelector('[data-testid=touch-action]');
      return el ? `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}` : '';
    });
    assert(prompt.trim().length > 0, 'no interaction prompt shown on B');
    await shot(a, 'e2e-3-A-sees-bubble');
    return `tags on both; bubble "${bubble.trim()}"; B targets ${sb.target.id}${prompt ? ` (prompt "${prompt.trim()}")` : ''}`;
  });

  await check('6. A taps an indoor chair: walks to it and sits; B sees A seated on it', async () => {
    const chair = getInteractable('chair_cafe_in_1b');
    const p = await screenOf(a, chair.position.x, chair.position.z, cafe.floorY + 0.7); // pick anchors sit 0.7 m up
    const pick = await query(a, 'pick', p.x, p.y, 'mouse');
    assert(pick?.id === chair.id, `the click would pick ${JSON.stringify(pick)} instead of the chair`);
    await tapOrClick(a, p.x, p.y);
    const sb = await waitSnap(b, (x) => posOf(x, idA)?.seat === `${chair.id}#0`, 'B sees A on the chair', 45_000);
    const sa = await snap(a);
    await shot(b, 'e2e-4-B-sees-A-seated');
    return `A seat ${posOf(sa, idA).seat}; B sees A seat ${posOf(sb, idA).seat}, anim ${posOf(sb, idA).anim}`;
  });

  await check('7. walls hold: A holds a key into the back wall — stays inside, server agrees', async () => {
    // stand up by walking (moving while seated sends `stand`), then push into the back wall for 2.5 s
    // stand up and step to a spot with a clear line to the back wall (between the plant and the counter)
    const lane = interiorAnchor('cafe', 'table_3').position;
    await keyboardRoute(a, [lane], { timeout: 40_000 });
    const sa0 = await snap(a);
    const back = rotateOffset({ x: 0, z: -1 }, cafe.footprint.yaw);
    const far = { x: sa0.local.x + back.x * 12, z: sa0.local.z + back.z * 12 };
    await keyboardWalk(a, [far], { timeout: 5_000 }).catch(() => undefined); // times out against the wall — expected
    await sleep(800);
    const sa = await snap(a);
    const auth = posOf(sa, idA);
    assert(auth.seat === '', `A still seated: ${auth.seat}`);
    assert(where(sa.local) === 'cafe' && where(auth) === 'cafe', `A left the café: local ${where(sa.local)}, server ${where(auth)}`);
    assert(Math.hypot(sa.local.x - auth.x, sa.local.z - auth.z) < 0.4, 'client and server disagree');
    const l = { x: auth.x - cafe.footprint.center.x, z: auth.z - cafe.footprint.center.z };
    const depth = -(l.x * Math.sin(cafe.footprint.yaw) + l.z * Math.cos(cafe.footprint.yaw));
    assert(depth > cafe.inner.halfDepth - 0.5, `A stopped ${depth.toFixed(2)} m behind the centre — short of the back wall (${cafe.inner.halfDepth.toFixed(2)})`);
    return `pressed into the back wall: A stops ${depth.toFixed(2)} m behind the centre, against the wall's inner face at ${cafe.inner.halfDepth.toFixed(2)} (radius ${0.4}); server (${auth.x.toFixed(2)}, ${auth.z.toFixed(2)})`;
  });

  await check('8. A walks out by KEYBOARD, B by TAP-to-move; both cutaways close', async () => {
    await keyboardRoute(a, [door.inside, out(1.2), out(2.6)], { timeout: 120_000 });
    const sa = await waitSnap(a, (x) => where(x.local) === 'outdoors' && x.interior?.active === null, 'A outside with cutaway closed', 10_000);
    const target = out(3.0);
    const offset = rotateOffset({ x: 1.6, z: 0 }, cafe.footprint.yaw);
    const goal = { x: target.x + offset.x, z: target.z + offset.z };
    await hopToward(b, goal, 1.0);
    const sb = await waitSnap(b, (x) => !x.motion?.path && where(x.local) === 'outdoors' && x.interior?.active === null, 'B outside with cutaway closed', 60_000);
    await waitSnap(a, (x) => posOf(x, idB) && where(posOf(x, idB)) === 'outdoors', 'A sees B outside', 10_000);
    return `A (${sa.local.x.toFixed(1)}, ${sa.local.z.toFixed(1)}), B (${sb.local.x.toFixed(1)}, ${sb.local.z.toFixed(1)}) — both outdoors`;
  });

  await check('9. zero console / page errors in both clients', async () => {
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
console.log(`[interiors] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
