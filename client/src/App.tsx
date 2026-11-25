import { useEffect } from 'react';
import { randomAppearance, randomDisplayName } from '@elsewhere/shared';
import { audio } from './audio/index.js';
import { GameCanvas } from './game/GameCanvas.js';
import { installDebugHook, net } from './net/index.js';
import { useUiStore } from './state/uiStore.js';
import { Chat, Hud } from './ui/index.js';

export function App() {
  useEffect(() => {
    installDebugHook(net);
    // Foundation: auto-join as a guest. The ui worker inserts <Onboarding> before this.
    net
      .connect({ name: randomDisplayName(), appearance: randomAppearance() })
      .then(() => useUiStore.getState().setPhase('playing'))
      .catch(() => undefined);
    const unlock = () => audio.unlock();
    // Leave consented on page close so the server removes us now instead of holding a reconnection seat.
    const leave = () => void net.disconnect();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  return (
    <>
      <GameCanvas />
      <Hud />
      <Chat />
    </>
  );
}
