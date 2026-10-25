// Bundles the game into a single self-contained HTML file (no external requests).
//
//   node build.mjs                       -> dist/index.html
//   node build.mjs --entry tools/sandbox/leviathan.js --out dist/sandbox-leviathan.html
//   node build.mjs --watch --serve       -> rebuild on change, serve dist/ on :8080
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const entry = opt('--entry', 'src/main.js');
const out = opt('--out', 'dist/index.html');
const template = opt('--template', 'index.html');
const minify = !flag('--no-minify');

function inline(js) {
  const html = fs.readFileSync(template, 'utf8');
  // A literal "</script" inside the bundle would terminate the inline tag early.
  const safe = js.replace(/<\/script/gi, '<\\/script');
  if (!html.includes('<!-- BUNDLE -->')) throw new Error(`${template} is missing the <!-- BUNDLE --> marker`);
  return html.replace('<!-- BUNDLE -->', () => `<script>\n${safe}\n</script>`);
}

const writeHtml = {
  name: 'inline-html',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith('.js'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, inline(js.text));
      const kb = (fs.statSync(out).size / 1024).toFixed(0);
      console.log(`[build] ${out} (${kb} KB)`);
    });
  },
};

const options = {
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify,
  sourcemap: false,
  write: false,
  outdir: 'dist/.tmp',
  legalComments: 'none',
  logLevel: 'warning',
  plugins: [writeHtml],
};

if (flag('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching for changes');
} else {
  await esbuild.build(options);
}

if (flag('--serve')) {
  const port = Number(opt('--port', 8080));
  const root = path.resolve('dist');
  http
    .createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(root, url === '/' ? 'index.html' : url);
      if (!file.startsWith(root) || !fs.existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, () => console.log(`[serve] http://localhost:${port}/`));
}
