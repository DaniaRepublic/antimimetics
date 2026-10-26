// Checks for the snatcher model (src/ai/snatcherModel.js), run against the sandbox page:
//   node tools/check-snatcher-model.mjs [--no-build] [--no-shots]
// - per-instance draw calls / triangles, 16-instance totals, update() cost
// - foot sliding while walking (planted feet must stay planted)
// - headAnchor framing for the death camera
// - screenshots under dist/shots/snatcher-*.png
// Exits non-zero on console errors or a failed budget.
import { execSync } from 'node:child_process';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const html = 'dist/sandbox-snatcher-model.html';
if (!args.includes('--no-build')) {
  execSync(`node build.mjs --entry tools/sandbox/snatcher-model.js --out ${html}`, { stdio: 'inherit' });
}
const shots = !args.includes('--no-shots');
const out = 'dist/shots/';
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

// --- one-off asset cost: painting faces + building geometry for 4 new variants on a fresh page.
{
  const f = await launch({ html, query: 'paused&modes=idle&seed=0' });
  const t = await f.eval(() => {
    const g = window.__game;
    const t0 = performance.now();
    g.setup([1, 2, 3, 4].map((seed, i) => ({ seed, mode: 'idle', x: i, z: -3 })));
    const t1 = performance.now();
    g.renderer.render(g.scene, g.camera);
    return { buildMs: Math.round(t1 - t0), firstRenderMs: Math.round(performance.now() - t1) };
  });
  console.log(JSON.stringify(t));
  check(t.buildMs < 2500, `4 face variants built in ${t.buildMs} ms (headless) < 2500`);
  if (f.errors.length) failures.push('console errors (asset page)');
  await f.close();
}

const h = await launch({ html, query: 'paused' });

// --- cost per instance (one model in view vs none) and for 16 on screen
const cost = await h.eval(() => {
  const g = window.__game;
  const measure = () => {
    g.renderer.render(g.scene, g.camera);
    return { calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles };
  };
  g.camera.position.set(0, 1.6, 4);
  g.camera.lookAt(0, 1.2, -2);
  g.setup([]);
  const base = measure();
  g.setup([{ seed: 0, mode: 'idle', x: 0, z: -2, yaw: Math.PI }]);
  g.advance(0.5);
  const one = measure();
  const modes = ['idle', 'walk', 'chase', 'search', 'suspicious', 'rapture', 'investigate', 'alarm'];
  g.setup(Array.from({ length: 16 }, (_, i) => ({
    seed: i, mode: modes[i % 8], x: (i % 4) * 1.6 - 2.4, z: -3 - Math.floor(i / 4) * 1.8, yaw: Math.PI,
    path: ['walk', 'chase', 'search', 'investigate'].includes(modes[i % 8]) ? 'circle' : null, len: 0.6,
  })));
  g.advance(1);
  g.camera.position.set(0, 3, 4);
  g.camera.lookAt(0, 1, -5);
  const sixteen = measure();
  // update() cost: 16 snatchers x 600 frames at 60 Hz.
  const t0 = performance.now();
  g.advance(10, 1 / 60);
  const ms = (performance.now() - t0) / 600;
  return {
    perInstance: { calls: one.calls - base.calls, triangles: one.triangles - base.triangles },
    sixteen: { calls: sixteen.calls - base.calls, triangles: sixteen.triangles - base.triangles },
    updateMsPer16: +ms.toFixed(3),
    updateMsPerInstance: +(ms / 16).toFixed(4),
  };
});
console.log(JSON.stringify(cost));
check(cost.perInstance.calls <= 4, `draw calls per snatcher ${cost.perInstance.calls} <= 4`);
check(cost.perInstance.triangles <= 6000, `triangles per snatcher ${cost.perInstance.triangles} <= 6000`);
check(cost.updateMsPerInstance < 0.25, `update() ${cost.updateMsPerInstance} ms per snatcher (headless CPU) < 0.25`);

