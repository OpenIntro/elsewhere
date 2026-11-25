/**
 * WORLD CONTRACT — owned by the world worker.
 * <World /> renders the island EXACTLY from @elsewhere/shared world data
 * (terrain, paths, decks, buildings, structures, nature, interactables) plus
 * environment (sky, water, lighting, day/night from the shared clock) and
 * synced object visuals (lights on/off, doors open, fountain stage) read from
 * useGameStore(s => s.objects).
 *
 * Foundation placeholder: height-mapped ground, water, blocks.
 */
import { Lighting } from './Lighting.js';
import { BuildingBlocks, MiscPlaceholders, TreeInstances } from './Placeholders.js';
import { Terrain, Water } from './Terrain.js';

export interface WorldProps {
  /** Terrain grid resolution in world units (lower = finer). */
  terrainResolution?: number;
}

export function World({ terrainResolution = 1 }: WorldProps) {
  return (
    <group name="world">
      <color attach="background" args={['#cfd9d6']} />
      <Lighting />
      <Terrain resolution={terrainResolution} />
      <Water />
      <BuildingBlocks />
      <TreeInstances />
      <MiscPlaceholders />
    </group>
  );
}
