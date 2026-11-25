/**
 * Proximity chat (CONFIG.chat.proximityRadius), global town chat, private
 * messages (whisper), @mentions (extractMentions, display names), typing
 * indicator, chat history (global + system lines for the welcome payload).
 *
 * Every line: chat-mute sanction check → per-player rate limit ('chat' /
 * 'whisper', rejections feed auto-mute) → sanitize + profanity mask → length
 * cap → duplicate-spam check → block/mute delivery filters → deliver.
 */
import { randomUUID } from 'node:crypto';
import { CONFIG, S2C, extractMentions, interiorAt, type ChatMessage, type ChatPayload, type TypingPayload, type WhisperPayload } from '@elsewhere/shared';
import type { ModerationService } from '../moderation/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';

export interface ChatService extends RoomHooks {
  handleChat(ctx: RoomContext, sessionId: string, payload: ChatPayload): void;
  handleWhisper(ctx: RoomContext, sessionId: string, payload: WhisperPayload): void;
  handleTyping(ctx: RoomContext, sessionId: string, payload: TypingPayload): void;
  /** Recent global/system messages of one room for the welcome payload (hides lines from profiles blocked either way). */
  recent(forProfileId?: string, roomId?: string): ChatMessage[];
  /** Post a system line (e.g. "The bell rings out over the island."). */
  system(ctx: RoomContext, text: string): void;
}

let seq = 0;
const newId = (ts: number) => `m_${ts.toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}_${randomUUID().slice(0, 6)}`;

export interface ChatOptions {
  /**
   * Whose proximity chat carries through a whole building right now (the café stage, the
   * Town Hall lectern): listeners inside that interior hear it whatever the distance.
   */
  reach?: (ctx: RoomContext, sessionId: string) => { interiorId: string; stage: 'cafe_stage' | 'hall_lectern' } | null;
}

