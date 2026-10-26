// Whole-game audio session, rendered offline and measured per mix bus.
//
//   node tools/ux-audio-session.mjs [--no-build] [--seconds 660] [--out dist/shots/ux-audio] [--no-soak]
//
// Boots the real game (all real modules, ?quality=0), swaps the engine's AudioContext for an
// OfflineAudioContext and then steps game and audio together: the context is suspended every
// 32 ms of audio, the game ticks once (a scripted bot drives the real input: walk, crouch, sprint,
// pick up, throw, get seen, flee, get caught, alarm, calls, the gate, the exit), and AnalyserNode
// taps on every mix bus (K-weighted for loudness, raw for spectra) are read before rendering
// resumes. Deterministic in time, much faster than real time, and nothing is missed.
//
// Writes to --out:
//   session.wav            the master output (stereo, 16-bit)
//   timeline.png           momentary loudness of every bus over time, with events and phases
//   excerpt-*.wav / .png   key moments cut from the session (+ spectrograms via audio-spectrogram.py)
//   session.json           per-frame series and the event log (for further digging)
// and prints per-phase and per-event loudness tables plus voice/node counts over time.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const OUT = opt('--out', 'dist/shots/ux-audio');
const SECONDS = Number(opt('--seconds', 660));
const SOAK = !args.includes('--no-soak');
const SR = Number(opt("--sr", 48000));
const FRAME = Math.round((SR * 0.032) / 128) * 128; // ~32 ms in whole render quanta
fs.mkdirSync(OUT, { recursive: true });
if (!args.includes('--no-build')) execFileSync('node', ['build.mjs'], { stdio: 'inherit' });

