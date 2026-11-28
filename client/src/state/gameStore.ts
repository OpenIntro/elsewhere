/**
 * Game state that UI cares about (low-frequency). Positions live in runtime.ts.
 * Written by net/ (from room state + messages); read everywhere.
 */
import { create } from 'zustand';
import type { ActivityStateView, Appearance, AnimState, ItemId, LocationId, ObjectStateView, ProfileSummary } from '@elsewhere/shared';

/** Low-frequency keeper info (positions live in runtime.keepers). Keepers are world characters, never players. */
export interface KeeperInfo {
  id: string;
  present: boolean;
  anim: string;
  animSeq: number;
  task: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** Roster entry (no positions). */
export interface PlayerInfo {
  id: string;
  profileId: string;
  name: string;
  appearance: Appearance;
  anim: AnimState;
  animSeq: number;
  seat: string;
  held: ItemId | '';
  location: LocationId | '';
  typing: boolean;
  isLocal: boolean;
}

export interface ClockInfo {
  epochMs: number;
  dayLengthMs: number;
  /** serverNow ≈ Date.now() + offsetMs */
  offsetMs: number;
}

export interface GameState {
  connection: ConnectionStatus;
  connectionError: string | null;
  sessionId: string | null;
  profile: ProfileSummary | null;
  players: Record<string, PlayerInfo>;
  objects: Record<string, ObjectStateView>;
  clock: ClockInfo;
  world: { fountainStage: number; fountainContributors: number; portalAwake: boolean };
  blocked: string[];
  muted: string[];
  /** Fresh-rejoin attempts since the session was lost (0 while connected / during same-session reconnection). Written by net/. */
  reconnectAttempt: number;
  /** Set by net/ when the server kicked/banned this client (socket closed with 4003): no auto-reconnect. connection = 'disconnected', connectionError = 'kicked'. */
  kicked: { reason: string; at: number } | null;
  /** Building keepers (NOT players: never counted, never in `players`). */
  keepers: Record<string, KeeperInfo>;
  /** Shared building-activity state (activities.ts ACTIVITY_KEYS). */
  activities: Record<string, ActivityStateView>;
  setKeeper(info: KeeperInfo): void;
  setActivity(state: ActivityStateView): void;

  setConnection(status: ConnectionStatus, error?: string | null): void;
  setSession(sessionId: string | null, profile?: ProfileSummary | null): void;
  setProfile(profile: ProfileSummary): void;
  upsertPlayer(info: PlayerInfo): void;
  patchPlayer(id: string, patch: Partial<PlayerInfo>): void;
  removePlayer(id: string): void;
  setObject(state: ObjectStateView): void;
  setClock(clock: Partial<ClockInfo>): void;
  setWorld(world: Partial<GameState['world']>): void;
  setLists(lists: { blocked?: string[]; muted?: string[] }): void;
  reset(): void;
}

const initial = {
  connection: 'idle' as ConnectionStatus,
  connectionError: null,
  sessionId: null,
  profile: null,
  players: {},
  objects: {},
  clock: { epochMs: Date.now(), dayLengthMs: 48 * 60_000, offsetMs: 0 },
  world: { fountainStage: 0, fountainContributors: 0, portalAwake: false },
  blocked: [],
  muted: [],
  reconnectAttempt: 0,
  kicked: null,
  keepers: {} as Record<string, KeeperInfo>,
  activities: {} as Record<string, ActivityStateView>,
};

export const useGameStore = create<GameState>()((set) => ({
  ...initial,
  setConnection: (connection, error = null) => set({ connection, connectionError: error }),
  setSession: (sessionId, profile) => set((s) => ({ sessionId, profile: profile === undefined ? s.profile : profile })),
  setProfile: (profile) => set({ profile }),
  upsertPlayer: (info) => set((s) => ({ players: { ...s.players, [info.id]: info } })),
  patchPlayer: (id, patch) =>
    set((s) => {
      const cur = s.players[id];
      if (!cur) return s;
      return { players: { ...s.players, [id]: { ...cur, ...patch } } };
    }),
  removePlayer: (id) =>
    set((s) => {
      if (!s.players[id]) return s;
      const { [id]: _gone, ...rest } = s.players;
      return { players: rest };
    }),
  setObject: (o) => set((s) => ({ objects: { ...s.objects, [o.id]: o } })),
  setKeeper: (k) => set((s) => ({ keepers: { ...s.keepers, [k.id]: k } })),
  setActivity: (a) => set((s) => ({ activities: { ...s.activities, [a.id]: a } })),
  setClock: (clock) => set((s) => ({ clock: { ...s.clock, ...clock } })),
  setWorld: (world) => set((s) => ({ world: { ...s.world, ...world } })),
  setLists: ({ blocked, muted }) => set((s) => ({ blocked: blocked ?? s.blocked, muted: muted ?? s.muted })),
  reset: () => set({ ...initial, clock: { ...initial.clock } }),
}));

/** Server-synchronized "now" (unix ms). Safe to call per frame. */
export function serverNow(): number {
  return Date.now() + useGameStore.getState().clock.offsetMs;
}
