/**
 * What the building activities change OUTSIDE:
 *  - finished Workshop projects (permanent, persisted, the same for everyone):
 *    lanterns strung across the Town Square, a weather vane on the General
 *    Store, bunting along the dock;
 *  - homes: chimney smoke and a warm window glow at night while the hearth
 *    inside burns (lit by a real player, burns down by itself);
 *  - public buildings: an OPEN / CLOSED sign by the door (shared clock).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, Color, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type Group } from 'three';
import { ACTIVITY_KEYS, OPENING_HOURS, getBuilding, getInteractable, groundHeight, terrainHeight, type Vec2 } from '@elsewhere/shared';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { anchors, onFace } from '../world/arch/kit.js';
import { makeBillboards } from '../world/billboard.js';
import { slotFade } from '../world/cutaway.js';
import { env } from '../world/env.js';
import { cone, cyl, GeoBuilder, rbox, sphere, T } from '../world/geom.js';
import { solidMaterial } from '../world/materials.js';
import { projectData, useActivity } from './model.js';

const _m = new Matrix4();
const _c = new Color();

/** Which finished projects are drawn right now (debug snapshot / e2e). */
export const outdoorRendered = new Set<string>();

function buildingMatrix(id: string): Matrix4 {
  const b = getBuilding(id);
  return T(b.position.x, terrainHeight(b.position.x, b.position.z), b.position.z, b.yaw);
}

/** Sagging string between two points: n+1 points. */
function catenary(a: Vector3, b: Vector3, sag: number, n: number): Vector3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return new Vector3().lerpVectors(a, b, t).add(new Vector3(0, -sag * 4 * t * (1 - t), 0));
  });
}
function stringAlong(B: GeoBuilder, pts: Vector3[], r: number, color: string): void {
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    const d = q.clone().sub(p);
    const len = d.length();
    const mid = p.clone().add(q).multiplyScalar(0.5);
    const m = new Matrix4().lookAt(p, q, new Vector3(0, 1, 0));
    m.multiply(new Matrix4().makeRotationX(Math.PI / 2));
    m.setPosition(mid);
    B.add('solid', cyl(r, r, len, 4), color, m, { ao: false });
  }
}

// ---------------------------------------------------------------------------
// Finished projects
// ---------------------------------------------------------------------------

function SquareLanterns() {
  const { geo, bulbs, bulbMat } = useMemo(() => {
    const lights = ['light_square_1', 'light_square_2', 'light_square_3', 'light_square_4', 'light_square_5'].map((id) => getInteractable(id)!.position);
    const centre = { x: 0, z: 2 };
    const ring = [...lights].sort((a, b) => Math.atan2(a.z - centre.z, a.x - centre.x) - Math.atan2(b.z - centre.z, b.x - centre.x));
    const top = (p: Vec2) => new Vector3(p.x, groundHeight(p.x, p.z) + 3.05, p.z);
    const B = new GeoBuilder(21);
    const spots: Vector3[] = [];
    // each lamp post → the next one round the square, and each lamp post → the fountain's crown
    const crown = new Vector3(centre.x, groundHeight(centre.x, centre.z) + 4.4, centre.z);
    for (let i = 0; i < ring.length; i++) {
      const a = top(ring[i]!);
      const b = top(ring[(i + 1) % ring.length]!);
      const pts = catenary(a, b, 0.9, 14);
      stringAlong(B, pts, 0.012, '#3e3b3a');
      for (let k = 2; k < pts.length - 1; k += 2) spots.push(pts[k]!.clone());
      const spoke = catenary(a, crown, 0.5, 10);
      stringAlong(B, spoke, 0.012, '#3e3b3a');
      for (let k = 3; k < spoke.length - 1; k += 3) spots.push(spoke[k]!.clone());
    }
    B.add('solid', cyl(0.05, 0.05, 0.25, 8), '#3e3b3a', T(crown.x, crown.y + 0.1, crown.z), { ao: false });
    for (const s of spots) {
      B.add('solid', cyl(0.006, 0.006, 0.12, 4), '#3e3b3a', T(s.x, s.y - 0.06, s.z), { ao: false });
      B.add('solid', cyl(0.07, 0.07, 0.03, 8), '#5a3f30', T(s.x, s.y - 0.12, s.z), { ao: false });
      B.add('solid', cyl(0.06, 0.06, 0.03, 8), '#5a3f30', T(s.x, s.y - 0.33, s.z), { ao: false });
    }
    const bulbMat = new MeshBasicMaterial({ color: '#f0c48a', toneMapped: false });
    return { geo: B.build().get('solid')!, bulbs: makeBulbs(spots.map((s) => new Vector3(s.x, s.y - 0.225, s.z)), bulbMat), bulbMat };
  }, []);
  useFrame(() => {
    // Paper lanterns: warm by night, pale paper by day.
    _c.set('#e9cfa6').lerp(new Color('#ffc480'), env.glow).multiplyScalar(1 + env.glow * 1.4 * (0.95 + 0.05 * Math.sin(env.time * 3)));
    bulbMat.color.copy(_c);
  });
  useEffect(() => {
    outdoorRendered.add('square_lanterns');
    return () => void outdoorRendered.delete('square_lanterns');
  }, []);
  return (
    <group name="project-square-lanterns">
      <mesh geometry={geo} material={solidMaterial} castShadow />
      <primitive object={bulbs} />
    </group>
  );
}

