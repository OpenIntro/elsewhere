/**
 * Every interactable object in The Commons. The world renderer draws these,
 * the player system targets them (nearest within `radius`), the server
 * validates interactions against them, and synced ones get an entry in the
 * room's `objects` state map (see protocol.ts ObjectStateView for semantics).
 *
 * Positions are ground-plane; the renderer places them at groundHeight().
 * Yaw: the object's front faces forward(yaw). For seats, a seated player faces seat.yaw.
 */
import { rotateOffset, yawFromDirection, type Vec2 } from '../math.js';
import { BUILDINGS, buildingLocal, doorPosition, getBuilding, type Building } from './buildings.js';
import { KEEPERS, STATIONS } from '../activities.js';
import { INTERIOR_SEATS, getInterior, interiorAnchor, type InteriorSeatSpec } from './interiors.js';
import type { DiscoveryId, ItemId } from './items.js';
import type { LocationId } from './locations.js';

export type InteractableKind =
  | 'bench'
  | 'chair'
  | 'door'
  | 'sign'
  | 'bell'
  | 'streetlight'
  | 'lantern'
  | 'mailbox'
  | 'pickup'
  | 'hidden'
  | 'fountain'
  | 'portal'
  | 'rune'
  | 'inspect'
  | 'newsstand'
  | 'archive'
  /** A building activity (activities.ts STATIONS): piano, notice board, workbench, hearth… */
  | 'station'
  /** Talk to a building's keeper (a world character, never a player — activities.ts KEEPERS). */
  | 'keeper';

export interface Seat {
  /** Where the seated character's root is placed. */
  position: Vec2;
  /** Height above ground of the seat surface (character sits at groundHeight + this). */
  height: number;
  /** Facing while seated. */
  yaw: number;
  /** Where the character is placed when standing up. */
  exit: Vec2;
}

interface Base<K extends InteractableKind> {
  id: string;
  kind: K;
  /** Short display name ("Fountain", "Bench"). */
  name: string;
  locationId: LocationId;
  position: Vec2;
  yaw: number;
  /** Label shown in the interaction prompt, e.g. "Sit", "Ring the bell". */
  prompt: string;
  /** True if the server keeps shared state for it in `state.objects`. */
  synced: boolean;
  /** Interaction radius override (default CONFIG.interaction.radius). */
  radius?: number;
}

export interface SeatInteractable extends Base<'bench' | 'chair'> {
  seats: readonly Seat[];
}
export interface DoorInteractable extends Base<'door'> {
  buildingId: string;
}
export interface SignInteractable extends Base<'sign'> {
  title: string;
  text: string;
}
export interface InspectInteractable extends Base<'inspect'> {
  title: string;
  text: string;
}
export interface LightInteractable extends Base<'streetlight' | 'lantern'> {
  light: { color: string; intensity: number; range: number; height: number };
}
export interface MailboxInteractable extends Base<'mailbox'> {
  /** Building id this mailbox belongs to, or 'public' for the post box. */
  owner: string;
}
export interface PickupInteractable extends Base<'pickup'> {
  itemId: ItemId;
}
export interface HiddenInteractable extends Base<'hidden'> {
  discoveryId: DiscoveryId;
}
export interface RuneInteractable extends Base<'rune'> {
  /** 0-based rune index (all CONFIG.collective.portalRunesRequired must be held together). */
  index: number;
}
export type SimpleInteractable = Base<'bell' | 'fountain' | 'portal' | 'newsstand' | 'archive'>;
export interface StationInteractable extends Base<'station'> {
  stationId: string;
  interiorId: string;
}
export interface KeeperInteractable extends Base<'keeper'> {
  keeperId: string;
  interiorId: string;
}

export type Interactable =
  | SeatInteractable
  | DoorInteractable
  | SignInteractable
  | InspectInteractable
  | LightInteractable
  | MailboxInteractable
  | PickupInteractable
  | HiddenInteractable
  | RuneInteractable
  | SimpleInteractable
  | StationInteractable
  | KeeperInteractable;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const v = (x: number, z: number): Vec2 => ({ x, z });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
