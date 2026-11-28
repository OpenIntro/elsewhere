/**
 * Camera-facing instanced quads for glows, sparkles, fireflies and smoke.
 * Instance matrix: translation = centre, scale (column length) = size.
 * instanceColor = rgb; optional per-instance `aAlpha`.
 */
import { AdditiveBlending, Color, InstancedBufferAttribute, InstancedMesh, NormalBlending, PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils } from 'three';
import { uniforms } from './env.js';

export type BillboardShape = 'glow' | 'puff' | 'star' | 'ring';

export function billboardMaterial(shape: BillboardShape, additive: boolean, fog = true): ShaderMaterial {
  const m = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog,
    blending: additive ? AdditiveBlending : NormalBlending,
    uniforms: UniformsUtils.merge([UniformsLib.fog, {}]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute float aAlpha;
      varying vec3 vCol; varying vec2 vUv; varying float vA; varying float vSeed;
      void main(){
        vUv = uv;
        vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float s = length(instanceMatrix[0].xyz);
        vec4 mvPosition = viewMatrix * vec4(center, 1.0);
        mvPosition.xy += position.xy * s;
        gl_Position = projectionMatrix * mvPosition;
        #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
        #else
          vCol = vec3(1.0);
        #endif
        vA = aAlpha;
        vSeed = fract(center.x * 1.37 + center.z * 0.71);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      varying vec3 vCol; varying vec2 vUv; varying float vA; varying float vSeed;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float d = length(p);
        float a;
        ${shape === 'glow' ? 'a = pow(max(0.0, 1.0 - d), 2.2);' : ''}
        ${shape === 'puff' ? 'a = smoothstep(1.0, 0.25, d + 0.12 * sin(atan(p.y, p.x) * 5.0 + vSeed * 20.0)); a *= 0.85;' : ''}
        ${shape === 'star' ? 'float rays = max(0.0, 1.0 - abs(p.x) * 7.0) * max(0.0, 1.0 - abs(p.y)) + max(0.0, 1.0 - abs(p.y) * 7.0) * max(0.0, 1.0 - abs(p.x)); a = clamp(pow(max(0.0, 1.0 - d), 3.0) + rays * 0.8, 0.0, 1.0);' : ''}
        ${shape === 'ring' ? 'a = smoothstep(0.12, 0.0, abs(d - 0.75)) + pow(max(0.0, 1.0 - d), 3.0) * 0.4;' : ''}
        a *= vA;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  m.uniforms.uTime = uniforms.uTime;
  m.toneMapped = false;
  return m;
}

const quadGeo = new PlaneGeometry(1, 1);

/** InstancedMesh of billboards with an aAlpha attribute (filled with 1). */
export function makeBillboards(count: number, shape: BillboardShape, additive: boolean, fog = true): InstancedMesh {
  const g = quadGeo.clone();
  const alpha = new InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
  g.setAttribute('aAlpha', alpha);
  const mesh = new InstancedMesh(g, billboardMaterial(shape, additive, fog), count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  // ensure instanceColor exists
  const white = new Color(1, 1, 1);
  for (let i = 0; i < count; i++) mesh.setColorAt(i, white);
  return mesh;
}
