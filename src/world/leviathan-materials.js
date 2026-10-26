import * as THREE from 'three';

// Shaders for the leviathan. Every material shares one uniforms object, so the creature writes
// each value once per frame. The look is deliberately stylised rather than lit by scene lights:
// a near-black body rim-lit by the red sky, faint bioluminescence, and its own fog that is far
// thinner than the scene fog and fades toward a colour a little darker than the sky, so the
// silhouette reads from anywhere in the city. Parts low to the ground still sink into the
// scene's ground mist (the feet vanish into the haze like the buildings around them).

export function createLeviathanUniforms() {
  return {
    uTime: { value: 0 },
    uCall: { value: 0 }, // call envelope 0..1
    uGlow: { value: 1 }, // bioluminescence multiplier
    uShudder: { value: 0 },
    uNeck: { value: new THREE.Vector3() }, // x yaw, y pitch (+ lifts), z jaw opening
    uNeckPivot: { value: new THREE.Vector3() },
    uJawPivot: { value: new THREE.Vector3() },
    uDrift: { value: new THREE.Vector3() }, // body-local velocity, tendrils trail against it
    uBase: { value: new THREE.Color(0.016, 0.011, 0.012) },
    uSky: { value: new THREE.Color(0.5, 0.08, 0.04) },
    uGlowColor: { value: new THREE.Color(1.0, 0.24, 0.06) },
    uFogColor: { value: new THREE.Color(0.03, 0.004, 0.003) },
    uFogDensity: { value: 0.002 },
    uMistColor: { value: new THREE.Color(0.04, 0.006, 0.004) },
    uMistDensity: { value: 0.012 },
    uMistLow: { value: 6 },
    uMistTop: { value: 55 },
    uPixelWorld: { value: 0.002 }, // world size of one pixel at distance 1
    uPixelScale: { value: 500 }, // pixels per world unit at distance 1
  };
}

const COMMON = /* glsl */ `
uniform float uTime;
uniform float uCall;
uniform float uGlow;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uMistColor;
uniform float uMistDensity;
uniform float uMistLow;
uniform float uMistTop;

float levFogAmount(vec3 wp) {
  float d = distance(cameraPosition, wp);
  return 1.0 - exp(-uFogDensity * uFogDensity * d * d);
}

float levMistAmount(vec3 wp) {
  float d = distance(cameraPosition, wp);
  float m = 1.0 - exp(-uMistDensity * uMistDensity * d * d);
  return m * (1.0 - smoothstep(uMistLow, uMistTop, wp.y));
}
`;

const DEFORM = /* glsl */ `
uniform vec3 uNeck;
uniform vec3 uNeckPivot;
uniform vec3 uJawPivot;
uniform vec3 uDrift;
uniform float uShudder;
uniform float uPixelWorld;
uniform float uPixelScale;

mat3 levRotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
}

mat3 levRotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

// Animates a rest-pose, body-local point. info = (jaw weight, neck bend weight, tendril s, phase).
vec3 levDeform(vec3 p, inout vec3 n, vec4 info, float part, vec2 uv2) {
  if (info.x > 0.0) {
    mat3 r = levRotX(-uNeck.z * info.x);
    p = uJawPivot + r * (p - uJawPivot);
    n = r * n;
  }
  if (info.z > 0.0) {
    float s2 = info.z * info.z;
    float ph = info.w;
    float amp = 1.3 + 2.6 * uCall;
    vec2 sway = vec2(
      sin(uTime * 0.41 + ph) + 0.45 * sin(uTime * 1.17 + ph * 2.3),
      cos(uTime * 0.33 + ph * 1.7) + 0.45 * sin(uTime * 0.93 + ph * 0.7)
    ) * amp;
    sway -= uDrift.xz * 2.0;
    p.xz += sway * s2;
    p.y += dot(sway, sway) * s2 * 0.01;
  }
  if (info.y > 0.0) {
    mat3 r = levRotY(uNeck.x * info.y) * levRotX(uNeck.y * info.y);
    p = uNeckPivot + r * (p - uNeckPivot);
    n = r * n;
  }
  if (part < 0.5 || (part > 4.5 && part < 5.5)) {
    float tail = smoothstep(0.6, 1.0, uv2.x);
    p.x += sin(uTime * 0.37 - uv2.x * 5.0) * tail * tail * 3.2;
    p += n * (sin(uv2.x * 38.0 - uTime * 1.3) * 0.07 + sin(uTime * 27.0 + uv2.x * 90.0) * 0.2 * uShudder);
  }
  return p;
}
`;

