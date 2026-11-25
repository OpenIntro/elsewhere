/**
 * Client-side token buckets mirroring the server's CONFIG.rateLimits so the
 * client never provokes S2C.rateLimited in normal use (and a stuck key or
 * buggy UI can't flood the socket). Refill is slightly slower than the
 * server's to absorb network jitter.
 */
import { C2S, CONFIG, type C2SType, type RateLimitRule } from '@elsewhere/shared';

/** Which server bucket each message type draws from (null = unlimited on the client). */
const ACTION_FOR: Record<C2SType, string | null> = {
  [C2S.move]: 'move',
  [C2S.stand]: 'stand',
  [C2S.emote]: 'emote',
  [C2S.reaction]: 'reaction',
  [C2S.chat]: 'chat',
  [C2S.whisper]: 'whisper',
  [C2S.typing]: 'typing',
  [C2S.interact]: 'interact',
  [C2S.dropItem]: 'interact',
  [C2S.mailSend]: 'mail',
  [C2S.mailRead]: 'mailRead',
  [C2S.updateProfile]: 'appearance',
  [C2S.block]: 'social',
  [C2S.unblock]: 'social',
  [C2S.mute]: 'social',
  [C2S.unmute]: 'social',
  [C2S.report]: 'report',
};

interface Bucket {
  tokens: number;
  at: number;
  rule: RateLimitRule;
}

export class ClientRateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly refillFactor = 0.9,
  ) {}

  private bucket(action: string): Bucket | null {
    let b = this.buckets.get(action);
    if (b) return b;
    const rule = (CONFIG.rateLimits as Record<string, RateLimitRule | undefined>)[action];
    if (!rule) return null;
    b = { tokens: rule.capacity, at: this.now(), rule };
    this.buckets.set(action, b);
    return b;
  }

  /** Try to spend one token for `type`. Returns 0 if allowed, else ms until a token is available. */
  take(type: C2SType): number {
    const action = ACTION_FOR[type];
    if (!action) return 0;
    const b = this.bucket(action);
    if (!b) return 0;
    const now = this.now();
    const rate = b.rule.refillPerSecond * this.refillFactor;
    b.tokens = Math.min(b.rule.capacity, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - b.tokens) / rate) * 1000);
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function rateLimitActionFor(type: C2SType): string | null {
  return ACTION_FOR[type];
}
