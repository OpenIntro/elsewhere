/**
 * WORLD CONTRACT — owned by the world worker.
 * <World /> renders the island EXACTLY from @elsewhere/shared world data
 * (terrain, paths, decks, buildings, structures, nature, interactables) plus
 * environment (sky, water, lighting, day/night from the shared clock) and
 * synced object visuals (lights on/off, doors open, bell, pickups, fountain
 * stage, runes, portal) read from useGameStore(s => s.objects).
 *
 * Quality (settings store `graphics`, low/medium/high) drives shadows, shadow
 * map size, point-light budget, terrain resolution, decoration/particle
 * density, pixel-ratio cap and the vignette overlay (see env.ts QUALITY).
 *
 * Dev-only overrides (URL params, never sent to the server):
 *   ?time=0.8  ?fountain=0..3  ?portal=1  ?runes=1  ?doors=1  ?weather=fog|haze
 *   ?quality=low|medium|high   ?cam=<location id>|island|x,z,zoom   ?inside=<building id> (force its cutaway)
 * and window.__ELSEWHERE_WORLD__ (set overrides at runtime, renderer stats, coverage).
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { ACESFilmicToneMapping, Vector3, type OrthographicCamera } from 'three';
import { INTERACTABLES, timeOfDayAt } from '@elsewhere/shared';
import { serverNow, useGameStore } from '../state/gameStore.js';
import { useSettingsStore } from '../state/settingsStore.js';
import { Architecture, buildWorld } from './Architecture.js';
import { coverageReport, markRepresented } from './coverage.js';
import { DEV_CAMERA_PRESETS, devOverrides, env, QUALITY, updateEnvironment, type DevOverrides } from './env.js';
import { Cutaway } from './Cutaway.js';
import { cutaway } from './cutaway.js';
import { Fountain } from './Fountain.js';
import { Lamps } from './Lamps.js';
import { Life } from './Life.js';
import { Lighting } from './Lighting.js';
import { Mechanisms } from './Mechanisms.js';
import { Nature } from './Nature.js';
import { Pickups } from './Pickups.js';
import { Sky } from './Sky.js';
import { Terrain } from './Terrain.js';
import { Unknown } from './Unknown.js';
import { Water } from './Water.js';

export interface WorldProps {
  /** Kept for API compatibility; the world uses its own per-quality terrain resolution. */
  terrainResolution?: number;
}

function currentTimeOfDay(): number {
  if (devOverrides.time !== null) return devOverrides.time;
  const { epochMs, dayLengthMs } = useGameStore.getState().clock;
  return timeOfDayAt(serverNow(), { epochMs, dayLengthMs });
}

function EnvironmentController() {
  useFrame((_, dt) => updateEnvironment(currentTimeOfDay(), Math.min(dt, 0.1)));
  return null;
}

/** Matches the player rig's camera elevation (player/camera.ts ELEVATION = 37°). */
const DEV_ELEVATION = (37 * Math.PI) / 180;
const ISO = new Vector3();
function DevCamera() {
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  useFrame(() => {
    const c = devOverrides.cam;
    if (!c) return;
    const y = 1;
    const yaw = c.yaw ?? Math.PI / 4;
    ISO.set(Math.sin(yaw) * Math.cos(DEV_ELEVATION), Math.sin(DEV_ELEVATION), Math.cos(yaw) * Math.cos(DEV_ELEVATION));
    camera.position.set(c.x + ISO.x * 160, y + ISO.y * 160, c.z + ISO.z * 160);
    camera.lookAt(c.x, y, c.z);
    camera.far = 800;
    camera.zoom = c.zoom;
    camera.updateProjectionMatrix();
  });
  return null;
}

interface FrameStats {
  frames: number;
  acc: number;
  avgMs: number;
}
const stats: FrameStats = { frames: 0, acc: 0, avgMs: 0 };

