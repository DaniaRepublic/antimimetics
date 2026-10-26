// Audio module checks.
//   node tools/check-audio.mjs [--offline-only] [--game-only] [--no-build]
// 1. Offline: renders every synth, layer and impulse response in an OfflineAudioContext inside a
//    sandbox page; checks for NaNs, clipping (> 0.99), silence and sane durations; dumps WAVs.
// 2. Game: boots the real game headless, calls audio.init(), fires every bus event (also in bursts),
//    simulates, and checks zero errors and that voices / nodes stay bounded and drain back.
//    Also checks silence + no errors before init() and with ?mute.
// Then (if python3 + numpy + PIL exist) renders spectrogram PNGs of the WAVs to dist/shots/audio/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const OUT = 'dist/shots/audio';
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  FAIL ${msg}`);
};

if (!args.includes('--no-build')) {
  execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
  execFileSync('node', ['build.mjs', '--entry', 'tools/sandbox/audio.js', '--out', 'dist/sandbox-audio.html'], { stdio: 'inherit' });
}

function writeWav(file, { channels, sampleRate, b64 }) {
  const f = new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);
  const pcm = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

// ---------------------------------------------------------------------------------------------
async function offline() {
  console.log('\n== offline renders ==');
  const h = await launch({ html: 'dist/sandbox-audio.html', query: '' });
  const cases = [
    ['footfall', { intensity: 1 }, { seconds: 4.5, wav: 'footfall-near', reverb: 'vast', wet: 0.5 }],
    ['footfall', { intensity: 0.15 }, { seconds: 4.5, wav: 'footfall-far', reverb: 'vast', wet: 0.8 }],
    ['leviathanCall', { duration: 4.6, brightness: 1 }, { seconds: 9, wav: 'call', reverb: 'vast', wet: 0.6 }],
    ['leviathanCall', { duration: 4.6, brightness: 1 }, { seconds: 7.5, wav: 'call-dry' }],
    ['legGroan', {}, { seconds: 5, wav: 'leg-groan', reverb: 'vast', wet: 0.4 }],
    ['metalGroan', {}, { seconds: 7, wav: 'metal-groan', reverb: 'street', wet: 0.6 }],
    ['structureCreak', {}, { seconds: 3 }],
    ['distantWail', {}, { seconds: 5.5, wav: 'wail', reverb: 'street', wet: 0.6 }],
    ['questionCreak', {}, { seconds: 2, wav: 'suspicious', reverb: 'street', wet: 0.2 }],
    ['shriek', {}, { seconds: 2.5, wav: 'shriek', reverb: 'street', wet: 0.3 }],
    ['hiss', {}, { seconds: 1.6 }],
    ['exhale', {}, { seconds: 2.5, wav: 'giveup' }],
    ['creatureStep', { chasing: false }, { seconds: 1 }],
    ['creatureStep', { chasing: true }, { seconds: 1 }],
    ['footstep', { mode: 'crouch' }, { seconds: 0.8 }],
    ['footstep', { mode: 'walk' }, { seconds: 0.8 }],
    ['footstep', { mode: 'sprint' }, { seconds: 0.8, wav: 'footstep-sprint' }],
    ['breath', {}, { seconds: 1.4, wav: 'breath' }],
    ['gasp', {}, { seconds: 0.8 }],
    ['whoosh', {}, { seconds: 0.8 }],
    ['emptyClick', {}, { seconds: 0.4 }],
    ['clink', {}, { seconds: 1 }],
    ['shatter', {}, { seconds: 2.2, wav: 'shatter', reverb: 'street', wet: 0.4 }],
    ['chainGrind', {}, { seconds: 1.5, wav: 'chain-grind' }],
    ['gateOpen', {}, { seconds: 12, wav: 'gate-open', reverb: 'street', wet: 0.3 }],
    ['chime', {}, { seconds: 18 }],
    ['swell', {}, { seconds: 6 }],
    ['stinger', {}, { seconds: 2.6, wav: 'stinger' }],
    ['grab', {}, { seconds: 8, wav: 'grab' }],
    ['endingTone', {}, { seconds: 41 }],
  ];
  const names = await h.eval(() => window.SYNTH_NAMES);
  for (const n of names) if (!cases.some((c) => c[0] === n)) fail(`synth ${n} has no offline test case`);
  const rows = [];
  for (const [name, opts, o] of cases) {
    const { wav, ...render } = o;
    const s = await h.eval(([n, op, r]) => window.renderSynth(n, op, r), [name, opts, { ...render, data: !!wav }]);
    const dry = render.reverb ? await h.eval(([n, op, r]) => window.renderSynth(n, op, r), [name, opts, { seconds: render.seconds }]) : s;
    const label = `${name}${Object.keys(opts).length ? ' ' + JSON.stringify(opts) : ''}`;
    if (wav) writeWav(path.join(OUT, `${wav}.wav`), s.data);
    rows.push([label, dry.peak, dry.peakDb, dry.rmsDb, dry.loudDb, dry.audible, dry.reported?.duration?.toFixed?.(2), dry.reported?.nodes, render.reverb ? s.peak : '']);
    if (dry.nan || s.nan) fail(`${label}: ${dry.nan + s.nan} NaN samples`);
    if (dry.peak > 0.99) fail(`${label}: clipping, dry peak ${dry.peak}`);
    if (dry.peak < 0.02) fail(`${label}: nearly silent, peak ${dry.peak}`);
    if (dry.audible > (dry.reported?.duration ?? 0) + 0.2) fail(`${label}: audible ${dry.audible}s beyond reported duration ${dry.reported?.duration}`);
    if (dry.audible < 0.05) fail(`${label}: too short`);
  }
  console.log('synth'.padEnd(46), 'peak   peakdB  rmsdB  loud50ms audible  dur   nodes  wetpeak');
  for (const r of rows) console.log(String(r[0]).padEnd(46), ...r.slice(1).map((v) => String(v).padEnd(6)));

  console.log('\n-- layers --');
  for (const [name, secs, wav] of [['wind', 20, 'wind'], ['drone', 8, 'drone'], ['tinnitus', 3], ['heartbeat', 8, 'heartbeat'], ['chase', 12, 'chase'], ['whisper', 14, 'whisper'], ['alarm', 13, 'alarm']]) {
    const s = await h.eval(([n, o]) => window.renderLayer(n, o), [name, { seconds: secs, data: !!wav }]);
    if (wav) writeWav(path.join(OUT, `${wav}.wav`), s.data);
    console.log(name.padEnd(12), `peak ${s.peak} (${s.peakDb} dB)  rms ${s.rmsDb} dB  loud50ms ${s.loudDb} dB  nodes ${s.reported?.nodes}  build ${s.buildMs} ms`);
    if (s.nan) fail(`layer ${name}: NaN`);
    if (s.peak > 0.99) fail(`layer ${name}: clipping ${s.peak}`);
    if (s.peak < 0.005) fail(`layer ${name}: silent`);
  }

  console.log('\n-- impulse responses --');
  for (const key of ['street', 'vast']) {
    const s = await h.eval(([k]) => window.renderIR(k, { data: true }), [key]);
    writeWav(path.join(OUT, `ir-${key}.wav`), s.data);
    console.log(key.padEnd(8), `len ${s.length}s  T30 ${s.t30}s  EDT(-10dB) ${s.edt10}s  gen ${s.genMs} ms  nan ${s.nan}`);
    if (s.nan) fail(`IR ${key}: NaN`);
    const [lo, hi] = key === 'street' ? [2, 4.5] : [4, 8];
    if (!(s.t30 >= lo && s.t30 <= hi)) fail(`IR ${key}: T30 ${s.t30} outside ${lo}..${hi}`);
  }
  if (h.errors.length) fail(`sandbox errors:\n${h.errors.join('\n')}`);
  await h.close();
}

// ---------------------------------------------------------------------------------------------
async function gameRun() {
  console.log('\n== game run ==');
  // (a) before init and with ?mute: events must be harmless and silent.
  for (const query of ['autostart', 'autostart&mute']) {
    // quality=0: the merged atmosphere at full quality makes SwiftShader frames take seconds,
    // and this test needs the game loop (and so audio.update) to keep running.
    const h = await launch({ html: 'dist/index.html', query: `${query}&quality=0` });
    const r = await h.eval(() => {
      const g = window.__game;
      if (location.search.includes('mute')) g.audio.init();
      const e = g.director.snatchers[0];
      const p = { x: 0, y: 0, z: -10 };
      for (const [t, payload] of [
        ['leviathan:footfall', { pos: p, intensity: 1 }], ['leviathan:call:start', { pos: p, duration: 4.6 }],
        ['enemy:alert', { enemy: e, pos: p }], ['enemy:step', { enemy: e, pos: p, chasing: true }],
        ['player:footstep', { mode: 'sprint', pos: p }], ['bottle:shatter', { pos: p }], ['alarm:start', { id: 'x', pos: p, duration: 3 }],
        ['game:state', { state: 'paused', prev: 'playing' }],
      ]) g.bus.emit(t, payload);
      g.simulate(2);
      return { ctx: !!g.audio.ctx, stats: g.audio.stats() };
    });
    await h.page.waitForTimeout(500);
    console.log(`  ${query}: context=${r.ctx} stats=${JSON.stringify(r.stats)}`);
    if (r.ctx) fail(`${query}: AudioContext exists without init (or despite ?mute)`);
    if (h.errors.length) fail(`${query}: errors\n${h.errors.join('\n')}`);
    await h.close();
  }

  // (a2) title screen: a real click must start audio (gesture path + game.begin()), ?mute must not.
  for (const query of ['', 'mute']) {
    const h = await launch({ html: 'dist/index.html', query: [query, 'quality=0'].filter(Boolean).join('&') });
    await h.page.mouse.click(640, 360);
    await h.page.waitForTimeout(1500);
    const r = await h.eval(() => ({ state: window.__game.state, ctx: window.__game.audio.ctx?.state ?? null, stats: window.__game.audio.stats() }));
    console.log(`  title click${query ? ' (mute)' : ''}: game=${r.state} audio=${r.ctx} voices=${r.stats.voices} nodes=${r.stats.nodes}`);
    if (query === 'mute' ? r.ctx !== null : r.ctx !== 'running') fail(`title click${query ? ' with ?mute' : ''}: audio context ${r.ctx}`);
    if (h.errors.length) fail(`title click errors:\n${h.errors.join('\n')}`);
    await h.close();
  }

  // (b) full run
  const h = await launch({ html: 'dist/index.html', query: 'autostart&quality=0' });
  // This is an audio test: freeze the AI and the leviathan so that, once the real modules are
  // merged, snatchers don't chase / catch the player and the leviathan doesn't call on its own in
  // the middle of an assertion. Threat / chasing are then pinned as own data properties (shadowing
  // a getter if the real Director uses one) and only change when the test sets them.
  await h.eval(() => {
    const g = window.__game;
    g.director.update = () => {};
    if (g.leviathan) g.leviathan.update = () => {};
    window.__pin = (k, v) => Object.defineProperty(g.director, k, { value: v, writable: true, configurable: true, enumerable: true });
    window.__pin('threat', 0);
    window.__pin('chasing', 0);
  });
  const warnings = () => h.logs.filter((l) => l.includes('[audio]'));
  const stats = () => h.eval(() => window.__game.audio.stats());
  const initInfo = await h.eval(() => {
    const g = window.__game;
    const t0 = performance.now();
    g.audio.init();
    const ms = performance.now() - t0;
    g.audio.init(); // idempotent
    return { ms: +ms.toFixed(1), state: g.audio.ctx?.state, rate: g.audio.ctx?.sampleRate, panning: g.audio.panningModel };
  });
  console.log('  init:', JSON.stringify(initInfo));
  if (!initInfo.state) fail('no AudioContext after init()');
  await h.page.waitForTimeout(1000);
  const base = await stats();
  console.log('  baseline:', JSON.stringify(base));

  // Fire every event in the catalogue once, with plausible payloads.
  await h.eval(() => {
    const g = window.__game;
    const e = g.director.snatchers[0];
    const P = (x, z, y = 0) => ({ x, y, z });
    const ev = [
      ['leviathan:footfall', { pos: P(30, -40), intensity: 0.9 }],
      ['leviathan:footfall', { pos: P(-200, -300), intensity: 0.1 }],
      ['enemy:suspicious', { enemy: e, pos: P(0, -12) }],
      ['enemy:alert', { enemy: e, pos: P(0, -12) }],
      ['enemy:lost', { enemy: e }],
      ['enemy:giveup', { enemy: e }],
      ['enemy:step', { enemy: e, pos: P(1, -8), chasing: false }],
      ['enemy:step', { enemy: e, pos: P(1, -8), chasing: true }],
      ['player:footstep', { mode: 'crouch', pos: P(0, 0) }],
      ['player:footstep', { mode: 'walk', pos: P(0, 0) }],
      ['player:footstep', { mode: 'sprint', pos: P(0, 0) }],
      ['player:breath', { pos: P(0, 0) }],
      ['player:exhausted', {}],
      ['player:throw', { pos: P(0, 0, 1.5) }],
      ['player:throw-empty', {}],
      ['player:pickup', { type: 'bottle', count: 1 }],
      ['bottle:shatter', { pos: P(5, -15, 0.1), collider: null }],
      ['alarm:start', { id: 'car1', pos: P(-8, -30), duration: 6 }],
      ['noise', { pos: P(2, -20), radius: 20, loudness: 1, source: 'gate' }],
      ['noise', { pos: P(2, -20), radius: 7, loudness: 0.4, source: 'player' }],
      ['gate:open', { id: 'g1', pos: P(2, -20) }],
      ['game:checkpoint', { checkpoint: g.checkpoint }],
      ['zone:enter', { index: 1, zone: {} }],
      ['level:message', { text: 'x', duration: 2 }],
      ['leviathan:call:start', { pos: P(60, -100, 110), duration: 4.6 }],
    ];
    for (const [t, p] of ev) g.bus.emit(t, p);
  });
  const s1 = await stats();
  console.log('  after one of each:', JSON.stringify(s1));
  if (!s1.calling) fail('call did not register');
  await h.page.waitForTimeout(5000);
  await h.eval(() => window.__game.bus.emit('leviathan:call:end', {}));

  // Burst: hundreds of events in one frame -> voice cap must hold.
  const burst = await h.eval(() => {
    const g = window.__game;
    const e = g.director.snatchers[0];
    const kinds = ['enemy:step', 'player:footstep', 'bottle:shatter', 'leviathan:footfall', 'enemy:alert', 'enemy:suspicious', 'noise', 'player:throw-empty', 'player:breath'];
    let maxVoices = 0;
    for (let i = 0; i < 400; i++) {
      const k = kinds[i % kinds.length];
      const pos = { x: Math.random() * 30 - 15, y: 0, z: -Math.random() * 40 };
      g.bus.emit(k, { enemy: e, pos, chasing: i % 2 === 0, mode: ['walk', 'sprint', 'crouch'][i % 3], intensity: Math.random(), source: 'gate', radius: 20 });
      maxVoices = Math.max(maxVoices, g.audio.voices.filter((v) => !v.releasing).length);
    }
    g.simulate(3);
    return { maxVoices, stats: g.audio.stats() };
  });
  console.log('  burst:', JSON.stringify(burst));
  if (burst.maxVoices > 32) fail(`voice cap exceeded: ${burst.maxVoices}`);
  if (burst.stats.nodes > 1200) fail(`burst created too many nodes: ${burst.stats.nodes}`);

  // Pause / resume, chase layer, threat.
  await h.eval(() => {
    const g = window.__game;
    g.pause();
  });
  await h.page.waitForTimeout(400);
  const paused = await h.eval(() => ({ f: window.__game.audio.pauseFilter.frequency.value, g: window.__game.audio.pauseGain.gain.value }));
  console.log('  paused filter:', JSON.stringify(paused));
  if (!(paused.f < 3000)) fail('pause did not lowpass the mix');
  await h.eval(() => window.__game.resume());
  await h.eval(() => {
    const g = window.__game;
    window.__pin('threat', 0.9);
    window.__pin('chasing', 1);
    // simulate() runs at a fixed step whatever the headless frame rate
    g.simulate(2);
  });
  await h.page.waitForTimeout(500);
  const chase = await stats();
  console.log('  chasing:', JSON.stringify(chase));
  if (!(chase.chase > 0.5)) fail('chase layer did not rise');
  await h.eval(() => {
    window.__pin('threat', 0);
    window.__pin('chasing', 0);
  });

  // Caught -> dead -> respawn.
  await h.eval(() => {
    const g = window.__game;
    g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
  });
  const caught = await h.eval(() => ({ state: window.__game.state, scene: window.__game.audio.scene, grab: window.__game.audio.voices.some((v) => v.kind === 'grab') }));
  console.log('  caught:', JSON.stringify(caught));
  if (caught.state !== 'caught' || caught.scene !== 0 || !caught.grab) fail('caught sequence did not start the grab / cut the scene');
  await h.page.waitForTimeout(3200);
  await h.eval(() => window.__game.respawn());
  await h.page.waitForTimeout(300);
  const resp = await stats();
  console.log('  respawned:', JSON.stringify(resp));
  if (resp.scene !== 1) fail('scene not restored after respawn');

  // Let everything drain, then compare with the baseline.
  await h.page.waitForTimeout(12000);
  // (one engine update after the wait, however slow the headless frames are)
  await h.eval(() => window.__game.audio.update(1 / 60));
  const drained = await stats();
  console.log('  drained:', JSON.stringify(drained));
  if (drained.voices > 6) fail(`voices did not drain: ${drained.voices}`);
  if (drained.nodes > base.nodes + 80) fail(`nodes did not drain: ${drained.nodes} vs baseline ${base.nodes}`);

  // Update cost (no rendering) with whisper slots active near a snatcher.
  const perf = await h.eval(() => {
    const g = window.__game;
    const e = g.director.snatchers[0];
    g.teleport(e.position.x, e.position.z + 4, 0);
    g.render();
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) g.audio.update(1 / 60);
    return { msPerUpdate: +((performance.now() - t0) / 300).toFixed(3), whispering: g.audio.stats().whispering };
  });
  console.log('  update cost:', JSON.stringify(perf));
  if (perf.msPerUpdate > 0.5) fail(`audio.update too slow: ${perf.msPerUpdate} ms`);

  // Robustness / integration edge cases.
  // (1) Vocal sounds come from the snatcher even when `pos` is what it noticed (here: the player).
  const vocal = await h.eval(() => {
    const g = window.__game;
    const e = g.director.snatchers[0];
    g.teleport(e.position.x + 12, e.position.z + 9, 0); // the stimulus (player) is 15 m away
    const head = e.getHeadPos(g.camera.position.clone());
    const p = g.player.position;
    g.bus.emit('enemy:alert', { enemy: e, pos: { x: p.x, y: 0, z: p.z } });
    const v = g.audio.voices.find((x) => x.kind === 'shriek' && !x.releasing);
    return v ? { dx: +(v.chain.pos.x - head.x).toFixed(2), dz: +(v.chain.pos.z - head.z).toFixed(2) } : null;
  });
  console.log('  shriek placed relative to its snatcher:', JSON.stringify(vocal));
  if (!vocal || Math.abs(vocal.dx) > 0.5 || Math.abs(vocal.dz) > 0.5) fail('enemy:alert shriek not placed at the snatcher');

  // (2) An alarm keeps wailing through a pause longer than its duration (the level's alarm is
  // frozen too), and the safety timeout still ends it once play resumes.
  await h.eval(() => {
    const g = window.__game;
    g.bus.emit('alarm:start', { id: 'pause-test', pos: { x: 6, y: 0, z: -10 }, duration: 1 });
    g.pause();
  });
  await h.page.waitForTimeout(4000);
  const alarmPaused = await h.eval(() => window.__game.audio.alarms.has('pause-test'));
  // Advance game time deterministically (headless frame rates vary): 3.5 s > duration + 2 s.
  const alarmAfter = await h.eval(() => {
    const g = window.__game;
    g.resume();
    g.simulate(3.5);
    return g.audio.alarms.has('pause-test');
  });
  console.log(`  alarm through a 4 s pause: kept=${alarmPaused} stopped after resume=${!alarmAfter}`);
  if (!alarmPaused) fail('alarm was cut while the game was paused');
  if (alarmAfter) fail('alarm safety timeout did not fire after resume');

  // (3) A suspended context (frozen clock) must not accumulate voices.
  const susp = await h.eval(async () => {
    const g = window.__game;
    const a = g.audio;
    await a.ctx.suspend();
    const before = a.voices.length;
    const e = g.director.snatchers[0];
    for (let i = 0; i < 200; i++) {
      g.bus.emit('player:pickup', { type: 'bottle', count: 1 });
      g.bus.emit('enemy:lost', { enemy: e });
      g.bus.emit('player:throw', { pos: g.player.position });
      a.update(1 / 60);
    }
    const after = a.voices.length;
    await a.ctx.resume();
    return { before, after };
  });
  console.log('  events while suspended:', JSON.stringify(susp));
  if (susp.after > susp.before) fail(`voices built while the context was suspended: ${susp.before} -> ${susp.after}`);

  // (4) Hidden tab suspends the context; visible again resumes it.
  const vis = await h.eval(async () => {
    const a = window.__game.audio;
    const set = (hidden) => {
      Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
      Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    // state changes are asynchronous (and slow under SwiftShader load): poll for up to 3 s
    const until = async (want) => {
      for (let i = 0; i < 30 && a.ctx.state !== want; i++) await new Promise((r) => setTimeout(r, 100));
      return a.ctx.state;
    };
    set(true);
    const hidden = await until('suspended');
    set(false);
    const visible = await until('running');
    return { hidden, visible };
  });
  console.log('  visibility:', JSON.stringify(vis));
  if (vis.hidden !== 'suspended' || vis.visible !== 'running') fail(`hidden tab handling: ${JSON.stringify(vis)}`);

  // (5) Malformed payloads and a NaN threat must not throw or stall the engine.
  const bad = await h.eval(() => {
    const g = window.__game;
    const N = { x: NaN, y: 0, z: NaN };
    g.bus.emit('leviathan:footfall', { pos: N, intensity: NaN });
    g.bus.emit('leviathan:footfall', {});
    g.bus.emit('enemy:step', { pos: N, chasing: true });
    g.bus.emit('enemy:alert', { pos: N });
    g.bus.emit('bottle:shatter', { pos: N });
    g.bus.emit('gate:open', {});
    g.bus.emit('alarm:start', { id: 'bad', duration: 'x' });
    g.bus.emit('alarm:end', { id: 'bad' });
    window.__pin('threat', NaN);
    g.simulate(1);
    window.__pin('threat', 0);
    g.simulate(0.5);
    return { threat: g.audio.threat, voices: g.audio.voices.length };
  });
  console.log('  malformed payloads:', JSON.stringify(bad));
  if (!Number.isFinite(bad.threat)) fail('NaN threat poisoned the audio engine');

  // Win.
  await h.eval(() => window.__game.win());
  await h.page.waitForTimeout(2500);
  const won = await stats();
  console.log('  won:', JSON.stringify(won));
  if (won.scene !== 0) fail('win did not fade the city');
  // A snatcher reaching the player after the win: the game ignores it, so must the audio.
  const lateCatch = await h.eval(() => {
    const g = window.__game;
    g.bus.emit('player:caught', { enemy: g.director.snatchers[0] });
    return { state: g.state, grab: g.audio.voices.some((v) => v.kind === 'grab' && !v.releasing) };
  });
  console.log('  player:caught after win:', JSON.stringify(lateCatch));
  if (lateCatch.grab) fail('grab played after the game was won');

  if (warnings().length) fail(`audio warnings:\n${warnings().join('\n')}`);
  if (h.errors.length) fail(`page errors:\n${h.errors.join('\n')}`);
  await h.close();
}

// ---------------------------------------------------------------------------------------------
// Mix calibration (--levels): meters the real master output in the running game for each sound in
// isolation (ambience muted) and for the ambience bed alone. Prints loudness (energy average of
// 46 ms windows) and true peak in dBFS.
async function levels() {
  console.log('\n== mix levels (dBFS at the output) ==');
  const h = await launch({ html: 'dist/index.html', query: 'autostart&god&quality=0' });
  await h.eval(() => {
    const g = window.__game;
    g.audio.init();
    // Measure sounds in isolation: no leviathan calls/footfalls, no AI acting on its own.
    if (g.leviathan) g.leviathan.update = () => {};
    g.director.update = () => {};
    window.__pin = (k, v) => Object.defineProperty(g.director, k, { value: v, writable: true, configurable: true, enumerable: true });
    window.__pin('threat', 0);
    window.__pin('chasing', 0);
    g.teleport(0, 0, 0);
    window.__measure = (secs) => new Promise((resolve) => {
      const out = [];
      const id = setInterval(() => out.push(g.audio.meter()), 23);
      setTimeout(() => {
        clearInterval(id);
        const act = out.filter((m) => m.rmsDb > -90);
        const e = act.reduce((s, m) => s + 10 ** (m.rmsDb / 10), 0) / Math.max(1, act.length);
        resolve({ loud: act.length ? +(10 * Math.log10(e)).toFixed(1) : -140, max: Math.max(...out.map((m) => m.rmsDb)), peak: Math.max(...out.map((m) => m.peakDb)), gr: Math.min(...out.map((m) => m.reduction)) });
      }, secs * 1000);
    });
    window.__bed = (on) => {
      const a = g.audio;
      const now = a.ctx.currentTime;
      if (on) return;
      a.drone.setLevel = () => {};
      a.wind.setLevel = () => {};
      a.wind.level.gain.setTargetAtTime(0, now, 0.02);
      a.drone.level.gain.setTargetAtTime(0, now, 0.02);
      a.nextAmbient = a.nextWail = a.nextLegGroan = Infinity;
    };
  });
  await h.page.waitForTimeout(6000); // reverbs + banks warm, ambience faded in
  const bed = await h.eval(() => window.__measure(6));
  console.log('ambience bed'.padEnd(34), JSON.stringify(bed));
  await h.eval(() => window.__bed(false));
  await h.page.waitForTimeout(1500);

  const P = (x, z, y = 0) => ({ x, y, z });
  const scenarios = [
    ['player walk x6', 'player:footstep', { mode: 'walk' }, 6, 0.5],
    ['player sprint x6', 'player:footstep', { mode: 'sprint' }, 6, 0.36],
    ['player crouch x6', 'player:footstep', { mode: 'crouch' }, 6, 0.7],
    ['breath x2', 'player:breath', {}, 2, 1.3],
    ['enemy step 5 m', 'enemy:step', { pos: P(0, -5), chasing: false }, 4, 0.7],
    ['enemy step 5 m chasing', 'enemy:step', { pos: P(0, -5), chasing: true }, 4, 0.4],
    ['suspicious 6 m', 'enemy:suspicious', { pos: P(3, -5, 1.9) }, 1, 0],
    ['alert shriek 10 m', 'enemy:alert', { pos: P(0, -10, 1.9) }, 1, 0],
    ['lost hiss 6 m', 'enemy:lost', { pos: P(0, -6, 1.9) }, 1, 0],
    ['giveup 6 m', 'enemy:giveup', { pos: P(0, -6, 1.9) }, 1, 0],
    ['shatter 10 m', 'bottle:shatter', { pos: P(6, -8) }, 1, 0],
    ['shatter 25 m', 'bottle:shatter', { pos: P(10, -23) }, 1, 0],
    ['footfall near (1.0)', 'leviathan:footfall', { pos: P(20, -20), intensity: 1 }, 1, 0],
    ['footfall mid (0.5)', 'leviathan:footfall', { pos: P(60, -80), intensity: 0.5 }, 1, 0],
    ['footfall far (0.1)', 'leviathan:footfall', { pos: P(200, -300), intensity: 0.1 }, 1, 0],
    ['leviathan call', 'leviathan:call:start', { pos: P(80, -120, 110), duration: 4.6 }, 1, 0],
    ['gate grind 4 m', 'noise', { pos: P(0, -4), source: 'gate', radius: 20 }, 3, 0.8],
    ['gate open 6 m', 'gate:open', { pos: P(0, -6) }, 1, 0],
    ['checkpoint chime', 'game:checkpoint', {}, 1, 0],
    ['throw whoosh', 'player:throw', {}, 1, 0],
    ['pickup clink', 'player:pickup', {}, 1, 0],
  ];
  for (const [label, ev, payload, count, gap] of scenarios) {
    const r = await h.eval(async ([ev, payload, count, gap]) => {
      const g = window.__game;
      // No `enemy` in the payload: snatcher sounds then come from `pos` (with an enemy they
      // follow its head, which a real snatcher model would not move when parked by hand).
      const m = window.__measure(gap * count + (ev.startsWith('leviathan:call') ? 8 : 3));
      for (let i = 0; i < count; i++) {
        g.bus.emit(ev, { ...payload });
        await new Promise((r2) => setTimeout(r2, gap * 1000));
      }
      if (ev === 'leviathan:call:start') setTimeout(() => g.bus.emit('leviathan:call:end', {}), 4600);
      return m;
    }, [ev, payload, count, gap]);
    console.log(label.padEnd(34), JSON.stringify(r));
    await h.page.waitForTimeout(400);
  }
  // Alarm at 15 m, chase layer + heartbeat.
  const alarm = await h.eval(async () => {
    const g = window.__game;
    const m = window.__measure(4);
    g.bus.emit('alarm:start', { id: 'cal', pos: { x: 9, y: 0, z: -12 }, duration: 4 });
    return m;
  });
  console.log('car alarm 15 m'.padEnd(34), JSON.stringify(alarm));
  await h.eval(() => window.__game.bus.emit('alarm:end', { id: 'cal' }));
  await h.page.waitForTimeout(800);
  const chase = await h.eval(async () => {
    const g = window.__game;
    window.__pin('threat', 0.95);
    window.__pin('chasing', 1);
    await new Promise((r) => setTimeout(r, 3000));
    const m = await window.__measure(4);
    window.__pin('threat', 0);
    window.__pin('chasing', 0);
    return m;
  });
  console.log('chase layer + heartbeat'.padEnd(34), JSON.stringify(chase));
  await h.page.waitForTimeout(9000);
  // Whisper: a fake snatcher 3 m in front of the camera.
  const whisper = await h.eval(async () => {
    const g = window.__game;
    const s = g.director.snatchers[0];
    const cam = g.camera.position;
    const saved = { x: s.position.x, z: s.position.z, state: s.state };
    // Park it by hand (the director is frozen); its head is overridden too, since a real model's
    // head anchor would stay where the model was last updated.
    const ownHead = Object.getOwnPropertyDescriptor(s, 'getHeadPos');
    s.position.set(cam.x, 0, cam.z - 3);
    s.getHeadPos = (out) => out.set(cam.x, 1.9, cam.z - 3);
    s.state = 'patrol';
    const m = await window.__measure(8);
    if (ownHead) Object.defineProperty(s, 'getHeadPos', ownHead);
    else delete s.getHeadPos;
    s.position.set(saved.x, 0, saved.z);
    s.state = saved.state;
    return { ...m, whispering: g.audio.stats().whispering };
  });
  console.log('whisper 3 m (patrol)'.padEnd(34), JSON.stringify(whisper));
  if (h.errors.length) fail(`errors during levels:\n${h.errors.join('\n')}`);
  await h.close();
}

if (args.includes('--levels')) await levels();
else {
  if (!args.includes('--game-only')) await offline();
  if (!args.includes('--offline-only')) await gameRun();
}

// Spectrograms (optional tooling).
try {
  execFileSync('python3', ['-I', 'tools/audio-spectrogram.py', OUT], { stdio: 'inherit' });
} catch {
  console.log('(spectrograms skipped: python3 with numpy + PIL not available)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall audio checks passed');
process.exitCode = failures ? 1 : 0;
