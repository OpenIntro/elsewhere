/**
 * Colyseus connection: session token (REST), join, state→store bridging,
 * remote snapshots, typed send helpers, reconnection.
 *
 * Usage: `await net.connect({ name, appearance })`; `net.send(C2S.move, …)`;
 * `net.on(S2C.chat, handler)`.
 */
import { Callbacks, Client, type Room } from '@colyseus/sdk';
import {
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
import { runtime } from '../state/runtime.js';
import { STORAGE_KEYS, safeStorage } from '../state/storage.js';
import { ServerEvents } from './events.js';
import { pushSnapshot, removeRemote } from './interpolation.js';
import { rest, setAuthToken } from './rest.js';

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

export class NetClient {
  readonly events = new ServerEvents();
  private client: Client | null = null;
  private room: Room<unknown, WorldStateView> | null = null;
  private detach: (() => void)[] = [];

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /** Raw room state (read-only). Prefer stores/runtime in UI code. */
  get state(): WorldStateView | null {
    return (this.room?.state as WorldStateView | undefined) ?? null;
  }

  private connecting: Promise<void> | null = null;

  /** Idempotent: concurrent/duplicate calls share one join (React StrictMode safe). */
  connect(opts: ConnectOptions = {}): Promise<void> {
    if (this.room) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.doConnect(opts).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async doConnect(opts: ConnectOptions): Promise<void> {
    const store = useGameStore.getState();
    store.setConnection('connecting');
    try {
      const saved = safeStorage.get(STORAGE_KEYS.session);
      const session = await rest.guestSession({ ...opts, ...(saved ? { token: saved } : {}) });
      safeStorage.set(STORAGE_KEYS.session, session.token);
      setAuthToken(session.token);

      this.client = new Client(serverEndpoint());
      const join: JoinOptions = { protocolVersion: CONFIG.protocolVersion, token: session.token };
      if (opts.name) join.name = opts.name;
      if (opts.appearance) join.appearance = opts.appearance;
      const room = await this.client.joinOrCreate<WorldStateView>(ROOM_NAME, join);
      this.room = room;
      this.bind(room);
      store.setSession(room.sessionId, session.profile);
      store.setConnection('connected');
    } catch (err) {
      console.error('[net] connect failed', err);
      store.setConnection('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.unbind();
    if (room) await room.leave(true).catch(() => undefined);
    useGameStore.getState().setConnection('disconnected');
  }

  send<T extends C2SType>(type: T, payload: C2SPayloads[T]): void {
    this.room?.send(type, payload);
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
      this.on(S2C.correction, (c) => {
        const lp = runtime.localPlayer;
        lp.x = c.x;
        lp.z = c.z;
        lp.y = c.y;
        lp.lastCorrectionAt = performance.now();
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

    this.detach.push(
      cb.onAdd('players', (p: PlayerStateView, id: string) => {
        store().upsertPlayer(toInfo(p, id));
        if (id === room.sessionId) {
          Object.assign(runtime.localPlayer, { ready: true, x: p.x, y: p.y, z: p.z, rot: p.rot });
        } else {
          pushSnapshot(id, { t: performance.now(), x: p.x, y: p.y, z: p.z, rot: p.rot });
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

    // After every patch, push remote poses into interpolation buffers (cheap, no React).
    const onPatch = (state: WorldStateView) => {
      const now = performance.now();
      state.players.forEach((p, id) => {
        if (id !== room.sessionId) pushSnapshot(id, { t: now, x: p.x, y: p.y, z: p.z, rot: p.rot });
      });
    };
    room.onStateChange(onPatch);
    this.detach.push(() => room.onStateChange.remove(onPatch));

    room.onDrop(() => store().setConnection('reconnecting'));
    room.onReconnect(() => store().setConnection('connected'));
    room.onLeave((code) => {
      store().setConnection('disconnected', `left (${code})`);
      this.unbind();
    });
    room.onError((code, message) => console.error('[net] room error', code, message));
  }

  private unbind(): void {
    for (const d of this.detach.splice(0)) d();
    this.room = null;
    runtime.remotes.clear();
    runtime.localPlayer.ready = false;
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
