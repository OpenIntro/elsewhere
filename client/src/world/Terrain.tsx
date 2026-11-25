/**
 * Island ground: a height mesh sampled from shared `terrainHeight`, painted
 * per-vertex (grass zones, beaches, worn paths blended into the grass, plazas,
 * creek banks, baked contact AO from every collider), plus a shader pass that
 * adds hand-painted mottling, grain and procedural paving (cobbles/flagstones).
 */
import { useMemo } from 'react';
import { BufferAttribute, Color, MeshStandardMaterial, PlaneGeometry } from 'three';
import {
  BUILDINGS,
  COLLIDERS,
  CREEK_BANK_HALF_WIDTH,
  CREEK_POINTS,
  PATHS,
  TREES,
  WORLD_BOUNDS,
  distanceToPolyline,
  getBuilding,
  getLocation,
  inlandDistance,
  smoothstep,
  terrainHeight,
  type PathSurface,
} from '@elsewhere/shared';
import { NOISE_GLSL } from './materials.js';
import { uniforms } from './env.js';

// --- tiny deterministic value noise (JS) --------------------------------------
function hash2(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function vnoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, z: number): number {
  return vnoise(x, z) * 0.55 + vnoise(x * 2.1 + 17, z * 2.1 - 9) * 0.3 + vnoise(x * 4.3 - 5, z * 4.3 + 3) * 0.15;
}

const C = (h: string) => new Color(h);
const PAL = {
  grassSun: C('#afb27b'),
  grassMid: C('#959d69'),
  grassDeep: C('#7b8a5d'),
  grassLush: C('#97a76c'),
  clover: C('#b6b583'),
  forest: C('#64744b'),
  needles: C('#86744f'),
  moss: C('#6f8a4c'),
  heath: C('#a1a072'),
  heather: C('#9a8a92'),
  sand: C('#e6d6ae'),
  wetSand: C('#c7b38c'),
  seabedShallow: C('#cdbf98'),
  seabedDeep: C('#4f7477'),
  mud: C('#86775a'),
  trampled: C('#a7a06c'),
  cobble: C('#c2b49c'),
  gravel: C('#cfc1a1'),
  dirt: C('#ad936c'),
  pathSand: C('#e3d4ad'),
  plaza: C('#cdbfa6'),
  plazaRing: C('#a99c88'),
  terrace: C('#d0a183'),
  hallStone: C('#c9c0b0'),
  flag: C('#a8a597'),
  yard: C('#bda37c'),
};

const SURFACE: Record<PathSurface, { color: Color; cell: number; grain: number; scale: number }> = {
  cobble: { color: PAL.cobble, cell: 0.9, grain: 0.3, scale: 3.1 },
  gravel: { color: PAL.gravel, cell: 0, grain: 1, scale: 1 },
  dirt: { color: PAL.dirt, cell: 0, grain: 0.7, scale: 1 },
  sand: { color: PAL.pathSand, cell: 0, grain: 0.5, scale: 1 },
  boardwalk: { color: PAL.dirt, cell: 0, grain: 0.3, scale: 1 },
};

interface Pave {
  cell: number;
  grain: number;
  scale: number;
}

