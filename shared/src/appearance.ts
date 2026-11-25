/**
 * Character appearance contract. Characters are toy-like and procedural, so an
 * appearance is just a set of catalog ids + palette colours. The characters
 * worker renders from these ids; the UI customization screen offers these
 * catalogs; the server sanitizes everything through `sanitizeAppearance`.
 */
import { CONFIG } from './config.js';
import { mulberry32 } from './math.js';

export interface CatalogOption {
  id: string;
  label: string;
}

export interface ColorOption {
  id: string;
  label: string;
  /** CSS hex, e.g. "#c9a27e". */
  hex: string;
}

/** Body silhouettes. The renderer maps these to proportions. */
export const BODY_OPTIONS = [
  { id: 'round', label: 'Round' },
  { id: 'tall', label: 'Tall' },
  { id: 'small', label: 'Small' },
  { id: 'sturdy', label: 'Sturdy' },
] as const satisfies readonly CatalogOption[];

export const SKIN_TONES = [
  { id: 'porcelain', label: 'Porcelain', hex: '#f3dccb' },
  { id: 'peach', label: 'Peach', hex: '#ecc3a3' },
  { id: 'sand', label: 'Sand', hex: '#d9a982' },
  { id: 'honey', label: 'Honey', hex: '#c08a5c' },
  { id: 'umber', label: 'Umber', hex: '#93613f' },
  { id: 'cocoa', label: 'Cocoa', hex: '#6b4430' },
  { id: 'espresso', label: 'Espresso', hex: '#4a2e22' },
  { id: 'sage', label: 'Sage (fantasy)', hex: '#a9b79a' },
] as const satisfies readonly ColorOption[];

export const HAIR_STYLES = [
  { id: 'none', label: 'None' },
  { id: 'buzz', label: 'Buzz' },
  { id: 'bob', label: 'Bob' },
  { id: 'bun', label: 'Bun' },
  { id: 'curly', label: 'Curly' },
  { id: 'long', label: 'Long' },
  { id: 'ponytail', label: 'Ponytail' },
  { id: 'swoop', label: 'Swoop' },
  { id: 'spiky', label: 'Spiky' },
  { id: 'afro', label: 'Cloud' },
  { id: 'pigtails', label: 'Pigtails' },
  { id: 'mohawk', label: 'Crest' },
] as const satisfies readonly CatalogOption[];

export const HAIR_COLORS = [
  { id: 'ink', label: 'Ink', hex: '#2b2522' },
  { id: 'chestnut', label: 'Chestnut', hex: '#6a3f2a' },
  { id: 'auburn', label: 'Auburn', hex: '#9a4b2f' },
  { id: 'wheat', label: 'Wheat', hex: '#d4b27a' },
  { id: 'ash', label: 'Ash', hex: '#b9b2a7' },
  { id: 'snow', label: 'Snow', hex: '#ece7df' },
  { id: 'moss', label: 'Moss', hex: '#7d8a5a' },
  { id: 'dusk', label: 'Dusk Rose', hex: '#b9788a' },
  { id: 'tide', label: 'Tide', hex: '#5f7f8f' },
] as const satisfies readonly ColorOption[];

export const FACE_OPTIONS = [
  { id: 'smile', label: 'Smile' },
  { id: 'calm', label: 'Calm' },
  { id: 'grin', label: 'Grin' },
  { id: 'sleepy', label: 'Sleepy' },
  { id: 'surprised', label: 'Surprised' },
  { id: 'wink', label: 'Wink' },
  { id: 'button', label: 'Button' },
  { id: 'starry', label: 'Starry' },
  { id: 'grumpy', label: 'Grumpy' },
] as const satisfies readonly CatalogOption[];

