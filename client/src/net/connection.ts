/**
 * Colyseus connection: session token (REST), join, state→store bridging,
 * remote snapshots, typed + rate-limited send, reconnection.
 *
 * Usage: `await net.connect({ name, appearance })`; `net.send(C2S.move, …)`
 * (or the typed helpers in ./actions.ts); `net.on(S2C.chat, handler)`.
 *
 * Reconnection (state surfaced in useGameStore.connection / reconnectAttempt):
 *  1. Socket drop → Colyseus automatic reconnection into the SAME session
 *     (server holds the seat CONFIG.network.reconnectGraceSeconds): status
 *     'reconnecting'; position, seat and appearance are kept server-side.
 *  2. If that fails (server restarted, grace expired) → fresh join with the
 *     saved guest token (same profile/appearance) and a `resume` position
 *     hint, retried with exponential backoff (+ jitter) until it works.
 *     `online` / tab-visible events retry immediately.
 *  3. `disconnect()` (pagehide) is a consented leave: no reconnection.
 * Sends are dropped (not queued) while not connected — the local player is
 * re-synced on (re)connect instead of replaying stale moves.
 */
import { Callbacks, Client, type Room } from '@colyseus/sdk';
import {
  C2S,
  CONFIG,
  ROOM_NAME,
  S2C,
  parseAppearanceJson,
  type Appearance,
  type C2SPayloads,
  type C2SType,
  type JoinOptions,
  type ObjectStateView,
  type PlayerStateView,
  type S2CPayloads,
  type S2CType,
  type WorldStateView,
} from '@elsewhere/shared';
import { useGameStore, type PlayerInfo } from '../state/gameStore.js';
import { runtime, type PoseSnapshot } from '../state/runtime.js';
import { STORAGE_KEYS, safeStorage } from '../state/storage.js';
import { ServerEvents } from './events.js';
import { ensureRemote, pushInto, removeRemote } from './interpolation.js';
import { ClientRateLimiter } from './rateLimit.js';
import { RestError, rest, setAuthToken } from './rest.js';

export interface ConnectOptions {
  name?: string;
  appearance?: Appearance;
}

function serverEndpoint(): string {
  // Dev: Vite serves the page; Colyseus listens on the server port. Prod: same origin.
  if (import.meta.env.DEV) return `${location.protocol}//${location.hostname}:${__SERVER_PORT__}`;
  return location.origin;
}

const ALL_S2C = Object.values(S2C) as S2CType[];

/** Network-level / server-unavailable failures worth retrying (not protocol mismatch, bans, bad input). */
function isTransient(err: unknown): boolean {
  if (err instanceof RestError) return err.status >= 500 || err.status === 0 || err.status === 429;
  const msg = err instanceof Error ? err.message : String(err);
  if (/protocol_mismatch|unauthorized|forbidden|banned/i.test(msg)) return false;
  return true;
}
/** Fresh-join backoff schedule (ms); the last value repeats. */
const REJOIN_BACKOFF = [400, 1000, 2000, 4000, 8000, 12000];

/** Local-player lifecycle hooks (player/ subscribes; avoids an import cycle). */
export type NetLifecycleEvent = 'joined' | 'resumed' | 'dropped' | 'left';

export class NetClient {
  readonly events = new ServerEvents();
  readonly limiter = new ClientRateLimiter();
  private client: Client | null = null;
  private room: Room<unknown, WorldStateView> | null = null;
  private detach: (() => void)[] = [];
  private opts: ConnectOptions = {};
  private intentionalLeave = false;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinAttempt = 0;
  private lifecycle = new Set<(e: NetLifecycleEvent) => void>();
  private globalListeners = false;
  private connecting: Promise<void> | null = null;
  /** Last local pose before the session ended (resume hint for a fresh rejoin). */
  private lastPose: { x: number; z: number; rot: number } | null = null;
  /** Reused snapshot to avoid per-patch allocations. */
  private snap: PoseSnapshot = { t: 0, x: 0, y: 0, z: 0, rot: 0 };
  /** Stats for the debug hook / load tests. */
  readonly stats = { joins: 0, autoReconnects: 0, rejoins: 0, droppedSends: 0, limitedSends: 0, patches: 0 };

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /** Raw room state (read-only). Prefer stores/runtime in UI code. */
  get state(): WorldStateView | null {
    return (this.room?.state as WorldStateView | undefined) ?? null;
  }

