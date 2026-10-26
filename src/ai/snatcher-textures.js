// Procedural canvas textures for the snatchers: one face (+ glow) texture per face variant, and a
// single shared tattered-cloth texture. Painted once, cached by snatcher-rig.js.
import * as THREE from 'three';
import { makeRng, clamp, lerp, smoothstep } from '../core/math.js';
import { HEAD, FINGER_SWATCH, angleToU, uToAngle, faceToAngles } from './snatcher-head.js';

export const FACE_SIZE = 1024;
export const GLOW_SIZE = 256;
export const CLOTH_SIZE = 512;

// Cloth texture regions (u ranges). The cape gets tatters and holes, the rest is solid fabric.
export const CLOTH_CAPE = { u0: 0.02, u1: 0.72 };
export const CLOTH_SOLID = { x: 0.78, y: 0.04, w: 0.2, h: 0.92 };

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// CPU-rasterised 2D context: these canvases are painted once and read back, and a GPU-backed
// canvas would stall on that readback (seconds under software GL).
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

const rgba = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

// Maps face metres to canvas pixels for a variant, with local affine frames for drawing shapes
// in metres (x = face right, y = up).
class FacePainter {
  constructor(ctx, size, variant, layout) {
    this.g = ctx;
    this.S = size;
    this.variant = variant;
    this.layout = layout;
    this._ang = { a: 0, th: 0 };
  }

  px(fx, fy, out = [0, 0]) {
    const ang = faceToAngles(fx, fy, this.variant, this._ang);
    out[0] = angleToU(ang.a) * this.S;
    out[1] = (1 - this.layout.thetaToV(ang.th)) * this.S;
    return out;
  }

  // Same, but in un-rotated head space (for things bound to the skull, not the features).
  pxHead(fx, fy, out = [0, 0]) {
    out[0] = angleToU(fx / HEAD.rx) * this.S;
    out[1] = (1 - this.layout.thetaToV(Math.PI / 2 - fy / HEAD.ry)) * this.S;
    return out;
  }

  frame(fx, fy, rot = 0, head = false) {
    const e = 0.002;
    const f = head ? this.pxHead.bind(this) : this.px.bind(this);
    const p = f(fx, fy), qx = f(fx + e, fy), qy = f(fx, fy + e);
    let ax = (qx[0] - p[0]) / e, ay = (qx[1] - p[1]) / e;
    let bx = (qy[0] - p[0]) / e, by = (qy[1] - p[1]) / e;
    if (rot) {
      const c = Math.cos(rot), s = Math.sin(rot);
      const nax = ax * c + bx * s, nay = ay * c + by * s;
      const nbx = -ax * s + bx * c, nby = -ay * s + by * c;
      ax = nax; ay = nay; bx = nbx; by = nby;
    }
    this.g.setTransform(ax, ay, bx, by, p[0], p[1]);
  }

  reset() {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Polyline through face (or head) metres, mapped point by point - for long, wide strokes.
  path(points, head = false) {
    const g = this.g;
    const q = [0, 0];
    g.beginPath();
    points.forEach(([x, y], i) => {
      if (head) this.pxHead(x, y, q);
      else this.px(x, y, q);
      if (i) g.lineTo(q[0], q[1]);
      else g.moveTo(q[0], q[1]);
    });
  }

  // Canvas pixels per metre around a head-space point (for line widths).
  pxPerM(fx = 0, fy = 0) {
    const a = this.pxHead(fx, fy), b = this.pxHead(fx + 0.002, fy);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.002;
  }

  blob(fx, fy, rx, ry, inner, outer, rot = 0, head = false) {
    const g = this.g;
    this.frame(fx, fy, rot, head);
    g.scale(1, ry / rx);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, rx, 0, Math.PI * 2);
    g.fill();
    this.reset();
  }
}

// Wandering, branching dark veins (drawn in face metres).
function veins(p, rng, x, y, dir, len, width, depth, color) {
  const g = p.g;
  let cx = x, cy = y, d = dir;
  const steps = Math.max(3, Math.round(len / 0.004));
  for (let i = 0; i < steps; i++) {
    const nx = cx + Math.cos(d) * 0.004, ny = cy + Math.sin(d) * 0.004;
    const w = width * (1 - (i / steps) * 0.7);
    p.frame(cx, cy, 0, true);
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(nx - cx, ny - cy);
    g.stroke();
    p.reset();
    cx = nx;
    cy = ny;
    d += (rng() - 0.5) * 0.8;
    if (depth > 0 && rng() < 0.09) veins(p, rng, cx, cy, d + (rng() < 0.5 ? -1 : 1) * rng.range(0.5, 1.1), len * 0.5, w * 0.7, depth - 1, color);
  }
}

