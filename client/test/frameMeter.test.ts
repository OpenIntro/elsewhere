/** The frame meter (client/src/game/perf.ts): ring buffer, p50 / p95 and fps. */
import { describe, expect, it } from 'vitest';
import { FrameRing, METER_FRAMES, frameReadout, meterFrame } from '../src/game/perf.js';

describe('frame meter', () => {
  it('is empty before the first frame', () => {
    expect(new FrameRing(10).stats()).toEqual({ n: 0, fps: 0, p50Ms: 0, p95Ms: 0 });
  });

  it('p50 / p95 are nearest-rank percentiles and fps is frames over their summed time', () => {
    const r = new FrameRing(300);
    // 1..100 ms, shuffled.
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    for (let i = v.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [v[i], v[j]] = [v[j]!, v[i]!];
    }
    for (const ms of v) r.push(ms);
    const s = r.stats();
    expect(s.n).toBe(100);
    expect(s.p50Ms).toBe(50);
    expect(s.p95Ms).toBe(95);
    expect(s.fps).toBeCloseTo((100 * 1000) / 5050, 6);
  });

  it('steady 60 fps reads 60 fps, 16.7 ms typical and slow', () => {
    const r = new FrameRing(300);
    for (let i = 0; i < 500; i++) r.push(1000 / 60);
    const s = r.stats();
    expect(s.n).toBe(300);
    expect(s.fps).toBeCloseTo(60, 3);
    expect(s.p50Ms).toBeCloseTo(16.667, 2);
    expect(s.p95Ms).toBeCloseTo(16.667, 2);
  });

  it('the ring keeps only the newest frames (wraps)', () => {
    const r = new FrameRing(5);
    for (let i = 1; i <= 12; i++) r.push(i);
    expect(r.length).toBe(5);
    expect(r.values()).toEqual([8, 9, 10, 11, 12]);
    expect(r.values(2)).toEqual([11, 12]);
    expect(r.stats(2)).toMatchObject({ n: 2, p50Ms: 11, p95Ms: 12 });
  });

  it('one slow frame in ten shows up in p95, not in p50', () => {
    const r = new FrameRing(300);
    for (let i = 0; i < 200; i++) r.push(i % 10 === 0 ? 100 : 10);
    const s = r.stats();
    expect(s.p50Ms).toBe(10);
    expect(s.p95Ms).toBe(100);
    // 180 x 10 ms + 20 x 100 ms = 3.8 s for 200 frames.
    expect(s.fps).toBeCloseTo(200 / 3.8, 6);
  });

  it('ignores invalid frame times', () => {
    const r = new FrameRing(10);
    r.push(Number.NaN);
    r.push(-1);
    r.push(Number.POSITIVE_INFINITY);
    r.push(20);
    expect(r.stats()).toMatchObject({ n: 1, p50Ms: 20, fps: 50 });
  });

  it('the readout covers the newest METER_FRAMES frames and the last frame’s renderer counts', () => {
    for (let i = 0; i < METER_FRAMES; i++) meterFrame(1000, { calls: 1, triangles: 1 });
    for (let i = 0; i < METER_FRAMES; i++) meterFrame(20, { calls: 200 + i, triangles: 5000 });
    const m = frameReadout();
    expect(m.n).toBe(METER_FRAMES);
    expect(m.fps).toBeCloseTo(50, 6);
    expect(m.p50Ms).toBe(20);
    expect(m.p95Ms).toBe(20);
    expect(m.calls).toBe(200 + METER_FRAMES - 1);
    expect(m.triangles).toBe(5000);
  });
});
