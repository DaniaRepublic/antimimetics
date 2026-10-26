import * as THREE from 'three';
import { mat, cyl, FACE } from './level-batch.js';
import { building, ruin, skyline } from './buildings.js';
import { GRAFFITI, STORE, decalUV, signUV, storeUV } from './textures.js';
import {
  car, bus, overturnedTruck, dumpster, trashBags, jersey, barrierLine, fence, wall, streetlight, powerPole,
  trafficMast, signPost, hydrant, newsBox, bench, barrel, crate, pallets, belongings, rubble, deadTree, planter,
  kiosk, busShelter, billboard, statue, fountain, gasCanopy, fuelSign, gantry, barricade, acUnit, pipe, backDoor,
  manhole, cylX, COL, color, shade,
} from './props.js';

// The city of Ashford, laid out along the escape route (north = -Z):
//   Z0 alley (z +8..-20) -> Z1 Main Street (-20..-138) -> Z2 civic plaza (-138..-212)
//   -> Z3 boulevard (-212..-338) -> Z4 highway approach & gate (-338..-446), exit at z = -430.
// Returns the gameplay data the Level exposes (zones, checkpoints, enemies, ...).

const PI = Math.PI;
const E = -PI / 2; // yaw facing +X (east)
const W = PI / 2; // yaw facing -X (west)
const N = 0; // facing -Z (north)
const S = PI; // facing +Z (south)

// Walkable areas (used by tests and to keep scenery out of the route).
export const ROUTE_RECTS = [
  { name: 'alley', minX: -3, maxX: 3, minZ: -24, maxZ: 8 },
  { name: 'south-cross', minX: -22, maxX: 22, minZ: -36, maxZ: -24 },
  { name: 'main', minX: -12, maxX: 12, minZ: -127, maxZ: -36 },
  { name: 'mid-cross', minX: -22, maxX: 22, minZ: -82, maxZ: -70 },
  { name: 'pharmacy', minX: 12, maxX: 28, minZ: -136, maxZ: -110 },
  { name: 'yard', minX: 13, maxX: 28, minZ: -148, maxZ: -136 },
  { name: 'plaza', minX: -28, maxX: 28, minZ: -205, maxZ: -145 },
  { name: 'gas-lot', minX: -40, maxX: -28, minZ: -182, maxZ: -156 },
  { name: 'passage', minX: -3.5, maxX: 3.5, minZ: -218, maxZ: -205 },
  { name: 'boulevard', minX: -17.5, maxX: 17.5, minZ: -338, maxZ: -218 },
  { name: 'road', minX: -12, maxX: 12, minZ: -446, maxZ: -338 },
  { name: 'garage', minX: -44, maxX: -13, minZ: -424, maxZ: -338 },
  { name: 'garage-exit', minX: -13, maxX: -12, minZ: -424, maxZ: -418 },
];

const rect = (minX, maxX, minZ, maxZ) => ({ minX, maxX, minZ, maxZ });

