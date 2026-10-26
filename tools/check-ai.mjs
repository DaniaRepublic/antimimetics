// Headless scenario tests for the snatcher AI (src/ai/*). Drives window.__game with game.tick()
// in a fresh page per scenario and prints a pass/fail table.
//
//   node build.mjs && node tools/check-ai.mjs [--only 1,5] [--shots]
//
// Each scenario runs on its own isolated test bed, independent of whatever level is built in:
// every level collider is disabled and replaced by a 20 m wide walled street (x in [-10, 10],
// z in [-112, 12]) with two parked cars, a fresh NavGrid is built over it, the level's update and
// the leviathan are frozen (scenarios emit call/alarm events themselves), and a fresh Director is
// spawned from the scenario's enemy defs (zone-less, so zone LOD never interferes).
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',').map(Number) : null;
const shots = args.includes('--shots');
const html = 'dist/index.html';

// Installed into the page once per scenario: helpers on window.__t.
const HELPERS = () => {
  const g = window.__game;
  const T = { g, events: [] };
  const types = ['enemy:suspicious', 'enemy:alert', 'enemy:lost', 'enemy:giveup', 'player:caught'];
  for (const type of types) g.bus.on(type, (e) => T.events.push({ type, t: +g.time.toFixed(2), id: e.enemy?.id }));
  T.ev = (type, id) => T.events.filter((e) => e.type === type && (!id || e.id === id));
  T.dirToYaw = (dx, dz) => Math.atan2(-dx, -dz);
  // A sentry with no sweep, facing south (+Z) unless told otherwise.
  T.sentryDef = (id, x, z, yaw = Math.PI, extra = {}) => ({ id, kind: 'sentry', pos: { x, z }, yaw, scanArc: 0, ...extra });

  T.setup = ({ enemies, boxes = [], light = 0.15, player = { x: 0, z: 0, yaw: 0 }, noEast = false, keepZones = false }) => {
    if (!T.bed) {
      T.bed = true;
      for (const c of g.world.colliders) g.world.setEnabled(c, false);
      const bed = [
        { x: -20, z: -50, w: 20, d: 128, h: 12 }, // west wall, inner face x = -10
        { x: 0, z: -114, w: 60, d: 4, h: 6 }, // north end
        { x: 0, z: 14, w: 60, d: 4, h: 6 }, // south end
        { x: -3, z: -25, w: 2, d: 4.5, h: 1.4, rot: 0.3 }, // parked cars
        { x: 4, z: -35, w: 2, d: 4.5, h: 1.4, rot: -0.2 },
      ];
      if (!noEast) bed.push({ x: 20, z: -50, w: 20, d: 128, h: 12 });
      for (const b of [...bed, ...boxes]) g.world.addBox(b);
      const nav = g.nav;
      g.nav = new nav.constructor(g.world, { minX: -40, maxX: 40, minZ: -120, maxZ: 16 }, { cell: nav.cell, agentRadius: nav.agentRadius });
      g.nav.build();
      g.level.update = () => {};
      if (g.leviathan) {
        g.leviathan.update = () => {};
        g.leviathan.calling = false;
      }
      g.noiseMask = 0;
    }
    g.director.dispose();
    g.level.enemies = keepZones ? enemies : enemies.map((d) => ({ ...d, zone: undefined }));
    g.director = new g.director.constructor(g);
    g.director.reset();
    T.light = light;
    g.atmosphere.lightLevelAt = () => T.light;
    g.teleport(player.x, player.z, player.yaw ?? 0);
    g.player.crouched = !!player.crouch;
    g.player.lightLevel = light;
    T.keys([]);
    T.t0 = g.time;
  };
  T.keys = (list) => {
    g.input.keys.clear();
    for (const k of list) g.input.keys.add(k);
  };
  T.s = (id) => g.director.snatchers.find((s) => s.id === id);
  T.now = () => g.time - T.t0;
  T.dist = (s, x, z) => Math.hypot(s.position.x - x, s.position.z - z);
  // Advance `seconds`; each(t) runs after every 1/30 s tick and may return true to stop early.
  T.run = (seconds, each) => {
    const step = 1 / 30;
    const n = Math.ceil(seconds / step);
    for (let i = 0; i < n; i++) {
      g.tick(step);
      if (T.driving) T.steer();
      if (each && each(T.now())) return true;
    }
    return false;
  };
  // Steer the player along points with real input (so footstep noise etc. happen).
  T.drive = (points, { sprint = false, crouch = false } = {}) => {
    T.driving = { points: points.slice(), sprint };
    g.player.crouched = crouch;
    T.steer();
  };
  T.steer = () => {
    const d = T.driving;
    const p = g.player.position;
    while (d.points.length && Math.hypot(d.points[0].x - p.x, d.points[0].z - p.z) < 0.6) d.points.shift();
    if (!d.points.length) {
      T.driving = null;
      T.keys([]);
      return;
    }
    const t = d.points[0];
    g.player.yaw = T.dirToYaw(t.x - p.x, t.z - p.z);
    T.keys(d.sprint ? ['KeyW', 'ShiftLeft'] : ['KeyW']);
  };
  T.stop = () => {
    T.driving = null;
    T.keys([]);
  };
  window.__t = T;
};

