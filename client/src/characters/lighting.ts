/**
 * Keeps the shared toy materials readable across the day/night cycle.
 * Reads the world clock (read-only) once per frame; the dev gallery can
 * override the night amount.
 */
import { daylight, timeOfDayAt } from '@elsewhere/shared';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { setToyNight } from './materials.js';

let override: number | null = null;
let lastStamp = -1;

/** Force a night amount (0 day … 1 night); null = follow the world clock. */
export function setCharacterNight(n: number | null) {
  override = n;
  lastStamp = -1;
}

/** Called from every Character's useFrame; does real work once per frame. */
export function tickToyLighting(frameStamp: number) {
  if (frameStamp === lastStamp) return;
  lastStamp = frameStamp;
  if (override !== null) {
    setToyNight(override);
    return;
  }
  const g = useGameStore.getState();
  if (!g.sessionId) {
    setToyNight(0);
    return;
  }
  const { epochMs, dayLengthMs } = g.clock;
  const light = daylight(timeOfDayAt(serverNow(), { epochMs, dayLengthMs }));
  setToyNight(1 - light);
}
