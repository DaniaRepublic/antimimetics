import { Snatcher } from './snatcher.js';

// STUB - replaced by the AI module. See ARCHITECTURE.md.
export class Director {
  constructor(game) {
    this.game = game;
    this.snatchers = game.level.enemies.map((def) => new Snatcher(game, def));
    this.threat = 0;
    this.chasing = 0;
  }

  update(dt) {
    for (const s of this.snatchers) s.update(dt);
  }

  reset() {
    for (const s of this.snatchers) s.reset();
  }

  getIndicators() {
    return [];
  }
}
