/**
 * Tiny synthesis primitives on top of a Voice. Every node is registered with
 * the voice so it is disconnected when the voice ends.
 */
import type { Voice } from './graph.js';

let random: () => number = Math.random;
/** Swap the randomness source (offline renders use a seeded one for reproducibility). */
export function setSynthRandom(fn: () => number): void {
  random = fn;
}
export const rand = (a = 0, b = 1) => a + (b - a) * random();
export const chance = (p: number) => random() < p;
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(random() * arr.length)]!;
}

export interface PartialOpts {
  type?: OscillatorType;
  freq: number;
  /** Glide target frequency (exponential) reached at t + glideTime. */
  toFreq?: number;
  glideTime?: number;
  t: number;
  attack?: number;
  /** Time from peak to silence (exponential decay). */
  decay: number;
  /** Optional sustain hold before decay. */
  hold?: number;
  peak: number;
  detune?: number;
  dest?: AudioNode;
}

/** One oscillator with an attack/hold/exponential-decay envelope. */
export function partial(v: Voice, o: PartialOpts): OscillatorNode {
  const ctx = v.ctx;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.toFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.toFreq), o.t + (o.glideTime ?? o.decay));
  if (o.detune) osc.detune.value = o.detune;
  const g = v.add(ctx.createGain());
  const a = Math.max(0.002, o.attack ?? 0.004);
  const hold = o.hold ?? 0;
  g.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
  g.gain.setValueAtTime(0, o.t);
  g.gain.linearRampToValueAtTime(o.peak, o.t + a);
  if (hold > 0) g.gain.setValueAtTime(o.peak, o.t + a + hold);
  const end = o.t + a + hold + o.decay;
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(g);
  g.connect(o.dest ?? v.input);
  v.src(osc, o.t, end + 0.02);
  return osc;
}

export interface NoiseOpts {
  t: number;
  attack?: number;
  decay: number;
  hold?: number;
  peak: number;
  kind?: 'white' | 'pink' | 'brown';
  filter?: BiquadFilterType;
  freq?: number;
  toFreq?: number;
  q?: number;
  /** Second filter in series (e.g. highpass + lowpass). */
  filter2?: BiquadFilterType;
  freq2?: number;
  q2?: number;
  dest?: AudioNode;
  rate?: number;
}

/** A filtered noise burst (random offset into the shared noise buffer). */
export function noise(v: Voice, buf: AudioBuffer, o: NoiseOpts): AudioBufferSourceNode {
  const ctx = v.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;
  let node: AudioNode = src;
  if (o.filter) {
    const f = v.add(ctx.createBiquadFilter());
    f.type = o.filter;
    f.frequency.setValueAtTime(o.freq ?? 1000, o.t);
    if (o.toFreq) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.toFreq), o.t + (o.attack ?? 0.004) + (o.hold ?? 0) + o.decay);
    f.Q.value = o.q ?? 0.8;
    node.connect(f);
    node = f;
  }
  if (o.filter2) {
    const f = v.add(ctx.createBiquadFilter());
    f.type = o.filter2;
    f.frequency.value = o.freq2 ?? 1000;
    f.Q.value = o.q2 ?? 0.7;
    node.connect(f);
    node = f;
  }
  const g = v.add(ctx.createGain());
  const a = Math.max(0.002, o.attack ?? 0.003);
  const hold = o.hold ?? 0;
  g.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
  g.gain.setValueAtTime(0, o.t);
  g.gain.linearRampToValueAtTime(o.peak, o.t + a);
  if (hold > 0) g.gain.setValueAtTime(o.peak, o.t + a + hold);
  const end = o.t + a + hold + o.decay;
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  node.connect(g);
  g.connect(o.dest ?? v.input);
  v.src(src, o.t, end + 0.02, rand(0, Math.max(0, buf.duration - (end - o.t) - 0.1)));
  return src;
}

/** Filter node owned by the voice, feeding `dest` (default voice input). */
export function filter(v: Voice, type: BiquadFilterType, freq: number, q = 0.7, dest?: AudioNode): BiquadFilterNode {
  const f = v.add(v.ctx.createBiquadFilter());
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.connect(dest ?? v.input);
  return f;
}

export function gainNode(v: Voice, value: number, dest?: AudioNode): GainNode {
  const g = v.add(v.ctx.createGain());
  g.gain.value = value;
  g.connect(dest ?? v.input);
  return g;
}