export function buildCity(B) {
  const rng = B.rng;
  const footprints = []; // explicit building rects, to keep skyline filler out of them
  const bld = (spec) => {
    footprints.push(rect(spec.x0, spec.x1, spec.z0, spec.z1));
    return building(B, spec);
  };
  const b = B.batch;

  // ------------------------------------------------------------------------------------------
  // Ground
  // City ground ends at the river embankment (z -452); the road continues out over a bridge.
  b.flat('asphalt', 0, 0, 0, 1000, 904, 0, [0, 0, 1000 / 8, 904 / 8], color(0xe8e4e0));

  const sidewalk = (x0, x1, z0, z1, curbSide = null) => {
    b.box('paving', mat((x0 + x1) / 2, 0, (z0 + z1) / 2), x1 - x0, 0.12, z1 - z0, color(0xe4dcd6), { uvScale: 4, ao: 0, faces: FACE.py | FACE.px | FACE.nx | FACE.pz | FACE.nz });
    if (curbSide) {
      const cx = curbSide === 'e' ? x1 - 0.12 : curbSide === 'w' ? x0 + 0.12 : (x0 + x1) / 2;
      const cz = curbSide === 'n' ? z0 + 0.12 : curbSide === 's' ? z1 - 0.12 : (z0 + z1) / 2;
      const along = curbSide === 'e' || curbSide === 'w';
      b.box('rough', mat(cx, 0, cz), along ? 0.24 : x1 - x0, 0.14, along ? z1 - z0 : 0.24, color(0x7a746e), { ao: 0, uvScale: 1.5 });
    }
  };
  // Road texture strip: 16 m wide section; u0..u1 selects lanes; alongX for east-west streets.
  const road = (x0, x1, z0, z1, alongX = false, u0 = 0, u1 = 1) => {
    const len = alongX ? x1 - x0 : z1 - z0;
    const wid = alongX ? z1 - z0 : x1 - x0;
    b.flat('road', (x0 + x1) / 2, 0.01, (z0 + z1) / 2, wid, len, alongX ? W : 0, [u0, 0, u1, len / 16]);
  };
  const paint = (x, z, w, d, yaw = 0, col = color(0xd8d2c4)) => b.flat('decal', x, 0.028, z, w, d, yaw, decalUV('crosswalk'), col);
  const crosswalk = (x0, x1, z, alongX = true) => {
    for (let x = x0 + 0.5; x < x1; x += 1.1) {
      if (alongX) paint(x, z, 0.55, 3.2);
      else paint(z, x, 3.2, 0.55);
    }
  };

  // ==========================================================================================
  // Z0 — THE ALLEY
  bld({ x0: -26, x1: -3, z0: -24, z1: 22, h: 21, style: 'brick', store: { n: true }, fireEscape: ['e'], lit: 0.06 });
  bld({ x0: 3, x1: 24, z0: -24, z1: 22, h: 15, style: 'brick', store: { n: true }, fireEscape: ['w'], lit: 0.05 });
  // Dead end behind the start: fence, then the alley carries on into darkness to a wall.
  fence(B, -3, 8, 3, 8, { h: 2.6, sag: 0.2 });
  wall(B, -3, 22, 3, 22, { h: 7, t: 0.6, color: color(0x3a302b) });
  dumpster(B, { x: -1.6, z: 12, yaw: 0.3, open: true });
  car(B, { x: 1.2, z: 17, yaw: 0.2, type: 'hatch', burnt: true });
  // alley floor dressing
  b.flat('asphalt', 0, 0.006, -8, 6, 32, 0, [0, 0, 6 / 6, 32 / 6], color(0xa8a09a));
  for (const z of [5, -6, -17]) b.flat('decal', 0, 0.03, z, 0.9, 0.5, 0, decalUV('grate'));
  B.puddle(0.6, -4.5, 2.6, 1.7, 0.2);
  B.puddle(-1.2, -19, 2.2, 1.5, 1.2);
  B.puddle(1.4, 2.5, 1.6, 1.1, 0.5);
  B.decal('papers', -1, -13, 2.2, 2.2, 0.4);
  B.decal('papers', 1.5, -21, 2.2, 2.2, 2.1);
  B.decal('oil', 0.2, -10, 3, 3, 0);
  // Back doors, lamp, wall clutter
  const lamp0 = backDoor(B, { x: -3, z: -4, yaw: E });
  B.light({ pos: lamp0, color: 0xffa358, intensity: 26, distance: 11, stealthRadius: 4.5, stealthWeight: 0.7, selfFlicker: true, flickerStyle: 'dying', halo: { size: 0.55, intensity: 2.2 } });
  b.box('emissive', mat(lamp0.x, lamp0.y - 0.02, lamp0.z), 0.22, 0.05, 0.3, color(0xffb070));
  backDoor(B, { x: 3, z: -15, yaw: W });
  backDoor(B, { x: -3, z: 14, yaw: E });
  dumpster(B, { x: 2.0, z: -1.6, yaw: PI / 2 });
  dumpster(B, { x: -2.05, z: -14.5, yaw: -PI / 2 + 0.05, open: true });
  pallets(B, { x: 2.2, z: -19.5, yaw: 0.2, n: 4 });
  crate(B, { x: -2.4, z: 5.8, yaw: 0.3, s: 0.7, stack: 2 });
  trashBags(B, { x: -2.3, z: -7.5, n: 4, spread: 0.7 });
  trashBags(B, { x: 2.4, z: 4.5, n: 3, spread: 0.6 });
  trashBags(B, { x: -2.4, z: -21.5, n: 3, spread: 0.6 });
  for (const [x, y, z, yaw] of [[-2.7, 3.6, 1, E], [2.7, 4.2, -6, W], [-2.7, 7.8, -11, E], [2.7, 3.4, -22, W], [-2.7, 5.2, 6, E]]) acUnit(B, { x, y, z, yaw });
  for (const [x, z] of [[-2.85, -1], [2.85, -12.5], [-2.85, -19.5], [2.85, 6.5]]) pipe(B, { x, z, h: 14, r: 0.07 });
  // The crashed delivery van, nose buried in the west wall. A gap remains on the east side.
  car(B, { x: -0.95, z: -10.6, yaw: 0.42, type: 'van', color: color(0xc8c2b4) });
  rubble(B, { x: -2.4, z: -13.4, w: 1.6, d: 2.2, h: 0.5, collider: false, color: color(0x7a5048) });
  belongings(B, { x: 0.5, z: -16, n: 2, spread: 1 });
  // Wires criss-crossing overhead
  for (const [za, zb, y] of [[3, -2, 8.5], [-5, -9, 10], [-13, -12, 7.5], [-18, -23, 11]]) B.wire(new THREE.Vector3(-3, y, za), new THREE.Vector3(3, y - 1, zb), 0.6);
  // Graffiti
  B.graffiti(GRAFFITI.stayLow, 2.98, 1.1, -3.5, W, 3.4, 1.7, 'STAY LOW — crouch (C) and keep something solid between you and them. Crouching is almost silent.', { range: 10 });
  B.graffiti(GRAFFITI.tally, -2.98, 1.4, -6.8, E, 2.2, 1.1);
  B.graffiti(GRAFFITI.dontRun, -2.98, 1.0, -17.5, E, 3.2, 1.6, "THEY DON'T RUN — they walk fast and never stop. Sprinting (Shift) gets you away, but not for long.", { range: 9 });
  B.graffiti(GRAFFITI.here, 2.98, 1.6, -19.5, W, 2.6, 1.3);

  // ==========================================================================================
  // South cross street (z -24..-36), closed at both ends
  road(-24, 24, -36, -24, true, 0.125, 0.875);
  sidewalk(-26, -3, -27, -24, 'n');
  sidewalk(3, 24, -27, -24, 'n');
  crosswalk(-8, 8, -38.5);
  for (const sx of [-1, 1]) {
    const x = sx * 22;
    fence(B, x, -24, x, -36, { h: 2.5 });
    barricade(B, { x: x - sx * 0.42, z: -29.5, yaw: sx > 0 ? E : W, w: 2.6, sign: true });
    barricade(B, { x: x - sx * 0.42, z: -33.5, yaw: sx > 0 ? E : W, w: 2.6 });
    car(B, { x: x + sx * 3.5, z: -31, yaw: 1.3 * sx, type: 'sedan', burnt: true });
    car(B, { x: x + sx * 8, z: -28, yaw: 0.2, type: 'hatch' });
    rubble(B, { x: x + sx * 12, z: -31, w: 5, d: 10, h: 2.5, collider: false });
  }
  // Blocks beyond the barricades (seen through the fences)
  bld({ x0: -60, x1: -26, z0: -24, z1: 4, h: 24, style: 'concrete', store: { n: true } });
  bld({ x0: 24, x1: 62, z0: -24, z1: 4, h: 30, style: 'stone', store: { n: true } });
  bld({ x0: -64, x1: -34, z0: -70, z1: -36, h: 34, style: 'brick', store: { s: true } });
  bld({ x0: 34, x1: 64, z0: -70, z1: -36, h: 20, style: 'brick', store: { s: true } });

  // ==========================================================================================
  // Z1 — MAIN STREET (x -12..12, z -36..-127)
  const W1 = bld({ x0: -34, x1: -12, z0: -70, z1: -36, h: 18, style: 'brick', store: { e: [STORE.shutter, STORE.smashed, STORE.halfShutter, STORE.boarded, STORE.papered, STORE.shutter], s: true }, fireEscape: ['e'], lit: 0.07 });
  bld({ x0: -34, x1: -12, z0: -104, z1: -82, h: 26, style: 'stone', store: { e: [STORE.shutter, STORE.smashed, STORE.laundry, STORE.papered], n: true }, lit: 0.05 });
  bld({ x0: -34, x1: -12, z0: -126, z1: -104, h: 15, style: 'concrete', store: { e: true }, lit: 0.04 });
  bld({ x0: 12, x1: 34, z0: -70, z1: -36, h: 22, style: 'concrete', store: { w: true, s: true }, fireEscape: ['w'], lit: 0.05 });
  bld({ x0: 12, x1: 34, z0: -110, z1: -82, h: 30, style: 'brick', store: { w: [STORE.barred, STORE.shutter, STORE.boarded, STORE.smashed, STORE.halfShutter], n: true }, fireEscape: ['w'], lit: 0.06 });
  // Mid cross street (z -70..-82), barricaded at x = +-22, more city beyond
  bld({ x0: -64, x1: -34, z0: -104, z1: -82, h: 40, style: 'concrete', store: { n: true } });
  bld({ x0: 34, x1: 64, z0: -110, z1: -82, h: 26, style: 'stone', store: { n: true } });
  road(-40, 40, -82, -70, true, 0.125, 0.875);
  road(-8, 8, -127, -36);
  sidewalk(-12, -8, -70, -36, 'e');
  sidewalk(-12, -8, -127, -82, 'e');
  sidewalk(8, 12, -70, -36, 'w');
  sidewalk(8, 12, -110, -82, 'w');
  sidewalk(8, 12, -127, -110, 'w');
  sidewalk(-34, -12, -73, -70, 's');
  sidewalk(-34, -12, -82, -79, 'n');
  sidewalk(12, 34, -73, -70, 's');
  sidewalk(12, 34, -82, -79, 'n');
  crosswalk(-8, 8, -68.5);
  crosswalk(-8, 8, -83.5);
  for (const sx of [-1, 1]) {
    const x = sx * 22;
    fence(B, x, -70, x, -82, { h: 2.5 });
    jersey(B, { x: x - sx * 0.4, z: -73, yaw: 0 });
    jersey(B, { x: x - sx * 0.4, z: -79.2, yaw: 0.03 });
    car(B, { x: x + sx * 4, z: -76, yaw: 0.4 * sx, type: 'van', burnt: sx > 0 });
    car(B, { x: x + sx * 11, z: -74, yaw: 1.9, type: 'sedan' });
  }
  // Manholes, puddles, litter, oil
  for (const [x, z] of [[2, -44], [-3, -88], [4, -116], [-1, -60]]) manhole(B, x, z);
  for (const [x, z] of [[-7.6, -50], [7.6, -95], [-7.6, -112], [7.6, -64], [-7.6, -88]]) b.flat('decal', x, 0.03, z, 0.5, 0.95, 0, decalUV('grate'));
  for (const [x, z, w, d, yaw] of [[-4, -52, 4, 2.5, 0.3], [5, -84, 3.5, 2.2, 1.1], [-1, -104, 4.5, 2.6, 0.2], [9.5, -58, 2, 1.2, 0], [-9.8, -95, 2.2, 1.4, 0.4], [2.5, -122, 3, 2, 0.8]]) B.puddle(x, z, w, d, yaw);
  for (const [x, z] of [[-6, -42], [6, -71], [-2, -95], [9, -103], [-10, -66]]) B.decal('papers', x, z, 2.4, 2.4, rng() * 6);
  for (const [x, z] of [[3, -50], [-4, -76], [1, -108]]) B.decal('oil', x, z, 3.2, 3.2, rng() * 6);
  B.decal('skid', -1, -58, 6, 3, 0.5);
  B.decal('arrow', -4, -46, 1.2, 4.5, 0);
  B.decal('arrow', 4, -122, 1.2, 4.5, PI);
  B.decal('cracks', 6, -90, 4, 4, 0.3);
  B.decal('cracks', -3, -40, 3, 3, 1.2);
  // Street lamps: mostly dead; one flickering on the east side.
  for (const z of [-44, -88, -118]) streetlight(B, { x: -9.0, z, yaw: E });
  for (const z of [-48, -96]) streetlight(B, { x: 9.0, z, yaw: W });
  streetlight(B, { x: 9.0, z: -62, yaw: W, state: 'flicker', intensity: 40, stealthRadius: 6 });
  trafficMast(B, { x: -10.3, z: -69.2, yaw: 0, arm: 9, blink: true });
  trafficMast(B, { x: 10.3, z: -82.8, yaw: PI, arm: 9 });
  signPost(B, { x: -10.5, z: -37.2, yaw: S, sign: 'street', w: 1.3, h: 0.32, at: 2.8 });
  signPost(B, { x: 10.5, z: -84, yaw: N, sign: 'stop', w: 0.75, h: 0.75, at: 1.6 });
  // Wrecks. The patrol walks the lanes; the sentry stands in the laundromat's light (west).
  car(B, { x: 5.6, z: -41, yaw: 0.15, type: 'sedan' });
  car(B, { x: -9.7, z: -41, yaw: S, type: 'sedan', sink: 0.02 });
  car(B, { x: -4.6, z: -47, yaw: -0.4, type: 'hatch', door: true });
  car(B, { x: 9.7, z: -52, yaw: PI + 0.04, type: 'pickup' });
  car(B, { x: 1.6, z: -55.5, yaw: 1.25, type: 'sedan', burnt: true });
  const z1Alarm = car(B, { x: -9.75, z: -68.0, yaw: 0.02, type: 'sedan', color: color(0x1f2b44), alarm: 'main_alarm' });
  car(B, { x: -3.2, z: -63.5, yaw: 0.7, type: 'sedan', roll: 1, police: true });
  car(B, { x: 6.4, z: -66, yaw: -0.12, type: 'hatch' });
  car(B, { x: -3.8, z: -80.5, yaw: 0.4, type: 'sedan', burnt: true, fire: true, fireScale: 1.15 });
  car(B, { x: 6.8, z: -76.5, yaw: 1.4, type: 'sedan', door: true, doorSide: 1 });
  car(B, { x: 9.8, z: -88.5, yaw: 0.02, type: 'van', color: color(0x5a6470) });
  bus(B, { x: 3.2, z: -101, yaw: 0.28, fold: 0.75 });
  car(B, { x: -5.4, z: -94, yaw: 2.9, type: 'hatch' });
  car(B, { x: -5.6, z: -107.5, yaw: 2.6, type: 'sedan', door: true });
  car(B, { x: 6.0, z: -114.5, yaw: -0.35, type: 'hatch', burnt: true });
  car(B, { x: -1.5, z: -119, yaw: 1.45, type: 'pickup' });
  // Sidewalk clutter
  dumpster(B, { x: -10.6, z: -61.5, yaw: W });
  dumpster(B, { x: 10.7, z: -44, yaw: E });
  dumpster(B, { x: 10.7, z: -101, yaw: E, open: true });
  newsBox(B, { x: 8.7, z: -57.5, yaw: W });
  newsBox(B, { x: 8.7, z: -58.3, yaw: W });
  newsBox(B, { x: -8.7, z: -100, yaw: E });
  hydrant(B, { x: 8.5, z: -73 });
  hydrant(B, { x: -8.5, z: -115 });
  bench(B, { x: 11.0, z: -94, yaw: W });
  trashBags(B, { x: -11, z: -47, n: 5, spread: 1 });
  trashBags(B, { x: 11.2, z: -64, n: 4, spread: 0.8 });
  trashBags(B, { x: -11, z: -118, n: 4, spread: 0.8 });
  trashBags(B, { x: 11, z: -108, n: 3, spread: 0.8 });
  for (const [x, z] of [[2, -43.5], [-6, -58], [3, -72], [-8, -101], [0, -112], [9, -79]]) belongings(B, { x, z, n: 3, spread: 1.6 });
  // Brick and plaster fallen from the facades
  for (const [x, z, n] of [[-10.6, -55, 6], [10.8, -76, 5], [-10.4, -97, 4], [10.6, -112, 5], [-10.8, -122, 8]]) {
    rubble(B, { x, z, w: 2.2, d: 2.2, h: 0.35, collider: false, density: 0.3 * n / 6 });
  }
  // Rooftop billboard over the east side, facing the alley mouth.
  billboard(B, { x: 15.5, y: 24.0, z: -57, yaw: W + 0.55, w: 11, h: 5.5, post: 2.5 });
  // Power lines along the cross streets
  {
    const a = powerPole(B, { x: -18, z: -36.6 });
    const c = powerPole(B, { x: 18, z: -36.6 });
    for (let i = 0; i < 3; i++) B.wire(a[i], c[i], 1.4, 12);
    const d = powerPole(B, { x: -18, z: -69.5 });
    const e = powerPole(B, { x: 18, z: -82.5 });
    for (let i = 0; i < 3; i++) B.wire(d[i], e[i], 1.6, 14);
    for (let i = 0; i < 3; i++) B.wire(a[i], new THREE.Vector3(-12, 9, -24), 0.5, 4);
  }
  // The lit laundromat (sentry post) — the only working shop light in the street.
  const mats = B.level.materials;
  B.light({
    pos: { x: -13.2, y: 2.6, z: -90.3 }, color: 0xd6efe6, intensity: 75, distance: 17, stealthRadius: 9.5, stealthWeight: 0.95,
    selfFlicker: true, flickerStyle: 'buzz', halo: { size: 1.6, intensity: 0.6 },
    onFlicker: (f) => {
      mats.storeLit.emissiveIntensity = 1.6 * f;
    },
  });
  b.box('emissive', mat(-12.3, 4.0, -90.3), 0.08, 0.06, 4.5, color(0xe8fff6));
  // Graffiti on Main Street
  B.graffiti(GRAFFITI.face, -11.98, 1.1, -46, E, 4.4, 2.2, "DON'T LET THEM SEE YOUR FACE — they see in a wide cone. Keep cars between you and them.", { range: 14 });
  B.graffiti(GRAFFITI.light, 11.98, 1.2, -61, W, 3.8, 1.9, 'STAY OUT OF THE LIGHT — lamps, fires and lit windows make you easy to see.', { range: 11 });
  B.graffiti(GRAFFITI.eye, -11.98, 2.0, -113, E, 2.8, 1.4);

  // --- the burnt-out pharmacy: the way through to the plaza ---------------------------------
  pharmacy(B, footprints);
  bld({ x0: 28, x1: 46, z0: -148, z1: -110, h: 20, style: 'brick', store: {}, lit: 0.05 });
  // --- the collapse: ruin on the west corner, rubble mound across the street end ------------
  footprints.push(rect(-40, -12, -148, -126));
  ruin(B, { x0: -40, x1: -12, z0: -148, z1: -126, h: 24, style: 'concrete', heights: [24, 19, 12, 7, 9.5, 5] });
  rubble(B, { x: 0.5, z: -135.5, w: 25, d: 20, h: 5.5, collider: false });
  rubble(B, { x: -4, z: -129, w: 10, d: 6, h: 2.2, collider: false, density: 0.6 });
  rubble(B, { x: 6, z: -128, w: 8, d: 5, h: 1.8, collider: false, density: 0.6 });
  // Mound collider: x -12.2..12 up to the pharmacy's front wall, plus the strip that walls the
  // yard's west side (x 12..13.2, behind the pharmacy) -- not inside the pharmacy itself.
  B.solid(-0.1, -137, 24.2, 18, 4.6, 0, { tag: 'rubble' });
  B.solid(12.6, -141, 1.2, 10, 4.6, 0, { tag: 'rubble' });
  B.solid(0.5, -128, 22, 2.4, 1.6, 0, { tag: 'rubble' });
  // slabs leaning on the mound + a car half buried
  b.box('rough', mat(-3, 0, -131.5, 0.3, -0.5), 9, 0.35, 5, shade(COL.concrete, 0.75), { ao: 0.2 });
  b.box('rough', mat(5, 0.5, -134, -0.6, 0.35, 0.2), 7, 0.35, 4, shade(COL.concrete, 0.65), { ao: 0.2 });
  car(B, { x: -7.5, z: -128.5, yaw: 2.1, type: 'sedan', pitch: -0.12, tilt: 0.1, burnt: true });
  B.graffiti(GRAFFITI.through, 11.98, 1.3, -125.3, W, 3.2, 1.6, 'THROUGH → — the pharmacy. Somebody found a way through.', { range: 12 });

  // ==========================================================================================
  // Z2 — THE CIVIC PLAZA (x -28..28, z -148..-205; gas lot to the west, arch to the north)
  bld({ x0: -56, x1: -28, z0: -156, z1: -148, h: 16, style: 'concrete', store: { e: true, n: true } });
  bld({ x0: -56, x1: -40, z0: -182, z1: -156, h: 5.6, exactH: true, style: 'concrete', store: { e: [STORE.papered, STORE.smashed, STORE.barred, STORE.boarded] }, roof: false, lit: 0 });
  bld({ x0: -80, x1: -56, z0: -192, z1: -146, h: 28, style: 'brick', store: {} });
  bld({ x0: -56, x1: -28, z0: -205, z1: -182, h: 30, style: 'stone', store: { e: true, s: true } });
  bld({ x0: 28, x1: 50, z0: -176, z1: -148, h: 20, style: 'brick', store: { w: true }, fireEscape: ['w'], lit: 0.07 });
  bld({ x0: 28, x1: 50, z0: -205, z1: -176, h: 28, style: 'concrete', store: { w: true } });
  // Civic hall with the arch passage (x -3.5..3.5)
  bld({ x0: -40, x1: -3.5, z0: -218, z1: -205, h: 22, style: 'stone', cornice: true, lit: 0.03 });
  bld({ x0: 3.5, x1: 40, z0: -218, z1: -205, h: 22, style: 'stone', cornice: true, lit: 0.03 });
  bld({ x0: -3.5, x1: 3.5, z0: -218, z1: -205, h: 22, y0: 6.6, style: 'stone', faces: ['n', 's'], roof: false, parapet: false });
  b.wall('signs', 0, 7.0, -204.95, 7.2, 1.8, S, signUV('civic'));
  for (const sx of [-1, 1]) {
    b.box('rough', mat(sx * 4.3, 0, -204.7), 1.6, 6.6, 0.8, color(0xa69a88), { ao: 0.4 });
    b.box('rough', mat(sx * 4.3, 0, -218.3), 1.6, 6.6, 0.8, color(0xa69a88), { ao: 0.4 });
  }
  // Plaza ground: pavers, raised central square with steps, ring road
  b.flat('pavers', 0, 0.012, -176.5, 56, 57, 0, [0, 0, 56 / 6, 57 / 6], color(0xd8d0ca));
  b.box('pavers', mat(0, 0, -175.5), 34, 0.16, 38, color(0xf0e8e0), { uvScale: 6, ao: 0, faces: FACE.py | FACE.px | FACE.nx | FACE.pz | FACE.nz });
  b.flat('pavers', 0, 0.012, -211.5, 7, 13, 0, [0, 0, 7 / 6, 13 / 6], color(0xc8c0ba));
  b.flat('rough', -34, 0.015, -169, 12, 26, 0, [0, 0, 3, 6.5], color(0x77716c));
  for (const [x, z] of [[-31, -176], [-33, -162], [-36, -170]]) B.decal('oil', x, z, 3, 3, rng() * 6);
  for (let z = -160; z > -180; z -= 3) paint(-29.2, z, 0.12, 2.4, 0);
  for (const [x, z, w, d, yaw] of [[-20, -150, 3.5, 2, 0.2], [21, -195, 3, 1.8, 1.2], [-23, -186, 3.5, 2.2, 0.6], [15, -152, 2.2, 1.4, 0.3], [6, -194, 2.6, 1.6, 0.9]]) B.puddle(x, z, w, d, yaw);
  for (const [x, z] of [[-10, -160], [8, -188], [18, -165], [-18, -199]]) B.decal('papers', x, z, 2.4, 2.4, rng() * 6);
  B.decal('leaves', 12, -180, 5, 5, 0.3);
  B.decal('leaves', -14, -165, 4, 4, 1.3);
  // Centrepieces
  fountain(B, { x: 0, z: -176, r: 5.5 });
  statue(B, { x: -10, z: -187.5, w: 2.8, plinth: 2.4, yaw: 0 });
  for (const [x, z] of [[-13, -160], [13, -160], [13, -192], [-15, -194]]) planter(B, { x, z, w: 3, d: 1.4, h: 1.15, tree: true });
  for (const [x, z, yaw] of [[0, -167.2, S], [-7, -176, W], [7.2, -176, E], [0, -184.8, N]]) bench(B, { x, z, yaw, broken: rng() < 0.3 });
  for (const [x, z] of [[-17, -157], [17, -157], [17, -194], [-17, -194]]) streetlight(B, { x, z, yaw: x > 0 ? W : E, h: 6 });
  streetlight(B, { x: -17.8, z: -175, yaw: E, h: 6, state: 'flicker', intensity: 30, stealthRadius: 5.5 });
  kiosk(B, { x: -14, z: -169, yaw: W });
  busShelter(B, { x: 26.2, z: -171, yaw: W });
  belongings(B, { x: 24, z: -170, n: 6, spread: 2.2 });
  belongings(B, { x: -2, z: -160, n: 4, spread: 2 });
  belongings(B, { x: 8, z: -196, n: 3, spread: 1.5 });
  newsBox(B, { x: 25.8, z: -166, yaw: W });
  trashBags(B, { x: 26.5, z: -184, n: 4, spread: 0.8 });
  trashBags(B, { x: -26.5, z: -196, n: 5, spread: 1 });
  dumpster(B, { x: 26.6, z: -152.5, yaw: E });
  // Ring-road wrecks (the east side is the dark way round)
  car(B, { x: 22.6, z: -160.5, yaw: 0.12, type: 'sedan' });
  car(B, { x: -21.5, z: -151.5, yaw: 1.45, type: 'hatch', burnt: true });
  car(B, { x: 22.4, z: -187.5, yaw: 0.04, type: 'van', color: color(0x2b3530) });
  car(B, { x: -21.8, z: -197.5, yaw: 1.3, type: 'sedan', door: true });
  car(B, { x: 13.5, z: -200.6, yaw: 1.62, type: 'hatch' });
  car(B, { x: 21.5, z: -199, yaw: -0.3, type: 'sedan', burnt: true });
  car(B, { x: -22.5, z: -182, yaw: -0.1, type: 'pickup' });
  car(B, { x: 11.5, z: -168.5, yaw: 0.6, type: 'sedan', burnt: true, fire: true, fireScale: 1.2 });
  // Gas station with the alarm car at the pumps
  const gas = gasCanopy(B, { x: -31, z: -169, w: 12, d: 14, h: 5 });
  fuelSign(B, { x: -26.8, z: -184.5, yaw: E });
  B.light({ pos: gas.tubes[1], color: 0xd8f0e8, intensity: 28, distance: 12, stealthRadius: 5, stealthWeight: 0.7, selfFlicker: true, flickerStyle: 'failing', halo: { size: 0.9, intensity: 1.0 } });
  b.box('emissive', mat(gas.tubes[1].x, 4.88, gas.tubes[1].z), 0.2, 0.04, 5.5, color(0xc8e8dc), { faces: FACE.ny });
  // The alarm car waits at the canopy's edge, within earshot of everyone guarding the arch.
  const plazaAlarm = car(B, { x: -25.0, z: -171.2, yaw: 0.06, type: 'sedan', color: color(0x7a1d18), alarm: 'plaza_alarm' });
  car(B, { x: -31, z: -168.5, yaw: 0.04, type: 'hatch', door: true });
  // Fire barrel by the arch: lights the snatchers clustered at the exit.
  barrel(B, { x: -8.6, z: -203, fire: true, light: { stealthRadius: 6.5 } });
  barrel(B, { x: -9.3, z: -203.8 });
  crate(B, { x: 9.5, z: -203.5, yaw: 0.2, s: 0.9, stack: 2 });
  pallets(B, { x: 11, z: -203.2, yaw: 0.1, n: 2 });
  // Graffiti
  B.graffiti(GRAFFITI.noise, 27.98, 1.2, -140.5, W, 3.6, 1.8, 'NOISE PULLS THEM — throw a bottle (F or left click) and they go to look. A car alarm carries much further.', { range: 12 });
  B.graffiti(GRAFFITI.eye, -27.98, 1.5, -152, E, 2.6, 1.3);
  B.graffiti(GRAFFITI.tags, -39.98, 1.0, -160, E, 3, 1.5);
  B.graffiti(GRAFFITI.here, 27.98, 1.6, -196, W, 3, 1.5);

  // ==========================================================================================
  // Z3 — THE BOULEVARD (x -17.5..17.5, z -218..-338). Wide, open, almost no cover.
  bld({ x0: -40, x1: -17.5, z0: -260, z1: -218, h: 40, style: 'concrete', store: { e: true }, lit: 0.04 });
  bld({ x0: -40, x1: -17.5, z0: -300, z1: -262, h: 52, style: 'stone', store: { e: true }, lit: 0.05 });
  bld({ x0: -40, x1: -17.5, z0: -338, z1: -302, h: 34, style: 'brick', store: { e: true }, fireEscape: ['e'], lit: 0.06 });
  bld({ x0: 17.5, x1: 40, z0: -250, z1: -218, h: 46, style: 'brick', store: { w: true }, fireEscape: ['w'], lit: 0.05 });
  bld({ x0: 17.5, x1: 40, z0: -292, z1: -252, h: 60, style: 'concrete', store: { w: true }, lit: 0.05 });
  bld({ x0: 17.5, x1: 40, z0: -338, z1: -294, h: 38, style: 'stone', store: { w: true }, lit: 0.04 });
  for (const [z0, z1] of [[-262, -260], [-302, -300]]) fence(B, -18.4, z0, -18.4, z1, { h: 2.6 });
  for (const [z0, z1] of [[-252, -250], [-294, -292]]) fence(B, 18.4, z0, 18.4, z1, { h: 2.6 });
  // surfaces: sidewalks, two roads, a raised dead-grass median with trees
  sidewalk(-17.5, -13.5, -338, -218, 'e');
  sidewalk(13.5, 17.5, -338, -218, 'w');
  road(-13.5, -6.5, -338, -218, false, 0.06, 0.5);
  road(6.5, 13.5, -338, -218, false, 0.5, 0.94);
  b.box('grass', mat(0, 0, -278), 13, 0.14, 116, color(0xe8d8c8), { uvScale: 5, ao: 0, faces: FACE.py });
  for (const sx of [-1, 1]) b.box('rough', mat(sx * 6.4, 0, -278), 0.25, 0.16, 116, color(0x7a746e), { ao: 0, uvScale: 1.5 });
  b.box('rough', mat(0, 0, -219.9), 13, 0.16, 0.25, color(0x7a746e), { ao: 0 });
  b.box('rough', mat(0, 0, -336.1), 13, 0.16, 0.25, color(0x7a746e), { ao: 0 });
  crosswalk(-17, 17, -221.5);
  for (const z of [-232, -266, -300, -330]) for (const sx of [-1, 1]) deadTree(B, { x: sx * 4.2, z: z + rng() * 4, h: 6 + rng() * 2 });
  for (const z of [-240, -276, -312]) streetlight(B, { x: 0.4, z, yaw: rng() < 0.5 ? E : W, h: 7.5 });
  for (const [x, z, w, d, yaw] of [[-10, -240, 3, 2, 0.3], [9, -262, 3.5, 2, 1.0], [-11, -300, 3, 1.8, 0.5], [10, -318, 2.5, 1.6, 0.2], [-3, -284, 2.5, 1.5, 0.8]]) B.puddle(x, z, w, d, yaw);
  for (const [x, z] of [[-9, -228], [11, -246], [-14, -270], [8, -296], [-6, -322], [14, -334]]) B.decal('papers', x, z, 2.4, 2.4, rng() * 6);
  for (const [x, z] of [[0, -250], [-2, -288], [3, -320]]) B.decal('leaves', x, z, 5, 5, rng() * 6);
  // Cover pockets, ~17 m apart: each shields from both sides of the boulevard.
  planter(B, { x: -3.6, z: -235, w: 3.2, d: 1.4, h: 1.2 });
  planter(B, { x: 3.2, z: -236.5, w: 3.2, d: 1.4, h: 1.2, yaw: 0.1 });
  bench(B, { x: 0, z: -233, yaw: S });
  bus(B, { x: -4.1, z: -252.5, yaw: 0.06, burnt: true, articulated: false });
  car(B, { x: 1.2, z: -253.5, yaw: -0.08, type: 'sedan', burnt: true });
  statue(B, { x: -2.3, z: -270.5, w: 3.6, plinth: 2.8, yaw: 0.0 });
  planter(B, { x: 3.4, z: -270, w: 1.4, d: 3.4, h: 1.2 });
  kiosk(B, { x: 2.9, z: -287.2, yaw: W });
  crate(B, { x: 2.7, z: -290.3, yaw: 0.2, s: 0.85, stack: 2 });
  car(B, { x: -1.5, z: -288.6, yaw: 0.03, type: 'sedan', burnt: true });
  dumpster(B, { x: -4.4, z: -284.5, yaw: 0.9, color: color(0x2a3446) });
  overturnedTruck(B, { x: -1.4, z: -305, yaw: 0.04 });
  // its cargo spilled along the east side forms the other wall of the pocket
  for (const [x, z, n] of [[2.9, -301.8, 2], [3.0, -304.2, 2], [2.8, -306.6, 2], [3.1, -308.8, 1]]) crate(B, { x, z, yaw: (rng() - 0.5) * 0.4, s: 0.85, stack: n });
  car(B, { x: -4.6, z: -322.5, yaw: 0.25, type: 'hatch' });
  car(B, { x: 1.9, z: -323.5, yaw: -0.2, type: 'pickup' });
  // Sparse edge clutter (not enough to hide in)
  for (const [x, z] of [[-15.8, -229], [15.8, -241], [-15.8, -291], [15.8, -312]]) newsBox(B, { x, z, yaw: x > 0 ? W : E });
  car(B, { x: -10.5, z: -258, yaw: 0.06, type: 'sedan' });
  car(B, { x: 10.2, z: -280, yaw: PI - 0.05, type: 'hatch', burnt: true });
  car(B, { x: 10.6, z: -232, yaw: PI + 0.1, type: 'sedan' });
  car(B, { x: -10.2, z: -318, yaw: 0.1, type: 'van', burnt: true });
  for (const [x, z] of [[-9, -244], [7, -268], [-8, -296], [9, -330], [0, -228]]) belongings(B, { x, z, n: 4, spread: 2 });
  // A fire high in the tallest tower lights the boulevard from above (no stealth effect).
  // (BE2's west face is at x = 17.5: the burning window and its flames sit just in front of it.)
  b.wall('emissive', 17.47, 24.4, -277.5, 6.4, 2.6, W, [0, 0, 1, 1], color(0xff6a20));
  B.fire(new THREE.Vector3(17.0, 24.6, -276.2), 2.2, { stealthRadius: 0.1, stealthWeight: 0, intensity: 90, distance: 36 });
  B.fire(new THREE.Vector3(17.1, 24.6, -279.0), 1.7, false);
  B.fire(new THREE.Vector3(17.2, 27.8, -277.6), 1.3, false);
  // Graffiti: the rule of the boulevard
  B.graffiti(GRAFFITI.calls, 3.48, 1.2, -212.2, W, 4.6, 2.3, 'WHEN IT CALLS THEY LISTEN — when the giant calls, they freeze and look up. Blind and deaf until it ends.', { range: 9, duration: 7 });
  // (centred on the planter's south face: x -5.2..-2.0)
  B.graffiti(GRAFFITI.move, -3.6, 0.12, -234.28, S, 2.4, 1.0, 'MOVE WHEN IT CALLS. Freeze behind cover between calls.', { range: 8 });
  B.graffiti(GRAFFITI.tally, -17.48, 1.4, -322, E, 2.4, 1.2);

  // ==========================================================================================
  // Z4 — HIGHWAY APPROACH (road x -12..12), the gate at z -395, the parking structure west.
  bld({ x0: 16, x1: 44, z0: -432, z1: -338, h: 9.5, style: 'concrete', store: {}, lit: 0.01, roof: true });
  bld({ x0: 44, x1: 70, z0: -400, z1: -338, h: 34, style: 'brick', store: {} });
  bld({ x0: -70, x1: -44, z0: -430, z1: -338, h: 26, style: 'concrete', store: {} });
  fence(B, 13.6, -338, 13.6, -446, { h: 2.6 });
  wall(B, 12.1, -338.2, 17.6, -338.2, { h: 1.4, t: 0.4, color: color(0x8a847e) });
  b.flat('rough', 14.8, 0.01, -392, 2.2, 108, 0, [0, 0, 1, 50], color(0x3a302a));
  // Sound wall on the east, beyond the barriers (end of the route)
  for (let z = -400; z > -446; z -= 6) b.box('rough', mat(15.2, 0, z - 3), 0.5, 3.6, 6, color(0x6e6862), { ao: 0.3, uvScale: 3 });
  B.solid(15.2, -423, 0.5, 46, 3.6, 0, { tag: 'wall' });
  // Road surface + markings
  b.flat('road', -6, 0.01, -392, 12, 108, 0, [0, 0, 0.75, 108 / 16], color(0xe0dcd8));
  b.flat('road', 6, 0.01, -392, 12, 108, 0, [0.25, 0, 1.0, 108 / 16], color(0xe0dcd8));
  // Jersey barriers lining both sides (gap on the west for the garage exit)
  barrierLine(B, 12.4, -339, 12.4, -446);
  barrierLine(B, -12.4, -339, -12.4, -417.5);
  barrierLine(B, -12.4, -423.9, -12.4, -446);
  // Overpass high above the road
  {
    const z = -368;
    b.box('rough', mat(0, 11.2, z), 220, 1.5, 13, color(0x8a8480), { ao: 0, uvScale: 4 });
    B.solid(0, z, 60, 13, 1.5, 0, { y: 11.2, blocksMove: false, tag: 'deck' }); // overhead: stops lobbed bottles only
    b.box('rough', mat(0, 12.7, z - 6.2), 220, 1.1, 0.4, color(0x7a7470), { ao: 0 });
    b.box('rough', mat(0, 12.7, z + 6.2), 220, 1.1, 0.4, color(0x7a7470), { ao: 0 });
    for (const x of [-6.6, 6.6, -26, 26, -48, 48]) {
      b.box('rough', mat(x, 0, z), 1.6, 11.2, 3.2, color(0x9a948e), { ao: 0.45 });
      b.box('rough', mat(x, 10.2, z), 3.2, 1.0, 10, color(0x8a8480), { ao: 0 });
      if (Math.abs(x) < 30) B.solid(x, z, 1.6, 3.2, 11.2, 0, { tag: 'pier' });
    }
    for (let x = -60; x < 60; x += 9) b.box('metal', mat(x, 12.7, z - 6.3), 0.08, 1.4, 0.08, COL.darkSteel, { ao: 0 });
  }
  // Queue of cars abandoned on the way out of the city
  car(B, { x: -6.8, z: -342.5, yaw: W + 0.1, type: 'sedan' });
  car(B, { x: -7.2, z: -352.5, yaw: 0.05, type: 'sedan', door: true });
  car(B, { x: 6.5, z: -356, yaw: -0.08, type: 'pickup' });
  car(B, { x: -2.6, z: -360.5, yaw: 0.2, type: 'hatch', door: true, doorSide: 1 });
  car(B, { x: 7.2, z: -379, yaw: 0.02, type: 'sedan', door: true, doorSide: 1 });
  car(B, { x: -7.0, z: -381, yaw: -0.1, type: 'hatch' });
  car(B, { x: 2.2, z: -386, yaw: 0.15, type: 'sedan', burnt: true });
  car(B, { x: -6.2, z: -406, yaw: 0.1, type: 'van', door: false });
  car(B, { x: 5.8, z: -414, yaw: -0.15, type: 'sedan', burnt: true });
  car(B, { x: -3.4, z: -436, yaw: 0.3, type: 'hatch' });
  for (const [x, z] of [[-4, -355], [3, -372], [-1, -398], [4, -425], [-8, -420]]) belongings(B, { x, z, n: 5, spread: 2.5 });
  for (const [x, z, w, d, yaw] of [[0, -347, 3, 2, 0.2], [-4, -390, 3.5, 2, 0.8], [6, -402, 3, 1.8, 0.1], [-2, -428, 4, 2.4, 0.3]]) B.puddle(x, z, w, d, yaw);
  // The gate: a temporary fence across the road; the middle leaves are chained (dynamic, Level).
  const GATE_Z = -395;
  fence(B, -12.1, GATE_Z, -3.1, GATE_Z, { h: 2.6 });
  fence(B, 3.1, GATE_Z, 12.1, GATE_Z, { h: 2.6 });
  for (const x of [-12, -6, -3.05, 3.05, 6, 12]) B.wire(new THREE.Vector3(x, 2.75, GATE_Z), new THREE.Vector3(x + 3, 2.75, GATE_Z), 0.08, 3);
  for (const x of [-10.6, -8.2, 8.2, 10.6]) barricade(B, { x, z: GATE_Z + 0.4, yaw: 0, w: 2.2, sign: Math.abs(x) < 10 });
  // Floodlight tower lighting the gate (danger while cutting the chain)
  {
    const x = 9.6, z = -389.5;
    b.box('paint', mat(x, 0, z, 0.3), 1.8, 0.9, 1.2, color(0x8a7a30), { ao: 0.4 });
    b.geom('metal', cylX(0.05, 0.05, 4), mat(x, 0, z), COL.darkSteel);
    b.box('metal', mat(x, 0.9, z), 0.12, 4.2, 0.12, COL.darkSteel, { ao: 0 });
    b.box('metal', mat(x - 0.5, 4.9, z - 0.2, 0.6, -0.4), 1.4, 0.5, 0.25, COL.darkSteel, { ao: 0 });
    b.box('emissive', mat(x - 0.5, 4.9, z - 0.33, 0.6, -0.4), 1.25, 0.4, 0.02, color(0xf4f8ff), { faces: FACE.nz });
    B.solid(x, z, 1.8, 1.2, 1.0, 0.3, { tag: 'generator' });
    // The lamp is aimed at the chain: the registered source sits over the lit patch in front of
    // the gate (so whoever cuts the chain stands well inside its stealth radius); the halo stays
    // on the lamp head.
    B.light({ pos: { x: 3.6, y: 4.4, z: -392.8 }, color: 0xe6eef4, intensity: 80, distance: 20, stealthRadius: 8.5, stealthWeight: 0.95, flicker: 0.05 });
    B.glow.add(new THREE.Vector3(x - 0.55, 4.95, z - 0.45), 0xe6eef4, 1.4, 2.4);
  }
  // Booth by the gate
  kiosk(B, { x: -9.6, z: -390, yaw: E });
  // Beyond the gate: gantry, the city limits, the road on into the mist.
  gantry(B, { x0: -12.8, x1: 12.8, z: -407, h: 6, signs: [{ x: -5.5, w: 6.8, sign: 'highway1' }, { x: 5.5, w: 6.8, sign: 'highway2' }] });
  {
    const x = 10.0, z = -421;
    for (const sx of [-1.1, 1.1]) b.geom('metal', cyl(0.05, 0.05, 3.6, 6), mat(x + sx, 0, z), COL.steel);
    b.wall('signs', x, 2.0, z, 3.4, 1.7, S, signUV('limits'));
    b.box('metal', mat(x, 2.0, z - 0.04), 3.4, 1.7, 0.05, COL.darkSteel, { ao: 0 });
    B.solid(x, z, 2.6, 0.3, 3.6, 0, { tag: 'sign', blocksSight: false });
  }
  for (const [x, z] of [[-14.5, -440], [14.5, -440]]) powerPole(B, { x, z });
  B.solid(0, -448.5, 44, 5, 4, 0, { tag: 'edge' }); // the exit trigger fires long before this
  // The parking structure (quiet route)
  garage(B, footprints);
  // The river and the bridge out, fading into the mist.
  bridge(B);
  // Graffiti
  // (sized to the 1.6 m wide overpass pier, slightly condensed)
  B.graffiti(GRAFFITI.gate, -6.6, 1.4, -366.38, S, 1.55, 1.0, 'THE GATE IS LOUD — cutting the chain will be heard. Pick your moment, or find another way round.', { range: 12 });
  B.graffiti(GRAFFITI.quiet, -15.2, 3.4, -337.8, S, 3.6, 1.8, 'QUIET WAY — the parking structure. Something sleeps in there.', { range: 14 });
  // (on the sloped face of the jersey barriers, x -12.27..-12.31 between y 0.32 and 1.05)
  B.graffiti(GRAFFITI.bridge, -12.27, 0.3, -411, E, 2.2, 0.75, 'BRIDGE → OUT', { range: 8 });
  B.graffiti(GRAFFITI.names, 14.93, 0.6, -425.5, W, 4.4, 2.2, 'NOBODY REMEMBERS THE NAMES', { range: 10 });

  // ==========================================================================================
  // Distant skyline in every direction (no colliders)
  const keep = [
    ...footprints.map((r) => ({ ...r, pad: 3 })),
    ...ROUTE_RECTS.map((r) => ({ ...r, pad: 8 })),
    { minX: -460, maxX: 460, minZ: -720, maxZ: -452, pad: 0 }, // the river
  ];
  skyline(B, {
    minX: -420, maxX: 420, minZ: -820, maxZ: 300, cell: 26,
    keepOut: (x, z) => keep.some((r) => x > r.minX - r.pad - 13 && x < r.maxX + r.pad + 13 && z > r.minZ - r.pad - 13 && z < r.maxZ + r.pad + 13),
  });

  // ==========================================================================================
  // Gameplay data
  const zones = [
    zone(0, 'alley', 'The Alley', rect(-60, 70, -20, 30), 'Get to the street.', { x: 62, z: -118 }, 'calm',
      'C to crouch. E to pick things up, F or left click to throw.'),
    zone(1, 'main', 'Main Street', rect(-60, 70, -138, -20), 'Get up the street. Stay low, stay out of the light.', { x: 62, z: -150 }, 'calm',
      'Keep the wrecks between you and them.'),
    zone(2, 'plaza', 'The Civic Plaza', rect(-60, 70, -212, -138), 'Get through the arch on the north side.', { x: 48, z: -212 }, 'calm',
      'They go to noise. Some cars still have alarms.'),
    zone(3, 'boulevard', 'The Boulevard', rect(-60, 70, -338, -212), 'Cross the boulevard.', { x: 0, z: -278 }, 'near',
      'Wait for the call. Then move.'),
    zone(4, 'overpass', 'The Overpass', rect(-60, 70, -460, -338), 'Get past the gate. Leave the city.', { x: 62, z: -405 }, 'calm',
      'The chain will be heard. There may be a quieter way round.'),
  ];
  const checkpoints = [
    { id: 'start', order: 0, pos: { x: 0, z: 4 }, yaw: 0, bottles: 0, zone: 0, area: rect(-3, 3, 0, 8) },
    { id: 'main', order: 1, pos: { x: 0, z: -21.5 }, yaw: 0, bottles: 1, zone: 1, area: rect(-3, 3, -24, -20) },
    // Every way into a zone crosses its checkpoint's area (the Z4 area spans both the road and the
    // parking-structure entrance, so the quiet route also saves progress).
    { id: 'plaza', order: 2, pos: { x: 20.7, z: -139.5 }, yaw: 0.25, bottles: 1, zone: 2, area: rect(13, 28, -142, -137) },
    { id: 'boulevard', order: 3, pos: { x: 6, z: -220.6 }, yaw: 0.35, bottles: 1, zone: 3, area: rect(-3.5, 9, -223, -212.2) },
    { id: 'overpass', order: 4, pos: { x: -8.2, z: -347 }, yaw: 0, bottles: 1, zone: 4, area: rect(-18, 12, -350, -338.5) },
  ];
  // Patrol routes: every leg (including the loop's closing leg) is a straight, walkable line, so an
  // AI that walks point to point without path-finding still never pushes through a wreck.
  const enemies = [
    // Z0: glimpsed far ahead, crossing Main Street through the firelight (there and back).
    {
      id: 'z0_crosser', zone: 0, kind: 'patrol', pos: { x: -19, z: -73.5 }, yaw: E,
      route: [{ x: -19, z: -73.5 }, { x: -9, z: -74.5 }, { x: 9, z: -74 }, { x: 19, z: -77 }, { x: 9, z: -74 }, { x: -9, z: -74.5 }],
      loop: true, pause: 4,
    },
    // Z1: patrol up the east lanes and back down the west; sentry in the laundromat light.
    {
      id: 'z1_patrol', zone: 1, kind: 'patrol', pos: { x: 2.5, z: -51 }, yaw: N,
      route: [{ x: 2.5, z: -51 }, { x: 4.75, z: -54.25 }, { x: 4.75, z: -56.25 }, { x: 3.5, z: -60 }, { x: 2.5, z: -72 }, { x: 0.5, z: -90 },
        { x: -1.8, z: -112 }, { x: -2.5, z: -100 }, { x: -1, z: -86 }, { x: -1.25, z: -78.25 }, { x: -6.5, z: -70 }, { x: -7, z: -56 }, { x: -1, z: -51 }],
      loop: true, pause: 2.5,
    },
    { id: 'z1_sentry', zone: 1, kind: 'sentry', pos: { x: -9.6, z: -90.3 }, yaw: E, scanArc: 1.7, scanPeriod: 9 },
    // Z2: a cluster around the arch, lit by the fire barrel.
    { id: 'z2_sentry_w', zone: 2, kind: 'sentry', pos: { x: -5.5, z: -198 }, yaw: S - 0.25, scanArc: 1.5, scanPeriod: 10 },
    { id: 'z2_sentry_e', zone: 2, kind: 'sentry', pos: { x: 5, z: -199.5 }, yaw: S + 0.35, scanArc: 1.4, scanPeriod: 8 },
    { id: 'z2_wander', zone: 2, kind: 'wander', pos: { x: -1, z: -192 }, radius: 5 },
    { id: 'z2_patrol', zone: 2, kind: 'patrol', pos: { x: -15, z: -199.5 }, yaw: E, route: [{ x: -15, z: -199.5 }, { x: 8, z: -197.5 }], loop: true, pause: 3 },
    // Z3: devout watchers on both sidewalks, facing across the open ground.
    { id: 'z3_devout_1', zone: 3, kind: 'devout', pos: { x: -15.2, z: -243 }, yaw: E - 0.15, scanArc: 1.7, scanPeriod: 12 },
    { id: 'z3_devout_2', zone: 3, kind: 'devout', pos: { x: 15.2, z: -259 }, yaw: W, scanArc: 1.8, scanPeriod: 11 },
    { id: 'z3_devout_3', zone: 3, kind: 'devout', pos: { x: -15.2, z: -278 }, yaw: E, scanArc: 1.8, scanPeriod: 13 },
    { id: 'z3_devout_4', zone: 3, kind: 'devout', pos: { x: 15.2, z: -296 }, yaw: W, scanArc: 1.8, scanPeriod: 10 },
    { id: 'z3_devout_5', zone: 3, kind: 'devout', pos: { x: -15.2, z: -313 }, yaw: E, scanArc: 1.7, scanPeriod: 12 },
    { id: 'z3_devout_6', zone: 3, kind: 'devout', pos: { x: 15.2, z: -326 }, yaw: W - 0.2, scanArc: 1.6, scanPeriod: 11 },
    // Z4: a patrol on the ramp in front of the gate (always within earshot of the chain, and
    // never closer than 30 m to the Z4 checkpoint); one asleep in the parking structure.
    { id: 'z4_patrol', zone: 4, kind: 'patrol', pos: { x: 4.5, z: -391 }, yaw: W, route: [{ x: 4.5, z: -391 }, { x: -4.5, z: -391.5 }, { x: -4.2, z: -378.5 }, { x: 0.5, z: -376.5 }, { x: 4.5, z: -380 }], loop: true, pause: 2.5 },
    { id: 'z4_sleeper', zone: 4, kind: 'sentry', sleeping: true, pos: { x: -18.4, z: -388 }, yaw: E, scanArc: 0.4, scanPeriod: 14 },
  ];
  const pickups = [
    { x: 0.9, z: -2.7, zone: 0 },
    { x: 11.3, z: -50.6, zone: 1 }, // on the kerb beside the pickup truck (not under it)
    { x: 8.2, z: -68.5, zone: 1 },
    { x: 17.6, z: -146.6, zone: 2 },
    { x: -24.6, z: -158.6, zone: 2 },
    { x: -37.2, z: -176.8, zone: 2 },
    { x: -1.3, z: -250.5, zone: 3 },
    { x: -10.2, z: -349.8, zone: 4 },
    { x: -30.6, z: -373.5, zone: 4 },
  ];
  return {
    bounds: { minX: -48, maxX: 32, minZ: -450, maxZ: 11 },
    zones,
    checkpoints,
    enemies,
    pickups,
    alarms: [
      { id: 'main_alarm', car: z1Alarm, zone: 1 },
      { id: 'plaza_alarm', car: plazaAlarm, zone: 2 },
    ],
    gate: { id: 'gate', x: 0, z: GATE_Z, halfWidth: 3, h: 2.5, order: 4.5 },
    leviathanRoute: [
      { x: 70, z: 40 }, { x: 76, z: -60 }, { x: 64, z: -150 }, { x: 46, z: -214 }, { x: 0, z: -278 },
      { x: 38, z: -345 }, { x: 68, z: -420 }, { x: 88, z: -540 },
    ],
    titleCamera: { pos: [-3.2, 1.7, -27.5], target: [14, 21, -105] },
    exitZ: -430,
    routeRects: ROUTE_RECTS,
    footprints,
  };
}

