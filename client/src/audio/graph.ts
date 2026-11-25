/**
 * The Web Audio graph. Works on BOTH a realtime AudioContext and an
 * OfflineAudioContext (offline renders in scripts/audio-verify.mjs use the very
 * same code), so nothing here touches window/document.
 *
 *   voice ─┬─ dry[ch] (bus gain = channel volume) ─┐
 *          └─ wet[ch] (same volume) → reverb ──────┼─ master (master × !muted) → compressor → soft clip → destination
 *   bed ───┘                                        │
 *
 * One-shot sounds are `Voice`s: every node they create is registered and
 * disconnected when the last source ends (no runaway node creation), and the
 * VoiceLimiter caps how many can sound at once.
 */
import type { Vec2 } from '@elsewhere/shared';
import type { VolumeChannel } from '../state/settingsStore.js';
import { DEFAULT_CAMERA_YAW, spatialize, type SpatialOptions } from './spatial.js';
import { VoiceLimiter } from './voiceLimiter.js';

export type Channel = VolumeChannel;
export const CHANNELS: readonly Channel[] = ['music', 'ambience', 'sfx'];

export interface BusLevels {
  master: number;
  music: number;
  ambience: number;
  sfx: number;
}

export interface VoiceOptions {
  channel: Channel;
  category: string;
  /** Higher = harder to steal. 0 ambience detail … 3 important cue. */
  priority?: number;
  /** Start time (ctx seconds). Default: now + 10 ms. */
  at?: number;
  /** Expected length in seconds (for the limiter; sources still define the true end). */
  duration: number;
  position?: Vec2;
  spatial?: SpatialOptions;
  /** Linear voice gain before spatial attenuation. */
  gain?: number;
  /** Reverb send 0..1. */
  wet?: number;
  /** Explicit pan when not positional. */
  pan?: number;
  /** Route into a sub-mix instead of the channel buses (e.g. the music fader). */
  route?: { dry: AudioNode; wet: AudioNode };
}

export interface GraphStats {
  /** Nodes currently alive inside one-shot voices. */
  voiceNodes: number;
  /** Long-lived nodes (buses, beds, reverb, music pads are voices). */
  persistentNodes: number;
  activeVoices: number;
  voicesCreated: number;
  voicesReleased: number;
  voicesRejected: number;
  voicesStolen: number;
}

type NoiseKind = 'white' | 'pink' | 'brown';

export class Voice {
  readonly input: GainNode;
  private nodes: AudioNode[] = [];
  private sources = new Set<AudioScheduledSourceNode>();
  private done = false;
  slotId = 0;

  constructor(
    private readonly graph: AudioGraph,
    readonly t0: number,
    input: GainNode,
    extra: AudioNode[],
  ) {
    this.input = input;
    this.nodes.push(input, ...extra);
  }

  get ctx(): BaseAudioContext {
    return this.graph.ctx;
  }

  add<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    this.graph.stats.voiceNodes++;
    return node;
  }

  /** Register a source that starts at `start` and stops at `stop`. Cleanup happens when all sources end. */
  src<T extends AudioScheduledSourceNode>(node: T, start: number, stop: number, offset?: number): T {
    this.add(node);
    this.sources.add(node);
    node.onended = () => {
      this.sources.delete(node);
      if (this.sources.size === 0) this.dispose();
    };
    if (offset !== undefined && node instanceof AudioBufferSourceNode) node.start(Math.max(start, 0), offset);
    else node.start(Math.max(start, 0));
    node.stop(Math.max(stop, start + 0.01));
    return node;
  }

  /** Fade out quickly and stop at `at` (default now) — voice stealing / shutdown. */
  kill(at?: number): void {
    if (this.done) return;
    const now = Math.max(at ?? 0, this.graph.ctx.currentTime);
    try {
      this.input.gain.cancelScheduledValues(now);
      this.input.gain.setTargetAtTime(0, now, 0.012);
      for (const s of this.sources) s.stop(now + 0.06);
    } catch {
      this.dispose();
    }
    if (this.sources.size === 0) this.dispose();
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.graph.releaseVoice(this, this.nodes.length);
    this.nodes = [];
    this.sources.clear();
  }
}

