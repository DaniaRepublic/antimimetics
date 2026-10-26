// Long-session hygiene test: plays ~15 minutes of game time headless with a scripted "bot" that
// walks every zone with real input (WASD, sprint, crouch), throws bottles, sets off both alarm
// cars, cuts the gate, gets itself caught and respawns (~10 deaths), pauses/resumes, renders real
// frames now and then and fires resize events. Tracks scene objects, colliders (incl. the
// leviathan's needle boxes and the spatial hash), renderer memory, shader programs, JS heap,
// Chromium process RSS, DOM nodes, bus listeners, audio voices/nodes and the per-system CPU
// profile, then reports growth between the end of the warm-up and the end of the run, and checks
// a few state-machine edge cases (respawn mid-call, the exit during a grab, a catch after winning).
//
// The real-time loop is stopped (game.stop()) and the world advanced in short chunks (<= 1 s of
// game time per page.evaluate), rendering real frames only every few episodes.
//   node tools/robust-session.mjs [--minutes 15] [--html dist/index.html] [--mute] [--quiet]
import { launch } from './harness.mjs';
import { chromeMemory } from './robust-proc.mjs';
import { installBot, ZONES } from './robust-bot.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const MINUTES = Number(opt('--minutes', 15));
const html = opt('--html', 'dist/index.html');
const quiet = args.includes('--quiet');
const mute = args.includes('--mute');
const CHUNK = Number(opt('--chunk', 1)); // seconds of game time per evaluate
const RSS_LIMIT = Number(opt('--rss-limit', 3000)); // MB: stop before the OOM killer does

