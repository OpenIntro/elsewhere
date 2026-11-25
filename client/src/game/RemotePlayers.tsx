/**
 * Renders every non-local player at its interpolated pose (per-frame via refs).
 *  - Pose from net/ snapshot interpolation (render delay, capped
 *    extrapolation, teleport snap); smoothed rotation.
 *  - Locomotion anim derived from the interpolated speed (matches what you
 *    see, not the 120 ms-early synced anim); server one-shots (wave, dance,
 *    interact) and `sit` come from the synced anim / animSeq.
 *  - Seats: blend into seat pose (seat position at groundHeight + height,
 *    facing seat yaw) and back out.
 *  - Join: scale/rise in. Leave: kept for a moment and scaled/sunk out.
 *  - Publishes the drawn pose in runtime.remotes[id].render (labels,
 *    targeting, picking, audio read it).
 * Shadows only for players near the camera focus (cheap with 50 remotes).
 */
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useRef, useState } from 'react';
import type { Group } from 'three';
import { CONFIG, angleDelta, getSeat, groundHeight, type AnimState } from '@elsewhere/shared';
import { Character } from '../characters/index.js';
import { sampleRemote } from '../net/index.js';
import { useGameStore, type PlayerInfo } from '../state/gameStore.js';
import { runtime, type Pose, type RemoteRenderState } from '../state/runtime.js';
import { useShallow } from 'zustand/react/shallow';

const APPEAR_MS = 380;
const LEAVE_MS = 450;
const SHADOW_RADIUS = 22;
const RUN_THRESHOLD = (CONFIG.movement.walkSpeed + CONFIG.movement.runSpeed) / 2;
const SERVER_ANIMS: readonly AnimState[] = ['sit', 'wave', 'dance', 'interact'];

