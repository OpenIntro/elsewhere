/**
 * Turns the MusicPlanner's blocks into sound. Look-ahead scheduler: call
 * `schedule(horizon)` regularly (realtime: every ~250 ms with a few seconds of
 * look-ahead; offline: once with the render length).
 *
 * Timbres (TEMPORARY placeholder synthesis):
 *  - pad: triangle + detuned saw through a mood-dependent lowpass, slow swell
 *  - bass: soft sine + quiet octave
 *  - pluck / musicbox / glass / chime: sine-based mallet/tine/glass tones with
 *    a few (some inharmonic) overtones and long reverb.
 */
import type { AudioGraph } from './graph.js';
import { MusicPlanner, midiToHz, type Mood, type MusicBlock, type NoteEvent } from './musicPlan.js';

const BRIGHTNESS: Record<Mood, { cutoff: number; detune: number; wet: number }> = {
  day: { cutoff: 2100, detune: 6, wet: 0.5 },
  evening: { cutoff: 1500, detune: 7, wet: 0.6 },
  night: { cutoff: 950, detune: 8, wet: 0.75 },
  mystery: { cutoff: 800, detune: 16, wet: 0.85 },
};

/** Overall music trim (pads are many simultaneous oscillators). */
const LEVEL = { pad: 0.045, bass: 0.09, pluck: 0.14, musicbox: 0.13, glass: 0.08, chime: 0.07 } as const;

export class MusicPlayer {
  private planner: MusicPlanner;
  private nextStart = 0;
  private mood: Mood = 'day';
  private playing = false;
  private readonly faderDry: GainNode;
  private readonly faderWet: GainNode;
  lastBlock: MusicBlock | null = null;

  constructor(
    private readonly g: AudioGraph,
    seed: number,
    opts: { startWithRest?: boolean } = {},
  ) {
    this.planner = new MusicPlanner(seed, opts);
    this.faderDry = g.keep(g.ctx.createGain());
    this.faderWet = g.keep(g.ctx.createGain());
    this.faderDry.gain.value = 0;
    this.faderWet.gain.value = 0;
    this.faderDry.connect(g.dry.music);
    this.faderWet.connect(g.wet.music);
  }

  get currentMood(): Mood {
    return this.mood;
  }
  get isPlaying(): boolean {
    return this.playing;
  }

  setMood(m: Mood): void {
    this.mood = m;
  }

  start(at = this.g.now): void {
    if (this.playing) return;
    this.playing = true;
    this.nextStart = Math.max(this.nextStart, at);
    for (const f of [this.faderDry, this.faderWet]) {
      f.gain.cancelScheduledValues(at);
      f.gain.setValueAtTime(f.gain.value, at);
      f.gain.setTargetAtTime(1, at, 0.4);
    }
  }

