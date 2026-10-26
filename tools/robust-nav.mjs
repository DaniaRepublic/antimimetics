// Node unit test for src/core/nav.js and src/core/collision.js (no browser needed):
//  - Jump Point Search vs plain A* on random cluttered worlds: same reachability, same optimal
//    cell-path cost, every smoothed path walkable, nearestWalkable unchanged;
//  - CollisionWorld.updateBox / removeBox keep the spatial hash consistent.
//   node tools/robust-nav.mjs [--worlds 40] [--queries 60]
import { CollisionWorld } from '../src/core/collision.js';
import { NavGrid } from '../src/core/nav.js';
import { makeRng } from '../src/core/math.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const WORLDS = opt('--worlds', 40);
const QUERIES = opt('--queries', 60);

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures < 20) console.log('FAIL', msg);
};

const cellCost = (nav, cells) => {
  let c = 0;
  for (let i = 1; i < cells.length; i++) c += nav._octile(cells[i - 1], cells[i]);
  return c;
};

let tJps = 0, tRef = 0, n = 0;
for (let wi = 0; wi < WORLDS; wi++) {
  const rng = makeRng(1000 + wi);
  const world = new CollisionWorld();
  const W = 40 + rng() * 60, D = 60 + rng() * 140;
  const boxes = 10 + Math.floor(rng() * 80);
  for (let i = 0; i < boxes; i++) {
    world.addBox({ x: rng() * W, z: rng() * D, w: 0.5 + rng() * 10, d: 0.5 + rng() * 10, h: 3, rot: rng() < 0.4 ? rng() * 3 : 0 });
  }
  // a few long walls with gaps, so detours happen
  for (let k = 0; k < 3; k++) {
    const z = D * (0.25 + 0.25 * k);
    const gap = rng() * W;
    world.addBox({ x: gap / 2 - 1, z, w: Math.max(0.1, gap - 2), d: 0.4, h: 3 });
  }
  const nav = new NavGrid(world, { minX: 0, maxX: W, minZ: 0, maxZ: D }, { cell: 0.5, agentRadius: 0.45 });
  nav.build();
  for (let q = 0; q < QUERIES; q++) {
    const a = { x: rng() * W, z: rng() * D }, b = { x: rng() * W, z: rng() * D };
    const ends = nav._endpoints(a, b);
    if (!ends || ends.direct) continue;
    const t0 = performance.now();
    const jc = nav._jps(ends.s, ends.t, 1e9, 1);
    const t1 = performance.now();
    const rc = nav._astar(ends.s, ends.t, 1e9, 1);
    const t2 = performance.now();
    tJps += t1 - t0;
    tRef += t2 - t1;
    n++;
    if (!!jc !== !!rc) {
      fail(`world ${wi} q${q}: reachability differs (jps ${!!jc}, astar ${!!rc})`);
      continue;
    }
    if (!jc) continue;
    // every step of the expanded JPS path is a legal 8-connected move
    for (let i = 1; i < jc.length; i++) {
      const p = jc[i - 1], c = jc[i];
      const dx = (c % nav.w) - (p % nav.w), dz = Math.floor(c / nav.w) - Math.floor(p / nav.w);
      if (Math.abs(dx) > 1 || Math.abs(dz) > 1 || !nav.walk[c]) fail(`world ${wi} q${q}: illegal step`);
      if (dx && dz && (!nav.walk[p + dx] || !nav.walk[p + dz * nav.w])) fail(`world ${wi} q${q}: corner cut`);
    }
    const cj = cellCost(nav, jc), cr = cellCost(nav, rc);
    if (cj > cr + 1e-3) fail(`world ${wi} q${q}: jps cost ${cj.toFixed(3)} > astar ${cr.toFixed(3)}`);
    const path = nav.findPath(a, b);
    if (!path) {
      fail(`world ${wi} q${q}: findPath null`);
      continue;
    }
    let px = ends.start0.x, pz = ends.start0.z;
    for (const p of path) {
      if (!nav.lineWalkable(px, pz, p.x, p.z)) fail(`world ${wi} q${q}: smoothed segment not walkable`);
      px = p.x;
      pz = p.z;
    }
    const last = path[path.length - 1];
    if (Math.abs(last.x - ends.goal0.x) > 1e-9 || Math.abs(last.z - ends.goal0.z) > 1e-9) fail(`world ${wi} q${q}: path does not end at the goal`);
  }

  // nearestWalkable: compare with the original full-square scan
  const naive = (x, z, maxCells) => {
    const cx = nav.cellX(x), cz = nav.cellZ(z);
    for (let r = 0; r <= maxCells; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx, iz = cz + dz;
          if (ix < 0 || iz < 0 || ix >= nav.w || iz >= nav.h) continue;
          const i = iz * nav.w + ix;
          if (!nav.walk[i]) continue;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best >= 0) return r === 0 ? { x, z } : nav.centerOf(best);
    }
    return null;
  };
  for (let q = 0; q < 40; q++) {
    const x = -5 + rng() * (W + 10), z = -5 + rng() * (D + 10);
    const a = nav.nearestWalkable(x, z, 12), b = naive(x, z, 12);
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`world ${wi}: nearestWalkable(${x.toFixed(2)}, ${z.toFixed(2)}) ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

// --- CollisionWorld: move / remove keep queries consistent ----------------------------------
{
  const world = new CollisionWorld();
  const rng = makeRng(7);
  const boxes = [];
  for (let i = 0; i < 50; i++) boxes.push(world.addBox({ x: rng() * 100, z: rng() * 100, w: 1 + rng() * 5, d: 1 + rng() * 5, h: 2, rot: rng() * 3 }));
  for (let it = 0; it < 2000; it++) {
    const b = boxes[Math.floor(rng() * boxes.length)];
    world.updateBox(b, { x: rng() * 100, z: rng() * 100, rot: rng() * 3, w: 0.3 + rng() * 6 });
  }
  const cells = [...world.grid.values()].reduce((s, c) => s + c.length, 0);
  // brute-force check of query() against every collider's AABB
  for (let q = 0; q < 500; q++) {
    const x = rng() * 110 - 5, z = rng() * 110 - 5, s = rng() * 12;
    const got = new Set(world.query(x, z, x + s, z + s));
    for (const c of world.colliders) {
      const hit = !(c.maxX < x || c.minX > x + s || c.maxZ < z || c.minZ > z + s);
      if (hit !== got.has(c)) fail(`query mismatch after updateBox (collider ${c.id})`);
    }
  }
  const removed = boxes.splice(0, 20);
  for (const b of removed) world.removeBox(b);
  for (const b of removed) world.removeBox(b); // twice is harmless
  if (world.colliders.length !== 30) fail(`removeBox left ${world.colliders.length} colliders`);
  for (const cell of world.grid.values()) for (const c of cell) if (removed.includes(c)) fail('removed box still in the grid');
  const before = cells;
  const after = [...world.grid.values()].reduce((s, c) => s + c.length, 0);
  console.log(`collision: ${before} cell entries for 50 boxes after 2000 moves, ${after} after removing 20`);
}

console.log(`nav: ${n} searches; JPS ${tJps.toFixed(1)} ms vs A* ${tRef.toFixed(1)} ms (${(tRef / Math.max(tJps, 1e-6)).toFixed(1)}x)`);
if (failures) {
  console.log(`${failures} failure(s)`);
  process.exitCode = 1;
} else console.log('all nav/collision checks passed');
