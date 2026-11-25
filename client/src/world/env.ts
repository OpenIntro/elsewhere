/**
 * World environment state: time of day (from the synchronized shared clock),
 * weather, quality profile and dev overrides. Computed once per frame by
 * <EnvironmentController/> and read (never via React state) by every world
 * system through the mutable `env` object and the shared shader `uniforms`.
 */
import { Color, Vector3 } from 'three';
import { daylight, lightsShouldBeOn, phaseForHours, sunAngles, type DayPhase } from '@elsewhere/shared';
import type { GraphicsQuality } from '../state/settingsStore.js';

// ---------------------------------------------------------------------------
// Weather seam
// ---------------------------------------------------------------------------

/**
 * Weather the renderer understands. Only `clear` and the fog variants are
 * implemented; rain/snow are typed so a future weather system (server-driven
 * or seasonal) can plug in: add the particle layer + tune `applyWeather`.
 */
export type WeatherKind = 'clear' | 'haze' | 'fog' | 'rain' | 'snow';
export interface WeatherState {
  kind: WeatherKind;
  /** 0..1 strength. */
  intensity: number;
}
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

// ---------------------------------------------------------------------------
// Quality profile
// ---------------------------------------------------------------------------

export interface QualityProfile {
  level: GraphicsQuality;
  shadows: boolean;
  shadowMapSize: number;
  /** Max simultaneous (non-shadow) point lights for lamps at night. */
  pointLights: number;
  terrainResolution: number;
  /** Multiplier on particle/decoration counts. */
  density: number;
  pixelRatioCap: number;
  /** Screen-space vignette / grade overlay. */
  post: boolean;
  waterDetail: boolean;
}

export const QUALITY: Record<GraphicsQuality, QualityProfile> = {
  low: { level: 'low', shadows: false, shadowMapSize: 512, pointLights: 0, terrainResolution: 1.2, density: 0.3, pixelRatioCap: 1, post: false, waterDetail: false },
  medium: { level: 'medium', shadows: true, shadowMapSize: 1024, pointLights: 3, terrainResolution: 0.8, density: 0.6, pixelRatioCap: 1.5, post: true, waterDetail: true },
  high: { level: 'high', shadows: true, shadowMapSize: 2048, pointLights: 6, terrainResolution: 0.6, density: 1, pixelRatioCap: 2, post: true, waterDetail: true },
};

// ---------------------------------------------------------------------------
// Dev overrides (never affect the server; dev builds only)
// ---------------------------------------------------------------------------

export interface DevOverrides {
  /** Fixed time of day 0..1 (0 = midnight). */
  time: number | null;
  fountainStage: number | null;
  portalAwake: boolean | null;
  runesLit: boolean | null;
  doorsOpen: boolean | null;
  /** Camera focus + zoom: "x,z,zoom". */
  cam: { x: number; z: number; zoom: number } | null;
  weather: WeatherState | null;
  quality: GraphicsQuality | null;
}

export const devOverrides: DevOverrides = {
  time: null,
  fountainStage: null,
  portalAwake: null,
  runesLit: null,
  doorsOpen: null,
  cam: null,
  weather: null,
  quality: null,
};

const LOCATION_CAMS: Record<string, { x: number; z: number; zoom: number }> = {
  island: { x: -4, z: -9, zoom: 6.6 },
  town_square: { x: 0, z: 2, zoom: 34 },
  cafe: { x: 19, z: -9, zoom: 40 },
  general_store: { x: -19.5, z: -7, zoom: 40 },
  residential: { x: -36, z: 17, zoom: 22 },
  town_hall: { x: 2, z: -25, zoom: 30 },
  workshop: { x: 31, z: 12.5, zoom: 40 },
  woods: { x: -31, z: -34, zoom: 22 },
  the_unknown: { x: -10, z: -60, zoom: 34 },
  waterfront: { x: 11, z: 48, zoom: 24 },
};
export const DEV_CAMERA_PRESETS = LOCATION_CAMS;

