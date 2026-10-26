import * as THREE from 'three';

// Dev-only stand-in for src/world/atmosphere.js used by tools/level-build.mjs, so the level can be
// judged under something close to the final lighting: red sky dome, exp2 fog, hemisphere light and
// a pool of 6 real point lights assigned to the nearest registered light sources each frame.
export class Atmosphere {
  constructor(game) {
    this.game = game;
    this.lightSources = [];
    this.fogColor = new THREE.Color(0x4a130b);
    this.skyGlowColor = new THREE.Color(0xff4a1e);
    this.fogDensity = Number(new URLSearchParams(location.search).get('fog') || 0.011);
    game.scene.fog = new THREE.FogExp2(this.fogColor, this.fogDensity);
    game.scene.background = this.fogColor.clone();
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uHorizon: { value: new THREE.Color(0x8a2410) }, uZenith: { value: new THREE.Color(0x120202) }, uFog: { value: this.fogColor } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position + cameraPosition, 1.0); }',
        fragmentShader: `uniform vec3 uHorizon; uniform vec3 uZenith; uniform vec3 uFog; varying vec3 vDir;
          void main(){ float h = clamp(vDir.y, -1.0, 1.0);
            vec3 c = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
            c = mix(c, uFog, smoothstep(0.08, -0.05, h));
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    game.scene.add(sky);
    this.hemi = new THREE.HemisphereLight(0xd0583e, 0x2a0e08, Number(new URLSearchParams(location.search).get('hemi') || 2.4));
    game.scene.add(this.hemi);
    this.pool = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      game.scene.add(l);
      this.pool.push(l);
    }
    this.t = 0;
  }

  registerLightSource(src) {
    const h = { enabled: true, flicker: 0, stealthWeight: 0.8, ...src };
    this.lightSources.push(h);
    return h;
  }

  lightLevelAt(pos) {
    let l = 0.15;
    for (const s of this.lightSources) {
      if (s.enabled === false || !s.stealthRadius) continue;
      const d = Math.hypot(pos.x - s.pos.x, pos.z - s.pos.z);
      if (d < s.stealthRadius) l += (1 - d / s.stealthRadius) * (s.stealthWeight ?? 0.8);
    }
    return Math.min(1, l);
  }

  setThreat() {}
  setDeath() {}
  onFootfall() {}
  setCall() {}

  update(dt) {
    this.t += dt;
  }

  resize() {}

  render() {
    const cam = this.game.camera.position;
    const list = this.lightSources
      .filter((s) => s.enabled !== false && s.intensity > 0)
      .map((s) => ({ s, d: s.pos.distanceToSquared(cam) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.pool.length);
    this.pool.forEach((l, i) => {
      const e = list[i];
      if (!e) {
        l.intensity = 0;
        return;
      }
      const f = e.s.flicker ? 1 - e.s.flicker * 0.5 * (0.5 + 0.5 * Math.sin(this.t * 23 + i * 7) * Math.sin(this.t * 13.1 + i)) : 1;
      l.position.copy(e.s.pos);
      l.color.set(e.s.color);
      l.intensity = e.s.intensity * f;
      l.distance = e.s.distance;
    });
    this.game.renderer.render(this.game.scene, this.game.camera);
  }
}
