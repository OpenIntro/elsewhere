/**
 * Typed send helpers for every C2S message (rate limited client-side by
 * net.send). Each returns true if the message was sent, false if dropped
 * (not connected / locally rate limited — a synthetic S2C.rateLimited is
 * emitted for user-facing actions so the UI can say "give it a moment").
 *
 *   import { actions } from '../net/index.js';
 *   actions.chat('hello');  actions.whisper(sessionId, 'psst');  actions.emote('wave');
 */
import { C2S, CONFIG, PIANO_NOTES, isEmote, isReaction, type ActivityPayload, type Appearance, type EmoteId, type ReactionEmoji, type ReportReason } from '@elsewhere/shared';
import { net } from './connection.js';

let lastTyping: boolean | null = null;
let lastTypingAt = 0;

export const actions = {
  chat(text: string, channel: 'proximity' | 'global' = 'proximity'): boolean {
    const t = text.trim().slice(0, CONFIG.chat.maxMessageLength);
    if (!t) return false;
    const ok = net.send(C2S.chat, { channel, text: t });
    if (ok) actions.typing(false);
    return ok;
  },
  whisper(to: string, text: string): boolean {
    const t = text.trim().slice(0, CONFIG.chat.maxMessageLength);
    if (!t || !to) return false;
    const ok = net.send(C2S.whisper, { to, text: t });
    if (ok) actions.typing(false);
    return ok;
  },
  /** Typing indicator; de-duplicated (only sends on change, re-asserts "true" at most every 4 s). */
  typing(typing: boolean): boolean {
    const now = performance.now();
    if (typing === lastTyping && (!typing || now - lastTypingAt < 4000)) return false;
    const ok = net.send(C2S.typing, { typing });
    if (ok) {
      lastTyping = typing;
      lastTypingAt = now;
    }
    return ok;
  },
  emote(emote: EmoteId): boolean {
    if (!isEmote(emote)) return false;
    return net.send(C2S.emote, { emote });
  },
  reaction(emoji: ReactionEmoji, target?: string): boolean {
    if (!isReaction(emoji)) return false;
    return net.send(C2S.reaction, target ? { emoji, target } : { emoji });
  },
  interact(id: string, action?: string): boolean {
    return net.send(C2S.interact, action ? { id, action } : { id });
  },
  stand(): boolean {
    return net.send(C2S.stand, {});
  },
  dropItem(): boolean {
    return net.send(C2S.dropItem, {});
  },
  mailSend(mailboxId: string, text: string): boolean {
    const t = text.trim().slice(0, CONFIG.interaction.mailMaxLength);
    if (!t) return false;
    return net.send(C2S.mailSend, { mailboxId, text: t });
  },
  mailRead(mailboxId: string): boolean {
    return net.send(C2S.mailRead, { mailboxId });
  },
  updateProfile(patch: { name?: string; appearance?: Appearance }): boolean {
    return net.send(C2S.updateProfile, patch);
  },
  updateAppearance(appearance: Appearance): boolean {
    return net.send(C2S.updateProfile, { appearance });
  },
  block(target: string): boolean {
    return net.send(C2S.block, { target });
  },
  unblock(target: string): boolean {
    return net.send(C2S.unblock, { target });
  },
  mute(target: string): boolean {
    return net.send(C2S.mute, { target });
  },
  unmute(target: string): boolean {
    return net.send(C2S.unmute, { target });
  },
  /** Building activity action (order, sip, take, pin, remove, report, vote, sign, status). */
  activity(payload: ActivityPayload): boolean {
    const p: ActivityPayload = { station: payload.station, action: payload.action };
    if (payload.item !== undefined) p.item = payload.item;
    if (payload.text !== undefined) p.text = payload.text.slice(0, 400);
    if (payload.option !== undefined) p.option = payload.option;
    if (payload.entryId !== undefined) p.entryId = payload.entryId;
    return net.send(C2S.activity, p);
  },
  pianoNote(note: number): boolean {
    if (!Number.isInteger(note) || note < 0 || note >= PIANO_NOTES) return false;
    return net.send(C2S.pianoNote, { note });
  },
  report(target: string, reason: ReportReason, details?: string, messageIds?: string[]): boolean {
    const payload: { target: string; reason: ReportReason; details?: string; messageIds?: string[] } = { target, reason };
    if (details) payload.details = details.slice(0, 1000);
    if (messageIds?.length) payload.messageIds = messageIds.slice(0, 20);
    return net.send(C2S.report, payload);
  },
};

/** Reset de-dup state (new session). */
export function resetActionState(): void {
  lastTyping = null;
  lastTypingAt = 0;
}

net.onLifecycle((e) => {
  if (e === 'joined') resetActionState();
});