// --- foot sliding: while a foot is planted (ankle near the ground), its world position must not move.
const slide = await h.eval(() => {
  const g = window.__game;
  const res = {};
  for (const [mode, speed] of [['walk', 1.25], ['investigate', 1.2], ['search', 1.0], ['chase', 3.9], ['search', 0.6], ['investigate', 0.3]]) {
    g.setup([{ seed: 1, mode, x: 0, z: 0, yaw: 0, path: 'pace', len: 400, speed }]);
    g.advance(2);
    const s = g.models[0];
    const foot = s.model.mesh.skeleton.bones.find((b) => b.name === 'footL');
    const p = foot.position.clone();
    let prev = null, planted = 0, slideSum = 0, slideMax = 0, frames = 0;
    for (let i = 0; i < 360; i++) {
      g.step(1 / 60);
      s.model.root.updateMatrixWorld(true);
      foot.getWorldPosition(p);
      const onGround = p.y < 0.0765; // ankle rest height 0.075 (flat, planted foot)
      if (onGround && prev) {
        const v = Math.hypot(p.x - prev.x, p.z - prev.z) * 60;
        slideSum += v;
        slideMax = Math.max(slideMax, v);
        planted++;
      }
      prev = onGround ? p.clone() : null;
      frames++;
    }
    res[`${mode}@${speed}`] = { speed, plantedFrac: +(planted / frames).toFixed(2), meanSlide: +(slideSum / Math.max(1, planted)).toFixed(3), maxSlide: +slideMax.toFixed(3) };
  }
  return res;
});
console.log(JSON.stringify(slide));
for (const [mode, r] of Object.entries(slide)) {
  check(r.plantedFrac > 0.2, `${mode}: a foot is planted ${Math.round(r.plantedFrac * 100)}% of frames`);
  check(r.meanSlide < 0.08 * r.speed, `${mode}: mean planted-foot slide ${r.meanSlide} m/s (< 8% of ${r.speed} m/s)`);
}

// --- headYaw / headPitch are honoured on top of the pose (alarm: no scan, no twitches).
const look = await h.eval(() => {
  const g = window.__game;
  const res = [];
  for (const [yaw, pitch, mode] of [[0.8, 0.3, 'alarm'], [-1.2, -0.2, 'alarm'], [0.5, 0, 'chase']]) {
    g.setup([{ seed: 2, mode, x: 0, z: 0, yaw: 0.4, headYaw: yaw, headPitch: pitch }]);
    g.advance(2);
    g.scene.updateMatrixWorld(true);
    const e = g.models[0].model.headAnchor.parent.matrixWorld.elements;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const worldYaw = Math.atan2(-fx, -fz);
    res.push({ mode, yaw, pitch, gotYaw: +(worldYaw - 0.4).toFixed(3), gotPitch: +Math.atan2(fy, Math.hypot(fx, fz)).toFixed(3) });
  }
  return res;
});
console.log(JSON.stringify(look));
for (const r of look) {
  // alarm adds a +0.05 gaze bias; chase adds jerky tremor.
  const tol = r.mode === 'chase' ? 0.2 : 0.08;
  check(Math.abs(r.gotYaw - r.yaw) < tol, `${r.mode}: headYaw ${r.yaw} -> face yaw ${r.gotYaw} relative to body`);
  check(Math.abs(r.gotPitch - r.pitch) < tol + 0.06, `${r.mode}: headPitch ${r.pitch} -> face pitch ${r.gotPitch}`);
}

