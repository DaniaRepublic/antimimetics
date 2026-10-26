import * as THREE from 'three';
import { mat, sub, cyl, cachedGeo, FACE } from './level-batch.js';
import { signUV, storeUV, STORE } from './textures.js';

// Prop library. Every function takes the level builder `B` (see level.js: batch, solid(), glow,
// flames, smoke, light(), wire(), rng) and pushes static geometry into the batch plus matching
// colliders. Models face -Z in local space. Collider heights match the visuals: a sedan is ~1.45 m,
// so a crouched player (eye 0.95 m) hides behind it and a standing one (eye 1.65 m) shows over it.

const C = (hex) => new THREE.Color(hex);
const shade = (c, f) => new THREE.Color(c.r * f, c.g * f, c.b * f);
const mix = (a, b, t) => new THREE.Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);

export const COL = {
  black: C(0x0b0b0c),
  tyre: C(0x101010),
  char: C(0x30271f), // burnt paint: charred grey-brown (lighter than black so the shapes read in the dark)
  rust: C(0x5a3420),
  steel: C(0x5d5f62),
  darkSteel: C(0x2a2b2d),
  concrete: C(0x8d877f),
  darkConcrete: C(0x4d4844),
  wood: C(0x5a4532),
  bark: C(0x2a221c),
  glass: C(0x9aa0a8),
  bronze: C(0x3a4436),
  dirt: C(0x2e2620),
  white: C(0xd8d4cc),
};

export const CAR_PAINT = [0x6e1d18, 0x1f2b44, 0x50545a, 0x8c8272, 0x161718, 0xb5b0a6, 0x24382c, 0x3f5a62, 0x4a3326, 0x7a5a2a, 0x3b2a3a]
  .map(C);

// --- cached shapes ------------------------------------------------------------------------------

// Box with an inset top (car cabins, kiosk roofs). Base at y = 0.
function frustum(Lb, Wb, Lt, Wt, H, shiftZ = 0) {
  return cachedGeo(`fr${Lb},${Wb},${Lt},${Wt},${H},${shiftZ}`, () => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const sx = Math.sign(p.getX(i)), sy = Math.sign(p.getY(i)), sz = Math.sign(p.getZ(i));
      if (sy < 0) p.setXYZ(i, (sx * Wb) / 2, 0, (sz * Lb) / 2);
      else p.setXYZ(i, (sx * Wt) / 2, H, (sz * Lt) / 2 + shiftZ);
    }
    g.computeVertexNormals();
    return g;
  });
}

// Cylinder centred on the origin with its axis along X (wheels, rails).
const cylX = (r, len, seg = 10) =>
  cachedGeo(`cylX${r},${len},${seg}`, () => {
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    g.rotateZ(Math.PI / 2);
    return g;
  });

const rock = (seed) =>
  cachedGeo(`rock${seed % 6}`, () => {
    const g = new THREE.IcosahedronGeometry(0.5, 0);
    const p = g.attributes.position;
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.7 + rnd() * 0.6), p.getY(i) * (0.5 + rnd() * 0.5), p.getZ(i) * (0.7 + rnd() * 0.6));
    g.computeVertexNormals();
    return g;
  });

// Lumpy unit dome (radius 1, height 1, base at y = 0): the solid core of a rubble heap, so the
// chunks piled on it never float with daylight between them.
const heap = (seed) =>
  cachedGeo(`heap${seed % 4}`, () => {
    const g = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const p = g.attributes.position;
    const h3 = (x, y, z) => {
      const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.13) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // displacement keyed on the rounded position, so the seam's duplicate vertices stay welded
      const k = 0.78 + 0.4 * h3(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50));
      const rim = y < 0.01 ? 1 : k;
      p.setXYZ(i, x * rim, y * k * (0.85 + 0.3 * (1 - y)), z * rim);
    }
    g.computeVertexNormals();
    return g;
  });

const bag = () =>
  cachedGeo('bag', () => {
    const g = new THREE.IcosahedronGeometry(0.32, 1);
    g.scale(1, 0.75, 1.1);
    g.translate(0, 0.22, 0);
    return g;
  });

function jerseyGeo() {
  return cachedGeo('jersey', () => {
    const s = new THREE.Shape();
    const pts = [[-0.32, 0], [0.32, 0], [0.32, 0.08], [0.13, 0.32], [0.09, 1.05], [-0.09, 1.05], [-0.13, 0.32], [-0.32, 0.08]];
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    const g = new THREE.ExtrudeGeometry(s, { depth: 2.9, bevelEnabled: false });
    g.translate(0, 0, -1.45);
    return g;
  });
}

// --- vehicles -----------------------------------------------------------------------------------

// Side profiles in (u, y): u = forward (front at +L/2), extruded across the width. `green` is the
// glass greenhouse (narrower than the body), `roofU` the span of the painted roof over it.
const CAR = {
  sedan: {
    L: 4.7, W: 1.84, r: 0.33, wz: 1.45, body: 0.3, belt: 0.98, roof: 1.45, gw: 0.86, head: 0.74,
    lower: [[-2.35, 0.3], [2.33, 0.3], [2.37, 0.62], [2.22, 0.86], [1.05, 0.97], [-1.5, 1.0], [-2.28, 0.98], [-2.38, 0.72]],
    green: [[-1.5, 0.97], [1.08, 0.95], [0.35, 1.41], [-0.95, 1.41]],
  },
  hatch: {
    L: 4.0, W: 1.74, r: 0.31, wz: 1.25, body: 0.3, belt: 0.97, roof: 1.51, gw: 0.86, head: 0.72,
    lower: [[-2.0, 0.3], [1.98, 0.3], [2.02, 0.6], [1.86, 0.84], [0.85, 0.96], [-1.92, 0.98], [-2.03, 0.7]],
    green: [[-1.92, 0.97], [0.88, 0.95], [0.2, 1.47], [-1.72, 1.47]],
  },
  pickup: {
    L: 5.4, W: 1.96, r: 0.4, wz: 1.72, body: 0.42, belt: 1.1, roof: 1.84, gw: 0.9, head: 0.9, bed: [-2.6, -0.85],
    lower: [[-2.7, 0.42], [2.68, 0.42], [2.72, 0.75], [2.56, 1.04], [1.4, 1.1], [-2.66, 1.1], [-2.73, 0.8]],
    green: [[-0.75, 1.09], [1.25, 1.07], [0.72, 1.8], [-0.62, 1.8]],
  },
  van: {
    L: 5.2, W: 2.0, r: 0.36, wz: 1.75, body: 0.35, belt: 1.2, roof: 2.17, gw: 0.98, head: 0.9,
    lower: [[-2.6, 0.35], [2.58, 0.35], [2.62, 0.7], [2.46, 1.05], [1.78, 1.2], [-2.62, 1.2], [-2.66, 0.9]],
    cargo: [[-2.62, 1.18], [0.18, 1.18], [0.18, 2.13], [-2.58, 2.13]],
    green: [[0.16, 1.19], [1.78, 1.19], [1.0, 2.1], [0.16, 2.1]],
  },
};
export const CAR_TYPES = Object.keys(CAR);

// Extruded side profile, centred across its width, front facing -Z.
function profileGeo(key, pts, width, bevel = 0.04) {
  return cachedGeo(key, () => {
    const shape = new THREE.Shape(pts.map(([u, y]) => new THREE.Vector2(u, y)));
    const depth = Math.max(0.01, width - 2 * bevel);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 1 });
    g.translate(0, 0, -depth / 2);
    g.rotateY(Math.PI / 2); // shape u -> -Z (forward), extrusion -> X
    return g;
  });
}

