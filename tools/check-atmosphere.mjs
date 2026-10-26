// Atmosphere checks: screenshots of the calibration sandbox and the game under every mood the
// module drives (threat, call, footfall, death), plus unit checks of the light pool and the
// stealth light level, and update-cost timing.
//   node tools/check-atmosphere.mjs [--no-build] [--only street,sky,...] [--skip-game] [--out dir]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = opt('--out', 'dist/shots/atmosphere');
const only = opt('--only', null)?.split(',');
const want = (name) => !only || only.some((o) => name.startsWith(o));

if (!args.includes('--no-build')) {
  execFileSync('node', ['build.mjs', '--entry', 'tools/sandbox/atmosphere.js', '--out', 'dist/sandbox-atmosphere.html'], { stdio: 'inherit' });
  execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
}

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

// ------------------------------------------------------------------ sandbox
const sb = await launch({ html: 'dist/sandbox-atmosphere.html', query: '' });
await sb.eval(() => {
  window.__game.paused = true; // tests drive time explicitly
  window.__game.simulate(2);
});

const setup = {
  calm: () => {
    const a = window.__game.atmosphere;
    a.setThreat(0);
    a.setDeath(0);
    a.setCall(0);
    window.__game.bus.emit('leviathan:call:end', {});
    window.__game.simulate(3);
  },
  threat: (v) => {
    window.__game.atmosphere.setThreat(v);
    window.__game.simulate(1.5);
  },
  death: (v) => {
    window.__game.atmosphere.setDeath(v);
    window.__game.simulate(0.1);
  },
  call: () => {
    const g = window.__game;
    g.bus.emit('leviathan:call:start', { duration: 4.6 });
    g.simulate(1.8);
  },
  footfall: () => {
    window.__game.atmosphere.onFootfall(1);
    window.__game.simulate(0.2);
  },
  later: () => window.__game.simulate(40),
};

const shots = [
  ['street', 'street', []],
  ['street_threat06', 'street', [['threat', 0.6]]],
  ['street_threat1', 'street', [['threat', 1]]],
  ['street_death05', 'street', [['death', 0.5]]],
  ['street_death1', 'street', [['death', 1]]],
  ['street_call', 'street', [['call']]],
  ['street_footfall', 'street', [['footfall']]],
  ['street_later', 'street', [['later']]],
  ['crouch', 'crouch', []],
  ['fire', 'fire', []],
  ['lamp', 'lamp', []],
  ['wall', 'wall', []],
  ['back', 'back', []],
  ['sky', 'sky', []],
  ['sky_call', 'sky', [['call']]],
  ['sun', 'sun', []],
  ['sunopen', 'sunopen', []],
  ['title', 'title', []],
  ['up', 'up', []],
  ['overview', 'overview', []],
  ['giant', 'giant', []],
];

for (const [name, view, steps] of shots) {
  if (!want(name)) continue;
  await sb.eval(([v, fns, st]) => {
    const run = (src, arg) => new Function('arg', `(${src})(arg)`)(arg);
    window.__sandbox.setView(v);
    run(fns.calm);
    for (const [k, a] of st) run(fns[k], a);
    window.__game.renderRequested = true;
  }, [view, Object.fromEntries(Object.entries(setup).map(([k, f]) => [k, f.toString()])), steps]);
  await sb.shot(path.join(out, `sandbox-${name}.png`));
  console.log('shot', name);
}

