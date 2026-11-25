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
  pieceColliders,
  type PieceRecord,
  type PieceView,
  type PieceWire,
  S2C,
} from '@elsewhere/shared';
import { net, registerDebugSection } from '../net/index.js';
import { refreshNavRect } from '../player/index.js';
import { useGameStore } from '../state/gameStore.js';
import { toasts } from '../ui/toasts.js';
import { reaim } from './actions.js';
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

/** Accumulates the snapshot until the last chunk arrives (applied in one go). */
let incoming: PieceRecord[] | null = null;
const stats = { snapshots: 0, snapshotChunks: 0, snapshotBytes: 0, lastSnapshotMs: 0, placed: 0, removed: 0, results: { ok: 0, refused: 0 } };
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
  return p;
}

function fromView(v: PieceView): PieceRecord {
  const p: PieceRecord = { id: v.id, kind: v.kind, variant: v.variant, x: v.x, z: v.z, rot: v.rot, level: v.level, y: v.y, ownerId: v.ownerId, ownerName: v.ownerName };
  if (v.text) p.text = v.text;
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
    net.on(S2C.buildResult, (r) => {
      const st = useBuildStore.getState();
      const pending = Math.max(0, st.pending - 1);
      if (r.ok) {
        stats.results.ok++;
        if (r.action === 'place' && r.pieceId) st.set({ pending, undo: [...st.undo.slice(-49), r.pieceId], refusal: null });
        else st.set({ pending, refusal: null });
      } else {
        stats.results.refused++;
        st.set({ pending, refusal: { text: r.message ?? 'Not here', at: Date.now() } });
      }
    }),
  ];

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
        .map((p) => ({ id: p.id, kind: p.kind, variant: p.variant, x: p.x, z: p.z, rot: p.rot, level: p.level, y: p.y, ownerId: p.ownerId, ...(p.text ? { text: p.text } : {}) })),
    };
  });

  return () => {
    for (const off of offs) off();
    installed = false;
  };
}
