/** Settings: sound, display, controls, camera, account, character, privacy & safety. */
import { useEffect, useId, useState } from 'react';
import { API, C2S, type RelationsResponse } from '@elsewhere/shared';
import { net } from '../../net/index.js';
import { STORAGE_KEYS, safeStorage } from '../../state/storage.js';
import { cameraControls, useCameraStore } from '../../player/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { useSettingsStore, type GraphicsQuality } from '../../state/settingsStore.js';
import { useUiStore } from '../../state/uiStore.js';
import { useSocialUi, useUiPrefs } from '../localState.js';
import { Icon } from '../icons.js';
import { Segmented, Sheet, Slider, Spinner, Toggle } from '../primitives.js';
import { CREDENTIAL_ERRORS, FlowError, logout, upgradeGuest, validateCredentials } from '../session.js';
import { formatMonthYear } from '../lib/format.js';

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={id}>
      <h3 className="section__title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function SoundSection() {
  const s = useSettingsStore();
  return (
    <Section title="Sound" id="set-sound">
      <div className="row-control">
        <span className="row-control__label">
          <span>Sound</span>
          <small>{s.muted ? 'Everything is muted' : 'Plays after your first tap or key press'}</small>
        </span>
        <button type="button" className={`btn btn--ghost btn--sm${s.muted ? ' is-on' : ''}`} aria-pressed={s.muted} onClick={() => s.setMuted(!s.muted)} data-testid="mute-toggle">
          <Icon name={s.muted ? 'mute' : 'volume'} size={18} /> {s.muted ? 'Unmute' : 'Mute all'}
        </button>
      </div>
      <Slider label="Master" icon="volume" value={s.masterVolume} onChange={s.setMasterVolume} disabled={s.muted} testId="vol-master" />
      <Slider label="Music" value={s.volumes.music} onChange={(v) => s.setVolume('music', v)} disabled={s.muted} testId="vol-music" />
      <Slider label="Ambience" value={s.volumes.ambience} onChange={(v) => s.setVolume('ambience', v)} disabled={s.muted} testId="vol-ambience" />
      <Slider label="Sound effects" value={s.volumes.sfx} onChange={(v) => s.setVolume('sfx', v)} disabled={s.muted} testId="vol-sfx" />
    </Section>
  );
}

function DisplaySection() {
  const graphics = useSettingsStore((s) => s.graphics);
  const setGraphics = useSettingsStore((s) => s.setGraphics);
  const reduced = useSettingsStore((s) => s.reducedMotion);
  const setReduced = useSettingsStore((s) => s.setReducedMotion);
  const prefs = useUiPrefs();
  return (
    <Section title="Display" id="set-display">
      <div className="row-control row-control--stack">
        <span className="row-control__label">
          <span>Graphics</span>
          <small>Lower is kinder to older devices and batteries.</small>
        </span>
        <Segmented<GraphicsQuality>
          label="Graphics quality"
          value={graphics}
          onChange={setGraphics}
          options={[
            { id: 'low', label: 'Low' },
            { id: 'medium', label: 'Medium' },
            { id: 'high', label: 'High' },
          ]}
        />
      </div>
      <div className="row-control">
        <span className="row-control__label">
          <span>Clock</span>
        </span>
        <Segmented
          label="Clock style"
          size="sm"
          value={prefs.clockStyle}
          onChange={(v) => prefs.set({ clockStyle: v })}
          options={[
            { id: '24h', label: '24h' },
            { id: '12h', label: '12h' },
          ]}
        />
      </div>
      <Toggle label="Reduce motion" hint="Fewer animations in menus and transitions." checked={reduced} onChange={setReduced} />
    </Section>
  );
}

