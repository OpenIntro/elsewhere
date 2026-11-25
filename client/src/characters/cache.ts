/**
 * Ref-counted cache of built character geometries keyed by appearance, so
 * identical outfits share one geometry and unused ones are disposed.
 */
import type { Appearance } from '@elsewhere/shared';
import { appearanceKey, buildCharacter, type BuiltCharacter } from './build.js';

interface Entry {
  built: BuiltCharacter;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
const DISPOSE_DELAY_MS = 4000;

function scheduleCheck(key: string, e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    if (e.refs <= 0 && entries.get(key) === e) {
      entries.delete(key);
      e.built.geometry.dispose();
    }
  }, DISPOSE_DELAY_MS);
}

/** Get (building if needed) without taking a reference; pair with retain/release in an effect. */
export function getCharacter(a: Appearance): { key: string; built: BuiltCharacter } {
  const key = appearanceKey(a);
  let e = entries.get(key);
  if (!e) {
    e = { built: buildCharacter(a), refs: 0, timer: null };
    entries.set(key, e);
    scheduleCheck(key, e);
  }
  return { key, built: e.built };
}

export function retainCharacter(key: string) {
  const e = entries.get(key);
  if (!e) return;
  e.refs++;
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
}

export function releaseCharacter(key: string) {
  const e = entries.get(key);
  if (!e) return;
  e.refs--;
  if (e.refs <= 0) scheduleCheck(key, e);
}

export function characterCacheStats() {
  let verts = 0;
  for (const e of entries.values()) verts += e.built.vertexCount;
  return { geometries: entries.size, vertices: verts };
}
