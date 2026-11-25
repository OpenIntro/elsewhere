#!/usr/bin/env node
/**
 * Audio verification (audio worker). Needs a running Vite dev client (+ server for --live).
 *
 *   node client/src/audio/verify/audio-verify.mjs offline [viteUrl] [filter]
 *       Renders every scene in src/audio/offline.ts with OfflineAudioContext in
 *       headless Chromium (same graph code as the game) and prints a levels table.
 *   node client/src/audio/verify/audio-verify.mjs live [viteUrl] [seconds]
 *       Real app: click → context "running"; walk → footstep events; change the
 *       three volume settings → bus gains follow; node count over simulated activity.
 *
 * Playwright is installed globally (not a dependency): loaded via createRequire like scripts/smoke-two-clients.mjs.
 */
import { createRequire } from 'node:module';

async function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    return import('playwright');
  }
}
const { chromium } = await loadPlaywright();
const [mode = 'offline', url = 'http://localhost:5186/?autojoin=1', arg] = process.argv.slice(2);
const log = (...a) => console.log('[audio-verify]', ...a);

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=user-gesture-required'],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url);

  if (mode === 'offline') {
    const res = await page.evaluate(async (filter) => {
      const m = await import('/src/audio/offline.ts');
      return m.runVerification(filter || undefined);
    }, arg ?? '');
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('scene', 34), pad('sec', 5), pad('peak', 7), pad('rms', 7), pad('actRms', 7), pad('act%', 5), pad('centroid', 9), 'bands % (<150 | 150-400 | 400-1k | 1k-2.5k | 2.5k-6k | >6k)  [peaks Hz]  nodesLeft');
    for (const r of res)
      console.log(
        pad(r.name, 34),
        pad(r.seconds, 5),
        pad(r.peakDb, 7),
        pad(r.rmsDb, 7),
        pad(r.activeRmsDb, 7),
        pad(Math.round(r.activeFraction * 100), 5),
        pad(r.centroidHz, 9),
        Object.values(r.bands).join(' | '),
        r.peaks ? ` [${r.peaks.join(', ')}]` : '',
        ` ${r.nodesAfter}`,
      );
    if (process.env.AUDIO_VERIFY_JSON) console.log(JSON.stringify(res));
  } else {
    const seconds = Number(arg ?? 120);
    const dbg = () => page.evaluate(() => window.__ELSEWHERE_AUDIO__?.debug());
    await page.waitForFunction(() => window.__ELSEWHERE__?.snapshot().connection === 'connected', null, { timeout: 30000 });
    log('before gesture:', JSON.stringify((await dbg())?.state));
    await page.mouse.click(480, 320);
    await page.waitForFunction(() => window.__ELSEWHERE_AUDIO__?.debug().state === 'running', null, { timeout: 10000 });
    const d0 = await dbg();
    log('after click: state =', d0.state, 'busGains =', JSON.stringify(d0.busGains), 'nodes =', d0.stats.totalNodes);

    // Walk: hold movement keys.
    const before = (await dbg()).sfxCounts.footstep ?? 0;
    for (const k of ['KeyD', 'KeyS', 'KeyA', 'KeyW']) {
      await page.keyboard.down(k);
      await page.waitForTimeout(900);
      await page.keyboard.up(k);
    }
    const after = (await dbg()).sfxCounts.footstep ?? 0;
    const local = await page.evaluate(() => window.__ELSEWHERE__?.snapshot().local);
    log(`walking 3.6 s → ${after - before} footstep events (local at ${local.x.toFixed(1)}, ${local.z.toFixed(1)})`);

    // Volumes → bus gains (via the persisted settings store: use the zustand store from the module graph).
    const vol = await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/state/settingsStore.ts');
      const s = useSettingsStore.getState();
      const out = [];
      const read = () => new Promise((r) => setTimeout(() => r(window.__ELSEWHERE_AUDIO__.debug().busGains), 700));
      s.setVolume('music', 0.2);
      s.setVolume('ambience', 0.9);
      s.setVolume('sfx', 0.35);
      s.setMasterVolume(0.6);
      out.push({ set: { music: 0.2, ambience: 0.9, sfx: 0.35, master: 0.6 }, bus: await read(), gainFor: { music: window.__ELSEWHERE_AUDIO__.gainFor('music'), ambience: window.__ELSEWHERE_AUDIO__.gainFor('ambience'), sfx: window.__ELSEWHERE_AUDIO__.gainFor('sfx') } });
      s.setMuted(true);
      out.push({ set: { muted: true }, bus: await read() });
      s.setMuted(false);
      s.setVolume('music', 0.5);
      s.setVolume('ambience', 0.6);
      s.setVolume('sfx', 0.8);
      s.setMasterVolume(0.8);
      out.push({ set: 'defaults', bus: await read() });
      return out;
    });
    for (const v of vol) log('volume', JSON.stringify(v.set), '→ bus', JSON.stringify(v.bus), v.gainFor ? `gainFor ${JSON.stringify(v.gainFor)}` : '');

    // Simulated activity: walk in patterns + a storm of synthetic events through the public API.
    const samples = [];
    const t0 = Date.now();
    const keys = ['KeyD', 'KeyS', 'KeyA', 'KeyW'];
    let i = 0;
    while (Date.now() - t0 < seconds * 1000) {
      const k = keys[i++ % 4];
      await page.keyboard.down(k);
      await page.evaluate(async () => {
        const { audio } = await import('/src/audio/AudioManager.ts');
        const names = ['bell', 'door_open', 'door_close', 'light_toggle', 'pickup', 'drop', 'sit', 'splash', 'chat_message', 'reaction', 'ui_click', 'ui_open', 'ui_close', 'rune', 'discovery', 'chime', 'bell_chorus', 'fountain_stage', 'world_shimmer', 'portal_wake'];
        for (let n = 0; n < 12; n++) audio.playSfx(names[Math.floor(Math.random() * names.length)], { x: Math.random() * 30 - 15, y: 0, z: Math.random() * 30 - 15 });
      });
      await page.waitForTimeout(1000);
      await page.keyboard.up(k);
      const d = await dbg();
      samples.push({ t: Math.round((Date.now() - t0) / 1000), nodes: d.stats.totalNodes, voices: d.stats.activeVoices, beds: d.stats.beds, created: d.stats.voicesCreated, rejected: d.stats.voicesRejected, stolen: d.stats.voicesStolen });
    }
    const nodes = samples.map((s) => s.nodes);
    log(`activity ${seconds}s: nodes min ${Math.min(...nodes)} max ${Math.max(...nodes)} last ${nodes.at(-1)}; voices max ${Math.max(...samples.map((s) => s.voices))}; voices created ${samples.at(-1).created}, rejected ${samples.at(-1).rejected}, stolen ${samples.at(-1).stolen}`);
    log('samples every ~10:', JSON.stringify(samples.filter((_, k) => k % 10 === 0)));
    await page.waitForTimeout(10000);
    const idle = await dbg();
    log(`10 s after activity: nodes ${idle.stats.totalNodes}, voices ${idle.stats.activeVoices}, beds ${idle.stats.beds}, music ${JSON.stringify(idle.music)}, ambienceKey ${idle.ambienceKey}`);
    log('sfx counts:', JSON.stringify(idle.sfxCounts));
    // Hidden tab → suspended.
    const vis = await page.evaluate(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 600));
      const hidden = window.__ELSEWHERE_AUDIO__.debug().state;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 600));
      return { hidden, visible: window.__ELSEWHERE_AUDIO__.debug().state };
    });
    log('visibility:', JSON.stringify(vis));
  }
} finally {
  await browser.close();
  log(errors.length ? `ERRORS (${errors.length}):\n  ${errors.join('\n  ')}` : 'no console errors');
}
