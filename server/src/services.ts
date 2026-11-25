/**
 * Composition root for server-side services. Rooms and HTTP routes get
 * services from here; each service lives in its own seam directory.
 */
import { CONFIG } from '@elsewhere/shared';
import { createAuth, type AuthService } from './auth/index.js';
import { createChat, type ChatService } from './chat/index.js';
import { createCollective, type CollectiveService } from './collective/index.js';
import { ENV } from './env.js';
import { createGazette, type GazetteService } from './gazette/index.js';
import { createInteractions, type InteractionService } from './interactions/index.js';
import { createMemory, type MemoryService } from './memory/index.js';
import { createModeration, type ModerationService } from './moderation/index.js';
import { createPersistence, type PersistenceService } from './persistence/index.js';
import type { RoomHooks } from './rooms/RoomContext.js';

export interface ServerServices {
  persistence: PersistenceService;
  auth: AuthService;
  moderation: ModerationService;
  chat: ChatService;
  memory: MemoryService;
  collective: CollectiveService;
  interactions: InteractionService;
  gazette: GazetteService;
  /** Services with room lifecycle hooks, in call order. */
  hooks: RoomHooks[];
}

let current: ServerServices | null = null;

export interface InitOptions {
  /** Override storage (tests): e.g. { dataDir: 'memory://' }. */
  persistence?: PersistenceService;
}

export async function initServices(opts: InitOptions = {}): Promise<ServerServices> {
  const persistence = opts.persistence ?? createPersistence({ databaseUrl: ENV.databaseUrl, dataDir: ENV.dataDir });
  await persistence.init();
  const auth = createAuth(persistence, { secret: ENV.sessionSecret, supabaseJwtSecret: ENV.supabaseJwtSecret, supabaseUrl: ENV.supabaseUrl });
  const moderation = createModeration(persistence);
  const chat = createChat(moderation);
  const memory = createMemory(persistence);
  const collective = createCollective(persistence, memory, { tunables: ENV.collective, dayLengthMs: ENV.dayLengthMs });
  await collective.load();
  const interactions = createInteractions({ persistence, memory, collective, moderation });
  const gazette = createGazette(persistence, {
    intervalMs: ENV.gazetteIntervalMs,
    memory,
    earlyEvents: ENV.gazetteEarlyEvents,
    earlyDelayMs: ENV.gazetteEarlyDelayMs,
    clock: () => ({ epochMs: collective.facts().clockEpochMs, dayLengthMs: ENV.dayLengthMs, startTimeOfDay: CONFIG.clock.startTimeOfDay }),
  });
  gazette.start();
  current = { persistence, auth, moderation, chat, memory, collective, interactions, gazette, hooks: [moderation, chat, collective, interactions] };
  return current;
}

export function services(): ServerServices {
  if (!current) throw new Error('initServices() has not run');
  return current;
}
