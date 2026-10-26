// One-shot sound designs. Every synth has the signature
//   synth(b: Builder, opts) -> duration (seconds after b.t until it is fully silent)
// and writes into b.out, so the same code runs in the live engine (b.out = a voice's input, which
// the engine routes through a panner/reverb send) and in an OfflineAudioContext for tests.
// Synths are normalised to peak below ~0.9 at full intensity; the engine sets mix levels.
import { sampleBank, driveCurve, pulseWave, perc, contour, lines } from './builder.js';
import {
  makeFootstep, makeCreatureStep, makeShatter, makeClink, makeWetClick, makeRattle, makeChain,
} from './dsp.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- sample banks (generated once per context) ------------------------------------------------
const banks = {
  step: (ctx) => sampleBank(ctx, 'step', makeFootstep, 8, 3),
  cstep: (ctx) => sampleBank(ctx, 'cstep', makeCreatureStep, 6, 7),
  shatter: (ctx) => sampleBank(ctx, 'shatter', makeShatter, 4, 11),
  clink: (ctx) => sampleBank(ctx, 'clink', makeClink, 3, 13),
  click: (ctx) => sampleBank(ctx, 'click', makeWetClick, 8, 17),
  rattle: (ctx) => sampleBank(ctx, 'rattle', makeRattle, 2, 19),
  chain: (ctx) => sampleBank(ctx, 'chain', makeChain, 3, 23),
};

// Pre-generate every sample bank (call once after creating a context, off the hot path).
export function warmBanks(ctx) {
  for (const make of Object.values(banks)) make(ctx);
}

// The same work split into small jobs, so it can be spread over several idle slices.
export function bankJobs(ctx) {
  return Object.values(banks).map((make) => () => make(ctx));
}

export function clickBuffer(ctx) {
  return pick(banks.click(ctx));
}

// =============================================================================================
// Leviathan
// =============================================================================================

// A footfall of something the size of a tower block: sub sweep 55 -> 22 Hz (saturated so its
// harmonics survive laptop speakers), a lowpassed noise body, and when close a concrete crack and
// the rattle of every loose window in the street. intensity 0..1 = how close it landed.
export function footfall(b, { intensity = 1 } = {}) {
  const { ctx } = b;
  const t = b.t;
  const I = clamp01(intensity);
  const end = t + 3.6;
  const out = b.gain(1);
  const tone = b.filter('lowpass', 420 + 5800 * I * I, 0.5);
  b.chain(out, tone, b.limiter(0.92));

  const sub = b.osc('sine', 55, t, end);
  contour(sub.frequency, [[t, 56], [t + 0.3, 38], [t + 1.9, 22]]);
  const subEnv = b.gain(0);
  perc(subEnv.gain, t, 1, 0.012, 0.8, end);
  const subLvl = b.gain(0.5);
  b.chain(sub, subEnv, b.shaper(driveCurve(ctx, 2.4)), subLvl, out);
  // Its upper harmonics (the sweep overdriven nearly square, then 150-600 Hz of it): small
  // speakers play nothing of the sub itself, but the ear rebuilds a deep boom from these.
  b.chain(subEnv, b.shaper(driveCurve(ctx, 5)), b.filter('highpass', 150, 0.7), b.filter('lowpass', 500, 0.7), b.gain(0.4), out);

  const body = b.noise('brown', t, end);
  const lp = b.filter('lowpass', 300, 1.2);
  contour(lp.frequency, [[t, 340], [t + 0.35, 140], [t + 1.8, 48]]);
  const bodyEnv = b.gain(0);
  perc(bodyEnv.gain, t, 1.0, 0.018, 0.5, end);
  b.chain(body, lp, bodyEnv, out);

  // The thud: the mid-bass body of the impact (100-300 Hz), so that small speakers, which play
  // nothing of the sub, still get hit, and the boom has a "where" even far away.
  const thud = b.noise('pink', t, t + 1.4);
  const tbp = b.filter('bandpass', 200, 1.1);
  contour(tbp.frequency, [[t, 230], [t + 0.5, 120], [t + 1.4, 90]]);
  const thudEnv = b.gain(0);
  perc(thudEnv.gain, t, 2.2 * (0.45 + 0.55 * I), 0.005, 0.16, t + 1.4);
  b.chain(thud, tbp, thudEnv, b.shaper(driveCurve(ctx, 1.8)), out);

  if (I > 0.2) {
    const crack = b.noise('white', t, t + 0.4);
    const env = b.gain(0);
    perc(env.gain, t, 0.7 * ((I - 0.2) / 0.8), 0.002, 0.04, t + 0.4);
    b.chain(crack, b.filter('bandpass', 650, 0.8), env, out);
  }
  if (I > 0.35) {
    const r = b.sample(pick(banks.rattle(ctx)), t + rand(0.05, 0.12), rand(0.85, 1.15));
    b.chain(r, b.filter('highpass', 120), b.gain(0.6 * ((I - 0.35) / 0.65)), out);
  }
  return 3.6;
}

