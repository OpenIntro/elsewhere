/**
 * Trees, rocks and bushes from shared data (TREES/ROCKS/BUSHES — positions
 * match collision), plus non-solid ground cover (grass tufts, wildflowers,
 * extra ferns). Everything is instanced: one InstancedMesh per template.
 */
import { useMemo } from 'react';
import { BufferAttribute, Color, InstancedMesh, LatheGeometry, Matrix4, SphereGeometry, Vector2, Vector3, type BufferGeometry, type Material } from 'three';
import {
  BUSHES,
  DECKS,
  PATHS,
  ROCKS,
  TREES,
  collidesAt,
  deckAt,
  distanceToPolyline,
  getLocation,
  inlandDistance,
  mulberry32,
  terrainHeight,
  type TreeKind,
} from '@elsewhere/shared';
import { cone, cyl, GeoBuilder, lathe, T } from './geom.js';
import { barkMaterial, foliageMaterial, plantMaterial } from './materials.js';
import { fbm, groundColor, vnoise } from './Terrain.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const blobCache = new Map<string, BufferGeometry>();
/** Lumpy soft sphere (smooth normals) for canopies and bushes. */
function blob(r: number, seed: number, amp = 0.12, ws = 10, hs = 7): BufferGeometry {
  const key = `${r},${seed},${amp},${ws}`;
  let g = blobCache.get(key);
  if (g) return g;
  const s = new SphereGeometry(r, ws, hs);
  const pos = s.attributes.position as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = vnoise(v.x * 2.1 / r + seed * 3.1, v.z * 2.1 / r + v.y * 1.3 / r) - 0.5;
    v.multiplyScalar(1 + n * amp * 2);
    if (v.y < -r * 0.35) v.y = -r * 0.35 + (v.y + r * 0.35) * 0.4; // flattened underside
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  s.computeVertexNormals();
  g = s.toNonIndexed();
  blobCache.set(key, g);
  return g;
}

function tierProfile(r: number, h: number): [number, number][] {
  return [
    [0.001, h],
    [r * 0.4, h * 0.62],
    [r * 0.85, h * 0.16],
    [r, 0.0],
    [r * 0.75, -0.12],
    [0.001, -0.1],
  ];
}

/** A soft, rounded pine tier: a lathe with a pillowy profile and lumpy rim. */
function softTier(key: string, r: number, h: number, seed: number): BufferGeometry {
  let g = blobCache.get(key);
  if (g) return g;
  const prof: [number, number][] = [[0.001, h], [r * 0.32, h * 0.8], [r * 0.7, h * 0.45], [r * 0.95, h * 0.15], [r * 0.92, -0.04], [r * 0.6, -0.14], [0.001, -0.1]];
  const lat = new LatheGeometry(prof.map(([x, y]) => new Vector2(x, y)), 11);
  const pos = lat.attributes.position as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const a = Math.atan2(v.z, v.x);
    const k = 1 + 0.07 * Math.sin(a * 5 + seed) + 0.04 * (vnoise(v.x * 2 + seed, v.z * 2) - 0.5);
    pos.setXYZ(i, v.x * k, v.y, v.z * k);
  }
  lat.computeVertexNormals();
  g = lat.toNonIndexed();
  blobCache.set(key, g);
  return g;
}

