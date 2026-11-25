/** Placeholder blocks for world data so the slice is readable; the world worker replaces these. */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { InstancedMesh, Object3D } from 'three';
import { BUILDINGS, DECKS, FOUNTAIN, INTERACTABLES, TREES, groundHeight, terrainHeight } from '@elsewhere/shared';

export function BuildingBlocks() {
  return (
    <>
      {BUILDINGS.map((b) => {
        const y = terrainHeight(b.position.x, b.position.z);
        return (
          <group key={b.id} position={[b.position.x, y, b.position.z]} rotation-y={b.yaw}>
            <mesh position={[0, b.height / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[b.width, b.height, b.depth]} />
              <meshStandardMaterial color={b.wallColor} />
            </mesh>
            <mesh position={[0, b.height + 0.6, 0]} castShadow>
              <boxGeometry args={[b.width + 0.4, 1.2, b.depth + 0.4]} />
              <meshStandardMaterial color={b.roofColor} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

export function TreeInstances() {
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    TREES.forEach((t, i) => {
      dummy.position.set(t.position.x, terrainHeight(t.position.x, t.position.z) + 2.4 * t.scale, t.position.z);
      dummy.scale.setScalar(t.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [dummy]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, TREES.length]} castShadow>
      <coneGeometry args={[1.3, 4.8, 7]} />
      <meshStandardMaterial color="#5b7a4c" />
    </instancedMesh>
  );
}

export function MiscPlaceholders() {
  const fountainY = terrainHeight(FOUNTAIN.position.x, FOUNTAIN.position.z);
  return (
    <>
      <mesh position={[FOUNTAIN.position.x, fountainY + FOUNTAIN.basinHeight / 2, FOUNTAIN.position.z]} castShadow receiveShadow>
        <cylinderGeometry args={[FOUNTAIN.basinRadius, FOUNTAIN.basinRadius, FOUNTAIN.basinHeight, 24]} />
        <meshStandardMaterial color="#b9b2a7" />
      </mesh>
      {DECKS.map((d) => (
        <mesh key={d.id} position={[d.center.x, d.y - 0.1, d.center.z]} rotation-y={d.yaw} receiveShadow>
          <boxGeometry args={[d.halfWidth * 2, 0.2, d.halfLength * 2]} />
          <meshStandardMaterial color="#8a6a4a" />
        </mesh>
      ))}
      {INTERACTABLES.map((i) => (
        <mesh key={i.id} position={[i.position.x, groundHeight(i.position.x, i.position.z) + 0.3, i.position.z]}>
          <boxGeometry args={[0.3, 0.6, 0.3]} />
          <meshStandardMaterial color={i.synced ? '#e7b25c' : '#c79195'} />
        </mesh>
      ))}
    </>
  );
}
