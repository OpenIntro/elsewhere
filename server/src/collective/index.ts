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
 *
 * Scoping: one CollectiveService per WORLD (persistent facts, sets and rule
 * counters are keyed by `worldId` in storage). Transient per-instance state
 * (lit runes, recent bell rings, location tracking, gathering cooldowns,
 * portal sleep timer) lives in a per-ROOM scope keyed by `ctx.roomId`, so two
 * room instances of the same world never share it. Persistent changes (fountain
 * stage, portal awake) are applied to every live room of the world.
 */
import { CONFIG, LOCATIONS, S2C, type DayPhase, type ErrorCode, type EventActor, type LocationId, type PersistentWorldState } from '@elsewhere/shared';
import type { CollectiveTunables } from '../env.js';
import type { MemoryService } from '../memory/index.js';
import { DEFAULT_WORLD_ID, type PersistenceService } from '../persistence/index.js';
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
  /** World instance these facts belong to (default 'default'). */
  worldId?: string;
  now?: () => number;
}

export interface CollectiveService extends RoomHooks {
  readonly worldId: string;
  /** Load persistent facts; creates them (with a fresh clock epoch) on first boot. */
  load(): Promise<WorldFacts>;
  facts(): WorldFacts;
  signal(ctx: RoomContext, signal: CollectiveSignal): Promise<SignalResult>;
  /** Transparent description of the data-driven rules + their current counters. */
  describe(): { rules: ReturnType<typeof describeRules>; counters: Record<string, number> };
  /** Flush facts to storage. */
  save(): Promise<void>;
  /** Number of live room scopes (tests / diagnostics). */
  roomCount(): number;
}

const START = CONFIG.clock.startTimeOfDay;
const actor = (ctx: RoomContext, sid: string): EventActor | null => {
  const p = ctx.getPlayer(sid);
  return p ? { profileId: p.profileId, name: p.name } : null;
};
const locationName = (id: string) => LOCATIONS.find((l) => l.id === id)?.name ?? id;
const runeId = (i: number) => `rune_${i + 1}`;

interface Lit {
  sessionId: string;
  profileId: string;
  name: string;
  at: number;
  timer: TimerHandle;
}

/** Transient state of ONE room instance. */
interface RoomScope {
  ctx: RoomContext;
  lit: Map<number, Lit>;
  sleepTimer: TimerHandle | null;
  rings: { profileId: string; name: string; sessionId: string; ts: number }[];
  lastChorusAt: number;
  lastLoc: Map<string, string>;
  lastGathering: Map<string, number>;
  headcountAcc: number;
}

