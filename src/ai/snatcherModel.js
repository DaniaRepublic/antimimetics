// Snatcher visual model + procedural animation (see ARCHITECTURE.md, "Snatchers").
//
//   const model = createSnatcherModel(seed);
//   scene.add(model.root);                 // feet at origin, faces -Z; the AI moves/rotates root
//   model.update(dt, { speed, mode, headYaw, headPitch, alert, time });
//   model.headAnchor.getWorldPosition(v);  // the face, for the death-cam look-at
//
// Every anim field is optional; non-finite numbers count as 0. headYaw/headPitch are relative to
// the body's facing and level (not to the hunched neck); headYaw is wrapped to [-PI, PI]. `time`
// is accepted but the model keeps its own clock (so paused snatchers don't twitch in sync). The
// AI states 'patrol'/'return' (and unknown modes) pose as 'walk' when moving, 'idle' when not.
// In 'grab' the snatcher lunges ~0.6 m forward and brings its face down to ~1.6 m: at
// 1.0-1.15 m from the player's eye the face ends 0.35-0.5 m away.
// The seed may be any number or string (spawn ids are hashed). A root jump of more than ~0.9 m
// between updates (spawn, respawn, reset) is a teleport: pose and cape snap instead of dragging.
//
// One SkinnedMesh per snatcher (2 draw calls: skin + cloth), geometry and materials shared per face
// variant. Everything inside root is animated here: a gait whose stride phase advances with
// distance travelled (two-bone leg IK keeps planted feet planted), per-mode pose targets blended
// smoothly, limp pendulum arms, a world-levelled head that honours headYaw/headPitch, uncanny
// overlays (twitches, jerks, tremor, sliding facial features), and a simulated cape.
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep, noise1, makeRng, angleDiff } from '../core/math.js';
import { seedToInt, variantForSeed } from './snatcher-head.js';
import { BONE, BONE_REST, CAPE_FIRST, CAPE_REST, LEG, createSkeleton, getSnatcherAssets } from './snatcher-rig.js';
import { CAPE, CapeSim } from './snatcher-cape.js';

// Pose targets per mode. Angles in radians. lean/hunch/neck: forward bend of the spine chain;
// look: gaze pitch bias (world, + up); sky: 0..1 pull of the gaze to the sky; armFlex: arms raised
// forward (world angle from hanging); pron: forearm twist (+ palms down when reaching);
// jaw: 0..1; drop: hips lowered (m); sweep: head scan amplitude; peer: lean into the scan;
// twitch: idle head-twitch rate; slide: sliding facial features; stiff: arms held, not limp;
// toe: rise onto the toes; lunge: step forward into a lunge (m); twist: upper-arm twist (elbows fold inward).
const BASE = {
  lean: 0.08, hunch: 0.28, neck: 0.3, look: -0.12, sky: 0, roll: 0,
  armFlex: 0, armOut: 0.05, elbow: 0.1, wrist: 0.05, curl: 0.35, pron: 0, shrug: 0,
  jaw: 0.2, drop: 0.02, sway: 1, breath: 1, tremor: 0.03, jerk: 0, sweep: 0, peer: 0,
  billow: 0, twitch: 1, slide: 1, reach: 0, stiff: 0, toe: 0, lunge: 0, twist: 0,
};

