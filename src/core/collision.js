// 2.5D collision world made of boxes that may be rotated about the Y axis.
//
// A box is described the same way you would build its mesh:
//   world.addBox({ x, z, w, d, h, y = 0, rot = 0 })
//   -> mesh = new Mesh(new BoxGeometry(w, h, d)); mesh.position.set(x, y + h / 2, z); mesh.rotation.y = rot
//
// Queries:
//   resolveCircle(pos, radius, opts)    push a vertical capsule out of solid boxes (mutates pos.x / pos.z)
//   segmentBlocked(a, b, opts)          true if any sight-blocking box intersects segment a->b (3D)
//   raycast(origin, dir, maxDist, opts) nearest hit {t, point, normal, collider} or null (3D, dir normalized)

export class CollisionWorld {
  constructor(cellSize = 8) {
    this.cellSize = cellSize;
    this.colliders = [];
    this.grid = new Map();
    this.stamp = 1;
    this._tmp = [];
  }

  addBox({
    x, z, w, d, h, y = 0, rot = 0,
    blocksMove = true, blocksSight = true, tag = null, data = null,
  }) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hx = w / 2;
    const hz = d / 2;
    // World-space extents of the rotated rectangle.
    const ex = Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    const col = {
      id: this.colliders.length,
      cx: x, cz: z, hx, hz, minY: y, maxY: y + h, rot, cos: c, sin: s,
      minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez,
      blocksMove, blocksSight, enabled: true, tag, data, _stamp: 0,
    };
    this.colliders.push(col);
    this._insert(col);
    return col;
  }

  setEnabled(col, enabled) {
    col.enabled = enabled;
  }

  _insert(col) {
    const cs = this.cellSize;
    for (let ix = Math.floor(col.minX / cs); ix <= Math.floor(col.maxX / cs); ix++) {
      for (let iz = Math.floor(col.minZ / cs); iz <= Math.floor(col.maxZ / cs); iz++) {
        const key = ix * 73856093 ^ iz * 19349663;
        let cell = this.grid.get(key);
        if (!cell) this.grid.set(key, (cell = []));
        cell.push(col);
      }
    }
  }

  // Colliders whose world AABB overlaps the rectangle. Returned array is reused; copy if you keep it.
  query(minX, minZ, maxX, maxZ, out = this._tmp) {
    out.length = 0;
    const stamp = ++this.stamp;
    const cs = this.cellSize;
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.grid.get(ix * 73856093 ^ iz * 19349663);
        if (!cell) continue;
        for (const col of cell) {
          if (col._stamp === stamp) continue;
          col._stamp = stamp;
          if (col.maxX < minX || col.minX > maxX || col.maxZ < minZ || col.minZ > maxZ) continue;
          out.push(col);
        }
      }
    }
    return out;
  }

  // Pushes a vertical cylinder (feet at pos.y) out of every solid box it overlaps.
  // Boxes lower than stepHeight above the feet, or entirely above the head, are ignored.
  resolveCircle(pos, radius, { height = 1.7, stepHeight = 0.45, iterations = 3 } = {}) {
    let hit = false;
    const feet = pos.y || 0;
    for (let it = 0; it < iterations; it++) {
      let moved = false;
      const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
      for (const col of list) {
        if (!col.enabled || !col.blocksMove) continue;
        if (col.maxY <= feet + stepHeight || col.minY >= feet + height) continue;
        const dx = pos.x - col.cx;
        const dz = pos.z - col.cz;
        const lx = col.cos * dx - col.sin * dz;
        const lz = col.sin * dx + col.cos * dz;
        const qx = Math.max(-col.hx, Math.min(col.hx, lx));
        const qz = Math.max(-col.hz, Math.min(col.hz, lz));
        let px = lx - qx;
        let pz = lz - qz;
        const d2 = px * px + pz * pz;
        if (d2 >= radius * radius) continue;
        let pushX, pushZ;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          pushX = (px / d) * (radius - d);
          pushZ = (pz / d) * (radius - d);
        } else {
          // Centre is inside the box: leave through the nearest face.
          const penX = col.hx - Math.abs(lx);
          const penZ = col.hz - Math.abs(lz);
          if (penX < penZ) {
            pushX = (lx >= 0 ? 1 : -1) * (penX + radius);
            pushZ = 0;
          } else {
            pushX = 0;
            pushZ = (lz >= 0 ? 1 : -1) * (penZ + radius);
          }
        }
        pos.x += col.cos * pushX + col.sin * pushZ;
        pos.z += -col.sin * pushX + col.cos * pushZ;
        hit = moved = true;
      }
      if (!moved) break;
    }
    return hit;
  }

  // Slab test of segment a->b against one collider. Returns entry t in [0,1] or -1, and writes the
  // local-space axis of the entry face into this._axis (0 = x, 1 = y, 2 = z) and its sign.
  _segmentT(col, ax, ay, az, bx, by, bz) {
    const dax = ax - col.cx, daz = az - col.cz;
    const dbx = bx - col.cx, dbz = bz - col.cz;
    const lax = col.cos * dax - col.sin * daz;
    const laz = col.sin * dax + col.cos * daz;
    const lbx = col.cos * dbx - col.sin * dbz;
    const lbz = col.sin * dbx + col.cos * dbz;
    const o = [lax, ay, laz];
    const dv = [lbx - lax, by - ay, lbz - laz];
    const lo = [-col.hx, col.minY, -col.hz];
    const hi = [col.hx, col.maxY, col.hz];
    let tmin = 0, tmax = 1, axis = -1, sign = 0;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dv[i]) < 1e-9) {
        if (o[i] < lo[i] || o[i] > hi[i]) return -1;
        continue;
      }
      const inv = 1 / dv[i];
      let t1 = (lo[i] - o[i]) * inv;
      let t2 = (hi[i] - o[i]) * inv;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1; t1 = t2; t2 = tmp;
        s = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        axis = i;
        sign = s;
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    this._axis = axis;
    this._sign = sign;
    return tmin;
  }

  // True if a sight-blocking box lies between a and b ({x,y,z} objects, e.g. THREE.Vector3).
  segmentBlocked(a, b, { ignore = null, includeDisabled = false } = {}) {
    const list = this.query(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z));
    for (const col of list) {
      if (!col.blocksSight || col === ignore) continue;
      if (!col.enabled && !includeDisabled) continue;
      if (this._segmentT(col, a.x, a.y, a.z, b.x, b.y, b.z) >= 0) return true;
    }
    return false;
  }

  // Nearest box hit along a ray. opts.filter(col) -> bool can restrict candidates.
  raycast(origin, dir, maxDist, { filter = null } = {}) {
    const bx = origin.x + dir.x * maxDist;
    const by = origin.y + dir.y * maxDist;
    const bz = origin.z + dir.z * maxDist;
    const list = this.query(Math.min(origin.x, bx), Math.min(origin.z, bz), Math.max(origin.x, bx), Math.max(origin.z, bz));
    let best = null;
    let bestT = Infinity;
    let bestAxis = -1, bestSign = 0;
    for (const col of list) {
      if (!col.enabled) continue;
      if (filter && !filter(col)) continue;
      const t = this._segmentT(col, origin.x, origin.y, origin.z, bx, by, bz);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = col;
        bestAxis = this._axis;
        bestSign = this._sign;
      }
    }
    if (!best) return null;
    const dist = bestT * maxDist;
    let nx = 0, ny = 0, nz = 0;
    if (bestAxis === 1) ny = bestSign;
    else if (bestAxis === 0 || bestAxis === 2) {
      const lx = bestAxis === 0 ? bestSign : 0;
      const lz = bestAxis === 2 ? bestSign : 0;
      nx = best.cos * lx + best.sin * lz;
      nz = -best.sin * lx + best.cos * lz;
    }
    return {
      t: dist,
      point: { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist, z: origin.z + dir.z * dist },
      normal: { x: nx, y: ny, z: nz },
      collider: best,
    };
  }

  // Is the point inside any enabled solid box (optionally padded in XZ)?
  pointBlocked(x, y, z, pad = 0) {
    const list = this.query(x - pad, z - pad, x + pad, z + pad);
    for (const col of list) {
      if (!col.enabled || !col.blocksMove) continue;
      if (y < col.minY || y > col.maxY) continue;
      const dx = x - col.cx, dz = z - col.cz;
      const lx = col.cos * dx - col.sin * dz;
      const lz = col.sin * dx + col.cos * dz;
      if (Math.abs(lx) <= col.hx + pad && Math.abs(lz) <= col.hz + pad) return true;
    }
    return false;
  }
}