export class AudioGraph {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode;
  readonly dry: Record<Channel, GainNode>;
  readonly wet: Record<Channel, GainNode>;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter = new VoiceLimiter({
    maxVoices: 40,
    perCategory: { footstep: 6, remote_step: 4, bird: 4, insect: 6, music: 30, ui: 3, chat: 2, bell: 4, amb: 8, water: 6 },
    defaultCategoryMax: 6,
  });
  readonly stats: GraphStats = { voiceNodes: 0, persistentNodes: 0, activeVoices: 0, voicesCreated: 0, voicesReleased: 0, voicesRejected: 0, voicesStolen: 0 };
  listener: Vec2 = { x: 0, z: 0 };
  cameraYaw = DEFAULT_CAMERA_YAW;
  private noiseCache = new Map<NoiseKind, AudioBuffer>();
  private voices = new Set<Voice>();
  private persistent: AudioNode[] = [];
  readonly hasStereoPanner: boolean;

  constructor(ctx: BaseAudioContext, levels: BusLevels) {
    this.ctx = ctx;
    this.hasStereoPanner = typeof ctx.createStereoPanner === 'function';
    this.master = this.keep(ctx.createGain());
    this.master.gain.value = levels.master;
    this.compressor = this.keep(ctx.createDynamicsCompressor());
    // Gentle bus glue + safety: only acts on loud stacked events.
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.3;
    const clip = this.keep(ctx.createWaveShaper());
    clip.curve = softClipCurve();
    const out = this.keep(ctx.createGain());
    out.gain.value = 0.95;
    this.master.connect(this.compressor);
    this.compressor.connect(clip);
    clip.connect(out);
    out.connect(ctx.destination);

    const reverb = this.keep(ctx.createConvolver());
    reverb.normalize = true;
    reverb.buffer = makeImpulse(ctx, 3.4);
    const reverbOut = this.keep(ctx.createGain());
    reverbOut.gain.value = 0.55;
    reverb.connect(reverbOut);
    reverbOut.connect(this.master);

    const mk = (gain: number, to: AudioNode) => {
      const g = this.keep(ctx.createGain());
      g.gain.value = gain;
      g.connect(to);
      return g;
    };
    this.dry = { music: mk(levels.music, this.master), ambience: mk(levels.ambience, this.master), sfx: mk(levels.sfx, this.master) };
    this.wet = { music: mk(levels.music, reverb), ambience: mk(levels.ambience, reverb), sfx: mk(levels.sfx, reverb) };
    // Keep-alive: Chrome stops processing a GainNode whose inputs have all gone away, and
    // its gain automation then is not evaluated (`.value` stays stale). A single silent
    // ConstantSource feeding every bus keeps them live (and the debug readout honest).
    if (typeof ctx.createConstantSource === 'function') {
      const zero = this.keep(ctx.createConstantSource());
      zero.offset.value = 0;
      for (const ch of CHANNELS) {
        zero.connect(this.dry[ch]);
        zero.connect(this.wet[ch]);
      }
      zero.start();
    }
  }

  /** Track a long-lived node. */
  keep<T extends AudioNode>(node: T): T {
    this.persistent.push(node);
    this.stats.persistentNodes++;
    return node;
  }

  /** Release a long-lived node created with keep(). */
  drop(node: AudioNode): void {
    const i = this.persistent.indexOf(node);
    if (i >= 0) {
      this.persistent.splice(i, 1);
      this.stats.persistentNodes--;
    }
    try {
      node.disconnect();
    } catch {
      /* ignore */
    }
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  setLevels(l: BusLevels, ramp = 0.08): void {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number) => {
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.setTargetAtTime(v, t, ramp);
    };
    set(this.master.gain, l.master);
    for (const ch of CHANNELS) {
      set(this.dry[ch].gain, l[ch]);
      set(this.wet[ch].gain, l[ch]);
    }
  }

