// Quick numeric probe of what lights a viewpoint: which registered sources hold the pooled real
// lights, their weights/intensities and the stealth light level, after a short settle.
//   node tools/visual-probe.mjs x z [yaw] [--quality 0] [--html dist/index.html]
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const [x, z, yaw = 0] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))).map(Number);
const h = await launch({ html: opt('--html', 'dist/index.html'), query: `autostart&god&quality=${opt('--quality', '0')}`, timeout: 120000 });
const r = await h.eval(([x, z, yaw]) => {
  const g = window.__game;
  g.teleport(x, z, yaw);
  g.leviathan.placeForCheckpoint({ pos: { x, z } });
  g.player.applyCamera(g.camera); // the pool ranks sources from the camera (normally set by render)
  g.simulate(1.5);
  const pool = g.atmosphere.lights;
  const f = (v) => Math.round(v * 100) / 100;
  return {
    sag: f(pool.sag),
    light: f(g.atmosphere.lightLevelAt(g.player.position)),
    slots: pool.slots.map((s) => (s.rec ? `${f(s.rec.src.pos.x)},${f(s.rec.src.pos.y)},${f(s.rec.src.pos.z)} base ${f(s.rec.src.intensity)} w ${f(s.rec.weight)} on ${f(s.rec.on)} flick ${f(s.rec.flick)} -> ${f(s.light.intensity)}` : null)),
    top: pool.records.filter((rec) => rec.score > 0).sort((a, b) => b.score - a.score).slice(0, 10)
      .map((rec) => `${f(rec.src.pos.x)},${f(rec.src.pos.z)} i${f(rec.src.intensity)} score ${f(rec.score)}${rec.slot ? ' [slot]' : ''}`),
  };
}, [x, z, yaw]);
console.log(JSON.stringify(r, null, 1));
if (h.errors.length) console.log(h.errors.join('\n'));
await h.close();
