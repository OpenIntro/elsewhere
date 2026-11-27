import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as H from '../lib/browser.mjs';
import { builderClient } from '../lib/seed.mjs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const BASE = 'http://localhost:2634';
const DATA = mkdtempSync(path.join(tmpdir(), 'roofrepro-'));
const srv = spawn(process.execPath, ['server/dist/index.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: '2634', DATA_DIR: DATA, SESSION_SECRET: 'r'.repeat(48), BUILD_RANGE: '400', BUILD_RATE_CAPACITY: '1000', BUILD_RATE_PER_SECOND: '1000' }, stdio: 'ignore' });
const log = (...a) => console.log(...a);
function rect(x0, z0, x1, z1, level = 0, kindAt = () => 'wall', variant = 'cream') {
  const out = []; let i;
  i = 0; for (let x = x0 + 1; x < x1; x += 2) { const k = kindAt('n', i++); if (k) out.push({ kind: k, x, z: z0, rot: 0, level, variant }); }
  i = 0; for (let x = x0 + 1; x < x1; x += 2) { const k = kindAt('s', i++); if (k) out.push({ kind: k, x, z: z1, rot: 0, level, variant }); }
  i = 0; for (let z = z0 + 1; z < z1; z += 2) { const k = kindAt('w', i++); if (k) out.push({ kind: k, x: x0, z, rot: 1, level, variant }); }
  i = 0; for (let z = z0 + 1; z < z1; z += 2) { const k = kindAt('e', i++); if (k) out.push({ kind: k, x: x1, z, rot: 1, level, variant }); }
  return out;
}
const HOUSES = [
  { name: 'H1 one storey 4x4, door south', box: [-20, -1, -16, 3], plan: rect(-20, -1, -16, 3, 0, (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall')) },
  { name: 'H2 two storeys 4x4', box: [-24, 18, -20, 22], plan: [...rect(-24, 18, -20, 22, 0, (s, i) => (s === 's' && i === 1 ? 'doorway' : 'wall')), ...rect(-24, 18, -20, 22, 1, () => 'wall_window')] },
  { name: 'H3 4x4 + garden wall at a corner', box: [-16, 18, -12, 22], plan: [...rect(-16, 18, -12, 22, 0, (s, i) => (s === 's' && i === 0 ? 'doorway' : 'wall')), { kind: 'wall', x: -12, z: 23, rot: 1, level: 0, variant: 'cream' }] },
  { name: 'H4 3x4 (odd side → 1 m gap)', box: [8, 14, 11, 18], plan: rect(8, 14, 11, 18) },
  { name: 'H5 4x4, one segment missing', box: [24, -28, 28, -24], plan: rect(24, -28, 28, -24, 0, (s, i) => (s === 'n' && i === 1 ? null : 'wall')) },
  { name: 'H6 porch: south side open', box: [-46, -8, -42, -4], plan: rect(-46, -8, -42, -4, 0, (s) => (s === 's' ? null : 'wall')) },
];
try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await H.sleep(500); }
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(`try { localStorage.setItem('elsewhere.settings.v1', JSON.stringify({ state: { graphics: 'low' }, version: 1 })); } catch {}`);
  const a = await ctx.newPage();
  const errors = [];
  a.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await a.goto(`${BASE}/?autojoin=1`);
  await H.waitSnap(a, (s) => s.local?.ready && s.navReady && s.build?.synced, 'ready');
  const token = await a.evaluate(() => localStorage.getItem('elsewhere.session.v1'));
  const b = await builderClient(BASE, { token });
  let placedN = 0;
  for (const h of HOUSES) for (const p of h.plan) { let r = await b.place(p); if (!r.ok && r.natureId) { await b.clear(r.natureId); r = await b.place(p); } if (!r.ok) log('  stage refused', h.name, p.kind, p.x, p.z, p.level, r.reason); else placedN++; }
  await b.leave();
  await H.waitSnap(a, (s) => s.build.count >= placedN, 'pieces synced', 30000);
  const sample = async (label) => { const sb = (await H.snap(a)).build; const g = sb.ghost; return `${label}: ${g ? `${g.ok ? 'GREEN' : 'red'} L${g.level} ${g.params ?? ''} ${g.message ?? ''} probes ${JSON.stringify(sb.roof.probes)} me ${JSON.stringify((await H.snap(a)).local).slice(0,60)}` : 'no ghost'}`; };
  for (const h of HOUSES.filter((h) => !process.env.ONLY || process.env.ONLY.split(',').some((k) => h.name.startsWith(k)))) {
    const [x0, z0, x1, z1] = h.box;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    log(`\n== ${h.name}`);
    await H.closeBuild(a).catch(() => {});
    await H.hopToward(a, { x: cx + 1, z: z1 + 2.5 }, 1.2, 200000).catch((e) => log('  hop failed', e.message.slice(0, 120)));
    await H.openBuild(a);
    await H.choosePiece(a, 'house_roof', { category: 'roof' });
    const pts = [];
    for (const p of h.plan.filter((q) => q.level === Math.max(...h.plan.map((w) => w.level)) || q.level === 0)) for (const y of [1.0, 2.2]) pts.push([`${p.kind}(${p.x},${p.z})L${p.level} y${y}`, p.x, p.z, p.level * 2.6 + y]);
    pts.push(['inside ground', cx, cz, 0.2]);
    pts.push(['over the house at roof height', cx, cz, 2.8 + 2.6 * Math.max(...h.plan.map((w) => w.level))]);
    let greens = 0, reds = 0, clickPt = null;
    for (const [label, x, z, y] of pts) {
      let pt;
      try { pt = await H.screenOf(a, x, z, y); } catch { log(`  ${label}: off screen`); continue; }
      await a.mouse.move(pt.x, pt.y, { steps: 2 });
      await H.sleep(600);
      const s = await sample(label);
      if (/ GREEN /.test(s)) { greens++; clickPt ??= pt; } else { reds++; log('  ' + s + ` screen ${pt.x.toFixed(0)},${pt.y.toFixed(0)}`); if (reds === 1) await a.screenshot({ path: `/tmp/claude-0/-home-user-elsewhere/9a47690e-d7d3-56a8-a9ea-4d95f569ebf5/scratchpad/roofs/red-${h.name.slice(0,2)}.jpg`, type: 'jpeg' }); }
    }
    log(`  ${greens} green / ${reds} red aim points`);
    const clicked = !!clickPt;
    if (clickPt) {
      await a.mouse.move(clickPt.x, clickPt.y, { steps: 2 });
      await H.sleep(500);
      const s0 = (await H.snap(a)).build;
      await a.mouse.click(clickPt.x, clickPt.y);
      const s1 = await H.waitSnap(a, (q) => q.build.stats.results.ok > s0.stats.results.ok || q.build.stats.results.refused > s0.stats.results.refused || (q.build.refusal && q.build.refusal.at > Date.now() - 3000), 'answer', 15000).catch(() => null);
      log(`  CLICK → ${s1 ? (s1.build.stats.results.ok > s0.stats.results.ok ? 'PLACED ' + s1.build.pieces.filter((p) => p.kind === 'house_roof').map((p) => p.params).at(-1) : `REFUSED "${s1.build.refusal?.text}"`) : 'NOTHING HAPPENED'}`);
    }
    if (!clicked) log('  (never green)');
  }
  log('\nconsole errors:', errors.length, errors.slice(0, 3));
  await browser.close();
} finally { srv.kill(); }
