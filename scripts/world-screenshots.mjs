#!/usr/bin/env node
/**
 * World art screenshots (dev client required — uses dev-only URL overrides).
 *
 *   node scripts/world-screenshots.mjs [baseUrl] [outDir] [filter]
 *     baseUrl default http://localhost:5173, outDir default docs/screenshots/world
 *     filter: substring to only take matching shot names
 *
 * Overrides: ?cam=<preset|x,z,zoom>&time=0..1&fountain=n&portal=1&runes=1&quality=…
 * Also prints renderer stats (draw calls / frame time) per shot and the
 * interactable coverage report from window.__ELSEWHERE_WORLD__.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}
const { chromium } = await loadPlaywright();

const base = process.argv[2] ?? 'http://localhost:5173';
const outDir = process.argv[3] ?? 'docs/screenshots/world';
const filter = process.argv[4] ?? '';
mkdirSync(outDir, { recursive: true });

const MID = 0.53;
const shots = [
  { name: 'island', q: `cam=island&time=${MID}` },
  { name: 'loc-town_square', q: `cam=town_square&time=${MID}` },
  { name: 'loc-cafe', q: `cam=cafe&time=${MID}` },
  { name: 'loc-general_store', q: `cam=general_store&time=${MID}` },
  { name: 'loc-residential', q: `cam=residential&time=${MID}` },
  { name: 'loc-town_hall', q: `cam=town_hall&time=${MID}` },
  { name: 'loc-workshop', q: `cam=workshop&time=${MID}` },
  { name: 'loc-woods', q: `cam=woods&time=${MID}` },
  { name: 'loc-the_unknown', q: `cam=the_unknown&time=${MID}` },
  { name: 'loc-waterfront', q: `cam=waterfront&time=${MID}` },
  { name: 'time-1-morning', q: 'cam=0,-4,16&time=0.31' },
  { name: 'time-2-midday', q: `cam=0,-4,16&time=${MID}` },
  { name: 'time-3-golden_hour', q: 'cam=0,-4,16&time=0.735' },
  { name: 'time-4-dusk', q: 'cam=0,-4,16&time=0.815' },
  { name: 'time-5-night', q: 'cam=0,-4,16&time=0.95' },
  { name: 'island-night', q: 'cam=island&time=0.95' },
  { name: 'fountain-stage-0', q: 'cam=0,2,58&time=0.62&fountain=0' },
  { name: 'fountain-stage-1', q: 'cam=0,2,58&time=0.62&fountain=1' },
  { name: 'fountain-stage-2', q: 'cam=0,2,58&time=0.62&fountain=2' },
  { name: 'fountain-stage-3', q: 'cam=0,2,58&time=0.62&fountain=3' },
  { name: 'fountain-stage-3-night', q: 'cam=0,2,46&time=0.93&fountain=3' },
  { name: 'portal-dormant', q: 'cam=-10.5,-61,46&time=0.84&portal=0&runes=0' },
  { name: 'portal-awake', q: 'cam=-10.5,-61,46&time=0.84&portal=1' },
  { name: 'night-cafe', q: 'cam=cafe&time=0.93' },
  { name: 'night-residential', q: 'cam=residential&time=0.9' },
  { name: 'quality-low', q: `cam=town_square&time=${MID}&quality=low` },
  { name: 'quality-high', q: `cam=town_square&time=${MID}&quality=high` },
].filter((s) => s.name.includes(filter));

const browser = await chromium.launch();
const errors = [];
try {
  for (const s of shots) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${s.name}: pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${s.name}: console.error ${m.text()}`);
      if (m.type() === 'warning' && m.text().includes('[world]')) errors.push(`${s.name}: ${m.text()}`);
    });
    const quality = s.q.includes('quality=') ? '' : '&quality=high';
    await page.goto(`${base}/?${s.q}${quality}`);
    await page.waitForFunction(() => !!window.__ELSEWHERE_WORLD__, null, { timeout: 60_000 });
    await page.addStyleTag({ content: '#root > :not(:first-child), body > div:not(#root) { display: none !important; }' });
    await page.waitForTimeout(s.name.startsWith('fountain') || s.name.startsWith('portal') ? 6000 : 4500);
    const info = await page.evaluate(() => window.__ELSEWHERE_WORLD__.info());
    await page.screenshot({ path: `${outDir}/${s.name}.png` });
    console.log(`[shot] ${s.name}: calls=${info.calls} tris=${info.triangles} avgFrame=${info.avgFrameMs.toFixed(1)}ms q=${info.quality}`);
    if (s.name === 'island') console.log('[coverage]', JSON.stringify(await page.evaluate(() => window.__ELSEWHERE_WORLD__.coverage())));
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.log('[errors]');
  for (const e of errors) console.log('  ', e);
} else console.log('[errors] none');
