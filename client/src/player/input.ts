/**
 * Input: keyboard, pointer gestures on the canvas (mouse + touch), virtual
 * joystick feed. Module-level state read per frame — no React.
 *
 * Keys (ignored while typing — ui.textInputFocused or an editable target):
 *   WASD / arrows  move (camera-relative)      Shift  run (inverted by settings.runByDefault)
 *   E              interact with the target    Space  contextual: interact › stand up › wave
 *   Enter          open chat                   Esc    close menu/panel › cancel path › recenter camera
 *   Q / R          rotate camera 90°           + / -  zoom          C  recenter camera
 *
 * Pointer on the canvas: click/tap = move / interact / player menu; drag =
 * pan the free camera; wheel / pinch = zoom; two-finger twist = rotate 90°.
 *
 * Movement vector is in SCREEN terms: x = right, y = up (forward), -1..1.
 * Convert with screenToWorld() (uses the current, animated camera yaw).
 */
import { useUiStore } from '../state/uiStore.js';
import { DRAG_RAD_PER_PX, cameraControls, cameraRuntime, classifyTwoFinger, screenToWorldDir, type TwoFingerMode } from './camera.js';

export interface InputSnapshot {
  moveX: number;
  moveY: number;
  run: boolean;
  /** Where the movement came from this frame. */
  source: 'none' | 'keyboard' | 'touch';
}

export type InputAction = 'interact' | 'contextual' | 'escape' | 'chat';

const keys = new Set<string>();
const touch = { x: 0, y: 0, active: false, run: false };
type Listener = () => void;
const interactListeners = new Set<Listener>();
const actionListeners = new Map<InputAction, Set<Listener>>();

function emit(a: InputAction): void {
  if (a === 'interact') for (const l of interactListeners) l();
  for (const l of actionListeners.get(a) ?? []) l();
}

/** Subscribe to an input action (keys / touch buttons). */
export function onAction(a: InputAction, l: Listener): () => void {
  let set = actionListeners.get(a);
  if (!set) actionListeners.set(a, (set = new Set()));
  set.add(l);
  return () => set.delete(l);
}

export function isTyping(target?: EventTarget | null): boolean {
  return useUiStore.getState().textInputFocused || isEditable(target ?? (typeof document !== 'undefined' ? document.activeElement : null));
}

function isEditable(t: EventTarget | null | undefined): boolean {
  const el = t as HTMLElement | null | undefined;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * Optional key handler consulted first on every keydown (not while typing).
 * Returning true consumes the key (e.g. build mode: B toggles, R rotates the
 * piece instead of the camera, Esc leaves build mode).
 */
type KeyInterceptor = (code: string, e: KeyboardEvent) => boolean;
let keyInterceptor: KeyInterceptor | null = null;
export function setKeyInterceptor(fn: KeyInterceptor | null): void {
  keyInterceptor = fn;
}

const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

let installed = 0;
let teardown: (() => void) | null = null;

export function installInput(): () => void {
  installed++;
  if (installed === 1) {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const code = e.code;
      if (MOVE_CODES.has(code) || code === 'Space') e.preventDefault();
      keys.add(code);
      if (e.repeat) return;
      if (keyInterceptor?.(code, e)) return;
      switch (code) {
        case 'KeyE':
          emit('interact');
          break;
        case 'Space':
          emit('contextual');
          break;
        case 'Enter':
        case 'NumpadEnter':
          e.preventDefault();
          emit('chat');
          break;
        case 'Escape':
          emit('escape');
          break;
        // Turn the view: [ / ] everywhere (build mode too); Q / R as well outside build mode
        // (while building R turns the piece — the build interceptor takes it first).
        case 'KeyQ':
        case 'BracketLeft':
          cameraControls.rotateLeft();
          break;
        case 'KeyR':
        case 'BracketRight':
          cameraControls.rotateRight();
          break;
        case 'Equal':
        case 'NumpadAdd':
          cameraControls.zoomIn();
          break;
        case 'Minus':
        case 'NumpadSubtract':
          cameraControls.zoomOut();
          break;
        case 'KeyC':
          cameraControls.recenter();
          break;
      }
    };
    const up = (e: KeyboardEvent) => keys.delete(e.code);
    const clear = () => {
      keys.clear();
      touch.active = false;
    };
    const vis = () => {
      if (document.visibilityState !== 'visible') clear();
    };
    // Starting to type releases held movement keys (keyup goes to the input).
    const unsubUi = useUiStore.subscribe((s, prev) => {
      if (s.textInputFocused && !prev.textInputFocused) keys.clear();
    });
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', vis);
    teardown = () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', vis);
      unsubUi();
      clear();
    };
  }
  return () => {
    installed--;
    if (installed === 0) {
      teardown?.();
      teardown = null;
    }
  };
}