/** Local coordinates of p in a building's frame. */
function toLocal(b: { position: { x: number; z: number }; yaw: number }, x: number, z: number) {
  const dx = x - b.position.x;
  const dz = z - b.position.z;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

function rectMask(lx: number, lz: number, x0: number, x1: number, z0: number, z1: number, soft: number): number {
  const dx = Math.max(x0 - lx, lx - x1, 0);
  const dz = Math.max(z0 - lz, lz - z1, 0);
  return 1 - smoothstep(0, soft, Math.hypot(dx, dz));
}

const SQUARE = getLocation('town_square');
const UNKNOWN = getLocation('the_unknown');
const WOODS = getLocation('woods');
const RES = getLocation('residential');
const WATERFRONT = getLocation('waterfront');
const HALL = getBuilding('town_hall');
const CAFE = getBuilding('cafe');
const STORE = getBuilding('general_store');
const WORKSHOP = getBuilding('workshop');

// Spatial hash of colliders for AO.
const AO_CELL = 8;
const aoGrid = new Map<string, typeof COLLIDERS[number][]>();
for (const c of COLLIDERS) {
  const r = c.shape === 'circle' ? c.radius + 3 : Math.hypot(c.halfWidth, c.halfDepth) + 3;
  for (let gx = Math.floor((c.x - r) / AO_CELL); gx <= Math.floor((c.x + r) / AO_CELL); gx++)
    for (let gz = Math.floor((c.z - r) / AO_CELL); gz <= Math.floor((c.z + r) / AO_CELL); gz++) {
      const k = `${gx},${gz}`;
      let l = aoGrid.get(k);
      if (!l) aoGrid.set(k, (l = []));
      l.push(c);
    }
}
const treeScale = new Map(TREES.map((t) => [`col_${t.id}`, t.scale]));

function contactAO(x: number, z: number): number {
  const list = aoGrid.get(`${Math.floor(x / AO_CELL)},${Math.floor(z / AO_CELL)}`);
  if (!list) return 1;
  let ao = 1;
  for (const c of list) {
    if (c.shape === 'circle') {
      const d = Math.hypot(x - c.x, z - c.z);
      const ts = treeScale.get(c.id);
      if (ts !== undefined) {
        // trunk contact + canopy shade
        ao *= 1 - 0.32 * (1 - smoothstep(c.radius * 0.5, c.radius + 0.9, d));
        ao *= 1 - 0.2 * (1 - smoothstep(0.5, 2.6 * ts, d));
      } else {
        ao *= 1 - 0.42 * (1 - smoothstep(c.radius * 0.7, c.radius + 0.75, d));
      }
    } else {
      const cc = Math.cos(c.yaw);
      const s = Math.sin(c.yaw);
      const dx = x - c.x;
      const dz = z - c.z;
      const lx = dx * cc - dz * s;
      const lz = dx * s + dz * cc;
      const ex = Math.max(Math.abs(lx) - c.halfWidth, 0);
      const ez = Math.max(Math.abs(lz) - c.halfDepth, 0);
      const d = Math.hypot(ex, ez);
      const big = c.source === 'building';
      ao *= 1 - (big ? 0.5 : 0.38) * (1 - smoothstep(0, big ? 1.8 : 0.7, d));
    }
  }
  return ao;
}

const tmp = new Color();
const tmp2 = new Color();

/** Ground colour + paving data at (x, z). */
export function groundColor(x: number, z: number, h: number, out: Color, pave: Pave): void {
  pave.cell = 0;
  pave.grain = 0;
  pave.scale = 1;
  const d = inlandDistance(x, z);
  const n1 = fbm(x * 0.045, z * 0.045);
  const n2 = fbm(x * 0.16 + 40, z * 0.16 - 12);
  if (h < 0.02) {
    const depth = -h;
    out.copy(PAL.seabedShallow).lerp(PAL.seabedDeep, smoothstep(0.2, 4.5, depth));
    out.lerp(PAL.wetSand, (1 - smoothstep(0, 0.35, depth)) * 0.6);
    pave.grain = 0.4;
    return;
  }

  // Base grass with painterly zones.
  out.copy(PAL.grassMid).lerp(PAL.grassSun, smoothstep(0.35, 0.75, n1));
  out.lerp(PAL.grassDeep, smoothstep(0.45, 0.8, n2) * 0.55);
  out.lerp(PAL.clover, smoothstep(0.72, 0.9, fbm(x * 0.3 + 3, z * 0.3)) * 0.4);
  // Slightly cooler on hill tops.
  out.lerp(PAL.grassDeep, smoothstep(2.5, 6, h) * 0.25);

  const dRes = Math.hypot(x - RES.center.x, z - RES.center.z);
  out.lerp(PAL.grassLush, (1 - smoothstep(RES.radius * 0.6, RES.radius + 6, dRes)) * 0.6);

  const dWoods = Math.hypot(x - WOODS.center.x, z - WOODS.center.z);
  const woodsW = 1 - smoothstep(WOODS.radius - 2, WOODS.radius + 9, dWoods + (n2 - 0.5) * 8);
  if (woodsW > 0) {
    tmp.copy(PAL.forest).lerp(PAL.needles, smoothstep(0.55, 0.85, n2) * 0.7).lerp(PAL.moss, smoothstep(0.6, 0.9, n1) * 0.5);
    out.lerp(tmp, woodsW);
  }
  const dUnk = Math.hypot(x - UNKNOWN.center.x, z - UNKNOWN.center.z);
  const unkW = 1 - smoothstep(UNKNOWN.radius - 2, UNKNOWN.radius + 10, dUnk + (n1 - 0.5) * 6);
  if (unkW > 0) {
    tmp.copy(PAL.heath).lerp(PAL.heather, smoothstep(0.5, 0.8, n2) * 0.7);
    out.lerp(tmp, unkW * 0.85);
  }

  // Beaches (wider at the Waterfront bay).
  const dWf = Math.hypot(x - WATERFRONT.center.x, z - WATERFRONT.center.z);
  const beachWidth = 2.6 + n2 * 1.8 + (1 - smoothstep(8, 22, dWf)) * 6;
  const sandW = 1 - smoothstep(beachWidth * 0.55, beachWidth, d);
  if (sandW > 0) {
    tmp.copy(PAL.sand).lerp(PAL.wetSand, 1 - smoothstep(0.1, 0.55, h));
    out.lerp(tmp, sandW);
    pave.grain = Math.max(pave.grain, sandW * 0.5);
  }

  // Creek banks.
  const dc = distanceToPolyline({ x, z }, CREEK_POINTS);
  if (dc < CREEK_BANK_HALF_WIDTH + 1.6) {
    const w = 1 - smoothstep(CREEK_BANK_HALF_WIDTH - 0.6, CREEK_BANK_HALF_WIDTH + 1.6, dc + (n2 - 0.5));
    out.lerp(PAL.mud, w * 0.8);
    pave.grain = Math.max(pave.grain, w * 0.8);
  }

  // --- plazas --------------------------------------------------------------
  const sq = Math.hypot(x - SQUARE.center.x, z - SQUARE.center.z);
  const sqEdge = 12.3 + (n2 - 0.5) * 0.6;
  const sqW = 1 - smoothstep(sqEdge - 0.25, sqEdge + 0.35, sq);
  if (sqW > 0) {
    tmp.copy(PAL.plaza).lerp(PAL.plazaRing, (1 - smoothstep(0.35, 0.6, Math.abs(sq - 11.6))) * 0.8 + (1 - smoothstep(0.2, 0.5, Math.abs(sq - 4.4))) * 0.7);
    // radial "rays" of darker stone between the bench spokes
    out.lerp(tmp, sqW);
    pave.cell = Math.max(pave.cell, sqW);
    pave.scale = sq < 4.6 ? 3.4 : 2.5;
  }
  const lh = toLocal(HALL, x, z);
  const hallW = Math.max(rectMask(lh.x, lh.z, -7.2, 7.2, 3.5, 9.2, 0.5), rectMask(lh.x, lh.z, -1.6, 1.6, 9, 12, 0.6));
  if (hallW > 0) {
    out.lerp(PAL.hallStone, hallW);
    pave.cell = Math.max(pave.cell, hallW);
    pave.scale = 1.25;
  }
  const lc = toLocal(CAFE, x, z);
  const cafeW = rectMask(lc.x, lc.z, -5.4, 5.4, 2.8, 9.2, 0.4);
  if (cafeW > 0) {
    out.lerp(PAL.terrace, cafeW);
    pave.cell = Math.max(pave.cell, cafeW);
    pave.scale = 1.9;
  }
  const ls = toLocal(STORE, x, z);
  const storeW = rectMask(ls.x, ls.z, -4.8, 4.8, 3, 5.6, 0.7);
  if (storeW > 0) {
    out.lerp(PAL.gravel, storeW * 0.9);
    pave.grain = Math.max(pave.grain, storeW);
  }
  const lw = toLocal(WORKSHOP, x, z);
  const yardW = rectMask(lw.x, lw.z, -5.4, 5.8, 3.2, 7.6, 1.2 + n2);
  if (yardW > 0) {
    out.lerp(PAL.yard, yardW * 0.85);
    pave.grain = Math.max(pave.grain, yardW);
  }
  // Cottage doorstep paths (door → loop path).
  for (const b of BUILDINGS) {
    if (b.style !== 'cottage') continue;
    const l = toLocal(b, x, z);
    const w = rectMask(l.x, l.z, -0.55, 0.55, b.depth / 2, b.depth / 2 + 3.2, 0.35);
    if (w > 0) {
      out.lerp(PAL.gravel, w * 0.85);
      pave.cell = Math.max(pave.cell, w * 0.7);
      pave.scale = 2.4;
    }
  }
  if (unkW > 0) {
    const fl = 1 - smoothstep(5.2, 6.4, dUnk + (n2 - 0.5) * 1.6);
    if (fl > 0) {
      out.lerp(PAL.flag, fl * 0.85);
      pave.cell = Math.max(pave.cell, fl * 0.85);
      pave.scale = 0.9;
    }
  }

  // --- paths: worn into the grass, soft frayed edges ------------------------
  for (const path of PATHS) {
    const pd = distanceToPolyline({ x, z }, path.points);
    const half = path.width / 2;
    if (pd > half + 1.6) continue;
    const s = SURFACE[path.surface];
    const fray = (vnoise(x * 0.9, z * 0.9) - 0.5) * 0.7;
    const core = 1 - smoothstep(half - 0.55, half + 0.15, pd + fray);
    const wear = 1 - smoothstep(half, half + 1.5, pd + fray);
    out.lerp(PAL.trampled, wear * 0.35 * (1 - sqW));
    tmp2.copy(s.color).lerp(out, 0.12);
    out.lerp(tmp2, core);
    if (core > 0.01) {
      pave.grain = Math.max(pave.grain, core * s.grain);
      if (s.cell > 0) {
        const cw = core * s.cell * (1 - smoothstep(0.6, 1.0, Math.max(sqW, hallW, cafeW)));
        if (cw > pave.cell) {
          pave.cell = Math.max(pave.cell, cw);
          pave.scale = s.scale;
        }
      }
    }
  }

  // Contact AO.
  out.multiplyScalar(contactAO(x, z));
}

const terrainMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
terrainMaterial.customProgramCacheKey = () => 'terrain';
terrainMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uniforms.uTime;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aPave; varying vec3 vPave; varying vec3 vWPos;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPave = aPave; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying vec3 vPave; varying vec3 vWPos;
${NOISE_GLSL}
vec3 voro(vec2 p){
  vec2 n = floor(p); vec2 f = fract(p);
  float f1 = 8.0; float f2 = 8.0; float id = 0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = vec2(wHash(n+g), wHash(n+g+17.7));
    o = 0.5 + 0.38*sin(6.2831*o);
    vec2 r = g + o - f;
    float d = dot(r,r);
    if(d < f1){ f2 = f1; f1 = d; id = wHash(n+g+3.1); } else if(d < f2){ f2 = d; }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
{
  vec3 col = diffuseColor.rgb;
  float n1 = wFbm(vWPos.xz * 0.33);
  float n2 = wNoise(vWPos.xz * 3.1);
  float n3 = wNoise(vWPos.xz * 11.0 + 7.0);
  float grassy = 1.0 - max(vPave.x, vPave.y * 0.6);
  // painterly mottling + small clumps
  col *= 1.0 + ((n1 - 0.5) * 0.16 + (n2 - 0.5) * 0.12 + (n3 - 0.5) * 0.06) * (0.4 + 0.6 * grassy);
  // grain/speckle on gravel, dirt and sand
  float sp = wHash(floor(vWPos.xz * 16.0));
  col *= 1.0 + (sp - 0.5) * 0.22 * vPave.y;
  if (vPave.x > 0.01) {
    vec3 v = voro(vWPos.xz * vPave.z);
    float edge = v.y - v.x;
    float mortar = 1.0 - smoothstep(0.025, 0.09, edge);
    float tone = 0.9 + 0.16 * v.z;
    vec3 paved = col * tone * (0.94 + 0.12 * smoothstep(0.05, 0.45, edge));
    // moss / grass creeping in the joints near the plaza edges
    vec3 joint = mix(col * 0.72, vec3(0.42, 0.5, 0.3), 0.35 * (1.0 - vPave.x));
    paved = mix(paved, joint, mortar);
    col = mix(col, paved, smoothstep(0.0, 0.5, vPave.x) * (0.55 + 0.45 * vPave.x));
  }
  diffuseColor.rgb = col;
}`,
    );
};

export function Terrain({ resolution = 0.7 }: { resolution?: number }) {
  const geometry = useMemo(() => {
    const w = WORLD_BOUNDS.maxX - WORLD_BOUNDS.minX;
    const d = WORLD_BOUNDS.maxZ - WORLD_BOUNDS.minZ;
    const g = new PlaneGeometry(w, d, Math.round(w / resolution), Math.round(d / resolution));
    g.rotateX(-Math.PI / 2);
    g.translate(WORLD_BOUNDS.minX + w / 2, 0, WORLD_BOUNDS.minZ + d / 2);
    const pos = g.attributes.position as BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const paveArr = new Float32Array(pos.count * 3);
    const c = new Color();
    const pave: Pave = { cell: 0, grain: 0, scale: 1 };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // Edge vertices drop to the seabed so the mesh meets the diorama base.
      const edge = x <= WORLD_BOUNDS.minX + 0.01 || x >= WORLD_BOUNDS.maxX - 0.01 || z <= WORLD_BOUNDS.minZ + 0.01 || z >= WORLD_BOUNDS.maxZ - 0.01;
      const h = edge ? -6 : terrainHeight(x, z);
      pos.setY(i, h);
      groundColor(x, z, h, c, pave);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
      paveArr[i * 3] = pave.cell;
      paveArr[i * 3 + 1] = pave.grain;
      paveArr[i * 3 + 2] = pave.scale;
    }
    g.setAttribute('color', new BufferAttribute(colors, 3));
    g.setAttribute('aPave', new BufferAttribute(paveArr, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }, [resolution]);

  return <mesh name="terrain" geometry={geometry} material={terrainMaterial} receiveShadow />;
}