/** Warm, muted clothing palette shared by shirt / pants / shoes. */
export const CLOTHING_COLORS = [
  { id: 'cream', label: 'Cream', hex: '#efe4cf' },
  { id: 'oat', label: 'Oat', hex: '#d8c6a4' },
  { id: 'terracotta', label: 'Terracotta', hex: '#c46f4f' },
  { id: 'rust', label: 'Rust', hex: '#a2512f' },
  { id: 'mustard', label: 'Mustard', hex: '#d1a23f' },
  { id: 'olive', label: 'Olive', hex: '#7e8452' },
  { id: 'sage', label: 'Sage', hex: '#9fae8c' },
  { id: 'teal', label: 'Teal', hex: '#4f7f7a' },
  { id: 'slate', label: 'Slate', hex: '#5d6b7a' },
  { id: 'plum', label: 'Plum', hex: '#7a4e64' },
  { id: 'rose', label: 'Dusty Rose', hex: '#c79195' },
  { id: 'charcoal', label: 'Charcoal', hex: '#3e3b3a' },
] as const satisfies readonly ColorOption[];

export const SHIRT_STYLES = [
  { id: 'tee', label: 'T-shirt' },
  { id: 'sweater', label: 'Sweater' },
  { id: 'overalls', label: 'Overalls' },
  { id: 'jacket', label: 'Jacket' },
  { id: 'dress', label: 'Dress' },
] as const satisfies readonly CatalogOption[];

export const PANTS_STYLES = [
  { id: 'trousers', label: 'Trousers' },
  { id: 'shorts', label: 'Shorts' },
  { id: 'skirt', label: 'Skirt' },
] as const satisfies readonly CatalogOption[];

export const SHOE_STYLES = [
  { id: 'sneakers', label: 'Sneakers' },
  { id: 'boots', label: 'Boots' },
  { id: 'sandals', label: 'Sandals' },
] as const satisfies readonly CatalogOption[];

/** Accessories: each slot independent so they can be combined. */
export const HAT_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'beanie', label: 'Beanie' },
  { id: 'cap', label: 'Cap' },
  { id: 'sunhat', label: 'Sun hat' },
  { id: 'beret', label: 'Beret' },
  { id: 'flower', label: 'Flower' },
  { id: 'bucket', label: 'Bucket hat' },
  { id: 'sprout', label: 'Sprout' },
  { id: 'headphones', label: 'Headphones' },
] as const satisfies readonly CatalogOption[];

export const EYEWEAR_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'round', label: 'Round glasses' },
  { id: 'square', label: 'Square glasses' },
  { id: 'shades', label: 'Sunglasses' },
  { id: 'monocle', label: 'Monocle' },
] as const satisfies readonly CatalogOption[];

export const NECK_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'scarf', label: 'Scarf' },
  { id: 'bowtie', label: 'Bow tie' },
  { id: 'pendant', label: 'Pendant' },
] as const satisfies readonly CatalogOption[];

export const BACK_OPTIONS = [
  { id: 'none', label: 'None' },
  { id: 'backpack', label: 'Backpack' },
  { id: 'satchel', label: 'Satchel' },
] as const satisfies readonly CatalogOption[];

type Ids<T extends readonly { id: string }[]> = T[number]['id'];

export type BodyId = Ids<typeof BODY_OPTIONS>;
export type SkinToneId = Ids<typeof SKIN_TONES>;
export type HairStyleId = Ids<typeof HAIR_STYLES>;
export type HairColorId = Ids<typeof HAIR_COLORS>;
export type FaceId = Ids<typeof FACE_OPTIONS>;
export type ClothingColorId = Ids<typeof CLOTHING_COLORS>;
export type ShirtStyleId = Ids<typeof SHIRT_STYLES>;
export type PantsStyleId = Ids<typeof PANTS_STYLES>;
export type ShoeStyleId = Ids<typeof SHOE_STYLES>;
export type HatId = Ids<typeof HAT_OPTIONS>;
export type EyewearId = Ids<typeof EYEWEAR_OPTIONS>;
export type NeckId = Ids<typeof NECK_OPTIONS>;
export type BackId = Ids<typeof BACK_OPTIONS>;

export interface Accessories {
  hat: HatId;
  eyewear: EyewearId;
  neck: NeckId;
  back: BackId;
}

