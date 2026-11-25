/**
 * Pure formatting helpers: world clock, phases, relative times, World Memory
 * event sentences. No DOM; unit-tested.
 */
import {
  DISCOVERIES,
  ITEMS,
  LOCATIONS,
  formatClock,
  worldTimeAt,
  type DayPhase,
  type DiscoveryId,
  type ItemId,
  type WorldEvent,
  type WorldTime,
} from '@elsewhere/shared';

export const PHASE_LABEL: Readonly<Record<DayPhase, string>> = {
  morning: 'Morning',
  midday: 'Midday',
  golden_hour: 'Golden hour',
  dusk: 'Dusk',
  night: 'Night',
};

export function phaseLabel(phase: DayPhase): string {
  return PHASE_LABEL[phase];
}

/** "07:12" (24h) or "7:12 am" (12h). */
export function formatWorldClock(t: WorldTime, style: '24h' | '12h' = '24h'): string {
  if (style === '24h') return formatClock(t);
  const h24 = Math.floor(t.hours) % 24;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(t.minutes).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** In-world calendar: day 0 is the island's first day → "Day 1". */
export function worldDayLabel(day: number): string {
  return `Day ${Math.max(0, day) + 1}`;
}

/** A real timestamp expressed in world time, e.g. "Day 12 · Golden hour". */
export function worldDateAt(ts: number, clock: { epochMs: number; dayLengthMs: number }): string {
  const wt = worldTimeAt(ts, clock);
  return `${worldDayLabel(wt.day)} · ${phaseLabel(wt.phase)}`;
}

/** Short local wall-clock time "14:05" for chat timestamps. */
export function formatChatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "3 days ago", then a date. */
export function formatRelative(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "March 2026" style label for "resident since". */
export function formatMonthYear(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

const locName = (id?: string) => LOCATIONS.find((l) => l.id === id)?.name;

function names(e: WorldEvent): string {
  const list = e.actors.map((a) => a.name);
  if (list.length === 0) return 'Someone';
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  if (list.length <= 4) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, 3).join(', ')} and ${list.length - 3} others`;
}

function num(e: WorldEvent, key: string): number | undefined {
  const v = e.data?.[key];
  return typeof v === 'number' ? v : undefined;
}
function str(e: WorldEvent, key: string): string | undefined {
  const v = e.data?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** One plain sentence for a World Memory event. Built only from recorded fields. */
export function describeEvent(e: WorldEvent): string {
  const who = names(e);
  const at = locName(e.locationId);
  const where = at ? ` at ${at}` : '';
  switch (e.kind) {
    case 'player_first_visit':
      return `${who} arrived on the island for the first time.`;
    case 'player_returned':
      return `${who} returned to the island.`;
    case 'bell_rung':
      return `${who} rang the Town Hall bell.`;
    case 'bell_chorus':
      return `${who} rang the bell together, and it answered in a different voice.`;
    case 'fountain_touched':
      return `${who} examined the fountain.`;
    case 'fountain_transformed': {
      const stage = num(e, 'stage');
      return `The fountain changed${stage !== undefined ? ` (stage ${stage})` : ''}, with help from ${who}.`;
    }
    case 'portal_rune_touched':
      return `${who} touched a rune stone${where}.`;
    case 'portal_awakened':
      return `${who} woke the arch at The Unknown.`;
    case 'portal_slept':
      return `The arch at The Unknown fell quiet again.`;
    case 'secret_found': {
      const id = str(e, 'discoveryId') as DiscoveryId | undefined;
      const def = id ? DISCOVERIES[id] : undefined;
      return def ? `${who} found the ${def.name}${where}.` : `${who} found something hidden${where}.`;
    }
    case 'item_picked_up': {
      const id = str(e, 'itemId') as ItemId | undefined;
      const def = id ? ITEMS[id] : undefined;
      return `${who} picked up ${def ? `a ${def.name.toLowerCase()}` : 'something'}${where}.`;
    }
    case 'item_dropped': {
      const id = str(e, 'itemId') as ItemId | undefined;
      const def = id ? ITEMS[id] : undefined;
      return `${who} set down ${def ? `a ${def.name.toLowerCase()}` : 'something'}${where}.`;
    }
    case 'light_toggled':
      return `${who} ${e.data?.on === false ? 'put out' : 'lit'} a light${where}.`;
    case 'door_opened':
      return `${who} opened a door${where}.`;
    case 'sign_read':
      return `${who} stopped to read a sign${where}.`;
    case 'mail_sent':
      return `${who} left a note in a mailbox${where}.`;
    case 'gathering': {
      const n = num(e, 'count');
      return `${n ? `${n} people` : who} gathered${where || ' together'}.`;
    }
    case 'dance_party':
      return `${who} danced together${where}.`;
    case 'sat_together':
      return `${who} sat together${where}.`;
    case 'milestone': {
      const label = str(e, 'label');
      return label ? `Milestone: ${label}.` : `The island reached a milestone.`;
    }
    default:
      return `${who} left a mark on the island${where}.`;
  }
}
