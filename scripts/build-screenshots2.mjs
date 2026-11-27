#!/usr/bin/env node
/**
 * Building round-2 screenshots (dev client + a scratch dev server; uses the
 * dev-only URL overrides ?cam= ?time= ?quality=).
 *
 *   PORT=2634 BUILD_RANGE=400 BUILD_RATE_CAPACITY=1000 BUILD_RATE_PER_SECOND=1000 BUILD_CLEAR_DAILY=100 \
 *     DATA_DIR=<fresh dir> npm run dev -w server   (and the Vite client)
 *   node scripts/build-screenshots2.mjs [devUrl] [serverUrl] [outDir]
 *     devUrl default http://localhost:5173, serverUrl http://localhost:2567, outDir docs/screenshots/build
 *     BUILD_SHOTS_ONLY=houses,signs,interior,ui picks sections (default: all)
 *
 * Stages showcase houses through the real server path (scripts/lib/seed.mjs:
 * a two-storey gable-roofed house with a name board, furnished, next to the
 * town's House 1; a hip-roofed cottage with a hanging sign and a chimney; an
 * L-shaped house with a cross gable and a plaque), then shoots them by day
 * and night on desktop (1440x900) and phones (390x844, 844x390), the
 * furnished interior from inside (roof dissolved), and the build UI: the
 * palette's tabs, the storey control with the stacking highlight, and the
 * "Clear bush" offer. Exits 1 on console / page errors.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PIECES } from '@elsewhere/shared';
import { builderClient } from './lib/seed.mjs';
import { BUSH_WALL, HOUSE, hipHouse, houseOrder, lHouse, twoStoreyHouse } from './lib/plans2.mjs';
import { aimGhost, choosePiece, hopToward, openBuild, press, rotateTo, screenOf, sleep, snap, waitSnap, zoomOut } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dev = process.argv[2] ?? 'http://localhost:5173';
const srv = process.argv[3] ?? 'http://localhost:2567';
const outDir = process.argv[4] ?? 'docs/screenshots/build';
mkdirSync(outDir, { recursive: true });
const ONLY = (process.env.BUILD_SHOTS_ONLY ?? 'houses,signs,interior,ui').split(',');
const DAY = 0.45;
const NIGHT = 0.93;
const HIP = { x: -4, z: 19 };
const ELL = { x: -14, z: 17 };
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const VIEWS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
  'phone-landscape': { ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 } },
};

function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label}: pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
}
async function shoot(page, name) {
  await page.screenshot({ path: `${outDir}/${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log(`[shot] ${name}`);
}
/** A page as a given profile (token) or a fresh guest. */
async function open(view, query, token) {
  const ctx = await browser.newContext(VIEWS[view]);
  if (token) await ctx.addInitScript((t) => localStorage.setItem('elsewhere.session.v1', t), token);
  const page = await ctx.newPage();
  page.__touch = view !== 'desktop';
  watch(page, `${view} ${query}`);
  await page.goto(`${dev}/?autojoin=1&${query}`);
  await waitSnap(page, (s) => s.local?.ready && s.build?.synced && s.connection === 'connected', 'joined', 120_000);
  return page;
}

// --- stage (idempotent: skipped when the house already stands) -----------------
const tokens = {};
{
  const ivy = await builderClient(srv, { name: 'Ivy' });
  tokens.ivy = ivy.token;
  const house = twoStoreyHouse(HOUSE, 'Fern Cottage');
  const refused = [];
  for (const id of ['bush_37']) await ivy.clear(id);
  for (const p of houseOrder(house)) {
    const r = await ivy.place(p);
    if (!r.ok) refused.push(`${p.kind} ${r.reason}`);
  }
  await ivy.place({ kind: 'lamp', x: HOUSE.x1 + 1.5, z: HOUSE.z1 + 1.5, variant: 'iron' });
  // A lone garden wall beside the house (where bush_37 grew): the stacking shot extends it.
  const gw = await ivy.place(BUSH_WALL);
  if (!gw.ok) refused.push(`garden wall ${gw.reason}`);
  await ivy.leave();
  const rowan = await builderClient(srv, { name: 'Rowan' });
  for (const p of hipHouse(HIP)) {
    const r = await rowan.place(p);
    if (!r.ok) refused.push(`hip ${p.kind} ${r.reason}`);
  }
  await rowan.leave();
  const hazel = await builderClient(srv, { name: 'Hazel' });
  for (const id of ['bush_59', 'bush_2']) await hazel.clear(id);
  for (const p of lHouse(ELL)) {
    const r = await hazel.place(p);
    if (!r.ok) refused.push(`L ${p.kind} ${r.reason}`);
  }
  await hazel.leave();
  console.log('[stage] refused (expected only on a re-run):', refused.length ? refused.join('; ') : 'none');
}

