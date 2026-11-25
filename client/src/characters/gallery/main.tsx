/**
 * Dev-only character gallery (not part of the game build).
 * Open: http://localhost:<vite>/src/characters/gallery/index.html?view=grid
 * Views: grid | anims | preview | crowd | sequence | items   (+ &fixed=1 for manual time via window.__advance(seconds))
 */
import { OrthographicCamera } from '@react-three/drei';
import { Canvas, advance, useFrame, useThree } from '@react-three/fiber';
import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PCFShadowMap, Vector3, type Group } from 'three';
import { ACCESSORY_CATALOG, ANIM_STATES, APPEARANCE_CATALOG, ITEMS, SKIN_TONES, randomAppearance, type AnimState, type Appearance } from '@elsewhere/shared';
import { Character, CharacterPreview } from '../index.js';
import { characterCacheStats } from '../cache.js';
import { setCharacterNight } from '../lighting.js';
import type { Detail } from '../geometry.js';
import { characterPerf } from '../Character.js';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'grid';
const fixed = q.get('fixed') === '1';
const seed0 = Number(q.get('seed') ?? 1);
const zoomQ = q.get('zoom');
const night = q.get('night') === '1';
const detailQ = (q.get('detail') as Detail | null) ?? undefined;
setCharacterNight(night ? 1 : 0);

declare global {
  interface Window {
    __advance?: (seconds: number) => void;
    __setAnim?: (anim: AnimState) => void;
    __stats?: Record<string, number>;
    __ready?: boolean;
  }
}

let simT = 0;
if (fixed) {
  window.__advance = (seconds: number) => {
    const steps = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < steps; i++) {
      simT += 1 / 60;
      advance(simT, true);
    }
  };
}

const ISO = 30;
/** Screen-right and toward-camera directions on the ground for the iso camera at (+30,+30,+30). */
const RIGHT: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
const TOWARD: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
const FACE_CAM = Math.PI / 4;

function IsoCam({ zoom, target = [0, 0.8, 0] }: { zoom: number; target?: [number, number, number] }) {
  return <OrthographicCamera makeDefault zoom={zoom} near={0.1} far={400} position={[target[0] + ISO, target[1] + ISO, target[2] + ISO]} onUpdate={(c) => c.lookAt(...target)} />;
}

function Lights({ shadowSize = 14 }: { shadowSize?: number }) {
  if (night)
    return (
      <>
        <ambientLight intensity={0.35} color="#7d8bb5" />
        <directionalLight position={[18, 30, 10]} intensity={0.3} color="#7d8bb5" castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-shadowSize} shadow-camera-right={shadowSize} shadow-camera-top={shadowSize} shadow-camera-bottom={-shadowSize} />
        <pointLight position={[4, 3.4, 2]} intensity={6} distance={9} color="#ffc27a" />
      </>
    );
  return (
    <>
      <hemisphereLight args={['#fff4e3', '#7b6a55', 0.55]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[18, 30, 10]}
        intensity={2.0}
        color="#fff1dc"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-shadowSize}
        shadow-camera-right={shadowSize}
        shadow-camera-top={shadowSize}
        shadow-camera-bottom={-shadowSize}
        shadow-bias={-0.0005}
      />
    </>
  );
}

function Ground({ size = 60, color = '#b9b48f' }: { size?: number; color?: string }) {
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color={color} roughness={1} />
    </mesh>
  );
}

/** Lightweight DOM label that follows a 3D anchor (drei <Html> warns under React 19 re-renders). */
function Label({ text }: { text: string }) {
  const anchor = useRef<Group>(null);
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const el = useMemo(() => {
    const d = document.createElement('div');
    d.className = 'label';
    d.style.position = 'fixed';
    d.style.transform = 'translate(-50%, 0)';
    d.style.pointerEvents = 'none';
    d.textContent = text;
    return d;
  }, [text]);
  useEffect(() => {
    document.body.appendChild(el);
    return () => el.remove();
  }, [el]);
  const v = useMemo(() => new Vector3(), []);
  useFrame(() => {
    if (!anchor.current) return;
    anchor.current.getWorldPosition(v);
    v.project(camera);
    el.style.left = `${((v.x + 1) / 2) * size.width}px`;
    el.style.top = `${((1 - v.y) / 2) * size.height + 6}px`;
  });
  return <group ref={anchor} position={[0, -0.05, 0]} />;
}

function Placed({ x, z, yaw = FACE_CAM, children }: { x: number; z: number; yaw?: number; children: React.ReactNode }) {
  return (
    <group position={[x, 0, z]} rotation-y={yaw}>
      {children}
    </group>
  );
}

function gridPos(i: number, cols: number, sx: number, sz: number): [number, number] {
  const c = i % cols;
  const r = Math.floor(i / cols);
  const u = (c - (cols - 1) / 2) * sx;
  const v = r * sz;
  return [RIGHT[0] * u + TOWARD[0] * v, RIGHT[1] * u + TOWARD[1] * v];
}