const SURFACE_VERT = /* glsl */ `
${COMMON}
${DEFORM}
#ifndef LEV_LEG
attribute vec4 aInfo;
attribute float aPart;
#endif
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;
varying float vS;

void main() {
  vec3 p = position;
  vec3 n = normal;
#ifdef LEV_LEG
  // Legs are instanced tapered lathes along +Y. Keep them at least ~1.5 px wide so the far
  // silhouette doesn't break up into dashes (there is no MSAA).
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w0 = m * vec4(p, 1.0);
  float minR = uPixelWorld * distance(cameraPosition, w0.xyz) * 0.75;
  float r = length(p.xz);
  if (r > 0.001) p.xz *= max(1.0, minR / r);
  vec4 wp = m * vec4(p, 1.0);
  vNormal = normalize(mat3(m) * n);
  vUv = vec2(uv.x, position.y);
  vPart = 6.0;
  vS = 0.0;
#else
  if (aPart > 3.5 && aPart < 4.5) {
    // Tendrils store their tube radius in uv.y: same minimum-width treatment.
    vec4 w0 = modelMatrix * vec4(p, 1.0);
    float minR = uPixelWorld * distance(cameraPosition, w0.xyz) * 0.7;
    p += n * max(0.0, minR - uv.y);
  }
  p = levDeform(p, n, aInfo, aPart, uv);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vNormal = normalize(mat3(modelMatrix) * n);
  vUv = uv;
  vPart = aPart;
  vS = aInfo.z;
#endif
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SURFACE_FRAG = /* glsl */ `
${COMMON}
uniform vec3 uBase;
uniform vec3 uSky;
uniform vec3 uGlowColor;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vPart;
varying float vS;

float levHash(float n) {
  return fract(sin(n * 127.1) * 43758.5453);
}