// --- robustness: what an AI built against the contract may plausibly pass.
const robust = await h.eval(() => {
  const g = window.__game;
  const V = g.camera.position.constructor;
  const bone = (m, n) => m.mesh.skeleton.bones.find((b) => b.name === n);
  const res = {};
  // Garbage inputs must never throw or poison the skeleton with NaN.
  g.setup([{ seed: 4, mode: 'idle', x: 0, z: 0 }]);
  const m = g.models[0].model;
  const junk = [
    [NaN, { speed: NaN, mode: undefined, headYaw: Infinity, headPitch: -Infinity, alert: 'x' }],
    [-1, { speed: -3, mode: 'constructor', headYaw: 40, headPitch: 9 }],
    [10, { speed: 1e9, mode: 'toString', alert: 7 }],
    [1 / 60, null],
    [1 / 60, undefined],
    [0, { mode: 'chase', speed: 3.9 }],
  ];
  let threw = null;
  let finite = true;
  const bonesFinite = () => m.mesh.skeleton.bones.every((b) => [...b.position.toArray(), ...b.quaternion.toArray()].every(Number.isFinite));
  try {
    for (let i = 0; i < 30; i++) {
      for (const [dt, a] of junk) {
        m.update(dt, a);
        finite = finite && bonesFinite();
      }
    }
  } catch (e) {
    threw = String(e);
  }
  g.scene.updateMatrixWorld(true);
  res.threw = threw;
  res.finite = finite && m.mesh.skeleton.bones.every((b) => b.matrixWorld.elements.every(Number.isFinite));
  // First placement within a few metres of the world origin must not drag the cape over the head.
  g.setup([{ seed: 1, mode: 'idle', x: 0, z: 0 }]);
  const s = g.models[0].model;
  s.root.position.set(2.5, 0, -1);
  s.root.rotation.y = Math.PI;
  let hem = 0;
  for (let i = 0; i < 30; i++) {
    s.update(1 / 60, { mode: 'idle', speed: 0 });
    g.scene.updateMatrixWorld(true);
    for (let k = 28; k < 35; k++) hem = Math.max(hem, bone(s, `cape${k}`).getWorldPosition(new V()).y);
  }
  res.spawnHemMaxY = +hem.toFixed(3);
  // A respawn 2 m back after a chase snaps the pose and the cape.
  g.setup([{ seed: 3, mode: 'chase', x: 0, z: 0, yaw: 0 }]);
  const c = g.models[0].model;
  let z = 0;
  for (let i = 0; i < 120; i++) {
    z -= 3.9 / 60;
    c.root.position.set(0, 0, z);
    c.update(1 / 60, { mode: 'chase', speed: 3.9 });
  }
  c.root.position.set(0, 0, z + 2);
  c.update(1 / 60, { mode: 'idle', speed: 0 });
  g.scene.updateMatrixWorld(true);
  hem = 0;
  for (let k = 28; k < 35; k++) hem = Math.max(hem, bone(c, `cape${k}`).getWorldPosition(new V()).y);
  res.respawnHemMaxY = +hem.toFixed(3);
  res.respawnArmX = +bone(c, 'armL').rotation.x.toFixed(3);
  // Spawn ids as seeds: distinct ids should spread over the faces.
  g.setup(['z1-patrol', 'z1-sentry', 'z2-a', 'z2-b', 'z2-c', 'z3-d'].map((seed, i) => ({ seed, mode: 'idle', x: i, z: -3 })));
  res.idVariants = new Set(g.models.map((x) => x.model.variant)).size;
  // AI state names ('patrol', 'return') pose like walking when moving, standing when not.
  const pose = (mode, speed) => {
    g.setup([{ seed: 1, mode: 'idle', x: 0, z: 0, yaw: 0 }]);
    const mm = g.models[0].model;
    let zz = 0;
    for (let i = 0; i < 120; i++) {
      zz -= speed / 60;
      mm.root.position.set(0, 0, zz);
      mm.update(1 / 60, { mode, speed });
    }
    return bone(mm, 'spine').rotation.x;
  };
  res.aliasErr = +Math.max(Math.abs(pose('patrol', 1.25) - pose('walk', 1.25)), Math.abs(pose('return', 1.25) - pose('walk', 1.25)), Math.abs(pose('patrol', 0) - pose('idle', 0))).toFixed(4);
  return res;
});
console.log(JSON.stringify(robust));
check(!robust.threw && robust.finite, `junk anim input/dt: no throw (${robust.threw}), finite skeleton (${robust.finite})`);
check(robust.spawnHemMaxY < 0.4, `first placement near the origin: cape hem stays low (max ${robust.spawnHemMaxY} m)`);
check(robust.respawnHemMaxY < 0.4 && Math.abs(robust.respawnArmX - 0.36) < 0.12, `respawn jump snaps cape (hem ${robust.respawnHemMaxY} m) and pose (arm ${robust.respawnArmX})`);
check(robust.idVariants >= 3, `string seeds spread over ${robust.idVariants} face variants`);
check(robust.aliasErr < 0.01, `AI states 'patrol'/'return' pose as walk/idle (err ${robust.aliasErr})`);

