/**
 * Local player controller.
 *  - Camera-relative input → desired velocity; exponential acceleration /
 *    deceleration; smooth turning toward travel direction.
 *  - Walk by default; run with Shift (inverted by settings.runByDefault),
 *    near-full joystick deflection, or automatically for long click paths.
 *  - Click/tap paths (navigation.ts) are followed when no direct input;
 *    any keyboard/joystick input cancels the path and recentres a free camera.
 *  - Prediction uses the SAME shared resolveMovement the server validates
 *    with (slides along obstacles, follows groundHeight).
 *  - Server corrections are re-based onto the predicted position using the
 *    sent-move history, then blended visually (snap only when far off).
 *  - Seats: smooth blend into the seat pose (seat yaw, seat height) while
 *    the synced `seat` is set; moving / Space asks the server to stand.
 * Sends C2S.move at CONFIG.movement.sendRateHz while the pose changes.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import type { Group } from 'three';
import {
  C2S,
  CONFIG,
  S2C,
  angleDelta,
  getSeat,
  groundHeight,
  isWalkable,
  resolveMovement,
  type AnimState,
  type LocomotionAnim,
} from '@elsewhere/shared';
import { Character } from '../characters/index.js';
import { net, registerDebugSection } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { useUiStore } from '../state/uiStore.js';
import { cameraControls, useCameraStore } from './camera.js';
import { sampleInput, screenToWorld } from './input.js';
import { interactNow, requestStand } from './interaction.js';
import { cancelPath, nav, walkTo } from './navigation.js';

const SEND_INTERVAL = 1 / CONFIG.movement.sendRateHz;
const WALK = CONFIG.movement.walkSpeed;
const RUN = CONFIG.movement.runSpeed;
/** Acceleration / deceleration rates (1/s, exponential approach). */
const ACCEL = 9;
const DECEL = 11;
/** Rotation smoothing rate (1/s). */
const TURN = CONFIG.movement.turnSpeed;
/** Corrections bigger than this snap instead of blending. */
const SNAP_DISTANCE = 4;
/** Visual correction blend rate (1/s). */
const BLEND = 9;
const RUN_THRESHOLD = (WALK + RUN) / 2;

/** Controller internals (module-level, allocation-free per frame). */
const motion = {
  vx: 0,
  vz: 0,
  /** Visual offset from the logical position (decays to 0). */
  ox: 0,
  oz: 0,
  /** Rendered root height (smoothed: seats, steps). */
  ry: 0,
  ryInit: false,
  sendAcc: 0,
  forceSend: false,
  lastSentX: NaN,
  lastSentZ: NaN,
  lastSentAnim: 'idle' as LocomotionAnim,
  lastSentRot: 0,
  /** Seat we are blending into ('' = none). */
  seatRef: '',
  /** Stuck detection for path following. */
  stuckT: 0,
  stuckX: 0,
  stuckZ: 0,
  replans: 0,
  pathVersion: -1,
  frozen: false,
};

/** Recent sent moves (seq → predicted position) for correction re-basing. */
const HISTORY = 64;
const histSeq = new Int32Array(HISTORY).fill(-1);
const histX = new Float32Array(HISTORY);
const histZ = new Float32Array(HISTORY);

function resetMotion(): void {
  motion.vx = motion.vz = motion.ox = motion.oz = 0;
  motion.ryInit = false;
  motion.sendAcc = 0;
  motion.forceSend = true;
  motion.lastSentX = motion.lastSentZ = NaN;
  motion.seatRef = '';
  histSeq.fill(-1);
  cancelPath();
}