const polar = (c: Vec2, r: number, deg: number): Vec2 => ({ x: c.x + r * Math.cos((deg * Math.PI) / 180), z: c.z + r * Math.sin((deg * Math.PI) / 180) });
const facing = (from: Vec2, to: Vec2): number => yawFromDirection(to.x - from.x, to.z - from.z);

/** exitZ: local Z of the stand-up spot (+ in front of the seat, - behind it). */
function seatAt(base: Vec2, yaw: number, lx: number, height: number, exitZ = 1.05): Seat {
  return {
    position: add(base, rotateOffset(v(lx, 0.05), yaw)),
    height,
    yaw,
    exit: add(base, rotateOffset(v(lx, exitZ), yaw)),
  };
}

function bench(id: string, locationId: LocationId, position: Vec2, yaw: number, name = 'Bench'): SeatInteractable {
  return {
    id,
    kind: 'bench',
    name,
    locationId,
    position,
    yaw,
    prompt: 'Sit',
    synced: true,
    seats: [seatAt(position, yaw, -0.55, 0.45), seatAt(position, yaw, 0.55, 0.45)],
  };
}

function chair(id: string, locationId: LocationId, position: Vec2, yaw: number): SeatInteractable {
  return { id, kind: 'chair', name: 'Chair', locationId, position, yaw, prompt: 'Sit', synced: true, radius: 1.8, seats: [seatAt(position, yaw, 0, 0.45, -0.9)] };
}

const WARM_LAMP = '#ffcf8a';
function streetlight(id: string, locationId: LocationId, position: Vec2): LightInteractable {
  return {
    id,
    kind: 'streetlight',
    name: 'Streetlight',
    locationId,
    position,
    yaw: 0,
    prompt: 'Toggle light',
    synced: true,
    light: { color: WARM_LAMP, intensity: 1.4, range: 9, height: 3.4 },
  };
}
function lantern(id: string, locationId: LocationId, position: Vec2, height = 1.6, name = 'Lantern'): LightInteractable {
  return {
    id,
    kind: 'lantern',
    name,
    locationId,
    position,
    yaw: 0,
    prompt: 'Toggle lantern',
    synced: true,
    light: { color: '#ffc27a', intensity: 0.9, range: 6, height },
  };
}

function sign(id: string, locationId: LocationId, position: Vec2, yaw: number, title: string, text: string): SignInteractable {
  return { id, kind: 'sign', name: 'Sign', locationId, position, yaw, prompt: 'Read', synced: false, title, text };
}

function inspect(id: string, name: string, locationId: LocationId, position: Vec2, yaw: number, title: string, text: string, prompt = 'Examine'): InspectInteractable {
  return { id, kind: 'inspect', name, locationId, position, yaw, prompt, synced: false, title, text };
}

function hidden(id: string, discoveryId: DiscoveryId, position: Vec2, locationId: LocationId = 'woods'): HiddenInteractable {
  return { id, kind: 'hidden', name: 'Something', locationId, position, yaw: 0, prompt: 'Look closer', synced: false, radius: 1.6, discoveryId };
}

