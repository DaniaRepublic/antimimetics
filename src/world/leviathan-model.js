import * as THREE from 'three';
import { lerp, makeRng, smoothstep } from '../core/math.js';
import { createLeviathanMaterials, createLeviathanUniforms } from './leviathan-materials.js';

// Procedural geometry for the leviathan. Body-local frame: origin at the body centre,
// forward is -Z, up is +Y. Everything here is built once; the creature animates through
// the body transform, shader uniforms (neck, jaw, tendrils, skin) and leg instance matrices.

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

export const BODY_FRONT = -36;
export const BODY_LENGTH = 86;
export const NECK_PIVOT = new THREE.Vector3(0, 0.3, -33);
export const LEG_LENGTHS = { femur: 60, tibia: 140, needle: 32 };
export const TIBIA_HALF = 70;

// u: hip position along the body (0 front .. 1 tail); foot: ideal planted spot relative to the
// body's ground point (x right, z back). front: +1 front pair, -1 rear pair.
export const LEG_DEFS = [
  { u: 0.13, side: -1, foot: [-46, -58], front: 1 },
  { u: 0.13, side: 1, foot: [46, -58], front: 1 },
  { u: 0.38, side: -1, foot: [-64, -4], front: 0 },
  { u: 0.38, side: 1, foot: [64, -4], front: 0 },
  { u: 0.62, side: -1, foot: [-48, 44], front: -1 },
  { u: 0.62, side: 1, foot: [48, 44], front: -1 },
];

// Body radius profile: (u, radius). Three bulbous sections joined by waists, then the tail.
const PROFILE = [
  [0, 1.6], [0.02, 3.3], [0.07, 4.6], [0.14, 5.1], [0.22, 4.6], [0.27, 3.8], [0.32, 4.4],
  [0.39, 4.9], [0.47, 4.3], [0.52, 3.6], [0.57, 4.0], [0.63, 4.1], [0.69, 3.3], [0.76, 2.3],
  [0.86, 1.35], [0.95, 0.75], [1, 0.45],
];

function profile(u) {
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [u0, r0] = PROFILE[i];
    const [u1, r1] = PROFILE[i + 1];
    if (u <= u1) return lerp(r0, r1, smoothstep(u0, u1, u));
  }
  return PROFILE[PROFILE.length - 1][1];
}