function buildTree(kind: TreeKind, variant: number): BufferGeometry {
  const B = new GeoBuilder(77 + variant * 13);
  const no = { ao: false };
  const bark = '#6e5242';
  if (kind === 'pine') {
    B.add('t', cyl(0.15, 0.27, 1.5, 8), bark, T(0, 0.75, 0), { ...no, grad: 0.3 });
    const tiers = 3;
    for (let i = 0; i < tiers; i++) {
      const r = 1.75 - i * 0.45 + variant * 0.06;
      const h = 1.9 - i * 0.2;
      const y = 1.0 + i * 1.15;
      const col = new Color('#62795a').lerp(new Color('#6f875d'), i / tiers);
      B.add('t', softTier(`pine${i},${variant}`, r, h, i * 7 + variant), col, T(0, y, 0, i * 0.6 + variant), { ...no, radialFrom: [0, y + h * 0.25, 0], radialBlend: 0.6, underside: 0.16 });
    }
    B.add('t', blob(0.32, 33 + variant, 0.08, 8, 6), '#7a955e', T(0, 1.0 + tiers * 1.15 + 0.25, 0, 0, 0, 0, 1, 1.5, 1), { ...no, radialFrom: [0, 1.0 + tiers * 1.15 + 0.2, 0], radialBlend: 0.6 });
  } else if (kind === 'oak') {
    B.add('t', cyl(0.2, 0.34, 2.1, 9), bark, T(0, 1.05, 0), { ...no, grad: 0.3 });
    B.add('t', cyl(0.07, 0.12, 1.1, 6), bark, T(0.4, 2.1, 0.1, 0, 0.2, -0.75), no);
    B.add('t', cyl(0.07, 0.11, 1.0, 6), bark, T(-0.35, 2.15, -0.1, 0, -0.2, 0.7), no);
    const blobs: [number, number, number, number][] = [
      [0, 3.05, 0, 1.55], [0.95, 2.65, 0.35, 1.08], [-0.85, 2.75, -0.2, 1.12], [0.1, 3.72, -0.25, 1.02],
    ];
    const col = new Color('#7d9258');
    blobs.forEach(([x, y, z, r], k) => {
      B.add('t', blob(r, k + variant * 7, 0.1, 12, 8), col, T(x, y, z, k), { ...no, jitter: 0, radialFrom: [0, 3.0, 0], radialBlend: 0.78, underside: 0.34 });
    });
  } else if (kind === 'birch') {
    B.add('t', cyl(0.1, 0.15, 3.4, 8), '#e9e4d8', T(0, 1.7, 0, 0, 0.03, 0.02), no);
    for (let k = 0; k < 4; k++) B.add('t', cyl(0.12, 0.13, 0.07, 6, true), '#4a4440', T(0, 0.5 + k * 0.65, 0, k, 0, 0, 1, 1, 0.6 + (k % 3) * 0.2), no);
    const blobs: [number, number, number, number][] = [[0, 3.6, 0, 0.95], [0.45, 3.1, 0.2, 0.75], [-0.4, 3.2, -0.15, 0.78], [0.05, 4.25, 0.05, 0.7]];
    const bcol = new Color('#a6ab6c');
    blobs.forEach(([x, y, z, r], k) => {
      B.add('t', blob(r, 20 + k + variant * 5, 0.1, 11, 8), bcol, T(x, y, z, k, 0, 0, 1, 1.25, 1), { ...no, jitter: 0, radialFrom: [0, 3.5, 0], radialBlend: 0.78, underside: 0.32 });
    });
  } else {
    B.add('t', cyl(0.14, 0.24, 1.5, 8), bark, T(0, 0.75, 0, 0, 0.05, 0), { ...no, grad: 0.3 });
    const fr = { ...no, jitter: 0, radialFrom: [0, 2.2, 0] as [number, number, number], radialBlend: 0.78, underside: 0.32 };
    B.add('t', blob(1.3, 40 + variant, 0.1, 12, 8), '#83995b', T(0, 2.3, 0), fr);
    B.add('t', blob(0.8, 41 + variant, 0.1, 10, 7), '#83995b', T(0.7, 2.0, 0.3), fr);
    B.add('t', blob(0.75, 42 + variant, 0.1, 10, 7), '#83995b', T(-0.6, 2.1, -0.4), fr);
    const rnd = mulberry32(99 + variant);
    for (let k = 0; k < 8; k++) {
      const a = rnd() * Math.PI * 2;
      const y = 1.7 + rnd() * 1.4;
      const rr = Math.sqrt(Math.max(0, 1.3 * 1.3 - (y - 2.3) ** 2)) * 0.98;
      B.add('t', cyl(0.12, 0.12, 0.2, 5), k % 4 ? '#c0473a' : '#d9a03f', T(Math.cos(a) * rr, y, Math.sin(a) * rr, 0, 0, 0, 1, 0.9, 1), no);
    }
  }
  return B.build().get('t')!;
}