// --- death cam: grab pose brings the face close to a standing player's eye.
const grab = await h.eval(() => {
  const g = window.__game;
  g.setup([{ seed: 0, mode: 'grab', x: 0, z: 0, yaw: Math.PI }]);
  g.advance(1.5);
  return g.faceCam(0, 1.0);
});
console.log(JSON.stringify(grab));
check(grab.distance > 0.3 && grab.distance < 0.6, `grab: face ${grab.distance.toFixed(2)} m from the eye at 1.0 m root distance`);
check(Math.abs(grab.head[1] - 1.65) < 0.2, `grab: face height ${grab.head[1].toFixed(2)} m near eye height`);

// --- death cam when the AI's root ends up too close (caught mid-stride): the visible body slides
// back from the scene camera so the face still lands ~0.4 m away, not inside the near plane.
const grabClose = await h.eval(() => {
  const g = window.__game;
  const V = g.camera.position.constructor;
  g.setup([{ seed: 0, mode: 'grab', x: 0, z: 0, yaw: Math.PI }]);
  const had = g.camera.parent;
  g.scene.add(g.camera);
  g.camera.position.set(0, 1.65, 0.52); // root 0.52 m away, in front of it (it faces +Z)
  g.camera.updateMatrixWorld();
  g.advance(1.5);
  const head = g.models[0].model.headAnchor.getWorldPosition(new V());
  const d = head.distanceTo(g.camera.position);
  // and once it lets go, the body eases back onto its root
  for (let i = 0; i < 120; i++) g.models[0].model.update(1 / 60, { mode: 'idle' });
  const rig = g.models[0].model.root.children[0].position;
  if (had) had.add(g.camera);
  else g.scene.remove(g.camera);
  return { d, rigBack: Math.hypot(rig.x, rig.z) };
});
console.log(JSON.stringify(grabClose));
check(grabClose.d > 0.3 && grabClose.d < 0.6, `grab at 0.52 m root distance: face ${grabClose.d.toFixed(2)} m from the camera`);
check(grabClose.rigBack < 0.05, `after the grab the body returns to its root (${grabClose.rigBack.toFixed(3)} m off)`);

// --- respawn straight out of a grab (the root jumps back to its post): the body must snap onto
// the root on that very update, not glide the grab offset back over the next second.
const grabRespawn = await h.eval(() => {
  const g = window.__game;
  g.setup([{ seed: 1, mode: 'grab', x: 0, z: 0, yaw: Math.PI }]);
  const had = g.camera.parent;
  g.scene.add(g.camera);
  g.camera.position.set(0, 1.65, 0.3);
  g.camera.updateMatrixWorld();
  g.advance(1.5);
  const m = g.models[0].model;
  const rig = m.root.children[0].position;
  const during = Math.hypot(rig.x, rig.z);
  m.root.position.set(25, 0, -40); // respawn: back at its post
  m.root.updateMatrixWorld();
  m.update(1 / 30, { mode: 'idle' });
  const after = Math.hypot(rig.x, rig.z);
  // a continuing grab is not mistaken for a teleport (the offset stays while it holds on)
  m.root.position.set(0, 0, 0);
  m.root.updateMatrixWorld();
  for (let i = 0; i < 45; i++) m.update(1 / 30, { mode: 'grab' });
  const held = Math.hypot(rig.x, rig.z);
  if (had) had.add(g.camera);
  else g.scene.remove(g.camera);
  return { during, after, held };
});
console.log(JSON.stringify(grabRespawn));
check(grabRespawn.during > 0.6 && grabRespawn.after === 0, `respawn out of a grab snaps the body onto its root (${grabRespawn.during.toFixed(2)} -> ${grabRespawn.after.toFixed(3)} m)`);
check(grabRespawn.held > 0.6, `a held grab keeps its offset (${grabRespawn.held.toFixed(2)} m)`);