export function createChat(moderation: ModerationService, options: ChatOptions = {}): ChatService {
  /** Global/system history per room instance (keyed by ctx.roomId). */
  const histories = new Map<string, ChatMessage[]>();
  const lastLines = new Map<string, { text: string; ts: number }[]>();

  const pushHistory = (ctx: RoomContext, m: ChatMessage) => {
    let history = histories.get(ctx.roomId);
    if (!history) histories.set(ctx.roomId, (history = []));
    history.push(m);
    if (history.length > CONFIG.chat.historyLength) history.splice(0, history.length - CONFIG.chat.historyLength);
  };

  /** Common gate. Returns cleaned text or null (and has already replied with the reason). */
  function gate(ctx: RoomContext, sessionId: string, raw: unknown, action: 'chat' | 'whisper'): { text: string; profileId: string } | null {
    const profile = ctx.getProfile(sessionId);
    const player = ctx.getPlayer(sessionId);
    if (!profile || !player) return null;
    const muted = moderation.chatMutedFor(profile.id);
    if (muted > 0) {
      ctx.notice(sessionId, { level: 'warning', code: 'chat_muted', text: `Your chat is paused for ${Math.ceil(muted / 60_000)} more minute(s).` });
      ctx.error(sessionId, 'forbidden', 'Chat is paused for you right now', action);
      return null;
    }
    const wait = moderation.rateLimiter.take(sessionId, action);
    if (wait > 0) {
      ctx.send(sessionId, S2C.rateLimited, { action, retryInMs: wait });
      moderation.noteRateLimited(ctx, sessionId, action);
      return null;
    }
    if (typeof raw !== 'string') {
      ctx.error(sessionId, 'bad_request', 'Message text required', action);
      return null;
    }
    const text = moderation.filterText(raw);
    if (!text) return null;
    if ([...text].length > CONFIG.chat.maxMessageLength) {
      ctx.error(sessionId, 'message_too_long', `Messages are limited to ${CONFIG.chat.maxMessageLength} characters`, action);
      return null;
    }
    // Duplicate-spam: the same line more than maxDuplicateMessages times within the window.
    const t = ctx.now();
    const key = text.toLowerCase();
    const recentLines = (lastLines.get(profile.id) ?? []).filter((l) => t - l.ts < CONFIG.moderation.duplicateWindowMs);
    if (recentLines.filter((l) => l.text === key).length >= CONFIG.moderation.maxDuplicateMessages) {
      ctx.send(sessionId, S2C.rateLimited, { action: `${action}_duplicate`, retryInMs: CONFIG.moderation.duplicateWindowMs });
      moderation.noteRateLimited(ctx, sessionId, `${action}_duplicate`);
      return null;
    }
    recentLines.push({ text: key, ts: t });
    lastLines.set(profile.id, recentLines.slice(-10));
    player.typing = false;
    profile.stats.chats = (profile.stats.chats ?? 0) + 1;
    return { text, profileId: profile.id };
  }

  /** Listener may receive speaker's lines (blocks both ways, mutes one way). */
  const canHear = (ctx: RoomContext, listenerSid: string, speakerProfileId: string) => {
    const listener = ctx.getPlayer(listenerSid);
    if (!listener) return false;
    if (listener.profileId === speakerProfileId) return true;
    return !moderation.isBlockedBetween(listener.profileId, speakerProfileId) && !moderation.isMutedBy(listener.profileId, speakerProfileId);
  };

  return {
    handleChat(ctx, sessionId, payload) {
      const channel = payload.channel;
      if (channel !== 'proximity' && channel !== 'global') return ctx.error(sessionId, 'bad_request', 'Unknown chat channel', 'chat');
      const g = gate(ctx, sessionId, payload.text, 'chat');
      if (!g) return;
      const sender = ctx.getPlayer(sessionId)!;
      const ts = ctx.now();
      const msg: ChatMessage = { id: newId(ts), channel, from: sessionId, fromProfileId: g.profileId, fromName: sender.name, text: g.text, ts, mentions: extractMentions(g.text) };
      const r2 = CONFIG.chat.proximityRadius * CONFIG.chat.proximityRadius;
      const reach = channel === 'proximity' ? (options.reach?.(ctx, sessionId) ?? null) : null;
      if (reach) msg.stage = reach.stage;
      ctx.broadcast(S2C.chat, msg, {
        filter: (sid) => {
          if (sid === sessionId) return true;
          if (!canHear(ctx, sid, g.profileId)) return false;
          if (channel === 'global') return true;
          const l = ctx.getPlayer(sid);
          if (!l) return false;
          if (reach && interiorAt(l)?.id === reach.interiorId) return true;
          const dx = l.x - sender.x;
          const dz = l.z - sender.z;
          return dx * dx + dz * dz <= r2;
        },
      });
      moderation.recordChat(msg);
      if (channel === 'global') pushHistory(ctx, msg);
    },

    handleWhisper(ctx, sessionId, payload) {
      const to = typeof payload.to === 'string' ? payload.to : '';
      const recipient = to ? ctx.getPlayer(to) : undefined;
      const sender = ctx.getPlayer(sessionId);
      if (!sender) return;
      if (!recipient) return ctx.error(sessionId, 'not_found', 'That player is not here', 'whisper');
      if (to === sessionId) return ctx.error(sessionId, 'bad_request', 'You cannot whisper to yourself', 'whisper');
      if (moderation.isBlockedBetween(sender.profileId, recipient.profileId)) return ctx.error(sessionId, 'blocked', 'You cannot message that player', 'whisper');
      const g = gate(ctx, sessionId, payload.text, 'whisper');
      if (!g) return;
      const ts = ctx.now();
      const msg: ChatMessage = {
        id: newId(ts),
        channel: 'private',
        from: sessionId,
        fromProfileId: g.profileId,
        fromName: sender.name,
        to,
        toName: recipient.name,
        text: g.text,
        ts,
        mentions: extractMentions(g.text),
      };
      ctx.send(sessionId, S2C.chat, msg);
      // Mutes are silent: the sender still sees their line.
      if (!moderation.isMutedBy(recipient.profileId, sender.profileId)) ctx.send(to, S2C.chat, msg);
      moderation.recordChat(msg, recipient.profileId);
    },

    handleTyping(ctx, sessionId, payload) {
      const p = ctx.getPlayer(sessionId);
      if (!p) return;
      if (moderation.rateLimiter.take(sessionId, 'typing') > 0) return;
      p.typing = payload.typing === true;
    },

    recent(forProfileId, roomId) {
      const history = roomId !== undefined ? (histories.get(roomId) ?? []) : [...histories.values()].flat();
      if (!forProfileId) return history.slice();
      return history.filter((m) => m.channel === 'system' || (!moderation.isBlockedBetween(forProfileId, m.fromProfileId) && !moderation.isMutedBy(forProfileId, m.fromProfileId)));
    },

    system(ctx, text) {
      const ts = ctx.now();
      const msg: ChatMessage = { id: newId(ts), channel: 'system', from: '', fromProfileId: '', fromName: 'Elsewhere', text, ts, mentions: [] };
      ctx.broadcast(S2C.chat, msg);
      pushHistory(ctx, msg);
    },

    onRoomDispose(ctx) {
      histories.delete(ctx.roomId);
    },

    onPlayerLeave(ctx, sessionId) {
      const p = ctx.getProfile(sessionId);
      if (p) lastLines.delete(p.id);
    },
  };
}
