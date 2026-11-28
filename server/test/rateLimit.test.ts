import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/moderation/rateLimit.js';

describe('RateLimiter', () => {
  it('allows a burst up to capacity then reports wait time, refilling over time', () => {
    let now = 0;
    const rl = new RateLimiter({ chat: { capacity: 2, refillPerSecond: 1 } }, () => now);
    expect(rl.take('s1', 'chat')).toBe(0);
    expect(rl.take('s1', 'chat')).toBe(0);
    const wait = rl.take('s1', 'chat');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
    expect(rl.take('s2', 'chat')).toBe(0); // independent keys
    now += 1000;
    expect(rl.take('s1', 'chat')).toBe(0);
    rl.forget('s1');
    expect(rl.take('s1', 'chat')).toBe(0);
    expect(rl.take('s1', 'unknown_action')).toBe(0);
  });
});
