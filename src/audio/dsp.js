// Offline (plain JS) sample generation for the audio module: noise beds, reverb impulse responses and
// short "recorded-like" one-shots (footsteps, glass, clicks). Everything here is pure: it fills
// Float32Arrays from a seeded PRNG, so it can be generated once per AudioContext and reused.
import { makeRng } from '../core/math.js';

const TAU = Math.PI * 2;

// --- small filters ---------------------------------------------------------------------------

// RBJ-cookbook biquad, direct form I, processing one sample at a time.
export class Biquad {
  constructor(type, freq, q = 0.707, sr = 48000) {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(type, freq, q, sr);
  }

  set(type, freq, q, sr) {
    const w = (TAU * Math.min(freq, sr * 0.45)) / sr;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    const a0 = 1 + alpha;
    if (type === 'lowpass') {
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0;
    } else {
      // bandpass, constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - alpha) / a0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Run a whole buffer through a biquad (in place) and return it.
export function filterBuffer(data, type, freq, q, sr) {
  const f = new Biquad(type, freq, q, sr);
  for (let i = 0; i < data.length; i++) data[i] = f.process(data[i]);
  return data;
}

export function normalize(data, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i]));
  if (m > 0) {
    const k = peak / m;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
  return data;
}

// Short fade-in/out so a buffer never starts or ends on a discontinuity.
export function fadeEdges(data, sr, fadeIn = 0.001, fadeOut = 0.01) {
  const ni = Math.min(data.length, Math.floor(fadeIn * sr));
  const no = Math.min(data.length, Math.floor(fadeOut * sr));
  for (let i = 0; i < ni; i++) data[i] *= i / ni;
  for (let i = 0; i < no; i++) data[data.length - 1 - i] *= i / no;
  return data;
}

// --- noise -----------------------------------------------------------------------------------

export function fillWhite(data, rnd) {
  for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
  return data;
}

// Paul Kellet's refined pink filter.
export function fillPink(data, rnd) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return data;
}

// Leaky-integrated white noise (red/brown), DC-free.
export function fillBrown(data, rnd) {
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y = (y + 0.02 * (rnd() * 2 - 1)) * 0.998;
    data[i] = y * 3.5;
  }
  // remove residual DC
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length;
  for (let i = 0; i < data.length; i++) data[i] -= mean;
  return data;
}

// A noise loop of `seconds` whose end crossfades into its start (no click when looping).
export function makeNoiseLoop(kind, sr, seconds, seed = 1) {
  const n = Math.floor(sr * seconds);
  const xf = Math.floor(sr * 0.25);
  const raw = new Float32Array(n + xf);
  const rnd = makeRng(seed);
  if (kind === 'pink') fillPink(raw, rnd);
  else if (kind === 'brown') fillBrown(raw, rnd);
  else fillWhite(raw, rnd);
  const out = raw.slice(0, n);
  for (let i = 0; i < xf; i++) {
    const a = i / xf;
    // equal-power: uncorrelated noise keeps its level through the fade
    out[i] = raw[n + i] * Math.cos(a * Math.PI * 0.5) + raw[i] * Math.sin(a * Math.PI * 0.5);
  }
  return normalize(out, kind === 'white' ? 0.9 : 0.8);
}

// --- reverb impulse responses ----------------------------------------------------------------

