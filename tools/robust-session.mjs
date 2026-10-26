// Long-session hygiene test: plays ~15 minutes of game time headless with a scripted "bot" that
// walks every zone with real input (WASD, sprint, crouch), throws bottles, sets off both alarm
// cars, cuts the gate, gets itself caught and respawns (~10 deaths), pauses/resumes, renders real
// frames now and then and fires resize events. Tracks scene objects, colliders (incl. the
// leviathan's needle boxes and the spatial hash), renderer memory, shader programs, JS heap, DOM
// nodes, bus listeners, audio voices/nodes and the per-system CPU profile, then reports growth
// between the end of the warm-up and the end of the run.
//   node tools/robust-session.mjs [--minutes 15] [--html dist/index.html] [--quiet]
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const MINUTES = Number(opt('--minutes', 15));
const html = opt('--html', 'dist/index.html');
const quiet = args.includes('--quiet');

const h = await launch({ html, query: 'autostart&quality=0&profile', args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const t0 = Date.now();

await h.eval(() => {
  const g = window.__game;
  g.audio.init(); // audio voices/nodes are part of the leak check
  const bot = {
    queue: [],
    target: null,
    sprint: false,
    crouch: false,
    respawns: 0,
    caught: 0,
    stuckT: 0,
    lastD: Infinity,
    walk(points, { sprint = false, crouch = false } = {}) {
      this.queue = points.map(([x, z]) => ({ x, z }));
      this.target = this.queue.shift() || null;
      this.sprint = sprint;
      this.crouch = crouch;
      this.stuckT = 0;
      this.lastD = Infinity;
    },
    steer(step) {
      const p = g.player, inp = g.input;
      inp.keys.delete('KeyW');
      inp.keys.delete('ShiftLeft');
      if (!this.target || g.state !== 'playing') return;
      const dx = this.target.x - p.position.x, dz = this.target.z - p.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2) {
        this.target = this.queue.shift() || null;
        this.lastD = Infinity;
        return;
      }
      // Not getting closer (wedged against a wreck): hop past the obstacle.
      if (d > this.lastD - 0.02) this.stuckT += step;
      else this.stuckT = 0;
      this.lastD = Math.min(this.lastD, d);
      if (this.stuckT > 3) {
        g.teleport(p.position.x + (dx / d) * 2.5, p.position.z + (dz / d) * 2.5, p.yaw);
        this.stuckT = 0;
        this.lastD = Infinity;
      }
      p.yaw = Math.atan2(-dx, -dz);
      inp.keys.add('KeyW');
      if (this.sprint && p.stamina > 0.4) inp.keys.add('ShiftLeft');
      if (this.crouch !== p.crouched && !this.sprint) inp.pressedKeys.add('KeyC');
    },
    // Advance `seconds` of game time (fixed 1/30 s steps), steering; respawns from the dead screen.
    run(seconds, until = null) {
      const step = 1 / 30;
      const n = Math.ceil(seconds / step);
      for (let i = 0; i < n; i++) {
        if (g.state === 'dead' && g.stateTime > 1.2) {
          g.respawn();
          this.respawns++;
          this.target = null;
        }
        this.steer(step);
        const was = g.state;
        g.tick(step);
        if (was !== 'caught' && g.state === 'caught') this.caught++;
        if (until && until()) return true;
      }
      return false;
    },
    metrics() {
      if (window.gc) window.gc();
      let objects = 0;
      g.scene.traverse(() => objects++);
      const mem = g.renderer.info.memory;
      let cellEntries = 0;
      for (const c of g.world.grid.values()) cellEntries += c.length;
      const a = g.audio.stats();
      return {
        t: Math.round(g.time),
        state: g.state,
        children: g.scene.children.length,
        objects,
        colliders: g.world.colliders.length,
        levFeet: g.world.colliders.filter((c) => c.tag === 'leviathan-foot').length,
        hashCells: g.world.grid.size,
        hashEntries: cellEntries,
        geometries: mem.geometries,
        textures: mem.textures,
        programs: g.renderer.info.programs?.length ?? 0,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        listeners: g.bus.listenerCount(),
        dom: document.getElementsByTagName('*').length,
        voices: a.voices,
        audioNodes: a.nodes,
        projectiles: g.projectiles.items.length + g.projectiles.shards.length,
        pathCache: g.director.pathCache.size,
        pathQueue: g.director.pathQueue.length,
        calls: g.leviathan.calls,
        footfalls: g.leviathan.footfalls,
        errors: g.errorLog.reduce((s, e) => s + e.count, 0),
      };
    },
  };
  window.__bot = bot;
});

// Zones: checkpoint index, a walk through it, and what to set off there.
const ZONES = [
  { cp: 0, walk: [[0, -6], [0, -19]] },
  { cp: 1, walk: [[2.5, -40], [4, -58], [0, -95]], alarm: 'main_alarm' },
  { cp: 2, walk: [[12, -150], [-8, -168], [-4, -186]], alarm: 'plaza_alarm' },
  { cp: 3, walk: [[2, -236], [-2, -270], [1, -310]], crouch: true },
  { cp: 4, walk: [[-8, -362], [-2, -384]], gate: true },
];

const rows = [];
const snapshot = async (label) => {
  const m = await h.eval(() => window.__bot.metrics());
  m.label = label;
  rows.push(m);
  if (!quiet) console.log(label.padEnd(26), JSON.stringify(m));
  return m;
};
const frames = async (n) => {
  for (let i = 0; i < n; i++) await h.eval(() => new Promise((r) => requestAnimationFrame(() => r())));
};

await snapshot('start');
const target = MINUTES * 60;
let episode = 0;
let warm = null;
while ((await h.eval(() => window.__game.time)) < target) {
  const z = ZONES[episode % ZONES.length];
  episode++;
  // 1. Respawn at the zone's checkpoint (a test may move the checkpoint; the game only moves it forward).
  await h.eval((z) => {
    const g = window.__game;
    if (g.state === 'paused') g.resume();
    if (g.state === 'caught') g.simulate(3);
    g.checkpoint = g.level.checkpoints[z.cp];
    g.checkpointBottles = 2;
    g.respawn();
    window.__bot.respawns++;
  }, z);
  // 2. Walk the zone (sprinting on odd episodes), throwing a bottle on the way.
  await h.eval((z) => {
    const bot = window.__bot, g = window.__game;
    bot.walk(z.walk, { sprint: z.cp % 2 === 1, crouch: !!z.crouch });
    bot.run(12);
    g.player.pitch = -0.15;
    g.input.pressedKeys.add('KeyF'); // throw (noise; the nearest snatcher goes to look)
    bot.run(14, () => !bot.target);
  }, z);
  // 3. Alarm car / gate.
  await h.eval((z) => {
    const g = window.__game, bot = window.__bot;
    if (z.alarm) {
      const a = g.level.alarms.find((x) => x.id === z.alarm);
      if (a) g.projectiles.throwBottle(a.pos.clone().setY(3), new (g.player.position.constructor)(0, -6, 0));
      bot.run(16);
    }
    if (z.gate) {
      g.level.openGate();
      bot.walk([[0, -400], [2, -412]]);
      bot.run(10);
    }
  }, z);
  // 4. Pause / resume (and a resize while paused).
  await h.eval(() => {
    const g = window.__game;
    if (g.pause()) {
      g.simulate(0.5);
      window.dispatchEvent(new Event('resize'));
      g.resume();
    }
  });
  // 5. Get caught: walk straight at the nearest snatcher that is looking about.
  await h.eval(() => {
    const g = window.__game, bot = window.__bot;
    if (g.state !== 'playing') return;
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
    if (!best) return;
    const fx = -Math.sin(best.yaw), fz = -Math.cos(best.yaw);
    g.teleport(best.position.x + fx * 5, best.position.z + fz * 5, best.yaw + Math.PI);
    bot.walk([[best.position.x, best.position.z]]);
    bot.run(30, () => g.state === 'caught');
    if (g.state === 'caught') bot.run(4); // through 'dead' and the respawn
  });
  // 6. Real frames now and then (renderer memory, programs), plus a resize mid-death sometimes.
  if (episode % 3 === 0) {
    await h.eval(() => window.dispatchEvent(new Event('resize')));
    await frames(3);
  }
  const m = await snapshot(`episode ${episode} (z${z.cp})`);
  if (episode === ZONES.length) warm = m; // every zone visited once: pools and caches are warm
}

// Respawn mid-call, and win while an enemy is mid-grab.
const edge = await h.eval(() => {
  const g = window.__game, bot = window.__bot;
  const out = {};
  if (g.state !== 'playing') g.respawn();
  for (let i = 0; i < 200 && !g.leviathan.calling; i++) bot.run(0.5);
  out.callingBefore = g.leviathan.calling;
  g.respawn();
  out.callingAfter = g.leviathan.calling;
  out.raptured = g.director.snatchers.filter((s) => s.state === 'rapture').length;
  bot.run(2);
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
  return out;
});

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
const keys = ['children', 'objects', 'colliders', 'levFeet', 'hashEntries', 'geometries', 'textures', 'programs', 'heapMB', 'listeners', 'dom', 'voices', 'audioNodes', 'projectiles', 'pathCache'];
console.log('\n=== growth from warm-up (episode %d, t=%ds) to end (t=%ds) ===', ZONES.length, base.t, end.t);
for (const k of keys) console.log(`${k.padEnd(12)} ${String(base[k]).padStart(8)} -> ${String(end[k]).padStart(8)}`);
console.log('\nedge cases:', JSON.stringify(edge));
console.log(`deaths (caught): ${report.caught}, respawns: ${report.respawns}, calls: ${end.calls}, footfalls: ${end.footfalls}`);
console.log('per-system ms per tick (simulated, quality=0):');
for (const [k, v] of Object.entries(report.perf)) console.log(`  ${k.padEnd(12)} mean ${v.mean.toFixed(3)}  p95 ${v.p95.toFixed(3)}  p99 ${v.p99.toFixed(3)}  max ${v.max.toFixed(2)}  (n=${v.n})`);
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
if (report.caught < 5) problems.push(`only ${report.caught} deaths: the session did not exercise respawn enough`);
if (edge.stuckRapture) problems.push('snatchers left in rapture after a respawn mid-call');
if (edge.stateAfterExitDuringGrab !== 'caught') problems.push('exit trigger during a grab changed the state');
if (edge.won !== 'won' || edge.afterCatchWhileWon !== 'won') problems.push('win / catch-after-win handling');
if (problems.length) {
  console.log('\nPROBLEMS:\n- ' + problems.join('\n- '));
  process.exitCode = 1;
} else console.log('\nno leaks or errors detected');
await h.close();
