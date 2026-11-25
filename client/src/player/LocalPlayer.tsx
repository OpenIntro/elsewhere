/**
 * Local player controller: client-side prediction with the SAME shared
 * collision the server validates with; sends `move` at CONFIG.movement.sendRateHz.
 * Server corrections are applied to runtime.localPlayer by net/.
 */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { Group } from 'three';
import { C2S, CONFIG, angleDelta, groundHeight, resolveMovement, yawFromDirection, type LocomotionAnim } from '@elsewhere/shared';
import { Character } from '../characters/index.js';
import { net } from '../net/index.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { sampleInput, screenToWorld } from './input.js';

const SEND_INTERVAL = 1 / CONFIG.movement.sendRateHz;

export function LocalPlayer() {
  const sessionId = useGameStore((s) => s.sessionId);
  const me = useGameStore((s) => (s.sessionId ? s.players[s.sessionId] : undefined));
  const group = useRef<Group>(null);
  const sendAcc = useRef(0);
  const lastSent = useRef<{ x: number; z: number; anim: LocomotionAnim }>({ x: NaN, z: NaN, anim: 'idle' });

  useFrame((_, rawDt) => {
    const lp = runtime.localPlayer;
    if (!lp.ready || !sessionId) return;
    const dt = Math.min(rawDt, 0.1);
    const seated = !!me?.seat;
    const input = sampleInput();
    const moving = Math.hypot(input.moveX, input.moveY) > 0.05;

    if (seated) {
      if (moving) net.send(C2S.stand, {});
    } else if (moving) {
      const runDefault = useSettingsStore.getState().controls.runByDefault;
      const running = runDefault ? !input.run : input.run;
      const speed = running ? CONFIG.movement.runSpeed : CONFIG.movement.walkSpeed;
      const dir = screenToWorld(input.moveX, input.moveY);
      const next = resolveMovement({ x: lp.x, z: lp.z }, { x: lp.x + dir.x * speed * dt, z: lp.z + dir.z * speed * dt });
      lp.x = next.x;
      lp.z = next.z;
      const targetYaw = yawFromDirection(dir.x, dir.z);
      lp.rot += angleDelta(lp.rot, targetYaw) * Math.min(1, CONFIG.movement.turnSpeed * dt);
      lp.anim = running ? 'run' : 'walk';
    } else {
      lp.anim = 'idle';
    }
    lp.y = groundHeight(lp.x, lp.z);

    // Network: send at a fixed rate while moving, plus one final idle on stop.
    sendAcc.current += dt;
    const changed = lp.x !== lastSent.current.x || lp.z !== lastSent.current.z || lp.anim !== lastSent.current.anim;
    if (!seated && changed && sendAcc.current >= SEND_INTERVAL) {
      sendAcc.current = 0;
      lp.seq += 1;
      net.send(C2S.move, { x: lp.x, z: lp.z, rot: lp.rot, anim: lp.anim, seq: lp.seq });
      lastSent.current = { x: lp.x, z: lp.z, anim: lp.anim };
    }

    const g = group.current;
    if (g) {
      g.position.set(lp.x, lp.y, lp.z);
      g.rotation.y = lp.rot;
    }
  });

  if (!me) return null;
  return (
    <group ref={group} name="local-player">
      <Character appearance={me.appearance} anim={seatedOr(me.anim, runtime.localPlayer.anim)} animSeq={me.animSeq} held={me.held} />
    </group>
  );
}

function seatedOr(serverAnim: string, local: LocomotionAnim) {
  return serverAnim === 'sit' || serverAnim === 'wave' || serverAnim === 'dance' || serverAnim === 'interact' ? (serverAnim as 'sit') : local;
}
