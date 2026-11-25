/**
 * World Memory (persistent, attributed event log) and the Elsewhere Gazette
 * (newspaper compiled from real recorded events via templates). These are the
 * record types; recording/compiling lives in server/src/{memory,gazette}.
 */
import type { LocationId } from './world/locations.js';

export type WorldEventKind =
  | 'player_first_visit'
  | 'player_returned'
  | 'bell_rung'
  | 'fountain_touched'
  | 'fountain_transformed'
  | 'portal_rune_touched'
  | 'portal_awakened'
  | 'portal_slept'
  | 'secret_found'
  | 'item_picked_up'
  | 'item_dropped'
  | 'light_toggled'
  | 'door_opened'
  | 'sign_read'
  | 'mail_sent'
  | 'gathering'
  | 'dance_party'
  | 'sat_together'
  | 'milestone';

/** Who did it. profileId is stable across sessions; name is the display name at the time. */
export interface EventActor {
  profileId: string;
  name: string;
}

export type EventData = Record<string, string | number | boolean>;

export interface WorldEvent {
  /** ULID-ish sortable id. */
  id: string;
  /** Unix ms. */
  ts: number;
  kind: WorldEventKind;
  actors: EventActor[];
  locationId?: LocationId;
  objectId?: string;
  /** Kind-specific details (counts, item ids, stage numbers…). Never free-form user text beyond short names. */
  data?: EventData;
  /** Importance 0..3 for Gazette selection / feed filtering (0 = trivia, 3 = front page). */
  significance: 0 | 1 | 2 | 3;
}

/** What gameplay code hands to MemoryService.record(); id/ts are assigned by the server. */
export type NewWorldEvent = Omit<WorldEvent, 'id' | 'ts'> & { ts?: number };

export interface WorldMemoryQuery {
  /** Return events strictly older than this cursor (event id). */
  before?: string;
  limit?: number;
  kind?: WorldEventKind;
  locationId?: LocationId;
  profileId?: string;
}

// ---------------------------------------------------------------------------
// Gazette
// ---------------------------------------------------------------------------

export type GazetteSection = 'front_page' | 'town_news' | 'comings_and_goings' | 'mysteries' | 'small_moments' | 'by_the_numbers';

export interface GazetteArticle {
  id: string;
  section: GazetteSection;
  headline: string;
  body: string;
  /** World events the article was generated from (attribution/traceability). */
  eventIds: string[];
  /** Template id that produced it (server/src/gazette/templates). */
  templateId: string;
  locationId?: LocationId;
}

export interface GazetteIssue {
  id: string;
  issueNumber: number;
  /** Unix ms. */
  publishedAt: number;
  periodStart: number;
  periodEnd: number;
  /** Masthead line, e.g. "Vol. 1, No. 12 — A misty morning". */
  title: string;
  articles: GazetteArticle[];
  stats: {
    uniqueVisitors: number;
    eventsRecorded: number;
    bellRings: number;
    secretsFound: number;
  };
}

// ---------------------------------------------------------------------------
// Persistent world facts (Collective Reality) — survive restarts.
// ---------------------------------------------------------------------------

export interface PersistentWorldState {
  /** Unix ms of the world clock epoch. */
  clockEpochMs: number;
  /** Unique profile ids that have touched the fountain (count drives the stage). */
  fountainContributors: number;
  fountainStage: number;
  /** Times the portal has been woken. */
  portalAwakenings: number;
  /** Arbitrary named counters for future collective features. */
  counters: Record<string, number>;
}
