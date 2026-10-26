// Grid navigation for ground agents: rasterises the CollisionWorld into a walkable grid
// (obstacles inflated by the agent radius), labels connected regions, and finds paths.
//
//   const nav = new NavGrid(world, { minX, maxX, minZ, maxZ }, { cell: 0.5, agentRadius: 0.45 });
//   nav.build();
//   nav.findPath({x, z}, {x, z}) -> [{x, z}, ...]  (smoothed; excludes the start; ends at goal) or null
//
// findPath uses Jump Point Search (8-connected, no corner cutting): on this grid a long detour
// (e.g. round the closed gate through the parking structure, ~150 m) costs well under a
// millisecond instead of the 7-25 ms plain A* needed. findPathReference() keeps the plain A*
// (used as a fallback and by tools/perf-nav.mjs). Call rebuildArea() after toggling colliders.

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Binary min-heap of int items keyed by float priorities (parallel typed arrays, grown on demand).
class MinHeap {
  constructor(capacity = 1024) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.size = 0;
  }
  clear() {
    this.size = 0;
  }
  push(item, key) {
    if (this.size === this.items.length) {
      const items = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      items.set(this.items);
      keys.set(this.keys);
      this.items = items;
      this.keys = keys;
    }
    const a = this.items, k = this.keys;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      a[i] = a[p];
      k[i] = k[p];
      i = p;
    }
    a[i] = item;
    k[i] = key;
  }
  pop() {
    const a = this.items, k = this.keys;
    const top = a[0];
    const n = --this.size;
    if (n > 0) {
      const lastItem = a[n], lastKey = k[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastKey) break;
        a[i] = a[c];
        k[i] = k[c];
        i = c;
      }
      a[i] = lastItem;
      k[i] = lastKey;
    }
    return top;
  }
}

