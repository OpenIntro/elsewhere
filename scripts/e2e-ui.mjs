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
 *  6. Register during onboarding, then log in from a fresh browser.
 *  7. No console errors / page errors, no horizontal overflow.
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

async function query(page, name, ...args) {
  return page.evaluate(([n, a]) => window.__ELSEWHERE__?.query(n, ...a) ?? null, [name, args]);
}
async function uiDebug(page) {
  return (await snapshot(page))?.ui ?? null;
}
async function closeChat(page) {
  if (await page.$('[data-testid=chat-close]')) await page.click('[data-testid=chat-close]').catch(() => undefined);
}
async function closeSheet(page) {
  for (let i = 0; i < 3 && (await page.$('[data-testid=sheet-close]')); i++) {
    await page.click('[data-testid=sheet-close]').catch(() => undefined);
    await page.waitForTimeout(200);
  }
}
/**
 * Real input: click the interactable in the 3D view (the player walks there and
 * interacts). If it is off-screen, click the ground toward it first.
 */
async function goInteract(page, id, resultSelector, tries = 30) {
  const it = await query(page, 'interactable', id);
  if (!it) throw new Error(`no interactable ${id}`);
  const vp = page.viewportSize();
  await closeChat(page);
  for (let i = 0; i < tries; i++) {
    await closeSheet(page);
    const ground = await query(page, 'worldToScreen', it.position.x, it.position.z);
    const inView = ground && ground.x > 50 && ground.x < vp.width - 50 && ground.y > 110 && ground.y < vp.height - 130;
    if (inView) {
      for (const dy of [0, 8, 16, 24, 32, 40]) {
        const pk = await query(page, 'pick', ground.x, ground.y - dy, 'mouse');
        if (pk?.kind === 'interactable' && pk.id === id && (await onCanvas(page, ground.x, ground.y - dy))) {
          await page.mouse.click(ground.x, ground.y - dy);
          try {
            if (typeof resultSelector === 'function') await resultSelector();
            else await page.waitForSelector(resultSelector, { timeout: 15000 });
            return;
          } catch {
            break;
          }
        }
      }
    }
    // Walk toward it: click the ground part-way from me to the target.
    const s = await snapshot(page);
    const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
    if (!me || !ground) throw new Error('cannot project positions');
    const dx = ground.x - me.x;
    const dy = ground.y - me.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(len, Math.min(vp.width, vp.height) * 0.3);
    const tx = Math.max(60, Math.min(vp.width - 60, me.x + (dx / len) * step));
    const ty = Math.max(120, Math.min(vp.height - 140, me.y + (dy / len) * step));
    await page.mouse.click(tx, ty);
    await page.waitForTimeout(1600);
  }
  throw new Error(`could not reach/interact with ${id}`);
}
/** Click another player in the 3D view (opens the player card through the player menu). */
/** True if a click at (x, y) would land on the 3D canvas rather than on UI. */
async function onCanvas(page, x, y) {
  return page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [x, y]);
}
async function clickPlayer(page, sessionId) {
  await closeChat(page);
  await closeSheet(page);
  for (let i = 0; i < 20; i++) {
    const s = await snapshot(page);
    const p = s.players.find((q) => q.id === sessionId);
    if (p) {
      const at = await query(page, 'worldToScreen', p.x, p.z);
      const vp = page.viewportSize();
      if (at && (at.x < 60 || at.x > vp.width - 60 || at.y < 140 || at.y > vp.height - 130)) {
        // Off-screen: walk toward them first (ground click part-way).
        const me = await query(page, 'worldToScreen', s.local.x, s.local.z);
        if (me) {
          const dx = at.x - me.x;
          const dy = at.y - me.y;
          const len = Math.hypot(dx, dy) || 1;
          const step = Math.min(len * 0.6, Math.min(vp.width, vp.height) * 0.3);
          await page.mouse.click(me.x + (dx / len) * step, me.y + (dy / len) * step);
          await page.waitForTimeout(1500);
          continue;
        }
      }
      if (at) {
        for (const dy of [30, 40, 20, 50, 12]) {
          const pk = await query(page, 'pick', at.x, at.y - dy, 'mouse');
          if (pk?.kind === 'player' && pk.id === sessionId && (await onCanvas(page, at.x, at.y - dy))) {
            await page.mouse.click(at.x, at.y - dy);
            const ok = await page.waitForSelector('[data-testid=player-card]', { timeout: 6000 }).then(() => true, () => false);
            if (ok) return;
            break; // they may have moved; re-project and try again
          }
        }
      }
    }
    await page.waitForTimeout(500);
  }
  const s = await snapshot(page);
  const p = s.players.find((q) => q.id === sessionId);
  const at = p ? await query(page, 'worldToScreen', p.x, p.z) : null;
  await shot(page, 'e2e-fail-clickplayer');
  throw new Error(`could not click the other player (me ${s.local.x.toFixed(1)},${s.local.z.toFixed(1)}; them ${p ? `${p.x.toFixed(1)},${p.z.toFixed(1)} → screen ${at ? `${Math.round(at.x)},${Math.round(at.y)}` : 'off'}` : 'not in roster'})`);
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

  // 5b. Social + world interactions with a second client (real input in the 3D view).
  try {
    const ctxB = await newContext({ viewport: { width: 960, height: 640 } });
    const b = await ctxB.newPage();
    watch(b, 'B2');
    await b.goto(withQuery(base, { autojoin: '1' }));
    await b.waitForSelector('[data-testid=hud]', { timeout: T });
    const sb = await waitSnap(b, (x) => x.connection === 'connected' && x.players.length >= 2, 'B2 connected');
    const sa = await waitSnap(a, (x) => x.players.some((p) => p.id === sb.sessionId), 'A sees B2');
    const bProfile = await b.evaluate(() => window.__ELSEWHERE__.snapshot().players.find((p) => p.id === window.__ELSEWHERE__.snapshot().sessionId)?.name);
    await closeSheet(a);

    // Player card from the world → wave + greet.
    await clickPlayer(a, sb.sessionId);
    await a.click('[data-testid=pc-wave]');
    await a.click('[data-testid=player-card] .action:has-text("Greet")');
    await shot(a, 'e2e-06-playercard');
    pass('open another player’s card by clicking them → wave, greet', bProfile ?? '');

    // Report → sent state (server ack).
    await a.click('[data-testid=pc-report]');
    await a.click('[data-testid=report-form] .radio:has-text("Spam")');
    await a.fill('[data-testid=report-form] textarea', 'e2e test report — please ignore');
    await a.click('[data-testid=report-submit]');
    await a.waitForSelector('[data-testid=report-sent]', { timeout: 15000 });
    pass('report submitted → “Report received”');
    await closeSheet(a);

    const say = async (text) => {
      if (!(await b.$('[data-testid=chat]'))) await b.click('[data-testid=nav-chat]');
      await b.click('[data-testid=chat-tab-town]');
      await b.fill('[data-testid=chat-input]', text);
      await b.press('[data-testid=chat-input]', 'Enter');
      await b.waitForSelector(`[data-testid=chat-log] >> text=${text}`, { timeout: 10000 });
      await b.waitForTimeout(1500);
    };
    const aGot = async (text) => (await uiDebug(a))?.rawChat?.some((m) => m.text === text) ?? false;
    const aShows = async (text) => !!(await a.$(`[data-testid=chat-log] >> text=${text}`));

    // Mute: server stops delivering B's lines to A.
    await clickPlayer(a, sb.sessionId);
    await a.click('[data-testid=player-card] .action:has-text("Mute")');
    await a.waitForSelector('[data-testid=player-card] .action:has-text("Unmute")', { timeout: 10000 });
    await closeSheet(a);
    const muted = `muted line ${Date.now() % 10000}`;
    await say(muted);
    if (await aGot(muted)) throw new Error('server delivered a muted player’s message');
    // Unmute from Settings (by profile id).
    await a.click('[data-testid=nav-settings]');
    await a.click('[data-testid=list-muted] button:has-text("Unmute")');
    await a.waitForSelector('[data-testid=list-muted]', { state: 'detached', timeout: 10000 });
    await closeSheet(a);
    pass('mute → server stops delivering; unmute from Settings list');

    // Block (with confirmation): not delivered, not shown.
    await clickPlayer(a, sb.sessionId);
    await a.click('[data-testid=player-card] .action:has-text("Block")');
    await a.click('[data-testid=confirm-block]');
    await a.waitForSelector('[data-testid=player-card] .action:has-text("Unblock")', { timeout: 10000 });
    await closeSheet(a);
    const blocked = `blocked line ${Date.now() % 10000}`;
    await say(blocked);
    if (!(await a.$('[data-testid=chat]'))) await a.click('[data-testid=nav-chat]');
    await a.click('[data-testid=chat-tab-town]');
    if ((await aGot(blocked)) || (await aShows(blocked))) throw new Error('blocked player’s message reached A');
    await a.click('[data-testid=chat-close]');
    await a.click('[data-testid=nav-settings]');
    await shot(a, 'e2e-07-blocked-list');
    await a.click('[data-testid=list-blocked] button:has-text("Unblock")');
    await a.waitForSelector('[data-testid=list-blocked]', { state: 'detached', timeout: 10000 });
    await closeSheet(a);
    const after = `after unblock ${Date.now() % 10000}`;
    await say(after);
    if (!(await aGot(after))) throw new Error('message not delivered after unblock');
    pass('block (confirmed) → not delivered or shown; unblock from Settings → delivered again');

    // World interactions (A walks there by clicking in the world).
    await goInteract(a, 'sign_welcome', '[data-testid=panel-sign]');
    await shot(a, 'e2e-08-sign');
    pass('sign → reading panel');
    await goInteract(a, 'fountain', '[data-testid=panel-inspect], [data-testid=panel-discovery]');
    await shot(a, 'e2e-09-fountain');
    pass('fountain → inspect panel');

    // Town Hall archive → town history.
    await goInteract(a, 'archive_town_hall', '[data-testid=memory-timeline]');
    await shot(a, 'e2e-12-archive');
    pass('Town Hall archive → town history timeline');
    await closeSheet(a);

    // Mailbox: A leaves a note, B reads it.
    const note = `Hello from the e2e test ${Date.now() % 100000}`;
    await goInteract(a, 'mailbox_post_office', '[data-testid=panel-mailbox]');
    await a.fill('[data-testid=panel-mailbox] textarea', note);
    await a.click('[data-testid=panel-mailbox] button[type=submit]');
    await a.waitForSelector(`[data-testid=panel-mailbox] >> text=${note}`, { timeout: 15000 });
    await closeSheet(b);
    await b.click('[data-testid=chat-close]').catch(() => undefined);
    await goInteract(b, 'mailbox_post_office', '[data-testid=panel-mailbox]');
    await b.waitForSelector(`[data-testid=panel-mailbox] >> text=${note}`, { timeout: 15000 });
    await shot(b, 'e2e-10-mailbox-b');
    pass('mailbox: A leaves a note → B reads it');

    // Pick up an item → Things → set it down.
    // Pick the nearest item that is currently at its spot (a previous run may have moved one; they respawn after minutes).
    const dbg = await uiDebug(a);
    const meNow = (await snapshot(a)).local;
    const candidates = [];
    for (const p of dbg?.pickups ?? []) {
      if (!p.available) continue;
      const it = await query(a, 'interactable', p.id);
      if (it) candidates.push({ id: p.id, name: it.name, d: Math.hypot(it.position.x - meNow.x, it.position.z - meNow.z) });
    }
    candidates.sort((x, y) => x.d - y.d);
    const item = candidates[0];
    if (!item) throw new Error('no pickup is available right now');
    await goInteract(a, item.id, async () => {
      // Done when Things shows the apple in hand.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await a.waitForTimeout(1200);
        await a.click('[data-testid=nav-inventory]');
        const ok = await a.waitForSelector(`[data-testid=panel-inventory] .item--held >> text=${item.name}`, { timeout: 1500 }).then(() => true, () => false);
        if (ok) return;
        await closeSheet(a);
      }
      throw new Error(`${item.name} not in hand`);
    });
    await shot(a, 'e2e-11-things-apple');
    await a.click('[data-testid=panel-inventory] button:has-text("Set down")');
    await a.waitForSelector('[data-testid=panel-inventory] >> text=Your hands are empty', { timeout: 15000 });
    await closeSheet(a);
    pass('pick up an item → shown in Things → set down', item.name);


    // A real Gazette issue (needs the admin token of the server under test).
    const adminToken = process.env.E2E_ADMIN_TOKEN;
    if (adminToken) {
      const res = await fetch(new URL('/api/admin/gazette/compile', base), { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ periodStart: Date.now() - 6 * 3600_000 }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.issue) throw new Error(`gazette compile failed: ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
      await a.click('[data-testid=nav-gazette]');
      await a.waitForSelector('[data-testid=gazette-issue] .article__headline', { timeout: 15000 });
      await shot(a, 'e2e-13-gazette');
      pass('real Gazette issue rendered', `No. ${body.issue.issueNumber}, ${body.issue.articles.length} articles`);
      await closeSheet(a);
    } else {
      log('SKIP gazette issue: set E2E_ADMIN_TOKEN to compile one on the server under test');
    }
    await b.close({ runBeforeUnload: true });
  } catch (err) {
    failStep('social + world interactions', err);
  }

  // 6. Create an account in onboarding, then log in from a fresh browser.
  try {
    // Auth endpoints are rate-limited per IP (CONFIG.rateLimits.auth); the earlier steps used most of the bucket.
    await new Promise((r) => setTimeout(r, 45_000));
    const username = `e2e${Date.now() % 1_000_000}`;
    const password = 'quiet-lantern-42';
    const ctxR = await newContext({ viewport: { width: 1024, height: 700 } });
    const r = await ctxR.newPage();
    watch(r, 'R');
    await r.goto(base);
    await r.waitForSelector('[data-testid=auth-choice]', { timeout: T });
    await r.click('[data-testid=choose-register]');
    await r.fill('[data-testid=register-form] input[autocomplete=username]', username);
    await r.fill('[data-testid=register-form] input[type=password]', password);
    await r.click('[data-testid=register-form] button[type=submit]');
    await r.waitForSelector('[data-testid=customize]', { timeout: T });
    await r.click('[data-testid=customize-save]');
    await r.fill('[data-testid=name-input]', 'Account Fern');
    await r.click('[data-testid=enter-world]');
    await r.waitForSelector('[data-testid=hud]', { timeout: T });
    await r.click('[data-testid=nav-settings]');
    await r.waitForSelector(`[data-testid=panel-settings] >> text=${username}`, { timeout: 15000 });
    await r.close({ runBeforeUnload: true });

    const ctxL = await newContext({ viewport: { width: 1024, height: 700 } });
    const l = await ctxL.newPage();
    watch(l, 'L');
    await l.goto(base);
    await l.waitForSelector('[data-testid=auth-choice]', { timeout: T });
    await l.click('[data-testid=choose-login]');
    await l.fill('[data-testid=login-form] input[autocomplete=username]', username);
    await l.fill('[data-testid=login-form] input[type=password]', 'not-the-password');
    await l.click('[data-testid=login-form] button[type=submit]');
    await l.waitForSelector('[data-testid=login-form] .form-error', { timeout: T });
    // The server rate-limits auth per IP; every e2e client shares localhost, so wait it out if needed.
    for (let attempt = 0; ; attempt++) {
      await l.fill('[data-testid=login-form] input[type=password]', password);
      await l.click('[data-testid=login-form] button[type=submit]');
      const got = await Promise.race([
        l.waitForSelector('[data-testid=hud]', { timeout: T }).then(() => 'hud'),
        l.waitForSelector('[data-testid=login-form] .form-error:has-text("Too many")', { timeout: T }).then(() => 'limited'),
      ]);
      if (got === 'hud') break;
      if (attempt >= 2) throw new Error('login stayed rate-limited');
      log('auth rate limit hit (shared localhost IP) — waiting 40s');
      await l.waitForTimeout(40_000);
    }
    const s = await waitSnap(l, (x) => x.connection === 'connected', 'L connected');
    const me = s.players.find((p) => p.id === s.sessionId);
    if (me?.name !== 'Account Fern') throw new Error(`logged in as ${me?.name}`);
    await l.waitForSelector('[data-testid=toast]:has-text("Welcome back")', { timeout: 15000 });
    await l.close({ runBeforeUnload: true });
    pass('register in onboarding → log in elsewhere (wrong password rejected, character kept)');
  } catch (err) {
    failStep('register / login', err);
  }
} finally {
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await browser.close();
}

// 401/429 resource errors are the browser logging the deliberate wrong-password / rate-limit responses.
const relevant = errors.filter((e) => !/WebGL|GPU stall|GL_|swiftshader/i.test(e) && !/status of (401|429)/.test(e));
if (relevant.length) {
  console.error('[e2e] console/page errors:\n  ' + relevant.join('\n  '));
  results.push({ name: 'no console errors', ok: false, detail: `${relevant.length} errors` });
} else pass('no console or page errors');

const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
