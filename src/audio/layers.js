// Long-lived sound layers: wind, city drone, tinnitus, heartbeat, the chase score, snatcher whisper
// voices and car alarms. Each owns a Builder (dispose() releases every node) and is driven by the
// engine through small setters plus schedule(now, horizon), which books automation a little ahead
// of the audio clock. Nothing here creates nodes per frame (only the occasional click one-shot).
import { Builder, driveCurve, pulseWave, throbWave, noiseBuffer } from './builder.js';
import { clickBuffer } from './synths.js';

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = ([lo, hi]) => Math.floor(rand(lo, hi + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Changes an AudioParam smoothly, skipping redundant automation calls.
function glide(param, value, now, tc, memo, key, eps = 0.002) {
  if (memo[key] !== undefined && Math.abs(memo[key] - value) <= eps * Math.max(1, Math.abs(value))) return;
  memo[key] = value;
  param.setTargetAtTime(value, now, tc);
}

class Layer {
  constructor(ctx, out) {
    this.ctx = ctx;
    this.b = new Builder(ctx, out);
    this.level = this.b.gain(0);
    this.level.connect(out);
    this.memo = {};
  }

  setLevel(v, now = this.ctx.currentTime, tc = 0.3) {
    glide(this.level.gain, v, now, tc, this.memo, 'level');
  }

  get nodeCount() {
    return this.b.nodes.length;
  }

  dispose() {
    this.b.dispose();
  }
}

// Cold wind: two decorrelated pink-noise beds in resonant, wandering bandpasses (the "voice" of the
// wind) that swell with each gust, airy hiss on top, a low rumble, and now and then a thin
// whistle through some broken window.
export class WindLayer extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    this.sides = [];
    for (const pan of [-0.7, 0.7]) {
      const bp = b.filter('bandpass', 420, 2.4);
      const g = b.gain(0.5);
      b.chain(b.noise('pink'), bp, g, b.pan(pan), this.level);
      this.sides.push({ bp, g });
    }
    this.hiss = b.filter('bandpass', 3000, 0.9);
    this.hissGain = b.gain(0.02);
    b.chain(b.noise('white'), this.hiss, this.hissGain, this.level);
    this.lowGain = b.gain(0.2);
    b.chain(b.noise('brown'), b.filter('lowpass', 200, 0.7), this.lowGain, this.level);
    this.whistle = b.filter('bandpass', 950, 30);
    this.whistleGain = b.gain(0);
    this.whistlePan = b.pan(0.3);
    b.chain(b.noise('white'), this.whistle, this.whistleGain, this.whistlePan, this.level);
    this.nextGust = 0;
    this.nextWhistle = 0;
  }

  schedule(now, horizon) {
    if (this.nextGust < now) this.nextGust = now;
    while (this.nextGust < now + horizon) {
      const t = this.nextGust;
      const gust = Math.random() ** 1.5;
      const tc = rand(0.7, 2.4);
      for (const s of this.sides) {
        s.bp.frequency.setTargetAtTime((240 + 760 * gust) * rand(0.75, 1.3), t, tc * rand(0.8, 1.2));
        s.g.gain.setTargetAtTime((0.25 + 1.1 * gust) * rand(0.7, 1), t, tc);
      }
      this.hiss.frequency.setTargetAtTime(2000 + 2500 * gust, t, tc);
      this.hissGain.gain.setTargetAtTime(0.01 + 0.06 * gust * gust, t, tc);
      this.lowGain.gain.setTargetAtTime(0.12 + 0.3 * gust, t, tc);
      this.nextGust = t + rand(1.5, 5.5);
    }
    if (!this.nextWhistle) this.nextWhistle = now + rand(3, 8);
    while (this.nextWhistle < now + horizon) {
      const t = Math.max(now, this.nextWhistle);
      const D = rand(2.5, 7);
      const f = rand(550, 1400);
      this.whistle.frequency.setTargetAtTime(f, t, 0.3);
      this.whistle.frequency.setTargetAtTime(f * rand(0.85, 1.2), t + D * 0.4, D * 0.3);
      this.whistleGain.gain.setTargetAtTime(rand(2.5, 5), t, D * 0.2);
      this.whistleGain.gain.setTargetAtTime(0, t + D * 0.6, D * 0.15);
      this.whistlePan.pan?.setValueAtTime(rand(-0.8, 0.8), t);
      this.nextWhistle = t + D + rand(5, 15);
    }
  }
}

