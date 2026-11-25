/**
 * Wire contract between client and server.
 *
 *  - ROOM_NAME: the single Colyseus room type (one instance ≈ one world shard).
 *  - C2S / S2C: message type names + payload types for room messages.
 *  - Synced state *shape* (what the Colyseus schema exposes to clients) as
 *    plain interfaces: the server's schema classes implement these, the client
 *    reads room.state through them.
 *  - REST routes + request/response types.
 *
 * Rules: everything here is JSON-serializable; numbers are finite; strings
 * from users are sanitized/length-limited by the server before rebroadcast.
 */
import type { Appearance } from './appearance.js';
import type { BuildRefusal, PieceKind } from './building.js';
import type { GazetteIssue, WorldEvent, WorldEventKind } from './memory.js';
import type { DiscoveryId, ItemId } from './world/items.js';
import type { LocationId } from './world/locations.js';

export const ROOM_NAME = 'world';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ANIM_STATES = ['idle', 'walk', 'run', 'sit', 'wave', 'dance', 'interact'] as const;
export type AnimState = (typeof ANIM_STATES)[number];
/** Animations the client may claim in a move message (others are server-driven). */
export const LOCOMOTION_ANIMS = ['idle', 'walk', 'run'] as const satisfies readonly AnimState[];
export type LocomotionAnim = (typeof LOCOMOTION_ANIMS)[number];

export const EMOTES = ['wave', 'dance'] as const;
export type EmoteId = (typeof EMOTES)[number];

/** Allowed reaction emoji (server rejects others). */
export const REACTIONS = ['❤️', '😂', '😮', '👏', '👋', '✨', '🎉', '😢', '🙌', '🌙'] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];

export type ChatChannel = 'proximity' | 'global' | 'private' | 'system';

export type ReportReason = 'harassment' | 'spam' | 'inappropriate_name' | 'inappropriate_content' | 'cheating' | 'other';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'too_far'
  | 'occupied'
  | 'cooldown'
  | 'blocked'
  | 'invalid_name'
  | 'name_taken'
  | 'message_too_long'
  | 'not_implemented'
  | 'protocol_mismatch'
  | 'room_full'
  | 'internal';

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/** Options passed to client.joinOrCreate(ROOM_NAME, options). */
export interface JoinOptions {
  protocolVersion: number;
  /** Session token from REST (guest or registered). If absent the server creates an ephemeral guest. */
  token?: string;
  /** Used only for ephemeral guests / first visit; registered profiles use stored values. */
  name?: string;
  appearance?: Appearance;
  /**
   * Client hint when re-joining after the previous session was lost (server
   * restart / reconnection grace expired): where the player was standing.
   * Optional for the server to honour; if it does it must validate it
   * (isWalkable, inside the world) and may ignore it (e.g. if too old).
   */
  resume?: { x: number; z: number; rot: number };
}

// ---------------------------------------------------------------------------
// Synced room state (read-only on the client)
// ---------------------------------------------------------------------------

export interface PlayerStateView {
  /** Colyseus sessionId (key in `players`). */
  id: string;
  /** Stable profile id (guest or registered). */
  profileId: string;
  name: string;
  /** JSON-encoded Appearance (sanitized). Parse with parseAppearanceJson. */
  appearance: string;
  x: number;
  y: number;
  z: number;
  /** Yaw in radians. */
  rot: number;
  anim: AnimState;
  /** Seat ref "<interactableId>#<index>" or "" when standing. */
  seat: string;
  /** Item currently held, or "". */
  held: ItemId | '';
  /** Increments every time an emote/anim one-shot is (re)triggered so clients can restart it. */
  animSeq: number;
  /** Current location id, or "" when between places. */
  location: LocationId | '';
  /** True while composing a chat message (speech-bubble typing indicator). */
  typing: boolean;
}

/** Generic per-object synced state. Meaning by interactable kind:
 *  - bench/chair:     value = bitmask of occupied seat indexes
 *  - door:            active = open
 *  - streetlight/lantern: active = on (server may follow the clock unless toggled)
 *  - bell:            value = total rings (increments on ring)
 *  - pickup:          holder = sessionId holding it ("" = available at its spot); active = present at spot
 *  - fountain:        value = transformation stage (0..n)
 *  - portal:          active = awake
 *  - rune:            active = currently lit; holder = sessionId touching it
 */
export interface ObjectStateView {
  id: string;
  active: boolean;
  value: number;
  holder: string;
  /** Server unix ms of last change. */
  updatedAt: number;
}

