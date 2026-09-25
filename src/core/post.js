import * as THREE from 'three';
import { LAYER_WORLD, LAYER_FX } from './shared.js';

// フルスクリーン三角形
const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const DEPTH_FUNCS = /* glsl */ `
uniform float uNear; uniform float uFar;
float linDepth(float d) { float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
`;

const COC_FUNCS = /* glsl */ `
uniform float uFocal;   // cm
uniform float uFstop;
uniform float uSensorH; // cm
uniform float uImgH;    // px (full res)
uniform sampler2D uFocusTex;
float focusDist() { return texture2D(uFocusTex, vec2(0.5)).r; }
// 符号付き錯乱円半径（フル解像度 px）。正: 合焦面より奥
float cocRadius(float d, float s) {
  float f = uFocal;
  float c = (f * f) / (uFstop * max(s - f, 0.5)) * (d - s) / max(d, 0.01);
  return 0.5 * c / uSensorH * uImgH;
}
`;

function makeMat(frag, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: frag,
    uniforms,
    depthTest: false,
    depthWrite: false,
    ...extra,
  });
}

export class PostFX {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.quad = new THREE.Mesh(fsGeo, null);
    this.quad.frustumCulled = false;
    this.samples = opts.samples ?? 4;
    this.dofEnabled = true;
    this.bloomEnabled = true;
    this.maxBlur = opts.maxBlur ?? 13;

