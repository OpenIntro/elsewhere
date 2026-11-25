/**
 * Scene composition (integration-owned): World + players + camera.
 * Each subsystem plugs in here through its public component.
 */
import { Canvas } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import { World } from '../world/index.js';
import { CameraRig, LocalPlayer, PlayerSystems } from '../player/index.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { RemotePlayers } from './RemotePlayers.js';

export function GameCanvas() {
  const quality = useSettingsStore((s) => s.graphics);
  return (
    <Canvas
      shadows={quality === 'low' ? false : { type: PCFShadowMap }}
      dpr={quality === 'high' ? [1, 2] : [1, 1.5]}
      gl={{ antialias: quality !== 'low', powerPreference: 'high-performance' }}
      style={{ position: 'fixed', inset: 0 }}
    >
      <CameraRig />
      <World terrainResolution={quality === 'low' ? 2 : 1} />
      <LocalPlayer />
      <RemotePlayers />
      <PlayerSystems />
    </Canvas>
  );
}
