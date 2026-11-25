/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Server-authoritative handling of every interactable kind
 * (shared/src/world/interactables.ts). WorldRoom has ALREADY validated that the
 * interactable exists and that the player is within its radius (+ slack) and
 * rate limits; this service applies the effect:
 *  - bench/chair: assign a free seat (ObjectState.value bitmask), set
 *    player.seat/anim='sit', ctx.teleport to the seat; `stand` → seat.exit.
 *  - door: toggle active, auto-close after CONFIG.interaction.doorAutoCloseMs.
 *  - streetlight/lantern: toggle active (cooldown); follow clock otherwise.
 *  - bell: cooldown, value++, broadcast ObjectEvent 'bell_rung', record memory.
 *  - pickup/drop: holder + player.held, respawn after pickupRespawnMs.
 *  - sign/inspect: return { ui: { panel: 'sign' | 'inspect', title, text } }.
 *  - newsstand/archive: return { ui: { panel: 'gazette' | 'memory' } }.
 *  - mailbox: return { ui: { panel: 'mailbox', ... } }; mail_send/mail_read.
 *  - hidden: per-profile discovery (profile.discoveries), S2C.discovery, memory.
 *  - fountain/rune/portal: forward to CollectiveService.signal.
 *
 * Foundation stub: read-only kinds (sign/inspect/newsstand/archive) work;
 * everything else replies not_implemented.
 */
import type { InteractPayload, InteractResult, MailReadPayload, MailSendPayload, Interactable } from '@elsewhere/shared';
import type { CollectiveService } from '../collective/index.js';
import type { MemoryService } from '../memory/index.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';

export interface InteractionDeps {
  persistence: PersistenceService;
  memory: MemoryService;
  collective: CollectiveService;
}

export interface InteractionService extends RoomHooks {
  /** Seed state.objects for SYNCED_INTERACTABLES is done by WorldRoom; this applies the interaction. */
  interact(ctx: RoomContext, sessionId: string, target: Interactable, payload: InteractPayload): Promise<InteractResult> | InteractResult;
  stand(ctx: RoomContext, sessionId: string): void;
  dropItem(ctx: RoomContext, sessionId: string): void;
  mailSend(ctx: RoomContext, sessionId: string, payload: MailSendPayload): Promise<void>;
  mailRead(ctx: RoomContext, sessionId: string, payload: MailReadPayload): Promise<void>;
}

export function createInteractions(_deps: InteractionDeps): InteractionService {
  return {
    interact(_ctx, _sessionId, target) {
      switch (target.kind) {
        case 'sign':
          return { id: target.id, ok: true, ui: { panel: 'sign', title: target.title, text: target.text } };
        case 'inspect':
          return { id: target.id, ok: true, ui: { panel: 'inspect', title: target.title, text: target.text } };
        case 'newsstand':
          return { id: target.id, ok: true, ui: { panel: 'gazette' } };
        case 'archive':
          return { id: target.id, ok: true, ui: { panel: 'memory' } };
        default:
          return { id: target.id, ok: false, error: 'not_implemented' };
      }
    },
    stand(ctx, sessionId) {
      const p = ctx.getPlayer(sessionId);
      if (p && p.seat) {
        p.seat = '';
        p.anim = 'idle';
      }
    },
    dropItem(ctx, sessionId) {
      ctx.error(sessionId, 'not_implemented', 'Dropping items is not implemented yet', 'drop_item');
    },
    async mailSend(ctx, sessionId) {
      ctx.error(sessionId, 'not_implemented', 'Mail is not implemented yet', 'mail_send');
    },
    async mailRead(ctx, sessionId) {
      ctx.error(sessionId, 'not_implemented', 'Mail is not implemented yet', 'mail_read');
    },
  };
}
