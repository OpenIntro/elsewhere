/**
 * Server → UI wiring (ui worker): chat log, toasts for notices / world events /
 * rate limits / moderation acks, mailbox notes. Installed once by App.
 * Chat messages are de-duplicated by id so it is safe if net/ also pushes them.
 */
import { C2S, S2C, type ChatMessage, type C2SType } from '@elsewhere/shared';
import { net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { useUiStore } from '../state/uiStore.js';
import { useChatUi, useSocialUi } from './localState.js';
import { toasts } from './toasts.js';

let localSeq = 0;

export function pushChatOnce(msg: ChatMessage): void {
  const ui = useUiStore.getState();
  if (ui.chatLog.some((m) => m.id === msg.id)) return;
  ui.pushChat(msg);
}

/** A local-only system line in the chat log (never sent anywhere). */
export function localChatLine(text: string, channel: ChatMessage['channel'] = 'system'): void {
  pushChatOnce({ id: `local-${Date.now()}-${localSeq++}`, channel, from: '', fromProfileId: '', fromName: '', text, ts: Date.now(), mentions: [] });
}

const CHATTY: readonly string[] = ['chat', 'whisper', C2S.chat, C2S.whisper];

function friendlyError(code: string, inResponseTo?: C2SType): string | null {
  if (code === 'not_implemented') {
    const what: Partial<Record<C2SType, string>> = {
      [C2S.chat]: 'Chat',
      [C2S.whisper]: 'Whispers',
      [C2S.report]: 'Reporting',
      [C2S.block]: 'Blocking',
      [C2S.unblock]: 'Unblocking',
      [C2S.mute]: 'Muting',
      [C2S.unmute]: 'Unmuting',
      [C2S.mailSend]: 'Leaving notes',
      [C2S.mailRead]: 'Reading mail',
      [C2S.updateProfile]: 'Saving your look',
      [C2S.dropItem]: 'Setting items down',
    };
    return `${(inResponseTo && what[inResponseTo]) || 'That'} isn’t available on this server yet.`;
  }
  return null;
}

export function installUiBridge(): () => void {
  const offs: (() => void)[] = [];
  const game = useGameStore.getState;
  const social = useSocialUi.getState;

  offs.push(
    net.on(S2C.welcome, (w) => {
      for (const m of w.recentChat ?? []) pushChatOnce(m);
      // History you arrive to isn't "unread".
      const last = (w.recentChat ?? []).reduce((t, m) => Math.max(t, m.ts), 0);
      if (last) for (const k of ['town', 'nearby']) useChatUi.getState().markRead(k, last);
    }),
    net.on(S2C.chat, (m) => {
      pushChatOnce(m);
      if (m.fromProfileId && m.fromName) social().rememberName(m.fromProfileId, m.fromName);
      const ui = useUiStore.getState();
      if (m.channel === 'private' && m.from !== game().sessionId && !ui.chatOpen) {
        toasts.push({ level: 'info', text: `${m.fromName} whispered to you`, detail: m.text.length > 70 ? `${m.text.slice(0, 68)}…` : m.text, ttlMs: 5000 });
      }
    }),
    net.on(S2C.rateLimited, (r) => {
      const secs = Math.max(1, Math.ceil(r.retryInMs / 1000));
      if (CHATTY.includes(r.action)) localChatLine(`Easy there — you can send again in ${secs}s.`);
      else toasts.push({ level: 'info', text: `Give it a moment — try again in ${secs}s.`, ttlMs: 2600 });
    }),
    net.on(S2C.notice, (n) => toasts.push({ level: n.level, text: n.text })),
    net.on(S2C.error, (e) => {
      if (e.inResponseTo === C2S.move || e.inResponseTo === C2S.typing) return;
      const msg = friendlyError(e.code, e.inResponseTo) ?? e.message;
      if (e.inResponseTo === C2S.report) {
        const target = Object.entries(social().reports).find(([, s]) => s === 'sending')?.[0];
        if (target) social().setReport(target, e.code === 'not_implemented' ? 'unavailable' : 'error');
      }
      if (e.inResponseTo && CHATTY.includes(e.inResponseTo)) localChatLine(msg);
      else toasts.push({ level: e.code === 'not_implemented' ? 'info' : 'warning', text: msg });
    }),
    net.on(S2C.worldEvent, (w) => toasts.push({ level: 'world', text: w.headline, ttlMs: 6500 })),
    net.on(S2C.discovery, (d) => {
      const panel = useUiStore.getState().panel;
      if (panel?.kind === 'discovery' && panel.discoveryId === d.discoveryId) return;
      toasts.push({ level: 'world', text: d.firstTime ? `You found the ${d.name}` : d.name, detail: d.text, ttlMs: 7000 });
    }),
    net.on(S2C.mail, (m) => social().setMail(m.mailboxId, m.notes)),
    net.on(S2C.moderation, (a) => {
      social().rememberName(a.targetProfileId, a.targetName);
      const { blocked, muted, setLists } = game();
      const add = (list: string[]) => (list.includes(a.targetProfileId) ? list : [...list, a.targetProfileId]);
      const del = (list: string[]) => list.filter((p) => p !== a.targetProfileId);
      switch (a.action) {
        case 'blocked':
          setLists({ blocked: add(blocked) });
          toasts.push({ level: 'success', text: `You blocked ${a.targetName}. You won’t see each other’s messages.` });
          break;
        case 'unblocked':
          setLists({ blocked: del(blocked) });
          toasts.push({ level: 'success', text: `${a.targetName} is unblocked.` });
          break;
        case 'muted':
          setLists({ muted: add(muted) });
          toasts.push({ level: 'success', text: `${a.targetName} is muted.` });
          break;
        case 'unmuted':
          setLists({ muted: del(muted) });
          toasts.push({ level: 'success', text: `${a.targetName} is unmuted.` });
          break;
        case 'reported':
          social().setReport(a.targetProfileId, 'sent');
          toasts.push({ level: 'success', text: `Thank you. Your report about ${a.targetName} was received.` });
          break;
      }
    }),
  );

  // Remember roster names so blocked/muted lists stay readable after people leave.
  offs.push(
    useGameStore.subscribe((s, prev) => {
      if (s.players === prev.players) return;
      for (const p of Object.values(s.players)) social().rememberName(p.profileId, p.name);
    }),
  );

  // Opening chat on a tab clears its unread marks (handled in Chat); keep whisper peer valid.
  offs.push(
    useGameStore.subscribe((s, prev) => {
      if (s.players === prev.players) return;
      const peer = useChatUi.getState().peer;
      if (peer && !s.players[peer] && prev.players[peer]) localChatLine(`${prev.players[peer]!.name} has left.`, 'system');
    }),
  );

  return () => {
    for (const o of offs) o();
  };
}
