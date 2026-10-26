import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { makeRng } from '../core/math.js';

// Renders the scene into a dedicated target that carries a depth texture, so later passes can
// reconstruct world positions (the composer's ping-pong targets never have depth attached, which
// keeps us clear of framebuffer feedback loops).
export class ScenePass extends Pass {
  constructor(scene, camera, samples = 0) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    this.target.texture.name = 'Atmosphere.scene';
    this.info = { calls: 0, triangles: 0 };
  }

  setSize(w, h) {
    this.target.setSize(w, h);
  }

  setSamples(n) {
    if (this.target.samples === n) return;
    this.target.samples = n;
    this.target.dispose(); // re-created with the new sample count on next use
  }

  render(renderer) {
    const before = renderer.info.render.calls, beforeTris = renderer.info.render.triangles;
    renderer.setRenderTarget(this.target);
    if (!renderer.autoClear) renderer.clear();
    renderer.render(this.scene, this.camera);
    this.info.calls = renderer.info.render.calls - before;
    this.info.triangles = renderer.info.render.triangles - beforeTris;
  }

  dispose() {
    this.target.dispose();
  }
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const LIGHT_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uLightPos[ 6 ];
uniform vec4 uLightCol[ 6 ];
`;

// Low-lying volumetric mist: raymarched at half resolution through a 0..uTop slab, 3D noise
// banks drifting on the wind, lit by the sky and by the pooled point lights (forward scattering
// gives the lamps and fires their halos). Output: rgb = inscattered light, a = transmittance.
const MARCH_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uDensity;
uniform float uTop;
uniform float uMaxDist;
uniform float uPuff;
uniform float uCall;
uniform float uFrame;
uniform float uHaze;
uniform float uMistGlow;
uniform vec2 uWind;
uniform vec3 uMistLow;
uniform vec3 uMistHigh;
${LIGHT_UNIFORMS_GLSL}
varying vec2 vUv;

float mistDensity( vec3 p ) {
  float h = p.y;
  float prof = exp( - max( h, 0.0 ) * 0.42 ) * smoothstep( - 0.1, 0.5, h ) * ( 1.0 - smoothstep( uTop * 0.55, uTop, h ) );
  vec3 q = ( p - vec3( uWind.x, - 0.05, uWind.y ) * uTime ) * vec3( 0.03, 0.075, 0.03 );
  q.xz += sin( vec2( uTime * 19.0 + p.y * 2.3, uTime * 15.0 + p.x * 0.4 ) ) * 0.004 * uCall;
  float n1 = texture( tNoise, q ).r;
  float n2 = texture( tNoise, q * 3.3 + vec3( 0.31, uTime * 0.012, 0.77 ) ).r;
  float n = n1 * 0.7 + n2 * 0.3;
  float d = smoothstep( 0.34 - uPuff * 0.14, 0.8, n );
  float puff = 1.0 + uPuff * 1.6 * ( 1.0 - smoothstep( 0.0, 1.8, h ) );
  return uDensity * prof * d * puff;
}

void main() {
  float depth = texture2D( tDepth, vUv ).x;
  vec4 vp = uProjInv * vec4( vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  vec3 wp = ( uCamWorld * vec4( vp.xyz / vp.w, 1.0 ) ).xyz;
  vec3 ray = wp - uCamPos;
  float sceneDist = length( ray );
  vec3 rd = ray / max( sceneDist, 1e-4 );
  if ( depth >= 0.999999 ) sceneDist = 1e5;

  float t0 = 0.0;
  float t1 = min( sceneDist, uMaxDist );
  if ( abs( rd.y ) > 1e-5 ) {
    float ta = ( 0.0 - uCamPos.y ) / rd.y;
    float tb = ( uTop - uCamPos.y ) / rd.y;
    t0 = max( t0, min( ta, tb ) );
    t1 = min( t1, max( ta, tb ) );
  } else if ( uCamPos.y > uTop || uCamPos.y < 0.0 ) {
    t1 = - 1.0;
  }

  vec3 L = vec3( 0.0 );
  float T = 1.0;
  if ( t1 > t0 ) {
    float jitter = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) + uFrame * 0.618034 );
    float span = t1 - t0;
    const float N = float( STEPS );
    for ( int i = 0; i < STEPS; i ++ ) {
      float a = ( float( i ) + jitter ) / N;
      float t = t0 + span * a * a; // denser sampling close to the camera
      float dt = span * ( 2.0 * float( i ) + 1.0 ) / ( N * N );
      vec3 p = uCamPos + rd * t;
      float sigma = mistDensity( p );
      if ( sigma < 1e-4 ) continue;
      vec3 inL = mix( uMistLow, uMistHigh, clamp( p.y / uTop, 0.0, 1.0 ) );
      float Ti = exp( - sigma * dt );
      L += T * ( 1.0 - Ti ) * inL;
      T *= Ti;
    }
  }

  // Point lights, integrated analytically along the ray (smooth halos, no sampling noise):
  //   integral of 1 / (d(t)^2 + c) dt = ( atan((b - tc)/k) - atan((a - tc)/k) ) / k
  // through a thin uniform haze over the whole visible ray, plus the mist bank density found at
  // the ray's closest approach to the light.
  float tS = min( sceneDist, 400.0 );
  vec3 Lp = vec3( 0.0 );
  for ( int j = 0; j < 6; j ++ ) {
    vec4 lc = uLightCol[ j ];
    if ( lc.r + lc.g + lc.b < 1e-3 ) continue;
    vec3 oc = uLightPos[ j ] - uCamPos;
    float tc = dot( oc, rd );
    float h2 = max( dot( oc, oc ) - tc * tc, 0.0 );
    float k = sqrt( h2 + 0.5 );
    float Ih = ( atan( ( tS - tc ) / k ) + atan( tc / k ) ) / k;
    float sm = 0.0;
    float Im = 0.0;
    float Tc = 1.0;
    if ( t1 > t0 ) {
      Im = ( atan( ( t1 - tc ) / k ) - atan( ( t0 - tc ) / k ) ) / k;
      float tcl = clamp( tc, t0, t1 );
      sm = mistDensity( uCamPos + rd * tcl );
      Tc = pow( max( T, 1e-4 ), ( tcl - t0 ) / max( t1 - t0, 1e-3 ) );
    }
    vec3 pc = uCamPos + rd * clamp( tc, 0.0, tS );
    float win = 1.0 - smoothstep( 0.4, 1.0, length( uLightPos[ j ] - pc ) / max( lc.w, 0.1 ) );
    float cosV = dot( oc, rd ) / max( length( oc ), 1e-3 );
    float phase = 0.84 / pow( 1.16 - 0.8 * cosV, 1.5 ); // Henyey-Greenstein, g = 0.4 (x 4 pi)
    Lp += lc.rgb * ( phase * win * ( uHaze * Ih + uMistGlow * sm * Im * Tc ) );
  }
  // Soft knee on the lamps' glow: a halo may bloom, but standing next to a lamp in a mist bank
  // must not turn the whole frame into a white-out.
  float peak = max( Lp.r, max( Lp.g, Lp.b ) );
  L += Lp / ( 1.0 + 1.1 * peak );
  gl_FragColor = vec4( L, T );
}
`;