function makeBulbs(points: Vector3[], mat: MeshBasicMaterial): InstancedMesh {
  const m = new InstancedMesh(rbox(0.13, 0.2, 0.13, 0.05), mat, Math.max(1, points.length));
  points.forEach((p, i) => m.setMatrixAt(i, _m.makeTranslation(p.x, p.y, p.z)));
  m.instanceMatrix.needsUpdate = true;
  return m;
}

function StoreVane() {
  const spin = useRef<Group>(null);
  const { base, arrow, matrix } = useMemo(() => {
    const b = getBuilding('general_store');
    const matrix = buildingMatrix('general_store').multiply(T(0, b.height + 1.85, -b.depth * 0.18));
    const B = new GeoBuilder(4);
    B.add('solid', cyl(0.035, 0.05, 1.1, 8), '#4a3a30', T(0, 0.55, 0));
    for (const [x, z, r] of [[0.32, 0, 0], [-0.32, 0, 0], [0, 0.32, Math.PI / 2], [0, -0.32, Math.PI / 2]] as const) B.add('solid', rbox(0.06, 0.06, 0.02, 0.01), '#a2512f', T(x, 0.85, z, r), { ao: false });
    B.add('solid', rbox(0.66, 0.02, 0.02, 0.01), '#4a3a30', T(0, 0.85, 0), { ao: false });
    B.add('solid', rbox(0.02, 0.02, 0.66, 0.01), '#4a3a30', T(0, 0.85, 0), { ao: false });
    const A = new GeoBuilder(5);
    A.add('solid', rbox(0.9, 0.04, 0.04, 0.01), '#b57a4a', T(0, 0, 0));
    A.add('solid', cone(0.09, 0.22, 4), '#b57a4a', T(0.52, 0, 0, 0, 0, -Math.PI / 2));
    A.add('solid', rbox(0.02, 0.26, 0.3, 0.01), '#b57a4a', T(-0.42, 0.04, 0, Math.PI / 2));
    A.add('solid', sphere(0.06, 8, 6), '#c9a23f', T(0, 0.05, 0));
    // a little copper cockerel on top
    A.add('solid', sphere(0.09, 10, 8), '#b57a4a', T(0, 0.2, 0, 0, 0, 0, 1.3, 1, 0.5));
    A.add('solid', cone(0.06, 0.14, 4), '#b57a4a', T(-0.16, 0.3, 0, 0, 0, 0.9));
    return { base: B.build().get('solid')!, arrow: A.build().get('solid')!, matrix };
  }, []);
  const root = useRef<Group>(null);
  useEffect(() => {
    if (root.current) matrix.decompose(root.current.position, root.current.quaternion, root.current.scale);
    outdoorRendered.add('store_vane');
    return () => void outdoorRendered.delete('store_vane');
  }, [matrix]);
  useFrame(() => {
    if (spin.current) spin.current.rotation.y = 0.6 + Math.sin(env.time * 0.11) * 0.9 + Math.sin(env.time * 0.53) * 0.12;
  });
  return (
    <group ref={root} name="project-store-vane">
      <mesh geometry={base} material={solidMaterial} castShadow />
      <group ref={spin} position={[0, 1.12, 0]}>
        <mesh geometry={arrow} material={solidMaterial} castShadow />
      </group>
    </group>
  );
}

