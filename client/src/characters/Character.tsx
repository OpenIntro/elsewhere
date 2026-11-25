/**
 * CHARACTER CONTRACT — owned by the characters worker. Placeholder: a capsule
 * body with a head and hair cap tinted from the appearance.
 *
 * <Character> renders at its local origin (feet at y=0, facing +Z). The parent
 * positions/rotates it every frame (refs, not props), so these props only
 * change on low-frequency events and re-renders stay cheap.
 */
import { memo, useMemo } from 'react';
import { CLOTHING_COLORS, HAIR_COLORS, SKIN_TONES, colorHex, type AnimState, type Appearance, type ItemId } from '@elsewhere/shared';

export interface CharacterProps {
  appearance: Appearance;
  anim: AnimState;
  /** Increments to restart one-shot animations (wave) even if anim is unchanged. */
  animSeq?: number;
  /** Item held in hand ('' = none). */
  held?: ItemId | '';
  /** Highlight (e.g. hovered / targeted). */
  highlighted?: boolean;
  /** Cast shadows (disable for previews / low quality). */
  castShadow?: boolean;
}

export const Character = memo(function Character({ appearance, anim, highlighted = false, castShadow = true }: CharacterProps) {
  const colors = useMemo(
    () => ({
      skin: colorHex(SKIN_TONES, appearance.skin),
      shirt: colorHex(CLOTHING_COLORS, appearance.shirtColor),
      pants: colorHex(CLOTHING_COLORS, appearance.pantsColor),
      hair: colorHex(HAIR_COLORS, appearance.hairColor),
    }),
    [appearance],
  );
  const sitting = anim === 'sit';
  return (
    <group position={[0, sitting ? -0.25 : 0, 0]}>
      {/* legs/pants */}
      <mesh position={[0, 0.35, 0]} castShadow={castShadow}>
        <cylinderGeometry args={[0.26, 0.24, 0.7, 12]} />
        <meshStandardMaterial color={colors.pants} />
      </mesh>
      {/* torso/shirt */}
      <mesh position={[0, 0.95, 0]} castShadow={castShadow}>
        <capsuleGeometry args={[0.32, 0.4, 6, 12]} />
        <meshStandardMaterial color={colors.shirt} emissive={highlighted ? '#553311' : '#000000'} />
      </mesh>
      {/* head */}
      <mesh position={[0, 1.62, 0]} castShadow={castShadow}>
        <sphereGeometry args={[0.3, 16, 12]} />
        <meshStandardMaterial color={colors.skin} />
      </mesh>
      {/* hair cap */}
      {appearance.hairStyle !== 'none' && (
        <mesh position={[0, 1.72, -0.03]} castShadow={castShadow}>
          <sphereGeometry args={[0.31, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color={colors.hair} />
        </mesh>
      )}
      {/* nose: shows facing direction (+Z) */}
      <mesh position={[0, 1.6, 0.29]}>
        <sphereGeometry args={[0.05, 8, 6]} />
        <meshStandardMaterial color={colors.skin} />
      </mesh>
    </group>
  );
});