export class NavGrid {
  constructor(world, bounds, { cell = 0.5, agentRadius = 0.45, maxObstacleBottom = 1.4 } = {}) {
    this.world = world;
    this.cell = cell;
    this.agentRadius = agentRadius;
    this.maxObstacleBottom = maxObstacleBottom;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.max(3, Math.ceil((bounds.maxX - bounds.minX) / cell));
    this.h = Math.max(3, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
    const n = this.w * this.h;
    this.walk = new Uint8Array(n);
    this.region = new Int32Array(n);
    this.regionCount = 0;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.searchId = 0;
    this.heap = new MinHeap();
    this.stack = new Int32Array(1024);
    // Counters for tools/perf-*.mjs and the debug overlay.
    this.stats = { searches: 0, expansions: 0, fallbacks: 0, lastMs: 0, maxMs: 0, totalMs: 0 };
  }

  build() {
    this.walk.fill(1);
    // Outer border is never walkable so neighbours never index out of the grid.
    for (let x = 0; x < this.w; x++) {
      this.walk[x] = 0;
      this.walk[(this.h - 1) * this.w + x] = 0;
    }
    for (let z = 0; z < this.h; z++) {
      this.walk[z * this.w] = 0;
      this.walk[z * this.w + this.w - 1] = 0;
    }
    for (const col of this.world.colliders) this._rasterise(col);
    this._labelRegions();
  }

  _blocks(col) {
    return col.enabled && col.blocksMove && col.minY < this.maxObstacleBottom && col.maxY > 0.45;
  }

  _rasterise(col, clip = null) {
    if (!this._blocks(col)) return;
    const r = this.agentRadius;
    let x0 = Math.max(1, Math.floor((col.minX - r - this.minX) / this.cell));
    let x1 = Math.min(this.w - 2, Math.floor((col.maxX + r - this.minX) / this.cell));
    let z0 = Math.max(1, Math.floor((col.minZ - r - this.minZ) / this.cell));
    let z1 = Math.min(this.h - 2, Math.floor((col.maxZ + r - this.minZ) / this.cell));
    if (clip) {
      x0 = Math.max(x0, clip.x0); x1 = Math.min(x1, clip.x1);
      z0 = Math.max(z0, clip.z0); z1 = Math.min(z1, clip.z1);
    }
    for (let iz = z0; iz <= z1; iz++) {
      const wz = this.minZ + (iz + 0.5) * this.cell;
      for (let ix = x0; ix <= x1; ix++) {
        const wx = this.minX + (ix + 0.5) * this.cell;
        const dx = wx - col.cx, dz = wz - col.cz;
        const lx = col.cos * dx - col.sin * dz;
        const lz = col.sin * dx + col.cos * dz;
        // Inflated rounded rectangle test.
        const ox = Math.max(0, Math.abs(lx) - col.hx);
        const oz = Math.max(0, Math.abs(lz) - col.hz);
        if (ox * ox + oz * oz <= r * r) this.walk[iz * this.w + ix] = 0;
      }
    }
  }

  // Re-rasterise a world-space rectangle (after enabling/disabling colliders).
  rebuildArea(minX, minZ, maxX, maxZ) {
    const pad = this.agentRadius + this.cell;
    const clip = {
      x0: Math.max(1, Math.floor((minX - pad - this.minX) / this.cell)),
      x1: Math.min(this.w - 2, Math.floor((maxX + pad - this.minX) / this.cell)),
      z0: Math.max(1, Math.floor((minZ - pad - this.minZ) / this.cell)),
      z1: Math.min(this.h - 2, Math.floor((maxZ + pad - this.minZ) / this.cell)),
    };
    for (let iz = clip.z0; iz <= clip.z1; iz++) this.walk.fill(1, iz * this.w + clip.x0, iz * this.w + clip.x1 + 1);
    const list = this.world.query(minX - pad, minZ - pad, maxX + pad, maxZ + pad).slice();
    for (const col of list) this._rasterise(col, clip);
    this._labelRegions();
  }

  // Flood-fills 8-connected (no corner cutting) walkable components. Border cells are never
  // walkable, so neighbour indices of a walkable cell never leave the grid.
  _labelRegions() {
    const { w, h, walk, region } = this;
    const n = w * h;
    region.fill(-1);
    let stack = this.stack;
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (!walk[i] || region[i] >= 0) continue;
      region[i] = next;
      let top = 0;
      stack[top++] = i;
      while (top) {
        const c = stack[--top];
        if (top + 8 >= stack.length) {
          const grown = new Int32Array(stack.length * 2);
          grown.set(stack);
          stack = this.stack = grown;
        }
        const e = walk[c + 1], wv = walk[c - 1], s = walk[c + w], nn = walk[c - w];
        if (e && region[c + 1] < 0) { region[c + 1] = next; stack[top++] = c + 1; }
        if (wv && region[c - 1] < 0) { region[c - 1] = next; stack[top++] = c - 1; }
        if (s && region[c + w] < 0) { region[c + w] = next; stack[top++] = c + w; }
        if (nn && region[c - w] < 0) { region[c - w] = next; stack[top++] = c - w; }
        if (e && s && walk[c + w + 1] && region[c + w + 1] < 0) { region[c + w + 1] = next; stack[top++] = c + w + 1; }
        if (e && nn && walk[c - w + 1] && region[c - w + 1] < 0) { region[c - w + 1] = next; stack[top++] = c - w + 1; }
        if (wv && s && walk[c + w - 1] && region[c + w - 1] < 0) { region[c + w - 1] = next; stack[top++] = c + w - 1; }
        if (wv && nn && walk[c - w - 1] && region[c - w - 1] < 0) { region[c - w - 1] = next; stack[top++] = c - w - 1; }
      }
      next++;
    }
    this.regionCount = next;
  }

  cellX(x) {
    return Math.floor((x - this.minX) / this.cell);
  }

  cellZ(z) {
    return Math.floor((z - this.minZ) / this.cell);
  }

  index(x, z) {
    const ix = this.cellX(x), iz = this.cellZ(z);
    if (!(ix >= 0 && iz >= 0 && ix < this.w && iz < this.h)) return -1; // also rejects NaN
    return iz * this.w + ix;
  }

  centerOf(i) {
    const ix = i % this.w;
    const iz = (i - ix) / this.w;
    return { x: this.minX + (ix + 0.5) * this.cell, z: this.minZ + (iz + 0.5) * this.cell };
  }

  isWalkable(x, z) {
    const i = this.index(x, z);
    return i >= 0 && this.walk[i] === 1;
  }

  regionAt(x, z) {
    const i = this.index(x, z);
    return i >= 0 && this.walk[i] ? this.region[i] : -1;
  }

  sameRegion(ax, az, bx, bz) {
    const ra = this.regionAt(ax, az);
    return ra >= 0 && ra === this.regionAt(bx, bz);
  }

