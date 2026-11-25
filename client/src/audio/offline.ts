/**
 * Offline verification harness: renders representative scenes with an
 * OfflineAudioContext through the SAME graph/music/ambience/sfx code the game
 * uses, and measures them (peak, RMS, spectrum). Not imported by the app; used
 * by scripts/audio-verify.mjs (Playwright loads it through the Vite dev server).
 */
import { LOCATIONS, mulberry32, type AmbienceKey, type Vec2 } from '@elsewhere/shared';
import { AMBIENCE_LAYERS, ambienceMix, type AmbienceLayer } from './ambienceMix.js';
import { AmbiencePlayer } from './ambiencePlayer.js';
import { AudioGraph, type BusLevels } from './graph.js';
import type { Mood } from './musicPlan.js';
import { MusicPlayer } from './musicPlayer.js';
import { SFX_NAMES, playSfxOn, type SfxName } from './sfx.js';
import { SURFACES, type Surface } from './surface.js';
import { setSynthRandom } from './synth.js';

/** Default settings-store volumes (master .8, music .5, ambience .6, sfx .8). */
export const DEFAULT_LEVELS: BusLevels = { master: 0.8, music: 0.5, ambience: 0.6, sfx: 0.8 };
const SR = 44100;

export type Scene =
  | { kind: 'music'; mood: Mood; seconds: number; seed?: number }
  | { kind: 'ambience_solo'; layer: AmbienceLayer; seconds: number; rateBoost?: number }
  | { kind: 'ambience_at'; location: string; hours: number; portalAwake?: boolean; seconds: number; offset?: Vec2 }
  | { kind: 'sfx'; name: SfxName; surface?: Surface; seconds: number; repeat?: number };

export interface Analysis {
  name: string;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  /** RMS over the loudest 10% of 50 ms windows (perceived "when it sounds" level). */
  activeRmsDb: number;
  /** Fraction of 50 ms windows above -60 dBFS. */
  activeFraction: number;
  centroidHz: number;
  /** Energy share per band, percent. */
  bands: Record<string, number>;
  /** Strongest spectral peaks (Hz), for tonal sounds. */
  peaks?: number[];
  nodesAfter?: number;
}

export const BANDS: [string, number, number][] = [
  ['<150', 0, 150],
  ['150-400', 150, 400],
  ['400-1k', 400, 1000],
  ['1k-2.5k', 1000, 2500],
  ['2.5k-6k', 2500, 6000],
  ['>6k', 6000, 22050],
];

const at = (id: string, dx = 0, dz = 0): Vec2 => {
  const l = LOCATIONS.find((x) => x.id === id)!;
  return { x: l.center.x + dx, z: l.center.z + dz };
};
/** Listener spot for each soloed ambience layer. */
const SOLO_SPOT: Record<AmbienceLayer, Vec2> = {
  wind: at('town_hall'),
  birds: at('woods'),
  gulls: at('waterfront'),
  insects: at('residential'),
  owl: at('woods'),
  shore: at('waterfront'),
  fountain: at('town_square', 4, 0),
  creek: { x: -30, z: -44 },
  cafe: at('cafe'),
  forest: at('woods'),
  workshop: at('workshop'),
  mystery: at('the_unknown'),
  chimes: at('the_unknown'),
};

