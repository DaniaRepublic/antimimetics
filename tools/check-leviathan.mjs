// Headless checks for the leviathan module.
//   node tools/check-leviathan.mjs            sandbox screenshots + gait invariants, then the real game
//   node tools/check-leviathan.mjs --sandbox  only the sandbox
//   node tools/check-leviathan.mjs --game     only the real game (expects dist/index.html to be built)
// Screenshots land in dist/shots/leviathan-*.png.
import { execSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const only = (f) => !args.some((a) => a === '--sandbox' || a === '--game') || args.includes(f);
const OUT = 'dist/shots';
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failed = true;
};

async function sandbox() {
  execSync('node build.mjs --entry tools/sandbox/leviathan.js --out dist/sandbox-leviathan.html', { stdio: 'inherit' });
  const h = await launch({ html: 'dist/sandbox-leviathan.html', query: 'paused' });

  // Gait invariants over 90 simulated seconds while the player walks north along the avenue.
  const stats = await h.eval(() => {
    const g = window.__game;
    const L = g.leviathan;
    L.update(1 / 30);
    const prev = L.legs.map((l) => ({ swing: l.swing, foot: l.foot.clone() }));
    let slide = 0, minKneeAbove = Infinity, maxStretch = 0, maxTibia = 0, nan = false;
    let ms = 0, frames = 0;
    for (let i = 0; i < 90 * 30; i++) {
      g.player.position.z -= 1.4 / 30; // slow walk north
      const t0 = performance.now();
      g.time += 1 / 30;
      L.update(1 / 30);
      ms += performance.now() - t0;
      frames++;
      L.legs.forEach((l, k) => {
        if (!l.swing && !prev[k].swing && l.foot.distanceTo(prev[k].foot) > slide) slide = l.foot.distanceTo(prev[k].foot);
        prev[k].swing = l.swing;
        prev[k].foot.copy(l.foot);
        minKneeAbove = Math.min(minKneeAbove, l.knee.y - L.position.y);
        const f = l.hip.distanceTo(l.knee) / 60, n = l.ankle.distanceTo(l.foot) / 32;
        maxStretch = Math.max(maxStretch, Math.abs(f - 1), Math.abs(n - 1));
        maxTibia = Math.max(maxTibia, Math.abs(l.knee.distanceTo(l.ankle) / 140 - 1));
        if (!Number.isFinite(l.knee.x + l.ankle.y + l.foot.z)) nan = true;
      });
    }
    return {
      slide, minKneeAbove, maxStretch, maxTibia, nan, avgMs: ms / frames, footfalls: L.footfalls,
      body: L.position.toArray(), yaw: L.yaw, player: g.player.position.toArray(),
    };
  });
  console.log('sandbox gait', JSON.stringify(stats));
  check(!stats.nan, 'no NaN in leg pose');
  check(stats.slide < 1e-6, `planted feet never slide (max ${stats.slide.toExponential(2)} m)`);
  check(stats.minKneeAbove > 8, `knees stay well above the body (min ${stats.minKneeAbove.toFixed(1)} m)`);
  check(stats.maxStretch < 0.01, `femur / needle keep their length (max ${(stats.maxStretch * 100).toFixed(2)}%)`);
  check(stats.maxTibia < 0.03, `shin reaches the ankle (max stretch ${(stats.maxTibia * 100).toFixed(2)}%)`);
  check(stats.avgMs < 0.5, `update() ${stats.avgMs.toFixed(3)} ms per frame`);
  check(stats.footfalls >= 20, `${stats.footfalls} footfalls in 90 s`);

  // Turn around: the player doubles back 160 m; legs must not pass through each other.
  const turn = await h.eval(() => {
    const g = window.__game;
    const L = g.leviathan;
    const segDist = (p1, q1, p2, q2) => {
      const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
      const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2);
      const den = a * e - b * b;
      let s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      let t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
    };
    let minGap = Infinity, yaw0 = L.yaw;
    for (let i = 0; i < 120 * 30; i++) {
      if (i < 40 * 30) g.player.position.z += 4 / 30;
      g.time += 1 / 30;
      L.update(1 / 30);
      if (i % 3) continue;
      const segs = L.legs.map((l) => [[l.hip, l.knee], [l.knee, l.mid], [l.mid, l.ankle], [l.ankle, l.foot]]);
      for (let a = 0; a < segs.length; a++) {
        for (let b = a + 1; b < segs.length; b++) {
          for (const s1 of segs[a]) for (const s2 of segs[b]) minGap = Math.min(minGap, segDist(s1[0], s1[1], s2[0], s2[1]));
        }
      }
    }
    return { minGap, turned: Math.abs(Math.atan2(Math.sin(L.yaw - yaw0), Math.cos(L.yaw - yaw0))) };
  });
  console.log('turn', JSON.stringify(turn));
  check(turn.turned > 2.5, `turned around (${turn.turned.toFixed(2)} rad)`);
  check(turn.minGap > 2.5, `legs never pass through each other while turning (min gap ${turn.minGap.toFixed(1)} m)`);

  const views = await h.eval(() => {
    window.__game.stage(8);
    const L = window.__game.leviathan;
    const p = L.position;
    const s = Math.sin(L.yaw), c = Math.cos(L.yaw);
    // broadside direction (body right) for side-on views
    const rx = c, rz = -s;
    return { p: p.toArray(), rx, rz, fx: -s, fz: -c };
  });
  const [bx, by, bz] = views.p;
  const side = (d, y = 1.7, lookY = by * 0.62) => [[bx + views.rx * d, y, bz + views.rz * d], [bx, lookY, bz]];
  const shots = [
    ['street-050', ...side(50, 1.7, by * 0.8)],
    ['street-150', ...side(150)],
    ['street-300', ...side(300, 1.7, by * 0.5)],
    ['front-220', [bx + views.fx * 220, 1.7, bz + views.fz * 220], [bx, by * 0.6, bz]],
    ['under', [bx + 0.5, 1.7, bz + 0.3], [bx + 0.5 + views.fx * 0.05, 200, bz + 0.3 + views.fz * 0.05]],
    ['foot', null, null],
  ];
  for (const [name, pos, target] of shots) {
    if (name === 'foot') {
      const f = await h.eval(() => window.__game.leviathan.legs.find((l) => !l.swing).foot.toArray());
      await h.cam([f[0] + 18, 1.7, f[2] + 22], [f[0], f[1] + 12, f[2]]);
    } else await h.cam(pos, target);
    await h.shot(`${OUT}/leviathan-${name}.png`);
  }
  // A call, seen side-on from 150 m.
  await h.eval(() => {
    const L = window.__game.leviathan;
    L.callTimer = 0;
    window.__game.simulate(1.6);
  });
  await h.cam(...side(150));
  await h.shot(`${OUT}/leviathan-call-150.png`);
  const head = await h.eval(() => window.__game.leviathan.headPosition.toArray());
  await h.cam([head[0] + views.rx * 90 - views.fx * 20, 1.7, head[2] + views.rz * 90 - views.fz * 20], [head[0], head[1] - 10, head[2]]);
  await h.shot(`${OUT}/leviathan-call-head.png`);
  const info = await h.eval(() => {
    const r = window.__game.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles };
  });
  console.log('render info (whole sandbox frame)', JSON.stringify(info));
  check(h.errors.length === 0, `sandbox console errors: ${h.errors.length}`);
  if (h.errors.length) console.log(h.errors.join('\n'));
  await h.close();
}

