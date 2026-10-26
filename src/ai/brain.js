import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { angleDiff, clamp, dirToYaw, lerp, smoothstep } from '../core/math.js';

const E = CONFIG.enemy;

// AI-private tuning. Shared balance numbers (speeds, cones, radii) live in CONFIG.enemy.
export const TUNE = {
  perceptionHz: 18,
  suspectAt: 0.3, // detection that makes a snatcher stop and look
  minTelegraph: 0.5, // seconds of visible staring before any shriek
  freshSighting: 1.0, // seconds unseen before a new sighting counts as "new" (re-telegraphs)
  // Detection per second at a distance (metres), before the multipliers below.
  distanceCurve: [[0, 3.0], [3, 2.0], [6, 1.3], [10, 0.7], [15, 0.42], [20, 0.28], [28, 0.15], [40, 0.1]],
  peripheryFactor: 0.45,
  stance: { crouchStill: 0.4, crouch: 0.5, still: 0.6, walk: 1.0, sprint: 1.3 },
  light: [0.45, 1.35],
  stateFactor: { suspicious: 1.3, investigate: 1.3, return: 1.15, search: 1.6, alarm: 0.35 },
  partialVisibility: 0.6,
  proximityRate: 2.6, // per second, player moving un-crouched within CONFIG.enemy.proximitySense
  decayDelay: 0.6,
  decay: { calm: 0.25, suspicious: 0.12, investigate: 0.15, return: 0.2, search: 0.04, alarm: 0.25, rapture: 0.1 },
  hearingCap: 0.92, // sound alone never completes a detection: they have to see you
  soundBend: 2.5, // metres: obstacles narrower than about twice this don't muffle a sound
  sleep: { perception: 0.25, range: 9, cone: 0.7, hearing: 0.6, wakeTime: 1.5, resettle: 6 },
  twitchRate: 20,
  creepSpeed: 0.55,
  chaseRepath: 0.35,
  chaseRepathMove: 1.5,
  chaseDetour: 25, // metres of path left: beyond this, re-plan at most every chaseDetourRepath s
  chaseDetourRepath: 1.2,
  chaseDetourMove: 6,
  chaseLead: 0.3, // seconds of player velocity it aims ahead while it can see you
  searchStartDetection: 0.6,
  searchRadius: 9,
  shoutDetection: 0.5,
  alarm: { speed: 2.4, ringMin: 2.8, ringSpread: 1.4, linger: 3, minStare: 7, occlusion: 0.8 },
  raptureStagger: 0.35,
  rapturePitch: 0.7, // ~40 degrees up
  raptureRecover: 0.5, // s after the call ends: heads still coming down, blind and deaf
  // Devouts do nothing but watch the open ground: sharper eyes than a sentry.
  devoutPerception: 1.5,
  grabRange: [1.0, 1.12], // metres, root to player, held through the death cam
};

// Piecewise-linear lookup in a sorted [[x, y], ...] table.
function curve(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return table[table.length - 1][1];
}

// Smoothed triangle wave with holds at both ends, u in cycles: -1 .. hold .. +1 .. hold .. -1.
function sweep(u) {
  u -= Math.floor(u);
  const s = (t) => t * t * (3 - 2 * t);
  if (u < 0.15) return -1;
  if (u < 0.5) return -1 + 2 * s((u - 0.15) / 0.35);
  if (u < 0.65) return 1;
  return 1 - 2 * s((u - 0.65) / 0.35);
}

const CALM = new Set(['idle', 'patrol']);
const _eye = new THREE.Vector3();
const _pEye = new THREE.Vector3();
const _pChest = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

// One snatcher's mind: perception (sight + hearing), detection and the behaviour state machine.
// It steers its body (Snatcher) through a small API: go / halt / face / lookAt / lookRel / twitch.
//
// States: idle | patrol (calm, per kind) -> suspicious -> investigate -> return
//         chase -> search -> return,  alarm,  rapture (the call),  grab.
export class Brain {
  constructor(body, game, director) {
    this.body = body;
    this.game = game;
    this.director = director;
    this.def = body.def;
    this.kind = this.def.kind || 'sentry';
    this.sleeper = !!this.def.sleeping;
    const p = this.def.pos || { x: 0, z: 0 };
    this.post = { x: p.x, z: p.z, yaw: this.def.yaw ?? 0 };
    this.route = Array.isArray(this.def.route) && this.def.route.length ? this.def.route : null;
    const devout = this.kind === 'devout';
    this.scanArc = this.def.scanArc ?? (devout ? 2.6 : this.kind === 'sentry' ? 1.6 : 0);
    this.scanPeriod = Math.max(2, this.def.scanPeriod ?? (devout ? 14 : 9));
    this.lastSeenPos = { x: 0, z: 0 };
    this.lastSeenVel = { x: 0, z: 0 };
    this.stimulus = { x: 0, z: 0 };
    this.target = { x: 0, z: 0 };
    this.searchCenter = { x: 0, z: 0 };
    this.chaseGoal = { x: 0, z: 0 };
    this.glancePos = { x: 0, y: 0, z: 0 };
    this.visited = [];
    this.percTimer = Math.random() / TUNE.perceptionHz;
  }

  reset() {
    this.detection = 0;
    this.seenNow = false;
    this.lastSeenTime = -1e9;
    this.sightingReacted = false;
    this.lastSuspiciousEmit = -1e9;
    this.ignoreUntil = -1e9;
    this.wakeUntil = -1e9;
    this.glanceUntil = -1e9;
    this.raptureAt = null;
    this.resume = null;
    this.alarm = null;
    this.asleep = this.sleeper;
    this.atPostTime = 0;
    this.routeIndex = this.route ? this.nearestRouteIndex() : 0;
    this.routeDir = 1;
    this.scanPhase = Math.random();
    this.lookTimer = 0;
    this.lookSide = Math.random() < 0.5 ? -1 : 1;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.idleLookAt = this.game.time + 2 + Math.random() * 4;
    this.twitchAt = this.game.time + 4 + Math.random() * 8;
    this.disappointed = false;
    this.enterCalm();
  }