// Per-mode targets (missing keys fall back to BASE); `rate` is how fast the pose blends in.
// Exported so poses can be tuned live (e.g. from a sandbox).
export const SNATCHER_MODES = {
  idle: { rate: 2.2 },
  walk: { rate: 3, lean: 0.12, neck: 0.3, look: -0.06, curl: 0.3, jaw: 0.16, sway: 0.2, breath: 0.6, twitch: 0.35, slide: 0.6 },
  investigate: {
    rate: 3, lean: 0.2, hunch: 0.32, neck: 0.42, look: -0.18, curl: 0.45, jaw: 0.16, sweep: 0.42, peer: 0.7,
    twitch: 0.3, sway: 0.2, slide: 0.6,
  },
  search: {
    rate: 3, lean: 0.18, hunch: 0.3, neck: 0.4, look: -0.12, curl: 0.45, jaw: 0.18, sweep: 0.75, peer: 1,
    twitch: 0.6, sway: 0.2, slide: 0.8,
  },
  suspicious: {
    rate: 10, lean: 0.2, hunch: 0.26, neck: 0.45, look: -0.02, roll: 0.62, armFlex: 0.04, elbow: 0.15,
    curl: 0.6, jaw: 0.26, drop: 0.03, sway: 0.05, breath: 0.3, tremor: 0.12, twitch: 0, slide: 0.4,
  },
  chase: {
    rate: 6, lean: 0.4, hunch: 0.18, neck: 0.32, look: 0.02, armFlex: 0.72, armOut: 0.18, elbow: 0.62,
    wrist: -0.1, curl: 0.2, pron: 0.5, shrug: 0.35, jaw: 0.42, drop: 0.05, sway: 0, breath: 0, tremor: 0.15,
    jerk: 1, twitch: 0, reach: 1, stiff: 1, slide: 0.5,
  },
  rapture: {
    rate: 2.5, lean: -0.08, hunch: 0.02, neck: -0.05, look: 0, sky: 1, roll: 0.12, armFlex: 0.2,
    armOut: 0.62, elbow: 0.3, wrist: 0.35, curl: 0.15, pron: -0.6, shrug: 0.2, jaw: 0.62, drop: 0,
    sway: 0.3, tremor: 0.55, billow: 1, twitch: 0, slide: 1.2, toe: 1,
  },
  grab: {
    rate: 10, lean: 0.55, hunch: 0.22, neck: 0.5, look: -0.05, roll: 0.1, armFlex: 1.4, armOut: 0.45,
    elbow: 0.3, twist: 0.3, wrist: -0.3, curl: 0.1, pron: 0.2, shrug: 0.5, jaw: 1, drop: 0.12, sway: 0, breath: 0,
    tremor: 0.4, jerk: 0.5, twitch: 0, slide: 1.5, reach: 0.5, stiff: 1, lunge: 0.16,
  },
  alarm: {
    rate: 3, lean: 0.03, hunch: 0.12, neck: 0.12, look: 0.05, armOut: 0.03, elbow: 0.03, curl: 0.2,
    jaw: 0.32, drop: 0, sway: 0.6, breath: 0.4, tremor: 0.06, twitch: 0, slide: 0.3,
  },
};
const MODES = SNATCHER_MODES;
const KEYS = Object.keys(BASE);
for (const m of Object.values(MODES)) for (const k of KEYS) if (m[k] === undefined) m[k] = BASE[k];

// AI state names that are not visual modes (ARCHITECTURE.md lists 'patrol' and 'return' as AI
// states) and any unknown mode fall back to walking or standing, by speed.
const MOVING_STATES = new Set(['patrol', 'return', 'wander', 'move']);
function resolveMode(mode, speed) {
  if (typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODES, mode)) return mode;
  if (MOVING_STATES.has(mode)) return speed > 0.15 ? 'walk' : 'idle';
  return speed > 0.3 ? 'walk' : 'idle';
}

// Numeric anim fields: anything that is not a finite number counts as 0.
const finite = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

// A root jump larger than this between two updates is a teleport (spawn, respawn, reset): the cape
// and the pose snap instead of being dragged across the gap.
const teleportDistance = (dt) => 0.75 + 8 * Math.min(dt, 0.25);

const HEAD_ANCHOR = new THREE.Vector3(0, 0.15, -0.1); // the face, relative to the head bone
const CHEST_REST = BONE_REST[BONE.chest];
const ROW0 = new Float32Array(CAPE.cols * 3); // cape row 0, relative to the chest at rest
for (let i = 0; i < CAPE.cols; i++) {
  ROW0[i * 3] = CAPE_REST[i * 3] - CHEST_REST.x;
  ROW0[i * 3 + 1] = CAPE_REST[i * 3 + 1] - CHEST_REST.y;
  ROW0[i * 3 + 2] = CAPE_REST[i * 3 + 2] - CHEST_REST.z;
}

// Per-side bone indices (s = -1 left, +1 right), so the frame loop does no string lookups.
const SIDES = ['L', 'R'].map((S, i) => ({
  s: i === 0 ? -1 : 1,
  i,
  clav: BONE[`clav${S}`], arm: BONE[`arm${S}`], fore: BONE[`fore${S}`], hand: BONE[`hand${S}`],
  f1: BONE[`fing1${S}`], f2: BONE[`fing2${S}`],
  thigh: BONE[`thigh${S}`], shin: BONE[`shin${S}`], foot: BONE[`foot${S}`],
}));
const TW_KEYS = ['yaw', 'pitch', 'roll', 'face', 'curl'];
const JK_KEYS = ['yaw', 'pitch', 'roll'];
let instanceCount = 0;

