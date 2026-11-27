#!/usr/bin/env node
/**
 * MVP acceptance test: two REAL browser clients against the REAL production build.
 *
 *   npm run build && npm run e2e:acceptance
 *   node scripts/e2e-acceptance.mjs            (same thing)
 *
 * Spawns its own production server (`node server/dist/index.js`, NODE_ENV=production,
 * random SESSION_SECRET, port $ACCEPT_PORT or 2620, fresh DATA_DIR in the OS temp dir
 * unless $ACCEPT_DATA_DIR is set) serving the built client. Lowered thresholds so two
 * players can trigger the collective rules in one run (set in SERVER_ENV below):
 *   FOUNTAIN_STAGES=2,4,6  FOUNTAIN_STAGE_DISTINCT=2,2,2   (stage 1 = 2 touches by 2 distinct players)
 *   PORTAL_RUNES_REQUIRED=2 (the default)                  GAZETTE_EARLY_EVENTS=3, GAZETTE_EARLY_DELAY_SECONDS=15
 *
 * Client A: desktop 1440x900 (mouse + keyboard). Client B: Pixel 7 emulation (touch).
 * Both go through the real onboarding UI (intro → guest → customize → name → Town Square).
 * Every check prints PASS/FAIL with a name; exit code 0 only if all pass.
 *
 * Nothing here simulates players or invents activity: every action is a real input in a real
 * browser page against the real server. Graphics are set to "low" before boot (headless
 * WebGL is software-rendered); this changes rendering cost only.
 *
 * Env: ACCEPT_PORT, ACCEPT_DATA_DIR, ACCEPT_SHOTS (screenshot dir, default
 * docs/screenshots/acceptance; "0" disables), ACCEPT_VERBOSE=1 (server output).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './lib/server.mjs';
import { resultFile } from './lib/report.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.ACCEPT_PORT ?? 2620);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.ACCEPT_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'elsewhere-accept-'));
const SHOTS = process.env.ACCEPT_SHOTS === '0' ? null : path.resolve(ROOT, process.env.ACCEPT_SHOTS ?? 'docs/screenshots/acceptance');
const PHONE = 'Pixel 7';
const SERVER_ENV = {
  NODE_ENV: 'production',
  PORT: String(PORT),
  DATA_DIR,
  SESSION_SECRET: randomBytes(32).toString('hex'),
  FOUNTAIN_STAGES: '2,4,6',
  FOUNTAIN_STAGE_DISTINCT: '2,2,2',
  PORTAL_RUNES_REQUIRED: '2',
  GAZETTE_EARLY_EVENTS: '3',
  GAZETTE_EARLY_DELAY_SECONDS: '15',
};
const T = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[accept]', ...a);
const results = [];
const resultOut = resultFile('acceptance', () => pageErrors);
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  resultOut.add(name, ok, detail);
  console.log(`[accept] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
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
// Server process (production build)
// ---------------------------------------------------------------------------
let server = null;
const serverHandle = createServer({ port: PORT, env: SERVER_ENV, dataDir: DATA_DIR, label: 'accept', verbose: !!process.env.ACCEPT_VERBOSE });
async function startServer() {
  await serverHandle.start();
  server = serverHandle.proc;
}
async function stopServer() {
  await serverHandle.stop();
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
const audioDebug = (page) => page.evaluate(() => window.__ELSEWHERE_AUDIO__?.debug() ?? null);
async function waitSnap(page, pred, label, timeout = T) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last && { connection: last.connection, players: last.players, local: last.local, world: last.world })?.slice(0, 400)}`);
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 75, scale: 'css' }).catch((e) => log('screenshot failed', name, e.message));
}
const isTouch = (page) => page.__touch === true;
async function tapOrClick(page, x, y) {
  if (isTouch(page)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
}
async function closeOverlays(page) {
  for (const sel of ['[data-testid=chat-close]', '[data-testid=sheet-close]', '[data-testid=hint-close]']) {
    for (let i = 0; i < 3 && (await page.$(sel)); i++) {
      await page.click(sel).catch(() => undefined);
      await sleep(200);
    }
  }
}
function playerCount(page) {
  return page.textContent('[data-testid=player-count]').then((t) => Number(t?.trim()));
}
async function waitCount(page, n, timeout = T) {
  const t0 = Date.now();
  let c = NaN;
  while (Date.now() - t0 < timeout) {
    c = await playerCount(page).catch(() => NaN);
    if (c === n) return c;
    await sleep(250);
  }
  throw new Error(`player count stayed ${c}, expected ${n}`);
}

/**
 * Real input: click/tap the interactable in the 3D view (the player walks there and uses it).
 * If it is off-screen or hidden, click/tap the ground toward it first.
 */
