import * as THREE from 'three';
import {
  NOISE_GLSL, CAUSTIC_GLSL, WATERFX_PARS, WATERFX_LIGHT, WATERFX_FOG,
  WORLDPOS_VERT_PARS, WORLDPOS_VERT, WORLDPOS_FRAG_PARS,
} from './glsl.js';

// ---- 水槽レイアウト定数（単位: cm） ----
export const TANK = {
  w: 40, d: 25, h: 28, glass: 0.5,
};
TANK.ix0 = -TANK.w / 2 + TANK.glass;
TANK.ix1 = TANK.w / 2 - TANK.glass;
TANK.iz0 = -TANK.d / 2 + TANK.glass;
TANK.iz1 = TANK.d / 2 - TANK.glass;

export const WATER_LEVEL = 4.6;

export const LAYER_WORLD = 0;
export const LAYER_FX = 1; // 水面・ガラスなど（2パス目）
export const LAYER_NAV = 2; // ナビ用ハイトマップ
export const LAYER_CEIL = 3; // 天井（シェルター石の裏）

// ---- 共有ユニフォーム ----
const dummyTex = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
dummyTex.needsUpdate = true;

export const shared = {
  uTime: { value: 0 },
  uWaterLevel: { value: WATER_LEVEL },
  uCaustic: { value: 1.0 },
  uWaterAbsorb: { value: new THREE.Vector3(0.075, 0.032, 0.036) },
  uWaterScatter: { value: new THREE.Color(0.012, 0.03, 0.028) },
  uTankInner: { value: new THREE.Vector4(TANK.ix0, TANK.iz0, TANK.ix1, TANK.iz1) },
  uRippleTex: { value: dummyTex },
  uRippleRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uCausticLight: { value: new THREE.Color(1, 1, 1) },
  uNight: { value: 0 },
};

// ---- マテリアルのパッチ（onBeforeCompile の合成） ----
function replaceChecked(src, find, repl, label) {
  if (!src.includes(find)) {
    console.warn('[patch] chunk not found:', find, label || '');
    return src;
  }
  return src.replace(find, repl);
}

export function addPatch(mat, patch) {
  const list = mat.userData._patches || (mat.userData._patches = []);
  list.push(patch);
  mat.onBeforeCompile = (shader) => {
    let vHead = '', fHead = '';
    for (const p of list) {
      if (p.uniforms) Object.assign(shader.uniforms, p.uniforms);
      if (p.vertexHead) vHead += '\n' + p.vertexHead;
      if (p.fragmentHead) fHead += '\n' + p.fragmentHead;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + vHead);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + fHead);
    for (const p of list) {
      for (const [a, b] of p.vertex || []) shader.vertexShader = replaceChecked(shader.vertexShader, a, b, p.key);
      for (const [a, b] of p.fragment || []) shader.fragmentShader = replaceChecked(shader.fragmentShader, a, b, p.key);
    }
    mat.userData.shader = shader;
  };
  const key = list.map((p) => p.key).join('|');
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
  return mat;
}

// ワールド座標 varying を追加（多くのパッチの前提）
export function worldPosPatch(mat) {
  if (mat.userData._hasWorldPos) return mat;
  mat.userData._hasWorldPos = true;
  return addPatch(mat, {
    key: 'wpos',
    vertexHead: WORLDPOS_VERT_PARS,
    fragmentHead: WORLDPOS_FRAG_PARS + NOISE_GLSL,
    vertex: [['#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERT]],
  });
}

// 水中効果（コースティクス・吸収）と濡れ
export function waterFxPatch(mat, { wetHeight = 0.6, wetDarken = 0.55, wetGloss = 0.85, porous = 1.0 } = {}) {
  worldPosPatch(mat);
  const u = {
    uTime: shared.uTime,
    uWaterLevel: shared.uWaterLevel,
    uCaustic: shared.uCaustic,
    uWaterAbsorb: shared.uWaterAbsorb,
    uWaterScatter: shared.uWaterScatter,
    uTankInner: shared.uTankInner,
    uRippleTex: shared.uRippleTex,
    uRippleRect: shared.uRippleRect,
    uCausticLight: shared.uCausticLight,
    uWetHeight: { value: wetHeight },
    uWetDarken: { value: wetDarken * porous },
    uWetGloss: { value: wetGloss },
    uExtraWet: mat.userData.uExtraWet || (mat.userData.uExtraWet = { value: 0 }),
  };
  return addPatch(mat, {
    key: 'waterfx',
    uniforms: u,
    fragmentHead: CAUSTIC_GLSL + WATERFX_PARS + `
uniform float uWetHeight; uniform float uWetDarken; uniform float uWetGloss; uniform float uExtraWet;
float wetFactor() {
  float w = 1.0 - smoothstep(uWaterLevel - 0.05, uWaterLevel + uWetHeight, vWPos.y);
  return clamp(max(w, uExtraWet), 0.0, 1.0);
}
`,
    fragment: [
      ['#include <roughnessmap_fragment>', `
      float _wet = wetFactor();
      diffuseColor.rgb *= mix(1.0, 1.0 - uWetDarken, _wet);
      #include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, min(roughnessFactor, 0.12), _wet * uWetGloss);
      `],
      ['#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + WATERFX_LIGHT],
      ['#include <opaque_fragment>', WATERFX_FOG + '\n#include <opaque_fragment>'],
    ],
  });
}

// 便利関数
export function srgb(hex) {
  return new THREE.Color(hex);
}
export function yieldFrame() {
  // 非表示タブでも読み込みが止まらないよう、タイマーでも解決する
  return new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 40);
  });
}
