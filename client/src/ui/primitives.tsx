/** Shared UI primitives: Sheet (panel / bottom sheet), buttons, controls. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';

export type SheetSize = 'side' | 'wide' | 'reading' | 'card';

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
}

/**
 * Floating panel on desktop/tablet, bottom sheet on phones (CSS), side sheet on
 * landscape phones. Takes focus on open and gives it back on close. Swipe the
 * header down on touch to dismiss.
 */
export function Sheet({ title, eyebrow, icon, size = 'side', tone = 'glass', onClose, onBack, children, footer, testId, headerExtra, className, hideTitle, headerInline }: SheetProps) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Focus the sheet itself (not the first button) so screen readers announce it and no button looks pre-selected.
    el?.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev) && prev !== document.body) prev.focus({ preventScroll: true });
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    start.current = e.clientY;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current === null) return;
    setDrag(Math.max(0, e.clientY - start.current));
  };
  const onPointerUp = () => {
    if (start.current === null) return;
    start.current = null;
    if (drag > 90) onClose();
    setDrag(0);
  };

  return (
    <section
      ref={ref}
      className={`sheet sheet--${size} sheet--${tone}${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-t`}
      tabIndex={-1}
      data-testid={testId}
      style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
    >
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
