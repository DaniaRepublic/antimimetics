import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { angleDiff, clamp, damp, dirToYaw, lerp, makeRng, noise1, smoothstep } from '../core/math.js';
import { LEG_DEFS, LEG_LENGTHS, LeviathanModel, NECK_PIVOT, TIBIA_HALF } from './leviathan-model.js';

// The leviathan: a starved, segmented body carried ~125 m above the streets on six harvestman
// legs. It walks the level's leviathanRoute a little ahead of the player ("following where the
// living are"), loiters over zones that ask for it, and periodically calls. Its footfalls and
// calls mask the player's noise (game.noiseMask) and drive camera shake / atmosphere / audio
// through the event bus. See ARCHITECTURE.md (Leviathan).

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const DOWN = { x: 0, y: -1, z: 0 };

const TUNE = {
  height: 122, // body centre above the street (plus a share of the average foot height)
  footHeightFollow: 0.45,
  speed: 2.0, // m/s while following
  hurrySpeed: 2.6, // when far behind its goal
  loiterSpeed: 1.05,
  accel: 0.3, // m/s^2
  turnRate: 0.035, // rad/s: its outer feet sweep ~2.3 m/s at this rate; faster, the gait can't keep up
  lead: 24, // metres ahead of the player's progress along the route
  stepThreshold: 8, // a foot this far from its ideal spot wants to step
  urgentLag: 30,
  stepTime: [2.75, 3.4],
  overlap: 0.7, // a second leg may lift once the swinging one is this far through its step
  restlessAfter: 6.5, // seconds without a step before a small settling step
  footClearance: 13, // never plant a foot closer than this to the player
  tallRoof: 32, // prefer plant spots lower than this
  maskPeak: 0.6, // noise mask at the player from a close footfall
  maskTime: 0.8,
  needleBox: 0.3, // collider width (m) around a needle planted in the street; 0 disables
  needleBoxH: 2.2, // ...covering its lean up to about head height
  maxNeedleBoxes: 600, // only without CollisionWorld.updateBox: each leg otherwise recycles one box
};

// Legs that must not be in the air at the same time (opposite leg, same-side neighbours).
const NEIGHBOURS = LEG_DEFS.map((_, i) => {
  const n = [i ^ 1];
  if (i - 2 >= 0) n.push(i - 2);
  if (i + 2 < LEG_DEFS.length) n.push(i + 2);
  return n;
});

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _v2 = new THREE.Vector2();
const _rp = { x: 0, z: 0 };
const _rt = { x: 0, z: 0 };

function randIn(range, fallback) {
  const r = Array.isArray(range) ? range : fallback;
  return r[0] + Math.random() * (r[1] - r[0]);
}

function plantable(c) {
  return c.blocksMove !== false && c.blocksSight !== false && c.maxY - c.minY > 0.25 && c.maxY < 150;
}

