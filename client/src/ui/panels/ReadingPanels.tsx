/** Interaction result panels: signs, inspect text, discoveries, mailbox notes. */
import { useEffect, useId, useState } from 'react';
import { CONFIG, getInteractable } from '@elsewhere/shared';
import { actions } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { useSocialUi } from '../localState.js';
import { Empty, Sheet, Spinner } from '../primitives.js';
import { formatRelative } from '../lib/format.js';

export function ReadingPanel({ kind, title, text, onClose }: { kind: 'sign' | 'inspect'; title: string; text: string; onClose(): void }) {
  return (
    <Sheet title={title} eyebrow={kind === 'sign' ? 'A sign reads' : 'You look closer'} size="reading" tone={kind === 'sign' ? 'paper' : 'glass'} onClose={onClose} testId={`panel-${kind}`}>
      <div className="reading">
        {text.split(/\n{2,}/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </Sheet>
  );
}

export function DiscoveryPanel({ name, text, firstTime, onClose }: { name: string; text: string; firstTime: boolean; onClose(): void }) {
  return (
    <Sheet title={name} eyebrow={firstTime ? 'A discovery — your first' : 'A discovery'} icon="sparkle" size="reading" onClose={onClose} testId="panel-discovery" className="sheet--discovery">
      <div className="reading reading--discovery">
        <p>{text}</p>
        {firstTime ? <p className="reading__note">Added to your discoveries.</p> : null}
      </div>
    </Sheet>
  );
}

export function MailboxPanel({ mailboxId, canSend, onClose }: { mailboxId: string; canSend: boolean; onClose(): void }) {
  const box = useSocialUi((s) => s.mail[mailboxId]);
  const [text, setText] = useState('');
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(true);
  const id = useId();
  const myProfile = useGameStore((s) => s.profile?.profileId);
  const def = getInteractable(mailboxId);
  const max = CONFIG.interaction.mailMaxLength;

  useEffect(() => {
    setWaiting(true);
    actions.mailRead(mailboxId);
    const t = setTimeout(() => setWaiting(false), 4000);
    return () => clearTimeout(t);
  }, [mailboxId]);

  useEffect(() => {
    if (box) setWaiting(false);
  }, [box]);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    actions.mailSend(mailboxId, t);
    setText('');
    setSentAt(Date.now());
    setTimeout(() => actions.mailRead(mailboxId), 600);
  };

  const notes = box?.notes ?? [];
  const now = Date.now();

  return (
    <Sheet title={def?.name ?? 'Mailbox'} eyebrow="Notes left here" icon="mail" size="reading" tone="paper" onClose={onClose} testId="panel-mailbox">
      <div className="notes">
        {notes.length ? (
          <ul className="notes__list">
            {notes.map((n) => (
              <li key={n.id} className="note">
                <p className="note__text">{n.text}</p>
                <p className="note__meta">
                  — {n.fromProfileId === myProfile ? 'you' : n.fromName}, {formatRelative(n.ts, now)}
                </p>
              </li>
            ))}
          </ul>
        ) : waiting ? (
          <div className="center-pad">
            <Spinner label="Opening the mailbox" />
          </div>
        ) : (
          <Empty icon="mail" title={box ? 'No notes yet' : 'This mailbox isn’t answering'}>
            {box ? 'Be the first to leave one.' : 'Reading notes may not be available on this server yet.'}
          </Empty>
        )}
        {canSend ? (
          <form className="notes__form" onSubmit={send}>
            <label htmlFor={id} className="field__label">
              Leave a note
            </label>
            <textarea id={id} className="input input--area" rows={3} maxLength={max} value={text} onChange={(e) => setText(e.target.value)} placeholder="Something kind, curious or true…" />
            <div className="notes__row">
              <small className="field__hint">
                {sentAt ? 'Sent. It may take a moment to appear.' : `Notes are public to anyone who opens this mailbox. ${text.length}/${max}`}
              </small>
              <button type="submit" className="btn btn--primary btn--sm" disabled={!text.trim()}>
                Leave note
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </Sheet>
  );
}
