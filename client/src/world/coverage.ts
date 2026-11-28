/** Which INTERACTABLES ids have a visible object (filled by the systems that draw them). */
import { INTERACTABLES } from '@elsewhere/shared';

export const represented = new Set<string>();

export function markRepresented(ids: Iterable<string>): void {
  for (const id of ids) represented.add(id);
}

export function coverageReport(): { total: number; missing: string[] } {
  const missing = INTERACTABLES.filter((i) => !represented.has(i.id)).map((i) => i.id);
  return { total: INTERACTABLES.length, missing };
}
