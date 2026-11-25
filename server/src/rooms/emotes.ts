/**
 * Emote rules (shared by WorldRoom and tests).
 *  - Upper-body one-shots (wave) are allowed while seated; full-body loops (dance) are not.
 *  - A one-shot reverts after its duration to `sit` if the player still holds a seat, else `idle`
 *    (only if nothing else replaced the anim meanwhile).
 */
import { CONFIG, C2S, S2C, isEmote, type EmoteId } from '@elsewhere/shared';
import type { RoomContext, TimerHandle } from './RoomContext.js';

/** Emotes that only animate the upper body (fine while seated). */
export const SEATED_EMOTES: ReadonlySet<EmoteId> = new Set<EmoteId>(['wave']);
/** One-shot emotes and how long they play. Others (dance) loop until the player moves. */
export const ONE_SHOT_MS: Partial<Record<EmoteId, number>> = { wave: CONFIG.emotes.waveDurationMs };

export function applyEmote(ctx: RoomContext, sid: string, emote: unknown, timers: Map<string, TimerHandle>): void {
  const p = ctx.getPlayer(sid);
  if (!p) return;
  if (!isEmote(emote)) return ctx.error(sid, 'bad_request', 'Unknown emote', C2S.emote);
  if (p.seat && !SEATED_EMOTES.has(emote)) return ctx.error(sid, 'forbidden', 'Stand up first', C2S.emote);
  p.anim = emote;
  p.animSeq = (p.animSeq + 1) % 65536;
  timers.get(sid)?.clear();
  timers.delete(sid);
  const ms = ONE_SHOT_MS[emote];
  if (ms !== undefined) {
    timers.set(
      sid,
      ctx.setTimeout(() => {
        timers.delete(sid);
        const cur = ctx.getPlayer(sid);
        if (cur && cur.anim === emote) cur.anim = cur.seat ? 'sit' : 'idle';
      }, ms),
    );
  }
  ctx.broadcast(S2C.emote, { sessionId: sid, emote, ts: ctx.now() });
}