// Antialiased periodic groove: 1 in the groove centre, 0 elsewhere; fades out when too fine.
float levGroove(float x, float width) {
  float f = fract(x);
  float d = min(f, 1.0 - f);
  float fw = fwidth(x);
  float g = 1.0 - smoothstep(width - fw, width + fw, d);
  return g * (1.0 - smoothstep(0.25, 0.6, fw));
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float up = N.y * 0.5 + 0.5;
  float shade = 1.0;
  float glow = 0.0;
  float u = vUv.x;
  float th = vUv.y;
  float wave = pow(0.5 + 0.5 * sin(u * 31.0 + uTime * (0.8 + 4.5 * uCall)), 3.0);

  if (vPart < 0.5) {
    // body: starved ribs on the flanks, segment seams, glowing seams and pores underneath
    float flank = smoothstep(0.06, 0.2, abs(th - 0.25)) * (1.0 - step(0.74, u));
    shade *= 1.0 - 0.45 * levGroove(u * 46.0 + 0.5, 0.22) * flank;
    float seam = levGroove(u * 13.0 + 0.5, 0.035);
    shade *= 1.0 - 0.5 * seam;
    float belly = 1.0 - smoothstep(0.04, 0.16, abs(th - 0.75));
    float segId = floor(u * 13.0 + 0.5);
    glow += seam * belly * (0.1 + 0.9 * wave) * 0.4 * step(0.45, levHash(segId));
    // irregular ventral pores: two loose rows, some dark, some bright
    float side = sign(th - 0.75);
    float poreId = floor(u * 64.0) + side * 0.37;
    float row = 1.0 - smoothstep(0.004, 0.012, abs(abs(th - 0.75) - 0.045 - 0.02 * levHash(poreId + 3.0)));
    float pore = levGroove(u * 64.0, 0.16) * step(0.4, levHash(poreId)) * levHash(poreId + 7.0);
    glow += belly * row * pore * (0.15 + 0.85 * wave) * 1.2 * (1.0 - step(0.8, u));
  } else if (vPart < 1.5) {
    // neck: vertebral rings, faint throat line
    shade *= 1.0 - 0.4 * levGroove(u * 11.0, 0.12);
    float throat = 1.0 - smoothstep(0.02, 0.06, abs(th - 0.75));
    glow += throat * wave * 0.08;
  } else if (vPart < 3.5) {
    // skull and jaw: smooth, eyeless; the mouth lights from inside when it calls
    float chin = 1.0 - smoothstep(0.08, 0.3, abs(th - 0.75));
    float mouth = chin * smoothstep(0.25, 0.45, u) * (1.0 - smoothstep(0.85, 1.0, u));
    glow += mouth * (uCall * 0.45 + 0.04);
    shade *= 0.9 + 0.1 * up;
  } else if (vPart < 4.5) {
    // tendrils: dim, with glowing lures at the tips
    // faintly luminous threads, brighter toward the lure at the tip
    float flick = 0.5 + 0.5 * sin(uTime * 1.7 + u * 40.0 - vS * 6.0);
    glow += (0.05 + 0.18 * smoothstep(0.3, 1.0, vS)) * (0.6 + 0.4 * flick) + smoothstep(0.95, 1.0, vS) * flick * 0.6;
  } else if (vPart > 5.5) {
    // legs: chitin rings
    shade *= 1.0 - 0.35 * levGroove(vUv.y / 7.5, 0.06);
  }

  vec3 col = uBase * shade * (0.3 + 1.0 * up * up);
  col += uMistColor * shade * 0.22 * (1.0 - up) * (1.0 - up); // faint glow of the burning city below
  float fres = pow(1.0 - ndv, 3.0);
  col += uSky * shade * (0.03 * up * up + 0.3 * fres * (0.45 + 0.55 * up));
  col += uGlowColor * glow * uGlow;
  col = mix(col, uFogColor, levFogAmount(vWorld));
  col = mix(col, uMistColor, levMistAmount(vWorld));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const LIGHTS_VERT = /* glsl */ `
${COMMON}
${DEFORM}
attribute vec4 aInfo;
attribute float aPart;
attribute vec3 aLight; // world size (m), phase, brightness
varying float vI;

void main() {
  vec3 p = position;
#ifdef LEV_DEFORM
  vec3 n = vec3(0.0);
  p = levDeform(p, n, aInfo, aPart, uv);
#endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * wp;
  float pulse = 0.5 + 0.5 * sin(uTime * (0.6 + 2.8 * uCall) + aLight.y);
  pulse *= pulse;
  float size = aLight.x * (1.0 + 0.9 * uCall);
  float raw = size * uPixelScale / max(-mv.z, 0.1);
  gl_PointSize = clamp(raw, 2.0, 56.0);
  float fade = (1.0 - 0.8 * levFogAmount(wp.xyz)) * (1.0 - levMistAmount(wp.xyz));
  vI = (0.15 + 0.85 * pulse) * uGlow * aLight.z * fade * clamp(raw / 2.0, 0.3, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const LIGHTS_FRAG = /* glsl */ `
uniform vec3 uGlowColor;
varying float vI;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 7.0) + 0.15 * (1.0 - r2);
  vec3 col = uGlowColor * (1.0 + 2.0 * exp(-r2 * 40.0));
  gl_FragColor = vec4(col * a * vI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DUST_VERT = /* glsl */ `
${COMMON}
uniform vec4 uBursts[4]; // xyz origin, w birth time
uniform float uBurstAmp[4];
uniform float uPixelScale;
attribute vec4 aSeed; // xyz direction, w random
attribute float aSlot;
varying float vA;

void main() {
  int slot = int(aSlot + 0.5);
  vec4 b = uBursts[slot];
  float amp = uBurstAmp[slot];
  float age = uTime - b.w;
  float life = 5.0;
  if (age < 0.0 || age > life || amp <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vA = 0.0;
    return;
  }
  float k = 1.0 - exp(-age * 1.4);
  vec3 dir = normalize(vec3(aSeed.x, 0.0, aSeed.z) + 1e-4);
  vec3 p = b.xyz + dir * (2.0 + (6.0 + 14.0 * aSeed.w) * k * (0.5 + 0.5 * amp));
  p.y += (0.5 + 4.0 * aSeed.y) * k + 0.4 * age;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float size = (2.5 + 7.0 * k) * (0.6 + 0.6 * aSeed.w) * (0.6 + 0.4 * amp);
  gl_PointSize = clamp(size * uPixelScale / max(-mv.z, 0.1), 1.0, 160.0);
  float fade = (1.0 - levFogAmount(p)) * (1.0 - 0.7 * levMistAmount(p));
  vA = pow(1.0 - age / life, 1.5) * smoothstep(0.0, 0.2, age) * 0.32 * fade;
  gl_Position = projectionMatrix * mv;
}
`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uMistColor;
uniform vec3 uSky;
varying float vA;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c) * 4.0;
  if (r2 > 1.0) discard;
  float a = (1.0 - r2) * (1.0 - r2) * vA;
  float luma = dot(uMistColor, vec3(0.3, 0.59, 0.11));
  vec3 col = mix(uMistColor, vec3(luma), 0.55) * 1.5;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createLeviathanMaterials(uniforms) {
  const u = uniforms;
  const body = new THREE.ShaderMaterial({
    name: 'LeviathanBody',
    uniforms: { ...u },
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
    side: THREE.FrontSide,
  });
  const leg = new THREE.ShaderMaterial({
    name: 'LeviathanLeg',
    uniforms: { ...u },
    defines: { LEV_LEG: '' },
    vertexShader: SURFACE_VERT,
    fragmentShader: SURFACE_FRAG,
  });
  const lights = new THREE.ShaderMaterial({
    name: 'LeviathanLights',
    uniforms: { ...u },
    defines: { LEV_DEFORM: '' },
    vertexShader: LIGHTS_VERT,
    fragmentShader: LIGHTS_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const jointLights = new THREE.ShaderMaterial({
    name: 'LeviathanJointLights',
    uniforms: { ...u },
    vertexShader: LIGHTS_VERT,
    fragmentShader: LIGHTS_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.ShaderMaterial({
    name: 'LeviathanDust',
    uniforms: {
      ...u,
      uBursts: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, -999, 0, -999)) },
      uBurstAmp: { value: [0, 0, 0, 0] },
    },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
  });
  return { body, leg, lights, jointLights, dust };
}
