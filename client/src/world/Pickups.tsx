/**
 * Pickups (visible at their spot while present, hidden while someone holds
 * them — objects[id].active/holder) and twinkles that make hidden things
 * findable: a rare, brief glint for hidden objects, a softer periodic one for
 * pickups, steady glow for woodland glow-caps at night.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, Group, Matrix4, Vector3, type BufferGeometry } from 'three';
import { INTERACTABLES, ITEMS, PROPS, groundHeight, type ItemId, type PickupInteractable } from '@elsewhere/shared';
import { anchors, P } from './arch/kit.js';
import { makeBillboards } from './billboard.js';
import { cone, cyl, GeoBuilder, rbox, sphere, T, torus } from './geom.js';
import { env } from './env.js';
import { solidMaterial, staticPlantMaterial } from './materials.js';
import { pickupPresent } from './objectState.js';

const PICKUPS = INTERACTABLES.filter((i): i is PickupInteractable => i.kind === 'pickup');

function itemGeometry(id: ItemId): Map<string, BufferGeometry> {
  const B = new GeoBuilder(id.length);
  const no = { ao: false };
  const c = ITEMS[id].color;
  switch (ITEMS[id].shape) {
    case 'sphere':
      B.add('s', sphere(0.15, 14, 10), c, T(0, 0.15, 0, 0, 0, 0, 1, 0.92, 1), no);
      B.add('s', cyl(0.012, 0.015, 0.09, 5), P.woodDark, T(0, 0.31, 0, 0, 0.2), no);
      B.add('s', sphere(0.05, 6, 4), '#6f9a52', T(0.04, 0.32, 0, 0, 0, 0.6, 1.4, 0.3, 0.8), no);
      break;
    case 'tool':
      B.add('s', rbox(0.06, 0.03, 0.55, 0.012), c, T(0, 0.03, 0), no);
      B.add('s', torus(0.07, 0.025, 5, 10, Math.PI * 1.5), c, T(0, 0.03, 0.3, 0, Math.PI / 2, Math.PI * 0.75), no);
      B.add('s', rbox(0.075, 0.04, 0.2, 0.015), '#a44a3f', T(0, 0.035, -0.18), no);
      break;
    case 'flower':
      B.add('s', cyl(0.012, 0.012, 0.32, 4), '#6f8f4d', T(0, 0.16, 0), no);
      for (let k = 0; k < 6; k++) B.add('s', sphere(0.05, 6, 5), c, T(Math.cos(k) * 0.06, 0.33, Math.sin(k) * 0.06, 0, 0, 0, 1, 0.5, 1), no);
      B.add('s', sphere(0.035, 6, 5), '#f1d27a', T(0, 0.34, 0), no);
      B.add('s', sphere(0.05, 6, 4), '#6f9a52', T(0.05, 0.12, 0, 0, 0, 0.8, 1.6, 0.3, 0.8), no);
      break;
    case 'pebble':
      B.add('s', sphere(0.12, 12, 8), c, T(0, 0.04, 0, 0, 0, 0, 1.3, 0.45, 1), no);
      break;
    case 'cone':
      for (let k = 0; k < 5; k++) B.add('s', cone(0.1 - k * 0.015, 0.1, 8), c, T(0, 0.04 + k * 0.05, 0, k * 0.5, Math.PI), no);
      break;
    case 'shell':
      for (let k = 0; k < 5; k++) B.add('s', sphere(0.08, 8, 6), c, T((k - 2) * 0.035, 0.03, 0, 0, 0, (k - 2) * 0.3, 0.4, 0.35, 1), no);
      B.add('s', sphere(0.05, 8, 6), '#d9b8a2', T(0, 0.03, -0.07, 0, 0, 0, 1.4, 0.5, 0.6), no);
      break;
    case 'lantern':
      B.add('s', sphere(0.17, 12, 10), c, T(0, 0.22, 0, 0, 0, 0, 1, 1.15, 1), no);
      for (let k = 0; k < 4; k++) B.add('s', torus(0.172, 0.008, 4, 16), '#b07a3a', T(0, 0.12 + k * 0.07, 0, 0, Math.PI / 2, 0, 1, 1, 1 - Math.abs(k - 1.5) * 0.12), no);
      B.add('s', cyl(0.06, 0.06, 0.04, 8), '#5a4636', T(0, 0.41, 0), no);
      B.add('s', torus(0.05, 0.01, 4, 8), '#5a4636', T(0, 0.47, 0), no);
      break;
  }
  return B.build();
}

export function Pickups({ density }: { density: number }) {
  const groups = useRef<Group[]>([]);
  const items = useMemo(
    () =>
      PICKUPS.map((p) => {
        // Resting surface: on top of a prop if it sits on one (apple on the crate).
        let y = groundHeight(p.position.x, p.position.z);
        for (const pr of PROPS) {
          const d = Math.hypot(pr.position.x - p.position.x, pr.position.z - p.position.z);
          if (d < 0.65) y = Math.max(y, groundHeight(pr.position.x, pr.position.z) + pr.height + 0.02);
        }
        return { p, y, geo: itemGeometry(p.itemId), yaw: (p.id.length * 1.3) % 6.28 };
      }),
    [],
  );
  const { stars, points } = useMemo(() => {
    const pts: { pos: Vector3; kind: 'hidden' | 'pickup' | 'cap' | 'bob'; id: string; phase: number }[] = [];
    for (const s of anchors.sparkles) pts.push({ pos: s.position, kind: s.id === 'glowcap' ? 'cap' : s.id === 'fishing_bob' ? 'bob' : 'hidden', id: s.id, phase: (s.position.x * 3.7 + s.position.z * 1.3) % 6.28 });
    for (const it of items) pts.push({ pos: new Vector3(it.p.position.x, it.y + 0.35, it.p.position.z), kind: 'pickup', id: it.p.id, phase: it.yaw });
    const stars = makeBillboards(pts.length, 'star', true, false);
    return { stars, points: pts };
  }, [items]);
  void density;
  const _m = useMemo(() => new Matrix4(), []);
  const _c = useMemo(() => new Color(), []);
  const lanternGlow = useMemo(() => new Color('#ffd28a'), []);

  useFrame(() => {
    const t = env.time;
    items.forEach((it, i) => {
      const g = groups.current[i];
      if (!g) return;
      g.visible = pickupPresent(it.p.id);
      g.rotation.y = it.yaw + Math.sin(t * 0.5 + i) * 0.1;
    });
    points.forEach((p, i) => {
      let size = 0.4;
      let k = 0;
      if (p.kind === 'hidden') {
        // brief glint every ~9s, brighter at night
        k = Math.pow(Math.max(0, Math.sin(t * 0.7 + p.phase)), 60) * (0.8 + env.night);
        size = 0.55;
      } else if (p.kind === 'pickup') {
        const present = pickupPresent(p.id);
        k = present ? Math.pow(Math.max(0, Math.sin(t * 1.1 + p.phase)), 18) * 0.9 : 0;
        size = 0.5;
      } else if (p.kind === 'cap') {
        k = env.night * (0.18 + 0.06 * Math.sin(t * 1.3 + p.phase));
        size = 0.35;
      } else {
        k = 0.25 + 0.1 * Math.sin(t * 2 + p.phase);
        size = 0.16;
      }
      const y = p.kind === 'bob' ? p.pos.y + Math.sin(t * 1.6) * 0.04 : p.pos.y;
      _m.makeScale(size, size, size).setPosition(p.pos.x, y, p.pos.z);
      stars.setMatrixAt(i, _m);
      _c.set(p.kind === 'cap' ? '#7ff5d8' : p.kind === 'bob' ? '#ff6a50' : '#fff4d0').multiplyScalar(k);
      stars.setColorAt(i, _c);
    });
    stars.instanceMatrix.needsUpdate = true;
    if (stars.instanceColor) stars.instanceColor.needsUpdate = true;
    void lanternGlow;
  });

  return (
    <group name="pickups">
      {items.map((it, i) => (
        <group key={it.p.id} position={[it.p.position.x, it.y, it.p.position.z]} ref={(g) => void (g && (groups.current[i] = g))}>
          {[...it.geo].map(([b, geo]) => (
            <mesh key={b} geometry={geo} material={b === 'p' ? staticPlantMaterial : solidMaterial} castShadow />
          ))}
        </group>
      ))}
      <primitive object={stars} />
    </group>
  );
}
