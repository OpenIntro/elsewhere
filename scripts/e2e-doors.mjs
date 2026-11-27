#!/usr/bin/env node
/**
 * Door-walk audit (diagnostic): does phone tap-to-move get a player from every spawn
 * point to every walk-in door without stalling?
 *
 *   npm run build && npm run e2e:doors
 *   node scripts/e2e-doors.mjs [--doors town_hall,cafe] [--spawns 1,8] [--strict] [--route-timeout 300]
 *
 * Spawns its own production server (scripts/lib/server.mjs; port $DOORS_PORT or 2643,
 * fresh temp DATA_DIR unless $DOORS_DATA_DIR). One emulated Pixel 7 (touch only, graphics
 * "low") joins per spawn point (the server hands out spawn points in join order; each new
 * page joins while the previous one is still connected so the order holds), then for every
 * walk-in door (Café, General Store, Town Hall, Workshop, House 1, House 2, Boathouse)
 * walks spawn → door (the walkable point just outside the doorstep, `door.outside`) and back
 * to the spawn point, by hops of on-screen taps on the ground — what a player on a phone does:
 * straight towards the goal, beside people and things, to one side when the way is blocked (the
 * fountain), and along a planned route when nothing ahead is tappable (inside a building).
 * Each tap's kind is logged (ground / detour / along planned route / blocked / door).
 *
 * Logged per route: taps, walked path length, straight-line distance, time, server
 * corrections (correction messages received), stalls (a tap-to-move path active but
 * < 0.2 m of progress for 5 s; see detectStalls in lib/report.mjs) and early stops (the
 * path ended > 1 m short of the tapped spot). At a stall: the full debug snapshot, a
 * screenshot, the client's remaining path, and the nav grid around the player (rebuilt
 * here from the same shared collision with client/src/player/pathfinding.ts) with a fresh
 * path from the stall point. Table to stdout; everything to e2e-results/doors.json,
 * screenshots to e2e-results/doors/.
 *
 * Exit 0 unless --strict (then 1 if any stall, unreached door or console error).
 * Nothing here simulates players: every move is a real tap in a real page.
 *
 * Env: DOORS_PORT, DOORS_DATA_DIR, DOORS_VERBOSE=1 (server output), DOORS_OUT (output dir,
 * default e2e-results).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INTERIORS, SPAWN_POINTS, getBuilding, zoneContains } from '@elsewhere/shared';
import { onCanvas, query, sleep, snap, waitSnap } from './lib/browser.mjs';
import { detectStalls, polylineLength } from './lib/report.mjs';
import { createServer } from './lib/server.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DOORS_PORT ?? 2643);
const DATA_DIR = process.env.DOORS_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-doors-'));
const OUT = path.resolve(ROOT, process.env.DOORS_OUT ?? 'e2e-results');
const SHOTS = path.join(OUT, 'doors');
const PHONE = 'Pixel 7';
const STALL = { minProgress: 0.2, window: 5000 };
const log = (...a) => console.log('[doors]', ...a);

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1];
};
const STRICT = argv.includes('--strict');
const ROUTE_TIMEOUT = Number(arg('--route-timeout') ?? 300) * 1000;
const NO_RETURN = argv.includes('--no-return');
/** Screen margin (fraction) a hop tap stays inside: smaller = longer hops (and longer paths). */
const HOP_MARGIN = Number(arg('--hop-margin') ?? 0.18);
/** Tap the door itself (walk to it and use it) as soon as it is on screen, instead of the ground. */
const TAP_DOOR = argv.includes('--tap-door');

const DOOR_ORDER = ['cafe', 'general_store', 'town_hall', 'workshop', 'house_1', 'house_2', 'boathouse'];
const doorsWanted = arg('--doors')?.split(',').map((s) => s.trim()) ?? DOOR_ORDER;
const DOORS = doorsWanted.map((id) => {
  const it = INTERIORS.find((i) => i.id === id);
  if (!it) throw new Error(`unknown door ${id}; known: ${DOOR_ORDER.join(', ')}`);
  const b = getBuilding(id);
  return { id, name: b.name, target: it.doors[0].outside, apron: it.doors[0].apron, door: { x: it.doors[0].position.x, z: it.doors[0].position.z } };
});
const spawnsWanted = (arg('--spawns')?.split(',').map((s) => Number(s.trim())) ?? SPAWN_POINTS.map((_, i) => i + 1)).sort((a, b) => a - b);
for (const n of spawnsWanted) if (!(n >= 1 && n <= SPAWN_POINTS.length)) throw new Error(`--spawns takes 1-${SPAWN_POINTS.length}`);