    const hf = THREE.HalfFloatType;
    this.depthTex = new THREE.DepthTexture(1, 1);
    this.depthTex.type = THREE.UnsignedIntType;
    this.rtScene = new THREE.WebGLRenderTarget(1, 1, {
      type: hf, samples: this.samples, depthTexture: this.depthTex,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.rtRefract = new THREE.WebGLRenderTarget(1, 1, { type: hf, depthBuffer: false });
    this.rtHalfA = new THREE.WebGLRenderTarget(1, 1, { type: hf, depthBuffer: false });
    this.rtHalfB = new THREE.WebGLRenderTarget(1, 1, { type: hf, depthBuffer: false });
    this.rtFull = new THREE.WebGLRenderTarget(1, 1, { type: hf, depthBuffer: false });
    const fOpts = { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.rtFocus = [new THREE.WebGLRenderTarget(1, 1, fOpts), new THREE.WebGLRenderTarget(1, 1, fOpts)];
    this.focusIdx = 0;
    this.bloomMips = [];
    for (let i = 0; i < 6; i++) this.bloomMips.push(new THREE.WebGLRenderTarget(1, 1, { type: hf, depthBuffer: false }));

    this.params = {
      exposure: 1.0,
      fstop: 7.0,
      focusUV: new THREE.Vector2(0.5, 0.5),
      focusOverride: -1,
      focusSpeed: 0.08,
      bloomStrength: 0.045,
      bloomThreshold: 1.2,
      vignette: 0.38,
      grain: 0.028,
      ca: 0.0035,
      saturation: 1.08,
      contrast: 1.12,
      warmth: 0.0,
    };

    const common = {
      uNear: { value: 1 }, uFar: { value: 1000 },
    };
    this.common = common;
    const cocU = {
      uFocal: { value: 5 }, uFstop: { value: 4 }, uSensorH: { value: 2.4 }, uImgH: { value: 1000 },
      uFocusTex: { value: null },
    };
    this.cocU = cocU;

    this.matCopy = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uColor; uniform sampler2D uDepth;
      ${DEPTH_FUNCS}
      void main() {
        vec3 c = texture2D(uColor, vUv).rgb;
        float d = linDepth(texture2D(uDepth, vUv).r);
        gl_FragColor = vec4(c, d);
      }`, { uColor: { value: null }, uDepth: { value: null }, ...common });

    this.matFocus = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uDepth; uniform sampler2D uPrev; uniform vec2 uFocusUV; uniform float uLerp; uniform float uOverride;
      uniform vec2 uTexel;
      ${DEPTH_FUNCS}
      void main() {
        float d = 1e5;
        for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
          vec2 o = vec2(float(i), float(j)) * uTexel * 6.0;
          d = min(d, linDepth(texture2D(uDepth, uFocusUV + o).r));
        }
        d = min(d, 400.0);
        if (uOverride > 0.0) d = uOverride;
        float prev = texture2D(uPrev, vec2(0.5)).r;
        if (prev <= 0.0 || prev != prev) prev = d;
        gl_FragColor = vec4(mix(prev, d, uLerp), 0.0, 0.0, 1.0);
      }`, {
      uDepth: { value: null }, uPrev: { value: null }, uFocusUV: { value: new THREE.Vector2(0.5, 0.5) },
      uLerp: { value: 0.1 }, uOverride: { value: -1 }, uTexel: { value: new THREE.Vector2() }, ...common,
    });

    // 1/2 解像度: 色 + CoC
    this.matPrefilter = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uColor; uniform sampler2D uDepth; uniform vec2 uTexel; // full-res texel
      ${DEPTH_FUNCS}
      ${COC_FUNCS}
      void main() {
        float s = focusDist();
        vec2 o = uTexel * 0.5;
        vec2 uvs[4];
        uvs[0] = vUv + vec2(-o.x, -o.y); uvs[1] = vUv + vec2(o.x, -o.y);
        uvs[2] = vUv + vec2(-o.x, o.y); uvs[3] = vUv + vec2(o.x, o.y);
        vec3 acc = vec3(0.0); float wsum = 0.0; float coc = 0.0; float cmin = 1e5; float cmax = -1e5;
        for (int i = 0; i < 4; i++) {
          vec3 c = texture2D(uColor, uvs[i]).rgb;
          float r = cocRadius(linDepth(texture2D(uDepth, uvs[i]).r), s) * 0.5; // half-res px
          float w = 1.0 / (1.0 + max(max(c.r, c.g), c.b) * 0.25);
          acc += c * w; wsum += w;
          cmin = min(cmin, r); cmax = max(cmax, r);
        }
        coc = (abs(cmin) > abs(cmax)) ? cmin : cmax;
        gl_FragColor = vec4(acc / max(wsum, 1e-6), coc);
      }`, { uColor: { value: null }, uDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, ...common, ...cocU });

    // ボケ（ゴールデンアングル螺旋によるギャザー）
    this.matBokeh = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uHalf; uniform vec2 uTexel; uniform float uMaxR;
      void main() {
        vec4 c0 = texture2D(uHalf, vUv);
        float cc = clamp(c0.a, -uMaxR, uMaxR);
        float cs = abs(cc);
        vec3 col = c0.rgb; float tot = 1.0;
        float radius = 0.75;
        float ang = 0.0;
        for (int i = 0; i < 320; i++) {
          if (radius >= uMaxR) break;
          vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
          vec4 s = texture2D(uHalf, tc);
          float ssz = min(abs(s.a), uMaxR);
          if (s.a > cc) ssz = clamp(ssz, 0.0, cs * 2.0);
          float m = smoothstep(radius - 0.5, radius + 0.5, ssz);
          col += mix(col / tot, s.rgb, m);
          tot += 1.0;
          radius += 0.75 / radius;
          ang += 2.39996323;
        }
        gl_FragColor = vec4(col / tot, cc);
      }`, { uHalf: { value: null }, uTexel: { value: new THREE.Vector2() }, uMaxR: { value: 16 } });

    // 合成（フル解像度）
    this.matComposite = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uColor; uniform sampler2D uDepth; uniform sampler2D uBlur; uniform float uDof;
      ${DEPTH_FUNCS}
      ${COC_FUNCS}
      void main() {
        vec3 sharp = texture2D(uColor, vUv).rgb;
        if (uDof < 0.5) { gl_FragColor = vec4(sharp, 1.0); return; }
        float s = focusDist();
        float r = cocRadius(linDepth(texture2D(uDepth, vUv).r), s);
        vec4 b = texture2D(uBlur, vUv);
        float t = smoothstep(0.7, 2.2, abs(r));
        float nearBleed = smoothstep(1.0, 3.0, -b.a * 2.0);
        vec3 col = mix(sharp, b.rgb, max(t, nearBleed));
        gl_FragColor = vec4(col, 1.0);
      }`, { uColor: { value: null }, uDepth: { value: null }, uBlur: { value: null }, uDof: { value: 1 }, ...common, ...cocU });

    // ブルーム
    this.matDown = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uFirst; uniform float uThreshold;
      vec3 S(vec2 o) { return texture2D(uSrc, vUv + o * uTexel).rgb; }
      float karis(vec3 c) { return 1.0 / (1.0 + max(max(c.r, c.g), c.b)); }
      void main() {
        vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2));
        vec3 d = S(vec2(-2, 0)), e = S(vec2(0, 0)), f = S(vec2(2, 0));
        vec3 g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2));
        vec3 j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));
        vec3 col;
        if (uFirst > 0.5) {
          vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
          float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
          col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
                (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
          float br = max(max(col.r, col.g), col.b);
          float soft = clamp(br - uThreshold * 0.6, 0.0, uThreshold * 0.8);
          soft = soft * soft / (4.0 * uThreshold * 0.4 + 1e-4);
          float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
          col *= max(contrib, 0.0);
        } else {
          col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        }
        gl_FragColor = vec4(col, 1.0);
      }`, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 1 } });

    this.matUp = makeMat(/* glsl */ `
      varying vec2 vUv;
      uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRadius;
      void main() {
        vec2 t = uTexel * uRadius;
        vec3 c = texture2D(uSrc, vUv).rgb * 4.0;
        c += (texture2D(uSrc, vUv + vec2(-t.x, 0)).rgb + texture2D(uSrc, vUv + vec2(t.x, 0)).rgb + texture2D(uSrc, vUv + vec2(0, -t.y)).rgb + texture2D(uSrc, vUv + vec2(0, t.y)).rgb) * 2.0;
        c += texture2D(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(uSrc, vUv + vec2(t.x, -t.y)).rgb + texture2D(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(uSrc, vUv + vec2(t.x, t.y)).rgb;
        gl_FragColor = vec4(c / 16.0, 1.0);
      }`, { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } }, {
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    });

    this.matFinal = makeMat(/* glsl */ `
      #include <common>
      #include <tonemapping_pars_fragment>
      varying vec2 vUv;
      uniform sampler2D uScene; uniform sampler2D uBloom; uniform float uBloomStrength; uniform float uExposure;
      uniform float uVignette; uniform float uGrain; uniform float uTime; uniform float uCA; uniform vec2 uRes;
      uniform float uSat; uniform float uContrast; uniform float uWarmth; uniform float uFade;
      float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      vec3 srgbOETF(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec2 uv = vUv;
        vec2 dc = uv - 0.5;
        dc.x *= uRes.x / uRes.y;
        float r2 = dot(dc, dc);
        vec2 caOff = (uv - 0.5) * uCA * r2 * 4.0;
        vec3 col;
        col.r = texture2D(uScene, uv - caOff).r;
        col.g = texture2D(uScene, uv).g;
        col.b = texture2D(uScene, uv + caOff).b;
        col += texture2D(uBloom, uv).rgb * uBloomStrength;
        col *= uExposure;
        col.r *= 1.0 + uWarmth * 0.06; col.b *= 1.0 - uWarmth * 0.06;
        col = AgXToneMapping(col);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, uSat);
        col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
        float vig = smoothstep(1.05, 0.2, sqrt(r2) * 1.15);
        col *= mix(1.0, vig, uVignette);
        col = srgbOETF(max(col, 0.0));
        float n = h12(gl_FragCoord.xy + fract(uTime * 13.7) * 311.0) + h12(gl_FragCoord.xy * 1.37 + fract(uTime * 7.3) * 97.0) - 1.0;
        col += n * uGrain * (1.0 - col * 0.6);
        col *= uFade;
        gl_FragColor = vec4(col, 1.0);
      }`, {
      uScene: { value: null }, uBloom: { value: null }, uBloomStrength: { value: 0.05 }, uExposure: { value: 1 },
      uVignette: { value: 0.3 }, uGrain: { value: 0.03 }, uTime: { value: 0 }, uCA: { value: 0.003 },
      uRes: { value: new THREE.Vector2() }, uSat: { value: 1 }, uContrast: { value: 1 }, uWarmth: { value: 0 }, uFade: { value: 1 },
    });
    this.matFinal.toneMapped = false;

    this.width = 1; this.height = 1;
  }

  setSize(w, h) {
    // w, h: 描画バッファのピクセル数
    this.width = w; this.height = h;
    this.rtScene.setSize(w, h);
    this.rtRefract.setSize(w, h);
    this.rtFull.setSize(w, h);
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    this.rtHalfA.setSize(hw, hh);
    this.rtHalfB.setSize(hw, hh);
    let bw = hw, bh = hh;
    for (const rt of this.bloomMips) {
      rt.setSize(Math.max(1, bw), Math.max(1, bh));
      bw = Math.floor(bw / 2); bh = Math.floor(bh / 2);
    }
    this.cocU.uImgH.value = h;
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, fsCam);
  }

  // シーン描画 + ポストエフェクト
  render(scene, camera, dt, time) {
    const r = this.renderer;
    const P = this.params;
    this.common.uNear.value = camera.near;
    this.common.uFar.value = camera.far;
    // カメラの焦点距離（35mm判換算）
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    this.cocU.uFocal.value = (0.5 * 2.4) / Math.tan(fovRad / 2);
    this.cocU.uFstop.value = P.fstop;

    // 1パス目: 不透明ワールド
    r.shadowMap.needsUpdate = true;
    camera.layers.set(LAYER_WORLD);
    r.autoClear = false;
    r.setRenderTarget(this.rtScene);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, true);
    r.render(scene, camera);
    r.shadowMap.needsUpdate = false;
    r.autoClear = true;

    // 屈折用コピー（色 + 線形深度）
    this.matCopy.uniforms.uColor.value = this.rtScene.texture;
    this.matCopy.uniforms.uDepth.value = this.depthTex;
    this.pass(this.matCopy, this.rtRefract);

    // 2パス目: 水面・ガラス（1パス目の MSAA バッファに重ね描き）
    camera.layers.set(LAYER_FX);
    r.autoClear = false;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);
    r.autoClear = true;
    camera.layers.set(LAYER_WORLD);
    camera.layers.enable(LAYER_FX);

    // フォーカス
    const prev = this.rtFocus[this.focusIdx];
    const next = this.rtFocus[1 - this.focusIdx];
    const fu = this.matFocus.uniforms;
    fu.uDepth.value = this.depthTex;
    fu.uPrev.value = prev.texture;
    fu.uFocusUV.value.copy(P.focusUV);
    fu.uLerp.value = this.snapFocus ? 1 : 1 - Math.pow(1 - P.focusSpeed, dt * 60);
    fu.uOverride.value = P.focusOverride;
    fu.uTexel.value.set(1 / this.width, 1 / this.height);
    this.pass(this.matFocus, next);
    this.focusIdx = 1 - this.focusIdx;
    this.cocU.uFocusTex.value = next.texture;

    let sceneTex = this.rtScene.texture;
    if (this.dofEnabled) {
      const pu = this.matPrefilter.uniforms;
      pu.uColor.value = sceneTex;
      pu.uDepth.value = this.depthTex;
      pu.uTexel.value.set(1 / this.width, 1 / this.height);
      this.pass(this.matPrefilter, this.rtHalfA);
      const bu = this.matBokeh.uniforms;
      bu.uHalf.value = this.rtHalfA.texture;
      bu.uTexel.value.set(1 / this.rtHalfA.width, 1 / this.rtHalfA.height);
      bu.uMaxR.value = this.maxBlur;
      this.pass(this.matBokeh, this.rtHalfB);
    }
    const cu = this.matComposite.uniforms;
    cu.uColor.value = sceneTex;
    cu.uDepth.value = this.depthTex;
    cu.uBlur.value = this.rtHalfB.texture;
    cu.uDof.value = this.dofEnabled ? 1 : 0;
    this.pass(this.matComposite, this.rtFull);

    // ブルーム
    if (this.bloomEnabled) {
      let src = this.rtFull;
      const du = this.matDown.uniforms;
      for (let i = 0; i < this.bloomMips.length; i++) {
        du.uSrc.value = src.texture;
        du.uTexel.value.set(1 / src.width, 1 / src.height);
        du.uFirst.value = i === 0 ? 1 : 0;
        du.uThreshold.value = P.bloomThreshold;
        this.pass(this.matDown, this.bloomMips[i]);
        src = this.bloomMips[i];
      }
      const uu = this.matUp.uniforms;
      for (let i = this.bloomMips.length - 1; i > 0; i--) {
        const lo = this.bloomMips[i], hi = this.bloomMips[i - 1];
        uu.uSrc.value = lo.texture;
        uu.uTexel.value.set(1 / lo.width, 1 / lo.height);
        this.renderer.autoClear = false;
        this.pass(this.matUp, hi);
        this.renderer.autoClear = true;
      }
    }

    const f = this.matFinal.uniforms;
    f.uScene.value = this.rtFull.texture;
    f.uBloom.value = this.bloomMips[0].texture;
    f.uBloomStrength.value = this.bloomEnabled ? P.bloomStrength : 0;
    f.uExposure.value = P.exposure;
    f.uVignette.value = P.vignette;
    f.uGrain.value = P.grain;
    f.uTime.value = time;
    f.uCA.value = P.ca;
    f.uRes.value.set(this.width, this.height);
    f.uSat.value = P.saturation;
    f.uContrast.value = P.contrast;
    f.uWarmth.value = P.warmth;
    this.pass(this.matFinal, null);
  }

  // 水面シェーダ用の屈折テクスチャ
  get refractTexture() {
    return this.rtRefract.texture;
  }
}
