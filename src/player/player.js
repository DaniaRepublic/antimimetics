import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, lerp } from '../core/math.js';

const P = CONFIG.player;
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _v = new THREE.Vector3();

// First-person controller. Owns movement, stance, stamina, footstep noise, interaction,
// throwing and the camera transform (including bob and shake).
export class Player {
  constructor(game) {
    this.game = game;
    this.position = new THREE.Vector3(); // feet
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.eyeHeight = P.eyeStand;
    this.crouched = false;
    this.sprinting = false;
    this.mode = 'idle'; // 'idle' | 'crouch' | 'walk' | 'sprint' (crouch = moving while crouched)
    this.speed = 0;
    this.stamina = 1;
    this.exhausted = false;
    this.staminaCooldown = 0;
    this.bottles = 0;
    this.lightLevel = 0.2;
    this.stepDistance = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.breathTimer = 0;
    this.throwCooldown = 0;
    this.trauma = 0; // camera shake 0..1
    this.shakeTime = 0;
    this.focus = null; // interactable currently in reach
    this.holdProgress = 0; // 0..1 for hold-to-interact
    this.controlsEnabled = true;
    this.fovKick = 0;
  }

  spawn(pos, yaw = 0) {
    this.position.set(pos.x, 0, pos.z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.crouched = false;
    this.sprinting = false;
    this.eyeHeight = P.eyeStand;
    this.stamina = 1;
    this.exhausted = false;
    this.trauma = 0;
    this.holdProgress = 0;
    this.mode = 'idle';
    this.speed = 0;
  }

  get isMoving() {
    return this.speed > 0.4;
  }

  // Points snatchers test line of sight against (head and chest).
  getEyePos(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  getChestPos(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight * 0.62, this.position.z);
  }

  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  addShake(amount) {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  update(dt) {
    const { input } = this.game;
    const enabled = this.controlsEnabled;

    // --- look
    const look = input.consumeLook();
    if (enabled) {
      const sens = P.lookSensitivity * (this.game.settings?.sensitivity ?? 1);
      this.yaw -= look.dx * sens;
      this.pitch = clamp(this.pitch - look.dy * sens, -1.45, 1.45);
    }

    // --- stance
    if (enabled && input.pressed('KeyC')) this.crouched = !this.crouched;
    let mx = 0, mz = 0;
    if (enabled) {
      if (input.down('KeyW') || input.down('ArrowUp')) mz += 1;
      if (input.down('KeyS') || input.down('ArrowDown')) mz -= 1;
      if (input.down('KeyD') || input.down('ArrowRight')) mx += 1;
      if (input.down('KeyA') || input.down('ArrowLeft')) mx -= 1;
    }
    const wantsMove = mx !== 0 || mz !== 0;
    const wantsSprint = enabled && wantsMove && mz > 0 && (input.down('ShiftLeft') || input.down('ShiftRight'));
    this.sprinting = wantsSprint && !this.exhausted && this.stamina > 0.02;
    if (this.sprinting && this.crouched) this.crouched = false;

    // --- stamina
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - P.sprintDrain * dt);
      this.staminaCooldown = P.staminaRegenDelay;
      if (this.stamina <= 0.02) {
        this.exhausted = true;
        this.game.bus.emit('player:exhausted', {});
      }
    } else {
      this.staminaCooldown -= dt;
      if (this.staminaCooldown <= 0) this.stamina = Math.min(1, this.stamina + P.staminaRegen * dt);
      if (this.exhausted && this.stamina >= P.exhaustedThreshold) this.exhausted = false;
    }

    // --- movement
    const maxSpeed = this.sprinting ? P.sprintSpeed : this.crouched ? P.crouchSpeed : P.walkSpeed;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(-_fwd.z, 0, _fwd.x);
    _wish.set(0, 0, 0).addScaledVector(_fwd, mz).addScaledVector(_right, mx);
    if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(maxSpeed);
    const k = 1 - Math.exp(-P.accel * dt);
    this.velocity.x += (_wish.x - this.velocity.x) * k;
    this.velocity.z += (_wish.z - this.velocity.z) * k;

    const before = _v.copy(this.position);
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.game.world.resolveCircle(this.position, P.radius, { height: this.crouched ? 1.15 : 1.8 });
    const moved = Math.hypot(this.position.x - before.x, this.position.z - before.z);
    this.speed = dt > 0 ? moved / dt : 0;
    // Kill velocity we could not realise (walking into walls) so we don't "stick".
    if (dt > 0 && moved < Math.hypot(this.velocity.x, this.velocity.z) * dt * 0.5) {
      this.velocity.x = (this.position.x - before.x) / dt;
      this.velocity.z = (this.position.z - before.z) / dt;
    }

    this.mode = !this.isMoving ? 'idle' : this.sprinting ? 'sprint' : this.crouched ? 'crouch' : 'walk';

    // --- footsteps -> noise
    this.stepDistance += moved;
    const stride = this.mode === 'sprint' ? 1.35 : this.mode === 'crouch' ? 0.7 : 0.95;
    if (this.isMoving && this.stepDistance >= stride) {
      this.stepDistance = 0;
      const radius = this.mode === 'sprint' ? CONFIG.noise.sprintStep : this.mode === 'crouch' ? CONFIG.noise.crouchStep : CONFIG.noise.walkStep;
      this.emitNoise(radius, this.mode === 'sprint' ? 0.8 : this.mode === 'crouch' ? 0.15 : 0.4);
      this.game.bus.emit('player:footstep', { mode: this.mode, pos: this.position.clone() });
    }
    if (this.exhausted) {
      this.breathTimer -= dt;
      if (this.breathTimer <= 0) {
        this.breathTimer = 1.3;
        this.emitNoise(CONFIG.noise.landExhausted, 0.2);
        this.game.bus.emit('player:breath', { pos: this.position.clone() });
      }
    }

    // --- stance height
    const targetEye = this.crouched ? P.eyeCrouch : P.eyeStand;
    this.eyeHeight = damp(this.eyeHeight, targetEye, 10, dt);

    // --- light level (for stealth); the atmosphere owns the light registry
    this.lightLevel = this.game.atmosphere.lightLevelAt(this.position);

    // --- interaction + throwing
    this.throwCooldown -= dt;
    if (enabled) {
      this.updateInteraction(dt);
      const throwPressed = (input.locked && input.mousePressed(0)) || input.pressed('KeyF') || input.pressed('KeyQ');
      if (throwPressed) this.tryThrow();
    } else {
      this.focus = null;
      this.holdProgress = 0;
    }

    // --- camera feel
    const speedNorm = clamp(this.speed / P.sprintSpeed, 0, 1);
    this.bobAmount = damp(this.bobAmount, this.isMoving ? lerp(0.35, 1, speedNorm) : 0, 8, dt);
    this.bobPhase += dt * (this.mode === 'sprint' ? 11.5 : this.mode === 'crouch' ? 6 : 8.2) * (this.isMoving ? 1 : 0.0);
    this.fovKick = damp(this.fovKick, this.sprinting ? 1 : 0, 4, dt);
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
    this.shakeTime += dt;
  }

