/**
 * World Memory: an append-only, attributed log of meaningful happenings
 * (shared/src/memory.ts WorldEventKind). Gameplay code calls `record` only for
 * things that actually happened; REST serves `list` (paging by id cursor,
 * filters by kind / location / profile). `announce` additionally broadcasts a
 * significant event to the room as S2C.worldEvent.
 */
import { randomBytes } from 'node:crypto';
import { S2C, type NewWorldEvent, type WorldEvent, type WorldMemoryQuery } from '@elsewhere/shared';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext } from '../rooms/RoomContext.js';

export interface MemoryService {
  record(event: NewWorldEvent): Promise<WorldEvent>;
  /** Record + broadcast `{ event, headline }` to everyone in the room. */
  announce(ctx: RoomContext, event: NewWorldEvent, headline: string): Promise<WorldEvent>;
  list(query: WorldMemoryQuery): Promise<WorldEvent[]>;
  /** Be told about every recorded event (after it is persisted). Returns an unsubscribe function. */
  subscribe(fn: (event: WorldEvent) => void): () => void;
}

let lastTs = 0;
let counter = 0;
/** Lexicographically time-sortable id: 9 base36 chars of ms + 3 of in-ms sequence + random. */
export function eventId(ts: number): string {
  if (ts === lastTs) counter++;
  else {
    lastTs = ts;
    counter = 0;
  }
  return `${ts.toString(36).padStart(9, '0')}${counter.toString(36).padStart(3, '0')}_${randomBytes(4).toString('hex')}`;
}

export function createMemory(persistence: PersistenceService): MemoryService {
  const listeners = new Set<(event: WorldEvent) => void>();
  const service: MemoryService = {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async record(e) {
      const ts = e.ts ?? Date.now();
      const event: WorldEvent = { ...e, ts, id: eventId(ts), actors: e.actors.slice(0, 24).map((a) => ({ profileId: a.profileId, name: a.name })) };
      await persistence.events.append(event);
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          console.error('[memory] listener failed', err);
        }
      }
      return event;
    },
    async announce(ctx, e, headline) {
      const event = await service.record(e);
      ctx.broadcast(S2C.worldEvent, { event, headline });
      return event;
    },
    list(q) {
      return persistence.events.list({ ...q, limit: Math.min(200, Math.max(1, q.limit ?? 50)) });
    },
  };
  return service;
}
