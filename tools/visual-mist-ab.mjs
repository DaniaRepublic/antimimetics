// What makes a view hazy: the same frame rendered with the mist's parts switched off one by one
// (A all on, B no wisps, C no lamp in-scatter, D no volumetric mist at all), with luminance stats.
//   node tools/visual-mist-ab.mjs x z yaw [pitch] [--crouch] [--quality 2] [--out dir]
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/visual/mist-ab');
const nums = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--quality', '--out'].includes(args[i - 1]))).map(Number);
const [x, z, yaw = 0, pitch = 0] = nums;
const crouch = args.includes('--crouch');
const h = await launch({ query: `autostart&god&quality=${opt('--quality', '2')}`, timeout: 120000 });
h.page.setDefaultTimeout(240000);
await h.eval(([x, z, yaw, pitch, crouch]) => {
  const g = window.__game;
  const s = document.createElement('style');
  s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
  document.head.appendChild(s);
  g.teleport(x, z, yaw);
  g.player.crouched = crouch;
  g.player.eyeHeight = crouch ? 0.95 : 1.65;
  g.leviathan.placeForCheckpoint({ pos: { x, z } });
  for (let i = 0; i < 45; i++) {
    g.player.pitch = pitch;
    g.player.applyCamera(g.camera);
    g.tick(1 / 30);
  }
  g.tick = () => {}; // freeze: every variant shows the same instant
}, [x, z, yaw, pitch, crouch]);

const lum = (file) => {
  const r = execFileSync('convert', [file, '-colorspace', 'Gray', '-format', '%[fx:mean*255] %[fx:standard_deviation*255]', 'info:'], { encoding: 'utf8' });
  return r.trim().split(' ').map((v) => (+v).toFixed(1)).join(' sd ');
};
// --glow a,b,c --knee a,b,c: extra variants with those lamp in-scatter settings (all else on)
const glows = opt('--glow', '').split(',').filter(Boolean).map(Number);
const knees = opt('--knee', '').split(',').filter(Boolean).map(Number);
const variants = [
  ['A_all', () => {}],
  ['B_no_wisps', (g) => { g.atmosphere.post.mistPass.wispsEnabled = false; }],
  ['C_no_lamp_glow', (g) => {
    const u = g.atmosphere.post.mistPass.marchUniforms;
    u.uMistGlow.value = 0;
    u.uHaze.value = 0;
  }],
  ['D_no_mist', (g) => { g.atmosphere.post.mistPass.mistEnabled = false; }],
];
const base = await h.eval(() => {
  const u = window.__game.atmosphere.post.mistPass.marchUniforms;
  return { glow: u.uMistGlow.value, haze: u.uHaze.value, knee: u.uGlowKnee?.value };
});
glows.forEach((gv, i) => {
  const kv = knees[i] ?? base.knee;
  variants.push([`E${i}_glow${gv}_knee${kv}`, `(g) => {
    const m = g.atmosphere.post.mistPass;
    m.mistEnabled = true;
    m.wispsEnabled = true;
    m.marchUniforms.uMistGlow.value = ${gv};
    m.marchUniforms.uHaze.value = ${base.haze};
    if (m.marchUniforms.uGlowKnee) m.marchUniforms.uGlowKnee.value = ${kv};
  }`]);
});
for (const [name, fn] of variants) {
  await h.eval(`(${typeof fn === 'string' ? fn : fn.toString()})(window.__game)`);
  const file = await h.shot(path.join(out, `${name}.png`));
  console.log(`${name}: mean ${lum(file)}`);
}
console.log(h.errors.length ? h.errors.join('\n') : 'no console errors');
await h.close();
