import * as THREE from 'three';
import { addPatch, worldPosPatch, waterFxPatch, LAYER_NAV, WATER_LEVEL } from '../core/shared.js';
import { RNG, clamp, lerp } from '../core/rng.js';
import { Noise } from '../core/noise.js';
import { heightAt, mossAt, terrainAt, ROCKS } from './layout.js';

// ---- 落ち葉のテクスチャ（2x2 アトラス） ----
function leafAtlas() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S * 2;
  const g = cv.getContext('2d');
  const rng = new RNG(333);
  const types = [
    { kind: 'oak', base: ['#6b4424', '#8a5a2e', '#4a2e18'] },
    { kind: 'zelkova', base: ['#9a5a26', '#b87332', '#6a3a18'] },
    { kind: 'maple', base: ['#8a2e16', '#a8441e', '#5a1e10'] },
    { kind: 'old', base: ['#3e2a1a', '#54391f', '#2a1a10'] },
  ];
  types.forEach((ty, idx) => {
    const ox = (idx % 2) * S, oy = Math.floor(idx / 2) * S;
    g.save();
    g.translate(ox + S / 2, oy + S / 2);
    // 輪郭
    const path = new Path2D();
    const N = 160;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      let r;
      const t = Math.cos(a); // -1: 葉先側
      if (ty.kind === 'maple') {
        const lobes = 5;
        const k = Math.abs(Math.sin((a + Math.PI / 2) * lobes / 2));
        r = S * (0.2 + 0.25 * Math.pow(k, 2.5)) * (1 - 0.1 * Math.max(0, t));
      } else {
        const w = ty.kind === 'zelkova' ? 0.24 : 0.3;
        const len = 0.46;
        const x = Math.cos(a), y = Math.sin(a);
        const base = 1 / Math.sqrt((x * x) / (len * len) + (y * y) / (w * w * (1 - 0.35 * x) ** 2));
        let edge = 0;
        if (ty.kind === 'oak') edge = 0.06 * Math.abs(Math.sin(a * 7));
        else edge = 0.012 * Math.abs(Math.sin(a * 38));
        r = S * (base * (1 - edge));
      }
      const px = Math.cos(a) * r, py = Math.sin(a) * r;
      if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
    }
    path.closePath();
    g.clip(path);
    // 地色
    const grad = g.createLinearGradient(-S / 2, 0, S / 2, 0);
    grad.addColorStop(0, ty.base[1]);
    grad.addColorStop(0.5, ty.base[0]);
    grad.addColorStop(1, ty.base[2]);
    g.fillStyle = grad;
    g.fillRect(-S / 2, -S / 2, S, S);
    // まだら
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(${rng.int(20, 60)},${rng.int(10, 30)},${rng.int(0, 15)},${rng.range(0.05, 0.25)})`;
      g.beginPath();
      g.arc(rng.range(-S / 2, S / 2), rng.range(-S / 2, S / 2), rng.range(4, 40), 0, Math.PI * 2);
      g.fill();
    }
    // 葉脈
    g.strokeStyle = 'rgba(225,190,140,0.55)';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(-S * 0.46, 0); g.lineTo(S * 0.46, 0); g.stroke();
    g.lineWidth = 2;
    for (let i = -7; i <= 7; i++) {
      if (!i) continue;
      const x0 = (i / 8) * S * 0.42;
      for (const sgn of [-1, 1]) {
        g.beginPath();
        g.moveTo(x0, 0);
        g.quadraticCurveTo(x0 - S * 0.06, sgn * S * 0.1, x0 - S * 0.1, sgn * S * 0.26);
        g.stroke();
      }
    }
    // 虫食いの穴
    g.globalCompositeOperation = 'destination-out';
    const holes = ty.kind === 'old' ? 14 : rng.int(0, 4);
    for (let i = 0; i < holes; i++) {
      g.beginPath();
      g.ellipse(rng.range(-S * 0.35, S * 0.35), rng.range(-S * 0.18, S * 0.18), rng.range(6, 26), rng.range(5, 18), rng.range(0, 3), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // 葉柄
    g.save();
    g.translate(ox + S / 2, oy + S / 2);
    g.strokeStyle = ty.base[2];
    g.lineWidth = 7;
    g.beginPath(); g.moveTo(S * 0.44, 0); g.lineTo(S * 0.5, 4); g.stroke();
    g.restore();
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function leafGeometry(rng, cell) {
  const nx = 10, ny = 5;
  const pos = [], uv = [], idx = [];
  const curl = rng.range(0.15, 0.55);
  const tipCurl = rng.range(-0.35, 0.45);
  const u0 = (cell % 2) * 0.5, v0 = Math.floor(cell / 2) * 0.5;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = i / nx - 0.5, z = j / ny - 0.5;
      let y = Math.abs(z) * Math.abs(z) * curl * 2.2;
      y += Math.pow(Math.max(0, -x - 0.1), 2) * tipCurl * 2 + Math.pow(Math.max(0, x - 0.2), 2) * 0.4;
      y += Math.sin(x * 9 + z * 5) * 0.012;
      pos.push(x, y, z);
      uv.push(u0 + (i / nx) * 0.5, 1 - (v0 + (1 - j / ny) * 0.5));
    }
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildLeafLitter(scene) {
  const tex = leafAtlas();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78 });
  waterFxPatch(mat, { wetHeight: 0.25, wetDarken: 0.45, wetGloss: 0.7 });
  const rng = new RNG(1717);
  const group = new THREE.Group();
  const spots = [
    [-8.5, 7.2, 2], [-13.5, 8.0, 0], [-6.0, 1.0, 1], [-15.0, -1.2, 3], [-3.2, 5.8, 1], [-10.2, -4.4, 0],
    [0.8, -3.4, 2], [-18.0, 6.0, 1], [-5.0, 9.8, 3], [5.6, -3.4, 1], [-12.8, 1.2, 2],
    // 水中
    [9.5, 5.0, 3], [14.2, 6.0, 0], [6.4, 9.6, 1],
  ];
  for (const [x, z, cell] of spots) {
    const g = leafGeometry(rng, cell);
    const m = new THREE.Mesh(g, mat);
    const size = rng.range(2.4, 3.8);
    m.scale.set(size, size, size * (cell === 2 ? 1 : 0.62));
    const inWater = heightAt(x, z) < WATER_LEVEL - 0.2;
    const lift = inWater ? 0.05 : 0.08 + mossAt(x, z) * 0.35;
    m.position.set(x, heightAt(x, z) + lift, z);
    m.rotation.set(rng.range(-0.12, 0.12), rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  scene.add(group);
  return group;
}

// ---- 流木 ----
export function buildDriftwood(scene) {
  const nz = new Noise(77);
  const main = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-4.2, 0, 3.4), new THREE.Vector3(-1.2, 0, 1.4), new THREE.Vector3(2.0, 0, -0.2), new THREE.Vector3(4.6, 0, -1.3),
  ]);
  const branch = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.6, 0, 0.5), new THREE.Vector3(1.5, 0, 2.3), new THREE.Vector3(1.3, 0, 4.0),
  ]);
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  worldPosPatch(mat);
  addPatch(mat, {
    key: 'wood',
    vertexHead: 'varying vec2 vWUv;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvWUv = uv;']],
    fragmentHead: 'varying vec2 vWUv;',
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      float wH = 0.0;
      {
        vec2 q = vec2(vWUv.x * 90.0, vWUv.y * 6.28 * 3.0);
        float grain = vnoise2(vec2(q.x * 0.35, q.y * 3.0)) * 0.6 + vnoise2(vec2(q.x * 0.9, q.y * 9.0)) * 0.4;
        float crack = smoothstep(0.9, 0.97, vnoise2(vec2(q.x * 0.2, q.y * 1.6)));
        diffuseColor.rgb *= 0.75 + 0.45 * grain;
        diffuseColor.rgb *= 1.0 - crack * 0.7;
        wH = grain * 0.02 - crack * 0.04;
      }`],
      ['#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
        float dhx = dFdx(wH), dhy = dFdy(wH);
        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
        float det = dot(dpdx, r1);
        normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2));
      }`]],
  });
  waterFxPatch(mat, { wetHeight: 0.6, wetDarken: 0.4, wetGloss: 0.7 });
  const make = (curve, r0, r1, seg, liftFn) => {
    // 地形に沿わせる
    const pts = curve.getPoints(40).map((p) => new THREE.Vector3(p.x, heightAt(p.x, p.z) + liftFn(p), p.z));
    const c2 = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(c2, seg, 1, 14, false);
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const col = new Float32Array(pos.count * 3);
    const cA = new THREE.Color(0.2, 0.15, 0.11), cB = new THREE.Color(0.34, 0.29, 0.23);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = uv.getX(i);
      const center = c2.getPointAt(Math.min(t, 1));
      const n = new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      const r = lerp(r0, r1, t) * (1 + 0.18 * nz.noise2(t * 9, uv.getY(i) * 3)) * (t < 0.02 || t > 0.98 ? 0.7 : 1);
      const p = center.clone().addScaledVector(n, r);
      pos.setXYZ(i, p.x, p.y, p.z);
      tmp.copy(cA).lerp(cB, 0.5 + 0.5 * n.y + 0.2 * nz.noise2(t * 5, 3));
      col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.layers.enable(LAYER_NAV);
    group.add(m);
    return m;
  };
  make(main, 0.6, 0.32, 90, (p) => 0.28 + Math.max(0, -p.x - 2) * 0.1);
  make(branch, 0.3, 0.14, 40, (p) => 0.42 + Math.max(0, p.z - 2) * 0.12);
  scene.add(group);
  return group;
}
