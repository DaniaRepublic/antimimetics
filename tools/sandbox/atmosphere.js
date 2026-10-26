// Atmosphere calibration sandbox: a dead street with buildings, cars, burning barrels, street
// lamps, snatcher-like silhouettes at 10/20/30/50 m and a distant stilt-legged giant.
//   node build.mjs --entry tools/sandbox/atmosphere.js --out dist/sandbox-atmosphere.html
// Exposes window.__game (fake game: scene/camera/renderer/bus/director/atmosphere, simulate())
// and window.__sandbox (views, sources, figures).
import * as THREE from 'three';
import { EventBus } from '../../src/core/events.js';
import { makeRng } from '../../src/core/math.js';
import { Atmosphere } from '../../src/world/atmosphere.js';

const params = new URLSearchParams(window.location.search);
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
app.appendChild(renderer.domElement);
document.getElementById('boot')?.remove();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 2500);
camera.rotation.order = 'YXZ';
scene.add(camera);

const game = {
  renderer, scene, camera,
  bus: new EventBus(),
  director: { threat: 0 },
  time: 0,
  state: 'playing',
  debugCamera: null,
  settings: { fov: 72 },
};
game.atmosphere = new Atmosphere(game);
const atmo = game.atmosphere;

// ------------------------------------------------------------------ textures
function facadeTexture(seed, lit = false) {
  const rng = makeRng(seed);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = lit ? '#000' : '#3b3634';
  g.fillRect(0, 0, 128, 256);
  if (!lit) {
    for (let i = 0; i < 900; i++) {
      const v = 40 + rng() * 30;
      g.fillStyle = `rgba(${v},${v * 0.92},${v * 0.9},0.25)`;
      g.fillRect(rng() * 128, rng() * 256, 2 + rng() * 6, 2 + rng() * 6);
    }
  }
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const px = 8 + x * 30, py = 12 + y * 62;
      const r = rng();
      if (lit) {
        if (r > 0.94) {
          g.fillStyle = `rgb(${200 + rng() * 55},${70 + rng() * 40},20)`;
          g.fillRect(px, py, 18, 36);
        }
      } else {
        g.fillStyle = r > 0.8 ? '#050404' : '#141415';
        g.fillRect(px, py, 18, 36);
        g.fillStyle = '#2a2624';
        g.fillRect(px - 2, py + 36, 22, 3);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function asphaltTexture() {
  const rng = makeRng(5);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#2b2928';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4000; i++) {
    const v = 25 + rng() * 40;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 2);
  }
  g.strokeStyle = 'rgba(10,10,10,0.6)';
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = rng() * 256, y = rng() * 256;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) g.lineTo((x += rng() * 30 - 15), (y += rng() * 30 - 15));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(60, 60);
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ world
const rng = makeRng(12);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1200, 1200),
  new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95, color: 0xffffff }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x4a4644, roughness: 0.9 });
for (const sx of [-1, 1]) {
  const sw = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.15, 420), sidewalkMat);
  sw.position.set(sx * 8.75, 0.075, -180);
  scene.add(sw);
}
const lineMat = new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.8 });
for (let z = 10; z > -380; z -= 6) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 2.6), lineMat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, 0.01, z);
  scene.add(m);
}

const facades = [0, 1, 2].map((i) => facadeTexture(100 + i));
const litFacades = [0, 1, 2].map((i) => facadeTexture(200 + i, true));
function building(x, z, w, d, h, k = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const n = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const side = Math.abs(n.getX(i)) > 0.5 ? d : w;
    uv.setXY(i, uv.getX(i) * side / 8, uv.getY(i) * h / 12);
  }
  const mat = new THREE.MeshStandardMaterial({
    map: facades[k % 3], emissiveMap: litFacades[k % 3], emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.92,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, h / 2, z);
  scene.add(m);
  return m;
}
for (const sx of [-1, 1]) {
  let z = 25;
  let k = sx > 0 ? 1 : 0;
  while (z > -380) {
    const w = 12 + rng() * 16;
    const gap = rng() < 0.15 ? 12 : 0.5;
    const h = 10 + rng() * 34;
    const d = 14 + rng() * 10;
    building(sx * (10.5 + d / 2), z - w / 2, d, w, h, k++);
    z -= w + gap;
  }
}
// distant skyline
for (let i = 0; i < 40; i++) {
  const a = rng() * Math.PI * 2;
  const r = 140 + rng() * 260;
  building(Math.cos(a) * r, Math.sin(a) * r - 120, 20 + rng() * 25, 20 + rng() * 25, 25 + rng() * 70, i);
}

