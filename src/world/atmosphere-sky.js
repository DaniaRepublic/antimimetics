import * as THREE from 'three';
import { FOG_TINT_GLSL, FOG_UNIFORMS } from './atmosphere-fog.js';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAG = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uCloudLow;
uniform vec3 uCloudHigh;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uTime;
uniform float uChurn;
uniform float uCall;
uniform float uPulse;
uniform sampler3D uNoise;
varying vec3 vDir;
${FOG_TINT_GLSL}

float n3( vec3 p ) { return texture( uNoise, p ).r; }

void main() {
  vec3 rd = normalize( vDir );
  float up = rd.y;
  vec3 col = atmoFogTint( rd, uHorizon );

  // Burning districts beyond the skyline: slow, uneven glow patches hugging the horizon.
  float az = atan( rd.z, rd.x ) / 6.2831853;
  float fireN = n3( vec3( az * 3.0, 0.21, uTime * 0.004 ) ) * 0.7 + n3( vec3( az * 9.0, 0.63, uTime * 0.011 ) ) * 0.3;
  float fires = smoothstep( 0.5, 0.85, fireN ) * exp( - abs( up ) * 38.0 );
  col += uHorizon * fires * ( 0.9 + 0.25 * sin( uTime * 1.3 + az * 40.0 ) );

  // Cloud deck: planar projection, banded, domain-warped; lit from below by the burning city.
  float cover = 0.0;
  if ( up > - 0.05 ) {
    float h = max( up, 0.0 ) + 0.05;
    vec2 cuv = rd.xz / h * 0.26;
    cuv.y *= 2.4; // stretch into long bands
    vec2 wind = vec2( 0.0045, 0.0012 ) * uTime;
    vec3 q = vec3( cuv + wind, uChurn * 0.015 );
    float warp = n3( q * 0.45 + vec3( 0.13, 0.71, uChurn * 0.01 ) );
    q.xy += ( warp - 0.5 ) * ( 0.35 + 0.5 * uCall );
    float d = n3( q ) * 0.58 + n3( q * 2.9 + vec3( 0.37, 0.11, uChurn * 0.04 ) ) * 0.3 + n3( q * 7.3 + vec3( 0.71, 0.53, uChurn * 0.07 ) ) * 0.12;
    d = clamp( ( d - 0.46 ) * 2.3 + 0.5, 0.0, 1.0 ); // noise mean is ~0.46
    cover = smoothstep( 0.38, 0.72, d );
    float lowLit = exp( - max( up, 0.0 ) * 3.0 );
    vec3 cloudCol = mix( uCloudHigh, uCloudLow, lowLit ) * ( 0.5 + 0.9 * d ) * ( 1.0 + uCall * 0.6 );
    // thin rims catch more of the glow than the dense cores
    cloudCol += uCloudLow * 0.5 * smoothstep( 0.3, 0.45, d ) * ( 1.0 - smoothstep( 0.45, 0.7, d ) ) * lowLit;
    float fade = smoothstep( 0.015, 0.3, up );
    // gaps between the bands look through to the darker sky above the glow
    col *= mix( 1.0, 0.6, fade );
    col = mix( col, cloudCol, cover * fade );
  }

  // A dim, swollen sun smeared behind the cloud bands.
  vec3 sr = normalize( cross( uSunDir, vec3( 0.0, 1.0, 0.0 ) ) );
  vec3 su = cross( sr, uSunDir );
  float facing = dot( rd, uSunDir );
  vec2 sp = vec2( dot( rd, sr ), dot( rd, su ) ) * vec2( 0.82, 1.18 );
  float sd = facing > 0.0 ? length( sp ) : 10.0;
  float rad = 0.08;
  float disc = smoothstep( rad, rad * 0.7, sd ) * mix( 0.55, 1.0, 1.0 - sd * sd / ( rad * rad ) );
  float halo = exp( - sd * 9.0 ) * 0.5 + exp( - sd * 2.6 ) * 0.18;
  col += uSunColor * ( disc * ( 1.0 - 0.8 * cover ) + halo * ( 1.0 - 0.4 * cover ) );

  // The call: the whole sky swells and throbs.
  col *= 1.0 + uCall * ( 0.55 + 0.35 * uPulse );
  col.r *= 1.0 + uCall * 0.25;

  gl_FragColor = vec4( col, 1.0 );
}
`;

// Camera-centred sky dome. Never fogged, never writes depth, drawn first.
export class Sky {
  constructor(noiseTexture, opts) {
    this.uniforms = {
      ...FOG_UNIFORMS,
      uHorizon: { value: opts.horizon },
      uCloudLow: { value: opts.cloudLow },
      uCloudHigh: { value: opts.cloudHigh },
      uSunDir: { value: opts.sunDir },
      uSunColor: { value: opts.sunColor },
      uTime: { value: 0 },
      uChurn: { value: 0 },
      uCall: { value: 0 },
      uPulse: { value: 0 },
      uNoise: { value: noiseTexture },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'AtmosphereSky',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1e6;
    this.mesh.matrixAutoUpdate = true;
  }

  // Keep the dome around the camera, comfortably inside the far plane.
  follow(camera) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.6);
  }
}
