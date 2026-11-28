#!/usr/bin/env node
/**
 * Every browser suite, one after another, with one summary.
 *
 *   npm run build && npm run e2e:all
 *   node scripts/e2e-all.mjs [--only build,build2] [--repeat N] [--with-player] [--with-ui]
 *
 * Runs the production-server suites in SUITES order (each spawns its own server through
 * scripts/lib/server.mjs on its own default port, with a fresh temp data dir), strictly
 * sequentially: headless software rendering cannot take two browser suites at once.
 * Each suite's output streams through unchanged and is also saved to
 * e2e-results/<suite>[.runN].log; each writes its result file ($E2E_RESULT) to
 * e2e-results/<suite>[.runN].json. At the end: a table (suite, checks passed/total, time),
 * the total wall-clock, and e2e-results/summary.json. Exit code 1 if anything failed,
 * 2 if the build is missing or older than the sources (run `npm run build`).
 *
 * Flags:
 *   --only a,b      run only these suites (names as in the table: acceptance, build, …)
 *   --repeat N      run the whole list N times (a pass needs every run green)
 *   --with-player   also run e2e-player (its own tsx server + Vite dev client)
 *   --with-ui       also run e2e-ui against $E2E_URL (an already running server; needs E2E_ADMIN_TOKEN)
 *   --list          print the suite list and exit
 *
 * Screenshots: suites that write to docs/screenshots/ by default (acceptance, combined, phone, camera)
 * write to e2e-results/shots/<suite>/ instead under this runner, so a run does not churn
 * the committed images; set ACCEPT_SHOTS / COMB_SHOTS / PHONE_SHOTS / CAMERA_SHOTS yourself to override. Every other
 * suite env var (ports, data dirs, *_VERBOSE) passes through.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtMs, formatSummary, mergeSummary, summaryRow } from './lib/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e-results');

/** The production-server suites, in run order, plus the opt-in ones. Default ports must all differ. */
const SUITES = [
  { name: 'acceptance', script: 'scripts/e2e-acceptance.mjs', port: ['ACCEPT_PORT', 2620], shots: 'ACCEPT_SHOTS' },
  { name: 'interiors', script: 'scripts/e2e-interiors.mjs', port: ['INT_PORT', 2631] },
  { name: 'activities', script: 'scripts/e2e-activities.mjs', port: ['ACT_PORT', 2633] },
  { name: 'build', script: 'scripts/e2e-build.mjs', port: ['BUILD_PORT', 2634] },
  { name: 'build2', script: 'scripts/e2e-build2.mjs', port: ['BUILD2_PORT', 2635] },
  { name: 'roofs', script: 'scripts/e2e-roofs.mjs', port: ['ROOFS_PORT', 2674], ifExists: true },
  { name: 'combined', script: 'scripts/e2e-combined.mjs', port: ['COMB_PORT', 2636], shots: 'COMB_SHOTS' },
  { name: 'built-interiors', script: 'scripts/e2e-built-interiors.mjs', port: ['BINT_PORT', 2641], ifExists: true },
  { name: 'phone', script: 'scripts/e2e-phone.mjs', port: ['PHONE_PORT', 2642], shots: 'PHONE_SHOTS', ifExists: true },
  { name: 'camera', script: 'scripts/e2e-camera.mjs', port: ['CAMERA_PORT', 2644], shots: 'CAMERA_SHOTS', ifExists: true },
  { name: 'homes', script: 'scripts/e2e-homes.mjs', port: ['HOMES_PORT', 2671], shots: 'HOMES_SHOTS', ifExists: true },
];
const OPTIONAL = {
  player: { name: 'player', script: 'scripts/e2e-player.mjs', port: ['E2E_SERVER_PORT', 2604] },
  ui: { name: 'ui', script: 'scripts/e2e-ui.mjs' },
  perf: { name: 'perf', script: 'scripts/perf-baseline.mjs', port: ['PERF_SERVER_PORT', 2672], shots: 'PERF_OUT_DIR' },
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { only: null, repeat: 1, withPlayer: false, withUi: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--only' || a.startsWith('--only=')) o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--repeat' || a.startsWith('--repeat=')) o.repeat = Number(val());
    else if (a === '--with-player') o.withPlayer = true;
    else if (a === '--with-ui') o.withUi = true;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a} (see the header of scripts/e2e-all.mjs)`);
  }
  if (!Number.isInteger(o.repeat) || o.repeat < 1) throw new Error('--repeat needs a whole number >= 1');
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`[e2e:all] ${err.message}`);
  process.exit(2);
}
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

let suites = SUITES.filter((s) => !s.ifExists || existsSync(path.join(ROOT, s.script)));
if (opts.withPlayer) suites.push(OPTIONAL.player);
if (opts.withUi) suites.push(OPTIONAL.ui);
if (opts.only) {
  const known = new Set([...SUITES, ...Object.values(OPTIONAL)].map((s) => s.name));
  const bad = opts.only.filter((n) => !known.has(n));
  if (bad.length) {
    console.error(`[e2e:all] unknown suite(s) ${bad.join(', ')}; known: ${[...known].join(', ')}`);
    process.exit(2);
  }
  const all = [...SUITES, ...Object.values(OPTIONAL)];
  suites = opts.only.map((n) => all.find((s) => s.name === n));
  const missing = suites.filter((s) => !existsSync(path.join(ROOT, s.script)));
  if (missing.length) {
    console.error(`[e2e:all] not in this checkout: ${missing.map((s) => s.script).join(', ')}`);
    process.exit(2);
  }
}
if (opts.list) {
  for (const s of suites) console.log(`${s.name.padEnd(16)} ${s.script}${s.port ? `  (${s.port[0]}, default ${s.port[1]})` : ''}`);
  process.exit(0);
}

// Default ports must not collide (they did once: build and build2 both on 2634), so each suite can
// also run standalone next to another. (Ports set in the env may repeat: this runner is sequential.)
{
  const seen = new Map();
  for (const s of SUITES) {
    if (!s.port) continue;
    const p = s.port[1];
    if (seen.has(p)) {
      console.error(`[e2e:all] ${s.name} and ${seen.get(p)} would both use port ${p}`);
      process.exit(2);
    }
    seen.set(p, s.name);
  }
}

if (opts.withUi && !process.env.E2E_ADMIN_TOKEN) {
  console.error('[e2e:all] --with-ui needs E2E_ADMIN_TOKEN (and E2E_URL: a running server; see README Testing)');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Build freshness: dist must be newer than its sources
// ---------------------------------------------------------------------------
function newest(dir, skip = /node_modules|\/dist\/|\.tsbuildinfo$/) {
  let best = { t: 0, file: null };
  if (!existsSync(dir)) return best;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else {
        const t = statSync(p).mtimeMs;
        if (t > best.t) best = { t, file: p };
      }
    }
  };
  walk(dir);
  return best;
}
function buildProblems() {
  const rel = (p) => path.relative(ROOT, p);
  const shared = newest(path.join(ROOT, 'shared/src'));
  const out = [];
  const checks = [
    // tsc only rewrites what changed, so compare against the newest output file.
    { what: 'shared', dist: path.join(ROOT, 'shared/dist'), src: [shared] },
    { what: 'server', dist: path.join(ROOT, 'server/dist'), src: [newest(path.join(ROOT, 'server/src'))] },
    // Vite rewrites the whole bundle and bundles shared in.
    { what: 'client', dist: path.join(ROOT, 'client/dist'), src: [newest(path.join(ROOT, 'client/src')), newest(path.join(ROOT, 'client/public')), shared, ...['client/index.html', 'client/vite.config.ts'].filter((f) => existsSync(path.join(ROOT, f))).map((f) => ({ t: statSync(path.join(ROOT, f)).mtimeMs, file: path.join(ROOT, f) }))] },
  ];
  for (const c of checks) {
    const d = newest(c.dist, /node_modules/);
    if (!d.file) {
      out.push(`${c.what}: no build output in ${rel(c.dist)}`);
      continue;
    }
    const src = c.src.reduce((a, b) => (b.t > a.t ? b : a), { t: 0, file: null });
    if (src.t > d.t) out.push(`${c.what}: ${rel(src.file)} is newer than the build (${rel(c.dist)})`);
  }
  return out;
}
const stale = buildProblems();
if (stale.length) {
  console.error(`[e2e:all] the production build is missing or older than the sources:\n  ${stale.join('\n  ')}\nrun \`npm run build\` first.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const startedAt = new Date().toISOString();
const rows = [];
let current = null;
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // The suite's own handlers stop its server; give it a moment, then write what we have.
    // No further suite starts (it would be orphaned when this process exits).
    stopping = true;
    if (current) current.kill(sig);
    setTimeout(() => finish(sig === 'SIGINT' ? 130 : 143), 6000);
  });
}

function runSuite(s, run) {
  const tag = opts.repeat > 1 ? `${s.name}.run${run}` : s.name;
  const resultPath = path.join(OUT, `${tag}.json`);
  const logPath = path.join(OUT, `${tag}.log`);
  rmSync(resultPath, { force: true });
  const env = { ...process.env, E2E_RESULT: resultPath };
  if (s.shots && process.env[s.shots] === undefined) env[s.shots] = path.join(OUT, 'shots', s.name);
  const args = [path.join(ROOT, s.script)];
  if (s.name === 'ui' && process.env.E2E_URL) args.push(process.env.E2E_URL);
  const logFile = createWriteStream(logPath);
  console.log(`\n[e2e:all] ── ${tag} (${s.script}) ${'─'.repeat(Math.max(0, 50 - tag.length))}`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = child;
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      logFile.write(d);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      logFile.write(d);
    });
    child.on('close', (code, signal) => {
      current = null;
      logFile.end();
      const ms = Date.now() - t0;
      let result = null;
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {
        /* none written */
      }
      const exitCode = code ?? (signal ? 128 : 1);
      const row = summaryRow({ suite: s.name, run, exitCode, ms, result });
      console.log(`[e2e:all] ${tag}: ${row.ok ? 'PASS' : 'FAIL'} ${row.passed}/${row.total} checks in ${fmtMs(ms)}${signal ? ` (killed by ${signal})` : ''}`);
      resolve(row);
    });
  });
}

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  const summary = mergeSummary(rows, { startedAt, finishedAt: new Date().toISOString(), argv: process.argv.slice(2) });
  writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n[e2e:all] summary (${path.relative(ROOT, path.join(OUT, 'summary.json'))})\n`);
  console.log(formatSummary(summary));
  process.exit(code ?? (summary.ok ? 0 : 1));
}

console.log(`[e2e:all] ${suites.map((s) => s.name).join(', ')}${opts.repeat > 1 ? ` × ${opts.repeat} runs` : ''}; results in ${path.relative(ROOT, OUT)}/`);
run: for (let run = 1; run <= opts.repeat; run++) {
  for (const s of suites) {
    if (stopping) break run;
    rows.push(await runSuite(s, run));
  }
}
if (!stopping) finish();