// --- nav grid (the client's pathfinding module, same shared collision) ------------
let nav = null;
async function navGrid() {
  if (nav !== null) return nav || null;
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'client/src/player/pathfinding.ts')).href);
    const g = new mod.NavGrid();
    while (!g.ready) g.buildStep(64);
    nav = { g, findPath: mod.findPath };
  } catch (err) {
    log(`nav grid not available in node (${err.message}); stall reports will lack the grid dump`);
    nav = false;
  }
  return nav || null;
}
async function navAround(p, goal) {
  const n = await navGrid();
  if (!n) return null;
  const { g } = n;
  const cell = (x, z) => {
    const c = Math.floor((x - g.minX) / g.cell);
    const r = Math.floor((z - g.minZ) / g.cell);
    return c < 0 || r < 0 || c >= g.cols || r >= g.rows ? -1 : r * g.cols + c;
  };
  const here = cell(p.x, p.z);
  const rows = [];
  for (let dz = -8; dz <= 8; dz++) {
    let row = '';
    for (let dx = -12; dx <= 12; dx++) {
      const i = cell(p.x + dx * g.cell, p.z + dz * g.cell);
      row += dx === 0 && dz === 0 ? '@' : i < 0 || !g.walk[i] ? '#' : g.comp[i] === g.comp[here] ? '.' : 'o';
    }
    rows.push(row);
  }
  let fresh = null;
  try {
    fresh = n.findPath(g, p, goal);
  } catch (err) {
    fresh = { error: String(err) };
  }
  return { cell: g.cell, legend: "@ player, . walkable (player's component), o walkable (other component), # blocked; x → right, z → down", rows, walkableHere: !!g.walk[here], freshPath: fresh };
}