// Depth-aware upsample of the half-res mist onto the full-res scene.
const COMPOSITE_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tScene;
uniform sampler2D tMist;
uniform sampler2D tDepth;
uniform vec2 uMistSize;
uniform float uNear;
uniform float uFar;
uniform float uEnabled;
varying vec2 vUv;

float viewDist( vec2 uv ) {
  return - perspectiveDepthToViewZ( texture2D( tDepth, uv ).x, uNear, uFar );
}

void main() {
  vec4 scene = texture2D( tScene, vUv );
  // One NaN/Inf pixel from any material would be smeared into a black blot by the bloom blur:
  // scrub it here, where every frame passes through, and cap runaway HDR values.
  scene.rgb = any( isnan( scene.rgb ) ) ? vec3( 0.0 ) : clamp( scene.rgb, 0.0, 64.0 );
  if ( uEnabled < 0.5 ) { gl_FragColor = scene; return; }
  float z = viewDist( vUv );
  vec2 st = vUv * uMistSize - 0.5;
  vec2 i0 = floor( st );
  vec2 f = st - i0;
  vec4 acc = vec4( 0.0 );
  float wsum = 0.0;
  for ( int k = 0; k < 4; k ++ ) {
    vec2 o = vec2( float( k - ( k / 2 ) * 2 ), float( k / 2 ) );
    vec2 uvL = ( i0 + o + 0.5 ) / uMistSize;
    float zl = viewDist( uvL );
    vec2 bw = mix( 1.0 - f, f, o );
    float w = bw.x * bw.y / ( 0.002 + abs( zl - z ) / max( z, 0.1 ) ) + 1e-5;
    acc += texture2D( tMist, uvL ) * w;
    wsum += w;
  }
  vec4 mist = acc / wsum;
  gl_FragColor = vec4( scene.rgb * mist.a + mist.rgb, scene.a );
}
`;

// Drifting mist wisps: big soft camera-facing sheets around the camera, faded against the scene
// depth (soft particles) so they never show a hard line where they meet walls or the street.
const WISP_VERT = /* glsl */ `
attribute vec4 aSeed;
attribute vec2 aCorner;
uniform float uTime;
uniform float uShake;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec2 uWind;
${LIGHT_UNIFORMS_GLSL}
uniform vec3 uMistHigh;
varying vec2 vCorner;
varying float vViewZ;
varying float vAlpha;
varying vec3 vColor;
varying vec4 vSeed;

