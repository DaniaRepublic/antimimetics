import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, smoothstep } from '../core/math.js';
import { Builder, impulseResponse, makeConvolver } from './builder.js';
import { SYNTHS, bankJobs } from './synths.js';
import {
  WindLayer, DroneLayer, TinnitusLayer, HeartbeatLayer, ChaseLayer, WhisperVoice, AlarmVoice, warmNoise,
} from './layers.js';

// Procedural sound for the whole game (100% WebAudio, no samples).
//
// Graph:  voice -> [air lowpass -> HRTF panner] -> bus.dry --------------------> preMaster
//              \-> send (distance-weighted) -----> bus.wet -> street reverb ---^
//                                                  bus.vast -> city-scale reverb
//         preMaster -> pause lowpass -> volume -> compressor -> limiter -> speakers
// Buses (world, body, levi, music, fx) are ducked as a whole: the leviathan's call ducks everything
// but itself, being caught cuts the scene (fx survives), winning fades the city out.

const MAX_VOICES = 32;
const SPAWN_BUDGET = 10; // new voices per frame (a burst of events never floods the graph)
const LOOKAHEAD = 0.3; // seconds of automation booked ahead of the audio clock
const HRTF_RANGE = 25; // m: voices starting farther away use cheaper equal-power panning
const WHISPER_SLOTS = 3;
const WHISPER_RANGE = 20; // m: start whispering
const WHISPER_KEEP = 24; // m: stop whispering (hysteresis)
const TAU = Math.PI * 2;

// Mix levels (linear gain at each voice's input).
const LEVEL = {
  wind: 0.22, drone: 0.07, tinnitusMin: 0.0015, tinnitusMax: 0.02, heart: 0.2, chase: 0.3,
  footfall: 0.95, call: 0.75, legGroan: 0.55,
  metalGroan: 0.5, structureCreak: 0.4, distantWail: 0.3,
  whisper: 2.0, questionCreak: 2.4, shriek: 0.75, stinger: 0.32, hiss: 0.9, exhale: 0.9,
  creatureStep: 0.75, footstep: 0.55, breath: 0.42, gasp: 0.4, whoosh: 0.28, emptyClick: 0.3, clink: 0.25,
  shatter: 2.0, alarm: 0.9, chainGrind: 0.9, gateOpen: 0.85, chime: 0.08, swell: 0.3, grab: 0.85, ending: 0.32,
};

// How much each bus is kept while the leviathan calls.
const CALL_DUCK = { world: 0.2, body: 0.55, levi: 1, music: 0.4, fx: 1 };
const BUS_NAMES = ['world', 'body', 'levi', 'music', 'fx'];

// Street canyon: ~3 s tail, flutter between facades ~22 m apart, one late echo off the far end.
export const STREET_IR = {
  duration: 3.6, rt60: 3.0, preDelay: 0.006, buildUp: 0.035, bright: 6500, dark: 420, darkTime: 1.1,
  width: 22, flutter: 10, flutterGain: 0.9, lowCut: 140, seed: 11,
  echoes: [{ t: 0.43, gain: 0.22, spread: 0.06, cutoff: 1800 }, { t: 0.81, gain: 0.1, spread: 0.08, cutoff: 1100 }],
};
// The whole city answering: long pre-delay, slow build, dark, with distant discrete echoes.
export const VAST_IR = {
  duration: 7.5, rt60: 6.2, preDelay: 0.06, buildUp: 0.16, bright: 3200, dark: 240, darkTime: 1.9,
  width: 70, flutter: 5, flutterGain: 0.4, lowCut: 28, seed: 23,
  echoes: [
    { t: 0.55, gain: 0.5, spread: 0.09, cutoff: 1400, smear: 0.06 },
    { t: 1.2, gain: 0.32, spread: 0.12, cutoff: 900, smear: 0.09 },
    { t: 1.9, gain: 0.22, spread: 0.07, cutoff: 700, smear: 0.12 },
    { t: 2.8, gain: 0.12, spread: 0.15, cutoff: 500, smear: 0.16 },
  ],
};

