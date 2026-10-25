# Architecture & module contracts

Browser game, Three.js **0.170.0** (`import * as THREE from 'three'`, addons via
`three/examples/jsm/...`), bundled by esbuild into **one self-contained `dist/index.html`**
(no network requests at runtime, no asset files — every mesh, texture and sound is procedural).

```
npm run build          # -> dist/index.html
npm run smoke          # headless boot + screenshot + console errors (tools/smoke.mjs)
node build.mjs --entry tools/sandbox/foo.js --out dist/sandbox-foo.html   # bundle a sandbox page
```

`tools/harness.mjs` exports `launch({ html, query })` -> `{ page, errors, shot(file), cam(pos, target), eval(fn) }`
for headless Chromium (SwiftShader WebGL, ~slow but works). Use it to screenshot and to drive
scenario tests through `window.__game`.

## Conventions

- Units are metres and seconds. Ground is the plane **y = 0** everywhere (flat world).
- **North is −Z.** The route runs from z ≈ 0 (start) to z ≈ −430 (exit). x is east.
- **Yaw**: rotation about +Y. `yaw = 0` faces −Z; forward = `(-sin(yaw), 0, -cos(yaw))`.
  Helpers: `yawToDir`, `dirToYaw`, `angleDiff`, `stepAngle`, `dampAngle` in `src/core/math.js`.
- **Models face −Z** in local space so `object.rotation.y = yaw` points them along `yawToDir(yaw)`.
- Randomness that affects layout must be seeded (`makeRng(seed)` from `core/math.js`) so the
  level is identical every load. Gameplay randomness (AI idle choices) may use `Math.random()`.
- Modules talk through **`game.bus`** events (below) or the documented fields — never reach into
  another module's private state. Do not edit files you don't own; if you need something from
  another module, use the contract and note the request in your final report.
- Style: ES modules, 2-space indent, single quotes, semicolons, classes with short doc comments.
  No TypeScript. No new npm dependencies.

## The `game` object (src/game.js — owned by the integrator)

| Field | Type | Notes |
|---|---|---|
| `scene`, `camera`, `renderer` | three.js | camera is a child of scene (attach view-model objects to it) |
| `bus` | `EventBus` | `on(type, fn) -> unsubscribe`, `emit(type, payload)` |
| `input` | `Input` | `down(code)`, `pressed(code)`, `mouseDown(b)`, `mousePressed(b)`, `locked`, `pointerLockFailed` |
| `world` | `CollisionWorld` | `addBox({x,z,w,d,h,y,rot,blocksMove,blocksSight,tag,data})`, `resolveCircle`, `segmentBlocked`, `raycast`, `query`, `setEnabled`, `pointBlocked` |
| `nav` | `NavGrid` | built **after** `level.build()`; `findPath`, `isWalkable`, `nearestWalkable`, `lineWalkable`, `randomPointNear`, `sameRegion`, `rebuildArea` |
| `player` | `Player` | `position` (feet), `yaw`, `pitch`, `velocity`, `speed`, `mode` (`idle/crouch/walk/sprint`), `crouched`, `sprinting`, `stamina`, `exhausted`, `lightLevel`, `bottles`, `eyeHeight`, `focus` (interactable), `holdProgress`, `getEyePos(out)`, `getChestPos(out)`, `forward(out)`, `addShake(0..1)` |
| `projectiles` | `Projectiles` | `throwBottle(origin, vel)`, `createBottleMesh()` (reuse for pickups) |
| `atmosphere` | `Atmosphere` | see below |
| `level` | `Level` | see below |
| `leviathan` | `Leviathan` | see below |
| `director` | `Director` | see below |
| `audio` | `AudioEngine` | see below |
| `hud` | `Hud` | see below |
| `state` | string | `title`, `intro`, `playing`, `paused`, `caught`, `dead`, `won` |
| `stateTime` | number | seconds since entering the state |
| `time` | number | simulated seconds (advances in playing/caught/won and title/intro) |
| `noiseMask` | 0..1 | written by the leviathan each frame; player noise radius × (1 − 0.75·mask) |
| `settings` | `{sensitivity, volume, fov}` | persisted via `game.saveSettings()` |
| `stats` | `{spotted, deaths, playTime}` | |
| `checkpoint` | checkpoint object | current respawn point |
| `debug`, `god` | bool | URL `?debug`, `?god` |
| `begin()`, `startPlaying()`, `pause()`, `resume()`, `respawn()` | | called by the HUD from user gestures |
| `simulate(seconds, step)` | | headless: tick without rendering |
| `teleport(x, z, yaw)`, `debugCamera` | | test helpers |

