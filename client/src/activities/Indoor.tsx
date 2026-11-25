/**
 * Live dressing of the building interiors, driven ONLY by synced state
 * (real players' actions) or by the shared clock (world behaviour):
 *  - café: today's special chalked on the board, steam from the espresso
 *    machine while the barista works, music notes over the piano when someone
 *    plays, a soft spotlight on whoever stands on the stage;
 *  - store: today's three curiosities on the table;
 *  - hall: one paper per real notice on the board, the poll slate with real
 *    tallies ("no votes yet"), a glow at the lectern while someone speaks;
 *  - workshop: the town project on the sawhorses, built up stage by stage;
 *  - homes: a fire in the hearth while it burns, kettle steam, guest books;
 *  - boathouse: freshly mended net sections, the tide log;
 *  - everywhere: wall clocks showing the world time, steam over cups in hand.
 * Wall-mounted pieces hide when their wall is cut away (cutaway.slotFade).
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Group,
} from 'three';
import {
  ACTIVITY_KEYS,
  FURNITURE,
  S2C,
  curiositiesForDay,
  getBuilding,
  getInterior,
  hashString,
  isDrinkItem,
  parseActivityData,
  rotateOffset,
  specialForDay,
  terrainHeight,
  type FurniturePiece,
} from '@elsewhere/shared';
import { heldGeometry } from '../characters/held.js';
import { toyMaterial } from '../characters/materials.js';
import { net } from '../net/index.js';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { runtime } from '../state/runtime.js';
import { slotFade, isHiddenIndoors, type CutPart } from '../world/cutaway.js';
import { makeBillboards } from '../world/billboard.js';
import { env } from '../world/env.js';
import { box, cone, cyl, GeoBuilder, rbox, T } from '../world/geom.js';
import { additiveMaterial, glazedMaterial, solidMaterial } from '../world/materials.js';
import { innerFace } from '../world/arch/walkin.js';
import { boardEntries, netsData, pollData, projectData, useActivity, visibleEntries } from './model.js';

const _m = new Matrix4();
const _v = new Vector3();
const _c = new Color();
const _o = new Object3D();

export function furn(interiorId: string, id: string): FurniturePiece {
  const f = FURNITURE.find((x) => x.id === `furn_${interiorId}_${id}`);
  if (!f) throw new Error(`no furniture ${interiorId}.${id}`);
  return f;
}
/** World matrix of a point in a furniture piece's frame (floor-relative y). */
export function furnMatrix(f: FurniturePiece, lx: number, ly: number, lz: number, extraYaw = 0): Matrix4 {
  const o = rotateOffset({ x: lx, z: lz }, f.yaw);
  return T(f.position.x + o.x, getInterior(f.interiorId)!.floorY + ly, f.position.z + o.z, f.yaw + extraYaw);
}
/** World matrix of a point on a building's inner wall face (walkin.innerFace frame). */
function wallMatrix(buildingId: string, face: 'front' | 'back' | 'left' | 'right', u: number, y: number, out = 0.06): Matrix4 {
  const b = getBuilding(buildingId);
  return T(b.position.x, terrainHeight(b.position.x, b.position.z), b.position.z, b.yaw).multiply(innerFace(b, face, u, y)).multiply(T(0, 0, out));
}
function setFrom(obj: Object3D, m: Matrix4): void {
  m.decompose(obj.position, obj.quaternion, obj.scale);
}

// ---------------------------------------------------------------------------
// Canvas textures (chalk, paper)
// ---------------------------------------------------------------------------

function canvasTexture(w: number, h: number): { tex: CanvasTexture; g: CanvasRenderingContext2D; c: HTMLCanvasElement } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, g, c };
}
const SERIF = '"Fraunces", Georgia, "Times New Roman", serif';
const HAND = '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Wall-mounted dressing: hide while its wall is cut away. */
function useWallHide(ref: { current: Object3D | null }, buildingId: string, part: CutPart): void {
  useFrame(() => {
    if (ref.current) ref.current.visible = slotFade(buildingId, part) < 0.5;
  });
}

// ---------------------------------------------------------------------------
// Café
// ---------------------------------------------------------------------------