// --- page helpers --------------------------------------------------------------
const consoleErrors = [];
function watch(page, label, counters) {
  page.on('pageerror', (e) => consoleErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${label} console.error: ${m.text()}`);
  });
  // Server corrections: count the room's correction messages on the wire (read-only).
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const p = f.payload;
      counters.frames++;
      if (typeof p !== 'string' && p?.includes?.('correction')) counters.corrections++;
    });
  });
}
const LOW_GFX = `try { if (!localStorage.getItem('elsewhere.settings.v1')) localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;

async function join(browser, label) {
  const ctx = await browser.newContext({ ...devices[PHONE] });
  await ctx.addInitScript(LOW_GFX);
  const page = await ctx.newPage();
  const counters = { corrections: 0, frames: 0 };
  watch(page, label, counters);
  await page.goto(`${server.url}/?autojoin=1`);
  const s = await waitSnap(page, (q) => q.connection === 'connected' && q.local?.ready && q.navReady === true, `${label} joined + nav grid ready`, 180_000);
  return { ctx, page, counters, at: { x: s.local.x, z: s.local.z } };
}
const nearestSpawn = (p) => SPAWN_POINTS.map((sp, i) => ({ n: i + 1, d: Math.hypot(sp.position.x - p.x, sp.position.z - p.z) })).sort((a, b) => a.d - b.d)[0];

/**
 * Pick the screen point for the next hop towards `target`: the target itself if it is
 * well inside the screen, else the farthest point on the screen line towards it; nudged
 * off people / things / UI onto walkable ground, as a player would tap beside them.
 */
async function hopPoint(page, s, target, door = null, skip = 0) {
  const vp = page.viewportSize();
  const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
  const tp = await query(page, 'worldToScreen', target.x, target.z);
  let x = tp.x;
  let y = tp.y;
  if (door) {
    const dp = await query(page, 'worldToScreen', door.x, door.z, door.y);
    const mm = 0.04;
    if (dp && dp.x > vp.width * mm && dp.x < vp.width * (1 - mm) && dp.y > vp.height * mm && dp.y < vp.height * (1 - mm) && (await onCanvas(page, dp.x, dp.y))) {
      return { x: dp.x, y: dp.y, ground: null, kind: 'door', pick: await query(page, 'pick', dp.x, dp.y, 'touch') };
    }
  }
  const m = HOP_MARGIN;
  const inside = (px, py) => px > vp.width * m && px < vp.width * (1 - m) && py > vp.height * m && py < vp.height * (1 - m);
  if (!inside(x, y)) {
    let k = 1;
    for (; k > 0.05; k -= 0.05) if (inside(me.x + (tp.x - me.x) * k, me.y + (tp.y - me.y) * k)) break;
    x = me.x + (tp.x - me.x) * k;
    y = me.y + (tp.y - me.y) * k;
  }
  if (!(await onCanvas(page, x, y))) y -= 40;
  const usable = async (px, py) => {
    const g = await query(page, 'groundFromScreen', px, py);
    return g && (await query(page, 'isWalkable', g.x, g.z)) && !(await query(page, 'pick', px, py, 'touch')) && (await onCanvas(page, px, py)) ? g : null;
  };
  for (const [dx, dy] of skip ? [] : [[0, 0], [0, 24], [24, 0], [-24, 0], [0, -24], [0, 40], [40, 0], [-40, 0], [0, -40]]) {
    const g = await usable(x + dx, y + dy);
    if (g) return { x: x + dx, y: y + dy, ground: g };
  }
  // Straight on is blocked (a fountain basin, a wall, a building in the way): tap to one side
  // of it instead, turning the hop a little further each time, as a player steers round.
  const turns = [30, -30, 55, -55, 80, -80, 110, -110];
  for (const deg of [...turns.slice((Math.max(1, skip) - 1) % turns.length), ...turns]) {
    const a = (deg * Math.PI) / 180;
    const vx = x - me.x;
    const vy = y - me.y;
    const rx = me.x + vx * Math.cos(a) - vy * Math.sin(a);
    const ry = me.y + vx * Math.sin(a) + vy * Math.cos(a);
    if (rx < 8 || ry < 8 || rx > vp.width - 8 || ry > vp.height - 8) continue;
    const g = await usable(rx, ry);
    if (g) return { x: rx, y: ry, ground: g, kind: `detour ${deg}°` };
  }
  // Nothing on the way is tappable (e.g. walked into a building and the way out is through its
  // door): tap a spot along a planned route instead (the client's own pathfinding, rebuilt here),
  // the farthest one that is on screen and usable, as a player would tap towards the door.
  const n = await navGrid();
  if (n) {
    const plan = n.findPath(n.g, s.local, target);
    const pts = [];
    let prev = { x: s.local.x, z: s.local.z };
    for (const q of plan.points ?? []) {
      const d = Math.hypot(q.x - prev.x, q.z - prev.z);
      for (let k = 1; k <= Math.ceil(d); k++) pts.push({ x: prev.x + ((q.x - prev.x) * Math.min(k, d)) / d, z: prev.z + ((q.z - prev.z) * Math.min(k, d)) / d });
      prev = q;
    }
    for (const q of pts.reverse()) {
      if (Math.hypot(q.x - s.local.x, q.z - s.local.z) < 0.8) continue;
      const sp = await query(page, 'worldToScreen', q.x, q.z);
      if (!sp || sp.x < 8 || sp.y < 8 || sp.x > vp.width - 8 || sp.y > vp.height - 8) continue;
      const g = await usable(sp.x, sp.y);
      if (g) return { x: sp.x, y: sp.y, ground: g, kind: 'along planned route' };
    }
  }
  return { x, y, ground: await query(page, 'groundFromScreen', x, y), kind: 'blocked' };
}

/** Walk to `target` by taps; returns the route record. */
async function walk(page, counters, { label, from, target, reached, door = null }) {
  const t0 = Date.now();
  const corr0 = counters.corrections;
  const frames0 = counters.frames;
  const samples = [];
  const taps = [];
  const stalls = [];
  const earlyStops = [];
  let retaps = 0;
  /** Taps in a row that started no path from the same spot (then steer round instead). */
  let noPath = 0;
  const sample = async () => {
    const s = await snap(page);
    if (s?.local) samples.push({ t: Date.now() - t0, x: +s.local.x.toFixed(3), z: +s.local.z.toFixed(3), path: !!s.motion?.path, speed: +(s.local.speed ?? 0).toFixed(2), anim: s.local.anim });
    return s;
  };
  let s = await sample();
  const start = { x: s.local.x, z: s.local.z };
  let ok = reached(s.local);
  let why = '';
  while (!ok) {
    if (Date.now() - t0 > ROUTE_TIMEOUT) {
      why = `route timeout (${ROUTE_TIMEOUT / 1000}s)`;
      break;
    }
    if (taps.length >= 60) {
      why = '60 taps without arriving';
      break;
    }
    // A tap that hit a person or a thing opened its card / panel: close it, as a player would.
    if (s.ui?.panel && (await page.locator('[data-testid=sheet-close]').isVisible().catch(() => false))) {
      await page.locator('[data-testid=sheet-close]').tap();
      await sleep(500);
    }
    const hp = await hopPoint(page, s, target, door, noPath);
    await page.touchscreen.tap(hp.x, hp.y);
    const tap = { i: taps.length, t: Date.now() - t0, screen: [Math.round(hp.x), Math.round(hp.y)], kind: hp.kind ?? 'ground', pick: hp.pick, ground: hp.ground && { x: +hp.ground.x.toFixed(2), z: +hp.ground.z.toFixed(2) }, from: { x: +s.local.x.toFixed(2), z: +s.local.z.toFixed(2) } };
    taps.push(tap);
    // Follow the hop: until the path ends, the route arrives, or a stall does not clear.
    const hop0 = samples.length;
    let goal = null;
    let sawPath = false;
    let stallSince = null;
    const hopT0 = Date.now();
    for (;;) {
      await sleep(200);
      s = await sample();
      if (!s?.local) continue;
      if (s.motion?.path) {
        sawPath = true;
        goal = { goal: s.motion.path.goal, exact: s.motion.path.exact };
      }
      if (reached(s.local)) {
        ok = true;
        break;
      }
      const live = detectStalls(samples.slice(hop0), STALL);
      const open = live.find((x) => x.i1 === samples.length - 1);
      if (open && !stallSince) {
        stallSince = Date.now();
        const full = await snap(page);
        const shot = path.join(SHOTS, `${label}-stall${stalls.length + 1}.png`);
        await page.screenshot({ path: shot }).catch(() => undefined);
        const rec = {
          at: { x: +full.local.x.toFixed(3), z: +full.local.z.toFixed(3) },
          t: Date.now() - t0,
          tap: tap.i,
          screenshot: path.relative(ROOT, shot),
          snapshot: { local: full.local, motion: full.motion, camera: full.camera, view: full.view, players: full.players, connection: full.connection, net: full.net, frame: full.frame, interior: full.interior, target: full.target, ui: full.ui },
          nav: await navAround(full.local, target),
        };
        stalls.push(rec);
        log(`${label}: STALL at (${rec.at.x.toFixed(2)}, ${rec.at.z.toFixed(2)}) path ${JSON.stringify(full.motion?.path ?? null).slice(0, 300)}; screenshot ${rec.screenshot}`);
      }
      if (stallSince && !open) {
        stalls[stalls.length - 1].recoveredAfterMs = Date.now() - stallSince;
        stallSince = null;
      }
      if (stallSince && Date.now() - stallSince > 20_000) {
        stalls[stalls.length - 1].recoveredAfterMs = null;
        retaps++;
        break; // still stuck: tap again
      }
      if (sawPath && !s.motion?.path && s.local.speed < 0.05) break;
      if (!sawPath && Date.now() - hopT0 > 4000 && s.local.speed < 0.05) break; // tap made no path (e.g. hit UI)
      if (Date.now() - hopT0 > 60_000) break;
    }
    tap.path = goal;
    noPath = !sawPath && Math.hypot(s.local.x - tap.from.x, s.local.z - tap.from.z) < 0.2 ? noPath + 1 : 0;
    tap.ms = Date.now() - hopT0 - 0;
    if (!ok && goal?.goal) {
      const short = Math.hypot(s.local.x - goal.goal.x, s.local.z - goal.goal.z);
      if (short > 1) earlyStops.push({ tap: tap.i, at: { x: +s.local.x.toFixed(2), z: +s.local.z.toFixed(2) }, goal: goal.goal, exact: goal.exact, short: +short.toFixed(2) });
    }
  }
  const end = s.local;
  const pts = samples.map((p) => ({ x: p.x, z: p.z }));
  return {
    label,
    from,
    start: { x: +start.x.toFixed(2), z: +start.z.toFixed(2) },
    target: { x: +target.x.toFixed(2), z: +target.z.toFixed(2) },
    reached: ok,
    why,
    end: { x: +end.x.toFixed(2), z: +end.z.toFixed(2) },
    taps: taps.length,
    retaps,
    walkedM: +polylineLength(pts).toFixed(1),
    straightM: +Math.hypot(target.x - start.x, target.z - start.z).toFixed(1),
    ms: Date.now() - t0,
    corrections: counters.corrections - corr0,
    wsFrames: counters.frames - frames0,
    stalls,
    earlyStops,
    tapLog: taps,
    samples,
  };
}

// --- run -----------------------------------------------------------------------
mkdirSync(SHOTS, { recursive: true });
const server = createServer({ port: PORT, dataDir: DATA_DIR, label: 'doors', verbose: !!process.env.DOORS_VERBOSE });
log(`data dir ${DATA_DIR}; server ${server.url}; ${DOORS.length} doors × spawns ${spawnsWanted.join(',')}${NO_RETURN ? '' : ' (out and back)'}; hop margin ${HOP_MARGIN}${TAP_DOOR ? '; taps the door once on screen' : ''}`);
await server.start();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const routes = [];
const returns = [];
const notes = [];
const t00 = Date.now();
let prev = null;
let joins = 0;
const writeOut = () => {
  const out = {
    ok: routes.length === DOORS.length * spawnsWanted.length && routes.every((r) => r.reached && !r.stalls.length) && returns.every((r) => !r.stalls.length),
    stallReproduced: [...routes, ...returns].some((r) => r.stalls.length > 0),
    port: PORT,
    device: PHONE,
    thresholds: STALL,
    hopMargin: HOP_MARGIN,
    tapDoor: TAP_DOOR,
    ms: Date.now() - t00,
    doors: DOORS.map((d) => ({ id: d.id, name: d.name, target: d.target })),
    spawns: spawnsWanted.map((n) => ({ n, id: SPAWN_POINTS[n - 1].id, position: SPAWN_POINTS[n - 1].position })),
    routes,
    returns,
    notes,
    consoleErrors,
  };
  writeFileSync(path.join(OUT, 'doors.json'), `${JSON.stringify(out, null, 1)}\n`);
  return out;
};
try {
  for (const want of spawnsWanted) {
    // Join until this page got the wanted spawn point (the server hands them out in join order).
    let me = null;
    for (let tries = 0; tries < SPAWN_POINTS.length + 2; tries++) {
      const cur = await join(browser, `phone${++joins}`);
      if (prev) await prev.ctx.close().catch(() => undefined);
      prev = cur;
      const sp = nearestSpawn(cur.at);
      if (sp.n === want && sp.d < 1.5) {
        me = cur;
        break;
      }
      log(`join ${joins} landed at spawn ${sp.n} (${sp.d.toFixed(2)} m away), want ${want}; joining again`);
    }
    if (!me) {
      notes.push(`could not get spawn ${want}`);
      continue;
    }
    const spawnPos = SPAWN_POINTS[want - 1].position;
    const home = { x: me.at.x, z: me.at.z };
    for (const d of DOORS) {
      const label = `s${want}-${d.id}`;
      const r = await walk(me.page, me.counters, {
        label,
        from: `spawn ${want}`,
        target: d.target,
        door: TAP_DOOR ? d.door : null,
        reached: (p) => Math.hypot(p.x - d.target.x, p.z - d.target.z) < 1.0 || zoneContains(d.apron, p),
      });
      r.door = d.id;
      r.spawn = want;
      routes.push(r);
      log(`${label}: ${r.reached ? 'reached' : `NOT reached (${r.why})`} — ${r.taps} taps, ${r.walkedM} m walked (${r.straightM} m straight), ${(r.ms / 1000).toFixed(0)} s, ${r.corrections} corrections, ${r.stalls.length} stalls, ${r.earlyStops.length} early stops`);
      if (!NO_RETURN) {
        const back = await walk(me.page, me.counters, { label: `${label}-back`, from: d.id, target: home, reached: (p) => Math.hypot(p.x - home.x, p.z - home.z) < 1.0 });
        back.door = d.id;
        back.spawn = want;
        returns.push(back);
        log(`${label}-back: ${back.reached ? 'reached' : `NOT reached (${back.why})`} — ${back.taps} taps, ${(back.ms / 1000).toFixed(0)} s, ${back.stalls.length} stalls`);
        if (Math.hypot(back.end.x - spawnPos.x, back.end.z - spawnPos.z) > 1.5) notes.push(`${label}: next route starts ${Math.hypot(back.end.x - spawnPos.x, back.end.z - spawnPos.z).toFixed(1)} m from spawn ${want}`);
      }
      writeOut();
    }
  }
} catch (err) {
  notes.push(`aborted: ${err?.stack ?? err}`);
  log(`aborted: ${err?.stack ?? err}`);
} finally {
  await browser.close().catch(() => undefined);
  await server.stop();
}

const out = writeOut();
const pad = (v, n) => String(v).padEnd(n);
console.log('');
console.log([pad('door', 14), pad('spawn', 6), pad('reached', 8), pad('taps', 5), pad('walked', 8), pad('straight', 9), pad('time', 6), pad('corr', 5), pad('stalls', 7), 'early stops'].join(' '));
for (const r of routes) {
  console.log([pad(r.door, 14), pad(r.spawn, 6), pad(r.reached ? 'yes' : 'NO', 8), pad(r.taps, 5), pad(`${r.walkedM} m`, 8), pad(`${r.straightM} m`, 9), pad(`${Math.round(r.ms / 1000)}s`, 6), pad(r.corrections, 5), pad(r.stalls.length, 7), r.earlyStops.length].join(' '));
}
const allStalls = [...routes, ...returns].flatMap((r) => r.stalls.map((s) => ({ route: r.label, ...s })));
console.log('');
if (allStalls.length) {
  console.log(`[doors] STALL REPRODUCED: ${allStalls.length} stall(s) (tap-to-move path active, < ${STALL.minProgress} m progress for ${STALL.window / 1000} s):`);
  for (const s of allStalls) console.log(`  ${s.route} at (${s.at.x.toFixed(2)}, ${s.at.z.toFixed(2)}), ${s.recoveredAfterMs == null ? 'did not recover (re-tapped)' : `recovered after ${(s.recoveredAfterMs / 1000).toFixed(1)} s`}; screenshot ${s.screenshot}`);
} else {
  console.log(`[doors] no stall reproduced: ${routes.length} routes out${NO_RETURN ? '' : ` + ${returns.length} back`}, no tap-to-move path stood still (< ${STALL.minProgress} m for ${STALL.window / 1000} s)`);
}
const unreached = routes.filter((r) => !r.reached);
if (unreached.length) console.log(`[doors] not reached: ${unreached.map((r) => `${r.label} (${r.why}; ended at ${r.end.x}, ${r.end.z})`).join('; ')}`);
const early = [...routes, ...returns].reduce((n, r) => n + r.earlyStops.length, 0);
console.log(`[doors] early stops (path ended > 1 m short of the tapped spot): ${early}; console/page errors: ${consoleErrors.length}${consoleErrors.length ? ` — ${consoleErrors.slice(0, 4).join(' | ')}` : ''}`);
for (const n of notes) console.log(`[doors] note: ${n}`);
console.log(`[doors] ${path.relative(ROOT, path.join(OUT, 'doors.json'))}; ${Math.round(out.ms / 1000)} s total`);
process.exit(STRICT && (!out.ok || consoleErrors.length) ? 1 : 0);
