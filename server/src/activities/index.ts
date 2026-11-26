/**
 * Building activities, server-authoritative (rules: shared/src/activities.ts).
 *
 * Everything players see happening indoors is either a real player's action
 * (validated here: range + same side of the wall, rate limits, per-day limits,
 * moderation) or clearly world behaviour (keepers, kettles coming to the boil,
 * hearths burning down). Keepers are never players: they live in
 * `state.keepers`, never in `state.players`, never chat, never appear as
 * actors in World Memory.
 *
 * Synced state: `state.activities` (ACTIVITY_KEYS) + `state.keepers`.
 * Persistent (survives restarts): notices / guest books / tide log
 * (activity_notes), poll votes (poll_votes), the Workshop project progress,
 * completed projects, hearths, boathouse nets (world kv / sets).
 * Transient per room instance: keepers, presence counts, stage/lectern holders,
 * drinks in hand, cooldowns.
 *
 * Activities:
 *  - Café: order a drink from the barista (held item; sip; runs out), the piano
 *    (notes relayed to everyone in or near the café), the stage (chat carries
 *    through the café), today's special.
 *  - General Store: today's free curiosities (per profile per world-day), try-on mirror.
 *  - Town Hall: notice board (moderated, limited, expiring, owner/admin removal,
 *    reportable), the town poll (one vote per profile; result recorded when the
 *    period ends), the lectern (chat carries through the hall).
 *  - Workshop: the town project (contributions per profile per world-day, per-stage
 *    contribution + DISTINCT contributor thresholds; completion = permanent change outside).
 *  - Homes: hearth, kettle, guest book. Boathouse: mend the nets, tide log.
 */
import { randomUUID } from 'node:crypto';
import {
  ACTIVITY_KEYS,
  CAFE_STAGE,
  CONFIG,
  DRINKS,
  HALL_LECTERN,
  INTERACTABLES,
  INTERIORS,
  KEEPERS,
  PIANO_NOTES,
  PROJECTS,
  S2C,
  STATIONS,
  buildingLocal,
  curiositiesForDay,
  dist,
  getBuilding,
  getInteractable,
  getKeeper,
  getStation,
  interiorAnchor,
  interiorAt,
  isDrinkItem,
  isOpenAt,
  keeperForInterior,
  pollForDay,
  sameSpace,
  specialForDay,
  zoneContains,
  type ActivityEvent,
  type ActivityResultPayload,
  type ActivityPayload,
  type BoardEntry,
  type ErrorCode,
  type EventActor,
  type Interactable,
  type InteractResult,
  type ItemId,
  type NetsData,
  type PianoNotePayload,
  type PollData,
  type ProjectData,
  type StationDef,
} from '@elsewhere/shared';
import { toProfileSummary } from '../auth/index.js';
import type { ActivityTunables } from '../env.js';
import type { MemoryService } from '../memory/index.js';
import type { ModerationService } from '../moderation/index.js';
import { maskProfanity, sanitizeMultiline } from '../moderation/text.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks, TimerHandle } from '../rooms/RoomContext.js';
import { ActivityState, KeeperState } from '../rooms/schema.js';
import { createKeeperSims, stepKeeper, attend, type KeeperSim } from './keepers.js';
import { createActivityRepository, type ActivityRepository, type StoredNote } from './repository.js';

export interface ActivityDeps {
  persistence: PersistenceService;
  memory: MemoryService;
  moderation: ModerationService;
  worldId: string;
  /** World clock epoch (collective facts) for world-day arithmetic outside a room. */
  clock: () => { epochMs: number; dayLengthMs: number };
  tunables: ActivityTunables;
  now?: () => number;
  random?: () => number;
}

export interface ChatReach {
  interiorId: string;
  stage: 'cafe_stage' | 'hall_lectern';
}

export interface ActivityService extends RoomHooks {
  /** Station / keeper interactables (WorldRoom validated existence, range and same space). */
  interact(ctx: RoomContext, sessionId: string, target: Interactable): Promise<InteractResult>;
  handle(ctx: RoomContext, sessionId: string, payload: ActivityPayload): Promise<void>;
  pianoNote(ctx: RoomContext, sessionId: string, payload: PianoNotePayload): void;
  /** Whose chat carries through a whole building right now (stage / lectern). */
  chatReach(ctx: RoomContext, sessionId: string): ChatReach | null;
  /** Admin tools. */
  listNotes(boardId: string | undefined, limit: number): Promise<StoredNote[]>;
  adminRemoveNote(id: string): Promise<boolean>;
  /** Tests / diagnostics. */
  readonly repo: ActivityRepository;
}

const PROJECT_KEY = 'activities:project';
const NETS_KEY = 'activities:nets';
const POLL_ACTIVE_KEY = 'activities:poll:active';
const POLL_LAST_KEY = 'activities:poll:last';
const POLL_CLOSED_SET = 'activities:poll:closed';
const hearthKey = (house: string) => `activities:hearth:${house}`;
const NOTICE_BOARD = 'hall_notices';
const BOARD_STATIONS = new Map(STATIONS.filter((s) => s.board).map((s) => [s.board!, s]));
const HOMES = ['house_1', 'house_2'];

interface ProjectState {
  index: number;
  stage: number;
  contributions: number;
  total: number;
  completed: string[];
}
interface Drink {
  item: ItemId;
  sips: number;
  until: number;
  lastSip: number;
}
interface RoomScope {
  ctx: RoomContext;
  keepers: KeeperSim[];
  drinks: Map<string, Drink>;
  animTimers: Map<string, TimerHandle>;
  acc: { presence: number; zones: number; slow: number };
  lastPianoAnim: Map<string, number>;
}

