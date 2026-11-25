/**
 * Animated architecture: door leaves (open/close from synced state), the Town
 * Hall bell (swings on ring events), clock hands showing world time,
 * weathervane, workshop gear and windmill.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Group, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry } from 'three';
import { S2C } from '@elsewhere/shared';
import { net } from '../net/index.js';
import { anchors, P, shade, type DoorAnchor } from './arch/kit.js';
import { cone, cyl, GeoBuilder, lathe, rbox, sphere, T, torus } from './geom.js';
import { env } from './env.js';
import { cutDepthMaterial, solidMaterial, glazedMaterial, solidCutMaterial, windowCutMaterial } from './materials.js';
import { bellRings, doorOpen } from './objectState.js';
import { runtime } from '../state/runtime.js';

const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();

function decompose(m: Matrix4, g: Group): void {
  m.decompose(_p, _q, _s);
  g.position.copy(_p);
  g.quaternion.copy(_q);
}

/** Geometry for one door leaf: hinge at local x=0, leaf extends to +x (width w). */
function leafGeometry(d: DoorAnchor, w: number, mirror: boolean): Map<string, BufferGeometry> {
  const B = new GeoBuilder(d.id.length);
  B.cut = d.cut; // leaves fade with the wall they sit in
  const h = d.height;
  const no = { ao: false };
  const c = d.color;
  const dk = shade(c, 0.8);
  const sx = mirror ? -1 : 1;
  const cx = (sx * w) / 2;
  if (d.style === 'round') {
    B.add('s', rbox(w - 0.04, h - w / 2, 0.08, 0.03), c, T(cx, (h - w / 2) / 2, 0), no);
    B.add('s', cyl(w / 2 - 0.02, w / 2 - 0.02, 0.08, 20, false), c, T(cx, h - w / 2, 0, 0, Math.PI / 2), no);
    for (let k = 1; k < 4; k++) B.add('s', rbox(0.025, h - 0.1, 0.02, 0.01), dk, T(cx - w / 2 + (k * w) / 4, h / 2 - 0.05, 0.05), no);
  } else if (d.style === 'barn') {
    B.add('s', rbox(w - 0.04, h - 0.04, 0.1, 0.03), c, T(cx, h / 2, 0), no);
    const len = Math.hypot(w - 0.2, h - 0.3);
    B.add('s', rbox(0.14, len, 0.04, 0.02), dk, T(cx, h / 2, 0.06, 0, 0, Math.atan2(w - 0.2, h - 0.3) * sx), no);
    for (const y of [0.15, h / 2, h - 0.15]) B.add('s', rbox(w - 0.1, 0.14, 0.05, 0.02), dk, T(cx, y, 0.065), no);
  } else {
    B.add('s', rbox(w - 0.04, h - 0.04, 0.08, 0.03), c, T(cx, h / 2, 0), no);
    if (d.style === 'glass') {
      B.addRaw('w', rbox(w - 0.34, h * 0.45, 0.02, 0.01), [0.9, 0.5, 0], T(cx, h * 0.64, 0.045));
      B.add('s', rbox(w - 0.3, 0.05, 0.03, 0.01), dk, T(cx, h * 0.64, 0.055), no);
    } else if (d.style === 'panel') {
      for (const y of [h * 0.28, h * 0.68]) B.add('s', rbox(w - 0.3, h * 0.3, 0.03, 0.02), dk, T(cx, y, 0.045), no);
    } else {
      for (let k = 1; k < 4; k++) B.add('s', rbox(0.02, h - 0.1, 0.02, 0.01), dk, T(cx - w / 2 + (k * w) / 4, h / 2, 0.045), no);
      for (const y of [0.35, h - 0.4]) B.add('s', rbox(w - 0.12, 0.1, 0.03, 0.01), dk, T(cx, y, 0.05), no);
    }
  }
  B.add('s', sphere(0.05, 8, 6), P.brass, T(sx * (w - 0.14), h * 0.48, 0.08), no);
  return B.build();
}

const _dp = new Vector3();
/** Someone (local or remote) standing at a walk-in door: it swings open for them. */
function someoneAt(d: DoorAnchor): boolean {
  _dp.setFromMatrixPosition(d.frame);
  const r2 = 2.1 * 2.1;
  const lp = runtime.localPlayer;
  if (lp.ready && (lp.x - _dp.x) ** 2 + (lp.z - _dp.z) ** 2 < r2) return true;
  for (const [, r] of runtime.remotes) {
    const p = r.render;
    if (p && p.visible && (p.x - _dp.x) ** 2 + (p.z - _dp.z) ** 2 < r2) return true;
  }
  return false;
}

