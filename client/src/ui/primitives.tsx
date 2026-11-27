/** Shared UI primitives: Sheet (panel / bottom sheet), buttons, controls. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cameraRuntime } from '../player/camera.js';
import { isTextEntry, useMediaQuery } from './hooks.js';
import { Icon, type IconName } from './icons.js';

export type SheetSize = 'side' | 'wide' | 'reading' | 'card';

/** Phone layouts (same breakpoints as ui.css): where a peek sheet actually peeks. */
export const PHONE_LAYOUT_QUERY = '(max-width: 720px), (max-height: 500px) and (orientation: landscape)';

/** Peek sheets: a short sheet that leaves the world visible, or the full sheet. */
export type SheetView = 'peek' | 'full';
/** Drag distances (px) on the handle / header. */
export const SHEET_DRAG_OPEN = 40;
export const SHEET_DRAG_CLOSE = 90;
export const SHEET_DRAG_SETTLE = 60;

/**
 * Where a vertical drag of `dy` px (+ = down) on a peek sheet's handle leaves it:
 * up → full; down from full → peek; down from peek far enough → closed.
 */
export function sheetAfterDrag(view: SheetView, dy: number): SheetView | 'closed' {
  if (dy <= -SHEET_DRAG_OPEN) return 'full';
  if (view === 'full' && dy >= SHEET_DRAG_SETTLE) return 'peek';
  if (view === 'peek' && dy >= SHEET_DRAG_CLOSE) return 'closed';
  return view;
}

/** Other peek-sheet transitions: a tap on the handle toggles; typing needs the full sheet; Esc / ✕ close. */
export function sheetAfterEvent(view: SheetView, ev: 'handle' | 'text-focus' | 'close'): SheetView | 'closed' {
  if (ev === 'close') return 'closed';
  if (ev === 'text-focus') return 'full';
  return view === 'peek' ? 'full' : 'peek';
}

export interface SheetProps {
  title: ReactNode;
  eyebrow?: ReactNode;
  icon?: IconName;
  size?: SheetSize;
  tone?: 'glass' | 'paper';
  onClose(): void;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  /** Extra header content (e.g. tabs). */
  headerExtra?: ReactNode;
  className?: string;
  /** Hide the visible title (still labels the dialog). */
  hideTitle?: boolean;
  /** Content shown in the header in place of the visible title (e.g. tabs). */
  headerInline?: ReactNode;
  /**
   * Opt-in peek mode (phones only): the sheet opens short, with a drag handle (peek ↔ full ↔ close),
   * and the camera frames the player (and `subject`) in the part of the screen it leaves free.
   * Focusing a text field takes it to full. No effect on desktop layouts.
   */
  peek?: boolean;
  /** World point of the thing being used (kept on screen next to the player while peeking). */
  subject?: { x: number; z: number } | null;
}

/**
 * Floating panel on desktop/tablet, bottom sheet on phones (CSS), side sheet on
 * landscape phones. Takes focus on open and gives it back on close. Swipe the
 * header down on touch to dismiss.
 */