  get engaged() {
    return !CALM.has(this.state);
  }

  get slumpTarget() {
    if (this.asleep) return this.state === 'rapture' ? 0.6 : 1;
    return 0;
  }

  setState(state, phase = null) {
    this.state = state;
    this.stateTime = 0;
    this.phase = phase;
    this.phaseTime = 0;
    this.body.chasing = state === 'chase';
    this.body.turnMul = state === 'chase' ? 1.6 : state === 'suspicious' ? 0.7 : 1;
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseTime = 0;
  }

  emit(type, extra) {
    this.game.bus.emit(type, { enemy: this.body, ...extra });
  }

  // --- per-frame ---------------------------------------------------------

  update(dt) {
    const now = this.game.time;
    this.stateTime += dt;
    this.phaseTime += dt;
    if (this.raptureAt !== null && now >= this.raptureAt) {
      this.raptureAt = null;
      this.enterRapture();
    }
    this.percTimer -= dt;
    this.percDt = (this.percDt || 0) + dt;
    if (this.percTimer <= 0 || this.state === 'chase') {
      this.perceive(Math.min(this.percDt, 0.25));
      this.percDt = 0;
      this.percTimer = Math.max(0, this.percTimer + (0.9 + Math.random() * 0.2) / TUNE.perceptionHz);
    }
    const waking = now < this.wakeUntil;
    this.body.hold = waking;
    if (waking) {
      // Waking up: unfold and lift the head first. Whatever woke it (a shout, an alarm) has already
      // set its errand; the body only starts walking once it's up.
      this.body.lookRel(0, lerp(0.05, -0.6, (this.wakeUntil - now) / TUNE.sleep.wakeTime), 3);
      return;
    }
    switch (this.state) {
      case 'idle':
      case 'patrol': this.updateCalm(dt); break;
      case 'suspicious': this.updateSuspicious(dt); break;
      case 'investigate': this.updateInvestigate(dt); break;
      case 'alarm': this.updateAlarm(dt); break;
      case 'chase': this.updateChase(dt); break;
      case 'search': this.updateSearch(dt); break;
      case 'return': this.updateReturn(dt); break;
      case 'rapture': this.updateRapture(dt); break;
      case 'grab': this.updateGrab(dt); break;
      default: this.enterCalm();
    }
    this.updateGlance();
  }

  // --- perception --------------------------------------------------------

  // Cone + line-of-sight test against the player's eye and chest. Returns 0 (unseen), partial or 1.
  sense() {
    const { body, game } = this;
    const player = game.player;
    const eye = body.getEyePos(_eye);
    player.getEyePos(_pEye);
    player.getChestPos(_pChest);
    const dx = _pChest.x - eye.x, dz = _pChest.z - eye.z;
    const d = Math.hypot(dx, dz);
    const chasing = this.state === 'chase';
    let range = E.viewDistance * (chasing ? 1.25 : this.state === 'search' ? 1.1 : 1);
    if (this.asleep) range = TUNE.sleep.range;
    const near = d <= E.proximitySense;
    this.senseDist = d;
    this.senseNear = near;
    this.senseInCone = false;
    if (d > range && !near) return 0;
    const ang = d < 0.05 ? 0 : Math.abs(angleDiff(body.yaw + body.headYaw, dirToYaw(dx, dz)));
    this.senseAngle = ang;
    const coneMul = chasing ? 1.6 : this.asleep ? TUNE.sleep.cone : 1;
    this.senseInCone = ang <= E.fov * 0.5 * coneMul && d <= range;
    if (!this.senseInCone && !near) return 0;
    const eyeVis = !game.world.segmentBlocked(eye, _pEye);
    const chestVis = !game.world.segmentBlocked(eye, _pChest);
    if (eyeVis && chestVis) return 1;
    return eyeVis || chestVis ? TUNE.partialVisibility : 0;
  }

  stanceFactor() {
    const p = this.game.player;
    const S = TUNE.stance;
    if (p.mode === 'sprint') return S.sprint;
    if (p.mode === 'walk') return S.walk;
    if (p.mode === 'crouch') return S.crouch;
    return p.crouched ? S.crouchStill : S.still;
  }

  stateFactor() {
    return TUNE.stateFactor[this.state] ?? 1;
  }

  // Detection gained per second while the player is visible with factor `vis`.
  detectionRate(vis) {
    const p = this.game.player;
    let rate = 0;
    if (this.senseInCone) {
      const focusHalf = E.focusFov * 0.5;
      const focus = lerp(1, TUNE.peripheryFactor, smoothstep(focusHalf, focusHalf + 0.25, this.senseAngle));
      const light = lerp(TUNE.light[0], TUNE.light[1], clamp(Number.isFinite(p.lightLevel) ? p.lightLevel : 0.2, 0, 1));
      rate = curve(TUNE.distanceCurve, this.senseDist) * focus * this.stanceFactor() * light * this.stateFactor() * vis;
    }
    if (this.kind === 'devout') rate *= TUNE.devoutPerception;
    if (this.senseNear && !p.crouched && (p.mode === 'walk' || p.mode === 'sprint')) rate += TUNE.proximityRate;
    if (this.asleep) rate *= TUNE.sleep.perception;
    if (this.game.time < this.wakeUntil) rate *= 0.5;
    return rate;
  }

  decayRate() {
    if (this.asleep) return TUNE.decay.calm;
    return TUNE.decay[this.state] ?? TUNE.decay.calm;
  }

  isBlind() {
    const st = this.state;
    if (this.game.state !== 'playing') return true;
    if (st === 'rapture' || st === 'grab') return true;
    if (this.director?.calling && this.raptureAt === null) return true; // the call blinds everyone
    return this.game.time < this.ignoreUntil;
  }

