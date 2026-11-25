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
  } satisfies Record<string, RateLimitRule>,

  clock: {
    /** Real minutes per in-world day (override with DAY_LENGTH_MINUTES on the server). */
    dayLengthMinutes: 48,
    /** Time-of-day (0..1, 0 = midnight) at the world epoch. 0.3 = 07:12. */
    startTimeOfDay: 0.3,
  },

  collective: {
    /** Unique players who must examine/touch the fountain for each transformation stage. */
    fountainStages: [5, 15, 40] as readonly number[],
    /** Number of distinct players who must each hold a rune stone at the same time. */
    portalRunesRequired: 3,
    /** All runes must be activated within this window. */
    portalWindowMs: 20_000,
    /** How long the portal stays awake once woken. */
    portalAwakeMs: 10 * 60 * 1000,
    /** Players simultaneously in one location that counts as a "gathering" event. */
    gatheringThreshold: 6,
  },

  gazette: {
    /** A new issue is compiled this often (real time). */
    issueIntervalMs: 6 * 60 * 60 * 1000,
    maxArticlesPerIssue: 8,
  },

  profile: {
    displayNameMin: 2,
    displayNameMax: 20,
  },
} as const;

export type Config = typeof CONFIG;
export type RateLimitAction = keyof typeof CONFIG.rateLimits;

/** Default listening port; override with PORT env. */
export const DEFAULT_PORT = 2567;
