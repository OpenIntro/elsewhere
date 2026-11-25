/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Block / mute / report, text filtering and rate limiting. Blocks are
 * server-enforced (blocked players' whispers and proximity chat are not
 * delivered; they cannot target you with reactions). Mutes are delivery
 * filters too, but only one-directional and silent.
 *
 * Foundation stub: rate limiting is real (RateLimiter); block/mute/report reply
 * `not_implemented`; filterText is identity.
 */
import type { ReportPayload, TargetPayload } from '@elsewhere/shared';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';
import { RateLimiter } from './rateLimit.js';

export { RateLimiter } from './rateLimit.js';

export interface ModerationService extends RoomHooks {
  readonly rateLimiter: RateLimiter;
  /** True if either profile blocked the other. */
  isBlockedBetween(profileA: string, profileB: string): boolean;
  /** True if `listener` muted `speaker`. */
  isMutedBy(listenerProfileId: string, speakerProfileId: string): boolean;
  block(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  unblock(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  mute(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  unmute(ctx: RoomContext, sessionId: string, payload: TargetPayload): Promise<void>;
  report(ctx: RoomContext, sessionId: string, payload: ReportPayload): Promise<void>;
  /** Normalize/clean user text (trim, collapse whitespace, strip control chars, profanity mask). */
  filterText(text: string): string;
}

export function createModeration(_persistence: PersistenceService): ModerationService {
  const rateLimiter = new RateLimiter();
  const nope = async (ctx: RoomContext, sessionId: string) => ctx.error(sessionId, 'not_implemented', 'Moderation is not implemented yet');
  return {
    rateLimiter,
    isBlockedBetween: () => false,
    isMutedBy: () => false,
    block: nope,
    unblock: nope,
    mute: nope,
    unmute: nope,
    report: nope,
    filterText: (text) => text.replace(/[\u0000-\u001f\u007f]/g, '').trim(),
    onPlayerLeave(_ctx, sessionId) {
      rateLimiter.forget(sessionId);
    },
  };
}