  perceive(pdt) {
    const now = this.game.time;
    const blind = this.isBlind();
    const vis = blind ? 0 : this.sense();
    const chasing = this.state === 'chase';
    const rate = vis > 0 && !chasing ? this.detectionRate(vis) : 0;
    const seen = vis > 0 && (chasing || rate > 0);
    this.seenNow = seen;
    if (seen) {
      if (now - this.lastSeenTime > TUNE.freshSighting) this.sightingReacted = false;
      this.lastSeenTime = now;
      const p = this.game.player;
      this.lastSeenPos.x = p.position.x;
      this.lastSeenPos.z = p.position.z;
      this.lastSeenVel.x = p.velocity?.x || 0;
      this.lastSeenVel.z = p.velocity?.z || 0;
      if (chasing) this.detection = 1;
      else this.detection = Math.min(1, this.detection + rate * pdt);
    } else if (!chasing && now - this.lastSeenTime > TUNE.decayDelay) {
      this.detection = Math.max(0, this.detection - this.decayRate() * pdt);
    }
    if (!blind) this.react(seen);
  }

  // Turn perception into decisions. Every escalation is telegraphed through 'suspicious'.
  react(seen) {
    const st = this.state;
    if (st === 'chase' || st === 'grab' || st === 'rapture') return;
    if (this.asleep) {
      if (this.detection >= TUNE.suspectAt) this.wake(() => this.enterSuspicious(this.lastSeenPos, { seen: true }));
      return;
    }
    if (this.detection >= 1) {
      // Never shriek without a visible stop-and-stare first, however fast detection filled.
      if (st === 'suspicious' && this.stateTime >= TUNE.minTelegraph) {
        this.enterChase();
        return;
      }
      this.detection = 0.99;
      if (st === 'suspicious') return;
      this.sightingReacted = false;
    }
    if (!seen || this.detection < TUNE.suspectAt || this.sightingReacted || st === 'suspicious') return;
    this.sightingReacted = true;
    const resume = st === 'search' ? 'search' : st === 'alarm' ? 'alarm' : null;
    this.enterSuspicious(this.lastSeenPos, { seen: true, resume });
  }

  // --- hearing (called by the director) ----------------------------------

  // Closeness 0..1 of a sound at this snatcher's ear, or -1 if it can't be heard.
  hearing(pos, radius, occlusionFactor = 0.6) {
    if (this.state === 'rapture' || this.state === 'grab' || this.director?.calling) return -1;
    const p = this.body.position;
    const d = Math.hypot(pos.x - p.x, pos.z - p.z);
    let r = radius * (this.asleep ? TUNE.sleep.hearing : 1);
    if (d > r) return -1;
    if (this.soundOccluded(pos)) {
      r *= occlusionFactor;
      if (d > r) return -1;
    }
    return clamp(1 - d / Math.max(r, 0.01), 0, 1);
  }

  // Muffled only by something big: the line from ~1 m above the source to the ear must be blocked,
  // and so must the line over low cover (cars, planters) and the lines either side of it (sound
  // bends round poles, statues and kiosks). In practice: buildings and long walls muffle.
  soundOccluded(pos) {
    const world = this.game.world;
    const ear = this.body.getEyePos(_eye);
    const base = Math.max(0, pos.y || 0);
    _a.set(pos.x, base + 1, pos.z);
    if (!world.segmentBlocked(_a, ear)) return false;
    _a.set(pos.x, base + 3.2, pos.z);
    _b.set(ear.x, ear.y + 0.8, ear.z);
    if (!world.segmentBlocked(_a, _b)) return false;
    const dx = ear.x - pos.x, dz = ear.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return true;
    const ox = (-dz / d) * TUNE.soundBend, oz = (dx / d) * TUNE.soundBend;
    for (let side = -1; side <= 1; side += 2) {
      _a.set(pos.x + ox * side, base + 1.5, pos.z + oz * side);
      _b.set(ear.x + ox * side, ear.y, ear.z + oz * side);
      if (!world.segmentBlocked(_a, _b)) return false;
    }
    return true;
  }

  hearPlayer(e, closeness) {
    const now = this.game.time;
    const st = this.state;
    const loud = Number.isFinite(e.loudness) ? clamp(e.loudness, 0, 1) : 0.4;
    if (now < this.ignoreUntil || st === 'grab' || st === 'rapture') return;
    if (this.asleep) {
      if (loud >= 0.35 || closeness > 0.5) this.wake(() => this.enterSuspicious(e.pos, { heard: true }));
      return;
    }
    if (st === 'chase') {
      // Footsteps sharpen where it thinks you are, but can't extend the memory of seeing you.
      if (now - this.lastSeenTime < E.loseSightMemory) {
        this.lastSeenPos.x = e.pos.x;
        this.lastSeenPos.z = e.pos.z;
      }
      return;
    }
    const big = loud >= 0.7 && closeness > 0.45;
    let boost = loud * (0.08 + 0.32 * closeness) + (big ? 0.25 : 0);
    if (st === 'alarm') boost *= TUNE.stateFactor.alarm;
    // Sound can push detection up to the cap but never past it (and never lowers it).
    this.detection = Math.min(Math.max(TUNE.hearingCap, this.detection), this.detection + boost);
    switch (st) {
      case 'alarm':
        if (this.detection >= 0.6) this.enterSuspicious(e.pos, { heard: true, resume: 'alarm' });
        else this.glance(e.pos, 1.5);
        break;
      case 'search':
        this.searchToward(e.pos, big);
        break;
      case 'investigate':
        if (big) this.enterSuspicious(e.pos, { heard: true });
        else this.retarget(e.pos);
        break;
      case 'suspicious':
        if (now - this.lastSeenTime > 0.5) {
          this.stimulus.x = e.pos.x;
          this.stimulus.z = e.pos.z;
        }
        this.stateTime = Math.min(this.stateTime, 0.8);
        break;
      default:
        this.enterSuspicious(e.pos, { heard: true });
    }
  }

  canInvestigate() {
    const st = this.state;
    return st !== 'chase' && st !== 'grab' && st !== 'rapture' && st !== 'alarm';
  }