function Chalkboard() {
  const special = useActivity(ACTIVITY_KEYS.special);
  const mesh = useRef<Mesh>(null);
  const { tex, g, mat, geo, matrix } = useMemo(() => {
    const { tex, g } = canvasTexture(512, 300);
    const mat = new MeshStandardMaterial({ map: tex, transparent: true, roughness: 1, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    return { tex, g, mat, geo: new PlaneGeometry(1.06, 0.62), matrix: furnMatrix(furn('cafe', 'chalkboard'), 0, 1.8, 0.066) };
  }, []);
  useEffect(() => {
    const sp = parseActivityData<{ name: string; text: string }>(special?.data, specialForDay(Math.round(special?.value ?? 0)));
    g.clearRect(0, 0, 512, 300);
    g.fillStyle = 'rgba(236,232,220,0.92)';
    g.textAlign = 'center';
    g.font = `600 30px ${SERIF}`;
    g.fillText('TODAY’S SPECIAL', 256, 46);
    g.strokeStyle = 'rgba(236,232,220,0.5)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(150, 62);
    g.lineTo(362, 62);
    g.stroke();
    g.fillStyle = '#f1d27a';
    g.font = `italic 600 44px ${SERIF}`;
    const lines = wrap(g, sp.name, 470);
    lines.slice(0, 2).forEach((l, i) => g.fillText(l, 256, 118 + i * 46));
    g.fillStyle = 'rgba(236,232,220,0.85)';
    g.font = `26px ${HAND}`;
    g.fillText(sp.text, 256, 118 + Math.min(2, lines.length) * 46 + 4);
    g.font = `24px ${SERIF}`;
    g.fillStyle = 'rgba(236,232,220,0.7)';
    g.fillText('coffee  ·  tea  ·  cocoa', 256, 278);
    tex.needsUpdate = true;
  }, [special?.data, special?.value, g, tex]);
  useEffect(() => () => (tex.dispose(), mat.dispose(), geo.dispose()), [tex, mat, geo]);
  useEffect(() => {
    if (mesh.current) setFrom(mesh.current, matrix);
  }, [matrix]);
  useWallHide(mesh, 'cafe', 'back');
  return <mesh ref={mesh} geometry={geo} material={mat} name="cafe-special" />;
}

/** Floating notes over the piano for every note anyone plays (S2C.pianoNote). */
function PianoNotes() {
  const { mesh, base, notes } = useMemo(() => {
    const { tex, g } = canvasTexture(64, 64);
    g.fillStyle = '#fff';
    g.font = `48px ${SERIF}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♪', 32, 34);
    tex.needsUpdate = true;
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: DoubleSide });
    const mesh = new InstancedMesh(new PlaneGeometry(0.22, 0.22), mat, 14);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    for (let i = 0; i < 14; i++) {
      mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      mesh.setColorAt(i, _c.set('#f1d27a'));
    }
    const p = furnMatrix(furn('cafe', 'piano'), 0, 1.45, 0.25);
    const base = new Vector3().setFromMatrixPosition(p);
    return { mesh, base, notes: Array.from({ length: 14 }, () => ({ t: -1, x: 0, note: 0 })) };
  }, []);
  const next = useRef(0);
  useEffect(
    () =>
      net.on(S2C.pianoNote, (e) => {
        const n = notes[next.current++ % notes.length]!;
        n.t = 0;
        n.note = e.note;
        n.x = (e.note / 24 - 0.5) * 1.0;
      }),
    [notes],
  );
  useFrame(({ camera }, dt) => {
    let any = false;
    notes.forEach((n, i) => {
      if (n.t < 0) return;
      n.t += dt;
      if (n.t > 1.8) {
        n.t = -1;
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        any = true;
        return;
      }
      const s = Math.sin(Math.min(1, n.t / 1.8) * Math.PI) * 1.1;
      _o.position.set(base.x + n.x + Math.sin(n.t * 3 + i) * 0.08, base.y + n.t * 0.55, base.z);
      _o.quaternion.copy(camera.quaternion);
      _o.scale.setScalar(Math.max(0.001, s));
      _o.updateMatrix();
      mesh.setMatrixAt(i, _o.matrix);
      mesh.setColorAt(i, _c.setHSL(0.11 + (n.note % 12) * 0.012, 0.75, 0.72));
      any = true;
    });
    if (any) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  });
  return <primitive object={mesh} />;
}

/** A soft spotlight cone + floor pool on whoever holds the café stage / the hall lectern. */
function Spotlight({ activityKey, color, strength }: { activityKey: string; color: string; strength: number }) {
  const holder = useActivity(activityKey)?.holder ?? '';
  const group = useRef<Group>(null);
  const { coneMat, poolMat, coneGeo, poolGeo } = useMemo(() => {
    const coneMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.16 * strength, depthWrite: false, blending: AdditiveBlending, toneMapped: false, side: DoubleSide });
    const poolMat = additiveMaterial();
    poolMat.color.set(color).multiplyScalar(0.55 * strength);
    const coneGeo = cyl(0.12, 0.85, 2.7, 24, true);
    const poolGeo = new PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2);
    return { coneMat, poolMat, coneGeo, poolGeo };
  }, [color, strength]);
  const fade = useRef(0);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const me = useGameStore.getState().sessionId;
    let p: { x: number; y: number; z: number } | null = null;
    if (holder && holder === me && runtime.localPlayer.ready) p = runtime.localPlayer;
    else if (holder) {
      const r = runtime.remotes.get(holder)?.render;
      if (r?.visible && !isHiddenIndoors(r.x, r.z)) p = r;
    }
    fade.current = Math.max(0, Math.min(1, fade.current + (p ? dt : -dt) * 2.5));
    g.visible = fade.current > 0.01;
    if (p) g.position.set(p.x, p.y, p.z);
    coneMat.opacity = 0.16 * strength * fade.current * (0.92 + 0.08 * Math.sin(env.time * 1.7));
    poolMat.opacity = fade.current;
  });
  return (
    <group ref={group} visible={false} name={`spot-${activityKey}`}>
      <mesh geometry={coneGeo} material={coneMat} position={[0, 1.35, 0]} renderOrder={4} />
      <mesh geometry={poolGeo} material={poolMat} position={[0, 0.03, 0]} renderOrder={4} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Store: today's curiosities on the table
// ---------------------------------------------------------------------------

function Curiosities() {
  const shelf = useActivity(ACTIVITY_KEYS.shelf);
  const items = useMemo(() => parseActivityData<{ items: string[] }>(shelf?.data, { items: curiositiesForDay(Math.round(shelf?.value ?? 0)) }).items, [shelf?.data, shelf?.value]);
  const f = useMemo(() => furn('general_store', 'display'), []);
  const mat = useMemo(() => toyMaterial('player', false), []);
  return (
    <group name="curiosities">
      {items.slice(0, 3).map((id, i) => {
        const m = furnMatrix(f, -0.45 + i * 0.45, 0.86, 0.28, 0.3 * (i - 1));
        const p = new Vector3().setFromMatrixPosition(m);
        return <mesh key={`${id}-${i}`} geometry={heldGeometry(id)} material={mat} position={p} rotation={[0, f.yaw + 0.4 * i, 0]} scale={1.8} castShadow />;
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Town Hall: notices + the poll slate
// ---------------------------------------------------------------------------

function NoticePapers() {
  const board = useActivity(ACTIVITY_KEYS.board('hall_notices'));
  const blocked = useGameStore((s) => s.blocked);
  const muted = useGameStore((s) => s.muted);
  const entries = useMemo(() => visibleEntries(boardEntries(board), blocked, muted), [board, blocked, muted]);
  const group = useRef<Group>(null);
  const { papers, pins } = useMemo(() => {
    const { tex, g } = canvasTexture(64, 48);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 64, 48);
    g.strokeStyle = 'rgba(70,60,50,0.55)';
    g.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(8, 10 + k * 7);
      g.lineTo(8 + 30 + ((k * 13) % 18), 10 + k * 7);
      g.stroke();
    }
    tex.needsUpdate = true;
    const papers = new InstancedMesh(new PlaneGeometry(0.3, 0.22), new MeshStandardMaterial({ map: tex, roughness: 0.95 }), 24);
    const pins = new InstancedMesh(new PlaneGeometry(0.035, 0.035), new MeshBasicMaterial({ color: '#b8453a' }), 24);
    papers.count = 0;
    pins.count = 0;
    papers.frustumCulled = false;
    pins.frustumCulled = false;
    return { papers, pins };
  }, []);
  useEffect(() => {
    const f = furn('town_hall', 'notice_board');
    const tones = ['#f4efe6', '#efe2c9', '#e9dcc8', '#f2e6d0', '#e8d9c4'];
    const shown = entries.slice(-12);
    shown.forEach((e, i) => {
      const h = hashString(e.id);
      const col = i % 4;
      const row = Math.floor(i / 4);
      const x = -0.55 + col * 0.37 + ((h % 7) - 3) * 0.008;
      const y = 1.98 - row * 0.3 + (((h >> 3) % 5) - 2) * 0.01;
      const r = (((h >> 6) % 9) - 4) * 0.025;
      const m = furnMatrix(f, x, y, 0.078).multiply(T(0, 0, 0, 0, 0, r));
      papers.setMatrixAt(i, m);
      papers.setColorAt(i, _c.set(tones[h % tones.length]!));
      pins.setMatrixAt(i, furnMatrix(f, x, y + 0.085, 0.083));
    });
    papers.count = shown.length;
    pins.count = shown.length;
    papers.instanceMatrix.needsUpdate = true;
    pins.instanceMatrix.needsUpdate = true;
    if (papers.instanceColor) papers.instanceColor.needsUpdate = true;
  }, [entries, papers, pins]);
  useWallHide(group, 'town_hall', 'right');
  return (
    <group ref={group} name="notice-papers">
      <primitive object={papers} />
      <primitive object={pins} />
    </group>
  );
}

function PollSlate() {
  const pollA = useActivity(ACTIVITY_KEYS.poll);
  const mesh = useRef<Mesh>(null);
  const { tex, g, mat, geo, box: ballot } = useMemo(() => {
    const { tex, g } = canvasTexture(384, 300);
    const mat = new MeshStandardMaterial({ map: tex, roughness: 1 });
    const B = new GeoBuilder(3);
    const f = furn('town_hall', 'meeting_table');
    B.at(furnMatrix(f, -0.95, 0.78, 0.15), () => {
      B.add('solid', rbox(0.34, 0.26, 0.26, 0.03), '#6a4f3e', T(0, 0.13, 0));
      B.add('solid', box(0.18, 0.012, 0.03), '#2e2620', T(0, 0.262, 0), { ao: false });
      B.add('solid', rbox(0.36, 0.03, 0.28, 0.01), P_BRASS, T(0, 0.27, 0), { ao: false });
    });
    B.at(furnMatrix(f, -0.95, 0.78, -0.32), () => {
      B.add('solid', rbox(0.66, 0.54, 0.04, 0.02), '#5e4636', T(0, 0.3, 0));
      B.add('solid', rbox(0.04, 0.2, 0.2, 0.01), '#5e4636', T(0, 0.08, -0.06, 0, -0.5));
    });
    return { tex, g, mat, geo: new PlaneGeometry(0.6, 0.47), box: B.build().get('solid')! };
  }, []);
  useEffect(() => {
    const p = pollData(pollA);
    g.fillStyle = '#2e3431';
    g.fillRect(0, 0, 384, 300);
    g.fillStyle = 'rgba(236,232,220,0.9)';
    g.textAlign = 'left';
    g.font = `600 22px ${SERIF}`;
    g.fillText('TOWN POLL', 18, 32);
    g.font = `italic 22px ${SERIF}`;
    const q = wrap(g, p.question || '…', 350).slice(0, 2);
    q.forEach((l, i) => g.fillText(l, 18, 62 + i * 26));
    const total = p.tallies.reduce((a, b) => a + b, 0);
    const top = 62 + q.length * 26 + 10;
    g.font = `18px ${SERIF}`;
    p.options.slice(0, 4).forEach((o, i) => {
      const y = top + i * 40;
      const n = p.tallies[i] ?? 0;
      g.fillStyle = 'rgba(236,232,220,0.85)';
      g.fillText(o, 18, y + 14);
      g.fillStyle = 'rgba(236,232,220,0.18)';
      g.fillRect(18, y + 20, 300, 10);
      g.fillStyle = '#f1d27a';
      g.fillRect(18, y + 20, total ? (300 * n) / total : 0, 10);
      g.fillStyle = 'rgba(236,232,220,0.9)';
      g.textAlign = 'right';
      g.fillText(String(n), 366, y + 30);
      g.textAlign = 'left';
    });
    if (!total) {
      g.fillStyle = 'rgba(236,232,220,0.6)';
      g.font = `italic 18px ${SERIF}`;
      g.fillText('no votes yet', 18, 290);
    }
    tex.needsUpdate = true;
  }, [pollA, g, tex]);
  useEffect(() => {
    if (mesh.current) setFrom(mesh.current, furnMatrix(furn('town_hall', 'meeting_table'), -0.95, 0.78 + 0.31, -0.295));
  }, []);
  return (
    <group name="poll-slate">
      <mesh geometry={ballot} material={solidMaterial} castShadow />
      <mesh ref={mesh} geometry={geo} material={mat} />
    </group>
  );
}
const P_BRASS = '#c9a23f';

// ---------------------------------------------------------------------------
// Workshop: the town project, stage by stage
// ---------------------------------------------------------------------------

function projectGeometry(projectId: string, stage: number) {
  const B = new GeoBuilder(11);
  const f = furn('workshop', 'sawhorses');
  B.at(furnMatrix(f, 0, 0.86, 0), () => {
    // the bench board laid over the sawhorses
    B.add('solid', rbox(1.9, 0.05, 0.62, 0.02), '#b08a62', T(0, 0.02, 0));
    if (projectId === 'square_lanterns') {
      for (let k = 0; k < 4; k++) {
        const x = -0.66 + k * 0.44;
        if (stage >= 1 || k < 2) {
          // frame
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add('solid', box(0.025, 0.26, 0.025), '#6a4f3e', T(x + sx * 0.08, 0.18, sz * 0.08));
          B.add('solid', rbox(0.21, 0.03, 0.21, 0.01), '#6a4f3e', T(x, 0.32, 0));
          B.add('solid', cone(0.12, 0.08, 4), '#5a3f30', T(x, 0.37, 0, Math.PI / 4));
        }
        if (stage >= 2) B.add('glazed', box(0.15, 0.22, 0.15), '#f0b866', T(x, 0.18, 0), { ao: false });
      }
      if (stage === 0) for (let k = 0; k < 6; k++) B.add('solid', box(0.03, 0.03, 0.5), '#7a5c46', T(0.3 + (k % 3) * 0.06, 0.06 + Math.floor(k / 3) * 0.035, 0.05, 0.3));
    } else if (projectId === 'store_vane') {
      B.add('solid', box(1.1, 0.04, 0.04), '#9a6b45', T(0, 0.06, 0));
      if (stage >= 1) {
        B.add('solid', cone(0.08, 0.2, 4), '#9a6b45', T(0.62, 0.06, 0, 0, 0, -Math.PI / 2));
        B.add('solid', rbox(0.02, 0.24, 0.26, 0.01), '#9a6b45', T(-0.55, 0.06, 0, 0, Math.PI / 2));
      }
      if (stage >= 2) for (const [x, z] of [[-0.2, 0.18], [0.0, -0.2], [0.2, 0.18], [0.4, -0.2]] as const) B.add('solid', rbox(0.1, 0.03, 0.12, 0.01), '#b57a4a', T(x, 0.06, z));
    } else if (projectId === 'dock_bunting') {
      const cols = ['#c46f4f', '#d1a23f', '#4f7f7a', '#efe4cf', '#7a4e64'];
      const n = stage >= 2 ? 9 : stage >= 1 ? 5 : 0;
      for (let k = 0; k < n; k++) B.add('solid', cone(0.08, 0.14, 3), cols[k % cols.length]!, T(-0.7 + k * 0.17, 0.05, 0.1 * ((k % 2) - 0.5), 0, Math.PI / 2), { ao: false });
      for (let k = 0; k < 3; k++) B.add('solid', cyl(0.07, 0.07, 0.12 + k * 0.01, 12), cols[k]!, T(0.55, 0.08, -0.15 + k * 0.15, 0, Math.PI / 2));
    }
  });
  return B.build();
}

function WorkshopProject() {
  const a = useActivity(ACTIVITY_KEYS.project);
  const p = projectData(a);
  const geo = useMemo(() => (p.projectId ? projectGeometry(p.projectId, p.stage) : null), [p.projectId, p.stage]);
  useEffect(() => () => geo?.forEach((g) => g.dispose()), [geo]);
  if (!geo) return null;
  return (
    <group name={`project-${p.projectId}-${p.stage}`}>
      {[...geo].map(([bucket, g]) => (
        <mesh key={bucket} geometry={g} material={bucket === 'glazed' ? glazedMaterial : solidMaterial} castShadow receiveShadow />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Homes: hearth fires, guest books; boathouse nets + log
// ---------------------------------------------------------------------------

function HearthFire({ house }: { house: string }) {
  const lit = useActivity(ACTIVITY_KEYS.hearth(house));
  const group = useRef<Group>(null);
  const flames = useRef<Mesh[]>([]);
  const { outer, inner, halo, pool, embers, m } = useMemo(() => {
    const outer = new MeshBasicMaterial({ color: '#f08a3a', toneMapped: false, transparent: true, opacity: 0.92 });
    const inner = new MeshBasicMaterial({ color: '#ffd27a', toneMapped: false });
    const halo = additiveMaterial();
    const pool = additiveMaterial();
    const embers = new MeshBasicMaterial({ color: '#7a2e18', toneMapped: false });
    const m = furnMatrix(furn(house, 'hearth'), 0, 0, 0);
    return { outer, inner, halo, pool, embers, m };
  }, [house]);
  const fade = useRef(0);
  useEffect(() => {
    if (group.current) setFrom(group.current, m);
  }, [m]);
  useFrame((_, dt) => {
    const on = !!lit?.active && (lit?.value ?? 0) > serverNow();
    fade.current = Math.max(0, Math.min(1, fade.current + (on ? dt * 0.8 : -dt * 0.4)));
    const f = fade.current;
    const t = env.time;
    if (group.current) group.current.visible = f > 0.005;
    flames.current.forEach((fl, i) => {
      if (!fl) return;
      const k = 0.75 + 0.25 * Math.sin(t * (7 + i * 2.3) + i) * Math.sin(t * (3.1 + i) + i * 2);
      fl.scale.set(f * (0.9 + 0.1 * k), Math.max(0.001, f * k * (1 - i * 0.15)), f * (0.9 + 0.1 * k));
      fl.visible = f > 0.02;
    });
    const flick = 0.85 + 0.15 * Math.sin(t * 9.1) * Math.sin(t * 4.7);
    halo.color.setRGB(1, 0.55, 0.22).multiplyScalar(0.9 * f * flick);
    pool.color.setRGB(1, 0.5, 0.2).multiplyScalar(0.55 * f * flick);
    embers.color.setRGB(0.45 + 0.35 * f, 0.16 + 0.1 * f, 0.08);
  });
  return (
    <group ref={group} name={`hearth-${house}`}>
      {[0, 1, 2].map((i) => (
        <mesh key={i} ref={(r) => void (r && (flames.current[i] = r))} geometry={i === 2 ? FLAME_SMALL : FLAME} material={i === 1 ? inner : outer} position={[(i - 1) * 0.12, 0.13, 0.2]} rotation={[0, i, 0]} />
      ))}
      <mesh geometry={EMBERS} material={embers} position={[0, 0.13, 0.2]} />
      <mesh geometry={HALO} material={halo} position={[0, 0.4, 0.4]} renderOrder={5} />
      <mesh geometry={POOL} material={pool} position={[0, 0.02 - 0.0, 0.95]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={4} />
    </group>
  );
}
const FLAME = cone(0.11, 0.38, 8).translate(0, 0.19, 0);
const FLAME_SMALL = cone(0.07, 0.24, 8).translate(0, 0.12, 0);
const EMBERS = rbox(0.42, 0.05, 0.16, 0.02);
const HALO = new PlaneGeometry(1.4, 1.2);
const POOL = new PlaneGeometry(2.4, 2.0);

function Books() {
  const geo = useMemo(() => {
    const B = new GeoBuilder(5);
    const book = (m: Matrix4, cover: string) =>
      B.at(m, () => {
        B.add('solid', rbox(0.42, 0.025, 0.3, 0.01), cover, T(0, 0.012, 0));
        for (const s of [-1, 1]) B.add('solid', rbox(0.19, 0.02, 0.27, 0.005), '#f4efe6', T(s * 0.1, 0.035, 0, 0, 0, s * -0.05), { ao: false });
        B.add('solid', cyl(0.008, 0.008, 0.16, 5), '#2e2a2a', T(0.12, 0.05, 0.05, 0.6, Math.PI / 2), { ao: false });
      });
    book(furnMatrix(furn('house_1', 'table'), 0.12, 0.77, 0.12, 0.3), '#8a4a3c');
    book(furnMatrix(furn('house_2', 'table'), -0.12, 0.77, 0.12, -0.3), '#3f5a52');
    book(furnMatrix(furn('boathouse', 'workbench'), 0.1, 0.93, 0.05, 0.2), '#3f4e57');
    return B.build().get('solid')!;
  }, []);
  return <mesh geometry={geo} material={solidMaterial} castShadow name="guest-books" />;
}

function MendedNets() {
  const a = useActivity(ACTIVITY_KEYS.nets);
  const sections = Math.round(a?.value ?? 0);
  const total = netsData(a).sections;
  const group = useRef<Group>(null);
  const geo = useMemo(() => {
    const B = new GeoBuilder(9);
    const f = furn('boathouse', 'nets');
    for (let k = 0; k < Math.min(sections, 12); k++) {
      const x = -0.9 + (k % 4) * 0.55;
      const y = 1.0 + Math.floor(k / 4) * 0.42;
      B.at(furnMatrix(f, x, y, 0.09), () => {
        for (let r = 0; r < 3; r++) {
          B.add('solid', box(0.34, 0.012, 0.012), '#efe2bf', T(0, -0.1 + r * 0.1, 0), { ao: false });
          B.add('solid', box(0.012, 0.3, 0.012), '#efe2bf', T(-0.12 + r * 0.12, 0, 0), { ao: false });
        }
      });
    }
    void total;
    return B.build().get('solid') ?? null;
  }, [sections, total]);
  useEffect(() => () => geo?.dispose(), [geo]);
  useWallHide(group, 'boathouse', 'back');
  return <group ref={group}>{geo ? <mesh geometry={geo} material={solidMaterial} name="mended-nets" /> : null}</group>;
}

// ---------------------------------------------------------------------------
// Clocks (world time), steam (espresso, kettles, cups in hand)
// ---------------------------------------------------------------------------

const CLOCKS: { building: string; u: number; y: number; r: number }[] = [
  { building: 'cafe', u: -4.4, y: 2.4, r: 0.24 },
  { building: 'house_1', u: 2.35, y: 2.35, r: 0.18 },
  { building: 'house_2', u: 2.35, y: 2.35, r: 0.18 },
];
function WallClocks() {
  const groups = useRef<Group[]>([]);
  const mats = useMemo(() => {
    const B = new GeoBuilder(2);
    B.add('h', rbox(0.025, 1, 0.012, 0.005), '#3a3236', T(0, 0.5, 0), { ao: false });
    return B.build().get('h')!;
  }, []);
  useEffect(() => {
    CLOCKS.forEach((c, i) => {
      const b = getBuilding(c.building);
      const g = groups.current[i];
      if (g) setFrom(g, wallMatrix(c.building, 'front', c.u, b.floorLift + c.y, 0.07));
    });
  }, []);
  useFrame(() => {
    const h = env.hours % 12;
    CLOCKS.forEach((c, i) => {
      const g = groups.current[i];
      if (!g) return;
      g.visible = slotFade(c.building, 'front') < 0.5;
      const [hh, mm] = g.children;
      if (hh) hh.rotation.z = -(h / 12) * Math.PI * 2;
      if (mm) mm.rotation.z = -((env.hours % 1) * Math.PI * 2);
    });
  });
  return (
    <>
      {CLOCKS.map((c, i) => (
        <group key={c.building} ref={(g) => void (g && (groups.current[i] = g))} name={`clock-${c.building}`}>
          <mesh geometry={mats} material={solidMaterial} scale={[1, c.r * 0.6, 1]} />
          <mesh geometry={mats} material={solidMaterial} scale={[0.7, c.r * 0.88, 1]} position={[0, 0, 0.01]} />
        </group>
      ))}
    </>
  );
}

const STEAM_N = 64;
function Steam() {
  const mesh = useMemo(() => makeBillboards(STEAM_N, 'puff', false, true), []);
  const puffs = useMemo(() => Array.from({ length: STEAM_N }, () => ({ life: -1, x: 0, y: 0, z: 0, s: 0.1, vx: 0 })), []);
  const acc = useRef(new Map<string, number>());
  const espresso = useMemo(() => new Vector3().setFromMatrixPosition(furnMatrix(furn('cafe', 'counter'), 1.94, 1.36, 0.12)), []);
  const kettles = useMemo(() => ['house_1', 'house_2'].map((h) => ({ h, p: new Vector3().setFromMatrixPosition(furnMatrix(furn(h, 'kitchen'), -0.5, 1.12, 0)) })), []);
  let cursor = 0;
  const spawn = (x: number, y: number, z: number, s: number) => {
    for (let k = 0; k < STEAM_N; k++) {
      const p = puffs[(cursor + k) % STEAM_N]!;
      if (p.life < 0) {
        Object.assign(p, { life: 0, x, y, z, s, vx: (Math.random() - 0.5) * 0.05 });
        cursor = (cursor + k + 1) % STEAM_N;
        return;
      }
    }
  };
  const emit = (key: string, rate: number, dt: number, x: number, y: number, z: number, s: number) => {
    const a = (acc.current.get(key) ?? 0) + rate * dt;
    let n = Math.floor(a);
    acc.current.set(key, a - n);
    while (n-- > 0) spawn(x + (Math.random() - 0.5) * 0.03, y, z + (Math.random() - 0.5) * 0.03, s);
  };
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const g = useGameStore.getState();
    const now = serverNow();
    // Espresso machine: steams while the barista is on duty (world behaviour).
    const bar = g.keepers.keeper_barista;
    if (bar?.present) emit('espresso', bar.task.includes('shot') ? 5 : 1.2, dt, espresso.x, espresso.y, espresso.z, 0.09);
    for (const k of kettles) {
      const a = g.activities[ACTIVITY_KEYS.kettle(k.h)];
      if (!a?.active) continue;
      const ready = now >= a.value;
      emit(`kettle-${k.h}`, ready ? 7 : now > a.value - 8000 ? 2.5 : 0.6, dt, k.p.x, k.p.y, k.p.z, ready ? 0.14 : 0.08);
    }
    // Cups in hand (real players holding a café drink).
    const lp = runtime.localPlayer;
    const me = g.sessionId ? g.players[g.sessionId] : undefined;
    if (me && lp.ready && isDrinkItem(me.held)) emit('me', 2.2, dt, lp.x + Math.sin(lp.rot) * 0.2 + Math.cos(lp.rot) * 0.18, lp.y + 1.05, lp.z + Math.cos(lp.rot) * 0.2 - Math.sin(lp.rot) * 0.18, 0.06);
    for (const [id, r] of runtime.remotes) {
      const info = g.players[id];
      const p = r.render;
      if (!info || !p?.visible || !isDrinkItem(info.held) || isHiddenIndoors(p.x, p.z)) continue;
      emit(id, 2.2, dt, p.x + Math.sin(p.rot) * 0.2 + Math.cos(p.rot) * 0.18, p.y + (info.seat ? 0.75 : 1.05), p.z + Math.cos(p.rot) * 0.2 - Math.sin(p.rot) * 0.18, 0.06);
    }
    const alpha = mesh.geometry.getAttribute('aAlpha');
    _c.set('#f4f1ea');
    for (let i = 0; i < STEAM_N; i++) {
      const p = puffs[i]!;
      if (p.life < 0) {
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        alpha.setX(i, 0);
        continue;
      }
      p.life += dt / 1.6;
      if (p.life >= 1) {
        p.life = -1;
        continue;
      }
      p.x += p.vx * dt;
      const y = p.y + p.life * 0.5;
      const s = p.s * (1 + p.life * 2.5);
      mesh.setMatrixAt(i, _m.makeScale(s, s, s).setPosition(p.x + Math.sin(p.life * 6 + i) * 0.03, y, p.z));
      mesh.setColorAt(i, _c);
      alpha.setX(i, Math.sin(p.life * Math.PI) * 0.5);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    alpha.needsUpdate = true;
  });
  return <primitive object={mesh} />;
}

export function IndoorActivities() {
  return (
    <group name="activities-indoor">
      <Chalkboard />
      <PianoNotes />
      <Spotlight activityKey={ACTIVITY_KEYS.stage} color="#ffe3b0" strength={1} />
      <Spotlight activityKey={ACTIVITY_KEYS.lectern} color="#fff0d0" strength={0.7} />
      <Curiosities />
      <NoticePapers />
      <PollSlate />
      <WorkshopProject />
      <HearthFire house="house_1" />
      <HearthFire house="house_2" />
      <Books />
      <MendedNets />
      <WallClocks />
      <Steam />
    </group>
  );
}
