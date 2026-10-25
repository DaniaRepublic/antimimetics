import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { angleDiff, dirToYaw } from '../core/math.js';
import { Snatcher } from './snatcher.js';
import { TUNE } from './brain.js';

const E = CONFIG.enemy;
const MAX_PATHS_PER_FRAME = 3;
const PATH_BUDGET_MS = 1.2;
const SEPARATION = 1.2;
const PLAYER_SPACE = 0.85;
const INDICATOR_RANGE = 35;
const CALL_GRACE = 1.5; // seconds past a call's announced duration before we assume it ended

// Spawns and coordinates the snatchers: routes sounds to whoever can hear them, decides who goes
// to look at a bottle, spreads the shriek, runs the call, throttles path-finding, keeps distant
// zones asleep, and reports threat / indicators for the HUD, audio and post-processing.
export class Director {
  constructor(game) {
    this.game = game;
    this.snatchers = [];
    this.threat = 0;
    this.chasing = 0;
    this.calling = false;
    this.callEndsAt = 0;
    this.callPos = new THREE.Vector3();
    this.caughtBy = null;
    this.pathQueue = [];
    this.pathCache = new Map();
    this.alarms = [];
    this.perf = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, paths: 0, pathMs: 0, maxPathMs: 0 };
    const defs = Array.isArray(game.level?.enemies) ? game.level.enemies : [];
    defs.forEach((def, i) => this.snatchers.push(new Snatcher(game, def, i, this)));

