import * as THREE from 'three';
import { CONFIG } from './config.js';
import { EventBus } from './core/events.js';
import { Input } from './core/input.js';
import { CollisionWorld } from './core/collision.js';
import { NavGrid } from './core/nav.js';
import { clamp, damp } from './core/math.js';
import { Player } from './player/player.js';
import { Projectiles } from './world/projectiles.js';
import { Atmosphere } from './world/atmosphere.js';
import { Level } from './world/level.js';
import { Leviathan } from './world/leviathan.js';
import { Director } from './ai/director.js';
import { AudioEngine } from './audio/audio.js';
import { Hud } from './ui/hud.js';

const SETTINGS_KEY = 'when-it-calls:settings';

function loadSettings() {
  const defaults = { sensitivity: 1, volume: 0.8, fov: 72 };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

// Owns every system and the top-level state machine:
//   title -> intro -> playing <-> paused
//   playing -> caught -> dead -> (respawn) playing
//   playing -> won
export class Game {
  constructor(container, params = new URLSearchParams()) {
    this.container = container;
    this.params = params;
    this.debug = params.has('debug');
    this.god = params.has('god');
    this.settings = loadSettings();
    this.bus = new EventBus();
    this.time = 0; // simulated seconds while playing
    this.noiseMask = 0; // 0..1, raised by the leviathan's footfalls and calls
    this.state = 'loading';
    this.stateTime = 0;
    this.stats = { spotted: 0, deaths: 0, playTime: 0 };
    this.caughtBy = null;
    this.debugCamera = null; // { pos: [x,y,z], target: [x,y,z] } overrides the camera (tests/screenshots)

    // --- rendering
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.1, 2500);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera); // so camera-attached objects render

    // --- systems (order matters: later systems read earlier ones in their constructors)
    this.input = new Input(renderer.domElement, this.bus);
    this.world = new CollisionWorld();
    this.projectiles = new Projectiles(this);
    this.audio = new AudioEngine(this);
    this.atmosphere = new Atmosphere(this);
    this.level = new Level(this);
    this.level.build();
    this.nav = new NavGrid(this.world, this.level.bounds, CONFIG.nav);
    this.nav.build();
    this.player = new Player(this);
    this.leviathan = new Leviathan(this);
    this.director = new Director(this);
    this.hud = new Hud(this);

    const cpIndex = clamp(parseInt(params.get('cp') || '0', 10) || 0, 0, this.level.checkpoints.length - 1);
    this.checkpoint = this.level.checkpoints[cpIndex];
    this.checkpointBottles = this.checkpoint.bottles ?? 0;
    this.player.spawn(this.checkpoint.pos, this.checkpoint.yaw);
    this.player.bottles = this.checkpointBottles;
    this.level.resetDynamic(this.checkpoint);
    this.director.reset();

    this.bus.on('player:caught', (e) => this.onCaught(e));
    this.bus.on('level:checkpoint', (e) => this.setCheckpoint(e.checkpoint));
    this.bus.on('level:exit', () => this.win());
    this.bus.on('enemy:alert', () => this.stats.spotted++);
    this.bus.on('input:unlock', () => {
      if (this.state === 'playing') this.pause();
    });
    this.bus.on('input:key', ({ code }) => {
      if ((code === 'Escape' || code === 'KeyP') && this.state === 'playing' && !this.input.locked) this.pause();
    });
    window.addEventListener('blur', () => {
      if (this.state === 'playing') this.pause();
    });
    window.addEventListener('resize', () => this.resize());

    this.setState(params.has('autostart') ? 'playing' : 'title');
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

  // Called by the HUD from a user gesture (click on the title screen).
  begin() {
    this.audio.init();
    this.input.requestLock();
    this.setState('intro');
  }

  // Called by the HUD when the intro text is dismissed or finishes.
  startPlaying() {
    this.input.requestLock();
    this.setState('playing');
  }

  pause() {
    this.input.reset();
    this.setState('paused');
  }

  resume() {
    this.input.requestLock();
    this.setState('playing');
  }

  setCheckpoint(cp) {
    if (!cp || cp === this.checkpoint) return;
    if ((cp.order ?? 0) < (this.checkpoint.order ?? 0)) return;
    this.checkpoint = cp;
    this.checkpointBottles = this.player.bottles;
    this.bus.emit('game:checkpoint', { checkpoint: cp });
  }

  onCaught({ enemy }) {
    if (this.god || this.state !== 'playing') return;
    this.caughtBy = enemy;
    this.stats.deaths++;
    this.setState('caught');
  }

  respawn() {
    const cp = this.checkpoint;
    this.projectiles.clear();
    this.level.resetDynamic(cp);
    this.director.reset();
    this.leviathan.onRespawn?.(cp);
    this.player.spawn(cp.pos, cp.yaw);
    this.player.bottles = this.checkpointBottles;
    this.noiseMask = 0;
    this.caughtBy = null;
    this.atmosphere.setDeath(0);
    this.bus.emit('game:respawn', { checkpoint: cp });
    this.input.requestLock();
    this.setState('playing');
  }

  win() {
    if (this.state !== 'playing') return;
    this.setState('won');
    this.bus.emit('game:won', { stats: this.stats });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.atmosphere.resize?.(w, h);
  }

  start() {
    document.getElementById('boot')?.remove();
    const frame = (now) => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.fps = damp(this.fps, dt > 0 ? 1 / dt : 60, 2, dt);
      this.tick(dt);
      this.render();
    };
    requestAnimationFrame(frame);
  }

  // One simulation step. Systems only advance in states where the world is "live".
  tick(dt) {
    this.stateTime += dt;
    const live = this.state === 'playing' || this.state === 'caught' || this.state === 'won';
    if (live) {
      this.time += dt;
      if (this.state === 'playing') this.stats.playTime += dt;
      this.player.update(dt);
      this.level.update(dt);
      this.leviathan.update(dt);
      this.director.update(dt);
      this.projectiles.update(dt);
    } else if (this.state === 'title' || this.state === 'intro') {
      this.time += dt;
      this.leviathan.update(dt);
    }
    if (this.state === 'caught') this.updateCaught(dt);
    this.atmosphere.update(dt);
    this.audio.update(dt);
    this.hud.update(dt);
    this.input.endFrame();
  }

  updateCaught(dt) {
    const e = this.caughtBy;
    if (e?.getHeadPos) {
      const head = e.getHeadPos(new THREE.Vector3());
      const eye = this.player.getEyePos(new THREE.Vector3());
      const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
      const targetYaw = Math.atan2(-dx, -dz);
      const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const p = this.player;
      p.yaw += Math.atan2(Math.sin(targetYaw - p.yaw), Math.cos(targetYaw - p.yaw)) * (1 - Math.exp(-10 * dt));
      p.pitch = damp(p.pitch, targetPitch, 10, dt);
      p.addShake(dt * 0.6);
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
      this.player.applyCamera(this.camera);
    }
    if (this.debugCamera) {
      const { pos, target } = this.debugCamera;
      this.camera.position.set(pos[0], pos[1], pos[2]);
      this.camera.lookAt(target[0], target[1], target[2]);
    }
    this.atmosphere.render();
  }

  // Headless helper for tests: advance the world without rendering.
  simulate(seconds, step = 1 / 30) {
    const n = Math.ceil(seconds / step);
    for (let i = 0; i < n; i++) this.tick(step);
  }

  // Debug helper: move the player.
  teleport(x, z, yaw = this.player.yaw) {
    this.player.spawn({ x, z }, yaw);
  }
}