  // A bottle, a gate, something that isn't the player. role: 'investigate' | 'glance'.
  hearDistraction(pos, closeness, role, source) {
    const st = this.state;
    if (st === 'chase' || st === 'grab' || st === 'rapture') return;
    const lookTime = source === 'bottle' ? 6 : 4.5;
    if (this.asleep) {
      this.wake(() => (role === 'investigate' ? this.enterSuspicious(pos, { heard: true, lookTime }) : this.enterCalm()));
      if (role !== 'investigate') this.glance(pos, 2.5);
      return;
    }
    if (st === 'alarm' || role !== 'investigate') {
      this.glance(pos, 2.5);
      return;
    }
    this.detection = Math.min(Math.max(TUNE.hearingCap, this.detection), this.detection + (source === 'gate' ? 0.2 : 0.08));
    if (st === 'search') this.searchToward(pos, true);
    else if (st === 'investigate') this.retarget(pos); // already on its way: keep walking
    else if (st === 'suspicious' && Math.hypot(pos.x - this.stimulus.x, pos.z - this.stimulus.z) < 4) {
      this.investigateLook = lookTime; // the same sound again: keep listening, don't restart
    } else this.enterSuspicious(pos, { heard: true, lookTime });
  }

  hearAlarm(alarm) {
    const st = this.state;
    if (st === 'chase' || st === 'grab') return;
    if (st === 'rapture') {
      this.alarm = alarm;
      this.resume = { state: 'alarm' };
      return;
    }
    if (st === 'alarm' && this.alarm === alarm) return;
    if (st === 'suspicious' && this.seenNow && this.detection > 0.6) return; // it is staring at you
    if (this.asleep) {
      this.wake(() => this.enterAlarm(alarm));
      return;
    }
    this.enterAlarm(alarm);
  }

  // Another snatcher shrieked nearby: hurry over to where it came from, already on edge.
  hearShout(pos) {
    const st = this.state;
    if (st === 'chase' || st === 'grab' || st === 'rapture') return;
    this.detection = Math.max(this.detection, TUNE.shoutDetection);
    if (st === 'suspicious' && this.seenNow) return; // already staring at you: keep staring
    this.sightingReacted = false;
    const go = () => this.enterInvestigate(pos, { lookTime: 5, speed: E.investigateSpeed * 1.25, snap: true });
    if (this.asleep) this.wake(go);
    else go();
  }

  // --- the call -------------------------------------------------------------

  scheduleRapture(delay, levPos) {
    if (this.state === 'grab') return;
    this.raptureAt = this.game.time + delay;
    this.levX = levPos?.x ?? 0;
    this.levZ = levPos?.z ?? 0;
  }

  enterRapture() {
    if (this.state === 'grab' || this.state === 'rapture') return;
    this.resume = this.captureResume();
    this.setState('rapture');
    this.body.halt();
    this.seenNow = false;
  }

  captureResume() {
    switch (this.state) {
      case 'chase': return { state: 'chase' };
      case 'suspicious': return { state: 'suspicious' };
      case 'investigate': return { state: 'investigate', lookTime: this.lookTime };
      case 'alarm': return { state: 'alarm' };
      case 'search': return { state: 'search', remaining: Math.max(4, this.searchEnd - this.game.time) };
      case 'return': return { state: 'return', disappointed: this.disappointed };
      default: return { state: 'calm' };
    }
  }

  endRapture() {
    this.raptureAt = null;
    if (this.state !== 'rapture') return;
    const r = this.resume || { state: 'calm' };
    this.resume = null;
    this.ignoreUntil = Math.max(this.ignoreUntil, this.game.time + TUNE.raptureRecover);
    switch (r.state) {
      case 'chase':
        // It lost you while it listened: search where it last knew you were.
        this.emit('enemy:lost');
        this.enterSearch(this.lastSeenPos, { vel: null });
        this.detection = Math.max(this.detection, 0.6);
        break;
      case 'suspicious': this.enterInvestigate(this.stimulus); break;
      case 'investigate': this.enterInvestigate(this.target, { lookTime: r.lookTime }); break;
      case 'alarm':
        if (this.alarm && this.director?.alarmRelevant(this.alarm)) this.enterAlarm(this.alarm);
        else this.enterReturn();
        break;
      case 'search': this.enterSearch(this.searchCenter, { remaining: r.remaining }); break;
      case 'return': this.enterReturn({ disappointed: r.disappointed }); break;
      default: this.enterCalm();
    }
  }

  updateRapture() {
    const b = this.body;
    const yawTo = dirToYaw(this.levX - b.position.x, this.levZ - b.position.z);
    if (this.asleep) {
      b.lookRel(0, 0.45, 1.2); // the sleeper only lifts its head toward the sound
      return;
    }
    b.face(yawTo);
    b.lookRel(clamp(angleDiff(b.yaw, yawTo), -1.2, 1.2), TUNE.rapturePitch, 2.5);
  }

  footfall(pos) {
    if (!CALM.has(this.state) && this.state !== 'return') return;
    if (this.asleep || !pos) return;
    this.glance({ x: pos.x, y: 6, z: pos.z }, 0.6 + Math.random() * 0.6, 3);
  }

  // --- states -----------------------------------------------------------------

  wake(then) {
    if (this.asleep) {
      this.asleep = false;
      this.wakeUntil = this.game.time + TUNE.sleep.wakeTime;
    }
    then();
  }

  enterSuspicious(pos, { seen = false, heard = false, lookTime = 4.5, resume = null } = {}) {
    const now = this.game.time;
    if (this.state !== 'suspicious') this.setState('suspicious');
    else this.stateTime = Math.min(this.stateTime, 0.5);
    this.stimulus.x = pos.x;
    this.stimulus.z = pos.z;
    this.suspSeen = seen;
    this.suspHeard = heard;
    this.investigateLook = lookTime;
    this.resumeAfter = resume;
    this.creepDone = false;
    this.body.halt();
    this.snapAt = Math.max(now, this.wakeUntil) + (seen ? 0.05 : 0.12) + Math.random() * 0.08;
    if (now - this.lastSuspiciousEmit > 2.5) {
      this.lastSuspiciousEmit = now;
      this.emit('enemy:suspicious', { pos: this.body.position.clone() });
      this.director?.shareGaze(this.body, pos);
    }
  }

