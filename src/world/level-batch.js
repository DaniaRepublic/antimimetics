import * as THREE from 'three';

// Static geometry accumulator. Everything the level builds is pushed into a buffer keyed by
// material and by a coarse z-chunk, then merged into one indexed mesh per key so the whole city
// costs a few dozen draw calls while chunks still frustum-cull.
//
//   const b = new Batch({ chunkSize: 90 });
//   b.box('concrete', mat(x, 0, z, yaw), 2, 1, 4, color);
//   b.geom('metal', cylinderGeometry, mat(...), color);
//   b.quad('facade', [p0, p1, p2, p3], [u0, v0, u1, v1, ...], color, { aLit: [seed, p] });
//   const group = b.build(materials);

const _m3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

// Matrix helper: translation, yaw (about Y), pitch (X), roll (Z), optional scale.
export function mat(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

// Child transform: parent * local.
export function sub(parent, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().multiplyMatrices(parent, mat(x, y, z, ry, rx, rz, sx, sy, sz));
}

class GeoBuffer {
  constructor(extras) {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.extras = {};
    for (const [name, size] of Object.entries(extras || {})) this.extras[name] = { size, data: [] };
    this.count = 0;
  }

  vertex(px, py, pz, nx, ny, nz, u, v, r, g, b, extra) {
    this.pos.push(px, py, pz);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    for (const [name, e] of Object.entries(this.extras)) {
      const val = extra?.[name];
      for (let i = 0; i < e.size; i++) e.data.push(val ? val[i] ?? 0 : 0);
    }
    return this.count++;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    for (const [name, e] of Object.entries(this.extras)) g.setAttribute(name, new THREE.Float32BufferAttribute(e.data, e.size));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Box faces: [normal axis, sign, u axis, v axis] in local space (u/v chosen so textures are upright).
const BOX_FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];
export const FACE = { px: 1, nx: 2, py: 4, ny: 8, pz: 16, nz: 32, all: 63, noBottom: 55 };

export class Batch {
  // chunkSizes: per-material override of chunkSize (Infinity = one mesh for the whole level).
  // Light, sparse materials gain nothing from culling, so they are merged whole to save draw calls.
  constructor({ chunkSize = 90, chunkSizes = {}, extras = {} } = {}) {
    this.chunkSize = chunkSize;
    this.chunkSizes = chunkSizes;
    this.extras = extras; // { materialKey: { attrName: size } }
    this.buffers = new Map();
    this.triangles = 0;
  }

  buffer(key, z) {
    const size = this.chunkSizes[key] ?? this.chunkSize;
    const chunk = Number.isFinite(size) ? Math.floor(z / size) : 0;
    const id = key + '|' + chunk;
    let b = this.buffers.get(id);
    if (!b) {
      b = new GeoBuffer(this.extras[key]);
      b.key = key;
      this.buffers.set(id, b);
    }
    return b;
  }

  // Axis-aligned box in local space centred on x/z with its base at y = 0, transformed by m.
  // opts: uvScale (metres per texture repeat, default 2), faces (bitmask), ao (0..1 darkening at the
  // base), top (colour multiplier for the top face), uv: 'world' (default) | 'unit' (0..1 per face),
  // uvRect [u0, v0, u1, v1] for 'unit' mapping, extra (per-vertex extra attributes).
  box(key, m, w, h, d, color = WHITE, opts = {}) {
    const { uvScale = 2, ao = 0.35, top = 1, uv = 'world', uvRect = null, extra = null, y0 = 0 } = opts;
    // Boxes resting on the ground skip their invisible bottom; raised ones (slabs, roofs) keep it.
    const faces = opts.faces ?? (m.elements[13] > 0.25 ? FACE.all : FACE.noBottom);
    const b = this.buffer(key, m.elements[14]);
    _m3.getNormalMatrix(m);
    const hx = w / 2, hz = d / 2;
    for (let f = 0; f < 6; f++) {
      if (!(faces & (1 << f))) continue;
      const F = BOX_FACES[f];
      const n = F.n, ua = F.u, va = F.v;
      // Face extents along u and v axes, and centre offset along the normal.
      const ext = (axis) => (axis[0] ? hx : axis[1] ? h / 2 : hz);
      const eu = ext(ua), ev = ext(va);
      const cx = n[0] * hx, cy = h / 2 + n[1] * (h / 2) + y0, cz = n[2] * hz;
      const shadeTop = n[1] > 0 ? top : 1;
      _n.set(n[0], n[1], n[2]).applyMatrix3(_m3).normalize();
      const base = b.count;
      for (let k = 0; k < 4; k++) {
        const su = k === 1 || k === 2 ? 1 : -1;
        const sv = k >= 2 ? 1 : -1;
        const lx = cx + ua[0] * eu * su + va[0] * ev * sv;
        const ly = cy + ua[1] * eu * su + va[1] * ev * sv;
        const lz = cz + ua[2] * eu * su + va[2] * ev * sv;
        _v.set(lx, ly, lz).applyMatrix4(m);
        let u, v;
        if (uv === 'unit') {
          const r = uvRect || [0, 0, 1, 1];
          u = su > 0 ? r[2] : r[0];
          v = sv > 0 ? r[3] : r[1];
        } else {
          // World-scaled: distance along the face axes (local), so textures keep density.
          u = (ua[0] * lx + ua[1] * ly + ua[2] * lz) / uvScale;
          v = (va[0] * lx + va[1] * ly + va[2] * lz) / uvScale;
        }
        const shade = (1 - ao * (1 - Math.min(1, (ly - y0) / Math.max(0.6, Math.min(h, 2.5))))) * shadeTop;
        b.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, v, color.r * shade, color.g * shade, color.b * shade, extra);
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      this.triangles += 2;
    }
  }

  // Arbitrary BufferGeometry (indexed or not) transformed by m. opts: uvScale -> planar world UVs
  // (xz) instead of the geometry's own, ao: darken towards local y = 0 over aoHeight.
  geom(key, g, m, color = WHITE, opts = {}) {
    const { ao = 0, aoHeight = 1.5, extra = null, uvScale = 0 } = opts;
    const b = this.buffer(key, m.elements[14]);
    _m3.getNormalMatrix(m);
    const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
    const base = b.count;
    for (let i = 0; i < P.count; i++) {
      const ly = P.getY(i);
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      if (N) _n.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize();
      else _n.set(0, 1, 0);
      let u = U ? U.getX(i) : 0, v = U ? U.getY(i) : 0;
      if (uvScale) {
        u = (_v.x + _v.z * 0.37) / uvScale;
        v = (_v.y + _v.z * 0.61) / uvScale;
      }
      const shade = ao ? 1 - ao * (1 - Math.min(1, Math.max(0, ly) / aoHeight)) : 1;
      b.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, v, color.r * shade, color.g * shade, color.b * shade, extra);
    }
    if (g.index) {
      const I = g.index.array;
      for (let i = 0; i < I.length; i++) b.idx.push(base + I[i]);
      this.triangles += I.length / 3;
    } else {
      for (let i = 0; i < P.count; i++) b.idx.push(base + i);
      this.triangles += P.count / 3;
    }
  }

  // Quad from 4 world points (counter-clockwise seen from the front), uvs = [u0,v0,...,u3,v3].
  quad(key, pts, uvs, color = WHITE, extra = null, colors = null) {
    const b = this.buffer(key, (pts[0].z + pts[2].z) / 2);
    const ax = pts[1].x - pts[0].x, ay = pts[1].y - pts[0].y, az = pts[1].z - pts[0].z;
    const bx = pts[3].x - pts[0].x, by = pts[3].y - pts[0].y, bz = pts[3].z - pts[0].z;
    _n.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx).normalize();
    const base = b.count;
    for (let k = 0; k < 4; k++) {
      const p = pts[k];
      const c = colors ? colors[k] : color;
      b.vertex(p.x, p.y, p.z, _n.x, _n.y, _n.z, uvs[k * 2], uvs[k * 2 + 1], c.r, c.g, c.b, extra);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.triangles += 2;
  }

  // Flat horizontal quad (decals, ground pieces) centred at x/z with yaw, at height y.
  flat(key, x, y, z, w, d, yaw, uvRect, color = WHITE, extra = null) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const corner = (lx, lz) => ({ x: x + c * lx + s * lz, y, z: z - s * lx + c * lz });
    const hw = w / 2, hd = d / 2;
    const [u0, v0, u1, v1] = uvRect;
    this.quad(key, [corner(-hw, hd), corner(hw, hd), corner(hw, -hd), corner(-hw, -hd)], [u0, v0, u1, v0, u1, v1, u0, v1], color, extra);
  }

  // Vertical quad facing direction `yaw` (its normal = yawToDir(yaw)), bottom centre at x/y/z.
  wall(key, x, y, z, w, h, yaw, uvRect, color = WHITE, extra = null) {
    // (lx, lz) is the left-hand side of a viewer standing in front of the face looking at it.
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const hw = w / 2;
    const p0 = { x: x + lx * hw, y, z: z + lz * hw };
    const p1 = { x: x - lx * hw, y, z: z - lz * hw };
    const p2 = { x: p1.x, y: y + h, z: p1.z };
    const p3 = { x: p0.x, y: y + h, z: p0.z };
    const [u0, v0, u1, v1] = uvRect;
    this.quad(key, [p0, p1, p2, p3], [u0, v0, u1, v0, u1, v1, u0, v1], color, extra);
  }

  build(materials, { name = 'level-static' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [id, b] of this.buffers) {
      if (!b.count) continue;
      const material = materials[b.key];
      if (!material) throw new Error(`Batch: no material for key "${b.key}"`);
      const mesh = new THREE.Mesh(b.toGeometry(), material);
      mesh.name = id;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    this.buffers.clear();
    return group;
  }
}

// Shared lightweight geometries (created once).
const _geoCache = new Map();
export function cachedGeo(key, make) {
  let g = _geoCache.get(key);
  if (!g) _geoCache.set(key, (g = make()));
  return g;
}

export const cyl = (rt, rb, h, seg = 8, open = false) =>
  cachedGeo(`cyl${rt},${rb},${h},${seg},${open}`, () => {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
    g.translate(0, h / 2, 0);
    return g;
  });
