/**
 * Pure ambience mix: which beds/event layers play, how loud (0..1), and where
 * point-like sources are, for a listener position, in-world hour, location
 * ambience key and portal state. Unit-tested; the engine just follows it.
 */
import {
  CREEK_POINTS,
  FOUNTAIN,
  LOCATIONS,
  PORTAL_ARCH,
  closestPointOnSegment,
  daylight,
  shoreRadius,
  terrainHeight,
  type AmbienceKey,
  type Vec2,
} from '@elsewhere/shared';
import { falloff } from './spatial.js';

export const AMBIENCE_LAYERS = ['wind', 'birds', 'gulls', 'insects', 'owl', 'shore', 'fountain', 'creek', 'cafe', 'forest', 'workshop', 'mystery', 'chimes'] as const;
export type AmbienceLayer = (typeof AMBIENCE_LAYERS)[number];

/** Layers rendered as continuous beds (the rest are scheduled events). */
export const BED_LAYERS = ['wind', 'shore', 'fountain', 'creek', 'cafe', 'forest', 'mystery', 'insects'] as const satisfies readonly AmbienceLayer[];
export type BedLayer = (typeof BED_LAYERS)[number];

export interface AmbienceInput {
  x: number;
  z: number;
  /** In-world hours 0..24. */
  hours: number;
  key: AmbienceKey | null;
  portalAwake: boolean;
}

export interface AmbienceMix {
  weights: Record<AmbienceLayer, number>;
  /** World positions of point-like sources (for panning). */
  sources: { shore: Vec2; fountain: Vec2; creek: Vec2; cafe: Vec2; mystery: Vec2; workshop: Vec2 };
  /** 0 = deep night, 1 = full day. */
  day: number;
}

const loc = (id: string) => LOCATIONS.find((l) => l.id === id)!;
const CAFE = loc('cafe').center;
const WOODS = loc('woods');
const WORKSHOP = loc('workshop').center;
const RESIDENTIAL = loc('residential').center;
const UNKNOWN = loc('the_unknown').center;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** Key → per-layer multiplier (gives each named place its own character). */
const KEY_BIAS: Partial<Record<AmbienceKey, Partial<Record<AmbienceLayer, number>>>> = {
  town: { fountain: 1.1, birds: 0.8 },
  cafe: { cafe: 1.25, wind: 0.75 },
  indoor_shop: { wind: 0.7, birds: 0.8 },
  garden: { birds: 1.25, insects: 1.2 },
  hall: { wind: 1.2 },
  workshop: { workshop: 1.2 },
  forest: { birds: 1.3, owl: 1.3, wind: 0.85 },
  ancient: { birds: 0.3, insects: 0.6, mystery: 1.2, chimes: 1.6, wind: 1.15 },
  shore: { birds: 0.45, gulls: 1.2, wind: 1.1 },
};

export function nearestOnPolyline(p: Vec2, pts: readonly Vec2[]): { point: Vec2; distance: number } {
  let best = { point: pts[0]!, distance: Infinity };
  for (let i = 0; i + 1 < pts.length; i++) {
    const r = closestPointOnSegment(p, pts[i]!, pts[i + 1]!);
    if (r.distance < best.distance) best = { point: r.point, distance: r.distance };
  }
  return best;
}

export function ambienceMix(input: AmbienceInput): AmbienceMix {
  const p = { x: input.x, z: input.z };
  const hours = ((input.hours % 24) + 24) % 24;
  const day = daylight(hours / 24);
  const night = 1 - day;
  // Dawn chorus 5–9h, a little evensong 17–19h.
  const dawn = falloff(Math.abs(hours - 7), 0.5, 2.5);
  const evensong = falloff(Math.abs(hours - 18), 0.3, 1.5);

  // Coast: radial point on the shoreline; dock / sea counts as "on the shore".
  const theta = Math.atan2(p.z, p.x);
  const r = shoreRadius(theta);
  const shorePoint = { x: Math.cos(theta) * r, z: Math.sin(theta) * r };
  const inland = r - Math.hypot(p.x, p.z);
  const shore = Math.pow(falloff(Math.max(0, inland), 2, 30), 1.3);

  const fountain = falloff(d(p, FOUNTAIN.position), 4, 24);
  const creekNear = nearestOnPolyline(p, CREEK_POINTS);
  const creek = falloff(creekNear.distance, 2.5, 22);
  const cafe = falloff(d(p, CAFE), 5, 20) * (0.3 + 0.7 * day);
  const forest = falloff(d(p, WOODS.center), WOODS.radius * 0.6, WOODS.radius + 16);
  const workshop = falloff(d(p, WORKSHOP), 4, 18) * (0.15 + 0.85 * day);
  const unknownNear = falloff(d(p, UNKNOWN), 8, 34);
  const mystery = falloff(d(p, PORTAL_ARCH.position), 5, input.portalAwake ? 46 : 34) * (input.portalAwake ? 1 : 0.5);
  const garden = falloff(d(p, RESIDENTIAL), 10, 28);
  const height = Math.max(0, terrainHeight(p.x, p.z));
  const exposure = clamp01(shore * 0.6 + unknownNear * 0.6 + height / 10);

  const greenery = clamp01(Math.max(forest, garden * 0.9, 0.45) - shore * 0.35 - fountain * 0.15);

  const weights: Record<AmbienceLayer, number> = {
    wind: clamp01(0.3 + 0.45 * exposure + 0.1 * night - 0.15 * fountain),
    birds: clamp01(day * (0.55 + 0.45 * dawn + 0.25 * evensong) * greenery),
    gulls: clamp01(day * shore * 0.8),
    insects: clamp01(Math.pow(night, 1.5) * (0.35 + 0.65 * Math.max(garden, forest, 0.4)) * (1 - shore * 0.5)),
    owl: clamp01(Math.pow(night, 2) * Math.max(forest, garden * 0.4, 0.15)),
    shore,
    fountain,
    creek,
    cafe,
    forest: clamp01(forest * (0.6 + 0.4 * day)),
    workshop,
    mystery,
    chimes: clamp01(0.08 + 0.6 * unknownNear + (input.portalAwake ? 0.25 : 0)),
  };

  const bias = input.key ? KEY_BIAS[input.key] : undefined;
  if (bias) for (const [k, m] of Object.entries(bias) as [AmbienceLayer, number][]) weights[k] = clamp01(weights[k] * m);

  return {
    weights,
    sources: { shore: shorePoint, fountain: FOUNTAIN.position, creek: creekNear.point, cafe: CAFE, mystery: PORTAL_ARCH.position, workshop: WORKSHOP },
    day,
  };
}