export async function renderScene(scene: Scene, levels: BusLevels = DEFAULT_LEVELS): Promise<{ buffer: AudioBuffer; graph: AudioGraph }> {
  setSynthRandom(mulberry32(1234));
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * scene.seconds), SR);
  const g = new AudioGraph(ctx, levels);
  g.listener = { x: 0, z: 0 };
  switch (scene.kind) {
    case 'music': {
      const m = new MusicPlayer(g, scene.seed ?? 2024, { startWithRest: false });
      m.setMood(scene.mood);
      m.start(0);
      m.schedule(scene.seconds);
      break;
    }
    case 'ambience_solo': {
      const a = new AmbiencePlayer(g);
      a.idleTeardown = 0;
      a.solo = scene.layer;
      if (scene.rateBoost) a.rateBoost = scene.rateBoost;
      a.start(0);
      // Stand where the soloed layer naturally lives (point sources need to be in range).
      const p = SOLO_SPOT[scene.layer];
      g.listener = p;
      a.update(ambienceMix({ ...p, hours: 12, key: null, portalAwake: true }), 0.05);
      a.tick(scene.seconds);
      break;
    }
    case 'ambience_at': {
      const l = LOCATIONS.find((x) => x.id === scene.location)!;
      const p = { x: l.center.x + (scene.offset?.x ?? 0), z: l.center.z + (scene.offset?.z ?? 0) };
      g.listener = p;
      const a = new AmbiencePlayer(g);
      a.idleTeardown = 0;
      a.start(0);
      a.update(ambienceMix({ ...p, hours: scene.hours, key: l.ambience as AmbienceKey, portalAwake: !!scene.portalAwake }), 0.05);
      a.tick(scene.seconds);
      break;
    }
    case 'sfx': {
      const n = scene.repeat ?? 1;
      for (let i = 0; i < n; i++) playSfxOn(g, scene.name, undefined, { at: 0.05 + i * 0.5, ...(scene.surface ? { surface: scene.surface } : {}) });
      break;
    }
  }
  const buffer = await ctx.startRendering();
  setSynthRandom(Math.random);
  return { buffer, graph: g };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x: number, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Averaged power spectrum (Welch, Hann, 4096) of the mono mix. */
function spectrum(mono: Float32Array, size = 4096, from = 0, to = mono.length): Float64Array {
  const acc = new Float64Array(size / 2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let frames = 0;
  for (let start = from; start + size <= to; start += size / 2) {
    let energy = 0;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      const x = mono[start + i]!;
      energy += x * x;
      re[i] = x * w;
      im[i] = 0;
    }
    if (energy < 1e-9) continue;
    fft(re, im);
    for (let k = 0; k < size / 2; k++) acc[k] = acc[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  if (frames) for (let k = 0; k < acc.length; k++) acc[k] = acc[k]! / frames;
  return acc;
}

export function analyze(name: string, buffer: AudioBuffer, opts: { peaks?: boolean; peakWindow?: [number, number] } = {}): Analysis {
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const mono = new Float32Array(len);
  let peak = 0;
  let sum = 0;
  for (const c of chans)
    for (let i = 0; i < len; i++) {
      const v = c[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      mono[i] = mono[i]! + v / chans.length;
    }
  const rms = Math.sqrt(sum / (len * chans.length));
  const win = Math.floor(sr * 0.05);
  const wins: number[] = [];
  for (let s = 0; s + win <= len; s += win) {
    let e = 0;
    for (const c of chans) for (let i = s; i < s + win; i++) e += c[i]! * c[i]!;
    wins.push(Math.sqrt(e / (win * chans.length)));
  }
  const sorted = [...wins].sort((a, b) => b - a);
  const top = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.1)));
  const activeRms = Math.sqrt(top.reduce((s, x) => s + x * x, 0) / top.length);
  const activeFraction = wins.filter((w) => db(w) > -60).length / Math.max(1, wins.length);

  const size = 4096;
  const spec = spectrum(mono, size);
  const binHz = sr / size;
  const bands: Record<string, number> = {};
  let total = 0;
  let centroidNum = 0;
  for (let k = 1; k < spec.length; k++) {
    total += spec[k]!;
    centroidNum += spec[k]! * k * binHz;
  }
  for (const [label, lo, hi] of BANDS) {
    let e = 0;
    for (let k = Math.max(1, Math.floor(lo / binHz)); k < Math.min(spec.length, Math.floor(hi / binHz)); k++) e += spec[k]!;
    bands[label] = round(total > 0 ? (100 * e) / total : 0, 1);
  }
  const res: Analysis = {
    name,
    seconds: round(len / sr, 2),
    peakDb: round(db(peak)),
    rmsDb: round(db(rms)),
    activeRmsDb: round(db(activeRms)),
    activeFraction: round(activeFraction, 2),
    centroidHz: Math.round(total > 0 ? centroidNum / total : 0),
    bands,
  };
  if (opts.peaks) {
    // High-resolution spectrum for partial detection.
    const big = 32768;
    const [a, b] = opts.peakWindow ?? [0.05, 1.6];
    const sp = spectrum(mono, big, Math.floor(a * sr), Math.min(len, Math.floor(b * sr) + big));
    const hz = sr / big;
    const max = Math.max(...sp);
    const cands: { f: number; p: number }[] = [];
    for (let k = 3; k < sp.length - 3; k++) {
      const p = sp[k]!;
      if (p < max * 1e-4) continue; // within 40 dB of the strongest
      if (p >= sp[k - 1]! && p >= sp[k + 1]! && p >= sp[k - 2]! && p >= sp[k + 2]! && p >= sp[k - 3]! && p >= sp[k + 3]!) cands.push({ f: k * hz, p });
    }
    cands.sort((x, y) => y.p - x.p);
    const picked: number[] = [];
    for (const c of cands) {
      if (picked.every((f) => Math.abs(f - c.f) > Math.max(8, f * 0.03))) picked.push(c.f);
      if (picked.length >= 10) break;
    }
    res.peaks = picked.sort((x, y) => x - y).map((f) => Math.round(f));
  }
  return res;
}

