import { describe, expect, it } from 'vitest';
import { BUILDINGS, DECKS, FOUNTAIN, LOCATIONS, PATHS, PORTAL_ARCH, CREEK_POINTS, shoreRadius } from '@elsewhere/shared';
import { surfaceAt, PLAZA_RADIUS } from '../src/audio/surface.js';
import { ambienceMix, AMBIENCE_LAYERS } from '../src/audio/ambienceMix.js';
import { MusicPlanner, planSpan, MOOD_SPECS, degreeToMidi, moodFor, type Mood } from '../src/audio/musicPlan.js';
import { VoiceLimiter } from '../src/audio/voiceLimiter.js';
import { spatialize, screenRight, DEFAULT_CAMERA_YAW, falloff } from '../src/audio/spatial.js';
import { BELL_PARTIALS } from '../src/audio/sfx.js';
import { advanceSteps, stepCadence } from '../src/audio/footsteps.js';

const loc = (id: string) => LOCATIONS.find((l) => l.id === id)!;

describe('surfaceAt', () => {
  it('decks (dock, bridge) are wood', () => {
    for (const d of DECKS) expect(surfaceAt(d.center.x, d.center.z)).toBe('wood');
  });
  it('path ribbons use their surface', () => {
    const map = { cobble: 'stone', gravel: 'gravel', dirt: 'dirt', sand: 'sand', boardwalk: 'wood' } as const;
    for (const p of PATHS) {
      const a = p.points[0]!;
      const b = p.points[1]!;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      // Skip midpoints that happen to sit on a deck.
      if (DECKS.some((d) => Math.hypot(d.center.x - mid.x, d.center.z - mid.z) < 3)) continue;
      expect(surfaceAt(mid.x, mid.z), p.id).toBe(map[p.surface]);
    }
  });
  it('the fountain plaza is stone, the woods floor is leaves, meadows are grass', () => {
    expect(surfaceAt(FOUNTAIN.position.x + PLAZA_RADIUS - 1, FOUNTAIN.position.z)).toBe('stone');
    const w = loc('woods').center;
    expect(surfaceAt(w.x + 3, w.z + 3)).toBe('leaves');
    // Somewhere inland, off paths, away from everything: between the hall and the workshop.
    expect(surfaceAt(22, -26)).toBe('grass');
  });
  it('low land right at the coast is sand', () => {
    // Walk inland from the coast at the waterfront until we are on land.
    const theta = Math.atan2(43, 5);
    const r = shoreRadius(theta) - 2.5;
    const s = surfaceAt(Math.cos(theta) * r, Math.sin(theta) * r);
    expect(['sand', 'stone', 'gravel', 'dirt', 'wood']).toContain(s);
    // Off-path beach west of the waterfront.
    const t2 = Math.atan2(36, -20);
    const r2 = shoreRadius(t2) - 2;
    expect(surfaceAt(Math.cos(t2) * r2, Math.sin(t2) * r2)).toBe('sand');
  });
  it('is total and fast', () => {
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) surfaceAt((i % 160) - 80, Math.floor(i / 160) - 80);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  void BUILDINGS;
});

describe('ambienceMix', () => {
  const at = (id: string, hours: number, portalAwake = false) => {
    const l = loc(id);
    return ambienceMix({ x: l.center.x, z: l.center.z, hours, key: l.ambience, portalAwake });
  };
  it('weights are all within 0..1', () => {
    for (const l of LOCATIONS)
      for (const h of [0, 3, 6, 9, 12, 15, 18, 21])
        for (const k of AMBIENCE_LAYERS) {
          const w = at(l.id, h).weights[k];
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1);
        }
  });
  it('birds by day, insects + owl by night', () => {
    const day = at('woods', 8).weights;
    const night = at('woods', 1).weights;
    expect(day.birds).toBeGreaterThan(0.5);
    expect(night.birds).toBeLessThan(0.05);
    expect(night.insects).toBeGreaterThan(0.4);
    expect(day.insects).toBeLessThan(0.05);
    expect(night.owl).toBeGreaterThan(day.owl);
  });
  it('point sources dominate where they are', () => {
    expect(at('waterfront', 12).weights.shore).toBeGreaterThan(0.8);
    expect(at('town_square', 12).weights.shore).toBeLessThan(0.2);
    expect(at('town_square', 12).weights.fountain).toBe(1);
    expect(at('waterfront', 12).weights.fountain).toBe(0);
    expect(at('cafe', 12).weights.cafe).toBeGreaterThan(0.9);
    expect(at('cafe', 12).weights.cafe).toBeGreaterThan(at('cafe', 2).weights.cafe);
    expect(at('woods', 12).weights.forest).toBeGreaterThan(0.6);
    const c = CREEK_POINTS[2]!;
    expect(ambienceMix({ x: c.x, z: c.z + 2, hours: 12, key: 'forest', portalAwake: false }).weights.creek).toBe(1);
    expect(at('town_square', 12).weights.creek).toBe(0);
  });
  it('portal hum is local and stronger when awake', () => {
    const asleep = ambienceMix({ x: PORTAL_ARCH.position.x, z: PORTAL_ARCH.position.z + 8, hours: 12, key: 'ancient', portalAwake: false }).weights.mystery;
    const awake = ambienceMix({ x: PORTAL_ARCH.position.x, z: PORTAL_ARCH.position.z + 8, hours: 12, key: 'ancient', portalAwake: true }).weights.mystery;
    expect(awake).toBeGreaterThan(asleep);
    expect(asleep).toBeGreaterThan(0.2);
    expect(at('town_square', 12, true).weights.mystery).toBe(0);
  });
  it('source positions are reported for panning', () => {
    const m = at('waterfront', 12);
    expect(Math.hypot(m.sources.shore.x, m.sources.shore.z)).toBeGreaterThan(30);
    expect(m.sources.fountain).toEqual(FOUNTAIN.position);
  });
});

