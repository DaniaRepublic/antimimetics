// Level module checks: navigation, enclosure, spawn safety, render cost, build time + screenshots.
//
//   node build.mjs && node tools/check-level.mjs [--html dist/index.html] [--out dist/shots/level]
//                                               [--no-shots] [--views a,b] [--query extra]
// Use tools/level-build.mjs (dev atmosphere with real light pools) for nicer screenshots:
//   node tools/level-build.mjs && node tools/check-level.mjs --html dist/level-dev.html
// Exits non-zero if any check fails.
import { launch } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const html = opt('--html', 'dist/index.html');
const out = opt('--out', 'dist/shots/level');
const extra = opt('--query', '');
const noShots = args.includes('--no-shots');
const onlyViews = opt('--views', '');
fs.mkdirSync(out, { recursive: true });

const h = await launch({ html, query: 'autostart&god' + (extra ? '&' + extra : ''), timeout: 120000 });
await h.page.waitForTimeout(600);

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

// ------------------------------------------------------------------------------------------------
// Static data + nav checks (run inside the page)
const R = await h.eval(() => {
  const g = window.__game;
  const L = g.level, nav = g.nav, world = g.world;
  const res = { errors: [] };
  const start = L.checkpoints[0].pos;
  const startRegion = nav.regionAt(start.x, start.z);
  res.bounds = L.bounds;
  res.boundsArea = (L.bounds.maxX - L.bounds.minX) * (L.bounds.maxZ - L.bounds.minZ);
  res.navCells = nav.w * nav.h;
  res.startRegion = startRegion;
  // Path between consecutive checkpoints and on to the exit (gate open for the last leg too).
  const legs = [];
  const pts = L.checkpoints.map((c) => ({ ...c.pos, id: c.id }));
  pts.push({ x: 0, z: L.exitZ - 2, id: 'exit' });
  const pathLen = (p, from) => {
    let len = 0, prev = from;
    for (const q of p) {
      len += Math.hypot(q.x - prev.x, q.z - prev.z);
      prev = q;
    }
    return len;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const t0 = performance.now();
    const p = nav.findPath(pts[i], pts[i + 1], { maxExpansions: 400000 });
    legs.push({ from: pts[i].id, to: pts[i + 1].id, ok: !!p, len: p ? pathLen(p, pts[i]) : 0, ms: performance.now() - t0, path: p });
  }
  res.legs = legs.map(({ path, ...l }) => l);
  res.legPaths = legs.map((l) => l.path);
  // Route length (the straight-ish walking distance)
  res.routeLength = legs.reduce((s, l) => s + l.len, 0);
  // Every enemy spawn and route point walkable + same region as the start
  res.enemies = L.enemies.map((e) => {
    const pts2 = [e.pos, ...(e.route || [])];
    const bad = pts2.filter((p) => !nav.isWalkable(p.x, p.z) || nav.regionAt(p.x, p.z) !== startRegion);
    let routeOk = true;
    if (e.route) {
      for (let i = 0; i < e.route.length; i++) {
        const a = e.route[i], b = e.route[(i + 1) % e.route.length];
        if (!nav.findPath(a, b, { maxExpansions: 200000 })) routeOk = false;
      }
    }
    if (e.kind === 'wander') {
      let n = 0;
      for (let k = 0; k < 20; k++) if (nav.randomPointNear(e.pos.x, e.pos.z, e.radius)) n++;
      if (n < 15) routeOk = false;
    }
    return { id: e.id, zone: e.zone, kind: e.kind, bad: bad.length, routeOk };
  });
  // Pickups reachable from the start
  res.pickups = L.pickups.map((p) => {
    const w = nav.nearestWalkable(p.pos.x, p.pos.z, 4);
    const reach = w && nav.regionAt(w.x, w.z) === startRegion && Math.hypot(w.x - p.pos.x, w.z - p.pos.z) < (p.interactable.range ?? 2.2) - 0.3;
    return { i: p.index, zone: p.zone, x: p.pos.x, z: p.pos.z, ok: !!reach };
  });
  // Checkpoints: walkable, inside their own area, inside their zone, and in the start region
  res.checkpoints = L.checkpoints.map((c) => ({
    id: c.id, walk: nav.isWalkable(c.pos.x, c.pos.z), region: nav.regionAt(c.pos.x, c.pos.z) === startRegion,
    inArea: c.pos.x >= c.area.minX && c.pos.x <= c.area.maxX && c.pos.z >= c.area.minZ && c.pos.z <= c.area.maxZ,
    zone: L.zoneAt(c.pos) === c.zone,
  }));
  // Spawn safety: no enemy can see a checkpoint (any scan angle, view distance 28, cone 115 deg + scan)
  res.spawnSafety = L.checkpoints.map((c) => {
    const seen = [];
    for (const e of L.enemies) {
      if (e.sleeping) continue;
      const dx = c.pos.x - e.pos.x, dz = c.pos.z - e.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 28) continue;
      const half = (115 / 2) * (Math.PI / 180) + (e.scanArc || 0) / 2;
      const fx = -Math.sin(e.yaw || 0), fz = -Math.cos(e.yaw || 0);
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / d)));
      if (e.kind !== 'wander' && e.kind !== 'patrol' && ang > half) continue;
      const blocked = world.segmentBlocked({ x: e.pos.x, y: 1.95, z: e.pos.z }, { x: c.pos.x, y: 1.65, z: c.pos.z });
      if (!blocked) seen.push(`${e.id}@${d.toFixed(0)}m`);
    }
    return { id: c.id, seen };
  });
  // Enclosure: sample the bounds; any cell reachable from the start must lie inside a route rect.
  const rects = L.routeRects;
  const inRoute = (x, z, pad) => rects.some((r) => x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad);
  let leaks = [];
  let reachable = 0;
  for (let iz = 0; iz < nav.h; iz += 2) {
    for (let ix = 0; ix < nav.w; ix += 2) {
      const i = iz * nav.w + ix;
      if (!nav.walk[i] || nav.region[i] !== startRegion) continue;
      reachable++;
      const c = nav.centerOf(i);
      if (!inRoute(c.x, c.z, 0.75)) leaks.push([+c.x.toFixed(1), +c.z.toFixed(1)]);
    }
  }
  res.reachableCells = reachable;
  res.leaks = leaks.slice(0, 20);
  res.leakCount = leaks.length;
  // Random points just outside the route boundary: not reachable from the start region.
  let outsideReach = 0, outsideTested = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 4000; k++) {
    const x = L.bounds.minX + rnd() * (L.bounds.maxX - L.bounds.minX);
    const z = L.bounds.minZ + rnd() * (L.bounds.maxZ - L.bounds.minZ);
    if (inRoute(x, z, 1.5)) continue;
    if (!inRoute(x, z, 6)) continue; // only the band just outside the route
    outsideTested++;
    if (nav.regionAt(x, z) === startRegion) outsideReach++;
  }
  res.outside = { tested: outsideTested, reachable: outsideReach };
  // Player-scale enclosure: walk a probe circle from the start with the real collision resolver
  // (flood fill on a 1 m lattice using resolveCircle), to catch gaps the nav inflation hides.
  {
    const step = 0.5;
    const seen = new Set();
    const queue = [[Math.round(start.x / step), Math.round(start.z / step)]];
    const probe = { x: 0, y: 0, z: 0 };
    let escaped = [];
    let visited = 0;
    while (queue.length && visited < 200000) {
      const [ix, iz] = queue.pop();
      const key = ix + ',' + iz;
      if (seen.has(key)) continue;
      seen.add(key);
      const x = ix * step, z = iz * step;
      probe.x = x;
      probe.z = z;
      world.resolveCircle(probe, 0.35, { height: 1.15 });
      if (Math.hypot(probe.x - x, probe.z - z) > 0.3) continue; // inside geometry
      visited++;
      if (!inRoute(x, z, 1.0)) {
        escaped.push([x, z]);
        if (escaped.length > 20) break;
        continue;
      }
      if (x < L.bounds.minX || x > L.bounds.maxX || z < L.bounds.minZ || z > L.bounds.maxZ) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) queue.push([ix + dx, iz + dz]);
    }
    res.playerFlood = { visited, escaped };
  }
  // Boulevard design check: crouched spots hidden from every devout (any scan angle, 28 m) and the
  // largest gap along the route between such spots (a call lasts ~4.6 s: walk ~14 m, sprint ~27 m).
  {
    const devouts = L.enemies.filter((e) => e.kind === 'devout');
    const hiddenAt = (x, z, eye) => devouts.every((e) => {
      const dx = x - e.pos.x, dz = z - e.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 28) return true;
      const half = (115 / 2) * (Math.PI / 180) + (e.scanArc || 0) / 2;
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * -Math.sin(e.yaw) + dz * -Math.cos(e.yaw)) / d)));
      if (ang > half) return true;
      return world.segmentBlocked({ x: e.pos.x, y: 1.95, z: e.pos.z }, { x, y: eye, z });
    });
    const spots = [];
    for (let z = -222; z >= -336; z -= 0.5) {
      for (let x = -12; x <= 12; x += 0.5) {
        if (!nav.isWalkable(x, z) || nav.regionAt(x, z) !== startRegion) continue;
        if (hiddenAt(x, z, 0.95)) {
          spots.push({ x, z });
          break;
        }
      }
    }
    let maxGap = 0, prevZ = -218;
    for (const sp of spots) {
      maxGap = Math.max(maxGap, prevZ - sp.z);
      prevZ = sp.z;
    }
    maxGap = Math.max(maxGap, prevZ - -338);
    const zs = [];
    for (const sp of spots) if (!zs.length || zs[zs.length - 1][1] - sp.z > 0.6) zs.push([sp.z, sp.z]); else zs[zs.length - 1][1] = sp.z;
    res.boulevard = { hiddenBands: zs.map(([a, b]) => `${a}..${b}`), maxGap };
    // Standing in the open at the boulevard's centre line should be visible from somewhere.
    let exposed = 0, tested = 0;
    for (let z = -225; z >= -335; z -= 5) {
      tested++;
      if (!hiddenAt(0, z, 1.65) || !hiddenAt(-9, z, 1.65) || !hiddenAt(9, z, 1.65)) exposed++;
    }
    res.boulevard.exposed = `${exposed}/${tested}`;
  }
  // Render / build cost
  res.buildMs = L.buildMs;
  res.texMs = L.textures?.buildMs;
  res.staticTriangles = L.triangles;
  res.colliders = world.colliders.length;
  res.navRegions = nav.regionCount;
  const t0 = performance.now();
  nav.build();
  res.navBuildMs = performance.now() - t0;
  // Level.update cost
  const t1 = performance.now();
  for (let k = 0; k < 200; k++) L.update(1 / 60);
  res.updateMs = (performance.now() - t1) / 200;
  // Count meshes / materials in the level
  let meshes = 0;
  L.root.traverse((o) => {
    if (o.isMesh || o.isLine) meshes++;
  });
  res.levelMeshes = meshes;
  return res;
});