export interface WorldStateView {
  /** Clock epoch (unix ms) + day length; derive time with clock.worldTimeAt(). */
  clockEpoch: number;
  dayLengthMs: number;
  players: MapLike<PlayerStateView>;
  objects: MapLike<ObjectStateView>;
}

/** Minimal read interface satisfied by Colyseus MapSchema on the client. */
export interface MapLike<V> {
  get(key: string): V | undefined;
  forEach(cb: (value: V, key: string) => void): void;
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export const C2S = {
  move: 'move',
  stand: 'stand',
  emote: 'emote',
  reaction: 'reaction',
  chat: 'chat',
  whisper: 'whisper',
  typing: 'typing',
  interact: 'interact',
  dropItem: 'drop_item',
  mailSend: 'mail_send',
  mailRead: 'mail_read',
  updateProfile: 'update_profile',
  block: 'block',
  unblock: 'unblock',
  mute: 'mute',
  unmute: 'unmute',
  report: 'report',
  /** Building: place a piece (server validates everything, see shared/src/building.ts). */
  buildPlace: 'build_place',
  /** Building: remove one of your own pieces. */
  buildRemove: 'build_remove',
  /** Always-available rescue: teleport to the Town Square (rate limited). */
  unstuck: 'unstuck',
} as const;
export type C2SType = (typeof C2S)[keyof typeof C2S];

export interface MovePayload {
  /** Client-predicted position after this move. Server validates speed + collision. */
  x: number;
  z: number;
  rot: number;
  anim: LocomotionAnim;
  /** Monotonic per-client sequence; echoed in corrections. */
  seq: number;
}
export type StandPayload = Record<string, never>;
export interface EmotePayload {
  emote: EmoteId;
}
export interface ReactionPayload {
  emoji: ReactionEmoji;
  /** Optional target player sessionId (reaction floats over them). */
  target?: string;
}
export interface ChatPayload {
  channel: 'proximity' | 'global';
  text: string;
}
export interface WhisperPayload {
  /** Recipient sessionId. */
  to: string;
  text: string;
}
export interface TypingPayload {
  typing: boolean;
}
export interface InteractPayload {
  /** Interactable id from world/interactables.ts. */
  id: string;
  /** Optional verb for multi-action objects (e.g. mailbox "read" | "send"); default action otherwise. */
  action?: string;
}
export type DropItemPayload = Record<string, never>;
export interface MailSendPayload {
  mailboxId: string;
  text: string;
}
export interface MailReadPayload {
  mailboxId: string;
}
export interface UpdateProfilePayload {
  name?: string;
  appearance?: Appearance;
}
export interface TargetPayload {
  /** Target sessionId (player currently in the room). Server maps it to a profileId so blocks persist. */
  target?: string;
  /**
   * Target profile id — works for players who are offline / not in this room
   * (e.g. unblock from a list after a reload). Either `target` or `profileId` is required;
   * `profileId` wins when both are given.
   */
  profileId?: string;
}

/** A blocked/muted profile as listed for its owner. */
export interface RelationEntry {
  profileId: string;
  /** Current display name ("" if the profile no longer exists). */
  name: string;
}
export interface ReportPayload {
  target: string;
  /** Report by profile instead (offline players, owners of built pieces); wins over `target`. */
  profileId?: string;
  reason: ReportReason;
  details?: string;
  /** Chat message ids relevant to the report. */
  messageIds?: string[];
}

export interface BuildPlacePayload {
  /** Client request id, echoed in S2C.buildResult. */
  reqId: number;
  kind: PieceKind;
  /** Variant id from the catalog (e.g. "oak"). */
  variant: string;
  /** Piece centre, multiples of CONFIG.building.grid. */
  x: number;
  z: number;
  /** Quarter turns 0..3 (yaw = rot * PI/2). */
  rot: number;
  /** Storey index 0..CONFIG.building.maxLevel. */
  level: number;
  /** Signs only: the text (sanitized, filtered and length-capped by the server). */
  text?: string;
}
export interface BuildRemovePayload {
  reqId: number;
  id: string;
}
export type UnstuckPayload = Record<string, never>;

export interface C2SPayloads {
  [C2S.move]: MovePayload;
  [C2S.stand]: StandPayload;
  [C2S.emote]: EmotePayload;
  [C2S.reaction]: ReactionPayload;
  [C2S.chat]: ChatPayload;
  [C2S.whisper]: WhisperPayload;
  [C2S.typing]: TypingPayload;
  [C2S.interact]: InteractPayload;
  [C2S.dropItem]: DropItemPayload;
  [C2S.mailSend]: MailSendPayload;
  [C2S.mailRead]: MailReadPayload;
  [C2S.updateProfile]: UpdateProfilePayload;
  [C2S.block]: TargetPayload;
  [C2S.unblock]: TargetPayload;
  [C2S.mute]: TargetPayload;
  [C2S.unmute]: TargetPayload;
  [C2S.report]: ReportPayload;
  [C2S.buildPlace]: BuildPlacePayload;
  [C2S.buildRemove]: BuildRemovePayload;
  [C2S.unstuck]: UnstuckPayload;
}

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export const S2C = {
  welcome: 'welcome',
  correction: 'correction',
  chat: 'chat',
  emote: 'emote',
  reaction: 'reaction',
  interactResult: 'interact_result',
  objectEvent: 'object_event',
  worldEvent: 'world_event',
  discovery: 'discovery',
  mail: 'mail',
  moderation: 'moderation',
  profile: 'profile',
  notice: 'notice',
  rateLimited: 'rate_limited',
  error: 'error',
  /** Building: all pieces of the world, in chunks, right after joining. */
  buildSnapshot: 'build_snapshot',
  /** Building: a piece was placed (everyone in the world). */
  buildPlaced: 'build_placed',
  /** Building: pieces were removed (everyone in the world). */
  buildRemoved: 'build_removed',
  /** Building: outcome of the requester's place/remove. */
  buildResult: 'build_result',
} as const;
export type S2CType = (typeof S2C)[keyof typeof S2C];

export interface ProfileSummary {
  profileId: string;
  name: string;
  appearance: Appearance;
  kind: 'guest' | 'registered';
  discoveries: DiscoveryId[];
  firstVisitAt: number;
  visits: number;
  /** Items this profile has ever picked up (collection, unique). */
  inventory?: ItemId[];
  /** Registered accounts only (lower-case login name). */
  username?: string;
  /** Simple activity counters (chats, bellRings, fountainTouches, seatsTaken, itemsPicked, mailSent, …). */
  stats?: Record<string, number>;
}

export interface WelcomePayload {
  sessionId: string;
  /** Server unix ms at send time, for client clock offset. */
  serverTime: number;
  clockEpoch: number;
  dayLengthMs: number;
  profile: ProfileSummary;
  /** Profile ids this player has blocked / muted (client hides their chat). */
  blocked: string[];
  muted: string[];
  /** Same lists with display names, for a manage-blocks UI (also GET API.relations). */
  blockedProfiles?: RelationEntry[];
  mutedProfiles?: RelationEntry[];
  /** Recent global/system chat so the log is not empty on join. */
  recentChat: ChatMessage[];
  /** Persistent collective facts. */
  world: {
    fountainStage: number;
    fountainContributors: number;
    portalAwake: boolean;
    /** Times the portal has ever been woken (persistent). */
    portalAwakenings?: number;
    /** Unix ms when the portal falls dormant again (0 when dormant). */
    portalAwakeUntil?: number;
  };
}

export interface CorrectionPayload {
  /** Authoritative position the client must snap/blend to. */
  x: number;
  z: number;
  y: number;
  /** Last move seq the server processed. */
  seq: number;
  reason: 'speed' | 'collision' | 'seated' | 'teleport' | 'invalid';
}

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  /** Sender sessionId ("" for system). */
  from: string;
  fromProfileId: string;
  fromName: string;
  /** Private only: recipient sessionId. */
  to?: string;
  toName?: string;
  text: string;
  ts: number;
  /** Lower-cased display names mentioned via @name (server-extracted). */
  mentions: string[];
}

