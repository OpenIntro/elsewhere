/**
 * What gameplay services (chat, interactions, collective, …) may do inside a
 * room. WorldRoom implements this; services never touch Colyseus directly, so
 * they stay unit-testable with a fake context (server/test/helpers.ts).
 */
import type { ErrorCode, C2SType, NoticePayload, S2CPayloads, S2CType, WorldTime } from '@elsewhere/shared';
import type { StoredProfile } from '../persistence/index.js';
import type { ObjectState, PlayerState, WorldState } from './schema.js';

export interface BroadcastOptions {
  /** Skip this sessionId. */
  except?: string;
  /** Only deliver to sessions for which this returns true (e.g. proximity, block lists). */
  filter?: (sessionId: string) => boolean;
}

export interface TimerHandle {
  clear(): void;
}

export interface RoomContext {
  readonly roomId: string;
  readonly state: WorldState;
  /** Server unix ms. */
  now(): number;
  /** Current in-world time (from the persisted clock epoch). */
  worldTime(): WorldTime;
  getPlayer(sessionId: string): PlayerState | undefined;
  getObject(id: string): ObjectState | undefined;
  /** The stored profile of a connected session (mutable; call saveProfile after changes). */
  getProfile(sessionId: string): StoredProfile | undefined;
  /** Persist a connected session's profile (fire-and-forget safe; errors are logged). */
  saveProfile(sessionId: string): Promise<void>;
  /** Session id currently playing this profile in this room, if any. */
  sessionForProfile(profileId: string): string | undefined;
  /** Session ids of everyone currently in the room. */
  sessionIds(): string[];
  send<T extends S2CType>(sessionId: string, type: T, payload: S2CPayloads[T]): void;
  broadcast<T extends S2CType>(type: T, payload: S2CPayloads[T], options?: BroadcastOptions): void;
  notice(sessionId: string, notice: NoticePayload): void;
  error(sessionId: string, code: ErrorCode, message: string, inResponseTo?: C2SType): void;
  /** Room-clock timers (cleared automatically when the room disposes). */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Teleport a player authoritatively (sends a correction to that client). */
  teleport(sessionId: string, x: number, z: number, reason?: 'teleport' | 'seated'): void;
  /** Disconnect a session (admin kick / ban). */
  kick(sessionId: string, reason: string): void;
}

/** Optional lifecycle hooks any service may implement; WorldRoom calls them in order. */
export interface RoomHooks {
  onRoomCreate?(ctx: RoomContext): void | Promise<void>;
  /** Before the welcome is sent (load per-player caches; must not send to the player). */
  onPlayerPreJoin?(ctx: RoomContext, sessionId: string): void | Promise<void>;
  onPlayerJoin?(ctx: RoomContext, sessionId: string): void | Promise<void>;
  onPlayerLeave?(ctx: RoomContext, sessionId: string): void | Promise<void>;
  /** Called every simulation tick. */
  tick?(ctx: RoomContext, dtMs: number): void;
  onRoomDispose?(ctx: RoomContext): void | Promise<void>;
}

/** Live rooms (for admin tools). WorldRoom adds/removes its context. */
export const roomRegistry = new Set<RoomContext>();