  /** True when messages can be sent right now. */
  get connected(): boolean {
    return !!this.room && useGameStore.getState().connection === 'connected';
  }

  /** Subscribe to connection lifecycle (joined = fresh session, resumed = same session after a drop). */
  onLifecycle(cb: (e: NetLifecycleEvent) => void): () => void {
    this.lifecycle.add(cb);
    return () => this.lifecycle.delete(cb);
  }
  private emitLifecycle(e: NetLifecycleEvent): void {
    for (const cb of this.lifecycle) {
      try {
        cb(e);
      } catch (err) {
        console.error('[net] lifecycle handler failed', err);
      }
    }
  }

  /** Idempotent: concurrent/duplicate calls share one join (React StrictMode safe). */
  connect(opts: ConnectOptions = {}): Promise<void> {
    this.opts = { ...this.opts, ...opts };
    this.intentionalLeave = false;
    this.installGlobalListeners();
    if (this.room) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.doConnect(false).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async doConnect(isRejoin: boolean): Promise<void> {
    const store = useGameStore.getState();
    store.setConnection(isRejoin ? 'reconnecting' : 'connecting');
    try {
      const saved = safeStorage.get(STORAGE_KEYS.session);
      const req = isRejoin ? {} : this.opts;
      const session = await rest.guestSession({ ...req, ...(saved ? { token: saved } : {}) });
      safeStorage.set(STORAGE_KEYS.session, session.token);
      setAuthToken(session.token);

      this.client ??= new Client(serverEndpoint());
      const join: JoinOptions = { protocolVersion: CONFIG.protocolVersion, token: session.token };
      if (!isRejoin) {
        if (this.opts.name) join.name = this.opts.name;
        if (this.opts.appearance) join.appearance = this.opts.appearance;
      }
      if (isRejoin && this.lastPose) join.resume = { ...this.lastPose };
      const room = await this.client.joinOrCreate<WorldStateView>(ROOM_NAME, join);
      if (this.intentionalLeave) {
        await room.leave(true).catch(() => undefined);
        return;
      }
      // Fresh session: forget the previous roster (sessions ids changed).
      useGameStore.setState({ players: {} });
      runtime.remotes.clear();
      this.room = room;
      this.configureReconnection(room);
      this.bind(room);
      this.rejoinAttempt = 0;
      this.stats.joins++;
      if (isRejoin) this.stats.rejoins++;
      store.setSession(room.sessionId, session.profile);
      store.setConnection('connected');
      useGameStore.setState({ reconnectAttempt: 0 });
      this.emitLifecycle('joined');
    } catch (err) {
      if (isRejoin) {
        console.warn('[net] rejoin failed', err instanceof Error ? err.message : err);
        this.scheduleRejoin();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // A handful of quick retries (~15 s) before reporting the error to the UI (which offers "Try again").
      if (isTransient(err) && !this.intentionalLeave && this.rejoinAttempt < 5) {
        // Server not reachable yet (starting / restarting / offline): keep trying; connect() resolves once in.
        const delay = REJOIN_BACKOFF[Math.min(this.rejoinAttempt++, REJOIN_BACKOFF.length - 1)]!;
        console.warn(`[net] connect failed (${message}); retrying in ${delay} ms`);
        store.setConnection('connecting', message);
        useGameStore.setState({ reconnectAttempt: this.rejoinAttempt });
        await new Promise((r) => setTimeout(r, delay));
        return this.doConnect(false);
      }
      console.error('[net] connect failed', err);
      this.rejoinAttempt = 0;
      store.setConnection('error', message);
      throw err;
    }
  }

  private configureReconnection(room: Room<unknown, WorldStateView>): void {
    const r = room.reconnection;
    r.enabled = true;
    // Stay within the server's grace window, then fall back to a fresh join.
    r.maxRetries = 8;
    r.delay = 200;
    r.minDelay = 250;
    r.maxDelay = 3000;
    r.minUptime = 1000;
    r.maxEnqueuedMessages = 0;
  }

  private scheduleRejoin(): void {
    if (this.intentionalLeave || this.room || this.rejoinTimer) return;
    const base = REJOIN_BACKOFF[Math.min(this.rejoinAttempt, REJOIN_BACKOFF.length - 1)]!;
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    this.rejoinAttempt++;
    useGameStore.getState().setConnection('reconnecting', null);
    useGameStore.setState({ reconnectAttempt: this.rejoinAttempt });
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.room || this.intentionalLeave) return;
      if (!this.connecting) {
        this.connecting = this.doConnect(true).finally(() => {
          this.connecting = null;
        });
      }
    }, delay);
  }

  /** Retry a pending fresh rejoin right now (network came back / tab visible). */
  private rejoinNow(): void {
    if (!this.rejoinTimer) return;
    clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    this.rejoinAttempt = Math.max(0, this.rejoinAttempt - 1);
    this.scheduleRejoin();
  }

  private installGlobalListeners(): void {
    if (this.globalListeners || typeof window === 'undefined') return;
    this.globalListeners = true;
    window.addEventListener('online', () => this.rejoinNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.rejoinNow();
    });
  }

  async disconnect(): Promise<void> {
    this.intentionalLeave = true;
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    const room = this.room;
    this.unbind();
    if (room) await room.leave(true).catch(() => undefined);
    useGameStore.getState().setConnection('disconnected');
  }

  /**
   * Typed send. Returns false when not connected or locally rate limited
   * (in which case a synthetic S2C.rateLimited is emitted on the bus so the
   * UI reacts exactly as if the server had refused).
   */
  send<T extends C2SType>(type: T, payload: C2SPayloads[T]): boolean {
    const room = this.room;
    if (!room || useGameStore.getState().connection !== 'connected') {
      this.stats.droppedSends++;
      return false;
    }
    const wait = this.limiter.take(type);
    if (wait > 0) {
      this.stats.limitedSends++;
      if (type !== C2S.move && type !== C2S.typing) this.events.emit(S2C.rateLimited, { action: type, retryInMs: wait });
      return false;
    }
    room.send(type, payload);
    return true;
  }

  on<T extends S2CType>(type: T, handler: (payload: S2CPayloads[T]) => void): () => void {
    return this.events.on(type, handler);
  }

  private bind(room: Room<unknown, WorldStateView>): void {
    const store = useGameStore.getState;

    // Register every S2C type so nothing is "unhandled", and fan out through the bus.
    for (const type of ALL_S2C) {
      this.detach.push(room.onMessage(type, (payload: unknown) => this.events.emit(type, payload as S2CPayloads[typeof type])));
    }

    this.detach.push(
      this.on(S2C.welcome, (w) => {
        store().setClock({ epochMs: w.clockEpoch, dayLengthMs: w.dayLengthMs, offsetMs: w.serverTime - Date.now() });
        store().setProfile(w.profile);
        store().setWorld(w.world);
        store().setLists({ blocked: w.blocked, muted: w.muted });
      }),
      // Corrections are reconciled by player/ (smooth blend, see LocalPlayer); net only records it.
      this.on(S2C.correction, () => {
        runtime.localPlayer.lastCorrectionAt = performance.now();
      }),
      this.on(S2C.profile, (p) => store().setProfile(p)),
    );

    // Structural + low-frequency fields → zustand. Positions → runtime buffers.
    const cb = Callbacks.get(room as unknown as Parameters<typeof Callbacks.get>[0]) as unknown as LooseCallbacks;
    const toInfo = (p: PlayerStateView, id: string): PlayerInfo => ({
      id,
      profileId: p.profileId,
      name: p.name,
      appearance: parseAppearanceJson(p.appearance),
      anim: p.anim,
      animSeq: p.animSeq,
      seat: p.seat,
      held: p.held,
      location: p.location,
      typing: p.typing,
      isLocal: id === room.sessionId,
    });

    const snap = this.snap;
    this.detach.push(
      cb.onAdd('players', (p: PlayerStateView, id: string) => {
        store().upsertPlayer(toInfo(p, id));
        if (id === room.sessionId) {
          Object.assign(runtime.localPlayer, { ready: true, x: p.x, y: p.y, z: p.z, rot: p.rot });
        } else {
          const r = ensureRemote(id);
          r.anim = p.anim;
          snap.t = performance.now();
          snap.x = p.x;
          snap.y = p.y;
          snap.z = p.z;
          snap.rot = p.rot;
          pushInto(r, snap);
        }
        for (const field of ['name', 'appearance', 'anim', 'animSeq', 'seat', 'held', 'location', 'typing'] as const) {
          cb.listen(p, field, () => {
            store().patchPlayer(id, field === 'appearance' ? { appearance: parseAppearanceJson(p.appearance) } : { [field]: p[field] });
            const r = runtime.remotes.get(id);
            if (r && field === 'anim') r.anim = p.anim;
          });
        }
      }),
      cb.onRemove('players', (_p: PlayerStateView, id: string) => {
        store().removePlayer(id);
        removeRemote(id);
      }),
      cb.onAdd('objects', (o: ObjectStateView, id: string) => {
        const copy = (): ObjectStateView => ({ id, active: o.active, value: o.value, holder: o.holder, updatedAt: o.updatedAt });
        store().setObject(copy());
        cb.onChange(o, () => store().setObject(copy()));
      }),
      cb.listen('clockEpoch', (v: number) => store().setClock({ epochMs: v })),
      cb.listen('dayLengthMs', (v: number) => store().setClock({ dayLengthMs: v })),
    );

    // After every patch, push remote poses into interpolation buffers (cheap, no React, no allocation).
    const local = room.sessionId;
    const onPatch = (state: WorldStateView) => {
      this.stats.patches++;
      snap.t = performance.now();
      state.players.forEach((p, id) => {
        if (id === local) return;
        const r = runtime.remotes.get(id);
        if (!r) return;
        snap.x = p.x;
        snap.y = p.y;
        snap.z = p.z;
        snap.rot = p.rot;
        pushInto(r, snap);
      });
    };
    room.onStateChange(onPatch);
    this.detach.push(() => room.onStateChange.remove(onPatch));

    room.onDrop(() => {
      if (this.room !== room) return;
      store().setConnection('reconnecting');
      this.emitLifecycle('dropped');
      this.watchDeadRoom(room);
    });
    room.onReconnect(() => {
      if (this.room !== room) return;
      this.stats.autoReconnects++;
      store().setConnection('connected');
      useGameStore.setState({ reconnectAttempt: 0 });
      this.emitLifecycle('resumed');
    });
    room.onLeave((code) => {
      if (this.room !== room) return;
      this.unbind();
      this.emitLifecycle('left');
      if (this.intentionalLeave) {
        store().setConnection('disconnected', `left (${code})`);
        return;
      }
      // Server restart / failed automatic reconnection / kicked by a crash: rejoin fresh.
      console.warn(`[net] room left unexpectedly (${code}); rejoining`);
      this.scheduleRejoin();
    });
    room.onError((code, message) => console.error('[net] room error', code, message));
  }

  /**
   * While Colyseus retries the old session, probe the server: once it answers
   * again but the session still hasn't resumed, the room is gone (server
   * restart) — abandon it and do a fresh join instead of waiting out every retry.
   */
  private watchDeadRoom(room: Room<unknown, WorldStateView>): void {
    let healthyAt = 0;
    const tick = async () => {
      if (this.room !== room || useGameStore.getState().connection !== 'reconnecting') return;
      let up = false;
      try {
        await rest.health();
        up = true;
      } catch {
        up = false;
      }
      if (this.room !== room || useGameStore.getState().connection !== 'reconnecting') return;
      if (up) {
        healthyAt ||= performance.now();
        if (performance.now() - healthyAt > 2500) {
          console.warn('[net] server is back but the session did not resume; joining fresh');
          void room.leave(true).catch(() => undefined);
          return;
        }
      } else healthyAt = 0;
      setTimeout(() => void tick(), 1000);
    };
    setTimeout(() => void tick(), 1000);
  }

  private unbind(): void {
    for (const d of this.detach.splice(0)) d();
    this.room = null;
    runtime.remotes.clear();
    // Keep the local pose (resume hint + no visual pop) but stop simulating until the next join.
    const lp = runtime.localPlayer;
    if (lp.ready) this.lastPose = { x: lp.x, z: lp.z, rot: lp.rot };
    lp.ready = false;
    this.limiter.reset();
  }
}

/** Callbacks API typed loosely: the client has no schema classes (state comes via reflection). */
interface LooseCallbacks {
  onAdd(collection: string, cb: (value: never, key: string) => void): () => void;
  onRemove(collection: string, cb: (value: never, key: string) => void): () => void;
  onChange(instance: object, cb: () => void): () => void;
  listen(property: string, cb: (value: never, previous: never) => void): () => void;
  listen(instance: object, property: string, cb: (value: never, previous: never) => void): () => void;
}

export const net = new NetClient();
