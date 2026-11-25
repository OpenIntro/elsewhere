/**
 * Player settings, persisted to localStorage (failures ignored).
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { STORAGE_KEYS, zustandSafeStorage } from './storage.js';

export type VolumeChannel = 'music' | 'sfx' | 'ambience';
export type GraphicsQuality = 'low' | 'medium' | 'high';

export interface SettingsState {
  /** 0..1 master multiplier applied on top of each channel. */
  masterVolume: number;
  volumes: Record<VolumeChannel, number>;
  muted: boolean;
  graphics: GraphicsQuality;
  controls: {
    /** Hold-to-walk instead of run by default. */
    runByDefault: boolean;
    showNames: boolean;
    showTouchControls: 'auto' | 'always' | 'never';
    /** Camera zoom level (orthographic zoom). */
    cameraZoom: number;
  };
  reducedMotion: boolean;

  setVolume(channel: VolumeChannel, v: number): void;
  setMasterVolume(v: number): void;
  setMuted(v: boolean): void;
  setGraphics(q: GraphicsQuality): void;
  setControls(patch: Partial<SettingsState['controls']>): void;
  setReducedMotion(v: boolean): void;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      masterVolume: 0.8,
      volumes: { music: 0.5, sfx: 0.8, ambience: 0.6 },
      muted: false,
      graphics: 'medium',
      controls: { runByDefault: false, showNames: true, showTouchControls: 'auto', cameraZoom: 38 },
      reducedMotion: false,
      setVolume: (channel, v) => set((s) => ({ volumes: { ...s.volumes, [channel]: clamp01(v) } })),
      setMasterVolume: (v) => set({ masterVolume: clamp01(v) }),
      setMuted: (muted) => set({ muted }),
      setGraphics: (graphics) => set({ graphics }),
      setControls: (patch) => set((s) => ({ controls: { ...s.controls, ...patch } })),
      setReducedMotion: (reducedMotion) => set({ reducedMotion }),
    }),
    {
      name: STORAGE_KEYS.settings,
      version: 1,
      storage: createJSONStorage(() => zustandSafeStorage),
      partialize: (s) => ({ masterVolume: s.masterVolume, volumes: s.volumes, muted: s.muted, graphics: s.graphics, controls: s.controls, reducedMotion: s.reducedMotion }),
    },
  ),
);
