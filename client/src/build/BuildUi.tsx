/**
 * Build mode UI (DOM, over the canvas): the Build button for the bottom nav,
 * and while building a glass dock in place of the nav — piece palette with
 * rendered thumbnails, style swatches, sign text, Rotate / Place / Remove /
 * Undo / Done, a status line (green hint or the refusal reason) and a card
 * for the piece picked with the remove tool (Remove if yours, Report if not).
 *
 * Mouse: hover aims the ghost, click places, R rotates, B or Esc finishes.
 * Touch: tap aims the ghost, then the explicit Place button; Rotate / Done buttons.
 */
import { useEffect, useRef, useState } from 'react';
import { CONFIG, PIECE_CATEGORIES, PIECES, PIECE_KINDS, type PieceKind } from '@elsewhere/shared';
import { useGameStore } from '../state/gameStore.js';
import { useIsTouch } from '../ui/hooks.js';
import { Icon } from '../ui/icons.js';
import { enterBuild, exitBuild, placeGhost, reportPiece, removePiece, rotate, selectKind, selectVariant, setSignText, setTool, toggleBuild, undo, unstuck } from './actions.js';
import { pieces, useBuildStore, variantFor } from './store.js';
import './build.css';

function Glyph({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
const HAMMER = 'M13.8 4.6 19.4 10l-2.2 2.2-1.5-1.4-7.9 8.5a1.7 1.7 0 0 1-2.5-2.4l8-8.3-1.5-1.5 2-2.5ZM14 4.4l2.4-.9 3.2 3.1-.8 2.5';
const ROTATE = 'M18.5 9.5A7 7 0 1 0 19 14M19 5v4.5h-4.5';
const UNDO = 'M9 7 5 11l4 4M5.5 11H14a5 5 0 0 1 0 10h-2';
const ERASE = 'M7.5 17.5h11M5.3 14.6l7.9-8.4a1.6 1.6 0 0 1 2.3 0l3 3a1.6 1.6 0 0 1 0 2.3l-5.8 6H8.6l-3.3-2.9Z';
const PLACE = 'M12 4.5v11M7.5 11 12 15.5l4.5-4.5M5.5 19.5h13';

/** The Build button in the bottom nav. */
export function BuildNavButton() {
  const on = useBuildStore((s) => s.mode !== 'off');
  return (
    <button type="button" className={`nav__btn nav__btn--build${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggleBuild()} data-testid="nav-build" title="Build (B)">
      <span className="nav__icon">
        <Glyph d={HAMMER} size={22} />
      </span>
      <span className="nav__label">Build</span>
    </button>
  );
}

function StatusLine({ touch }: { touch: boolean }) {
  const mode = useBuildStore((s) => s.mode);
  const ghost = useBuildStore((s) => s.ghost);
  const refusal = useBuildStore((s) => s.refusal);
  const kind = useBuildStore((s) => s.kind);
  const synced = useBuildStore((s) => s.synced);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!refusal) return;
    const t = setTimeout(() => tick((n) => n + 1), 3200);
    return () => clearTimeout(t);
  }, [refusal]);
  const recentRefusal = refusal && Date.now() - refusal.at < 3000 ? refusal.text : null;
  let text: string;
  let tone: 'ok' | 'bad' | 'soft' = 'soft';
  if (!synced) text = 'Gathering what others have built…';
  else if (recentRefusal) {
    text = recentRefusal;
    tone = 'bad';
  } else if (mode === 'remove') text = touch ? 'Tap one of your pieces to remove it' : 'Click one of your pieces to remove it';
  else if (!ghost) text = touch ? 'Tap the ground to aim' : 'Point at the ground to aim';
  else if (!ghost.ok) {
    text = ghost.message;
    tone = 'bad';
  } else {
    const lvl = ghost.level > 0 ? ` · storey ${ghost.level + 1}` : '';
    text = touch ? `Tap Place to build the ${PIECES[kind].name.toLowerCase()}${lvl}` : `Click to place${lvl} · R to turn · Esc when done`;
    tone = 'ok';
  }
  return (
    <div className={`build-status build-status--${tone}`} role="status" aria-live="polite" data-testid="build-status" data-tone={tone}>
      <span className="build-status__dot" aria-hidden="true" />
      <span className="build-status__text">{text}</span>
    </div>
  );
}

function Palette() {
  const kind = useBuildStore((s) => s.kind);
  const category = useBuildStore((s) => s.category);
  const thumbs = useBuildStore((s) => s.thumbs);
  const mode = useBuildStore((s) => s.mode);
  const kinds = PIECE_KINDS.filter((k) => PIECES[k].category === category);
  return (
    <div className="build-palette">
      <div className="build-tabs" role="tablist" aria-label="Piece groups">
        {PIECE_CATEGORIES.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={c.id === category} className={`build-tab${c.id === category ? ' is-on' : ''}`} onClick={() => useBuildStore.getState().set({ category: c.id })} data-testid={`build-tab-${c.id}`}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="build-tiles" role="listbox" aria-label="Pieces">
        {kinds.map((k) => {
          const on = mode === 'place' && k === kind;
          return (
            <button key={k} type="button" role="option" aria-selected={on} className={`build-tile${on ? ' is-on' : ''}`} onClick={() => selectKind(k)} title={PIECES[k].hint} data-testid={`build-piece-${k}`}>
              <span className="build-tile__img">{thumbs[k] ? <img src={thumbs[k]} alt="" draggable={false} /> : <span className="build-tile__ph" />}</span>
              <span className="build-tile__name">{PIECES[k].name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Variants({ kind }: { kind: PieceKind }) {
  useBuildStore((s) => s.variants[kind]);
  const cur = variantFor(kind);
  return (
    <div className="build-swatches" role="radiogroup" aria-label="Style">
      {PIECES[kind].variants.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={v.id === cur}
          aria-label={v.name}
          title={v.name}
          className={`build-swatch${v.id === cur ? ' is-on' : ''}`}
          style={{ background: `linear-gradient(135deg, ${v.colors.main} 0 58%, ${v.colors.trim} 58% 100%)` }}
          onClick={() => selectVariant(kind, v.id)}
          data-testid={`build-variant-${v.id}`}
        />
      ))}
    </div>
  );
}

function SignInput() {
  const text = useBuildStore((s) => s.signText);
  return (
    <label className="build-sign">
      <span className="visually-hidden">Sign text</span>
      <input
        type="text"
        className="build-sign__input"
        value={text}
        maxLength={CONFIG.building.signMaxLength}
        placeholder="Words for your sign…"
        onChange={(e) => setSignText(e.target.value)}
        data-testid="build-sign-text"
      />
      <span className="build-sign__count">{CONFIG.building.signMaxLength - [...text].length}</span>
    </label>
  );
}

function SelectionCard() {
  const selected = useBuildStore((s) => s.selected);
  useBuildStore((s) => s.version);
  const me = useGameStore((s) => s.profile?.profileId);
  const p = selected ? pieces.index.get(selected) : undefined;
  if (!p) return null;
  const mine = p.ownerId === me;
  const variant = PIECES[p.kind].variants.find((v) => v.id === p.variant)?.name;
  return (
    <div className="build-card" data-testid="build-selected" data-owner={mine ? 'me' : 'other'}>
      <div className="build-card__text">
        <span className="build-card__title">
          {PIECES[p.kind].name}
          {variant ? <span className="build-card__sub"> · {variant}</span> : null}
        </span>
        <span className="build-card__by">{mine ? 'Built by you' : `Built by ${p.ownerName || 'someone'}`}</span>
        {p.text ? <span className="build-card__quote">“{p.text}”</span> : null}
      </div>
      {mine ? (
        <button type="button" className="btn btn--danger btn--sm" onClick={() => removePiece(p.id)} data-testid="build-remove">
          Remove
        </button>
      ) : (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => reportPiece(p.id)} data-testid="build-report">
          <Icon name="flag" size={16} /> Report
        </button>
      )}
    </div>
  );
}

function Dock() {
  const touch = useIsTouch();
  const mode = useBuildStore((s) => s.mode);
  const kind = useBuildStore((s) => s.kind);
  const ghostOk = useBuildStore((s) => !!s.ghost?.ok);
  const canUndo = useBuildStore((s) => s.undo.some((id) => pieces.index.get(id)));
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  // Keep the touch joystick clear of the dock.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--ew-touch-bottom');
    const apply = () => root.style.setProperty('--ew-touch-bottom', `${Math.round(el.getBoundingClientRect().height + 22)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (prev) root.style.setProperty('--ew-touch-bottom', prev);
      else root.style.removeProperty('--ew-touch-bottom');
    };
  }, []);

  return (
    <div className={`build-dock${touch ? ' is-touch' : ''}`} ref={ref} data-testid="build-dock" data-mode={mode}>
      <StatusLine touch={touch} />
      {mode === 'remove' ? <SelectionCard /> : null}
      <div className="build-panel">
        {mode === 'place' ? <Palette /> : null}
        <div className="build-bar">
          {mode === 'place' ? (
            <>
              <Variants kind={kind} />
              {PIECES[kind].text ? <SignInput /> : null}
            </>
          ) : (
            <span className="build-bar__note">Only your own pieces can be removed. Pieces holding others up go last.</span>
          )}
          <div className="build-actions">
            {mode === 'place' ? (
              <button type="button" className="build-act" onClick={() => rotate(1)} aria-label="Rotate piece" title="Rotate (R)" data-testid="build-rotate">
                <Glyph d={ROTATE} />
                <span className="build-act__label">Rotate</span>
              </button>
            ) : null}
            <button type="button" className={`build-act${mode === 'remove' ? ' is-on' : ''}`} onClick={() => setTool(mode === 'remove' ? 'place' : 'remove')} aria-pressed={mode === 'remove'} data-testid="build-tool-remove">
              <Glyph d={ERASE} />
              <span className="build-act__label">{mode === 'remove' ? 'Build' : 'Remove'}</span>
            </button>
            <button type="button" className="build-act" onClick={() => undo()} disabled={!canUndo} aria-label="Undo last piece" data-testid="build-undo">
              <Glyph d={UNDO} />
              <span className="build-act__label">Undo</span>
            </button>
            <span className="build-more">
              <button type="button" className="build-act build-act--quiet" onClick={() => setMore((v) => !v)} aria-expanded={more} aria-label="More" data-testid="build-more">
                <span className="build-act__dots" aria-hidden="true">···</span>
              </button>
              {more ? (
                <span className="build-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="build-menu__item"
                    onClick={() => {
                      setMore(false);
                      unstuck();
                    }}
                    data-testid="build-unstuck"
                  >
                    Stuck? Back to the Town Square
                  </button>
                </span>
              ) : null}
            </span>
            {mode === 'place' && touch ? (
              <button type="button" className="btn btn--primary build-place" onClick={() => placeGhost()} disabled={!ghostOk} data-testid="build-place">
                <Glyph d={PLACE} size={18} /> Place
              </button>
            ) : null}
            <button type="button" className={`btn ${touch && mode === 'place' ? 'btn--ghost' : 'btn--primary'} build-done`} onClick={() => exitBuild()} data-testid="build-done">
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Mounted by the HUD; renders nothing unless building. */
export function BuildUi() {
  const mode = useBuildStore((s) => s.mode);
  const connected = useGameStore((s) => s.connection === 'connected');
  useEffect(() => {
    if (!connected && mode !== 'off') exitBuild();
  }, [connected, mode]);
  if (mode === 'off') return null;
  return <Dock />;
}

export { enterBuild };
