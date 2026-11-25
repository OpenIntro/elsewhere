/**
 * Scene composition (integration-owned): World + players + camera + in-world
 * overlay, plus the DOM touch controls next to the canvas.
 * Each subsystem plugs in here through its public component.
 */
import { Canvas } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import { BuildLayer } from '../build/index.js';
import { World } from '../world/index.js';
import { CameraRig, LocalPlayer, PlayerSystems, TouchControls } from '../player/index.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { RemotePlayers } from './RemotePlayers.js';
import { WorldOverlay } from './WorldOverlay.js';

export function GameCanvas() {
  const quality = useSettingsStore((s) => s.graphics);
  return (
    <>
      <Canvas
        shadows={quality === 'low' ? false : { type: PCFShadowMap }}
        dpr={quality === 'high' ? [1, 2] : [1, 1.5]}
        gl={{ antialias: quality !== 'low', powerPreference: 'high-performance' }}
        style={{ position: 'fixed', inset: 0, touchAction: 'none' }}
      >
        <CameraRig />
        <World terrainResolution={quality === 'low' ? 2 : 1} />
        <LocalPlayer />
        <RemotePlayers />
        <BuildLayer />
        <PlayerSystems />
        <WorldOverlay />
      </Canvas>
      <TouchControls />
    </>
  );
}
