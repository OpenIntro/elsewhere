/**
 * Notification queue (pure; time is passed in). Shows at most `maxVisible`
 * toasts; the rest wait their turn. Each toast's lifetime starts when it
 * becomes visible, so queued items are never "used up" off-screen. Identical
 * texts within `dedupeWindowMs` collapse into one (with a repeat count) so
 * spammy events never stack into clutter.
 */

export type ToastLevel = 'info' | 'success' | 'warning' | 'error' | 'world';

export interface ToastInput {
  id: number | string;
  level: ToastLevel;
  text: string;
  /** Optional second line (e.g. world event detail). */
  detail?: string;
  /** How long it stays once visible (ms); 0 = until dismissed. */
  ttlMs?: number;
}

export interface Toast extends Required<Omit<ToastInput, 'detail'>> {
  detail?: string;
  count: number;
  createdAt: number;
  /** Set when it becomes visible. */
  shownAt: number | null;
}

export interface ToastQueueOptions {
  maxVisible?: number;
  defaultTtlMs?: number;
  dedupeWindowMs?: number;
  /** Hard cap on waiting items; oldest low-priority ones are dropped. */
  maxQueued?: number;
}

export class ToastQueue {
  private items: Toast[] = [];
  readonly maxVisible: number;
  readonly defaultTtlMs: number;
  readonly dedupeWindowMs: number;
  readonly maxQueued: number;

  constructor(opts: ToastQueueOptions = {}) {
    this.maxVisible = opts.maxVisible ?? 2;
    this.defaultTtlMs = opts.defaultTtlMs ?? 4500;
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 8000;
    this.maxQueued = opts.maxQueued ?? 6;
  }

  push(input: ToastInput, now: number): void {
    const dup = this.items.find((t) => t.text === input.text && t.level === input.level && now - t.createdAt < this.dedupeWindowMs);
    if (dup) {
      dup.count += 1;
      // Keep a visible duplicate on screen a little longer.
      if (dup.shownAt !== null) dup.shownAt = now;
      return;
    }
    this.items.push({
      id: input.id,
      level: input.level,
      text: input.text,
      ...(input.detail ? { detail: input.detail } : {}),
      ttlMs: input.ttlMs ?? this.defaultTtlMs,
      count: 1,
      createdAt: now,
      shownAt: null,
    });
    const waiting = this.items.filter((t) => t.shownAt === null);
    if (waiting.length > this.maxQueued) {
      const drop = waiting.find((t) => t.level === 'info') ?? waiting[0]!;
      this.items = this.items.filter((t) => t !== drop);
    }
    this.tick(now);
  }

  dismiss(id: Toast['id'], now: number): void {
    this.items = this.items.filter((t) => t.id !== id);
    this.tick(now);
  }

  /** Expire visible toasts and promote waiting ones. Returns the visible list. */
  tick(now: number): Toast[] {
    this.items = this.items.filter((t) => t.shownAt === null || t.ttlMs === 0 || now - t.shownAt < t.ttlMs);
    let visible = this.items.filter((t) => t.shownAt !== null).length;
    for (const t of this.items) {
      if (visible >= this.maxVisible) break;
      if (t.shownAt === null) {
        t.shownAt = now;
        visible++;
      }
    }
    return this.visible();
  }

  visible(): Toast[] {
    return this.items.filter((t) => t.shownAt !== null).map((t) => ({ ...t }));
  }

  get pending(): number {
    return this.items.filter((t) => t.shownAt === null).length;
  }

  /** ms until the next state change (for scheduling a timer), or null if idle. */
  nextDeadline(now: number): number | null {
    let best: number | null = null;
    for (const t of this.items) {
      if (t.shownAt === null || t.ttlMs === 0) continue;
      const left = t.shownAt + t.ttlMs - now;
      if (best === null || left < best) best = left;
    }
    return best === null ? null : Math.max(0, best);
  }
}
