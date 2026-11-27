/**
 * Pure parts of the browser-suite harness (scripts/lib/report.mjs): the per-suite result
 * recorder, the e2e:all summary rows / merge / table, and the door-walk stall detector.
 */
import { describe, expect, it } from 'vitest';
import { createRecorder, detectStalls, fmtMs, formatSummary, mergeSummary, polylineLength, suiteResult, summaryRow } from '../../scripts/lib/report.mjs';

type Sample = { t: number; x: number; z: number; path: boolean };

describe('createRecorder / suiteResult', () => {
  it('records checks in order with the time since the previous check', () => {
    let t = 1000;
    const rec = createRecorder('build', { now: () => t, t0: 1000 });
    t = 1500;
    rec.add('0. first', true, 'fine');
    t = 4000;
    rec.add('1. second', false, new Error('boom').message);
    const r = rec.result(1, ['A console.error: x']);
    expect(r.suite).toBe('build');
    expect(r.ms).toBe(3000);
    expect(r.checks.map((c: { name: string }) => c.name)).toEqual(['0. first', '1. second']);
    expect(r.checks.map((c: { ms: number }) => c.ms)).toEqual([500, 2500]);
    expect(r.checks[1]).toMatchObject({ ok: false, detail: 'boom' });
    expect(r.consoleErrors).toEqual(['A console.error: x']);
    expect(r.ok).toBe(false);
  });

  it('is ok only with exit 0, at least one check, and every check passed', () => {
    const pass = [{ name: 'a', ok: true, ms: 1, detail: '' }];
    expect(suiteResult({ suite: 's', checks: pass, ms: 1, exitCode: 0 }).ok).toBe(true);
    expect(suiteResult({ suite: 's', checks: pass, ms: 1, exitCode: 1 }).ok).toBe(false);
    expect(suiteResult({ suite: 's', checks: [], ms: 1, exitCode: 0 }).ok).toBe(false);
    expect(suiteResult({ suite: 's', checks: [...pass, { name: 'b', ok: false, ms: 1, detail: '' }], ms: 1, exitCode: 0 }).ok).toBe(false);
  });
});

describe('summaryRow / mergeSummary / formatSummary', () => {
  const result = (suite: string, oks: boolean[]) =>
    suiteResult({ suite, checks: oks.map((ok, i) => ({ name: `${i}. c${i}`, ok, ms: 10, detail: '' })), ms: 30, exitCode: oks.every(Boolean) ? 0 : 1 });

  it('counts passed / total and lists failed checks', () => {
    const row = summaryRow({ suite: 'build', run: 1, exitCode: 1, ms: 61_000, result: result('build', [true, false, true]) });
    expect(row).toMatchObject({ suite: 'build', ok: false, passed: 2, total: 3, failed: ['1. c1'] });
  });

  it('a suite without a result file fails even with exit 0', () => {
    const row = summaryRow({ suite: 'x', run: 1, exitCode: 0, ms: 5, result: null });
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/no result file/);
  });

  it('merges runs: per-run totals, overall ok only if every row passed', () => {
    const rows = [
      summaryRow({ suite: 'a', run: 1, exitCode: 0, ms: 1000, result: result('a', [true]) }),
      summaryRow({ suite: 'b', run: 1, exitCode: 0, ms: 2000, result: result('b', [true, true]) }),
      summaryRow({ suite: 'a', run: 2, exitCode: 0, ms: 1500, result: result('a', [true]) }),
      summaryRow({ suite: 'b', run: 2, exitCode: 1, ms: 2500, result: result('b', [true, false]) }),
    ];
    const s = mergeSummary(rows, { startedAt: 'x', finishedAt: 'y' });
    expect(s.ok).toBe(false);
    expect(s.totalMs).toBe(7000);
    expect(s.runs.map((r: { run: number; ok: boolean; ms: number }) => [r.run, r.ok, r.ms])).toEqual([
      [1, true, 3000],
      [2, false, 4000],
    ]);
    const text = formatSummary(s);
    expect(text).toMatch(/run\s+suite\s+checks\s+time\s+result/);
    expect(text).toMatch(/b\s+1\/2\s+3s\s+FAIL \(exit 1\)/);
    expect(text).toMatch(/run 2 b failed: 1\. c1/);
    expect(text).toMatch(/total wall-clock 7s; FAILED/);
    expect(mergeSummary([]).ok).toBe(false);
  });

  it('single run table has no run column', () => {
    const s = mergeSummary([summaryRow({ suite: 'acceptance', run: 1, exitCode: 0, ms: 125_000, result: result('acceptance', [true, true]) })]);
    const text = formatSummary(s);
    expect(text.split('\n')[0]).toMatch(/^suite\s+checks\s+time\s+result$/);
    expect(text).toMatch(/acceptance\s+2\/2\s+2m 05s\s+PASS/);
    expect(text).toMatch(/all passed/);
  });

  it('formats durations', () => {
    expect(fmtMs(999)).toBe('1s');
    expect(fmtMs(59_400)).toBe('59s');
    expect(fmtMs(61_000)).toBe('1m 01s');
    expect(fmtMs(undefined)).toBe('-');
  });
});

