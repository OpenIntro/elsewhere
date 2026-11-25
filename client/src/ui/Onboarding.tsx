/**
 * Onboarding seam (ui worker): welcome → name → customize → enter world.
 * Contract: call onDone({ name, appearance }) and App connects with them.
 * Foundation: App skips onboarding and auto-joins as a random guest.
 */
import type { Appearance } from '@elsewhere/shared';

export interface OnboardingResult {
  name: string;
  appearance: Appearance;
}

export function Onboarding(_props: { onDone(result: OnboardingResult): void }) {
  return null;
}
