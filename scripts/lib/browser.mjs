/**
 * Shared Playwright helpers for the browser scripts (e2e-build, build-screenshots,
 * build-scale): snapshot polling, click/tap-to-move hops, keyboard walking along
 * an A* route over the shared collision, and the real build UI (palette, ghost
 * aiming by hover or tap, Place / Rotate buttons). Every action is a real input
 * in a real page; nothing here talks to the server directly.
 */
import { CONFIG, isWalkable } from '@elsewhere/shared';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const snap = (page) => page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
export const query = (page, name, ...args) => page.evaluate(([n, a]) => window.__ELSEWHERE__.query(n, ...a), [name, args]);
export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export async function waitSnap(page, pred, label, timeout = 90_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await snap(page).catch(() => null);
    if (last && pred(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}; last local ${JSON.stringify(last?.local)} build ${JSON.stringify(last?.build ? { ...last.build, pieces: undefined } : null).slice(0, 400)}`);
}

export async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
}

/** Screen point of a world point (ground height by default) that lands on the canvas. */
export async function screenOf(page, x, z, y) {
  const p = await query(page, 'worldToScreen', x, z, y);
  assert(p, `no screen point for (${x.toFixed(1)}, ${z.toFixed(1)})`);
  const vp = page.viewportSize();
  assert(p.x > 6 && p.y > 6 && p.x < vp.width - 6 && p.y < vp.height - 6, `(${x.toFixed(1)}, ${z.toFixed(1)}) is off screen at ${p.x.toFixed(0)},${p.y.toFixed(0)}`);
  assert(await onCanvas(page, p.x, p.y), `UI covers ${p.x.toFixed(0)},${p.y.toFixed(0)} (world ${x.toFixed(1)}, ${z.toFixed(1)})`);
  return p;
}

/** Click (desktop) or tap (touch) a UI element. */
export async function press(page, sel) {
  if (page.__touch) await page.locator(sel).tap();
  else await page.click(sel);
}

export async function tapOrClick(page, x, y) {
  if (page.__touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/** Click/tap-to-move in hops towards a far target (the camera follows), until within `near`. */
export async function hopToward(page, target, near = 1.5, timeout = 150_000) {
  const vp = page.viewportSize();
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (Math.hypot(s.local.x - target.x, s.local.z - target.z) < near) return s;
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    const tp = await query(page, 'worldToScreen', target.x, target.z);
    let x = tp.x;
    let y = tp.y;
    const m = 0.18;
    const inside = (px, py) => px > vp.width * m && px < vp.width * (1 - m) && py > vp.height * m && py < vp.height * (1 - m);
    if (!inside(x, y)) {
      let k = 1;
      for (; k > 0.05; k -= 0.05) if (inside(me.x + (tp.x - me.x) * k, me.y + (tp.y - me.y) * k)) break;
      x = me.x + (tp.x - me.x) * k;
      y = me.y + (tp.y - me.y) * k;
    }
    if (!(await onCanvas(page, x, y))) y -= 40;
    await tapOrClick(page, x, y);
    await sleep(300);
    await waitSnap(page, (q) => !q.motion?.path && q.local.speed < 0.05, 'hop finished', 40_000);
  }
  throw new Error(`could not hop to (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
}

/** A* on a 0.25 m grid over the shared collision (+ optional extra blockers), string-pulled. */
export function route(from, to, blocked = () => false) {
  const G = 0.25;
  const r = CONFIG.movement.playerRadius + 0.06;
  const key = (i, j) => `${i},${j}`;
  const pt = (i, j) => ({ x: i * G, z: j * G });
  const walk = new Map();
  const free = (p, rr) => isWalkable(p, rr) && !blocked(p, rr);
  const ok = (i, j) => {
    const k = key(i, j);
    if (!walk.has(k)) walk.set(k, free(pt(i, j), r));
    return walk.get(k);
  };
  const si = Math.round(from.x / G);
  const sj = Math.round(from.z / G);
  const ti = Math.round(to.x / G);
  const tj = Math.round(to.z / G);
  const h = (i, j) => Math.hypot(i - ti, j - tj) * G;
  const open = [[h(si, sj), 0, si, sj]];
  const came = new Map([[key(si, sj), null]]);
  const cost = new Map([[key(si, sj), 0]]);
  for (let iter = 0; open.length && iter < 60_000; iter++) {
    let bi = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[bi][0]) bi = n;
    const [, g, i, j] = open.splice(bi, 1)[0];
    if (i === ti && j === tj) {
      const out = [];
      for (let k = key(i, j); k; k = came.get(k)) {
        const [a, b] = k.split(',').map(Number);
        out.unshift(pt(a, b));
      }
      out.push(to);
      const clear = (p, q) => {
        const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.1);
        for (let k = 1; k < n; k++) if (!free({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n }, r + 0.05)) return false;
        return true;
      };
      const pulled = [];
      let at = 0;
      while (at < out.length - 1) {
        let j2 = out.length - 1;
        while (j2 > at + 1 && !clear(out[at], out[j2])) j2--;
        pulled.push(out[j2]);
        at = j2;
      }
      return pulled;
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (!ok(ni, nj) || (di && dj && (!ok(i + di, j) || !ok(i, j + dj)))) continue;
      const ng = g + Math.hypot(di, dj) * G;
      const k = key(ni, nj);
      if (ng < (cost.get(k) ?? Infinity)) {
        cost.set(k, ng);
        came.set(k, key(i, j));
        open.push([ng + h(ni, nj), ng, ni, nj]);
      }
    }
  }
  return [to];
}