// ---------------------------------------------------------------------------
// The verification suite
// ---------------------------------------------------------------------------

export function verificationScenes(): { name: string; scene: Scene; peaks?: boolean; peakWindow?: [number, number] }[] {
  const out: { name: string; scene: Scene; peaks?: boolean; peakWindow?: [number, number] }[] = [];
  for (const mood of ['day', 'night', 'evening', 'mystery'] as const) out.push({ name: `music_${mood}`, scene: { kind: 'music', mood, seconds: 30 } });
  for (const layer of AMBIENCE_LAYERS) {
    const rare = ['owl', 'gulls', 'workshop', 'chimes', 'forest'].includes(layer);
    out.push({ name: `amb_${layer}${rare ? ' (rate x8)' : ''}`, scene: { kind: 'ambience_solo', layer, seconds: 20, ...(rare ? { rateBoost: 8 } : {}) } });
  }
  const places: [string, number, boolean?, Vec2?][] = [
    ['town_square', 10],
    ['town_square', 1],
    ['cafe', 11],
    ['woods', 7],
    ['woods', 0],
    ['waterfront', 14],
    ['waterfront', 23],
    ['residential', 22],
    ['the_unknown', 2, false],
    ['the_unknown', 2, true],
  ];
  for (const [loc, hours, awake, offset] of places)
    out.push({ name: `scene_${loc}_${hours}h${awake ? '_awake' : ''}`, scene: { kind: 'ambience_at', location: loc, hours, seconds: 20, ...(awake ? { portalAwake: true } : {}), ...(offset ? { offset } : {}) } });
  for (const surface of SURFACES) out.push({ name: `sfx_footstep_${surface}`, scene: { kind: 'sfx', name: 'footstep', surface, seconds: 3, repeat: 5 } });
  for (const name of SFX_NAMES) {
    if (name === 'footstep') continue;
    const long = ['bell', 'bell_chorus', 'portal_wake', 'portal_sleep', 'fountain_stage', 'chime'].includes(name);
    out.push({ name: `sfx_${name}`, scene: { kind: 'sfx', name, seconds: long ? (name === 'bell_chorus' ? 12 : 9) : 3 }, ...(name === 'bell' ? { peaks: true, peakWindow: [0.06, 1.5] as [number, number] } : {}) });
  }
  return out;
}

export async function runVerification(filter?: string): Promise<Analysis[]> {
  const results: Analysis[] = [];
  for (const s of verificationScenes()) {
    if (filter && !s.name.includes(filter)) continue;
    const { buffer, graph } = await renderScene(s.scene);
    await new Promise((r) => setTimeout(r, 30)); // let `ended` events run → voices release their nodes
    const a = analyze(s.name, buffer, { ...(s.peaks ? { peaks: true } : {}), ...(s.peakWindow ? { peakWindow: s.peakWindow } : {}) });
    a.nodesAfter = graph.stats.voiceNodes;
    results.push(a);
  }
  return results;
}
