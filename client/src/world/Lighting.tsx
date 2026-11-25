/** Placeholder day/night lighting driven by the shared world clock. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, type AmbientLight, type DirectionalLight } from 'three';
import { daylight, sunAngles, timeOfDayAt } from '@elsewhere/shared';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';

const DAY = new Color('#fff1dc');
const NIGHT = new Color('#7d8bb5');

export function Lighting() {
  const sun = useRef<DirectionalLight>(null);
  const amb = useRef<AmbientLight>(null);
  useFrame(() => {
    const { epochMs, dayLengthMs } = useGameStore.getState().clock;
    const t = timeOfDayAt(serverNow(), { epochMs, dayLengthMs });
    const light = daylight(t);
    const { elevation, azimuth } = sunAngles(t);
    const lp = runtime.localPlayer;
    if (sun.current) {
      const el = Math.max(0.15, elevation);
      sun.current.position.set(lp.x + Math.cos(azimuth) * 40 * Math.cos(el), 40 * Math.sin(el) + 5, lp.z + Math.sin(azimuth) * 40 * Math.cos(el));
      sun.current.target.position.set(lp.x, 0, lp.z);
      sun.current.target.updateMatrixWorld();
      sun.current.intensity = 0.3 + 1.9 * light;
      sun.current.color.copy(NIGHT).lerp(DAY, light);
    }
    if (amb.current) amb.current.intensity = 0.35 + 0.45 * light;
  });
  return (
    <>
      <ambientLight ref={amb} intensity={0.6} />
      <directionalLight ref={sun} castShadow intensity={1.8} shadow-mapSize={[1024, 1024]} />
    </>
  );
}
