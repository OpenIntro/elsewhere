import { describe, expect, it } from 'vitest';
import { Bone } from 'three';
import {
  ACCESSORY_CATALOG,
  APPEARANCE_CATALOG,
  DEFAULT_APPEARANCE,
  ITEMS,
  parseAppearanceJson,
  randomAppearance,
  sanitizeAppearance,
  type Appearance,
} from '@elsewhere/shared';
import { RENDER_MAPPING, buildCharacter } from '../src/characters/build.js';
import { Animator } from '../src/characters/animation.js';
import { heldGeometry, HELD_BUILDERS } from '../src/characters/held.js';
import { BONE_COUNT, B, layoutFor } from '../src/characters/rig.js';

const BUILDER_SLOTS = ['body', 'hairStyle', 'face', 'shirtStyle', 'pantsStyle', 'shoeStyle'] as const;
const COLOR_SLOTS = ['skin', 'hairColor', 'shirtColor', 'pantsColor', 'shoeColor'] as const;

function triangles(a: Appearance) {
  const b = buildCharacter(a);
  return { b, tris: b.geometry.getIndex()!.count / 3 };
}

function assertSane(a: Appearance) {
  const { b, tris } = triangles(a);
  const pos = b.geometry.getAttribute('position');
  expect(pos.count).toBeGreaterThan(500);
  let finite = true;
  for (let i = 0; i < pos.count; i++) finite &&= Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i));
  expect(finite).toBe(true);
  const si = b.geometry.getAttribute('skinIndex');
  let maxBone = 0;
  for (let i = 0; i < si.count; i++) maxBone = Math.max(maxBone, si.getX(i));
  expect(maxBone).toBeLessThan(BONE_COUNT);
  // Budget: one draw call per character; keep triangles modest for crowds.
  expect(tris).toBeLessThan(20000);
  return b;
}

describe('character renderer mapping', () => {
  it('maps every catalog option id of every builder slot', () => {
    for (const slot of BUILDER_SLOTS) {
      const mapping = RENDER_MAPPING[slot] as Record<string, unknown>;
      for (const o of APPEARANCE_CATALOG[slot]) expect(mapping, `${slot}:${o.id}`).toHaveProperty(o.id);
    }
    for (const slot of Object.keys(ACCESSORY_CATALOG) as (keyof typeof ACCESSORY_CATALOG)[]) {
      const mapping = RENDER_MAPPING[slot] as Record<string, unknown>;
      for (const o of ACCESSORY_CATALOG[slot]) expect(mapping, `${slot}:${o.id}`).toHaveProperty(o.id);
    }
    // Shirt colours also need an accessory accent.
    for (const o of APPEARANCE_CATALOG.shirtColor) expect(RENDER_MAPPING.shirtColor).toHaveProperty(o.id);
  });

  it('builds every option of every slot (and every colour) into valid geometry', () => {
    const base = DEFAULT_APPEARANCE;
    for (const slot of [...BUILDER_SLOTS, ...COLOR_SLOTS]) {
      for (const o of APPEARANCE_CATALOG[slot]) assertSane({ ...base, [slot]: o.id } as Appearance);
    }
    for (const slot of Object.keys(ACCESSORY_CATALOG) as (keyof typeof ACCESSORY_CATALOG)[]) {
      for (const o of ACCESSORY_CATALOG[slot]) {
        assertSane({ ...base, accessories: { ...base.accessories, [slot]: o.id } });
        // hats must also coexist with every hair style
        if (slot === 'hat') for (const h of APPEARANCE_CATALOG.hairStyle) assertSane({ ...base, hairStyle: h.id, accessories: { ...base.accessories, hat: o.id } });
      }
    }
  }, 120_000);

  it('each slot option visibly changes the geometry or colours', () => {
    const sig = (a: Appearance) => {
      const g = buildCharacter(a).geometry;
      const p = g.getAttribute('position');
      const c = g.getAttribute('color');
      let s = p.count;
      for (let i = 0; i < p.count; i += 7) s += p.getX(i) * 3.1 + p.getY(i) * 1.7 + p.getZ(i) * 2.3 + c.getX(i) + c.getY(i) * 2 + c.getZ(i) * 3;
      return s.toFixed(4);
    };
    const base: Appearance = { ...DEFAULT_APPEARANCE, hairStyle: 'buzz' };
    for (const slot of [...BUILDER_SLOTS, ...COLOR_SLOTS]) {
      const sigs = new Set(APPEARANCE_CATALOG[slot].map((o) => sig({ ...base, [slot]: o.id } as Appearance)));
      expect(sigs.size, slot).toBe(APPEARANCE_CATALOG[slot].length);
    }
    for (const slot of Object.keys(ACCESSORY_CATALOG) as (keyof typeof ACCESSORY_CATALOG)[]) {
      const sigs = new Set(ACCESSORY_CATALOG[slot].map((o) => sig({ ...base, accessories: { ...base.accessories, [slot]: o.id } })));
      expect(sigs.size, slot).toBe(ACCESSORY_CATALOG[slot].length);
    }
  }, 120_000);

  it('falls back gracefully for unknown ids', () => {
    const weird = { ...DEFAULT_APPEARANCE, body: 'giant', hairStyle: 'beehive', face: 'cyclops', shirtStyle: 'cape', pantsStyle: 'kilt', shoeStyle: 'skates', skin: 'blue', accessories: { hat: 'crown', eyewear: 'x', neck: 'y', back: 'z' } } as unknown as Appearance;
    expect(() => assertSane(weird)).not.toThrow();
    expect(() => assertSane({ ...DEFAULT_APPEARANCE, accessories: undefined } as unknown as Appearance)).not.toThrow();
  });

  it('sanitize/random still produce valid appearances with the extended catalogs', () => {
    for (let i = 0; i < 300; i++) {
      const a = randomAppearance(i);
      expect(sanitizeAppearance(a)).toEqual(a);
      expect(parseAppearanceJson(JSON.stringify(a))).toEqual(a);
    }
    for (const slot of BUILDER_SLOTS) for (const o of APPEARANCE_CATALOG[slot]) expect(sanitizeAppearance({ [slot]: o.id })[slot]).toBe(o.id);
    for (const slot of Object.keys(ACCESSORY_CATALOG) as (keyof typeof ACCESSORY_CATALOG)[])
      for (const o of ACCESSORY_CATALOG[slot]) expect(sanitizeAppearance({ accessories: { [slot]: o.id } }).accessories[slot]).toBe(o.id);
    expect(sanitizeAppearance({ hairStyle: 'beehive' }).hairStyle).toBe(DEFAULT_APPEARANCE.hairStyle);
  });

  it('builds a held prop for every item id and a parcel for unknown ones', () => {
    for (const id of Object.keys(ITEMS)) {
      expect(HELD_BUILDERS).toHaveProperty(id);
      expect(heldGeometry(id).getAttribute('position').count).toBeGreaterThan(20);
    }
    expect(heldGeometry('mystery_box')).toBe(heldGeometry('parcel'));
  });
});