function angDist(a, b) {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

export function bodyCenter(u, out = new THREE.Vector3()) {
  const arch = 1.1 * Math.sin(Math.PI * Math.min(u / 0.72, 1));
  const droop = -12 * Math.pow(smoothstep(0.6, 1, u), 1.7);
  return out.set(0, arch + droop, BODY_FRONT + BODY_LENGTH * u);
}

const HIP_U = [...new Set(LEG_DEFS.map((l) => l.u))];

// The body tube runs front -> tail (+Z), so its ring frame puts theta = 0 on the creature's
// LEFT (-X) and theta = PI on its right; PI/2 is the spine, 3PI/2 the belly. Angle `below`
// radians under the equator on the given side (+1 right, -1 left):
function sideTheta(side, below = 0.35) {
  return side > 0 ? Math.PI + below : -below;
}

// Cross-section offset (in the ring's side/up frame) of the body surface at (u, theta).
function bodyOffset(u, th) {
  const seg = (u * 13 + 0.5) % 1;
  const r = profile(u) * (0.93 + 0.07 * Math.pow(Math.sin(Math.PI * seg), 0.7));
  const s = Math.sin(th);
  const c = Math.cos(th);
  let k = 1;
  k += 0.26 * Math.pow(Math.max(0, s), 16); // dorsal ridge
  k += 0.1 * Math.pow(Math.max(0, -s), 10); // ventral keel
  k -= 0.1 * Math.exp(-Math.pow((s + 0.45) / 0.22, 2)); // starved, sunken flanks
  if (u < 0.74) {
    const rib = Math.pow(0.5 + 0.5 * Math.cos(TAU * u * 46), 6);
    k += 0.07 * rib * (1 - Math.pow(Math.max(0, s), 2)) * smoothstep(0.03, 0.08, u);
  }
  for (const hu of HIP_U) {
    const dz = (u - hu) * BODY_LENGTH;
    const dth = Math.min(angDist(th, -0.35), angDist(th, Math.PI + 0.35));
    k += 0.32 * Math.exp(-(dz * dz) / 7 - (dth * dth) / 0.09);
  }
  return { ox: c * r * 0.92 * k, oy: s * r * 1.06 * k };
}

// Point on the body surface (rest pose). The body centreline lies in the YZ plane, so the
// ring frame is side = +X and up = the centreline normal.
export function bodySurface(u, th, out = new THREE.Vector3(), lift = 0) {
  const c = bodyCenter(u, out);
  const du = 0.004;
  const a = bodyCenter(Math.max(0, u - du), new THREE.Vector3());
  const b = bodyCenter(Math.min(1, u + du), new THREE.Vector3());
  const t = b.sub(a).normalize();
  const side = new THREE.Vector3().crossVectors(t, UP).normalize();
  const up = new THREE.Vector3().crossVectors(side, t).normalize();
  const o = bodyOffset(u, th);
  const len = Math.hypot(o.ox, o.oy) || 1;
  return c.addScaledVector(side, o.ox * (1 + lift / len)).addScaledVector(up, o.oy * (1 + lift / len));
}

// Accumulates an indexed mesh with the creature's custom attributes.
class Builder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.info = [];
    this.part = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  vert(p, uv, info, part) {
    this.pos.push(p.x, p.y, p.z);
    this.uv.push(uv[0], uv[1]);
    this.info.push(info[0], info[1], info[2], info[3]);
    this.part.push(part);
  }

  // Closed tube along `centers`. sample(i, theta) -> { ox, oy, uv, info, part } where ox/oy are
  // offsets along the ring's side/up axes.
  tube(centers, radial, sample, refUp = UP) {
    const n = centers.length;
    const base = this.count;
    const T = new THREE.Vector3(), S = new THREE.Vector3(), U = new THREE.Vector3(), P = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      T.subVectors(centers[Math.min(n - 1, i + 1)], centers[Math.max(0, i - 1)]).normalize();
      S.crossVectors(T, refUp);
      if (S.lengthSq() < 1e-8) S.set(1, 0, 0);
      S.normalize();
      U.crossVectors(S, T).normalize();
      for (let j = 0; j < radial; j++) {
        const th = (j / radial) * TAU;
        const s = sample(i, th, j);
        P.copy(centers[i]).addScaledVector(S, s.ox).addScaledVector(U, s.oy);
        this.vert(P, s.uv, s.info, s.part);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = 0; j < radial; j++) {
        const j1 = (j + 1) % radial;
        const a = base + i * radial + j;
        const b = base + (i + 1) * radial + j;
        const c = base + (i + 1) * radial + j1;
        const d = base + i * radial + j1;
        this.idx.push(a, b, d, b, c, d);
      }
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(this.info, 4));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

function frameFor(dir) {
  const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  return { side, up };
}

// Builds the static body mesh data (body, spines, neck, head, jaw, tendrils) and the
// body-local light points. Returns { geometry, lights, jawPivot, headTip }.
function buildBody() {
  const rng = makeRng(7331);
  const b = new Builder();
  const lights = { pos: [], uv: [], info: [], part: [], light: [] };
  const addLight = (p, uv, info, part, size, brightness) => {
    lights.pos.push(p.x, p.y, p.z);
    lights.uv.push(uv[0], uv[1]);
    lights.info.push(info[0], info[1], info[2], info[3]);
    lights.part.push(part);
    lights.light.push(size, rng() * TAU, brightness);
  };
  const NONE = [0, 0, 0, 0];

  // --- body
  const N = 260, RAD = 28;
  const centers = [];
  for (let i = 0; i < N; i++) centers.push(bodyCenter(i / (N - 1)));
  b.tube(centers, RAD, (i, th) => {
    const u = i / (N - 1);
    const o = bodyOffset(u, th);
    return { ox: o.ox, oy: o.oy, uv: [u, th / TAU], info: NONE, part: 0 };
  });

  // --- a tattered fluke at the end of the tail (moves with the tail sway: uv.x = 1)
  const tailEnd = bodyCenter(1);
  const FN = 19;
  const flukePts = [];
  const chords = [];
  for (let i = 0; i < FN; i++) {
    const x = lerp(-9, 9, i / (FN - 1));
    const ax = Math.abs(x) / 9;
    let chord = 0.5 + 3.8 * Math.sqrt(Math.max(0, 1 - ax * ax));
    if (ax > 0.3) chord *= 0.75 + 0.25 * rng(); // torn trailing edge
    chords.push(chord);
    flukePts.push(new THREE.Vector3(x, tailEnd.y - 0.6 * ax * ax + 0.3, tailEnd.z - 0.4 + 3.2 * Math.pow(ax, 1.3) + chord * 0.4));
  }
  b.tube(flukePts, 10, (i, th) => ({
    ox: Math.cos(th) * chords[i] * 0.5, oy: Math.sin(th) * (0.12 + chords[i] * 0.06), uv: [1, th / TAU], info: NONE, part: 0,
  }));

  // --- dorsal spines and flank barbs
  const spine = (base, dir, len, r0, u, radial = 6) => {
    const pts = [0, 0.35, 0.75, 1].map((t) => base.clone().addScaledVector(dir, t * len));
    const radii = [r0, r0 * 0.62, r0 * 0.3, 0.02];
    b.tube(pts, radial, (i, th) => ({
      ox: Math.cos(th) * radii[i], oy: Math.sin(th) * radii[i], uv: [u, th / TAU], info: NONE, part: 5,
    }));
  };
  for (let k = 1; k <= 9; k++) {
    const u = k / 13;
    const len = (4 + 9 * (profile(u) / 5.1)) * (1 - 0.4 * u) * (0.8 + 0.4 * rng());
    const base = bodySurface(u, Math.PI / 2, new THREE.Vector3(), -0.6);
    spine(base, new THREE.Vector3((rng() - 0.5) * 0.2, 1, 0.5 + 0.3 * rng()).normalize(), len, 0.3 + len * 0.035, u);
    if (k % 2) {
      // a thinner, longer quill beside some of the spines
      const qb = bodySurface(u + 0.02, Math.PI / 2 + (rng() - 0.5) * 0.5, new THREE.Vector3(), -0.4);
      spine(qb, new THREE.Vector3((rng() - 0.5) * 0.5, 1, 0.9).normalize(), len * 1.25, 0.2, u, 5);
    }
    for (const sd of [-1, 1]) {
      const th = Math.PI / 2 + sd * 0.75;
      const fb = bodySurface(u + 0.012, th, new THREE.Vector3(), -0.3);
      const dir = new THREE.Vector3(sd * 0.8, 0.55, 0.7).normalize();
      spine(fb, dir, 1.4 + 1.6 * rng(), 0.22, u, 5);
    }
  }

  // --- neck (bends progressively from the pivot)
  const neckCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.4, -30),
    new THREE.Vector3(0, 0.2, -37.5),
    new THREE.Vector3(0, -4.2, -44.5),
    new THREE.Vector3(0, -11.5, -48.5),
    new THREE.Vector3(0, -19, -50.2),
    new THREE.Vector3(0, -24, -50.8),
  ]);
  const NN = 44;
  const neckPts = neckCurve.getSpacedPoints(NN - 1);
  b.tube(neckPts, 14, (i, th) => {
    const t = i / (NN - 1);
    let r = lerp(3.3, 1.25, Math.pow(t, 0.75));
    const s = Math.sin(th);
    r *= 1 + 0.16 * Math.pow(0.5 + 0.5 * Math.cos(TAU * t * 11), 4) * (0.4 + 0.6 * Math.max(0, s));
    return { ox: Math.cos(th) * r * 0.88, oy: s * r * 1.05, uv: [t, th / TAU], info: [0, t, 0, 0], part: 1 };
  });
  for (let k = 2; k < 8; k++) {
    const t = k / 9;
    const p = neckCurve.getPointAt(t);
    const tan = neckCurve.getTangentAt(t);
    const { up } = frameFor(tan);
    const r = lerp(3.3, 1.25, Math.pow(t, 0.75)) * 1.05;
    addLight(p.addScaledVector(up, -r - 0.1), [0, 0], [0, t, 0, 0], 1, 0.8, 0.3);
  }

  // --- head: a small, eyeless, laterally pinched skull hanging from the neck
  const neckEnd = neckPts[NN - 1];
  const hdir = new THREE.Vector3(0, -0.85, -0.5).normalize();
  const hf = frameFor(hdir);
  const H0 = neckEnd.clone().addScaledVector(hdir, -1.2);
  const HL = 10.5;
  const HEAD = [[0, 1.3], [0.1, 1.9], [0.28, 2.1], [0.45, 1.75], [0.7, 1.05], [0.9, 0.7], [0.97, 0.45], [1, 0.1]];
  const headR = (t) => {
    for (let i = 0; i < HEAD.length - 1; i++) {
      if (t <= HEAD[i + 1][0]) return lerp(HEAD[i][1], HEAD[i + 1][1], smoothstep(HEAD[i][0], HEAD[i + 1][0], t));
    }
    return 0.1;
  };
  const HN = 34;
  const headPts = [];
  for (let i = 0; i < HN; i++) headPts.push(H0.clone().addScaledVector(hdir, (i / (HN - 1)) * HL));
  b.tube(headPts, 16, (i, th) => {
    const t = i / (HN - 1);
    const r = headR(t);
    const s = Math.sin(th);
    const crest = 0.28 * Math.pow(Math.max(0, s), 8) * (1 - smoothstep(0.3, 0.7, t));
    return { ox: Math.cos(th) * r * 0.74, oy: s * r * (1 + crest), uv: [t, th / TAU], info: [0, 1, 0, 0], part: 2 };
  });
  const headTip = H0.clone().addScaledVector(hdir, HL);

  // --- lower jaw, hinged under the skull
  const jawPivot = H0.clone().addScaledVector(hdir, 2.4).addScaledVector(hf.up, -1.25);
  const jdir = hdir.clone().addScaledVector(hf.up, -0.1).normalize();
  const JL = 7.2, JN = 18;
  const jawPts = [];
  for (let i = 0; i < JN; i++) jawPts.push(jawPivot.clone().addScaledVector(jdir, (i / (JN - 1)) * JL));
  b.tube(jawPts, 10, (i, th) => {
    const t = i / (JN - 1);
    const r = lerp(0.95, 0.15, Math.pow(t, 1.6));
    return {
      ox: Math.cos(th) * r * 0.95, oy: Math.sin(th) * r * 0.55, uv: [0.3 + 0.7 * t, th / TAU], info: [1, 1, 0, 0], part: 3,
    };
  });

  // --- tendrils: thin filaments hanging from the belly (and a few from the jaw)
  const tendril = (anchor, length, r0, info0, phase, uvx) => {
    const TN = 18;
    const pts = [];
    const bend = rng() * TAU;
    for (let i = 0; i < TN; i++) {
      const s = i / (TN - 1);
      pts.push(anchor.clone().add(new THREE.Vector3(Math.sin(bend) * s * s * 1.5, -length * s, Math.cos(bend) * s * s * 1.5)));
    }
    b.tube(pts, 5, (i, th) => {
      const s = i / (TN - 1);
      const r = r0 * Math.pow(1 - s, 0.7) + 0.05;
      return { ox: Math.cos(th) * r, oy: Math.sin(th) * r, uv: [uvx, r], info: [info0[0], info0[1], s, phase], part: 4 };
    }, new THREE.Vector3(0, 0, -1));
    addLight(pts[TN - 1], [uvx, 0], [info0[0], info0[1], 1, phase], 4, 1.1, 0.55);
  };
  for (let k = 0; k < 14; k++) {
    const u = 0.1 + k * 0.042 + rng() * 0.01;
    const th = 1.5 * Math.PI + (k % 2 ? 0.32 : -0.32);
    const anchor = bodySurface(u, th, new THREE.Vector3(), -0.4);
    const length = (12 + 24 * Math.sin((Math.PI * (k + 0.5)) / 14)) * (0.6 + 0.6 * rng());
    tendril(anchor, length, 0.42, [0, 0], rng() * TAU, u);
  }
  for (let k = 0; k < 3; k++) {
    const t = 0.55 + k * 0.17;
    const anchor = jawPivot.clone().addScaledVector(jdir, t * JL).addScaledVector(hf.up, -0.3);
    tendril(anchor, 7 + rng() * 6, 0.16, [1, 1], rng() * TAU, 0.5);
  }

  // --- belly light rows (match the pores the surface shader draws), hip lights, throat
  for (let k = 4; k < 48; k += 3) {
    const u = k / 64;
    for (const sd of [-1, 1]) {
      if (rng() < 0.25) continue;
      const th = TAU * (0.75 + sd * 0.055);
      const p = bodySurface(u, th, new THREE.Vector3(), 0.12);
      addLight(p, [u, 0], NONE, 0, 0.85, 0.25 + 0.4 * rng());
    }
  }
  for (const def of LEG_DEFS) {
    addLight(bodySurface(def.u, sideTheta(def.side, 0.8), new THREE.Vector3(), 0.2), [def.u, 0], NONE, 0, 1.4, 0.5);
  }
  for (const t of [0.45, 0.62]) {
    const p = H0.clone().addScaledVector(hdir, t * HL).addScaledVector(hf.up, -headR(t) - 0.1);
    addLight(p, [0, 0], [0, 1, 0, 0], 2, 0.8, 0.35);
  }

  const geometry = b.build();
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += 25; // neck swings and tendril sway happen in the shader

  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lights.pos, 3));
  lg.setAttribute('uv', new THREE.Float32BufferAttribute(lights.uv, 2));
  lg.setAttribute('aInfo', new THREE.Float32BufferAttribute(lights.info, 4));
  lg.setAttribute('aPart', new THREE.Float32BufferAttribute(lights.part, 1));
  lg.setAttribute('aLight', new THREE.Float32BufferAttribute(lights.light, 3));
  return { geometry, lights: lg, jawPivot, headTip };
}

