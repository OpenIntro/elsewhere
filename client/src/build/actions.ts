/**
 * Build-mode actions: enter/leave, choose a piece, rotate, aim the ghost from
 * a screen point (shared validation → green/red + reason), place, remove,
 * undo, report, clear bushes / rocks, edit sign words, unstuck. The server
 * re-validates everything.
 *
 * Aiming ("you build on what you point at"):
 *  - a wall-type piece aimed at one of your walls (its face or its top) goes
 *    straight on top of it, same line and orientation (the wall is
 *    highlighted); the storey control can lock the ghost to one storey so a
 *    run of walls is placed without re-aiming, and after each placement the
 *    ghost moves on to the next segment of the run;
 *  - the house roof finds the walled rectangle under the cursor and spans it
 *    whole (fallback: two corners, click / tap twice);
 *  - wall mounts (name signs, pictures, shelves…) snap onto the face of the
 *    wall under the cursor; table-top things onto the table under it;
 *  - otherwise the ground under the cursor (lowest valid storey).
 */
import {
  C2S,
  CONFIG,
  PIECES,
  autoLevel,
  clearableNature,
  fitRoof,
  groundHeight,
  isWallKind,
  nextInRun,
  pieceTop,
  refusalText,
  roofParamsFor,
  roofParamsString,
  roofSpanAt,
  roofSpanFromCorners,
  snapToGrid,
  stackOnto,
  validatePlacement,
  yawOfRot,
  type PieceKind,
  type PieceRecord,
  type PlacementResult,
  type RoofSpan,
  type Vec2,
} from '@elsewhere/shared';
import { net } from '../net/index.js';
import { cancelPath, groundFromScreen } from '../player/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { toasts } from '../ui/toasts.js';
import { pickPiece, pickPieceHit, rayAtHeight, screenRay } from './picking.js';
import { pieces, useBuildStore, variantFor, type GhostState } from './store.js';

let reqSeq = 0;
/** Last aimed ground point (re-validated when the rotation/piece changes). */
let lastAim: (Vec2 & { level?: number; rot?: number }) | null = null;
/** The last two pieces this player placed (repeat along a run). */
let lastPlaced: { kind: PieceKind; x: number; z: number; rot: number; level: number } | null = null;
let prevPlaced: { x: number; z: number } | null = null;
/** Pending placement payloads by request id (to continue a run when the server confirms). */
const pendingPlaces = new Map<number, { kind: PieceKind; x: number; z: number; rot: number; level: number }>();

export function isBuilding(): boolean {
  return useBuildStore.getState().mode !== 'off';
}

export function enterBuild(mode: 'place' | 'remove' | 'clear' = 'place'): void {
  const ui = useUiStore.getState();
  ui.closePanel();
  if (ui.chatOpen && window.matchMedia('(max-width: 720px), (max-height: 500px)').matches) ui.setChatOpen(false);
  cancelPath();
  useBuildStore.getState().set({ mode, selected: null, selectedNature: null, refusal: null, editing: null });
  if (mode === 'place') reaim();
}

export function exitBuild(): void {
  useBuildStore.getState().set({ mode: 'off', ghost: null, selected: null, selectedNature: null, refusal: null, editing: null });
  lastAim = null;
}

export function toggleBuild(): void {
  if (isBuilding()) exitBuild();
  else enterBuild('place');
}

export function setTool(mode: 'place' | 'remove' | 'clear'): void {
  useBuildStore.getState().set({ mode, selected: null, selectedNature: null, refusal: null, editing: null, ...(mode !== 'place' ? { ghost: null } : {}) });
  if (mode === 'place') reaim();
}

export function selectKind(kind: PieceKind): void {
  const st = useBuildStore.getState();
  // A house roof turns its ridge (two ways), everything else in quarter turns.
  st.set({ kind, mode: 'place', selected: null, selectedNature: null, refusal: null, ...(PIECES[kind].param === 'roof' ? { rot: st.rot % 2 } : {}) });
  if (st.ghost?.anchor) useBuildStore.getState().set({ ghost: null });
  reaim();
}

export function selectVariant(kind: PieceKind, variant: string): void {
  const st = useBuildStore.getState();
  st.set({ variants: { ...st.variants, [kind]: variant } });
  reaim();
}