function Door({ d }: { d: DoorAnchor }) {
  const root = useRef<Group>(null);
  const leaves = useRef<Group[]>([]);
  const parts = useMemo(() => {
    const w = d.double ? d.width / 2 : d.width;
    if (d.double) return [{ x: -d.width / 2, mirror: false, geo: leafGeometry(d, w, false) }, { x: d.width / 2, mirror: true, geo: leafGeometry(d, w, true) }];
    return [{ x: -d.width / 2, mirror: false, geo: leafGeometry(d, w, false) }];
  }, [d]);
  const angle = useRef(0);
  useEffect(() => {
    if (root.current) decompose(d.frame, root.current);
  }, [d]);
  useFrame((_, dt) => {
    const target = doorOpen(d.id) || (d.walkIn && someoneAt(d)) ? 1 : 0;
    const k = 1 - Math.exp(-dt * 5);
    angle.current += (target - angle.current) * k;
    const a = angle.current;
    // ease with a little overshoot feel via sine; walk-in doors swing inwards, closed ones out
    const open = a * (Math.PI * (d.walkIn ? 0.47 : 0.55)) * (1 + 0.06 * Math.sin(a * Math.PI));
    const s = d.walkIn ? -1 : 1;
    parts.forEach((p, i) => {
      const g = leaves.current[i];
      if (g) g.rotation.y = (p.mirror ? open : -open) * s;
    });
  });
  return (
    <group ref={root}>
      {parts.map((p, i) => (
        <group key={i} position={[p.x, 0, 0.02]} ref={(g) => void (g && (leaves.current[i] = g))}>
          {[...p.geo].map(([bucket, geo]) => (
            <mesh key={bucket} geometry={geo} material={bucket === 'w' ? windowCutMaterial : solidCutMaterial} castShadow receiveShadow customDepthMaterial={cutDepthMaterial()} />
          ))}
        </group>
      ))}
    </group>
  );
}

function Bell() {
  const root = useRef<Group>(null);
  const swing = useRef<Group>(null);
  const motion = useRef({ amp: 0, phase: 0, lastRings: -1 });
  const geo = useMemo(() => {
    const B = new GeoBuilder(5);
    const no = { ao: false };
    const prof: [number, number][] = [[0.001, 0], [0.5, 0], [0.52, 0.06], [0.42, 0.2], [0.33, 0.55], [0.3, 0.8], [0.22, 0.92], [0.001, 0.95]];
    B.add('b', lathe('bell', prof, 24), '#b8893e', T(0, -0.95, 0), no);
    B.add('b', torus(0.47, 0.035, 6, 24), '#9a7232', T(0, -0.9, 0, 0, Math.PI / 2), no);
    B.add('b', sphere(0.1, 8, 6), '#6a5a4a', T(0, -0.95, 0), no);
    B.add('b', cyl(0.03, 0.03, 0.3, 6), P.iron, T(0, -0.82, 0), no);
    B.add('b', torus(0.1, 0.03, 6, 12), P.iron, T(0, 0.02, 0), no);
    return B.build().get('b')!;
  }, []);
  useEffect(() => {
    if (root.current && anchors.bell) decompose(anchors.bell, root.current);
    const off = net.on(S2C.objectEvent, (e) => {
      if (e.kind === 'bell_rung' && e.id === 'bell_town_hall') motion.current.amp = Math.min(0.75, motion.current.amp + 0.55);
    });
    return off;
  }, []);
  useFrame((_, dt) => {
    const m = motion.current;
    const rings = bellRings('bell_town_hall');
    if (m.lastRings >= 0 && rings > m.lastRings) m.amp = Math.max(m.amp, 0.55);
    m.lastRings = rings;
    m.phase += dt * 4.2;
    m.amp *= Math.exp(-dt * 0.55);
    if (swing.current) swing.current.rotation.x = Math.sin(m.phase) * m.amp;
  });
  if (!anchors.bell) return null;
  return (
    <group ref={root}>
      <group ref={swing}>
        <mesh geometry={geo} material={glazedMaterial} castShadow />
      </group>
    </group>
  );
}

