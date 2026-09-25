import * as THREE from 'three';
import { TANK, LAYER_NAV, addPatch, worldPosPatch, waterFxPatch } from '../core/shared.js';
import { terrainAt, mossAt } from './layout.js';

// 地形グリッドからの高速な高さ取得（双線形補間）
export function heightSampler(f) {
  return (x, z) => {
    let fx = ((x - f.x0) / (f.x1 - f.x0)) * f.NX, fz = ((z - f.z0) / (f.z1 - f.z0)) * f.NZ;
    fx = Math.min(Math.max(fx, 0), f.NX - 0.001); fz = Math.min(Math.max(fz, 0), f.NZ - 0.001);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const w = f.NX + 1, H = f.hField;
    const a = H[j * w + i], b = H[j * w + i + 1], c = H[(j + 1) * w + i], d = H[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
}

// 底床（砂利・土・断面）
export function buildTerrain(scene) {
  const NX = 240, NZ = 150;
  const x0 = TANK.ix0, x1 = TANK.ix1, z0 = TANK.iz0, z1 = TANK.iz1;
  const hField = new Float32Array((NX + 1) * (NZ + 1));
  const gField = new Float32Array((NX + 1) * (NZ + 1));
  const mField = new Float32Array((NX + 1) * (NZ + 1));
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      const x = x0 + (x1 - x0) * (i / NX);
      const z = z0 + (z1 - z0) * (j / NZ);
      const t = terrainAt(x, z);
      const k = j * (NX + 1) + i;
      hField[k] = t.h;
      gField[k] = t.gravel;
      mField[k] = mossAt(x, z);
    }
  }
  const dx = (x1 - x0) / NX, dz = (z1 - z0) / NZ;
  const H = (i, j) => hField[Math.min(NZ, Math.max(0, j)) * (NX + 1) + Math.min(NX, Math.max(0, i))];

  // 上面
  const vCount = (NX + 1) * (NZ + 1);
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const zone = new Float32Array(vCount * 3); // x: 砂利, y: 苔, z: 断面フラグ
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      const k = j * (NX + 1) + i;
      pos[k * 3] = x0 + dx * i;
      pos[k * 3 + 1] = hField[k];
      pos[k * 3 + 2] = z0 + dz * j;
      const nx = -(H(i + 1, j) - H(i - 1, j)) / (2 * dx);
      const nz = -(H(i, j + 1) - H(i, j - 1)) / (2 * dz);
      const l = Math.hypot(nx, 1, nz);
      nrm[k * 3] = nx / l; nrm[k * 3 + 1] = 1 / l; nrm[k * 3 + 2] = nz / l;
      zone[k * 3] = gField[k];
      zone[k * 3 + 1] = mField[k];
      zone[k * 3 + 2] = 0;
    }
  }
  const idx = [];
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i, b = a + 1, c = a + NX + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  top.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  top.setAttribute('aZone', new THREE.BufferAttribute(zone, 3));
  top.setIndex(idx);

  // 側面（ガラス越しに見える断面）
  const sp = [], sn = [], sz = [], si = [];
  const addSkirt = (pts, normal) => {
    const base = sp.length / 3;
    for (const p of pts) {
      sp.push(p.x, 0, p.z, p.x, p.h, p.z);
      sn.push(...normal, ...normal);
      sz.push(p.g, 0, 1, p.g, 0, 1);
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = base + k * 2, b = a + 1, c = a + 2, d = a + 3;
      si.push(a, c, b, b, c, d);
    }
  };
  const row = (j) => { const r = []; for (let i = 0; i <= NX; i++) { const k = j * (NX + 1) + i; r.push({ x: pos[k * 3], z: pos[k * 3 + 2], h: hField[k], g: gField[k] }); } return r; };
  const col = (i) => { const r = []; for (let j = 0; j <= NZ; j++) { const k = j * (NX + 1) + i; r.push({ x: pos[k * 3], z: pos[k * 3 + 2], h: hField[k], g: gField[k] }); } return r; };
  addSkirt(row(NZ), [0, 0, 1]);
  addSkirt(row(0).reverse(), [0, 0, -1]);
  addSkirt(col(0), [-1, 0, 0]);
  addSkirt(col(NX).reverse(), [1, 0, 0]);
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  skirt.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
  skirt.setAttribute('aZone', new THREE.Float32BufferAttribute(sz, 3));
  skirt.setIndex(si);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  terrainPatch(mat);
  waterFxPatch(mat, { wetHeight: 0.9, wetDarken: 0.5, wetGloss: 0.55 });

  const meshTop = new THREE.Mesh(top, mat);
  meshTop.receiveShadow = true;
  meshTop.name = 'terrain';
  meshTop.layers.enable(LAYER_NAV);
  const meshSkirt = new THREE.Mesh(skirt, mat);
  meshSkirt.receiveShadow = true;
  scene.add(meshTop, meshSkirt);

  return {
    mesh: meshTop, skirt: meshSkirt, material: mat,
    field: { hField, gField, mField, NX, NZ, x0, x1, z0, z1, dx, dz },
  };
}

