import * as THREE from 'three';

// STUB - replaced by the atmosphere module. See ARCHITECTURE.md.
export class Atmosphere {
  constructor(game) {
    this.game = game;
    this.lightSources = [];
    game.scene.background = new THREE.Color(0x3a0d08);
    game.scene.fog = new THREE.FogExp2(0x3a0d08, 0.02);
    game.scene.add(new THREE.HemisphereLight(0xff6040, 0x100505, 1.2));
    this.fogColor = game.scene.fog.color;
    this.skyGlowColor = new THREE.Color(0xff3a1a);
    this.fogDensity = 0.02;
  }

  registerLightSource(src) {
    this.lightSources.push(src);
    return src;
  }

  lightLevelAt(pos) {
    let l = 0.15;
    for (const s of this.lightSources) {
      if (s.enabled === false) continue;
      const d = Math.hypot(pos.x - s.pos.x, pos.z - s.pos.z);
      if (d < s.radius) l += (1 - d / s.radius) * (s.stealthWeight ?? 0.8);
    }
    return Math.min(1, l);
  }

  setThreat() {}
  setDeath() {}
  onFootfall() {}
  setCall() {}
  update() {}
  resize() {}

  render() {
    this.game.renderer.render(this.game.scene, this.game.camera);
  }
}