// Thin bar between two profile points (u1, y1) -> (u2, y2) at lateral offset x.
function strut(b, key, M, x, u1, y1, u2, y2, w, color) {
  const dy = y2 - y1, dz = -(u2 - u1);
  const len = Math.hypot(dy, dz);
  b.box(key, sub(M, x, y1, -u1, 0, Math.atan2(dz, dy)), w, len, w * 1.3, color, { ao: 0 });
}

// A car. roll: 0 upright, 1 on its roof, 2 on its side. Returns { height, collider, led, hazards }.
export function car(B, o) {
  const { x, z, yaw = 0, type = 'sedan', burnt = false, door = false, roll = 0, fire = false, police = false, alarm = null, sink = 0 } = o;
  const T = CAR[type];
  // burnt: rust-brown shell, not black (the wrecks are cover; their shape must read in the dark)
  const paint = burnt ? mix(COL.char, COL.rust, 0.3 + B.rng() * 0.4) : o.color || B.rng.pick(CAR_PAINT);
  const drop = burnt ? 0.12 : 0;
  let M;
  if (roll === 1) M = mat(x, T.roof - drop, z, yaw, 0, Math.PI);
  else if (roll === 2) M = mat(x, T.W / 2, z, yaw, 0, Math.PI / 2);
  else M = mat(x, -drop - sink, z, yaw, o.pitch || 0, o.tilt || 0);
  const b = B.batch;
  const bodyKey = burnt ? 'rough' : 'paint';
  const L = T.L, W = T.W, Wg = W * T.gw;
  const G = T.green;

  // Chassis shadow under the body.
  b.box('rough', sub(M, 0, 0.12, 0), W - 0.25, T.body - 0.1, L - 0.7, COL.black, { ao: 0 });
  b.geom(bodyKey, profileGeo(`car-${type}-lower`, T.lower, W), M, paint, { ao: 0.45, aoHeight: 1.0 });
  if (T.cargo) {
    b.geom(bodyKey, profileGeo(`car-${type}-cargo`, T.cargo, W, 0.03), M, paint, { ao: 0.2, aoHeight: 2 });
    // Box-body detailing, so the big flat panels read as a van and not a crate: vertical ribs,
    // top and bottom rails proud of the skin, a dirt band along the sill, the rear doors' seam.
    const C0 = T.cargo, u0 = C0[0][0], u1 = C0[1][0], y0 = C0[0][1], y1 = C0[2][1];
    const rib = shade(paint, 0.72), rail = shade(paint, 0.6), dirt = mix(paint, C(0x2a2118), 0.55);
    for (const sx of [-1, 1]) {
      const px = sx * (W / 2 + 0.012);
      for (let u = u0 + 0.32; u < u1 - 0.15; u += 0.62) b.box(bodyKey, sub(M, px, y0 + 0.06, -u), 0.035, y1 - y0 - 0.16, 0.06, rib, { ao: 0.25 });
      b.box(bodyKey, sub(M, sx * (W / 2 + 0.016), y1 - 0.12, -(u0 + u1) / 2), 0.045, 0.1, u1 - u0 - 0.04, rail, { ao: 0 });
      b.box(bodyKey, sub(M, sx * (W / 2 + 0.016), y0 - 0.02, -(u0 + u1) / 2), 0.045, 0.12, u1 - u0 - 0.04, rail, { ao: 0 });
      b.box('rough', sub(M, sx * (W / 2 + 0.006), T.body + 0.02, 0), 0.02, 0.32, L - 0.5, dirt, { ao: 0.6, faces: sx > 0 ? FACE.px : FACE.nx });
    }
    // Rear: a roll-up door (slats between two corner posts, a grab bar near the bottom), each piece
    // laid on the body's actual rear surface at its height (the profiles lean and bulge).
    const rearZ = (y) => {
      let u = Infinity;
      for (const [pts, bev] of [[T.lower, 0.04], [C0, 0.03]]) {
        for (let i = 0; i < pts.length; i++) {
          const [ua, ya] = pts[i], [ub, yb2] = pts[(i + 1) % pts.length];
          if ((y - ya) * (y - yb2) > 0 || ya === yb2) continue;
          u = Math.min(u, ua + ((ub - ua) * (y - ya)) / (yb2 - ya) - bev);
        }
      }
      return -u + 0.006;
    };
    const yb = T.body + 0.12;
    for (const sx of [-1, 1]) {
      for (let y = yb; y < y1 - 0.05; y += 0.25) b.box(bodyKey, sub(M, sx * (W / 2 - 0.06), y, rearZ(y + 0.12) + 0.01), 0.1, 0.25, 0.03, rail, { ao: 0 });
    }
    for (let y = yb + 0.16; y < y1 - 0.08; y += 0.17) b.box(bodyKey, sub(M, 0, y, rearZ(y)), W - 0.22, 0.025, 0.02, rib, { ao: 0 });
    b.box('metal', sub(M, 0, yb + 0.1, rearZ(yb + 0.1) + 0.02), 0.6, 0.05, 0.05, COL.darkSteel, { ao: 0 });
  }
  if (burnt) {
    // Gutted greenhouse: dark interior, bare pillars, a sagging roof.
    b.geom('rough', profileGeo(`car-${type}-gut`, G, Wg - 0.12, 0.02), sub(M, 0, -0.04, 0), COL.black);
    for (const sx of [-1, 1]) {
      strut(b, 'rough', M, sx * (Wg / 2 - 0.03), G[1][0], G[1][1], G[2][0], G[2][1] - 0.06, 0.06, paint);
      strut(b, 'rough', M, sx * (Wg / 2 - 0.03), G[0][0], G[0][1], G[3][0], G[3][1] - 0.06, 0.06, paint);
    }
    b.box('rough', sub(M, 0, G[2][1] - 0.1, -(G[2][0] + G[3][0]) / 2, 0, 0.06), Wg, 0.05, G[2][0] - G[3][0] + 0.1, mix(paint, C(0x6a645c), 0.45), { ao: 0 }); // ash-grey sagging roof
  } else {
    b.geom('glass', profileGeo(`car-${type}-green`, G, Wg, 0.02), M, COL.glass);
    b.box('paint', sub(M, 0, G[2][1] - 0.02, -(G[2][0] + G[3][0]) / 2), Wg + 0.04, 0.06, G[2][0] - G[3][0] + 0.12, paint, { ao: 0 });
    for (const sx of [-1, 1]) {
      const px = sx * (Wg / 2 + 0.006);
      strut(b, 'paint', M, px, G[1][0], G[1][1], G[2][0], G[2][1], 0.07, shade(paint, 0.8));
      strut(b, 'paint', M, px, G[0][0], G[0][1], G[3][0], G[3][1], 0.09, shade(paint, 0.8));
      const bu = (G[1][0] + G[0][0]) / 2 + 0.15;
      strut(b, 'paint', M, px, bu, G[1][1], bu - 0.05, G[2][1], 0.08, shade(paint, 0.8));
    }
  }
  if (T.bed) b.box('rough', sub(M, 0, T.belt + 0.03, -(T.bed[0] + T.bed[1]) / 2), W - 0.22, 0.02, T.bed[1] - T.bed[0], COL.black, { ao: 0 });
  // Bumpers and lights
  b.box('rough', sub(M, 0, T.body - 0.04, -L / 2 - 0.05), W + 0.02, 0.24, 0.16, COL.darkSteel, { ao: 0 });
  b.box('rough', sub(M, 0, T.body - 0.04, L / 2 + 0.05), W + 0.02, 0.24, 0.16, COL.darkSteel, { ao: 0 });
  if (!burnt) {
    for (const sx of [-1, 1]) {
      b.box('glass', sub(M, sx * (W / 2 - 0.3), T.head - 0.07, -L / 2 - 0.02), 0.38, 0.14, 0.05, C(0xb8b4aa), { ao: 0 });
      b.box('paint', sub(M, sx * (W / 2 - 0.25), T.head - 0.05, L / 2 + 0.02), 0.32, 0.17, 0.05, C(0x4a0c0a), { ao: 0 });
    }
  }
  // Wheels (stand slightly proud of the body so they read from the side)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wr = burnt ? T.r * 0.78 : T.r;
      const wy = wr + (burnt ? 0.02 : 0);
      b.geom('rough', cylX(wr, 0.24, 12), sub(M, sx * (W / 2 - 0.09), wy, sz * T.wz), burnt ? COL.rust : COL.tyre);
      b.geom('metal', cylX(wr * 0.58, 0.04, 8), sub(M, sx * (W / 2 + 0.03), wy, sz * T.wz), burnt ? COL.rust : COL.steel);
    }
  }
  const hingeU = G[1][0] - 0.12;
  // Open door, swung outwards about its front hinge.
  if (door && roll === 0 && type !== 'van') {
    const side = o.doorSide || -1;
    const swing = side * 0.95;
    const D = sub(M, side * (W / 2), T.body + 0.02, -hingeU, swing);
    b.box(bodyKey, sub(D, 0, 0, 0.55), 0.06, T.belt - T.body, 1.1, paint, { ao: 0.3 });
    if (!burnt) b.box('glass', sub(D, -side * 0.06, T.belt - T.body, 0.6), 0.03, 0.4, 0.9, COL.glass, { ao: 0 });
    const lc = _rot(side * (W / 2) + 0.55 * Math.sin(swing), -hingeU + 0.55 * Math.cos(swing), yaw);
    B.solid(x + lc.x, z + lc.z, 0.14, 1.1, T.belt, yaw + swing, { blocksSight: false, tag: 'door' });
  }
  // Police livery + lightbar
  if (police) {
    const u0 = G[0][0], u1 = G[1][0];
    b.box('paint', sub(M, 0, T.body + 0.08, -(u0 + u1) / 2), W + 0.03, T.belt - T.body - 0.16, u1 - u0, COL.white, { ao: 0 });
    const R = sub(M, 0, G[2][1] + 0.04, -(G[2][0] + G[3][0]) / 2);
    b.box('rough', R, 1.1, 0.06, 0.28, COL.black, { ao: 0 });
    b.box('glass', sub(R, -0.3, 0.06, 0), 0.48, 0.1, 0.24, C(0x3a0808), { ao: 0 });
    b.box('glass', sub(R, 0.3, 0.06, 0), 0.48, 0.1, 0.24, C(0x080a3a), { ao: 0 });
  }
  if (burnt) B.decal('scorch', x, z, L + 1.2, L + 1.2, yaw);
  const cabU = (G[0][0] + G[1][0]) / 2;
  if (fire) B.fire(new THREE.Vector3(x, T.belt * 0.9, z).add(_rot(0, -cabU - 0.4, yaw)), o.fireScale ?? 1.1, o.fireLight);

  // Collider
  const height = roll === 2 ? W : roll === 1 ? T.roof - drop : T.roof - drop - sink;
  const width = roll === 2 ? T.roof : W;
  const data = alarm ? { alarmCar: alarm } : null;
  let collider;
  if (type === 'pickup' && roll === 0) {
    const front = _rot(0, -L / 4 + 0.05, yaw);
    collider = B.solid(x + front.x, z + front.z, W, L / 2 + 0.1, height, yaw, { tag: 'car', data });
    const back = _rot(0, L / 4, yaw);
    B.solid(x + back.x, z + back.z, W, L / 2, T.belt, yaw, { tag: 'car', data });
  } else {
    collider = B.solid(x, z, width, L + 0.1, height, yaw, { tag: 'car', data });
  }
  const local = (lx, ly, lz) => new THREE.Vector3(lx, ly, lz).applyMatrix4(M);
  return {
    height,
    collider,
    matrix: M,
    led: local(-0.32, T.belt + 0.04, -(G[1][0] - 0.28)),
    hazards: [local(-(W / 2 - 0.3), T.head, -L / 2 - 0.12), local(W / 2 - 0.3, T.head, -L / 2 - 0.12),
      local(-(W / 2 - 0.25), T.head, L / 2 + 0.12), local(W / 2 - 0.25, T.head, L / 2 + 0.12)],
  };
}

