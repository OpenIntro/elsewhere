/**
 * EXTENSION SEAM — owned by the server worker.
 *
 * World Memory: an append-only, attributed log of meaningful happenings
 * (see shared/src/memory.ts WorldEventKind). Gameplay code calls `record`;
 * REST serves `list`. Significant events may also be broadcast as
 * S2C.worldEvent notices (decide in the collective/interactions services).
 *
 * Foundation: thin pass-through to persistence with ids assigned here.
 */
import { randomUUID } from 'node:crypto';
import type { NewWorldEvent, WorldEvent, WorldMemoryQuery } from '@elsewhere/shared';
import type { PersistenceService } from '../persistence/index.js';

export interface MemoryService {
  record(event: NewWorldEvent): Promise<WorldEvent>;
  list(query: WorldMemoryQuery): Promise<WorldEvent[]>;
}

export function createMemory(persistence: PersistenceService): MemoryService {
  return {
    async record(e) {
      const ts = e.ts ?? Date.now();
      // Time-sortable id: base36 timestamp + random suffix.
      const event: WorldEvent = { ...e, ts, id: `${ts.toString(36).padStart(9, '0')}_${randomUUID().slice(0, 8)}` };
      await persistence.events.append(event);
      return event;
    },
    list(q) {
      return persistence.events.list({ ...q, limit: Math.min(200, Math.max(1, q.limit ?? 50)) });
    },
  };
}
