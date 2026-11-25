/**
 * Read-only debug hook on window for automated tests (scripts/smoke-two-clients.mjs,
 * scripts/e2e-player.mjs) and manual inspection.
 *
 *   window.__ELSEWHERE__.snapshot()   connection, sessionId, players (authoritative room
 *                                     state), local (predicted pose) + extras registered by
 *                                     other modules (camera, nav, remotes, frame stats…)
 *   window.__ELSEWHERE__.query(name, ...args)   read-only helpers registered by modules
 *                                     (e.g. 'worldToScreen', 'isWalkable', 'interactableScreen')
 */
import { runtime } from '../state/runtime.js';
import { useGameStore } from '../state/gameStore.js';
import type { NetClient } from './connection.js';

export interface DebugSnapshot {
  connection: string;
  sessionId: string | null;
  /** Authoritative positions as this client currently sees them in room state. */
  players: { id: string; name: string; x: number; z: number; anim: string; seat: string }[];
  local: { ready: boolean; x: number; z: number; rot: number; anim: string; speed: number };
  net: NetClient['stats'] & { reconnectAttempt: number };
  [extra: string]: unknown;
}

type Extra = () => unknown;
type Query = (...args: never[]) => unknown;
const extras = new Map<string, Extra>();
const queries = new Map<string, Query>();

/** Add a section to snapshot() (must be cheap, JSON-serializable, read-only). */
export function registerDebugSection(name: string, fn: Extra): void {
  extras.set(name, fn);
}
/** Add a read-only query helper. */
export function registerDebugQuery<A extends unknown[]>(name: string, fn: (...args: A) => unknown): void {
  queries.set(name, fn as unknown as Query);
}

declare global {
  interface Window {
    __ELSEWHERE__?: { snapshot(): DebugSnapshot; query(name: string, ...args: unknown[]): unknown };
  }
}

export function installDebugHook(net: NetClient): void {
  window.__ELSEWHERE__ = {
    snapshot() {
      const players: DebugSnapshot['players'] = [];
      net.state?.players?.forEach((p, id) => players.push({ id, name: p.name, x: p.x, z: p.z, anim: p.anim, seat: p.seat }));
      const lp = runtime.localPlayer;
      const snap: DebugSnapshot = {
        connection: useGameStore.getState().connection,
        sessionId: net.sessionId,
        players,
        local: { ready: lp.ready, x: lp.x, z: lp.z, rot: lp.rot, anim: lp.anim, speed: lp.speed ?? 0 },
        net: { ...net.stats, reconnectAttempt: useGameStore.getState().reconnectAttempt ?? 0 },
        view: { ...runtime.view },
      };
      for (const [k, fn] of extras) {
        try {
          snap[k] = fn();
        } catch (err) {
          snap[k] = { error: String(err) };
        }
      }
      return snap;
    },
    query(name: string, ...args: unknown[]) {
      const fn = queries.get(name);
      if (!fn) throw new Error(`unknown debug query ${name}`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    },
  };
}