console.log(`bounds ${JSON.stringify(R.bounds)} area ${R.boundsArea.toFixed(0)} m2, nav cells ${R.navCells}`);
console.log(`build: level ${R.buildMs.toFixed(0)} ms (textures ${R.texMs?.toFixed(0)} ms), nav ${R.navBuildMs.toFixed(0)} ms; update ${R.updateMs.toFixed(3)} ms/frame`);
console.log(`static triangles ${R.staticTriangles}, colliders ${R.colliders}, level meshes ${R.levelMeshes}, nav regions ${R.navRegions}`);
check(R.buildMs + R.navBuildMs < 1500, `level.build + nav.build < 1.5 s (${(R.buildMs + R.navBuildMs).toFixed(0)} ms)`);
check(R.boundsArea < 200 * 470, 'bounds under 200 x 470 m');
for (const l of R.legs) check(l.ok, `path ${l.from} -> ${l.to} (${l.len.toFixed(0)} m, ${l.ms.toFixed(0)} ms)`);
console.log(`route length via nav: ${R.routeLength.toFixed(0)} m`);
console.log(`boulevard crouch-hidden bands (z): ${R.boulevard.hiddenBands.join(', ')}; max gap ${R.boulevard.maxGap.toFixed(1)} m; open ground exposed ${R.boulevard.exposed}`);
check(R.boulevard.maxGap <= 22, `boulevard: hidden pockets no more than 22 m apart (max gap ${R.boulevard.maxGap.toFixed(1)} m)`);
for (const c of R.checkpoints) check(c.walk && c.region && c.inArea && c.zone, `checkpoint ${c.id} walkable/region/area/zone`);
for (const s of R.spawnSafety) check(s.seen.length === 0, `checkpoint ${s.id} not visible to enemies ${s.seen.join(' ')}`);
for (const e of R.enemies) check(e.bad === 0 && e.routeOk, `enemy ${e.id} (${e.kind}, zone ${e.zone}) spawn/route walkable + connected`);
for (const p of R.pickups) check(p.ok, `pickup ${p.i} (zone ${p.zone}) at ${p.x.toFixed(1)},${p.z.toFixed(1)} reachable`);
check(R.leakCount === 0, `nav enclosure: reachable cells outside route rects = ${R.leakCount} ${JSON.stringify(R.leaks.slice(0, 8))}`);
check(R.outside.reachable === 0, `points just outside the route unreachable (${R.outside.tested} tested, ${R.outside.reachable} reachable)`);
check(R.playerFlood.escaped.length === 0, `player-radius flood fill (0.5 m lattice) stays inside (${R.playerFlood.visited} cells) ${JSON.stringify(R.playerFlood.escaped.slice(0, 6))}`);