function DevHook() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useFrame((_, dt) => {
    stats.acc += dt * 1000;
    stats.frames++;
    if (stats.frames >= 30) {
      stats.avgMs = stats.acc / stats.frames;
      stats.acc = 0;
      stats.frames = 0;
    }
  });
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = {
      overrides: devOverrides,
      presets: DEV_CAMERA_PRESETS,
      set(o: Partial<DevOverrides> & { camPreset?: string }) {
        const { camPreset, ...rest } = o;
        Object.assign(devOverrides, rest);
        if (camPreset && DEV_CAMERA_PRESETS[camPreset]) devOverrides.cam = { ...DEV_CAMERA_PRESETS[camPreset]! };
      },
      setQuality(q: 'low' | 'medium' | 'high') {
        useSettingsStore.getState().setGraphics(q);
      },
      info() {
        const r = gl.info.render;
        let shadowMap = 0;
        scene.traverse((o) => {
          const l = o as unknown as { isDirectionalLight?: boolean; castShadow: boolean; shadow?: { map: { width: number } | null; mapSize: { x: number } } };
          if (l.isDirectionalLight && l.shadow) shadowMap = l.castShadow && gl.shadowMap.enabled ? (l.shadow.map?.width ?? -l.shadow.mapSize.x) : 0;
        });
        return {
          shadowMap, calls: r.calls, triangles: r.triangles, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures, programs: gl.info.programs?.length ?? 0, avgFrameMs: stats.avgMs, pixelRatio: gl.getPixelRatio(), quality: env.quality.level };
      },
      /** Time N synchronous renders (CPU submit + GPU finish via readPixels). */
      bench(n = 20) {
        const px = new Uint8Array(4);
        const ctx = gl.getContext();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          gl.render(scene, camera);
          ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        }
        const ms = (performance.now() - t0) / n;
        const r = gl.info.render;
        return { msPerFrame: ms, calls: r.calls, triangles: r.triangles };
      },
      coverage: coverageReport,
      /** Heaviest meshes by triangle count (instancing included). */
      breakdown(top = 15) {
        const rows: { name: string; tris: number; count: number }[] = [];
        scene.traverse((o) => {
          const m = o as unknown as { isMesh?: boolean; geometry?: { index: { count: number } | null; attributes: { position: { count: number } } }; count?: number; name: string; parent: { name: string } | null };
          if (!m.isMesh || !m.geometry) return;
          const n = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
          const c = m.count ?? 1;
          rows.push({ name: `${m.parent?.name ?? ''}/${m.name}`, tris: Math.round(n * c), count: c });
        });
        return rows.sort((a, b) => b.tris - a.tris).slice(0, top);
      },
      env: () => ({ hours: env.hours, phase: env.phase, night: env.night, glow: env.glow, lightsOn: env.lightsOn }),
      cutaway: () => ({ active: cutaway.active?.id ?? null, amount: cutaway.amount }),
    };
    (window as unknown as { __ELSEWHERE_WORLD__?: typeof hook }).__ELSEWHERE_WORLD__ = hook;
    const cov = coverageReport();
    if (cov.missing.length) console.warn('[world] interactables without visuals:', cov.missing);
    return () => {
      delete (window as unknown as { __ELSEWHERE_WORLD__?: typeof hook }).__ELSEWHERE_WORLD__;
    };
  }, [gl, scene, camera]);
  return null;
}

function RendererSetup({ pixelRatioCap }: { pixelRatioCap: number }) {
  const gl = useThree((s) => s.gl);
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => {
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
  }, [gl]);
  useEffect(() => {
    setDpr(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  }, [setDpr, pixelRatioCap]);
  return null;
}

export function World(_props: WorldProps) {
  const graphics = useSettingsStore((s) => s.graphics);
  useEffect(() => {
    if (devOverrides.quality && devOverrides.quality !== useSettingsStore.getState().graphics) useSettingsStore.getState().setGraphics(devOverrides.quality);
  }, []);
  const Q = QUALITY[graphics] ?? QUALITY.medium;
  env.quality = Q;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const shadows = Q.shadows;
  // Runtime quality switches: own the renderer's shadow toggle and force programs to recompile.
  useEffect(() => {
    if (gl.shadowMap.enabled === shadows) return;
    gl.shadowMap.enabled = shadows;
    gl.shadowMap.needsUpdate = true;
    scene.traverse((o) => {
      const m = (o as unknown as { material?: { needsUpdate: boolean } | { needsUpdate: boolean }[] }).material;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
  }, [gl, scene, shadows]);

  useMemo(() => {
    const built = buildWorld();
    markRepresented(built.represented);
    // Dynamic systems draw these by construction (they map over INTERACTABLES by kind).
    markRepresented(INTERACTABLES.filter((i) => i.kind === 'pickup' || i.kind === 'fountain' || i.kind === 'portal').map((i) => i.id));
  }, []);

  return (
    <group name="world">
      <EnvironmentController />
      <DevCamera />
      <DevHook />
      <RendererSetup pixelRatioCap={Q.pixelRatioCap} />
      <Sky vignette={Q.post} />
      <Lighting shadows={shadows} mapSize={Q.shadowMapSize} />
      <Terrain resolution={Q.terrainResolution} />
      <Water detail={Q.waterDetail} />
      <Architecture shadows={shadows} />
      <Cutaway fill />
      <Mechanisms />
      <Nature shadows={shadows} density={Q.density} />
      <Lamps maxLights={Q.pointLights} density={Q.density} />
      <Fountain density={Q.density} />
      <Unknown density={Q.density} />
      <Pickups density={Q.density} />
      <Life density={Q.density} shadows={shadows} />
    </group>
  );
}
