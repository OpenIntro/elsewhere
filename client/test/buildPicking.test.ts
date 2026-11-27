/**
 * Build picking (client/src/build/picking.ts): pieces thinned for the local player are looked through,
 * but selecting (remove / report) falls back to a thinned piece when nothing solid is behind it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, OrthographicCamera } from 'three';
import { view3d } from '../src/player/picking.js';
import { pickPiece, pickPieceHit, pickTargets } from '../src/build/picking.js';

function wallMesh(ids: string[], xs: number[], fades: number[]) {
  const geo = new BoxGeometry(0.2, 2.6, 2);
  geo.setAttribute('aFade', new InstancedBufferAttribute(new Float32Array(fades), 1));
  geo.setAttribute('aCut', new InstancedBufferAttribute(new Float32Array(ids.length), 1));
  const mesh = new InstancedMesh(geo, new MeshBasicMaterial(), ids.length);
  xs.forEach((x, i) => mesh.setMatrixAt(i, new Matrix4().makeTranslation(x, 1.3, 0)));
  mesh.updateMatrixWorld();
  const t = { mesh, ids };
  pickTargets.add(t);
  return t;
}

function setup() {
  // Looking along -X from x = +20 at height 1.3: the screen centre ray hits walls at larger x first.
  const cam = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
  cam.position.set(20, 1.3, 0);
  cam.lookAt(0, 1.3, 0);
  cam.updateMatrixWorld();
  view3d.camera = cam;
  view3d.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLElement;
}

afterEach(() => {
  pickTargets.clear();
  view3d.camera = null;
  view3d.canvas = null;
});

describe('build picking through thinned pieces', () => {
  it('a solid piece behind a thinned wall wins (aiming / selecting looks through the veil)', () => {
    setup();
    wallMesh(['near', 'far'], [2, -2], [0.8, 0]);
    expect(pickPieceHit(50, 50)?.id).toBe('far');
    expect(pickPiece(50, 50)).toBe('far');
  });
  it('a thinned wall with nothing solid behind it: aiming looks through, selecting picks the wall', () => {
    setup();
    wallMesh(['near'], [2], [0.8]);
    expect(pickPieceHit(50, 50)).toBeNull();
    expect(pickPiece(50, 50)).toBe('near');
  });
  it('a roof all but gone over your head (fade 0.99) is never selected by the fallback', () => {
    setup();
    wallMesh(['gone'], [2], [0.99]);
    expect(pickPiece(50, 50)).toBeNull();
  });
});
