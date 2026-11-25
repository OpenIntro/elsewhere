/**
 * <AudioDirector /> — renders nothing; drives the whole soundscape by itself.
 * Mounted once in App. Subscribes to stores, runtime and `net.on` events so no
 * other system has to call audio directly.
 *
 *  - unlock on first pointer/key/touch gesture
 *  - listener = local player (or camera focus in free-camera mode), camera yaw from runtime.view
 *  - world clock + location → ambience mix + music mood
 *  - footsteps for the local player and up to 3 nearby remotes, surface-aware
 *  - server events (objectEvent, worldEvent, discovery, chat, emote/reaction, mail)
 *  - UI: panel open/close, soft button clicks, local seat changes
 */
import { useEffect } from 'react';
import { LOCATIONS, S2C, getInteractable, locationAt, worldTimeAt, type ObjectEvent, type Vec3 } from '@elsewhere/shared';
import { net, sampleRemote } from '../net/index.js';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { runtime, type Pose } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { audio } from './AudioManager.js';
import { moodFor } from './musicPlan.js';
import { DEFAULT_CAMERA_YAW } from './spatial.js';
import { advanceSteps, type StepTracker } from './footsteps.js';
import { surfaceAt } from './surface.js';

const UNKNOWN = LOCATIONS.find((l) => l.id === 'the_unknown')!.center;

function cameraYaw(): number {
  const v = (runtime as { view?: { yaw?: number } }).view;
  return typeof v?.yaw === 'number' && Number.isFinite(v.yaw) ? v.yaw : DEFAULT_CAMERA_YAW;
}

function objectPosition(id: string): Vec3 | undefined {
  const i = getInteractable(id);
  return i ? { x: i.position.x, y: 0, z: i.position.z } : undefined;
}

function remotePosition(sessionId: string): Vec3 | undefined {
  const pose: Pose = { x: 0, y: 0, z: 0, rot: 0 };
  return sampleRemote(sessionId, pose) ? { x: pose.x, y: pose.y, z: pose.z } : undefined;
}

