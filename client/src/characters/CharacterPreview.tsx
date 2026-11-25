/**
 * Self-contained preview canvas for the customization screen / profile cards.
 * Placeholder: slowly turning <Character>.
 */
import { Canvas, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import type { AnimState, Appearance } from '@elsewhere/shared';
import { Character } from './Character.js';

export interface CharacterPreviewProps {
  appearance: Appearance;
  anim?: AnimState;
  /** Auto-rotate speed in rad/s (0 = still). */
  spin?: number;
  className?: string;
  style?: React.CSSProperties;
}

function Spinner({ appearance, anim, spin }: Required<Pick<CharacterPreviewProps, 'appearance' | 'anim' | 'spin'>>) {
  const ref = useRef<Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += spin * dt;
  });
  return (
    <group ref={ref}>
      <Character appearance={appearance} anim={anim} castShadow={false} />
    </group>
  );
}

export function CharacterPreview({ appearance, anim = 'idle', spin = 0.6, className, style }: CharacterPreviewProps) {
  return (
    <Canvas className={className} style={style} camera={{ position: [0, 1.4, 3.6], fov: 35 }} dpr={[1, 2]}>
      <ambientLight intensity={0.7} />
      <directionalLight position={[2, 4, 3]} intensity={1.6} />
      <group position={[0, -0.9, 0]}>
        <Spinner appearance={appearance} anim={anim} spin={spin} />
      </group>
    </Canvas>
  );
}
