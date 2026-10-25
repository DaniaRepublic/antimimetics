// Snatcher rig: bone layout, the merged skinned geometry (body + head + collar + cape) and the
// shared materials. One geometry + skin material per face variant, one cloth material for all.
//
// All bones have identity rest rotations, so procedural poses are plain Euler angles:
//   rotation.x > 0 swings a hanging limb forward / tips a spine segment backward,
//   rotation.z > 0 swings a hanging limb toward +X (the snatcher's right).
// The mesh has two groups: 0 = skin (face texture atlas), 1 = cloth (double-sided, alpha-tested).
import * as THREE from 'three';
import { smoothstep } from '../core/math.js';
import { HEAD, FACE_VARIANTS, SKIN_SWATCH, FINGER_SWATCH, buildHeadData } from './snatcher-head.js';
import { CAPE, capePoint, capeBoneRest } from './snatcher-cape.js';
import { paintFace, paintGlow, paintCloth, canvasTexture, CLOTH_CAPE, CLOTH_SOLID } from './snatcher-textures.js';

// name, parent, rest position (model space). Left = -X.
const BODY_BONES = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 1.06, 0]],
  ['spine', 'hips', [0, 1.2, 0]],
  ['chest', 'spine', [0, 1.44, 0]],
  ['neck', 'chest', [0, 1.72, -0.01]],
  ['head', 'neck', [0, 1.9, -0.01]],
  ['jaw', 'head', HEAD.jawHinge],
  ['face', 'head', HEAD.center],
  ['clavL', 'chest', [-0.04, 1.68, 0]],
  ['armL', 'clavL', [-0.205, 1.665, 0.005]],
  ['foreL', 'armL', [-0.222, 1.22, 0.01]],
  ['handL', 'foreL', [-0.235, 0.77, 0.0]],
  ['fing1L', 'handL', [-0.236, 0.655, 0.0]],
  ['fing2L', 'fing1L', [-0.236, 0.555, 0.0]],
  ['clavR', 'chest', [0.04, 1.68, 0]],
  ['armR', 'clavR', [0.205, 1.665, 0.005]],
  ['foreR', 'armR', [0.222, 1.22, 0.01]],
  ['handR', 'foreR', [0.235, 0.77, 0.0]],
  ['fing1R', 'handR', [0.236, 0.655, 0.0]],
  ['fing2R', 'fing1R', [0.236, 0.555, 0.0]],
  ['thighL', 'hips', [-0.1, 1.03, 0]],
  ['shinL', 'thighL', [-0.105, 0.55, 0]],
  ['footL', 'shinL', [-0.11, 0.075, 0]],
  ['thighR', 'hips', [0.1, 1.03, 0]],
  ['shinR', 'thighR', [0.105, 0.55, 0]],
  ['footR', 'shinR', [0.11, 0.075, 0]],
];

export const BONE = {};
export const BONE_REST = [];
export const BONE_PARENT = [];
BODY_BONES.forEach(([name, parent, pos], i) => {
  BONE[name] = i;
  BONE_REST.push(new THREE.Vector3(...pos));
  BONE_PARENT.push(parent === null ? -1 : BONE[parent]);
});
export const CAPE_FIRST = BODY_BONES.length;
const capeRest = capeBoneRest();
for (let k = 0; k < CAPE.cols * CAPE.rows; k++) {
  BONE_REST.push(new THREE.Vector3(capeRest[k * 3], capeRest[k * 3 + 1], capeRest[k * 3 + 2]));
  BONE_PARENT.push(BONE.root);
}
export const BONE_COUNT = BONE_REST.length;
export const CAPE_REST = capeRest;

export const LEG = { thigh: 0.48, shin: 0.475 };

// Creates a fresh bone hierarchy + skeleton for one instance.
export function createSkeleton() {
  const bones = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = new THREE.Bone();
    const p = BONE_PARENT[i];
    b.position.copy(BONE_REST[i]);
    if (p >= 0) {
      b.position.sub(BONE_REST[p]);
      bones[p].add(b);
    }
    bones.push(b);
  }
  bones.forEach((b, i) => (b.name = i < CAPE_FIRST ? BODY_BONES[i][0] : `cape${i - CAPE_FIRST}`));
  const inverses = BONE_REST.map((p) => new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
  return { bones, skeleton: new THREE.Skeleton(bones, inverses) };
}

// ---------------------------------------------------------------------------------------------
// Geometry builder

const _p = new THREE.Vector3();
const _l = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

class PartBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vertex(p, n, u, v, weights) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    const w = weights
      .map(([b, x]) => [typeof b === 'string' ? BONE[b] : b, x])
      .filter((x) => x[1] > 1e-4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const sum = w.reduce((s, x) => s + x[1], 0) || 1;
    for (let k = 0; k < 4; k++) {
      this.si.push(w[k] ? w[k][0] : 0);
      this.sw.push(w[k] ? w[k][1] / sum : 0);
    }
  }

  // Appends a three.js primitive transformed by `matrix`. uv: {x,y,w,h, transpose?} rect in the
  // atlas; weights(modelPos, localPos) -> [[bone, w], ...].
  add(geo, matrix, uv, weights) {
    const base = this.count;
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
    _nm.getNormalMatrix(matrix);
    for (let i = 0; i < P.count; i++) {
      _l.fromBufferAttribute(P, i);
      _p.copy(_l).applyMatrix4(matrix);
      _n.fromBufferAttribute(N, i).applyMatrix3(_nm).normalize();
      let u = U ? U.getX(i) : 0, v = U ? U.getY(i) : 0;
      if (uv.transpose) [u, v] = [1 - v, u];
      this.vertex(_p, _n, uv.x + u * uv.w, uv.y + v * uv.h, weights(_p, _l));
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) this.idx.push(base + geo.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
    geo.dispose();
  }
}

const rigid = (bone) => () => [[bone, 1]];
const Y_UP = new THREE.Vector3(0, 1, 0);

// Matrix placing a Y-aligned primitive between top point a and bottom point b, with an
// elliptical cross-section (sx, sz) and an optional twist about its axis.
function between(a, b, sx = 1, sz = 1, twist = 0) {
  const dir = new THREE.Vector3().subVectors(a, b);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.normalize());
  if (twist) q.multiply(new THREE.Quaternion().setFromAxisAngle(Y_UP, twist));
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(sx, 1, sz));
  return { m, len };
}

