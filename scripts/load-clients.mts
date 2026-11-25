#!/usr/bin/env -S npx tsx --conditions=source
/**
 * Simulated load: N headless Colyseus SDK clients random-walking with valid
 * moves (shared resolveMovement, 15 Hz, adopting server corrections), and
 * optionally one real browser (Playwright, global install) that reports its
 * frame-time stats via window.__ELSEWHERE__.snapshot().frame.
 *
 *   npx tsx --conditions=source scripts/load-clients.mts [--clients 40] [--seconds 30]
 *       [--server http://localhost:2604] [--browser http://localhost:5184]
 *
 * Prints JSON with per-phase numbers. Exit code 0 unless the bots fail to join.
 */
import { createRequire } from 'node:module';
import { Client, type Room } from '@colyseus/sdk';
import { C2S, CONFIG, ROOM_NAME, S2C, isWalkable, resolveMovement, type CorrectionPayload } from '@elsewhere/shared';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const N = Number(arg('clients', '40'));
const SECONDS = Number(arg('seconds', '30'));
const SERVER = arg('server', 'http://localhost:2604');
const BROWSER_URL = arg('browser', '');

interface Bot {
  room: Room;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  turnAt: number;
  seq: number;
  speed: number;
  corrections: number;
  sent: number;
}

const log = (...a: unknown[]) => console.log('[load]', ...a);

async function joinBot(i: number): Promise<Bot> {
  const client = new Client(SERVER);
  const room = await client.joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, name: `Bot ${i + 1}` });
  const bot: Bot = { room, x: 0, z: 0, dirX: 1, dirZ: 0, turnAt: 0, seq: 0, speed: Math.random() < 0.3 ? CONFIG.movement.runSpeed : CONFIG.movement.walkSpeed, corrections: 0, sent: 0 };
  for (const t of Object.values(S2C)) room.onMessage(t, () => undefined);
  room.onMessage(S2C.correction, (c: CorrectionPayload) => {
    bot.x = c.x;
    bot.z = c.z;
    bot.corrections++;
  });
  // Initial position from synced state.
  await new Promise<void>((resolve) => {
    const check = () => {
      const st = room.state as { players?: { get(id: string): { x: number; z: number } | undefined } };
      const me = st.players?.get(room.sessionId);
      if (me) {
        bot.x = me.x;
        bot.z = me.z;
        resolve();
      } else setTimeout(check, 50);
    };
    check();
  });
  return bot;
}

function step(bot: Bot, dt: number, now: number): void {
  if (now > bot.turnAt) {
    const a = Math.random() * Math.PI * 2;
    bot.dirX = Math.sin(a);
    bot.dirZ = Math.cos(a);
    bot.turnAt = now + 1500 + Math.random() * 3500;
  }
  const to = { x: bot.x + bot.dirX * bot.speed * dt, z: bot.z + bot.dirZ * bot.speed * dt };
  const next = resolveMovement({ x: bot.x, z: bot.z }, to);
  if (Math.hypot(next.x - bot.x, next.z - bot.z) < bot.speed * dt * 0.3 || !isWalkable(next)) bot.turnAt = 0; // blocked: turn
  // Keep the crowd around the plaza so the browser sees them.
  if (Math.hypot(next.x, next.z - 2) > 26) {
    bot.dirX = -next.x / Math.hypot(next.x, next.z - 2);
    bot.dirZ = -(next.z - 2) / Math.hypot(next.x, next.z - 2);
  }
  bot.x = next.x;
  bot.z = next.z;
  bot.seq++;
  bot.sent++;
  bot.room.send(C2S.move, { x: bot.x, z: bot.z, rot: Math.atan2(bot.dirX, bot.dirZ), anim: bot.speed > 4 ? 'run' : 'walk', seq: bot.seq });
}

async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}

type FrameStats = { n: number; avg: number; p95: number; max: number; over50: number };

const bots: Bot[] = [];
let browser: import('playwright').Browser | null = null;
try {
  let page: import('playwright').Page | null = null;
  if (BROWSER_URL) {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } });
    page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(BROWSER_URL);
    await page.waitForFunction(() => window.__ELSEWHERE__?.snapshot().connection === 'connected', null, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 4000));
    const base = (await page.evaluate(() => window.__ELSEWHERE__!.snapshot().frame)) as FrameStats;
    log('browser baseline (alone):', JSON.stringify(base));
    (globalThis as { __errors?: string[] }).__errors = errors;
  }

  const t0 = Date.now();
  for (let i = 0; i < N; i += 10) {
    const batch = await Promise.all(Array.from({ length: Math.min(10, N - i) }, (_, k) => joinBot(i + k)));
    bots.push(...batch);
  }
  log(`${bots.length} bots joined in ${Date.now() - t0} ms`);

  const interval = 1000 / CONFIG.movement.sendRateHz;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    for (const b of bots) step(b, dt, now);
  }, interval);

  const samples: { t: number; frame: FrameStats; players: number; remotesVisible: number; connection: string }[] = [];
  const end = Date.now() + SECONDS * 1000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 5000));
    if (page) {
      const s = (await page.evaluate(() => {
        const snap = window.__ELSEWHERE__!.snapshot();
        return { frame: snap.frame, players: snap.players.length, remotes: (snap.remotes as { visible: boolean }[]).filter((r) => r.visible).length, connection: snap.connection };
      })) as { frame: FrameStats; players: number; remotes: number; connection: string };
      samples.push({ t: Math.round((Date.now() - t0) / 1000), frame: s.frame, players: s.players, remotesVisible: s.remotes, connection: s.connection });
      log(`t=${samples.at(-1)!.t}s players=${s.players} visibleRemotes=${s.remotes} frame avg=${s.frame.avg.toFixed(1)}ms p95=${s.frame.p95.toFixed(1)}ms max=${s.frame.max.toFixed(1)}ms >50ms=${s.frame.over50}/${s.frame.n}`);
    } else {
      log(`t=${Math.round((Date.now() - t0) / 1000)}s bots=${bots.length}`);
    }
  }
  clearInterval(timer);

  if (page) {
    // Responsiveness: a key press while loaded must move the player promptly.
    const before = (await page.evaluate(() => window.__ELSEWHERE__!.snapshot().local)) as { x: number; z: number };
    const tPress = Date.now();
    await page.keyboard.down('KeyS');
    await page.waitForFunction(
      (b) => {
        const l = window.__ELSEWHERE__!.snapshot().local;
        return Math.hypot(l.x - b.x, l.z - b.z) > 0.3;
      },
      before,
      { timeout: 5000 },
    );
    const latency = Date.now() - tPress;
    await page.keyboard.up('KeyS');
    log(`input→movement latency under load: ${latency} ms (includes Playwright round trips)`);
  }
  const corrections = bots.reduce((a, b) => a + b.corrections, 0);
  const sent = bots.reduce((a, b) => a + b.sent, 0);
  log(`bot moves sent=${sent} corrections=${corrections} (${((corrections / Math.max(1, sent)) * 100).toFixed(2)}%)`);
  const errors = (globalThis as { __errors?: string[] }).__errors ?? [];
  log(`browser console errors: ${errors.length}`, errors.slice(0, 5));
  console.log(JSON.stringify({ clients: bots.length, seconds: SECONDS, samples, corrections, sent, consoleErrors: errors.length }, null, 1));
} catch (err) {
  console.error('[load] FAIL', err);
  process.exitCode = 1;
} finally {
  await Promise.all(bots.map((b) => b.room.leave(true).catch(() => undefined)));
  await browser?.close();
}