function rockGeometry(seed: number): BufferGeometry {
  const s = new SphereGeometry(1, 14, 10);
  const pos = s.attributes.position as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = fbm(v.x * 1.3 + seed, v.z * 1.3 + v.y * 1.1 - seed) - 0.5;
    v.multiplyScalar(1 + n * 0.55);
    v.y = v.y > 0 ? v.y * 0.62 : v.y * 0.35;
    pos.setXYZ(i, v.x, v.y + 0.12, v.z);
  }
  s.computeVertexNormals();
  const g = s.toNonIndexed();
  const nrm = g.attributes.normal as BufferAttribute;
  const p2 = g.attributes.position as BufferAttribute;
  const col = new Float32Array(nrm.count * 3);
  const base = new Color('#a39d90');
  const moss = new Color('#7a9852');
  const c = new Color();
  for (let i = 0; i < nrm.count; i++) {
    const ny = nrm.getY(i);
    const y = p2.getY(i);
    c.copy(base).multiplyScalar(0.85 + 0.25 * vnoise(p2.getX(i) * 3 + seed, p2.getZ(i) * 3));
    c.lerp(moss, Math.max(0, Math.min(1, (ny - 0.45) * 2.2)) * 0.85);
    c.multiplyScalar(0.7 + 0.3 * Math.min(1, (y + 0.1) / 0.6));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new BufferAttribute(col, 3));
  return g;
}

function bushGeometry(kind: 'shrub' | 'fern' | 'flowers' | 'reeds' | 'tuft', variant = 0): BufferGeometry {
  const B = new GeoBuilder(200 + variant);
  const no = { ao: false };
  if (kind === 'shrub') {
    const pts: [number, number, number, number][] = [[0, 0.45, 0, 0.6], [0.45, 0.35, 0.15, 0.42], [-0.4, 0.33, -0.1, 0.45], [0.1, 0.32, -0.45, 0.4]];
    pts.forEach(([x, y, z, r], k) => B.add('t', blob(r, 60 + k + variant * 4, 0.1, 10, 7), new Color('#7a9058'), T(x, y, z), { jitter: 0, ...no, radialFrom: [0, 0.3, 0], radialBlend: 0.75, underside: 0.32 }));
  } else if (kind === 'fern') {
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + variant;
      B.add('t', blob(0.5, 80 + k, 0.08, 6, 4), new Color('#5f8a4a').lerp(new Color('#7fa65a'), (k % 3) / 3), T(Math.cos(a) * 0.38, 0.22, Math.sin(a) * 0.38, -a + Math.PI / 2, 0, 0.5, 1.0, 0.12, 0.28), no);
    }
    B.add('t', blob(0.2, 90, 0.1, 8, 6), '#5f7a4b', T(0, 0.1, 0), no);
  } else if (kind === 'flowers') {
    const palettes = [['#e7a0a6', '#f4efe6'], ['#f1d27a', '#e98a3b'], ['#b9a2d8', '#9fc0e8'], ['#f4efe6', '#e7a0a6']];
    const pal = palettes[variant % palettes.length]!;
    B.add('t', blob(0.28, 100 + variant, 0.12, 8, 6), '#75904f', T(0, 0.16, 0, 0, 0, 0, 1.2, 0.7, 1.2), { ...no, radialFrom: [0, 0.05, 0], radialBlend: 0.8, underside: 0.3 });
    const rnd = mulberry32(300 + variant);
    for (let k = 0; k < 6; k++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 0.32;
      const h = 0.25 + rnd() * 0.25;
      B.add('t', cyl(0.014, 0.016, h, 3, true), '#6f8f4d', T(Math.cos(a) * r, h / 2, Math.sin(a) * r), no);
      B.add('t', blob(0.08, 110 + k, 0.1, 5, 4), pal[k % 2]!, T(Math.cos(a) * r, h, Math.sin(a) * r, 0, 0, 0, 1, 0.6, 1), no);
    }
  } else if (kind === 'reeds') {
    const rnd = mulberry32(400 + variant);
    for (let k = 0; k < 9; k++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 0.3;
      const h = 0.8 + rnd() * 0.7;
      B.add('t', cone(0.035, h, 4), new Color('#7f9a5c').lerp(new Color('#a3a86a'), rnd()), T(Math.cos(a) * r, h / 2, Math.sin(a) * r, 0, (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.25), no);
      if (k % 3 === 0) B.add('t', cyl(0.035, 0.035, 0.22, 6), '#6e5242', T(Math.cos(a) * r, h * 0.85, Math.sin(a) * r), no);
    }
  } else {
    // grass tuft: a soft clump of short, broad blades (tinted per instance to the ground colour)
    const rnd = mulberry32(500 + variant);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + rnd();
      const h = 0.16 + rnd() * 0.16;
      B.add('t', cone(0.08, h, 3), new Color(1, 1, 1).multiplyScalar(0.92 + 0.2 * (h / 0.32)), T(Math.cos(a) * 0.07, h / 2 - 0.02, Math.sin(a) * 0.07, a, Math.sin(a) * 0.3, Math.cos(a) * 0.3, 1, 1, 0.55), { ...no, jitter: 0, radialFrom: [0, -0.4, 0], radialBlend: 0.85 });
    }
  }
  return B.build().get('t')!;
}

