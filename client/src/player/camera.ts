/**
 * Camera controls API (player worker). The CameraRig reads this every frame;
 * UI buttons, keys and gestures call the actions.
 *
 *   import { cameraControls, useCameraStore } from '../player/index.js';
 *   cameraControls.rotateLeft() / rotateRight()   90° steps, eased (Q / R keys)
 *   cameraControls.zoomIn() / zoomOut()           one step, smooth (wheel / pinch / + -)
 *   cameraControls.setZoom(z)                     absolute, clamped to [ZOOM_MIN, ZOOM_MAX]
 *   cameraControls.toggleFree() / setFree(bool)   detach the camera to explore (drag pans)
 *   cameraControls.recenter()                     back to the player (ends free mode)
 *   useCameraStore(s => s.free | s.rotation | s.zoom)   low-frequency state for UI
 *
 * Zoom is persisted through settingsStore.controls.cameraZoom (debounced).
 * Per-frame camera output is published in runtime.view (see state/runtime.ts).
 */
import { create } from 'zustand';
import { clamp } from '@elsewhere/shared';
import { useSettingsStore } from '../state/settingsStore.js';

/**
 * Zoom = pixels per metre at the 1440×900 reference viewport (see viewportScaleFor).
 * Default frames a ~1.6 m character at ≈10% of the viewport height there
 * (screen height ≈ 0.8 · 1.6 m · zoom); MIN ≈ a 60 m wide overview, MAX ≈ close-up.
 */
export const ZOOM_MIN = 24;
export const ZOOM_MAX = 140;
export const ZOOM_DEFAULT = 70;
/** Zoom values persisted by older builds' default framing; treated as "never chose a zoom". */
const LEGACY_DEFAULT_ZOOMS: readonly number[] = [38];
/** Multiplicative zoom step for buttons/keys. */
export const ZOOM_STEP = 1.25;
/** Camera yaw at rotation index 0: camera sits at +X +Z looking north-west (classic iso). */
export const BASE_YAW = Math.PI / 4;
/** Camera elevation (radians above the horizon). True iso is 35.26°; slightly higher reads better. */
export const ELEVATION = (37 * Math.PI) / 180;
export const ROTATE_MS = 480;

export interface CameraState {
  /** Rotation index (any integer; yaw = BASE_YAW + rotation·90°). */
  rotation: number;
  /** Target zoom (the rig eases toward it). */
  zoom: number;
  /** Free-camera exploration (camera detached from the player). */
  free: boolean;
}

export const useCameraStore = create<CameraState>()(() => ({
  rotation: 0,
  zoom: initialZoom(),
  free: false,
}));

function initialZoom(): number {
  const saved = useSettingsStore.getState().controls.cameraZoom;
  if (typeof saved !== 'number' || LEGACY_DEFAULT_ZOOMS.includes(saved)) return ZOOM_DEFAULT;
  return clampZoom(saved);
}

export function clampZoom(z: number): number {
  return clamp(Number.isFinite(z) ? z : ZOOM_DEFAULT, ZOOM_MIN, ZOOM_MAX);
}

/** Mutable per-frame camera internals shared by the rig and input (not React state). */
export const cameraRuntime = {
  /** Current (animated) yaw. */
  yaw: BASE_YAW,
  /** Rotation tween. */
  yawFrom: BASE_YAW,
  yawTo: BASE_YAW,
  yawStart: 0,
  /** Current eased zoom (before viewport scaling). */
  zoom: useCameraStore.getState().zoom,
  /** Viewport scale applied on top of zoom (phones show a similar world extent). */
  viewportScale: 1,
  /** Free-camera focus (world X/Z). */
  freeX: 0,
  freeZ: 0,
  /** Set by recenter(): the rig re-snaps focus smoothly to the player. */
  recenterAt: 0,
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistZoom(z: number): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => useSettingsStore.getState().setControls({ cameraZoom: Math.round(z * 10) / 10 }), 600);
}

function rotateBy(steps: number): void {
  const s = useCameraStore.getState();
  const rotation = s.rotation + steps;
  cameraRuntime.yawFrom = cameraRuntime.yaw;
  cameraRuntime.yawTo = BASE_YAW + (rotation * Math.PI) / 2;
  cameraRuntime.yawStart = performance.now();
  useCameraStore.setState({ rotation });
}

export const cameraControls = {
  /** Orbit the camera 90° counter-clockwise (seen from above). */
  rotateLeft(): void {
    rotateBy(-1);
  },
  /** Orbit the camera 90° clockwise (seen from above). */
  rotateRight(): void {
    rotateBy(1);
  },
  zoomIn(): void {
    cameraControls.setZoom(useCameraStore.getState().zoom * ZOOM_STEP);
  },
  zoomOut(): void {
    cameraControls.setZoom(useCameraStore.getState().zoom / ZOOM_STEP);
  },
  /** Multiply the zoom target (wheel / pinch). */
  zoomBy(factor: number): void {
    cameraControls.setZoom(useCameraStore.getState().zoom * factor);
  },
  setZoom(z: number): void {
    const zoom = clampZoom(z);
    if (zoom === useCameraStore.getState().zoom) return;
    useCameraStore.setState({ zoom });
    persistZoom(zoom);
  },
  setFree(free: boolean): void {
    if (free === useCameraStore.getState().free) return;
    if (free) {
      cameraRuntime.freeX = runtimeFocus.x;
      cameraRuntime.freeZ = runtimeFocus.z;
    } else {
      cameraRuntime.recenterAt = performance.now();
    }
    useCameraStore.setState({ free });
  },
  toggleFree(): void {
    cameraControls.setFree(!useCameraStore.getState().free);
  },
  /** Snap back to the player (ends free mode). */
  recenter(): void {
    cameraControls.setFree(false);
    cameraRuntime.recenterAt = performance.now();
  },
  /** Pan the free camera by a world-space delta (enters free mode). */
  panBy(dx: number, dz: number): void {
    if (!useCameraStore.getState().free) cameraControls.setFree(true);
    cameraRuntime.freeX += dx;
    cameraRuntime.freeZ += dz;
  },
};

/** Current focus as last written by the rig (kept here to avoid a runtime import cycle). */
export const runtimeFocus = { x: 0, z: 0 };

/**
 * Viewport → zoom multiplier (1 at 1440×900). Fitted so the local character
 * reads at a similar size everywhere: ≈10% of the height on desktop, ≈11% of
 * the short side on a landscape phone (844×390 → 0.48) and ≈7.5% of the height
 * in portrait (390×844 → 0.70, leaving horizontal context). Height dominates;
 * width contributes a little. 1920×1080 → 1.22, 2560×1440 → 1.61.
 */
export function viewportScaleFor(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return clamp(Math.pow(h / 900, 0.725) * Math.pow(w / 1440, 0.238), 0.35, 2.2);
}

/** Ease-in-out cubic. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Screen-relative movement → world direction for a camera at `yaw`.
 * mx = screen right, my = screen up (both -1..1). Writes into `out`.
 */
export function screenToWorldDir(mx: number, my: number, yaw: number, out: { x: number; z: number }): { x: number; z: number } {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // Screen up = away from the camera on the ground plane = -(sin yaw, cos yaw); screen right = (cos yaw, -sin yaw).
  out.x = mx * c - my * s;
  out.z = -mx * s - my * c;
  return out;
}