  emitNoise(radius, loudness) {
    const mask = this.game.noiseMask || 0;
    const r = radius * (1 - CONFIG.noise.maskStrength * mask);
    this.game.bus.emit('noise', {
      pos: this.position.clone(),
      radius: r,
      loudness,
      source: 'player',
    });
  }

  updateInteraction(dt) {
    const list = this.game.level.interactables;
    const fwd = this.forward(_fwd);
    let best = null;
    let bestScore = Infinity;
    for (const it of list) {
      if (!it.enabled) continue;
      const dx = it.pos.x - this.position.x;
      const dz = it.pos.z - this.position.z;
      const d = Math.hypot(dx, dz);
      const range = it.range ?? P.interactRange;
      if (d > range) continue;
      const facing = d < 0.01 ? 1 : (dx * fwd.x + dz * fwd.z) / (d * Math.hypot(fwd.x, fwd.z) || 1);
      if (facing < 0.35 && d > 1.0) continue;
      const score = d * (1.6 - facing);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (best !== this.focus) this.holdProgress = 0;
    this.focus = best;
    if (!best) return;
    const hold = best.holdTime || 0;
    if (hold > 0) {
      if (this.game.input.down('KeyE')) {
        if (this.holdProgress === 0) best.onHoldStart?.(this.game);
        this.holdProgress = Math.min(1, this.holdProgress + dt / hold);
        if (this.holdProgress >= 1) {
          this.holdProgress = 0;
          best.onInteract(this.game);
        }
      } else if (this.holdProgress > 0) {
        this.holdProgress = 0;
        best.onHoldCancel?.(this.game);
      }
    } else if (this.game.input.pressed('KeyE')) {
      best.onInteract(this.game);
    }
  }

  tryThrow() {
    if (this.bottles <= 0 || this.throwCooldown > 0) {
      if (this.bottles <= 0) this.game.bus.emit('player:throw-empty', {});
      return;
    }
    this.throwCooldown = 0.6;
    this.bottles--;
    const origin = this.getEyePos(new THREE.Vector3());
    const fwd = this.forward(new THREE.Vector3());
    origin.addScaledVector(fwd, 0.4);
    origin.y -= 0.15;
    const vel = fwd.clone().multiplyScalar(P.throwSpeed);
    vel.y += P.throwUp;
    vel.x += this.velocity.x * 0.5;
    vel.z += this.velocity.z * 0.5;
    this.game.projectiles.throwBottle(origin, vel);
    this.game.bus.emit('player:throw', { pos: origin.clone() });
  }

  // Writes the camera transform for this frame.
  applyCamera(camera) {
    const bob = this.bobAmount;
    const bx = Math.cos(this.bobPhase * 0.5) * 0.035 * bob;
    const by = Math.abs(Math.sin(this.bobPhase * 0.5)) * 0.05 * bob;
    const t = this.shakeTime;
    const tr = this.trauma * this.trauma;
    const sx = (Math.sin(t * 37.1) + Math.sin(t * 23.3 + 1.2)) * 0.5 * tr * 0.12;
    const sy = (Math.sin(t * 41.7 + 0.5) + Math.sin(t * 19.1 + 2.1)) * 0.5 * tr * 0.12;
    camera.position.set(
      this.position.x + _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).x * bx + sx,
      this.position.y + this.eyeHeight + by - 0.025 * bob + sy,
      this.position.z + _right.z * bx,
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.y = this.yaw + Math.sin(t * 29.3) * tr * 0.02;
    camera.rotation.x = this.pitch + Math.sin(t * 31.9 + 0.7) * tr * 0.02;
    camera.rotation.z = Math.sin(this.bobPhase * 0.5) * 0.004 * bob + Math.sin(t * 17.3) * tr * 0.03;
    const baseFov = this.game.settings?.fov ?? 72;
    const fov = baseFov + this.fovKick * 5;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
