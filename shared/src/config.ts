/**
 * Gameplay tunables shared by client and server. Server is authoritative: the
 * client uses these for prediction/UX, the server for validation/enforcement.
 * Change values here, never hard-code duplicates elsewhere.
 */

export interface RateLimitRule {
  /** Max burst (bucket capacity). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSecond: number;
}

export const CONFIG = {
  /** Protocol version; bump on breaking wire changes. Sent in join options. */
  protocolVersion: 1,

  movement: {
    walkSpeed: 3.2,
    runSpeed: 6.0,
    /** Collision radius of a player character. */
    playerRadius: 0.4,
    /** Client sends position this many times per second while moving. */
    sendRateHz: 15,
    /** Server tolerance multiplier on max speed (latency jitter). */
    speedTolerance: 1.35,
    /** Extra metres of slack allowed per move message. */
    distanceSlack: 0.6,
    /** If server-resolved position differs from claimed by more than this, a correction is sent. */
    correctionThreshold: 0.35,
    /** Turn-rate for character facing smoothing (rad/s), client-side visual only. */
    turnSpeed: 12,
  },

  network: {
    /** Server simulation tick (Hz). */
    tickRateHz: 20,
    /** Schema patch rate (Hz). */
    patchRateHz: 20,
    /** Remote players are rendered this far in the past for smooth interpolation (ms). */
    interpolationDelayMs: 120,
    maxClientsPerRoom: 50,
    /** Seconds a dropped client may reconnect into its old seat. */
    reconnectGraceSeconds: 20,
  },

  chat: {
    maxMessageLength: 240,
    proximityRadius: 18,
    /** Speech bubbles linger this long client-side. */
    bubbleDurationMs: 6000,
    historyLength: 100,
  },

  interaction: {
    /** Default max distance between player and interactable (server enforced with slack). */
    radius: 2.4,
    serverSlack: 0.75,
    bellCooldownMs: 4000,
    lightToggleCooldownMs: 600,
    doorAutoCloseMs: 12000,
    pickupRespawnMs: 5 * 60 * 1000,
    mailMaxLength: 400,
    maxHeldItems: 1,
  },

  emotes: {
    waveDurationMs: 1800,
    interactDurationMs: 900,
    reactionDurationMs: 2500,
  },

  rateLimits: {
    move: { capacity: 40, refillPerSecond: 25 },
    chat: { capacity: 5, refillPerSecond: 0.5 },
    whisper: { capacity: 5, refillPerSecond: 0.5 },
    emote: { capacity: 4, refillPerSecond: 1 },
    reaction: { capacity: 6, refillPerSecond: 1.5 },
    interact: { capacity: 8, refillPerSecond: 3 },
    appearance: { capacity: 3, refillPerSecond: 0.2 },
    report: { capacity: 3, refillPerSecond: 1 / 60 },
    mail: { capacity: 2, refillPerSecond: 1 / 30 },
    rest: { capacity: 30, refillPerSecond: 5 },
    /** Auth endpoints (register/login/guest session), per IP. */
    auth: { capacity: 10, refillPerSecond: 0.2 },
    /** Reading a mailbox / misc cheap requests. */
    mailRead: { capacity: 6, refillPerSecond: 1 },
    /** Block/mute/unblock/unmute. */
    social: { capacity: 10, refillPerSecond: 0.5 },
    typing: { capacity: 10, refillPerSecond: 2 },
    stand: { capacity: 6, refillPerSecond: 2 },
    /** Build place/remove (server keys it per PROFILE; env BUILD_RATE_CAPACITY / BUILD_RATE_PER_SECOND). */
    build: { capacity: 8, refillPerSecond: 2 },
    /** "Unstuck" teleport to the Town Square. */
    unstuck: { capacity: 1, refillPerSecond: 1 / 30 },
  } satisfies Record<string, RateLimitRule>,

  clock: {
    /** Real minutes per in-world day (override with DAY_LENGTH_MINUTES on the server). */
    dayLengthMinutes: 48,
    /** Time-of-day (0..1, 0 = midnight) at the world epoch. 0.3 = 07:12. */
    startTimeOfDay: 0.3,
  },

