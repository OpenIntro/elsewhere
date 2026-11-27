#!/usr/bin/env node
/**
 * Screenshots of the houses e2e:roofs roofed (dev client + a scratch dev
 * server on that run's data dir; uses the dev-only URL overrides ?cam= ?time=).
 *
 *   ROOFS_DATA_DIR=<dir> npm run e2e:roofs        (keeps the roofed houses in <dir>)
 *   PORT=2634 DATA_DIR=<dir> npm run dev -w server  (and the Vite client, VITE_SERVER_PORT=2634)
 *   node scripts/roof-screenshots.mjs [devUrl] [outDir]
 *     devUrl default http://localhost:5173, outDir docs/screenshots/build
 *
 * One desktop (1440x900) shot per house, framed on it with the HUD hidden,
 * plus a phone (390x844) overview of the 6x4 and the 2x2 next to House 1.
 * Exits 1 on console / page errors.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ROOF_HOUSES } from './lib/roofPlans.mjs';
import { sleep, waitSnap } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const dev = process.argv[2] ?? 'http://localhost:5173';
const outDir = process.argv[3] ?? 'docs/screenshots/build';
mkdirSync(outDir, { recursive: true });
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function shoot(view, name, cam) {
  const ctx = await browser.newContext(view === 'phone' ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(`${dev}/?autojoin=1&time=0.45&quality=${view === 'phone' ? 'medium' : 'high'}&cam=${cam.join(',')}`);
  await waitSnap(page, (s) => s.local?.ready && s.build?.synced && s.build.count > 0, 'joined', 120_000);
  await page.addStyleTag({ content: '.hud > * { visibility: hidden !important; }' });
  await sleep(5000);
  await page.screenshot({ path: `${outDir}/${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log(`[shot] ${name}`);
  await ctx.close();
}
try {
  for (const h of ROOF_HOUSES) {
    const cx = (h.box.x0 + h.box.x1) / 2;
    const cz = (h.box.z0 + h.box.z1) / 2;
    // Focus a little behind the house (it stands 3-6 m tall) at the default rotation.
    await shoot('desktop', `roofed-${h.id}`, [cx - 1.2, cz - 1.2, 70, Math.PI / 4]);
  }
  await shoot('phone', 'roofed-overview-phone', [-21, 13, 26, Math.PI / 4]);
} finally {
  await browser.close();
}
if (errors.length) {
  console.log('[errors]');
  for (const e of errors) console.log('  ', e);
  process.exit(1);
}
console.log('[errors] none');
