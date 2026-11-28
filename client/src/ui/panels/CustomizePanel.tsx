/** In-game appearance + name editing (Settings → Edit character). Sends C2S.updateProfile and waits for the server's answer. */
import { useEffect, useRef, useState } from 'react';
import { C2S, DEFAULT_APPEARANCE, S2C, appearanceEquals, type Appearance } from '@elsewhere/shared';
import { actions, net } from '../../net/index.js';
import { useGameStore } from '../../state/gameStore.js';
import { CustomizationScreen } from '../CustomizationScreen.js';
import { Sheet } from '../primitives.js';
import { toasts } from '../toasts.js';

export function CustomizePanel({ onClose }: { onClose(): void }) {
  const profile = useGameStore((s) => s.profile);
  const me = useGameStore((s) => (s.sessionId ? s.players[s.sessionId] : undefined));
  const initial = me?.appearance ?? profile?.appearance ?? DEFAULT_APPEARANCE;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offs = useRef<(() => void)[]>([]);

  useEffect(() => () => offs.current.forEach((o) => o()), []);

  const save = (appearance: Appearance, name?: string) => {
    const payload: { appearance?: Appearance; name?: string } = {};
    if (!appearanceEquals(appearance, initial)) payload.appearance = appearance;
    if (name && name !== (me?.name ?? profile?.name)) payload.name = name;
    if (!payload.appearance && !payload.name) return onClose();
    setBusy(true);
    setError(null);
    const done = () => {
      offs.current.forEach((o) => o());
      offs.current = [];
    };
    const timer = setTimeout(() => {
      done();
      setBusy(false);
      setError('The server didn’t answer. Try again in a moment.');
    }, 6000);
    offs.current.push(
      () => clearTimeout(timer),
      net.on(S2C.profile, () => {
        done();
        toasts.push({ level: 'success', text: 'Your new look is saved.' });
        onClose();
      }),
      net.on(S2C.error, (e) => {
        if (e.inResponseTo !== C2S.updateProfile) return;
        done();
        setBusy(false);
        setError(e.code === 'invalid_name' ? 'That name isn’t allowed. Try another.' : e.code === 'rate_limited' ? 'Saving too often — wait a few seconds.' : e.message);
      }),
      net.on(S2C.rateLimited, (r) => {
        if (r.action !== 'appearance' && r.action !== C2S.updateProfile) return;
        done();
        setBusy(false);
        setError(`Saving too often — try again in ${Math.ceil(r.retryInMs / 1000)}s.`);
      }),
    );
    actions.updateProfile(payload);
  };

  return (
    <Sheet title="Your character" eyebrow="Edit" icon="user" size="wide" onClose={onClose} testId="panel-customize" className="sheet--customize">
      <CustomizationScreen initial={initial} initialName={me?.name ?? profile?.name ?? ''} showName layout="panel" saveLabel="Save" onSave={save} onCancel={onClose} busy={busy} error={error} />
    </Sheet>
  );
}