function parseOverrides(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  const q = new URLSearchParams(window.location.search);
  const num = (k: string): number | null => {
    const v = q.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (k: string): boolean | null => {
    const v = q.get(k);
    if (v === null) return null;
    return v === '1' || v === 'true' || v === 'on';
  };
  const t = num('time');
  if (t !== null) devOverrides.time = ((t % 1) + 1) % 1;
  devOverrides.fountainStage = num('fountain');
  devOverrides.portalAwake = bool('portal');
  devOverrides.runesLit = bool('runes');
  devOverrides.doorsOpen = bool('doors');
  const cam = q.get('cam');
  if (cam) {
    if (LOCATION_CAMS[cam]) devOverrides.cam = { ...LOCATION_CAMS[cam]! };
    else {
      const [x, z, zoom] = cam.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(z)) devOverrides.cam = { x: x!, z: z!, zoom: Number.isFinite(zoom) ? zoom! : 30 };
    }
  }
  const w = q.get('weather');
  if (w && ['clear', 'haze', 'fog', 'rain', 'snow'].includes(w)) devOverrides.weather = { kind: w as WeatherKind, intensity: num('weatherIntensity') ?? 1 };
  const ql = q.get('quality');
  if (ql === 'low' || ql === 'medium' || ql === 'high') devOverrides.quality = ql;
}
parseOverrides();

// ---------------------------------------------------------------------------
// Palette keyframes over the day (hours)
// ---------------------------------------------------------------------------

interface Key {
  h: number;
  sun: string;
  sunI: number;
  moonI: number;
  hemiSky: string;
  hemiGround: string;
  hemiI: number;
  bgTop: string;
  bgBottom: string;
  fog: string;
  waterShallow: string;
  waterDeep: string;
  /** Warm lamp glow multiplier 0..1 (windows/lamps). */
  glow: number;
}

const NIGHT: Omit<Key, 'h'> = {
  sun: '#9db2e8', sunI: 0, moonI: 0.75, hemiSky: '#5a6aa8', hemiGround: '#2a2a40', hemiI: 1.05,
  bgTop: '#0f1630', bgBottom: '#2b3463', fog: '#222a4e', waterShallow: '#2f5470', waterDeep: '#13223f', glow: 1,
};

const KEYS: Key[] = [
  { h: 0, ...NIGHT },
  { h: 4.6, ...NIGHT, hemiSky: '#5c64a0', bgBottom: '#3a3c6e', fog: '#2c3058' },
  { h: 5.6, sun: '#ff9f7a', sunI: 0, moonI: 0.35, hemiSky: '#8d84b0', hemiGround: '#3c3440', hemiI: 0.95, bgTop: '#4a5590', bgBottom: '#e3a59a', fog: '#8a7b9a', waterShallow: '#5c7a96', waterDeep: '#263a5c', glow: 0.8 },
  { h: 6.6, sun: '#ffc39a', sunI: 1.8, moonI: 0, hemiSky: '#dcd0e2', hemiGround: '#7a7066', hemiI: 1.05, bgTop: '#a9bde0', bgBottom: '#f6d2b8', fog: '#ead4ca', waterShallow: '#8eacaa', waterDeep: '#425f76', glow: 0.25 },
  { h: 8.5, sun: '#fff0dc', sunI: 2.7, moonI: 0, hemiSky: '#d8e8f2', hemiGround: '#8c8a6c', hemiI: 1.05, bgTop: '#bcd8ec', bgBottom: '#f3eedf', fog: '#e4ece9', waterShallow: '#8fb2aa', waterDeep: '#41657a', glow: 0 },
  { h: 12, sun: '#fff5e6', sunI: 2.9, moonI: 0, hemiSky: '#d9e8f2', hemiGround: '#8f8a6a', hemiI: 1.0, bgTop: '#b4d3ea', bgBottom: '#eef2e8', fog: '#e3ecee', waterShallow: '#90b6ad', waterDeep: '#3f667c', glow: 0 },
  { h: 15.5, sun: '#ffecd2', sunI: 2.8, moonI: 0, hemiSky: '#dfe4ea', hemiGround: '#8f8466', hemiI: 0.95, bgTop: '#bcd3e6', bgBottom: '#f3ead8', fog: '#e8e6de', waterShallow: '#8fb2a9', waterDeep: '#416479', glow: 0 },
  { h: 17.4, sun: '#ffc27c', sunI: 2.8, moonI: 0, hemiSky: '#f2d6bc', hemiGround: '#8a7458', hemiI: 1.0, bgTop: '#e8c4a8', bgBottom: '#f8d29a', fog: '#f2cfa6', waterShallow: '#a2b2a0', waterDeep: '#4a6274', glow: 0.1 },
  { h: 18.6, sun: '#ff9a5e', sunI: 1.9, moonI: 0, hemiSky: '#dca8a8', hemiGround: '#63505a', hemiI: 0.95, bgTop: '#9c8fb8', bgBottom: '#f2a27e', fog: '#d9a092', waterShallow: '#8e96a0', waterDeep: '#3d4a66', glow: 0.45 },
  { h: 19.6, sun: '#ff8a6a', sunI: 0.15, moonI: 0.25, hemiSky: '#a08cc0', hemiGround: '#4a3c52', hemiI: 1.25, bgTop: '#4d4c86', bgBottom: '#c98a98', fog: '#6e6290', waterShallow: '#56688c', waterDeep: '#22304f', glow: 0.85 },
  { h: 21, ...NIGHT, moonI: 0.55, hemiSky: '#5f6aa4', bgTop: '#18204a', bgBottom: '#3c3f78', fog: '#2a3060' },
  { h: 24, ...NIGHT },
];

