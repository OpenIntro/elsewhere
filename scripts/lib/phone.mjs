/**
 * Helpers for the phone-layout and camera browser suites (scripts/e2e-phone.mjs,
 * scripts/e2e-camera.mjs): screen-coverage measurement of the build dock / a
 * sheet, interior-aware click/tap hops (in through the door), using a station,
 * real touch drags and two-finger gestures through CDP (they arrive as touch
 * pointer events, as from a finger), and an independent orthographic
 * screen → ground solve from the published camera view (to check picking
 * against the camera the player sees). Every action is a real input.
 */
import { CONFIG, getInteractable, getInterior, groundHeight, interiorAt, isWalkable } from '@elsewhere/shared';
import { assert, keyboardRoute, onCanvas, query, sleep, snap, tapOrClick, waitSnap } from './browser.mjs';

const ELEVATION = (37 * Math.PI) / 180;

/**
 * Screen coverage of a set of UI elements: the union of their (viewport-clipped) rects as a share of
 * the viewport area, and the union of their vertical extents as a share of its height.
 * `what` = 'dock' (the build dock's visible parts: status pill, cards, palette, strip / panel) or a CSS selector.
 */
export async function coverage(page, what) {
  return page.evaluate((what) => {
    const W = innerWidth;
    const H = innerHeight;
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // (opacity is not checked: a sheet's entry animation restarts on a resize and is drawn a frame later)
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') return null;
      return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(W, r.right), bottom: Math.min(H, r.bottom) };
    };
    let els;
    if (what === 'dock') {
      const dock = document.querySelector('[data-testid=build-dock]');
      els = dock ? [...dock.children] : [];
    } else els = [...document.querySelectorAll(what)];
    const rects = els.map(vis).filter((r) => r && r.right > r.left && r.bottom > r.top);
    // union area by coordinate compression
    const xs = [...new Set(rects.flatMap((r) => [r.left, r.right]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap((r) => [r.top, r.bottom]))].sort((a, b) => a - b);
    let area = 0;
    for (let i = 0; i < xs.length - 1; i++)
      for (let j = 0; j < ys.length - 1; j++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        const cy = (ys[j] + ys[j + 1]) / 2;
        if (rects.some((r) => cx > r.left && cx < r.right && cy > r.top && cy < r.bottom)) area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    let hgt = 0;
    for (let j = 0; j < ys.length - 1; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (rects.some((r) => cy > r.top && cy < r.bottom)) hgt += ys[j + 1] - ys[j];
    }
    const top = rects.length ? Math.min(...rects.map((r) => r.top)) : H;
    const round = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) });
    return { W, H, n: rects.length, rects: rects.map(round), top: Math.round(top), areaShare: area / (W * H), heightShare: hgt / H };
  }, what);
}
export const pct = (v) => `${(v * 100).toFixed(1)}%`;

/** Rect of the first element matching `sel` (rounded), or null. */
export async function rectOf(page, sel) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  }, sel);
}

/** Close an open panel with its ✕ (tap on touch). */
export async function closePanel(page) {
  const btn = page.locator('[data-testid=sheet-close]').first();
  if (await btn.isVisible().catch(() => false)) {
    if (page.__touch) await btn.tap().catch(() => undefined);
    else await btn.click().catch(() => undefined);
  }
  await waitSnap(page, (s) => !s.ui?.panel, 'panel closed', 10_000).catch(() => undefined);
}

