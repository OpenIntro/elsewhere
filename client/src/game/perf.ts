/**
 * Tiny per-frame CPU timers for the player/net/game systems (exposed as
 * snapshot().perf). Each section accumulates ms; the debug section reports a
 * per-frame average over the frames since the last read.
 *
 * Also the frame meter (production builds too; nothing leaves the device):
 * a ring of the last frame times plus the renderer's draw calls / triangles of
 * the last frame, read by Settings → Display ("Performance") and by
 * snapshot().frame.
 */
import { registerDebugSection } from '../net/index.js';

const sections = new Map<string, { total: number; frames: number; max: number; cur: number; frame: number }>();
let frameNo = 0;

export function perfFrame(): void {
  frameNo++;
}

/** Add `ms` to section `name` for the current frame. */
export function perfAdd(name: string, ms: number): void {
  let s = sections.get(name);
  if (!s) sections.set(name, (s = { total: 0, frames: 0, max: 0, cur: 0, frame: -1 }));
  if (s.frame !== frameNo) {
    if (s.frame >= 0) {
      s.frames++;
      s.max = Math.max(s.max, s.cur);
    }
    s.frame = frameNo;
    s.cur = 0;
  }
  s.cur += ms;
  s.total += ms;
}

registerDebugSection('perf', () => {
  const out: Record<string, { avgMs: number; maxMs: number; frames: number }> = {};
  for (const [k, s] of sections) {
    out[k] = { avgMs: s.frames ? s.total / s.frames : 0, maxMs: s.max, frames: s.frames };
    s.total = 0;
    s.frames = 0;
    s.max = 0;
  }
  return out;
});

// ---------------------------------------------------------------------------
// Frame meter
// ---------------------------------------------------------------------------

/** Frames the meter's fps / typical / slow figures are taken over (~5 s at 60 fps). */
export const METER_FRAMES = 300;

export interface FrameStats {
  /** Frames in the window. */
  n: number;
  /** Frames per second over the window (frames / their summed time). */
  fps: number;
  /** Typical frame (median) and slow frame (95th percentile), ms. */
  p50Ms: number;
  p95Ms: number;
}

/** A fixed-size ring of frame times (ms) with percentile / rate read-outs. */
export class FrameRing {
  readonly size: number;
  private readonly ms: Float32Array;
  private count = 0;
  constructor(size: number) {
    this.size = size;
    this.ms = new Float32Array(size);
  }
  push(ms: number): void {
    if (!(ms >= 0) || !Number.isFinite(ms)) return;
    this.ms[this.count % this.size] = ms;
    this.count++;
  }
  /** Frames held (at most `size`). */
  get length(): number {
    return Math.min(this.count, this.size);
  }
  /** The newest `last` frames (default: all held), oldest first. */
  values(last = this.size): number[] {
    const n = Math.min(this.length, last);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.ms[(this.count - n + i) % this.size]!;
    return out;
  }
  /** fps and p50 / p95 over the newest `last` frames (nearest-rank percentiles). */
  stats(last = this.size): FrameStats {
    const v = this.values(last);
    const n = v.length;
    if (!n) return { n: 0, fps: 0, p50Ms: 0, p95Ms: 0 };
    const sum = v.reduce((a, b) => a + b, 0);
    v.sort((a, b) => a - b);
    const rank = (q: number) => v[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]!;
    return { n, fps: sum > 0 ? (n * 1000) / sum : 0, p50Ms: rank(0.5), p95Ms: rank(0.95) };
  }
  clear(): void {
    this.count = 0;
  }
}

/**
 * 600 frames: the meter reads the newest METER_FRAMES; the older debug fields of snapshot().frame
 * (n / avg / p95 / max / over50, used by scripts/load-clients.mts) keep their 600-frame window.
 */
const ring = new FrameRing(600);
const last = { calls: 0, triangles: 0 };

/** One rendered frame: its time (ms) and the renderer's counts for it (`gl.info.render`). */
export function meterFrame(ms: number, render: { calls: number; triangles: number }): void {
  ring.push(ms);
  last.calls = render.calls;
  last.triangles = render.triangles;
}

export interface FrameReadout extends FrameStats {
  /** Draw calls and triangles of the last rendered frame (all passes, shadows included). */
  calls: number;
  triangles: number;
}

/** What the Performance line shows. */
export function frameReadout(): FrameReadout {
  return { ...ring.stats(METER_FRAMES), calls: last.calls, triangles: last.triangles };
}

/** snapshot().frame: the meter plus the older fields over the full 600-frame window. */
function frameSection() {
  const all = ring.values();
  const n = all.length;
  let sum = 0;
  let max = 0;
  let over50 = 0;
  for (const v of all) {
    sum += v;
    if (v > max) max = v;
    if (v > 50) over50++;
  }
  const sorted = all.sort((a, b) => a - b);
  const m = frameReadout();
  return { fps: m.fps, p50Ms: m.p50Ms, p95Ms: m.p95Ms, calls: m.calls, triangles: m.triangles, window: m.n, n, avg: n ? sum / n : 0, p95: n ? sorted[Math.floor(n * 0.95)]! : 0, max, over50 };
}

/**
 * Claim snapshot().frame for the meter. Called on the first rendered frame (after every component's
 * mount effects, so it replaces the older frame-time section the player systems register at mount).
 */
export function installFrameSection(): void {
  registerDebugSection('frame', frameSection);
}
