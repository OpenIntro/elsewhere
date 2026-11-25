/**
 * Gazette templates: headline + body variants per article type. Placeholders
 * are filled ONLY from recorded World Memory events (names, counts, times,
 * places). A variant is chosen deterministically from the source event ids,
 * so recompiling the same period yields the same text.
 *
 * Placeholders: {names} {name} {count} {stage} {place} {time} (mid-sentence) / {Time} (sentence start) {item} {voices}
 * {awakenings} {discovery} {milestone} {n}
 */
import type { GazetteSection } from '@elsewhere/shared';

export interface ArticleTemplate {
  id: string;
  section: GazetteSection;
  headlines: readonly string[];
  bodies: readonly string[];
}

export const TEMPLATES = {
  fountain_transformed: {
    id: 'fountain_transformed',
    section: 'front_page',
    headlines: ['The Fountain Changes', 'Something Stirs in the Town Square', 'Fountain Reaches Stage {stage}'],
    bodies: [
      '{Time}, the fountain in the Town Square shifted into its stage {stage} form. Residents credited: {names}.',
      'It took {count} touches from {n} different residents, but {time} the fountain changed into its stage {stage} form. Thanks go to {names}.',
    ],
  },
  portal_awakened: {
    id: 'portal_awakened',
    section: 'front_page',
    headlines: ['The Arch Awakens', 'Light at The Unknown', 'The Old Stones Answer'],
    bodies: [
      '{Time}, the dormant arch at The Unknown woke. Present at the stones: {names}. It has now woken {awakenings} time(s).',
      'Witnesses report the arch at The Unknown glowing {time}. {names} were at the rune stones when it happened.',
    ],
  },
  portal_awakened_first: {
    id: 'portal_awakened_first',
    section: 'front_page',
    headlines: ['For the First Time, the Arch Wakes', 'The Unknown Is Unknown No Longer'],
    bodies: ['No one had seen it before. {Time}, the arch at The Unknown woke for the very first time, with {names} standing at the stones.'],
  },
  bell_chorus: {
    id: 'bell_chorus',
    section: 'mysteries',
    headlines: ['The Bell Sings Back', 'A Strange Peal at Town Hall'],
    bodies: ['{Time}, {voices} people rang the Town Hall bell within moments of each other, and it answered in a voice nobody recognised. Ringers: {names}.'],
  },
  midnight_bell: {
    id: 'midnight_bell',
    section: 'mysteries',
    headlines: ['A Bell at Midnight', 'The Midnight Toll'],
    bodies: ['Right at midnight on world-day {n}, {name} rang the Town Hall bell. Those nearby say it sounded different.'],
  },
  secret_first: {
    id: 'secret_first',
    section: 'mysteries',
    headlines: ['A Discovery: the {discovery}', '{name} Finds Something Hidden'],
    bodies: ['{Time}, {name} became the first resident to find the {discovery} ({place}).'],
  },
  secrets_more: {
    id: 'secrets_more',
    section: 'mysteries',
    headlines: ['More Secrets Uncovered', 'The Island Gives Up Its Secrets'],
    bodies: ['{count} more discoveries were made this period, by {names}.'],
  },
  gathering: {
    id: 'gathering',
    section: 'town_news',
    headlines: ['A Crowd at {place}', '{place} Fills Up'],
    bodies: ['{Time}, {count} people gathered at {place}, among them {names}.'],
  },
  dance_party: {
    id: 'dance_party',
    section: 'town_news',
    headlines: ['Dancing at {place}', 'Impromptu Dance Party'],
    bodies: ['{Time}, {count} residents broke into dance at {place}: {names}.'],
  },
  residents: {
    id: 'residents',
    section: 'town_news',
    headlines: ['Resident Number {count}', 'The Island Grows'],
    bodies: ['{name} arrived {time} and became resident number {count}.'],
  },
  place_visits: {
    id: 'place_visits',
    section: 'town_news',
    headlines: ['{place}: A Favourite Spot', '{count} Visits to {place}'],
    bodies: ['{place} has now welcomed {count} daily visits from residents.'],
  },
  night_wanders: {
    id: 'night_wanders',
    section: 'mysteries',
    headlines: ['Night Walkers', 'Lanterns in the Woods'],
    bodies: ['Residents have now made {count} night-time trips into the Woods and The Unknown.'],
  },
  newcomers: {
    id: 'newcomers',
    section: 'comings_and_goings',
    headlines: ['New Faces', 'Welcome, Newcomers', 'Arrivals'],
    bodies: ['{count} new resident(s) arrived this period: {names}.', 'The ferry that never comes somehow brought {count} newcomer(s): {names}.'],
  },
  returning: {
    id: 'returning',
    section: 'comings_and_goings',
    headlines: ['Familiar Faces', 'Back Again'],
    bodies: ['{count} resident(s) returned to the island: {names}.'],
  },
  bell_rung: {
    id: 'bell_rung',
    section: 'small_moments',
    headlines: ['The Bell Rang', 'Ding'],
    bodies: ['The Town Hall bell was rung by {names}.'],
  },
  sat_together: {
    id: 'sat_together',
    section: 'small_moments',
    headlines: ['Sharing a Bench', 'Company'],
    bodies: ['{names} shared a bench at {place} {time}.'],
  },
  mail_sent: {
    id: 'mail_sent',
    section: 'small_moments',
    headlines: ['Notes Left Behind', 'The Post Box Is Busy'],
    bodies: ['{count} note(s) were left in island mailboxes, by {names}.'],
  },
  items: {
    id: 'items',
    section: 'small_moments',
    headlines: ['Finders, Keepers', 'Pockets Full'],
    bodies: ['{names} picked up something new: {item}.'],
  },
  fountain_touches: {
    id: 'fountain_touches',
    section: 'small_moments',
    headlines: ['Hands in the Water', 'At the Fountain'],
    bodies: ['{count} resident(s) touched the fountain this period: {names}.'],
  },
  first_build: {
    id: 'first_build',
    section: 'town_news',
    headlines: ['New Builders', 'Hammers Out', 'Someone Is Building'],
    bodies: ['{count} resident(s) placed their very first building piece this period: {names}.', 'Fresh sawdust on the island: {names} started building for the first time.'],
  },
  structure_roofed: {
    id: 'structure_roofed',
    section: 'town_news',
    headlines: ['A Roof Goes Up', '{name} Raises a Roof', 'Under a New Roof'],
    bodies: ['{Time}, {name} put the roof on a little structure of {count} walls, doorway included, near {place}.', 'Walls, a doorway and now a roof: {name} finished a building near {place} {time}.'],
  },
  build_pieces: {
    id: 'build_pieces',
    section: 'town_news',
    headlines: ['{count} Pieces and Counting', 'The Island Builds'],
    bodies: ['With a piece placed by {name} {time}, residents have now placed {count} building pieces on the island.'],
  },
  numbers: {
    id: 'numbers',
    section: 'by_the_numbers',
    headlines: ['By the Numbers'],
    bodies: ['{count} events recorded. {n}'],
  },
  quiet: {
    id: 'quiet',
    section: 'small_moments',
    headlines: ['A Quiet Stretch'],
    bodies: ['Not much happened this time. {count} small thing(s) were recorded, and the island kept its peace.'],
  },
} as const satisfies Record<string, ArticleTemplate>;

export type TemplateId = keyof typeof TEMPLATES;

export function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] !== undefined ? String(vars[k]) : ''));
}

/** Deterministic variant pick (FNV-1a over the seed). */
export function pick<T>(variants: readonly T[], seed: string): T {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return variants[(h >>> 0) % variants.length]!;
}

/** "Fern, Moth and Otter" */
export function joinNames(names: readonly string[], max = 5): string {
  const uniq = [...new Set(names)];
  if (uniq.length === 0) return 'someone';
  if (uniq.length > max) return `${uniq.slice(0, max).join(', ')} and ${uniq.length - max} others`;
  if (uniq.length === 1) return uniq[0]!;
  return `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`;
}