interface ParsedKey {
  h: number;
  sun: Color; sunI: number; moonI: number; hemiSky: Color; hemiGround: Color; hemiI: number;
  bgTop: Color; bgBottom: Color; fog: Color; waterShallow: Color; waterDeep: Color; glow: number;
}
const PARSED: ParsedKey[] = KEYS.map((k) => ({
  h: k.h, sunI: k.sunI, moonI: k.moonI, hemiI: k.hemiI, glow: k.glow,
  sun: new Color(k.sun), hemiSky: new Color(k.hemiSky), hemiGround: new Color(k.hemiGround),
  bgTop: new Color(k.bgTop), bgBottom: new Color(k.bgBottom), fog: new Color(k.fog),
  waterShallow: new Color(k.waterShallow), waterDeep: new Color(k.waterDeep),
}));

// ---------------------------------------------------------------------------
// Mutable environment (read per frame)
// ---------------------------------------------------------------------------

export const env = {
  timeOfDay: 0.4,
  hours: 9.6,
  phase: 'morning' as DayPhase,
  daylight: 1,
  /** 0 by day → 1 deep night (smooth). */
  night: 0,
  /** Warm lamp/window glow 0..1. */
  glow: 0,
  lightsOn: false,
  sunElevation: 0.5,
  /** Unit vector pointing from the ground TOWARDS the key light (sun or moon). */
  keyDir: new Vector3(-0.5, 0.8, 0.2),
  sunDir: new Vector3(-0.5, 0.8, 0.2),
  sunColor: new Color(),
  sunIntensity: 2.5,
  moonIntensity: 0,
  hemiSky: new Color(),
  hemiGround: new Color(),
  hemiIntensity: 1,
  bgTop: new Color(),
  bgBottom: new Color(),
  fogColor: new Color(),
  fogDensity: 1,
  waterShallow: new Color(),
  waterDeep: new Color(),
  weather: { kind: 'clear', intensity: 0 } as WeatherState,
  season: 'summer' as Season,
  /** Seconds since start (animation clock). */
  time: 0,
  /** Wind strength 0..1 (weather could raise it). */
  wind: 0.5,
  quality: QUALITY.medium,
  /** Camera focus on the ground + view half-extent in world units (for culling/shadows). */
  focus: new Vector3(),
  viewRadius: 30,
  cameraZoom: 38,
};

/** Uniforms shared by every custom shader in the world (same object references). */
export const uniforms = {
  uTime: { value: 0 },
  uWind: { value: 0.5 },
  uNight: { value: 0 },
  uGlow: { value: 0 },
  uDaylight: { value: 1 },
  uKeyDir: { value: env.keyDir },
  uSunColor: { value: env.sunColor },
  uSunIntensity: { value: 1 },
  uFogColor: { value: env.fogColor },
  uWaterShallow: { value: env.waterShallow },
  uWaterDeep: { value: env.waterDeep },
  uBgTop: { value: env.bgTop },
  uBgBottom: { value: env.bgBottom },
};

