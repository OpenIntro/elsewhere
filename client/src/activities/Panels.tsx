/**
 * Activity panels (opened from a station or keeper interactable): keeper
 * dialog + the building's menu, piano keyboard, curiosity table, notice
 * board, town poll, town project, guest books / tide log.
 *
 * Everything shown is synced state (real players' actions, real counts —
 * "no votes yet" when there are none) or the keepers' world behaviour. All
 * actions go to the server (net actions.activity / pianoNote), which
 * validates range, limits and moderation and answers with S2C.activityResult.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_KEYS,
  CONFIG,
  DRINKS,
  ITEMS,
  OPENING_HOURS,
  PIANO_NOTES,
  PROJECTS,
  S2C,
  curiositiesForDay,
  formatHour,
  getInteractable,
  getKeeper,
  getStation,
  isDrinkItem,
  keeperLine,
  parseActivityData,
  specialForDay,
  type ActivityResultPayload,
  type BoardEntry,
  type ItemId,
  type KeeperDef,
  type StationDef,
} from '@elsewhere/shared';
import { actions, net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { useUiStore } from '../state/uiStore.js';
import { Icon, ItemGlyph } from '../ui/icons.js';
import { Empty, Sheet } from '../ui/primitives.js';
import { boardEntries, insideCount, leftTime, pollData, projectData, relTime, useActivity, visibleEntries, worldNow } from './model.js';
import './activities.css';

/** Where a station / keeper stands (the camera keeps it on screen while its sheet peeks on a phone). */
function subjectOf(id: string): { x: number; z: number } | null {
  const p = getInteractable(id)?.position;
  return p ? { x: p.x, z: p.z } : null;
}

// ---------------------------------------------------------------------------
// Results from the server for this panel
// ---------------------------------------------------------------------------

function useResults(stations: string[]): { last: ActivityResultPayload | null; data: Record<string, string | number | boolean> } {
  const [last, setLast] = useState<ActivityResultPayload | null>(null);
  const [data, setData] = useState<Record<string, string | number | boolean>>({});
  const key = stations.join('|');
  useEffect(() => {
    const ids = new Set(key.split('|'));
    return net.on(S2C.activityResult, (r) => {
      if (!ids.has(r.station)) return;
      if (r.data) setData((d) => ({ ...d, ...r.data }));
      if (r.action !== 'status') setLast(r);
    });
  }, [key]);
  useEffect(() => {
    for (const s of key.split('|')) if (getStation(s)) actions.activity({ station: s, action: 'status' });
  }, [key]);
  return { last, data };
}

