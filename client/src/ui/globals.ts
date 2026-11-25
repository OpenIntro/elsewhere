/**
 * Document-level UI behaviour (ui worker), installed once by App:
 *  - ui.textInputFocused follows focus of text-entry elements (game keys ignored while typing)
 *  - Enter opens chat, Esc closes the top-most panel / chat
 *  - on-screen keyboard height → CSS var --kb (visualViewport)
 *  - reduced-motion preference → <html data-motion="reduced">
 */
import { useEffect } from 'react';
import { useSettingsStore } from '../state/settingsStore.js';
import { useUiStore } from '../state/uiStore.js';
import { isTextEntry } from './hooks.js';
import { useChatUi } from './localState.js';

export function useUiGlobals(): void {
  useEffect(() => {
    const ui = useUiStore.getState;
    const syncFocus = () => {
      const v = isTextEntry(document.activeElement);
      if (ui().textInputFocused !== v) ui().setTextInputFocused(v);
    };
    const onFocusOut = () => setTimeout(syncFocus, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const s = ui();
      if (s.phase !== 'playing') return;
      const active = document.activeElement as HTMLElement | null;
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const neutral = !active || active === document.body || active.tagName === 'CANVAS' || active.classList.contains('sheet');
        if (!neutral || isTextEntry(active)) return;
        e.preventDefault();
        s.setChatOpen(true);
        useChatUi.getState().requestFocus();
        return;
      }
      if (e.key === 'Escape') {
        if (isTextEntry(active)) {
          active?.blur();
          return;
        }
        if (s.panel) {
          e.preventDefault();
          s.closePanel();
        } else if (s.chatOpen) {
          e.preventDefault();
          s.setChatOpen(false);
        }
      }
    };

    const vv = window.visualViewport;
    const root = document.documentElement;
    const onViewport = () => {
      if (!vv) return;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb', `${Math.round(kb)}px`);
      root.classList.toggle('kb-open', kb > 80);
    };

    document.addEventListener('focusin', syncFocus);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('keydown', onKey);
    vv?.addEventListener('resize', onViewport);
    vv?.addEventListener('scroll', onViewport);
    onViewport();
    return () => {
      document.removeEventListener('focusin', syncFocus);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('keydown', onKey);
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
    };
  }, []);

  const reduced = useSettingsStore((s) => s.reducedMotion);
  useEffect(() => {
    if (reduced) document.documentElement.dataset.motion = 'reduced';
    else delete document.documentElement.dataset.motion;
  }, [reduced]);
}