// =============================================================================================
// Page side (serialised into the page: must be self-contained)
// =============================================================================================
async function pageSetup(o) {
  const g = window.__game;
  const SR = o.sr, FRAME = o.frame, DT = FRAME / SR;
  const realTick = g.tick.bind(g);
  const realRender = g.render.bind(g);
  // The page's own requestAnimationFrame loop must not advance the game behind our back.
  g.tick = () => {};
  g.render = () => {};
  g.atmosphere.render = () => {};

  const frames = Math.ceil(o.seconds / DT);
  const ctx = new OfflineAudioContext(2, (frames + 4) * FRAME, SR);
  // The engine refuses to build voices on a context that is not 'running'; an offline context
  // reads 'suspended' between our steps.
  Object.defineProperty(ctx, 'state', { configurable: true, get: () => 'running' });
  const RealAC = window.AudioContext;
  window.AudioContext = function OfflineShim() { return ctx; };
  try {
    g.audio.init();
  } finally {
    window.AudioContext = RealAC;
  }
  const a = g.audio;
  if (a.ctx !== ctx) throw new Error('audio engine did not take the offline context');
  for (let i = 0; i < 400 && !a.warm; i++) await new Promise((r) => setTimeout(r, 25));
  if (o.exp?.includes('noreverb')) {
    a.reverb.buffer = null;
    a.vast.buffer = null;
  }
  // Nothing is rendered, and repainting the HUD under SwiftShader would cost more than the audio.
  document.getElementById('wic-hud').style.display = 'none';
  g.renderer.domElement.style.display = 'none';
  if (o.exp?.includes('nohrtf')) {
    a.panningModel = 'equalpower';
    for (const sl of a.slots) sl.chain.panner.panningModel = 'equalpower';
  }

  // --- taps ------------------------------------------------------------------------------------
  const BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const taps = [];
  const addTap = (name, nodes) => {
    const sum = ctx.createGain();
    for (const n of nodes) n.connect(sum);
    const raw = ctx.createAnalyser();
    raw.fftSize = 4096;
    raw.smoothingTimeConstant = 0;
    const k1 = ctx.createBiquadFilter();
    k1.type = 'highshelf';
    k1.frequency.value = 1500;
    k1.gain.value = 4;
    const k2 = ctx.createBiquadFilter();
    k2.type = 'highpass';
    k2.frequency.value = 38;
    k2.Q.value = 0.5;
    const kw = ctx.createAnalyser();
    kw.fftSize = 2048;
    kw.smoothingTimeConstant = 0;
    sum.connect(raw);
    sum.connect(k1);
    k1.connect(k2);
    k2.connect(kw);
    taps.push({
      name, raw, kw, td: new Float32Array(4096), kd: new Float32Array(2048), fd: new Float32Array(2048),
      ms: new Float32Array(frames), peak: new Float32Array(frames), bands: new Float32Array(Math.ceil(frames / 2) * BANDS.length),
    });
  };
  for (const [name, bus] of Object.entries(a.buses)) addTap(name, [bus.dry]);
  addTap('reverb', [a.revOut, a.vastOut]);
  const finalNode = a.output ?? a.limiter;
  addTap('master', [finalNode]);
  const split = ctx.createChannelSplitter(2);
  finalNode.connect(split);
  const capL = ctx.createAnalyser();
  const capR = ctx.createAnalyser();
  capL.fftSize = capR.fftSize = 2048;
  split.connect(capL, 0);
  split.connect(capR, 1);
  const bufL = new Float32Array(2048);
  const bufR = new Float32Array(2048);
  const wavL = new Int16Array(frames * FRAME);
  const wavR = new Int16Array(frames * FRAME);
  const binHz = SR / 4096;
  const bandBins = BANDS.map((fc) => [Math.max(1, Math.floor((fc / Math.SQRT2) / binHz)), Math.max(1, Math.ceil((fc * Math.SQRT2) / binHz))]);

  // --- per-frame series + events ---------------------------------------------------------------
  const series = {
    state: [], mode: new Int8Array(frames), threat: new Float32Array(frames), chasing: new Int8Array(frames),
    calling: new Int8Array(frames), mask: new Float32Array(frames), voices: new Int16Array(frames), nodes: new Int16Array(frames),
    whispering: new Int8Array(frames), nearest: new Float32Array(frames), x: new Float32Array(frames), z: new Float32Array(frames),
    light: new Float32Array(frames),
  };
  const MODES = ['idle', 'crouch', 'walk', 'sprint'];
  const events = [];
  const marks = [];
  let frame = 0;
  const now = () => frame * DT;
  const log = (type, extra) => events.push({ t: +now().toFixed(3), type, ...extra });
  const types = [
    'leviathan:footfall', 'leviathan:call:start', 'leviathan:call:end', 'enemy:suspicious', 'enemy:alert', 'enemy:lost',
    'enemy:giveup', 'enemy:step', 'player:footstep', 'player:breath', 'player:exhausted', 'player:throw', 'player:pickup',
    'bottle:shatter', 'alarm:start', 'alarm:end', 'gate:open', 'game:checkpoint', 'zone:enter', 'player:caught', 'game:state',
    'game:respawn', 'game:won', 'level:message',
  ];
  for (const type of types) {
    g.bus.on(type, (e = {}) => {
      const x = {};
      if (type === 'leviathan:footfall') x.i = +(e.intensity ?? 0).toFixed(2);
      if (type === 'player:footstep') x.mode = e.mode;
      if (type === 'enemy:step') {
        x.chasing = !!e.chasing;
        const p = g.player.position;
        x.d = e.pos ? +Math.hypot(e.pos.x - p.x, e.pos.z - p.z).toFixed(1) : null;
      }
      if (type === 'game:state') x.state = e.state;
      if (type === 'zone:enter') x.zone = e.index;
      if (e.enemy?.id) x.enemy = e.enemy.id;
      log(type, x);
    });
  }

  // --- bot -------------------------------------------------------------------------------------
  const P = g.player;
  const keys = g.input.keys;
  const pressed = g.input.pressedKeys;
  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'KeyE'];
  const setKeys = (codes) => {
    for (const c of MOVE_KEYS) keys.delete(c);
    for (const c of codes) keys.add(c);
  };
  const press = (code) => pressed.add(code);
  const mark = (label) => marks.push({ t: +now().toFixed(3), label });
  const enemy = (id) => g.director.snatchers.find((s) => s.id === id);
  const face = (x, z, pitch = 0) => {
    const p = P.position;
    P.yaw = Math.atan2(-(x - p.x), -(z - p.z));
    P.pitch = pitch;
  };
  function* wait(s) {
    setKeys([]);
    for (let i = Math.round(s / DT); i > 0; i--) yield;
  }
  function* crouch(on) {
    if (P.crouched !== on) {
      press('KeyC');
      yield;
    }
  }
  function* walkTo(x, z, mode = 'walk', timeout = 45) {
    yield* crouch(mode === 'crouch');
    const path = g.nav.findPath(P.position, { x, z }) || [{ x, z }];
    let i = 0;
    for (let t = 0; t < timeout; t += DT) {
      const p = P.position;
      let wp = path[i];
      if (Math.hypot(wp.x - p.x, wp.z - p.z) < 0.6) {
        i++;
        if (i >= path.length) break;
        wp = path[i];
      }
      face(wp.x, wp.z);
      setKeys(mode === 'sprint' ? ['KeyW', 'ShiftLeft'] : ['KeyW']);
      yield;
    }
    setKeys([]);
  }
  function* walkFor(seconds, mode) {
    yield* crouch(mode === 'crouch');
    setKeys(mode === 'sprint' ? ['KeyW', 'ShiftLeft'] : ['KeyW']);
    for (let i = Math.round(seconds / DT); i > 0; i--) yield;
    setKeys([]);
  }
  const teleport = (x, z, yaw, bottles = P.bottles) => {
    g.teleport(x, z, yaw);
    P.bottles = bottles;
  };
  // Ballistic throw that lands on (x, y, z), as the player's own throw would (whoosh included).
  const throwAt = (x, y, z) => {
    const o = P.getEyePos(new P.position.constructor());
    const dx = x - o.x, dz = z - o.z, dy = y - (o.y - 0.15);
    const dist = Math.hypot(dx, dz);
    const T = Math.max(0.35, dist / 13);
    const vel = new P.position.constructor(dx / T, (dy + 0.5 * 9.8 * T * T) / T, dz / T);
    face(x, z);
    o.y -= 0.15;
    if (P.bottles > 0) P.bottles--;
    g.projectiles.throwBottle(o, vel);
    g.bus.emit('player:throw', { pos: o.clone() });
  };

  function* scenario() {
    mark('title');
    yield* wait(10);
    g.begin();
    mark('intro');
    yield* wait(4);
    g.hud.finishIntro();
    mark('alley idle');
    yield* wait(6);
    mark('alley walk');
    yield* walkTo(0.9, -1.9, 'walk');
    face(0.9, -2.7, -0.6);
    yield;
    press('KeyE');
    yield;
    yield* walkTo(0, -13, 'walk');
    mark('alley crouch');
    yield* walkTo(0, 2, 'crouch');
    mark('alley idle crouched');
    yield* wait(3);
    mark('alley sprint');
    yield* walkTo(0, -17, 'sprint');
    yield* wait(3);

    // Main street: how audible is a patrolling snatcher's whisper, by distance, from behind it?
    teleport(0, -21.5, 0, 1);
    yield* crouch(true);
    yield* wait(2);
    const pat = enemy('z1_patrol');
    for (const d of [26, 20, 16, 12, 8, 5]) {
      mark(`whisper ${d}m`);
      for (let i = Math.round(4 / DT); i > 0; i--) {
        const fx = -Math.sin(pat.yaw), fz = -Math.cos(pat.yaw);
        const x = pat.position.x - fx * d, z = pat.position.z - fz * d;
        if (g.nav.isWalkable(x, z)) {
          P.position.set(x, 0, z);
          P.velocity.set(0, 0, 0);
        }
        face(pat.position.x, pat.position.z);
        yield;
      }
    }
    g.director.reset();
    yield* wait(1);

    // Get seen by the lit sentry, flee (sprint until exhausted), get caught.
    mark('spotted');
    yield* crouch(false);
    const sen = enemy('z1_sentry');
    {
      const fx = -Math.sin(sen.yaw), fz = -Math.cos(sen.yaw);
      let x = sen.position.x + fx * 10, z = sen.position.z + fz * 10;
      const w = g.nav.nearestWalkable(x, z, 20);
      if (w) ({ x, z } = w);
      teleport(x, z, 0);
      face(sen.position.x, sen.position.z);
    }
    g.god = false;
    for (let t = 0; t < 12 && !g.director.chasing; t += DT) yield;
    mark('chase');
    const away = { x: P.position.x + (P.position.x - sen.position.x) * 3, z: P.position.z + (P.position.z - sen.position.z) * 3 };
    const flee = g.nav.nearestWalkable(away.x, away.z, 30) || { x: 0, z: -24 };
    yield* walkTo(flee.x, flee.z, 'sprint', 7);
    for (let t = 0; t < 25 && g.state === 'playing'; t += DT) {
      face(flee.x, flee.z);
      setKeys(['KeyW', 'ShiftLeft']);
      yield;
    }
    setKeys([]);
    mark('caught');
    for (let t = 0; t < 6 && g.state !== 'dead'; t += DT) yield;
    yield* wait(2.5);
    g.respawn();
    g.god = true;
    mark('respawned');
    yield* wait(4);

    // Plaza: set the alarm car off, slip past while it wails.
    teleport(20.7, -139.5, 0.25, 2);
    mark('plaza');
    yield* wait(3);
    const alarm = g.level.alarms.find((al) => al.id === 'plaza_alarm') || g.level.alarms[0];
    yield* walkTo(alarm.pos.x + 8, alarm.pos.z + 12, 'crouch', 30);
    yield* wait(1);
    throwAt(alarm.pos.x, 0.9, alarm.pos.z);
    mark('alarm');
    yield* wait(7);
    mark('plaza sneak');
    yield* walkTo(0, -185, 'crouch', 14);
    yield* wait(6);
    g.director.reset();

    // Boulevard: the leviathan straddles it and calls often. Move only while it calls.
    teleport(6, -220.6, 0.35, 1);
    mark('boulevard');
    for (let t = 0; t < 50; t += DT) {
      if (g.leviathan.calling) {
        if (!P.crouched) press('KeyC');
        setKeys(['KeyW']);
        face(0, -330);
      } else setKeys([]);
      yield;
    }
    setKeys([]);
    g.director.reset();

    // Overpass: cut the chain, open the gate, leave.
    teleport(-8.2, -347, 0, 1);
    mark('overpass');
    yield* walkTo(0, -393.4, 'crouch', 40);
    face(0, -394.6, -0.25);
    mark('gate');
    keys.add('KeyE');
    for (let t = 0; t < 3.6; t += DT) yield;
    keys.delete('KeyE');
    yield* wait(3);
    mark('exit');
    yield* walkTo(0, -433, 'walk', 30);
    mark('ending');
    yield* wait(22);
    if (!o.soak) return;

    // Soak: back into the plaza with snatchers about; wander, throw, sprint, until time runs out.
    g.respawn();
    teleport(20.7, -139.5, 0.25, 3);
    g.setState('playing');
    g.god = true;
    mark('soak');
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    for (;;) {
      const mode = ['walk', 'crouch', 'sprint', 'walk'][Math.floor(Math.random() * 4)];
      const target = g.nav.randomPointNear(0, -170, 30) || { x: 0, z: -170 };
      yield* walkTo(target.x, target.z, mode, rnd(4, 9));
      if (Math.random() < 0.35) {
        if (P.bottles <= 0) P.bottles = 3;
        throwAt(P.position.x + rnd(-15, 15), 0.1, P.position.z + rnd(-15, 15));
      }
      if (Math.random() < 0.08) {
        const al = g.level.alarms[Math.floor(Math.random() * g.level.alarms.length)];
        g.level.onShatter({ pos: al.pos, collider: al.collider });
      }
      yield* wait(rnd(0.5, 3));
    }
  }

  const it = scenario();
  let done = false;
  let error = null;

  function measure(fi) {
    for (const tap of taps) {
      tap.kw.getFloatTimeDomainData(tap.kd);
      let s = 0;
      for (let i = 2048 - FRAME; i < 2048; i++) s += tap.kd[i] * tap.kd[i];
      tap.ms[fi] = s / FRAME;
      tap.raw.getFloatTimeDomainData(tap.td);
      let pk = 0;
      for (let i = 4096 - FRAME; i < 4096; i++) pk = Math.max(pk, Math.abs(tap.td[i]));
      tap.peak[fi] = pk;
      if (fi % 2 === 0) {
        tap.raw.getFloatFrequencyData(tap.fd);
        const base = (fi / 2) * BANDS.length;
        bandBins.forEach(([lo, hi], b) => {
          let e = 0;
          for (let k = lo; k <= hi && k < 2048; k++) e += 10 ** (tap.fd[k] / 10);
          tap.bands[base + b] = e;
        });
      }
    }
    capL.getFloatTimeDomainData(bufL);
    capR.getFloatTimeDomainData(bufR);
    const off = fi * FRAME;
    for (let i = 0; i < FRAME; i++) {
      wavL[off + i] = Math.max(-32768, Math.min(32767, Math.round(bufL[2048 - FRAME + i] * 32767)));
      wavR[off + i] = Math.max(-32768, Math.min(32767, Math.round(bufR[2048 - FRAME + i] * 32767)));
    }
    const st = a.stats();
    series.state.push(g.state);
    series.mode[fi] = MODES.indexOf(P.mode);
    series.threat[fi] = g.director.threat || 0;
    series.chasing[fi] = g.director.chasing || 0;
    series.calling[fi] = a.calling ? 1 : 0;
    series.mask[fi] = g.noiseMask || 0;
    series.voices[fi] = st.voices;
    series.nodes[fi] = st.nodes;
    series.whispering[fi] = st.whispering;
    series.x[fi] = P.position.x;
    series.z[fi] = P.position.z;
    series.light[fi] = P.lightLevel || 0;
    let near = 999;
    for (const s of g.director.snatchers) near = Math.min(near, Math.hypot(s.position.x - P.position.x, s.position.z - P.position.z));
    series.nearest[fi] = near;
  }

  // One game step per FRAME of audio. Called while rendering is suspended at frame·DT: the audio
  // rendered so far is what the previous steps scheduled, so read it before ticking again.
  const prof = { bot: 0, tick: 0, render: 0, measure: 0 };
  const advance = () => {
    const t0 = performance.now();
    it.next();
    const t1 = performance.now();
    realTick(DT);
    const t2 = performance.now();
    realRender();
    const t3 = performance.now();
    prof.bot += t1 - t0;
    prof.tick += t2 - t1;
    prof.render += t3 - t2;
    frame++;
  };
  let lastStep = performance.now();
  const slow = [];
  const step = () => {
    try {
      const tm = performance.now();
      if (tm - lastStep > 150 && slow.length < 400) slow.push({ t: +now().toFixed(2), ms: Math.round(tm - lastStep), voices: a.voices.map((v) => v.name).join(','), slots: a.slots.filter((x) => x.enemy).length });
      lastStep = tm;
      measure(frame - 1);
      prof.measure += performance.now() - tm;
      if (frame >= frames) {
        done = true;
        ctx.resume();
        return;
      }
      advance();
      ctx.suspend(frame * DT).then(step);
      ctx.resume();
    } catch (err) {
      error = String(err?.stack || err);
      done = true;
      ctx.resume();
    }
  };
  advance();
  ctx.suspend(frame * DT).then(step);
  const t0 = performance.now();
  const rendering = ctx.startRendering().then(() => {
    done = true;
  });
  window.__session = {
    progress: () => ({
      t: +now().toFixed(1), of: o.seconds, done, error, wall: +((performance.now() - t0) / 1000).toFixed(1), state: g.state,
      js: Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, Math.round(v / 1000)])), nodes: a.stats().nodes, slow: slow.splice(0),
    }),
    rendering,
    result: () => {
      const n = Math.min(frame - 1, frames);
      const tapOut = taps.map((tp) => ({
        name: tp.name,
        ms: Array.from(tp.ms.subarray(0, n), (v) => +v.toExponential(3)),
        peak: Array.from(tp.peak.subarray(0, n), (v) => +v.toFixed(4)),
        bands: Array.from(tp.bands.subarray(0, Math.ceil(n / 2) * BANDS.length), (v) => +v.toExponential(3)),
      }));
      const s = {};
      for (const [k, v] of Object.entries(series)) s[k] = Array.from(v.slice ? v.slice(0, n) : v).map((x) => (typeof x === 'number' ? +x.toFixed(3) : x));
      return { dt: DT, frames: n, bands: BANDS, taps: tapOut, series: s, events, marks, modes: MODES };
    },
    wavChunk: (ch, start, len) => {
      const src = ch ? wavR : wavL;
      const part = src.subarray(start, Math.min(src.length, start + len));
      const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      let str = '';
      for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(str);
    },
    wavLength: () => Math.min(frame - 1, frames) * FRAME,
  };
  return { frames, taps: taps.map((tp) => tp.name), sr: SR };
}