export function rotate(dir = 1): void {
  const st = useBuildStore.getState();
  const steps = PIECES[st.kind].param === 'roof' ? 2 : 4;
  st.set({ rot: (((st.rot + dir) % steps) + steps) % steps });
  if (lastAim) lastAim.rot = undefined;
  reaim();
}

export function setRoofOptions(o: { style?: 'gable' | 'hip'; pitch?: 0 | 1 }): void {
  useBuildStore.getState().set({ ...(o.style ? { roofStyle: o.style } : {}), ...(o.pitch !== undefined ? { roofPitch: o.pitch } : {}) });
  reaim();
}

/** Storey control: step the locked storey up / down (from automatic, start at the ghost's storey). */
export function stepStorey(dir: 1 | -1): void {
  const st = useBuildStore.getState();
  const def = PIECES[st.kind];
  const cur = st.lockLevel ?? st.ghost?.level ?? 0;
  const next = Math.max(def.minLevel, Math.min(Math.min(def.maxLevel, CONFIG.building.maxLevel), cur + dir));
  st.set({ lockLevel: next });
  reaim();
}
export function setAutoStorey(): void {
  useBuildStore.getState().set({ lockLevel: null });
  reaim();
}

export function setSignText(text: string): void {
  const st = useBuildStore.getState();
  const max = PIECES[st.kind].textMax ?? CONFIG.building.signMaxLength;
  st.set({ signText: text.slice(0, Math.max(max, CONFIG.building.signMaxLength)) });
}

/** Where the local player and everyone else stand (for the "someone is standing there" preview). */
function playerPositions(): Vec2[] {
  const out: Vec2[] = [];
  const lp = runtime.localPlayer;
  if (lp.ready) out.push({ x: lp.x, z: lp.z });
  for (const r of runtime.remotes.values()) if (r.render?.visible !== false && r.render) out.push({ x: r.render.x, z: r.render.z });
  return out;
}

function myId(): string {
  return useGameStore.getState().profile?.profileId ?? '';
}

function placementContext() {
  const lp = runtime.localPlayer;
  return { index: pieces.index, builderId: myId(), builderPos: lp.ready ? { x: lp.x, z: lp.z } : null, players: playerPositions(), cleared: useBuildStore.getState().cleared };
}

function setGhost(res: PlacementResult, at: { x: number; z: number; level: number; rot: number }, extra: Partial<GhostState> = {}): void {
  const st = useBuildStore.getState();
  if (res.ok) {
    st.set({ ghost: { x: res.x, z: res.z, level: res.level, rot: res.rot, y: res.y, ok: true, message: '', ...(res.params ? { params: res.params } : {}), ...extra } });
  } else {
    st.set({
      ghost: { x: at.x, z: at.z, level: at.level, rot: at.rot, y: NaN, ok: false, message: refusalText(res.reason, res.label), ...(res.natureId ? { natureId: res.natureId } : {}), ...extra },
    });
  }
}

/** Validate the chosen piece at an exact spot (no snapping, no level search) and show the ghost. */
function aimExact(x: number, z: number, rot: number, level: number, extra: Partial<GhostState> = {}, params?: string): PlacementResult {
  const st = useBuildStore.getState();
  const res = validatePlacement({ kind: st.kind, variant: variantFor(st.kind), x, z, rot, level, ...(params ? { params: JSON.parse(params) } : {}) }, placementContext());
  setGhost(res, { x, z, level, rot }, { ...extra, ...(params && !res.ok ? { params } : {}) });
  return res;
}

/** Validate the current piece at a ground point (lowest valid storey, or the locked storey) and update the ghost. */
export function aimAt(p: Vec2, level?: number, rot?: number): void {
  lastAim = { x: p.x, z: p.z, ...(level !== undefined ? { level } : {}), ...(rot !== undefined ? { rot } : {}) };
  const st = useBuildStore.getState();
  if (st.mode !== 'place') return;
  const def = PIECES[st.kind];
  if (def.param === 'roof') return aimRoofAt(p);
  const r = rot ?? st.rot;
  const snapped = snapToGrid(st.kind, p, r);
  const lv = st.lockLevel ?? level;
  const base = { kind: st.kind, variant: variantFor(st.kind), x: snapped.x, z: snapped.z, rot: r };
  let res = lv !== undefined ? validatePlacement({ ...base, level: lv }, placementContext()) : autoLevel(base, placementContext());
  if (!res.ok && lv !== undefined && st.lockLevel === null) res = autoLevel(base, placementContext());
  setGhost(res, { x: snapped.x, z: snapped.z, level: res.ok ? res.level : (lv ?? 0), rot: r });
}

