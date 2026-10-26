import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp, damp, lerp, noise1, smoothstep } from '../core/math.js';
import { fogShared, fogFactorBetween, installAtmosphereFog } from './atmosphere-fog.js';
import { getNoiseTexture } from './atmosphere-noise.js';
import { Sky } from './atmosphere-sky.js';
import { LightPool } from './atmosphere-lights.js';
import { Particles } from './atmosphere-particles.js';
import { createPost } from './atmosphere-post.js';

const rgb = (r, g, b) => new THREE.Color().setRGB(r, g, b); // linear working space

// The whole mood in one place (linear colours, pre tone-mapping).
const LOOK = {
  horizon: rgb(0.21, 0.035, 0.019), // fog colour where the sky meets the streets
  zenith: rgb(0.0045, 0.001, 0.0012),
  mid: rgb(0.045, 0.0058, 0.0045),
  glowStrength: 0.85,
  glowDir: new THREE.Vector3(-0.6, 0.0, -0.8).normalize(),
  sunDir: new THREE.Vector3(-0.6, 0.15, -0.79).normalize(),
  sun: rgb(0.5, 0.085, 0.024),
  skyGlow: rgb(0.55, 0.1, 0.035),
  cloudLow: rgb(0.26, 0.048, 0.024),
  cloudHigh: rgb(0.032, 0.0075, 0.0062),
  hemiSky: rgb(1.0, 0.26, 0.15),
  hemiGround: rgb(0.06, 0.018, 0.014),
  hemiIntensity: 1.5,
  dirColor: rgb(1.0, 0.36, 0.16),
  dirIntensity: 0.7,
  mistLow: rgb(0.05, 0.0095, 0.0065),
  mistHigh: rgb(0.13, 0.024, 0.014),
  // Height fog: density at the street, exponential falloff with altitude, high-altitude floor.
  fogDensity: 0.0228,
  fogFalloff: 0.09,
  fogFloor: 0.12,
};

const EYE = 1.65;
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();

// Lub-dub pulse shape for x in [0,1).
function heartbeat(x) {
  const a = x / 0.055, b = (x - 0.2) / 0.07;
  return Math.exp(-a * a) + 0.6 * Math.exp(-b * b);
}

