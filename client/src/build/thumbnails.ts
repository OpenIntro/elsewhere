/**
 * Palette thumbnails rendered from the real piece templates with the main
 * renderer (offscreen render target → data URL), once, the first time build
 * mode opens. Same light direction as the iso camera so tiles look like the world.
 */
import { Box3, Color, DirectionalLight, HemisphereLight, Mesh, OrthographicCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { PIECE_KINDS, PIECES, type PieceKind } from '@elsewhere/shared';
import { lampGlassMaterial, pieceGlassMaterial, pieceMaterial } from './materials.js';
import { templateFor } from './meshes.js';

const SIZE = 112;

export function renderThumbnails(gl: WebGLRenderer, variants: (kind: PieceKind) => string): Record<string, string> {
  const out: Record<string, string> = {};
  const rt = new WebGLRenderTarget(SIZE, SIZE, { samples: 4 });
  rt.texture.colorSpace = SRGBColorSpace;
  const scene = new Scene();
  scene.add(new HemisphereLight(new Color('#fff4e2'), new Color('#7a6a58'), 2.0));
  const sun = new DirectionalLight(new Color('#fff0dc'), 2.6);
  sun.position.set(-4, 8, 6);
  scene.add(sun);
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const prevTarget = gl.getRenderTarget();
  const prevClear = gl.getClearColor(new Color());
  const prevAlpha = gl.getClearAlpha();
  const prevShadow = gl.shadowMap.autoUpdate;
  gl.shadowMap.autoUpdate = false;
  try {
    for (const kind of PIECE_KINDS) {
      const t = templateFor(kind, variants(kind));
      const meshes: Mesh[] = [];
      const box = new Box3();
      for (const [bucket, geo] of t) {
        const m = new Mesh(geo, bucket === 'glass' ? pieceGlassMaterial : bucket === 'glow' ? lampGlassMaterial : pieceMaterial);
        meshes.push(m);
        scene.add(m);
        geo.computeBoundingBox();
        box.union(geo.boundingBox!);
      }
      // Trim the buried footing so pieces sit in the tile.
      box.min.y = Math.max(box.min.y, -0.05);
      const c = box.getCenter(new Vector3());
      const size = box.getSize(new Vector3());
      const r = Math.max(size.x, size.y, size.z) * 0.62 + 0.05;
      cam.left = -r;
      cam.right = r;
      cam.top = r;
      cam.bottom = -r;
      const dir = new Vector3(1, 0.9, 1.25).normalize();
      cam.position.copy(c).addScaledVector(dir, 20);
      cam.lookAt(c);
      cam.updateProjectionMatrix();
      gl.setRenderTarget(rt);
      gl.setClearColor(0x000000, 0);
      gl.clear();
      gl.render(scene, cam);
      gl.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, pixels);
      // Flip Y.
      for (let y = 0; y < SIZE; y++) img.data.set(pixels.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
      ctx.putImageData(img, 0, 0);
      out[kind] = canvas.toDataURL('image/png');
      for (const m of meshes) scene.remove(m);
      void PIECES;
    }
  } finally {
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevClear, prevAlpha);
    gl.shadowMap.autoUpdate = prevShadow;
    rt.dispose();
  }
  return out;
}
