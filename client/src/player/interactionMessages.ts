/**
 * Friendly, in-world wording for interaction failures (pure; unit tested).
 * Returns null when the failure should stay quiet (not implemented yet, rate
 * limits, or cases the controller handles itself such as a first too_far).
 */
import type { ErrorCode, InteractableKind } from '@elsewhere/shared';

export interface InteractNotice {
  level: 'info' | 'warning';
  text: string;
  ttlMs: number;
}

const info = (text: string, ttlMs = 2600): InteractNotice => ({ level: 'info', text, ttlMs });

export function interactErrorNotice(code: ErrorCode | undefined, kind?: InteractableKind, name?: string): InteractNotice | null {
  const thing = name ? name.toLowerCase().replace(/^the /, '') : 'that';
  switch (code) {
    case undefined:
    case 'not_implemented':
    case 'rate_limited':
      return null;
    case 'occupied':
      if (kind === 'bench' || kind === 'chair') return info('That seat’s taken — maybe there’s room nearby.');
      if (kind === 'pickup') return info('Someone got to it first.');
      return info(`Someone else is using the ${thing}.`);
    case 'cooldown':
      if (kind === 'bell') return info('The bell is still humming. Give it a moment.', 2200);
      if (kind === 'streetlight' || kind === 'lantern') return info('The lamp needs a moment.', 2000);
      if (kind === 'door') return info('The door is still swinging.', 2000);
      return info('Give it a moment.', 2000);
    case 'too_far':
      return info('A little closer…', 1800);
    case 'blocked':
      return info('That isn’t possible with them.');
    case 'forbidden':
      if (kind === 'door') return info('It’s locked.');
      if (kind === 'bench' || kind === 'chair') return info('You can’t sit there right now.');
      return info('That can’t be used right now.');
    case 'not_found':
      return info('Hm — it isn’t there any more.');
    default:
      return info('Nothing seems to happen. Try again in a moment.');
  }
}