// Sky, height fog, mist, ash, lighting, pooled light sources, stealth light level and the whole
// post-processing chain. See ARCHITECTURE.md (Atmosphere) for the contract.
//
// Notes for other modules:
// - Fog is patched into three's fog chunks (see atmosphere-fog.js): any built-in material with
//   fog gets height fog whose colour matches the sky behind it. Tall things (the leviathan) thin
//   out of it naturally. Custom ShaderMaterials get the same by merging UniformsLib.fog and
//   including all four fog chunks; without the extra uniforms they fall back to plain FogExp2.
// - registerLightSource: `intensity` is a three.js PointLight intensity (candela, decay 2),
//   e.g. burning barrel ~30, street lamp ~60. The returned handle gains `level` (current
//   flicker x on/off, 0..1) for syncing emissive meshes. Only the 6 most relevant sources get
//   a real PointLight; the rest still count for lightLevelAt and should glow via emissives.
// - Extras beyond the contract: fogFactor(from, to), unregisterLightSource(handle),
//   setQuality(0..2) (?quality=N pins it), getDebugInfo().
export class Atmosphere {
  constructor(game) {
    installAtmosphereFog();
    this.game = game;
    const { scene, renderer, camera } = game;
    this.time = 0;
    this.lastDt = 1 / 60;
    this.threat = 0;
    this._threatSet = 0;
    this.death = 0;
    this.call = 0;
    this._callExt = 0;
    this._callExtAge = 99;
    this._callEvt = null; // { t, dur, released }
    this.churn = 0;
    this.footfall = 0;
    this._footfallAge = 99;
    this.beatPhase = 0;
    this.beat = 0;

    // --- fog (scene.fog.color *is* fogColor; mutated in place so references stay live)
    scene.fog = new THREE.FogExp2(LOOK.horizon.getHex(THREE.LinearSRGBColorSpace), LOOK.fogDensity);
    scene.fog.color.copy(LOOK.horizon);
    this.fogColor = scene.fog.color;
    this.skyGlowColor = LOOK.skyGlow.clone();
    this.fogHeightFalloff = LOOK.fogFalloff;
    this.fogFloor = LOOK.fogFloor;
    scene.background = this.fogColor;

    // --- lighting: red sky above, near-black street below, a weak low glow from the burning horizon
    this.hemi = new THREE.HemisphereLight(LOOK.hemiSky, LOOK.hemiGround, LOOK.hemiIntensity);
    this.hemi.name = 'atmosphere-hemi';
    this.sun = new THREE.DirectionalLight(LOOK.dirColor, LOOK.dirIntensity);
    this.sun.name = 'atmosphere-skyglow';
    this.sun.position.copy(LOOK.sunDir).multiplyScalar(100);
    scene.add(this.hemi, this.sun);

    // --- sky, lights, particles, post
    const noise = getNoiseTexture();
    this.noise = noise;
    this.sky = new Sky(noise, {
      horizon: this.fogColor,
      cloudLow: LOOK.cloudLow.clone(),
      cloudHigh: LOOK.cloudHigh.clone(),
      sunDir: LOOK.sunDir.clone(),
      sunColor: LOOK.sun.clone(),
    });
    scene.add(this.sky.mesh);

    this.lights = new LightPool(scene, 6);
    this.lightSources = this.lights.sources;
    this.lightPack = { pos: new Float32Array(18), col: new Float32Array(24) };
    this.particles = new Particles(scene, this.lightPack);

    this.mistColors = { low: LOOK.mistLow.clone(), high: LOOK.mistHigh.clone() };
    this.post = createPost({ renderer, scene, camera, noise, lights: this.lightPack, mistColors: this.mistColors });
    this.composer = this.post.composer;
    // Count every draw call of the frame (scene + post), not just the last pass.
    renderer.info.autoReset = false;
    this.drawingBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.writeFogUniforms(0);

    // --- quality: 2 = everything, 1 = no MSAA, 0 = also fewer mist steps, no wisps, no bloom.
    // ?quality=N pins it; otherwise it steps down if the game runs slowly for a few seconds.
    this.quality = 2;
    this._slowTime = 0;
    this._qualityCooldown = 8;
    const pinned = game.params?.get?.('quality');
    const automated = typeof navigator !== 'undefined' && navigator.webdriver;
    this.autoQuality = pinned == null && !automated;
    if (pinned != null) this.setQuality(Number(pinned));

    // --- the leviathan drives the call/footfall directly, but listen to its events too, so the
    // sky still answers if a caller only emits events.
    const bus = game.bus;
    bus?.on('leviathan:call:start', (e) => {
      this._callEvt = { t: 0, dur: e?.duration ?? CONFIG.leviathan.callDuration, released: false };
    });
    bus?.on('leviathan:call:end', () => {
      if (this._callEvt) this._callEvt.released = true;
    });
    bus?.on('leviathan:footfall', (e) => this.onFootfall(e?.intensity ?? 0.5));
    bus?.on('game:respawn', () => {
      this.death = 0;
    });
  }

  // ---------------------------------------------------------------- contract

  registerLightSource(src) {
    return this.lights.register(src);
  }

  unregisterLightSource(handle) {
    this.lights.unregister(handle);
  }

  lightLevelAt(pos) {
    return this.lights.levelAt(pos);
  }

  setThreat(v) {
    this._threatSet = clamp(Number(v) || 0, 0, 1);
  }

  setDeath(v) {
    this.death = clamp(Number(v) || 0, 0, 1);
  }

  onFootfall(intensity = 0.5) {
    const i = clamp(Number(intensity) || 0, 0, 1);
    if (i >= this.footfall * 0.8) this._footfallAge = 0;
    this.footfall = Math.max(this.footfall, i);
  }

  setCall(v) {
    this._callExt = clamp(Number(v) || 0, 0, 1);
    this._callExtAge = 0;
  }

