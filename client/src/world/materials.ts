/**
 * Shared materials. One matte "clay" material for all vertex-coloured static
 * geometry, foliage with wind sway, glowing window glass, lamp emissives.
 * All patches read the shared `uniforms` from env.ts.
 */
import { AdditiveBlending, CanvasTexture, Color, DoubleSide, MeshBasicMaterial, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, type Material, type WebGLProgramParametersWithUniforms } from 'three';
import { CUT_VEC4S, cutUniform, occluderDirUniform, occluderUniform } from './cutawayRuntime.js';
import { uniforms } from './env.js';

type Shader = WebGLProgramParametersWithUniforms;

export const NOISE_GLSL = /* glsl */ `
float wHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float wNoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(wHash(i), wHash(i+vec2(1,0)), u.x), mix(wHash(i+vec2(0,1)), wHash(i+vec2(1,1)), u.x), u.y); }
float wFbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<3;i++){ v+=a*wNoise(p); p*=2.03; a*=0.5; } return v; }
`;

interface PatchOpts {
  /** Hand-painted brightness mottling (world-space). */
  paint?: number;
  /** Wind sway: amplitude per unit height^2 (object/instance local Y). */
  wind?: number;
  /** Soft rim light for a clay/sculpted feel. */
  rim?: number;
  /** Extra fragment code run after lighting (has vWPos, uniforms). */
  extraFrag?: string;
  extraFragHeader?: string;
  /** Dollhouse cutaway: parts tagged with a `cut` slot dissolve (dithered) as that slot fades. */
  cut?: boolean;
  /** Instanced foliage: instances standing between the camera and an open building dissolve. */
  occlude?: boolean;
}

/** Vertex side of the cutaway: look up this vertex's slot fade (constant per part). */
export const CUT_VERT_HEADER = /* glsl */ `
attribute float cut;
uniform vec4 uCut[${CUT_VEC4S}];
varying float vCutFade;`;
export const CUT_VERT = /* glsl */ `{
  int ci = int(cut + 0.5) - 1;
  vCutFade = 0.0;
  if (ci >= 0) {
    vec4 q = uCut[ci / 4];
    int m = ci - (ci / 4) * 4;
    vCutFade = m == 0 ? q.x : m == 1 ? q.y : m == 2 ? q.z : q.w;
  }
}`;
/** Fragment side: interleaved-gradient-noise dissolve (no sorting, no z-fighting, smooth over ~0.4 s). */
export const CUT_FRAG_HEADER = /* glsl */ `varying float vCutFade;`;
export const CUT_FRAG = /* glsl */ `if (vCutFade > 0.002) {
  float cutN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (cutN < vCutFade) discard;
}`;

