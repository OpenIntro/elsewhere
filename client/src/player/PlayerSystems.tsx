/** Mounts input + interaction wiring and per-frame targeting inside the Canvas. */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { installInput } from './input.js';
import { installInteraction, updateTargeting } from './interaction.js';

export function PlayerSystems() {
  useEffect(() => {
    const a = installInput();
    const b = installInteraction();
    return () => {
      a();
      b();
    };
  }, []);
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current > 0.1) {
      acc.current = 0;
      updateTargeting();
    }
  });
  return null;
}
