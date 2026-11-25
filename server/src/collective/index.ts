/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * Collective Reality: the world evolves from UNIQUE-player participation and
 * the result persists (PersistentWorldState via persistence.worldState).
 *  - Fountain: each unique profile touching it counts once; crossing
 *    CONFIG.collective.fountainStages[n] bumps objects['fountain'].value to n+1,
 *    records 'fountain_transformed' and broadcasts S2C.worldEvent.
 *  - Portal secret: CONFIG.collective.portalRunesRequired distinct players each
 *    hold a rune within portalWindowMs → objects['portal_arch'].active = true
 *    for portalAwakeMs; record 'portal_awakened' with all actors.
 *
 * Foundation stub: loads/creates the persistent world facts (incl. clock epoch).
 */
import type { PersistentWorldState } from '@elsewhere/shared';
import type { MemoryService } from '../memory/index.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks } from '../rooms/RoomContext.js';

/** Gameplay signals the interactions service forwards here. */
export type CollectiveSignal =
  | { type: 'fountain_touched'; sessionId: string; profileId: string }
  | { type: 'rune_touched'; sessionId: string; profileId: string; runeIndex: number }
  | { type: 'rune_released'; sessionId: string; runeIndex: number };

export interface CollectiveService extends RoomHooks {
  /** Load persistent facts; creates them (with a fresh clock epoch) on first boot. */
  load(): Promise<PersistentWorldState>;
  facts(): PersistentWorldState;
  signal(ctx: RoomContext, signal: CollectiveSignal): Promise<void>;
}

export function createCollective(persistence: PersistenceService, _memory: MemoryService): CollectiveService {
  let facts: PersistentWorldState | null = null;
  return {
    async load() {
      facts = (await persistence.worldState.load()) ?? {
        clockEpochMs: Date.now(),
        fountainContributors: 0,
        fountainStage: 0,
        portalAwakenings: 0,
        counters: {},
      };
      await persistence.worldState.save(facts);
      return facts;
    },
    facts() {
      if (!facts) throw new Error('collective.load() not called');
      return facts;
    },
    async signal() {
      // Not implemented yet.
    },
    onRoomCreate(ctx) {
      const f = facts;
      if (!f) return;
      const fountain = ctx.getObject('fountain');
      if (fountain) fountain.value = f.fountainStage;
    },
  };
}