  collective: {
    /**
     * Fountain contributions needed for each transformation stage. A contribution is one
     * touch by one profile per in-world day (repeat touches the same world-day never count).
     * Server override: FOUNTAIN_STAGES="5,15,40".
     */
    fountainStages: [5, 15, 40] as readonly number[],
    /** Minimum DISTINCT profiles that must have contributed for each stage (same length as fountainStages). Server override: FOUNTAIN_STAGE_DISTINCT. */
    fountainStageDistinct: [3, 8, 20] as readonly number[],
    /**
     * Number of distinct players who must each light a different rune stone at the same time
     * (2 so the secret is discoverable by two people; there are 3 stones). Server override: PORTAL_RUNES_REQUIRED.
     */
    portalRunesRequired: 2,
    /** All runes must be activated within this window. */
    portalWindowMs: 20_000,
    /** How long the portal stays awake once woken. */
    portalAwakeMs: 10 * 60 * 1000,
    /** Players simultaneously in one location that counts as a "gathering" event. */
    gatheringThreshold: 6,
    /** A location records at most one gathering per this window. */
    gatheringCooldownMs: 30 * 60 * 1000,
    /** Players dancing together in one location that count as a dance party. */
    danceThreshold: 3,
    /** Distinct players ringing the bell within bellChorusWindowMs → the bell answers differently. Server override: BELL_CHORUS_PLAYERS. */
    bellChorusPlayers: 3,
    bellChorusWindowMs: 8_000,
    bellChorusCooldownMs: 2 * 60 * 1000,
    /** Half-width (fraction of a day) of the world-midnight window for time-based secrets (0.015 ≈ ±22 world minutes). */
    midnightWindow: 0.015,
    /** Distinct residents (profiles that ever joined) at which a milestone is recorded. */
    residentMilestones: [1, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as readonly number[],
    /** Daily-unique visits to one location at which a "popular place" milestone is recorded. */
    placeVisitMilestones: [10, 50, 150, 500, 1500] as readonly number[],
    /** Daily-unique night-time visits to the Woods / The Unknown at which a milestone is recorded. */
    nightWanderMilestones: [3, 10, 30, 100] as readonly number[],
  },

  moderation: {
    /** Rate-limit rejections (any chat-ish action) within abuseWindowMs before an automatic chat mute. */
    abuseStrikes: 8,
    abuseWindowMs: 60_000,
    autoMuteMs: 5 * 60 * 1000,
    /** Identical messages from one player within duplicateWindowMs beyond this count are dropped. */
    maxDuplicateMessages: 2,
    duplicateWindowMs: 30_000,
    /** Recent chat lines kept per room for report evidence. */
    evidenceLines: 20,
  },

  auth: {
    usernameMin: 3,
    usernameMax: 24,
    passwordMin: 8,
    passwordMax: 128,
    guestSessionDays: 365,
    accountSessionDays: 90,
  },

  gazette: {
    /** A new issue is compiled this often (real time). */
    issueIntervalMs: 6 * 60 * 60 * 1000,
    maxArticlesPerIssue: 8,
    /** An issue needs at least this many events in its period; otherwise no issue is published. */
    minEventsForIssue: 1,
    /**
     * Young world: until the FIRST issue exists, it is compiled earlyIssueDelayMs after this many
     * significant (significance >= 1) real events have been recorded, instead of waiting a full
     * interval. Server overrides: GAZETTE_EARLY_EVENTS, GAZETTE_EARLY_DELAY_SECONDS.
     */
    earlyIssueSignificantEvents: 3,
    earlyIssueDelayMs: 60_000,
  },

  profile: {
    displayNameMin: 2,
    displayNameMax: 20,
  },

  /** Player building (shared/src/building.ts is the rulebook; the server enforces, the client previews). */
  building: {
    /** Positions must be multiples of this (metres). Structural pieces snap to 1 m in the UI. */
    grid: 0.5,
    /** Height of one storey (walls, pillars, doorways). */
    storeyHeight: 2.6,
    /** Highest level index (0 = ground). Walls go up to maxLevel - 1, roofs up to maxLevel. */
    maxLevel: 3,
    /** Max distance from the builder to the piece centre (server override BUILD_RANGE). */
    range: 9,
    /** Pieces one profile may own at once (BUILD_MAX_PER_PLAYER). */
    maxPiecesPerPlayer: 400,
    /** Pieces in one world (BUILD_MAX_PER_WORLD). */
    maxPiecesPerWorld: 6000,
    /** Max terrain height difference under one ground-level piece. */
    maxSlope: 0.5,
    /** Sign text length (after sanitizing). */
    signMaxLength: 40,
    /** Pieces per S2C.buildSnapshot chunk. */
    snapshotChunk: 500,
    /** World milestones (pieces ever placed) recorded in World Memory. */
    milestones: [10, 100, 500, 1000, 2500, 5000, 10000] as readonly number[],
  },
} as const;

export type Config = typeof CONFIG;
export type RateLimitAction = keyof typeof CONFIG.rateLimits;

/** Default listening port; override with PORT env. */
export const DEFAULT_PORT = 2567;
