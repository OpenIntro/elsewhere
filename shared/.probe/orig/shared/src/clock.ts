/**
 * Synchronized world clock. Everyone derives the same time-of-day from the
 * server's epoch (ms since unix epoch, persisted so the world keeps its time
 * across restarts) and the day length. Clients correct for clock skew with an
 * offset measured at join (see `welcome.serverTime`).
 */
import { CONFIG } from './config.js';
import { TAU } from './math.js';

export type DayPhase = 'night' | 'morning' | 'midday' | 'golden_hour' | 'dusk';

export interface ClockParams {
  /** Real-time ms at which day 0 started (at `startTimeOfDay`). */
  epochMs: number;
  /** Real ms per in-world day. */
  dayLengthMs: number;
  /** Time-of-day at the epoch, 0..1 (0 = midnight). */
  startTimeOfDay?: number;
}

export interface WorldTime {
  /** Whole in-world days elapsed since the epoch. */
  day: number;
  /** Continuous 0..1 within the day (0 = midnight, 0.5 = noon). */
  timeOfDay: number;
  /** 0..24 in-world hours. */
  hours: number;
  /** In-world minute within the hour (0..59). */
  minutes: number;
  phase: DayPhase;
  /** 0..1 progress through the current phase (useful for blending). */
  phaseProgress: number;
}

/** Phase boundaries in in-world hours [start, end). Night wraps midnight. */
export const PHASE_HOURS: Readonly<Record<DayPhase, readonly [number, number]>> = {
  morning: [5, 10],
  midday: [10, 16],
  golden_hour: [16, 19],
  dusk: [19, 21],
  night: [21, 29], // 21:00 → 05:00 next day
};

export const PHASE_ORDER: readonly DayPhase[] = ['morning', 'midday', 'golden_hour', 'dusk', 'night'];

export function defaultDayLengthMs(): number {
  return CONFIG.clock.dayLengthMinutes * 60_000;
}

export function timeOfDayAt(nowMs: number, params: ClockParams): number {
  const start = params.startTimeOfDay ?? CONFIG.clock.startTimeOfDay;
  const elapsed = (nowMs - params.epochMs) / params.dayLengthMs + start;
  return elapsed - Math.floor(elapsed);
}

export function phaseForHours(hours: number): { phase: DayPhase; progress: number } {
  const h = ((hours % 24) + 24) % 24;
  for (const phase of PHASE_ORDER) {
    const [s, e] = PHASE_HOURS[phase];
    const hh = phase === 'night' && h < 5 ? h + 24 : h;
    if (hh >= s && hh < e) return { phase, progress: (hh - s) / (e - s) };
  }
  return { phase: 'night', progress: 0 };
}

export function worldTimeAt(nowMs: number, params: ClockParams): WorldTime {
  const start = params.startTimeOfDay ?? CONFIG.clock.startTimeOfDay;
  const elapsedDays = (nowMs - params.epochMs) / params.dayLengthMs + start;
  const day = Math.floor(elapsedDays);
  const timeOfDay = elapsedDays - day;
  const hours = timeOfDay * 24;
  const { phase, progress } = phaseForHours(hours);
  return { day, timeOfDay, hours, minutes: Math.floor((hours % 1) * 60), phase, phaseProgress: progress };
}

/**
 * Sun position for lighting: elevation in radians (negative = below horizon)
 * and azimuth (yaw, radians). Sun rises in the east (+X) at 06:00, sets west at 18:00.
 */
export function sunAngles(timeOfDay: number): { elevation: number; azimuth: number } {
  const a = (timeOfDay - 0.25) * TAU; // 0 at sunrise
  return { elevation: Math.sin(a) * (Math.PI / 2.6), azimuth: Math.PI / 2 - a * 0.5 };
}

/** 0 at deep night, 1 at noon: smooth daylight factor for blending light/fog colours. */
export function daylight(timeOfDay: number): number {
  const s = Math.sin((timeOfDay - 0.25) * TAU);
  return Math.max(0, Math.min(1, s * 1.4 + 0.25));
}

/** Format as "07:12". */
export function formatClock(t: WorldTime): string {
  const h = Math.floor(t.hours) % 24;
  return `${String(h).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}`;
}

/** Streetlights/lanterns default to on during these phases (object state may override). */
export function lightsShouldBeOn(phase: DayPhase): boolean {
  return phase === 'dusk' || phase === 'night';
}
