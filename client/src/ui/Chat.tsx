/**
 * Chat: collapsible panel with Nearby / Town / Whispers, unread badges,
 * @mention autocomplete + highlighting, reactions & emotes quick-bar,
 * timestamps, system lines, typing indicator, gentle rate-limit notices.
 * Enter opens/sends, Esc closes. Names open the player card.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { C2S, CONFIG, EMOTES, REACTIONS, type ChatMessage, type EmoteId } from '@elsewhere/shared';
import { net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { useUiStore } from '../state/uiStore.js';
import { CHAT_TABS, conversations, inTab, unreadFor, visibleMessages, type ChatTab } from './lib/chatModel.js';
import { formatChatTime } from './lib/format.js';
import { activeMentionQuery, applyMention, mentionCandidates, mentionsName, segmentMentions, type MentionQuery } from './lib/mentions.js';
import { useChatUi } from './localState.js';
import { Icon, type IconName } from './icons.js';
import { localChatLine } from './bridge.js';

const EMOTE_ICON: Record<EmoteId, IconName> = { wave: 'wave', dance: 'dance' };
const EMOTE_LABEL: Record<EmoteId, string> = { wave: 'Wave', dance: 'Dance' };

function useHiddenProfiles(): Set<string> {
  const blocked = useGameStore((s) => s.blocked);
  const muted = useGameStore((s) => s.muted);
  return useMemo(() => new Set([...blocked, ...muted]), [blocked, muted]);
}

/** Total unread across tabs (for the nav badge) + whether any unread line mentions me. */
export function useChatUnread(): { count: number; mention: boolean } {
  const log = useUiStore((s) => s.chatLog);
  const sid = useGameStore((s) => s.sessionId);
  const me = useGameStore((s) => s.profile?.name);
  const readAt = useChatUi((s) => s.readAt);
  const hidden = useHiddenProfiles();
  return useMemo(() => {
    const vis = visibleMessages(log, hidden);
    const count = CHAT_TABS.reduce((n, t) => n + unreadFor(vis, t.id, sid, readAt), 0);
    const mention = vis.some((m) => m.from !== sid && m.ts > (readAt[m.channel === 'global' ? 'town' : 'nearby'] ?? 0) && mentionsName(m.mentions, m.text, me));
    return { count, mention };
  }, [log, sid, readAt, hidden, me]);
}