// A stereo impulse response built from: discrete early reflections (flutter between two facades,
// a distant end-of-street echo) plus a diffuse noise tail whose high frequencies die faster.
//   rt60: tail decay time (s); width: facade spacing (m); bright: initial tail cutoff (Hz)
export function makeImpulseResponse(sr, {
  duration = 3.4, rt60 = 3.0, preDelay = 0.008, buildUp = 0.03, bright = 7000, dark = 500, darkTime = 1.2,
  width = 22, flutter = 10, flutterGain = 0.5, echoes = [], lowCut = 0, seed = 11,
} = {}) {
  const n = Math.floor(sr * duration);
  const chans = [new Float32Array(n), new Float32Array(n)];
  const k60 = 6.91 / rt60;
  for (let c = 0; c < 2; c++) {
    const data = chans[c];
    const rnd = makeRng(seed + c * 7919);
    // Diffuse tail with time-varying one-pole lowpass (darkening over time).
    let y = 0;
    let a = 0;
    const p0 = Math.floor(preDelay * sr);
    // Envelope (1 - e^(-t/buildUp)) · e^(-t·k60) as two running multiplicative decays.
    const dDecay = Math.exp(-k60 / sr);
    const dBuild = Math.exp(-1 / (buildUp * sr));
    let decay = 1;
    let build = 1;
    for (let i = p0; i < n; i++) {
      if (((i - p0) & 63) === 0) {
        const t = (i - p0) / sr;
        const fc = dark + (bright - dark) * Math.exp(-t / darkTime);
        a = 1 - Math.exp((-TAU * fc) / sr);
      }
      // No level compensation: low frequencies follow rt60, highs die faster as the cutoff falls.
      y += a * ((rnd() * 2 - 1) - y);
      data[i] = y * (1 - build) * decay;
      decay *= dDecay;
      build *= dBuild;
    }
    // Flutter echo between two parallel facades: a decaying, smeared tap every width/c seconds.
    const period = width / 343;
    for (let k = 1; k <= flutter; k++) {
      const jitter = (rnd() - 0.5) * 0.006;
      const t = preDelay + k * period + jitter + (c === k % 2 ? 0.0035 : 0);
      const amp = flutterGain * Math.pow(0.7, k) * (c === k % 2 ? 1 : 0.6);
      addGrain(data, sr, t, amp, 0.004 + k * 0.0015, rnd, 5200 / Math.sqrt(k));
    }
    // Discrete distant echoes [{t, gain, spread}], darker the later they come.
    for (const e of echoes) {
      const t = e.t + (c ? e.spread ?? 0.02 : 0);
      addGrain(data, sr, t, e.gain, e.smear ?? 0.03, rnd, e.cutoff ?? 1600);
    }
  }
  // Outdoors the low end escapes upward: optional highpass so the tail doesn't turn to mud.
  if (lowCut > 0) for (const data of chans) filterBuffer(data, 'highpass', lowCut, 0.6, sr);
  // Keep a sane peak (ConvolverNode normalises energy anyway).
  for (const data of chans) normalize(data, 0.7);
  return chans;
}

// A short noise "grain" (lowpassed, exponentially decaying) added at time t.
function addGrain(data, sr, t, amp, smear, rnd, cutoff) {
  const i0 = Math.floor(t * sr);
  const len = Math.floor(smear * sr * 4);
  const a = 1 - Math.exp((-TAU * cutoff) / sr);
  const d = Math.exp(-1 / (smear * sr));
  let env = amp * 3;
  let y = 0;
  for (let j = 0; j < len && i0 + j < data.length; j++) {
    y += a * ((rnd() * 2 - 1) - y);
    data[i0 + j] += y * env;
    env *= d;
  }
}

// --- one-shot samples ------------------------------------------------------------------------

// Helper: render a mono buffer of `seconds` by calling fill(data, sr, rnd).
function render(sr, seconds, seed, fill, peak = 0.85) {
  const data = new Float32Array(Math.floor(sr * seconds));
  fill(data, sr, makeRng(seed));
  return fadeEdges(normalize(data, peak), sr, 0.0005, 0.02);
}

// Adds a decaying noise burst through a biquad.
function burst(data, sr, rnd, { t = 0, amp = 1, tau = 0.01, attack = 0.0005, type = 'lowpass', freq = 1000, q = 0.7, len } = {}) {
  const f = new Biquad(type, freq, q, sr);
  const i0 = Math.floor(t * sr);
  const n = Math.floor((len ?? tau * 7 + attack) * sr);
  const na = Math.floor(attack * sr);
  const d = Math.exp(-1 / (tau * sr));
  let decay = amp;
  for (let j = 0; j < n && i0 + j < data.length; j++) {
    let env;
    if (j < na) env = (j / na) * amp;
    else {
      env = decay;
      decay *= d;
    }
    data[i0 + j] += f.process(rnd() * 2 - 1) * env;
  }
}

// Adds an exponentially decaying sinusoid (one mode of a struck object). Uses a rotating phasor
// with multiplicative decay (no per-sample sin/exp); `glide` bends the pitch down from above
// over the first ~10 ms, re-evaluated every 16 samples.
function mode(data, sr, { t = 0, freq, amp = 1, tau = 0.1, phase = 0, glide = 0 }) {
  if (freq >= sr * 0.49) return;
  const i0 = Math.floor(t * sr);
  const n = Math.min(Math.floor(tau * 7 * sr), data.length - i0);
  const decay = Math.exp(-1 / (tau * sr));
  let re = Math.cos(phase) * amp;
  let im = Math.sin(phase) * amp;
  let c = 0, s = 0;
  for (let j = 0; j < n; j++) {
    if ((j & 15) === 0) {
      const f = glide ? freq * (1 + glide * Math.exp(-j / (0.01 * sr))) : freq;
      const w = (TAU * f) / sr;
      c = Math.cos(w) * decay;
      s = Math.sin(w) * decay;
    }
    const r = re * c - im * s;
    im = re * s + im * c;
    re = r;
    data[i0 + j] += im;
  }
}

