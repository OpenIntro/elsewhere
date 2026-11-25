/**
 * Builds all static architecture, props, decks and interactable bodies into a
 * few merged meshes per location (frustum-culled chunks, shared materials).
 */
import { useMemo } from 'react';
import { Vector3, type BufferGeometry, type Material } from 'three';
import { BUILDINGS, DECKS, INTERACTABLES, PROPS, buildingLocal, getBuilding, terrainHeight, type LocationId } from '@elsewhere/shared';
import { GeoBuilder } from './geom.js';
import { buildBuilding } from './arch/buildings.js';
import { anchors, resetAnchors } from './arch/kit.js';
import { buildDeck, buildInteractable, buildProp, buildUnknownStatics, finishStrings } from './arch/props.js';
import { glazedMaterial, solidMaterial, staticPlantMaterial, windowMaterial } from './materials.js';
import { signMaterial } from './signs.js';
import { buildDressing } from './arch/dressing.js';
import { buildDecorPieces, buildFences } from './arch/decor.js';

export interface BuiltWorld {
  chunks: { key: string; bucket: string; geometry: BufferGeometry }[];
  represented: Set<string>;
}

let built: BuiltWorld | null = null;

/** Build once (deterministic); anchors are filled as a side effect. */
export function buildWorld(): BuiltWorld {
  if (built) return built;
  resetAnchors();
  const builders = new Map<string, GeoBuilder>();
  const get = (key: string) => {
    let b = builders.get(key);
    if (!b) builders.set(key, (b = new GeoBuilder(key.length * 7919 + key.charCodeAt(0))));
    return b;
  };
  for (const b of BUILDINGS) buildBuilding(get(b.style === 'cottage' ? `res_${b.id}` : b.locationId), b);
  for (const i of INTERACTABLES) buildInteractable(get(i.locationId), i);
  for (const p of PROPS) {
    const loc: LocationId = p.id.includes('cafe') ? 'cafe' : p.id.includes('store') ? 'general_store' : p.id.includes('workshop') || p.id === 'workbench' ? 'workshop' : 'residential';
    buildProp(get(loc), p);
  }
  for (const d of DECKS) buildDeck(get(d.kind === 'bridge' ? 'woods' : 'waterfront'), d);
  buildUnknownStatics(get('the_unknown'));
  // café string lights: pole → café façade points (+ parasol)
  const cafe = getBuilding('cafe');
  const y = terrainHeight(cafe.position.x, cafe.position.z);
  const f1 = buildingLocal(cafe, -3.0, cafe.depth / 2 + 0.1);
  const f2 = buildingLocal(cafe, 3.4, cafe.depth / 2 + 0.1);
  finishStrings(get('cafe'), [new Vector3(f1.x, y + 3.3, f1.z), new Vector3(f2.x, y + 3.3, f2.z)]);
  buildFences(get);
  buildDecorPieces(get);
  buildDressing(get);

  const represented = new Set<string>();
  const chunks: BuiltWorld['chunks'] = [];
  for (const [key, b] of builders) {
    for (const id of b.represented) represented.add(id);
    for (const [bucket, geometry] of b.build()) chunks.push({ key, bucket, geometry });
  }
  // Doors are represented by their door leaf (Doors.tsx).
  for (const d of anchors.doors) represented.add(d.id);
  built = { chunks, represented };
  return built;
}

function materialFor(bucket: string): Material {
  switch (bucket) {
    case 'window':
      return windowMaterial;
    case 'glazed':
      return glazedMaterial;
    case 'plant':
      return staticPlantMaterial;
    case 'sign':
      return signMaterial();
    default:
      return solidMaterial;
  }
}

export function Architecture({ shadows }: { shadows: boolean }) {
  const world = useMemo(() => buildWorld(), []);
  return (
    <group name="architecture">
      {world.chunks.map((c) => (
        <mesh
          key={`${c.key}:${c.bucket}`}
          name={`${c.key}:${c.bucket}`}
          geometry={c.geometry}
          material={materialFor(c.bucket)}
          castShadow={shadows && c.bucket !== 'window' && c.bucket !== 'sign'}
          receiveShadow
        />
      ))}
    </group>
  );
}
