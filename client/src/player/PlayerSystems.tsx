/**
 * Mounts input + interaction wiring inside the Canvas: keyboard, pointer
 * gestures on the canvas (tap-to-move / interact / player menu, drag-pan,
 * wheel + pinch zoom, twist-rotate), targeting at 10 Hz, background
 * NavGrid build, in-world markers, debug hook sections.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { BUILDINGS, INTERACTABLES, groundHeight, isGroundWalkable, isWalkable } from '@elsewhere/shared';
import { registerDebugQuery, registerDebugSection } from '../net/index.js';
import { runtime } from '../state/runtime.js';
import { useUiStore } from '../state/uiStore.js';
import { ELEVATION, ZOOM_MAX, ZOOM_MIN, cameraControls, cameraRuntime, useCameraStore } from './camera.js';
import { installInput, installPointer } from './input.js';
import { installInteraction, interactWith, target, updateTargeting } from './interaction.js';
import { DestinationMarker, TargetIndicator } from './Markers.js';
import { navGrid, prebuildNavGrid, walkTo, walkToPlayer } from './navigation.js';
import { groundFromScreen, pickAt, view3d, worldToScreen } from './picking.js';

/** Frame-time ring for the debug hook / load tests. */
const FRAMES = 600;
const frameMs = new Float32Array(FRAMES);
let frameCount = 0;

function frameStats() {
  const n = Math.min(frameCount, FRAMES);
  if (n === 0) return { n: 0, avg: 0, p95: 0, max: 0, over50: 0 };
  const arr = Array.from(frameMs.subarray(0, n)).sort((a, b) => a - b);
  let sum = 0;
  let over50 = 0;
  for (const v of arr) {
    sum += v;
    if (v > 50) over50++;
  }
  return { n, avg: sum / n, p95: arr[Math.floor(n * 0.95)]!, max: arr[n - 1]!, over50 };
}

export function PlayerSystems() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  view3d.camera = camera;

  useEffect(() => {
    view3d.canvas = gl.domElement;
    const el = gl.domElement;
    const offInput = installInput();
    const offInteraction = installInteraction();
    const offGrid = prebuildNavGrid();
    let lastHover = 0;
    const offPointer = installPointer(el, {
      tap(x, y, type) {
        const ui = useUiStore.getState();
        if (ui.playerMenu) ui.closePlayerMenu();
        if (useCameraStore.getState().free) cameraControls.recenter();
        const pick = pickAt(x, y, type);
        if (pick?.kind === 'player') {
          if (walkToPlayer(pick.sessionId, pick.at) === 'now') ui.openPlayerMenu(pick.sessionId, type === 'touch' ? 'touch' : 'pointer');
          return;
        }
        if (pick?.kind === 'interactable') {
          interactWith(pick.target.id);
          return;
        }
        const g = groundFromScreen(x, y);
        if (g) walkTo(g);
      },
      pan(dx, dy) {
        const zoom = cameraRuntime.zoom * cameraRuntime.viewportScale;
        const yaw = cameraRuntime.yaw;
        const s = Math.sin(yaw);
        const c = Math.cos(yaw);
        const wx = dx / zoom;
        const wy = dy / (zoom * Math.sin(ELEVATION));
        // Drag moves the world with the finger: focus moves the opposite way.
        cameraControls.panBy(-(c * wx + s * wy), -(-s * wx + c * wy));
      },
      hover(x, y) {
        const now = performance.now();
        if (now - lastHover < 80) return;
        lastHover = now;
        const pick = pickAt(x, y, 'mouse');
        el.style.cursor = pick ? 'pointer' : '';
      },
    });

    registerDebugSection('camera', () => {
      const s = useCameraStore.getState();
      return { yaw: cameraRuntime.yaw, rotation: s.rotation, zoomTarget: s.zoom, zoom: cameraRuntime.zoom, zoomMin: ZOOM_MIN, zoomMax: ZOOM_MAX, free: s.free, focus: { x: runtime.view.focusX, z: runtime.view.focusZ } };
    });
    registerDebugSection('target', () => ({ kind: target.kind, id: target.id }));
    registerDebugSection('frame', frameStats);
    registerDebugSection('remotes', () => {
      const out: { id: string; x: number; z: number; visible: boolean; speed: number }[] = [];
      for (const [id, r] of runtime.remotes) if (r.render) out.push({ id, x: r.render.x, z: r.render.z, visible: r.render.visible, speed: r.render.speed });
      return out;
    });
    registerDebugSection('navReady', () => navGrid().ready);
    registerDebugQuery('worldToScreen', (x: number, z: number, y?: number) => worldToScreen(x, y ?? groundHeight(x, z), z, { x: 0, y: 0 }));
    registerDebugQuery('groundFromScreen', (x: number, y: number) => groundFromScreen(x, y, { x: 0, z: 0 }));
    registerDebugQuery('isWalkable', (x: number, z: number) => isWalkable({ x, z }));
    registerDebugQuery('interactable', (id: string) => INTERACTABLES.find((i) => i.id === id) ?? null);
    registerDebugQuery('groundWalkable', (x: number, z: number) => isGroundWalkable({ x, z }));
    registerDebugQuery('buildings', () => BUILDINGS.map((b) => ({ id: b.id, x: b.position.x, z: b.position.z, yaw: b.yaw, width: b.width, depth: b.depth })));
    registerDebugQuery('pick', (x: number, y: number, type?: string) => {
      const p = pickAt(x, y, type ?? 'mouse');
      return p ? { kind: p.kind, id: p.kind === 'player' ? p.sessionId : p.target.id } : null;
    });

    return () => {
      offPointer();
      offInput();
      offInteraction();
      offGrid();
      if (view3d.canvas === el) view3d.canvas = null;
    };
  }, [gl]);

  const acc = useRef(0);
  useFrame((_, dt) => {
    frameMs[frameCount % FRAMES] = dt * 1000;
    frameCount++;
    acc.current += dt;
    if (acc.current > 0.1) {
      acc.current = 0;
      updateTargeting();
    }
  });
  return (
    <>
      <TargetIndicator />
      <DestinationMarker />
    </>
  );
}