function GridView() {
  const n = Number(q.get('n') ?? 12);
  const cols = Number(q.get('cols') ?? 6);
  const apps = useMemo(() => Array.from({ length: n }, (_, i) => randomAppearance(seed0 * 1000 + i)), []);
  const rows = Math.ceil(n / cols);
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 105)} target={[TOWARD[0] * ((rows - 1) * 2.4) / 2, 0.8, TOWARD[1] * ((rows - 1) * 2.4) / 2]} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {apps.map((a, i) => {
        const [x, z] = gridPos(i, cols, 1.45, 2.4);
        return (
          <Placed key={i} x={x} z={z}>
            <Character appearance={a} anim="idle" seed={i / n} detail={detailQ} />
            {q.get('labels') === '1' && <Label text={`#${seed0 * 1000 + i} ${a.body}/${a.face}/${a.hairStyle}`} />}
          </Placed>
        );
      })}
    </Canvas>
  );
}

function AnimsView() {
  const a = useMemo(() => randomAppearance(seed0), []);
  const states = ANIM_STATES;
  // Retrigger one-shots so a screenshot at any moment catches them mid-pose.
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeq((s) => s + 1), 2600);
    return () => clearInterval(id);
  }, []);
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 120)} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {states.map((s, i) => {
        const [x, z] = gridPos(i, states.length, 1.55, 0);
        return (
          <Placed key={s} x={x} z={z} yaw={s === 'walk' || s === 'run' ? FACE_CAM + 0.9 : FACE_CAM}>
            {s === 'sit' && (
              <mesh position={[0, 0.225, -0.08]} castShadow receiveShadow>
                <boxGeometry args={[0.7, 0.45, 0.5]} />
                <meshStandardMaterial color="#8a6a4c" roughness={0.9} />
              </mesh>
            )}
            <group position={[0, s === 'sit' ? 0.45 : 0, 0]}>
              <Character appearance={a} anim={s} animSeq={s === 'wave' || s === 'interact' ? seq : 0} seed={0.2 + i * 0.1} />
            </group>
            <Label text={s} />
          </Placed>
        );
      })}
    </Canvas>
  );
}

function PreviewView() {
  const [seed, setSeed] = useState(seed0);
  const [anim, setAnim] = useState<AnimState>((q.get('anim') as AnimState) ?? 'idle');
  const [seq, setSeq] = useState(0);
  const a = useMemo(() => randomAppearance(seed), [seed]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 12 }}>
      <div style={{ width: Number(q.get('w') ?? 520), height: Number(q.get('h') ?? 640), background: 'radial-gradient(circle at 50% 40%, #f6eee2, #dccdb6)', borderRadius: 18 }}>
        <CharacterPreview appearance={a} anim={anim} animSeq={seq} spin={Number(q.get('spin') ?? 0.45)} held={(q.get('held') as never) ?? ''} variant={q.get('variant') === 'npc' ? 'npc' : 'player'} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={() => setSeed((s) => s + 1)}>next look</button>
        {ANIM_STATES.map((s) => (
          <button
            key={s}
            onClick={() => {
              setAnim(s);
              setSeq((x) => x + 1);
            }}
          >
            {s}
          </button>
        ))}
        <span>seed {seed}</span>
      </div>
    </div>
  );
}

