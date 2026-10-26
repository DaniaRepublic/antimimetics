// Visual changes must not move gameplay geometry: compares the collision world and the light
// sources' stealth footprint of two builds.
//   node tools/visual-layout-diff.mjs <a.html> <b.html>
import { launch } from './harness.mjs';

const dump = async (html) => {
  const h = await launch({ html, query: 'autostart&quality=0', timeout: 120000 });
  const r = await h.eval(() => {
    const g = window.__game;
    const f = (v) => Math.round(v * 100) / 100;
    const cols = g.world.colliders.map((c) => [c.tag, f(c.minX ?? c.x), f(c.maxX ?? c.w), f(c.minZ ?? c.z), f(c.maxZ ?? c.d), f(c.maxY ?? c.h)].join(' '));
    const lights = g.atmosphere.lightSources.map((s) => [f(s.pos.x), f(s.pos.y), f(s.pos.z), f(s.stealthRadius ?? -1), f(s.stealthWeight ?? -1)].join(' '));
    return { cols, lights, nav: g.nav.regionCount, walk: g.nav.walkableCount ?? null };
  });
  await h.close();
  return r;
};
const [a, b] = process.argv.slice(2);
const A = await dump(a), B = await dump(b);
const diff = (x, y) => x.filter((v) => !y.includes(v));
console.log(`colliders: ${A.cols.length} vs ${B.cols.length}; only in A: ${diff(A.cols, B.cols).length}, only in B: ${diff(B.cols, A.cols).length}`);
for (const v of diff(A.cols, B.cols).slice(0, 10)) console.log('  A-only', v);
for (const v of diff(B.cols, A.cols).slice(0, 10)) console.log('  B-only', v);
console.log(`light sources: ${A.lights.length} vs ${B.lights.length}`);
for (const v of diff(A.lights, B.lights)) console.log('  A-only light', v);
for (const v of diff(B.lights, A.lights)) console.log('  B-only light', v);
console.log(`nav regions: ${A.nav} vs ${B.nav}`);
