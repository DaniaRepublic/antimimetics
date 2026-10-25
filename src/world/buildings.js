import * as THREE from 'three';
import { mat, sub, cyl, FACE } from './level-batch.js';
import { BAY, FLOOR, FACADE_CELLS, STOREFRONT, storeUV, STORE } from './textures.js';
import { COL, shade, mix, color } from './props.js';

// City blocks. Buildings are axis-aligned boxes [x0,x1] x [z0,z1] (x0 < x1, z0 < z1, north = -Z)
// with textured facades, optional ground-floor storefronts, fire escapes, rooftop clutter and
// collapsed sections. Faces: 'n' (z = z0, faces -Z), 's' (z = z1), 'e' (x = x1), 'w' (x = x0).

const STORE_H = 4.4;
const FACE_YAW = { n: 0, s: Math.PI, e: -Math.PI / 2, w: Math.PI / 2 };

export const TINTS = {
  brick: [0xf2ddd4, 0xe0c8bc, 0xffe6da, 0xd4c4bc, 0xead2c4, 0xc8b0a6].map((h) => color(h)),
  concrete: [0xeeeae4, 0xdcd8d2, 0xf4ece0, 0xd2d2d0, 0xe4dcd0].map((h) => color(h)),
  stone: [0xfff4e4, 0xece0d0, 0xf8e8d0, 0xe0dad0, 0xf0e4d2].map((h) => color(h)),
};

// Face geometry: centre on the ground, width along the face and outward normal.
function faceInfo(b, f) {
  const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  if (f === 'n') return { x: cx, z: b.z0, w: b.x1 - b.x0, nx: 0, nz: -1, along: (t) => ({ x: b.x0 + t, z: b.z0 }) };
  if (f === 's') return { x: cx, z: b.z1, w: b.x1 - b.x0, nx: 0, nz: 1, along: (t) => ({ x: b.x1 - t, z: b.z1 }) };
  if (f === 'e') return { x: b.x1, z: cz, w: b.z1 - b.z0, nx: 1, nz: 0, along: (t) => ({ x: b.x1, z: b.z0 + t }) };
  return { x: b.x0, z: cz, w: b.z1 - b.z0, nx: -1, nz: 0, along: (t) => ({ x: b.x0, z: b.z1 - t }) };
}

// One facade quad from yA to yB, texture-mapped in whole bays so windows meet the corners.
function facadeQuad(B, key, F, yA, yB, uOff, vOff, tint, lit, dark = 0.72) {
  const cols = Math.max(1, Math.round(F.w / BAY));
  const u0 = uOff / FACADE_CELLS, u1 = (uOff + cols) / FACADE_CELLS;
  const v0 = vOff / FACADE_CELLS, v1 = (vOff + (yB - yA) / FLOOR) / FACADE_CELLS;
  const yaw = FACE_YAW[F.f];
  const ox = F.nx * 0.0, oz = F.nz * 0.0;
  const lx = Math.cos(yaw), lz = -Math.sin(yaw);
  const hw = F.w / 2;
  const p0 = { x: F.x + ox + lx * hw, y: yA, z: F.z + oz + lz * hw };
  const p1 = { x: F.x + ox - lx * hw, y: yA, z: F.z + oz - lz * hw };
  const p2 = { x: p1.x, y: yB, z: p1.z };
  const p3 = { x: p0.x, y: yB, z: p0.z };
  const lo = yA < 1 ? shade(tint, dark) : shade(tint, 0.9);
  const hi = shade(tint, 1.04);
  B.batch.quad(key, [p0, p1, p2, p3], [u0, v0, u1, v0, u1, v1, u0, v1], tint, { aLit: lit }, [lo, lo, hi, hi]);
}