// THE CALL: a vast whale-like moan. Detuned saws on a slowly gliding fundamental (with one voice
// "break" upward), pushed through moving vowel formants; a saturated sub an octave down; a high,
// lagging pair of tones a semitone apart (the beautiful part, which beats against itself); a
// counter-voice gliding the wrong way; breath; and a shudder that creeps in near the end.
export function leviathanCall(b, { duration = 4.6, brightness = 1, variant = Math.random() } = {}) {
  const { ctx } = b;
  const t = b.t;
  const D = Math.max(2.5, duration);
  const end = t + D + 2.2;
  // Every call differs a little: overall pitch, where the voice breaks, the song's key.
  const p = 0.88 + 0.24 * variant;
  const brk = 0.5 + 0.12 * ((variant * 7.31) % 1);
  const key = [1, 1.122, 0.891, 1.189][Math.floor(variant * 4) % 4];
  const at = (f) => t + D * Math.min(0.98, f < 0.5 ? f : f + (brk - 0.54) * (1 - f) * 2.2);

  const out = b.gain(0);
  b.chain(out, b.filter('lowpass', 1400 + 4200 * clamp01(brightness), 0.6), b.gain(0.62), b.limiter(0.92));
  out.gain.setValueAtTime(0, t);
  out.gain.setTargetAtTime(1, t, 0.45);
  out.gain.setTargetAtTime(0.72, at(0.54), 0.05);
  out.gain.setTargetAtTime(1.05, at(0.58), 0.25);
  out.gain.setTargetAtTime(0, t + D - 1.0, 0.5);
  out.gain.setValueAtTime(0, end);

  const f0 = [[t, 44 * p], [at(0.3), 61 * p], [at(0.52), 64 * p], [at(0.57), 86 * p], [at(0.64), 79 * p], [t + D, 39 * p], [end, 33 * p]];

  // shudder VCA
  const shudder = b.gain(1);
  const lfo = b.osc('sine', 7.3, t, end);
  const depth = b.gain(0);
  lines(depth.gain, [[t, 0], [at(0.6), 0], [at(0.85), 0.3], [t + D, 0.22]]);
  b.chain(lfo, depth, shudder.gain);
  shudder.connect(out);

  // body
  const src = b.gain(1);
  for (const [ratio, det, lvl] of [[1, -11, 0.5], [1, 4, 0.5], [1, 15, 0.45], [1.5, 27, 0.22], [2.003, -6, 0.18]]) {
    const o = b.osc('sawtooth', 50, t, end, det);
    contour(o.frequency, f0, ratio);
    b.chain(o, b.gain(lvl), src);
  }
  const formants = [
    { pts: [[t, 230], [at(0.3), 400], [at(0.57), 560], [at(0.8), 380], [end, 240]], q: 6, g: 1.0 },
    { pts: [[t, 560], [at(0.3), 820], [at(0.57), 1150], [at(0.8), 760], [end, 520]], q: 8, g: 0.75 },
    { pts: [[t, 1500], [at(0.57), 2300], [end, 1400]], q: 10, g: 0.4 },
  ];
  for (const fm of formants) {
    const bp = b.filter('bandpass', 400, fm.q);
    contour(bp.frequency, fm.pts);
    b.chain(src, bp, b.gain(fm.g * 3), shudder);
  }
  b.chain(src, b.filter('lowpass', 170, 0.9), b.gain(0.16), shudder);

  // sub, an octave down
  const sub = b.osc('sine', 22, t, end);
  contour(sub.frequency, f0, 0.5);
  const subG = b.gain(0);
  lines(subG.gain, [[t, 0], [at(0.25), 0.3], [at(0.75), 0.34], [t + D + 0.4, 0]]);
  b.chain(sub, subG, b.shaper(driveCurve(ctx, 1.6)), out);

  // song: a high, pure, whale-like line with its own wide glides (up an octave and back), doubled
  // a semitone apart so it beats against itself, vibrato deepening as it goes
  const song = b.gain(0);
  lines(song.gain, [[t, 0], [at(0.18), 0], [at(0.45), 0.2], [at(0.62), 0.24], [at(0.85), 0.12], [t + D, 0]]);
  const vib = b.osc('sine', 4.4, t, end);
  const vibDepth = b.gain(0);
  lines(vibDepth.gain, [[t, 0], [at(0.4), 8], [t + D, 30]]);
  vib.connect(vibDepth);
  const songPts = [[at(0.15), 262], [at(0.42), 392], [at(0.58), 523], [at(0.66), 494], [at(0.85), 349], [t + D, 294], [end, 262]];
  for (const [ratio, det] of [[key, 0], [key * 1.0595, 4]]) {
    const o = b.osc('triangle', 262 * ratio, t, end, det);
    contour(o.frequency, songPts, ratio);
    vibDepth.connect(o.detune);
    b.chain(o, b.gain(0.5), song);
  }
  b.chain(song, b.filter('lowpass', 1800, 0.7), out);

  // counter-voice
  const cv = b.osc('triangle', 330, t, end);
  contour(cv.frequency, [[t, 330], [at(0.5), 226], [at(0.75), 262], [end, 300]]);
  const cvG = b.gain(0);
  lines(cvG.gain, [[t, 0], [at(0.35), 0.05], [at(0.8), 0.07], [t + D, 0]]);
  b.chain(cv, cvG, out);

  // breath
  const air = b.noise('pink', t, end);
  const abp = b.filter('bandpass', 500, 1.6);
  contour(abp.frequency, formants[0].pts, 1.7);
  const ag = b.gain(0);
  lines(ag.gain, [[t, 0], [at(0.4), 0.22], [t + D, 0.06], [end, 0]]);
  b.chain(air, abp, ag, shudder);
  return D + 2.2;
}