// cars
const carMats = [0x2a2e33, 0x3a1d1a, 0x26302a, 0x403c38].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.3 }));
function car(x, z, rot, k) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 4.4), carMats[k % 4]);
  body.position.y = 0.6;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.2), carMats[k % 4]);
  cab.position.set(0, 1.25, -0.2);
  g.add(body, cab);
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  scene.add(g);
}
car(-3.5, -14, 0.3, 0);
car(4.2, -26, -0.2, 1);
car(-1.5, -44, 1.2, 2);
car(3.5, -70, 0.1, 3);
car(-4.5, -98, -0.4, 0);
car(2, -120, 0.8, 1);

// fires: barrel + flame billboards + registered light
const flameMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(6, 1.6, 0.35), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
const flames = [];
const sources = {};
function fire(id, x, z, intensity = 34) {
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.8 }));
  barrel.position.set(x, 0.45, z);
  scene.add(barrel);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.9, 8, 1, true), flameMat);
  flame.position.set(x, 1.3, z);
  scene.add(flame);
  flames.push(flame);
  sources[id] = atmo.registerLightSource({
    pos: new THREE.Vector3(x, 1.5, z), color: 0xff7a30, intensity, distance: 16, flicker: 0.55, stealthRadius: 6.5, stealthWeight: 0.85,
  });
  flame.userData.src = sources[id];
}
fire('fireA', -5.5, -17);
fire('fireB', 6, -58);
fire('fireC', -2.5, -104, 40);
fire('fireD', 4, -160);

// street lamps
const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1a19, roughness: 0.7, metalness: 0.4 });
const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(5, 3.2, 1.6) });
const lamps = [];
function lamp(id, x, z, side, opts = {}) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 7, 8), poleMat);
  pole.position.set(x, 3.5, z);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.1), poleMat);
  arm.position.set(x - side * 0.8, 6.9, z);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.3), lampMat.clone());
  head.position.set(x - side * 1.5, 6.82, z);
  scene.add(pole, arm, head);
  sources[id] = atmo.registerLightSource({
    pos: new THREE.Vector3(x - side * 1.5, 6.6, z), color: 0xffb070, intensity: opts.intensity ?? 70, distance: 20,
    flicker: opts.flicker ?? 0.08, stealthRadius: 7.5, stealthWeight: 0.8,
  });
  head.userData.src = sources[id];
  lamps.push(head);
}
lamp('lampA', 8, -36, 1);
lamp('lampB', -8, -82, -1);
lamp('lampBroken', 8, -132, 1, { flicker: 1 });
lamp('lampFar', -8, -200, -1);
// a blinking red alarm light (toggled via enabled)
sources.alarm = atmo.registerLightSource({ pos: new THREE.Vector3(3.5, 1.2, -70), color: 0xff1a10, intensity: 0, distance: 10, stealthRadius: 4, stealthWeight: 0.6, enabled: false });

// snatcher-like silhouettes
const figureMat = new THREE.MeshStandardMaterial({ color: 0x0b0909, roughness: 0.85 });
const faceMat = new THREE.MeshStandardMaterial({ color: 0x6d5a52, roughness: 0.7 });
function figure(x, z, yaw = 0) {
  const g = new THREE.Group();
  const cape = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.9, 10, 1, true), figureMat);
  cape.position.y = 1.0;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.7, 4, 8), figureMat);
  torso.position.y = 1.55;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), faceMat);
  head.scale.set(1, 1.35, 1);
  head.position.y = 2.12;
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), figureMat);
  hood.position.y = 2.16;
  hood.rotation.x = 0.35;
  g.add(cape, torso, head, hood);
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  scene.add(g);
  return g;
}
const figures = [
  figure(1.2, -5, 0.2), // 10 m from the default camera at z = 5
  figure(-1.8, -15, -0.3),
  figure(2.0, -25, 0.5),
  figure(-0.8, -45, 0.0),
];

