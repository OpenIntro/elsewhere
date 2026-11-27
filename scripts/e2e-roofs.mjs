#!/usr/bin/env node
/**
 * Roofs attach — two real browsers against a production server.
 *
 *   npm run build && npm run e2e:roofs
 *
 * Walls are staged through the real server path (protocol clients with each
 * browser's own session, on a staging run of the server with a long build
 * range so it can reach every site). The server then restarts with the
 * DEFAULT settings (normal range, rate limits) on the same data, both
 * browsers reload as the same profiles, and every roof goes on through the
 * real UI: desktop A by mouse (hover → click), phone B by touch (tap → Place).
 *
 * Checks (named):
 *  1. both clients join and see every staged wall
 *  2..11. one roof per house in ONE action (one click / one Place), covering:
 *     one storey; two storeys aimed at the GROUND floor; doors + windows in
 *     every side, from INSIDE; an odd 3 m side with its 1 m gap with the
 *     storey control locked on the WRONG storey; a wall segment left out;
 *     an open porch from inside (touch); a 2x2 hut (touch); a 6x4 whose west
 *     wall is a neighbour's, with a garden wall at a corner; a 2x3; a 2x2
 *     right next to House 1 (its eaves shorten) — at all four camera
 *     rotations, by mouse and by touch; the other client sees each roof
 *  12. every deliberately invalid case shows its specific reason in the build
 *      status (two sides only, half walls, someone else's walls, too far) and
 *      clicking places nothing
 *  13. zero console / page errors in both clients
 *
 * Env: ROOFS_PORT (default 2674), ROOFS_DATA_DIR, ROOFS_SHOTS (screenshot dir), ROOFS_VERBOSE=1.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, buildState, choosePiece, closeBuild, hopToward, onCanvas, openBuild, press, query, sleep, snap, waitSnap, zoomOut } from './lib/browser.mjs';
import { builderClient } from './lib/seed.mjs';
import { ROOF_HOUSES, ROOF_REFUSALS } from './lib/roofPlans.mjs';
import { resultFile, shotsDir } from './lib/report.mjs';
import { createServer } from './lib/server.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ROOFS_PORT ?? 2674);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.ROOFS_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-roofs-'));
const SHOTS = shotsDir(process.env.ROOFS_SHOTS, null, ROOT);
const VERBOSE = process.env.ROOFS_VERBOSE === '1';
const SECRET = randomBytes(32).toString('hex');
const STOREY = 2.6;
const log = (...a) => console.log('[roofs]', ...a);
const vlog = (...a) => VERBOSE && log(...a);

// --- checks -------------------------------------------------------------------
const results = [];
const resultOut = resultFile('roofs', () => pageErrors);
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    resultOut.add(name, true, detail ?? '');
    console.log(`[roofs] PASS ${name}${detail ? ` — ${detail}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false });
    resultOut.add(name, false, String(err?.message ?? err));
    console.log(`[roofs] FAIL ${name} — ${String(err?.message ?? err)}`);
    const tag = name.split('.')[0];
    for (const [label, page] of [['A', a], ['B', b]]) if (page) await shot(page, `fail-${tag}-${label}`);
    // Leave build mode so the next check starts from a known state.
    for (const page of [a, b]) if (page && (await page.locator('[data-testid=build-done]').isVisible().catch(() => false))) await press(page, '[data-testid=build-done]').catch(() => undefined);
  }
}

// --- server -------------------------------------------------------------------
// The real run uses the server's own defaults for these (the staging run overrides them).
for (const k of ['BUILD_RANGE', 'BUILD_RATE_CAPACITY', 'BUILD_RATE_PER_SECOND', 'BUILD_MAX_PER_PLAYER']) delete process.env[k];
const serverOpts = { port: PORT, dataDir: DATA_DIR, label: 'roofs', verbose: VERBOSE, logPrefix: '[roofs] server: ' };
const stagingServer = createServer({ ...serverOpts, env: { SESSION_SECRET: SECRET, BUILD_RANGE: '400', BUILD_RATE_CAPACITY: '1000', BUILD_RATE_PER_SECOND: '1000' } });
const realServer = createServer({ ...serverOpts, env: { SESSION_SECRET: SECRET } });
let server = null;
async function startServer(handle) {
  server = handle;
  await handle.start();
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await s.stop();
}

// --- browsers -------------------------------------------------------------------
const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The planned server restart drops the websocket once; the browser logs that as a failed connection.
    if (restarting && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) return;
    pageErrors.push(`${label}: ${m.text()}`);
  });
}
let restarting = false;
let a = null;
let b = null;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 80 }).catch((e) => log('screenshot failed', name, e.message));
}

// --- helpers ------------------------------------------------------------------------
/** Build mode on/off through the UI: a tap on the phone, a click on the desktop. */
async function enterBuild(page) {
  if (!page.__touch) return openBuild(page);
  if (!(await page.$('[data-testid=build-dock]'))) await press(page, '[data-testid=nav-build]');
  await page.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
  await waitSnap(page, (s) => s.build?.synced && s.build.mode !== 'off', 'build mode on', 30_000);
}
async function leaveBuild(page) {
  if (!page.__touch) return closeBuild(page);
  if (await page.$('[data-testid=build-done]')) await press(page, '[data-testid=build-done]');
  await waitSnap(page, (s) => s.build?.mode === 'off', 'build mode off', 15_000);
}
const centre = (h) => ({ x: (h.box.x0 + h.box.x1) / 2, z: (h.box.z0 + h.box.z1) / 2 });
/** Wait until the camera stops moving (it follows the player with some lag). */
async function settleCamera(page) {
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const v = (await snap(page)).view;
    if (prev && Math.abs(v.focusX - prev.focusX) < 0.01 && Math.abs(v.focusZ - prev.focusZ) < 0.01 && Math.abs(v.yaw - prev.yaw) < 0.001 && Math.abs(v.zoom - prev.zoom) < 0.05) return v;
    prev = v;
    await sleep(250);
  }
  return prev;
}
async function turnCameraTo(page, quarter) {
  // Desktop: Q turns the camera a quarter. Count turns from the default yaw.
  for (let i = 0; i < 4; i++) {
    const v = await settleCamera(page);
    const k = ((Math.round((v.yaw - Math.PI / 4) / (Math.PI / 2)) % 4) + 4) % 4;
    if (k === quarter) return v;
    await page.keyboard.press('KeyQ');
    await waitSnap(page, (s) => Math.abs(s.view.yaw - v.yaw) > 1.2, 'camera turned', 15_000);
  }
  return settleCamera(page);
}
async function wallsOf(page, h) {
  const st = await buildState(page);
  return st.pieces.filter((p) => p.x >= h.box.x0 - 0.01 && p.x <= h.box.x1 + 0.01 && p.z >= h.box.z0 - 0.01 && p.z <= h.box.z1 + 0.01 && p.kind !== 'house_roof');
}
/** Screen points a player would point at for this house: the top of the walls over the middle, wall faces low and high, the floor. */
async function aimPoints(page, h, { groundFloor = false } = {}) {
  const ws = await wallsOf(page, h);
  const base = Math.min(...ws.map((w) => w.y));
  const levels = h.levels ?? 1;
  const c = centre(h);
  const pts = [];
  const wallFaces = (level, y) => {
    for (const w of ws.filter((q) => q.level === level)) {
      const n = w.rot % 2 === 0 ? { x: 0, z: 0.14 } : { x: 0.14, z: 0 };
      for (const s of [1, -1]) pts.push({ label: `${w.kind}(${w.x},${w.z}) ${s > 0 ? '+' : '-'} face, ${y.toFixed(1)} m up`, x: w.x + s * n.x, z: w.z + s * n.z, y: base + level * STOREY + y });
    }
  };
  if (groundFloor) wallFaces(0, 1.0);
  else {
    pts.push({ label: 'over the middle, at the wall tops', x: c.x, z: c.z, y: base + levels * STOREY });
    wallFaces(levels - 1, 1.9);
    pts.push({ label: 'the floor in the middle', x: c.x, z: c.z, y: base + 0.1 });
  }
  return pts;
}
/** Aim the roof tool at the first point that gives the expected roof; returns { point, ghost }. */
async function aimRoof(page, h, expect, opts) {
  const tried = [];
  for (const p of await aimPoints(page, h, opts)) {
    await settleCamera(page);
    const sp = await query(page, 'worldToScreen', p.x, p.z, p.y);
    const vp = page.viewportSize();
    if (!sp || sp.x < 8 || sp.y < 8 || sp.x > vp.width - 8 || sp.y > vp.height - 8 || !(await onCanvas(page, sp.x, sp.y))) {
      tried.push(`${p.label}: off screen / under the UI`);
      continue;
    }
    if (page.__touch) await page.touchscreen.tap(sp.x, sp.y);
    else await page.mouse.move(sp.x, sp.y, { steps: 3 });
    const s = await waitSnap(page, (q) => q.build.ghost && q.build.ghost.ok && Math.abs(q.build.ghost.x - expect.x) < 0.01 && Math.abs(q.build.ghost.z - expect.z) < 0.01 && q.build.ghost.level === expect.level, 'roof ghost', 4_000).catch(() => null);
    if (s) return { point: p, screen: sp, ghost: s.build.ghost };
    const g = (await buildState(page)).ghost;
    tried.push(`${p.label}: ${g ? `${g.ok ? 'green' : 'red'} at (${g.x},${g.z}) L${g.level} ${g.message ?? ''}` : 'no ghost'}`);
  }
  throw new Error(`no aim point gave the roof at (${expect.x}, ${expect.z}) L${expect.level}: ${tried.join(' | ')}`);
}