// --- sleepers: anim.slump sits the figure down; easing it to 0 over 1.5 s gets it up again.
const slump = await h.eval(() => {
  const g = window.__game;
  const V = g.camera.position.constructor;
  g.setup([{ seed: 2, mode: 'idle', x: 0, z: 0, yaw: Math.PI }]);
  const m = g.models[0].model;
  const bone = (n) => m.mesh.skeleton.bones.find((b) => b.name === n);
  const read = () => {
    g.scene.updateMatrixWorld(true);
    const hips = bone('hips').getWorldPosition(new V());
    const head = m.headAnchor.getWorldPosition(new V());
    const feet = ['footL', 'footR'].map((n) => bone(n).getWorldPosition(new V()));
    const hands = ['fing2L', 'fing2R'].map((n) => bone(n).getWorldPosition(new V()));
    return { hips: hips.y, head: head.y, feetMinY: Math.min(...feet.map((f) => f.y)), handsMinY: Math.min(...hands.map((f) => f.y)) };
  };
  for (let i = 0; i < 120; i++) m.update(1 / 60, { mode: 'idle', slump: 1 });
  const seated = read();
  let minHead = Infinity, maxHead = -Infinity, finite = true;
  const track = [];
  for (let i = 0; i <= 150; i++) {
    m.update(1 / 60, { mode: 'idle', slump: Math.max(0, 1 - i / 90), headPitch: -0.3 });
    const r = read();
    finite = finite && Object.values(r).every(Number.isFinite);
    if (i % 15 === 0) track.push(+r.head.toFixed(2));
    minHead = Math.min(minHead, r.head);
    maxHead = Math.max(maxHead, r.head);
  }
  const standing = read();
  return { seated, standing, track, finite };
});
console.log(JSON.stringify(slump));
check(slump.finite, 'slump: finite pose throughout the get-up');
check(slump.seated.hips < 0.4 && slump.seated.head < 1.15, `slump 1: sat on the ground (hips ${slump.seated.hips.toFixed(2)} m, face ${slump.seated.head.toFixed(2)} m)`);
check(slump.seated.feetMinY > -0.02 && slump.seated.handsMinY > -0.06, `slump 1: feet and fingertips not under the ground (${slump.seated.feetMinY.toFixed(2)}, ${slump.seated.handsMinY.toFixed(2)})`);
check(slump.standing.head > 1.9 && slump.standing.hips > 0.95, `slump eased to 0: standing again (face ${slump.standing.head.toFixed(2)} m)`);
check(slump.track.every((v, i) => i === 0 || v >= slump.track[i - 1] - 0.05), `get-up rises monotonically (${slump.track.join(' ')})`);

// --- screenshots
if (shots) {
  const set = async (defs, adv) => h.eval(([d, a]) => {
    const g = window.__game;
    g.debugCamera = null;
    g.setup(d);
    g.advance(a);
  }, [defs, adv]);
  const PI = Math.PI;
  // Line-up in the mood lighting.
  await set(['idle', 'walk', 'suspicious', 'chase', 'rapture'].map((mode, i) => ({ seed: i, mode, x: (i - 2) * 1.9, z: -4.5, yaw: PI })), 2);
  await h.cam([0, 1.6, 1.2], [0, 1.3, -4.5]);
  await h.shot(out + 'snatcher-lineup.png');
  // Death-cam close-ups of every face.
  for (let v = 0; v < 5; v++) {
    await set([{ seed: v, mode: 'grab', x: 0, z: 0, yaw: PI }], 1.6);
    await h.eval(() => window.__game.faceCam(0, 1.0));
    await h.shot(out + `snatcher-grab-${v}.png`);
  }
  // Chase, side on.
  await set([{ seed: 3, mode: 'chase', x: 0, z: 0, yaw: PI / 2, path: 'pace', len: 100 }], 1.3);
  await h.eval(() => {
    const g = window.__game;
    const p = g.models[0].model.root.position;
    g.debugCamera = { pos: [p.x, 1.2, p.z + 3.4], target: [p.x, 1.1, p.z] };
  });
  await h.shot(out + 'snatcher-chase.png');
}

if (h.errors.length) {
  console.log('ERRORS:\n' + h.errors.join('\n'));
  failures.push('console errors');
}
await h.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exitCode = failures.length ? 1 : 0;
