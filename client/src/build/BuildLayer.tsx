/**
 * Renders every player-built piece (inside the Canvas):
 *  - one InstancedMesh per (kind, variant, material bucket) → hundreds of
 *    pieces cost a few dozen draw calls; shadows like the rest of the world;
 *  - window glass glows at night via the world's window shader, lamp glass
 *    and halos follow the world clock (env.glow);
 *  - upper storeys and roofs near and above the local player fade out
 *    (dithered, per instance) so a roof never hides you;
 *  - sign boards get their text drawn on a small canvas texture;
 *  - the build ghost (green = valid / red = refused) and the selected piece
 *    highlight of the remove tool.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SRGBColorSpace,
  type BufferGeometry,
  type Material,
} from 'three';
import { CONFIG, PIECES, footprint, groundHeight, type PieceKind, type PieceRecord } from '@elsewhere/shared';
import { registerDebugSection } from '../net/index.js';
import { runtime } from '../state/runtime.js';
import { makeBillboards } from '../world/billboard.js';
import { env } from '../world/env.js';
import { GHOST_BAD, GHOST_BAD_EMISSIVE, GHOST_OK, GHOST_OK_EMISSIVE, ghostMaterial, lampGlassMaterial, pieceDepthMaterial, pieceGlassMaterial, pieceMaterial } from './materials.js';
import { LAMP_GLOW_Y, SIGN_FACE, templateFor, templateTriangles, type Bucket } from './meshes.js';
import { pickTargets, type PickTarget } from './picking.js';
import { pieces, useBuildStore, variantFor } from './store.js';
import { renderThumbnails } from './thumbnails.js';

const MAT: Record<Bucket, Material> = { solid: pieceMaterial, glass: pieceGlassMaterial, glow: lampGlassMaterial };
const _m = new Matrix4();
const _r = new Matrix4();
const WARM = new Color('#ffc77e');
const LAMP_OFF = new Color('#8a8070');
const _c = new Color();

interface GroupEntry {
  key: string;
  kind: PieceKind;
  meshes: Map<Bucket, InstancedMesh>;
  target: PickTarget[];
  list: PieceRecord[];
  capacity: number;
  /** Fade state per instance (upper pieces only). */
  fade: Float32Array;
  upper: boolean;
}

function groupKey(p: PieceRecord): string {
  return `${p.kind}|${p.variant}|${p.kind === 'floor' && p.level > 0 ? 'u' : ''}`;
}

/** Pieces that may hide the player (they fade): anything above the ground, and every roof. */
function fades(p: PieceRecord): boolean {
  return p.level > 0 || PIECES[p.kind].layer === 'roof' || PIECES[p.kind].layer === 'gable';
}
/** Storey-tall ground pieces (walls, doorways, pillars) that thin out when they stand between the camera and the player. */
function screens(p: PieceRecord): boolean {
  return p.level === 0 && PIECES[p.kind].structural;
}

