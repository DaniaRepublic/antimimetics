// Before/after sheets: pairs same-named screenshots from two tour folders side by side (ImageMagick
// `montage`, half size) into an output folder.
//   node tools/visual-compare.mjs <beforeDir> <afterDir> [outDir] [name ...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [before, after, out = 'dist/shots/visual/compare', ...names] = process.argv.slice(2);
if (!before || !after) {
  console.log('usage: node tools/visual-compare.mjs <beforeDir> <afterDir> [outDir] [name ...]');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const list = names.length ? names.map((n) => (n.endsWith('.png') ? n : `${n}.png`)) : fs.readdirSync(after).filter((f) => f.endsWith('.png'));
for (const f of list) {
  const a = path.join(before, f), b = path.join(after, f);
  if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
  const dst = path.join(out, f);
  execFileSync('montage', [a, b, '-tile', '2x1', '-geometry', '640x360+4+4', '-background', '#111', dst]);
  console.log(dst);
}