function easeOutBack(t: number): number {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function locomotion(speed: number, prev: AnimState): AnimState {
  const p = prev === 'walk' || prev === 'run' ? prev : 'idle';
  if (p === 'idle') return speed > 0.45 ? (speed > RUN_THRESHOLD ? 'run' : 'walk') : 'idle';
  if (speed < 0.25) return 'idle';
  if (p === 'run') return speed < RUN_THRESHOLD - 0.5 ? 'walk' : 'run';
  return speed > RUN_THRESHOLD + 0.3 ? 'run' : 'walk';
}

const RemotePlayer = memo(function RemotePlayer({ id, cached, leavingAt }: { id: string; cached: PlayerInfo; leavingAt: number }) {
  const live = useGameStore((s) => s.players[id]) as PlayerInfo | undefined;
  const info = live ?? cached;
  const group = useRef<Group>(null);
  const inner = useRef<Group>(null);
  const sample = useRef<Pose>({ x: 0, y: 0, z: 0, rot: 0 });
  const rs = useRef<RemoteRenderState>({ x: 0, y: 0, z: 0, rot: 0, speed: 0, visible: false });
  const st = useRef({ init: false, teleportSeq: -1, mountedAt: performance.now(), px: 0, pz: 0, seatBlend: 0, shadowCheck: 0, anim: 'idle' as AnimState });
  const infoRef = useRef(info);
  infoRef.current = info;
  const [anim, setAnim] = useState<AnimState>(info.anim === 'sit' ? 'sit' : 'idle');
  const [shadow, setShadow] = useState(true);

  useFrame((_, rawDt) => {
    const g = group.current;
    const ig = inner.current;
    if (!g || !ig) return;
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const s = st.current;
    const r = runtime.remotes.get(id);
    const out = rs.current;
    const cur = infoRef.current;
    const seat = cur.seat ? getSeat(cur.seat) : null;

    const has = r ? sampleRemote(id, sample.current, now) : false;
    if (has) {
      const p = sample.current;
      const snap = !s.init || (r!.teleportSeq ?? 0) !== s.teleportSeq;
      s.teleportSeq = r!.teleportSeq ?? 0;
      // Seat blend factor (eases in/out so sitting down never pops).
      s.seatBlend += ((seat ? 1 : 0) - s.seatBlend) * (1 - Math.exp(-dt * 9));
      if (snap) s.seatBlend = seat ? 1 : 0;
      let tx = p.x;
      let ty = p.y;
      let tz = p.z;
      let trot = p.rot;
      if (seat) {
        const sy = groundHeight(seat.position.x, seat.position.z) + seat.height;
        const b = s.seatBlend;
        tx = p.x + (seat.position.x - p.x) * b;
        tz = p.z + (seat.position.z - p.z) * b;
        ty = p.y + (sy - p.y) * b;
        trot = seat.yaw;
      } else if (s.seatBlend > 0.01) {
        // Standing up: the interpolated pose already moves to the exit point; just ease height.
        ty = p.y;
      }
      if (snap) {
        out.x = tx;
        out.y = ty;
        out.z = tz;
        out.rot = trot;
        out.speed = 0;
        s.px = tx;
        s.pz = tz;
        s.init = true;
      } else {
        out.x = tx;
        out.z = tz;
        out.y += (ty - out.y) * (1 - Math.exp(-dt * 20));
        out.rot += angleDelta(out.rot, trot) * (1 - Math.exp(-dt * CONFIG.movement.turnSpeed));
        const inst = dt > 0 ? Math.hypot(tx - s.px, tz - s.pz) / dt : 0;
        out.speed += (Math.min(inst, 12) - out.speed) * (1 - Math.exp(-dt * 8));
        s.px = tx;
        s.pz = tz;
      }
    } else if (!s.init) {
      out.visible = false;
      g.visible = false;
      return;
    } else {
      // No data (removed / reconnecting): hold, settle to idle.
      out.speed *= Math.exp(-dt * 6);
    }

    // Join / leave transitions.
    const appear = Math.min(1, (now - s.mountedAt) / APPEAR_MS);
    const leave = leavingAt > 0 ? Math.min(1, (now - leavingAt) / LEAVE_MS) : 0;
    const scale = Math.max(0.001, easeOutBack(appear) * (1 - leave * leave));
    out.visible = leave < 1;
    g.visible = out.visible;
    g.position.set(out.x, out.y - 0.25 * (1 - appear) - 0.35 * leave, out.z);
    g.rotation.y = out.rot;
    ig.scale.setScalar(scale);
    if (r) r.render = out;

    // Anim: server one-shots / sit win unless clearly moving.
    const serverAnim = cur.anim;
    let next: AnimState;
    if (seat || serverAnim === 'sit') next = 'sit';
    else if (SERVER_ANIMS.includes(serverAnim) && out.speed < 0.8) next = serverAnim;
    else next = locomotion(out.speed, s.anim);
    if (next !== s.anim) {
      s.anim = next;
      setAnim(next);
    }

    // Shadow budget: only players near the view focus cast shadows.
    if (now - s.shadowCheck > 500) {
      s.shadowCheck = now;
      const v = runtime.view;
      const near = Math.hypot(out.x - v.focusX, out.z - v.focusZ) < SHADOW_RADIUS;
      setShadow((prev) => (prev === near ? prev : near));
    }
  });

  return (
    <group ref={group} name={`remote-${id}`} visible={false}>
      <group ref={inner}>
        <Character appearance={info.appearance} anim={anim} animSeq={info.animSeq} held={info.held} castShadow={shadow} />
      </group>
    </group>
  );
});

interface Rendered {
  id: string;
  info: PlayerInfo;
  leavingAt: number;
}

export function RemotePlayers() {
  const players = useGameStore(useShallow((s) => Object.values(s.players).filter((p) => p.id !== s.sessionId)));
  const [rendered, setRendered] = useState<Rendered[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    setRendered((prev) => {
      const now = performance.now();
      const byId = new Map(players.map((p) => [p.id, p]));
      const next: Rendered[] = [];
      const seen = new Set<string>();
      for (const r of prev) {
        const p = byId.get(r.id);
        if (p) {
          // Still here (or came back within the leave animation).
          next.push(r.info === p && r.leavingAt === 0 ? r : { id: r.id, info: p, leavingAt: 0 });
          const t = timers.current.get(r.id);
          if (t) {
            clearTimeout(t);
            timers.current.delete(r.id);
          }
        } else if (r.leavingAt > 0) {
          next.push(r);
        } else {
          next.push({ ...r, leavingAt: now });
          const t = setTimeout(() => {
            timers.current.delete(r.id);
            setRendered((cur) => cur.filter((x) => !(x.id === r.id && x.leavingAt > 0)));
          }, LEAVE_MS + 50);
          timers.current.set(r.id, t);
        }
        seen.add(r.id);
      }
      for (const p of players) if (!seen.has(p.id)) next.push({ id: p.id, info: p, leavingAt: 0 });
      return next;
    });
  }, [players]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const x of t.values()) clearTimeout(x);
      t.clear();
    };
  }, []);

  return (
    <>
      {rendered.map((r) => (
        <RemotePlayer key={r.id} id={r.id} cached={r.info} leavingAt={r.leavingAt} />
      ))}
    </>
  );
}