function signTexture(text: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9c3a2';
  g.fillRect(0, 0, 256, 128);
  // Painted-on look: soft vignette, warm ink.
  const grd = g.createRadialGradient(128, 64, 20, 128, 64, 150);
  grd.addColorStop(0, 'rgba(255,248,230,0.35)');
  grd.addColorStop(1, 'rgba(120,90,60,0.25)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#4a3627';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  let size = 34;
  g.font = `600 ${size}px Fraunces, Georgia, serif`;
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > 230 && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) {
    size = 24;
    g.font = `600 ${size}px Fraunces, Georgia, serif`;
  }
  const shown = lines.slice(0, 3);
  shown.forEach((l, i) => g.fillText(l, 128, 64 + (i - (shown.length - 1) / 2) * (size * 1.1), 240));
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function BuildLayer() {
  const root = useRef<Group>(null);
  const gl = useThree((s) => s.gl);
  const groups = useRef(new Map<string, GroupEntry>());
  const signs = useRef(new Map<string, { holder: Group; mat: MeshStandardMaterial; text: string }>());
  const seen = useRef(-1);
  const lastFade = useRef(0);

  const halos = useMemo(() => {
    const m = makeBillboards(256, 'glow', true);
    m.count = 0;
    m.name = 'build-lamp-halos';
    return m;
  }, []);
  const lights = useMemo(() => [new PointLight('#ffc480', 0, 9, 1.4), new PointLight('#ffc480', 0, 9, 1.4)], []);
  const signGeo = useMemo(() => new PlaneGeometry(SIGN_FACE.width, SIGN_FACE.height), []);

  // Ghost + selection meshes (imperative; updated from the store every frame).
  const ghost = useMemo(() => new Group(), []);
  const ghostKey = useRef('');
  const footprintMesh = useMemo(() => {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const m = new Mesh(g, new MeshBasicMaterial({ color: '#a6dcae', transparent: true, opacity: 0.32, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }));
    m.renderOrder = 6;
    return m;
  }, []);
  const selectMat = useMemo(() => new MeshStandardMaterial({ color: '#f0a48f', transparent: true, opacity: 0.5, depthWrite: false, emissive: new Color('#8a3322'), emissiveIntensity: 0.5 }), []);
  const selection = useMemo(() => new Group(), []);
  const selKey = useRef('');

  useEffect(() => {
    registerDebugSection('buildRender', () => {
      let drawCalls = 0;
      let triangles = 0;
      let instances = 0;
      for (const g of groups.current.values()) {
        for (const [bucket, mesh] of g.meshes) {
          if (mesh.count === 0) continue;
          drawCalls++;
          const geo = mesh.geometry;
          triangles += ((geo.index ? geo.index.count : geo.attributes.position!.count) / 3) * mesh.count;
          if (bucket === 'solid') instances += mesh.count;
        }
      }
      const info = gl.info.render;
      return { groups: groups.current.size, drawCalls, triangles: Math.round(triangles), instances, signs: signs.current.size, halos: halos.count, frame: { calls: info.calls, triangles: info.triangles }, programs: gl.info.programs?.length ?? 0 };
    });
  }, [gl, halos]);

  function ensureGroup(key: string, sample: PieceRecord, need: number): GroupEntry {
    let g = groups.current.get(key);
    if (g && g.capacity >= need) return g;
    const capacity = Math.max(8, Math.ceil(need * 1.5));
    const template = templateFor(sample.kind, sample.variant, sample.kind === 'floor' && sample.level > 0);
    if (g) {
      for (const m of g.meshes.values()) {
        root.current?.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
      for (const t of g.target) pickTargets.delete(t);
    }
    const meshes = new Map<Bucket, InstancedMesh>();
    const target: PickTarget[] = [];
    const fade = new Float32Array(capacity);
    for (const [bucket, geo] of template) {
      const cloned: BufferGeometry = geo.clone();
      if (bucket !== 'glow') cloned.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array(capacity), 1));
      const mesh = new InstancedMesh(cloned, MAT[bucket], capacity);
      mesh.count = 0;
      mesh.castShadow = bucket === 'solid';
      if (bucket === 'solid') mesh.customDepthMaterial = pieceDepthMaterial;
      mesh.receiveShadow = bucket !== 'glow';
      mesh.name = `build:${key}:${bucket}`;
      meshes.set(bucket, mesh);
      root.current?.add(mesh);
      if (bucket === 'solid') {
        const t: PickTarget = { mesh, ids: [] };
        target.push(t);
        pickTargets.add(t);
      }
    }
    g = { key, kind: sample.kind, meshes, target, list: [], capacity, fade, upper: false };
    groups.current.set(key, g);
    return g;
  }

  function rebuild(): void {
    const dirty = pieces.dirtyKinds;
    pieces.dirtyKinds = new Set();
    const byKey = new Map<string, PieceRecord[]>();
    for (const p of pieces.index.all()) {
      if (dirty && !dirty.has(p.kind)) continue;
      const k = groupKey(p);
      let l = byKey.get(k);
      if (!l) byKey.set(k, (l = []));
      l.push(p);
    }
    // Groups of rebuilt kinds that no longer have pieces.
    for (const g of groups.current.values()) {
      if ((dirty && !dirty.has(g.kind)) || byKey.has(g.key)) continue;
      g.list = [];
      for (const m of g.meshes.values()) m.count = 0;
      for (const t of g.target) t.ids = [];
    }
    for (const [key, list] of byKey) {
      const g = ensureGroup(key, list[0]!, list.length);
      g.list = list;
      g.upper = list.some((p) => fades(p) || screens(p));
      g.fade.fill(0);
      for (const [bucket, mesh] of g.meshes) {
        list.forEach((p, i) => {
          _m.makeRotationY((p.rot % 4) * (Math.PI / 2));
          _m.setPosition(p.x, p.y, p.z);
          mesh.setMatrixAt(i, _m);
        });
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        const fa = mesh.geometry.getAttribute('aFade') as InstancedBufferAttribute | undefined;
        if (fa) {
          (fa.array as Float32Array).fill(0);
          fa.needsUpdate = true;
        }
        mesh.computeBoundingSphere();
        void bucket;
      }
      for (const t of g.target) t.ids = list.map((p) => p.id);
    }
    syncSigns();
    syncHalos();
  }

  function syncSigns(): void {
    const want = new Map<string, PieceRecord>();
    for (const p of pieces.index.all()) if (p.kind === 'sign' && p.text) want.set(p.id, p);
    for (const [id, s] of signs.current) {
      const p = want.get(id);
      if (p && p.text === s.text) continue;
      root.current?.remove(s.holder);
      s.mat.map?.dispose();
      s.mat.dispose();
      signs.current.delete(id);
    }
    for (const [id, p] of want) {
      if (signs.current.has(id)) continue;
      const mat = new MeshStandardMaterial({ map: signTexture(p.text!), roughness: 0.9, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
      const mesh = new Mesh(signGeo, mat);
      const yaw = (p.rot % 4) * (Math.PI / 2);
      const holder = new Group();
      holder.position.set(p.x, p.y, p.z);
      holder.rotation.y = yaw;
      mesh.position.set(0, SIGN_FACE.y, SIGN_FACE.z);
      const back = new Mesh(signGeo, mat);
      back.position.set(0, SIGN_FACE.y, -SIGN_FACE.z);
      back.rotation.y = Math.PI;
      holder.add(mesh, back);
      holder.name = `sign:${id}`;
      root.current?.add(holder);
      signs.current.set(id, { holder, mat, text: p.text! });
    }
  }

  const lampList = useRef<PieceRecord[]>([]);
  function syncHalos(): void {
    const lamps = [...pieces.index.all()].filter((p) => PIECES[p.kind].light);
    lampList.current = lamps;
    const n = Math.min(lamps.length, 256);
    for (let i = 0; i < n; i++) {
      const p = lamps[i]!;
      halos.setMatrixAt(i, _m.makeScale(1.3, 1.3, 1.3).setPosition(p.x, p.y + LAMP_GLOW_Y, p.z));
    }
    halos.count = n;
    halos.instanceMatrix.needsUpdate = true;
  }

  function updateFade(dt: number): void {
    const lp = runtime.localPlayer;
    const k = 1 - Math.exp(-dt * 8);
    // Horizontal direction from the focus towards the camera (camera.ts: camera sits at +(sin yaw, cos yaw)).
    const cx = Math.sin(runtime.view.yaw);
    const cz = Math.cos(runtime.view.yaw);
    for (const g of groups.current.values()) {
      if (!g.upper || !g.list.length) continue;
      let changed = false;
      g.list.forEach((p, i) => {
        let target = 0;
        if (lp.ready) {
          const f = footprint(p.kind, p.x, p.z, p.rot);
          if (fades(p)) {
            // Roofs and upper storeys over (or right next to) the player step aside completely.
            const m = 2.4;
            if (p.y > lp.y + 1.2 && lp.x > f.minX - m && lp.x < f.maxX + m && lp.z > f.minZ - m && lp.z < f.maxZ + m) target = 1;
          } else if (screens(p)) {
            // Tall ground pieces between the camera and the player thin out (like the interiors' cutaway).
            const qx = Math.max(f.minX, Math.min(f.maxX, lp.x));
            const qz = Math.max(f.minZ, Math.min(f.maxZ, lp.z));
            const along = (p.x - lp.x) * cx + (p.z - lp.z) * cz;
            if (Math.hypot(qx - lp.x, qz - lp.z) < 2.6 && along > 0.15) target = 0.8;
          }
        }
        const cur = g.fade[i]!;
        const next = Math.abs(target - cur) < 0.01 ? target : cur + (target - cur) * k;
        if (next !== cur) {
          g.fade[i] = next;
          changed = true;
        }
      });
      if (!changed) continue;
      for (const mesh of g.meshes.values()) {
        const fa = mesh.geometry.getAttribute('aFade') as InstancedBufferAttribute | undefined;
        if (!fa) continue;
        (fa.array as Float32Array).set(g.fade.subarray(0, g.list.length));
        fa.needsUpdate = true;
      }
    }
  }

  function updateGhost(): void {
    const st = useBuildStore.getState();
    const g = st.ghost;
    const show = st.mode === 'place' && g !== null;
    ghost.visible = show;
    footprintMesh.visible = show;
    if (show && g) {
      const variant = variantFor(st.kind);
      const key = `${st.kind}|${variant}|${g.level}`;
      if (ghostKey.current !== key) {
        ghostKey.current = key;
        ghost.clear();
        for (const [bucket, geo] of templateFor(st.kind, variant, st.kind === 'floor' && g.level > 0)) {
          if (bucket === 'glow') continue;
          const m = new Mesh(geo, ghostMaterial);
          m.renderOrder = 7;
          ghost.add(m);
        }
      }
      const y = Number.isFinite(g.y) ? g.y : groundHeight(g.x, g.z) + g.level * CONFIG.building.storeyHeight;
      ghost.position.set(g.x, y + 0.01, g.z);
      ghost.rotation.y = st.rot * (Math.PI / 2);
      ghostMaterial.color.copy(g.ok ? GHOST_OK : GHOST_BAD);
      ghostMaterial.emissive.copy(g.ok ? GHOST_OK_EMISSIVE : GHOST_BAD_EMISSIVE);
      const f = footprint(st.kind, g.x, g.z, st.rot);
      footprintMesh.scale.set(f.maxX - f.minX + 0.1, 1, f.maxZ - f.minZ + 0.1);
      footprintMesh.position.set(g.x, (g.level > 0 ? y : groundHeight(g.x, g.z)) + 0.05, g.z);
      (footprintMesh.material as MeshBasicMaterial).color.copy(g.ok ? GHOST_OK : GHOST_BAD);
    }
    // Remove-tool selection highlight.
    const sel = st.mode !== 'off' && st.selected ? pieces.index.get(st.selected) : undefined;
    selection.visible = !!sel;
    if (sel) {
      const key = `${sel.id}`;
      if (selKey.current !== key) {
        selKey.current = key;
        selection.clear();
        for (const [bucket, geo] of templateFor(sel.kind, sel.variant, sel.kind === 'floor' && sel.level > 0)) {
          if (bucket === 'glow') continue;
          const m = new Mesh(geo, selectMat);
          m.renderOrder = 7;
          selection.add(m);
        }
        selection.position.set(sel.x, sel.y + 0.005, sel.z);
        selection.rotation.y = sel.rot * (Math.PI / 2);
        selection.scale.setScalar(1.015);
      }
    }
  }

  const thumbsTried = useRef(false);
  useFrame((_, dt) => {
    if (!thumbsTried.current && useBuildStore.getState().mode !== 'off') {
      thumbsTried.current = true;
      try {
        useBuildStore.getState().set({ thumbs: renderThumbnails(gl, (k) => variantFor(k)) });
      } catch (err) {
        console.warn('[build] palette thumbnails unavailable', err);
      }
    }
    if (seen.current !== pieces.version) {
      seen.current = pieces.version;
      rebuild();
    }
    const now = performance.now();
    if (now - lastFade.current > 50) {
      updateFade(Math.min(0.2, (now - lastFade.current) / 1000));
      lastFade.current = now;
    }
    updateGhost();
    // Lamps follow the world's evening glow.
    const on = env.glow > 0.04 ? Math.min(1, env.glow * 1.25) : 0;
    _c.copy(LAMP_OFF).lerp(WARM, on).multiplyScalar(1 + on * 1.6);
    lampGlassMaterial.color.copy(_c);
    const flick = 0.93 + 0.07 * Math.sin(env.time * 6.3);
    for (let i = 0; i < halos.count; i++) halos.setColorAt(i, _c.copy(WARM).multiplyScalar(on * 0.55 * flick));
    if (halos.instanceColor) halos.instanceColor.needsUpdate = true;
    // Two point lights for the lamps nearest the camera focus (no shadows).
    const lamps = lampList.current;
    if (lamps.length && on > 0) {
      const f = env.focus;
      const near = [...lamps].sort((a, b) => (a.x - f.x) ** 2 + (a.z - f.z) ** 2 - ((b.x - f.x) ** 2 + (b.z - f.z) ** 2)).slice(0, lights.length);
      lights.forEach((l, i) => {
        const p = near[i];
        l.intensity = p && env.quality.pointLights > 0 ? on * 5 : 0;
        if (p) l.position.set(p.x, p.y + LAMP_GLOW_Y, p.z);
      });
    } else for (const l of lights) l.intensity = 0;
  });

  useEffect(() => {
    const gs = groups.current;
    return () => {
      for (const g of gs.values()) for (const t of g.target) pickTargets.delete(t);
    };
  }, []);

  return (
    <group name="player-builds">
      <group ref={root} />
      <primitive object={halos} />
      <primitive object={ghost} />
      <primitive object={footprintMesh} />
      <primitive object={selection} />
      {lights.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </group>
  );
}
