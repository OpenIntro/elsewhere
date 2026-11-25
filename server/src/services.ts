/**
 * Composition root for server-side services. Rooms and HTTP routes get
 * services from here; each service lives in its own seam directory.
 */
import { createAuth, type AuthService } from './auth/index.js';
import { createChat, type ChatService } from './chat/index.js';
import { createCollective, type CollectiveService } from './collective/index.js';
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

export async function initServices(): Promise<ServerServices> {
  const persistence = createPersistence();
  await persistence.init();
  const auth = createAuth(persistence);
  const moderation = createModeration(persistence);
  const chat = createChat(moderation);
  const memory = createMemory(persistence);
  const collective = createCollective(persistence, memory);
  await collective.load();
  const interactions = createInteractions({ persistence, memory, collective });
  const gazette = createGazette(persistence);
  gazette.start();
  current = { persistence, auth, moderation, chat, memory, collective, interactions, gazette, hooks: [moderation, chat, collective, interactions] };
  return current;
}

export function services(): ServerServices {
  if (!current) throw new Error('initServices() has not run');
  return current;
}