  // Closest walkable cell centre within maxCells rings (or null). Visits only each ring's
  // perimeter, in row-major order (ties resolve exactly as the original full-square scan did).
  nearestWalkable(x, z, maxCells = 20) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const cx = this.cellX(x), cz = this.cellZ(z);
    const { w, h, walk } = this;
    if (cx >= 0 && cz >= 0 && cx < w && cz < h && walk[cz * w + cx]) return { x, z };
    for (let r = 1; r <= maxCells; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        const iz = cz + dz;
        if (iz < 0 || iz >= h) continue;
        const edge = dz === -r || dz === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r) {
          const ix = cx + dx;
          if (ix < 0 || ix >= w) continue;
          const i = iz * w + ix;
          if (!walk[i]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return this.centerOf(best);
    }
    return null;
  }

  // Supercover grid traversal: true if every cell the segment touches is walkable.
  lineWalkable(ax, az, bx, bz) {
    const c = this.cell;
    let ix = this.cellX(ax), iz = this.cellZ(az);
    const tx = this.cellX(bx), tz = this.cellZ(bz);
    if (!Number.isFinite(ix + iz + tx + tz)) return false;
    const dx = bx - ax, dz = bz - az;
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(c / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(c / dz) : Infinity;
    const fx = (ax - this.minX) / c - ix;
    const fz = (az - this.minZ) / c - iz;
    let tMaxX = dx !== 0 ? (stepX > 0 ? 1 - fx : fx) * tDeltaX : Infinity;
    let tMaxZ = dz !== 0 ? (stepZ > 0 ? 1 - fz : fz) * tDeltaZ : Infinity;
    let remX = Math.abs(tx - ix), remZ = Math.abs(tz - iz);
    if (!this._open(ix, iz)) return false;
    while (remX > 0 || remZ > 0) {
      if (remX > 0 && remZ > 0 && Math.abs(tMaxX - tMaxZ) < 1e-9) {
        // Passing exactly through a corner: both side cells must be open.
        if (!this._open(ix + stepX, iz) || !this._open(ix, iz + stepZ)) return false;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
        ix += stepX;
        iz += stepZ;
        remX--;
        remZ--;
      } else if (remZ === 0 || (remX > 0 && tMaxX < tMaxZ)) {
        tMaxX += tDeltaX;
        ix += stepX;
        remX--;
      } else {
        tMaxZ += tDeltaZ;
        iz += stepZ;
        remZ--;
      }
      if (!this._open(ix, iz)) return false;
    }
    return true;
  }

  _open(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.w && iz < this.h && this.walk[iz * this.w + ix] === 1;
  }

  // Resolves the endpoints shared by both searches: {s, t, start0, goal0}, a direct hop, or null.
  _endpoints(from, to) {
    if (!from || !to) return null;
    const start0 = this.nearestWalkable(from.x, from.z, 6);
    const goal0 = this.nearestWalkable(to.x, to.z, 12);
    if (!start0 || !goal0) return null;
    const s = this.index(start0.x, start0.z);
    const t = this.index(goal0.x, goal0.z);
    if (s < 0 || t < 0 || this.region[s] !== this.region[t]) return null;
    if (this.lineWalkable(start0.x, start0.z, goal0.x, goal0.z)) return { direct: [{ x: goal0.x, z: goal0.z }] };
    return { s, t, start0, goal0 };
  }

  // Path from `from` to `to` (world {x, z}), or null if unreachable. Same contract as always:
  // smoothed corner points, excluding the start, ending exactly at the (nearest walkable) goal.
  // Options: maxExpansions bounds the work (jump points for JPS); heuristicWeight > 1 trades a
  // little optimality for speed (JPS rarely needs it).
  findPath(from, to, { maxExpansions = 40000, heuristicWeight = 1 } = {}) {
    const t0 = performance.now();
    const ends = this._endpoints(from, to);
    let out = null;
    if (ends?.direct) out = ends.direct;
    else if (ends) {
      const cells = this._jps(ends.s, ends.t, maxExpansions, heuristicWeight);
      if (cells) out = this._smooth(cells, ends.start0, ends.goal0);
      else {
        // Should not happen within one region; plain A* is the safety net (and honours maxExpansions).
        this.stats.fallbacks++;
        const ref = this._astar(ends.s, ends.t, maxExpansions, 1.2);
        if (ref) out = this._smooth(ref, ends.start0, ends.goal0);
      }
    }
    const ms = performance.now() - t0;
    const st = this.stats;
    st.searches++;
    st.lastMs = ms;
    st.totalMs += ms;
    if (ms > st.maxMs) st.maxMs = ms;
    return out;
  }

  // The previous plain weighted A* (8-connected, no corner cutting). Same contract as findPath.
  findPathReference(from, to, { maxExpansions = 40000, heuristicWeight = 1.2 } = {}) {
    const ends = this._endpoints(from, to);
    if (!ends) return null;
    if (ends.direct) return ends.direct;
    const cells = this._astar(ends.s, ends.t, maxExpansions, heuristicWeight);
    return cells ? this._smooth(cells, ends.start0, ends.goal0) : null;
  }

  // Octile distance in cells.
  _octile(a, b) {
    const w = this.w;
    const ax = a % w, bx = b % w;
    const ddx = Math.abs(ax - bx), ddz = Math.abs((a - ax) / w - (b - bx) / w);
    return ddx > ddz ? ddx + (SQRT2 - 1) * ddz : ddz + (SQRT2 - 1) * ddx;
  }

  _astar(s, t, maxExpansions, heuristicWeight) {
    const { w, walk, g, parent, seen, closed, heap } = this;
    const id = this._nextSearch();
    heap.clear();
    g[s] = 0;
    parent[s] = -1;
    seen[s] = id;
    heap.push(s, this._octile(s, t));
    let expansions = 0;
    let found = false;
    while (heap.size) {
      const c = heap.pop();
      if (closed[c] === id) continue;
      closed[c] = id;
      if (c === t) {
        found = true;
        break;
      }
      if (++expansions > maxExpansions) break;
      const cx = c % w, cz = (c - cx) / w;
      for (const [dx, dz, cost] of NEIGHBOURS) {
        const ni = (cz + dz) * w + cx + dx;
        if (!walk[ni] || closed[ni] === id) continue;
        if (dx && dz && (!walk[cz * w + cx + dx] || !walk[(cz + dz) * w + cx])) continue;
        const ng = g[c] + cost;
        if (seen[ni] !== id || ng < g[ni]) {
          seen[ni] = id;
          g[ni] = ng;
          parent[ni] = c;
          heap.push(ni, ng + this._octile(ni, t) * heuristicWeight);
        }
      }
    }
    this.stats.expansions += expansions;
    if (!found) return null;
    const cells = [];
    for (let c = t; c !== -1; c = parent[c]) cells.push(c);
    return cells.reverse();
  }

  _nextSearch() {
    if (++this.searchId >= 0xffffffff) {
      // Generation counters wrapped (after ~4 billion searches): start the marks afresh.
      this.seen.fill(0);
      this.closed.fill(0);
      this.searchId = 1;
    }
    return this.searchId;
  }

  // --- Jump Point Search -------------------------------------------------------------------
  // Variant for 8-connected moves that never cut a corner (a diagonal step needs both orthogonal
  // neighbours open): straight jumps stop where a side opens up behind an obstacle; diagonal
  // jumps stop where either of their straight components finds a jump point.

  // Straight jump from i (exclusive) along (dx, 0) or (0, dz). Returns the jump point or -1.
  _jumpStraight(i, dx, dz, goal) {
    const walk = this.walk, w = this.w;
    if (dx !== 0) {
      for (;;) {
        i += dx;
        if (!walk[i]) return -1;
        if (i === goal) return i;
        if ((walk[i - w] && !walk[i - dx - w]) || (walk[i + w] && !walk[i - dx + w])) return i;
      }
    }
    const step = dz * w;
    for (;;) {
      i += step;
      if (!walk[i]) return -1;
      if (i === goal) return i;
      if ((walk[i - 1] && !walk[i - 1 - step]) || (walk[i + 1] && !walk[i + 1 - step])) return i;
    }
  }

  _jumpDiagonal(i, dx, dz, goal) {
    const walk = this.walk, w = this.w;
    const sz = dz * w;
    for (;;) {
      if (!walk[i + dx] || !walk[i + sz]) return -1; // no corner cutting
      i += dx + sz;
      if (!walk[i]) return -1;
      if (i === goal) return i;
      if (this._jumpStraight(i, dx, 0, goal) >= 0 || this._jumpStraight(i, 0, dz, goal) >= 0) return i;
    }
  }

  _jps(s, t, maxExpansions, heuristicWeight) {
    const { w, walk, g, parent, seen, closed, heap } = this;
    const id = this._nextSearch();
    heap.clear();
    g[s] = 0;
    parent[s] = -1;
    seen[s] = id;
    heap.push(s, this._octile(s, t) * heuristicWeight);
    const dirs = new Int8Array(16);
    let expansions = 0;
    let found = false;
    while (heap.size) {
      const c = heap.pop();
      if (closed[c] === id) continue;
      closed[c] = id;
      if (c === t) {
        found = true;
        break;
      }
      if (++expansions > maxExpansions) break;
      // Successor directions: all eight from the start, pruned by the arrival direction after.
      let nd = 0;
      const p = parent[c];
      if (p < 0) {
        for (const [dx, dz] of DIRS) {
          dirs[nd++] = dx;
          dirs[nd++] = dz;
        }
      } else {
        const cx = c % w, px = p % w;
        const dx = Math.sign(cx - px), dz = Math.sign((c - cx) / w - (p - px) / w);
        if (dx && dz) {
          const ox = walk[c + dx], oz = walk[c + dz * w];
          if (oz) { dirs[nd++] = 0; dirs[nd++] = dz; }
          if (ox) { dirs[nd++] = dx; dirs[nd++] = 0; }
          if (ox && oz) { dirs[nd++] = dx; dirs[nd++] = dz; }
        } else if (dx) {
          const next = walk[c + dx], up = walk[c - w], down = walk[c + w];
          if (next) {
            dirs[nd++] = dx; dirs[nd++] = 0;
            if (up) { dirs[nd++] = dx; dirs[nd++] = -1; }
            if (down) { dirs[nd++] = dx; dirs[nd++] = 1; }
          }
          if (up) { dirs[nd++] = 0; dirs[nd++] = -1; }
          if (down) { dirs[nd++] = 0; dirs[nd++] = 1; }
        } else {
          const next = walk[c + dz * w], left = walk[c - 1], right = walk[c + 1];
          if (next) {
            dirs[nd++] = 0; dirs[nd++] = dz;
            if (right) { dirs[nd++] = 1; dirs[nd++] = dz; }
            if (left) { dirs[nd++] = -1; dirs[nd++] = dz; }
          }
          if (right) { dirs[nd++] = 1; dirs[nd++] = 0; }
          if (left) { dirs[nd++] = -1; dirs[nd++] = 0; }
        }
      }
      for (let k = 0; k < nd; k += 2) {
        const dx = dirs[k], dz = dirs[k + 1];
        const j = dx && dz ? this._jumpDiagonal(c, dx, dz, t) : this._jumpStraight(c, dx, dz, t);
        if (j < 0 || closed[j] === id) continue;
        const ng = g[c] + this._octile(c, j);
        if (seen[j] !== id || ng < g[j]) {
          seen[j] = id;
          g[j] = ng;
          parent[j] = c;
          heap.push(j, ng + this._octile(j, t) * heuristicWeight);
        }
      }
    }
    this.stats.expansions += expansions;
    if (!found) return null;
    // Expand the jump points back into the full cell sequence (each leg is straight or diagonal).
    const jumps = [];
    for (let c = t; c !== -1; c = parent[c]) jumps.push(c);
    jumps.reverse();
    const cells = [jumps[0]];
    for (let k = 1; k < jumps.length; k++) {
      const a = jumps[k - 1], b = jumps[k];
      const ax = a % w, bx = b % w;
      const ddz = (b - bx) / w - (a - ax) / w;
      const step = Math.sign(bx - ax) + Math.sign(ddz) * w;
      const n = Math.max(Math.abs(bx - ax), Math.abs(ddz));
      for (let m = 1, c = a + step; m < n; m++, c += step) cells.push(c);
      cells.push(b);
    }
    return cells;
  }

  // String-pull a cell path: keep only the corners needed for straight walkable segments.
  _smooth(cells, start0, goal0) {
    const pts = cells.map((c) => this.centerOf(c));
    pts[0] = { x: start0.x, z: start0.z };
    pts[pts.length - 1] = { x: goal0.x, z: goal0.z };
    const out = [];
    let anchor = pts[0];
    for (let k = 2; k < pts.length; k++) {
      if (!this.lineWalkable(anchor.x, anchor.z, pts[k].x, pts[k].z)) {
        anchor = pts[k - 1];
        out.push(anchor);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Random walkable point within `radius` of (x, z) in the same connected region.
  randomPointNear(x, z, radius, rng = Math.random, tries = 24) {
    const region = this.regionAt(x, z) >= 0 ? this.regionAt(x, z) : (() => {
      const p = this.nearestWalkable(x, z);
      return p ? this.regionAt(p.x, p.z) : -1;
    })();
    if (region < 0) return null;
    for (let i = 0; i < tries; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (this.regionAt(px, pz) === region) return { x: px, z: pz };
    }
    return null;
  }
}
