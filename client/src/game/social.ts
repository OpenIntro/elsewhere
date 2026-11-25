/**
 * In-world social feed for the overlay: speech bubbles (from S2C.chat
 * proximity/global lines), reactions (S2C.reaction) and emote pings.
 * Module-level and bounded; blocked/muted profiles are filtered here too.
 */
import { CONFIG, S2C, type ChatMessage, type ReactionEmoji } from '@elsewhere/shared';
import { net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';

export interface Bubble {
  text: string;
  /** performance.now() */
  at: number;
  until: number;
  id: string;
}

export interface FloatingReaction {
  sessionId: string;
  emoji: ReactionEmoji;
  at: number;
  /** Small horizontal offset so simultaneous reactions don't overlap. */
  lane: number;
}

export const REACTION_MS = CONFIG.emotes.reactionDurationMs;
const MAX_REACTIONS = 24;
const MAX_REACTIONS_PER_PLAYER = 3;

export const bubbles = new Map<string, Bubble>();
export const reactions: FloatingReaction[] = [];

function hidden(profileId: string): boolean {
  const g = useGameStore.getState();
  return !!profileId && (g.blocked.includes(profileId) || g.muted.includes(profileId));
}

/** Bubble duration grows a little with length (reading time), within limits. */
export function bubbleDuration(text: string): number {
  return Math.min(CONFIG.chat.bubbleDurationMs * 1.6, Math.max(3500, CONFIG.chat.bubbleDurationMs * 0.6 + text.length * 45));
}

export function addBubble(sessionId: string, text: string, id = '', now = performance.now()): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  bubbles.set(sessionId, { text: clean, at: now, until: now + bubbleDuration(clean), id });
}

export function addReaction(sessionId: string, emoji: ReactionEmoji, now = performance.now()): void {
  let mine = 0;
  for (const r of reactions) if (r.sessionId === sessionId && now - r.at < REACTION_MS) mine++;
  if (mine >= MAX_REACTIONS_PER_PLAYER) {
    const i = reactions.findIndex((r) => r.sessionId === sessionId);
    if (i >= 0) reactions.splice(i, 1);
  }
  reactions.push({ sessionId, emoji, at: now, lane: mine });
  while (reactions.length > MAX_REACTIONS) reactions.shift();
}

/** Drop expired entries (called by the overlay a few times a second). */
export function pruneSocial(now = performance.now()): void {
  for (const [id, b] of bubbles) if (now > b.until) bubbles.delete(id);
  let w = 0;
  for (let i = 0; i < reactions.length; i++) {
    const r = reactions[i]!;
    if (now - r.at < REACTION_MS) reactions[w++] = r;
  }
  reactions.length = w;
}

function onChat(m: ChatMessage): void {
  if (m.channel !== 'proximity' && m.channel !== 'global') return;
  if (!m.from || hidden(m.fromProfileId)) return;
  addBubble(m.from, m.text, m.id);
}

let installed = 0;
let offs: (() => void)[] = [];
export function installSocialFeed(): () => void {
  if (installed++ === 0) {
    offs = [
      net.on(S2C.chat, onChat),
      net.on(S2C.reaction, (r) => {
        const g = useGameStore.getState();
        const from = g.players[r.sessionId];
        if (from && hidden(from.profileId)) return;
        addReaction(r.target && g.players[r.target] ? r.target : r.sessionId, r.emoji);
      }),
      net.onLifecycle((e) => {
        if (e === 'joined') {
          bubbles.clear();
          reactions.length = 0;
        }
      }),
    ];
  }
  return () => {
    if (--installed === 0) {
      for (const o of offs) o();
      offs = [];
    }
  };
}
