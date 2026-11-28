/**
 * Subtle in-world feedback:
 *  - TargetIndicator: a small softly bobbing diamond above the current
 *    interaction target plus a faint ground ring (objects and players).
 *  - DestinationMarker: a ring at the click/tap destination that settles in,
 *    breathes gently while walking and fades on arrival. Dimmer when the
 *    target was unreachable (we walk to the nearest reachable point).
 * Both are allocation-free per frame and never cast shadows.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, DoubleSide, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import { groundHeight } from '@elsewhere/shared';
import { runtime } from '../state/runtime.js';
import { target } from './interaction.js';
import { nav } from './navigation.js';

const WARM = '#ffe2a8';

export function TargetIndicator() {
  const group = useRef<Group>(null);
  const gem = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const state = useRef({ alpha: 0, x: 0, y: 0, z: 0, h: 0, id: '' });
  useFrame(({ clock }, dt) => {
    const g = group.current;
    if (!g || !gem.current || !ring.current) return;
    const s = state.current;
    const active = target.kind !== 'none';
    if (active) {
      let tx = target.x;
      let ty = target.y;
      let tz = target.z;
      if (target.kind === 'player') {
        const r = runtime.remotes.get(target.id)?.render;
        if (r) {
          tx = r.x;
          ty = r.y;
          tz = r.z;
        }
      }
      if (s.id !== target.id || s.alpha < 0.02) {
        s.x = tx;
        s.y = ty;
        s.z = tz;
        s.h = target.height;
        s.id = target.id;
      } else {
        const k = 1 - Math.exp(-dt * 14);
        s.x += (tx - s.x) * k;
        s.y += (ty - s.y) * k;
        s.z += (tz - s.z) * k;
        s.h += (target.height - s.h) * k;
      }
    }
    s.alpha += ((active ? 1 : 0) - s.alpha) * (1 - Math.exp(-dt * 10));
    g.visible = s.alpha > 0.01;
    if (!g.visible) return;
    const t = clock.elapsedTime;
    g.position.set(s.x, s.y, s.z);
    gem.current.position.y = s.h + Math.sin(t * 2.4) * 0.07;
    gem.current.rotation.y = t * 1.2;
    (gem.current.material as MeshBasicMaterial).opacity = 0.85 * s.alpha;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
    ring.current.scale.setScalar(target.kind === 'player' ? 0.75 : 1 + pulse * 0.06);
    (ring.current.material as MeshBasicMaterial).opacity = (0.22 + 0.12 * pulse) * s.alpha;
  });
  return (
    <group ref={group} visible={false}>
      <mesh ref={gem} renderOrder={10}>
        <octahedronGeometry args={[0.11, 0]} />
        <meshBasicMaterial color={WARM} transparent depthWrite={false} />
      </mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.04} renderOrder={9}>
        <ringGeometry args={[0.62, 0.72, 40]} />
        <meshBasicMaterial color={WARM} transparent depthWrite={false} side={DoubleSide} blending={AdditiveBlending} />
      </mesh>
    </group>
  );
}

export function DestinationMarker() {
  const group = useRef<Group>(null);
  const outer = useRef<Mesh>(null);
  const dot = useRef<Mesh>(null);
  const s = useRef({ version: -1, born: 0, alpha: 0, x: 0, y: 0, z: 0, exact: true });
  const geo = useMemo(() => ({ outerArgs: [0.32, 0.4, 36] as [number, number, number] }), []);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g || !outer.current || !dot.current) return;
    const st = s.current;
    const now = performance.now();
    if (nav.version !== st.version) {
      st.version = nav.version;
      if (nav.goal) {
        st.born = now;
        st.x = nav.goal.x;
        st.z = nav.goal.z;
        st.y = groundHeight(st.x, st.z);
        st.exact = nav.exact;
      }
    }
    const active = !!nav.goal;
    st.alpha += ((active ? 1 : 0) - st.alpha) * (1 - Math.exp(-dt * (active ? 14 : 5)));
    g.visible = st.alpha > 0.01;
    if (!g.visible) return;
    const age = (now - st.born) / 1000;
    // Settle-in: starts wide, eases to size; then breathes softly.
    const settle = Math.min(1, age / 0.35);
    const ease = 1 - Math.pow(1 - settle, 3);
    const breathe = 1 + 0.06 * Math.sin(age * 4);
    g.position.set(st.x, st.y + 0.05, st.z);
    outer.current.scale.setScalar((1.9 - 0.9 * ease) * breathe);
    const base = st.exact ? 0.75 : 0.4;
    (outer.current.material as MeshBasicMaterial).opacity = base * st.alpha * (0.4 + 0.6 * ease);
    (dot.current.material as MeshBasicMaterial).opacity = base * 0.8 * st.alpha;
  });
  return (
    <group ref={group} visible={false}>
      <mesh ref={outer} rotation-x={-Math.PI / 2} renderOrder={9}>
        <ringGeometry args={geo.outerArgs} />
        <meshBasicMaterial color="#fff4dc" transparent depthWrite={false} side={DoubleSide} />
      </mesh>
      <mesh ref={dot} rotation-x={-Math.PI / 2} renderOrder={9}>
        <circleGeometry args={[0.08, 16]} />
        <meshBasicMaterial color="#fff4dc" transparent depthWrite={false} side={DoubleSide} />
      </mesh>
    </group>
  );
}