// Fine trembling: incommensurate sines, -1..1.
const tremble = (t, k) => (Math.sin(t * 43.1 + k * 1.7) + 0.7 * Math.sin(t * 61.7 + k * 2.3) + 0.5 * Math.sin(t * 29.3 + k)) / 2.2;

// Head scan: hold left, turn, hold right, turn back. -1..1.
function scanWave(x) {
  x -= Math.floor(x);
  if (x < 0.2) return -1;
  if (x < 0.5) return -1 + 2 * smoothstep(0.2, 0.5, x);
  if (x < 0.7) return 1;
  return 1 - 2 * smoothstep(0.7, 1, x);
}

const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _hipsM = new THREE.Matrix4();
const _chestM = new THREE.Matrix4();
const _invM = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qHipsInv = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();
const _target = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _pinned = new Float32Array(CAPE.cols * 3);
const _caps = new Float32Array(16 * 7);
const _capeOpts = { wind: _wind, billow: 0, time: 0, drag: 2.2 };

// Writes capsule n (a -> b, radius r) into the collider buffer; returns n + 1.
function capsule(n, a, b, r) {
  const o = n * 7;
  _caps[o] = a.x;
  _caps[o + 1] = a.y;
  _caps[o + 2] = a.z;
  _caps[o + 3] = b.x;
  _caps[o + 4] = b.y;
  _caps[o + 5] = b.z;
  _caps[o + 6] = r;
  return n + 1;
}

class SnatcherAnimator {
  constructor(rig, bones, seed) {
    this.rig = rig;
    this.b = bones;
    this.rng = makeRng(seed * 7 + 3);
    this.seed = seed;
    this.t = this.rng() * 100;
    this.mode = 'idle';
    this.modeTime = 0;
    this.p = { ...MODES.idle };
    this.speed = 0;
    this.phase = this.rng();
    this.gait = 0;
    this.lift = 0;
    // Root motion tracking (world).
    this.hasPrev = false;
    this.prevX = 0;
    this.prevZ = 0;
    this.prevYaw = 0;
    this.vx = 0;
    this.vz = 0;
    this.yaw = 0;
    this.yawRate = 0;
    this.accF = 0;
    this.accL = 0;
    // Overlays.
    this.tw = { yaw: 0, pitch: 0, roll: 0, face: 0, curl: 0 };
    this.twTarget = { yaw: 0, pitch: 0, roll: 0, face: 0, curl: 0 };
    this.twHold = 0;
    this.twTimer = 1 + this.rng() * 4;
    this.jk = { yaw: 0, pitch: 0, roll: 0 };
    this.jkTarget = { yaw: 0, pitch: 0, roll: 0 };
    this.jkTimer = 0;
    this.pend = [{ f: 0, fv: 0, o: 0, ov: 0 }, { f: 0, fv: 0, o: 0, ov: 0 }];
    this.scanOffset = this.rng();
    this.cape = new CapeSim(CAPE_REST);
    this.onStep = null;
    for (const b of bones) b.rotation.order = 'XYZ';
    bones[BONE.neck].rotation.order = 'YXZ';
    bones[BONE.thighL].rotation.order = 'ZXY';
    bones[BONE.thighR].rotation.order = 'ZXY';
    bones[BONE.armL].rotation.order = 'XZY';
    bones[BONE.armR].rotation.order = 'XZY';
  }

  update(dtIn, anim = {}) {
    // rawDt measures root motion (an AI may update distant snatchers at a lower rate); the
    // animation itself never steps more than 0.1 s at once.
    const rawDt = Number.isFinite(dtIn) && dtIn > 0 ? dtIn : 0;
    const dt = Math.min(rawDt, 0.1);
    const speedIn = clamp(finite(anim.speed), 0, 12);
    const mode = resolveMode(anim.mode, speedIn);
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeTime = 0;
    }
    this.modeTime += dt;
    this.t += dt;
    const headYaw = angleDiff(0, finite(anim.headYaw)); // wrapped: AIs often pass raw angle differences
    const headPitch = clamp(finite(anim.headPitch), -1.5, 1.5);
    const alert = clamp(finite(anim.alert), 0, 1);

