/**
 * Machine-readable results for the browser suites, the e2e:all summary, and the
 * door-walk stall detector. Pure functions apart from `resultFile` (which writes
 * a file when the suite exits); unit tested in client/test/e2eHarness.test.ts.
 *
 * Result file (written when $E2E_RESULT names a path):
 *   { suite, ok, ms, exitCode, checks: [{ name, ok, ms, detail }], consoleErrors }
 * `ms` of a check is the time since the previous recorded check (or since the
 * suite started): the suites record checks one after another, so that is the
 * check's own time plus any setup in front of it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Collects checks in order; `ms` = time since the previous check (or `t0`). */
export function createRecorder(suite, { now = Date.now, t0 = now() } = {}) {
  const checks = [];
  let last = t0;
  return {
    suite,
    checks,
    add(name, ok, detail = '') {
      const t = now();
      checks.push({ name, ok: !!ok, ms: t - last, detail: String(detail ?? '') });
      last = t;
    },
    /** The result object for an exit code and the suite's console / page error list. */
    result(exitCode, consoleErrors = []) {
      return suiteResult({ suite, checks, ms: now() - t0, exitCode, consoleErrors });
    },
  };
}

/** A suite passed only if it exited 0, recorded at least one check and every check passed. */
export function suiteResult({ suite, checks, ms, exitCode, consoleErrors = [] }) {
  const ok = exitCode === 0 && checks.length > 0 && checks.every((c) => c.ok);
  return { suite, ok, ms, exitCode, checks: checks.map((c) => ({ ...c })), consoleErrors: [...consoleErrors] };
}

/**
 * Adapter used by every suite: `const rec = resultFile('build', () => pageErrors)`, then
 * `rec.add(name, ok, detail)` inside the suite's own record(). Writes the file named by
 * $E2E_RESULT synchronously on process exit (whatever the exit path); does nothing and
 * prints nothing when the variable is unset.
 */
export function resultFile(suite, consoleErrors = () => [], file = process.env.E2E_RESULT) {
  const rec = createRecorder(suite);
  if (file) {
    process.on('exit', (code) => {
      try {
        mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        writeFileSync(file, `${JSON.stringify(rec.result(process.exitCode ?? code, consoleErrors() ?? []), null, 2)}\n`);
      } catch (err) {
        process.stderr.write(`[${suite}] could not write ${file}: ${err?.message ?? err}\n`);
      }
    });
  }
  return rec;
}

// ---------------------------------------------------------------------------
// e2e:all summary
// ---------------------------------------------------------------------------

/**
 * One summary row per suite run. `result` is the suite's result file (or null if
 * it wrote none: crashed before exit, or killed); `exitCode`/`ms` come from the runner.
 */
export function summaryRow({ suite, run = 1, exitCode, ms, result }) {
  const checks = result?.checks ?? [];
  const passed = checks.filter((c) => c.ok).length;
  const ok = exitCode === 0 && !!result && result.ok === true;
  return {
    suite,
    run,
    ok,
    exitCode,
    passed,
    total: checks.length,
    ms,
    failed: checks.filter((c) => !c.ok).map((c) => c.name),
    note: result ? '' : 'no result file (suite crashed or was killed)',
  };
}

/** Merge the rows of one or more runs into the summary.json shape. */
export function mergeSummary(rows, { startedAt, finishedAt, argv = [] } = {}) {
  const runs = new Map();
  for (const r of rows) {
    if (!runs.has(r.run)) runs.set(r.run, []);
    runs.get(r.run).push(r);
  }
  const perRun = [...runs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([run, rs]) => ({ run, ok: rs.every((r) => r.ok), ms: rs.reduce((s, r) => s + (r.ms ?? 0), 0), suites: rs }));
  return {
    ok: rows.length > 0 && rows.every((r) => r.ok),
    startedAt,
    finishedAt,
    argv,
    totalMs: rows.reduce((s, r) => s + (r.ms ?? 0), 0),
    runs: perRun,
  };
}

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** Plain-text table: suite, checks passed/total, time, status. */
export function formatSummary(summary) {
  const lines = [];
  const multi = summary.runs.length > 1;
  const head = [...(multi ? ['run'] : []), 'suite', 'checks', 'time', 'result'];
  const body = [];
  for (const run of summary.runs) {
    for (const r of run.suites) body.push([...(multi ? [String(run.run)] : []), r.suite, `${r.passed}/${r.total}`, fmtMs(r.ms), r.ok ? 'PASS' : `FAIL${r.exitCode != null ? ` (exit ${r.exitCode})` : ''}`]);
    if (multi) body.push(['', `run ${run.run} total`, '', fmtMs(run.ms), run.ok ? 'PASS' : 'FAIL']);
  }
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (row) => row.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  lines.push(fmt(head), w.map((n) => '-'.repeat(n)).join('  '));
  for (const row of body) lines.push(fmt(row));
  lines.push('', `total wall-clock ${fmtMs(summary.totalMs)}; ${summary.ok ? 'all passed' : 'FAILED'}`);
  for (const run of summary.runs)
    for (const r of run.suites) {
      if (r.failed.length) lines.push(`  ${multi ? `run ${run.run} ` : ''}${r.suite} failed: ${r.failed.join(' | ')}`);
      if (r.note) lines.push(`  ${multi ? `run ${run.run} ` : ''}${r.suite}: ${r.note}`);
    }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Door walk: stall detector
// ---------------------------------------------------------------------------

/**
 * Stalls in a recorded position series: stretches where a click/tap-to-move path
 * was active (`path` truthy) but the player moved less than `minProgress` metres
 * (net, from the stretch's first sample) for at least `window` ms.
 *
 * @param {{ t: number, x: number, z: number, path: boolean }[]} samples  time-ordered
 * @returns {{ from: number, to: number, ms: number, at: { x: number, z: number }, moved: number, i0: number, i1: number }[]}
 */
export function detectStalls(samples, { minProgress = 0.2, window = 5000 } = {}) {
  const out = [];
  let i0 = -1;
  const close = (i1) => {
    if (i0 < 0 || i1 <= i0) return;
    const a = samples[i0];
    const b = samples[i1];
    if (b.t - a.t >= window) {
      let moved = 0;
      for (let k = i0; k <= i1; k++) moved = Math.max(moved, Math.hypot(samples[k].x - a.x, samples[k].z - a.z));
      out.push({ from: a.t, to: b.t, ms: b.t - a.t, at: { x: a.x, z: a.z }, moved, i0, i1 });
    }
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s.path) {
      close(i - 1);
      i0 = -1;
      continue;
    }
    if (i0 < 0) {
      i0 = i;
      continue;
    }
    const a = samples[i0];
    if (Math.hypot(s.x - a.x, s.z - a.z) >= minProgress) {
      // Progress made: the still stretch (if any) ended at the previous sample.
      close(i - 1);
      i0 = i;
    }
  }
  close(samples.length - 1);
  return out;
}

/** Total distance along a polyline of {x, z} points. */
export function polylineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return d;
}
