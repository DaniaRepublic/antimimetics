// CPU profile of the simulation on the real level: builds an unminified copy, lets the scripted
// bot (tools/robust-bot.mjs) tour every zone with the V8 sampling profiler running, and reports
// game.perfReport() (per-system ms per tick) plus self time by source module and by function.
// Rendering is excluded (simulate only) unless --frames N asks for real frames per episode.
// --alloc also samples allocations (including objects already collected) to find GC churn.
//   node tools/perf-systems.mjs [--episodes 10] [--top 30] [--no-build] [--frames 0] [--alloc]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { launch } from './harness.mjs';
import { installBot, ZONES } from './robust-bot.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const EPISODES = Number(opt('--episodes', 10));
const TOP = Number(opt('--top', 30));
const FRAMES = Number(opt('--frames', 0));
const html = 'dist/profile.html';
if (!args.includes('--no-build')) execFileSync('node', ['build.mjs', '--no-minify', '--out', html], { stdio: 'inherit' });

// Bundle line -> source module (esbuild writes a "// path" marker before each module).
const lines = fs.readFileSync(html, 'utf8').split('\n');
const marks = [];
lines.forEach((l, i) => {
  const m = /^\s*\/\/ ((?:\.\.\/)*(?:src|node_modules)\/\S+\.m?js)\s*$/.exec(l);
  // Profiler line numbers of an inline script are document lines (0-based), like i.
  if (m) marks.push({ line: i, mod: m[1].replace(/^(?:\.\.\/)*node_modules\/three\/.*/, 'three') });
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

const h = await launch({ html, query: 'autostart&quality=0&profile' });
await h.eval(installBot, { spikes: false });
await h.eval(() => window.__game.stop()); // simulate only; --frames renders on demand
const cdp = await h.top.context().newCDPSession(h.top);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
await h.eval(() => window.__game.resetPerf());
await cdp.send('Profiler.start');
const ALLOC = args.includes('--alloc');
if (ALLOC) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
}
const run = async (seconds, until = null) => {
  for (let left = seconds; left > 1e-6; left -= 1) {
    if (await h.eval(([s, u]) => window.__bot.run(s, u), [Math.min(1, left), until])) return true;
  }
  return false;
};
for (let e = 0; e < EPISODES; e++) {
  const z = ZONES[e % ZONES.length];
  await h.eval((z) => {
    const g = window.__game;
    if (g.state === 'paused') g.resume();
    g.checkpoint = g.level.checkpoints[z.cp];
    g.respawn();
    window.__bot.walk(z.walk, { sprint: z.cp % 2 === 1, crouch: !!z.crouch });
  }, z);
  await run(20, 'noTarget');
  if (z.alarm) {
    await h.eval((id) => {
      const g = window.__game;
      const a = g.level.alarms.find((x) => x.id === id);
      if (a) g.projectiles.throwBottle(a.pos.clone().setY(3), new (g.player.position.constructor)(0, -6, 0));
    }, z.alarm);
    await run(12);
  }
  // a chase: show yourself to the nearest snatcher, then run away for a while
  await h.eval(() => {
    const g = window.__game, bot = window.__bot;
    const p = g.player.position;
    let best = null, bd = Infinity;
    for (const s of g.director.snatchers) {
      const d = Math.hypot(s.position.x - p.x, s.position.z - p.z);
      if (s.active && d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) return;
    g.teleport(best.position.x - Math.sin(best.yaw) * 9, best.position.z - Math.cos(best.yaw) * 9, best.yaw + Math.PI);
    bot.walk([[best.position.x - Math.sin(best.yaw) * 8, best.position.z - Math.cos(best.yaw) * 8]]);
  });
  await run(6);
  await run(16, 'caught');
  await run(4);
  if (FRAMES) {
    await h.eval(() => window.__game.start());
    for (let f = 0; f < FRAMES; f++) await h.eval(() => new Promise((r) => requestAnimationFrame(() => r())));
    await h.eval(() => window.__game.stop());
  }
}
const { profile } = await cdp.send('Profiler.stop');
const alloc = ALLOC ? (await cdp.send('HeapProfiler.stopSampling')).profile : null;
const perf = await h.eval(() => ({ perf: window.__game.perfReport(), nav: window.__game.nav.stats, time: window.__game.time, director: window.__game.director.perf }));
await h.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0) / 1000));
const perModule = new Map(), perFn = new Map();
let total = 0;
for (const [id, ms] of self) {
  const cf = byId.get(id).callFrame;
  let mod = cf.functionName ? `(${cf.functionName})` : '(native)';
  if (cf.url && cf.url.includes('profile.html')) mod = moduleAt(cf.lineNumber);
  if (mod === '(idle)' || mod === '(program)') continue; // waiting for the test driver / native glue
  total += ms;
  perModule.set(mod, (perModule.get(mod) || 0) + ms);
  const key = `${cf.functionName || '(anon)'}  [${mod}]`;
  perFn.set(key, (perFn.get(key) || 0) + ms);
}
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`).join('\n');
console.log(`simulated ${perf.time.toFixed(0)} s of game time; ${total.toFixed(0)} ms of JS sampled`);
console.log('\nper-system ms per tick:');
for (const [k, v] of Object.entries(perf.perf)) console.log(`  ${k.padEnd(12)} mean ${v.mean.toFixed(3)}  p95 ${v.p95.toFixed(3)}  p99 ${v.p99.toFixed(3)}  max ${v.max.toFixed(2)}  (n=${v.n})`);
console.log('nav:', JSON.stringify(perf.nav));
console.log('\nself time by module:\n' + fmt(perModule));
console.log('\nself time by function:\n' + fmt(perFn));
if (alloc) {
  const perAlloc = new Map();
  let allocTotal = 0;
  const walk = (node, stack) => {
    const cf = node.callFrame;
    const mod = cf.url && cf.url.includes('profile.html') ? moduleAt(cf.lineNumber) : '';
    const name = `${cf.functionName || '(anon)'}${mod ? `  [${mod}]` : ''}`;
    if (node.selfSize) {
      // attribute to the innermost game frame (three.js helpers report their caller too)
      const key = mod && mod !== 'three' ? name : `${name}  <- ${stack.find((s) => !s.includes('[three]') && s.includes('[src/')) || '?'}`;
      perAlloc.set(key, (perAlloc.get(key) || 0) + node.selfSize);
      allocTotal += node.selfSize;
    }
    for (const c of node.children || []) walk(c, mod ? [name, ...stack] : stack);
  };
  walk(alloc.head, []);
  console.log(`\nallocations sampled: ${(allocTotal / 1048576).toFixed(0)} MB over ${perf.time.toFixed(0)} s of game time (${(allocTotal / 1024 / perf.time).toFixed(0)} KB per game-second)`);
  console.log([...perAlloc].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${(v / 1048576).toFixed(1).padStart(7)} MB  ${k}`).join('\n'));
}
if (h.errors.length) {
  console.log('ERRORS:\n' + h.errors.join('\n'));
  process.exitCode = 1;
}
