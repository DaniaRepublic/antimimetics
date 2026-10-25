import * as THREE from 'three';

// STUB - replaced by the AI module. See ARCHITECTURE.md.
export class Snatcher {
  constructor(game, def) {
    this.game = game;
    this.def = def;
    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.state = 'patrol';
    this.detection = 0;
    this.root = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.4), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    game.scene.add(this.root);
    this.reset();
  }

  reset() {
    this.position.set(this.def.pos.x, 0, this.def.pos.z);
    this.yaw = this.def.yaw || 0;
    this.routeIndex = 0;
  }

  getHeadPos(out = new THREE.Vector3()) {
    return out.set(this.position.x, 1.9, this.position.z);
  }

  getEyePos(out = new THREE.Vector3()) {
    return out.set(this.position.x, 1.95, this.position.z);
  }

  update(dt) {
    const route = this.def.route;
    if (route) {
      const t = route[this.routeIndex];
      const dx = t.x - this.position.x, dz = t.z - this.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.3) this.routeIndex = (this.routeIndex + 1) % route.length;
      else {
        this.position.x += (dx / d) * 1.2 * dt;
        this.position.z += (dz / d) * 1.2 * dt;
        this.yaw = Math.atan2(-dx, -dz);
      }
    }
    this.root.position.set(this.position.x, 0.9, this.position.z);
    this.root.rotation.y = this.yaw;
  }
}
