/**
 * The Elsewhere Gazette + World Memory (town history). Fed only by the
 * server's REST data (API.gazette / API.memory). Honest empty/unavailable states.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LOCATIONS, worldTimeAt, type GazetteArticle, type GazetteIssue, type GazetteSection, type WorldEvent } from '@elsewhere/shared';
import { rest, RestError } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { describeEvent, formatRelative, phaseLabel, worldDateAt, worldDayLabel } from '../lib/format.js';
import { Icon } from '../icons.js';
import { Empty, Segmented, Sheet, Spinner } from '../primitives.js';

const SECTION_LABEL: Record<GazetteSection, string> = {
  front_page: 'Front page',
  town_news: 'Town news',
  comings_and_goings: 'Comings & goings',
  mysteries: 'Mysteries',
  small_moments: 'Small moments',
  by_the_numbers: 'By the numbers',
};
const SECTION_ORDER: readonly GazetteSection[] = ['front_page', 'town_news', 'mysteries', 'comings_and_goings', 'small_moments', 'by_the_numbers'];

type LoadState<T> = { status: 'loading' } | { status: 'error'; unavailable: boolean } | { status: 'ok'; data: T; cursor: string | null; more: boolean };

function errState(err: unknown): { status: 'error'; unavailable: boolean } {
  return { status: 'error', unavailable: err instanceof RestError && (err.status === 501 || err.code === 'not_implemented' || err.status === 404) };
}

function useClock() {
  const clock = useGameStore((s) => s.clock);
  return useMemo(() => ({ epochMs: clock.epochMs, dayLengthMs: clock.dayLengthMs }), [clock.epochMs, clock.dayLengthMs]);
}

function Article({ a, lead, onHistory }: { a: GazetteArticle; lead?: boolean; onHistory(): void }) {
  const place = LOCATIONS.find((l) => l.id === a.locationId)?.name;
  return (
    <article className={`article${lead ? ' article--lead' : ''}${lead && a.body.length > 260 && !/^\S\s/.test(a.body) ? ' article--dropcap' : ''}`}>
      {place ? <p className="article__kicker">{place}</p> : null}
      <h3 className="article__headline">{a.headline}</h3>
      {a.body.split(/\n{2,}/).map((p, i) => (
        <p key={i} className={i === 0 ? 'article__body article__body--first' : 'article__body'}>
          {p}
        </p>
      ))}
      {a.eventIds.length ? (
        <button type="button" className="article__source" onClick={onHistory}>
          From {a.eventIds.length} recorded {a.eventIds.length === 1 ? 'event' : 'events'}
        </button>
      ) : null}
    </article>
  );
}

function Issue({ issue, onHistory }: { issue: GazetteIssue; onHistory(): void }) {
  const clock = useClock();
  const bySection = new Map<GazetteSection, GazetteArticle[]>();
  for (const a of issue.articles) bySection.set(a.section, [...(bySection.get(a.section) ?? []), a]);
  const lead = bySection.get('front_page')?.[0] ?? issue.articles[0];
  const rest_ = issue.articles.filter((a) => a !== lead);
  const sections = SECTION_ORDER.map((s) => ({ s, list: rest_.filter((a) => a.section === s) })).filter((x) => x.list.length);
  const st = issue.stats;
  return (
    <div className="paper" data-testid="gazette-issue">
      <header className="masthead">
        <p className="masthead__top">
          <span>No. {issue.issueNumber}</span>
          <span>{worldDateAt(issue.publishedAt, clock)}</span>
        </p>
        <h2 className="masthead__name">The Elsewhere Gazette</h2>
        <p className="masthead__line">{issue.title}</p>
      </header>
      {lead ? <Article a={lead} lead onHistory={onHistory} /> : <p className="paper__empty">A quiet issue — nothing made the front page.</p>}
      {sections.length ? (
        <div className="paper__cols">
          {sections.map(({ s, list }) => (
            <section key={s} className="paper__section">
              <h4 className="paper__section-title">{SECTION_LABEL[s]}</h4>
              {list.map((a) => (
                <Article key={a.id} a={a} onHistory={onHistory} />
              ))}
            </section>
          ))}
        </div>
      ) : null}
      {bySection.has('by_the_numbers') ? null : (
      <aside className="numbers" aria-label="By the numbers">
        <h4 className="paper__section-title">This issue, by the numbers</h4>
        <dl>
          <div>
            <dt>Visitors</dt>
            <dd>{st.uniqueVisitors}</dd>
          </div>
          <div>
            <dt>Events recorded</dt>
            <dd>{st.eventsRecorded}</dd>
          </div>
          <div>
            <dt>Bell rings</dt>
            <dd>{st.bellRings}</dd>
          </div>
          <div>
            <dt>Secrets found</dt>
            <dd>{st.secretsFound}</dd>
          </div>
        </dl>
      </aside>
      )}
      <p className="paper__colophon">Printed {new Date(issue.publishedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · compiled from the island’s own records</p>
    </div>
  );
}

function GazetteView({ onHistory }: { onHistory(): void }) {
  const [state, setState] = useState<LoadState<GazetteIssue[]>>({ status: 'loading' });
  const [index, setIndex] = useState(0);

  const load = useCallback(() => {
    setState({ status: 'loading' });
    rest
      .gazette({ limit: 10 })
      .then((r) => setState({ status: 'ok', data: r.issues, cursor: r.nextCursor, more: !!r.nextCursor }))
      .catch((err) => setState(errState(err)));
  }, []);
  useEffect(load, [load]);

  const older = async () => {
    if (state.status !== 'ok') return;
    if (index + 1 < state.data.length) return setIndex(index + 1);
    if (!state.cursor) return;
    try {
      const r = await rest.gazette({ limit: 10, before: state.cursor });
      setState({ status: 'ok', data: [...state.data, ...r.issues], cursor: r.nextCursor, more: !!r.nextCursor });
      if (r.issues.length) setIndex(index + 1);
    } catch {
      /* keep current */
    }
  };

  if (state.status === 'loading')
    return (
      <div className="paper paper--state">
        <Spinner label="Fetching the Gazette" />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="paper paper--state">
        <h2 className="masthead__name masthead__name--sm">The Elsewhere Gazette</h2>
        <p>{state.unavailable ? 'The presses aren’t running on this server yet.' : 'Couldn’t fetch the Gazette just now.'}</p>
        {!state.unavailable ? (
          <button type="button" className="btn btn--ink btn--sm" onClick={load}>
            Try again
          </button>
        ) : null}
      </div>
    );
  const issue = state.data[index];
  if (!issue)
    return (
      <div className="paper paper--state" data-testid="gazette-empty">
        <h2 className="masthead__name masthead__name--sm">The Elsewhere Gazette</h2>
        <p className="paper__empty-title">No news yet.</p>
        <p>The Gazette is written only from what really happens on the island. Once there’s something to tell, the first issue will appear here.</p>
        <button type="button" className="btn btn--ink btn--sm" onClick={onHistory}>
          Read the town history
        </button>
      </div>
    );
  const hasOlder = index + 1 < state.data.length || state.more;
  return (
    <>
      <Issue issue={issue} onHistory={onHistory} />
      {state.data.length > 1 || state.more ? (
        <nav className="issue-nav" aria-label="Issues">
          <button type="button" className="btn btn--quiet btn--sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            <Icon name="back" size={16} /> Newer
          </button>
          <span className="muted small">Issue {issue.issueNumber}</span>
          <button type="button" className="btn btn--quiet btn--sm" disabled={!hasOlder} onClick={() => void older()}>
            Older <Icon name="chevron" size={16} />
          </button>
        </nav>
      ) : null}
    </>
  );
}

