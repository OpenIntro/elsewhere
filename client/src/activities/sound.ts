/**
 * Activity sounds through the procedural audio system (audio.playSfx):
 * piano notes, cups, saw / anvil / kiln, hearth, kettle, pins, pages, ballots,
 * nets. Positional; a wall between the source and the listener muffles it
 * (duller + quieter), matching the indoor ambience muffling. Volume follows
 * the sfx channel / master settings like every other effect.
 */
import { S2C, getInteractable, groundHeight, spaceAt, type ActivityEvent } from '@elsewhere/shared';
import { audio, type SfxName } from '../audio/index.js';
import { net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';

/** Counters for tests / the debug snapshot (how many notes this client actually played). */
export const activitySoundStats = { pianoNotes: 0, events: 0 };

function muffleFor(x: number, z: number): number {
  const lp = runtime.localPlayer;
  if (!lp.ready) return 0;
  return spaceAt({ x: lp.x, z: lp.z }) === spaceAt({ x, z }) ? 0 : 1;
}

function play(name: SfxName, x: number, z: number, extra: { note?: number; gain?: number } = {}): void {
  audio.playSfx(name, { x, y: groundHeight(x, z) + 1, z }, { muffle: muffleFor(x, z), ...extra });
}

const EVENT_SOUND: Partial<Record<ActivityEvent['kind'], SfxName>> = {
  cup: 'cup',
  sip: 'cup',
  kettle_on: 'kettle',
  kettle_whistle: 'kettle_whistle',
  hearth_lit: 'hearth',
  pin: 'pin',
  sign: 'page',
  vote: 'ballot',
  mend: 'net',
  take: 'page',
};

export function installActivitySounds(): () => void {
  const offs = [
    net.on(S2C.pianoNote, (e) => {
      const it = getInteractable('station_cafe_piano');
      if (!it) return;
      activitySoundStats.pianoNotes++;
      play('piano', it.position.x, it.position.z, { note: e.note });
    }),
    net.on(S2C.activityEvent, (e) => {
      activitySoundStats.events++;
      if (e.kind === 'tool') {
        const tool = String(e.data?.tool ?? 'hammer');
        play(tool === 'saw' ? 'saw' : tool === 'kiln' ? 'kiln' : 'hammer', e.x, e.z);
        return;
      }
      if (e.kind === 'project_stage' || e.kind === 'project_done') {
        audio.playSfx(e.kind === 'project_done' ? 'fountain_stage' : 'chime');
        return;
      }
      const name = EVENT_SOUND[e.kind];
      if (name) play(name, e.x, e.z, e.kind === 'sip' ? { gain: 0.5 } : {});
      if (e.kind === 'drink_done' && e.by === useGameStore.getState().sessionId) {
        /* the panel/notice layer tells the player; nothing to play */
      }
    }),
  ];
  return () => offs.forEach((o) => o());
}