// Leg joints straining under the weight: a very slow creak through low resonances plus a sub groan.
export function legGroan(b) {
  const { ctx } = b;
  const t = b.t;
  const D = rand(2.6, 4.2);
  const end = t + D + 0.2;
  const out = b.gain(0);
  out.connect(b.out);
  lines(out.gain, [[t, 0], [t + D * 0.35, 1], [t + D * 0.7, 0.8], [t + D, 0]]);

  const fry = b.osc(pulseWave(ctx), 6, t, end);
  contour(fry.frequency, [[t, rand(3, 5)], [t + D * 0.3, rand(9, 14)], [t + D * 0.6, rand(5, 8)], [t + D, rand(10, 16)]]);
  const k = rand(0.85, 1.2);
  for (const [f, q, g] of [[88, 14, 1], [161, 18, 0.7], [307, 20, 0.45], [580, 16, 0.2]]) {
    const bp = b.filter('bandpass', f * k, q);
    contour(bp.frequency, [[t, f * k], [t + D, f * k * rand(0.94, 1.06)]]);
    b.chain(fry, bp, b.gain(g * 2.2), out);
  }
  const groan = b.osc('sawtooth', 36, t, end);
  contour(groan.frequency, [[t, 34 * k], [t + D, 29 * k]]);
  b.chain(groan, b.filter('lowpass', 140, 3), b.gain(0.25), out);
  const wet = b.noise('brown', t, end);
  b.chain(wet, b.filter('bandpass', 380, 3), b.gain(0.35), out);
  return D + 0.25;
}

// =============================================================================================
// Ambient city
// =============================================================================================

// Steel under stress far away: a stick-slip pulse train ringing a bank of inharmonic, high-Q
// resonances whose pitches bend as the load shifts.
export function metalGroan(b) {
  const { ctx } = b;
  const t = b.t;
  const D = rand(2.4, 5);
  const end = t + D + 1.2;
  const out = b.gain(0);
  out.connect(b.out);
  lines(out.gain, [[t, 0], [t + D * rand(0.3, 0.6), 1], [t + D, 0.6], [end, 0]]);

  const fry = b.osc(pulseWave(ctx), 10, t, end);
  contour(fry.frequency, [[t, rand(6, 12)], [t + D * 0.3, rand(10, 26)], [t + D * 0.7, rand(5, 14)], [end, rand(12, 30)]]);
  const base = rand(130, 300);
  const bend = rand(0.93, 1.07);
  const ratios = [1, 1.47, 2.09, 2.8, 3.62, 4.7];
  ratios.forEach((r, i) => {
    const bp = b.filter('bandpass', base * r, 28 + i * 6);
    contour(bp.frequency, [[t, base * r], [end, base * r * bend]]);
    b.chain(fry, bp, b.gain((3.2 / (i + 1)) * rand(0.6, 1.2)), out);
  });
  // a little grinding noise under it
  const grit = b.noise('pink', t, end);
  b.chain(grit, b.filter('bandpass', base * 2.5, 4), b.gain(0.08), out);
  return D + 1.2;
}

// A long structural creak (wood, roofing, a sign swinging on one bolt).
export function structureCreak(b) {
  const { ctx } = b;
  const t = b.t;
  const D = rand(0.9, 2.2);
  const end = t + D + 0.1;
  const out = b.gain(0);
  out.connect(b.out);
  lines(out.gain, [[t, 0], [t + 0.15, 0.9], [t + D * 0.7, 1], [t + D, 0]]);
  const fry = b.osc(pulseWave(ctx), 30, t, end);
  contour(fry.frequency, [[t, rand(18, 30)], [t + D * 0.5, rand(40, 75)], [t + D, rand(20, 40)]]);
  const k = rand(0.8, 1.3);
  for (const [f, q, g] of [[620, 9, 1], [1450, 11, 0.6], [2900, 12, 0.3]]) {
    b.chain(fry, b.filter('bandpass', f * k, q), b.gain(g * 1.8), out);
  }
  return D + 0.1;
}

