// Art-direction tour of the real game: screenshots from ~20 viewpoints along the route (every
// zone, eye height, standing and crouched, facing forward and toward the leviathan), the title
// screen, snatchers at 5/15/30 m, the leviathan from each zone, a call in progress and the death
// cam (a real catch, captured at ~1.0/1.8/2.4 s into 'caught').
//
//   node tools/visual-tour.mjs [--no-build] [--quality 2] [--only z1,title,...] [--out dir]
//                              [--hud] [--stats] [--html dist/index.html] [--death-fix]
//
// The game loop is frozen while shooting (the tour advances time itself), so every image is
// deterministic up to the AI's Math.random idles. Prints luminance stats per image with --stats.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const quality = opt('--quality', '2');
const out = opt('--out', `dist/shots/visual/q${quality}`);
const only = opt('--only', null)?.split(',');
const want = (name) => !only || only.some((o) => name.startsWith(o));
const showHud = args.includes('--hud');
const stats = args.includes('--stats');
const html = opt('--html', 'dist/index.html');

if (!args.includes('--no-build')) execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
fs.mkdirSync(out, { recursive: true });

const PI = Math.PI;
const N = 0, E = -PI / 2, W = PI / 2, S = PI;

// name, x, z, yaw, pitch, crouched, [look: 'lev' to face the leviathan]
const VIEWS = [
  ['z0_start', 0, 4, N, 0.02, false],
  ['z0_van_crouch', 0.8, -6, N - 0.08, 0.0, true],
  ['z0_mouth', 0, -19, N, 0.03, false],
  ['z0_lev', 0, -10, 0, 0, false, 'lev'],
  ['z0_mouth_lev', 0, -23, 0, 0, false, 'lev'],
  ['z1_street', 0, -30, N, 0.02, false],
  ['z1_cover_crouch', -6.5, -45.5, N + 0.1, 0.0, true],
  ['z1_fire', 3.5, -72, N + 0.05, 0.0, false],
  ['z1_laundromat', 5.5, -84, N + 0.55, 0.0, true],
  ['z1_pharmacy_gap', 4, -110, N - 0.6, 0.02, false],
  ['z1_lev', 0, -60, 0, 0, false, 'lev'],
  ['z1_cross_lev', 2, -76, 0, 0, false, 'lev'],
  ['z1_pharmacy_in', 15.5, -118, N + 0.5, 0.0, true],
  ['z2_yard', 20.7, -141, N + 0.25, 0.04, false],
  ['z2_arch', 16, -158, N + 0.35, 0.03, true],
  ['z2_gas', -14, -164, W - 0.15, 0.0, true],
  ['z2_arch_near', 9, -184, N + 0.3, 0.06, true],
  ['z2_lev', 10, -170, 0, 0, false, 'lev'],
  ['z3_entrance', 4, -219, N + 0.05, 0.04, false],
  ['z3_bus_crouch', 0.2, -249, N + 0.1, 0.0, true],
  ['z3_mid', 1.5, -284, N, 0.05, false],
  ['z3_lev', 0, -262, 0, 0, false, 'lev'],
  ['z4_ramp', -6, -346, N, 0.04, false],
  ['z4_gate', 0, -383, N - 0.05, 0.02, true],
  ['z4_garage', -24, -350, N, 0.0, true],
  ['z4_lev', -2, -360, 0, 0, false, 'lev'],
  ['z4_exit', 0, -414, N, 0.03, false],
];

const h = await launch({ html, query: `autostart&god&quality=${quality}`, timeout: 120000 });
const page = h.page;
page.setDefaultTimeout(240000);