// =============================================================================================
// Node side
// =============================================================================================
const h = await launch({ html: opt('--html', 'dist/index.html'), query: 'quality=0&god', timeout: 180000 });
h.page.setDefaultTimeout(0);
const setup = await h.eval(pageSetup, { sr: SR, frame: FRAME, seconds: SECONDS, soak: SOAK, exp: opt('--exp', '') });
console.log(`session: ${SECONDS}s, ${setup.frames} steps, taps: ${setup.taps.join(', ')}`);
for (;;) {
  await h.page.waitForTimeout(5000);
  const p = await h.eval(() => window.__session.progress());
  console.log(`  t=${p.t}/${p.of}s  wall ${p.wall}s  state ${p.state}  js(s) ${JSON.stringify(p.js)}  nodes ${p.nodes}`);
  if (args.includes('--slow')) for (const x of p.slow) console.log('     slow', JSON.stringify(x));
  if (p.error) {
    console.log('\nERROR', p.error);
    break;
  }
  if (p.done) break;
}
console.log('');
await h.eval(() => window.__session.rendering);
const R = await h.eval(() => window.__session.result());

// --- WAV ---------------------------------------------------------------------------------------
function writeWav(file, L, Rch, sr) {
  const n = L.length;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(L[i], i * 4);
    pcm.writeInt16LE(Rch[i], i * 4 + 2);
  }
  const hd = Buffer.alloc(44);
  hd.write('RIFF', 0);
  hd.writeUInt32LE(36 + pcm.length, 4);
  hd.write('WAVEfmt ', 8);
  hd.writeUInt32LE(16, 16);
  hd.writeUInt16LE(1, 20);
  hd.writeUInt16LE(2, 22);
  hd.writeUInt32LE(sr, 24);
  hd.writeUInt32LE(sr * 4, 28);
  hd.writeUInt16LE(4, 32);
  hd.writeUInt16LE(16, 34);
  hd.write('data', 36);
  hd.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([hd, pcm]));
}
const total = await h.eval(() => window.__session.wavLength());
const L = new Int16Array(total), Rc = new Int16Array(total);
const CH = SR * 20;
for (let s = 0; s < total; s += CH) {
  for (const [ch, dst] of [[0, L], [1, Rc]]) {
    const b64 = await h.eval(([c, st, len]) => window.__session.wavChunk(c, st, len), [ch, s, CH]);
    const buf = Buffer.from(b64, 'base64');
    const bytes = new Uint8Array(buf); // copy: the pooled Buffer may be unaligned for Int16
    const part = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    dst.set(part.subarray(0, Math.max(0, Math.min(part.length, dst.length - s))), s);
  }
}
writeWav(path.join(OUT, 'session.wav'), L, Rc, SR);