  updateSuspicious() {
    const now = this.game.time;
    const b = this.body;
    const seenRecently = now - this.lastSeenTime < 0.4;
    if (seenRecently) {
      this.stimulus.x = this.lastSeenPos.x;
      this.stimulus.z = this.lastSeenPos.z;
    }
    const s = this.stimulus;
    const dx = s.x - b.position.x, dz = s.z - b.position.z;
    const d = Math.hypot(dx, dz);
    // Sharp head twitch toward it, then the body follows a beat later.
    if (now >= this.snapAt) b.lookAt(s.x, 1.2, s.z, now - this.snapAt < 0.35 ? TUNE.twitchRate : 7);
    if (this.stateTime > 0.45 && d > 0.3) b.face(dirToYaw(dx, dz));
    // One slow step toward what it saw.
    if (!this.creepDone && this.stateTime > 1.1 && d > 3) {
      this.creepDone = true;
      b.go(b.position.x + (dx / d) * 0.9, b.position.z + (dz / d) * 0.9, TUNE.creepSpeed, 0.15);
    }
    const minTime = this.suspSeen ? 1.6 : 1.2;
    if (seenRecently && this.stateTime > 5) {
      // It keeps half-seeing something: walk over to get a better look.
      this.enterInvestigate(s, { lookTime: this.investigateLook });
      return;
    }
    if (this.stateTime > minTime && now - this.lastSeenTime > 1.4) {
      if (this.resumeAfter === 'alarm' && this.alarm && this.director?.alarmRelevant(this.alarm)) this.enterAlarm(this.alarm);
      else if (this.resumeAfter === 'search') this.enterSearch(s, { remaining: Math.max(6, (this.searchEnd ?? 0) - now) });
      else this.enterInvestigate(s, { lookTime: this.investigateLook });
    }
  }

  enterInvestigate(pos, { lookTime = 4.5, speed = E.investigateSpeed, snap = false } = {}) {
    this.setState('investigate', 'go');
    this.target.x = pos.x;
    this.target.z = pos.z;
    this.lookTime = lookTime;
    this.moveSpeed = speed;
    this.body.go(pos.x, pos.z, speed, 1.0);
    if (snap) {
      this.body.lookAt(pos.x, 1.4, pos.z, TUNE.twitchRate);
      this.snapUntil = this.game.time + 0.5;
    }
  }

  retarget(pos) {
    this.target.x = pos.x;
    this.target.z = pos.z;
    if (this.phase !== 'go') this.setPhase('go');
    this.body.go(pos.x, pos.z, this.moveSpeed || E.investigateSpeed, 1.0);
  }

  updateInvestigate(dt) {
    const b = this.body;
    const now = this.game.time;
    if (this.phase === 'go') {
      if (now - this.lastSeenTime < 0.4) b.lookAt(this.lastSeenPos.x, 1.2, this.lastSeenPos.z, 8);
      else if (now > (this.snapUntil ?? 0)) b.lookAt(this.target.x, 0.9, this.target.z, 4);
      const d = Math.hypot(this.target.x - b.position.x, this.target.z - b.position.z);
      if (b.arrived || b.pathFailed || d < 1.2 || this.phaseTime > 45) {
        b.halt();
        this.setPhase('look');
        this.lookTimer = 0.2;
      }
    } else {
      // Study the spot itself for a moment, then look around it.
      if (this.phaseTime < 1.1) b.lookAt(this.target.x, 0.1, this.target.z, 4);
      else this.lookAround(dt, 1.1);
      if (this.phaseTime > this.lookTime) this.enterReturn();
    }
  }

  enterAlarm(alarm) {
    this.alarm = alarm;
    this.setState('alarm', 'go');
    const p = this.body.position;
    const ang = Math.atan2(p.z - alarm.pos.z, p.x - alarm.pos.x) + (Math.random() - 0.5) * 0.9;
    const r = TUNE.alarm.ringMin + Math.random() * TUNE.alarm.ringSpread;
    let sx = alarm.pos.x + Math.cos(ang) * r, sz = alarm.pos.z + Math.sin(ang) * r;
    const w = this.game.nav.nearestWalkable(sx, sz, 8);
    if (w) {
      sx = w.x;
      sz = w.z;
    }
    this.target.x = sx;
    this.target.z = sz;
    this.body.go(sx, sz, TUNE.alarm.speed, 0.6);
  }

  updateAlarm() {
    const a = this.alarm;
    const b = this.body;
    if (!a) {
      this.enterReturn();
      return;
    }
    const now = this.game.time;
    const dx = a.pos.x - b.position.x, dz = a.pos.z - b.position.z;
    const d = Math.hypot(dx, dz);
    b.lookAt(a.pos.x, 0.9, a.pos.z, 4);
    if (this.phase === 'go') {
      if (b.arrived || b.pathFailed || d < TUNE.alarm.ringMin - 0.3 || this.phaseTime > 40) {
        b.halt();
        this.setPhase('stare');
      }
    } else {
      b.face(dirToYaw(dx, dz));
      // Transfixed: a slow, uneasy head tilt while it wails.
      b.lookRel(clamp(angleDiff(b.yaw, dirToYaw(dx, dz)), -1.2, 1.2) + Math.sin(now * 0.7 + this.body.index) * 0.12,
        -0.12 + Math.sin(now * 0.43 + this.body.index * 2) * 0.08, 3);
      const over = !this.director?.alarmActive(a) && now > (this.director?.alarmEndTime(a) ?? 0) + TUNE.alarm.linger;
      if (over && this.phaseTime > TUNE.alarm.minStare) this.enterReturn();
    }
    if (this.stateTime > 75) this.enterReturn();
  }

