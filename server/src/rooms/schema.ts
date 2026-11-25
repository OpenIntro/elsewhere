/**
 * Colyseus synced state. Field names/types mirror the plain interfaces in
 * shared/src/protocol.ts (PlayerStateView, ObjectStateView, WorldStateView);
 * the `satisfies` checks below keep them from drifting. Append new fields at
 * the END of a schema (wire compatibility).
 */
import { schema, t, type SchemaType } from '@colyseus/schema';
import type { ActivityStateView, KeeperStateView, ObjectStateView, PlayerStateView } from '@elsewhere/shared';

export const PlayerState = schema(
  {
    id: t.string().default(''),
    profileId: t.string().default(''),
    name: t.string().default(''),
    appearance: t.string().default('{}'),
    x: t.float32().default(0),
    y: t.float32().default(0),
    z: t.float32().default(0),
    rot: t.float32().default(0),
    anim: t.string().default('idle'),
    seat: t.string().default(''),
    held: t.string().default(''),
    animSeq: t.uint16().default(0),
    location: t.string().default(''),
    typing: t.boolean().default(false),
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const ObjectState = schema(
  {
    id: t.string().default(''),
    active: t.boolean().default(false),
    value: t.float64().default(0),
    holder: t.string().default(''),
    updatedAt: t.float64().default(0),
  },
  'ObjectState',
);
export type ObjectState = SchemaType<typeof ObjectState>;

/** A building keeper: a WORLD character (never a player; never in `players`). */
export const KeeperState = schema(
  {
    id: t.string().default(''),
    x: t.float32().default(0),
    z: t.float32().default(0),
    rot: t.float32().default(0),
    anim: t.string().default('idle'),
    animSeq: t.uint16().default(0),
    present: t.boolean().default(false),
    task: t.string().default(''),
  },
  'KeeperState',
);
export type KeeperState = SchemaType<typeof KeeperState>;

/** Shared building-activity state (keys and meaning: shared/src/activities.ts ACTIVITY_KEYS). */
export const ActivityState = schema(
  {
    id: t.string().default(''),
    active: t.boolean().default(false),
    value: t.float64().default(0),
    holder: t.string().default(''),
    data: t.string().default(''),
    updatedAt: t.float64().default(0),
  },
  'ActivityState',
);
export type ActivityState = SchemaType<typeof ActivityState>;

export const WorldState = schema(
  {
    clockEpoch: t.float64().default(0),
    dayLengthMs: t.float64().default(0),
    players: t.map(PlayerState),
    objects: t.map(ObjectState),
    // Appended (wire compatibility): building activities.
    keepers: t.map(KeeperState),
    activities: t.map(ActivityState),
  },
  'WorldState',
);
export type WorldState = SchemaType<typeof WorldState>;

// Compile-time drift checks against the shared contract (anim/held/location are
// plain strings on the wire; the shared interface narrows them).
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : T[K] };
type AssertAssignable<A, B extends A> = B;
export type _PlayerCheck = AssertAssignable<Widen<PlayerStateView>, Pick<PlayerState, keyof PlayerStateView>>;
export type _ObjectCheck = AssertAssignable<ObjectStateView, Pick<ObjectState, keyof ObjectStateView>>;
export type _KeeperCheck = AssertAssignable<KeeperStateView, Pick<KeeperState, keyof KeeperStateView>>;
export type _ActivityCheck = AssertAssignable<ActivityStateView, Pick<ActivityState, keyof ActivityStateView>>;