// --- analysis ----------------------------------------------------------------------------------
const dt = R.dt;
const db = (ms) => (ms > 1e-12 ? 10 * Math.log10(ms) : -120);
const tapByName = Object.fromEntries(R.taps.map((t) => [t.name, t]));
const frameAt = (t) => Math.max(0, Math.min(R.frames - 1, Math.round(t / dt)));
// Momentary loudness: 384 ms sliding energy average (K-weighted), per tap.
const MOM = 12;
for (const t of R.taps) {
  const m = new Float64Array(R.frames);
  let acc = 0;
  for (let i = 0; i < R.frames; i++) {
    acc += t.ms[i];
    if (i >= MOM) acc -= t.ms[i - MOM];
    m[i] = acc / Math.min(MOM, i + 1);
  }
  t.mom = m;
}
const segs = R.marks.map((m, i) => ({ label: m.label, t0: m.t, t1: R.marks[i + 1]?.t ?? R.frames * dt }));
const integ = (tap, t0, t1, gate = -70) => {
  let e = 0, n = 0;
  for (let i = frameAt(t0); i < frameAt(t1); i++) {
    if (db(tap.ms[i]) < gate) continue;
    e += tap.ms[i];
    n++;
  }
  return n ? db(e / n) : -120;
};
const maxMom = (tap, t0, t1) => {
  let m = 0;
  for (let i = frameAt(t0); i < frameAt(t1); i++) m = Math.max(m, tap.mom[i]);
  return db(m);
};
const maxPeak = (tap, t0, t1) => {
  let m = 0;
  for (let i = frameAt(t0); i < frameAt(t1); i++) m = Math.max(m, tap.peak[i]);
  return m > 0 ? 20 * Math.log10(m) : -120;
};
const f1 = (v) => (v <= -119 ? '   –  ' : v.toFixed(1).padStart(6));
const names = R.taps.map((t) => t.name);
console.log('\n== per phase: integrated K-weighted loudness (dB, gated -70) / master max momentary / master peak ==');
console.log('phase'.padEnd(22), ...names.map((n) => n.slice(0, 7).padStart(7)), '  M.max  peak');
for (const s of segs) {
  if (s.t1 - s.t0 < 0.5) continue;
  console.log(s.label.padEnd(22), ...names.map((n) => f1(integ(tapByName[n], s.t0, s.t1)).padStart(7)),
    f1(maxMom(tapByName.master, s.t0, s.t1)), f1(maxPeak(tapByName.master, s.t0, s.t1)));
}

