/**
 * What gameplay services (chat, interactions, collective, …) may do inside a
 * room. WorldRoom implements this; services never touch Colyseus directly, so
 * they stay unit-testable with a fake context.
 */
import type { ErrorCode, C2SType, NoticePayload, S2CPayloads, S2CType } from '@elsewhere/shared';
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
  getPlayer(sessionId: string): PlayerState | undefined;
  getObject(id: string): ObjectState | undefined;
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
}

/** Optional lifecycle hooks any service may implement; WorldRoom calls them in order. */
export interface RoomHooks {
  onRoomCreate?(ctx: RoomContext): void | Promise<void>;
  onPlayerJoin?(ctx: RoomContext, sessionId: string): void | Promise<void>;
  onPlayerLeave?(ctx: RoomContext, sessionId: string): void | Promise<void>;
  /** Called every simulation tick. */
  tick?(ctx: RoomContext, dtMs: number): void;
  onRoomDispose?(ctx: RoomContext): void | Promise<void>;
}
