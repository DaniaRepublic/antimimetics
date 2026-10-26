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

  // jump tables: every straight jump equals the scanning reference (random cells, goals, directions)
  {
    const walkable = [];
    for (let i = 0; i < nav.w * nav.h; i++) if (nav.walk[i]) walkable.push(i);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let q = 0; q < 3000; q++) {
      const i = walkable[Math.floor(rng() * walkable.length)];
      const [dx, dz] = dirs[q % 4];
      // goals: random, or on the same line (so the goal check is exercised)
      let goal = walkable[Math.floor(rng() * walkable.length)];
      if (q % 3 === 0) goal = i + (dx + dz * nav.w) * (1 + Math.floor(rng() * 40));
      const a = nav._jumpStraight(i, dx, dz, goal), b = nav._scanStraight(i, dx, dz, goal);
      if (a !== b) {
        fail(`world ${wi}: jump table ${a} != scan ${b} (cell ${i}, dir ${dx},${dz}, goal ${goal})`);
        break;
      }
    }
  }

  // regions: compare with the original cell-by-cell flood fill (8-connected, no corner cutting)
  {
    const { w, h, walk } = nav;
    const ref = new Int32Array(w * h).fill(-1);
    const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let next = 0;
    for (let i = 0; i < w * h; i++) {
      if (!walk[i] || ref[i] >= 0) continue;
      ref[i] = next;
      const stack = [i];
      while (stack.length) {
        const c = stack.pop();
        const cx = c % w, cz = (c - cx) / w;
        for (const [dx, dz] of N8) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const ni = nz * w + nx;
          if (!walk[ni] || ref[ni] >= 0) continue;
          if (dx && dz && (!walk[cz * w + nx] || !walk[nz * w + cx])) continue;
          ref[ni] = next;
          stack.push(ni);
        }
      }
      next++;
    }
    if (next !== nav.regionCount) fail(`world ${wi}: ${nav.regionCount} regions, reference ${next}`);
    for (let i = 0; i < w * h; i++) {
      if (ref[i] !== nav.region[i]) {
        fail(`world ${wi}: region label differs at cell ${i} (${nav.region[i]} vs ${ref[i]})`);
        break;
      }
    }
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

// --- region labelling cost on a level-sized grid (80 m x 461 m at 0.5 m) -----------------------
{
  const rng = makeRng(99);
  const world = new CollisionWorld();
  for (let i = 0; i < 400; i++) world.addBox({ x: rng() * 80, z: rng() * 461, w: 1 + rng() * 12, d: 1 + rng() * 12, h: 3, rot: rng() * 3 });
  const nav = new NavGrid(world, { minX: 0, maxX: 80, minZ: 0, maxZ: 461 }, { cell: 0.5, agentRadius: 0.45 });
  nav.build();
  const { w, h, walk } = nav;
  const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const original = () => { // the pre-polish flood fill, for comparison
    const region = new Int32Array(w * h).fill(-1);
    let next = 0;
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      if (!walk[i] || region[i] >= 0) continue;
      region[i] = next;
      stack.push(i);
      while (stack.length) {
        const c = stack.pop();
        const cx = c % w, cz = (c - cx) / w;
        for (const [dx, dz] of N8) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const ni = nz * w + nx;
          if (!walk[ni] || region[ni] >= 0) continue;
          if (dx && dz && (!walk[cz * w + nx] || !walk[nz * w + cx])) continue;
          region[ni] = next;
          stack.push(ni);
        }
      }
      next++;
    }
    return next;
  };
  const time = (fn) => {
    for (let i = 0; i < 3; i++) fn();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) fn();
    return (performance.now() - t0) / 10;
  };
  const a = time(original), b = time(() => nav._labelRegions());
  console.log(`regions on a ${w}x${h} grid: flood fill ${a.toFixed(1)} ms, runs + union-find ${b.toFixed(1)} ms`);
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
