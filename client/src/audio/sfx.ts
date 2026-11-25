/**
 * Procedural sound effects. TEMPORARY placeholder-quality assets: every sound
 * is synthesised (oscillators + filtered noise), tuned blind against offline
 * level/spectrum measurements, not by ear. Replace with recorded/designed
 * assets later without changing the SfxName API.
 */
import type { Vec2 } from '@elsewhere/shared';
import type { AudioGraph, VoiceOptions } from './graph.js';
import type { Surface } from './surface.js';
import { chance, filter, noise, partial, pick, rand } from './synth.js';

export const SFX_NAMES = [
  'footstep',
  'ui_click',
  'ui_open',
  'ui_close',
  'chat_message',
  'mention',
  'door_open',
  'door_close',
  'bell',
  'bell_chorus',
  'light_toggle',
  'pickup',
  'drop',
  'sit',
  'splash',
  'fountain_stage',
  'world_shimmer',
  'discovery',
  'rune',
  'rune_fade',
  'portal_wake',
  'portal_sleep',
  'reaction',
  'notification',
  'chime',
  // Building activities (client/src/activities/sound.ts)
  'piano',
  'cup',
  'saw',
  'hammer',
  'kiln',
  'hearth',
  'kettle',
  'kettle_whistle',
  'pin',
  'page',
  'ballot',
  'net',
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export interface SfxOptions {
  /** Footsteps: surface under the foot (default grass). */
  surface?: Surface;
  /** Extra linear gain (e.g. 0.4 for remote players' footsteps). */
  gain?: number;
  /** Voice category override (e.g. 'remote_step'). */
  category?: string;
  /** Start time in ctx seconds (default now). */
  at?: number;
  /** Piano: note index (0 = C4, semitones). */
  note?: number;
  /** Extra low-pass muffling 0..1 (a wall between the sound and the listener). */
  muffle?: number;
}

type Recipe = (g: AudioGraph, pos: Vec2 | undefined, o: SfxOptions) => void;

function voice(g: AudioGraph, pos: Vec2 | undefined, o: SfxOptions, base: Omit<VoiceOptions, 'channel'> & { channel?: VoiceOptions['channel'] }) {
  return g.voice({
    channel: 'sfx',
    ...base,
    ...(o.category ? { category: o.category } : {}),
    ...(o.at !== undefined ? { at: o.at } : {}),
    ...(pos ? { position: pos } : {}),
    gain: (base.gain ?? 1) * (o.gain ?? 1),
  });
}

// ---------------------------------------------------------------------------
// Footsteps — distinct per surface.
// ---------------------------------------------------------------------------

function footstep(g: AudioGraph, pos: Vec2 | undefined, o: SfxOptions): void {
  const surface = o.surface ?? 'grass';
  const v = voice(g, pos, o, { category: 'footstep', priority: 1, duration: 0.25, gain: rand(0.85, 1.1), wet: 0.06, spatial: { ref: 3, max: 18 } });
  if (!v) return;
  const t = v.t0;
  const w = g.noise('white');
  const p = g.noise('pink');
  switch (surface) {
    case 'grass':
      // Soft swish: band-limited pink noise, no hard transient.
      noise(v, p, { t, attack: 0.012, decay: 0.11, peak: 0.36, filter: 'bandpass', freq: rand(1900, 2600), q: 0.7, filter2: 'lowpass', freq2: 5200 });
      noise(v, w, { t: t + 0.02, attack: 0.01, decay: 0.07, peak: 0.12, filter: 'highpass', freq: 4500 });
      break;
    case 'leaves':
      // Crunchy: a cluster of tiny bright crackles over a soft swish.
      noise(v, p, { t, attack: 0.01, decay: 0.12, peak: 0.25, filter: 'bandpass', freq: 1800, q: 0.6 });
      for (let i = 0; i < 5; i++) noise(v, w, { t: t + rand(0, 0.09), decay: rand(0.008, 0.02), peak: rand(0.18, 0.32), filter: 'bandpass', freq: rand(2500, 6000), q: 1.4 });
      break;
    case 'stone':
      // Hard heel click + small body.
      noise(v, w, { t, attack: 0.001, decay: 0.03, peak: 0.24, filter: 'bandpass', freq: rand(2600, 3400), q: 1.2 });
      noise(v, p, { t, attack: 0.002, decay: 0.05, peak: 0.06, filter: 'lowpass', freq: 900 });
      partial(v, { freq: rand(150, 190), t, attack: 0.001, decay: 0.04, peak: 0.04 });
      break;
    case 'gravel':
      for (let i = 0; i < 7; i++) noise(v, w, { t: t + rand(0, 0.08), decay: rand(0.01, 0.03), peak: rand(0.15, 0.3), filter: 'bandpass', freq: rand(1800, 4200), q: 1.8 });
      noise(v, p, { t, attack: 0.006, decay: 0.08, peak: 0.18, filter: 'lowpass', freq: 1400 });
      break;
    case 'dirt':
      // Dull thud.
      noise(v, p, { t, attack: 0.004, decay: 0.08, peak: 0.24, filter: 'lowpass', freq: rand(500, 700), q: 0.8 });
      partial(v, { freq: rand(80, 100), t, attack: 0.002, decay: 0.07, peak: 0.08 });
      noise(v, w, { t: t + 0.01, decay: 0.03, peak: 0.05, filter: 'highpass', freq: 3000 });
      break;
    case 'sand':
      // Soft, longer, muffled shhk with no transient.
      noise(v, p, { t, attack: 0.03, decay: 0.14, peak: 0.36, filter: 'bandpass', freq: rand(900, 1300), q: 0.6, filter2: 'lowpass', freq2: 2600 });
      break;
    case 'wood': {
      // Hollow knock: resonant mid body + low board resonance.
      const body = filter(v, 'bandpass', rand(420, 520), 6);
      noise(v, w, { t, attack: 0.001, decay: 0.03, peak: 0.6, dest: body });
      const body2 = filter(v, 'bandpass', rand(900, 1050), 5);
      noise(v, w, { t, attack: 0.001, decay: 0.02, peak: 0.25, dest: body2 });
      partial(v, { type: 'triangle', freq: rand(170, 210), toFreq: 140, glideTime: 0.12, t, attack: 0.001, decay: 0.13, peak: 0.11 });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Bells — inharmonic church-bell partials (hum, prime, minor-third tierce,
// quint, nominal, + upper inharmonics), long low decays, strike transient.
// ---------------------------------------------------------------------------

export const BELL_PARTIALS: readonly [ratio: number, amp: number, decay: number][] = [
  [0.5, 0.5, 7.5], // hum
  [1.0, 0.55, 5.5], // prime
  [1.183, 0.42, 4.2], // tierce (minor third — the bell "colour")
  [1.506, 0.24, 3.2], // quint
  [2.0, 0.36, 2.8], // nominal
  [2.514, 0.18, 1.9],
  [2.662, 0.14, 1.6],
  [3.011, 0.12, 1.3],
  [4.166, 0.08, 0.9],
  [5.433, 0.05, 0.6],
];

function strikeBell(g: AudioGraph, v: NonNullable<ReturnType<AudioGraph['voice']>>, prime: number, t: number, amp: number): void {
  for (const [ratio, a, decay] of BELL_PARTIALS) {
    partial(v, { freq: prime * ratio, t, attack: 0.002, decay, peak: a * amp });
    // Slight beating on the lowest two partials (real bells are not perfectly round).
    if (ratio <= 1) partial(v, { freq: prime * ratio + rand(0.6, 1.4), t, attack: 0.004, decay: decay * 0.9, peak: a * amp * 0.35 });
  }
  noise(v, g.noise('white'), { t, attack: 0.001, decay: 0.05, peak: 0.25 * amp, filter: 'bandpass', freq: prime * 6, q: 1.5 });
}

const bell: Recipe = (g, pos, o) => {
  const v = voice(g, pos, o, { category: 'bell', priority: 3, duration: 8, gain: 0.3, wet: 0.45, spatial: { ref: 14, max: 140, rolloff: 0.6 } });
  if (!v) return;
  strikeBell(g, v, rand(259, 263), v.t0, 1);
};

const bellChorus: Recipe = (g, pos, o) => {
  const v = voice(g, pos, o, { category: 'bell', priority: 3, duration: 10, gain: 0.22, wet: 0.55, spatial: { ref: 14, max: 160, rolloff: 0.6 } });
  if (!v) return;
  // A peal: three tuned bells (1, 5/4, 3/2) in a gentle cascade, twice.
  const primes = [261.6, 327, 392.4];
  let t = v.t0;
  for (let round = 0; round < 2; round++)
    for (const p of round === 0 ? primes : [...primes].reverse()) {
      strikeBell(g, v, p * rand(0.998, 1.002), t, round === 0 ? 0.8 : 0.6);
      t += rand(0.42, 0.55);
    }
};

// ---------------------------------------------------------------------------
// Everything else
// ---------------------------------------------------------------------------

type ActivitySfx = 'piano' | 'cup' | 'saw' | 'hammer' | 'kiln' | 'hearth' | 'kettle' | 'kettle_whistle' | 'pin' | 'page' | 'ballot' | 'net';
const RECIPES: Record<Exclude<SfxName, 'footstep' | ActivitySfx>, Recipe> = {
  ui_click: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'ui', priority: 0, duration: 0.06, gain: 0.08 });
    if (!v) return;
    partial(v, { freq: rand(1900, 2100), t: v.t0, attack: 0.002, decay: 0.035, peak: 1 });
  },
  ui_open: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'ui', priority: 0, duration: 0.3, gain: 0.09, wet: 0.2 });
    if (!v) return;
    partial(v, { freq: 1318.5, t: v.t0, attack: 0.004, decay: 0.16, peak: 0.8 });
    partial(v, { freq: 1975.5, t: v.t0 + 0.06, attack: 0.004, decay: 0.2, peak: 0.7 });
  },
  ui_close: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'ui', priority: 0, duration: 0.3, gain: 0.08, wet: 0.2 });
    if (!v) return;
    partial(v, { freq: 1975.5, t: v.t0, attack: 0.004, decay: 0.14, peak: 0.7 });
    partial(v, { freq: 1318.5, t: v.t0 + 0.06, attack: 0.004, decay: 0.18, peak: 0.7 });
  },
  chat_message: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'chat', priority: 0, duration: 0.2, gain: 0.07, wet: 0.15, spatial: { ref: 6, max: 30 } });
    if (!v) return;
    partial(v, { freq: 1240, toFreq: 1560, glideTime: 0.05, t: v.t0, attack: 0.004, decay: 0.09, peak: 1 });
  },
  mention: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'chat', priority: 2, duration: 0.5, gain: 0.14, wet: 0.3 });
    if (!v) return;
    partial(v, { freq: 1046.5, t: v.t0, attack: 0.003, decay: 0.3, peak: 0.8 });
    partial(v, { freq: 1568, t: v.t0 + 0.09, attack: 0.003, decay: 0.35, peak: 0.7 });
    partial(v, { freq: 1568 * 2.76, t: v.t0 + 0.09, attack: 0.002, decay: 0.12, peak: 0.12 });
  },
  door_open: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'door', priority: 2, duration: 0.9, gain: 0.32, wet: 0.2, spatial: { ref: 4, max: 28 } });
    if (!v) return;
    const t = v.t0;
    // Latch click, then a short creak (sawtooth through a narrow sweeping band).
    noise(v, g.noise('white'), { t, decay: 0.02, peak: 0.6, filter: 'bandpass', freq: 3200, q: 3 });
    const band = filter(v, 'bandpass', 700, 9);
    band.frequency.setValueAtTime(rand(600, 750), t + 0.05);
    band.frequency.linearRampToValueAtTime(rand(950, 1150), t + 0.55);
    const creak = partial(v, { type: 'sawtooth', freq: rand(95, 120), t: t + 0.05, attack: 0.08, hold: 0.3, decay: 0.25, peak: 0.9, dest: band });
    creak.frequency.setValueAtTime(rand(95, 120), t + 0.05);
    creak.frequency.linearRampToValueAtTime(rand(70, 85), t + 0.65);
    noise(v, g.noise('pink'), { t: t + 0.05, attack: 0.1, decay: 0.4, peak: 0.12, filter: 'lowpass', freq: 600 });
  },
  door_close: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'door', priority: 2, duration: 0.5, gain: 0.4, wet: 0.25, spatial: { ref: 4, max: 28 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('pink'), { t, attack: 0.003, decay: 0.16, peak: 0.9, filter: 'lowpass', freq: 380, q: 1 });
    partial(v, { freq: 72, t, attack: 0.002, decay: 0.16, peak: 0.45 });
    noise(v, g.noise('white'), { t: t + 0.03, decay: 0.025, peak: 0.35, filter: 'bandpass', freq: 2800, q: 3 });
  },
  bell,
  bell_chorus: bellChorus,
  light_toggle: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'light', priority: 1, duration: 0.3, gain: 0.25, wet: 0.1, spatial: { ref: 3, max: 20 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('white'), { t, decay: 0.012, peak: 0.7, filter: 'highpass', freq: 2500 });
    noise(v, g.noise('white'), { t: t + 0.03, decay: 0.01, peak: 0.45, filter: 'bandpass', freq: 4200, q: 2 });
    partial(v, { freq: 3520, t: t + 0.03, attack: 0.003, decay: 0.18, peak: 0.08 }); // filament tink
  },
  pickup: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'item', priority: 2, duration: 0.5, gain: 0.2, wet: 0.25, spatial: { ref: 3, max: 18 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('pink'), { t, attack: 0.01, decay: 0.08, peak: 0.25, filter: 'bandpass', freq: 1800, q: 0.8 });
    partial(v, { freq: 784, t: t + 0.03, attack: 0.003, decay: 0.22, peak: 0.55 });
    partial(v, { freq: 1174.7, t: t + 0.1, attack: 0.003, decay: 0.3, peak: 0.5 });
  },
  drop: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'item', priority: 1, duration: 0.4, gain: 0.3, wet: 0.15, spatial: { ref: 3, max: 18 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('pink'), { t, attack: 0.002, decay: 0.09, peak: 0.6, filter: 'lowpass', freq: 700 });
    partial(v, { freq: 110, t, attack: 0.002, decay: 0.1, peak: 0.3 });
    noise(v, g.noise('white'), { t: t + 0.11, decay: 0.03, peak: 0.12, filter: 'bandpass', freq: 2200, q: 2 });
  },
  sit: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'sit', priority: 1, duration: 0.6, gain: 0.26, wet: 0.1, spatial: { ref: 3, max: 16 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('pink'), { t, attack: 0.08, decay: 0.25, peak: 0.45, filter: 'bandpass', freq: 1400, q: 0.6 }); // cloth
    const band = filter(v, 'bandpass', 520, 10);
    partial(v, { type: 'sawtooth', freq: rand(140, 170), toFreq: 120, glideTime: 0.2, t: t + 0.12, attack: 0.03, decay: 0.2, peak: 0.5, dest: band }); // seat creak
  },
  splash: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'water', priority: 1, duration: 0.8, gain: 0.3, wet: 0.3, spatial: { ref: 4, max: 24 } });
    if (!v) return;
    const t = v.t0;
    noise(v, g.noise('white'), { t, attack: 0.004, decay: 0.35, peak: 0.6, filter: 'bandpass', freq: 2400, toFreq: 700, q: 0.8 });
    for (let i = 0; i < 6; i++) {
      const f = rand(900, 2200);
      partial(v, { freq: f, toFreq: f * rand(1.4, 1.9), glideTime: 0.04, t: t + rand(0.05, 0.5), attack: 0.002, decay: 0.05, peak: rand(0.1, 0.22) });
    }
  },
  fountain_stage: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'event', priority: 3, duration: 4, gain: 0.22, wet: 0.7, spatial: { ref: 16, max: 90, rolloff: 0.5 } });
    if (!v) return;
    const t = v.t0;
    // Rising water-glass arpeggio over a watery swell.
    noise(v, g.noise('white'), { t, attack: 0.8, decay: 1.6, peak: 0.25, filter: 'bandpass', freq: 1500, toFreq: 3500, q: 1 });
    const notes = [1046.5, 1318.5, 1568, 2093, 2637];
    notes.forEach((f, i) => {
      partial(v, { freq: f, t: t + 0.25 + i * 0.16, attack: 0.004, decay: 1.8, peak: 0.42 });
      partial(v, { freq: f * 2.76, t: t + 0.25 + i * 0.16, attack: 0.002, decay: 0.3, peak: 0.07 });
    });
  },
  world_shimmer: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'event', priority: 2, duration: 3.5, gain: 0.16, wet: 0.8 });
    if (!v) return;
    const t = v.t0;
    for (let i = 0; i < 9; i++) {
      const f = pick([1568, 1760, 2093, 2349, 2637, 3136]);
      partial(v, { freq: f * rand(0.997, 1.003), t: t + i * rand(0.08, 0.16), attack: 0.01, decay: rand(1, 1.8), peak: rand(0.2, 0.35) });
    }
  },
  discovery: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'event', priority: 3, duration: 3, gain: 0.24, wet: 0.55 });
    if (!v) return;
    const t = v.t0;
    // Music-box arpeggio (Cmaj9 rising) — tine fundamental + inharmonic overtone.
    [1046.5, 1318.5, 1568, 1975.5, 2349].forEach((f, i) => {
      const tt = t + i * 0.13;
      partial(v, { freq: f, t: tt, attack: 0.002, decay: 1.6, peak: 0.6 });
      partial(v, { freq: f * 5.4, t: tt, attack: 0.001, decay: 0.12, peak: 0.08 });
    });
    partial(v, { freq: 523.25, t, attack: 0.3, decay: 2.2, peak: 0.25 });
  },
  rune: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'event', priority: 2, duration: 3, gain: 0.22, wet: 0.6, spatial: { ref: 6, max: 40 } });
    if (!v) return;
    const t = v.t0;
    partial(v, { freq: 220, t, attack: 0.35, decay: 2.2, peak: 0.5 });
    partial(v, { freq: 330.4, t: t + 0.05, attack: 0.35, decay: 2, peak: 0.35 });
    partial(v, { freq: 441.2, t: t + 0.1, attack: 0.4, decay: 1.8, peak: 0.25 });
    partial(v, { freq: 1321, t: t + 0.15, attack: 0.02, decay: 1.2, peak: 0.12 });
  },
  rune_fade: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'event', priority: 1, duration: 2.5, gain: 0.16, wet: 0.6, spatial: { ref: 6, max: 40 } });
    if (!v) return;
    partial(v, { freq: 441, toFreq: 220, glideTime: 1.6, t: v.t0, attack: 0.05, decay: 1.8, peak: 0.4 });
    partial(v, { freq: 330, toFreq: 165, glideTime: 1.6, t: v.t0, attack: 0.05, decay: 1.6, peak: 0.25 });
  },
  portal_wake: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'event', priority: 3, duration: 6, gain: 0.22, wet: 0.7, spatial: { ref: 18, max: 120, rolloff: 0.5 } });
    if (!v) return;
    const t = v.t0;
    // Swell: low drone + rising airy noise, then a bright inharmonic bloom.
    partial(v, { freq: 55, t, attack: 2.2, hold: 0.6, decay: 2.8, peak: 0.6 });
    partial(v, { freq: 82.6, t, attack: 2.4, hold: 0.4, decay: 2.6, peak: 0.35 });
    noise(v, g.noise('pink'), { t, attack: 2.4, decay: 1.6, peak: 0.35, filter: 'bandpass', freq: 300, toFreq: 4200, q: 1.5 });
    for (const [r, a] of [[1, 0.35], [2.76, 0.2], [5.4, 0.12], [1.5, 0.25]] as const) partial(v, { freq: 440 * r, t: t + 2.4, attack: 0.01, decay: 2.5, peak: a });
  },
  portal_sleep: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'event', priority: 2, duration: 4, gain: 0.22, wet: 0.7, spatial: { ref: 18, max: 100, rolloff: 0.5 } });
    if (!v) return;
    const t = v.t0;
    partial(v, { freq: 440, toFreq: 110, glideTime: 2.5, t, attack: 0.05, decay: 3, peak: 0.3 });
    noise(v, g.noise('pink'), { t, attack: 0.1, decay: 2.5, peak: 0.25, filter: 'bandpass', freq: 3000, toFreq: 250, q: 1.5 });
  },
  reaction: (g, pos, o) => {
    const v = voice(g, pos, o, { category: 'chat', priority: 0, duration: 0.2, gain: 0.08, wet: 0.15, spatial: { ref: 6, max: 26 } });
    if (!v) return;
    partial(v, { freq: rand(560, 640), toFreq: rand(880, 960), glideTime: 0.06, t: v.t0, attack: 0.003, decay: 0.1, peak: 1 });
  },
  notification: (g, _p, o) => {
    const v = voice(g, undefined, o, { category: 'ui', priority: 1, duration: 0.6, gain: 0.1, wet: 0.3 });
    if (!v) return;
    partial(v, { freq: 880, t: v.t0, attack: 0.004, decay: 0.3, peak: 0.7 });
    partial(v, { freq: 1318.5, t: v.t0 + 0.1, attack: 0.004, decay: 0.4, peak: 0.6 });
  },
  chime: (g, pos, o) => {
    // Distant, mysterious wind-chime/bell tone: inharmonic, very wet.
    const v = voice(g, pos, o, { category: 'amb', priority: 0, duration: 5, gain: 0.12, wet: 0.9, spatial: { ref: 20, max: 120, rolloff: 0.4 }, channel: 'ambience' });
    if (!v) return;
    const f = pick([587.3, 659.3, 783.99, 880, 987.8]);
    const t = v.t0;
    for (const [r, a, d] of [[1, 0.5, 3.5], [2.76, 0.18, 1.6], [5.4, 0.07, 0.8], [1.002, 0.2, 3]] as const) partial(v, { freq: f * r, t, attack: 0.003, decay: d, peak: a });
    if (chance(0.5)) partial(v, { freq: f * 1.5, t: t + rand(0.4, 1), attack: 0.003, decay: 3, peak: 0.25 });
  },
};