describe('character animation', () => {
  const L = layoutFor('round');
  const bones = Array.from({ length: BONE_COUNT }, () => new Bone());
  const run = (an: Animator, seconds: number, inp: Parameters<Animator['update']>[1]) => {
    for (let t = 0; t < seconds; t += 1 / 60) an.update(1 / 60, inp, L);
  };
  const base = { animSeq: 0, sitStyle: 'seat' as const, holding: false };

  it('cross-fades smoothly (no single-frame pops) across every state change', () => {
    const an = new Animator(0.3);
    const series: number[][] = [];
    const tracked = [B.root, B.hips, B.spine, B.head, B.shoulderL, B.shoulderR, B.elbowL, B.elbowR, B.hipL, B.hipR, B.kneeL, B.kneeR];
    for (const anim of ['idle', 'walk', 'run', 'idle', 'sit', 'idle', 'wave', 'dance', 'interact', 'walk', 'idle'] as const) {
      for (let f = 0; f < 90; f++) {
        an.update(1 / 60, { ...base, anim, animSeq: anim === 'wave' || anim === 'interact' ? 1 : 0 }, L);
        an.apply(bones, L.rest);
        series.push(tracked.flatMap((b) => [bones[b]!.rotation.x, bones[b]!.rotation.y, bones[b]!.rotation.z, bones[b]!.position.x * 4, bones[b]!.position.y * 4, bones[b]!.scale.y * 4]));
      }
    }
    // A pop = a one-frame jump much larger than the motion on the frames around it.
    let worstSpike = 0;
    let worstStep = 0;
    for (let t = 2; t < series.length - 1; t++) {
      for (let i = 0; i < series[t]!.length; i++) {
        const d = (k: number) => Math.abs(series[k]![i]! - series[k - 1]![i]!);
        worstStep = Math.max(worstStep, d(t));
        worstSpike = Math.max(worstSpike, d(t) - Math.max(d(t - 1), d(t + 1)));
      }
    }
    expect(worstSpike).toBeLessThan(0.05);
    // Fastest joint (running knee) stays below ~0.4 rad per 60 fps frame.
    expect(worstStep).toBeLessThan(0.4);
  });

  it('one-shots retrigger on animSeq and return to the base state', () => {
    const an = new Animator(0.1);
    run(an, 1, { ...base, anim: 'idle' });
    run(an, 0.5, { ...base, anim: 'wave', animSeq: 1 });
    expect(an.state.oneShot).toBe('wave');
    expect(an.state.oneShotW).toBeGreaterThan(0.8);
    run(an, 2.5, { ...base, anim: 'wave', animSeq: 1 });
    expect(an.state.oneShot).toBeNull();
    expect(an.state.oneShotW).toBeLessThan(0.05);
    expect(an.state.weights.idle).toBeGreaterThan(0.95);
    // same anim, new seq → plays again
    run(an, 0.3, { ...base, anim: 'wave', animSeq: 2 });
    expect(an.state.oneShot).toBe('wave');
    // interact too
    run(an, 0.3, { ...base, anim: 'interact', animSeq: 3 });
    expect(an.state.oneShot).toBe('interact');
    expect(an.state.focus).toBeGreaterThan(0.3);
    // waving while seated returns to sitting
    const s = new Animator(0.2);
    run(s, 1, { ...base, anim: 'sit' });
    run(s, 3, { ...base, anim: 'wave', animSeq: 5 });
    expect(s.state.weights.sit).toBeGreaterThan(0.9);
  });

  it('is happy while dancing and desynchronised between instances', () => {
    const a = new Animator(0.1);
    const b = new Animator(0.7);
    run(a, 1.5, { ...base, anim: 'dance' });
    expect(a.state.happy).toBeGreaterThan(0.8);
    const ba = Array.from({ length: BONE_COUNT }, () => new Bone());
    const bb = Array.from({ length: BONE_COUNT }, () => new Bone());
    const ia = new Animator(0.1);
    const ib = new Animator(0.7);
    run(ia, 2, { ...base, anim: 'idle' });
    run(ib, 2, { ...base, anim: 'idle' });
    ia.apply(ba, L.rest);
    ib.apply(bb, L.rest);
    expect(Math.abs(ba[B.hips]!.position.x - bb[B.hips]!.position.x) + Math.abs(ba[B.spine]!.scale.y - bb[B.spine]!.scale.y)).toBeGreaterThan(1e-4);
  });
});
