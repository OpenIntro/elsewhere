/**
 * Stylised sea around the island (and in the creek): depth-tinted from a
 * baked depth texture of the shared terrain, animated shoreline foam bands,
 * shallow caustics, sun/moon glints. The sea sits in a diorama tile with a
 * water cross-section wall and a wooden base so the whole world reads as a
 * handcrafted miniature when zoomed out.
 */
import { useMemo } from 'react';
import { Color, DataTexture, LinearFilter, MeshStandardMaterial, PlaneGeometry, RGBAFormat, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { WORLD_BOUNDS, terrainHeight, WATER_LEVEL } from '@elsewhere/shared';
import { NOISE_GLSL } from './materials.js';
import { env, uniforms } from './env.js';
import { rbox } from './geom.js';
import { patch } from './materials.js';

export const TILE = { minX: -104, maxX: 100, minZ: -112, maxZ: 92 } as const;
const TILE_W = TILE.maxX - TILE.minX;
const TILE_D = TILE.maxZ - TILE.minZ;
const BASE_DEPTH = 7;

function bakeDepth(size: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = TILE.minX + ((i + 0.5) / size) * TILE_W;
      const z = TILE.minZ + ((j + 0.5) / size) * TILE_D;
      const inside = x > WORLD_BOUNDS.minX && x < WORLD_BOUNDS.maxX && z > WORLD_BOUNDS.minZ && z < WORLD_BOUNDS.maxZ;
      const h = inside ? terrainHeight(x, z) : -6;
      const depth = Math.max(0, Math.min(1, (WATER_LEVEL - h) / 6));
      const k = (j * size + i) * 4;
      data[k] = Math.round(depth * 255);
      // G: land mask (above water) for foam.
      data[k + 1] = h > WATER_LEVEL ? 255 : 0;
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
uniform float uTime;
varying vec3 vWPos;
varying vec2 vTileUv;
uniform vec4 uTile;
void main(){
  vec3 p = position;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  wp.y += sin(wp.x * 0.35 + uTime * 1.1) * 0.025 + cos(wp.z * 0.29 + uTime * 0.9) * 0.025;
  vWPos = wp.xyz;
  vTileUv = (wp.xz - uTile.xy) / uTile.zw;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime; uniform float uNight; uniform float uDaylight; uniform float uSunIntensity;
uniform vec3 uKeyDir; uniform vec3 uSunColor; uniform vec3 uWaterShallow; uniform vec3 uWaterDeep; uniform vec3 uBgTop;
uniform sampler2D uDepth; uniform float uDetail;
varying vec3 vWPos; varying vec2 vTileUv;
${NOISE_GLSL}
float caustic(vec2 p){
  vec2 n = floor(p); vec2 f = fract(p); float m = 8.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = vec2(wHash(n+g), wHash(n+g+5.3));
    o = 0.5 + 0.45 * sin(uTime * 0.8 + 6.2831 * o);
    m = min(m, length(g + o - f));
  }
  return m;
}
void main(){
  vec4 dt = texture2D(uDepth, vTileUv);
  float depth = dt.r;
  float du = depth * 6.0;
  vec2 p = vWPos.xz;
  // base colour by depth
  vec3 shallow = uWaterShallow * 1.18 + vec3(0.03, 0.05, 0.03);
  vec3 col = mix(shallow, uWaterDeep, smoothstep(0.0, 0.5, depth));
  col = mix(col, uWaterDeep * 0.82, smoothstep(0.5, 1.0, depth));
  // painterly large-scale variation
  col *= 0.94 + 0.12 * wFbm(p * 0.05 + uTime * 0.01);
  // wave normal from two scrolling noise fields
  float e = 0.4;
  vec2 q1 = p * 0.42 + vec2(uTime * 0.12, uTime * 0.05);
  vec2 q2 = p * 0.77 - vec2(uTime * 0.07, -uTime * 0.11);
  float h0 = wNoise(q1) + 0.5 * wNoise(q2);
  float hx = wNoise(q1 + vec2(e, 0.0)) + 0.5 * wNoise(q2 + vec2(e, 0.0));
  float hz = wNoise(q1 + vec2(0.0, e)) + 0.5 * wNoise(q2 + vec2(0.0, e));
  vec3 N = normalize(vec3((h0 - hx) * 1.3, 1.0, (h0 - hz) * 1.3));
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 L = normalize(uKeyDir);
  // soft sky reflection
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col = mix(col, uBgTop * 1.05, clamp(fres * 0.5, 0.0, 0.35));
  // gentle diffuse wave shading
  col *= 0.95 + 0.1 * clamp(dot(N, L), 0.0, 1.0);
  // painterly wave streaks
  col *= 0.97 + 0.06 * smoothstep(0.55, 0.8, wNoise(vec2(p.x * 0.25 + p.y * 0.1, p.y * 0.9) + uTime * 0.04));
  // caustics in the shallows (day)
  if (uDetail > 0.5) {
    float c = 1.0 - smoothstep(0.0, 0.42, caustic(p * 0.9));
    col += vec3(0.9, 1.0, 0.95) * c * c * 0.16 * (1.0 - smoothstep(0.03, 0.22, depth)) * uDaylight;
  }
  // glints: sparkling cells near the reflection direction
  vec3 H = normalize(L + V);
  vec3 Ns = normalize(vec3(N.x * 0.35, 1.0, N.z * 0.35));
  float spec = pow(max(dot(Ns, H), 0.0), 320.0);
  // sparse twinkling glints on wave crests
  vec2 gp = p * 1.3;
  vec2 cell = floor(gp);
  float seed = wHash(cell);
  float phase = fract(uTime * (0.25 + seed * 0.3) + seed * 7.0);
  vec2 cpos = vec2(wHash(cell + 3.7), wHash(cell + 9.1)) * 0.8 + 0.1;
  float dd = length(fract(gp) - cpos);
  float tw = step(0.93, seed) * smoothstep(0.09, 0.0, dd) * sin(phase * 3.14159);
  float crest = 1.0;
  vec3 glintCol = mix(uSunColor, vec3(0.75, 0.82, 1.0), uNight);
  float glintAmt = (uSunIntensity * 0.25 + uNight * 0.35);
  col += glintCol * (spec * 0.5 + tw * crest * 0.9) * glintAmt * (0.4 + 0.6 * smoothstep(0.05, 0.4, depth));
  // soft broad sheen towards the light
  col += glintCol * pow(max(dot(Ns, H), 0.0), 18.0) * 0.06 * glintAmt;
  // shoreline foam: a crisp lip plus waves travelling in towards the beach
  float nf = wNoise(p * 1.3 + uTime * 0.2);
  float lip = 1.0 - smoothstep(0.012, 0.03 + nf * 0.02, depth);
  float waves = smoothstep(0.72, 0.95, sin(du * 9.0 - uTime * 1.7 + nf * 3.0)) * (1.0 - smoothstep(0.02, 0.13, depth));
  waves *= smoothstep(0.25, 0.6, wNoise(p * 0.45 + vec2(uTime * 0.05, 0.0)));
  float foam = clamp(max(lip, waves * 0.75), 0.0, 1.0);
  vec3 foamCol = mix(vec3(1.0, 0.98, 0.93), vec3(0.62, 0.68, 0.85), uNight) * mix(vec3(1.0), uSunColor, 0.15);
  col = mix(col, foamCol, foam * 0.92);
  float alpha = mix(0.5, 0.96, smoothstep(0.0, 0.3, depth));
  alpha = max(alpha, foam);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function Water({ detail = true }: { detail?: boolean }) {
  const { material, geometry, wallMaterial, baseMaterial, seabedMaterial } = useMemo(() => {
    const depthTex = bakeDepth(512);
    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      fog: true,
      depthWrite: false,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uDepth: { value: null }, uTile: { value: null }, uDetail: { value: 1 } },
      ]),
    });
    Object.assign(material.uniforms, {
      uTime: uniforms.uTime,
      uNight: uniforms.uNight,
      uDaylight: uniforms.uDaylight,
      uSunIntensity: uniforms.uSunIntensity,
      uKeyDir: uniforms.uKeyDir,
      uSunColor: uniforms.uSunColor,
      uWaterShallow: uniforms.uWaterShallow,
      uWaterDeep: uniforms.uWaterDeep,
      uBgTop: uniforms.uBgTop,
    });
    material.uniforms.uDepth!.value = depthTex;
    material.uniforms.uTile!.value = [TILE.minX, TILE.minZ, TILE_W, TILE_D];
    const geometry = new PlaneGeometry(TILE_W, TILE_D, 160, 160);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(TILE.minX + TILE_W / 2, WATER_LEVEL, TILE.minZ + TILE_D / 2);

    // Water cross-section wall: gradient by depth.
    const wallMaterial = new ShaderMaterial({
      uniforms: { uWaterShallow: uniforms.uWaterShallow, uWaterDeep: uniforms.uWaterDeep, uTime: uniforms.uTime },
      vertexShader: `varying vec3 vP; void main(){ vP = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vP,1.0); }`,
      fragmentShader: `uniform vec3 uWaterShallow; uniform vec3 uWaterDeep; uniform float uTime; varying vec3 vP;
        void main(){ float t = clamp(-vP.y / ${BASE_DEPTH.toFixed(1)}, 0.0, 1.0);
          vec3 c = mix(uWaterShallow * 1.05, uWaterDeep * 0.55, pow(t, 0.7));
          float rays = 0.5 + 0.5 * sin((vP.x + vP.z) * 0.35 + sin(uTime*0.3)*0.8);
          c += vec3(0.05,0.07,0.07) * rays * (1.0 - t);
          if (vP.y > -0.35) c = mix(c, vec3(0.95,0.97,0.95), 0.55);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const baseMaterial = patch(new MeshStandardMaterial({ color: '#6e5444', roughness: 0.8 }), { paint: 1.4, rim: 0.2 });
    const seabedMaterial = new MeshStandardMaterial({ color: new Color('#4f7477'), roughness: 1 });
    return { material, geometry, wallMaterial, baseMaterial, seabedMaterial };
  }, []);
  material.uniforms.uDetail!.value = detail ? 1 : 0;
  void env;

  const cx = TILE.minX + TILE_W / 2;
  const cz = TILE.minZ + TILE_D / 2;
  return (
    <group name="water">
      <mesh geometry={geometry} material={material} renderOrder={2} />
      {/* Seabed beyond the terrain mesh. */}
      <mesh position={[cx, -6.05, cz]} rotation-x={-Math.PI / 2} material={seabedMaterial}>
        <planeGeometry args={[TILE_W, TILE_D]} />
      </mesh>
      {/* Diorama: water cross-section walls (outward-facing). */}
      <mesh position={[cx, -BASE_DEPTH / 2, TILE.maxZ]} material={wallMaterial}>
        <planeGeometry args={[TILE_W, BASE_DEPTH]} />
      </mesh>
      <mesh position={[TILE.maxX, -BASE_DEPTH / 2, cz]} rotation-y={Math.PI / 2} material={wallMaterial}>
        <planeGeometry args={[TILE_D, BASE_DEPTH]} />
      </mesh>
      <mesh position={[cx, -BASE_DEPTH / 2, TILE.minZ]} rotation-y={Math.PI} material={wallMaterial}>
        <planeGeometry args={[TILE_W, BASE_DEPTH]} />
      </mesh>
      <mesh position={[TILE.minX, -BASE_DEPTH / 2, cz]} rotation-y={-Math.PI / 2} material={wallMaterial}>
        <planeGeometry args={[TILE_D, BASE_DEPTH]} />
      </mesh>
      <mesh position={[cx, -BASE_DEPTH - 0.8, cz]} geometry={rbox(TILE_W + 2.4, 1.8, TILE_D + 2.4, 0.6, 3)} material={baseMaterial} castShadow={false} receiveShadow />
      <mesh position={[cx, -BASE_DEPTH - 0.02, cz]} geometry={rbox(TILE_W + 0.9, 0.3, TILE_D + 0.9, 0.12, 2)} material={baseMaterial} />
    </group>
  );
}
