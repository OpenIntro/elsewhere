#!/usr/bin/env node
/**
 * Turning the view, end to end: two real browsers against the REAL production
 * build, through the real HUD, keys, mouse drags and touch gestures.
 *
 *   npm run build && npm run e2e:camera
 *
 * Own production server (scripts/lib/server.mjs; PORT $CAMERA_PORT or 2644,
 * fresh DATA_DIR). Client A: desktop 1440x900 (mouse + keyboard). Client B:
 * Pixel 7 emulation (touch; the two-finger gestures are CDP touch events, which
 * reach the page as touch pointer events). Low graphics.
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. desktop HUD shows the two turn buttons with their keys in the tooltip
 *  2. A turns a full circle in four steps with the ↻ button: after each step the orientation (snapshot camera.rotation / yaw)
 *     is one of the four settled sides, W goes screen-up and a click-to-move reaches the clicked point (server positions)
 *  3. the same with the ] key (and [ back)
 *  4. the same with a right-button drag (the view follows the drag, then settles to the nearest 90°); a middle-button drag
 *     turns too; the browser context menu is held back only while dragging on the canvas
 *  5. B (touch) turns by the ↻ button and by a two-finger twist (settles to 90°); a pinch zooms and does not turn
 *  6. in the Café A turns four times: the cutaway stays open and A stays on screen at every orientation; B the same on the phone
 *  7. build mode: ] turns the view, R still turns the piece; after each turn the ghost is under the (still) mouse pointer
 *  8. seated on a café chair, A turns the view and stays seated
 *  9. zero console / page errors on both pages
 *
 * Env: CAMERA_PORT, CAMERA_DATA_DIR, CAMERA_SHOTS (default docs/screenshots/camera; 0 = none), CAMERA_CLIENT_DIST,
 * CAMERA_VERBOSE=1, E2E_RESULT.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getInteractable, getInterior, interiorAnchor, interiorAt } from '@elsewhere/shared';
import { assert, choosePiece, hopToward, openBuild, press, query, sleep, snap, waitSnap } from './lib/browser.mjs';
import { closePanel, groundUnder, hopInto, twoFinger } from './lib/phone.mjs';
import { ROOT, createServer } from './lib/server.mjs';
import { resultFile } from './lib/report.mjs';

const { chromium, devices } = createRequire(import.meta.url)('playwright');

const PORT = Number(process.env.CAMERA_PORT ?? 2644);
const SHOTS = process.env.CAMERA_SHOTS === '0' ? null : path.resolve(ROOT, process.env.CAMERA_SHOTS ?? 'docs/screenshots/camera');
const BASE_YAW = Math.PI / 4;
const Q = Math.PI / 2;
/** Open, walkable ground (nothing solid within 3.5 m) for the movement checks. */
const OPEN = { x: -14, z: -6 };
/** Buildable meadow for the build-mode check. */
const BUILD_AT = { x: -10, z: 14 };

const log = (...a) => console.log('[camera]', ...a);
const pageErrors = [];
const rec = resultFile('camera', () => pageErrors);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  rec.add(name, ok, detail);
  console.log(`[camera] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
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
const env = process.env.CAMERA_CLIENT_DIST ? { CLIENT_DIST: path.resolve(process.env.CAMERA_CLIENT_DIST) } : {};
const server = createServer({ port: PORT, env, ...(process.env.CAMERA_DATA_DIR ? { dataDir: process.env.CAMERA_DATA_DIR } : {}), label: 'camera', verbose: !!process.env.CAMERA_VERBOSE, tmpPrefix: 'elsewhere-camera-' });
const BASE = server.url;
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${label} console.error: ${m.text()}`);
  });
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 80 }).catch((e) => log('screenshot failed', name, e.message));
}
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const angleDeg = (u, v) => (Math.abs(norm(Math.atan2(u.z, u.x) - Math.atan2(v.z, v.x))) * 180) / Math.PI;