function DockBunting() {
  const group = useRef<Group>(null);
  const { line, flags } = useMemo(() => {
    const ids = ['lantern_dock_1', 'lantern_dock_2', 'lantern_dock_3'];
    const tops = ids.map((id) => {
      const p = getInteractable(id)!.position;
      return new Vector3(p.x, groundHeight(p.x, p.z) + 2.05, p.z);
    });
    const B = new GeoBuilder(8);
    const F = new GeoBuilder(9);
    const cols = ['#c46f4f', '#d1a23f', '#4f7f7a', '#efe4cf', '#7a4e64', '#9fae8c'];
    let k = 0;
    for (let i = 0; i < tops.length - 1; i++) {
      const pts = catenary(tops[i]!, tops[i + 1]!, 0.45, 16);
      stringAlong(B, pts, 0.01, '#efe4cf');
      for (let j = 1; j < pts.length - 1; j++) {
        const p = pts[j]!;
        const d = pts[j + 1]!.clone().sub(pts[j - 1]!);
        const yaw = Math.atan2(d.x, d.z) + Math.PI / 2;
        F.add('solid', cone(0.11, 0.24, 3), cols[k++ % cols.length]!, T(p.x, p.y - 0.13, p.z, yaw, 0, Math.PI).multiply(T(0, 0, 0, 0, 0, 0, 1, 1, 0.12)), { ao: false });
      }
    }
    return { line: B.build().get('solid')!, flags: F.build().get('solid')! };
  }, []);
  useEffect(() => {
    outdoorRendered.add('dock_bunting');
    return () => void outdoorRendered.delete('dock_bunting');
  }, []);
  useFrame(() => {
    if (group.current) group.current.position.y = Math.sin(env.time * 1.3) * 0.015;
  });
  return (
    <group name="project-dock-bunting">
      <mesh geometry={line} material={solidMaterial} />
      <group ref={group}>
        <mesh geometry={flags} material={solidMaterial} castShadow />
      </group>
    </group>
  );
}