// The low hum of a dead city: beating sub sines, a faint mid hum and distant rumble, breathing slowly.
export class DroneLayer extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    const vca = b.gain(0.6);
    for (const [f, a, det] of [[41.2, 0.32, 0], [41.2, 0.28, 7], [61.74, 0.16, -5], [82.41, 0.07, 3]]) {
      b.chain(b.osc('sine', f, ctx.currentTime, null, det), b.gain(a), vca);
    }
    b.chain(b.osc('triangle', 123.47, ctx.currentTime, null, -3), b.filter('bandpass', 250, 2), b.gain(0.05), vca);
    b.chain(b.osc('sine', 0.055), b.gain(0.25), vca.gain);
    vca.connect(this.level);
    b.chain(b.noise('brown'), b.filter('lowpass', 90, 0.7), b.gain(0.4), this.level);
  }
}

// A faint high ringing in the ears that rises with tension.
export class TinnitusLayer extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    for (const [f, a] of [[7040, 0.4], [7046.5, 0.36], [4186, 0.1]]) b.chain(b.osc('sine', f), b.gain(a), this.level);
  }
}

// Heartbeat: one persistent oscillator whose pitch and gain are re-triggered for each lub-dub.
export class HeartbeatLayer extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    this.osc = b.osc('sine', 50);
    this.env = b.gain(0);
    b.chain(this.osc, this.env, b.shaper(driveCurve(ctx, 2.2)), b.filter('lowpass', 180, 0.7), b.gain(0.8), this.level);
    this.level.gain.value = 1;
    this.next = 0;
  }

  // level 0..1 (0 = stopped), bpm
  schedule(now, horizon, bpm, level) {
    if (level <= 0.01) {
      this.next = 0;
      return;
    }
    if (this.next < now) this.next = now + 0.05;
    while (this.next < now + horizon) {
      const t = this.next;
      const period = 60 / bpm;
      this.beat(t, level);
      this.beat(t + Math.max(0.17, period * 0.3), level * 0.55);
      this.next = t + period;
    }
  }

  beat(t, a) {
    const f = this.osc.frequency;
    f.setValueAtTime(64, t);
    f.exponentialRampToValueAtTime(36, t + 0.12);
    const g = this.env.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(a, t + 0.012);
    g.setTargetAtTime(0, t + 0.014, 0.05);
  }
}

// Chase score: a low, throbbing dissonant string cluster (minor seconds and a tritone) that opens
// up as intensity rises, with a tremolo screech of high strings at the top.
export class ChaseLayer extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    const t = ctx.currentTime;
    // Randomly detuned saws can line up past full scale at top intensity: soft-limit the sum.
    const lim = b.limiter(0.92, this.level);
    const cluster = b.gain(1);
    for (const f of [55, 58.27, 82.41, 87.31, 116.54, 123.47]) {
      b.chain(b.osc('sawtooth', f, t, null, rand(-6, 6)), b.gain(0.16), cluster);
    }
    this.lp = b.filter('lowpass', 300, 2.2);
    this.pulseVca = b.gain(0.45);
    this.pulse = b.osc(throbWave(ctx), 1.5, t);
    b.chain(this.pulse, b.gain(0.55), this.pulseVca.gain);
    b.chain(cluster, this.lp, this.pulseVca, lim);
    b.chain(b.osc('sine', 41.2, t), b.gain(0.4), this.pulseVca);

    const hi = b.gain(0.55);
    b.chain(b.osc('square', 9.5, t), b.gain(0.4), hi.gain);
    for (const f of [880, 932.33, 1318.5]) b.chain(b.osc('sawtooth', f, t, null, rand(-10, 10)), b.gain(0.2), hi);
    this.hiGain = b.gain(0);
    b.chain(hi, b.filter('bandpass', 1900, 1.2), this.hiGain, lim);
  }

  set(intensity, now) {
    const m = this.memo;
    glide(this.level.gain, Math.pow(intensity, 1.3), now, 0.25, m, 'level', 0.01);
    glide(this.lp.frequency, 220 + 1700 * intensity * intensity, now, 0.4, m, 'lp', 0.02);
    glide(this.pulse.frequency, 1.1 + 1.5 * intensity, now, 0.5, m, 'rate', 0.02);
    const hi = intensity < 0.55 ? 0 : ((intensity - 0.55) / 0.45) ** 2;
    glide(this.hiGain.gain, hi * 0.4, now, 0.5, m, 'hi', 0.01);
  }
}

