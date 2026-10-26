import * as THREE from 'three';
import { clamp, noise1, smoothstep } from '../core/math.js';

const BUCKET = 16; // m, spatial hash cell for stealth-light queries
const BUCKET_MIN_SOURCES = 12; // below this a linear scan is cheaper than the hash
const FADE_RATE = 2.6; // pool fade in/out per second (~0.4 s)
const ON_RATE = 28; // enabled toggles: fast but not a hard pop (alarm blinks stay crisp)
// A camera jump this large in one update (respawn, title -> play, teleport) is a cut, not a walk:
// the pool snaps to the new surroundings instead of fading the old lights out and the new ones in
// (which would leave the new place unlit for ~0.8 s).
const SNAP_DISTANCE = 15;

const _c = new THREE.Color();
const _flick = { shimmer: 1, drop: 1 };

// Registry of the level's light sources, a fixed pool of real PointLights that follows the most
// relevant ones, and the stealth light-level query used by the player and the AI.
//
// A source is the object passed to register(); it is returned as the handle and stays mutable:
//   { pos: Vector3|{x,y,z}, color, intensity, distance, decay?, flicker?: 0..1,
//     stealthRadius, stealthWeight?: 0..1, enabled?: true }
// `intensity` is three.js PointLight intensity (candela, physical decay 2): a burning barrel
// ~25-40, a working street lamp ~40-80. While registered, the handle also exposes
// `handle.level` (0..1.x): the current flicker x on/off factor, so emissive meshes/halos can pulse
// in sync with the real light.
export class LightPool {
  constructor(scene, count = 6) {
    this.sources = [];
    this.records = [];
    this.ambient = 0.13;
    this.slots = [];
    this.group = new THREE.Group();
    this.group.name = 'atmosphere-light-pool';
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.name = `pool-light-${i}`;
      light.position.set(0, -100, 0);
      this.group.add(light);
      this.slots.push({ light, rec: null });
    }
    scene.add(this.group);
    this.buckets = null;
    this.bucketsDirty = true;
    this.sag = 0; // 0..1 global dimming (footfall power stutter, the call)
    this._seed = 1;
    this._frame = 0;
    this._ranked = [];
    this._lastCam = null;
    this._snapNext = true; // first update: light the start position immediately
  }

  // Next update assigns the pool instantly (no fades). Called on respawn; camera cuts are detected.
  snap() {
    this._snapNext = true;
  }

  register(src) {
    if (!src || typeof src !== 'object') throw new Error('registerLightSource: expected an object');
    // Registering the same handle again (e.g. from a level's resetDynamic) must not double its light.
    if (this.sources.includes(src)) return src;
    if (!src.pos) src.pos = new THREE.Vector3();
    if (src.enabled === undefined) src.enabled = true;
    if (src.intensity === undefined) src.intensity = 30;
    if (src.color === undefined) src.color = 0xff8a4a;
    const rec = {
      src,
      seed: (this._seed++ * 7.31) % 97,
      baseIntensity: src.intensity > 0 ? src.intensity : 0,
      on: src.enabled ? 1 : 0,
      flick: 1,
      stealth: src.enabled ? 1 : 0,
      weight: 0, // pool fade 0..1
      slot: null,
      score: 0,
      wanted: 0,
      lastX: NaN, lastZ: NaN, lastR: NaN,
    };
    this.records.push(rec);
    this.sources.push(src);
    this.bucketsDirty = true;
    src.level = rec.on;
    return src;
  }

  unregister(src) {
    const i = this.records.findIndex((r) => r.src === src);
    if (i < 0) return;
    const rec = this.records[i];
    if (rec.slot) {
      rec.slot.rec = null;
      rec.slot.light.intensity = 0;
    }
    this.records.splice(i, 1);
    this.sources.splice(this.sources.indexOf(src), 1);
    this.bucketsDirty = true;
  }

  static stealthRadiusOf(src) {
    return src.stealthRadius ?? src.radius ?? (src.distance ? src.distance * 0.55 : 6);
  }

  // Flicker: two octaves of value noise (the shimmer) plus, for badly flickering sources, rare
  // deep dropouts. Writes { shimmer, drop } (both 0..1 multipliers) into `out`.
  static flicker(f, t, seed, out) {
    if (!(f > 0)) {
      out.shimmer = 1;
      out.drop = 1;
      return out;
    }
    const n = noise1(t * 7.3, seed) * 0.62 + noise1(t * 19.7, seed + 3.1) * 0.38;
    out.shimmer = 1 - f * 0.6 * n;
    out.drop = 1 - 0.88 * smoothstep(0.74, 0.84, noise1(t * 1.9, seed + 9.7)) * smoothstep(0.6, 1, f);
    return out;
  }

  update(dt, time, camPos, camFwd) {
    const recs = this.records;
    const onK = 1 - Math.exp(-ON_RATE * dt);
    let snap = this._snapNext;
    if (this._lastCam) snap ||= this._lastCam.distanceToSquared(camPos) > SNAP_DISTANCE * SNAP_DISTANCE;
    else this._lastCam = new THREE.Vector3();
    this._lastCam.copy(camPos);
    // --- per-source state + relevance score
    let moved = false;
    for (const r of recs) {
      const s = r.src;
      r.on += ((s.enabled ? 1 : 0) - r.on) * onK;
      const { shimmer, drop } = LightPool.flicker(s.flicker || 0, time, r.seed, _flick);
      const ratio = r.baseIntensity > 0 ? clamp(s.intensity / r.baseIntensity, 0, 1.5) : s.intensity > 0 ? 1 : 0;
      r.flick = shimmer * drop;
      s.level = r.on * r.flick;
      // Stealth follows dropouts fully (a dead lamp is a dark spot) but only a fifth of the
      // shimmer, so standing next to a fire stays reliably dangerous.
      r.stealth = r.on * drop * (1 - 0.2 * (1 - shimmer)) * ratio;
      const p = s.pos;
      const sr = LightPool.stealthRadiusOf(s);
      if (p.x !== r.lastX || p.z !== r.lastZ || sr !== r.lastR) {
        r.lastX = p.x;
        r.lastZ = p.z;
        r.lastR = sr;
        moved = true;
      }
      if (!s.enabled && r.on < 0.01) {
        r.score = 0;
        continue;
      }
      const dx = p.x - camPos.x, dy = (p.y ?? 2.5) - camPos.y, dz = p.z - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2);
      const range = s.distance || 12;
      // Lights behind the camera still light what we look at, but less of it.
      const facing = d > 0.01 ? (dx * camFwd.x + dy * camFwd.y + dz * camFwd.z) / d : 1;
      const view = 0.55 + 0.45 * smoothstep(-0.5, 0.4, facing);
      const reach = Math.max(0, d - range * 0.5);
      r.score = (Math.max(1, s.intensity) * view) / (1 + reach * reach * 0.04 + d * 0.05);
      if (r.slot) r.score *= 1.35; // hysteresis: incumbents are sticky
    }
    if (moved) this.bucketsDirty = true;

    // --- choose the desired set (top N by score)
    const n = this.slots.length;
    const ranked = this._ranked;
    ranked.length = 0;
    for (const r of recs) if (r.score > 0) ranked.push(r);
    ranked.sort((a, b) => b.score - a.score);
    if (ranked.length > n) ranked.length = n;
    const stamp = ++this._frame;
    for (const r of ranked) r.wanted = stamp;

    // --- fade slots; free a slot only once fully faded so nothing pops (unless this is a cut)
    const fadeK = FADE_RATE * dt;
    for (const slot of this.slots) {
      const r = slot.rec;
      if (!r) continue;
      if (r.wanted === stamp) r.weight = snap ? 1 : Math.min(1, r.weight + fadeK);
      else {
        r.weight = snap ? 0 : Math.max(0, r.weight - fadeK);
        if (r.weight <= 0) {
          r.slot = null;
          slot.rec = null;
        }
      }
    }
    for (const r of ranked) {
      if (r.slot) continue;
      const free = this.slots.find((sl) => !sl.rec);
      if (!free) break;
      free.rec = r;
      r.slot = free;
      r.weight = snap ? 1 : 0;
    }
    this._snapNext = false;

    // --- drive the real lights
    const supply = clamp(1 - this.sag, 0, 1);
    for (const slot of this.slots) {
      const L = slot.light;
      const r = slot.rec;
      if (!r) {
        L.intensity = 0;
        L.visible = true; // keep the light count constant -> no shader recompiles
        continue;
      }
      const s = r.src;
      const w = r.weight * r.weight * (3 - 2 * r.weight);
      L.position.set(s.pos.x, s.pos.y ?? 2.5, s.pos.z);
      L.color.set(s.color);
      L.intensity = Math.max(0, s.intensity) * r.on * r.flick * w * supply;
      L.distance = s.distance || 12;
      L.decay = s.decay ?? 2;
    }
  }

  // Stealth light level (0..1) at a ground position. Cheap; called every frame by player and AI.
  levelAt(pos) {
    const recs = this.bucketList(pos);
    let dark = 1;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!(r.stealth > 0.001)) continue;
      const s = r.src;
      const R = r.lastR || LightPool.stealthRadiusOf(s);
      const dx = pos.x - s.pos.x, dz = pos.z - s.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      const q = 1 - d2 / (R * R);
      const c = clamp((s.stealthWeight ?? 0.85) * q * q * Math.min(1, r.stealth), 0, 1);
      dark *= 1 - c;
    }
    return clamp(this.ambient + (1 - this.ambient) * (1 - dark), 0, 1);
  }

  bucketList(pos) {
    if (this.records.length < BUCKET_MIN_SOURCES) return this.records;
    if (this.bucketsDirty || !this.buckets) this.rebuildBuckets();
    return this.buckets.get(this.key(Math.floor(pos.x / BUCKET), Math.floor(pos.z / BUCKET))) || EMPTY;
  }

  key(ix, iz) {
    return ix * 92821 + iz * 68917;
  }

  rebuildBuckets() {
    const map = new Map();
    for (const r of this.records) {
      const s = r.src;
      const R = LightPool.stealthRadiusOf(s);
      r.lastR = R;
      for (let ix = Math.floor((s.pos.x - R) / BUCKET); ix <= Math.floor((s.pos.x + R) / BUCKET); ix++) {
        for (let iz = Math.floor((s.pos.z - R) / BUCKET); iz <= Math.floor((s.pos.z + R) / BUCKET); iz++) {
          const k = this.key(ix, iz);
          let list = map.get(k);
          if (!list) map.set(k, (list = []));
          list.push(r);
        }
      }
    }
    this.buckets = map;
    this.bucketsDirty = false;
  }

  // Pooled lights packed for the mist shader: positions and colour*intensity (w = range).
  pack(posArr, colArr) {
    let i = 0;
    for (const slot of this.slots) {
      const L = slot.light;
      posArr[i * 3] = L.position.x;
      posArr[i * 3 + 1] = L.position.y;
      posArr[i * 3 + 2] = L.position.z;
      _c.copy(L.color).multiplyScalar(L.intensity);
      colArr[i * 4] = _c.r;
      colArr[i * 4 + 1] = _c.g;
      colArr[i * 4 + 2] = _c.b;
      colArr[i * 4 + 3] = L.distance || 12;
      i++;
    }
  }
}

const EMPTY = [];