function ClockHands() {
  const groups = useRef<Group[]>([]);
  const geo = useMemo(() => {
    const B = new GeoBuilder(3);
    B.add('h', rbox(0.07, 0.42, 0.03, 0.015), '#3a3236', T(0, 0.19, 0), { ao: false });
    const hour = B.build().get('h')!;
    const B2 = new GeoBuilder(4);
    B2.add('m', rbox(0.05, 0.62, 0.03, 0.015), '#3a3236', T(0, 0.29, 0.02), { ao: false });
    B2.add('m', sphere(0.06, 8, 6), P.brass, T(0, 0, 0.03), { ao: false });
    const minute = B2.build().get('m')!;
    return { hour, minute };
  }, []);
  useEffect(() => {
    anchors.clock.forEach((m, i) => {
      const g = groups.current[i];
      if (g) decompose(m, g);
    });
  }, []);
  useFrame(() => {
    const h = env.hours % 12;
    groups.current.forEach((g) => {
      const [hh, mm] = g.children as Mesh[];
      if (hh) hh.rotation.z = -(h / 12) * Math.PI * 2;
      if (mm) mm.rotation.z = -((env.hours % 1) * Math.PI * 2);
    });
  });
  return (
    <>
      {anchors.clock.map((_, i) => (
        <group key={i} ref={(g) => void (g && (groups.current[i] = g))}>
          <mesh geometry={geo.hour} material={solidMaterial} />
          <mesh geometry={geo.minute} material={solidMaterial} />
        </group>
      ))}
    </>
  );
}

function Spinners() {
  const groups = useRef<Group[]>([]);
  const spinners = anchors.spinners;
  const geos = useMemo(
    () =>
      spinners.map((s) => {
        const B = new GeoBuilder(9);
        const no = { ao: false };
        if (s.kind === 'gear') {
          B.add('g', cyl(s.size, s.size, 0.14, 24), P.brass, T(0, 0, 0, 0, Math.PI / 2), no);
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * Math.PI * 2;
            B.add('g', rbox(0.22, 0.22, 0.14, 0.04), P.brass, T(Math.cos(a) * s.size, Math.sin(a) * s.size, 0, 0, 0, a), no);
          }
          B.add('g', cyl(s.size * 0.4, s.size * 0.4, 0.2, 16), shade(P.brass, 0.75), T(0, 0, 0.02, 0, Math.PI / 2), no);
          for (let k = 0; k < 6; k++) B.add('g', cyl(0.09, 0.09, 0.18, 8), shade(P.brass, 0.6), T(Math.cos(k) * s.size * 0.68, Math.sin(k) * s.size * 0.68, 0.02, 0, Math.PI / 2), no);
        } else if (s.kind === 'vane') {
          B.add('g', rbox(0.06, 0.06, 1.1, 0.02), P.iron, T(0, 0, 0), no);
          B.add('g', cone(0.12, 0.3, 4), P.iron, T(0, 0, 0.6, 0, Math.PI / 2), no);
          B.add('g', rbox(0.04, 0.32, 0.36, 0.02), P.iron, T(0, 0.05, -0.5), no);
          B.add('g', sphere(0.1, 8, 6), P.brass, T(0, 0.25, 0.05), no);
        } else {
          for (let k = 0; k < 4; k++) B.add('g', rbox(0.12, 0.7, 0.03, 0.02), k % 2 ? '#efe3cf' : '#b0563d', T(0, 0, 0.05, 0, 0, (k / 4) * Math.PI * 2).multiply(T(0, 0.38, 0)), no);
          B.add('g', sphere(0.08, 8, 6), P.iron, T(0, 0, 0.06), no);
          B.add('g', rbox(0.04, 0.04, 0.5, 0.01), P.iron, T(0, 0, -0.25), no);
          B.add('g', rbox(0.02, 0.24, 0.24, 0.01), P.iron, T(0, 0, -0.5), no);
        }
        return B.build().get('g')!;
      }),
    [spinners],
  );
  useEffect(() => {
    spinners.forEach((s, i) => {
      const g = groups.current[i];
      if (g) decompose(s.matrix, g);
    });
  }, [spinners]);
  useFrame((_, dt) => {
    spinners.forEach((s, i) => {
      const g = groups.current[i]?.children[0];
      if (!g) return;
      if (s.kind === 'vane') g.rotation.y = Math.sin(env.time * 0.13) * 0.8 + Math.sin(env.time * 0.71) * 0.15;
      else if (s.kind === 'windmill') {
        g.rotation.y = Math.sin(env.time * 0.1) * 0.5;
        const blades = g as Mesh;
        blades.rotation.z += dt * s.speed * (1 + env.wind);
      } else g.rotation.z += dt * s.speed;
    });
  });
  return (
    <>
      {spinners.map((s, i) => (
        <group key={i} ref={(g) => void (g && (groups.current[i] = g))}>
          <mesh geometry={geos[i]} material={glazedMaterial} castShadow />
        </group>
      ))}
    </>
  );
}

export function Mechanisms() {
  return (
    <group name="mechanisms">
      {anchors.doors.map((d) => (
        <Door key={d.id} d={d} />
      ))}
      <Bell />
      <ClockHands />
      <Spinners />
    </group>
  );
}