describe('music planner', () => {
  it('is deterministic for a seed', () => {
    const a = planSpan(42, 'day', 600);
    const b = planSpan(42, 'day', 600);
    expect(a).toEqual(b);
    const c = planSpan(43, 'day', 600);
    expect(c).not.toEqual(a);
  });
  it('is deterministic with mood changes', () => {
    const moodAt = (t: number): Mood => (t < 120 ? 'day' : t < 300 ? 'night' : 'mystery');
    expect(planSpan(7, moodAt, 500)).toEqual(planSpan(7, moodAt, 500));
    const blocks = planSpan(7, moodAt, 500);
    expect(blocks.some((b) => b.mood === 'night' && b.kind === 'chord')).toBe(true);
    expect(blocks.some((b) => b.mood === 'mystery' && b.kind === 'chord')).toBe(true);
  });
  it('blocks tile time, chords are slow, and pieces are separated by long rests', () => {
    for (const mood of ['day', 'evening', 'night', 'mystery'] as const) {
      const blocks = planSpan(99, mood, 1800);
      let t = 0;
      for (const b of blocks) {
        expect(b.start).toBeCloseTo(t, 6);
        t += b.dur;
        if (b.kind === 'chord') {
          expect(b.dur).toBeGreaterThanOrEqual(MOOD_SPECS[mood].chordSec[0]);
          expect(b.chord.length).toBeGreaterThanOrEqual(3);
          for (const e of b.events) {
            expect(e.t).toBeGreaterThanOrEqual(b.start);
            expect(e.t).toBeLessThan(b.start + b.dur);
            expect(e.midi).toBeGreaterThanOrEqual(30);
            expect(e.midi).toBeLessThanOrEqual(100);
            expect(e.vel).toBeGreaterThan(0);
            expect(e.vel).toBeLessThanOrEqual(1);
          }
        }
      }
      const rests = blocks.filter((b) => b.kind === 'rest' && b.dur >= MOOD_SPECS[mood].restSec[0]);
      expect(rests.length, mood).toBeGreaterThan(0);
      const restTime = blocks.filter((b) => b.kind === 'rest').reduce((s, b) => s + b.dur, 0);
      // Never fatiguing: a meaningful share of the time is silence.
      expect(restTime / t, mood).toBeGreaterThan(0.12);
    }
  });
  it('every pitched note stays in the piece scale (no random beeps)', () => {
    for (const mood of ['day', 'evening', 'night', 'mystery'] as const) {
      const p = new MusicPlanner(5);
      let chords = 0;
      let melody = 0;
      for (let i = 0; i < 80; i++) {
        const b = p.next(mood, i * 10);
        if (b.kind !== 'chord') continue;
        chords++;
        const pcs = new Set(b.scale.map((s) => (b.tonic + s) % 12));
        for (const m of b.chord) expect(pcs.has(m % 12)).toBe(true);
        for (const e of b.events) {
          expect(pcs.has(e.midi % 12), `${mood} ${e.voice} ${e.midi}`).toBe(true);
          if (e.voice !== 'pad' && e.voice !== 'bass') melody++;
        }
      }
      expect(chords).toBeGreaterThan(10);
      expect(melody).toBeGreaterThan(5);
    }
  });
  it('degreeToMidi wraps octaves', () => {
    const ionian = [0, 2, 4, 5, 7, 9, 11];
    expect(degreeToMidi(60, ionian, 0)).toBe(60);
    expect(degreeToMidi(60, ionian, 7)).toBe(72);
    expect(degreeToMidi(60, ionian, -1)).toBe(59);
  });
  it('moodFor follows time of day and The Unknown', () => {
    expect(moodFor(9, 100)).toBe('day');
    expect(moodFor(18, 100)).toBe('evening');
    expect(moodFor(23, 100)).toBe('night');
    expect(moodFor(3, 100)).toBe('night');
    expect(moodFor(12, 10)).toBe('mystery');
  });
});

