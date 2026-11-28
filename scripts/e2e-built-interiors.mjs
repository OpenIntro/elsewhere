#!/usr/bin/env node
/**
 * Built interiors you can read, end to end: two real browsers against the
 * REAL production build; every piece is placed through the real build UI.
 *
 *   npm run build && npm run e2e:built-interiors
 *
 * Spawns its own production server (scripts/lib/server.mjs; port $BINT_PORT
 * or 2641, fresh temp DATA_DIR unless $BINT_DATA_DIR). Client A: desktop
 * 1440x900 (mouse + keyboard). Client B: Pixel 7 emulation (touch). Low
 * graphics (headless WebGL is software-rendered).
 *
 * Setup (recorded as checks too): A builds a 4 x 4 hut (doorway, a window
 * wall, one house roof) and furnishes it from inside (bed, rug, table + a
 * table lamp on it, a picture on the far wall and one on a camera-facing
 * wall — hung after turning the camera round, as a player would), and a
 * two-storey 2 x 4 hut next to it (two storeys of walls, a house roof).
 *
 * Named checks (PASS/FAIL each; exit 0 only if all pass):
 *  1. A walks in through the doorway (server position inside): cutaway active, the camera-facing walls are cut, the roof fully faded
 *  2. at the same moment B, outside, sees that house whole (no cut, no fade on its pieces)
 *  3. A turns the camera four times (Q): the cut walls follow the camera-facing faces each time
 *  4. the picture on the cut wall is hidden; the far-wall picture and all furniture are visible (and pickable)
 *  5. A stands on the threshold for 3 s: at most one active/inactive toggle (hysteresis)
 *  6. A walks out: within 1 s of being outside nothing of the house is cut or faded
 *  7. B walks in by tap-to-move and gets the cutaway on the phone
 *  8. on the two-storey hut's ground floor every storey-1+ piece of it is hidden for A
 *  9. inside, A aims through a cut wall and places a table lamp on the table behind it; B sees the lamp
 * 10. build draw calls inside == outside (same pieces) == the count before built interiors existed (BINT_BASELINE_DRAWCALLS)
 * 11. zero console / page errors on both pages
 *
 * Env: BINT_PORT, BINT_DATA_DIR, BINT_SHOTS (screenshot dir), BINT_VERBOSE=1,
 * BINT_BASELINE_DRAWCALLS (default: the count measured on the build before
 * this feature for exactly this scene, see README "Player building").
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG, PIECES } from '@elsewhere/shared';
import { assert, buildState, choosePiece, hopToward, openBuild, closeBuild, placeHere, press, query, rotateTo, screenOf, sleep, snap, waitSnap, zoomOut, aimGhost } from './lib/browser.mjs';

/** The 4 × 4 hut: wall lines x −20..−16, z −1..3 (the open meadow west of the Town Square). */
export const HUT = { x0: -20, z0: -1, x1: -16, z1: 3, x: -18, z: 1 };
/** The two-storey 2 × 4 hut beside it: wall lines x −23..−21, z −2..2. */
export const TWO = { x0: -23, z0: -2, x1: -21, z1: 2, x: -22, z: 0 };