function lathe(points) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 8);
}

// Leg segment shapes (+Y along the bone, joints bulge at the ends).
function buildLegGeometries() {
  const femur = lathe([
    [0.02, -2.4], [1.5, -2.0], [2.3, -0.6], [2.2, 1.2], [1.55, 3.5], [1.25, 10], [1.1, 32],
    [1.05, 50], [1.3, 56], [1.75, 58.8], [1.8, 60.6], [1.2, 62], [0.02, 62.6],
  ]);
  const tibia = lathe([
    [0.02, -1.8], [1.3, -1.3], [1.45, 0.3], [1.05, 3.5], [0.9, 20], [0.78, 50], [0.8, 64],
    [1.1, 68.5], [1.25, 70.2], [0.8, 71.4], [0.02, 71.8],
  ]);
  const needle = lathe([
    [0.02, -1.4], [1.0, -1.0], [1.2, 0.4], [0.8, 2.6], [0.62, 9], [0.42, 20], [0.2, 28], [0.06, 31.6], [0.0, 32],
  ]);
  return { femur, tibia, needle };
}

const DUST_SLOTS = 4;
const DUST_PER = 44;

function buildDustGeometry() {
  const rng = makeRng(99);
  const n = DUST_SLOTS * DUST_PER;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4);
  const slot = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    seed.set([Math.cos(a), rng(), Math.sin(a), rng()], i * 4);
    slot[i] = Math.floor(i / DUST_PER);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  return g;
}