function ControlsSection() {
  const controls = useSettingsStore((s) => s.controls);
  const setControls = useSettingsStore((s) => s.setControls);
  const prefs = useUiPrefs();
  const free = useCameraStore((s) => s.free);
  return (
    <Section title="Controls & camera" id="set-controls">
      <div className="row-control row-control--stack">
        <span className="row-control__label">
          <span>On-screen joystick</span>
          <small>Auto shows it on touch screens.</small>
        </span>
        <Segmented
          label="On-screen joystick"
          value={controls.showTouchControls}
          onChange={(v) => setControls({ showTouchControls: v })}
          options={[
            { id: 'auto', label: 'Auto' },
            { id: 'always', label: 'Always' },
            { id: 'never', label: 'Off' },
          ]}
        />
      </div>
      <Toggle label="Run by default" hint="Hold Shift to walk instead." checked={controls.runByDefault} onChange={(v) => setControls({ runByDefault: v })} />
      <div className="row-control">
        <span className="row-control__label">
          <span>Stuck somewhere?</span>
          <small>Walled in or wedged? This takes you back to the Town Square.</small>
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => net.send(C2S.unstuck, {})} data-testid="unstuck">
          <Icon name="compass" size={18} /> Unstuck
        </button>
      </div>
      <Toggle label="Show names above people" checked={controls.showNames} onChange={(v) => setControls({ showNames: v })} />
      <div className="row-control row-control--stack">
        <span className="row-control__label">
          <span>Camera buttons</span>
          <small>Turn the view: [ / ] (or Q / R; while building R turns the piece), drag with the right or middle mouse button, or twist two fingers; it settles on one of four sides. Zoom: + / −, wheel or pinch. Auto shows the turn buttons on a computer, all buttons on a touch screen.</small>
        </span>
        <Segmented
          label="Camera buttons"
          value={prefs.cameraButtons}
          onChange={(v) => prefs.set({ cameraButtons: v })}
          options={[
            { id: 'auto', label: 'Auto' },
            { id: 'on', label: 'Show' },
            { id: 'off', label: 'Hide' },
          ]}
        />
      </div>
      <div className="cam-row" role="group" aria-label="Camera">
        <button type="button" className="icon-btn" aria-label="Turn view left" onClick={() => cameraControls.rotateLeft()}>
          <Icon name="rotateL" />
        </button>
        <button type="button" className="icon-btn" aria-label="Turn view right" onClick={() => cameraControls.rotateRight()}>
          <Icon name="rotateR" />
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => cameraControls.zoomIn()}>
          <Icon name="zoomIn" />
        </button>
        <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => cameraControls.zoomOut()}>
          <Icon name="zoomOut" />
        </button>
        <button type="button" className={`icon-btn${free ? ' is-on' : ''}`} aria-pressed={free} aria-label="Free camera" title="Free camera: drag to look around" onClick={() => cameraControls.toggleFree()}>
          <Icon name="camera" />
        </button>
        <button type="button" className="icon-btn" aria-label="Recenter on me" onClick={() => cameraControls.recenter()}>
          <Icon name="target" />
        </button>
      </div>
    </Section>
  );
}

