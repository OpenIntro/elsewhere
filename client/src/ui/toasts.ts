/**
 * Toast service: one ToastQueue for the whole UI. Anything may call
 * `toasts.push(...)`; `useUiStore.notify(...)` (used by other systems) is
 * drained into the same queue by <Toasts />.
 */
import { useSyncExternalStore } from 'react';
import { ToastQueue, type Toast, type ToastInput } from './lib/toastQueue.js';

const queue = new ToastQueue({ maxVisible: 2, defaultTtlMs: 4500, dedupeWindowMs: 8000 });
let snapshot: Toast[] = [];
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 1;

function publish(): void {
  snapshot = queue.tick(Date.now());
  for (const l of listeners) l();
  if (timer) clearTimeout(timer);
  const next = queue.nextDeadline(Date.now());
  if (next !== null) timer = setTimeout(publish, next + 20);
}

export const toasts = {
  push(input: Omit<ToastInput, 'id'> & { id?: ToastInput['id'] }): void {
    queue.push({ ...input, id: input.id ?? `t${seq++}` }, Date.now());
    publish();
  },
  dismiss(id: ToastInput['id']): void {
    queue.dismiss(id, Date.now());
    publish();
  },
};

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