function HistoryView() {
  const [state, setState] = useState<LoadState<WorldEvent[]>>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const clock = useClock();
  const load = useCallback(() => {
    setState({ status: 'loading' });
    rest
      .memory({ limit: 60 })
      .then((r) => setState({ status: 'ok', data: r.events, cursor: r.nextCursor, more: !!r.nextCursor }))
      .catch((err) => setState(errState(err)));
  }, []);
  useEffect(load, [load]);

  const more = async () => {
    if (state.status !== 'ok' || !state.cursor) return;
    setLoadingMore(true);
    try {
      const r = await rest.memory({ limit: 60, before: state.cursor });
      setState({ status: 'ok', data: [...state.data, ...r.events], cursor: r.nextCursor, more: !!r.nextCursor });
    } catch {
      /* ignore */
    } finally {
      setLoadingMore(false);
    }
  };

  if (state.status === 'loading')
    return (
      <div className="center-pad">
        <Spinner label="Opening the archive" />
      </div>
    );
  if (state.status === 'error')
    return (
      <Empty icon="history" title={state.unavailable ? 'The archive isn’t open on this server yet' : 'Couldn’t open the archive'}>
        {!state.unavailable ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={load}>
            Try again
          </button>
        ) : null}
      </Empty>
    );
  if (!state.data.length)
    return (
      <Empty icon="history" title="Nothing recorded yet" >
        The town remembers what people do here — bells rung, secrets found, gatherings. Its history starts with you.
      </Empty>
    );

  // Group by world day.
  const groups: { day: number; events: WorldEvent[] }[] = [];
  for (const e of state.data) {
    const day = worldTimeAt(e.ts, clock).day;
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.events.push(e);
    else groups.push({ day, events: [e] });
  }
  const now = Date.now();
  return (
    <div className="timeline" data-testid="memory-timeline">
      {groups.map((g) => (
        <section key={g.day} className="timeline__day">
          <h3 className="timeline__date">{worldDayLabel(g.day)}</h3>
          <ol className="timeline__list">
            {g.events.map((e) => {
              const wt = worldTimeAt(e.ts, clock);
              const place = LOCATIONS.find((l) => l.id === e.locationId)?.name;
              return (
                <li key={e.id} className={`event event--s${e.significance}`}>
                  <span className="event__dot" aria-hidden="true" />
                  <p className="event__text">{describeEvent(e)}</p>
                  <p className="event__meta">
                    {[place, phaseLabel(wt.phase), formatRelative(e.ts, now)].filter(Boolean).join(' · ')}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {state.more ? (
        <button type="button" className="btn btn--ghost btn--block" onClick={() => void more()} disabled={loadingMore}>
          {loadingMore ? 'Reading…' : 'Earlier'}
        </button>
      ) : (
        <p className="timeline__end">The beginning of the record.</p>
      )}
    </div>
  );
}

export function GazettePanel({ initialTab = 'news', onClose }: { initialTab?: 'news' | 'history'; onClose(): void }) {
  const [tab, setTab] = useState<'news' | 'history'>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  return (
    <Sheet
      title={tab === 'news' ? 'The Elsewhere Gazette' : 'Town history'}
      eyebrow={tab === 'news' ? 'Newspaper' : 'World Memory'}
      icon={tab === 'news' ? 'paper' : 'history'}
      size="wide"
      onClose={onClose}
      testId="panel-gazette"
      className="sheet--gazette"
      headerInline={
        <Segmented<'news' | 'history'>
          label="Gazette sections"
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'news', label: 'Latest issue' },
            { id: 'history', label: 'Town history' },
          ]}
        />
      }
    >
      {tab === 'news' ? <GazetteView onHistory={() => setTab('history')} /> : <HistoryView />}
    </Sheet>
  );
}
