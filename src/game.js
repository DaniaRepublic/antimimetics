import * as THREE from 'three';
import { CONFIG } from './config.js';
import { EventBus } from './core/events.js';
import { Input } from './core/input.js';
import { CollisionWorld } from './core/collision.js';
import { NavGrid } from './core/nav.js';
import { clamp, damp } from './core/math.js';
import { hideNotice, reloadAction, showNotice } from './core/notice.js';
import { Player } from './player/player.js';
import { Projectiles } from './world/projectiles.js';
import { Atmosphere } from './world/atmosphere.js';
import { Level } from './world/level.js';
import { Leviathan } from './world/leviathan.js';
import { Director } from './ai/director.js';
import { AudioEngine } from './audio/audio.js';
import { Hud } from './ui/hud.js';

const SETTINGS_KEY = 'when-it-calls:settings';
// [min, max, default] for the settings the pause menu edits (anything else stored is kept if sane).
const SETTING_RANGES = { sensitivity: [0.3, 3, 1], volume: [0, 1, 0.8], fov: [60, 95, 72], brightness: [0.5, 2, 1] };
const MAX_DT = 0.05;
const ERROR_LOGS_PER_SOURCE = 3; // full stack traces per failing system, then a periodic count
const RENDER_FAILS_BEFORE_FALLBACK = 15;
const CONTEXT_RESTORE_WAIT = 5000; // ms before offering a reload after the GPU context is lost
const PROFILE_SAMPLES = 1200;
// States a respawn may be requested from (tests also respawn while playing).
const RESPAWNABLE = new Set(['playing', 'paused', 'caught', 'dead']);

const _head = new THREE.Vector3();
const _eye = new THREE.Vector3();

function loadSettings() {
  const out = {};
  for (const [k, [, , def]] of Object.entries(SETTING_RANGES)) if (k !== 'brightness') out[k] = def;
  let raw = null;
  try {
    raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
  } catch {
    raw = null; // storage unavailable (sandboxed iframe, privacy mode) or corrupt
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const range = SETTING_RANGES[k];
      if (range) {
        const n = Number(v);
        if (v !== null && v !== '' && Number.isFinite(n)) out[k] = clamp(n, range[0], range[1]);
      } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string') {
        out[k] = v;
      }
    }
  }
  return out;
}

// Size of the view: the window, or the container if the window reports nothing (some embeds
// report 0 x 0 while hidden). Never 0, so the aspect ratio and render targets stay valid.
function viewSize(container) {
  const w = window.innerWidth || container?.clientWidth || 0;
  const h = window.innerHeight || container?.clientHeight || 0;
  return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)), valid: w >= 1 && h >= 1 };
}

const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