  /** Fade out over a few seconds and stop planning. */
  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    const t = this.g.now;
    for (const f of [this.faderDry, this.faderWet]) {
      f.gain.cancelScheduledValues(t);
      f.gain.setValueAtTime(f.gain.value, t);
      f.gain.setTargetAtTime(0, t, 1.2);
    }
  }

  schedule(horizon: number): void {
    if (!this.playing) return;
    // Don't build up a backlog after the context was suspended.
    if (this.nextStart < this.g.now - 1) this.nextStart = this.g.now + 0.5;
    while (this.nextStart < horizon) {
      const block = this.planner.next(this.mood, this.nextStart);
      this.lastBlock = block;
      for (const e of block.events) this.note(e, block.mood);
      this.nextStart = block.start + block.dur;
    }
  }

  private note(e: NoteEvent, mood: Mood): void {
    const g = this.g;
    const b = BRIGHTNESS[mood];
    const f = midiToHz(e.midi);
    const route = { dry: this.faderDry, wet: this.faderWet };
    const ctx = g.ctx;
    switch (e.voice) {
      case 'pad': {
        const atk = mood === 'day' ? 2.2 : 3;
        const rel = 3.5;
        const v = g.voice({ channel: 'music', category: 'music', priority: 1, at: e.t, duration: e.dur + rel, gain: LEVEL.pad * e.vel, wet: b.wet, route, pan: ((e.midi % 7) - 3) * 0.08 });
        if (!v) return;
        const t = v.t0;
        const lp = v.add(ctx.createBiquadFilter());
        lp.type = 'lowpass';
        lp.Q.value = 0.4;
        lp.frequency.setValueAtTime(b.cutoff * 0.6, t);
        lp.frequency.linearRampToValueAtTime(b.cutoff, t + atk + 1);
        lp.frequency.linearRampToValueAtTime(b.cutoff * 0.7, t + e.dur);
        const env = v.add(ctx.createGain());
        env.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + atk);
        env.gain.setValueAtTime(1, t + Math.max(atk, e.dur - rel));
        env.gain.linearRampToValueAtTime(0, t + e.dur + 0.2);
        lp.connect(env);
        env.connect(v.input);
        const end = t + e.dur + 0.3;
        const o1 = ctx.createOscillator();
        o1.type = 'triangle';
        o1.frequency.value = f;
        o1.detune.value = -b.detune;
        const o2 = ctx.createOscillator();
        o2.type = 'sawtooth';
        o2.frequency.value = f;
        o2.detune.value = b.detune;
        const g2 = v.add(ctx.createGain());
        g2.gain.value = 0.35;
        o1.connect(lp);
        o2.connect(g2);
        g2.connect(lp);
        v.src(o1, t, end);
        v.src(o2, t, end);
        return;
      }
      case 'bass': {
        const v = g.voice({ channel: 'music', category: 'music', priority: 1, at: e.t, duration: e.dur + 2, gain: LEVEL.bass * e.vel, wet: 0.25, route });
        if (!v) return;
        const t = v.t0;
        const env = v.add(ctx.createGain());
        env.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(1, t + 0.8);
        env.gain.setTargetAtTime(0.55, t + 0.8, 2);
        env.gain.setTargetAtTime(0, t + e.dur - 1, 0.6);
        env.connect(v.input);
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const o2 = ctx.createOscillator();
        o2.frequency.value = f * 2;
        const g2 = v.add(ctx.createGain());
        g2.gain.value = 0.15;
        o.connect(env);
        o2.connect(g2);
        g2.connect(env);
        v.src(o, t, t + e.dur + 2);
        v.src(o2, t, t + e.dur + 2);
        return;
      }
      default: {
        // Struck voices: [ratio, amp, decay-multiplier] partial sets.
        const sets: Record<'pluck' | 'musicbox' | 'glass' | 'chime', { parts: [number, number, number][]; attack: number; decay: number }> = {
          pluck: { parts: [[1, 1, 1], [2, 0.35, 0.45], [3, 0.12, 0.25]], attack: 0.004, decay: 1.5 },
          musicbox: { parts: [[1, 1, 1], [5.4, 0.12, 0.12], [2, 0.08, 0.5]], attack: 0.002, decay: 2.2 },
          glass: { parts: [[1, 1, 1], [2.005, 0.3, 0.7], [3.01, 0.08, 0.4]], attack: 0.06, decay: 3.2 },
          chime: { parts: [[1, 1, 1], [2.76, 0.28, 0.5], [5.4, 0.1, 0.25], [1.003, 0.4, 0.9]], attack: 0.003, decay: 3.8 },
        };
        const s = sets[e.voice];
        const decay = Math.max(s.decay * (mood === 'night' ? 1.2 : 1), e.dur);
        const v = g.voice({ channel: 'music', category: 'music', priority: 2, at: e.t, duration: decay + 0.1, gain: LEVEL[e.voice] * e.vel, wet: Math.min(0.95, b.wet + 0.15), route, pan: ((e.midi % 5) - 2) * 0.15 });
        if (!v) return;
        const t = v.t0;
        for (const [ratio, amp, dm] of s.parts) {
          const fr = f * ratio;
          if (fr > 12000) continue;
          const o = ctx.createOscillator();
          o.frequency.value = fr;
          const env = v.add(ctx.createGain());
          env.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
          env.gain.setValueAtTime(0, t);
          env.gain.linearRampToValueAtTime(amp, t + s.attack);
          env.gain.exponentialRampToValueAtTime(0.0001, t + s.attack + decay * dm);
          o.connect(env);
          env.connect(v.input);
          v.src(o, t, t + s.attack + decay * dm + 0.02);
        }
      }
    }
  }

  dispose(): void {
    this.playing = false;
    this.g.drop(this.faderDry);
    this.g.drop(this.faderWet);
  }
}
