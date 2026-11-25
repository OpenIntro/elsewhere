/**
 * The Elsewhere Gazette: every gazette interval (CONFIG.gazette.issueIntervalMs,
 * env GAZETTE_INTERVAL_MINUTES) an issue is compiled from the REAL World
 * Memory events of the period via templates.ts. Every article lists the
 * eventIds it was generated from. Nothing is invented: no events → no issue;
 * only trivia → a short "quiet stretch" issue.
 *
 * The compile cursor (end of the last compiled period) is persisted, so after
 * a restart the next issue picks up exactly where the last one ended.
 */
import { randomBytes } from 'node:crypto';
import {
  CONFIG,
  DISCOVERIES,
  ITEMS,
  LOCATIONS,
  worldTimeAt,
  type ClockParams,
  type DiscoveryId,
  type GazetteArticle,
  type GazetteIssue,
  type ItemId,
  type WorldEvent,
} from '@elsewhere/shared';
import type { MemoryService } from '../memory/index.js';
import type { PersistenceService } from '../persistence/index.js';
import { TEMPLATES, joinNames, pick, render, type TemplateId } from './templates.js';

export interface GazetteService {
  list(limit: number, before?: string): Promise<GazetteIssue[]>;
  get(id: string): Promise<GazetteIssue | null>;
  /** Compile (and persist) an issue covering [periodStart, periodEnd). Returns null if nothing happened. */
  compileIssue(periodStart: number, periodEnd: number): Promise<GazetteIssue | null>;
  /** Compile from the persisted cursor up to now (what the schedule does). */
  compileDue(): Promise<GazetteIssue | null>;
  /** Begin the periodic compile schedule. */
  start(): void;
  stop(): void;
}

export interface GazetteOptions {
  intervalMs: number;
  clock: () => ClockParams;
  now?: () => number;
  /** Young-world first issue: compile `earlyDelayMs` after `earlyEvents` significant events (needs `memory`). */
  memory?: MemoryService;
  earlyEvents?: number;
  earlyDelayMs?: number;
}

const CURSOR_KEY = 'gazette:cursor';
const BELL_SNAPSHOT_KEY = 'gazette:bellRings';
const placeName = (id?: string) => (id ? (LOCATIONS.find((l) => l.id === id)?.name ?? id) : 'the island');

const SECTION_ORDER: Record<GazetteArticle['section'], number> = { front_page: 0, mysteries: 1, town_news: 2, comings_and_goings: 3, small_moments: 4, by_the_numbers: 5 };

interface Draft {
  template: TemplateId;
  events: WorldEvent[];
  vars: Record<string, string | number>;
  weight: number;
  locationId?: WorldEvent['locationId'];
}

