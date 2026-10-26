import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { makeRng, noise1, clamp } from '../core/math.js';
import { Batch, mat } from './level-batch.js';
import { createLevelTextures, decalUV, graffitiUV } from './textures.js';
import { createLevelMaterials } from './level-materials.js';
import { GlowSprites, Flames, Smoke } from './level-fx.js';
import { buildCity } from './level-layout.js';
import { cylX } from './props.js';

const ALARM_DURATION = 14;
const ALARM_REARM = 6; // seconds after an alarm stops before the car can be set off again
const ALARM_NEAR = 2.0; // a bottle smashing this close to the car (footprint, metres) sets it off
const GATE_SWING = 1.75; // radians the gate leaves swing open
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

const inRect = (p, r) => p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;

// Construction helpers handed to props.js / buildings.js / level-layout.js.
class Builder {
  constructor(level) {
    this.level = level;
    this.game = level.game;
    this.world = level.game.world;
    this.rng = makeRng(20261025);
    const lit = { aLit: 2 };
    // Heavy materials (facades, concrete, metal, paint) are sliced every 90 m so the slices behind
    // the camera cull; light ones are merged whole (a draw call costs more than their vertices).
    const whole = Object.fromEntries(['chain', 'store', 'storeLit', 'storeGlow', 'shopsigns', 'decal', 'puddle', 'emissive', 'glass',
      'graffiti', 'road', 'paving', 'pavers', 'grass', 'water', 'signs', 'asphalt'].map((k) => [k, Infinity]));
    this.batch = new Batch({
      chunkSize: 90,
      chunkSizes: { ...whole, skyline: 400 },
      extras: { facade_brick: lit, facade_concrete: lit, facade_stone: lit },
    });
    this.glow = new GlowSprites();
    this.flames = new Flames();
    this.smoke = new Smoke();
    this.blinkers = level.blinkers;
    this.wires = [];
    this.shopSign = 0; // next shop name in the sign atlas
  }

  solid(x, z, w, d, h, rot = 0, opts = {}) {
    return this.world.addBox({ x, z, w, d, h, rot, ...opts });
  }

  // Register a gameplay light with the atmosphere (+ an optional halo sprite). Lights with
  // selfFlicker are driven by the level so the bulb, halo and light stay in sync.
  light(o) {
    const pos = new THREE.Vector3(o.pos.x, o.pos.y, o.pos.z);
    const enabled = o.enabled ?? true;
    const handle = this.game.atmosphere.registerLightSource({
      pos,
      color: o.color,
      intensity: o.intensity,
      distance: o.distance ?? 14,
      flicker: o.selfFlicker ? 0 : o.flicker ?? 0,
      stealthRadius: o.stealthRadius ?? 6,
      stealthWeight: o.stealthWeight ?? 0.8,
      enabled,
    });
    const L = {
      handle,
      pos,
      base: o.intensity,
      glow: o.halo ? this.glow.add(pos, o.color, o.halo.size, enabled ? o.halo.intensity : 0) : -1,
      haloBase: o.halo?.intensity ?? 0,
      seed: this.rng() * 100,
      self: !!o.selfFlicker,
      style: o.flickerStyle || 'dying',
      onFlicker: o.onFlicker || null,
    };
    if (L.self) this.level.flickers.push(L);
    this.level.lights.push(L);
    return L;
  }

  fire(pos, scale = 1, lightOpts = {}) {
    this.flames.add(pos, scale, this.rng() * 100);
    this.smoke.add(new THREE.Vector3(pos.x, pos.y, pos.z), scale * 0.9, 6);
    if (lightOpts === false) return null;
    return this.light({
      pos: { x: pos.x, y: pos.y + 0.8 * scale + 0.4, z: pos.z },
      color: 0xff7a32,
      intensity: 38 * scale + 10,
      distance: 10 + 5 * scale,
      flicker: 0.45,
      stealthRadius: 4.5 * scale + 1.5,
      stealthWeight: 0.85,
      ...lightOpts,
    });
  }

  decal(name, x, z, w, d, yaw = 0, y = 0.03) {
    this.batch.flat('decal', x, y, z, w, d, yaw, decalUV(name));
  }

  puddle(x, z, w, d, yaw = 0, y = 0.035) {
    const name = this.rng.pick(['puddle1', 'puddle2', 'puddle3']);
    this.batch.flat('puddle', x, y, z, w, d, yaw, decalUV(name), new THREE.Color(0x0a0809));
  }