// A painted mouth (not the jaw seam): dark slit, lips, teeth. Drawn in a rotated face frame.
function paintedMouth(p, rng, m, tone) {
  const g = p.g;
  const L = m.len / 2;
  const curve = m.curve * m.len;
  const open = m.open;
  p.frame(m.fx, m.fy, m.rot);
  // Lips: bruised grey-purple, slightly swollen.
  g.fillStyle = rgba(tone[0] * 0.62, tone[1] * 0.5, tone[2] * 0.56, 0.75);
  g.beginPath();
  g.moveTo(-L - 0.004, 0);
  g.quadraticCurveTo(0, curve + open + 0.009, L + 0.004, 0);
  g.quadraticCurveTo(0, curve - open - 0.01, -L - 0.004, 0);
  g.fill();
  // Interior.
  g.fillStyle = '#060103';
  g.beginPath();
  g.moveTo(-L, 0);
  g.quadraticCurveTo(0, curve + open, L, 0);
  g.quadraticCurveTo(0, curve - open, -L, 0);
  g.fill();
  // Teeth: too many, too small, crowded along both edges.
  if (m.teeth) {
    const n = Math.round(m.len / 0.0042);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = -L + t * 2 * L;
      const b = 2 * t * (1 - t);
      const yMid = b * curve;
      const lift = b * open;
      if (rng() < 0.12) continue;
      const tw = 0.0016 + rng() * 0.0012;
      const th = lift * (0.6 + rng() * 0.5);
      const shade = 150 + rng() * 50;
      g.fillStyle = rgba(shade, shade * 0.93, shade * 0.74, 0.95);
      g.fillRect(x - tw / 2, yMid + lift - th, tw, th);
      g.fillStyle = rgba(shade * 0.9, shade * 0.85, shade * 0.68, 0.9);
      g.fillRect(x - tw / 2 + 0.0002, yMid - lift, tw * 0.9, th * 0.9);
    }
  }
  // Creases fanning out from the corners.
  g.strokeStyle = 'rgba(40,28,32,0.35)';
  g.lineWidth = 0.0008;
  for (const sgn of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      g.moveTo(sgn * (L + 0.002), 0);
      g.quadraticCurveTo(sgn * (L + 0.008), (k - 1.5) * 0.004, sgn * (L + 0.014 + rng() * 0.01), (k - 1.5) * 0.009);
      g.stroke();
    }
  }
  p.reset();
}

function paintEye(p, rng, e, tone) {
  const g = p.g;
  // Bruised socket.
  p.blob(e.fx, e.fy - 0.004, e.w * 2.6, e.h * 2.2, rgba(70, 48, 62, 0.5), rgba(70, 48, 62, 0), e.rot);
  // The hollow: overlapping jittered dark smudges.
  for (let k = 0; k < 9; k++) {
    const jx = (rng() - 0.5) * e.w * 0.5, jy = (rng() - 0.5) * e.h * 0.5;
    p.blob(e.fx + jx, e.fy + jy, e.w * (0.9 + rng() * 0.45), e.h * (0.9 + rng() * 0.4), 'rgba(2,0,1,0.92)', 'rgba(14,5,8,0)', e.rot + (rng() - 0.5) * 0.6);
  }
  p.blob(e.fx, e.fy, e.w * 0.78, e.h * 0.82, 'rgba(0,0,0,1)', 'rgba(0,0,0,0.85)', e.rot);
  // Smeared drips (or upward smears on the inverted face).
  const dir = e.drip >= 0 ? -1 : 1;
  const dripLen = Math.abs(e.drip);
  const n = dripLen > 0 ? 3 + Math.floor(rng() * 3) : 0;
  for (let k = 0; k < n; k++) {
    const len = dripLen * (0.4 + rng() * 0.8);
    let x = e.fx + (rng() - 0.5) * e.w * 1.2;
    let w = e.w * (0.25 + rng() * 0.35);
    const steps = 26;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const y = e.fy + dir * (e.h * 0.4 + t * len);
      x += (rng() - 0.5) * 0.0012;
      p.frame(x, y);
      g.fillStyle = rgba(4, 1, 2, 0.55 * (1 - t * 0.8));
      g.beginPath();
      g.arc(0, 0, w * (1 - t * 0.75), 0, Math.PI * 2);
      g.fill();
      p.reset();
    }
  }
  // Pale overhang on the upper rim, then a deep red pinprick slightly off-centre.
  p.frame(e.fx, e.fy, e.rot);
  g.strokeStyle = rgba(tone[0] * 1.2, tone[1] * 1.18, tone[2] * 1.15, 0.22);
  g.lineWidth = 0.0025;
  g.beginPath();
  g.ellipse(0, 0.002, e.w * 1.15, e.h * 1.1, 0, Math.PI * 0.15, Math.PI * 0.85);
  g.stroke();
  g.fillStyle = 'rgba(70,6,4,0.95)';
  g.beginPath();
  g.ellipse(e.w * 0.18, -e.h * 0.1, e.w * 0.16, e.h * 0.12, 0, 0, Math.PI * 2);
  g.fill();
  p.reset();
}

