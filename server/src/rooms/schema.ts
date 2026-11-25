/**
 * Colyseus synced state. Field names/types mirror the plain interfaces in
 * shared/src/protocol.ts (PlayerStateView, ObjectStateView, WorldStateView);
 * the `satisfies` checks below keep them from drifting. Append new fields at
 * the END of a schema (wire compatibility).
 */
import { schema, t, type SchemaType } from '@colyseus/schema';
import type { ObjectStateView, PlayerStateView } from '@elsewhere/shared';

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

export const WorldState = schema(
  {
    clockEpoch: t.float64().default(0),
    dayLengthMs: t.float64().default(0),
    players: t.map(PlayerState),
    objects: t.map(ObjectState),
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