  busGains(): BusLevels {
    return { master: this.master.gain.value, music: this.dry.music.gain.value, ambience: this.dry.ambience.gain.value, sfx: this.dry.sfx.gain.value };
  }

  noise(kind: NoiseKind = 'white'): AudioBuffer {
    let b = this.noiseCache.get(kind);
    if (!b) {
      b = makeNoise(this.ctx, kind, 4);
      this.noiseCache.set(kind, b);
    }
    return b;
  }

  /** Allocate a one-shot voice, or null if spatially inaudible / limiter refuses. */
  voice(o: VoiceOptions): Voice | null {
    const ctx = this.ctx;
    const t0 = Math.max(o.at ?? ctx.currentTime + 0.01, ctx.currentTime);
    let gain = o.gain ?? 1;
    let pan = o.pan ?? 0;
    if (o.position) {
      const s = spatialize(this.listener, o.position, this.cameraYaw, o.spatial);
      if (s.gain < 0.01) return null;
      gain *= s.gain;
      pan = s.pan;
    }
    // Limiter time is the event's own start time, so scheduled-ahead (offline) events are counted correctly.
    const slot = this.limiter.acquire(o.category, o.priority ?? 1, t0, t0 + o.duration + 0.1, (at) => v.kill(at));
    this.stats.voicesRejected = this.limiter.rejected;
    this.stats.voicesStolen = this.limiter.stolen;
    if (!slot) return null;
    const input = ctx.createGain();
    input.gain.value = gain;
    const extra: AudioNode[] = [];
    let tail: AudioNode = input;
    if (pan !== 0 && this.hasStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      input.connect(p);
      extra.push(p);
      tail = p;
    }
    tail.connect(o.route?.dry ?? this.dry[o.channel]);
    if ((o.wet ?? 0) > 0) {
      const w = ctx.createGain();
      w.gain.value = o.wet!;
      tail.connect(w);
      w.connect(o.route?.wet ?? this.wet[o.channel]);
      extra.push(w);
    }
    const v = new Voice(this, t0, input, extra);
    v.slotId = slot.id;
    this.stats.voiceNodes += 1 + extra.length;
    this.stats.voicesCreated++;
    this.voices.add(v);
    this.stats.activeVoices = this.voices.size;
    return v;
  }

  releaseVoice(v: Voice, nodeCount: number): void {
    if (!this.voices.delete(v)) return;
    this.limiter.release(v.slotId);
    this.stats.voiceNodes -= nodeCount;
    this.stats.voicesReleased++;
    this.stats.activeVoices = this.voices.size;
  }

  /** Stop every one-shot voice (shutdown / unmount). */
  killAll(): void {
    for (const v of [...this.voices]) v.kill();
  }

  dispose(): void {
    for (const v of [...this.voices]) v.dispose();
    for (const n of this.persistent) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.persistent = [];
    this.stats.persistentNodes = 0;
  }
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    // Linear to 0.75, then smooth knee to 0.98.
    const y = a < 0.75 ? a : 0.75 + 0.23 * Math.tanh((a - 0.75) / 0.23);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

function makeNoise(ctx: BaseAudioContext, kind: NoiseKind, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = kind === 'white' ? 1 : kind === 'pink' ? 2 : 3;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = rnd() * 2 - 1;
    if (kind === 'white') d[i] = w * 0.5;
    else if (kind === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
  }
  // Crossfade the loop seam.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i]! * t + d[len - fade + i]! * (1 - t);
  }
  return buf;
}

/** Generated stereo impulse: short predelay, diffuse exponential tail that darkens over time. */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * 0.018);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let seed = 0x9e3779b9 + ch * 7919;
    let y = 0;
    for (let i = pre; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const w = seed / 4294967296 - 0.5;
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9 * t) / seconds) * (t < 0.08 ? 0.55 + (t / 0.08) * 0.45 : 1);
      const a = 0.85 - 0.75 * Math.min(1, t / seconds); // one-pole lowpass, darker later
      y += a * (w - y);
      d[i] = y * env;
    }
  }
  return buf;
}