export interface EmoteEvent {
  sessionId: string;
  emote: EmoteId;
  ts: number;
}

export interface ReactionEvent {
  sessionId: string;
  emoji: ReactionEmoji;
  target?: string;
  ts: number;
}

/** Response to an InteractPayload (only to the requester). */
export interface InteractResult {
  id: string;
  ok: boolean;
  error?: ErrorCode;
  /** Kind-specific UI payload, e.g. { panel: 'sign', title, text } | { panel: 'gazette' } | { panel: 'memory' } | { panel: 'mailbox', ... }. */
  ui?: InteractUi;
}

export type InteractUi =
  | { panel: 'sign' | 'inspect'; title: string; text: string }
  | { panel: 'gazette' }
  | { panel: 'memory' }
  | { panel: 'mailbox'; mailboxId: string; canSend: boolean }
  | { panel: 'discovery'; discoveryId: DiscoveryId; name: string; text: string; firstTime: boolean };

/** One-shot effects everyone nearby should see/hear (bell ring, door creak, splash). */
export interface ObjectEvent {
  id: string;
  kind:
    | 'bell_rung'
    | 'door_opened'
    | 'door_closed'
    | 'light_on'
    | 'light_off'
    | 'picked_up'
    | 'dropped'
    | 'fountain_ripple'
    | 'rune_lit'
    | 'rune_faded'
    | 'portal_awake'
    | 'portal_sleep'
    /** Several distinct players rang the bell close together: it answers with a different voice. */
    | 'bell_chorus'
    /** The bell rung at world-midnight. */
    | 'bell_midnight'
    /** The fountain changed stage (also visible as objects['fountain'].value). */
    | 'fountain_stage';
  by: string;
  byName: string;
  ts: number;
  /** Optional kind-specific numbers (e.g. bell_chorus: { voices }, fountain_stage: { stage }). */
  data?: Record<string, string | number | boolean>;
}

