/**
 * User text hygiene: normalization, invisible/control character stripping and
 * a basic profanity mask. Pure (unit-tested).
 */

// C0/C1 controls, zero-width chars, bidi overrides/isolates, BOM, interlinear annotation, tag chars.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]|\udb40[\udc00-\udc7f]/g;
// Stacked combining marks ("zalgo"): keep at most 2 per base character.
const ZALGO = /(\p{M}{2})\p{M}+/gu;

/** Normalize, strip invisible/control chars, collapse whitespace, trim. Newlines become spaces. */
export function sanitizeText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, 4000)
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(ZALGO, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Like sanitizeText but keeps line breaks (max 2 in a row) — for mail notes. */
export function sanitizeMultiline(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .slice(0, 4000)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\t/g, ' ').replace(INVISIBLE, '').replace(ZALGO, '$1').replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Basic word list (stems). Matched on word starts, tolerant of common
 * leetspeak substitutions and repeated letters. Intentionally small: this is
 * a courtesy filter, not a moderation system; reports/mutes/blocks do the rest.
 */
const STEMS = ['fuck', 'shit', 'cunt', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'retard', 'kike', 'twat', 'wank', 'cock', 'motherfucker'];
const LEET: Record<string, string> = { a: '[a@4]', i: '[i1!|]', o: '[o0]', e: '[e3]', s: '[s$5]', t: '[t7]', g: '[g9]', u: '[uv]', c: '[ck]', k: '[kc]' };
const stemPattern = (stem: string) =>
  [...stem]
    .map((ch) => `${LEET[ch] ?? ch}+`)
    .join('[\\W_]?');
const SUFFIX = '(?:s|es|ed|er|ers|ing|in|y|ty|ties|ies|head|heads|face|hole|holes|wit|tard)?';
const PROFANITY = new RegExp(`(?<![\\p{L}\\p{N}])(?:${STEMS.sort((a, b) => b.length - a.length).map(stemPattern).join('|')})${SUFFIX}(?![\\p{L}\\p{N}])`, 'giu');
/** Words that match a stem + suffix but are fine. */
const ALLOWED = new Set(['dicky', 'cocky', 'cocker', 'cockers', 'dicker', 'dickers']);

export function maskProfanity(text: string): string {
  return text.replace(PROFANITY, (m) => (ALLOWED.has(m.toLowerCase()) ? m : m[0] + '*'.repeat(Math.max(1, [...m].length - 1))));
}

export function containsProfanity(text: string): boolean {
  PROFANITY.lastIndex = 0;
  for (const m of text.matchAll(PROFANITY)) if (!ALLOWED.has(m[0].toLowerCase())) return true;
  return false;
}

/** Full pipeline used for chat, mail and report details. */
export function filterText(raw: unknown): string {
  return maskProfanity(sanitizeText(raw));
}