// Polyline in ground coordinates with arc-length queries.
class Route {
  constructor(points) {
    this.pts = points.map((p) => ({ x: +p.x || 0, z: +p.z || 0 }));
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      this.cum.push(this.cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  segment(s) {
    let i = 1;
    while (i < this.pts.length - 1 && this.cum[i] < s) i++;
    return i;
  }

  pointAt(s, out) {
    s = clamp(s, 0, this.length);
    const i = this.segment(s);
    const a = this.pts[i - 1], b = this.pts[i];
    const t = (s - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  }

  tangentAt(s, out) {
    const i = this.segment(clamp(s, 0, this.length));
    const a = this.pts[i - 1], b = this.pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out.x = (b.x - a.x) / l;
    out.z = (b.z - a.z) / l;
    return out;
  }

  // Arc length of the closest point on the route to (x, z).
  project(x, z) {
    let best = 0, bestD = Infinity;
    for (let i = 1; i < this.pts.length; i++) {
      const a = this.pts[i - 1], b = this.pts[i];
      const ex = b.x - a.x, ez = b.z - a.z;
      const l2 = ex * ex + ez * ez;
      const t = l2 > 1e-9 ? clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1) : 0;
      const px = a.x + ex * t - x, pz = a.z + ez * t - z;
      const d = px * px + pz * pz;
      if (d < bestD) {
        bestD = d;
        best = this.cum[i - 1] + t * Math.sqrt(l2);
      }
    }
    return best;
  }
}

export class Leviathan {
  constructor(game) {
    this.game = game;
    this.model = new LeviathanModel();
    game.scene.add(this.model.root);
    this.uniforms = this.model.uniforms;

    // --- public
    this.position = new THREE.Vector3(0, TUNE.height, 0); // body centre (world)
    this.headPosition = new THREE.Vector3();
    this.calling = false;
    this.callProgress = 0; // 0..1 during a call
    this.callEnvelope = 0; // smoothed 0..1 loudness of the call
    this.mode = 'follow'; // 'title' | 'follow' | 'near'
    this.footfalls = 0; // counters (tests / debug)
    this.calls = 0;

    // --- body state
    this.time = 0;
    this.ground = new THREE.Vector2(); // body centre projected on the ground (x, z)
    this.vel = new THREE.Vector2();
    this.goal = new THREE.Vector2();
    this.yaw = 0;
    this.yawRate = 0;
    this.bodyY = TUNE.height;
    this.pitch = 0;
    this.roll = 0;
    this.jolt = 0;
    this.joltVel = 0;
    this.shift = 0;
    this.neck = { yaw: 0, pitch: 0, jaw: 0 };
    this.playerS = 0;

    // --- call / noise mask
    this.callTimer = randIn(CONFIG.leviathan?.callIntervalCalm, [32, 48]) * 0.5;
    this.callTime = 0;
    this.wasNear = false;
    this.startedPlaying = false;
    this.footMask = 0;
    this.footMaskPeak = 0;
    this.footMaskAge = 99;
    this.lastLift = -99;

    const rng = makeRng(2024);
    this.legs = LEG_DEFS.map((def, i) => ({
      index: i,
      def,
      hipLocal: this.model.hips[i],
      hip: new THREE.Vector3(),
      foot: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      goal: new THREE.Vector3(),
      knee: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      ankle: new THREE.Vector3(),
      dirX: 0,
      dirZ: 0,
      swing: false,
      t: 0,
      dur: 3,
      arc: 12,
      lag: 0,
      bias: rng() * 3,
      collider: null, // CollisionWorld box while the needle stands in the street
      box: null, // this leg's box, kept (disabled) while the foot is lifted and moved on the next plant
      boxPending: false,
    }));
    this.needleBoxes = 0;

    this.routeSource = undefined;
    this.route = null;
    this.titleGoal = null;
    this.placedFor = null;
    // Provisional pose so the creature is never drawn unposed; the first update re-places it
    // for the title shot or the actual starting checkpoint.
    this.placeForCheckpoint(game.checkpoint ?? game.level?.checkpoints?.[0]);
    this.firstUpdate = true;
  }

  // ------------------------------------------------------------------ placement

  ensureRoute() {
    const src = this.game.level?.leviathanRoute;
    if (this.route && src === this.routeSource) return this.route;
    this.routeSource = src;
    if (Array.isArray(src) && src.length >= 2) {
      this.route = new Route(src);
      if (this.route.length < 1) this.route = null;
    } else this.route = null;
    if (!this.route) {
      // No route from the level: walk a line beside the start, heading north.
      const cp = this.game.level?.checkpoints?.[0]?.pos ?? { x: 0, z: 0 };
      this.route = new Route([{ x: cp.x + 55, z: cp.z + 60 }, { x: cp.x + 55, z: cp.z - 520 }]);
    }
    return this.route;
  }

  zoneFor(cp) {
    const level = this.game.level;
    const zones = level?.zones;
    if (!zones || !cp) return null;
    if (typeof cp.zone === 'number') return zones.find((z) => z.index === cp.zone) ?? zones[cp.zone] ?? null;
    if (typeof cp.zone === 'string') return zones.find((z) => z.id === cp.zone) ?? null;
    const i = cp.pos && level.zoneAt ? level.zoneAt(cp.pos) : -1;
    return i >= 0 ? zones[i] : null;
  }

  currentZone() {
    const level = this.game.level;
    return level?.zones?.[level.currentZone] ?? null;
  }

  // Where to stand on the title screen: on the route, inside the title camera's view.
  computeTitleGoal() {
    const tc = this.game.level?.titleCamera;
    if (!tc?.pos || !tc?.target) return null;
    const route = this.ensureRoute();
    const cx = tc.pos[0], cz = tc.pos[2];
    let fx = tc.target[0] - cx, fz = tc.target[2] - cz;
    const fl = Math.hypot(fx, fz);
    if (fl < 1e-3) return null;
    fx /= fl;
    fz /= fl;
    const start = this.game.level?.checkpoints?.[0]?.pos;
    const startS = start ? route.project(start.x, start.z) : 0;
    // Distance at which the body sits ~40% of the way up from the centre of the frame.
    const pitch = Math.atan2(tc.target[1] - tc.pos[1], fl);
    const halfFov = THREE.MathUtils.degToRad((this.game.camera?.fov ?? 72) / 2);
    const elev = clamp(pitch + halfFov * 0.4, 0.12, 1.2);
    const ideal = clamp((TUNE.height - tc.pos[1]) / Math.tan(elev), 200, 460);
    const p = { x: 0, z: 0 };
    const world = this.game.world;
    const eye = new THREE.Vector3(tc.pos[0], tc.pos[1], tc.pos[2]);
    const body = new THREE.Vector3();
    let best = null, bestScore = Infinity;
    for (let s = 0; s <= route.length; s += 4) {
      route.pointAt(s, p);
      const dx = p.x - cx, dz = p.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < 170 || d > 520) continue;
      const cos = (dx * fx + dz * fz) / d;
      if (cos < 0.93) continue;
      let score = Math.abs(s - startS) * 0.3 + (1 - cos) * 900 + Math.abs(d - ideal) * 0.6;
      // A building between the title camera and the body would hide the whole point of the shot.
      if (world?.segmentBlocked && score - 600 < bestScore) {
        body.set(p.x, TUNE.height - 6, p.z);
        if (world.segmentBlocked(eye, body)) score += 600;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { x: p.x, z: p.z };
      }
    }
    if (!best) best = { x: cx + fx * ideal, z: cz + fz * ideal };
    best.yaw = dirToYaw(-fz, fx); // broadside to the camera
    return best;
  }

  // Jump to (x, z) facing yaw and plant every foot instantly (clear of `avoid`, e.g. the spawn).
  placeAt(x, z, yaw, avoid = this.game.player?.position) {
    this.ground.set(x, z);
    this.goal.set(x, z);
    this.vel.set(0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.jolt = this.joltVel = 0;
    let footY = 0;
    for (const leg of this.legs) {
      this.idealFoot(leg, 0, leg.foot);
      // Stagger the feet a little along the heading so the gait starts out of phase.
      const stagger = (leg.index % 3 === 1 ? 1 : -1) * (leg.index % 2 ? 4 : -4);
      leg.foot.x += -Math.sin(yaw) * stagger;
      leg.foot.z += -Math.cos(yaw) * stagger;
      if (avoid) this.avoidPoint(leg.foot, avoid);
      leg.foot.y = this.groundHeight(leg.foot.x, leg.foot.z);
      leg.to.copy(leg.foot);
      leg.goal.copy(leg.foot);
      leg.swing = false;
      leg.t = 0;
      footY += leg.foot.y;
    }
    this.bodyY = TUNE.height + (footY / this.legs.length) * TUNE.footHeightFollow;
    this.applyBodyTransform(0);
    for (const leg of this.legs) {
      this.poseLeg(leg);
      this.setNeedleBox(leg);
    }
    this.commitLegs();
    this.updateHeadPosition();
  }

  placeForCheckpoint(cp) {
    this.placedFor = cp ?? null;
    const route = this.ensureRoute();
    const pos = cp?.pos ?? this.game.player?.position ?? { x: 0, z: 0 };
    const sP = route.project(pos.x, pos.z);
    this.playerS = sP;
    const lz = this.zoneFor(cp)?.leviathan;
    const t = { x: 0, z: 0 };
    // On respawn the player still stands where they died: keep the feet off the spawn point.
    const avoid = cp?.pos ?? this.game.player?.position;
    if (lz?.calls === 'near' && lz.anchor) {
      route.tangentAt(route.project(lz.anchor.x, lz.anchor.z), t);
      this.placeAt(lz.anchor.x, lz.anchor.z, dirToYaw(t.x, t.z), avoid);
      return;
    }
    const s = clamp(sP + TUNE.lead, 0, route.length);
    const p = route.pointAt(s, { x: 0, z: 0 });
    route.tangentAt(s, t);
    this.placeAt(p.x, p.z, dirToYaw(t.x, t.z), avoid);
  }

  initialPlacement() {
    const game = this.game;
    this.ensureRoute();
    if (game.state === 'title') {
      this.titleGoal = this.computeTitleGoal();
      if (this.titleGoal) {
        this.placeAt(this.titleGoal.x, this.titleGoal.z, this.titleGoal.yaw);
        return;
      }
    }
    this.placeForCheckpoint(game.checkpoint ?? game.level?.checkpoints?.[0]);
  }

  onRespawn(checkpoint) {
    if (this.calling) this.endCall();
    this.footMask = this.footMaskPeak = 0;
    this.footMaskAge = 99;
    this.placeForCheckpoint(checkpoint);
    const near = this.zoneFor(checkpoint)?.leviathan?.calls === 'near';
    this.wasNear = near;
    const L = CONFIG.leviathan ?? {};
    this.callTimer = near ? randIn(L.callIntervalNear, [10, 13]) * 0.6 : randIn(L.callIntervalCalm, [32, 48]) * 0.5;
    this.game.noiseMask = 0;
  }

  // ------------------------------------------------------------------ helpers

  // Ideal planted spot for a leg, `tau` seconds ahead on the current motion.
  idealFoot(leg, tau, out) {
    const yaw = this.yaw + this.yawRate * tau;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const fx = leg.def.foot[0], fz = leg.def.foot[1];
    out.x = this.ground.x + this.vel.x * tau + fx * c + fz * s;
    out.z = this.ground.y + this.vel.y * tau - fx * s + fz * c;
    return out;
  }

  groundHeight(x, z) {
    const world = this.game.world;
    if (!world?.raycast) return 0;
    _origin.set(x, 400, z);
    const hit = world.raycast(_origin, DOWN, 400, { filter: plantable });
    return hit ? Math.max(0, hit.point.y) : 0;
  }

  // Push a ground point out of the player's personal space.
  avoidPlayer(p) {
    const pl = this.game.player?.position;
    return pl ? this.avoidPoint(p, pl) : false;
  }

  avoidPoint(p, c) {
    const dx = p.x - c.x, dz = p.z - c.z;
    const d = Math.hypot(dx, dz);
    if (!(d < TUNE.footClearance)) return false;
    const k = TUNE.footClearance / Math.max(d, 1e-3);
    p.x = c.x + (d < 1e-3 ? TUNE.footClearance : dx * k);
    p.z = c.z + (d < 1e-3 ? 0 : dz * k);
    return true;
  }

  // A needle standing in the street is solid: the player and snatchers walk around it rather
  // than through it. Uses the public CollisionWorld API (addBox / setEnabled); boxes cannot be
  // removed, so a lifted foot only disables its box. Rooftop plants need none. Call after
  // poseLeg: the box follows the needle's lean over the bottom TUNE.needleBoxH metres.
  setNeedleBox(leg) {
    this.clearNeedleBox(leg);
    leg.boxPending = false;
    const world = this.game.world;
    const f = leg.foot, a = leg.ankle;
    const rise = a.y - f.y;
    if (leg.swing || f.y > 0.3 || rise < 1 || TUNE.needleBox <= 0) return;
    if (!world?.addBox) return;
    const k = TUNE.needleBoxH / rise;
    const ox = (a.x - f.x) * k, oz = (a.z - f.z) * k;
    const off = Math.hypot(ox, oz);
    const shape = {
      x: f.x + ox / 2, z: f.z + oz / 2, y: f.y, h: TUNE.needleBoxH,
      w: TUNE.needleBox + off, d: TUNE.needleBox, rot: off > 1e-4 ? Math.atan2(-oz, ox) : 0,
    };
    if (leg.box && world.updateBox) {
      // Recycle this leg's box: the world keeps exactly one collider per leg however long it walks.
      world.updateBox(leg.box, shape);
      world.setEnabled(leg.box, true);
    } else {
      if (!world.updateBox && this.needleBoxes >= TUNE.maxNeedleBoxes) return;
      this.needleBoxes++;
      leg.box = world.addBox({ ...shape, blocksMove: true, blocksSight: false, tag: 'leviathan-foot' });
    }
    leg.collider = leg.box;
  }

  clearNeedleBox(leg) {
    if (!leg.collider) return;
    this.game.world?.setEnabled?.(leg.collider, false);
    leg.collider = null;
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    const game = this.game;
    if (this.firstUpdate) {
      this.firstUpdate = false;
      if (game.state === 'title' || (game.checkpoint && game.checkpoint !== this.placedFor)) this.initialPlacement();
    }
    dt = Math.min(Math.max(dt, 0), 0.1);
    this.time += dt;

    if (!this.startedPlaying && game.state === 'playing') {
      // First moments of play: make sure the player hears a call soon, to learn the rule.
      this.startedPlaying = true;
      if (!this.calling) this.callTimer = Math.min(this.callTimer, 16 + Math.random() * 6);
    }

    this.updateGoal(dt);
    this.updateBody(dt);
    this.updateGait(dt);
    for (const leg of this.legs) {
      this.poseLeg(leg);
      if (leg.boxPending) this.setNeedleBox(leg);
    }
    this.commitLegs();
    this.updateCall(dt);
    this.updateHead(dt);
    this.updateUniforms();

    this.footMaskAge += dt;
    this.footMask = this.footMaskPeak * Math.max(0, 1 - this.footMaskAge / TUNE.maskTime);
    game.noiseMask = Math.max(this.calling ? 1 : 0, this.footMask);
  }

  updateGoal(dt) {
    const game = this.game;
    const route = this.ensureRoute();
    const lz = this.currentZone()?.leviathan;
    const t = this.time;
    if (game.state === 'title' && this.titleGoal) {
      this.mode = 'title';
      const g = this.titleGoal;
      const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
      const a = Math.sin((t * TAU) / 95) * 16, b = Math.cos((t * TAU) / 95) * 8;
      this.goal.set(g.x - s * a + c * b, g.z - c * a - s * b);
      return;
    }
    if (lz?.calls === 'near' && lz.anchor) {
      this.mode = 'near';
      const a = (t * TAU) / 80;
      this.goal.set(lz.anchor.x + Math.sin(a) * 12, lz.anchor.z + Math.cos(a * 0.8) * 9);
      return;
    }
    this.mode = 'follow';
    const pl = game.player?.position;
    if (pl) {
      const sP = route.project(pl.x, pl.z);
      this.playerS = Math.abs(sP - this.playerS) > 80 ? sP : damp(this.playerS, sP, 0.35, dt);
    }
    const s = clamp(this.playerS + TUNE.lead + Math.sin((t * TAU) / 83) * 14, 0, route.length);
    const p = route.pointAt(s, _rp);
    const tan = route.tangentAt(s, _rt);
    const side = Math.sin((t * TAU) / 61 + 1) * 7;
    this.goal.set(p.x - tan.z * side, p.z + tan.x * side);
  }

  updateBody(dt) {
    const dx = this.goal.x - this.ground.x, dz = this.goal.y - this.ground.y;
    const dist = Math.hypot(dx, dz);
    let vmax = TUNE.speed;
    if (this.mode === 'follow') vmax = dist > 100 ? TUNE.hurrySpeed : TUNE.speed;
    else vmax = dist > 45 ? TUNE.speed : TUNE.loiterSpeed;
    let speed = vmax * smoothstep(1.5, 28, dist);
    if (this.calling) speed *= 0.12;
    const tx = dist > 1e-3 ? (dx / dist) * speed : 0;
    const tz = dist > 1e-3 ? (dz / dist) * speed : 0;
    let ax = tx - this.vel.x, az = tz - this.vel.y;
    const al = Math.hypot(ax, az);
    const maxA = TUNE.accel * dt;
    if (al > maxA) {
      ax *= maxA / al;
      az *= maxA / al;
    }
    this.vel.x += ax;
    this.vel.y += az;
    this.ground.x += this.vel.x * dt;
    this.ground.y += this.vel.y * dt;

    const sp = this.vel.length();
    if (sp > 0.15) {
      const diff = angleDiff(this.yaw, dirToYaw(this.vel.x, this.vel.y));
      const step = clamp(diff, -TUNE.turnRate * dt, TUNE.turnRate * dt) * clamp(sp / 0.8, 0, 1);
      this.yaw += step;
      this.yawRate = damp(this.yawRate, dt > 0 ? step / dt : 0, 4, dt);
    } else {
      this.yawRate = damp(this.yawRate, 0, 2, dt);
    }
    this.applyBodyTransform(dt);
  }

  // Height, bob, sway and call shudder; writes the body transform and hip positions.
  applyBodyTransform(dt) {
    let dip = 0, roll = 0, pitch = 0, footY = 0;
    for (const leg of this.legs) {
      footY += leg.swing ? lerp(leg.from.y, leg.to.y, leg.t) : leg.foot.y;
      if (!leg.swing) continue;
      const w = Math.sin(Math.PI * leg.t);
      dip += w;
      roll += leg.def.side * w;
      pitch -= leg.def.front * w;
    }
    footY /= this.legs.length;
    const env = this.callEnvelope;
    const t = this.time;
    const sp = this.vel.length();
    const targetY = TUNE.height + footY * TUNE.footHeightFollow - dip * 0.9 + Math.sin(t * 0.29) * 0.7 + env * 3;
    if (dt > 0) {
      this.bodyY = damp(this.bodyY, targetY, 1.2, dt);
      this.joltVel += (-this.jolt * 6 - this.joltVel * 2.2) * dt;
      this.jolt += this.joltVel * dt;
      this.pitch = damp(this.pitch, pitch * 0.02 + env * 0.075 - sp * 0.004 + Math.sin(t * 0.21) * 0.006, 1.2, dt);
      this.roll = damp(this.roll, roll * 0.028 + Math.sin(t * 0.17) * 0.008, 1.2, dt);
      // shift the weight away from a lifted leg
      this.shift = damp(this.shift, -roll * 1.2, 1.0, dt);
    } else {
      this.bodyY = targetY;
      this.shift = 0;
    }
    const sh = env * env;
    const body = this.model.body;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    body.position.set(
      this.ground.x + cy * this.shift + (noise1(t * 6, 1) - 0.5) * 0.7 * sh,
      this.bodyY + this.jolt + (noise1(t * 7, 2) - 0.5) * 0.5 * sh,
      this.ground.y - sy * this.shift + (noise1(t * 6, 3) - 0.5) * 0.7 * sh,
    );
    body.rotation.set(
      this.pitch + Math.sin(t * 23) * 0.006 * sh,
      this.yaw,
      this.roll + Math.sin(t * 19) * 0.008 * sh,
    );
    body.updateMatrixWorld(true);
    this.position.copy(body.position);
    for (const leg of this.legs) leg.hip.copy(leg.hipLocal).applyMatrix4(body.matrixWorld);
  }

  // Decide which foot steps next, advance swings, plant feet.
  updateGait(dt) {
    let swinging = 0, overlapOk = true;
    for (const leg of this.legs) {
      if (!leg.swing) continue;
      swinging++;
      if (leg.t < TUNE.overlap) overlapOk = false;
    }

    if (!this.calling && this.time - this.lastLift > 0.45) {
      // The most lagging foot whose neighbours are all planted steps next.
      let best = null;
      for (const leg of this.legs) {
        if (leg.swing) {
          leg.lag = 0;
          continue;
        }
        this.idealFoot(leg, 0, _a);
        leg.lag = Math.hypot(leg.foot.x - _a.x, leg.foot.z - _a.z);
        // Standing about, it still shifts its weight now and then (small settling steps).
        const threshold = this.time - this.lastLift > TUNE.restlessAfter ? 3 : TUNE.stepThreshold + leg.bias;
        if (leg.lag <= threshold || (best && leg.lag <= best.lag)) continue;
        let blocked = false;
        for (const n of NEIGHBOURS[leg.index]) if (this.legs[n].swing) blocked = true;
        if (!blocked || leg.lag > TUNE.urgentLag + 8) best = leg;
      }
      if (best) {
        const urgent = best.lag > TUNE.urgentLag;
        const limit = urgent ? 3 : 2;
        if (swinging < limit && (swinging === 0 || overlapOk || urgent)) this.lift(best);
      }
    }

    for (const leg of this.legs) {
      if (!leg.swing) continue;
      leg.t += dt / leg.dur;
      // Keep the landing spot out of the player's way; ease the target so nothing pops.
      if (leg.t < 0.85 && this.avoidPlayer(leg.goal)) leg.goal.y = this.groundHeight(leg.goal.x, leg.goal.z);
      const k = 1 - Math.exp(-3 * dt);
      leg.to.lerp(leg.goal, k);
      if (leg.t >= 1) {
        leg.swing = false;
        leg.t = 0;
        leg.to.copy(leg.goal);
        leg.foot.copy(leg.goal);
        leg.boxPending = true; // placed once the leg is posed this frame
        this.onFootfall(leg);
        continue;
      }
      const t = leg.t;
      const h = smoothstep(0.06, 0.9, t);
      const rise = smoothstep(0, 0.38, t);
      const fall = clamp((t - 0.66) / 0.34, 0, 1);
      leg.foot.x = lerp(leg.from.x, leg.to.x, h);
      leg.foot.z = lerp(leg.from.z, leg.to.z, h);
      leg.foot.y = lerp(leg.from.y, leg.to.y, smoothstep(0.1, 0.9, t)) + leg.arc * rise * (1 - fall * fall);
    }
  }

  lift(leg) {
    const sp = this.vel.length();
    leg.dur = lerp(TUNE.stepTime[1], TUNE.stepTime[0], clamp(sp / 3, 0, 1)) * (0.94 + Math.random() * 0.12);
    const g = this.idealFoot(leg, leg.dur, leg.goal);
    if (sp > 0.05) {
      const lead = clamp(sp * (leg.dur * 0.5 + 3.5), 0, 15);
      g.x += (this.vel.x / sp) * lead;
      g.z += (this.vel.y / sp) * lead;
    }
    g.x += (Math.random() - 0.5) * 3;
    g.z += (Math.random() - 0.5) * 3;
    this.avoidPlayer(g);
    g.y = this.groundHeight(g.x, g.z);
    if (g.y > TUNE.tallRoof) this.findLowerPlant(g);
    leg.from.copy(leg.foot);
    leg.to.copy(g);
    const dx = g.x - leg.from.x, dz = g.z - leg.from.z;
    const dist = Math.hypot(dx, dz);
    leg.dirX = dist > 1e-3 ? dx / dist : 0;
    leg.dirZ = dist > 1e-3 ? dz / dist : 0;
    // High arc, and enough clearance over whatever is between the two spots.
    const midY = this.groundHeight((g.x + leg.from.x) / 2, (g.z + leg.from.z) / 2);
    leg.arc = Math.max(clamp(10 + dist * 0.45, 11, 24), midY - Math.max(g.y, leg.from.y) + 8);
    leg.swing = true;
    leg.t = 0;
    leg.boxPending = false;
    this.clearNeedleBox(leg);
    this.lastLift = this.time;
  }

  // Very tall roofs make the leg fold awkwardly: look around for a lower spot.
  findLowerPlant(g) {
    const x0 = g.x, z0 = g.z;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + this.time;
      const r = 9 + (k % 2) * 7;
      const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      const y = this.groundHeight(x, z);
      if (y < g.y - 4) {
        _a.set(x, y, z);
        if (this.avoidPlayer(_a)) continue;
        g.set(x, y, z);
        if (y <= TUNE.tallRoof) return;
      }
    }
  }

  onFootfall(leg) {
    const game = this.game;
    const p = leg.foot;
    const pl = game.player?.position;
    const d = pl ? Math.hypot(p.x - pl.x, p.z - pl.z) : 300;
    const intensity = d <= 40 ? 1 : clamp(Math.pow(40 / d, 1.15), 0.02, 1);
    this.footfalls++;
    game.bus?.emit('leviathan:footfall', { pos: p.clone(), intensity });
    const st = game.state;
    if (st === 'playing' || st === 'caught' || st === 'won') game.player?.addShake?.(0.35 * intensity);
    game.atmosphere?.onFootfall?.(intensity);
    const peak = TUNE.maskPeak * intensity;
    if (peak >= this.footMask) {
      this.footMaskPeak = peak;
      this.footMaskAge = 0;
    }
    this.model.burstDust(p, clamp(0.4 + intensity, 0, 1), this.time);
    this.joltVel -= 0.9;
  }

  // Leg IK: hip -> knee (up and out, harvestman style) -> bowed shin -> ankle -> needle foot.
  poseLeg(leg) {
    const H = leg.hip, F = leg.foot;
    const a = LEG_LENGTHS.femur, b = LEG_LENGTHS.tibia;
    const dmin = b - a + 3, dmax = a + b - 3;
    // Below ~106 m the knee can only fold inward over the body, so keep the ankle at least
    // that far from the hip (feet on tall roofs and high in the swing kick the needle out).
    const dsoft = 106;
    // Needle: mostly vertical, leaning toward the hip; trails behind the foot mid-swing.
    let hx = H.x - F.x, hz = H.z - F.z;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    let sx = 0, sz = 0;
    if (leg.swing) {
      const w = Math.sin(Math.PI * leg.t);
      sx = -leg.dirX * 0.6 * w;
      sz = -leg.dirZ * 0.6 * w;
    }
    // Tilt the needle (never stretch it) until the ankle is inside the reachable shell.
    const A = leg.ankle;
    let lean = 0.3;
    for (let it = 0; it < 14; it++) {
      _q.set(hx * lean + sx, 1, hz * lean + sz).normalize();
      A.copy(F).addScaledVector(_q, LEG_LENGTHS.needle);
      const d0 = A.distanceTo(H);
      if (d0 < dsoft && lean > -3) lean -= 0.25;
      else if (d0 > dmax && lean < 1.6) lean += 0.3;
      else break;
    }
    _d.subVectors(A, H);
    let d = _d.length();
    if (d > dmax) A.copy(H).addScaledVector(_d, dmax / d); // last resort: the leg cannot reach
    d = clamp(d, dmin, dmax);
    _d.normalize();

    // Pole: up and outward (toward the leg's ideal foot direction).
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const fx = leg.def.foot[0], fz = leg.def.foot[1];
    const fl = Math.hypot(fx, fz) || 1;
    _pole.set((fx * c + fz * s) / fl * 0.55, 1, (-fx * s + fz * c) / fl * 0.55);
    _p.copy(_pole).addScaledVector(_d, -_pole.dot(_d)).normalize();
    const x = (a * a - b * b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    leg.knee.copy(H).addScaledVector(_d, x).addScaledVector(_p, h);

    // Mid-shin joint, bowed outward a little.
    _b.subVectors(A, leg.knee).normalize();
    _p.copy(_pole).addScaledVector(_b, -_pole.dot(_b)).normalize();
    leg.mid.addVectors(leg.knee, A).multiplyScalar(0.5).addScaledVector(_p, 3.4);
  }

  commitLegs() {
    const m = this.model;
    const set = LeviathanModel.setSegment;
    const jp = m.jointPos;
    for (const leg of this.legs) {
      const i = leg.index;
      set(m.femurs, i, leg.hip, leg.knee, LEG_LENGTHS.femur);
      set(m.tibias, i * 2, leg.knee, leg.mid, TIBIA_HALF);
      set(m.tibias, i * 2 + 1, leg.mid, leg.ankle, TIBIA_HALF, 0.82);
      set(m.needles, i, leg.ankle, leg.foot, LEG_LENGTHS.needle);
      jp.set([leg.knee.x, leg.knee.y, leg.knee.z, leg.mid.x, leg.mid.y, leg.mid.z, leg.ankle.x, leg.ankle.y, leg.ankle.z], i * 9);
    }
    m.femurs.instanceMatrix.needsUpdate = true;
    m.tibias.instanceMatrix.needsUpdate = true;
    m.needles.instanceMatrix.needsUpdate = true;
    m.jointLights.geometry.attributes.position.needsUpdate = true;
  }

  // ------------------------------------------------------------------ the call

  updateCall(dt) {
    const game = this.game;
    const L = CONFIG.leviathan ?? {};
    const duration = L.callDuration ?? 4.6;
    const near = this.currentZone()?.leviathan?.calls === 'near';
    if (near !== this.wasNear) {
      this.wasNear = near;
      if (near && !this.calling) this.callTimer = Math.min(this.callTimer, randIn(L.callIntervalNear, [10, 13]) * 0.4);
    }
    if (this.calling) {
      this.callTime += dt;
      this.callProgress = clamp(this.callTime / duration, 0, 1);
      if (this.callTime >= duration) this.endCall();
    } else {
      this.callTimer -= dt;
      if (this.callTimer <= 0) this.startCall(duration);
    }
    const ct = this.callTime;
    this.callEnvelope = this.calling ? smoothstep(0, 0.7, ct) * (1 - smoothstep(duration - 1.0, duration, ct)) : 0;
    game.atmosphere?.setCall?.(this.callEnvelope);
  }

  startCall(duration) {
    this.calling = true;
    this.callTime = 0;
    this.callProgress = 0;
    this.calls++;
    this.game.bus?.emit('leviathan:call:start', { pos: this.headPosition.clone(), duration });
  }

  // Intervals in CONFIG are start-to-start; the silence after a call is the remainder (>= 4 s).
  endCall() {
    const L = CONFIG.leviathan ?? {};
    const duration = L.callDuration ?? 4.6;
    const near = this.currentZone()?.leviathan?.calls === 'near';
    const interval = near ? randIn(L.callIntervalNear, [10, 13]) : randIn(L.callIntervalCalm, [32, 48]);
    this.calling = false;
    this.callTime = 0;
    this.callProgress = 0;
    this.callEnvelope = 0;
    this.callTimer = Math.max(4, interval - duration);
    this.game.bus?.emit('leviathan:call:end', { pos: this.headPosition.clone() });
  }

  // ------------------------------------------------------------------ head, shaders

  updateHead(dt) {
    const t = this.time;
    let yawT = (noise1(t * 0.045, 3.1) - 0.5) * 1.5;
    let pitchT = (noise1(t * 0.06, 8.7) - 0.5) * 0.45;
    const pl = this.game.player?.position;
    if (pl && this.game.state !== 'title') {
      // It drifts its blind face toward the living when they are close.
      const dx = pl.x - this.position.x, dz = pl.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      const w = (1 - smoothstep(60, 260, dist)) * 0.45;
      const rel = clamp(angleDiff(this.yaw, dirToYaw(dx, dz)), -0.9, 0.9);
      yawT = lerp(yawT, rel, w);
      pitchT = lerp(pitchT, -0.12, w * 0.6);
    }
    const env = this.callEnvelope;
    if (this.calling) {
      pitchT = lerp(pitchT, 1.45, env);
      yawT *= 1 - 0.7 * env;
    }
    const n = this.neck;
    n.yaw = damp(n.yaw, yawT, 0.5, dt);
    n.pitch = damp(n.pitch, pitchT, this.calling ? 1.4 : 0.45, dt);
    const jawT = this.calling ? env * (0.7 + 0.12 * Math.sin(t * 7.3)) : 0.04 + 0.05 * noise1(t * 0.3, 5);
    n.jaw = damp(n.jaw, jawT, 2.5, dt);
    this.uniforms.uNeck.value.set(n.yaw, n.pitch, n.jaw);
    this.updateHeadPosition();
  }

  // World position of the head (the neck bend matches the shader's at full bend weight).
  updateHeadPosition() {
    const n = this.neck;
    this.headPosition.copy(this.model.headTip).sub(NECK_PIVOT)
      .applyAxisAngle(AXIS_X, n.pitch).applyAxisAngle(UP, n.yaw)
      .add(NECK_PIVOT).applyMatrix4(this.model.body.matrixWorld);
  }

  updateUniforms() {
    const U = this.uniforms;
    const game = this.game;
    const env = this.callEnvelope;
    U.uTime.value = this.time;
    U.uCall.value = env;
    U.uShudder.value = env * env;
    U.uGlow.value = 1 + 1.6 * env + 0.6 * this.footMask;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    U.uDrift.value.set(this.vel.x * c - this.vel.y * s, 0, this.vel.x * s + this.vel.y * c);

    // Fog: follow whatever the atmosphere currently uses (it may swap or animate the fog).
    const atm = game.atmosphere;
    const fog = game.scene?.fog;
    const fogColor = atm?.fogColor?.isColor ? atm.fogColor : fog?.color?.isColor ? fog.color : null;
    let density = 0.012;
    if (fog?.isFogExp2) density = fog.density;
    else if (typeof atm?.fogDensity === 'number') density = atm.fogDensity;
    else if (fog?.isFog) density = 2.2 / Math.max(50, fog.far || 300);
    if (fogColor) {
      U.uMistColor.value.copy(fogColor);
      U.uFogColor.value.copy(fogColor).multiplyScalar(this.silhouetteTint);
    }
    U.uMistDensity.value = density;
    U.uFogDensity.value = clamp(density * 0.16, 0.0011, 0.003);
    const glow = atm?.skyGlowColor?.isColor ? atm.skyGlowColor : fogColor;
    if (glow) U.uSky.value.copy(glow).multiplyScalar(0.5);

    const cam = game.camera;
    const r = game.renderer;
    if (cam?.isPerspectiveCamera && r?.getDrawingBufferSize) {
      const h = r.getDrawingBufferSize(_v2).y || 720;
      const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
      U.uPixelScale.value = scale;
      U.uPixelWorld.value = 1 / scale;
    }
  }

  get silhouetteTint() {
    return 0.62;
  }
}
