// QA scratch (cycle 2): hip-roofed home, walk in with chunking, rotate, label + pin on B, perf line. Not part of the repo.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { roofParamsString } from '@elsewhere/shared';
import { createServer } from './lib/server.mjs';
import { builderClient } from './lib/seed.mjs';
import { rectWalls } from './lib/roofPlans.mjs';
import { snap, sleep, waitSnap, keyboardRoute, hopToward, press, cameraSettled } from './lib/browser.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const OUT = process.env.OUT;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[cross]', ...a);
const server = createServer({ port: 2691, label: 'cross', env: { BUILD_RANGE: '400', BUILD_RATE_CAPACITY: '1000', BUILD_RATE_PER_SECOND: '1000' } });
await server.start();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const LOW = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ca = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ca.addInitScript(LOW);
const cb = await browser.newContext({ ...devices['Pixel 7'] });
await cb.addInitScript(LOW);
const a = await ca.newPage();
const b = await cb.newPage();
b.__touch = true;
const errors = [];
for (const [n, p] of [['A', a], ['B', b]]) {
  p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${n}: ${m.text()}`));
}
try {
  for (const p of [a, b]) {
    await p.goto(`${server.url}/?autojoin=1`);
    await waitSnap(p, (s) => s.local?.ready && s.build?.synced && s.navReady, 'joined', 120_000);
  }
  const tokA = await a.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
  const st = await builderClient(server.url, { token: tokA });
  const homeRes = [];
  st.room.onMessage('home_result', (m) => homeRes.push(m));
  const box = { x0: -21, z0: -2, x1: -17, z1: 2 };
  const walls = rectWalls(box, { kindAt: (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall') });
  const ids = [];
  for (const w of walls) {
    const r = await st.place(w);
    if (!r.ok) throw new Error(`wall refused ${JSON.stringify(r)}`);
    ids.push(r.id ?? r.pieceId);
  }
  const roof = await st.place({ kind: 'house_roof', variant: 'clay', x: -19, z: 0, rot: 0, level: 1, params: roofParamsString({ w: 4, d: 4, style: 'hip', pitch: 1 }) });
  log('roof', JSON.stringify(roof).slice(0, 200));
  const sa = await waitSnap(a, (s) => s.build.pieces.some((p) => p.kind === 'house_roof'), 'A has roof', 30_000);
  const door = sa.build.pieces.find((p) => p.kind === 'doorway');
  st.room.send('home_set', { pieceId: door.id });
  await sleep(1500);
  st.room.send('home_pin', { on: true });
  await sleep(1500);
  log('home results', JSON.stringify(homeRes));
  await st.leave();
  const ha = await waitSnap(a, (s) => s.homes?.homes?.some((h) => h.pinned), 'A sees pinned home', 20_000).catch(async () => snap(a));
  log('A homes', JSON.stringify(ha.homes).slice(0, 400));
  log('A roof params', JSON.stringify(sa.build.pieces.find((p) => p.kind === 'house_roof')?.params), 'buildRender', JSON.stringify(sa.buildRender).slice(0, 300));
  // A walks in through the doorway (south side, x -20).
  await keyboardRoute(a, [{ x: -20, z: 4 }, { x: -20, z: 2.6 }, { x: -19.2, z: 0.2 }], { timeout: 120_000 });
  const ins = await waitSnap(a, (s) => s.builtCutaway?.active && s.builtCutaway.settled, 'A cutaway active', 20_000);
  log('A inside cutaway', JSON.stringify({ rect: ins.builtCutaway.rect, cut: ins.builtCutaway.cutIds, hidden: ins.builtCutaway.hiddenIds, yaw: ins.view.yaw.toFixed(2), chunks: ins.buildRender?.groups ?? ins.buildRender?.drawCalls }));
  await a.screenshot({ path: `${OUT}/A-inside-q0.jpg`, type: 'jpeg', quality: 75 });
  for (let k = 1; k <= 3; k++) {
    const y0 = (await snap(a)).view.yaw;
    await a.keyboard.press('BracketRight');
    await waitSnap(a, (s) => Math.abs(s.view.yaw - y0) > 1.2, 'turned', 15_000);
    await cameraSettled(a);
    const s = await waitSnap(a, (q) => q.builtCutaway?.active && q.builtCutaway.settled, 'settled', 15_000);
    log(`rot ${k}: yaw ${s.view.yaw.toFixed(2)} cut ${s.builtCutaway.cutIds.length} [${s.builtCutaway.cutIds.join(',')}] hidden ${s.builtCutaway.hiddenIds.length}`);
    await a.screenshot({ path: `${OUT}/A-inside-r${k}.jpg`, type: 'jpeg', quality: 75 });
  }
  // B walks up outside the door: approach label while A is inside.
  await hopToward(b, { x: -20, z: 5.2 }, 1.2);
  const lab = await b.waitForSelector('[data-testid=build-name-prompt]', { timeout: 30_000 }).then(() => b.textContent('[data-testid=build-name-prompt]')).catch(() => null);
  const labRect = await b.evaluate(() => document.querySelector('[data-testid=build-name-prompt]')?.getBoundingClientRect().toJSON());
  const stickRect = await b.evaluate(() => {
    const el = document.querySelector('[data-testid=joystick]');
    return el ? el.getBoundingClientRect().toJSON() : null;
  });
  log('B label', JSON.stringify(lab), 'rect', JSON.stringify(labRect), 'stick', JSON.stringify(stickRect));
  await b.screenshot({ path: `${OUT}/B-approach-label.jpg`, type: 'jpeg', quality: 75 });
  await press(b, '[data-testid=nav-map]');
  await b.waitForSelector('[data-testid=panel-map]', { timeout: 20_000 });
  const pin = await b.waitForSelector('[data-testid^=map-home-]', { timeout: 10_000 }).then((e) => e.getAttribute('data-label')).catch(() => null);
  log('B map pin', JSON.stringify(pin));
  await sleep(800);
  await b.screenshot({ path: `${OUT}/B-map-pin.jpg`, type: 'jpeg', quality: 75 });
  await press(b, '[data-testid=sheet-close]');
  // Settings performance line on both.
  for (const [n, p] of [['A', a], ['B', b]]) {
    await press(p, '[data-testid=nav-settings]');
    const line = await p.waitForSelector('[data-testid=perf-line]', { timeout: 20_000 }).then(() => sleep(2000)).then(() => p.textContent('[data-testid=perf-line]')).catch((e) => `missing: ${e.message}`);
    await p.locator('[data-testid=perf-line]').scrollIntoViewIfNeeded().catch(() => undefined);
    await p.screenshot({ path: `${OUT}/${n}-settings-perf.jpg`, type: 'jpeg', quality: 75 });
    log(`${n} perf line`, JSON.stringify(line));
    const fr = (await snap(p)).frame;
    log(`${n} frame`, JSON.stringify(fr));
  }
  log('errors', JSON.stringify(errors));
} catch (e) {
  log('FAILED', e.stack);
  await a.screenshot({ path: `${OUT}/fail-A.jpg` }).catch(() => undefined);
  await b.screenshot({ path: `${OUT}/fail-B.jpg` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