function applyCorrection(c: { x: number; z: number; y: number; seq: number; reason: string }): void {
  const lp = runtime.localPlayer;
  if (!lp.ready) return;
  if (c.reason === 'seated') return; // pose is driven by the seat while seated
  let tx = c.x;
  let tz = c.z;
  const slot = c.seq % HISTORY;
  if (c.reason !== 'teleport' && histSeq[slot] === c.seq) {
    // Re-base: keep the movement predicted since that seq, shifted by the server's delta,
    // and re-run it through collision from the authoritative point.
    const rebased = resolveMovement({ x: c.x, z: c.z }, { x: lp.x + (c.x - histX[slot]!), z: lp.z + (c.z - histZ[slot]!) });
    tx = rebased.x;
    tz = rebased.z;
  }
  const err = Math.hypot(tx - lp.x, tz - lp.z);
  if (err > SNAP_DISTANCE) {
    motion.ox = motion.oz = 0;
    motion.ryInit = false;
  } else {
    motion.ox += lp.x - tx;
    motion.oz += lp.z - tz;
  }
  lp.x = tx;
  lp.z = tz;
  lp.y = groundHeight(tx, tz);
  if (c.reason === 'teleport' || err > SNAP_DISTANCE) {
    motion.vx = motion.vz = 0;
    if (err > SNAP_DISTANCE) cancelPath();
  }
  // Make sure the server hears our (re-based) position promptly.
  motion.forceSend = true;
}

function locomotionFor(speed: number, prev: LocomotionAnim): LocomotionAnim {
  // Hysteresis so the anim doesn't flicker at thresholds.
  if (prev === 'idle') return speed > 0.35 ? (speed > RUN_THRESHOLD ? 'run' : 'walk') : 'idle';
  if (speed < 0.2) return 'idle';
  if (prev === 'run') return speed < RUN_THRESHOLD - 0.4 ? 'walk' : 'run';
  return speed > RUN_THRESHOLD + 0.2 ? 'run' : 'walk';
}

const ONE_SHOTS: readonly AnimState[] = ['wave', 'dance', 'interact'];

