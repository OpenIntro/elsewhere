import { describe, expect, it } from 'vitest';
import { extractMentions, worldTimeAt, type ChatMessage, type WorldEvent } from '@elsewhere/shared';
import { activeMentionQuery, applyMention, mentionCandidates, mentionToken, mentionsName, segmentMentions } from '../src/ui/lib/mentions.js';
import { ToastQueue } from '../src/ui/lib/toastQueue.js';
import { describeEvent, formatRelative, formatWorldClock, phaseLabel, worldDateAt, worldDayLabel } from '../src/ui/lib/format.js';
import { conversations, inTab, unreadFor, visibleMessages } from '../src/ui/lib/chatModel.js';

describe('mentions', () => {
  it('finds the active @query at the caret', () => {
    expect(activeMentionQuery('hi @Mo')).toEqual({ start: 3, query: 'Mo', quoted: false });
    expect(activeMentionQuery('@')).toEqual({ start: 0, query: '', quoted: false });
    expect(activeMentionQuery('hi @"Mossy He')).toEqual({ start: 3, query: 'Mossy He', quoted: true });
    expect(activeMentionQuery('mail a@b')).toBeNull();
    expect(activeMentionQuery('hi @Mo there')).toBeNull();
    expect(activeMentionQuery('hi @Mo there', 6)).toEqual({ start: 3, query: 'Mo', quoted: false });
  });

  it('ranks candidates: prefix, then word-prefix, then substring; excludes self', () => {
    const names = ['Mossy Heron', 'Quiet Moth', 'Amber Fern', 'mossy heron', 'Me'];
    expect(mentionCandidates('mo', names, 5, 'Me')).toEqual(['Mossy Heron', 'Quiet Moth']);
    expect(mentionCandidates('er', names)).toEqual(['Amber Fern', 'Mossy Heron']);
    expect(mentionCandidates('', names, 2)).toHaveLength(2);
  });

  it('applies a mention in the wire format extractMentions understands', () => {
    const q = activeMentionQuery('hello @mos')!;
    const r = applyMention('hello @mos', q, 10, 'Mossy Heron');
    expect(r.text).toBe('hello @"Mossy Heron" ');
    expect(r.caret).toBe(r.text.length);
    expect(extractMentions(r.text)).toEqual(['mossy heron']);
    expect(mentionToken('Fern')).toBe('@Fern');
    expect(extractMentions(`${mentionToken('Fern')} hi`)).toEqual(['fern']);
  });

  it('segments text and flags self mentions', () => {
    const segs = segmentMentions('hey @Fern and @"Mossy Heron"!', 'mossy heron');
    expect(segs.map((s) => s.text)).toEqual(['hey ', '@Fern', ' and ', '@Mossy Heron', '!']);
    expect(segs[1]!.mention).toBe('fern');
    expect(segs[3]!.self).toBe(true);
    expect(segmentMentions('mail a@b.com')).toEqual([{ text: 'mail a@b.com' }]);
    expect(mentionsName(['fern'], '', 'Fern')).toBe(true);
    expect(mentionsName([], 'yo @Fern', 'Fern')).toBe(true);
    expect(mentionsName([], 'yo', null)).toBe(false);
  });
});

describe('ToastQueue', () => {
  it('shows at most maxVisible and promotes waiting toasts when others expire', () => {
    const q = new ToastQueue({ maxVisible: 2, defaultTtlMs: 1000 });
    q.push({ id: 1, level: 'info', text: 'a' }, 0);
    q.push({ id: 2, level: 'info', text: 'b' }, 0);
    q.push({ id: 3, level: 'world', text: 'c' }, 0);
    expect(q.visible().map((t) => t.id)).toEqual([1, 2]);
    expect(q.pending).toBe(1);
    // Lifetime of #3 starts only when it is shown.
    expect(q.tick(1000).map((t) => t.id)).toEqual([3]);
    expect(q.tick(1999).map((t) => t.id)).toEqual([3]);
    expect(q.tick(2000)).toEqual([]);
  });

  it('collapses duplicates and supports dismiss + deadlines', () => {
    const q = new ToastQueue({ maxVisible: 1, defaultTtlMs: 1000 });
    q.push({ id: 1, level: 'warning', text: 'slow down' }, 0);
    q.push({ id: 2, level: 'warning', text: 'slow down' }, 500);
    expect(q.visible()).toHaveLength(1);
    expect(q.visible()[0]!.count).toBe(2);
    expect(q.nextDeadline(600)).toBe(900);
    q.push({ id: 3, level: 'info', text: 'other' }, 600);
    q.dismiss(1, 700);
    expect(q.visible().map((t) => t.id)).toEqual([3]);
  });

  it('caps the waiting list, dropping info before important items', () => {
    const q = new ToastQueue({ maxVisible: 1, maxQueued: 2 });
    q.push({ id: 0, level: 'world', text: 'shown' }, 0);
    q.push({ id: 1, level: 'world', text: 'w1' }, 0);
    q.push({ id: 2, level: 'info', text: 'i1' }, 0);
    q.push({ id: 3, level: 'world', text: 'w2' }, 0);
    expect(q.pending).toBe(2);
    q.dismiss(0, 1);
    expect(q.visible()[0]!.id).toBe(1);
  });
});

