// Grid navigation for ground agents: rasterises the CollisionWorld into a walkable grid
// (obstacles inflated by the agent radius), labels connected regions, and runs A*.
//
//   const nav = new NavGrid(world, { minX, maxX, minZ, maxZ }, { cell: 0.5, agentRadius: 0.45 });
//   nav.build();
//   nav.findPath({x, z}, {x, z}) -> [{x, z}, ...]  (smoothed; excludes the start; ends at goal) or null
//
// Paths are cheap for short hops (< ~60 m). Call rebuildArea() after toggling colliders (gates).

const SQRT2 = Math.SQRT2;
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  get size() {
    return this.items.length;
  }
  clear() {
    this.items.length = 0;
    this.keys.length = 0;
  }
  push(item, key) {
    const a = this.items, k = this.keys;
    let i = a.length;
    a.push(item);
    k.push(key);
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
    const lastItem = a.pop();
    const lastKey = k.pop();
    const n = a.length;
    if (n > 0) {
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
    this.w = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    const n = this.w * this.h;
    this.walk = new Uint8Array(n);
    this.region = new Int32Array(n);
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.searchId = 0;
    this.heap = new MinHeap();
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

  _labelRegions() {
    const { w, h, walk, region } = this;
    region.fill(-1);
    let next = 0;
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!walk[i] || region[i] >= 0) continue;
      region[i] = next;
      stack.push(i);
      while (stack.length) {
        const c = stack.pop();
        const cx = c % w;
        const cz = (c - cx) / w;
        for (const [dx, dz] of NEIGHBOURS) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const ni = nz * w + nx;
          if (!walk[ni] || region[ni] >= 0) continue;
          if (dx && dz && (!walk[cz * w + nx] || !walk[nz * w + cx])) continue;
          region[ni] = next;
          stack.push(ni);
        }
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
    if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) return -1;
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

  // Closest walkable cell centre within maxCells rings (or null).
  nearestWalkable(x, z, maxCells = 20) {
    const cx = this.cellX(x), cz = this.cellZ(z);
    for (let r = 0; r <= maxCells; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx, iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= this.w || iz >= this.h) continue;
          const i = iz * this.w + ix;
          if (!this.walk[i]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return r === 0 ? { x, z } : this.centerOf(best);
    }
    return null;
  }

  // Supercover grid traversal: true if every cell the segment touches is walkable.
  lineWalkable(ax, az, bx, bz) {
    const c = this.cell;
    let ix = this.cellX(ax), iz = this.cellZ(az);
    const tx = this.cellX(bx), tz = this.cellZ(bz);
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

  findPath(from, to, { maxExpansions = 40000 } = {}) {
    const start0 = this.nearestWalkable(from.x, from.z, 6);
    const goal0 = this.nearestWalkable(to.x, to.z, 12);
    if (!start0 || !goal0) return null;
    const s = this.index(start0.x, start0.z);
    const t = this.index(goal0.x, goal0.z);
    if (s < 0 || t < 0 || this.region[s] !== this.region[t]) return null;
    if (this.lineWalkable(start0.x, start0.z, goal0.x, goal0.z)) return [{ x: goal0.x, z: goal0.z }];

    const { w, walk, g, parent, seen, closed, heap } = this;
    const id = ++this.searchId;
    const tx = t % w, tz = (t - tx) / w;
    const hfn = (i) => {
      const x = i % w, z = (i - x) / w;
      const ddx = Math.abs(x - tx), ddz = Math.abs(z - tz);
      return (ddx + ddz) + (SQRT2 - 2) * Math.min(ddx, ddz);
    };
    heap.clear();
    g[s] = 0;
    parent[s] = -1;
    seen[s] = id;
    heap.push(s, hfn(s));
    let found = false;
    let expansions = 0;
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
        const nx = cx + dx, nz = cz + dz;
        const ni = nz * w + nx;
        if (!walk[ni] || closed[ni] === id) continue;
        if (dx && dz && (!walk[cz * w + nx] || !walk[nz * w + cx])) continue;
        const ng = g[c] + cost;
        if (seen[ni] !== id || ng < g[ni]) {
          seen[ni] = id;
          g[ni] = ng;
          parent[ni] = c;
          heap.push(ni, ng + hfn(ni) * 1.001);
        }
      }
    }
    if (!found) return null;

    const cells = [];
    for (let c = t; c !== -1; c = parent[c]) cells.push(c);
    cells.reverse();
    // String-pull: keep only the corners needed for straight walkable segments.
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
