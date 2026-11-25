/**
 * Building activities: the rulebook shared by client (UI, visuals) and server
 * (validation, simulation). Rules are DATA here; the server enforces them.
 *
 *  - Stations: things you use inside a building (piano, notice board, poll,
 *    workbenches, hearth, kettle, guest books, nets…). Each is an interactable
 *    of kind 'station' (interactables.ts) placed on an interior anchor.
 *  - Keepers: one per public building. They are WORLD characters, not players:
 *    never in `players`, never counted online, never chatting as a player,
 *    never credited in World Memory. Their state is simulated by the server
 *    and synced in `state.keepers`.
 *  - Opening hours follow the shared world clock.
 *  - Daily rotations (café special, store curiosities, town poll) are pure
 *    functions of the world day, so every client and the server agree.
 *  - The Workshop project sequence: each completed project makes a permanent
 *    change outside.
 *
 * Synced activity state lives in `state.activities` (ActivityStateView, see
 * protocol.ts) keyed by the ACTIVITY_KEYS below.
 */
import type { Appearance } from './appearance.js';
import { hashString } from './math.js';
import type { ItemId } from './world/items.js';

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export type StationKind =
  | 'piano'
  | 'shelf'
  | 'mirror'
  | 'notices'
  | 'poll'
  | 'work'
  | 'project'
  | 'hearth'
  | 'kettle'
  | 'guestbook'
  | 'nets';

export interface StationDef {
  id: string;
  kind: StationKind;
  interiorId: string;
  /** Interior anchor the user stands at. */
  anchor: string;
  /** The interactable sits this far in front of the anchor (towards what it faces). */
  toward: number;
  name: string;
  prompt: string;
  radius: number;
  /** Workshop work stations: what kind of work (sound + animation flavour). */
  tool?: 'saw' | 'hammer' | 'kiln';
  /** Guest books / boards: the board id their entries are stored under. */
  board?: string;
}

export const STATIONS: readonly StationDef[] = [
  // Café
  { id: 'station_cafe_piano', kind: 'piano', interiorId: 'cafe', anchor: 'piano', toward: 0.75, name: 'Upright piano', prompt: 'Play the piano', radius: 2.2 },
  // General Store
  { id: 'station_store_shelf', kind: 'shelf', interiorId: 'general_store', anchor: 'display', toward: 0.7, name: 'Curiosity table', prompt: 'Browse the curiosities', radius: 2.2 },
  { id: 'station_store_mirror', kind: 'mirror', interiorId: 'general_store', anchor: 'mirror', toward: 0.55, name: 'Try-on mirror', prompt: 'Try things on', radius: 1.9 },
  // Town Hall
  { id: 'station_hall_notices', kind: 'notices', interiorId: 'town_hall', anchor: 'notice_board', toward: 0.6, name: 'Notice board', prompt: 'Read the notices', radius: 2.2, board: 'hall_notices' },
  { id: 'station_hall_poll', kind: 'poll', interiorId: 'town_hall', anchor: 'meeting_table', toward: 0.9, name: 'Ballot box', prompt: 'Vote in the town poll', radius: 2.2 },
  // Workshop
  { id: 'station_workshop_lumber', kind: 'work', interiorId: 'workshop', anchor: 'lumber_rack', toward: 0.5, name: 'Lumber rack', prompt: 'Cut timber for the project', radius: 2.0, tool: 'saw' },
  { id: 'station_workshop_anvil', kind: 'work', interiorId: 'workshop', anchor: 'anvil', toward: 0.5, name: 'Anvil', prompt: 'Hammer fittings for the project', radius: 1.9, tool: 'hammer' },
  { id: 'station_workshop_kiln', kind: 'work', interiorId: 'workshop', anchor: 'kiln', toward: 0.55, name: 'Kiln', prompt: 'Fire glass for the project', radius: 2.0, tool: 'kiln' },
  { id: 'station_workshop_project', kind: 'project', interiorId: 'workshop', anchor: 'sawhorses', toward: 0.6, name: 'Town project', prompt: 'See the town project', radius: 2.2 },
  // Homes
  ...([1, 2] as const).flatMap((n): StationDef[] => [
    { id: `station_house_${n}_hearth`, kind: 'hearth', interiorId: `house_${n}`, anchor: 'hearth', toward: 0.5, name: 'Hearth', prompt: 'Light the hearth', radius: 1.9 },
    { id: `station_house_${n}_kettle`, kind: 'kettle', interiorId: `house_${n}`, anchor: 'kitchen', toward: 0.5, name: 'Kettle', prompt: 'Put the kettle on', radius: 1.8 },
    { id: `station_house_${n}_guestbook`, kind: 'guestbook', interiorId: `house_${n}`, anchor: 'table', toward: 0.55, name: 'Guest book', prompt: 'Sign the guest book', radius: 1.9, board: `book_house_${n}` },
  ]),
  // Boathouse
  { id: 'station_boathouse_nets', kind: 'nets', interiorId: 'boathouse', anchor: 'nets', toward: 0.5, name: 'Fishing nets', prompt: 'Mend the nets', radius: 1.9 },
  { id: 'station_boathouse_log', kind: 'guestbook', interiorId: 'boathouse', anchor: 'workbench', toward: 0.5, name: 'Tide log', prompt: 'Write in the tide log', radius: 1.9, board: 'book_boathouse' },
];

