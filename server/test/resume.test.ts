import { describe, expect, it } from 'vitest';
import { isWalkable } from '@elsewhere/shared';
import { resumePosition } from '../src/rooms/WorldRoom.js';

describe('resumePosition (saved position is authoritative; client hint only a nearby tie-breaker)', () => {
  const saved = { x: 4, z: 10 };
  it('uses the saved position and ignores far or invalid hints', () => {
    expect(isWalkable(saved)).toBe(true);
    expect(resumePosition(saved)).toEqual(saved);
    expect(resumePosition(saved, { x: 40, z: 40, rot: 0 })).toEqual(saved);
    expect(resumePosition(saved, { x: Number.NaN, z: 10 })).toEqual(saved);
    expect(resumePosition(saved, 'nope')).toEqual(saved);
  });
  it('accepts a walkable hint within 3 m of the saved spot', () => {
    expect(resumePosition(saved, { x: 5.5, z: 10.5, rot: 1 })).toEqual({ x: 5.5, z: 10.5 });
  });
  it('no saved position → null (caller spawns normally), even with a hint', () => {
    expect(resumePosition(null, { x: 4, z: 10 })).toBeNull();
  });
});
