/**
 * UI state: which panel is open, the current interaction prompt,
 * notifications/toasts, chat focus (suppresses movement keys), onboarding phase.
 */
import { create } from 'zustand';
import type { ChatMessage, DiscoveryId } from '@elsewhere/shared';

export type Panel =
  | { kind: 'sign' | 'inspect'; title: string; text: string }
  | { kind: 'gazette' }
  | { kind: 'memory' }
  | { kind: 'mailbox'; mailboxId: string; canSend: boolean }
  | { kind: 'discovery'; discoveryId: DiscoveryId; name: string; text: string; firstTime: boolean }
  | { kind: 'customize' }
  | { kind: 'settings' }
  | { kind: 'profile'; sessionId: string }
  | { kind: 'report'; sessionId: string };

export interface InteractionPrompt {
  interactableId: string;
  label: string;
  name: string;
}

export interface UiNotification {
  id: number;
  level: 'info' | 'success' | 'warning' | 'error';
  text: string;
  /** ms since epoch when it should auto-dismiss (0 = sticky). */
  expiresAt: number;
}

export type AppPhase = 'loading' | 'onboarding' | 'playing';

export interface UiState {
  phase: AppPhase;
  panel: Panel | null;
  prompt: InteractionPrompt | null;
  notifications: UiNotification[];
  /** True while a text input has focus: player input ignores movement keys. */
  textInputFocused: boolean;
  chatOpen: boolean;
  /** Chat log (owned/filled by net + ui chat worker). */
  chatLog: ChatMessage[];

  setPhase(phase: AppPhase): void;
  openPanel(panel: Panel): void;
  closePanel(): void;
  setPrompt(prompt: InteractionPrompt | null): void;
  notify(level: UiNotification['level'], text: string, ttlMs?: number): number;
  dismiss(id: number): void;
  setTextInputFocused(v: boolean): void;
  setChatOpen(v: boolean): void;
  pushChat(msg: ChatMessage, max?: number): void;
}

let nextId = 1;

export const useUiStore = create<UiState>()((set) => ({
  phase: 'loading',
  panel: null,
  prompt: null,
  notifications: [],
  textInputFocused: false,
  chatOpen: false,
  chatLog: [],
  setPhase: (phase) => set({ phase }),
  openPanel: (panel) => set({ panel }),
  closePanel: () => set({ panel: null }),
  setPrompt: (prompt) =>
    set((s) => (s.prompt?.interactableId === prompt?.interactableId && s.prompt?.label === prompt?.label ? s : { prompt })),
  notify: (level, text, ttlMs = 4000) => {
    const id = nextId++;
    set((s) => ({ notifications: [...s.notifications.slice(-4), { id, level, text, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  setTextInputFocused: (textInputFocused) => set({ textInputFocused }),
  setChatOpen: (chatOpen) => set({ chatOpen }),
  pushChat: (msg, max = 100) => set((s) => ({ chatLog: [...s.chatLog.slice(-(max - 1)), msg] })),
}));
