#!/usr/bin/env node
/**
 * Player / camera / netcode end-to-end checks in real browsers (Playwright,
 * global install — loaded with createRequire like the smoke test).
 *
 *   node scripts/e2e-player.mjs
 *
 * Spawns its OWN server (tsx, PORT=$E2E_SERVER_PORT or 2604, fresh DATA_DIR in
 * the OS temp dir) and Vite dev server ($E2E_VITE_PORT or 5184, pointed at that
 * server) so it can kill/restart the server for the reconnection check.
 * Set E2E_URL to reuse an already running client+server instead (the
 * reconnection step is then skipped).
 *
 * Checks (each reported PASS/FAIL with numbers):
 *  1. keyboard movement is camera-relative, before and after a 90° rotation
 *  2. wheel zoom changes zoom and clamps to the limits
 *  2b. runtime.view is valid from the first snapshot and tracks a resize
 *  2c. clicking a cottage door walks through its garden gate (2 m gap) to the door
 *  3. click-to-move reaches a point behind a building; every sampled
 *     position (and the segments between them) is walkable
 *  4. the player cannot walk through a building or into the sea
 *  5. a second client sees smooth remote movement: positions monotonic along
 *     the walk, no jumps — from rendered frames (low graphics quality), or, if
 *     software rendering yields < 30 frames, from the interpolated pose sampled
 *     on a fixed 60 Hz timer via the debug hook (the detail says which)
 *  6. server killed + restarted → both clients reconnect automatically and
 *     see each other again
 *  7. mobile emulation: tap-to-move, joystick, pinch zoom, no page scroll/zoom
 *  8. no console errors (network errors during the deliberate outage excepted)
 *
 * Env: E2E_SERVER_PORT, E2E_VITE_PORT, E2E_VITE_CONFIG (custom vite config), E2E_CLIENT_DIST (serve a
 * prebuilt client from the spawned server, no Vite), E2E_URL, E2E_VERBOSE=1.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultFile } from './lib/report.mjs';

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}
const { chromium, devices } = await loadPlaywright();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 2604);
const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 5184);
const EXTERNAL = process.env.E2E_URL;
/** Serve a prebuilt client from the spawned server instead of running Vite (stable when others edit sources). */
const CLIENT_DIST = process.env.E2E_CLIENT_DIST;
const URL = EXTERNAL ?? (CLIENT_DIST ? `http://localhost:${SERVER_PORT}` : `http://localhost:${VITE_PORT}`);
/** `?autojoin=1` skips onboarding and joins as a random guest (see App.tsx). */
const PAGE_URL = (() => {
  const u = new globalThis.URL(URL);
  u.searchParams.set('autojoin', '1');
  return u.toString();
})();
/** Init script: persist settings.graphics = 'low' before the app boots (zustand persist format). */
const LOW_GRAPHICS = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elsewhere-e2e-'));

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const resultOut = resultFile('player', () => consoleErrors);
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  resultOut.add(name, ok, detail);
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------
const children = [];
function start(name, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}
function kill(child, signal = 'SIGKILL') {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* gone */
  }
}
async function waitHttp(url, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${url}`);
}
let server = null;
async function startServer() {
  // A distinctly named entry file so other developers' `pkill -f src/index.ts` cleanups don't hit this server.
  const entry = path.join(DATA_DIR, `e2e-player-server-${SERVER_PORT}.ts`);
  writeFileSync(entry, `import ${JSON.stringify(path.join(ROOT, 'server', 'src', 'index.ts'))};\n`);
  server = start('server', 'npx', ['tsx', '--conditions=source', entry], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(SERVER_PORT), DATA_DIR, ...(CLIENT_DIST ? { CLIENT_DIST } : {}) },
  });
  await waitHttp(`http://localhost:${SERVER_PORT}/api/health`);
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------
const consoleErrors = [];
let outage = false;
function watch(page, name) {
  page.on('pageerror', (e) => consoleErrors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (outage && /WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource|Failed to fetch|net::|matchmake|\[net\]/i.test(text)) return;
    consoleErrors.push(`${name}: ${text}`);
  });
}
const snap = (page) => page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
const query = (page, name, ...args) => page.evaluate(([n, a]) => window.__ELSEWHERE__.query(n, ...a), [name, args]);
async function waitFor(page, pred, label, timeout = 20_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page);
    if (last && pred(last)) return last;
    await sleep(120);
  }
  const brief = last && { connection: last.connection, sessionId: last.sessionId, players: last.players?.length, local: last.local, navReady: last.navReady, frame: last.frame, net: last.net };
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(brief)}`);
}
async function ready(page) {
  return waitFor(page, (s) => s.connection === 'connected' && s.local.ready && s.navReady === true, 'connected + nav grid ready', 90_000);
}
/** Walkable along a straight segment (0.2 m samples). */
async function segmentWalkable(page, a, b) {
  return page.evaluate(
    ([a, b]) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.2));
      for (let i = 0; i <= n; i++) {
        const x = a.x + ((b.x - a.x) * i) / n;
        const z = a.z + ((b.z - a.z) * i) / n;
        if (!window.__ELSEWHERE__.query('isWalkable', x, z)) return { ok: false, x, z };
      }
      return { ok: true };
    },
    [a, b],
  );
}
/** Count of non-walkable points (one round trip). */
async function countUnwalkable(page, pts) {
  return page.evaluate((pts) => pts.filter((q) => !window.__ELSEWHERE__.query('isWalkable', q.x, q.z)).length, pts.map((q) => ({ x: q.x, z: q.z })));
}
/** Distance along `d` from `o` to the first non-ground point (step `step`, up to `max`), Infinity if none. */
async function distToWater(page, o, d, max, step) {
  return page.evaluate(
    ([o, d, max, step]) => {
      for (let t = 0; t <= max; t += step) if (!window.__ELSEWHERE__.query('groundWalkable', o.x + d.x * t, o.z + d.z * t)) return t;
      return null;
    },
    [{ x: o.x, z: o.z }, d, max, step],
  ).then((v) => (v === null ? Infinity : v));
}
/** World direction for screen-relative key input at camera yaw. */
function keyDir(key, yaw) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  const [mx, my] = { KeyW: [0, 1], KeyS: [0, -1], KeyD: [1, 0], KeyA: [-1, 0] }[key];
  return { x: mx * c - my * s, z: -mx * s - my * c };
}
async function freeKey(page, yaw, dist = 3) {
  const s = await snap(page);
  for (const key of ['KeyW', 'KeyD', 'KeyS', 'KeyA']) {
    const d = keyDir(key, yaw);
    const r = await segmentWalkable(page, s.local, { x: s.local.x + d.x * dist, z: s.local.z + d.z * dist });
    if (r.ok) return key;
  }
  return 'KeyW';
}
async function holdAndMeasure(page, key, ms) {
  const a = (await snap(page)).local;
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
  await sleep(400);
  const b = (await snap(page)).local;
  return { dx: b.x - a.x, dz: b.z - a.z, from: a, to: b };
}
const angleBetween = (a, b) => {
  const la = Math.hypot(a.x, a.z);
  const lb = Math.hypot(b.x, b.z);
  return (Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.z * b.z) / (la * lb)))) * 180) / Math.PI;
};

/** Sample the local position every ~80 ms until `done` (returns samples). */
async function sampleUntil(page, done, timeout) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    out.push({ x: s.local.x, z: s.local.z, t: Date.now() - t0, path: s.motion?.path ?? null, speed: s.local.speed });
    if (done(s, out)) break;
    await sleep(80);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function testCameraRelative(page) {
  const s0 = await snap(page);
  const yaw0 = s0.camera.yaw;
  const k0 = await freeKey(page, yaw0);
  const m0 = await holdAndMeasure(page, k0, 700);
  const e0 = keyDir(k0, yaw0);
  const a0 = angleBetween({ x: m0.dx, z: m0.dz }, e0);
  await page.keyboard.press('KeyR');
  // The eased 90° turn takes ~0.5 s of real time; wait for a rendered frame at the end of it.
  const yaw1 = (await waitFor(page, (sn) => Math.abs(Math.abs(sn.camera.yaw - yaw0) - Math.PI / 2) < 0.005, 'rotation to settle', 10_000)).camera.yaw;
  const k1 = await freeKey(page, yaw1);
  const m1 = await holdAndMeasure(page, k1, 700);
  const e1 = keyDir(k1, yaw1);
  const a1 = angleBetween({ x: m1.dx, z: m1.dz }, e1);
  // The same key before the rotation would have gone 90° off.
  const wrong = angleBetween({ x: m1.dx, z: m1.dz }, keyDir(k1, yaw0));
  const rotated = Math.abs(Math.abs(yaw1 - yaw0) - Math.PI / 2) < 0.02;
  const ok = rotated && a0 < 20 && a1 < 20 && wrong > 60 && Math.hypot(m1.dx, m1.dz) > 1;
  record('keyboard movement is camera-relative after a 90° rotation', ok, `yaw ${yaw0.toFixed(3)}→${yaw1.toFixed(3)}; ${k0} err ${a0.toFixed(1)}°, after rotation ${k1} err ${a1.toFixed(1)}° (vs old mapping ${wrong.toFixed(0)}°), moved ${Math.hypot(m1.dx, m1.dz).toFixed(2)} m`);
  await page.keyboard.press('KeyQ');
  await sleep(700);
}

async function testZoom(page) {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const z0 = (await snap(page)).camera.zoomTarget;
  await page.mouse.wheel(0, -240);
  await sleep(300);
  const z1 = (await snap(page)).camera.zoomTarget;
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400);
  await sleep(500);
  const s2 = await snap(page);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
  await sleep(500);
  const s3 = await snap(page);
  const scrolled = await page.evaluate(() => window.scrollY + document.documentElement.scrollTop);
  const ok = z1 > z0 && s2.camera.zoomTarget === s2.camera.zoomMin && s3.camera.zoomTarget === s3.camera.zoomMax && scrolled === 0;
  record('wheel zoom changes zoom within limits', ok, `start ${z0.toFixed(1)} → in ${z1.toFixed(1)}; out-clamped ${s2.camera.zoomTarget.toFixed(1)} (min ${s2.camera.zoomMin}); in-clamped ${s3.camera.zoomTarget.toFixed(1)} (max ${s3.camera.zoomMax}); page scroll ${scrolled}`);
  // Zoom out for the long walk so the target is on screen.
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400);
  await sleep(900);
}

async function testViewRuntime(page, firstSnap) {
  const finite = (v) => v && ['focusX', 'focusY', 'focusZ', 'yaw', 'zoom', 'halfWidth', 'halfHeight'].every((k) => Number.isFinite(v[k])) && v.halfWidth > 0 && v.halfHeight > 0;
  const vp0 = page.viewportSize();
  const v0 = (await snap(page)).view;
  const w0 = v0.halfWidth * 2 * v0.zoom;
  await page.setViewportSize({ width: 1200, height: 700 });
  await waitFor(page, (sn) => Math.abs(sn.view.halfWidth * 2 * sn.view.zoom - 1200) < 2, 'view to track the resize', 10_000).catch(() => null);
  const v1 = (await snap(page)).view;
  const w1 = v1.halfWidth * 2 * v1.zoom;
  await page.setViewportSize(vp0);
  await waitFor(page, (sn) => Math.abs(sn.view.halfWidth * 2 * sn.view.zoom - vp0.width) < 2, 'view to track the restore', 10_000).catch(() => null);
  const ok = finite(firstSnap?.view) && finite(v0) && finite(v1) && Math.abs(w0 - vp0.width) < 2 && Math.abs(w1 - 1200) < 2;
  record(
    'runtime.view is populated from the first frame and tracks resize',
    ok,
    `first snapshot ${finite(firstSnap?.view) ? 'finite' : JSON.stringify(firstSnap?.view)}; canvas ${vp0.width}px ↔ 2·halfWidth·zoom ${w0.toFixed(1)}; after resize to 1200 → ${w1.toFixed(1)} (halfWidth ${v0.halfWidth.toFixed(1)}→${v1.halfWidth.toFixed(1)} m)`,
  );
}

async function testDoorThroughGate(page) {
  const s = await snap(page);
  const buildings = (await query(page, 'buildings')).filter((b) => b.id.startsWith('house_'));
  const vp = page.viewportSize();
  const local = (b, lx, lz) => ({ x: b.x + lx * Math.cos(b.yaw) + lz * Math.sin(b.yaw), z: b.z - lx * Math.sin(b.yaw) + lz * Math.cos(b.yaw) });
  let chosen = null;
  buildings.sort((p, q) => Math.hypot(p.x - s.local.x, p.z - s.local.z) - Math.hypot(q.x - s.local.x, q.z - s.local.z));
  for (const b of buildings) {
    const door = await query(page, 'interactable', `door_${b.id}`);
    if (!door) continue;
    const scr = await query(page, 'worldToScreen', door.position.x, door.position.z);
    if (!scr || scr.x < 30 || scr.y < 30 || scr.x > vp.width - 30 || scr.y > vp.height - 30) continue;
    const pick = await query(page, 'pick', scr.x, scr.y, 'mouse');
    if (pick?.id !== door.id) continue;
    chosen = { b, door, scr };
    break;
  }
  if (!chosen) return record('click a cottage door → walks through its garden gate', false, 'no cottage door on screen');
  const { b, door, scr } = chosen;
  await page.mouse.click(scr.x, scr.y);
  await sleep(100);
  const planned = (await snap(page)).motion?.path?.points ?? [];
  const samples = await sampleUntil(page, (sn, out) => out.length > 3 && !sn.motion?.path && sn.local.speed < 0.05, 45_000);
  const end = samples.at(-1);
  const gate = local(b, 0, b.depth / 2 + 3.0);
  // Closest approach of the walked samples and the planned polyline to the gate centre.
  let gateDist = Infinity;
  for (const pts of [samples, [samples[0], ...planned]]) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const c = pts[i];
      const dx = c.x - a.x;
      const dz = c.z - a.z;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((gate.x - a.x) * dx + (gate.z - a.z) * dz) / l2));
      gateDist = Math.min(gateDist, Math.hypot(a.x + dx * t - gate.x, a.z + dz * t - gate.z));
    }
  }
  const walk = (await countUnwalkable(page, samples)) === 0;
  const radius = (door.radius ?? 2.4) - 0.3;
  const toDoor = Math.hypot(end.x - door.position.x, end.z - door.position.z);
  const target = (await snap(page)).target;
  // Ended inside the fenced front garden (local |x| < width/2 + 0.35, depth/2 < z < depth/2 + 3).
  const dx = end.x - b.x;
  const dz = end.z - b.z;
  const lx = dx * Math.cos(b.yaw) - dz * Math.sin(b.yaw);
  const lz = dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw);
  const inGarden = Math.abs(lx) < b.width / 2 + 0.35 && lz > b.depth / 2 && lz < b.depth / 2 + 3.0;
  const ok = walk && toDoor <= radius && inGarden;
  record(
    'click a cottage door → walks into its fenced garden to the door',
    ok,
    `${door.id}: ended ${toDoor.toFixed(2)} m from the door (radius ${radius.toFixed(2)}) inside the garden=${inGarden} (local ${lx.toFixed(2)}, ${lz.toFixed(2)}); route passes ${gateDist.toFixed(2)} m from the gate centre (fence runs are also opened where paths cross); ${samples.length} samples all walkable (never through a fence)=${walk}; target now ${target.kind}:${target.id}`,
  );
}

function behindPoint(b, extra = 2.6) {
  const lz = -(b.depth / 2 + extra);
  return { x: b.x + lz * Math.sin(b.yaw), z: b.z + lz * Math.cos(b.yaw) };
}
function insideBox(p, b, margin) {
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  // True distance from the point to the footprint rectangle (0 when inside), so corners are round.
  const ox = Math.max(0, Math.abs(lx) - b.width / 2);
  const oz = Math.max(0, Math.abs(lz) - b.depth / 2);
  return Math.hypot(ox, oz) < margin;
}

async function clickWorld(page, p) {
  const scr = await query(page, 'worldToScreen', p.x, p.z);
  await page.mouse.click(scr.x, scr.y);
  return scr;
}

async function testClickBehindBuilding(page) {
  const s = await snap(page);
  const buildings = await query(page, 'buildings');
  // Nearest building whose far side is walkable and on screen.
  const cands = buildings
    .map((b) => ({ b, p: behindPoint(b), d: Math.hypot(b.x - s.local.x, b.z - s.local.z) }))
    .sort((a, b) => a.d - b.d);
  let chosen = null;
  for (const c of cands) {
    if (!(await query(page, 'isWalkable', c.p.x, c.p.z))) continue;
    const scr = await query(page, 'worldToScreen', c.p.x, c.p.z);
    const vp = page.viewportSize();
    if (!scr || scr.x < 20 || scr.y < 20 || scr.x > vp.width - 20 || scr.y > vp.height - 20) continue;
    const pick = await query(page, 'pick', scr.x, scr.y, 'mouse');
    if (pick) continue;
    // The straight line must actually be blocked by the building (otherwise it's not "behind").
    const straight = await segmentWalkable(page, s.local, c.p);
    if (straight.ok) continue;
    chosen = c;
    break;
  }
  if (!chosen) return record('click-to-move reaches a point behind a building', false, 'no suitable building on screen');
  const { b, p } = chosen;
  await clickWorld(page, p);
  await sleep(100);
  const planned = (await snap(page)).motion?.path?.points ?? [];
  const samples = await sampleUntil(page, (sn, out) => out.length > 5 && !sn.motion?.path && sn.local.speed < 0.05, 45_000);
  const last = samples.at(-1);
  // Every sampled position is walkable; the planned path segments are walkable; and where samples are
  // dense enough (<0.8 m apart) the chord between them is too (sparse chords may legitimately cut corners).
  let walkable = (await countUnwalkable(page, samples)) === 0;
  let bad = null;
  let insideCount = 0;
  let prev = samples[0];
  for (const q of planned) {
    const r = await segmentWalkable(page, prev, q);
    if (!r.ok) {
      walkable = false;
      bad = r;
    }
    prev = q;
  }
  for (let i = 0; i < samples.length; i++) {
    if (insideBox(samples[i], b, 0.3)) insideCount++;
    if (i > 0 && Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z) < 0.8) {
      const r = await segmentWalkable(page, samples[i - 1], samples[i]);
      if (!r.ok) {
        walkable = false;
        bad = r;
      }
    }
  }
  let travelled = 0;
  for (let i = 1; i < samples.length; i++) travelled += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
  const straight = Math.hypot(p.x - samples[0].x, p.z - samples[0].z);
  const reached = Math.hypot(last.x - p.x, last.z - p.z);
  const ok = reached < 0.6 && walkable && insideCount === 0 && travelled > straight + 0.5;
  record(
    'click-to-move walks around a building to a point behind it',
    ok,
    `building ${b.id}; target (${p.x.toFixed(1)}, ${p.z.toFixed(1)}); reached within ${reached.toFixed(2)} m in ${(last.t / 1000).toFixed(1)} s; planned path ${planned.length} waypoints; ${samples.length} samples all walkable=${walkable}${bad ? ` (bad at ${bad.x.toFixed(2)},${bad.z.toFixed(2)})` : ''}; inside building=${insideCount}; travelled ${travelled.toFixed(1)} m vs straight ${straight.toFixed(1)} m`,
  );
  return { b, p };
}

async function testCannotPassBuilding(page, b) {
  // We're behind building b: run straight at it for 2.5 s.
  const s = await snap(page);
  const yaw = s.camera.yaw;
  const toward = { x: b.x - s.local.x, z: b.z - s.local.z };
  let best = 'KeyW';
  let bestA = 999;
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
    const a = angleBetween(keyDir(k, yaw), toward);
    if (a < bestA) {
      bestA = a;
      best = k;
    }
  }
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down(best);
  const samples = await sampleUntil(page, (_, out) => out.at(-1).t > 2500, 4000);
  await page.keyboard.up(best);
  await page.keyboard.up('ShiftLeft');
  const inside = samples.filter((q) => insideBox(q, b, 0.3)).length;
  const walk = (await countUnwalkable(page, samples)) === 0;
  record('cannot walk through a building', inside === 0 && walk, `pushed ${best} toward ${b.id} for 2.5 s: ${samples.length} samples, inside=${inside}, all walkable=${walk}`);
}

async function testCannotEnterSea(page) {
  // Find the nearest shore direction from here (march 8 directions in the page).
  const s = await snap(page);
  const yaw = s.camera.yaw;
  const dirs = [];
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) dirs.push({ keys: [k], d: keyDir(k, yaw) });
  const combos = [['KeyW', 'KeyD'], ['KeyD', 'KeyS'], ['KeyS', 'KeyA'], ['KeyA', 'KeyW']];
  for (const c of combos) {
    const a = keyDir(c[0], yaw);
    const b = keyDir(c[1], yaw);
    const l = Math.hypot(a.x + b.x, a.z + b.z);
    dirs.push({ keys: c, d: { x: (a.x + b.x) / l, z: (a.z + b.z) / l } });
  }
  let best = null;
  for (const o of dirs) {
    const dist = await distToWater(page, s.local, o.d, 90, 1);
    if (!best || dist < best.dist) best = { ...o, dist };
  }
  await page.keyboard.down('ShiftLeft');
  for (const k of best.keys) await page.keyboard.down(k);
  const samples = await sampleUntil(
    page,
    (_, out) => {
      if (out.length < 15) return false;
      const a = out.at(-13);
      const z = out.at(-1);
      return Math.hypot(z.x - a.x, z.z - a.z) < 0.15; // stopped (shore or stuck)
    },
    Math.min(25_000, (best.dist / 5) * 1000 + 6000),
  );
  for (const k of best.keys) await page.keyboard.up(k);
  await page.keyboard.up('ShiftLeft');
  const walk = (await countUnwalkable(page, samples)) === 0;
  const end = samples.at(-1);
  // Distance from the end point to the water along the run direction.
  const toWater = await distToWater(page, end, best.d, 6, 0.25);
  const ran = Math.hypot(end.x - samples[0].x, end.z - samples[0].z);
  record('cannot walk into the sea', walk && ran > 3, `ran ${best.keys.join('+')} toward water ${best.dist} m away; covered ${ran.toFixed(1)} m in ${(end.t / 1000).toFixed(1)} s; ${samples.length} samples all walkable=${walk}; end is ${toWater === Infinity ? '>6' : toWater.toFixed(2)} m from water${toWater > 2 ? ' (stopped by an obstacle before the shore)' : ''}`);

  // Click out at sea → walks to the nearest reachable beach point, never into water.
  if (best.dist === Infinity) return;
  // A point 6 m out to sea along the same line (from the original start, where we measured the shore).
  const sea = { x: s.local.x + best.d.x * (best.dist + 6), z: s.local.z + best.d.z * (best.dist + 6) };
  const scr = await query(page, 'worldToScreen', sea.x, sea.z, 0);
  const vp = page.viewportSize();
  if (scr && scr.x > 10 && scr.y > 10 && scr.x < vp.width - 10 && scr.y < vp.height - 10) {
    await page.mouse.click(scr.x, scr.y);
    await sleep(150);
    const after = await snap(page);
    const goal = after.motion?.path?.goal;
    const exact = after.motion?.path?.exact;
    const samples2 = await sampleUntil(page, (sn, out) => out.length > 3 && !sn.motion?.path && sn.local.speed < 0.05, 15_000);
    const walk2 = (await countUnwalkable(page, samples2)) === 0;
    record('clicking the sea walks to the nearest reachable shore point', walk2 && exact === false, `goal ${goal ? `(${goal.x.toFixed(1)}, ${goal.z.toFixed(1)})` : 'none'} exact=${exact}; samples all walkable=${walk2}`);
  }
}

/** Monotonic progress + no jumps for a series of {t, x, z} samples of a remote walking in a straight line. */
function analyseSeries(series) {
  const first = series[0];
  const lastF = series.at(-1);
  const dir = { x: lastF.x - first.x, z: lastF.z - first.z };
  const len = Math.hypot(dir.x, dir.z) || 1;
  let backwards = 0;
  let maxStep = 0;
  let maxSpeed = 0;
  for (let i = 1; i < series.length; i++) {
    const dx = series[i].x - series[i - 1].x;
    const dz = series[i].z - series[i - 1].z;
    if ((dx * dir.x + dz * dir.z) / len < -0.01) backwards++;
    const st = Math.hypot(dx, dz);
    maxStep = Math.max(maxStep, st);
  }
  // Peak speed over sliding windows of ≥ 50 ms (shorter windows are dominated by timer jitter; a
  // one-frame jump still shows up because it dominates the window that contains it).
  for (let i = 1, j = 0; i < series.length; i++) {
    while (j + 1 < i && series[i].t - series[j + 1].t >= 50) j++;
    const dtS = (series[i].t - series[j].t) / 1000;
    if (dtS >= 0.05) maxSpeed = Math.max(maxSpeed, Math.hypot(series[i].x - series[j].x, series[i].z - series[j].z) / dtS);
  }
  const rate = series.length / ((lastF.t - first.t) / 1000);
  return { len, backwards, maxStep, maxSpeed, rate, n: series.length };
}

async function testRemoteSmoothness(pageA, pageB) {
  await ready(pageA);
  await ready(pageB);
  const a = await snap(pageA);
  // Pick a free walking direction for A.
  const key = await freeKey(pageA, a.camera.yaw, 9);
  const id = a.sessionId;
  // B is the observer: give it the foreground so its rAF isn't throttled (keys still reach A via CDP).
  await pageB.bringToFront();
  await pageA.keyboard.down(key);
  // (c) In parallel: B's received snapshot buffer (real network arrival times), merged across polls.
  const received = new Map();
  let polling = true;
  let anim = 'walk';
  const poller = (async () => {
    while (polling) {
      const rb = await query(pageB, 'remoteBuffer', id).catch(() => null);
      if (rb) {
        anim = rb.anim === 'run' ? 'run' : 'walk';
        for (const p of rb.buffer) received.set(p.t, p);
      }
      await sleep(250);
    }
  })();
  // Collect (a) the pose actually rendered each frame and (b) the interpolated pose on a fixed 60 Hz timer.
  const { frames, timer } = await pageB.evaluate(
    (id) =>
      new Promise((resolve) => {
        const frames = [];
        const timer = [];
        const t0 = performance.now();
        const tick = () => {
          const r = window.__ELSEWHERE__.snapshot().remotes.find((q) => q.id === id);
          if (r) frames.push({ t: performance.now() - t0, x: r.x, z: r.z });
          if (performance.now() - t0 < 3200) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const iv = setInterval(() => {
          const p = window.__ELSEWHERE__.query('sampleRemote', id);
          if (p) timer.push({ t: performance.now() - t0, x: p.x, z: p.z });
          if (performance.now() - t0 >= 3200) {
            clearInterval(iv);
            resolve({ frames, timer });
          }
        }, 16);
      }),
    id,
  );
  // A sends moves from its own frame loop: when software rendering starves A's page too, B may have
  // received only a handful of distinct poses in 3.2 s. Keep walking (and collecting what B receives)
  // until there is enough to judge — at least 12 snapshots — or 9 s in all. The checks below are unchanged.
  const tWalk = Date.now();
  while (received.size < 12 && Date.now() - tWalk < 5_800) await sleep(200);
  polling = false;
  await poller;
  await pageA.keyboard.up(key);
  // Steady part only (skip acceleration and the final stop).
  const steadyFrames = frames.filter((f) => f.t > 600 && f.t < 3000);
  const steadyTimer = timer.filter((f) => f.t > 600 && f.t < 3000);
  let mode = 'rendered frames';
  let series = steadyFrames;
  if (series.length < 30) {
    mode = 'fixed 60 Hz timer';
    series = steadyTimer;
  }
  if (series.length < 30) {
    // Main thread too starved by software rendering for in-page timers: replay what B actually received
    // through the real interpolation (sampleBuffer) at a virtual 60 Hz.
    const snaps = [...received.values()].sort((p, q) => p.t - q.t);
    if (snaps.length >= 10) {
      const delay = 120;
      const from = snaps[0].t + delay + 600;
      const to = snaps.at(-1).t + delay - 150;
      series = (await query(pageB, 'sampleSnapshots', snaps, anim, from, to, 1000 / 60)).map((p) => ({ ...p, t: p.t - from }));
      mode = `received stream (${snaps.length} snapshots) replayed through the real interpolation at a virtual 60 Hz (rendering gave ${steadyFrames.length} frames, timer ${steadyTimer.length} ticks)`;
    }
  }
  if (series.length < 20) {
    record('second client sees smooth movement', false, `too few samples (frames ${steadyFrames.length}, timer ${steadyTimer.length}, received ${received.size})`);
    return;
  }
  const useFrames = mode === 'rendered frames';
  const r = analyseSeries(series);
  const walk = 3.2;
  // No backwards steps; no sample-to-sample speed above 1.6× walk speed (a teleport/catch-up jump would be far more).
  const ok = r.backwards === 0 && r.maxSpeed < walk * 1.6 && r.len > 2;
  const fr = steadyFrames.length ? analyseSeries(steadyFrames) : null;
  record(
    'second client sees smooth movement',
    ok,
    `${mode}: ${r.n} samples at ${r.rate.toFixed(0)}/s over ${r.len.toFixed(2)} m, backwards=${r.backwards}, max step ${r.maxStep.toFixed(3)} m, peak ${r.maxSpeed.toFixed(2)} m/s (walk ${walk})` +
      (fr && !useFrames ? `; rendered frames: ${fr.n} at ${fr.rate.toFixed(0)} fps, backwards=${fr.backwards}` : ''),
  );
}

async function testReconnect(pageA, pageB) {
  const a0 = await snap(pageA);
  const before = { x: a0.local.x, z: a0.local.z };
  outage = true;
  const tKill = Date.now();
  kill(server);
  await waitFor(pageA, (s) => s.connection === 'reconnecting', 'A reconnecting', 10_000);
  await waitFor(pageB, (s) => s.connection === 'reconnecting', 'B reconnecting', 10_000);
  log('server killed; both clients show "reconnecting"');
  await sleep(2500);
  await startServer();
  const tUp = Date.now();
  const a1 = await waitFor(pageA, (s) => s.connection === 'connected' && s.players.length === 2, 'A sees 2 after restart', 40_000);
  const b1 = await waitFor(pageB, (s) => s.connection === 'connected' && s.players.length === 2, 'B sees 2 after restart', 40_000);
  const tBack = Date.now();
  outage = false;
  const ids = new Set([...a1.players.map((p) => p.id), ...b1.players.map((p) => p.id)]);
  const sameSet = ids.size === 2 && ids.has(a1.sessionId) && ids.has(b1.sessionId);
  // Both see each other's remote rendered too.
  await sleep(800);
  const a2 = await snap(pageA);
  const b2 = await snap(pageB);
  const renders = a2.remotes.some((r) => r.id === b2.sessionId && r.visible) && b2.remotes.some((r) => r.id === a2.sessionId && r.visible);
  const resumed = Math.hypot(a2.local.x - before.x, a2.local.z - before.z);
  record(
    'server restart → automatic reconnection, both clients see each other again',
    sameSet && renders,
    `outage ${((tUp - tKill) / 1000).toFixed(1)} s; back ${((tBack - tUp) / 1000).toFixed(1)} s after the server came up; rejoins A=${a2.net.rejoins} B=${b2.net.rejoins}; remotes rendered=${renders}; A position delta after rejoin ${resumed.toFixed(2)} m (${resumed < 1 ? 'resume hint honoured' : 'server ignored the resume hint → respawn'})`,
  );
}

async function testMobile(browser) {
  const ctx = await browser.newContext({ ...devices['Pixel 5'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, 'M');
  await page.goto(PAGE_URL);
  await ready(page);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1, radiusX: 4, radiusY: 4, force: 1 })) });

  // Tap-to-move: a walkable point ~4 m away.
  const s0 = await snap(page);
  let target = null;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    const p = { x: s0.local.x + Math.cos(a) * 4, z: s0.local.z + Math.sin(a) * 4 };
    if (!(await query(page, 'isWalkable', p.x, p.z))) continue;
    if (!(await segmentWalkable(page, s0.local, p)).ok) continue;
    const scr = await query(page, 'worldToScreen', p.x, p.z);
    if (await query(page, 'pick', scr.x, scr.y, 'touch')) continue;
    // The tap must land on the canvas, not on a HUD element / hint card over it.
    if (!(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [scr.x, scr.y]))) continue;
    target = { p, scr };
    break;
  }
  if (!target) {
    record('touch: tap-to-move', false, 'no free spot found');
  } else {
    await page.touchscreen.tap(target.scr.x, target.scr.y);
    const samples = await sampleUntil(page, (sn, out) => out.length > 4 && !sn.motion?.path && sn.local.speed < 0.05, 10_000);
    const end = samples.at(-1);
    const err = Math.hypot(end.x - target.p.x, end.z - target.p.z);
    record('touch: tap-to-move', err < 0.6, `tapped (${target.scr.x.toFixed(0)}, ${target.scr.y.toFixed(0)}) → reached within ${err.toFixed(2)} m`);
  }

  // Joystick: push "up" for 1.2 s.
  const joy = page.getByTestId('joystick');
  const visible = await joy.isVisible().catch(() => false);
  if (!visible) {
    record('touch: virtual joystick moves the player', false, 'joystick not visible on a touch device');
  } else {
    const box = await joy.boundingBox();
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = await snap(page);
    await touch('touchStart', [c]);
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [{ x: c.x, y: c.y - i * 9 }]);
      await sleep(16);
    }
    await sleep(1200);
    const mid = await snap(page);
    await touch('touchEnd', []);
    const tRel = Date.now();
    const atRelease = await snap(page);
    // Released: the player must decelerate to a stop (allow for slow frames under load).
    const after = await waitFor(page, (sn) => sn.local.speed < 0.1, 'player to stop after joystick release', 8000).catch(() => null);
    const stopMs = Date.now() - tRel;
    const moved = { x: mid.local.x - before.local.x, z: mid.local.z - before.local.z };
    const expect = keyDir('KeyW', before.camera.yaw);
    const ang = angleBetween(moved, expect);
    const d = Math.hypot(moved.x, moved.z);
    // Drift is measured from the first snapshot after the release was delivered (CDP round trips are slow under load).
    const drift = after ? Math.hypot(after.local.x - atRelease.local.x, after.local.z - atRelease.local.z) : Infinity;
    const stopped = drift < 1.5;
    // A clear path upward is not guaranteed; sliding along an obstacle can bend the direction.
    record('touch: virtual joystick moves the player', d > 1 && (ang < 35 || d > 1) && stopped, `moved ${d.toFixed(2)} m, direction error vs screen-up ${ang.toFixed(0)}°, stops on release=${stopped} (observed stopped ${stopMs} ms after release; drift after release ${drift.toFixed(2)} m)`);
  }

  // Pinch on the canvas: camera zoom changes, page does not zoom/scroll.
  const z0 = (await snap(page)).camera.zoomTarget;
  const vp = page.viewportSize();
  const cy = vp.height * 0.4;
  const cx = vp.width / 2;
  await touch('touchStart', [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ x: cx - 40 - i * 12, y: cy }, { x: cx + 40 + i * 12, y: cy }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  // A one-finger swipe as well (would scroll a normal page).
  await touch('touchStart', [{ x: cx, y: cy + 100 }]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ x: cx, y: cy + 100 - i * 25 }]);
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(400);
  const z1 = (await snap(page)).camera.zoomTarget;
  const pageState = await page.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, scrollX: window.scrollX, scrollY: window.scrollY, docScroll: document.scrollingElement?.scrollTop ?? 0 }));
  const free = (await snap(page)).camera.free;
  record(
    'touch: pinch zooms the camera, not the page; no page scroll',
    z1 > z0 && pageState.scale === 1 && pageState.scrollX === 0 && pageState.scrollY === 0 && pageState.docScroll === 0,
    `zoom ${z0.toFixed(1)} → ${z1.toFixed(1)}; visualViewport.scale=${pageState.scale}; scroll=(${pageState.scrollX},${pageState.scrollY}); swipe panned free camera=${free}`,
  );
  await page.close({ runBeforeUnload: true });
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let browser = null;
let vite = null;
try {
  if (!EXTERNAL) await startServer();
  if (!EXTERNAL && !CLIENT_DIST) {
    const viteArgs = ['vite', '--port', String(VITE_PORT), '--strictPort'];
    // Optional: a custom Vite config (e.g. a private cacheDir when other dev servers share client/node_modules/.vite).
    if (process.env.E2E_VITE_CONFIG) viteArgs.push('--config', process.env.E2E_VITE_CONFIG);
    vite = start('vite', 'npx', viteArgs, { cwd: path.join(ROOT, 'client'), env: { ...process.env, VITE_SERVER_PORT: String(SERVER_PORT) } });
    await waitHttp(URL);
  }
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctxA = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const ctxB = await browser.newContext({ viewport: { width: 960, height: 640 } });
  // Low graphics quality (software rendering): more frames for the smoothness check.
  for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(LOW_GRAPHICS);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  watch(pageA, 'A');
  watch(pageB, 'B');
  log('opening', PAGE_URL);
  await pageA.goto(PAGE_URL);
  // First snapshot as soon as the debug hook exists (runtime.view must already be valid).
  let firstSnapA = null;
  for (let i = 0; i < 400 && !firstSnapA; i++) {
    firstSnapA = await snap(pageA).catch(() => null);
    if (!firstSnapA) await sleep(50);
  }
  await ready(pageA);
  await pageA.bringToFront();

  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      record(name, false, err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  await step('camera-relative keys', () => testCameraRelative(pageA));
  await step('wheel zoom', () => testZoom(pageA));
  await step('view runtime', () => testViewRuntime(pageA, firstSnapA));
  await step('door through gate', () => testDoorThroughGate(pageA));
  const behind = await step('click behind building', () => testClickBehindBuilding(pageA));
  if (behind) await step('building is solid', () => testCannotPassBuilding(pageA, behind.b));
  await step('sea', () => testCannotEnterSea(pageA));

  await pageB.goto(PAGE_URL);
  await ready(pageB);
  await waitFor(pageA, (s) => s.players.length === 2, 'A sees B');
  await waitFor(pageB, (s) => s.players.length === 2, 'B sees A');
  await step('remote smoothness', () => testRemoteSmoothness(pageA, pageB));
  if (!EXTERNAL) await step('reconnection', () => testReconnect(pageA, pageB));
  else log('SKIP reconnection (E2E_URL set: server not owned by this script)');
  // Free the CPU for the mobile run (software rendering): close the desktop pages first.
  for (const p of [pageA, pageB]) await p.close({ runBeforeUnload: true }).catch(() => undefined);
  await step('mobile', () => testMobile(browser));

  record('no console errors', consoleErrors.length === 0, consoleErrors.length ? consoleErrors.slice(0, 6).join(' | ') : '0 errors across all pages');
} catch (err) {
  record('e2e run', false, err instanceof Error ? err.stack : String(err));
} finally {
  if (browser) {
    for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
    await sleep(300);
    await browser.close();
  }
  for (const c of children) kill(c);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}
