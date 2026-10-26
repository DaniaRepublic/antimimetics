// Full-screen states: title, intro, pause, dead and the ending. Each screen is shown/hidden by
// the Hud on game:state and advanced by update(dt).
import { clamp } from '../core/math.js';
import { el, keycaps, setAttr, setText, svgEl, toggleClass } from './dom.js';
import { Typewriter } from './typewriter.js';
import { CALIBRATE, CONTROLS, DEAD, DEATH_LINES, ENDING, INTRO, PAUSE, TITLE } from './text.js';
import { formatClock } from './widgets.js';

// Seconds before a resumed/retried pointer lock is allowed: browsers refuse to re-lock
// for about a second after the player leaves lock with Esc. Measured in real time as well as
// game time (whichever is further along): game time runs slow when frames are slow (dt is
// clamped), but the browser's cooldown does not.
export const RESUME_DELAY = 1.2;
export const RETRY_DELAY = 1.1;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

// Brightness (game.settings.brightness, 0.5..2, 1 = as graded): the atmosphere applies it as a
// display gamma of 1 / brightness, so the calibration mark gets the same curve.
export const BRIGHTNESS = { min: 0.5, max: 2, step: 0.05, fallback: 1 };
const MARK_LEVEL = 0.035; // display value of the calibration mark at brightness 1 (~9/255)
const formatBrightness = (v) => `${Math.round(v * 100)}%`;

// A labelled range input bound to game.settings[key]; saves on every change.
function settingSlider(game, parent, { label, key, min, max, step, fallback, format, onChange }) {
  const wrap = el('label', 'wic-slider', parent);
  el('span', 'wic-slider__label', wrap, label);
  const value = el('span', 'wic-slider__value', wrap);
  const input = el('input', 'wic-range', wrap);
  Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
  const paint = (v) => {
    value.textContent = format(v);
    input.style.setProperty('--p', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
    onChange?.(v);
  };
  // The game's input layer cancels arrow keys at window level while playing; keep them for a
  // focused slider in a menu.
  input.addEventListener('keydown', (e) => {
    if (SLIDER_KEYS.has(e.code) && game.state !== 'playing') e.stopPropagation();
  });
  input.addEventListener('input', () => {
    const v = clamp(parseFloat(input.value), min, max);
    paint(v);
    if (!game.settings) game.settings = {};
    game.settings[key] = v;
    game.saveSettings?.();
  });
  return {
    input,
    sync: (settings) => {
      const raw = Number(settings?.[key]);
      const v = clamp(Number.isFinite(raw) ? raw : fallback, min, max);
      input.value = String(v);
      paint(v);
    },
  };
}

function controlsList(parent) {
  const list = el('ul', 'wic-controls', parent);
  for (const [keys, label] of CONTROLS) {
    const item = el('li', null, list);
    keycaps(item, keys);
    el('span', null, item, label);
  }
  return list;
}

function button(parent, label, onClick) {
  const b = el('button', 'wic-btn', parent, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!b.disabled) onClick();
  });
  return b;
}

class Screen {
  constructor(hud, className) {
    this.hud = hud;
    this.game = hud.game;
    this.el = el('div', `wic-screen ${className}`, hud.root);
    this.visible = false;
  }

  show() {
    this.visible = true;
    this.shownAt = now();
    this.el.classList.add('is-on');
  }

  // Seconds this screen has been up (real time or game time, whichever is larger).
  get age() {
    return Math.max(this.game.stateTime ?? 0, (now() - (this.shownAt ?? now())) / 1000);
  }

  hide() {
    this.visible = false;
    this.el.classList.remove('is-on');
    // A button or slider left focused would swallow Space/Enter/arrows once play resumes.
    const active = document.activeElement;
    if (active && active !== document.body && this.el.contains(active)) active.blur?.();
  }

  update() {}
}

export class TitleScreen extends Screen {
  constructor(hud) {
    super(hud, 'wic-title');
    el('div', 'wic-title__shade', this.el);
    el('div', 'wic-scan', this.el);
    const inner = el('div', 'wic-title__inner', this.el);
    el('div', 'wic-title__file', inner, TITLE.file);
    const ref = el('div', 'wic-title__ref', inner);
    TITLE.ref.split('##').forEach((part, i) => {
      if (i) el('span', 'wic-redact', ref);
      ref.append(part);
    });
    const name = el('h1', 'wic-title__name', inner, TITLE.name);
    name.dataset.text = TITLE.name;
    const sub = el('p', 'wic-title__sub', inner, TITLE.subPre);
    el('i', null, sub, TITLE.subBook);
    el('div', 'wic-rule', inner);
    controlsList(inner);
    const foot = el('div', 'wic-title__foot', inner);
    el('span', 'wic-title__begin', foot, TITLE.begin);
    el('span', 'wic-title__phones', foot, TITLE.phones);
    this.buildCalibration();
    this.calibrating = false;
  }