export function patch(mat: MeshStandardMaterial, opts: PatchOpts): MeshStandardMaterial {
  const key = JSON.stringify(opts);
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader: Shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.uniforms.uNight = uniforms.uNight;
    shader.uniforms.uGlow = uniforms.uGlow;
    shader.uniforms.uKeyDir = uniforms.uKeyDir;
    shader.uniforms.uSunColor = uniforms.uSunColor;
    if (opts.occlude) {
      shader.uniforms.uOcc = occluderUniform;
      shader.uniforms.uOccDir = occluderDirUniform;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
uniform vec4 uOcc; uniform vec2 uOccDir; varying float vCutFade;`).replace('#include <begin_vertex>', `#include <begin_vertex>
vCutFade = 0.0;
#ifdef USE_INSTANCING
if (uOcc.w > 0.001) {
  vec2 rel = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xz - vec2(uOcc.x, uOcc.z);
  float along = dot(rel, uOccDir);
  float side = abs(dot(rel, vec2(-uOccDir.y, uOccDir.x)));
  // whole trees go (no half-dissolved stipple at the zone edge)
  float inZone = step(-uOcc.y * 0.2, along) * step(along, uOcc.y + 11.0) * step(side, uOcc.y * 0.85 + 1.2);
  vCutFade = uOcc.w * inZone;
}
#endif`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${CUT_FRAG_HEADER}`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_FRAG}`);
    }
    if (opts.cut) {
      shader.uniforms.uCut = cutUniform;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${CUT_VERT_HEADER}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUT_VERT}`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${CUT_FRAG_HEADER}`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_FRAG}`);
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform float uWind; varying vec3 vWPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
${opts.wind ? `{
  #ifdef USE_INSTANCING
    vec3 pivot = instanceMatrix[3].xyz;
  #else
    vec3 pivot = (modelMatrix * vec4(position, 1.0)).xyz;
  #endif
  float hgt = max(position.y, 0.0);
  float ph = uTime * 1.6 + pivot.x * 0.31 + pivot.z * 0.23;
  float gust = 0.6 + 0.4 * sin(uTime * 0.37 + pivot.x * 0.05);
  float k = ${opts.wind.toFixed(4)} * uWind * gust * hgt * hgt;
  transformed.x += sin(ph) * k + sin(ph * 2.7 + position.z * 3.0) * k * 0.25;
  transformed.z += cos(ph * 0.83) * k * 0.7;
}` : ''}`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
{
  vec4 wpp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wpp = instanceMatrix * wpp;
  #endif
  vWPos = (modelMatrix * wpp).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime; uniform float uNight; uniform float uGlow; uniform vec3 uKeyDir; uniform vec3 uSunColor; varying vec3 vWPos;
${NOISE_GLSL}
${opts.extraFragHeader ?? ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
${opts.paint ? `{
  float pn = wFbm(vWPos.xz * 1.7 + vWPos.y * 0.9) - 0.5;
  float pn2 = wNoise(vWPos.xz * 9.0 + vWPos.y * 7.0) - 0.5;
  diffuseColor.rgb *= 1.0 + (pn * 0.16 + pn2 * 0.05) * ${opts.paint.toFixed(3)};
}` : ''}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `${opts.rim ? `{
  vec3 vd = normalize(vViewPosition);
  float fr = pow(1.0 - clamp(dot(normalize(normal), -vd), 0.0, 1.0), 3.0);
  outgoingLight += diffuseColor.rgb * fr * ${opts.rim.toFixed(3)} * (0.35 + 0.65 * (1.0 - uNight));
}` : ''}
${opts.extraFrag ?? ''}
#include <opaque_fragment>`,
      );
  };
  return mat;
}

function standard(params: ConstructorParameters<typeof MeshStandardMaterial>[0], opts: PatchOpts): MeshStandardMaterial {
  return patch(new MeshStandardMaterial(params), opts);
}

/** Matte clay/painted-wood for all merged static geometry. */
export const solidMaterial = standard({ vertexColors: true, roughness: 0.84, metalness: 0 }, { paint: 1, rim: 0.22 });

/** Slightly glossier glazed variant (fountain stone, tiles). */
export const glazedMaterial = standard({ vertexColors: true, roughness: 0.55, metalness: 0 }, { paint: 0.6, rim: 0.25 });

/** Foliage: wind + paint. */
export const foliageMaterial = standard({ vertexColors: true, roughness: 0.9, metalness: 0 }, { paint: 1.2, wind: 0.006, rim: 0.35, occlude: true });
/** Low plants (stronger sway relative to height). */
export const plantMaterial = standard({ vertexColors: true, roughness: 0.92, metalness: 0, side: DoubleSide }, { paint: 0.8, wind: 0.09, rim: 0.06 });
/** Merged static plants (flower boxes, beds): world-space geometry, so no height-based sway. */
export const staticPlantMaterial = standard({ vertexColors: true, roughness: 0.92, metalness: 0 }, { paint: 0.9, rim: 0.3 });
/** Trunks / rocks (no wind). */
export const barkMaterial = standard({ vertexColors: true, roughness: 0.95, metalness: 0 }, { paint: 1.3, rim: 0.15 });

/**
 * Window glass. Vertex colour encodes data, not albedo:
 *   r = how lit this window is at night (0..1), g = warm tint variation, b = curtain amount.
 */
