/**
 * Customization seam (ui worker): edits an Appearance using APPEARANCE_CATALOG /
 * ACCESSORY_CATALOG with a live <CharacterPreview>. On save: net.send(C2S.updateProfile, { appearance }).
 */
import type { Appearance } from '@elsewhere/shared';

export interface CustomizationScreenProps {
  initial: Appearance;
  onSave(appearance: Appearance): void;
  onCancel(): void;
}

export function CustomizationScreen(_props: CustomizationScreenProps) {
  return null;
}
