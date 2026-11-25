/**
 * Materials for player-built pieces: the world's matte clay and window glass,
 * plus a per-instance dithered fade (instanced attribute `aFade`, 0 = solid,
 * 1 = gone) so upper storeys and roofs can step aside for the local player
 * without transparency sorting. The shadow pass honours the fade too
 * (`pieceDepthMaterial`), so a faded roof lets the sun into the room, like
 * the interiors' cutaway.
 */
import { Color, MeshBasicMaterial, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, type WebGLProgramParametersWithUniforms } from 'three';
import { patch, windowMaterial } from '../world/materials.js';

type Shader = WebGLProgramParametersWithUniforms;

function withFade(mat: MeshStandardMaterial, base: (shader: Shader) => void, key: string): MeshStandardMaterial {
  mat.customProgramCacheKey = () => `build-fade-${key}`;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader);
    void renderer;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFade; varying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
if (vFade > 0.001) {
  // 4x4 ordered dither: screen-door transparency, keeps a faint silhouette.
  vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
  float b = mod(q.x * 4.0 + q.y * 7.0 + q.x * q.y * 3.0, 16.0) / 16.0;
  if (b < vFade * 0.86) discard;
}`,
      );
  };
  return mat;
}

const FADE_FRAG = `
if (vFade > 0.001) {
  // 4x4 ordered dither: screen-door transparency, keeps a faint silhouette.
  vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
  float b = mod(q.x * 4.0 + q.y * 7.0 + q.x * q.y * 3.0, 16.0) / 16.0;
  if (b < vFade * 0.86) discard;
}`;

/** Shadow-pass depth material for instanced pieces carrying `aFade` (faded pieces stop casting shadows). */
export const pieceDepthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
pieceDepthMaterial.customProgramCacheKey = () => 'build-fade-depth';
pieceDepthMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aFade; varying float vFade;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFade;')
    // Only (nearly) fully faded pieces (roofs, upper storeys) stop casting: a half-faded wall keeps its shadow.
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFade > 0.9) discard;');
};

const clay = patch(new MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0 }), { paint: 1, rim: 0.22 });
const clayCompile = clay.onBeforeCompile as unknown as (s: Shader) => void;
/** Matte painted clay/wood (vertex coloured), fade-capable. */
export const pieceMaterial = withFade(clay, clayCompile, 'clay');

const glass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.1, color: new Color('#3d4a5c') });
/** Window glass that glows at night like the town's windows, fade-capable. */
export const pieceGlassMaterial = withFade(glass, (s) => (windowMaterial.onBeforeCompile as unknown as (s: Shader) => void).call(windowMaterial, s), 'glass');

/** Lantern glass: colour is driven per frame by the world clock (warm at night). */
export const lampGlassMaterial = new MeshBasicMaterial({ color: '#8a8070', toneMapped: false });

/** Ghost preview (valid / invalid tint). */
export const ghostMaterial = new MeshStandardMaterial({ color: '#9fd9a4', transparent: true, opacity: 0.55, roughness: 0.6, depthWrite: false, emissive: new Color('#2f6b3a'), emissiveIntensity: 0.35 });
export const GHOST_OK = new Color('#a6dcae');
export const GHOST_BAD = new Color('#e7a08f');
export const GHOST_OK_EMISSIVE = new Color('#2f6b3a');
export const GHOST_BAD_EMISSIVE = new Color('#7a2f22');
