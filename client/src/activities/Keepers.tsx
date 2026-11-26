/**
 * Building keepers (barista, shopkeeper, archivist, tinkerer): WORLD
 * characters, rendered with the shared character rig in its 'npc' variant
 * (glazed-ceramic finish + floating gem marker) and an overlay tag in the
 * NPC style with a "keeper" badge — never a player name tag, never counted,
 * never in chat. Pose and state come from the server (`state.keepers`) so
 * every client sees the same thing; here we only smooth it.
 */
import { useFrame } from '@react-three/fiber';
import { memo, useEffect, useRef, useState } from 'react';
import type { Group } from 'three';
import { KEEPERS, angleDelta, groundHeight, type AnimState, type KeeperDef } from '@elsewhere/shared';
import { Character } from '../characters/index.js';
import { registerOverlayActor } from '../game/WorldOverlay.js';
import { useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { isHiddenIndoors } from '../world/cutaway.js';
import { devOverrides } from '../world/env.js';

const FADE_S = 0.6;

const Keeper = memo(function Keeper({ def }: { def: KeeperDef }) {
  const info = useGameStore((s) => s.keepers[def.id]);
  const group = useRef<Group>(null);
  const st = useRef({ init: false, x: 0, y: 0, z: 0, rot: 0, px: 0, pz: 0, speed: 0, fade: 0 });
  const [anim, setAnim] = useState<AnimState>('idle');
  /** Only build / animate the character when it is near what the camera looks at (saves CPU per frame). */
  const [near, setNear] = useState(false);
  const nearCheck = useRef(0);
  const animRef = useRef<AnimState>('idle');
  const present = !!info?.present;
  const presentRef = useRef(present);
  presentRef.current = present;

  useEffect(
    () =>
      registerOverlayActor(def.id, {
        kind: 'npc',
        name: `${def.name} · ${def.role}`,
        pose(out) {
          const s = st.current;
          if (!s.init || s.fade < 0.5 || isHiddenIndoors(s.x, s.z)) return false;
          out.x = s.x;
          out.y = s.y;
          out.z = s.z;
          return true;
        },
      }),
    [def],
  );

  useFrame((_, rawDt) => {
    const g = group.current;
    const r = runtime.keepers.get(def.id);
    if (!g || !r) return;
    const dt = Math.min(rawDt, 0.1);
    const s = st.current;
    if (!s.init) {
      Object.assign(s, { init: true, x: r.x, z: r.z, rot: r.rot, px: r.x, pz: r.z });
    }
    // Smooth toward the authoritative pose (server moves keepers at walking pace).
    const k = 1 - Math.exp(-dt * 8);
    s.x += (r.x - s.x) * k;
    s.z += (r.z - s.z) * k;
    s.rot += angleDelta(s.rot, r.rot) * (1 - Math.exp(-dt * 7));
    s.y = groundHeight(s.x, s.z);
    const inst = dt > 0 ? Math.hypot(s.x - s.px, s.z - s.pz) / dt : 0;
    s.speed += (Math.min(inst, 4) - s.speed) * (1 - Math.exp(-dt * 6));
    s.px = s.x;
    s.pz = s.z;
    s.fade = Math.max(0, Math.min(1, s.fade + (presentRef.current ? dt : -dt) / FADE_S));
    g.visible = s.fade > 0.01;
    g.position.set(s.x, s.y - 0.2 * (1 - s.fade), s.z);
    g.rotation.y = s.rot;
    g.scale.setScalar(0.6 + 0.4 * s.fade);
    r.render = { x: s.x, y: s.y, z: s.z, rot: s.rot, speed: s.speed, visible: s.fade > 0.5 };
    nearCheck.current -= dt;
    if (nearCheck.current <= 0) {
      nearCheck.current = 0.5;
      const v = runtime.view;
      const cam = devOverrides.cam; // dev screenshots look elsewhere than the player
      const n = s.fade > 0.01 && Math.hypot(s.x - (cam?.x ?? v.focusX), s.z - (cam?.z ?? v.focusZ)) < Math.max(40, v.halfWidth * 1.6);
      setNear((prev) => (prev === n ? prev : n));
    }
    const serverAnim = useGameStore.getState().keepers[def.id]?.anim ?? 'idle';
    const next: AnimState = s.speed > 0.35 ? 'walk' : serverAnim === 'interact' ? 'interact' : 'idle';
    if (next !== animRef.current) {
      animRef.current = next;
      setAnim(next);
    }
  });

  return (
    <group ref={group} name={`keeper-${def.id}`} visible={false}>
      {near ? <Character appearance={def.appearance} anim={anim} animSeq={info?.animSeq ?? 0} variant="npc" castShadow speed={st.current.speed} seed={def.id.length / 17} /> : null}
    </group>
  );
});

export function Keepers() {
  return (
    <group name="keepers">
      {KEEPERS.map((k) => (
        <Keeper key={k.id} def={k} />
      ))}
    </group>
  );
}