function at(x, y, z, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const R = (name) => BONE_REST[BONE[name]];

function addArm(skin, cloth, side) {
  const s = side;
  const S = s < 0 ? 'L' : 'R';
  const arm = `arm${S}`, fore = `fore${S}`, hand = `hand${S}`, f1 = `fing1${S}`, f2 = `fing2${S}`;
  const sh = R(arm), el = R(fore), wr = R(hand), kn = R(f1);
  // Bony shoulder knob.
  cloth.add(new THREE.SphereGeometry(0.056, 8, 6), at(sh.x + s * 0.004, sh.y + 0.004, sh.z, 1, 0.9, 1.1), CLOTH_SOLID, () => [[arm, 0.6], [`clav${S}`, 0.4]]);
  // Sleeve over the upper arm and the top of the forearm.
  let t = between(V(sh.x, sh.y + 0.02, sh.z), el);
  cloth.add(new THREE.CylinderGeometry(0.043, 0.036, t.len, 8, 2, true), t.m, CLOTH_SOLID, rigid(arm));
  cloth.add(new THREE.SphereGeometry(0.037, 7, 5), at(el.x, el.y, el.z), CLOTH_SOLID, rigid(fore));
  const cuff = V(el.x + (wr.x - el.x) * 0.62, el.y + (wr.y - el.y) * 0.62, el.z);
  t = between(el, cuff);
  cloth.add(new THREE.CylinderGeometry(0.036, 0.032, t.len, 8, 1, true), t.m, CLOTH_SOLID, rigid(fore));
  // Bare, bony wrist and hand.
  t = between(V(el.x + (wr.x - el.x) * 0.5, el.y + (wr.y - el.y) * 0.5, el.z), wr);
  skin.add(new THREE.CylinderGeometry(0.025, 0.02, t.len, 6, 1, true), t.m, SKIN_SWATCH, rigid(fore));
  skin.add(new THREE.SphereGeometry(0.021, 6, 4), at(wr.x, wr.y, wr.z, 0.8, 1, 1.2), SKIN_SWATCH, rigid(hand));
  t = between(V(wr.x, wr.y - 0.005, wr.z), V(kn.x, kn.y - 0.004, kn.z), 0.42, 1.18);
  skin.add(new THREE.CylinderGeometry(0.025, 0.03, t.len, 6, 1), t.m, SKIN_SWATCH, rigid(hand));
  // Four long fingers, splayed, two segments each (proximal -> fing1, distal -> fing2).
  const lens = [0.082, 0.098, 0.09, 0.07];
  const zs = [-0.024, -0.008, 0.008, 0.023];
  const splay = [-0.12, -0.035, 0.035, 0.1];
  const f1Swatch = { ...FINGER_SWATCH, w: FINGER_SWATCH.w * 0.5, transpose: true };
  const f2Swatch = { ...FINGER_SWATCH, x: FINGER_SWATCH.x + FINGER_SWATCH.w * 0.5, w: FINGER_SWATCH.w * 0.5, transpose: true };
  for (let k = 0; k < 4; k++) {
    const z0 = zs[k];
    const top = V(kn.x, kn.y + 0.004, z0);
    const mid = V(kn.x, R(f2).y, z0 + Math.sin(splay[k]) * 0.095);
    const tip = V(kn.x - s * 0.004, R(f2).y - lens[k], mid.z + Math.sin(splay[k]) * lens[k] * 1.1);
    t = between(top, mid);
    skin.add(new THREE.CylinderGeometry(0.0074, 0.0064, t.len, 5, 1), t.m, f1Swatch, rigid(f1));
    t = between(V(mid.x, mid.y + 0.004, mid.z), tip);
    skin.add(new THREE.CylinderGeometry(0.0064, 0.0022, t.len, 5, 1), t.m, f2Swatch, rigid(f2));
  }
  // Thumb, from the front of the palm, angled down and in.
  const tb = V(wr.x - s * 0.006, wr.y - 0.04, -0.03);
  t = between(tb, V(tb.x - s * 0.022, tb.y - 0.085, tb.z - 0.03));
  skin.add(new THREE.CylinderGeometry(0.0085, 0.0035, t.len, 5, 1), t.m, f1Swatch, rigid(hand));
}

function addLeg(cloth, side) {
  const s = side;
  const S = s < 0 ? 'L' : 'R';
  const thigh = `thigh${S}`, shin = `shin${S}`, foot = `foot${S}`;
  const hp = R(thigh), kn = R(shin), an = R(foot);
  let t = between(V(hp.x, hp.y + 0.05, hp.z), kn);
  cloth.add(new THREE.CylinderGeometry(0.064, 0.046, t.len, 8, 2, true), t.m, CLOTH_SOLID, rigid(thigh));
  cloth.add(new THREE.SphereGeometry(0.048, 7, 5), at(kn.x, kn.y, kn.z - 0.006, 1, 1.1, 1), CLOTH_SOLID, rigid(shin));
  t = between(kn, V(an.x, an.y + 0.02, an.z));
  cloth.add(new THREE.CylinderGeometry(0.045, 0.032, t.len, 8, 1, true), t.m, CLOTH_SOLID, rigid(shin));
  // Long, narrow feet bound in filthy rags.
  cloth.add(new THREE.SphereGeometry(0.034, 6, 5), at(an.x, an.y, an.z + 0.005), CLOTH_SOLID, rigid(foot));
  t = between(V(an.x, 0.035, an.z + 0.055), V(an.x + s * 0.012, 0.02, an.z - 0.21), 1.15, 0.62);
  cloth.add(new THREE.CylinderGeometry(0.031, 0.019, t.len, 6, 1), t.m, CLOTH_SOLID, rigid(foot));
}

function addTorso(cloth) {
  const prof = [
    [0.02, 0.93], [0.11, 0.955], [0.145, 1.02], [0.138, 1.11], [0.113, 1.21], [0.12, 1.31],
    [0.148, 1.43], [0.163, 1.54], [0.17, 1.62], [0.158, 1.685], [0.1, 1.725], [0.05, 1.76],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(prof, 12);
  cloth.add(geo, at(0, 0, 0.01, 1, 1, 0.6), CLOTH_SOLID, (p) => {
    const y = p.y;
    const w = [];
    if (y < 1.27) {
      const k = smoothstep(1.06, 1.24, y);
      w.push(['hips', 1 - k], ['spine', k]);
    } else if (y < 1.6) {
      const k = smoothstep(1.34, 1.5, y);
      w.push(['spine', 1 - k], ['chest', k]);
    } else {
      const kNeck = smoothstep(1.71, 1.76, y);
      const side = p.x < 0 ? 'clavL' : 'clavR';
      const kClav = smoothstep(0.09, 0.16, Math.abs(p.x)) * smoothstep(1.56, 1.66, y) * 0.6;
      w.push(['chest', Math.max(0, 1 - kNeck - kClav)], ['neck', kNeck], [side, kClav]);
    }
    return w;
  });
}

function addNeck(skin) {
  const t = between(V(0, 1.95, -0.012), V(0, 1.69, -0.004), 1, 0.92);
  skin.add(new THREE.CylinderGeometry(0.036, 0.043, t.len, 8, 4, true), t.m, SKIN_SWATCH, (p) => {
    const kHead = smoothstep(1.83, 1.93, p.y);
    const kChest = 1 - smoothstep(1.7, 1.76, p.y);
    return [['head', kHead], ['neck', Math.max(0, 1 - kHead - kChest)], ['chest', kChest]];
  });
}

function addHead(skin, variant) {
  const d = buildHeadData(variant);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
  g.setIndex(d.indices);
  g.computeVertexNormals();
  const N = g.attributes.normal;
  // Weld normals across the back seam (first/last column) and point the poles straight out.
  for (let r = 0; r < d.rows; r++) {
    const a = r * d.cols, b = r * d.cols + d.cols - 1;
    if (r === 0 || r === d.rows - 1) {
      for (let i = 0; i < d.cols; i++) N.setXYZ(r * d.cols + i, 0, r === 0 ? 1 : -1, 0);
      continue;
    }
    _n.set(N.getX(a) + N.getX(b), N.getY(a) + N.getY(b), N.getZ(a) + N.getZ(b)).normalize();
    N.setXYZ(a, _n.x, _n.y, _n.z);
    N.setXYZ(b, _n.x, _n.y, _n.z);
  }
  const base = skin.count;
  for (let k = 0; k < d.cols * d.rows; k++) {
    _p.fromArray(d.positions, k * 3);
    _n.fromBufferAttribute(N, k);
    skin.vertex(_p, _n, d.uvs[k * 2], d.uvs[k * 2 + 1], d.weights[k]);
  }
  for (const i of d.indices) skin.idx.push(base + i);
  g.dispose();
  return d.layout;
}

function addCollar(cloth) {
  const cols = 16, rows = 3;
  const psiMax = 2.55;
  const pos = [], uv = [], idx = [];
  const g = new THREE.BufferGeometry();
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const psi = psiMax * (2 * u - 1);
      const yTop = 1.99 - 0.15 * Math.pow(psi / psiMax, 2);
      const y = 1.67 + (yTop - 1.67) * t;
      const rx = 0.138 + 0.04 * t * t, rz = 0.118 + 0.045 * t * t;
      pos.push(rx * Math.sin(psi), y, rz * Math.cos(psi) + 0.012 + 0.03 * t * t);
      uv.push(CLOTH_SOLID.x + u * CLOTH_SOLID.w, CLOTH_SOLID.y + CLOTH_SOLID.h * (0.85 + 0.15 * t));
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const a = r * (cols + 1) + i, b = a + 1, c = a + cols + 2, d = a + cols + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  cloth.add(g, new THREE.Matrix4(), { x: 0, y: 0, w: 1, h: 1 }, (p) => {
    const k = smoothstep(1.75, 1.98, p.y) * 0.35;
    return [['chest', 1 - k], ['neck', k]];
  });
}

// Cape mesh, bilinearly skinned to the bone grid; the mantle (above row 0) rides the chest.
function addCape(cloth, seed) {
  const { cols, rows, rowT, mantleT } = CAPE;
  const NU = 26, NV = 18;
  const pos = [], uv = [], idx = [], wts = [];
  const p = [0, 0, 0];
  // Rows of the mesh: mantle, then denser near the top where the drape curves.
  const ts = [];
  for (let r = 0; r <= 3; r++) ts.push(mantleT + (-mantleT * r) / 3);
  for (let r = 1; r <= NV - 3; r++) ts.push(Math.pow(r / (NV - 3), 1.15));
  const hemJitter = [];
  let h = seed * 9301 + 49297;
  for (let i = 0; i <= NU; i++) {
    h = (h * 9301 + 49297) % 233280;
    hemJitter.push((h / 233280 - 0.5) * 0.08);
  }
  const rowOf = (t) => {
    for (let j = 0; j < rows - 1; j++) if (t <= rowT[j + 1]) return j + (t - rowT[j]) / (rowT[j + 1] - rowT[j]);
    return rows - 1;
  };
  for (let r = 0; r < ts.length; r++) {
    for (let i = 0; i <= NU; i++) {
      const u = i / NU;
      let t = ts[r];
      if (r === ts.length - 1) t += hemJitter[i];
      capePoint(u, Math.min(t, 1), p);
      if (t > 1) p[1] -= (t - 1) * (CAPE.topY - CAPE.hemY);
      pos.push(p[0], p[1], p[2]);
      uv.push(CLOTH_CAPE.u0 + u * (CLOTH_CAPE.u1 - CLOTH_CAPE.u0), 1 - (Math.min(t, 1.04) - mantleT) / (1.04 - mantleT));
      if (t < 0) {
        const s = (t - mantleT) / -mantleT;
        const k = smoothstep(0.55, 1, s);
        const ci = u * (cols - 1);
        const i0 = Math.min(cols - 2, Math.floor(ci));
        const fu = ci - i0;
        wts.push([['chest', 1 - k], [CAPE_FIRST + i0, k * (1 - fu)], [CAPE_FIRST + i0 + 1, k * fu]]);
      } else {
        const ci = u * (cols - 1);
        const i0 = Math.min(cols - 2, Math.floor(ci));
        const fu = ci - i0;
        const rj = Math.min(rowOf(Math.min(t, 1)), rows - 1);
        const j0 = Math.min(rows - 2, Math.floor(rj));
        const fv = Math.min(1, rj - j0);
        const b = (ii, jj) => CAPE_FIRST + jj * cols + ii;
        wts.push([
          [b(i0, j0), (1 - fu) * (1 - fv)], [b(i0 + 1, j0), fu * (1 - fv)],
          [b(i0, j0 + 1), (1 - fu) * fv], [b(i0 + 1, j0 + 1), fu * fv],
        ]);
      }
    }
  }
  for (let r = 0; r < ts.length - 1; r++) {
    for (let i = 0; i < NU; i++) {
      const a = r * (NU + 1) + i, b = a + 1, c = a + NU + 2, d = a + NU + 1;
      idx.push(a, d, b, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  let n = 0;
  cloth.add(g, new THREE.Matrix4(), { x: 0, y: 0, w: 1, h: 1 }, () => wts[n++]);
}

function assemble(skin, cloth) {
  const g = new THREE.BufferGeometry();
  const cat = (a, b) => a.concat(b);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat(skin.pos, cloth.pos), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat(skin.nrm, cloth.nrm), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(cat(skin.uv, cloth.uv), 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(cat(skin.si, cloth.si), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(cat(skin.sw, cloth.sw), 4));
  const off = skin.count;
  g.setIndex(skin.idx.concat(cloth.idx.map((i) => i + off)));
  g.addGroup(0, skin.idx.length, 0);
  g.addGroup(skin.idx.length, cloth.idx.length, 1);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 1.8);
  return g;
}

function buildGeometry(variant, seed) {
  const skin = new PartBuilder();
  const cloth = new PartBuilder();
  const layout = addHead(skin, variant);
  addNeck(skin);
  addArm(skin, cloth, -1);
  addArm(skin, cloth, 1);
  addLeg(cloth, -1);
  addLeg(cloth, 1);
  addTorso(cloth);
  addCollar(cloth);
  addCape(cloth, seed);
  return { geometry: assemble(skin, cloth), layout };
}

// ---------------------------------------------------------------------------------------------
// Materials

let clothMaterial = null;

// Near-black cloth with a faint red sheen at grazing angles (picks up the sky glow).
function getClothMaterial() {
  if (clothMaterial) return clothMaterial;
  const map = canvasTexture(paintCloth(11));
  const m = new THREE.MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float rim = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        totalEmissiveRadiance += vec3(0.05, 0.006, 0.004) * pow(rim, 3.0);
      }`,
    );
  };
  m.customProgramCacheKey = () => 'snatcher-cloth';
  clothMaterial = m;
  return m;
}

function makeSkinMaterial(variant, layout, seed) {
  const map = canvasTexture(paintFace(variant, layout, seed));
  const glow = canvasTexture(paintGlow(variant, layout));
  return new THREE.MeshStandardMaterial({
    map,
    bumpMap: map,
    bumpScale: 1.2,
    emissiveMap: glow,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    roughness: 0.48,
    metalness: 0,
  });
}

const cache = new Map();

// Shared assets for a face variant index: { geometry, materials: [skin, cloth], variant, layout }.
export function getSnatcherAssets(index) {
  const key = index % FACE_VARIANTS.length;
  let a = cache.get(key);
  if (a) return a;
  const variant = FACE_VARIANTS[key];
  const seed = 1013 + key * 7919;
  const { geometry, layout } = buildGeometry(variant, seed);
  a = { geometry, materials: [makeSkinMaterial(variant, layout, seed), getClothMaterial()], variant, layout };
  cache.set(key, a);
  return a;
}

// Frees every cached geometry/texture (for full teardown; instances must be disposed first).
export function disposeSnatcherAssets() {
  for (const a of cache.values()) {
    a.geometry.dispose();
    a.materials[0].map?.dispose();
    a.materials[0].emissiveMap?.dispose();
    a.materials[0].dispose();
  }
  cache.clear();
  if (clothMaterial) {
    clothMaterial.map?.dispose();
    clothMaterial.dispose();
    clothMaterial = null;
  }
}
