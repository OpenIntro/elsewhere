import { describe, expect, it } from 'vitest';
import { CONFIG } from '@elsewhere/shared';
import { EXTRAPOLATE_MS, TELEPORT_DISTANCE, pushInto, sampleBuffer } from '../src/net/interpolation.js';
import type { Pose, RemoteRuntime } from '../src/state/runtime.js';

const PATCH = 1000 / CONFIG.network.patchRateHz;
const DELAY = CONFIG.network.interpolationDelayMs;

function remote(): RemoteRuntime {
  return { buffer: [], anim: 'walk', teleportSeq: 0 };
}
const pose = (): Pose => ({ x: 0, y: 0, z: 0, rot: 0 });

describe('interpolation buffer', () => {
  it('lerps between bracketing snapshots', () => {
    const r = remote();
    pushInto(r, { t: 1000, x: 0, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 1050, x: 0.1, y: 0, z: 0.1, rot: 0.5 });
    const out = pose();
    expect(sampleBuffer(r, 1025, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.05);
    expect(out.z).toBeCloseTo(0.05);
    expect(out.rot).toBeCloseTo(0.25);
  });

  it('interpolates rotation the short way round', () => {
    const r = remote();
    pushInto(r, { t: 0, x: 0, y: 0, z: 0, rot: Math.PI - 0.1 });
    pushInto(r, { t: 50, x: 0.1, y: 0, z: 0, rot: -Math.PI + 0.1 });
    const out = pose();
    sampleBuffer(r, 25, out);
    expect(Math.abs(Math.abs(out.rot) - Math.PI)).toBeLessThan(0.01);
  });

  it('produces monotonic, jitter-free positions for a steady walk at 20 Hz with receive jitter', () => {
    const r = remote();
    const speed = CONFIG.movement.walkSpeed;
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const out = pose();
    let lastX = -Infinity;
    let maxStep = 0;
    // Patches every 50 ms (±8 ms jitter); render at 60 fps.
    let nextPatch = 0;
    let k = 0;
    for (let now = 0; now < 3000; now += 1000 / 60) {
      while (nextPatch <= now) {
        pushInto(r, { t: nextPatch + rand() * 16, x: (k * PATCH * speed) / 1000, y: 0, z: 0, rot: 0 });
        k++;
        nextPatch += PATCH;
      }
      if (now < DELAY + 100) continue;
      sampleBuffer(r, now - DELAY, out);
      expect(out.x).toBeGreaterThanOrEqual(lastX - 1e-9);
      if (lastX > -Infinity) maxStep = Math.max(maxStep, out.x - lastX);
      lastX = out.x;
    }
    // One 60 fps frame at walk speed is ~0.053 m; allow generous jitter headroom.
    expect(maxStep).toBeLessThan(0.12);
  });

  it('extrapolates briefly past the newest sample, then holds', () => {
    const r = remote();
    r.anim = 'run'; // 0.3 m per 50 ms = 6 m/s
    pushInto(r, { t: 0, x: 0, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 50, x: 0.3, y: 0, z: 0, rot: 0 });
    const out = pose();
    sampleBuffer(r, 100, out);
    expect(out.x).toBeCloseTo(0.6);
    sampleBuffer(r, 50 + EXTRAPOLATE_MS * 5, out);
    expect(out.x).toBeCloseTo(0.3 + (0.3 * EXTRAPOLATE_MS) / 50);
  });

  it('does not extrapolate an idle remote (it has stopped)', () => {
    const r = remote();
    r.anim = 'idle';
    pushInto(r, { t: 0, x: 0, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 50, x: 0.3, y: 0, z: 0, rot: 0 });
    const out = pose();
    sampleBuffer(r, 200, out);
    expect(out.x).toBeCloseTo(0.3);
  });

  it('snaps (never lerps) across a teleport and bumps teleportSeq', () => {
    const r = remote();
    pushInto(r, { t: 0, x: 0, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 50, x: 0.2, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 100, x: 0.2 + TELEPORT_DISTANCE + 10, y: 0, z: 0, rot: 0 });
    expect(r.teleportSeq).toBe(1);
    const out = pose();
    sampleBuffer(r, 75, out);
    expect(out.x).toBeCloseTo(0.2 + TELEPORT_DISTANCE + 10);
  });

  it('does not creep when a player resumes after standing still', () => {
    const r = remote();
    pushInto(r, { t: 0, x: 5, y: 0, z: 0, rot: 0 });
    // Stands still for 2 s (identical patches just confirm), then moves.
    for (let t = 50; t <= 2000; t += 50) pushInto(r, { t, x: 5, y: 0, z: 0, rot: 0 });
    pushInto(r, { t: 2050, x: 5.15, y: 0, z: 0, rot: 0 });
    const out = pose();
    // Half a second before the move the rendered pose must still be at rest.
    sampleBuffer(r, 1500, out);
    expect(out.x).toBe(5);
    sampleBuffer(r, 2025, out);
    expect(out.x).toBeCloseTo(5.075);
  });

  it('bounds the buffer and recycles snapshot objects', () => {
    const r = remote();
    for (let i = 0; i < 500; i++) pushInto(r, { t: i * 50, x: i * 0.1, y: 0, z: 0, rot: 0 });
    expect(r.buffer.length).toBeLessThanOrEqual(24);
    const out = pose();
    sampleBuffer(r, 499 * 50 - 25, out);
    expect(out.x).toBeCloseTo(49.85);
  });

  it('spreads bunched arrivals (busy main thread) so the rendered motion does not jump', () => {
    const r = remote();
    const speed = CONFIG.movement.walkSpeed;
    // Patches are generated every 50 ms but delivered in batches of 6 every 300 ms (a ~3 fps main thread), all with the same receive time.
    let k = 0;
    for (let batch = 0; batch < 12; batch++) {
      const t = batch * 300;
      for (let i = 0; i < 6; i++, k++) pushInto(r, { t, x: (k * PATCH * speed) / 1000, y: 0, z: 0, rot: 0 });
    }
    const out = pose();
    let last = -Infinity;
    let maxSpeed = 0;
    for (let now = 900; now < 3200; now += 1000 / 60) {
      sampleBuffer(r, now - DELAY, out);
      if (last > -Infinity) maxSpeed = Math.max(maxSpeed, (out.x - last) / (1 / 60));
      expect(out.x).toBeGreaterThanOrEqual(last - 1e-9);
      last = out.x;
    }
    // Without smoothing, equal stamps make the pose jump a whole batch (~0.8 m) in one frame.
    expect(maxSpeed).toBeLessThan(speed * 2);
  });

  it('keeps constant speed when 15 Hz moves are sampled by 20 Hz patches (uneven 50/100 ms gaps)', () => {
    const r = remote();
    const speed = CONFIG.movement.walkSpeed;
    const moveEvery = 1000 / CONFIG.movement.sendRateHz;
    // Each patch carries the latest move the server has; some patches repeat the previous pose.
    for (let t = 0; t <= 4000; t += PATCH) {
      const lastMove = Math.floor(t / moveEvery) * moveEvery;
      pushInto(r, { t, x: (lastMove * speed) / 1000, y: 0, z: 0, rot: 0 });
    }
    const out = pose();
    let prevX = -Infinity;
    let prevT = 0;
    let maxSpeed = 0;
    // Speed over 100 ms windows (the data itself is only 15 Hz).
    for (let now = 600; now < 3800; now += 100) {
      sampleBuffer(r, now - DELAY, out);
      if (prevX > -Infinity) maxSpeed = Math.max(maxSpeed, (out.x - prevX) / ((now - prevT) / 1000));
      prevX = out.x;
      prevT = now;
    }
    expect(maxSpeed).toBeLessThan(speed * 1.35);
  });

  it('a sender that only updates every 250 ms (slow device) still interpolates smoothly', () => {
    const r = remote();
    const speed = CONFIG.movement.walkSpeed;
    for (let t = 0; t <= 4000; t += 250) pushInto(r, { t, x: (t * speed) / 1000, y: 0, z: 0, rot: 0 });
    const out = pose();
    let prevX = -Infinity;
    let maxSpeed = 0;
    for (let now = 600; now < 3800; now += 1000 / 60) {
      sampleBuffer(r, now - DELAY, out);
      if (prevX > -Infinity) maxSpeed = Math.max(maxSpeed, (out.x - prevX) * 60);
      prevX = out.x;
    }
    expect(maxSpeed).toBeLessThan(speed * 1.35);
  });

  it('plays a real hitchy-sender stream (captured: sender at ~2 fps) at a believable walking speed', () => {
    // Receive time (ms) and position of a remote walking diagonally, captured from a software-rendered
    // browser whose main thread ran at ~490 ms/frame, so its moves arrived in bursts.
    const stream: [number, number, number][] = [
      [13868, 0.52, -3.72], [14157, 0.87, -4.07], [14558, 1.49, -4.69], [14833, 2.54, -5.74], [15105, 3.13, -6.33],
      [15327, 4.21, -7.41], [15633, 4.8, -8.0], [15919, 5.59, -8.79], [16190, 6.24, -9.44], [16471, 6.85, -10.05],
      [16754, 7.47, -10.67], [17004, 8.11, -11.31],
    ];
    const r = remote();
    r.anim = 'idle';
    pushInto(r, { t: 9381, x: 0, y: 0, z: -3.2, rot: 0 });
    for (let t = 9431; t < 13868; t += 50) pushInto(r, { t, x: 0, y: 0, z: -3.2, rot: 0 }); // standing (confirms)
    r.anim = 'walk';
    for (const [t, x, z] of stream) pushInto(r, { t, x, y: 0, z, rot: 0 });
    const out = pose();
    const series: { t: number; x: number; z: number }[] = [];
    for (let now = 13868; now < 17600; now += 1000 / 60) {
      sampleBuffer(r, now - DELAY, out);
      series.push({ t: now, x: out.x, z: out.z });
    }
    let maxSpeed = 0;
    for (let i = 1, j = 0; i < series.length; i++) {
      while (j + 1 < i && series[i]!.t - series[j + 1]!.t >= 50) j++;
      const dt = (series[i]!.t - series[j]!.t) / 1000;
      if (dt >= 0.05) maxSpeed = Math.max(maxSpeed, Math.hypot(series[i]!.x - series[j]!.x, series[i]!.z - series[j]!.z) / dt);
      // Monotonic along the walk direction (+x, -z).
      expect(series[i]!.x - series[i - 1]!.x).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(maxSpeed).toBeLessThan(CONFIG.movement.walkSpeed * 1.6);
  });
});