// ---------------------------------------------------------------------------
// Building activities. Muffle = a wall between source and listener: duller, quieter.
// ---------------------------------------------------------------------------

/** Voice whose input runs through a low-pass when muffled (indoors ↔ outdoors). */
function activityVoice(g: AudioGraph, pos: Vec2 | undefined, o: SfxOptions, base: Omit<VoiceOptions, 'channel'>) {
  const m = Math.max(0, Math.min(1, o.muffle ?? 0));
  const v = voice(g, pos, o, { ...base, gain: (base.gain ?? 1) * (1 - m * 0.55) });
  if (!v) return null;
  const dest = m > 0 ? filter(v, 'lowpass', 5200 - m * 4400, 0.6) : v.input;
  return { v, t: v.t0, dest };
}

const ACTIVITY_RECIPES: Record<ActivitySfx, Recipe> = {
  piano: (g, pos, o) => {
    const n = Math.max(0, Math.min(24, Math.round(o.note ?? 12)));
    const f = 261.6256 * Math.pow(2, n / 12);
    const a = activityVoice(g, pos, o, { category: 'piano', priority: 2, duration: 2.6, gain: 0.34, wet: 0.35, spatial: { ref: 4, max: 34 } });
    if (!a) return;
    const { v, t, dest } = a;
    // Felted hammer: soft thump + slightly inharmonic, quickly decaying upper partials, a long fundamental.
    for (const [r, amp, d] of [[1, 0.62, 2.2], [2.001, 0.3, 1.2], [3.004, 0.14, 0.7], [4.01, 0.07, 0.4], [5.02, 0.04, 0.25]] as const) partial(v, { freq: f * r, t, attack: 0.004, decay: d * (1.15 - n / 60), peak: amp, dest });
    partial(v, { freq: f * 1.0015, t, attack: 0.006, decay: 1.9, peak: 0.16, dest });
    noise(v, g.noise('pink'), { t, attack: 0.001, decay: 0.03, peak: 0.08, filter: 'lowpass', freq: 1200, dest });
  },
  cup: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 0.8, gain: 0.2, wet: 0.2, spatial: { ref: 4, max: 22 } });
    if (!a) return;
    const { v, t, dest } = a;
    // Porcelain on saucer: two bright inharmonic tinks.
    for (const [dt, f] of [[0, rand(2900, 3300)], [rand(0.06, 0.11), rand(3500, 3900)]] as const) {
      partial(v, { freq: f, t: t + dt, attack: 0.001, decay: 0.25, peak: 0.4, dest });
      partial(v, { freq: f * 2.35, t: t + dt, attack: 0.001, decay: 0.08, peak: 0.12, dest });
    }
  },
  saw: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 1.4, gain: 0.22, wet: 0.15, spatial: { ref: 4, max: 26 } });
    if (!a) return;
    const { v, t, dest } = a;
    for (let i = 0; i < 4; i++) noise(v, g.noise('white'), { t: t + i * 0.3, attack: 0.05, hold: 0.08, decay: 0.12, peak: 0.32, filter: 'bandpass', freq: i % 2 ? 2600 : 1900, q: 2.2, dest });
  },
  hammer: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 1.4, gain: 0.26, wet: 0.25, spatial: { ref: 4, max: 30 } });
    if (!a) return;
    const { v, t, dest } = a;
    // Anvil: bright ringing strikes.
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.36;
      noise(v, g.noise('white'), { t: tt, attack: 0.001, decay: 0.02, peak: 0.5, filter: 'highpass', freq: 2500, dest });
      for (const [r, amp] of [[1, 0.35], [2.76, 0.2], [5.4, 0.1]] as const) partial(v, { freq: 1180 * r, t: tt, attack: 0.001, decay: 0.45, peak: amp, dest });
    }
  },
  kiln: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 2, gain: 0.24, wet: 0.2, spatial: { ref: 4, max: 24 } });
    if (!a) return;
    const { v, t, dest } = a;
    noise(v, g.noise('brown'), { t, attack: 0.25, hold: 0.6, decay: 0.9, peak: 0.6, filter: 'lowpass', freq: 380, toFreq: 700, dest });
    for (let i = 0; i < 6; i++) noise(v, g.noise('white'), { t: t + rand(0.1, 1.4), decay: 0.015, peak: rand(0.1, 0.2), filter: 'bandpass', freq: rand(2000, 4000), q: 2, dest });
  },
  hearth: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 2.4, gain: 0.22, wet: 0.15, spatial: { ref: 3, max: 20 } });
    if (!a) return;
    const { v, t, dest } = a;
    // Match strike, then catching kindling: a soft whoomph and crackles.
    noise(v, g.noise('white'), { t, attack: 0.002, decay: 0.12, peak: 0.35, filter: 'bandpass', freq: 3200, q: 1, dest });
    noise(v, g.noise('brown'), { t: t + 0.25, attack: 0.3, decay: 1.2, peak: 0.45, filter: 'lowpass', freq: 500, dest });
    for (let i = 0; i < 10; i++) noise(v, g.noise('white'), { t: t + rand(0.3, 2.1), decay: rand(0.006, 0.02), peak: rand(0.12, 0.3), filter: 'bandpass', freq: rand(1800, 5200), q: 1.6, dest });
  },
  kettle: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 1, duration: 1.2, gain: 0.18, wet: 0.15, spatial: { ref: 3, max: 18 } });
    if (!a) return;
    const { v, t, dest } = a;
    // Lid clink + water pouring.
    partial(v, { freq: 1650, t, attack: 0.001, decay: 0.18, peak: 0.3, dest });
    noise(v, g.noise('pink'), { t: t + 0.15, attack: 0.08, hold: 0.4, decay: 0.3, peak: 0.3, filter: 'bandpass', freq: 900, q: 0.9, dest });
  },
  kettle_whistle: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 2, duration: 3, gain: 0.12, wet: 0.2, spatial: { ref: 4, max: 26 } });
    if (!a) return;
    const { v, t, dest } = a;
    partial(v, { freq: 1320, toFreq: 1760, glideTime: 0.9, t, attack: 0.5, hold: 1.2, decay: 0.8, peak: 0.45, dest });
    partial(v, { freq: 1336, toFreq: 1778, glideTime: 0.9, t, attack: 0.5, hold: 1.2, decay: 0.8, peak: 0.2, dest });
    noise(v, g.noise('white'), { t, attack: 0.4, hold: 1.2, decay: 0.8, peak: 0.08, filter: 'highpass', freq: 3500, dest });
  },
  pin: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 0, duration: 0.5, gain: 0.2, wet: 0.2, spatial: { ref: 3, max: 18 } });
    if (!a) return;
    const { v, t, dest } = a;
    noise(v, g.noise('pink'), { t, attack: 0.01, decay: 0.12, peak: 0.25, filter: 'bandpass', freq: 2400, q: 0.8, dest });
    const body = filter(v, 'bandpass', 700, 5, dest);
    noise(v, g.noise('white'), { t: t + 0.14, attack: 0.001, decay: 0.03, peak: 0.6, dest: body });
  },
  page: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 0, duration: 0.9, gain: 0.16, wet: 0.15, spatial: { ref: 3, max: 16 } });
    if (!a) return;
    const { v, t, dest } = a;
    noise(v, g.noise('pink'), { t, attack: 0.04, decay: 0.2, peak: 0.3, filter: 'bandpass', freq: 3000, q: 0.7, dest });
    for (let i = 0; i < 5; i++) noise(v, g.noise('white'), { t: t + 0.25 + i * 0.09, decay: 0.05, peak: 0.08, filter: 'bandpass', freq: rand(3500, 5000), q: 2, dest });
  },
  ballot: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 0, duration: 0.6, gain: 0.2, wet: 0.25, spatial: { ref: 3, max: 18 } });
    if (!a) return;
    const { v, t, dest } = a;
    noise(v, g.noise('pink'), { t, attack: 0.01, decay: 0.08, peak: 0.2, filter: 'bandpass', freq: 2600, dest });
    const body = filter(v, 'bandpass', 260, 4, dest);
    noise(v, g.noise('white'), { t: t + 0.12, attack: 0.001, decay: 0.05, peak: 0.7, dest: body });
  },
  net: (g, pos, o) => {
    const a = activityVoice(g, pos, o, { category: 'activity', priority: 0, duration: 1.2, gain: 0.16, wet: 0.15, spatial: { ref: 3, max: 16 } });
    if (!a) return;
    const { v, t, dest } = a;
    for (let i = 0; i < 3; i++) partial(v, { type: 'triangle', freq: rand(180, 240), toFreq: rand(120, 160), glideTime: 0.25, t: t + i * 0.3, attack: 0.05, decay: 0.25, peak: 0.25, dest });
    noise(v, g.noise('pink'), { t, attack: 0.1, decay: 0.8, peak: 0.12, filter: 'bandpass', freq: 1400, dest });
  },
};

export function playSfxOn(g: AudioGraph, name: SfxName, pos?: Vec2, o: SfxOptions = {}): void {
  const act = (ACTIVITY_RECIPES as Partial<Record<SfxName, Recipe>>)[name];
  if (act) return act(g, pos, o);
  if (name === 'footstep') footstep(g, pos, o);
  else (RECIPES as Partial<Record<SfxName, Recipe>>)[name]?.(g, pos, o);
}