function CreateAccount({ displayName, onDone }: { displayName: string; onDone(): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = validateCredentials(username, password);
    if (bad) return setError(CREDENTIAL_ERRORS[bad]);
    setBusy(true);
    setError(null);
    try {
      await upgradeGuest(username, password, displayName);
      onDone();
    } catch (err) {
      setError(err instanceof FlowError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="subform" onSubmit={submit} noValidate data-testid="upgrade-form">
      <div className="field">
        <label className="field__label" htmlFor={`${id}-u`}>
          Username
        </label>
        <input id={`${id}-u`} className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-p`}>
          Password
        </label>
        <input id={`${id}-p`} type="password" className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        {busy ? <Spinner /> : 'Create account'}
      </button>
    </form>
  );
}

function AccountSection() {
  const profile = useGameStore((s) => s.profile);
  const openPanel = useUiStore((s) => s.openPanel);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const guest = profile?.kind !== 'registered';
  return (
    <Section title="You" id="set-account">
      <div className="account">
        <div className="account__who">
          <span className="avatar-dot" aria-hidden="true">
            <Icon name="user" size={20} />
          </span>
          <div>
            <strong>{profile?.name ?? '—'}</strong>
            <small>
              {guest ? 'Guest' : `Account${profile?.username ? ` · ${profile.username}` : ''}`}
              {profile?.firstVisitAt ? ` · resident since ${formatMonthYear(profile.firstVisitAt)}` : ''}
            </small>
          </div>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => openPanel({ kind: 'customize' })} data-testid="edit-character">
          Edit character
        </button>
      </div>
      {created ? <p className="success-note">Your account is ready. You’ll keep this character on any device.</p> : null}
      {guest && !created ? (
        creating ? (
          <CreateAccount
            displayName={profile?.name ?? ''}
            onDone={() => {
              setCreating(false);
              setCreated(true);
            }}
          />
        ) : (
          <div className="row-control">
            <span className="row-control__label">
              <span>Keep your place</span>
              <small>Create an account to keep this character and your discoveries.</small>
            </span>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)} data-testid="create-account">
              Create account
            </button>
          </div>
        )
      ) : null}
      {confirmLeave ? (
        <div className="confirm" role="alertdialog" aria-label="Confirm log out">
          <p>{guest && !created ? 'As a guest, logging out means this character can’t be recovered. Leave anyway?' : 'Log out of Elsewhere on this device?'}</p>
          <div className="confirm__row">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setConfirmLeave(false)}>
              Stay
            </button>
            <button type="button" className="btn btn--danger btn--sm" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn--quiet btn--sm link-danger" onClick={() => setConfirmLeave(true)}>
          Log out
        </button>
      )}
    </Section>
  );
}

/** Fetch names for the caller's blocked/muted profiles (works for people who are offline). */
function useRelationNames(): void {
  const rememberName = useSocialUi((s) => s.rememberName);
  useEffect(() => {
    const token = safeStorage.get(STORAGE_KEYS.session);
    if (!token) return;
    let alive = true;
    fetch(API.relations, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<RelationsResponse>) : null))
      .then((body) => {
        if (!alive || !body) return;
        for (const e of [...body.blocked, ...body.muted]) if (e.name) rememberName(e.profileId, e.name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rememberName]);
}

function PeopleList({ kind }: { kind: 'blocked' | 'muted' }) {
  const ids = useGameStore((s) => s[kind]);
  const players = useGameStore((s) => s.players);
  const names = useSocialUi((s) => s.names);
  if (!ids.length) return <p className="muted small">{kind === 'blocked' ? 'You haven’t blocked anyone.' : 'You haven’t muted anyone.'}</p>;
  return (
    <ul className="people" data-testid={`list-${kind}`}>
      {ids.map((pid) => {
        const online = Object.values(players).find((p) => p.profileId === pid);
        const name = online?.name ?? names[pid] ?? 'Someone';
        return (
          <li key={pid} className="people__row">
            <span>
              {name}
              {!online ? <span className="muted"> · not here</span> : null}
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              aria-label={`${kind === 'blocked' ? 'Unblock' : 'Unmute'} ${name}`}
              // By profile id, so it works whether or not they are online.
              onClick={() => net.send(kind === 'blocked' ? C2S.unblock : C2S.unmute, { profileId: pid })}
            >
              {kind === 'blocked' ? 'Unblock' : 'Unmute'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PrivacySection() {
  useRelationNames();
  return (
    <Section title="Privacy & safety" id="set-privacy">
      <h4 className="subhead">Blocked</h4>
      <PeopleList kind="blocked" />
      <h4 className="subhead">Muted</h4>
      <PeopleList kind="muted" />
      <div className="safety">
        <Icon name="shield" size={20} />
        <p>
          Click anyone’s name to open their card, where you can mute, block or report them. Blocking hides both of your messages from each other. Reports go to the island’s
          moderators with the recent chat for context; the person isn’t told who reported them.
        </p>
      </div>
    </Section>
  );
}

export function SettingsPanel({ onClose }: { onClose(): void }) {
  return (
    <Sheet title="Settings" icon="gear" onClose={onClose} testId="panel-settings">
      <AccountSection />
      <SoundSection />
      <DisplaySection />
      <ControlsSection />
      <PrivacySection />
    </Sheet>
  );
}
