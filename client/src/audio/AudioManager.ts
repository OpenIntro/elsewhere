/**
 * AUDIO CONTRACT — owned by the audio worker.
 *
 * All sound is procedural (Web Audio synthesis) — no downloaded assets. These
 * are TEMPORARY placeholder-quality sounds/music, tuned blind against offline
 * measurements; swap in designed assets later behind the same API.
 *
 * One AudioContext, created/resumed on the first user gesture (`unlock()`,
 * idempotent; App and <AudioDirector/> both call it). Three channel buses
 * (music / ambience / sfx) × master volume × !muted, bound live to the settings
 * store with click-free ramps. Suspends while the tab is hidden.
 * Nothing throws if Web Audio is unavailable — every call becomes a no-op.
 *
 * Usually driven by <AudioDirector/> (mounted once in App), which feeds the
 * listener, location, clock and server events. Other code may call
 * `audio.playSfx(name, position?)` directly.
 */
import { hashString, type AmbienceKey, type Vec3 } from '@elsewhere/shared';
import { useSettingsStore, type VolumeChannel } from '../state/settingsStore.js';
import { ambienceMix, type AmbienceMix } from './ambienceMix.js';
import { AmbiencePlayer } from './ambiencePlayer.js';
import { AudioGraph, type BusLevels, type GraphStats } from './graph.js';
import type { Mood } from './musicPlan.js';
import { MusicPlayer } from './musicPlayer.js';
import { playSfxOn, type SfxName, type SfxOptions } from './sfx.js';
import { DEFAULT_CAMERA_YAW } from './spatial.js';

export type { SfxName, SfxOptions } from './sfx.js';
export { SFX_NAMES } from './sfx.js';

export type MusicTrack = 'none' | 'day' | 'evening' | 'night' | 'mystery';

export interface AudioEnvironment {
  /** In-world hours 0..24. */
  hours: number;
  portalAwake: boolean;
  /** 0..1 inside a walk-in building (muffled outdoor ambience). */
  indoors?: number;
}

export interface AudioDebugInfo {
  supported: boolean;
  unlocked: boolean;
  state: AudioContextState | 'none';
  busGains: BusLevels | null;
  stats: (GraphStats & { totalNodes: number; beds: number }) | null;
  music: { track: MusicTrack; mood: Mood | null; playing: boolean };
  ambienceKey: AmbienceKey | null;
  sfxCounts: Record<string, number>;
  recent: { name: string; t: number }[];
}

export interface AudioManager {
  /** Create/resume the AudioContext after a user gesture. Safe to call repeatedly. */
  unlock(): void;
  /** One-shot effect; positional (attenuated + panned relative to the listener) when `position` given. */
  playSfx(name: SfxName, position?: Vec3, opts?: SfxOptions): void;
  /** Location ambience character (crossfades); null = in-between places. */
  setAmbience(key: AmbienceKey | null): void;
  /** Music mood; 'none' fades music out. */
  playMusic(track: MusicTrack): void;
  /**
   * Listener pose, call per frame. `yaw` is the CAMERA yaw (screen orientation,
   * see spatial.ts) — panning is relative to the screen, not the avatar's facing.
   */
  setListener(position: Vec3, yaw: number): void;
  /** Effective 0..1 gain for a channel (master × channel × !muted). */
  gainFor(channel: VolumeChannel): number;
  /** World time + portal state for ambience/music colour. */
  setEnvironment(env: AudioEnvironment): void;
  /** Stop all sound and scheduling (keeps the context so a remount can resume without a new gesture). */
  stopAll(): void;
  debug(): AudioDebugInfo;
}

function levelsFromSettings(): BusLevels {
  const s = useSettingsStore.getState();
  return { master: s.muted ? 0 : s.masterVolume, music: s.volumes.music, ambience: s.volumes.ambience, sfx: s.volumes.sfx };
}

type Ctor = typeof AudioContext;

class WebAudioManager implements AudioManager {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private music: MusicPlayer | null = null;
  private amb: AmbiencePlayer | null = null;
  private failed = false;
  private unlocked = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubSettings: (() => void) | null = null;
  private track: MusicTrack = 'none';
  private key: AmbienceKey | null = null;
  private env: AudioEnvironment = { hours: 12, portalAwake: false };
  private listener = { x: 0, z: 0 };
  private hiddenSuspended = false;
  private lastMix: AmbienceMix | null = null;
  private sfxCounts: Record<string, number> = {};
  private recent: { name: string; t: number }[] = [];
  private active = false;