const scenarios = [
  {
    n: 1,
    name: 'lit standing player 8 m in front -> suspicious, then chase within ~2 s',
    run: () => {
      const T = window.__t;
      T.setup({ enemies: [T.sentryDef('a', 0, -60)], light: 0.8, player: { x: 0, z: -52 } });
      const s = T.s('a');
      let susp = null, alert = null;
      T.run(4, (t) => {
        if (susp === null && s.state === 'suspicious') susp = t;
        if (alert === null && s.state === 'chase') alert = t;
        return alert !== null;
      });
      const pass = susp !== null && alert !== null && susp < alert && alert <= 2.1 && alert >= 0.7;
      return { pass, detail: `suspicious @${susp?.toFixed(2)}s, chase @${alert?.toFixed(2)}s` };
    },
  },
  {
    n: 2,
    name: 'crouched behind a 1.5 m box -> never detected',
    run: () => {
      const T = window.__t;
      T.setup({
        enemies: [T.sentryDef('a', 0, -60)],
        boxes: [{ x: 0, z: -53, w: 3, d: 1.2, h: 1.5 }],
        light: 0.8,
        player: { x: 0, z: -52, crouch: true },
      });
      const s = T.s('a');
      let maxDet = 0, states = new Set();
      T.run(12, () => {
        maxDet = Math.max(maxDet, s.detection);
        states.add(s.state);
      });
      return { pass: maxDet < 0.02 && states.size === 1, detail: `max detection ${maxDet.toFixed(3)}, states ${[...states]}` };
    },
  },
  {
    n: 3,
    name: 'crouched in darkness, 20 m, periphery -> not detected for > 6 s',
    run: () => {
      const T = window.__t;
      T.setup({ enemies: [T.sentryDef('a', -8, -60)], light: 0.15, player: { x: 6, z: -45, crouch: true } });
      const s = T.s('a');
      let susp = null, maxDet = 0;
      T.run(12, (t) => {
        maxDet = Math.max(maxDet, s.detection);
        if (susp === null && s.state !== 'idle') susp = t;
      });
      const dx = 6 + 8, dz = 15;
      return {
        pass: susp === null || susp > 6,
        detail: `dist ${Math.hypot(dx, dz).toFixed(1)} m @ ${((Math.atan2(dx, dz) * 180) / Math.PI).toFixed(0)}deg; first reaction ${susp === null ? 'never (12 s)' : susp.toFixed(1) + 's'}; max det ${maxDet.toFixed(2)}`,
      };
    },
  },
  {
    n: 4,
    name: 'bottle shatter -> investigate, look around, return to post',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -60)], light: 0.15, player: { x: 0, z: -5 } });
      const s = T.s('a');
      T.run(1);
      g.projectiles.shatter({ x: 6, y: 0.03, z: -50 }, null);
      let inv = null, near = null, ret = null, home = null, maxDet = 0;
      T.run(60, (t) => {
        maxDet = Math.max(maxDet, s.detection);
        if (inv === null && s.state === 'investigate') inv = t;
        if (near === null && T.dist(s, 6, -50) < 1.6) near = t;
        if (ret === null && s.state === 'return') ret = t;
        if (ret !== null && home === null && s.state === 'idle') home = t;
        return home !== null && t > home + 1;
      });
      const atPost = T.dist(s, 0, -60);
      const look = ret !== null && near !== null ? ret - near : 0;
      return {
        pass: inv !== null && inv < 2.5 && near !== null && look > 4 && home !== null && atPost < 1 && maxDet < 0.3,
        detail: `investigate @${inv?.toFixed(1)}s, at spot @${near?.toFixed(1)}s, looked ${look.toFixed(1)}s, home @${home?.toFixed(1)}s (${atPost.toFixed(2)} m from post), max det ${maxDet.toFixed(2)}`,
      };
    },
  },
  {
    n: 5,
    name: 'car alarm 40 m away pulls a cluster of 3 off the exit and holds them',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const car = { x: 0, z: -52 };
      const exit = { x: 0, z: -92 };
      T.setup({
        enemies: [T.sentryDef('a', -2.5, -92), T.sentryDef('b', 1.5, -90, 0.4), T.sentryDef('c', 3, -94.5, -0.5)],
        boxes: [{ x: car.x, z: car.z, w: 2, d: 4.5, h: 1.4, data: { alarmCar: 'car1' } }],
        light: 0.15,
        player: { x: 0, z: -5 },
      });
      const ids = ['a', 'b', 'c'];
      g.bus.emit('alarm:start', { id: 'car1', pos: { x: car.x, y: 0, z: car.z }, duration: 14 });
      const arrive = {}, leave = {}, alarmState = {};
      let clearFrom = null, clearTo = null, nextNoise = 1;
      T.run(90, (t) => {
        if (t < 14 && t >= nextNoise) {
          nextNoise += 1;
          g.bus.emit('noise', { pos: { x: car.x, y: 0.8, z: car.z }, radius: 48, loudness: 1, source: 'alarm' });
        }
        if (t >= 14 && nextNoise < 100) {
          nextNoise = 100;
          g.bus.emit('alarm:end', { id: 'car1', pos: car });
        }
        let anyNearExit = false;
        for (const id of ids) {
          const s = T.s(id);
          if (alarmState[id] == null && s.state === 'alarm') alarmState[id] = t;
          const d = T.dist(s, car.x, car.z);
          if (arrive[id] == null && d < 6) arrive[id] = t;
          if (arrive[id] != null && leave[id] == null && d > 6) leave[id] = t;
          if (T.dist(s, exit.x, exit.z) < 12) anyNearExit = true;
        }
        if (!anyNearExit && clearFrom === null) clearFrom = t;
        if (anyNearExit && clearFrom !== null && clearTo === null) clearTo = t;
        return clearTo !== null && ids.every((id) => T.s(id).state === 'idle');
      });
      const stays = ids.map((id) => (leave[id] ?? 90) - (arrive[id] ?? 90));
      const allAlarm = ids.every((id) => alarmState[id] != null && alarmState[id] < 1);
      const allArrive = ids.every((id) => arrive[id] != null && arrive[id] < 22);
      const window_ = (clearTo ?? 90) - (clearFrom ?? 90);
      const home = ids.every((id) => T.s(id).state === 'idle');
      return {
        pass: allAlarm && allArrive && stays.every((x) => x >= 5) && window_ >= 15 && home,
        detail: `arrive ${ids.map((id) => arrive[id]?.toFixed(1)).join('/')}s, stayed ${stays.map((x) => x.toFixed(1)).join('/')}s, exit clear ${clearFrom?.toFixed(1)}..${clearTo?.toFixed(1)}s (${window_.toFixed(1)} s), back home ${home}`,
      };
    },
  },
  {
    n: 6,
    name: 'the call -> rapture (blind, detection decays), walk past in the open, resume',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -60), T.sentryDef('b', 6, -75)], light: 0.8, player: { x: 0, z: -28 } });
      const a = T.s('a'), b = T.s('b');
      T.run(1);
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      T.run(0.4);
      const rapt = a.state === 'rapture' && b.state === 'rapture';
      g.teleport(0, -51, Math.PI);
      T.drive([{ x: 3.5, z: -58 }, { x: 3.5, z: -64 }]);
      let maxDet = 0, broke = false;
      T.run(4.2, () => {
        maxDet = Math.max(maxDet, a.detection, b.detection);
        if (a.state !== 'rapture' || b.state !== 'rapture') broke = true;
      });
      T.stop();
      g.player.crouched = true;
      const posAtEnd = { x: g.player.position.x, z: g.player.position.z };
      g.bus.emit('leviathan:call:end', { pos: { x: 80, y: 110, z: -100 } });
      T.run(0.2);
      const resumed = a.state === 'idle' && b.state === 'idle';
      T.run(3);
      // Part 2: a chaser loses you to the call and searches.
      g.teleport(0, -52, 0);
      g.player.crouched = false;
      let chase = T.run(4, () => a.state === 'chase');
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      T.run(0.4);
      const chaserRapt = a.state === 'rapture';
      g.teleport(-8, -20, 0);
      T.run(4.2);
      g.bus.emit('leviathan:call:end', {});
      T.run(0.2);
      const searching = a.state === 'search';
      const pass = rapt && !broke && maxDet < 0.05 && resumed && chase && chaserRapt && searching;
      return {
        pass,
        detail: `rapture ${rapt}, held ${!broke}, max det during call ${maxDet.toFixed(3)}, player ended at (${posAtEnd.x.toFixed(1)}, ${posAtEnd.z.toFixed(1)}), resumed ${resumed}; chaser: rapture ${chaserRapt}, then ${a.state}`,
      };
    },
  },
  {
    n: 7,
    name: 'chase, sprint away + break LOS -> search -> giveup -> return to post',
    run: () => {
      const T = window.__t;
      const g = T.g;
      // Replace the east wall with blocks forming a T: an alley east at z -50..-44 (x 10..30),
      // and a corridor running south from it at x 16..22.
      T.setup({
        enemies: [T.sentryDef('a', -4, -70)],
        noEast: true,
        boxes: [
          { x: 20, z: -85, w: 20, d: 70, h: 12 },
          { x: 13, z: -12, w: 6, d: 64, h: 12 },
          { x: 26, z: -12, w: 8, d: 64, h: 12 },
          { x: 45, z: -50, w: 10, d: 140, h: 12 }, // far side of the escape strip
        ],
        light: 0.6,
        player: { x: -4, z: -60 },
      });
      // Lit around the sentry's post, dark everywhere else.
      g.atmosphere.lightLevelAt = (p) => (p.z < -52 && p.x < 9 ? 0.6 : 0.15);
      const s = T.s('a');
      const chased = T.run(5, () => s.state === 'chase');
      T.drive([{ x: 11, z: -47.5 }, { x: 18.5, z: -46.5 }, { x: 19, z: -38 }, { x: 19, z: 8 }], { sprint: true });
      let lost = null, giveup = null, home = null;
      const seq = [];
      T.run(110, (t) => {
        if (seq[seq.length - 1] !== s.state) seq.push(s.state);
        if (!T.driving && !g.player.crouched) g.player.crouched = true;
        if (lost === null && s.state === 'search') lost = t;
        if (giveup === null && lost !== null && s.state === 'return') giveup = t;
        if (giveup !== null && home === null && s.state === 'idle') home = t;
        return home !== null;
      });
      const atPost = T.dist(s, -4, -70);
      const order = T.events.filter((e) => e.id === 'a' && e.type !== 'enemy:suspicious').map((e) => e.type.split(':')[1]).join(' > ');
      return {
        pass: chased && lost !== null && giveup !== null && giveup - lost > 12 && home !== null && atPost < 1 && T.ev('player:caught').length === 0,
        detail: `${order}; search ${lost?.toFixed(1)}..${giveup?.toFixed(1)}s, home @${home?.toFixed(1)}s (${atPost.toFixed(2)} m); states ${seq.join('>')}`,
      };
    },
  },
  {
    n: 8,
    name: 'catch emits player:caught exactly once (two chasers)',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -62), T.sentryDef('b', 2.5, -63)], light: 0.8, player: { x: 0.5, z: -55 } });
      T.run(10);
      const caught = T.ev('player:caught');
      // While one has you, the other closes in and watches: no "lost"/"giveup" stings during the death.
      const after = caught.length ? T.events.filter((e) => e.t > caught[0].t && (e.type === 'enemy:lost' || e.type === 'enemy:giveup')) : [];
      const other = g.director.snatchers.find((s) => s.state !== 'grab');
      const otherGap = other ? T.dist(other, g.player.position.x, g.player.position.z) : 99;
      return {
        pass: caught.length === 1 && g.state !== 'playing' && g.director.snatchers.some((s) => s.state === 'grab') && after.length === 0 && otherGap < 3.2,
        detail: `player:caught x${caught.length} @${caught.map((e) => e.t + 's by ' + e.id).join(', ')}; game state ${g.state}; states ${g.director.snatchers.map((s) => s.state)}; other one ${otherGap.toFixed(1)} m away; lost/giveup during death x${after.length}`,
      };
    },
  },
  {
    n: 9,
    name: 'sprinting player outpaces a chaser; walking player gets caught',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const setup = () => {
        T.setup({ enemies: [T.sentryDef('a', 0, -70)], light: 0.8, player: { x: 0, z: -63 } });
        return T.run(4, () => T.s('a').state === 'chase');
      };
      const gap = () => T.dist(T.s('a'), g.player.position.x, g.player.position.z);
      const c1 = setup();
      const g0 = gap();
      T.drive([{ x: 0, z: 8 }], { sprint: true });
      T.run(4.5);
      const g1 = gap();
      T.stop();
      // Walking away from the same start.
      g.director.reset();
      g.teleport(0, -63, 0);
      const c2 = T.run(4, () => T.s('a').state === 'chase');
      const w0 = gap();
      T.drive([{ x: 0, z: 8 }]);
      let caughtAt = null;
      const tw = T.now();
      T.run(25, (t) => {
        if (T.ev('player:caught').length) {
          caughtAt = t - tw;
          return true;
        }
      });
      return {
        pass: c1 && c2 && g1 - g0 >= 5 && caughtAt !== null,
        detail: `sprint: gap ${g0.toFixed(1)} -> ${g1.toFixed(1)} m in 4.5 s; walk: gap ${w0.toFixed(1)} m, caught ${caughtAt !== null ? 'after ' + caughtAt.toFixed(1) + 's' : 'never'}`,
      };
    },
  },
  {
    n: 10,
    name: 'shriek alerts a second snatcher within 26 m to investigate (not chase); far one ignores',
    run: () => {
      const T = window.__t;
      T.setup({
        enemies: [T.sentryDef('a', 0, -62), T.sentryDef('b', -6, -80, 0), T.sentryDef('c', 6, -97, 0)],
        light: 0.8,
        player: { x: 0, z: -55 },
      });
      const a = T.s('a'), b = T.s('b'), c = T.s('c');
      T.run(4, () => a.state === 'chase');
      const bDist = T.dist(b, a.position.x, a.position.z), cDist = T.dist(c, a.position.x, a.position.z);
      T.run(1 / 30);
      const bState = b.state, bDet = b.detection;
      const later = [];
      T.run(4, () => {
        if (later[later.length - 1] !== b.state) later.push(b.state);
      });
      return {
        pass: (a.state === 'chase' || a.state === 'grab') && bState === 'investigate' && bDet >= 0.45 && c.state === 'idle' && T.ev('enemy:alert', 'c').length === 0,
        detail: `a ${a.state}; b (${bDist.toFixed(1)} m) -> ${bState} det ${bDet.toFixed(2)}, then ${later.join('>')}; c (${cDist.toFixed(1)} m) ${c.state}`,
      };
    },
  },
  {
    n: 11,
    name: '3-minute patrol/wander simulation around obstacles: nobody gets stuck',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const enemies = [
        { id: 'p1', kind: 'patrol', pos: { x: -6, z: -18 }, route: [{ x: -6, z: -18 }, { x: 6, z: -30 }, { x: -6, z: -45 }, { x: 6, z: -55 }], pause: 1.5 },
        { id: 'p2', kind: 'patrol', pos: { x: 0, z: -8 }, route: [{ x: 0, z: -8 }, { x: 0, z: -75 }], loop: false, pause: 2 },
        { id: 'p3', kind: 'patrol', pos: { x: -9, z: -60 }, route: [{ x: -9.2, z: -60 }, { x: 9.2, z: -60 }, { x: 9, z: -82 }, { x: -9, z: -82 }], pause: 0 },
        { id: 'p4', kind: 'patrol', pos: { x: 3, z: -100 }, route: [{ x: 3, z: -100 }, { x: -3, z: -24 }], pause: 0.5 },
        { id: 'p5', kind: 'patrol', pos: { x: -3, z: -70 }, route: [{ x: -3, z: -70 }, { x: 4, z: -27 }, { x: -1, z: -96 }], pause: 1 },
        { id: 'w1', kind: 'wander', pos: { x: 0, z: -40 }, radius: 12 },
        { id: 'w2', kind: 'wander', pos: { x: 0, z: -88 }, radius: 10 },
        { id: 'w3', kind: 'wander', pos: { x: 5, z: -66 }, radius: 7 },
        { id: 's1', kind: 'sentry', pos: { x: 0, z: -66 }, yaw: 0, scanArc: 1.4, scanPeriod: 7 },
      ];
      T.setup({
        enemies,
        boxes: [
          { x: -1, z: -66, w: 5, d: 1.2, h: 1.5, rot: 0.6 }, // a bench/planter in the middle
          { x: 6, z: -48, w: 2.6, d: 11, h: 3.2, rot: 0.25 }, // jack-knifed bus
          { x: -6, z: -86, w: 4, d: 4, h: 2.5 }, // kiosk
          { x: 2, z: -78, w: 1.8, d: 4.4, h: 1.4, rot: 1.2 }, // car
        ],
        light: 0.15,
        player: { x: 35, z: 0 },
      });
      const stats = {};
      for (const s of g.director.snatchers) stats[s.id] = { legs: 0, frozen: 0, maxFrozen: 0, lastPhase: s.brain.phase, dist: 0, px: s.position.x, pz: s.position.z };
      T.run(180, () => {
        for (const s of g.director.snatchers) {
          const st = stats[s.id];
          const moving = s.path && s.moveSpeed > 0.25 && !s.pathPending;
          if (moving && s.actualSpeed < 0.1) st.frozen += 1 / 30;
          else st.frozen = 0;
          st.maxFrozen = Math.max(st.maxFrozen, st.frozen);
          if (st.lastPhase === 'walk' && s.brain.phase === 'pause') st.legs++;
          st.lastPhase = s.brain.phase;
          st.dist += Math.hypot(s.position.x - st.px, s.position.z - st.pz);
          st.px = s.position.x;
          st.pz = s.position.z;
        }
      });
      const rows = g.director.snatchers.map((s) => {
        const st = stats[s.id];
        return { id: s.id, kind: s.def.kind, legs: st.legs, dist: Math.round(st.dist), stuckEvents: s.stuckEvents, maxFrozen: +st.maxFrozen.toFixed(2), state: s.state };
      });
      const ok = rows.every((r) => r.maxFrozen < 2 && (r.kind === 'sentry' || (r.legs >= 2 && r.dist > 100)) && r.stuckEvents <= 2);
      return {
        pass: ok,
        detail: rows.map((r) => `${r.id}:${r.legs}legs/${r.dist}m/stuck${r.stuckEvents}/frozen${r.maxFrozen}`).join(' '),
      };
    },
  },
  {
    n: 12,
    name: 'performance: 16 snatchers, director.update cost per frame',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const enemies = [];
      for (let i = 0; i < 16; i++) {
        const x = -8 + (i % 4) * 5.3, z = -15 - Math.floor(i / 4) * 22;
        if (i % 3 === 0) enemies.push({ id: 'p' + i, kind: 'patrol', pos: { x, z }, route: [{ x, z }, { x: -x, z: z - 18 }], pause: 1 });
        else if (i % 3 === 1) enemies.push({ id: 'w' + i, kind: 'wander', pos: { x, z }, radius: 8 });
        else enemies.push({ id: 's' + i, kind: i % 2 ? 'devout' : 'sentry', pos: { x, z }, yaw: i, scanArc: 2 });
      }
      T.setup({ enemies, light: 0.5, player: { x: 0, z: -40 } });
      g.god = true;
      // The AI's own cost: the skinned model animation (snatcherModel.js, ~0.2 ms per visible
      // snatcher) is measured by tools/check-snatcher-model.mjs, not here.
      for (const s of g.director.snatchers) s.model.update = () => {};
      // Player wanders through them so perception, hearing, chases and paths all run.
      T.drive([{ x: 6, z: -70 }, { x: -6, z: -95 }, { x: 0, z: -20 }, { x: 5, z: -60 }]);
      const p = g.director.perf;
      p.frames = 0;
      p.totalMs = 0;
      p.maxMs = 0;
      p.paths = 0;
      p.pathMs = 0;
      p.maxPathMs = 0;
      const times = [];
      T.run(60, () => {
        times.push(p.lastMs);
      });
      const worst = times.map((ms, i) => [ms, i]).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([ms, i]) => `${ms.toFixed(1)}@f${i}`);
      times.sort((a, b) => a - b);
      const avg = p.totalMs / p.frames;
      const p95 = times[Math.floor(times.length * 0.95)];
      const states = {};
      for (const s of g.director.snatchers) states[s.state] = (states[s.state] || 0) + 1;
      return {
        pass: avg < 1.5,
        detail: `avg ${avg.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${p.maxMs.toFixed(2)} ms over ${p.frames} frames (worst ${worst.join(' ')}); ${p.paths} findPath calls (${(p.pathMs / Math.max(1, p.paths)).toFixed(3)} ms avg, max ${p.maxPathMs.toFixed(2)}); alerts ${T.ev('enemy:alert').length}; end states ${JSON.stringify(states)}`,
      };
    },
  },
  {
    n: 13,
    name: 'sleeper: crouch past unnoticed, walking close wakes it (~1.5 s), it settles back to sleep',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('z', 0, -60, Math.PI, { sleeping: true })], light: 0.15, player: { x: -4, z: -48 } });
      const s = T.s('z');
      // Crouch-walk past its side at ~4 m.
      T.drive([{ x: -4, z: -56 }, { x: -4, z: -68 }], { crouch: true });
      let maxDet = 0;
      T.run(14, () => {
        maxDet = Math.max(maxDet, s.detection);
      });
      const sleptThrough = s.brain.asleep && s.state === 'idle';
      // Walk past at ~2.5 m.
      g.player.crouched = false;
      T.drive([{ x: -2.5, z: -60 }, { x: -2.5, z: -52 }, { x: -6, z: -40 }]);
      let woke = null, awake = null, acted = null, actedAs = null;
      T.run(12, (t) => {
        if (woke === null && !s.brain.asleep) {
          woke = t;
          T.stop();
          g.teleport(-8, 5, 0); // the player legs it the moment it stirs
        }
        if (woke !== null && awake === null && s.slump < 0.05) awake = t;
        if (acted === null && woke !== null && t > s.brain.wakeUntil - T.t0 && s.state !== 'idle') {
          acted = t;
          actedAs = s.state;
        }
      });
      T.stop();
      let resettled = null;
      T.run(70, (t) => {
        if (resettled === null && s.brain.asleep && s.state === 'idle') resettled = t;
        return resettled !== null;
      });
      return {
        pass: sleptThrough && maxDet < 0.3 && woke !== null && awake !== null && awake - woke > 1.0 && resettled !== null,
        detail: `crouch pass: asleep ${sleptThrough} (max det ${maxDet.toFixed(2)}); walk pass: woke @${woke?.toFixed(1)}s, upright @${awake?.toFixed(1)}s, then ${actedAs}; asleep again @${resettled?.toFixed(1)}s`,
      };
    },
  },
  {
    n: 14,
    name: 'bottle near a group of 3: only the nearest goes to look, the others turn their heads',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', -2, -60), T.sentryDef('b', 0, -62), T.sentryDef('c', 2.5, -60)], light: 0.15, player: { x: 0, z: -5 } });
      T.run(0.5);
      g.projectiles.shatter({ x: 8.5, y: 0.03, z: -61 }, null);
      const went = new Set();
      let facing = null;
      T.run(4, (t) => {
        for (const s of g.director.snatchers) if (s.state === 'suspicious' || s.state === 'investigate') went.add(s.id);
        if (facing === null && t > 2) {
          facing = g.director.snatchers
            .filter((s) => !went.has(s.id))
            .map((s) => Math.abs(Math.atan2(Math.sin(s.yaw + s.headYaw - T.dirToYaw(8.5 - s.position.x, -61 - s.position.z)), Math.cos(s.yaw + s.headYaw - T.dirToYaw(8.5 - s.position.x, -61 - s.position.z)))));
        }
      });
      return {
        pass: went.size === 1 && went.has('c') && facing.every((a) => a < 0.6),
        detail: `went to look: ${[...went]}; others' gaze error toward the bottle ${facing.map((a) => ((a * 180) / Math.PI).toFixed(0) + 'deg').join(', ')}`,
      };
    },
  },
  {
    n: 15,
    name: 'proximity: walking up behind is noticed, crouch-creeping to 2.6 m is not; HUD bearing sign',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -60)], light: 0.15, player: { x: 0, z: -72 } });
      const s = T.s('a');
      T.drive([{ x: 0, z: -62.6 }], { crouch: true });
      let maxCrouch = 0;
      T.run(10, () => {
        maxCrouch = Math.max(maxCrouch, s.detection);
      });
      const calmAfterCrouch = s.state === 'idle';
      g.director.reset();
      g.player.crouched = false;
      g.teleport(0, -72, Math.PI);
      T.drive([{ x: 0, z: -61.6 }]);
      let susp = null, chase = null;
      T.run(8, (t) => {
        if (susp === null && s.state === 'suspicious') susp = t;
        if (chase === null && s.state === 'chase') chase = t;
        return chase !== null;
      });
      // HUD bearing: facing east, a snatcher due north must be on the left (+).
      g.director.reset();
      g.teleport(0, -50, -Math.PI / 2);
      s.brain.detection = 0.5;
      const ind = g.director.getIndicators().find((i) => i.enemy === s);
      return {
        pass: calmAfterCrouch && maxCrouch < 0.3 && susp !== null && chase !== null && ind && Math.abs(ind.bearing - Math.PI / 2) < 0.1,
        detail: `crouch to 2.6 m behind: max det ${maxCrouch.toFixed(2)}, ${calmAfterCrouch ? 'calm' : s.state}; walking up: suspicious @${susp?.toFixed(1)}s, chase @${chase?.toFixed(1)}s; bearing ${ind?.bearing.toFixed(2)} (want +1.57)`,
      };
    },
  },
  {
    n: 16,
    name: 'gate chain cut (repeated noise for 3 s) -> nearby snatcher reacts at once and walks over',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -60), T.sentryDef('b', -5, -85, 0)], light: 0.15, player: { x: 0, z: 0 } });
      const gate = { x: 6, y: 1, z: -45 };
      const a = T.s('a');
      let next = 0, reacted = null, walking = null, near = null, back = null;
      T.run(60, (t) => {
        if (t < 3 && t >= next) {
          next += 0.4;
          g.bus.emit('noise', { pos: gate, radius: 22, loudness: 1, source: 'gate' });
        }
        if (reacted === null && a.state !== 'idle') reacted = t;
        if (walking === null && a.actualSpeed > 0.8) walking = t;
        if (near === null && T.dist(a, gate.x, gate.z) < 2) near = t;
        if (near !== null && back === null && a.state === 'idle') back = t;
        return back !== null;
      });
      const b = T.s('b');
      return {
        pass: reacted !== null && reacted < 0.5 && walking !== null && walking < 3.5 && near !== null && near < 15 && back !== null && b.state === 'idle',
        detail: `reacted @${reacted?.toFixed(1)}s, walking @${walking?.toFixed(1)}s, at gate @${near?.toFixed(1)}s, home @${back?.toFixed(1)}s; out-of-earshot b (${T.dist(b, gate.x, gate.z).toFixed(0)} m): ${b.state}`,
      };
    },
  },
  {
    n: 17,
    name: 'zone LOD: only zones within +-1 of the player think; waking mid-call raptures; reset() restores spawns',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const route = (x, z) => [{ x, z }, { x, z: z - 20 }];
      T.setup({
        keepZones: true,
        enemies: [
          { id: 'z0', zone: 0, kind: 'patrol', pos: { x: -6, z: -10 }, route: route(-6, -10), pause: 0.5 },
          { id: 'z1', zone: 1, kind: 'patrol', pos: { x: 0, z: -40 }, route: route(0, -40), pause: 0.5 },
          { id: 'z3', zone: 3, kind: 'patrol', pos: { x: 6, z: -80 }, route: route(6, -80), pause: 0.5 },
        ],
        player: { x: 35, z: 0 },
      });
      const moved = (s) => Math.hypot(s.position.x - s.def.pos.x, s.position.z - s.def.pos.z);
      g.level.currentZone = 0;
      T.run(8);
      const phase1 = { z0: moved(T.s('z0')) > 3, z1: moved(T.s('z1')) > 3, z3: moved(T.s('z3')) < 0.01 };
      // The player reaches zone 2 while the leviathan is calling: z3 wakes up straight into rapture.
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      g.level.currentZone = 2;
      T.run(1);
      const raptured = T.s('z3').state === 'rapture' && T.s('z1').state === 'rapture';
      const z0Frozen = T.s('z0').active === false;
      g.bus.emit('leviathan:call:end', {});
      T.run(6);
      const z3Moves = moved(T.s('z3')) > 2;
      g.director.reset();
      const home = g.director.snatchers.every((s) => moved(s) < 0.01 && (s.state === 'patrol' || s.state === 'idle') && s.detection === 0);
      return {
        pass: phase1.z0 && phase1.z1 && phase1.z3 && raptured && z0Frozen && z3Moves && home,
        detail: `cz=0: z0 moves ${phase1.z0}, z1 moves ${phase1.z1}, z3 frozen ${phase1.z3}; cz=2 mid-call: z3+z1 rapture ${raptured}, z0 dormant ${z0Frozen}; after call z3 moves ${z3Moves}; reset -> at spawn & calm ${home}`,
      };
    },
  },
  {
    n: 18,
    name: 'sound bends round a lamp pole and a statue (alarm still heard at 40 m) but a building muffles it',
    run: () => {
      const T = window.__t;
      const g = T.g;
      const car = { x: 0, y: 0.8, z: -30 };
      const alarm = () => {
        g.bus.emit('alarm:start', { id: 'car', pos: car, duration: 14 });
        T.run(1);
      };
      // A statue plinth (3.4 m wide, 5.2 m tall) and a lamp pole right on the line to the listener.
      T.setup({
        enemies: [T.sentryDef('a', 0, -70)],
        boxes: [{ x: 0, z: -45, w: 3.4, d: 3.4, h: 5.2 }, { x: 0, z: -58, w: 0.25, d: 0.25, h: 6 }],
        player: { x: 0, z: 5 },
      });
      const occl1 = T.s('a').brain.soundOccluded(car);
      alarm();
      const heard = T.s('a').state;
      // A 16 m wide building in between instead.
      g.director.reset();
      g.world.addBox({ x: 0, z: -50, w: 16, d: 6, h: 9 });
      const occl2 = T.s('a').brain.soundOccluded(car);
      alarm();
      const muffled = T.s('a').state;
      return {
        pass: !occl1 && heard === 'alarm' && occl2 && muffled === 'idle',
        detail: `pole + statue: occluded ${occl1}, listener -> ${heard}; building: occluded ${occl2}, listener -> ${muffled}`,
      };
    },
  },
  {
    n: 19,
    name: 'a sleeper woken by an alarm gets up (~1.5 s), then walks over and stares at it',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('z', 0, -60, Math.PI, { sleeping: true })], player: { x: 0, z: 5 } });
      const s = T.s('z');
      T.run(1);
      g.bus.emit('alarm:start', { id: 'car', pos: { x: 3, y: 0.8, z: -42 }, duration: 14 });
      let woke = null, moving = null, arrived = null, stare = null;
      T.run(20, (t) => {
        if (woke === null && !s.brain.asleep) woke = t;
        if (moving === null && s.actualSpeed > 0.5) moving = t;
        if (arrived === null && T.dist(s, 3, -42) < 5) arrived = t;
        if (arrived !== null && stare === null && s.brain.phase === 'stare') stare = t;
        return stare !== null && t > stare + 2;
      });
      return {
        pass: woke !== null && moving !== null && moving - woke >= 1.2 && arrived !== null && s.state === 'alarm',
        detail: `woke @${woke?.toFixed(1)}s, walking @${moving?.toFixed(1)}s, at the car @${arrived?.toFixed(1)}s, staring @${stare?.toFixed(1)}s, state ${s.state}`,
      };
    },
  },
  {
    n: 20,
    name: 'recovery: a jostled sentry steps back to its post; a patrol frozen mid-leg by a call carries on (no backtracking)',
    run: () => {
      const T = window.__t;
      const g = T.g;
      // The patrol walks between two points either side of a thick wall with a gap at its east end,
      // so each leg is a real (cached) path: round the corner, along the wall's end, round again.
      T.setup({
        enemies: [
          T.sentryDef('s', -6, -60),
          { id: 'p', kind: 'patrol', pos: { x: 0, z: -70 }, route: [{ x: 0, z: -70 }, { x: 0, z: -90 }], pause: 0.5 },
        ],
        boxes: [{ x: -1.5, z: -80, w: 15, d: 6, h: 2 }],
        player: { x: 35, z: 0 },
      });
      const s = T.s('s'), p = T.s('p');
      T.run(2);
      s.position.x += 2.2; // shoved off its spot
      T.run(6);
      const back = T.dist(s, -6, -60);
      // Wait until the patrol walks the southbound leg again (now from the cache) and is in the gap,
      // past the path's first corner. A stale cached leg would walk it back to that corner.
      const cachedLegs = () => g.director.pathCache.has('p:0') && g.director.pathCache.has('p:1');
      const midLeg = T.run(120, () => cachedLegs() && p.brain.routeIndex === 1 && p.brain.phase === 'walk' && p.position.x > 6 && p.position.z < -79.5 && p.position.z > -81.5);
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      T.run(5);
      g.bus.emit('leviathan:call:end', {});
      const stuckBefore = p.stuckEvents;
      let best = T.dist(p, 0, -90), backtrack = 0, arrived = null;
      const t1 = T.now();
      T.run(20, (t) => {
        const d = T.dist(p, 0, -90);
        best = Math.min(best, d);
        backtrack = Math.max(backtrack, d - best);
        if (arrived === null && d < 0.8) arrived = t - t1;
        return arrived !== null;
      });
      const stuck = p.stuckEvents - stuckBefore;
      return {
        pass: back < 0.6 && midLeg && backtrack < 0.5 && arrived !== null && stuck === 0,
        detail: `sentry ${back.toFixed(2)} m from its post after the shove; patrol mid-leg at the call ${midLeg}, walked back ${backtrack.toFixed(2)} m after it, at its route point ${arrived?.toFixed(1)}s after, stuck ${stuck}`,
      };
    },
  },
  {
    n: 21,
    name: 'pursuit cuts you off: a player walking across in front of a chaser is met, not trailed',
    run: () => {
      const T = window.__t;
      const g = T.g;
      // Chaser at the west wall; the player walks east across the street 9 m north of it.
      T.setup({ enemies: [T.sentryDef('a', -8, -50, 0)], light: 0.8, player: { x: -6, z: -59, yaw: -Math.PI / 2 } });
      const a = T.s('a');
      T.run(4, () => a.state === 'chase');
      const chasing = a.state === 'chase';
      T.drive([{ x: 9, z: -59 }]);
      // Where does it aim, relative to where the player is? Ahead (east) of them = intercept.
      let lead = 0, n = 0;
      const caught = T.run(6, () => {
        if (a.state === 'chase' && a.goal) {
          lead += a.goal.x - g.player.position.x;
          n++;
        }
        return g.state !== 'playing';
      });
      const meanLead = n ? lead / n : 0;
      return {
        pass: chasing && meanLead > 0.8 && caught,
        detail: `chasing ${chasing}; aims on average ${meanLead.toFixed(2)} m ahead of the player along their path; caught ${caught} (${g.state})`,
      };
    },
  },
  {
    n: 22,
    name: 'after a call, a chaser that sees you again resumes at once; one that does not, searches then gives up',
    run: () => {
      const T = window.__t;
      const g = T.g;
      T.setup({ enemies: [T.sentryDef('a', 0, -60), T.sentryDef('b', -6, -100, 0)], light: 0.8, player: { x: 0, z: -50 } });
      const a = T.s('a');
      T.run(4, () => a.state === 'chase');
      const chasing = a.state === 'chase';
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      T.run(0.5);
      // Walk away during the call, still in plain view.
      T.drive([{ x: 0, z: -35 }]);
      T.run(3.5);
      T.stop();
      g.bus.emit('leviathan:call:end', {});
      const tEnd = T.now();
      let resumedAt = null;
      T.run(3, (t) => {
        if (a.state === 'chase' && resumedAt === null) resumedAt = t - tEnd;
      });
      const alerts = T.ev('enemy:alert', 'a').length;
      // Part 2: the same, but hidden behind the parked car (x -3, z -25) when the call ends.
      g.god = true;
      T.setup({ enemies: [T.sentryDef('a', 0, -60), T.sentryDef('b', -6, -100, 0)], light: 0.8, player: { x: 0, z: -50 } });
      const a2 = T.s('a');
      T.run(4, () => a2.state === 'chase');
      g.bus.emit('leviathan:call:start', { pos: { x: 80, y: 110, z: -100 }, duration: 4.6 });
      T.run(0.5);
      g.teleport(-3.2, -21.2, 0);
      g.player.crouched = true;
      T.run(4);
      g.bus.emit('leviathan:call:end', {});
      T.run(1.5);
      const searching = a2.state === 'search';
      const gaveUp = T.run(40, () => a2.state === 'return' || a2.state === 'idle');
      g.god = false;
      return {
        pass: chasing && resumedAt !== null && resumedAt < 1.6 && alerts >= 2 && searching && gaveUp,
        detail: `in view: chase resumed ${resumedAt?.toFixed(2)} s after the call (alerts ${alerts}); hidden: ${searching ? 'searched' : a2.state}, then ${gaveUp ? 'gave up' : 'still ' + a2.state}`,
      };
    },
  },
];