// A far-off human-ish wail: a voice with vibrato through vowel formants, rising then sinking.
export function distantWail(b) {
  const t = b.t;
  const D = rand(2.8, 4.2);
  const end = t + D + 0.3;
  const out = b.gain(0);
  out.connect(b.out);
  lines(out.gain, [[t, 0], [t + 0.5, 0.8], [t + D * 0.6, 1], [t + D, 0], [end, 0]]);

  const p = rand(0.85, 1.25);
  const v = b.osc('sawtooth', 300 * p, t, end);
  contour(v.frequency, [[t, 330 * p], [t + D * 0.25, 410 * p], [t + D * 0.5, 395 * p], [t + D, 210 * p]]);
  const vib = b.osc('sine', rand(4.8, 6), t, end);
  const vd = b.gain(0);
  lines(vd.gain, [[t, 10], [t + D, 45]]);
  b.chain(vib, vd, v.detune);
  for (const [pts, q, g] of [
    [[[t, 760], [t + D * 0.5, 700], [t + D, 470]], 7, 1],
    [[[t, 1150], [t + D * 0.5, 1080], [t + D, 820]], 9, 0.6],
    [[[t, 2600], [t + D, 2400]], 10, 0.25],
  ]) {
    const bp = b.filter('bandpass', 700, q);
    contour(bp.frequency, pts);
    b.chain(v, bp, b.gain(g * 1.6), out);
  }
  const breath = b.noise('pink', t, end);
  b.chain(breath, b.filter('bandpass', 1200, 1.5), b.gain(0.08), out);
  return D + 0.3;
}

// =============================================================================================
// Snatchers
// =============================================================================================

// Questioning click-creak: a few wet clicks speeding up, then a throat creak rising like "...hn?"
export function questionCreak(b) {
  const { ctx } = b;
  const t = b.t;
  const out = b.gain(1);
  out.connect(b.out);
  for (const k of [0, 0.17, 0.29, 0.37]) {
    b.chain(b.sample(clickBuffer(ctx), t + k + rand(-0.01, 0.01), rand(0.85, 1.15)), b.gain(0.3), out);
  }
  const c0 = t + 0.45;
  const cEnd = c0 + 0.75;
  const fry = b.osc(pulseWave(ctx), 16, c0, cEnd + 0.05);
  contour(fry.frequency, [[c0, 15], [c0 + 0.35, 32], [c0 + 0.6, 68], [cEnd, 128]]);
  const env = b.gain(0);
  env.gain.setValueAtTime(0, c0);
  env.gain.linearRampToValueAtTime(1, c0 + 0.08);
  env.gain.setTargetAtTime(0.7, c0 + 0.3, 0.2);
  env.gain.setTargetAtTime(0, cEnd - 0.09, 0.03);
  env.gain.setValueAtTime(0, cEnd + 0.05);
  const f1 = b.filter('bandpass', 600, 4);
  contour(f1.frequency, [[c0, 480], [cEnd, 820]]);
  const f2 = b.filter('bandpass', 1600, 6);
  contour(f2.frequency, [[c0, 1350], [cEnd, 2150]]);
  b.chain(fry, f1, b.gain(1.2), env);
  b.chain(fry, f2, b.gain(0.8), env);
  env.connect(out);
  return 1.35;
}

// The shriek when one of them sees you: dissonant saws tearing upward through a distorted throat,
// with a scream of noise on top and a growl underneath.
export function shriek(b, { pitch = 1, length = 1.5 } = {}) {
  const { ctx } = b;
  const t = b.t;
  const D = length;
  const end = t + D + 0.1;
  const out = b.gain(0);
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(1, t + 0.035);
  out.gain.setTargetAtTime(0.72, t + 0.22, 0.3);
  out.gain.setTargetAtTime(0, t + D - 0.42, 0.11);
  out.gain.setValueAtTime(0, end);
  out.connect(b.limiter(0.92));

  const voice = b.gain(0.9);
  const jitter = b.osc('square', rand(10, 15), t, end);
  const jd = b.gain(40);
  jitter.connect(jd);
  for (const [f, lvl] of [[390, 0.4], [413, 0.38], [584, 0.3], [97, 0.32]]) {
    const o = b.osc('sawtooth', f, t, end);
    contour(o.frequency, [[t, f * 0.55], [t + 0.3, f * 1.5], [t + D * 0.6, f * 1.62], [t + D, f * 1.05]], pitch);
    jd.connect(o.detune);
    b.chain(o, b.gain(lvl), voice);
  }
  const drive = b.shaper(driveCurve(ctx, 5), '4x');
  voice.connect(drive);
  const mix = b.gain(1);
  b.chain(drive, b.filter('bandpass', 1300 * pitch, 2.5), b.gain(0.9), mix);
  b.chain(drive, b.filter('bandpass', 2900 * pitch, 3), b.gain(0.7), mix);
  b.chain(drive, b.filter('lowpass', 500, 1), b.gain(0.25), mix);
  b.chain(mix, b.filter('highpass', 180), out);

  const n = b.noise('white', t, end);
  const nbp = b.filter('bandpass', 3500, 1.3);
  contour(nbp.frequency, [[t, 2200], [t + 0.3, 4800], [t + D, 3000]], pitch);
  b.chain(n, nbp, b.gain(0.4), out);
  return D + 0.15;
}