/** Virtual joystick calls this with -1..1 values (y = screen up); pass active=false on release. */
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
/** Trigger interact programmatically (touch button / HUD prompt). */
export function pressInteract(): void {
  emit('interact');
}
/** Trigger the contextual action programmatically (Space equivalent). */
export function pressContextual(): void {
  emit('contextual');
}

const snapshot: InputSnapshot = { moveX: 0, moveY: 0, run: false, source: 'none' };

/** Per-frame input. Returns a shared object (do not keep references across frames). */
export function sampleInput(): InputSnapshot {
  const s = snapshot;
  s.moveX = 0;
  s.moveY = 0;
  s.run = false;
  s.source = 'none';
  if (useUiStore.getState().textInputFocused) return s;
  let x = 0;
  let y = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  let run = keys.has('ShiftLeft') || keys.has('ShiftRight');
  if (x !== 0 || y !== 0) s.source = 'keyboard';
  if (touch.active && (touch.x !== 0 || touch.y !== 0)) {
    x = touch.x;
    y = touch.y;
    run = touch.run;
    s.source = 'touch';
  }
  const len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
  }
  s.moveX = x;
  s.moveY = y;
  s.run = run;
  return s;
}

const dirOut = { x: 0, z: 0 };
/** Screen-relative direction → world direction for the CURRENT camera yaw. Returns a shared object. */
export function screenToWorld(mx: number, my: number): { x: number; z: number } {
  return screenToWorldDir(mx, my, cameraRuntime.yaw, dirOut);
}

// ---------------------------------------------------------------------------
// Pointer gestures (installed on the canvas by PlayerSystems)
// ---------------------------------------------------------------------------

export interface PointerHandlers {
  /** Click / tap at client coordinates. */
  tap(clientX: number, clientY: number, pointerType: string): void;
  /** Drag pan in pixels (screen delta since the last call). */
  pan(dxPx: number, dyPx: number): void;
  /** Pointer hover (mouse only) for cursor feedback. */
  hover?(clientX: number, clientY: number): void;
}

interface TrackedPointer {
  id: number;
  type: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t: number;
}

const TAP_SLOP_MOUSE = 6;
const TAP_SLOP_TOUCH = 12;
const TAP_MAX_MS = 650;

/**
 * When a pointer event happened, in the performance.now() time base: the event's own timeStamp
 * (when the input arrived), not when our handler got to run. On a janky frame the down and up
 * handlers can run hundreds of ms apart for a quick tap (measured up to ~360 ms under headless
 * software rendering with a 0 ms real gap); timing the handlers turned such taps into long presses
 * that did nothing. Falls back to `now` if the timeStamp is missing or not in that time base.
 */
export function pointerEventTime(e: { timeStamp?: number }, now: number): number {
  const t = e.timeStamp;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= now + 1 ? t : now;
}

/** A press that ended within TAP_MAX_MS of starting (event times, see pointerEventTime). */
export function isTapDuration(downAt: number, upAt: number): boolean {
  return upAt - downAt < TAP_MAX_MS;
}