function zone(index, id, name, bounds, objective, anchor, calls, hint) {
  return { id, index, name, bounds, objective, hint, leviathan: { anchor, calls } };
}

// Burnt-out pharmacy: storefront on Main Street, a dark shop floor, a back door into the yard.
function pharmacy(B, footprints) {
  const b = B.batch;
  const x0 = 12, x1 = 28, z0 = -136, z1 = -110, H = 4.4;
  footprints.push(rect(x0, x1, z0, z1));
  building(B, { x0, x1, z0, z1, h: 13.6, y0: H, style: 'brick', faces: ['n', 'w'], lit: 0.03, collider: true, fireEscape: [] });
  const char = color(0x4a3e36);
  const t = 0.35;
  const doorZ0 = -121.2, doorZ1 = -117.6, backX0 = 19.2, backX1 = 22.6;
  // West front (Main Street): wall segments either side of the door, storefront texture outside.
  const front = [[z0, doorZ0], [doorZ1, z1]];
  for (const [za, zb] of front) {
    wall(B, x0 + t / 2, za, x0 + t / 2, zb, { h: H, t, color: char });
    const len = zb - za;
    const n = Math.max(1, Math.round(len / 6));
    for (let i = 0; i < n; i++) {
      const zc = za + (len / n) * (i + 0.5);
      b.wall('store', x0 - 0.02, 0, zc, len / n, H, W, storeUV(i % 2 ? STORE.smashed : STORE.pharmacy), color(0xd0c8c0));
    }
  }
  b.box('rough', mat(x0 - 0.1, H, (z0 + z1) / 2), 0.4, 0.35, z1 - z0, color(0x2a2420), { ao: 0 });
  // Door frame and a fallen sign
  b.box('rough', mat(x0, H - 0.5, (doorZ0 + doorZ1) / 2), t + 0.1, 0.5, doorZ1 - doorZ0, char, { ao: 0 });
  b.box('rough', mat(x0 - 1.4, 0, -114.5, 0.4, 0, 0.12), 0.08, 0.9, 3.6, color(0x3a4a40), { ao: 0 });
  // North (back) wall with the back door, outer face plain dark brick
  wall(B, x0, z0 + t / 2, backX0, z0 + t / 2, { h: H, t, color: char });
  wall(B, backX1, z0 + t / 2, x1, z0 + t / 2, { h: H, t, color: char });
  b.box('rough', mat((backX0 + backX1) / 2, H - 1.4, z0 + t / 2), backX1 - backX0, 1.4, t + 0.1, char, { ao: 0 });
  b.box('paint', mat(backX1 + 0.35, 0, z0 - 0.75, 1.2), 1.4, 2.4, 0.08, color(0x2e3a34), { ao: 0.2 }); // door hanging open
  // Inner faces over the neighbours' facades + ceiling + floor
  wall(B, x1 - t / 2, z0, x1 - t / 2, z1, { h: H, t, color: char });
  wall(B, x0, z1 - t / 2, x1, z1 - t / 2, { h: H, t, color: char });
  b.box('rough', mat((x0 + x1) / 2, H - 0.2, (z0 + z1) / 2), x1 - x0, 0.2, z1 - z0, color(0x1c1816), { faces: FACE.ny, ao: 0 });
  b.flat('paving', (x0 + x1) / 2, 0.02, (z0 + z1) / 2, x1 - x0, z1 - z0, 0, [0, 0, 4, 6.5], color(0x8a8078));
  B.decal('scorch', 16, -126, 9, 9, 0.3);
  B.decal('scorch', 24, -116, 7, 7, 1.1);
  B.decal('papers', 20.5, -130, 3, 3, 0.2);
  B.decal('papers', 15, -114, 3, 3, 1.2);
  // Shelving rows (cover), some toppled; counter at the back.
  const shelf = (x, z, len, yaw = 0, fallen = false) => {
    if (fallen) {
      b.box('metal', mat(x, 0, z, yaw, 0, 1.45), 0.6, 1.9, len, color(0x3a3634), { ao: 0.3 });
      B.solid(x, z, 1.7, len, 0.65, yaw, { tag: 'shelf' });
      return;
    }
    b.box('metal', mat(x, 0, z, yaw), 0.6, 1.9, len, color(0x4a4442), { ao: 0.5 });
    for (let y = 0.4; y < 1.9; y += 0.5) b.box('rough', mat(x, y, z, yaw), 0.62, 0.04, len, color(0x2a2624), { ao: 0 });
    B.solid(x, z, 0.62, len, 1.9, yaw, { tag: 'shelf' });
  };
  shelf(15.6, -116.5, 6);
  shelf(15.6, -127, 5);
  shelf(19.2, -115.5, 5);
  shelf(19.9, -125.5, 5.5, 0.35, true);
  shelf(23.6, -117, 6);
  shelf(23.6, -127.5, 5);
  b.box('rough', mat(14.6, 0, -132.2), 4.6, 1.1, 0.8, color(0x3a302a), { ao: 0.4 });
  B.solid(14.6, -132.2, 4.6, 0.8, 1.1, 0, { tag: 'counter' });
  for (let k = 0; k < 14; k++) {
    b.box('rough', mat(13 + B.rng() * 14, 0, -134 + B.rng() * 22, B.rng() * 6), 0.3 + B.rng() * 0.3, 0.2 + B.rng() * 0.2, 0.3 + B.rng() * 0.3, color(0x6a5e52).multiplyScalar(0.5 + B.rng() * 0.6), { ao: 0.3 });
  }
  // A dropped flashlight just inside the door, still on: the lure from the street.
  b.geom('metal', cylX(0.03, 0.22, 8), mat(14.6, 0.04, -120.2, 0.9), color(0x2a2a2a));
  b.box('emissive', mat(14.6 - 0.09, 0.015, -120.2 + 0.07, 0.9), 0.02, 0.05, 0.05, color(0xfff6e0));
  B.light({ pos: { x: 14.2, y: 0.25, z: -119.9 }, color: 0xf4ecd8, intensity: 9, distance: 7, stealthRadius: 2.5, stealthWeight: 0.4, flicker: 0.05, halo: { size: 0.25, intensity: 1.6 } });
  B.decal('papers', 14, -119.5, 1.6, 1.6, 2.2);
  // Ceiling tubes: all dead but one, which is failing.
  for (const z of [-115, -123, -131]) for (const x of [16, 24]) b.box('emissive', mat(x, H - 0.25, z), 0.18, 0.05, 2.4, color(0x141616), { faces: FACE.ny });
  B.light({ pos: { x: 20, y: H - 0.4, z: -123 }, color: 0xcfe2da, intensity: 32, distance: 13, stealthRadius: 4, stealthWeight: 0.5, selfFlicker: true, flickerStyle: 'dying', halo: { size: 0.7, intensity: 1.2 } });
  b.box('emissive', mat(20, H - 0.27, -123), 0.18, 0.05, 2.4, color(0xa8c8bc), { faces: FACE.ny });
}

