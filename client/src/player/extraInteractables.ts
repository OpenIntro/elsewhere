/**
 * Interactables that are not world data (player-built seats): a source the
 * build system registers; targeting (E / prompt / touch button) and click
 * picking consult it next to INTERACTABLES.
 */
import type { Interactable } from '@elsewhere/shared';

type Source = (x: number, z: number, radius: number) => readonly Interactable[];
let source: Source | null = null;
const EMPTY: readonly Interactable[] = [];

export function setExtraInteractables(fn: Source | null): void {
  source = fn;
}
export function extraInteractables(x: number, z: number, radius: number): readonly Interactable[] {
  return source ? source(x, z, radius) : EMPTY;
}
