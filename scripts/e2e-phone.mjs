#!/usr/bin/env node
/**
 * A phone that shows the world, end to end: two real browsers against the
 * REAL production build, through the real UI.
 *
 *   npm run build && npm run e2e:phone
 *
 * Own production server (scripts/lib/server.mjs; PORT $PHONE_PORT or 2642,
 * fresh DATA_DIR unless $PHONE_DATA_DIR; ADMIN_TOKEN set so the report check
 * can read the server's report list). Client A: desktop 1440x900 (mouse +
 * keyboard). Client B: Pixel 7 emulation rotated to 915x412 landscape (touch;
 * the CDP touch drags arrive as touch pointer events), later 390x844 portrait.
 * Low graphics (headless WebGL is software-rendered).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass). They run in the
 * order 1, 2, 4, 5, 3, 6 … 11 (check 3's second half needs B inside the Café):
 *  1. B enters build mode in landscape: the strip is collapsed; it covers ≤ 20% of the viewport area and ≤ 25% of its height
 *  2. B builds a hut entirely through the collapsed strip by touch (floor, three walls + doorway, a house roof from the roof
 *     tool, a garden wall with a second-storey wall on it via the storey control, a signpost with words); A sees the same pieces
 *  3. B taps a free ground spot with the strip open: the ghost lands within 0.5 m of the tapped world point (solved independently
 *     from the published camera); with build mode off and the piano peeking, tap-to-move reaches within 0.6 m (server position)
 *  4. B selects A's piece: Report is reachable from the strip and sends (server acknowledges; the report is in the admin list)
 *  5. joystick, camera buttons and the strip / dock controls do not overlap (elementFromPoint at each centre) at 915x412, 844x390, 390x844
 *  6. B (portrait 390x844) opens the piano in peek: ≤ 40% of the height; B and the piano on screen in the uncovered part within 1 s
 *  7. B plays three notes; A (in the Café) receives them
 *  8. the drag handle takes the piano to full and back to peek; ✕ and Esc close it and the camera eases back (no jump)
 *  9. B opens the notice board in peek, starts writing: the sheet goes full; the pinned notice shows on A
 * 10. desktop A's dock and piano sheet rects equal the before values (docs/screenshots/phone/before.json)
 * 11. zero console / page errors on both pages
 *
 * PHONE_MODE=before: measure only (dock and piano coverage at 844x390 / 915x412 / 390x844, desktop rects) and write
 * docs/screenshots/phone/before.json + before-*.jpg — run once on the build before the phone layout change.
 *
 * Env: PHONE_PORT, PHONE_DATA_DIR, PHONE_SHOTS (screenshot dir, default docs/screenshots/phone; 0 = none),
 * PHONE_CLIENT_DIST (serve another client build), PHONE_VERBOSE=1, E2E_RESULT (result file).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { CONFIG, PIECES, getInteractable, getInterior, groundHeight, interiorAnchor, interiorAt, isWalkable } from '@elsewhere/shared';
import { aimGhost, assert, buildState, choosePiece, hopToward, openBuild, placeHere, press, query, rotateTo, screenOf, sleep, snap, waitSnap, zoomOut } from './lib/browser.mjs';
import { closePanel, coverage, groundUnder, hopInto, pct, rectOf, screenOfView, touchDrag, useThing } from './lib/phone.mjs';
import { ROOT, createServer } from './lib/server.mjs';
import { resultFile } from './lib/report.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const MODE = process.env.PHONE_MODE === 'before' ? 'before' : 'after';
const PORT = Number(process.env.PHONE_PORT ?? 2642);
const SHOTS = process.env.PHONE_SHOTS === '0' ? null : path.resolve(ROOT, process.env.PHONE_SHOTS ?? 'docs/screenshots/phone');
const BEFORE_FILE = path.join(ROOT, 'docs/screenshots/phone/before.json');
const ADMIN_TOKEN = `phone-admin-${Math.random().toString(36).slice(2, 14)}`;
const LAND = { width: 915, height: 412 };
const PORTRAIT = { width: 390, height: 844 };
const HUT = { x: -21, z: 6 };
const GARDEN = { kind: 'wall', x: HUT.x + 3, z: HUT.z, rot: 1 };
const SIGN = { kind: 'sign', x: -23.5, z: 8.5, rot: 0, text: 'Little hut' };
const A_WALL = { kind: 'wall', x: -15, z: 6, rot: 1 };
const NOTICE = `Phone notice ${Date.now() % 10000}`;

const log = (...a) => console.log('[phone]', ...a);
const pageErrors = [];
const rec = resultFile('phone', () => pageErrors);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  rec.add(name, ok, detail);
  console.log(`[phone] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
let a;
let b;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
  } catch (err) {
    record(name, false, String(err?.message ?? err));
  }
}

const env = { ADMIN_TOKEN, ...(process.env.PHONE_CLIENT_DIST ? { CLIENT_DIST: path.resolve(process.env.PHONE_CLIENT_DIST) } : {}) };
const server = createServer({ port: PORT, env, ...(process.env.PHONE_DATA_DIR ? { dataDir: process.env.PHONE_DATA_DIR } : {}), label: 'phone', verbose: !!process.env.PHONE_VERBOSE, tmpPrefix: 'elsewhere-phone-' });
const BASE = server.url;

function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${label} console.error: ${m.text()}`);
  });
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${MODE}-${name}.jpg`), type: 'jpeg', quality: 80 }).catch((e) => log('screenshot failed', name, e.message));
}
const layoutOf = (page) => page.evaluate(() => document.querySelector('[data-testid=build-dock]')?.getAttribute('data-layout') ?? null);
const shiftOf = async (page) => (await snap(page))?.cameraShift ?? null;
const tap = (page, sel) => page.locator(sel).first().tap();
/** Wait until the focus shift has settled on its target (or there is none). */
async function shiftSettled(page, timeout = 15_000) {
  return waitSnap(page, (s) => !s.cameraShift || (Math.abs(s.cameraShift.shift.x - s.cameraShift.target.x) < 0.5 && Math.abs(s.cameraShift.shift.y - s.cameraShift.target.y) < 0.5), 'focus shift settled', timeout);
}

