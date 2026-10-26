// Offline audio test page: renders every synth / layer into an OfflineAudioContext and reports
// peak, RMS, NaNs and audible duration. Driven by tools/check-audio.mjs.
//   node build.mjs --entry tools/sandbox/audio.js --out dist/sandbox-audio.html
import { Builder, impulseResponse, makeConvolver, noiseBuffer, sampleBank } from '../../src/audio/builder.js';
import { SYNTHS, warmBanks } from '../../src/audio/synths.js';
import { WindLayer, DroneLayer, TinnitusLayer, HeartbeatLayer, ChaseLayer, WhisperVoice, AlarmVoice } from '../../src/audio/layers.js';
import { STREET_IR, VAST_IR } from '../../src/audio/audio.js';
import * as D from '../../src/audio/dsp.js';

const SR = 48000;

// Times each piece of engine start-up work on a fresh context.
window.profileInit = () => {
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const out = {};
  const time = (k, fn) => {
    const t0 = performance.now();
    fn();
    out[k] = +(performance.now() - t0).toFixed(1);
  };
  for (const k of ['white', 'pink', 'brown']) time(`noise:${k}`, () => noiseBuffer(ctx, k));
  time('ir:street', () => impulseResponse(ctx, 'street', STREET_IR));
  time('ir:vast', () => impulseResponse(ctx, 'vast', VAST_IR));
  const banks = {
    step: [D.makeFootstep, 8], cstep: [D.makeCreatureStep, 6], shatter: [D.makeShatter, 4], clink: [D.makeClink, 3],
    click: [D.makeWetClick, 8], rattle: [D.makeRattle, 2], chain: [D.makeChain, 3],
  };
  for (const [k, [fn, n]] of Object.entries(banks)) time(`bank:${k}`, () => sampleBank(ctx, `p${k}`, fn, n, 5));
  return out;
};

function analyse(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  let peak = 0, sum = 0, nan = 0, last = 0, first = -1;
  const n = buffer.length;
  for (let i = 0; i < n; i++) {
    for (const d of chans) {
      const x = d[i];
      if (!Number.isFinite(x)) {
        nan++;
        continue;
      }
      const a = Math.abs(x);
      if (a > peak) peak = a;
      sum += x * x;
      if (a > 0.001) {
        last = i;
        if (first < 0) first = i;
      }
    }
  }
  // RMS over the audible span only
  let s2 = 0, cnt = 0;
  for (let i = Math.max(0, first); i <= last; i++) for (const d of chans) {
    const x = d[i];
    if (Number.isFinite(x)) {
      s2 += x * x;
      cnt++;
    }
  }
  // Loudest 50 ms window (short-term level).
  const win = Math.floor(0.05 * buffer.sampleRate);
  let maxWin = 0;
  for (let i = 0; i + win < n; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) for (const d of chans) e += d[j] * d[j];
    maxWin = Math.max(maxWin, Math.sqrt(e / (win * chans.length)));
  }
  const db = (v) => (v > 0 ? +(20 * Math.log10(v)).toFixed(1) : -Infinity);
  return {
    peak: +peak.toFixed(4), peakDb: db(peak),
    rms: +(Math.sqrt(s2 / Math.max(1, cnt))).toFixed(5), rmsDb: db(Math.sqrt(s2 / Math.max(1, cnt))),
    loudDb: db(maxWin), nan, start: +(Math.max(0, first) / buffer.sampleRate).toFixed(3),
    audible: +(last / buffer.sampleRate).toFixed(3), length: +(n / buffer.sampleRate).toFixed(3),
  };
}

function encode(buffer) {
  // interleaved float32 -> base64
  const n = buffer.length, ch = buffer.numberOfChannels;
  const out = new Float32Array(n * ch);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i * ch + c] = d[i];
  }
  const bytes = new Uint8Array(out.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { channels: ch, sampleRate: buffer.sampleRate, b64: btoa(s) };
}