    const bus = game.bus;
    this.unsubs = [
      bus.on('noise', (e) => this.onNoise(e)),
      bus.on('alarm:start', (e) => this.onAlarmStart(e)),
      bus.on('alarm:end', (e) => this.onAlarmEnd(e)),
      bus.on('leviathan:call:start', (e) => this.onCallStart(e)),
      bus.on('leviathan:call:end', () => this.onCallEnd()),
      bus.on('leviathan:footfall', (e) => this.onFootfall(e)),
      bus.on('gate:open', () => this.pathCache.clear()),
    ];
    this.debugView = game.debug && typeof document !== 'undefined' ? new DebugView(this) : null;
  }

  // --- per-frame -----------------------------------------------------------------

  update(dt) {
    const t0 = performance.now();
    // Never leave anyone entranced if a call's end event goes missing (e.g. a respawn mid-call).
    if (this.calling && this.game.time > this.callEndsAt) this.onCallEnd();
    this.processPaths();
    for (const s of this.snatchers) {
      const was = s.active;
      s.active = this.isActive(s);
      if (s.active && !was && this.calling) s.brain.scheduleRapture(Math.random() * TUNE.raptureStagger, this.callPos);
    }
    this.separate();
    let threat = 0;
    let chasing = 0;
    for (const s of this.snatchers) {
      if (s.active) s.update(dt);
      else s.updateDormant(dt);
      if (!s.active) continue;
      const st = s.state;
      if (st === 'chase' || st === 'grab') {
        chasing++;
        threat = 1;
      } else if (s.detection > threat) threat = s.detection;
    }
    this.threat = threat;
    this.chasing = chasing;
    this.game.atmosphere?.setThreat?.(threat);
    this.debugView?.update();
    const ms = performance.now() - t0;
    const p = this.perf;
    p.frames++;
    p.totalMs += ms;
    p.lastMs = ms;
    if (ms > p.maxMs) p.maxMs = ms;
  }

  // Only snatchers within one zone of the player think; engaged ones finish what they started.
  isActive(s) {
    const cz = this.game.level?.currentZone;
    const z = s.def.zone;
    if (typeof cz !== 'number' || cz < 0 || typeof z !== 'number') return true;
    return Math.abs(z - cz) <= 1 || s.brain.engaged;
  }

  reset() {
    this.pathQueue.length = 0;
    this.alarms.length = 0;
    this.caughtBy = null;
    this.calling = !!this.game.leviathan?.calling;
    for (const s of this.snatchers) {
      s.queued = false;
      s.reset();
      s.active = this.isActive(s);
    }
    if (this.calling) {
      const lp = this.game.leviathan?.position;
      if (lp) this.callPos.copy(lp);
      this.callEndsAt = this.game.time + CONFIG.leviathan.callDuration + CALL_GRACE;
      for (const s of this.snatchers) s.brain.scheduleRapture(Math.random() * TUNE.raptureStagger, this.callPos);
    }
    this.threat = 0;
    this.chasing = 0;
  }

  dispose() {
    for (const u of this.unsubs) u();
    for (const s of this.snatchers) s.dispose();
    this.snatchers.length = 0;
    this.debugView?.dispose();
  }

  // --- path-finding throttle ---------------------------------------------------------

  requestPath(s) {
    if (s.queued) return;
    s.queued = true;
    this.pathQueue.push(s);
  }

  // At most MAX_PATHS_PER_FRAME searches, and no new one once PATH_BUDGET_MS has been spent.
  processPaths() {
    const nav = this.game.nav;
    const start = performance.now();
    let done = 0;
    while (done < MAX_PATHS_PER_FRAME && this.pathQueue.length && (done === 0 || performance.now() - start < PATH_BUDGET_MS)) {
      const s = this.pathQueue.shift();
      s.queued = false;
      if (!s.pathPending || !s.goal) continue;
      const t0 = performance.now();
      const path = nav.findPath(s.position, s.goal);
      const ms = performance.now() - t0;
      this.perf.pathMs += ms;
      this.perf.maxPathMs = Math.max(this.perf.maxPathMs, ms);
      this.perf.paths++;
      s.receivePath(path);
      done++;
    }
  }

  // Soft push between snatchers (and away from the player unless they want you).
  separate() {
    const list = this.snatchers;
    for (const s of list) {
      s.sepX = 0;
      s.sepZ = 0;
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.active) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.active) continue;
        const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= SEPARATION * SEPARATION) continue;
        const d = Math.sqrt(d2) || 0.01;
        const push = (SEPARATION - d) / SEPARATION;
        const nx = d2 > 1e-6 ? dx / d : Math.random() - 0.5, nz = d2 > 1e-6 ? dz / d : Math.random() - 0.5;
        const wa = a.state === 'grab' ? 0 : 1, wb = b.state === 'grab' ? 0 : 1;
        a.sepX -= nx * push * wa;
        a.sepZ -= nz * push * wa;
        b.sepX += nx * push * wb;
        b.sepZ += nz * push * wb;
      }
    }
    const p = this.game.player?.position;
    if (!p) return;
    for (const s of list) {
      if (!s.active || s.chasing || s.state === 'grab') continue;
      const dx = s.position.x - p.x, dz = s.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d >= PLAYER_SPACE || d < 1e-3) continue;
      const push = (PLAYER_SPACE - d) / PLAYER_SPACE;
      s.sepX += (dx / d) * push;
      s.sepZ += (dz / d) * push;
    }
  }

  // --- sound ---------------------------------------------------------------------------

  onNoise(e) {
    if (!e?.pos) return;
    const source = e.source || 'other';
    if (source === 'alarm') {
      const a = this.alarmFromNoise(e);
      this.broadcastAlarm(a, e.radius ?? CONFIG.noise.alarm);
      return;
    }
    const hearers = [];
    for (const s of this.snatchers) {
      if (!s.active) continue;
      const c = s.brain.hearing(e.pos, e.radius ?? 0);
      if (c >= 0) hearers.push({ s, c, d: Math.hypot(e.pos.x - s.position.x, e.pos.z - s.position.z) });
    }
    if (!hearers.length) return;
    if (source === 'player') {
      for (const h of hearers) h.s.brain.hearPlayer(e, h.c);
      return;
    }
    if (source === 'gate') {
      for (const h of hearers) h.s.brain.hearDistraction(e.pos, h.c, 'investigate', source);
      return;
    }
    // A bottle (or anything else): the nearest free snatcher goes to look, the others only turn
    // their heads. Throwing near a group pulls them one at a time.
    hearers.sort((a, b) => a.d - b.d);
    let sent = 0;
    for (const h of hearers) {
      const role = sent < 1 && h.s.brain.canInvestigate() ? 'investigate' : 'glance';
      if (role === 'investigate') sent++;
      h.s.brain.hearDistraction(e.pos, h.c, role, source);
    }
  }

  shout(src) {
    for (const s of this.snatchers) {
      if (s === src || !s.active) continue;
      if (s.brain.hearing(src.position, E.alertShoutRadius) >= 0) s.brain.hearShout(src.position);
    }
  }

  // Calm neighbours follow a suspicious snatcher's gaze: a readable "what's that?" moment.
  shareGaze(src, pos) {
    for (const s of this.snatchers) {
      if (s === src || !s.active || s.brain.asleep) continue;
      const st = s.state;
      if (st !== 'idle' && st !== 'patrol' && st !== 'return') continue;
      if (Math.hypot(s.position.x - src.position.x, s.position.z - src.position.z) > 10) continue;
      s.brain.glance({ x: pos.x, y: 1.2, z: pos.z }, 1.4 + Math.random() * 0.8, 5);
    }
  }

  // --- alarms ---------------------------------------------------------------------------

  findAlarm(id, pos) {
    for (const a of this.alarms) {
      if (id != null && a.id === id) return a;
      if (pos && Math.hypot(a.pos.x - pos.x, a.pos.z - pos.z) < 4) return a;
    }
    return null;
  }

  onAlarmStart(e) {
    if (!e?.pos) return;
    const now = this.game.time;
    let a = this.findAlarm(e.id, e.pos);
    if (!a) {
      a = { id: e.id ?? `alarm_${this.alarms.length}`, pos: { x: e.pos.x, y: e.pos.y || 0, z: e.pos.z } };
      this.alarms.push(a);
    }
    a.ended = false;
    a.endsAt = now + (e.duration ?? 14) + 0.5;
    this.broadcastAlarm(a, CONFIG.noise.alarm);
  }

  onAlarmEnd(e) {
    const a = this.findAlarm(e?.id, e?.pos);
    if (!a || a.ended) return;
    a.ended = true;
    a.endedAt = this.game.time;
  }

  alarmFromNoise(e) {
    const now = this.game.time;
    let a = this.findAlarm(null, e.pos);
    if (!a) {
      a = { id: `noise_alarm_${this.alarms.length}`, pos: { x: e.pos.x, y: e.pos.y || 0, z: e.pos.z }, ended: false, endsAt: now };
      this.alarms.push(a);
    }
    if (!a.ended) a.endsAt = Math.max(a.endsAt, now + 2);
    return a;
  }

  alarmActive(a) {
    return !a.ended && this.game.time < a.endsAt;
  }

  alarmEndTime(a) {
    return a.ended ? a.endedAt : a.endsAt;
  }

  // Still worth walking to / standing at (wailing, or only just stopped).
  alarmRelevant(a) {
    return this.alarmActive(a) || this.game.time < this.alarmEndTime(a) + TUNE.alarm.linger;
  }

  broadcastAlarm(a, radius) {
    if (!this.alarmActive(a)) return;
    for (const s of this.snatchers) {
      if (!s.active) continue;
      if (s.brain.hearing(a.pos, radius, TUNE.alarm.occlusion) >= 0) s.brain.hearAlarm(a);
    }
  }

  // --- the leviathan ----------------------------------------------------------------------

  onCallStart(e) {
    this.calling = true;
    this.callEndsAt = this.game.time + (e?.duration ?? CONFIG.leviathan.callDuration) + CALL_GRACE;
    const p = e?.pos || this.game.leviathan?.position;
    if (p) this.callPos.set(p.x, p.y || 0, p.z);
    for (const s of this.snatchers) s.brain.scheduleRapture(Math.random() * TUNE.raptureStagger, this.callPos);
  }

  onCallEnd() {
    this.calling = false;
    for (const s of this.snatchers) s.brain.endRapture();
  }

  onFootfall(e) {
    if (!e?.pos) return;
    for (const s of this.snatchers) if (s.active && Math.random() < 0.45) s.brain.footfall(e.pos);
  }

  // --- catching -----------------------------------------------------------------------------

  tryCatch(brain) {
    if (this.game.god) {
      brain.loseInterest();
      return;
    }
    if (this.caughtBy) return;
    this.caughtBy = brain.body;
    brain.enterGrab();
    this.game.bus.emit('player:caught', { enemy: brain.body });
  }

  // --- HUD ----------------------------------------------------------------------------------

  getIndicators() {
    const out = [];
    const player = this.game.player;
    if (!player) return out;
    const p = player.position;
    const camYaw = player.yaw;
    for (const s of this.snatchers) {
      if (!s.active) continue;
      const st = s.state;
      const engaged = st === 'chase' || st === 'search' || st === 'grab';
      const det = st === 'chase' || st === 'grab' ? 1 : s.detection;
      if (!engaged && det <= 0.05) continue;
      const dx = s.position.x - p.x, dz = s.position.z - p.z;
      const distance = Math.hypot(dx, dz);
      if (distance > INDICATOR_RANGE) continue;
      out.push({ enemy: s, detection: det, bearing: angleDiff(camYaw, dirToYaw(dx, dz)), state: st, distance });
    }
    return out;
  }
}

