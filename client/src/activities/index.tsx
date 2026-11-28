/**
 * Building activities on the client (rules: shared/src/activities.ts; server:
 * server/src/activities). Public surface:
 *  - <ActivityLayer />: inside the Canvas — keepers, live interior dressing,
 *    the outdoor changes; installs activity sounds + the debug section.
 *  - ActivityPanel / DrinkChip: HUD (ui/Hud.tsx).
 *  - installActivityClient(): interaction results → panels / notices.
 */
import { useEffect } from 'react';
import { ACTIVITY_KEYS, INTERIORS, KEEPERS, S2C, getInteractable, getStation } from '@elsewhere/shared';
import { net, registerDebugSection } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { IndoorActivities } from './Indoor.js';
import { Keepers } from './Keepers.js';
import { boardEntries, netsData, pollData, projectData } from './model.js';
import { OutdoorActivities, outdoorRendered } from './Outdoor.js';
import { activitySoundStats, installActivitySounds } from './sound.js';

export { DrinkChip } from './Panels.js';
export { insideCount, isOpen, liveStationLabel } from './model.js';

let debugInstalled = false;
function installDebug(): void {
  if (debugInstalled) return;
  debugInstalled = true;
  registerDebugSection('activities', () => {
    const g = useGameStore.getState();
    const a = g.activities;
    const keepers: Record<string, unknown> = {};
    for (const k of KEEPERS) {
      const info = g.keepers[k.id];
      const r = runtime.keepers.get(k.id);
      keepers[k.id] = { present: !!info?.present, task: info?.task ?? '', anim: info?.anim ?? '', x: r?.x ?? null, z: r?.z ?? null, drawn: !!r?.render?.visible };
    }
    const poll = pollData(a[ACTIVITY_KEYS.poll]);
    const project = projectData(a[ACTIVITY_KEYS.project]);
    const presence: Record<string, number> = {};
    const open: Record<string, boolean> = {};
    for (const it of INTERIORS) {
      const b = a[ACTIVITY_KEYS.building(it.id)];
      if (b) {
        presence[it.id] = b.value;
        open[it.id] = b.active;
      }
    }
    return {
      keepers,
      presence,
      open,
      poll: { key: poll.key, question: poll.question, tallies: poll.tallies, last: poll.last ?? null },
      notices: boardEntries(a[ACTIVITY_KEYS.board('hall_notices')]).map((e) => ({ id: e.id, author: e.a, text: e.t })),
      guestbooks: Object.fromEntries(['book_house_1', 'book_house_2', 'book_boathouse'].map((b) => [b, boardEntries(a[ACTIVITY_KEYS.board(b)]).map((e) => ({ id: e.id, author: e.a, text: e.t }))])),
      project,
      outdoor: [...outdoorRendered],
      hearths: Object.fromEntries(['house_1', 'house_2'].map((h) => [h, { active: !!a[ACTIVITY_KEYS.hearth(h)]?.active, until: a[ACTIVITY_KEYS.hearth(h)]?.value ?? 0 }])),
      stage: a[ACTIVITY_KEYS.stage]?.holder ?? '',
      lectern: a[ACTIVITY_KEYS.lectern]?.holder ?? '',
      nets: { mended: a[ACTIVITY_KEYS.nets]?.value ?? 0, ...netsData(a[ACTIVITY_KEYS.nets]) },
      sound: { ...activitySoundStats },
      held: Object.fromEntries(Object.values(g.players).map((p) => [p.id, p.held])),
      online: Object.keys(g.players).length,
      panel: (() => {
        const p = useUiStore.getState().panel;
        return p?.kind === 'activity' ? p.station : null;
      })(),
    };
  });
}

/** Interaction / activity results → panels and gentle notices (call once, returns cleanup). */
export function installActivityClient(): () => void {
  installDebug();
  // Dev only (screenshots): ?panel=<station or keeper id> opens that activity panel once joined.
  const devPanel = import.meta.env.DEV ? new URLSearchParams(location.search).get('panel') : null;
  const offs = [
    net.onLifecycle((e) => {
      if (e === 'joined' && devPanel && getInteractable(devPanel)) setTimeout(() => useUiStore.getState().openPanel({ kind: 'activity', station: devPanel }), 1500);
    }),
    net.on(S2C.activityResult, (r) => {
      const ui = useUiStore.getState();
      const open = ui.panel?.kind === 'activity' ? ui.panel.station : null;
      // Panels show their own results inline; elsewhere (e.g. sipping from the HUD chip) say it briefly.
      if (r.action === 'status' || (open && (open === r.station || getStation(open)?.kind === getStation(r.station)?.kind))) return;
      if (r.message && (!r.ok || r.station === 'drink')) ui.notify(r.ok ? 'info' : 'warning', r.message, 2600);
    }),
    net.on(S2C.activityEvent, (e) => {
      if (e.kind === 'drink_done' && e.by === useGameStore.getState().sessionId) useUiStore.getState().notify('info', String(e.data?.message ?? 'Your cup is empty.'), 2600);
    }),
  ];
  return () => offs.forEach((o) => o());
}

export function ActivityLayer() {
  useEffect(() => {
    installDebug();
    return installActivitySounds();
  }, []);
  return (
    <group name="activities">
      <Keepers />
      <IndoorActivities />
      <OutdoorActivities />
    </group>
  );
}