// Lost sight of you: a long hiss through the teeth, with a throat catch at the start.
export function hiss(b) {
  const { ctx } = b;
  const t = b.t;
  const D = 1.1;
  const env = b.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.9, t + 0.09);
  env.gain.setTargetAtTime(0.6, t + 0.15, 0.2);
  env.gain.setTargetAtTime(0, t + 0.65, 0.12);
  env.gain.setValueAtTime(0, t + D);
  env.connect(b.out);
  const trem = b.gain(0.8);
  const am = b.osc('sine', rand(18, 26), t, t + D);
  b.chain(am, b.gain(0.2), trem.gain);
  const n = b.noise('white', t, t + D);
  const bp = b.filter('bandpass', 5000, 0.9);
  contour(bp.frequency, [[t, 3800], [t + 0.25, 6000], [t + D, 4200]]);
  b.chain(n, bp, b.filter('highpass', 2200), trem, env);
  const fry = b.osc(pulseWave(ctx), 28, t, t + 0.2);
  const fg = b.gain(0);
  perc(fg.gain, t, 0.6, 0.01, 0.05, t + 0.2);
  b.chain(fry, b.filter('bandpass', 900, 3), fg, b.out);
  return D;
}

// Gave up: a low, disappointed exhale with a creaky voiced tail.
export function exhale(b) {
  const { ctx } = b;
  const t = b.t;
  const D = 2.0;
  const env = b.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(1, t + 0.18);
  env.gain.setTargetAtTime(0, t + 0.35, 0.42);
  env.gain.setValueAtTime(0, t + D);
  env.connect(b.out);
  const n = b.noise('pink', t, t + D);
  const f1 = b.filter('bandpass', 520, 3);
  contour(f1.frequency, [[t, 560], [t + D, 360]]);
  const f2 = b.filter('bandpass', 1150, 5);
  contour(f2.frequency, [[t, 1200], [t + D, 820]]);
  b.chain(n, f1, b.gain(2.2), env);
  b.chain(n, f2, b.gain(1.4), env);

  const v = b.osc('sawtooth', 92, t, t + D);
  contour(v.frequency, [[t, 94], [t + D, 62]]);
  const vg = b.gain(0);
  lines(vg.gain, [[t, 0], [t + 0.25, 0.22], [t + 1.1, 0.12], [t + D, 0]]);
  b.chain(v, b.filter('bandpass', 480, 3), b.filter('lowpass', 900), vg, b.out);
  const fry = b.osc(pulseWave(ctx), 20, t + 0.8, t + D);
  contour(fry.frequency, [[t + 0.8, 24], [t + D, 11]]);
  const fg = b.gain(0);
  lines(fg.gain, [[t + 0.8, 0], [t + 1.0, 0.35], [t + D, 0]]);
  b.chain(fry, b.filter('bandpass', 520, 4), fg, b.out);
  return D;
}

// Soft cloth-and-foot step; heavier, brighter and faster when chasing.
export function creatureStep(b, { chasing = false } = {}) {
  const s = b.sample(pick(banks.cstep(b.ctx)), b.t, (chasing ? 0.9 : 1) * rand(0.94, 1.06));
  b.chain(s, b.filter('lowpass', chasing ? 9000 : 4200), b.gain(chasing ? 1 : 0.6), b.out);
  return 0.7;
}

// =============================================================================================
// Player
// =============================================================================================

const STEP_MODES = {
  crouch: { gain: 0.12, lp: 1500, rate: 1.1 },
  walk: { gain: 0.5, lp: 5200, rate: 1 },
  sprint: { gain: 0.95, lp: 12000, rate: 0.9 },
};

export function footstep(b, { mode = 'walk' } = {}) {
  const cfg = STEP_MODES[mode] ?? STEP_MODES.walk;
  // Sprint: the heel thump can land on the sample's peak (up to ~1.1), so it gets a safety limiter.
  const dest = mode === 'sprint' ? b.limiter(0.92) : b.out;
  const s = b.sample(pick(banks.step(b.ctx)), b.t, cfg.rate * rand(0.93, 1.07));
  b.chain(s, b.filter('lowpass', cfg.lp * rand(0.8, 1.2), 0.6), b.gain(cfg.gain), dest);
  if (mode === 'sprint') {
    const o = b.osc('sine', 70, b.t, b.t + 0.25);
    contour(o.frequency, [[b.t, 72], [b.t + 0.12, 42]]);
    const g = b.gain(0);
    perc(g.gain, b.t, 0.3, 0.004, 0.04, b.t + 0.25);
    b.chain(o, g, dest);
  }
  return 0.5;
}

