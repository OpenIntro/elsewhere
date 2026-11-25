/**
 * Self-contained preview canvas for the customization screen / profile cards.
 * Studio look: warm key + cool fill + rim light, soft contact shadow, gentle
 * turntable with drag-to-rotate (with inertia), responsive framing. Updates
 * live as the appearance changes and plays the requested animation.
 */
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, PCFSoftShadowMap, type Group, type OrthographicCamera, type PerspectiveCamera } from 'three';
import type { AnimState, Appearance, ItemId } from '@elsewhere/shared';
import { Character } from './Character.js';
import { getCharacter } from './cache.js';

export interface CharacterPreviewProps {
  appearance: Appearance;
  anim?: AnimState;
  /** Increments to replay one-shots (wave / interact). */
  animSeq?: number;
  /** Auto-rotate speed in rad/s (0 = still; dragging always works). */
  spin?: number;
  held?: ItemId | '';
  variant?: 'player' | 'npc';
  /** Start yaw (radians); default turns slightly toward the viewer's left. */
  yaw?: number;
  className?: string;
  style?: React.CSSProperties;
}

interface Drag {
  active: boolean;
  lastX: number;
  vel: number;
  yaw: number;
  idle: number;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(40,28,20,0.55)');
  grd.addColorStop(0.55, 'rgba(40,28,20,0.22)');
  grd.addColorStop(1, 'rgba(40,28,20,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

function Framing({ height }: { height: number }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as PerspectiveCamera | OrthographicCamera;
    if (!('fov' in cam)) return;
    const aspect = size.width / Math.max(1, size.height);
    const target = height * 0.5;
    const fitH = height * 1.18; // vertical extent incl. margins
    const fitW = 1.7; // arms out / dance
    const vfov = (cam.fov * Math.PI) / 180;
    const distH = fitH / 2 / Math.tan(vfov / 2);
    const distW = fitW / 2 / (Math.tan(vfov / 2) * aspect);
    const dist = Math.max(distH, distW);
    const pitch = 0.16;
    cam.position.set(0, target + Math.sin(pitch) * dist, Math.cos(pitch) * dist);
    cam.lookAt(0, target, 0);
    cam.updateProjectionMatrix();
  }, [camera, size, height]);
  return null;
}

function Turntable({ drag, spin, children }: { drag: React.MutableRefObject<Drag>; spin: number; children: React.ReactNode }) {
  const ref = useRef<Group>(null);
  useFrame((_, dt) => {
    const d = drag.current;
    if (!d.active) {
      d.idle += dt;
      d.vel *= Math.exp(-dt * 3.5);
      const auto = d.idle > 2.2 ? spin * Math.min(1, (d.idle - 2.2) / 1.5) : 0;
      d.yaw += (d.vel + auto) * dt;
    }
    if (ref.current) ref.current.rotation.y = d.yaw;
  });
  return <group ref={ref}>{children}</group>;
}

export function CharacterPreview({ appearance, anim = 'idle', animSeq = 0, spin = 0.45, held = '', variant = 'player', yaw = -0.45, className, style }: CharacterPreviewProps) {
  const drag = useRef<Drag>({ active: false, lastX: 0, vel: 0, yaw, idle: 10 });
  const blob = useMemo(() => (typeof document !== 'undefined' ? blobTexture() : null), []);
  useEffect(() => () => blob?.dispose(), [blob]);
  // Frame the actual silhouette (hair / hats included), with headroom for raised arms.
  const height = getCharacter(appearance).built.topY + 0.12;

  const onDown = (e: React.PointerEvent) => {
    drag.current.active = true;
    drag.current.lastX = e.clientX;
    drag.current.vel = 0;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    const dx = e.clientX - d.lastX;
    d.lastX = e.clientX;
    d.yaw += dx * 0.012;
    d.vel = dx * 0.012 * 60;
    d.idle = 0;
  };
  const onUp = () => {
    drag.current.active = false;
    drag.current.idle = 0;
  };

  return (
    <div
      className={className}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 160, touchAction: 'none', cursor: 'grab', ...style }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <Canvas shadows={{ type: PCFSoftShadowMap }} camera={{ position: [0, 1.2, 4.2], fov: 30 }} dpr={[1, 2]} gl={{ alpha: true, antialias: true }} style={{ position: 'absolute', inset: 0 }}>
        <Framing height={height} />
        <hemisphereLight args={['#fff4e6', '#6b5a4c', 0.75]} />
        {/* key: warm, high, front-left */}
        <directionalLight
          position={[2.2, 3.6, 2.8]}
          intensity={2.2}
          color="#ffe9d2"
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-left={-1.5}
          shadow-camera-right={1.5}
          shadow-camera-top={2.5}
          shadow-camera-bottom={-0.5}
          shadow-radius={6}
          shadow-bias={-0.0004}
        />
        {/* fill: cool, low, front-right */}
        <directionalLight position={[-3, 1.4, 2]} intensity={0.7} color="#d6e4ff" />
        {/* rim: behind */}
        <directionalLight position={[-1, 2.6, -3.5]} intensity={1.5} color="#fff0dc" />
        <Turntable drag={drag} spin={spin}>
          <Character appearance={appearance} anim={anim} animSeq={animSeq} held={held} variant={variant} castShadow seed={0.37} />
        </Turntable>
        {/* soft contact blob + real shadow catcher */}
        {blob && (
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}>
            <planeGeometry args={[1.5, 1.5]} />
            <meshBasicMaterial map={blob} transparent depthWrite={false} />
          </mesh>
        )}
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.001, 0]} receiveShadow>
          <circleGeometry args={[1.6, 40]} />
          <shadowMaterial transparent opacity={0.18} />
        </mesh>
      </Canvas>
    </div>
  );
}
