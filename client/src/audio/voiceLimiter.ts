/**
 * Voice limiter: caps simultaneous one-shot voices globally and per category so
 * a burst of events (twenty people ringing bells, a crowd walking) never clips
 * or eats CPU. Pure bookkeeping (time is passed in) — unit-tested.
 *
 * Policy: expired voices are pruned first. If the category is full, the oldest
 * voice of that category is stolen when the newcomer's priority >= its
 * priority, else the newcomer is rejected. Same rule for the global cap, where
 * the victim is the lowest-priority (then oldest) voice.
 */
export interface VoiceSlot {
  id: number;
  category: string;
  priority: number;
  start: number;
  end: number;
  /** Called when this voice is stolen (should fade + stop its nodes quickly). */
  steal?: (now: number) => void;
}

export interface VoiceLimiterOptions {
  maxVoices: number;
  perCategory?: Record<string, number>;
  /** Cap for categories not listed in perCategory. */
  defaultCategoryMax?: number;
}

export class VoiceLimiter {
  private slots: VoiceSlot[] = [];
  private nextId = 1;
  stolen = 0;
  rejected = 0;

  constructor(private readonly opts: VoiceLimiterOptions) {}

  private capFor(category: string): number {
    return this.opts.perCategory?.[category] ?? this.opts.defaultCategoryMax ?? this.opts.maxVoices;
  }

  prune(now: number): void {
    if (this.slots.some((s) => s.end <= now)) this.slots = this.slots.filter((s) => s.end > now);
  }

  acquire(category: string, priority: number, now: number, end: number, steal?: (now: number) => void): VoiceSlot | null {
    this.prune(now);
    const inCat = this.slots.filter((s) => s.category === category);
    if (inCat.length >= this.capFor(category)) {
      const victim = inCat.reduce((a, b) => (b.start < a.start ? b : a));
      if (victim.priority > priority) {
        this.rejected++;
        return null;
      }
      this.evict(victim, now);
    }
    if (this.slots.length >= this.opts.maxVoices) {
      const victim = this.slots.reduce((a, b) => (b.priority < a.priority || (b.priority === a.priority && b.start < a.start) ? b : a));
      if (victim.priority > priority) {
        this.rejected++;
        return null;
      }
      this.evict(victim, now);
    }
    const slot: VoiceSlot = { id: this.nextId++, category, priority, start: now, end, ...(steal ? { steal } : {}) };
    this.slots.push(slot);
    return slot;
  }

  private evict(v: VoiceSlot, now: number): void {
    this.slots = this.slots.filter((s) => s !== v);
    this.stolen++;
    try {
      v.steal?.(now);
    } catch {
      /* ignore */
    }
  }

  release(id: number): void {
    this.slots = this.slots.filter((s) => s.id !== id);
  }

  active(now?: number): number {
    if (now !== undefined) this.prune(now);
    return this.slots.length;
  }

  activeIn(category: string): number {
    return this.slots.filter((s) => s.category === category).length;
  }

  clear(now = 0): void {
    const all = this.slots;
    this.slots = [];
    for (const s of all) {
      try {
        s.steal?.(now);
      } catch {
        /* ignore */
      }
    }
  }
}
