import * as THREE from 'three';

// STUB - replaced by the level module. See ARCHITECTURE.md for the full contract.
export class Level {
  constructor(game) {
    this.game = game;
    this.bounds = { minX: -40, maxX: 40, minZ: -120, maxZ: 10 };
    this.checkpoints = [{ id: 'start', order: 0, pos: { x: 0, z: 0 }, yaw: 0, bottles: 1, zone: 0 }];
    this.zones = [{ id: 'street', index: 0, name: 'Street', bounds: { minX: -40, maxX: 40, minZ: -120, maxZ: 10 } }];
    this.enemies = [
      { id: 'stub_a', zone: 0, kind: 'patrol', pos: { x: 0, z: -40 }, yaw: 0, route: [{ x: -5, z: -40 }, { x: 5, z: -60 }], pause: 2 },
    ];
    this.interactables = [];
    this.leviathanRoute = [{ x: 80, z: 0 }, { x: 80, z: -200 }];
    this.titleCamera = { pos: [0, 2, 5], target: [0, 4, -40] };
    this.currentZone = 0;
  }

  build() {
    const { scene, world } = this.game;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x222020 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a3535 });
    const add = (x, z, w, d, h, rot = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, h / 2, z);
      m.rotation.y = rot;
      scene.add(m);
      world.addBox({ x, z, w, d, h, rot });
    };
    add(-20, -50, 20, 140, 30);
    add(20, -50, 20, 140, 30);
    add(0, -110, 20, 4, 6);
    add(-3, -25, 2, 4.5, 1.4, 0.3);
    add(4, -35, 2, 4.5, 1.4, -0.2);
  }

  zoneAt() {
    return 0;
  }

  update() {
    const p = this.game.player.position;
    if (p.z < -100) this.game.bus.emit('level:exit', {});
  }

  resetDynamic() {}
}
