#!/usr/bin/env node
/**
 * Rendering baseline for player building: seeds the 2,000-piece mix through the REAL server path and
 * reads what the build layer and the whole frame cost in three fixed views. Test tooling only.
 *
 *   npm run perf:baseline                       (needs shared built: `npm run build -w shared` or `npm run build`)
 *   node scripts/perf-baseline.mjs [--pieces 2000] [--out <file>] [--no-compare] [--write] [--views a,b,a]
 *
 * Runs against the DEV client, because the fixed views need the dev-only `?time=` / `?cam=` overrides:
 * a tsx server from the sources (PORT $PERF_SERVER_PORT, default 2672, fresh temp DATA_DIR, generous
 * BUILD_RANGE / rate / cap env overrides so the seeders place from where they stand — every other rule
 * applies) and Vite ($PERF_VITE_PORT, default 2673; $PERF_VITE_CONFIG for a custom config). Seeding uses
 * the plan of scripts/build-scale.mts (huts with roofs and furniture, then yards, then pillars and lamps;
 * every clearable plant cleared first), placed one at a time in plan order by 8 protocol clients
 * (scripts/lib/seed.mjs), so every run loads the same pieces in the same order.
 *
 * Then one desktop browser profile (1440x900, headless Chromium, software WebGL) loads each view in turn,
 * standing at the same spawn point every time (protocol joins line up the server's join-order spawn
 * counter first; later pages of the profile resume where it stood), alone in the room:
 *   default      `?autojoin=1&time=0.5&quality=medium&weather=clear&doors=0&fountain=0&portal=0&runes=0`
 *                the default spawn, camera following you (world state fixed: it follows the server otherwise)
 *   town_square  `… &cam=town_square`
 *   corner       `… &cam=-62,-74,30`                           a corner of the island with no pieces in view
 * Each view: `snapshot().buildRender` — all groups (`drawCalls` / `triangles`: every instanced mesh with
 * instances) and `visible` (meshes whose bounding sphere meets the camera frustum, and the pieces in view),
 * the whole frame (`buildRender.frame`: the renderer's calls / triangles, shadow pass included; median of
 * 6 rendered frames) and the frame meter (`snapshot().frame`). Frame times on this machine say nothing
 * about real devices: only the counts are compared.
 *
 * Also the build layer's own draw calls in that frame (`buildRender.passes`: main + shadow pass, counted
 * by the renderer's per-object hooks): the rest of the frame is noisy between identical runs (the shop
 * keepers walk server-timed routes in and out of view and of the shadow box: ±70 calls in the Town Square).
 *
 * Writes the result to docs/perf/baseline.json ($PERF_OUT_DIR/baseline.json if set; `--out` for any
 * other file) and exits non-zero if, in any view, visible build triangles or whole-frame calls are more
 * than 10% above the reference: the committed docs/perf/baseline.json (`git show HEAD:`), else the file
 * on disk before the run. Whole-frame calls are compared with the world's share held at the reference's
 * (reference calls − reference build share + this run's build share), so the keepers cannot fail or pass
 * a run. A run that regresses does not overwrite the reference unless `--write`.
 * `--no-compare` measures only (used for docs/perf/baseline-before.json). `--views town_square,town_square`
 * (diagnostics) measures only those views, repeats allowed, without comparing, into
 * e2e-results/perf-views.json unless `--out` is given.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, PIECES, PieceIndex, SPAWN_POINTS, WORLD_BOUNDS, clearableNature, validatePlacement } from '@elsewhere/shared';
import { resultFile } from './lib/report.mjs';
import { builderClient } from './lib/seed.mjs';

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const N = Number(arg('pieces', '2000'));
const DIAG = !!arg('views', '');
const COMPARE = !args.includes('--no-compare') && !DIAG;
const FORCE_WRITE = args.includes('--write');
const SERVER_PORT = Number(process.env.PERF_SERVER_PORT ?? 2672);
const VITE_PORT = Number(process.env.PERF_VITE_PORT ?? 2673);
const REF_REL = 'docs/perf/baseline.json';
const OUT = path.resolve(ROOT, arg('out', DIAG ? 'e2e-results/perf-views.json' : process.env.PERF_OUT_DIR ? path.join(process.env.PERF_OUT_DIR, 'baseline.json') : REF_REL));
const SEEDERS = 8;
/** Fixed time, quality and world state (weather, doors, fountain, portal, runes follow the server otherwise). */
const QUERY = 'autojoin=1&time=0.5&quality=medium&weather=clear&doors=0&fountain=0&portal=0&runes=0';
const ALL_VIEWS = [
  { name: 'default', query: '' },
  { name: 'town_square', query: '&cam=town_square' },
  { name: 'corner', query: '&cam=-62,-74,30' },
];
/** `--views a,b,a` (diagnostics: measure some views, repeats allowed, in that order); the baseline uses all three. */
const VIEWS = arg('views', '')
  ? arg('views', '')
      .split(',')
      .map((n, i, a) => ({ ...ALL_VIEWS.find((v) => v.name === n), name: a.indexOf(n) === i ? n : `${n}#${i}` }))
  : ALL_VIEWS;
