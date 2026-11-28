/**
 * Materials for player-built pieces: the world's matte clay and window glass,
 * plus two per-instance attributes so pieces can step aside for the local
 * player without transparency sorting or extra draw calls:
 *  - `aFade` (0 = solid, 1 = gone): dithered fade (roofs / upper storeys near
 *    you, tall walls between the camera and you outdoors); ≥ 0.995 discards the
 *    piece completely (no veil of dots left);
 *  - `aCut` (0 = no cut, else 1000 + a world-space clip height): a hard cut —
 *    everything above the height is gone. Built interiors use it to drop the
 *    camera-side walls of the room you are in to stubs. A cut piece shows its
 *    inner faces as a dark cap (the materials draw both sides, but back faces
 *    of uncut pieces are discarded at once, so everything else looks as before)
 *    with a thin darker line along the cut.
 * The shadow pass honours both (`pieceDepthMaterial`): a faded roof lets the sun
 * into the room, a cut wall casts only its stub's shadow.
 */
import { BackSide, Color, DoubleSide, MeshBasicMaterial, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, type WebGLProgramParametersWithUniforms } from 'three';
import { patch, windowMaterial } from '../world/materials.js';

type Shader = WebGLProgramParametersWithUniforms;

/** Offset of the `aCut` encoding (0 must mean "no cut": geometry without the attribute reads 0). */
export const CUT_OFFSET = 1000;

const VERT_HEADER = 'attribute float aFade; attribute float aCut; varying float vFade; varying float vCutOn; varying float vCutH;';
const VERT = `vFade = aFade;
vCutOn = step(0.5, aCut);
{
  vec4 cw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    cw = instanceMatrix * cw;
  #endif
  cw = modelMatrix * cw;
  // Metres below the clip height (negative = above it, discarded).
  vCutH = vCutOn > 0.5 ? (aCut - ${CUT_OFFSET.toFixed(1)}) - cw.y : 1.0;
}`;
const FRAG_HEADER = 'varying float vFade; varying float vCutOn; varying float vCutH;';
const FRAG_CLIP = `if (!gl_FrontFacing && vCutOn < 0.5) discard;
if (vCutH < 0.0) discard;
if (vFade > 0.995) discard;
if (vFade > 0.001) {
  // 4x4 ordered dither: screen-door transparency, keeps a faint silhouette.
  vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
  float b = mod(q.x * 4.0 + q.y * 7.0 + q.x * q.y * 3.0, 16.0) / 16.0;
  if (b < vFade * 0.86) discard;
}`;
const FRAG_CAP = `if (vCutOn > 0.5) {
  // Cut piece: its inside reads as a dark solid cap; a thin darker line runs along the cut.
  if (!gl_FrontFacing) outgoingLight *= 0.38;
  else if (vCutH < 0.035) outgoingLight *= 0.62;
}
#include <opaque_fragment>`;

function withFade(mat: MeshStandardMaterial, base: (shader: Shader) => void, key: string): MeshStandardMaterial {
  mat.customProgramCacheKey = () => `build-fade-cut-${key}`;
  // Both sides are drawn so a cut piece can show its inside; uncut back faces are discarded first thing.
  mat.side = DoubleSide;
  // Shadows as before (a front-side material casts from its back faces).
  mat.shadowSide = BackSide;
  mat.onBeforeCompile = (shader, renderer) => {
    base.call(mat, shader);
    void renderer;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_HEADER}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEADER}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_CLIP}`)
      .replace('#include <opaque_fragment>', FRAG_CAP);
  };
  return mat;
}

/** Shadow-pass depth material for instanced pieces carrying `aFade` / `aCut` (faded pieces and cut-away parts cast no shadow). */
export const pieceDepthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
pieceDepthMaterial.customProgramCacheKey = () => 'build-fade-cut-depth';
pieceDepthMaterial.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_HEADER}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_HEADER}`)
    // Only (nearly) fully faded pieces (roofs, upper storeys) stop casting: a half-faded wall keeps its shadow.
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFade > 0.9 || vCutH < 0.0) discard;');
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