await h.eval((hud) => {
  const g = window.__game;
  // Freeze the real-time loop: the tour advances the world explicitly (deterministic shots).
  g.__tick = g.tick.bind(g);
  g.tick = () => {};
  // Place the camera as game.render() would before each tick: the atmosphere ranks its pooled
  // lights from the camera, so a frozen camera would light a viewpoint with the previous one's lamps.
  g.__cam = () => {
    const tc = g.level.titleCamera;
    if (g.state === 'title' && tc) {
      g.camera.position.set(tc.pos[0], tc.pos[1], tc.pos[2]);
      g.camera.lookAt(tc.target[0], tc.target[1], tc.target[2]);
    } else g.player.applyCamera(g.camera);
    g.camera.updateMatrixWorld();
  };
  g.__step = (step) => {
    g.__cam();
    g.__tick(step);
  };
  g.__sim = (seconds, step = 1 / 30) => {
    const n = Math.ceil(seconds / step);
    for (let i = 0; i < n; i++) g.__step(step);
  };
  if (!hud) {
    const s = document.createElement('style');
    s.id = 'tour-hide-hud';
    s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
    document.head.appendChild(s);
  }
}, showHud);

async function lum(file) {
  if (!stats) return '';
  // Median / mean luminance of the screenshot, measured in the page (canvas readback).
  const data = fs.readFileSync(file).toString('base64');
  const r = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width >> 2;
    c.height = img.height >> 2;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const ls = [];
    for (let i = 0; i < d.length; i += 4) ls.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    ls.sort((a, b) => a - b);
    const mean = ls.reduce((a, b) => a + b, 0) / ls.length;
    const q = (p) => ls[Math.floor(p * (ls.length - 1))];
    return { median: q(0.5), mean, p10: q(0.1), p90: q(0.9), p99: q(0.99) };
  }, data);
  return ` lum median ${r.median.toFixed(1)} mean ${r.mean.toFixed(1)} p10 ${r.p10.toFixed(1)} p90 ${r.p90.toFixed(1)} p99 ${r.p99.toFixed(1)}`;
}

async function snap(name) {
  const file = path.join(out, `${name}.png`);
  const t0 = Date.now();
  await h.shot(file);
  const info = await h.eval(() => {
    const g = window.__game;
    const a = g.atmosphere.getDebugInfo();
    return { calls: a.calls, tris: a.triangles, sceneCalls: a.sceneCalls, q: a.quality };
  });
  console.log(`${name}: ${info.calls} calls (${info.sceneCalls} scene), ${(info.tris / 1000).toFixed(0)}k tris, q${info.q}, ${((Date.now() - t0) / 1000).toFixed(1)}s${await lum(file)}`);
  return info;
}

// Put the player at (x, z) facing yaw/pitch; re-place the leviathan for that spot (as on respawn).
async function viewpoint(x, z, yaw, pitch, crouched, look) {
  await h.eval(([x, z, yaw, pitch, crouched, look]) => {
    const g = window.__game;
    g.debugCamera = null;
    g.teleport(x, z, yaw);
    g.player.crouched = crouched;
    g.player.eyeHeight = crouched ? 0.95 : 1.65;
    g.player.pitch = pitch;
    g.leviathan.placeForCheckpoint({ pos: { x, z } });
    if (g.leviathan.calling) g.leviathan.endCall?.();
    g.leviathan.callTimer = 999; // no call in the plain views (the 'call' shots trigger one)
    g.__sim(1.2);
    g.player.pitch = pitch;
    if (look === 'lev') {
      // Face the leviathan: aim at a point ~40% up its body height so legs and body both show.
      const L = g.leviathan.position;
      const eye = g.player.getEyePos(new g.player.position.constructor());
      const dx = L.x - eye.x, dz = L.z - eye.z;
      g.player.yaw = Math.atan2(-dx, -dz);
      g.player.pitch = Math.atan2(L.y * 0.62 - eye.y, Math.hypot(dx, dz));
    }
  }, [x, z, yaw, pitch, crouched, look ?? null]);
}

const results = {};

