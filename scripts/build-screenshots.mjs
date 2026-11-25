#!/usr/bin/env node
/**
 * Player-building screenshots (dev client required — uses the dev-only URL
 * overrides ?cam= ?time= ?quality=).
 *
 *   node scripts/build-screenshots.mjs [baseUrl] [outDir]
 *     baseUrl default http://localhost:5173, outDir default docs/screenshots/build
 *
 * 1. A desktop client builds the cottage of scripts/lib/cottage.mjs through
 *    the real build UI (palette, styles, rotate, hover + click), unless the
 *    site already holds it (dev data persists between runs). Leftovers of an
 *    unfinished earlier run are cleared through the admin API
 *    (SHOTS_ADMIN_TOKEN = the dev server's ADMIN_TOKEN).
 * 2. Shots: the palette + a valid (green) ghost and a refused (red) ghost
 *    with its reason, on desktop (1440x900), phone portrait (390x844) and
 *    phone landscape (844x390, touch); the finished cottage by day and by
 *    night on all three. JPEG. Exits 1 on console/page errors.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PIECES, groundHeight } from '@elsewhere/shared';
import { SITE, cottagePlan } from './lib/cottage.mjs';
import { assert, aimGhost, buildState, screenOf, choosePiece, hopToward, openBuild, placeHere, rotateTo, sleep, snap, waitSnap, zoomOut } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] ?? 'http://localhost:5173';
const outDir = process.argv[3] ?? 'docs/screenshots/build';
mkdirSync(outDir, { recursive: true });
const DAY = 0.45;
const NIGHT = 0.93;
const STAND = { x: SITE.x, z: SITE.z + 5.5 };
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label}: pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${label}: ${m.text()}`));
}
async function shoot(page, name) {
  await page.screenshot({ path: `${outDir}/${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log(`[shot] ${name}`);
}
async function newPage(kind, query = '') {
  const opts = kind === 'desktop' ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } : kind === 'portrait' ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 } };
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.__touch = kind !== 'desktop';
  watch(page, kind);
  await page.goto(`${base}/?autojoin=1&${query}`);
  await waitSnap(page, (s) => s.local?.ready && s.navReady && s.connection === 'connected', `${kind} joined`);
  return page;
}

/** Build the cottage through the UI (skips pieces that already stand there). */
async function buildCottage(page) {
  const plan = cottagePlan();
  const onSite = (st) => st.pieces.filter((p) => Math.abs(p.x - SITE.x) < 7 && Math.abs(p.z - SITE.z) < 7);
  const st0 = await buildState(page);
  if (onSite(st0).length === plan.length) return console.log('[build] the cottage already stands; not rebuilding');
  if (onSite(st0).length) {
    // Leftovers of an earlier run belong to another guest (they cannot be built on): clear them as an admin.
    const token = process.env.SHOTS_ADMIN_TOKEN;
    assert(token, 'the site holds pieces of an earlier run; set SHOTS_ADMIN_TOKEN (the dev server ADMIN_TOKEN) to clear them');
    for (const p of onSite(st0)) await fetch(`${base}/api/admin/build/pieces/${p.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    await waitSnap(page, (s) => onSite(s.build).length === 0, 'site cleared', 20_000);
  }
  await hopToward(page, STAND, 1.0);
  await zoomOut(page, 2);
  await openBuild(page);
  for (const item of plan) {
    const st = await buildState(page);
    if (st.pieces.some((p) => p.kind === item.kind && p.x === item.x && p.z === item.z && p.level === (item.level ?? 0))) continue;
    await choosePiece(page, item.kind, { category: PIECES[item.kind].category, variant: item.variant });
    await rotateTo(page, item.rot ?? 0);
    if (item.text) await page.fill('[data-testid=build-sign-text]', item.text);
    let y;
    if (item.top) {
      const below = (await buildState(page)).pieces.filter((p) => p.level === 0 && PIECES[p.kind].structural);
      y = Math.max(...below.map((p) => p.y)) + 2.6;
    }
    const placed = await placeHere(page, item.x, item.z, y, item.level !== undefined ? { level: item.level } : {});
    console.log(`[build] ${placed.kind} at ${placed.x},${placed.z} level ${placed.level}`);
  }
}

try {
  // --- Build + palette / ghost shots (desktop) ------------------------------
  const a = await newPage('desktop', `time=${DAY}&quality=low`);
  await buildCottage(a);
  await a.context().close();

  for (const kind of ['desktop', 'portrait', 'landscape']) {
    const p = await newPage(kind, `time=${DAY}&quality=medium`);
    await hopToward(p, STAND, 1.2);
    await zoomOut(p, 2);
    await openBuild(p);
    await page_ghosts(p, kind === 'desktop' ? 'desktop' : kind === 'portrait' ? 'phone' : 'phone-landscape');
    await p.context().close();
  }

  // --- The finished cottage, day and night -----------------------------------
  for (const [tod, t] of [['day', DAY], ['night', NIGHT]]) {
    for (const [kind, zoom, label] of [['desktop', 60, 'desktop'], ['portrait', 42, 'phone'], ['landscape', 46, 'phone-landscape']]) {
      const p = await newPage(kind, `time=${t}&quality=${kind === 'desktop' ? 'high' : 'medium'}&cam=${SITE.x + 0.5},${SITE.z + 0.5},${zoom}`);
      await p.addStyleTag({ content: '.hud > *:not(.build-dock) { visibility: hidden !important; }' });
      await waitSnap(p, (s) => (s.build?.count ?? 0) >= cottagePlan().length, 'pieces synced', 30_000);
      await sleep(5000);
      await shoot(p, `cottage-${tod}-${label}`);
      await p.context().close();
    }
  }
} finally {
  await browser.close();
}

async function page_ghosts(page, label) {
  // Valid: a fence by the garden (green ghost).
  await choosePiece(page, 'fence', { category: 'garden', variant: 'oak' });
  await rotateTo(page, 1);
  // The first candidate spot that is on screen (not under the dock / buttons on small screens).
  let ok = null;
  for (const [dx, dz] of [[4, 3], [-4, 3], [4, -1], [-4, -1], [3, 5], [-3, 5]]) {
    try {
      await screenOf(page, SITE.x + dx, SITE.z + dz);
    } catch {
      continue;
    }
    const g = await aimGhost(page, SITE.x + dx, SITE.z + dz);
    if (!g.build.ghost.ok) continue;
    ok = g;
    break;
  }
  assert(ok, 'no on-screen spot for the valid ghost');
  assert(ok.build.ghost.ok, `expected a valid ghost, got ${ok.build.ghost.message}`);
  await sleep(1200);
  await shoot(page, `ghost-valid-${label}`);
  // Refused: on the path (red ghost + reason).
  await choosePiece(page, 'wall', { category: 'structure', variant: 'rose' });
  const s = await snap(page);
  let bad = null;
  for (const [dx, dz] of [[3, 3], [2, 2], [-2, 3], [3, -1], [1, 2]]) {
    try {
      await screenOf(page, Math.round(s.local.x + dx), Math.round(s.local.z + dz));
    } catch {
      continue;
    }
    bad = await aimGhost(page, Math.round(s.local.x + dx), Math.round(s.local.z + dz));
    break;
  }
  assert(bad, 'no on-screen spot for the refused ghost');
  if (bad.build.ghost.ok) console.log('[warn] the refused-ghost spot was valid');
  await sleep(1200);
  await shoot(page, `ghost-refused-${label}`);
  // Palette: the Home tab.
  await page.click('[data-testid=build-tab-furnishing]');
  await sleep(600);
  await shoot(page, `palette-${label}`);
}

if (errors.length) {
  console.log('[errors]');
  for (const e of errors) console.log('  ', e);
  process.exit(1);
}
console.log('[errors] none');
void groundHeight;