/** Every piece of the scene, by role (coordinates on the build grid; mounts: the wall's centre + the face they look out of). */
export function interiorScene() {
  const v = 'cream';
  const hutWalls = {
    north: [{ kind: 'wall', x: -19, z: -1, rot: 0 }, { kind: 'wall', x: -17, z: -1, rot: 0 }],
    south: [{ kind: 'doorway', x: -19, z: 3, rot: 0 }, { kind: 'wall_window', x: -17, z: 3, rot: 0 }],
    west: [{ kind: 'wall', x: -20, z: 0, rot: 1 }, { kind: 'wall', x: -20, z: 2, rot: 1 }],
    east: [{ kind: 'wall', x: -16, z: 0, rot: 1 }, { kind: 'wall', x: -16, z: 2, rot: 1 }],
  };
  for (const side of Object.values(hutWalls)) for (const w of side) Object.assign(w, { level: 0, variant: v });
  const twoGround = [
    { kind: 'wall', x: -22, z: -2, rot: 0 },
    { kind: 'doorway', x: -22, z: 2, rot: 0 },
    { kind: 'wall', x: -23, z: -1, rot: 1 },
    { kind: 'wall', x: -23, z: 1, rot: 1 },
    { kind: 'wall', x: -21, z: -1, rot: 1 },
    { kind: 'wall', x: -21, z: 1, rot: 1 },
  ].map((w) => ({ ...w, level: 0, variant: 'sage' }));
  const twoUpper = twoGround.map((w) => ({ ...w, kind: w.kind === 'doorway' ? 'wall_window' : w.kind, level: 1 }));
  return {
    hutWalls,
    hutRoof: { kind: 'house_roof', x: HUT.x, z: HUT.z, rot: 0, level: 1, variant: 'clay', params: { w: 4, d: 4, style: 'gable', pitch: 1 } },
    furniture: [
      { kind: 'bed', x: -18.5, z: 0, rot: 1, level: 0, variant: 'sage' },
      { kind: 'rug', x: -18.5, z: 1.5, rot: 0, level: 0, variant: 'madder' },
      { kind: 'table', x: -17, z: 1.5, rot: 1, level: 0, variant: 'oak' },
    ],
    lamp: { kind: 'table_lamp', x: -17, z: 2, rot: 0, level: 0, variant: 'ochre' },
    /** On the far (north) wall's inner face at the default camera. */
    farPicture: { kind: 'picture', x: -19, z: -1, rot: 0, level: 0, variant: 'meadow' },
    /** On the east wall's inner face: a camera-facing wall at the default camera. */
    nearPicture: { kind: 'picture', x: -16, z: 0, rot: 3, level: 0, variant: 'harbour' },
    /** Check 9: on the same table, aimed at from inside through the cut east wall. */
    lamp2: { kind: 'table_lamp', x: -17, z: 1, rot: 0, level: 0, variant: 'blue' },
    twoGround,
    twoUpper,
    twoRoof: { kind: 'house_roof', x: TWO.x, z: TWO.z, rot: 0, level: 2, variant: 'slate', params: { w: 2, d: 4, style: 'gable', pitch: 1 } },
  };
}

