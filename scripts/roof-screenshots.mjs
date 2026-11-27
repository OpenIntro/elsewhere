#!/usr/bin/env node
/**
 * Screenshots of built house roofs (dev client + a scratch dev server; uses
 * the dev-only URL overrides ?cam= ?time= ?quality=).
 *
 * Default mode — the houses e2e:roofs roofed:
 *   ROOFS_DATA_DIR=<dir> npm run e2e:roofs        (keeps the roofed houses in <dir>)
 *   PORT=2634 DATA_DIR=<dir> npm run dev -w server  (and the Vite client, VITE_SERVER_PORT=2634)
 *   node scripts/roof-screenshots.mjs [devUrl] [outDir]
 *     devUrl default http://localhost:5173, outDir docs/screenshots/build
 *   One desktop (1440x900) shot per house, framed on it with the HUD hidden,
 *   plus a phone (390x844) overview of the 6x4 and the 2x2 next to House 1.
 *
 * Hip mode — hip roofs at several sizes and both pitches:
 *   PORT=2634 BUILD_RANGE=400 BUILD_RATE_CAPACITY=1000 BUILD_RATE_PER_SECOND=1000 \
 *     DATA_DIR=<fresh dir> npm run dev -w server   (and the Vite client)
 *   node scripts/roof-screenshots.mjs --hips [devUrl] [serverUrl] [outDir]
 *     serverUrl default http://localhost:2567; HIP_SHOTS_PREFIX (default house-hip)
 *   Stages (through the real server path, idempotent) the hip-roofed cottage
 *   of build-screenshots2 (6x4, gentle) plus hip houses of 2x2 gentle, 2x3
 *   steep, 4x4 gentle and steep, 6x4 steep (ridge the other way), 8x6 gentle
 *   and a 4x4 steep gable beside the 4x4 steep hip for comparison. Shoots
 *   <prefix>-{day,night}-{desktop,phone,phone-landscape} framed like
 *   build-screenshots2's house-hip (so before / after line up with it), one
 *   desktop close-up per size by day (<prefix>-<size>-day-desktop), and one
 *   town view with the Town Hall's own hip roof (<prefix>-town-check-night,
 *   to confirm the town kit is unchanged).
 *
 * Exits 1 on console / page errors.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ROOF_HOUSES, rectWalls } from './lib/roofPlans.mjs';
import { hipHouse } from './lib/plans2.mjs';
import { builderClient } from './lib/seed.mjs';
import { sleep, waitSnap } from './lib/browser.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const HIPS = process.argv[2] === '--hips';
const args = HIPS ? process.argv.slice(3) : process.argv.slice(2);
const dev = args[0] ?? 'http://localhost:5173';
const srv = HIPS ? (args[1] ?? 'http://localhost:2567') : null;
const outDir = (HIPS ? args[2] : args[1]) ?? 'docs/screenshots/build';
const PREFIX = process.env.HIP_SHOTS_PREFIX ?? 'house-hip';
mkdirSync(outDir, { recursive: true });
const errors = [];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const VIEWS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } },
  'phone-landscape': { ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 } },
};
async function shootAt(view, name, query) {
  const ctx = await browser.newContext(VIEWS[view]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(`${dev}/?autojoin=1&${query}`);
  await waitSnap(page, (s) => s.local?.ready && s.build?.synced && s.build.count > 0, 'joined', 120_000);
  await page.addStyleTag({ content: '.hud > * { visibility: hidden !important; }' });
  await sleep(5000);
  await page.screenshot({ path: `${outDir}/${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log(`[shot] ${name}`);
  await ctx.close();
}
async function shoot(view, name, cam) {
  await shootAt(view, name, `time=0.45&quality=${view === 'desktop' ? 'high' : 'medium'}&cam=${cam.join(',')}`);
}

// --- hip mode ------------------------------------------------------------------------
const DAY = 0.45;
const NIGHT = 0.93;
/** The build-screenshots2 hip cottage (6x4, ridge along X, gentle) — the house-hip views frame it. */
const HIP = { x: -4, z: 19 };
const site = (id) => ROOF_HOUSES.find((h) => h.id === id).box;
/** Hip houses on sites e2e:roofs already found open and buildable (plus one larger site). rot 0: w = the x side. */
const HIP_SIZES = [
  { id: '2x2-gentle', box: site('small'), rot: 0, style: 'hip', pitch: 0 },
  { id: '2x3-steep', box: site('two-by-three'), rot: 1, style: 'hip', pitch: 1 },
  { id: '4x4-gentle', box: site('doors-windows'), rot: 0, style: 'hip', pitch: 0 },
  { id: '4x4-steep', box: site('one-storey'), rot: 0, style: 'hip', pitch: 1 },
  { id: '4x4-steep-gable', box: site('missing'), rot: 0, style: 'gable', pitch: 1 },
  { id: '6x4-steep', box: site('mixed-owner'), rot: 0, style: 'hip', pitch: 1 },
  { id: '8x6-gentle', box: { x0: -22, z0: 20, x1: -14, z1: 26 }, rot: 1, style: 'hip', pitch: 0 },
];
async function stageHips() {
  const rowan = await builderClient(srv, { name: 'Rowan' });
  const refused = [];
  const place = async (p) => {
    let r = await rowan.place(p);
    if (!r.ok && r.natureId) {
      await rowan.clear(r.natureId);
      r = await rowan.place(p);
    }
    if (!r.ok) refused.push(`${p.kind}@${p.x},${p.z}L${p.level ?? 0} ${r.reason} ${r.message ?? ''}`);
    return r;
  };
  for (const p of hipHouse(HIP)) await place(p);
  for (const h of HIP_SIZES) {
    const b = h.box;
    for (const w of rectWalls(b, { kindAt: (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall'), variant: 'sage' })) await place({ ...w, owner: undefined });
    const sx = b.x1 - b.x0;
    const sz = b.z1 - b.z0;
    // The widest eaves that stay off protected land, like the roof tool.
    for (const o of [0.45, 0.25, 0]) {
      const params = { w: h.rot % 2 === 0 ? sx : sz, d: h.rot % 2 === 0 ? sz : sx, style: h.style, pitch: h.pitch, overhang: o };
      const r = await rowan.place({ kind: 'house_roof', x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, rot: h.rot, level: 1, variant: 'slate', params });
      if (r.ok) break;
      if (o === 0) refused.push(`${h.id} roof ${r.reason} ${r.message ?? ''}`);
    }
  }
  await rowan.leave();
  console.log('[stage] refused:', refused.length ? refused.join('; ') : 'none');
}

try {
  if (HIPS) {
    await stageHips();
    const zoom = { desktop: 70, phone: 46, 'phone-landscape': 50 };
    for (const [tod, t] of [['day', DAY], ['night', NIGHT]])
      for (const view of Object.keys(VIEWS)) await shootAt(view, `${PREFIX}-${tod}-${view}`, `time=${t}&quality=${view === 'desktop' ? 'high' : 'medium'}&cam=${HIP.x},${HIP.z},${zoom[view]}`);
    for (const h of HIP_SIZES) {
      const b = h.box;
      const size = Math.max(b.x1 - b.x0, b.z1 - b.z0);
      await shootAt('desktop', `${PREFIX}-${h.id}-day-desktop`, `time=${DAY}&quality=high&cam=${(b.x0 + b.x1) / 2},${(b.z0 + b.z1) / 2},${36 + size * 5}`);
    }
    // The Town Hall's own (kit) hip roof, same view as docs/screenshots/interiors/exterior-night-hall.
    await shootAt('desktop', `${PREFIX}-town-check-night`, `cam=2,-25,30&time=${NIGHT}&quality=high`);
  } else {
    for (const h of ROOF_HOUSES) {
      const cx = (h.box.x0 + h.box.x1) / 2;
      const cz = (h.box.z0 + h.box.z1) / 2;
      // Focus a little behind the house (it stands 3-6 m tall) at the default rotation.
      await shoot('desktop', `roofed-${h.id}`, [cx - 1.2, cz - 1.2, 70, Math.PI / 4]);
    }
    await shoot('phone', 'roofed-overview-phone', [-21, 13, 26, Math.PI / 4]);
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
