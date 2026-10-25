// STUB - replaced by the HUD module. See ARCHITECTURE.md.
export class Hud {
  constructor(game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;color:#eee;font:16px monospace;pointer-events:auto;';
    document.body.appendChild(this.el);
    this.el.addEventListener('click', () => {
      const s = game.state;
      if (s === 'title') game.begin();
      else if (s === 'intro') game.startPlaying();
      else if (s === 'paused') game.resume();
      else if (s === 'dead') game.respawn();
    });
  }

  update() {
    const s = this.game.state;
    const text = { title: 'WHEN IT CALLS - click to begin', intro: 'click to start', paused: 'paused - click', dead: 'caught - click', won: 'you got out' }[s] || '';
    this.el.textContent = text;
    this.el.style.pointerEvents = text ? 'auto' : 'none';
  }
}
