/**
 * The Town Square fountain and its Collective Reality transformation stages
 * (objects['fountain'].value, 0..CONFIG.collective.fountainStages.length):
 *   0 weathered stone basin, a modest trickle
 *   1 restored: second tier, arcing jets, lily pads
 *   2 enchanted: three tiers, mosaic band, glowing water, flower crown, fish spouts
 *   3 radiant: marble + gold, floating light orb, spiral water ribbons,
 *     orbiting crystals, a light pillar, rainbow and rising motes.
 * Each stage swells in with a burst of sparkles when it changes.
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  QuadraticBezierCurve3,
  ShaderMaterial,
  TubeGeometry,
  Vector3,
  type BufferGeometry,
  type PointLight,
} from 'three';
import { FOUNTAIN, terrainHeight } from '@elsewhere/shared';
import { P, shade } from './arch/kit.js';
import { makeBillboards } from './billboard.js';
import { cyl, GeoBuilder, ico, lathe, rbox, sphere, T, torus } from './geom.js';
import { env, uniforms } from './env.js';
import { glazedMaterial, solidMaterial, staticPlantMaterial } from './materials.js';
import { FOUNTAIN_MAX_STAGE, fountainStage } from './objectState.js';

const G = terrainHeight(FOUNTAIN.position.x, FOUNTAIN.position.z);
const WATER_Y = 0.62;

function waterMaterial(kind: 'flow' | 'pool', magic: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: { uTime: uniforms.uTime, uNight: uniforms.uNight, uSunColor: uniforms.uSunColor, uMagic: magic, uShallow: uniforms.uWaterShallow },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uNight; uniform vec3 uSunColor; uniform float uMagic; uniform vec3 uShallow;
      varying vec2 vUv; varying vec3 vW;
      float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
      void main(){
        vec3 base = mix(vec3(0.55, 0.78, 0.8), vec3(0.45, 0.9, 0.95), clamp(uMagic * 0.5, 0.0, 1.0));
        base = mix(base, vec3(0.62, 0.95, 1.0), clamp(uMagic - 2.0, 0.0, 1.0));
        float a;
        vec3 c;
        ${kind === 'flow'
          ? `float s = fract(vUv.y * 3.0 - uTime * 1.6 + sin(vUv.x * 25.0) * 0.08);
             float streak = smoothstep(0.0, 0.25, s) * smoothstep(1.0, 0.55, s);
             float fine = 0.5 + 0.5 * sin(vUv.x * 60.0 + vUv.y * 8.0 - uTime * 7.0);
             float strands = smoothstep(0.35, 0.9, 0.5 + 0.5 * sin(vUv.x * 90.0 + sin(vUv.x * 13.0) * 2.0));
             c = base * (0.9 + 0.35 * streak) + vec3(1.0) * fine * 0.2;
             a = (0.12 + 0.42 * streak * strands + 0.12 * fine) * (0.6 + 0.4 * smoothstep(0.0, 0.25, vUv.y));`
          : `vec2 p = vW.xz - vec2(${FOUNTAIN.position.x.toFixed(2)}, ${FOUNTAIN.position.z.toFixed(2)});
             float r = length(p);
             float rip = 0.5 + 0.5 * sin(r * 7.0 - uTime * 2.6);
             float rip2 = 0.5 + 0.5 * sin(r * 13.0 - uTime * 4.1 + p.x);
             c = mix(base * 0.72, base * 1.08, rip * 0.6 + rip2 * 0.25);
             float sp = step(0.985, h(floor(vW.xz * 6.0) + floor(uTime * 3.0)));
             c += vec3(1.0) * sp * 0.6 * (1.0 - uNight * 0.5);
             a = 0.82;`}
        // daylight tint + night glow (stronger with magic)
        c *= mix(vec3(1.0), uSunColor, 0.12) * (1.0 - uNight * 0.72);
        float glow = clamp(uMagic - 1.0, 0.0, 2.0) * 0.5;
        c += base * glow * (0.25 + 0.75 * uNight) * 0.9;
        gl_FragColor = vec4(c, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function curtain(key: string, r0: number, y0: number, r1: number, y1: number): BufferGeometry {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push([r0 + (r1 - r0) * Math.pow(t, 0.6) + Math.sin(t * Math.PI) * 0.06, y0 + (y1 - y0) * t * t]);
  }
  return lathe(`curt${key}`, pts, 28);
}

function bowl(B: GeoBuilder, key: string, r: number, y: number, color: string, mat = 'glazed'): void {
  const prof: [number, number][] = [[0.001, -0.32], [r * 0.25, -0.3], [r * 0.7, -0.16], [r, 0.02], [r * 1.04, 0.1], [r * 0.95, 0.12], [r * 0.9, 0.05], [0.001, 0.02]];
  B.add(mat, lathe(`bowl${key}`, prof, 28), color, T(0, y, 0), { ao: false });
}

function column(B: GeoBuilder, key: string, h: number, color: string): void {
  const prof: [number, number][] = [[0.6, 0], [0.62, 0.12], [0.45, 0.2], [0.32, 0.35], [0.26, h * 0.5], [0.3, h * 0.85], [0.4, h * 0.95], [0.2, h], [0.001, h]];
  B.add('glazed', lathe(`col${key}`, prof, 20), color, T(0, 0, 0), { ao: false });
}

interface Stage {
  stone: Map<string, BufferGeometry>;
  flows: BufferGeometry[];
}

function buildStages(): Stage[] {
  const basinProf: [number, number][] = [[0.001, 0.12], [2.5, 0.12], [2.55, 0.68], [2.62, 0.8], [2.72, 0.86], [3.0, 0.86], [3.12, 0.78], [3.12, 0.62], [3.04, 0.56], [3.06, 0.18], [3.2, 0.1], [3.22, 0.0]];
  const stages: Stage[] = [];
  for (let s = 0; s <= FOUNTAIN_MAX_STAGE; s++) {
    const B = new GeoBuilder(31 + s);
    const flows: BufferGeometry[] = [];
    const stone = s === 0 ? '#aaa395' : s === 1 ? '#c9bfae' : s === 2 ? '#d7cfbf' : '#f0ebe2';
    B.add('glazed', lathe('basin', basinProf, 40), stone, T(), { ao: false, grad: s === 0 ? 0.25 : 0.12 });
    // basin floor tint (darker under water)
    B.add('solid', cyl(2.5, 2.5, 0.02, 32), s >= 2 ? '#3f8f95' : '#6f8a86', T(0, 0.14, 0), { ao: false });
    if (s === 0) {
      // weathered: moss tufts on the rim, a crack, a lonely trickle
      for (let k = 0; k < 7; k++) {
        const a = k * 0.97;
        B.add('plant', sphere(0.16 + (k % 3) * 0.05, 8, 6), '#6f8a4c', T(Math.cos(a) * 2.86, 0.8, Math.sin(a) * 2.86, 0, 0, 0, 1.4, 0.45, 1));
      }
      column(B, '0', 1.55, '#a39c8e');
      bowl(B, '0', 0.95, 1.5, '#a39c8e');
      B.add('glazed', sphere(0.16, 10, 8), '#a39c8e', T(0, 1.7, 0), { ao: false });
      flows.push(curtain('0', 0.92, 1.55, 1.05, WATER_Y - 1.55 - 0.02));
      // a few fallen leaves floating
      for (let k = 0; k < 6; k++) B.add('solid', sphere(0.08, 6, 4), k % 2 ? '#b0703d' : '#c9a23f', T(Math.cos(k * 2.1) * 1.9, WATER_Y + 0.02, Math.sin(k * 2.1) * 1.9, k, 0, 0, 1, 0.15, 1.5), { ao: false });
    }
    if (s >= 1) {
      const colH = s === 1 ? 2.05 : 2.6;
      column(B, `${s}`, colH, stone);
      bowl(B, `1a${s}`, s >= 2 ? 1.3 : 1.15, 1.05, stone);
      bowl(B, `1b${s}`, s >= 2 ? 0.88 : 0.62, s >= 2 ? 1.85 : 1.95, stone);
      flows.push(curtain(`a${s}`, s >= 2 ? 1.3 : 1.15, 1.12, s >= 2 ? 1.5 : 1.35, WATER_Y - 1.12 - 0.02));
      flows.push(curtain(`b${s}`, s >= 2 ? 0.88 : 0.62, s >= 2 ? 1.92 : 2.02, s >= 2 ? 1.0 : 0.72, (s >= 2 ? 1.05 : 1.05) - (s >= 2 ? 1.92 : 2.02) + 0.06));
      // finial spout
      B.add('glazed', sphere(0.18, 12, 9), stone, T(0, colH + 0.1, 0), { ao: false });
      // arcing jets from the rim
      const jets = s === 1 ? 4 : 8;
      for (let k = 0; k < jets; k++) {
        const a = (k / jets) * Math.PI * 2 + 0.3;
        const p0 = new Vector3(Math.cos(a) * 2.7, 0.85, Math.sin(a) * 2.7);
        const p2 = new Vector3(Math.cos(a) * 1.2, 1.15, Math.sin(a) * 1.2);
        const p1 = new Vector3(Math.cos(a) * 2.1, s >= 2 ? 2.6 : 2.1, Math.sin(a) * 2.1);
        const g = new TubeGeometry(new QuadraticBezierCurve3(p0, p1, p2), 16, s >= 2 ? 0.05 : 0.04, 6, false);
        flows.push(g);
        // little spout heads (fish at stage 2+)
        if (s >= 2) {
          B.add('glazed', sphere(0.17, 10, 8), s === 3 ? '#d9b25f' : '#5f8f8a', T(p0.x, 0.86, p0.z, -a + Math.PI / 2, 0, 0, 1, 0.8, 1.5), { ao: false });
          B.add('glazed', torus(0.08, 0.04, 5, 8), s === 3 ? '#d9b25f' : '#5f8f8a', T(p0.x * 1.04, 0.9, p0.z * 1.04, -a, 0, 0), { ao: false });
        } else {
          B.add('glazed', cyl(0.07, 0.1, 0.12, 8), '#8f8676', T(p0.x, 0.83, p0.z), { ao: false });
        }
      }
      // lily pads
      for (let k = 0; k < (s === 1 ? 5 : 8); k++) {
        const a = k * 1.31 + 0.4;
        const r = 1.7 + (k % 3) * 0.25;
        B.add('plant', cyl(0.24, 0.24, 0.02, 12), '#6f9a52', T(Math.cos(a) * r, WATER_Y + 0.02, Math.sin(a) * r), { ao: false });
        if (k % 2 === 0) B.add('solid', sphere(0.08, 8, 6), s >= 2 ? '#f4efe6' : '#e7a0a6', T(Math.cos(a) * r, WATER_Y + 0.08, Math.sin(a) * r, 0, 0, 0, 1, 0.7, 1), { ao: false });
      }
    }
    if (s >= 2) {
      bowl(B, `2c${s}`, 0.46, 2.55, stone);
      flows.push(curtain(`c${s}`, 0.46, 2.62, 0.55, 1.85 - 2.62 + 0.06));
      // mosaic band on the basin's outer wall
      const n = 48;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const col = s === 3 ? (k % 2 ? '#d9b25f' : '#f4efe6') : ['#4f8f8a', '#d9b25f', '#e9e4d8', '#3f6f8a'][k % 4]!;
        B.add('glazed', rbox(0.34, 0.2, 0.05, 0.02), col, T(Math.cos(a) * 3.09, 0.42, Math.sin(a) * 3.09, -a + Math.PI / 2, 0, 0), { ao: false });
      }
      // flower crown on the rim
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + 0.1;
        B.add('plant', sphere(0.17, 8, 6), '#6f9a52', T(Math.cos(a) * 2.86, 0.86, Math.sin(a) * 2.86, 0, 0, 0, 1, 0.6, 1), { ao: false });
        B.add('solid', sphere(0.07, 6, 5), P.petals[k % P.petals.length]!, T(Math.cos(a) * 2.86, 0.98, Math.sin(a) * 2.86), { ao: false });
      }
    }
    if (s === 3) {
      // gold trims
      for (const [r, y] of [[3.02, 0.8], [1.33, 1.1], [0.9, 1.9], [0.48, 2.6]] as const) B.add('glazed', torus(r, 0.05, 6, 40), '#d9b25f', T(0, y, 0, 0, Math.PI / 2), { ao: false });
      // crown of petals at the top holding the orb
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        B.add('glazed', sphere(0.2, 10, 8), '#d9b25f', T(Math.cos(a) * 0.3, 2.85, Math.sin(a) * 0.3, -a, 0, 0.7, 0.5, 1.4, 0.5), { ao: false });
      }
      // four guardian lanterns on pedestals around the basin (outside collider is still plaza; small)
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
        B.add('glazed', rbox(0.34, 0.5, 0.34, 0.08), '#f0ebe2', T(Math.cos(a) * 2.86, 1.05, Math.sin(a) * 2.86), { ao: false });
        B.add('glazed', sphere(0.14, 10, 8), '#d9b25f', T(Math.cos(a) * 2.86, 1.42, Math.sin(a) * 2.86), { ao: false });
      }
    }
    stages.push({ stone: B.build(), flows });
  }
  return stages;
}

function rainbowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uTime: uniforms.uTime, uNight: uniforms.uNight },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uNight; varying vec2 vUv;
      vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0); }
      void main(){ vec3 c = hue(vUv.y * 0.85); float a = 0.16 * sin(vUv.x * 3.14159) * (0.8 + 0.2 * sin(uTime + vUv.x * 6.0)); gl_FragColor = vec4(c * a * (1.0 - uNight * 0.4), 1.0); }`,
  });
}

function beamMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uTime: uniforms.uTime, uNight: uniforms.uNight },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uNight; varying vec2 vUv;
      void main(){ float a = pow(1.0 - vUv.y, 1.6) * (0.55 + 0.45 * sin(vUv.y * 30.0 - uTime * 3.0)) * (0.5 + 0.5 * sin(vUv.x * 6.2831 * 3.0 + uTime));
        vec3 c = mix(vec3(1.0, 0.85, 0.5), vec3(0.6, 0.95, 1.0), vUv.y);
        gl_FragColor = vec4(c * a * (0.35 + 0.65 * uNight), 1.0); }`,
  });
}

export function Fountain({ density }: { density: number }) {
  const root = useRef<Group>(null);
  const stageGroups = useRef<Group[]>([]);
  const magicGroup = useRef<Group>(null);
  const orb = useRef<Mesh>(null);
  const ribbons = useRef<Group>(null);
  const crystals = useRef<InstancedMesh>(null);
  const light = useRef<PointLight>(null);
  const cur = useRef({ shown: -1, swell: 1, burst: 0 });
  const magic = useMemo(() => ({ value: 0 }), []);
  const built = useMemo(() => {
    const stages = buildStages();
    const flow = waterMaterial('flow', magic);
    const pool = waterMaterial('pool', magic);
    // stage 3 extras
    const ribbonGeos = [0, 1, 2].map((k) => {
      const pts: Vector3[] = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const a = t * Math.PI * 4 + (k * Math.PI * 2) / 3;
        const r = 1.6 - t * 1.1;
        pts.push(new Vector3(Math.cos(a) * r, 0.9 + t * 3.0, Math.sin(a) * r));
      }
      return new TubeGeometry(new CatmullRomCurve3(pts), 80, 0.06, 6, false);
    });
    const cb = new GeoBuilder(2);
    cb.add('c', ico(0.22, 0), '#ffffff', T(), { ao: false, jitter: 0 });
    const crystalMesh = new InstancedMesh(cb.build().get('c')!, glazedMaterial, 6);
    for (let i = 0; i < 6; i++) crystalMesh.setColorAt(i, new Color(i % 2 ? '#9fe6f2' : '#f3d98a'));
    const sparkles = makeBillboards(Math.max(12, Math.round(70 * density)), 'star', true, false);
    const seeds = Array.from({ length: sparkles.count }, (_, i) => ({ a: i * 2.399, r: 0.3 + (i % 7) * 0.35, sp: 0.4 + (i % 5) * 0.15, off: (i * 0.137) % 1 }));
    return { stages, flow, pool, ribbonGeos, crystalMesh, sparkles, seeds, rainbow: rainbowMaterial(), beam: beamMaterial() };
  }, [magic, density]);

  const _m = useMemo(() => new Matrix4(), []);
  const _c = useMemo(() => new Color(), []);

  useFrame((_, dt) => {
    const stage = fountainStage();
    const c = cur.current;
    if (stage !== c.shown) {
      if (c.shown >= 0) c.burst = 1;
      c.shown = stage;
      c.swell = c.burst > 0 ? 0.6 : 1;
    }
    c.swell += (1 - c.swell) * (1 - Math.exp(-dt * 3));
    c.burst = Math.max(0, c.burst - dt * 0.35);
    magic.value += (stage - magic.value) * (1 - Math.exp(-dt * 2));
    stageGroups.current.forEach((g, i) => {
      if (!g) return;
      g.visible = i === stage;
      if (i === stage) g.scale.setScalar(c.swell);
    });
    const t = env.time;
    if (magicGroup.current) magicGroup.current.visible = stage >= FOUNTAIN_MAX_STAGE;
    if (stage >= FOUNTAIN_MAX_STAGE) {
      if (orb.current) {
        orb.current.position.y = 3.55 + Math.sin(t * 1.3) * 0.12;
        orb.current.rotation.y = t * 0.5;
      }
      if (ribbons.current) ribbons.current.rotation.y = t * 0.6;
      const cm = crystals.current;
      if (cm) {
        for (let i = 0; i < 6; i++) {
          const a = t * 0.45 + (i / 6) * Math.PI * 2;
          _m.makeRotationY(t + i).setPosition(Math.cos(a) * 2.2, 2.9 + Math.sin(t * 1.4 + i) * 0.25, Math.sin(a) * 2.2);
          cm.setMatrixAt(i, _m);
        }
        cm.instanceMatrix.needsUpdate = true;
      }
    }
    // sparkles: rising motes (stage ≥ 2), or a burst after a stage change
    const sp = built.sparkles;
    const active = stage >= 2 ? (stage >= 3 ? 1 : 0.45) : 0;
    built.seeds.forEach((s, i) => {
      const life = (t * s.sp * 0.25 + s.off) % 1;
      const a = s.a + t * 0.3;
      const r = s.r * (stage >= 3 ? 1 : 0.8) + c.burst * 2.5 * life;
      const y = 0.8 + life * (stage >= 3 ? 5.5 : 3.2) + c.burst * 1.5;
      const size = (0.12 + 0.1 * Math.sin(t * 3 + i)) * (1 - life * 0.5);
      _m.makeScale(size, size, size).setPosition(Math.cos(a) * r, y, Math.sin(a) * r);
      sp.setMatrixAt(i, _m);
      const k = Math.max(active, c.burst) * Math.sin(life * Math.PI);
      _c.set(i % 3 ? '#a8f0ff' : '#ffe1a0').multiplyScalar(k * (0.6 + 0.6 * env.night));
      sp.setColorAt(i, _c);
    });
    sp.instanceMatrix.needsUpdate = true;
    if (sp.instanceColor) sp.instanceColor.needsUpdate = true;
    if (light.current) {
      const want = stage >= 3 ? 1 : stage >= 2 ? 0.45 : 0;
      light.current.intensity = want * (6 + 10 * env.night) * (0.9 + 0.1 * Math.sin(t * 2.1));
    }
  });

  return (
    <group ref={root} name="fountain" position={[FOUNTAIN.position.x, G, FOUNTAIN.position.z]}>
      {built.stages.map((s, i) => (
        <group key={i} ref={(g) => void (g && (stageGroups.current[i] = g))} visible={false}>
          {[...s.stone].map(([bucket, geo]) => (
            <mesh key={bucket} geometry={geo} material={bucket === 'plant' ? staticPlantMaterial : bucket === 'glazed' ? glazedMaterial : solidMaterial} castShadow receiveShadow />
          ))}
          <mesh position={[0, WATER_Y, 0]} rotation-x={-Math.PI / 2} material={built.pool} renderOrder={3}>
            <circleGeometry args={[2.56, 40]} />
          </mesh>
          {s.flows.map((g, k) => (
            <mesh key={k} geometry={g} material={built.flow} renderOrder={4} />
          ))}
        </group>
      ))}
      <group ref={magicGroup} visible={false}>
        <mesh ref={orb} position={[0, 3.55, 0]}>
          <sphereGeometry args={[0.36, 24, 16]} />
          <meshBasicMaterial color={new Color('#fff1c4').multiplyScalar(1.8)} toneMapped={false} />
        </mesh>
        <mesh position={[0, 3.55, 0]} scale={1.6}>
          <icosahedronGeometry args={[0.36, 1]} />
          <meshBasicMaterial color="#9fe6f2" transparent opacity={0.25} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
        </mesh>
        <group ref={ribbons}>
          {built.ribbonGeos.map((g, k) => (
            <mesh key={k} geometry={g} material={built.flow} renderOrder={4} />
          ))}
        </group>
        <primitive object={built.crystalMesh} ref={crystals} />
        <mesh position={[0, 7.5, 0]} material={built.beam} renderOrder={6}>
          <cylinderGeometry args={[0.35, 1.2, 9, 24, 1, true]} />
        </mesh>
        <mesh position={[0, 0.9, 0]} rotation-y={0.6} material={built.rainbow} renderOrder={6}>
          <torusGeometry args={[3.0, 0.22, 6, 40, Math.PI]} />
        </mesh>
      </group>
      <primitive object={built.sparkles} />
      <pointLight ref={light} position={[0, 3.6, 0]} color="#bff3ff" intensity={0} distance={16} decay={1.3} />
    </group>
  );
}
void shade;
