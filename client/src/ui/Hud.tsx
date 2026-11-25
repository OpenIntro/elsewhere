/**
 * In-world HUD: top bar (wordmark, location, world time, weather, real online
 * count, connection), bottom navigation, contextual interaction prompt,
 * toasts, one-time controls hint, location title card, camera buttons and the
 * panel host.
 */
import { useEffect, useRef, useState } from 'react';
import { LOCATIONS, worldTimeAt } from '@elsewhere/shared';
import { cameraControls, pressInteract, useCameraStore, useTouchControlsVisible } from '../player/index.js';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { useUiStore, type Panel } from '../state/uiStore.js';
import { useChatUnread } from './Chat.js';
import { useIsTouch, useTicker } from './hooks.js';
import { Icon, phaseIcon, type IconName } from './icons.js';
import { formatWorldClock, phaseLabel } from './lib/format.js';
import { useChatUi, useUiPrefs } from './localState.js';
import { CustomizePanel } from './panels/CustomizePanel.js';
import { GazettePanel } from './panels/GazettePanel.js';
import { MapPanel } from './panels/MapPanel.js';
import { PlayerCard } from './panels/PlayerCard.js';
import { DiscoveryPanel, MailboxPanel, ReadingPanel } from './panels/ReadingPanels.js';
import { SettingsPanel } from './panels/SettingsPanel.js';
import { HomePanel, InventoryPanel } from './panels/SimplePanels.js';
import { toasts, useToasts } from './toasts.js';

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function WorldClock() {
  useTicker(1000);
  const clock = useGameStore((s) => s.clock);
  const style = useUiPrefs((s) => s.clockStyle);
  const wt = worldTimeAt(serverNow(), { epochMs: clock.epochMs, dayLengthMs: clock.dayLengthMs });
  const night = wt.phase === 'night' || wt.phase === 'dusk';
  return (
    <div className="pill pill--clock" data-testid="hud-clock" data-phase={wt.phase}>
      <span className="pill__item" title={phaseLabel(wt.phase)}>
        <Icon name={phaseIcon(wt.phase)} size={18} className="pill__phase" />
        <span className="pill__time">{formatWorldClock(wt, style)}</span>
        <span className="pill__label hide-sm">{phaseLabel(wt.phase)}</span>
      </span>
      <span className="pill__sep hide-xs" aria-hidden="true" />
      <span className="pill__item hide-xs" title="Weather: clear. The island has no weather yet." data-testid="hud-weather">
        <Icon name={night ? 'moon' : 'sun'} size={16} className="pill__dim" />
        <span className="pill__label">Clear</span>
      </span>
    </div>
  );
}

function OnlineCount() {
  const count = useGameStore((s) => Object.keys(s.players).length);
  const connected = useGameStore((s) => s.connection === 'connected');
  if (!connected) return null;
  return (
    <div className="pill" title="People in this world right now" data-testid="hud-online">
      <span className="pill__item">
        <Icon name="people" size={18} className="pill__dim" />
        <span className="pill__time" data-testid="player-count">
          {count}
        </span>
        <span className="pill__label">here</span>
      </span>
    </div>
  );
}

function ConnectionPill() {
  const connection = useGameStore((s) => s.connection);
  const attempt = useGameStore((s) => s.reconnectAttempt);
  const kicked = useGameStore((s) => s.kicked);
  if (connection === 'connected' || connection === 'idle' || kicked) return null;
  const lost = connection === 'disconnected' || connection === 'error';
  return (
    <div className={`pill pill--conn${lost ? ' is-lost' : ''}`} role="status" data-testid="hud-connection">
      <span className="conn-dot" aria-hidden="true" />
      <span className="pill__label">{lost ? 'Connection lost' : connection === 'connecting' ? 'Connecting…' : attempt > 1 ? `Reconnecting… (try ${attempt})` : 'Reconnecting…'}</span>
      {lost ? (
        <button type="button" className="btn btn--primary btn--xs" onClick={() => location.reload()}>
          Rejoin
        </button>
      ) : null}
    </div>
  );
}

