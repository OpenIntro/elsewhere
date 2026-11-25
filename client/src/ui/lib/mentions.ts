/**
 * Pure @mention helpers for the chat input and log (no DOM, unit-tested).
 * Wire format matches shared `extractMentions`: `@Name` for single words,
 * `@"Two Words"` when the name has spaces or underscores.
 */

export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number;
  /** What has been typed after "@" (without a leading quote). */
  query: string;
  quoted: boolean;
}

/** The @token the caret is currently inside/after, or null. */
export function activeMentionQuery(text: string, caret: number = text.length): MentionQuery | null {
  const before = text.slice(0, caret);
  // Quoted form: @"partial name (no closing quote yet)
  const quoted = /(^|[\s(])@"([^"]{0,20})$/u.exec(before);
  if (quoted) {
    const start = before.length - quoted[2]!.length - 2;
    return { start, query: quoted[2]!, quoted: true };
  }
  const bare = /(^|[\s(])@([\p{L}\p{N}._'-]{0,20})$/u.exec(before);
  if (bare) {
    const start = before.length - bare[2]!.length - 1;
    return { start, query: bare[2]!, quoted: false };
  }
  return null;
}

/**
 * Candidate names for a query: prefix matches (by whole name or any word)
 * first, then substring matches; case-insensitive, de-duplicated, stable.
 */
export function mentionCandidates(query: string, names: readonly string[], max = 5, exclude?: string): string[] {
  const q = query.replace(/_/g, ' ').toLowerCase();
  const ex = exclude?.toLowerCase();
  const seen = new Set<string>();
  const prefix: string[] = [];
  const word: string[] = [];
  const sub: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === ex || seen.has(lower)) continue;
    seen.add(lower);
    if (lower.startsWith(q)) prefix.push(name);
    else if (lower.split(/\s+/).some((w) => w.startsWith(q))) word.push(name);
    else if (q && lower.includes(q)) sub.push(name);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  return [...prefix.sort(byName), ...word.sort(byName), ...sub.sort(byName)].slice(0, max);
}

/** Wire token for a display name. */
export function mentionToken(name: string): string {
  return /[\s_]/.test(name) ? `@"${name}"` : `@${name}`;
}

/** Replace the active query (start..caret) with the full mention; returns new text + caret. */
export function applyMention(text: string, q: MentionQuery, caret: number, name: string): { text: string; caret: number } {
  const token = `${mentionToken(name)} `;
  const after = text.slice(caret).replace(/^"/, '');
  const next = text.slice(0, q.start) + token + after.replace(/^\s/, '');
  return { text: next, caret: q.start + token.length };
}

export interface TextSegment {
  text: string;
  /** Lower-cased mentioned name, if this segment is a mention. */
  mention?: string;
  /** The mention refers to the local player. */
  self?: boolean;
}

const MENTION_RE = /@"([^"]{2,20})"|@([\p{L}\p{N}._'-]{2,20})/gu;

/** Split a message into plain/mention segments for highlighting. */
export function segmentMentions(text: string, myName?: string | null): TextSegment[] {
  const me = myName?.toLowerCase();
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const idx = m.index ?? 0;
    if (idx > 0 && !/[\s(]/u.test(text[idx - 1]!)) continue; // e-mail-like "a@b" is not a mention
    if (idx > last) out.push({ text: text.slice(last, idx) });
    const name = (m[1] ?? m[2] ?? '').replace(/_/g, ' ').trim().toLowerCase();
    const seg: TextSegment = { text: m[1] ? `@${m[1]}` : m[0], mention: name };
    if (me && name === me) seg.self = true;
    out.push(seg);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Does this message mention me (server-extracted list preferred, text fallback)? */
export function mentionsName(mentions: readonly string[] | undefined, text: string, myName: string | null | undefined): boolean {
  if (!myName) return false;
  const me = myName.toLowerCase();
  if (mentions?.includes(me)) return true;
  return segmentMentions(text, myName).some((s) => s.self);
}
