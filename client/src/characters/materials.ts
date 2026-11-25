/**
 * Shared character materials (one program, a handful of instances shared by
 * every character on screen).
 *
 * "Toy" finish: matte clay/vinyl base (vertex colours) + per-vertex `gloss`
 * attribute (painted eyes, lenses, gems are shiny) + a soft fresnel sheen
 * that gives the rounded forms a tactile vinyl edge. Variants only change
 * uniform values, so they all share one compiled shader.
 */
import { Color, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from 'three';

export interface ToyMaterialOptions {
  roughness: number;
  rimColor: string;
  rimStrength: number;
  rimPower: number;
  emissive?: string;
  /** Saturation multiplier applied in-shader (NPC "glaze" is slightly cooler / less saturated). */
  saturation?: number;
}

function makeToyMaterial(name: string, o: ToyMaterialOptions): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: o.roughness, metalness: 0, emissive: new Color(o.emissive ?? '#000000') });
  m.name = name;
  const uniforms = {
    uRimColor: { value: new Color(o.rimColor) },
    uRimStrength: { value: o.rimStrength },
    uRimPower: { value: o.rimPower },
    uSaturation: { value: o.saturation ?? 1 },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float gloss;\nvarying float vGloss;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloss = gloss;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vGloss;\nuniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\nuniform float uSaturation;',
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n{ float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, uSaturation); }',
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.18, vGloss);')
      .replace(
        '#include <opaque_fragment>',
        `{
          vec3 vdir = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
          float fr = pow(1.0 - saturate(dot(normalize(normal), vdir)), uRimPower);
          outgoingLight += uRimColor * fr * uRimStrength * (0.6 + 0.4 * diffuseColor.rgb);
          // Small self-lit floor so the toys stay readable at night / in deep shade.
          outgoingLight = max(outgoingLight, diffuseColor.rgb * 0.16);
        }
        #include <opaque_fragment>`,
      );
  };
  // Same shader source for every variant → one program.
  m.customProgramCacheKey = () => 'elsewhere-toy-v1';
  return m;
}

export const TOY_MATERIALS = {
  player: makeToyMaterial('toy-player', { roughness: 0.74, rimColor: '#fff1dc', rimStrength: 0.16, rimPower: 2.6 }),
  playerHighlight: makeToyMaterial('toy-player-hl', { roughness: 0.74, rimColor: '#ffd27a', rimStrength: 0.85, rimPower: 2.6, emissive: '#120b04' }),
  // NPCs: glazed-ceramic finish (glossier, cooler sheen, a touch desaturated).
  npc: makeToyMaterial('toy-npc', { roughness: 0.32, rimColor: '#cfe6ff', rimStrength: 0.42, rimPower: 2.2, saturation: 0.82 }),
  npcHighlight: makeToyMaterial('toy-npc-hl', { roughness: 0.32, rimColor: '#ffd27a', rimStrength: 0.9, rimPower: 2.6, saturation: 0.82, emissive: '#120b04' }),
} as const;

export type CharacterVariant = 'player' | 'npc';

export function toyMaterial(variant: CharacterVariant, highlighted: boolean): MeshStandardMaterial {
  if (variant === 'npc') return highlighted ? TOY_MATERIALS.npcHighlight : TOY_MATERIALS.npc;
  return highlighted ? TOY_MATERIALS.playerHighlight : TOY_MATERIALS.player;
}

/** Floating NPC marker (small glowing gem). */
export const NPC_MARKER_MATERIAL = new MeshStandardMaterial({ color: '#9fd3e8', emissive: '#3f8fb0', emissiveIntensity: 0.9, roughness: 0.25, metalness: 0 });
