import * as THREE from 'three';
import { makeRng } from '../core/math.js';

// Falling ash and a few drifting embers in a box that wraps around the camera. All motion is in
// the vertex shader (no per-frame CPU work); one draw call per layer.
const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
uniform float uShake;
uniform float uSize;
uniform float uRise;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec3 uWind;
uniform vec3 uLightPos[ 6 ];
uniform vec4 uLightCol[ 6 ];
varying float vAlpha;
varying float vRot;
varying vec3 vLit;
varying float vSeed;

void main() {
  float ph = aSeed.w * 40.0;
  float sp = 0.6 + 0.8 * fract( aSeed.w * 7.13 );
  vec3 p = aSeed.xyz * uBox;
  p += uWind * uTime * sp;
  p.y += uRise * uTime * sp;
  p.x += sin( uTime * ( 0.5 + aSeed.w ) + ph ) * 0.45;
  p.z += cos( uTime * ( 0.4 + aSeed.y ) + ph * 1.3 ) * 0.45;
  p.y += sin( uTime * 1.3 + ph ) * 0.15;
  p += vec3( sin( uTime * 37.0 + ph ), 0.6 + 0.4 * sin( uTime * 23.0 + ph * 2.0 ), cos( uTime * 33.0 + ph ) ) * uShake * 0.35;
  vec3 rel = mod( p - uCam + 0.5 * uBox, uBox ) - 0.5 * uBox;
  vec3 world = uCam + rel;
  vec4 mv = viewMatrix * vec4( world, 1.0 );
  gl_Position = projectionMatrix * mv;
  float dist = - mv.z;

  vec3 e = abs( rel ) / ( 0.5 * uBox );
  vAlpha = 1.0 - smoothstep( 0.7, 1.0, max( e.x, max( e.y, e.z ) ) );
  vAlpha *= smoothstep( 0.0, 0.3, world.y );
  vAlpha *= smoothstep( 0.3, 1.2, dist );
  vAlpha *= exp( - dist * 0.055 );

  vLit = vec3( 0.0 );
  for ( int i = 0; i < 6; i ++ ) {
    vec3 d = uLightPos[ i ] - world;
    float d2 = dot( d, d );
    float win = 1.0 - smoothstep( 0.4, 1.0, sqrt( d2 ) / max( uLightCol[ i ].w, 0.1 ) );
    vLit += uLightCol[ i ].rgb * win / ( d2 + 1.0 );
  }

  float px = uSize * ( 0.55 + 0.9 * fract( aSeed.w * 13.7 ) ) * uScale / max( dist, 0.1 );
  if ( px < 1.5 ) { vAlpha *= px / 1.5; px = 1.5; }
  gl_PointSize = min( px, 32.0 );
  vRot = aSeed.w * 6.2831 + uTime * ( aSeed.x - 0.5 ) * 3.0;
  vSeed = aSeed.w;
}
`;

const FRAG_ASH = /* glsl */ `
uniform vec3 uColor;
uniform float uLitGain;
varying float vAlpha;
varying float vRot;
varying vec3 vLit;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float cs = cos( vRot ), sn = sin( vRot );
  c = vec2( c.x * cs - c.y * sn, c.x * sn + c.y * cs );
  c.y *= 1.8;
  float a = smoothstep( 0.5, 0.18, length( c ) ) * vAlpha;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( uColor + vLit * uLitGain, a );
}
`;

const FRAG_EMBER = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length( c );
  float core = smoothstep( 0.5, 0.0, d );
  float flick = 0.55 + 0.45 * sin( uTime * ( 6.0 + vSeed * 9.0 ) + vSeed * 50.0 );
  float a = core * core * vAlpha * flick;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

function makeLayer({ count, seed, box, wind, rise, size, color, frag, blending, lights }) {
  const rng = makeRng(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
  const geom = new THREE.BufferGeometry();
  // three needs a position attribute for the draw count; the shader only reads aSeed.
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = {
    uTime: { value: 0 },
    uScale: { value: 400 },
    uShake: { value: 0 },
    uSize: { value: size },
    uRise: { value: rise },
    uCam: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(...box) },
    uWind: { value: new THREE.Vector3(...wind) },
    uColor: { value: color },
    uLitGain: { value: 0.03 },
    uLightPos: { value: lights.pos },
    uLightCol: { value: lights.col },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending,
    fog: false,
  });
  const points = new THREE.Points(geom, material);
  points.frustumCulled = false;
  points.renderOrder = 10;
  return { points, uniforms };
}

export class Particles {
  constructor(scene, lights) {
    this.ash = makeLayer({
      count: 1600,
      seed: 77,
      box: [40, 22, 40],
      wind: [0.45, -0.32, 0.18],
      rise: 0,
      size: 0.035,
      color: new THREE.Color().setRGB(0.075, 0.052, 0.05),
      frag: FRAG_ASH,
      blending: THREE.NormalBlending,
      lights,
    });
    this.ash.points.name = 'ash';
    this.embers = makeLayer({
      count: 90,
      seed: 91,
      box: [44, 18, 44],
      wind: [0.55, 0.0, 0.25],
      rise: 0.28,
      size: 0.04,
      color: new THREE.Color().setRGB(4.5, 1.15, 0.28),
      frag: FRAG_EMBER,
      blending: THREE.AdditiveBlending,
      lights,
    });
    this.embers.points.name = 'embers';
    scene.add(this.ash.points, this.embers.points);
  }

  update(time, shake) {
    for (const layer of [this.ash, this.embers]) {
      layer.uniforms.uTime.value = time;
      layer.uniforms.uShake.value = shake;
    }
  }

  // Camera-dependent values, set right before rendering.
  prepare(camera, heightPx) {
    const scale = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const layer of [this.ash, this.embers]) {
      layer.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
      layer.uniforms.uScale.value = scale;
    }
  }
}
