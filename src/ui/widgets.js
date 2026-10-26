// In-game HUD widgets. Each owns a bit of DOM inside the in-game layer and is advanced by
// update(dt) from the Hud while playing (so they also run under game.simulate()).
import { angleDiff, clamp, damp, dirToYaw, lerp, smoothstep } from '../core/math.js';
import { el, envelope, richLine, setAttr, setStyle, setText, svgEl, toggleClass } from './dom.js';
import { Typewriter } from './typewriter.js';
import { HUD_TEXT, TUTORIAL } from './text.js';

const PALE = [238, 228, 218];
const HOT = [248, 140, 98];
const RED = [230, 52, 30];
const AMBER = [228, 156, 112];

const HUNTING = new Set(['chase', 'grab']);

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1).toFixed(3)})`;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)].map(Math.round);
const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

// Accepts 'E — pick up bottle', '[E] pick up bottle' or 'pick up bottle'.
export function cleanPrompt(text) {
  return String(text ?? '').replace(/^\s*(?:\[E\]\s*[—–:-]?|E\s*[—–:-])\s*/, '').trim() || 'interact';
}

export function formatClock(seconds, withHours = false) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return withHours ? `${pad2(h)}:${pad2(m)}:${pad2(r)}` : `${h ? h + ':' + pad2(m) : m}:${pad2(r)}`;
}

/** Arcs around the crosshair pointing at every snatcher that has noticed the player. */
export class DetectionRing {
  constructor(parent) {
    this.canvas = el('canvas', 'wic-ring', parent);
    this.ctx = this.canvas.getContext('2d');
    this.tracks = new Map();
    this.flashes = new Map();
    this.time = 0;
    this.dirty = true;
    this.resize();
  }

  resize() {
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    this.radius = Math.round(clamp(vmin * 0.165, 62, 128));
    this.size = (this.radius + 36) * 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this.dirty = true;
    this.draw();
  }

  flash(enemy) {
    if (enemy) this.flashes.set(enemy.id ?? enemy, 1);
  }

  clear() {
    this.tracks.clear();
    this.flashes.clear();
    this.dirty = true;
    this.draw();
  }

  update(dt, list, player) {
    this.time += dt;
    for (const t of this.tracks.values()) t.live = false;
    for (let i = 0; i < list.length; i++) {
      const ind = list[i];
      if (!ind) continue;
      const key = ind.enemy?.id ?? ind.enemy ?? i;
      const det = clamp(Number(ind.detection) || 0, 0, 1);
      const state = ind.state ?? ind.enemy?.state ?? '';
      const relevant = HUNTING.has(state) || state === 'search' || det > 0.03;
      let t = this.tracks.get(key);
      if (!t) {
        if (!relevant) continue;
        t = { det: 0, alpha: 0, flash: 0, bearing: 0, near: 1, state };
        this.tracks.set(key, t);
      }
      t.live = relevant;
      t.state = state;
      t.bearing = Number.isFinite(ind.bearing) ? ind.bearing : fallbackBearing(ind.enemy, player, t.bearing);
      t.det = damp(t.det, det, 10, dt);
      const d = Number(ind.distance);
      t.near = Number.isFinite(d) ? clamp(1.3 - d / 34, 0.5, 1) : 1;
      const f = this.flashes.get(key);
      if (f) {
        t.flash = f;
        this.flashes.delete(key);
      }
    }
    for (const [key, t] of this.tracks) {
      t.alpha = damp(t.alpha, t.live ? 1 : 0, t.live ? 9 : 3.5, dt);
      t.flash = Math.max(0, t.flash - dt * 1.4);
      if (!t.live && t.alpha < 0.01) this.tracks.delete(key);
    }
    this.flashes.clear();
    this.draw();
  }

  draw() {
    const { ctx, size, dpr } = this;
    if (!this.tracks.size) {
      if (this.dirty) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.dirty = false;
      }
      return;
    }
    this.dirty = true;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const c = size / 2;
    const maxHalf = 0.27;
    for (const t of this.tracks.values()) {
      const chase = HUNTING.has(t.state);
      const search = !chase && t.state === 'search';
      const det = chase ? 1 : t.det;
      let a = t.alpha * t.near;
      if (search) a *= 0.5 + 0.22 * Math.sin(this.time * 3.4);
      if (a < 0.01) continue;
      const col = chase ? RED : search ? AMBER : mix(PALE, HOT, smoothstep(0.55, 1, det));
      // + bearing = left of forward; screen up = forward.
      const ang = Math.atan2(-Math.cos(t.bearing), -Math.sin(t.bearing));
      const pulse = chase ? Math.sin(this.time * 8.5) * 1.6 : 0;
      const R = this.radius + pulse + t.flash * 8;

      // Faint full-length track: the meter this enemy's attention fills.
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = rgba(col, 0.22 * a);
      ctx.beginPath();
      ctx.arc(c, c, R, ang - maxHalf, ang + maxHalf);
      ctx.stroke();

      // Filled part grows from the centre outward with detection.
      const half = chase ? maxHalf + 0.05 : lerp(0.035, maxHalf, det);
      ctx.lineWidth = chase ? 4.5 : lerp(2, 4, det);
      ctx.strokeStyle = rgba(col, a * (chase ? 1 : lerp(0.6, 1, det)));
      ctx.shadowColor = rgba(col, 0.85 * a);
      ctx.shadowBlur = (chase ? 14 : 3 + det * 9) * dpr;
      ctx.beginPath();
      ctx.arc(c, c, R, ang - half, ang + half);
      ctx.stroke();

      // Chevrons point outward at whoever is about to (or already does) see you.
      const k = chase ? 1 : smoothstep(0.72, 0.95, det);
      if (k > 0.01) {
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = rgba(col, a * k);
        chevron(ctx, c, ang, R + 9, 5);
        if (chase) chevron(ctx, c, ang, R + 16 + pulse, 5);
      }
    }
    ctx.shadowBlur = 0;
  }
}

function chevron(ctx, c, ang, r, w) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const px = -dy, py = dx;
  ctx.beginPath();
  ctx.moveTo(c + dx * r + px * w, c + dy * r + py * w);
  ctx.lineTo(c + dx * (r + 5), c + dy * (r + 5));
  ctx.lineTo(c + dx * r - px * w, c + dy * r - py * w);
  ctx.stroke();
}

function fallbackBearing(enemy, player, prev) {
  const p = enemy?.position;
  if (!p || !player?.position) return prev;
  return angleDiff(player.yaw || 0, dirToYaw(p.x - player.position.x, p.z - player.position.z));
}

/** Centre dot, hold-progress ring and the "[E] ..." interaction prompt. */
export class Crosshair {
  constructor(parent) {
    this.el = el('div', 'wic-cross', parent);
    el('div', 'wic-cross__dot', this.el);
    this.hold = svgEl('svg', { class: 'wic-hold', viewBox: '-21 -21 42 42', 'aria-hidden': 'true' }, this.el);
    this.circ = 2 * Math.PI * 15;
    svgEl('circle', { class: 'wic-hold__track', r: 15 }, this.hold);
    this.bar = svgEl('circle', {
      class: 'wic-hold__bar', r: 15, 'stroke-dasharray': this.circ.toFixed(2), 'stroke-dashoffset': this.circ.toFixed(2),
    }, this.hold);
    this.prompt = el('div', 'wic-prompt', parent);
    this.holdLabel = el('span', 'wic-prompt__hold', this.prompt, HUD_TEXT.holdPrefix);
    el('kbd', 'wic-kbd', this.prompt, 'E');
    this.label = el('span', 'wic-prompt__label', this.prompt);
    this.vis = 0;
  }

  update(dt, player) {
    const focus = player?.focus || null;
    if (focus) {
      const isHold = (focus.holdTime || 0) > 0;
      setText(this.label, cleanPrompt(focus.prompt));
      setStyle(this.holdLabel, 'display', isHold ? 'inline' : 'none');
      toggleClass(this.hold, 'is-on', isHold);
    } else {
      toggleClass(this.hold, 'is-on', false);
    }
    toggleClass(this.el, 'is-focus', !!focus);
    this.vis = damp(this.vis, focus ? 1 : 0, focus ? 14 : 8, dt);
    setStyle(this.prompt, 'opacity', this.vis < 0.01 ? 0 : this.vis);
    const p = clamp(player?.holdProgress || 0, 0, 1);
    setAttr(this.bar, 'stroke-dashoffset', (this.circ * (1 - p)).toFixed(2));
  }

  reset() {
    this.vis = 0;
    setStyle(this.prompt, 'opacity', 0);
    toggleClass(this.hold, 'is-on', false);
  }
}

/** Visibility eye (light level), footstep noise ripples and the stamina bar. */
export class EyeMeter {
  constructor(parent) {
    this.el = el('div', 'wic-eye', parent);
    const svg = svgEl('svg', { class: 'wic-eye__svg', viewBox: '-90 -32 180 64', 'aria-hidden': 'true' }, this.el);
    const clip = svgEl('clipPath', { id: 'wic-eye-clip' }, svgEl('defs', null, svg));
    this.clipShape = svgEl('path', {}, clip);
    const ringGroup = svgEl('g', null, svg);
    this.rings = [];
    for (let i = 0; i < 7; i++) {
      const node = svgEl('ellipse', { class: 'wic-eye__ring', cx: 0, cy: 0, rx: 0, ry: 0, opacity: 0 }, ringGroup);
      this.rings.push({ node, active: false, age: 0, life: 1, r0: 24, r1: 30, loud: 0.5 });
    }
    this.glyph = svgEl('g', { class: 'wic-eye__glyph', transform: 'scale(1.18)' }, svg);
    this.white = svgEl('path', { class: 'wic-eye__white' }, this.glyph);
    const irisGroup = svgEl('g', { 'clip-path': 'url(#wic-eye-clip)' }, this.glyph);
    this.iris = svgEl('circle', { class: 'wic-eye__iris', cx: 0, cy: -1, r: 7.6 }, irisGroup);
    this.pupil = svgEl('circle', { class: 'wic-eye__pupil', cx: 0, cy: -1, r: 2.8 }, irisGroup);
    this.lid = svgEl('path', { class: 'wic-eye__lid' }, this.glyph);
    this.lashes = svgEl('g', null, this.glyph);
    for (const [x1, y1, x2, y2] of [[-12, 2.2, -14.5, 7], [0, 2.6, 0, 8.4], [12, 2.2, 14.5, 7]]) {
      svgEl('line', { class: 'wic-eye__lash', x1, y1, x2, y2 }, this.lashes);
    }
    this.stamina = el('div', 'wic-stamina', this.el);
    this.staminaFill = el('div', 'wic-stamina__fill', this.stamina);
    this.open = 0;
    this.lit = false;
    this.staminaVis = 0;
    this.exhaustFlash = 0;
    this.time = 0;
    this.drawEye(0);
  }

  drawEye(o) {
    const up = (5 - o * 27).toFixed(2);
    const lo = (5 + o * 13).toFixed(2);
    const d = `M-22,0 Q0,${up} 22,0 Q0,${lo} -22,0 Z`;
    setAttr(this.white, 'd', d);
    setAttr(this.lid, 'd', d);
    setAttr(this.clipShape, 'd', d);
    setAttr(this.lashes, 'opacity', (1 - smoothstep(0, 0.3, o)).toFixed(3));
    setAttr(this.pupil, 'r', lerp(2.2, 3.4, o).toFixed(2));
    setAttr(this.glyph, 'opacity', lerp(0.42, 1, o).toFixed(3));
  }

  // radius in metres (already scaled by the noise mask), loudness 0..1.
  ripple(radius, loudness = 0.5, breath = false) {
    let r = this.rings.find((x) => !x.active);
    if (!r) r = this.rings.reduce((a, b) => (a.age > b.age ? a : b));
    r.active = true;
    r.age = 0;
    r.life = breath ? 1.15 : 0.9;
    r.r0 = 27;
    r.r1 = 30 + Math.max(0, radius) * 3.1;
    r.loud = clamp(loudness, 0.2, 1);
    r.node.classList.toggle('is-breath', breath);
  }

  exhaust() {
    this.exhaustFlash = 1;
  }

  reset() {
    for (const r of this.rings) {
      r.active = false;
      setAttr(r.node, 'opacity', 0);
    }
  }

  update(dt, player) {
    this.time += dt;
    const light = clamp(player?.lightLevel ?? 0.15, 0, 1);
    this.open = damp(this.open, smoothstep(0.2, 0.62, light), 7, dt);
    this.drawEye(this.open);
    if (this.lit ? this.open < 0.6 : this.open > 0.74) {
      this.lit = !this.lit;
      toggleClass(this.el, 'is-lit', this.lit);
    }

    for (const r of this.rings) {
      if (!r.active) continue;
      r.age += dt;
      const k = r.age / r.life;
      if (k >= 1) {
        r.active = false;
        setAttr(r.node, 'opacity', 0);
        continue;
      }
      const e = 1 - (1 - k) ** 3;
      const rx = lerp(r.r0, r.r1, e);
      setAttr(r.node, 'rx', rx.toFixed(1));
      setAttr(r.node, 'ry', (rx * 0.36).toFixed(1));
      setAttr(r.node, 'opacity', ((1 - k) ** 1.4 * r.loud * 0.85).toFixed(3));
    }

    const stamina = clamp(player?.stamina ?? 1, 0, 1);
    const exhausted = !!player?.exhausted;
    const show = stamina < 0.995 || exhausted;
    this.staminaVis = damp(this.staminaVis, show ? 1 : 0, show ? 10 : 2.2, dt);
    this.exhaustFlash = Math.max(0, this.exhaustFlash - dt * 1.5);
    let vis = this.staminaVis;
    if (exhausted) vis *= 0.55 + 0.45 * (Math.sin(this.time * 18) > 0 ? 1 : 0.2);
    setStyle(this.stamina, 'opacity', clamp(vis + this.exhaustFlash * 0.5, 0, 1));
    setStyle(this.staminaFill, 'transform', `scaleX(${stamina.toFixed(3)})`);
    toggleClass(this.stamina, 'is-exhausted', exhausted);
  }
}

/** Bottle glyph and count, bottom right. */
export class BottleCounter {
  constructor(parent) {
    this.el = el('div', 'wic-bottles', parent);
    const icon = svgEl('svg', { class: 'wic-bottles__icon', viewBox: '0 0 11 28', 'aria-hidden': 'true' }, this.el);
    svgEl('path', {
      d: 'M3.7,0.8 H7.3 V8.4 C7.3,10.4 10.4,11.2 10.4,14 V25.4 C10.4,26.6 9.8,27.2 8.7,27.2 H2.3 C1.2,27.2 0.6,26.6 0.6,25.4 V14 C0.6,11.2 3.7,10.4 3.7,8.4 Z',
    }, icon);
    this.count = el('span', 'wic-bottles__count', this.el);
    this.last = null;
    this.bump = 0;
    this.denied = 0;
  }

  deny() {
    this.denied = 0.7;
    this.bump = 0.5;
  }

  update(dt, n) {
    const count = Math.max(0, n | 0);
    if (count !== this.last) {
      if (this.last !== null) this.bump = 1;
      this.last = count;
      setText(this.count, `× ${count}`);
    }
    this.bump = Math.max(0, this.bump - dt * 3.5);
    this.denied = Math.max(0, this.denied - dt);
    const s = 1 + 0.24 * this.bump * this.bump;
    const shake = this.denied > 0 ? Math.sin(this.denied * 60) * 3 * this.denied : 0;
    setStyle(this.el, 'transform', `translateX(${shake.toFixed(1)}px) scale(${s.toFixed(3)})`);
    toggleClass(this.el, 'is-empty', count === 0 && this.denied <= 0);
    toggleClass(this.el, 'is-denied', this.denied > 0);
  }
}

const CARD_IN = 1.2, CARD_HOLD = 4, CARD_OUT = 1.8, CARD_TOTAL = CARD_IN + CARD_HOLD + CARD_OUT;

/** Big letter-spaced zone name + objective, fades in and out on zone:enter. */
export class ZoneCard {
  constructor(parent) {
    this.el = el('div', 'wic-zone', parent);
    this.index = el('div', 'wic-zone__index', this.el);
    this.name = el('div', 'wic-zone__name', this.el);
    el('div', 'wic-rule wic-zone__rule', this.el);
    this.obj = el('div', 'wic-zone__obj', this.el);
    this.t = -1;
    this.rate = 1;
  }

  show(zone, index, total) {
    const i = Number.isFinite(index) ? index : zone?.index ?? 0;
    setText(this.index, total > i ? `${pad2(i + 1)} / ${pad2(total)}` : pad2(i + 1));
    setText(this.name, zone?.name || `Zone ${i + 1}`);
    const obj = zone?.objective || '';
    setText(this.obj, obj);
    setStyle(this.obj, 'display', obj ? 'block' : 'none');
    this.t = 0;
    this.rate = 1;
  }

  // Get out of the way quickly (spotted): fade out from the current opacity, fast.
  dismiss() {
    if (this.t < 0) return;
    const a = envelope(this.t, CARD_IN, CARD_HOLD, CARD_OUT);
    this.t = Math.max(this.t, CARD_IN + CARD_HOLD + (1 - a) * CARD_OUT);
    this.rate = 3;
  }

  hide() {
    this.t = -1;
    setStyle(this.el, 'opacity', 0);
  }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt * this.rate;
    if (this.t >= CARD_TOTAL) {
      this.hide();
      return;
    }
    setStyle(this.el, 'opacity', envelope(this.t, CARD_IN, CARD_HOLD, CARD_OUT));
    const spacing = 0.3 + 0.12 * smoothstep(0, CARD_TOTAL, this.t);
    setStyle(this.name, 'letterSpacing', `${spacing.toFixed(3)}em`);
    setStyle(this.name, 'marginRight', `${(-spacing).toFixed(3)}em`);
  }
}

/** Queue of typewritten messages (graffiti read, hints) in the lower third. */
export class MessageToasts {
  constructor(parent) {
    this.el = el('div', 'wic-msg', parent);
    this.text = el('span', 'wic-msg__text', this.el);
    this.tw = new Typewriter(this.text, { cps: 40 });
    this.queue = [];
    this.current = null;
    this.gap = 0;
  }

  push(text, duration) {
    const t = String(text ?? '').trim();
    if (!t) return;
    if (this.current?.text === t || this.queue.some((m) => m.text === t)) return;
    const auto = clamp(2.2 + t.length * 0.045, 3, 7);
    this.queue.push({ text: t, hold: Number.isFinite(duration) && duration > 0 ? duration : auto, t: 0, held: 0, out: 0 });
    if (this.queue.length > 4) this.queue.shift();
  }

  get busy() {
    return !!this.current || this.queue.length > 0;
  }

  clear() {
    this.queue.length = 0;
    this.current = null;
    this.tw.clear();
    setStyle(this.el, 'opacity', 0);
  }

  update(dt) {
    if (!this.current) {
      this.gap -= dt;
      if (this.gap > 0 || !this.queue.length) return;
      this.current = this.queue.shift();
      this.tw.start(this.current.text, 0.2);
    }
    const m = this.current;
    m.t += dt;
    let a = Math.min(1, m.t / 0.3);
    if (this.tw.update(dt)) {
      m.held += dt;
      if (m.held > m.hold) {
        m.out += dt;
        a = Math.max(0, 1 - m.out / 0.8);
        if (m.out >= 0.8) {
          this.current = null;
          this.gap = 0.4;
          this.tw.clear();
        }
      }
    }
    setStyle(this.el, 'opacity', a);
  }
}

// First-zone sequence, shown in order, one at a time. A step whose action the player has
// already performed (`learned`) is skipped without being shown. None starts while something is
// hunting the player: that moment belongs to the chase tip.
const calm = (g) => !(g.director?.chasing > 0) && !((g.director?.threat ?? 0) > 0.5);
const SEQUENCE = [
  {
    id: 'move', ready: (g, s) => s.playTime > 2.5 && (g.level?.currentZone ?? 0) <= 0 && calm(g),
    learned: (g, s) => s.moved > 6, done: (g, s) => s.moved > 6, min: 3.5, max: 11,
  },
  {
    id: 'crouch', ready: (g, s) => s.playTime > 6 && s.idle > 1.6 && (g.level?.currentZone ?? 0) <= 1 && calm(g),
    learned: (g, s) => s.crouchedOnce, done: (g) => !!g.player?.crouched, min: 3, max: 12,
  },
  {
    id: 'throw', ready: (g, s) => s.idle > 1.2 && (g.player?.bottles ?? 0) > 0 && calm(g),
    learned: (g, s) => s.thrown, done: (g, s) => s.thrown, min: 3.5, max: 13,
  },
];
const ALWAYS = () => true;
const CONTEXTUAL = {
  light: { min: 4.5, max: 6, done: ALWAYS, expires: 5 },
  noticed: { min: 4.5, max: 6.5, done: ALWAYS, expires: 4, urgent: 1 },
  chase: { min: 4, max: 6, done: ALWAYS, expires: 5, urgent: 2 },
};
const ZONE_HINT = { min: 5, max: 7, done: ALWAYS, expires: 30 };

/** Unobtrusive one-time hints above the eye: the first-zone tutorial, contextual tips and zone hints. */
export class Tutorial {
  constructor(parent) {
    this.el = el('div', 'wic-tut', parent);
    this.seen = new Set();
    this.queue = []; // { id, text, spec, at, delay }
    this.current = null;
    this.playTime = 0;
    this.idle = 0; // seconds since the last hint closed
    this.moved = 0;
    this.thrown = false;
    this.crouchedOnce = false;
    this.quiet = 0; // seconds since another text channel (level messages) was last busy
    this.last = null;
  }

  enqueue(id, text, spec, delay = 0) {
    if (!text || this.seen.has(id) || this.current?.id === id || this.queue.some((q) => q.id === id)) return;
    this.queue.push({ id, text, spec, at: this.playTime, delay });
  }

  // Built-in contextual tip ('light', 'noticed', 'chase'). An urgent one goes first and cuts
  // short whatever less urgent text is on screen: it is about what is happening right now.
  trigger(id) {
    const spec = CONTEXTUAL[id];
    if (!spec?.urgent || this.seen.has(id) || this.current?.id === id) {
      this.enqueue(id, TUTORIAL[id], spec);
      return;
    }
    this.queue = this.queue.filter((q) => q.id !== id);
    this.queue.unshift({ id, text: TUTORIAL[id], spec, at: this.playTime, delay: 0 });
    this.queue.sort((a, b) => (b.spec.urgent ?? 0) - (a.spec.urgent ?? 0));
    if (this.current && this.current.out < 0 && (this.current.spec.urgent ?? 0) < spec.urgent) {
      // Not counted as seen: an interrupted lesson comes back later.
      if (!this.current.spec.urgent && this.current.t < this.current.spec.min) this.seen.delete(this.current.id);
      this.current.out = 0;
      this.current.fast = true;
    }
  }

  // A level-authored zone hint, shown a few seconds after entering the zone.
  zoneHint(index, text) {
    this.enqueue(`zone:${index}`, String(text ?? '').trim(), { ...ZONE_HINT, zone: index }, 3.5);
  }

  // busy: another text channel (a level message) is on screen; new hints wait for it so the
  // player is never handed two pieces of text to read at once.
  update(dt, game, busy = false) {
    const p = game.player;
    this.playTime += dt;
    if (p?.position) {
      if (this.last) this.moved += Math.hypot(p.position.x - this.last.x, p.position.z - this.last.z);
      this.last = { x: p.position.x, z: p.position.z };
    }
    if (p?.crouched) this.crouchedOnce = true;
    if (!this.current) this.idle += dt;
    this.quiet = busy ? 0 : this.quiet + dt;

    let next = SEQUENCE.find((s) => !this.seen.has(s.id));
    while (next && !this.current && next.learned(game, this)) {
      this.seen.add(next.id); // already knows it: don't teach it
      next = SEQUENCE.find((s) => !this.seen.has(s.id));
    }
    if (next && !this.current && !this.queue.length && next.ready(game, this)) this.enqueue(next.id, TUTORIAL[next.id], next);
    if ((p?.lightLevel ?? 0) > 0.55 && this.playTime > 5) this.trigger('light');

    // A tip that could not be shown soon after its moment has passed is dropped.
    // ...and so is a zone's hint once the player has left that zone.
    const zone = game.level?.currentZone;
    const stale = (spec) => spec.zone != null && zone != null && zone !== spec.zone;
    if (this.queue.length) this.queue = this.queue.filter((q) => (!q.spec.expires || this.playTime - q.at < q.spec.expires) && !stale(q.spec));
    if (this.current && this.current.out < 0 && stale(this.current.spec)) this.current.out = 0;
    const urgent = this.queue[0]?.spec.urgent;
    if (!this.current && (urgent || (this.idle > 0.8 && this.quiet > 0.8))) {
      const i = this.queue.findIndex((q) => this.playTime - q.at >= q.delay);
      if (i >= 0) {
        const q = this.queue.splice(i, 1)[0];
        this.current = { id: q.id, spec: q.spec, t: 0, out: -1 };
        this.seen.add(q.id);
        richLine(this.el, q.text);
      }
    }
    const c = this.current;
    if (!c) return;
    c.t += dt;
    if (c.out < 0 && ((c.t > c.spec.min && c.spec.done(game, this)) || c.t > c.spec.max)) c.out = 0;
    let a = Math.min(1, c.t / 0.6);
    if (c.out >= 0) {
      const fade = c.fast ? 0.2 : 0.7;
      c.out += dt;
      a *= Math.max(0, 1 - c.out / fade);
      if (c.out >= fade) {
        this.current = null;
        this.idle = 0;
      }
    }
    setStyle(this.el, 'opacity', a);
  }

  // Respawn: fade out whatever is showing; sequence progress is kept.
  reset() {
    this.last = null;
    if (this.current && this.current.out < 0) this.current.out = 0;
  }
}

/** Found-footage "REC" tag with a timecode; marks checkpoints; glitches while the Leviathan calls. */
export class RecTag {
  constructor(parent) {
    this.el = el('div', 'wic-rec', parent);
    const line = el('div', 'wic-rec__line', this.el);
    this.dot = el('span', 'wic-rec__dot', line);
    el('span', null, line, 'REC');
    this.clock = el('span', 'wic-rec__time', line);
    this.mark = el('div', 'wic-rec__mark', this.el);
    el('span', 'wic-rec__diamond', this.mark);
    el('span', null, this.mark, HUD_TEXT.checkpoint);
    this.markT = -1;
    this.time = 0;
  }

  marked() {
    this.markT = 0;
  }

  update(dt, game) {
    this.time += dt;
    const calling = !!game.leviathan?.calling;
    setStyle(this.dot, 'opacity', this.time % 1.2 < 0.75 ? 1 : 0.15);
    let tc = formatClock(game.stats?.playTime ?? 0, true);
    if (calling && Math.random() < 0.4) tc = tc.replace(/\d/g, () => '0123456789#/%'[(Math.random() * 13) | 0]);
    setText(this.clock, tc);
    const jitter = calling && Math.random() < 0.3 ? (Math.random() * 4 - 2).toFixed(1) : 0;
    setStyle(this.el, 'transform', jitter ? `translateX(${jitter}px)` : 'none');
    if (this.markT >= 0) {
      this.markT += dt;
      setStyle(this.mark, 'opacity', envelope(this.markT, 0.5, 3, 1.2) * 0.85);
      if (this.markT > 4.7) this.markT = -1;
    }
  }
}

/** One-time notice when pointer lock is unavailable (sandboxed iframes etc). */
export class LockNotice {
  constructor(parent) {
    this.el = el('div', 'wic-notice', parent, HUD_TEXT.lockFailed);
    this.t = -1;
    this.shown = false;
  }

  show() {
    if (this.shown) return;
    this.shown = true;
    this.t = 0;
  }

  update(dt) {
    if (this.t < 0) return;
    this.t += dt;
    setStyle(this.el, 'opacity', envelope(this.t, 0.5, 6, 1.2));
    if (this.t > 7.7) this.t = -1;
  }
}

/** ?debug overlay: numbers for tuning. Every field is optional. */
export class DebugOverlay {
  constructor(parent) {
    this.el = el('pre', 'wic-debug', parent);
    this.acc = 1;
  }

  update(dt, game) {
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    setText(this.el, describe(game));
  }
}

const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '–');

function describe(g) {
  const p = g.player;
  const pos = p?.position;
  const zi = g.level?.currentZone;
  const zone = g.level?.zones?.[zi];
  const lev = g.leviathan;
  const dir = g.director;
  const lines = [
    `fps ${Math.round(g.fps || 0)}   ${g.state} ${f1(g.stateTime)}s   t ${f1(g.time)}`,
    `pos ${f2(pos?.x)} ${f2(pos?.z)}   yaw ${f2(p?.yaw)} pitch ${f2(p?.pitch)}`,
    `mode ${p?.mode ?? '–'}${p?.crouched ? ' (crouched)' : ''}   light ${f2(p?.lightLevel)}   stamina ${f2(p?.stamina)}${p?.exhausted ? ' EXH' : ''}`,
    `zone ${zi ?? '–'} ${zone?.name ?? ''}   bottles ${p?.bottles ?? '–'}`,
    `noiseMask ${f2(g.noiseMask)}   calling ${lev?.calling ? 'YES ' + f2(lev.callProgress) : 'no'}`,
    `threat ${f2(dir?.threat)}   chasing ${dir?.chasing ?? '–'}   spotted ${g.stats?.spotted ?? 0}  deaths ${g.stats?.deaths ?? 0}`,
  ];
  const list = Array.isArray(dir?.snatchers) ? dir.snatchers : [];
  if (list.length) {
    lines.push(`— snatchers (${list.length}) —`);
    const rows = list.map((s) => {
      const sp = s?.position;
      const d = sp && pos ? Math.hypot(sp.x - pos.x, sp.z - pos.z) : NaN;
      return { s, d };
    }).sort((a, b) => (Number.isFinite(a.d) ? a.d : 1e9) - (Number.isFinite(b.d) ? b.d : 1e9)).slice(0, 24);
    for (const { s, d } of rows) {
      const id = String(s?.id ?? s?.def?.id ?? '?').slice(0, 14).padEnd(14);
      const st = String(s?.state ?? '–').padEnd(11);
      lines.push(`${id} ${st} det ${f2(s?.detection)}  ${f1(d)}m`);
    }
  }
  return lines.join('\n');
}
