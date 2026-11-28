/**
 * The one production-server harness for the browser suites: spawn
 * `server/dist/index.js` on a port with a fresh (or given) DATA_DIR and a
 * random SESSION_SECRET, wait for /api/health, pipe its logs, stop / restart
 * it, and never leave it running behind us.
 *
 *   const server = await startServer({ port, env, dataDir, label, verbose });
 *   server.url / server.port / server.dataDir / server.proc
 *   await server.stop(); await server.start(); await server.restart();
 *
 * `createServer(opts)` gives the same handle without starting it.
 *
 * Stale ports: every server we start is recorded in a small pid file
 * (`<os tmpdir>/elsewhere-e2e-servers/<port>.json`, our pid + the server's).
 * If the port is busy when we start, and that file says the server was left
 * behind by a run that is no longer alive (killed uncleanly: SIGKILL, a closed
 * terminal, a container restart), that one server is stopped and we go on;
 * anything else on the port fails fast with a message saying what holds it.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'server/dist/index.js');
const PID_DIR = path.join(tmpdir(), 'elsewhere-e2e-servers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every handle that may still own a child; killed when this process exits. */
const live = new Set();
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const h of live) h.kill('SIGKILL');
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, async () => {
      const exits = [...live].map((h) => h.exit);
      for (const h of live) h.kill('SIGTERM');
      await Promise.race([Promise.all(exits), sleep(5000)]);
      process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129);
    });
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return null;
  }
}

/** True if something accepts TCP connections on localhost:port. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

const pidFile = (port) => path.join(PID_DIR, `${port}.json`);
function readPidFile(port) {
  try {
    return JSON.parse(readFileSync(pidFile(port), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Make sure `port` is free before spawning. Stops a server WE left behind
 * (recorded owner process gone, recorded server pid still running our entry);
 * otherwise throws a clear message.
 */
export async function ensurePortFree(port, label = 'e2e') {
  if (!(await portTaken(port))) return;
  const rec = readPidFile(port);
  const cmd = rec ? cmdline(rec.serverPid) : null;
  const ours = rec && cmd && cmd.includes('server/dist/index.js');
  if (ours && !alive(rec.ownerPid)) {
    console.log(`[${label}] port ${port}: stopping a stale server (pid ${rec.serverPid}) left behind by an earlier run (pid ${rec.ownerPid}, no longer running)`);
    try {
      process.kill(rec.serverPid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const t0 = Date.now();
    while (alive(rec.serverPid) && Date.now() - t0 < 10_000) await sleep(200);
    if (alive(rec.serverPid)) process.kill(rec.serverPid, 'SIGKILL');
    while (Date.now() - t0 < 15_000 && (await portTaken(port))) await sleep(200);
    if (!(await portTaken(port))) return;
  }
  const who = ours
    ? `a server started by another run that is still going (pid ${rec.ownerPid}, server pid ${rec.serverPid})`
    : 'another process (not a server this harness started)';
  throw new Error(`port ${port} is already in use by ${who}; stop it, or pick another port with this suite's *_PORT variable`);
}

/**
 * @param {{ port: number, env?: Record<string,string>, dataDir?: string, label?: string,
 *           verbose?: boolean, logPrefix?: string, healthTimeout?: number, tmpPrefix?: string }} opts
 */
export function createServer(opts) {
  const { port, label = 'e2e', verbose = false, healthTimeout = 30_000 } = opts;
  const env = { ...(opts.env ?? {}) };
  const dataDir = opts.dataDir ?? env.DATA_DIR ?? mkdtempSync(path.join(tmpdir(), opts.tmpPrefix ?? 'elsewhere-e2e-'));
  const secret = env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  const prefix = opts.logPrefix ?? '[server] ';
  const tail = [];
  const keep = (d) => {
    for (const line of String(d).split('\n')) if (line) tail.push(line);
    if (tail.length > 400) tail.splice(0, tail.length - 400);
  };

  const h = {
    port,
    url: `http://localhost:${port}`,
    dataDir,
    proc: null,
    exit: null,
    /** Last ~400 server log lines (stdout + stderr). */
    logs: () => tail.slice(),
    kill(sig) {
      if (h.proc && h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill(sig);
    },
    async start() {
      if (!existsSync(ENTRY) || !existsSync(path.join(ROOT, 'client/dist/index.html'))) throw new Error('production build missing: run `npm run build` first');
      await ensurePortFree(port, label);
      hookExit();
      h.proc = spawn(process.execPath, [ENTRY], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production', ...env, PORT: String(port), DATA_DIR: dataDir, SESSION_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      live.add(h);
      const proc = h.proc;
      h.exit = new Promise((r) => proc.once('exit', r));
      h.exit.then(() => {
        live.delete(h);
        const rec = readPidFile(port);
        if (rec && rec.serverPid === proc.pid) rmSync(pidFile(port), { force: true });
      });
      try {
        mkdirSync(PID_DIR, { recursive: true });
        writeFileSync(pidFile(port), JSON.stringify({ ownerPid: process.pid, serverPid: proc.pid, root: ROOT, at: new Date().toISOString() }));
      } catch {
        /* best effort */
      }
      proc.stdout.on('data', (d) => {
        keep(d);
        if (verbose) process.stdout.write(`${prefix}${d}`);
      });
      proc.stderr.on('data', (d) => {
        keep(d);
        process.stderr.write(`${prefix}${d}`);
      });
      const t0 = Date.now();
      while (Date.now() - t0 < healthTimeout) {
        if (proc.exitCode !== null) throw new Error(`server on ${port} exited with ${proc.exitCode}`);
        try {
          if ((await fetch(`${h.url}/api/health`)).ok) return h;
        } catch {
          /* not yet */
        }
        await sleep(200);
      }
      throw new Error(`server on ${port} did not become healthy`);
    },
    async stop() {
      const proc = h.proc;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      const done = await Promise.race([h.exit.then(() => true), sleep(15_000).then(() => false)]);
      if (!done) {
        proc.kill('SIGKILL');
        await h.exit;
      }
    },
    async restart() {
      await h.stop();
      return h.start();
    },
  };
  return h;
}

/** Create and start; resolves with the running handle. */
export async function startServer(opts) {
  const h = createServer(opts);
  await h.start();
  return h;
}