// The bridge beyond the exit: deck, parapets, dead lamps, two cable-stayed pylons, a dark river.
function bridge(B) {
  const b = B.batch;
  const z0 = -446, z1 = -900, len = z0 - z1, cz = (z0 + z1) / 2;
  b.flat('water', 0, -7, -700, 1000, 520, 0, [0, 0, 1, 1], color(0x14181c));
  b.box('rough', mat(0, -7, -452.3), 1000, 7, 0.6, color(0x4a4440), { ao: 0, uvScale: 4 }); // embankment wall
  b.box('rough', mat(0, -1.4, cz), 26, 1.4, len, color(0x6a645e), { ao: 0, uvScale: 4 });
  b.flat('road', -6, 0.012, cz, 12, len, 0, [0, 0, 0.75, len / 16], color(0xe0dcd8));
  b.flat('road', 6, 0.012, cz, 12, len, 0, [0.25, 0, 1.0, len / 16], color(0xe0dcd8));
  for (const sx of [-1, 1]) {
    b.box('rough', mat(sx * 12.8, 0, cz), 0.5, 1.1, len, color(0x8a847e), { ao: 0.3, uvScale: 3 });
    b.box('metal', mat(sx * 12.8, 1.1, cz), 0.12, 0.12, len, COL.darkSteel, { ao: 0 });
    for (let z = z0 - 20; z > z1; z -= 32) streetlight(B, { x: sx * 12.6, z, yaw: sx > 0 ? W : E, h: 8 });
  }
  // Pylons with fanned stay cables
  for (const pz of [-575, -800]) {
    for (const sx of [-1, 1]) {
      b.box('rough', mat(sx * 15, -7, pz), 3, 85, 4, color(0x8a8480), { ao: 0.2, uvScale: 6 });
      for (let k = 1; k <= 7; k++) {
        const top = new THREE.Vector3(sx * 15, 70 - k * 1.5, pz);
        B.wire(top, new THREE.Vector3(sx * 13, 0.5, pz + k * 14), 0.6, 4);
        B.wire(top, new THREE.Vector3(sx * 13, 0.5, pz - k * 14), 0.6, 4);
      }
    }
    b.box('rough', mat(0, 62, pz), 33, 3, 3, color(0x8a8480), { ao: 0 });
    b.box('rough', mat(0, 38, pz), 33, 2, 2.4, color(0x8a8480), { ao: 0 });
  }
  // Abandoned cars on the bridge, facing out of the city
  car(B, { x: 5.5, z: -478, yaw: 0.08, type: 'sedan', door: true, doorSide: 1 });
  car(B, { x: -6, z: -505, yaw: -0.2, type: 'van' });
  car(B, { x: 2.5, z: -540, yaw: 0.5, type: 'hatch', burnt: true });
  car(B, { x: -4, z: -610, yaw: 0.1, type: 'pickup' });
}

