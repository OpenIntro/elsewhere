/**
 * The living layer: chimney smoke, drifting clouds (with ground shadows),
 * birds overhead, butterflies by day, fireflies at night, falling leaves,
 * a moored rowboat and buoys bobbing on the swell. All instanced, all
 * updated in place per frame; counts scale with the quality density.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color, DoubleSide, Euler, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type Group } from 'three';
import { BUSHES, TREES, getLocation, mulberry32, terrainHeight, WATER_LEVEL } from '@elsewhere/shared';
import { anchors, P } from './arch/kit.js';
import { makeBillboards } from './billboard.js';
import { cone, cyl, GeoBuilder, rbox, sphere, T, torus } from './geom.js';
import { env } from './env.js';
import { solidMaterial } from './materials.js';
import { TILE } from './Water.js';

const _m = new Matrix4();
const _q = new Quaternion();
const _v = new Vector3();
const _s = new Vector3();
const _c = new Color();
const _e = new Vector3();
const _eul = new Euler();
const UP = new Vector3(0, 1, 0);

function Smoke({ density }: { density: number }) {
  const per = Math.max(2, Math.round(7 * density));
  const sources = anchors.smoke;
  const mesh = useMemo(() => makeBillboards(Math.max(1, sources.length * per), 'puff', false, true), [sources.length, per]);
  useFrame(() => {
    const t = env.time;
    const alpha = mesh.geometry.getAttribute('aAlpha');
    const smokeC = _c.copy(env.hemiSky).lerp(new Color('#f2ede6'), 0.6).multiplyScalar(0.85 + 0.25 * (1 - env.night));
    sources.forEach((src, si) => {
      for (let k = 0; k < per; k++) {
        const i = si * per + k;
        const life = (t * 0.16 + k / per + si * 0.37) % 1;
        const drift = life * life * 2.2;
        const x = src.x + drift * 0.9 + Math.sin(t * 0.8 + i) * 0.15 * life;
        const y = src.y + life * 3.2;
        const z = src.z - drift * 0.35;
        const s = 0.35 + life * 1.3;
        _m.makeScale(s, s, s).setPosition(x, y, z);
        mesh.setMatrixAt(i, _m);
        mesh.setColorAt(i, smokeC);
        alpha.setX(i, Math.sin(Math.min(1, life * 1.4) * Math.PI) * 0.4);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    alpha.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

function Clouds({ shadows }: { shadows: boolean }) {
  const group = useRef<Group>(null);
  const { geo, mat, clouds } = useMemo(() => {
    const B = new GeoBuilder(17);
    const rnd = mulberry32(17);
    for (let k = 0; k < 7; k++) {
      const x = (k - 3) * 1.6 + rnd() * 0.6;
      const r = 1.8 + rnd() * 1.6 - Math.abs(k - 3) * 0.35;
      B.add('c', sphere(r, 14, 10), '#ffffff', T(x, rnd() * 0.6, rnd() * 1.6 - 0.8, 0, 0, 0, 1, 0.7, 1), { ao: false, jitter: 0, grad: 0.2 });
    }
    const geo = B.build().get('c')!;
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 1, transparent: true, opacity: 0.9, depthWrite: false });
    const rr = mulberry32(5);
    const clouds = Array.from({ length: 7 }, (_, i) => ({ x: TILE.minX + rr() * (TILE.maxX - TILE.minX), z: -90 + rr() * 160, y: 24 + rr() * 6, s: 0.8 + rr() * 0.7, speed: 0.6 + rr() * 0.5, yaw: rr() * 0.6 - 0.3, i }));
    return { geo, mat, clouds };
  }, []);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    // Clouds read as floating objects only from far out; up close only their shadows drift by.
    const vis = Math.max(0, Math.min(1, (16 - env.cameraZoom) / 8));
    mat.opacity = 0.88 * vis;
    mat.color.copy(env.hemiSky).lerp(new Color('#ffffff'), 0.65).multiplyScalar(0.8 + 0.35 * (1 - env.night));
    g.children.forEach((c, i) => {
      const cl = clouds[i]!;
      cl.x += cl.speed * dt * (0.6 + env.wind);
      if (cl.x > TILE.maxX + 20) cl.x = TILE.minX - 20;
      c.position.set(cl.x, cl.y, cl.z);
      c.visible = vis > 0.01 || shadows;
    });
  });
  return (
    <group ref={group}>
      {clouds.map((c) => (
        <mesh key={c.i} geometry={geo} material={mat} scale={c.s} rotation-y={c.yaw} castShadow={shadows} renderOrder={8} />
      ))}
    </group>
  );
}

function Birds({ density }: { density: number }) {
  const n = Math.max(4, Math.round(9 * density));
  const { body, wingL, wingR, birds } = useMemo(() => {
    const B = new GeoBuilder(3);
    B.add('b', sphere(0.12, 8, 6), '#3d3a3a', T(0, 0, 0, 0, 0, 0, 0.8, 0.7, 1.8), { ao: false });
    B.add('b', cone(0.05, 0.12, 4), '#d9a03f', T(0, 0, 0.25, 0, Math.PI / 2), { ao: false });
    const bodyGeo = B.build().get('b')!;
    const W = new GeoBuilder(4);
    W.add('w', rbox(0.5, 0.02, 0.18, 0.01), '#4a4646', T(0.25, 0, 0), { ao: false });
    const wingGeo = W.build().get('w')!;
    const body = new InstancedMesh(bodyGeo, solidMaterial, n);
    const wingL = new InstancedMesh(wingGeo, solidMaterial, n);
    const wingR = new InstancedMesh(wingGeo, solidMaterial, n);
    for (const m of [body, wingL, wingR]) m.frustumCulled = false;
    const rnd = mulberry32(23);
    const birds = Array.from({ length: n }, (_, i) => ({ r: 6 + rnd() * 6, phase: rnd() * 6.28, y: 13 + rnd() * 4, flap: 5 + rnd() * 3, cx: (rnd() - 0.5) * 3, cz: (rnd() - 0.5) * 3, i }));
    return { body, wingL, wingR, birds };
  }, [n]);
  useFrame(() => {
    const t = env.time;
    // the flock circles a slowly wandering centre
    const fx = Math.sin(t * 0.021) * 34 - 4;
    const fz = Math.cos(t * 0.017) * 30 - 6;
    const day = env.night < 0.6;
    for (const b of birds) {
      const a = t * 0.22 + b.phase;
      const x = fx + b.cx + Math.cos(a) * b.r;
      const z = fz + b.cz + Math.sin(a) * b.r;
      const y = b.y + Math.sin(t * 0.7 + b.phase) * 0.6;
      const yaw = Math.atan2(-Math.sin(a), Math.cos(a)) + Math.PI;
      const s = day ? 1 : 0;
      _q.setFromAxisAngle(UP, yaw);
      _m.compose(_v.set(x, y, z), _q, _s.set(s, s, s));
      body.setMatrixAt(b.i, _m);
      const flap = Math.sin(t * b.flap + b.phase) * 0.7;
      for (const [mesh, side] of [[wingL, 1], [wingR, -1]] as const) {
        const local = new Matrix4().makeRotationZ(side * flap);
        if (side < 0) local.premultiply(new Matrix4().makeRotationY(Math.PI));
        mesh.setMatrixAt(b.i, _m.clone().multiply(local));
      }
    }
    body.instanceMatrix.needsUpdate = true;
    wingL.instanceMatrix.needsUpdate = true;
    wingR.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <primitive object={body} />
      <primitive object={wingL} />
      <primitive object={wingR} />
    </>
  );
}

function Butterflies({ density }: { density: number }) {
  const n = Math.max(4, Math.round(18 * density));
  const { wingL, wingR, flies } = useMemo(() => {
    const W = new GeoBuilder(8);
    W.add('w', sphere(0.12, 8, 5), '#ffffff', T(0.11, 0, 0, 0, 0, 0, 1, 0.12, 0.8), { ao: false, jitter: 0 });
    const g = W.build().get('w')!;
    const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: DoubleSide });
    const wingL = new InstancedMesh(g, mat, n);
    const wingR = new InstancedMesh(g, mat, n);
    const palette = ['#f1d27a', '#f4efe6', '#e7a0a6', '#9fc0e8', '#e98a3b'];
    const rnd = mulberry32(41);
    const spots = BUSHES.filter((b) => b.kind === 'flowers');
    const res = getLocation('residential').center;
    const flies = Array.from({ length: n }, (_, i) => {
      const sp = spots.length && i % 3 ? spots[Math.floor(rnd() * spots.length)]!.position : { x: res.x + (rnd() - 0.5) * 16, z: res.z + (rnd() - 0.5) * 16 };
      const col = new Color(palette[i % palette.length]!);
      wingL.setColorAt(i, col);
      wingR.setColorAt(i, col);
      return { x: sp.x, z: sp.z, phase: rnd() * 6.28, r: 0.6 + rnd() * 1.5, i };
    });
    for (const m of [wingL, wingR]) m.frustumCulled = false;
    return { wingL, wingR, flies };
  }, [n]);
  useFrame(() => {
    const t = env.time;
    const day = env.daylight > 0.45 ? 1 : 0;
    for (const f of flies) {
      const a = t * 0.6 + f.phase;
      const x = f.x + Math.cos(a) * f.r + Math.sin(a * 2.3) * 0.3;
      const z = f.z + Math.sin(a * 0.8) * f.r;
      const y = terrainHeight(f.x, f.z) + 0.6 + Math.sin(a * 3.1) * 0.25 + 0.3;
      const yaw = a + Math.PI / 2;
      _q.setFromAxisAngle(UP, yaw);
      _m.compose(_v.set(x, y, z), _q, _s.set(day, day, day));
      const flap = 0.2 + Math.abs(Math.sin(t * 14 + f.phase)) * 1.2;
      wingL.setMatrixAt(f.i, _m.clone().multiply(new Matrix4().makeRotationZ(flap)));
      wingR.setMatrixAt(f.i, _m.clone().multiply(new Matrix4().makeRotationY(Math.PI)).multiply(new Matrix4().makeRotationZ(flap)));
    }
    wingL.instanceMatrix.needsUpdate = true;
    wingR.instanceMatrix.needsUpdate = true;
  });
  return (
    <>
      <primitive object={wingL} />
      <primitive object={wingR} />
    </>
  );
}

function Fireflies({ density }: { density: number }) {
  const n = Math.max(12, Math.round(140 * density));
  const { mesh, flies } = useMemo(() => {
    const mesh = makeBillboards(n, 'glow', true, false);
    const rnd = mulberry32(61);
    const zones = [getLocation('woods'), getLocation('residential'), getLocation('waterfront'), getLocation('the_unknown')];
    const flies = Array.from({ length: n }, (_, i) => {
      const z = zones[i % 5 === 0 ? 1 : i % 7 === 0 ? 2 : i % 11 === 0 ? 3 : 0]!;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * z.radius;
      const x = z.center.x + Math.cos(a) * r;
      const zz = z.center.z + Math.sin(a) * r;
      return { x, z: zz, y: Math.max(terrainHeight(x, zz), WATER_LEVEL) + 0.5 + rnd() * 1.6, phase: rnd() * 6.28, sp: 0.3 + rnd() * 0.5 };
    });
    return { mesh, flies };
  }, [n]);
  useFrame(() => {
    const t = env.time;
    const on = Math.max(0, (env.night - 0.35) / 0.65);
    flies.forEach((f, i) => {
      const a = t * f.sp + f.phase;
      _m.makeScale(0.28, 0.28, 0.28).setPosition(f.x + Math.sin(a) * 0.8, f.y + Math.sin(a * 1.7) * 0.3, f.z + Math.cos(a * 0.7) * 0.8);
      mesh.setMatrixAt(i, _m);
      const blink = Math.pow(Math.max(0, Math.sin(t * 1.3 + f.phase * 3)), 3);
      _c.setRGB(0.85, 1.0, 0.45).multiplyScalar(on * blink * 1.4);
      mesh.setColorAt(i, _c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

function Leaves({ density }: { density: number }) {
  const n = Math.max(8, Math.round(50 * density));
  const { mesh, leaves } = useMemo(() => {
    const B = new GeoBuilder(91);
    B.add('l', sphere(0.08, 6, 4), '#ffffff', T(0, 0, 0, 0, 0, 0, 1, 0.12, 1.5), { ao: false, jitter: 0 });
    const mesh = new InstancedMesh(B.build().get('l')!, new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide }), n);
    mesh.frustumCulled = false;
    const deciduous = TREES.filter((t) => t.kind !== 'pine');
    const rnd = mulberry32(73);
    const cols = ['#c9a23f', '#b0703d', '#9aae5c', '#d9b25f'];
    const leaves = Array.from({ length: n }, (_, i) => {
      const tr = deciduous[Math.floor(rnd() * deciduous.length)]!;
      mesh.setColorAt(i, new Color(cols[i % cols.length]!));
      return { tx: tr.position.x, tz: tr.position.z, top: terrainHeight(tr.position.x, tr.position.z) + 3.2 * tr.scale, phase: rnd(), sp: 0.07 + rnd() * 0.06, i };
    });
    return { mesh, leaves };
  }, [n]);
  useFrame(() => {
    const t = env.time;
    for (const l of leaves) {
      const life = (t * l.sp + l.phase) % 1;
      const ground = terrainHeight(l.tx, l.tz);
      const y = l.top - life * (l.top - ground);
      const x = l.tx + Math.sin(t * 1.5 + l.i) * 0.6 + life * 1.8;
      const z = l.tz + Math.cos(t * 1.1 + l.i) * 0.5;
      _q.setFromEuler(_eul.set(t * 2 + l.i, t * 1.3, Math.sin(t * 3 + l.i)));
      const s = life > 0.96 ? 0 : 1;
      _m.compose(_v.set(x, y, z), _q, _s.set(s, s, s));
      mesh.setMatrixAt(l.i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

function Harbour() {
  const boat = useRef<Group>(null);
  const buoys = useRef<Group>(null);
  const { boatGeo, buoyGeo } = useMemo(() => {
    const B = new GeoBuilder(5);
    const no = { ao: false };
    B.add('b', sphere(1.0, 16, 10), '#a44a3f', T(0, 0, 0, 0, 0, 0, 0.75, 0.42, 1.9), no);
    B.add('b', sphere(0.93, 16, 10), '#efe6d4', T(0, 0.1, 0, 0, 0, 0, 0.68, 0.36, 1.8), no);
    B.add('b', torus(0.7, 0.06, 6, 24), '#6b5444', T(0, 0.28, 0, 0, Math.PI / 2, 0, 1, 2.45, 1), no);
    for (const z of [-0.6, 0.4]) B.add('b', rbox(1.25, 0.06, 0.3, 0.02), P.woodLight, T(0, 0.22, z), no);
    B.add('b', rbox(0.06, 0.05, 2.2, 0.02), P.woodLight, T(0.35, 0.3, 0.1, 0.12, 0, 0.3), no);
    B.add('b', rbox(0.22, 0.03, 0.5, 0.02), P.woodLight, T(0.48, 0.36, 1.05, 0.12, 0, 0.3), no);
    const boatGeo = B.build().get('b')!;
    const U = new GeoBuilder(6);
    U.add('u', sphere(0.32, 12, 8), '#e98a6b', T(0, 0.1, 0, 0, 0, 0, 1, 0.8, 1), no);
    U.add('u', cyl(0.33, 0.33, 0.12, 12), '#f4efe6', T(0, 0.15, 0), no);
    U.add('u', cyl(0.04, 0.04, 0.6, 6), '#3f4447', T(0, 0.55, 0), no);
    U.add('u', sphere(0.08, 8, 6), '#f1d27a', T(0, 0.88, 0), no);
    return { boatGeo, buoyGeo: U.build().get('u')! };
  }, []);
  const buoySpots = useMemo(() => [{ x: 22, z: 60 }, { x: 6, z: 66 }, { x: 25, z: 68 }], []);
  useFrame(() => {
    const t = env.time;
    if (boat.current) {
      boat.current.position.y = WATER_LEVEL - 0.02 + Math.sin(t * 1.1) * 0.05;
      boat.current.rotation.z = Math.sin(t * 0.9) * 0.05;
      boat.current.rotation.x = Math.sin(t * 0.7 + 1) * 0.03;
    }
    buoys.current?.children.forEach((c, i) => {
      c.position.y = WATER_LEVEL - 0.05 + Math.sin(t * 1.3 + i * 2) * 0.07;
      c.rotation.z = Math.sin(t * 1.1 + i) * 0.12;
    });
  });
  return (
    <group name="harbour">
      <group ref={boat} position={[17.4, 0, 56.5]} rotation-y={0.12}>
        <mesh geometry={boatGeo} material={solidMaterial} castShadow />
      </group>
      <group ref={buoys}>
        {buoySpots.map((b, i) => (
          <mesh key={i} geometry={buoyGeo} material={solidMaterial} position={[b.x, 0, b.z]} castShadow />
        ))}
      </group>
    </group>
  );
}

export function Life({ density, shadows }: { density: number; shadows: boolean }) {
  void _e;
  return (
    <group name="life">
      <Smoke density={density} />
      <Clouds shadows={shadows} />
      <Birds density={density} />
      <Butterflies density={density} />
      <Fireflies density={density} />
      <Leaves density={density} />
      <Harbour />
    </group>
  );
}
