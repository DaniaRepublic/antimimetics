import * as THREE from 'three';

// Height fog with sky-coloured inscattering, patched into three.js' shared fog chunks so every
// built-in material (basic / lambert / phong / standard / physical / points / sprite ...) gets it
// without per-material work.
//
// - Density falls off exponentially with altitude (dense in the streets, thin over the rooftops),
//   integrated analytically along the view ray, then shaped like FogExp2 (clear up close).
// - The fog colour depends on the view direction and matches the sky dome's haze, so fogged
//   buildings dissolve into the sky behind them instead of turning into flat cut-outs.
//
// The extra values live in Float32Arrays shared *by reference*: UniformsUtils.clone() copies
// Vector/Color values per material but passes typed arrays through, so one write per frame here
// reaches every compiled material. A ShaderMaterial that never received these uniforms reads
// zeros and falls back to plain FogExp2 (atmoFogParams.x == 0).
export const fogShared = {
  params: new Float32Array(4), // x: enabled, y: height falloff (1/m), z: high-altitude haze floor (0..1), w: unused
  zenith: new Float32Array(3), // haze colour straight up (linear)
  mid: new Float32Array(3), // broad mid-sky term (linear)
  glow: new Float32Array(4), // xyz: glow direction (normalised), w: glow strength
};

export const FOG_UNIFORMS = {
  atmoFogParams: { value: fogShared.params },
  atmoFogZenith: { value: fogShared.zenith },
  atmoFogMid: { value: fogShared.mid },
  atmoFogGlow: { value: fogShared.glow },
};

// Uniform declarations + haze colour for a world-space view direction. Shared with the sky dome
// so the horizon and the fog are the same colour by construction. `horizon` is the fog colour.
export const FOG_TINT_GLSL = /* glsl */ `
uniform vec4 atmoFogParams;
uniform vec3 atmoFogZenith;
uniform vec3 atmoFogMid;
uniform vec4 atmoFogGlow;

vec3 atmoFogTint( vec3 rd, vec3 horizon ) {
  float up = max( rd.y, 0.0 );
  float band = exp( - up * 16.0 );
  float mid = exp( - up * 3.2 );
  vec3 c = atmoFogZenith + atmoFogMid * mid + ( horizon - atmoFogZenith - atmoFogMid ) * band;
  c *= 1.0 - 0.4 * smoothstep( 0.0, 0.7, - rd.y );
  vec2 flat2 = rd.xz / max( length( rd.xz ), 1e-4 );
  float g = max( dot( flat2, atmoFogGlow.xz ), 0.0 );
  c *= 1.0 + atmoFogGlow.w * g * g * g * exp( - up * 5.0 );
  return max( c, vec3( 0.0 ) );
}
`;

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  #ifdef FOG_EXP2
    varying vec3 vAtmoFogRay;
  #endif
#endif
`;

const VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  #ifdef FOG_EXP2
    // camera -> vertex in world space (view matrix is rigid, so its inverse rotation is a transpose)
    vAtmoFogRay = transpose( mat3( viewMatrix ) ) * mvPosition.xyz;
  #endif
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  #ifdef FOG_EXP2
    uniform float fogDensity;
    varying vec3 vAtmoFogRay;
    ${FOG_TINT_GLSL}
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

const FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor;
    vec3 atmoFogCol = fogColor;
    if ( atmoFogParams.x > 0.5 ) {
      float fogDist = length( vAtmoFogRay );
      vec3 fogDir = vAtmoFogRay / max( fogDist, 1e-4 );
      float fogB = atmoFogParams.y;
      float fogK = clamp( fogB * fogDir.y * fogDist, - 60.0, 60.0 );
      float fogShape = abs( fogK ) > 1e-3 ? ( 1.0 - exp( - fogK ) ) / fogK : 1.0 - 0.5 * fogK;
      float fogTau = fogDensity * fogDist * ( atmoFogParams.z + ( 1.0 - atmoFogParams.z ) * exp( - fogB * max( cameraPosition.y, 0.0 ) ) * fogShape );
      fogFactor = 1.0 - exp( - fogTau * fogTau );
      atmoFogCol = atmoFogTint( fogDir, fogColor );
    } else {
      fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    }
    gl_FragColor.rgb = mix( gl_FragColor.rgb, atmoFogCol, fogFactor );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif
`;

let installed = false;

// Patch the fog chunks and register the shared uniforms. Must run before the first material
// compiles; idempotent. It runs when this module is first imported (game.js imports the
// atmosphere before the level, leviathan and AI modules, so a module-level
// `UniformsUtils.merge([UniformsLib.fog, ...])` there already picks up the extra uniforms) and
// again, as a no-op, from the Atmosphere constructor.
export function installAtmosphereFog() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FRAGMENT;
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms;
    if (u && u.fogColor) Object.assign(u, FOG_UNIFORMS);
  }
  Object.assign(THREE.UniformsLib.fog, FOG_UNIFORMS);
}

installAtmosphereFog();

// CPU mirror of the shader's fog factor (for tests and for modules that want to fade things
// consistently). `from`/`to` are world positions.
export function fogFactorBetween(density, falloff, floor, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-4) return 0;
  const k = Math.max(-60, Math.min(60, falloff * dy));
  const shape = Math.abs(k) > 1e-3 ? (1 - Math.exp(-k)) / k : 1 - 0.5 * k;
  const tau = density * dist * (floor + (1 - floor) * Math.exp(-falloff * Math.max(from.y, 0)) * shape);
  return 1 - Math.exp(-tau * tau);
}