// ?debug: state/detection labels over each snatcher, flat view cones, and current paths.
const STATE_COLORS = {
  idle: '#8fbf8f', patrol: '#8fbf8f', suspicious: '#ffd84a', investigate: '#ff9f3a', alarm: '#e055ff',
  chase: '#ff3030', search: '#ff6a3a', return: '#6fa8ff', rapture: '#b080ff', grab: '#ff0000',
};
const MAX_PATH_SEGMENTS = 512;

class DebugView {
  constructor(director) {
    this.director = director;
    this.game = director.game;
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:40;font:11px/1.25 monospace;';
    document.body.appendChild(this.el);
    this.items = director.snatchers.map((s) => this.makeItem(s));
    const geo = new THREE.BufferGeometry();
    this.pathPositions = new Float32Array(MAX_PATH_SEGMENTS * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pathPositions, 3));
    this.paths = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.8, depthTest: false, fog: false }));
    this.paths.frustumCulled = false;
    this.paths.renderOrder = 999;
    this.game.scene.add(this.paths);
    this.v = new THREE.Vector3();
  }

  makeItem(s) {
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;text-align:center;color:#fff;text-shadow:0 0 3px #000,0 0 2px #000;';
    this.el.appendChild(label);
    const pivot = new THREE.Group();
    const mk = (radius, angle, opacity) => {
      const geo = new THREE.CircleGeometry(radius, 24, Math.PI / 2 - angle / 2, angle);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      pivot.add(m);
      return m;
    };
    const cone = mk(E.viewDistance, E.fov, 0.07);
    const focus = mk(E.viewDistance, E.focusFov, 0.08);
    this.game.scene.add(pivot);
    return { s, label, pivot, cone, focus, text: '' };
  }

  update() {
    const cam = this.game.camera;
    const w = window.innerWidth, h = window.innerHeight;
    for (const it of this.items) {
      const s = it.s;
      const st = s.state;
      const color = STATE_COLORS[st] || '#fff';
      it.pivot.visible = s.active && st !== 'rapture';
      it.pivot.position.set(s.position.x, 0.06, s.position.z);
      it.pivot.rotation.y = s.yaw + s.headYaw;
      it.cone.material.color.set(color);
      it.focus.material.color.set(color);
      const det = st === 'chase' || st === 'grab' ? 1 : s.detection;
      it.cone.material.opacity = 0.06 + det * 0.1;
      it.focus.material.opacity = 0.08 + det * 0.16;
      const text = `${s.id}\n${st}${s.brain.asleep ? ' zz' : ''} ${s.detection.toFixed(2)}`;
      if (text !== it.text) {
        it.text = text;
        it.label.textContent = text;
      }
      it.label.style.color = color;
      this.v.set(s.position.x, 2.6, s.position.z).project(cam);
      const show = s.active && this.v.z < 1 && Math.abs(this.v.x) < 1.2 && Math.abs(this.v.y) < 1.2;
      it.label.style.display = show ? 'block' : 'none';
      if (show) it.label.style.transform = `translate(${((this.v.x + 1) / 2) * w - 40}px, ${((1 - this.v.y) / 2) * h - 20}px)`;
    }
    // Paths as line segments.
    let n = 0;
    const P = this.pathPositions;
    for (const s of this.director.snatchers) {
      if (!s.path || !s.active) continue;
      let px = s.position.x, pz = s.position.z;
      for (let i = s.pathIndex; i < s.path.length && n < MAX_PATH_SEGMENTS; i++) {
        const wp = s.path[i];
        P.set([px, 0.12, pz, wp.x, 0.12, wp.z], n * 6);
        px = wp.x;
        pz = wp.z;
        n++;
      }
    }
    const geo = this.paths.geometry;
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.el.remove();
    this.game.scene.remove(this.paths);
    for (const it of this.items) this.game.scene.remove(it.pivot);
  }
}