  enterChase() {
    this.asleep = false;
    this.setState('chase');
    this.detection = 1;
    this.repathAt = 0;
    this.chaseGoal.x = this.lastSeenPos.x;
    this.chaseGoal.z = this.lastSeenPos.z;
    this.emit('enemy:alert', { pos: this.body.position.clone() });
    this.director?.shout(this.body);
  }

  // Where it believes the player is `t` seconds after losing sight: last position + velocity,
  // shortened if that line runs into something solid.
  extrapolate(t, out) {
    const k = Math.min(t, E.loseSightMemory);
    const sx = this.lastSeenPos.x, sz = this.lastSeenPos.z;
    let ex = sx + this.lastSeenVel.x * k, ez = sz + this.lastSeenVel.z * k;
    const world = this.game.world;
    for (let i = 0; i < 3; i++) {
      _a.set(sx, 0.6, sz);
      _b.set(ex, 0.6, ez);
      if (!world.segmentBlocked(_a, _b)) break;
      ex = (ex + sx) * 0.5;
      ez = (ez + sz) * 0.5;
      if (i === 2) {
        ex = sx;
        ez = sz;
      }
    }
    out.x = ex;
    out.z = ez;
    return out;
  }

  updateChase() {
    const now = this.game.time;
    const g = this.game;
    const b = this.body;
    const caughtBy = this.director?.caughtBy;
    if (caughtBy && caughtBy !== b) {
      // Another one has you: the rest close in slowly and watch (no "lost" while you die).
      const p = g.player.position;
      if (Math.hypot(p.x - b.position.x, p.z - b.position.z) > 2.6) b.go(p.x, p.z, E.patrolSpeed, 2.4);
      else b.halt();
      b.lookAt(p.x, p.y + g.player.eyeHeight, p.z, 6);
      return;
    }
    const since = now - this.lastSeenTime;
    if (since > E.loseSightMemory) {
      this.emit('enemy:lost');
      this.extrapolate(since, this.chaseGoal);
      this.enterSearch(this.chaseGoal, { vel: this.lastSeenVel });
      this.detection = TUNE.searchStartDetection;
      return;
    }
    // Aim a little ahead of a visible player; extrapolate a vanished one.
    this.extrapolate(since < 0.2 ? TUNE.chaseLead : since, _a);
    const tx = _a.x, tz = _a.z;
    const moved = Math.hypot(tx - this.chaseGoal.x, tz - this.chaseGoal.z);
    // Straight-line pursuit is free, so it updates every frame; A* re-plans are throttled, and on a
    // long detour (round a block, through the parking structure) small moves of yours don't matter.
    const direct = b.canWalkDirect(tx, tz);
    const detour = !direct && b.remainingPathLength() > TUNE.chaseDetour;
    const due = direct || (detour
      ? (now >= this.repathAt && moved > TUNE.chaseRepathMove) || moved > TUNE.chaseDetourMove
      : now >= this.repathAt || moved > TUNE.chaseRepathMove);
    if (due) {
      if (!direct) this.repathAt = now + (detour ? TUNE.chaseDetourRepath : TUNE.chaseRepath);
      this.chaseGoal.x = tx;
      this.chaseGoal.z = tz;
      b.go(tx, tz, E.chaseSpeed, 0.1, { brake: false });
    }
    const p = g.player.position;
    if (since < 0.3) b.lookAt(p.x, p.y + g.player.eyeHeight, p.z, 10);
    else b.lookAt(tx, 1.3, tz, 6);
    const d = Math.hypot(p.x - b.position.x, p.z - b.position.z);
    if (d < E.catchRadius && g.state === 'playing' && since < 0.3) this.director?.tryCatch(this);
  }

  enterGrab() {
    this.setState('grab');
    this.body.halt();
    // Plant the feet at once: the model's own lunge closes the last ~0.6 m, so any momentum
    // carried into the grab would push its face through the camera.
    this.body.stopDead();
  }

  updateGrab(dt) {
    const b = this.body;
    const p = this.game.player;
    const dx = p.position.x - b.position.x, dz = p.position.z - b.position.z;
    const d = Math.hypot(dx, dz);
    b.face(dirToYaw(dx, dz));
    b.lookAt(p.position.x, p.position.y + p.eyeHeight, p.position.z, 12);
    // Hold the root TUNE.grabRange from the player (the player still slides a little as their
    // momentum dies): ease back if too close, follow if they drift away.
    const [near, far] = TUNE.grabRange;
    if (d > 1e-3 && (d < near || d > far)) {
      const want = d < near ? near : far;
      const step = clamp(d - want, -1.5 * dt, 1.5 * dt);
      b.nudge((dx / d) * step, (dz / d) * step);
    }
  }

  // God mode: it reaches you and simply stops caring for a while.
  loseInterest() {
    this.emit('enemy:lost');
    this.ignoreUntil = this.game.time + 6;
    this.detection = 0.2;
    this.enterReturn({ disappointed: true });
  }

  enterSearch(center, { remaining = E.searchDuration, vel = null } = {}) {
    this.setState('search', 'go');
    this.searchCenter.x = center.x;
    this.searchCenter.z = center.z;
    this.searchEnd = this.game.time + remaining;
    this.visited.length = 0;
    const vl = vel ? Math.hypot(vel.x, vel.z) : 0;
    this.searchDirX = vl > 0.5 ? vel.x / vl : 0;
    this.searchDirZ = vl > 0.5 ? vel.z / vl : 0;
    this.target.x = center.x;
    this.target.z = center.z;
    this.body.go(center.x, center.z, E.searchSpeed, 0.8);
  }

  searchToward(pos, snap) {
    this.target.x = pos.x;
    this.target.z = pos.z;
    this.searchCenter.x = pos.x;
    this.searchCenter.z = pos.z;
    this.searchEnd = Math.max(this.searchEnd ?? 0, this.game.time + 6);
    this.setPhase('go');
    this.body.go(pos.x, pos.z, E.searchSpeed * 1.2, 0.8);
    if (snap) this.body.lookAt(pos.x, 1.0, pos.z, TUNE.twitchRate);
  }