function FinishedProjects() {
  const a = useActivity(ACTIVITY_KEYS.project);
  const done = new Set(projectData(a).completed);
  return (
    <group name="finished-projects">
      {done.has('square_lanterns') ? <SquareLanterns /> : null}
      {done.has('store_vane') ? <StoreVane /> : null}
      {done.has('dock_bunting') ? <DockBunting /> : null}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Homes: chimney smoke + window glow while the hearth burns
// ---------------------------------------------------------------------------

const HOME_WINDOWS: { face: 'front' | 'left' | 'right' | 'back'; u: number; y: number }[] = [
  { face: 'front', u: -2.35, y: 1.5 },
  { face: 'front', u: 2.35, y: 1.5 },
  { face: 'left', u: 0.6, y: 1.55 },
  { face: 'right', u: 0.6, y: 1.55 },
  { face: 'back', u: -1.6, y: 1.7 },
];
const HOUSES = ['house_1', 'house_2'];

function HearthsOutside() {
  const chimneys = anchors.hearthChimneys;
  const PER = 8;
  const smoke = useMemo(() => makeBillboards(Math.max(1, chimneys.length * PER), 'puff', false, true), [chimneys.length]);
  const glow = useMemo(() => makeBillboards(HOUSES.length * HOME_WINDOWS.length, 'glow', true, true), []);
  const windows = useMemo(
    () =>
      HOUSES.flatMap((h) => {
        const b = getBuilding(h);
        return HOME_WINDOWS.map((w) => ({ h, p: new Vector3().setFromMatrixPosition(buildingMatrix(h).multiply(onFace(w.face, b.width, b.depth, w.u, b.floorLift + w.y, 0.12))) }));
      }),
    [],
  );
  const lit = useRef(new Map<string, number>());
  useFrame((_, dt) => {
    const acts = useGameStore.getState().activities;
    const now = serverNow();
    for (const h of HOUSES) {
      const a = acts[ACTIVITY_KEYS.hearth(h)];
      const on = !!a?.active && a.value > now ? 1 : 0;
      const cur = lit.current.get(h) ?? on;
      lit.current.set(h, cur + (on - cur) * Math.min(1, dt * 0.7));
    }
    const t = env.time;
    const alpha = smoke.geometry.getAttribute('aAlpha');
    const smokeC = _c.copy(env.hemiSky).lerp(new Color('#ece6de'), 0.6).multiplyScalar(0.8 + 0.25 * (1 - env.night));
    chimneys.forEach((src, si) => {
      const lv = lit.current.get(src.buildingId) ?? 0;
      for (let k = 0; k < PER; k++) {
        const i = si * PER + k;
        const life = (t * 0.17 + k / PER + si * 0.41) % 1;
        const drift = life * life * 2.0;
        const s = 0.3 + life * 1.2;
        _m.makeScale(s, s, s).setPosition(src.position.x + drift * 0.8 + Math.sin(t * 0.7 + i) * 0.12 * life, src.position.y + life * 3, src.position.z - drift * 0.3);
        smoke.setMatrixAt(i, _m);
        smoke.setColorAt(i, smokeC);
        alpha.setX(i, Math.sin(Math.min(1, life * 1.4) * Math.PI) * 0.42 * lv);
      }
    });
    smoke.instanceMatrix.needsUpdate = true;
    if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
    alpha.needsUpdate = true;
    windows.forEach((w, i) => {
      const lv = lit.current.get(w.h) ?? 0;
      const flick = 0.85 + 0.15 * Math.sin(t * 8.3 + i) * Math.sin(t * 3.9 + i * 2);
      glow.setMatrixAt(i, _m.makeScale(2.1, 2.1, 2.1).setPosition(w.p));
      glow.setColorAt(i, _c.setRGB(1, 0.55, 0.25).multiplyScalar(lv * env.glow * 1.0 * flick));
    });
    glow.instanceMatrix.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  });
  return (
    <group name="hearths-outside">
      <primitive object={smoke} />
      <primitive object={glow} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// OPEN / CLOSED signs (shared clock)
// ---------------------------------------------------------------------------

function signTexture(text: string, bg: string, fg: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 96);
  g.strokeStyle = fg;
  g.globalAlpha = 0.5;
  g.lineWidth = 4;
  g.strokeRect(8, 8, 240, 80);
  g.globalAlpha = 1;
  g.fillStyle = fg;
  g.font = '600 46px "Fraunces", Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 52);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function OpenSign({ id }: { id: string }) {
  const open = useActivity(ACTIVITY_KEYS.building(id))?.active ?? false;
  const mesh = useRef<Mesh>(null);
  const { mats, geo, frame, matrix } = useMemo(() => {
    const b = getBuilding(id);
    const mats = {
      open: new MeshStandardMaterial({ map: signTexture('OPEN', '#efe4cf', '#4f6f66'), roughness: 0.9 }),
      closed: new MeshStandardMaterial({ map: signTexture('CLOSED', '#5e4636', '#efe4cf'), roughness: 0.9 }),
    };
    const matrix = buildingMatrix(id).multiply(T(b.doorWidth / 2 + 0.62, b.floorLift + 1.65, b.depth / 2 + 0.1));
    const B = new GeoBuilder(2);
    B.at(matrix, () => {
      B.add('solid', rbox(0.62, 0.26, 0.04, 0.015), '#5e4636', T(0, 0, -0.01), { ao: false });
      for (const s of [-1, 1]) B.add('solid', cyl(0.006, 0.006, 0.22, 4), '#3e3b3a', T(s * 0.2, 0.22, -0.01, 0, 0, s * 0.45), { ao: false });
    });
    return { mats, geo: new PlaneGeometry(0.56, 0.21), frame: B.build().get('solid')!, matrix };
  }, [id]);
  useEffect(() => {
    if (mesh.current) {
      matrix.decompose(mesh.current.position, mesh.current.quaternion, mesh.current.scale);
      mesh.current.translateZ(0.016);
    }
  }, [matrix]);
  const group = useRef<Group>(null);
  useFrame(() => {
    if (group.current) group.current.visible = slotFade(id, 'front') < 0.5;
  });
  return (
    <group ref={group} name={`open-sign-${id}`}>
      <mesh geometry={frame} material={solidMaterial} />
      <mesh ref={mesh} geometry={geo} material={open ? mats.open : mats.closed} />
    </group>
  );
}

export function OutdoorActivities() {
  return (
    <group name="activities-outdoor">
      <FinishedProjects />
      <HearthsOutside />
      {Object.keys(OPENING_HOURS).map((id) => (
        <OpenSign key={id} id={id} />
      ))}
    </group>
  );
}
