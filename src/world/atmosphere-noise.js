import * as THREE from 'three';
import { makeRng } from '../core/math.js';

// Tileable 3D fbm value noise baked once into an R8 Data3DTexture. Shared by the sky clouds,
// the volumetric mist and the mist wisps: one hardware-filtered fetch per octave instead of
// evaluating procedural noise per pixel.
let shared = null;

export function getNoiseTexture(size = 64) {
  if (shared) return shared;
  const n = size * size * size;
  const acc = new Float32Array(n);
  const rng = makeRng(0x6d15);
  const periods = [4, 8, 16, 32];
  const weights = [0.5, 0.27, 0.15, 0.08];

  for (let o = 0; o < periods.length; o++) {
    const P = periods[o];
    const lattice = new Float32Array(P * P * P);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
    // Per-axis lattice indices and smooth weights (the noise is separable in its indexing).
    const i0 = new Int32Array(size), i1 = new Int32Array(size), wt = new Float32Array(size);
    for (let x = 0; x < size; x++) {
      const f = (x * P) / size;
      const a = Math.floor(f);
      const t = f - a;
      i0[x] = a % P;
      i1[x] = (a + 1) % P;
      wt[x] = t * t * t * (t * (t * 6 - 15) + 10);
    }
    const w = weights[o];
    let idx = 0;
    for (let z = 0; z < size; z++) {
      const z0 = i0[z] * P * P, z1 = i1[z] * P * P, tz = wt[z];
      for (let y = 0; y < size; y++) {
        const y0 = i0[y] * P, y1 = i1[y] * P, ty = wt[y];
        const a00 = z0 + y0, a10 = z0 + y1, a01 = z1 + y0, a11 = z1 + y1;
        for (let x = 0; x < size; x++, idx++) {
          const x0 = i0[x], x1 = i1[x], tx = wt[x];
          const c00 = lattice[a00 + x0] + (lattice[a00 + x1] - lattice[a00 + x0]) * tx;
          const c10 = lattice[a10 + x0] + (lattice[a10 + x1] - lattice[a10 + x0]) * tx;
          const c01 = lattice[a01 + x0] + (lattice[a01 + x1] - lattice[a01 + x0]) * tx;
          const c11 = lattice[a11 + x0] + (lattice[a11 + x1] - lattice[a11 + x0]) * tx;
          const c0 = c00 + (c10 - c00) * ty;
          const c1 = c01 + (c11 - c01) * ty;
          acc[idx] += (c0 + (c1 - c0) * tz) * w;
        }
      }
    }
  }

  // fbm piles up around the middle; stretch to the full 0..1 range so shaders can threshold it.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (acc[i] < lo) lo = acc[i];
    if (acc[i] > hi) hi = acc[i];
  }
  const data = new Uint8Array(n);
  const k = 255 / (hi - lo || 1);
  for (let i = 0; i < n; i++) data[i] = (acc[i] - lo) * k;

  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  shared = tex;
  return tex;
}
