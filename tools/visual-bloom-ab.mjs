// A/B check of the bloom merged into the grade pass: the same frame with the bloom added in the
// grade (A) and with UnrealBloomPass' own additive blend restored (B). They should match.
//   node tools/visual-bloom-ab.mjs [--quality 2] [--out dir] [x z yaw]
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/visual/bloom-ab');
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))).map(Number);
const [x = 0, z = -2, yaw = 0] = pos;
const h = await launch({ query: `autostart&god&quality=${opt('--quality', '2')}`, timeout: 120000 });
h.page.setDefaultTimeout(240000);
await h.eval(([x, z, yaw]) => {
  const g = window.__game;
  const s = document.createElement('style');
  s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
  document.head.appendChild(s);
  g.teleport(x, z, yaw);
  g.player.applyCamera(g.camera);
  g.simulate(1);
  // freeze the world so A and B show the same instant (grain and flicker still differ slightly)
  g.tick = () => {};
}, [x, z, yaw]);
const a = await h.shot(path.join(out, 'A_merged.png'));
await h.eval(() => {
  const g = window.__game;
  const { bloom, grade } = g.atmosphere.post;
  bloom.fsQuad.render = Object.getPrototypeOf(bloom.fsQuad).render.bind(bloom.fsQuad);
  grade.uniforms.tBloom.value = null; // an empty sampler reads black: no bloom added in the grade
});
const b = await h.shot(path.join(out, 'B_blend.png'));
let diff = '';
try {
  diff = execFileSync('compare', ['-metric', 'MAE', a, b, path.join(out, 'diff.png')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  diff = String(e.stderr || e.stdout || e.message).trim();
}
console.log(`mean abs error A vs B: ${diff}`);
console.log(h.errors.length ? h.errors.join('\n') : 'no console errors');
await h.close();
