/**
 * HUD placeholder (ui worker owns): connection, player count, world clock,
 * interaction prompt, notifications, and a minimal panel host for signs.
 */
import { useEffect, useState } from 'react';
import { formatClock, worldTimeAt } from '@elsewhere/shared';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { useUiStore } from '../state/uiStore.js';
import { pressInteract } from '../player/index.js';

const box: React.CSSProperties = {
  background: 'rgba(42, 38, 34, 0.78)',
  color: '#efe4cf',
  borderRadius: 10,
  padding: '8px 12px',
  font: '14px/1.4 system-ui, sans-serif',
  pointerEvents: 'auto',
};

function ClockLabel() {
  const clock = useGameStore((s) => s.clock);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const wt = worldTimeAt(serverNow(), { epochMs: clock.epochMs, dayLengthMs: clock.dayLengthMs });
  return (
    <span>
      {formatClock(wt)} · {wt.phase.replace('_', ' ')}
    </span>
  );
}

export function Hud() {
  const connection = useGameStore((s) => s.connection);
  const error = useGameStore((s) => s.connectionError);
  const count = useGameStore((s) => Object.keys(s.players).length);
  const name = useGameStore((s) => s.profile?.name);
  const prompt = useUiStore((s) => s.prompt);
  const panel = useUiStore((s) => s.panel);
  const closePanel = useUiStore((s) => s.closePanel);
  const notifications = useUiStore((s) => s.notifications);
  const dismiss = useUiStore((s) => s.dismiss);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      for (const n of useUiStore.getState().notifications) if (n.expiresAt && n.expiresAt < now) dismiss(n.id);
    }, 500);
    return () => clearInterval(t);
  }, [dismiss]);

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      <div style={{ ...box, position: 'absolute', top: 12, left: 12 }} data-testid="hud-status">
        <strong>Elsewhere</strong> · {connection}
        {connection === 'connected' && (
          <>
            {' '}· <span data-testid="player-count">{count}</span> here · <ClockLabel />
          </>
        )}
        {name && <div style={{ opacity: 0.8 }}>you are {name}</div>}
        {error && connection === 'error' && <div style={{ color: '#e0a08a' }}>{error}</div>}
      </div>
      {prompt && !panel && (
        <button
          type="button"
          onClick={() => pressInteract()}
          style={{ ...box, position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', border: 'none', cursor: 'pointer' }}
        >
          <kbd>E</kbd> {prompt.label} — {prompt.name}
        </button>
      )}
      {panel && (panel.kind === 'sign' || panel.kind === 'inspect') && (
        <div style={{ ...box, position: 'absolute', top: '30%', left: '50%', transform: 'translateX(-50%)', maxWidth: 420, whiteSpace: 'pre-wrap' }}>
          <h3 style={{ margin: '0 0 8px' }}>{panel.title}</h3>
          <div>{panel.text}</div>
          <button type="button" onClick={closePanel} style={{ marginTop: 10 }}>
            Close
          </button>
        </div>
      )}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {notifications.map((n) => (
          <div key={n.id} style={box} onClick={() => dismiss(n.id)}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}