// Event-centred: loudest momentary level of a bus in a window after the event, minus the
// ambience bed just before it.
const busOf = (name) => tapByName[name] ? name : 'master';
const EVENT_BUS = {
  'leviathan:footfall': busOf('levi'), 'leviathan:call:start': busOf('call'), 'enemy:alert': busOf('enemy'),
  'enemy:suspicious': busOf('enemy'), 'enemy:lost': busOf('enemy'), 'enemy:giveup': busOf('enemy'), 'enemy:step': busOf('enemy'),
  'player:footstep': busOf('player'), 'bottle:shatter': busOf('props'), 'alarm:start': busOf('props'), 'gate:open': busOf('props'),
  'player:caught': busOf('fx'), 'player:breath': busOf('body'), 'game:checkpoint': busOf('music'), 'zone:enter': busOf('music'),
  'player:pickup': busOf('player'), 'player:throw': busOf('player'),
};
const WIN = { 'leviathan:call:start': 6, 'alarm:start': 4, 'player:caught': 1.6, 'gate:open': 3, 'leviathan:footfall': 2.5 };
const bedTap = tapByName.amb ?? tapByName.world ?? tapByName.master;
// Share of a bus's energy above 200 Hz (bands from 250 Hz up) over a window: what a laptop's
// speakers can reproduce of it.
const NB = R.bands.length;
const midShare = (tap, t0, t1) => {
  let hi = 0, all = 0;
  for (let i = Math.floor(frameAt(t0) / 2); i < Math.floor(frameAt(t1) / 2); i++) {
    for (let b = 0; b < NB; b++) {
      const e = tap.bands[i * NB + b] || 0;
      all += e;
      if (R.bands[b] >= 250) hi += e;
    }
  }
  return all > 0 ? hi / all : 0;
};
console.log('\n== events: bus max momentary after the event, its level over the ambience bed, the part above 200 Hz, master max (dB) ==');
const groups = new Map();
for (const e of R.events) {
  if (!EVENT_BUS[e.type]) continue;
  let key = e.type;
  if (e.type === 'player:footstep') key += ` ${e.mode}`;
  if (e.type === 'leviathan:footfall') key += e.i >= 0.8 ? ' near' : e.i >= 0.3 ? ' mid' : ' far';
  if (e.type === 'enemy:step') key += `${e.chasing ? ' chasing' : ''} ${e.d == null ? '?' : e.d < 6 ? '<6m' : e.d < 12 ? '6-12m' : e.d < 20 ? '12-20m' : '20m+'}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
const evRows = [];
for (const [key, list] of [...groups].sort()) {
  const bus = tapByName[EVENT_BUS[list[0].type]];
  const w = WIN[list[0].type] ?? 0.6;
  const vals = list.map((e) => {
    const lvl = maxMom(bus, e.t, e.t + w);
    const bed = integ(bedTap, Math.max(0, e.t - 2), e.t, -90);
    const mid = lvl + 10 * Math.log10(Math.max(1e-6, midShare(bus, e.t, e.t + w)));
    return { lvl, over: lvl - bed, mid, master: maxMom(tapByName.master, e.t, e.t + w), peak: maxPeak(tapByName.master, e.t, e.t + w) };
  });
  const med = (k) => {
    const s = vals.map((v) => v[k]).sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const row = { key, n: list.length, bus: bus.name, lvl: med('lvl'), over: med('over'), mid: med('mid'), master: med('master'), peak: Math.max(...vals.map((v) => v.peak)) };
  evRows.push(row);
  console.log(key.padEnd(30), String(row.n).padStart(4), row.bus.padEnd(7), f1(row.lvl), ' over bed', f1(row.over), ' >200Hz', f1(row.mid), '  master', f1(row.master), ' peak', f1(row.peak));
}

// The speech band (1-4 kHz) of the snatcher bus against everything else, while the bot stands
// behind a patrolling snatcher at a set distance: can the player hear it coming?
const bandSum = (tap, t0, t1, lo, hi) => {
  let e = 0, n = 0;
  for (let i = Math.floor(frameAt(t0) / 2); i < Math.floor(frameAt(t1) / 2); i++, n++) {
    for (let b = 0; b < NB; b++) if (R.bands[b] >= lo && R.bands[b] <= hi) e += tap.bands[i * NB + b] || 0;
  }
  return n ? e / n : 0;
};
const others = R.taps.filter((t) => !['enemy', 'master', 'reverb'].includes(t.name));
console.log('\n== whisper tell: snatcher bus vs the rest (dB), 0.5-4 kHz and >4 kHz ==');
for (const sg of segs.filter((x) => x.label.startsWith('whisper'))) {
  const en = tapByName.enemy;
  if (!en) break;
  const row = [[500, 4000], [8000, 16000]].map(([lo, hi]) => {
    const a = bandSum(en, sg.t0, sg.t1, lo, hi);
    const b = others.reduce((acc, t) => acc + bandSum(t, sg.t0, sg.t1, lo, hi), 0);
    return a > 0 && b > 0 ? 10 * Math.log10(a / b) : -99;
  });
  console.log(`  ${sg.label.padEnd(14)} enemy ${f1(integ(en, sg.t0, sg.t1))} dB   speech-band SNR ${f1(row[0])}   air SNR ${f1(row[1])}`);
}

// Spectral balance: share of each bus's energy above 200 Hz (what laptop speakers can play).
console.log('\n== spectral balance per bus over the session (octave bands, dB rel. loudest band; >200 Hz share) ==');
console.log('bus'.padEnd(9), ...R.bands.map((b) => (b >= 1000 ? `${b / 1000}k` : String(b)).padStart(6)), '  >200Hz');
for (const t of R.taps) {
  const nb = R.bands.length;
  const sums = new Float64Array(nb);
  for (let i = 0; i < t.bands.length; i++) sums[i % nb] += t.bands[i];
  const mx = Math.max(...sums);
  if (!(mx > 0)) continue;
  const hi = sums.slice(3).reduce((s, v) => s + v, 0) / sums.reduce((s, v) => s + v, 0);
  console.log(t.name.padEnd(9), ...[...sums].map((v) => f1(db(v / mx) / 1).padStart(6)), `  ${(hi * 100).toFixed(0)}%`);
}

// Voices / nodes over time.
const S = R.series;
const mins = Math.ceil((R.frames * dt) / 60);
console.log('\n== voices / nodes per minute (max) ==');
for (let m = 0; m < mins; m++) {
  const a0 = frameAt(m * 60), a1 = frameAt((m + 1) * 60);
  let v = 0, nmax = 0;
  for (let i = a0; i < a1; i++) {
    v = Math.max(v, S.voices[i]);
    nmax = Math.max(nmax, S.nodes[i]);
  }
  console.log(`  min ${String(m).padStart(2)}: voices ${String(v).padStart(3)}  nodes ${String(nmax).padStart(5)}`);
}
const masterPeak = Math.max(...tapByName.master.peak);
console.log(`\nmaster true peak over the session: ${(20 * Math.log10(masterPeak)).toFixed(2)} dBFS`);
let clipped = 0;
for (let i = 0; i < total; i++) if (Math.abs(L[i]) >= 32700 || Math.abs(Rc[i]) >= 32700) clipped++;
console.log(`samples at full scale: ${clipped}`);
// Unweighted RMS of the master over windows (dBFS), as a meter on the output would show it.
const rmsAt = (t0, t1) => {
  const a0 = Math.max(0, Math.round(t0 * SR)), a1 = Math.min(total, Math.round(t1 * SR));
  let e = 0;
  for (let i = a0; i < a1; i++) e += (L[i] / 32768) ** 2 + (Rc[i] / 32768) ** 2;
  return a1 > a0 ? 10 * Math.log10(e / (2 * (a1 - a0)) + 1e-12) : -120;
};
{
  const rows = [];
  const idle = R.marks.find((m) => m.label === 'alley idle');
  if (idle) rows.push(['bed (alley idle, 6 s)', rmsAt(idle.t, idle.t + 6)]);
  const cg = R.events.find((e) => e.type === 'player:caught');
  if (cg) rows.push(['grab (1.35 s)', rmsAt(cg.t, cg.t + 1.35)], ['before the grab (3 s)', rmsAt(cg.t - 3, cg.t)]);
  for (const c of R.events.filter((e) => e.type === 'leviathan:call:start').slice(0, 4)) rows.push([`call @${c.t.toFixed(0)}s (4.6 s)`, rmsAt(c.t + 0.3, c.t + 4.6)], ['  2 s before it', rmsAt(c.t - 2, c.t)]);
  const al = R.events.find((e) => e.type === 'alarm:start');
  if (al) rows.push(['car alarm (4 s)', rmsAt(al.t + 0.5, al.t + 4.5)]);
  console.log('\n== master RMS (unweighted dBFS) ==');
  for (const [k, v] of rows) console.log(`  ${k.padEnd(28)} ${v.toFixed(1)}`);
}

// --- excerpts ------------------------------------------------------------------------------------
const excerpt = (name, t0, t1) => {
  const a0 = Math.max(0, Math.round(t0 * SR)), a1 = Math.min(total, Math.round(t1 * SR));
  if (a1 - a0 < SR * 0.2) return;
  writeWav(path.join(OUT, `excerpt-${name}.wav`), L.subarray(a0, a1), Rc.subarray(a0, a1), SR);
};
const firstEv = (type, pred = () => true) => R.events.find((e) => e.type === type && pred(e));
const markT = (label) => R.marks.find((m) => m.label === label)?.t;
for (const f of fs.readdirSync(OUT)) if (f.startsWith('excerpt-')) fs.unlinkSync(path.join(OUT, f));
const call = firstEv('leviathan:call:start', (e) => e.t > (markT('boulevard') ?? 0)) || firstEv('leviathan:call:start');
if (call) excerpt('call', call.t - 1.5, call.t + 9);
const ff = firstEv('leviathan:footfall', (e) => e.i >= 0.9);
if (ff) excerpt('footfall-near', ff.t - 0.5, ff.t + 4);
const alert = firstEv('enemy:alert');
if (alert) excerpt('spotted-chase', alert.t - 2, alert.t + 14);
const caught = firstEv('player:caught');
if (caught) excerpt('grab', caught.t - 3, caught.t + 7);
const al = firstEv('alarm:start');
if (al) excerpt('alarm', al.t - 2, al.t + 10);
const gate = markT('gate');
if (gate != null) excerpt('gate', gate - 1, gate + 10);
if (markT('whisper 26m') != null) excerpt('whisper-approach', markT('whisper 26m'), markT('spotted') ?? markT('whisper 26m') + 24);
if (markT('alley walk') != null) excerpt('player-steps', markT('alley walk'), (markT('alley sprint') ?? 0) + 4);
if (markT('ending') != null) excerpt('ending', markT('ending') - 2, markT('ending') + 20);
if (markT('title') != null) excerpt('title', 0, 10);

// --- timeline PNG (drawn in the page) ----------------------------------------------------------
const png = await h.eval((data) => {
  const { lanes, frames, dt, events, marks } = data;
  const W = 2400, laneH = 64, top = 70, H = top + lanes.length * laneH + 30;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#0d0809';
  x.fillRect(0, 0, W, H);
  const L0 = 90, span = W - L0 - 10, tx = (t) => L0 + (t / (frames * dt)) * span;
  const COLORS = ['#e8c39e', '#e05a3a', '#c06cff', '#6fb3ff', '#ffd84a', '#8fdf8f', '#ff8fb0', '#ffffff', '#aaaaaa', '#ff5050', '#70ffd0'];
  x.font = '12px monospace';
  // phases
  marks.forEach((m, i) => {
    const X = tx(m.t);
    x.strokeStyle = 'rgba(255,255,255,0.18)';
    x.beginPath();
    x.moveTo(X, 14);
    x.lineTo(X, H - 24);
    x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.75)';
    x.save();
    x.translate(X + 2, 12 + (i % 4) * 13);
    x.fillText(m.label, 0, 0);
    x.restore();
  });
  lanes.forEach((ln, li) => {
    const y0 = top + li * laneH, y1 = y0 + laneH - 6;
    const yv = (d) => y1 - ((Math.max(-60, Math.min(0, d)) + 60) / 60) * (laneH - 10);
    x.fillStyle = 'rgba(255,255,255,0.04)';
    x.fillRect(L0, y0, span, laneH - 6);
    for (const g of [-40, -20]) {
      x.strokeStyle = 'rgba(255,255,255,0.08)';
      x.beginPath();
      x.moveTo(L0, yv(g));
      x.lineTo(L0 + span, yv(g));
      x.stroke();
    }
    x.fillStyle = COLORS[li % COLORS.length];
    x.fillText(ln.name, 6, y0 + 16);
    x.fillStyle = 'rgba(255,255,255,0.4)';
    x.fillText('-20', 60, yv(-20) + 4);
    x.fillText('-40', 60, yv(-40) + 4);
    x.strokeStyle = COLORS[li % COLORS.length];
    x.beginPath();
    for (let px = 0; px < span; px++) {
      const i0 = Math.floor((px / span) * frames), i1 = Math.max(i0 + 1, Math.floor(((px + 1) / span) * frames));
      let m = -120;
      for (let i = i0; i < i1 && i < frames; i++) m = Math.max(m, ln.mom[i]);
      const Y = yv(m);
      if (px === 0) x.moveTo(L0 + px, Y);
      else x.lineTo(L0 + px, Y);
    }
    x.stroke();
  });
  const EVC = {
    'leviathan:footfall': '#e05a3a', 'leviathan:call:start': '#ff2020', 'enemy:alert': '#ffffff', 'player:caught': '#ff00ff',
    'alarm:start': '#ffd84a', 'bottle:shatter': '#6fb3ff', 'gate:open': '#8fdf8f', 'enemy:suspicious': '#ffb070',
  };
  for (const e of events) {
    const col = EVC[e.type];
    if (!col) continue;
    const X = tx(e.t);
    x.strokeStyle = col;
    x.lineWidth = e.type === 'leviathan:call:start' || e.type === 'player:caught' ? 3 : 1;
    x.beginPath();
    x.moveTo(X, top - 10);
    x.lineTo(X, top - (e.type === 'leviathan:footfall' ? 4 + 6 * (e.i || 0) : 0));
    x.stroke();
    x.lineWidth = 1;
  }
  x.fillStyle = 'rgba(255,255,255,0.6)';
  for (let s = 0; s <= frames * dt; s += 30) x.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, tx(s) - 12, H - 8);
  return c.toDataURL('image/png').split(',')[1];
}, {
  lanes: R.taps.map((t) => ({ name: t.name, mom: Array.from(t.mom, (v) => +db(v).toFixed(1)) })),
  frames: R.frames, dt, events: R.events.filter((e) => e.type !== 'enemy:step' && e.type !== 'player:footstep'), marks: R.marks,
});
fs.writeFileSync(path.join(OUT, 'timeline.png'), Buffer.from(png, 'base64'));
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ ...R, taps: R.taps.map(({ mom, ...t }) => t), eventRows: evRows }));
if (h.errors.length) console.log('\nPAGE ERRORS:\n' + h.errors.join('\n'));
const warns = h.logs.filter((l) => l.includes('[audio]'));
if (warns.length) console.log('\nAUDIO WARNINGS:\n' + warns.join('\n'));
await h.close();
try {
  // Spectrograms of the excerpts only (the whole session would be too long for one image).
  const tmp = path.join(OUT, 'excerpts');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp);
  for (const f of fs.readdirSync(OUT)) if (f.startsWith('excerpt-') && f.endsWith('.wav')) fs.copyFileSync(path.join(OUT, f), path.join(tmp, f));
  execFileSync('python3', ['-I', 'tools/audio-spectrogram.py', tmp], { stdio: 'inherit' });
} catch {
  console.log('(spectrograms skipped)');
}
console.log(`\nwrote ${OUT}/session.wav, timeline.png, excerpts/*.png`);
