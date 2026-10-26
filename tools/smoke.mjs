// Smoke test: boot the built game headless, run it for a while, screenshot, report errors (console
// errors and failures the game caught itself, game.errorLog) and the boot timings.
//   node tools/smoke.mjs [--html dist/index.html] [--query autostart] [--seconds 4] [--out <dir>]
import { launch } from './harness.mjs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const html = opt('--html', 'dist/index.html');
const query = opt('--query', 'autostart');
const seconds = Number(opt('--seconds', 4));
const out = opt('--out', 'dist/smoke');

const h = await launch({ html, query });
await h.page.waitForTimeout(seconds * 1000);
const info = await h.eval(() => {
  const g = window.__game;
  return {
    state: g.state,
    fps: Math.round(g.fps),
    player: [g.player.position.x, g.player.position.z].map((v) => +v.toFixed(2)),
    enemies: g.director.snatchers.length,
    colliders: g.world.colliders.length,
    drawCalls: g.renderer.info.render.calls,
    triangles: g.renderer.info.render.triangles,
    navRegions: g.nav.regionCount,
    boot: g.bootTimings && { constructMs: g.bootTimings.constructMs, firstFrameMs: g.bootTimings.firstFrameMs, firstFrameAt: g.bootTimings.firstFrameAt },
    errorLog: g.errorLog,
  };
});
const file = await h.shot(path.join(out, 'smoke.png'));
console.log(JSON.stringify(info, null, 2));
console.log('screenshot:', file);
if (info.errorLog?.length) {
  console.log('game.errorLog:', JSON.stringify(info.errorLog));
  process.exitCode = 1;
}
if (h.errors.length) {
  console.log('ERRORS:\n' + h.errors.join('\n'));
  process.exitCode = 1;
} else console.log('no console errors');
await h.close();
