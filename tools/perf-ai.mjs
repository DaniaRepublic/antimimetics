// Node micro-benchmark of the snatcher AI (Director + Brain + Snatcher) on a full-size test city
// (440 m route, buildings, wrecked cars) with the visual model stubbed out, so the numbers are the
// AI's own cost. Usage: node tools/perf-ai.mjs [--snatchers 16] [--seconds 60]
import { register } from 'node:module';

const threeUrl = import.meta.resolve('three');
const stub = `
import * as THREE from '${threeUrl}';
export function createSnatcherModel() {
  const root = new THREE.Group();
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = 2.05;
  root.add(headAnchor);
  return { root, headAnchor, update() {}, dispose() {} };
}`;
const hook = `
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('snatcherModel.js')) return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
  return next(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hook));

const THREE = await import('three');
const { EventBus } = await import('../src/core/events.js');
const { CollisionWorld } = await import('../src/core/collision.js');
const { NavGrid } = await import('../src/core/nav.js');
const { makeRng } = await import('../src/core/math.js');
const { CONFIG } = await import('../src/config.js');
const { Director } = await import('../src/ai/director.js');

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const COUNT = opt('--snatchers', 16);
const SECONDS = opt('--seconds', 60);
const DT = 1 / 60;

// --- a city: a 30 m wide street from z = 0 to z = -440, side streets, cars, a few lights -----
const world = new CollisionWorld();
const rng = makeRng(7);
for (let z = 0; z > -440; z -= 40) {
  world.addBox({ x: -35, z: z - 17, w: 40, d: 30, h: 20 });
  world.addBox({ x: 35, z: z - 17, w: 40, d: 30, h: 20 });
}
for (let i = 0; i < 70; i++) {
  world.addBox({ x: rng.range(-12, 12), z: rng.range(-430, -10), w: 1.9, d: 4.4, h: 1.45, rot: rng.range(-1, 1) });
}
const bounds = { minX: -60, maxX: 60, minZ: -445, maxZ: 5 };
const tNav = performance.now();
const nav = new NavGrid(world, bounds, CONFIG.nav);
nav.build();
const navMs = performance.now() - tNav;

// --- a minimal game: the fields the AI reads -----------------------------------------------------
class FakePlayer {
  constructor() {
    this.position = new THREE.Vector3(0, 0, -5);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.eyeHeight = 1.65;
    this.crouched = false;
    this.mode = 'walk';
    this.speed = 3;
    this.lightLevel = 0.3;
    this.stepDist = 0;
  }
  getEyePos(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.eyeHeight, this.position.z);
  }
  getChestPos(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.eyeHeight * 0.62, this.position.z);
  }
}
const game = {
  bus: new EventBus(),
  world,
  nav,
  scene: new THREE.Scene(),
  player: new FakePlayer(),
  time: 0,
  state: 'playing',
  god: true,
  debug: false,
  noiseMask: 0,
  atmosphere: { lightLevelAt: () => 0.3, setThreat() {} },
  level: { enemies: [], currentZone: 1 },
};
const zoneOf = (z) => Math.min(4, Math.floor(-z / 88));
for (let i = 0; i < COUNT; i++) {
  const z = -20 - (i / COUNT) * 240;
  const x = rng.range(-10, 10);
  const kind = ['patrol', 'sentry', 'wander', 'devout'][i % 4];
  const def = { id: `s${i}`, zone: zoneOf(z), kind, pos: { x, z }, yaw: rng.range(-3, 3), scanArc: 1.6 };
  if (kind === 'patrol') def.route = [{ x, z }, { x: -x, z: z - 30 }, { x: x * 0.5, z: z - 55 }];
  if (kind === 'wander') def.radius = 10;
  if (i % 7 === 6) def.sleeping = true;
  game.level.enemies.push(def);
}
// Record the slowest searches (who asked, how far, how long).
const slowPaths = [];
const findPath = nav.findPath.bind(nav);
nav.findPath = (from, to, o) => {
  const t0 = performance.now();
  const p = findPath(from, to, o);
  const ms = performance.now() - t0;
  slowPaths.push({ ms, d: Math.hypot(to.x - from.x, to.z - from.z), wp: p ? p.length : -1, f: frameNo });
  return p;
};
let frameNo = 0;
const director = new Director(game);
game.director = director;
director.reset();

// The player walks up the street weaving between cars, making footstep noise like the real one.
const route = [];
for (let z = -5; z > -260; z -= 12) route.push({ x: rng.range(-9, 9), z });
let ri = 0;
const counts = { alert: 0, suspicious: 0 };
game.bus.on('enemy:alert', () => counts.alert++);
game.bus.on('enemy:suspicious', () => counts.suspicious++);

const frames = Math.round(SECONDS / DT);
const times = new Float64Array(frames);
for (let f = 0; f < frames; f++) {
  frameNo = f;
  game.time += DT;
  const p = game.player;
  const t = route[ri];
  const dx = t.x - p.position.x, dz = t.z - p.position.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) ri = (ri + 1) % route.length;
  else {
    p.velocity.set((dx / d) * 3, 0, (dz / d) * 3);
    p.position.addScaledVector(p.velocity, DT);
    world.resolveCircle(p.position, 0.35);
    p.yaw = Math.atan2(-dx, -dz);
    p.stepDist += 3 * DT;
    if (p.stepDist > 0.95) {
      p.stepDist = 0;
      game.bus.emit('noise', { pos: p.position.clone(), radius: CONFIG.noise.walkStep, loudness: 0.4, source: 'player' });
    }
  }
  game.level.currentZone = zoneOf(p.position.z);
  const t0 = performance.now();
  director.update(DT);
  times[f] = performance.now() - t0;
}

const sorted = Array.from(times).sort((a, b) => a - b);
const avg = sorted.reduce((a, b) => a + b, 0) / frames;
const pct = (q) => sorted[Math.floor(frames * q)];
const states = {};
for (const s of director.snatchers) states[s.state] = (states[s.state] || 0) + 1;
console.log(`nav grid ${nav.w}x${nav.h} built in ${navMs.toFixed(1)} ms; ${COUNT} snatchers; ${frames} frames @60 Hz`);
console.log(`director.update: avg ${avg.toFixed(3)} ms, p50 ${pct(0.5).toFixed(3)}, p95 ${pct(0.95).toFixed(3)}, p99 ${pct(0.99).toFixed(3)}, max ${sorted[frames - 1].toFixed(3)} ms`);
const worst = Array.from(times, (ms, i) => [ms, i]).sort((a, b) => b[0] - a[0]).slice(0, 5);
console.log(`worst frames: ${worst.map(([ms, i]) => `${ms.toFixed(2)} ms @f${i}`).join(', ')}`);
console.log(`findPath: ${director.perf.paths} calls, avg ${(director.perf.pathMs / Math.max(1, director.perf.paths)).toFixed(3)} ms, max ${director.perf.maxPathMs.toFixed(3)} ms`);
slowPaths.sort((a, b) => b.ms - a.ms);
console.log(`slowest searches: ${slowPaths.slice(0, 4).map((p) => `${p.ms.toFixed(2)} ms (${p.d.toFixed(0)} m, ${p.wp} wp, f${p.f})`).join(', ')}`);
console.log(`events: ${counts.suspicious} suspicious, ${counts.alert} alerts; end states ${JSON.stringify(states)}`);
// A sentry dragged ~200 m from its post (a very long chase) must still find its way home.
const far = director.snatchers.find((s) => s.def.kind === 'sentry' && !s.def.sleeping);
far.position.set(4, 0, -425);
far.brain.enterReturn({ disappointed: true });
game.player.position.set(0, 0, -440);
game.state = 'won'; // nobody perceives the player while we watch it walk home
let homeAt = null;
const trail = [];
let lastKey = '';
let returnWorst = 0;
for (let f = 0; f < 60 * 600 && homeAt === null; f++) {
  game.time += DT;
  const t0 = performance.now();
  director.update(DT);
  returnWorst = Math.max(returnWorst, performance.now() - t0);
  const key = `${far.state}/${far.brain.phase}${far.pathFailed ? '!' : ''}`;
  if (key !== lastKey && trail.length < 30) trail.push(`${(f * DT).toFixed(0)}s ${key} z=${far.position.z.toFixed(0)} hops=${far.hops}`);
  lastKey = key;
  if (far.state === 'idle' && Math.hypot(far.position.x - far.def.pos.x, far.position.z - far.def.pos.z) < 1.2) homeAt = f * DT;
}
if (args.includes('--trail')) console.log(trail.join('\n'));
const d0 = Math.hypot(4 - far.def.pos.x, -425 - far.def.pos.z);
console.log(`long return: ${d0.toFixed(0)} m -> ${homeAt === null ? `NOT home (state ${far.state}, ${Math.hypot(far.position.x - far.def.pos.x, far.position.z - far.def.pos.z).toFixed(1)} m away)` : `home after ${homeAt.toFixed(0)} s`}, worst frame meanwhile ${returnWorst.toFixed(2)} ms`);
const ok = avg < 1.5 && homeAt !== null;
console.log(ok ? 'PASS' : 'FAIL');
if (!ok) process.exitCode = 1;
