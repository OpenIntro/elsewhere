#!/usr/bin/env node
/**
 * UI flow test against an ALREADY RUNNING server/client.
 *
 *   node scripts/e2e-ui.mjs [url]     (default: $E2E_URL or http://localhost:2567)
 *
 *  1. Fresh visitor: intro → guest → customize → name → in the world with HUD.
 *  2. Reload: resumes without onboarding (saved session), "welcome back".
 *  3. Opens every bottom-nav panel (map, things, chat, home, gazette, settings).
 *  4. Settings sliders persist across reload.
 *  5. Chat: client A sends a Town message, client B (`?autojoin=1`) sees it.
 *  6. No console errors / page errors, no horizontal overflow.
 * Exit code 0 = pass. Set SHOTS=dir to save screenshots of each step.
 */
import { createRequire } from 'node:module';

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}
const { chromium } = await loadPlaywright();

const base = process.argv[2] ?? process.env.E2E_URL ?? 'http://localhost:2567';
const SHOTS = process.env.SHOTS ?? null;
const T = 45_000;
const log = (...a) => console.log('[e2e]', ...a);
const errors = [];
const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  log('PASS', name, detail);
};
const failStep = (name, err) => {
  results.push({ name, ok: false, detail: String(err?.message ?? err) });
  console.error('[e2e] FAIL', name, '-', err?.message ?? err);
};

function withQuery(u, q) {
  const url = new URL(u);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return url.toString();
}

function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label} console.error: ${m.text()}`);
  });
}

async function snapshot(page) {
  return page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
}
async function waitSnap(page, pred, label, timeout = T) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await snapshot(page);
    if (last && pred(last)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)?.slice(0, 300)}`);
}
async function noOverflow(page, where) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > iw) throw new Error(`horizontal overflow at ${where}: ${sw} > ${iw}`);
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