async function goInteract(page, id, done, tries = 40) {
  const it = await query(page, 'interactable', id);
  assert(it, `no interactable ${id}`);
  const vp = page.viewportSize();
  const pickType = isTouch(page) ? 'touch' : 'mouse';
  for (let i = 0; i < tries; i++) {
    await closeOverlays(page);
    const ground = await query(page, 'worldToScreen', it.position.x, it.position.z);
    const inView = ground && ground.x > 40 && ground.x < vp.width - 40 && ground.y > 120 && ground.y < vp.height - 160;
    if (inView) {
      for (const dy of [0, 8, 16, 24, 32, 40, 56]) {
        const pk = await query(page, 'pick', ground.x, ground.y - dy, pickType);
        if (pk?.kind === 'interactable' && pk.id === id && (await onCanvas(page, ground.x, ground.y - dy))) {
          await tapOrClick(page, ground.x, ground.y - dy);
          if (await done().then(() => true, () => false)) return;
          break;
        }
      }
    }
    const s = await snap(page);
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    assert(me && ground, 'cannot project positions');
    const dx = ground.x - me.x;
    const dy = ground.y - me.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(len, Math.min(vp.width, vp.height) * 0.3);
    // A ground point toward the target: must be on the canvas, walkable, and not on another
    // interactable or player (tapping a lamp on the way would use the lamp instead of walking).
    let tap = null;
    const base = Math.atan2(dy, dx);
    search: for (const k of [1, 0.7, 1.3, 0.5]) {
      for (const da of [0, 0.35, -0.35, 0.7, -0.7]) {
        const tx = Math.max(50, Math.min(vp.width - 50, me.x + Math.cos(base + da) * step * k));
        const ty = Math.max(130, Math.min(vp.height - 170, me.y + Math.sin(base + da) * step * k));
        if (!(await onCanvas(page, tx, ty)) || (await query(page, 'pick', tx, ty, pickType))) continue;
        const g = await query(page, 'groundFromScreen', tx, ty);
        if (!g || !(await query(page, 'isWalkable', g.x, g.z))) continue;
        tap = { tx, ty };
        break search;
      }
    }
    assert(tap, `no free ground to walk toward ${id}`);
    await tapOrClick(page, tap.tx, tap.ty);
    await sleep(1600);
  }
  await shot(page, `fail-${isTouch(page) ? 'phone' : 'desktop'}-${id}`);
  throw new Error(`could not reach/use ${id}`);
}
const waitFor = async (pred, label, timeout = 15_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await pred()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${label}`);
};

/** Drag horizontally across the character preview; returns [yawBefore, yawAfter] as rendered. */
async function dragPreview(page) {
  const el = await page.waitForSelector('[data-testid=character-preview]', { timeout: T });
  await page.waitForFunction(() => document.querySelector('[data-testid=character-preview]')?.dataset.yaw !== undefined, null, { timeout: T });
  const box = await el.boundingBox();
  const readYaw = () => page.evaluate(() => Number(document.querySelector('[data-testid=character-preview]').dataset.yaw));
  const before = await readYaw();
  const y = box.y + box.height * 0.5;
  const x0 = box.x + box.width * 0.3;
  if (isTouch(page)) {
    const cdp = await page.context().newCDPSession(page);
    const t = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 })) });
    await t('touchStart', [{ x: x0, y }]);
    for (let i = 1; i <= 12; i++) {
      await t('touchMove', [{ x: x0 + i * 12, y }]);
      await sleep(30);
    }
    await t('touchEnd', []);
    await cdp.detach();
  } else {
    await page.mouse.move(x0, y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(x0 + i * 12, y);
      await sleep(30);
    }
    await page.mouse.up();
  }
  await sleep(600);
  return [before, await readYaw()];
}

/** Full real onboarding. Returns the chosen name. */
async function onboard(page, label, name) {
  await page.goto(BASE);
  await page.waitForSelector('[data-testid=intro]', { timeout: T });
  const pre = await audioDebug(page);
  await shot(page, `${label}-01-intro`);
  // The intro advances on a gesture (or by itself); either way the guest button follows.
  if (await page.$('[data-testid=intro-skip]')) await page.click('[data-testid=intro-skip]').catch(() => undefined);
  await page.waitForSelector('[data-testid=auth-choice]', { timeout: T });
  await page.click('[data-testid=enter-guest]');
  await page.waitForSelector('[data-testid=customize]', { timeout: T });
  await page.click('[data-testid=randomize]');
  await sleep(500);
  const yaw = await dragPreview(page);
  await shot(page, `${label}-02-customize`);
  await page.click('[data-testid=customize-save]');
  await page.waitForSelector('[data-testid=name-step]', { timeout: T });
  await page.fill('[data-testid=name-input]', name);
  await shot(page, `${label}-03-name`);
  await page.click('[data-testid=enter-world]');
  await page.waitForSelector('[data-testid=hud]', { timeout: T });
  const s = await waitSnap(page, (x) => x.connection === 'connected' && x.local.ready && x.navReady === true && x.world?.self, `${label} in world`, 120_000);
  return { s, yaw, preAudio: pre };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`data dir ${DATA_DIR}; server ${BASE}; env ${Object.entries(SERVER_ENV).filter(([k]) => !/SECRET|DATA_DIR|PORT|NODE_ENV/.test(k)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
await startServer();
const browser = await chromium.launch();
const LOW_GFX = `try { if (!localStorage.getItem('elsewhere.settings.v1')) localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ ...devices[PHONE] });
await ctxA.addInitScript(LOW_GFX);
await ctxB.addInitScript(LOW_GFX);
let a = await ctxA.newPage();
let b = await ctxB.newPage();
b.__touch = true;
watch(a, 'A(desktop)');
watch(b, `B(${PHONE})`);

const NAME_A = 'Desk Wren';
const NAME_B = 'Phone Fern';
let A = null;
let B = null;
const state = {};
try {
  // --- Onboarding (both) ------------------------------------------------------
  await check('0. onboarding through the real UI on desktop and phone', async () => {
    A = await onboard(a, 'desktop', NAME_A);
    state.countAlone = await waitCount(a, 1);
    B = await onboard(b, 'phone', NAME_B);
    assert(A.s.world.self.name === NAME_A, `A is ${A.s.world.self.name}`);
    assert(B.s.world.self.name === NAME_B, `B is ${B.s.world.self.name}`);
    return `A=${NAME_A}, B=${NAME_B} (${PHONE}, touch); A alone saw count ${state.countAlone}`;
  });
  if (!A || !B) throw new Error('onboarding failed; cannot continue');
  const idA = A.s.sessionId;
  const idB = B.s.sessionId;

  // --- 10. preview drag ------------------------------------------------------
  await check('10. character preview drag-to-rotate (mouse on desktop, touch on phone)', async () => {
    const dA = A.yaw[1] - A.yaw[0];
    const dB = B.yaw[1] - B.yaw[0];
    assert(Math.abs(dA) > 0.5, `desktop preview yaw changed only ${dA.toFixed(3)} rad`);
    assert(Math.abs(dB) > 0.5, `phone preview yaw changed only ${dB.toFixed(3)} rad`);
    return `rendered yaw desktop ${A.yaw[0].toFixed(2)}→${A.yaw[1].toFixed(2)}, phone ${B.yaw[0].toFixed(2)}→${B.yaw[1].toFixed(2)} rad`;
  });

  // --- 1. same world, see each other, counts --------------------------------
  await check('1a. same world: each sees the other; player count = 2 connected clients', async () => {
    const sa = await waitSnap(a, (x) => x.players.some((p) => p.id === idB), 'A sees B');
    const sb = await waitSnap(b, (x) => x.players.some((p) => p.id === idA), 'B sees A');
    const ids = (s) => s.players.map((p) => p.id).sort().join(',');
    assert(ids(sa) === ids(sb), `rosters differ: ${ids(sa)} vs ${ids(sb)}`);
    assert(sa.players.length === 2, `A roster has ${sa.players.length}`);
    const [ca, cb] = [await waitCount(a, 2), await waitCount(b, 2)];
    const nameA = sb.players.find((p) => p.id === idA)?.name;
    const nameB = sa.players.find((p) => p.id === idB)?.name;
    assert(nameA === NAME_A && nameB === NAME_B, `names seen: ${nameA}, ${nameB}`);
    await shot(a, 'desktop-04-together');
    await shot(b, 'phone-04-together');
    return `rosters identical (${ids(sa)}); top bar shows ${ca} on desktop and ${cb} on phone`;
  });

  // --- 9a. audio unlocked after gesture ---------------------------------------
  await check('9a. audio graph starts only after a user gesture', async () => {
    for (const [label, r, page] of [['A', A, a], ['B', B, b]]) {
      assert(r.preAudio && r.preAudio.unlocked === false && r.preAudio.state !== 'running', `${label} audio before gesture: ${JSON.stringify(r.preAudio)}`);
      const now = await audioDebug(page);
      assert(now.unlocked && now.state === 'running', `${label} audio after onboarding: unlocked=${now.unlocked} state=${now.state}`);
    }
    return `before gesture: state=${A.preAudio.state}/${B.preAudio.state}, unlocked=false; after: running on both`;
  });

  // --- 3. chat ------------------------------------------------------------------
  async function sendChat(page, tab, text) {
    if (!(await page.$('[data-testid=chat]'))) await page.click('[data-testid=nav-chat]');
    await page.click(`[data-testid=chat-tab-${tab}]`);
    await page.fill('[data-testid=chat-input]', text);
    await page.press('[data-testid=chat-input]', 'Enter');
  }
  async function seesInChat(page, tab, text) {
    if (!(await page.$('[data-testid=chat]'))) await page.click('[data-testid=nav-chat]');
    await page.click(`[data-testid=chat-tab-${tab}]`);
    await page.waitForSelector(`[data-testid=chat-log] >> text=${text}`, { timeout: 15_000 });
  }
  await check('3a. Town chat A→B and B→A rendered in the other chat UI', async () => {
    const t1 = `hello from the desk ${Date.now() % 100000}`;
    await sendChat(a, 'town', t1);
    await seesInChat(b, 'town', t1);
    await shot(b, 'phone-05-chat-town');
    const t2 = `hello from the phone ${Date.now() % 100000}`;
    await sendChat(b, 'town', t2);
    await seesInChat(a, 'town', t2);
    await shot(a, 'desktop-05-chat-town');
    await closeOverlays(a);
    await closeOverlays(b);
    return `"${t1}" on B, "${t2}" on A`;
  });
  await check('3b. Nearby message from B shows as a speech bubble over B on A', async () => {
    const t = `nearby wave ${Date.now() % 10000}`;
    await closeOverlays(a);
    await sendChat(b, 'nearby', t);
    // A bubble lasts ~4-5 s; check and capture it right away.
    await a.waitForFunction((t) => [...document.querySelectorAll('.ew-bubble')].some((el) => !el.classList.contains('ew-off') && el.textContent.includes(t)), t, { timeout: 15_000 });
    await shot(a, 'desktop-06-bubble');
    await closeOverlays(b);
    await seesInChat(a, 'nearby', t);
    await closeOverlays(a);
    return `bubble "${t}" visible on A and in A's Nearby tab`;
  });

  // --- 2. movement ----------------------------------------------------------
  await check('2a. A moves with the keyboard; B sees A move in real time', async () => {
    await closeOverlays(a);
    const before = (await snap(b)).players.find((p) => p.id === idA);
    let moved = 0;
    let used = '';
    for (const key of ['KeyW', 'KeyD', 'KeyS', 'KeyA']) {
      const start = (await snap(a)).local;
      await a.keyboard.down(key);
      const seen = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        const p = (await snap(b)).players.find((q) => q.id === idA);
        seen.push({ t: Date.now() - t0, x: p.x, z: p.z });
        await sleep(100);
      }
      await a.keyboard.up(key);
      await sleep(500);
      const end = (await snap(a)).local;
      moved = Math.hypot(end.x - start.x, end.z - start.z);
      if (moved > 1) {
        const after = (await snap(b)).players.find((p) => p.id === idA);
        const firstChange = seen.find((q) => Math.hypot(q.x - before.x, q.z - before.z) > 0.2);
        const seenDist = Math.hypot(after.x - end.x, after.z - end.z);
        assert(firstChange, 'B never saw A move while the key was held');
        assert(seenDist < 0.6, `B's view of A is ${seenDist.toFixed(2)} m off A's own position`);
        used = `${key}: A moved ${moved.toFixed(2)} m; B saw the first change ${firstChange.t} ms after keydown, final error ${seenDist.toFixed(2)} m`;
        break;
      }
    }
    assert(used, `keyboard did not move A (last try ${moved.toFixed(2)} m)`);
    return used;
  });
  await check('2b. B moves by tap-to-move; A sees B move', async () => {
    await closeOverlays(b);
    const vp = b.viewportSize();
    const s = await snap(b);
    const me = await query(b, 'worldToScreen', s.local.x, s.local.z);
    let target = null;
    for (const [ox, oy] of [[0, -150], [120, -60], [-120, -60], [120, 80], [-120, 80], [0, 160], [0, -220], [160, 0], [-160, 0]]) {
      const x = me.x + ox;
      const y = me.y + oy;
      if (x < 40 || x > vp.width - 40 || y < 140 || y > vp.height - 200) continue;
      const g = await query(b, 'groundFromScreen', x, y);
      if (!g || !(await query(b, 'isWalkable', g.x, g.z))) continue;
      if (await query(b, 'pick', x, y, 'touch')) continue;
      if (!(await onCanvas(b, x, y))) continue;
      target = { x, y, g };
      break;
    }
    assert(target, 'no free tap target found');
    const before = (await snap(a)).players.find((p) => p.id === idB);
    await b.touchscreen.tap(target.x, target.y);
    await waitSnap(b, (x) => x.local.speed < 0.05 && !x.motion?.path && Math.hypot(x.local.x - target.g.x, x.local.z - target.g.z) < 1.0, 'B reaches tap target', 20_000);
    await sleep(600);
    const bNow = (await snap(b)).local;
    const seen = (await snap(a)).players.find((p) => p.id === idB);
    const moved = Math.hypot(seen.x - before.x, seen.z - before.z);
    const err = Math.hypot(seen.x - bNow.x, seen.z - bNow.z);
    assert(moved > 1, `A saw B move only ${moved.toFixed(2)} m`);
    assert(err < 0.6, `A's view of B is ${err.toFixed(2)} m off`);
    await shot(b, 'phone-07-after-tap');
    return `tap at (${Math.round(target.x)}, ${Math.round(target.y)}) → B walked to (${bNow.x.toFixed(1)}, ${bNow.z.toFixed(1)}); A saw B move ${moved.toFixed(2)} m, error ${err.toFixed(2)} m`;
  });

  // --- 4. shared objects --------------------------------------------------------
  await check('4a. A sits on a bench; B sees A seated', async () => {
    const bench = 'bench_square_1';
    await goInteract(a, bench, () => waitSnap(a, (x) => x.players.find((p) => p.id === idA)?.seat?.startsWith(`${bench}#`), 'A seated', 12_000));
    const sb = await waitSnap(b, (x) => {
      const p = x.players.find((q) => q.id === idA);
      return p?.seat?.startsWith(`${bench}#`) && p.anim === 'sit';
    }, 'B sees A seated', 10_000);
    await sleep(800);
    await shot(a, 'desktop-08-seated');
    await shot(b, 'phone-08-sees-seated');
    const p = sb.players.find((q) => q.id === idA);
    // Stand up again (a movement key stands).
    await a.keyboard.down('KeyS');
    await sleep(500);
    await a.keyboard.up('KeyS');
    await waitSnap(b, (x) => x.players.find((q) => q.id === idA)?.seat === '', 'B sees A stand', 10_000);
    return `B saw seat=${p.seat} anim=${p.anim}, then saw A stand up`;
  });
  await check('4b + 9b. B rings the bell; A receives the event (object state + bell sfx on A)', async () => {
    const bellBefore = (await snap(a)).world.objects.bell_town_hall?.value ?? 0;
    const sfxBefore = (await audioDebug(a)).sfxCounts;
    const sumBell = (c) => Object.entries(c).filter(([k]) => k.startsWith('bell')).reduce((n, [, v]) => n + v, 0);
    await goInteract(b, 'bell_town_hall', () => waitSnap(b, (x) => (x.world.objects.bell_town_hall?.value ?? 0) > bellBefore, 'bell rung (B)', 12_000));
    const sa = await waitSnap(a, (x) => (x.world.objects.bell_town_hall?.value ?? 0) > bellBefore, 'A sees bell count rise', 10_000);
    await waitFor(async () => sumBell((await audioDebug(a)).sfxCounts) > sumBell(sfxBefore), 'bell sfx on A', 8000);
    const recent = (await audioDebug(a)).recent.filter((r) => r.name.startsWith('bell')).at(-1);
    await shot(b, 'phone-09-bell');
    return `bell value ${bellBefore}→${sa.world.objects.bell_town_hall.value} on A; A played sfx "${recent?.name}" (A did not ring it)`;
  });

  // --- 9c. volumes ---------------------------------------------------------------
  await check('9c. music / ambience / sfx volume sliders change the respective bus gains', async () => {
    await closeOverlays(a);
    await a.click('[data-testid=nav-settings]');
    await a.waitForSelector('[data-testid=panel-settings]');
    const bus = async () => {
      await sleep(900);
      return (await audioDebug(a)).busGains;
    };
    const b0 = await bus();
    const out = [];
    for (const [ch, v] of [['music', '20'], ['ambience', '85'], ['sfx', '35']]) {
      const prev = await bus();
      await a.fill(`[data-testid=vol-${ch}]`, v);
      const next = await bus();
      const changed = Object.keys(next).filter((k) => Math.abs(next[k] - prev[k]) > 0.01);
      assert(changed.length === 1 && changed[0] === ch, `setting ${ch}=${v} changed buses ${JSON.stringify(changed)} (${JSON.stringify(prev)} → ${JSON.stringify(next)})`);
      const want = (Number(v) / 100);
      assert(Math.abs(next[ch] - want) < 0.05 || Math.abs(next[ch] - want * next.master) < 0.05, `${ch} bus ${next[ch].toFixed(3)} vs slider ${want}`);
      out.push(`${ch} ${prev[ch].toFixed(2)}→${next[ch].toFixed(2)}`);
    }
    await shot(a, 'desktop-10-settings');
    await closeOverlays(a);
    return `${out.join(', ')} (master ${b0.master.toFixed(2)} unchanged)`;
  });

  // --- 5. fountain ---------------------------------------------------------------
  await check('5. fountain advances a stage from contributions by both players; both see it', async () => {
    const stage0 = (await snap(a)).world.fountainStage;
    const inspect = (page) => () => page.waitForSelector('[data-testid=panel-inspect], [data-testid=panel-discovery]', { timeout: 12_000 });
    await goInteract(a, 'fountain', inspect(a));
    await closeOverlays(a);
    await goInteract(b, 'fountain', inspect(b));
    await closeOverlays(b);
    const sa = await waitSnap(a, (x) => x.world.fountainStage > stage0 && (x.world.objects.fountain?.value ?? 0) > stage0, 'A sees new fountain stage', 15_000);
    const sb = await waitSnap(b, (x) => x.world.fountainStage > stage0 && (x.world.objects.fountain?.value ?? 0) > stage0, 'B sees new fountain stage', 15_000);
    const api = await fetch(`${BASE}/api/world`).then((r) => r.json());
    state.fountainStage = api.fountainStage;
    await sleep(1500);
    await shot(a, 'desktop-11-fountain-stage');
    await shot(b, 'phone-11-fountain-stage');
    return `stage ${stage0}→${sa.world.fountainStage} on A, ${sb.world.fountainStage} on B; server says stage ${api.fountainStage} with ${api.fountainContributors} contributors (thresholds lowered: FOUNTAIN_STAGES=2,4,6, FOUNTAIN_STAGE_DISTINCT=2,2,2)`;
  });

  // --- 6. portal -------------------------------------------------------------------
  await check('6. both players light runes together; the portal wakes and both see it awake', async () => {
    // Walk both to The Unknown first (real click/tap-to-move), then touch two different runes close together in time.
    const near = (page, id, r) => async () => {
      const it = await query(page, 'interactable', id);
      await waitSnap(page, (x) => Math.hypot(x.local.x - it.position.x, x.local.z - it.position.z) < r, `near ${id}`, 2500);
    };
    await Promise.all([goInteract(a, 'portal_arch', near(a, 'portal_arch', 7), 60).catch(() => undefined), goInteract(b, 'portal_arch', near(b, 'portal_arch', 7), 60).catch(() => undefined)]);
    await closeOverlays(a);
    await closeOverlays(b);
    const lit = (page, id) => () => waitSnap(page, (x) => x.world.objects[id]?.active === true, `${id} lit`, 6000);
    const t0 = Date.now();
    await Promise.all([goInteract(a, 'rune_1', lit(a, 'rune_1')), goInteract(b, 'rune_2', lit(b, 'rune_2'))]);
    const spread = ((Date.now() - t0) / 1000).toFixed(1);
    const sa = await waitSnap(a, (x) => x.world.portalAwake === true && x.world.objects.portal_arch?.active === true, 'A sees portal awake', 15_000);
    const sb = await waitSnap(b, (x) => x.world.portalAwake === true && x.world.objects.portal_arch?.active === true, 'B sees portal awake', 15_000);
    await sleep(1500);
    await shot(a, 'desktop-12-portal-awake');
    await shot(b, 'phone-12-portal-awake');
    return `runes lit within ${spread}s; portal awake on A (${sa.world.portalAwake}) and B (${sb.world.portalAwake})`;
  });

  // --- 7. gazette ---------------------------------------------------------------
  await check('7. a Gazette issue is compiled from these real events and renders in the panel', async () => {
    let issue = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const r = await fetch(`${BASE}/api/gazette?limit=1`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      issue = r?.issues?.[0] ?? null;
      if (issue) break;
      await sleep(2000);
    }
    assert(issue, 'no Gazette issue within 120 s (GAZETTE_EARLY_EVENTS=3, delay 15 s)');
    state.issueNumber = issue.issueNumber;
    state.headline = issue.articles?.[0]?.headline;
    for (const [page, label] of [[a, 'desktop'], [b, 'phone']]) {
      await closeOverlays(page);
      await page.click('[data-testid=nav-gazette]');
      await page.waitForSelector('[data-testid=gazette-issue] .article__headline', { timeout: 20_000 });
      const h = await page.textContent('[data-testid=gazette-issue] .article__headline');
      assert(h && h.trim().length > 0, `${label} headline empty`);
      await shot(page, `${label}-13-gazette`);
      await closeOverlays(page);
    }
    return `issue No. ${issue.issueNumber}, ${issue.articles?.length} articles; lead "${state.headline}"; rendered on both`;
  });

  // Town history before restart (for 8).
  await a.click('[data-testid=nav-gazette]');
  await a.click('[data-testid=panel-gazette] [role=radio]:has-text("Town history")');
  await a.waitForSelector('[data-testid=memory-timeline] .event', { timeout: 20_000 });
  state.historyBefore = await a.$$eval('[data-testid=memory-timeline] .event__text', (els) => els.map((e) => e.textContent));
  await shot(a, 'desktop-14-history');
  await closeOverlays(a);
  state.selfA = (await snap(a)).world.self;
  state.selfB = (await snap(b)).world.self;

  // --- 8. persistence across restart -------------------------------------------
  await check('8. server restart on the same DATA_DIR: both resume as the same profile; fountain, history and Gazette persist', async () => {
    // Leave the pages (as closing the tab would) so the outage does not spam reconnect errors; storage stays in each context.
    await a.goto('about:blank');
    await b.goto('about:blank');
    await sleep(1000);
    await stopServer();
    log(`server stopped (exit ${server.exitCode ?? server.signalCode}); restarting on the same DATA_DIR`);
    await startServer();
    const out = [];
    for (const [page, label, prev] of [[a, 'A', state.selfA], [b, 'B', state.selfB]]) {
      await page.goto(BASE);
      const first = await Promise.race([
        page.waitForSelector('[data-testid=hud]', { timeout: T }).then(() => 'hud'),
        page.waitForSelector('[data-testid=onboarding]', { timeout: T }).then(() => 'onboarding'),
      ]);
      assert(first === 'hud', `${label}: onboarding shown after restart`);
      const s = await waitSnap(page, (x) => x.connection === 'connected' && x.world?.self, `${label} rejoined`, 90_000);
      assert(s.world.self.profileId === prev.profileId, `${label} profile ${s.world.self.profileId} != ${prev.profileId}`);
      assert(s.world.self.name === prev.name, `${label} name ${s.world.self.name} != ${prev.name}`);
      assert(JSON.stringify(s.world.self.appearance) === JSON.stringify(prev.appearance), `${label} appearance changed`);
      await waitSnap(page, (x) => x.world.fountainStage === state.fountainStage, `${label} fountain stage ${state.fountainStage}`, 20_000);
      out.push(`${label} ${prev.name} same profile + appearance`);
    }
    await waitCount(a, 2);
    await a.click('[data-testid=nav-gazette]');
    await a.waitForSelector('[data-testid=gazette-issue] .article__headline', { timeout: 20_000 });
    const headline = await a.textContent('[data-testid=gazette-issue] .article__headline');
    assert(!state.headline || headline.trim() === state.headline.trim(), `gazette lead after restart "${headline}" != "${state.headline}"`);
    await shot(a, 'desktop-15-gazette-after-restart');
    await a.click('[data-testid=panel-gazette] [role=radio]:has-text("Town history")');
    await a.waitForSelector('[data-testid=memory-timeline] .event', { timeout: 20_000 });
    const after = await a.$$eval('[data-testid=memory-timeline] .event__text', (els) => els.map((e) => e.textContent));
    const missing = state.historyBefore.filter((t) => !after.includes(t));
    assert(missing.length === 0, `history lost after restart: ${JSON.stringify(missing.slice(0, 3))}`);
    await closeOverlays(a);
    await b.click('[data-testid=nav-gazette]');
    await b.waitForSelector('[data-testid=gazette-issue] .article__headline', { timeout: 20_000 });
    await shot(b, 'phone-15-gazette-after-restart');
    await closeOverlays(b);
    return `${out.join('; ')}; fountain stage ${state.fountainStage}; ${state.historyBefore.length} history entries all still present (${after.length} now); Gazette No. ${state.issueNumber} readable on both`;
  });

  // --- 1b. count drops ---------------------------------------------------------
  await check('1b. player count drops to 1 when one client leaves', async () => {
    await b.close({ runBeforeUnload: true });
    const c = await waitCount(a, 1, 45_000);
    await shot(a, 'desktop-16-alone');
    return `A's top bar shows ${c} after B closed its tab`;
  });
} catch (err) {
  record('run aborted', false, String(err?.stack ?? err));
} finally {
  await browser.close().catch(() => undefined);
  await stopServer();
}

// --- 11. errors --------------------------------------------------------------
record('11. zero console errors and zero page errors on both clients', pageErrors.length === 0, pageErrors.length ? pageErrors.slice(0, 10).join(' | ') : 'none (no filtering applied)');

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exitCode = failed.length ? 1 : 0;
