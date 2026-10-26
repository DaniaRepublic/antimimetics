import * as THREE from 'three';
import { FACADE_CELLS } from './textures.js';
import { skylineMaterial } from './level-fx.js';

// Shared materials for the merged level geometry. Every static material uses vertex colours so
// many differently tinted things share one draw call.

// Facades: the emissive map is a window-glow mask; which windows are actually lit is decided in
// the shader per window cell from a per-face seed (attribute aLit = [seed, probability]), so lit
// windows never repeat in a visible lattice even though the texture tiles. The material's own
// emissive colour is black, so if this patch were ever replaced no window would glow at all.
function facadeMaterial(tex, panes) {
  const m = new THREE.MeshStandardMaterial({
    map: tex.map,
    emissiveMap: tex.glow,
    emissive: 0x000000,
    emissiveIntensity: 1.0,
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aLit;\nvarying vec2 vLit;\nvarying float vLitY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = aLit;\nvLitY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vLit;
varying float vLitY;
float litHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }`)
      .replace('#include <emissivemap_fragment>', `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
  // seeds are rounded: interpolated varyings wobble in the last bits and would make the hash speckle
  vec2 cellId = floor( vEmissiveMapUv * vec2( ${FACADE_CELLS * panes}.0, ${FACADE_CELLS}.0 ) ) + floor( vLit.x + 0.5 );
  float h1 = litHash( cellId );
  float h2 = litHash( cellId.yx + 17.0 );
  // (never at street level: a glowing pane at arm's length reads as a flat lit panel, not a room)
  float lit = step( h1, vLit.y ) * step( 3.2, vLitY );
  vec3 tint = mix( vec3( 1.0, 0.46, 0.17 ), vec3( 0.9, 0.08, 0.03 ), step( 0.72, h2 ) );
  tint *= 0.25 + 0.6 * h2;
  totalEmissiveRadiance = emissiveColor.rgb * tint * lit;
#endif`);
  };
  m.customProgramCacheKey = () => `facade-lit-${panes}`;
  return m;
}

export function createLevelMaterials(T) {
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
  const decalBase = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
  const M = {
    facade_brick: facadeMaterial(T.facade.brick, 1),
    facade_concrete: facadeMaterial(T.facade.concrete, 3),
    facade_stone: facadeMaterial(T.facade.stone, 1),
    store: std({ map: T.store.map, emissiveMap: T.store.glow, emissive: 0xffffff, emissiveIntensity: 0.0, roughness: 0.75, metalness: 0.05 }),
    storeLit: std({ map: T.store.map, emissiveMap: T.store.glow, emissive: 0x8fb8a8, emissiveIntensity: 1.6, roughness: 0.6, metalness: 0.05 }),
    road: std({ map: T.road, roughness: 0.82, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    asphalt: std({ map: T.asphalt, roughness: 0.88, metalness: 0.0 }),
    paving: std({ map: T.paving, roughness: 0.9 }),
    pavers: std({ map: T.pavers, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    grass: std({ map: T.grass, roughness: 1.0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    rough: std({ map: T.concrete, roughness: 0.93 }),
    paint: std({ map: T.grime, roughness: 0.5, metalness: 0.3, envMap: T.sky, envMapIntensity: 0.35 }),
    metal: std({ map: T.grime, roughness: 0.62, metalness: 0.6, envMap: T.sky, envMapIntensity: 0.3 }),
    glass: std({ roughness: 0.08, metalness: 0.85, envMap: T.sky, envMapIntensity: 0.8 }),
    emissive: new THREE.MeshBasicMaterial({ vertexColors: true }),
    decal: std({ map: T.decals, roughness: 0.9, ...decalBase }),
    puddle: std({ map: T.decals, roughness: 0.04, metalness: 0.2, envMap: T.sky, envMapIntensity: 1.4, ...decalBase, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    graffiti: std({ map: T.graffiti, emissiveMap: T.graffiti, emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.8, ...decalBase }),
    signs: std({ map: T.signs, roughness: 0.6, metalness: 0.1 }),
    shopsigns: std({ map: T.shopSigns, roughness: 0.65, metalness: 0.1 }),
    water: std({ roughness: 0.12, metalness: 0.7, envMap: T.sky, envMapIntensity: 1.0 }),
    chain: std({ map: T.chain, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 }),
    skyline: skylineMaterial(),
  };
  for (const m of Object.values(M)) m.name = m.name || 'level';
  return M;
}