describe('VoiceLimiter', () => {
  it('caps per category by stealing the oldest', () => {
    const stolen: number[] = [];
    const l = new VoiceLimiter({ maxVoices: 10, perCategory: { step: 2 } });
    const a = l.acquire('step', 1, 0, 1, () => stolen.push(1))!;
    l.acquire('step', 1, 0.1, 1, () => stolen.push(2));
    l.acquire('step', 1, 0.2, 1, () => stolen.push(3));
    expect(stolen).toEqual([1]);
    expect(l.activeIn('step')).toBe(2);
    expect(a).toBeTruthy();
  });
  it('rejects low priority when full of higher priority, steals lower priority', () => {
    const l = new VoiceLimiter({ maxVoices: 2 });
    l.acquire('bell', 3, 0, 10);
    l.acquire('bell', 3, 0, 10);
    expect(l.acquire('ui', 0, 0.1, 1)).toBeNull();
    expect(l.rejected).toBe(1);
    const l2 = new VoiceLimiter({ maxVoices: 2 });
    let stolen = 0;
    l2.acquire('amb', 0, 0, 10, () => stolen++);
    l2.acquire('bell', 3, 0, 10);
    expect(l2.acquire('bell', 3, 0.1, 10)).not.toBeNull();
    expect(stolen).toBe(1);
  });
  it('expired voices free their slot; a flood stays bounded', () => {
    const l = new VoiceLimiter({ maxVoices: 8, perCategory: { x: 4 } });
    for (let i = 0; i < 1000; i++) {
      l.acquire('x', 1, i * 0.01, i * 0.01 + 0.5);
      expect(l.active()).toBeLessThanOrEqual(4);
    }
    expect(l.active(1000)).toBe(0);
  });
});

describe('spatialize', () => {
  it('attenuates with distance and is silent beyond max', () => {
    const near = spatialize({ x: 0, z: 0 }, { x: 2, z: 0 });
    const mid = spatialize({ x: 0, z: 0 }, { x: 15, z: 0 });
    const far = spatialize({ x: 0, z: 0 }, { x: 100, z: 0 });
    expect(near.gain).toBe(1);
    expect(mid.gain).toBeLessThan(near.gain);
    expect(mid.gain).toBeGreaterThan(0);
    expect(far.gain).toBe(0);
  });
  it('pans relative to the camera: screen right is world (+X, -Z) at the default yaw', () => {
    const r = screenRight(DEFAULT_CAMERA_YAW);
    expect(r.x).toBeCloseTo(Math.SQRT1_2);
    expect(r.z).toBeCloseTo(-Math.SQRT1_2);
    expect(spatialize({ x: 0, z: 0 }, { x: 10, z: -10 }).pan).toBeGreaterThan(0.7);
    expect(spatialize({ x: 0, z: 0 }, { x: -10, z: 10 }).pan).toBeLessThan(-0.7);
    // Straight "into" the screen: centred.
    expect(Math.abs(spatialize({ x: 0, z: 0 }, { x: -10, z: -10 }).pan)).toBeLessThan(1e-9);
    // Rotate the camera 180°: left and right swap.
    expect(spatialize({ x: 0, z: 0 }, { x: 10, z: -10 }, DEFAULT_CAMERA_YAW + Math.PI).pan).toBeLessThan(-0.7);
  });
  it('falloff is smooth and bounded', () => {
    expect(falloff(0, 2, 10)).toBe(1);
    expect(falloff(6, 2, 10)).toBeCloseTo(0.5);
    expect(falloff(12, 2, 10)).toBe(0);
  });
});

describe('bell + footsteps data', () => {
  it('bell partials are inharmonic (minor-third tierce, non-integer upper partials)', () => {
    const ratios = BELL_PARTIALS.map(([r]) => r);
    expect(ratios).toContain(1.183);
    const nonInteger = ratios.filter((r) => Math.abs(r * 2 - Math.round(r * 2)) > 0.02);
    expect(nonInteger.length).toBeGreaterThanOrEqual(4);
  });
  it('advanceSteps: walking produces ~cadence steps/s, standing and teleports produce none', () => {
    const tr = { x: 0, z: 0, phase: 0, init: false };
    let steps = 0;
    const dt = 1 / 60;
    advanceSteps(tr, 0, 0, dt);
    for (let i = 1; i <= 600; i++) if (advanceSteps(tr, i * dt * 3.2, 0, dt)) steps++;
    expect(steps).toBeGreaterThan(10 * stepCadence(3.2) - 2);
    expect(steps).toBeLessThan(10 * stepCadence(3.2) + 2);
    let still = 0;
    for (let i = 0; i < 120; i++) if (advanceSteps(tr, tr.x, 0, dt)) still++;
    expect(still).toBe(0);
    expect(advanceSteps(tr, tr.x + 50, 0, dt)).toBe(false);
  });
  it('cadence rises with speed and stays human', () => {
    expect(stepCadence(3.2)).toBeGreaterThan(2);
    expect(stepCadence(6)).toBeGreaterThan(stepCadence(3.2));
    expect(stepCadence(20)).toBeLessThanOrEqual(3.2);
  });
});