// All meshes of the creature. `body` is moved by the behaviour code; legs, joint lights and
// dust live in world space.
export class LeviathanModel {
  constructor() {
    this.uniforms = createLeviathanUniforms();
    this.materials = createLeviathanMaterials(this.uniforms);
    this.root = new THREE.Group();
    this.root.name = 'leviathan';

    const built = buildBody();
    this.jawPivot = built.jawPivot;
    this.headTip = built.headTip;
    this.uniforms.uNeckPivot.value.copy(NECK_PIVOT);
    this.uniforms.uJawPivot.value.copy(built.jawPivot);

    this.body = new THREE.Group();
    this.body.name = 'leviathan-body';
    this.body.rotation.order = 'YXZ';
    this.bodyMesh = new THREE.Mesh(built.geometry, this.materials.body);
    this.body.add(this.bodyMesh);
    this.bodyLights = new THREE.Points(built.lights, this.materials.lights);
    this.bodyLights.frustumCulled = false;
    this.body.add(this.bodyLights);
    this.root.add(this.body);

    // Hip sockets in body-local space.
    this.hips = LEG_DEFS.map((def) => {
      return bodySurface(def.u, sideTheta(def.side), new THREE.Vector3(), -0.8);
    });

    const geo = buildLegGeometries();
    const n = LEG_DEFS.length;
    const inst = (g, count) => {
      const m = new THREE.InstancedMesh(g, this.materials.leg, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      this.root.add(m);
      return m;
    };
    this.femurs = inst(geo.femur, n);
    this.tibias = inst(geo.tibia, n * 2);
    this.needles = inst(geo.needle, n);

    // Knee / mid-shin / ankle glow, written every frame.
    const jl = new THREE.BufferGeometry();
    const jcount = n * 3;
    this.jointPos = new Float32Array(jcount * 3);
    const jlight = new Float32Array(jcount * 3);
    const jrng = makeRng(4242);
    const JL = [[1.6, 0.55], [1.0, 0.25], [1.4, 0.45]]; // knee, mid-shin, ankle: size (m), brightness
    for (let i = 0; i < jcount; i++) jlight.set([JL[i % 3][0], jrng() * TAU, JL[i % 3][1]], i * 3);
    jl.setAttribute('position', new THREE.BufferAttribute(this.jointPos, 3).setUsage(THREE.DynamicDrawUsage));
    jl.setAttribute('aLight', new THREE.BufferAttribute(jlight, 3));
    jl.setAttribute('aInfo', new THREE.BufferAttribute(new Float32Array(jcount * 4), 4));
    jl.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(jcount), 1));
    this.jointLights = new THREE.Points(jl, this.materials.jointLights);
    this.jointLights.frustumCulled = false;
    this.root.add(this.jointLights);

