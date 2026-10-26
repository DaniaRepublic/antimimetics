// AI soak test in the REAL level (real colliders, nav grid, spawn defs, wrecks and leviathan): for
// each zone, the player stands at its checkpoint (invisible to the snatchers, so nothing gets
// caught), and for a few minutes the zone is stirred up -- bottles shattering at random walkable
// spots, footsteps, the zone's car alarm, one of the zone's snatchers "seeing" something up to
// 20 m away (chase, shriek, search) -- while the
// leviathan walks and calls as usual. Then everything is left alone so they can settle.
//
//   node build.mjs && node tools/playtest-ai.mjs [--zones 1,2] [--minutes 5] [--settle 180]
//
// After the stirring, it runs until every snatcher is calm again (idle on its post / patrolling)
// for up to --settle seconds; whoever is still busy then counts as a failure.
//
// Reports per snatcher: distance walked, stalls (> 3 s trying to move but not moving), unstuck
// events, needle (leviathan-foot) contacts, states visited, and whether it is back on its post or
// route at the end; per zone: path-finding cost (max ms per search) and calls.
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const zones = opt('--zones', '1,2,3,4').split(',').map(Number);
const minutes = Number(opt('--minutes', 5));
const settle = Number(opt('--settle', 180));
const verbose = args.includes('--verbose');

// Zone play areas the stimuli are scattered over (inside the route rects).
const AREAS = {
  0: [{ minX: -2.5, maxX: 2.5, minZ: -20, maxZ: 6 }],
  1: [{ minX: -11, maxX: 11, minZ: -125, maxZ: -38 }, { minX: 13, maxX: 27, minZ: -134, maxZ: -112 }],
  2: [{ minX: -27, maxX: 27, minZ: -204, maxZ: -146 }, { minX: -39, maxX: -29, minZ: -181, maxZ: -157 }],
  3: [{ minX: -17, maxX: 17, minZ: -336, maxZ: -220 }],
  4: [{ minX: -11.5, maxX: 11.5, minZ: -394, maxZ: -340 }, { minX: -43, maxX: -14, minZ: -422, maxZ: -340 }],
};

