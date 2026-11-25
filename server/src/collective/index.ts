/**
 * Collective Reality: the world evolves from UNIQUE-player participation and
 * the result persists.
 *
 *  - Rules engine (rules.ts, data-driven): fountain stages, popular places,
 *    night wanderers, resident milestones.
 *  - Portal (secret): runes are lit by touching them; a rune stays lit for
 *    portalWindowMs (or until its lighter leaves). One profile can light only
 *    one rune at a time. When portalRunesRequired runes are lit at once by
 *    that many DISTINCT profiles, the portal at The Unknown awakens for
 *    portalAwakeMs (persisted: survives restart), `portal_arch.active = true`,
 *    `portal_arch.value = total awakenings`, recorded as 'portal_awakened'
 *    crediting the lighters.
 *  - Bell chorus (secret): bellChorusPlayers distinct profiles ring within
 *    bellChorusWindowMs → ObjectEvent 'bell_chorus' + 'bell_chorus' memory.
 *  - Midnight bell (secret): ringing within ±midnightWindow of world-midnight
 *    → ObjectEvent 'bell_midnight' + a milestone event (once per world-day).
 *  - Gatherings / dance parties: periodic headcount per location.
 *  - World clock epoch persisted; if DAY_LENGTH_MINUTES changes between runs
 *    the epoch is rebased so the current time of day is continuous.
 */
import { CONFIG, S2C, type DayPhase, type ErrorCode, type EventActor, type LocationId, type PersistentWorldState, type WorldEvent, LOCATIONS } from '@elsewhere/shared';
import type { CollectiveTunables } from '../env.js';
import type { MemoryService } from '../memory/index.js';
import type { PersistenceService } from '../persistence/index.js';
import type { RoomContext, RoomHooks, TimerHandle } from '../rooms/RoomContext.js';
import { buildRules, describeRules, type CollectiveRule, type RuleSignal } from './rules.js';

/** Gameplay signals the interactions service (and room hooks) forward here. */
export type CollectiveSignal =
  | { type: 'fountain_touched'; sessionId: string; profileId: string }
  | { type: 'rune_touched'; sessionId: string; profileId: string; runeIndex: number }
  | { type: 'rune_released'; sessionId: string; runeIndex?: number }
  | { type: 'bell_rung'; sessionId: string; profileId: string }
  | { type: 'location_entered'; sessionId: string; profileId: string; locationId: LocationId }
  | { type: 'first_visit'; sessionId: string; profileId: string };

export interface SignalResult {
  /** A rules-engine contribution was counted (not a duplicate). */
  counted?: boolean;
  /** A stage changed / the portal woke. */
  changed?: boolean;
  error?: ErrorCode;
}

/** Persistent facts (shared shape + server-only extras). */
export interface WorldFacts extends PersistentWorldState {
  dayLengthMs?: number;
  portalAwakeUntil?: number;
}

export interface CollectiveOptions {
  tunables: CollectiveTunables;
  dayLengthMs: number;
  now?: () => number;
}

export interface CollectiveService extends RoomHooks {
  /** Load persistent facts; creates them (with a fresh clock epoch) on first boot. */
  load(): Promise<WorldFacts>;
  facts(): WorldFacts;
  signal(ctx: RoomContext, signal: CollectiveSignal): Promise<SignalResult>;
  /** Transparent description of the data-driven rules + their current counters. */
  describe(): { rules: ReturnType<typeof describeRules>; counters: Record<string, number> };
  /** Flush facts to storage. */
  save(): Promise<void>;
}

const START = CONFIG.clock.startTimeOfDay;
const actor = (ctx: RoomContext, sid: string): EventActor | null => {
  const p = ctx.getPlayer(sid);
  return p ? { profileId: p.profileId, name: p.name } : null;
};
const locationName = (id: string) => LOCATIONS.find((l) => l.id === id)?.name ?? id;

