#!/usr/bin/env node
/**
 * Interior art screenshots (dev client required — uses the dev-only URL
 * overrides ?cam= ?time= ?inside= ?quality=).
 *
 *   node scripts/interior-screenshots.mjs [baseUrl] [outDir] [filter]
 *     baseUrl default http://localhost:5173, outDir default docs/screenshots/interiors
 *
 * For every walk-in building: day + night, desktop 1440×900 + phone 390×844
 * (cutaway forced open with ?inside=<id>), plus closed exteriors at night
 * (lit windows) and the four camera rotations of one interior. JPEG output.
 * Prints renderer stats per shot; exits 1 on console/page errors.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const base = process.argv[2] ?? 'http://localhost:5173';
const outDir = process.argv[3] ?? 'docs/screenshots/interiors';
const filter = process.argv[4] ?? '';
mkdirSync(outDir, { recursive: true });

// Interior centres (shared INTERIORS footprint centres) and a zoom that frames each room.
const ROOMS = {
  cafe: { x: 23.4, z: -14.7, zoom: 62, phone: 44 },
  general_store: { x: -23.3, z: -10.4, zoom: 62, phone: 44 },
  town_hall: { x: 2.0, z: -29.0, zoom: 46, phone: 33 },
  workshop: { x: 34.8, z: 10.05, zoom: 58, phone: 42 },
  house_1: { x: -28.7, z: 4.9, zoom: 80, phone: 58 },
  house_2: { x: -40.7, z: 5.4, zoom: 80, phone: 58 },
  boathouse: { x: 3.3, z: 45.0, zoom: 84, phone: 60 },
};
const DAY = 0.53;
const NIGHT = 0.93;
const shots = [];
for (const [id, r] of Object.entries(ROOMS)) {
  for (const [tod, t] of [['day', DAY], ['night', NIGHT]]) {
    shots.push({ name: `${id}-${tod}-desktop`, q: `cam=${r.x},${r.z},${r.zoom}&inside=${id}&time=${t}&quality=high`, vp: { width: 1440, height: 900 } });
    shots.push({ name: `${id}-${tod}-phone`, q: `cam=${r.x},${r.z},${r.phone}&inside=${id}&time=${t}&quality=medium`, vp: { width: 390, height: 844 } });
  }
}
// closed exteriors at night: lit windows from outside
shots.push({ name: 'exterior-night-cafe', q: `cam=21,-10,34&time=${NIGHT}&quality=high`, vp: { width: 1440, height: 900 } });
shots.push({ name: 'exterior-night-hall', q: `cam=2,-25,30&time=${NIGHT}&quality=high`, vp: { width: 1440, height: 900 } });
shots.push({ name: 'exterior-day-residential', q: `cam=-36,12,26&time=${DAY}&quality=high`, vp: { width: 1440, height: 900 } });
// the four camera rotations, one room
for (let k = 0; k < 4; k++) shots.push({ name: `rotation-${k + 1}-cafe`, q: `cam=${ROOMS.cafe.x},${ROOMS.cafe.z},${ROOMS.cafe.zoom},${Math.PI / 4 + (k * Math.PI) / 2}&inside=cafe&time=${DAY}&quality=high`, vp: { width: 1440, height: 900 } });
// low quality
shots.push({ name: 'cafe-night-low', q: `cam=${ROOMS.cafe.x},${ROOMS.cafe.z},${ROOMS.cafe.zoom}&inside=cafe&time=${NIGHT}&quality=low`, vp: { width: 1440, height: 900 } });
const list = shots.filter((s) => !filter || filter.split(',').some((f) => s.name.includes(f)));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  for (const s of list) {
    const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${s.name}: pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || (m.type() === 'warning' && m.text().includes('[world]'))) errors.push(`${s.name}: ${m.text()}`);
    });
    await page.goto(`${base}/?${s.q}`);
    await page.waitForFunction(() => !!window.__ELSEWHERE_WORLD__, null, { timeout: 90_000 });
    await page.addStyleTag({ content: '#root > :not(:first-child), body > div:not(#root) { display: none !important; }' });
    await page.waitForTimeout(5500);
    const info = await page.evaluate(() => window.__ELSEWHERE_WORLD__.info());
    await page.screenshot({ path: `${outDir}/${s.name}.jpg`, type: 'jpeg', quality: 82 });
    console.log(`[shot] ${s.name}: calls=${info.calls} tris=${info.triangles} q=${info.quality}`);
    await ctx.close();
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