// Exhausted panting: a voiced-ish "hah" exhale, then a higher, rougher inhale.
export function breath(b, { strength = 1 } = {}) {
  const t = b.t;
  const ex = b.noise('pink', t, t + 0.55);
  const exEnv = b.gain(0);
  perc(exEnv.gain, t, 1, 0.04, 0.12, t + 0.55);
  const exMix = b.gain(strength);
  b.chain(ex, b.filter('bandpass', 760, 1.5), b.gain(2.2), exEnv);
  b.chain(ex, b.filter('bandpass', 1300, 2.5), b.gain(1.5), exEnv);
  b.chain(exEnv, b.filter('highpass', 280), exMix, b.out);

  const t2 = t + rand(0.5, 0.6);
  const inh = b.noise('white', t2, t2 + 0.5);
  const inEnv = b.gain(0);
  inEnv.gain.setValueAtTime(0, t2);
  inEnv.gain.linearRampToValueAtTime(0.55, t2 + 0.12);
  inEnv.gain.setTargetAtTime(0, t2 + 0.14, 0.07);
  inEnv.gain.setValueAtTime(0, t2 + 0.5);
  b.chain(inh, b.filter('bandpass', 1700, 2), b.gain(0.9), inEnv);
  b.chain(inh, b.filter('bandpass', 2800, 5), b.gain(0.6), inEnv);
  b.chain(inEnv, b.gain(strength), b.out);
  return t2 + 0.5 - t;
}

// Sharp gasp when stamina runs out.
export function gasp(b) {
  const t = b.t;
  const n = b.noise('white', t, t + 0.45);
  const env = b.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.9, t + 0.06);
  env.gain.setTargetAtTime(0, t + 0.12, 0.08);
  env.gain.setValueAtTime(0, t + 0.45);
  b.chain(n, b.filter('bandpass', 1500, 2.5), b.gain(1.2), env);
  b.chain(n, b.filter('bandpass', 2600, 4), b.gain(0.8), env);
  env.connect(b.out);
  return 0.45;
}

// A bottle leaving the hand: bandpassed noise sweeping up and back down, plus a sleeve swish.
export function whoosh(b) {
  const t = b.t;
  const n = b.noise('white', t, t + 0.45);
  const bp = b.filter('bandpass', 400, 1.6);
  contour(bp.frequency, [[t, 320], [t + 0.12, 1900], [t + 0.38, 520]]);
  const env = b.gain(0);
  lines(env.gain, [[t, 0], [t + 0.1, 0.9], [t + 0.38, 0], [t + 0.45, 0]]);
  b.chain(n, bp, env, b.out);
  const sw = b.noise('pink', t, t + 0.25);
  const sg = b.gain(0);
  perc(sg.gain, t, 0.35, 0.02, 0.05, t + 0.25);
  b.chain(sw, b.filter('bandpass', 3200, 0.8), sg, b.out);
  return 0.45;
}

// Patting an empty pocket.
export function emptyClick(b) {
  const t = b.t;
  const n = b.noise('white', t, t + 0.12);
  const g = b.gain(0);
  perc(g.gain, t, 0.8, 0.001, 0.012, t + 0.12);
  b.chain(n, b.filter('lowpass', 900, 0.8), g, b.out);
  const n2 = b.noise('white', t + 0.035, t + 0.12);
  const g2 = b.gain(0);
  perc(g2.gain, t + 0.035, 0.25, 0.001, 0.006, t + 0.12);
  b.chain(n2, b.filter('bandpass', 2600, 2), g2, b.out);
  return 0.15;
}

export function clink(b) {
  b.chain(b.sample(pick(banks.clink(b.ctx)), b.t, rand(0.95, 1.05)), b.gain(0.9), b.out);
  return 0.75;
}

export function shatter(b) {
  b.chain(b.sample(pick(banks.shatter(b.ctx)), b.t, rand(0.9, 1.1)), b.gain(1), b.out);
  return 1.7;
}

// =============================================================================================
// Props
// =============================================================================================

// Bolt cutters biting into a chain: a rising metal squeal, a stick-slip grind and the chain rattling.
export function chainGrind(b) {
  const { ctx } = b;
  const t = b.t;
  const D = rand(0.7, 1.0);
  const lim = b.limiter(0.92); // squeal + grind + chain sample can sum past 1 on some draws
  const out = b.gain(0);
  lines(out.gain, [[t, 0], [t + 0.08, 1], [t + D * 0.7, 0.9], [t + D, 0]]);
  out.connect(lim);
  const sq = b.osc('sawtooth', 1800, t, t + D);
  contour(sq.frequency, [[t, rand(1500, 1900)], [t + D, rand(2400, 3000)]]);
  const sqMix = b.gain(1);
  b.chain(sq, b.filter('bandpass', 2400, 12), b.gain(1.2), sqMix);
  b.chain(sq, b.filter('bandpass', 3700, 15), b.gain(0.8), sqMix);
  b.chain(sqMix, b.gain(0.5), out);
  const grind = b.osc(pulseWave(ctx), 40, t, t + D);
  contour(grind.frequency, [[t, rand(25, 35)], [t + D, rand(45, 70)]]);
  b.chain(grind, b.filter('bandpass', 1500, 6), b.gain(1.3), out);
  b.chain(grind, b.filter('bandpass', 3100, 9), b.gain(0.9), out);
  b.chain(b.sample(pick(banks.chain(ctx)), t + rand(0, 0.15), rand(0.9, 1.1)), b.gain(0.55), lim);
  return Math.max(D, 1.05);
}

