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
    pushInto(r, { t: 1050, x: 1, y: 0, z: 2, rot: 0.5 });
    const out = pose();
    expect(sampleBuffer(r, 1025, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.5);
    expect(out.z).toBeCloseTo(1);
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
    pushInto(r, { t: 2050, x: 5.3, y: 0, z: 0, rot: 0 });
    const out = pose();
    // Half a second before the move the rendered pose must still be at rest.
    sampleBuffer(r, 1500, out);
    expect(out.x).toBe(5);
    sampleBuffer(r, 2025, out);
    expect(out.x).toBeCloseTo(5.15);
  });

  it('bounds the buffer and recycles snapshot objects', () => {
    const r = remote();
    for (let i = 0; i < 500; i++) pushInto(r, { t: i * 50, x: i * 0.1, y: 0, z: 0, rot: 0 });
    expect(r.buffer.length).toBeLessThanOrEqual(24);
    const out = pose();
    sampleBuffer(r, 499 * 50 - 25, out);
    expect(out.x).toBeCloseTo(49.85);
  });
});