function terrainPatch(mat) {
  worldPosPatch(mat);
  addPatch(mat, {
    key: 'terrain',
    vertexHead: 'attribute vec3 aZone; varying vec3 vZone;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvZone = aZone;']],
    fragmentHead: /* glsl */ `
varying vec3 vZone;
vec3 tSandCol(vec3 p, float fade, out float hgt) {
  vec2 q = p.xz;
  vec2 w1 = worley2(q * 3.6);
  vec2 w2 = worley2(q * 8.5 + 3.7);
  float g = vnoise2(q * 38.0);
  g = mix(g, 0.5, fade);
  float peb1 = smoothstep(0.46, 0.30, w1.x);
  float peb2 = smoothstep(0.42, 0.26, w2.x) * (1.0 - peb1);
  vec3 sand = vec3(0.235, 0.205, 0.165) * (0.78 + 0.44 * g);
  float sp = hash12(floor(q * 55.0));
  sand = mix(sand, vec3(0.05, 0.045, 0.04), step(0.92, sp) * (1.0 - fade));
  sand = mix(sand, vec3(0.45, 0.42, 0.38), step(0.965, sp) * (1.0 - fade));
  vec3 pc1 = mix(vec3(0.13, 0.125, 0.12), vec3(0.36, 0.33, 0.28), hash11(w1.y * 91.0));
  pc1 = mix(pc1, vec3(0.3, 0.17, 0.09), step(0.85, hash11(w1.y * 13.0)) * 0.7);
  vec3 pc2 = mix(vec3(0.1, 0.1, 0.1), vec3(0.4, 0.38, 0.34), hash11(w2.y * 57.0));
  vec3 c = sand;
  c = mix(c, pc2, peb2);
  c = mix(c, pc1, peb1);
  hgt = (peb1 * (0.46 - w1.x) * 0.22 + peb2 * (0.42 - w2.x) * 0.08) * (1.0 - fade * 0.7) + g * 0.004 * (1.0 - fade);
  return c;
}
vec3 tSoilCol(vec3 p, float fade, out float hgt) {
  vec2 q = p.xz;
  vec2 w = worley2(q * 6.0);
  float n = vnoise2(q * 2.3) * 0.6 + vnoise2(q * 11.0) * 0.4;
  vec3 c = mix(vec3(0.045, 0.03, 0.02), vec3(0.11, 0.075, 0.048), n);
  float gran = smoothstep(0.5, 0.2, w.x);
  c *= 0.75 + 0.5 * gran * hash11(w.y * 17.0);
  float fib = smoothstep(0.93, 0.99, vnoise2(vec2(q.x * 30.0 + q.y * 9.0, q.y * 4.0)));
  c = mix(c, vec3(0.22, 0.15, 0.08), fib * 0.5 * (1.0 - fade));
  hgt = gran * 0.02 * (1.0 - fade);
  return c;
}
`,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `#include <color_fragment>
      float tH = 0.0;
      {
        vec3 p = vWPos;
        float fw = length(fwidth(p));
        float fade = smoothstep(0.006, 0.03, fw);
        float hs, hl;
        vec3 cs, cl;
        if (vZone.z > 0.5) {
          // 断面: ガラスに押し付けられた粒
          vec2 q = abs(vWNrm.z) > 0.5 ? p.xy : p.zy;
          vec2 w = worley2(q * vec2(3.2, 3.6));
          float soilLayer = smoothstep(1.3, 1.9, p.y + vnoise2(q * 0.8) * 0.6) * (1.0 - vZone.x);
          vec3 gcol = mix(vec3(0.12, 0.115, 0.1), vec3(0.4, 0.37, 0.32), hash11(w.y * 71.0));
          vec3 scol = mix(vec3(0.03, 0.022, 0.016), vec3(0.09, 0.06, 0.04), hash11(w.y * 23.0));
          vec3 c = mix(gcol, scol, soilLayer);
          float gap = smoothstep(0.28, 0.5, w.x);
          c *= mix(1.0, 0.18, gap);
          diffuseColor.rgb = c;
          tH = (0.5 - w.x) * 0.1;
        } else {
          cs = tSandCol(p, fade, hs);
          cl = tSoilCol(p, fade, hl);
          float gw = smoothstep(0.15, 0.85, vZone.x + (vnoise2(p.xz * 1.7) - 0.5) * 0.35);
          vec3 c = mix(cl, cs, gw);
          tH = mix(hl, hs, gw);
          // 苔の下は暗い緑がかった土
          c = mix(c, vec3(0.03, 0.04, 0.015), smoothstep(0.05, 0.4, vZone.y) * 0.85);
          diffuseColor.rgb = c;
        }
      }`],
      ['#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
      {
        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
        float dhx = dFdx(tH), dhy = dFdy(tH);
        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
        float det = dot(dpdx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        normal = safeNormalize(abs(det) * normal - grad, normal);
      }`],
    ],
  });
}