const _rot = (lx, lz, yaw) => ({ x: Math.cos(yaw) * lx + Math.sin(yaw) * lz, z: -Math.sin(yaw) * lx + Math.cos(yaw) * lz, y: 0 });

// City bus body section (no collider): length L, local origin at the section centre.
function busSection(B, M, L, paint, burnt, front) {
  const b = B.batch;
  const key = burnt ? 'rough' : 'paint';
  const W = 2.55;
  b.box('rough', sub(M, 0, 0.12, 0), W - 0.3, 0.3, L - 1.0, COL.black, { ao: 0 });
  b.box(key, sub(M, 0, 0.35, 0), W, 1.05, L, paint, { ao: 0.4 });
  b.box(key, sub(M, 0, 0.95, 0), W + 0.02, 0.18, L, burnt ? COL.char : C(0x7a1a14), { ao: 0 });
  if (burnt) {
    b.box('rough', sub(M, 0, 1.4, 0), W - 0.1, 1.0, L - 0.2, C(0x16110e), { ao: 0, faces: FACE.px | FACE.nx | FACE.pz | FACE.nz });
    for (let k = -L / 2 + 0.3; k <= L / 2 - 0.2; k += 1.25) b.box('rough', sub(M, 0, 1.4, k), W + 0.01, 1.0, 0.1, paint, { ao: 0 });
  } else {
    b.box('glass', sub(M, 0, 1.4, 0), W + 0.02, 1.0, L - 0.4, COL.glass, { ao: 0 });
    for (let k = -L / 2 + 0.6; k <= L / 2 - 0.4; k += 1.6) b.box('paint', sub(M, 0, 1.4, k), W + 0.04, 1.0, 0.08, shade(paint, 0.7), { ao: 0 });
  }
  b.box(key, sub(M, 0, 2.4, 0), W, 0.55, L, paint, { ao: 0 });
  b.box('metal', sub(M, 0, 2.95, L * 0.1), 1.6, 0.25, L * 0.4, COL.darkSteel, { ao: 0 });
  if (front) b.box(burnt ? 'rough' : 'glass', sub(M, 0, 0.9, -L / 2 - 0.02), W - 0.2, 1.7, 0.06, burnt ? COL.black : COL.glass, { ao: 0 });
  for (const sx of [-1, 1]) {
    for (const zz of front ? [-L / 2 + 2.2, L / 2 - 2.0] : [L / 2 - 2.0]) {
      b.geom('rough', cylX(0.5, 0.3, 12), sub(M, sx * (W / 2 - 0.16), 0.5, zz), burnt ? COL.rust : COL.tyre);
    }
  }
}

// Articulated bus jack-knifed at `fold` radians, or a single bus (rear omitted).
export function bus(B, { x, z, yaw = 0, fold = 0, burnt = false, articulated = true }) {
  const paint = burnt ? mix(COL.char, COL.rust, 0.55) : C(0xb8ad96);
  const Lf = 11.5, Lr = 7;
  const M = mat(x, burnt ? -0.15 : 0, z, yaw);
  busSection(B, M, Lf, paint, burnt, true);
  B.solid(x, z, 2.6, Lf, 3.0, yaw, { tag: 'bus' });
  if (articulated) {
    const ry = yaw + fold;
    const joint = _rot(0, Lf / 2 + 0.6, yaw);
    const rc = _rot(0, Lr / 2 + 0.6, ry);
    const cx = x + joint.x + rc.x, cz = z + joint.z + rc.z;
    busSection(B, mat(cx, burnt ? -0.15 : 0, cz, ry), Lr, paint, burnt, false);
    // bellows
    B.batch.box('rough', mat(x + joint.x, 0.4, z + joint.z, yaw + fold / 2), 2.3, 2.5, 1.3, COL.black, { ao: 0 });
    B.solid(cx, cz, 2.6, Lr, 3.0, ry, { tag: 'bus' });
    B.solid(x + joint.x, z + joint.z, 2.4, 1.6, 3.0, yaw + fold / 2, { tag: 'bus' });
  }
  if (burnt) B.decal('scorch', x, z, 6, Lf + 2, yaw);
}