/** Wait until the view has settled on rotation `r` (yaw exactly that side). */
async function settledAt(page, r, label) {
  return waitSnap(page, (s) => s.camera?.rotation === r && Math.abs(s.camera.yaw - (BASE_YAW + r * Q)) < 1e-4, `${label}: settled at rotation ${r}`, 15_000);
}
const serverPos = (s, id) => s.players.find((p) => p.id === id);

/** W for 700 ms: the server position moves screen-up (away from the camera) within 25°. */
async function wGoesUp(page, id) {
  const s0 = await snap(page);
  const p0 = serverPos(s0, id);
  await page.keyboard.down('KeyW');
  await sleep(700);
  await page.keyboard.up('KeyW');
  const s1 = await waitSnap(page, (s) => s.local.speed < 0.05 && Math.hypot(serverPos(s, id).x - s.local.x, serverPos(s, id).z - s.local.z) < 0.15, 'stopped (server caught up)', 15_000);
  const p1 = serverPos(s1, id);
  const d = { x: p1.x - p0.x, z: p1.z - p0.z };
  const up = { x: -Math.sin(s1.camera.yaw), z: -Math.cos(s1.camera.yaw) };
  const err = angleDeg(d, up);
  assert(Math.hypot(d.x, d.z) > 0.6, `W moved only ${Math.hypot(d.x, d.z).toFixed(2)} m`);
  assert(err < 25, `W went ${err.toFixed(0)}° off screen-up`);
  return err;
}
/** Click / tap the ground at `world` (its screen point now): the server position ends within 0.6 m. */
async function clickToMove(page, id, world) {
  const p = await query(page, 'worldToScreen', world.x, world.z);
  assert(p, 'no screen point');
  if (page.__touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
  const g = await query(page, 'groundFromScreen', p.x, p.y);
  await sleep(400);
  const s = await waitSnap(page, (q) => !q.motion?.path && q.local.speed < 0.05 && Math.hypot(serverPos(q, id).x - q.local.x, serverPos(q, id).z - q.local.z) < 0.15, 'walk finished', 30_000);
  const sp = serverPos(s, id);
  const d = Math.hypot(sp.x - g.x, sp.z - g.z);
  assert(d <= 0.6, `click-to-move ended ${d.toFixed(2)} m from the clicked point`);
  return d;
}
/** After a step: W goes up, then click back to the open spot. */
async function afterStep(page, id) {
  const e = await wGoesUp(page, id);
  const d = await clickToMove(page, id, OPEN);
  return `W ${e.toFixed(0)}°, click ${d.toFixed(2)} m`;
}

// --- run ----------------------------------------------------------------------
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
log(`server ${BASE}; data dir ${server.dataDir}${env.CLIENT_DIST ? `; client ${env.CLIENT_DIST}` : ''}`);
await server.start();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
await ctxA.addInitScript(LOW_GFX);
await ctxB.addInitScript(LOW_GFX);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
b.__touch = true;
watch(a, 'A(desktop)');
watch(b, 'B(phone)');
let idA = '';
let idB = '';

try {
  await a.goto(`${BASE}/?autojoin=1`);
  await b.goto(`${BASE}/?autojoin=1`);
  idA = (await waitSnap(a, (s) => s.local?.ready && s.navReady && s.build?.synced, 'A joined', 120_000)).sessionId;
  idB = (await waitSnap(b, (s) => s.local?.ready && s.navReady && s.build?.synced, 'B joined', 120_000)).sessionId;
  await hopToward(a, OPEN, 0.8, 240_000);

  await check('1. desktop HUD shows the two turn buttons with their keys in the tooltip', async () => {
    const l = a.locator('[data-testid=cam-rotate-left]');
    const r = a.locator('[data-testid=cam-rotate-right]');
    assert((await l.isVisible()) && (await r.isVisible()), 'turn buttons not visible on desktop');
    const tl = await l.getAttribute('title');
    const tr = await r.getAttribute('title');
    assert(/\[/.test(tl) && /Q/.test(tl) && /\]/.test(tr) && /R/.test(tr), `tooltips: "${tl}" / "${tr}"`);
    const hit = await a.evaluate(() => [...document.querySelectorAll('[data-testid^=cam-rotate]')].every((el) => {
      const b = el.getBoundingClientRect();
      const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return h === el || el.contains(h);
    }));
    assert(hit, 'turn buttons covered');
    await shot(a, 'desktop-hud-turn-buttons');
    return `"${tl}" / "${tr}"`;
  });

  await check('2. A turns a full circle in four steps with the ↻ button; after each step W goes screen-up and click-to-move arrives', async () => {
    const r0 = (await snap(a)).camera.rotation;
    const notes = [];
    for (let i = 1; i <= 4; i++) {
      await a.click('[data-testid=cam-rotate-right]');
      await settledAt(a, r0 + i, 'button');
      await shot(a, `desktop-orientation-${i % 4}`);
      notes.push(`${i}: ${await afterStep(a, idA)}`);
    }
    return notes.join('; ');
  });

  await check('3. the same with the ] key (and [ back)', async () => {
    const r0 = (await snap(a)).camera.rotation;
    const notes = [];
    for (let i = 1; i <= 4; i++) {
      await a.keyboard.press('BracketRight');
      await settledAt(a, r0 + i, '] key');
      notes.push(`${i}: ${await afterStep(a, idA)}`);
    }
    await a.keyboard.press('BracketLeft');
    await settledAt(a, r0 + 3, '[ key');
    await a.keyboard.press('BracketRight');
    await settledAt(a, r0 + 4, '] key');
    return notes.join('; ');
  });

  await check('4. right-button drag turns the view with the drag and settles to the nearest 90°; middle drag too; context menu held back only while dragging', async () => {
    await a.evaluate(() => {
      window.__ctx = [];
      document.addEventListener('contextmenu', (e) => window.__ctx.push({ prevented: e.defaultPrevented, canvas: e.target?.tagName === 'CANVAS' }), { capture: false });
    });
    const vp = a.viewportSize();
    const cx = vp.width / 2;
    const cy = vp.height / 2 + 120;
    const notes = [];
    let r = (await snap(a)).camera.rotation;
    for (let i = 1; i <= 4; i++) {
      const button = i === 4 ? 'middle' : 'right';
      const y0 = (await snap(a)).camera.yaw;
      await a.mouse.move(cx - 150, cy);
      await a.mouse.down({ button });
      const mid = [];
      for (let k = 1; k <= 10; k++) {
        await a.mouse.move(cx - 150 - k * 22, cy); // drag left 220 px (~76°): one step
        if (k === 6) mid.push((await snap(a)).camera.yaw);
      }
      const during = (await snap(a)).camera.yaw;
      await a.mouse.up({ button });
      // the drag turned the view live (not just on release) …
      assert(Math.abs(norm(during - y0)) > 0.5 && Math.abs(norm(mid[0] - y0)) > 0.15, `${button} drag: yaw ${y0.toFixed(2)} → ${mid[0].toFixed(2)} → ${during.toFixed(2)} while dragging`);
      // … and settles on the nearest side
      r += 1;
      await settledAt(a, r, `${button} drag`);
      notes.push(`${i} (${button}): ${await afterStep(a, idA)}`);
    }
    const ctx = await a.evaluate(() => window.__ctx);
    assert(ctx.every((c) => c.prevented), `a context menu opened while dragging: ${JSON.stringify(ctx)}`);
    // A right-click on the HUD (not the canvas) still gets the browser menu event un-prevented.
    await a.evaluate(() => (window.__ctx = []));
    const btn = await a.locator('[data-testid=player-count]').boundingBox().catch(() => null);
    if (btn) {
      await a.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2, { button: 'right' });
      await sleep(300);
      const c2 = await a.evaluate(() => window.__ctx);
      assert(c2.length === 0 || c2.every((c) => !c.prevented), `context menu suppressed outside the canvas: ${JSON.stringify(c2)}`);
      await a.keyboard.press('Escape');
    }
    return `${notes.join('; ')}; context menu events while dragging: ${ctx.length}, all held back`;
  });

  await check('5. B (touch) turns by the ↻ button and by a two-finger twist (settles to 90°); a pinch zooms and does not turn', async () => {
    const r0 = (await snap(b)).camera.rotation;
    await b.locator('[data-testid=cam-rotate-right]').tap();
    await settledAt(b, r0 + 1, 'touch button');
    await shot(b, 'phone-orientation-button');
    const vp = b.viewportSize();
    const cx = vp.width / 2;
    const cy = vp.height / 2 - 40;
    // Twist 60° clockwise on screen (fingers keep their distance): one step, settled.
    const z0 = (await snap(b)).camera.zoomTarget;
    await twoFinger(b, cx, cy, { r0: 90, r1: 92, a0: 0.3, turn: (60 * Math.PI) / 180 });
    const st = await waitSnap(b, (s) => s.camera.rotation !== r0 + 1 && Math.abs(s.camera.yaw - (BASE_YAW + s.camera.rotation * Q)) < 1e-4, 'twist settled', 15_000);
    assert(Math.abs(st.camera.rotation - (r0 + 1)) === 1, `twist moved ${st.camera.rotation - (r0 + 1)} steps`);
    assert(Math.abs(Math.log(st.camera.zoomTarget / z0)) < 0.05, `the twist zoomed: ${z0} → ${st.camera.zoomTarget}`);
    const r1 = st.camera.rotation;
    // Pinch out (distance 70 → 150 px) with a little incidental turn (7°): zooms, no turn.
    const z1 = st.camera.zoomTarget;
    await twoFinger(b, cx, cy, { r0: 70, r1: 150, a0: 1.2, turn: (7 * Math.PI) / 180 });
    await sleep(1500);
    const sp = await snap(b);
    assert(sp.camera.rotation === r1 && Math.abs(sp.camera.yaw - (BASE_YAW + r1 * Q)) < 1e-4, `the pinch turned the view: rotation ${r1} → ${sp.camera.rotation}, yaw ${sp.camera.yaw}`);
    assert(sp.camera.zoomTarget > z1 * 1.3, `the pinch did not zoom: ${z1} → ${sp.camera.zoomTarget}`);
    await shot(b, 'phone-orientation-twist');
    // tap-to-move still lands after the touch turns
    const me = sp.local;
    const target = { x: me.x + 1.5, z: me.z + 1.0 };
    const d = await clickToMove(b, idB, target);
    return `button → ${r0 + 1}; twist 60° → ${r1} (zoom unchanged); pinch: zoom ${z1.toFixed(0)} → ${sp.camera.zoomTarget.toFixed(0)}, rotation unchanged; tap-to-move ${d.toFixed(2)} m`;
  });

  await check('6. in the Café both turn four times: the cutaway stays open and the player stays on screen at every orientation', async () => {
    await Promise.all([hopInto(a, interiorAnchor('cafe', 'table_3').position, 1.4), hopInto(b, interiorAnchor('cafe', 'table_1').position, 1.6)]);
    const notes = [];
    for (const [page, label, act] of [[a, 'desktop', () => a.keyboard.press('BracketRight')], [b, 'phone', () => b.locator('[data-testid=cam-rotate-right]').tap()]]) {
      const r0 = (await snap(page)).camera.rotation;
      for (let i = 1; i <= 4; i++) {
        await act();
        const s = await settledAt(page, r0 + i, `${label} café`);
        const si = await waitSnap(page, (q) => q.interior?.active === 'cafe' && q.interior.amount > 0.9, `${label}: cutaway open at rotation ${i}`, 10_000);
        const p = await query(page, 'worldToScreen', s.local.x, s.local.z, (getInteractable('station_cafe_piano') ? 0 : 0) + 1);
        const vp = page.viewportSize();
        assert(p && p.x > 20 && p.x < vp.width - 20 && p.y > 40 && p.y < vp.height - 40, `${label}: player off screen at rotation ${i}: ${JSON.stringify(p)}`);
        assert(interiorAt(s.local)?.id === 'cafe', `${label}: not inside`);
        await shot(page, `${label}-cafe-orientation-${(r0 + i) % 4}`);
        notes.push(`${label} ${i}: cutaway ${si.interior.amount}`);
      }
    }
    return notes.join('; ');
  });

  await check('7. build mode: ] turns the view, R still turns the piece; the ghost stays under the still mouse pointer', async () => {
    await hopToward(a, { x: BUILD_AT.x, z: BUILD_AT.z + 2.5 }, 1.2, 240_000);
    await openBuild(a);
    await choosePiece(a, 'sign', { category: 'sign' });
    const vp = a.viewportSize();
    const px = vp.width / 2 + 90;
    const py = vp.height / 2 - 40;
    await a.mouse.move(px, py, { steps: 2 });
    await waitSnap(a, (s) => !!s.build?.ghost, 'ghost', 10_000);
    const rot0 = (await snap(a)).build.rot;
    await a.keyboard.press('KeyR');
    const sR = await waitSnap(a, (s) => s.build.rot !== rot0, 'R turned the piece', 10_000);
    assert(sR.camera.rotation === (await snap(a)).camera.rotation, 'R turned the camera in build mode');
    const notes = [];
    let r = sR.camera.rotation;
    for (let i = 1; i <= 4; i++) {
      await a.keyboard.press('BracketRight');
      r += 1;
      const s = await settledAt(a, r, 'build ]');
      // the ground under the (unmoved) pointer for the settled view, solved from the published camera
      const g = groundUnder(s.view, vp.width, vp.height, px, py);
      const sg = await waitSnap(a, (q) => q.build.ghost && Math.hypot(q.build.ghost.x - g.x, q.build.ghost.z - g.z) < 0.5, `ghost under the pointer after turn ${i}`, 10_000);
      notes.push(`${i}: ghost ${Math.hypot(sg.build.ghost.x - g.x, sg.build.ghost.z - g.z).toFixed(2)} m from the pointer's ground`);
      if (i === 1) await shot(a, 'desktop-build-turned');
    }
    await press(a, '[data-testid=build-done]');
    await waitSnap(a, (s) => s.build.mode === 'off', 'build off', 10_000);
    return notes.join('; ');
  });

  await check('8. seated on a café chair, A turns the view and stays seated', async () => {
    const chair = getInteractable('chair_cafe_in_1b');
    const floorY = getInterior('cafe').floorY ?? 0;
    await hopInto(a, interiorAnchor('cafe', 'table_1').position, 1.6);
    const t0 = Date.now();
    let lastPick = null;
    while (Date.now() - t0 < 90_000) {
      const s = await snap(a);
      if (serverPos(s, idA)?.seat?.startsWith(chair.id)) break;
      const p = await query(a, 'worldToScreen', chair.position.x, chair.position.z, floorY + 0.7); // pick anchors sit 0.7 m up
      lastPick = await query(a, 'pick', p.x, p.y, 'mouse');
      if (lastPick?.id === chair.id) await a.mouse.click(p.x, p.y);
      await sleep(3000);
    }
    await waitSnap(a, (s) => serverPos(s, idA)?.seat?.startsWith(chair.id), `A seated (pick ${JSON.stringify(lastPick)})`, 30_000);
    const r0 = (await snap(a)).camera.rotation;
    await a.click('[data-testid=cam-rotate-left]');
    await settledAt(a, r0 - 1, 'seated button');
    await a.keyboard.press('BracketLeft');
    const s = await settledAt(a, r0 - 2, 'seated [');
    assert(serverPos(s, idA).seat.startsWith(chair.id), 'A stood up');
    await shot(a, 'desktop-seated-turned');
    return `seated on ${serverPos(s, idA).seat}, turned ${r0} → ${r0 - 2}`;
  });

  await check('9. zero console / page errors on both pages', async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
    return 'none';
  });
} catch (err) {
  record('script', false, String(err?.stack ?? err));
} finally {
  await closePanel(a).catch(() => undefined);
  await browser.close().catch(() => undefined);
  await server.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`[camera] ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