function useMyLocation() {
  return useGameStore((s) => (s.sessionId ? (s.players[s.sessionId]?.location ?? '') : ''));
}

function TopBar() {
  const locId = useMyLocation();
  const loc = LOCATIONS.find((l) => l.id === locId);
  return (
    <header className="topbar" data-testid="hud-status">
      <div className="topbar__brand">
        <span className="topbar__mark">Elsewhere</span>
        <span className="topbar__place" aria-live="polite">
          {loc?.name ?? ''}
        </span>
      </div>
      <div className="topbar__status">
        <ConnectionPill />
        <WorldClock />
        <OnlineCount />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Bottom navigation
// ---------------------------------------------------------------------------

type NavId = 'map' | 'inventory' | 'chat' | 'home' | 'gazette' | 'settings';
const NAV: readonly { id: NavId; label: string; icon: IconName }[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'inventory', label: 'Things', icon: 'bag' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'gazette', label: 'Gazette', icon: 'paper' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function navActive(id: NavId, panel: Panel | null, chatOpen: boolean): boolean {
  if (id === 'chat') return chatOpen;
  if (!panel) return false;
  if (id === 'gazette') return panel.kind === 'gazette' || panel.kind === 'memory';
  if (id === 'settings') return panel.kind === 'settings' || panel.kind === 'customize';
  return panel.kind === id;
}

function BottomNav() {
  const panel = useUiStore((s) => s.panel);
  const chatOpen = useUiStore((s) => s.chatOpen);
  const { count, mention } = useChatUnread();
  const narrow = useIsNarrow();
  const toggle = (id: NavId) => {
    const ui = useUiStore.getState();
    if (id === 'chat') {
      const next = !ui.chatOpen;
      ui.setChatOpen(next);
      if (next) {
        if (narrow) ui.closePanel();
        useChatUi.getState().requestFocus();
      }
      return;
    }
    if (navActive(id, ui.panel, false)) return ui.closePanel();
    if (narrow) ui.setChatOpen(false);
    ui.openPanel({ kind: id } as Panel);
  };
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((n) => {
        const on = navActive(n.id, panel, chatOpen);
        return (
          <button key={n.id} type="button" className={`nav__btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(n.id)} data-testid={`nav-${n.id}`}>
            <span className="nav__icon">
              <Icon name={n.icon} size={22} />
              {n.id === 'chat' && count > 0 && !chatOpen ? (
                <span className={`nav__badge${mention ? ' is-mention' : ''}`} aria-label={`${count} unread`}>
                  {count > 9 ? '9+' : count}
                </span>
              ) : null}
            </span>
            <span className="nav__label">{n.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function useIsNarrow(): boolean {
  const [n, setN] = useState(() => window.matchMedia('(max-width: 720px), (max-height: 500px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px), (max-height: 500px)');
    const on = () => setN(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return n;
}

// ---------------------------------------------------------------------------
// Contextual: prompt, toasts, hint, location card, camera buttons
// ---------------------------------------------------------------------------

const READING_PANELS = new Set<Panel['kind']>(['sign', 'inspect', 'discovery', 'mailbox', 'customize', 'profile', 'report']);

function Prompt() {
  const prompt = useUiStore((s) => s.prompt);
  const playerPrompt = useUiStore((s) => s.playerPrompt);
  const panel = useUiStore((s) => s.panel);
  const typing = useUiStore((s) => s.textInputFocused);
  const touch = useIsTouch();
  // On touch the player system's thumb action button carries the prompt; don't duplicate it.
  const touchControls = useTouchControlsVisible();
  const p = prompt ? { label: prompt.label, name: prompt.name } : playerPrompt ? { label: playerPrompt.label, name: playerPrompt.name } : null;
  if (!p || touchControls || (panel && READING_PANELS.has(panel.kind))) return null;
  return (
    <button
      type="button"
      className={`prompt${touch ? ' prompt--touch' : ''}${typing ? ' is-dim' : ''}`}
      onClick={() => pressInteract()}
      aria-label={`${p.label} ${p.name}`}
      data-testid="interact-prompt"
      key={`${p.label}-${p.name}`}
    >
      {!touch ? <kbd className="prompt__key">E</kbd> : null}
      <span className="prompt__label">{p.label}</span>
      <span className="prompt__name">{p.name}</span>
    </button>
  );
}

function Toasts() {
  const list = useToasts();
  const notifications = useUiStore((s) => s.notifications);
  const dismiss = useUiStore((s) => s.dismiss);
  // Drain other systems' ui.notify() into the shared queue.
  useEffect(() => {
    for (const n of notifications) {
      toasts.push({ id: `n${n.id}`, level: n.level, text: n.text, ttlMs: n.expiresAt ? Math.max(1800, n.expiresAt - Date.now()) : 0 });
      dismiss(n.id);
    }
  }, [notifications, dismiss]);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false" data-testid="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`} role={t.level === 'error' || t.level === 'warning' ? 'alert' : 'status'} data-testid="toast">
          {t.level === 'world' ? <Icon name="sparkle" size={18} className="toast__icon" /> : null}
          <div className="toast__body">
            <p className="toast__text">
              {t.text}
              {t.count > 1 ? <span className="toast__count"> ×{t.count}</span> : null}
            </p>
            {t.detail ? <p className="toast__detail">{t.detail}</p> : null}
          </div>
          <button type="button" className="toast__x" aria-label="Dismiss" onClick={() => toasts.dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ControlsHint() {
  const seen = useUiPrefs((s) => s.controlsHintSeen);
  const set = useUiPrefs((s) => s.set);
  const touch = useIsTouch();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (seen) return;
    const a = setTimeout(() => setShow(true), 1600);
    const b = setTimeout(() => {
      setShow(false);
      set({ controlsHintSeen: true });
    }, 16000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [seen, set]);
  if (seen || !show) return null;
  const close = () => {
    setShow(false);
    set({ controlsHintSeen: true });
  };
  return (
    <aside className="hint" aria-label="Controls" data-testid="controls-hint">
      <ul className="hint__list">
        {touch ? (
          <>
            <li>
              <span className="hint__key">Joystick</span> to walk
            </li>
            <li>
              <span className="hint__key">Tap</span> the round button to interact
            </li>
            <li>
              <span className="hint__key">Pinch</span> to zoom
            </li>
          </>
        ) : (
          <>
            <li>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> walk, <kbd>Shift</kbd> run
            </li>
            <li>
              <kbd>E</kbd> interact
            </li>
            <li>
              <kbd>Q</kbd>
              <kbd>R</kbd> turn view
            </li>
            <li>
              <kbd>Enter</kbd> chat
            </li>
          </>
        )}
      </ul>
      <button type="button" className="icon-btn icon-btn--xs" aria-label="Got it" onClick={close} data-testid="hint-close">
        <Icon name="close" size={14} />
      </button>
    </aside>
  );
}

function LocationCard() {
  const locId = useMyLocation();
  const [card, setCard] = useState<{ name: string; key: number } | null>(null);
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current === locId) return;
    const first = prev.current === null;
    prev.current = locId;
    const loc = LOCATIONS.find((l) => l.id === locId);
    if (!loc) return;
    setCard({ name: loc.name, key: Date.now() });
    const t = setTimeout(() => setCard(null), first ? 3600 : 2800);
    return () => clearTimeout(t);
  }, [locId]);
  if (!card) return null;
  return (
    <div className="placecard" key={card.key} aria-hidden="true">
      <span className="placecard__rule" />
      <span className="placecard__name">{card.name}</span>
      <span className="placecard__rule" />
    </div>
  );
}

function CameraButtons() {
  const pref = useUiPrefs((s) => s.cameraButtons);
  const touch = useIsTouch();
  const free = useCameraStore((s) => s.free);
  const panelOpen = useUiStore((s) => s.panel !== null);
  if (pref === 'off' || (pref === 'auto' && !touch) || panelOpen) return null;
  return (
    <div className="camctl" role="group" aria-label="Camera">
      <button type="button" className="icon-btn icon-btn--glass" aria-label="Turn view left" onClick={() => cameraControls.rotateLeft()}>
        <Icon name="rotateL" size={20} />
      </button>
      <button type="button" className="icon-btn icon-btn--glass" aria-label="Turn view right" onClick={() => cameraControls.rotateRight()}>
        <Icon name="rotateR" size={20} />
      </button>
      <button type="button" className="icon-btn icon-btn--glass" aria-label="Zoom in" onClick={() => cameraControls.zoomIn()}>
        <Icon name="zoomIn" size={20} />
      </button>
      <button type="button" className="icon-btn icon-btn--glass" aria-label="Zoom out" onClick={() => cameraControls.zoomOut()}>
        <Icon name="zoomOut" size={20} />
      </button>
      {free ? (
        <button type="button" className="icon-btn icon-btn--glass is-on" aria-label="Recenter on me" onClick={() => cameraControls.recenter()}>
          <Icon name="target" size={20} />
        </button>
      ) : null}
    </div>
  );
}

/** Free camera: a gentle pill to come back. */
function FreeCamPill() {
  const free = useCameraStore((s) => s.free);
  if (!free) return null;
  return (
    <button type="button" className="pill pill--action freecam" onClick={() => cameraControls.recenter()} data-testid="freecam">
      <Icon name="target" size={16} /> <span className="pill__label">Back to me</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function PanelHost() {
  const panel = useUiStore((s) => s.panel);
  const closePanel = useUiStore((s) => s.closePanel);
  const playerMenu = useUiStore((s) => s.playerMenu);
  const narrow = useIsNarrow();

  // The player worker's context-menu request opens the player card.
  useEffect(() => {
    if (!playerMenu) return;
    const ui = useUiStore.getState();
    const cur = ui.panel;
    if (!(cur?.kind === 'profile' && cur.sessionId === playerMenu.sessionId)) ui.openPanel({ kind: 'profile', sessionId: playerMenu.sessionId });
  }, [playerMenu]);
  useEffect(() => {
    const ui = useUiStore.getState();
    if (ui.playerMenu && !(panel?.kind === 'profile' && panel.sessionId === ui.playerMenu.sessionId)) ui.closePlayerMenu();
    // Small screens show one surface at a time.
    if (panel && narrow && ui.chatOpen) ui.setChatOpen(false);
  }, [panel, narrow]);

  if (!panel) return null;
  const close = closePanel;
  switch (panel.kind) {
    case 'sign':
    case 'inspect':
      return <ReadingPanel key={panel.title} kind={panel.kind} title={panel.title} text={panel.text} onClose={close} />;
    case 'discovery':
      return <DiscoveryPanel key={panel.discoveryId} name={panel.name} text={panel.text} firstTime={panel.firstTime} onClose={close} />;
    case 'mailbox':
      return <MailboxPanel key={panel.mailboxId} mailboxId={panel.mailboxId} canSend={panel.canSend} onClose={close} />;
    case 'gazette':
      return <GazettePanel initialTab="news" onClose={close} />;
    case 'memory':
      return <GazettePanel initialTab="history" onClose={close} />;
    case 'map':
      return <MapPanel onClose={close} />;
    case 'inventory':
      return <InventoryPanel onClose={close} />;
    case 'home':
      return <HomePanel onClose={close} />;
    case 'settings':
      return <SettingsPanel onClose={close} />;
    case 'customize':
      return <CustomizePanel onClose={close} />;
    case 'profile':
      return <PlayerCard key={panel.sessionId} sessionId={panel.sessionId} onClose={close} />;
    case 'report':
      return <PlayerCard key={`r-${panel.sessionId}`} sessionId={panel.sessionId} startWithReport onClose={close} />;
  }
}

export function Hud() {
  return (
    <div className="hud" data-testid="hud">
      <TopBar />
      <Toasts />
      <LocationCard />
      <FreeCamPill />
      <CameraButtons />
      <ControlsHint />
      <Prompt />
      <BottomNav />
      <PanelHost />
    </div>
  );
}
