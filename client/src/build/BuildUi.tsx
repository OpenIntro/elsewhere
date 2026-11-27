/**
 * Build mode UI (DOM, over the canvas): the Build button for the bottom nav,
 * and while building a glass dock in place of the nav — piece palette with
 * rendered thumbnails, style swatches, sign text, Rotate / Place / Remove /
 * Undo / Done, a status line (green hint or the refusal reason) and a card
 * for the piece picked with the remove tool (Remove if yours, Report if not).
 *
 * Mouse: hover aims the ghost, click places, R rotates, B or Esc finishes.
 * Touch: tap aims the ghost, then the explicit Place button; Rotate / Done buttons.
 *
 * Landscape phones get a slim strip instead (StripDock): the chosen piece as a chip
 * (tap → the palette opens over the strip; choosing a piece closes it), Rotate, Undo,
 * Place, Done, and ··· for Remove / Clear / the storey control / Next / Unstuck. The
 * strip is a camera cover: the rig frames the player in the world above it.
 */
import { useEffect, useRef, useState } from 'react';
import { CONFIG, PALETTE_ORDER, PIECE_CATEGORIES, PIECES, natureItem, type PieceKind } from '@elsewhere/shared';
import { runtime } from '../state/runtime.js';
import { useGameStore } from '../state/gameStore.js';
import { useIsTouch, useMediaQuery } from '../ui/hooks.js';
import { Icon } from '../ui/icons.js';
import {
  canRepeat,
  clearNature,
  editText,
  enterBuild,
  exitBuild,
  nextSegment,
  placeGhost,
  reportPiece,
  removePiece,
  rotate,
  selectKind,
  selectVariant,
  setAutoStorey,
  setRoofOptions,
  setSignText,
  setTool,
  stepStorey,
  toggleBuild,
  undo,
  unstuck,
} from './actions.js';
import { STRIP_QUERY, dockEvent, pieces, useBuildStore, variantFor } from './store.js';
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
const UP = 'M6 14.5 12 8.5l6 6';
const DOWN = 'M6 9.5l6 6 6-6';
const LEAF_ICON = 'M5 19c0-8 5-13 14-14-1 9-6 14-14 14Zm0 0 7-7';
const NEXT = 'M5 12h11M12 7l5 5-5 5M19 6v12';
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
  const natureId = useBuildStore((s) => (s.mode === 'place' && s.ghost && !s.ghost.ok ? s.ghost.natureId : undefined));
  if (mode === 'clear' && tone !== 'bad') text = touch ? 'Tap a bush or a small rock to clear it' : 'Click a bush or a small rock to clear it';
  return (
    <div className={`build-status build-status--${tone}`} role="status" aria-live="polite" data-testid="build-status" data-tone={tone}>
      <span className="build-status__dot" aria-hidden="true" />
      <span className="build-status__text">{text}</span>
      {natureId && !recentRefusal ? (
        <button type="button" className="build-status__act" onClick={() => clearNature(natureId)} data-testid="build-clear-offer">
          {natureItem(natureId)?.kind === 'rock' ? 'Clear rock' : 'Clear bush'}
        </button>
      ) : null}
    </div>
  );
}

