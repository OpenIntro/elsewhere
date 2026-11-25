/**
 * Input sampling (keyboard now; touch joystick feeds setTouchMove()).
 * Module-level state read per frame — no React.
 *
 * Movement vector is in SCREEN terms: x = right, y = up (forward), each -1..1.
 * Convert to world with screenToWorld() (isometric camera at +X+Z looking at -X-Z).
 */
import { useUiStore } from '../state/uiStore.js';

export interface InputSnapshot {
  moveX: number;
  moveY: number;
  run: boolean;
}

const keys = new Set<string>();
const touch = { x: 0, y: 0, active: false, run: false };
type Listener = () => void;
const interactListeners = new Set<Listener>();

let installed = false;
export function installInput(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const down = (e: KeyboardEvent) => {
    if (useUiStore.getState().textInputFocused) return;
    if (isEditable(e.target)) return;
    keys.add(e.code);
    if (e.code === 'KeyE' && !e.repeat) for (const l of interactListeners) l();
  };
  const up = (e: KeyboardEvent) => keys.delete(e.code);
  const blur = () => keys.clear();
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    installed = false;
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
  };
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/** Touch joystick (ui/ worker) calls this with -1..1 values; pass active=false on release. */
export function setTouchMove(x: number, y: number, active: boolean, run = false): void {
  touch.x = x;
  touch.y = y;
  touch.active = active;
  touch.run = run;
}

/** Subscribe to the interact action (E key / touch button). */
export function onInteractPressed(l: Listener): () => void {
  interactListeners.add(l);
  return () => interactListeners.delete(l);
}
/** Trigger interact programmatically (touch button). */
export function pressInteract(): void {
  for (const l of interactListeners) l();
}

export function sampleInput(): InputSnapshot {
  if (useUiStore.getState().textInputFocused) return { moveX: 0, moveY: 0, run: false };
  let x = 0;
  let y = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  let run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (touch.active) {
    x = touch.x;
    y = touch.y;
    run = touch.run;
  }
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  return { moveX: x, moveY: y, run };
}

/** Isometric camera sits at +X,+Z: screen-up is world (-1,0,-1)/√2, screen-right is (1,0,-1)/√2. */
export function screenToWorld(mx: number, my: number): { x: number; z: number } {
  const s = Math.SQRT1_2;
  return { x: (mx - my) * s, z: (-mx - my) * s };
}
