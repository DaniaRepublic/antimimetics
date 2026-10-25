// Snatcher cape: rest layout (shared with the mesh builder) and a tiny per-instance cloth sim.
//
// The cape is skinned to a COLS x ROWS grid of bones. Row 0 is pinned to the chest (it sits on the
// shoulders); rows 1.. are verlet particles simulated in world space, so the cape trails behind a
// walking snatcher, swings when it turns, is pushed by its legs and billows during the call.
// Each frame the particles are written back into the grid bones (position + orientation from
// neighbouring particles), and the mesh follows by bilinear skinning.
import * as THREE from 'three';
import { lerp, smoothstep, noise1 } from '../core/math.js';

export const CAPE = {
  cols: 7,
  rows: 5,
  rowT: [0, 0.2, 0.45, 0.72, 1],
  topY: 1.73,
  hemY: 0.09,
  mantleT: -0.12, // the mesh starts this far above row 0 (the mantle from the collar to the shoulders)
};

// Half angle (measured from the back, +Z) the cape covers at parameter t. Over the shoulders it
// wraps forward to the collarbones; below the shoulders it falls behind the arms.
export function capeEdge(t) {
  if (t <= 0) return 2.2;
  return lerp(2.2, 1.38, smoothstep(0, 0.2, t)) + 0.32 * Math.pow(smoothstep(0.55, 1, t), 1.5);
}

// Rest position (model space) of the cape surface at u01 (0..1 across, left front edge -> right)
// and t (mantleT..1, top -> hem).
export function capePoint(u01, t, out) {
  if (t < 0) {
    const s = (t - CAPE.mantleT) / -CAPE.mantleT;
    const psi = 2.2 * (2 * u01 - 1);
    const top = capePoint(u01, 0, out);
    const tx = top[0], ty = top[1], tz = top[2];
    const bx = 0.14 * Math.sin(psi), bz = 0.115 * Math.cos(psi) + 0.005;
    out[0] = lerp(bx, tx, s);
    out[1] = lerp(1.7, ty, s) + 0.03 * Math.sin(Math.PI * s);
    out[2] = lerp(bz, tz, s);
    return out;
  }
  const psi = capeEdge(t) * (2 * u01 - 1);
  const k = Math.pow(t, 0.75);
  const rx = lerp(0.255, 0.45, k);
  const rz = lerp(0.16, 0.37, k);
  const fold = 1 + (0.1 * Math.sin(psi * 6 + 1.3) + 0.04 * Math.sin(psi * 13 + 0.4)) * smoothstep(0.08, 0.6, t);
  out[0] = rx * Math.sin(psi) * fold;
  out[1] = lerp(CAPE.topY, CAPE.hemY, t) - 0.025 * Math.pow(Math.cos(psi * 0.5), 2) * (1 - smoothstep(0, 0.1, t));
  out[2] = rz * Math.cos(psi) * fold + 0.02 * t;
  return out;
}

// Rest positions of the bone grid (C*R*3, row-major by row).
export function capeBoneRest() {
  const { cols, rows, rowT } = CAPE;
  const out = new Float32Array(cols * rows * 3);
  const p = [0, 0, 0];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      capePoint(i / (cols - 1), rowT[j], p);
      out.set(p, (j * cols + i) * 3);
    }
  }
  return out;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _v = new THREE.Vector3();