// Snatcher vocal behaviour per AI state (null = silent).
const WHISPER_STYLES = {
  calm: { rate: 5, loud: 0.6, phrase: [3, 8], pause: [0.8, 3.2], fric: 0.45, reverse: 0.25, voiced: 0.08, click: [2.5, 7], clickBurst: [1, 2] },
  hunt: { rate: 6.5, loud: 0.8, phrase: [4, 10], pause: [0.4, 1.4], fric: 0.55, reverse: 0.3, voiced: 0.12, click: [0.9, 2.2], clickBurst: [2, 4], clickLoud: 1.2 },
  listen: { rate: 0, click: [0.5, 1.2], clickBurst: [2, 4], clickLoud: 1.3 },
  chase: { rate: 8.5, loud: 1, phrase: [6, 14], pause: [0.15, 0.5], fric: 0.7, reverse: 0.15, voiced: 0.3, click: [3, 6], clickBurst: [1, 2] },
  trance: { rate: 3.2, loud: 0.45, phrase: [2, 5], pause: [1.5, 4], fric: 0.3, reverse: 0.6, voiced: 0.05, click: [4, 9], clickBurst: [1, 1] },
};
const STATE_STYLE = {
  idle: 'calm', patrol: 'calm', return: 'calm', wander: 'calm',
  investigate: 'hunt', search: 'hunt', suspicious: 'listen', chase: 'chase', alarm: 'trance',
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const volumeCurve = (v) => clamp(v, 0, 1) ** 2;
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();

function headOf(enemy, out) {
  if (enemy?.getHeadPos) return enemy.getHeadPos(out);
  const p = enemy?.position;
  return p ? out.set(p.x, (p.y || 0) + 1.9, p.z) : null;
}

export class AudioEngine {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.muted = !!game.params?.has?.('mute');
    this.volume = game.settings?.volume ?? 0.8;
    this.voices = [];
    this.alarms = new Map();
    this.slots = [];
    this.listenerPos = new THREE.Vector3();
    this.threat = 0;
    this.chase = 0;
    this.ring = 0; // tinnitus spike, decays
    this.scene = 1;
    this.calling = false;
    this.callUntil = 0;
    this.caughtActive = false;
    this.paused = false;
    this.won = false;
    this.last = new Map(); // debounce timestamps by key
    this.lastZone = -1;
    this.errorsLogged = 0;

    const on = (type, fn) => game.bus.on(type, (e) => {
      if (!this.ctx) return;
      try {
        fn(e || {});
      } catch (err) {
        this.warn(`${type}: ${err?.message || err}`);
      }
    });
    on('leviathan:footfall', (e) => this.onFootfall(e));
    on('leviathan:call:start', (e) => this.onCallStart(e));
    on('leviathan:call:end', () => this.onCallEnd());
    on('enemy:suspicious', (e) => {
      if (this.debounce(e.enemy, 1.2)) this.enemySound('questionCreak', e, { ref: 3, send: 0.3 });
    });
    on('enemy:alert', (e) => this.onAlert(e));
    on('enemy:lost', (e) => this.enemySound('hiss', e, { ref: 3, send: 0.3 }));
    on('enemy:giveup', (e) => this.enemySound('exhale', e, { ref: 3, send: 0.3 }));
    on('enemy:step', (e) => this.onEnemyStep(e));
    on('player:footstep', (e) => this.onFootstep(e));
    on('player:breath', () => this.play('breath', { strength: 0.8 + this.threat * 0.4 }, { bus: 'body', gain: LEVEL.breath, send: 0.04 }));
    on('player:exhausted', () => this.play('gasp', {}, { bus: 'body', gain: LEVEL.gasp, send: 0.06 }));
    on('player:throw', () => this.play('whoosh', {}, { gain: LEVEL.whoosh, send: 0.05, pan: 0.15 }));
    on('player:throw-empty', () => {
      if (this.debounce('empty', 0.25)) this.play('emptyClick', {}, { gain: LEVEL.emptyClick, send: 0.03 });
    });
    on('player:pickup', () => this.play('clink', {}, { gain: LEVEL.clink, send: 0.12, pan: 0.1 }));
    on('bottle:shatter', (e) => this.play('shatter', {}, {
      pos: e.pos, ref: 4, gain: LEVEL.shatter, send: 0.7, priority: 5, kind: 'shatter', maxKind: 4,
    }));
    on('alarm:start', (e) => this.startAlarm(e));
    on('alarm:end', (e) => this.stopAlarm(e.id));
    on('noise', (e) => {
      if (e.source === 'gate' && this.debounce('gate', 0.45)) {
        this.play('chainGrind', {}, { pos: e.pos, ref: 3, gain: LEVEL.chainGrind, send: 0.5, priority: 6, kind: 'grind', maxKind: 2 });
      }
    });
    on('gate:open', (e) => this.play('gateOpen', {}, { pos: e.pos, ref: 4, gain: LEVEL.gateOpen, send: 0.6, vast: 0.2, priority: 6 }));
    on('game:checkpoint', () => this.play('chime', {}, { bus: 'music', gain: LEVEL.chime, send: 0.6, priority: 4 }));
    on('zone:enter', (e) => this.onZone(e));
    on('player:caught', () => {
      if (!this.game.god) this.onCaught();
    });
    on('game:won', () => this.onWon());
    on('game:state', (e) => this.onState(e));
    on('game:respawn', () => this.onRespawn());

    // Browsers only allow audio after a user gesture: start (or resume) on the first one, so
    // ?autostart sessions get sound too. game.begin() also calls init() from its click.
    this.onGesture = () => {
      if (this.muted || this.failed) return;
      if (!this.ctx) this.init();
      else if (this.ctx.state === 'suspended') this.ctx.resume?.().catch(() => {});
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture, true);
      window.addEventListener('keydown', this.onGesture, true);
    }
  }

  warn(msg) {
    if (this.errorsLogged++ < 5) console.warn(`[audio] ${msg}`);
  }

  // --- lifecycle -------------------------------------------------------------------------------

  // Must be called from a user gesture. Creates the context, the mix graph and starts ambience.
  init() {
    if (this.ctx || this.muted || this.failed) return;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) {
      this.failed = true;
      return;
    }
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      try {
        this.ctx = new AC();
      } catch {
        this.failed = true;
        return;
      }
    }
    try {
      this.buildGraph();
      this.startLayers();
    } catch (err) {
      this.warn(`init failed: ${err?.message || err}`);
      this.failed = true;
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
      return;
    }
    this.ctx.resume?.().catch(() => {});
    this.ready = true;
    this.initTime = this.ctx.currentTime;
    this.spawnBudget = SPAWN_BUDGET;
    this.onState({ state: this.game.state, prev: null });
    this.warmUp();
  }

  // Generates the reverb impulse responses and the sample banks in small idle slices after init,
  // so the click that starts the game stays responsive. (Anything needed earlier is generated
  // on demand by the cache.)
  warmUp() {
    const ctx = this.ctx;
    const jobs = [
      () => {
        this.reverb.buffer = impulseResponse(ctx, 'street', STREET_IR);
      },
      () => {
        this.vast.buffer = impulseResponse(ctx, 'vast', VAST_IR);
      },
      ...bankJobs(ctx),
    ];
    const step = () => {
      if (this.ctx !== ctx) return;
      const job = jobs.shift();
      if (!job) {
        this.warm = true;
        return;
      }
      try {
        job();
      } catch (err) {
        this.warn(`warm-up: ${err?.message || err}`);
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  setMasterVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    if (this.ctx) this.master.gain.setTargetAtTime(volumeCurve(this.volume), this.ctx.currentTime, 0.05);
  }

  buildGraph() {
    const ctx = this.ctx;
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.persistent = [];
    const keep = (...nodes) => {
      this.persistent.push(...nodes);
      return nodes[0];
    };

    this.master = keep(g(volumeCurve(this.volume)));
    const comp = keep(ctx.createDynamicsCompressor());
    comp.threshold.value = -20;
    comp.knee.value = 14;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.28;
    const limiter = keep(ctx.createDynamicsCompressor());
    limiter.threshold.value = -2.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    this.pauseFilter = keep(ctx.createBiquadFilter());
    this.pauseFilter.type = 'lowpass';
    this.pauseFilter.frequency.value = 20000;
    this.pauseFilter.Q.value = 0.5;
    this.pauseGain = keep(g(1));
    this.preMaster = keep(g(1));
    this.preMaster.connect(this.pauseFilter);
    this.pauseFilter.connect(this.pauseGain);
    this.pauseGain.connect(this.master);
    this.master.connect(comp);
    comp.connect(limiter);
    limiter.connect(ctx.destination);
    this.compressor = comp;
    this.limiter = limiter;

    // Reverbs (impulse responses generated once).
    // Reverbs: impulse responses are generated and assigned by warmUp() right after init.
    this.revIn = keep(g(1));
    this.reverb = keep(makeConvolver(ctx, null));
    this.revOut = keep(g(1.3));
    this.revIn.connect(this.reverb);
    this.reverb.connect(this.revOut);
    this.revOut.connect(this.preMaster);
    this.vastIn = keep(g(1));
    this.vast = keep(makeConvolver(ctx, null));
    this.vastOut = keep(g(0.6));
    this.vastIn.connect(this.vast);
    this.vast.connect(this.vastOut);
    this.vastOut.connect(this.preMaster);

    this.buses = {};
    for (const name of BUS_NAMES) {
      const bus = { dry: keep(g(1)), wet: keep(g(1)), vast: keep(g(1)) };
      bus.dry.connect(this.preMaster);
      bus.wet.connect(this.revIn);
      bus.vast.connect(this.vastIn);
      this.buses[name] = bus;
    }

    // Prefer HRTF panning; fall back to equal-power where it is unavailable.
    this.panningModel = 'equalpower';
    try {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      if (p.panningModel === 'HRTF') this.panningModel = 'HRTF';
    } catch {
      /* equal-power */
    }
    warmNoise(ctx);
  }

  startLayers() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const world = this.buses.world;
    const body = this.buses.body;
    const music = this.buses.music;
    const withSend = (bus, send, gain = 1) => {
      const input = ctx.createGain();
      input.gain.value = gain;
      const s = ctx.createGain();
      s.gain.value = send;
      input.connect(bus.dry);
      input.connect(s);
      s.connect(bus.wet);
      this.persistent.push(input, s);
      return input;
    };
    this.wind = new WindLayer(ctx, withSend(world, 0.12));
    this.drone = new DroneLayer(ctx, world.dry);
    this.tinnitus = new TinnitusLayer(ctx, body.dry);
    this.heart = new HeartbeatLayer(ctx, body.dry);
    this.chaseLayer = new ChaseLayer(ctx, withSend(music, 0.25, LEVEL.chase));
    this.wind.level.gain.setValueAtTime(0, now);
    this.wind.level.gain.setTargetAtTime(LEVEL.wind, now, 1.5);
    this.drone.level.gain.setValueAtTime(0, now);
    this.drone.level.gain.setTargetAtTime(LEVEL.drone, now, 2);
    this.heart.level.gain.value = LEVEL.heart;

    for (let i = 0; i < WHISPER_SLOTS; i++) {
      const chain = this.makeChain({ bus: 'world', gain: 0, pos: { x: 0, y: -100, z: 0 }, ref: 1.5, send: 0.18, hrtf: true });
      const voice = new WhisperVoice(ctx, chain.input);
      voice.level.gain.value = LEVEL.whisper;
      this.slots.push({ voice, chain, enemy: null, freeAt: 0 });
    }
    this.layers = [this.wind, this.drone, this.tinnitus, this.heart, this.chaseLayer];
    this.nextAmbient = now + rand(4, 9);
    this.nextWail = now + rand(35, 70);
    this.nextLegGroan = now + rand(2, 5);
    this.layerTimer = 0;
  }

  // --- routing ---------------------------------------------------------------------------------

  // Builds the per-voice routing. route: { bus, gain, pos, ref, rolloff, send, vast, pan, hrtf }
  makeChain(route) {
    const ctx = this.ctx;
    const bus = this.buses[route.bus ?? 'world'];
    const nodes = [];
    const mk = (n) => {
      nodes.push(n);
      return n;
    };
    const input = mk(ctx.createGain());
    input.gain.value = route.gain ?? 1;
    const send = mk(ctx.createGain());
    const baseSend = route.send ?? 0.2;
    send.gain.value = baseSend;
    send.connect(bus.wet);
    let vast = null;
    if (route.vast) {
      vast = mk(ctx.createGain());
      vast.gain.value = route.vast;
      vast.connect(bus.vast);
    }
    const chain = { input, nodes, send, baseSend, vast, panner: null, air: null, pos: null, ref: route.ref ?? 2 };
    if (route.pos) {
      const air = mk(ctx.createBiquadFilter());
      air.type = 'lowpass';
      air.Q.value = 0.5;
      const p = mk(ctx.createPanner());
      // HRTF costs a convolution per voice: keep it for sounds that start close by.
      const far = _v.set(route.pos.x, route.pos.y ?? 1, route.pos.z).distanceTo(this.listenerPos) > HRTF_RANGE;
      p.panningModel = far && route.hrtf !== true ? 'equalpower' : this.panningModel;
      p.distanceModel = 'inverse';
      p.refDistance = chain.ref;
      p.rolloffFactor = route.rolloff ?? 1;
      p.maxDistance = 10000;
      input.connect(air);
      air.connect(p);
      p.connect(bus.dry);
      air.connect(send);
      if (vast) air.connect(vast);
      chain.air = air;
      chain.panner = p;
      chain.pos = new THREE.Vector3(route.pos.x, route.pos.y ?? 1, route.pos.z);
      this.placeChain(chain, chain.pos, true);
    } else {
      let head = input;
      if (route.pan && ctx.createStereoPanner) {
        const sp = mk(ctx.createStereoPanner());
        sp.pan.value = clamp(route.pan, -1, 1);
        input.connect(sp);
        head = sp;
      }
      head.connect(bus.dry);
      input.connect(send);
      if (vast) input.connect(vast);
    }
    chain.dispose = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      nodes.length = 0;
    };
    return chain;
  }

  // Moves a positional chain and updates its distance cues (air absorption + reverb send).
  placeChain(chain, pos, immediate = false) {
    if (!chain.panner) return;
    const p = chain.panner;
    chain.pos.set(pos.x, pos.y ?? chain.pos.y, pos.z);
    if (p.positionX) {
      p.positionX.value = chain.pos.x;
      p.positionY.value = chain.pos.y;
      p.positionZ.value = chain.pos.z;
    } else p.setPosition(chain.pos.x, chain.pos.y, chain.pos.z);
    const d = chain.pos.distanceTo(this.listenerPos);
    const air = clamp(20000 * Math.exp(-d / 38), 700, 20000);
    const ref = chain.ref;
    const send = chain.baseSend * Math.sqrt(ref / (ref + Math.max(0, d - ref)));
    const now = this.ctx.currentTime;
    if (immediate) {
      chain.air.frequency.value = air;
      chain.send.gain.value = send;
      chain.lastD = d;
    } else if (Math.abs(d - (chain.lastD ?? -99)) > 0.25) {
      chain.air.frequency.setTargetAtTime(air, now, 0.05);
      chain.send.gain.setTargetAtTime(send, now, 0.05);
      chain.lastD = d;
    }
  }

  // Stereo position (-1 left .. 1 right) of a world point relative to the camera.
  panOf(pos) {
    if (!pos) return 0;
    _v.set(pos.x - this.listenerPos.x, 0, pos.z - this.listenerPos.z);
    const len = _v.length();
    if (len < 0.01) return 0;
    return clamp(_v.dot(_right) / len, -1, 1);
  }

  // --- voices ----------------------------------------------------------------------------------

  // Plays a one-shot synth. route: { bus, gain, pos, follow (enemy), ref, send, vast, pan,
  // priority (higher survives), kind + maxKind (per-kind cap), cull (m), delay }
  play(name, opts = {}, route = {}) {
    const ctx = this.ctx;
    const synth = SYNTHS[name];
    if (!ctx || !synth) return null;
    // While the scene is cut (caught, dead, won) only the fx bus is audible: don't build voices.
    if (this.scene === 0 && route.bus !== 'fx') return null;
    if (route.pos && route.cull && _v.set(route.pos.x, route.pos.y ?? 1, route.pos.z).distanceTo(this.listenerPos) > route.cull) return null;
    const priority = route.priority ?? 3;
    const kind = route.kind ?? name;
    if (this.spawnBudget <= 0 && priority < 7) return null;
    if (!this.reserve(priority, kind, route.maxKind)) return null;
    this.spawnBudget--;
    const when = ctx.currentTime + 0.01 + (route.delay ?? 0);
    const chain = this.makeChain(route);
    const b = new Builder(ctx, chain.input, when);
    let duration;
    try {
      duration = synth(b, opts);
    } catch (err) {
      b.dispose();
      chain.dispose();
      this.warn(`${name}: ${err?.message || err}`);
      return null;
    }
    const voice = { name, kind, priority, b, chain, born: when, end: when + duration + 0.15, follow: route.follow ?? null, releasing: false };
    this.voices.push(voice);
    return voice;
  }

  // Makes room for a new voice; returns false if it should be dropped.
  reserve(priority, kind, maxKind) {
    if (maxKind) {
      let count = 0;
      let oldest = null;
      for (const v of this.voices) {
        if (v.releasing || v.kind !== kind) continue;
        count++;
        if (!oldest || v.born < oldest.born) oldest = v;
      }
      if (count >= maxKind) {
        // A flurry of the same sound: keep what is already playing rather than churn.
        if (!oldest || this.ctx.currentTime - oldest.born < 0.06) return false;
        this.release(oldest);
      }
    }
    const live = this.voices.reduce((n, v) => n + (v.releasing ? 0 : 1), 0);
    if (live < MAX_VOICES) return true;
    let victim = null;
    for (const v of this.voices) {
      if (v.releasing || v.priority > priority) continue;
      if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.born < victim.born)) victim = v;
    }
    if (!victim) return false;
    this.release(victim);
    return true;
  }

  // Fades a voice out quickly (no click) and schedules its disposal.
  release(v, tc = 0.012) {
    if (v.releasing) return;
    v.releasing = true;
    const now = this.ctx.currentTime;
    const g = v.chain.input.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0, now, tc);
    v.end = Math.min(v.end, now + tc * 8);
  }

  disposeVoice(v) {
    v.b.dispose();
    v.chain.dispose();
  }

  enemySound(name, e, route = {}) {
    const enemy = e.enemy;
    const pos = e.pos ? _v.set(e.pos.x, (e.pos.y ?? 0) < 0.5 ? 1.9 : e.pos.y, e.pos.z) : headOf(enemy, _v);
    if (!pos) return null;
    return this.play(name, {}, {
      bus: 'world', pos: { x: pos.x, y: pos.y, z: pos.z }, follow: enemy, gain: LEVEL[name], priority: 5, cull: 70, ...route,
    });
  }

  debounce(key, seconds) {
    const now = this.ctx.currentTime;
    if (now - (this.last.get(key) ?? -99) < seconds) return false;
    this.last.set(key, now);
    return true;
  }

  // --- event handlers --------------------------------------------------------------------------

  onFootfall(e) {
    const I = clamp(e.intensity ?? 0.5, 0, 1);
    this.play('footfall', { intensity: I }, {
      bus: 'levi', gain: LEVEL.footfall * (0.12 + 0.88 * I ** 1.2), pan: this.panOf(e.pos) * 0.6,
      send: 0.12, vast: 0.35 + 0.3 * (1 - I), priority: 8, kind: 'footfall', maxKind: 3,
    });
    if (I > 0.6) this.ring = Math.max(this.ring, (I - 0.6) * 0.5);
  }

  onCallStart(e) {
    if (this.won) return;
    const now = this.ctx.currentTime;
    const duration = e.duration ?? CONFIG.leviathan.callDuration ?? 4.6;
    const pos = e.pos ?? this.game.leviathan?.position;
    const d = pos ? Math.hypot(pos.x - this.listenerPos.x, pos.z - this.listenerPos.z) : 200;
    const near = 1 - smoothstep(60, 450, d);
    this.calling = true;
    this.callUntil = now + duration + 1.5;
    this.applyBuses(0.3);
    this.play('leviathanCall', { duration, brightness: 0.35 + 0.65 * near }, {
      bus: 'levi', gain: LEVEL.call * (0.6 + 0.4 * near), pan: this.panOf(pos) * 0.45,
      send: 0.15, vast: 0.95, priority: 9, kind: 'call', maxKind: 1,
    });
  }

  onCallEnd() {
    if (!this.calling) return;
    this.calling = false;
    this.applyBuses(0.8);
  }

  onAlert(e) {
    this.enemySound('shriek', e, { ref: 5, send: 0.55, vast: 0.15, priority: 7, cull: 120, kind: 'shriek', maxKind: 3 });
    if (this.debounce('stinger', 4)) {
      this.play('stinger', {}, { bus: 'music', gain: LEVEL.stinger, send: 0.35, priority: 7 });
    }
    this.ring = Math.max(this.ring, 0.6);
  }

  onEnemyStep(e) {
    const chasing = !!(e.chasing ?? e.enemy?.state === 'chase');
    const p = e.pos ?? e.enemy?.position;
    if (!p) return;
    this.play('creatureStep', { chasing }, {
      bus: 'world', pos: { x: p.x, y: 0.2, z: p.z }, ref: 1.5, gain: LEVEL.creatureStep * (chasing ? 1.5 : 1),
      send: 0.14, priority: chasing ? 4 : 2, kind: 'cstep', maxKind: 6, cull: chasing ? 45 : 30,
    });
  }

  onFootstep(e) {
    this.stepSide = -(this.stepSide || 1);
    this.play('footstep', { mode: e.mode }, {
      bus: 'world', gain: LEVEL.footstep, pan: this.stepSide * 0.12, send: e.mode === 'sprint' ? 0.16 : 0.1,
      priority: 3, kind: 'pstep', maxKind: 3,
    });
  }

  onZone(e) {
    const idx = e.index ?? -1;
    if (idx === this.lastZone) return;
    this.lastZone = idx;
    if (this.ctx.currentTime - (this.initTime ?? 0) < 2.5) return; // not on the very first frame
    if (this.debounce('zone', 4)) this.play('swell', {}, { bus: 'music', gain: LEVEL.swell, send: 0.4, priority: 4 });
  }

  startAlarm(e) {
    const ctx = this.ctx;
    const id = e.id ?? 'alarm';
    if (this.alarms.has(id)) {
      this.alarms.get(id).until = ctx.currentTime + (e.duration ?? 14) + 2;
      return;
    }
    const pos = e.pos ?? { x: 0, y: 1, z: 0 };
    const chain = this.makeChain({ bus: 'world', gain: LEVEL.alarm, pos: { x: pos.x, y: 1.0, z: pos.z }, ref: 6, send: 0.5, hrtf: true });
    const voice = new AlarmVoice(ctx, chain.input, ctx.currentTime + 0.02);
    this.alarms.set(id, { voice, chain, until: ctx.currentTime + (e.duration ?? 14) + 2 });
  }

  stopAlarm(id) {
    const a = this.alarms.get(id ?? 'alarm');
    if (!a) return;
    this.alarms.delete(id ?? 'alarm');
    const now = this.ctx.currentTime;
    a.voice.stop(now);
    // Hand it to the voice list so it is disposed once faded.
    this.voices.push({ name: 'alarm', kind: 'alarm-end', priority: 10, b: a.voice.b, chain: a.chain, born: now, end: now + 0.25, releasing: true });
  }

  onCaught() {
    if (this.caughtActive) return;
    this.caughtActive = true;
    const now = this.ctx.currentTime;
    for (const v of this.voices) if (v.kind !== 'grab') this.release(v, 0.03);
    for (const id of [...this.alarms.keys()]) this.stopAlarm(id);
    this.chase = 0;
    this.chaseLayer?.set(0, now);
    this.scene = 0;
    this.applyBuses(0.03);
    this.play('grab', {}, { bus: 'fx', gain: LEVEL.grab, send: 0, priority: 11, kind: 'grab', maxKind: 1 });
  }

  onRespawn() {
    this.caughtActive = false;
    this.won = false;
    this.calling = false;
    this.chase = 0;
    this.threat = 0;
    this.ring = 0;
    for (const id of [...this.alarms.keys()]) this.stopAlarm(id);
    for (const v of this.voices) if (v.kind !== 'grab' && v.kind !== 'call') this.release(v, 0.05);
    for (const s of this.slots) this.freeSlot(s, this.ctx.currentTime);
    this.scene = 1;
    this.applyBuses(0.9);
  }

  onWon() {
    if (this.won) return;
    this.won = true;
    this.calling = false;
    this.scene = 0;
    this.applyBuses(2.6);
    this.play('endingTone', {}, { bus: 'fx', gain: LEVEL.ending, send: 0.35, priority: 10, kind: 'ending', maxKind: 1, delay: 1.5 });
  }

  onState({ state, prev }) {
    const now = this.ctx.currentTime;
    const paused = state === 'paused';
    if (paused !== this.paused) {
      this.paused = paused;
      this.pauseFilter.frequency.setTargetAtTime(paused ? 420 : 20000, now, paused ? 0.12 : 0.2);
      this.pauseGain.gain.setTargetAtTime(paused ? 0.5 : 1, now, 0.15);
    }
    if (state === 'caught') this.onCaught();
    else if (state === 'dead') {
      if (this.scene !== 0) {
        this.scene = 0;
        this.applyBuses(0.2);
      }
    } else if (state === 'won') this.onWon();
    else if (state === 'playing' && (prev === 'dead' || prev === 'caught') && this.caughtActive) this.onRespawn();
  }

  // Sets every bus to (call duck × scene fader).
  applyBuses(tc) {
    const now = this.ctx.currentTime;
    for (const name of BUS_NAMES) {
      const bus = this.buses[name];
      const v = (this.calling ? CALL_DUCK[name] : 1) * (name === 'fx' ? 1 : this.scene);
      for (const g of [bus.dry, bus.wet, bus.vast]) g.gain.setTargetAtTime(v, now, tc);
    }
  }

  // --- per-frame -------------------------------------------------------------------------------

  update(dt) {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    try {
      this.tick(Math.min(0.1, Math.max(0, dt || 0)), ctx.currentTime);
    } catch (err) {
      this.warn(`update: ${err?.message || err}`);
    }
  }

  tick(dt, now) {
    const game = this.game;
    const state = game.state;
    this.spawnBudget = SPAWN_BUDGET;
    this.updateListener();

    const live = state === 'playing' || state === 'caught';
    const ambient = live || state === 'title' || state === 'intro';
    const threatTarget = live ? clamp(game.director?.threat ?? 0, 0, 1) : 0;
    this.threat = damp(this.threat, threatTarget, threatTarget > this.threat ? 4 : 0.7, dt);
    const chasing = state === 'playing' && (game.director?.chasing ?? 0) > 0;
    this.chase = chasing ? Math.min(1, this.chase + dt / 1.4) : Math.max(0, this.chase - dt / 8);
    this.ring = Math.max(0, this.ring - dt * 0.35);

    if (this.calling && now > this.callUntil) this.onCallEnd();

    // Slow-changing layer parameters at ~10 Hz.
    this.layerTimer -= dt;
    if (this.layerTimer <= 0) {
      this.layerTimer = 0.1;
      const t = this.threat;
      this.tinnitus.setLevel(LEVEL.tinnitusMin + (LEVEL.tinnitusMax - LEVEL.tinnitusMin) * Math.max(smoothstep(0.2, 1, t), this.ring), now, 0.15);
      this.chaseLayer.set(this.chase, now);
      this.drone.setLevel(LEVEL.drone * (1 + 0.6 * t), now, 1.5);
    }
    this.wind.schedule(now, 1);
    const tension = Math.max(this.threat, this.chase * 0.9);
    const heartLevel = live ? smoothstep(0.28, 0.85, tension) : 0;
    this.heart.schedule(now, LOOKAHEAD, 62 + 78 * smoothstep(0.3, 1, tension), heartLevel);

    this.updateWhispers(now, state);
    if (ambient && !this.won) {
      this.updateAmbient(now);
      this.updateLeviathan(now);
    }
    for (const [id, a] of this.alarms) {
      a.voice.schedule(now, LOOKAHEAD);
      if (now > a.until) this.stopAlarm(id);
    }
    this.updateVoices(now);
  }

  updateListener() {
    const cam = this.game.camera;
    if (!cam) return;
    const l = this.ctx.listener;
    const p = cam.position;
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    _right.crossVectors(_fwd, _up).normalize();
    this.listenerPos.copy(p);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = _fwd.x;
      l.forwardY.value = _fwd.y;
      l.forwardZ.value = _fwd.z;
      l.upX.value = _up.x;
      l.upY.value = _up.y;
      l.upZ.value = _up.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(_fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z);
    }
  }

  updateVoices(now) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now >= v.end) {
        this.disposeVoice(v);
        this.voices.splice(i, 1);
        continue;
      }
      if (v.chain.panner) {
        if (v.follow) {
          const head = headOf(v.follow, _v);
          if (head) this.placeChain(v.chain, head);
        } else this.placeChain(v.chain, v.chain.pos);
      }
    }
  }

  // Assign the nearest snatchers to the whisper voices and drive their babble.
  updateWhispers(now, state) {
    const allowed = state === 'playing' || state === 'title' || state === 'intro';
    const list = allowed && !this.calling ? this.game.director?.snatchers ?? [] : [];
    const near = [];
    for (const s of list) {
      const head = headOf(s, _v);
      if (!head) continue;
      const d = head.distanceTo(this.listenerPos);
      if (d < WHISPER_KEEP) near.push({ s, d });
    }
    near.sort((a, b) => a.d - b.d);
    if (near.length > WHISPER_SLOTS) near.length = WHISPER_SLOTS;

    for (const slot of this.slots) {
      if (slot.enemy && !near.some((n) => n.s === slot.enemy)) this.freeSlot(slot, now);
    }
    for (const n of near) {
      if (this.slots.some((sl) => sl.enemy === n.s) || n.d > WHISPER_RANGE) continue;
      const slot = this.slots.find((sl) => !sl.enemy && now >= sl.freeAt);
      if (!slot) continue;
      slot.enemy = n.s;
      this.placeChain(slot.chain, headOf(n.s, _v), true);
      slot.chain.input.gain.cancelScheduledValues(now);
      slot.chain.input.gain.setTargetAtTime(1, now, 0.2);
    }
    for (const slot of this.slots) {
      if (!slot.enemy) continue;
      const head = headOf(slot.enemy, _v);
      if (head) this.placeChain(slot.chain, head);
      const enemy = slot.enemy;
      let style = WHISPER_STYLES[STATE_STYLE[enemy.state] ?? 'calm'] ?? null;
      if (enemy.state === 'rapture' || enemy.state === 'grab') style = null;
      else if (enemy.def?.sleeping && (enemy.state === 'idle' || !enemy.state)) style = WHISPER_STYLES.trance;
      slot.voice.schedule(now, LOOKAHEAD, style);
    }
  }

  freeSlot(slot, now) {
    if (!slot.enemy) return;
    slot.enemy = null;
    slot.freeAt = now + 0.6;
    slot.chain.input.gain.cancelScheduledValues(now);
    slot.chain.input.gain.setTargetAtTime(0, now, 0.12);
    slot.voice.silence(now);
  }

  // Sparse distant city sounds: groaning steel, creaks, and very rarely something like a voice.
  updateAmbient(now) {
    if (now >= this.nextAmbient) {
      this.nextAmbient = now + rand(7, 20);
      this.playDistant(Math.random() < 0.62 ? 'metalGroan' : 'structureCreak');
    }
    if (now >= this.nextWail) {
      this.nextWail = now + rand(55, 130);
      this.playDistant('distantWail');
    }
  }

  playDistant(name) {
    const a = Math.random() * TAU;
    const d = rand(45, 140);
    const L = this.listenerPos;
    this.play(name, {}, {
      bus: 'world', pos: { x: L.x + Math.cos(a) * d, y: rand(6, 30), z: L.z + Math.sin(a) * d },
      ref: 30, gain: LEVEL[name], send: 0.9, vast: 0.35, priority: 1, kind: 'amb', maxKind: 2,
    });
  }

  // When the leviathan is overhead its joints groan (positional, from its body).
  updateLeviathan(now) {
    const lev = this.game.leviathan;
    const p = lev?.position;
    if (!p || lev.calling || now < this.nextLegGroan) return;
    const d = Math.hypot(p.x - this.listenerPos.x, p.z - this.listenerPos.z);
    if (d > 170) {
      this.nextLegGroan = now + 3;
      return;
    }
    this.nextLegGroan = now + rand(3.5, 8) * (0.6 + d / 170);
    this.play('legGroan', {}, {
      bus: 'levi', pos: { x: p.x, y: Math.max(20, (p.y ?? 100) * 0.6), z: p.z }, ref: 45,
      gain: LEVEL.legGroan, send: 0.4, vast: 0.6, priority: 2, kind: 'leg', maxKind: 2,
    });
  }

  // --- diagnostics -----------------------------------------------------------------------------

  // Output level of the final mix over the last ~43 ms: { rmsDb, peakDb } (creates an analyser lazily).
  meter() {
    if (!this.ctx) return null;
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.limiter.connect(this.analyser);
      this.meterBuf = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    let peak = 0;
    for (const x of this.meterBuf) {
      sum += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    const db = (v) => (v > 1e-7 ? +(20 * Math.log10(v)).toFixed(1) : -140);
    return { rmsDb: db(Math.sqrt(sum / this.meterBuf.length)), peakDb: db(peak), reduction: +(this.compressor.reduction ?? 0).toFixed(1) };
  }

  // Counts of live voices and (approximately) live nodes, for tests and the debug overlay.
  stats() {
    if (!this.ctx) return { state: this.muted ? 'muted' : 'off', voices: 0, nodes: 0 };
    let voiceNodes = 0;
    for (const v of this.voices) voiceNodes += v.b.nodes.length + v.chain.nodes.length;
    let layerNodes = 0;
    for (const l of this.layers) layerNodes += l.nodeCount;
    for (const s of this.slots) layerNodes += s.voice.nodeCount + s.chain.nodes.length;
    for (const a of this.alarms.values()) layerNodes += a.voice.nodeCount + a.chain.nodes.length;
    return {
      state: this.ctx.state,
      voices: this.voices.length,
      alarms: this.alarms.size,
      whispering: this.slots.filter((s) => s.enemy).length,
      voiceNodes,
      layerNodes,
      graphNodes: this.persistent.length,
      nodes: voiceNodes + layerNodes + this.persistent.length,
      threat: +this.threat.toFixed(2),
      chase: +this.chase.toFixed(2),
      calling: this.calling,
      scene: this.scene,
    };
  }
}