// ------------------------------------------------------------------ title screen
if (want('title')) {
  await h.eval(() => {
    const g = window.__game;
    document.getElementById('tour-hide-hud')?.remove();
    g.setState('title');
    g.leviathan.firstUpdate = true; // re-place for the title shot
    g.__sim(3);
  });
  results.title = await snap('title');
  const tp = await h.eval(() => {
    const g = window.__game;
    // where the leviathan sits in the frame (0 = bottom, 1 = top)
    const v = g.leviathan.position.clone().project(g.camera);
    const hd = g.leviathan.headPosition.clone().project(g.camera);
    g.setState('playing');
    return { body: [v.x * 0.5 + 0.5, v.y * 0.5 + 0.5], head: [hd.x * 0.5 + 0.5, hd.y * 0.5 + 0.5], lev: g.leviathan.position.toArray().map(Math.round) };
  });
  console.log(`  title: leviathan body at screen ${tp.body.map((v) => v.toFixed(2))}, head ${tp.head.map((v) => v.toFixed(2))}, world ${tp.lev}`);
  if (!showHud) {
    await h.eval(() => {
      const s = document.createElement('style');
      s.id = 'tour-hide-hud';
      s.textContent = '#wic-hud, #wic-hud * { visibility: hidden !important; }';
      document.head.appendChild(s);
    });
  }
}

// ------------------------------------------------------------------ route
for (const [name, x, z, yaw, pitch, crouched, look] of VIEWS) {
  if (!want(name)) continue;
  await viewpoint(x, z, yaw, pitch, crouched, look);
  results[name] = await snap(name);
}

// ------------------------------------------------------------------ a call in progress (Z3)
if (want('call')) {
  await viewpoint(0.5, -232, N + 0.15, 0.25, true);
  await h.eval(() => {
    const g = window.__game;
    g.leviathan.callTimer = 0.01;
    g.__sim(1.8);
  });
  results.call = await snap('call_z3');
  await h.eval(() => {
    const g = window.__game;
    const L = g.leviathan.position;
    const eye = g.player.getEyePos(new g.player.position.constructor());
    const dx = L.x - eye.x, dz = L.z - eye.z;
    g.player.yaw = Math.atan2(-dx, -dz);
    g.player.pitch = Math.atan2(L.y * 0.7 - eye.y, Math.hypot(dx, dz));
    g.__sim(0.6);
  });
  results.callLev = await snap('call_z3_lev');
}

// ------------------------------------------------------------------ snatcher close-ups
if (want('snatcher')) {
  // The Z1 sentry in the laundromat light, a Z3 devout on the dark boulevard sidewalk, the Z4
  // sleeper in the garage: seen from the street at about 5, 15 and 30 m (crouched, as a player
  // sneaking up would see them).
  const subjects = [
    ['snatcher_lit', 'z1_sentry', [[-4.8, -88.6], [3.4, -82], [3.2, -62.5]]],
    ['snatcher_dark', 'z3_devout_2', [[10.5, -257.2], [0.6, -262.5], [-12.6, -267]]],
    ['snatcher_sleeper', 'z4_sleeper', [[-14.6, -386.6], [-17.4, -373.2]]],
  ];
  for (const [label, id, spots] of subjects) {
    for (const [x, z] of spots) {
      const d = await h.eval(([id, x, z]) => {
        const g = window.__game;
        const s = g.director.snatchers.find((e) => e.id === id);
        if (!s) return null;
        s.reset();
        g.teleport(x, z, Math.atan2(-(s.position.x - x), -(s.position.z - z)));
        g.leviathan.placeForCheckpoint({ pos: { x, z } });
        g.player.crouched = true;
        g.player.eyeHeight = 0.95;
        g.__sim(0.8);
        s.reset(); // keep the subject calm in its own pose (the tour player is not sneaking)
        g.__sim(0.3);
        const head = s.getHeadPos(new s.position.constructor());
        const eye = g.player.getEyePos(new s.position.constructor());
        const dx = head.x - eye.x, dz = head.z - eye.z;
        g.player.yaw = Math.atan2(-dx, -dz);
        g.player.pitch = Math.atan2(head.y - 0.6 - eye.y, Math.hypot(dx, dz));
        return Math.round(Math.hypot(dx, dz));
      }, [id, x, z]);
      if (d != null) results[`${label}_${d}`] = await snap(`${label}_${d}m`);
    }
  }
}

