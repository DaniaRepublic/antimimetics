import * as THREE from 'three';
import { makeRng } from '../core/math.js';

// Procedural CanvasTextures for the city: facades (with window-glow masks), storefronts, ground,
// signs, graffiti, decals, chain-link and a small red-sky reflection map. Everything is seeded so
// the city looks identical every load. Call createLevelTextures() once; results are cached.

export const FACADE_CELLS = 8; // window bays/floors per facade texture
export const BAY = 3.0; // metres per window bay
export const FLOOR = 3.2; // metres per floor

const FONT = '"Arial Black", "Helvetica Neue", Helvetica, Arial, sans-serif';
const STENCIL = '"Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif';

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d') };
}

function toTexture(c, { srgb = true, repeat = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

// --- noise tiles ------------------------------------------------------------------------------

// Seamless multi-octave value noise as a grayscale canvas (alpha = 1).
function fbmCanvas(size, seed, baseCells = 4, octaves = 5, contrast = 1) {
  const rng = makeRng(seed);
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const acc = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    const step = size / cells;
    for (let y = 0; y < size; y++) {
      const gy = y / step;
      const y0 = Math.floor(gy), fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      const r0 = (y0 % cells) * cells, r1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const gx = x / step;
        const x0 = Math.floor(gx), fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const c0 = x0 % cells, c1 = (x0 + 1) % cells;
        const a = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
        const b = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
        acc[y * size + x] += (a + (b - a) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < acc.length; i++) {
    let v = acc[i] / total;
    v = Math.min(1, Math.max(0, (v - 0.5) * contrast + 0.5));
    const b = v * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grainCanvas(size, seed) {
  const rng = makeRng(seed);
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 128 + (rng() - 0.5) * 255 * (rng() < 0.08 ? 1 : 0.45);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let NOISE = null;
function noiseTiles() {
  if (!NOISE) {
    NOISE = {
      blotch: fbmCanvas(256, 11, 3, 5, 1.6),
      fine: fbmCanvas(256, 23, 12, 3, 1.4),
      grain: grainCanvas(128, 37),
    };
  }
  return NOISE;
}

// Overlay a noise tile over a rect with a composite op ('multiply', 'overlay', 'soft-light', ...).
function overlay(ctx, tile, x, y, w, h, alpha, op = 'overlay', scale = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = op;
  const pat = ctx.createPattern(tile, 'repeat');
  if (scale !== 1) pat.setTransform(new DOMMatrix().scale(scale));
  ctx.fillStyle = pat;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// Random-walk crack line.
function crack(ctx, rng, x, y, len, width = 1.2, color = 'rgba(8,6,6,0.75)') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  let a = rng() * Math.PI * 2;
  for (let i = 0; i < len; i++) {
    a += (rng() - 0.5) * 1.1;
    x += Math.cos(a) * 6;
    y += Math.sin(a) * 6;
    ctx.lineTo(x, y);
    if (rng() < 0.12) {
      ctx.moveTo(x, y);
      const b = a + (rng() < 0.5 ? 1 : -1) * (0.6 + rng());
      let bx = x, by = y;
      for (let k = 0; k < 4; k++) {
        bx += Math.cos(b) * 5;
        by += Math.sin(b) * 5;
        ctx.lineTo(bx, by);
      }
      ctx.moveTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function stain(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// --- facades ----------------------------------------------------------------------------------

// The glow mask: a soft gradient inside the window (white = fully lit when the shader picks it).
function glowWindow(glow, x, y, w, h) {
  const g = glow.createRadialGradient(x + w / 2, y + h * 0.55, 2, x + w / 2, y + h * 0.55, Math.max(w, h) * 0.75);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#5a5a5a');
  glow.fillStyle = g;
  glow.fillRect(x, y, w, h);
}

// Window contents shared by every facade style. (x, y, w, h) in pixels. Writes the matching
// glow-mask silhouette (curtains and blinds dim the light) into `glow` for windows that can be lit.
function drawWindow(ctx, glow, rng, x, y, w, h, opts = {}) {
  const r = rng();
  const kind = r < 0.36 ? 'dark' : r < 0.55 ? 'curtain' : r < 0.67 ? 'blinds' : r < 0.82 ? 'broken' : r < 0.9 ? 'boarded' : 'void';
  // Glass base: faint red sky reflection at the top, nearly black lower down.
  const g = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  g.addColorStop(0, opts.glassTop || '#2e1714');
  g.addColorStop(0.45, '#110c0d');
  g.addColorStop(1, '#060607');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const canLight = kind === 'dark' || kind === 'curtain' || kind === 'blinds';
  if (canLight) glowWindow(glow, x + 2, y + 2, w - 4, h - 4);
  if (kind === 'curtain') {
    const hue = rng.pick([18, 30, 200, 350, 40]);
    const cw = w * (0.25 + rng() * 0.25);
    const both = rng() < 0.6;
    ctx.fillStyle = hsl(hue, 18, 22 + rng() * 10);
    ctx.fillRect(x, y, cw, h);
    if (both) ctx.fillRect(x + w - cw * 0.8, y, cw * 0.8, h);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + (cw / 4) * i + 2, y, 1.5, h);
    glow.fillStyle = 'rgba(0,0,0,0.65)';
    glow.fillRect(x, y, cw, h);
    if (both) glow.fillRect(x + w - cw * 0.8, y, cw * 0.8, h);
  } else if (kind === 'blinds') {
    const drop = h * (0.3 + rng() * 0.7);
    ctx.fillStyle = '#6e675f';
    for (let yy = y; yy < y + drop; yy += 4) ctx.fillRect(x, yy, w, 2.5);
    if (rng() < 0.5) {
      ctx.save();
      ctx.translate(x + w * 0.5, y + drop);
      ctx.rotate(0.25);
      ctx.fillRect(-w * 0.5, 0, w * 0.7, 2.5);
      ctx.restore();
    }
    glow.fillStyle = 'rgba(0,0,0,0.55)';
    for (let yy = y; yy < y + drop; yy += 4) glow.fillRect(x, yy, w, 2.5);
  } else if (kind === 'broken') {
    ctx.fillStyle = '#040404';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(120,110,115,0.35)';
    for (let i = 0; i < 5; i++) {
      const edge = rng.int(0, 3);
      const sx = edge === 0 ? x : edge === 1 ? x + w : x + rng() * w;
      const sy = edge === 2 ? y : edge === 3 ? y + h : y + rng() * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (rng() - 0.5) * w * 0.7, sy + (rng() - 0.5) * h * 0.6);
      ctx.lineTo(sx + (rng() - 0.5) * w * 0.3, sy + (rng() - 0.5) * h * 0.3);
      ctx.fill();
    }
  } else if (kind === 'boarded') {
    const n = 3 + rng.int(0, 2);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = hsl(30, 25, 22 + rng() * 12);
      const ph = h / n;
      ctx.save();
      ctx.translate(x + w / 2, y + ph * (i + 0.5));
      ctx.rotate((rng() - 0.5) * 0.15);
      ctx.fillRect(-w * 0.55, -ph * 0.45, w * 1.1, ph * 0.9);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(-w * 0.55, ph * 0.35, w * 1.1, ph * 0.1);
      ctx.restore();
    }
  } else if (kind === 'void') {
    ctx.fillStyle = '#020202';
    ctx.fillRect(x, y, w, h);
  }
  if (canLight && opts.mullions !== false) {
    ctx.fillStyle = opts.frame || '#1a1615';
    ctx.fillRect(x + w / 2 - 1.5, y, 3, h);
    ctx.fillRect(x, y + h * 0.42, w, 3);
    glow.fillStyle = '#000';
    glow.fillRect(x + w / 2 - 1.5, y, 3, h);
    glow.fillRect(x, y + h * 0.42, w, 3);
  }
  ctx.strokeStyle = opts.frame || '#1a1615';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  return canLight;
}

function facadeBase(style, seed) {
  const S = 1024, C = S / FACADE_CELLS;
  const rng = makeRng(seed);
  const { c, ctx } = canvas(S);
  const { c: gc, ctx: glow } = canvas(S);
  glow.fillStyle = '#000';
  glow.fillRect(0, 0, S, S);
  const N = noiseTiles();

  if (style === 'brick') {
    ctx.fillStyle = '#6d5a52';
    ctx.fillRect(0, 0, S, S);
    const bh = S / 256, bw = S / 80; // whole bricks per tile so the texture wraps seamlessly
    for (let row = 0; row < 256; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -off; x < S; x += bw) {
        const l = 40 + rng() * 13;
        ctx.fillStyle = hsl(12 + rng() * 10, 30 + rng() * 15, l);
        ctx.fillRect(x + 1, row * bh + 1, bw - 1, bh - 1);
      }
    }
  } else if (style === 'concrete') {
    ctx.fillStyle = '#8b867d';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < FACADE_CELLS; i++) {
      for (let j = 0; j < FACADE_CELLS; j++) {
        ctx.fillStyle = hsl(35, 6, 48 + rng() * 8);
        ctx.fillRect(i * C + 1, j * C + 1, C - 2, C - 2);
      }
    }
  } else {
    // stone / stucco
    ctx.fillStyle = '#9b9182';
    ctx.fillRect(0, 0, S, S);
    const bw = S / 26;
    for (let row = 0; row * 16 < S; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -off; x < S; x += bw) {
        ctx.fillStyle = hsl(32, 12, 50 + rng() * 9);
        ctx.fillRect(x + 1, row * 16 + 1, bw - 1, 15);
      }
    }
  }
  overlay(ctx, N.blotch, 0, 0, S, S, 0.55, 'overlay', 1.5);
  overlay(ctx, N.grain, 0, 0, S, S, 0.25, 'overlay');

  for (let j = 0; j < FACADE_CELLS; j++) {
    for (let i = 0; i < FACADE_CELLS; i++) {
      const cx = i * C, cy = j * C;
      let wx, wy, ww, wh;
      if (style === 'brick') {
        wx = cx + 36; wy = cy + 24; ww = 56; wh = 74;
        ctx.fillStyle = '#7d7268';
        ctx.fillRect(wx - 5, wy - 9, ww + 10, 9); // lintel
        ctx.fillStyle = '#857a70';
        ctx.fillRect(wx - 7, wy + wh, ww + 14, 6); // sill
      } else if (style === 'concrete') {
        wx = cx + 5; wy = cy + 34; ww = C - 10; wh = 58;
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(cx, cy + 30, C, 3);
      } else {
        wx = cx + 42; wy = cy + 18; ww = 44; wh = 84;
        ctx.fillStyle = '#b0a593';
        ctx.fillRect(cx, cy + C - 12, C, 9); // cornice band
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(cx, cy + C - 3, C, 3);
        ctx.fillStyle = '#a89c8a';
        ctx.fillRect(wx - 6, wy - 6, ww + 12, wh + 10);
        ctx.fillRect(wx + ww / 2 - 5, wy - 12, 10, 10); // keystone
      }
      // Grime streaks running down from the sill.
      const sg = ctx.createLinearGradient(0, wy + wh, 0, wy + wh + 30 + rng() * 40);
      sg.addColorStop(0, 'rgba(15,10,8,0.45)');
      sg.addColorStop(1, 'rgba(15,10,8,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(wx + 4 + rng() * 6, wy + wh, ww - 14, 70);
      if (style === 'concrete') {
        // Three panes per bay, each its own window.
        const pw = ww / 3;
        for (let k = 0; k < 3; k++) {
          drawWindow(ctx, glow, rng, wx + k * pw, wy, pw, wh, { glassTop: '#3a1d1a', frame: '#232323', mullions: false });
        }
      } else {
        drawWindow(ctx, glow, rng, wx, wy, ww, wh);
      }
    }
  }
  // Soot and weathering over everything, darker towards the top of each tile row.
  overlay(ctx, N.fine, 0, 0, S, S, 0.3, 'multiply', 2);
  for (let k = 0; k < 18; k++) {
    const x = rng() * S, w = 10 + rng() * 40;
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, 'rgba(10,8,8,0.0)');
    g.addColorStop(rng(), 'rgba(10,8,8,0.18)');
    g.addColorStop(1, 'rgba(10,8,8,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, w, S);
  }
  return { map: toTexture(c), glow: toTexture(gc) };
}

// --- storefronts --------------------------------------------------------------------------------

// Atlas of 8 ground-floor storefronts, 4 x 2 cells of 512 px, each mapped to 6 m x 4.4 m.
export const STOREFRONT = { cols: 4, rows: 2, width: 6, height: 4.4 };
export const STORE = { shutter: 0, smashed: 1, boarded: 2, halfShutter: 3, pharmacy: 4, laundry: 5, papered: 6, barred: 7 };

function signText(ctx, text, x, y, w, size, color, opts = {}) {
  ctx.save();
  ctx.font = `${opts.weight || 'bold'} ${size}px ${opts.font || FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  const metrics = ctx.measureText(text);
  const sx = Math.min(1, (w * 0.92) / metrics.width);
  ctx.translate(x + w / 2, y);
  ctx.scale(sx, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function storefronts() {
  const W = 2048, H = 1024, C = 512;
  const rng = makeRng(501);
  const { c, ctx } = canvas(W, H);
  const { c: gc, ctx: glow } = canvas(W, H);
  glow.fillStyle = '#000';
  glow.fillRect(0, 0, W, H);
  const N = noiseTiles();
  const signTop = 0, signH = 112, openTop = 120, openBot = 450;

  const kinds = [STORE.shutter, STORE.smashed, STORE.boarded, STORE.halfShutter, STORE.pharmacy, STORE.laundry, STORE.papered, STORE.barred];
  kinds.forEach((kind, n) => {
    const x0 = (n % 4) * C, y0 = Math.floor(n / 4) * C;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, C, C);
    ctx.clip();
    // Surround: stone pilasters + bulkhead.
    ctx.fillStyle = '#4e4640';
    ctx.fillRect(x0, y0, C, C);
    overlay(ctx, N.blotch, x0, y0, C, C, 0.5, 'overlay');
    // Sign band
    ctx.fillStyle = rng.pick(['#2a2522', '#3a2a24', '#262a2a', '#33302a']);
    ctx.fillRect(x0 + 10, y0 + signTop + 14, C - 20, signH - 22);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(x0 + 10, y0 + signH - 8, C - 20, 6);
    const ox = x0 + 22, ow = C - 44, oy = y0 + openTop, oh = openBot - openTop;
    const interior = (lit) => {
      const g = ctx.createLinearGradient(0, oy, 0, oy + oh);
      g.addColorStop(0, lit ? '#9fb0a6' : '#0c0a0a');
      g.addColorStop(1, lit ? '#59645c' : '#050404');
      ctx.fillStyle = g;
      ctx.fillRect(ox, oy, ow, oh);
    };
    if (kind === STORE.shutter || kind === STORE.halfShutter) {
      interior(false);
      const sh = kind === STORE.shutter ? oh : oh * 0.62;
      for (let yy = oy; yy < oy + sh; yy += 9) {
        ctx.fillStyle = hsl(20, 6, 30 + rng() * 6);
        ctx.fillRect(ox, yy, ow, 7);
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(ox, yy + 7, ow, 2);
      }
      // rust runs
      for (let k = 0; k < 10; k++) {
        const g = ctx.createLinearGradient(0, oy, 0, oy + sh);
        g.addColorStop(0, 'rgba(110,50,20,0.0)');
        g.addColorStop(0.4 + rng() * 0.5, 'rgba(110,50,20,0.35)');
        g.addColorStop(1, 'rgba(110,50,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(ox + rng() * ow, oy, 4 + rng() * 14, sh);
      }
      // tags
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = rng.pick(['rgba(220,220,210,0.55)', 'rgba(170,20,20,0.6)', 'rgba(20,20,20,0.6)']);
        ctx.lineWidth = 3 + rng() * 3;
        ctx.beginPath();
        let tx = ox + 30 + rng() * (ow - 160), ty = oy + 60 + rng() * (sh - 120);
        ctx.moveTo(tx, ty);
        for (let s = 0; s < 9; s++) {
          tx += 8 + rng() * 14;
          ty += (rng() - 0.5) * 40;
          ctx.lineTo(tx, ty);
        }
        ctx.stroke();
      }
    } else if (kind === STORE.boarded || kind === STORE.papered) {
      interior(false);
      if (kind === STORE.boarded) {
        for (let k = 0; k < 4; k++) {
          ctx.fillStyle = hsl(32, 28, 26 + rng() * 10);
          ctx.fillRect(ox + (ow / 4) * k + 2, oy, ow / 4 - 4, oh);
        }
        ctx.strokeStyle = 'rgba(200,30,20,0.7)';
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(ox + 60, oy + 60);
        ctx.lineTo(ox + ow - 60, oy + oh - 40);
        ctx.moveTo(ox + ow - 60, oy + 60);
        ctx.lineTo(ox + 60, oy + oh - 40);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#7d7462';
        ctx.fillRect(ox, oy, ow, oh);
        overlay(ctx, N.fine, ox, oy, ow, oh, 0.6, 'multiply');
        // missing-person flyers whose faces were left blank
        for (let k = 0; k < 7; k++) {
          const fx = ox + 20 + rng() * (ow - 90), fy = oy + 20 + rng() * (oh - 120);
          ctx.save();
          ctx.translate(fx, fy);
          ctx.rotate((rng() - 0.5) * 0.2);
          ctx.fillStyle = '#c9c3b4';
          ctx.fillRect(0, 0, 66, 90);
          ctx.fillStyle = '#222';
          ctx.fillRect(8, 6, 50, 7);
          ctx.fillStyle = '#d8d3c6';
          ctx.fillRect(13, 18, 40, 44);
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          for (let l = 0; l < 3; l++) ctx.fillRect(8, 68 + l * 6, 30 + rng() * 20, 3);
          ctx.restore();
        }
        signText(ctx, 'FOR LEASE', x0 + 10, y0 + 60, C - 20, 50, 'rgba(200,190,170,0.6)');
      }
    } else if (kind === STORE.laundry) {
      interior(true);
      // tiled back wall + row of machines
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      for (let yy = oy; yy < oy + oh * 0.5; yy += 16) ctx.fillRect(ox, yy, ow, 1);
      for (let k = 0; k < 6; k++) {
        const mx = ox + 12 + k * (ow / 6);
        ctx.fillStyle = '#c9d1cd';
        ctx.fillRect(mx, oy + oh * 0.5, ow / 6 - 12, oh * 0.5);
        ctx.fillStyle = '#26302c';
        ctx.beginPath();
        ctx.arc(mx + (ow / 6 - 12) / 2, oy + oh * 0.72, 22, 0, Math.PI * 2);
        ctx.fill();
      }
      // a slumped coat on the floor and a chair
      ctx.fillStyle = '#2b2622';
      ctx.fillRect(ox + ow * 0.6, oy + oh - 30, 70, 26);
      signText(ctx, 'LAUNDRY', x0 + 10, y0 + 60, C - 20, 60, 'rgba(210,220,215,0.85)');
      // glow mask: bright interior, machines dimmer
      const g = glow.createLinearGradient(0, oy, 0, oy + oh);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#8a8a8a');
      glow.fillStyle = g;
      glow.fillRect(ox, oy, ow, oh);
      glow.fillStyle = 'rgba(0,0,0,0.45)';
      for (let k = 0; k < 6; k++) glow.fillRect(ox + 12 + k * (ow / 6), oy + oh * 0.5, ow / 6 - 12, oh * 0.5);
      glow.fillStyle = '#9a9a9a';
      glow.fillRect(x0 + 40, y0 + 30, C - 80, 60);
    } else {
      // smashed glass / pharmacy / barred
      interior(false);
      ctx.fillStyle = 'rgba(30,26,24,1)';
      ctx.fillRect(ox + 20, oy + oh * 0.55, ow * 0.4, oh * 0.45); // fallen shelving silhouette
      ctx.fillRect(ox + ow * 0.6, oy + oh * 0.3, ow * 0.25, oh * 0.7);
      ctx.fillStyle = 'rgba(140,130,135,0.3)';
      for (let k = 0; k < 9; k++) {
        const sx = ox + (k % 2 ? 0 : ow) + (k % 2 ? 1 : -1) * rng() * 30;
        const sy = oy + rng() * oh;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + (k % 2 ? 1 : -1) * (30 + rng() * 80), sy + (rng() - 0.5) * 80);
        ctx.lineTo(sx, sy + 40 + rng() * 60);
        ctx.fill();
      }
      if (kind === STORE.barred) {
        ctx.fillStyle = '#1b1b1b';
        for (let xx = ox; xx < ox + ow; xx += 22) ctx.fillRect(xx, oy, 5, oh);
        ctx.fillRect(ox, oy + oh * 0.3, ow, 6);
        ctx.fillRect(ox, oy + oh * 0.7, ow, 6);
      } else if (kind === STORE.pharmacy) {
        // Burnt: soot blooms up the facade, half the letters gone.
        const sg = ctx.createLinearGradient(0, y0 + C, 0, y0);
        sg.addColorStop(0, 'rgba(0,0,0,0.2)');
        sg.addColorStop(0.6, 'rgba(0,0,0,0.85)');
        sg.addColorStop(1, 'rgba(0,0,0,0.5)');
        ctx.fillStyle = sg;
        ctx.fillRect(x0, y0, C, C);
        signText(ctx, 'PHAR  ACY', x0 + 10, y0 + 62, C - 20, 60, 'rgba(160,200,170,0.45)');
        ctx.fillStyle = 'rgba(150,40,30,0.5)';
        ctx.fillRect(x0 + 30, y0 + 40, 14, 44);
        ctx.fillRect(x0 + 15, y0 + 55, 44, 14);
      } else {
        // ghost of a removed sign: screw holes and a paler rectangle
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x0 + 60, y0 + 30, C - 120, 60);
      }
    }
    // Pilasters and bulkhead
    ctx.fillStyle = '#3d3632';
    ctx.fillRect(x0, y0 + openTop - 8, 22, C - openTop + 8);
    ctx.fillRect(x0 + C - 22, y0 + openTop - 8, 22, C - openTop + 8);
    ctx.fillRect(x0, y0 + openBot, C, C - openBot);
    ctx.fillStyle = '#2a2420';
    ctx.fillRect(x0 + 22, y0 + openTop - 8, C - 44, 8);
    overlay(ctx, N.grain, x0, y0, C, C, 0.25, 'overlay');
    overlay(ctx, N.fine, x0, y0, C, C, 0.35, 'multiply');
    // Dirt rising from the pavement
    const dg = ctx.createLinearGradient(0, y0 + C, 0, y0 + C - 140);
    dg.addColorStop(0, 'rgba(12,8,6,0.6)');
    dg.addColorStop(1, 'rgba(12,8,6,0)');
    ctx.fillStyle = dg;
    ctx.fillRect(x0, y0 + C - 140, C, 140);
    ctx.restore();
  });
  return { map: toTexture(c, { repeat: false }), glow: toTexture(gc, { repeat: false }) };
}

// UV rect [u0, v0, u1, v1] of a storefront variant (texture v = 0 at the bottom).
export function storeUV(kind) {
  const col = kind % STOREFRONT.cols, row = Math.floor(kind / STOREFRONT.cols);
  const u0 = col / STOREFRONT.cols, u1 = (col + 1) / STOREFRONT.cols;
  const v1 = 1 - row / STOREFRONT.rows, v0 = 1 - (row + 1) / STOREFRONT.rows;
  const e = 0.002;
  return [u0 + e, v0 + e, u1 - e, v1 - e];
}

// --- ground -------------------------------------------------------------------------------------

function asphaltBase(ctx, S, rng, tone = 30) {
  ctx.fillStyle = hsl(10, 4, tone * 1.05);
  ctx.fillRect(0, 0, S, S);
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.22, 'overlay', S / 256);
  overlay(ctx, N.grain, 0, 0, S, S, 0.55, 'overlay');
  overlay(ctx, N.fine, 0, 0, S, S, 0.3, 'overlay', S / 512);
  // Patch repairs: slightly different asphalt, soft-edged
  for (let k = 0; k < 4; k++) {
    const w = 60 + rng() * 140, h = 40 + rng() * 120, x = rng() * S, y = rng() * S;
    ctx.fillStyle = `rgba(${rng() < 0.5 ? '10,10,12' : '70,66,64'},${0.08 + rng() * 0.1})`;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }
  for (let k = 0; k < 10; k++) stain(ctx, rng() * S, rng() * S, 20 + rng() * 70, 'rgba(0,0,0,0.35)');
}

function road() {
  // 16 m wide x 16 m long four-lane road section, 64 px per metre.
  const S = 1024, PX = S / 16;
  const rng = makeRng(77);
  const { c, ctx } = canvas(S);
  asphaltBase(ctx, S, rng, 32);
  // oil drips down the middle of each lane
  for (let lane = 0; lane < 4; lane++) {
    const lx = (lane * 4 + 2) * PX;
    for (let k = 0; k < 6; k++) stain(ctx, lx + (rng() - 0.5) * 50, rng() * S, 18 + rng() * 30, 'rgba(0,0,0,0.3)');
  }
  // Markings on their own layer, worn away with speckle, then laid over the asphalt.
  const { c: pc, ctx: paint } = canvas(S);
  paint.fillStyle = 'rgba(205,165,60,0.9)';
  paint.fillRect(8 * PX - 10, 0, 6, S);
  paint.fillRect(8 * PX + 4, 0, 6, S);
  paint.fillStyle = 'rgba(210,205,195,0.85)';
  for (const lx of [4 * PX, 12 * PX]) {
    paint.fillRect(lx - 4, 0, 8, 3 * PX);
    paint.fillRect(lx - 4, 8 * PX, 8, 3 * PX);
  }
  paint.fillRect(0.35 * PX, 0, 7, S);
  paint.fillRect(15.65 * PX - 7, 0, 7, S);
  paint.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 2600; k++) {
    paint.fillStyle = `rgba(0,0,0,${0.3 + rng() * 0.7})`;
    paint.beginPath();
    paint.arc(rng() * S, rng() * S, 1 + rng() * 4, 0, Math.PI * 2);
    paint.fill();
  }
  for (let k = 0; k < 12; k++) {
    paint.fillStyle = `rgba(0,0,0,${0.5 + rng() * 0.5})`;
    paint.fillRect(0, rng() * S, S, 10 + rng() * 60); // whole stretches scuffed off
  }
  ctx.drawImage(pc, 0, 0);
  for (let k = 0; k < 14; k++) crack(ctx, rng, rng() * S, rng() * S, 10 + rng() * 30, 1 + rng() * 1.5);
  // tyre marks
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 12;
  for (let k = 0; k < 3; k++) {
    const x = rng() * S;
    ctx.beginPath();
    ctx.moveTo(x, rng() * S);
    ctx.bezierCurveTo(x + 80, rng() * S, x - 60, rng() * S, x + (rng() - 0.5) * 200, rng() * S);
    ctx.stroke();
  }
  return toTexture(c, { aniso: 8 });
}

function asphalt() {
  const S = 512;
  const rng = makeRng(91);
  const { c, ctx } = canvas(S);
  asphaltBase(ctx, S, rng, 30);
  for (let k = 0; k < 8; k++) crack(ctx, rng, rng() * S, rng() * S, 8 + rng() * 20, 1.2);
  return toTexture(c, { aniso: 8 });
}

function paving() {
  // Sidewalk: 4 m tile, 3 x 3 concrete slabs.
  const S = 512, P = S / 3;
  const rng = makeRng(131);
  const { c, ctx } = canvas(S);
  ctx.fillStyle = '#5b5552';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      ctx.fillStyle = hsl(20, 5, 33 + rng() * 9);
      ctx.fillRect(i * P + 2, j * P + 2, P - 4, P - 4);
    }
  }
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.55, 'overlay', 2);
  overlay(ctx, N.grain, 0, 0, S, S, 0.35, 'overlay');
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0; i <= 3; i++) {
    ctx.fillRect(i * P - 2, 0, 3, S);
    ctx.fillRect(0, i * P - 2, S, 3);
  }
  for (let k = 0; k < 7; k++) crack(ctx, rng, rng() * S, rng() * S, 6 + rng() * 14, 1.3);
  for (let k = 0; k < 6; k++) stain(ctx, rng() * S, rng() * S, 15 + rng() * 40, 'rgba(10,6,4,0.3)');
  // chewing-gum spots
  ctx.fillStyle = 'rgba(15,12,12,0.5)';
  for (let k = 0; k < 40; k++) ctx.fillRect(rng() * S, rng() * S, 3, 3);
  return toTexture(c, { aniso: 8 });
}

function pavers() {
  // Plaza stone pavers, 6 m tile.
  const S = 512;
  const rng = makeRng(171);
  const { c, ctx } = canvas(S);
  ctx.fillStyle = '#433c38';
  ctx.fillRect(0, 0, S, S);
  const rowH = 32;
  for (let row = 0; row < S / rowH; row++) {
    let x = row % 2 ? -24 : 0;
    while (x < S) {
      const w = 40 + rng.int(0, 2) * 16;
      ctx.fillStyle = hsl(25, 7 + rng() * 6, 30 + rng() * 10);
      ctx.fillRect(x + 2, row * rowH + 2, w - 4, rowH - 4);
      x += w;
    }
  }
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.5, 'overlay', 2);
  overlay(ctx, N.grain, 0, 0, S, S, 0.3, 'overlay');
  for (let k = 0; k < 6; k++) stain(ctx, rng() * S, rng() * S, 20 + rng() * 50, 'rgba(8,5,4,0.35)');
  // moss/dirt in the joints
  overlay(ctx, N.fine, 0, 0, S, S, 0.3, 'multiply', 3);
  return toTexture(c, { aniso: 8 });
}

function deadGrass() {
  const S = 512;
  const rng = makeRng(191);
  const { c, ctx } = canvas(S);
  ctx.fillStyle = '#3a2f24';
  ctx.fillRect(0, 0, S, S);
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.7, 'overlay', 2);
  for (let k = 0; k < 4000; k++) {
    ctx.strokeStyle = hsl(30 + rng() * 15, 20 + rng() * 15, 15 + rng() * 20, 0.7);
    ctx.lineWidth = 1;
    const x = rng() * S, y = rng() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 6, y - 3 - rng() * 7);
    ctx.stroke();
  }
  for (let k = 0; k < 10; k++) stain(ctx, rng() * S, rng() * S, 20 + rng() * 40, 'rgba(10,8,6,0.4)');
  return toTexture(c);
}

function concrete() {
  const S = 512;
  const rng = makeRng(211);
  const { c, ctx } = canvas(S);
  ctx.fillStyle = '#dcd8d2';
  ctx.fillRect(0, 0, S, S);
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.6, 'overlay', 2);
  overlay(ctx, N.grain, 0, 0, S, S, 0.35, 'overlay');
  overlay(ctx, N.fine, 0, 0, S, S, 0.35, 'multiply', 2);
  for (let k = 0; k < 6; k++) crack(ctx, rng, rng() * S, rng() * S, 6 + rng() * 10, 1, 'rgba(20,18,16,0.5)');
  for (let k = 0; k < 14; k++) {
    const x = rng() * S;
    const g = ctx.createLinearGradient(0, rng() * S * 0.5, 0, S);
    g.addColorStop(0, 'rgba(20,14,10,0)');
    g.addColorStop(1, 'rgba(20,14,10,0.25)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 4 + rng() * 20, S);
  }
  return toTexture(c);
}

// Corrugated / rusty metal used on cars and props as a subtle grime map.
function grime() {
  const S = 256;
  const { c, ctx } = canvas(S);
  ctx.fillStyle = '#e6e2dc';
  ctx.fillRect(0, 0, S, S);
  const N = noiseTiles();
  overlay(ctx, N.blotch, 0, 0, S, S, 0.5, 'overlay');
  overlay(ctx, N.grain, 0, 0, S, S, 0.25, 'overlay');
  overlay(ctx, N.fine, 0, 0, S, S, 0.25, 'multiply');
  return toTexture(c);
}

// --- decals -------------------------------------------------------------------------------------

// Ground-decal atlas (1024 px): named rects in pixels, top-left origin.
export const DECAL = {
  manhole: [0, 0, 256, 256],
  grate: [256, 0, 256, 128],
  oil: [512, 0, 256, 256],
  cracks: [768, 0, 256, 256],
  skid: [256, 128, 256, 128],
  crosswalk: [0, 256, 128, 512],
  papers: [128, 256, 256, 256],
  scorch: [384, 256, 256, 256],
  leaves: [640, 256, 256, 256],
  arrow: [896, 256, 128, 512],
  puddle1: [128, 512, 384, 256],
  puddle2: [512, 512, 384, 256],
  puddle3: [128, 768, 384, 256],
  rubble: [512, 768, 256, 256],
  stripes: [768, 768, 256, 256],
};

export function decalUV(name) {
  const [x, y, w, h] = DECAL[name];
  const S = 1024, e = 1 / S;
  return [x / S + e, 1 - (y + h) / S + e, (x + w) / S - e, 1 - y / S - e];
}

function decals() {
  const S = 1024;
  const rng = makeRng(301);
  const { c, ctx } = canvas(S);
  ctx.clearRect(0, 0, S, S);
  const N = noiseTiles();
  const R = (name) => DECAL[name];

  // Manhole cover
  {
    const [x, y, w] = R('manhole');
    const cx = x + w / 2, cy = y + w / 2, r = w * 0.44;
    ctx.fillStyle = '#1c1a19';
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#34302d';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1d1a18';
    ctx.lineWidth = 5;
    for (let k = 1; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r * k) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let k = 0; k < 8; k++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos((k * Math.PI) / 4) * r, cy + Math.sin((k * Math.PI) / 4) * r);
      ctx.stroke();
    }
    signText(ctx, 'SEWER', x, cy, w, 26, 'rgba(25,22,20,0.9)');
  }
  // Storm drain grate
  {
    const [x, y, w, h] = R('grate');
    ctx.fillStyle = '#121010';
    ctx.fillRect(x + 10, y + 30, w - 20, h - 60);
    ctx.fillStyle = '#3a3532';
    for (let xx = x + 14; xx < x + w - 14; xx += 14) ctx.fillRect(xx, y + 34, 6, h - 68);
  }
  // Oil stain
  {
    const [x, y, w] = R('oil');
    for (let k = 0; k < 6; k++) stain(ctx, x + w / 2 + (rng() - 0.5) * 60, y + w / 2 + (rng() - 0.5) * 60, 40 + rng() * 60, 'rgba(0,0,0,0.45)');
  }
  // Cracks
  {
    const [x, y, w] = R('cracks');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, w);
    ctx.clip();
    for (let k = 0; k < 6; k++) crack(ctx, rng, x + w / 2, y + w / 2, 14 + rng() * 14, 2.5, 'rgba(0,0,0,0.8)');
    ctx.restore();
  }
  // Skid marks
  {
    const [x, y, w, h] = R('skid');
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 16;
    for (const off of [-30, 30]) {
      ctx.beginPath();
      ctx.moveTo(x + 10, y + h / 2 + off);
      ctx.quadraticCurveTo(x + w / 2, y + h / 2 + off + 20, x + w - 10, y + h / 2 + off - 10);
      ctx.stroke();
    }
  }
  // Crosswalk bar (worn white paint)
  {
    const [x, y, w, h] = R('crosswalk');
    ctx.fillStyle = 'rgba(215,210,200,0.85)';
    ctx.fillRect(x + 8, y + 8, w - 16, h - 16);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    overlay(ctx, N.blotch, x, y, w, h, 0.2, 'destination-out', 0.5);
    for (let k = 0; k < 500; k++) {
      ctx.fillStyle = `rgba(0,0,0,${0.2 + rng() * 0.6})`;
      ctx.beginPath();
      ctx.arc(x + rng() * w, y + rng() * h, 1 + rng() * 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // Litter / papers
  {
    const [x, y, w] = R('papers');
    for (let k = 0; k < 14; k++) {
      ctx.save();
      ctx.translate(x + 20 + rng() * (w - 40), y + 20 + rng() * (w - 40));
      ctx.rotate(rng() * Math.PI);
      ctx.fillStyle = hsl(40, 10, 55 + rng() * 20, 0.85);
      ctx.fillRect(-14, -18, 28 + rng() * 10, 36);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let l = 0; l < 4; l++) ctx.fillRect(-10, -12 + l * 7, 18, 2);
      ctx.restore();
    }
  }
  // Scorch mark under burnt wrecks
  {
    const [x, y, w] = R('scorch');
    stain(ctx, x + w / 2, y + w / 2, w * 0.5, 'rgba(0,0,0,0.85)');
    stain(ctx, x + w / 2, y + w / 2, w * 0.3, 'rgba(10,5,2,0.8)');
  }
  // Dead leaves and grit
  {
    const [x, y, w] = R('leaves');
    for (let k = 0; k < 160; k++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * w * 0.45;
      ctx.fillStyle = hsl(20 + rng() * 25, 35, 12 + rng() * 15, 0.85);
      ctx.beginPath();
      ctx.ellipse(x + w / 2 + Math.cos(a) * r, y + w / 2 + Math.sin(a) * r, 3 + rng() * 4, 1.5 + rng() * 2, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Road arrow
  {
    const [x, y, w, h] = R('arrow');
    ctx.fillStyle = 'rgba(210,205,195,0.8)';
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y + 10);
    ctx.lineTo(x + w - 10, y + 140);
    ctx.lineTo(x + w / 2 + 18, y + 140);
    ctx.lineTo(x + w / 2 + 18, y + h - 10);
    ctx.lineTo(x + w / 2 - 18, y + h - 10);
    ctx.lineTo(x + w / 2 - 18, y + 140);
    ctx.lineTo(x + 10, y + 140);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 80; k++) {
      ctx.fillStyle = `rgba(0,0,0,${0.3 + rng() * 0.7})`;
      ctx.fillRect(x + rng() * w, y + rng() * h, 4 + rng() * 16, 3 + rng() * 10);
    }
    ctx.restore();
  }
  // Puddle shapes (white, alpha = water)
  for (const name of ['puddle1', 'puddle2', 'puddle3']) {
    const [x, y, w, h] = R(name);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (let k = 0; k < 7; k++) {
      const px = x + w * (0.25 + rng() * 0.5), py = y + h * (0.3 + rng() * 0.4);
      const g = ctx.createRadialGradient(px, py, 0, px, py, 50 + rng() * 60);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(px, py, 60 + rng() * 70, 30 + rng() * 40, rng() * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // Rubble grit
  {
    const [x, y, w] = R('rubble');
    for (let k = 0; k < 220; k++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * w * 0.47;
      ctx.fillStyle = hsl(25, 6, 18 + rng() * 25, 0.9);
      const s = 2 + rng() * 9;
      ctx.fillRect(x + w / 2 + Math.cos(a) * r, y + w / 2 + Math.sin(a) * r, s, s * (0.5 + rng()));
    }
  }
  // Hazard stripes
  {
    const [x, y, w, h] = R('stripes');
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#c9c2b4';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#b4351f';
    for (let k = -4; k < 8; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 48, y + h);
      ctx.lineTo(x + k * 48 + 24, y + h);
      ctx.lineTo(x + k * 48 + 24 + h, y);
      ctx.lineTo(x + k * 48 + h, y);
      ctx.fill();
    }
    overlay(ctx, N.grain, x, y, w, h, 0.4, 'multiply');
    ctx.restore();
  }
  return toTexture(c, { repeat: false });
}

// --- signs ---------------------------------------------------------------------------------------

export const SIGN = {
  highway1: [0, 0, 512, 256],
  highway2: [512, 0, 512, 256],
  limits: [0, 256, 512, 256],
  billboard: [512, 256, 512, 256],
  roadClosed: [0, 512, 256, 128],
  street: [256, 512, 256, 128],
  parking: [512, 512, 256, 128],
  exit: [768, 512, 256, 128],
  poster: [0, 640, 256, 256],
  stop: [256, 640, 256, 256],
  fuel: [512, 640, 256, 256],
  civic: [0, 896, 512, 128],
  courier: [512, 896, 256, 128],
  stripes: [768, 640, 256, 256],
  gasco: [768, 896, 256, 128],
};

export function signUV(name) {
  const [x, y, w, h] = SIGN[name];
  const S = 1024, e = 0.5 / S;
  return [x / S + e, 1 - (y + h) / S + e, (x + w) / S - e, 1 - y / S - e];
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function signs() {
  const S = 1024;
  const rng = makeRng(401);
  const { c, ctx } = canvas(S);
  const N = noiseTiles();
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, S, S);
  const wear = (r, alpha = 0.45) => {
    const [x, y, w, h] = r;
    overlay(ctx, N.blotch, x, y, w, h, alpha, 'multiply', 1);
    overlay(ctx, N.grain, x, y, w, h, 0.3, 'overlay');
  };
  const green = (r) => {
    const [x, y, w, h] = r;
    ctx.fillStyle = '#e8e6df';
    roundRect(ctx, x + 4, y + 4, w - 8, h - 8, 18);
    ctx.fill();
    ctx.fillStyle = '#1f5a3a';
    roundRect(ctx, x + 10, y + 10, w - 20, h - 20, 14);
    ctx.fill();
  };
  // Highway signs
  {
    const r = SIGN.highway1;
    green(r);
    signText(ctx, 'ROUTE 9  NORTH', r[0] + 20, r[1] + 70, r[2] - 40, 44, '#ecebe4', { font: STENCIL });
    signText(ctx, 'HARROW BRIDGE', r[0] + 20, r[1] + 140, r[2] - 40, 56, '#ecebe4', { font: STENCIL });
    signText(ctx, '↑', r[0] + 20, r[1] + 205, r[2] - 40, 60, '#ecebe4');
    wear(r, 0.5);
  }
  {
    const r = SIGN.highway2;
    green(r);
    signText(ctx, 'EXIT 14', r[0] + 300, r[1] + 50, 180, 34, '#1f5a3a');
    ctx.fillStyle = '#ecebe4';
    ctx.fillRect(r[0] + 320, r[1] + 24, 160, 52);
    signText(ctx, 'EXIT 14', r[0] + 320, r[1] + 51, 160, 36, '#1f5a3a', { font: STENCIL });
    signText(ctx, 'CITY LIMITS', r[0] + 20, r[1] + 120, r[2] - 40, 54, '#ecebe4', { font: STENCIL });
    signText(ctx, '1/4 MILE', r[0] + 20, r[1] + 190, r[2] - 40, 44, '#ecebe4', { font: STENCIL });
    wear(r, 0.5);
  }
  // City limits
  {
    const [x, y, w, h] = SIGN.limits;
    ctx.fillStyle = '#e4e2da';
    roundRect(ctx, x + 6, y + 6, w - 12, h - 12, 14);
    ctx.fill();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 6;
    roundRect(ctx, x + 16, y + 16, w - 32, h - 32, 10);
    ctx.stroke();
    signText(ctx, 'NOW LEAVING', x + 30, y + 62, w - 60, 40, '#1a1a1a', { font: STENCIL });
    signText(ctx, 'ASHFORD', x + 30, y + 130, w - 60, 86, '#1a1a1a', { font: STENCIL });
    signText(ctx, 'POP.', x + 40, y + 205, 120, 36, '#1a1a1a', { font: STENCIL });
    // population scraped off
    ctx.fillStyle = '#9b958a';
    ctx.fillRect(x + 175, y + 186, 240, 40);
    ctx.strokeStyle = 'rgba(60,55,50,0.8)';
    ctx.lineWidth = 2;
    for (let k = 0; k < 30; k++) {
      ctx.beginPath();
      const sx = x + 175 + rng() * 240;
      ctx.moveTo(sx, y + 186 + rng() * 40);
      ctx.lineTo(sx + 20 + rng() * 30, y + 186 + rng() * 40);
      ctx.stroke();
    }
    wear(SIGN.limits, 0.4);
  }
  // Billboard: civic slogan with the key word peeled away
  {
    const [x, y, w, h] = SIGN.billboard;
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#7a8fa0');
    g.addColorStop(1, '#c49a72');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    // a smiling family silhouette, faces blank
    ctx.fillStyle = 'rgba(40,35,40,0.6)';
    for (let k = 0; k < 3; k++) {
      const fx = x + 330 + k * 52, fy = y + 120 - (k === 1 ? 14 : 0);
      ctx.beginPath();
      ctx.arc(fx, fy, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(fx - 26, fy + 26, 52, 120);
    }
    ctx.fillStyle = '#d8d0c0';
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(x + 330 + k * 52, y + 120 - (k === 1 ? 14 : 0), 18, 0, Math.PI * 2);
      ctx.fill();
    }
    signText(ctx, 'ASHFORD', x + 20, y + 70, 290, 64, '#f4efe4');
    signText(ctx, 'a city worth', x + 20, y + 130, 290, 34, '#f4efe4', { weight: 'italic bold' });
    // peeled strip where the last word was
    ctx.fillStyle = '#6a6458';
    ctx.beginPath();
    ctx.moveTo(x + 40, y + 160);
    ctx.lineTo(x + 300, y + 152);
    ctx.lineTo(x + 290, y + 214);
    ctx.lineTo(x + 50, y + 222);
    ctx.fill();
    overlay(ctx, N.fine, x + 40, y + 150, 260, 75, 0.7, 'multiply');
    // peeling paper strips
    for (let k = 0; k < 9; k++) {
      ctx.fillStyle = `rgba(90,85,75,${0.5 + rng() * 0.4})`;
      ctx.fillRect(x + rng() * w, y + rng() * h, 20 + rng() * 60, 6 + rng() * 40);
    }
    wear(SIGN.billboard, 0.6);
  }
  // ROAD CLOSED
  {
    const [x, y, w, h] = SIGN.roadClosed;
    ctx.fillStyle = '#e6e1d6';
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 10, y + 10, w - 20, h - 20);
    signText(ctx, 'ROAD', x + 14, y + 44, w - 28, 40, '#111', { font: STENCIL });
    signText(ctx, 'CLOSED', x + 14, y + 90, w - 28, 40, '#111', { font: STENCIL });
    wear(SIGN.roadClosed, 0.45);
  }
  // Street name
  {
    const [x, y, w, h] = SIGN.street;
    ctx.fillStyle = '#1e5236';
    ctx.fillRect(x + 4, y + 30, w - 8, h - 60);
    signText(ctx, 'MERCER ST', x + 10, y + h / 2, w - 20, 40, '#e8e8e0', { font: STENCIL });
    wear(SIGN.street, 0.35);
  }
  // Parking
  {
    const [x, y, w, h] = SIGN.parking;
    ctx.fillStyle = '#204a86';
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    signText(ctx, 'P', x + 8, y + h / 2, 80, 90, '#f0f0f0');
    signText(ctx, 'PARKING', x + 90, y + 46, w - 100, 34, '#f0f0f0', { font: STENCIL });
    signText(ctx, 'ENTRANCE', x + 90, y + 88, w - 100, 30, '#f0f0f0', { font: STENCIL });
    wear(SIGN.parking, 0.4);
  }
  // EXIT (emergency)
  {
    const [x, y, w, h] = SIGN.exit;
    ctx.fillStyle = '#1a0606';
    ctx.fillRect(x, y, w, h);
    signText(ctx, 'EXIT', x + 10, y + h / 2, w - 20, 80, '#ff3a2a', { font: STENCIL });
  }
  // Transit poster (bus shelter)
  {
    const [x, y, w, h] = SIGN.poster;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#2c3b52');
    g.addColorStop(1, '#a06a4a');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(230,220,200,0.85)';
    ctx.beginPath();
    ctx.arc(x + w / 2, y + 100, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + w / 2 - 50, y + 150, 100, 90);
    signText(ctx, 'RIDE WITH US', x + 10, y + 30, w - 20, 26, '#f0e8d8');
    wear(SIGN.poster, 0.5);
  }
  // STOP
  {
    const [x, y, w] = SIGN.stop;
    const cx = x + w / 2, cy = y + w / 2, r = w * 0.46;
    ctx.fillStyle = '#e8e6e0';
    ctx.beginPath();
    for (let k = 0; k < 8; k++) ctx.lineTo(cx + Math.cos(Math.PI / 8 + (k * Math.PI) / 4) * r, cy + Math.sin(Math.PI / 8 + (k * Math.PI) / 4) * r);
    ctx.fill();
    ctx.fillStyle = '#a3241c';
    ctx.beginPath();
    for (let k = 0; k < 8; k++) ctx.lineTo(cx + Math.cos(Math.PI / 8 + (k * Math.PI) / 4) * r * 0.92, cy + Math.sin(Math.PI / 8 + (k * Math.PI) / 4) * r * 0.92);
    ctx.fill();
    signText(ctx, 'STOP', x + 20, cy, w - 40, 70, '#eee', { font: STENCIL });
    wear(SIGN.stop, 0.5);
  }
  // Fuel price board (prices rolled to blanks)
  {
    const [x, y, w, h] = SIGN.fuel;
    ctx.fillStyle = '#e1ddd2';
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.fillStyle = '#8c2a1e';
    ctx.fillRect(x + 4, y + 4, w - 8, 60);
    signText(ctx, 'FUEL', x + 10, y + 35, w - 20, 44, '#f4efe4');
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = '#111';
      ctx.fillRect(x + 20, y + 80 + k * 56, w - 40, 46);
      signText(ctx, '- . - -', x + 20, y + 104 + k * 56, w - 40, 34, '#c7462e', { font: STENCIL });
    }
    wear(SIGN.fuel, 0.5);
  }
  // Civic centre inscription (carved, pale on stone)
  {
    const [x, y, w, h] = SIGN.civic;
    ctx.fillStyle = '#8f8678';
    ctx.fillRect(x, y, w, h);
    overlay(ctx, N.blotch, x, y, w, h, 0.5, 'overlay');
    signText(ctx, 'ASHFORD  CIVIC  HALL', x + 14, y + h / 2 + 2, w - 28, 50, 'rgba(30,25,22,0.85)', { font: STENCIL });
    signText(ctx, 'ASHFORD  CIVIC  HALL', x + 14, y + h / 2, w - 28, 50, 'rgba(200,190,175,0.5)', { font: STENCIL });
  }
  // Newspaper box front
  {
    const [x, y, w, h] = SIGN.courier;
    ctx.fillStyle = '#6a1e18';
    ctx.fillRect(x, y, w, h);
    signText(ctx, 'THE COURIER', x + 8, y + 40, w - 16, 34, '#eee', { font: STENCIL });
    ctx.fillStyle = '#ddd6c6';
    ctx.fillRect(x + 20, y + 70, w - 40, 48);
    signText(ctx, 'CITY CALM', x + 24, y + 94, w - 48, 26, '#222', { font: STENCIL });
  }
  // Hazard stripes (for barricades)
  {
    const [x, y, w, h] = SIGN.stripes;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#ddd5c4';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#c0451f';
    for (let k = -6; k < 10; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 64, y + h);
      ctx.lineTo(x + k * 64 + 32, y + h);
      ctx.lineTo(x + k * 64 + 32 + h, y);
      ctx.lineTo(x + k * 64 + h, y);
      ctx.fill();
    }
    ctx.restore();
    wear(SIGN.stripes, 0.5);
  }
  // Gas station canopy band
  {
    const [x, y, w, h] = SIGN.gasco;
    ctx.fillStyle = '#d9d3c6';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#8c2a1e';
    ctx.fillRect(x, y + h * 0.62, w, h * 0.2);
    signText(ctx, 'GAS  ·  FOOD', x + 10, y + 42, w - 20, 40, '#5a1a14', { font: STENCIL });
    wear(SIGN.gasco, 0.55);
  }
  return toTexture(c, { repeat: false });
}

// --- shop signs --------------------------------------------------------------------------------

// Fictional, generic shop names (never brands). Some letters have fallen off.
export const SHOP_SIGNS = ['HARDWARE', 'DINER', 'PAWN & LOAN', 'LIQUORS', 'SHOE REPAIR', 'BAKERY', 'DRY CLEANING', 'BOOKS',
  'TAILOR', 'PHOTO', 'FLORIST', 'BARBER', 'ELECTRONICS', 'DELI', 'TOBACCO', 'OPTICIAN', 'GROCERY', 'KEYS CUT',
  'HATS', 'NOODLES', 'RECORDS', 'PET SUPPLY', 'BEAUTY', 'CHECKS CASHED', 'TOYS', 'FABRICS', 'BAR', 'DONUTS',
  'CAMERAS', 'SHOES', 'HOTEL', 'BANK'];
const SHOP_COLS = 4, SHOP_ROWS = 8;

export function shopSignUV(i) {
  const n = i % (SHOP_COLS * SHOP_ROWS);
  const col = n % SHOP_COLS, row = Math.floor(n / SHOP_COLS);
  const e = 0.002;
  return [col / SHOP_COLS + e, 1 - (row + 1) / SHOP_ROWS + e, (col + 1) / SHOP_COLS - e, 1 - row / SHOP_ROWS - e];
}

function shopSigns() {
  const W = 1024, H = 512, cw = W / SHOP_COLS, ch = H / SHOP_ROWS;
  const rng = makeRng(911);
  const { c, ctx } = canvas(W, H);
  const N = noiseTiles();
  const boards = ['#2a2420', '#1e2a2a', '#3a2620', '#2a2a34', '#c8bea8', '#3a3020', '#14181c', '#5a1e18'];
  const inks = ['#d8cdb8', '#c9a24a', '#e0d8c8', '#b8452e', '#9ac0b0', '#e8e0d0'];
  const fonts = [FONT, STENCIL, 'Georgia, "Times New Roman", serif'];
  SHOP_SIGNS.forEach((name, i) => {
    const x = (i % SHOP_COLS) * cw, y = Math.floor(i / SHOP_COLS) * ch;
    const board = rng.pick(boards);
    const light = board === '#c8bea8';
    ctx.fillStyle = board;
    ctx.fillRect(x + 2, y + 2, cw - 4, ch - 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 4, y + 4, cw - 8, ch - 8);
    // letters gone missing
    let text = name.split('').map((ch2) => (ch2 !== ' ' && rng() < 0.12 ? ' ' : ch2)).join('');
    if (rng() < 0.15) text = text.slice(0, Math.max(3, Math.floor(text.length * 0.6)));
    signText(ctx, text, x + 8, y + ch / 2 + 2, cw - 16, 40, light ? '#3a2a20' : rng.pick(inks), { font: rng.pick(fonts) });
    overlay(ctx, N.blotch, x, y, cw, ch, 0.55, 'multiply', 0.7);
    overlay(ctx, N.grain, x, y, cw, ch, 0.3, 'overlay');
    // rust drips from the fixings
    for (let k = 0; k < 3; k++) {
      const g = ctx.createLinearGradient(0, y + 8, 0, y + ch);
      g.addColorStop(0, 'rgba(90,40,20,0.5)');
      g.addColorStop(1, 'rgba(90,40,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + 10 + rng() * (cw - 20), y + 8, 2 + rng() * 3, ch - 10);
    }
  });
  return toTexture(c, { repeat: false });
}

// --- graffiti ----------------------------------------------------------------------------------

export const GRAFFITI_SLOTS = { cols: 4, rows: 4, w: 512, h: 256 };

export function graffitiUV(slot) {
  const { cols, rows } = GRAFFITI_SLOTS;
  const col = slot % cols, row = Math.floor(slot / cols);
  const e = 0.002;
  return [col / cols + e, 1 - (row + 1) / rows + e, (col + 1) / cols - e, 1 - row / rows - e];
}

// Sprayed text: jittered passes with soft overspray, plus drips running down from the letters.
function spray(ctx, rng, text, x, y, w, h, color, size, opts = {}) {
  const lines = text.split('\n');
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(opts.rot ?? (rng() - 0.5) * 0.12);
  ctx.font = `bold ${size}px ${opts.font || FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = size * 1.05;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const scale = Math.min(1, (w * 0.92) / Math.max(...widths));
  ctx.scale(scale, 1);
  const y0 = (-(lines.length - 1) * lh) / 2;
  // overspray halo
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.35;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, 0, y0 + i * lh));
  ctx.shadowBlur = size * 0.08;
  ctx.globalAlpha = 0.85;
  for (let pass = 0; pass < 3; pass++) {
    lines.forEach((l, i) => ctx.fillText(l, (rng() - 0.5) * 3, y0 + i * lh + (rng() - 0.5) * 3));
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.8;
  // drips
  for (let i = 0; i < lines.length; i++) {
    const half = (widths[i] / 2) * 0.95;
    const n = Math.floor(widths[i] / 40);
    for (let k = 0; k < n; k++) {
      if (rng() < 0.45) continue;
      const dx = -half + rng() * half * 2;
      const len = 6 + rng() * size * 0.9;
      const top = y0 + i * lh + size * 0.3;
      ctx.fillRect(dx, top, 2.2, len);
      ctx.beginPath();
      ctx.arc(dx + 1.1, top + len, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export const GRAFFITI = {
  stayLow: 0,
  dontRun: 1,
  face: 2,
  calls: 3,
  bridge: 4,
  names: 5,
  light: 6,
  noise: 7,
  move: 8,
  through: 9,
  eye: 10,
  tally: 11,
  gate: 12,
  quiet: 13,
  here: 14,
  tags: 15,
};

function graffiti() {
  const { cols, w: SW, h: SH } = GRAFFITI_SLOTS;
  const { c, ctx } = canvas(SW * cols, SH * 4);
  const rng = makeRng(601);
  ctx.clearRect(0, 0, c.width, c.height);
  const RED = '#c4160f', WHITE = '#e3ddd0', BLACK = '#0d0b0b', YELLOW = '#d6b030';
  const slot = (i) => [(i % cols) * SW, Math.floor(i / cols) * SH];
  const put = (i, text, color, size, opts) => {
    const [x, y] = slot(i);
    spray(ctx, rng, text, x + 8, y + 8, SW - 16, SH - 16, color, size, opts);
  };
  put(GRAFFITI.stayLow, 'STAY LOW', RED, 110);
  put(GRAFFITI.dontRun, "THEY DON'T\nRUN", WHITE, 84);
  put(GRAFFITI.face, "DON'T LET THEM\nSEE YOUR FACE", RED, 70);
  put(GRAFFITI.calls, 'WHEN IT CALLS\nTHEY LISTEN', WHITE, 78);
  put(GRAFFITI.bridge, 'BRIDGE → OUT', YELLOW, 92);
  put(GRAFFITI.light, 'STAY OUT OF\nTHE LIGHT', WHITE, 78);
  put(GRAFFITI.noise, 'NOISE PULLS\nTHEM', RED, 84);
  put(GRAFFITI.move, 'MOVE WHEN\nIT CALLS', RED, 84);
  put(GRAFFITI.through, 'THROUGH →', WHITE, 100);
  put(GRAFFITI.gate, 'THE GATE\nIS LOUD', WHITE, 84);
  put(GRAFFITI.quiet, 'QUIET WAY \u2193', YELLOW, 92);
  put(GRAFFITI.here, 'WE WERE HERE', WHITE, 74, { rot: -0.18 });
  // Names, crossed out, then the line under them.
  {
    const [x, y] = slot(GRAFFITI.names);
    ctx.save();
    ctx.font = `bold 30px ${STENCIL}`;
    ctx.fillStyle = 'rgba(220,215,205,0.75)';
    ctx.strokeStyle = 'rgba(190,20,15,0.85)';
    ctx.lineWidth = 4;
    for (let k = 0; k < 9; k++) {
      const nx = x + 24 + (k % 3) * 160, ny = y + 34 + Math.floor(k / 3) * 40;
      // Names you cannot read: scribbled strokes where letters should be.
      ctx.beginPath();
      let sx = nx;
      for (let s = 0; s < 10; s++) {
        ctx.moveTo(sx, ny + (rng() - 0.5) * 6);
        ctx.lineTo(sx + 6 + rng() * 6, ny - 10 + rng() * 20);
        sx += 11;
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(220,215,205,0.7)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(nx - 6, ny);
      ctx.lineTo(nx + 120, ny - 4);
      ctx.stroke();
    }
    ctx.restore();
    spray(ctx, rng, 'NOBODY REMEMBERS THE NAMES', x + 8, y + 150, SW - 16, 96, RED, 54, { rot: 0.02 });
  }
  // An eye with a bar through it
  {
    const [x, y] = slot(GRAFFITI.eye);
    ctx.save();
    ctx.translate(x + SW / 2, y + SH / 2);
    ctx.strokeStyle = RED;
    ctx.fillStyle = RED;
    ctx.lineWidth = 12;
    ctx.shadowColor = RED;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(-170, 0);
    ctx.quadraticCurveTo(0, -150, 170, 0);
    ctx.quadraticCurveTo(0, 150, -170, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(-180, 100);
    ctx.lineTo(180, -100);
    ctx.stroke();
    ctx.restore();
  }
  // Tally marks
  {
    const [x, y] = slot(GRAFFITI.tally);
    ctx.save();
    ctx.strokeStyle = 'rgba(225,220,210,0.8)';
    ctx.lineWidth = 6;
    for (let g = 0; g < 7; g++) {
      const gx = x + 30 + g * 66, gy = y + 60 + (g % 2) * 70;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(gx + k * 12, gy);
        ctx.lineTo(gx + k * 12 + 2, gy + 60);
        ctx.stroke();
      }
      if (g < 6) {
        ctx.beginPath();
        ctx.moveTo(gx - 6, gy + 50);
        ctx.lineTo(gx + 46, gy + 8);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // Generic tags
  {
    const [x, y] = slot(GRAFFITI.tags);
    for (let k = 0; k < 5; k++) {
      ctx.strokeStyle = rng.pick([RED, WHITE, BLACK, YELLOW]);
      ctx.lineWidth = 5 + rng() * 5;
      ctx.beginPath();
      let tx = x + 20 + rng() * 300, ty = y + 40 + rng() * 170;
      ctx.moveTo(tx, ty);
      for (let s = 0; s < 8; s++) {
        tx += 10 + rng() * 16;
        ty += (rng() - 0.5) * 50;
        ctx.quadraticCurveTo(tx - 10, ty - 30, tx, ty);
      }
      ctx.stroke();
    }
  }
  const t = toTexture(c, { repeat: false });
  return t;
}

// --- misc ---------------------------------------------------------------------------------------

function chainLink() {
  const S = 128;
  const { c, ctx } = canvas(S);
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(150,150,150,1)';
  ctx.lineWidth = 3;
  const n = 4, step = S / n;
  for (let i = -n; i <= n * 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + S, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step + S, 0);
    ctx.lineTo(i * step, S);
    ctx.stroke();
  }
  const t = toTexture(c, { srgb: true });
  return t;
}

// Equirectangular red-sky reflection map for glossy things (glass, paint, puddles).
function skyReflection() {
  const W = 256, H = 128;
  const { c, ctx } = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2a0604');
  g.addColorStop(0.3, '#4a0e08');
  g.addColorStop(0.47, '#8a2a12');
  g.addColorStop(0.5, '#3a0e08');
  g.addColorStop(0.6, '#0c0404');
  g.addColorStop(1, '#030101');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // skyline cut into the horizon
  const rng = makeRng(707);
  ctx.fillStyle = '#120404';
  let x = 0;
  while (x < W) {
    const w = 3 + rng() * 10, h = 3 + rng() * 18;
    ctx.fillRect(x, H * 0.5 - h, w, h);
    x += w;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

let CACHE = null;

export function createLevelTextures() {
  if (CACHE) return CACHE;
  const t0 = performance.now();
  const brick = facadeBase('brick', 1001);
  const office = facadeBase('concrete', 1002);
  const stone = facadeBase('stone', 1003);
  const store = storefronts();
  CACHE = {
    facade: { brick, concrete: office, stone },
    store,
    road: road(),
    asphalt: asphalt(),
    paving: paving(),
    pavers: pavers(),
    grass: deadGrass(),
    concrete: concrete(),
    grime: grime(),
    decals: decals(),
    signs: signs(),
    graffiti: graffiti(),
    shopSigns: shopSigns(),
    chain: chainLink(),
    sky: skyReflection(),
  };
  CACHE.buildMs = performance.now() - t0;
  return CACHE;
}
