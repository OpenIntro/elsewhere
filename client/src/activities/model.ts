/**
 * Client view of building activities: typed accessors over the synced
 * `activities` / `keepers` state (net/ bridges them into useGameStore) and
 * small pure helpers shared by the 3D layer and the panels.
 */
import {
  ACTIVITY_KEYS,
  getInteractable,
  getStation,
  parseActivityData,
  worldTimeAt,
  type ActivityStateView,
  type BoardEntry,
  type NetsData,
  type PollData,
  type ProjectData,
} from '@elsewhere/shared';
import { serverNow, useGameStore, type GameState } from '../state/gameStore.js';

export const EMPTY_POLL: PollData = { key: '', question: '', options: [], tallies: [], endDay: 0, last: null };
export const EMPTY_PROJECT: ProjectData = { projectId: '', index: 0, stage: 0, stages: 0, contributions: 0, distinct: 0, need: { contributions: 1, distinct: 1 }, completed: [], total: 0 };

export function activity(s: Pick<GameState, 'activities'>, key: string): ActivityStateView | undefined {
  return s.activities[key];
}
export const boardEntries = (a: ActivityStateView | undefined): BoardEntry[] => parseActivityData<{ entries: BoardEntry[] }>(a?.data, { entries: [] }).entries ?? [];
export const pollData = (a: ActivityStateView | undefined): PollData => ({ ...EMPTY_POLL, ...parseActivityData<Partial<PollData>>(a?.data, {}) });
export const projectData = (a: ActivityStateView | undefined): ProjectData => ({ ...EMPTY_PROJECT, ...parseActivityData<Partial<ProjectData>>(a?.data, {}) });
export const netsData = (a: ActivityStateView | undefined): NetsData => parseActivityData<NetsData>(a?.data, { sections: 5, nets: 0 });

/** Hook: one synced activity entry (re-renders only when it changes). */
export function useActivity(key: string): ActivityStateView | undefined {
  return useGameStore((s) => s.activities[key]);
}

/** Entries a viewer should see: blocked / muted authors are hidden on this client too. */
export function visibleEntries(entries: readonly BoardEntry[], blocked: readonly string[], muted: readonly string[]): BoardEntry[] {
  const hide = new Set([...blocked, ...muted]);
  return entries.filter((e) => !hide.has(e.p));
}

/** Real count of players inside a building right now (server presence; 0 is honest). */
export function insideCount(s: Pick<GameState, 'activities'>, buildingId: string): number | null {
  const a = s.activities[ACTIVITY_KEYS.building(buildingId)];
  return a ? Math.max(0, Math.round(a.value)) : null;
}
export function isOpen(s: Pick<GameState, 'activities'>, buildingId: string): boolean | null {
  const a = s.activities[ACTIVITY_KEYS.building(buildingId)];
  return a ? a.active : null;
}

export function worldNow(): { day: number; hours: number } {
  const { epochMs, dayLengthMs } = useGameStore.getState().clock;
  const t = worldTimeAt(serverNow(), { epochMs, dayLengthMs });
  return { day: t.day, hours: t.hours };
}

/** The interior an activity panel belongs to (station or keeper interactable id). */
export function interiorOfPanel(id: string): string | null {
  const it = getInteractable(id);
  if (it && (it.kind === 'station' || it.kind === 'keeper')) return it.interiorId;
  return getStation(id)?.interiorId ?? null;
}

export function relTime(ts: number, now = serverNow()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
export function leftTime(until: number, now = serverNow()): string {
  const m = Math.max(0, Math.round((until - now) / 60_000));
  if (m < 60) return `${m} min left`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h left`;
  return `${Math.round(h / 24)} days left`;
}

/** A station's prompt label given live state (e.g. a lit hearth is warmed at, not lit again). */
export function liveStationLabel(s: Pick<GameState, 'activities'>, interactableId: string, fallback: string): string {
  const st = getStation(interactableId);
  if (!st) return fallback;
  if (st.kind === 'hearth') {
    const a = s.activities[ACTIVITY_KEYS.hearth(st.interiorId)];
    return a?.active && a.value > serverNow() ? 'Warm your hands' : fallback;
  }
  if (st.kind === 'kettle') {
    const a = s.activities[ACTIVITY_KEYS.kettle(st.interiorId)];
    return a?.active ? 'Check the kettle' : fallback;
  }
  return fallback;
}
