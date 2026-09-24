import * as THREE from 'three';
import { addPatch, worldPosPatch, shared, TANK } from '../core/shared.js';
import { RNG } from '../core/rng.js';
import { heightAt, mossAt, ROCKS } from './layout.js';

// ---- ハイゴケ（シェル法による絨毯状の苔） ----
export function buildMossCarpet(scene, field, { shells = 24, thick = 0.6 } = {}) {
  const step = 2;
  const NX = Math.floor(field.NX / step), NZ = Math.floor(field.NZ / step);
  const pos = [], nrm = [], moss = [], index = [];
  const map = new Int32Array((NX + 1) * (NZ + 1)).fill(-1);
  const e = 0.2;
  // 苔のある頂点だけを使う
  const need = (i, j) => {
    const fi = Math.min(field.NX, i * step), fj = Math.min(field.NZ, j * step);
    return field.mField[fj * (field.NX + 1) + fi];
  };
  for (let j = 0; j <= NZ; j++) {
    for (let i = 0; i <= NX; i++) {
      let m = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = Math.max(0, Math.min(NX, i + di)), jj = Math.max(0, Math.min(NZ, j + dj));
        m = Math.max(m, need(ii, jj));
      }
      if (m <= 0.01) continue;
      const x = field.x0 + (field.x1 - field.x0) * (i / NX);
      const z = field.z0 + (field.z1 - field.z0) * (j / NZ);
      const h = heightAt(x, z);
      const nx = heightAt(x - e, z) - heightAt(x + e, z), nz = heightAt(x, z - e) - heightAt(x, z + e);
      const l = Math.hypot(nx, 2 * e, nz);
      map[j * (NX + 1) + i] = pos.length / 3;
      pos.push(x, h, z);
      nrm.push(nx / l, (2 * e) / l, nz / l);
      moss.push(need(i, j));
    }
  }
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const a = map[j * (NX + 1) + i], b = map[j * (NX + 1) + i + 1], c = map[(j + 1) * (NX + 1) + i], d = map[(j + 1) * (NX + 1) + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aMoss', new THREE.Float32BufferAttribute(moss, 1));
  geo.setIndex(index);
  const shellArr = new Float32Array(shells);
  for (let i = 0; i < shells; i++) shellArr[i] = 1 - i / (shells - 1); // 上の層から描く
  geo.setAttribute('aShell', new THREE.InstancedBufferAttribute(shellArr, 1));
  geo.instanceCount = shells;
  geo.computeBoundingSphere();
  geo.boundingSphere.radius += 2;

  const mat = mossMaterial(thick);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = 'moss';
  scene.add(mesh);
  return { mesh, material: mat };
}

// ---- 岩の上の苔（上向きの面にシェルを重ねる） ----
export function buildRockMoss(scene, rocks, { shells = 18, thick = 0.5 } = {}) {
  const pos = [], nrm = [], moss = [];
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const noise = (x, y, z) => {
    // 軽い 3D 値ノイズ代わり
    return 0.5 + 0.25 * Math.sin(x * 0.9 + Math.sin(z * 1.3)) + 0.25 * Math.sin(z * 0.8 + Math.cos(y * 1.1 + x * 0.4));
  };
  for (const r of rocks) {
    const def = r.userData.def;
    if (!['seiryu', 'slab', 'river'].includes(def.type)) continue;
    if (def.type === 'river' && def.seed % 3 === 0) continue;
    const g = r.geometry;
    const P = g.attributes.position, N = g.attributes.normal, I = g.index.array;
    r.updateMatrixWorld(true);
    nm.getNormalMatrix(r.matrixWorld);
    const wp = new Float32Array(P.count * 3), wn = new Float32Array(P.count * 3), wm = new Float32Array(P.count);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(r.matrixWorld);
      n.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      wp[i * 3] = v.x; wp[i * 3 + 1] = v.y; wp[i * 3 + 2] = v.z;
      wn[i * 3] = n.x; wn[i * 3 + 1] = n.y; wn[i * 3 + 2] = n.z;
      const up = THREE.MathUtils.smoothstep(n.y, 0.5, 0.9);
      const nz = THREE.MathUtils.smoothstep(noise(v.x, v.y, v.z), 0.4, 0.62);
      // 水面より下や水際には付けない
      const dry = THREE.MathUtils.smoothstep(v.y, 5.4, 6.2);
      wm[i] = up * nz * dry * (def.type === 'river' ? 0.7 : 1);
    }
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (wm[a] < 0.03 && wm[b] < 0.03 && wm[c] < 0.03) continue;
      for (const k of [a, b, c]) {
        pos.push(wp[k * 3], wp[k * 3 + 1], wp[k * 3 + 2]);
        nrm.push(wn[k * 3], wn[k * 3 + 1], wn[k * 3 + 2]);
        moss.push(wm[k]);
      }
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('aMoss', new THREE.Float32BufferAttribute(moss, 1));
  const shellArr = new Float32Array(shells);
  for (let i = 0; i < shells; i++) shellArr[i] = 1 - i / (shells - 1);
  geo.setAttribute('aShell', new THREE.InstancedBufferAttribute(shellArr, 1));
  geo.instanceCount = shells;
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mossMaterial(thick));
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = 'rock-moss';
  scene.add(mesh);
  return { mesh };
}

