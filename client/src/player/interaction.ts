/**
 * Interaction targeting: nearest interactable in range → ui prompt; the
 * interact action sends C2S.interact and routes the result to the UI.
 * (The server re-validates range; this is UX only.)
 */
import { C2S, CONFIG, INTERACTABLES, S2C, dist2, type Interactable } from '@elsewhere/shared';
import { net } from '../net/index.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { onInteractPressed } from './input.js';

export function findTarget(x: number, z: number): Interactable | null {
  let best: Interactable | null = null;
  let bestD = Infinity;
  for (const it of INTERACTABLES) {
    const r = it.radius ?? CONFIG.interaction.radius;
    const d = dist2({ x, z }, it.position);
    if (d <= r * r && d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/** Call every frame or two; cheap (≈100 interactables). */
export function updateTargeting(): void {
  const lp = runtime.localPlayer;
  if (!lp.ready) return;
  const t = findTarget(lp.x, lp.z);
  useUiStore.getState().setPrompt(t ? { interactableId: t.id, label: t.prompt, name: t.name } : null);
}

/** Wire E-key → interact, and interact results → panels/notifications. Returns cleanup. */
export function installInteraction(): () => void {
  const offPress = onInteractPressed(() => {
    const prompt = useUiStore.getState().prompt;
    if (prompt) net.send(C2S.interact, { id: prompt.interactableId });
  });
  const offResult = net.on(S2C.interactResult, (r) => {
    const ui = useUiStore.getState();
    if (!r.ok) {
      if (r.error && r.error !== 'not_implemented') ui.notify('warning', `Can't do that (${r.error})`);
      return;
    }
    if (!r.ui) return;
    switch (r.ui.panel) {
      case 'sign':
      case 'inspect':
        ui.openPanel({ kind: r.ui.panel, title: r.ui.title, text: r.ui.text });
        break;
      case 'gazette':
      case 'memory':
        ui.openPanel({ kind: r.ui.panel });
        break;
      case 'mailbox':
        ui.openPanel({ kind: 'mailbox', mailboxId: r.ui.mailboxId, canSend: r.ui.canSend });
        break;
      case 'discovery':
        ui.openPanel({ kind: 'discovery', discoveryId: r.ui.discoveryId, name: r.ui.name, text: r.ui.text, firstTime: r.ui.firstTime });
        break;
    }
  });
  return () => {
    offPress();
    offResult();
  };
}