// ---------------------------------------------------------------------------------------
try {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  log(`data dir ${DATA_DIR}; server ${BASE}`);
  // Stage: a server with a long build range so protocol clients can reach every site.
  await startServer(stagingServer);
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxA.addInitScript(LOW_GFX);
  a = await ctxA.newPage();
  watch(a, 'A(desktop)');
  const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
  await ctxB.addInitScript(LOW_GFX);
  b = await ctxB.newPage();
  b.__touch = true;
  watch(b, 'B(phone)');
  for (const p of [a, b]) {
    await p.goto(`${BASE}/?autojoin=1`);
    await waitSnap(p, (s) => s.local?.ready && s.build?.synced, 'joined', 120_000);
  }
  const tokens = { A: await a.evaluate(() => localStorage.getItem('elsewhere.session.v1')), B: await b.evaluate(() => localStorage.getItem('elsewhere.session.v1')) };
  const stagers = { A: await builderClient(BASE, { token: tokens.A }), B: await builderClient(BASE, { token: tokens.B }) };
  let staged = 0;
  const stageRefused = [];
  for (const h of [...ROOF_HOUSES, ...ROOF_REFUSALS])
    for (const w of h.build(h.box)) {
      const c = stagers[w.owner];
      let r = await c.place(w);
      if (!r.ok && r.natureId) {
        await c.clear(r.natureId);
        r = await c.place(w);
      }
      if (r.ok) staged++;
      else stageRefused.push(`${h.id} ${w.kind}@${w.x},${w.z}L${w.level} ${r.reason}`);
    }
  for (const c of Object.values(stagers)) await c.leave();
  assert(stageRefused.length === 0, `staging refused: ${stageRefused.join('; ')}`);
  // The real run: default server settings (range, rate limits) on the same data.
  restarting = true;
  await stopServer();
  await startServer(realServer);
  for (const p of [a, b]) await p.reload();
  for (const p of [a, b]) await waitSnap(p, (s) => s.local?.ready && s.navReady && s.build?.synced && s.connection === 'connected', 'rejoined', 120_000);
  restarting = false;

  await check('1. both clients join (default server settings) and see every staged wall', async () => {
    const sa = await waitSnap(a, (s) => s.build.count === staged && s.players.length >= 2, `A has ${staged} pieces`, 30_000);
    const sb = await waitSnap(b, (s) => s.build.count === staged, `B has ${staged} pieces`, 30_000);
    return `${sa.build.count} walls on A and ${sb.build.count} on B; A owns ${sa.build.mine}, B owns ${sb.build.mine}`;
  });

  // Desktop houses rotate through the four camera quarters; touch houses use the phone's default view.
  const plan = {
    'one-storey': { quarter: 0 },
    'two-storeys': { quarter: 1, groundFloor: true },
    'doors-windows': { quarter: 2 },
    'odd-gap': { quarter: 3 },
    'mixed-owner': { quarter: 0 },
    'two-by-three': { quarter: 1 },
    'by-house-1': { quarter: 2 },
  };
  let n = 2;
  for (const h of ROOF_HOUSES) {
    const page = h.by === 'A' ? a : b;
    const other = page === a ? b : a;
    const opts = plan[h.id] ?? {};
    await check(`${n++}. ${h.label}: roofed in one ${page.__touch ? 'tap + Place' : 'click'}${h.inside ? ' from inside' : ' from outside'}${opts.quarter !== undefined ? `, camera quarter ${opts.quarter}` : ''}; the other client sees it`, async () => {
      await leaveBuild(page).catch(() => undefined);
      const c = centre(h);
      const stand = h.inside ? c : { x: c.x + 0.6, z: h.box.z1 + 2.4 };
      await hopToward(page, stand, h.inside ? 0.7 : 1.3, 240_000);
      const me = (await snap(page)).local;
      if (h.inside) assert(me.x > h.box.x0 && me.x < h.box.x1 && me.z > h.box.z0 && me.z < h.box.z1, `not inside: ${JSON.stringify(me)}`);
      if (!page.__touch && opts.quarter !== undefined) await turnCameraTo(page, opts.quarter);
      await enterBuild(page);
      if (h.lock) {
        // The storey control locked on the wrong storey (storey 3) before choosing the roof.
        for (let i = 0; i < 3; i++) await page.keyboard.press('PageUp');
        await waitSnap(page, (s) => s.build.lockLevel !== null && s.build.lockLevel >= 2, 'storey locked', 10_000);
      }
      await choosePiece(page, 'house_roof', { category: 'roof' });
      const levels = h.levels ?? 1;
      const expect = { x: c.x, z: c.z, level: levels };
      const aimed = await aimRoof(page, h, expect, { groundFloor: !!opts.groundFloor });
      const s0 = await snap(page);
      const sentBefore = s0.build.stats.results.ok + s0.build.stats.results.refused;
      if (page.__touch) await press(page, '[data-testid=build-place]');
      else await page.mouse.click(aimed.screen.x, aimed.screen.y);
      const s1 = await waitSnap(page, (q) => q.build.stats.results.ok + q.build.stats.results.refused > sentBefore, 'server answer', 20_000);
      assert(s1.build.stats.results.ok === s0.build.stats.results.ok + 1 && s1.build.stats.results.refused === s0.build.stats.results.refused, `not placed: ${JSON.stringify(s1.build.refusal)}`);
      const roof = s1.build.pieces.find((p) => p.kind === 'house_roof' && p.x === expect.x && p.z === expect.z && p.level === expect.level);
      assert(roof, 'no roof piece where the ghost was');
      const params = JSON.parse(roof.params);
      const span = { sx: h.box.x1 - h.box.x0, sz: h.box.z1 - h.box.z0 };
      assert((roof.rot % 2 === 0 ? params.w === span.sx && params.d === span.sz : params.w === span.sz && params.d === span.sx), `roof ${roof.params} rot ${roof.rot} does not span ${span.sx}x${span.sz}`);
      await waitSnap(other, (q) => q.build.pieces.some((p) => p.id === roof.id), 'the other client sees the roof', 20_000);
      await leaveBuild(page);
      await shot(page, `roof-${h.id}`);
      return `${roof.params} at (${roof.x}, ${roof.z}) storey ${roof.level} y ${roof.y}; aimed at ${aimed.point.label}${h.lock ? `; storey lock was on storey ${(s0.build.lockLevel ?? 0) + 1}` : ''}; yaw ${(((aimed.ghost && (await snap(page)).view.yaw) * 180) / Math.PI).toFixed(0)}°`;
    });
  }

  await check(`${n++}. invalid houses: the build status says exactly why, and a click places nothing`, async () => {
    const out = [];
    for (const h of ROOF_REFUSALS) {
      await closeBuild(a).catch(() => undefined);
      const c = centre(h);
      if (h.far) {
        // Stand well beyond the build range from the nearest wall, then look back at the house.
        await hopToward(a, { x: c.x, z: h.box.z1 + 11 }, 1.5, 240_000);
        const me = (await snap(a)).local;
        const dist = Math.hypot(Math.max(h.box.x0 - me.x, 0, me.x - h.box.x1), Math.max(h.box.z0 - me.z, 0, me.z - h.box.z1));
        assert(dist > 9.2, `only ${dist.toFixed(1)} m from the house`);
        await zoomOut(a, 2);
      } else {
        await hopToward(a, { x: c.x + 0.6, z: h.box.z1 + 2.4 }, 1.3, 240_000);
      }
      await turnCameraTo(a, 0);
      await openBuild(a);
      await choosePiece(a, 'house_roof', { category: 'roof' });
      await settleCamera(a);
      const base = Math.min(...(await wallsOf(a, h)).map((w) => w.y));
      const sp = await query(a, 'worldToScreen', c.x, c.z, base + STOREY);
      await a.mouse.move(sp.x, sp.y, { steps: 3 });
      const g = await waitSnap(a, (q) => q.build.ghost && !q.build.ghost.ok && q.build.ghost.message === h.message, `red ghost "${h.message}"`, 8_000).catch(async () => {
        throw new Error(`${h.id}: ghost ${JSON.stringify((await buildState(a)).ghost)}`);
      });
      const status = (await a.textContent('[data-testid=build-status]')) ?? '';
      assert(status.includes(h.message), `${h.id}: the status shows "${status}"`);
      if (h.id === 'two-sides' || h.id === 'theirs') await shot(a, `roof-refused-${h.id}`);
      const okBefore = g.build.stats.results.ok;
      const roofsBefore = g.build.pieces.filter((p) => p.kind === 'house_roof').length;
      await a.mouse.click(sp.x, sp.y);
      await sleep(1500);
      const after = await buildState(a);
      assert(after.stats.results.ok === okBefore && after.pieces.filter((p) => p.kind === 'house_roof').length === roofsBefore, `${h.id}: something was placed`);
      out.push(`${h.id}: "${h.message}"`);
    }
    await closeBuild(a);
    return out.join('; ');
  });

  await check(`${n++}. zero console / page errors in both clients`, async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  results.push({ name: 'script', ok: false });
  resultOut.add('script', false, String(err?.message ?? err));
  console.log(`[roofs] FAIL script — ${String(err?.stack ?? err)}`);
} finally {
  await browser.close().catch(() => undefined);
  await stopServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`[roofs] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
