#!/usr/bin/env node
/**
 * Building-activity screenshots (dev client required: uses the dev-only ?cam= ?inside= ?quality=
 * ?panel= overrides). The world time is NOT overridden: each shot waits until the SERVER clock is in
 * its window, so keepers / open signs / lights are what the world really shows at that hour.
 * Run the dev server with a short day (e.g. DAY_LENGTH_MINUTES=12) so the windows come round quickly,
 * ideally on a data dir with real activity in it (e.g. a copy of an e2e:activities data dir).
 *
 *   node scripts/activities-screenshots.mjs [devUrl] [outDir] [filter]
 *     devUrl default http://localhost:5193 (REST is proxied, /api/world gives the clock)
 *     outDir default docs/screenshots/activities
 *
 * Every interior, day + night, desktop 1440×900 + phone 390×844, with that building's activity
 * panel open (keeper dialog / piano / notices / project / guest book / tide log). JPEG.
 * Prints renderer stats per shot; exits 1 on console / page errors.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.argv[2] ?? 'http://localhost:5193';
const outDir = process.argv[3] ?? 'docs/screenshots/activities';
const filter = process.argv[4] ?? '';
mkdirSync(outDir, { recursive: true });

const ROOMS = {
  cafe: { x: 23.4, z: -14.7, zoom: 62, phone: 40, day: 'keeper_barista', night: 'station_cafe_piano' },
  general_store: { x: -23.3, z: -10.4, zoom: 62, phone: 40, day: 'keeper_shopkeeper', night: 'station_store_shelf' },
  town_hall: { x: 2.0, z: -29.0, zoom: 46, phone: 31, day: 'station_hall_poll', night: 'station_hall_notices' },
  workshop: { x: 34.8, z: 10.05, zoom: 58, phone: 38, day: 'keeper_tinkerer', night: 'station_workshop_project' },
  house_1: { x: -28.7, z: 4.9, zoom: 80, phone: 56, day: 'station_house_1_guestbook', night: 'station_house_1_guestbook' },
  house_2: { x: -40.7, z: 5.4, zoom: 80, phone: 56, day: 'station_house_2_guestbook', night: 'station_house_2_guestbook' },
  boathouse: { x: 3.3, z: 45.0, zoom: 84, phone: 58, day: 'station_boathouse_log', night: 'station_boathouse_log' },
};
// [from, to) world hours; the café stays open until 22:00, so its night shot is taken just before closing.
const WINDOWS = { day: [10.5, 15.5], night: [22.3, 28.5], cafe_night: [20.6, 21.8] };
const shots = [];
for (const tod of ['day', 'night']) {
  for (const [id, r] of Object.entries(ROOMS)) {
    const win = tod === 'night' && id === 'cafe' ? WINDOWS.cafe_night : WINDOWS[tod];
    const panel = r[tod];
    shots.push({ name: `${id}-${tod}-desktop`, win, q: `autojoin=1&cam=${r.x},${r.z},${r.zoom}&inside=${id}&quality=high&panel=${panel}`, vp: { width: 1440, height: 900 } });
    shots.push({ name: `${id}-${tod}-phone`, win, q: `autojoin=1&cam=${r.x},${r.z},${r.phone}&inside=${id}&quality=medium&panel=${panel}`, vp: { width: 390, height: 844 }, phone: true });
  }
}
shots.push({ name: 'square-lanterns-night', win: WINDOWS.night, q: 'autojoin=1&cam=0,2,30&quality=high', vp: { width: 1440, height: 900 } });
shots.push({ name: 'residential-hearths-night', win: WINDOWS.night, q: 'autojoin=1&cam=-34,6,40&quality=high', vp: { width: 1440, height: 900 } });
const list = shots.filter((s) => !filter || filter.split(',').some((f) => s.name.includes(f)));

async function worldHours() {
  const w = await (await fetch(`${base}/api/world`)).json();
  const e = (w.serverTime - w.clockEpoch) / w.dayLengthMs + 0.3;
  return (e - Math.floor(e)) * 24;
}
const inWin = (h, [a, b]) => (b > 24 ? h >= a || h < b - 24 : h >= a && h < b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  for (const s of list) {
    const ctx = await browser.newContext({ viewport: s.vp, deviceScaleFactor: 1, ...(s.phone ? { hasTouch: true, isMobile: true } : {}) });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${s.name}: pageerror ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${s.name}: ${m.text()}`);
    });
    // Load a little before the window opens (loading takes a while under software rendering).
    for (;;) {
      const h = await worldHours();
      const lead = [(s.win[0] - 0.6 + 24) % 24, s.win[1] - 0.3];
      if (inWin(h, lead)) break;
      await sleep(1000);
    }
    await page.goto(`${base}/?${s.q}`);
    await page.waitForFunction(() => !!window.__ELSEWHERE_WORLD__ && window.__ELSEWHERE__?.snapshot()?.connection === 'connected', null, { timeout: 120_000 });
    while (!inWin(await worldHours(), s.win)) await sleep(500);
    await page.waitForTimeout(7000);
    const info = await page.evaluate(() => window.__ELSEWHERE_WORLD__.info());
    const act = await page.evaluate(() => window.__ELSEWHERE__.snapshot().activities);
    await page.screenshot({ path: `${outDir}/${s.name}.jpg`, type: 'jpeg', quality: 82 });
    const onDuty = Object.entries(act.keepers).filter(([, k]) => k.present).map(([id]) => id.replace('keeper_', ''));
    console.log(`[shot] ${s.name}: world ${(await worldHours()).toFixed(2)}h calls=${info.calls} tris=${info.triangles} keepers on duty: ${onDuty.join(',') || 'none'}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.slice(0, 10).join('\n'));
  process.exit(1);
}
