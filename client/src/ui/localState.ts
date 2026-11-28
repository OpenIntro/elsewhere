/**
 * UI-local stores (ui worker). Kept out of state/ because nothing else reads them.
 *  - useUiPrefs: persisted UI conveniences (hint seen, clock style, camera buttons, map toggles).
 *  - useChatUi: chat tab, whisper peer, read marks, focus requests.
 *  - useSocialUi: mailbox notes, moderation name cache, report status.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { MailNote } from '@elsewhere/shared';
import { STORAGE_KEYS, zustandSafeStorage } from '../state/storage.js';
import type { ChatTab } from './lib/chatModel.js';

export interface UiPrefs {
  controlsHintSeen: boolean;
  clockStyle: '24h' | '12h';
  /** 'auto' = on for touch devices. */
  cameraButtons: 'auto' | 'on' | 'off';
  mapShowOthers: boolean;
  set(patch: Partial<Omit<UiPrefs, 'set'>>): void;
}

export const useUiPrefs = create<UiPrefs>()(
  persist(
    (set) => ({
      controlsHintSeen: false,
      clockStyle: '24h',
      cameraButtons: 'auto',
      mapShowOthers: true,
      set: (patch) => set(patch),
    }),
    {
      name: STORAGE_KEYS.uiPrefs,
      version: 1,
      storage: createJSONStorage(() => zustandSafeStorage),
      partialize: ({ set: _s, ...rest }) => rest,
    },
  ),
);

export interface ChatUiState {
  tab: ChatTab;
  /** Open whisper conversation (peer sessionId), or null for the list. */
  peer: string | null;
  /** Read marks: tab id or `w:<sessionId>` → ts. */
  readAt: Record<string, number>;
  /** Incremented to ask the input to take focus. */
  focusSeq: number;
  /** Text to place into the input (e.g. a mention), consumed by the input. */
  insert: string | null;
  setTab(tab: ChatTab): void;
  openWhisper(sessionId: string | null): void;
  markRead(key: string, ts: number): void;
  requestFocus(insert?: string): void;
  consumeInsert(): string | null;
}

export const useChatUi = create<ChatUiState>()((set, get) => ({
  tab: 'nearby',
  peer: null,
  readAt: {},
  focusSeq: 0,
  insert: null,
  setTab: (tab) => set({ tab }),
  openWhisper: (peer) => set({ tab: 'whispers', peer }),
  markRead: (key, ts) => set((s) => (ts > (s.readAt[key] ?? 0) ? { readAt: { ...s.readAt, [key]: ts } } : s)),
  requestFocus: (insert) => set((s) => ({ focusSeq: s.focusSeq + 1, insert: insert ?? null })),
  consumeInsert: () => {
    const v = get().insert;
    if (v !== null) set({ insert: null });
    return v;
  },
}));

export type ReportStatus = 'idle' | 'sending' | 'sent' | 'unavailable' | 'error';

export interface SocialUiState {
  mail: Record<string, { notes: MailNote[]; loadedAt: number } | undefined>;
  /** profileId → last known display name (for blocked/muted lists). */
  names: Record<string, string>;
  /** profileId → report status. */
  reports: Record<string, ReportStatus>;
  setMail(mailboxId: string, notes: MailNote[]): void;
  rememberName(profileId: string, name: string): void;
  setReport(profileId: string, status: ReportStatus): void;
}

export const useSocialUi = create<SocialUiState>()((set) => ({
  mail: {},
  names: {},
  reports: {},
  setMail: (mailboxId, notes) => set((s) => ({ mail: { ...s.mail, [mailboxId]: { notes, loadedAt: Date.now() } } })),
  rememberName: (profileId, name) => set((s) => (s.names[profileId] === name ? s : { names: { ...s.names, [profileId]: name } })),
  setReport: (profileId, status) => set((s) => ({ reports: { ...s.reports, [profileId]: status } })),
}));
