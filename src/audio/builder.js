// WebAudio plumbing shared by every synth: a Builder that creates and remembers the nodes of one
// voice (so the whole voice can be disconnected in one go when it ends), plus per-context caches for
// noise buffers, generated samples, waveshaper curves and periodic waves. Works with both a live
// AudioContext and an OfflineAudioContext.
import { makeNoiseLoop, makeImpulseResponse } from './dsp.js';

const caches = new WeakMap();

// Memoise `make()` per AudioContext under `key`.
export function cached(ctx, key, make) {
  let c = caches.get(ctx);
  if (!c) caches.set(ctx, (c = new Map()));
  if (!c.has(key)) c.set(key, make());
  return c.get(key);
}

export function toBuffer(ctx, channels) {
  const list = Array.isArray(channels) ? channels : [channels];
  const buf = ctx.createBuffer(list.length, list[0].length, ctx.sampleRate);
  list.forEach((data, i) => buf.copyToChannel ? buf.copyToChannel(data, i) : buf.getChannelData(i).set(data));
  return buf;
}

const NOISE_SECONDS = { white: 4, pink: 8, brown: 8 };

export function noiseBuffer(ctx, kind = 'white') {
  return cached(ctx, `noise:${kind}`, () => toBuffer(ctx, makeNoiseLoop(kind, ctx.sampleRate, NOISE_SECONDS[kind] ?? 4, kind.length * 977 + 13)));
}

// A bank of `count` variations of a generated sample: make(sampleRate, seed) -> Float32Array.
export function sampleBank(ctx, key, make, count, seed = 1) {
  return cached(ctx, `bank:${key}`, () => {
    const out = [];
    for (let i = 0; i < count; i++) out.push(toBuffer(ctx, make(ctx.sampleRate, seed * 1000 + i * 37 + 1)));
    return out;
  });
}

export function impulseResponse(ctx, key, opts) {
  return cached(ctx, `ir:${key}`, () => toBuffer(ctx, makeImpulseResponse(ctx.sampleRate, opts)));
}

// Soft-saturation curve: tanh(k·x) normalised so ±1 -> ±ceiling.
export function driveCurve(ctx, k = 2, ceiling = 0.95) {
  return cached(ctx, `drive:${k}:${ceiling}`, () => {
    const n = 2048;
    const curve = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = (Math.tanh(k * x) / norm) * ceiling;
    }
    return curve;
  });
}

// Band-limited impulse train: at low rates it is a "creak"/vocal fry, higher up a buzzy pitched
// source. Not normalised: every harmonic has the same small amplitude whatever the harmonic count,
// so the raw wave peaks far above 1 — always feed it through resonant filters.
export function pulseWave(ctx, harmonics = 1024) {
  return cached(ctx, `pulse:${harmonics}`, () => {
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    for (let h = 1; h <= harmonics; h++) real[h] = 0.014 * (1 - (h / (harmonics + 1)) * 0.5);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  });
}

// Safety limiter: unity gain below 0.7, then a smooth knee that never exceeds `ceiling`.
export function limitCurve(ctx, ceiling = 0.95) {
  return cached(ctx, `limit:${ceiling}`, () => {
    const n = 4096;
    const curve = new Float32Array(n);
    const knee = 0.7;
    const room = ceiling - knee;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 4 - 2; // input range -2..2
      const a = Math.abs(x);
      const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  });
}

// Smooth one-sided pulse (for throbbing LFOs): mostly low, a rounded bump once per cycle.
export function throbWave(ctx) {
  return cached(ctx, 'throb', () => {
    const n = 12;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let h = 1; h <= n; h++) real[h] = Math.exp(-h * h * 0.035);
    return ctx.createPeriodicWave(real, imag);
  });
}

// Creates and tracks the nodes of one voice. `t` is the voice's start time on the context clock.
export class Builder {
  constructor(ctx, out, when) {
    this.ctx = ctx;
    this.out = out;
    this.t = when ?? ctx.currentTime;
    this.nodes = [];
  }