export interface Appearance {
  body: BodyId;
  skin: SkinToneId;
  hairStyle: HairStyleId;
  hairColor: HairColorId;
  face: FaceId;
  shirtStyle: ShirtStyleId;
  shirtColor: ClothingColorId;
  pantsStyle: PantsStyleId;
  pantsColor: ClothingColorId;
  shoeStyle: ShoeStyleId;
  shoeColor: ClothingColorId;
  accessories: Accessories;
}

/** Catalog per slot; drives the customization UI and validation. */
export const APPEARANCE_CATALOG = {
  body: BODY_OPTIONS,
  skin: SKIN_TONES,
  hairStyle: HAIR_STYLES,
  hairColor: HAIR_COLORS,
  face: FACE_OPTIONS,
  shirtStyle: SHIRT_STYLES,
  shirtColor: CLOTHING_COLORS,
  pantsStyle: PANTS_STYLES,
  pantsColor: CLOTHING_COLORS,
  shoeStyle: SHOE_STYLES,
  shoeColor: CLOTHING_COLORS,
} as const;

export const ACCESSORY_CATALOG = {
  hat: HAT_OPTIONS,
  eyewear: EYEWEAR_OPTIONS,
  neck: NECK_OPTIONS,
  back: BACK_OPTIONS,
} as const;

export type AppearanceSlot = keyof typeof APPEARANCE_CATALOG;
export type AccessorySlot = keyof typeof ACCESSORY_CATALOG;

export const DEFAULT_APPEARANCE: Appearance = {
  body: 'round',
  skin: 'sand',
  hairStyle: 'bob',
  hairColor: 'chestnut',
  face: 'smile',
  shirtStyle: 'sweater',
  shirtColor: 'terracotta',
  pantsStyle: 'trousers',
  pantsColor: 'oat',
  shoeStyle: 'sneakers',
  shoeColor: 'charcoal',
  accessories: { hat: 'none', eyewear: 'none', neck: 'none', back: 'none' },
};

function pickValid<T extends readonly { id: string }[]>(catalog: T, value: unknown, fallback: T[number]['id']): T[number]['id'] {
  if (typeof value === 'string' && catalog.some((o) => o.id === value)) return value as T[number]['id'];
  return fallback;
}

/** Coerce any untrusted input into a valid Appearance (unknown ids fall back to defaults). */
export function sanitizeAppearance(input: unknown): Appearance {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const acc = (src.accessories && typeof src.accessories === 'object' ? src.accessories : {}) as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  return {
    body: pickValid(BODY_OPTIONS, src.body, d.body),
    skin: pickValid(SKIN_TONES, src.skin, d.skin),
    hairStyle: pickValid(HAIR_STYLES, src.hairStyle, d.hairStyle),
    hairColor: pickValid(HAIR_COLORS, src.hairColor, d.hairColor),
    face: pickValid(FACE_OPTIONS, src.face, d.face),
    shirtStyle: pickValid(SHIRT_STYLES, src.shirtStyle, d.shirtStyle),
    shirtColor: pickValid(CLOTHING_COLORS, src.shirtColor, d.shirtColor),
    pantsStyle: pickValid(PANTS_STYLES, src.pantsStyle, d.pantsStyle),
    pantsColor: pickValid(CLOTHING_COLORS, src.pantsColor, d.pantsColor),
    shoeStyle: pickValid(SHOE_STYLES, src.shoeStyle, d.shoeStyle),
    shoeColor: pickValid(CLOTHING_COLORS, src.shoeColor, d.shoeColor),
    accessories: {
      hat: pickValid(HAT_OPTIONS, acc.hat, d.accessories.hat),
      eyewear: pickValid(EYEWEAR_OPTIONS, acc.eyewear, d.accessories.eyewear),
      neck: pickValid(NECK_OPTIONS, acc.neck, d.accessories.neck),
      back: pickValid(BACK_OPTIONS, acc.back, d.accessories.back),
    },
  };
}