    const teleported = this.trackRoot(rawDt);
    if (teleported) this.snap(mode, speedIn);
    this.blend(dt, mode);
    this.overlays(dt);
    const P = this.p;
    const t = this.t;
    const b = this.b;
    const tr = P.tremor + 0.1 * alert;

    // --- gait: stride phase advances with distance (anim.speed), feet are IK-planted.
    // Slow walking takes shorter steps (cycle length D shrinks) rather than shorter strides, so
    // planted feet never slide; only when (almost) stopped do the feet settle under the body.
    this.speed = damp(this.speed, speedIn, 8, dt);
    const v = this.speed;
    const g = smoothstep(0.03, 0.2, v);
    const turn = Math.abs(this.yawRate);
    const turnStep = (1 - g) * smoothstep(0.6, 1.8, turn);
    const D = v < 0.6 ? lerp(0.5, 1.25, v / 0.6) : clamp(1.1 + 0.25 * v, 1.25, 2.15);
    const beta = lerp(0.62, 0.52, smoothstep(1.5, 3.9, v));
    const prevPhase = this.phase;
    this.phase = (this.phase + (speedIn * dt + turnStep * turn * dt * 0.3) / D) % 1;
    this.gait = g;
    this.lift = damp(this.lift, Math.max(g * smoothstep(0, 0.8, v), turnStep), 6, dt);
    if (this.onStep && this.lift > 0.3) {
      if (prevPhase > this.phase) this.onStep(-1);
      else if (prevPhase < 0.5 && this.phase >= 0.5) this.onStep(1);
    }
    const gw = this.gait;
    const halfStride = beta * D * 0.5 * gw;
    const legLen = LEG.thigh + LEG.shin;
    const reach = halfStride * 0.8;
    const gaitDrop = Math.max(0, legLen - Math.sqrt(Math.max(0.1, legLen * legLen * 0.995 - reach * reach)));
    const leanEff = P.lean + 0.035 * v + 0.05 * alert + P.peer * 0.04 * Math.abs(this.scan);
    const chestPitch = leanEff + P.hunch;

    // --- hips & spine
    const ph = this.phase * Math.PI * 2;
    const swayX = P.sway * 0.013 * Math.sin(t * 0.63 + this.seed) + 0.014 * gw * Math.sin(ph);
    const swayZ = P.sway * 0.01 * Math.sin(t * 0.47 + this.seed * 2.1);
    const bob = 0.007 * gw * Math.cos(2 * ph);
    const hips = b[BONE.hips];
    const hipsZ = swayZ + leanEff * 0.08;
    hips.position.set(swayX, 1.06 - P.drop - gaitDrop * 0.85 - bob - 0.02 * P.toe, hipsZ - 0.8 * P.lunge);
    const pelvisYaw = 0.07 * gw * Math.cos(ph);
    const pelvisRoll = 0.03 * gw * Math.sin(ph) + P.sway * 0.012 * Math.sin(t * 0.63 + this.seed + 0.6);
    hips.rotation.set(0, pelvisYaw, pelvisRoll);
    const breath = Math.sin(t * 1.25 + this.seed) * P.breath;
    const peerRoll = P.peer * 0.08 * this.scan;
    b[BONE.spine].rotation.set(-leanEff * 0.55 + 0.01 * tr * tremble(t, 9), -pelvisYaw * 0.6, -pelvisRoll * 0.7 + peerRoll * 0.5);
    b[BONE.chest].rotation.set(-(leanEff * 0.45 + P.hunch) - 0.012 * breath, -pelvisYaw * 0.4 + 0.12 * this.scan * P.peer, peerRoll * 0.5);

    hips.updateMatrix();
    b[BONE.spine].updateMatrix();
    b[BONE.chest].updateMatrix();
    _hipsM.copy(hips.matrix);
    _chestM.multiplyMatrices(_hipsM, b[BONE.spine].matrix).multiply(b[BONE.chest].matrix);
    _qHipsInv.copy(hips.quaternion).invert();