/** Pure: build articles from events (exported for tests). */
export function buildArticles(events: readonly WorldEvent[], clock: ClockParams, extras: { bellRings?: number } = {}): GazetteArticle[] {
  const when = (ts: number) => {
    const t = worldTimeAt(ts, clock);
    const phase = { morning: 'one morning', midday: 'around midday', golden_hour: 'in the golden hour', dusk: 'at dusk', night: 'in the night' }[t.phase];
    return `${phase} of world-day ${t.day}`;
  };
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const namesOf = (evs: readonly WorldEvent[]) => joinNames(evs.flatMap((e) => e.actors.map((a) => a.name)));
  const drafts: Draft[] = [];
  const byKind = (k: WorldEvent['kind']) => events.filter((e) => e.kind === k);
  const one = (template: TemplateId, e: WorldEvent, vars: Record<string, string | number>, weight: number) =>
    drafts.push({ template, events: [e], vars: { time: when(e.ts), Time: cap(when(e.ts)), names: namesOf([e]), name: e.actors[0]?.name ?? 'someone', place: placeName(e.locationId), ...vars }, weight, ...(e.locationId ? { locationId: e.locationId } : {}) });
  const many = (template: TemplateId, evs: WorldEvent[], vars: Record<string, string | number>, weight: number) => {
    if (evs.length) drafts.push({ template, events: evs, vars: { names: namesOf(evs), count: evs.length, ...vars }, weight });
  };

  for (const e of byKind('portal_awakened')) {
    one(e.data?.first === true ? 'portal_awakened_first' : 'portal_awakened', e, { awakenings: Number(e.data?.awakenings ?? 1) }, 100);
  }
  for (const e of byKind('fountain_transformed')) {
    one('fountain_transformed', e, { stage: Number(e.data?.stage ?? 0), count: Number(e.data?.contributions ?? 0), n: Number(e.data?.distinct ?? e.actors.length) }, 90);
  }
  for (const e of byKind('bell_chorus')) one('bell_chorus', e, { voices: Number(e.data?.voices ?? e.actors.length) }, 60);
  const secrets = byKind('secret_found');
  for (const e of secrets.filter((s) => s.data?.firstOnIsland === true)) {
    one('secret_first', e, { discovery: DISCOVERIES[String(e.data?.discoveryId) as DiscoveryId]?.name ?? 'something' }, 55);
  }
  many('secrets_more', secrets.filter((s) => s.data?.firstOnIsland !== true), {}, 20);
  for (const e of byKind('milestone')) {
    const m = String(e.data?.milestone ?? '');
    if (m === 'midnight_bell') one('midnight_bell', e, { n: Number(e.data?.worldDay ?? 0) }, 50);
    else if (m === 'residents') one('residents', e, { count: Number(e.data?.contributions ?? 0) }, 45);
    else if (m === 'place_visits') one('place_visits', e, { count: Number(e.data?.contributions ?? 0) }, 30);
    else if (m === 'night_wanders') one('night_wanders', e, { count: Number(e.data?.contributions ?? 0) }, 30);
    else if (m === 'build_pieces') one('build_pieces', e, { count: Number(e.data?.contributions ?? 0) }, 32);
  }
  for (const e of byKind('structure_roofed')) one('structure_roofed', e, { count: Number(e.data?.walls ?? 0) }, 52);
  many('first_build', byKind('first_build'), {}, 22);
  // Building activities (all real players' actions; keepers never appear as actors).
  const lower = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
  for (const e of byKind('project_completed')) one('project_completed', e, { project: lower(String(e.data?.name ?? 'a town project')), outcome: String(e.data?.outcome ?? 'Something new stands outside'), n: e.actors.length }, 95);
  for (const e of byKind('project_stage')) one('project_stage', e, { project: lower(String(e.data?.name ?? 'the town project')), stage: Number(e.data?.stage ?? 0), stages: Number(e.data?.stages ?? 0), stageName: String(e.data?.stageName ?? 'Progress') }, 38);
  for (const e of byKind('poll_closed')) one('poll_closed', e, { question: String(e.data?.question ?? ''), result: String(e.data?.result ?? ''), tallies: String(e.data?.tallies ?? ''), count: Number(e.data?.votes ?? e.actors.length) }, 48);
  for (const e of byKind('nets_mended')) one('nets_mended', e, { count: Number(e.data?.nets ?? 1) }, 28);
  many('notices', byKind('notice_pinned'), {}, 11);
  many('guestbooks', byKind('guestbook_signed'), {}, 9);
  many('piano', byKind('piano_played'), {}, 8);
  many('hearths', byKind('hearth_lit'), {}, 5);
  for (const e of byKind('gathering')) one('gathering', e, { count: Number(e.data?.count ?? e.actors.length) }, 40);
  for (const e of byKind('dance_party')) one('dance_party', e, { count: Number(e.data?.count ?? e.actors.length) }, 35);
  many('newcomers', byKind('player_first_visit'), {}, 25);
  many('returning', byKind('player_returned'), {}, 8);
  many('fountain_touches', byKind('fountain_touched'), {}, 12);
  many('bell_rung', byKind('bell_rung'), {}, 10);
  const benches = byKind('sat_together');
  if (benches[0]) one('sat_together', benches[benches.length - 1]!, {}, 9);
  many('mail_sent', byKind('mail_sent'), {}, 7);
  const items = byKind('item_picked_up');
  many('items', items, { item: joinNames(items.map((e) => ITEMS[String(e.data?.itemId) as ItemId]?.name.toLowerCase() ?? 'a thing'), 4) }, 6);

  const max = CONFIG.gazette.maxArticlesPerIssue;
  const significant = events.some((e) => e.significance >= 1);
  let chosen = drafts.sort((a, b) => b.weight - a.weight).slice(0, Math.max(1, max - 1));
  if (!significant) {
    // Honest quiet issue: one line, no puffing up.
    chosen = [{ template: 'quiet', events: [...events], vars: { count: events.length }, weight: 0 }];
  }

  const uniqueVisitors = new Set(events.flatMap((e) => e.actors.map((a) => a.profileId))).size;
  const facts: string[] = [`${uniqueVisitors} resident(s) took part.`];
  if (extras.bellRings !== undefined && extras.bellRings > 0) facts.push(`The bell rang ${extras.bellRings} time(s).`);
  if (secrets.length) facts.push(`${secrets.length} secret(s) found.`);
  const places = new Map<string, number>();
  for (const e of events) if (e.locationId) places.set(e.locationId, (places.get(e.locationId) ?? 0) + 1);
  const busiest = [...places].sort((a, b) => b[1] - a[1])[0];
  if (busiest && places.size > 1) facts.push(`Busiest place: ${placeName(busiest[0])} (${busiest[1]} recorded moments).`);
  if (significant) chosen.push({ template: 'numbers', events: [], vars: { count: events.length, n: facts.join(' ') }, weight: -1 });

  return chosen
    .map((d): GazetteArticle => {
      const tpl = TEMPLATES[d.template];
      const ids = d.events.map((e) => e.id);
      const seed = ids.join('|') || d.template;
      const article: GazetteArticle = {
        id: `art_${d.template}_${(ids[0] ?? 'stats').slice(-8)}`,
        section: tpl.section,
        headline: render(pick(tpl.headlines, seed), d.vars),
        body: render(pick(tpl.bodies, seed + '#'), d.vars),
        eventIds: ids,
        templateId: tpl.id,
      };
      if (d.locationId) article.locationId = d.locationId;
      return article;
    })
    .sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);
}