function Stats() {
  const gl = useThree((s) => s.gl);
  const acc = useRef({ frames: 0, t: 0, fps: 0 });
  const el = useMemo(() => {
    const d = document.createElement('div');
    d.className = 'hud';
    d.textContent = 'measuring…';
    return d;
  }, []);
  useEffect(() => {
    document.body.appendChild(el);
    return () => el.remove();
  }, [el]);
  useFrame((_, dt) => {
    const a = acc.current;
    a.frames++;
    a.t += dt;
    if (a.t >= 1) {
      a.fps = a.frames / a.t;
      const frames = a.frames;
      a.frames = 0;
      a.t = 0;
      const info = gl.info;
      const cache = characterCacheStats();
      const animMsPerFrame = characterPerf.ms / Math.max(1, frames);
      characterPerf.ms = 0;
      characterPerf.updates = 0;
      const stats = { fps: Math.round(a.fps * 10) / 10, calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, programs: info.programs?.length ?? 0, charGeometries: cache.geometries, charVertices: cache.vertices, animMsPerFrame: Math.round(animMsPerFrame * 100) / 100 };
      window.__stats = stats;
      el.textContent = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
  });
  return null;
}

const CROWD_ANIMS: AnimState[] = ['walk', 'walk', 'run', 'idle', 'idle', 'dance', 'wave', 'idle', 'walk', 'sit'];

function Walker({ i, a }: { i: number; a: Appearance }) {
  const g = useRef<Group>(null);
  const anim = CROWD_ANIMS[i % CROWD_ANIMS.length]!;
  const moving = anim === 'walk' || anim === 'run';
  const speed = anim === 'run' ? 6 : 3.2;
  const r = 2 + (i % 7) * 1.3;
  const ang0 = i * 2.39996;
  const cx = ((i * 37) % 11) - 5;
  const cz = ((i * 53) % 11) - 5;
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (anim !== 'wave') return;
    const id = setInterval(() => setSeq((s) => s + 1), 3000);
    return () => clearInterval(id);
  }, [anim]);
  useFrame((st) => {
    const o = g.current;
    if (!o) return;
    if (moving) {
      const w = speed / r;
      const ang = ang0 + st.clock.elapsedTime * w * (i % 2 ? 1 : -1);
      o.position.set(cx + Math.cos(ang) * r, 0, cz + Math.sin(ang) * r);
      // tangent direction
      const dx = -Math.sin(ang) * (i % 2 ? 1 : -1);
      const dz = Math.cos(ang) * (i % 2 ? 1 : -1);
      o.rotation.y = Math.atan2(dx, dz);
    } else {
      o.position.set(cx + Math.cos(ang0) * r * 0.5, anim === 'sit' ? 0.45 : 0, cz + Math.sin(ang0) * r * 0.5);
      o.rotation.y = FACE_CAM + Math.sin(i) * 0.8;
    }
  });
  return (
    <group ref={g}>
      <Character appearance={a} anim={anim} animSeq={seq} detail={detailQ} speed={moving ? speed : undefined} held={i % 9 === 4 ? (Object.keys(ITEMS)[i % 7] as never) : ''} />
    </group>
  );
}

function CrowdView() {
  const n = Number(q.get('n') ?? 50);
  const apps = useMemo(() => Array.from({ length: n }, (_, i) => randomAppearance(seed0 * 7919 + i)), [n]);
  return (
    <Canvas shadows={q.get('shadows') === '0' ? false : { type: PCFShadowMap }} dpr={1} gl={{ antialias: true, powerPreference: 'high-performance' }}>
      <IsoCam zoom={Number(zoomQ ?? 38)} target={[0, 0, 0]} />
      <color attach="background" args={['#cfd8c2']} />
      <Lights shadowSize={18} />
      <Ground size={80} color="#a9b48a" />
      {apps.map((a, i) => (
        <Walker key={i} i={i} a={a} />
      ))}
      <Stats />
    </Canvas>
  );
}

function SequenceView() {
  const [anim, setAnim] = useState<AnimState>((q.get('anim') as AnimState) ?? 'idle');
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    window.__setAnim = (s) => {
      setAnim(s);
      setSeq((x) => x + 1);
    };
  }, []);
  const a = useMemo(() => randomAppearance(seed0), []);
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1} frameloop={fixed ? 'never' : 'always'}>
      <IsoCam zoom={Number(zoomQ ?? 240)} target={[0, 0.8, 0]} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {anim === 'sit' && (
        <mesh position={[0, 0.225, -0.08]} castShadow receiveShadow>
          <boxGeometry args={[0.7, 0.45, 0.5]} />
          <meshStandardMaterial color="#8a6a4c" roughness={0.9} />
        </mesh>
      )}
      <Placed x={0} z={0} yaw={FACE_CAM + 0.5}>
        {/* stays mounted across states so cross-fades are visible; root lifts to the seat when sitting */}
        <SeatLift sitting={anim === 'sit'}>
          <Character appearance={a} anim={anim} animSeq={seq} seed={0.5} />
        </SeatLift>
      </Placed>
    </Canvas>
  );
}

/** Mimics the game moving the root onto the seat (snaps like the server teleport). */
function SeatLift({ sitting, children }: { sitting: boolean; children: React.ReactNode }) {
  return <group position={[0, sitting ? 0.45 : 0, 0]}>{children}</group>;
}

function ItemsView() {
  const a = useMemo(() => randomAppearance(seed0), []);
  const ids = [...Object.keys(ITEMS), 'mystery'];
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 120)} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {ids.map((id, i) => {
        const [x, z] = gridPos(i, ids.length, 1.3, 0);
        return (
          <Placed key={id} x={x} z={z}>
            <Character appearance={a} anim="idle" held={id as never} highlighted={i === 0} variant={i === ids.length - 1 ? 'npc' : 'player'} seed={i * 0.13} />
            <Label text={i === 0 ? `${id} (highlighted)` : i === ids.length - 1 ? `${id} (npc)` : id} />
          </Placed>
        );
      })}
    </Canvas>
  );
}

