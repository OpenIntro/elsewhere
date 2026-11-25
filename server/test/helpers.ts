/**
 * Test harness: real services over an in-memory PGlite database plus a fake
 * RoomContext backed by the real Colyseus schema classes, a manual clock and
 * manual timers. No network.
 */
import { CONFIG, SYNCED_INTERACTABLES, createCollisionWorld, getInteractable, groundHeight, worldTimeAt, type CollisionWorld, type S2CPayloads, type S2CType } from '@elsewhere/shared';
import { newGuestProfile } from '../src/auth/index.js';
import { createBuilding, type BuildingOptions, type BuildingService } from '../src/building/index.js';
import { createChat, type ChatService } from '../src/chat/index.js';
import { createCollective, type CollectiveService } from '../src/collective/index.js';
import type { CollectiveTunables } from '../src/env.js';
import { createInteractions, type InteractionService } from '../src/interactions/index.js';
import { createMemory, type MemoryService } from '../src/memory/index.js';
import { createModeration, RateLimiter, type ModerationService } from '../src/moderation/index.js';
import { createPersistence, type PersistenceService, type StoredProfile } from '../src/persistence/index.js';
import type { RoomContext, RoomHooks, TimerHandle } from '../src/rooms/RoomContext.js';
import { ObjectState, PlayerState, WorldState } from '../src/rooms/schema.js';

export const DAY_MS = 48 * 60_000;

export const TEST_TUNABLES: CollectiveTunables = {
  fountainStages: [3, 6],
  fountainStageDistinct: [2, 4],
  portalRunesRequired: 2,
  portalWindowMs: 20_000,
  portalAwakeMs: 60_000,
  bellChorusPlayers: 3,
  gatheringThreshold: 6,
};

export interface Sent {
  to: string;
  type: S2CType;
  payload: unknown;
}