// Concrete footstep: heel thump, sole slap, grit crackle and a short scuff.
export function makeFootstep(sr, seed) {
  return render(sr, 0.42, seed, (d, sr2, rnd) => {
    const heel = 0.6 + rnd() * 0.4;
    burst(d, sr2, rnd, { t: 0, amp: 1.1 * heel, tau: 0.007, freq: 520 + rnd() * 300, q: 0.9 });
    mode(d, sr2, { t: 0, freq: 70 + rnd() * 30, amp: 0.45 * heel, tau: 0.028, glide: 0.4 });
    burst(d, sr2, rnd, { t: 0.018 + rnd() * 0.02, amp: 0.35, tau: 0.012, type: 'bandpass', freq: 1500 + rnd() * 900, q: 1.1 });
    // grit / debris under the sole
    const grains = 10 + Math.floor(rnd() * 18);
    const g = new Biquad('highpass', 2200, 0.7, sr2);
    const grit = new Float32Array(d.length);
    for (let k = 0; k < grains; k++) {
      const t = 0.01 + Math.pow(rnd(), 1.8) * 0.2;
      const i = Math.floor(t * sr2);
      grit[i] += (rnd() * 2 - 1) * 1.6 * Math.exp(-t / 0.12);
      if (i + 1 < grit.length) grit[i + 1] += (rnd() * 2 - 1) * 0.8;
    }
    for (let i = 0; i < d.length; i++) d[i] += g.process(grit[i]) * 0.5;
    // scuff (sole dragging forward)
    burst(d, sr2, rnd, { t: 0.05 + rnd() * 0.04, amp: 0.13, attack: 0.025, tau: 0.05, type: 'bandpass', freq: 2400 + rnd() * 1500, q: 0.7 });
  }, 0.85);
}

// Snatcher step: a soft padded footfall, a dragged toe and the flap of a heavy cape.
export function makeCreatureStep(sr, seed) {
  return render(sr, 0.65, seed, (d, sr2, rnd) => {
    burst(d, sr2, rnd, { t: 0, amp: 1, tau: 0.022, attack: 0.004, freq: 300 + rnd() * 160, q: 0.8 });
    mode(d, sr2, { t: 0, freq: 58 + rnd() * 20, amp: 0.35, tau: 0.04 });
    // dragged toe: slow-attack scrape
    burst(d, sr2, rnd, { t: 0.04 + rnd() * 0.05, amp: 0.3, attack: 0.07, tau: 0.08, type: 'bandpass', freq: 900 + rnd() * 700, q: 0.8 });
    // cape: band-limited noise with a fluttering amplitude
    const f = new Biquad('bandpass', 2600 + rnd() * 1800, 0.6, sr2);
    const flap = 14 + rnd() * 12;
    const t0 = rnd() * 0.05;
    const n = d.length;
    for (let i = 0; i < n; i++) {
      const t = i / sr2 - t0;
      if (t < 0 || t > 0.45) {
        f.process(0);
        continue;
      }
      const hump = Math.sin((Math.PI * t) / 0.45) ** 2;
      const flutter = 0.55 + 0.45 * Math.sin(TAU * flap * t + 3 * Math.sin(TAU * 3.1 * t));
      d[i] += f.process(rnd() * 2 - 1) * hump * flutter * 0.32;
    }
  }, 0.85);
}

// A glass bottle bursting: sharp crash, crunch, then shards tinkling and settling.
export function makeShatter(sr, seed) {
  return render(sr, 1.5, seed, (d, sr2, rnd) => {
    burst(d, sr2, rnd, { t: 0, amp: 1.2, tau: 0.03, type: 'highpass', freq: 1600, q: 0.7 });
    burst(d, sr2, rnd, { t: 0.002, amp: 0.55, tau: 0.05, type: 'bandpass', freq: 650 + rnd() * 300, q: 1.2 });
    mode(d, sr2, { t: 0, freq: 120 + rnd() * 50, amp: 0.25, tau: 0.02 });
    const shards = 40 + Math.floor(rnd() * 20);
    for (let k = 0; k < shards; k++) {
      const t = 0.004 + Math.pow(rnd(), 2.3) * 1.15;
      const amp = (0.12 + rnd() * 0.3) * Math.exp(-t / 0.35);
      const partials = 2 + Math.floor(rnd() * 3);
      for (let p = 0; p < partials; p++) {
        mode(d, sr2, { t, freq: 2600 + rnd() * 7400, amp: amp * (p ? 0.6 : 1), tau: 0.008 + rnd() * 0.05, phase: rnd() * TAU });
      }
    }
  }, 0.85);
}