// --- B's strip helpers (touch, the collapsed strip only) ---------------------
async function stripChoose(page, kind) {
  if ((await layoutOf(page)) !== 'strip-palette') await tap(page, '[data-testid=build-chip]');
  await page.waitForSelector('[data-testid=build-palette-overlay]', { timeout: 10_000 });
  await tap(page, `[data-testid=build-tab-${PIECES[kind].category}]`);
  await tap(page, `[data-testid=build-piece-${kind}]`);
  await waitSnap(page, (s) => s.build?.kind === kind && s.build.mode === 'place', `piece ${kind} chosen`, 10_000);
  await waitFor(async () => (await layoutOf(page)) === 'strip' || `layout ${await layoutOf(page)}`, 'strip collapses after the pick', 10_000);
}
async function waitFor(fn, label, timeout = 20_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn().catch((e) => `error ${e.message}`);
    if (last === true) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (${JSON.stringify(last)})`);
}
/** Aim (tap) and place through the strip's Place button; a bush in the way is cleared from the status offer. */
async function stripPlace(page, x, z, y, { level } = {}) {
  let g = await aimGhost(page, x, z, y, { level });
  if (!g.build.ghost.ok && g.build.ghost.natureId) {
    const nat = g.build.ghost.natureId;
    await tap(page, '[data-testid=build-clear-offer]');
    await waitSnap(page, (s) => s.build.cleared.includes(nat), `cleared ${nat}`, 15_000);
    g = await aimGhost(page, x, z, y, { level });
  }
  assert(g.build.ghost.ok, `ghost refused at (${x}, ${z}) level ${level}: ${g.build.ghost.message}`);
  const before = new Set(g.build.pieces.map((p) => p.id));
  const ok0 = g.build.stats.results.ok;
  await tap(page, '[data-testid=build-place]');
  const s1 = await waitSnap(page, (s) => s.build.stats.results.ok > ok0, 'server confirmed the piece', 20_000);
  const added = s1.build.pieces.filter((p) => !before.has(p.id));
  assert(added.length === 1, `expected one new piece, got ${added.length}`);
  return added[0];
}
async function stripRotateTo(page, rot) {
  for (let i = 0; i < 4; i++) {
    const st = await buildState(page);
    if (st.rot === rot) return;
    await tap(page, '[data-testid=build-rotate]');
    await waitSnap(page, (s) => s.build?.rot !== st.rot, 'rotated', 10_000);
  }
  throw new Error(`could not rotate to ${rot}`);
}
async function menu(page, open) {
  const isOpen = !!(await page.$('[data-testid=build-menu]'));
  if (isOpen !== open) await tap(page, '[data-testid=build-more]');
  if (open) await page.waitForSelector('[data-testid=build-menu]', { timeout: 5000 });
}

/** In-page hit test: each control's centre must hit the control itself. */
async function hitTest(page, sels) {
  return page.evaluate((sels) => {
    const out = { ok: [], bad: [], missing: [] };
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)];
      if (!els.length) {
        out.missing.push(sel);
        continue;
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        const name = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? sel;
        if (hit && (hit === el || el.contains(hit))) out.ok.push(name);
        else out.bad.push(`${name} @${Math.round(cx)},${Math.round(cy)} hit ${hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? hit?.className?.toString().slice(0, 30) ?? hit?.tagName}`);
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.bad.push(`${name} off screen`);
      }
    }
    return out;
  }, sels);
}

async function join(page) {
  await page.goto(`${BASE}/?autojoin=1`);
  return waitSnap(page, (s) => s.local?.ready && s.build?.synced && s.navReady, 'joined', 120_000);
}

// --- run ----------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`mode ${MODE}; server ${BASE}; data dir ${server.dataDir}${env.CLIENT_DIST ? `; client ${env.CLIENT_DIST}` : ''}`);
await server.start();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ ...devices['Pixel 7'], viewport: LAND, screen: LAND });
await ctxA.addInitScript(LOW_GFX);
await ctxB.addInitScript(LOW_GFX);
a = await ctxA.newPage();
b = await ctxB.newPage();
b.__touch = true;
watch(a, 'A(desktop)');
watch(b, 'B(phone)');

const measured = {};
let desktopDock = null;
let desktopPiano = null;
let idA = '';
let idB = '';
let check3a = null;

async function desktopDockRects() {
  await openBuild(a);
  await a.mouse.move(2, 2);
  await sleep(800);
  const r = { dock: await rectOf(a, '[data-testid=build-dock]'), panel: await rectOf(a, '[data-testid=build-dock] .build-panel') };
  await press(a, '[data-testid=build-done]');
  await waitSnap(a, (s) => s.build?.mode === 'off', 'A build off', 15_000);
  return r;
}
async function measureDock(page, tag) {
  await page.setViewportSize(tag === '390x844' ? PORTRAIT : tag === '844x390' ? { width: 844, height: 390 } : LAND);
  await sleep(1500);
  const c = await coverage(page, 'dock');
  measured[`dock ${tag}${(await layoutOf(page)) === 'strip' ? ' (strip)' : ' (palette open)'}`] = { area: pct(c.areaShare), height: pct(c.heightShare), rects: c.rects };
  return c;
}

try {
  await Promise.all([join(a), join(b)]);
  idA = (await snap(a)).sessionId;
  idB = (await snap(b)).sessionId;
  log(`A=${idA} B=${idB}`);
  desktopDock = await desktopDockRects();

  if (MODE === 'before') {
    // ----------------------------------------------------------------- before
    await openBuild(b);
    for (const tag of ['844x390', '915x412', '390x844']) {
      await measureDock(b, tag);
      if (tag !== '915x412') await shot(b, `build-${tag}`);
    }
    await press(b, '[data-testid=build-done]');
    await waitSnap(b, (s) => s.build?.mode === 'off', 'B build off', 15_000);
    await b.setViewportSize(PORTRAIT);
    const piano = getInteractable('station_cafe_piano');
    await Promise.all([useThing(a, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'piano').position }), useThing(b, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'stage').position })]);
    await sleep(1500);
    desktopPiano = await rectOf(a, '[data-testid=panel-piano]');
    for (const [tag, vp] of [['390x844', PORTRAIT], ['844x390', { width: 844, height: 390 }]]) {
      await b.setViewportSize(vp);
      await sleep(1800);
      const c = await coverage(b, '[data-testid=panel-piano]');
      measured[`piano ${tag}`] = { area: pct(c.areaShare), height: pct(c.heightShare), rects: c.rects };
      await shot(b, `piano-${tag}`);
    }
    const out = { measuredAt: new Date().toISOString(), note: 'phone layout before the strip / peek change (scripts/e2e-phone.mjs PHONE_MODE=before)', desktop: { ...desktopDock, piano: desktopPiano }, coverage: measured, piano: piano.position };
    log(JSON.stringify(out, null, 2));
    mkdirSync(path.dirname(BEFORE_FILE), { recursive: true });
    writeFileSync(BEFORE_FILE, `${JSON.stringify(out, null, 2)}\n`);
    record('before: measurements written', true, BEFORE_FILE);
  } else {
    // ------------------------------------------------------------------ after
    // A builds one wall near B's hut through the desktop UI (for the report check).
    await hopToward(a, { x: A_WALL.x - 1.5, z: A_WALL.z + 2.5 }, 1.2, 240_000);
    await zoomOut(a, 1);
    await openBuild(a);
    await choosePiece(a, 'wall', { category: 'structure' });
    await rotateTo(a, A_WALL.rot, { key: true });
    const aWall = await placeHere(a, A_WALL.x, A_WALL.z, undefined, { level: 0 });
    await press(a, '[data-testid=build-done]');
    await waitSnap(a, (s) => s.build?.mode === 'off', 'A build off', 15_000);
    await hopToward(b, { x: HUT.x + 0.5, z: HUT.z + 3.4 }, 1.0, 300_000);

    await check('1. B enters build mode in landscape: the strip is collapsed; ≤ 20% of the viewport area and ≤ 25% of its height', async () => {
      await tap(b, '[data-testid=nav-build]');
      await b.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
      await waitSnap(b, (s) => s.build?.synced && s.build.mode === 'place', 'B build on', 20_000);
      await waitFor(async () => (await layoutOf(b)) === 'strip' || `layout ${await layoutOf(b)}`, 'collapsed strip', 10_000);
      await sleep(800);
      const c = await coverage(b, 'dock');
      measured['strip 915x412'] = { area: pct(c.areaShare), height: pct(c.heightShare), rects: c.rects };
      const sh = (await shiftSettled(b)).cameraShift;
      await shot(b, 'landscape-build-collapsed');
      assert(c.areaShare <= 0.2 && c.heightShare <= 0.25, `strip covers ${pct(c.areaShare)} of the area, ${pct(c.heightShare)} of the height`);
      assert(sh && Math.abs(sh.target.y) > 10, `no focus shift while the strip covers the bottom: ${JSON.stringify(sh)}`);
      // the same at 844x390, and the palette opened from the chip (recorded)
      await b.setViewportSize({ width: 844, height: 390 });
      await sleep(1500);
      const c2 = await coverage(b, 'dock');
      measured['strip 844x390'] = { area: pct(c2.areaShare), height: pct(c2.heightShare) };
      assert(c2.areaShare <= 0.2 && c2.heightShare <= 0.25, `at 844x390 the strip covers ${pct(c2.areaShare)} / ${pct(c2.heightShare)}`);
      await tap(b, '[data-testid=build-chip]');
      await b.waitForSelector('[data-testid=build-palette-overlay]', { timeout: 10_000 });
      await sleep(900);
      const c3 = await coverage(b, 'dock');
      measured['strip + palette 844x390'] = { area: pct(c3.areaShare), height: pct(c3.heightShare) };
      await shot(b, 'landscape-build-palette');
      await tap(b, '[data-testid=build-palette-close]');
      await waitFor(async () => (await layoutOf(b)) === 'strip' || 'open', 'palette closed', 10_000);
      await b.setViewportSize(LAND);
      await sleep(1200);
      return `915x412 strip: area ${pct(c.areaShare)}, height ${pct(c.heightShare)} (shift ${JSON.stringify(sh.target)}); 844x390: ${pct(c2.areaShare)} / ${pct(c2.heightShare)}; palette open 844x390: ${pct(c3.areaShare)} / ${pct(c3.heightShare)}`;
    });

    await check('2. B builds a hut through the collapsed strip by touch (floor, 3 walls + doorway, house roof, a second-storey wall via the storey control, a signpost with words); A sees the same pieces', async () => {
      const mine = [];
      await stripChoose(b, 'floor');
      mine.push(await stripPlace(b, HUT.x, HUT.z, undefined, { level: 0 }));
      await stripChoose(b, 'wall');
      for (const w of [{ x: HUT.x, z: HUT.z - 1, rot: 0 }, { x: HUT.x - 1, z: HUT.z, rot: 1 }, { x: HUT.x + 1, z: HUT.z, rot: 1 }]) {
        await stripRotateTo(b, w.rot);
        mine.push(await stripPlace(b, w.x, w.z, undefined, { level: 0 }));
      }
      await stripChoose(b, 'doorway');
      await stripRotateTo(b, 0);
      mine.push(await stripPlace(b, HUT.x, HUT.z + 1, undefined, { level: 0 }));
      // House roof from the roof tool: tap the hut's wall tops → whole-roof ghost → Place.
      await stripChoose(b, 'house_roof');
      let st = await buildState(b);
      const top = Math.max(...st.pieces.filter((p) => p.level === 0 && PIECES[p.kind].structural && Math.abs(p.x - HUT.x) <= 1 && Math.abs(p.z - HUT.z) <= 1).map((p) => p.y)) + CONFIG.building.storeyHeight;
      const roof = await stripPlace(b, HUT.x, HUT.z, top, { level: 1 });
      assert(roof.kind === 'house_roof' && roof.params, `roof ${JSON.stringify(roof)}`);
      mine.push(roof);
      // A garden wall, then a wall on top of it with the storey control (··· → ▲ → "Storey 2", locked).
      await stripChoose(b, 'wall');
      await stripRotateTo(b, GARDEN.rot);
      const garden = await stripPlace(b, GARDEN.x, GARDEN.z, undefined, { level: 0 });
      mine.push(garden);
      await menu(b, true);
      await tap(b, '[data-testid=build-storey-up]');
      await waitFor(async () => (await b.getAttribute('[data-testid=build-storey]', 'data-lock')) === '1' || `lock ${await b.getAttribute('[data-testid=build-storey]', 'data-lock')}`, 'storey 2 locked', 10_000);
      const label = await b.textContent('[data-testid=build-storey-label] .build-storey__n');
      await menu(b, false);
      const upper = await stripPlace(b, GARDEN.x, GARDEN.z, garden.y + CONFIG.building.storeyHeight, { level: 1 });
      assert(upper.level === 1 && upper.x === GARDEN.x && upper.z === GARDEN.z, `upper wall ${JSON.stringify(upper)}`);
      mine.push(upper);
      // With the lock still set, the house-roof tool must not claim it (roofs sit on the walls they cover) …
      const hintOf = () => b.evaluate(() => {
        const l = document.querySelector('[data-testid=build-storey-label]');
        return { hint: l?.querySelector('.build-storey__hint')?.textContent ?? '', locked: !!l?.classList.contains('is-locked'), lock: document.querySelector('[data-testid=build-storey]')?.getAttribute('data-lock') };
      });
      await stripChoose(b, 'house_roof');
      await menu(b, true);
      const onRoof = await hintOf();
      await menu(b, false);
      assert(onRoof.lock === '1' && !onRoof.locked && !/locked/i.test(onRoof.hint), `roof tool shows the storey lock: ${JSON.stringify(onRoof)}`);
      // … and another piece shows it again.
      await stripChoose(b, 'wall');
      await menu(b, true);
      const onWall = await hintOf();
      assert(onWall.locked && /locked/i.test(onWall.hint), `the lock is not shown again for a wall: ${JSON.stringify(onWall)}`);
      await tap(b, '[data-testid=build-storey-label]'); // back to automatic
      await waitFor(async () => (await b.getAttribute('[data-testid=build-storey]', 'data-lock')) === 'auto' || 'locked', 'storey auto', 10_000);
      await menu(b, false);
      // A signpost with words typed into the strip.
      await stripChoose(b, 'sign');
      await b.locator('[data-testid=build-sign-text]').tap();
      await b.fill('[data-testid=build-sign-text]', SIGN.text);
      await b.evaluate(() => document.activeElement?.blur());
      const sign = await stripPlace(b, SIGN.x, SIGN.z, undefined, { level: 0 });
      assert(sign.text === SIGN.text, `sign text ${JSON.stringify(sign.text)}`);
      mine.push(sign);
      st = await buildState(b);
      assert((await layoutOf(b)) === 'strip', 'the strip did not stay collapsed');
      await shot(b, 'landscape-hut-built');
      const sa = await waitSnap(a, (s) => mine.every((m) => s.build.pieces.some((p) => p.id === m.id)), 'A sees every piece of B', 30_000);
      for (const m of mine) {
        const p = sa.build.pieces.find((q) => q.id === m.id);
        assert(p.kind === m.kind && p.x === m.x && p.z === m.z && p.level === m.level && p.rot === m.rot && (p.text ?? '') === (m.text ?? '') && (p.params ?? '') === (m.params ?? ''), `A sees ${JSON.stringify(p)} for ${JSON.stringify(m)}`);
      }
      return `${mine.length} pieces (${mine.map((m) => `${m.kind}${m.level ? `@${m.level}` : ''}`).join(', ')}); storey control said "${label?.trim()}"; with the roof tool it said "${onRoof.hint}" (not locked), for a wall "${onWall.hint}" again; identical on A`;
    });

    // Check 3, first half (B is here with the strip open).
    try {
      await stripChoose(b, 'sign');
      await shiftSettled(b);
      const s0 = await snap(b);
      const sh = s0.cameraShift;
      assert(sh && Math.hypot(sh.shift.x, sh.shift.y) > 10, `focus shift not active: ${JSON.stringify(sh)}`);
      const W = LAND.width;
      const H = LAND.height;
      const free = sh.free;
      let pt = null;
      let world = null;
      for (const [ox, oy] of [[150, 20], [-150, 20], [150, -40], [-150, -40], [80, 60], [-80, 60]]) {
        const x = (free.left + free.right) / 2 + ox;
        const y = (free.top + free.bottom) / 2 + oy;
        const g = groundUnder(s0.view, W, H, x, y);
        if (isWalkable(g, 0.5) && Math.hypot(g.x - SIGN.x, g.z - SIGN.z) > 1.5 && (await query(b, 'pick', x, y, 'touch')) === null && (await b.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]))) {
          pt = { x, y };
          world = g;
          break;
        }
      }
      assert(pt, 'no free ground spot in the uncovered part');
      // The published view is the camera the player sees: three.js projection of that world point = our solve.
      const proj = await query(b, 'worldToScreen', world.x, world.z);
      const mine = screenOfView(s0.view, W, H, world.x, groundHeight(world.x, world.z), world.z);
      await b.touchscreen.tap(pt.x, pt.y);
      const g = await waitSnap(b, (s) => s.build?.ghost && Math.hypot(s.build.ghost.x - world.x, s.build.ghost.z - world.z) < 0.9, 'ghost near the tapped point', 15_000);
      const err = Math.hypot(g.build.ghost.x - world.x, g.build.ghost.z - world.z);
      assert(err <= 0.5, `ghost ${err.toFixed(2)} m from the tapped point`);
      const projErr = Math.hypot(proj.x - pt.x, proj.y - pt.y);
      assert(projErr < 3, `three.js projection of the solved point is ${projErr.toFixed(1)} px off the tap`);
      check3a = `ghost ${err.toFixed(2)} m from the tapped world point (${world.x.toFixed(2)}, ${world.z.toFixed(2)}) with the focus shifted by (${sh.shift.x}, ${sh.shift.y}) px; projection agrees within ${projErr.toFixed(1)} px (plane solve ${Math.hypot(mine.x - pt.x, mine.y - pt.y).toFixed(1)} px)`;
    } catch (err) {
      check3a = new Error(`strip half: ${err.message}`);
    }

    await check('4. B selects A’s piece: Report is reachable from the strip and sends (server acknowledges)', async () => {
      await menu(b, true);
      await tap(b, '[data-testid=build-tool-remove]');
      await waitSnap(b, (s) => s.build.mode === 'remove', 'remove tool', 10_000);
      const p = await screenOf(b, aWall.x, aWall.z, aWall.y + 1.2);
      await b.touchscreen.tap(p.x, p.y);
      await b.waitForSelector('[data-testid=build-selected][data-owner=other]', { timeout: 15_000 });
      await shot(b, 'landscape-report-card');
      await tap(b, '[data-testid=build-report]');
      await waitFor(async () => (await b.evaluate(() => [...document.querySelectorAll('[role=status], .toast, [data-testid^=toast]')].some((e) => /report about/i.test(e.textContent ?? '')))) || 'no ack toast', 'server ack toast', 20_000);
      const res = await fetch(`${BASE}/api/admin/reports?limit=20`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
      assert(res.ok, `admin reports ${res.status}`);
      const list = (await res.json()).reports ?? [];
      const r = list.find((x) => JSON.stringify(x).includes(aWall.id));
      assert(r, `report about ${aWall.id} not in the server list (${list.length} reports)`);
      await tap(b, '[data-testid=build-tool-remove]'); // "Back to building"
      await waitSnap(b, (s) => s.build.mode === 'place', 'back to place', 10_000);
      return `report on ${aWall.id} acknowledged; server list has it`;
    });

    await check('5. joystick, camera buttons and the strip / dock controls do not overlap at 915x412, 844x390, 390x844', async () => {
      const notes = [];
      for (const vp of [LAND, { width: 844, height: 390 }, PORTRAIT]) {
        await b.setViewportSize(vp);
        await sleep(1800);
        const portrait = vp.height > vp.width;
        const sels = ['[data-testid=joystick]', '[data-testid=cam-rotate-left]', '[data-testid=cam-rotate-right]', 'button[aria-label="Zoom in"]', 'button[aria-label="Zoom out"]', '[data-testid=build-status]', '[data-testid=build-rotate]', '[data-testid=build-undo]', '[data-testid=build-more]', '[data-testid=build-place]', '[data-testid=build-done]', ...(portrait ? ['[data-testid=build-tool-remove]', '[data-testid=build-tool-clear]', '[data-testid=build-storey-up]'] : ['[data-testid=build-chip]'])];
        const h = await hitTest(b, sels);
        await shot(b, `controls-${vp.width}x${vp.height}`);
        assert(h.bad.length === 0 && h.missing.length === 0, `${vp.width}x${vp.height}: ${[...h.bad, ...h.missing.map((m) => `missing ${m}`)].join(', ')}`);
        notes.push(`${vp.width}x${vp.height}: ${h.ok.length} controls clear`);
      }
      await b.setViewportSize(LAND);
      await sleep(1200);
      return notes.join('; ');
    });

    await tap(b, '[data-testid=build-done]');
    await waitSnap(b, (s) => s.build?.mode === 'off', 'B build off', 15_000);
    const aToCafe = useThing(a, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'piano').position });
    await hopInto(b, interiorAnchor('cafe', 'stage').position, 1.4);

    await check('3. B taps free ground with the strip open: ghost within 0.5 m of the tapped world point; with build off and the piano peeking, tap-to-move reaches within 0.6 m', async () => {
      if (check3a instanceof Error) throw check3a;
      await useThing(b, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'stage').position });
      await b.waitForSelector('[data-testid=panel-piano][data-view=peek]', { timeout: 10_000 });
      const s0 = await shiftSettled(b);
      await shot(b, 'landscape-piano-peek');
      const c = await coverage(b, '[data-testid=panel-piano]');
      measured['piano peek 915x412'] = { area: pct(c.areaShare), height: pct(c.heightShare) };
      const free = s0.cameraShift.free;
      assert(free, 'no free rect while the piano peeks');
      const cafe = getInterior('cafe');
      let pt = null;
      let world = null;
      // scan the uncovered part on a 30 px grid, nearest the free rect's centre first
      const cands = [];
      for (let x = free.left + 30; x < free.right - 30; x += 30) for (let y = free.top + 20; y < free.bottom - 10; y += 30) cands.push({ x, y });
      const fc = { x: (free.left + free.right) / 2, y: (free.top + free.bottom) / 2 };
      cands.sort((p, q) => Math.hypot(p.x - fc.x, p.y - fc.y) - Math.hypot(q.x - fc.x, q.y - fc.y));
      // one page round trip for the whole grid (ground under each point, nothing pickable there, the canvas on top)
      const probed = await b.evaluate((cands) => cands.map(({ x, y }) => ({ x, y, g: window.__ELSEWHERE__.query('groundFromScreen', x, y), pick: window.__ELSEWHERE__.query('pick', x, y, 'touch'), canvas: document.elementFromPoint(x, y)?.tagName === 'CANVAS' })), cands);
      const me = s0.local;
      for (const c of probed) {
        const g = c.g;
        const d = g ? Math.hypot(g.x - me.x, g.z - me.z) : 0;
        // a spot on the café floor (with the cutaway open the ground outside the walls is visible too)
        if (g && !c.pick && c.canvas && interiorAt(g)?.id === 'cafe' && isWalkable(g, 0.45) && d > 1 && d < 3.5) {
          pt = { x: c.x, y: c.y };
          world = g;
          break;
        }
      }
      assert(pt, `no free café floor in the uncovered part (free ${JSON.stringify(free)}, cafe floor ${cafe.floorY})`);
      await b.touchscreen.tap(pt.x, pt.y);
      // the walk starts (a path or movement), then ends with the server caught up
      await waitSnap(b, (s) => !!s.motion?.path || s.local.speed > 0.05 || Math.hypot(s.local.x - world.x, s.local.z - world.z) < 0.6, 'walk started', 10_000).catch(() => undefined);
      const s1 = await waitSnap(b, (s) => {
        const sp = s.players.find((p) => p.id === idB);
        return !s.motion?.path && s.local.speed < 0.05 && sp && Math.hypot(sp.x - s.local.x, sp.z - s.local.z) < 0.15;
      }, 'walk finished', 30_000);
      const srv = s1.players.find((p) => p.id === idB);
      const d = Math.hypot(srv.x - world.x, srv.z - world.z);
      assert(d <= 0.6, `server position (${srv.x.toFixed(2)}, ${srv.z.toFixed(2)}) is ${d.toFixed(2)} m from the tapped point (${world.x.toFixed(2)}, ${world.z.toFixed(2)}); start (${s0.local.x.toFixed(2)}, ${s0.local.z.toFixed(2)}), local now (${s1.local.x.toFixed(2)}, ${s1.local.z.toFixed(2)}), tap ${JSON.stringify(pt)}`);
      assert(s1.ui?.panel, 'the piano closed on the tap');
      return `${check3a}; piano peeking (${pct(c.heightShare)} of the height): walked to within ${d.toFixed(2)} m (server)`;
    });

    await aToCafe.catch((e) => log('A to the café:', e.message));
    await sleep(1000);
    desktopPiano = await rectOf(a, '[data-testid=panel-piano]');
    await shot(a, 'desktop-piano');
    await a.keyboard.press('Escape');

    await check('6. B (portrait 390x844) opens the piano in peek: ≤ 40% of the height; B and the piano are in the uncovered part within 1 s', async () => {
      await closePanel(b);
      await b.setViewportSize(PORTRAIT);
      await sleep(1800);
      const piano = getInteractable('station_cafe_piano');
      const fy = getInterior('cafe').floorY ?? 0;
      // Timer starts in the page when the sheet appears; it polls the projected positions every 40 ms.
      const timing = b.evaluate(([px, pz, fy]) => new Promise((resolve) => {
        const t0 = performance.now();
        let seenAt = 0;
        let samples = 0;
        const tick = () => {
          const sheet = document.querySelector('[data-testid=panel-piano]');
          if (sheet && !seenAt) seenAt = performance.now();
          if (sheet) {
            samples++;
            const r = sheet.getBoundingClientRect();
            const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
            const s = window.__ELSEWHERE__.snapshot();
            const me = window.__ELSEWHERE__.query('worldToScreen', s.local.x, s.local.z, fy + 0.9); // the character's middle (snapshot().local has no height; B stands on the café floor)
            const pi = window.__ELSEWHERE__.query('worldToScreen', px, pz, fy + 0.9);
            const inside = (p) => p && p.x > 8 && p.x < innerWidth - 8 && p.y > top + 4 && p.y < r.top - 4;
            if (inside(me) && inside(pi)) return resolve({ ms: Math.round(performance.now() - seenAt), samples, me, pi, sheetTop: Math.round(r.top), top: Math.round(top) });
            if (performance.now() - seenAt > 4000) return resolve({ ms: -1, samples, me, pi, sheetTop: Math.round(r.top), top: Math.round(top) });
          }
          if (performance.now() - t0 > 400_000) return resolve({ ms: -2 });
          setTimeout(tick, 40);
        };
        tick();
      }), [piano.position.x, piano.position.z, fy]);
      await useThing(b, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'stage').position });
      const t = await timing;
      if (!(await b.waitForSelector('[data-testid=panel-piano][data-view=peek]', { timeout: 10_000 }).catch(() => null))) {
        const st = await b.evaluate(() => ({ vp: [innerWidth, innerHeight], sheets: [...document.querySelectorAll('.sheet')].map((e) => ({ id: e.getAttribute('data-testid'), view: e.getAttribute('data-view'), cls: e.className })), phone: matchMedia('(max-width: 720px), (max-height: 500px) and (orientation: landscape)').matches, active: document.activeElement?.tagName }));
        await shot(b, 'fail-6-not-peeking');
        throw new Error(`the piano is not peeking: ${JSON.stringify(st)}; timing ${JSON.stringify(t)}`);
      }
      await shiftSettled(b);
      await shot(b, 'portrait-piano-peek');
      const c = await coverage(b, '[data-testid=panel-piano]');
      measured['piano peek 390x844'] = { area: pct(c.areaShare), height: pct(c.heightShare) };
      const keys = await b.evaluate(() => [...document.querySelectorAll('.piano__key--white')].map((k) => Math.round(k.getBoundingClientRect().width * 10) / 10));
      assert(c.heightShare <= 0.4, `piano peek covers ${pct(c.heightShare)} of the height`);
      assert(Math.min(...keys) >= 44, `white keys ${Math.min(...keys)} px wide`);
      assert(t.ms >= 0 && t.ms <= 1000, `B / the piano not in the uncovered part within 1 s: ${JSON.stringify(t)}`);
      return `peek ${pct(c.heightShare)} of the height (${pct(c.areaShare)} of the area); white keys ≥ ${Math.min(...keys)} px; B and the piano uncovered ${t.ms} ms after the sheet appeared (${t.samples} samples)`;
    });

    await check('7. B plays three notes; A (in the Café) receives them', async () => {
      const n0 = (await snap(a)).activities.sound.pianoNotes;
      for (const n of [0, 4, 7]) {
        await b.locator(`[data-testid=piano-keys] [data-note="${n}"]`).tap();
        await sleep(350);
      }
      await waitFor(async () => (await snap(a)).activities.sound.pianoNotes >= n0 + 3 || `A has ${(await snap(a)).activities.sound.pianoNotes - n0}`, 'A received 3 notes', 20_000);
      return `A received ${(await snap(a)).activities.sound.pianoNotes - n0} notes`;
    });

    await check('8. the drag handle takes the piano to full and back to peek; ✕ and Esc close it and the camera eases back', async () => {
      const h = await rectOf(b, '[data-testid=sheet-handle]');
      assert(h && h.w >= 44 && h.h >= 44, `handle ${JSON.stringify(h)}`);
      await touchDrag(b, h.x + h.w / 2, h.y + h.h / 2, 0, -160);
      await b.waitForSelector('[data-testid=panel-piano][data-view=full]', { timeout: 10_000 });
      await sleep(800);
      const full = await coverage(b, '[data-testid=panel-piano]');
      await shot(b, 'portrait-piano-full');
      const h2 = await rectOf(b, '[data-testid=sheet-handle]');
      await touchDrag(b, h2.x + h2.w / 2, h2.y + h2.h / 2, 0, 120);
      await b.waitForSelector('[data-testid=panel-piano][data-view=peek]', { timeout: 10_000 });
      const peeking = await shiftSettled(b);
      // ✕: the shift eases back to zero (frame-by-frame samples, no jump).
      const samples = b.evaluate(() => new Promise((resolve) => {
        const out = [];
        const t0 = performance.now();
        const f = () => {
          const s = window.__ELSEWHERE__.snapshot().cameraShift;
          const v = Math.hypot(s.shift.x, s.shift.y);
          out.push(v);
          // until it is back at zero after the panel closed (or 20 s)
          if (performance.now() - t0 < 20_000 && !(v < 0.5 && !document.querySelector('[data-testid=panel-piano]'))) requestAnimationFrame(f);
          else resolve(out);
        };
        f();
      }));
      await sleep(150);
      await tap(b, '[data-testid=sheet-close]');
      const v = await samples;
      await waitSnap(b, (s) => !s.ui?.panel, 'piano closed', 10_000);
      const start = Math.hypot(peeking.cameraShift.shift.x, peeking.cameraShift.shift.y);
      const mid = v.filter((x) => x > 0.5 && x < start - 0.5);
      assert(v[v.length - 1] < 0.5, `shift did not ease back: ${v.slice(-3).map((x) => x.toFixed(1))}`);
      assert(mid.length >= 1, `no intermediate frames (a jump): ${v.map((x) => x.toFixed(0)).join(',')}`);
      // Esc closes it too.
      await useThing(b, 'station_cafe_piano', { panel: 'panel-piano', approach: interiorAnchor('cafe', 'stage').position });
      await b.keyboard.press('Escape');
      await waitSnap(b, (s) => !s.ui?.panel, 'Esc closed the piano', 10_000);
      await waitSnap(b, (s) => Math.hypot(s.cameraShift.shift.x, s.cameraShift.shift.y) < 0.5, 'camera back after Esc', 10_000);
      return `full: ${pct(full.heightShare)} of the height; ✕ eased ${start.toFixed(0)} px → 0 over ${mid.length} intermediate frames; Esc closed it`;
    });

    await check('9. B opens the notice board in peek, starts writing: the sheet goes full; the pinned notice shows on A', async () => {
      await useThing(b, 'station_hall_notices', { panel: 'panel-notices', approach: interiorAnchor('town_hall', 'notice_board').position, near: 2.2, timeout: 120_000 });
      await b.waitForSelector('[data-testid=panel-notices][data-view=peek]', { timeout: 10_000 });
      await sleep(900);
      const c = await coverage(b, '[data-testid=panel-notices]');
      await shot(b, 'portrait-notices-peek');
      assert(c.heightShare <= 0.45, `notices peek covers ${pct(c.heightShare)} of the height`);
      // The input may be below the fold of the peek: scroll it into view as a finger would, then tap it.
      await b.locator('[data-testid=board-input]').scrollIntoViewIfNeeded();
      await b.locator('[data-testid=board-input]').tap();
      await b.waitForSelector('[data-testid=panel-notices][data-view=full]', { timeout: 10_000 });
      await b.fill('[data-testid=board-input]', NOTICE);
      await shot(b, 'portrait-notices-writing');
      await b.locator('[data-testid=board-submit]').tap();
      await waitSnap(a, (s) => s.activities?.notices?.some((e) => e.text === NOTICE), 'A sees the notice', 30_000);
      await closePanel(b);
      return `peek ${pct(c.heightShare)} of the height → full on typing; A sees “${NOTICE}”`;
    });

    await check('10. desktop A’s dock and piano sheet rects equal the before values', async () => {
      assert(existsSync(BEFORE_FILE), `no before values (${BEFORE_FILE}); run with PHONE_MODE=before on the unchanged build`);
      const before = JSON.parse(readFileSync(BEFORE_FILE, 'utf8')).desktop;
      const same = (x, y) => x && y && ['x', 'y', 'w', 'h'].every((k) => Math.abs(x[k] - y[k]) <= 0.5);
      assert(same(desktopDock.dock, before.dock), `dock ${JSON.stringify(desktopDock.dock)} vs before ${JSON.stringify(before.dock)}`);
      assert(same(desktopDock.panel, before.panel), `dock panel ${JSON.stringify(desktopDock.panel)} vs before ${JSON.stringify(before.panel)}`);
      assert(same(desktopPiano, before.piano), `piano ${JSON.stringify(desktopPiano)} vs before ${JSON.stringify(before.piano)}`);
      return `dock ${JSON.stringify(desktopDock.dock)}, panel ${JSON.stringify(desktopDock.panel)}, piano ${JSON.stringify(desktopPiano)} — identical`;
    });
  }

  await check('11. zero console / page errors on both pages', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  record('script', false, String(err?.stack ?? err));
} finally {
  log('coverage:', JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, { area: v.area, height: v.height }]))));
  await browser.close().catch(() => undefined);
  await server.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`[phone] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