function Palette({ onPick }: { onPick?: () => void }) {
  const kind = useBuildStore((s) => s.kind);
  const category = useBuildStore((s) => s.category);
  const query = useBuildStore((s) => s.query);
  const thumbs = useBuildStore((s) => s.thumbs);
  const mode = useBuildStore((s) => s.mode);
  const q = query.trim().toLowerCase();
  const kinds = PALETTE_ORDER.filter((k) => !PIECES[k].legacy || (category === 'roof' && !q)).filter((k) =>
    q ? PIECES[k].name.toLowerCase().includes(q) || PIECES[k].hint.toLowerCase().includes(q) || k.replace('_', ' ').includes(q) : PIECES[k].category === category,
  );
  return (
    <div className="build-palette">
      <div className="build-tabs-row">
        <div className="build-tabs" role="tablist" aria-label="Piece groups">
          {PIECE_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={!q && c.id === category}
              className={`build-tab${!q && c.id === category ? ' is-on' : ''}`}
              onClick={() => useBuildStore.getState().set({ category: c.id, query: '' })}
              data-testid={`build-tab-${c.id}`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <label className="build-search">
          <span className="visually-hidden">Find a piece</span>
          <input type="search" className="build-search__input" value={query} placeholder="Find…" onChange={(e) => useBuildStore.getState().set({ query: e.target.value })} data-testid="build-search" />
        </label>
      </div>
      <div className="build-tiles" role="listbox" aria-label="Pieces">
        {kinds.map((k) => {
          const on = mode === 'place' && k === kind;
          return (
            <button key={k} type="button" role="option" aria-selected={on} className={`build-tile${on ? ' is-on' : ''}${PIECES[k].legacy ? ' is-legacy' : ''}`} onClick={() => {
                selectKind(k);
                onPick?.();
              }}
              title={PIECES[k].hint} data-testid={`build-piece-${k}`}>
              <span className="build-tile__img">{thumbs[k] ? <img src={thumbs[k]} alt="" draggable={false} /> : <span className="build-tile__ph" />}</span>
              <span className="build-tile__name">{PIECES[k].name}</span>
            </button>
          );
        })}
        {kinds.length === 0 ? <span className="build-bar__note">Nothing called that.</span> : null}
      </div>
    </div>
  );
}

/** Storey control: ▲ / ▼ lock the ghost to a storey (PgUp / PgDn); the label goes back to automatic. */
function StoreyControl() {
  const lock = useBuildStore((s) => s.lockLevel);
  const level = useBuildStore((s) => s.ghost?.level ?? 0);
  const shown = lock ?? level;
  return (
    <div className="build-storey" role="group" aria-label="Storey" data-testid="build-storey" data-lock={lock === null ? 'auto' : String(lock)}>
      <button type="button" className="build-storey__btn" onClick={() => stepStorey(1)} aria-label="Up a storey" title="Up a storey (PgUp)" data-testid="build-storey-up">
        <Glyph d={UP} size={16} />
      </button>
      <button type="button" className={`build-storey__label${lock === null ? '' : ' is-locked'}`} onClick={() => setAutoStorey()} title={lock === null ? 'Storey follows what you point at' : 'Locked — tap for automatic'} data-testid="build-storey-label">
        <span className="build-storey__n">{shown === 0 ? 'Ground' : `Storey ${shown + 1}`}</span>
        <span className="build-storey__hint">{lock === null ? 'auto' : 'locked'}</span>
      </button>
      <button type="button" className="build-storey__btn" onClick={() => stepStorey(-1)} aria-label="Down a storey" title="Down a storey (PgDn)" data-testid="build-storey-down">
        <Glyph d={DOWN} size={16} />
      </button>
    </div>
  );
}

function RoofOptions() {
  const style = useBuildStore((s) => s.roofStyle);
  const pitch = useBuildStore((s) => s.roofPitch);
  return (
    <div className="build-seg" role="group" aria-label="Roof shape">
      {(['gable', 'hip'] as const).map((v) => (
        <button key={v} type="button" className={`build-seg__btn${style === v ? ' is-on' : ''}`} aria-pressed={style === v} onClick={() => setRoofOptions({ style: v })} data-testid={`build-roof-${v}`}>
          {v === 'gable' ? 'Gable' : 'Hip'}
        </button>
      ))}
      <span className="build-seg__gap" />
      {([0, 1] as const).map((v) => (
        <button key={v} type="button" className={`build-seg__btn${pitch === v ? ' is-on' : ''}`} aria-pressed={pitch === v} onClick={() => setRoofOptions({ pitch: v })} data-testid={`build-pitch-${v}`}>
          {v === 0 ? 'Gentle' : 'Steep'}
        </button>
      ))}
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
  const kind = useBuildStore((s) => s.kind);
  const max = PIECES[kind].textMax ?? CONFIG.building.signMaxLength;
  const facade = !!PIECES[kind].mount;
  return (
    <label className="build-sign">
      <span className="visually-hidden">Sign text</span>
      <input
        type="text"
        className="build-sign__input"
        value={text}
        maxLength={max}
        placeholder={facade ? 'Name of your building…' : 'Words for your sign…'}
        onChange={(e) => setSignText(e.target.value)}
        data-testid="build-sign-text"
      />
      <span className="build-sign__count">{max - [...text].length}</span>
    </label>
  );
}

function SelectionCard() {
  const selected = useBuildStore((s) => s.selected);
  const editing = useBuildStore((s) => s.editing);
  useBuildStore((s) => s.version);
  const me = useGameStore((s) => s.profile?.profileId);
  const p = selected ? pieces.index.get(selected) : undefined;
  const [draft, setDraft] = useState('');
  if (!p) return null;
  const mine = p.ownerId === me;
  const def = PIECES[p.kind];
  const variant = def.variants.find((v) => v.id === p.variant)?.name;
  const max = def.textMax ?? CONFIG.building.signMaxLength;
  if (editing === p.id) {
    return (
      <div className="build-card build-card--edit" data-testid="build-edit">
        <label className="build-sign">
          <span className="visually-hidden">New words</span>
          <input type="text" className="build-sign__input" value={draft} maxLength={max} onChange={(e) => setDraft(e.target.value)} data-testid="build-edit-text" autoFocus />
          <span className="build-sign__count">{max - [...draft].length}</span>
        </label>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => editText(p.id, draft)} disabled={!draft.trim()} data-testid="build-edit-save">
          Save
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => useBuildStore.getState().set({ editing: null })}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="build-card" data-testid="build-selected" data-owner={mine ? 'me' : 'other'}>
      <div className="build-card__text">
        <span className="build-card__title">
          {def.name}
          {variant ? <span className="build-card__sub"> · {variant}</span> : null}
        </span>
        <span className="build-card__by">{mine ? 'Built by you' : `Built by ${p.ownerName || 'someone'}`}</span>
        {p.text ? <span className="build-card__quote">“{p.text}”</span> : null}
      </div>
      {mine && def.text ? (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setDraft(p.text ?? '');
            useBuildStore.getState().set({ editing: p.id });
          }}
          data-testid="build-edit-open"
        >
          Edit words
        </button>
      ) : null}
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

/** A bush / rock picked with the clear (or remove) tool. */
function NatureCard() {
  const id = useBuildStore((s) => s.selectedNature);
  if (!id) return null;
  const n = natureItem(id);
  if (!n) return null;
  const what = n.kind === 'rock' ? 'Small rock' : 'Bush';
  return (
    <div className="build-card" data-testid="build-nature" data-nature={id}>
      <div className="build-card__text">
        <span className="build-card__title">{what}</span>
        <span className="build-card__by">Grows back by itself after a while unless you build here.</span>
      </div>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => clearNature(id)} data-testid="build-clear">
        {n.kind === 'rock' ? 'Clear rock' : 'Clear bush'}
      </button>
    </div>
  );
}

/**
 * Keep the touch joystick / action button clear of the dock: lift them above it — unless the dock sits
 * between them (phone landscape: the dock leaves both sides free), where lifting would only push the
 * action button into the camera buttons.
 */
function useTouchClearance(ref: React.RefObject<HTMLDivElement | null>, layout: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const prev = root.style.getPropertyValue('--ew-touch-bottom');
    const apply = () => {
      const r = el.getBoundingClientRect();
      // side zones of the thumb controls (player/TouchControls: 22 px margin, 124 px joystick, 96 px button)
      const between = r.left >= 22 + 124 + 4 && r.right <= window.innerWidth - (22 + 96 + 4);
      if (between) {
        if (prev) root.style.setProperty('--ew-touch-bottom', prev);
        else root.style.removeProperty('--ew-touch-bottom');
      } else root.style.setProperty('--ew-touch-bottom', `${Math.round(r.height + 22)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      if (prev) root.style.setProperty('--ew-touch-bottom', prev);
      else root.style.removeProperty('--ew-touch-bottom');
    };
  }, [ref, layout]);
}

function Dock() {
  const touch = useIsTouch();
  const ref = useRef<HTMLDivElement>(null);
  // Every entry into build mode (and every orientation change) starts with the strip collapsed.
  const strip = useMediaQuery(STRIP_QUERY);
  useEffect(() => dockEvent({ type: 'enter' }), []);
  useEffect(() => dockEvent({ type: 'orient' }), [strip]);
  useTouchClearance(ref, strip ? 'strip' : 'dock');
  return strip ? <StripDock touch={touch} dockRef={ref} /> : <FullDock touch={touch} dockRef={ref} />;
}

function FullDock({ touch, dockRef }: { touch: boolean; dockRef: React.RefObject<HTMLDivElement | null> }) {
  const mode = useBuildStore((s) => s.mode);
  const kind = useBuildStore((s) => s.kind);
  const ghostOk = useBuildStore((s) => !!s.ghost?.ok);
  const cornerPick = useBuildStore((s) => !!s.ghost && !s.ghost.ok && /corner/.test(s.ghost.message));
  const isRoof = PIECES[kind].param === 'roof';
  useBuildStore((s) => s.version);
  const repeat = canRepeat();
  const canUndo = useBuildStore((s) => s.undo.some((id) => pieces.index.get(id)));
  const [more, setMore] = useState(false);

  return (
    <div className={`build-dock${touch ? ' is-touch' : ''}`} ref={dockRef} data-testid="build-dock" data-mode={mode}>
      <StatusLine touch={touch} />
      {mode === 'remove' ? <SelectionCard /> : null}
      {mode === 'remove' || mode === 'clear' ? <NatureCard /> : null}
      <div className="build-panel">
        {mode === 'place' ? <Palette /> : null}
        {mode === 'place' && isRoof ? <RoofOptions /> : null}
        <div className="build-bar">
          {mode === 'place' ? (
            <>
              <Variants kind={kind} />
              {PIECES[kind].text ? <SignInput /> : null}
              <StoreyControl />
            </>
          ) : (
            <span className="build-bar__note">
              {mode === 'clear' ? 'Bushes and small rocks on open land. Trees and the town’s gardens stay.' : 'Only your own pieces can be removed. Pieces holding others up go last.'}
            </span>
          )}
          <div className="build-actions">
            {mode === 'place' ? (
              <button type="button" className="build-act" onClick={() => rotate(1)} aria-label={isRoof ? 'Turn the ridge' : 'Rotate piece'} title="Rotate (R)" data-testid="build-rotate">
                <Glyph d={ROTATE} />
                <span className="build-act__label">{isRoof ? 'Ridge' : 'Rotate'}</span>
              </button>
            ) : null}
            {mode === 'place' && repeat ? (
              <button type="button" className="build-act" onClick={() => nextSegment()} aria-label="Next along the run" title="Next along the run (N)" data-testid="build-next">
                <Glyph d={NEXT} />
                <span className="build-act__label">Next</span>
              </button>
            ) : null}
            <button type="button" className={`build-act${mode === 'remove' ? ' is-on' : ''}`} onClick={() => setTool(mode === 'remove' ? 'place' : 'remove')} aria-pressed={mode === 'remove'} data-testid="build-tool-remove">
              <Glyph d={ERASE} />
              <span className="build-act__label">{mode === 'remove' ? 'Build' : 'Remove'}</span>
            </button>
            <button type="button" className={`build-act${mode === 'clear' ? ' is-on' : ''}`} onClick={() => setTool(mode === 'clear' ? 'place' : 'clear')} aria-pressed={mode === 'clear'} data-testid="build-tool-clear">
              <Glyph d={LEAF_ICON} />
              <span className="build-act__label">{mode === 'clear' ? 'Build' : 'Clear'}</span>
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
              <button type="button" className="btn btn--primary build-place" onClick={() => placeGhost()} disabled={!ghostOk && !cornerPick} data-testid="build-place">
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

/**
 * Landscape phones: the slim build strip. One row of 44 px targets — chosen-piece chip (opens the palette
 * over the strip), Rotate, Undo, ···, Place, Done — plus the sign words row for pieces with text. The ···
 * menu holds the storey control, Next, the Remove / Clear tools and Unstuck. Every test id of the full
 * dock is kept (only one of the two is ever mounted).
 */
function StripDock({ touch, dockRef }: { touch: boolean; dockRef: React.RefObject<HTMLDivElement | null> }) {
  const mode = useBuildStore((s) => s.mode);
  const kind = useBuildStore((s) => s.kind);
  const thumb = useBuildStore((s) => s.thumbs[s.kind]);
  const palette = useBuildStore((s) => s.paletteOpen && s.mode === 'place');
  const ghostOk = useBuildStore((s) => !!s.ghost?.ok);
  const cornerPick = useBuildStore((s) => !!s.ghost && !s.ghost.ok && /corner/.test(s.ghost.message));
  const lock = useBuildStore((s) => s.lockLevel);
  const isRoof = PIECES[kind].param === 'roof';
  useBuildStore((s) => s.version);
  const repeat = canRepeat();
  const canUndo = useBuildStore((s) => s.undo.some((id) => pieces.index.get(id)));
  const [more, setMore] = useState(false);
  const place = mode === 'place';
  useEffect(() => {
    if (!place) setMore(false);
  }, [place]);
  const tool = (next: 'remove' | 'clear') => {
    setMore(false);
    setTool(next);
  };

  return (
    <div className="build-dock build-dock--strip is-touch" ref={dockRef} data-testid="build-dock" data-mode={mode} data-layout={palette ? 'strip-palette' : 'strip'} data-camera-cover="">
      <StatusLine touch={touch} />
      {mode === 'remove' ? <SelectionCard /> : null}
      {mode === 'remove' || mode === 'clear' ? <NatureCard /> : null}
      {palette ? (
        <div className="build-panel build-overlay" data-testid="build-palette-overlay">
          <Palette onPick={() => dockEvent({ type: 'pick', kind: useBuildStore.getState().kind })} />
          {isRoof ? <RoofOptions /> : null}
          <div className="build-bar">
            <Variants kind={kind} />
            <button type="button" className="btn btn--ghost btn--sm build-overlay__close" onClick={() => dockEvent({ type: 'collapse' })} data-testid="build-palette-close">
              Close
            </button>
          </div>
        </div>
      ) : null}
      <div className="build-panel build-strip" data-testid="build-strip">
        {place && PIECES[kind].text ? <SignInput /> : null}
        <div className="build-strip__row">
          {place ? (
            <button type="button" className={`build-chip${palette ? ' is-on' : ''}`} onClick={() => dockEvent({ type: 'chip' })} aria-expanded={palette} aria-label={`${PIECES[kind].name} — choose a piece`} data-testid="build-chip" data-kind={kind}>
              <span className="build-chip__img">{thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="build-tile__ph" />}</span>
              <span className="build-chip__name">{PIECES[kind].name}</span>
              {lock !== null ? <span className="build-chip__lvl">{lock === 0 ? 'G' : lock + 1}</span> : null}
            </button>
          ) : (
            <button type="button" className="build-act build-act--wide is-on" onClick={() => setTool('place')} aria-pressed="true" data-testid={mode === 'remove' ? 'build-tool-remove' : 'build-tool-clear'}>
              <Glyph d={mode === 'remove' ? ERASE : LEAF_ICON} />
              <span className="build-act__label">Back to building</span>
            </button>
          )}
          {place ? (
            <button type="button" className="build-act" onClick={() => rotate(1)} aria-label={isRoof ? 'Turn the ridge' : 'Rotate piece'} title="Rotate (R)" data-testid="build-rotate">
              <Glyph d={ROTATE} />
            </button>
          ) : null}
          <button type="button" className="build-act" onClick={() => undo()} disabled={!canUndo} aria-label="Undo last piece" data-testid="build-undo">
            <Glyph d={UNDO} />
          </button>
          <span className="build-more">
            <button type="button" className={`build-act${more ? ' is-open' : ''}`} onClick={() => setMore((v) => !v)} aria-expanded={more} aria-label="More" data-testid="build-more">
              <span className="build-act__dots" aria-hidden="true">···</span>
            </button>
            {more ? (
              <span className="build-menu build-menu--strip" role="menu" data-testid="build-menu">
                {place ? <StoreyControl /> : null}
                {place && repeat ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="build-menu__item"
                    onClick={() => {
                      setMore(false);
                      nextSegment();
                    }}
                    data-testid="build-next"
                  >
                    Next along the run
                  </button>
                ) : null}
                {place ? (
                  <>
                    <button type="button" role="menuitem" className="build-menu__item" onClick={() => tool('remove')} data-testid="build-tool-remove">
                      Remove or report a piece
                    </button>
                    <button type="button" role="menuitem" className="build-menu__item" onClick={() => tool('clear')} data-testid="build-tool-clear">
                      Clear a bush or rock
                    </button>
                  </>
                ) : null}
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
          {place ? (
            <button type="button" className="btn btn--primary build-place" onClick={() => placeGhost()} disabled={!ghostOk && !cornerPick} data-testid="build-place">
              <Glyph d={PLACE} size={18} /> Place
            </button>
          ) : null}
          <button type="button" className="btn btn--ghost build-done" onClick={() => exitBuild()} data-testid="build-done">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "<name> · built by <player>": a quiet label when you walk up to a building
 * with a name board (nearest within a few metres, outside build mode too).
 */
function NamePrompt() {
  const [label, setLabel] = useState<{ name: string; by: string } | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      const lp = runtime.localPlayer;
      if (!lp.ready) return setLabel(null);
      let best: { name: string; by: string } | null = null;
      let bd = 6;
      for (const p of pieces.index.query({ minX: lp.x - 7, maxX: lp.x + 7, minZ: lp.z - 7, maxZ: lp.z + 7 })) {
        if (!p.text || !PIECES[p.kind].mount) continue;
        const d = Math.hypot(p.x - lp.x, p.z - lp.z);
        if (d < bd) {
          bd = d;
          best = { name: p.text, by: p.ownerName || 'someone' };
        }
      }
      setLabel((cur) => (cur?.name === best?.name && cur?.by === best?.by ? cur : best));
    }, 400);
    return () => clearInterval(t);
  }, []);
  if (!label) return null;
  return (
    <div className="build-nameprompt" data-testid="build-name-prompt" role="status">
      <span className="build-nameprompt__name">{label.name}</span>
      <span className="build-nameprompt__by"> · built by {label.by}</span>
    </div>
  );
}

/** Mounted by the HUD: the building-name label, and the dock while building. */
export function BuildUi() {
  const mode = useBuildStore((s) => s.mode);
  const connected = useGameStore((s) => s.connection === 'connected');
  useEffect(() => {
    if (!connected && mode !== 'off') exitBuild();
  }, [connected, mode]);
  return (
    <>
      {mode === 'off' ? <NamePrompt /> : null}
      {mode === 'off' ? null : <Dock />}
    </>
  );
}

export { enterBuild };