let failed = 0;
const errors = [];
for (const zone of zones) {
  const h = await launch({ query: `autostart&quality=0&mute&cp=${zone}`, timeout: 120000 });
  const r = await h.eval(([zone, minutes, settle, areas]) => {
    const g = window.__game;
    g.tick = g.__realTick || g.tick.bind(g);
    window.requestAnimationFrame = () => 0; // the page's own loop stops; we tick by hand
    g.render = () => {};
    const D = g.director;
    for (const s of D.snatchers) s.model.update = () => {};
    // The player is a ghost here: snatchers must move because of the stimuli, not chase us.
    const proto = D.snatchers[0].brain.constructor.prototype;
    proto.sense = function () {
      this.senseInCone = false;
      this.senseNear = false;
      return 0;
    };
    // Log the slowest path searches (who asked, from where to where, how long).
    const slow = [];
    const fp = g.nav.findPath.bind(g.nav);
    g.nav.findPath = (from, to, o) => {
      const t0 = performance.now();
      const path = fp(from, to, o);
      const ms = performance.now() - t0;
      if (ms > 3) {
        const who = D.snatchers.find((s) => s.position === from);
        let len = 0, px = from.x, pz = from.z;
        for (const q of path || []) {
          len += Math.hypot(q.x - px, q.z - pz);
          px = q.x;
          pz = q.z;
        }
        slow.push(`${ms.toFixed(1)} ms ${who ? who.id + '/' + who.state : '?'} ${from.x.toFixed(0)},${from.z.toFixed(0)} -> ${to.x.toFixed(0)},${to.z.toFixed(0)} (${Math.hypot(to.x - from.x, to.z - from.z).toFixed(0)} m straight, path ${path ? len.toFixed(0) + ' m' : 'NONE'}, budget ${o?.maxExpansions})`);
      }
      return path;
    };
    const rnd = (() => {
      let a = 12345 + zone * 777;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
    const V = g.player.position.constructor;
    const randomPoint = () => {
      for (let k = 0; k < 50; k++) {
        const A = areas[Math.floor(rnd() * areas.length)];
        const x = A.minX + rnd() * (A.maxX - A.minX), z = A.minZ + rnd() * (A.maxZ - A.minZ);
        if (g.nav.isWalkable(x, z)) return { x, z };
      }
      return null;
    };
    const mine = D.snatchers.filter((s) => s.def.zone === zone || Math.abs(s.def.zone - zone) <= 1);
    const stat = new Map(mine.map((s) => [s, { id: s.id, kind: s.def.kind, dist: 0, stall: 0, maxStall: 0, stalls: [], states: {}, needle: 0, lastX: s.position.x, lastZ: s.position.z, trail: [] }]));
    const DT = 1 / 30;
    let t = 0, nextBottle = 4, nextStep = 9, nextShout = 25, nextAlarm = 40, calls = 0, stimuli = 0;
    g.bus.on('leviathan:call:start', () => calls++);
    const alarm = g.level.alarms.find((a) => a.zone === zone);
    let slowFrames = 0, frames = 0;
    const step = (active) => {
      g.tick(DT);
      t += DT;
      frames++;
      if (D.perf.lastMs > 8) slowFrames++;
      for (const s of mine) {
        const st = stat.get(s);
        if (Math.round(t / DT) % 150 === 0) {
          st.trail.push(`${t.toFixed(0)}:${s.state}${s.brain.phase ? '/' + s.brain.phase : ''}@${s.position.x.toFixed(1)},${s.position.z.toFixed(1)}${s.path ? ' p' + (s.path.length - s.pathIndex) : ''}${s.pathFailed ? ' FAILED' : ''}${s.goal ? ' ->' + s.goal.x.toFixed(1) + ',' + s.goal.z.toFixed(1) : ''}`);
          if (st.trail.length > 14) st.trail.shift();
        }
        if (!s.active) continue;
        const moved = Math.hypot(s.position.x - st.lastX, s.position.z - st.lastZ);
        st.dist += moved;
        st.lastX = s.position.x;
        st.lastZ = s.position.z;
        st.states[s.state] = (st.states[s.state] || 0) + DT;
        const trying = s.path && s.moveSpeed > 0.25 && !s.hold && !s.pathPending && s.state !== 'rapture' && s.state !== 'grab';
        if (trying && moved < 0.15 * DT) {
          st.stall += DT;
          if (st.stall > st.maxStall) st.maxStall = st.stall;
          if (st.stall > 3 && st.stall - DT <= 3) st.stalls.push(`${s.state}@${s.position.x.toFixed(1)},${s.position.z.toFixed(1)} t=${t.toFixed(0)}`);
        } else st.stall = 0;
        if (trying) {
          const feet = g.world.query(s.position.x - 0.9, s.position.z - 0.9, s.position.x + 0.9, s.position.z + 0.9).some((c) => c.enabled && c.tag === 'leviathan-foot');
          if (feet) st.needle += DT;
        }
      }
      if (!active) return;
      if (t > nextBottle) {
        nextBottle = t + 6 + rnd() * 10;
        const p = randomPoint();
        if (p) {
          stimuli++;
          g.bus.emit('noise', { pos: new V(p.x, 0.05, p.z), radius: 20, loudness: 1, source: 'bottle' });
        }
      }
      if (t > nextStep) {
        nextStep = t + 5 + rnd() * 8;
        const p = randomPoint();
        if (p) g.bus.emit('noise', { pos: new V(p.x, 0, p.z), radius: 7.5, loudness: 0.4, source: 'player' });
      }
      if (t > nextShout) {
        // One of them "saw" something at a random spot: chase there, lose it, search.
        nextShout = t + 30 + rnd() * 25;
        const cand = mine.filter((s) => s.def.zone === zone && s.active && !s.brain.engaged);
        const s = cand[Math.floor(rnd() * cand.length)];
        const p = s && g.nav.randomPointNear(s.position.x, s.position.z, 20, rnd);
        if (p && s) {
          s.brain.lastSeenPos.x = p.x;
          s.brain.lastSeenPos.z = p.z;
          s.brain.lastSeenVel.x = s.brain.lastSeenVel.z = 0;
          s.brain.lastSeenTime = g.time;
          s.brain.enterChase();
        }
      }
      if (alarm && t > nextAlarm) {
        nextAlarm = t + 70 + rnd() * 30;
        if (alarm.armed && !alarm.active) g.level.startAlarm(alarm);
      }
    };
    const t0 = performance.now();
    D.perf.maxPathMs = 0;
    D.perf.paths = 0;
    D.perf.pathMs = 0;
    while (t < minutes * 60) step(true);
    const tStir = t;
    const calm = () => !g.director.calling && mine.every((s) => !s.active || s.state === 'idle' || s.state === 'patrol');
    while (t < tStir + settle && !(t > tStir + 5 && calm())) step(false);
    const settleTime = t - tStir;
    for (let k = 0; k < 90; k++) step(false); // and a few more seconds on post
    const wall = performance.now() - t0;
    const out = [];
    for (const s of mine) {
      const st = stat.get(s);
      const b = s.brain;
      let home = '';
      const es = b.state === 'rapture' && b.resume?.state === 'calm' ? ((b.kind === 'wander' || b.route) && !b.sleeper ? 'patrol' : 'idle') : b.state;
      if (es === 'idle') home = Math.hypot(s.position.x - b.post.x, s.position.z - b.post.z) < 1.5 ? 'on post' : `OFF POST ${Math.hypot(s.position.x - b.post.x, s.position.z - b.post.z).toFixed(1)} m`;
      else if (es === 'patrol') home = 'on route';
      else home = `STILL ${b.state}`;
      out.push({ ...st, end: b.state, home, stuckEvents: s.stuckEvents, asleep: b.asleep, x: +s.position.x.toFixed(1), z: +s.position.z.toFixed(1) });
    }
    slow.sort((a, b) => parseFloat(b) - parseFloat(a));
    return { slowFrames, frames, slow: slow.slice(0, 8), nslow: slow.length, zone, wall, settleTime, calls, stimuli, paths: D.perf.paths, maxPathMs: +D.perf.maxPathMs.toFixed(1), meanPathMs: +(D.perf.pathMs / Math.max(1, D.perf.paths)).toFixed(2), maxDirMs: +D.perf.maxMs.toFixed(1), out };
  }, [zone, minutes, settle, AREAS[zone]]);
  console.log(`\nZ${zone}: ${minutes} min stirred, all calm ${r.settleTime.toFixed(0)} s later (${(r.wall / 1000).toFixed(0)} s wall), ${r.stimuli} bottles, ${r.calls} calls, ${r.paths} paths (mean ${r.meanPathMs} ms, max ${r.maxPathMs} ms), director max ${r.maxDirMs} ms/frame (${r.slowFrames} of ${r.frames} frames over 8 ms)`);
  if (r.nslow) console.log(`  path searches > 3 ms: ${r.nslow}\n    ` + r.slow.join('\n    '));
  for (const s of r.out) {
    const bad = s.maxStall > 3 || !/on (post|route)/.test(s.home);
    if (bad) failed++;
    const states = Object.entries(s.states).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ');
    console.log(`  ${bad ? 'FAIL' : 'ok  '} ${s.id.padEnd(13)} ${s.kind.padEnd(7)} walked ${s.dist.toFixed(0).padStart(4)} m  maxStall ${s.maxStall.toFixed(1)} s  unstuck ${s.stuckEvents}  needle ${s.needle.toFixed(1)} s  end ${s.home}${s.asleep ? ' (asleep)' : ''}`);
    if (verbose || bad) console.log(`       states: ${states}${s.stalls.length ? '\n       stalls: ' + s.stalls.join('; ') : ''}  at ${s.x},${s.z}`);
    if (bad) console.log('       trail: ' + s.trail.join('\n              '));
  }
  errors.push(...h.errors);
  await h.close();
}
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
console.log(failed ? `\n${failed} snatcher(s) FAILED` : '\nall snatchers kept moving and went home');
process.exitCode = failed || errors.length ? 1 : 0;