function mossMaterial(thick) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  worldPosPatch(m);
  addPatch(m, {
    key: 'moss-shell',
    uniforms: { uThick: { value: thick }, uTime: shared.uTime },
    vertexHead: /* glsl */ `
      attribute float aShell; attribute float aMoss;
      uniform float uThick; uniform float uTime;
      varying float vShell; varying float vMoss; varying vec3 vBase;
    `,
    vertex: [['#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
      vShell = aShell; vMoss = aMoss;
      vBase = (modelMatrix * vec4(position, 1.0)).xyz;
      {
        float hh = (0.015 + aShell * uThick) * smoothstep(0.0, 0.35, aMoss);
        transformed += objectNormal * hh;
        // 先端がわずかに寝る
        vec2 lean = vec2(sin(vBase.x * 1.3 + vBase.z * 0.7), cos(vBase.z * 1.1 - vBase.x * 0.4)) * 0.06;
        lean += vec2(sin(uTime * 0.7 + vBase.x * 2.0), cos(uTime * 0.6 + vBase.z * 2.0)) * 0.004;
        transformed.xz += lean * aShell * aShell;
      }`]],
    fragmentHead: /* glsl */ `
      varying float vShell; varying float vMoss; varying vec3 vBase;
    `,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `#include <color_fragment>
      float mossRel = 1.0;
      float mH = 0.0;
      {
        vec2 p = vBase.xz;
        float fw = length(fwidth(p));
        float fade = smoothstep(0.004, 0.025, fw);
        vec2 cw = worley2(p * 0.7 + 3.0);
        float cushion = 1.0 - smoothstep(0.0, 1.1, cw.x);
        vec2 cw2 = worley2(p * 2.1 + 11.0);
        float sub = 1.0 - smoothstep(0.0, 1.0, cw2.x);
        float mid = vnoise2(p * 6.5) * 0.6 + vnoise2(p * 13.0 + 3.0) * 0.4;
        float st = vnoise2(p * 28.0) * 0.55 + vnoise2(p * 61.0 + 7.0) * 0.45;
        st = mix(st, 0.6, fade);
        float hmax = smoothstep(0.02, 0.45, vMoss) * (0.42 + 0.22 * cushion + 0.2 * sub + 0.16 * mid) * (0.5 + 0.6 * st);
        // 縁ではまばらに
        float edgeCut = smoothstep(0.02, 0.12, hmax + (st - 0.5) * 0.08);
        if (vShell > hmax + 0.001 || edgeCut < 0.5) discard;
        mossRel = clamp(vShell / max(hmax, 1e-3), 0.0, 1.0) * smoothstep(0.03, 0.2, hmax);
        // 種類の違う苔のパッチ（大きなスケールでゆるやかに変化）
        float region = vnoise2(p * 0.22 + 4.0);
        vec3 tipA = vec3(0.055, 0.105, 0.012);   // ハイゴケ（深い緑）
        vec3 tipB = vec3(0.12, 0.15, 0.02);      // 黄緑
        vec3 tipC = vec3(0.085, 0.12, 0.07);     // 白っぽい青緑（ホソバオキナゴケ）
        vec3 tip = mix(tipA, tipB, smoothstep(0.35, 0.75, region));
        tip = mix(tip, tipC, smoothstep(0.78, 0.95, vnoise2(p * 0.3 + 17.0)) * 0.6);
        tip *= 0.8 + 0.4 * mid;
        vec3 base = vec3(0.006, 0.011, 0.003);
        vec3 c = mix(base, tip, pow(mossRel, 1.4));
        c *= 0.75 + 0.35 * vnoise2(p * 2.2 + 5.0);
        // 枯れた茶色の部分
        float dead = smoothstep(0.62, 0.8, vnoise2(p * 0.7 + 21.0)) * 0.6;
        c = mix(c, vec3(0.13, 0.09, 0.04) * (0.4 + 0.6 * mossRel), dead * 0.7);
        diffuseColor.rgb = c;
        mH = st * 0.05 * (1.0 - fade) + mid * 0.04;
      }`],
      ['#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
      {
        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
        float dhx = dFdx(mH), dhy = dFdy(mH);
        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
        float det = dot(dpdx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        normal = normalize(abs(det) * normal - grad);
      }`],
      ['#include <aomap_fragment>', `#include <aomap_fragment>
      {
        float ao = mix(0.12, 1.0, pow(mossRel, 0.8));
        reflectedLight.indirectDiffuse *= ao;
        reflectedLight.indirectSpecular *= ao * 0.5;
        reflectedLight.directDiffuse *= mix(0.25, 1.0, mossRel);
        reflectedLight.directSpecular *= mossRel * 0.4;
      }`],
    ],
  });
  return m;
}

