import * as THREE from 'three';
import { TANK, WATER_LEVEL, LAYER_FX, shared, addPatch, worldPosPatch } from '../core/shared.js';
import { NOISE_GLSL } from '../core/glsl.js';

const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
fsGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// 波紋シミュレーション（波動方程式）
export class RippleSim {
  constructor(renderer, rect, texelCm = 0.09) {
    this.renderer = renderer;
    this.rect = rect; // {x0, z0, x1, z1}
    const w = rect.x1 - rect.x0, d = rect.z1 - rect.z0;
    this.nx = Math.ceil(w / texelCm);
    this.nz = Math.ceil(d / texelCm);
    this.texelCm = texelCm;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };
    this.rts = [new THREE.WebGLRenderTarget(this.nx, this.nz, opts), new THREE.WebGLRenderTarget(this.nx, this.nz, opts)];
    this.idx = 0;
    this.drops = [];
    this.maskTex = null;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D uState; uniform sampler2D uMask; uniform vec2 uTexel; uniform float uK; uniform float uDamp;
        uniform vec4 uRect; uniform float uTexelCm;
        uniform vec4 uDrops[24]; uniform int uDropCount;
        void main() {
          vec4 s = texture2D(uState, vUv);
          float h = s.r, v = s.g;
          float hl = texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r;
          float hr = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r;
          float hd = texture2D(uState, vUv - vec2(0.0, uTexel.y)).r;
          float hu = texture2D(uState, vUv + vec2(0.0, uTexel.y)).r;
          float avg = (hl + hr + hd + hu) * 0.25;
          v += (avg - h) * uK;
          v *= uDamp;
          h += v;
          h *= 0.9992;
          vec2 wp = uRect.xy + vUv * uRect.zw;
          for (int i = 0; i < 24; i++) {
            if (i >= uDropCount) break;
            vec4 d = uDrops[i];
            vec2 dd = wp - d.xy;
            h += d.w * exp(-dot(dd, dd) / (d.z * d.z));
          }
          float m = texture2D(uMask, vUv).r;
          h *= m; v *= m;
          vec2 g = vec2(hr - hl, hu - hd) / (2.0 * uTexelCm);
          gl_FragColor = vec4(h, v, g);
        }`,
      uniforms: {
        uState: { value: null }, uMask: { value: null }, uTexel: { value: new THREE.Vector2(1 / this.nx, 1 / this.nz) },
        uK: { value: 0.9 }, uDamp: { value: 0.988 },
        uRect: { value: new THREE.Vector4(rect.x0, rect.z0, w, d) }, uTexelCm: { value: texelCm },
        uDrops: { value: Array.from({ length: 24 }, () => new THREE.Vector4()) }, uDropCount: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(fsGeo, this.mat);
    this.quad.frustumCulled = false;
    // 共有ユニフォームへ
    shared.uRippleRect.value.set(rect.x0, rect.z0, 1 / w, 1 / d);
  }

  setMask(fn) {
    const data = new Uint8Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.rect.x0 + (i + 0.5) * this.texelCm;
        const z = this.rect.z0 + (j + 0.5) * this.texelCm;
        data[j * this.nx + i] = fn(x, z) ? 255 : 0;
      }
    }
    const tex = new THREE.DataTexture(data, this.nx, this.nz, THREE.RedFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    this.maskTex = tex;
  }

  addDrop(x, z, radius, strength) {
    if (this.drops.length >= 24) this.drops.shift();
    this.drops.push([x, z, radius, strength]);
  }

  step(substeps = 5) {
    const r = this.renderer;
    const u = this.mat.uniforms;
    u.uMask.value = this.maskTex;
    for (let s = 0; s < substeps; s++) {
      const src = this.rts[this.idx], dst = this.rts[1 - this.idx];
      u.uState.value = src.texture;
      if (s === 0) {
        u.uDropCount.value = this.drops.length;
        this.drops.forEach((d, i) => u.uDrops.value[i].set(d[0], d[1], d[2], d[3]));
        this.drops.length = 0;
      } else {
        u.uDropCount.value = 0;
      }
      r.setRenderTarget(dst);
      r.render(this.quad, fsCam);
      this.idx = 1 - this.idx;
    }
    r.setRenderTarget(null);
    shared.uRippleTex.value = this.texture;
  }

  get texture() {
    return this.rts[this.idx].texture;
  }
}

// 水面
export function buildWater(scene, { terrainField, post }) {
  // 水場の範囲（地形が水位より低い場所）
  const f = terrainField;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let j = 0; j <= f.NZ; j++) {
    for (let i = 0; i <= f.NX; i++) {
      if (f.hField[j * (f.NX + 1) + i] < WATER_LEVEL) {
        const x = f.x0 + f.dx * i, z = f.z0 + f.dz * j;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
  }
  x0 = Math.max(TANK.ix0, x0 - 0.8); x1 = Math.min(TANK.ix1, x1 + 0.8);
  z0 = Math.max(TANK.iz0, z0 - 0.8); z1 = Math.min(TANK.iz1, z1 + 0.8);
  const rect = { x0, x1, z0, z1 };

  const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, WATER_LEVEL, (z0 + z1) / 2);

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000, roughness: 0.035, metalness: 0, ior: 1.333, specularIntensity: 1,
    envMapIntensity: 1.0, transparent: true, depthWrite: true, side: THREE.DoubleSide,
  });
  worldPosPatch(mat);
  const u = {
    uRefractTex: { value: post.refractTexture },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRippleTex: shared.uRippleTex,
    uRippleRect: shared.uRippleRect,
    uTime: shared.uTime,
    uWaterScatter: shared.uWaterScatter,
  };
  addPatch(mat, {
    key: 'water-surface',
    uniforms: u,
    fragmentHead: /* glsl */ `
      uniform sampler2D uRefractTex; uniform vec2 uResolution; uniform sampler2D uRippleTex; uniform vec4 uRippleRect; uniform float uTime;
      uniform vec3 uWaterScatter;
      uniform mat4 projectionMatrix;
      vec3 waterNormalW(vec3 wp) {
        vec2 ruv = (wp.xz - uRippleRect.xy) * uRippleRect.zw;
        vec2 g = texture2D(uRippleTex, ruv).zw * 0.6;
        // 常にある穏やかな揺らぎ（ポンプの流れ）
        vec2 q = wp.xz * 0.7;
        float t = uTime;
        float e = 0.1;
        float n0 = vnoise2(q + vec2(t * 0.25, t * 0.15));
        float nx = vnoise2(q + vec2(e, 0.0) + vec2(t * 0.25, t * 0.15));
        float nz = vnoise2(q + vec2(0.0, e) + vec2(t * 0.25, t * 0.15));
        vec2 amb = vec2(nx - n0, nz - n0) / e * 0.012;
        g += amb;
        return normalize(vec3(-g.x, 1.0, -g.y));
      }
    `,
    fragment: [
      // 水面は非常に滑らか（three の下限 0.0525 を上書き）
      ['#include <lights_physical_fragment>', '#include <lights_physical_fragment>\nmaterial.roughness = 0.014;'],
      ['#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
        vec3 wN = waterNormalW(vWPos);
        if (!gl_FrontFacing) wN = -wN;
        normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
      `],
      ['#include <transmission_fragment>', /* glsl */ `
      {
        vec2 suv = gl_FragCoord.xy / uResolution;
        float surfDepth = vViewPosition.z;
        vec4 base = texture2D(uRefractTex, suv);
        float thick = clamp(base.a - surfDepth, 0.0, 30.0);
        vec3 V = normalize(cameraPosition - vWPos);
        vec3 Nw = wN;
        vec3 refr;
        float Fr;
        if (gl_FrontFacing) {
          vec3 Rd = refract(-V, Nw, 1.0 / 1.333);
          vec3 hit = vWPos + Rd * thick;
          vec4 clip = projectionMatrix * viewMatrix * vec4(hit, 1.0);
          vec2 ruv = clip.xy / clip.w * 0.5 + 0.5;
          vec4 s = texture2D(uRefractTex, ruv);
          if (s.a < surfDepth - 0.05) s = base;
          refr = s.rgb;
          float ndv = clamp(dot(Nw, V), 0.0, 1.0);
          Fr = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        } else {
          // 水中から見上げた水面（全反射）
          float ndv = clamp(dot(Nw, V), 0.0, 1.0);
          float tir = smoothstep(0.62, 0.72, 1.0 - ndv);
          vec3 above = texture2D(uRefractTex, suv + Nw.xz * 0.02).rgb;
          refr = mix(above, uWaterScatter * 1.5 + base.rgb * 0.35, tir);
          Fr = 0.0;
        }
        totalDiffuse = refr * (1.0 - Fr);
      }
      `],
    ],
  });
  const surface = new THREE.Mesh(geo, mat);
  surface.layers.set(LAYER_FX);
  surface.renderOrder = 1;
  surface.name = 'water';
  scene.add(surface);

  // 前面ガラスのメニスカス（水面の線）
  const menGeo = [];
  const menMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `varying vec2 vUv;
      void main() {
        float y = vUv.y;
        float dark = smoothstep(0.0, 0.35, y) * smoothstep(0.75, 0.45, y);
        float bright = smoothstep(0.7, 0.85, y) * smoothstep(1.0, 0.88, y);
        vec3 c = vec3(0.9, 0.95, 1.0) * bright * 0.6;
        float a = dark * 0.35 + bright * 0.5;
        gl_FragColor = vec4(c, a);
      }`,
  });
  const addMeniscus = (ax, az, bx, bz, nx, nz) => {
    const g = new THREE.PlaneGeometry(Math.hypot(bx - ax, bz - az), 0.14);
    const m = new THREE.Mesh(g, menMat);
    m.position.set((ax + bx) / 2 + nx * 0.02, WATER_LEVEL - 0.03, (az + bz) / 2 + nz * 0.02);
    m.rotation.y = Math.atan2(-(bz - az), bx - ax);
    if (nz < 0 || nx < 0) m.rotation.y += 0;
    m.layers.set(LAYER_FX);
    m.renderOrder = 5;
    scene.add(m);
    menGeo.push(m);
  };
  // 前面
  {
    let sx = null;
    const zf = TANK.iz1 - 0.01;
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const x = TANK.ix0 + (TANK.ix1 - TANK.ix0) * (i / steps);
      const j = f.NZ;
      const ii = Math.round(((x - f.x0) / (f.x1 - f.x0)) * f.NX);
      const under = f.hField[j * (f.NX + 1) + ii] < WATER_LEVEL;
      if (under && sx === null) sx = x;
      if ((!under || i === steps) && sx !== null) { addMeniscus(sx, zf, x, zf, 0, -1); sx = null; }
    }
  }
  // 右面
  {
    let sz = null;
    const xf = TANK.ix1 - 0.01;
    const steps = 150;
    for (let j = 0; j <= steps; j++) {
      const z = TANK.iz0 + (TANK.iz1 - TANK.iz0) * (j / steps);
      const jj = Math.round(((z - f.z0) / (f.z1 - f.z0)) * f.NZ);
      const under = f.hField[jj * (f.NX + 1) + f.NX] < WATER_LEVEL;
      if (under && sz === null) sz = z;
      if ((!under || j === steps) && sz !== null) {
        const g = new THREE.PlaneGeometry(z - sz, 0.14);
        const m = new THREE.Mesh(g, menMat);
        m.position.set(xf, WATER_LEVEL - 0.03, (sz + z) / 2);
        m.rotation.y = Math.PI / 2;
        m.layers.set(LAYER_FX);
        m.renderOrder = 5;
        scene.add(m);
        sz = null;
      }
    }
  }

  return { surface, material: mat, rect, uniforms: u };
}