/** Outward normal of each side of a rectangle of walls. */
const SIDE_NORMAL = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, east: { x: 1, z: 0 } };
/** Sides of the hut facing a camera at `yaw` (camera at +(sin yaw, cos yaw) from the focus), independent of the client's code. */
export function facingSides(yaw) {
  const cx = Math.sin(yaw);
  const cz = Math.cos(yaw);
  return Object.entries(SIDE_NORMAL)
    .filter(([, n]) => n.x * cx + n.z * cz > 0.26)
    .map(([s]) => s)
    .sort();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

async function main() {
  const { createServer } = await import('./lib/server.mjs');
  const { resultFile, shotsDir } = await import('./lib/report.mjs');
  const { chromium, devices } = createRequire(import.meta.url)('playwright');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const PORT = Number(process.env.BINT_PORT ?? 2641);
  const SHOTS = shotsDir(process.env.BINT_SHOTS, null, ROOT);
  // Measured with this scene on the production build before built interiors (draw calls depend only on the piece set).
  const BASELINE = Number(process.env.BINT_BASELINE_DRAWCALLS ?? 19);
  const server = createServer({ port: PORT, label: 'bint', verbose: !!process.env.BINT_VERBOSE, tmpPrefix: 'elsewhere-bint-', ...(process.env.BINT_DATA_DIR ? { dataDir: process.env.BINT_DATA_DIR } : {}) });
  const BASE = server.url;

  const log = (...a) => console.log('[bint]', ...a);
  const pageErrors = [];
  const out = resultFile('built-interiors', () => pageErrors);
  const results = [];
  let a;
  let b;
  function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    out.add(name, ok, detail);
    console.log(`[bint] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  }
  async function check(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      record(name, true, `${detail ?? ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`.trim());
    } catch (err) {
      record(name, false, String(err?.message ?? err));
      for (const page of [a, b]) {
        if (page && (await page.locator('[data-testid=build-done]').isVisible().catch(() => false))) await press(page, '[data-testid=build-done]').catch(() => undefined);
      }
    }
  }
  function watch(page, label) {
    page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && pageErrors.push(`${label} console.error: ${m.text()}`));
  }
  async function shot(page, name) {
    if (!SHOTS) return;
    await page.screenshot({ path: path.join(SHOTS, `${name}.jpg`), type: 'jpeg', quality: 80 }).catch((e) => log('screenshot failed', name, e.message));
  }

  const scene = interiorScene();
  const sameIds = (x, y) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  const findPiece = (pieces, p) => pieces.find((q) => q.kind === p.kind && q.x === p.x && q.z === p.z && q.level === (p.level ?? 0) && (p.rot === undefined || q.rot === p.rot));
  const ids = { hutSides: {}, hut: [], two: [], roof: null, far: null, near: null, furniture: [], lamp: null, table: null };
  function learnIds(pieces) {
    for (const [side, list] of Object.entries(scene.hutWalls)) ids.hutSides[side] = list.map((w) => findPiece(pieces, w)?.id).filter(Boolean);
    const inRect = (p, r, m) => p.x >= r.x0 - m && p.x <= r.x1 + m && p.z >= r.z0 - m && p.z <= r.z1 + m;
    ids.hut = pieces.filter((p) => inRect(p, HUT, 0.3)).map((p) => p.id);
    ids.two = pieces.filter((p) => inRect(p, TWO, 0.3) && p.level >= 1).map((p) => p.id);
    ids.roof = findPiece(pieces, scene.hutRoof)?.id ?? null;
    ids.far = findPiece(pieces, scene.farPicture)?.id ?? null;
    ids.near = findPiece(pieces, scene.nearPicture)?.id ?? null;
    ids.table = findPiece(pieces, scene.furniture[2])?.id ?? null;
    ids.lamp = findPiece(pieces, scene.lamp)?.id ?? null;
    ids.furniture = [...scene.furniture, scene.lamp].map((f) => findPiece(pieces, f)?.id).filter(Boolean);
  }
  /** The hut's walls that must be cut for a camera yaw (independent geometry: sides whose outward normal faces the camera). */
  const expectedCut = (yaw) => facingSides(yaw).flatMap((s) => ids.hutSides[s]).sort();
  const cutOf = (s) => s.builtCutaway;
  const depthIn = (r, p) => Math.min(p.x - r.x0, r.x1 - p.x, p.z - r.z0, r.z1 - p.z);
  const touched = (c, list) => list.filter((id) => (c.cut[id] ?? 0) > 0 || (c.fade[id] ?? 0) > 0);

  /** Place a planned piece through the UI (palette, style, rotation, aim, click). */
  async function build(page, item, opts = {}) {
    await choosePiece(page, item.kind, { category: PIECES[item.kind].category, variant: item.variant });
    if (!PIECES[item.kind].mount && PIECES[item.kind].param !== 'roof') await rotateTo(page, item.rot ?? 0);
    const p = await placeHere(page, item.x, item.z, opts.y, { level: item.level ?? 0, aim: opts.aim });
    assert(p.kind === item.kind && p.x === item.x && p.z === item.z && p.level === (item.level ?? 0) && (item.rot === undefined || p.rot === item.rot), `placed ${JSON.stringify(p)} for ${JSON.stringify(item)}`);
    return p;
  }
  async function buildRoof(page, roof) {
    await choosePiece(page, 'house_roof', { category: 'roof', variant: roof.variant });
    await press(page, '[data-testid=build-roof-gable]');
    await press(page, '[data-testid=build-pitch-1]');
    const st0 = await buildState(page);
    if (st0.rot % 2 !== roof.rot % 2) await press(page, '[data-testid=build-rotate]');
    const below = st0.pieces.filter((p) => p.level === roof.level - 1 && PIECES[p.kind].structural && Math.abs(p.x - roof.x) <= roof.params.w / 2 + 0.5 && Math.abs(p.z - roof.z) <= roof.params.d / 2 + 0.5);
    const top = Math.max(...below.map((p) => p.y)) + CONFIG.building.storeyHeight;
    const g = await aimGhost(page, roof.x, roof.z, top, { level: roof.level });
    const params = JSON.parse(g.build.ghost.params);
    assert(g.build.ghost.ok && params.w === roof.params.w && params.d === roof.params.d, `roof ghost ${JSON.stringify(g.build.ghost)}`);
    return placeHere(page, roof.x, roof.z, top, { level: roof.level });
  }
  /** A mount on the inner face of a wall (pointed at from inside, like a player would). */
  async function hang(page, item, wall) {
    const n = item.rot % 2 === 0 ? { x: 0, z: item.rot === 0 ? 1 : -1 } : { x: item.rot === 1 ? 1 : -1, z: 0 };
    return build(page, item, { y: wall.y + 1.5, aim: { x: item.x + n.x * 0.14, z: item.z + n.z * 0.14 } });
  }
  /** Q (or [, the same turn): the camera turns a quarter; resolves with the new yaw once it has stopped turning. */
  async function turn(page, key = 'KeyQ') {
    const y0 = (await snap(page)).view.yaw;
    await page.keyboard.press(key);
    await waitSnap(page, (x) => Math.abs(x.view.yaw - y0) > 1.2, 'camera turned', 15_000);
    let last = (await snap(page)).view.yaw;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const y = (await snap(page)).view.yaw;
      if (Math.abs(y - last) < 1e-4) return y;
      last = y;
    }
    throw new Error(`camera still turning (yaw ${last})`);
  }
  async function waitCut(page, label, pred, timeout = 20_000) {
    return waitSnap(page, (s) => cutOf(s) && pred(cutOf(s), s), label, timeout).catch(async (err) => {
      const s = await snap(page);
      const c = cutOf(s);
      throw new Error(`${err.message}; cutaway ${JSON.stringify({ active: c?.active, rect: c?.rect, cutIds: c?.cutIds, hiddenIds: c?.hiddenIds, settled: c?.settled })} yaw ${s.view.yaw.toFixed(2)} at (${s.local.x.toFixed(2)}, ${s.local.z.toFixed(2)})`);
    });
  }

  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  log(`data dir ${server.dataDir}; server ${BASE}`);
  await server.start();
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const LOW_GFX = `try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ ...devices['Pixel 7'] });
  await ctxA.addInitScript(LOW_GFX);
  await ctxB.addInitScript(LOW_GFX);
  a = await ctxA.newPage();
  b = await ctxB.newPage();
  b.__touch = true;
  watch(a, 'A(desktop)');
  watch(b, 'B(phone)');

  const STAND = { x: -19.5, z: 5.5 };
  const INSIDE_A = { x: -18.6, z: 1.7 };
  const INSIDE_B = { x: -19.3, z: 2.0 };
  const OUTSIDE_A = { x: -19, z: 5.3 };
  const OUTSIDE_B = { x: -12.5, z: 6.5 };
  let idA = '';
  let drawInside = null;
  let drawOutside = null;

  try {
    await check('setup: A and B join the same world', async () => {
      await a.goto(`${BASE}/?autojoin=1`);
      await b.goto(`${BASE}/?autojoin=1`);
      const sa = await waitSnap(a, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.navReady && s.builtCutaway, 'A ready');
      await waitSnap(b, (s) => s.local?.ready && s.players.length >= 2 && s.build?.synced && s.navReady && s.builtCutaway, 'B ready');
      idA = sa.sessionId;
      return `A=${idA}`;
    });

    await check('setup: B goes to its spot outside; A builds the two-storey hut first (it stands behind the 4 x 4 hut from the camera)', async () => {
      await hopToward(b, OUTSIDE_B, 1.2);
      await hopToward(a, STAND, 1.0);
      await zoomOut(a, 2);
      await openBuild(a);
      for (const w of scene.twoGround) await build(a, w);
      const top = Math.max(...(await buildState(a)).pieces.filter((p) => p.level === 0 && p.x <= TWO.x1 + 0.1).map((p) => p.y)) + CONFIG.building.storeyHeight;
      // The storey control: lock Storey 2, then aim along the wall lines.
      await a.click('[data-testid=build-storey-up]');
      let ls = await waitSnap(a, (s) => s.build.lockLevel !== null, 'storey locked', 10_000);
      while (ls.build.lockLevel < 1) {
        await a.click('[data-testid=build-storey-up]');
        ls = await waitSnap(a, (s) => s.build.lockLevel >= 1, 'storey 2', 10_000);
      }
      while (ls.build.lockLevel > 1) {
        await a.click('[data-testid=build-storey-down]');
        ls = await waitSnap(a, (s) => s.build.lockLevel === 1, 'storey 2', 10_000);
      }
      for (const w of scene.twoUpper) await build(a, w, { y: top });
      await a.click('[data-testid=build-storey-label]');
      await waitSnap(a, (s) => s.build.lockLevel === null, 'storey automatic', 10_000);
      const roof = await buildRoof(a, scene.twoRoof);
      return `${scene.twoGround.length} + ${scene.twoUpper.length} walls, roof ${roof.id} ${roof.params} (level ${roof.level})`;
    });

    await check('setup: A builds the 4 x 4 hut beside it (doorway, window wall, house roof)', async () => {
      const order = [...scene.hutWalls.north, ...scene.hutWalls.west, ...scene.hutWalls.east, ...scene.hutWalls.south];
      for (const w of order) await build(a, w);
      const roof = await buildRoof(a, scene.hutRoof);
      await closeBuild(a);
      return `${order.length} walls + roof ${roof.id} ${roof.params}`;
    });

    await check('setup: A walks in and furnishes the hut (bed, rug, table + lamp, a far-wall and a camera-side picture)', async () => {
      await hopToward(a, { x: -19, z: 4.6 }, 0.8);
      await hopToward(a, INSIDE_A, 0.45, 120_000);
      await openBuild(a);
      const placed = [];
      for (const f of scene.furniture) placed.push((await build(a, f)).kind);
      const table = findPiece((await buildState(a)).pieces, scene.furniture[2]);
      placed.push((await build(a, scene.lamp, { y: table.y + PIECES.table.h })).kind);
      const st = await buildState(a);
      const north = findPiece(st.pieces, scene.hutWalls.north[0]);
      placed.push(`${(await hang(a, scene.farPicture, north)).kind}@far`);
      // The east wall faces the camera (it is cut): turn the camera round so it is the far wall, hang the picture, turn back.
      const y0 = (await snap(a)).view.yaw;
      await turn(a);
      await turn(a);
      const east = findPiece(st.pieces, scene.hutWalls.east[0]);
      placed.push(`${(await hang(a, scene.nearPicture, east)).kind}@camera-side`);
      await turn(a);
      await turn(a);
      const y1 = (await snap(a)).view.yaw;
      assert(Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0))) < 0.05, `camera did not come back: ${y0} → ${y1}`);
      await closeBuild(a);
      await hopToward(a, OUTSIDE_A, 0.6, 120_000);
      const s = await snap(a);
      learnIds(s.build.pieces);
      assert(ids.hut.length === 15 && ids.two.length === 7 && ids.far && ids.near && ids.table && ids.lamp, `scene ids ${JSON.stringify(ids)}`);
      assert(!cutOf(s).active, 'cutaway still active outside');
      return placed.join(', ');
    });

    await check('1. A walks in through the doorway (server position inside): cutaway active, camera-facing walls cut, roof fully faded', async () => {
      await hopToward(a, INSIDE_A, 0.45, 120_000);
      const s0 = await snap(a);
      const me = s0.players.find((p) => p.id === idA);
      assert(me && depthIn(HUT, me) >= 0.3, `server position not inside: ${JSON.stringify(me)}`);
      const want = expectedCut(s0.view.yaw);
      const s = await waitCut(a, 'A cutaway settled', (c) => c.active && sameIds(c.cutIds, want) && c.settled && (c.fade[ids.roof] ?? 0) >= 0.999);
      const c = cutOf(s);
      const far = facingSides(s.view.yaw).length === 2 ? Object.keys(SIDE_NORMAL).filter((k) => !facingSides(s.view.yaw).includes(k)).flatMap((k) => ids.hutSides[k]) : [];
      assert(touched(c, far).length === 0, `far walls touched: ${touched(c, far)}`);
      for (const id of want) assert((c.cut[id] ?? 0) >= 0.999, `${id} cut ${c.cut[id]}`);
      drawInside = s.buildRender.drawCalls;
      await shot(a, 'bint-01-A-inside');
      return `server (${me.x.toFixed(2)}, ${me.z.toFixed(2)}); yaw ${s.view.yaw.toFixed(2)} → cut ${c.cutIds.join(',')} (sides ${facingSides(s.view.yaw)}); roof fade ${c.fade[ids.roof]}; far walls whole; drawCalls ${drawInside}`;
    });

    await check('2. at the same moment B, outside, sees that house whole (no cut, no fade on its pieces)', async () => {
      const [sa, sb] = await Promise.all([snap(a), snap(b)]);
      assert(cutOf(sa).active, 'A no longer inside');
      const cb = cutOf(sb);
      assert(!cb.active && cb.cutIds.length === 0 && cb.hiddenIds.length === 0, `B cutaway ${JSON.stringify(cb).slice(0, 300)}`);
      const t = touched(cb, ids.hut);
      assert(t.length === 0, `B: house pieces cut/faded: ${t.map((id) => `${id} cut ${cb.cut[id] ?? 0} fade ${cb.fade[id] ?? 0}`)}`);
      await shot(b, 'bint-02-B-outside');
      return `B at (${sb.local.x.toFixed(1)}, ${sb.local.z.toFixed(1)}): inactive, 0 of ${ids.hut.length} house pieces cut or faded (A: ${cutOf(sa).cutIds.length} cut)`;
    });

    await check('3. A turns the camera four times (Q, [, Q, [): the cut walls follow the camera-facing faces each time', async () => {
      const outL = [];
      for (let k = 0; k < 4; k++) {
        const yaw = await turn(a, k % 2 ? 'BracketLeft' : 'KeyQ');
        const want = expectedCut(yaw);
        const s = await waitCut(a, `rotation ${k + 1}`, (c) => c.active && sameIds(c.cutIds, want) && c.settled);
        const c = cutOf(s);
        const others = ids.hut.filter((id) => ![...want, ...c.hiddenIds].includes(id));
        assert(others.every((id) => !(c.cut[id] > 0)), `rotation ${k + 1}: other pieces cut ${others.filter((id) => c.cut[id] > 0)}`);
        if (k === 0) await shot(a, 'bint-03-A-rotated');
        outL.push(`${((((yaw * 180) / Math.PI) % 360) + 360) % 360 | 0}°: ${facingSides(yaw).join('+')}`);
      }
      return outL.join('; ');
    });

    await check('4. the picture on the cut wall is hidden; the far-wall picture and all furniture are visible', async () => {
      const s = await snap(a);
      const c = cutOf(s);
      const sides = facingSides(s.view.yaw);
      const nearWall = findPiece(s.build.pieces, scene.hutWalls.east[0]);
      const farWall = findPiece(s.build.pieces, scene.hutWalls.north[0]);
      assert(sides.includes('east') && !sides.includes('north'), `unexpected camera sides ${sides}`);
      assert(c.cutIds.includes(nearWall.id) && !c.cutIds.includes(farWall.id), 'walls');
      assert(c.hiddenIds.includes(ids.near) && (c.cut[ids.near] ?? 0) >= 0.999, `camera-side picture not hidden: cut ${c.cut[ids.near]}`);
      for (const id of [ids.far, ...ids.furniture]) assert(!c.hiddenIds.includes(id) && !c.cutIds.includes(id) && !(c.cut[id] > 0) && !(c.fade[id] > 0), `${id} is not fully visible`);
      // What the player sees is what they can point at: the far picture and the bed under the cursor.
      const far = findPiece(s.build.pieces, scene.farPicture);
      const fp = await screenOf(a, far.x, far.z + 0.15, far.y + 1.8);
      const hitFar = await query(a, 'pickPiece', fp.x, fp.y);
      const bed = findPiece(s.build.pieces, scene.furniture[0]);
      const bp = await screenOf(a, bed.x, bed.z, bed.y + 0.62);
      const hitBed = await query(a, 'pickPiece', bp.x, bp.y);
      assert(hitFar?.id === ids.far, `far picture not under the cursor: ${JSON.stringify(hitFar)}`);
      assert(hitBed?.id === bed.id, `bed not under the cursor: ${JSON.stringify(hitBed)}`);
      await shot(a, 'bint-04-A-pictures');
      return `hidden ${c.hiddenIds.length} (${ids.near} cut ${c.cut[ids.near]}); visible: far picture (picked), ${ids.furniture.length} furniture pieces, bed picked`;
    });

    await check('5. A stands on the threshold for 3 s: at most one active/inactive toggle', async () => {
      await hopToward(a, { x: -19, z: HUT.z1 }, 0.35, 90_000);
      await sleep(600);
      const s0 = await snap(a);
      const t0 = cutOf(s0).toggles;
      const zs = [];
      const states = [];
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const s = await snap(a);
        zs.push(s.local.z);
        states.push(cutOf(s).active);
        await sleep(150);
      }
      const s1 = await snap(a);
      const n = cutOf(s1).toggles - t0;
      assert(n <= 1, `${n} toggles in 3 s on the threshold`);
      return `${zs.length} samples at z ${Math.min(...zs).toFixed(2)}..${Math.max(...zs).toFixed(2)} (wall line ${HUT.z1}); active ${[...new Set(states)].join('/')}; toggles ${n}`;
    });

    await check('6. A walks out: within 1 s of being outside nothing of the house is cut or faded', async () => {
      await a.evaluate((list) => {
        const set = new Set(list);
        const w = window;
        w.__bint = [];
        w.__bintT = setInterval(() => {
          const s = w.__ELSEWHERE__.snapshot();
          const c = s.builtCutaway;
          let n = 0;
          for (const id of Object.keys(c.cut)) if (set.has(id)) n++;
          for (const id of Object.keys(c.fade)) if (set.has(id)) n++;
          w.__bint.push({ t: performance.now(), x: s.local.x, z: s.local.z, active: c.active, n });
        }, 50);
      }, ids.hut);
      await hopToward(a, OUTSIDE_A, 0.6, 90_000);
      await sleep(1500);
      const samples = await a.evaluate(() => {
        clearInterval(window.__bintT);
        return window.__bint;
      });
      const leave = samples.find((p) => p.z >= HUT.z1 + 0.6);
      assert(leave, `never 0.6 m outside (last z ${samples.at(-1)?.z})`);
      const clear = samples.find((p) => p.t >= leave.t && !p.active && p.n === 0);
      assert(clear, `still cut/faded at the end: ${JSON.stringify(samples.at(-1))}`);
      const dt = clear.t - leave.t;
      const s = await snap(a);
      drawOutside = s.buildRender.drawCalls;
      assert(dt <= 1000, `${Math.round(dt)} ms from 0.6 m outside to nothing cut/faded`);
      return `0.6 m outside at z ${leave.z.toFixed(2)}; clear after ${Math.round(dt)} ms (${samples.length} samples); drawCalls outside ${drawOutside}`;
    });

    await check('7. B walks in by tap-to-move and gets the cutaway on the phone', async () => {
      await hopToward(b, { x: -18.6, z: 4.8 }, 1.0, 150_000);
      await hopToward(b, INSIDE_B, 0.5, 150_000);
      const s0 = await snap(b);
      const want = expectedCut(s0.view.yaw);
      const s = await waitCut(b, 'B cutaway', (c) => c.active && sameIds(c.cutIds, want) && c.settled && (c.fade[ids.roof] ?? 0) >= 0.999);
      await shot(b, 'bint-07-B-inside');
      const sa = await snap(a);
      assert(!cutOf(sa).active, 'A (outside) has a cutaway');
      return `B at (${s.local.x.toFixed(2)}, ${s.local.z.toFixed(2)}), yaw ${s.view.yaw.toFixed(2)}: cut ${cutOf(s).cutIds.join(',')}; roof gone; A outside unaffected`;
    });

    await check("8. on the two-storey hut's ground floor every storey-1+ piece of it is hidden for A", async () => {
      await hopToward(a, { x: TWO.x, z: TWO.z1 + 1.4 }, 0.6, 120_000);
      await hopToward(a, { x: TWO.x, z: TWO.z + 0.2 }, 0.45, 120_000);
      const s = await waitCut(a, 'two-storey cutaway', (c) => c.active && c.rect && Math.abs(c.rect.minX - TWO.x0) < 0.01 && Math.abs(c.rect.maxZ - TWO.z1) < 0.01 && c.settled);
      const c = cutOf(s);
      assert(ids.two.length === 7, `expected 6 upper walls + a roof on the two-storey hut, found ${ids.two.length}`);
      const missing = ids.two.filter((id) => !c.hiddenIds.includes(id));
      assert(missing.length === 0, `storey-1+ pieces not hidden: ${missing}`);
      for (const id of ids.two) assert((c.fade[id] ?? 0) >= 0.999, `${id} fade ${c.fade[id]}`);
      assert(c.storey === 0, `storey ${c.storey}`);
      await shot(a, 'bint-08-A-two-storey');
      return `storey ${c.storey}, rect ${JSON.stringify(c.rect)}; hidden ${ids.two.length}/${ids.two.length} upper pieces (+ ${c.hiddenIds.length - ids.two.length} mounts); cut ${c.cutIds.length} walls`;
    });

    await check('9. inside, A aims through a cut wall and places a table lamp on the table behind it; B sees the lamp', async () => {
      await hopToward(a, { x: -19, z: 4.6 }, 0.8, 120_000);
      await hopToward(a, INSIDE_A, 0.45, 120_000);
      const s0 = await waitCut(a, 'A inside again', (c) => c.active && c.settled && c.rect && Math.abs(c.rect.minX - HUT.x0) < 0.01);
      const c0 = cutOf(s0);
      await openBuild(a);
      await choosePiece(a, scene.lamp2.kind, { category: PIECES[scene.lamp2.kind].category, variant: scene.lamp2.variant });
      const table = findPiece(s0.build.pieces, scene.furniture[2]);
      const topY = table.y + PIECES.table.h;
      const pt = await screenOf(a, scene.lamp2.x, scene.lamp2.z, topY);
      const ray = await query(a, 'rayPieces', pt.x, pt.y);
      const ti = ray.findIndex((h) => h.id === table.id);
      const wallHit = ray.slice(0, Math.max(0, ti)).find((h) => c0.cutIds.includes(h.id));
      assert(ti > 0 && wallHit, `the ray to the table top does not pass a cut wall first: ${JSON.stringify(ray)}`);
      assert(wallHit.cut !== null && wallHit.y > wallHit.cut, `the ray meets ${wallHit.id} below its cut: ${JSON.stringify(wallHit)}`);
      const pick = await query(a, 'pickPiece', pt.x, pt.y);
      assert(pick?.id === table.id, `picking does not look through the cut: ${JSON.stringify(pick)}`);
      const lamp = await placeHere(a, scene.lamp2.x, scene.lamp2.z, topY, { level: 0 });
      assert(lamp.kind === 'table_lamp' && Math.abs(lamp.y - topY) < 0.02, `lamp ${JSON.stringify(lamp)}; table top ${topY}`);
      await closeBuild(a);
      await waitSnap(b, (s) => s.build.pieces.some((p) => p.id === lamp.id && p.y === lamp.y), 'B sees the lamp', 20_000);
      await shot(a, 'bint-09-A-lamp');
      return `ray: ${wallHit.id} hit at y ${wallHit.y} above its cut ${wallHit.cut} → looked through → table ${table.id}; lamp ${lamp.id} at y ${lamp.y} (table top ${topY.toFixed(2)}); B has it`;
    });

    await check('10. build draw calls inside == outside (same pieces) == before built interiors', async () => {
      assert(drawInside !== null && drawOutside !== null, `not measured: inside ${drawInside}, outside ${drawOutside}`);
      assert(drawInside === drawOutside, `inside ${drawInside} vs outside ${drawOutside}`);
      assert(drawInside === BASELINE, `inside/outside ${drawInside} vs ${BASELINE} before this feature`);
      return `inside ${drawInside}, outside ${drawOutside}, before ${BASELINE}`;
    });

    await check('11. zero console / page errors on both pages', async () => {
      assert(pageErrors.length === 0, pageErrors.slice(0, 6).join(' | '));
      return 'none';
    });
  } catch (err) {
    record('script', false, String(err?.stack ?? err));
  } finally {
    await browser.close().catch(() => undefined);
    await server.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[bint] ${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
  process.exit(process.exitCode);
}
