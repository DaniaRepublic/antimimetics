import * as THREE from 'three';

// Cheap shader effects for the level, each a single draw call:
//   GlowSprites  camera-facing additive halos (lamp bulbs, LEDs, pickup glints), per-sprite intensity
//   Flames       animated procedural fire billboards (burning cars, barrels)
//   Smoke        dark rising plumes above fires
//   skylineMaterial  distant silhouette blocks with sparse lit windows and their own lighter fog
// Fog is computed in the shaders from uniforms the level refreshes every frame from the atmosphere,
// so these stay correct whatever fog implementation the atmosphere module uses.

const HASH = /* glsl */ `
float fxHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

function quadBuffers(n) {
  const center = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const index = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
  for (let i = 0; i < n; i++) {
    const c = [-1, -1, 1, -1, 1, 1, -1, 1];
    corner.set(c, i * 8);
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  return { center, corner, index };
}

export class GlowSprites {
  constructor() {
    this.items = [];
    this.mesh = null;
  }

  // size = radius in metres; intensity scales colour (HDR, > 1 blooms). Returns an index.
  add(pos, color, size = 0.6, intensity = 1) {
    const c = new THREE.Color(color);
    this.items.push({ pos: pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y, pos.z), color: c, size, intensity });
    return this.items.length - 1;
  }

  set(i, intensity) {
    const it = this.items[i];
    if (!it || it.intensity === intensity) return;
    it.intensity = intensity;
    if (this.attr) {
      // Whole-buffer upload (a few hundred floats). Per-sprite update ranges would pile up
      // without bound while the game is simulated headless (no render to flush them).
      this.attr.array.fill(intensity, i * 4, i * 4 + 4);
      this.attr.needsUpdate = true;
    }
  }

  build() {
    const n = Math.max(1, this.items.length);
    const { center, corner, index } = quadBuffers(n);
    const color = new Float32Array(n * 4 * 3);
    const size = new Float32Array(n * 4);
    const inten = new Float32Array(n * 4);
    this.items.forEach((it, i) => {
      for (let k = 0; k < 4; k++) {
        center.set([it.pos.x, it.pos.y, it.pos.z], (i * 4 + k) * 3);
        color.set([it.color.r, it.color.g, it.color.b], (i * 4 + k) * 3);
        size[i * 4 + k] = it.size;
        inten[i * 4 + k] = it.intensity;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(center, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.attr = new THREE.BufferAttribute(inten, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aIntensity', this.attr);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    this.uniforms = { uFogDensity: { value: 0.012 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aIntensity;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          // Grow with distance so far lamps still read as glows through the mist; shrink up close.
          float s = aSize * (0.55 + clamp(d / 45.0, 0.0, 1.8));
          mv.xy += aCorner * s;
          mv.z += 0.3; // pull towards the camera so the halo is not swallowed by its own fixture
          float fog = exp(-d * uFogDensity * 0.55);
          vColor = aColor * aIntensity * fog;
          vUv = aCorner;
          gl_Position = projectionMatrix * mv;
          if (aIntensity <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vColor;
        void main() {
          float r = length(vUv);
          if (r > 1.0) discard;
          float a = exp(-r * r * 5.0) * 0.8 + smoothstep(0.22, 0.0, r) * 1.2;
          gl_FragColor = vec4(vColor * a, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'level-glows';
    return this.mesh;
  }
}

export class Flames {
  constructor() {
    this.items = [];
  }

  // A fire at a ground (or roof) position: several crossed flame sheets. scale ~ 1 for a car fire.
  add(pos, scale = 1, seed = Math.random() * 100) {
    const sheets = scale > 0.8 ? 4 : 2;
    for (let k = 0; k < sheets; k++) {
      const a = (k / sheets) * Math.PI * 2 + seed;
      const r = scale * 0.45 * (k % 2 ? 1 : 0.35);
      this.items.push({
        pos: new THREE.Vector3(pos.x + Math.cos(a) * r, pos.y, pos.z + Math.sin(a) * r),
        w: scale * (0.55 + (k % 3) * 0.12),
        h: scale * (1.6 + (k % 2) * 0.7),
        seed: seed + k * 7.31,
      });
    }
  }

  build() {
    const n = Math.max(1, this.items.length);
    const { center, corner, index } = quadBuffers(n);
    const params = new Float32Array(n * 4 * 3);
    this.items.forEach((it, i) => {
      for (let k = 0; k < 4; k++) {
        center.set([it.pos.x, it.pos.y, it.pos.z], (i * 4 + k) * 3);
        params.set([it.w, it.h, it.seed], (i * 4 + k) * 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(center, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aParams', new THREE.BufferAttribute(params, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.uniforms = { uTime: { value: 0 }, uFogDensity: { value: 0.012 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec3 aParams;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vSeed;
        varying float vFog;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          mv.x += aCorner.x * aParams.x;
          mv.y += (aCorner.y * 0.5 + 0.5) * aParams.y - 0.1;
          vUv = vec2(aCorner.x, aCorner.y * 0.5 + 0.5);
          vSeed = aParams.z;
          vFog = exp(-(-mv.z) * uFogDensity * 0.6);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vUv;
        varying float vSeed;
        varying float vFog;
        ${HASH}
        void main() {
          float y = vUv.y;
          float t = uTime * 2.2 + vSeed;
          float n1 = fxNoise(vec2(vUv.x * 2.5 + vSeed, y * 3.0 - t * 1.7));
          float n2 = fxNoise(vec2(vUv.x * 5.0 - vSeed, y * 6.0 - t * 2.9));
          float n = n1 * 0.65 + n2 * 0.35;
          float x = vUv.x + (n - 0.5) * 0.9 * y;
          float width = mix(0.85, 0.05, pow(y, 0.8));
          float body = smoothstep(width, width * 0.15, abs(x));
          float heat = body * smoothstep(1.0, 0.0, y + (n - 0.5) * 0.6) * smoothstep(0.0, 0.08, y);
          if (heat < 0.02) discard;
          vec3 col = mix(vec3(0.55, 0.06, 0.01), vec3(1.0, 0.38, 0.06), smoothstep(0.1, 0.5, heat));
          col = mix(col, vec3(1.0, 0.85, 0.45), smoothstep(0.55, 0.95, heat));
          gl_FragColor = vec4(col * heat * 2.4 * vFog, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.renderOrder = 6;
    this.mesh.name = 'level-flames';
    return this.mesh;
  }
}

export class Smoke {
  constructor() {
    this.items = [];
  }

  // A plume rising from pos: `puffs` sprites cycling upward over `life` seconds.
  add(pos, scale = 1, puffs = 6) {
    for (let k = 0; k < puffs; k++) this.items.push({ pos: pos.clone(), scale, phase: k / puffs, seed: Math.random() * 50 });
  }

  build() {
    const n = Math.max(1, this.items.length);
    const { center, corner, index } = quadBuffers(n);
    const params = new Float32Array(n * 4 * 3);
    this.items.forEach((it, i) => {
      for (let k = 0; k < 4; k++) {
        center.set([it.pos.x, it.pos.y, it.pos.z], (i * 4 + k) * 3);
        params.set([it.scale, it.phase, it.seed], (i * 4 + k) * 3);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(center, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aParams', new THREE.BufferAttribute(params, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.uniforms = { uTime: { value: 0 }, uFogDensity: { value: 0.012 }, uFogColor: { value: new THREE.Color(0x3a0d08) } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec3 aParams;
        uniform float uTime;
        uniform float uFogDensity;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vFog;
        varying float vSeed;
        void main() {
          float life = 9.0;
          float t = fract(uTime / life + aParams.y);
          vec3 p = position;
          p.y += 1.2 + t * 14.0 * aParams.x;
          p.x += sin(t * 3.0 + aParams.z) * 1.5 * t + t * 3.0;
          p.z += cos(t * 2.0 + aParams.z) * 1.0 * t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float s = aParams.x * (0.9 + t * 3.5);
          mv.xy += aCorner * s;
          vUv = aCorner;
          vAlpha = smoothstep(0.0, 0.12, t) * (1.0 - t);
          vFog = 1.0 - exp(-(-mv.z) * uFogDensity);
          vSeed = aParams.z + t * 2.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uFogColor;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vFog;
        varying float vSeed;
        ${HASH}
        void main() {
          float r = length(vUv);
          float n = fxNoise(vUv * 2.5 + vSeed);
          float a = smoothstep(1.0, 0.2, r + (n - 0.5) * 0.5) * vAlpha * 0.55;
          if (a < 0.01) discard;
          vec3 col = mix(vec3(0.03, 0.02, 0.02), uFogColor, vFog * 0.85);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.renderOrder = 4;
    this.mesh.name = 'level-smoke';
    return this.mesh;
  }
}

// Distant city silhouettes. Vertex colour .r = brightness, .g = per-building seed.
export function skylineMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uFogColor: { value: new THREE.Color(0x3a0d08) },
      uDensity: { value: 0.0035 },
      uBase: { value: new THREE.Color(0x0d0707) },
      uMaxFog: { value: 0.9 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 color;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec2 vShade;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normal;
        vShade = color.rg;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uFogColor;
      uniform float uDensity;
      uniform vec3 uBase;
      uniform float uMaxFog;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec2 vShade;
      ${HASH}
      void main() {
        float dist = distance(vWorld, cameraPosition);
        vec3 col = uBase * (0.6 + vShade.x * 0.8);
        if (abs(vN.y) < 0.5) {
          float along = abs(vN.x) > 0.5 ? vWorld.z : vWorld.x;
          vec2 g = vec2(along / 3.0, vWorld.y / 3.3);
          vec2 cell = floor(g);
          vec2 f = fract(g);
          float win = step(0.28, f.x) * step(f.x, 0.72) * step(0.3, f.y) * step(f.y, 0.78);
          float h = fxHash(cell + floor(vShade.y * 173.0 + 0.5));
          col *= 1.0 - win * 0.35;
          float lit = step(0.9935, h) * win;
          col += lit * mix(vec3(1.0, 0.45, 0.16), vec3(0.95, 0.1, 0.04), step(0.6, fract(h * 37.0))) * 1.4;
        } else {
          col *= 0.7;
        }
        // Height haze: tops catch more of the glow.
        float fog = min(uMaxFog, 1.0 - exp(-dist * uDensity));
        fog = max(fog, smoothstep(0.0, 160.0, vWorld.y) * 0.25);
        gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
