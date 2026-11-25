/**
 * Streetlights, lanterns and string lights: emissive bulbs, soft halos, faked
 * warm light pools on the ground, and a small BUDGETED pool of real point
 * lights (no shadows) assigned each frame to the nearest lamps that are on.
 * On/off comes from synced object state (see objectState.lightOn).
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, DoubleSide, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, AdditiveBlending, SphereGeometry, type PointLight } from 'three';
import { groundHeight } from '@elsewhere/shared';
import { anchors } from './arch/kit.js';
import { makeBillboards } from './billboard.js';
import { env } from './env.js';
import { blobTexture, bulbMaterial } from './materials.js';
import { lightOn } from './objectState.js';

const WARM = new Color('#ffc480');
const OFF = new Color('#8a8070');
const _m = new Matrix4();
const _c = new Color();

export function Lamps({ maxLights, density }: { maxLights: number; density: number }) {
  const lightRefs = useRef<(PointLight | null)[]>([]);
  const state = useRef(new Map<string, number>());
  const { bulbs, halos, pools, lamps, glows, lightIds } = useMemo(() => {
    const glows = anchors.glows;
    const lamps = anchors.lamps;
    const bulbs = new InstancedMesh(new SphereGeometry(1, 10, 8), bulbMaterial, Math.max(1, glows.length));
    glows.forEach((g, i) => {
      bulbs.setMatrixAt(i, _m.makeScale(g.size, g.size * 1.25, g.size).setPosition(g.position));
      bulbs.setColorAt(i, OFF);
    });
    bulbs.frustumCulled = false;
    const halos = makeBillboards(Math.max(1, glows.length), 'glow', true, false);
    glows.forEach((g, i) => {
      const s = g.kind === 1 ? 0.55 : 2.2;
      halos.setMatrixAt(i, _m.makeScale(s, s, s).setPosition(g.position));
    });
    const poolMat = new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    const poolGeo = new PlaneGeometry(1, 1);
    poolGeo.rotateX(-Math.PI / 2);
    const pools = new InstancedMesh(poolGeo, poolMat, Math.max(1, lamps.length));
    lamps.forEach((l, i) => {
      const r = l.range * (l.lightId.startsWith('light_') ? 1.05 : 0.8);
      pools.setMatrixAt(i, _m.makeScale(r, 1, r).setPosition(l.position.x, groundHeight(l.position.x, l.position.z) + 0.04, l.position.z));
      pools.setColorAt(i, new Color(0, 0, 0));
    });
    pools.frustumCulled = false;
    pools.renderOrder = 3;
    const lightIds = [...new Set([...glows.map((g) => g.lightId), ...lamps.map((l) => l.lightId)])];
    return { bulbs, halos, pools, lamps, glows, lightIds };
  }, []);
  void density;

  const order = useMemo(() => lamps.map((_, i) => i), [lamps]);

  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 4);
    const st = state.current;
    for (const id of lightIds) {
      const target = lightOn(id) ? 1 : 0;
      const cur = st.get(id) ?? target;
      st.set(id, cur + (target - cur) * k);
    }
    const nightGlow = 0.25 + 0.75 * env.glow;
    const t = env.time;
    glows.forEach((g, i) => {
      const lv = st.get(g.lightId) ?? 0;
      const flick = g.kind === 1 ? 0.85 + 0.15 * Math.sin(t * 2.3 + i * 1.7) : 0.93 + 0.07 * Math.sin(t * 7.1 + i) * Math.sin(t * 3.3 + i * 0.7);
      _c.copy(OFF).lerp(WARM, lv).multiplyScalar(lv > 0.01 ? 1 + lv * 1.6 * flick : 1);
      bulbs.setColorAt(i, _c);
      _c.copy(WARM).multiplyScalar(lv * nightGlow * flick * (g.kind === 1 ? 0.7 : 0.55));
      halos.setColorAt(i, _c);
    });
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;
    if (halos.instanceColor) halos.instanceColor.needsUpdate = true;
    lamps.forEach((l, i) => {
      const lv = st.get(l.lightId) ?? 0;
      _c.set(l.color).multiplyScalar(lv * env.glow * 0.42 * (0.95 + 0.05 * Math.sin(t * 5 + i)));
      pools.setColorAt(i, _c);
    });
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;

    // Point-light budget: nearest lamps that are on.
    const lights = lightRefs.current;
    if (maxLights > 0) {
      const f = env.focus;
      order.sort((a, b) => lamps[a]!.position.distanceToSquared(f) - lamps[b]!.position.distanceToSquared(f));
      let used = 0;
      for (const i of order) {
        if (used >= maxLights) break;
        const l = lamps[i]!;
        const lv = st.get(l.lightId) ?? 0;
        if (lv < 0.05 || env.glow < 0.05) continue;
        const pl = lights[used];
        if (!pl) break;
        pl.position.copy(l.position);
        pl.color.set(l.color);
        pl.intensity = l.intensity * lv * env.glow * 9;
        pl.distance = l.range * 1.5;
        used++;
      }
      for (let j = used; j < lights.length; j++) if (lights[j]) lights[j]!.intensity = 0;
    }
  });

  return (
    <group name="lamps">
      <primitive object={bulbs} />
      <primitive object={halos} />
      <primitive object={pools} />
      {Array.from({ length: maxLights }, (_, i) => (
        <pointLight key={i} ref={(r) => void (lightRefs.current[i] = r)} intensity={0} distance={10} decay={1.4} />
      ))}
    </group>
  );
}
