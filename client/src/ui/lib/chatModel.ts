/**
 * Chat log → tabs/conversations/unread (pure, unit-tested).
 * Tabs: Nearby (proximity), Town (global), Whispers (private, per-conversation).
 * System lines show in Nearby and Town.
 */
import type { ChatMessage } from '@elsewhere/shared';

export type ChatTab = 'nearby' | 'town' | 'whispers';

export const CHAT_TABS: readonly { id: ChatTab; label: string }[] = [
  { id: 'nearby', label: 'Nearby' },
  { id: 'town', label: 'Town' },
  { id: 'whispers', label: 'Whispers' },
];

export function tabOf(m: ChatMessage): ChatTab | 'both' {
  switch (m.channel) {
    case 'proximity':
      return 'nearby';
    case 'global':
      return 'town';
    case 'private':
      return 'whispers';
    default:
      return 'both';
  }
}

export function inTab(m: ChatMessage, tab: ChatTab): boolean {
  const t = tabOf(m);
  return t === tab || (t === 'both' && tab !== 'whispers');
}

/** The other party of a private message from my point of view. */
export function whisperPeer(m: ChatMessage, mySessionId: string | null): { sessionId: string; name: string } | null {
  if (m.channel !== 'private') return null;
  if (m.from === mySessionId) return { sessionId: m.to ?? '', name: m.toName ?? 'someone' };
  return { sessionId: m.from, name: m.fromName };
}

export interface Conversation {
  sessionId: string;
  name: string;
  lastTs: number;
  lastText: string;
  unread: number;
}

/** Whisper conversations, most recent first. `readAt` maps peer sessionId → last read ts. */
export function conversations(log: readonly ChatMessage[], mySessionId: string | null, readAt: Readonly<Record<string, number>>): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const m of log) {
    const peer = whisperPeer(m, mySessionId);
    if (!peer || !peer.sessionId) continue;
    const c = map.get(peer.sessionId) ?? { sessionId: peer.sessionId, name: peer.name, lastTs: 0, lastText: '', unread: 0 };
    c.name = peer.name || c.name;
    c.lastTs = m.ts;
    c.lastText = m.text;
    if (m.from !== mySessionId && m.ts > (readAt[`w:${peer.sessionId}`] ?? 0)) c.unread += 1;
    map.set(peer.sessionId, c);
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
}

/** Unread count for a tab: messages from others newer than the tab's read mark. */
export function unreadFor(log: readonly ChatMessage[], tab: ChatTab, mySessionId: string | null, readAt: Readonly<Record<string, number>>): number {
  if (tab === 'whispers') return conversations(log, mySessionId, readAt).reduce((n, c) => n + c.unread, 0);
  const mark = readAt[tab] ?? 0;
  let n = 0;
  for (const m of log) if (m.channel !== 'system' && inTab(m, tab) && m.from !== mySessionId && m.ts > mark) n++;
  return n;
}

/** Hide lines from muted/blocked profiles (server filters too; this is belt and braces). */
export function visibleMessages(log: readonly ChatMessage[], hidden: ReadonlySet<string>): ChatMessage[] {
  return hidden.size ? log.filter((m) => !m.fromProfileId || !hidden.has(m.fromProfileId)) : [...log];
}
