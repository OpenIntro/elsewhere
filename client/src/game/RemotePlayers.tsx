/** Renders every non-local player at its interpolated pose (per-frame via refs). */
import { useFrame } from '@react-three/fiber';
import { memo, useRef } from 'react';
import type { Group } from 'three';
import { Character } from '../characters/index.js';
import { sampleRemote } from '../net/index.js';
import { useGameStore, type PlayerInfo } from '../state/gameStore.js';
import type { Pose } from '../state/runtime.js';
import { useShallow } from 'zustand/react/shallow';

const RemotePlayer = memo(function RemotePlayer({ id }: { id: string }) {
  const info = useGameStore((s) => s.players[id]) as PlayerInfo | undefined;
  const group = useRef<Group>(null);
  const pose = useRef<Pose>({ x: 0, y: 0, z: 0, rot: 0 });
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    if (sampleRemote(id, pose.current)) {
      g.visible = true;
      g.position.set(pose.current.x, pose.current.y, pose.current.z);
      g.rotation.y = pose.current.rot;
    } else {
      g.visible = false;
    }
  });
  if (!info) return null;
  return (
    <group ref={group} name={`remote-${id}`} visible={false}>
      <Character appearance={info.appearance} anim={info.anim} animSeq={info.animSeq} held={info.held} />
    </group>
  );
});

export function RemotePlayers() {
  const ids = useGameStore(useShallow((s) => Object.keys(s.players).filter((id) => id !== s.sessionId)));
  return (
    <>
      {ids.map((id) => (
        <RemotePlayer key={id} id={id} />
      ))}
    </>
  );
}
