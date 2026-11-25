/**
 * Interaction targeting + actions.
 *  - updateTargeting(): nearest eligible interactable within its radius, with
 *    a facing bias (things in front of you win), or — if closer/only — a
 *    nearby remote PLAYER. Writes ui.prompt / ui.playerPrompt (never both)
 *    and `target` (read by the in-world TargetIndicator).
 *  - E / HUD prompt / touch button → interact with the target (or open the
 *    player menu); Space → contextual (interact › stand › wave); Esc → close
 *    menu/panel › cancel path › recenter camera; Enter → open chat.
 *  - interact results → panels / gentle notices; seats are handled by the
 *    synced `seat` field (LocalPlayer snaps smoothly into the seat pose).
 * The server re-validates range; this is UX only.
 */
import {
  CONFIG,
  INTERACTABLES,
  S2C,
  getInteractable,
  groundHeight,
  isSeatInteractable,
  sameSpace,
  type Interactable,
} from '@elsewhere/shared';
import { actions, net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { cameraControls, useCameraStore } from './camera.js';
import { onAction } from './input.js';
import { interactErrorNotice } from './interactionMessages.js';
import { cancelPath, hasPath, walkToInteract } from './navigation.js';

/** Players closer than this can be targeted. */
export const PLAYER_TARGET_RADIUS = 2.2;
/** 0 = pure distance, 1 = strongly prefer what you face. */
const FACING_BIAS = 0.45;

export interface TargetState {
  kind: 'none' | 'interactable' | 'player';
  id: string;
  x: number;
  y: number;
  z: number;
  /** Visual height of the marker above the target's ground. */
  height: number;
}
export const target: TargetState = { kind: 'none', id: '', x: 0, y: 0, z: 0, height: 0 };

function eligible(it: Interactable): boolean {
  const obj = useGameStore.getState().objects[it.id];
  if (it.kind === 'pickup' && obj && (!obj.active || obj.holder)) return false;
  if (isSeatInteractable(it) && obj) {
    const full = (1 << it.seats.length) - 1;
    if ((obj.value & full) === full) return false;
  }
  return true;
}

/** Nearest eligible interactable with facing bias (null if none in range). */
export function findTarget(x: number, z: number, yaw = runtime.localPlayer.rot): Interactable | null {
  let best: Interactable | null = null;
  let bestScore = Infinity;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  for (const it of INTERACTABLES) {
    const r = it.radius ?? CONFIG.interaction.radius;
    const dx = it.position.x - x;
    const dz = it.position.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > r * r) continue;
    // No using things through walls (the server enforces the same rule).
    if (!sameSpace({ x, z }, it.position, it.kind === 'door')) continue;
    const d = Math.sqrt(d2);
    const facing = d > 0.3 ? (dx * fx + dz * fz) / d : 1;
    const score = d * (1 - FACING_BIAS * facing);
    if (score < bestScore && eligible(it)) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

function markerHeight(it: Interactable): number {
  switch (it.kind) {
    case 'streetlight':
      return 3.6;
    case 'bell':
    case 'portal':
      return 2.8;
    case 'door':
      return 2.6;
    case 'fountain':
      return 2.2;
    case 'pickup':
    case 'hidden':
      return 0.8;
    default:
      return 1.6;
  }
}

/** Call every ~100 ms; cheap (≈100 interactables + ≤50 players, no allocation). */
export function updateTargeting(): void {
  const lp = runtime.localPlayer;
  const ui = useUiStore.getState();
  if (!lp.ready) {
    target.kind = 'none';
    ui.setPrompt(null);
    ui.setPlayerPrompt(null);
    return;
  }
  const game = useGameStore.getState();
  const me = game.sessionId ? game.players[game.sessionId] : undefined;
  const seated = !!me?.seat;
  const it = seated ? null : findTarget(lp.x, lp.z);
  let itScore = Infinity;
  if (it) {
    const dx = it.position.x - lp.x;
    const dz = it.position.z - lp.z;
    const d = Math.hypot(dx, dz);
    const facing = d > 0.3 ? (dx * Math.sin(lp.rot) + dz * Math.cos(lp.rot)) / d : 1;
    itScore = d * (1 - FACING_BIAS * facing);
  }
  // Nearby players (rendered positions).
  let pid = '';
  let pScore = Infinity;
  let px = 0;
  let pz = 0;
  let py = 0;
  const fx = Math.sin(lp.rot);
  const fz = Math.cos(lp.rot);
  for (const [id, r] of runtime.remotes) {
    const p = r.render;
    if (!p || !p.visible || id === game.sessionId) continue;
    const dx = p.x - lp.x;
    const dz = p.z - lp.z;
    const d = Math.hypot(dx, dz);
    if (d > PLAYER_TARGET_RADIUS) continue;
    if (!sameSpace({ x: lp.x, z: lp.z }, { x: p.x, z: p.z })) continue;
    const facing = d > 0.3 ? (dx * fx + dz * fz) / d : 1;
    // Objects get a small priority: standing next to a bench with friends should still offer "Sit".
    const score = d * (1 - FACING_BIAS * facing) + 0.5;
    if (score < pScore) {
      pScore = score;
      pid = id;
      px = p.x;
      py = p.y;
      pz = p.z;
    }
  }
  if (it && itScore <= pScore) {
    target.kind = 'interactable';
    target.id = it.id;
    target.x = it.position.x;
    target.z = it.position.z;
    target.y = groundHeight(it.position.x, it.position.z);
    target.height = markerHeight(it);
    ui.setPrompt({ interactableId: it.id, label: it.prompt, name: it.name });
    ui.setPlayerPrompt(null);
  } else if (pid) {
    const info = game.players[pid];
    target.kind = 'player';
    target.id = pid;
    target.x = px;
    target.y = py;
    target.z = pz;
    target.height = 2.25;
    ui.setPrompt(null);
    ui.setPlayerPrompt({ sessionId: pid, name: info?.name ?? 'Someone', label: 'Say hi' });
  } else {
    target.kind = 'none';
    ui.setPrompt(null);
    ui.setPlayerPrompt(null);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let lastInteract = { id: '', at: 0, retried: false };
let lastStandAt = 0;

/** Send an interact for `id` right now (in range). */
export function interactNow(id: string): void {
  if (performance.now() - lastInteract.at < 250 && lastInteract.id === id) return;
  lastInteract = { id, at: performance.now(), retried: lastInteract.id === id ? lastInteract.retried : false };
  actions.interact(id);
}

/** Walk to (if needed) and interact. Used by clicks/taps on objects. */
export function interactWith(id: string): void {
  const r = walkToInteract(id);
  if (r === 'now') interactNow(id);
  else if (r === 'failed') useUiStore.getState().notify('info', 'Can’t find a way there.', 2500);
}

export function requestStand(): void {
  const now = performance.now();
  if (now - lastStandAt < 500) return;
  lastStandAt = now;
  actions.stand();
}

function isSeated(): boolean {
  const g = useGameStore.getState();
  return !!(g.sessionId && g.players[g.sessionId]?.seat);
}

function onInteract(): void {
  const ui = useUiStore.getState();
  if (ui.prompt) return interactNow(ui.prompt.interactableId);
  if (ui.playerPrompt) return ui.openPlayerMenu(ui.playerPrompt.sessionId, 'keyboard');
  if (isSeated()) requestStand();
}

function onContextual(): void {
  const ui = useUiStore.getState();
  if (ui.prompt) return interactNow(ui.prompt.interactableId);
  if (isSeated()) return requestStand();
  actions.emote('wave');
}

function onEscape(): void {
  const ui = useUiStore.getState();
  if (ui.playerMenu) return ui.closePlayerMenu();
  if (ui.panel) return ui.closePanel();
  if (hasPath()) return cancelPath();
  if (useCameraStore.getState().free) return cameraControls.recenter();
  if (ui.chatOpen) ui.setChatOpen(false);
}

function onChat(): void {
  useUiStore.getState().setChatOpen(true);
}

/** Wire input actions and interact results. Returns cleanup. */
export function installInteraction(): () => void {
  const offs = [
    onAction('interact', onInteract),
    onAction('contextual', onContextual),
    onAction('escape', onEscape),
    onAction('chat', onChat),
    net.on(S2C.interactResult, (r) => {
      const ui = useUiStore.getState();
      if (!r.ok) {
        const it = getInteractable(r.id);
        if (r.error === 'too_far' && !lastInteract.retried && it) {
          // Prediction said we were in range; walk a little closer and try once more (quietly).
          lastInteract.retried = true;
          const res = walkToInteract(r.id);
          if (res === 'now') setTimeout(() => actions.interact(r.id), 300);
          return;
        }
        const notice = interactErrorNotice(r.error, it?.kind, it?.name);
        if (notice) ui.notify(notice.level, notice.text, notice.ttlMs);
        return;
      }
      if (!r.ui) return;
      switch (r.ui.panel) {
        case 'sign':
        case 'inspect':
          ui.openPanel({ kind: r.ui.panel, title: r.ui.title, text: r.ui.text });
          break;
        case 'gazette':
        case 'memory':
          ui.openPanel({ kind: r.ui.panel });
          break;
        case 'mailbox':
          ui.openPanel({ kind: 'mailbox', mailboxId: r.ui.mailboxId, canSend: r.ui.canSend });
          break;
        case 'discovery':
          ui.openPanel({ kind: 'discovery', discoveryId: r.ui.discoveryId, name: r.ui.name, text: r.ui.text, firstTime: r.ui.firstTime });
          break;
      }
    }),
  ];
  return () => {
    for (const o of offs) o();
  };
}