// A storefront band along a face, split into ~6 m shop units.
function storefrontBand(B, F, kinds, rng, tint) {
  const n = Math.max(1, Math.round(F.w / STOREFRONT.width));
  const w = F.w / n;
  const yaw = FACE_YAW[F.f];
  const fronts = [];
  for (let i = 0; i < n; i++) {
    const kind = Array.isArray(kinds) ? kinds[i % kinds.length] : rng.pick([STORE.shutter, STORE.smashed, STORE.boarded, STORE.halfShutter, STORE.papered, STORE.barred, STORE.shutter]);
    const p = F.along(w * (i + 0.5));
    const pos = { x: p.x + F.nx * 0.02, z: p.z + F.nz * 0.02 };
    if (kind !== null && kind !== undefined && kind >= 0) {
      B.batch.wall(kind === STORE.laundry ? 'storeLit' : 'store', pos.x, 0, pos.z, w, STORE_H, yaw, storeUV(kind), shade(color(0xffffff), 0.85 + rng() * 0.25));
    }
    fronts.push({ kind, x: pos.x, z: pos.z, w, yaw });
    // Awnings: torn fabric on a frame, some collapsed.
    if (kind !== STORE.laundry && rng() < 0.3) {
      const fabric = rng.pick([color(0x5a1a16), color(0x1e3a2c), color(0x3a2a1e), color(0x2a2a36)]);
      const M = mat(pos.x + F.nx * 0.7, 3.55, pos.z + F.nz * 0.7, yaw, 0.35 + (rng() < 0.3 ? 0.5 : 0));
      B.batch.box('rough', M, w * 0.85, 0.04, 1.5, fabric, { ao: 0 });
    }
  }
  // Ledge above the shops.
  const ledge = mat(F.x + F.nx * 0.12, STORE_H, F.z + F.nz * 0.12, FACE_YAW[F.f]);
  B.batch.box('rough', ledge, F.w + 0.1, 0.32, 0.3, shade(tint, 0.55), { ao: 0 });
  return fronts;
}

// Fire escape: platforms on every floor, railings, zig-zag ladders. t = distance along face.
function fireEscape(B, F, t, yStart, yEnd) {
  const yaw = FACE_YAW[F.f];
  const p = F.along(t);
  const M = mat(p.x + F.nx * 0.55, 0, p.z + F.nz * 0.55, yaw);
  const c = color(0x1c1a19);
  let k = 0;
  for (let y = yStart; y < yEnd - 1.5; y += FLOOR, k++) {
    const P = sub(M, 0, y, 0);
    B.batch.box('metal', P, 3.0, 0.06, 1.1, c, { ao: 0 });
    B.batch.box('metal', sub(P, 0, 0.95, -0.52), 3.0, 0.04, 0.04, c, { ao: 0 });
    for (const sx of [-1.48, 1.48]) B.batch.box('metal', sub(P, sx, 0, 0), 0.04, 1.0, 1.1, c, { ao: 0, faces: FACE.px | FACE.nx });
    // balusters (cheap: one thin slab with gaps implied by darkness)
    for (let bx = -1.3; bx <= 1.3; bx += 0.33) B.batch.box('metal', sub(P, bx, 0, -0.53), 0.02, 0.95, 0.02, c, { ao: 0, faces: FACE.pz | FACE.nz });
    // ladder to the next platform
    const dir = k % 2 ? 1 : -1;
    const L = sub(P, dir * 0.5, 0.06, -0.15, 0, 0, dir * -0.82);
    B.batch.box('metal', L, 0.45, Math.hypot(FLOOR, 2.0) * 0.98, 0.05, c, { ao: 0, faces: FACE.pz | FACE.nz | FACE.px | FACE.nx });
  }
}