try {
  // --- houses, day and night, three viewports ---------------------------------
  const scenes = [
    { name: 'house-gable-vs-town', cam: [-23.5, 2.5], zoom: { desktop: 46, phone: 30, 'phone-landscape': 34 } },
    { name: 'house-hip', cam: [HIP.x, HIP.z], zoom: { desktop: 70, phone: 46, 'phone-landscape': 50 } },
    { name: 'house-L', cam: [ELL.x, ELL.z + 1.5], zoom: { desktop: 64, phone: 42, 'phone-landscape': 46 } },
  ];
  for (const s of ONLY.includes('houses') ? scenes : [])
    for (const [tod, t] of [['day', DAY], ['night', NIGHT]])
      for (const view of Object.keys(VIEWS)) {
        const page = await open(view, `time=${t}&quality=${view === 'desktop' ? 'high' : 'medium'}&cam=${s.cam[0]},${s.cam[1]},${s.zoom[view]}`);
        await page.addStyleTag({ content: '.hud > * { visibility: hidden !important; }' });
        await sleep(5000);
        await shoot(page, `${s.name}-${tod}-${view}`);
        await page.context().close();
      }

  // --- facade signs close up (board, hanging, plaque) -------------------------
  const signs = [
    // Face-on (camera yaw toward each sign's face); the focus sits back from the wall by about the sign's height.
    { name: 'sign-board', cam: [HOUSE.x0 + 1, HOUSE.z1 - 1, 0] },
    { name: 'sign-hanging', cam: [HIP.x + 2.2, HIP.z - 1, Math.PI / 2] },
    { name: 'sign-plaque', cam: [ELL.x + 2, ELL.z + 4.4, 0] },
  ];
  for (const s of ONLY.includes('signs') ? signs : [])
    for (const [tod, t] of [['day', DAY], ['night', NIGHT]]) {
      const page = await open('desktop', `time=${t}&quality=high&cam=${s.cam[0]},${s.cam[1]},150,${s.cam[2]}`);
      await page.addStyleTag({ content: '.hud > * { visibility: hidden !important; }' });
      await sleep(5000);
      await shoot(page, `${s.name}-${tod}`);
      await page.context().close();
    }

  // --- the furnished interior, from inside (the roof dissolves for you) --------
  for (const [tod, t] of ONLY.includes('interior') ? [['day', DAY], ['night', NIGHT]] : [])
    for (const view of Object.keys(VIEWS)) {
      const page = await open(view, `time=${t}&quality=${view === 'desktop' ? 'high' : 'medium'}`, tokens.ivy);
      await hopToward(page, { x: HOUSE.x0 + 1, z: HOUSE.z1 + 1.6 }, 0.8);
      await hopToward(page, { x: HOUSE.x0 + 1.1, z: HOUSE.z + 0.3 }, 0.6);
      await page.addStyleTag({ content: '.hud > *:not(.build-nameprompt) { visibility: hidden !important; }' });
      await sleep(4000);
      await shoot(page, `interior-${tod}-${view}`);
      await page.context().close();
    }

  // --- the build UI: palette tabs, storey control + stacking highlight, clear-bush offer
  for (const view of ONLY.includes('ui') ? Object.keys(VIEWS) : []) {
    const page = await open(view, `time=${DAY}&quality=medium`, tokens.ivy);
    await hopToward(page, { x: HOUSE.x + 0.5, z: HOUSE.z1 + 2.5 }, 1.0);
    await zoomOut(page, 1);
    await openBuild(page);
    // Palette: the Living tab.
    await choosePiece(page, 'sofa', { category: 'living', variant: 'sage' });
    await sleep(800);
    await shoot(page, `palette-living-${view}`);
    // Storey control + stacking highlight: a wall aimed at the top of the garden wall goes on top of it.
    await press(page, '[data-testid=build-done]');
    await hopToward(page, { x: BUSH_WALL.x + 2, z: BUSH_WALL.z + 1 }, 1.0);
    await openBuild(page);
    await choosePiece(page, 'wall', { category: 'structure', variant: 'stone' });
    const st = (await snap(page)).build;
    const target = st.pieces.find((p) => p.level === 0 && p.x === BUSH_WALL.x && p.z === BUSH_WALL.z && PIECES[p.kind].structural);
    const pt = await screenOf(page, target.x, target.z, target.y + 2.1);
    if (page.__touch) await page.touchscreen.tap(pt.x, pt.y);
    else await page.mouse.move(pt.x, pt.y, { steps: 2 });
    await waitSnap(page, (s) => s.build.ghost?.extend === target.id, 'stack highlight', 20_000).catch(() => undefined);
    await sleep(1200);
    await shoot(page, `stack-storey-${view}`);
    // Clear-bush offer: a garden wall aimed through a bush.
    const bush = { x: -21, z: 19 }; // bush_5 grows here
    try {
      // Walk over there (out of build mode: in build mode a tap aims the ghost), then aim a garden wall at the bush.
      await press(page, '[data-testid=build-done]');
      await hopToward(page, { x: bush.x + 1.5, z: bush.z + 2.5 }, 1.2); // camera side: the bush shows above the dock
      await openBuild(page);
      await choosePiece(page, 'fence', { category: 'garden', variant: 'oak' });
      await rotateTo(page, 0);
      await aimGhost(page, bush.x, bush.z).catch(() => undefined);
      await page.waitForSelector('[data-testid=build-clear-offer]', { timeout: 15_000 });
      await sleep(800);
      await shoot(page, `clear-bush-offer-${view}`);
    } catch (err) {
      console.log('[warn] no clear-bush offer shot for', view, String(err).slice(0, 160));
    }
    await page.context().close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.log('[errors]');
  for (const e of errors) console.log('  ', e);
  process.exit(1);
}
console.log('[errors] none');
