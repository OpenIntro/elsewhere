/**
 * Ambience: continuous beds (wind, shore, fountain, creek, café murmur, forest
 * rustle, portal hum, insect haze) cross-faded by the pure `ambienceMix`, plus
 * scheduled event layers (birdsong, crickets, owl, gulls, workshop taps, café
 * clinks, water droplets, rare distant chimes) scattered around the listener.
 *
 * Beds are created lazily when their weight rises and torn down after a while
 * at zero, so the node count stays small on mobile. Works on realtime and
 * offline contexts: call `update(mix)` then `tick(horizon)`.
 *
 * TEMPORARY placeholder synthesis, tuned blind.
 */
import type { Vec2 } from '@elsewhere/shared';
import { BED_LAYERS, type AmbienceLayer, type AmbienceMix, type BedLayer } from './ambienceMix.js';
import type { AudioGraph } from './graph.js';
import { playSfxOn } from './sfx.js';
import { spatialize } from './spatial.js';
import { chance, noise, partial, pick, rand } from './synth.js';

/** Per-bed loudness at weight 1 (linear, pre channel bus). */
const BED_LEVEL: Record<BedLayer, number> = {
  wind: 0.16,
  shore: 0.3,
  fountain: 0.1,
  creek: 0.11,
  cafe: 0.12,
  forest: 0.05,
  mystery: 0.1,
  insects: 0.018,
};

/** Event layers: mean events per second at weight 1. */
const EVENT_RATE: Partial<Record<AmbienceLayer, number>> = {
  birds: 0.5,
  gulls: 0.06,
  insects: 3.2,
  owl: 0.035,
  workshop: 0.1,
  cafe: 0.25,
  fountain: 3,
  creek: 2.2,
  chimes: 0.012,
  forest: 0.12,
};

interface Bed {
  layer: BedLayer;
  level: GainNode;
  pan: StereoPannerNode | null;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  /** Modulation targets. */
  mods: AudioParam[];
  zeroSince: number;
}

const STEP = 0.25;

export class AmbiencePlayer {
  private beds = new Map<BedLayer, Bed>();
  private mix: AmbienceMix | null = null;
  private cursor = 0;
  private nextGust = 0;
  private nextWave = 0;
  private nextMurmur = 0;
  private crickets: { pos: Vec2; period: number; next: number; pitch: number }[] = [];
  private cricketsMovedAt = -Infinity;
  private perches: { pos: Vec2; species: number; until: number }[] = [];
  private gust = 0.8;
  private running = false;
  /** Layers forced on/off for tests and offline renders (solo). */
  solo: AmbienceLayer | null = null;
  /** Multiplies event rates (offline verification of rare layers). */
  rateBoost = 1;
  /** Teardown delay for silent beds (s). 0 = never tear down (offline). */
  idleTeardown = 8;

  constructor(private readonly g: AudioGraph) {}

  start(at = this.g.now): void {
    this.running = true;
    this.cursor = Math.max(this.cursor, at);
  }

  stop(): void {
    this.running = false;
    for (const b of this.beds.values()) this.destroyBed(b, true);
    this.beds.clear();
  }

  get bedCount(): number {
    return this.beds.size;
  }

  private w(layer: AmbienceLayer): number {
    if (!this.mix) return 0;
    if (this.solo) return this.solo === layer ? 1 : 0;
    return this.mix.weights[layer];
  }

  /** Apply a new mix: ramp bed levels and pans (no clicks: setTargetAtTime). */
  update(mix: AmbienceMix, rampTc = 1.2): void {
    this.mix = mix;
    if (!this.running) return;
    const t = this.g.now;
    for (const layer of BED_LAYERS) {
      const w = this.w(layer);
      let bed = this.beds.get(layer);
      if (!bed && w > 0.005) bed = this.createBed(layer, t);
      if (!bed) continue;
      const target = w * BED_LEVEL[layer];
      bed.level.gain.setTargetAtTime(target, t, rampTc);
      if (w > 0.003) bed.zeroSince = Infinity;
      else if (bed.zeroSince === Infinity) bed.zeroSince = t;
      if (bed.pan) {
        const src = this.bedSource(layer);
        const pan = src ? spatialize(this.g.listener, src, this.g.cameraYaw, { ref: 1, max: 1e6 }).pan * 0.7 : 0;
        bed.pan.pan.setTargetAtTime(pan, t, 0.8);
      }
    }
    for (const bed of [...this.beds.values()])
      if (this.idleTeardown > 0 && bed.zeroSince !== Infinity && t - bed.zeroSince > this.idleTeardown) {
        this.destroyBed(bed, false);
        this.beds.delete(bed.layer);
      }
  }