URL params: `autostart` (skip title), `cp=N` (start at checkpoint N), `god`, `debug`, `mute`.

**Frame order (playing):** `player.update → level.update → leviathan.update → director.update →
projectiles.update → atmosphere.update → audio.update → hud.update → render (atmosphere.render())`.
In `title`/`intro` only `leviathan.update`, `atmosphere`, `audio`, `hud` run. In `caught`, the world
keeps simulating while the game turns the camera toward `caughtBy.getHeadPos()` and ramps
`atmosphere.setDeath(0..1)`, then switches to `dead`.

**Construction order:** `input, world, projectiles, audio, atmosphere, level (+level.build()), nav
(+build), player, leviathan, director, hud`. Then the game spawns the player at the checkpoint and
calls `level.resetDynamic(cp)` and `director.reset()`.

## Event catalogue (`game.bus`)

| Event | Payload | Emitted by |
|---|---|---|
| `noise` | `{pos: Vector3, radius, loudness 0..1, source: 'player'\|'bottle'\|'alarm'\|'gate'\|'other'}` | player, projectiles, level |
| `player:footstep` | `{mode, pos}` | player |
| `player:breath` | `{pos}` (exhausted panting) | player |
| `player:exhausted` | `{}` | player |
| `player:throw` / `player:throw-empty` | `{pos}` / `{}` | player |
| `player:pickup` | `{type:'bottle', count}` | level |
| `bottle:shatter` | `{pos, collider}` | projectiles (level checks `collider.data?.alarmCar`) |
| `alarm:start` / `alarm:end` | `{id, pos, duration}` / `{id, pos}` | level |
| `leviathan:footfall` | `{pos: Vector3, intensity 0..1 (at player)}` | leviathan |
| `leviathan:call:start` / `leviathan:call:end` | `{pos, duration}` / `{pos}` | leviathan |
| `enemy:suspicious` | `{enemy, pos}` (first notices something) | director/snatcher |
| `enemy:alert` | `{enemy, pos}` (spotted player, starts chase, shrieks) | director/snatcher |
| `enemy:lost` | `{enemy}` (chase → search) | director/snatcher |
| `enemy:giveup` | `{enemy}` (search → return) | director/snatcher |
| `enemy:step` | `{enemy, pos, chasing}` (footstep, for audio) | snatcher |
| `player:caught` | `{enemy}` | director |
| `zone:enter` | `{index, zone}` | level |
| `level:checkpoint` | `{checkpoint}` | level |
| `level:exit` | `{}` | level |
| `level:message` | `{text, duration}` (graffiti read, hint) | level |
| `gate:open` | `{id, pos}` | level |
| `game:state` | `{state, prev}` | game |
| `game:checkpoint` / `game:respawn` / `game:won` | `{checkpoint}` / `{checkpoint}` / `{stats}` | game |

---

## Module contracts

### Level — `src/world/level.js` (+ `props.js`, `buildings.js`, `textures.js` as you like)

```js
class Level {
  constructor(game)
  build()                       // add meshes to scene, colliders to world, light sources to atmosphere
  bounds                        // {minX, maxX, minZ, maxZ}: nav grid extent, must enclose all walkable space
  checkpoints                   // [{id, order, pos:{x,z}, yaw, bottles?, zone, area:{minX,maxX,minZ,maxZ}}], [0] = start
  zones                         // [{id, index, name, bounds:{minX,maxX,minZ,maxZ}, objective?, hint?,
                                //   leviathan:{anchor:{x,z}, calls:'calm'|'near'}}]
  currentZone                   // index of zone containing the player
  enemies                       // spawn defs (see Director)
  interactables                 // [{id, pos: Vector3, range?, prompt, holdTime?, enabled,
                                //   onInteract(game), onHoldStart?(game), onHoldCancel?(game)}]
  leviathanRoute                // [{x, z}, ...] polyline (ground coords) the leviathan walks along, start → exit
  titleCamera                   // {pos:[x,y,z], target:[x,y,z]} — a beautiful establishing shot
  zoneAt(pos) -> index | -1
  update(dt)                    // triggers: zone:enter, level:checkpoint, level:exit; pickups; alarms; flicker
  resetDynamic(checkpoint)      // respawn: re-arm alarms, close gates not committed, restore pickups taken
                                //   since the last checkpoint, clear transient state
}
```
- Must enclose the playable route with colliders so the player can't leave it (buildings, rubble,
  barricades, fences). Everything the player can see but not reach still needs to look good.