// quality=0 (cheapest atmosphere) unless screenshots are wanted: the AI never reads the render.
const h = await launch({ html, query: shots ? 'autostart&mute' : 'autostart&mute&quality=0', timeout: 120000 });
const url = h.page.url();
const results = [];
for (const sc of scenarios) {
  if (only && !only.includes(sc.n)) continue;
  await h.page.goto(url, { timeout: 120000 });
  await h.page.waitForFunction(() => !!window.__game, null, { timeout: 120000 });
  await h.page.evaluate(HELPERS);
  const t0 = Date.now();
  let res;
  try {
    res = await h.page.evaluate(sc.run);
  } catch (err) {
    res = { pass: false, detail: 'threw: ' + err.message.split('\n')[0] };
  }
  if (shots) {
    await h.cam([0, 40, -20], [0, 0, -60]);
    await h.shot(`dist/shots/ai-${sc.n}.png`);
    await h.cam(null);
  }
  results.push({ n: sc.n, name: sc.name, ...res, ms: Date.now() - t0 });
  console.log(`${res.pass ? 'PASS' : 'FAIL'}  ${String(sc.n).padStart(2)}  ${sc.name}\n        ${res.detail}`);
}
await h.close();

console.log('\n  #  result  scenario');
for (const r of results) console.log(`${String(r.n).padStart(3)}  ${r.pass ? 'PASS  ' : 'FAIL  '}  ${r.name}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (h.errors.length) {
  console.log('CONSOLE ERRORS:\n' + h.errors.join('\n'));
  process.exitCode = 1;
}
if (failed) process.exitCode = 1;