// ---------------------------------------------------------------------------
// Instancing helper
// ---------------------------------------------------------------------------

interface Inst {
  m: Matrix4;
  c: Color;
}

/** Instanced meshes split into spatial cells so frustum culling (main + shadow pass) works. */
const CELL = 36;
function makeInstanced(geo: BufferGeometry, mat: Material, list: Inst[], shadows: boolean, receive = true): InstancedMesh[] {
  const cells = new Map<string, Inst[]>();
  const p = new Vector3();
  for (const it of list) {
    p.setFromMatrixPosition(it.m);
    const k = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(it);
  }
  const out: InstancedMesh[] = [];
  for (const items of cells.values()) {
    const mesh = new InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = shadows;
    mesh.receiveShadow = receive;
    mesh.computeBoundingSphere();
    out.push(mesh);
  }
  return out;
}

const tmpC = new Color();
function jitterColor(rnd: () => number, amt = 0.08, hue = 0.02): Color {
  return new Color().setHSL(0, 0, 1).offsetHSL(0, 0, 0).multiplyScalar(1 - amt + rnd() * amt * 2).offsetHSL((rnd() - 0.5) * hue, 0, 0);
}

function pathDist(x: number, z: number): number {
  let d = Infinity;
  for (const p of PATHS) d = Math.min(d, distanceToPolyline({ x, z }, p.points) - p.width / 2);
  return d;
}