- **Light sources** are registered with `game.atmosphere.registerLightSource({...})` (see
  Atmosphere); the level never creates `PointLight`s directly except via that API.
- **Alarm cars:** car collider gets `data: { alarmCar: id }`; on `bottle:shatter` with that
  collider (or within 1.5 m of the car) start the alarm: `alarm:start`, then emit `noise`
  `{radius: CONFIG.noise.alarm, source:'alarm'}` every ~1 s for its duration, blink hazard lights.
- **Pickups:** bottles as interactables ("E — pick up bottle"), respect `CONFIG.player.maxBottles`,
  emit `player:pickup`. A faint glint so they can be spotted.
- **Messages:** graffiti is rendered as wall textures (CanvasTexture); when the player first looks
  at / walks near a graffiti hint, emit `level:message`.
- Use `InstancedMesh` / merged geometry for repeated things; target < 250 draw calls total.

### Atmosphere — `src/world/atmosphere.js`

```js
class Atmosphere {
  constructor(game)             // sky, fog, ambient/hemisphere light, mist, ash, post-processing
  registerLightSource({pos: Vector3, color, intensity, distance, flicker?: 0..1, stealthRadius,
                       stealthWeight?: 0..1, enabled?: true}) -> handle (mutable: handle.enabled, handle.intensity)
  lightLevelAt(pos) -> 0..1     // stealth light level at a ground position (ambient ~0.15 in darkness)
  setThreat(0..1)               // HUD/AI tension → subtle post FX (pulse, vignette, aberration)
  setDeath(0..1)                // caught sequence → heavy distortion/fade to black
  onFootfall(intensity)         // leviathan footfall → mist puff / light flicker / dust
  setCall(0..1)                 // leviathan call envelope → sky pulses brighter red, mist shudders
  update(dt)
  resize(w, h)
  render()                      // renders the frame (EffectComposer)
  fogColor (THREE.Color), skyGlowColor (THREE.Color), fogDensity (number)
}
```
- Pools a **fixed** number of real `PointLight`s (≤ 6) and assigns them to the nearest registered
  sources each frame (constant light count = no shader recompiles). Distant sources still glow
  via emissive sprites/halos the level provides.
- Sky: dark crimson zenith → glowing red/orange horizon, cloud bands; matches fog colour.
- Mist: layered, drifting, low-lying; ash/ember particles around the camera.
- Post: bloom (subtle), film grain, vignette, slight chromatic aberration, colour grade.

### Leviathan — `src/world/leviathan.js`

```js
class Leviathan {
  constructor(game)             // builds the creature; reads game.level.leviathanRoute
  position                      // THREE.Vector3 body centre (world)
  calling                       // bool
  callProgress                  // 0..1 during a call
  update(dt)                    // walk, legs, call timer; writes game.noiseMask; emits footfall/call events
  onRespawn(checkpoint)
}
```
- Scale: body ~100–130 m above ground, legs 4–6, thin multi-segment, procedural IK gait, slow.
  Visible as a silhouette through mist from anywhere in the city (custom fog on its materials).
- Follows the player's progress along `leviathanRoute` with lag, using
  `game.level.zones[game.level.currentZone].leviathan` (`anchor`, `calls`) to decide where to
  loiter and how often to call (`CONFIG.leviathan.callIntervalCalm/Near`, `callDuration`).
- Footfalls: emit `leviathan:footfall` with intensity by distance; `game.player.addShake(...)`;
  `game.atmosphere.onFootfall(...)`; set `game.noiseMask` briefly (≈0.6 for 0.8 s when near).