// The jaw seam: a black band (stretches open with the jaw) holding two rows of teeth.
function paintSeam(p, rng, variant, tone) {
  const g = p.g;
  const S = p.S;
  const { vUp, vLow } = p.layout.seam;
  const yTop = (1 - vUp) * S, yBot = (1 - vLow) * S;
  const half = variant.seam.half;
  const x0 = angleToU(-half) * S, x1 = angleToU(half) * S;
  const bh = yBot - yTop;
  const cols = 64;
  // Lips hugging the band: thin, bruised, cracked; the corners pull down into creases.
  const lips = variant.seam.lips;
  const lipPx = (0.0055 * S * (1 - HEAD.v0)) / (Math.PI * HEAD.ry);
  if (lips > 0) {
    for (const side of [-1, 1]) {
      const edge = side < 0 ? yTop : yBot;
      g.beginPath();
      for (let i = 0; i <= cols; i++) {
        const t = i / cols;
        const taper = Math.pow(1 - Math.abs(2 * t - 1), 0.6);
        g.lineTo(lerp(x0, x1, t), edge + side * lipPx * taper * (0.8 + 0.4 * Math.sin(t * 9 + side)));
      }
      for (let i = cols; i >= 0; i--) g.lineTo(lerp(x0, x1, i / cols), edge);
      g.closePath();
      g.fillStyle = rgba(tone[0] * 0.55, tone[1] * 0.42, tone[2] * 0.5, 0.75 * lips);
      g.fill();
    }
    g.strokeStyle = `rgba(30,16,22,${0.5 * lips})`;
    g.lineWidth = 1;
    for (let i = 0; i < 70 * lips; i++) {
      const x = lerp(x0, x1, 0.05 + rng() * 0.9);
      const side = rng() < 0.5 ? -1 : 1;
      const edge = side < 0 ? yTop : yBot;
      g.beginPath();
      g.moveTo(x, edge);
      g.lineTo(x + (rng() - 0.5) * 3, edge + side * lipPx * (0.4 + rng() * 0.6));
      g.stroke();
    }
  }
  // Band interior: black with a dark red throat in the middle.
  g.beginPath();
  for (let i = 0; i <= cols; i++) {
    const t = i / cols;
    const x = lerp(x0, x1, t);
    const taper = Math.pow(1 - Math.abs(2 * t - 1), 0.35);
    g.lineTo(x, yTop + bh * 0.5 * (1 - taper));
  }
  for (let i = cols; i >= 0; i--) {
    const t = i / cols;
    const x = lerp(x0, x1, t);
    const taper = Math.pow(1 - Math.abs(2 * t - 1), 0.35);
    g.lineTo(x, yBot - bh * 0.5 * (1 - taper));
  }
  g.closePath();
  const grad = g.createLinearGradient(0, yTop, 0, yBot);
  grad.addColorStop(0, '#020001');
  grad.addColorStop(0.5, '#1c0304');
  grad.addColorStop(1, '#020001');
  g.fillStyle = grad;
  g.fill();
  // Teeth: rows hanging from the top edge and rising from the bottom edge.
  if (variant.seam.teeth) {
    const cx = (x0 + x1) / 2, hw = (x1 - x0) / 2;
    for (const row of [0, 1]) {
      let x = x0 + hw * 0.12;
      while (x < x1 - hw * 0.12) {
        const tw = 3 + rng() * 3.5;
        const edge = Math.pow(1 - Math.abs(x - cx) / hw, 0.5);
        if (rng() > 0.1) {
          const len = bh * (0.22 + rng() * 0.2) * edge;
          const shade = 140 + rng() * 60;
          g.fillStyle = rgba(shade, shade * 0.92, shade * 0.72, 1);
          if (row === 0) {
            g.beginPath();
            g.moveTo(x, yTop + bh * 0.5 * (1 - Math.pow(edge, 0.7)));
            g.lineTo(x + tw, yTop + bh * 0.5 * (1 - Math.pow(edge, 0.7)));
            g.lineTo(x + tw * 0.7, yTop + bh * 0.5 * (1 - Math.pow(edge, 0.7)) + len);
            g.lineTo(x + tw * 0.25, yTop + bh * 0.5 * (1 - Math.pow(edge, 0.7)) + len * 0.92);
            g.fill();
          } else {
            g.beginPath();
            g.moveTo(x, yBot - bh * 0.5 * (1 - Math.pow(edge, 0.7)));
            g.lineTo(x + tw, yBot - bh * 0.5 * (1 - Math.pow(edge, 0.7)));
            g.lineTo(x + tw * 0.75, yBot - bh * 0.5 * (1 - Math.pow(edge, 0.7)) - len * 0.9);
            g.lineTo(x + tw * 0.3, yBot - bh * 0.5 * (1 - Math.pow(edge, 0.7)) - len);
            g.fill();
          }
        }
        x += tw + 0.6 + rng() * 1.2;
      }
    }
  }
}

