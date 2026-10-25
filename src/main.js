import { Game } from './game.js';

const params = new URLSearchParams(window.location.search);
const game = new Game(document.getElementById('app'), params);
// Exposed for automated tests (tools/*.mjs) and debugging from the console.
window.__game = game;
game.start();
