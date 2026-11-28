/**
 * Collective Reality rules — DATA, not code paths. The engine (engine.ts)
 * evaluates every rule whose `signal` matches:
 *
 *   1. `match` filters the signal (location ids, day phases).
 *   2. A contribution is deduplicated by `dedupe`:
 *        'profile'               — once per profile, ever
 *        'profile_per_world_day' — once per profile per in-world day
 *      Duplicate contributions are ignored entirely (anti-spam).
 *   3. Contributions and distinct contributors are counted per `scope`
 *      ('global' or per 'location'), persisted as unique-member sets.
 *   4. When BOTH `contributions >= stage.contributions` AND
 *      `distinct >= stage.distinct` for the next stage, the stage advances:
 *      the persistent stage counter is bumped, `effect` is applied to synced
 *      state, and a World Memory event is recorded crediting the distinct
 *      participants since the previous stage (announced if `announce`).
 *
 * Thresholds come from shared CONFIG (with server env overrides in env.ts).
 */
import { CONFIG, type DayPhase, type LocationId, type ObjectEvent, type WorldEvent, type WorldEventKind } from '@elsewhere/shared';
import type { CollectiveTunables } from '../env.js';

export type RuleSignal = 'fountain_touched' | 'location_entered' | 'first_visit';

export interface RuleStage {
  contributions: number;
  distinct: number;
}

export interface CollectiveRule {
  id: string;
  description: string;
  signal: RuleSignal;
  match?: { locationIds?: readonly LocationId[]; phases?: readonly DayPhase[] };
  scope: 'global' | 'location';
  dedupe: 'profile' | 'profile_per_world_day';
  stages: readonly RuleStage[];
  /** Persistent change applied to synced state when a stage is reached. */
  effect?: { type: 'object_value'; objectId: string; fact?: 'fountainStage' };
  /** One-shot object event broadcast on stage change. */
  objectEvent?: ObjectEvent['kind'];
  memory: {
    kind: WorldEventKind;
    significance: WorldEvent['significance'];
    /** Headline template: {stage} {contributions} {distinct} {place} {names} {participants}. */
    headline: string;
    /** Data tag stored in event.data.milestone (gazette template key). */
    tag?: string;
    /** Record a low-significance event for every counted contribution (honest activity trail). */
    contributionEvent?: { kind: WorldEventKind; significance: WorldEvent['significance'] };
  };
  announce: boolean;
  /** Who the stage event credits: everyone who contributed since the previous stage (default) or only the triggering player. */
  credit?: 'participants' | 'trigger';
}

function zipStages(contrib: readonly number[], distinct: readonly number[]): RuleStage[] {
  return contrib.map((c, i) => ({ contributions: c, distinct: Math.min(c, distinct[i] ?? distinct[distinct.length - 1] ?? 1) }));
}

export function buildRules(t: CollectiveTunables): CollectiveRule[] {
  return [
    {
      id: 'fountain',
      description: 'The fountain transforms as distinct residents touch its water (one contribution per resident per world-day).',
      signal: 'fountain_touched',
      scope: 'global',
      dedupe: 'profile_per_world_day',
      stages: zipStages(t.fountainStages, t.fountainStageDistinct),
      effect: { type: 'object_value', objectId: 'fountain', fact: 'fountainStage' },
      objectEvent: 'fountain_stage',
      memory: {
        kind: 'fountain_transformed',
        significance: 3,
        headline: 'The fountain changes — stage {stage}, thanks to {names}',
        contributionEvent: { kind: 'fountain_touched', significance: 0 },
      },
      announce: true,
    },
    {
      id: 'popular_place',
      description: 'A place becomes a known gathering spot as daily-unique visits accumulate.',
      signal: 'location_entered',
      scope: 'location',
      dedupe: 'profile_per_world_day',
      stages: CONFIG.collective.placeVisitMilestones.map((n) => ({ contributions: n, distinct: Math.max(2, Math.ceil(n / 5)) })),
      memory: { kind: 'milestone', significance: 1, tag: 'place_visits', headline: '{place} has welcomed {contributions} visits' },
      announce: false,
    },
    {
      id: 'night_wanderers',
      description: 'Night-time wanderings into the Woods and The Unknown are remembered.',
      signal: 'location_entered',
      match: { locationIds: ['woods', 'the_unknown'], phases: ['night'] },
      scope: 'global',
      dedupe: 'profile_per_world_day',
      stages: CONFIG.collective.nightWanderMilestones.map((n) => ({ contributions: n, distinct: Math.max(1, Math.ceil(n / 3)) })),
      memory: { kind: 'milestone', significance: 1, tag: 'night_wanders', headline: '{contributions} night walks into the dark beyond the town' },
      announce: false,
    },
    {
      id: 'residents',
      description: 'Resident milestones: the Nth person to ever arrive on the island.',
      signal: 'first_visit',
      scope: 'global',
      dedupe: 'profile',
      stages: CONFIG.collective.residentMilestones.map((n) => ({ contributions: n, distinct: n })),
      memory: { kind: 'milestone', significance: 2, tag: 'residents', headline: 'The island welcomes resident number {contributions}: {names}' },
      announce: true,
      credit: 'trigger',
    },
  ];
}

/** Public, transparent view of the rules (served at GET /api/world). */
export function describeRules(rules: readonly CollectiveRule[]) {
  return rules.map((r) => ({ id: r.id, description: r.description, signal: r.signal, scope: r.scope, dedupe: r.dedupe, match: r.match ?? null, stages: r.stages }));
}