void main() {
  float sp = 0.6 + 0.7 * aSeed.w;
  vec3 p = vec3( aSeed.x * uBox.x, 0.0, aSeed.z * uBox.z );
  p.xz += uWind * uTime * sp;
  p.x += sin( uTime * 0.07 + aSeed.w * 30.0 ) * 2.0;
  vec3 rel = mod( p - uCam + 0.5 * uBox, uBox ) - 0.5 * uBox;
  float size = mix( 3.5, 8.0, aSeed.y );
  vec3 c = vec3( uCam.x + rel.x, mix( 0.5, 2.4, fract( aSeed.w * 17.3 ) ) + size * 0.15, uCam.z + rel.z );
  c += vec3( sin( uTime * 31.0 + aSeed.w * 9.0 ), 0.5, cos( uTime * 27.0 + aSeed.w * 7.0 ) ) * uShake * 0.25;
  vec4 mv = viewMatrix * vec4( c, 1.0 );
  float ang = aSeed.w * 6.2831 + uTime * 0.02 * ( aSeed.x - 0.5 );
  vec2 cr = mat2( cos( ang ), sin( ang ), - sin( ang ), cos( ang ) ) * aCorner;
  mv.xy += cr * size * vec2( 1.6, 0.75 );
  gl_Position = projectionMatrix * mv;
  vViewZ = - mv.z;
  vCorner = aCorner;
  vSeed = aSeed;
  float dist = length( rel.xz );
  vec3 e = abs( rel ) / ( 0.5 * uBox );
  vAlpha = ( 1.0 - smoothstep( 0.6, 1.0, max( e.x, e.z ) ) ) * smoothstep( 3.5, 10.0, dist ) * ( 1.0 - smoothstep( 6.0, 14.0, uCam.y ) );
  if ( vAlpha < 0.004 ) {
    // invisible sheet (too close, at the wrap edge, or camera above the mist): rasterise nothing
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }
  vColor = uMistHigh;
  for ( int j = 0; j < 6; j ++ ) {
    vec3 dl = uLightPos[ j ] - c;
    float d2 = dot( dl, dl );
    float win = 1.0 - smoothstep( 0.45, 1.0, sqrt( d2 ) / max( uLightCol[ j ].w, 0.1 ) );
    vColor += uLightCol[ j ].rgb * win / ( d2 + 4.0 ) * 0.2;
  }
}
`;

const WISP_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uOpacity;
uniform float uCall;
varying vec2 vCorner;
varying float vViewZ;
varying float vAlpha;
varying vec3 vColor;
varying vec4 vSeed;

void main() {
  // cheapest rejections first: these sheets cover the screen several times over
  float r = length( vCorner );
  float a = smoothstep( 1.0, 0.25, r ) * vAlpha * uOpacity * ( 1.0 + 0.4 * uCall );
  if ( a < 0.003 ) discard;
  float sceneZ = - perspectiveDepthToViewZ( texture2D( tDepth, gl_FragCoord.xy / uResolution ).x, uNear, uFar );
  a *= smoothstep( 0.0, 2.2, sceneZ - vViewZ );
  if ( a < 0.003 ) discard;
  vec3 q = vec3( vCorner * 0.22 + vSeed.xy * 7.0, uTime * 0.012 + vSeed.z );
  float n = texture( tNoise, q ).r * 0.65 + texture( tNoise, q * 2.7 ).r * 0.35;
  a *= smoothstep( 0.35, 0.8, n );
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vColor, a );
}
`;