// Owns every system and the top-level state machine:
//   title -> intro -> playing <-> paused
//   playing -> caught -> dead -> (respawn) playing
//   playing -> won
//
// Robustness: in normal builds each system's update (and the render) runs guarded, so an
// exception in one system is logged and the rest of the game keeps running; with ?debug errors
// are not caught. A lost WebGL context pauses the game behind a message until it comes back.
export class Game {
  constructor(container, params = new URLSearchParams()) {
    const tStart = performance.now();
    let tPrev = tStart;
    this.bootTimings = { startedAt: Math.round(tStart), steps: {} };
    const mark = (name) => {
      const now = performance.now();
      this.bootTimings.steps[name] = Math.round((now - tPrev) * 10) / 10;
      tPrev = now;
    };

    this.container = container;
    this.params = params;
    this.debug = params.has('debug');
    this.god = params.has('god');
    this.profiling = params.has('profile');
    this.settings = loadSettings();
    this.bus = new EventBus();
    this.time = 0; // simulated seconds while playing
    this.noiseMask = 0; // 0..1, raised by the leviathan's footfalls and calls
    this.state = 'loading';
    this.stateTime = 0;
    this.stats = { spotted: 0, deaths: 0, playTime: 0 };
    this.caughtBy = null;
    this.debugCamera = null; // { pos: [x,y,z], target: [x,y,z] } overrides the camera (tests/screenshots)
    this.errorLog = []; // [{ source, message, count }] (tests read this)
    this.contextLost = false;
    this.frames = 0;
    this._errors = new Map();
    this._renderFails = 0;
    this._fallbackFails = 0;
    this.renderFallback = false; // true once the post chain has failed repeatedly: plain render
    this._resizePending = false;
    this._raf = null;
    this.perf = null;
    if (this.profiling) this.resetPerf();
    // A listener that throws is reported like a failing system (re-thrown later with ?debug).
    this.bus.onError = (err, type) => this.reportError(`event:${type}`, err);

    // --- rendering
    const size = viewSize(container);
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(size.w, size.h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, size.w / size.h, 0.1, 2500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera); // so camera-attached objects render
    const canvas = renderer.domElement;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // allow the browser to restore it
      this.onContextLost();
    }, false);
    canvas.addEventListener('webglcontextrestored', () => this.onContextRestored(), false);
    mark('renderer');

    // --- systems (order matters: later systems read earlier ones in their constructors)
    this.input = new Input(renderer.domElement, this.bus);
    this.world = new CollisionWorld();
    this.projectiles = new Projectiles(this);
    mark('input+world+projectiles');
    this.audio = new AudioEngine(this);
    mark('audio');
    this.atmosphere = new Atmosphere(this);
    mark('atmosphere');
    this.level = new Level(this);
    this.level.build();
    mark('level');
    this.nav = new NavGrid(this.world, this.level.bounds, CONFIG.nav);
    this.nav.build();
    mark('nav');
    this.player = new Player(this);
    this.leviathan = new Leviathan(this);
    mark('player+leviathan');
    this.director = new Director(this);
    mark('director');
    this.hud = new Hud(this);
    mark('hud');

    const cpIndex = clamp(parseInt(params.get('cp') || '0', 10) || 0, 0, this.level.checkpoints.length - 1);
    this.checkpoint = this.level.checkpoints[cpIndex];
    this.checkpointBottles = this.checkpoint.bottles ?? 0;
    this.player.spawn(this.checkpoint.pos, this.checkpoint.yaw);
    this.player.bottles = this.checkpointBottles;
    this._lastGood = { pos: this.player.position.clone(), yaw: this.player.yaw, pitch: this.player.pitch };
    this.level.resetDynamic(this.checkpoint);
    this.director.reset();

    this.bus.on('player:caught', (e) => this.onCaught(e));
    this.bus.on('level:checkpoint', (e) => this.setCheckpoint(e.checkpoint));
    this.bus.on('level:exit', () => this.win());
    this.bus.on('enemy:alert', () => this.stats.spotted++);
    // Esc (the browser drops the lock) pauses; an exit the game asked for itself does not.
    this.bus.on('input:unlock', (e) => {
      if (this.state === 'playing' && !e?.requested) this.pause();
    });
    this.bus.on('input:key', ({ code }) => {
      if ((code === 'Escape' || code === 'KeyP') && this.state === 'playing' && !this.input.locked) this.pause();
    });
    window.addEventListener('blur', () => {
      if (this.state === 'playing') this.pause();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    // Coalesced: a window drag fires dozens of resizes; the post chain is rebuilt once per frame.
    window.addEventListener('resize', () => {
      this._resizePending = true;
    });

    this.setState(params.has('autostart') ? 'playing' : 'title');
    mark('spawn');
    this.bootTimings.constructMs = Math.round(performance.now() - tStart);
    this.last = performance.now();
    this.fps = 60;
  }

  setState(state) {
    const prev = this.state;
    this.state = state;
    this.stateTime = 0;
    this.player.controlsEnabled = state === 'playing';
    this.input.enabled = state === 'playing';
    this.bus.emit('game:state', { state, prev });
  }

  saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable: settings last for this session only */
    }
    this.audio.setMasterVolume?.(this.settings.volume);
  }

  // --- state transitions (from HUD user gestures; each is a no-op from the wrong state) -------

  // Title screen click.
  begin() {
    if (this.state !== 'title') return false;
    this.audio.init();
    this.input.requestLock();
    this.setState('intro');
    return true;
  }

  // The intro text is dismissed or finishes.
  startPlaying() {
    if (this.state !== 'intro' && this.state !== 'title') return false;
    if (this.state === 'title') this.audio.init();
    this.input.requestLock();
    this.setState('playing');
    return true;
  }

  pause() {
    if (this.state !== 'playing') return false;
    this.input.reset();
    this.setState('paused');
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    if (this.contextLost) return false; // nothing to see yet: stay behind the notice
    this.input.requestLock();
    this.setState('playing');
    return true;
  }

  setCheckpoint(cp) {
    if (!cp || cp === this.checkpoint) return;
    if ((cp.order ?? 0) < (this.checkpoint.order ?? 0)) return;
    this.checkpoint = cp;
    this.checkpointBottles = this.player.bottles;
    this.bus.emit('game:checkpoint', { checkpoint: cp });
  }

  onCaught(e) {
    if (this.god || this.state !== 'playing') return;
    this.caughtBy = e?.enemy ?? null;
    this.stats.deaths++;
    this.setState('caught');
  }

  // Back to the last checkpoint with every system reset. Order: clear transient things, put the
  // level back, the player at the checkpoint (snatchers measure their distance to it), then the
  // snatchers, and only then the leviathan: ending a call in progress after the director's reset
  // means the call's end finds everyone calm (no stray 'lost'/search reactions at respawn).
  respawn() {
    if (!RESPAWNABLE.has(this.state)) return false;
    const cp = this.checkpoint;
    this.caughtBy = null;
    // Each reset is guarded (outside ?debug): one module failing to reset must not leave the
    // player stuck on the dead screen, every retry throwing before the state changes.
    this.guard('respawn:projectiles', () => this.projectiles.clear());
    this.guard('respawn:level', () => this.level.resetDynamic(cp));
    this.guard('respawn:player', () => {
      this.player.spawn(cp.pos, cp.yaw);
      this.player.bottles = this.checkpointBottles;
      this.player.focus = null;
    });
    if (finite3(this.player.position)) this._lastGood.pos.copy(this.player.position);
    this.guard('respawn:director', () => this.director.reset());
    this.guard('respawn:leviathan', () => this.leviathan.onRespawn?.(cp));
    this.noiseMask = 0;
    this.guard('respawn:atmosphere', () => this.atmosphere.setDeath(0));
    this.input.reset();
    this.bus.emit('game:respawn', { checkpoint: cp });
    this.input.requestLock();
    this.setState('playing');
    return true;
  }

  win() {
    if (this.state !== 'playing') return;
    this.setState('won');
    this.bus.emit('game:won', { stats: this.stats });
  }

  resize() {
    this._resizePending = false;
    const size = viewSize(this.container);
    if (!size.valid) return; // hidden embed: keep the last good size until we are shown again
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(size.w, size.h);
    this.camera.aspect = size.w / size.h;
    this.camera.updateProjectionMatrix();
    this.atmosphere.resize?.(size.w, size.h);
  }

  // --- main loop ---------------------------------------------------------------------------------

  start() {
    if (this._raf !== null) return;
    document.getElementById('boot')?.remove();
    this.last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this._raf = requestAnimationFrame(loop);
  }

  // Halts the real-time loop (tools that drive the world with simulate() and render on demand;
  // start() resumes it).
  stop() {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  frame(now) {
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0; // first frame, a clock hiccup, NaN
    dt = Math.min(MAX_DT, dt);
    if (dt > 0) this.fps = damp(this.fps, 1 / dt, 2, dt);
    if (this._resizePending) this.resize();
    const t0 = performance.now();
    this.tick(dt);
    const t1 = performance.now();
    this.render();
    const t2 = performance.now();
    this.frames++;
    if (this.perf) {
      this._sample('tick', t1 - t0);
      this._sample('render', t2 - t1);
    }
    if (this.frames === 1) {
      this.bootTimings.firstFrameMs = Math.round(t2 - t0);
      this.bootTimings.firstFrameAt = Math.round(t2);
    }
  }

  // One simulation step. Systems only advance in states where the world is "live".
  tick(dt) {
    if (!(dt >= 0)) dt = 0;
    // No playing blind: Enter on the title / dead screen (or a respawn) can still reach 'playing'
    // while the picture is gone behind the notice. Hold it paused until the context comes back.
    if (this.contextLost && this.state === 'playing') this.pause();
    this.stateTime += dt;
    const live = this.state === 'playing' || this.state === 'caught' || this.state === 'won';
    if (live) {
      this.time += dt;
      if (this.state === 'playing') this.stats.playTime += dt;
      this.run('player', this.player, dt);
      this.run('level', this.level, dt);
      this.run('leviathan', this.leviathan, dt);
      this.run('director', this.director, dt);
      this.run('projectiles', this.projectiles, dt);
      this.watchdog();
    } else if (this.state === 'title' || this.state === 'intro') {
      this.time += dt;
      this.run('leviathan', this.leviathan, dt);
    }
    if (this.state === 'caught') this.guard('caught', () => this.updateCaught(dt));
    this.run('atmosphere', this.atmosphere, dt);
    this.run('audio', this.audio, dt);
    this.run('hud', this.hud, dt);
    this.input.endFrame();
  }

  // Calls system.update(dt), timed when profiling and guarded outside ?debug.
  run(name, system, dt) {
    if (this.perf) {
      const t0 = performance.now();
      this.guardUpdate(name, system, dt);
      this._sample(name, performance.now() - t0);
    } else this.guardUpdate(name, system, dt);
  }

  guardUpdate(name, system, dt) {
    if (this.debug) {
      system.update(dt);
      return;
    }
    try {
      system.update(dt);
    } catch (err) {
      this.reportError(name, err);
    }
  }

  guard(name, fn) {
    if (this.debug) return fn();
    try {
      return fn();
    } catch (err) {
      this.reportError(name, err);
      return undefined;
    }
  }

  // Logs the first few failures of each source with their stack, then a count now and then, and
  // keeps a summary in game.errorLog. With ?debug, errors from the event bus are re-thrown
  // asynchronously (system updates are not guarded at all there).
  reportError(source, err) {
    let rec = this._errors.get(source);
    if (!rec) {
      rec = { source, message: String(err?.message || err), count: 0 };
      this._errors.set(source, rec);
      this.errorLog.push(rec);
    }
    rec.count++;
    rec.lastMessage = String(err?.message || err);
    if (rec.count <= ERROR_LOGS_PER_SOURCE) console.error(`[game] ${source} failed:`, err);
    else if (rec.count % 600 === 0) console.error(`[game] ${source} has failed ${rec.count} times (last: ${rec.lastMessage})`);
    if (this.debug) {
      queueMicrotask(() => {
        throw err;
      });
    }
  }

  // Last line of defence against NaN: a non-finite player or snatcher would otherwise break the
  // camera, the AI and the audio for the rest of the session.
  watchdog() {
    const p = this.player;
    const good = this._lastGood;
    if (finite3(p.position) && Number.isFinite(p.yaw) && Number.isFinite(p.pitch)) {
      good.pos.copy(p.position);
      good.yaw = p.yaw;
      good.pitch = p.pitch;
    } else {
      this.reportError('watchdog', new Error('player state went non-finite; restored the last good position'));
      if (!finite3(good.pos)) good.pos.set(this.checkpoint.pos.x, 0, this.checkpoint.pos.z);
      if (!Number.isFinite(good.yaw)) good.yaw = this.checkpoint.yaw ?? 0;
      if (!Number.isFinite(good.pitch)) good.pitch = 0;
      p.position.copy(good.pos);
      p.velocity.set(0, 0, 0);
      p.yaw = good.yaw;
      p.pitch = good.pitch;
    }
    if (!Number.isFinite(this.noiseMask)) this.noiseMask = 0;
    for (const s of this.director.snatchers) {
      if (finite3(s.position) && Number.isFinite(s.yaw)) continue;
      this.reportError('watchdog', new Error(`snatcher ${s.id} went non-finite; reset it`));
      this.guard('watchdog', () => s.reset());
    }
  }

  updateCaught(dt) {
    const e = this.caughtBy;
    if (e?.getHeadPos) {
      const head = e.getHeadPos(_head);
      const eye = this.player.getEyePos(_eye);
      const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
      if (Number.isFinite(dx + dy + dz) && dx * dx + dz * dz > 1e-8) {
        const targetYaw = Math.atan2(-dx, -dz);
        const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
        const p = this.player;
        p.yaw += Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw)) * (1 - Math.exp(-10 * dt));
        p.pitch = damp(p.pitch, targetPitch, 10, dt);
      }
      this.player.addShake(dt * 0.6);
    }
    this.atmosphere.setDeath(clamp(this.stateTime / 2.4, 0, 1));
    if (this.stateTime > 2.6) this.setState('dead');
  }

  render() {
    if (this.state === 'title' && this.level.titleCamera && !this.debugCamera) {
      const tc = this.level.titleCamera;
      const sway = Math.sin(this.time * 0.07) * 0.6;
      this.camera.position.set(tc.pos[0] + sway, tc.pos[1], tc.pos[2]);
      this.camera.lookAt(tc.target[0], tc.target[1], tc.target[2]);
    } else {
      this.guard('camera', () => this.player.applyCamera(this.camera));
    }
    if (this.debugCamera) {
      const { pos, target } = this.debugCamera;
      this.camera.position.set(pos[0], pos[1], pos[2]);
      this.camera.lookAt(target[0], target[1], target[2]);
    }
    if (this.contextLost) return;
    if (!this.renderFallback) {
      if (this.debug) {
        this.atmosphere.render();
        return;
      }
      try {
        this.atmosphere.render();
        this._renderFails = 0;
        return;
      } catch (err) {
        this.reportError('render', err);
        if (++this._renderFails < RENDER_FAILS_BEFORE_FALLBACK) return;
        // The post-processing chain keeps failing: draw the scene directly (no mist, no grade)
        // rather than freeze on the last good frame.
        this.renderFallback = true;
        console.error('[game] post-processing disabled after repeated failures; rendering the plain scene');
      }
    }
    try {
      const r = this.renderer;
      r.info.reset();
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      this._fallbackFails = 0;
    } catch (err) {
      this.reportError('render-fallback', err);
      if (++this._fallbackFails === RENDER_FAILS_BEFORE_FALLBACK) {
        this.pause();
        showNotice({
          title: 'NO PICTURE',
          text: 'The city could not be drawn on this device. Reloading may help.',
          detail: String(err?.message || err),
          action: reloadAction(),
        });
      }
    }
  }

  // --- WebGL context loss -------------------------------------------------------------------------

  onContextLost() {
    if (this.contextLost) return;
    this.contextLost = true;
    this.pause();
    this.input.releaseLock?.();
    showNotice({ title: 'SIGNAL LOST', text: 'The picture dropped out (the graphics driver was reset). Trying to bring it back…' });
    clearTimeout(this._restoreTimer);
    this._restoreTimer = setTimeout(() => {
      if (!this.contextLost) return;
      showNotice({
        title: 'SIGNAL LOST',
        text: 'The picture is not coming back on its own. Reloading restarts the city from the beginning.',
        action: reloadAction(),
      });
    }, CONTEXT_RESTORE_WAIT);
  }

  onContextRestored() {
    this.contextLost = false;
    clearTimeout(this._restoreTimer);
    hideNotice();
    // three.js re-creates its GL state on restore; re-size so every render target is rebuilt.
    this._resizePending = true;
    this._renderFails = 0;
  }

  // --- profiling (?profile, or game.resetPerf() from a test) ----------------------------------------

  resetPerf() {
    this.perf = { samples: new Map() };
  }

  _sample(name, ms) {
    let s = this.perf.samples.get(name);
    if (!s) this.perf.samples.set(name, (s = { n: 0, total: 0, max: 0, ring: new Float32Array(PROFILE_SAMPLES) }));
    s.ring[s.n % PROFILE_SAMPLES] = ms;
    s.n++;
    s.total += ms;
    if (ms > s.max) s.max = ms;
  }

  // { system: { n, mean, p95, p99, max } } in milliseconds (percentiles over the last samples).
  perfReport() {
    const out = {};
    if (!this.perf) return out;
    for (const [name, s] of this.perf.samples) {
      const k = Math.min(s.n, PROFILE_SAMPLES);
      const sorted = Array.from(s.ring.subarray(0, k)).sort((a, b) => a - b);
      const pct = (p) => (k ? sorted[Math.min(k - 1, Math.floor(k * p))] : 0);
      const r3 = (v) => Math.round(v * 1000) / 1000;
      out[name] = { n: s.n, mean: r3(s.total / Math.max(1, s.n)), p95: r3(pct(0.95)), p99: r3(pct(0.99)), max: r3(s.max) };
    }
    return out;
  }

  // --- test helpers -----------------------------------------------------------------------------------

  // Headless helper for tests: advance the world without rendering.
  simulate(seconds, step = 1 / 30) {
    if (!(step > 0)) step = 1 / 30;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const n = Math.ceil(seconds / step);
    for (let i = 0; i < n; i++) this.tick(step);
  }

  // Debug helper: move the player.
  teleport(x, z, yaw = this.player.yaw) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false; // would poison the watchdog's last good spot
    this.player.spawn({ x, z }, Number.isFinite(yaw) ? yaw : this.player.yaw);
    this._lastGood.pos.copy(this.player.position);
    return true;
  }
}