  setQuality(level) {
    const q = clamp(Math.round(Number(level)), 0, 2);
    this.quality = Number.isFinite(q) ? q : 2;
    const pr = this.game.renderer.getPixelRatio();
    const maxSamples = this.game.renderer.capabilities.maxSamples || 0;
    this.post.scenePass.setSamples(this.quality >= 2 && pr < 1.25 ? Math.min(4, maxSamples) : 0);
    this.post.mistPass.setSteps(this.quality >= 1 ? 12 : 7);
    this.post.mistPass.wispsEnabled = this.quality >= 1;
    this.post.bloom.enabled = this.quality >= 1;
  }

  updateQuality(dt) {
    const game = this.game;
    if (!this.autoQuality || this.quality === 0 || game.state !== 'playing' || !Number.isFinite(game.fps)) return;
    this._qualityCooldown -= dt;
    if (this._qualityCooldown > 0) return;
    this._slowTime = game.fps < 38 ? this._slowTime + dt : Math.max(0, this._slowTime - dt * 2);
    if (this._slowTime > 4) {
      this.setQuality(this.quality - 1);
      this._slowTime = 0;
      this._qualityCooldown = 6;
    }
  }

  // Effective FogExp2-equivalent density for a horizontal view at eye height.
  get fogDensity() {
    return this.game.scene.fog.density * (this.fogFloor + (1 - this.fogFloor) * Math.exp(-this.fogHeightFalloff * EYE));
  }

  set fogDensity(v) {
    this.game.scene.fog.density = v / (this.fogFloor + (1 - this.fogFloor) * Math.exp(-this.fogHeightFalloff * EYE));
  }

  // Fog factor (0 clear .. 1 fully fogged) between two world points, matching the shaders.
  fogFactor(from, to) {
    return fogFactorBetween(this.game.scene.fog.density, this.fogHeightFalloff, this.fogFloor, from, to);
  }

  update(dt) {
    this.lastDt = dt;
    this.time += dt;
    this.updateQuality(dt);
    const t = this.time;
    const game = this.game;

    // --- threat (director wins if it reports more) + heartbeat
    const dirThreat = game.director?.threat;
    const threatTarget = Math.max(this._threatSet, Number.isFinite(dirThreat) ? clamp(dirThreat, 0, 1) : 0);
    this.threat = damp(this.threat, threatTarget, 5, dt);
    this.beatPhase = (this.beatPhase + dt * lerp(1.05, 2.2, this.threat)) % 1;
    this.beat = heartbeat(this.beatPhase);

    // --- the call: external envelope (fades if no longer refreshed) or our own from bus events
    this._callExtAge += dt;
    if (this._callExtAge > 0.4) this._callExt = Math.max(0, this._callExt - dt * 1.5);
    let evtEnv = 0;
    const ev = this._callEvt;
    if (ev) {
      ev.t += dt;
      if (ev.t > ev.dur) ev.released = true;
      if (!ev.released) evtEnv = smoothstep(0, 0.8, ev.t);
      else {
        ev.rel = (ev.rel ?? 0) + dt;
        evtEnv = smoothstep(0, 0.8, ev.t) * (1 - smoothstep(0, 1.4, ev.rel));
        if (ev.rel > 1.4) this._callEvt = null;
      }
    }
    this.call = damp(this.call, Math.max(this._callExt, evtEnv), 8, dt);
    const callThrob = 0.5 + 0.5 * Math.sin(t * 4.6);
    this.churn += dt * (1 + this.call * 9);

    // --- leviathan footfalls: mist puff, ash shake, a power stutter in the lamps
    this._footfallAge += dt;
    this.footfall = Math.max(0, this.footfall - dt * 0.8);
    const stutter = this.footfall * (1 - smoothstep(0.0, 0.55, this._footfallAge)) * (0.45 + 0.55 * noise1(t * 31, 4.2));
    this.lights.sag = stutter * 0.75 + this.call * 0.12 * (0.5 + 0.5 * Math.sin(t * 9.0));

    // --- light pool
    const cam = game.camera;
    cam.getWorldPosition(_v);
    cam.getWorldDirection(_fwd);
    this.lights.update(dt, t, _v, _fwd);
    this.lights.pack(this.lightPack.pos, this.lightPack.col);

    // --- fog, sky and lights swell together during the call so they stay matched
    const swell = 1 + this.call * (0.35 + 0.25 * callThrob);
    this.fogColor.copy(LOOK.horizon).multiplyScalar(swell);
    this.fogColor.r *= 1 + this.call * 0.2;
    this.skyGlowColor.copy(LOOK.skyGlow).multiplyScalar(swell);
    this.writeFogUniforms(this.call);
    this.hemi.intensity = LOOK.hemiIntensity * (1 + this.call * (0.5 + 0.35 * callThrob));
    this.sun.intensity = LOOK.dirIntensity * (1 + this.call * 0.6);

    const su = this.sky.uniforms;
    su.uTime.value = t;
    su.uChurn.value = this.churn;
    su.uCall.value = this.call;
    su.uPulse.value = callThrob;

    // --- particles + mist
    this.particles.update(t, this.footfall * this.footfall);
    const mist = this.post.mistPass;
    mist.marchUniforms.uTime.value = t;
    mist.marchUniforms.uPuff.value = this.footfall * (1 - smoothstep(0.2, 2.0, this._footfallAge) * 0.6);
    mist.marchUniforms.uCall.value = this.call;
    mist.wispUniforms.uTime.value = t;
    mist.wispUniforms.uShake.value = this.footfall * this.footfall;
    mist.wispUniforms.uCall.value = this.call;
    this.mistColors.low.copy(LOOK.mistLow).multiplyScalar(swell);
    this.mistColors.high.copy(LOOK.mistHigh).multiplyScalar(swell);

    // --- grade
    const gu = this.post.grade.uniforms;
    gu.uTime.value = t;
    gu.uThreat.value = this.threat;
    gu.uBeat.value = this.beat;
    gu.uDeath.value = this.death;
    gu.uCall.value = this.call;
  }

