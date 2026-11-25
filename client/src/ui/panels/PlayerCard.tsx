/**
 * Player card: public profile + contextual actions (wave, dance together,
 * greet, whisper, mute, block with confirmation, report with reason + note).
 */
import { useEffect, useId, useState } from 'react';
import { C2S, LOCATIONS, type ReportReason } from '@elsewhere/shared';
import { CharacterPreview } from '../../characters/index.js';
import { net } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { useUiStore } from '../../state/uiStore.js';
import { useChatUi, useSocialUi } from '../localState.js';
import { Icon, type IconName } from '../icons.js';
import { Sheet, Spinner } from '../primitives.js';
import { formatMonthYear } from '../lib/format.js';

export const REPORT_REASONS: Record<ReportReason, string> = {
  harassment: 'Harassment or bullying',
  spam: 'Spam or flooding',
  inappropriate_name: 'Inappropriate name',
  inappropriate_content: 'Inappropriate messages',
  cheating: 'Cheating or exploiting',
  other: 'Something else',
};
const DETAILS_MAX = 300;

function Action({ icon, label, onClick, tone, pressed, testId }: { icon: IconName; label: string; onClick(): void; tone?: 'danger'; pressed?: boolean; testId?: string }) {
  return (
    <button type="button" className={`action${tone ? ` action--${tone}` : ''}${pressed ? ' is-on' : ''}`} onClick={onClick} aria-pressed={pressed} data-testid={testId}>
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

function ReportForm({ sessionId, profileId, name, onBack }: { sessionId: string; profileId: string; name: string; onBack(): void }) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const status = useSocialUi((s) => s.reports[profileId] ?? 'idle');
  const setReport = useSocialUi((s) => s.setReport);
  const id = useId();

  useEffect(() => {
    if (status !== 'sending') return;
    const t = setTimeout(() => {
      if (useSocialUi.getState().reports[profileId] === 'sending') setReport(profileId, 'error');
    }, 8000);
    return () => clearTimeout(t);
  }, [status, profileId, setReport]);

  if (status === 'sent')
    return (
      <div className="report-done" role="status" data-testid="report-sent">
        <Icon name="check" size={26} />
        <p>
          <strong>Report received.</strong> Thank you for looking out for the island. You can also block {name} so you won’t see each other.
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}>
          Back
        </button>
      </div>
    );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason) return;
    // Attach the reported player's recent messages as context (ids only).
    const messageIds = useUiStore
      .getState()
      .chatLog.filter((m) => m.fromProfileId === profileId)
      .slice(-5)
      .map((m) => m.id);
    setReport(profileId, 'sending');
    net.send(C2S.report, { target: sessionId, reason, ...(details.trim() ? { details: details.trim().slice(0, DETAILS_MAX) } : {}), ...(messageIds.length ? { messageIds } : {}) });
  };

  return (
    <form className="report" onSubmit={submit} data-testid="report-form">
      <fieldset className="report__reasons">
        <legend className="field__label">What’s happening?</legend>
        {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => (
          <label key={r} className={`radio${reason === r ? ' is-on' : ''}`}>
            <input type="radio" name={`${id}-r`} value={r} checked={reason === r} onChange={() => setReason(r)} />
            <span>{REPORT_REASONS[r]}</span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-d`}>
          Anything else? <span className="muted">(optional)</span>
        </label>
        <textarea id={`${id}-d`} className="input input--area" rows={3} maxLength={DETAILS_MAX} value={details} onChange={(e) => setDetails(e.target.value)} />
        <small className="field__hint">Their recent messages are included for context.</small>
      </div>
      {status === 'unavailable' ? (
        <p className="form-error" role="alert">
          Reporting isn’t connected on this server yet. Blocking still keeps them away from you.
        </p>
      ) : status === 'error' ? (
        <p className="form-error" role="alert">
          We didn’t hear back from the server. Try again in a moment.
        </p>
      ) : null}
      <div className="confirm__row">
        <button type="button" className="btn btn--quiet btn--sm" onClick={onBack}>
          Cancel
        </button>
        <button type="submit" className="btn btn--danger btn--sm" disabled={!reason || status === 'sending'} data-testid="report-submit">
          {status === 'sending' ? <Spinner /> : 'Send report'}
        </button>
      </div>
    </form>
  );
}

export function PlayerCard({ sessionId, startWithReport = false, onClose }: { sessionId: string; startWithReport?: boolean; onClose(): void }) {
  const player = useGameStore((s) => s.players[sessionId]);
  const myProfile = useGameStore((s) => s.profile);
  const muted = useGameStore((s) => (player ? s.muted.includes(player.profileId) : false));
  const blocked = useGameStore((s) => (player ? s.blocked.includes(player.profileId) : false));
  const [view, setView] = useState<'main' | 'block' | 'report'>(startWithReport ? 'report' : 'main');
  const [lastName, setLastName] = useState(player?.name ?? '');

  useEffect(() => {
    if (player?.name) setLastName(player.name);
  }, [player?.name]);

  if (!player) {
    return (
      <Sheet title={lastName || 'Gone'} eyebrow="Player" icon="user" size="card" onClose={onClose} testId="player-card">
        <p className="muted">{lastName ? `${lastName} has left this world.` : 'This person isn’t here any more.'}</p>
      </Sheet>
    );
  }

  const isMe = player.isLocal;
  const place = LOCATIONS.find((l) => l.id === player.location)?.name;
  const whisper = () => {
    const ui = useUiStore.getState();
    useChatUi.getState().openWhisper(sessionId);
    ui.setChatOpen(true);
    useChatUi.getState().requestFocus();
    onClose();
  };

  return (
    <Sheet
      title={player.name}
      eyebrow={isMe ? 'That’s you' : place ? `At ${place}` : 'Out and about'}
      size="card"
      onClose={onClose}
      onBack={view !== 'main' ? () => setView('main') : undefined}
      testId="player-card"
      className="sheet--player"
    >
      {view === 'main' ? (
        <>
          <div className="pcard">
            <div className="pcard__preview" aria-hidden="true">
              <CharacterPreview appearance={player.appearance} anim={player.anim === 'dance' || player.anim === 'wave' || player.anim === 'sit' ? player.anim : 'idle'} spin={0.3} />
            </div>
            <dl className="pcard__facts">
              {isMe && myProfile ? (
                <>
                  <div>
                    <dt>Resident since</dt>
                    <dd>{formatMonthYear(myProfile.firstVisitAt)}</dd>
                  </div>
                  <div>
                    <dt>Discoveries</dt>
                    <dd>{myProfile.discoveries.length}</dd>
                  </div>
                  <div>
                    <dt>Visits</dt>
                    <dd>{myProfile.visits}</dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt>Status</dt>
                  <dd>{player.typing ? 'Typing…' : player.seat ? 'Sitting' : player.anim === 'dance' ? 'Dancing' : 'Here now'}</dd>
                </div>
              )}
            </dl>
          </div>
          {isMe ? (
            <div className="actions">
              <Action icon="wave" label="Wave" onClick={() => net.send(C2S.emote, { emote: 'wave' })} />
              <Action icon="dance" label="Dance" onClick={() => net.send(C2S.emote, { emote: 'dance' })} />
              <Action icon="user" label="Edit look" onClick={() => useUiStore.getState().openPanel({ kind: 'customize' })} />
            </div>
          ) : (
            <>
              <div className="actions">
                <Action icon="wave" label="Wave" onClick={() => net.send(C2S.emote, { emote: 'wave' })} testId="pc-wave" />
                <Action icon="dance" label="Dance together" onClick={() => net.send(C2S.emote, { emote: 'dance' })} />
                <Action icon="smile" label="Greet" onClick={() => net.send(C2S.reaction, { emoji: '👋', target: sessionId })} />
                <Action icon="whisper" label="Whisper" onClick={whisper} testId="pc-whisper" />
              </div>
              <div className="actions actions--quiet">
                <Action icon="mute" label={muted ? 'Unmute' : 'Mute'} pressed={muted} onClick={() => net.send(muted ? C2S.unmute : C2S.mute, { target: sessionId })} />
                <Action icon="block" label={blocked ? 'Unblock' : 'Block'} pressed={blocked} tone="danger" onClick={() => (blocked ? net.send(C2S.unblock, { target: sessionId }) : setView('block'))} />
                <Action icon="flag" label="Report" tone="danger" onClick={() => setView('report')} testId="pc-report" />
              </div>
            </>
          )}
        </>
      ) : view === 'block' ? (
        <div className="confirm" role="alertdialog" aria-label={`Block ${player.name}?`}>
          <p>
            <strong>Block {player.name}?</strong> You won’t see each other’s messages or whispers. You can undo this in Settings.
          </p>
          <div className="confirm__row">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setView('main')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              data-testid="confirm-block"
              onClick={() => {
                net.send(C2S.block, { target: sessionId });
                setView('main');
              }}
            >
              Block
            </button>
          </div>
        </div>
      ) : (
        <ReportForm sessionId={sessionId} profileId={player.profileId} name={player.name} onBack={() => setView('main')} />
      )}
    </Sheet>
  );
}