const browser = await chromium.launch();
// Headless WebGL is software-rendered: start every context on low graphics so the UI stays responsive.
// (Volumes are left at defaults; step 4 changes and verifies them.)
const LOW_GFX = `try { if (!localStorage.getItem('elsewhere.settings.v1')) localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`;
async function newContext(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(LOW_GFX);
  return ctx;
}
try {
  const ctxA = await newContext({ viewport: { width: 1024, height: 700 } });
  const a = await ctxA.newPage();
  watch(a, 'A');

  // 1. Fresh visitor → onboarding → world.
  try {
    const t0 = Date.now();
    await a.goto(base);
    await a.waitForSelector('[data-testid=intro]', { timeout: T });
    await shot(a, 'e2e-01-intro');
    await a.waitForSelector('[data-testid=auth-choice]', { timeout: T });
    await noOverflow(a, 'auth');
    await a.click('[data-testid=enter-guest]');
    await a.waitForSelector('[data-testid=customize]', { timeout: T });
    await a.click('[data-testid=randomize]');
    await shot(a, 'e2e-02-customize');
    await a.click('[data-testid=customize-save]');
    await a.waitForSelector('[data-testid=name-step]', { timeout: T });
    await a.fill('[data-testid=name-input]', 'Test Wren');
    await a.click('[data-testid=enter-world]');
    await a.waitForSelector('[data-testid=hud]', { timeout: T });
    const s = await waitSnap(a, (x) => x.connection === 'connected' && x.players.length >= 1, 'A connected');
    const me = s.players.find((p) => p.id === s.sessionId);
    if (me?.name !== 'Test Wren') throw new Error(`expected name "Test Wren", got ${me?.name}`);
    await a.waitForSelector('[data-testid=player-count]', { timeout: T });
    await a.waitForSelector('[data-testid=hud-clock]', { timeout: T });
    await noOverflow(a, 'hud');
    await shot(a, 'e2e-03-hud');
    pass('fresh visitor → intro → guest → customize → name → world', `${((Date.now() - t0) / 1000).toFixed(1)}s incl. intro`);
  } catch (err) {
    failStep('fresh visitor onboarding', err);
  }

  // 2. Reload → resume without onboarding.
  try {
    await a.reload();
    const first = await Promise.race([
      a.waitForSelector('[data-testid=hud]', { timeout: T }).then(() => 'hud'),
      a.waitForSelector('[data-testid=onboarding]', { timeout: T }).then(() => 'onboarding'),
    ]);
    if (first !== 'hud') throw new Error('onboarding shown again after reload');
    const s = await waitSnap(a, (x) => x.connection === 'connected', 'A reconnected');
    const me = s.players.find((p) => p.id === s.sessionId);
    if (me?.name !== 'Test Wren') throw new Error(`resumed as ${me?.name}, expected Test Wren`);
    await a.waitForSelector('[data-testid=toast]:has-text("Welcome back")', { timeout: 15000 });
    pass('reload resumes saved session (no onboarding, welcome back)');
  } catch (err) {
    failStep('reload resume', err);
  }

  // 3. Every bottom-nav panel opens.
  try {
    const panels = { map: 'panel-map', inventory: 'panel-inventory', chat: 'chat', home: 'panel-home', gazette: 'panel-gazette', settings: 'panel-settings' };
    for (const [nav, id] of Object.entries(panels)) {
      await a.click(`[data-testid=nav-${nav}]`);
      await a.waitForSelector(`[data-testid=${id}]`, { timeout: 15000 });
      await noOverflow(a, nav);
      await shot(a, `e2e-04-${nav}`);
      await a.click(`[data-testid=nav-${nav}]`);
      await a.waitForSelector(`[data-testid=${id}]`, { state: 'detached', timeout: 15000 });
    }
    // Gazette shows either an issue or the honest empty state (never invented news).
    await a.click('[data-testid=nav-gazette]');
    await a.waitForSelector('[data-testid=gazette-issue], [data-testid=gazette-empty], .paper--state', { timeout: 8000 });
    await a.keyboard.press('Escape');
    pass('all six bottom-nav panels open and close');
  } catch (err) {
    failStep('bottom-nav panels', err);
  }

  // 4. Settings sliders persist across reload.
  try {
    await a.click('[data-testid=nav-settings]');
    await a.waitForSelector('[data-testid=panel-settings]');
    await a.fill('[data-testid=vol-music]', '23');
    await a.fill('[data-testid=vol-sfx]', '61');
    await a.waitForTimeout(300);
    await a.reload();
    await a.waitForSelector('[data-testid=hud]', { timeout: T });
    await a.click('[data-testid=nav-settings]');
    const music = await a.inputValue('[data-testid=vol-music]');
    const sfx = await a.inputValue('[data-testid=vol-sfx]');
    if (music !== '23' || sfx !== '61') throw new Error(`sliders after reload: music=${music} sfx=${sfx}`);
    await a.keyboard.press('Escape');
    pass('volume sliders persist across reload', `music=${music} sfx=${sfx}`);
  } catch (err) {
    failStep('settings persistence', err);
  }

  // 5. Chat between two clients.
  try {
    const ctxB = await newContext({ viewport: { width: 960, height: 640 } });
    const b = await ctxB.newPage();
    watch(b, 'B');
    await b.goto(withQuery(base, { autojoin: '1' }));
    await b.waitForSelector('[data-testid=hud]', { timeout: T });
    await waitSnap(b, (x) => x.connection === 'connected' && x.players.length >= 2, 'B sees 2 players');
    await waitSnap(a, (x) => x.players.length >= 2, 'A sees 2 players');

    const text = `hello from A ${Date.now() % 100000}`;
    await a.click('[data-testid=nav-chat]');
    await a.click('[data-testid=chat-tab-town]');
    await a.fill('[data-testid=chat-input]', text);
    await a.press('[data-testid=chat-input]', 'Enter');
    await a.waitForSelector(`[data-testid=chat-log] >> text=${text}`, { timeout: 8000 });

    await b.click('[data-testid=nav-chat]');
    await b.click('[data-testid=chat-tab-town]');
    await b.waitForSelector(`[data-testid=chat-log] >> text=${text}`, { timeout: 8000 });
    await shot(b, 'e2e-05-chat-b');
    pass('chat: A → Town → seen by B');
    await b.close({ runBeforeUnload: true });
  } catch (err) {
    failStep('chat between clients', err);
  }
} finally {
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await browser.close();
}

const relevant = errors.filter((e) => !/WebGL|GPU stall|GL_|swiftshader/i.test(e));
if (relevant.length) {
  console.error('[e2e] console/page errors:\n  ' + relevant.join('\n  '));
  results.push({ name: 'no console errors', ok: false, detail: `${relevant.length} errors` });
} else pass('no console or page errors');

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