// Three-level parking structure west of the road: dark, pillared, cars in bays.
function garage(B, footprints) {
  const b = B.batch;
  const x0 = -44, x1 = -13, z0 = -424, z1 = -338;
  footprints.push(rect(x0, x1, z0, z1));
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;
  const slab = color(0x7c7670);
  b.flat('rough', cx, 0.015, cz, w, d, 0, [0, 0, w / 4, d / 4], color(0x6a6460));
  // Ceiling collider: overhead only (above every eye line and agent), so it just stops thrown bottles.
  B.solid(cx, cz, w, d, 0.35, 0, { y: 3.1, blocksMove: false, tag: 'deck' });
  for (const y of [3.1, 6.2, 9.3]) {
    b.box('rough', mat(cx, y, cz), w + 0.4, 0.35, d + 0.4, slab, { ao: 0, uvScale: 5 });
    if (y < 9) {
      // upper-deck parapets on the street side and the boulevard end
      b.box('rough', mat(x1 + 0.05, y + 0.35, cz), 0.3, 1.0, d, slab, { ao: 0 });
      b.box('rough', mat(cx, y + 0.35, z1 + 0.05), w, 1.0, 0.3, slab, { ao: 0 });
    }
  }
  b.box('rough', mat(cx, 9.65, z1 + 0.05), w, 1.0, 0.3, slab, { ao: 0 });
  b.box('rough', mat(x1 + 0.05, 9.65, cz), 0.3, 1.0, d, slab, { ao: 0 });
  // Walls: solid west/north/south (behind other buildings), parapet + mesh on the street side.
  wall(B, x0, z0, x0, z1, { h: 9.3, t: 0.5, color: slab });
  wall(B, x0, z0, x1 + 0.9, z0, { h: 9.3, t: 0.5, color: slab });
  wall(B, x0, z1, -17.2, z1, { h: 3.1, t: 0.5, color: slab });
  b.box('rough', mat(-15.2, 2.5, z1), 4.2, 0.6, 0.5, slab, { ao: 0 });
  // street side: parapet (hides a crouched player) and chain-link above (blocks movement only)
  const exitZ0 = -424, exitZ1 = -417.6;
  b.box('rough', mat(x1, 0, (exitZ1 + z1) / 2), 0.4, 1.1, z1 - exitZ1, slab, { ao: 0.3 });
  B.solid(x1, (exitZ1 + z1) / 2, 0.4, z1 - exitZ1, 1.1, 0, { tag: 'parapet' });
  fence(B, x1, exitZ1, x1, z1, { h: 3.05 });
  // Entrance from the boulevard (south) with a lifted barrier arm and the sign
  B.batch.box('metal', mat(-13.8, 0, -337.6), 0.3, 1.0, 0.3, color(0x8a7a30), { ao: 0 });
  B.batch.box('paint', mat(-14.0, 1.0, -336.2, 0, 1.2), 0.08, 0.08, 3.2, color(0xc8b040), { ao: 0 });
  B.batch.wall('signs', -15.2, 2.0, z1 + 0.27, 2.0, 1.0, S, signUV('parking'));
  // second sign on the street side, readable from the road (and the checkpoint there)
  b.geom('metal', cyl(0.04, 0.04, 3.4, 6), mat(-12.95, 0, -341.2), COL.steel);
  B.batch.wall('signs', -12.88, 2.3, -341.2, 1.8, 0.9, E, signUV('parking'));
  // Pillar grid
  for (const x of [-37, -29, -21]) {
    for (let z = -346; z > z0 + 2; z -= 8) {
      b.box('rough', mat(x, 0, z), 0.7, 3.1, 0.7, color(0x8e8882), { ao: 0.5 });
      b.box('paint', mat(x, 0, z), 0.72, 1.0, 0.72, color(0x8a7a30), { ao: 0 }); // painted pillar base
      B.solid(x, z, 0.7, 0.7, 3.1, 0, { tag: 'pillar' });
    }
  }
  // Ramp block along the west wall
  b.box('rough', mat(-40.5, 0, -386, 0, -0.2), 6, 0.35, 15.5, slab, { ao: 0 });
  b.box('rough', mat(-40.5, 0, -386), 6, 1.4, 14, color(0x5a5450), { ao: 0.3 });
  B.solid(-40.5, -386, 6.2, 15, 3.1, 0, { tag: 'ramp' });
  // Bays: painted lines and parked cars (some gone, leaving gaps to slip between)
  for (const rowX of [-33, -25]) {
    for (let z = -346; z > -420; z -= 2.8) {
      b.flat('decal', rowX - 2.4, 0.03, z - 1.4, 0.1, 0.1, 0, decalUV('crosswalk'), color(0xc8c2b4));
      B.batch.flat('decal', rowX, 0.03, z - 1.4, 4.6, 0.1, 0, decalUV('crosswalk'), color(0xb8b2a4));
    }
  }
  const parked = [
    [-33, -350.5], [-33, -356.1], [-33, -367.3], [-33, -378.5], [-33, -384.1], [-33, -395.3], [-33, -403.7], [-33, -412.1],
    [-25, -353.3], [-25, -364.5], [-25, -370.1], [-25, -381.3], [-25, -392.5], [-25, -398.1], [-25, -409.3], [-25, -414.9],
    [-41, -352], [-41, -364], [-41, -404], [-41, -412],
  ];
  for (const [x, z] of parked) car(B, { x: x + (B.rng() - 0.5) * 0.3, z, yaw: (B.rng() < 0.5 ? E : W) + (B.rng() - 0.5) * 0.12, type: B.rng.pick(['sedan', 'sedan', 'hatch', 'pickup']) });
  // Upper-deck cars glimpsed through the openings
  for (const [x, z, y] of [[-17, -350, 3.45], [-17, -380, 3.45], [-18, -400, 6.55], [-17, -362, 6.55]]) {
    b.box('paint', mat(x, y + 0.3, z, 0.05), 1.8, 0.75, 4.6, B.rng.pick([color(0x3a3a3a), color(0x5a1a14), color(0x2a3446)]), { ao: 0.3 });
    b.box('glass', mat(x, y + 1.05, z + 0.2, 0.05), 1.5, 0.42, 2.4, color(0x9aa0a8), { ao: 0 });
  }
  // Light: one failing tube; a red EXIT sign over the way out.
  for (let z = -350; z > -420; z -= 12) for (const x of [-33, -17]) b.box('emissive', mat(x, 2.95, z), 0.18, 0.05, 1.6, color(0x121414), { faces: FACE.ny });
  B.light({ pos: { x: -25, y: 2.7, z: -362 }, color: 0xcfe0d8, intensity: 14, distance: 9, stealthRadius: 3.5, stealthWeight: 0.35, selfFlicker: true, flickerStyle: 'failing', halo: { size: 0.6, intensity: 1.0 } });
  b.box('emissive', mat(-25, 2.95, -362), 0.18, 0.05, 1.6, color(0x9ab8ac), { faces: FACE.ny });
  b.wall('signs', -15.5, 2.3, z0 + 0.27, 1.1, 0.55, S, signUV('exit'));
  B.glow.add(new THREE.Vector3(-15.5, 2.55, z0 + 0.6), 0xff2a1a, 0.5, 0.9);
  B.decal('oil', -29, -380, 3, 3, 0.4);
  B.decal('oil', -21, -405, 3, 3, 1.4);
  B.puddle(-17, -372, 3, 1.8, 0.2);
  B.decal('papers', -17.5, -395, 2.5, 2.5, 0.7);
  belongings(B, { x: -18, z: -402, n: 4, spread: 1.6 });
  // (on the pillars' east faces, x = pillar + 0.35)
  B.graffiti(GRAFFITI.eye, -20.64, 1.0, -394, E, 0.68, 0.34);
  B.graffiti(GRAFFITI.tally, -36.64, 1.2, -362, E, 0.68, 0.34);
}