const unit = !args.includes('--no-unit');
if (unit) {
  // --- stealth light level
  const ll = await sb.eval(() => {
    const g = window.__game;
    const a = g.atmosphere;
    const s = window.__sandbox.sources;
    a.setDeath(0);
    g.simulate(0.5);
    const at = (x, z) => +a.lightLevelAt({ x, y: 0, z }).toFixed(3);
    const r = {
      darkStreet: at(0, -240),
      darkBetween: at(0, -46),
      nextToFire: at(-5.0, -16.4),
      nearFire3m: at(-2.5, -17),
      edgeOfFire: at(-5.5, -23),
      underLamp: at(6.5, -36),
      alarmOff: at(3.5, -70),
    };
    s.alarm.enabled = true;
    s.alarm.intensity = 20;
    g.simulate(0.3);
    r.alarmOn = at(3.5, -70);
    s.fireA.enabled = false;
    g.simulate(0.4);
    r.fireDisabled = at(-5.0, -16.4);
    s.fireA.enabled = true;
    s.alarm.enabled = false;
    g.simulate(0.4);
    // flicker range of the broken lamp
    let lo = 1, hi = 0;
    for (let i = 0; i < 300; i++) {
      g.simulate(1 / 30);
      const v = a.lightLevelAt({ x: 6.5, z: -132 });
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    r.brokenLampRange = [+lo.toFixed(3), +hi.toFixed(3)];
    // a flickering fire stays dangerous all the time
    let fmin = 1, fsum = 0;
    for (let i = 0; i < 300; i++) {
      g.simulate(1 / 30);
      const v = a.lightLevelAt({ x: -5.0, z: -16.4 });
      fmin = Math.min(fmin, v);
      fsum += v;
    }
    r.fireOverTime = [+fmin.toFixed(3), +(fsum / 300).toFixed(3)];
    // missing optional fields
    const h = a.registerLightSource({ pos: { x: 500, y: 2, z: 500 } });
    r.defaultsOk = h.enabled === true && typeof h.intensity === 'number';
    r.defaultLevel = at(500, 500);
    // registering the same handle twice is a no-op
    const n0 = a.lights.records.length;
    r.reRegisterSame = a.registerLightSource(h) === h && a.lights.records.length === n0 && at(500, 500) === r.defaultLevel;
    return r;
  });
  console.log('lightLevelAt', JSON.stringify(ll));
  check(ll.darkStreet >= 0.11 && ll.darkStreet <= 0.17, `dark street ~0.15 (${ll.darkStreet})`);
  check(ll.nextToFire >= 0.8, `next to a fire >= 0.8 (${ll.nextToFire})`);
  check(ll.fireOverTime[0] >= 0.78 && ll.fireOverTime[1] >= 0.8, `fire light stays high while flickering (min/mean ${ll.fireOverTime})`);
  check(ll.nearFire3m > ll.edgeOfFire && ll.edgeOfFire < 0.3, `fire falloff smooth (${ll.nearFire3m} -> ${ll.edgeOfFire})`);
  check(ll.underLamp >= 0.6, `under a working lamp >= 0.6 (${ll.underLamp})`);
  check(ll.alarmOff < 0.17 && ll.alarmOn > 0.4, `toggling enabled works (${ll.alarmOff} -> ${ll.alarmOn})`);
  check(ll.fireDisabled < 0.17, `disabled fire gives no light (${ll.fireDisabled})`);
  check(ll.brokenLampRange[1] - ll.brokenLampRange[0] > 0.2, `flicker shows in light level (${ll.brokenLampRange})`);
  check(ll.defaultsOk && ll.defaultLevel > 0.5, `defaults for missing fields (${ll.defaultLevel})`);
  check(ll.reRegisterSame, 're-registering the same handle does not duplicate it');

  // --- every fog-using material type still compiles with the patched fog chunks, including
  // custom ShaderMaterials that did (or did not) merge UniformsLib.fog
  const fogCompat = await sb.eval(() => {
    const T = window.__sandbox.THREE;
    const g = window.__game;
    const vs = [
      '#include <fog_pars_vertex>',
      'void main() {',
      '  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );',
      '  gl_Position = projectionMatrix * mvPosition;',
      '#include <fog_vertex>',
      '}',
    ].join('\n');
    const fs = [
      'uniform vec3 uColor;',
      '#include <fog_pars_fragment>',
      'void main() {',
      '  gl_FragColor = vec4( uColor, 1.0 );',
      '#include <fog_fragment>',
      '}',
    ].join('\n');
    const custom = (uniforms) => new T.ShaderMaterial({ fog: true, uniforms, vertexShader: vs, fragmentShader: fs });
    const plain = {
      fogColor: { value: new T.Color() }, fogDensity: { value: 0.02 }, fogNear: { value: 1 }, fogFar: { value: 100 },
      uColor: { value: new T.Color(0.2, 0.2, 0.2) },
    };
    const mats = [
      custom(T.UniformsUtils.merge([T.UniformsLib.fog, { uColor: { value: new T.Color(0.2, 0.2, 0.2) } }])),
      custom(plain),
      new T.MeshBasicMaterial(), new T.MeshLambertMaterial(), new T.MeshPhongMaterial(),
      new T.MeshStandardMaterial(), new T.MeshPhysicalMaterial({ clearcoat: 0.5 }), new T.MeshToonMaterial(),
    ];
    const group = new T.Group();
    const geo = new T.BoxGeometry(1, 1, 1);
    mats.forEach((m, i) => {
      const mesh = new T.Mesh(geo, m);
      mesh.position.set(-3.5 + i, 1.5, -6);
      group.add(mesh);
    });
    const inst = new T.InstancedMesh(geo, new T.MeshStandardMaterial(), 4);
    for (let i = 0; i < 4; i++) inst.setMatrixAt(i, new T.Matrix4().makeTranslation(i - 2, 3, -8));
    group.add(inst);
    const sprite = new T.Sprite(new T.SpriteMaterial({ color: 0xffffff }));
    sprite.position.set(0, 4, -6);
    group.add(sprite);
    const pts = new T.Points(new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute([0, 2, -5, 1, 2, -5], 3)), new T.PointsMaterial({ size: 0.2 }));
    group.add(pts);
    const line = new T.Line(new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute([0, 0, -4, 0, 3, -4], 3)), new T.LineBasicMaterial());
    group.add(line);
    g.scene.add(group);
    g.debugCamera = { pos: [0, 1.65, 0], target: [0, 1.6, -6] };
    window.__sandbox.render();
    const programs = g.renderer.info.programs.length;
    g.scene.remove(group);
    g.debugCamera = null;
    // the shared uniforms reached the ShaderLib materials and the merged custom material
    const a = mats[0].uniforms.atmoFogParams?.value;
    return { programs, sharedByRef: !!a && a[0] === 1, plainHasNone: !mats[1].uniforms.atmoFogParams };
  });
  console.log('fog', JSON.stringify(fogCompat));
  check(fogCompat.sharedByRef && fogCompat.plainHasNone, 'fog uniforms shared by reference; plain ShaderMaterial falls back');

  // --- quality levels and resizing keep rendering cleanly
  const errBefore = sb.errors.length;
  const scales = [];
  for (const q of [0, 1, 2]) {
    scales.push(await sb.eval((level) => {
      const g = window.__game;
      g.atmosphere.setQuality(level);
      window.__sandbox.render();
      return +(g.atmosphere.post.scenePass.target.width / g.renderer.domElement.width).toFixed(2);
    }, q));
  }
  if (want('street_q0')) {
    await sb.eval(() => {
      window.__game.atmosphere.setQuality(0);
      window.__sandbox.setView('street');
      window.__game.renderRequested = true;
    });
    await sb.shot(path.join(out, 'sandbox-street_q0.png'));
    await sb.eval(() => window.__game.atmosphere.setQuality(2));
  }
  check(scales[0] <= 0.86 && scales[0] >= 0.5 && scales[1] === 1 && scales[2] === 1, `quality 0 renders the post chain at a reduced pixel ratio (${scales})`);
  await sb.page.setViewportSize({ width: 960, height: 600 });
  await sb.page.waitForTimeout(300);
  const resized = await sb.eval(() => {
    const g = window.__game;
    window.__sandbox.render();
    const t = g.atmosphere.post.scenePass.target;
    return { w: t.width, h: t.height, bw: g.renderer.domElement.width };
  });
  await sb.page.setViewportSize({ width: 1280, height: 720 });
  await sb.page.waitForTimeout(300);
  await sb.eval(() => window.__sandbox.render());
  check(sb.errors.length === errBefore && resized.w === resized.bw, `quality switches + resize render cleanly (${resized.w}x${resized.h})`);

  // --- light pool: constant light count, no popping while walking the street
  const pool = await sb.eval(() => {
    const g = window.__game;
    const a = g.atmosphere;
    let maxLights = 0, minLights = 99, pops = 0, reassign = 0;
    // start the walk from a settled pool at its first position (getting there is a camera cut)
    g.debugCamera = { pos: [0, 1.65, 5], target: [0, 1.6, -5] };
    window.__sandbox.placeCamera();
    g.simulate(1);
    const prev = a.lights.slots.map((s) => ({ rec: s.rec, i: s.light.intensity }));
    for (let i = 0; i <= 600; i++) {
      const z = 5 - i * 0.4;
      g.debugCamera = { pos: [0, 1.65, z], target: [0, 1.6, z - 10] };
      window.__sandbox.placeCamera();
      g.simulate(1 / 30);
      let n = 0;
      g.scene.traverse((o) => { if (o.isPointLight) n++; });
      maxLights = Math.max(maxLights, n);
      minLights = Math.min(minLights, n);
      a.lights.slots.forEach((s, k) => {
        if (s.rec !== prev[k].rec) {
          reassign++;
          // a slot may only change hands once its old light has faded to (almost) nothing
        if (prev[k].rec && prev[k].i > 0.05 * Math.max(1, prev[k].rec.src.intensity)) pops++;
        }
        prev[k] = { rec: s.rec, i: s.light.intensity };
      });
    }
    g.debugCamera = null;
    return { maxLights, minLights, pops, reassign };
  });
  console.log('pool', JSON.stringify(pool));
  check(pool.maxLights === pool.minLights && pool.maxLights <= 6, `constant point light count (${pool.maxLights})`);
  check(pool.pops === 0 && pool.reassign > 0, `slots reassigned only when faded out (${pool.reassign} reassignments, ${pool.pops} pops)`);

  // --- a camera cut (respawn, title -> play) snaps the pool: the new place is lit on the next
  // update instead of going dark while old lights fade out and new ones fade in
  const cut = await sb.eval(() => {
    const g = window.__game;
    const a = g.atmosphere;
    const lit = () => a.lights.slots.filter((s) => s.rec && s.light.intensity > 0.3 * s.rec.src.intensity * s.rec.flick).length;
    const near = (z) => a.lights.slots.filter((s) => s.rec && Math.abs(s.rec.src.pos.z - z) < 30).length;
    g.debugCamera = { pos: [0, 1.65, -230], target: [0, 1.6, -260] };
    window.__sandbox.placeCamera();
    g.simulate(1);
    g.debugCamera = { pos: [0, 1.65, -10], target: [0, 1.6, -30] };
    window.__sandbox.placeCamera();
    g.simulate(1 / 30);
    const r = { litAfterCut: lit(), nearAfterCut: near(-10) };
    g.debugCamera = null;
    return r;
  });
  console.log('cut', JSON.stringify(cut));
  check(cut.litAfterCut >= 3 && cut.nearAfterCut >= 2, `camera cut snaps the light pool (${cut.litAfterCut} lit, ${cut.nearAfterCut} near, one frame after)`);

  // --- cost
  const cost = await sb.eval(() => {
    const g = window.__game;
    const a = g.atmosphere;
    const T = (fn, n) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn(i);
      return (performance.now() - t0) / n;
    };
    const updateMs = T(() => a.update(1 / 60), 300);
    const levelUs = T((i) => a.lightLevelAt({ x: (i % 20) - 10, z: -(i % 300) }), 5000) * 1000;
    for (let i = 0; i < 200; i++) {
      a.registerLightSource({ pos: { x: (i % 10) * 9 - 45, y: 2, z: -i * 2 }, color: 0xff8040, intensity: 20, distance: 12, flicker: 0.4, stealthRadius: 5 });
    }
    const updateMs200 = T(() => a.update(1 / 60), 300);
    const levelUs200 = T((i) => a.lightLevelAt({ x: (i % 20) - 10, z: -(i % 300) }), 5000) * 1000;
    window.__sandbox.render();
    const dbg = a.getDebugInfo();
    return { updateMs, levelUs, updateMs200, levelUs200, calls: dbg.calls, sceneCalls: dbg.sceneCalls, triangles: dbg.triangles };
  });
  console.log('cost', JSON.stringify(cost));
  check(cost.updateMs < 0.5, `update() < 0.5 ms (${cost.updateMs.toFixed(3)} ms)`);
  check(cost.levelUs200 < 5, `lightLevelAt with 200+ sources < 5 us (${cost.levelUs200.toFixed(2)} us)`);
}
check(sb.errors.length === 0, `sandbox console clean (${sb.errors.length} errors)`);
if (sb.errors.length) console.log(sb.errors.join('\n'));
await sb.close();