    // --- legs (a lunge steps the left foot forward, lifting it on the way)
    const lungeK = clamp(P.lunge / 0.16, 0, 1);
    for (const side of SIDES) {
      const s = side.s;
      const legPhase = (this.phase + (s < 0 ? 0 : 0.5)) % 1;
      this.footTarget(legPhase, s, beta, halfStride, gw, P, _target);
      _target.z += hipsZ;
      if (s < 0) {
        _target.z -= 1.6 * P.lunge;
        _target.y += 0.12 * 4 * lungeK * (1 - lungeK);
      }
      this.solveLeg(side, _target);
    }

    // --- arms: limp pendulums driven by body acceleration, or held up when stiff.
    const stiffK = lerp(16, 70, P.stiff);
    const damping = 2 * lerp(0.28, 0.6, P.stiff) * Math.sqrt(stiffK);
    for (const side of SIDES) {
      const s = side.s;
      const pd = this.pend[side.i];
      pd.fv += (-stiffK * pd.f - damping * pd.fv - this.accF * stiffK * 0.05) * dt;
      pd.f = clamp(pd.f + pd.fv * dt, -0.6, 0.6);
      pd.ov += (-stiffK * pd.o - damping * pd.ov - s * this.accL * stiffK * 0.04) * dt;
      pd.o = clamp(pd.o + pd.ov * dt, -0.25, 0.5);
      const legPhase = (this.phase + (s < 0 ? 0.5 : 0)) % 1;
      const swing = 0.09 * gw * (1 - P.stiff) * Math.sin(legPhase * Math.PI * 2);
      const reach = P.reach * 0.08 * Math.sin(t * 2.3 + s * 1.3);
      b[side.clav].rotation.set(0, -s * 0.06 * P.armFlex, s * (P.shrug * 0.22 + 0.012 * breath + 0.03 * tr * tremble(t, 5 + s)));
      b[side.arm].rotation.set(P.armFlex + chestPitch + swing + pd.f + reach, s * P.twist, s * (P.armOut + pd.o + 0.03 * P.reach * Math.sin(t * 1.7 + s)));
      b[side.fore].rotation.set(P.elbow + 0.4 * Math.max(0, -pd.f) * (1 - P.stiff) + 0.06 * P.reach * Math.sin(t * 2.9 + s), s * P.pron * 1.3, 0);
      b[side.hand].rotation.set(P.wrist + 0.12 * tr * tremble(t, 3 + s), 0, -s * 0.06);
      const curl = clamp(P.curl + 0.15 * alert + this.tw.curl + 0.28 * P.reach * Math.sin(t * 5.1 + s * 2) + 0.2 * tr * tremble(t, 4 + s), -0.25, 1.25);
      b[side.f1].rotation.set(0, 0, -s * curl * 0.75);
      b[side.f2].rotation.set(0, 0, -s * curl * 0.95);
    }

    // --- neck & head: the gaze is solved in model space so headYaw/headPitch stay world-levelled.
    const sweepYaw = P.sweep * this.scan;
    const yawTotal = clamp(headYaw + sweepYaw + this.tw.yaw + this.jk.yaw, -2.3, 2.3);
    const basePitch = headPitch + P.look + this.tw.pitch + this.jk.pitch + 0.025 * tr * tremble(t, 1);
    const pitchTotal = clamp(basePitch + P.sky * Math.max(0, 1.05 - basePitch), -1.1, 1.3);
    const roll = P.roll + this.tw.roll + this.jk.roll + 0.03 * tr * tremble(t, 2) + peerRoll * 0.6;
    const neck = b[BONE.neck];
    neck.rotation.set(-P.neck, yawTotal * 0.3, 0);
    neck.updateMatrix();
    _q1.setFromRotationMatrix(_m1.multiplyMatrices(_chestM, neck.matrix)); // neck orientation, model space
    _e.set(pitchTotal, yawTotal, roll, 'YXZ');
    _q2.setFromEuler(_e);
    b[BONE.head].quaternion.copy(_q1.invert().multiply(_q2));