/** Random but tasteful appearance. Pass a seed for determinism (e.g. tests, NPC previews). */
export function randomAppearance(seed?: number): Appearance {
  const rnd = seed === undefined ? Math.random : mulberry32(seed);
  const pick = <T extends readonly { id: string }[]>(c: T, noneBias = 0): T[number]['id'] => {
    if (noneBias > 0 && rnd() < noneBias) return 'none' as T[number]['id'];
    return c[Math.floor(rnd() * c.length)]!.id;
  };
  // Keep shirt and pants from matching exactly.
  const shirtColor = pick(CLOTHING_COLORS);
  let pantsColor = pick(CLOTHING_COLORS);
  if (pantsColor === shirtColor) pantsColor = shirtColor === 'charcoal' ? 'oat' : 'charcoal';
  return {
    body: pick(BODY_OPTIONS),
    skin: pick(SKIN_TONES.filter((s) => s.id !== 'sage')),
    hairStyle: pick(HAIR_STYLES),
    hairColor: pick(HAIR_COLORS),
    face: pick(FACE_OPTIONS),
    shirtStyle: pick(SHIRT_STYLES),
    shirtColor,
    pantsStyle: pick(PANTS_STYLES),
    pantsColor,
    shoeStyle: pick(SHOE_STYLES),
    shoeColor: pick(CLOTHING_COLORS),
    accessories: {
      hat: pick(HAT_OPTIONS, 0.6),
      eyewear: pick(EYEWEAR_OPTIONS, 0.7),
      neck: pick(NECK_OPTIONS, 0.7),
      back: pick(BACK_OPTIONS, 0.7),
    },
  };
}

/** Resolve a colour id to its hex (falls back to mid grey). */
export function colorHex(catalog: readonly ColorOption[], id: string): string {
  return catalog.find((c) => c.id === id)?.hex ?? '#888888';
}

export function appearanceEquals(a: Appearance, b: Appearance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

export type DisplayNameResult = { ok: true; name: string } | { ok: false; reason: DisplayNameError };
export type DisplayNameError = 'too_short' | 'too_long' | 'invalid_characters' | 'reserved';

const RESERVED_NAMES = ['admin', 'moderator', 'mod', 'system', 'elsewhere', 'server', 'gazette', 'staff', 'official'];

/**
 * Normalizes + validates a display name. Allowed: letters (any script), digits,
 * spaces, and . _ - ' . Whitespace is collapsed. Profanity filtering lives in
 * server moderation, not here.
 */
export function validateDisplayName(raw: unknown): DisplayNameResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'too_short' };
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  const { displayNameMin, displayNameMax } = CONFIG.profile;
  if ([...name].length < displayNameMin) return { ok: false, reason: 'too_short' };
  if ([...name].length > displayNameMax) return { ok: false, reason: 'too_long' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(name)) return { ok: false, reason: 'invalid_characters' };
  const lower = name.toLowerCase().replace(/[^a-z]/g, '');
  if (RESERVED_NAMES.includes(lower)) return { ok: false, reason: 'reserved' };
  return { ok: true, name };
}

const NAME_ADJECTIVES = ['Quiet', 'Sunny', 'Wandering', 'Mossy', 'Gentle', 'Curious', 'Amber', 'Misty', 'Little', 'Velvet', 'Brave', 'Drifting'];
const NAME_NOUNS = ['Fern', 'Otter', 'Lantern', 'Pebble', 'Sparrow', 'Willow', 'Comet', 'Teacup', 'Heron', 'Maple', 'Biscuit', 'Moth'];

/** Friendly random guest name, e.g. "Mossy Heron". */
export function randomDisplayName(seed?: number): string {
  const rnd = seed === undefined ? Math.random : mulberry32(seed);
  const a = NAME_ADJECTIVES[Math.floor(rnd() * NAME_ADJECTIVES.length)]!;
  const n = NAME_NOUNS[Math.floor(rnd() * NAME_NOUNS.length)]!;
  return `${a} ${n}`;
}

/** Parse the JSON appearance string carried in PlayerStateView.appearance (always returns a valid Appearance). */
export function parseAppearanceJson(json: string): Appearance {
  try {
    return sanitizeAppearance(JSON.parse(json));
  } catch {
    return { ...DEFAULT_APPEARANCE, accessories: { ...DEFAULT_APPEARANCE.accessories } };
  }
}
