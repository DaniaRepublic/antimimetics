import * as THREE from 'three';
import { CONFIG } from '../config.js';

// STUB - replaced by the leviathan module. See ARCHITECTURE.md.
export class Leviathan {
  constructor(game) {
    this.game = game;
    this.position = new THREE.Vector3(80, 110, -100);
    this.calling = false;
    this.callTimer = 20;
    this.callElapsed = 0;
  }

  update(dt) {
    const game = this.game;
    if (this.calling) {
      this.callElapsed += dt;
      game.noiseMask = 1;
      if (this.callElapsed >= CONFIG.leviathan.callDuration) {
        this.calling = false;
        game.noiseMask = 0;
        game.bus.emit('leviathan:call:end', {});
      }
      return;
    }
    this.callTimer -= dt;
    if (this.callTimer <= 0) {
      this.callTimer = 30;
      this.calling = true;
      this.callElapsed = 0;
      game.bus.emit('leviathan:call:start', { pos: this.position.clone(), duration: CONFIG.leviathan.callDuration });
    }
  }

  onRespawn() {}
}