// distant giant: thin body on stilt legs
const giantMat = new THREE.MeshStandardMaterial({ color: 0x0d0909, roughness: 0.9 });
const giant = new THREE.Group();
const body = new THREE.Mesh(new THREE.CapsuleGeometry(4, 40, 6, 12), giantMat);
body.rotation.z = Math.PI / 2;
body.position.y = 115;
giant.add(body);
for (let i = 0; i < 5; i++) {
  const a = (i / 5) * Math.PI * 2;
  const fx = Math.cos(a) * 45, fz = Math.sin(a) * 30;
  const knee = new THREE.Vector3(fx * 0.7, 150, fz * 0.7);
  const hip = new THREE.Vector3((i - 2) * 8, 115, 0);
  const foot = new THREE.Vector3(fx, 0, fz);
  for (const [a0, b0] of [[hip, knee], [knee, foot]]) {
    const len = a0.distanceTo(b0);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.4, len, 6), giantMat);
    seg.position.copy(a0).add(b0).multiplyScalar(0.5);
    seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b0.clone().sub(a0).normalize());
    giant.add(seg);
  }
}
giant.position.set(-30, 0, -300);
scene.add(giant);

// ------------------------------------------------------------------ loop
const views = {
  street: { pos: [0, 1.65, 5], target: [0, 1.4, -40] },
  crouch: { pos: [-2.2, 0.95, -10.5], target: [2, 0.9, -40] },
  fire: { pos: [-2.5, 1.65, -11], target: [-5.5, 1.0, -18] },
  lamp: { pos: [2, 1.65, -24], target: [6, 1.5, -38] },
  sky: { pos: [0, 1.65, 0], target: [-12, 14, -30] },
  sun: { pos: [0, 1.65, 0], target: [-60, 18, -79] },
  sunopen: { pos: [20, 90, -40], target: [-40, 105, -119] },
  title: { pos: [4, 30, 40], target: [-10, 45, -300] },
  up: { pos: [0, 1.65, 0], target: [0, 40, -10] },
  overview: { pos: [26, 22, 20], target: [0, 0, -40] },
  giant: { pos: [0, 1.65, -40], target: [-30, 70, -300] },
  wall: { pos: [-5, 1.65, -40], target: [-12, 2.5, -48] },
  back: { pos: [0, 1.65, -60], target: [0, 2, 0] },
};
let view = views[params.get('view')] || views.street;

function tick(dt) {
  game.time += dt;
  for (const f of flames) {
    const s = f.userData.src;
    f.scale.set(1, 0.75 + 0.35 * s.level, 1);
    f.material.opacity = 0.5 + 0.45 * s.level;
  }
  for (const l of lamps) l.material.color.setRGB(5, 3.2, 1.6).multiplyScalar(l.userData.src.level ?? 1);
  atmo.update(dt);
}

function placeCamera() {
  const v = game.debugCamera || view;
  camera.position.set(...v.pos);
  camera.lookAt(...v.target);
  camera.updateMatrixWorld();
}

function render() {
  placeCamera();
  atmo.render();
}

game.simulate = (seconds, step = 1 / 30) => {
  const n = Math.ceil(seconds / step);
  for (let i = 0; i < n; i++) tick(step);
};

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!game.paused) tick(dt);
  // While a test drives time (paused), only render on request to keep software GL responsive.
  if (!game.paused || game.renderRequested) {
    game.renderRequested = false;
    render();
  }
}
requestAnimationFrame(frame);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  atmo.resize(window.innerWidth, window.innerHeight);
});

window.__game = game;
window.__sandbox = {
  THREE, views, sources, figures, giant,
  setView(name) {
    view = views[name];
    game.debugCamera = null;
  },
  render,
  placeCamera,
  tick,
};