// Heavy gate swinging open on rusted hinges, then clanging against its stop.
export function gateOpen(b) {
  const { ctx } = b;
  const t = b.t;
  const C = 2.4; // creak length
  const lim = b.limiter(0.92);
  const creak = b.gain(0);
  lines(creak.gain, [[t, 0], [t + 0.25, 0.9], [t + C - 0.3, 0.8], [t + C, 0]]);
  creak.connect(lim);
  const fry = b.osc(pulseWave(ctx), 10, t, t + C);
  contour(fry.frequency, [[t, 12], [t + 0.5, 38], [t + 0.9, 22], [t + 1.5, 64], [t + 1.9, 30], [t + C, 16]]);
  for (const [f, q, g] of [[310, 10, 1], [740, 12, 0.7], [1290, 14, 0.45], [2240, 16, 0.25]]) {
    b.chain(fry, b.filter('bandpass', f, q), b.gain(g * 2), creak);
  }
  const groan = b.osc('sawtooth', 160, t, t + C);
  contour(groan.frequency, [[t, 150], [t + C, 185]]);
  b.chain(groan, b.filter('bandpass', 480, 20), b.gain(0.35), creak);

  // clang: a heavy, slightly dirty strike (inharmonic modes, noise, thud), the whole gate rattling
  const tc = t + C - 0.05;
  const clang = b.gain(0.55);
  clang.connect(lim);
  const modes = [[143, 1.1, 0.34], [287, 0.8, 0.26], [452, 0.65, 0.24], [631, 0.5, 0.2], [889, 0.38, 0.16],
    [1187, 0.3, 0.12], [1622, 0.22, 0.09], [2245, 0.15, 0.07], [3110, 0.1, 0.05]];
  for (const [f, tau, a] of modes) {
    const o = b.osc('sine', f * rand(0.97, 1.03), tc, tc + tau * 5);
    const g = b.gain(0);
    perc(g.gain, tc, a, 0.002, tau * 0.7, tc + tau * 5);
    b.chain(o, g, clang);
  }
  const hit = b.noise('white', tc, tc + 0.5);
  const hg = b.gain(0);
  perc(hg.gain, tc, 0.7, 0.001, 0.06, tc + 0.5);
  b.chain(hit, b.filter('bandpass', 1400, 0.7), hg, clang);
  const thud = b.osc('sine', 62, tc, tc + 0.6);
  contour(thud.frequency, [[tc, 75], [tc + 0.3, 48]]);
  const tg = b.gain(0);
  perc(tg.gain, tc, 0.7, 0.003, 0.08, tc + 0.6);
  b.chain(thud, tg, clang);
  b.chain(b.sample(pick(banks.chain(ctx)), tc + 0.02, 0.7), b.gain(0.5), lim);
  b.chain(b.sample(pick(banks.rattle(ctx)), tc + 0.03, 1.4), b.gain(0.35), lim);
  return C + 5.6;
}

// =============================================================================================
// Score / cues
// =============================================================================================

// Subtle low bell for a checkpoint.
export function chime(b) {
  const t = b.t;
  const f = 146.83;
  const parts = [[1, 0.32, 3.5], [1.0082, 0.15, 3.2], [2.0, 0.15, 2.5], [2.76, 0.11, 1.6], [4.07, 0.06, 1.0], [5.4, 0.04, 0.7]];
  for (const [r, a, tau] of parts) {
    const o = b.osc('sine', f * r, t, t + tau * 5);
    const g = b.gain(0);
    perc(g.gain, t, a, 0.006, tau, t + tau * 5 - 0.01);
    b.chain(o, g, b.out);
  }
  return 17.5;
}

// Low swell when entering a new zone.
export function swell(b) {
  const t = b.t;
  const D = 5.5;
  const env = b.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(1, t, 0.9);
  env.gain.setTargetAtTime(0, t + 2.6, 0.7);
  env.gain.setValueAtTime(0, t + D);
  env.connect(b.out);
  // (the upper partials are what small speakers will play of it)
  for (const [f, a, det] of [[73.42, 0.3, 0], [110, 0.2, 5], [116.54, 0.12, -4], [36.71, 0.25, 0], [220, 0.07, 3], [329.6, 0.035, -3]]) {
    b.chain(b.osc('sine', f, t, t + D, det), b.gain(a), env);
  }
  const n = b.noise('pink', t, t + D);
  b.chain(n, b.filter('lowpass', 380, 0.7), b.gain(0.3), env);
  return D;
}

