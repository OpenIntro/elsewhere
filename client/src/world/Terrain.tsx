import { useMemo } from 'react';
import { BufferAttribute, Color, PlaneGeometry } from 'three';
import { WORLD_BOUNDS, terrainHeight, WATER_LEVEL } from '@elsewhere/shared';

const SAND = new Color('#d9c79c');
const GRASS = new Color('#8fa66a');
const GRASS_HIGH = new Color('#6f8a55');
const SEABED = new Color('#6f7f78');

/** Placeholder terrain: a height-displaced grid sampled from shared terrainHeight. */
export function Terrain({ resolution = 1 }: { resolution?: number }) {
  const geometry = useMemo(() => {
    const w = WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX;
    const d = WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ;
    const g = new PlaneGeometry(w, d, Math.round(w / resolution), Math.round(d / resolution));
    g.rotateX(-Math.PI / 2);
    g.translate(WORLD_BOUNDS.minX + w / 2, 0, WORLD_BOUNDS.minZ + d / 2);
    const pos = g.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      if (h < WATER_LEVEL + 0.05) c.copy(SEABED);
      else if (h < WATER_LEVEL + 0.6) c.copy(SAND);
      else c.copy(GRASS).lerp(GRASS_HIGH, Math.min(1, (h - 1) / 4));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  }, [resolution]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors roughness={0.95} />
    </mesh>
  );
}

export function Water() {
  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, WATER_LEVEL, 0]}>
      <planeGeometry args={[600, 600]} />
      <meshStandardMaterial color="#5f8f99" transparent opacity={0.85} roughness={0.3} />
    </mesh>
  );
}