  // Sagging wire between two points (rendered as one LineSegments for the whole level).
  wire(a, b, sag = 0.8, segs = 8) {
    let prev = a;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const p = new THREE.Vector3().lerpVectors(a, b, t);
      p.y -= Math.sin(Math.PI * t) * sag;
      this.wires.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
    }
  }

  // Spray-painted wall text. (x, y, z) = bottom centre on the wall, yaw = direction it faces.
  graffiti(slot, x, y, z, yaw, w, h, message = null, opts = {}) {
    const nx = -Math.sin(yaw), nz = -Math.cos(yaw);
    this.batch.wall('graffiti', x + nx * 0.04, y, z + nz * 0.04, w, h, yaw, graffitiUV(slot), opts.color);
    if (message) {
      this.level.graffiti.push({
        pos: new THREE.Vector3(x + nx * 0.25, y + h / 2, z + nz * 0.25),
        nx, nz, message, range: opts.range ?? 9, duration: opts.duration ?? 6, shown: false,
      });
    }
  }
}

// The city: static scenery, colliders, light sources and the dynamic gameplay bits (pickups,
// alarm cars, the gate, triggers). See ARCHITECTURE.md (Level) and DESIGN.md (route).
export class Level {
  constructor(game) {
    this.game = game;
    this.bounds = { minX: -50, maxX: 34, minZ: -450, maxZ: 12 };
    this.checkpoints = [];
    this.zones = [];
    this.currentZone = 0; // always a valid index (readable on the title screen too)
    this._announcedZone = -1; // last zone we emitted zone:enter for
    this.enemies = [];
    this.interactables = [];
    this.leviathanRoute = [];
    this.titleCamera = { pos: [-3, 1.7, -28], target: [16, 18, -110] };
    this.lights = [];
    this.flickers = [];
    this.blinkers = [];
    this.graffiti = [];
    this.pickups = [];
    this.alarms = [];
    this.gate = null;
    this.reached = new Set();
    this.exited = false;
    this.exitZ = -430;
    this.time = 0;
    this.buildMs = 0;
    this._fxFrame = -1;
  }