  private bedSource(layer: BedLayer): Vec2 | null {
    const s = this.mix?.sources;
    if (!s) return null;
    switch (layer) {
      case 'shore':
        return s.shore;
      case 'fountain':
        return s.fountain;
      case 'creek':
        return s.creek;
      case 'cafe':
        return s.cafe;
      case 'mystery':
        return s.mystery;
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Beds
  // -------------------------------------------------------------------------

  private createBed(layer: BedLayer, t: number): Bed {
    const g = this.g;
    const ctx = g.ctx;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    const mods: AudioParam[] = [];
    const keep = <T extends AudioNode>(n: T): T => {
      nodes.push(g.keep(n));
      return n;
    };
    const level = keep(ctx.createGain());
    level.gain.value = 0;
    const pan = g.hasStereoPanner && layer !== 'wind' && layer !== 'forest' && layer !== 'insects' ? keep(ctx.createStereoPanner()) : null;
    const wetSend = keep(ctx.createGain());
    wetSend.gain.value = layer === 'mystery' ? 0.6 : layer === 'cafe' ? 0.25 : 0.12;
    const head: AudioNode = pan ?? level;
    if (pan) level.connect(pan);
    head.connect(g.dry.ambience);
    head.connect(wetSend);
    wetSend.connect(g.wet.ambience);

    const loop = (kind: 'white' | 'pink' | 'brown', rate = 1) => {
      const s = keep(ctx.createBufferSource());
      s.buffer = g.noise(kind);
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(t, rand(0, 3.5));
      sources.push(s);
      return s;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
      const n = keep(ctx.createBiquadFilter());
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const gain = (v: number) => {
      const n = keep(ctx.createGain());
      n.gain.value = v;
      return n;
    };
    const chain = (...ns: AudioNode[]) => {
      for (let i = 0; i + 1 < ns.length; i++) ns[i]!.connect(ns[i + 1]!);
    };

    switch (layer) {
      case 'wind': {
        const bp = filt('bandpass', 380, 0.6);
        const gust = gain(0.8);
        chain(loop('brown', 0.9), bp, gust, level);
        const hiss = filt('highpass', 2500, 0.5);
        const hg = gain(0.12);
        chain(loop('pink', 1.1), hiss, hg, gust);
        mods.push(bp.frequency, gust.gain);
        break;
      }
      case 'shore': {
        const lp = filt('lowpass', 650, 0.5);
        const wave = gain(0.3);
        chain(loop('brown'), lp, wave, level);
        const hp = filt('highpass', 2600, 0.5);
        const lp2 = filt('lowpass', 7500, 0.5);
        const foam = gain(0.05);
        chain(loop('white'), hp, lp2, foam, level);
        mods.push(wave.gain, foam.gain);
        break;
      }
      case 'fountain': {
        const bp = filt('bandpass', 2600, 0.5);
        const shelf = gain(0.9);
        chain(loop('white'), bp, shelf, level);
        const lp = filt('lowpass', 900, 0.6);
        const body = gain(0.55);
        chain(loop('pink'), lp, body, level);
        break;
      }
      case 'creek': {
        const bp = filt('bandpass', 1100, 0.7);
        const lp = filt('lowpass', 3200, 0.5);
        chain(loop('pink', 1.05), bp, lp, level);
        const bp2 = filt('bandpass', 450, 1.2);
        const g2 = gain(0.6);
        chain(loop('brown', 1.2), bp2, g2, level);
        mods.push(bp.frequency);
        break;
      }
      case 'cafe': {
        // Murmur: two voice-formant bands with syllabic amplitude modulation.
        const src = loop('pink', 0.95);
        const f1 = filt('bandpass', 420, 1.6);
        const m1 = gain(0.6);
        const f2 = filt('bandpass', 1150, 2.2);
        const m2 = gain(0.35);
        chain(src, f1, m1, level);
        chain(src, f2, m2, level);
        mods.push(m1.gain, m2.gain);
        break;
      }
      case 'forest': {
        const hp = filt('highpass', 1800, 0.5);
        const lp = filt('lowpass', 6500, 0.5);
        const rustle = gain(0.8);
        chain(loop('white', 0.97), hp, lp, rustle, level);
        mods.push(rustle.gain);
        break;
      }
      case 'mystery': {
        const lp = filt('lowpass', 420, 0.5);
        const sum = gain(1);
        chain(sum, lp, level);
        for (const [f, a] of [[55, 0.5], [82.6, 0.32], [110.7, 0.22], [164.9, 0.1]] as const) {
          const o = keep(ctx.createOscillator());
          o.frequency.value = f;
          const og = gain(a);
          chain(o, og, sum);
          o.start(t);
          sources.push(o);
        }
        // Breathing: slow AM via an LFO on the sum.
        const lfo = keep(ctx.createOscillator());
        lfo.frequency.value = 0.07;
        const depth = gain(0.35);
        chain(lfo, depth);
        depth.connect(sum.gain);
        lfo.start(t);
        sources.push(lfo);
        break;
      }
      case 'insects': {
        const bp = filt('bandpass', 5200, 9);
        const amp = gain(1);
        chain(loop('white'), bp, amp, level);
        // Pulsing haze: fast LFO on the amplitude.
        const lfo = keep(ctx.createOscillator());
        lfo.frequency.value = 13;
        const depth = gain(0.5);
        chain(lfo, depth);
        depth.connect(amp.gain);
        lfo.start(t);
        sources.push(lfo);
        break;
      }
    }
    const bed: Bed = { layer, level, pan, nodes, sources, mods, zeroSince: Infinity };
    this.beds.set(layer, bed);
    return bed;
  }

  private destroyBed(b: Bed, fade: boolean): void {
    const t = this.g.now;
    try {
      b.level.gain.cancelScheduledValues(t);
      if (fade) b.level.gain.setTargetAtTime(0, t, 0.3);
      for (const s of b.sources) s.stop(t + (fade ? 1.5 : 0.05));
    } catch {
      /* ignore */
    }
    const drop = () => {
      for (const n of b.nodes) this.g.drop(n);
    };
    const last = b.sources[0];
    if (last) last.onended = drop;
    else drop();
  }

  // -------------------------------------------------------------------------
  // Scheduled modulation + events
  // -------------------------------------------------------------------------

  tick(horizon: number): void {
    if (!this.running || !this.mix) return;
    const now = this.g.now;
    if (this.cursor < now - 1) this.cursor = now; // skip backlog after suspension
    while (this.cursor < horizon) {
      const t = this.cursor;
      this.modulate(t);
      this.events(t);
      this.cursor += STEP;
    }
  }

  private modulate(t: number): void {
    const wind = this.beds.get('wind');
    if (wind && t >= this.nextGust) {
      this.gust = rand(0.45, 1.25);
      const [freq, gain] = wind.mods;
      freq?.setTargetAtTime(rand(260, 650), t, rand(1, 2.5));
      gain?.setTargetAtTime(this.gust, t, rand(1, 2.5));
      const forest = this.beds.get('forest');
      forest?.mods[0]?.setTargetAtTime(0.5 + this.gust * 0.6, t + 0.3, 1.5);
      this.nextGust = t + rand(2.5, 6);
    }
    const shore = this.beds.get('shore');
    if (shore && t >= this.nextWave) {
      const [wave, foam] = shore.mods;
      const crest = rand(0.7, 1.1);
      wave?.setTargetAtTime(crest, t, 0.9);
      wave?.setTargetAtTime(0.22, t + 2.4, 1.6);
      foam?.setTargetAtTime(0.25 * crest, t + 1.9, 0.4);
      foam?.setTargetAtTime(0.03, t + 2.9, 1.2);
      this.nextWave = t + rand(6, 10);
    }
    const creek = this.beds.get('creek');
    if (creek && chance(0.25)) creek.mods[0]?.setTargetAtTime(rand(850, 1400), t, 0.6);
    const cafe = this.beds.get('cafe');
    if (cafe && t >= this.nextMurmur) {
      // Syllabic chatter: a few independent amplitude targets per step.
      for (let k = 0; k < 2; k++) {
        const tt = t + k * STEP * 0.5;
        cafe.mods[0]?.setTargetAtTime(rand(0.25, 1), tt, 0.06);
        cafe.mods[1]?.setTargetAtTime(rand(0.1, 0.6), tt + 0.05, 0.05);
      }
      this.nextMurmur = t + STEP * 0.9;
    }
  }

  private scatter(min: number, max: number): Vec2 {
    const a = rand(0, Math.PI * 2);
    const r = rand(min, max);
    return { x: this.g.listener.x + Math.cos(a) * r, z: this.g.listener.z + Math.sin(a) * r };
  }

  private fire(layer: AmbienceLayer): boolean {
    const rate = EVENT_RATE[layer] ?? 0;
    return chance(rate * this.rateBoost * this.w(layer) * STEP);
  }

  private events(t: number): void {
    const at = t + rand(0, STEP);
    if (this.fire('birds')) this.bird(at);
    if (this.fire('gulls')) this.gull(at);
    if (this.w('insects') > 0.02) this.cricketsStep(t);
    if (this.fire('owl')) this.owl(at);
    if (this.fire('workshop') && this.mix) this.workshop(at, this.mix.sources.workshop);
    if (this.fire('cafe') && this.mix) this.clink(at, this.mix.sources.cafe);
    if (this.fire('fountain') && this.mix && this.w('fountain') > 0.15) this.droplet(at, this.mix.sources.fountain, 0.035, [900, 2400]);
    if (this.fire('creek') && this.mix && this.w('creek') > 0.15) this.droplet(at, this.mix.sources.creek, 0.03, [350, 900]);
    if (this.fire('forest')) this.twig(at);
    if (this.fire('chimes')) playSfxOn(this.g, 'chime', this.scatter(25, 50), { at });
  }

  private ev(at: number, category: string, duration: number, gain: number, pos: Vec2, wet = 0.3, max = 60) {
    return this.g.voice({ channel: 'ambience', category, priority: 0, at, duration, gain, wet, position: pos, spatial: { ref: 8, max, rolloff: 0.5 } });
  }

  private bird(at: number): void {
    // Reuse perches so a bird calls a few times from the same spot.
    this.perches = this.perches.filter((p) => p.until > at);
    let perch = this.perches.length && chance(0.7) ? pick(this.perches) : null;
    if (!perch) {
      perch = { pos: this.scatter(7, 26), species: Math.floor(rand(0, 4)), until: at + rand(15, 40) };
      this.perches.push(perch);
    }
    const v = this.ev(at, 'bird', 1.6, 0.055, perch.pos, 0.35);
    if (!v) return;
    let tt = v.t0;
    switch (perch.species) {
      case 0: {
        // Whistler: 2–4 clear glides.
        const n = Math.floor(rand(2, 5));
        const base = rand(2400, 3600);
        for (let i = 0; i < n; i++) {
          const f = base * pick([1, 1.12, 0.89, 1.26]);
          partial(v, { freq: f, toFreq: f * pick([1.25, 0.8, 1.1]), glideTime: 0.14, t: tt, attack: 0.015, decay: 0.16, peak: 0.8 });
          tt += rand(0.2, 0.3);
        }
        break;
      }
      case 1: {
        // Trill: fast repeated pips, slightly descending.
        const n = Math.floor(rand(8, 14));
        let f = rand(4200, 5200);
        for (let i = 0; i < n; i++) {
          partial(v, { freq: f, toFreq: f * 0.92, glideTime: 0.03, t: tt, attack: 0.004, decay: 0.035, peak: 0.6 });
          tt += 0.055;
          f *= 0.985;
        }
        break;
      }
      case 2: {
        // Warbler: quick varied notes.
        const n = Math.floor(rand(5, 9));
        for (let i = 0; i < n; i++) {
          const f = rand(2800, 5600);
          partial(v, { freq: f, toFreq: f * rand(0.8, 1.3), glideTime: 0.05, t: tt, attack: 0.006, decay: 0.06, peak: 0.55 });
          tt += rand(0.07, 0.11);
        }
        break;
      }
      default: {
        // Dove-ish coo: low, soft, three notes.
        for (const [f, d] of [[520, 0.22], [600, 0.38], [520, 0.25]] as const) {
          partial(v, { freq: f, toFreq: f * 0.93, glideTime: d, t: tt, attack: 0.05, decay: d, peak: 0.7 });
          tt += d + 0.12;
        }
      }
    }
  }

  private gull(at: number): void {
    const pos = this.mix ? { x: this.mix.sources.shore.x + rand(-15, 15), z: this.mix.sources.shore.z + rand(-15, 15) } : this.scatter(20, 40);
    const v = this.ev(at, 'bird', 2, 0.12, pos, 0.4, 80);
    if (!v) return;
    let tt = v.t0;
    const bp = v.add(v.ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 2.5;
    bp.connect(v.input);
    for (let i = 0; i < Math.floor(rand(2, 4)); i++) {
      partial(v, { type: 'sawtooth', freq: rand(1250, 1400), toFreq: rand(800, 950), glideTime: 0.3, t: tt, attack: 0.04, decay: 0.3, peak: 0.8, dest: bp });
      tt += rand(0.35, 0.5);
    }
  }

  private cricketsStep(t: number): void {
    if (t - this.cricketsMovedAt > 30 || this.crickets.length === 0) {
      this.cricketsMovedAt = t;
      this.crickets = Array.from({ length: 3 }, () => ({ pos: this.scatter(5, 18), period: rand(0.75, 1.15), next: t + rand(0, 1), pitch: rand(4300, 4900) }));
    }
    const w = this.w('insects');
    for (const c of this.crickets) {
      while (c.next < t + STEP) {
        if (chance(0.85)) {
          const v = this.ev(c.next, 'insect', 0.15, 0.03 * w, c.pos, 0.15, 30);
          if (v) {
            const o = v.ctx.createOscillator();
            o.frequency.value = c.pitch;
            const env = v.add(v.ctx.createGain());
            const t0 = v.t0;
            env.gain.value = 0; // silent before the envelope starts (sub-sample start would leak one sample at gain 1)
            env.gain.setValueAtTime(0, t0);
            for (let k = 0; k < 3; k++) {
              const s = t0 + k * 0.032;
              env.gain.linearRampToValueAtTime(1, s + 0.004);
              env.gain.linearRampToValueAtTime(0, s + 0.018);
            }
            o.connect(env);
            env.connect(v.input);
            v.src(o, t0, t0 + 0.12);
          }
        }
        c.next += c.period * rand(0.92, 1.08);
      }
    }
  }

  private owl(at: number): void {
    const pos = this.scatter(16, 30);
    const v = this.ev(at, 'amb', 3, 0.07, pos, 0.5, 70);
    if (!v) return;
    const lp = v.add(v.ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.connect(v.input);
    let tt = v.t0;
    const f = rand(360, 400);
    for (const [d, gap] of [[0.45, 0.55], [0.18, 0.08], [0.4, 0]] as const) {
      partial(v, { freq: f, toFreq: f * 0.9, glideTime: d, t: tt, attack: 0.06, hold: d * 0.4, decay: d * 0.6, peak: 0.9, dest: lp });
      tt += d + gap;
    }
  }

  private workshop(at: number, pos: Vec2): void {
    const v = this.ev(at, 'amb', 2, 0.12, pos, 0.25, 40);
    if (!v) return;
    let tt = v.t0;
    const n = Math.floor(rand(3, 6));
    for (let i = 0; i < n; i++) {
      const body = v.add(v.ctx.createBiquadFilter());
      body.type = 'bandpass';
      body.frequency.value = rand(700, 900);
      body.Q.value = 7;
      body.connect(v.input);
      noise(v, this.g.noise('white'), { t: tt, decay: 0.03, peak: 1.4, dest: body });
      partial(v, { type: 'triangle', freq: rand(600, 800), toFreq: 520, glideTime: 0.05, t: tt, attack: 0.001, decay: 0.06, peak: 0.5 });
      tt += rand(0.28, 0.38);
    }
  }

  private clink(at: number, pos: Vec2): void {
    const p = { x: pos.x + rand(-4, 4), z: pos.z + rand(-4, 4) };
    const v = this.ev(at, 'amb', 0.6, 0.05, p, 0.3, 30);
    if (!v) return;
    const f = rand(2600, 3400);
    for (const [r, a] of [[1, 0.6], [1.47, 0.35], [2.09, 0.2]] as const) partial(v, { freq: f * r, t: v.t0, attack: 0.001, decay: rand(0.15, 0.3), peak: a });
  }

  private droplet(at: number, pos: Vec2, gain: number, range: [number, number]): void {
    const p = { x: pos.x + rand(-2, 2), z: pos.z + rand(-2, 2) };
    const v = this.ev(at, 'water', 0.1, gain, p, 0.2, 30);
    if (!v) return;
    const f = rand(range[0], range[1]);
    partial(v, { freq: f, toFreq: f * rand(1.5, 2.2), glideTime: 0.03, t: v.t0, attack: 0.002, decay: 0.04, peak: 1 });
  }

  private twig(at: number): void {
    const v = this.ev(at, 'amb', 0.2, 0.05, this.scatter(6, 18), 0.2, 30);
    if (!v) return;
    for (let i = 0; i < 3; i++) noise(v, this.g.noise('white'), { t: v.t0 + i * rand(0.015, 0.04), decay: 0.012, peak: rand(0.5, 1), filter: 'bandpass', freq: rand(1500, 3500), q: 2 });
  }
}