const MEDIUM = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'medium' }, version: 1 })); } catch {}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elsewhere-perf-'));
const log = (...a) => console.log('[perf]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const consoleErrors = [];
const rec = resultFile('perf', () => consoleErrors);
const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok });
  rec.add(name, ok, detail);
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Processes (own process groups, killed on any exit)
// ---------------------------------------------------------------------------
const children = [];
function start(name, cmd, argv, opts) {
  const child = spawn(cmd, argv, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const tail = (d) => process.env.PERF_VERBOSE && process.stdout.write(`[${name}] ${d}`);
  child.stdout.on('data', tail);
  child.stderr.on('data', (d) => (process.env.PERF_VERBOSE || /error/i.test(String(d))) && process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}
function killAll() {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(sig === 'SIGINT' ? 130 : 143));

async function waitHttp(url, timeout = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function startServer() {
  // A distinctly named entry file so other runs' `pkill -f src/index.ts` cleanups don't hit this server.
  const entry = path.join(DATA_DIR, `perf-baseline-server-${SERVER_PORT}.ts`);
  writeFileSync(entry, `import ${JSON.stringify(path.join(ROOT, 'server', 'src', 'index.ts'))};\n`);
  start('server', 'npx', ['tsx', '--conditions=source', entry], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      DATA_DIR,
      BUILD_RANGE: '400',
      BUILD_RATE_CAPACITY: '100000',
      BUILD_RATE_PER_SECOND: '100000',
      BUILD_MAX_PER_PLAYER: '100000',
      BUILD_CLEAR_DAILY: '100000',
      BUILD_MAX_PER_WORLD: String(N + 1000),
    },
  });
  await waitHttp(`http://localhost:${SERVER_PORT}/api/health`, 90_000);
}
async function startVite() {
  const viteArgs = ['vite', '--port', String(VITE_PORT), '--strictPort'];
  if (process.env.PERF_VITE_CONFIG) viteArgs.push('--config', process.env.PERF_VITE_CONFIG);
  start('vite', 'npx', viteArgs, { cwd: path.join(ROOT, 'client'), env: { ...process.env, VITE_SERVER_PORT: String(SERVER_PORT) } });
  await waitHttp(`http://localhost:${VITE_PORT}/`, 90_000);
}

// ---------------------------------------------------------------------------
// The 2,000-piece mix (same plan as scripts/build-scale.mts), checked locally with the shared rulebook.
// ---------------------------------------------------------------------------
const CLEARED = new Set(clearableNature().keys());
function planPieces() {
  const ix = new PieceIndex();
  const out = [];
  let n = 0;
  const tryPut = (seeder, kind, x, z, rot = 0, level = 0, params, text) => {
    const variant = PIECES[kind].variants[(x + z + level) % PIECES[kind].variants.length | 0]?.id ?? PIECES[kind].variants[0].id;
    const v = validatePlacement({ kind, variant, x, z, rot, level, ...(params ? { params } : {}) }, { index: ix, builderId: `s${seeder}`, builderPos: null, players: [], cleared: CLEARED });
    if (!v.ok) return false;
    ix.add({ id: `l${n++}`, kind, x, z, rot, level, y: v.y, ownerId: `s${seeder}`, ...(v.params ? { params: v.params } : {}) });
    out.push({ seeder, kind, variant, x, z, rot, level, ...(params ? { params } : {}), ...(text ? { text } : {}) });
    return true;
  };
  let plot = 0;
  for (let cz = Math.ceil(WORLD_BOUNDS.minZ / 7) * 7; cz < WORLD_BOUNDS.maxZ && out.length < N; cz += 7) {
    for (let cx = Math.ceil(WORLD_BOUNDS.minX / 8) * 8; cx < WORLD_BOUNDS.maxX && out.length < N; cx += 8) {
      const s = plot++ % SEEDERS;
      const hut = [
        ['floor', cx - 1, cz, 0, 0],
        ['floor', cx + 1, cz, 0, 0],
        ['wall', cx - 1, cz - 1, 0, 0],
        ['wall_window', cx + 1, cz - 1, 0, 0],
        ['wall', cx - 2, cz, 1, 0],
        ['wall', cx + 2, cz, 1, 0],
        ['doorway', cx - 1, cz + 1, 0, 0],
        ['wall_window', cx + 1, cz + 1, 0, 0],
      ];
      if (!hut.every(([k, x, z, r]) => validatePlacement({ kind: k, variant: PIECES[k].variants[0].id, x, z, rot: r, level: 0 }, { index: ix, builderId: `s${s}`, builderPos: null, players: [] }).ok)) continue;
      for (const [k, x, z, r, l] of hut) if (out.length < N) tryPut(s, k, x, z, r, l);
      const storeys = plot % 2 === 0 ? 2 : 1;
      if (storeys === 2) for (const [k, x, z, r] of hut) if (out.length < N && k !== 'floor') tryPut(s, k === 'doorway' ? 'wall_window' : k, x, z, r, 1);
      if (out.length < N) tryPut(s, 'house_roof', cx, cz, 1, storeys, { w: 2, d: 4, style: plot % 3 === 0 ? 'hip' : 'gable', pitch: plot % 2 });
      if (out.length < N) tryPut(s, 'table', cx - 0.5, cz);
      if (out.length < N) tryPut(s, 'table_lamp', cx - 0.5, cz);
      if (out.length < N) tryPut(s, 'chair', cx + 1, cz, 3);
      if (out.length < N) tryPut(s, 'picture', cx - 1, cz - 1, 0);
      if (out.length < N) tryPut(s, 'name_board', cx - 1, cz + 1, 0, 0, undefined, 'Hut');
      if (out.length < N) tryPut(s, 'lamp', cx + 2.5, cz + 2);
      if (out.length < N) tryPut(s, 'crate', cx - 2.5, cz + 2);
      if (out.length < N) tryPut(s, 'fence', cx, cz + 3, 0);
      if (out.length < N) tryPut(s, 'planter', cx + 3, cz - 2);
    }
  }
  let k = 0;
  for (let cz = Math.ceil(WORLD_BOUNDS.minZ / 2) * 2; cz < WORLD_BOUNDS.maxZ && out.length < N; cz += 2) {
    for (let cx = Math.ceil(WORLD_BOUNDS.minX / 2) * 2; cx < WORLD_BOUNDS.maxX && out.length < N; cx += 2) {
      const s = k++ % SEEDERS;
      if (!tryPut(s, 'floor', cx, cz)) continue;
      const FILL = ['rug', 'crate', 'sofa', 'bookshelf', 'plant_tall', 'dining_table', 'barrel', 'armchair', 'bed', 'kitchen_counter', 'stove', 'fireplace'];
      if (out.length < N) tryPut(s, FILL[k % FILL.length], cx, cz);
    }
  }
  for (let cz = Math.ceil(WORLD_BOUNDS.minZ / 2) * 2 + 1; cz < WORLD_BOUNDS.maxZ && out.length < N; cz += 2) {
    for (let cx = Math.ceil(WORLD_BOUNDS.minX / 2) * 2 + 1; cx < WORLD_BOUNDS.maxX && out.length < N; cx += 2) {
      const s = k++ % SEEDERS;
      tryPut(s, k % 2 ? 'pillar' : 'lamp', cx, cz);
    }
  }
  return out;
}

async function seed(base) {
  const plan = planPieces();
  const clients = [];
  for (let i = 0; i < SEEDERS; i++) clients.push(await builderClient(base, { name: `Seeder ${i + 1}` }));
  const refused = {};
  const t0 = Date.now();
  try {
    const ids = [...CLEARED];
    await Promise.all(
      clients.map(async (c, i) => {
        for (const id of ids.filter((_, j) => j % SEEDERS === i)) {
          const r = await c.clear(id);
          if (!r.ok && r.reason !== 'already_cleared') refused[`clear:${r.reason}`] = (refused[`clear:${r.reason}`] ?? 0) + 1;
        }
      }),
    );
    // One placement at a time, in plan order (each by its seeder): every run gives the server, and so every
    // joining client, the same pieces in the same order. Instance order matters to three.js's instanced
    // bounding spheres (an incremental union), so an interleaved seeding would change what is culled.
    for (const o of plan) {
      const r = await clients[o.seeder].place(o);
      if (!r.ok) refused[r.reason ?? 'unknown'] = (refused[r.reason ?? 'unknown'] ?? 0) + 1;
    }
  } finally {
    for (const c of clients) await c.leave();
  }
  return { planned: plan.length, refused, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Browser measurement
// ---------------------------------------------------------------------------
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
/** Resolves after the page has rendered `n` more animation frames. */
const frames = (page, n) =>
  page.evaluate(
    (n) =>
      new Promise((r) => {
        let k = 0;
        const f = () => (++k >= n ? r() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

/** Where the measuring player stands in every view: the spawn point the first measurement got before. */
const HOME = SPAWN_POINTS[1].position;

/**
 * The server hands out spawn points by join order. Join and leave with protocol clients until one gets the
 * spawn point before HOME: the next join (the measuring browser) then spawns at HOME.
 */
async function alignSpawn(base) {
  const prev = SPAWN_POINTS[0].position;
  for (let i = 0; i < SPAWN_POINTS.length * 2; i++) {
    const c = await builderClient(base, { name: `Probe ${i + 1}` });
    let me = null;
    for (let t = 0; t < 200 && !me; t++) {
      me = c.room.state?.players?.get(c.room.sessionId) ?? null;
      if (!me) await sleep(25);
    }
    const at = me ? { x: me.x, z: me.z } : null;
    await c.leave();
    if (at && Math.hypot(at.x - prev.x, at.z - prev.z) < 0.5) return i + 1;
  }
  throw new Error('could not line up the spawn point');
}

async function measureView(ctx, view, expect) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`${view.name} pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${view.name}: ${m.text()}`));
  try {
    await page.goto(`http://localhost:${VITE_PORT}/?${QUERY}${view.query}`);
    await page.waitForFunction(
      (n) => {
        const s = window.__ELSEWHERE__?.snapshot();
        return s?.connection === 'connected' && s.local?.ready && s.build?.synced && s.build.count >= n && s.buildRender && s.buildRender.instances > 0;
      },
      expect,
      { timeout: 240_000, polling: 250 },
    );
    // Alone in the room: the previous view's player stays for the reconnection grace (and would be drawn).
    await page.waitForFunction(() => window.__ELSEWHERE__.snapshot().players.length === 1, null, { timeout: 120_000, polling: 500 });
    // Settle: camera ease, fades, shadow maps, first-use shader compiles.
    await frames(page, 8);
    await sleep(2000);
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await frames(page, 2);
      samples.push(await page.evaluate(() => {
        const s = window.__ELSEWHERE__.snapshot();
        // Where two fixed world points land on screen: the same numbers in two runs mean the same view.
        const q = (x, z) => {
          const p = window.__ELSEWHERE__.query('worldToScreen', x, z, 0);
          return p ? [Math.round(p.x), Math.round(p.y)] : null;
        };
        return { buildRender: s.buildRender, frame: s.frame, local: s.local, camera: s.camera, pieces: s.build.count, players: s.players.length, probe: [q(0, 0), q(20, 20)] };
      }));
    }
    const last = samples.at(-1);
    const br = last.buildRender;
    return {
      pieces: last.pieces,
      local: { x: Math.round(last.local.x * 100) / 100, z: Math.round(last.local.z * 100) / 100 },
      players: last.players,
      screenProbe: last.probe,
      build: {
        groups: br.groups,
        meshes: br.meshes ?? null,
        chunkSize: br.chunkSize ?? null,
        all: { drawCalls: br.drawCalls, triangles: br.triangles, instances: br.instances },
        visible: { drawCalls: median(samples.map((s) => s.buildRender.visible.drawCalls)), triangles: median(samples.map((s) => s.buildRender.visible.triangles)), pieces: median(samples.map((s) => s.buildRender.visible.pieces)) },
      },
      frame: {
        calls: median(samples.map((s) => s.buildRender.frame.calls)),
        triangles: median(samples.map((s) => s.buildRender.frame.triangles)),
        callsRange: [Math.min(...samples.map((s) => s.buildRender.frame.calls)), Math.max(...samples.map((s) => s.buildRender.frame.calls))],
        // The build layer's own draw calls in that frame, counted by the renderer's per-object hooks.
        build: { main: median(samples.map((s) => s.buildRender.passes?.main ?? NaN)), shadow: median(samples.map((s) => s.buildRender.passes?.shadow ?? NaN)) },
      },
      meter: last.frame ?? null,
    };
  } finally {
    await page.close();
    // The room keeps a closed page's player for the reconnection grace; the next view must not draw it.
    // Leaving also saves the profile's position, so the next page of this profile resumes right there.
    await sleep((CONFIG.network.reconnectGraceSeconds + 3) * 1000);
  }
}

function readReference() {
  try {
    return { from: `git HEAD:${REF_REL}`, data: JSON.parse(execFileSync('git', ['show', `HEAD:${REF_REL}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()) };
  } catch {
    /* not committed (or not a git checkout) */
  }
  const f = path.join(ROOT, REF_REL);
  if (existsSync(f)) return { from: REF_REL, data: JSON.parse(readFileSync(f, 'utf8')) };
  return null;
}

// ---------------------------------------------------------------------------
let browser = null;
let exitCode = 1;
try {
  const ref = COMPARE ? readReference() : null;
  log(`data dir ${DATA_DIR}; server :${SERVER_PORT}, vite :${VITE_PORT}; reference ${ref ? ref.from : 'none'}`);
  await startServer();
  await startVite();
  const base = `http://localhost:${SERVER_PORT}`;
  const seeding = await seed(base);
  const placed = (await (await fetch(`${base}/api/health`)).json().catch(() => ({}))).pieces ?? null;
  log('seeding:', JSON.stringify({ ...seeding, placed }));

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  // Warm-up load: Vite's first dependency optimisation may reload the page once; not measured.
  {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${VITE_PORT}/?${QUERY}&cam=-62,-74,30`);
    await page.waitForFunction(() => window.__ELSEWHERE__?.snapshot()?.connection === 'connected', null, { timeout: 240_000, polling: 250 });
    await sleep(3000);
    await ctx.close();
  }
  const expect = seeding.planned - Object.values(seeding.refused).reduce((a, b) => a + b, 0);
  record('seeded the piece mix through the real server path', expect >= N * 0.98, `${expect} of ${seeding.planned} planned placed in ${seeding.ms} ms; refused ${JSON.stringify(seeding.refused)}`);

  // One profile for every view (it resumes where it stood), starting at HOME.
  const probes = await alignSpawn(base);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MEDIUM);
  const views = {};
  for (const v of VIEWS) {
    const t0 = Date.now();
    views[v.name] = await measureView(ctx, v, expect);
    const m = views[v.name];
    record(`view ${v.name} measured`, m.pieces >= expect, `${Math.round((Date.now() - t0) / 1000)} s; pieces ${m.pieces}; build all ${m.build.all.drawCalls} calls / ${m.build.all.triangles} tris; visible ${m.build.visible.drawCalls} calls / ${m.build.visible.triangles} tris / ${m.build.visible.pieces} pieces; frame ${m.frame.calls} calls (${m.frame.callsRange.join('-')}; build ${m.frame.build.main} + ${m.frame.build.shadow} shadow) / ${m.frame.triangles} tris`);
  }
  await ctx.close();
  const away = Object.entries(views).filter(([, m]) => Math.hypot(m.local.x - HOME.x, m.local.z - HOME.z) > 0.3);
  record('the player stood at the same spawn point in every view', away.length === 0, `(${HOME.x.toFixed(2)}, ${HOME.z.toFixed(2)}) after ${probes} probe join(s)${away.length ? `; elsewhere in ${away.map(([n, m]) => `${n} (${m.local.x}, ${m.local.z})`).join(', ')}` : ''}`);
  if (views.corner) record('corner view shows no pieces', views.corner.build.visible.pieces === 0, `${views.corner.build.visible.pieces} pieces in view`);
  const busiest = Object.entries(views).sort((a, b) => b[1].build.visible.pieces - a[1].build.visible.pieces)[0][0];
  const result = {
    measuredAt: new Date().toISOString(),
    setup: { client: 'dev (tsx server + Vite)', viewport: '1440x900', quality: 'medium', time: 0.5, renderer: 'headless Chromium, software WebGL (SwiftShader)', pieces: Object.values(views)[0].pieces, seeding },
    note: 'Counts are what is compared; frame times on a software renderer say nothing about real devices.',
    busiest,
    views,
  };

  let regressed = false;
  if (ref) {
    for (const [name, m] of Object.entries(views)) {
      const r = ref.data.views?.[name];
      if (!r) continue;
      // Whole-frame calls with the world's share held at the reference's: the keepers walk server-timed
      // routes in and out of the view and the shadow box (±70 calls in the Town Square between identical
      // runs), which says nothing about this code. The build layer's share is exact.
      const buildNow = m.frame.build.main + m.frame.build.shadow;
      const buildWas = r.frame.build.main + r.frame.build.shadow;
      const tri = { now: m.build.visible.triangles, was: r.build.visible.triangles };
      const calls = { now: r.frame.calls - buildWas + buildNow, was: r.frame.calls };
      const okTri = tri.now <= tri.was * 1.1;
      const okCalls = calls.now <= calls.was * 1.1;
      regressed ||= !okTri || !okCalls;
      record(`${name}: within 10% of the reference`, okTri && okCalls, `visible build triangles ${tri.now} vs ${tri.was}; whole-frame calls ${calls.now} vs ${calls.was} (build share ${buildNow} vs ${buildWas}; measured whole frame ${m.frame.calls})`);
    }
  }
  record('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  if (!regressed || FORCE_WRITE) {
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
    log(`wrote ${path.relative(ROOT, OUT)}`);
  } else {
    const side = path.join(ROOT, 'e2e-results', 'perf-baseline.latest.json');
    mkdirSync(path.dirname(side), { recursive: true });
    writeFileSync(side, `${JSON.stringify(result, null, 2)}\n`);
    log(`regressed: reference kept; this run written to ${path.relative(ROOT, side)}`);
  }
  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} catch (err) {
  console.error('[perf] error:', err);
  record('run completed', false, String(err?.message ?? err));
  exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  killAll();
}
process.exit(exitCode);