function rooftop(B, b, h, rng, tint) {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  if (w < 6 || d < 6) return;
  const rx = () => b.x0 + 2 + rng() * (w - 4);
  const rz = () => b.z0 + 2 + rng() * (d - 4);
  const nAc = rng.int(0, 3);
  for (let i = 0; i < nAc; i++) B.batch.box('metal', mat(rx(), h, rz(), rng() < 0.5 ? 0 : Math.PI / 2), 2.2, 1.3, 1.6, color(0x5a5a56), { ao: 0.3 });
  if (rng() < 0.55) {
    // stair bulkhead
    B.batch.box('rough', mat(rx(), h, rz()), 3, 3, 3.5, shade(tint, 0.5), { ao: 0.3 });
  }
  if (b.waterTower ?? rng() < 0.35) {
    const x = rx(), z = rz();
    const legH = 3.5 + rng() * 2;
    for (const [sx, sz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) {
      B.batch.box('metal', mat(x + sx, h, z + sz), 0.18, legH, 0.18, COL.darkSteel, { ao: 0 });
    }
    B.batch.box('metal', mat(x, h + legH * 0.5, z, 0.785), 3.6, 0.1, 0.1, COL.darkSteel, { ao: 0 });
    B.batch.geom('rough', cyl(2.0, 2.0, 3.8, 14), mat(x, h + legH, z), mix(COL.wood, COL.char, 0.4), { ao: 0 });
    B.batch.geom('rough', cyl(0.05, 2.2, 1.4, 14), mat(x, h + legH + 3.8, z), COL.char);
  }
  if (rng() < 0.35) {
    // antenna mast with cross bars
    const x = rx(), z = rz(), ah = 6 + rng() * 10;
    B.batch.geom('metal', cyl(0.05, 0.1, ah, 5), mat(x, h, z), COL.darkSteel);
    for (let y = ah * 0.4; y < ah; y += 1.6) B.batch.box('metal', mat(x, h + y, z, rng() * 3), 1.4 - y * 0.05, 0.05, 0.05, COL.darkSteel, { ao: 0 });
  }
}

let bseed = 1;

// Build one block. Returns { fronts: [storefront info...] } for the caller to light or dress.
export function building(B, spec) {
  const rng = B.rng;
  const { x0, x1, z0, z1, style = 'brick' } = spec;
  const tint = spec.tint || rng.pick(TINTS[style]).clone().multiplyScalar(0.85 + rng() * 0.25);
  const key = 'facade_' + style;
  const store = spec.store || {};
  const faces = spec.faces || ['n', 's', 'e', 'w'];
  const seed = (bseed++ * 13.37) % 997;
  const litP = spec.lit ?? 0.05;
  const b = { x0, x1, z0, z1, waterTower: spec.waterTower };
  // Snap the height so the top floor ends under the parapet instead of mid-window.
  const y0 = spec.y0 || 0; // raised base (arches, open ground floors built by the caller)
  const base = Object.keys(store).length ? STORE_H : y0;
  const h = spec.exactH ? spec.h : base + Math.max(1, Math.round((spec.h - base) / FLOOR)) * FLOOR + 0.45;
  const fronts = [];
  let fi = 0;
  for (const f of faces) {
    const F = { ...faceInfo(b, f), f };
    const lit = [seed + fi * 17.3, litP];
    const uOff = rng.int(0, FACADE_CELLS - 1), vOff = rng.int(0, FACADE_CELLS - 1);
    if (store[f]) {
      fronts.push(...storefrontBand(B, F, store[f] === true ? null : store[f], rng, tint));
      facadeQuad(B, key, F, STORE_H, h, uOff, vOff, tint, lit);
    } else {
      facadeQuad(B, key, F, y0, h, uOff, vOff, tint, lit);
    }
    if (spec.fireEscape?.includes(f) && h > 10) fireEscape(B, F, F.w * (0.3 + rng() * 0.4), base + FLOOR * 0.95 + (base ? 0 : 1), h);
    fi++;
  }
  // Roof, parapet, cornice
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  B.batch.box('rough', mat(cx, h - 0.05, cz), w - 0.1, 0.05, d - 0.1, color(0x3a3532), { faces: FACE.py, ao: 0, uvScale: 6 });
  const pc = shade(tint, 0.55);
  if (spec.parapet !== false) {
    B.batch.box('rough', mat(cx, h, z0 + 0.15), w, 0.9, 0.3, pc, { ao: 0 });
    B.batch.box('rough', mat(cx, h, z1 - 0.15), w, 0.9, 0.3, pc, { ao: 0 });
    B.batch.box('rough', mat(x0 + 0.15, h, cz), 0.3, 0.9, d - 0.6, pc, { ao: 0 });
    B.batch.box('rough', mat(x1 - 0.15, h, cz), 0.3, 0.9, d - 0.6, pc, { ao: 0 });
  }
  if (style === 'stone' || spec.cornice) {
    B.batch.box('rough', mat(cx, h - 0.9, cz), w + 0.6, 0.55, d + 0.6, shade(tint, 0.8), { ao: 0 });
    B.batch.box('rough', mat(cx, h - 0.35, cz), w + 0.3, 0.12, d + 0.3, shade(tint, 0.6), { ao: 0 });
  }
  if (spec.roof !== false) rooftop(B, b, h, rng, tint);
  if (y0 > 0) B.batch.box('rough', mat(cx, y0, cz), w, 0.3, d, shade(tint, 0.4), { faces: FACE.ny, ao: 0, uvScale: 4 });
  if (spec.collider !== false) B.solid(cx, cz, w, d, h - y0, 0, { tag: 'building', y: y0 });
  return { h, fronts, tint };
}

// A building whose top has fallen in: slices along its long axis with jagged heights, exposed
// floor slabs and rebar where neighbours are lower.
export function ruin(B, spec) {
  const rng = B.rng;
  const { x0, x1, z0, z1, style = 'concrete' } = spec;
  const alongX = x1 - x0 >= z1 - z0;
  const len = alongX ? x1 - x0 : z1 - z0;
  const n = spec.slices || Math.max(3, Math.round(len / 5));
  const heights = spec.heights || Array.from({ length: n }, (_, i) => spec.h * (i === 0 ? 1 : 0.25 + rng() * 0.75));
  const tint = rng.pick(TINTS[style]).clone();
  const key = 'facade_' + style;
  const seed = (bseed++ * 13.37) % 997;
  const inner = color(0x2a2522);
  const sl = len / n;
  for (let i = 0; i < n; i++) {
    const b = alongX ? { x0: x0 + i * sl, x1: x0 + (i + 1) * sl, z0, z1 } : { x0, x1, z0: z0 + i * sl, z1: z0 + (i + 1) * sl };
    const h = heights[i];
    const faces = alongX ? ['n', 's'] : ['e', 'w'];
    if (i === 0) faces.push(alongX ? 'w' : 'n');
    if (i === n - 1) faces.push(alongX ? 'e' : 's');
    for (const f of faces) {
      const F = { ...faceInfo(b, f), f };
      // keep window columns continuous across slices (u runs along the viewer's left -> right)
      const along = alongX ? (f === 'n' ? (n - 1 - i) * sl : i * sl) : (f === 'e' ? (n - 1 - i) * sl : i * sl);
      facadeQuad(B, key, F, 0, h, Math.round(along / BAY) % FACADE_CELLS, 2, tint, [seed, 0.02]);
    }
    // Exposed interior faces where the neighbour is lower.
    for (const [j, f] of [[i - 1, alongX ? 'w' : 'n'], [i + 1, alongX ? 'e' : 's']]) {
      if (j < 0 || j >= n) continue;
      const hn = heights[j];
      if (hn >= h - 0.5) continue;
      const F = { ...faceInfo(b, f), f };
      const yaw = FACE_YAW[f];
      B.batch.wall('rough', F.x + F.nx * 0.01, hn, F.z + F.nz * 0.01, F.w, h - hn, yaw, [0, hn / 3, F.w / 3, h / 3], inner);
      for (let y = Math.ceil(hn / FLOOR) * FLOOR; y < h - 0.5; y += FLOOR) {
        // slab ends sticking out, a few hanging down
        const M = mat(F.x + F.nx * 0.4, y - 0.25, F.z + F.nz * 0.4, yaw, rng() < 0.25 ? -0.4 : 0);
        B.batch.box('rough', M, F.w * (0.5 + rng() * 0.5), 0.25, 0.8 + rng() * 0.6, shade(COL.concrete, 0.6), { ao: 0 });
        if (rng() < 0.5) {
          for (let r = 0; r < 4; r++) {
            const p = F.along(rng() * F.w);
            B.batch.geom('metal', cyl(0.012, 0.012, 1 + rng() * 1.5, 3), mat(p.x + F.nx * 0.6, y - 0.2, p.z + F.nz * 0.6, rng() * 6, (rng() - 0.5) * 2, (rng() - 0.5) * 2), COL.rust);
          }
        }
      }
    }
    // Broken top: jagged chunks instead of a parapet.
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, w = b.x1 - b.x0, d = b.z1 - b.z0;
    B.batch.box('rough', mat(cx, h - 0.05, cz), w - 0.1, 0.05, d - 0.1, color(0x3a3532), { faces: FACE.py, ao: 0 });
    for (let k = 0; k < 5; k++) {
      B.batch.box('rough', mat(b.x0 + rng() * w, h - 0.5, b.z0 + rng() * d, rng() * 6, (rng() - 0.5) * 0.8, (rng() - 0.5) * 0.8), 1 + rng() * 2.5, 0.8 + rng() * 1.5, 1 + rng() * 2, shade(tint, 0.5), { ao: 0 });
    }
    if (spec.collider !== false) B.solid(cx, cz, w, d, h, 0, { tag: 'building' });
  }
}

// Silhouette blocks filling the distance in every direction (skyline material, no colliders).
// `keepOut(x, z, margin)` returns true where the playable city already has real buildings.
export function skyline(B, { minX, maxX, minZ, maxZ, keepOut, cell = 24, seed = 5 }) {
  const rng = B.rng;
  for (let gx = minX; gx < maxX; gx += cell) {
    for (let gz = minZ; gz < maxZ; gz += cell) {
      const ix = Math.round((gx - minX) / cell), iz = Math.round((gz - minZ) / cell);
      if (ix % 4 === 1 || iz % 5 === 2) continue; // streets between blocks
      const cx = gx + cell / 2, cz = gz + cell / 2;
      if (keepOut(cx, cz)) continue;
      const dist = Math.min(Math.abs(cx), 400);
      const tall = rng() < 0.12 ? 2.2 : 1;
      const h = (14 + rng() * 40 + dist * 0.12) * tall;
      const w = cell * (0.55 + rng() * 0.4), d = cell * (0.55 + rng() * 0.4);
      const shadeV = rng();
      const col = new THREE.Color(shadeV, (seed * 31 + ix * 7.1 + iz * 3.3) % 1, 0);
      B.batch.box('skyline', mat(cx + (rng() - 0.5) * 4, 0, cz + (rng() - 0.5) * 4), w, h, d, col, { ao: 0, uv: 'unit' });
      if (rng() < 0.3) {
        B.batch.box('skyline', mat(cx + (rng() - 0.5) * w * 0.4, h, cz + (rng() - 0.5) * d * 0.4), w * 0.4, 3 + rng() * 6, d * 0.4, col, { ao: 0, uv: 'unit' });
      }
      if (rng() < 0.18) {
        B.batch.box('skyline', mat(cx, h, cz), 0.4, 8 + rng() * 14, 0.4, col, { ao: 0, uv: 'unit' });
      }
      if (rng() < 0.12) {
        B.batch.geom('skyline', cyl(2.2, 2.2, 4, 8), mat(cx + 3, h + 3, cz - 2), col);
        B.batch.box('skyline', mat(cx + 3, h, cz - 2), 3, 3, 3, col, { ao: 0, uv: 'unit' });
      }
    }
  }
}