export function Sheet({ title, eyebrow, icon, size = 'side', tone = 'glass', onClose, onBack, children, footer, testId, headerExtra, className, hideTitle, headerInline, peek, subject }: SheetProps) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const phone = useMediaQuery(PHONE_LAYOUT_QUERY);
  const peekable = !!peek && phone;
  const [view, setView] = useState<SheetView>('peek');
  const peeking = peekable && view === 'peek';
  const handleStart = useRef<{ y: number; id: number } | null>(null);
  const [handleDrag, setHandleDrag] = useState(0);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Focus the sheet itself (not the first button) so screen readers announce it and no button looks pre-selected.
    el?.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev) && prev !== document.body) prev.focus({ preventScroll: true });
    };
  }, []);

  // While peeking, keep the thing being used on screen beside the player (the camera rig reads it).
  const sx = subject?.x;
  const sz = subject?.z;
  useEffect(() => {
    if (!peeking || sx === undefined || sz === undefined) return;
    const s = { x: sx, z: sz };
    cameraRuntime.coverSubject = s;
    return () => {
      if (cameraRuntime.coverSubject === s) cameraRuntime.coverSubject = null;
    };
  }, [peeking, sx, sz]);

  const go = (next: SheetView | 'closed') => {
    if (next === 'closed') onClose();
    else setView(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    start.current = e.clientY;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current === null) return;
    const dy = e.clientY - start.current;
    setDrag(peekable ? dy : Math.max(0, dy));
  };
  const onPointerUp = () => {
    if (start.current === null) return;
    start.current = null;
    if (peekable) go(sheetAfterDrag(view, drag));
    else if (drag > SHEET_DRAG_CLOSE) onClose();
    setDrag(0);
  };

  // The handle: tap toggles peek / full; drag up = full, down = peek, then closed.
  const onHandleDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    handleStart.current = { y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const h = handleStart.current;
    if (!h || h.id !== e.pointerId) return;
    setHandleDrag(e.clientY - h.y);
  };
  const onHandleUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const h = handleStart.current;
    if (!h || h.id !== e.pointerId) return;
    handleStart.current = null;
    const dy = e.clientY - h.y;
    setHandleDrag(0);
    if (Math.abs(dy) < 10) go(sheetAfterEvent(view, 'handle'));
    else go(sheetAfterDrag(view, dy));
  };
  const onHandleCancel = () => {
    handleStart.current = null;
    setHandleDrag(0);
  };
  const onFocusCapture = (e: React.FocusEvent) => {
    if (!peekable || view === 'full') return;
    const t = e.target as HTMLElement;
    if (isTextEntry(t) && !(t as HTMLInputElement).readOnly) go(sheetAfterEvent(view, 'text-focus'));
  };

  const dy = drag || handleDrag;
  const shown = peekable ? Math.max(0, dy) : dy;
  const cls = `sheet sheet--${size} sheet--${tone}${peekable ? ` sheet--peekable sheet--${view}` : ''}${className ? ` ${className}` : ''}`;
  return (
    <section
      ref={ref}
      className={cls}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-t`}
      tabIndex={-1}
      data-testid={testId}
      data-view={peekable ? view : undefined}
      data-camera-cover={peeking ? '' : undefined}
      onFocusCapture={peekable ? onFocusCapture : undefined}
      style={shown ? { transform: `translateY(${shown}px)`, transition: 'none' } : undefined}
    >
      {peekable ? (
        <button
          type="button"
          className="sheet__handle"
          aria-label={view === 'peek' ? 'Show more' : 'Show less'}
          aria-expanded={view === 'full'}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleCancel}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              go(sheetAfterEvent(view, 'handle'));
            }
          }}
          data-testid="sheet-handle"
        >
          <span className="sheet__handle-bar" aria-hidden="true" />
        </button>
      ) : null}
      <header className="sheet__head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <span className="sheet__grip" aria-hidden="true" />
        {onBack ? (
          <button type="button" className="icon-btn icon-btn--sm" onClick={onBack} aria-label="Back">
            <Icon name="back" size={20} />
          </button>
        ) : icon ? (
          <span className="sheet__icon" aria-hidden="true">
            <Icon name={icon} size={20} />
          </span>
        ) : null}
        {headerInline ? <div className="sheet__inline">{headerInline}</div> : null}
        <div className={`sheet__titles${hideTitle || headerInline ? ' visually-hidden' : ''}`}>
          {eyebrow ? <div className="sheet__eyebrow">{eyebrow}</div> : null}
          <h2 className="sheet__title" id={`${id}-t`}>
            {title}
          </h2>
        </div>
        <button type="button" className="icon-btn icon-btn--sm sheet__close" onClick={onClose} aria-label="Close" data-testid="sheet-close">
          <Icon name="close" size={20} />
        </button>
      </header>
      {headerExtra ? <div className="sheet__extra">{headerExtra}</div> : null}
      <div className="sheet__body">{children}</div>
      {footer ? <footer className="sheet__foot">{footer}</footer> : null}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, size }: { value: T; options: readonly { id: T; label: string }[]; onChange(v: T): void; label: string; size?: 'sm' }) {
  return (
    <div className={`segmented${size ? ` segmented--${size}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'is-on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, testId }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; testId?: string }) {
  const id = useId();
  return (
    <div className="row-control">
      <label htmlFor={id} className="row-control__label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </label>
      <button id={id} type="button" role="switch" aria-checked={checked} className={`switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)} data-testid={testId}>
        <span className="switch__knob" />
      </button>
    </div>
  );
}

export function Slider({ label, value, onChange, disabled, icon, testId }: { label: string; value: number; onChange(v: number): void; disabled?: boolean; icon?: IconName; testId?: string }) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <div className={`slider${disabled ? ' is-disabled' : ''}`}>
      <label htmlFor={id} className="slider__label">
        {icon ? <Icon name={icon} size={18} /> : null}
        <span>{label}</span>
        <output htmlFor={id} className="slider__value">
          {pct}
        </output>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        data-testid={testId}
      />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty__icon" aria-hidden="true">
        <Icon name={icon} size={26} />
      </span>
      <p className="empty__title">{title}</p>
      {children ? <div className="empty__text">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span />
    </span>
  );
}
