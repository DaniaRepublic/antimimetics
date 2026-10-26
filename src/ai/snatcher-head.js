// Snatcher head: shared UV layout, face variants and the head surface builder.
//
// The head is a deformed lat-long ellipsoid. Its UVs are warped so the front of the face gets
// most of the texture, and a pair of almost coincident "seam" rings runs along the mouth line:
// the upper ring is skinned to the head, the lower ring to the jaw. In the texture the thin band
// between the two rings is painted as a black mouth with teeth, so when the jaw drops the band
// stretches open into a real gaping mouth (and on variants whose painted mouth is elsewhere, the
// face splits open where there was no mouth at all).
//
// Face coordinates (fx, fy) are metres on the face surface: fx = model +X (the snatcher's right),
// fy = up, origin at the centre of the face (head equator, front).
import { clamp, smoothstep } from '../core/math.js';

export const HEAD = {
  center: [0, 2.045, -0.012], // ellipsoid centre, model space, rest pose
  rx: 0.08,
  ry: 0.15,
  rz: 0.102,
  segW: 40, // segments around
  rings: 28, // latitude bands (before the mouth seam is inserted)
  warp: 1.6, // slope of u at the front: >1 gives the face more columns (and texels)
  v0: 0.06, // v below this is reserved for body skin swatches
  seamHalfV: 0.009, // half-height of the mouth band in v
  seamGap: 0.0012, // geometric half-gap between the two seam rings (radians of latitude)
  jawHinge: [0, 1.985, 0.02],
};

// Swatches in the reserved bottom strip of every face texture (u, v, w, h).
export const SKIN_SWATCH = { x: 0.02, y: 0.012, w: 0.4, h: 0.03 };
export const FINGER_SWATCH = { x: 0.5, y: 0.012, w: 0.48, h: 0.03 };

// Around-the-head angle (0 = front, +PI/-PI = back) <-> texture u. Quadratic warp: slope `warp`
// at the front, 2 - warp at the back seam (finite everywhere, so local drawing frames stay sane).
export function angleToU(a) {
  const t = clamp(Math.abs(a) / Math.PI, 0, 1);
  const k = HEAD.warp;
  return 0.5 + 0.5 * Math.sign(a) * t * (k - (k - 1) * t);
}

export function uToAngle(u) {
  const f = clamp(Math.abs(2 * u - 1), 0, 1);
  const k = HEAD.warp;
  const t = (k - Math.sqrt(k * k - 4 * (k - 1) * f)) / (2 * (k - 1));
  return Math.PI * Math.sign(2 * u - 1) * t;
}

// Face variants. Eyes: {fx, fy, w, h (half sizes, m), rot, drip (m), depth 0..1}.
// seam: the jaw split (fy, half-width in radians around the head, lips: painted strength 0..1).
// mouth2: an extra painted mouth {fx, fy, len, open, rot, curve, teeth}.
export const FACE_VARIANTS = [
  {
    name: 'wide',
    tone: [176, 171, 163],
    faceRot: 0.03,
    eyes: [
      { fx: 0.05, fy: 0.016, w: 0.021, h: 0.027, rot: 0.25, drip: 0.065, depth: 1 },
      { fx: -0.054, fy: 0.006, w: 0.022, h: 0.025, rot: -0.15, drip: 0.085, depth: 1 },
    ],
    seam: { fy: -0.066, half: 1.22, lips: 1, teeth: 1 },
    drool: 1,
    nose: 'slits',
    veins: 0.8,
    hair: 0.55,
    creases: 1,
  },
  {
    name: 'slipped',
    tone: [170, 168, 160],
    faceRot: 0.2,
    eyes: [
      { fx: 0.033, fy: 0.044, w: 0.016, h: 0.021, rot: 0.1, drip: 0.035, depth: 0.9 },
      { fx: -0.036, fy: -0.014, w: 0.023, h: 0.03, rot: -0.3, drip: 0.09, depth: 1 },
    ],
    seam: { fy: -0.08, half: 0.62, lips: 0.25, teeth: 1 },
    drool: 0.5,
    mouth2: { fx: 0.02, fy: -0.052, len: 0.074, open: 0.005, rot: 1.42, curve: 0.12, teeth: 1 },
    nose: 'none',
    veins: 0.6,
    hair: 0.9,
    creases: 0.5,
  },
  {
    name: 'doubled',
    tone: [180, 174, 165],
    faceRot: -0.06,
    eyes: [
      { fx: 0.04, fy: 0.03, w: 0.014, h: 0.016, rot: 0, drip: 0.03, depth: 0.9 },
      { fx: -0.038, fy: 0.026, w: 0.015, h: 0.015, rot: 0, drip: 0.05, depth: 0.9 },
    ],
    seam: { fy: -0.07, half: 0.78, lips: 0.9, teeth: 1 },
    drool: 0.6,
    mouth2: { fx: -0.004, fy: 0.088, len: 0.07, open: 0.006, rot: 0.1, curve: -0.22, teeth: 1 },
    nose: 'slits',
    veins: 1,
    hair: 0.35,
    creases: 0.7,
  },
  {
    name: 'wax',
    tone: [188, 183, 172],
    faceRot: 0.0,
    eyes: [
      { fx: 0.056, fy: 0.02, w: 0.011, h: 0.015, rot: 0.2, drip: 0.015, depth: 1.4 },
      { fx: -0.049, fy: 0.026, w: 0.01, h: 0.013, rot: -0.1, drip: 0.0, depth: 1.4 },
    ],
    seam: { fy: -0.058, half: 1.38, lips: 0.12, teeth: 1 },
    nose: 'none',
    veins: 0.35,
    hair: 0,
    creases: 0,
    wax: 1,
  },
  {
    name: 'inverted',
    tone: [172, 166, 160],
    faceRot: Math.PI - 0.12,
    eyes: [
      { fx: 0.036, fy: 0.074, w: 0.018, h: 0.022, rot: 0.1, drip: -0.04, depth: 1 },
      { fx: -0.035, fy: 0.07, w: 0.018, h: 0.023, rot: -0.1, drip: -0.035, depth: 1 },
    ],
    seam: { fy: 0.012, half: 0.7, lips: 0.2, teeth: 1 },
    mouth2: { fx: 0.0, fy: -0.07, len: 0.08, open: 0.007, rot: 0, curve: 0.18, teeth: 1 },
    nose: 'slits',
    veins: 0.7,
    hair: 0.75,
    creases: 0.6,
  },
];

