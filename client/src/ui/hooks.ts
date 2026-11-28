/** Small DOM hooks shared by UI components. */
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../state/settingsStore.js';

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Primary input is touch (coarse pointer, no hover). */
export function useIsTouch(): boolean {
  return useMediaQuery('(hover: none) and (pointer: coarse)');
}

export function useReducedMotion(): boolean {
  const sys = useMediaQuery('(prefers-reduced-motion: reduce)');
  const pref = useSettingsStore((s) => s.reducedMotion);
  return sys || pref;
}

/** Re-render every `ms` (for clocks / relative times). */
export function useTicker(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

/** True for inputs that take typed text (range/checkbox inputs don't block game keys). */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return ['text', 'search', 'password', 'email', 'url', 'tel', ''].includes(el.type);
  return (el as HTMLElement).isContentEditable === true;
}
