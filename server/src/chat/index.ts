/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Proximity chat (CONFIG.chat.proximityRadius), global chat, private messages
 * (whisper), @mentions (extractMentions), typing indicator, chat history.
 * Must apply ModerationService.filterText, rate limits ('chat' / 'whisper'),
 * CONFIG.chat.maxMessageLength and block/mute filters before delivering.
 *
 * Foundation stub: replies `not_implemented`.
 */
import type { ChatMessage, ChatPayload, TypingPayload, WhisperPayload } from '@elsewhere/shared';
import type { ModerationService } from '../moderation/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';

export interface ChatService extends RoomHooks {
  handleChat(ctx: RoomContext, sessionId: string, payload: ChatPayload): void;
  handleWhisper(ctx: RoomContext, sessionId: string, payload: WhisperPayload): void;
  handleTyping(ctx: RoomContext, sessionId: string, payload: TypingPayload): void;
  /** Recent global/system messages for the welcome payload. */
  recent(): ChatMessage[];
  /** Post a system line (e.g. "The bell rings out over the island."). */
  system(ctx: RoomContext, text: string): void;
}

export function createChat(_moderation: ModerationService): ChatService {
  return {
    handleChat(ctx, sessionId) {
      ctx.error(sessionId, 'not_implemented', 'Chat is not implemented yet', 'chat');
    },
    handleWhisper(ctx, sessionId) {
      ctx.error(sessionId, 'not_implemented', 'Private messages are not implemented yet', 'whisper');
    },
    handleTyping(ctx, sessionId, payload) {
      const p = ctx.getPlayer(sessionId);
      if (p) p.typing = payload.typing === true;
    },
    recent: () => [],
    system() {},
  };
}