// Any seed -> non-negative integer. Numbers are floored; other values (e.g. spawn ids such as
// 'z1-patrol') are hashed (FNV-1a) so distinct ids still get distinct faces and heights.
export function seedToInt(seed) {
  const n = typeof seed === 'number' ? seed : typeof seed === 'string' && seed.trim() !== '' ? Number(seed) : NaN;
  if (Number.isFinite(n)) return Math.abs(Math.floor(n)) % 2147483647;
  if (seed === undefined || seed === null) return 0;
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483647;
}

// Sequential seeds cycle through every face.
export function variantForSeed(seed) {
  return seedToInt(seed) % FACE_VARIANTS.length;
}

// Rotates face coordinates by the variant's feature rotation (features slid round the face).
export function faceToAngles(fx, fy, variant, out = { a: 0, th: 0 }) {
  const r = variant.faceRot || 0;
  const c = Math.cos(r), s = Math.sin(r);
  const x = fx * c - fy * s;
  const y = fx * s + fy * c;
  out.a = x / HEAD.rx;
  out.th = Math.PI / 2 - y / HEAD.ry;
  return out;
}

// Ring layout (latitudes + v) for a variant, including the inserted mouth seam rings.
export function headLayout(variant) {
  const n = HEAD.rings;
  const linV = (th) => HEAD.v0 + (1 - HEAD.v0) * (1 - th / Math.PI);
  // The seam is horizontal in head space (it is a hinge), so it ignores faceRot.
  const th0 = Math.PI / 2 - variant.seam.fy / HEAD.ry;
  const k = clamp(Math.floor((th0 / Math.PI) * n), 2, n - 3);
  const thSeam = ((k + 0.5) / n) * Math.PI;
  const rings = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * Math.PI;
    rings.push({ th, v: linV(th), seam: 0 });
    if (i === k) {
      const vm = linV(thSeam);
      rings.push({ th: thSeam - HEAD.seamGap, v: vm + HEAD.seamHalfV, seam: 1 });
      rings.push({ th: thSeam + HEAD.seamGap, v: vm - HEAD.seamHalfV, seam: 2 });
    }
  }
  const thetaToV = (th) => {
    if (th <= 0) return rings[0].v;
    for (let i = 1; i < rings.length; i++) {
      const r0 = rings[i - 1], r1 = rings[i];
      if (th <= r1.th) return r0.v + ((r1.v - r0.v) * (th - r0.th)) / Math.max(1e-6, r1.th - r0.th);
    }
    return rings[rings.length - 1].v;
  };
  const vm = linV(thSeam);
  return { rings, thetaToV, seam: { th: thSeam, vUp: vm + HEAD.seamHalfV, vLow: vm - HEAD.seamHalfV } };
}

const gauss = (d2) => Math.exp(-d2);

