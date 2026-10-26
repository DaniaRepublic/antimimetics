// Death-cam geometry probe: triggers a real catch (Z1 sentry, laundromat light) and reports where
// the caught-by snatcher's face is relative to the camera during the 'caught' state.
//   node tools/visual-deathcam.mjs [--html dist/index.html] [--shots dir]
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const html = opt('--html', 'dist/index.html');
const shots = opt('--shots', null);
const h = await launch({ html, query: `autostart&god&quality=${shots ? 2 : 0}`, timeout: 120000 });
h.page.setDefaultTimeout(240000);
await h.eval(() => {
  const g = window.__game;
  g.__tick = g.tick.bind(g);
  g.tick = () => {};
  const s = document.createElement('style');
  s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
  document.head.appendChild(s);
  const e = g.director.snatchers.find((x) => x.id === 'z1_sentry');
  e.reset();
  g.god = false;
  g.teleport(e.position.x + 4.5, e.position.z + 0.3, Math.PI / 2);
  let t = 0;
  while (g.state !== 'caught' && t < 25) {
    g.__tick(1 / 30);
    t += 1 / 30;
  }
});
for (const at of [0.3, 0.6, 1.0, 1.4, 1.8, 2.4]) {
  const r = await h.eval((at) => {
    const g = window.__game;
    const s = g.caughtBy;
    while (g.stateTime < at && g.state === 'caught') g.__tick(1 / 30);
    const V = g.camera.position.constructor;
    g.player.applyCamera(g.camera);
    g.camera.updateMatrixWorld();
    const head = s.getHeadPos(new V());
    const cam = g.camera.getWorldPosition(new V());
    const fwd = g.camera.getWorldDirection(new V());
    const to = head.clone().sub(cam);
    const d = to.length();
    return {
      at, state: g.state, by: s?.id, enemy: s?.state, d: +d.toFixed(2),
      offAxisDeg: +((Math.acos(Math.min(1, fwd.dot(to.normalize()))) * 180) / Math.PI).toFixed(1),
      head: head.toArray().map((v) => +v.toFixed(2)), cam: cam.toArray().map((v) => +v.toFixed(2)),
      death: +g.atmosphere.death.toFixed(2),
      rootDist: +Math.hypot(s.position.x - cam.x, s.position.z - cam.z).toFixed(2),
    };
  }, at);
  console.log(JSON.stringify(r));
  if (shots) await h.shot(path.join(shots, `death_${at.toFixed(1)}s.png`));
}
console.log(h.errors.length ? h.errors.join('\n') : 'no console errors');
await h.close();