/** Click/tap-to-move in hops towards a target (the camera follows) until within `near` (or `reached`). */
export async function hop(page, target, near = 1.2, timeout = 180_000, reached = null) {
  const vp = page.viewportSize();
  const t0 = Date.now();
  let stuck = 0;
  let prev = null;
  while (Date.now() - t0 < timeout) {
    const s = await snap(page);
    if (Math.hypot(s.local.x - target.x, s.local.z - target.z) < near || (reached && (await reached(s)))) return s;
    if (s.ui?.panel) await closePanel(page);
    if (prev && Math.hypot(s.local.x - prev.x, s.local.z - prev.z) < 0.2) stuck++;
    else stuck = 0;
    prev = { x: s.local.x, z: s.local.z };
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    const tp = await query(page, 'worldToScreen', target.x, target.z);
    let x = tp.x;
    let y = tp.y;
    const m = 0.2;
    const inside = (px, py) => px > vp.width * m && px < vp.width * (1 - m) && py > vp.height * m && py < vp.height * (1 - m);
    if (!inside(x, y)) {
      let k = 1;
      for (; k > 0.05; k -= 0.05) if (inside(me.x + (tp.x - me.x) * k, me.y + (tp.y - me.y) * k)) break;
      x = me.x + (tp.x - me.x) * k;
      y = me.y + (tp.y - me.y) * k;
    }
    if (stuck > 3) {
      await keyboardRoute(page, [target], { timeout: 90_000 }).catch(() => undefined);
      stuck = 0;
      continue;
    }
    if (!(await onCanvas(page, x, y))) y -= 40;
    for (let k = 0; k < 6; k++) {
      const pk = await query(page, 'pick', x, y, page.__touch ? 'touch' : 'mouse');
      if (!pk) break;
      x += (k % 2 ? -1 : 1) * (40 + k * 25);
      y -= 15;
    }
    await tapOrClick(page, x, y);
    await sleep(300);
    await waitSnap(page, (q) => !q.motion?.path && q.local.speed < 0.05, 'hop finished', 40_000);
  }
  const last = (await snap(page))?.local;
  throw new Error(`could not hop to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}); at (${last?.x?.toFixed(2)}, ${last?.z?.toFixed(2)})`);
}

/** Walk like a person: into the target's building through its door first, then to the spot. */
export async function hopInto(page, target, near = 1.2, timeout = 300_000, panel = null) {
  const it = interiorAt(target);
  const s = await snap(page);
  if (it && interiorAt(s.local)?.id !== it.id) {
    const door = it.doors[0];
    const inside = (q) => interiorAt(q.local)?.id === it.id;
    const front = [3, 2, 1.2, 0].map((d) => ({ x: door.outside.x + Math.sin(door.yaw) * d, z: door.outside.z + Math.cos(door.yaw) * d })).find((p) => isWalkable(p, 0.5)) ?? door.outside;
    await hop(page, front, 2.5, timeout, inside);
    if (!inside(await snap(page))) await keyboardRoute(page, [door.outside, door.inside], { timeout: 90_000 }).catch(() => undefined);
  }
  // A hop tap on the thing we came to use opens its panel: that is arriving, not a stray tap to close.
  return hop(page, target, near, timeout, panel ? async () => !!(await page.$(`[data-testid=${panel}]`)) : null);
}

/** Walk next to an interactable (inside its building) and click / tap it; wait for its panel. */
export async function useThing(page, id, { panel, approach = null, near = 1.3, timeout = 60_000 } = {}) {
  const it = getInteractable(id);
  assert(it, `no interactable ${id}`);
  const interior = it.interiorId ? getInterior(it.interiorId) : null;
  // close enough to tap it (a tap on it walks the rest of the way, as a player's would)
  await hopInto(page, approach ?? it.position, near, 300_000, panel);
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeout) {
    if (panel && (await page.$(`[data-testid=${panel}]`))) return;
    // Standing at it with the interaction prompt on it: E (keyboard) or the round action button (touch).
    const s = await snap(page);
    if (s.target?.id === id) {
      if (page.__touch) await page.locator('[data-testid=touch-action]').tap().catch(() => undefined);
      else await page.keyboard.press('KeyE');
      if (await page.waitForSelector(`[data-testid=${panel}]`, { timeout: 15_000 }).catch(() => null)) return;
    }
    const y = (interior?.floorY ?? 0) + 0.7;
    const p = await query(page, 'worldToScreen', it.position.x, it.position.z, y);
    if (p && (await onCanvas(page, p.x, p.y))) {
      const pick = await query(page, 'pick', p.x, p.y, page.__touch ? 'touch' : 'mouse');
      if (pick?.id === id) {
        await tapOrClick(page, p.x, p.y);
        try {
          await page.waitForSelector(`[data-testid=${panel}]`, { timeout: 25_000 });
          return;
        } catch {
          lastErr = `panel ${panel} did not open`;
        }
      } else lastErr = `pick ${JSON.stringify(pick)}`;
    } else lastErr = 'not on screen';
    await sleep(600);
  }
  const s = await snap(page);
  throw new Error(`could not use ${id}: ${lastErr}; at (${s.local.x.toFixed(2)}, ${s.local.z.toFixed(2)}) in ${interiorAt(s.local)?.id ?? 'outdoors'}, target ${JSON.stringify(s.target)}, interior ${JSON.stringify(s.interior)}`);
}