  track(node) {
    this.nodes.push(node);
    return node;
  }

  // A builder writing to another node / start time but sharing this one's node list.
  fork(out, when = this.t) {
    const b = new Builder(this.ctx, out, when);
    b.nodes = this.nodes;
    return b;
  }

  gain(value = 1) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return this.track(g);
  }

  filter(type, frequency, Q = 0.707, gain = 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    if (gain) f.gain.value = gain;
    return this.track(f);
  }

  // type: oscillator type string or a PeriodicWave. Starts at `start`, stops at `stop` (if given).
  osc(type, frequency, start = this.t, stop = null, detune = 0) {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type;
    else o.setPeriodicWave(type);
    o.frequency.value = frequency;
    o.detune.value = detune;
    o.start(start);
    if (stop != null) o.stop(stop);
    return this.track(o);
  }

  // Looping noise from the shared buffer, started at a random offset.
  noise(kind = 'white', start = this.t, stop = null, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = noiseBuffer(this.ctx, kind);
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(start, Math.random() * (s.buffer.duration - 0.1));
    if (stop != null) s.stop(stop);
    return this.track(s);
  }

  sample(buffer, start = this.t, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = rate;
    s.start(start);
    return this.track(s);
  }

  shaper(curve, oversample = '2x') {
    const w = this.ctx.createWaveShaper();
    w.curve = curve;
    w.oversample = oversample;
    return this.track(w);
  }

  // Output stage that guarantees no sample above `ceiling`: returns the node to feed. The curve
  // spans inputs -2..2, so the signal is halved going in and the curve restores unity gain.
  limiter(ceiling = 0.95, dest = this.out) {
    const pre = this.gain(0.5);
    this.chain(pre, this.shaper(limitCurve(this.ctx, ceiling), 'none'), dest);
    return pre;
  }

  pan(value = 0) {
    if (!this.ctx.createStereoPanner) return this.gain(1);
    const p = this.ctx.createStereoPanner();
    p.pan.value = value;
    return this.track(p);
  }

  // Connect nodes in series; returns the last.
  chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  dispose() {
    for (const n of this.nodes) {
      // Sources with no stop time would keep running on the audio thread even when disconnected.
      if (n.stop) {
        try {
          n.stop();
        } catch {
          /* never started / already stopped */
        }
      }
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes.length = 0;
  }
}

// --- automation helpers ----------------------------------------------------------------------

const EPS = 0.0001;

// Percussive envelope on an AudioParam: 0 -> peak in `attack`, then exponential decay with time
// constant `tau`; a fast release just before `end` makes sure it reaches silence without a click.
export function perc(param, t, peak, attack, tau, end = t + attack + tau * 7) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
  const rel = Math.max(t + attack, end - 0.08);
  param.setTargetAtTime(0, rel, Math.min(0.012, (end - rel) / 6 || 0.001));
}

// Piecewise exponential pitch/frequency contour: points = [[time, value], ...] (absolute times).
export function contour(param, points, scale = 1) {
  const [t0, v0] = points[0];
  param.setValueAtTime(Math.max(EPS, v0 * scale), t0);
  for (let i = 1; i < points.length; i++) {
    const [t, v] = points[i];
    param.exponentialRampToValueAtTime(Math.max(EPS, v * scale), t);
  }
}

// Piecewise linear contour (for gains that may reach 0).
export function lines(param, points, scale = 1) {
  const [t0, v0] = points[0];
  param.setValueAtTime(v0 * scale, t0);
  for (let i = 1; i < points.length; i++) param.linearRampToValueAtTime(points[i][1] * scale, points[i][0]);
}

// Positional/air helpers shared by the engine and the offline tests.
export function makeConvolver(ctx, ir = null) {
  const c = ctx.createConvolver();
  c.normalize = true;
  if (ir) c.buffer = ir;
  return c;
}