// ------------------------------------------------------------------ game (stub level)
if (!args.includes('--skip-game')) {
  const gm = await launch({ html: 'dist/index.html', query: 'autostart&god' });
  await gm.eval(() => window.__game.simulate(2));
  const gameShots = [
    ['game-player', null, null],
    ['game-overview', [18, 14, 12], [0, 0, -40]],
    ['game-up', [0, 1.7, 0], [10, 30, -40]],
    ['game-title', 'title', null],
  ];
  for (const [name, pos, target] of gameShots) {
    if (!want(name)) continue;
    if (pos === 'title') {
      await gm.eval(() => {
        const g = window.__game;
        g.debugCamera = { pos: g.level.titleCamera.pos, target: g.level.titleCamera.target };
      });
    } else await gm.cam(pos, target);
    await gm.shot(path.join(out, `${name}.png`));
    console.log('shot', name);
  }
  // wait for the leviathan's next call: the sky should swell
  if (want('game-call')) {
    await gm.eval(() => {
      const g = window.__game;
      for (let i = 0; i < 160 && !g.leviathan.calling; i++) g.simulate(0.5);
      g.simulate(1.5);
    });
    await gm.cam([0, 1.7, 0], [6, 12, -40]);
    const call = await gm.eval(() => window.__game.atmosphere.call);
    await gm.shot(path.join(out, 'game-call.png'));
    console.log('shot game-call', call.toFixed(2));
    check(call > 0.5, `game: leviathan call drives the sky (${call.toFixed(2)})`);
  }
  // caught sequence uses setDeath via the game itself
  await gm.cam(null);
  const state = await gm.eval(() => {
    const g = window.__game;
    g.atmosphere.setDeath(0.7);
    return { info: g.atmosphere.getDebugInfo(), state: g.state };
  });
  if (want('game-death')) await gm.shot(path.join(out, 'game-death07.png'));
  await gm.eval(() => window.__game.atmosphere.setDeath(0));
  console.log('game', JSON.stringify(state.info));
  // respawn is a clean cut; the optional brightness setting reaches the grade
  const resp = await gm.eval(() => {
    const g = window.__game;
    const a = g.atmosphere;
    a.setDeath(1);
    a.threat = 0.9;
    g.respawn();
    g.tick(1 / 30);
    g.settings.brightness = 1.4;
    g.tick(1 / 30);
    const gamma = a.post.grade.uniforms.uGamma.value;
    delete g.settings.brightness;
    g.tick(1 / 30);
    return { death: a.death, threat: a.threat, state: g.state, gamma, gammaDefault: a.post.grade.uniforms.uGamma.value };
  });
  check(resp.death === 0 && resp.threat < 0.05 && resp.state === 'playing', `respawn clears death + threat (${JSON.stringify(resp)})`);
  check(Math.abs(resp.gamma - 1 / 1.4) < 1e-6 && resp.gammaDefault === 1, `settings.brightness drives the grade gamma (${resp.gamma.toFixed(3)})`);
  check(gm.errors.length === 0, `game console clean (${gm.errors.length} errors)`);
  if (gm.errors.length) console.log(gm.errors.join('\n'));
  await gm.close();

  // lowest quality boots clean too
  const lo = await launch({ html: 'dist/index.html', query: 'autostart&god&quality=0' });
  await lo.eval(() => window.__game.simulate(1));
  await lo.page.waitForTimeout(500);
  const q = await lo.eval(() => window.__game.atmosphere.getDebugInfo().quality);
  check(q === 0 && lo.errors.length === 0, `?quality=0 renders clean (quality ${q}, ${lo.errors.length} errors)`);
  if (want('game-lowq')) await lo.shot(path.join(out, 'game-lowq.png'));
  await lo.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exitCode = failures.length ? 1 : 0;
