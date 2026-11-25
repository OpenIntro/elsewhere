/**
 * Per-frame accessors for synced object visuals (see ObjectStateView docs in
 * shared/protocol.ts), with dev overrides layered on top. Cheap: read the
 * zustand store directly (no React subscriptions).
 */
import { CONFIG, getInteractable } from '@elsewhere/shared';
import { useGameStore } from '../state/gameStore.js';
import { devOverrides, env } from './env.js';

const objects = () => useGameStore.getState().objects;

export const FOUNTAIN_MAX_STAGE = CONFIG.collective.fountainStages.length;

export function lightOn(id: string): boolean {
  // When the clock is overridden locally, follow the overridden clock (server state would disagree).
  if (devOverrides.time !== null) return env.lightsOn;
  const o = objects()[id];
  return o ? o.active : env.lightsOn;
}

export function doorOpen(id: string): boolean {
  if (devOverrides.doorsOpen !== null) return devOverrides.doorsOpen;
  return objects()[id]?.active ?? false;
}

export function bellRings(id: string): number {
  return objects()[id]?.value ?? 0;
}

export function fountainStage(): number {
  if (devOverrides.fountainStage !== null) return Math.max(0, Math.min(FOUNTAIN_MAX_STAGE, Math.round(devOverrides.fountainStage)));
  const o = objects()['fountain'];
  const s = o ? o.value : useGameStore.getState().world.fountainStage;
  return Math.max(0, Math.min(FOUNTAIN_MAX_STAGE, s | 0));
}

export function portalAwake(): boolean {
  if (devOverrides.portalAwake !== null) return devOverrides.portalAwake;
  const o = objects()['portal_arch'];
  return o ? o.active : useGameStore.getState().world.portalAwake;
}

export function runeLit(id: string): boolean {
  if (devOverrides.runesLit !== null) return devOverrides.runesLit;
  if (devOverrides.portalAwake) return true;
  return objects()[id]?.active ?? false;
}

/** Pickup visible at its spot (not held by anyone). */
export function pickupPresent(id: string): boolean {
  const o = objects()[id];
  if (!o) return true;
  return o.active && !o.holder;
}

export function seatMask(id: string): number {
  return objects()[id]?.value ?? 0;
}

export function exists(id: string): boolean {
  return getInteractable(id) !== undefined;
}