/** A CDP session per page (touch input). */
const cdps = new WeakMap();
async function cdp(page) {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  return cdps.get(page);
}

/** One-finger touch drag from (x, y) by (dx, dy) in `steps` moves (real touch events → touch pointer events). */
export async function touchDrag(page, x, y, dx, dy, steps = 8) {
  const c = await cdp(page);
  const pt = (k) => [{ x: x + (dx * k) / steps, y: y + (dy * k) / steps, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(0) });
  for (let k = 1; k <= steps; k++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(k) });
    await sleep(30);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Two-finger gesture around (cx, cy): fingers start `r0` px from the centre at angle `a0`, and end
 * `r1` px out, turned by `turn` radians (screen, + = clockwise since y points down).
 */
export async function twoFinger(page, cx, cy, { r0 = 80, r1 = 80, a0 = 0, turn = 0, steps = 12 } = {}) {
  const c = await cdp(page);
  const pts = (k) => {
    const t = k / steps;
    const r = r0 + (r1 - r0) * t;
    const a = a0 + turn * t;
    return [
      { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, id: 1, radiusX: 4, radiusY: 4, force: 1 },
      { x: cx - Math.cos(a) * r, y: cy - Math.sin(a) * r, id: 2, radiusX: 4, radiusY: 4, force: 1 },
    ];
  };
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(0) });
  for (let k = 1; k <= steps; k++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(k) });
    await sleep(40);
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Independent screen → ground solve: the orthographic camera the rig publishes in snapshot().view
 * (look-at focus, yaw, zoom = px per metre, ELEVATION), marched against the shared groundHeight.
 * Used to check that what the player taps is what picking / aiming hits (no projection tricks).
 */
export function groundUnder(view, W, H, sx, sy) {
  const yaw = view.yaw;
  const zoom = view.zoom;
  const ce = Math.cos(ELEVATION);
  const se = Math.sin(ELEVATION);
  const f = { x: -Math.sin(yaw) * ce, y: -se, z: -Math.cos(yaw) * ce };
  const R = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  // up = R × f
  const U = { x: R.y * f.z - R.z * f.y, y: R.z * f.x - R.x * f.z, z: R.x * f.y - R.y * f.x };
  const dx = (sx - W / 2) / zoom;
  const dy = -(sy - H / 2) / zoom;
  const o = { x: view.focusX + R.x * dx + U.x * dy - f.x * 60, y: view.focusY + R.y * dx + U.y * dy - f.y * 60, z: view.focusZ + R.z * dx + U.z * dy - f.z * 60 };
  const above = (t) => o.y + f.y * t - groundHeight(o.x + f.x * t, o.z + f.z * t);
  let lo = 0;
  let hi = 0;
  for (let t = 0.25; t < 300; t += 0.25) {
    if (above(t) <= 0) {
      lo = t - 0.25;
      hi = t;
      break;
    }
  }
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (above(m) > 0) lo = m;
    else hi = m;
  }
  return { x: o.x + f.x * hi, z: o.z + f.z * hi };
}

/** Where a world point appears on screen for the published view (inverse of groundUnder; point at height y). */
export function screenOfView(view, W, H, x, y, z) {
  const yaw = view.yaw;
  const zoom = view.zoom;
  const ce = Math.cos(ELEVATION);
  const se = Math.sin(ELEVATION);
  const f = { x: -Math.sin(yaw) * ce, y: -se, z: -Math.cos(yaw) * ce };
  const R = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const U = { x: R.y * f.z - R.z * f.y, y: R.z * f.x - R.x * f.z, z: R.x * f.y - R.y * f.x };
  const d = { x: x - view.focusX, y: y - view.focusY, z: z - view.focusZ };
  return { x: W / 2 + (d.x * R.x + d.y * R.y + d.z * R.z) * zoom, y: H / 2 - (d.x * U.x + d.y * U.y + d.z * U.z) * zoom };
}

export const playerRadius = CONFIG.movement.playerRadius;