export function createActivities(deps: ActivityDeps): ActivityService {
  const { persistence, memory, moderation, tunables: T } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const ws = persistence.forWorld(deps.worldId);
  const repo = createActivityRepository(persistence, deps.worldId);
  const scopes = new Map<string, RoomScope>();
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialize world-level mutations (no double stage advances / double votes). */
  const serial = <R>(fn: () => Promise<R>): Promise<R> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  // --- world-level (persistent) state --------------------------------------
  let loaded = false;
  const boards = new Map<string, BoardEntry[]>();
  let project: ProjectState = { index: 0, stage: 0, contributions: 0, total: 0, completed: [] };
  let nets: NetsData = { sections: 0, nets: 0 };
  const hearths = new Map<string, number>(); // house → lit until
  const kettles = new Map<string, { readyAt: number; readyUntil: number; whistled: boolean }>();
  let poll: { key: string; tallies: number[]; endDay: number; question: string; options: string[] } = { key: '', tallies: [], endDay: 0, question: '', options: [] };
  let lastPoll: PollData['last'] = null;
  const cooldowns = new Map<string, number>(); // `${profile}:${what}` → ms
  const memo = new Map<string, number>(); // memory throttles

  const worldDay = (): number => {
    const c = deps.clock();
    return Math.floor((now() - c.epochMs) / c.dayLengthMs + CONFIG.clock.startTimeOfDay);
  };
  const stages = (): { contributions: number; distinct: number }[] => {
    const c = T.projectStageContributions;
    const d = T.projectStageDistinct;
    return c.map((n, i) => ({ contributions: Math.max(1, Math.round(n)), distinct: Math.max(1, Math.round(d[i] ?? d[d.length - 1] ?? 1)) }));
  };

  // --- sync helpers -----------------------------------------------------------
  const rooms = (): RoomContext[] => [...scopes.values()].map((s) => s.ctx);
  function put(ctx: RoomContext, key: string, patch: { active?: boolean; value?: number; holder?: string; data?: string }): void {
    let a = ctx.state.activities.get(key);
    if (!a) {
      a = new ActivityState({ id: key, updatedAt: now() });
      ctx.state.activities.set(key, a);
    }
    let changed = false;
    if (patch.active !== undefined && a.active !== patch.active) ((a.active = patch.active), (changed = true));
    if (patch.value !== undefined && a.value !== patch.value) ((a.value = patch.value), (changed = true));
    if (patch.holder !== undefined && a.holder !== patch.holder) ((a.holder = patch.holder), (changed = true));
    if (patch.data !== undefined && a.data !== patch.data) ((a.data = patch.data), (changed = true));
    if (changed) a.updatedAt = now();
  }
  const putAll = (key: string, patch: Parameters<typeof put>[2]) => {
    for (const r of rooms()) put(r, key, patch);
  };

  const projectData = (): ProjectData => {
    const st = stages();
    const def = PROJECTS[project.index];
    const need = st[Math.min(project.stage, st.length - 1)]!;
    return {
      projectId: def?.id ?? '',
      index: project.index,
      stage: def ? project.stage : st.length,
      stages: st.length,
      contributions: def ? project.contributions : 0,
      distinct: 0,
      need,
      completed: [...project.completed],
      total: project.total,
    };
  };
  async function syncProject(): Promise<void> {
    const d = projectData();
    const def = PROJECTS[project.index];
    if (def) d.distinct = await ws.setSize(`activities:project:${def.id}:s${project.stage}`);
    putAll(ACTIVITY_KEYS.project, { value: d.stage, active: !def, data: JSON.stringify(d) });
  }
  const syncBoard = (boardId: string) => {
    const entries = boards.get(boardId) ?? [];
    putAll(ACTIVITY_KEYS.board(boardId), { value: entries.length, data: JSON.stringify({ entries }) });
  };
  const syncNets = () => putAll(ACTIVITY_KEYS.nets, { value: nets.sections, data: JSON.stringify({ sections: T.netSections, nets: nets.nets } satisfies NetsData) });
  const syncPoll = () => {
    const data: PollData = { key: poll.key, question: poll.question, options: [...poll.options], tallies: [...poll.tallies], endDay: poll.endDay, last: lastPoll };
    putAll(ACTIVITY_KEYS.poll, { value: poll.tallies.reduce((a, b) => a + b, 0), data: JSON.stringify(data) });
  };
  const syncHearth = (house: string) => {
    const until = hearths.get(house) ?? 0;
    putAll(ACTIVITY_KEYS.hearth(house), { active: until > now(), value: until });
  };
  const syncKettle = (house: string) => {
    const k = kettles.get(house);
    putAll(ACTIVITY_KEYS.kettle(house), { active: !!k && now() < k.readyUntil, value: k?.readyAt ?? 0, data: k ? JSON.stringify({ readyUntil: k.readyUntil }) : '' });
  };
  const syncDaily = (ctx: RoomContext) => {
    const day = ctx.worldTime().day;
    const sp = specialForDay(day);
    put(ctx, ACTIVITY_KEYS.special, { value: day, data: JSON.stringify(sp) });
    put(ctx, ACTIVITY_KEYS.shelf, { value: day, data: JSON.stringify({ items: curiositiesForDay(day) }) });
  };

  const entryOf = (n: StoredNote): BoardEntry => ({ id: n.id, a: n.authorName, p: n.profileId, t: n.text, ts: n.createdAt, x: n.expiresAt ?? 0 });
  const maxVisible = (boardId: string) => (boardId === NOTICE_BOARD ? CONFIG.activities.noticeMaxVisible : CONFIG.activities.guestbookMaxVisible);

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    for (const boardId of BOARD_STATIONS.keys()) boards.set(boardId, (await repo.visibleNotes(boardId, now(), maxVisible(boardId))).map(entryOf));
    const p = await ws.getKv<ProjectState>(PROJECT_KEY);
    if (p) project = { index: p.index ?? 0, stage: p.stage ?? 0, contributions: p.contributions ?? 0, total: p.total ?? 0, completed: Array.isArray(p.completed) ? p.completed.filter((id) => PROJECTS.some((x) => x.id === id)) : [] };
    if (project.stage >= stages().length) project.stage = stages().length - 1; // thresholds changed between runs
    nets = (await ws.getKv<NetsData>(NETS_KEY)) ?? { sections: 0, nets: 0 };
    for (const h of HOMES) hearths.set(h, (await ws.getKv<number>(hearthKey(h))) ?? 0);
    lastPoll = (await ws.getKv<PollData['last']>(POLL_LAST_KEY)) ?? null;
    await rollPoll(true);
  }

  // --- poll ------------------------------------------------------------------
  /** Make `poll` the current period's; close (record) the previous one if it had real votes. */
  async function rollPoll(initial: boolean): Promise<void> {
    const cur = pollForDay(worldDay(), T.pollPeriodDays);
    if (poll.key === cur.key) return;
    // (stored as an object: a bare JSON string does not round-trip through the kv reader)
    const prevKey = initial ? ((await ws.getKv<{ key: string }>(POLL_ACTIVE_KEY))?.key ?? null) : poll.key;
    if (prevKey && prevKey !== cur.key) await closePoll(prevKey);
    poll = { key: cur.key, tallies: await repo.tallies(cur.key, cur.poll.options.length), endDay: cur.endDay, question: cur.poll.question, options: [...cur.poll.options] };
    await ws.setKv(POLL_ACTIVE_KEY, { key: cur.key });
    syncPoll();
  }
  async function closePoll(key: string): Promise<void> {
    if (!(await ws.addToSet(POLL_CLOSED_SET, key))) return; // already closed (another room / earlier run)
    const index = Number.parseInt(key.slice(1), 10);
    const def = pollForDay(index * Math.max(1, T.pollPeriodDays), T.pollPeriodDays).poll;
    if (!key.endsWith(`:${def.id}`)) return;
    const tallies = await repo.tallies(key, def.options.length);
    const total = tallies.reduce((a, b) => a + b, 0);
    if (total === 0) return; // nobody voted: nothing happened, nothing is recorded
    const best = Math.max(...tallies);
    const winners = def.options.filter((_, i) => tallies[i] === best);
    const actors = await namesFor(await repo.voters(key, 24));
    lastPoll = { question: def.question, options: [...def.options], tallies };
    await ws.setKv(POLL_LAST_KEY, lastPoll);
    const result = winners.length === 1 ? winners[0]! : `a tie between ${winners.join(' and ')}`;
    const ev = { kind: 'poll_closed' as const, actors, locationId: 'town_hall' as const, objectId: 'station_hall_poll', significance: 2 as const, data: { poll: def.id, question: def.question, result, votes: total, tallies: def.options.map((o, i) => `${o}: ${tallies[i]}`).join(', ') } };
    const headline = `The town poll closed: ${result} (${total} vote${total === 1 ? '' : 's'})`;
    const live = rooms();
    if (live[0]) {
      const recorded = await memory.announce(live[0], ev, headline);
      for (const r of live.slice(1)) r.broadcast(S2C.worldEvent, { event: recorded, headline });
    } else await memory.record(ev);
  }

  async function namesFor(ids: string[]): Promise<EventActor[]> {
    const online = new Map<string, string>();
    for (const r of rooms()) for (const sid of r.sessionIds()) {
      const p = r.getPlayer(sid);
      if (p) online.set(p.profileId, p.name);
    }
    const out: EventActor[] = [];
    for (const id of ids.slice(0, 24)) {
      const name = online.get(id) ?? (await persistence.profiles.get(id))?.displayName;
      if (name) out.push({ profileId: id, name });
    }
    return out;
  }

  // --- helpers ------------------------------------------------------------------
  const S = (ctx: RoomContext): RoomScope => {
    let s = scopes.get(ctx.roomId);
    if (!s) {
      s = { ctx, keepers: createKeeperSims(now()), drinks: new Map(), animTimers: new Map(), acc: { presence: 0, zones: 0, slow: 0 }, lastPianoAnim: new Map() };
      scopes.set(ctx.roomId, s);
    }
    return s;
  };
  const result = (ctx: RoomContext, sid: string, station: string, action: string, ok: boolean, message?: string, error?: ErrorCode, data?: Record<string, string | number | boolean>) => {
    const r: ActivityResultPayload = { station, action, ok };
    if (message) r.message = message;
    if (error) r.error = error;
    if (data) r.data = data;
    ctx.send(sid, S2C.activityResult, r);
  };
  const refuse = (ctx: RoomContext, sid: string, station: string, action: string, error: ErrorCode, message: string) => result(ctx, sid, station, action, false, message, error);
  /** Everyone in the same building as (x, z) or within `radius` of it. */
  const nearFilter = (ctx: RoomContext, x: number, z: number, radius = 18) => {
    const space = interiorAt({ x, z })?.id ?? null;
    return (sid: string) => {
      const p = ctx.getPlayer(sid);
      if (!p) return false;
      if (space && interiorAt(p)?.id === space) return true;
      return Math.hypot(p.x - x, p.z - z) <= radius;
    };
  };
  const event = (ctx: RoomContext, e: ActivityEvent, radius = 18) => ctx.broadcast(S2C.activityEvent, e, { filter: nearFilter(ctx, e.x, e.z, radius) });
  const oneShot = (ctx: RoomContext, sid: string, ms: number = CONFIG.emotes.interactDurationMs) => {
    const p = ctx.getPlayer(sid);
    if (!p) return;
    const sc = S(ctx);
    p.anim = 'interact';
    p.animSeq = (p.animSeq + 1) % 65536;
    sc.animTimers.get(sid)?.clear();
    sc.animTimers.set(
      sid,
      ctx.setTimeout(() => {
        sc.animTimers.delete(sid);
        const cur = ctx.getPlayer(sid);
        if (cur && cur.anim === 'interact') cur.anim = cur.seat ? 'sit' : 'idle';
      }, ms),
    );
  };
  const onCooldown = (key: string, ms: number): number => {
    const left = (cooldowns.get(key) ?? 0) + ms - now();
    return left > 0 ? left : 0;
  };
  const throttled = (key: string): boolean => {
    if (now() - (memo.get(key) ?? -Infinity) < CONFIG.activities.memoryThrottleMs) return true;
    memo.set(key, now());
    return false;
  };
  const keeperState = (ctx: RoomContext, keeperId: string) => ctx.state.keepers.get(keeperId);
  const keeperPresent = (ctx: RoomContext, interiorId: string): boolean => {
    const k = keeperForInterior(interiorId);
    return !!k && !!keeperState(ctx, k.id)?.present;
  };
  const stationIt = (id: string) => getInteractable(id);

  /** Range + same side of the wall for a station (or keeper talk spot); null = OK, else the refusal sent. */
  function inReach(ctx: RoomContext, sid: string, interactableId: string, action: string): boolean {
    const p = ctx.getPlayer(sid);
    const it = stationIt(interactableId);
    if (!p || !it || (it.kind !== 'station' && it.kind !== 'keeper')) {
      refuse(ctx, sid, interactableId, action, 'not_found', 'There is nothing like that here.');
      return false;
    }
    const range = (it.radius ?? CONFIG.interaction.radius) + CONFIG.interaction.serverSlack;
    if (dist(p, it.position) > range || !sameSpace(p, it.position)) {
      refuse(ctx, sid, interactableId, action, 'too_far', 'Walk a little closer.');
      return false;
    }
    return true;
  }
  const writingPaused = (profileId: string) => moderation.chatMutedFor(profileId) > 0;
  const cleanText = (raw: unknown): string => maskProfanity(sanitizeMultiline(typeof raw === 'string' ? raw : '').replace(/\n+/g, ' ').trim());

  // --- café -------------------------------------------------------------------
  function orderDrink(ctx: RoomContext, sid: string, item: unknown): void {
    const station = 'keeper_barista';
    if (!inReach(ctx, sid, station, 'order')) return;
    const p = ctx.getPlayer(sid)!;
    const def = DRINKS.find((d) => d.id === item);
    if (!def) return refuse(ctx, sid, station, 'order', 'bad_request', 'That is not on the menu.');
    if (!keeperPresent(ctx, 'cafe')) return refuse(ctx, sid, station, 'order', 'forbidden', 'The café is closed — come back in the morning.');
    if (p.held && !isDrinkItem(p.held)) return refuse(ctx, sid, station, 'order', 'forbidden', 'Your hands are full. Set something down first.');
    const wait = onCooldown(`${p.profileId}:drink`, CONFIG.activities.drinkCooldownMs);
    if (wait) return refuse(ctx, sid, station, 'order', 'cooldown', 'Mara is still busy with your last one.');
    cooldowns.set(`${p.profileId}:drink`, now());
    p.held = def.item;
    S(ctx).drinks.set(sid, { item: def.item, sips: CONFIG.activities.drinkSips, until: now() + T.drinkDurationMs, lastSip: 0 });
    const keeper = keeperState(ctx, 'keeper_barista');
    const sim = S(ctx).keepers.find((k) => k.def.id === 'keeper_barista');
    if (keeper && sim) attend(sim, keeper, p, `making a ${def.name.toLowerCase()}`, now());
    const counter = stationIt('keeper_barista')!.position;
    event(ctx, { kind: 'cup', station, by: sid, x: counter.x, z: counter.z, data: { item: def.item } });
    const name = def.id === 'special' ? specialForDay(ctx.worldTime().day).name.toLowerCase() : def.name.toLowerCase();
    const prof = ctx.getProfile(sid);
    if (prof) prof.stats.drinks = (prof.stats.drinks ?? 0) + 1;
    result(ctx, sid, station, 'order', true, `Mara hands you a ${name}. Careful, it’s hot.`);
  }

  function sip(ctx: RoomContext, sid: string): void {
    const p = ctx.getPlayer(sid);
    const d = S(ctx).drinks.get(sid);
    if (!p || !d || p.held !== d.item) return refuse(ctx, sid, 'drink', 'sip', 'bad_request', 'You are not holding a drink.');
    if (now() - d.lastSip < CONFIG.activities.sipCooldownMs) return;
    d.lastSip = now();
    d.sips -= 1;
    oneShot(ctx, sid, 1200);
    event(ctx, { kind: 'sip', station: 'drink', by: sid, x: p.x, z: p.z, data: { left: d.sips } }, 10);
    if (d.sips <= 0) finishDrink(ctx, sid, 'That was the last sip.');
    else result(ctx, sid, 'drink', 'sip', true, undefined, undefined, { left: d.sips });
  }

  function finishDrink(ctx: RoomContext, sid: string, message: string): void {
    const sc = S(ctx);
    const d = sc.drinks.get(sid);
    sc.drinks.delete(sid);
    const p = ctx.getPlayer(sid);
    if (!p || !d) return;
    if (p.held === d.item) p.held = '';
    ctx.send(sid, S2C.activityEvent, { kind: 'drink_done', station: 'drink', by: sid, x: p.x, z: p.z, data: { message } });
  }

  // --- store ------------------------------------------------------------------
  async function takeCuriosity(ctx: RoomContext, sid: string, item: unknown): Promise<void> {
    const station = 'station_store_shelf';
    if (!inReach(ctx, sid, station, 'take')) return;
    const p = ctx.getPlayer(sid)!;
    const prof = ctx.getProfile(sid);
    const day = ctx.worldTime().day;
    const today = curiositiesForDay(day);
    if (typeof item !== 'string' || !today.includes(item as ItemId)) return refuse(ctx, sid, station, 'take', 'bad_request', 'That is not on the table today.');
    if (!keeperPresent(ctx, 'general_store')) return refuse(ctx, sid, station, 'take', 'forbidden', 'The store is closed; the table is covered for the night.');
    if (!prof) return;
    const set = `activities:store:${day}:${p.profileId}`;
    if ((await ws.setSize(set)) >= T.storeTakesPerDay) return refuse(ctx, sid, station, 'take', 'cooldown', `One a day, mind. Come back tomorrow (world-day ${day + 1}).`);
    if (!(await ws.addToSet(set, item))) return refuse(ctx, sid, station, 'take', 'cooldown', 'You already took one of those today.');
    const id = item as ItemId;
    if (!prof.inventory.includes(id)) prof.inventory.push(id);
    prof.stats.curiosities = (prof.stats.curiosities ?? 0) + 1;
    await ctx.saveProfile(sid);
    ctx.send(sid, S2C.profile, toProfileSummary(prof));
    await memory.record({ kind: 'item_picked_up', actors: [{ profileId: p.profileId, name: p.name }], locationId: 'general_store', objectId: station, significance: 0, data: { itemId: id, source: 'store' } });
    const it = stationIt(station)!;
    event(ctx, { kind: 'take', station, by: sid, x: it.position.x, z: it.position.z, data: { item: id } });
    const keeper = keeperState(ctx, 'keeper_shopkeeper');
    const sim = S(ctx).keepers.find((k) => k.def.id === 'keeper_shopkeeper');
    if (keeper && sim) attend(sim, keeper, p, 'wrapping a curiosity', now(), 1800);
    result(ctx, sid, station, 'take', true, 'On the house, for now. It’s in your things.', undefined, { taken: await ws.setSize(set), limit: T.storeTakesPerDay });
  }

  // --- boards (notices, guest books, tide log) -------------------------------
  async function writeEntry(ctx: RoomContext, sid: string, station: StationDef, text: unknown): Promise<void> {
    const boardId = station.board!;
    const action = boardId === NOTICE_BOARD ? 'pin' : 'sign';
    if (!inReach(ctx, sid, station.id, action)) return;
    const p = ctx.getPlayer(sid)!;
    if (writingPaused(p.profileId)) return refuse(ctx, sid, station.id, action, 'forbidden', 'Writing is paused for you right now.');
    const clean = cleanText(text);
    if (!clean) return refuse(ctx, sid, station.id, action, 'bad_request', 'Write something first.');
    const max = boardId === NOTICE_BOARD ? CONFIG.activities.noticeMaxLength : CONFIG.activities.guestbookMaxLength;
    if ([...clean].length > max) return refuse(ctx, sid, station.id, action, 'message_too_long', `Keep it under ${max} characters.`);
    const t = now();
    if (boardId === NOTICE_BOARD) {
      if ((await repo.countActive(boardId, p.profileId, t)) >= T.noticeMaxPerProfile) return refuse(ctx, sid, station.id, action, 'cooldown', `You already have ${T.noticeMaxPerProfile} notices up. Take one down first.`);
    } else {
      const day = ctx.worldTime().day;
      if (!(await ws.addToSet(`activities:book:${boardId}:${day}`, p.profileId))) return refuse(ctx, sid, station.id, action, 'cooldown', 'You have signed this today already.');
    }
    const note: StoredNote = { id: `note_${randomUUID()}`, boardId, profileId: p.profileId, authorName: p.name, text: clean, createdAt: t, expiresAt: boardId === NOTICE_BOARD ? t + T.noticeExpiryMs : null, removedAt: null, removedBy: null };
    await repo.addNote(note);
    const list = [...(boards.get(boardId) ?? []), entryOf(note)];
    boards.set(boardId, list.slice(-maxVisible(boardId)));
    syncBoard(boardId);
    const it = stationIt(station.id)!;
    event(ctx, { kind: action === 'pin' ? 'pin' : 'sign', station: station.id, by: sid, x: it.position.x, z: it.position.z });
    await memory.record({
      kind: boardId === NOTICE_BOARD ? 'notice_pinned' : 'guestbook_signed',
      actors: [{ profileId: p.profileId, name: p.name }],
      locationId: it.locationId,
      objectId: station.id,
      significance: 0,
      data: { board: boardId },
    });
    result(ctx, sid, station.id, action, true, boardId === NOTICE_BOARD ? 'Pinned. It stays up for a few days.' : 'Signed. Thank you for visiting.', undefined, { entryId: note.id });
  }

  async function removeEntry(ctx: RoomContext, sid: string, station: StationDef, entryId: unknown): Promise<void> {
    const p = ctx.getPlayer(sid);
    if (!p || typeof entryId !== 'string') return refuse(ctx, sid, station.id, 'remove', 'bad_request', 'Which one?');
    const note = await repo.getNote(entryId);
    if (!note || note.boardId !== station.board || note.removedAt) return refuse(ctx, sid, station.id, 'remove', 'not_found', 'It is not there any more.');
    if (note.profileId !== p.profileId) return refuse(ctx, sid, station.id, 'remove', 'forbidden', 'Only the person who wrote it can take it down.');
    await repo.removeNote(entryId, now(), 'owner');
    boards.set(note.boardId, (boards.get(note.boardId) ?? []).filter((e) => e.id !== entryId));
    syncBoard(note.boardId);
    result(ctx, sid, station.id, 'remove', true, 'Taken down.');
  }

  async function reportEntry(ctx: RoomContext, sid: string, station: StationDef, entryId: unknown): Promise<void> {
    const p = ctx.getPlayer(sid);
    if (!p || typeof entryId !== 'string') return refuse(ctx, sid, station.id, 'report', 'bad_request', 'Which one?');
    if (moderation.rateLimiter.take(sid, 'report') > 0) return refuse(ctx, sid, station.id, 'report', 'rate_limited', 'Give it a moment.');
    const note = await repo.getNote(entryId);
    if (!note || note.boardId !== station.board) return refuse(ctx, sid, station.id, 'report', 'not_found', 'It is not there any more.');
    if (note.profileId === p.profileId) return refuse(ctx, sid, station.id, 'report', 'bad_request', 'That one is yours — you can take it down instead.');
    await persistence.reports.add({
      id: `rep_${randomUUID()}`,
      ts: now(),
      reporterProfileId: p.profileId,
      targetProfileId: note.profileId,
      reason: 'inappropriate_content',
      details: `${note.boardId} entry ${note.id}`,
      evidence: [`${note.authorName}: ${note.text}`],
    });
    result(ctx, sid, station.id, 'report', true, 'Thanks — a moderator will take a look.');
  }

  // --- poll ---------------------------------------------------------------------
  async function vote(ctx: RoomContext, sid: string, option: unknown): Promise<void> {
    const station = 'station_hall_poll';
    if (!inReach(ctx, sid, station, 'vote')) return;
    const p = ctx.getPlayer(sid)!;
    await rollPoll(false);
    const cur = pollForDay(ctx.worldTime().day, T.pollPeriodDays);
    if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= cur.poll.options.length) return refuse(ctx, sid, station, 'vote', 'bad_request', 'Pick one of the options.');
    if (!(await repo.addVote(cur.key, p.profileId, option, now()))) {
      const mine = await repo.voteOf(cur.key, p.profileId);
      return result(ctx, sid, station, 'vote', false, 'You have already voted on this one.', 'forbidden', mine === null ? undefined : { voted: mine });
    }
    poll.tallies = await repo.tallies(cur.key, cur.poll.options.length);
    syncPoll();
    const it = stationIt(station)!;
    event(ctx, { kind: 'vote', station, by: sid, x: it.position.x, z: it.position.z });
    const prof = ctx.getProfile(sid);
    if (prof) prof.stats.votes = (prof.stats.votes ?? 0) + 1;
    result(ctx, sid, station, 'vote', true, 'Your vote is in the box.', undefined, { voted: option });
  }

  // --- workshop ---------------------------------------------------------------
  async function contribute(ctx: RoomContext, sid: string, station: StationDef): Promise<InteractResult> {
    const p = ctx.getPlayer(sid)!;
    const def = PROJECTS[project.index];
    const ui = (message: string): InteractResult => ({ id: station.id, ok: true, ui: { panel: 'activity', station: 'station_workshop_project', message } });
    if (!def) return ui('Every project on the list is finished. More are planned.');
    const wait = onCooldown(`${p.profileId}:work`, CONFIG.activities.projectCooldownMs);
    if (wait) return { id: station.id, ok: false, error: 'cooldown' };
    const day = ctx.worldTime().day;
    const daySet = `activities:project:day:${day}:${p.profileId}`;
    const done = await ws.setSize(daySet);
    if (done >= T.projectDailyPerProfile) return ui(`You’ve done your share today (${done} of ${T.projectDailyPerProfile}). Come back tomorrow.`);
    cooldowns.set(`${p.profileId}:work`, now());
    await ws.addToSet(daySet, String(done));
    await ws.addToSet(`activities:project:${def.id}:all`, p.profileId);
    await ws.addToSet(`activities:project:${def.id}:s${project.stage}`, p.profileId);
    project.contributions += 1;
    project.total += 1;
    const st = stages();
    const need = st[project.stage]!;
    const distinct = await ws.setSize(`activities:project:${def.id}:s${project.stage}`);
    oneShot(ctx, sid, 1600);
    const at = stationIt(station.id)!.position;
    event(ctx, { kind: 'tool', station: station.id, by: sid, x: at.x, z: at.z, data: { tool: station.tool ?? 'hammer' } }, 22);
    const prof = ctx.getProfile(sid);
    if (prof) prof.stats.projectWork = (prof.stats.projectWork ?? 0) + 1;
    let message = `You ${station.tool === 'saw' ? 'cut timber' : station.tool === 'kiln' ? 'fire a batch of glass' : 'hammer a fitting'} for ${def.name.charAt(0).toLowerCase()}${def.name.slice(1)}.`;
    if (project.contributions >= need.contributions && distinct >= need.distinct) {
      const ids = await ws.setMembers(`activities:project:${def.id}:s${project.stage}`, 24);
      const actors = await namesFor(ids);
      project.stage += 1;
      project.contributions = 0;
      const stageName = def.stageNames[Math.min(project.stage - 1, def.stageNames.length - 1)] ?? `Stage ${project.stage}`;
      if (project.stage >= st.length) {
        const all = await namesFor(await ws.setMembers(`activities:project:${def.id}:all`, 24));
        project.completed.push(def.id);
        project.index += 1;
        project.stage = 0;
        await ws.setKv(PROJECT_KEY, project);
        const headline = `Finished at the Workshop: ${def.name.charAt(0).toLowerCase()}${def.name.slice(1)}`;
        const recorded = await memory.announce(ctx, { kind: 'project_completed', actors: all, locationId: 'workshop', objectId: def.id, significance: 3, data: { project: def.id, name: def.name, outcome: def.outcome, contributors: all.length } }, headline);
        for (const r of rooms()) if (r !== ctx) r.broadcast(S2C.worldEvent, { event: recorded, headline });
        for (const r of rooms()) r.broadcast(S2C.activityEvent, { kind: 'project_done', station: station.id, by: sid, x: p.x, z: p.z, data: { project: def.id } });
        message = `That did it — ${def.name.charAt(0).toLowerCase()}${def.name.slice(1)} is finished! ${def.outcome}.`;
      } else {
        await ws.setKv(PROJECT_KEY, project);
        await memory.record({ kind: 'project_stage', actors, locationId: 'workshop', objectId: def.id, significance: 1, data: { project: def.id, name: def.name, stage: project.stage, stages: st.length, stageName } });
        for (const r of rooms()) r.broadcast(S2C.activityEvent, { kind: 'project_stage', station: station.id, by: sid, x: p.x, z: p.z, data: { project: def.id, stage: project.stage } });
        message = `${stageName}! The project moves on to stage ${project.stage + 1} of ${st.length}.`;
      }
    } else {
      await ws.setKv(PROJECT_KEY, project);
    }
    await syncProject();
    return ui(message);
  }

  // --- homes / boathouse ---------------------------------------------------------
  async function lightHearth(ctx: RoomContext, sid: string, station: StationDef): Promise<InteractResult> {
    const house = station.interiorId;
    const p = ctx.getPlayer(sid)!;
    const until = hearths.get(house) ?? 0;
    if (until > now()) {
      ctx.notice(sid, { level: 'info', text: 'The fire is already going. You warm your hands a moment.' });
      return { id: station.id, ok: true };
    }
    const lit = now() + T.hearthBurnMs;
    hearths.set(house, lit);
    await ws.setKv(hearthKey(house), lit);
    syncHearth(house);
    oneShot(ctx, sid, 1400);
    const it = stationIt(station.id)!;
    event(ctx, { kind: 'hearth_lit', station: station.id, by: sid, x: it.position.x, z: it.position.z }, 30);
    if (!throttled(`hearth:${p.profileId}`)) await memory.record({ kind: 'hearth_lit', actors: [{ profileId: p.profileId, name: p.name }], locationId: 'residential', objectId: station.id, significance: 0, data: { house } });
    ctx.notice(sid, { level: 'success', text: 'The kindling catches. The hearth will burn for a while.' });
    return { id: station.id, ok: true };
  }

  function kettleOn(ctx: RoomContext, sid: string, station: StationDef): InteractResult {
    const house = station.interiorId;
    const k = kettles.get(house);
    if (k && now() < k.readyUntil) {
      ctx.notice(sid, { level: 'info', text: now() < k.readyAt ? 'The kettle is already on. Nearly there.' : 'The kettle has just boiled. Tea, anyone?' });
      return { id: station.id, ok: true };
    }
    const readyAt = now() + CONFIG.activities.kettleBoilMs;
    kettles.set(house, { readyAt, readyUntil: readyAt + CONFIG.activities.kettleReadyMs, whistled: false });
    syncKettle(house);
    oneShot(ctx, sid);
    const it = stationIt(station.id)!;
    event(ctx, { kind: 'kettle_on', station: station.id, by: sid, x: it.position.x, z: it.position.z });
    ctx.notice(sid, { level: 'success', text: 'You put the kettle on.' });
    return { id: station.id, ok: true };
  }

  async function mendNets(ctx: RoomContext, sid: string, station: StationDef): Promise<InteractResult> {
    const p = ctx.getPlayer(sid)!;
    const day = ctx.worldTime().day;
    if (!(await ws.addToSet(`activities:nets:day:${day}`, p.profileId))) {
      ctx.notice(sid, { level: 'info', text: 'You’ve mended your share of the nets today.' });
      return { id: station.id, ok: true };
    }
    await ws.addToSet(`activities:nets:net${nets.nets}`, p.profileId);
    nets.sections += 1;
    oneShot(ctx, sid, 1600);
    const it = stationIt(station.id)!;
    event(ctx, { kind: 'mend', station: station.id, by: sid, x: it.position.x, z: it.position.z });
    let text = `You mend a section of net (${nets.sections} of ${T.netSections}).`;
    if (nets.sections >= T.netSections) {
      const actors = await namesFor(await ws.setMembers(`activities:nets:net${nets.nets}`, 24));
      nets.nets += 1;
      nets.sections = 0;
      await memory.record({ kind: 'nets_mended', actors, locationId: 'waterfront', objectId: station.id, significance: 1, data: { nets: nets.nets } });
      text = `The last knot! A whole net mended — that makes ${nets.nets}.`;
    }
    await ws.setKv(NETS_KEY, nets);
    syncNets();
    ctx.notice(sid, { level: 'success', text });
    return { id: station.id, ok: true };
  }

  // --- piano / stage / lectern ---------------------------------------------------
  const piano = () => stationIt('station_cafe_piano')!;

  // --- ticks -------------------------------------------------------------------------
  function presence(ctx: RoomContext): void {
    const counts = new Map<string, number>();
    for (const sid of ctx.sessionIds()) {
      const p = ctx.getPlayer(sid);
      const it = p ? interiorAt(p) : null;
      if (it) counts.set(it.id, (counts.get(it.id) ?? 0) + 1);
    }
    const hours = ctx.worldTime().hours;
    for (const it of INTERIORS) put(ctx, ACTIVITY_KEYS.building(it.id), { value: counts.get(it.id) ?? 0, active: isOpenAt(it.id, hours) });
  }

  const stageZone = (() => {
    const b = getBuilding(CAFE_STAGE.interiorId);
    return { center: buildingLocal(b, CAFE_STAGE.at[0], CAFE_STAGE.at[1]), halfWidth: CAFE_STAGE.half[0], halfDepth: CAFE_STAGE.half[1], yaw: b.yaw };
  })();
  const lectern = interiorAnchor(HALL_LECTERN.interiorId, HALL_LECTERN.anchor);
  function zones(ctx: RoomContext): void {
    const pick = (key: string, inZone: (p: { x: number; z: number }) => boolean, label: string) => {
      const cur = ctx.state.activities.get(key)?.holder ?? '';
      const curP = cur ? ctx.getPlayer(cur) : undefined;
      if (curP && inZone(curP)) return;
      let next = '';
      for (const sid of ctx.sessionIds()) {
        const p = ctx.getPlayer(sid);
        if (p && inZone(p)) {
          next = sid;
          break;
        }
      }
      if (next !== cur) {
        put(ctx, key, { holder: next, active: !!next });
        if (next) {
          const p = ctx.getPlayer(next)!;
          event(ctx, { kind: 'stage', station: key, by: next, x: p.x, z: p.z, data: { place: label } }, 26);
        }
      }
    };
    pick(ACTIVITY_KEYS.stage, (p) => interiorAt(p)?.id === 'cafe' && zoneContains(stageZone, p), 'cafe_stage');
    pick(ACTIVITY_KEYS.lectern, (p) => interiorAt(p)?.id === 'town_hall' && dist(p, lectern.position) <= HALL_LECTERN.radius, 'hall_lectern');
  }

  function slow(ctx: RoomContext): void {
    const sc = S(ctx);
    const t = now();
    // Drinks run out (or were set down).
    for (const [sid, d] of [...sc.drinks]) {
      const p = ctx.getPlayer(sid);
      if (!p || p.held !== d.item) sc.drinks.delete(sid);
      else if (t >= d.until) finishDrink(ctx, sid, 'Your cup is empty.');
    }
    syncDaily(ctx);
  }

  /** World-level timers (once per tick across rooms: the first room drives them). */
  function worldTimers(): void {
    const t = now();
    for (const h of HOMES) {
      const until = hearths.get(h) ?? 0;
      const a = scopes.size ? [...scopes.values()][0]!.ctx.state.activities.get(ACTIVITY_KEYS.hearth(h)) : undefined;
      if (a?.active && until <= t) {
        syncHearth(h);
        const it = stationIt(`station_house_${h.slice(-1)}_hearth`)!;
        for (const r of rooms()) event(r, { kind: 'hearth_out', station: it.id, by: '', x: it.position.x, z: it.position.z }, 30);
      }
      const k = kettles.get(h);
      if (k && !k.whistled && t >= k.readyAt) {
        k.whistled = true;
        const it = stationIt(`station_house_${h.slice(-1)}_kettle`)!;
        for (const r of rooms()) event(r, { kind: 'kettle_whistle', station: it.id, by: '', x: it.position.x, z: it.position.z }, 20);
        syncKettle(h);
      }
      if (k && t >= k.readyUntil) {
        kettles.delete(h);
        syncKettle(h);
      }
    }
    // Notices expire.
    for (const [boardId, entries] of boards) {
      const keep = entries.filter((e) => !e.x || e.x > t);
      if (keep.length !== entries.length) {
        boards.set(boardId, keep);
        syncBoard(boardId);
      }
    }
    // Poll periods roll with the world day.
    if (pollForDay(worldDay(), T.pollPeriodDays).key !== poll.key) void serial(() => rollPoll(false)).catch((e) => console.error('[activities] poll roll', e));
  }

  // --- service ------------------------------------------------------------------
  const service: ActivityService = {
    repo,

    async interact(ctx, sid, target) {
      const p = ctx.getPlayer(sid);
      if (!p) return { id: target.id, ok: false, error: 'not_found' };
      if (target.kind === 'keeper') {
        const k = getKeeper(target.keeperId);
        if (!k) return { id: target.id, ok: false, error: 'not_found' };
        const ks = keeperState(ctx, k.id);
        const sim = S(ctx).keepers.find((x) => x.def.id === k.id);
        if (ks?.present && sim) attend(sim, ks, p, 'chatting', now(), 2000);
        return { id: target.id, ok: true, ui: { panel: 'activity', station: target.id } };
      }
      if (target.kind !== 'station') return { id: target.id, ok: false, error: 'not_found' };
      const st = getStation(target.stationId);
      if (!st) return { id: target.id, ok: false, error: 'not_found' };
      switch (st.kind) {
        case 'work':
          return serial(() => contribute(ctx, sid, st));
        case 'hearth':
          return serial(() => lightHearth(ctx, sid, st));
        case 'kettle':
          return kettleOn(ctx, sid, st);
        case 'nets':
          return serial(() => mendNets(ctx, sid, st));
        default:
          return { id: target.id, ok: true, ui: { panel: 'activity', station: st.id } };
      }
    },

    async handle(ctx, sid, m) {
      const p = ctx.getPlayer(sid);
      if (!p) return;
      const station = typeof m.station === 'string' ? m.station : '';
      const action = typeof m.action === 'string' ? m.action : '';
      if (station === 'drink' && action === 'sip') return sip(ctx, sid);
      if (station === 'keeper_barista' && action === 'order') return orderDrink(ctx, sid, m.item);
      const st = getStation(station);
      if (!st) return refuse(ctx, sid, station, action, 'not_found', 'There is nothing like that here.');
      if (action === 'status') return status(ctx, sid, st);
      if (st.kind === 'shelf' && action === 'take') return serial(() => takeCuriosity(ctx, sid, m.item));
      if (st.kind === 'poll' && action === 'vote') return serial(() => vote(ctx, sid, m.option));
      if (st.board) {
        if (action === 'pin' || action === 'sign') return serial(() => writeEntry(ctx, sid, st, m.text));
        if (action === 'remove') return serial(() => removeEntry(ctx, sid, st, m.entryId));
        if (action === 'report') return reportEntry(ctx, sid, st, m.entryId);
      }
      refuse(ctx, sid, station, action, 'bad_request', 'That does not work here.');
    },

    pianoNote(ctx, sid, m) {
      const p = ctx.getPlayer(sid);
      if (!p) return;
      const note = m.note;
      if (typeof note !== 'number' || !Number.isInteger(note) || note < 0 || note >= PIANO_NOTES) return;
      const it = piano();
      const seatedAtPiano = p.seat.startsWith('stool_cafe_piano');
      if (!seatedAtPiano && (dist(p, it.position) > (it.radius ?? 2.2) + CONFIG.interaction.serverSlack || !sameSpace(p, it.position))) {
        return refuse(ctx, sid, it.id, 'note', 'too_far', 'Sit at the piano to play.');
      }
      ctx.broadcast(S2C.pianoNote, { by: sid, note, ts: now() }, { filter: nearFilter(ctx, it.position.x, it.position.z, CONFIG.activities.pianoHearingRadius) });
      const sc = S(ctx);
      if (now() - (sc.lastPianoAnim.get(sid) ?? 0) > 700) {
        sc.lastPianoAnim.set(sid, now());
        oneShot(ctx, sid, 900);
      }
      if (!throttled(`piano:${p.profileId}`)) void memory.record({ kind: 'piano_played', actors: [{ profileId: p.profileId, name: p.name }], locationId: 'cafe', objectId: it.id, significance: 0 }).catch((e) => console.error('[activities] memory', e));
    },

    chatReach(ctx, sid) {
      if (ctx.state.activities.get(ACTIVITY_KEYS.stage)?.holder === sid) return { interiorId: 'cafe', stage: 'cafe_stage' };
      if (ctx.state.activities.get(ACTIVITY_KEYS.lectern)?.holder === sid) return { interiorId: 'town_hall', stage: 'hall_lectern' };
      return null;
    },

    listNotes: (boardId, limit) => repo.listNotes(boardId, Math.min(500, Math.max(1, limit))),
    async adminRemoveNote(id) {
      const note = await repo.getNote(id);
      if (!note) return false;
      const ok = await repo.removeNote(id, now(), 'admin');
      boards.set(note.boardId, (boards.get(note.boardId) ?? []).filter((e) => e.id !== id));
      if (BOARD_STATIONS.has(note.boardId)) syncBoard(note.boardId);
      return ok;
    },

    async onRoomCreate(ctx) {
      S(ctx);
      await serial(load);
      for (const k of KEEPERS) ctx.state.keepers.set(k.id, new KeeperState({ id: k.id }));
      // Seed every key in this room from the world-level state.
      for (const boardId of BOARD_STATIONS.keys()) {
        const entries = boards.get(boardId) ?? [];
        put(ctx, ACTIVITY_KEYS.board(boardId), { value: entries.length, data: JSON.stringify({ entries }) });
      }
      const d = projectData();
      const def = PROJECTS[project.index];
      if (def) d.distinct = await ws.setSize(`activities:project:${def.id}:s${project.stage}`);
      put(ctx, ACTIVITY_KEYS.project, { value: d.stage, active: !def, data: JSON.stringify(d) });
      put(ctx, ACTIVITY_KEYS.nets, { value: nets.sections, data: JSON.stringify({ sections: T.netSections, nets: nets.nets }) });
      for (const h of HOMES) {
        const until = hearths.get(h) ?? 0;
        put(ctx, ACTIVITY_KEYS.hearth(h), { active: until > now(), value: until });
        put(ctx, ACTIVITY_KEYS.kettle(h), { active: false, value: 0 });
      }
      put(ctx, ACTIVITY_KEYS.stage, { holder: '', active: false });
      put(ctx, ACTIVITY_KEYS.lectern, { holder: '', active: false });
      syncDaily(ctx);
      syncPoll();
      presence(ctx);
      // Keepers take their places at once.
      const hours = ctx.worldTime().hours;
      for (const sim of S(ctx).keepers) stepKeeper(sim, ctx.state.keepers.get(sim.def.id)!, hours, now(), 0, random);
    },

    tick(ctx, dtMs) {
      const sc = S(ctx);
      const hours = ctx.worldTime().hours;
      for (const sim of sc.keepers) {
        const ks = ctx.state.keepers.get(sim.def.id);
        if (ks) stepKeeper(sim, ks, hours, now(), dtMs, random);
      }
      sc.acc.presence += dtMs;
      sc.acc.zones += dtMs;
      sc.acc.slow += dtMs;
      if (sc.acc.zones >= 250) {
        sc.acc.zones = 0;
        zones(ctx);
      }
      if (sc.acc.presence >= 1000) {
        sc.acc.presence = 0;
        presence(ctx);
        if ([...scopes.keys()][0] === ctx.roomId) worldTimers();
      }
      if (sc.acc.slow >= 2000) {
        sc.acc.slow = 0;
        slow(ctx);
      }
    },

    onPlayerLeave(ctx, sid) {
      const sc = S(ctx);
      sc.drinks.delete(sid);
      sc.animTimers.get(sid)?.clear();
      sc.animTimers.delete(sid);
      sc.lastPianoAnim.delete(sid);
      for (const key of [ACTIVITY_KEYS.stage, ACTIVITY_KEYS.lectern]) if (ctx.state.activities.get(key)?.holder === sid) put(ctx, key, { holder: '', active: false });
      const p = ctx.getPlayer(sid);
      if (p && isDrinkItem(p.held)) p.held = '';
    },

    async onRoomDispose(ctx) {
      const sc = scopes.get(ctx.roomId);
      if (sc) for (const t of sc.animTimers.values()) t.clear();
      scopes.delete(ctx.roomId);
      await queue;
    },
  };

  /** Per-player facts a panel needs (my vote, what I took today, my notices…). */
  async function status(ctx: RoomContext, sid: string, st: StationDef): Promise<void> {
    const p = ctx.getPlayer(sid);
    if (!p) return;
    const day = ctx.worldTime().day;
    const data: Record<string, string | number | boolean> = {};
    if (st.kind === 'poll') {
      const cur = pollForDay(day, T.pollPeriodDays);
      const mine = await repo.voteOf(cur.key, p.profileId);
      data.voted = mine ?? -1;
    } else if (st.kind === 'shelf') {
      data.taken = await ws.setSize(`activities:store:${day}:${p.profileId}`);
      data.limit = T.storeTakesPerDay;
    } else if (st.kind === 'project' || st.kind === 'work') {
      data.today = await ws.setSize(`activities:project:day:${day}:${p.profileId}`);
      data.limit = T.projectDailyPerProfile;
    } else if (st.board === NOTICE_BOARD) {
      data.mine = await repo.countActive(NOTICE_BOARD, p.profileId, now());
      data.limit = T.noticeMaxPerProfile;
    } else if (st.board) {
      data.signedToday = await ws.hasInSet(`activities:book:${st.board}:${day}`, p.profileId);
    }
    result(ctx, sid, st.id, 'status', true, undefined, undefined, data);
  }

  return service;
}

/** Every interactable id the activities service answers for (WorldRoom routing). */
export const ACTIVITY_INTERACTABLES: ReadonlySet<string> = new Set(INTERACTABLES.filter((i) => i.kind === 'station' || i.kind === 'keeper').map((i) => i.id));
