import { useEffect, useState } from 'react';
import { randomAppearance, randomDisplayName } from '@elsewhere/shared';
import { audio } from './audio/index.js';
import { AudioDirector } from './audio/AudioDirector.js';
import { GameCanvas } from './game/GameCanvas.js';
import { installDebugHook, net } from './net/index.js';
import { useGameStore } from './state/gameStore.js';
import { useUiStore } from './state/uiStore.js';
import { Chat, Hud, Onboarding, Wordmark, enter, hasSavedSession, installUiBridge, resumeSession, toasts, useUiGlobals, type EnterRequest } from './ui/index.js';

/**
 * App phases (useUiStore.phase):
 *   loading    → deciding: `?autojoin=1` (automated tests) joins at once as a random guest;
 *                a saved session token resumes straight into the world ("welcome back");
 *                otherwise → onboarding.
 *   onboarding → title sequence → guest / account → look → name → enter (ui/Onboarding).
 *   playing    → HUD + chat over the world.
 */
let flowStarted = false;

/** Shown once the arrival veil has lifted. */
function welcomeBack(name: string): void {
  setTimeout(() => toasts.push({ level: 'info', text: name ? `Welcome back, ${name}.` : 'Welcome back.', ttlMs: 5000 }), 1100);
}

function startFlow(setResumeError: (msg: string | null) => void): void {
  if (flowStarted) return;
  flowStarted = true;
  const ui = useUiStore.getState();
  const params = new URLSearchParams(location.search);
  if (params.get('autojoin') === '1') {
    net
      .connect({ name: randomDisplayName(), appearance: randomAppearance() })
      .then(() => ui.setPhase('playing'))
      .catch(() => setResumeError('Couldn’t reach the island.'));
    return;
  }
  if (!hasSavedSession()) {
    ui.setPhase('onboarding');
    return;
  }
  resumeSession()
    .then((name) => {
      if (name === null) return ui.setPhase('onboarding');
      ui.setPhase('playing');
      welcomeBack(name);
    })
    .catch((err: unknown) => setResumeError(err instanceof Error ? err.message : 'Couldn’t reach the island.'));
}

function Loading({ error, onRetry }: { error: string | null; onRetry(): void }) {
  return (
    <div className="loading" data-testid="loading" role="status">
      <Wordmark className="wordmark--small" />
      {error ? (
        <>
          <p className="loading__text">{error}</p>
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Try again
          </button>
        </>
      ) : (
        <p className="loading__text loading__text--soft">Finding your way back…</p>
      )}
    </div>
  );
}

/** Shown when the server removed this client (kick/ban). Never retries on its own. */
function Removed({ reason }: { reason: string }) {
  return (
    <div className="loading removed" role="alertdialog" aria-labelledby="removed-title" data-testid="removed">
      <h2 id="removed-title" className="card__title">You were removed from the island</h2>
      <p className="loading__text">{reason ? `Reason given: ${reason}` : 'A moderator ended your session.'}</p>
      <p className="loading__text loading__text--small">You won’t be reconnected automatically. If you think this was a mistake, you can try again later.</p>
      <button type="button" className="btn btn--ghost" onClick={() => location.reload()}>
        Return to the start
      </button>
    </div>
  );
}

/** Soft veil that lifts as you arrive in the world. */
function Reveal() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(false), 1600);
    return () => clearTimeout(t);
  }, []);
  return on ? <div className="reveal" aria-hidden="true" /> : null;
}

export function App() {
  const phase = useUiStore((s) => s.phase);
  const kicked = useGameStore((s) => s.kicked);
  const [resumeError, setResumeError] = useState<string | null>(null);
  useUiGlobals();

  useEffect(() => {
    installDebugHook(net);
    const offBridge = installUiBridge();
    startFlow(setResumeError);
    const unlock = () => audio.unlock();
    // Leave consented on page close so the server removes us now instead of holding a reconnection seat.
    const leave = () => void net.disconnect();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pagehide', leave);
    return () => {
      offBridge();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

  const onEnter = async (req: EnterRequest) => {
    await enter(req);
    useUiStore.getState().setPhase('playing');
    if (req.mode === 'login') {
      welcomeBack(useGameStore.getState().profile?.name ?? '');
    }
  };

  return (
    <>
      <AudioDirector />
      <GameCanvas />
      {phase === 'playing' ? (
        <>
          <Hud />
          <Chat />
          <Reveal />
          {kicked ? <Removed reason={kicked.reason} /> : null}
        </>
      ) : phase === 'onboarding' ? (
        <Onboarding onEnter={onEnter} />
      ) : (
        <Loading
          error={resumeError}
          onRetry={() => {
            setResumeError(null);
            flowStarted = false;
            startFlow(setResumeError);
          }}
        />
      )}
    </>
  );
}
