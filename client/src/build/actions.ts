/**
 * Build-mode actions: enter/leave, choose a piece, rotate, aim the ghost from
 * a screen point (shared validation → green/red + reason), place, remove,
 * undo, report, unstuck. The server re-validates everything.
 */
import {
  C2S,
  CONFIG,
  PIECES,
  autoLevel,
  pieceTop,
  refusalText,
  snapToGrid,
  validatePlacement,
  type PieceKind,
  type Vec2,
} from '@elsewhere/shared';
import { net } from '../net/index.js';
import { cancelPath, groundFromScreen } from '../player/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { toasts } from '../ui/toasts.js';
import { pickPiece, pickPieceHit, rayAtHeight, screenRay } from './picking.js';
import { pieces, useBuildStore, variantFor } from './store.js';

let reqSeq = 0;
/** Last aimed ground point (re-validated when the rotation/piece changes). */
let lastAim: (Vec2 & { level?: number }) | null = null;

export function isBuilding(): boolean {
  return useBuildStore.getState().mode !== 'off';
}

export function enterBuild(mode: 'place' | 'remove' = 'place'): void {
  const ui = useUiStore.getState();
  ui.closePanel();
  if (ui.chatOpen && window.matchMedia('(max-width: 720px), (max-height: 500px)').matches) ui.setChatOpen(false);
  cancelPath();
  useBuildStore.getState().set({ mode, selected: null, refusal: null });
  if (mode === 'place') reaim();
}

export function exitBuild(): void {
  useBuildStore.getState().set({ mode: 'off', ghost: null, selected: null, refusal: null });
  lastAim = null;
}

export function toggleBuild(): void {
  if (isBuilding()) exitBuild();
  else enterBuild('place');
}

export function setTool(mode: 'place' | 'remove'): void {
  useBuildStore.getState().set({ mode, selected: null, refusal: null, ...(mode === 'remove' ? { ghost: null } : {}) });
  if (mode === 'place') reaim();
}

export function selectKind(kind: PieceKind): void {
  useBuildStore.getState().set({ kind, mode: 'place', selected: null, refusal: null });
  reaim();
}

export function selectVariant(kind: PieceKind, variant: string): void {
  const st = useBuildStore.getState();
  st.set({ variants: { ...st.variants, [kind]: variant } });
  reaim();
}

export function rotate(dir = 1): void {
  const st = useBuildStore.getState();
  st.set({ rot: (((st.rot + dir) % 4) + 4) % 4 });
  reaim();
}

export function setSignText(text: string): void {
  useBuildStore.getState().set({ signText: text.slice(0, CONFIG.building.signMaxLength) });
}

/** Where the local player and everyone else stand (for the "someone is standing there" preview). */
function playerPositions(): Vec2[] {
  const out: Vec2[] = [];
  const lp = runtime.localPlayer;
  if (lp.ready) out.push({ x: lp.x, z: lp.z });
  for (const r of runtime.remotes.values()) if (r.render?.visible !== false && r.render) out.push({ x: r.render.x, z: r.render.z });
  return out;
}

function placementContext() {
  const me = useGameStore.getState().profile?.profileId ?? '';
  const lp = runtime.localPlayer;
  return { index: pieces.index, builderId: me, builderPos: lp.ready ? { x: lp.x, z: lp.z } : null, players: playerPositions() };
}

/** Validate the current piece at a ground point (lowest valid storey) and update the ghost. */
export function aimAt(p: Vec2, level?: number): void {
  lastAim = { x: p.x, z: p.z, ...(level !== undefined ? { level } : {}) };
  const st = useBuildStore.getState();
  if (st.mode !== 'place') return;
  const snapped = snapToGrid(st.kind, p, st.rot);
  const base = { kind: st.kind, variant: variantFor(st.kind), x: snapped.x, z: snapped.z, rot: st.rot };
  let res = level !== undefined ? validatePlacement({ ...base, level }, placementContext()) : autoLevel(base, placementContext());
  if (!res.ok && level !== undefined) res = autoLevel(base, placementContext());
  if (res.ok) st.set({ ghost: { x: res.x, z: res.z, level: res.level, y: res.y, ok: true, message: '' } });
  else st.set({ ghost: { x: snapped.x, z: snapped.z, level: st.ghost?.x === snapped.x && st.ghost?.z === snapped.z ? st.ghost.level : 0, y: NaN, ok: false, message: refusalText(res.reason, res.label) } });
}

/** Re-run validation at the last aim point (piece/rotation changed, the world changed). */
export function reaim(): void {
  if (useBuildStore.getState().mode !== 'place') return;
  if (lastAim) return aimAt(lastAim, lastAim.level);
  // First aim: a couple of metres in front of the player.
  const lp = runtime.localPlayer;
  if (lp.ready) aimAt({ x: lp.x + Math.sin(lp.rot) * 2.5, z: lp.z + Math.cos(lp.rot) * 2.5 });
}

