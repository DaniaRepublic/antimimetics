// Sandbox for the snatcher model: a dark red street corner with a line-up of snatchers in
// different modes, plus helpers for death-cam close-ups. Built with:
//   node build.mjs --entry tools/sandbox/snatcher-model.js --out dist/sandbox-snatcher-model.html
// URL params: modes=idle,walk,... (line-up), seed=N (first seed), face=<mode> (close-up of one
// snatcher at 0.4 m), crowd=N (N snatchers for performance checks), paused.
// window.__game exposes { renderer, scene, camera, models, setup(defs), advance(s), faceCam(i, d) }.
import * as THREE from 'three';
import { createSnatcherModel, SNATCHER_MODES } from '../../src/ai/snatcherModel.js';
import { makeRng } from '../../src/core/math.js';
import { paintFace, paintGlow, paintCloth } from '../../src/ai/snatcher-textures.js';
import { FACE_VARIANTS, headLayout, buildHeadData } from '../../src/ai/snatcher-head.js';

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app').appendChild(renderer.domElement);
document.getElementById('boot')?.remove();

const scene = new THREE.Scene();
const fogColor = new THREE.Color(0x2c0906);
scene.background = fogColor;
scene.fog = new THREE.FogExp2(fogColor, Number(params.get('fog') || 0.045));
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 400);
camera.position.set(0, 1.65, 4);

// Light: dim red sky, a sodium streetlight off to the side, a faint red rim from the horizon.
scene.add(new THREE.HemisphereLight(0x8a2814, 0x0a0404, Number(params.get('hemi') || 0.9)));
const street = new THREE.PointLight(0xffa25a, 9, 16, 1.6);
street.position.set(3.5, 4.2, 1.5);
scene.add(street);
const rim = new THREE.DirectionalLight(0xff3a18, 0.5);
rim.position.set(-4, 5, -12);
scene.add(rim);
// ?studio: a neutral key light to judge shapes and textures (not the in-game mood).
if (params.has('studio')) {
  const key = new THREE.DirectionalLight(0xfff1e6, 2.2);
  key.position.set(2, 4, 6);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
}

// Ground: cracked dark asphalt.
function asphalt() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const rng = makeRng(5);
  g.fillStyle = '#1a1414';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const v = 14 + rng() * 26;
    g.fillStyle = `rgba(${v},${v * 0.85},${v * 0.82},0.5)`;
    g.fillRect(rng() * 256, rng() * 256, 1 + rng() * 2, 1 + rng() * 2);
  }
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    let x = rng() * 256, y = rng() * 256;
    g.moveTo(x, y);
    for (let k = 0; k < 8; k++) g.lineTo((x += (rng() - 0.5) * 50), (y += (rng() - 0.5) * 50));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(20, 20);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: asphalt(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const boxMat = new THREE.MeshStandardMaterial({ color: 0x2a2222, roughness: 0.9 });
for (const [x, z, w, d, h, r] of [[-6, -8, 1.9, 4.4, 1.4, 0.3], [6.5, -3, 1.9, 4.5, 1.5, -0.2], [0, -18, 30, 1, 9, 0], [-9, 2, 1, 20, 7, 0], [4.5, -12, 2.4, 2.4, 1.1, 0.6]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), boxMat);
  m.position.set(x, h / 2, z);
  m.rotation.y = r;
  scene.add(m);
}

// --- snatchers
const MOVE_SPEED = { walk: 1.25, investigate: 1.2, search: 1.0, chase: 3.9 };
let models = [];

// defs: [{seed, mode, x, z, yaw, speed?, path?: 'pace'|'circle', len?, headYaw?, headPitch?, alert?}]
function setup(defs) {
  for (const m of models) m.model.dispose();
  models = defs.map((d) => {
    const model = createSnatcherModel(d.seed);
    scene.add(model.root);
    const s = { def: d, model, x: d.x, z: d.z, yaw: d.yaw ?? Math.PI, dir: 1, travelled: 0, ang: 0 };
    s.speed = d.speed ?? (d.path ? MOVE_SPEED[d.mode] ?? 1.25 : 0);
    model.root.position.set(s.x, 0, s.z);
    model.root.rotation.y = s.yaw;
    return s;
  });
  return models.map((m) => m.model.variant);
}