export function AudioDirector(): null {
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    audio.resumeSystems();

    // --- Unlock on first gesture (idempotent; App may also call unlock). ----
    const unlock = () => audio.unlock();
    const gestureOpts = { capture: true, passive: true } as const;
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, unlock, gestureOpts);
    unsubs.push(() => {
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.removeEventListener(ev, unlock, gestureOpts);
    });

    // --- Soft UI click on buttons. -------------------------------------------
    const onClick = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target.closest('button, [role="button"], a[href], input[type="checkbox"], input[type="range"], select') : null;
      if (el && !(el as HTMLButtonElement).disabled) audio.playSfx('ui_click');
    };
    document.addEventListener('click', onClick, true);
    unsubs.push(() => document.removeEventListener('click', onClick, true));

    // --- Per-frame: listener + footsteps; every 0.5 s: environment. ----------
    const local: StepTracker = { x: 0, z: 0, phase: 0, init: false };
    const remotes = new Map<string, StepTracker>();
    const pose: Pose = { x: 0, y: 0, z: 0, rot: 0 };
    let last = performance.now();
    let envAt = 0;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const lp = runtime.localPlayer;
      const view = (runtime as { view?: { free?: boolean; focusX?: number; focusZ?: number } }).view;
      const game = useGameStore.getState();
      const sid = game.sessionId;
      if (lp.ready) {
        const lx = view?.free && typeof view.focusX === 'number' ? view.focusX : lp.x;
        const lz = view?.free && typeof view.focusZ === 'number' ? view.focusZ : lp.z;
        audio.setListener({ x: lx, y: lp.y, z: lz }, cameraYaw());
        const seated = !!(sid && game.players[sid]?.seat);
        if (!seated && advanceSteps(local, lp.x, lp.z, dt, typeof lp.speed === 'number' ? lp.speed : undefined))
          audio.playSfx('footstep', { x: lp.x, y: lp.y, z: lp.z }, { surface: surfaceAt(lp.x, lp.z) });
        if (seated) local.init = false;

        // Nearby remotes (3 nearest within 14 m) get quiet footsteps.
        const near: { id: string; d: number; x: number; y: number; z: number }[] = [];
        for (const id of runtime.remotes.keys()) {
          if (id === sid) continue;
          if (!sampleRemote(id, pose, now)) continue;
          const d = Math.hypot(pose.x - lp.x, pose.z - lp.z);
          if (d < 14) near.push({ id, d, x: pose.x, y: pose.y, z: pose.z });
        }
        near.sort((a, b) => a.d - b.d);
        const chosenList = near.slice(0, 3);
        const chosen = new Set(chosenList.map((n) => n.id));
        for (const id of [...remotes.keys()]) if (!chosen.has(id)) remotes.delete(id);
        for (const { id, x, y, z } of chosenList) {
          let tr = remotes.get(id);
          if (!tr) remotes.set(id, (tr = { x: 0, z: 0, phase: 0, init: false }));
          const r = runtime.remotes.get(id);
          const spd = r?.render && r.render.visible ? r.render.speed : undefined;
          const seated = !!game.players[id]?.seat;
          if (!seated && advanceSteps(tr, x, z, dt, spd)) audio.playSfx('footstep', { x, y, z }, { surface: surfaceAt(x, z), gain: 0.45, category: 'remote_step' });
        }
      }
      if (now - envAt > 500) {
        envAt = now;
        const clock = game.clock;
        const wt = worldTimeAt(serverNow(), { epochMs: clock.epochMs, dayLengthMs: clock.dayLengthMs });
        const portalAwake = game.world.portalAwake || !!game.objects['portal_arch']?.active;
        audio.setEnvironment({ hours: wt.hours, portalAwake });
        const px = lp.ready ? lp.x : 0;
        const pz = lp.ready ? lp.z : 2;
        audio.setAmbience(locationAt({ x: px, z: pz })?.ambience ?? null);
        const playing = useUiStore.getState().phase === 'playing' || lp.ready;
        audio.playMusic(playing ? moodFor(wt.hours, Math.hypot(px - UNKNOWN.x, pz - UNKNOWN.z)) : 'none');
      }
    };
    raf = requestAnimationFrame(frame);
    unsubs.push(() => cancelAnimationFrame(raf));

    // --- Server events. ------------------------------------------------------
    const bellRingers: { by: string; t: number }[] = [];
    let lastChorus = 0;
    let lastPortalSound = 0;
    let lastChatBlip = 0;
    let lastReaction = 0;
    const onObject = (e: ObjectEvent) => {
      const pos = objectPosition(e.id);
      const kind = e.kind as string;
      switch (kind) {
        case 'bell_rung':
        case 'bell_midnight': {
          const now = performance.now();
          bellRingers.push({ by: e.by, t: now });
          while (bellRingers.length && now - bellRingers[0]!.t > 6000) bellRingers.shift();
          const distinct = new Set(bellRingers.map((b) => b.by)).size;
          if (distinct >= 3 && now - lastChorus > 10_000) {
            lastChorus = now;
            audio.playSfx('bell_chorus', pos);
          } else audio.playSfx('bell', pos);
          break;
        }
        case 'bell_chorus':
          lastChorus = performance.now();
          audio.playSfx('bell_chorus', pos);
          break;
        case 'door_opened':
          audio.playSfx('door_open', pos);
          break;
        case 'door_closed':
          audio.playSfx('door_close', pos);
          break;
        case 'light_on':
        case 'light_off':
          audio.playSfx('light_toggle', pos);
          break;
        case 'picked_up':
          audio.playSfx('pickup', pos);
          break;
        case 'dropped':
          audio.playSfx('drop', pos);
          break;
        case 'fountain_ripple':
          audio.playSfx('splash', pos);
          break;
        case 'fountain_stage':
          audio.playSfx('fountain_stage', pos);
          break;
        case 'rune_lit':
          audio.playSfx('rune', pos);
          break;
        case 'rune_faded':
          audio.playSfx('rune_fade', pos);
          break;
        case 'portal_awake':
          lastPortalSound = performance.now();
          audio.playSfx('portal_wake', pos);
          break;
        case 'portal_sleep':
          lastPortalSound = performance.now();
          audio.playSfx('portal_sleep', pos);
          break;
      }
    };
    unsubs.push(net.on(S2C.objectEvent, onObject));
    unsubs.push(net.on(S2C.worldEvent, () => audio.playSfx('world_shimmer')));
    unsubs.push(net.on(S2C.discovery, () => audio.playSfx('discovery')));
    unsubs.push(net.on(S2C.mail, () => audio.playSfx('notification')));
    unsubs.push(
      net.on(S2C.chat, (m) => {
        const game = useGameStore.getState();
        if (!m || m.from === game.sessionId) return;
        const myName = game.profile?.name?.toLowerCase();
        if (myName && Array.isArray(m.mentions) && m.mentions.includes(myName)) {
          audio.playSfx('mention');
          return;
        }
        const now = performance.now();
        if (now - lastChatBlip < 1500) return;
        if (m.channel === 'private') {
          lastChatBlip = now;
          audio.playSfx('notification');
        } else if (m.channel === 'proximity') {
          const pos = remotePosition(m.from);
          if (!pos) return;
          lastChatBlip = now;
          audio.playSfx('chat_message', pos);
        }
      }),
    );
    const onReaction = (sessionId: string) => {
      const now = performance.now();
      if (now - lastReaction < 800) return;
      const pos = sessionId === useGameStore.getState().sessionId ? undefined : remotePosition(sessionId);
      if (sessionId !== useGameStore.getState().sessionId && !pos) return;
      lastReaction = now;
      audio.playSfx('reaction', pos);
    };
    unsubs.push(net.on(S2C.reaction, (r) => onReaction(r.sessionId)));

    // --- Store-driven cues. --------------------------------------------------
    unsubs.push(
      useUiStore.subscribe((s, prev) => {
        if (s.panel && !prev.panel) audio.playSfx('ui_open');
        else if (!s.panel && prev.panel) audio.playSfx('ui_close');
        if (s.notifications.length > prev.notifications.length) {
          const n = s.notifications[s.notifications.length - 1];
          if (n && (n.level === 'success' || n.level === 'warning')) audio.playSfx('notification');
        }
      }),
    );
    unsubs.push(
      useGameStore.subscribe((s, prev) => {
        // Local seat change → sit sound; nearby remotes sitting → quiet.
        if (s.players !== prev.players) {
          for (const [id, p] of Object.entries(s.players)) {
            const before = prev.players[id];
            if (!before || before.seat === p.seat || !p.seat) continue;
            if (id === s.sessionId) audio.playSfx('sit');
            else {
              const pos = remotePosition(id);
              if (pos) audio.playSfx('sit', pos, { gain: 0.5 });
            }
          }
        }
        // Collective changes (fallback when no explicit event arrives).
        if (s.world.fountainStage > prev.world.fountainStage) audio.playSfx('fountain_stage', objectPosition('fountain'));
        const awake = s.world.portalAwake || !!s.objects['portal_arch']?.active;
        const wasAwake = prev.world.portalAwake || !!prev.objects['portal_arch']?.active;
        if (awake !== wasAwake && performance.now() - lastPortalSound > 3000 && s.connection === 'connected' && prev.connection === 'connected') {
          lastPortalSound = performance.now();
          audio.playSfx(awake ? 'portal_wake' : 'portal_sleep', objectPosition('portal_arch'));
        }
      }),
    );

    return () => {
      for (const u of unsubs) u();
      audio.stopAll();
    };
  }, []);
  return null;
}