  // One-time brightness check, shown in place of the title text on the first click.
  buildCalibration() {
    const c = el('div', 'wic-calib', this.el);
    el('div', 'wic-calib__tag', c, CALIBRATE.tag);
    el('h2', 'wic-calib__title', c, CALIBRATE.title);
    el('p', 'wic-calib__body', c, CALIBRATE.body);
    const swatch = el('div', 'wic-calib__swatch', c);
    const svg = svgEl('svg', { class: 'wic-calib__mark', viewBox: '-30 -16 60 32', 'aria-hidden': 'true' }, swatch);
    this.markShapes = [
      svgEl('path', { d: 'M-24,0 Q0,-22 24,0 Q0,16 -24,0 Z', fill: 'none', 'stroke-width': 2.2 }, svg),
      svgEl('circle', { cx: 0, cy: -1.5, r: 6.5, stroke: 'none' }, svg),
    ];
    this.calibSlider = settingSlider(this.game, c, {
      label: PAUSE.brightness, key: 'brightness', ...BRIGHTNESS, format: formatBrightness, onChange: (v) => this.paintMark(v),
    });
    el('p', 'wic-calib__aside', c, CALIBRATE.aside);
    const foot = el('div', 'wic-calib__foot', c);
    this.calibGo = button(foot, CALIBRATE.go, () => this.hud.finishCalibration());
    el('span', 'wic-calib__hint', foot, CALIBRATE.hint);
  }

  paintMark(brightness) {
    const v = Math.round(255 * MARK_LEVEL ** (1 / clamp(brightness, BRIGHTNESS.min, BRIGHTNESS.max)));
    const col = `rgb(${v},${Math.round(v * 0.93)},${Math.round(v * 0.9)})`;
    setAttr(this.markShapes[0], 'stroke', col);
    setAttr(this.markShapes[1], 'fill', col);
  }

  // Arrow keys while calibrating, whatever has focus.
  nudgeBrightness(dir) {
    const input = this.calibSlider.input;
    const v = clamp(parseFloat(input.value) + dir * BRIGHTNESS.step, BRIGHTNESS.min, BRIGHTNESS.max);
    input.value = String(+v.toFixed(2));
    input.dispatchEvent(new Event('input'));
  }

  startCalibration() {
    this.calibrating = true;
    this.calibSlider.sync(this.game.settings);
    toggleClass(this.el, 'is-calib', true);
    // Arrow keys work at once; a click elsewhere on the screen does nothing while calibrating.
    this.calibSlider.input.focus({ preventScroll: true });
  }

  hide() {
    super.hide();
    this.calibrating = false;
    toggleClass(this.el, 'is-calib', false);
  }
}

export class IntroScreen extends Screen {
  constructor(hud) {
    super(hud, 'wic-intro');
    const body = el('div', 'wic-intro__body', this.el);
    el('div', 'wic-intro__head', body, INTRO.head);
    const last = INTRO.lines.length - 1;
    this.lineEls = INTRO.lines.map((_, i) => el('p', `wic-intro__line${i === last ? ' is-final' : ''}`, body));
    this.tws = this.lineEls.map((node, i) => new Typewriter(node, { cps: i === last ? 16 : 40 }));
    this.skip = el('div', 'wic-intro__skip', this.el, INTRO.skip);
    this.tw = null;
    this.finished = true;
  }

  show() {
    super.show();
    this.lineEls.forEach((line, i) => {
      line.classList.remove('is-past', 'is-old');
      this.tws[i].prime(INTRO.lines[i]);
    });
    setText(this.skip, INTRO.skip);
    toggleClass(this.skip, 'is-wait', false);
    this.index = 0;
    this.gap = 1.0;
    this.after = 0;
    this.typing = false;
    this.finished = false;
  }

  beginLine() {
    const i = this.index;
    this.lineEls.forEach((line, k) => {
      line.classList.toggle('is-past', k < i && i - k <= 2);
      line.classList.toggle('is-old', k < i && i - k > 2);
    });
    this.tw = this.tws[i];
    this.tw.start(INTRO.lines[i]);
    this.typing = true;
  }

  update(dt) {
    if (this.finished) return;
    const n = INTRO.lines.length;
    if (this.typing) {
      if (this.tw.update(dt)) {
        this.typing = false;
        this.index++;
        this.gap = this.index === n - 1 ? 1.4 : 0.75;
      }
      return;
    }
    if (this.index < n) {
      this.gap -= dt;
      if (this.gap <= 0) this.beginLine();
      return;
    }
    this.after += dt;
    if (this.after < 3) return;
    // Starting without a fresh click would leave the mouse unlocked: auto-advance only when
    // the lock is already held (or unavailable anyway), otherwise ask for a click.
    const input = this.game.input;
    if (input?.locked || input?.pointerLockFailed) this.hud.finishIntro();
    else {
      setText(this.skip, INTRO.cont);
      toggleClass(this.skip, 'is-wait', true);
    }
  }
}

