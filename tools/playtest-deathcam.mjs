// Screenshots of the death cam in the real level: the bot walks upright at a zone's snatcher until
// it is caught, then the frames at ~0.4 s, 1.2 s and 2.2 s into the 'caught' state are rendered.
//
//   node build.mjs && node tools/playtest-deathcam.mjs [--zone 1] [--victim z1_patrol] [--out dist/playtest]
import { launch } from './harness.mjs';
import { installBot } from './playtest-bot.mjs';
import { CONFIG } from '../src/config.js';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const zone = Number(opt('--zone', 1));
const victim = opt('--victim', 'z1_patrol');
const out = opt('--out', 'dist/playtest');
const quality = opt('--quality', '2');

const h = await launch({ query: `autostart&mute&quality=${quality}&cp=${zone}`, timeout: 180000 });
await h.eval(installBot, [CONFIG, { fastModels: false }]);
const caught = await h.eval(([zone, id]) => {
  const B = window.__bot, g = B.g;
  B.reset(zone);
  const v = B.s(id);
  let path = null, pi = 0;
  for (let i = 0; i < 30 * 90 && g.state === 'playing'; i++) {
    const p = g.player.position;
    if (i % 15 === 0) {
      path = g.nav.findPath(p, v.position) || [{ x: v.position.x, z: v.position.z }];
      pi = 0;
    }
    while (pi < path.length - 1 && Math.hypot(path[pi].x - p.x, path[pi].z - p.z) < 0.5) pi++;
    const wp = Math.hypot(v.position.x - p.x, v.position.z - p.z) < 4 ? v.position : path[pi];
    g.player.yaw = B.dirToYaw(wp.x - p.x, wp.z - p.z);
    g.input.keys.clear();
    g.input.keys.add('KeyW');
    g.__realTick(B.DT);
  }
  g.input.keys.clear();
  return { state: g.state, by: g.caughtBy?.id };
}, [zone, victim]);
console.log('caught:', JSON.stringify(caught));
// Restore real rendering for the shots: the page's frame loop runs again, rendering (but not
// advancing) the world; we advance it by hand between shots.
await h.eval(() => {
  const g = window.__game;
  g.render = g.constructor.prototype.render.bind(g);
  window.requestAnimationFrame = window.__rAF;
  window.requestAnimationFrame(() => g.start());
});
let t = 0;
for (const at of [0.4, 1.2, 2.2]) {
  const info = await h.eval((dt) => {
    const g = window.__game;
    const n = Math.round(dt * 30);
    for (let i = 0; i < n; i++) g.__realTick(1 / 30);
    const e = g.caughtBy;
    const head = e.getHeadPos(new (g.player.position.constructor)());
    const eye = g.player.getEyePos(new (g.player.position.constructor)());
    return { state: g.state, st: g.stateTime.toFixed(2), d: Math.hypot(e.position.x - g.player.position.x, e.position.z - g.player.position.z).toFixed(2), head: head.distanceTo(eye).toFixed(2) };
  }, at - t);
  t = at;
  const file = await h.shot(path.join(out, `deathcam-z${zone}-${at}s.png`));
  console.log(file, JSON.stringify(info));
}
if (h.errors.length) console.log('ERRORS:\n' + h.errors.join('\n'));
await h.close();