- Call: emit `leviathan:call:start/end`; `game.noiseMask = 1` during the call;
  `game.atmosphere.setCall(envelope)`.

### Snatchers — `src/ai/snatcherModel.js` (visual), `src/ai/snatcher.js`, `src/ai/brain.js`, `src/ai/director.js` (AI)

Visual contract (`snatcherModel.js`):
```js
createSnatcherModel(seed) -> {
  root: THREE.Object3D,         // feet at origin, faces −Z, ~2.1–2.3 m tall
  headAnchor: THREE.Object3D,   // world position used for the death-cam look-at
  update(dt, anim)              // anim = { speed (m/s), mode, headYaw, headPitch, alert 0..1, time }
                                //   mode: 'idle'|'walk'|'investigate'|'search'|'chase'|'suspicious'|'rapture'|'grab'|'alarm'
  dispose()
}
```
AI contract:
```js
class Director {
  constructor(game)             // spawns a Snatcher per game.level.enemies def
  snatchers                     // array
  threat                        // 0..1 max detection/alert (drives HUD/audio/post)
  chasing                       // number currently chasing
  update(dt)
  reset()                       // all snatchers back to spawn, calm
  getIndicators() -> [{ enemy, detection 0..1, bearing (radians relative to camera forward, + = left),
                        state, distance }]
}
class Snatcher {
  id, def, position: Vector3, yaw, state, detection 0..1, root (THREE.Object3D)
  getHeadPos(out), getEyePos(out)
  update(dt), reset()
}
```
Spawn defs (`level.enemies`):
```js
{ id, zone, kind: 'patrol', pos:{x,z}, yaw, route:[{x,z},...], loop?: true, pause?: 2 }
{ id, zone, kind: 'sentry', pos:{x,z}, yaw, scanArc?: radians, scanPeriod?: seconds }
{ id, zone, kind: 'wander', pos:{x,z}, radius }
{ id, zone, kind: 'devout', pos:{x,z}, yaw, scanArc?, scanPeriod? }   // boulevard watchers
{ ..., sleeping?: true }  // optional: idle/slumped, much lower perception until disturbed
```
States: `idle`, `patrol`, `suspicious`, `investigate`, `alarm`, `chase`, `search`, `return`,
`rapture`, `grab`. Perception and tuning live in `CONFIG.enemy`. Snatchers only simulate fully
when within ±1 zone of the player (others stay put, cheap).

### Audio — `src/audio/audio.js`

```js
class AudioEngine {
  constructor(game)             // subscribe to bus events; no AudioContext yet
  init()                        // called from a user gesture; create context, start ambience
  setMasterVolume(0..1)
  update(dt)                    // listener follows game.camera; threat-driven layers from game.director.threat
}
```
Everything procedural (oscillators, filtered noise, generated impulse-response reverb, PannerNode
for positional sources). Must be silent and error-free before `init()` and when `?mute`.

### HUD — `src/ui/hud.js`

```js
class Hud {
  constructor(game)             // builds its own DOM + <style> inside document.body
  update(dt)
}
```
Owns every screen: title (game title, subtitle "a fragment inspired by *There Is No Antimemetics
Division*", controls, click to begin → `game.begin()`), intro text (→ `game.startPlaying()`),
pause (resume, sensitivity, volume, FOV), caught/dead (→ `game.respawn()`), win/ending (stats,
play again → reload). In-game: crosshair dot, directional detection indicators from
`director.getIndicators()`, visibility (light) eye, stamina, bottle count, interaction prompt +
hold progress, zone title cards (`zone:enter`), hint toasts (`level:message`), checkpoint toast,
pointer-lock fallback notice ("drag to look"), `?debug` overlay (fps, pos, zone, enemy states).
Minimal, diegetic-feeling, typewriter/mono type, never cluttered.

## Performance budget

60 fps on an integrated-GPU laptop at 1080p: ≤ 250 draw calls, ≤ 600k triangles, ≤ 6 dynamic
point lights, no shadow maps (or one cheap one), pixel ratio ≤ 1.5. Use instancing for repeated
props/windows, merged static geometry per material, cheap `MeshLambertMaterial`/`MeshStandardMaterial`.