function pickup(id: string, itemId: ItemId, name: string, locationId: LocationId, position: Vec2): PickupInteractable {
  return { id, kind: 'pickup', name, locationId, position, yaw: 0, prompt: `Pick up ${name.toLowerCase()}`, synced: true, radius: 1.8, itemId };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const SQUARE = v(0, 2);
/** Local X of the Town Hall bell tower (front-right corner); the bell rope post stands in front of it. */
export const HALL_TOWER_X = 5.7;
const RES_CENTER = v(-36, 18);
const UNKNOWN = v(-10, -61);
/** The arch stands between two runes on the west side and faces east-north-east, towards the camera side. */
const ARCH_FACING = v(-1, -56.6);

/** A point relative to a building's FRONT face: lx along it, dz out from it. */
const front = (b: Building, lx: number, dz: number): Vec2 => buildingLocal(b, lx, b.depth / 2 + dz);

const doors: DoorInteractable[] = BUILDINGS.map((b) => ({
  id: b.doorId,
  kind: 'door',
  name: b.futureHome ? `${b.name} — a future home` : `${b.name} door`,
  locationId: b.locationId,
  position: doorPosition(b),
  yaw: b.yaw,
  prompt: 'Open door',
  synced: true,
  buildingId: b.id,
}));

const houseMailboxes: MailboxInteractable[] = BUILDINGS.filter((b) => b.style === 'cottage').map((b) => ({
  id: `mailbox_${b.id}`,
  kind: 'mailbox',
  name: `${b.name} mailbox`,
  locationId: 'residential',
  position: buildingLocal(b, -2.1, b.depth / 2 + 1.5),
  yaw: b.yaw,
  prompt: 'Check mailbox',
  synced: false,
  owner: b.id,
}));

// Town Square: benches + lights avoid the six radiating paths.
const squareBenches = [-120, -60, 52, 115, 180].map((deg, i) => {
  const pos = polar(SQUARE, 8, deg);
  return bench(`bench_square_${i + 1}`, 'town_square', pos, facing(pos, SQUARE));
});
const squareLights = [-10, -100, 95, -170, 135].map((deg, i) => streetlight(`light_square_${i + 1}`, 'town_square', polar(SQUARE, 12, deg)));

// Café outdoor seating: three tables in front of the café, two chairs each.
const cafe = getBuilding('cafe');
const cafeTableSpots: Vec2[] = [front(cafe, -2.9, 3.3), front(cafe, 0.3, 4.6), front(cafe, 3.4, 3.1)];
export const CAFE_TABLES: readonly { id: string; position: Vec2; radius: number }[] = cafeTableSpots.map((p, i) => ({ id: `cafe_table_${i + 1}`, position: p, radius: 0.6 }));
const cafeChairs: SeatInteractable[] = cafeTableSpots.flatMap((t, i) => {
  const a = rotateOffset(v(-1.05, 0), cafe.yaw);
  const left = v(t.x + a.x, t.z + a.z);
  const right = v(t.x - a.x, t.z - a.z);
  return [chair(`chair_cafe_${i + 1}a`, 'cafe', left, facing(left, t)), chair(`chair_cafe_${i + 1}b`, 'cafe', right, facing(right, t))];
});

const store = getBuilding('general_store');
const hall = getBuilding('town_hall');
const workshop = getBuilding('workshop');
const boathouse = getBuilding('boathouse');

/** Indoor chairs / benches (interiors.ts INTERIOR_SEATS). */
function indoorSeat(s: InteriorSeatSpec): SeatInteractable {
  if (s.kind === 'bench') return bench(s.id, s.locationId, s.position, s.yaw, s.name);
  const seat: Seat = { position: add(s.position, rotateOffset(v(0, 0.05), s.yaw)), height: s.style === 'armchair' ? 0.42 : s.style === 'stool' ? 0.5 : 0.45, yaw: s.yaw, exit: s.exit };
  return { id: s.id, kind: 'chair', name: s.name, locationId: s.locationId, position: s.position, yaw: s.yaw, prompt: 'Sit', synced: true, radius: 1.8, seats: [seat] };
}
const indoorSeats = INTERIOR_SEATS.map(indoorSeat);
/** Interior anchor as a position (things that live indoors are placed on anchors / furniture). */
const inside = (interior: string, anchor: string, toward = 0): Vec2 => {
  const a = interiorAnchor(interior, anchor);
  return add(a.position, rotateOffset(v(0, toward), a.yaw));
};

/** Building activities (activities.ts): stations on interior anchors. */
const stations: StationInteractable[] = STATIONS.map((st) => {
  const a = interiorAnchor(st.interiorId, st.anchor);
  const interior = getInterior(st.interiorId)!;
  return {
    id: st.id,
    kind: 'station',
    name: st.name,
    locationId: interior.locationId,
    position: inside(st.interiorId, st.anchor, st.toward),
    yaw: a.yaw + Math.PI,
    prompt: st.prompt,
    synced: false,
    radius: st.radius,
    stationId: st.id,
    interiorId: st.interiorId,
  };
});
/** Keepers: talked to across their counter / at their spot (the keeper walks around behind it). */
const keepers: KeeperInteractable[] = KEEPERS.map((k) => {
  const a = interiorAnchor(k.interiorId, k.talkAnchor);
  const interior = getInterior(k.interiorId)!;
  return {
    id: k.interactableId,
    kind: 'keeper',
    name: `${k.name}, ${k.role.toLowerCase()}`,
    locationId: interior.locationId,
    position: inside(k.interiorId, k.talkAnchor, k.talkToward),
    yaw: a.yaw + Math.PI,
    prompt: `Talk to ${k.name}`,
    synced: false,
    radius: k.talkRadius,
    keeperId: k.id,
    interiorId: k.interiorId,
  };
});

export const INTERACTABLES: readonly Interactable[] = [
  // --- Town Square -------------------------------------------------------
  {
    id: 'fountain',
    kind: 'fountain',
    name: 'The Fountain',
    locationId: 'town_square',
    position: SQUARE,
    yaw: 0,
    prompt: 'Touch the water',
    synced: true,
    radius: 4.6,
  },
  ...squareBenches,
  ...squareLights,
  sign('sign_welcome', 'town_square', polar(SQUARE, 10.5, 66), Math.PI, 'Welcome to The Commons',
    'Somewhere between a game and a place.\n\nSit a while. Say hello. Ring the bell if you like.\nThe island remembers who passes through.'),
  sign('sign_notice_board', 'town_square', polar(SQUARE, 11.2, -140), facing(polar(SQUARE, 11.2, -140), SQUARE), 'Community Notice Board',
    'LOST: one wrench, probably at the Workshop.\nFOUND: a coin covered in moss (returned to the Woods).\nREMINDER: the fountain has been acting strangely when lots of people visit.'),
  { id: 'newsstand', kind: 'newsstand', name: 'Gazette Stand', locationId: 'town_square', position: polar(SQUARE, 10.2, -22), yaw: facing(polar(SQUARE, 10.2, -22), SQUARE), prompt: 'Read the Gazette', synced: false },

  // --- Café ---------------------------------------------------------------
  ...cafeChairs,
  sign('sign_cafe_menu', 'cafe', front(cafe, 4.6, 0.75), cafe.yaw, 'Today at the Café',
    'Coffee — black, or as dark as the night gets\nTea — whatever the kettle feels like\nCinnamon bun — while they last\n\nTake your time. The tables are for everyone.'),
  lantern('lantern_cafe', 'cafe', front(cafe, -4.6, 0.75), 2.2, 'String lights'),
  inspect('inspect_cafe_window', 'Café window', 'cafe', front(cafe, 2.4, 0.2), cafe.yaw, 'Café window',
    'Through the glass: a chalkboard, a hissing espresso machine, and a cat asleep on a stack of newspapers.', 'Peek inside'),


  // --- General Store ------------------------------------------------------
  { id: 'mailbox_post_office', kind: 'mailbox', name: 'Post Box', locationId: 'general_store', position: front(store, 3.6, 1.35), yaw: store.yaw, prompt: 'Use post box', synced: false, owner: 'public' },
  sign('sign_store_hours', 'general_store', front(store, -3.4, 0.95), store.yaw, 'General Store',
    'Open when the door is open.\nWe stock: string, lamp oil, apples, postcards, and things you did not know you needed.'),
  pickup('pickup_apple', 'apple', 'Apple', 'general_store', inside('general_store', 'crates', 0.75)),
  lantern('lantern_store', 'general_store', front(store, -1.5, 0.65), 2.2, 'Porch lamp'),

  // --- Town Hall ----------------------------------------------------------
  { id: 'bell_town_hall', kind: 'bell', name: 'Town Hall Bell', locationId: 'town_hall', position: front(hall, HALL_TOWER_X, 0.7), yaw: hall.yaw, prompt: 'Ring the bell', synced: true },
  { id: 'archive_town_hall', kind: 'archive', name: 'Island Archive', locationId: 'town_hall', position: inside('town_hall', 'archive', 0.9), yaw: interiorAnchor('town_hall', 'archive').yaw + Math.PI, prompt: 'Browse the archive', synced: false },
  sign('sign_town_hall', 'town_hall', front(hall, 0, 3.9), Math.PI, 'Town Hall',
    'Seat of no government in particular.\nThe bell may be rung by anyone, at any hour, for any reason.\nThe archive inside records everything the island remembers.'),
  lantern('lantern_hall_left', 'town_hall', front(hall, -2.65, 0.8), 2.4, 'Hall lamp'),
  lantern('lantern_hall_right', 'town_hall', front(hall, 2.65, 0.8), 2.4, 'Hall lamp'),

  // --- Workshop -----------------------------------------------------------
  inspect('inspect_workbench', 'Workbench', 'workshop', inside('workshop', 'workbench_1', 0.45), interiorAnchor('workshop', 'workbench_1').yaw + Math.PI, 'Workbench',
    'Clamps, shavings, a half-built birdhouse, and a list: "1. fix the dock lantern 2. ask about the arch 3. more glue".', 'Look at workbench'),
  pickup('pickup_wrench', 'wrench', 'Wrench', 'workshop', inside('workshop', 'workbench_2', 0.85)),
  inspect('inspect_boat_frame', 'Half-built boat', 'workshop', inside('workshop', 'project_1', 0.4), interiorAnchor('workshop', 'project_1').yaw + Math.PI, 'Half-built boat',
    'Ribs of steamed oak, a keel, and a chalk note: "for whoever wants to see the other island". Nobody remembers starting it.', 'Look at the boat'),
  sign('sign_workshop', 'workshop', front(workshop, -4.0, 0.9), workshop.yaw, 'The Workshop', 'Borrow a tool, return a tool.\nMind the sawdust.'),
  lantern('lantern_workshop', 'workshop', front(workshop, -2.4, 0.4), 2.3, 'Work lamp'),

  // --- Residential --------------------------------------------------------
  ...houseMailboxes,
  bench('bench_garden', 'residential', v(-36, 21.2), Math.PI, 'Garden bench'),
  pickup('pickup_wildflower', 'wildflower', 'Wildflower', 'residential', v(-34.2, 16.4)),
  sign('sign_residential', 'residential', v(-26.8, 10.6), facing(v(-26.8, 10.6), SQUARE), 'Residential District', 'Please close the garden gates.\nMail is collected whenever someone remembers.'),
  streetlight('light_res_1', 'residential', v(-33.5, 8.4)),
  streetlight('light_res_2', 'residential', v(-44.8, 18.5)),
  streetlight('light_res_3', 'residential', v(-33, 26.6)),
  inspect('inspect_garden_bed', 'Garden bed', 'residential', RES_CENTER, 0, 'Shared garden', 'Tomatoes, marigolds, and a label that says "everyone\'s".'),

  // --- Paths between places ----------------------------------------------
  streetlight('light_path_waterfront', 'waterfront', v(6.2, 22)),
  streetlight('light_path_residential', 'residential', v(-18.5, 12.6)),
  streetlight('light_path_workshop', 'workshop', v(18.5, 12.3)),
  streetlight('light_path_hall', 'town_hall', v(5.3, -15.5)),

  // --- The Woods ----------------------------------------------------------
  sign('sign_trailhead', 'woods', v(-12.2, -36.4), facing(v(-12.2, -36.4), SQUARE), 'The Woods',
    'Fern Loop — a gentle circle under the pines.\nStone Trail — north, over the Mossy Bridge, to the edge of everything.\nThe woods keep a few secrets. Look closely.'),
  lantern('lantern_bridge_south', 'woods', v(-22.2, -41.4), 1.5, 'Bridge lantern'),
  lantern('lantern_bridge_north', 'woods', v(-26.0, -48.8), 1.5, 'Bridge lantern'),
  pickup('pickup_pinecone', 'pinecone', 'Pinecone', 'woods', v(-34.5, -27.6)),
  hidden('hidden_mossy_coin', 'mossy_coin', v(-36.4, -38.2)),
  hidden('hidden_carved_owl', 'carved_owl', v(-46.2, -29.5)),
  hidden('hidden_music_box', 'music_box', v(-27.4, -26.6)),
  hidden('hidden_old_compass', 'old_compass', v(-31.5, -42.2)),
  inspect('inspect_old_stump', 'Old stump', 'woods', v(-40.6, -18.8), 0, 'Old stump', 'The rings are too many to count. Someone left a single acorn on top.'),

  // --- The Unknown --------------------------------------------------------
  sign('sign_unknown', 'the_unknown', v(-19.6, -53.6), facing(v(-19.6, -53.6), UNKNOWN), 'Beyond This Point', 'The Unknown.\nNo one remembers who raised these stones.'),
  { id: 'portal_arch', kind: 'portal', name: 'Dormant Arch', locationId: 'the_unknown', position: add(UNKNOWN, rotateOffset(v(0, -3.2), facing(UNKNOWN, ARCH_FACING))), yaw: facing(UNKNOWN, ARCH_FACING), prompt: 'Touch the arch', synced: true, radius: 3 },
  ...[0, 1, 2].map((i): RuneInteractable => {
    const deg = 146 + 120 * (i + 1); // equilateral triangle: two flank the arch, one greets the entrance
    const pos = polar(UNKNOWN, 4.2, deg);
    return { id: `rune_${i + 1}`, kind: 'rune', name: 'Rune Stone', locationId: 'the_unknown', position: pos, yaw: facing(pos, UNKNOWN), prompt: 'Place a hand on the rune', synced: true, radius: 1.9, index: i };
  }),
  { ...hidden('hidden_stone_inscription', 'stone_inscription', polar(UNKNOWN, 7.6, 146 + 180), 'the_unknown'), radius: 2 },

  // --- Waterfront ---------------------------------------------------------
  bench('bench_shore_1', 'waterfront', v(5.5, 48.6), Math.PI * 0.1, 'Shore bench'),
  bench('bench_shore_2', 'waterfront', v(19.5, 45.6), -Math.PI * 0.1, 'Shore bench'),
  bench('bench_dock_end', 'waterfront', v(14, 63.4), Math.PI, 'Dock bench'),
  lantern('lantern_dock_1', 'waterfront', v(15.6, 49.5), 1.9, 'Dock lantern'),
  lantern('lantern_dock_2', 'waterfront', v(12.4, 55.5), 1.9, 'Dock lantern'),
  lantern('lantern_dock_3', 'waterfront', v(17.2, 61.4), 1.9, 'Dock lantern'),
  sign('sign_dock', 'waterfront', v(16.2, 46.2), Math.PI, 'The Dock', 'No ferry today. Or any day, so far.\nSunsets nightly, free of charge.'),
  inspect('inspect_telescope', 'Telescope', 'waterfront', v(11.2, 62.6), Math.PI, 'Coin telescope', 'Through the lens: open sea, a gull, and — for a moment — something like another island.', 'Look through'),
  pickup('pickup_pebble', 'smooth_pebble', 'Smooth Pebble', 'waterfront', v(-2.5, 44.8)),
  pickup('pickup_seashell', 'seashell', 'Seashell', 'waterfront', v(24.5, 45.2)),
  pickup('pickup_paper_lantern', 'paper_lantern', 'Paper Lantern', 'waterfront', v(6.6, 41.6)),
  hidden('hidden_message_bottle', 'message_bottle', v(-9.5, 40.2), 'waterfront'),

  // --- Indoors ------------------------------------------------------------
  ...indoorSeats,
  ...stations,
  ...keepers,
  ...doors,
];

const BY_ID = new Map<string, Interactable>(INTERACTABLES.map((i) => [i.id, i]));

export function getInteractable(id: string): Interactable | undefined {
  return BY_ID.get(id);
}

export function isSeatInteractable(i: Interactable): i is SeatInteractable {
  return i.kind === 'bench' || i.kind === 'chair';
}

/** All synced interactables (server seeds `state.objects` from this). */
export const SYNCED_INTERACTABLES: readonly Interactable[] = INTERACTABLES.filter((i) => i.synced);

/** Seat reference string used in PlayerState.seat: "<interactableId>#<seatIndex>". */
export function seatRef(interactableId: string, seatIndex: number): string {
  return `${interactableId}#${seatIndex}`;
}

export function parseSeatRef(ref: string): { interactableId: string; seatIndex: number } | null {
  const m = /^(.+)#(\d+)$/.exec(ref);
  if (!m) return null;
  return { interactableId: m[1]!, seatIndex: Number(m[2]) };
}

export function getSeat(ref: string): Seat | null {
  const parsed = parseSeatRef(ref);
  if (!parsed) return null;
  const it = getInteractable(parsed.interactableId);
  if (!it || !isSeatInteractable(it)) return null;
  return it.seats[parsed.seatIndex] ?? null;
}