// ------------------------------------------------------------------------------------------------
// Map: nav grid + colliders + enemies + pickups + checkpoints + checkpoint paths
const mapData = await h.eval(() => {
  const g = window.__game;
  const nav = g.nav, L = g.level;
  const s = 3; // px per metre
  const W = Math.ceil((L.bounds.maxX - L.bounds.minX) * s), H = Math.ceil((L.bounds.maxZ - L.bounds.minZ) * s);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const X = (x) => (x - L.bounds.minX) * s, Z = (z) => (z - L.bounds.minZ) * s;
  const start = L.checkpoints[0].pos;
  const sr = nav.regionAt(start.x, start.z);
  const img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = L.bounds.minX + px / s, z = L.bounds.minZ + py / s;
      const i = nav.index(x, z);
      const o = (py * W + px) * 4;
      let r = 20, gg = 18, b = 18;
      if (i >= 0 && nav.walk[i]) {
        if (nav.region[i] === sr) [r, gg, b] = [70, 80, 70];
        else [r, gg, b] = [45, 40, 60];
      }
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.lineWidth = 1;
  for (const col of g.world.colliders) {
    if (col.minY > 1.5) continue;
    ctx.strokeStyle = !col.enabled ? '#555' : col.blocksSight ? (col.maxY < 1.7 ? '#c8a040' : '#b04030') : '#4090d0';
    ctx.beginPath();
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = sx * col.hx, lz = sz * col.hz;
      const x = col.cx + col.cos * lx + col.sin * lz, z = col.cz - col.sin * lx + col.cos * lz;
      ctx.lineTo(X(x), Z(z));
    }
    ctx.closePath();
    ctx.stroke();
  }
  for (const r of L.routeRects) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(X(r.minX), Z(r.minZ), (r.maxX - r.minX) * s, (r.maxZ - r.minZ) * s);
  }
  ctx.font = '10px monospace';
  for (const e of L.enemies) {
    ctx.fillStyle = e.kind === 'devout' ? '#ff60ff' : e.kind === 'patrol' ? '#ff4040' : e.kind === 'wander' ? '#ffa040' : '#ff2020';
    if (e.route) {
      ctx.strokeStyle = 'rgba(255,80,80,0.6)';
      ctx.beginPath();
      e.route.forEach((p) => ctx.lineTo(X(p.x), Z(p.z)));
      if (e.loop) ctx.closePath();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(X(e.pos.x), Z(e.pos.z), 4, 0, Math.PI * 2);
    ctx.fill();
    const yaw = e.yaw || 0;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath();
    ctx.moveTo(X(e.pos.x), Z(e.pos.z));
    ctx.lineTo(X(e.pos.x - Math.sin(yaw) * 6), Z(e.pos.z - Math.cos(yaw) * 6));
    ctx.stroke();
    if (e.kind === 'sentry' || e.kind === 'devout') {
      ctx.fillStyle = 'rgba(255,40,40,0.08)';
      ctx.beginPath();
      ctx.moveTo(X(e.pos.x), Z(e.pos.z));
      const half = (115 / 2) * (Math.PI / 180);
      for (let a = -half; a <= half; a += 0.1) ctx.lineTo(X(e.pos.x - Math.sin(yaw + a) * 28), Z(e.pos.z - Math.cos(yaw + a) * 28));
      ctx.fill();
    }
  }
  for (const p of L.pickups) {
    ctx.fillStyle = '#60ffd0';
    ctx.fillRect(X(p.pos.x) - 2, Z(p.pos.z) - 2, 5, 5);
  }
  for (const a of L.alarms) {
    ctx.strokeStyle = '#ffd000';
    ctx.beginPath();
    ctx.arc(X(a.pos.x), Z(a.pos.z), 48 * s, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const l of L.lights) {
    ctx.fillStyle = 'rgba(255,200,80,0.18)';
    ctx.beginPath();
    ctx.arc(X(l.pos.x), Z(l.pos.z), (l.handle.stealthRadius || 1) * s, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const gr of L.graffiti) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(X(gr.pos.x) - 1.5, Z(gr.pos.z) - 1.5, 4, 4);
  }
  for (const cp of L.checkpoints) {
    ctx.strokeStyle = '#40ff40';
    ctx.strokeRect(X(cp.area.minX), Z(cp.area.minZ), (cp.area.maxX - cp.area.minX) * s, (cp.area.maxZ - cp.area.minZ) * s);
    ctx.fillStyle = '#40ff40';
    ctx.fillText(cp.id, X(cp.pos.x) + 5, Z(cp.pos.z));
  }
  return c.toDataURL('image/png');
});
// The map is tall (route is ~460 m); split into two halves side by side for viewing.
fs.writeFileSync(path.join(out, 'map.png'), Buffer.from(mapData.split(',')[1], 'base64'));
console.log('map:', path.join(out, 'map.png'));

