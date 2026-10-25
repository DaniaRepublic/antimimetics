// Small math helpers shared by every module.
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));
export const smoothstep = (a, b, v) => {
  const t = clamp(invLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
};

// Frame-rate independent exponential smoothing: damp(current, target, lambda, dt).
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// Shortest signed difference between two angles (radians), result in [-PI, PI].
export function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const dampAngle = (a, b, lambda, dt) => a + angleDiff(a, b) * (1 - Math.exp(-lambda * dt));

// Rotate angle `a` towards `b` by at most `maxStep` radians.
export function stepAngle(a, b, maxStep) {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

// Yaw convention used everywhere: yaw = 0 faces -Z (three.js forward), positive yaw turns left (CCW seen from above).
// Forward vector for yaw: (-sin(yaw), 0, -cos(yaw)).
export const yawToDir = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
export const dirToYaw = (dx, dz) => Math.atan2(-dx, -dz);

export const dist2D = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);

// Deterministic PRNG (mulberry32). rng() -> [0, 1).
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rng());
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

// Cheap 1D value noise for flicker / sway, deterministic in t.
export function noise1(t, seed = 0) {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n) => {
    const x = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}