// Box truck lying on its side (overturned), cargo spilled.
export function overturnedTruck(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  // On its side: the truck's width becomes the height (2.5 m), height becomes footprint width.
  const box = sub(M, 0, 0, 1.0);
  b.box('paint', box, 3.1, 2.5, 7.2, C(0xc9c2b2), { ao: 0.45 });
  b.box('paint', sub(box, 0, 0.5, 0), 3.12, 0.4, 7.22, C(0x6a2018), { ao: 0 });
  b.box('rough', sub(box, -1.2, 2.5, 0), 0.6, 0.05, 7.0, COL.black, { ao: 0 });
  const cab = sub(M, -0.35, 0, -3.8);
  b.box('paint', cab, 2.3, 2.3, 2.3, C(0x3d4a58), { ao: 0.4 });
  b.box('glass', sub(cab, 0, 0.5, -1.16), 1.7, 1.3, 0.04, COL.glass, { ao: 0 });
  // Wheels: on its side the axles are vertical, so the tyres lie flat against the underside.
  for (const zz of [-3.8, -1.2, 3.2]) {
    for (const yy of [0.12, 2.08]) b.geom('rough', cyl(0.5, 0.5, 0.3, 12), sub(M, 1.62, yy, zz), COL.tyre, { ao: 0 });
  }
  const tc = _rot(0.3, 1.0, yaw);
  B.solid(x + tc.x, z + tc.z, 3.7, 7.2, 2.5, yaw, { tag: 'truck' });
  const c2 = _rot(-0.35, -3.8, yaw);
  B.solid(x + c2.x, z + c2.z, 2.3, 2.3, 2.3, yaw, { tag: 'truck' });
  // spilled crates
  for (let k = 0; k < 7; k++) {
    const lx = -2.2 - B.rng() * 2.5, lz = -1 + B.rng() * 6;
    const p = _rot(lx, lz, yaw);
    const s = 0.5 + B.rng() * 0.4;
    b.box('rough', mat(x + p.x, 0, z + p.z, B.rng() * 3), s, s * 0.8, s, mix(COL.wood, COL.concrete, 0.2), { ao: 0.3 });
  }
}

// --- street furniture ---------------------------------------------------------------------------

export function dumpster(B, { x, z, yaw = 0, color, open = false }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  const c = color || B.rng.pick([C(0x24382c), C(0x2a3446), C(0x4a3a20), C(0x3a3a3a)]);
  b.box('paint', sub(M, 0, 0.12, 0), 1.9, 1.1, 1.15, c, { ao: 0.5 });
  b.box('metal', sub(M, 0, 1.2, open ? -0.75 : 0, 0, open ? -1.2 : 0.05), 1.95, 0.06, 1.2, shade(c, 0.6), { ao: 0 });
  for (const sx of [-0.8, 0.8]) for (const sz of [-0.45, 0.45]) b.geom('rough', cylX(0.07, 0.06, 6), sub(M, sx, 0.07, sz), COL.black);
  B.solid(x, z, 1.95, 1.2, 1.3, yaw, { tag: 'dumpster' });
  if (B.rng() < 0.7) trashBags(B, { x: x + _rot(0, 1.0, yaw).x, z: z + _rot(0, 1.0, yaw).z, n: 2 + B.rng.int(0, 3), spread: 0.8 });
}

export function trashBags(B, { x, z, n = 3, spread = 0.9 }) {
  for (let k = 0; k < n; k++) {
    const a = B.rng() * Math.PI * 2, r = B.rng() * spread;
    const s = 0.75 + B.rng() * 0.5;
    B.batch.geom('paint', bag(), mat(x + Math.cos(a) * r, 0, z + Math.sin(a) * r, B.rng() * 6, (B.rng() - 0.5) * 0.4, 0, s, s, s),
      B.rng() < 0.75 ? C(0x0e0e10) : C(0x2a3a2a), { ao: 0.5, aoHeight: 0.4 });
  }
}

export function jersey(B, { x, z, yaw = 0, color, collider = true }) {
  B.batch.geom('rough', jerseyGeo(), mat(x, 0, z, yaw), color || shade(COL.concrete, 0.85 + B.rng() * 0.2), { ao: 0.4, aoHeight: 0.6, uvScale: 2.5 });
  if (collider) B.solid(x, z, 0.62, 2.9, 1.05, yaw, { tag: 'barrier' });
}

// A run of jersey barriers from (x0,z0) to (x1,z1). One continuous collider: separate boxes would
// leave hairline gaps a player could squeeze through.
export function barrierLine(B, x0, z0, x1, z1, { jitter = 0.04 } = {}) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(len / 2.95));
  const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    jersey(B, { x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, yaw: yaw + (B.rng() - 0.5) * jitter, collider: false });
  }
  B.solid((x0 + x1) / 2, (z0 + z1) / 2, 0.62, len, 1.05, yaw, { tag: 'barrier' });
}

// Chain-link fence with posts and a top rail. blocksMove, never blocksSight.
export function fence(B, x0, z0, x1, z1, { h = 2.4, sag = 0 } = {}) {
  const b = B.batch;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
  const n = Math.max(1, Math.round(len / 3));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    b.geom('metal', cyl(0.04, 0.04, h + 0.05, 6), mat(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t), COL.steel);
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  b.geom('metal', cylX(0.025, len, 5), mat(cx, h, cz, yaw + Math.PI / 2), COL.steel);
  // Mesh: double-sided quad, chain texture repeats every 0.6 m.
  const rep = 0.6;
  const p0 = { x: x0, y: 0.03, z: z0 }, p1 = { x: x1, y: 0.03, z: z1 };
  const p2 = { x: x1, y: h - sag, z: z1 }, p3 = { x: x0, y: h, z: z0 };
  b.quad('chain', [p0, p1, p2, p3], [0, 0, len / rep, 0, len / rep, h / rep, 0, h / rep], COL.steel);
  B.solid(cx, cz, 0.3, len, h, yaw, { blocksSight: false, tag: 'fence' }); // thicker than the mesh: no tunnelling
}

// Plain concrete/brick wall segment (collider + mesh).
export function wall(B, x0, z0, x1, z1, { h = 3, t = 0.4, color = COL.darkConcrete, key = 'rough', blocksSight = true } = {}) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  B.batch.box(key, mat(cx, 0, cz, yaw), t, h, len, color, { uvScale: 3, ao: 0.4 });
  return B.solid(cx, cz, t, len, h, yaw, { tag: 'wall', blocksSight });
}

