/**
 * The Unknown: the arch crown over the two portal pillars, the portal itself
 * (dormant: a faint shimmer in old stone; awake: a swirling vortex, a light
 * pillar, levitating stones and drawn-in motes), and rune glyphs on the three
 * rune stones that light when touched (objects[rune_n].active).
 */
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, Color, DoubleSide, Group, InstancedMesh, Matrix4, Mesh, ShaderMaterial, Shape, ShapeGeometry, type PointLight } from 'three';
import { INTERACTABLES, PORTAL_ARCH, terrainHeight, type RuneInteractable } from '@elsewhere/shared';
import { makeBillboards } from './billboard.js';
import { GeoBuilder, ico, rbox, sphere, T, torus } from './geom.js';
import { env, uniforms } from './env.js';
import { barkMaterial, solidMaterial } from './materials.js';
import { portalAwake, runeLit } from './objectState.js';

const RUNES = INTERACTABLES.filter((i): i is RuneInteractable => i.kind === 'rune');
const ARCH_G = terrainHeight(PORTAL_ARCH.position.x, PORTAL_ARCH.position.z);

function portalMaterial(awake: { value: number }): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: { uTime: uniforms.uTime, uAwake: awake, uNight: uniforms.uNight },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uAwake; uniform float uNight; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
      void main(){
        vec2 p = (vUv - vec2(0.5, 0.42)) * vec2(1.0, 1.25);
        float r = length(p);
        float a = atan(p.y, p.x);
        float swirl = a + r * 6.0 - uTime * (0.6 + 2.4 * uAwake);
        float bands = n(vec2(swirl * 1.6, r * 5.0 - uTime * 0.8)) * 0.7 + n(vec2(swirl * 4.0, r * 12.0)) * 0.3;
        float edge = smoothstep(0.62, 0.25, r);
        vec3 deep = vec3(0.12, 0.05, 0.3);
        vec3 teal = vec3(0.25, 0.95, 0.85);
        vec3 violet = vec3(0.62, 0.38, 1.0);
        vec3 c = mix(deep, mix(violet, teal, bands), smoothstep(0.25, 0.8, bands));
        c += vec3(1.0, 0.95, 0.85) * smoothstep(0.12, 0.0, r) * (0.6 + 0.4 * sin(uTime * 3.0));
        float rim = smoothstep(0.05, 0.0, abs(r - 0.5 - 0.02 * sin(a * 7.0 + uTime * 2.0)));
        c += teal * rim * 1.2;
        float dormant = (0.06 + 0.05 * sin(uTime * 0.7 + a * 3.0)) * smoothstep(0.62, 0.3, r) * bands;
        float alpha = mix(dormant, edge * (0.9 + 0.3 * bands) + rim * 1.3, uAwake);
        gl_FragColor = vec4(c * alpha * (1.0 + uNight * 0.3), 1.0);
      }`,
  });
}

function glyphMaterial(lit: { value: number }, index: number): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: uniforms.uTime, uLit: lit, uIndex: { value: index }, uNight: uniforms.uNight },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uLit; uniform float uIndex; uniform float uNight; varying vec2 vUv;
      float seg(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float t=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*t); }
      void main(){
        vec2 p = vUv;
        float d = 1.0;
        d = min(d, seg(p, vec2(0.5, 0.12), vec2(0.5, 0.88)));
        if (uIndex < 0.5) { d = min(d, seg(p, vec2(0.5,0.7), vec2(0.78,0.86))); d = min(d, seg(p, vec2(0.5,0.48), vec2(0.78,0.64))); }
        else if (uIndex < 1.5) { d = min(d, seg(p, vec2(0.5,0.88), vec2(0.8,0.5))); d = min(d, seg(p, vec2(0.8,0.5), vec2(0.5,0.12))); d = min(d, seg(p, vec2(0.22,0.5), vec2(0.5,0.88))); }
        else { d = min(d, seg(p, vec2(0.22,0.78), vec2(0.78,0.22))); d = min(d, seg(p, vec2(0.22,0.22), vec2(0.78,0.78))); }
        float line = smoothstep(0.06, 0.02, d);
        float halo = smoothstep(0.25, 0.0, d) * 0.5;
        vec3 c = vec3(0.35, 1.0, 0.85);
        float dim = 0.1 + 0.05 * uNight;
        float a = mix(dim * line, (line * 1.4 + halo) * (0.8 + 0.2 * sin(uTime * 3.0 + uIndex)), uLit);
        gl_FragColor = vec4(c * a, 1.0);
      }`,
  });
}