function step(dt) {
  for (const s of models) {
    const d = s.def;
    let speed = 0;
    if (d.path === 'pace' && s.speed > 0) {
      // Walk back and forth along the facing line, turning at the ends.
      if (s.turning > 0) {
        s.turning -= dt;
        const k = 1 - Math.max(0, s.turning) / 0.9;
        s.yaw = s.turnFrom + Math.PI * k;
      } else {
        speed = s.speed;
        s.x += -Math.sin(s.yaw) * speed * dt;
        s.z += -Math.cos(s.yaw) * speed * dt;
        s.travelled += speed * dt;
        if (s.travelled > (d.len ?? 4)) {
          s.travelled = 0;
          s.turning = 0.9;
          s.turnFrom = s.yaw;
        }
      }
    } else if (d.path === 'circle' && s.speed > 0) {
      const r = d.len ?? 2;
      s.ang += (s.speed / r) * dt;
      s.x = d.x + Math.cos(s.ang) * r;
      s.z = d.z + Math.sin(s.ang) * r;
      s.yaw = Math.atan2(Math.sin(s.ang), -Math.cos(s.ang));
      speed = s.speed;
    }
    s.model.root.position.set(s.x, 0, s.z);
    s.model.root.rotation.y = s.yaw;
    s.model.update(dt, {
      speed,
      mode: d.mode,
      headYaw: d.headYaw ?? 0,
      headPitch: d.headPitch ?? 0,
      alert: d.alert ?? (d.mode === 'chase' || d.mode === 'grab' ? 1 : 0),
      time: performance.now() / 1000,
    });
  }
}

function advance(seconds, h = 1 / 60) {
  const n = Math.ceil(seconds / h);
  for (let i = 0; i < n; i++) step(h);
}

// Death-cam framing: camera at player eye height, the snatcher lunging in from `dist` metres.
function faceCam(i = 0, dist = 1.0) {
  const s = models[i];
  const eye = new THREE.Vector3(s.x - Math.sin(s.yaw) * dist, 1.65, s.z - Math.cos(s.yaw) * dist);
  const head = s.model.headAnchor.getWorldPosition(new THREE.Vector3());
  api.debugCamera = { pos: eye.toArray(), target: head.toArray() };
  return { eye: eye.toArray(), head: head.toArray(), distance: eye.distanceTo(head) };
}

const api = {
  renderer, scene, camera, setup, advance, faceCam, step, street, rim, ground, modes: SNATCHER_MODES,
  debug: { paintFace, paintGlow, paintCloth, FACE_VARIANTS, headLayout, buildHeadData },
  get models() {
    return models;
  },
  paused: params.has('paused'),
  debugCamera: null,
  timeScale: 1,
};
window.__game = api;

// Default scene from URL.
const seed0 = Number(params.get('seed') || 1);
if (params.get('face')) {
  setup([{ seed: seed0, mode: params.get('face'), x: 0, z: 0, yaw: Math.PI }]);
  advance(1.2);
  faceCam(0, Number(params.get('dist') || 1.0));
} else if (params.get('crowd')) {
  const n = Number(params.get('crowd'));
  const modes = ['idle', 'walk', 'chase', 'search', 'suspicious', 'rapture', 'investigate', 'alarm'];
  setup(Array.from({ length: n }, (_, i) => ({
    seed: seed0 + i, mode: modes[i % modes.length], x: (i % 4) * 2.6 - 3.9, z: -4 - Math.floor(i / 4) * 3,
    yaw: Math.PI, path: ['walk', 'chase', 'search', 'investigate'].includes(modes[i % modes.length]) ? 'circle' : null, len: 1,
  })));
  camera.position.set(0, 3.2, 6);
  camera.lookAt(0, 1, -8);
} else {
  const modes = (params.get('modes') || 'idle,walk,suspicious,chase,rapture').split(',');
  setup(modes.map((mode, i) => ({
    seed: seed0 + i, mode, x: (i - (modes.length - 1) / 2) * 1.9, z: -4.5, yaw: Math.PI,
    path: params.has('move') && MOVE_SPEED[mode] ? 'pace' : null,
  })));
  camera.position.set(0, 1.6, 1.2);
  camera.lookAt(0, 1.3, -4.5);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!api.paused) advance(dt * api.timeScale, Math.max(1 / 240, dt * api.timeScale));
  if (api.debugCamera) {
    camera.position.fromArray(api.debugCamera.pos);
    camera.lookAt(...api.debugCamera.target);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