/** A World Memory event worth surfacing as a toast/banner (collective milestones etc.). */
export interface WorldEventNotice {
  event: WorldEvent;
  headline: string;
}

export interface DiscoveryEvent {
  discoveryId: DiscoveryId;
  name: string;
  text: string;
  firstTime: boolean;
}

export interface MailNote {
  id: string;
  mailboxId: string;
  fromProfileId: string;
  fromName: string;
  text: string;
  ts: number;
}

export interface MailPayload {
  mailboxId: string;
  notes: MailNote[];
}

export interface ModerationAck {
  action: 'blocked' | 'unblocked' | 'muted' | 'unmuted' | 'reported';
  targetProfileId: string;
  targetName: string;
}

export interface NoticePayload {
  level: 'info' | 'success' | 'warning' | 'error';
  code?: string;
  text: string;
}

export interface RateLimitedPayload {
  action: string;
  retryInMs: number;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  /** The C2S message type that caused it, if any. */
  inResponseTo?: C2SType;
}

/** A placed piece as the server stores it (y is authoritative, computed by the server). */
export interface PieceView {
  id: string;
  kind: PieceKind;
  variant: string;
  x: number;
  z: number;
  rot: number;
  level: number;
  /** Base height (metres). */
  y: number;
  ownerId: string;
  ownerName: string;
  text?: string;
}

/**
 * Compact snapshot row: [id, kindIndex, variantIndex, x*2, z*2, rot, level, y in cm, ownerIndex, text].
 * kindIndex / variantIndex index PIECE_KINDS / the piece's `variants`; ownerIndex indexes `owners`.
 */
export type PieceWire = [string, number, number, number, number, number, number, number, number, string];

export interface BuildSnapshotPayload {
  /** First chunk: drop everything known so far. */
  reset: boolean;
  /** Last chunk. */
  done: boolean;
  /** Pieces in the whole snapshot. */
  total: number;
  /** [profileId, name] referenced by ownerIndex. */
  owners: [string, string][];
  pieces: PieceWire[];
}
export interface BuildPlacedPayload {
  piece: PieceView;
  /** sessionId of the builder ("" if not in this room). */
  by: string;
}
export interface BuildRemovedPayload {
  ids: string[];
  /** Who removed them: the owner, or a moderator (admin tools). */
  by: 'owner' | 'admin';
}
export interface BuildResultPayload {
  reqId: number;
  action: 'place' | 'remove';
  ok: boolean;
  reason?: BuildRefusal;
  /** Short human-readable reason (shown next to the ghost). */
  message?: string;
  pieceId?: string;
}