function beamMaterial(level: { value: number }, color: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uTime: uniforms.uTime, uLevel: level, uColor: { value: new Color(color) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform float uTime; uniform float uLevel; uniform vec3 uColor; varying vec2 vUv;
      void main(){ float a = pow(1.0 - vUv.y, 1.4) * (0.6 + 0.4 * sin(vUv.y * 24.0 - uTime * 4.0)); gl_FragColor = vec4(uColor * a * uLevel * 0.8, 1.0); }`,
  });
}

export function Unknown({ density }: { density: number }) {
  const awake = useMemo(() => ({ value: 0 }), []);
  const runeLevels = useMemo(() => RUNES.map(() => ({ value: 0 })), []);
  const floating = useRef<InstancedMesh>(null);
  const portalMesh = useRef<Mesh>(null);
  const light = useRef<PointLight>(null);
  const awakeGroup = useRef<Group>(null);
  const built = useMemo(() => {
    // Arch crown: a half ring of voussoir blocks + keystone, on the pillar tops.
    const B = new GeoBuilder(71);
    const r = PORTAL_ARCH.span / 2;
    const baseY = PORTAL_ARCH.height - 0.2;
    const n = 9;
    for (let k = 0; k < n; k++) {
      const a = Math.PI - (k + 0.5) * (Math.PI / n);
      const x = Math.cos(a) * r;
      const y = baseY + Math.sin(a) * r * 0.9;
      B.add('s', rbox(0.95, 0.7, 1.0, 0.14), k === 4 ? '#b5afa0' : k % 2 ? '#a39e91' : '#9a958a', T(x, y, 0, 0, 0, a - Math.PI / 2, k === 4 ? 1.15 : 1), { ao: false, grad: 0.15 });
    }
    B.add('s', rbox(0.6, 0.9, 1.15, 0.12), '#c2bba9', T(0, baseY + r * 0.9 + 0.35, 0), { ao: false });
    // carved runes band on keystone
    B.add('s', torus(0.18, 0.04, 6, 14), '#6f8a86', T(0, baseY + r * 0.9 + 0.35, 0.58), { ao: false });
    // ivy / moss draping over the crown
    for (let k = 0; k < 6; k++) B.add('s', sphere(0.3, 8, 6), k % 2 ? '#6f8a4c' : '#7d9a55', T(-r + k * 0.65, baseY + Math.sin(Math.PI * (k / 5)) * r * 0.9 + 0.35, 0.3, 0, 0, 0, 1.1, 0.45, 1.3), { ao: false });
    // dais: stepped circular platform under the arch (decorative, flush with ground)
    for (let k = 0; k < 3; k++) B.add('s', rbox(4.6 - k * 1.0, 0.1, 2.4 - k * 0.5, 0.05), k % 2 ? '#a8a597' : '#9a958a', T(0, 0.02 + k * 0.05, 0), { ao: false });
    const crown = B.build().get('s')!;

    // Portal surface: an arched panel inside the pillars.
    const w = PORTAL_ARCH.span - PORTAL_ARCH.pillarRadius * 2 - 0.1;
    const s = new Shape();
    const top = baseY + 0.1;
    s.moveTo(-w / 2, 0.3);
    s.lineTo(w / 2, 0.3);
    s.lineTo(w / 2, top);
    s.absarc(0, top, w / 2, 0, Math.PI, false);
    s.lineTo(-w / 2, 0.3);
    const portalGeo = new ShapeGeometry(s, 24);
    // normalize UVs to 0..1
    portalGeo.computeBoundingBox();
    const bb = portalGeo.boundingBox!;
    const uv = portalGeo.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - bb.min.x) / (bb.max.x - bb.min.x), (uv.getY(i) - bb.min.y) / (bb.max.y - bb.min.y));

    const rockB = new GeoBuilder(3);
    rockB.add('r', ico(0.32, 1), '#9a958a', T(0, 0, 0, 0, 0, 0, 1, 0.7, 1), { ao: false });
    const rocks = new InstancedMesh(rockB.build().get('r')!, barkMaterial, 7);
    const motes = makeBillboards(Math.max(16, Math.round(80 * density)), 'glow', true, false);
    return { crown, portalGeo, rocks, motes, portalMat: portalMaterial(awake), glyphMats: RUNES.map((rn, i) => glyphMaterial(runeLevels[i]!, rn.index)), beamMats: runeLevels.map((l) => beamMaterial(l, '#7ff5d8')), pillarBeam: beamMaterial(awake, '#b89cff') };
  }, [awake, runeLevels, density]);

  const _m = useMemo(() => new Matrix4(), []);
  const _c = useMemo(() => new Color(), []);

  useFrame((_, dt) => {
    const k = 1 - Math.exp(-dt * 2.2);
    awake.value += ((portalAwake() ? 1 : 0) - awake.value) * k;
    RUNES.forEach((rn, i) => {
      const l = runeLevels[i]!;
      l.value += ((runeLit(rn.id) ? 1 : 0) - l.value) * k;
    });
    const a = awake.value;
    const t = env.time;
    if (awakeGroup.current) awakeGroup.current.visible = a > 0.01;
    const rocks = floating.current;
    if (rocks) {
      for (let i = 0; i < 7; i++) {
        const ang = t * 0.3 + (i / 7) * Math.PI * 2;
        const rad = 2.6 + Math.sin(i * 1.7) * 0.5;
        const y = 0.3 + a * (2.2 + Math.sin(t * 0.9 + i) * 0.5 + (i % 3) * 0.6);
        const s = 0.6 + (i % 3) * 0.3;
        _m.makeRotationY(t * 0.4 + i).scale({ x: s, y: s, z: s } as never).setPosition(Math.cos(ang) * rad * (0.4 + 0.6 * a) + 0, y, Math.sin(ang) * rad * 0.7);
        rocks.setMatrixAt(i, _m);
      }
      rocks.instanceMatrix.needsUpdate = true;
    }
    const motes = built.motes;
    for (let i = 0; i < motes.count; i++) {
      const life = (t * 0.22 + i * 0.6180339) % 1;
      const ang = i * 2.399 + t * 0.5;
      const rad = (1 - life) * 4.5;
      _m.makeScale(0.16, 0.16, 0.16).setPosition(Math.cos(ang) * rad, 0.6 + (1 - life) * 2.5 + life * 1.8, Math.sin(ang) * rad * 0.6);
      motes.setMatrixAt(i, _m);
      _c.set(i % 2 ? '#8ff7e2' : '#c4a8ff').multiplyScalar(a * Math.sin(life * Math.PI) * 1.2);
      motes.setColorAt(i, _c);
    }
    motes.instanceMatrix.needsUpdate = true;
    if (motes.instanceColor) motes.instanceColor.needsUpdate = true;
    if (light.current) light.current.intensity = a * (8 + 10 * env.night) * (0.9 + 0.1 * Math.sin(t * 3));
    if (portalMesh.current) portalMesh.current.scale.setScalar(0.96 + 0.04 * Math.sin(t * 1.5) * a);
  });

  return (
    <group name="the-unknown">
      <group position={[PORTAL_ARCH.position.x, ARCH_G, PORTAL_ARCH.position.z]} rotation-y={PORTAL_ARCH.yaw}>
        <mesh geometry={built.crown} material={solidMaterial} castShadow receiveShadow />
        <mesh ref={portalMesh} geometry={built.portalGeo} material={built.portalMat} renderOrder={6} />
        <group ref={awakeGroup} visible={false}>
          <primitive object={built.rocks} ref={floating} />
          <primitive object={built.motes} />
          <mesh position={[0, 9, 0]} material={built.pillarBeam} renderOrder={7}>
            <cylinderGeometry args={[0.9, 1.6, 14, 24, 1, true]} />
          </mesh>
        </group>
        <pointLight ref={light} position={[0, 2.4, 0.8]} color="#9b8cff" intensity={0} distance={18} decay={1.3} />
      </group>
      {RUNES.map((rn, i) => {
        const g = terrainHeight(rn.position.x, rn.position.z);
        return (
          <group key={rn.id} position={[rn.position.x, g, rn.position.z]} rotation-y={rn.yaw}>
            <mesh position={[0, 0.8, 0.235]} rotation-x={-0.06} material={built.glyphMats[i]} renderOrder={6}>
              <planeGeometry args={[0.42, 0.54]} />
            </mesh>
            <mesh position={[0, 3.6, 0]} material={built.beamMats[i]} renderOrder={7}>
              <cylinderGeometry args={[0.18, 0.4, 5, 16, 1, true]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