// Street lamp. state: 'dead' | 'on' | 'flicker'. Returns the light handle (or null).
export function streetlight(B, { x, z, yaw = 0, state = 'dead', h = 7.2, color = 0xffa14a, intensity = 45, stealthRadius = 7 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.geom('metal', cyl(0.07, 0.11, h, 8), M, COL.darkSteel, { ao: 0.2 });
  b.box('metal', sub(M, 0, h - 0.1, -1.0), 0.08, 0.08, 2.0, COL.darkSteel, { ao: 0 });
  b.box('metal', sub(M, 0, h - 0.22, -2.0), 0.32, 0.16, 0.62, COL.darkSteel, { ao: 0 });
  const bulbPos = new THREE.Vector3(0, h - 0.27, -2.0).applyMatrix4(M);
  b.box('emissive', sub(M, 0, h - 0.27, -2.0), 0.24, 0.04, 0.5, state === 'dead' ? C(0x151210) : shade(C(color), 1.6), { ao: 0 });
  B.solid(x, z, 0.3, 0.3, h, 0, { tag: 'pole' });
  if (state === 'dead') return null;
  return B.light({
    pos: bulbPos, color, intensity, distance: 16, flicker: state === 'flicker' ? 0.7 : 0.05,
    stealthRadius, stealthWeight: 0.75, halo: { size: 0.9, intensity: 1.6 }, selfFlicker: state === 'flicker',
  });
}

// Wooden utility pole with a cross-arm; returns the three wire attachment points.
export function powerPole(B, { x, z, yaw = 0, h = 10 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw + (B.rng() - 0.5) * 0.1, 0, (B.rng() - 0.5) * 0.05);
  b.geom('rough', cyl(0.12, 0.16, h, 7), M, COL.bark, { ao: 0.2 });
  b.box('rough', sub(M, 0, h - 0.8, 0), 2.4, 0.12, 0.12, COL.bark, { ao: 0 });
  b.geom('rough', cyl(0.18, 0.18, 0.7, 7), sub(M, 0.35, h - 2.2, 0), C(0x3a3f44));
  B.solid(x, z, 0.36, 0.36, h, 0, { tag: 'pole' });
  return [-1.1, 0, 1.1].map((lx) => new THREE.Vector3(lx, h - 0.62, 0).applyMatrix4(M));
}

// Traffic signal on a mast arm reaching over the road. blink: index of a lens that blinks red.
export function trafficMast(B, { x, z, yaw = 0, arm = 6, blink = false }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.geom('metal', cyl(0.12, 0.16, 6.6, 8), M, C(0x2e3236), { ao: 0.2 });
  b.box('metal', sub(M, arm / 2, 6.2, 0), arm, 0.14, 0.14, C(0x2e3236), { ao: 0 });
  const heads = [];
  for (const ax of [arm * 0.55, arm * 0.95]) {
    const H = sub(M, ax, 5.0, 0, (B.rng() - 0.5) * 0.3);
    b.box('paint', H, 0.36, 1.05, 0.3, C(0x2a2716), { ao: 0 });
    for (let k = 0; k < 3; k++) {
      b.box('emissive', sub(H, 0, 0.2 + k * 0.32, -0.16), 0.2, 0.2, 0.03, [C(0x1a1a0a), C(0x1a120a), C(0x240808)][k], { ao: 0 });
    }
    heads.push(new THREE.Vector3(0, 0.84, -0.2).applyMatrix4(H));
  }
  B.solid(x, z, 0.35, 0.35, 6.6, 0, { tag: 'pole' });
  if (blink) {
    const gi = B.glow.add(heads[1], 0xff2010, 0.45, 0);
    B.blinkers.push({ glow: gi, period: 1.6, duty: 0.5, intensity: 2.2 });
  }
  return heads;
}

export function signPost(B, { x, z, yaw = 0, sign = 'street', w = 1.2, h = 0.6, at = 2.6 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.geom('metal', cyl(0.035, 0.035, at + h, 6), M, COL.steel);
  B.batch.wall('signs', x + Math.sin(yaw) * 0.05, at, z + Math.cos(yaw) * 0.05, w, h, yaw, signUV(sign));
  B.batch.wall('signs', x - Math.sin(yaw) * 0.05, at, z - Math.cos(yaw) * 0.05, w, h, yaw + Math.PI, signUV(sign), shade(COL.white, 0.4));
}

export function hydrant(B, { x, z }) {
  const b = B.batch;
  const M = mat(x, 0, z, B.rng() * 6);
  b.geom('paint', cyl(0.13, 0.15, 0.62, 8), M, C(0x7a2a1a), { ao: 0.3, aoHeight: 0.6 });
  b.geom('paint', cyl(0.05, 0.12, 0.14, 8), sub(M, 0, 0.62, 0), C(0x7a2a1a));
  b.geom('paint', cylX(0.06, 0.45, 6), sub(M, 0, 0.42, 0), C(0x7a2a1a));
}

export function newsBox(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  const c = B.rng.pick([C(0x6a1e18), C(0x22406a), C(0x2a5a3a)]);
  b.box('paint', sub(M, 0, 0.3, 0), 0.52, 0.85, 0.45, c, { ao: 0.2 });
  b.box('metal', sub(M, 0, 0, 0), 0.4, 0.3, 0.3, COL.darkSteel, { ao: 0.4 });
  const f = _rot(0, -0.23, yaw);
  B.batch.wall('signs', x + f.x, 0.62, z + f.z, 0.5, 0.25, yaw, signUV('courier'));
  B.solid(x, z, 0.52, 0.45, 1.15, yaw, { tag: 'newsbox' });
}

export function bench(B, { x, z, yaw = 0, broken = false }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  for (const sx of [-0.75, 0.75]) b.box('metal', sub(M, sx, 0, 0), 0.06, 0.45, 0.5, COL.darkSteel, { ao: 0 });
  b.box('rough', sub(M, 0, 0.45, 0, 0, 0, broken ? 0.12 : 0), 1.8, 0.06, 0.48, COL.wood, { ao: 0 });
  b.box('rough', sub(M, 0, 0.55, 0.22, 0, -0.2), 1.8, 0.4, 0.05, COL.wood, { ao: 0 });
  B.solid(x, z, 1.8, 0.55, 0.9, yaw, { tag: 'bench', blocksSight: false });
}

export function barrel(B, { x, z, fire = false, light = null, color }) {
  const b = B.batch;
  b.geom('paint', cyl(0.29, 0.29, 0.9, 10), mat(x, 0, z, B.rng() * 6), color || mix(COL.rust, C(0x2a4a5a), B.rng() * 0.5), { ao: 0.4, aoHeight: 0.9 });
  b.geom('metal', cyl(0.3, 0.3, 0.04, 10), mat(x, 0.6, z), COL.darkSteel);
  B.solid(x, z, 0.6, 0.6, 0.9, 0, { tag: 'barrel' });
  if (fire) B.fire(new THREE.Vector3(x, 0.85, z), 0.55, light);
}

export function crate(B, { x, z, yaw = 0, s = 0.8, stack = 1 }) {
  for (let k = 0; k < stack; k++) {
    B.batch.box('rough', mat(x + (B.rng() - 0.5) * 0.1, k * s, z + (B.rng() - 0.5) * 0.1, yaw + (B.rng() - 0.5) * 0.2), s, s, s, mix(COL.wood, COL.dirt, B.rng() * 0.5), { ao: 0.3 });
  }
  if (s * stack > 0.45) B.solid(x, z, s + 0.05, s + 0.05, s * stack, yaw, { tag: 'crate' });
}

export function pallets(B, { x, z, yaw = 0, n = 3 }) {
  for (let k = 0; k < n; k++) B.batch.box('rough', mat(x, k * 0.15, z, yaw + (B.rng() - 0.5) * 0.15), 1.2, 0.14, 1.0, COL.wood, { ao: 0 });
  if (n * 0.15 > 0.45) B.solid(x, z, 1.2, 1.0, n * 0.15, yaw, { tag: 'pallet' });
}

// Personal effects left where people stood: coats, shoes, suitcases, bags. No colliders.
export function belongings(B, { x, z, n = 3, spread = 1.5 }) {
  const b = B.batch;
  for (let k = 0; k < n; k++) {
    const a = B.rng() * Math.PI * 2, r = B.rng() * spread;
    const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r, yaw = B.rng() * Math.PI * 2;
    const kind = B.rng.int(0, 3);
    if (kind === 0) {
      // coat lying flat with sleeves
      const c = B.rng.pick([C(0x2a2622), C(0x3a2e26), C(0x1e2430), C(0x4a2a24), C(0x5a5248)]);
      const M = mat(px, 0, pz, yaw);
      b.box('rough', M, 0.62, 0.07, 0.95, c, { ao: 0.2 });
      b.box('rough', sub(M, -0.42, 0, -0.15, 0.6), 0.16, 0.06, 0.6, c, { ao: 0.2 });
      b.box('rough', sub(M, 0.4, 0, -0.1, -0.3), 0.16, 0.06, 0.6, c, { ao: 0.2 });
    } else if (kind === 1) {
      const c = B.rng.pick([C(0x1a1410), C(0x3a2a1a), C(0x6a6460)]);
      b.box('rough', mat(px, 0, pz, yaw), 0.1, 0.1, 0.27, c, { ao: 0 });
      b.box('rough', mat(px + 0.16, 0, pz + 0.05, yaw + 0.3), 0.1, 0.1, 0.27, c, { ao: 0 });
    } else if (kind === 2) {
      const c = B.rng.pick([C(0x2a3446), C(0x4a1e1a), C(0x2a2a2a), C(0x5a4a2a)]);
      const up = B.rng() < 0.4;
      const M = up ? mat(px, 0, pz, yaw) : mat(px, 0.13, pz, yaw, 0, Math.PI / 2);
      b.box('paint', up ? M : sub(M, 0, -0.13, 0), up ? 0.45 : 0.26, up ? 0.62 : 0.45, up ? 0.22 : 0.62, c, { ao: 0.2 });
    } else {
      const c = B.rng.pick([C(0x3a2418), C(0x111111), C(0x5a3a3a)]);
      b.box('rough', mat(px, 0, pz, yaw), 0.32, 0.22, 0.14, c, { ao: 0.3 });
    }
  }
}

// Irregular pile of broken concrete, slabs and rebar. Collider: a core box of height h.
export function rubble(B, { x, z, w, d, h, yaw = 0, collider = true, color = COL.concrete, density = 1 }) {
  const b = B.batch;
  if (h > 0.8) {
    // solid core under the chunks
    const core = mix(color, COL.darkConcrete, 0.55);
    b.geom('rough', heap(Math.round(x * 7 + z * 3)), mat(x, 0, z, yaw, 0, 0, w * 0.47, h * 0.78, d * 0.47), core, { uvScale: 2.5 });
  }
  const n = Math.round(((w * d) / 1.6 + 6) * density);
  for (let k = 0; k < n; k++) {
    const u = B.rng() - 0.5, v = B.rng() - 0.5;
    const edge = Math.max(Math.abs(u), Math.abs(v)) * 2; // 0 centre .. 1 edge
    const top = h * (1 - edge * edge) * (0.7 + B.rng() * 0.4);
    const p = _rot(u * w, v * d, yaw);
    const s = 0.4 + B.rng() * 1.4 * (1 - edge * 0.5);
    const c = mix(color, B.rng() < 0.3 ? COL.wood : COL.darkConcrete, B.rng() * 0.6);
    if (B.rng() < 0.35) {
      // slab chunk
      b.box('rough', mat(x + p.x, Math.max(0, top - s * 0.4), z + p.z, B.rng() * 6, (B.rng() - 0.5) * 1.2, (B.rng() - 0.5) * 0.8), s * 1.6, 0.22, s * 1.2, c, { ao: 0.2, uvScale: 1.5 });
    } else {
      b.geom('rough', rock(k), mat(x + p.x, Math.max(0, top - s * 0.5), z + p.z, B.rng() * 6, 0, 0, s * 1.4, s, s * 1.3), c, { ao: 0.25, uvScale: 1.2 });
    }
    if (B.rng() < 0.12) {
      b.geom('metal', cyl(0.015, 0.015, 1.2 + B.rng() * 1.5, 4), mat(x + p.x, top * 0.6, z + p.z, B.rng() * 6, (B.rng() - 0.5) * 1.6, (B.rng() - 0.5) * 1.6), COL.rust);
    }
  }
  B.decal('rubble', x, z, w * 1.15, d * 1.15, yaw);
  if (collider) B.solid(x, z, w * 0.82, d * 0.82, h, yaw, { tag: 'rubble' });
}

// Dead tree: recursive bare branches.
export function deadTree(B, { x, z, h = 6, collider = true }) {
  const b = B.batch;
  const rng = B.rng;
  const branch = (M, len, r, depth) => {
    b.geom('rough', cyl(r * 0.6, r, len, depth > 1 ? 6 : 4, true), M, COL.bark);
    if (depth <= 0) return;
    const n = depth > 1 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const at = len * (0.55 + rng() * 0.45);
      const C2 = sub(M, 0, at, 0, rng() * Math.PI * 2, 0.35 + rng() * 0.6, 0);
      branch(C2, len * (0.5 + rng() * 0.25), r * 0.55, depth - 1);
    }
  };
  branch(mat(x, 0, z, rng() * 6, (rng() - 0.5) * 0.1, (rng() - 0.5) * 0.1), h * 0.45, h * 0.035, 3);
  if (collider) B.solid(x, z, 0.4, 0.4, h * 0.5, 0, { tag: 'tree', blocksSight: false });
}

export function planter(B, { x, z, w = 2.6, d = 1.2, h = 1.15, yaw = 0, tree = false }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.box('rough', M, w, h, d, shade(COL.concrete, 0.8), { ao: 0.4, uvScale: 2 });
  b.box('rough', sub(M, 0, h - 0.1, 0), w - 0.2, 0.12, d - 0.2, COL.dirt, { ao: 0, faces: FACE.py });
  // dead shrub stalks
  for (let k = 0; k < 7; k++) {
    const p = _rot((B.rng() - 0.5) * (w - 0.5), (B.rng() - 0.5) * (d - 0.4), yaw);
    b.geom('rough', cyl(0.008, 0.02, 0.5 + B.rng() * 0.8, 3), mat(x + p.x, h, z + p.z, B.rng() * 6, (B.rng() - 0.5) * 0.9, (B.rng() - 0.5) * 0.9), COL.bark);
  }
  if (tree) deadTree(B, { x, z, h: 5 + B.rng() * 2, collider: false });
  B.solid(x, z, w, d, h, yaw, { tag: 'planter' });
}

// News kiosk with shuttered front.
export function kiosk(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.box('paint', M, 2.6, 2.5, 2.0, C(0x44584c), { ao: 0.45 });
  b.box('paint', sub(M, 0, 2.5, -0.2), 3.1, 0.18, 2.6, C(0x2a3530), { ao: 0 });
  const f = _rot(0, -1.01, yaw);
  B.batch.wall('store', x + f.x, 0.4, z + f.z, 2.2, 1.7, yaw, storeUV(STORE.shutter));
  // Flyers pasted over the other three sides, so the kiosk is not a plain dark block. (Varied by a
  // local hash, not B.rng: the shared sequence drives the layout of everything built after this.)
  const flyers = [[1.315, -0.35, -Math.PI / 2], [1.315, 0.5, -Math.PI / 2], [-1.315, 0.1, Math.PI / 2], [0.55, 1.015, Math.PI], [-0.6, 1.015, Math.PI]];
  flyers.forEach(([lx, lz, fy], i) => {
    const r = (k) => {
      const v = Math.sin(x * 12.99 + z * 78.23 + i * 37.7 + k * 5.1) * 43758.55;
      return v - Math.floor(v);
    };
    const p = _rot(lx, lz, yaw);
    const w = 0.7 + r(1) * 0.3;
    B.batch.wall('signs', x + p.x, 0.55 + r(2) * 0.35, z + p.z, w, w * 1.45, yaw + fy, signUV('poster'), shade(C(0xffffff), 0.55 + r(3) * 0.35));
  });
  for (let k = 0; k < 3; k++) {
    const p = _rot(1.0 - k * 0.5, -1.3, yaw);
    b.box('rough', mat(x + p.x, 0, z + p.z, yaw + B.rng() * 0.5), 0.35, 0.05 + B.rng() * 0.1, 0.5, C(0x8a8478), { ao: 0 });
  }
  B.solid(x, z, 2.6, 2.0, 2.5, yaw, { tag: 'kiosk' });
}

// Bus shelter: steel frame, broken glass, one intact ad panel at the end (which blocks sight).
export function busShelter(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  for (const sx of [-1.9, 1.9]) for (const sz of [-0.6, 0.6]) b.box('metal', sub(M, sx, 0, sz), 0.08, 2.5, 0.08, COL.darkSteel, { ao: 0 });
  b.box('metal', sub(M, 0, 2.5, 0), 4.1, 0.1, 1.5, COL.darkSteel, { ao: 0 });
  b.box('glass', sub(M, 0, 0.5, 0.6), 3.8, 1.6, 0.03, shade(COL.glass, 0.6), { ao: 0 });
  b.box('rough', sub(M, 0, 0.45, 0.35), 3.0, 0.05, 0.35, COL.darkSteel, { ao: 0 });
  // ad panel at one end
  b.box('paint', sub(M, -1.9, 0.1, 0), 0.14, 2.2, 1.3, COL.darkSteel, { ao: 0.2 });
  const pr = _rot(-1.82, 0, yaw);
  B.batch.wall('signs', x + pr.x, 0.3, z + pr.z, 1.1, 1.8, yaw - Math.PI / 2, signUV('poster'));
  const pl = _rot(-1.98, 0, yaw);
  B.batch.wall('signs', x + pl.x, 0.3, z + pl.z, 1.1, 1.8, yaw + Math.PI / 2, signUV('poster'));
  B.solid(x + pr.x - _rot(0.08, 0, yaw).x, z + pr.z - _rot(0.08, 0, yaw).z, 0.16, 1.3, 2.3, yaw, { tag: 'shelter' });
  const back = _rot(0, 0.6, yaw);
  B.solid(x + back.x, z + back.z, 3.9, 0.1, 2.1, yaw, { tag: 'shelter', blocksSight: false });
  B.decal('papers', x - back.x * 2, z - back.z * 2, 2.5, 2.5, B.rng() * 6);
}

// Billboard on two posts (or on a roof when y > 0). Faces direction `yaw`.
export function billboard(B, { x, z, y = 0, yaw = 0, w = 10, h = 5, post = 7 }) {
  const b = B.batch;
  const M = mat(x, y, z, yaw);
  for (const sx of [-w * 0.3, w * 0.3]) {
    b.box('metal', sub(M, sx, 0, 0.4), 0.35, post, 0.35, COL.darkSteel, { ao: 0.2 });
    b.box('metal', sub(M, sx, post * 0.4, 0.8, 0, 0.5), 0.12, post * 0.6, 0.12, COL.darkSteel, { ao: 0 });
  }
  b.box('metal', sub(M, 0, post - 0.2, 0.15), w + 0.4, h + 0.4, 0.3, C(0x1c1c1c), { ao: 0 });
  b.box('metal', sub(M, 0, post - 0.6, -0.4), w, 0.08, 0.9, COL.darkSteel, { ao: 0 });
  const sf = _rot(0, -0.02, yaw);
  B.batch.wall('signs', x + sf.x, y + post, z + sf.z, w, h, yaw, signUV('billboard'));
  if (!y) for (const sx of [-w * 0.3, w * 0.3]) {
    const p = _rot(sx, 0.4, yaw);
    B.solid(x + p.x, z + p.z, 0.4, 0.4, post, yaw, { tag: 'pole' });
  }
}

// Bronze figure on a stone plinth, one arm raised and pointing along `point` yaw.
export function statue(B, { x, z, yaw = 0, plinth = 2.4, w = 3.2 }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  b.box('rough', M, w + 0.6, 0.4, w + 0.6, shade(COL.concrete, 0.7), { ao: 0.3 });
  b.box('rough', sub(M, 0, 0.4, 0), w, plinth - 0.4, w, shade(COL.concrete, 0.85), { ao: 0.4 });
  b.box('rough', sub(M, 0, plinth - 0.1, 0), w + 0.25, 0.25, w + 0.25, shade(COL.concrete, 0.75), { ao: 0 });
  const F = sub(M, 0, plinth + 0.15, 0);
  const bz = COL.bronze;
  b.box('metal', F, 0.9, 0.2, 0.9, bz);
  // legs, long coat, torso, head bowed
  b.geom('metal', frustum(0.75, 0.95, 0.5, 0.62, 1.6, 0), sub(F, 0, 0.2, 0), bz);
  b.geom('metal', frustum(0.5, 0.62, 0.4, 0.72, 0.9, 0), sub(F, 0, 1.8, 0), bz);
  b.geom('metal', cyl(0.13, 0.15, 0.25, 8), sub(F, 0, 2.7, 0), bz);
  b.box('metal', sub(F, 0, 2.92, -0.05, 0, 0.25), 0.3, 0.38, 0.32, bz);
  // pointing arm (towards -Z) and hanging arm
  b.box('metal', sub(F, -0.33, 2.55, -0.1, 0, 1.25), 0.15, 0.9, 0.15, bz);
  b.box('metal', sub(F, 0.4, 1.75, 0, 0, 0, -0.08), 0.15, 0.85, 0.15, bz);
  B.solid(x, z, w + 0.6, w + 0.6, plinth + 2.8, yaw, { tag: 'statue' });
}

export function fountain(B, { x, z, r = 6 }) {
  const b = B.batch;
  const segs = 20;
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    const len = 2 * r * Math.sin(Math.PI / segs) + 0.05;
    b.box('rough', mat(x + Math.cos(a) * r, 0, z + Math.sin(a) * r, -a), 0.55, 0.85, len, shade(COL.concrete, 0.8), { ao: 0.35 });
  }
  // dry basin floor + leaves
  b.geom('rough', cyl(r - 0.2, r - 0.2, 0.05, 24), mat(x, 0, z), COL.darkConcrete);
  B.decal('leaves', x + 1.5, z - 1, 4, 4, 0.4);
  B.decal('leaves', x - 2, z + 1.5, 3.5, 3.5, 2);
  // central column + bowl + spout
  b.geom('rough', cyl(0.9, 1.2, 1.4, 12), mat(x, 0, z), shade(COL.concrete, 0.85), { ao: 0.4, aoHeight: 1.2 });
  b.geom('rough', cyl(2.2, 1.0, 0.55, 16), mat(x, 1.4, z), shade(COL.concrete, 0.8));
  b.geom('rough', cyl(0.35, 0.45, 1.3, 10), mat(x, 1.95, z), shade(COL.concrete, 0.85));
  b.geom('rough', cyl(0.9, 0.3, 0.3, 12), mat(x, 3.2, z), shade(COL.concrete, 0.8));
  // rim colliders (octagon of boxes) + column
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const len = 2 * r * Math.sin(Math.PI / 8) + 0.6;
    B.solid(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.6, len, 0.85, -a, { tag: 'fountain' });
  }
  B.solid(x, z, 2.2, 2.2, 3.5, 0, { tag: 'fountain' });
}