/**
 * Aim from a screen point (mouse hover / tap): you build on what you point at.
 *  1. The top of one of your walls/pillars under the cursor → the next storey
 *     there; the top of an upper floor → that storey.
 *  2. Roof pieces (never on the ground): the camera ray is crossed with the
 *     real top heights of nearby pieces and the highest storey where the roof
 *     is valid wins, so pointing at the top of your walls puts a roof there.
 *  3. Otherwise the ground under the cursor (lowest valid storey, so a wall
 *     aimed at an existing wall climbs onto it); an upper result is re-aimed
 *     at its own height so the ghost stays under the cursor.
 */
export function aimFromScreen(clientX: number, clientY: number): void {
  const st = useBuildStore.getState();
  if (st.mode !== 'place') return;
  const g = groundFromScreen(clientX, clientY);
  const r = screenRay(clientX, clientY);
  const ctx = placementContext();
  const variant = variantFor(st.kind);
  const valid = (p: Vec2, level: number) => {
    const s = snapToGrid(st.kind, p, st.rot);
    return validatePlacement({ kind: st.kind, variant, x: s.x, z: s.z, rot: st.rot, level }, ctx).ok;
  };
  const def = PIECES[st.kind];
  // 1. Pointing at a piece's top face.
  const hit = r ? pickPieceHit(clientX, clientY) : null;
  const q = hit ? pieces.index.get(hit.id) : undefined;
  if (q && hit && hit.normalY > 0.6) {
    const qd = PIECES[q.kind];
    const level = qd.structural ? q.level + 1 : q.kind === 'floor' && q.level > 0 ? q.level : -1;
    if (level >= def.minLevel && level <= def.maxLevel && valid(hit.point, level)) return aimAt(hit.point, level);
  }
  // 2. Roofs: the highest storey top under the cursor.
  if (r && g && def.minLevel >= 1) {
    const heights = new Map<string, { h: number; level: number }>();
    for (const p of pieces.index.query({ minX: g.x - 14, maxX: g.x + 14, minZ: g.z - 14, maxZ: g.z + 14 })) {
      if (!PIECES[p.kind].structural || p.level + 1 > CONFIG.building.maxLevel) continue;
      const h = pieceTop(p);
      heights.set(`${Math.round(h * 20)}|${p.level + 1}`, { h, level: p.level + 1 });
    }
    let best: { p: Vec2; level: number } | null = null;
    for (const { h, level } of heights.values()) {
      if (best && level <= best.level) continue;
      const p = rayAtHeight(r, h);
      if (p && valid(p, level)) best = { p, level };
    }
    if (best) return aimAt(best.p, best.level);
  }
  if (!g) return;
  // 3. The ground under the cursor (climbs onto your own pieces there).
  aimAt(g);
  const gh = useBuildStore.getState().ghost;
  if (r && gh?.ok && gh.level > 0 && Number.isFinite(gh.y)) {
    const p = rayAtHeight(r, gh.y);
    if (p && valid(p, gh.level)) aimAt(p, gh.level);
  }
}

/** Confirm the ghost (click / Place button). */
export function placeGhost(): boolean {
  const st = useBuildStore.getState();
  const g = st.ghost;
  if (st.mode !== 'place' || !g) return false;
  if (!g.ok) {
    st.set({ refusal: { text: g.message, at: Date.now() } });
    return false;
  }
  const def = PIECES[st.kind];
  const text = st.signText.trim();
  if (def.text && !text) {
    st.set({ refusal: { text: refusalText('text_required'), at: Date.now() } });
    return false;
  }
  const payload = { reqId: ++reqSeq, kind: st.kind, variant: variantFor(st.kind), x: g.x, z: g.z, rot: st.rot, level: g.level, ...(def.text ? { text } : {}) };
  if (!net.send(C2S.buildPlace, payload)) return false;
  st.set({ pending: st.pending + 1 });
  return true;
}

/** Remove tool: select the piece under a screen point. */
export function selectAt(clientX: number, clientY: number): void {
  const id = pickPiece(clientX, clientY);
  useBuildStore.getState().set({ selected: id, refusal: null });
}

export function removePiece(id: string): boolean {
  const p = pieces.index.get(id);
  if (!p) return false;
  if (!net.send(C2S.buildRemove, { reqId: ++reqSeq, id })) return false;
  const st = useBuildStore.getState();
  st.set({ pending: st.pending + 1, selected: null });
  return true;
}

/** Undo: remove the newest piece this player placed this session that still exists. */
export function undo(): boolean {
  const st = useBuildStore.getState();
  const id = [...st.undo].reverse().find((x) => pieces.index.get(x));
  if (!id) return false;
  st.set({ undo: st.undo.filter((x) => x !== id) });
  return removePiece(id);
}

/** Report a piece through the existing report flow (reports its owner, with the piece as details). */
export function reportPiece(id: string): void {
  const p = pieces.index.get(id);
  if (!p) return;
  const details = `Built piece ${p.id} (${PIECES[p.kind].name}) at ${p.x},${p.z}${p.text ? `, sign text: "${p.text}"` : ''}`;
  if (net.send(C2S.report, { target: '', profileId: p.ownerId, reason: 'inappropriate_content', details })) {
    toasts.push({ level: 'info', text: `Thanks — ${p.ownerName || 'the builder'} has been reported to the moderators.`, ttlMs: 5000 });
  }
  useBuildStore.getState().set({ selected: null });
}

export function unstuck(): void {
  if (net.send(C2S.unstuck, {})) cancelPath();
}