// ------------------------------------------------------------------------------------------------
// Screenshots: eye-height views along the route + an overhead per zone.
const VIEWS = {
  v01_alley_start: [[0, 1.65, 4], [0.3, 2.2, -20]],
  v02_alley_mouth: [[0.5, 1.65, -21.5], [2, 3.5, -80]],
  v03_main_crouch: [[7.5, 0.95, -60], [-6, 1.6, -92]],
  v04_main_north: [[-2, 1.65, -104], [6, 3, -130]],
  v05_pharmacy: [[14, 1.65, -114], [22, 1.4, -134]],
  v06_plaza_entry: [[20.5, 1.65, -142], [-6, 2.5, -196]],
  v07_plaza_gas: [[-14, 1.65, -160], [-31, 1.8, -170]],
  v08_arch: [[16, 1.65, -192], [0, 4, -210]],
  v09_boulevard: [[0, 1.65, -219], [0, 9, -300]],
  v10_boulevard_mid: [[0.5, 0.95, -275], [-12, 3, -330]],
  v11_overpass: [[-6, 1.65, -346], [0, 4, -396]],
  v12_garage: [[-16, 1.65, -342], [-24, 1.4, -390]],
  v13_gate: [[2, 1.65, -386], [-1, 1.8, -420]],
  v14_exit: [[0, 1.65, -400], [3, 3, -446]],
  t_title: null,
  o_z0_z1: [[0, 95, -40], [0, 0, -75]],
  o_z1: [[0, 95, -95], [0, 0, -120]],
  o_z2: [[0, 110, -160], [0, 0, -180]],
  o_z3: [[0, 120, -250], [0, 0, -280]],
  o_z4: [[-14, 120, -360], [-14, 0, -395]],
};
if (!noShots) {
  for (const [name, v] of Object.entries(VIEWS)) {
    if (onlyViews && !onlyViews.split(',').includes(name)) continue;
    // Overheads: thin the fog (where the atmosphere uses scene.fog) so the layout is visible.
    await h.eval((over) => {
      const g = window.__game;
      if (!g.scene.fog) return;
      g.__fogKeep ??= g.scene.fog.density;
      g.scene.fog.density = over ? 0.0015 : g.__fogKeep;
      if (g.atmosphere.fogDensity !== undefined) g.atmosphere.fogDensity = g.scene.fog.density;
    }, name.startsWith('o_'));
    if (name === 't_title') {
      const tc = await h.eval(() => window.__game.level.titleCamera);
      await h.cam(tc.pos, tc.target);
    } else await h.cam(v[0], v[1]);
    await h.page.waitForTimeout(100);
    await h.shot(path.join(out, `${name}.png`));
    const info = await h.eval(() => ({ calls: window.__game.renderer.info.render.calls, tris: window.__game.renderer.info.render.triangles }));
    check(info.calls < 200 && info.tris < 500000, `${name}: ${info.calls} draw calls, ${info.tris} triangles`);
  }
}