// Gas-station canopy over two pump islands, with a dead price board on a pole.
export function gasCanopy(B, { x, z, w = 14, d = 10, h = 5 }) {
  const b = B.batch;
  for (const sx of [-w / 2 + 1.5, w / 2 - 1.5]) {
    for (const sz of [-d / 2 + 2, d / 2 - 2]) {
      b.box('paint', mat(x + sx, 0, z + sz), 0.45, h, 0.45, C(0xb9b2a4), { ao: 0.4 });
      B.solid(x + sx, z + sz, 0.5, 0.5, h, 0, { tag: 'pillar' });
    }
  }
  b.box('paint', mat(x, h, z), w, 0.9, d, C(0xb9b2a4), { ao: 0 });
  B.solid(x, z, w, d, 0.9, 0, { y: h, blocksMove: false, tag: 'canopy' }); // overhead only: stops lobbed bottles
  b.box('rough', mat(x, h - 0.02, z), w - 0.6, 0.05, d - 0.6, C(0x1a1816), { ao: 0, faces: FACE.ny });
  // canopy fascia band
  for (const [fx, fz, fw, yaw] of [[x, z - d / 2 - 0.01, w, 0], [x, z + d / 2 + 0.01, w, Math.PI], [x + w / 2 + 0.01, z, d, -Math.PI / 2], [x - w / 2 - 0.01, z, d, Math.PI / 2]]) {
    b.wall('signs', fx, h + 0.05, fz, fw, 0.8, yaw, signUV('gasco'));
  }
  // pump islands
  const pumps = [];
  for (const sx of [-w / 4, w / 4]) {
    b.box('rough', mat(x + sx, 0, z), 1.2, 0.2, d * 0.55, shade(COL.concrete, 0.8), { ao: 0 });
    for (const sz of [-d * 0.15, d * 0.15]) {
      b.box('paint', mat(x + sx, 0.2, z + sz), 0.75, 1.6, 0.5, C(0x8a2a1e), { ao: 0.3 });
      b.box('glass', mat(x + sx, 1.25, z + sz), 0.6, 0.35, 0.52, COL.black, { ao: 0 });
      pumps.push({ x: x + sx, z: z + sz });
      B.solid(x + sx, z + sz, 0.8, 0.55, 1.8, 0, { tag: 'pump' });
    }
  }
  // fluorescent tubes under the canopy (dead), returned so the level can light one
  const tubes = [];
  for (const sx of [-w / 4, w / 4]) {
    b.box('emissive', mat(x + sx, h - 0.08, z), 0.25, 0.06, d * 0.5, C(0x1a1c1c), { ao: 0, faces: FACE.ny });
    tubes.push(new THREE.Vector3(x + sx, h - 0.2, z));
  }
  return { pumps, tubes };
}