  // Where would I hide? Prefer spots next to cover, out of my own sight, along the way you ran.
  pickSearchPoint() {
    const { game, body } = this;
    const nav = game.nav;
    const c = this.searchCenter;
    const eye = body.getEyePos(_eye);
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      const pt = nav.randomPointNear(c.x, c.z, TUNE.searchRadius);
      if (!pt) continue;
      let score = Math.random() * 0.4;
      const cover = game.world.query(pt.x - 2, pt.z - 2, pt.x + 2, pt.z + 2);
      for (const col of cover) {
        if (col.enabled && col.blocksSight && col.maxY >= 1.0) {
          score += 1;
          break;
        }
      }
      _a.set(pt.x, 0.9, pt.z);
      if (game.world.segmentBlocked(eye, _a)) score += 1.2;
      const ox = pt.x - c.x, oz = pt.z - c.z;
      const ol = Math.hypot(ox, oz) || 1;
      score += ((ox * this.searchDirX + oz * this.searchDirZ) / ol) * 0.8;
      const md = Math.hypot(pt.x - body.position.x, pt.z - body.position.z);
      score -= Math.max(0, md - 10) * 0.08;
      if (md < 2) score -= 1;
      for (const v of this.visited) if (Math.hypot(v.x - pt.x, v.z - pt.z) < 3) score -= 1.5;
      // Split up: don't check the spot another searcher is already heading for.
      for (const o of this.director?.snatchers || []) {
        if (o !== body && o.state === 'search' && Math.hypot(o.brain.target.x - pt.x, o.brain.target.z - pt.z) < 4) score -= 1.2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = pt;
      }
    }
    return best;
  }

  updateSearch(dt) {
    const now = this.game.time;
    const b = this.body;
    if (now >= this.searchEnd) {
      this.emit('enemy:giveup');
      this.enterReturn({ disappointed: true });
      return;
    }
    if (this.phase === 'go') {
      if (now - this.lastSeenTime < 0.4) b.lookAt(this.lastSeenPos.x, 1.2, this.lastSeenPos.z, 8);
      else b.lookRel(Math.sin(now * 1.9 + b.index) * 0.75, -0.08, 4);
      if (b.arrived || b.pathFailed || this.phaseTime > 10) {
        b.halt();
        this.visited.push({ x: b.position.x, z: b.position.z });
        this.setPhase('look');
        this.lookDur = 1.5 + Math.random();
        this.lookTimer = 0;
      }
    } else {
      this.lookAround(dt, 1.6);
      if (this.phaseTime > this.lookDur) {
        const pt = this.pickSearchPoint();
        if (pt) {
          this.target.x = pt.x;
          this.target.z = pt.z;
          this.setPhase('go');
          b.go(pt.x, pt.z, E.searchSpeed, 0.7);
        } else this.phaseTime = 0;
      }
    }
  }

  // Where "home" is: the post, or the nearest point of the patrol route.
  homePoint() {
    if (this.route && !this.sleeper) {
      this.routeIndex = this.nearestRouteIndex();
      return this.route[this.routeIndex];
    }
    return this.post;
  }

  nearestRouteIndex() {
    const p = this.body.position;
    let best = 0, bd = Infinity;
    this.route.forEach((r, i) => {
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  enterReturn({ disappointed = false } = {}) {
    this.setState('return');
    this.disappointed = disappointed;
    const h = this.homePoint();
    this.target.x = h.x;
    this.target.z = h.z;
    const speed = E.patrolSpeed * (disappointed ? 0.85 : 1);
    const p = this.body.position;
    this.returnDeadline = 30 + (Math.hypot(h.x - p.x, h.z - p.z) / speed) * 1.8;
    this.body.go(h.x, h.z, speed, 0.5);
  }

  updateReturn() {
    const b = this.body;
    const t = this.stateTime;
    if (this.disappointed && t > 2 && t < 3.4) {
      // One last look back over the shoulder at where it lost you.
      b.lookAt(this.searchCenter.x, 1.0, this.searchCenter.z, 3);
    } else if (this.disappointed && t < 4) b.lookRel(0, -0.3, 2);
    else this.calmHead();
    if (b.arrived || b.pathFailed || this.stateTime > this.returnDeadline) this.enterCalm();
  }

  // --- calm behaviour per kind ----------------------------------------------

  enterCalm() {
    const roams = (this.kind === 'patrol' && this.route) || this.kind === 'wander';
    this.setState(roams && !this.sleeper ? 'patrol' : 'idle', 'start');
    this.atPostTime = 0;
  }

  updateCalm(dt) {
    if (this.sleeper || !((this.kind === 'patrol' && this.route) || this.kind === 'wander')) this.updatePost(dt);
    else if (this.kind === 'wander') this.updateWander(dt);
    else this.updatePatrol(dt);
    this.idleTwitch();
  }

  updatePatrol(dt) {
    const b = this.body;
    const route = this.route;
    if (this.phase === 'start') {
      this.goRoute();
      return;
    }
    if (this.phase === 'walk') {
      this.calmHead();
      if (b.arrived) {
        b.halt();
        this.pauseTime = this.def.pause ?? 2;
        this.setPhase('pause');
        this.lookTimer = 0.3;
      } else if (b.pathFailed) {
        // Unreachable leg: wait a moment (no hammering the path-finder), then try the next one.
        b.halt();
        this.pauseTime = 2;
        this.setPhase('pause');
      }
    } else if (this.phase === 'pause') {
      if (this.pauseTime >= 1) this.lookAround(dt, 0.7);
      if (this.phaseTime >= this.pauseTime) {
        this.advanceRoute();
        this.goRoute();
      }
    }
    if (route.length === 1 && this.phase === 'pause') this.phaseTime = Math.min(this.phaseTime, 0);
  }

  goRoute() {
    const i = this.routeIndex;
    const r = this.route[i];
    this.setPhase('walk');
    this.body.go(r.x, r.z, E.patrolSpeed, 0.4, { cacheKey: `${this.body.id}:${i}` });
  }

  advanceRoute() {
    const n = this.route.length;
    if (n < 2) return;
    if (this.def.loop !== false) this.routeIndex = (this.routeIndex + 1) % n;
    else {
      if (this.routeIndex + this.routeDir >= n || this.routeIndex + this.routeDir < 0) this.routeDir = -this.routeDir;
      this.routeIndex += this.routeDir;
    }
  }

  updateWander(dt) {
    const b = this.body;
    if (this.phase === 'start') {
      const r = this.def.radius ?? 8;
      const pt = this.game.nav.randomPointNear(this.post.x, this.post.z, r);
      if (pt) {
        this.setPhase('walk');
        b.go(pt.x, pt.z, E.patrolSpeed * 0.85, 0.5);
      } else this.setPhase('pause');
      this.pauseTime = 2 + Math.random() * 3;
    } else if (this.phase === 'walk') {
      this.calmHead();
      if (b.arrived || b.pathFailed) {
        b.halt();
        this.setPhase('pause');
        this.lookTimer = 0.3;
      }
    } else {
      this.lookAround(dt, 0.6);
      if (this.phaseTime > this.pauseTime) this.setPhase('start');
    }
  }

  // Sentries, devouts and sleepers hold a post.
  updatePost(dt) {
    const b = this.body;
    const P = this.post;
    if (this.phase === 'start') {
      if (Math.hypot(P.x - b.position.x, P.z - b.position.z) > 0.8) {
        b.go(P.x, P.z, E.patrolSpeed, 0.4);
        this.setPhase('walk');
      } else this.enterScan();
      return;
    }
    if (this.phase === 'walk') {
      this.calmHead();
      if (b.arrived || b.pathFailed) {
        b.halt();
        this.enterScan();
      }
      return;
    }
    this.atPostTime += dt;
    // Jostled off its spot (a patrol brushing past): step back rather than slowly drift away.
    if (Math.hypot(this.spotX - b.position.x, this.spotZ - b.position.z) > 1.2 && !this.asleep) {
      this.setPhase('start');
      return;
    }
    if (this.sleeper) {
      b.face(P.yaw);
      if (!this.asleep) {
        b.lookRel(0, -0.2, 2);
        if (this.atPostTime > TUNE.sleep.resettle) this.asleep = true;
      } else b.lookRel(0, -0.85, 1.2);
      return;
    }
    if (this.scanArc <= 0.01) {
      b.face(P.yaw);
      this.calmHead();
      return;
    }
    this.scanPhase += dt / this.scanPeriod;
    const off = sweep(this.scanPhase) * this.scanArc * 0.5;
    b.face(P.yaw + off * 0.55);
    b.lookRel(off * 0.45, this.kind === 'devout' ? 0.08 : -0.04, 2.5);
  }

  enterScan() {
    this.setPhase('scan');
    this.spotX = this.body.position.x;
    this.spotZ = this.body.position.z;
  }

  // Calm head: mostly forward, an occasional slow glance to one side.
  calmHead() {
    const now = this.game.time;
    const b = this.body;
    if (now > this.idleLookAt + 1.4) {
      this.idleLookAt = now + 3 + Math.random() * 5;
      this.lookSide = -this.lookSide;
      this.lookYaw = this.lookSide * (0.4 + Math.random() * 0.5);
    }
    if (now > this.idleLookAt) b.lookRel(this.lookYaw, -0.05, 3);
    else b.lookRel(0, -0.06, 3);
  }

  // Unsettling idle detail: a small, sudden jerk of the head every so often.
  idleTwitch() {
    const now = this.game.time;
    if (now < this.twitchAt || this.asleep) return;
    this.twitchAt = now + 5 + Math.random() * 9;
    this.body.twitch((Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.4, 0.18 + Math.random() * 0.2);
  }

  lookAround(dt, pace = 1) {
    const b = this.body;
    this.lookTimer -= dt * pace;
    if (this.lookTimer <= 0) {
      this.lookTimer = 0.8 + Math.random();
      this.lookSide = -this.lookSide;
      this.lookYaw = this.lookSide * (0.45 + Math.random() * 0.8);
      this.lookPitch = -0.18 + Math.random() * 0.2;
      if (Math.random() < 0.35) b.face(b.yaw + this.lookSide * (0.7 + Math.random() * 1.2));
    }
    b.lookRel(this.lookYaw, this.lookPitch, 5);
  }

  glance(pos, duration, rate = 7) {
    const st = this.state;
    if (st === 'chase' || st === 'grab' || st === 'rapture') return;
    this.glanceUntil = this.game.time + duration;
    this.glancePos.x = pos.x;
    this.glancePos.y = pos.y ?? 1.2;
    this.glancePos.z = pos.z;
    this.glanceRate = rate;
  }

  updateGlance() {
    if (this.game.time >= this.glanceUntil) return;
    const st = this.state;
    if (st === 'chase' || st === 'grab' || st === 'rapture' || st === 'suspicious') return;
    const b = this.body;
    const g = this.glancePos;
    b.lookAt(g.x, Math.min(g.y, 3), g.z, this.glanceRate);
    if (CALM.has(st) && b.arrived) {
      const yawTo = dirToYaw(g.x - b.position.x, g.z - b.position.z);
      if (Math.abs(angleDiff(b.yaw, yawTo)) > 1.2) b.face(yawTo);
    }
  }

  // The body could not make progress twice in a row: give up on this leg.
  onStuck() {
    switch (this.state) {
      case 'patrol':
        if (this.kind === 'wander') this.setPhase('start');
        else if (this.route) {
          this.advanceRoute();
          this.goRoute();
        }
        break;
      case 'idle': this.enterScan(); break;
      case 'investigate': this.setPhase('look'); this.body.halt(); break;
      case 'search': this.setPhase('look'); this.lookDur = 1; this.body.halt(); break;
      case 'alarm': this.setPhase('stare'); this.body.halt(); break;
      case 'return': this.enterCalm(); break;
      default: break;
    }
  }
}