// Short dissonant hit when you are spotted (non-positional, under the shriek).
export function stinger(b) {
  const { ctx } = b;
  const t = b.t;
  const D = 2.2;
  const out = b.gain(1);
  out.connect(b.limiter(0.92));
  const boom = b.osc('sine', 70, t, t + 1.2);
  contour(boom.frequency, [[t, 74], [t + 0.8, 38]]);
  const bg = b.gain(0);
  perc(bg.gain, t, 0.6, 0.006, 0.25, t + 1.2);
  b.chain(boom, bg, out);
  const cl = b.gain(0);
  cl.gain.setValueAtTime(0, t);
  cl.gain.linearRampToValueAtTime(0.5, t + 0.015);
  cl.gain.setTargetAtTime(0, t + 0.05, 0.45);
  cl.gain.setValueAtTime(0, t + D);
  const lp = b.filter('lowpass', 2400, 1.2);
  contour(lp.frequency, [[t, 2600], [t + D, 260]]);
  b.chain(cl, lp, out);
  for (const f of [146.83, 155.56, 220, 233.08]) b.chain(b.osc('sawtooth', f, t, t + D, rand(-8, 8)), b.gain(0.17), cl);
  const hi = b.gain(0);
  lines(hi.gain, [[t, 0], [t + 0.02, 0.09], [t + 0.7, 0.03], [t + 1.2, 0]]);
  const trem = b.osc('square', 11, t, t + 1.2);
  const tremVca = b.gain(0.6);
  b.chain(trem, b.gain(0.4), tremVca.gain);
  for (const f of [1760, 1864.66]) b.chain(b.osc('sawtooth', f, t, t + 1.2), tremVca);
  b.chain(tremVca, b.filter('bandpass', 2400, 1.5), hi, out);
  return D;
}

// Caught: a violent grab — noise burst, a shriek right in your face, a sub drop, then a hard cut.
export function grab(b) {
  const { ctx } = b;
  const t = b.t;
  const cut = t + 1.35;
  const out = b.gain(1);
  out.gain.setValueAtTime(1, t);
  out.gain.setValueAtTime(1, cut - 0.02);
  out.gain.linearRampToValueAtTime(0, cut);
  b.chain(out, b.shaper(driveCurve(ctx, 1.5, 0.93), 'none'), b.gain(0.95), b.limiter(0.93));

  const n = b.noise('white', t, cut);
  const ng = b.gain(0);
  perc(ng.gain, t, 0.9, 0.002, 0.12, cut);
  b.chain(n, ng, out);
  shriek(b.fork(out, t + 0.03), { pitch: 1.25, length: 1.3 });
  // (a sub drop, not a 1.3 s square wave: driven harder it would be most of the energy)
  const sub = b.osc('sine', 90, t, cut);
  contour(sub.frequency, [[t, 95], [cut, 24]]);
  const sg = b.gain(0);
  lines(sg.gain, [[t, 0], [t + 0.02, 0.55], [t + 0.5, 0.4], [cut, 0.25]]);
  b.chain(sub, sg, b.shaper(driveCurve(ctx, 2)), out);
  b.chain(b.sample(pick(banks.rattle(ctx)), t + 0.04, 0.55), b.gain(0.5), out);

  // ...then only a thin ringing in the ears, fading away
  const ring = b.gain(0);
  lines(ring.gain, [[cut, 0], [cut + 0.4, 0.03], [cut + 6, 0]]);
  ring.connect(b.out);
  for (const [f, a] of [[6280, 0.6], [6287, 0.5]]) b.chain(b.osc('sine', f, cut, cut + 6.1), b.gain(a), ring);
  return cut + 6.2 - t;
}

// Ending: one calm, sustained tone with a soft fifth and octave.
export function endingTone(b) {
  const t = b.t;
  const D = 40;
  const env = b.gain(0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(1, t, 2.2);
  env.gain.setTargetAtTime(0, t + 24, 4);
  env.gain.setValueAtTime(0, t + D);
  b.chain(env, b.filter('lowpass', 2200, 0.5), b.out);
  for (const [f, a, det] of [[220, 0.3, 0], [220, 0.2, 4], [330, 0.08, -2], [440, 0.07, 1], [110, 0.12, 0]]) {
    b.chain(b.osc('sine', f, t, t + D, det), b.gain(a), env);
  }
  return D;
}

// Every synth by name (used by the engine's event table and the offline test page).
export const SYNTHS = {
  footfall, leviathanCall, legGroan, metalGroan, structureCreak, distantWail,
  questionCreak, shriek, hiss, exhale, creatureStep, footstep, breath, gasp, whoosh, emptyClick,
  clink, shatter, chainGrind, gateOpen, chime, swell, stinger, grab, endingTone,
};