/**
 * Keyboard walking towards waypoints: every step pick the camera-relative
 * W/A/S/D combination closest to the direction of the next waypoint.
 */
export async function keyboardWalk(page, waypoints, { reach = 0.45, timeout = 40_000 } = {}) {
  const held = new Set();
  const press = async (keys) => {
    for (const k of [...held])
      if (!keys.has(k)) {
        await page.keyboard.up(k);
        held.delete(k);
      }
    for (const k of keys)
      if (!held.has(k)) {
        await page.keyboard.down(k);
        held.add(k);
      }
  };
  const t0 = Date.now();
  try {
    for (const wp of waypoints) {
      let last = null;
      let stall = 0;
      let nudge = 0;
      for (;;) {
        const s = await snap(page);
        if (Date.now() - t0 > timeout) {
          const focus = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`);
          throw new Error(`keyboard walk timed out before (${wp.x.toFixed(1)}, ${wp.z.toFixed(1)}); at (${s.local.x.toFixed(2)}, ${s.local.z.toFixed(2)}) anim ${s.local.anim}, connection ${s.connection}, build ${s.build?.mode}, focus ${focus}, ui ${JSON.stringify(s.ui ?? null).slice(0, 160)}`);
        }
        const dx = wp.x - s.local.x;
        const dz = wp.z - s.local.z;
        if (Math.hypot(dx, dz) < reach) break;
        const yaw = s.view.yaw;
        const mx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
        const my = -(dx * Math.sin(yaw) + dz * Math.cos(yaw));
        const a = Math.atan2(my, mx);
        const dist = Math.hypot(dx, dz);
        const moved = last ? Math.hypot(s.local.x - last.x, s.local.z - last.z) : 1;
        last = { x: s.local.x, z: s.local.z };
        if (moved > 0.05) {
          stall = 0;
          if (nudge && moved > 0.4) nudge = 0;
        } else if (++stall >= 4) {
          nudge = nudge === 0 ? 1 : nudge > 0 ? -nudge : -nudge + 1;
          if (Math.abs(nudge) > 2) nudge = 1;
          stall = 0;
        }
        let sector = Math.round(a / (Math.PI / 4)) + nudge;
        if (sector > 4) sector -= 8;
        if (sector < -4) sector += 8;
        const combos = { 0: ['KeyD'], 1: ['KeyD', 'KeyW'], 2: ['KeyW'], 3: ['KeyA', 'KeyW'], 4: ['KeyA'], [-4]: ['KeyA'], [-3]: ['KeyA', 'KeyS'], [-2]: ['KeyS'], [-1]: ['KeyD', 'KeyS'] };
        await press(new Set(combos[sector] ?? ['KeyW']));
        // At least ~250 ms: headless software rendering runs at a few fps and a shorter press can fall between frames.
        await sleep(Math.max(250, Math.min(450, (dist / CONFIG.movement.walkSpeed) * 1000 * 0.5)));
        await press(new Set());
      }
    }
  } finally {
    await press(new Set());
  }
}

/** Keyboard walk along an A* route through `via` points. */
export async function keyboardRoute(page, via, opts = {}) {
  let from = (await snap(page)).local;
  const wps = [];
  for (const v of via) {
    wps.push(...route(from, v, opts.blocked));
    from = v;
  }
  await keyboardWalk(page, wps, { reach: 0.9, ...opts });
}

// ---------------------------------------------------------------------------
// Build UI
// ---------------------------------------------------------------------------

export const buildState = async (page) => (await snap(page))?.build ?? null;

/** Open build mode through the nav button (or the B key) and wait for the dock + snapshot. */
export async function openBuild(page, { key = false } = {}) {
  if (!(await page.$('[data-testid=build-dock]'))) {
    if (key) await page.keyboard.press('KeyB');
    else await page.click('[data-testid=nav-build]');
  }
  await page.waitForSelector('[data-testid=build-dock]', { timeout: 20_000 });
  await waitSnap(page, (s) => s.build?.synced && s.build.mode !== 'off', 'build mode on + synced', 30_000);
}

export async function closeBuild(page) {
  if (await page.$('[data-testid=build-done]')) await page.click('[data-testid=build-done]');
  await waitSnap(page, (s) => s.build?.mode === 'off', 'build mode off', 15_000);
}

/** Pick a piece (category tab → tile) and optionally a style, through the palette. */
export async function choosePiece(page, kind, { variant, category } = {}) {
  const st = await buildState(page);
  const tap = (sel) => (page.__touch ? page.locator(sel).tap() : page.click(sel));
  if (st.mode === 'remove') await tap('[data-testid=build-tool-remove]');
  if (st.mode === 'clear') await tap('[data-testid=build-tool-clear]');
  if (category) await tap(`[data-testid=build-tab-${category}]`);
  await tap(`[data-testid=build-piece-${kind}]`);
  if (variant) await tap(`[data-testid=build-variant-${variant}]`);
  await waitSnap(page, (s) => s.build?.kind === kind && s.build.mode === 'place', `piece ${kind} chosen`, 10_000);
}

/** Turn the piece with the on-screen Rotate button (or R) until it has `rot` quarter turns. */
export async function rotateTo(page, rot, { key = false } = {}) {
  for (let i = 0; i < 4; i++) {
    const st = await buildState(page);
    if (st.rot === rot) return;
    if (key) await page.keyboard.press('KeyR');
    else await press(page, '[data-testid=build-rotate]');
    await waitSnap(page, (s) => s.build?.rot !== st.rot, 'rotated', 10_000);
  }
  throw new Error(`could not rotate to ${rot}`);
}

/**
 * Aim the ghost at world (x, z) — hover (mouse) or tap (touch) the screen
 * point of (x, y, z) — and wait until the ghost sits on that grid cell.
 */
export async function aimGhost(page, x, z, y, { level } = {}) {
  const p = await screenOf(page, x, z, y);
  if (page.__touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.move(p.x, p.y, { steps: 2 });
  return waitSnap(page, (s) => s.build?.ghost && Math.abs(s.build.ghost.x - x) < 0.01 && Math.abs(s.build.ghost.z - z) < 0.01 && (level === undefined || s.build.ghost.level === level), `ghost at (${x}, ${z})${level !== undefined ? ` level ${level}` : ''}`, 20_000);
}

/**
 * Place the chosen piece at (x, z) through the real UI: aim, then click
 * (desktop) or tap Place (touch). Resolves with the new piece (as the build
 * debug section lists it) once the server has confirmed it.
 */
export async function placeHere(page, x, z, y, { level } = {}) {
  const s0 = await aimGhost(page, x, z, y, { level });
  assert(s0.build.ghost.ok, `ghost refused at (${x}, ${z}): ${s0.build.ghost.message}`);
  const before = new Set(s0.build.pieces.map((p) => p.id));
  const okBefore = s0.build.stats.results.ok;
  if (page.__touch) await press(page, '[data-testid=build-place]');
  else {
    const p = await screenOf(page, x, z, y);
    await page.mouse.click(p.x, p.y);
  }
  const s1 = await waitSnap(page, (s) => s.build.stats.results.ok > okBefore || (s.build.refusal && Date.now() - s.build.refusal.at < 4000 && s.build.stats.results.refused > s0.build.stats.results.refused), 'server answer', 20_000);
  const added = s1.build.pieces.filter((p) => !before.has(p.id));
  assert(added.length === 1, `expected one new piece, got ${added.length}; refusal ${JSON.stringify(s1.build.refusal)}`);
  return added[0];
}

/** Zoom the camera out `steps` notches (the - key, or the on-screen Zoom out button on touch). */
export async function zoomOut(page, steps = 2) {
  for (let i = 0; i < steps; i++) {
    const z0 = (await snap(page)).view.zoom;
    if (page.__touch) await page.click('button[aria-label="Zoom out"]');
    else await page.keyboard.press('Minus');
    await waitSnap(page, (s) => s.view.zoom < z0 - 0.5, 'zoomed out', 10_000).catch(() => undefined);
  }
}
