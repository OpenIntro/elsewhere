/**
 * Piece sync: applies S2C.buildSnapshot (chunked, on join) and the
 * S2C.buildPlaced / S2C.buildRemoved deltas to the local piece index, the
 * shared dynamic collider layer (so client prediction collides exactly like
 * the server) and the click-to-move nav grid. Also handles S2C.buildResult
 * for the local player's own requests and registers the read-only `build`
 * debug section.
 */
import {
  C2S,
  CONFIG,
  PIECES,
  PIECE_KINDS,
  defaultCollisionWorld,
  footprint,
  natureItem,
  pieceColliders,
  pieceIdOfInteract,
  pieceSeatInteractable,
  registerInteractableResolver,
  type PieceRecord,
  type PieceView,
  type Interactable,
  type PieceWire,
  S2C,
} from '@elsewhere/shared';
import { net, registerDebugQuery, registerDebugSection } from '../net/index.js';
import { refreshNavRect, setExtraInteractables } from '../player/index.js';
import { useGameStore } from '../state/gameStore.js';
import { toasts } from '../ui/toasts.js';
import { afterPlaced, reaim, roofToolProbes } from './actions.js';
import { natureVisible, resetNatureHidden, setNatureHidden } from '../world/natureMask.js';
import { markDirty, pieces, useBuildStore } from './store.js';

/** The world changed: re-check the ghost where it is (it may now be blocked, or stackable). */
let reaimTimer: ReturnType<typeof setTimeout> | null = null;
function reaimSoon(): void {
  if (reaimTimer) return;
  reaimTimer = setTimeout(() => {
    reaimTimer = null;
    reaim();
  }, 16);
}

const collision = () => defaultCollisionWorld();

/** Cleared bushes / rocks: collider off (rocks), nav grid re-sampled, visual hidden, UI set updated. */
function applyCleared(ids: readonly string[], on: boolean, reset = false): void {
  const st = useBuildStore.getState();
  const next = reset ? new Set<string>() : new Set(st.cleared);
  if (reset) for (const id of st.cleared) if (!ids.includes(id)) refreshNature(id, false);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
    refreshNature(id, on);
  }
  if (reset) resetNatureHidden(ids);
  else setNatureHidden(ids, on);
  st.set({ cleared: next, selectedNature: st.selectedNature && !on ? st.selectedNature : null });
  reaimSoon();
}
function refreshNature(id: string, on: boolean): void {
  const n = natureItem(id);
  if (!n) return;
  if (n.colliderId) {
    if (on) collision().disabled.add(n.colliderId);
    else collision().disabled.delete(n.colliderId);
  }
  refreshNavRect(n.position.x - n.radius - 0.5, n.position.z - n.radius - 0.5, n.position.x + n.radius + 0.5, n.position.z + n.radius + 0.5);
}

/** Accumulates the snapshot until the last chunk arrives (applied in one go). */
let incoming: PieceRecord[] | null = null;
const stats = { snapshots: 0, snapshotChunks: 0, snapshotBytes: 0, lastSnapshotMs: 0, placed: 0, removed: 0, cleared: 0, restored: 0, results: { ok: 0, refused: 0 } };
let snapshotStartedAt = 0;

function fromWire(w: PieceWire, owners: [string, string][]): PieceRecord | null {
  const kind = PIECE_KINDS[w[1]];
  if (!kind) return null;
  const owner = owners[w[8]] ?? ['', ''];
  const p: PieceRecord = {
    id: w[0],
    kind,
    variant: PIECES[kind].variants[w[2]]?.id ?? PIECES[kind].variants[0]!.id,
    x: w[3] / 2,
    z: w[4] / 2,
    rot: w[5],
    level: w[6],
    y: w[7] / 100,
    ownerId: owner[0],
    ownerName: owner[1],
  };
  if (w[9]) p.text = w[9];
  if (w[10]) p.params = w[10];
  return p;
}

function fromView(v: PieceView): PieceRecord {
  const p: PieceRecord = { id: v.id, kind: v.kind, variant: v.variant, x: v.x, z: v.z, rot: v.rot, level: v.level, y: v.y, ownerId: v.ownerId, ownerName: v.ownerName };
  if (v.text) p.text = v.text;
  if (v.params) p.params = v.params;
  return p;
}

function refreshNav(p: PieceRecord): void {
  if (p.level !== 0 || !PIECES[p.kind].solid) return;
  const f = footprint(p.kind, p.x, p.z, p.rot);
  refreshNavRect(f.minX, f.minZ, f.maxX, f.maxZ);
}

function addPiece(p: PieceRecord): void {
  pieces.index.add(p);
  const cols = pieceColliders(p);
  if (cols.length) collision().dynamic.set(p.id, cols);
}

function removePiece(id: string): PieceRecord | undefined {
  const p = pieces.index.remove(id);
  collision().dynamic.remove(id);
  return p;
}

function applySnapshot(list: PieceRecord[]): void {
  // Replace everything: drop colliders of pieces we knew about, then add the snapshot.
  for (const p of pieces.index.all()) collision().dynamic.remove(p.id);
  pieces.index.clear();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of list) {
    addPiece(p);
    if (p.level === 0 && PIECES[p.kind].solid) {
      const f = footprint(p.kind, p.x, p.z, p.rot);
      minX = Math.min(minX, f.minX);
      minZ = Math.min(minZ, f.minZ);
      maxX = Math.max(maxX, f.maxX);
      maxZ = Math.max(maxZ, f.maxZ);
    }
  }
  if (Number.isFinite(minX)) refreshNavRect(minX, minZ, maxX, maxZ);
  markDirty(null);
  const st = useBuildStore.getState();
  st.set({ synced: true, version: st.version + 1, undo: st.undo.filter((id) => pieces.index.get(id)), selected: null });
}