const h = await launch({
  html, query: `autostart&quality=0&profile${mute ? '&mute' : ''}`, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const t0 = Date.now();

await h.eval(installBot);
// The real-time loop would render (slow SwiftShader) frames between evaluates: drive the world with
// the bot alone and render on demand (frames()).
await h.eval(() => window.__game.stop());


const rows = [];
let peakRss = 0;
const rssCheck = async (label) => {
  const mem = chromeMemory();
  const rss = mem.renderer || 0;
  peakRss = Math.max(peakRss, rss);
  if (rss > RSS_LIMIT) {
    console.log(`ABORT: renderer RSS ${rss} MB after ${label}`, JSON.stringify(mem));
    console.log(JSON.stringify(await h.eval(() => window.__bot.metrics())));
    await h.close();
    process.exit(2);
  }
  return mem;
};
const verbose = args.includes('--verbose');
let evals = 0;
const ev = async (fn, arg) => {
  const r = await h.eval(fn, arg);
  const mem = await rssCheck('evaluate');
  evals++;
  if (verbose) console.log(`  #${evals} ${String(fn).slice(0, 60).replace(/\s+/g, ' ')} -> ${JSON.stringify(mem)}`);
  return r;
};
// Runs the bot for `seconds` of game time in short evaluates; true if `until` was met.
const run = async (seconds, until = null) => {
  let left = seconds;
  while (left > 1e-6) {
    const s = Math.min(CHUNK, left);
    left -= s;
    if (await ev(([s, u]) => window.__bot.run(s, u), [s, until])) return true;
  }
  return false;
};
const snapshot = async (label) => {
  const m = await h.eval(() => window.__bot.metrics());
  Object.assign(m, await rssCheck(label));
  m.label = label;
  rows.push(m);
  if (!quiet) console.log(label.padEnd(18), JSON.stringify(m));
  return m;
};
const frames = async (n) => {
  await h.eval(() => window.__game.start());
  for (let i = 0; i < n; i++) await h.eval(() => new Promise((r) => requestAnimationFrame(() => r())));
  await h.eval(() => window.__game.stop());
};

await snapshot('start');
const target = MINUTES * 60;
let episode = 0;
let warm = null;
let pausedSeen = 0;
while ((await ev(() => window.__game.time)) < target) {
  const z = ZONES[episode % ZONES.length];
  episode++;
  // 1. Respawn at the zone's checkpoint (a test may move the checkpoint; the game only moves it forward).
  pausedSeen += await ev((z) => {
    const g = window.__game;
    const paused = g.state === 'paused' ? 1 : 0;
    if (g.state === 'paused') g.resume();
    if (g.state === 'caught') g.simulate(3);
    g.checkpoint = g.level.checkpoints[z.cp];
    g.checkpointBottles = 2;
    g.respawn();
    window.__bot.respawns++;
    return paused;
  }, z);
  // 2. Walk the zone (sprinting on odd episodes), throwing a bottle on the way.
  await ev((z) => window.__bot.walk(z.walk, { sprint: z.cp % 2 === 1, crouch: !!z.crouch }), z);
  await run(12);
  await ev(() => {
    const g = window.__game;
    g.player.pitch = -0.15;
    g.input.pressedKeys.add('KeyF'); // throw (noise; the nearest snatcher goes to look)
  });
  await run(14, 'noTarget');
  // 3. Alarm car / gate.
  if (z.alarm) {
    await ev((id) => {
      const g = window.__game;
      const a = g.level.alarms.find((x) => x.id === id);
      if (a) g.projectiles.throwBottle(a.pos.clone().setY(3), new (g.player.position.constructor)(0, -6, 0));
    }, z.alarm);
    await run(16);
  }
  if (z.gate) {
    await ev(() => {
      window.__game.level.openGate();
      window.__bot.walk([[0, -400], [2, -412]]);
    });
    await run(10);
  }
  // 4. Pause / resume (and a resize while paused).
  await ev(() => {
    const g = window.__game;
    if (g.pause()) {
      g.simulate(0.5);
      window.dispatchEvent(new Event('resize'));
      g.resume();
    }
  });
  // 5. Get caught: walk straight at the nearest snatcher that is looking about.
  const found = await ev(() => {
    const g = window.__game, bot = window.__bot;
    if (g.state !== 'playing') return false;
    const p = g.player.position;
    let best = null, bd = Infinity;
    for (const s of g.director.snatchers) {
      if (!s.active || s.state === 'rapture') continue;
      const d = Math.hypot(s.position.x - p.x, s.position.z - p.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) return false;
    const fx = -Math.sin(best.yaw), fz = -Math.cos(best.yaw);
    g.teleport(best.position.x + fx * 5, best.position.z + fz * 5, best.yaw + Math.PI);
    bot.walk([[best.position.x, best.position.z]]);
    return true;
  });
  if (found && (await run(30, 'caught'))) {
    // 6. A resize mid-death now and then, then through 'dead' and the respawn.
    if (episode % 2 === 0) await ev(() => window.dispatchEvent(new Event('resize')));
    await run(4);
  }
  // 7. Real frames now and then (renderer memory, programs).
  if (episode % 3 === 0) await frames(3);
  const m = await snapshot(`episode ${episode} (z${z.cp})`);
  if (episode === ZONES.length) warm = m; // every zone visited once: pools and caches are warm
}

// Respawn mid-call, and win while an enemy is mid-grab.
const edge = {};
await ev(() => {
  const g = window.__game;
  if (g.state === 'paused') g.resume();
  if (g.state !== 'playing') g.respawn();
});
edge.callingBefore = await run(120, 'calling');
Object.assign(edge, await ev(() => {
  const g = window.__game;
  const out = {};
  g.respawn();
  out.callingAfterRespawn = g.leviathan.calling;
  return out;
}));
await run(2);
Object.assign(edge, await ev(() => {
  const g = window.__game, bot = window.__bot;
  const out = {};
  out.stuckRapture = g.director.snatchers.filter((s) => s.state === 'rapture').length;
  // caught, then the exit trigger fires during the grab: must stay caught (no win)
  g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
  out.stateAfterCatch = g.state;
  g.teleport(0, -440);
  bot.run(0.2);
  out.stateAfterExitDuringGrab = g.state;
  bot.run(3);
  out.stateLater = g.state;
  g.respawn();
  // win, then a snatcher reaching the player must not kill them
  g.teleport(0, -440);
  bot.run(0.2);
  out.won = g.state;
  g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
  out.afterCatchWhileWon = g.state;
  out.respawnFromWon = g.respawn();
  return out;
}));

const end = rows[rows.length - 1];
const base = warm || rows[1] || rows[0];
const report = await h.eval(() => ({
  perf: window.__game.perfReport(),
  nav: window.__game.nav.stats,
  director: window.__game.director.perf,
  respawns: window.__bot.respawns,
  caught: window.__bot.caught,
  errorLog: window.__game.errorLog,
}));
const keys = ['renderer', 'gpu', 'children', 'objects', 'colliders', 'levFeet', 'hashEntries', 'geometries', 'textures', 'programs', 'heapMB', 'listeners', 'dom', 'voices', 'audioNodes', 'projectiles', 'pathCache'];
console.log(`\n=== growth from warm-up (episode ${ZONES.length}, t=${base.t}s) to end (t=${end.t}s) ===`);
for (const k of keys) console.log(`${k.padEnd(12)} ${String(base[k]).padStart(8)} -> ${String(end[k]).padStart(8)}`);
console.log(`peak renderer RSS ${peakRss} MB`);
console.log('\nedge cases:', JSON.stringify(edge));
console.log(`deaths (caught): ${report.caught}, respawns: ${report.respawns}, calls: ${end.calls}, footfalls: ${end.footfalls}, found paused: ${pausedSeen}`);
console.log('per-system ms per tick (simulated, quality=0):');
for (const [k, v] of Object.entries(report.perf)) console.log(`  ${k.padEnd(12)} mean ${v.mean.toFixed(3)}  p95 ${v.p95.toFixed(3)}  p99 ${v.p99.toFixed(3)}  max ${v.max.toFixed(2)}  (n=${v.n})`);
const spikes = await h.eval(() => window.__spikes);
const bySource = new Map();
for (const sp of spikes) {
  const k = sp.what;
  const r = bySource.get(k) || { n: 0, max: 0, at: null };
  r.n++;
  if (sp.ms > r.max) {
    r.max = sp.ms;
    r.at = `t=${sp.t} zone ${sp.zone} ${sp.state}`;
  }
  bySource.set(k, r);
}
console.log('spikes > 4 ms (count, worst):');
for (const [k, r] of [...bySource].sort((a, b) => b[1].max - a[1].max).slice(0, 25)) console.log(`  ${k.padEnd(36)} x${String(r.n).padEnd(4)} max ${r.max} ms  (${r.at})`);
console.log('nav:', JSON.stringify(report.nav));
console.log('director:', JSON.stringify(report.director));
console.log('game.errorLog:', JSON.stringify(report.errorLog));
console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const problems = [];
if (h.errors.length) problems.push(`${h.errors.length} console error(s):\n` + h.errors.slice(0, 10).join('\n'));
if (end.listeners !== base.listeners) problems.push(`bus listeners ${base.listeners} -> ${end.listeners}`);
if (end.children > base.children + 40) problems.push(`scene children grew ${base.children} -> ${end.children}`);
if (end.geometries > base.geometries + 10) problems.push(`geometries grew ${base.geometries} -> ${end.geometries}`);
if (end.textures > base.textures + 4) problems.push(`textures grew ${base.textures} -> ${end.textures}`);
if (end.dom > base.dom + 30) problems.push(`DOM nodes grew ${base.dom} -> ${end.dom}`);
if (report.caught < Math.min(5, episode / 2)) problems.push(`only ${report.caught} deaths: the session did not exercise respawn enough`);
if (pausedSeen) problems.push(`the game paused itself ${pausedSeen} time(s) without an Esc`);
if (edge.stuckRapture) problems.push('snatchers left in rapture after a respawn mid-call');
if (edge.callingAfterRespawn) problems.push('the call kept going through a respawn');
if (edge.stateAfterExitDuringGrab !== 'caught') problems.push('exit trigger during a grab changed the state');
if (edge.won !== 'won' || edge.afterCatchWhileWon !== 'won' || edge.respawnFromWon) problems.push('win / catch-after-win handling');
if (problems.length) {
  console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
  process.exitCode = 1;
} else console.log('\nno leaks or errors detected');
await h.close();
