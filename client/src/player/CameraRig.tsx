/** Orthographic isometric camera that follows the local player smoothly. */
import { OrthographicCamera } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { OrthographicCamera as ThreeOrtho } from 'three';
import { runtime } from '../state/runtime.js';
import { useSettingsStore } from '../state/settingsStore.js';

/** Camera offset from the focus point (true isometric: equal X/Y/Z). */
export const ISO_OFFSET = { x: 30, y: 30, z: 30 } as const;

export function CameraRig() {
  const cam = useRef<ThreeOrtho>(null);
  const zoom = useSettingsStore((s) => s.controls.cameraZoom);
  const focus = useRef({ x: 0, y: 0, z: 0, init: false });
  useFrame((_, dt) => {
    const c = cam.current;
    const lp = runtime.localPlayer;
    if (!c) return;
    const f = focus.current;
    if (lp.ready) {
      if (!f.init) Object.assign(f, { x: lp.x, y: lp.y, z: lp.z, init: true });
      const k = 1 - Math.exp(-dt * 6);
      f.x += (lp.x - f.x) * k;
      f.y += (lp.y - f.y) * k;
      f.z += (lp.z - f.z) * k;
    }
    c.position.set(f.x + ISO_OFFSET.x, f.y + ISO_OFFSET.y, f.z + ISO_OFFSET.z);
    c.lookAt(f.x, f.y, f.z);
    if (c.zoom !== zoom) {
      c.zoom = zoom;
      c.updateProjectionMatrix();
    }
  });
  return <OrthographicCamera ref={cam} makeDefault near={0.1} far={400} zoom={zoom} position={[30, 30, 30]} />;
}
