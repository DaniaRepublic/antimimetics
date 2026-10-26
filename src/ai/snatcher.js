import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { angleDiff, clamp, damp, dirToYaw, stepAngle } from '../core/math.js';
import { Brain } from './brain.js';
import { createSnatcherModel } from './snatcherModel.js';

const E = CONFIG.enemy;
const HEAD_YAW_MAX = (80 * Math.PI) / 180;
const WAYPOINT_RADIUS = 0.5;
const SEPARATION_SPEED = 1.3; // m/s at full overlap
const STUCK_WINDOW = 1.5;
const STUCK_PROGRESS = 0.35;
const LONG_TRIP = 40; // metres: a failed search longer than this is retried in hops
const MAX_HOPS = 16;
const HOP_IMMEDIATELY = 90;
const CULL_DISTANCE = 140; // beyond this the mist hides them anyway

function seedFrom(id, index) {
  let h = 2166136261 ^ index;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// A snatcher's body: position, path following, turning, independent head aim, footsteps, and the
// visual model. All decisions come from its Brain (src/ai/brain.js).
export class Snatcher {
  constructor(game, def, index = 0, director = null) {
    this.game = game;
    this.def = def;
    this.index = index;
    this.director = director;
    this.id = def.id ?? `snatcher_${index}`;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0; // commanded speed (m/s)
    this.actualSpeed = 0; // realised speed after collisions (m/s)
    this.headYaw = 0; // relative to the body, + = left
    this.headPitch = 0; // + = up
    this.slump = 0;
    this.turnMul = 1;
    this.chasing = false;
    this.active = true;
    this.queued = false;
    this.sepX = 0;
    this.sepZ = 0;
    this.stuckEvents = 0;
    this.model = createSnatcherModel(seedFrom(this.id, index));
    this.root = this.model.root;
    game.scene.add(this.root);
    // Footsteps: if the model reports its foot plants (optional onStep hook), step sounds land
    // exactly when a foot visibly hits the ground; otherwise fall back to one per ~1.3 m walked.
    this.modelSteps = 'onStep' in this.model;
    if (this.modelSteps) this.model.onStep = () => this.footPlanted();
    this.lastStepAt = -1e9;
    this.anim = { speed: 0, mode: 'idle', headYaw: 0, headPitch: 0, alert: 0, time: 0, slump: 0 };
    this.brain = new Brain(this, game, director);
    this.reset();
  }

  get state() {
    return this.brain.state;
  }

  get detection() {
    return this.brain.detection;
  }

  reset() {
    const p = this.def.pos || { x: 0, z: 0 };
    this.position.set(p.x, 0, p.z);
    this.velocity.set(0, 0, 0);
    this.yaw = this.def.yaw ?? 0;
    this.speed = 0;
    this.actualSpeed = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.slump = this.def.sleeping ? 1 : 0;
    this.hold = false; // brain-set: keep the errand but don't move (e.g. still waking up)
    this.goal = null;
    this.path = null;
    this.pathIndex = 0;
    this.pathPending = false;
    this.pathFailed = false;
    this.arrived = true;
    this.moveSpeed = 0;
    this.arriveDist = 0.5;
    this.brake = true;
    this.clearHops();
    this.cacheKey = null;
    this.faceYaw = null;
    this.dirX = 0;
    this.dirZ = 0;
    this.lookMode = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.lookZ = 0;
    this.lookRate = 4;
    this.twitchTime = 0;
    this.twitchYaw = 0;
    this.twitchPitch = 0;
    this.stride = 0;
    this.stuckClock = 0;
    this.stuckX = p.x;
    this.stuckZ = p.z;
    this.stuckCount = 0;
    this.animAccum = 0;
    this.brain.reset();
    this.syncRoot();
    this.animate(0);
  }

  getHeadPos(out = new THREE.Vector3()) {
    if (this.model.headAnchor) return this.model.headAnchor.getWorldPosition(out);
    return out.set(this.position.x, 2.05, this.position.z);
  }

  getEyePos(out = new THREE.Vector3()) {
    const a = this.yaw + this.headYaw;
    return out.set(
      this.position.x - Math.sin(a) * 0.12,
      E.eyeHeight - this.slump * 0.55,
      this.position.z - Math.cos(a) * 0.12,
    );
  }

  // --- steering API used by the brain ------------------------------------------

  // Walk to (x, z). Straight line when the nav grid allows it, otherwise a queued A* path.
  go(x, z, speed, arrive = 0.5, { cacheKey = null, force = false, brake = true } = {}) {
    this.moveSpeed = speed;
    this.arriveDist = arrive;
    this.brake = brake;
    this.faceYaw = null;
    const g = this.goal;
    if (!force && g && Math.abs(g.x - x) < 0.3 && Math.abs(g.z - z) < 0.3 && (this.path || this.pathPending || this.arrived)) return;
    if (g && Math.hypot(g.x - x, g.z - z) > 3) this.path = null; // a different errand: drop the old route
    this.goal = { x, z };
    this.arrived = false;
    this.pathFailed = false;
    this.cacheKey = cacheKey;
    this.clearHops();
    const pos = this.position;
    if (Math.hypot(x - pos.x, z - pos.z) < arrive) {
      this.path = null;
      this.pathPending = false;
      this.arrived = true;
      return;
    }
    if (!force) {
      const end = this.canWalkDirect(x, z);
      if (end) {
        this.setPath([end]);
        return;
      }
      // A cached leg is only good from (near) where it was planned: after an errand the snatcher
      // may rejoin its route from anywhere, and following a stale route would walk it into walls.
      const cached = cacheKey && this.director?.pathCache.get(cacheKey);
      if (cached && Math.hypot(cached.from.x - pos.x, cached.from.z - pos.z) < 2) {
        this.setPath(cached.path);
        return;
      }
    }
    // Far beyond what one search can cover: don't pay for a doomed A*, hop straight away.
    if (Math.hypot(x - pos.x, z - pos.z) > HOP_IMMEDIATELY && this.tryHop()) return;
    this.requestPath();
  }

  // The walkable end point if the nav grid allows a straight walk from here to (x, z), else null.
  canWalkDirect(x, z) {
    const nav = this.game.nav;
    const pos = this.position;
    const end = nav.isWalkable(x, z) ? { x, z } : nav.nearestWalkable(x, z, 3);
    const start = nav.isWalkable(pos.x, pos.z) ? pos : nav.nearestWalkable(pos.x, pos.z, 3);
    if (!end || !start || !nav.lineWalkable(start.x, start.z, end.x, end.z)) return null;
    return end;
  }

  // Metres left along the current path (0 without one).
  remainingPathLength() {
    const path = this.path;
    if (!path) return 0;
    let px = this.position.x, pz = this.position.z, len = 0;
    for (let i = this.pathIndex; i < path.length; i++) {
      len += Math.hypot(path[i].x - px, path[i].z - pz);
      px = path[i].x;
      pz = path[i].z;
    }
    return len;
  }

  setPath(path) {
    this.path = path;
    this.pathIndex = 0;
    this.pathPending = false;
    this.pathFailed = false;
  }

  requestPath() {
    this.pathPending = true;
    if (this.director) this.director.requestPath(this);
    else this.receivePath(this.game.nav.findPath(this.position, this.goal));
  }

  // Called by the director's throttled path queue.
  receivePath(path) {
    if (!this.pathPending) return;
    this.pathPending = false;
    if (!path || !path.length) {
      if (this.tryHop()) return;
      this.clearHops();
      this.path = null;
      this.pathFailed = true;
      return;
    }
    if (!this.onHop) this.hopFinal = null; // this is the leg that reaches the real goal
    if (this.cacheKey) this.director?.pathCache.set(this.cacheKey, { from: { x: this.position.x, z: this.position.z }, path });
    this.setPath(path);
  }

  // A very long trip (e.g. home after a long chase) can exceed the path-finder's search budget.
  // Walk toward the goal in same-region hops of up to ~45 m, re-planning the whole way at each.
  tryHop() {
    const final = this.hopFinal || this.goal;
    const pos = this.position;
    if (!final || this.hops >= MAX_HOPS) return false;
    const dx = final.x - pos.x, dz = final.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < LONG_TRIP) return false;
    const nav = this.game.nav;
    const here = nav.nearestWalkable(pos.x, pos.z, 4);
    if (!here) return false;
    const step = Math.min(d * 0.5, 45) * (this.onHop ? 0.5 : 1); // a failed hop tries a shorter one
    for (const side of [0, 7, -7, 14, -14]) {
      const px = pos.x + (dx / d) * step - (dz / d) * side;
      const pz = pos.z + (dz / d) * step + (dx / d) * side;
      const m = nav.nearestWalkable(px, pz, 10);
      if (!m || !nav.sameRegion(here.x, here.z, m.x, m.z)) continue;
      this.hopFinal = { x: final.x, z: final.z, arrive: this.hopFinal?.arrive ?? this.arriveDist };
      this.onHop = true;
      this.hops++;
      this.cacheKey = null;
      this.goal = { x: m.x, z: m.z };
      this.requestPath();
      return true;
    }
    return false;
  }

  clearHops() {
    this.hopFinal = null;
    this.onHop = false;
    this.hops = 0;
  }

  halt() {
    this.clearHops();
    this.goal = null;
    this.path = null;
    this.pathPending = false;
    this.pathFailed = false;
    this.arrived = true;
  }

  face(yaw) {
    this.faceYaw = yaw;
  }

  lookAt(x, y, z, rate = 6) {
    this.lookMode = 1;
    this.lookX = x;
    this.lookY = y;
    this.lookZ = z;
    this.lookRate = rate;
  }

  lookRel(yaw, pitch, rate = 5) {
    this.lookMode = 2;
    this.lookX = yaw;
    this.lookY = pitch;
    this.lookRate = rate;
  }

  twitch(yaw, pitch, duration) {
    this.twitchTime = duration;
    this.twitchYaw = yaw;
    this.twitchPitch = pitch;
  }

  // --- per-frame -------------------------------------------------------------------

  update(dt) {
    if (dt <= 0) return;
    this.brain.update(dt);
    this.updateMotion(dt);
    this.updateHead(dt);
    const target = this.brain.slumpTarget;
    const rate = target < this.slump ? 1 / 1.5 : 1 / 2.2;
    this.slump += clamp(target - this.slump, -rate * dt, rate * dt);
    const dist = this.syncRoot();
    // Animation LOD: full rate nearby, 10 Hz far away, nothing at all once hidden by the mist.
    this.tickModel(dt, dist > 50 ? 0.1 : 0);
  }

  // Outside the player's neighbourhood: no thinking, just a slow idle pose.
  updateDormant(dt) {
    this.actualSpeed = 0;
    this.root.visible = this.distanceToPlayer() < CULL_DISTANCE;
    this.tickModel(dt, 0.25);
  }

  tickModel(dt, interval) {
    if (!this.root.visible) {
      this.animAccum = 0;
      return;
    }
    this.animAccum += dt;
    if (this.animAccum >= interval) {
      this.animate(this.animAccum);
      this.animAccum = 0;
    }
  }

  distanceToPlayer() {
    const p = this.game.player?.position;
    return p ? Math.hypot(p.x - this.position.x, p.z - this.position.z) : 0;
  }

  updateMotion(dt) {
    const pos = this.position;
    let targetSpeed = 0;
    let dirX = 0, dirZ = 0;
    let desiredYaw = this.faceYaw ?? this.yaw;
    const path = this.hold ? null : this.path;
    if (path) {
      let wp = path[this.pathIndex];
      let dx = wp.x - pos.x, dz = wp.z - pos.z;
      let d = Math.hypot(dx, dz);
      while (this.pathIndex < path.length - 1 && d < WAYPOINT_RADIUS) {
        wp = path[++this.pathIndex];
        dx = wp.x - pos.x;
        dz = wp.z - pos.z;
        d = Math.hypot(dx, dz);
      }
      const last = this.pathIndex === path.length - 1;
      if (last && d < Math.max(this.arriveDist, 1) && this.onHop) {
        // Reached a hop of a long trip: plan the rest of the way.
        const f = this.hopFinal;
        this.onHop = false;
        this.goal = { x: f.x, z: f.z };
        this.arriveDist = f.arrive;
        this.path = null;
        if (Math.hypot(f.x - pos.x, f.z - pos.z) <= HOP_IMMEDIATELY || !this.tryHop()) this.requestPath();
      } else if (last && d < this.arriveDist) {
        this.path = null;
        this.arrived = true;
      } else if (d > 1e-4) {
        dirX = dx / d;
        dirZ = dz / d;
        desiredYaw = dirToYaw(dx, dz);
        targetSpeed = this.moveSpeed;
        if (last && this.brake) targetSpeed *= clamp(d / 1.0, 0.35, 1);
      }
    }

    // Turn the body; slow down (or turn in place) when facing away from where it wants to go.
    const diff = angleDiff(this.yaw, desiredYaw);
    const turnRate = E.turnSpeed * this.turnMul;
    this.yaw = stepAngle(this.yaw, desiredYaw, Math.min(turnRate, Math.abs(diff) * 7 + 0.4) * dt);
    if (targetSpeed > 0) {
      const align = Math.cos(angleDiff(this.yaw, desiredYaw));
      targetSpeed *= clamp((align - 0.05) / 0.75, 0.06, 1);
    }
    const accel = targetSpeed > this.speed ? (this.chasing ? 7 : 3.5) : 6;
    this.speed = damp(this.speed, targetSpeed, accel, dt);
    if (dirX || dirZ) {
      this.dirX = dirX;
      this.dirZ = dirZ;
    }

    const bx = pos.x, bz = pos.z;
    pos.x += (this.dirX * this.speed + this.sepX * SEPARATION_SPEED) * dt;
    pos.z += (this.dirZ * this.speed + this.sepZ * SEPARATION_SPEED) * dt;
    this.game.world.resolveCircle(pos, E.radius, { height: 2.1 });
    const mx = pos.x - bx, mz = pos.z - bz;
    const moved = Math.hypot(mx, mz);
    this.velocity.set(mx / dt, 0, mz / dt);
    this.actualSpeed = moved / dt;

    // Footsteps for audio (when the model doesn't report its own foot plants).
    if (!this.modelSteps && this.actualSpeed > 0.3) {
      this.stride += moved;
      const strideLen = this.chasing ? 1.7 : 1.3;
      if (this.stride >= strideLen) {
        this.stride -= strideLen;
        this.game.bus.emit('enemy:step', { enemy: this, pos: pos.clone(), chasing: this.chasing });
      }
    }

    // Unstuck: trying to move but making no progress.
    if (this.path && this.moveSpeed > 0.25 && !this.pathPending && !this.hold) {
      this.stuckClock += dt;
      if (this.stuckClock >= STUCK_WINDOW) {
        if (Math.hypot(pos.x - this.stuckX, pos.z - this.stuckZ) < STUCK_PROGRESS) this.handleStuck();
        else this.stuckCount = 0;
        this.stuckClock = 0;
        this.stuckX = pos.x;
        this.stuckZ = pos.z;
      }
    } else {
      this.stuckClock = 0;
      this.stuckX = pos.x;
      this.stuckZ = pos.z;
    }
  }

  footPlanted() {
    const now = this.game.time;
    if (!this.active || this.actualSpeed < 0.2 || now - this.lastStepAt < 0.18) return;
    this.lastStepAt = now;
    this.game.bus.emit('enemy:step', { enemy: this, pos: this.position.clone(), chasing: this.chasing });
  }

  handleStuck() {
    this.stuckCount++;
    this.stuckEvents++;
    if (this.cacheKey) this.director?.pathCache.delete(this.cacheKey);
    const g = this.goal;
    if (this.stuckCount === 1 && g) {
      // Sidestep a little and plan again from where we really are.
      const side = Math.random() < 0.5 ? -1 : 1;
      this.position.x += -this.dirZ * 0.25 * side;
      this.position.z += this.dirX * 0.25 * side;
      this.game.world.resolveCircle(this.position, E.radius, { height: 2.1 });
      this.go(g.x, g.z, this.moveSpeed, this.arriveDist, { force: true, cacheKey: null });
    } else {
      this.stuckCount = 0;
      this.halt();
      this.brain.onStuck();
    }
  }

  updateHead(dt) {
    let ty = 0, tp = 0;
    if (this.lookMode === 1) {
      const dx = this.lookX - this.position.x, dz = this.lookZ - this.position.z;
      ty = angleDiff(this.yaw, dirToYaw(dx, dz));
      tp = Math.atan2(this.lookY - E.eyeHeight, Math.hypot(dx, dz));
    } else if (this.lookMode === 2) {
      ty = this.lookX;
      tp = this.lookY;
    }
    let rate = this.lookRate;
    if (this.twitchTime > 0) {
      this.twitchTime -= dt;
      ty += this.twitchYaw;
      tp += this.twitchPitch;
      rate = Math.max(rate, 22);
    }
    ty = clamp(ty, -HEAD_YAW_MAX, HEAD_YAW_MAX);
    tp = clamp(tp, -1.0, 0.95);
    const k = 1 - Math.exp(-rate * dt);
    this.headYaw += (ty - this.headYaw) * k;
    this.headPitch += (tp - this.headPitch) * k;
  }

  // Moves the visual root to the body; returns the distance to the player.
  syncRoot() {
    this.root.position.set(this.position.x, 0, this.position.z);
    this.root.rotation.y = this.yaw;
    const dist = this.distanceToPlayer();
    this.root.visible = dist < CULL_DISTANCE;
    return dist;
  }

  animMode() {
    const moving = this.actualSpeed > 0.15;
    switch (this.brain.state) {
      case 'suspicious': return 'suspicious';
      case 'investigate': return 'investigate';
      case 'search': return 'search';
      case 'alarm': return 'alarm';
      case 'chase': return 'chase';
      case 'grab': return 'grab';
      case 'rapture': return this.brain.asleep ? 'idle' : 'rapture';
      default: return moving ? 'walk' : 'idle';
    }
  }

  animate(dt) {
    const a = this.anim;
    const st = this.brain.state;
    a.speed = this.actualSpeed;
    a.mode = this.animMode();
    a.headYaw = this.headYaw;
    a.headPitch = this.headPitch;
    a.alert = st === 'chase' || st === 'grab' ? 1 : this.brain.detection;
    a.time = this.game.time + this.index * 1.37;
    a.slump = this.slump;
    this.model.update(dt, a);
  }

  dispose() {
    this.model.dispose?.();
    this.root.removeFromParent();
  }
}
