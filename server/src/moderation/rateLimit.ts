import { CONFIG, type RateLimitAction, type RateLimitRule } from '@elsewhere/shared';

/** Token bucket per (key, action). Pure and clock-injected for tests. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(
    private readonly rules: Readonly<Record<string, RateLimitRule>> = CONFIG.rateLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one token. Returns 0 if allowed, else ms until a token is available. */
  take(key: string, action: RateLimitAction | string, cost = 1): number {
    const rule = this.rules[action];
    if (!rule) return 0;
    const id = `${key}\u0000${action}`;
    const t = this.now();
    let b = this.buckets.get(id);
    if (!b) this.buckets.set(id, (b = { tokens: rule.capacity, last: t }));
    b.tokens = Math.min(rule.capacity, b.tokens + ((t - b.last) / 1000) * rule.refillPerSecond);
    b.last = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return 0;
    }
    return Math.ceil(((cost - b.tokens) / rule.refillPerSecond) * 1000);
  }

  /** Drop all buckets for a key (on leave). */
  forget(key: string): void {
    const prefix = `${key}\u0000`;
    for (const id of this.buckets.keys()) if (id.startsWith(prefix)) this.buckets.delete(id);
  }
}
