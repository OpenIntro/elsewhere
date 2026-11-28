/**
 * Homes: the rule for "this house can be your home" (pure; shared by the
 * server, which decides, and the client, which only offers the button).
 *
 * A home is a roofed room of ONE owner's pieces: the room is found with
 * `enclosureAt` over an index of that owner's pieces only, so nothing anybody
 * else builds — a roof against an open side, a wall, a sign — can change the
 * result (a neighbour can never make your house "not a house").
 *
 * It qualifies when
 *  - the room is roofed (`enclosureAt` kind 'roofed'),
 *  - at least 4 of the owner's walls (wall / window / doorway) are on its
 *    outline, at least one of them a doorway,
 *  - its cover includes one of the owner's roofs (house roof or legacy roof tile).
 * Its name is the text of the owner's facade name sign (name board, hanging
 * sign, plaque) on an outline wall, facing out, if there is one.
 *
 * The server stores only the door piece; the room is recomputed from the
 * owner's pieces whenever they change near it (server/src/homes).
 */
import { PIECES, PieceIndex, footprintOf, mountCentre, type PieceKind, type PieceLike, type Rect } from './building.js';
import { enclosureAt, type Enclosure } from './buildEnclosure.js';
import type { Vec2 } from './math.js';

/** A piece as the rule needs it (sign text for the name). */
export type HomePiece = PieceLike & { text?: string };

export interface House {
  /** Bounding rectangle of the room (wall centre lines). */
  rect: Rect;
  /** The rectangles whose union is the room. */
  parts: Rect[];
  /** The doorway that identifies this home (stored by the server). */
  doorPieceId: string;
  roofPieceIds: string[];
  /** The owner's walls (wall / window / doorway) on the room's outline. */
  wallPieceIds: string[];
  signPieceId?: string;
  /** Text of the facade name sign ('' without one). */
  name: string;
}

export type HomeRefusal =
  | 'not_found'
  | 'not_owner'
  | 'not_a_house'
  | 'no_roof'
  | 'few_walls'
  | 'no_doorway'
  | 'banned'
  | 'rate_limited'
  | 'no_home'
  | 'bad_request'
  | 'internal';

/** Short reasons shown to the player (server `S2C.homeResult.text`; the client shows them as sent). */
export const HOME_REFUSAL_TEXT: Readonly<Record<HomeRefusal, string>> = {
  not_found: 'That piece is not there any more.',
  not_owner: 'Only the builder of a house can make it their home.',
  not_a_house: 'That is not part of a house yet: your walls, a doorway and your roof make one.',
  no_roof: 'A home needs a roof of your own over it.',
  few_walls: 'A home needs at least four of your walls around it.',
  no_doorway: 'A home needs a doorway in one of its walls.',
  banned: 'You can’t do that while building is paused for you.',
  rate_limited: 'One moment — try that again in a few seconds.',
  no_home: 'You don’t have a home yet.',
  bad_request: 'That request was not understood.',
  internal: 'Something went wrong; please try again.',
};

/** Walls that count for a home's outline (pillars and half walls do not). */
const HOME_WALLS: ReadonlySet<PieceKind> = new Set<PieceKind>(['wall', 'wall_window', 'doorway']);
const WALL_LIKE: ReadonlySet<PieceKind> = new Set<PieceKind>(['wall', 'wall_window', 'doorway', 'half_wall', 'pillar']);
/** Facade name signs, in order of preference. */
const NAME_SIGNS: readonly PieceKind[] = ['name_board', 'name_hanging', 'name_plaque'];
/** How far inside a wall the room is probed (metres along each normal). */
export const HOME_PROBE_STEP = 0.6;

export type HouseCheck = { ok: true; house: House } | { ok: false; reason: HomeRefusal };

/** How far a failed probe got (the most telling reason wins). */
const PROGRESS: Partial<Record<HomeRefusal, number>> = { not_found: 0, not_a_house: 1, no_roof: 2, few_walls: 3, no_doorway: 4 };

function centreOf(r: Rect): Vec2 {
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
}
function inParts(parts: readonly Rect[], p: Vec2, m = 0): boolean {
  return parts.some((r) => p.x >= r.minX - m && p.x <= r.maxX + m && p.z >= r.minZ - m && p.z <= r.maxZ + m);
}
function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
}

/** The wall a mount hangs on (same centre, level and axis), or null. */
function wallOf<P extends HomePiece>(index: PieceIndex<P>, m: P): P | null {
  for (const q of index.query({ minX: m.x - 0.05, maxX: m.x + 0.05, minZ: m.z - 0.05, maxZ: m.z + 0.05 })) {
    if (q.id !== m.id && WALL_LIKE.has(q.kind) && q.level === m.level && Math.abs(q.x - m.x) < 1e-6 && Math.abs(q.z - m.z) < 1e-6 && q.rot % 2 === m.rot % 2) return q;
  }
  return null;
}

/** Points inside the house the selected piece belongs to: 0.6 m to each side of a wall, the centre of anything else. */
function probesFor<P extends HomePiece>(index: PieceIndex<P>, sel: P): { probes: Vec2[]; anchor: P } {
  let anchor = sel;
  if (PIECES[sel.kind].mount) anchor = wallOf(index, sel) ?? sel;
  if (WALL_LIKE.has(anchor.kind)) {
    const f = footprintOf(anchor);
    const w = f.maxX - f.minX;
    const d = f.maxZ - f.minZ;
    const normals: Vec2[] = Math.abs(w - d) < 1e-6 ? [{ x: 0, z: 1 }, { x: 0, z: -1 }, { x: 1, z: 0 }, { x: -1, z: 0 }] : w > d ? [{ x: 0, z: 1 }, { x: 0, z: -1 }] : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
    return { probes: normals.map((n) => ({ x: anchor.x + n.x * HOME_PROBE_STEP, z: anchor.z + n.z * HOME_PROBE_STEP })), anchor };
  }
  return { probes: [centreOf(footprintOf(anchor))], anchor };
}