    // --- jaw & sliding face
    let jaw = P.jaw + 0.1 * alert + 0.02 * (breath + 1) + 0.05 * tr * tremble(t, 6);
    jaw += 0.07 * P.jerk * Math.max(0, Math.sin(t * 19 + this.seed)) * (Math.sin(t * 2.1) > 0 ? 1 : 0);
    if (this.mode === 'grab') jaw *= lerp(0.25, 1, smoothstep(0.15, 1.1, this.modeTime));
    b[BONE.jaw].rotation.set(-clamp(jaw, 0, 1.15) * 0.62, 0, 0);
    const sl = P.slide;
    b[BONE.face].rotation.set(
      sl * 0.05 * (noise1(t * 0.41, this.seed) - 0.5) + this.tw.face * 0.3,
      sl * 0.1 * (noise1(t * 0.29, this.seed + 3) - 0.5) + this.tw.face,
      sl * 0.14 * (noise1(t * 0.23, this.seed + 5) - 0.5) + this.tw.face * 0.6,
    );

    // --- cape
    this.updateCape(dt, teleported, P, gw);
  }

  // Root world motion -> velocity / acceleration in the body frame, yaw rate. True on teleport.
  trackRoot(dt) {
    const rig = this.rig;
    rig.updateWorldMatrix(true, false);
    const e = rig.matrixWorld.elements;
    const x = e[12], z = e[14];
    const yaw = Math.atan2(e[8], e[10]);
    let teleported = false;
    if (!this.hasPrev || Math.hypot(x - this.prevX, z - this.prevZ) > teleportDistance(dt)) {
      teleported = true;
      this.hasPrev = true;
      this.vx = this.vz = this.accF = this.accL = this.yawRate = 0;
    } else if (dt > 0) {
      const nvx = (x - this.prevX) / dt, nvz = (z - this.prevZ) / dt;
      const ax = (nvx - this.vx) / dt, az = (nvz - this.vz) / dt;
      this.vx = nvx;
      this.vz = nvz;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      this.accF = clamp(damp(this.accF, ax * fx + az * fz, 12, dt), -20, 20);
      this.accL = clamp(damp(this.accL, ax * rx + az * rz, 12, dt), -20, 20);
      this.yawRate = damp(this.yawRate, angleDiff(this.prevYaw, yaw) / dt, 10, dt);
    }
    this.prevX = x;
    this.prevZ = z;
    this.prevYaw = yaw;
    this.yaw = yaw;
    return teleported;
  }

  // After a teleport: take the current mode's pose at once and drop all motion state.
  snap(mode, speed) {
    const target = MODES[mode];
    for (const key of KEYS) this.p[key] = target[key];
    this.speed = speed;
    this.lift = smoothstep(0.03, 0.2, speed) * smoothstep(0, 0.8, speed);
    for (const pd of this.pend) pd.f = pd.fv = pd.o = pd.ov = 0;
    for (const k of TW_KEYS) this.tw[k] = 0;
    for (const k of JK_KEYS) this.jk[k] = 0;
    this.twHold = 0;
  }

  blend(dt, mode) {
    const target = MODES[mode];
    const P = this.p;
    const k = 1 - Math.exp(-target.rate * dt);
    for (const key of KEYS) P[key] += (target[key] - P[key]) * k;
    if (mode === 'grab') {
      const mt = this.modeTime;
      P.curl = lerp(0.1, 0.8, smoothstep(0.45, 0.95, mt));
      // The neck keeps stretching: the face creeps closer while the jaw opens.
      P.neck = Math.max(P.neck, lerp(0.45, 0.74, smoothstep(0.3, 1.9, mt)));
      P.roll = 0.1 + 0.38 * smoothstep(0.9, 2.2, mt);
    }
  }

  overlays(dt) {
    const P = this.p;
    const rng = this.rng;
    // Idle twitches: a sharp snap of the head (and fingers), a hold, a slow release.
    this.twTimer -= dt * P.twitch;
    if (this.twTimer <= 0) {
      this.twTimer = 1.8 + rng() * 4.5;
      this.twHold = 0.25 + rng() * 1.2;
      const sgn = () => (rng() < 0.5 ? -1 : 1);
      const T = this.twTarget;
      T.yaw = sgn() * (0.18 + rng() * 0.4);
      T.roll = sgn() * (0.1 + rng() * 0.38);
      T.pitch = -0.12 + rng() * 0.3;
      T.face = sgn() * (0.03 + rng() * 0.05);
      T.curl = (rng() - 0.3) * 0.5;
    }
    if (this.mode === 'grab' && this.modeTime > 1.35 && this.modeTime - dt <= 1.35) {
      // The face slips sideways while you watch.
      this.twTarget.face = 0.12;
      this.twTarget.yaw = this.twTarget.pitch = this.twTarget.curl = 0;
      this.twTarget.roll = 0.15;
      this.twHold = 2;
    }
    const holding = this.twHold > 0;
    this.twHold -= dt;
    const lam = holding ? 38 : 2.2;
    const gain = this.mode === 'grab' ? 1 : clamp(P.twitch * 1.5, 0, 1);
    for (const k of TW_KEYS) this.tw[k] = damp(this.tw[k], holding ? this.twTarget[k] * gain : 0, lam, dt);
    // Chase jerks: the head is locked forward but keeps jolting.
    this.jkTimer -= dt;
    if (this.jkTimer <= 0) {
      this.jkTimer = 0.05 + rng() * 0.18;
      const big = rng() < 0.08 ? 3 : 1;
      this.jkTarget.yaw = (rng() - 0.5) * 0.18 * big * P.jerk;
      this.jkTarget.pitch = (rng() - 0.5) * 0.14 * big * P.jerk;
      this.jkTarget.roll = (rng() - 0.5) * 0.24 * big * P.jerk;
    }
    for (const k of JK_KEYS) this.jk[k] = damp(this.jk[k], this.jkTarget[k], 28, dt);
    // Scan wave for investigate/search, plus a little irregularity.
    this.scan = scanWave(this.t / 5.4 + this.scanOffset) * 0.85 + 0.15 * Math.sin(this.t * 1.7 + this.seed);
  }

  // Ankle target (model space) for a leg at gait phase u.
  footTarget(u, s, beta, halfStride, gw, P, out) {
    let z, y = 0, pitch;
    const lift = this.lift * lerp(0.07, 0.13, smoothstep(1.5, 3.9, this.speed));
    if (u < beta) {
      const k = u / beta;
      z = lerp(-halfStride, halfStride, k);
      pitch = 0.22 * gw * (1 - smoothstep(0, 0.15, k)) - 0.45 * gw * smoothstep(0.75, 1, k);
      y = 0.055 * gw * smoothstep(0.75, 1, k);
    } else {
      const k = (u - beta) / (1 - beta);
      z = lerp(halfStride, -halfStride, smoothstep(0, 1, k));
      y = lift * Math.sin(Math.PI * k) + 0.055 * gw * (1 - smoothstep(0, 0.3, k));
      pitch = lerp(-0.45, 0.22, smoothstep(0, 0.9, k)) * gw;
    }
    y += 0.05 * P.toe;
    pitch -= 0.4 * P.toe;
    this._footPitch = pitch;
    return out.set(s * (0.1 - 0.02 * gw), 0.075 + y, z);
  }

  // Two-bone IK in the hips frame; knee bends forward, foot keeps its pitch to the ground.
  solveLeg(sideBones, target) {
    const thigh = this.b[sideBones.thigh], shin = this.b[sideBones.shin], foot = this.b[sideBones.foot];
    _v1.copy(thigh.position).applyMatrix4(_hipsM); // hip joint, model space
    _d.subVectors(target, _v1).applyQuaternion(_qHipsInv);
    const a = LEG.thigh, c = LEG.shin;
    const dist = _d.length() || 1e-4;
    const len = clamp(dist, 0.25, a + c - 1e-4);
    const fwd = Math.asin(clamp(-_d.z / dist, -1, 1));
    const side = Math.atan2(_d.x, -_d.y);
    const knee = Math.acos(clamp((a * a + c * c - len * len) / (2 * a * c), -1, 1));
    const hipA = Math.acos(clamp((a * a + len * len - c * c) / (2 * a * len), -1, 1));
    const flex = fwd + hipA;
    const bend = Math.PI - knee;
    thigh.rotation.set(flex, 0, side);
    shin.rotation.set(-bend, 0, 0);
    foot.rotation.set(-flex + bend + this._footPitch, 0, -side);
  }

  updateCape(dt, teleported, P, gw) {
    const b = this.b;
    // Pinned top row rides the chest.
    for (let i = 0; i < CAPE.cols; i++) {
      _v1.fromArray(ROW0, i * 3).applyMatrix4(_chestM).toArray(_pinned, i * 3);
    }
    // Body colliders (model space): torso, thighs, shins, upper arms, forearms.
    let n = 0;
    _v1.setFromMatrixPosition(_hipsM);
    _v2.set(0, 0.22, 0).applyMatrix4(_chestM);
    n = capsule(n, _v1, _v2, 0.14);
    for (const side of SIDES) {
      const thigh = b[side.thigh], shin = b[side.shin], foot = b[side.foot];
      thigh.updateMatrix();
      shin.updateMatrix();
      _m1.multiplyMatrices(_hipsM, thigh.matrix);
      _v1.setFromMatrixPosition(_m1);
      _m2.multiplyMatrices(_m1, shin.matrix);
      _v2.setFromMatrixPosition(_m2);
      n = capsule(n, _v1, _v2, 0.08);
      _v1.copy(foot.position).applyMatrix4(_m2);
      n = capsule(n, _v2, _v1, 0.065);
      const clav = b[side.clav], arm = b[side.arm], fore = b[side.fore];
      clav.updateMatrix();
      arm.updateMatrix();
      _m1.multiplyMatrices(_chestM, clav.matrix).multiply(arm.matrix);
      _v1.setFromMatrixPosition(_m1);
      _v2.copy(fore.position).applyMatrix4(_m1);
      n = capsule(n, _v1, _v2, 0.055);
      fore.updateMatrix();
      _m1.multiply(fore.matrix);
      _v1.set(0, -0.45, 0).applyMatrix4(_m1);
      n = capsule(n, _v2, _v1, 0.05);
    }
    const M = this.rig.matrixWorld;
    if (teleported) this.cape.reset(M, _pinned);
    const t = this.t;
    _wind.set(0.25 * Math.sin(t * 0.31 + this.seed), 0, 0.2 * Math.sin(t * 0.23 + this.seed * 1.7));
    _capeOpts.billow = P.billow;
    _capeOpts.time = t;
    _capeOpts.drag = 2.2 + 0.4 * gw;
    this.cape.step(dt, M, _pinned, _caps, n, _capeOpts);
    _invM.copy(M).invert();
    this.cape.apply(b, CAPE_FIRST, _invM);
  }
}