export function installPointer(el: HTMLElement, h: PointerHandlers): () => void {
  const pointers = new Map<number, TrackedPointer>();
  let dragging = false;
  /** A multi-touch gesture happened: suppress the tap until all fingers lift. */
  let multi = false;
  let pinchDist = 0;
  let pinchAngle = 0;
  /** Two-finger gesture totals since it started, and what it was decided to be. */
  let gestAngle = 0;
  let gestLogScale = 0;
  let gestMode: TwoFingerMode = 'undecided';
  /** Right / middle mouse drag turns the view (this pointer id), or -1. */
  let rotPointer = -1;
  let rotEndedAt = 0;

  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none';

  const pair = (): [TrackedPointer, TrackedPointer] | null => {
    if (pointers.size < 2) return null;
    const it = pointers.values();
    return [it.next().value!, it.next().value!];
  };

  const endTwist = () => {
    if (gestMode === 'twist') cameraControls.endDragRotate();
    gestMode = 'undecided';
    gestAngle = 0;
    gestLogScale = 0;
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      // Right / middle drag: turn the view with the drag, settle to the nearest 90° on release.
      if (rotPointer !== -1) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      rotPointer = e.pointerId;
      pointers.set(e.pointerId, { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: pointerEventTime(e, performance.now()) });
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    el.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: pointerEventTime(e, performance.now()) });
    if (pointers.size === 1) {
      dragging = false;
      multi = false;
    } else {
      multi = true;
      dragging = false;
      const p = pair()!;
      pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      pinchAngle = Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x);
      endTwist();
    }
  };

  const move = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
      lastMouse.in = true;
    }
    const p = pointers.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') h.hover?.(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (e.pointerId === rotPointer) {
      if (!cameraControls.isDragRotating() && Math.abs(p.x - p.sx) < TAP_SLOP_MOUSE) return;
      // Include the slop so the turn starts from where the button went down.
      cameraControls.dragRotate((cameraControls.isDragRotating() ? dx : p.x - p.sx) * -DRAG_RAD_PER_PX);
      return;
    }
    if (pointers.size >= 2) {
      const pr = pair()!;
      const d = Math.hypot(pr[0].x - pr[1].x, pr[0].y - pr[1].y);
      const a = Math.atan2(pr[1].y - pr[0].y, pr[1].x - pr[0].x);
      let da = a - pinchAngle;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      pinchAngle = a;
      const ds = pinchDist > 10 && d > 10 ? Math.log(d / pinchDist) : 0;
      pinchDist = d;
      gestAngle += da;
      gestLogScale += ds;
      // Pinch or twist — decided once from the dominant motion, then only that one acts.
      if (gestMode === 'undecided') {
        gestMode = classifyTwoFinger(gestAngle, gestLogScale);
        if (gestMode === 'twist') cameraControls.dragRotate(-gestAngle);
        else if (gestMode === 'pinch') cameraControls.zoomBy(Math.exp(gestLogScale));
      } else if (gestMode === 'twist') cameraControls.dragRotate(-da);
      else cameraControls.zoomBy(Math.exp(ds));
      return;
    }
    if (multi) return;
    const slop = p.type === 'mouse' ? TAP_SLOP_MOUSE : TAP_SLOP_TOUCH;
    if (!dragging && Math.hypot(p.x - p.sx, p.y - p.sy) > slop) {
      dragging = true;
      // Include the slop distance so the pan starts exactly under the finger.
      h.pan(p.x - p.sx - dx, p.y - p.sy - dy);
    }
    if (dragging) h.pan(dx, dy);
  };

  const up = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    el.releasePointerCapture?.(e.pointerId);
    if (e.pointerId === rotPointer) {
      rotPointer = -1;
      rotEndedAt = performance.now();
      cameraControls.endDragRotate();
      return;
    }
    if (pointers.size < 2) endTwist();
    if (e.type === 'pointerup' && !dragging && !multi && pointers.size === 0 && isTapDuration(p.t, pointerEventTime(e, performance.now())) && !(p.type === 'mouse' && e.button === 2)) {
      h.tap(e.clientX, e.clientY, p.type);
    }
    if (pointers.size === 0) {
      dragging = false;
      multi = false;
    } else if (pointers.size === 1) {
      pinchDist = 0;
    }
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    // Normalise line/page deltas; trackpad pinch arrives as ctrl+wheel.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit * (e.ctrlKey ? 4 : 1);
    cameraControls.zoomBy(Math.exp(-dy * 0.0015));
  };
  const prevent = (e: Event) => e.preventDefault();
  // While the view turns (keys, buttons, drag), what is under a still mouse changes: re-hover there so
  // the build ghost / hover feedback stays under the pointer.
  const lastMouse = { x: 0, y: 0, in: false };
  let lastYaw = cameraRuntime.yaw;
  let raf = 0;
  const watchYaw = () => {
    raf = requestAnimationFrame(watchYaw);
    const y = cameraRuntime.yaw;
    if (Math.abs(y - lastYaw) < 1e-6) return;
    lastYaw = y;
    if (lastMouse.in && rotPointer === -1) h.hover?.(lastMouse.x, lastMouse.y);
  };
  raf = requestAnimationFrame(watchYaw);
  const leave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') lastMouse.in = false;
  };
  // The context menu is only held back while a right / middle drag is on the canvas (or just ended).
  const contextMenu = (e: Event) => {
    if (rotPointer !== -1 || performance.now() - rotEndedAt < 400) e.preventDefault();
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', contextMenu);
  el.addEventListener('pointerleave', leave);
  // iOS Safari pinch-zoom of the page / double-tap zoom / overscroll.
  el.addEventListener('gesturestart', prevent as EventListener);
  el.addEventListener('touchmove', prevent, { passive: false });
  el.addEventListener('dblclick', prevent);
  return () => {
    el.style.touchAction = prevTouchAction;
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('contextmenu', contextMenu);
    el.removeEventListener('pointerleave', leave);
    cancelAnimationFrame(raf);
    el.removeEventListener('gesturestart', prevent as EventListener);
    el.removeEventListener('touchmove', prevent);
    el.removeEventListener('dblclick', prevent);
  };
}
