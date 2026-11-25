/**
 * Day/night lighting from the synchronized clock: a single key light (sun by
 * day, moon by night) with a shadow frustum fitted and texel-snapped to the
 * camera's view, plus a hemisphere fill. Fog follows the camera distance.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Color, Fog, Matrix4, Vector3, type DirectionalLight, type HemisphereLight, type OrthographicCamera } from 'three';
import { env } from './env.js';

const _fwd = new Vector3();
const _focus = new Vector3();
const _lm = new Matrix4();
const _li = new Matrix4();
const _p = new Vector3();
const _up = new Vector3(0, 1, 0);
const MOON = new Color('#a9b8e8');

export function Lighting({ shadows, mapSize }: { shadows: boolean; mapSize: number }) {
  const sun = useRef<DirectionalLight>(null);
  const hemi = useRef<HemisphereLight>(null);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as OrthographicCamera;
  const size = useThree((s) => s.size);

  useEffect(() => {
    scene.fog = new Fog(env.fogColor.getHex(), 80, 260);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  useEffect(() => {
    const s = sun.current;
    if (!s) return;
    s.shadow.mapSize.set(mapSize, mapSize);
    s.shadow.map?.dispose();
    s.shadow.map = null as never;
  }, [mapSize]);

  useFrame(() => {
    // Ground focus = where the view ray through the screen centre meets y≈1.
    camera.getWorldDirection(_fwd);
    const t = (1 - camera.position.y) / (_fwd.y || -1);
    _focus.copy(camera.position).addScaledVector(_fwd, t);
    env.focus.copy(_focus);
    const zoom = camera.zoom || 1;
    const halfW = (camera.right - camera.left) / (2 * zoom);
    const halfH = (camera.top - camera.bottom) / (2 * zoom);
    const radius = Math.min(110, Math.hypot(halfW, halfH * 1.75) + 3);
    env.viewRadius = radius;
    env.cameraZoom = zoom;
    void size;

    const s = sun.current;
    if (s) {
      const fade = Math.min(1, Math.max(0, (env.sunElevation + 0.02) / 0.12));
      if (env.sunIntensity > 0.05 || env.sunElevation > 0) {
        s.intensity = env.sunIntensity * fade;
        s.color.copy(env.sunColor);
      } else {
        s.intensity = env.moonIntensity;
        s.color.copy(MOON);
      }
      // Texel-snapped shadow box around the focus.
      const dist = 90;
      const texel = (radius * 2) / Math.max(256, s.shadow.mapSize.x);
      _lm.lookAt(env.keyDir, new Vector3(0, 0, 0), _up);
      _li.copy(_lm).invert();
      _p.copy(_focus).applyMatrix4(_li);
      _p.x = Math.round(_p.x / texel) * texel;
      _p.y = Math.round(_p.y / texel) * texel;
      _p.applyMatrix4(_lm);
      s.target.position.copy(_p);
      s.position.copy(_p).addScaledVector(env.keyDir, dist);
      s.target.updateMatrixWorld();
      const sc = s.shadow.camera;
      if (sc.right !== radius) {
        sc.left = -radius;
        sc.right = radius;
        sc.top = radius;
        sc.bottom = -radius;
        sc.near = 1;
        sc.far = dist + 70;
        sc.updateProjectionMatrix();
      }
      s.castShadow = shadows;
    }
    const h = hemi.current;
    if (h) {
      h.color.copy(env.hemiSky);
      h.groundColor.copy(env.hemiGround);
      h.intensity = env.hemiIntensity;
    }
    const fog = scene.fog as Fog | null;
    if (fog) {
      fog.color.copy(env.fogColor);
      const camDist = camera.position.distanceTo(_focus);
      fog.near = camDist + 18 / env.fogDensity;
      fog.far = camDist + (zoom < 12 ? 260 : 150) / env.fogDensity;
    }
  });

  return (
    <>
      <hemisphereLight ref={hemi} intensity={1} />
      <directionalLight
        ref={sun}
        castShadow={shadows}
        intensity={2.5}
        shadow-mapSize={[mapSize, mapSize]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.035}
        shadow-radius={3}
      />
    </>
  );
}