const Line = memo(function Line({ m, myName, mySid, grouped, onName }: { m: ChatMessage; myName: string | null; mySid: string | null; grouped: boolean; onName(sid: string): void }) {
  if (m.channel === 'system' || !m.from) {
    return (
      <li className="line line--system">
        <span>{m.text}</span>
      </li>
    );
  }
  const mine = m.from === mySid;
  const self = !mine && mentionsName(m.mentions, m.text, myName);
  const segs = segmentMentions(m.text, myName);
  return (
    <li className={`line${grouped ? ' line--grouped' : ''}${self ? ' line--mention' : ''}${mine ? ' line--mine' : ''}`}>
      {!grouped ? (
        <div className="line__head">
          <button type="button" className="line__name" onClick={() => onName(m.from)}>
            {mine ? 'You' : m.fromName}
          </button>
          {m.channel === 'private' && mine && m.toName ? <span className="line__to">to {m.toName}</span> : null}
          <time className="line__time" dateTime={new Date(m.ts).toISOString()}>
            {formatChatTime(m.ts)}
          </time>
        </div>
      ) : null}
      <p className="line__text">
        {segs.map((s, i) =>
          s.mention ? (
            <mark key={i} className={`mention${s.self ? ' mention--me' : ''}`}>
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
    </li>
  );
});

function QuickBar({ onClose }: { onClose(): void }) {
  return (
    <div className="quickbar" role="toolbar" aria-label="Reactions and emotes">
      <div className="quickbar__row">
        {REACTIONS.map((r) => (
          <button
            key={r}
            type="button"
            className="quickbar__emoji"
            aria-label={`React ${r}`}
            onClick={() => {
              net.send(C2S.reaction, { emoji: r });
              onClose();
            }}
          >
            {r}
          </button>
        ))}
      </div>
      <div className="quickbar__row quickbar__row--emotes">
        {EMOTES.map((e) => (
          <button
            key={e}
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              net.send(C2S.emote, { emote: e });
              onClose();
            }}
          >
            <Icon name={EMOTE_ICON[e]} size={18} /> {EMOTE_LABEL[e]}
          </button>
        ))}
        <span className="quickbar__hint">Sit by walking up to a bench.</span>
      </div>
    </div>
  );
}

function WhisperList({ onPick }: { onPick(sid: string): void }) {
  const log = useUiStore((s) => s.chatLog);
  const sid = useGameStore((s) => s.sessionId);
  const players = useGameStore((s) => s.players);
  const readAt = useChatUi((s) => s.readAt);
  const convs = conversations(log, sid, readAt);
  const others = Object.values(players)
    .filter((p) => !p.isLocal && !convs.some((c) => c.sessionId === p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="whispers">
      {convs.length ? (
        <ul className="convs">
          {convs.map((c) => (
            <li key={c.sessionId}>
              <button type="button" className="conv" onClick={() => onPick(c.sessionId)}>
                <span className="conv__name">
                  {c.name}
                  {!players[c.sessionId] ? <span className="muted"> · left</span> : null}
                </span>
                <span className="conv__last">{c.lastText}</span>
                {c.unread ? <span className="badge">{c.unread}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="whispers__empty">Whispers are private, one to one.</p>
      )}
      {others.length ? (
        <>
          <h4 className="subhead">Start a whisper</h4>
          <ul className="convs convs--people">
            {others.map((p) => (
              <li key={p.id}>
                <button type="button" className="conv conv--person" onClick={() => onPick(p.id)}>
                  <span className="conv__name">{p.name}</span>
                  <Icon name="whisper" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : !convs.length ? (
        <p className="muted small">No one else is in this world right now.</p>
      ) : null}
    </div>
  );
}

export function Chat() {
  const open = useUiStore((s) => s.chatOpen);
  const setOpen = useUiStore((s) => s.setChatOpen);
  const log = useUiStore((s) => s.chatLog);
  const openPanel = useUiStore((s) => s.openPanel);
  const setTextFocus = useUiStore((s) => s.setTextInputFocused);
  const sid = useGameStore((s) => s.sessionId);
  const myName = useGameStore((s) => s.profile?.name ?? null);
  const players = useGameStore((s) => s.players);
  const connected = useGameStore((s) => s.connection === 'connected');
  const { tab, peer, readAt, focusSeq, setTab, openWhisper, markRead } = useChatUi();
  const hidden = useHiddenProfiles();

  const [text, setText] = useState('');
  const [quick, setQuick] = useState(false);
  const [mq, setMq] = useState<MentionQuery | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const typingRef = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const visible = useMemo(() => visibleMessages(log, hidden), [log, hidden]);
  const lines = useMemo(() => {
    if (tab === 'whispers') {
      if (!peer) return [];
      return visible.filter((m) => m.channel === 'private' && (m.from === peer || m.to === peer));
    }
    return visible.filter((m) => inTab(m, tab));
  }, [visible, tab, peer]);

  // Read marks while visible.
  useEffect(() => {
    if (!open) return;
    const last = lines[lines.length - 1];
    if (!last) return;
    markRead(tab === 'whispers' && peer ? `w:${peer}` : tab, last.ts);
  }, [open, lines, tab, peer, markRead]);

  // Scroll to newest.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, open, tab, peer]);

  // Focus requests (Enter key, whisper from player card).
  useEffect(() => {
    if (!focusSeq) return;
    const t = setTimeout(() => {
      inputRef.current?.focus();
      const ins = useChatUi.getState().consumeInsert();
      if (ins) setText((v) => (v ? `${v} ${ins}` : ins));
    }, 30);
    return () => clearTimeout(t);
  }, [focusSeq]);

  const setTyping = (v: boolean) => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (v) typingTimer.current = setTimeout(() => setTyping(false), 3500);
    if (typingRef.current === v) return;
    typingRef.current = v;
    if (connected) net.send(C2S.typing, { typing: v });
  };
  useEffect(() => () => setTyping(false), []);

  const names = useMemo(() => Object.values(players).map((p) => p.name), [players]);
  const candidates = mq ? mentionCandidates(mq.query, names, 5, myName ?? undefined) : [];
  const showCandidates = !!mq && candidates.length > 0;

  const peerPlayer = peer ? players[peer] : undefined;
  const peerName = peerPlayer?.name ?? conversations(log, sid, readAt).find((c) => c.sessionId === peer)?.name;
  const canType = tab !== 'whispers' || (!!peer && !!peerPlayer);

  const close = () => {
    setOpen(false);
    setQuick(false);
    setMq(null);
    inputRef.current?.blur();
    setTyping(false);
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (!connected) {
      localChatLine('You’re offline — your message wasn’t sent.');
      return;
    }
    if ([...t].length > CONFIG.chat.maxMessageLength) return;
    if (tab === 'whispers') {
      if (!peer || !peerPlayer) return;
      net.send(C2S.whisper, { to: peer, text: t });
    } else {
      net.send(C2S.chat, { channel: tab === 'nearby' ? 'proximity' : 'global', text: t });
    }
    setText('');
    setMq(null);
    setTyping(false);
  };

  const pick = (name: string) => {
    if (!mq) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    const r = applyMention(text, mq, caret, name);
    setText(r.text);
    setMq(null);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(r.caret, r.caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showCandidates) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => (s + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => (s - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        pick(candidates[Math.min(sel, candidates.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMq(null);
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text.trim()) send();
      else close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setText(v);
    const q = activeMentionQuery(v, e.target.selectionStart ?? v.length);
    setMq(q);
    setSel(0);
    setTyping(v.trim().length > 0);
  };

  const onName = (from: string) => {
    if (players[from]) openPanel({ kind: 'profile', sessionId: from });
  };

  const unread = (t: ChatTab) => unreadFor(visible, t, sid, readAt);
  const len = [...text].length;
  const placeholder =
    tab === 'nearby' ? 'Say something to people nearby…' : tab === 'town' ? 'Talk to the whole town…' : peerName ? `Whisper to ${peerName}…` : 'Choose someone to whisper to';

  if (!open) return <ChatPeek />;

  return (
    <section className="chat" aria-label="Chat" data-testid="chat">
      <header className="chat__head">
        {tab === 'whispers' && peer ? (
          <button type="button" className="icon-btn icon-btn--sm" aria-label="All whispers" onClick={() => openWhisper(null)}>
            <Icon name="back" size={18} />
          </button>
        ) : null}
        <div className="chat__tabs" role="tablist" aria-label="Chat channels">
          {CHAT_TABS.map((t) => {
            const n = tab === t.id ? 0 : unread(t.id);
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? 'is-on' : ''}
                onClick={() => {
                  setTab(t.id);
                  if (t.id === 'whispers') openWhisper(null);
                }}
                data-testid={`chat-tab-${t.id}`}
              >
                {t.id === 'whispers' && peer && tab === 'whispers' ? peerName ?? t.label : t.label}
                {n ? (
                  <span className="badge" aria-label={`${n} unread`}>
                    {n > 9 ? '9+' : n}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button type="button" className="icon-btn icon-btn--sm" onClick={close} aria-label="Close chat" data-testid="chat-close">
          <Icon name="close" size={18} />
        </button>
      </header>

      {tab === 'whispers' && !peer ? (
        <div className="chat__body">
          <WhisperList onPick={(s) => openWhisper(s)} />
        </div>
      ) : (
        <ol className="chat__log" ref={listRef} aria-live="polite" aria-relevant="additions" data-testid="chat-log">
          {lines.length ? (
            lines.map((m, i) => {
              const prev = lines[i - 1];
              const grouped = !!prev && prev.from === m.from && !!m.from && prev.channel === m.channel && m.ts - prev.ts < 120_000;
              return <Line key={m.id} m={m} myName={myName} mySid={sid} grouped={grouped} onName={onName} />;
            })
          ) : (
            <li className="chat__empty">
              {tab === 'nearby'
                ? `Only people within earshot hear Nearby messages.`
                : tab === 'town'
                  ? 'Town messages reach everyone in this world.'
                  : peerPlayer
                    ? `Whispers between you and ${peerName} stay between you.`
                    : `${peerName ?? 'They'} has left this world.`}
            </li>
          )}
        </ol>
      )}

      {quick ? <QuickBar onClose={() => setQuick(false)} /> : null}

      {showCandidates ? (
        <ul className="mentions" role="listbox" id="mention-list" aria-label="Mention someone">
          {candidates.map((c, i) => (
            <li key={c} role="option" aria-selected={i === sel}>
              <button type="button" className={i === sel ? 'is-on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}>
                @{c}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="chat__input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <button type="button" className={`icon-btn icon-btn--sm${quick ? ' is-on' : ''}`} aria-label="Reactions and emotes" aria-expanded={quick} onClick={() => setQuick((v) => !v)} data-testid="chat-quick">
          <Icon name="smile" size={20} />
        </button>
        <input
          ref={inputRef}
          className="chat__field"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => setTextFocus(true)}
          onBlur={() => {
            setTextFocus(false);
            setTyping(false);
          }}
          placeholder={placeholder}
          disabled={!canType}
          maxLength={CONFIG.chat.maxMessageLength + 20}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-controls={showCandidates ? 'mention-list' : undefined}
          aria-expanded={showCandidates}
          enterKeyHint="send"
          autoComplete="off"
          data-testid="chat-input"
        />
        {len > CONFIG.chat.maxMessageLength * 0.8 ? <span className={`chat__count${len > CONFIG.chat.maxMessageLength ? ' is-over' : ''}`}>{CONFIG.chat.maxMessageLength - len}</span> : null}
        <button type="submit" className="icon-btn icon-btn--sm icon-btn--accent" aria-label="Send" disabled={!text.trim() || !canType || len > CONFIG.chat.maxMessageLength} data-testid="chat-send">
          <Icon name="send" size={19} />
        </button>
      </form>
    </section>
  );
}

/** While chat is closed: the newest incoming line floats briefly, then fades. */
function ChatPeek() {
  const log = useUiStore((s) => s.chatLog);
  const sid = useGameStore((s) => s.sessionId);
  const myName = useGameStore((s) => s.profile?.name ?? null);
  const hidden = useHiddenProfiles();
  const [shown, setShown] = useState<ChatMessage | null>(null);
  const lastId = useRef<string | null>(null);
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    const last = [...log].reverse().find((m) => m.from && m.from !== sid && !hidden.has(m.fromProfileId));
    if (!last || last.id === lastId.current) return;
    lastId.current = last.id;
    if (last.ts < mountedAt.current - 1000) return; // history, not news
    setShown(last);
    const t = setTimeout(() => setShown(null), 6000);
    return () => clearTimeout(t);
  }, [log, sid, hidden]);

  if (!shown) return null;
  const segs = segmentMentions(shown.text, myName);
  return (
    <button
      type="button"
      className={`chat-peek${shown.channel === 'private' ? ' chat-peek--whisper' : ''}`}
      onClick={() => {
        const ui = useChatUi.getState();
        if (shown.channel === 'private') ui.openWhisper(shown.from);
        else ui.setTab(shown.channel === 'global' ? 'town' : 'nearby');
        useUiStore.getState().setChatOpen(true);
        ui.requestFocus();
      }}
      data-testid="chat-peek"
    >
      <strong>{shown.fromName}</strong>
      {shown.channel === 'private' ? <span className="chat-peek__tag">whisper</span> : shown.channel === 'global' ? <span className="chat-peek__tag">town</span> : null}
      <span className="chat-peek__text">
        {segs.map((s, i) => (s.mention ? <mark key={i} className={`mention${s.self ? ' mention--me' : ''}`}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
      </span>
    </button>
  );
}