// Vowel formants (F1, F2, F3) for whispered syllables.
const VOWELS = [
  [300, 2300, 3000], [400, 2000, 2600], [700, 1200, 2500], [600, 900, 2400], [350, 800, 2300], [500, 1500, 2500],
];

// Snatcher whisper babble: one looping noise source shaped into syllables by formant filters and a
// scheduled envelope (some syllables play "backwards": a swell that cuts off), fricative bursts,
// an occasional voiced murmur and wet clicks. `out` is the input of a positional chain.
export class WhisperVoice extends Layer {
  constructor(ctx, out) {
    super(ctx, out);
    const b = this.b;
    this.level.gain.value = 1;
    const src = b.noise('white');
    this.f = [b.filter('bandpass', 600, 5), b.filter('bandpass', 1500, 7), b.filter('bandpass', 2600, 8)];
    this.vowel = b.gain(0);
    [1.8, 1.3, 0.7].forEach((g, i) => b.chain(src, this.f[i], b.gain(g), this.vowel));
    this.fricF = b.filter('highpass', 4500, 0.7);
    this.fric = b.gain(0);
    b.chain(src, this.fricF, this.fric);
    this.murmurOsc = b.osc(pulseWave(ctx), 80);
    this.murmur = b.gain(0);
    b.chain(this.murmurOsc, b.filter('bandpass', 520, 3), b.gain(0.5), this.murmur);
    this.mix = b.gain(1);
    for (const n of [this.vowel, this.fric, this.murmur]) n.connect(this.mix);
    this.clickGain = b.gain(0.35);
    this.clickGain.connect(this.mix);
    this.mix.connect(this.level);
    this.clicks = new Set();
    this.next = 0;
    this.nextClick = 0;
    this.phraseLeft = 0;
    this.speaker = rand(0.9, 1.15);
  }

  // style = null silences the voice (it is listening / enthralled).
  schedule(now, horizon, style) {
    if (!style) {
      if (this.next) this.silence(now);
      return;
    }
    if (style.rate > 0) {
      if (this.next < now) this.next = now + rand(0.05, 0.4);
      while (this.next < now + horizon) this.next = this.syllable(this.next, style);
    } else if (this.next) this.silence(now, false);
    if (style.click) {
      if (!this.nextClick || this.nextClick < now - 1) this.nextClick = now + rand(...style.click) * 0.5;
      while (this.nextClick < now + horizon) {
        const n = randInt(style.clickBurst ?? [1, 1]);
        let t = Math.max(now, this.nextClick);
        for (let i = 0; i < n; i++) {
          this.click(t, style.clickLoud ?? 1);
          t += rand(0.08, 0.2);
        }
        this.nextClick = t + rand(...style.click);
      }
    }
  }

  syllable(t, s) {
    if (this.phraseLeft <= 0) {
      this.phraseLeft = randInt(s.phrase);
      this.speaker = rand(0.9, 1.15);
      return t + rand(...s.pause);
    }
    this.phraseLeft--;
    const dur = (1 / s.rate) * rand(0.6, 1.5);
    const v = pick(VOWELS);
    const k = this.speaker * rand(0.94, 1.08);
    this.f.forEach((f, i) => f.frequency.setTargetAtTime(v[i] * k, t, 0.025));
    const peak = s.loud * rand(0.45, 1);
    const g = this.vowel.gain;
    if (Math.random() < s.reverse) {
      g.setTargetAtTime(peak, t, dur * 0.35);
      g.setTargetAtTime(0, t + dur * 0.82, 0.012);
    } else {
      g.setTargetAtTime(peak, t, 0.012);
      g.setTargetAtTime(0, t + dur * 0.2, dur * 0.28);
    }
    if (Math.random() < s.fric) {
      const ft = t - rand(0.03, 0.07);
      this.fricF.frequency.setValueAtTime(rand(2800, 6500), ft);
      this.fric.gain.setTargetAtTime(peak * rand(0.35, 0.8), ft, 0.01);
      this.fric.gain.setTargetAtTime(0, ft + rand(0.03, 0.09), 0.015);
    }
    if (Math.random() < (s.voiced ?? 0)) {
      this.murmurOsc.frequency.setValueAtTime(rand(60, 110), t);
      this.murmur.gain.setTargetAtTime(peak * 0.8, t, 0.03);
      this.murmur.gain.setTargetAtTime(0, t + dur * 0.6, 0.05);
    }
    return t + dur;
  }