// ------------------------------------------------------------------------------------------------
// Gameplay smoke: triggers, pickups, alarm, gate
const G = await h.eval(() => {
  const g = window.__game;
  const L = g.level;
  const log = [];
  const offs = ['zone:enter', 'level:checkpoint', 'level:exit', 'player:pickup', 'alarm:start', 'alarm:end', 'gate:open', 'level:message', 'noise']
    .map((t) => g.bus.on(t, (e) => log.push({ t, src: e?.source, text: e?.text, id: e?.id ?? e?.checkpoint?.id ?? e?.zone?.id })));
  const res = {};
  L._announcedZone = -1;
  // walk the checkpoints
  for (const cp of L.checkpoints) {
    g.teleport(cp.pos.x, cp.pos.z, cp.yaw);
    g.simulate(0.2);
  }
  res.zonesEntered = log.filter((e) => e.t === 'zone:enter').map((e) => e.id);
  res.cps = log.filter((e) => e.t === 'level:checkpoint').map((e) => e.id);
  // pickup the first bottle
  const pk = L.pickups[0];
  g.teleport(pk.pos.x, pk.pos.z + 1.2, 0);
  g.player.bottles = 0;
  pk.interactable.onInteract(g);
  res.bottlesAfterPickup = g.player.bottles;
  res.pickupEnabled = pk.interactable.enabled;
  g.respawn();
  res.pickupRestored = pk.interactable.enabled;
  // alarm: shatter on the plaza alarm car
  const a = L.alarms.find((x) => x.id === 'plaza_alarm');
  g.bus.emit('bottle:shatter', { pos: a.pos.clone(), collider: a.collider });
  g.simulate(3);
  res.alarmNoises = log.filter((e) => e.t === 'noise' && e.src === 'alarm').length;
  g.simulate(13);
  res.alarmEnded = log.some((e) => e.t === 'alarm:end');
  res.alarmRearmed = (() => {
    L.resetDynamic(L.checkpoints[2]);
    return a.armed;
  })();
  // gate: hold E
  const gate = L.gate;
  g.teleport(0, gate.pos.z + 1.2, 0);
  g.simulate(0.1);
  g.input.keys.add('KeyE');
  g.simulate(3.4);
  g.input.keys.delete('KeyE');
  res.gateOpen = gate.open;
  res.gateNoises = log.filter((e) => e.t === 'noise' && e.src === 'gate').length;
  res.gateNav = g.nav.isWalkable(0, gate.pos.z);
  g.simulate(2);
  g.teleport(0, -429, 0);
  g.simulate(0.2);
  g.teleport(0, -432, 0);
  g.simulate(0.2);
  res.exit = log.some((e) => e.t === 'level:exit');
  // Graffiti hint: stand in front of the first one, facing it.
  const gr = L.graffiti[0];
  gr.shown = false;
  g.teleport(gr.pos.x + gr.nx * 4, gr.pos.z + gr.nz * 4, Math.atan2(gr.nx, gr.nz));
  g.player.pitch = 0;
  g.simulate(0.2);
  res.messages = log.filter((e) => e.t === 'level:message').map((e) => e.text.slice(0, 24));
  L.resetDynamic(L.checkpoints[4]);
  res.gateClosedAfterReset = !gate.open && !g.nav.isWalkable(0, gate.pos.z);
  offs.forEach((f) => f());
  return res;
});
console.log('gameplay', JSON.stringify(G));
check(G.zonesEntered.join() === 'alley,main,plaza,boulevard,overpass', 'zone:enter fires for every zone in order');
check(G.cps.length >= 4, 'level:checkpoint fires for checkpoints');
check(G.bottlesAfterPickup === 1 && !G.pickupEnabled && G.pickupRestored, 'bottle pickup + restore on respawn');
check(G.alarmNoises >= 3 && G.alarmEnded && G.alarmRearmed, 'alarm emits noise, ends, re-arms');
check(G.gateOpen && G.gateNoises >= 3 && G.gateNav && G.gateClosedAfterReset, 'gate: hold to cut, noisy, opens nav, closes on reset');
check(G.exit, 'level:exit fires past z -430');
check(G.messages.length >= 1, 'graffiti emits level:message when read');

check(h.errors.length === 0, `no console/page errors ${h.errors.join('\n')}`);
await h.close();
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall level checks passed');
process.exitCode = failed ? 1 : 0;
