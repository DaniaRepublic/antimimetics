// Game-flow checks in the real level, driven by the playtest bot (tools/playtest-bot.mjs):
//   * death cam: during 'caught' the catcher is in 'grab', standing still 1.0-1.15 m from the
//     player, facing them, its face (getHeadPos) a safe distance in front of the camera;
//   * respawn: dying in each zone after messing it up (bottle picked up and thrown, the zone's
//     alarm wailing, the gate cut) restores snatchers, alarms, gate, pickups, bottles, leviathan;
//   * checkpoints can't go backwards; the exit fires exactly once and leads to game:won.
//
//   node build.mjs && node tools/playtest-flow.mjs [--zones 1,2,3,4]
import { launch } from './harness.mjs';
import { installBot } from './playtest-bot.mjs';
import { CONFIG } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const zones = opt('--zones', '1,2,3,4').split(',').map(Number);

const results = [];
const check = (ok, name, detail = '') => {
  results.push({ ok, name });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`);
};
let errors = [];

// Per zone: a pickup to take, the alarm to set off, and a snatcher to walk into.
const ZONE = {
  1: { pickup: [11.3, -50.6], alarm: 'main_alarm', victim: 'z1_patrol' },
  2: { pickup: [17.6, -146.6], alarm: 'plaza_alarm', victim: 'z2_sentry_e' },
  3: { pickup: [-1.3, -250.5], alarm: null, victim: 'z3_devout_1' },
  4: { pickup: [-10.2, -349.8], alarm: null, victim: 'z4_patrol', gate: true },
};

for (const zone of zones) {
  console.log(`\nZ${zone}`);
  const h = await launch({ query: `autostart&quality=0&mute&cp=${zone}`, timeout: 120000 });
  await h.eval(installBot, [CONFIG, { fastModels: false }]);
  const r = await h.eval(([zone, Z]) => {
    const B = window.__bot, g = B.g, L = g.level;
    const tick = () => g.__realTick(B.DT);
    B.reset(zone);
    const cp = g.checkpoint;
    const cpBottles = g.checkpointBottles;
    const levBefore = { x: g.leviathan.position.x, z: g.leviathan.position.z };
    // --- mess the zone up (invulnerable while doing it) -------------------------------------
    B.run = { t: 0, frames: 0, log: [], timeLimit: 1e9, maxThreat: 0, chaseTime: 0, alerts: 0, alertIds: [], suspicious: 0, alarms: 0, checkpoints: [], exits: 0 };
    g.god = true;
    let picked = false;
    try {
      picked = B.pickup(Z.pickup[0], Z.pickup[1], { stance: 'walk' });
    } catch (e) {
      B.run.log.push('pickup threw ' + (e.reason || e));
    }
    const bottlesAfterPickup = g.player.bottles;
    g.player.yaw += 1;
    g.player.pitch = 0.3;
    B.press.add('KeyF');
    try { B.tick(); } catch { /* ignore */ }
    g.player.pitch = 0;
    for (let i = 0; i < 60; i++) tick();
    const alarm = Z.alarm && L.alarms.find((a) => a.id === Z.alarm);
    if (alarm) L.startAlarm(alarm);
    if (Z.gate) L.openGate();
    for (let i = 0; i < 30; i++) tick();
    const messed = {
      picked, bottlesAfterPickup, bottlesNow: g.player.bottles,
      alarmActive: alarm ? alarm.active : null, gateOpen: L.gate.open,
      takenNow: L.pickups.filter((p) => p.taken).length,
    };
    // --- get caught: walk upright straight at the victim ------------------------------------
    g.god = false;
    const victim = B.s(Z.victim);
    let caughtAt = null;
    let path = null, pi = 0;
    for (let i = 0; i < 30 * 60 && g.state === 'playing'; i++) {
      const p = g.player.position;
      if (i % 15 === 0) {
        path = g.nav.findPath(p, victim.position) || [{ x: victim.position.x, z: victim.position.z }];
        pi = 0;
      }
      while (pi < path.length - 1 && Math.hypot(path[pi].x - p.x, path[pi].z - p.z) < 0.5) pi++;
      const wp = Math.hypot(victim.position.x - p.x, victim.position.z - p.z) < 4 ? victim.position : path[pi];
      g.player.yaw = B.dirToYaw(wp.x - p.x, wp.z - p.z);
      g.input.keys.clear();
      g.input.keys.add('KeyW');
      if (g.player.crouched) g.input.pressedKeys.add('KeyC');
      tick();
    }
    // --- the death cam ----------------------------------------------------------------------
    const cam = { frames: 0, notGrab: 0, maxSpeed: 0, minD: 99, maxD: 0, maxFacing: 0, minHead: 99, maxHead: 0, by: g.caughtBy?.id, startD: null };
    const V = window.__THREE_V;
    const head = new V(), eye = new V();
    g.input.keys.clear();
    while (g.state === 'caught') {
      tick();
      const e = g.caughtBy;
      if (!e) break;
      const p = g.player.position;
      const dx = p.x - e.position.x, dz = p.z - e.position.z;
      const d = Math.hypot(dx, dz);
      if (cam.startD === null) cam.startD = d;
      cam.frames++;
      if (e.state !== 'grab') cam.notGrab++;
      cam.maxSpeed = Math.max(cam.maxSpeed, e.speed, e.actualSpeed);
      if (cam.frames > 3) {
        cam.minD = Math.min(cam.minD, d);
        cam.maxD = Math.max(cam.maxD, d);
      }
      const want = Math.atan2(-dx, -dz);
      const err = Math.abs(Math.atan2(Math.sin(want - e.yaw), Math.cos(want - e.yaw)));
      if (cam.frames > 10) cam.maxFacing = Math.max(cam.maxFacing, err);
      e.getHeadPos(head);
      g.player.getEyePos(eye);
      const hd = head.distanceTo(eye);
      if (cam.frames > 30) cam.minHead = Math.min(cam.minHead, hd);
      cam.maxHead = Math.max(cam.maxHead, hd);
    }
    const stateAfter = g.state;
    // --- respawn ----------------------------------------------------------------------------
    g.respawn();
    tick();
    const sn = g.director.snatchers.map((s) => ({
      id: s.id, off: Math.hypot(s.position.x - s.def.pos.x, s.position.z - s.def.pos.z), state: s.state, det: s.detection, asleep: s.brain.asleep, sleeper: !!s.def.sleeping,
    }));
    const restored = {
      cp: g.checkpoint.id, expectCp: cp.id,
      pos: Math.hypot(g.player.position.x - cp.pos.x, g.player.position.z - cp.pos.z),
      bottles: g.player.bottles, cpBottles,
      alarms: L.alarms.map((a) => ({ id: a.id, armed: a.armed, active: a.active })),
      gateOpen: L.gate.open, gateSolid: L.gate.collider.enabled, gateInteract: L.gate.interactable.enabled,
      gateNavBlocked: !g.nav.isWalkable(0, -395),
      pickupsTaken: L.pickups.filter((p) => p.taken && !p.committed).length,
      projectiles: g.projectiles.items.length,
      levCalling: g.leviathan.calling, noiseMask: g.noiseMask,
      levMoved: Math.hypot(g.leviathan.position.x - levBefore.x, g.leviathan.position.z - levBefore.z),
      directorCalling: g.director.calling, caughtBy: g.director.caughtBy, threat: g.director.threat,
      state: g.state, stateAfter,
      badSnatchers: sn.filter((s) => s.off > 0.05 || !['idle', 'patrol', 'rapture'].includes(s.state) || s.det > 0 || s.asleep !== s.sleeper).map((s) => `${s.id}:${s.state}/${s.off.toFixed(2)}`),
    };
    // --- checkpoints can't go backwards -------------------------------------------------------
    const prev = L.checkpoints[Math.max(0, zone - 1)];
    g.bus.emit('level:checkpoint', { checkpoint: prev });
    const cpKept = g.checkpoint.id === cp.id;
    B.run = null;
    return { messed, cam, restored, cpKept, log: [] };
  }, [zone, ZONE[zone]]);

  const m = r.messed;
  check(m.picked && m.bottlesAfterPickup === r.restored.cpBottles + 1, 'messed up: picked a bottle up', JSON.stringify(m));
  const c = r.cam;
  check(c.frames > 30 && c.notGrab === 0, `death cam: caught by ${c.by}, in 'grab' throughout (${c.frames} frames)`);
  check(c.maxSpeed < 0.05, `death cam: catcher stands still (max speed ${c.maxSpeed.toFixed(3)} m/s)`);
  check(c.minD >= 0.99 && c.maxD <= 1.16 && c.startD >= 0.95, `death cam: root 1.0-1.15 m from the player after 0.1 s (first frame ${c.startD?.toFixed(2)}, then ${c.minD.toFixed(2)}..${c.maxD.toFixed(2)})`);
  check(c.maxFacing < 0.35, `death cam: faces the player (max error ${c.maxFacing.toFixed(2)} rad)`);
  check(c.minHead > 0.3, `death cam: face stays in front of the camera (head-eye ${c.minHead.toFixed(2)}..${c.maxHead.toFixed(2)} m)`);
  const R = r.restored;
  check(R.stateAfter === 'dead' && R.state === 'playing', `caught -> dead -> respawn -> playing (${R.stateAfter}, ${R.state})`);
  check(R.cp === R.expectCp && R.pos < 0.01, `respawn at checkpoint ${R.cp}`);
  check(R.badSnatchers.length === 0, `respawn: every snatcher back on its spawn, calm, detection 0 ${R.badSnatchers.join(' ')}`);
  check(R.bottles === R.cpBottles, `respawn: bottles = checkpoint count (${R.bottles}/${R.cpBottles})`);
  check(R.pickupsTaken === 0, 'respawn: pickups taken since the checkpoint are back');
  check(R.alarms.every((a) => a.armed && !a.active), `respawn: alarms re-armed and quiet ${JSON.stringify(R.alarms)}`);
  check(!R.gateOpen && R.gateSolid && R.gateInteract && R.gateNavBlocked, `respawn: gate closed, solid, cuttable, nav blocked (gate was ${m.gateOpen ? 'open' : 'closed'})`);
  check(!R.levCalling && R.noiseMask === 0 && !R.directorCalling && !R.caughtBy && R.threat === 0 && R.projectiles === 0, 'respawn: leviathan quiet, no mask, director clear, no bottles in flight');
  check(r.cpKept, 'an earlier checkpoint cannot replace the current one');
  errors = errors.concat(h.errors);
  await h.close();
}

// --- the exit fires once, game:won follows --------------------------------------------------
{
  console.log('\nexit');
  const h = await launch({ query: 'autostart&quality=0&mute&cp=4', timeout: 120000 });
  await h.eval(installBot, [CONFIG, { fastModels: true }]);
  const r = await h.eval(() => {
    const B = window.__bot, g = B.g;
    const n = { exit: 0, won: 0, cp: [] };
    g.bus.on('level:exit', () => n.exit++);
    g.bus.on('game:won', () => n.won++);
    g.bus.on('level:checkpoint', (e) => n.cp.push(e.checkpoint.id));
    B.reset(4);
    g.god = true;
    B.run = { t: 0, frames: 0, log: [], timeLimit: 1e9, maxThreat: 0, chaseTime: 0, alerts: 0, alertIds: [], suspicious: 0, alarms: 0, checkpoints: [], exits: 0, continueAfterGoal: true };
    let err = null;
    try {
      B.path([[-15.2, -343], [-27.6, -349], [-28.1, -419], [-17, -421], [-12.4, -420.8], [-6, -425], [-2.5, -436]], { stance: 'walk' });
      B.wait(3);
    } catch (e) {
      err = String(e.reason || e);
    }
    B.run = null;
    return { n, state: g.state, z: g.player.position.z, err };
  });
  check(r.n.exit === 1 && r.n.won === 1 && r.state === 'won', `level:exit x${r.n.exit}, game:won x${r.n.won}, state ${r.state} (z ${r.z.toFixed(1)})${r.err ? ' err ' + r.err : ''}`);
  errors = errors.concat(h.errors);
  await h.close();
}

// --- throwing at the plaza alarm car the way a person aims ------------------------------------
// From every side, standing or crouched: the crosshair on the middle of the car from 6-12 m, and
// a flat throw (pitch 0) from 8-14 m (where it used to sail over the roof). Every one of them is
// what a player would call "a hit" and must set it off.
{
  console.log('\nalarm car throws');
  const h = await launch({ query: 'autostart&god&quality=0&mute&cp=2', timeout: 120000 });
  await h.eval(installBot, [CONFIG, { fastModels: true }]);
  const r = await h.eval(() => {
    const B = window.__bot, g = B.g, L = g.level;
    const a = L.alarms.find((x) => x.id === 'plaza_alarm');
    const c = a.collider;
    let started = 0;
    g.bus.on('alarm:start', (e) => {
      if (e.id === a.id) started++;
    });
    const tick = () => g.__realTick(B.DT);
    const out = { aimed: [0, 0], flat: [0, 0], misses: [] };
    for (const crouch of [false, true]) {
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2 + 0.2;
        for (const dist of [6, 8, 10, 12, 14]) {
          const x = c.cx + Math.cos(ang) * dist, z = c.cz + Math.sin(ang) * dist;
          if (!g.nav.isWalkable(x, z)) continue;
          for (const mode of ['aimed', 'flat']) {
            if ((mode === 'aimed' && dist > 12) || (mode === 'flat' && dist < 8)) continue;
            L.stopAlarm(a, true);
            g.teleport(x, z, B.dirToYaw(c.cx - x, c.cz - z));
            g.player.crouched = crouch;
            for (let i = 0; i < 15; i++) tick();
            // Can the player see the car from here (a throw at something hidden doesn't count)?
            // (The aim point is inside the car's own collider, which must not count as cover.)
            const eye = g.player.getEyePos(new window.__THREE_V());
            if (g.world.segmentBlocked(eye, new window.__THREE_V(c.cx, 0.9, c.cz), { ignore: c })) continue;
            const d = Math.hypot(c.cx - x, c.cz - z);
            g.player.pitch = mode === 'flat' ? 0 : Math.atan2(0.75 - eye.y, d);
            g.player.bottles = 1;
            const before = started;
            g.input.pressedKeys.add('KeyF');
            for (let i = 0; i < 75; i++) tick();
            const hit = started > before;
            out[mode][1]++;
            if (hit) out[mode][0]++;
            else out.misses.push(`${mode}${crouch ? '/crouch' : ''} ${dist} m @${(ang * 57.3).toFixed(0)}deg`);
          }
        }
      }
    }
    // Crouched right against the car (using it as cover), throwing along it or away from it:
    // the bottle must not count as hitting the car it was thrown from beside.
    out.beside = [0, 0];
    const shortX = c.hx < c.hz;
    for (const side of [-1, 1]) {
      for (const dir of [[0, 1], [0, -1], [side, 0]]) {
        const off = (shortX ? c.hx : c.hz) + 0.4;
        const lx = shortX ? side * off : 0, lz = shortX ? 0 : side * off;
        const x = c.cx + c.cos * lx + c.sin * lz, z = c.cz - c.sin * lx + c.cos * lz;
        // dir is in car-local axes: [across, along] (across = away from the car on this side)
        const ax = shortX ? dir[0] : dir[1], az = shortX ? dir[1] : dir[0];
        const wx = c.cos * ax + c.sin * az, wz = -c.sin * ax + c.cos * az;
        L.stopAlarm(a, true);
        g.teleport(x, z, Math.atan2(-wx, -wz));
        g.player.crouched = true;
        for (let i = 0; i < 15; i++) tick();
        g.player.pitch = 0.2;
        g.player.bottles = 1;
        const before = started;
        let landed = null;
        const un = g.bus.on('bottle:shatter', (e) => { landed = landed || e.pos; });
        g.input.pressedKeys.add('KeyF');
        for (let i = 0; i < 75; i++) tick();
        un();
        // (a bottle that smashes within a couple of metres of the car -- on a canopy pillar, say --
        // fairly sets it off: only count throws that landed well away)
        if (!landed || L.constructor.distToCollider(landed, c) < 3) continue;
        out.beside[1]++;
        if (started > before) out.beside[0]++;
      }
    }
    L.stopAlarm(a, true);
    return out;
  });
  // (at least a few throws from each kind: an empty sample is a broken test, not a pass)
  check(r.aimed[1] >= 8 && r.aimed[0] === r.aimed[1], `aimed at the car: ${r.aimed[0]}/${r.aimed[1]} set the alarm off`);
  check(r.flat[1] >= 8 && r.flat[0] === r.flat[1], `flat throws: ${r.flat[0]}/${r.flat[1]} set it off${r.misses.length ? ' (missed: ' + r.misses.slice(0, 8).join(', ') + ')' : ''}`);
  check(r.beside[1] >= 4 && r.beside[0] === 0, `throws away from the car while crouched right beside it: ${r.beside[0]}/${r.beside[1]} set it off (none should)`);
  errors = errors.concat(h.errors);
  await h.close();
}

const failed = results.filter((x) => !x.ok).length;
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall flow checks passed');
process.exitCode = failed || errors.length ? 1 : 0;
