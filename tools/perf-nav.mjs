// Path-finding benchmark on the real level (headless): times NavGrid.findPath on a fixed, seeded set
// of queries (random same-region pairs plus the known long detours: round the closed Z4 gate via
// the parking structure, and the length of the route) and checks every returned path is walkable.
// If the build has NavGrid.findPathReference (plain A*), it is timed too and path lengths compared.
//
//   node tools/perf-nav.mjs [--html dist/index.html] [--pairs 300] [--reps 3]
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const html = opt('--html', 'dist/index.html');
const pairs = Number(opt('--pairs', 300));
const reps = Number(opt('--reps', 3));

const h = await launch({ html, query: 'autostart&quality=0&mute' });
const res = await h.eval(({ pairs, reps }) => {
  const g = window.__game;
  const nav = g.nav;
  // mulberry32
  let s = 12345;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const b = g.level.bounds;
  const randomWalkable = () => {
    for (let i = 0; i < 200; i++) {
      const x = b.minX + rng() * (b.maxX - b.minX), z = b.minZ + rng() * (b.maxZ - b.minZ);
      if (nav.isWalkable(x, z)) return { x, z };
    }
    return null;
  };
  const queries = [
    { name: 'gate detour S->N', a: { x: 0, z: -385 }, b: { x: 0, z: -402 } },
    { name: 'gate detour N->S', a: { x: 2, z: -410 }, b: { x: -2, z: -380 } },
    { name: 'parking deep', a: { x: -8, z: -347 }, b: { x: 4, z: -428 } },
    { name: 'plaza->boulevard', a: { x: 20.7, z: -139.5 }, b: { x: 6, z: -300 } },
    { name: 'start->plaza', a: { x: 0, z: 4 }, b: { x: 20, z: -150 } },
  ];
  while (queries.length < pairs) {
    const a = randomWalkable(), c = randomWalkable();
    if (!a || !c) continue;
    const d = Math.hypot(a.x - c.x, a.z - c.z);
    if (d < 15 || d > 160 || !nav.sameRegion(a.x, a.z, c.x, c.z)) continue;
    queries.push({ name: 'random', a, b: c });
  }
  const length = (from, path) => {
    let px = from.x, pz = from.z, L = 0;
    for (const p of path) {
      L += Math.hypot(p.x - px, p.z - pz);
      px = p.x;
      pz = p.z;
    }
    return L;
  };
  const valid = (from, path) => {
    const st = nav.nearestWalkable(from.x, from.z, 6);
    let px = st.x, pz = st.z;
    for (const p of path) {
      if (!nav.lineWalkable(px, pz, p.x, p.z)) return false;
      px = p.x;
      pz = p.z;
    }
    return true;
  };
  const run = (fn) => {
    const times = [];
    const out = [];
    for (const q of queries) {
      let best = Infinity, path = null;
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now();
        path = fn(q.a, q.b);
        best = Math.min(best, performance.now() - t0);
      }
      times.push(best);
      out.push(path);
    }
    const sorted = [...times].sort((x, y) => x - y);
    const sum = times.reduce((x, y) => x + y, 0);
    return {
      times, out,
      stats: { total: +sum.toFixed(1), mean: +(sum / times.length).toFixed(3), p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(3), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(3), max: +sorted[sorted.length - 1].toFixed(2) },
    };
  };
  const main = run((a, c) => nav.findPath(a, c));
  const report = { queries: queries.length, findPath: main.stats, named: {}, invalid: 0, failed: 0 };
  queries.forEach((q, i) => {
    const p = main.out[i];
    if (!p) report.failed++;
    else if (!valid(q.a, p)) report.invalid++;
    if (q.name !== 'random') report.named[q.name] = { ms: +main.times[i].toFixed(2), len: p ? +length(q.a, p).toFixed(1) : null, pts: p?.length ?? 0 };
  });
  if (nav.findPathReference) {
    const ref = run((a, c) => nav.findPathReference(a, c));
    report.reference = ref.stats;
    let worse = 0, maxRatio = 0, mismatch = 0;
    queries.forEach((q, i) => {
      const p = main.out[i], r = ref.out[i];
      if (!!p !== !!r) {
        mismatch++;
        return;
      }
      if (!p) return;
      const ratio = length(q.a, p) / Math.max(1e-6, length(q.a, r));
      maxRatio = Math.max(maxRatio, ratio);
      if (ratio > 1.05) worse++;
      if (q.name !== 'random') report.named[q.name].refMs = +ref.times[i].toFixed(2);
    });
    Object.assign(report, { foundMismatch: mismatch, longerThanRefBy5pct: worse, maxLengthRatio: +maxRatio.toFixed(3) });
  }
  return report;
}, { pairs, reps });
console.log(JSON.stringify(res, null, 2));
if (h.errors.length) {
  console.log('ERRORS:\n' + h.errors.join('\n'));
  process.exitCode = 1;
}
if (res.invalid || res.failed || res.foundMismatch) process.exitCode = 1;
await h.close();