export class MistPass extends Pass {
  constructor({ scenePass, camera, noise, lights, colors, wispCount = 26 }) {
    super();
    this.scenePass = scenePass;
    this.camera = camera;
    this.needsSwap = true;
    this.mistEnabled = true; // false: composite becomes a plain copy (the pass itself must still run)
    this.frame = 0;
    this.half = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.half.texture.name = 'Atmosphere.mist';
    this.half.texture.minFilter = THREE.NearestFilter;
    this.half.texture.magFilter = THREE.NearestFilter;
    this.halfSize = new THREE.Vector2(1, 1);
    this.resolution = new THREE.Vector2(1, 1);

    this.marchUniforms = {
      tDepth: { value: null },
      tNoise: { value: noise },
      uProjInv: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uDensity: { value: 0.085 },
      uTop: { value: 7.5 },
      uMaxDist: { value: 75 },
      uPuff: { value: 0 },
      uCall: { value: 0 },
      uFrame: { value: 0 },
      uHaze: { value: 0.0006 }, // thin everywhere-haze that gives every lamp a glow
      uMistGlow: { value: 0.4 }, // how strongly mist banks catch the lamps' light
      uWind: { value: new THREE.Vector2(0.32, 0.12) }, // m/s
      uMistLow: { value: colors.low },
      uMistHigh: { value: colors.high },
      uLightPos: { value: lights.pos },
      uLightCol: { value: lights.col },
    };
    this.march = new FullScreenQuad(new THREE.ShaderMaterial({
      name: 'AtmosphereMistMarch',
      defines: { STEPS: 12 },
      uniforms: this.marchUniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false,
      depthWrite: false,
    }));

    this.compositeUniforms = {
      tScene: { value: null },
      tMist: { value: this.half.texture },
      tDepth: { value: null },
      uMistSize: { value: this.halfSize },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uEnabled: { value: 1 },
    };
    this.composite = new FullScreenQuad(new THREE.ShaderMaterial({
      name: 'AtmosphereMistComposite',
      uniforms: this.compositeUniforms,
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    }));

    // --- wisps
    const rng = makeRng(4242);
    const geom = new THREE.InstancedBufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geom.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(wispCount * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng();
    geom.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geom.instanceCount = wispCount;
    this.wispUniforms = {
      tDepth: { value: null },
      tNoise: { value: noise },
      uResolution: { value: this.resolution },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uTime: { value: 0 },
      uShake: { value: 0 },
      uOpacity: { value: 0.16 },
      uCall: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(56, 10, 56) },
      uWind: { value: this.marchUniforms.uWind.value },
      uMistHigh: { value: colors.high },
      uLightPos: { value: lights.pos },
      uLightCol: { value: lights.col },
    };
    this.wisps = new THREE.Mesh(geom, new THREE.ShaderMaterial({
      name: 'AtmosphereMistWisps',
      uniforms: this.wispUniforms,
      vertexShader: WISP_VERT,
      fragmentShader: WISP_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }));
    this.wisps.frustumCulled = false;
    this.wispScene = new THREE.Scene();
    this.wispScene.add(this.wisps);
    this.wispsEnabled = true;
  }

  setSteps(n) {
    const m = this.march.material;
    if (m.defines.STEPS === n) return;
    m.defines.STEPS = n;
    m.needsUpdate = true;
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    this.half.setSize(hw, hh);
    this.halfSize.set(hw, hh);
    this.resolution.set(w, h);
  }

  render(renderer, writeBuffer) {
    const src = this.scenePass.target;
    const cam = this.camera;
    const mu = this.marchUniforms;
    this.frame = (this.frame + 1) % 64;
    mu.uFrame.value = this.frame;
    mu.tDepth.value = src.depthTexture;
    mu.uProjInv.value.copy(cam.projectionMatrixInverse);
    mu.uCamWorld.value.copy(cam.matrixWorld);
    mu.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);

    const mistOn = this.mistEnabled && mu.uDensity.value > 0;
    if (mistOn) {
      renderer.setRenderTarget(this.half);
      this.march.render(renderer);
    }

    const cu = this.compositeUniforms;
    cu.tScene.value = src.texture;
    cu.tDepth.value = src.depthTexture;
    cu.uNear.value = cam.near;
    cu.uFar.value = cam.far;
    cu.uEnabled.value = mistOn ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.composite.render(renderer);

    if (mistOn && this.wispsEnabled) {
      const wu = this.wispUniforms;
      wu.tDepth.value = src.depthTexture;
      wu.uNear.value = cam.near;
      wu.uFar.value = cam.far;
      wu.uCam.value.copy(mu.uCamPos.value);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(this.wispScene, cam);
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.half.dispose();
    this.march.dispose();
    this.composite.dispose();
    this.wisps.geometry.dispose();
    this.wisps.material.dispose();
  }
}
