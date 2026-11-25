/**
 * Read-only debug hook on window for automated tests (scripts/smoke-two-clients.mjs)
 * and manual inspection. Reads straight from the synced room state.
 */
import { runtime } from '../state/runtime.js';
import { useGameStore } from '../state/gameStore.js';
import type { NetClient } from './connection.js';

export interface DebugSnapshot {
  connection: string;
  sessionId: string | null;
  /** Authoritative positions as this client currently sees them in room state. */
  players: { id: string; name: string; x: number; z: number; anim: string }[];
  local: { ready: boolean; x: number; z: number };
}

declare global {
  interface Window {
    __ELSEWHERE__?: { snapshot(): DebugSnapshot };
  }
}

export function installDebugHook(net: NetClient): void {
  window.__ELSEWHERE__ = {
    snapshot() {
      const players: DebugSnapshot['players'] = [];
      net.state?.players.forEach((p, id) => players.push({ id, name: p.name, x: p.x, z: p.z, anim: p.anim }));
      const lp = runtime.localPlayer;
      return { connection: useGameStore.getState().connection, sessionId: net.sessionId, players, local: { ready: lp.ready, x: lp.x, z: lp.z } };
    },
  };
}