/** Re-run validation at the last aim point (piece/rotation changed, the world changed). */
export function reaim(): void {
  if (useBuildStore.getState().mode !== 'place') return;
  if (lastAim) return aimAt(lastAim, lastAim.level, lastAim.rot);
  // First aim: a couple of metres in front of the player.
  const lp = runtime.localPlayer;
  if (lp.ready) aimAt({ x: lp.x + Math.sin(lp.rot) * 2.5, z: lp.z + Math.cos(lp.rot) * 2.5 });
}

// ---------------------------------------------------------------------------
// House roof tool
// ---------------------------------------------------------------------------

/** Any of your walls / pillars near a ground point? */
function ownWallsNear(p: Vec2): boolean {
  const me = myId();
  return pieces.index.query({ minX: p.x - 7, maxX: p.x + 7, minZ: p.z - 7, maxZ: p.z + 7 }).some((q) => q.ownerId === me && PIECES[q.kind].structural);
}

/** Wall-top heights of your storeys near a ground point, highest first (where the cursor ray meets a roof's base). */
function wallTopHeights(g: Vec2): number[] {
  const me = myId();
  const hs = new Set<number>();
  for (const q of pieces.index.query({ minX: g.x - 14, maxX: g.x + 14, minZ: g.z - 14, maxZ: g.z + 14 })) if (q.ownerId === me && PIECES[q.kind].structural) hs.add(Math.round(pieceTop(q) * 20) / 20);
  return [...hs].sort((a, b) => b - a);
}

/** The roof ghost for a span: the widest eaves that fit, validated exactly as the server will (fitRoof → validatePlacement). */
function roofGhostFor(span: RoofSpan, anchor?: { x: number; z: number }): void {
  const st = useBuildStore.getState();
  const res = fitRoof(span, st.rot, st.roofStyle, st.roofPitch, variantFor(st.kind), placementContext());
  const params = roofParamsString(roofParamsFor(span, st.rot, st.roofStyle, st.roofPitch));
  setGhost(res, { x: span.x, z: span.z, level: span.level, rot: st.rot % 2 }, { ...(anchor ? { anchor } : {}), ...(!res.ok ? { params } : {}) });
}

let roofAnchor: { x: number; z: number; level: number } | null = null;
/** Extra probe points from the last screen aim (wall hit, cursor ray at wall-top heights), reused by re-aims. */
let roofProbes: Vec2[] = [];
/** For the debug snapshot / tests: where the roof tool last looked. */
export function roofToolProbes(): readonly Vec2[] {
  return lastRoofProbes;
}
let lastRoofProbes: Vec2[] = [];
function aimRoofAt(p: Vec2, probes: readonly Vec2[] = roofProbes): void {
  const st = useBuildStore.getState();
  if (roofAnchor) {
    const span = roofSpanFromCorners(roofAnchor, p, roofAnchor.level);
    if (span) return roofGhostFor(span, { x: roofAnchor.x, z: roofAnchor.z });
    return void st.set({ ghost: { x: Math.round(p.x), z: Math.round(p.z), level: roofAnchor.level, rot: st.rot % 2, y: NaN, ok: false, message: 'Pick the opposite corner of the roof', anchor: { x: roofAnchor.x, z: roofAnchor.z } } });
  }
  // The storey lock does not apply: a roof always goes on the top storey of the house it covers.
  const all = [...probes, p];
  lastRoofProbes = all;
  const span = roofSpanAt(pieces.index, myId(), all);
  if (span) return roofGhostFor(span);
  // Half-built (two sides): show that rectangle in red with the sides still open.
  const partial = roofSpanAt(pieces.index, myId(), all, 2);
  if (partial) return roofGhostFor(partial);
  st.set({
    ghost: {
      x: Math.round(p.x),
      z: Math.round(p.z),
      level: 1,
      rot: st.rot % 2,
      y: NaN,
      ok: false,
      message: ownWallsNear(p) ? 'No walled rectangle here — point inside the house, or click two opposite corners' : 'Point at a house you built (walls on at least three sides)',
    },
  });
}

// ---------------------------------------------------------------------------
// Aim from the screen
// ---------------------------------------------------------------------------

