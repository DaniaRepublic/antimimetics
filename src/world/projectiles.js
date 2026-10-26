import * as THREE from 'three';
import { CONFIG } from '../config.js';

const GRAVITY = 9.8;
// Alarm cars are big, obvious targets: a bottle that skims within this much of the body (sides
// and roof) counts as a hit, so a throw aimed at the car never sails just over the roof.
const ALARM_PAD = 0.6;
const ALARM_PAD_Y = 0.9;
const _dir = new THREE.Vector3();

// The alarm car (collider with data.alarmCar) whose padded box contains p, if any (`skip` excepted).
function alarmCarAt(world, p, skip = null) {
  const pad = ALARM_PAD;
  for (const col of world.query(p.x - pad, p.z - pad, p.x + pad, p.z + pad)) {
    if (!col.enabled || !col.data?.alarmCar || col === skip) continue;
    if (p.y > col.maxY + ALARM_PAD_Y) continue;
    const dx = p.x - col.cx, dz = p.z - col.cz;
    const lx = col.cos * dx - col.sin * dz;
    const lz = col.sin * dx + col.cos * dz;
    if (Math.abs(lx) <= col.hx + pad && Math.abs(lz) <= col.hz + pad) return col;
  }
  return null;
}

function makeBottleGeometry() {
  const pts = [
    [0.0, 0.0], [0.035, 0.0], [0.038, 0.01], [0.038, 0.16], [0.03, 0.19],
    [0.013, 0.22], [0.012, 0.28], [0.014, 0.285], [0.0, 0.285],
  ].map(([x, y]) => new THREE.Vector2(x, y - 0.14));
  return new THREE.LatheGeometry(pts, 10);
}

// Thrown bottles: ballistic flight, shatter on contact, emit a noise the snatchers can hear.
export class Projectiles {
  constructor(game) {
    this.game = game;
    this.items = [];
    this.shards = [];
    this.geometry = makeBottleGeometry();
    this.material = new THREE.MeshStandardMaterial({
      color: 0x2f4a2a, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.85,
    });
    this.shardGeometry = new THREE.TetrahedronGeometry(0.025);
    this.shardMaterial = new THREE.MeshStandardMaterial({ color: 0x5c7a52, roughness: 0.2 });
  }

  // Exposed so the level can reuse the same look for pickups.
  createBottleMesh() {
    const m = new THREE.Mesh(this.geometry, this.material);
    m.castShadow = false;
    return m;
  }

  throwBottle(origin, velocity) {
    const mesh = this.createBottleMesh();
    mesh.position.copy(origin);
    this.game.scene.add(mesh);
    this.items.push({
      mesh,
      pos: origin.clone(),
      vel: velocity.clone(),
      spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 4, Math.random() * 12 - 6),
      age: 0,
      // Thrown from right beside an alarm car (crouched behind it as cover): only a real hit on
      // that car counts, or every throw from there would shatter in your hand and set it off.
      padSkip: alarmCarAt(this.game.world, origin),
    });
  }

  update(dt) {
    const world = this.game.world;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.age += dt;
      p.vel.y -= GRAVITY * dt;
      const step = p.vel.length() * dt;
      _dir.copy(p.vel).normalize();
      const hit = step > 0 ? world.raycast(p.pos, _dir, step, { filter: (c) => c.blocksMove || c.blocksSight }) : null;
      let impact = null;
      let collider = null;
      if (hit) {
        impact = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z).addScaledVector(_dir, -0.05);
        collider = hit.collider;
      } else {
        p.pos.addScaledVector(p.vel, dt);
        const car = alarmCarAt(world, p.pos, p.padSkip);
        if (car) {
          impact = p.pos.clone().setY(Math.min(p.pos.y, car.maxY));
          collider = car;
        } else if (p.pos.y <= 0.03) impact = p.pos.clone().setY(0.03);
      }
      if (impact || p.age > 6) {
        this.shatter(impact || p.pos, collider);
        this.game.scene.remove(p.mesh);
        this.items.splice(i, 1);
        continue;
      }
      p.mesh.position.copy(p.pos);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
    }

    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      if (s.pos.y > 0.01) {
        s.vel.y -= GRAVITY * dt;
        s.pos.addScaledVector(s.vel, dt);
        if (s.pos.y < 0.01) {
          s.pos.y = 0.01;
          s.vel.set(0, 0, 0);
        }
        s.mesh.rotation.x += dt * 9;
        s.mesh.rotation.z += dt * 7;
      }
      s.mesh.position.copy(s.pos);
      if (s.life <= 0) {
        this.game.scene.remove(s.mesh);
        this.shards.splice(i, 1);
      }
    }
  }

  shatter(pos, collider) {
    const p = new THREE.Vector3(pos.x, Math.max(0.03, pos.y), pos.z);
    for (let k = 0; k < 10; k++) {
      const mesh = new THREE.Mesh(this.shardGeometry, this.shardMaterial);
      mesh.position.copy(p);
      this.game.scene.add(mesh);
      this.shards.push({
        mesh,
        pos: p.clone(),
        vel: new THREE.Vector3(Math.random() * 4 - 2, Math.random() * 2.5 + 0.5, Math.random() * 4 - 2),
        life: 8 + Math.random() * 4,
      });
    }
    this.game.bus.emit('bottle:shatter', { pos: p.clone(), collider });
    this.game.bus.emit('noise', { pos: p.clone(), radius: CONFIG.noise.bottle, loudness: 1, source: 'bottle' });
  }

  clear() {
    for (const p of this.items) this.game.scene.remove(p.mesh);
    for (const s of this.shards) this.game.scene.remove(s.mesh);
    this.items.length = 0;
    this.shards.length = 0;
  }
}