// Orientation frame of grid point k from its neighbours: +Y up along the cloth, +X across it.
function frameQuat(P, i, j, cols, rows, out) {
  const k = j * cols + i;
  const kd = j < rows - 1 ? k + cols : k;
  const ku = j < rows - 1 ? k : k - cols;
  _y.set(P[ku * 3] - P[kd * 3], P[ku * 3 + 1] - P[kd * 3 + 1], P[ku * 3 + 2] - P[kd * 3 + 2]);
  if (j === rows - 1) _y.set(P[(k - cols) * 3] - P[k * 3], P[(k - cols) * 3 + 1] - P[k * 3 + 1], P[(k - cols) * 3 + 2] - P[k * 3 + 2]);
  _y.normalize();
  const kl = j * cols + Math.max(0, i - 1), kr = j * cols + Math.min(cols - 1, i + 1);
  _x.set(P[kr * 3] - P[kl * 3], P[kr * 3 + 1] - P[kl * 3 + 1], P[kr * 3 + 2] - P[kl * 3 + 2]);
  _x.addScaledVector(_y, -_x.dot(_y));
  if (_x.lengthSq() < 1e-10) _x.set(1, 0, 0);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

export class CapeSim {
  constructor(rest) {
    const { cols, rows } = CAPE;
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.rest = rest; // model space
    this.pos = new Float32Array(this.n * 3); // world space
    this.prev = new Float32Array(this.n * 3);
    this.pin = new Float32Array(cols * 3);
    this.pinPrev = new Float32Array(cols * 3);
    this.model = new Float32Array(this.n * 3);
    this.ready = false;
    this.qRestInv = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) this.qRestInv.push(frameQuat(rest, i, j, cols, rows, new THREE.Quaternion()).invert());
    }
    // Constraint rest lengths (model space).
    const d = (a, b) => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
    this.links = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (j < rows - 1) this.links.push(k, k + cols, d(k, k + cols), 1);
        if (i < cols - 1) this.links.push(k, k + 1, d(k, k + 1), 0.5);
        if (i < cols - 1 && j < rows - 1) {
          this.links.push(k, k + cols + 1, d(k, k + cols + 1), 0.25);
          this.links.push(k + 1, k + cols, d(k + 1, k + cols), 0.25);
        }
      }
    }
    this.caps = new Float32Array(16 * 7);
    this.nCaps = 0;
  }

  // Places every particle at its rest pose under world matrix M.
  reset(M, pinnedModel) {
    for (let k = 0; k < this.n; k++) {
      _v.fromArray(this.rest, k * 3);
      if (k < this.cols) _v.fromArray(pinnedModel, k * 3);
      _v.applyMatrix4(M);
      _v.toArray(this.pos, k * 3);
      _v.toArray(this.prev, k * 3);
    }
    for (let i = 0; i < this.cols; i++) {
      this.pin[i * 3] = this.pinPrev[i * 3] = this.pos[i * 3];
      this.pin[i * 3 + 1] = this.pinPrev[i * 3 + 1] = this.pos[i * 3 + 1];
      this.pin[i * 3 + 2] = this.pinPrev[i * 3 + 2] = this.pos[i * 3 + 2];
    }
    this.ready = true;
  }

  // caps: model-space capsules [ax, ay, az, bx, by, bz, r] * count.
  step(dt, M, pinnedModel, capsModel, nCaps, opts) {
    if (!this.ready) this.reset(M, pinnedModel);
    if (dt <= 0) return;
    const { cols, n } = this;
    const P = this.pos, Q = this.prev;
    const e = M.elements;
    const scale = Math.hypot(e[0], e[1], e[2]);
    // Pinned row and colliders into world space.
    for (let i = 0; i < cols; i++) {
      this.pinPrev[i * 3] = this.pin[i * 3];
      this.pinPrev[i * 3 + 1] = this.pin[i * 3 + 1];
      this.pinPrev[i * 3 + 2] = this.pin[i * 3 + 2];
      _v.fromArray(pinnedModel, i * 3).applyMatrix4(M).toArray(this.pin, i * 3);
    }
    const C = this.caps;
    this.nCaps = nCaps;
    for (let c = 0; c < nCaps; c++) {
      _v.fromArray(capsModel, c * 7).applyMatrix4(M).toArray(C, c * 7);
      _v.fromArray(capsModel, c * 7 + 3).applyMatrix4(M).toArray(C, c * 7 + 3);
      C[c * 7 + 6] = capsModel[c * 7 + 6] * scale;
    }
    const ox = e[12], oy = e[13], oz = e[14];
    const { wind, billow = 0, time = 0, drag = 2.2 } = opts;
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = dt / steps;
    const h2 = h * h;
    const R = this.rest;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      for (let i = 0; i < cols; i++) {
        for (let a = 0; a < 3; a++) {
          const v = lerp(this.pinPrev[i * 3 + a], this.pin[i * 3 + a], f);
          P[i * 3 + a] = v;
          Q[i * 3 + a] = v;
        }
      }
      for (let k = cols; k < n; k++) {
        const i = k % cols, j = (k / cols) | 0;
        const kx = k * 3;
        const vx = (P[kx] - Q[kx]) * 0.99, vy = (P[kx + 1] - Q[kx + 1]) * 0.99, vz = (P[kx + 2] - Q[kx + 2]) * 0.99;
        // Air: ambient drift + billow (outward and up, gusting) against particle velocity.
        let wx = wind.x, wy = wind.y, wz = wind.z;
        const gust = noise1(time * 1.7 + i * 0.83 + j * 0.37, k) - 0.5;
        wx += gust * 0.9;
        wz += (noise1(time * 1.3 + i * 0.61, k + 7) - 0.5) * 0.9;
        if (billow > 0) {
          // Flapping updraught: waves run round the hem, lifting it and throwing it outward.
          const rx = P[kx] - ox, rz = P[kx + 2] - oz;
          const rl = Math.hypot(rx, rz) || 1;
          const flap = 0.5 + 0.5 * Math.sin(time * 3.4 - i * 1.3 + j * 0.5 + k * 0.17);
          const b = billow * (0.25 + 0.75 * flap) * (0.6 + 0.8 * noise1(time * 2.3 + i * 1.1, k + 3)) * (j / (this.rows - 1));
          wx += (rx / rl) * 2.6 * b;
          wz += (rz / rl) * 2.6 * b;
          wy += 9 * b;
        }
        let ax = drag * (wx - vx / h), ay = drag * (wy - vy / h) - 9.8, az = drag * (wz - vz / h);
        // Weak shape memory: hang the rest shape from the pinned top, upright in world space.
        const top = i * 3;
        _v.set(R[kx] - R[top], R[kx + 1] - R[top + 1], R[kx + 2] - R[top + 2]).transformDirection(M).multiplyScalar(
          Math.hypot(R[kx] - R[top], R[kx + 1] - R[top + 1], R[kx + 2] - R[top + 2]) * scale,
        );
        const ks = 7;
        ax += ks * (P[top] + _v.x - P[kx]);
        ay += ks * (P[top + 1] + _v.y - P[kx + 1]);
        az += ks * (P[top + 2] + _v.z - P[kx + 2]);
        Q[kx] = P[kx];
        Q[kx + 1] = P[kx + 1];
        Q[kx + 2] = P[kx + 2];
        P[kx] += vx + ax * h2;
        P[kx + 1] += vy + ay * h2;
        P[kx + 2] += vz + az * h2;
      }
      this.solve(scale, oy);
    }
    // Safety: if anything blew up or got stuck far away, snap back to rest.
    for (let k = cols; k < n; k++) {
      const kx = k * 3;
      const dx = P[kx] - ox, dz = P[kx + 2] - oz;
      if (!(dx * dx + dz * dz < 9) || !Number.isFinite(P[kx + 1])) {
        this.reset(M, pinnedModel);
        break;
      }
    }
  }

  solve(scale, groundY) {
    const P = this.pos;
    const L = this.links;
    const { cols, n } = this;
    const C = this.caps;
    for (let it = 0; it < 3; it++) {
      for (let l = 0; l < L.length; l += 4) {
        const a = L[l], b = L[l + 1];
        const rest = L[l + 2] * scale, stiff = L[l + 3];
        const ax = a * 3, bx = b * 3;
        const dx = P[bx] - P[ax], dy = P[bx + 1] - P[ax + 1], dz = P[bx + 2] - P[ax + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        // Cross links may bunch up (folds) but not stretch.
        if (stiff < 1 && d < rest && d > rest * 0.55) continue;
        const diff = ((d - rest) / d) * stiff;
        const wa = a < cols ? 0 : 1, wb = b < cols ? 0 : 1;
        const wsum = wa + wb;
        if (wsum === 0) continue;
        const ka = (wa / wsum) * diff, kb = (wb / wsum) * diff;
        P[ax] += dx * ka;
        P[ax + 1] += dy * ka;
        P[ax + 2] += dz * ka;
        P[bx] -= dx * kb;
        P[bx + 1] -= dy * kb;
        P[bx + 2] -= dz * kb;
      }
      // Body colliders.
      for (let k = cols; k < n; k++) {
        const kx = k * 3;
        for (let c = 0; c < this.nCaps; c++) {
          const o = c * 7;
          const sx = C[o + 3] - C[o], sy = C[o + 4] - C[o + 1], sz = C[o + 5] - C[o + 2];
          const px = P[kx] - C[o], py = P[kx + 1] - C[o + 1], pz = P[kx + 2] - C[o + 2];
          const ll = sx * sx + sy * sy + sz * sz;
          let t = ll > 0 ? (px * sx + py * sy + pz * sz) / ll : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = px - sx * t, qy = py - sy * t, qz = pz - sz * t;
          const d2 = qx * qx + qy * qy + qz * qz;
          const r = C[o + 6];
          if (d2 < r * r && d2 > 1e-10) {
            const d = Math.sqrt(d2);
            const push = (r - d) / d;
            P[kx] += qx * push;
            P[kx + 1] += qy * push;
            P[kx + 2] += qz * push;
          }
        }
        if (P[kx + 1] < groundY + 0.015) P[kx + 1] = groundY + 0.015;
      }
    }
  }

  // Writes the simulated grid into the cape bones (parented to the model-space root bone).
  apply(bones, first, Minv) {
    const { cols, rows, n } = this;
    const Pm = this.model;
    for (let k = 0; k < n; k++) _v.fromArray(this.pos, k * 3).applyMatrix4(Minv).toArray(Pm, k * 3);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const bone = bones[first + k];
        bone.position.fromArray(Pm, k * 3);
        frameQuat(Pm, i, j, cols, rows, _q);
        bone.quaternion.multiplyQuaternions(_q, this.qRestInv[k]);
      }
    }
  }
}