/** Which face of a wall a hit point is on: the mount's rotation facing out of that face. */
function faceRot(wall: PieceRecord, hit: { x: number; z: number }): number {
  const yaw = yawOfRot(wall.rot);
  const side = (hit.x - wall.x) * Math.sin(yaw) + (hit.z - wall.z) * Math.cos(yaw);
  return side >= 0 ? ((wall.rot % 4) + 4) % 4 : (wall.rot + 2) % 4;
}

const MOUNTABLE: readonly string[] = ['wall', 'wall_window', 'doorway'];
/** Pointing at a wall above this fraction of its height means "build on top of it". */
const STACK_FROM = 0.6;

/**
 * Aim from a screen point (mouse hover / tap): you build on what you point at
 * (see the header).
 */
export function aimFromScreen(clientX: number, clientY: number): void {
  const st = useBuildStore.getState();
  if (st.mode !== 'place') return;
  const g = groundFromScreen(clientX, clientY);
  const r = screenRay(clientX, clientY);
  const ctx = placementContext();
  const variant = variantFor(st.kind);
  const def = PIECES[st.kind];
  // Wall mounts look for a wall (past roofs and eaves in front of it); everything else takes the first visible piece.
  const accept = def.mount ? (id: string) => MOUNTABLE.includes(pieces.index.get(id)?.kind ?? '') : undefined;
  const hit = r ? pickPieceHit(clientX, clientY, accept) : null;
  const q = hit ? pieces.index.get(hit.id) : undefined;
  const valid = (p: Vec2, level: number) => {
    const s = snapToGrid(st.kind, p, st.rot);
    return validatePlacement({ kind: st.kind, variant, x: s.x, z: s.z, rot: st.rot, level }, ctx).ok;
  };

  // Wall mounts: onto the face of the wall under the cursor.
  if (def.mount) {
    if (q && hit && MOUNTABLE.includes(q.kind)) {
      lastAim = null;
      aimExact(q.x, q.z, faceRot(q, hit.point), q.level);
      return;
    }
    if (q && hit && PIECES[q.kind].mount) {
      lastAim = null;
      aimExact(q.x, q.z, q.rot, q.level);
      return;
    }
    const gp = g;
    if (gp) {
      // Nearest wall to the ground point (within a metre).
      let best: PieceRecord | null = null;
      let bd = 1.2;
      for (const w of pieces.index.query({ minX: gp.x - 1.5, maxX: gp.x + 1.5, minZ: gp.z - 1.5, maxZ: gp.z + 1.5 })) {
        if (!MOUNTABLE.includes(w.kind) || (st.lockLevel !== null && w.level !== st.lockLevel)) continue;
        const d = Math.hypot(w.x - gp.x, w.z - gp.z);
        if (d < bd) {
          bd = d;
          best = w;
        }
      }
      if (best) return void aimExact(best.x, best.z, faceRot(best, gp), best.level);
      st.set({ ghost: { x: Math.round(gp.x), z: Math.round(gp.z), level: 0, rot: st.rot, y: NaN, ok: false, message: 'Point at one of your walls' } });
    }
    return;
  }

  // House roof: the walled rectangle around where the cursor points (or a two-corner span).
  if (def.param === 'roof') {
    let p = g;
    if (roofAnchor && r) p = rayAtHeight(r, roofAnchorHeight()) ?? g;
    if (!p) return;
    lastAim = { x: p.x, z: p.z };
    const probes: Vec2[] = [];
    if (hit) probes.push({ x: hit.point.x, z: hit.point.z });
    // The cursor ray at each storey's wall-top and mid-wall height: pointing at a wall (even one cut away
    // or faded while you stand next to it) or at the roof ghost above the house lands on that house.
    if (r && !roofAnchor)
      for (const h of wallTopHeights(p))
        for (const at of [rayAtHeight(r, h), rayAtHeight(r, h - CONFIG.building.storeyHeight * 0.55)]) if (at) probes.push(at);
    roofProbes = probes;
    aimRoofAt(p, probes);
    return;
  }

  // Table-top things: onto the top of the table / counter under the cursor.
  if (def.top && q && hit && PIECES[q.kind].surface && hit.normalY > 0.6) {
    const s = snapToGrid(st.kind, hit.point, st.rot);
    const res = validatePlacement({ kind: st.kind, variant, x: s.x, z: s.z, rot: st.rot, level: q.level }, ctx);
    if (res.ok) return aimAt(hit.point, q.level);
  }

  // Walls upward: aimed at the upper part of one of your walls (its top or the top 40% of its face)
  // → straight on top of it, same line. Lower down, the cursor means the ground behind it.
  const upperPart = q && hit ? hit.normalY > 0.6 || hit.point.y - q.y >= STACK_FROM * CONFIG.building.storeyHeight : false;
  if (isWallKind(st.kind) && q && PIECES[q.kind].structural && upperPart && st.lockLevel === null) {
    let at = stackOnto(q, st.kind);
    // Climb past storeys that are already built.
    for (let i = 0; at && i < CONFIG.building.maxLevel; i++) {
      if (st.lockLevel !== null && at.level !== st.lockLevel) {
        if (at.level > st.lockLevel) break;
        at = { ...at, level: at.level + 1 };
        continue;
      }
      const res = validatePlacement({ kind: st.kind, variant, x: at.x, z: at.z, rot: at.rot, level: at.level }, ctx);
      if (res.ok || res.reason !== 'overlap') {
        lastAim = { x: at.x, z: at.z, level: at.level, rot: at.rot };
        setGhost(res, at, { extend: q.id });
        return;
      }
      at = { ...at, level: at.level + 1 };
    }
  }

  // Locked storey: the cursor ray at that storey's base height; a wall right below is highlighted.
  if (st.lockLevel !== null && r && g) {
    const h = storeyBaseHeight(g, st.lockLevel);
    const p = rayAtHeight(r, h) ?? g;
    aimAt(p, st.lockLevel);
    const gh = useBuildStore.getState().ghost;
    if (gh && isWallKind(st.kind)) {
      const below = pieces.index.query({ minX: gh.x - 0.05, maxX: gh.x + 0.05, minZ: gh.z - 0.05, maxZ: gh.z + 0.05 }).find((w) => w.level === gh.level - 1 && w.x === gh.x && w.z === gh.z && PIECES[w.kind].structural);
      if (below) useBuildStore.getState().set({ ghost: { ...gh, extend: below.id } });
    }
    return;
  }

  // 1. Pointing at a piece's top face.
  if (q && hit && hit.normalY > 0.6) {
    const qd = PIECES[q.kind];
    const level = qd.structural ? q.level + 1 : q.kind === 'floor' && q.level > 0 ? q.level : -1;
    if (level >= def.minLevel && level <= def.maxLevel && valid(hit.point, level)) return aimAt(hit.point, level);
  }
  // 2. Pieces that never stand on the ground (chimneys): the highest storey top under the cursor.
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

/** Base height of a storey near a ground point: the top of your walls of the storey below, else ground + storeys. */
function storeyBaseHeight(g: Vec2, level: number): number {
  if (level <= 0) return groundAt(g);
  let h = -Infinity;
  for (const q of pieces.index.query({ minX: g.x - 8, maxX: g.x + 8, minZ: g.z - 8, maxZ: g.z + 8 })) if (q.level === level - 1 && PIECES[q.kind].structural) h = Math.max(h, pieceTop(q));
  return Number.isFinite(h) ? h : groundAt(g) + level * CONFIG.building.storeyHeight;
}
function groundAt(g: Vec2): number {
  return groundHeight(g.x, g.z);
}
function roofAnchorHeight(): number {
  if (!roofAnchor) return 0;
  return storeyBaseHeight(roofAnchor, roofAnchor.level);
}

/** Confirm the ghost (click / Place button). */
export function placeGhost(): boolean {
  const st = useBuildStore.getState();
  const g = st.ghost;
  if (st.mode !== 'place' || !g) return false;
  const def = PIECES[st.kind];
  // House roof fallback: the first click sets the corner.
  if (def.param === 'roof' && !g.ok && !g.anchor && /corners/.test(g.message)) {
    roofAnchor = { x: Math.round(g.x), z: Math.round(g.z), level: g.level };
    st.set({ refusal: null });
    reaim();
    return false;
  }
  if (!g.ok) {
    st.set({ refusal: { text: g.message, at: Date.now() } });
    return false;
  }
  const text = st.signText.trim();
  if (def.text && !text) {
    st.set({ refusal: { text: refusalText('text_required'), at: Date.now() } });
    return false;
  }
  const params = g.params ? (JSON.parse(g.params) as { w: number; d: number; s: string; p: number; o?: number }) : null;
  const payload = {
    reqId: ++reqSeq,
    kind: st.kind,
    variant: variantFor(st.kind),
    x: g.x,
    z: g.z,
    rot: g.rot,
    level: g.level,
    ...(def.text ? { text } : {}),
    ...(params ? { params: { w: params.w, d: params.d, style: params.s, pitch: params.p, ...(params.o !== undefined ? { overhang: params.o } : {}) } } : {}),
  };
  if (!net.send(C2S.buildPlace, payload)) return false;
  pendingPlaces.set(payload.reqId, { kind: st.kind, x: g.x, z: g.z, rot: g.rot, level: g.level });
  roofAnchor = null;
  st.set({ pending: st.pending + 1 });
  return true;
}

/** Server confirmed a placement: walls / fences continue along their run (the ghost moves on). */
export function afterPlaced(reqId: number): void {
  const p = pendingPlaces.get(reqId);
  pendingPlaces.delete(reqId);
  if (!p) return;
  prevPlaced = lastPlaced ? { x: lastPlaced.x, z: lastPlaced.z } : null;
  if (lastPlaced && Math.hypot(lastPlaced.x - p.x, lastPlaced.z - p.z) > PIECES[p.kind].w + 0.1) prevPlaced = null;
  lastPlaced = p;
  const st = useBuildStore.getState();
  if (st.mode !== 'place' || st.kind !== p.kind) return;
  const runs = isWallKind(p.kind) && p.kind !== 'pillar' ? true : p.kind === 'fence';
  if (!runs) return;
  const next = nextInRun(p, prevPlaced);
  lastAim = { x: next.x, z: next.z, level: p.level, rot: p.rot };
  aimExact(next.x, next.z, p.rot, p.level);
}

/** Repeat last: put the ghost on the next segment of the run (the "Next" button). */
export function nextSegment(): void {
  if (!lastPlaced) return;
  const next = nextInRun(lastPlaced, prevPlaced);
  lastAim = { x: next.x, z: next.z, level: lastPlaced.level, rot: lastPlaced.rot };
  aimExact(next.x, next.z, lastPlaced.rot, lastPlaced.level);
}

export function canRepeat(): boolean {
  return lastPlaced !== null;
}

// ---------------------------------------------------------------------------
// Remove / clear / edit
// ---------------------------------------------------------------------------

/** The nearest clearable bush / rock (not cleared yet) to a ground point. */
export function natureNear(p: Vec2, within = 1.4): string | null {
  const cleared = useBuildStore.getState().cleared;
  let best: string | null = null;
  let bd = within;
  for (const n of clearableNature().values()) {
    if (cleared.has(n.id)) continue;
    const d = Math.hypot(n.position.x - p.x, n.position.z - p.z) - n.radius * 0.5;
    if (d < bd) {
      bd = d;
      best = n.id;
    }
  }
  return best;
}

/** Remove / clear tool: select the piece (or bush / rock) under a screen point. */
export function selectAt(clientX: number, clientY: number): void {
  const st = useBuildStore.getState();
  const id = st.mode === 'clear' ? null : pickPiece(clientX, clientY);
  let nature: string | null = null;
  if (!id) {
    const g = groundFromScreen(clientX, clientY);
    if (g) nature = natureNear(g);
  }
  st.set({ selected: id, selectedNature: nature, refusal: null, editing: null });
}

export function removePiece(id: string): boolean {
  const p = pieces.index.get(id);
  if (!p) return false;
  if (!net.send(C2S.buildRemove, { reqId: ++reqSeq, id })) return false;
  const st = useBuildStore.getState();
  st.set({ pending: st.pending + 1, selected: null });
  return true;
}

/** Clear a bush / small rock (server validates range, zones and the daily cap). */
export function clearNature(id: string): boolean {
  if (!net.send(C2S.buildClear, { reqId: ++reqSeq, id })) return false;
  const st = useBuildStore.getState();
  st.set({ pending: st.pending + 1, selectedNature: null });
  return true;
}

/** Owner: new words for a sign / name board. */
export function editText(id: string, text: string): boolean {
  if (!text.trim()) return false;
  if (!net.send(C2S.buildEditText, { reqId: ++reqSeq, id, text: text.trim() })) return false;
  const st = useBuildStore.getState();
  st.set({ pending: st.pending + 1, editing: null });
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

/** Cancel a half-drawn two-corner roof (Esc / choosing another piece). */
export function cancelRoofSpan(): boolean {
  if (!roofAnchor) return false;
  roofAnchor = null;
  reaim();
  return true;
}
