import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  DEFAULT_APPEARANCE,
  extractMentions,
  parseAppearanceJson,
  phaseForHours,
  randomAppearance,
  randomDisplayName,
  sanitizeAppearance,
  timeOfDayAt,
  validateDisplayName,
  worldTimeAt,
} from '../src/index.js';

describe('appearance', () => {
  it('sanitizes garbage to defaults and keeps valid ids', () => {
    expect(sanitizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    const a = sanitizeAppearance({ body: 'tall', skin: 'nope', accessories: { hat: 'beret', eyewear: 42 } });
    expect(a.body).toBe('tall');
    expect(a.skin).toBe(DEFAULT_APPEARANCE.skin);
    expect(a.accessories.hat).toBe('beret');
    expect(a.accessories.eyewear).toBe('none');
  });
  it('randomAppearance is valid and seedable', () => {
    for (let i = 0; i < 50; i++) {
      const a = randomAppearance(i);
      expect(sanitizeAppearance(a)).toEqual(a);
      expect(randomAppearance(i)).toEqual(a);
    }
  });
  it('parseAppearanceJson never throws', () => {
    expect(parseAppearanceJson('{oops')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearanceJson(JSON.stringify(randomAppearance(3)))).toEqual(randomAppearance(3));
  });
  it('validates display names', () => {
    expect(validateDisplayName('  Mossy   Heron ')).toEqual({ ok: true, name: 'Mossy Heron' });
    expect(validateDisplayName('a')).toEqual({ ok: false, reason: 'too_short' });
    expect(validateDisplayName('x'.repeat(CONFIG.profile.displayNameMax + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateDisplayName('<script>')).toEqual({ ok: false, reason: 'invalid_characters' });
    expect(validateDisplayName('Admin')).toEqual({ ok: false, reason: 'reserved' });
    expect(validateDisplayName('Zoë')).toEqual({ ok: true, name: 'Zoë' });
    expect(validateDisplayName(randomDisplayName(1)).ok).toBe(true);
  });
});

describe('clock', () => {
  const params = { epochMs: 1_000_000, dayLengthMs: 24 * 60_000, startTimeOfDay: 0 };
  it('maps elapsed time to time of day', () => {
    expect(timeOfDayAt(1_000_000, params)).toBe(0);
    expect(timeOfDayAt(1_000_000 + 12 * 60_000, params)).toBeCloseTo(0.5);
    const t = worldTimeAt(1_000_000 + 36 * 60_000, params);
    expect(t.day).toBe(1);
    expect(t.hours).toBeCloseTo(12);
    expect(t.phase).toBe('midday');
  });
  it('phases cover the whole day', () => {
    expect(phaseForHours(3).phase).toBe('night');
    expect(phaseForHours(6).phase).toBe('morning');
    expect(phaseForHours(12).phase).toBe('midday');
    expect(phaseForHours(17).phase).toBe('golden_hour');
    expect(phaseForHours(20).phase).toBe('dusk');
    expect(phaseForHours(23).phase).toBe('night');
    for (let h = 0; h < 24; h += 0.25) {
      const p = phaseForHours(h).progress;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('protocol helpers', () => {
  it('extracts mentions', () => {
    expect(extractMentions('hi @Fern and @"Mossy Heron", also @Mossy_Heron')).toEqual(['fern', 'mossy heron']);
  });
});
