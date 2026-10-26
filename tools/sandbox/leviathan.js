// Sandbox for the leviathan: a dead city grid under a red sky with the creature walking a route.
//   node build.mjs --entry tools/sandbox/leviathan.js --out dist/sandbox-leviathan.html
// Query: ?paused (no real-time ticking; drive with __game.simulate), ?state=title, ?near
import * as THREE from 'three';
import { EventBus } from '../../src/core/events.js';
import { CollisionWorld } from '../../src/core/collision.js';
import { makeRng } from '../../src/core/math.js';
import { Leviathan } from '../../src/world/leviathan.js';

const params = new URLSearchParams(window.location.search);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
document.getElementById('boot')?.remove();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2500);
camera.rotation.order = 'YXZ';
scene.add(camera);

// --- sky + fog, roughly what the atmosphere module aims for
const fogColor = new THREE.Color(0x6a1c0c);
const skyGlowColor = new THREE.Color(0xff3a1a);
scene.fog = new THREE.FogExp2(fogColor, 0.012);
scene.background = fogColor.clone();
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uHorizon: { value: fogColor.clone() },
      uGlow: { value: new THREE.Color(0xa8381a) },
      uZenith: { value: new THREE.Color(0x2a0806) },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uZenith; varying vec3 vDir;
      void main(){ float h = max(vDir.y, 0.0);
        vec3 c = mix(uHorizon, uZenith, pow(h, 0.6));
        c += uGlow * exp(-h * 6.0) * 0.5;
        c *= 0.92 + 0.08 * sin(vDir.x * 4.0 + vDir.z * 3.0 + h * 18.0);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }),
);
sky.frustumCulled = false;
scene.add(sky);
scene.add(new THREE.HemisphereLight(0xff5a3a, 0x120606, 1.1));

// --- ground and a grid of buildings (also colliders so the feet plant on rooftops)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x1a1312 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const world = new CollisionWorld();
const rng = makeRng(11);
const boxes = [];
for (let ix = -6; ix <= 5; ix++) {
  for (let iz = -14; iz <= 4; iz++) {
    const x = ix * 50 + 25;
    const z = iz * 50 + 25;
    if (Math.abs(x) < 26 && z > -520 && z < 60) continue; // main avenue along x = 0 (wide)
    if (z < -100 && z > -310 && Math.abs(x) < 400) continue; // open band (z -307..-93) for broadside views
    const w = 30 + rng() * 6, d = 30 + rng() * 6;
    const h = 8 + Math.pow(rng(), 1.6) * 52;
    boxes.push({ x, z, w, d, h });
    world.addBox({ x, z, w, d, h });
  }
}
const bmesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x2a2020 }), boxes.length);
const m4 = new THREE.Matrix4();
boxes.forEach((b, i) => bmesh.setMatrixAt(i, m4.makeScale(b.w, b.h, b.d).setPosition(b.x, b.h / 2, b.z)));
scene.add(bmesh);
// a few wrecked cars on the avenue for scale
const carGeo = new THREE.BoxGeometry(1.9, 1.4, 4.4);
const carMat = new THREE.MeshLambertMaterial({ color: 0x1e1a1a });
for (let i = 0; i < 18; i++) {
  const car = new THREE.Mesh(carGeo, carMat);
  car.position.set((rng() - 0.5) * 16, 0.7, 30 - i * 28 + rng() * 8);
  car.rotation.y = (rng() - 0.5) * 1.2;
  scene.add(car);
  world.addBox({ x: car.position.x, z: car.position.z, w: 1.9, d: 4.4, h: 1.4, rot: car.rotation.y });
}

// --- fake game object (only what the leviathan reads)
const near = params.has('near');
const game = {
  scene, camera, renderer, world,
  bus: new EventBus(),
  state: params.get('state') || 'playing',
  time: 0,
  noiseMask: 0,
  debugCamera: null,
  level: {
    leviathanRoute: [{ x: 10, z: 120 }, { x: 0, z: -80 }, { x: 30, z: -260 }, { x: 0, z: -500 }],
    zones: [
      { id: 'a', index: 0, bounds: { minX: -100, maxX: 100, minZ: -200, maxZ: 100 }, leviathan: { anchor: { x: 0, z: -100 }, calls: near ? 'near' : 'calm' } },
    ],
    currentZone: 0,
    checkpoints: [{ id: 'start', order: 0, pos: { x: 0, z: 0 }, yaw: 0, zone: 0 }],
    titleCamera: { pos: [4, 2.2, 40], target: [0, 30, -60] },
  },
  player: {
    position: new THREE.Vector3(0, 0, 0),
    shake: 0,
    addShake(v) {
      this.shake += v;
    },
  },
  atmosphere: {
    fogColor,
    skyGlowColor,
    fogDensity: 0.011,
    footfalls: [],
    call: 0,
    onFootfall(i) {
      this.footfalls.push(i);
    },
    setCall(v) {
      this.call = v;
    },
  },
};
game.checkpoint = game.level.checkpoints[0];
game.leviathan = new Leviathan(game);

function tick(dt) {
  game.time += dt;
  game.leviathan.update(dt);
}
game.simulate = (seconds, step = 1 / 30) => {
  const n = Math.ceil(seconds / step);
  for (let i = 0; i < n; i++) tick(step);
};
// Stage the creature broadside on the cross avenue (z ~ -175) for screenshots.
game.stage = (seconds = 8) => {
  game.player.position.set(0, 0, -176);
  game.leviathan.placeAt(18, -200, 0);
  game.leviathan.playerS = game.leviathan.route.project(0, -176);
  game.simulate(seconds);
};
window.__game = game;

let last = performance.now();
const paused = params.has('paused');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) tick(dt);
  if (game.debugCamera) {
    const { pos, target } = game.debugCamera;
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(target[0], target[1], target[2]);
  } else {
    const L = game.leviathan.position;
    camera.position.set(L.x + 160, 2, L.z + 120);
    camera.lookAt(L.x, L.y * 0.7, L.z);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