export class FakeClock {
  t = 1_800_000_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now = () => this.t;
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return { clear: () => (this.timers = this.timers.filter((x) => x.id !== id)) };
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

export interface World {
  clock: FakeClock;
  persistence: PersistenceService;
  moderation: ModerationService;
  chat: ChatService;
  memory: MemoryService;
  collective: CollectiveService;
  interactions: InteractionService;
  /** Only when makeWorld({ building }) was used. */
  building: BuildingService | undefined;
  /** This world's own collision world (static island + its dynamic layer; building writes into it). */
  collision: CollisionWorld;
  hooks: RoomHooks[];
  ctx: RoomContext;
  state: WorldState;
  sent: Sent[];
  kicked: string[];
  /** Join a player (new guest profile unless one is given) at x,z. Returns sessionId. */
  join(name: string, x: number, z: number, profile?: StoredProfile): Promise<string>;
  leave(sessionId: string): Promise<void>;
  move(sessionId: string, x: number, z: number): void;
  /** Move next to an interactable and interact (range already validated by WorldRoom in production). */
  interact(sessionId: string, id: string, action?: string): Promise<S2CPayloads['interact_result']>;
  received(sessionId: string, type: S2CType): unknown[];
  clearSent(): void;
  /** A second (third, …) room instance of the SAME world, sharing all services. */
  openRoom(roomId: string): Promise<World>;
  dispose(): Promise<void>;
  close(): Promise<void>;
}

export async function makeWorld(opts: { persistence?: PersistenceService; tunables?: Partial<CollectiveTunables>; clock?: FakeClock; building?: Partial<BuildingOptions> | true } = {}): Promise<World> {
  const clock = opts.clock ?? new FakeClock();
  const persistence = opts.persistence ?? createPersistence({ dataDir: 'memory://' });
  await persistence.init();
  const moderation = createModeration(persistence, { now: clock.now, rateLimiter: new RateLimiter(CONFIG.rateLimits, clock.now) });
  const chat = createChat(moderation);
  const memory = createMemory(persistence);
  const collective = createCollective(persistence, memory, { tunables: { ...TEST_TUNABLES, ...opts.tunables }, dayLengthMs: DAY_MS, now: clock.now });
  await collective.load();
  const interactions = createInteractions({ persistence, memory, collective, moderation, now: clock.now });
  const hooks: RoomHooks[] = [moderation, chat, collective, interactions];
  const collision = createCollisionWorld();
  let building: BuildingService | undefined;
  if (opts.building) {
    building = createBuilding({ persistence, memory, moderation, now: clock.now, collision, ...(opts.building === true ? {} : { options: opts.building }) });
    await building.load();
    hooks.push(building);
  }
  const services = { clock, persistence, moderation, chat, memory, collective, interactions, building, collision, hooks };
  return openRoomWith(services, 'test');
}

let sessionCounter = 0;

async function openRoomWith(
  services: Pick<World, 'clock' | 'persistence' | 'moderation' | 'chat' | 'memory' | 'collective' | 'interactions' | 'building' | 'collision' | 'hooks'>,
  roomId: string,
): Promise<World> {
  const { clock, persistence, collective, interactions, hooks } = services;
  const state = new WorldState();
  state.clockEpoch = collective.facts().clockEpochMs;
  state.dayLengthMs = DAY_MS;
  for (const it of SYNCED_INTERACTABLES) state.objects.set(it.id, new ObjectState({ id: it.id, active: it.kind === 'pickup', updatedAt: clock.t }));
  const profiles = new Map<string, StoredProfile>();
  const sent: Sent[] = [];
  const kicked: string[] = [];

  const ctx: RoomContext = {
    roomId,
    state,
    now: clock.now,
    worldTime: () => worldTimeAt(clock.t, { epochMs: state.clockEpoch, dayLengthMs: DAY_MS }),
    getPlayer: (id) => state.players.get(id),
    getObject: (id) => state.objects.get(id),
    getProfile: (id) => profiles.get(id),
    saveProfile: async (id) => {
      const p = profiles.get(id);
      if (p) await persistence.profiles.save(p);
    },
    sessionForProfile: (pid) => [...profiles].find(([, p]) => p.id === pid)?.[0],
    sessionIds: () => [...state.players.keys()],
    send: (to, type, payload) => void sent.push({ to, type, payload }),
    broadcast: (type, payload, o) => {
      for (const sid of state.players.keys()) {
        if (o?.except === sid) continue;
        if (o?.filter && !o.filter(sid)) continue;
        sent.push({ to: sid, type, payload });
      }
    },
    notice: (to, payload) => void sent.push({ to, type: 'notice', payload }),
    error: (to, code, message, inResponseTo) => void sent.push({ to, type: 'error', payload: { code, message, inResponseTo } }),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    teleport: (sid, x, z) => {
      const p = state.players.get(sid);
      if (p) {
        p.x = x;
        p.z = z;
        p.y = groundHeight(x, z);
      }
    },
    kick: (sid) => void kicked.push(sid),
  };
  for (const h of hooks) await h.onRoomCreate?.(ctx);

  const world: World = {
    ...services,
    ctx,
    state,
    sent,
    kicked,
    async join(name, x, z, profile) {
      const sid = `s${++sessionCounter}`;
      const p = profile ?? newGuestProfile(name);
      p.visits += 1;
      await persistence.profiles.save(p);
      profiles.set(sid, p);
      state.players.set(sid, new PlayerState({ id: sid, profileId: p.id, name: p.displayName, x, z, y: groundHeight(x, z) }));
      for (const h of hooks) await h.onPlayerPreJoin?.(ctx, sid);
      for (const h of hooks) await h.onPlayerJoin?.(ctx, sid);
      return sid;
    },
    async leave(sid) {
      for (const h of hooks) await h.onPlayerLeave?.(ctx, sid);
      state.players.delete(sid);
      profiles.delete(sid);
    },
    move(sid, x, z) {
      const p = state.players.get(sid)!;
      p.x = x;
      p.z = z;
    },
    async interact(sid, id, action) {
      const it = getInteractable(id);
      if (!it) throw new Error(`no interactable ${id}`);
      const p = state.players.get(sid)!;
      if (!p.seat) {
        p.x = it.position.x;
        p.z = it.position.z + 0.5;
      }
      return interactions.interact(ctx, sid, it, action === undefined ? { id } : { id, action });
    },
    received: (sid, type) => sent.filter((s) => s.to === sid && s.type === type).map((s) => s.payload),
    clearSent: () => void sent.splice(0, sent.length),
    openRoom: (id) => openRoomWith(services, id),
    async dispose() {
      for (const h of hooks) await h.onRoomDispose?.(ctx);
    },
    close: () => persistence.close(),
  };
  return world;
}