/** Every option of one slot on the same base character: ?view=catalog&slot=hairStyle */
function CatalogView() {
  const slot = q.get('slot') ?? 'hairStyle';
  const base = useMemo(() => randomAppearance(seed0), []);
  const isAcc = slot in ACCESSORY_CATALOG;
  const options = (isAcc ? ACCESSORY_CATALOG[slot as keyof typeof ACCESSORY_CATALOG] : APPEARANCE_CATALOG[slot as keyof typeof APPEARANCE_CATALOG]) ?? [];
  const cols = Number(q.get('cols') ?? Math.min(options.length, 7));
  const rows = Math.ceil(options.length / cols);
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 150)} target={[(TOWARD[0] * ((rows - 1) * 3.0)) / 2, 0.8, (TOWARD[1] * ((rows - 1) * 3.0)) / 2]} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {options.map((o, i) => {
        const a: Appearance = isAcc
          ? { ...base, hairStyle: slot === 'hat' && base.hairStyle === 'none' ? 'bob' : base.hairStyle, accessories: { ...base.accessories, [slot]: o.id } }
          : ({ ...base, [slot]: o.id } as Appearance);
        const [x, z] = gridPos(i, cols, 1.35, 3.0);
        return (
          <Placed key={o.id} x={x} z={z}>
            <Character appearance={a} anim="idle" seed={i * 0.11} />
            <Label text={o.id} />
          </Placed>
        );
      })}
    </Canvas>
  );
}

/** Every skin tone × a set of faces: ?view=tones */
function TonesView() {
  const faces = (q.get('faces') ?? 'smile,calm,grin,sleepy,wink,button,starry,grumpy,surprised').split(',');
  const hairs = ['buzz', 'bob', 'curly', 'none', 'ponytail', 'swoop', 'afro', 'long', 'spiky'];
  const hairCols = ['ink', 'chestnut', 'snow', 'auburn', 'wheat', 'ink', 'ash', 'moss', 'ink'];
  const tones = SKIN_TONES.map((t) => t.id);
  const cols = faces.length;
  const base = useMemo(() => randomAppearance(seed0), []);
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 70)} target={[(TOWARD[0] * ((tones.length - 1) * 1.9)) / 2, 0.8, (TOWARD[1] * ((tones.length - 1) * 1.9)) / 2]} />
      <color attach="background" args={[night ? '#1d2233' : '#e9dfcf']} />
      <Lights shadowSize={20} />
      <Ground size={80} color={night ? '#3a3f4f' : '#b9b48f'} />
      {tones.flatMap((tone, r) =>
        faces.map((face, i) => {
          const [x, z] = gridPos(r * cols + i, cols, 1.25, 1.9);
          const a = { ...base, skin: tone, face, hairStyle: hairs[(i + r) % hairs.length], hairColor: hairCols[(i * 3 + r) % hairCols.length], accessories: { hat: 'none', eyewear: 'none', neck: 'none', back: 'none' } } as Appearance;
          return (
            <Placed key={`${tone}-${face}`} x={x} z={z}>
              <Character appearance={a} anim="idle" seed={(r * cols + i) * 0.07} detail={detailQ} />
            </Placed>
          );
        }),
      )}
    </Canvas>
  );
}

/** Same characters at high / medium / low detail: ?view=detail */
function DetailView() {
  const n = Number(q.get('n') ?? 4);
  const apps = useMemo(() => Array.from({ length: n }, (_, i) => randomAppearance(seed0 * 100 + i)), []);
  const levels: Detail[] = ['high', 'medium', 'low'];
  return (
    <Canvas shadows={{ type: PCFShadowMap }} dpr={1}>
      <IsoCam zoom={Number(zoomQ ?? 120)} target={[(TOWARD[0] * 2 * 3.4) / 2, 0.8, (TOWARD[1] * 2 * 3.4) / 2]} />
      <color attach="background" args={['#e9dfcf']} />
      <Lights />
      <Ground />
      {levels.flatMap((lv, r) =>
        apps.map((a, i) => {
          const [x, z] = gridPos(r * n + i, n, 1.6, 3.4);
          return (
            <Placed key={`${lv}-${i}`} x={x} z={z}>
              <Character appearance={a} anim="idle" seed={i * 0.2} detail={lv} />
              {i === 0 && <Label text={lv} />}
            </Placed>
          );
        }),
      )}
    </Canvas>
  );
}

function App() {
  useEffect(() => {
    const id = setTimeout(() => (window.__ready = true), 300);
    return () => clearTimeout(id);
  }, []);
  switch (view) {
    case 'anims':
      return <AnimsView />;
    case 'preview':
      return <PreviewView />;
    case 'crowd':
      return <CrowdView />;
    case 'sequence':
      return <SequenceView />;
    case 'items':
      return <ItemsView />;
    case 'catalog':
      return <CatalogView />;
    case 'tones':
      return <TonesView />;
    case 'detail':
      return <DetailView />;
    default:
      return <GridView />;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
