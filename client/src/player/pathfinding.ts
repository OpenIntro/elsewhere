/**
 * Click-to-move pathfinding (pure: no DOM / three — unit tested in client/test).
 *
 *  - NavGrid: coarse walkability grid sampled ONCE from the shared collision
 *    (`isWalkable` with a small clearance margin) over a bounds rectangle,
 *    plus 8-connected component labels (fast "is it reachable at all?").
 *  - findPath(grid, from, to): A* (octile, no corner cutting) → string-pulled
 *    (line-of-sight smoothed) waypoints. Unwalkable / unreachable targets
 *    resolve to the nearest reachable cell in the start's component.
 *
 * Buffers are allocated once per grid and reused between searches (stamp
 * based reset), so a search allocates only its output array.
 */
import { CONFIG, WORLD_BOUNDS, isWalkable, type CollisionWorld, type Vec2 } from '@elsewhere/shared';

export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NavGridOptions {
  bounds?: NavBounds;
  /** Cell size in metres (default 0.5). */
  cell?: number;
  /** Character radius (default CONFIG.movement.playerRadius). */
  radius?: number;
  /** Extra clearance so paths do not hug walls (default 0.1). */
  margin?: number;
  /** Custom collision world (tests). */
  world?: CollisionWorld;
}

export class NavGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minZ: number;
  readonly radius: number;
  readonly world: CollisionWorld | undefined;
  /** 1 = walkable. Index = row * cols + col (row ↔ z, col ↔ x). */
  readonly walk: Uint8Array;
  /** Connected component id per cell (0 = unwalkable). */
  readonly comp: Int32Array;
  private built = 0;
  private readonly margin: number;

  // Search scratch (reused).
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closedStamp: Uint32Array;
  private curStamp = 0;
  private heap: Int32Array;
  private heapF: Float32Array;
  private heapSize = 0;

  constructor(opts: NavGridOptions = {}) {
    const b = opts.bounds ?? WORLD_BOUNDS;
    this.cell = opts.cell ?? 0.5;
    this.radius = opts.radius ?? CONFIG.movement.playerRadius;
    this.margin = opts.margin ?? 0.1;
    this.world = opts.world;
    this.minX = b.minX;
    this.minZ = b.minZ;
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX) / this.cell));
    this.rows = Math.max(1, Math.ceil((b.maxZ - b.minZ) / this.cell));
    const n = this.cols * this.rows;
    this.walk = new Uint8Array(n);
    this.comp = new Int32Array(n);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closedStamp = new Uint32Array(n);
    this.heap = new Int32Array(n);
    this.heapF = new Float32Array(n);
  }

  get ready(): boolean {
    return this.built >= this.rows;
  }

  /** Sample up to `maxRows` more rows; returns true when the grid is complete. Lets the client build incrementally. */
  buildStep(maxRows = Infinity): boolean {
    const r = this.radius + this.margin;
    const end = Math.min(this.rows, this.built + maxRows);
    const p = { x: 0, z: 0 };
    for (let row = this.built; row < end; row++) {
      p.z = this.minZ + (row + 0.5) * this.cell;
      for (let col = 0; col < this.cols; col++) {
        p.x = this.minX + (col + 0.5) * this.cell;
        this.walk[row * this.cols + col] = isWalkable(p, r, this.world) ? 1 : 0;
      }
    }
    this.built = end;
    if (this.ready) this.labelComponents();
    return this.ready;
  }

  build(): this {
    this.buildStep();
    return this;
  }

  /**
   * Re-sample the already-built cells inside a world rectangle (dynamic
   * colliders changed there, e.g. a player placed or removed a piece) and
   * relabel components. Rows not built yet will sample fresh data anyway.
   */
  refreshRect(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const r = this.radius + this.margin;
    const c0 = Math.max(0, this.colOf(minX - r));
    const c1 = Math.min(this.cols - 1, this.colOf(maxX + r));
    const r0 = Math.max(0, this.rowOf(minZ - r));
    const r1 = Math.min(this.built - 1, this.rowOf(maxZ + r));
    if (c1 < c0 || r1 < r0) return;
    const p = { x: 0, z: 0 };
    for (let row = r0; row <= r1; row++) {
      p.z = this.minZ + (row + 0.5) * this.cell;
      for (let col = c0; col <= c1; col++) {
        p.x = this.minX + (col + 0.5) * this.cell;
        this.walk[row * this.cols + col] = isWalkable(p, r, this.world) ? 1 : 0;
      }
    }
    if (this.ready) this.labelComponents();
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }
  colOf(x: number): number {
    return Math.floor((x - this.minX) / this.cell);
  }
  rowOf(z: number): number {
    return Math.floor((z - this.minZ) / this.cell);
  }
  centerX(col: number): number {
    return this.minX + (col + 0.5) * this.cell;
  }
  centerZ(row: number): number {
    return this.minZ + (row + 0.5) * this.cell;
  }
  inside(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }
  walkableCell(col: number, row: number): boolean {
    return this.inside(col, row) && this.walk[row * this.cols + col] === 1;
  }
  /** Grid walkability at a world point. */
  walkableAt(x: number, z: number): boolean {
    return this.walkableCell(this.colOf(x), this.rowOf(z));
  }

  private labelComponents(): void {
    const { cols, rows, walk, comp } = this;
    comp.fill(0);
    const queue = this.heap; // reuse as BFS queue
    let next = 1;
    for (let i = 0; i < walk.length; i++) {
      if (walk[i] !== 1 || comp[i] !== 0) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      comp[i] = next;
      while (head < tail) {
        const cur = queue[head++]!;
        const c = cur % cols;
        const r = (cur - c) / cols;
        for (let k = 0; k < 8; k++) {
          const nc = c + DX[k]!;
          const nr = r + DZ[k]!;
          if (!this.walkableCell(nc, nr)) continue;
          if (k >= 4 && (!this.walkableCell(c + DX[k]!, r) || !this.walkableCell(c, r + DZ[k]!))) continue;
          const ni = nr * cols + nc;
          if (comp[ni] !== 0) continue;
          comp[ni] = next;
          queue[tail++] = ni;
        }
      }
      next++;
    }
  }

  /** Nearest walkable cell to a world point (optionally restricted to a component). -1 if none within maxCells. */
  nearestCell(x: number, z: number, component = 0, maxCells = Math.max(this.cols, this.rows)): number {
    const c0 = this.colOf(x);
    const r0 = this.rowOf(z);
    const ok = (c: number, r: number) => this.walkableCell(c, r) && (component === 0 || this.comp[r * this.cols + c] === component);
    if (ok(c0, r0)) return this.index(c0, r0);
    let best = -1;
    let bestD = Infinity;
    let foundRing = -1;
    for (let ring = 1; ring <= maxCells; ring++) {
      // Once something is found at ring R, cells up to R*√2 could still be closer.
      if (foundRing > 0 && ring > Math.ceil(foundRing * Math.SQRT2) + 1) break;
      for (let dr = -ring; dr <= ring; dr++) {
        const edge = dr === -ring || dr === ring;
        for (let dc = -ring; dc <= ring; dc += edge ? 1 : 2 * ring) {
          const c = c0 + dc;
          const r = r0 + dr;
          if (!ok(c, r)) continue;
          const ddx = this.centerX(c) - x;
          const ddz = this.centerZ(r) - z;
          const d = ddx * ddx + ddz * ddz;
          if (d < bestD) {
            bestD = d;
            best = this.index(c, r);
            if (foundRing < 0) foundRing = ring;
          }
        }
      }
    }
    return best;
  }

  /**
   * Grid line of sight between two world points: every cell the segment
   * passes through (supercover, slightly thickened) must be walkable.
   */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return this.walkableAt(ax, az);
    // Sample at quarter-cell steps along the centre line and two offset lines
    // (±0.3 of a cell): cheap, conservative enough for 0.5 m cells.
    const step = this.cell * 0.25;
    const n = Math.ceil(len / step);
    const px = (-dz / len) * this.cell * 0.3;
    const pz = (dx / len) * this.cell * 0.3;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + dx * t;
      const z = az + dz * t;
      if (!this.walkableAt(x, z)) return false;
      if (i > 0 && i < n && (!this.walkableAt(x + px, z + pz) || !this.walkableAt(x - px, z - pz))) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // A*
  // ---------------------------------------------------------------------

  private heapPush(node: number, f: number): void {
    let i = this.heapSize++;
    const h = this.heap;
    const hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p]! <= f) break;
      h[i] = h[p]!;
      hf[i] = hf[p]!;
      i = p;
    }
    h[i] = node;
    hf[i] = f;
  }

  private heapPop(): number {
    const h = this.heap;
    const hf = this.heapF;
    const top = h[0]!;
    const n = --this.heapSize;
    if (n > 0) {
      const node = h[n]!;
      const f = hf[n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && hf[r]! < hf[l]! ? r : l;
        if (hf[c]! >= f) break;
        h[i] = h[c]!;
        hf[i] = hf[c]!;
        i = c;
      }
      h[i] = node;
      hf[i] = f;
    }
    return top;
  }

  /** Raw A* over cells; returns cell indices start→goal, or null. */
  searchCells(start: number, goal: number, maxExpansions = 200_000): number[] | null {
    if (start === goal) return [start];
    const { cols } = this;
    this.curStamp = (this.curStamp + 1) >>> 0;
    if (this.curStamp === 0) {
      this.stamp.fill(0);
      this.closedStamp.fill(0);
      this.curStamp = 1;
    }
    const s = this.curStamp;
    const gc = goal % cols;
    const gr = (goal - gc) / cols;
    const h = (i: number) => {
      const c = i % cols;
      const r = (i - c) / cols;
      const dx = Math.abs(c - gc);
      const dz = Math.abs(r - gr);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    this.heapSize = 0;
    this.g[start] = 0;
    this.parent[start] = -1;
    this.stamp[start] = s;
    this.heapPush(start, h(start));
    let expansions = 0;
    while (this.heapSize > 0) {
      const cur = this.heapPop();
      if (this.closedStamp[cur] === s) continue;
      this.closedStamp[cur] = s;
      if (cur === goal) {
        const out: number[] = [];
        for (let i = cur; i !== -1; i = this.parent[i]!) out.push(i);
        return out.reverse();
      }
      if (++expansions > maxExpansions) return null;
      const c = cur % cols;
      const r = (cur - c) / cols;
      const gcur = this.g[cur]!;
      for (let k = 0; k < 8; k++) {
        const nc = c + DX[k]!;
        const nr = r + DZ[k]!;
        if (!this.walkableCell(nc, nr)) continue;
        if (k >= 4 && (!this.walkableCell(c + DX[k]!, r) || !this.walkableCell(c, r + DZ[k]!))) continue;
        const ni = nr * cols + nc;
        if (this.closedStamp[ni] === s) continue;
        const ng = gcur + (k >= 4 ? Math.SQRT2 : 1);
        if (this.stamp[ni] === s && ng >= this.g[ni]!) continue;
        this.stamp[ni] = s;
        this.g[ni] = ng;
        this.parent[ni] = cur;
        this.heapPush(ni, ng + h(ni));
      }
    }
    return null;
  }
}

