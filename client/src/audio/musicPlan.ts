/**
 * Generative music PLANNER — pure and deterministic for a seed (unit-tested).
 * It decides WHAT plays (chords, voicings, motifs, rests); musicPlayer.ts turns
 * the plan into Web Audio nodes.
 *
 * Structure: a "piece" is 4–8 slow chords from a mood-specific progression,
 * a pad underneath, a soft bass, and a short melodic motif that recurs (with
 * call/answer variation) over the chords so it sounds composed rather than
 * random. Between pieces there is a long rest (silence) so it never fatigues.
 * Mood changes take effect at the next chord: the current piece is cut short
 * with a brief rest and a new piece starts in the new colour.
 *
 * TEMPORARY placeholder music: procedural by design, tuned blind (no listening).
 */
import { mulberry32 } from '@elsewhere/shared';

export type Mood = 'day' | 'evening' | 'night' | 'mystery';
export const MOODS: readonly Mood[] = ['day', 'evening', 'night', 'mystery'];
export type MusicVoice = 'pad' | 'bass' | 'pluck' | 'musicbox' | 'glass' | 'chime';

export interface NoteEvent {
  /** Seconds from the planner's time origin. */
  t: number;
  dur: number;
  midi: number;
  voice: MusicVoice;
  /** 0..1 */
  vel: number;
}

export interface MusicBlock {
  kind: 'chord' | 'rest';
  start: number;
  dur: number;
  mood: Mood;
  /** Piece counter (increments per piece). */
  piece: number;
  /** Chord tones (midi) — empty for rests. */
  chord: number[];
  /** Piece tonic (midi) and scale (semitone offsets) — informative; rests carry the last ones. */
  tonic: number;
  scale: readonly number[];
  events: NoteEvent[];
}

const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  lydianAug: [0, 2, 4, 6, 8, 9, 11],
} as const;
type ScaleName = keyof typeof SCALES;

interface MoodSpec {
  scales: ScaleName[];
  /** Tonic midi notes (octave 3). */
  tonics: number[];
  /** Root scale degrees (0-based) of progressions. */
  progressions: number[][];
  chordSec: [number, number];
  chordsPerPiece: [number, number];
  restSec: [number, number];
  beat: number;
  melodyProb: number;
  melodyVoices: MusicVoice[];
  /** Melody register: octaves above the tonic (keeps melody in the piece's key). */
  melodyOctaves: number;
  ornamentProb: number;
  bassProb: number;
  /** Chance of adding a 7th / 9th to a chord. */
  colourProb: number;
  quartal: boolean;
  padVel: number;
}

export const MOOD_SPECS: Record<Mood, MoodSpec> = {
  day: {
    scales: ['ionian', 'lydian'],
    tonics: [50, 53, 55, 48], // D F G C
    progressions: [
      [0, 4, 5, 3],
      [0, 2, 3, 4],
      [3, 0, 5, 4],
      [0, 5, 3, 4],
      [3, 4, 2, 5],
    ],
    chordSec: [7, 9.5],
    chordsPerPiece: [6, 8],
    restSec: [24, 50],
    beat: 0.52,
    melodyProb: 0.75,
    melodyVoices: ['musicbox', 'pluck'],
    melodyOctaves: 3,
    ornamentProb: 0.3,
    bassProb: 0.8,
    colourProb: 0.6,
    quartal: false,
    padVel: 0.55,
  },
  evening: {
    scales: ['mixolydian', 'ionian'],
    tonics: [52, 50, 55], // E D G
    progressions: [
      [0, 3, 6, 3],
      [3, 0, 4, 5],
      [0, 5, 3, 6],
    ],
    chordSec: [8.5, 11],
    chordsPerPiece: [5, 7],
    restSec: [30, 60],
    beat: 0.62,
    melodyProb: 0.6,
    melodyVoices: ['pluck', 'glass'],
    melodyOctaves: 2,
    ornamentProb: 0.15,
    bassProb: 0.7,
    colourProb: 0.75,
    quartal: false,
    padVel: 0.5,
  },
  night: {
    scales: ['dorian', 'aeolian'],
    tonics: [45, 50, 52], // A D E
    progressions: [
      [0, 5, 2, 6],
      [0, 3, 5, 4],
      [0, 6, 5, 3],
      [5, 3, 0, 6],
    ],
    chordSec: [10, 13],
    chordsPerPiece: [4, 6],
    restSec: [40, 80],
    beat: 0.8,
    melodyProb: 0.4,
    melodyVoices: ['glass', 'musicbox'],
    melodyOctaves: 2,
    ornamentProb: 0.06,
    bassProb: 0.55,
    colourProb: 0.85,
    quartal: false,
    padVel: 0.45,
  },
  mystery: {
    scales: ['lydianAug', 'dorian'],
    tonics: [46, 49], // Bb C#
    progressions: [
      [0, 1, 0, 5],
      [0, 3, 1, 0],
    ],
    chordSec: [11, 14],
    chordsPerPiece: [4, 6],
    restSec: [30, 60],
    beat: 0.9,
    melodyProb: 0.55,
    melodyVoices: ['chime', 'glass'],
    melodyOctaves: 3,
    ornamentProb: 0,
    bassProb: 0.9,
    colourProb: 0.5,
    quartal: true,
    padVel: 0.42,
  },
};

