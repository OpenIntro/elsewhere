#!/usr/bin/env node
/**
 * Two-client smoke test against an ALREADY RUNNING server (npm start / npm run dev).
 *
 *   node scripts/smoke-two-clients.mjs [url]        (default: $SMOKE_URL or http://localhost:2567)
 *
 * Opens two isolated browser contexts (separate guest identities; `?autojoin=1`
 * bypasses onboarding), waits until
 * each sees exactly 2 players in the synced room state, then holds a movement
 * key in client A and asserts that client B observes A's position change.
 * Reads state through the read-only window.__ELSEWHERE__.snapshot() hook.
 * Exit code 0 = pass.
 */
import { createRequire } from 'node:module';

// Playwright is installed globally (not a project dependency): CommonJS require honours NODE_PATH, ESM import does not.
async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}
const { chromium } = await loadPlaywright();

const baseUrl = process.argv[2] ?? process.env.SMOKE_URL ?? 'http://localhost:2567';
// `?autojoin=1` skips the onboarding flow (intro / character creation) and joins as a random guest.
const url = (() => {
  const u = new URL(baseUrl);
  u.searchParams.set('autojoin', '1');
  return u.toString();
})();
const TIMEOUT = 20_000;

const log = (...a) => console.log('[smoke]', ...a);
const fail = (msg) => {
  console.error('[smoke] FAIL:', msg);
  process.exitCode = 1;
};

async function snapshot(page) {
  return page.evaluate(() => window.__ELSEWHERE__?.snapshot() ?? null);
}

async function waitFor(page, predicate, label, timeout = TIMEOUT) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await snapshot(page);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}; last snapshot: ${JSON.stringify(last)}`);
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const ctxA = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const ctxB = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const [name, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', (e) => console.error(`[smoke] page ${name} error:`, e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error(`[smoke] page ${name} console.error:`, m.text());
    });
  }

  const G0=Date.now(); log('opening', url);
  await pageA.goto(url);
  await pageB.goto(url);
  log('gotos', Date.now()-G0);

  const a0 = await waitFor(pageA, (s) => s.connection === 'connected' && s.players.length === 2, 'A to see 2 players');
  log('A ready', Date.now()-G0);
  const b0 = await waitFor(pageB, (s) => s.connection === 'connected' && s.players.length === 2, 'B to see 2 players');
  log('B ready', Date.now()-G0);
  log(`A (${a0.sessionId}) sees ${a0.players.length} players; B (${b0.sessionId}) sees ${b0.players.length} players`);
  if (a0.sessionId === b0.sessionId) throw new Error('both clients share a session id');
  const ids = new Set([...a0.players.map((p) => p.id), ...b0.players.map((p) => p.id)]);
  if (ids.size !== 2 || !ids.has(a0.sessionId) || !ids.has(b0.sessionId)) throw new Error(`player sets disagree: ${[...ids].join(',')}`);

  const aSeenByB0 = b0.players.find((p) => p.id === a0.sessionId);
  log(`B sees A at (${aSeenByB0.x.toFixed(2)}, ${aSeenByB0.z.toFixed(2)})`);

  // Real input: hold a movement key in A (screen-right, then screen-down so we don't just hit the fountain).
  await pageA.bringToFront();
  await pageA.keyboard.down('KeyD');
  await new Promise((r) => setTimeout(r, 900));
  await pageA.keyboard.up('KeyD');
  await pageA.keyboard.down('KeyS');
  await new Promise((r) => setTimeout(r, 700));
  await pageA.keyboard.up('KeyS');

  const moved = (s) => {
    const p = s.players.find((q) => q.id === a0.sessionId);
    return p && Math.hypot(p.x - aSeenByB0.x, p.z - aSeenByB0.z) > 1.0;
  };
  const b1 = await waitFor(pageB, moved, "B to observe A's movement", 8000);
  const aSeenByB1 = b1.players.find((p) => p.id === a0.sessionId);
  const a1 = await snapshot(pageA);
  const moveDist = Math.hypot(aSeenByB1.x - aSeenByB0.x, aSeenByB1.z - aSeenByB0.z);
  log(`B now sees A at (${aSeenByB1.x.toFixed(2)}, ${aSeenByB1.z.toFixed(2)}) — moved ${moveDist.toFixed(2)} units`);
  log(`A's own predicted position: (${a1.local.x.toFixed(2)}, ${a1.local.z.toFixed(2)})`);

  // B itself did not move.
  const bSelf0 = b0.players.find((p) => p.id === b0.sessionId);
  const bSelf1 = b1.players.find((p) => p.id === b0.sessionId);
  if (Math.hypot(bSelf1.x - bSelf0.x, bSelf1.z - bSelf0.z) > 0.01) throw new Error('B moved without input');

  log('PASS: both clients see 2 players and B observed A move');
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  // Close pages first so clients leave consented (no lingering reconnection seats).
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) await page.close({ runBeforeUnload: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await browser.close();
}
