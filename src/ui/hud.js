import { CONFIG } from '../config.js';
import { clamp, damp } from '../core/math.js';
import { el, setStyle, toggleClass } from './dom.js';
import { injectStyles } from './style.js';
import { DeadScreen, IntroScreen, PauseScreen, RESUME_DELAY, RETRY_DELAY, TitleScreen, WonScreen } from './screens.js';
import {
  BottleCounter, Crosshair, DebugOverlay, DetectionRing, EyeMeter, LockNotice, MessageToasts, RecTag, Tutorial, ZoneCard,
} from './widgets.js';

const NO_INDICATORS = [];
const STEP_NOISE = {
  crouch: [CONFIG.noise.crouchStep, 0.35],
  walk: [CONFIG.noise.walkStep, 0.6],
  sprint: [CONFIG.noise.sprintStep, 0.95],
};

// All DOM UI over the canvas: the screens for every game state plus the in-game HUD.
// The root never takes pointer events; only visible menu screens do.
export class Hud {
  constructor(game) {
    this.game = game;
    injectStyles();
    this.root = el('div', 'wic-hud', document.body);
    this.root.id = 'wic-hud';

    // In-game layer (pointer-events: none throughout).
    this.layer = el('div', 'wic-layer', this.root);
    this.edge = el('div', 'wic-edge', this.layer);
    this.ring = new DetectionRing(this.layer);
    this.cross = new Crosshair(this.layer);
    this.zoneCard = new ZoneCard(this.layer);
    this.messages = new MessageToasts(this.layer);
    this.tutorial = new Tutorial(this.layer);
    this.eye = new EyeMeter(this.layer);
    this.bottles = new BottleCounter(this.layer);
    this.rec = new RecTag(this.layer);
    this.notice = new LockNotice(this.layer);

    this.screens = {
      title: new TitleScreen(this),
      intro: new IntroScreen(this),
      paused: new PauseScreen(this),
      dead: new DeadScreen(this),
      won: new WonScreen(this),
    };
    this.debugOverlay = game.debug ? new DebugOverlay(this.root) : null;

    this.state = null;
    this.time = 0;
    this.edgeLevel = 0;
    this.edgeFlash = 0;
    this.zonesShown = new Set();
    this.bindBus();
    this.bindDom();
  }

  bindBus() {
    const { bus } = this.game;
    bus.on('game:state', ({ state, prev }) => this.setState(state, prev));
    bus.on('zone:enter', (e) => this.onZoneEnter(e));
    bus.on('game:checkpoint', () => this.rec.marked());
    bus.on('level:message', (e) => this.messages.push(e?.text, e?.duration));
    bus.on('player:footstep', (e) => this.onFootstep(e));
    bus.on('player:breath', () => {
      if (this.game.state === 'playing') this.eye.ripple(CONFIG.noise.landExhausted * this.maskFactor(), 0.6, true);
    });
    bus.on('player:throw', () => {
      this.tutorial.thrown = true;
    });
    bus.on('player:throw-empty', () => this.bottles.deny());
    bus.on('player:exhausted', () => this.eye.exhaust());
    bus.on('enemy:alert', (e) => {
      this.ring.flash(e?.enemy);
      this.edgeFlash = 1;
      this.zoneCard.dismiss(); // the chase arcs sweep the upper screen; clear the title text
      this.tutorial.trigger('chase');
    });
    bus.on('game:respawn', () => this.onRespawn());
  }