function ResultLine({ r }: { r: ActivityResultPayload | null }) {
  if (!r?.message) return null;
  return (
    <p className={`act-result${r.ok ? '' : ' is-no'}`} role="status" data-testid="activity-result" key={`${r.action}-${r.message}`}>
      {r.ok ? <Icon name="check" size={15} /> : null}
      {r.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Keeper dialog
// ---------------------------------------------------------------------------

function useKeeperContext(def: KeeperDef) {
  const keeper = useGameStore((s) => s.keepers[def.id]);
  const poll = pollData(useActivity(ACTIVITY_KEYS.poll));
  const project = projectData(useActivity(ACTIVITY_KEYS.project));
  const special = useActivity(ACTIVITY_KEYS.special);
  const fountainStage = useGameStore((s) => s.world.fountainStage);
  const inside = useGameStore((s) => insideCount(s, def.interiorId)) ?? 0;
  const { day, hours } = worldNow();
  const def2 = PROJECTS.find((p) => p.id === project.projectId);
  const sp = parseActivityData<{ name: string }>(special?.data, specialForDay(day));
  const line = keeperLine(def, {
    open: !!keeper?.present,
    hours,
    day,
    fountainStage,
    pollVotes: poll.tallies.reduce((a, b) => a + b, 0),
    pollQuestion: poll.question,
    project: def2 ? { name: def2.name, stage: project.stage + 1, stages: project.stages } : null,
    projectsDone: project.completed.length,
    special: sp.name,
    inside,
  });
  return { keeper, line };
}

function KeeperPanel({ def, message, onClose }: { def: KeeperDef; message?: string; onClose(): void }) {
  const { keeper, line } = useKeeperContext(def);
  const hours = OPENING_HOURS[def.interiorId];
  const present = !!keeper?.present;
  const stations = useMemo(() => [def.interactableId, ...(def.id === 'keeper_shopkeeper' ? ['station_store_shelf'] : def.id === 'keeper_tinkerer' ? ['station_workshop_project'] : [])], [def]);
  const { last, data } = useResults(stations);
  return (
    <Sheet title={def.name} eyebrow={`${def.role} · keeper`} icon="smile" onClose={onClose} testId="panel-keeper" className="sheet--keeper" peek subject={subjectOf(def.interactableId)}>
      <div className="keeper">
        <div className="keeper__badge" title="Keepers are characters of the island, not players.">
          <span aria-hidden="true">❦</span> Keeper — a character of the island, not a player
        </div>
        <blockquote className="keeper__line" data-testid="keeper-line">
          “{line}”
        </blockquote>
        <p className="keeper__task muted small" data-testid="keeper-task">
          {present ? `${def.name} is ${keeper?.task || 'here'}.` : `${def.name} is off duty.`} {hours ? `Open ${formatHour(hours[0])}–${formatHour(hours[1])} (island time).` : ''}
        </p>
      </div>
      {message ? <p className="act-result">{message}</p> : null}
      <ResultLine r={last} />
      {def.id === 'keeper_barista' ? <CafeMenu open={present} /> : null}
      {def.id === 'keeper_shopkeeper' ? <ShelfContent open={present} data={data} /> : null}
      {def.id === 'keeper_clerk' ? <HallSummary /> : null}
      {def.id === 'keeper_tinkerer' ? <ProjectContent data={data} /> : null}
    </Sheet>
  );
}

function CafeMenu({ open }: { open: boolean }) {
  const special = useActivity(ACTIVITY_KEYS.special);
  const held = useGameStore((s) => (s.sessionId ? (s.players[s.sessionId]?.held ?? '') : ''));
  const sp = parseActivityData<{ name: string; text: string }>(special?.data, specialForDay(Math.round(special?.value ?? 0)));
  const busyHands = !!held && !isDrinkItem(held);
  return (
    <section className="section" aria-label="Menu">
      <h3 className="section__title">Menu</h3>
      <ul className="act-menu">
        {DRINKS.map((d) => (
          <li key={d.id} className="act-menu__row">
            <span className="act-menu__text">
              <strong>{d.id === 'special' ? sp.name : d.name}</strong>
              <span>{d.id === 'special' ? `Today’s special — ${sp.text}` : d.blurb}</span>
            </span>
            <button type="button" className="btn btn--primary btn--sm" disabled={!open || busyHands} onClick={() => actions.activity({ station: 'keeper_barista', action: 'order', item: d.id })} data-testid={`order-${d.id}`}>
              Order
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">{!open ? 'The café is closed — the counter is quiet until morning.' : busyHands ? 'Your hands are full. Set something down to take a cup.' : 'On the house, like everything here for now. Sip it while it lasts.'}</p>
    </section>
  );
}

function HallSummary() {
  const poll = pollData(useActivity(ACTIVITY_KEYS.poll));
  const notices = useActivity(ACTIVITY_KEYS.board('hall_notices'));
  const total = poll.tallies.reduce((a, b) => a + b, 0);
  return (
    <section className="section">
      <h3 className="section__title">In the hall today</h3>
      <ul className="act-facts">
        <li>
          <Icon name="flag" size={16} /> Town poll: “{poll.question}” — {total ? `${total} vote${total === 1 ? '' : 's'} so far` : 'no votes yet'}. The ballot box is on the meeting table.
        </li>
        <li>
          <Icon name="pin" size={16} /> {Math.round(notices?.value ?? 0) || 'No'} notice{Math.round(notices?.value ?? 0) === 1 ? '' : 's'} on the board.
        </li>
        <li>
          <Icon name="history" size={16} /> The archive holds everything the island remembers.
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Piano
// ---------------------------------------------------------------------------

const WHITE = [0, 2, 4, 5, 7, 9, 11];
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** Desktop keys: lower row (Z…/) = first octave, upper row (Q…]) = second. */
const KEYMAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24,
};
const KEY_LABEL: Record<number, string> = Object.fromEntries(Object.entries(KEYMAP).filter(([k]) => k !== 'Comma').map(([k, n]) => [n, k.replace('Key', '').replace('Digit', '')]));

function PianoPanel({ onClose }: { onClose(): void }) {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 760px)').matches);
  const [octave, setOctave] = useState(0);
  const [pressed, setPressed] = useState<Record<number, number>>({});
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const trap = useRef<HTMLInputElement>(null);
  const { last } = useResults(['station_cafe_piano']);
  const seated = useGameStore((s) => (s.sessionId ? (s.players[s.sessionId]?.seat ?? '').startsWith('stool_cafe_piano') : false));
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 760px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // Desktop: a focused (invisible) input takes the keys, so walking / E / Enter don't fire while you play.
  useEffect(() => {
    if (!touch) trap.current?.focus({ preventScroll: true });
  }, [touch]);
  const play = (n: number) => {
    if (!actions.pianoNote(n)) return;
    setPressed((p) => ({ ...p, [n]: performance.now() }));
    setTimeout(() => setPressed((p) => (p[n] && performance.now() - p[n]! > 150 ? { ...p, [n]: 0 } : p)), 180);
  };
  const first = wide ? 0 : octave * 12;
  const count = wide ? PIANO_NOTES : 13;
  const notes = Array.from({ length: count }, (_, i) => first + i).filter((n) => n < PIANO_NOTES);
  const whites = notes.filter((n) => WHITE.includes(n % 12));
  return (
    <Sheet title="Upright piano" eyebrow="Café · everyone in the café hears you" icon="volume" size="wide" onClose={onClose} testId="panel-piano" className="sheet--piano" peek subject={subjectOf('station_cafe_piano')}>
      <input
        ref={trap}
        className="piano__trap"
        aria-label="Piano keys (use your keyboard)"
        readOnly
        value=""
        onKeyDown={(e) => {
          if (e.key === 'Escape') return onClose();
          const n = KEYMAP[e.code];
          if (n === undefined || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          play(n);
        }}
        onBlur={() => !touch && setTimeout(() => trap.current?.isConnected && document.activeElement === document.body && trap.current?.focus({ preventScroll: true }), 0)}
      />
      <div className="piano" role="group" aria-label="Piano keyboard" data-testid="piano-keys" onPointerDown={() => !touch && trap.current?.focus({ preventScroll: true })}>
        <div className="piano__whites" style={{ gridTemplateColumns: `repeat(${whites.length}, 1fr)` }}>
          {whites.map((n) => (
            <button
              key={n}
              type="button"
              className={`piano__key piano__key--white${pressed[n] ? ' is-down' : ''}`}
              onPointerDown={(e) => {
                e.preventDefault();
                play(n);
              }}
              aria-label={`${NAMES[n % 12]}${4 + Math.floor(n / 12)}`}
              data-note={n}
            >
              {!touch && wide ? <kbd>{KEY_LABEL[n] ?? ''}</kbd> : <span>{n % 12 === 0 ? `C${4 + Math.floor(n / 12)}` : ''}</span>}
            </button>
          ))}
        </div>
        <div className="piano__blacks" aria-hidden="false">
          {notes
            .filter((n) => !WHITE.includes(n % 12))
            .map((n) => {
              const left = whites.indexOf(n - 1) + 1;
              return (
                <button
                  key={n}
                  type="button"
                  className={`piano__key piano__key--black${pressed[n] ? ' is-down' : ''}`}
                  style={{ left: `calc(${(left / whites.length) * 100}% - ${50 / whites.length}% * 0.62)`, width: `${(100 / whites.length) * 0.62}%` }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    play(n);
                  }}
                  aria-label={`${NAMES[n % 12]}${4 + Math.floor(n / 12)}`}
                  data-note={n}
                >
                  {!touch && wide ? <kbd>{KEY_LABEL[n] ?? ''}</kbd> : null}
                </button>
              );
            })}
        </div>
      </div>
      <div className="piano__foot">
        {!wide ? (
          <div className="segmented segmented--sm" role="radiogroup" aria-label="Octave">
            {[0, 1].map((o) => (
              <button key={o} type="button" role="radio" aria-checked={octave === o} className={octave === o ? 'is-on' : ''} onClick={() => setOctave(o)}>
                {o === 0 ? 'Low' : 'High'}
              </button>
            ))}
          </div>
        ) : null}
        <p className="muted small">{touch ? 'Tap the keys.' : 'Play with your keyboard (Z–M and Q–I rows) or click the keys.'} {seated ? 'You’re on the piano stool.' : 'Sit on the stool for the full effect.'}</p>
      </div>
      <ResultLine r={last && !last.ok ? last : null} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// General Store
// ---------------------------------------------------------------------------

function ShelfContent({ open, data }: { open: boolean; data: Record<string, string | number | boolean> }) {
  const shelf = useActivity(ACTIVITY_KEYS.shelf);
  const inventory = useGameStore((s) => s.profile?.inventory ?? []);
  const items = parseActivityData<{ items: ItemId[] }>(shelf?.data, { items: curiositiesForDay(Math.round(shelf?.value ?? 0)) }).items.filter((id) => id in ITEMS);
  const taken = Number(data.taken ?? 0);
  const limit = Number(data.limit ?? CONFIG.activities.storeTakesPerDay);
  const done = taken >= limit;
  return (
    <section className="section" aria-label="Today’s curiosities">
      <h3 className="section__title">On the table today</h3>
      <ul className="act-shelf">
        {items.map((id) => (
          <li key={id} className="item">
            <span className="item__glyph">
              <ItemGlyph item={ITEMS[id]} size={40} />
            </span>
            <span className="item__text">
              <strong>{ITEMS[id].name}</strong>
              <span>{ITEMS[id].description}</span>
            </span>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!open || done} onClick={() => actions.activity({ station: 'station_store_shelf', action: 'take', item: id })} data-testid={`take-${id}`}>
              {inventory.includes(id) ? 'Another' : 'Take'}
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small">
        <span className="tag tag--inline">On the house, for now</span> {open ? (done ? 'You’ve had today’s. New things arrive tomorrow.' : `Take ${limit === 1 ? 'one' : limit} a day into your things.`) : 'The store is closed; the table is covered for the night.'} Prices and trading come later.
      </p>
    </section>
  );
}

function ShelfPanel({ onClose }: { onClose(): void }) {
  const open = useGameStore((s) => !!s.keepers.keeper_shopkeeper?.present);
  const { last, data } = useResults(['station_store_shelf']);
  return (
    <Sheet title="Curiosity table" eyebrow="General Store" icon="bag" onClose={onClose} testId="panel-shelf" peek subject={subjectOf('station_store_shelf')}>
      <ResultLine r={last} />
      <ShelfContent open={open} data={data} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Boards: notices, guest books, tide log
// ---------------------------------------------------------------------------

function BoardPanel({ station, onClose }: { station: StationDef; onClose(): void }) {
  const boardId = station.board!;
  const notices = boardId === 'hall_notices';
  const a = useActivity(ACTIVITY_KEYS.board(boardId));
  const blocked = useGameStore((s) => s.blocked);
  const muted = useGameStore((s) => s.muted);
  const me = useGameStore((s) => s.profile?.profileId ?? '');
  const entries = useMemo(() => visibleEntries(boardEntries(a), blocked, muted).slice().reverse(), [a, blocked, muted]);
  const { last, data } = useResults([station.id]);
  const [text, setText] = useState('');
  const [reported, setReported] = useState<Record<string, boolean>>({});
  const id = useId();
  const max = notices ? CONFIG.activities.noticeMaxLength : CONFIG.activities.guestbookMaxLength;
  const mine = entries.filter((e) => e.p === me).length;
  const signedToday = data.signedToday === true;
  useEffect(() => {
    if (last?.ok && (last.action === 'pin' || last.action === 'sign')) {
      setText('');
      actions.activity({ station: station.id, action: 'status' });
    }
    if (last?.ok && last.action === 'remove') actions.activity({ station: station.id, action: 'status' });
  }, [last, station.id]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t) actions.activity({ station: station.id, action: notices ? 'pin' : 'sign', text: t });
  };
  const title = notices ? 'Notice board' : boardId === 'book_boathouse' ? 'Tide log' : 'Guest book';
  const eyebrow = notices ? 'Town Hall · written by residents' : boardId === 'book_boathouse' ? 'Boathouse · notes from the water' : 'Visitors to this home';
  return (
    <Sheet title={title} eyebrow={eyebrow} icon={notices ? 'pin' : 'scroll'} size="reading" tone="paper" onClose={onClose} testId={notices ? 'panel-notices' : 'panel-guestbook'} peek subject={subjectOf(station.id)}>
      <div className="notes">
        <ResultLine r={last} />
        {entries.length ? (
          <ul className="notes__list" data-testid="board-entries">
            {entries.map((e: BoardEntry) => (
              <li key={e.id} className="note" data-entry={e.id}>
                <p className="note__text">{e.t}</p>
                <p className="note__meta">
                  — {e.p === me ? 'you' : e.a}, {relTime(e.ts)}
                  {e.x ? ` · ${leftTime(e.x)}` : ''}
                </p>
                <div className="note__actions">
                  {e.p === me ? (
                    <button type="button" className="btn btn--quiet btn--xs" onClick={() => actions.activity({ station: station.id, action: 'remove', entryId: e.id })}>
                      Take down
                    </button>
                  ) : reported[e.id] ? (
                    <span className="small muted">Reported</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--quiet btn--xs"
                      onClick={() => {
                        actions.activity({ station: station.id, action: 'report', entryId: e.id });
                        setReported((r) => ({ ...r, [e.id]: true }));
                      }}
                    >
                      Report
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={notices ? 'pin' : 'scroll'} title={notices ? 'Nothing pinned yet' : 'No signatures yet'}>
            {notices ? 'Be the first to put something up.' : 'Be the first to sign.'}
          </Empty>
        )}
        {notices && mine >= Number(data.limit ?? 2) ? (
          <p className="field__hint">You have {mine} notices up (the limit). Take one down to pin another.</p>
        ) : !notices && signedToday ? (
          <p className="field__hint">You signed today. Come back tomorrow to sign again.</p>
        ) : (
          <form className="notes__form" onSubmit={submit}>
            <label htmlFor={id} className="field__label">
              {notices ? 'Pin a notice' : 'Sign'}
            </label>
            <textarea id={id} className="input input--area" rows={2} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} placeholder={notices ? 'Lost, found, wanted, welcome…' : 'A line for whoever lives here…'} data-testid="board-input" />
            <div className="notes__row">
              <small className="field__hint">
                {notices ? `Public, kept for a few days. ${Number(data.limit ?? 2)} per person. ` : 'Public to visitors. '}
                {text.length}/{max}
              </small>
              <button type="submit" className="btn btn--primary btn--sm" disabled={!text.trim()} data-testid="board-submit">
                {notices ? 'Pin it' : 'Sign'}
              </button>
            </div>
          </form>
        )}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Town poll
// ---------------------------------------------------------------------------

function PollPanel({ onClose }: { onClose(): void }) {
  const p = pollData(useActivity(ACTIVITY_KEYS.poll));
  const { last, data } = useResults(['station_hall_poll']);
  const total = p.tallies.reduce((a, b) => a + b, 0);
  const voted = typeof data.voted === 'number' && data.voted >= 0 ? data.voted : null;
  const lastTotal = p.last ? p.last.tallies.reduce((a, b) => a + b, 0) : 0;
  return (
    <Sheet title="Town poll" eyebrow="Town Hall · one vote each" icon="flag" onClose={onClose} testId="panel-poll" peek subject={subjectOf('station_hall_poll')}>
      <ResultLine r={last} />
      <section className="section">
        <p className="poll__q">{p.question}</p>
        <ul className="poll" data-testid="poll-options">
          {p.options.map((o, i) => {
            const n = p.tallies[i] ?? 0;
            const pct = total ? Math.round((n / total) * 100) : 0;
            return (
              <li key={o}>
                <button type="button" className={`poll__opt${voted === i ? ' is-mine' : ''}`} disabled={voted !== null} onClick={() => actions.activity({ station: 'station_hall_poll', action: 'vote', option: i })} data-testid={`vote-${i}`}>
                  <span className="poll__bar" style={{ width: `${pct}%` }} />
                  <span className="poll__label">
                    {o}
                    {voted === i ? <Icon name="check" size={14} /> : null}
                  </span>
                  <span className="poll__n" data-testid={`tally-${i}`}>
                    {n}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted small" data-testid="poll-total">
          {total ? `${total} vote${total === 1 ? '' : 's'} so far — real votes only.` : 'No votes yet.'} {voted !== null ? 'You have voted.' : 'Tap an option to vote.'} The result goes into the island’s record when the day ends.
        </p>
      </section>
      {p.last && lastTotal ? (
        <section className="section">
          <h3 className="section__title">Last time</h3>
          <p className="small">
            “{p.last.question}” — {p.last.options.map((o, i) => `${o} ${p.last!.tallies[i] ?? 0}`).join(' · ')}
          </p>
        </section>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Workshop project
// ---------------------------------------------------------------------------

function ProjectContent({ data, message }: { data: Record<string, string | number | boolean>; message?: string }) {
  const p = projectData(useActivity(ACTIVITY_KEYS.project));
  const def = PROJECTS.find((x) => x.id === p.projectId);
  const today = Number(data.today ?? 0);
  const limit = Number(data.limit ?? CONFIG.activities.projectDailyPerProfile);
  return (
    <>
      {message ? <p className="act-result" data-testid="project-message">{message}</p> : null}
      {def ? (
        <section className="section" data-testid="project-status">
          <h3 className="section__title">Now making</h3>
          <p className="proj__name">{def.name}</p>
          <ol className="proj__stages">
            {Array.from({ length: p.stages }, (_, i) => (
              <li key={i} className={i < p.stage ? 'is-done' : i === p.stage ? 'is-now' : ''}>
                <span className="proj__dot" aria-hidden="true">
                  {i < p.stage ? <Icon name="check" size={12} /> : i + 1}
                </span>
                {def.stageNames[i] ?? `Stage ${i + 1}`}
              </li>
            ))}
          </ol>
          <div className="proj__meter" aria-label="Progress towards the next stage">
            <span style={{ width: `${Math.min(100, (p.contributions / Math.max(1, p.need.contributions)) * 100)}%` }} />
          </div>
          <p className="small" data-testid="project-progress">
            Stage {Math.min(p.stage + 1, p.stages)} of {p.stages}: {p.contributions} of {p.need.contributions} pieces of work, by {p.distinct} of {p.need.distinct} different people needed.
          </p>
          <p className="muted small">When it’s finished: {def.outcome.charAt(0).toLowerCase() + def.outcome.slice(1)}. Use the lumber rack, the anvil or the kiln to help — you can do {limit} a day ({today} done today).</p>
        </section>
      ) : (
        <Empty icon="check" title="Every project is finished">
          More are planned. Thank you to everyone who lent a hand.
        </Empty>
      )}
      {p.completed.length ? (
        <section className="section">
          <h3 className="section__title">Finished by the town</h3>
          <ul className="act-facts">
            {p.completed.map((id) => {
              const d = PROJECTS.find((x) => x.id === id);
              return d ? (
                <li key={id} data-testid={`project-done-${id}`}>
                  <Icon name="sparkle" size={16} /> <strong>{d.name}</strong> — {d.outcome}.
                </li>
              ) : null;
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function ProjectPanel({ message, onClose }: { message?: string; onClose(): void }) {
  const { data } = useResults(['station_workshop_project']);
  return (
    <Sheet title="The town project" eyebrow="Workshop · many hands" icon="gear" onClose={onClose} testId="panel-project">
      <ProjectContent data={data} {...(message ? { message } : {})} />
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export function ActivityPanel({ station, message, onClose }: { station: string; message?: string; onClose(): void }) {
  const it = getInteractable(station);
  if (it?.kind === 'keeper') {
    const def = getKeeper(it.keeperId);
    return def ? <KeeperPanel def={def} {...(message ? { message } : {})} onClose={onClose} /> : null;
  }
  const st = getStation(station);
  if (!st) return null;
  switch (st.kind) {
    case 'piano':
      return <PianoPanel onClose={onClose} />;
    case 'shelf':
      return <ShelfPanel onClose={onClose} />;
    case 'notices':
    case 'guestbook':
      return <BoardPanel station={st} onClose={onClose} />;
    case 'poll':
      return <PollPanel onClose={onClose} />;
    case 'project':
    case 'work':
      return <ProjectPanel {...(message ? { message } : {})} onClose={onClose} />;
    default:
      return null;
  }
}

/** A small HUD chip while you hold a café drink: sip it (also touch-friendly). */
export function DrinkChip() {
  const held = useGameStore((s) => (s.sessionId ? (s.players[s.sessionId]?.held ?? '') : ''));
  const panel = useUiStore((s) => s.panel);
  if (!held || !isDrinkItem(held) || panel?.kind === 'activity') return null;
  return (
    <button type="button" className="pill pill--action drink-chip" onClick={() => actions.activity({ station: 'drink', action: 'sip' })} aria-label={`Sip your ${ITEMS[held].name.toLowerCase()}`} data-testid="drink-sip">
      <ItemGlyph item={ITEMS[held]} size={20} />{' '}
      <span className="pill__label">
        Sip<span className="drink-chip__item"> your {ITEMS[held].name.toLowerCase()}</span>
      </span>
    </button>
  );
}