/** Does the anchor piece belong to this room? */
function belongs<P extends HomePiece>(e: Enclosure, anchor: P): boolean {
  if (e.walls.some((w) => w.id === anchor.id) || e.inner.some((w) => w.id === anchor.id) || e.above.includes(anchor.id)) return true;
  return anchor.level === e.storey && inParts(e.parts, centreOf(footprintOf(anchor)));
}

function evaluate<P extends HomePiece>(index: PieceIndex<P>, e: Enclosure | null, anchor: P, sel: P): HouseCheck {
  if (!e || !belongs(e, anchor)) return { ok: false, reason: 'not_a_house' };
  if (e.kind !== 'roofed') return { ok: false, reason: 'no_roof' };
  const roofPieceIds = e.above.filter((id) => {
    const q = index.get(id);
    return !!q && PIECES[q.kind].layer === 'roof';
  });
  if (!roofPieceIds.length) return { ok: false, reason: 'no_roof' };
  const walls = e.walls.filter((w) => HOME_WALLS.has(w.kind));
  if (walls.length < 4) return { ok: false, reason: 'few_walls' };
  const doors = walls.filter((w) => w.kind === 'doorway').map((w) => w.id).sort();
  if (!doors.length) return { ok: false, reason: 'no_doorway' };
  const doorPieceId = doors.includes(sel.id) ? sel.id : doors.includes(anchor.id) ? anchor.id : doors[0]!;
  // The name: a facade sign on an outline wall, facing out of the house.
  const normals = new Map(e.walls.map((w) => [w.id, w.normals] as const));
  let sign: P | null = null;
  for (const q of index.query(e.rect, 1)) {
    if (!NAME_SIGNS.includes(q.kind) || !q.text) continue;
    const wall = wallOf(index, q);
    const ns = wall ? normals.get(wall.id) : undefined;
    if (!wall || !ns?.length) continue;
    const c = mountCentre(q.kind, q.x, q.z, q.rot);
    const out = { x: c.x - wall.x, z: c.z - wall.z };
    if (!ns.some((n) => n.x * out.x + n.z * out.z > 0.01)) continue;
    if (!sign) {
      sign = q;
      continue;
    }
    const a = NAME_SIGNS.indexOf(q.kind);
    const b = NAME_SIGNS.indexOf(sign.kind);
    if (a < b || (a === b && q.id < sign.id)) sign = q;
  }
  const house: House = {
    rect: { ...e.rect },
    // A stable order whichever cover the search started from.
    parts: e.parts.map((r) => ({ ...r })).sort((a, b) => a.minX - b.minX || a.minZ - b.minZ || a.maxX - b.maxX || a.maxZ - b.maxZ),
    doorPieceId,
    roofPieceIds: [...roofPieceIds].sort(),
    wallPieceIds: walls.map((w) => w.id).sort(),
    name: sign?.text ?? '',
  };
  if (sign) house.signPieceId = sign.id;
  return { ok: true, house };
}

/**
 * The house the piece `pieceId` belongs to, if it can be a home — with the
 * reason it cannot otherwise. Only pieces of that piece's owner are looked at
 * (anything else in `ownerPieces` is ignored). `prefer`: when the piece
 * borders two of the owner's qualifying rooms (a shared doorway), the room
 * overlapping this rectangle most wins.
 */
export function checkHouse<P extends HomePiece>(ownerPieces: Iterable<P>, pieceId: string, opts: { prefer?: Rect } = {}): HouseCheck {
  const list = [...ownerPieces];
  const sel = list.find((p) => p.id === pieceId);
  if (!sel) return { ok: false, reason: 'not_found' };
  const index = new PieceIndex<P>();
  for (const p of list) if (p.ownerId === sel.ownerId) index.add(p);
  const { probes, anchor } = probesFor(index, sel);
  const found: House[] = [];
  let worst: HomeRefusal = 'not_a_house';
  for (const p of probes) {
    const r = evaluate(index, enclosureAt(index, p), anchor, sel);
    if (r.ok) {
      if (!found.some((h) => h.doorPieceId === r.house.doorPieceId && JSON.stringify(h.rect) === JSON.stringify(r.house.rect))) found.push(r.house);
      if (!opts.prefer) break;
    } else if ((PROGRESS[r.reason] ?? 0) > (PROGRESS[worst] ?? 0)) worst = r.reason;
  }
  if (!found.length) return { ok: false, reason: worst };
  const prefer = opts.prefer;
  if (prefer) found.sort((a, b) => overlapArea(b.rect, prefer) - overlapArea(a.rect, prefer));
  return { ok: true, house: found[0]! };
}

/** `checkHouse` without the reason: the house, or null. */
export function houseFor<P extends HomePiece>(ownerPieces: Iterable<P>, pieceId: string, opts: { prefer?: Rect } = {}): House | null {
  const r = checkHouse(ownerPieces, pieceId, opts);
  return r.ok ? r.house : null;
}

/** Is p inside the home's room (any of its parts)? */
export function insideHome(home: { rect: Rect; parts?: readonly Rect[] }, p: Vec2): boolean {
  return inParts(home.parts?.length ? home.parts : [home.rect], p);
}

/** "Fern Cottage · Ivy's home" / "Ivy's home". */
export function homeLabel(name: string, ownerName: string): string {
  const owner = `${ownerName || 'Someone'}’s home`;
  return name ? `${name} · ${owner}` : owner;
}