let worldWeather: WeatherState = { kind: 'clear', intensity: 0 };
/** Public weather seam: a future weather system calls this. */
export function setWeather(w: WeatherState): void {
  worldWeather = { kind: w.kind, intensity: Math.max(0, Math.min(1, w.intensity)) };
}
export function getWeather(): WeatherState {
  return devOverrides.weather ?? worldWeather;
}

const tmpC = new Color();
function sampleKeys(hours: number): void {
  let i = 0;
  while (i < PARSED.length - 2 && PARSED[i + 1]!.h <= hours) i++;
  const a = PARSED[i]!;
  const b = PARSED[i + 1]!;
  const raw = (hours - a.h) / Math.max(1e-6, b.h - a.h);
  const t = raw * raw * (3 - 2 * raw);
  env.sunColor.copy(a.sun).lerp(b.sun, t);
  env.sunIntensity = a.sunI + (b.sunI - a.sunI) * t;
  env.moonIntensity = a.moonI + (b.moonI - a.moonI) * t;
  env.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  env.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  env.hemiIntensity = a.hemiI + (b.hemiI - a.hemiI) * t;
  env.bgTop.copy(a.bgTop).lerp(b.bgTop, t);
  env.bgBottom.copy(a.bgBottom).lerp(b.bgBottom, t);
  env.fogColor.copy(a.fog).lerp(b.fog, t);
  env.waterShallow.copy(a.waterShallow).lerp(b.waterShallow, t);
  env.waterDeep.copy(a.waterDeep).lerp(b.waterDeep, t);
  env.glow = a.glow + (b.glow - a.glow) * t;
}

function applyWeather(w: WeatherState): void {
  env.weather = w;
  env.fogDensity = 1;
  env.wind = 0.5;
  if (w.kind === 'haze' || w.kind === 'fog') {
    const k = w.kind === 'fog' ? 1 : 0.45;
    const s = w.intensity * k;
    env.fogDensity = 1 + s * 5;
    tmpC.set('#c9cfd2').lerp(env.fogColor, 0.35 + env.night * 0.5);
    env.fogColor.lerp(tmpC, s * 0.8);
    env.sunIntensity *= 1 - s * 0.55;
    env.bgTop.lerp(env.fogColor, s * 0.7);
    env.bgBottom.lerp(env.fogColor, s * 0.8);
    env.hemiIntensity *= 1 + s * 0.15;
  }
  // rain / snow: not implemented yet (seam) — would add particles, wet ground and dimming here.
}

/** Recompute the environment for a given time of day (0..1). */
export function updateEnvironment(timeOfDay: number, dt: number): void {
  env.time += dt;
  env.timeOfDay = timeOfDay;
  env.hours = timeOfDay * 24;
  env.phase = phaseForHours(env.hours).phase;
  env.daylight = daylight(timeOfDay);
  env.lightsOn = lightsShouldBeOn(env.phase);
  sampleKeys(env.hours);
  env.night = Math.max(0, Math.min(1, 1 - env.daylight * 1.6));

  // Sun path. Elevation comes from the shared sunAngles(); azimuth is mapped for the
  // isometric camera so morning light comes from the east (screen right), noon from
  // behind (north, screen up) and the evening sun from the west (screen upper-left).
  const { elevation } = sunAngles(timeOfDay);
  env.sunElevation = elevation;
  const a = (timeOfDay - 0.25) * Math.PI * 2; // 0 at sunrise, PI at sunset
  const yaw = Math.PI / 2 + Math.max(-0.3, Math.min(Math.PI + 0.3, a)) * 0.95;
  const el = Math.max(0.4, elevation);
  env.sunDir.set(Math.sin(yaw) * Math.cos(el), Math.sin(el), Math.cos(yaw) * Math.cos(el)).normalize();
  if (env.sunIntensity > 0.05 || elevation > 0) {
    env.keyDir.copy(env.sunDir);
  } else {
    // Moon: high in the north-west so night shadows still read.
    env.keyDir.set(-0.45, 0.78, -0.42).normalize();
  }

  applyWeather(getWeather());

  uniforms.uTime.value = env.time;
  uniforms.uWind.value = env.wind;
  uniforms.uNight.value = env.night;
  uniforms.uGlow.value = env.glow;
  uniforms.uDaylight.value = env.daylight;
  uniforms.uSunIntensity.value = env.sunIntensity;
}