export function createCollective(persistence: PersistenceService, memory: MemoryService, options: CollectiveOptions): CollectiveService {
  const now = options.now ?? Date.now;
  const t = options.tunables;
  const rules: CollectiveRule[] = buildRules(t);
  let facts: WorldFacts | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialize all mutations of collective state (no double stage-advances). */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => undefined);
    return p;
  };

  const F = () => {
    if (!facts) throw new Error('collective.load() not called');
    return facts;
  };
  const save = () => persistence.worldState.save(F());
  const worldDay = () => Math.floor((now() - F().clockEpochMs) / options.dayLengthMs + START);

  // --- rules engine -----------------------------------------------------------

  async function evaluate(ctx: RoomContext, signal: RuleSignal, sessionId: string, profileId: string, locationId: LocationId | null, phase: DayPhase): Promise<SignalResult> {
    const out: SignalResult = {};
    for (const rule of rules) {
      if (rule.signal !== signal) continue;
      if (rule.match?.locationIds && (!locationId || !rule.match.locationIds.includes(locationId))) continue;
      if (rule.match?.phases && !rule.match.phases.includes(phase)) continue;
      if (rule.scope === 'location' && !locationId) continue;
      const scope = rule.scope === 'location' ? (locationId as string) : 'global';
      const base = `rule:${rule.id}:${scope}`;
      const member = rule.dedupe === 'profile' ? profileId : `${profileId}@${worldDay()}`;
      if (!(await persistence.worldState.addToSet(`${base}:contrib`, member))) continue; // duplicate → ignored
      out.counted = true;
      await persistence.worldState.addToSet(`${base}:distinct`, profileId);
      const c = F().counters;
      let stage = c[`${base}:stage`] ?? 0;
      await persistence.worldState.addToSet(`${base}:since${stage}`, profileId);
      const contributions = await persistence.worldState.setSize(`${base}:contrib`);
      const distinct = await persistence.worldState.setSize(`${base}:distinct`);
      c[`${base}:contributions`] = contributions;
      c[`${base}:distinct`] = distinct;
      const who = actor(ctx, sessionId);
      if (rule.memory.contributionEvent && who) {
        await memory.record({
          kind: rule.memory.contributionEvent.kind,
          actors: [who],
          significance: rule.memory.contributionEvent.significance,
          ...(locationId ? { locationId } : {}),
          ...(rule.effect ? { objectId: rule.effect.objectId } : {}),
          data: { rule: rule.id, contributions, distinct },
        });
      }
      while (stage < rule.stages.length && contributions >= rule.stages[stage]!.contributions && distinct >= rule.stages[stage]!.distinct) {
        const reached = stage + 1;
        const ids = rule.credit === 'trigger' ? [profileId] : await persistence.worldState.setMembers(`${base}:since${stage}`, 50);
        const actors = await namesFor(ctx, ids);
        stage = reached;
        c[`${base}:stage`] = stage;
        if (rule.effect?.type === 'object_value') {
          const o = ctx.getObject(rule.effect.objectId);
          if (o) {
            o.value = stage;
            o.updatedAt = now();
          }
          if (rule.effect.fact === 'fountainStage') F().fountainStage = stage;
        }
        if (rule.id === 'fountain') F().fountainContributors = distinct;
        await save();
        const names = actors.slice(0, 4).map((a) => a.name).join(', ') + (actors.length > 4 ? ` and ${actors.length - 4} others` : '');
        const headline = rule.memory.headline
          .replace('{stage}', String(stage))
          .replace('{contributions}', String(rule.stages[stage - 1]!.contributions))
          .replace('{distinct}', String(distinct))
          .replace('{place}', locationId ? locationName(locationId) : 'The island')
          .replace('{participants}', String(actors.length))
          .replace('{names}', names || 'everyone');
        const ev = {
          kind: rule.memory.kind,
          actors,
          significance: rule.memory.significance,
          ...(locationId ? { locationId } : {}),
          ...(rule.effect ? { objectId: rule.effect.objectId } : {}),
          data: { rule: rule.id, stage, contributions, distinct, participants: ids.length, ...(rule.memory.tag ? { milestone: rule.memory.tag } : {}) },
        };
        if (rule.announce) await memory.announce(ctx, ev, headline);
        else await memory.record(ev);
        if (rule.objectEvent && rule.effect) {
          ctx.broadcast(S2C.objectEvent, { id: rule.effect.objectId, kind: rule.objectEvent, by: sessionId, byName: who?.name ?? '', ts: now(), data: { stage } });
        }
        out.changed = true;
      }
      if (rule.id === 'fountain') F().fountainContributors = distinct;
      await save();
    }
    return out;
  }

  async function namesFor(ctx: RoomContext, ids: string[]): Promise<EventActor[]> {
    const online = new Map<string, string>();
    for (const sid of ctx.sessionIds()) {
      const p = ctx.getPlayer(sid);
      if (p) online.set(p.profileId, p.name);
    }
    const out: EventActor[] = [];
    for (const id of ids.slice(0, 24)) {
      const name = online.get(id) ?? (await persistence.profiles.get(id))?.displayName;
      if (name) out.push({ profileId: id, name });
    }
    return out;
  }

  // --- portal -----------------------------------------------------------------

  interface Lit {
    sessionId: string;
    profileId: string;
    name: string;
    at: number;
    timer: TimerHandle;
  }
  const lit = new Map<number, Lit>();
  let sleepTimer: TimerHandle | null = null;
  const runeId = (i: number) => `rune_${i + 1}`;
  const runeTouchMemo = new Map<string, number>();

  function fadeRune(ctx: RoomContext, index: number, byName = ''): void {
    const l = lit.get(index);
    if (!l) return;
    l.timer.clear();
    lit.delete(index);
    const o = ctx.getObject(runeId(index));
    if (o) {
      o.active = false;
      o.holder = '';
      o.updatedAt = now();
    }
    ctx.broadcast(S2C.objectEvent, { id: runeId(index), kind: 'rune_faded', by: l.sessionId, byName: byName || l.name, ts: now() });
  }

  function setPortalAwake(ctx: RoomContext, until: number): void {
    const o = ctx.getObject('portal_arch');
    if (o) {
      o.active = true;
      o.value = F().portalAwakenings;
      o.updatedAt = now();
    }
    sleepTimer?.clear();
    sleepTimer = ctx.setTimeout(() => void serial(() => portalSleep(ctx)), Math.max(0, until - now()));
  }

  async function portalSleep(ctx: RoomContext): Promise<void> {
    const o = ctx.getObject('portal_arch');
    if (!o?.active) return;
    o.active = false;
    o.updatedAt = now();
    sleepTimer = null;
    F().portalAwakeUntil = 0;
    await save();
    ctx.broadcast(S2C.objectEvent, { id: 'portal_arch', kind: 'portal_sleep', by: '', byName: '', ts: now() });
    await memory.record({ kind: 'portal_slept', actors: [], locationId: 'the_unknown', objectId: 'portal_arch', significance: 1, data: { awakenings: F().portalAwakenings } });
  }

  async function touchRune(ctx: RoomContext, sessionId: string, profileId: string, index: number): Promise<SignalResult> {
    const o = ctx.getObject(runeId(index));
    const me = actor(ctx, sessionId);
    if (!o || !me) return { error: 'not_found' };
    const current = lit.get(index);
    if (current && current.profileId !== profileId) return { error: 'occupied' };
    // One rune per profile: lighting another moves your light.
    for (const [i, l] of lit) if (i !== index && l.profileId === profileId) fadeRune(ctx, i);
    current?.timer.clear();
    const at = now();
    lit.set(index, { sessionId, profileId, name: me.name, at, timer: ctx.setTimeout(() => fadeRune(ctx, index), t.portalWindowMs) });
    o.active = true;
    o.holder = sessionId;
    o.updatedAt = at;
    ctx.broadcast(S2C.objectEvent, { id: runeId(index), kind: 'rune_lit', by: sessionId, byName: me.name, ts: at });
    const last = runeTouchMemo.get(profileId) ?? 0;
    if (at - last > 10 * 60_000) {
      runeTouchMemo.set(profileId, at);
      await memory.record({ kind: 'portal_rune_touched', actors: [me], locationId: 'the_unknown', objectId: runeId(index), significance: 0 });
    }
    const portal = ctx.getObject('portal_arch');
    if (portal?.active) return {};
    const lighters = new Map<string, Lit>();
    for (const l of lit.values()) if (at - l.at <= t.portalWindowMs) lighters.set(l.profileId, l);
    if (lighters.size < t.portalRunesRequired) return {};
    const f = F();
    f.portalAwakenings += 1;
    f.portalAwakeUntil = at + t.portalAwakeMs;
    await save();
    setPortalAwake(ctx, f.portalAwakeUntil);
    const actors = [...lighters.values()].map((l) => ({ profileId: l.profileId, name: l.name }));
    ctx.broadcast(S2C.objectEvent, { id: 'portal_arch', kind: 'portal_awake', by: sessionId, byName: me.name, ts: at, data: { awakenings: f.portalAwakenings } });
    await memory.announce(
      ctx,
      { kind: 'portal_awakened', actors, locationId: 'the_unknown', objectId: 'portal_arch', significance: 3, data: { awakenings: f.portalAwakenings, runes: lighters.size, first: f.portalAwakenings === 1 } },
      f.portalAwakenings === 1 ? `The arch at The Unknown wakes for the first time` : `The arch at The Unknown wakes again`,
    );
    return { changed: true };
  }

  // --- bell -------------------------------------------------------------------

  let rings: { profileId: string; name: string; sessionId: string; ts: number }[] = [];
  let lastChorusAt = 0;

  async function bellRung(ctx: RoomContext, sessionId: string, profileId: string): Promise<SignalResult> {
    const me = actor(ctx, sessionId);
    if (!me) return {};
    const at = now();
    rings = rings.filter((r) => at - r.ts <= CONFIG.collective.bellChorusWindowMs);
    rings.push({ profileId, name: me.name, sessionId, ts: at });
    const out: SignalResult = {};
    const voices = new Map(rings.map((r) => [r.profileId, r]));
    if (voices.size >= t.bellChorusPlayers && at - lastChorusAt >= CONFIG.collective.bellChorusCooldownMs) {
      lastChorusAt = at;
      rings = [];
      const actors = [...voices.values()].map((r) => ({ profileId: r.profileId, name: r.name }));
      ctx.broadcast(S2C.objectEvent, { id: 'bell_town_hall', kind: 'bell_chorus', by: sessionId, byName: me.name, ts: at, data: { voices: actors.length } });
      await memory.announce(
        ctx,
        { kind: 'bell_chorus', actors, locationId: 'town_hall', objectId: 'bell_town_hall', significance: 2, data: { voices: actors.length } },
        'The bell answers in a voice no one has heard before',
      );
      out.changed = true;
    }
    const wt = ctx.worldTime();
    const fromMidnight = Math.min(wt.timeOfDay, 1 - wt.timeOfDay);
    if (fromMidnight <= CONFIG.collective.midnightWindow) {
      // The world-day that this midnight starts (late 23:xx rings belong to the next day).
      const day = wt.timeOfDay > 0.5 ? wt.day + 1 : wt.day;
      ctx.broadcast(S2C.objectEvent, { id: 'bell_town_hall', kind: 'bell_midnight', by: sessionId, byName: me.name, ts: at });
      if (await persistence.worldState.addToSet('secret:midnight_bell', String(day))) {
        await memory.record({ kind: 'milestone', actors: [me], locationId: 'town_hall', objectId: 'bell_town_hall', significance: 2, data: { milestone: 'midnight_bell', worldDay: day } });
      }
      out.changed = true;
    }
    return out;
  }

  // --- gatherings + location tracking ----------------------------------------

  const lastLoc = new Map<string, string>();
  const lastGathering = new Map<string, number>();
  let headcountAcc = 0;

  function headcount(ctx: RoomContext): void {
    const byLoc = new Map<string, Map<string, { name: string; dancing: boolean }>>();
    for (const sid of ctx.sessionIds()) {
      const p = ctx.getPlayer(sid);
      if (!p || !p.location) continue;
      let m = byLoc.get(p.location);
      if (!m) byLoc.set(p.location, (m = new Map()));
      m.set(p.profileId, { name: p.name, dancing: p.anim === 'dance' });
    }
    const at = now();
    for (const [loc, people] of byLoc) {
      const dancers = [...people].filter(([, v]) => v.dancing);
      const big = people.size >= t.gatheringThreshold;
      const party = dancers.length >= CONFIG.collective.danceThreshold;
      if (!big && !party) continue;
      const key = `${loc}:${party ? 'dance' : 'gather'}`;
      if (at - (lastGathering.get(key) ?? 0) < CONFIG.collective.gatheringCooldownMs) continue;
      lastGathering.set(key, at);
      const list = party ? dancers : [...people];
      void serial(() =>
        memory.record({
          kind: party ? 'dance_party' : 'gathering',
          actors: list.map(([profileId, v]) => ({ profileId, name: v.name })),
          locationId: loc as LocationId,
          significance: party ? 1 : 2,
          data: { count: list.length },
        }),
      );
    }
  }

  const service: CollectiveService = {
    async load() {
      const stored = (await persistence.worldState.load()) as WorldFacts | null;
      const t0 = now();
      facts = stored ?? { clockEpochMs: t0, fountainContributors: 0, fountainStage: 0, portalAwakenings: 0, counters: {} };
      facts.counters ??= {};
      if (facts.dayLengthMs && facts.dayLengthMs !== options.dayLengthMs) {
        // Keep the current time of day continuous across a day-length change.
        const elapsedDays = (t0 - facts.clockEpochMs) / facts.dayLengthMs;
        facts.clockEpochMs = Math.round(t0 - elapsedDays * options.dayLengthMs);
      }
      facts.dayLengthMs = options.dayLengthMs;
      await persistence.worldState.save(facts);
      return facts;
    },
    facts: F,
    save,
    describe() {
      return { rules: describeRules(rules), counters: { ...F().counters } };
    },

    signal(ctx, s) {
      return serial(async (): Promise<SignalResult> => {
        const phase = ctx.worldTime().phase;
        switch (s.type) {
          case 'fountain_touched':
            return evaluate(ctx, 'fountain_touched', s.sessionId, s.profileId, 'town_square', phase);
          case 'location_entered':
            return evaluate(ctx, 'location_entered', s.sessionId, s.profileId, s.locationId, phase);
          case 'first_visit':
            return evaluate(ctx, 'first_visit', s.sessionId, s.profileId, null, phase);
          case 'rune_touched':
            return touchRune(ctx, s.sessionId, s.profileId, s.runeIndex);
          case 'rune_released': {
            for (const [i, l] of [...lit]) if (l.sessionId === s.sessionId && (s.runeIndex === undefined || s.runeIndex === i)) fadeRune(ctx, i);
            return {};
          }
          case 'bell_rung':
            return bellRung(ctx, s.sessionId, s.profileId);
        }
      });
    },

    async onRoomCreate(ctx) {
      const f = F();
      const fountain = ctx.getObject('fountain');
      if (fountain) fountain.value = f.fountainStage;
      const portal = ctx.getObject('portal_arch');
      if (portal) portal.value = f.portalAwakenings;
      if (f.portalAwakeUntil && f.portalAwakeUntil > now()) setPortalAwake(ctx, f.portalAwakeUntil);
      else if (f.portalAwakeUntil) {
        f.portalAwakeUntil = 0;
        await save();
      }
    },

    onPlayerJoin(ctx, sessionId) {
      // Start tracking (and counting the arrival location) once the join has settled.
      ctx.setTimeout(() => {
        if (ctx.getPlayer(sessionId)) lastLoc.set(sessionId, '');
      }, 1500);
    },

    async onPlayerLeave(ctx, sessionId) {
      lastLoc.delete(sessionId);
      await service.signal(ctx, { type: 'rune_released', sessionId });
    },

    tick(ctx, dtMs) {
      for (const sid of ctx.sessionIds()) {
        const p = ctx.getPlayer(sid);
        if (!p) continue;
        const prev = lastLoc.get(sid);
        if (prev !== undefined && p.location !== prev) {
          lastLoc.set(sid, p.location);
          if (p.location) void service.signal(ctx, { type: 'location_entered', sessionId: sid, profileId: p.profileId, locationId: p.location as LocationId }).catch((e) => console.error('[collective]', e));
        }
      }
      headcountAcc += dtMs;
      if (headcountAcc >= 5000) {
        headcountAcc = 0;
        headcount(ctx);
      }
    },

    async onRoomDispose(ctx) {
      for (const i of [...lit.keys()]) fadeRune(ctx, i);
      sleepTimer?.clear();
      await queue;
      await save();
    },
  };
  return service;
}

export type { WorldEvent };
