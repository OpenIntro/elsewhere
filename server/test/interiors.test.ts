import { describe, expect, it } from 'vitest';
import { INTERIORS, interiorAt, isWalkable, rotateOffset } from '@elsewhere/shared';
import { resumePosition } from '../src/rooms/WorldRoom.js';

describe('interiors on the server', () => {
  it('a position saved indoors resumes indoors (every interior)', () => {
    for (const it of INTERIORS) {
      const saved = it.anchors.entrance!.position;
      expect(isWalkable(saved), it.id).toBe(true);
      const pos = resumePosition(saved);
      expect(pos, it.id).toEqual(saved);
      expect(interiorAt(pos!)?.id, it.id).toBe(it.id);
    }
  });

  it('a reconnect hint cannot carry you through a wall', () => {
    const cafe = INTERIORS.find((i) => i.id === 'cafe')!;
    // Saved just inside the right wall; the hint is just outside it (within the 3 m hint radius).
    const inside = rotateOffset({ x: cafe.inner.halfWidth - 0.5, z: 0 }, cafe.footprint.yaw);
    const outside = rotateOffset({ x: cafe.footprint.halfWidth + 0.6, z: 0 }, cafe.footprint.yaw);
    const saved = { x: cafe.footprint.center.x + inside.x, z: cafe.footprint.center.z + inside.z };
    const hint = { x: cafe.footprint.center.x + outside.x, z: cafe.footprint.center.z + outside.z };
    expect(isWalkable(saved)).toBe(true);
    expect(isWalkable(hint)).toBe(true);
    expect(Math.hypot(hint.x - saved.x, hint.z - saved.z)).toBeLessThan(3);
    expect(resumePosition(saved, hint)).toEqual(saved);
  });
});
