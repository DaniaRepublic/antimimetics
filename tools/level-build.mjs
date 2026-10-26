// Dev build for the level module: bundles the game with tools/sandbox/level-atmosphere.js in place
// of the atmosphere stub, so screenshots show real light pools and a red sky.
//   node tools/level-build.mjs [--out dist/level-dev.html]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'dist/level-dev.html';
const swap = {
  name: 'swap-atmosphere',
  setup(build) {
    build.onResolve({ filter: /\/atmosphere\.js$/ }, (a) => (a.importer.includes(`${path.sep}src${path.sep}`) ? { path: path.resolve('tools/sandbox/level-atmosphere.js') } : null));
  },
};
const res = await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: ['es2020'], minify: true, write: false, plugins: [swap], logLevel: 'warning',
});
const html = fs.readFileSync('index.html', 'utf8').replace('<!-- BUNDLE -->', () => `<script>\n${res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}\n</script>`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`[level-build] ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
