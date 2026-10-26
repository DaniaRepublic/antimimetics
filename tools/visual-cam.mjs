// One screenshot from an arbitrary camera (debugCamera), e.g. a top-down look at a layout detail.
//   node tools/visual-cam.mjs px py pz tx ty tz [--quality 2] [--out file.png] [--html dist/index.html]
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const nums = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--quality', '--out', '--html'].includes(args[i - 1]))).map(Number);
const h = await launch({ html: opt('--html', 'dist/index.html'), query: `autostart&god&quality=${opt('--quality', '2')}`, timeout: 120000 });
h.page.setDefaultTimeout(240000);
await h.eval((n) => {
  const s = document.createElement('style');
  s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
  document.head.appendChild(s);
  const g = window.__game;
  g.teleport(n[0], n[2], 0);
  g.debugCamera = { pos: n.slice(0, 3), target: n.slice(3, 6) };
}, nums);
await h.shot(opt('--out', 'dist/shots/visual/cam.png'));
console.log(h.errors.length ? h.errors.join('\n') : 'no console errors');
await h.close();
