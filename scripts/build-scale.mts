#!/usr/bin/env -S npx tsx --conditions=source
/**
 * Building at scale: seeds N pieces (default 2000) THROUGH THE REAL SERVER
 * PATH (protocol clients sending C2S.buildPlace to a production server:
 * validation, persistence, broadcast) and measures what a player and the
 * server pay for them. Test tooling only — nothing here is part of the product.
 *
 *   npm run build && npx tsx --conditions=source scripts/build-scale.mts [--pieces 2000] [--bots 30]
 *
 * Spawns its own production server (PORT $SCALE_PORT or 2634, fresh temp
 * DATA_DIR, ADMIN_TOKEN for the stats route). The seeding server gets
 * generous BUILD_RANGE / BUILD_RATE_* / BUILD_MAX_PER_PLAYER env overrides so
 * a few seeders can place from the Town Square without walking; every other
 * rule (grid, zones, overlap, support, caps) applies as in production.
 *
 * Reports (JSON + plain lines):
 *  - seeding: pieces placed / refused, time
 *  - join: a real browser (Playwright, desktop 1440x900) from page load to the
 *    full build snapshot applied; websocket bytes received during the join
 *    (Chrome DevTools frames), with 0 pieces and with N pieces
 *  - state patches: websocket bytes/s while idle after joining (pieces are
 *    not in the Colyseus schema, so this must not grow with N)
 *  - client render: draw calls / triangles of the build layer and of the
 *    whole frame, frame time (software WebGL in headless Chromium!)
 *  - server: event-loop delay (p50/p99/max) with M protocol clients walking,
 *    0 vs N pieces; validation time per placement; resolveMovement cost next
 *    to pieces; heap
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Room } from '@colyseus/sdk';
import { C2S, CONFIG, PIECES, PieceIndex, ROOM_NAME, S2C, WORLD_BOUNDS, isWalkable, resolveMovement, validatePlacement, type PieceKind, type PieceLike } from '@elsewhere/shared';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const N = Number(arg('pieces', '2000'));
const BOTS = Number(arg('bots', '30'));
const SEEDERS = 8;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SCALE_PORT ?? 2634);
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'scale-admin-token-0123456789';
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'elsewhere-scale-'));
const log = (...a: unknown[]) => console.log('[scale]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
let server: ChildProcess | null = null;
async function startServer(): Promise<void> {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR,
    SESSION_SECRET: 'scale-test-secret-0123456789abcdef0123456789',
    ADMIN_TOKEN: ADMIN,
    BUILD_RANGE: '400',
    BUILD_RATE_CAPACITY: '100000',
    BUILD_RATE_PER_SECOND: '100000',
    BUILD_MAX_PER_PLAYER: '100000',
    BUILD_MAX_PER_WORLD: String(Math.max(N + 100, CONFIG.building.maxPiecesPerWorld)),
  };
  server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let t = 0; t < 150; t++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  throw new Error('server did not start');
}
async function stats(q = '') {
  return (await (await fetch(`${BASE}/api/admin/build/stats${q}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, any>;
}

// ---------------------------------------------------------------------------
// Plan N pieces locally with the shared rulebook: little 4 x 2 m huts (floor,
// walls, a doorway, a window, roof) with a lamp, a crate and a fence, on every
// free plot of the island, one seeder (owner) per plot.
// ---------------------------------------------------------------------------
interface Order {
  seeder: number;
  kind: PieceKind;
  variant: string;
  x: number;
  z: number;
  rot: number;
  level: number;
}
function planPieces(): Order[] {
  const ix = new PieceIndex();
  const out: Order[] = [];
  let n = 0;
  const tryPut = (seeder: number, kind: PieceKind, x: number, z: number, rot = 0, level = 0): boolean => {
    const variant = PIECES[kind].variants[(x + z + level) % PIECES[kind].variants.length | 0]?.id ?? PIECES[kind].variants[0]!.id;
    const v = validatePlacement({ kind, variant, x, z, rot, level }, { index: ix, builderId: `s${seeder}`, builderPos: null, players: [] });
    if (!v.ok) return false;
    ix.add({ id: `l${n++}`, kind, x, z, rot, level, y: v.y, ownerId: `s${seeder}` } as PieceLike);
    out.push({ seeder, kind, variant, x, z, rot, level });
    return true;
  };
  let plot = 0;
  for (let cz = Math.ceil(WORLD_BOUNDS.minZ / 7) * 7; cz < WORLD_BOUNDS.maxZ && out.length < N; cz += 7) {
    for (let cx = Math.ceil(WORLD_BOUNDS.minX / 8) * 8; cx < WORLD_BOUNDS.maxX && out.length < N; cx += 8) {
      const s = plot++ % SEEDERS;
      const hut: [PieceKind, number, number, number, number][] = [
        ['floor', cx - 1, cz, 0, 0],
        ['floor', cx + 1, cz, 0, 0],
        ['wall', cx - 1, cz - 1, 0, 0],
        ['wall_window', cx + 1, cz - 1, 0, 0],
        ['wall', cx - 2, cz, 1, 0],
        ['wall', cx + 2, cz, 1, 0],
        ['doorway', cx - 1, cz + 1, 0, 0],
        ['wall_window', cx + 1, cz + 1, 0, 0],
      ];
      // Only start a hut where all of its ground pieces fit.
      const probe = new PieceIndex();
      if (!hut.every(([k, x, z, r]) => validatePlacement({ kind: k, variant: PIECES[k].variants[0]!.id, x, z, rot: r, level: 0 }, { index: ix, builderId: `s${s}`, builderPos: null, players: [] }).ok)) continue;
      void probe;
      for (const [k, x, z, r, l] of hut) if (out.length < N) tryPut(s, k, x, z, r, l);
      for (const x of [cx - 1, cx + 1]) if (out.length < N) tryPut(s, 'roof_peak', x, cz, 1, 1);
      if (out.length < N) tryPut(s, 'lamp', cx + 2.5, cz + 2);
      if (out.length < N) tryPut(s, 'crate', cx - 2.5, cz + 2);
      if (out.length < N) tryPut(s, 'fence', cx, cz + 3, 0);
      if (out.length < N) tryPut(s, 'planter', cx + 3, cz - 2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
async function seeder(i: number): Promise<{ room: Room; results: Map<number, { ok: boolean; reason?: string }> }> {
  const room = await new Client(BASE).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, name: `Seeder ${i + 1}` });
  const results = new Map<number, { ok: boolean; reason?: string }>();
  room.onMessage(S2C.buildResult, (r: { reqId: number; ok: boolean; reason?: string }) => results.set(r.reqId, r));
  room.onMessage('*', () => undefined);
  return { room, results };
}

interface Bot {
  room: Room;
  x: number;
  z: number;
  dx: number;
  dz: number;
  seq: number;
}
async function bots(n: number): Promise<Bot[]> {
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const room = await new Client(BASE).joinOrCreate(ROOM_NAME, { protocolVersion: CONFIG.protocolVersion, name: `Walker ${i + 1}` });
    room.onMessage('*', () => undefined);
    const bot: Bot = { room, x: 0, z: 0, dx: 1, dz: 0, seq: 0 };
    room.onMessage(S2C.correction, (c: { x: number; z: number }) => {
      bot.x = c.x;
      bot.z = c.z;
    });
    for (let t = 0; t < 100; t++) {
      const me = (room.state as { players?: Map<string, { x: number; z: number }> }).players?.get(room.sessionId);
      if (me) {
        bot.x = me.x;
        bot.z = me.z;
        break;
      }
      await sleep(30);
    }
    out.push(bot);
  }
  return out;
}
async function walk(list: Bot[], seconds: number): Promise<void> {
  const dt = 1 / CONFIG.movement.sendRateHz;
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    for (const b of list) {
      if (Math.random() < 0.03) {
        const a = Math.random() * Math.PI * 2;
        b.dx = Math.sin(a);
        b.dz = Math.cos(a);
      }
      const to = { x: b.x + b.dx * CONFIG.movement.walkSpeed * dt, z: b.z + b.dz * CONFIG.movement.walkSpeed * dt };
      const next = resolveMovement({ x: b.x, z: b.z }, to);
      if (!isWalkable(next) || Math.hypot(next.x, next.z) > 45) {
        b.dx = -b.dx;
        b.dz = -b.dz;
        continue;
      }
      b.x = next.x;
      b.z = next.z;
      b.room.send(C2S.move, { x: b.x, z: b.z, rot: Math.atan2(b.dx, b.dz), anim: 'walk', seq: ++b.seq });
    }
    await sleep(dt * 1000);
  }
}

async function measureBrowser(label: string, expect: number) {
  const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(`try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    let wsBytes = 0;
    let wsFrames = 0;
    cdp.on('Network.webSocketFrameReceived', (e: { response: { opcode: number; payloadData: string } }) => {
      wsFrames++;
      // Binary frames arrive base64-encoded.
      wsBytes += e.response.opcode === 2 ? Math.floor((e.response.payloadData.length * 3) / 4) : e.response.payloadData.length;
    });
    const t0 = Date.now();
    await page.goto(`${BASE}/?autojoin=1`);
    await page.waitForFunction((n) => {
      const s = window.__ELSEWHERE__?.snapshot() as { connection?: string; build?: { synced: boolean; count: number } } | undefined;
      return s?.connection === 'connected' && s.build?.synced && s.build.count >= n;
    }, expect, { timeout: 180_000, polling: 100 });
    const joinMs = Date.now() - t0;
    const joinBytes = wsBytes;
    const joinFrames = wsFrames;
    const snap1 = (await page.evaluate(() => window.__ELSEWHERE__!.snapshot())) as Record<string, any>;
    // Idle traffic (state patches + world ticks) for 10 s.
    await sleep(3000);
    const b0 = wsBytes;
    const f0 = wsFrames;
    await sleep(10_000);
    const idleBytesPerSec = (wsBytes - b0) / 10;
    const idleFramesPerSec = (wsFrames - f0) / 10;
    const snap = (await page.evaluate(() => window.__ELSEWHERE__!.snapshot())) as Record<string, any>;
    return {
      label,
      pieces: snap.build.count,
      joinMs,
      joinWsBytes: joinBytes,
      joinWsFrames: joinFrames,
      snapshotJsonBytes: snap1.build.stats.snapshotBytes,
      snapshotChunks: snap1.build.stats.snapshotChunks,
      snapshotApplyMs: Math.round(snap1.build.stats.lastSnapshotMs * 10) / 10,
      idleWsBytesPerSec: Math.round(idleBytesPerSec),
      idleWsFramesPerSec: Math.round(idleFramesPerSec * 10) / 10,
      buildRender: snap.buildRender,
      frame: snap.frame,
      errors,
    };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
const report: Record<string, unknown> = { pieces: N, bots: BOTS, node: process.version };
try {
  log(`data dir ${DATA_DIR}; server ${BASE}`);
  await startServer();
  const plan = planPieces();
  log(`planned ${plan.length} pieces`);
  if (plan.length < N) log(`WARNING: only ${plan.length} pieces fit the plan`);

  // --- 0 pieces baseline -------------------------------------------------
  report.browserEmpty = await measureBrowser('0 pieces', 0);
  log('browser, empty world:', JSON.stringify(report.browserEmpty));
  let walkers = await bots(BOTS);
  await stats('?reset=1');
  await walk(walkers, 15);
  report.serverEmpty = await stats('?bench=1&reset=1');
  for (const b of walkers) await b.room.leave();
  log('server, empty world, walkers:', JSON.stringify(report.serverEmpty));

  // --- Seed through the real server path -----------------------------------
  const seeders = await Promise.all(Array.from({ length: SEEDERS }, (_, i) => seeder(i)));
  const t0 = Date.now();
  let refused: Record<string, number> = {};
  let req = 0;
  const bySeeder = seeders.map((_, i) => plan.filter((o) => o.seeder === i));
  await Promise.all(
    seeders.map(async (s, i) => {
      for (const o of bySeeder[i]!) {
        const id = ++req;
        s.room.send(C2S.buildPlace, { reqId: id, kind: o.kind, variant: o.variant, x: o.x, z: o.z, rot: o.rot, level: o.level });
        for (let w = 0; !s.results.has(id) && w < 2000; w++) await sleep(2);
        const r = s.results.get(id);
        if (!r?.ok) refused[r?.reason ?? 'timeout'] = (refused[r?.reason ?? 'timeout'] ?? 0) + 1;
      }
    }),
  );
  const seedMs = Date.now() - t0;
  for (const s of seeders) await s.room.leave();
  const afterSeed = await stats('?reset=1');
  report.seeding = { placed: afterSeed.pieces, refused, ms: seedMs, perPieceMs: Math.round((seedMs / plan.length) * 100) / 100, validationAvgMs: afterSeed.validation.avgMs, validationMaxMs: afterSeed.validation.maxMs };
  log('seeding:', JSON.stringify(report.seeding));

  // --- N pieces -------------------------------------------------------------
  report.browserFull = await measureBrowser(`${afterSeed.pieces} pieces`, afterSeed.pieces);
  log('browser, full world:', JSON.stringify(report.browserFull));
  walkers = await bots(BOTS);
  await stats('?reset=1');
  await walk(walkers, 15);
  report.serverFull = await stats('?bench=1&reset=1');
  for (const b of walkers) await b.room.leave();
  log('server, full world, walkers:', JSON.stringify(report.serverFull));

  // Restart: load time from the database.
  server?.kill('SIGTERM');
  await new Promise((r) => server?.once('exit', r));
  const r0 = Date.now();
  await startServer();
  report.restart = { healthyAfterMs: Date.now() - r0, pieces: (await stats()).pieces };
  log('restart:', JSON.stringify(report.restart));
} finally {
  server?.kill('SIGTERM');
}
console.log(JSON.stringify(report, null, 2));
