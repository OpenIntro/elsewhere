/**
 * Touch controls (DOM, rendered next to the Canvas by game/GameCanvas):
 *  - Virtual joystick (bottom-left): analog walk, near-full deflection runs.
 *  - Contextual action button (bottom-right, near the thumb): shown while an
 *    interaction prompt / player prompt is active, or "Stand" while seated.
 * Shown per settings.controls.showTouchControls ('auto' = touch devices only).
 * Layout hooks for the UI worker (CSS custom properties on :root):
 *   --ew-touch-bottom (default 92px)  distance from the bottom edge (clear a bottom nav)
 *   --ew-touch-side   (default 22px)  distance from the side edges
 * Elements: [data-testid=joystick], [data-testid=joystick-knob], [data-testid=touch-action].
 */
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useGameStore } from '../state/gameStore.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { useUiStore } from '../state/uiStore.js';
import { pressContextual, pressInteract, setTouchMove } from './input.js';
import { useBuildStore } from '../build/store.js';

const BASE = 124;
const KNOB = 52;
const RANGE = (BASE - KNOB) / 2 + 6;

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(pointer: coarse)').matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
}

export function useTouchControlsVisible(): boolean {
  const pref = useSettingsStore((s) => s.controls.showTouchControls);
  const [touch, setTouch] = useState(isTouchDevice);
  useEffect(() => {
    // A first touch on a hybrid device switches to touch mode.
    const on = (e: PointerEvent) => {
      if (e.pointerType === 'touch') setTouch(true);
    };
    window.addEventListener('pointerdown', on, { passive: true });
    return () => window.removeEventListener('pointerdown', on);
  }, []);
  return pref === 'always' || (pref === 'auto' && touch);
}

export function TouchControls() {
  const visible = useTouchControlsVisible();
  const phase = useUiStore((s) => s.phase);
  const connected = useGameStore((s) => s.sessionId !== null);
  if (!visible || phase !== 'playing' || !connected) return null;
  return (
    <>
      <Joystick />
      <ActionButton />
    </>
  );
}

function Joystick() {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const active = useRef<number | null>(null);
  const center = useRef({ x: 0, y: 0 });

  const update = (clientX: number, clientY: number) => {
    let dx = clientX - center.current.x;
    let dy = clientY - center.current.y;
    const d = Math.hypot(dx, dy);
    if (d > RANGE) {
      dx = (dx / d) * RANGE;
      dy = (dy / d) * RANGE;
    }
    if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
    const mx = dx / RANGE;
    const my = -dy / RANGE;
    const m = Math.hypot(mx, my);
    // Small dead zone so resting a thumb doesn't drift.
    if (m < 0.12) setTouchMove(0, 0, true, false);
    else setTouchMove(mx, my, true, m > 0.92);
  };
  const release = () => {
    active.current = null;
    setTouchMove(0, 0, false);
    if (knob.current) knob.current.style.transform = 'translate(0px, 0px)';
    base.current?.classList.remove('ew-joy-active');
  };
  useEffect(() => release, []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (active.current !== null) return;
    active.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    center.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    base.current?.classList.add('ew-joy-active');
    update(e.clientX, e.clientY);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (active.current !== e.pointerId) return;
    e.preventDefault();
    update(e.clientX, e.clientY);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (active.current !== e.pointerId) return;
    release();
  };

  return (
    <div
      ref={base}
      data-testid="joystick"
      aria-label="Move"
      role="application"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
      style={joyBase}
    >
      <div ref={knob} data-testid="joystick-knob" style={joyKnob} />
    </div>
  );
}

function ActionButton() {
  const prompt = useUiStore((s) => s.prompt);
  const playerPrompt = useUiStore((s) => s.playerPrompt);
  const panel = useUiStore((s) => s.panel);
  const menu = useUiStore((s) => s.playerMenu);
  const seated = useGameStore((s) => !!(s.sessionId && s.players[s.sessionId]?.seat));
  // No interacting while building (desktop: E is swallowed by build/input.ts); the joystick still walks.
  const building = useBuildStore((s) => s.mode !== 'off');
  if (panel || menu || building) return null;
  let label: string | null = null;
  let sub = '';
  let onPress = pressInteract;
  if (prompt) {
    label = prompt.label;
    sub = prompt.name;
  } else if (playerPrompt) {
    label = playerPrompt.label;
    sub = playerPrompt.name;
  } else if (seated) {
    label = 'Stand';
    onPress = pressContextual;
  }
  if (!label) return null;
  return (
    <button
      type="button"
      data-testid="touch-action"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPress();
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={actionBtn}
    >
      <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.1 }}>{label}</span>
      {sub && <span style={{ fontSize: 11, opacity: 0.75, marginTop: 2, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
    </button>
  );
}

const joyBase: CSSProperties = {
  position: 'fixed',
  left: 'calc(var(--ew-touch-side, 22px) + env(safe-area-inset-left, 0px))',
  bottom: 'calc(var(--ew-touch-bottom, 92px) + env(safe-area-inset-bottom, 0px))',
  width: BASE,
  height: BASE,
  borderRadius: '50%',
  background: 'radial-gradient(circle, rgba(42,38,34,0.28) 0%, rgba(42,38,34,0.42) 100%)',
  border: '1.5px solid rgba(239,228,207,0.35)',
  boxShadow: '0 4px 18px rgba(0,0,0,0.18)',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const joyKnob: CSSProperties = {
  width: KNOB,
  height: KNOB,
  borderRadius: '50%',
  background: 'rgba(239,228,207,0.82)',
  boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  pointerEvents: 'none',
  transition: 'transform 60ms linear',
};

const actionBtn: CSSProperties = {
  position: 'fixed',
  right: 'calc(var(--ew-touch-side, 22px) + env(safe-area-inset-right, 0px))',
  bottom: 'calc(var(--ew-touch-bottom, 92px) + 14px + env(safe-area-inset-bottom, 0px))',
  width: 96,
  height: 96,
  borderRadius: '50%',
  border: '1.5px solid rgba(239,228,207,0.45)',
  background: 'rgba(42,38,34,0.78)',
  color: '#efe4cf',
  font: '14px/1.2 system-ui, sans-serif',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 8,
  touchAction: 'none',
  userSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  boxShadow: '0 4px 18px rgba(0,0,0,0.22)',
  zIndex: 20,
  cursor: 'pointer',
};