// Price sign on a tall pole.
export function fuelSign(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  b.box('metal', mat(x, 0, z, yaw), 0.3, 6, 0.3, COL.darkSteel, { ao: 0 });
  b.box('paint', mat(x, 6, z, yaw), 2.2, 2.4, 0.3, C(0x2a2a2a), { ao: 0 });
  for (const s of [1, -1]) {
    const f = _rot(0, s * -0.16, yaw);
    B.batch.wall('signs', x + f.x, 6.1, z + f.z, 2.0, 2.2, s > 0 ? yaw : yaw + Math.PI, signUV('fuel'));
  }
  B.solid(x, z, 0.35, 0.35, 6, 0, { tag: 'pole' });
}

// Highway gantry spanning the road from x0 to x1 at z.
export function gantry(B, { x0, x1, z, h = 6.2, signs = [] }) {
  const b = B.batch;
  for (const x of [x0, x1]) {
    b.box('metal', mat(x, 0, z), 0.45, h + 1.4, 0.45, COL.steel, { ao: 0.2 });
    B.solid(x, z, 0.5, 0.5, h + 1.4, 0, { tag: 'pole' });
  }
  const w = x1 - x0;
  b.box('metal', mat((x0 + x1) / 2, h + 1.0, z), w, 0.35, 0.6, COL.steel, { ao: 0 });
  b.box('metal', mat((x0 + x1) / 2, h + 1.6, z), w, 0.15, 0.4, COL.steel, { ao: 0 });
  for (const s of signs) {
    b.wall('signs', s.x, h - 0.9, z + 0.36, s.w, s.w / 2, Math.PI, signUV(s.sign));
    b.box('metal', mat(s.x, h - 0.9, z + 0.28), s.w, s.w / 2, 0.08, COL.darkSteel, { ao: 0 });
  }
}