// Thin, lank, greasy hair: a receding hairline in front, longer at the nape, with bald patches.
function paintHair(p, rng, density) {
  if (!density) return;
  const g = p.g;
  const S = p.S;
  const hairline = (u) => {
    const a = Math.abs(uToAngle(u));
    const th = 0.6 + 1.15 * smoothstep(0.5, 2.6, a);
    return (1 - p.layout.thetaToV(th)) * S;
  };
  // Darkened scalp where the hair grows, soft at the hairline.
  for (let x = 0; x < S; x += 4) {
    const yh = hairline(x / S);
    const grad = g.createLinearGradient(0, 0, 0, yh);
    grad.addColorStop(0, 'rgba(38,32,32,0.55)');
    grad.addColorStop(0.8, 'rgba(38,32,32,0.4)');
    grad.addColorStop(1, 'rgba(38,32,32,0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 4, yh);
  }
  const bald = Array.from({ length: 3 }, () => [rng() * S, rng() * S * 0.25, 30 + rng() * 60]);
  const n = Math.round(1400 * density);
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const u = rng();
    let x = u * S;
    const yh = hairline(u);
    let y = rng() * yh * 0.75;
    if (bald.some(([bx, by, r]) => Math.hypot(x - bx, (y - by) * 0.6) < r)) continue;
    const len = (yh - y) * (0.6 + rng() * 0.7) + (rng() < 0.08 ? 40 + rng() * 80 : 0);
    const steps = Math.max(3, Math.round(len / 10));
    const drift = (rng() - 0.5) * 1.6;
    const v = 12 + rng() * 22;
    g.strokeStyle = rgba(v, v * 0.85, v * 0.82, 0.3 + rng() * 0.45);
    g.lineWidth = 0.6 + rng() * 1.3;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < steps; s++) {
      x += drift + (rng() - 0.5) * 1.2;
      y += len / steps;
      g.lineTo(x, y);
    }
    g.stroke();
  }
}

