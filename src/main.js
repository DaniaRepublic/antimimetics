import { Game } from './game.js';
import { reloadAction, showNotice } from './core/notice.js';

// Builds the game. Deferred until the LOADING screen has been painted (the build is one long
// synchronous task), with a timer fallback for hidden tabs, where animation frames never run.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  const params = new URLSearchParams(window.location.search);
  let game;
  try {
    game = new Game(document.getElementById('app'), params);
  } catch (err) {
    console.error('[boot] the game could not start:', err);
    window.__gameError = String(err?.stack || err?.message || err); // lets headless tools fail fast
    document.getElementById('boot')?.remove();
    const msg = String(err?.message || err);
    const webgl = /webgl|context|gpu/i.test(msg);
    showNotice({
      title: 'CANNOT START',
      text: webgl
        ? 'This game draws with WebGL, and the browser could not provide it. Try turning hardware acceleration on, or another browser.'
        : 'Something went wrong while building the city.',
      detail: msg,
      action: reloadAction(),
    });
    return;
  }
  // Exposed for automated tests (tools/*.mjs) and debugging from the console.
  window.__game = game;
  game.start();
}

requestAnimationFrame(() => setTimeout(boot, 0));
setTimeout(boot, 500);
