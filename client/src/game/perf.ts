/**
 * Tiny per-frame CPU timers for the player/net/game systems (exposed as
 * snapshot().perf). Each section accumulates ms; the debug section reports a
 * per-frame average over the frames since the last read.
 */
import { registerDebugSection } from '../net/index.js';

const sections = new Map<string, { total: number; frames: number; max: number; cur: number; frame: number }>();
let frameNo = 0;

export function perfFrame(): void {
  frameNo++;
}

/** Add `ms` to section `name` for the current frame. */
export function perfAdd(name: string, ms: number): void {
  let s = sections.get(name);
  if (!s) sections.set(name, (s = { total: 0, frames: 0, max: 0, cur: 0, frame: -1 }));
  if (s.frame !== frameNo) {
    if (s.frame >= 0) {
      s.frames++;
      s.max = Math.max(s.max, s.cur);
    }
    s.frame = frameNo;
    s.cur = 0;
  }
  s.cur += ms;
  s.total += ms;
}

registerDebugSection('perf', () => {
  const out: Record<string, { avgMs: number; maxMs: number; frames: number }> = {};
  for (const [k, s] of sections) {
    out[k] = { avgMs: s.frames ? s.total / s.frames : 0, maxMs: s.max, frames: s.frames };
    s.total = 0;
    s.frames = 0;
    s.max = 0;
  }
  return out;
});