export class PauseScreen extends Screen {
  constructor(hud) {
    super(hud, 'wic-pause');
    const panel = el('div', 'wic-pause__panel', this.el);
    this.tag = el('div', 'wic-pause__tag', panel, PAUSE.tag);
    el('h2', 'wic-pause__title', panel, PAUSE.title);
    this.note = el('div', 'wic-pause__note', panel, PAUSE.relock);
    const menu = el('div', 'wic-menu', panel);
    this.resumeBtn = button(menu, PAUSE.resume, () => hud.resume());
    this.restartBtn = button(menu, PAUSE.restart, () => hud.restart());
    const settings = el('div', 'wic-settings', panel);
    const slider = (label, key, min, max, step, fallback, format) => settingSlider(this.game, settings, { label, key, min, max, step, fallback, format });
    this.sliders = [
      slider(PAUSE.brightness, 'brightness', BRIGHTNESS.min, BRIGHTNESS.max, BRIGHTNESS.step, BRIGHTNESS.fallback, formatBrightness),
      slider(PAUSE.sensitivity, 'sensitivity', 0.3, 3, 0.05, 1, (v) => `${v.toFixed(2)}×`),
      slider(PAUSE.volume, 'volume', 0, 1, 0.01, 0.8, (v) => `${Math.round(v * 100)}%`),
      slider(PAUSE.fov, 'fov', 60, 95, 1, 72, (v) => `${Math.round(v)}°`),
    ];
    controlsList(panel);
  }

  show() {
    super.show();
    const g = this.game;
    const zone = g.level?.zones?.[g.level?.currentZone]?.name;
    const parts = [PAUSE.tag, formatClock(g.stats?.playTime ?? 0, true)];
    if (zone) parts.push(zone);
    setText(this.tag, parts.join('  ·  '));
    for (const s of this.sliders) s.sync(g.settings);
    toggleClass(this.note, 'is-on', !!this.relockFailed);
    this.relockFailed = false;
    this.update();
  }

  get ready() {
    return this.visible && this.age >= RESUME_DELAY;
  }

  update() {
    const wait = !this.ready;
    if (this.resumeBtn.disabled !== wait) {
      this.resumeBtn.disabled = wait;
      this.restartBtn.disabled = wait;
    }
  }
}

export class DeadScreen extends Screen {
  constructor(hud) {
    super(hud, 'wic-dead');
    this.line = el('div', 'wic-dead__line', this.el);
    const retry = el('div', 'wic-dead__retry', this.el);
    el('span', null, retry, DEAD.retry);
    this.lastLine = -1;
  }

  show() {
    let i = Math.floor(Math.random() * DEATH_LINES.length);
    if (i === this.lastLine) i = (i + 1) % DEATH_LINES.length;
    this.lastLine = i;
    setText(this.line, DEATH_LINES[i]);
    toggleClass(this.el, 'is-ready', false);
    super.show();
  }

  get ready() {
    return this.visible && this.age > RETRY_DELAY;
  }

  update() {
    toggleClass(this.el, 'is-ready', this.ready);
  }
}

export class WonScreen extends Screen {
  constructor(hud) {
    super(hud, 'wic-won');
    el('div', 'wic-scan', this.el);
    const body = el('div', 'wic-won__body', this.el);
    this.lineEls = ENDING.lines.map(() => el('p', 'wic-won__line', body));
    this.tws = this.lineEls.map((node) => new Typewriter(node, { cps: 24 }));
    el('div', 'wic-won__end', body, ENDING.end);
    const stats = el('div', 'wic-won__stats', body);
    const stat = (label) => {
      const s = el('div', 'wic-stat', stats);
      el('div', 'wic-stat__k', s, label);
      return el('div', 'wic-stat__v', s);
    };
    this.statTime = stat(ENDING.stats.time);
    this.statSpotted = stat(ENDING.stats.spotted);
    this.statDeaths = stat(ENDING.stats.deaths);
    this.again = button(body, ENDING.again, () => window.location.reload());
    this.done = false;
  }

  show() {
    super.show();
    this.tws.forEach((tw, i) => tw.prime(ENDING.lines[i]));
    const st = this.game.stats || {};
    setText(this.statTime, formatClock(st.playTime));
    setText(this.statSpotted, String(st.spotted ?? 0));
    setText(this.statDeaths, String(st.deaths ?? 0));
    toggleClass(this.el, 'is-done', false);
    this.done = false;
    this.index = 0;
    this.gap = 2.6; // let the mist fade in first
    this.typing = false;
  }

  update(dt) {
    if (this.done) return;
    const n = this.lineEls.length;
    if (this.typing) {
      if (this.tw.update(dt)) {
        this.typing = false;
        this.index++;
        this.gap = this.index === 2 ? 1.3 : 0.6;
      }
      return;
    }
    this.gap -= dt;
    if (this.gap > 0) return;
    if (this.index < n) {
      this.tw = this.tws[this.index];
      this.tw.start(ENDING.lines[this.index]);
      this.typing = true;
    } else {
      this.done = true;
      toggleClass(this.el, 'is-done', true);
    }
  }
}
