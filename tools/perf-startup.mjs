// Startup profile: builds an unminified copy of the game, loads it headless with the V8 sampling
// profiler running, and reports (1) the game's own boot timings (game.bootTimings: construction
// steps, first frame) and (2) where the main thread spent its time until the first frame, grouped
// by source module (esbuild's "// src/..." markers) and by function.
//   node tools/perf-startup.mjs [--query "autostart&quality=0"] [--top 25] [--no-build]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const query = opt('--query', 'autostart&quality=0&mute');
const top = Number(opt('--top', 25));
const html = 'dist/profile.html';
if (!args.includes('--no-build')) execFileSync('node', ['build.mjs', '--no-minify', '--out', html], { stdio: 'inherit' });

// Map bundle line numbers to source modules.
const lines = fs.readFileSync(html, 'utf8').split('\n');
const scriptStart = lines.findIndex((l) => l.startsWith('<script>')) + 1;
const marks = [];
lines.forEach((l, i) => {
  // esbuild marks each module with its path relative to the cwd ("src/...", "../node_modules/...").
  const m = /^\s*\/\/ ((?:\.\.\/)*(?:src|node_modules)\/\S+\.m?js)\s*$/.exec(l);
  if (m) marks.push({ line: i - scriptStart, mod: m[1].replace(/^(?:\.\.\/)*node_modules\/three\/.*/, 'three') });
});
const moduleAt = (line) => {
  let lo = 0, hi = marks.length - 1, best = '(bundle)';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].line <= line) {
      best = marks[mid].mod;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const t0 = Date.now();
await page.goto('file://' + path.resolve(html) + '?' + query);
await page.waitForFunction(() => window.__game?.bootTimings?.firstFrameAt || window.__gameError, null, { timeout: 180000, polling: 100 });
const wall = Date.now() - t0;
const { profile } = await cdp.send('Profiler.stop');
const timings = await page.evaluate(() => ({ boot: window.__game?.bootTimings, error: window.__gameError || null, tex: window.__game?.level?.textures?.buildMs }));
await browser.close();

// Self time per node -> per module / per function. Samples between boot and first frame only.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dts = profile.timeDeltas;
profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (dts[i] || 0) / 1000));
const perModule = new Map(), perFn = new Map();
let total = 0;
for (const [id, ms] of self) {
  const n = byId.get(id);
  const cf = n.callFrame;
  total += ms;
  let mod = '(native/idle)';
  if (cf.url && cf.url.includes('profile.html')) mod = moduleAt(cf.lineNumber);
  else if (cf.functionName === '(program)' || cf.functionName === '(garbage collector)') mod = cf.functionName;
  else if (cf.functionName === '(idle)') mod = '(idle)';
  perModule.set(mod, (perModule.get(mod) || 0) + ms);
  const key = `${cf.functionName || '(anon)'}  [${mod}]`;
  perFn.set(key, (perFn.get(key) || 0) + ms);
}
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms  ${k}`).join('\n');
console.log('boot timings:', JSON.stringify(timings, null, 1));
console.log(`wall time to first frame: ${wall} ms; profiled ${total.toFixed(0)} ms`);
console.log('\nself time by module:\n' + fmt(perModule));
console.log('\nself time by function:\n' + fmt(perFn));
if (errors.length) {
  console.log('ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
}