const stripeBand = () => {
  const [u0, v0, u1, v1] = signUV('stripes');
  return [u0, v0 + (v1 - v0) * 0.3, u0 + (u1 - u0) * 0.6, v0 + (v1 - v0) * 0.42];
};

// Saw-horse barricade with striped boards. blocksMove only.
export function barricade(B, { x, z, yaw = 0, w = 2.4, sign = false }) {
  const b = B.batch;
  const M = mat(x, 0, z, yaw);
  for (const sx of [-w / 2 + 0.15, w / 2 - 0.15]) {
    b.box('rough', sub(M, sx, 0, 0.2, 0, 0.2), 0.08, 1.1, 0.08, COL.wood, { ao: 0 });
    b.box('rough', sub(M, sx, 0, -0.2, 0, -0.2), 0.08, 1.1, 0.08, COL.wood, { ao: 0 });
  }
  for (const y of [0.55, 0.95]) {
    b.box('rough', sub(M, 0, y, 0), w, 0.2, 0.04, COL.white, { ao: 0, faces: FACE.py | FACE.ny | FACE.px | FACE.nx });
    for (const s of [1, -1]) {
      const f = _rot(0, s * -0.025, yaw);
      b.wall('signs', x + f.x, y, z + f.z, w, 0.2, s > 0 ? yaw : yaw + Math.PI, stripeBand());
    }
  }
  if (sign) {
    const f = _rot(0, -0.03, yaw);
    b.wall('signs', x + f.x, 1.2, z + f.z, 1.2, 0.6, yaw, signUV('roadClosed'));
    b.box('rough', sub(M, 0, 1.15, 0), 1.22, 0.7, 0.02, COL.darkSteel, { ao: 0 });
  }
  B.solid(x, z, w, 0.5, 1.15, yaw, { tag: 'barricade', blocksSight: false });
}

// Wall-mounted details for alley walls: AC units, pipes, back doors with a hood lamp.
export function acUnit(B, { x, y, z, yaw = 0 }) {
  B.batch.box('metal', mat(x, y, z, yaw), 0.9, 0.6, 0.55, C(0x6a6a64), { ao: 0.3 });
  B.batch.box('rough', mat(x, y + 0.1, z + 0, yaw), 0.7, 0.4, 0.57, C(0x1a1a1a), { ao: 0, faces: FACE.nz });
}

export function pipe(B, { x, z, h, yaw = 0, r = 0.08 }) {
  B.batch.geom('metal', cyl(r, r, h, 6), mat(x, 0, z, yaw), mix(COL.rust, COL.darkSteel, 0.5));
}

export function backDoor(B, { x, z, yaw = 0 }) {
  const b = B.batch;
  const f = _rot(0, -0.06, yaw);
  b.box('paint', mat(x + f.x, 0, z + f.z, yaw), 1.2, 2.2, 0.12, C(0x2a2c2a), { ao: 0.3 });
  b.box('rough', mat(x + f.x * 2, 2.2, z + f.z * 2, yaw), 1.5, 0.12, 0.2, COL.darkConcrete, { ao: 0 });
  b.box('metal', mat(x + f.x * 4, 2.9, z + f.z * 4, yaw), 0.4, 0.22, 0.45, COL.darkSteel, { ao: 0 });
  return new THREE.Vector3(x + f.x * 6, 2.78, z + f.z * 6);
}

// Ground decals are thin quads on the 'decal' material.
export function manhole(B, x, z) {
  B.decal('manhole', x, z, 0.9, 0.9, B.rng() * 6);
}

export { shade, mix, C as color, cylX };