export function createCollective(persistence: PersistenceService, memory: MemoryService, options: CollectiveOptions): CollectiveService {
  const now = options.now ?? Date.now;
  const t = options.tunables;
  const worldId = options.worldId ?? DEFAULT_WORLD_ID;
  const ws = persistence.forWorld(worldId);
  const rules: CollectiveRule[] = buildRules(t);
  let facts: WorldFacts | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const scopes = new Map<string, RoomScope>();
  /** Per-profile throttle for the low-significance rune-touch memory trail (world-level, not gameplay state). */
  const runeTouchMemo = new Map<string, number>();

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
  const save = () => ws.save(F());
  const worldDay = () => Math.floor((now() - F().clockEpochMs) / options.dayLengthMs + START);
  const scope = (ctx: RoomContext): RoomScope => {
    let s = scopes.get(ctx.roomId);
    if (!s) {
      s = { ctx, lit: new Map(), sleepTimer: null, rings: [], lastChorusAt: 0, lastLoc: new Map(), lastGathering: new Map(), headcountAcc: 0 };
      scopes.set(ctx.roomId, s);
    }
    return s;
  };
  /** Live rooms of this world (the calling room is always included). */
  const rooms = (ctx: RoomContext): RoomContext[] => {
    scope(ctx);
    return [...scopes.values()].map((s) => s.ctx);
  };

  // --- rules engine -----------------------------------------------------------

  async function evaluate(ctx: RoomContext, signal: RuleSignal, sessionId: string, profileId: string, locationId: LocationId | null, phase: DayPhase): Promise<SignalResult> {
    const out: SignalResult = {};
    for (const rule of rules) {
      if (rule.signal !== signal) continue;
      if (rule.match?.locationIds && (!locationId || !rule.match.locationIds.includes(locationId))) continue;
      if (rule.match?.phases && !rule.match.phases.includes(phase)) continue;
      if (rule.scope === 'location' && !locationId) continue;
      const sc = rule.scope === 'location' ? (locationId as string) : 'global';
      const base = `rule:${rule.id}:${sc}`;
      const member = rule.dedupe === 'profile' ? profileId : `${profileId}@${worldDay()}`;
      if (!(await ws.addToSet(`${base}:contrib`, member))) continue; // duplicate → ignored
      out.counted = true;
      await ws.addToSet(`${base}:distinct`, profileId);
      const c = F().counters;
      let stage = c[`${base}:stage`] ?? 0;
      await ws.addToSet(`${base}:since${stage}`, profileId);
      const contributions = await ws.setSize(`${base}:contrib`);
      const distinct = await ws.setSize(`${base}:distinct`);
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
        const ids = rule.credit === 'trigger' ? [profileId] : await ws.setMembers(`${base}:since${stage}`, 50);
        const actors = await namesFor(ctx, ids);
        stage += 1;
        c[`${base}:stage`] = stage;
        if (rule.effect?.type === 'object_value') {
          for (const r of rooms(ctx)) {
            const o = r.getObject(rule.effect.objectId);
            if (o) {
              o.value = stage;
              o.updatedAt = now();
            }
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
        if (rule.announce) {
          const recorded = await memory.announce(ctx, ev, headline);
          for (const r of rooms(ctx)) if (r !== ctx) r.broadcast(S2C.worldEvent, { event: recorded, headline });
        } else await memory.record(ev);
        if (rule.objectEvent && rule.effect) {
          for (const r of rooms(ctx)) r.broadcast(S2C.objectEvent, { id: rule.effect.objectId, kind: rule.objectEvent, by: sessionId, byName: who?.name ?? '', ts: now(), data: { stage } });
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
    for (const r of rooms(ctx)) {
      for (const sid of r.sessionIds()) {
        const p = r.getPlayer(sid);
        if (p) online.set(p.profileId, p.name);
      }
    }
    const out: EventActor[] = [];
    for (const id of ids.slice(0, 24)) {
      const name = online.get(id) ?? (await persistence.profiles.get(id))?.displayName;
      if (name) out.push({ profileId: id, name });
    }
    return out;
  }

  // --- portal -----------------------------------------------------------------

  function fadeRune(ctx: RoomContext, index: number): void {
    const s = scope(ctx);
    const l = s.lit.get(index);
    if (!l) return;
    l.timer.clear();
    s.lit.delete(index);
    const o = ctx.getObject(runeId(index));
    if (o) {
      o.active = false;
      o.holder = '';
      o.updatedAt = now();
    }
    ctx.broadcast(S2C.objectEvent, { id: runeId(index), kind: 'rune_faded', by: l.sessionId, byName: l.name, ts: now() });
  }

  /** Show the portal awake in one room and schedule that room's sleep. */
  function setPortalAwake(ctx: RoomContext, until: number): void {
    const s = scope(ctx);
    const o = ctx.getObject('portal_arch');
    if (o) {
      o.active = true;
      o.value = F().portalAwakenings;
      o.updatedAt = now();
    }
    s.sleepTimer?.clear();
    s.sleepTimer = ctx.setTimeout(() => void serial(() => portalSleep(ctx)), Math.max(0, until - now()));
  }

  async function portalSleep(ctx: RoomContext): Promise<void> {
    const s = scope(ctx);
    s.sleepTimer = null;
    const o = ctx.getObject('portal_arch');
    if (o?.active) {
      o.active = false;
      o.updatedAt = now();
      ctx.broadcast(S2C.objectEvent, { id: 'portal_arch', kind: 'portal_sleep', by: '', byName: '', ts: now() });
    }
    // The persistent fact (and its memory event) changes once per world, whichever room's timer fires first.
    const f = F();
    if (f.portalAwakeUntil && f.portalAwakeUntil <= now()) {
      f.portalAwakeUntil = 0;
      await save();
      await memory.record({ kind: 'portal_slept', actors: [], locationId: 'the_unknown', objectId: 'portal_arch', significance: 1, data: { awakenings: f.portalAwakenings } });
    }
  }

  async function touchRune(ctx: RoomContext, sessionId: string, profileId: string, index: number): Promise<SignalResult> {
    const s = scope(ctx);
    const o = ctx.getObject(runeId(index));
    const me = actor(ctx, sessionId);
    if (!o || !me) return { error: 'not_found' };
    const current = s.lit.get(index);
    if (current && current.profileId !== profileId) return { error: 'occupied' };
    // One rune per profile: lighting another moves your light.
    for (const [i, l] of s.lit) if (i !== index && l.profileId === profileId) fadeRune(ctx, i);
    current?.timer.clear();
    const at = now();
    s.lit.set(index, { sessionId, profileId, name: me.name, at, timer: ctx.setTimeout(() => fadeRune(ctx, index), t.portalWindowMs) });
    o.active = true;
    o.holder = sessionId;
    o.updatedAt = at;
    ctx.broadcast(S2C.objectEvent, { id: runeId(index), kind: 'rune_lit', by: sessionId, byName: me.name, ts: at });
    if (at - (runeTouchMemo.get(profileId) ?? 0) > 10 * 60_000) {
      runeTouchMemo.set(profileId, at);
      await memory.record({ kind: 'portal_rune_touched', actors: [me], locationId: 'the_unknown', objectId: runeId(index), significance: 0 });
    }
    if (ctx.getObject('portal_arch')?.active) return {};
    const lighters = new Map<string, Lit>();
    for (const l of s.lit.values()) if (at - l.at <= t.portalWindowMs) lighters.set(l.profileId, l);
    if (lighters.size < t.portalRunesRequired) return {};
    const f = F();
    f.portalAwakenings += 1;
    f.portalAwakeUntil = at + t.portalAwakeMs;
    await save();
    const actors = [...lighters.values()].map((l) => ({ profileId: l.profileId, name: l.name }));
    const headline = f.portalAwakenings === 1 ? 'The arch at The Unknown wakes for the first time' : 'The arch at The Unknown wakes again';
    const event = await memory.announce(
      ctx,
      { kind: 'portal_awakened', actors, locationId: 'the_unknown', objectId: 'portal_arch', significance: 3, data: { awakenings: f.portalAwakenings, runes: lighters.size, first: f.portalAwakenings === 1 } },
      headline,
    );
    for (const r of rooms(ctx)) {
      setPortalAwake(r, f.portalAwakeUntil);
      r.broadcast(S2C.objectEvent, { id: 'portal_arch', kind: 'portal_awake', by: sessionId, byName: me.name, ts: at, data: { awakenings: f.portalAwakenings } });
      if (r !== ctx) r.broadcast(S2C.worldEvent, { event, headline });
    }
    return { changed: true };
  }

  // --- bell -------------------------------------------------------------------

  async function bellRung(ctx: RoomContext, sessionId: string, profileId: string): Promise<SignalResult> {
    const s = scope(ctx);
    const me = actor(ctx, sessionId);
    if (!me) return {};
    const at = now();
    s.rings = s.rings.filter((r) => at - r.ts <= CONFIG.collective.bellChorusWindowMs);
    s.rings.push({ profileId, name: me.name, sessionId, ts: at });
    const out: SignalResult = {};
    const voices = new Map(s.rings.map((r) => [r.profileId, r]));
    if (voices.size >= t.bellChorusPlayers && at - s.lastChorusAt >= CONFIG.collective.bellChorusCooldownMs) {
      s.lastChorusAt = at;
      s.rings = [];
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
      if (await ws.addToSet('secret:midnight_bell', String(day))) {
        await memory.record({ kind: 'milestone', actors: [me], locationId: 'town_hall', objectId: 'bell_town_hall', significance: 2, data: { milestone: 'midnight_bell', worldDay: day } });
      }
      out.changed = true;
    }
    return out;
  }

  // --- gatherings (per room) ------------------------------------------------

  function headcount(ctx: RoomContext): void {
    const s = scope(ctx);
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
      if (at - (s.lastGathering.get(key) ?? 0) < CONFIG.collective.gatheringCooldownMs) continue;
      s.lastGathering.set(key, at);
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
    worldId,
    async load() {
      const stored = (await ws.load()) as WorldFacts | null;
      const t0 = now();
      facts = stored ?? { clockEpochMs: t0, fountainContributors: 0, fountainStage: 0, portalAwakenings: 0, counters: {} };
      facts.counters ??= {};
      if (facts.dayLengthMs && facts.dayLengthMs !== options.dayLengthMs) {
        // Keep the current time of day continuous across a day-length change.
        const elapsedDays = (t0 - facts.clockEpochMs) / facts.dayLengthMs;
        facts.clockEpochMs = Math.round(t0 - elapsedDays * options.dayLengthMs);
      }
      facts.dayLengthMs = options.dayLengthMs;
      await ws.save(facts);
      return facts;
    },
    facts: F,
    save,
    roomCount: () => scopes.size,
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
            for (const [i, l] of [...scope(ctx).lit]) if (l.sessionId === s.sessionId && (s.runeIndex === undefined || s.runeIndex === i)) fadeRune(ctx, i);
            return {};
          }
          case 'bell_rung':
            return bellRung(ctx, s.sessionId, s.profileId);
        }
      });
    },

    async onRoomCreate(ctx) {
      scope(ctx);
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
        if (ctx.getPlayer(sessionId)) scope(ctx).lastLoc.set(sessionId, '');
      }, 1500);
    },

    async onPlayerLeave(ctx, sessionId) {
      scope(ctx).lastLoc.delete(sessionId);
      await service.signal(ctx, { type: 'rune_released', sessionId });
    },

    tick(ctx, dtMs) {
      const s = scope(ctx);
      for (const sid of ctx.sessionIds()) {
        const p = ctx.getPlayer(sid);
        if (!p) continue;
        const prev = s.lastLoc.get(sid);
        if (prev !== undefined && p.location !== prev) {
          s.lastLoc.set(sid, p.location);
          if (p.location) void service.signal(ctx, { type: 'location_entered', sessionId: sid, profileId: p.profileId, locationId: p.location as LocationId }).catch((e) => console.error('[collective]', e));
        }
      }
      s.headcountAcc += dtMs;
      if (s.headcountAcc >= 5000) {
        s.headcountAcc = 0;
        headcount(ctx);
      }
    },

    async onRoomDispose(ctx) {
      const s = scopes.get(ctx.roomId);
      if (s) {
        for (const i of [...s.lit.keys()]) fadeRune(ctx, i);
        s.sleepTimer?.clear();
      }
      scopes.delete(ctx.roomId);
      await queue;
      await save();
    },
  };
  return service;
}