export function Nature({ shadows, density }: { shadows: boolean; density: number }) {
  const meshes = useMemo(() => {
    const out: InstancedMesh[] = [];
    const rnd = mulberry32(0xa11ce);
    // Trees: 2 variants per kind.
    const kinds: TreeKind[] = ['pine', 'oak', 'birch', 'fruit'];
    for (const kind of kinds) {
      for (let v = 0; v < 2; v++) {
        const list: Inst[] = [];
        TREES.forEach((t, idx) => {
          if (t.kind !== kind || idx % 2 !== v) return;
          const y = terrainHeight(t.position.x, t.position.z) - 0.05;
          const s = t.scale;
          const m = T(t.position.x, y, t.position.z, t.yaw, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06, s * (0.95 + rnd() * 0.1), s * (0.92 + rnd() * 0.16), s * (0.95 + rnd() * 0.1));
          list.push({ m, c: jitterColor(rnd, 0.09, 0.03) });
        });
        // Canopies cast but do not receive shadow-map shadows: low-poly self-shadowing
        // shows up as faceted dark patches; sculpted normals + baked AO give the form.
        out.push(...makeInstanced(buildTree(kind, v), foliageMaterial, list, shadows, false));
      }
    }
    // Rocks.
    for (let v = 0; v < 3; v++) {
      const list: Inst[] = [];
      ROCKS.forEach((r, idx) => {
        if (idx % 3 !== v) return;
        const y = terrainHeight(r.position.x, r.position.z) - 0.1 * r.scale;
        list.push({ m: T(r.position.x, y, r.position.z, r.yaw, 0, 0, r.scale * 0.62, r.scale * 0.62, r.scale * 0.55), c: jitterColor(rnd, 0.08, 0.01) });
      });
      out.push(...makeInstanced(rockGeometry(v * 7.3 + 1), barkMaterial, list, shadows));
    }
    const pave0 = { cell: 0, grain: 0, scale: 1 };
    // Bushes from data.
    const bushLists = new Map<string, Inst[]>();
    const pushB = (key: string, it: Inst) => {
      let l = bushLists.get(key);
      if (!l) bushLists.set(key, (l = []));
      l.push(it);
    };
    const sqC = getLocation('town_square').center;
    BUSHES.forEach((b, idx) => {
      const y = terrainHeight(b.position.x, b.position.z);
      if (y < 0.05 && b.kind !== 'reeds') return;
      // Decorative only: keep plazas, paths and terraces clear.
      if (Math.hypot(b.position.x - sqC.x, b.position.z - sqC.z) < 13.2) return;
      groundColor(b.position.x, b.position.z, y, tmpC, pave0);
      if (pave0.cell > 0.25 || pathDist(b.position.x, b.position.z) < 0.4) return;
      const s = b.scale;
      const m = T(b.position.x, Math.max(y, -0.2) - 0.03, b.position.z, rnd() * 6.28, 0, 0, s, s * (0.85 + rnd() * 0.3), s);
      const key = b.kind === 'flowers' ? `flowers${idx % 4}` : `${b.kind}${idx % 2}`;
      pushB(key, { m, c: jitterColor(rnd, 0.1, 0.03) });
    });

    // Ground cover (non-solid): grass tufts tinted by the ground, wildflowers, woodland ferns.
    const woods = getLocation('woods');
    const square = getLocation('town_square');
    const unknown = getLocation('the_unknown');
    const pave = { cell: 0, grain: 0, scale: 1 };
    const tuftTarget = Math.round(1300 * density);
    const flowerTarget = Math.round(300 * density);
    const fernTarget = Math.round(160 * density);
    let tufts = 0;
    let flowers = 0;
    let ferns = 0;
    for (let attempt = 0; attempt < 40000 && (tufts < tuftTarget || flowers < flowerTarget || ferns < fernTarget); attempt++) {
      const x = -62 + rnd() * 126;
      const z = -78 + rnd() * 136;
      const inl = inlandDistance(x, z);
      if (inl < 2.2) continue;
      const h = terrainHeight(x, z);
      if (h < 0.3) continue;
      if (deckAt({ x, z }, -0.3)) continue;
      if (Math.hypot(x - square.center.x, z - square.center.z) < 12.8) continue;
      if (Math.hypot(x - unknown.center.x, z - unknown.center.z) < 6.2) continue;
      const pd = pathDist(x, z);
      if (pd < 0.15) continue;
      groundColor(x, z, h, tmpC, pave);
      if (pave.cell > 0.2 || pave.grain > 0.5) continue;
      if (collidesAt({ x, z }, 0.25)) continue;
      const inWoods = Math.hypot(x - woods.center.x, z - woods.center.z) < woods.radius + 3;
      const clump = fbm(x * 0.12 + 5, z * 0.12 - 3);
      const roll = rnd();
      if (inWoods && ferns < fernTarget && roll < 0.12) {
        ferns++;
        const s = 0.7 + rnd() * 0.6;
        pushB(`fern${ferns % 2}`, { m: T(x, h - 0.03, z, rnd() * 6.28, 0, 0, s), c: jitterColor(rnd, 0.1, 0.03) });
      } else if (!inWoods && flowers < flowerTarget && roll < 0.1 && clump > 0.55) {
        flowers++;
        const s = 0.5 + rnd() * 0.45;
        pushB(`flowers${flowers % 4}`, { m: T(x, h - 0.02, z, rnd() * 6.28, 0, 0, s), c: jitterColor(rnd, 0.1, 0.02) });
      } else if (tufts < tuftTarget && (clump > 0.48 || rnd() < 0.15)) {
        tufts++;
        const s = 0.8 + rnd() * 0.9;
        const c = tmpC.clone().multiplyScalar(1.06 + rnd() * 0.12);
        pushB(`tuft${tufts % 3}`, { m: T(x, h - 0.02, z, rnd() * 6.28, 0, 0, s * 1.2, s * (0.55 + rnd() * 0.4), s * 1.2), c });
      }
    }

    for (const [key, list] of bushLists) {
      const kind = key.replace(/\d+$/, '') as 'shrub' | 'fern' | 'flowers' | 'reeds' | 'tuft';
      const variant = Number(key.match(/\d+$/)?.[0] ?? 0);
      const mat = kind === 'shrub' ? foliageMaterial : plantMaterial;
      out.push(...makeInstanced(bushGeometry(kind, variant), mat, list, shadows && kind === 'shrub', kind !== 'shrub' && kind !== 'fern'));
    }
    void DECKS;
    return out;
  }, [shadows, density]);

  return (
    <group name="nature">
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
    </group>
  );
}
