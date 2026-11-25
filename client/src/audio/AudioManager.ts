/**
 * AUDIO CONTRACT — owned by the audio worker. Stub implementation: logs nothing,
 * plays nothing, but keeps volume wiring + the API stable.
 *
 * All sound is procedural (WebAudio synthesis) — no downloaded assets.
 * Three channels (music / sfx / ambience) × master volume, from settingsStore.
 * Browsers require a user gesture before audio: call `audio.unlock()` from the
 * first click/keypress (App does this).
 */
import type { AmbienceKey, Vec3 } from '@elsewhere/shared';
import { useSettingsStore, type VolumeChannel } from '../state/settingsStore.js';

export type SfxName =
  | 'footstep'
  | 'ui_click'
  | 'ui_open'
  | 'ui_close'
  | 'chat_message'
  | 'mention'
  | 'door_open'
  | 'door_close'
  | 'bell'
  | 'light_toggle'
  | 'pickup'
  | 'drop'
  | 'sit'
  | 'splash'
  | 'discovery'
  | 'rune'
  | 'portal_wake'
  | 'reaction'
  | 'notification';

export type MusicTrack = 'none' | 'day' | 'evening' | 'night' | 'mystery';

export interface AudioManager {
  /** Resume the AudioContext after a user gesture. Safe to call repeatedly. */
  unlock(): void;
  /** One-shot effect; positional (attenuated by distance to the listener) when `position` given. */
  playSfx(name: SfxName, position?: Vec3): void;
  setAmbience(key: AmbienceKey | null): void;
  playMusic(track: MusicTrack): void;
  /** Listener pose (local player / camera), call per frame. */
  setListener(position: Vec3, yaw: number): void;
  /** Effective 0..1 gain for a channel (master × channel × !muted). */
  gainFor(channel: VolumeChannel): number;
}

class StubAudioManager implements AudioManager {
  unlock(): void {}
  playSfx(_name: SfxName, _position?: Vec3): void {}
  setAmbience(_key: AmbienceKey | null): void {}
  playMusic(_track: MusicTrack): void {}
  setListener(_position: Vec3, _yaw: number): void {}
  gainFor(channel: VolumeChannel): number {
    const s = useSettingsStore.getState();
    return s.muted ? 0 : s.masterVolume * s.volumes[channel];
  }
}

export const audio: AudioManager = new StubAudioManager();