  bindDom() {
    // Under pointer lock every click targets the canvas, so "click anywhere" screens listen on window.
    window.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.ring.resize());
    // Playing without the mouse locked (e.g. ?autostart): a click on the canvas grabs it.
    this.game.renderer?.domElement?.addEventListener('mousedown', () => {
      const { state, input } = this.game;
      if (state === 'playing' && input && !input.locked && !input.pointerLockFailed) input.requestLock();
    });
  }

  setState(state, prev) {
    if (state === this.state) return;
    this.state = state;
    this.root.dataset.state = state;
    for (const [name, screen] of Object.entries(this.screens)) {
      if (name === state) screen.show(prev);
      else if (screen.visible) screen.hide();
    }
    toggleClass(this.layer, 'is-on', state === 'playing');
    // Menus need a visible cursor.
    if (state === 'paused' || state === 'won') this.game.input?.releaseLock?.();
  }

  // --- actions (from user gestures)

  finishIntro() {
    this.screens.intro.finished = true;
    if (this.game.state === 'intro') this.game.startPlaying();
  }

  resume() {
    if (this.game.state === 'paused' && this.game.stateTime >= RESUME_DELAY) this.game.resume();
  }

  restart() {
    if (this.game.state === 'paused' && this.game.stateTime >= RESUME_DELAY) this.game.respawn();
  }

  retry() {
    if (this.game.state === 'dead' && this.game.stateTime > RETRY_DELAY) this.game.respawn();
  }

  onClick(e) {
    if (e.button !== 0) return;
    const g = this.game;
    const before = g.state;
    if (g.state === 'title' && g.stateTime > 0.25) g.begin();
    else if (g.state === 'intro' && g.stateTime > 0.5) this.finishIntro();
    else if (g.state === 'dead') this.retry();
    // A fast click can land within one frame: don't let it also count as a throw.
    if (g.state !== before) g.input?.endFrame?.();
  }

  onKey(e) {
    if (e.repeat) return;
    const g = this.game;
    const confirm = e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space';
    // Esc never resumes/starts anything: it is not a user activation, so pointer lock would fail.
    if (g.state === 'title' && confirm && g.stateTime > 0.25) g.begin();
    else if (g.state === 'intro' && confirm && g.stateTime > 0.5) this.finishIntro();
    else if (g.state === 'dead' && confirm) this.retry();
    else if (g.state === 'paused' && e.code === 'KeyP') this.resume();
    else if (g.state === 'won' && confirm && this.screens.won.done) window.location.reload();
  }

  // --- bus reactions

  onZoneEnter(e) {
    const level = this.game.level;
    const index = Number.isFinite(e?.index) ? e.index : e?.zone?.index;
    if (index == null || this.zonesShown.has(index)) return;
    this.zonesShown.add(index);
    const zone = e?.zone ?? level?.zones?.[index];
    this.zoneCard.show(zone, index, level?.zones?.length ?? 0);
    // The first zone is covered by the HUD's own tutorial sequence.
    if (index > 0 && zone?.hint) this.tutorial.zoneHint(index, zone.hint);
  }

  maskFactor() {
    return 1 - CONFIG.noise.maskStrength * clamp(this.game.noiseMask || 0, 0, 1);
  }

  onFootstep(e) {
    if (this.game.state !== 'playing') return;
    const [radius, loud] = STEP_NOISE[e?.mode] || STEP_NOISE.walk;
    this.eye.ripple(radius * this.maskFactor(), loud);
  }

  onRespawn() {
    this.ring.clear();
    this.edgeLevel = 0;
    this.edgeFlash = 0;
    this.eye.reset();
    this.cross.reset();
    this.tutorial.reset();
    // A card frozen mid-fade by the caught/dead screens would otherwise ghost back in.
    this.zoneCard.hide();
    setStyle(this.edge, 'opacity', 0);
  }

  // --- per frame

  update(dt) {
    const g = this.game;
    this.time += dt;
    if (g.state !== this.state) this.setState(g.state, this.state);
    this.screens[g.state]?.update(dt);
    if (g.state === 'playing') {
      if (g.input?.pointerLockFailed) this.notice.show();
      this.updatePlaying(dt);
    }
    this.debugOverlay?.update(dt, g);
  }

  updatePlaying(dt) {
    const g = this.game;
    const player = g.player;
    const list = g.director?.getIndicators?.();
    const indicators = Array.isArray(list) ? list : NO_INDICATORS;
    this.ring.update(dt, indicators, player);

    const chasing = (g.director?.chasing || 0) > 0 || indicators.some((i) => i?.state === 'chase');
    this.edgeLevel = damp(this.edgeLevel, chasing ? 1 : 0, chasing ? 2.5 : 0.9, dt);
    this.edgeFlash = Math.max(0, this.edgeFlash - dt * 1.4);
    // Steady, not pulsing: the atmosphere's post pass already beats the screen edges with a
    // threat-driven heartbeat, and a second rhythm on the same edges would fight it.
    const glow = this.edgeLevel * 0.7 + this.edgeFlash * 0.4;
    setStyle(this.edge, 'opacity', glow < 0.005 ? 0 : clamp(glow, 0, 1));

    this.cross.update(dt, player);
    this.eye.update(dt, player);
    this.bottles.update(dt, player?.bottles ?? 0);
    this.zoneCard.update(dt);
    this.messages.update(dt);
    this.tutorial.update(dt, g, this.messages.busy);
    this.rec.update(dt, g);
    this.notice.update(dt);
  }
}
