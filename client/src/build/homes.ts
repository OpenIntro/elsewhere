/**
 * Homes on the client: the world's homes as the server sent them (S2C.homes
 * after the build snapshot, then S2C.homeChanged; fed from sync.ts), the
 * outcome of this player's own requests, and the three requests. The server
 * decides everything (shared/src/homes.ts is used here only to offer the
 * button on a house that would qualify); `pinned` already arrives filtered
 * for this viewer. Read-only `snapshot().homes` for tests.
 */
import { create } from 'zustand';
import { C2S, checkHouse, footprintOf, insideHome, type HomeChangedPayload, type HomeResultPayload, type HomeWire, type House, type PieceRecord } from '@elsewhere/shared';
import { net, registerDebugSection } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { pieces } from './store.js';

export interface HomesUiState {
  /** profileId → home. */
  homes: Record<string, HomeWire>;
  /** Set once the first S2C.homes arrived. */
  synced: boolean;
  /** The last answer to this player's own request. */
  result: (HomeResultPayload & { at: number }) | null;
  /** Requests in flight. */
  pending: number;
  /** Bumped on every change (cheap subscription key). */
  version: number;
  set(patch: Partial<HomesUiState>): void;
}

export const useHomesStore = create<HomesUiState>((set) => ({
  homes: {},
  synced: false,
  result: null,
  pending: 0,
  version: 0,
  set: (patch) => set(patch),
}));

const stats = { lists: 0, changes: 0, results: { ok: 0, refused: 0 } };

export function applyHomes(list: readonly HomeWire[]): void {
  const homes: Record<string, HomeWire> = {};
  for (const h of list) homes[h.profileId] = h;
  stats.lists++;
  const st = useHomesStore.getState();
  st.set({ homes, synced: true, version: st.version + 1 });
}

export function applyHomeChanged(c: HomeChangedPayload): void {
  const st = useHomesStore.getState();
  const homes = { ...st.homes };
  if ('home' in c) homes[c.home.profileId] = c.home;
  else delete homes[c.profileId];
  stats.changes++;
  st.set({ homes, version: st.version + 1 });
}

export function applyHomeResult(r: HomeResultPayload): void {
  const st = useHomesStore.getState();
  if (r.ok) stats.results.ok++;
  else stats.results.refused++;
  st.set({ result: { ...r, at: Date.now() }, pending: Math.max(0, st.pending - 1) });
}

/** Forget everything (a new join: the snapshot follows). */
export function resetHomes(): void {
  useHomesStore.getState().set({ homes: {}, synced: false, pending: 0 });
}

function send(type: typeof C2S.homeSet | typeof C2S.homeClear | typeof C2S.homePin, payload: object): boolean {
  const ok = net.send(type, payload as never);
  if (ok) {
    const st = useHomesStore.getState();
    st.set({ pending: st.pending + 1, result: null });
  }
  return ok;
}
export const homeActions = {
  /** Make the house this piece of yours belongs to your home. */
  set: (pieceId: string) => send(C2S.homeSet, { pieceId }),
  clear: () => send(C2S.homeClear, {}),
  pin: (on: boolean) => send(C2S.homePin, { on }),
};

export function myProfileId(): string | undefined {
  return useGameStore.getState().profile?.profileId;
}
export function myHome(): HomeWire | null {
  const me = myProfileId();
  return (me && useHomesStore.getState().homes[me]) || null;
}

/** The house one of the local player's pieces belongs to, if it would qualify (only offers the button; the server decides). */
export function houseOfPiece(pieceId: string): House | null {
  const p = pieces.index.get(pieceId);
  if (!p) return null;
  const f = footprintOf(p);
  const own = pieces.index.query(f, 13).filter((q) => q.ownerId === p.ownerId);
  const r = checkHouse<PieceRecord>(own, pieceId);
  return r.ok ? r.house : null;
}

/** Players whose positions this room instance syncs that stand inside the home's room (never an estimate). */
export function insideCount(home: HomeWire): number {
  let n = 0;
  net.state?.players?.forEach((p) => {
    if (insideHome(home, { x: p.x, z: p.z })) n++;
  });
  return n;
}

/** The home whose room is nearest to (x, z), within `max` metres of its outline (0 inside). */
export function homeNear(x: number, z: number, max: number): HomeWire | null {
  let best: HomeWire | null = null;
  let bd = max;
  for (const h of Object.values(useHomesStore.getState().homes)) {
    const r = h.rect;
    const dx = Math.max(r.minX - x, 0, x - r.maxX);
    const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
    const d = Math.hypot(dx, dz);
    if (d <= bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

let registered = false;
export function registerHomesDebug(): void {
  if (registered) return;
  registered = true;
  registerDebugSection('homes', () => {
    const st = useHomesStore.getState();
    const me = myProfileId();
    return {
      synced: st.synced,
      pending: st.pending,
      result: st.result,
      mine: me ? (st.homes[me] ?? null) : null,
      homes: Object.values(st.homes)
        .map((h) => ({ ...h, rect: { ...h.rect }, inside: insideCount(h) }))
        .sort((a, b) => (a.profileId < b.profileId ? -1 : 1)),
      stats: { ...stats, results: { ...stats.results } },
    };
  });
}