// Two bottles knocking together in a pocket.
export function makeClink(sr, seed) {
  return render(sr, 0.7, seed, (d, sr2, rnd) => {
    const base = [2210, 3890, 5750, 8130];
    const taus = [0.25, 0.15, 0.08, 0.05];
    const amps = [1, 0.6, 0.4, 0.25];
    for (const [t, a] of [[0, 1], [0.085 + rnd() * 0.03, 0.45]]) {
      const tune = 0.94 + rnd() * 0.12;
      for (let p = 0; p < base.length; p++) {
        mode(d, sr2, { t, freq: base[p] * tune * (0.98 + rnd() * 0.04), amp: amps[p] * a * 0.4, tau: taus[p], phase: rnd() * TAU });
      }
      burst(d, sr2, rnd, { t, amp: 0.15 * a, tau: 0.002, type: 'highpass', freq: 3000 });
    }
    burst(d, sr2, rnd, { t: 0.0, amp: 0.08, attack: 0.03, tau: 0.06, type: 'bandpass', freq: 1800, q: 0.6 });
  }, 0.7);
}

// A wet tongue/throat click (snatchers "listen" with these).
export function makeWetClick(sr, seed) {
  return render(sr, 0.09, seed, (d, sr2, rnd) => {
    const exc = new Float32Array(d.length);
    for (let i = 0; i < Math.floor(sr2 * 0.0015); i++) exc[i] = (rnd() * 2 - 1) * (1 - i / (sr2 * 0.0015));
    const hi = new Biquad('bandpass', 1500 + rnd() * 1700, 9, sr2);
    const lo = new Biquad('bandpass', 450 + rnd() * 450, 4, sr2);
    const lag = Math.floor((0.004 + rnd() * 0.006) * sr2);
    for (let i = 0; i < d.length; i++) {
      d[i] += hi.process(exc[i]) * 3 + lo.process(i >= lag ? exc[i - lag] : 0) * 2.2;
    }
    // the wet "pop": a fast downward chirp
    let ph = 0;
    const f0 = 1400 + rnd() * 600;
    for (let i = 0; i < Math.floor(0.018 * sr2); i++) {
      const t = i / sr2;
      ph += (TAU * f0 * Math.exp(-t / 0.008)) / sr2;
      d[i + lag] += Math.sin(ph) * Math.exp(-t / 0.005) * 0.25;
    }
  }, 0.75);
}

// Loose things rattling (window panes, debris) after a heavy impact.
export function makeRattle(sr, seed) {
  return render(sr, 1.4, seed, (d, sr2, rnd) => {
    let t = 0.01;
    while (t < 1.25) {
      const env = Math.exp(-t / 0.4);
      const amp = env * (0.5 + rnd() * 0.5);
      burst(d, sr2, rnd, { t, amp: amp * 0.8, tau: 0.004, type: 'bandpass', freq: 170 + rnd() * 80, q: 5 });
      burst(d, sr2, rnd, { t, amp: amp * 0.5, tau: 0.003, type: 'bandpass', freq: 400 + rnd() * 150, q: 6 });
      if (rnd() < 0.4) mode(d, sr2, { t, freq: 2500 + rnd() * 2500, amp: amp * 0.12, tau: 0.01, phase: rnd() * TAU });
      t += 0.022 + rnd() * 0.04;
    }
  }, 0.75);
}

// A chain shaking: a run of small, heavy metallic impacts.
export function makeChain(sr, seed) {
  return render(sr, 0.9, seed, (d, sr2, rnd) => {
    let t = 0;
    const count = 9 + Math.floor(rnd() * 6);
    for (let k = 0; k < count; k++) {
      t += 0.02 + rnd() * 0.07;
      const amp = (0.4 + rnd() * 0.6) * Math.exp(-t / 0.5);
      const f0 = 1100 + rnd() * 1700;
      for (const [r, a, tau] of [[1, 1, 0.05], [2.7, 0.55, 0.03], [5.2, 0.3, 0.015]]) {
        mode(d, sr2, { t, freq: f0 * r, amp: amp * a * 0.35, tau, phase: rnd() * TAU });
      }
      burst(d, sr2, rnd, { t, amp: amp * 0.3, tau: 0.002, type: 'highpass', freq: 2500 });
    }
  }, 0.75);
}