  writeFogUniforms(call) {
    const p = fogShared.params;
    p[0] = 1;
    p[1] = this.fogHeightFalloff;
    p[2] = this.fogFloor;
    p[3] = 0;
    const swell = 1 + call * 0.5;
    fogShared.zenith[0] = LOOK.zenith.r * swell;
    fogShared.zenith[1] = LOOK.zenith.g * swell;
    fogShared.zenith[2] = LOOK.zenith.b * swell;
    fogShared.mid[0] = LOOK.mid.r * swell * (1 + call * 0.4);
    fogShared.mid[1] = LOOK.mid.g * swell;
    fogShared.mid[2] = LOOK.mid.b * swell;
    fogShared.glow[0] = LOOK.glowDir.x;
    fogShared.glow[1] = 0;
    fogShared.glow[2] = LOOK.glowDir.z;
    fogShared.glow[3] = LOOK.glowStrength;
  }

  resize(w, h) {
    const r = this.game.renderer;
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(w, h);
    r.getDrawingBufferSize(this.drawingBuffer);
    this.post.grade.uniforms.uRes.value.copy(this.drawingBuffer);
  }

  render() {
    const { renderer, camera } = this.game;
    renderer.info.reset();
    camera.updateMatrixWorld();
    renderer.getDrawingBufferSize(this.drawingBuffer);
    this.post.grade.uniforms.uRes.value.copy(this.drawingBuffer);
    this.sky.follow(camera);
    this.particles.prepare(camera, this.drawingBuffer.y);
    this.composer.render(this.lastDt);
  }

  // Debug/test helper: what the frame cost and which sources hold the real lights.
  getDebugInfo() {
    const info = this.game.renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      sceneCalls: this.post.scenePass.info.calls,
      sceneTriangles: this.post.scenePass.info.triangles,
      sources: this.lights.records.length,
      pooled: this.lights.slots.map((s) => (s.rec ? { weight: +s.rec.weight.toFixed(2), intensity: +s.light.intensity.toFixed(2) } : null)),
      threat: this.threat,
      call: this.call,
      death: this.death,
      fogDensity: this.fogDensity,
      quality: this.quality,
    };
  }
}