describe('detectStalls', () => {
  /** A walk sampled every 250 ms: `speed` m/s along +x for `secs` seconds (path active unless told). */
  function series(parts: { secs: number; speed: number; path?: boolean }[]): Sample[] {
    const out: Sample[] = [];
    let t = 0;
    let x = 0;
    for (const p of parts) {
      for (let k = 0; k < p.secs * 4; k++) {
        out.push({ t, x, z: -15.3, path: p.path ?? true });
        t += 250;
        x += p.speed * 0.25;
      }
    }
    return out;
  }

  it('no stall on a steady walk', () => {
    expect(detectStalls(series([{ secs: 20, speed: 1.5 }]))).toEqual([]);
  });

  it('finds a stop on open ground with the path still active (>= 5 s, < 0.2 m)', () => {
    const s = series([{ secs: 4, speed: 1.5 }, { secs: 8, speed: 0 }, { secs: 4, speed: 1.5 }]);
    const stalls = detectStalls(s);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].ms).toBeGreaterThanOrEqual(7500);
    expect(stalls[0].at.x).toBeCloseTo(6, 5);
    expect(stalls[0].moved).toBeLessThan(0.2);
  });

  it('a short pause (< 5 s) is not a stall', () => {
    expect(detectStalls(series([{ secs: 3, speed: 1.5 }, { secs: 4, speed: 0 }, { secs: 3, speed: 1.5 }]))).toEqual([]);
  });

  it('standing still with no path (arrived, or idle between taps) is not a stall', () => {
    expect(detectStalls(series([{ secs: 3, speed: 1.5 }, { secs: 20, speed: 0, path: false }]))).toEqual([]);
  });

  it('a slow crawl that keeps making progress is not a stall', () => {
    // 0.05 m/s: 0.25 m every 5 s.
    expect(detectStalls(series([{ secs: 30, speed: 0.05 }]))).toEqual([]);
  });

  it('jitter in place (back and forth under 0.2 m) is a stall', () => {
    const s: Sample[] = [];
    for (let k = 0; k < 40; k++) s.push({ t: k * 250, x: -2.7 + (k % 2 ? 0.08 : -0.08), z: -15.3, path: true });
    const stalls = detectStalls(s);
    expect(stalls).toHaveLength(1);
    expect(stalls[0].ms).toBe(39 * 250);
  });

  it('a stall still open at the end of the series is reported', () => {
    const stalls = detectStalls(series([{ secs: 2, speed: 1.5 }, { secs: 6, speed: 0 }]));
    expect(stalls).toHaveLength(1);
  });

  it('thresholds are options', () => {
    const s = series([{ secs: 2, speed: 1.5 }, { secs: 3, speed: 0 }, { secs: 2, speed: 1.5 }]);
    expect(detectStalls(s)).toEqual([]);
    expect(detectStalls(s, { window: 2000 })).toHaveLength(1);
  });
});

describe('polylineLength', () => {
  it('sums segment lengths', () => {
    expect(polylineLength([{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 0 }])).toBe(9);
    expect(polylineLength([])).toBe(0);
  });
});