export function LocalPlayer() {
  const sessionId = useGameStore((s) => s.sessionId);
  const me = useGameStore((s) => (s.sessionId ? s.players[s.sessionId] : undefined));
  const group = useRef<Group>(null);
  const [anim, setAnim] = useState<AnimState>('idle');
  const animRef = useRef<AnimState>('idle');

  useEffect(() => {
    const offs = [
      net.on(S2C.correction, applyCorrection),
      net.onLifecycle((e) => {
        if (e === 'joined') resetMotion();
        if (e === 'resumed') motion.forceSend = true;
      }),
    ];
    const vis = () => {
      if (document.visibilityState === 'visible') {
        // Resync once on return instead of replaying anything.
        motion.sendAcc = 0;
        motion.forceSend = true;
      } else {
        motion.vx = motion.vz = 0;
      }
    };
    document.addEventListener('visibilitychange', vis);
    registerDebugSection('motion', () => ({
      vx: motion.vx,
      vz: motion.vz,
      offset: Math.hypot(motion.ox, motion.oz),
      seat: motion.seatRef,
      path: nav.goal ? { goal: nav.goal, exact: nav.exact, remaining: nav.points.length - nav.index, run: nav.run, points: nav.points.slice(nav.index) } : null,
    }));
    return () => {
      for (const o of offs) o();
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  useFrame((_, rawDt) => {
    const lp = runtime.localPlayer;
    const g = group.current;
    if (!lp.ready || !sessionId) {
      if (g) g.visible = lp.ready;
      return;
    }
    const dt = Math.min(rawDt, 0.1);
    const game = useGameStore.getState();
    const info = game.players[sessionId];
    const live = game.connection === 'connected';
    const seatRef = info?.seat ?? '';
    const seat = seatRef ? getSeat(seatRef) : null;
    const input = sampleInput();
    const mag = Math.hypot(input.moveX, input.moveY);
    const manual = mag > 0.08;

    if (manual) {
      if (nav.goal) cancelPath();
      if (useCameraStore.getState().free) cameraControls.recenter();
      if (useUiStore.getState().playerMenu) useUiStore.getState().closePlayerMenu();
    }

    // --- Seat handling -----------------------------------------------------
    if (seatRef !== motion.seatRef) {
      const prevSeat = motion.seatRef ? getSeat(motion.seatRef) : null;
      motion.seatRef = seatRef;
      if (seat) {
        // Blend from where we are into the seat (server teleported us there).
        motion.ox += lp.x - seat.position.x;
        motion.oz += lp.z - seat.position.z;
        lp.x = seat.position.x;
        lp.z = seat.position.z;
        motion.vx = motion.vz = 0;
        cancelPath();
      } else if (prevSeat && isWalkable(prevSeat.exit)) {
        // Stood up: step out to the seat's exit point (server teleports there too).
        motion.ox += lp.x - prevSeat.exit.x;
        motion.oz += lp.z - prevSeat.exit.z;
        lp.x = prevSeat.exit.x;
        lp.z = prevSeat.exit.z;
        motion.forceSend = true;
      }
    }

    let desiredX = 0;
    let desiredZ = 0;
    let running = false;
    if (seat) {
      if (manual || nav.goal) requestStand();
      lp.x = seat.position.x;
      lp.z = seat.position.z;
    } else if (!live) {
      // Reconnecting: hold still (no stale moves).
    } else if (manual) {
      const dir = screenToWorld(input.moveX / mag, input.moveY / mag);
      const runDefault = useSettingsStore.getState().controls.runByDefault;
      running = input.source === 'touch' ? mag > 0.92 || (runDefault && mag > 0.6) : runDefault ? !input.run : input.run;
      const analog = input.source === 'touch' ? Math.min(1, mag / 0.85) : 1;
      const speed = running ? RUN : WALK * Math.max(0.35, analog);
      desiredX = dir.x * speed;
      desiredZ = dir.z * speed;
    } else if (nav.goal) {
      // Follow the path.
      if (nav.version !== motion.pathVersion) {
        motion.pathVersion = nav.version;
        motion.stuckT = 0;
        motion.stuckX = lp.x;
        motion.stuckZ = lp.z;
        motion.replans = 0;
      }
      const near = nav.arriveNear;
      if (near && Math.hypot(near.x - lp.x, near.z - lp.z) <= nav.arriveRadius) {
        arrive();
      } else {
        let wp = nav.points[nav.index];
        while (wp) {
          const last = nav.index === nav.points.length - 1;
          const d = Math.hypot(wp.x - lp.x, wp.z - lp.z);
          if (d > (last ? 0.12 : 0.45)) break;
          nav.index++;
          wp = nav.points[nav.index];
        }
        if (!wp) {
          arrive();
        } else {
          const dx = wp.x - lp.x;
          const dz = wp.z - lp.z;
          const d = Math.hypot(dx, dz);
          running = nav.run;
          let speed = running ? RUN : WALK;
          // Ease into the final point.
          const toGoal = Math.hypot(nav.goal.x - lp.x, nav.goal.z - lp.z);
          if (nav.index === nav.points.length - 1) speed *= Math.min(1, Math.max(0.3, toGoal / (running ? 2.2 : 1.2)));
          desiredX = (dx / d) * speed;
          desiredZ = (dz / d) * speed;
          // Stuck detection: replan once, then give up.
          motion.stuckT += dt;
          if (motion.stuckT > 0.7) {
            const moved = Math.hypot(lp.x - motion.stuckX, lp.z - motion.stuckZ);
            motion.stuckT = 0;
            motion.stuckX = lp.x;
            motion.stuckZ = lp.z;
            if (moved < 0.25) {
              if (motion.replans++ < 1 && nav.goal) {
                const goal = nav.goal;
                const opts = { onArrive: nav.onArrive, run: nav.run, arriveRadius: nav.arriveRadius, ...(nav.arriveNear ? { arriveNear: nav.arriveNear } : {}) };
                if (!walkTo(goal, opts)) cancelPath();
                motion.pathVersion = nav.version;
              } else {
                cancelPath();
              }
            }
          }
        }
      }
    }

    // --- Integrate ----------------------------------------------------------
    if (!seat) {
      const wantFaster = desiredX * desiredX + desiredZ * desiredZ > motion.vx * motion.vx + motion.vz * motion.vz;
      const k = 1 - Math.exp(-dt * (wantFaster ? ACCEL : DECEL));
      motion.vx += (desiredX - motion.vx) * k;
      motion.vz += (desiredZ - motion.vz) * k;
      if (desiredX === 0 && desiredZ === 0 && motion.vx * motion.vx + motion.vz * motion.vz < 0.0025) motion.vx = motion.vz = 0;
      if (motion.vx !== 0 || motion.vz !== 0) {
        const next = resolveMovement({ x: lp.x, z: lp.z }, { x: lp.x + motion.vx * dt, z: lp.z + motion.vz * dt });
        // Velocity becomes what actually happened (sliding along walls loses the blocked component).
        if (dt > 0) {
          motion.vx = (next.x - lp.x) / dt;
          motion.vz = (next.z - lp.z) / dt;
        }
        lp.x = next.x;
        lp.z = next.z;
      }
    } else {
      motion.vx = motion.vz = 0;
    }
    const speed = Math.hypot(motion.vx, motion.vz);
    lp.vx = motion.vx;
    lp.vz = motion.vz;
    lp.speed = speed;

    // Facing.
    if (seat) {
      lp.rot += angleDelta(lp.rot, seat.yaw) * (1 - Math.exp(-dt * 8));
    } else if (speed > 0.15) {
      const targetYaw = Math.atan2(motion.vx, motion.vz);
      lp.rot += angleDelta(lp.rot, targetYaw) * (1 - Math.exp(-dt * TURN));
    }
    lp.anim = seat ? 'idle' : locomotionFor(speed, lp.anim);
    const ground = groundHeight(lp.x, lp.z);
    lp.y = ground;

    // --- Network ------------------------------------------------------------
    motion.sendAcc += dt;
    if (live && !seat) {
      const changed = lp.x !== motion.lastSentX || lp.z !== motion.lastSentZ || lp.anim !== motion.lastSentAnim || Math.abs(angleDelta(lp.rot, motion.lastSentRot)) > 0.15;
      if ((changed && motion.sendAcc >= SEND_INTERVAL) || motion.forceSend) {
        motion.sendAcc = 0;
        lp.seq += 1;
        if (net.send(C2S.move, { x: lp.x, z: lp.z, rot: lp.rot, anim: lp.anim, seq: lp.seq })) {
          const slot = lp.seq % HISTORY;
          histSeq[slot] = lp.seq;
          histX[slot] = lp.x;
          histZ[slot] = lp.z;
          motion.lastSentX = lp.x;
          motion.lastSentZ = lp.z;
          motion.lastSentAnim = lp.anim;
          motion.lastSentRot = lp.rot;
          motion.forceSend = false;
        }
      }
    }

    // --- Render -------------------------------------------------------------
    const bk = Math.exp(-dt * BLEND);
    motion.ox *= bk;
    motion.oz *= bk;
    if (Math.abs(motion.ox) < 1e-4) motion.ox = 0;
    if (Math.abs(motion.oz) < 1e-4) motion.oz = 0;
    const targetY = seat ? ground + seat.height : ground;
    if (!motion.ryInit) {
      motion.ry = targetY;
      motion.ryInit = true;
    }
    // Follow the terrain tightly while walking, ease into / out of seats.
    motion.ry += (targetY - motion.ry) * (1 - Math.exp(-dt * (seat || Math.abs(targetY - motion.ry) > 0.25 ? 10 : 30)));
    if (g) {
      g.visible = true;
      g.position.set(lp.x + motion.ox, motion.ry, lp.z + motion.oz);
      g.rotation.y = lp.rot;
    }

    // Display anim: seat › moving › server one-shot (wave/dance) › idle.
    const serverAnim = info?.anim ?? 'idle';
    const display: AnimState = seat ? 'sit' : speed > 0.3 ? lp.anim : ONE_SHOTS.includes(serverAnim) ? serverAnim : lp.anim;
    if (display !== animRef.current) {
      animRef.current = display;
      setAnim(display);
    }
  });

  if (!me) return null;
  return (
    <group ref={group} name="local-player">
      <Character appearance={me.appearance} anim={anim} animSeq={me.animSeq} held={me.held} />
    </group>
  );
}

function arrive(): void {
  const action = nav.onArrive;
  cancelPath();
  if (!action) return;
  if (action.kind === 'interact') interactNow(action.id);
  else useUiStore.getState().openPlayerMenu(action.sessionId, 'pointer');
}