// Surface point of the head for angle a (around) and latitude th, at rest, model space.
function headPoint(a, th, variant, layout, out) {
  const sa = Math.sin(a), ca = Math.cos(a), st = Math.sin(th), ct = Math.cos(th);
  let x = st * sa, y = ct, z = -st * ca;
  // Long cranium swelling up and back.
  if (z > 0) z *= 1 + 0.14 * smoothstep(-0.3, 0.85, y);
  if (y > 0) y *= 1.05;
  // Narrow, long chin and jaw.
  if (y < -0.3) {
    const k = smoothstep(-0.3, -0.98, y);
    x *= 1 - 0.36 * k;
    y *= 1 + 0.1 * k;
    if (z < 0) z *= 1 + 0.06 * k;
  }
  if (z < 0) z *= 0.93; // flat face
  // Pinched temples.
  x *= 1 - 0.07 * smoothstep(0.15, 0.55, y) * (1 - smoothstep(0.55, 0.95, y));
  // Radial (horizontal) relief: cheek hollows, cheekbones, brow, sockets, mouth groove.
  let r = 1;
  const front = smoothstep(-0.2, -0.75, -ca); // 1 at the front, 0 at the back
  for (const sgn of [-1, 1]) {
    const da = a - sgn * 0.8, dt = th - 1.95;
    r -= 0.12 * gauss((da * da) / 0.07 + (dt * dt) / 0.05) * front;
    const ba = a - sgn * 0.72, bt = th - 1.66;
    r += 0.05 * gauss((ba * ba) / 0.035 + (bt * bt) / 0.012) * front;
  }
  const browT = th - 1.3;
  r += 0.035 * gauss((browT * browT) / 0.012) * gauss((a * a) / 0.3);
  const ang = { a: 0, th: 0 };
  for (const e of variant.eyes) {
    faceToAngles(e.fx, e.fy, variant, ang);
    const sa2 = Math.pow((e.w / HEAD.rx) * 1.35, 2), st2 = Math.pow((e.h / HEAD.ry) * 1.35, 2);
    const da = a - ang.a, dt = th - ang.th;
    r -= 0.13 * (e.depth ?? 1) * gauss((da * da) / sa2 + (dt * dt) / st2);
  }
  if (variant.nose === 'none') r -= 0.02 * gauss((a * a) / 0.04 + Math.pow(th - 1.74, 2) / 0.02);
  else r += 0.025 * gauss((a * a) / 0.006 + Math.pow(th - 1.72, 2) / 0.012);
  const seamA = Math.abs(a) / variant.seam.half;
  if (seamA < 1.3) r -= 0.025 * (1 - smoothstep(0.8, 1.3, seamA)) * gauss(Math.pow(th - layout.seam.th, 2) / 0.004);
  if (variant.wax) r += 0.02 * gauss((a * a) / 0.2 + Math.pow(th - 1.2, 2) / 0.05);
  const c = HEAD.center;
  out[0] = c[0] + HEAD.rx * x * r;
  out[1] = c[1] + HEAD.ry * y;
  out[2] = c[2] + HEAD.rz * z * r;
  return out;
}

// Skin weights for a head vertex: [[boneName, w], ...]. Lower face -> jaw, upper face -> 'face'
// (a bone that lets the features slide over the skull), the rest -> head.
function headWeights(a, th, ringSeam, layout, variant) {
  const absA = Math.abs(a);
  const jawSpan = Math.max(variant.seam.half, 0.95) + 0.2;
  const jawAng = 1 - smoothstep(jawSpan, jawSpan + 0.55, absA);
  let jaw = 0;
  if (ringSeam === 2 || (ringSeam === 0 && th > layout.seam.th)) {
    jaw = jawAng * (1 - smoothstep(0.84 * Math.PI, 0.97 * Math.PI, th));
  }
  let face = 0;
  if (ringSeam === 1 || (ringSeam === 0 && th < layout.seam.th)) {
    face = (1 - smoothstep(0.85, 1.35, absA)) * smoothstep(0.62, 1.0, th);
  }
  const head = Math.max(0, 1 - jaw - face);
  const w = [['head', head]];
  if (jaw > 0.001) w.push(['jaw', jaw]);
  if (face > 0.001) w.push(['face', face]);
  return w;
}

// Builds the head surface for a variant: {positions, uvs, indices, weights, normals}.
export function buildHeadData(variant) {
  const layout = headLayout(variant);
  const cols = HEAD.segW + 1;
  const rows = layout.rings.length;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const weights = new Array(cols * rows);
  const p = [0, 0, 0];
  for (let r = 0; r < rows; r++) {
    const ring = layout.rings[r];
    for (let i = 0; i < cols; i++) {
      const u = i / HEAD.segW;
      const a = uToAngle(u);
      headPoint(a, ring.th, variant, layout, p);
      const k = r * cols + i;
      positions.set(p, k * 3);
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = ring.v;
      weights[k] = headWeights(a, ring.th, ring.seam, layout, variant);
    }
  }
  const indices = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let i = 0; i < HEAD.segW; i++) {
      const a = r * cols + i, b = (r + 1) * cols + i, c = (r + 1) * cols + i + 1, d = r * cols + i + 1;
      indices.push(a, d, b, b, d, c);
    }
  }
  return { positions, uvs, indices, weights, cols, rows, layout };
}