let installed = false;

export function installBuildSync(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const offs = [
    net.onLifecycle((e) => {
      if (e === 'joined') useBuildStore.getState().set({ synced: false, pending: 0 });
      // Same session after an automatic reconnection: deltas sent while we were away are lost, so ask again.
      if (e === 'resumed') {
        useBuildStore.getState().set({ pending: 0 });
        net.send(C2S.buildSync, {});
      }
    }),
    net.on(S2C.buildSnapshot, (s) => {
      if (s.reset || !incoming) {
        incoming = [];
        snapshotStartedAt = performance.now();
      }
      if (s.cleared) applyCleared(s.cleared, true, true);
      stats.snapshotChunks++;
      stats.snapshotBytes += JSON.stringify(s).length;
      for (const w of s.pieces) {
        const p = fromWire(w, s.owners);
        if (p) incoming.push(p);
      }
      if (s.done) {
        const list = incoming;
        incoming = null;
        applySnapshot(list);
        stats.snapshots++;
        stats.lastSnapshotMs = performance.now() - snapshotStartedAt;
      }
    }),
    net.on(S2C.buildPlaced, ({ piece }) => {
      const p = fromView(piece);
      addPiece(p);
      refreshNav(p);
      markDirty(p.kind);
      stats.placed++;
      // Pieces placed while the snapshot is still streaming must survive it.
      incoming?.push(p);
      const st = useBuildStore.getState();
      st.set({ version: st.version + 1 });
      reaimSoon();
    }),
    net.on(S2C.buildRemoved, ({ ids, by }) => {
      const me = useGameStore.getState().profile?.profileId;
      let mine = 0;
      for (const id of ids) {
        const p = removePiece(id);
        if (!p) continue;
        if (p.ownerId === me) mine++;
        refreshNav(p);
        markDirty(p.kind);
        stats.removed++;
      }
      if (incoming) incoming = incoming.filter((p) => !ids.includes(p.id));
      const st = useBuildStore.getState();
      st.set({ version: st.version + 1, undo: st.undo.filter((id) => !ids.includes(id)), selected: st.selected && ids.includes(st.selected) ? null : st.selected });
      reaimSoon();
      if (by === 'admin' && mine > 0) toasts.push({ level: 'warning', text: mine === 1 ? 'A moderator removed one of your pieces.' : `A moderator removed ${mine} of your pieces.`, ttlMs: 6000 });
    }),
    net.on(S2C.natureCleared, ({ ids }) => {
      stats.cleared += ids.length;
      applyCleared(ids, true);
    }),
    net.on(S2C.natureRestored, ({ ids }) => {
      stats.restored += ids.length;
      applyCleared(ids, false);
    }),
    net.on(S2C.buildUpdated, ({ piece }) => {
      const p = fromView(piece);
      addPiece(p);
      markDirty(p.kind);
      const st = useBuildStore.getState();
      st.set({ version: st.version + 1 });
    }),
    net.on(S2C.buildResult, (r) => {
      const st = useBuildStore.getState();
      const pending = Math.max(0, st.pending - 1);
      if (r.ok) {
        stats.results.ok++;
        if (r.action === 'place' && r.pieceId) {
          st.set({ pending, undo: [...st.undo.slice(-49), r.pieceId], refusal: null });
          afterPlaced(r.reqId);
        } else st.set({ pending, refusal: null });
      } else {
        stats.results.refused++;
        st.set({ pending, refusal: { text: r.message ?? 'Not here', at: Date.now() } });
      }
    }),
  ];

  // Built seats are interactables ("bp:<pieceId>") for the sit flow (targeting, getSeat, seated rendering).
  registerInteractableResolver((id) => {
    const pid = pieceIdOfInteract(id);
    const p = pid ? pieces.index.get(pid) : undefined;
    return p ? (pieceSeatInteractable(p) ?? undefined) : undefined;
  });

  setExtraInteractables((x, z, r) => {
    const out: Interactable[] = [];
    for (const p of pieces.index.query({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r })) {
      if (!PIECES[p.kind].seats) continue;
      const it = pieceSeatInteractable(p);
      if (it) out.push(it);
    }
    return out;
  });

  registerDebugSection('build', () => {
    const b = useBuildStore.getState();
    const me = useGameStore.getState().profile?.profileId;
    const list = [...pieces.index.all()];
    return {
      synced: b.synced,
      mode: b.mode,
      kind: b.kind,
      rot: b.rot,
      ghost: b.ghost,
      selected: b.selected,
      selectedNature: b.selectedNature,
      lockLevel: b.lockLevel,
      editing: b.editing,
      roof: { style: b.roofStyle, pitch: b.roofPitch, probes: roofToolProbes().map((p) => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 })) },
      cleared: [...b.cleared].sort(),
      disabledColliders: [...collision().disabled].sort(),
      refusal: b.refusal,
      pending: b.pending,
      count: list.length,
      mine: me ? list.filter((p) => p.ownerId === me).length : 0,
      colliders: collision().dynamic.size,
      stats: { ...stats, results: { ...stats.results } },
      maxLevel: CONFIG.building.maxLevel,
      // Compact list for tests (sorted by id): kind, position, level, y, owner, text.
      pieces: list
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, 5000)
        .map((p) => ({ id: p.id, kind: p.kind, variant: p.variant, x: p.x, z: p.z, rot: p.rot, level: p.level, y: p.y, ownerId: p.ownerId, ...(p.text ? { text: p.text } : {}), ...(p.params ? { params: p.params } : {}) })),
    };
  });
  registerDebugQuery('natureVisible', (id: string) => natureVisible(id));

  return () => {
    for (const off of offs) off();
    installed = false;
  };
}