// 4 orthogonal, then 4 diagonal.
const DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DZ = [0, 0, 1, -1, 1, -1, 1, -1] as const;

export interface PathResult {
  /** Smoothed waypoints, excluding the start, ending at `goal`. Empty = already there. */
  points: Vec2[];
  /** Where the path actually ends (== requested target when reachable). */
  goal: Vec2;
  /** True when the requested target was reachable exactly (walkable & connected). */
  exact: boolean;
}

export interface FindPathOptions {
  /** Verify each smoothed segment against the continuous collision (default true). */
  verify?: boolean;
}

/**
 * Path from `from` to `to`. Returns null only when the start itself is
 * hopeless (no walkable cell nearby); otherwise walks to the nearest
 * reachable point.
 */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2, opts: FindPathOptions = {}): PathResult | null {
  if (!grid.ready) grid.build();
  const verify = opts.verify ?? true;
  const start = grid.nearestCell(from.x, from.z, 0, 8);
  if (start < 0) return null;
  const comp = grid.comp[start]!;
  const tc = grid.colOf(to.x);
  const tr = grid.rowOf(to.z);
  const exactCell = grid.walkableCell(tc, tr) && grid.comp[grid.index(tc, tr)] === comp;
  const goalCell = exactCell ? grid.index(tc, tr) : grid.nearestCell(to.x, to.z, comp);
  if (goalCell < 0) return null;
  const cells = grid.searchCells(start, goalCell);
  if (!cells) return null;

  const cellPoint = (i: number): Vec2 => {
    const c = i % grid.cols;
    return { x: grid.centerX(c), z: grid.centerZ((i - c) / grid.cols) };
  };
  // Exact targets keep the precise clicked point (it is inside a walkable cell; verify the
  // continuous collision too — the cell centre being clear does not guarantee the point is).
  let goal = cellPoint(goalCell);
  let exact = false;
  if (exactCell && isWalkable(to, grid.radius, grid.world)) {
    goal = { x: to.x, z: to.z };
    exact = true;
  }

  // Raw polyline: start position, cell centres (skip the start cell), goal.
  const raw: Vec2[] = [{ x: from.x, z: from.z }];
  for (let i = 1; i < cells.length - 1; i++) raw.push(cellPoint(cells[i]!));
  raw.push(goal);

  // String pulling: from each anchor jump to the farthest visible point.
  const out: Vec2[] = [];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let j = anchor + 1;
    const a = raw[anchor]!;
    for (let k = raw.length - 1; k > anchor + 1; k--) {
      const b = raw[k]!;
      if (grid.lineOfSight(a.x, a.z, b.x, b.z) && (!verify || segmentClear(a, b, grid))) {
        j = k;
        break;
      }
    }
    out.push(raw[j]!);
    anchor = j;
  }
  return { points: out, goal, exact };
}

/** Continuous check along a segment with the real collision (radius only, no margin). */
export function segmentClear(a: Vec2, b: Vec2, grid: NavGrid, step = 0.3): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(len / step));
  const p = { x: 0, z: 0 };
  for (let i = 1; i < n; i++) {
    p.x = a.x + (dx * i) / n;
    p.z = a.z + (dz * i) / n;
    if (!isWalkable(p, grid.radius, grid.world)) return false;
  }
  return true;
}

/** Total length of a path starting at `from`. */
export function pathLength(from: Vec2, points: readonly Vec2[]): number {
  let len = 0;
  let px = from.x;
  let pz = from.z;
  for (const p of points) {
    len += Math.hypot(p.x - px, p.z - pz);
    px = p.x;
    pz = p.z;
  }
  return len;
}