export function degreeToMidi(tonic: number, scale: readonly number[], degree: number): number {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return tonic + 12 * oct + scale[idx]!;
}

interface Motif {
  /** Relative scale steps from the anchor. */
  steps: number[];
  /** Durations in beats. */
  beats: number[];
}

interface PieceState {
  mood: Mood;
  tonic: number;
  scale: readonly number[];
  progression: number[];
  chordsLeft: number;
  chordIndex: number;
  motif: Motif;
  lastMelodyDegree: number;
}

export interface MusicPlannerOptions {
  /** Start with a rest block instead of music (realtime start). Default false. */
  startWithRest?: boolean;
}

export class MusicPlanner {
  private rnd: () => number;
  private piece: PieceState | null = null;
  private pieceCount = 0;
  private pendingRest: boolean;
  /** The opening rest (realtime start) is short; rests between pieces are long. */
  private firstRest = true;

  constructor(seed: number, opts: MusicPlannerOptions = {}) {
    this.rnd = mulberry32(seed);
    this.pendingRest = opts.startWithRest ?? false;
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }
  private int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rnd() * arr.length)]!;
  }

  /** Produce the next block starting at `start`, in `mood`. */
  next(mood: Mood, start: number): MusicBlock {
    const spec = MOOD_SPECS[mood];
    if (this.piece && this.piece.mood !== mood) {
      // Mood changed mid-piece: let it breathe briefly, then start fresh.
      this.piece = null;
      return this.rest(mood, start, this.range(6, 12));
    }
    if (this.pendingRest) {
      this.pendingRest = false;
      const scale = this.firstRest ? 0.25 : 1;
      this.firstRest = false;
      return this.rest(mood, start, this.range(spec.restSec[0], spec.restSec[1]) * scale);
    }
    this.firstRest = false;
    if (!this.piece) this.piece = this.newPiece(mood);
    const block = this.chord(this.piece, start);
    this.piece.chordsLeft--;
    this.piece.chordIndex++;
    if (this.piece.chordsLeft <= 0) {
      this.piece = null;
      this.pendingRest = true;
    }
    return block;
  }

  private rest(mood: Mood, start: number, dur: number): MusicBlock {
    return { kind: 'rest', start, dur, mood, piece: this.pieceCount, chord: [], events: [], tonic: 0, scale: [] };
  }

  private newPiece(mood: Mood): PieceState {
    const spec = MOOD_SPECS[mood];
    this.pieceCount++;
    const len = this.int(3, 5);
    const steps: number[] = [0];
    const contour = [1, -1, 2, -2, 1, 3, -1, 0, -3];
    for (let i = 1; i < len; i++) steps.push(steps[i - 1]! + this.pick(contour));
    const beatChoices = mood === 'day' ? [1, 1, 1, 2, 2, 3] : [1, 2, 2, 3, 4];
    const beats = steps.map(() => this.pick(beatChoices));
    beats[beats.length - 1] = Math.max(beats[beats.length - 1]!, 3); // phrases end on a long note
    return {
      mood,
      tonic: this.pick(spec.tonics),
      scale: SCALES[this.pick(spec.scales)],
      progression: this.pick(spec.progressions),
      chordsLeft: this.int(spec.chordsPerPiece[0], spec.chordsPerPiece[1]),
      chordIndex: 0,
      motif: { steps, beats },
      lastMelodyDegree: 7 + this.int(0, 4),
    };
  }

  private chord(ps: PieceState, start: number): MusicBlock {
    const spec = MOOD_SPECS[ps.mood];
    const dur = this.range(spec.chordSec[0], spec.chordSec[1]);
    const root = ps.progression[ps.chordIndex % ps.progression.length]!;
    const n = ps.scale.length;
    const stack = spec.quartal ? [0, 3, 6] : [0, 2, 4];
    if (this.rnd() < spec.colourProb) stack.push(this.rnd() < 0.55 ? 6 : 8); // 7th or add9
    // Pad voicing: fold each chord tone into a warm window above the tonic.
    const lo = ps.tonic + 7;
    const chord = [...new Set(stack.map((s) => {
      let m = degreeToMidi(ps.tonic, ps.scale, root + s);
      while (m < lo) m += 12;
      while (m >= lo + 14) m -= 12;
      return m;
    }))].sort((a, b) => a - b);
    const events: NoteEvent[] = [];
    const overlap = 3.5;
    for (const m of chord) events.push({ t: start + this.range(0, 0.35), dur: dur + overlap, midi: m, voice: 'pad', vel: spec.padVel * this.range(0.85, 1) });
    if (this.rnd() < spec.bassProb) {
      let b = degreeToMidi(ps.tonic, ps.scale, root) - 12;
      while (b > 50) b -= 12;
      while (b < 36) b += 12;
      events.push({ t: start, dur: dur + 1.5, midi: b, voice: 'bass', vel: 0.6 });
    }

    // Melody: the piece's motif (odd chords answer with inverted contour), anchored to a chord tone near the last phrase.
    if (this.rnd() < spec.melodyProb) {
      const voice = this.pick(spec.melodyVoices);
      const answer = ps.chordIndex % 2 === 1;
      const chordDegrees = stack.map((s) => root + s);
      // Anchor: chord-tone degree (in melody octave) nearest the previous ending.
      let anchor = chordDegrees[0]! + n;
      let best = Infinity;
      for (const cd of chordDegrees) for (const o of [0, n, 2 * n]) {
        const dd = Math.abs(cd + o - ps.lastMelodyDegree);
        if (dd < best) {
          best = dd;
          anchor = cd + o;
        }
      }
      const steps = ps.motif.steps.map((s) => (answer ? -s : s));
      if (this.rnd() < 0.35) {
        const i = this.int(1, Math.max(1, steps.length - 1));
        steps[i] = steps[i]! + (this.rnd() < 0.5 ? 1 : -1);
      }
      let t = start + spec.beat * this.int(1, 3);
      const end = start + dur - 0.8;
      const melodyBase = ps.tonic + 12 * (spec.melodyOctaves - 1);
      for (let i = 0; i < steps.length; i++) {
        const beats = ps.motif.beats[i]!;
        if (t > end) break;
        const deg = anchor + steps[i]!;
        let midi = degreeToMidi(melodyBase, ps.scale, deg - n);
        // Keep the melody in its register (fold by octaves — stays in key).
        while (midi > melodyBase + 19) midi -= 12;
        while (midi < melodyBase) midi += 12;
        const noteDur = Math.min(beats * spec.beat * 1.6, end + 0.8 - t);
        events.push({ t, dur: Math.max(0.25, noteDur), midi, voice, vel: this.range(0.55, 0.85) * (i === 0 ? 1 : 0.9) });
        ps.lastMelodyDegree = Math.max(n, Math.min(2 * n + 3, deg));
        t += beats * spec.beat * this.range(0.97, 1.03);
        // Sparse: occasionally leave a breath inside the phrase.
        if (this.rnd() < 0.12) t += spec.beat;
      }
    }
    // Whimsy: a quick rising music-box flourish of chord tones.
    if (this.rnd() < spec.ornamentProb) {
      let t = start + this.range(dur * 0.45, dur * 0.75);
      const top = ps.tonic + 12 * (spec.melodyOctaves - 1) + 5;
      const tones = chord.map((m) => {
        let x = m;
        while (x < top) x += 12;
        return x;
      }).sort((a, b) => a - b).slice(0, 3);
      for (const m of tones) {
        events.push({ t, dur: 0.9, midi: m, voice: 'musicbox', vel: 0.4 });
        t += 0.12;
      }
    }
    events.sort((a, b) => a.t - b.t);
    return { kind: 'chord', start, dur, mood: ps.mood, piece: this.pieceCount, chord, events, tonic: ps.tonic, scale: ps.scale };
  }
}

/** Plan everything that starts within [0, duration). Handy for offline renders/tests. */
export function planSpan(seed: number, mood: Mood | ((t: number) => Mood), duration: number, opts: MusicPlannerOptions = {}): MusicBlock[] {
  const planner = new MusicPlanner(seed, opts);
  const blocks: MusicBlock[] = [];
  let t = 0;
  while (t < duration) {
    const b = planner.next(typeof mood === 'function' ? mood(t) : mood, t);
    blocks.push(b);
    t += b.dur;
  }
  return blocks;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Music mood from world hour and listener's distance to The Unknown. */
export function moodFor(hours: number, distanceToUnknown: number): Mood {
  if (distanceToUnknown < 26) return 'mystery';
  const h = ((hours % 24) + 24) % 24;
  if (h >= 6 && h < 16.5) return 'day';
  if (h >= 16.5 && h < 21) return 'evening';
  return 'night';
}