// Renders `build(ctx, out)` for `seconds`. reverb: route a copy through the street/vast IR.
async function renderWith(seconds, build, { reverb = null, wet = 0.3, dry = true, data = false } = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  warmBanks(ctx);
  const out = ctx.createGain();
  if (dry) out.connect(ctx.destination);
  if (reverb) {
    const conv = makeConvolver(ctx, impulseResponse(ctx, reverb, reverb === 'vast' ? VAST_IR : STREET_IR));
    const send = ctx.createGain();
    send.gain.value = wet;
    out.connect(send);
    send.connect(conv);
    conv.connect(ctx.destination);
  }
  const t0 = performance.now();
  const extra = build(ctx, out);
  const buildMs = performance.now() - t0;
  const buffer = await ctx.startRendering();
  const stats = analyse(buffer);
  stats.buildMs = +buildMs.toFixed(1);
  if (extra != null) stats.reported = extra;
  if (data) stats.data = encode(buffer);
  return stats;
}

window.renderSynth = (name, opts = {}, { seconds = 6, ...rest } = {}) => renderWith(seconds, (ctx, out) => {
  const b = new Builder(ctx, out, 0.05);
  const d = SYNTHS[name](b, opts);
  return { duration: d, nodes: b.nodes.length };
}, rest);

const LAYERS = {
  wind: (ctx, out, secs) => {
    const l = new WindLayer(ctx, out);
    l.level.gain.value = 1;
    l.schedule(0, secs);
    return l;
  },
  drone: (ctx, out) => {
    const l = new DroneLayer(ctx, out);
    l.level.gain.value = 1;
    return l;
  },
  tinnitus: (ctx, out) => {
    const l = new TinnitusLayer(ctx, out);
    l.level.gain.value = 1;
    return l;
  },
  heartbeat: (ctx, out, secs) => {
    const l = new HeartbeatLayer(ctx, out);
    l.schedule(0, secs / 2, 75, 1);
    // speed up halfway
    l.next = Math.max(l.next, secs / 2);
    l.schedule(secs / 2, secs / 2, 135, 1);
    return l;
  },
  chase: (ctx, out, secs) => {
    const l = new ChaseLayer(ctx, out);
    // ramp intensity 0 -> 1 over the render
    for (let k = 0; k <= 10; k++) l.set(k / 10, (k / 10) * secs * 0.8);
    return l;
  },
  whisper: (ctx, out, secs) => {
    const l = new WhisperVoice(ctx, out);
    const styles = [
      { rate: 5, loud: 0.6, phrase: [3, 8], pause: [0.8, 3.2], fric: 0.45, reverse: 0.25, voiced: 0.08, click: [2.5, 7], clickBurst: [1, 2] },
      { rate: 8.5, loud: 1, phrase: [6, 14], pause: [0.15, 0.5], fric: 0.7, reverse: 0.15, voiced: 0.3, click: [3, 6], clickBurst: [1, 2] },
    ];
    l.schedule(0, secs / 2, styles[0]);
    l.next = Math.max(l.next, secs / 2);
    l.schedule(secs / 2, secs / 2, styles[1]);
    return l;
  },
  alarm: (ctx, out, secs) => {
    const l = new AlarmVoice(ctx, out, 0.05);
    l.schedule(0, secs - 0.5);
    l.stop(secs - 0.4);
    return l;
  },
};

window.renderLayer = (name, { seconds = 10, ...rest } = {}) => renderWith(seconds, (ctx, out) => {
  const l = LAYERS[name](ctx, out, seconds);
  return { nodes: l.nodeCount };
}, rest);

window.renderIR = async (key, { data = false } = {}) => {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const t0 = performance.now();
  const buf = impulseResponse(ctx, key, key === 'vast' ? VAST_IR : STREET_IR);
  const ms = performance.now() - t0;
  const stats = analyse(buf);
  stats.genMs = +ms.toFixed(1);
  // energy decay: time for the smoothed envelope to drop 60 dB below its peak (Schroeder integral)
  const d = buf.getChannelData(0);
  const e = new Float64Array(d.length);
  let acc = 0;
  for (let i = d.length - 1; i >= 0; i--) {
    acc += d[i] * d[i];
    e[i] = acc;
  }
  const t = (dbDown) => {
    const thr = e[0] * Math.pow(10, -dbDown / 10);
    for (let i = 0; i < e.length; i++) if (e[i] < thr) return +(i / SR).toFixed(3);
    return null;
  };
  stats.edt10 = t(10);
  stats.t30 = t(35) && t(5) ? +((t(35) - t(5)) * 2).toFixed(3) : null;
  if (data) stats.data = encode(buf);
  return stats;
};

window.SYNTH_NAMES = Object.keys(SYNTHS);
window.__game = { sandbox: 'audio' };
document.getElementById('boot')?.remove();