// Creates one snatcher. The seed picks the face variant and individual quirks (height, timing).
export function createSnatcherModel(seed = 1) {
  const seedInt = seedToInt(seed);
  const variantIndex = variantForSeed(seedInt);
  const assets = getSnatcherAssets(variantIndex);
  const rng = makeRng(seedInt * 2654435761);
  const root = new THREE.Object3D();
  root.name = 'snatcher';
  const rig = new THREE.Group();
  rig.scale.setScalar(rng.range(0.97, 1.045));
  root.add(rig);
  const { bones, skeleton } = createSkeleton();
  rig.add(bones[BONE.root]);
  const mesh = new THREE.SkinnedMesh(assets.geometry, assets.materials);
  mesh.name = 'snatcher-body';
  mesh.bind(skeleton, new THREE.Matrix4());
  // Generous fixed bounds (raised arms, billowing cape) so frustum culling never pops.
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 1.8);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-1.3, -0.1, -1.3), new THREE.Vector3(1.3, 2.6, 1.3));
  rig.add(mesh);
  const headAnchor = new THREE.Object3D();
  headAnchor.name = 'snatcher-head-anchor';
  headAnchor.position.copy(HEAD_ANCHOR);
  bones[BONE.head].add(headAnchor);

  // Timing quirks also mix in the instance number, so two snatchers sharing a seed never move in step.
  const animSeed = (seedInt % 9973) + 1 + (instanceCount++ % 97) * 131;
  const animator = new SnatcherAnimator(rig, bones, animSeed);
  animator.update(0, { mode: 'idle' });
  // The AI has not placed the model yet: its first real update is a teleport, wherever that is
  // (otherwise a spawn within a few metres of the origin drags the cape across the gap).
  animator.hasPrev = false;

  return {
    root,
    headAnchor,
    mesh,
    variant: assets.variant.name,
    // Optional: called with -1 (left) / +1 (right) when a foot plants, for synced step sounds.
    set onStep(fn) {
      animator.onStep = fn;
    },
    get onStep() {
      return animator.onStep;
    },
    update(dt, anim) {
      animator.update(dt, anim || {});
    },
    dispose() {
      root.removeFromParent();
      skeleton.dispose();
    },
  };
}