  build() {
    const t0 = performance.now();
    const game = this.game;
    const textures = createLevelTextures();
    this.textures = textures;
    this.materials = createLevelMaterials(textures);
    const B = new Builder(this);
    this.builder = B;
    const data = buildCity(B);
    this.layout = data;
    this.bounds = data.bounds;
    this.zones = data.zones;
    this.checkpoints = data.checkpoints;
    this.enemies = data.enemies;
    this.leviathanRoute = data.leviathanRoute;
    this.titleCamera = data.titleCamera;
    this.exitZ = data.exitZ ?? this.exitZ;
    this.routeRects = data.routeRects;

    this.root = new THREE.Group();
    this.root.name = 'level';
    // Dynamic bits first: they add glow sprites, which must exist before the glow mesh is built.
    this.buildPickups(data.pickups || []);
    for (const a of data.alarms || []) this.addAlarm(a);
    if (data.gate) this.buildGate(data.gate);
    const tMesh = performance.now();
    this.triangles = B.batch.triangles;
    this.root.add(B.batch.build(this.materials));
    this.mergeMs = performance.now() - tMesh;
    this.glowMesh = B.glow.build();
    this.root.add(this.glowMesh);
    this.flames = B.flames;
    this.root.add(B.flames.build());
    this.smoke = B.smoke;
    this.root.add(B.smoke.build());
    if (B.wires.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.wires, 3));
      const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x050303 }));
      lines.name = 'level-wires';
      this.root.add(lines);
    }
    game.scene.add(this.root);

    // Per-frame visual upkeep (flicker, shader time, fog uniforms) runs from the glow mesh's
    // onBeforeRender so it also animates on the title screen, when update() is not called.
    this.glowMesh.onBeforeRender = (renderer) => this.fxTick(renderer.info.render.frame);

    game.bus.on('bottle:shatter', (e) => this.onShatter(e));
    game.bus.on('game:checkpoint', () => {
      for (const p of this.pickups) if (p.taken) p.committed = true;
    });
    this.buildMs = performance.now() - t0;
  }

  // --- queries -------------------------------------------------------------------------------

  zoneAt(pos) {
    for (let i = 0; i < this.zones.length; i++) if (inRect(pos, this.zones[i].bounds)) return i;
    return -1;
  }

  // --- pickups ---------------------------------------------------------------------------------

  buildPickups(list) {
    if (!list.length) return;
    const proto = this.game.projectiles.createBottleMesh();
    this.bottleMesh = new THREE.InstancedMesh(proto.geometry, proto.material, list.length);
    this.bottleMesh.name = 'level-bottles';
    list.forEach((p, i) => {
      const yaw = this.builder.rng() * Math.PI * 2;
      const pk = {
        index: i,
        zone: p.zone,
        pos: new THREE.Vector3(p.x, 0.04, p.z),
        matrix: mat(p.x, 0.04, p.z, yaw, 0, Math.PI / 2),
        taken: false,
        committed: false,
        glow: this.builder.glow.add(new THREE.Vector3(p.x, 0.12, p.z), 0xbfe8d8, 0.16, 0.8),
      };
      this.bottleMesh.setMatrixAt(i, pk.matrix);
      pk.interactable = {
        id: `bottle_${i}`,
        pos: new THREE.Vector3(p.x, 0.15, p.z),
        range: 2.0,
        prompt: 'pick up bottle',
        enabled: true,
        onInteract: () => this.takeBottle(pk),
      };
      this.interactables.push(pk.interactable);
      this.pickups.push(pk);
    });
    this.bottleMesh.instanceMatrix.needsUpdate = true;
    this.bottleMesh.computeBoundingSphere();
    this.root.add(this.bottleMesh);
  }

  takeBottle(pk) {
    const game = this.game;
    const player = game.player;
    if (pk.taken) return;
    if (player.bottles >= CONFIG.player.maxBottles) {
      game.bus.emit('level:message', { text: `You can't carry more than ${CONFIG.player.maxBottles} bottles.`, duration: 2.5 });
      return;
    }
    player.bottles++;
    this.setPickup(pk, true);
    game.bus.emit('player:pickup', { type: 'bottle', count: player.bottles });
  }

  setPickup(pk, taken) {
    pk.taken = taken;
    if (!taken) pk.committed = false;
    pk.interactable.enabled = !taken;
    this.bottleMesh.setMatrixAt(pk.index, taken ? new THREE.Matrix4().makeScale(0, 0, 0) : pk.matrix);
    this.bottleMesh.instanceMatrix.needsUpdate = true;
    this.builder.glow.set(pk.glow, taken ? 0 : 0.8);
  }

  // --- alarm cars ------------------------------------------------------------------------------

  addAlarm({ id, car, zone }) {
    const B = this.builder;
    const a = {
      id,
      zone,
      collider: car.collider,
      pos: new THREE.Vector3(car.collider.cx, 0.8, car.collider.cz),
      led: B.glow.add(car.led, 0xff1a0a, 0.12, 0),
      hazards: car.hazards.map((p) => B.glow.add(p, 0xffa030, 0.35, 0)),
      light: B.light({ pos: { x: car.collider.cx, y: 1.2, z: car.collider.cz }, color: 0xff9a2a, intensity: 30, distance: 10, stealthRadius: 4, stealthWeight: 0.6, enabled: false }),
      armed: true,
      active: false,
      t: 0,
      noiseT: 0,
      rearmT: 0,
    };
    this.alarms.push(a);
  }

  // Distance from a point to a collider's footprint (XZ).
  static distToCollider(p, c) {
    const dx = p.x - c.cx, dz = p.z - c.cz;
    const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz;
    const ox = Math.max(0, Math.abs(lx) - c.hx), oz = Math.max(0, Math.abs(lz) - c.hz);
    return Math.hypot(ox, oz);
  }

  onShatter({ pos, collider }) {
    for (const a of this.alarms) {
      if (!a.armed || a.active) continue;
      const hit = collider?.data?.alarmCar === a.id || (pos && pos.y < a.collider.maxY + 1 && Level.distToCollider(pos, a.collider) <= ALARM_NEAR);
      if (hit) this.startAlarm(a);
    }
  }

  startAlarm(a) {
    a.active = true;
    a.t = 0;
    a.noiseT = 0;
    this.game.bus.emit('alarm:start', { id: a.id, pos: a.pos.clone(), duration: ALARM_DURATION });
  }

  // rearm = true re-arms at once (respawn); otherwise the alarm resets itself after a short
  // pause and its LED starts blinking again, so a failed attempt can be retried with another bottle.
  stopAlarm(a, rearm) {
    const was = a.active;
    a.active = false;
    a.armed = rearm;
    a.rearmT = rearm ? 0 : ALARM_REARM;
    a.light.handle.enabled = false;
    for (const h of a.hazards) this.builder.glow.set(h, 0);
    this.builder.glow.set(a.led, 0);
    if (was) this.game.bus.emit('alarm:end', { id: a.id, pos: a.pos.clone() });
  }

  updateAlarms(dt) {
    const glow = this.builder.glow;
    for (const a of this.alarms) {
      if (a.active) {
        a.t += dt;
        a.noiseT -= dt;
        if (a.noiseT <= 0) {
          a.noiseT = 1;
          this.game.bus.emit('noise', { pos: a.pos.clone(), radius: CONFIG.noise.alarm, loudness: 1, source: 'alarm' });
        }
        const on = a.t % 0.7 < 0.38;
        for (const h of a.hazards) glow.set(h, on ? 2.6 : 0);
        a.light.handle.enabled = on;
        glow.set(a.led, on ? 2 : 0.4);
        if (a.t >= ALARM_DURATION) this.stopAlarm(a, false);
      } else if (a.armed) {
        // The tell: a small red LED on the dash, blinking slowly.
        glow.set(a.led, (this.time + a.id.length * 0.37) % 1.3 < 0.16 ? 2.2 : 0.25);
      } else if (a.rearmT > 0) {
        a.rearmT -= dt;
        if (a.rearmT <= 0) a.armed = true;
      }
    }
  }

  // --- the gate --------------------------------------------------------------------------------

  buildGate(spec) {
    const { x, z, halfWidth = 3, h = 2.5 } = spec;
    const m = this.materials;
    const leaves = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(x + side * halfWidth, 0, z);
      const leaf = new THREE.Group();
      // frame + mesh, extending from the hinge towards the centre
      const len = halfWidth - 0.05;
      const cx = -side * len / 2;
      const b = new Batch({ chunkSize: 1e6 });
      b.box('metal', mat(cx, 0.08, 0), len, 0.06, 0.06, new THREE.Color(0x6d7074));
      b.box('metal', mat(cx, h - 0.06, 0), len, 0.06, 0.06, new THREE.Color(0x6d7074));
      b.box('metal', mat(-side * len, 0.05, 0), 0.07, h, 0.07, new THREE.Color(0x6d7074));
      b.box('metal', mat(0, 0, 0), 0.08, h + 0.1, 0.08, new THREE.Color(0x6d7074));
      b.box('metal', mat(cx, h * 0.5, 0), len, 0.05, 0.05, new THREE.Color(0x6d7074));
      b.quad('chain', [{ x: 0, y: 0.1, z: 0 }, { x: -side * len, y: 0.1, z: 0 }, { x: -side * len, y: h - 0.05, z: 0 }, { x: 0, y: h - 0.05, z: 0 }],
        [0, 0, len / 0.6, 0, len / 0.6, h / 0.6, 0, h / 0.6], new THREE.Color(0x8a8c90));
      leaf.add(b.build(m, { name: 'gate-leaf' }));
      pivot.add(leaf);
      pivot.userData.side = side;
      this.root.add(pivot);
      leaves.push(pivot);
    }
    // chain + padlock wrapped around the meeting posts
    const cb = new Batch({ chunkSize: 1e6 });
    for (let k = 0; k < 7; k++) {
      cb.geom('metal', cylX(0.035, 0.24, 6), mat(x, 1.05 + k * 0.07, z, 0.35 * (k % 2 ? 1 : -1), 0, 0.35), new THREE.Color(0x9a9890));
    }
    cb.box('metal', mat(x, 0.82, z - 0.06), 0.12, 0.16, 0.05, new THREE.Color(0x8a7a40));
    const chain = cb.build(m, { name: 'gate-chain' });
    this.root.add(chain);
    const collider = this.game.world.addBox({ x, z, w: halfWidth * 2 + 0.2, d: 0.3, h, blocksSight: false, tag: 'gate', data: { gate: spec.id || 'gate' } });
    // The swung-open leaves are solid too (enabled once the gate opens), so nobody walks through them.
    const len = halfWidth - 0.05;
    const openLeaves = leaves.map((p) => {
      const rot = -p.userData.side * GATE_SWING;
      const cx = -p.userData.side * len / 2;
      const c = this.game.world.addBox({
        x: p.position.x + Math.cos(rot) * cx, z: p.position.z - Math.sin(rot) * cx, w: len, d: 0.12, h, rot,
        blocksSight: false, tag: 'gate-leaf',
      });
      this.game.world.setEnabled(c, false);
      return c;
    });
    const gate = {
      id: spec.id || 'gate',
      pos: new THREE.Vector3(x, 1, z),
      leaves,
      chain,
      collider,
      openLeaves,
      open: false,
      anim: 0,
      wasHolding: false,
      noiseT: 0,
      order: spec.order ?? 4.5,
      rect: { minX: x - halfWidth - 0.6, maxX: x + halfWidth + 0.6, minZ: z - halfWidth - 0.4, maxZ: z + 0.6 },
    };
    gate.interactable = {
      id: 'gate',
      pos: new THREE.Vector3(x, 1.1, z + 0.35),
      range: 2.4,
      prompt: 'cut the chain',
      holdTime: 3,
      enabled: true,
      onHoldStart: () => this.gateNoise(0.75),
      onHoldCancel: () => {
        gate.wasHolding = false;
      },
      onInteract: () => this.openGate(),
    };
    this.interactables.push(gate.interactable);
    this.gate = gate;
  }

  gateNoise(loudness, radius = 22) {
    const g = this.gate;
    g.noiseT = 1;
    g.wasHolding = true;
    this.game.bus.emit('noise', { pos: g.pos.clone(), radius, loudness, source: 'gate' });
  }

  openGate() {
    const g = this.gate;
    if (!g || g.open) return;
    g.open = true;
    g.wasHolding = false;
    g.interactable.enabled = false;
    g.chain.visible = false;
    this.game.world.setEnabled(g.collider, false);
    for (const c of g.openLeaves) this.game.world.setEnabled(c, true);
    this.game.nav?.rebuildArea(g.rect.minX, g.rect.minZ, g.rect.maxX, g.rect.maxZ);
    this.game.player?.addShake?.(0.12);
    this.game.bus.emit('gate:open', { id: g.id, pos: g.pos.clone() });
    this.game.bus.emit('noise', { pos: g.pos.clone(), radius: 30, loudness: 1, source: 'gate' });
  }

  closeGate() {
    const g = this.gate;
    if (!g) return;
    g.wasHolding = false;
    g.noiseT = 0;
    if (!g.open) return;
    g.open = false;
    g.anim = 0;
    g.interactable.enabled = true;
    g.chain.visible = true;
    for (const p of g.leaves) p.rotation.y = 0;
    this.game.world.setEnabled(g.collider, true);
    for (const c of g.openLeaves) this.game.world.setEnabled(c, false);
    this.game.nav?.rebuildArea(g.rect.minX, g.rect.minZ, g.rect.maxX, g.rect.maxZ);
  }

  updateGate(dt) {
    const g = this.gate;
    if (!g) return;
    const player = this.game.player;
    const holding = !g.open && player.focus === g.interactable && player.holdProgress > 0;
    if (holding) {
      if (!g.wasHolding) this.gateNoise(0.75);
      g.noiseT -= dt;
      if (g.noiseT <= 0) this.gateNoise(0.75);
    } else {
      g.wasHolding = false;
    }
    if (g.open && g.anim < 1) {
      g.anim = Math.min(1, g.anim + dt / 1.8);
      const e = 1 - Math.pow(1 - g.anim, 3);
      // Swing away from the player (towards -Z) with a little bounce at the end.
      for (const p of g.leaves) p.rotation.y = -p.userData.side * (GATE_SWING * e - Math.sin(e * Math.PI) * 0.08);
    }
  }

  // --- per-frame -------------------------------------------------------------------------------

  update(dt) {
    const game = this.game;
    this.time += dt;
    const p = game.player.position;
    const zi = this.zoneAt(p);
    if (zi >= 0) {
      this.currentZone = zi;
      if (zi !== this._announcedZone) {
        this._announcedZone = zi;
        game.bus.emit('zone:enter', { index: zi, zone: this.zones[zi] });
      }
    }
    // A checkpoint saves when you cross into its area -- but not while something is chasing you
    // (a call only pauses a chase): then it saves as soon as you shake them off anywhere beyond
    // its line (north of the area's south edge, in its zone or later). Dragging a pack across the
    // line doesn't bank progress.
    const hunted = (game.director?.hunting ?? game.director?.chasing ?? 0) > 0;
    for (const cp of this.checkpoints) {
      if (this.reached.has(cp.id) || !cp.area || hunted) continue;
      const past = p.z < cp.area.maxZ && zi >= (cp.zone ?? 0);
      if (inRect(p, cp.area) || past) {
        this.reached.add(cp.id);
        game.bus.emit('level:checkpoint', { checkpoint: cp });
      }
    }
    if (!this.exited && p.z < this.exitZ) {
      this.exited = true;
      game.bus.emit('level:exit', {});
    }
    this.updateAlarms(dt);
    this.updateGate(dt);
    this.updateGraffiti();
    for (const pk of this.pickups) {
      if (!pk.taken) this.builder.glow.set(pk.glow, 0.45 + 0.4 * Math.max(0, Math.sin(this.time * 2.2 + pk.index * 1.7)));
    }
  }

  updateGraffiti() {
    const player = this.game.player;
    const p = player.position;
    const fwd = player.forward(_w);
    const fl = Math.hypot(fwd.x, fwd.z) || 1;
    for (const g of this.graffiti) {
      if (g.shown) continue;
      const dx = g.pos.x - p.x, dz = g.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > g.range || d < 0.01) continue;
      if (dx * g.nx + dz * g.nz > 0) continue; // behind the wall
      if ((dx * fwd.x + dz * fwd.z) / (d * fl) < 0.6) continue; // not looking at it
      if (this.game.world.segmentBlocked(player.getEyePos(_v), g.pos)) continue;
      g.shown = true;
      this.game.bus.emit('level:message', { text: g.message, duration: g.duration });
      break;
    }
  }

  // Visual upkeep, once per rendered frame.
  fxTick(frame) {
    if (frame === this._fxFrame) return;
    this._fxFrame = frame;
    const game = this.game;
    const t = game.time;
    const atm = game.atmosphere;
    const density = atm?.fogDensity ?? game.scene.fog?.density ?? 0.012;
    const fogColor = atm?.fogColor ?? game.scene.fog?.color;
    this.builder.glow.uniforms.uFogDensity.value = density;
    this.flames.uniforms.uTime.value = t;
    this.flames.uniforms.uFogDensity.value = density;
    this.smoke.uniforms.uTime.value = t;
    this.smoke.uniforms.uFogDensity.value = density;
    if (fogColor) this.smoke.uniforms.uFogColor.value.copy(fogColor);
    const sky = this.materials.skyline.uniforms;
    sky.uDensity.value = density;
    if (fogColor) sky.uFogColor.value.copy(fogColor);
    for (const L of this.flickers) {
      const f = flickerValue(L.style, t, L.seed);
      L.handle.intensity = L.base * f;
      if (L.glow >= 0) this.builder.glow.set(L.glow, L.haloBase * f);
      L.onFlicker?.(f);
    }
    for (const b of this.blinkers) {
      this.builder.glow.set(b.glow, (t % b.period) / b.period < b.duty ? b.intensity : 0);
    }
  }

  resetDynamic(checkpoint) {
    if (checkpoint?.pos) this.currentZone = Math.max(0, this.zoneAt(checkpoint.pos));
    for (const a of this.alarms) this.stopAlarm(a, true);
    const order = checkpoint?.order ?? 0;
    if (this.gate && !(order > this.gate.order)) this.closeGate();
    for (const pk of this.pickups) if (pk.taken && !pk.committed) this.setPickup(pk, false);
    this.exited = false;
  }
}

// Flicker curves: 'dying' = mostly on with stuttering drop-outs, 'buzz' = steady with a hum,
// 'failing' = mostly off with brief struggling flashes.
function flickerValue(style, t, seed) {
  if (style === 'buzz') return 0.85 + 0.15 * noise1(t * 30, seed);
  if (style === 'failing') {
    const n = noise1(t * 2.3, seed);
    return n > 0.62 ? 0.4 + 0.6 * noise1(t * 40, seed + 3) : 0.03;
  }
  const n = noise1(t * 1.7, seed);
  if (n < 0.28) return noise1(t * 35, seed + 1) > 0.5 ? 0.9 : 0.05;
  return clamp(0.8 + 0.2 * noise1(t * 20, seed + 2), 0, 1);
}