    this.dust = new THREE.Points(buildDustGeometry(), this.materials.dust);
    this.dust.frustumCulled = false;
    this.root.add(this.dust);
    this.dustNext = 0;
  }

  // Writes a bone instance: local +Y of the segment geometry runs from p0 to p1.
  static setSegment(mesh, i, p0, p1, nominal, radiusScale = 1) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    const len = Math.hypot(dx, dy, dz) || 1e-6;
    const yx = dx / len, yy = dy / len, yz = dz / len;
    // x = normalize(y cross UP) (fallback when vertical), z = x cross y
    let xx = -yz, xy = 0, xz = yx;
    let xl = Math.hypot(xx, xz);
    if (xl < 1e-5) {
      xx = 1;
      xz = 0;
      xl = 1;
    }
    xx /= xl;
    xz /= xl;
    const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
    const s = len / nominal;
    const r = radiusScale;
    const e = mesh.instanceMatrix.array;
    const o = i * 16;
    e[o] = xx * r; e[o + 1] = xy * r; e[o + 2] = xz * r; e[o + 3] = 0;
    e[o + 4] = yx * s; e[o + 5] = yy * s; e[o + 6] = yz * s; e[o + 7] = 0;
    e[o + 8] = zx * r; e[o + 9] = zy * r; e[o + 10] = zz * r; e[o + 11] = 0;
    e[o + 12] = p0.x; e[o + 13] = p0.y; e[o + 14] = p0.z; e[o + 15] = 1;
  }

  burstDust(pos, amount, time) {
    const u = this.materials.dust.uniforms;
    const i = this.dustNext;
    this.dustNext = (i + 1) % DUST_SLOTS;
    u.uBursts.value[i].set(pos.x, pos.y, pos.z, time);
    u.uBurstAmp.value[i] = amount;
  }
}