describe('clock + formatting', () => {
  const clock = { epochMs: 0, dayLengthMs: 24 * 60_000, startTimeOfDay: 0 };
  it('formats world time in 24h and 12h', () => {
    const wt = worldTimeAt(13.5 * 60_000, clock); // 13:30
    expect(formatWorldClock(wt)).toBe('13:30');
    expect(formatWorldClock(wt, '12h')).toBe('1:30 pm');
    expect(formatWorldClock(worldTimeAt(0, clock), '12h')).toBe('12:00 am');
    expect(phaseLabel(wt.phase)).toBe('Midday');
  });
  it('labels world days and dates', () => {
    expect(worldDayLabel(0)).toBe('Day 0');
    expect(worldDayLabel(3)).toBe('Day 3');
    expect(worldDateAt(0, { epochMs: 0, dayLengthMs: 60_000 })).toMatch(/^Day 0 · /);
  });
  it('formats relative times', () => {
    expect(formatRelative(0, 10_000)).toBe('just now');
    expect(formatRelative(0, 5 * 60_000)).toBe('5 min ago');
    expect(formatRelative(0, 3 * 3600_000)).toBe('3 h ago');
    expect(formatRelative(0, 26 * 3600_000)).toBe('yesterday');
  });
  it('describes world events from recorded fields only', () => {
    const e: WorldEvent = { id: '1', ts: 0, kind: 'bell_rung', actors: [{ profileId: 'p', name: 'Fern' }], significance: 1 };
    expect(describeEvent(e)).toBe('Fern rang the Town Hall bell.');
    expect(describeEvent({ ...e, kind: 'secret_found', data: { discoveryId: 'music_box' }, locationId: 'woods' })).toBe('Fern found the Music Box at The Woods.');
    expect(describeEvent({ ...e, kind: 'dance_party', actors: [{ profileId: 'a', name: 'A' }, { profileId: 'b', name: 'B' }, { profileId: 'c', name: 'C' }] })).toBe('A, B and C danced together.');
  });
});

describe('chat model', () => {
  const msg = (p: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(), channel: 'global', from: 's2', fromProfileId: 'p2', fromName: 'Fern', text: 'hi', ts: 10, mentions: [], ...p });
  it('routes channels to tabs (system lines in both public tabs)', () => {
    expect(inTab(msg({ channel: 'proximity' }), 'nearby')).toBe(true);
    expect(inTab(msg({ channel: 'system' }), 'town')).toBe(true);
    expect(inTab(msg({ channel: 'system' }), 'whispers')).toBe(false);
  });
  it('counts unread per tab and per whisper conversation', () => {
    const log = [
      msg({ channel: 'global', ts: 5 }),
      msg({ channel: 'global', ts: 20 }),
      msg({ channel: 'global', from: 'me', ts: 30 }),
      msg({ channel: 'private', to: 'me', ts: 40 }),
      msg({ channel: 'private', from: 'me', to: 's2', toName: 'Fern', ts: 50 }),
    ];
    expect(unreadFor(log, 'town', 'me', { town: 10 })).toBe(1);
    expect(unreadFor(log, 'whispers', 'me', {})).toBe(1);
    const convs = conversations(log, 'me', { 'w:s2': 45 });
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ sessionId: 's2', name: 'Fern', unread: 0, lastTs: 50 });
  });
  it('hides muted/blocked senders', () => {
    expect(visibleMessages([msg({}), msg({ fromProfileId: 'x' })], new Set(['x']))).toHaveLength(1);
  });
});