  private get supported(): boolean {
    return typeof window !== 'undefined' && !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext);
  }

  unlock(): void {
    if (this.failed || !this.supported) return;
    try {
      if (!this.ctx) {
        const C: Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: Ctor }).webkitAudioContext;
        // 'playback' latency = bigger buffers = less CPU on mobile; nothing here is latency-critical.
        this.ctx = new C({ latencyHint: 'playback' });
        this.graph = new AudioGraph(this.ctx, levelsFromSettings());
        this.unsubSettings = useSettingsStore.subscribe(() => this.graph?.setLevels(levelsFromSettings()));
        document.addEventListener('visibilitychange', this.onVisibility);
      }
      if (this.ctx.state !== 'running' && !document.hidden) void this.ctx.resume().catch(() => undefined);
      this.unlocked = true;
      this.startSystems();
    } catch (err) {
      this.failed = true;
      console.warn('[audio] Web Audio unavailable; continuing silently.', err);
    }
  }

  private startSystems(): void {
    const g = this.graph;
    if (!g || this.active) return;
    this.active = true;
    const seed = hashString(`elsewhere-${Date.now()}`);
    this.music = new MusicPlayer(g, seed, { startWithRest: true });
    this.amb = new AmbiencePlayer(g);
    this.amb.start(g.now + 0.2);
    if (this.track !== 'none') {
      this.music.setMood(this.track);
      this.music.start(g.now + 0.5);
    }
    this.timer = setInterval(this.tick, 250);
    this.tick();
  }

  private tick = (): void => {
    const g = this.graph;
    if (!g || !this.ctx || this.ctx.state !== 'running') return;
    try {
      g.listener = this.listener;
      const mix = ambienceMix({ x: this.listener.x, z: this.listener.z, hours: this.env.hours, key: this.key, portalAwake: this.env.portalAwake, indoors: this.env.indoors ?? 0 });
      this.lastMix = mix;
      this.amb?.update(mix);
      this.amb?.tick(g.now + 1.2);
      this.music?.schedule(g.now + 4);
    } catch (err) {
      console.warn('[audio] tick failed', err);
    }
  };

  private onVisibility = (): void => {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || !this.unlocked) return;
    if (document.hidden) {
      if (ctx.state === 'running') {
        g.master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        this.hiddenSuspended = true;
        setTimeout(() => {
          if (document.hidden) void ctx.suspend().catch(() => undefined);
        }, 250);
      }
    } else if (this.hiddenSuspended) {
      this.hiddenSuspended = false;
      void ctx
        .resume()
        .then(() => g.setLevels(levelsFromSettings(), 0.3))
        .catch(() => undefined);
    }
  };

  private ready(): AudioGraph | null {
    if (!this.graph || !this.ctx || this.ctx.state !== 'running' || !this.active) return null;
    return this.graph;
  }

  playSfx(name: SfxName, position?: Vec3, opts?: SfxOptions): void {
    const g = this.ready();
    if (!g) return;
    try {
      g.listener = this.listener;
      playSfxOn(g, name, position ? { x: position.x, z: position.z } : undefined, opts);
      this.sfxCounts[name] = (this.sfxCounts[name] ?? 0) + 1;
      this.recent.push({ name, t: Math.round(performance.now()) });
      if (this.recent.length > 40) this.recent.shift();
    } catch (err) {
      console.warn('[audio] sfx failed', name, err);
    }
  }

  setAmbience(key: AmbienceKey | null): void {
    this.key = key;
  }

  playMusic(track: MusicTrack): void {
    this.track = track;
    const m = this.music;
    if (!m || !this.graph) return;
    if (track === 'none') m.stop();
    else {
      m.setMood(track);
      m.start(this.graph.now + 0.5);
    }
  }

  setListener(position: Vec3, yaw: number): void {
    this.listener = { x: position.x, z: position.z };
    if (this.graph) {
      this.graph.listener = this.listener;
      this.graph.cameraYaw = Number.isFinite(yaw) ? yaw : DEFAULT_CAMERA_YAW;
    }
  }

  setEnvironment(env: AudioEnvironment): void {
    this.env = env;
  }

  gainFor(channel: VolumeChannel): number {
    const s = useSettingsStore.getState();
    return s.muted ? 0 : s.masterVolume * s.volumes[channel];
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.music?.stop();
    this.music?.dispose();
    this.amb?.stop();
    this.graph?.killAll();
    this.music = null;
    this.amb = null;
    this.active = false;
  }

  /** Bring sound back after stopAll() (e.g. React remount) if already unlocked. */
  resumeSystems(): void {
    if (this.unlocked) this.startSystems();
  }

  debug(): AudioDebugInfo {
    const g = this.graph;
    return {
      supported: this.supported && !this.failed,
      unlocked: this.unlocked,
      state: this.ctx?.state ?? 'none',
      busGains: g ? g.busGains() : null,
      stats: g ? { ...g.stats, totalNodes: g.stats.voiceNodes + g.stats.persistentNodes, beds: this.amb?.bedCount ?? 0 } : null,
      music: { track: this.track, mood: this.music?.currentMood ?? null, playing: this.music?.isPlaying ?? false },
      ambienceKey: this.key,
      sfxCounts: { ...this.sfxCounts },
      recent: [...this.recent],
    };
  }

  /** Current ambience weights (debug). */
  get mix(): AmbienceMix | null {
    return this.lastMix;
  }
}

const manager = new WebAudioManager();
export const audio: AudioManager & { resumeSystems(): void; readonly mix: AmbienceMix | null } = manager;

declare global {
  interface Window {
    /** Read-only audio debug accessor (tests / manual inspection). */
    __ELSEWHERE_AUDIO__?: {
      debug(): AudioDebugInfo;
      gainFor(c: VolumeChannel): number;
      mix(): AmbienceMix | null;
      /** Test helpers (same effect as the settings UI / any game code calling audio). */
      settings(): ReturnType<typeof useSettingsStore.getState>;
      playSfx(name: SfxName, position?: Vec3): void;
    };
  }
}
if (typeof window !== 'undefined') {
  window.__ELSEWHERE_AUDIO__ = {
    debug: () => manager.debug(),
    gainFor: (c) => manager.gainFor(c),
    mix: () => manager.mix,
    settings: () => useSettingsStore.getState(),
    playSfx: (name, position) => manager.playSfx(name, position),
  };
}