// Paints the colour texture for a face variant. Returns a canvas.
export function paintFace(variant, layout, seed) {
  const S = FACE_SIZE;
  const c = makeCanvas(S);
  const g = ctx2d(c);
  const rng = makeRng(seed);
  const p = new FacePainter(g, S, variant, layout);
  const tone = variant.tone;

  // Base: waxy grey, darker and greyer over the scalp and under the jaw.
  const base = g.createLinearGradient(0, 0, 0, S);
  base.addColorStop(0, rgba(tone[0] * 0.78, tone[1] * 0.77, tone[2] * 0.78));
  base.addColorStop(0.35, rgba(tone[0], tone[1], tone[2]));
  base.addColorStop(0.75, rgba(tone[0] * 0.93, tone[1] * 0.9, tone[2] * 0.9));
  base.addColorStop(1, rgba(tone[0] * 0.7, tone[1] * 0.66, tone[2] * 0.68));
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  // Back of the head darker.
  const side = g.createLinearGradient(0, 0, S, 0);
  side.addColorStop(0, 'rgba(30,24,26,0.45)');
  side.addColorStop(0.3, 'rgba(30,24,26,0)');
  side.addColorStop(0.7, 'rgba(30,24,26,0)');
  side.addColorStop(1, 'rgba(30,24,26,0.45)');
  g.fillStyle = side;
  g.fillRect(0, 0, S, S);

  // Mottling: livid patches.
  const blotchTones = [[120, 128, 110], [150, 120, 140], [190, 182, 160], [95, 80, 92], [170, 160, 150]];
  for (let i = 0; i < 260; i++) {
    const t = rng.pick(blotchTones);
    const x = rng() * S, y = rng() * S, r = 6 + rng() * 60;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(t[0], t[1], t[2], 0.05 + rng() * 0.07));
    grad.addColorStop(1, rgba(t[0], t[1], t[2], 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  paintHair(p, rng, variant.hair ?? 0.6);

  // Facial shading in head space: sunken cheeks, waxy highlights, dark under the brow.
  for (const sgn of [-1, 1]) {
    p.blob(sgn * 0.07, -0.062, 0.034, 0.05, 'rgba(45,32,40,0.38)', 'rgba(45,32,40,0)', 0, true);
    p.blob(sgn * 0.064, -0.012, 0.025, 0.012, rgba(235, 228, 215, 0.2), rgba(235, 228, 215, 0), 0, true);
    p.blob(sgn * 0.075, 0.06, 0.03, 0.04, 'rgba(60,45,60,0.25)', 'rgba(60,45,60,0)', 0, true);
  }
  p.blob(0, 0.085, 0.07, 0.04, rgba(240, 234, 222, 0.18), rgba(240, 234, 222, 0), 0, true);
  p.blob(0, -0.135, 0.05, 0.03, 'rgba(40,28,34,0.3)', 'rgba(40,28,34,0)', 0, true);
  if (variant.wax) {
    // Melted, glossy smoothness with pale runs.
    for (let k = 0; k < 14; k++) {
      const x = (rng() - 0.5) * 0.14, y = 0.02 + rng() * 0.08;
      p.blob(x, y - 0.03, 0.006 + rng() * 0.006, 0.03 + rng() * 0.03, rgba(225, 220, 205, 0.25), rgba(225, 220, 205, 0), 0, true);
    }
  }

  // Veins: temples, around the sockets, down the jaw and neck.
  const veinColor = 'rgba(52,44,78,0.32)';
  const nVeins = Math.round(14 * variant.veins);
  for (let k = 0; k < nVeins; k++) {
    const sgn = rng() < 0.5 ? -1 : 1;
    const start = rng.pick([
      [0.075, 0.05], [0.06, -0.01], [0.04, 0.1], [0.05, -0.1], [0.085, -0.04], [0.02, 0.12],
    ]);
    veins(p, rng, sgn * start[0] + (rng() - 0.5) * 0.01, start[1] + (rng() - 0.5) * 0.02, rng() * Math.PI * 2, 0.03 + rng() * 0.05, 0.0013, 2, veinColor);
  }
  for (const e of variant.eyes) {
    for (let k = 0; k < Math.round(3 * variant.veins); k++) {
      veins(p, rng, e.fx + (rng() - 0.5) * e.w * 2, e.fy + (rng() - 0.5) * e.h * 2, rng() * Math.PI * 2, 0.02 + rng() * 0.03, 0.001, 1, 'rgba(70,30,50,0.3)');
    }
  }

  // Creases: under the eyes, across the brow.
  g.lineWidth = 1.2;
  for (let k = 0; k < Math.round(10 * variant.creases); k++) {
    const e = rng.pick(variant.eyes);
    p.frame(e.fx, e.fy - e.h * (1.4 + rng() * 0.8), e.rot);
    g.strokeStyle = 'rgba(50,38,44,0.28)';
    g.lineWidth = 0.0007;
    g.beginPath();
    g.moveTo(-e.w * 1.3, 0.002);
    g.quadraticCurveTo(0, -0.004 - rng() * 0.003, e.w * 1.3, 0.002);
    g.stroke();
    p.reset();
  }
  const ppm = p.pxPerM();
  for (let k = 0; k < Math.round(4 * variant.creases); k++) {
    const x0 = -0.03 - rng() * 0.02, x1 = 0.03 + rng() * 0.02, y0 = 0.065 + k * 0.01, bend = 0.002 + rng() * 0.003;
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push([lerp(x0, x1, t), y0 + bend * 4 * t * (1 - t) + (rng() - 0.5) * 0.0008]);
    }
    p.path(pts, true);
    g.strokeStyle = 'rgba(60,46,50,0.25)';
    g.lineWidth = 0.0008 * ppm;
    g.stroke();
  }
  // Black drool from the corners of the jaw seam.
  if (variant.drool) {
    const seamFy = (Math.PI / 2 - layout.seam.th) * HEAD.ry;
    for (const sgn of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const x = sgn * (variant.seam.half * HEAD.rx * (0.55 + 0.35 * rng()));
        const len = 0.02 + rng() * 0.05 * variant.drool;
        const pts = [];
        for (let i = 0; i <= 12; i++) pts.push([x + (rng() - 0.5) * 0.001, seamFy - (i / 12) * len]);
        p.path(pts, true);
        g.strokeStyle = 'rgba(8,2,4,0.7)';
        g.lineWidth = (0.0025 + rng() * 0.002) * ppm;
        g.lineCap = 'round';
        g.stroke();
      }
    }
  }

  // Nose: two thin slits, or nothing at all.
  if (variant.nose === 'slits') {
    for (const sgn of [-1, 1]) {
      p.frame(sgn * 0.0055, -0.034, sgn * 0.25);
      g.fillStyle = 'rgba(8,3,5,0.9)';
      g.beginPath();
      g.ellipse(0, 0, 0.0018, 0.0065, 0, 0, Math.PI * 2);
      g.fill();
      p.reset();
    }
  }

  // Seam mouth (opens with the jaw), painted mouths, eyes.
  paintSeam(p, rng, variant, tone);
  if (variant.mouth2) paintedMouth(p, rng, variant.mouth2, tone);
  for (const e of variant.eyes) paintEye(p, rng, e, tone);

  // Body swatches in the reserved strip: plain skin and a fingertip gradient (dark nails).
  g.fillStyle = rgba(tone[0] * 0.92, tone[1] * 0.9, tone[2] * 0.9);
  g.fillRect(0, (1 - HEAD.v0) * S, S, HEAD.v0 * S);
  const fs = FINGER_SWATCH;
  const fg = g.createLinearGradient(fs.x * S, 0, (fs.x + fs.w) * S, 0);
  fg.addColorStop(0, rgba(tone[0] * 0.92, tone[1] * 0.9, tone[2] * 0.9));
  fg.addColorStop(0.55, rgba(tone[0] * 0.8, tone[1] * 0.74, tone[2] * 0.8));
  fg.addColorStop(0.82, rgba(tone[0] * 0.55, tone[1] * 0.45, tone[2] * 0.55));
  fg.addColorStop(0.9, 'rgb(28,18,22)');
  fg.addColorStop(1, 'rgb(14,8,10)');
  g.fillStyle = fg;
  g.fillRect(fs.x * S - 4, (1 - fs.y - fs.h) * S - 4, fs.w * S + 8, fs.h * S + 8);

  // Pores and grain.
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let n = (rng() - 0.5) * 14;
    if (rng() < 0.012) n -= 22;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n * 1.05, 0, 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Emissive map: the face is a faint pale smear in total darkness, the eye hollows hold embers.
// The skin material multiplies this by SKIN_GLOW (snatcher-rig.js), so the embers run hot enough
// to bloom into two red points at 20-30 m while the face smear stays faint.
export function paintGlow(variant, layout) {
  const S = GLOW_SIZE;
  const c = makeCanvas(S);
  const g = ctx2d(c);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const p = new FacePainter(g, S, variant, layout);
  p.blob(0, 0.005, 0.11, 0.15, 'rgba(54,51,48,1)', 'rgba(54,51,48,0)', 0, true);
  for (const e of variant.eyes) {
    p.blob(e.fx, e.fy, e.w * 1.4, e.h * 1.4, 'rgba(80,9,4,0.85)', 'rgba(60,6,3,0)', e.rot);
    p.blob(e.fx + e.w * 0.18 * Math.cos(e.rot), e.fy - e.h * 0.1, e.w * 0.26, e.w * 0.24, 'rgba(225,52,18,1)', 'rgba(150,18,6,0)', e.rot);
  }
  // Faint ember glow deep in the mouth band.
  const { vUp, vLow } = layout.seam;
  const half = variant.seam.half;
  g.fillStyle = 'rgba(48,5,2,0.9)';
  g.fillRect(angleToU(-half * 0.8) * S, (1 - vUp) * S + 1, (angleToU(half * 0.8) - angleToU(-half * 0.8)) * S, (vUp - vLow) * S - 2);
  return c;
}

// Shared cloth texture: near-black fabric with grime streaks, a tattered hem and moth holes on
// the cape region (alpha-tested), plain fabric elsewhere.
export function paintCloth(seed = 7) {
  const S = CLOTH_SIZE;
  const c = makeCanvas(S);
  const g = ctx2d(c);
  const rng = makeRng(seed);
  g.fillStyle = '#0d0a0b';
  g.fillRect(0, 0, S, S);
  // Vertical weave streaks and folds.
  for (let i = 0; i < 900; i++) {
    const x = rng() * S, y = rng() * S, len = 20 + rng() * 140;
    const light = rng() < 0.5;
    g.strokeStyle = light ? rgba(48, 30, 30, 0.12 + rng() * 0.1) : rgba(0, 0, 0, 0.25);
    g.lineWidth = 0.6 + rng() * 2.2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 6, y + len);
    g.stroke();
  }
  // Rust-red stains and grime.
  for (let i = 0; i < 70; i++) {
    const x = rng() * S, y = rng() * S, r = 8 + rng() * 50;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const red = rng() < 0.55;
    grad.addColorStop(0, red ? rgba(60, 14, 10, 0.25) : rgba(40, 34, 30, 0.18));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Worn, faintly lighter bottom of the cape (dust, ash).
  const dust = g.createLinearGradient(0, S * 0.7, 0, S);
  dust.addColorStop(0, 'rgba(70,52,46,0)');
  dust.addColorStop(1, 'rgba(70,52,46,0.22)');
  g.fillStyle = dust;
  g.fillRect(0, S * 0.7, S * CLOTH_CAPE.u1 + 6, S * 0.3);

  // Cut-outs on the cape region.
  g.globalCompositeOperation = 'destination-out';
  const x0 = CLOTH_CAPE.u0 * S - 6, x1 = CLOTH_CAPE.u1 * S + 6;
  // Ragged hem: jagged spikes cut up from the bottom edge.
  let x = x0;
  g.beginPath();
  g.moveTo(x0, S + 2);
  while (x < x1) {
    const w = 5 + rng() * 18;
    const depth = rng() < 0.18 ? 50 + rng() * 80 : 6 + rng() * 34;
    g.lineTo(x + w * (0.3 + rng() * 0.4), S - depth);
    x += w;
    g.lineTo(x, S - rng() * 6);
  }
  g.lineTo(x1, S + 2);
  g.closePath();
  g.fill();
  // Long vertical tears that split the hem into strips.
  for (let i = 0; i < 16; i++) {
    const tx = lerp(x0, x1, rng()), len = 40 + rng() * 120, w = 1.5 + rng() * 3;
    g.beginPath();
    g.moveTo(tx - w, S);
    g.lineTo(tx + (rng() - 0.5) * 6, S - len);
    g.lineTo(tx + w, S);
    g.fill();
  }
  // Moth holes and rips, denser towards the hem.
  for (let i = 0; i < 46; i++) {
    const hy = S * (0.25 + Math.pow(rng(), 0.6) * 0.7), hx = lerp(x0 + 10, x1 - 10, rng());
    const r = 1.5 + rng() * (hy / S) * 9;
    g.beginPath();
    g.ellipse(hx, hy, r * (0.6 + rng()), r * (1 + rng() * 1.5), rng() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  // Ragged front edges.
  for (const ex of [x0 + 4, x1 - 4]) {
    for (let y = S * 0.2; y < S; y += 8 + rng() * 22) {
      g.beginPath();
      g.ellipse(ex, y, 3 + rng() * 6, 2 + rng() * 5, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

export function canvasTexture(canvas, { srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