const STATION_BY_ID = new Map(STATIONS.map((s) => [s.id, s]));
export function getStation(id: string): StationDef | undefined {
  return STATION_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Opening hours (world hours, shared clock)
// ---------------------------------------------------------------------------

export const OPENING_HOURS: Readonly<Record<string, readonly [number, number]>> = {
  cafe: [6.5, 22],
  general_store: [8, 19],
  town_hall: [8, 20],
  workshop: [7, 19],
};

/** Whether a public building is staffed right now (homes / boathouse: always "open", no keeper). */
export function isOpenAt(buildingId: string, hours: number): boolean {
  const h = OPENING_HOURS[buildingId];
  if (!h) return true;
  const x = ((hours % 24) + 24) % 24;
  return x >= h[0] && x < h[1];
}

export function formatHour(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Keepers (world characters — never players)
// ---------------------------------------------------------------------------

export interface KeeperStop {
  /** Interior anchor, or a local point [x, z] in the building frame. */
  anchor?: string;
  at?: readonly [number, number];
  /** Facing target (local point); defaults to the anchor's facing. */
  face?: readonly [number, number];
  /** What the keeper is doing there (shown in the dialog, e.g. "steaming milk"). */
  task: string;
  /** Dwell range (real seconds). */
  dwell: readonly [number, number];
  /** Play the 'interact' (hands busy) animation while here. */
  busy?: boolean;
}

export interface KeeperDef {
  id: string;
  /** Interactable id used to talk to the keeper. */
  interactableId: string;
  name: string;
  /** Short role shown on the tag ("Barista"). */
  role: string;
  interiorId: string;
  /** Where players stand to talk (an anchor on the customer side). */
  talkAnchor: string;
  talkToward: number;
  talkRadius: number;
  appearance: Appearance;
  /** Cyclic route; consecutive stops (and last → first) are straight, collision-free walks (tested). */
  route: readonly KeeperStop[];
}

const look = (a: Partial<Appearance> & Pick<Appearance, 'body' | 'skin' | 'hairStyle' | 'hairColor' | 'face' | 'shirtStyle' | 'shirtColor'>, acc: Partial<Appearance['accessories']> = {}): Appearance => ({
  pantsStyle: 'trousers',
  pantsColor: 'charcoal',
  shoeStyle: 'boots',
  shoeColor: 'charcoal',
  ...a,
  accessories: { hat: 'none', eyewear: 'none', neck: 'none', back: 'none', ...acc },
});

export const KEEPERS: readonly KeeperDef[] = [
  {
    id: 'keeper_barista',
    interactableId: 'keeper_barista',
    name: 'Mara',
    role: 'Barista',
    interiorId: 'cafe',
    talkAnchor: 'counter',
    talkToward: 0.2,
    talkRadius: 2.4,
    appearance: look({ body: 'round', skin: 'honey', hairStyle: 'bun', hairColor: 'auburn', face: 'smile', shirtStyle: 'overalls', shirtColor: 'sage', pantsColor: 'oat' }, { neck: 'scarf' }),
    route: [
      { anchor: 'barista', task: 'wiping the counter', dwell: [10, 22], busy: true },
      { anchor: 'espresso', task: 'pulling a shot', dwell: [8, 16], busy: true },
      { at: [3.6, -3.25], face: [3.6, -3.9], task: 'straightening the cups', dwell: [6, 12], busy: true },
    ],
  },
  {
    id: 'keeper_shopkeeper',
    interactableId: 'keeper_shopkeeper',
    name: 'Odile',
    role: 'Shopkeeper',
    interiorId: 'general_store',
    talkAnchor: 'counter',
    talkToward: 0.2,
    talkRadius: 2.4,
    appearance: look({ body: 'tall', skin: 'cocoa', hairStyle: 'curly', hairColor: 'ash', face: 'calm', shirtStyle: 'sweater', shirtColor: 'mustard', pantsColor: 'olive' }, { eyewear: 'round' }),
    route: [
      { anchor: 'shopkeeper', task: 'tallying the ledger', dwell: [12, 24], busy: true },
      { at: [3.9, -3.0], face: [3.9, -3.9], task: 'sorting the back shelf', dwell: [8, 14], busy: true },
      { at: [0.35, -2.9], face: [0.35, -3.9], task: 'dusting jars', dwell: [6, 12], busy: true },
    ],
  },
  {
    id: 'keeper_clerk',
    interactableId: 'keeper_clerk',
    name: 'Ferris',
    role: 'Archivist',
    interiorId: 'town_hall',
    talkAnchor: 'clerk_desk',
    talkToward: 0,
    talkRadius: 2.6,
    appearance: look({ body: 'small', skin: 'peach', hairStyle: 'swoop', hairColor: 'snow', face: 'sleepy', shirtStyle: 'jacket', shirtColor: 'plum', pantsColor: 'slate' }, { eyewear: 'monocle', neck: 'bowtie' }),
    route: [
      { anchor: 'archive', task: 'filing the day’s records', dwell: [12, 22], busy: true },
      { anchor: 'archive_shelves', task: 'reshelving ledgers', dwell: [10, 18], busy: true },
      { at: [-4.6, -2.1], face: [-3.4, -1.4], task: 'keeping an eye on the hall', dwell: [8, 14] },
    ],
  },
  {
    id: 'keeper_tinkerer',
    interactableId: 'keeper_tinkerer',
    name: 'Bram',
    role: 'Tinkerer',
    interiorId: 'workshop',
    talkAnchor: 'tool_wall',
    talkToward: -0.2,
    talkRadius: 2.4,
    appearance: look({ body: 'sturdy', skin: 'umber', hairStyle: 'buzz', hairColor: 'ink', face: 'grin', shirtStyle: 'overalls', shirtColor: 'rust', pantsColor: 'charcoal' }, { hat: 'cap' }),
    route: [
      { anchor: 'tool_wall', task: 'sharpening chisels', dwell: [10, 20], busy: true },
      { at: [-0.6, -1.0], face: [2.9, 2.75], task: 'eyeing the project', dwell: [6, 12] },
      { anchor: 'workbench_1', task: 'planing a board', dwell: [10, 20], busy: true },
      { at: [-1.0, -0.4], face: [-2.6, 1.85], task: 'checking the old boat frame', dwell: [5, 10] },
    ],
  },
];

const KEEPER_BY_ID = new Map(KEEPERS.map((k) => [k.id, k]));
export function getKeeper(id: string): KeeperDef | undefined {
  return KEEPER_BY_ID.get(id);
}
export function keeperForInterior(interiorId: string): KeeperDef | undefined {
  return KEEPERS.find((k) => k.interiorId === interiorId);
}
export const KEEPER_WALK_SPEED = 1.15;

// ---------------------------------------------------------------------------
// Café
// ---------------------------------------------------------------------------

export type DrinkId = 'coffee' | 'tea' | 'cocoa' | 'special';
export interface DrinkDef {
  id: DrinkId;
  /** Held item shown in hand. */
  item: ItemId;
  name: string;
  blurb: string;
}
export const DRINKS: readonly DrinkDef[] = [
  { id: 'coffee', item: 'cup_coffee', name: 'Coffee', blurb: 'Black, or as dark as the night gets.' },
  { id: 'tea', item: 'cup_tea', name: 'Tea', blurb: 'Whatever the kettle feels like.' },
  { id: 'cocoa', item: 'cup_cocoa', name: 'Cocoa', blurb: 'Thick enough to stand a spoon in.' },
  { id: 'special', item: 'cup_special', name: 'Today’s special', blurb: 'See the chalkboard.' },
];
export const DRINK_ITEMS: ReadonlySet<string> = new Set(DRINKS.map((d) => d.item));
export function isDrinkItem(item: string): boolean {
  return DRINK_ITEMS.has(item);
}

const SPECIALS: readonly { name: string; text: string }[] = [
  { name: 'Honey & lavender latte', text: 'from the garden beds' },
  { name: 'Cardamom bun', text: 'and a small strong coffee' },
  { name: 'Smoked tea', text: 'brewed over the hearth' },
  { name: 'Fig & walnut cake', text: 'one slice each, please' },
  { name: 'Iced lemon cordial', text: 'for a warm afternoon' },
  { name: 'Spiced cocoa', text: 'with a pinch of chilli' },
  { name: 'Barley tea', text: 'toasty and kind' },
  { name: 'Rhubarb tart', text: 'while it lasts' },
];
/** Today's special (changes with the world day). */
export function specialForDay(day: number): { name: string; text: string } {
  return SPECIALS[((day % SPECIALS.length) + SPECIALS.length) % SPECIALS.length]!;
}

/** The café stage platform (interiors.ts CAFE platform 'stage', local frame) — standing on it is "on stage". */
export const CAFE_STAGE = { interiorId: 'cafe', at: [-3.9, -2.83] as const, half: [1.25, 1.07] as const };
/** Standing within this radius of the hall lectern anchor = speaking from the lectern. */
export const HALL_LECTERN = { interiorId: 'town_hall', anchor: 'lectern', radius: 0.95 };

/** Piano: two octaves C4..C6 (note 0 = C4). */
export const PIANO_NOTES = 25;
export function pianoFrequency(note: number): number {
  return 261.6256 * Math.pow(2, note / 12);
}

// ---------------------------------------------------------------------------
// General Store: today's free curiosities ("on the house, for now")
// ---------------------------------------------------------------------------

export const CURIOSITIES: readonly ItemId[] = ['postcard', 'brass_key', 'tin_whistle', 'glass_marble', 'ribbon', 'seed_packet', 'spinning_top', 'pressed_leaf', 'candle_stub'];
/** Three curiosities on the table today (deterministic per world day). */
export function curiositiesForDay(day: number, count = 3): ItemId[] {
  const pool = [...CURIOSITIES];
  const out: ItemId[] = [];
  let h = hashString(`curio:${day}`);
  while (out.length < Math.min(count, pool.length)) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Town Hall: the town poll (one config-driven question per period)
// ---------------------------------------------------------------------------

export interface PollDef {
  id: string;
  question: string;
  options: readonly string[];
}
export const POLLS: readonly PollDef[] = [
  { id: 'square_flowers', question: 'What should be planted around the fountain?', options: ['Lavender', 'Sunflowers', 'Wild meadow'] },
  { id: 'bell_hour', question: 'When is the best time to ring the bell?', options: ['At dawn', 'At noon', 'At midnight', 'Whenever you like'] },
  { id: 'cafe_music', question: 'What should the café piano play most?', options: ['Waltzes', 'Sea shanties', 'Lullabies'] },
  { id: 'next_path', question: 'Which path deserves more lanterns?', options: ['Woods trail', 'The dock', 'Residential lane'] },
  { id: 'island_name', question: 'What should we call the little cove by the dock?', options: ['Gull Cove', 'Quiet Bay', 'Lantern Inlet'] },
];
export interface PollPeriod {
  /** Unique per period, e.g. "p12:bell_hour". */
  key: string;
  index: number;
  poll: PollDef;
  /** First world day of the period / first day of the next one. */
  startDay: number;
  endDay: number;
}
export function pollForDay(day: number, periodDays = 1): PollPeriod {
  const len = Math.max(1, Math.round(periodDays));
  const index = Math.floor(day / len);
  const poll = POLLS[((index % POLLS.length) + POLLS.length) % POLLS.length]!;
  return { key: `p${index}:${poll.id}`, index, poll, startDay: index * len, endDay: (index + 1) * len };
}

// ---------------------------------------------------------------------------
// Workshop: the town project sequence (Collective Reality, rules as data)
// ---------------------------------------------------------------------------

export interface ProjectDef {
  id: string;
  name: string;
  /** What appears outside when it is done. */
  outcome: string;
  /** Stage names (stage k is reached after the k-th stage's contributions). */
  stageNames: readonly string[];
}
export const PROJECTS: readonly ProjectDef[] = [
  { id: 'square_lanterns', name: 'Lanterns for the Town Square', outcome: 'Strings of lanterns across the Town Square', stageNames: ['Frames cut', 'Glass fired', 'Lanterns strung'] },
  { id: 'store_vane', name: 'A weather vane for the General Store', outcome: 'A copper weather vane on the General Store roof', stageNames: ['Arrow forged', 'Letters cut', 'Vane raised'] },
  { id: 'dock_bunting', name: 'Bunting for the dock', outcome: 'Strings of flags along the dock', stageNames: ['Cloth dyed', 'Flags stitched', 'Bunting hung'] },
];
export function getProject(id: string): ProjectDef | undefined {
  return PROJECTS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Synced activity keys (state.activities)
// ---------------------------------------------------------------------------

export const ACTIVITY_KEYS = {
  /** active = open (keeper present), value = real players inside right now. */
  building: (id: string) => `bld:${id}`,
  /** value = world day, data = { name, text }. */
  special: 'cafe:special',
  /** holder = sessionId on the stage ('' = nobody). */
  stage: 'cafe:stage',
  /** holder = sessionId at the lectern. */
  lectern: 'hall:lectern',
  /** value = world day, data = { items: ItemId[] }. */
  shelf: 'store:shelf',
  /** value = total votes, data = PollData. */
  poll: 'hall:poll',
  /** value = visible entries, data = { entries: BoardEntry[] }. */
  board: (boardId: string) => `board:${boardId}`,
  /** value = stage, active = every project finished, data = ProjectData. */
  project: 'workshop:project',
  /** active = lit, value = lit until (unix ms). */
  hearth: (houseId: string) => `hearth:${houseId}`,
  /** active = on the stove or ready, value = ready at (unix ms), data = { readyUntil }. */
  kettle: (houseId: string) => `kettle:${houseId}`,
  /** value = sections mended on the current net, data = NetsData. */
  nets: 'boathouse:nets',
} as const;

/** One entry on a board / guest book (text is already moderated by the server). */
export interface BoardEntry {
  id: string;
  /** Author name at the time of writing. */
  a: string;
  /** Author profile id (clients hide blocked/muted authors; owners can remove). */
  p: string;
  t: string;
  ts: number;
  /** Expiry (unix ms) or 0. */
  x: number;
}
export interface PollData {
  key: string;
  question: string;
  options: string[];
  tallies: number[];
  endDay: number;
  /** The previous period's real result, if anyone voted. */
  last?: { question: string; options: string[]; tallies: number[] } | null;
}
export interface ProjectData {
  /** '' when every project is finished. */
  projectId: string;
  index: number;
  stage: number;
  stages: number;
  /** Contributions / distinct contributors towards the NEXT stage. */
  contributions: number;
  distinct: number;
  need: { contributions: number; distinct: number };
  completed: string[];
  /** Total contributions ever. */
  total: number;
}
export interface NetsData {
  sections: number;
  nets: number;
}

/** Parse a synced `data` JSON field defensively. */
export function parseActivityData<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Keeper lines (never about invented player activity — only real world state)
// ---------------------------------------------------------------------------

export interface KeeperContext {
  open: boolean;
  hours: number;
  day: number;
  fountainStage: number;
  pollVotes: number;
  pollQuestion: string;
  project: { name: string; stage: number; stages: number } | null;
  projectsDone: number;
  special: string;
  /** Real players inside this building right now (including the asker). */
  inside: number;
}

/** A short, context-aware greeting. Deterministic per (keeper, world day, hour). */
export function keeperLine(keeper: KeeperDef, c: KeeperContext): string {
  const hours = OPENING_HOURS[keeper.interiorId];
  if (!c.open) return `Closed for now — back at ${hours ? formatHour(hours[0]) : 'opening'}.`;
  const lines: string[] = [];
  const timeOfDay = c.hours < 11 ? 'morning' : c.hours < 17 ? 'afternoon' : 'evening';
  switch (keeper.id) {
    case 'keeper_barista':
      lines.push(`Good ${timeOfDay}. Today’s special is the ${c.special.toLowerCase()}.`);
      lines.push(`The piano’s in tune enough. Mostly.`);
      if (c.fountainStage > 0) lines.push(`Have you seen the fountain? Stage ${c.fountainStage} now, it hums at night.`);
      else lines.push(`The fountain’s still quiet. They say it changes when enough people touch it.`);
      break;
    case 'keeper_shopkeeper':
      lines.push(`Everything on the table is on the house, for now. One a day, mind.`);
      lines.push(`Good ${timeOfDay}. The till’s not open yet — that comes later.`);
      if (c.projectsDone > 0) lines.push(`${c.projectsDone} town project${c.projectsDone === 1 ? '' : 's'} finished at the Workshop so far.`);
      break;
    case 'keeper_clerk':
      lines.push(c.pollVotes === 0 ? `Today’s question: “${c.pollQuestion}” No votes yet.` : `Today’s question: “${c.pollQuestion}” ${c.pollVotes} vote${c.pollVotes === 1 ? '' : 's'} so far.`);
      lines.push(`The archive keeps everything the island remembers. Have a browse.`);
      lines.push(`Notices go on the board by the meeting corner. Keep them kind.`);
      break;
    case 'keeper_tinkerer':
      if (c.project) lines.push(`We’re making ${c.project.name.charAt(0).toLowerCase()}${c.project.name.slice(1)}. Stage ${c.project.stage} of ${c.project.stages}. Grab a tool.`);
      else lines.push(`Every project on the list is done. More are coming.`);
      lines.push(`The lumber rack, the anvil and the kiln all need hands.`);
      break;
  }
  return lines[hashString(`${keeper.id}:${c.day}:${Math.floor(c.hours)}`) % lines.length]!;
}
