import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { ScenePass, MistPass } from './atmosphere-mist.js';

// Final pass: tone mapping (ACES, as three's OutputPass would do: merged here to save a full-screen
// pass), then the look in display space: lens distortion for the death sequence, chromatic
// aberration, a maroon/amber colour grade, threat-driven vignette and heartbeat pulse, film grain.
export const GradeShader = {
  name: 'AtmosphereGrade',
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uThreat: { value: 0 },
    uBeat: { value: 0 },
    uDeath: { value: 0 },
    uCall: { value: 0 },
    uGrain: { value: 0.045 },
    uAberration: { value: 0.0016 },
    uGamma: { value: 1 }, // display gamma from the optional brightness setting (1 = as graded)
    toneMappingExposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime;
    uniform float uThreat;
    uniform float uBeat;
    uniform float uDeath;
    uniform float uCall;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uGamma;
    varying vec2 vUv;

    #include <tonemapping_pars_fragment>

    vec3 toDisplay( vec3 hdr ) {
      return sRGBTransferOETF( vec4( ACESFilmicToneMapping( hdr ), 1.0 ) ).rgb;
    }

    float hash12( vec2 p ) {
      vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
      p3 += dot( p3, p3.yzx + 33.33 );
      return fract( ( p3.x + p3.y ) * p3.z );
    }

    void main() {
      float aspect = uRes.x / uRes.y;
      vec2 uv = vUv;
      vec2 c = ( uv - 0.5 ) * vec2( aspect, 1.0 );
      float r = length( c );

      // --- caught: the world folds in on itself
      float d2 = uDeath * uDeath;
      if ( uDeath > 0.0 ) {
        float ang = d2 * 0.9 * smoothstep( 0.9, 0.0, r ) * sin( uTime * 1.7 );
        float cs = cos( ang ), sn = sin( ang );
        vec2 cc = mat2( cs, sn, - sn, cs ) * c;
        cc *= 1.0 - 0.18 * d2 * ( 0.6 + 0.4 * sin( uTime * 5.3 ) );
        cc += vec2( sin( cc.y * 21.0 + uTime * 11.0 ), cos( cc.x * 17.0 - uTime * 8.0 ) ) * 0.014 * d2;
        uv = cc / vec2( aspect, 1.0 ) + 0.5;
      }

      // --- heartbeat squeeze under threat; a low pressure-wave wobble during the call
      uv = 0.5 + ( uv - 0.5 ) * ( 1.0 - 0.0045 * uBeat * uThreat );
      uv.y += sin( uv.x * 9.0 + uTime * 2.3 ) * 0.0012 * uCall;

      // --- chromatic aberration (radial)
      vec2 dir = uv - 0.5;
      float ab = ( uAberration + 0.0045 * uThreat * ( 0.6 + 0.4 * uBeat ) + 0.03 * d2 + 0.002 * uCall ) * ( 0.35 + 2.4 * r * r );
      vec3 col;
      col.r = texture2D( tDiffuse, uv + dir * ab ).r;
      col.g = texture2D( tDiffuse, uv ).g;
      col.b = texture2D( tDiffuse, uv - dir * ab * 1.2 ).b;
      col = toDisplay( col );

      // --- grade: maroon shadows, amber highlights, gentle S-curve, muted non-reds
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      // Toe: a laptop panel crushes everything under ~10/255, and most of this image lives there.
      // The darks get a gain (hue kept) and a faint maroon-brown floor, so cover, the street and
      // the figures on it stay legible; the S-curve's contrast only works from the low mids up.
      float toe = 1.0 - smoothstep( 0.0, 0.3, l );
      col = col * ( 1.0 + 0.38 * toe ) + vec3( 0.028, 0.011, 0.01 ) * toe * toe;
      col = mix( col, col * vec3( 1.06, 0.95, 0.84 ), smoothstep( 0.3, 0.85, l ) );
      col = mix( col, col * col * ( 3.0 - 2.0 * col ), 0.3 * smoothstep( 0.1, 0.4, l ) );
      float l2 = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l2 ), col, 0.88 + 0.12 * smoothstep( 0.0, 0.2, col.r - max( col.g, col.b ) ) );
      col = pow( max( col, 0.0 ), vec3( uGamma ) );

      // --- vignette, tightening with threat and death. At rest the screen sides stay at ~55% so
      // a snatcher in the periphery is still readable; under threat it closes to a tunnel.
      float inner = 0.42 - 0.2 * uThreat - 0.25 * uDeath;
      float outer = 1.3 - 0.5 * uThreat - 0.55 * uDeath;
      float vig = smoothstep( outer, inner, r );
      // darken green/blue faster than red so dimmed oranges fall to maroon, not olive
      col *= mix( vec3( 0.2, 0.11, 0.1 ), vec3( 1.0 ), vig );
      col += vec3( 0.2, 0.0, 0.015 ) * uThreat * ( 0.3 + 0.7 * uBeat ) * smoothstep( 0.4, 1.0, r );

      // --- caught: a hard flash as it takes hold, a second of its face in full colour, then the
      // image bleeds to red monochrome and goes to black
      float dl = dot( col, vec3( 0.3, 0.59, 0.11 ) );
      float flash = smoothstep( 0.0, 0.02, uDeath ) * ( 1.0 - smoothstep( 0.02, 0.13, uDeath ) );
      col = mix( col, vec3( dl ) * vec3( 1.5, 1.15, 1.05 ), 0.6 * flash ) * ( 1.0 + 0.9 * flash );
      col = mix( col, vec3( dl * 1.5, dl * 0.1, dl * 0.07 ), smoothstep( 0.4, 0.78, uDeath ) );
      col *= 1.0 - smoothstep( 0.68, 1.0, uDeath );

      // --- grain (triangular, luminance weighted; also dithers the dark gradients)
      vec2 gp = gl_FragCoord.xy + fract( uTime * 13.17 ) * vec2( 431.0, 197.0 );
      float g = hash12( gp ) + hash12( gp + 71.3 ) - 1.0;
      // (heavier while dying, gone once the screen has faded to black)
      col += g * uGrain * ( 0.45 + 0.55 * ( 1.0 - l ) ) * ( 1.0 + 0.6 * uDeath ) * ( 1.0 - smoothstep( 0.8, 1.0, uDeath ) );

      gl_FragColor = vec4( max( col, 0.0 ), 1.0 );
    }
  `,
};

// Scene (+ depth texture) -> volumetric mist -> bloom (reduced res) -> tone map + grade.
export function createPost({ renderer, scene, camera, noise, lights, mistColors }) {
  const pr = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  // The ping-pong targets only carry colour; depth lives on the scene pass' own target.
  const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, depthBuffer: false });
  rt.texture.name = 'Atmosphere.post';
  const composer = new EffectComposer(renderer, rt);
  // MSAA only where pixels are big enough for jaggies to show (pixel ratio ~1).
  const samples = pr < 1.25 ? Math.min(4, renderer.capabilities.maxSamples || 0) : 0;
  const scenePass = new ScenePass(scene, camera, samples);
  const mistPass = new MistPass({ scenePass, camera, noise, lights, colors: mistColors });
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr, size.y * pr), 0.55, 0.6, 0.85);
  bloom.highPassUniforms.smoothWidth.value = 0.6;
  // Bloom at half the composer resolution (the pass itself already halves again internally).
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(2, Math.round(w * 0.5)), Math.max(2, Math.round(h * 0.5)));
  const grade = new ShaderPass(GradeShader);
  // Tone mapping happens inside the grade (see GradeShader); three must not add its own.
  grade.material.toneMapped = false;
  composer.addPass(scenePass);
  composer.addPass(mistPass);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);
  return { composer, scenePass, mistPass, bloom, grade };
}