export const windowMaterial = standard(
  { vertexColors: true, roughness: 0.25, metalness: 0.1, color: new Color('#3d4a5c') },
  {
    extraFrag: `{
  vec3 d = vColor.rgb;
  vec3 warmA = vec3(1.0, 0.70, 0.36);
  vec3 warmB = vec3(1.0, 0.82, 0.55);
  vec3 glowC = mix(warmA, warmB, d.g);
  float flick = 0.94 + 0.06 * sin(uTime * 3.1 + vWPos.x * 1.7 + vWPos.z);
  float pane = 0.75 + 0.25 * smoothstep(0.0, 0.6, fract(vWPos.y * 2.2));
  outgoingLight = mix(outgoingLight, glowC * 2.6 * pane * flick, clamp(uGlow * d.r, 0.0, 1.0));
  // daytime sky reflection streak
  float streak = smoothstep(0.45, 0.5, fract((vWPos.x + vWPos.z) * 0.6 + vWPos.y * 0.6)) * (1.0 - smoothstep(0.5, 0.6, fract((vWPos.x + vWPos.z) * 0.6 + vWPos.y * 0.6)));
  outgoingLight += vec3(0.25, 0.3, 0.33) * streak * (1.0 - uGlow);
  // Interior side of a window (b = 1): the sky outside — bright by day, deep blue at night.
  if (d.b > 0.5) {
    float sky = clamp(vWPos.y - floor(vWPos.y), 0.0, 1.0);
    vec3 dayC = mix(vec3(0.78, 0.88, 0.93), vec3(0.95, 0.93, 0.84), 0.35 + 0.3 * sky);
    vec3 nightC = vec3(0.11, 0.14, 0.27) + vec3(0.05, 0.05, 0.08) * streak;
    outgoingLight = mix(dayC * (0.9 + 0.1 * streak), nightC, uNight);
  }
}`,
  },
);
// Do not tint glass by vertex data.
const baseCompile = windowMaterial.onBeforeCompile;
windowMaterial.onBeforeCompile = (shader, renderer) => {
  baseCompile.call(windowMaterial, shader, renderer);
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '');
};

// --- Cutaway variants for architecture (walk-in buildings fade their walls/roof). --------
export const solidCutMaterial = standard({ vertexColors: true, roughness: 0.84, metalness: 0 }, { paint: 1, rim: 0.22, cut: true });
export const glazedCutMaterial = standard({ vertexColors: true, roughness: 0.55, metalness: 0 }, { paint: 0.6, rim: 0.25, cut: true });
export const staticPlantCutMaterial = standard({ vertexColors: true, roughness: 0.92, metalness: 0 }, { paint: 0.9, rim: 0.3, cut: true });
export const windowCutMaterial = windowMaterial.clone() as MeshStandardMaterial;
{
  const winOpts = { extraFrag: 'window', cut: true };
  const base = windowMaterial.onBeforeCompile;
  windowCutMaterial.customProgramCacheKey = () => JSON.stringify(winOpts);
  windowCutMaterial.onBeforeCompile = (shader, renderer) => {
    base.call(windowCutMaterial, shader, renderer);
    shader.uniforms.uCut = cutUniform;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${CUT_VERT_HEADER}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUT_VERT}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${CUT_FRAG_HEADER}`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_FRAG}`);
  };
}

let _cutDepth: MeshDepthMaterial | null = null;
/** Shadow-pass depth material honouring the cutaway (a faded roof lets the sun into the room). */
export function cutDepthMaterial(): MeshDepthMaterial {
  if (_cutDepth) return _cutDepth;
  const m = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.customProgramCacheKey = () => 'cutDepth';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCut = cutUniform;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${CUT_VERT_HEADER}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUT_VERT}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${CUT_FRAG_HEADER}`).replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_FRAG}`);
  };
  return (_cutDepth = m);
}

/** Lamp bulbs / glowing bits, per-instance colour drives on/off. */
export const bulbMaterial = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false });

function radialTexture(inner: string, outer: string, size = 128, falloff = 1): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35 * falloff, inner.replace(/[\d.]+\)$/, '0.45)'));
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new CanvasTexture(c);
  return t;
}

let _glowTex: CanvasTexture | null = null;
export function glowTexture(): CanvasTexture {
  return (_glowTex ??= radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)'));
}
let _shadowTex: CanvasTexture | null = null;
export function blobTexture(): CanvasTexture {
  return (_shadowTex ??= radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64, 1.6));
}

/** Additive glow (halos, light pools). Per-instance colour = intensity. */
export function additiveMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false, vertexColors: false });
}

export function disposeAll(list: Material[]): void {
  for (const m of list) m.dispose();
}
