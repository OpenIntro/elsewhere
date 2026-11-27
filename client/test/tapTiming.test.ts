/**
 * Tap classification uses the pointer events' own timestamps (player/input.ts): a quick tap whose
 * down and up handlers run far apart on a janky frame is still a tap.
 */
import { describe, expect, it } from 'vitest';
import { isTapDuration, pointerEventTime } from '../src/player/input.js';

describe('pointerEventTime / isTapDuration', () => {
  it('prefers the event timeStamp over the handler time', () => {
    expect(pointerEventTime({ timeStamp: 1000 }, 1400)).toBe(1000);
  });
  it('falls back to now when the timeStamp is missing, zero or not in the performance.now() base', () => {
    expect(pointerEventTime({}, 1400)).toBe(1400);
    expect(pointerEventTime({ timeStamp: 0 }, 1400)).toBe(1400);
    expect(pointerEventTime({ timeStamp: Number.NaN }, 1400)).toBe(1400);
    expect(pointerEventTime({ timeStamp: 1.7e12 }, 1400)).toBe(1400); // epoch ms, not page time
  });
  it('a quick tap whose handlers ran 700 ms apart is still a tap; a real long press is not', () => {
    // down at 1000 (handler ran at 1000), up at 1050 (handler ran at 1700, after a long frame)
    expect(isTapDuration(pointerEventTime({ timeStamp: 1000 }, 1000), pointerEventTime({ timeStamp: 1050 }, 1700))).toBe(true);
    // the old handler-time rule would have said 700 ms: not a tap
    expect(isTapDuration(1000, 1700)).toBe(false);
    expect(isTapDuration(1000, 1000 + 800)).toBe(false);
  });
});