// ---- スギゴケ（星形の芽をインスタンス描画） ----
function sugiShootGeometry(rng) {
  const pos = [], nrm = [], col = [], idx = [];
  const H = 1.0;
  // 茎
  const seg = 6, rad = 0.022;
  const base = pos.length / 3;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * H;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, y, Math.sin(a) * rad);
      nrm.push(Math.cos(a), 0, Math.sin(a));
      col.push(0.12, 0.07, 0.03);
    }
  }
  for (let i = 0; i < 4; i++) for (let k = 0; k < seg; k++) {
    const a = base + i * seg + k, b = base + i * seg + ((k + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, c, b, b, c, d);
  }
  // 葉（らせん状に放射）
  const nLeaves = 26;
  for (let l = 0; l < nLeaves; l++) {
    const t = 0.25 + 0.75 * (l / nLeaves);
    const y = t * H;
    const az = l * 2.39996;
    const len = 0.32 + 0.16 * Math.sin(t * Math.PI);
    const up = 0.55 + 0.9 * t; // 上ほど立つ
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(up * 0.6), Math.sin(0.35 + t * 0.9), Math.sin(az) * Math.cos(up * 0.6)).normalize();
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    const n = new THREE.Vector3().crossVectors(side, dir).normalize();
    const w = 0.035;
    const b0 = pos.length / 3;
    const segs = 3;
    for (let s = 0; s <= segs; s++) {
      const u = s / segs;
      const p = new THREE.Vector3(0, y, 0).addScaledVector(dir, len * u);
      p.y -= u * u * len * 0.25; // 先端がわずかに垂れる
      const ww = w * (1 - u) * (s === segs ? 0 : 1);
      const g = 0.6 + 0.4 * u;
      pos.push(p.x + side.x * ww, p.y, p.z + side.z * ww, p.x - side.x * ww, p.y, p.z - side.z * ww);
      nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
      col.push(0.03 * g, 0.085 * g, 0.018 * g, 0.03 * g, 0.085 * g, 0.018 * g);
    }
    for (let s = 0; s < segs; s++) {
      const a = b0 + s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export function buildSugigoke(scene) {
  const rng = new RNG(808);
  const geo = sugiShootGeometry(rng);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  const clumps = [
    { x: -16.3, z: 7.6, r: 2.3, n: 230 },
    { x: -2.2, z: -4.6, r: 1.7, n: 140 },
    { x: -9.5, z: -3.2, r: 1.5, n: 110 },
    { x: 4.6, z: -5.2, r: 1.3, n: 80 },
  ];
  const total = clumps.reduce((a, c) => a + c.n, 0);
  const im = new THREE.InstancedMesh(geo, mat, total);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const col = new THREE.Color();
  let k = 0;
  for (const c of clumps) {
    for (let i = 0; i < c.n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = c.r * Math.sqrt(rng.next());
      const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
      const edge = rr / c.r;
      const h = heightAt(x, z);
      const sc = (1.1 + rng.range(-0.2, 0.35)) * (1 - edge * 0.45);
      e.set(rng.range(-0.18, 0.18) + (z - c.z) * 0.06, rng.range(0, 6.28), rng.range(-0.18, 0.18) - (x - c.x) * 0.06);
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, h - 0.05, z), q, new THREE.Vector3(sc * 1.1, sc * 1.35, sc * 1.1));
      im.setMatrixAt(k, m4);
      const v = 0.8 + rng.next() * 0.45;
      col.setRGB(v, v * (0.95 + rng.next() * 0.15), v * 0.9);
      im.setColorAt(k, col);
      k++;
    }
  }
  im.instanceMatrix.needsUpdate = true;
  im.instanceColor.needsUpdate = true;
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  worldPosPatch(mat);
  scene.add(im);
  return { mesh: im };
}