async function realGame() {
  const h = await launch({ html: 'dist/index.html', query: 'autostart&god' });
  const res = await h.eval(() => {
    const g = window.__game;
    const L = g.leviathan;
    const log = { foot: [], start: [], end: [] };
    let landMin = Infinity, jumped = -99; // teleports can put the player under a foot already landing
    g.bus.on('leviathan:footfall', (e) => {
      log.foot.push({ t: g.time, i: e.intensity, ok: !!e.pos?.isVector3 });
      if (g.time - jumped > 1.5) landMin = Math.min(landMin, Math.hypot(e.pos.x - g.player.position.x, e.pos.z - g.player.position.z));
    });
    g.bus.on('leviathan:call:start', (e) => log.start.push({ t: g.time, d: e.duration, ok: !!e.pos?.isVector3 }));
    g.bus.on('leviathan:call:end', (e) => log.end.push({ t: g.time, ok: !!e.pos?.isVector3 }));
    const level = g.level;
    let zones = level.zones || [];
    let injected = false;
    if (!zones.some((z) => z.leviathan?.calls === 'near') && zones.length) {
      // The foundation stub has no near zone. Add one at runtime (never in the stub file) so the
      // near cadence, loitering and near respawn get exercised; the phases force currentZone.
      const route = L.ensureRoute();
      const a = route.pointAt(route.length * 0.3, { x: 0, z: 0 });
      zones = level.zones = [
        { ...zones[0], leviathan: { calls: 'calm' } },
        { ...zones[0], id: 'near-test', index: zones.length, leviathan: { anchor: { x: a.x, z: a.z }, calls: 'near' } },
      ];
      zones[1].index = 1;
      injected = true;
    }
    const nearIdx = zones.findIndex((z) => z.leviathan?.calls === 'near');
    const calmIdx = zones.findIndex((z) => z.leviathan?.calls !== 'near');
    let maskInCall = 1, maskMaxOutside = 0, maskSamples = 0, maskAfterFall = [];
    let ms = 0, n = 0;
    const update = L.update.bind(L);
    L.update = (dt) => {
      const t0 = performance.now();
      update(dt);
      ms += performance.now() - t0;
      n++;
    };
    const run = (seconds) => {
      const step = 1 / 30;
      for (let i = 0; i < seconds / step; i++) {
        g.tick(step);
        if (L.calling) maskInCall = Math.min(maskInCall, g.noiseMask);
        else maskMaxOutside = Math.max(maskMaxOutside, g.noiseMask);
        maskSamples++;
        const last = log.foot[log.foot.length - 1];
        if (last && g.time - last.t > 0.85 && g.time - last.t < 0.9 && !L.calling) maskAfterFall.push(g.noiseMask);
      }
    };
    const phase = (name, zoneIdx, seconds) => {
      if (zoneIdx >= 0) {
        const z = zones[zoneIdx];
        const cp = level.checkpoints?.find((c) => c.zone === zoneIdx || c.zone === z.index || c.zone === z.id);
        const b = z.bounds;
        let p = cp?.pos;
        if (!p && b) {
          const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
          p = g.nav?.nearestWalkable?.(cx, cz, 60) ?? { x: cx, z: cz };
        }
        if (p) {
          g.teleport(p.x, p.z);
          jumped = g.time;
        }
      }
      const f0 = log.foot.length, s0 = log.start.length;
      const t0 = g.time;
      // The stub level does not track zones; force it when needed (a real level updates it itself).
      const steps = Math.ceil(seconds * 30);
      for (let i = 0; i < steps; i++) {
        if (zoneIdx >= 0 && level.currentZone !== zoneIdx && level.zoneAt?.(g.player.position) !== zoneIdx) level.currentZone = zoneIdx;
        run(1 / 30);
      }
      const foot = log.foot.slice(f0).map((f) => f.t);
      const starts = log.start.slice(s0).map((s) => s.t);
      const gaps = (a) => a.slice(1).map((t, i) => +(t - a[i]).toFixed(2));
      return {
        name, zone: level.currentZone, seconds: +(g.time - t0).toFixed(1), mode: L.mode,
        footfalls: foot.length, footGapAvg: +(gaps(foot).reduce((s, v) => s + v, 0) / Math.max(1, gaps(foot).length)).toFixed(2),
        footGapMax: Math.max(0, ...gaps(foot)), calls: starts.length, callGaps: gaps(starts),
      };
    };
    const out = [];
    out.push(phase('calm', calmIdx, 150));
    out.push(phase('near', nearIdx, 90));
    const distToAnchor = nearIdx >= 0 && zones[nearIdx].leviathan?.anchor
      ? Math.hypot(L.ground.x - zones[nearIdx].leviathan.anchor.x, L.ground.y - zones[nearIdx].leviathan.anchor.z) : null;
    // Needle colliders: one enabled box per foot planted in the street, none for lifted feet.
    const boxes = g.world.colliders.filter((c) => c.tag === 'leviathan-foot');
    const enabledBoxes = boxes.filter((c) => c.enabled).length;
    const groundFeet = L.legs.filter((l) => !l.swing && l.foot.y <= 0.3).length;
    // respawn (during a call if possible, to check it is cut cleanly)
    if (!L.calling) {
      L.callTimer = 0;
      g.tick(1 / 30);
    }
    const ends0 = log.end.length;
    g.respawn();
    const afterRespawn = {
      mask: g.noiseMask, calling: L.calling, endedCall: log.end.length - ends0, body: L.position.toArray().map((v) => +v.toFixed(1)),
    };
    // respawn into the near zone: placed on its anchor, feet clear of the spawn, a call soon
    let nearRespawn = null;
    if (nearIdx >= 0) {
      const z = zones[nearIdx];
      const cp = level.checkpoints.find((c) => c.zone === nearIdx || c.zone === z.id)
        ?? { id: 'near-test-cp', order: 99, pos: { x: z.leviathan.anchor.x - 20, z: z.leviathan.anchor.z + 30 }, yaw: 0, zone: nearIdx };
      g.checkpoint = cp;
      g.respawn();
      level.currentZone = nearIdx;
      const s0 = log.start.length, t0 = g.time;
      const feetMin = Math.min(...L.legs.map((l) => Math.hypot(l.foot.x - cp.pos.x, l.foot.z - cp.pos.z)));
      const anchorD = Math.hypot(L.ground.x - z.leviathan.anchor.x, L.ground.y - z.leviathan.anchor.z);
      for (let i = 0; i < 12 * 30; i++) {
        level.currentZone = nearIdx;
        g.tick(1 / 30);
      }
      nearRespawn = { mode: L.mode, anchorD, feetMin, firstCall: log.start[s0] ? log.start[s0].t - t0 : null };
    }
    return {
      injected, enabledBoxes, groundFeet, boxes: boxes.length, landMin, nearRespawn,
      out, distToAnchor, afterRespawn, maskInCall, maskMaxOutside, maskAfterFall: maskAfterFall.slice(0, 5),
      intensities: log.foot.slice(0, 8).map((f) => +f.i.toFixed(2)), payloadsOk: [...log.foot, ...log.start, ...log.end].every((e) => e.ok),
      callDur: log.start[0]?.d, ends: log.end.length, starts: log.start.length, avgMs: ms / n, nearIdx, calmIdx,
      drawCalls: g.renderer.info.render.calls,
    };
  });
  console.log('real game', JSON.stringify(res, null, 1));
  check(res.payloadsOk, 'event payloads carry Vector3 positions');
  check(res.maskInCall === 1, 'noiseMask is 1 for the whole call');
  check(res.maskMaxOutside <= 0.61, `footfall mask peaks at ${res.maskMaxOutside.toFixed(2)} (<= 0.6)`);
  check(res.avgMs < 0.5, `update() ${res.avgMs.toFixed(3)} ms per frame in the real game`);
  const calm = res.out[0];
  check(calm.footGapAvg >= 1.6 && calm.footGapAvg <= 4.5, `calm footfall cadence ${calm.footGapAvg}s`);
  check(calm.callGaps.every((g) => g >= 30), `calm call gaps ${calm.callGaps}`);
  check(res.maskAfterFall.every((m) => m < 0.05), `footfall mask has decayed 0.85 s later (${res.maskAfterFall})`);
  check(res.landMin >= 12.9, `no foot lands within 13 m of the player (min ${res.landMin.toFixed(1)} m)`);
  check(res.enabledBoxes === res.groundFeet, `needle colliders: ${res.enabledBoxes} enabled for ${res.groundFeet} street feet (${res.boxes} made)`);
  if (res.injected) console.log('note: stub level has no near zone; one was injected at runtime for these checks');
  if (res.nearIdx >= 0) {
    const near = res.out[1];
    check(near.mode === 'near', 'near zone -> near mode');
    check(near.calls >= 5 && near.callGaps.every((g) => g >= 9 && g <= 14), `near call gaps ${near.callGaps}`);
    check(res.distToAnchor !== null && res.distToAnchor < 40, `loiters at the anchor (${res.distToAnchor?.toFixed(1)} m)`);
    const nr = res.nearRespawn;
    check(nr.mode === 'near' && nr.anchorD < 1, `near respawn places it on the anchor (${nr.anchorD.toFixed(1)} m)`);
    check(nr.feetMin >= 12.9, `near respawn keeps feet off the spawn (${nr.feetMin.toFixed(1)} m)`);
    check(nr.firstCall !== null && nr.firstCall <= 9, `first call ${nr.firstCall?.toFixed(1)} s after a near respawn`);
  } else console.log('note: level has no zones; skipped near checks');
  check(!res.afterRespawn.calling && res.afterRespawn.mask === 0 && res.afterRespawn.endedCall === 1, 'respawn ends the call once and clears the mask');
  await h.page.waitForTimeout(800);
  await h.shot(`${OUT}/leviathan-game.png`);
  check(h.errors.length === 0, `game console errors: ${h.errors.length}`);
  if (h.errors.length) console.log(h.errors.join('\n'));
  await h.close();

  // Title screen: it stands in the title camera's frame, stays alive, and never shakes the camera.
  const t = await launch({ html: 'dist/index.html', query: 'god' });
  const title = await t.eval(() => {
    const g = window.__game;
    const L = g.leviathan;
    let foot = 0, calls = 0;
    g.bus.on('leviathan:footfall', () => foot++);
    g.bus.on('leviathan:call:start', () => calls++);
    g.simulate(40);
    g.render();
    g.camera.updateMatrixWorld();
    const ndc = L.position.clone().project(g.camera);
    return { state: g.state, mode: L.mode, ndc: ndc.toArray(), trauma: g.player.trauma, foot, calls, mask: g.noiseMask };
  });
  console.log('title', JSON.stringify(title));
  check(title.state === 'title' && title.mode === 'title', 'title state -> title mode');
  check(Math.abs(title.ndc[0]) < 0.95 && Math.abs(title.ndc[1]) < 0.95 && title.ndc[2] < 1, `body is inside the title frame (ndc ${title.ndc.map((v) => v.toFixed(2))})`);
  check(title.foot >= 8 && title.calls >= 1, `alive on the title screen (${title.foot} footfalls, ${title.calls} calls in 40 s)`);
  check(title.trauma === 0, 'no camera shake on the title screen');
  await t.shot(`${OUT}/leviathan-title.png`);
  check(t.errors.length === 0, `title console errors: ${t.errors.length}`);
  if (t.errors.length) console.log(t.errors.join('\n'));
  await t.close();
}

if (only('--sandbox')) await sandbox();
if (only('--game')) await realGame();
if (failed) process.exitCode = 1;