export function createGazette(persistence: PersistenceService, options: GazetteOptions): GazetteService {
  const now = options.now ?? Date.now;
  let timer: NodeJS.Timeout | null = null;
  let compiling: Promise<GazetteIssue | null> | null = null;
  let earlyTimer: NodeJS.Timeout | null = null;
  let earlyDone = false;
  let unsubscribe: (() => void) | null = null;
  const earlyEvents = options.earlyEvents ?? CONFIG.gazette.earlyIssueSignificantEvents;
  const earlyDelayMs = options.earlyDelayMs ?? CONFIG.gazette.earlyIssueDelayMs;

  /** Until a first issue exists: once enough significant REAL events are on record, publish soon. */
  async function checkEarly(): Promise<void> {
    if (earlyDone || earlyTimer) return;
    if (await persistence.gazette.latest()) {
      earlyDone = true;
      return;
    }
    const from = (await persistence.worldState.getKv<number>(CURSOR_KEY)) ?? 0;
    const significant = (await persistence.events.range(from, now() + 1)).filter((e) => e.significance >= 1).length;
    if (significant < earlyEvents || earlyTimer) return;
    earlyTimer = setTimeout(() => {
      void compileDue()
        .then((issue) => {
          if (issue) earlyDone = true;
        })
        .catch((err) => console.error('[gazette] early compile failed', err))
        .finally(() => {
          earlyTimer = null;
        });
    }, earlyDelayMs);
    earlyTimer.unref();
  }

  async function compileIssue(periodStart: number, periodEnd: number): Promise<GazetteIssue | null> {
    const events = await persistence.events.range(periodStart, periodEnd);
    await persistence.worldState.setKv(CURSOR_KEY, periodEnd);
    if (events.length < CONFIG.gazette.minEventsForIssue) return null;
    const bell = (await persistence.worldState.loadObjects()).find((o) => o.id === 'bell_town_hall');
    const prevBell = (await persistence.worldState.getKv<number>(BELL_SNAPSHOT_KEY)) ?? 0;
    const bellRings = bell ? Math.max(0, bell.value - prevBell) : 0;
    if (bell) await persistence.worldState.setKv(BELL_SNAPSHOT_KEY, bell.value);
    const clock = options.clock();
    const articles = buildArticles(events, clock, { bellRings });
    const latest = await persistence.gazette.latest();
    const issueNumber = (latest?.issueNumber ?? 0) + 1;
    const t = worldTimeAt(periodEnd, clock);
    const mood = events.some((e) => e.significance >= 2) ? 'Big news' : events.some((e) => e.significance >= 1) ? 'Island notes' : 'A quiet stretch';
    const issue: GazetteIssue = {
      id: `gz_${String(issueNumber).padStart(5, '0')}_${randomBytes(3).toString('hex')}`,
      issueNumber,
      publishedAt: now(),
      periodStart,
      periodEnd,
      title: `Vol. ${1 + Math.floor((issueNumber - 1) / 100)}, No. ${issueNumber} — ${mood}, world-day ${t.day}`,
      articles,
      stats: {
        uniqueVisitors: new Set(events.flatMap((e) => e.actors.map((a) => a.profileId))).size,
        eventsRecorded: events.length,
        bellRings,
        secretsFound: events.filter((e) => e.kind === 'secret_found').length,
      },
    };
    await persistence.gazette.save(issue);
    return issue;
  }

  async function compileDue(): Promise<GazetteIssue | null> {
    if (compiling) return compiling;
    compiling = (async () => {
      const end = now();
      const cursor = (await persistence.worldState.getKv<number>(CURSOR_KEY)) ?? (await persistence.events.firstTs()) ?? end;
      if (cursor >= end) return null;
      return compileIssue(cursor, end);
    })().finally(() => {
      compiling = null;
    });
    return compiling;
  }

  return {
    list: (limit, before) => persistence.gazette.list(Math.min(50, Math.max(1, limit)), before),
    get: (id) => persistence.gazette.get(id),
    compileIssue,
    compileDue,
    start() {
      if (timer) return;
      const run = () => void compileDue().catch((err) => console.error('[gazette] compile failed', err));
      // Catch up if the last period ended more than one interval ago (e.g. server was down).
      void (async () => {
        const cursor = await persistence.worldState.getKv<number>(CURSOR_KEY);
        if (cursor !== null && now() - cursor >= options.intervalMs) run();
      })().catch(() => undefined);
      timer = setInterval(run, Math.max(10_000, options.intervalMs));
      timer.unref();
      if (options.memory) {
        unsubscribe = options.memory.subscribe((e) => {
          if (!earlyDone && e.significance >= 1) void checkEarly().catch((err) => console.error('[gazette] early check failed', err));
        });
        void checkEarly().catch(() => undefined);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (earlyTimer) clearTimeout(earlyTimer);
      earlyTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