  click(t, loud = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = clickBuffer(this.ctx);
    s.playbackRate.value = rand(0.8, 1.2);
    let target = this.clickGain;
    if (loud !== 1) {
      target = this.ctx.createGain();
      target.gain.value = loud;
      target.connect(this.clickGain);
    }
    s.connect(target);
    this.clicks.add(s);
    s.onended = () => {
      this.clicks.delete(s);
      s.disconnect();
      if (target !== this.clickGain) target.disconnect();
    };
    s.start(t);
  }

  silence(now, stopClicks = true) {
    for (const p of [this.vowel.gain, this.fric.gain, this.murmur.gain]) {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(0, now, 0.04);
    }
    this.next = 0;
    this.phraseLeft = 0;
    if (stopClicks) this.nextClick = 0;
  }

  get nodeCount() {
    return this.b.nodes.length + this.clicks.size;
  }

  dispose() {
    for (const s of this.clicks) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ended */
      }
    }
    this.clicks.clear();
    super.dispose();
  }
}

// A car alarm: a cheap distorted horn cycling through a two-tone wail, a rising whoop and a fast yelp.
export class AlarmVoice extends Layer {
  constructor(ctx, out, t0 = ctx.currentTime) {
    super(ctx, out);
    const b = this.b;
    this.oscs = [b.osc('square', 1350, t0), b.osc('square', 1350, t0, null, 11)];
    const horn = b.gain(0.5);
    for (const o of this.oscs) o.connect(horn);
    this.env = b.gain(0);
    b.chain(horn, b.shaper(driveCurve(ctx, 3)), b.filter('bandpass', 1700, 0.8), b.filter('highpass', 450), b.gain(0.55), this.env, this.level);
    this.level.gain.value = 1;
    this.env.gain.setValueAtTime(0, t0);
    this.env.gain.setTargetAtTime(1, t0, 0.01);
    this.next = t0;
    this.pattern = 0;
    this.patternEnd = t0 + 3.6;
    this.flip = false;
    this.stopped = false;
  }

  schedule(now, horizon) {
    if (this.stopped) return;
    if (this.next < now) this.next = now;
    while (this.next < now + horizon) {
      if (this.next >= this.patternEnd) {
        this.pattern = (this.pattern + 1) % 4;
        this.patternEnd = this.next + [3.6, 2.6, 3.6, 2.2][this.pattern];
      }
      this.next = this.step(this.next);
    }
  }

  step(t) {
    this.flip = !this.flip;
    for (const o of this.oscs) {
      const f = o.frequency;
      if (this.pattern === 0 || this.pattern === 2) {
        f.setValueAtTime(this.flip ? 1350 : 1000, t);
      } else if (this.pattern === 1) {
        f.setValueAtTime(650, t);
        f.exponentialRampToValueAtTime(1750, t + 0.36);
      } else {
        f.setValueAtTime(this.flip ? 1550 : 1150, t);
        f.linearRampToValueAtTime(this.flip ? 1150 : 1550, t + 0.11);
      }
    }
    return t + (this.pattern === 1 ? 0.4 : this.pattern === 3 ? 0.115 : 0.3);
  }

  stop(now) {
    if (this.stopped) return;
    this.stopped = true;
    this.env.gain.cancelScheduledValues(now);
    this.env.gain.setTargetAtTime(0, now, 0.015);
  }
}

// Exposed for tests: make sure the shared noise buffers exist before timing-sensitive work.
export function warmNoise(ctx) {
  for (const k of ['white', 'pink', 'brown']) noiseBuffer(ctx, k);
}