// ------------------------------------------------------------------ the sleeper waking up
if (want('sleeper')) {
  const ok = await h.eval(() => {
    const g = window.__game;
    const s = g.director.snatchers.find((e) => e.id === 'z4_sleeper');
    if (!s) return false;
    s.reset();
    const x = s.position.x + 4.2, z = s.position.z - 1.5;
    g.teleport(x, z, 0);
    g.leviathan.placeForCheckpoint({ pos: { x, z } });
    g.player.crouched = true;
    g.player.eyeHeight = 0.95;
    g.__sim(1.0);
    const head = s.getHeadPos(new s.position.constructor());
    const eye = g.player.getEyePos(new s.position.constructor());
    g.player.yaw = Math.atan2(-(head.x - eye.x), -(head.z - eye.z));
    g.player.pitch = Math.atan2(head.y + 0.2 - eye.y, Math.hypot(head.x - eye.x, head.z - eye.z));
    return true;
  });
  if (ok) {
    results.sleeper = await snap('sleeper_asleep');
    // A bottle shatters next to it: it wakes, unfolds and gets up.
    await h.eval(() => {
      const g = window.__game;
      const s = g.director.snatchers.find((e) => e.id === 'z4_sleeper');
      g.bus.emit('noise', { pos: s.position.clone().add(new s.position.constructor(1.5, 0, 2)), radius: 20, loudness: 1, source: 'bottle' });
      let t = 0;
      while (s.slump > 0.5 && t < 6) {
        g.__step(1 / 30);
        t += 1 / 30;
      }
    });
    results.sleeperWake = await snap('sleeper_waking');
  }
}

// ------------------------------------------------------------------ death cam
if (want('death')) {
  const r = await h.eval(() => {
    const g = window.__game;
    const s = g.director.snatchers.find((e) => e.id === 'z1_sentry');
    s.reset();
    g.god = false;
    g.teleport(s.position.x + 4.5, s.position.z + 0.3, Math.PI / 2);
    g.player.crouched = false;
    g.player.eyeHeight = 1.65;
    g.player.pitch = 0;
    let t = 0;
    while (g.state !== 'caught' && t < 25) {
      g.__step(1 / 30);
      t += 1 / 30;
    }
    return { state: g.state, t, caughtBy: g.caughtBy?.id };
  });
  console.log('death setup:', JSON.stringify(r));
  // --death-fix: emulate the requested AI fix (the grabbing snatcher stands 1.08 m from the player,
  // the distance the grab pose is built for) to judge the framing as designed.
  if (r.state === 'caught' && args.includes('--death-fix')) {
    const d = await h.eval(() => {
      const g = window.__game;
      const s = g.caughtBy, p = g.player.position;
      const dx = s.position.x - p.x, dz = s.position.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (d < 1.05) {
        s.position.x = p.x + (dx / d) * 1.08;
        s.position.z = p.z + (dz / d) * 1.08;
      }
      return d;
    });
    console.log(`  (root was ${d.toFixed(2)} m from the player; moved to 1.08 m)`);
  }
  if (r.state === 'caught') {
    for (const at of [1.0, 1.8, 2.4]) {
      await h.eval((at) => {
        const g = window.__game;
        while (g.stateTime < at && g.state === 'caught') g.__step(1 / 30);
      }, at);
      results[`death_${at}`] = await snap(`death_${at.toFixed(1)}s`);
    }
  }
}

console.log(h.errors.length ? 'ERRORS:\n' + h.errors.join('\n') : 'no console errors');
const maxCalls = Math.max(...Object.values(results).map((r) => r.calls));
console.log(`max draw calls: ${maxCalls}`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
await h.close();
if (h.errors.length) process.exitCode = 1;