export interface S2CPayloads {
  [S2C.welcome]: WelcomePayload;
  [S2C.correction]: CorrectionPayload;
  [S2C.chat]: ChatMessage;
  [S2C.emote]: EmoteEvent;
  [S2C.reaction]: ReactionEvent;
  [S2C.interactResult]: InteractResult;
  [S2C.objectEvent]: ObjectEvent;
  [S2C.worldEvent]: WorldEventNotice;
  [S2C.discovery]: DiscoveryEvent;
  [S2C.mail]: MailPayload;
  [S2C.moderation]: ModerationAck;
  [S2C.profile]: ProfileSummary;
  [S2C.notice]: NoticePayload;
  [S2C.rateLimited]: RateLimitedPayload;
  [S2C.error]: ErrorPayload;
  [S2C.buildSnapshot]: BuildSnapshotPayload;
  [S2C.buildPlaced]: BuildPlacedPayload;
  [S2C.buildRemoved]: BuildRemovedPayload;
  [S2C.buildResult]: BuildResultPayload;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export const API = {
  health: '/api/health',
  guestSession: '/api/session/guest',
  register: '/api/auth/register',
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  profile: '/api/profile',
  gazette: '/api/gazette',
  /** GET `${API.gazette}/:id` for a single issue. */
  gazetteIssue: '/api/gazette/:id',
  memory: '/api/memory',
  /** GET: persistent collective facts + the active Collective Reality rules (transparency). */
  world: '/api/world',
  /** Admin (Authorization: Bearer $ADMIN_TOKEN). GET reports?limit= */
  adminReports: '/api/admin/reports',
  /** Admin GET sanctions?active=1 ; POST { profileId, kind: 'chat_mute' | 'ban', minutes, reason } */
  adminSanctions: '/api/admin/sanctions',
  /** Admin DELETE a sanction. */
  adminSanction: '/api/admin/sanctions/:id',
  /** Admin POST { profileId | sessionId, reason } — disconnects the player now. */
  adminKick: '/api/admin/kick',
  /** Admin POST { periodStart?, periodEnd? } — compile a Gazette issue now. */
  adminGazetteCompile: '/api/admin/gazette/compile',
  /** Admin GET — players currently online. */
  adminPlayers: '/api/admin/players',
  /** GET (auth): the caller's blocked + muted profiles with names → RelationsResponse. */
  relations: '/api/profile/relations',
  /** Admin GET ?owner=&limit= — placed pieces (newest first) + totals. */
  adminBuildPieces: '/api/admin/build/pieces',
  /** Admin DELETE one piece (anything resting on it goes too). */
  adminBuildPiece: '/api/admin/build/pieces/:id',
  /** Admin DELETE every piece a profile owns. */
  adminBuildProfile: '/api/admin/build/profiles/:profileId',
  /** Admin GET — building stats (counts, timing of collision/validation, event-loop delay). */
  adminBuildStats: '/api/admin/build/stats',
} as const;

/** GET API.relations */
export interface RelationsResponse {
  blocked: RelationEntry[];
  muted: RelationEntry[];
}

/** All REST errors use this body with an appropriate HTTP status. */
export interface ApiError {
  error: { code: ErrorCode; message: string };
}

export interface HealthResponse {
  ok: true;
  version: string;
  uptimeSeconds: number;
  rooms: number;
  players: number;
  serverTime: number;
}

/** POST guestSession. Creates (or refreshes, if token given) a guest profile. */
export interface GuestSessionRequest {
  name?: string;
  appearance?: Appearance;
  /** Existing guest token to resume. */
  token?: string;
}
export interface SessionResponse {
  /** Bearer token for REST (Authorization: Bearer) and JoinOptions.token. */
  token: string;
  profile: ProfileSummary;
}

/** POST register. Optionally upgrades the guest identified by guestToken (keeps discoveries/history). */
export interface RegisterRequest {
  username: string;
  password: string;
  displayName: string;
  guestToken?: string;
}
export interface LoginRequest {
  username: string;
  password: string;
}
export type AuthResponse = SessionResponse;

/** GET profile (auth). */
export interface ProfileResponse {
  profile: ProfileSummary;
}
/** PUT profile (auth). */
export interface SaveProfileRequest {
  name?: string;
  appearance?: Appearance;
}

/** GET gazette?limit=&before= */
export interface GazetteListQuery {
  limit?: number;
  /** Issue id cursor. */
  before?: string;
}
export interface GazetteListResponse {
  issues: GazetteIssue[];
  nextCursor: string | null;
}
export interface GazetteIssueResponse {
  issue: GazetteIssue;
}

/** GET memory?limit=&before=&kind=&locationId=&profileId= */
export interface MemoryListQuery {
  limit?: number;
  before?: string;
  kind?: WorldEventKind;
  locationId?: LocationId;
  profileId?: string;
}
export interface MemoryListResponse {
  events: WorldEvent[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAnimState(v: unknown): v is AnimState {
  return typeof v === 'string' && (ANIM_STATES as readonly string[]).includes(v);
}
export function isLocomotionAnim(v: unknown): v is LocomotionAnim {
  return typeof v === 'string' && (LOCOMOTION_ANIMS as readonly string[]).includes(v);
}
export function isEmote(v: unknown): v is EmoteId {
  return typeof v === 'string' && (EMOTES as readonly string[]).includes(v);
}
export function isReaction(v: unknown): v is ReactionEmoji {
  return typeof v === 'string' && (REACTIONS as readonly string[]).includes(v);
}

/** Extract @mentions (by display name, spaces allowed via @"Mossy Heron" or @Mossy_Heron). */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /@"([^"]{2,20})"|@([\p{L}\p{N}._'-]{2,20})/gu;
  for (const m of text.matchAll(re)) {
    const name = (m[1] ?? m[2] ?? '').replace(/_/g, ' ').trim().toLowerCase();
    if (name) out.add(name);
  }
  return [...out];
}
