import * as THREE from 'three';
import { addPatch, worldPosPatch, waterFxPatch, shared, TANK } from '../core/shared.js';
import { RNG, clamp, lerp } from '../core/rng.js';
import { heightAt } from './layout.js';

// 頂点を貯めるビルダー
class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.i = []; this.w = []; }
  get count() { return this.p.length / 3; }
  v(p, n, c, sway = 0) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.c.push(c.r, c.g, c.b); this.w.push(sway);
    return this.count - 1;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.w, 1));
    g.setIndex(this.i);
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function plantMaterial({ roughness = 0.55, gloss = 0 } = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, side: THREE.DoubleSide, metalness: 0 });
  worldPosPatch(m);
  addPatch(m, {
    key: 'plant-sway',
    uniforms: { uTime: shared.uTime },
    vertexHead: 'attribute float aSway; uniform float uTime;',
    vertex: [['#include <begin_vertex>', `#include <begin_vertex>
      {
        vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
        float ph = wp0.x * 0.35 + wp0.z * 0.27;
        vec2 sw = vec2(sin(uTime * 0.8 + ph), cos(uTime * 0.63 + ph * 1.3)) * 0.05 + vec2(sin(uTime * 2.3 + ph * 3.0)) * 0.012;
        transformed.xz += sw * aSway;
      }`]],
    fragment: [['#include <aomap_fragment>', `#include <aomap_fragment>
      // 葉の裏から透ける光（簡易）
      reflectedLight.indirectDiffuse += diffuseColor.rgb * 0.06 * (1.0 - abs(normal.y));`]],
  });
  waterFxPatch(m, { wetHeight: 0.3, wetDarken: 0.2, wetGloss: 0.4 });
  return m;
}

// ---- 水槽の内側に収める ----
// ガラスの内面から少し離す（揺れのアニメーション分の余白を含む）
const GLASS_MARGIN = 0.25;
const BOUNDS = {
  x0: TANK.ix0 + GLASS_MARGIN, x1: TANK.ix1 - GLASS_MARGIN,
  z0: TANK.iz0 + GLASS_MARGIN, z1: TANK.iz1 - GLASS_MARGIN,
  y1: TANK.h - 1.0,
};
function outside(x, y, z) {
  return Math.max(0, BOUNDS.x0 - x, x - BOUNDS.x1, BOUNDS.z0 - z, z - BOUNDS.z1, y - BOUNDS.y1);
}
// 最後の保険: 残ったはみ出しはガラスに押しつけられた形に収める
function containVertices(b) {
  const p = b.p;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = clamp(p[i], BOUNDS.x0, BOUNDS.x1);
    p[i + 1] = Math.min(p[i + 1], BOUNDS.y1);
    p[i + 2] = clamp(p[i + 2], BOUNDS.z0, BOUNDS.z1);
  }
}
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ---- シダ（羽状複葉） ----
function rachis(base, azim, opt, segs = 22) {
  const dirH = new THREE.Vector3(Math.sin(azim), 0, Math.cos(azim));
  const pts = [], tans = [];
  const p = base.clone();
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const th = opt.elev - opt.droop * Math.pow(t, 1.4);
    const d = dirH.clone().applyAxisAngle(UP, opt.curl * t).multiplyScalar(Math.cos(th)).addScaledVector(UP, Math.sin(th));
    pts.push(p.clone());
    tans.push(d.clone().normalize());
    p.addScaledVector(d, opt.length / segs);
  }
  return { pts, tans };
}
const pinnaShape = (t) => Math.pow(Math.sin(Math.PI * (0.1 + 0.9 * t)), 0.7) * (1 - 0.55 * t) * Math.min(1, t * 6);

// 葉軸と羽片の先端がどれだけ水槽の外へ出るか
function frondOverflow(base, azim, opt) {
  const { pts, tans } = rachis(base, azim, opt);
  const segs = pts.length - 1;
  const sd = new THREE.Vector3(), tip = new THREE.Vector3();
  let v = 0;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs, p = pts[s];
    v = Math.max(v, outside(p.x, p.y, p.z));
    const len = opt.pinnaLen * pinnaShape(t) * 1.1;
    if (len < 0.15) continue;
    sd.crossVectors(tans[s], UP);
    if (sd.lengthSq() < 1e-8) continue;
    sd.normalize();
    const fwd = opt.pinnaAngle * (1 + 0.3 * t);
    for (const sg of [1, -1]) {
      tip.copy(p).addScaledVector(sd, sg * Math.cos(fwd) * len).addScaledVector(tans[s], Math.sin(fwd) * len);
      v = Math.max(v, outside(tip.x, tip.y, tip.z));
    }
  }
  return v;
}

function addFrond(b, rng, base, azim, opt) {
  const segs = 22;
  const { pts, tans } = rachis(base, azim, opt, segs);
  const at = (t) => {
    const f = t * segs;
    const i = Math.min(Math.floor(f), segs - 1);
    const u = f - i;
    return { p: pts[i].clone().lerp(pts[i + 1], u), t: tans[i].clone().lerp(tans[i + 1], u).normalize() };
  };
  // 葉軸（細い管）
  const rCol = new THREE.Color(0.06, 0.07, 0.025);
  const ring = 4;
  let prev = null;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const { p: pp, t: tt } = at(Math.min(t, 0.999));
    const sd = new THREE.Vector3().crossVectors(tt, UP).normalize();
    const nn = new THREE.Vector3().crossVectors(sd, tt).normalize();
    const r = lerp(0.045, 0.012, t) * opt.scale;
    const idx = [];
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      const off = sd.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(nn, Math.sin(a) * r);
      idx.push(b.v(pp.clone().add(off), off.clone().normalize(), rCol, t * t));
    }
    if (prev) for (let k = 0; k < ring; k++) { const k2 = (k + 1) % ring; b.tri(prev[k], idx[k], prev[k2]); b.tri(prev[k2], idx[k], idx[k2]); }
    prev = idx;
  }
  // 羽片
  const N = opt.pinnae;
  const young = rng.next() < 0.25;
  const baseCol = young ? new THREE.Color(0.12, 0.24, 0.035) : new THREE.Color(0.045, 0.12, 0.025);
  for (let k = 0; k < N; k++) {
    for (const sideSign of [1, -1]) {
      const t = 0.1 + 0.88 * ((k + (sideSign > 0 ? 0 : 0.5)) / N);
      if (t > 0.985) continue;
      const len = opt.pinnaLen * pinnaShape(t) * rng.range(0.9, 1.08);
      if (len < 0.15) continue;
      const { p: rp, t: rt } = at(t);
      const sd = new THREE.Vector3().crossVectors(rt, UP).normalize().multiplyScalar(sideSign);
      const fwd = opt.pinnaAngle * (1 + 0.3 * t);
      const pdir = sd.clone().multiplyScalar(Math.cos(fwd)).addScaledVector(rt, Math.sin(fwd)).normalize();
      const blades = 12;
      const colT = baseCol.clone().multiplyScalar(rng.range(0.85, 1.15));
      let prevRow = null;
      let pp = rp.clone();
      for (let s = 0; s <= blades; s++) {
        const u = s / blades;
        // 羽片の中肋（先端ほど垂れる）
        const dd = pdir.clone();
        dd.y -= u * 0.5 * opt.pinnaDroop;
        dd.normalize();
        if (s > 0) pp.addScaledVector(dd, len / blades);
        const lobe = 0.72 + 0.28 * Math.abs(Math.sin(u * Math.PI * opt.lobes));
        const w = opt.pinnaW * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.75)), 0.7) * lobe * (s === blades ? 0 : 1);
        const across = new THREE.Vector3().crossVectors(dd, UP).normalize();
        const nrm = new THREE.Vector3().crossVectors(across, dd).normalize();
        if (nrm.y < 0) nrm.negate();
        const mid = pp.clone().addScaledVector(nrm, 0.02 * (1 - u));
        const eL = pp.clone().addScaledVector(across, w).addScaledVector(nrm, -0.03 * w);
        const eR = pp.clone().addScaledVector(across, -w).addScaledVector(nrm, -0.03 * w);
        const cMid = colT.clone().multiplyScalar(0.8);
        const cEdge = colT.clone().multiplyScalar(1.05 + 0.15 * u);
        const sway = t * t * 0.8 + u * 0.3;
        const row = [b.v(eL, nrm.clone().addScaledVector(across, 0.3).normalize(), cEdge, sway), b.v(mid, nrm, cMid, sway), b.v(eR, nrm.clone().addScaledVector(across, -0.3).normalize(), cEdge, sway)];
        if (prevRow) {
          b.tri(prevRow[0], row[0], prevRow[1]); b.tri(prevRow[1], row[0], row[1]);
          b.tri(prevRow[1], row[1], prevRow[2]); b.tri(prevRow[2], row[1], row[2]);
        }
        prevRow = row;
      }
    }
  }
}

export function buildFerns(scene) {
  const b = new Builder();
  const rng = new RNG(9090);
  const plants = [
    { x: -17.2, z: -9.0, fronds: 11, length: [8, 12], scale: 1.1 },
    { x: 3.8, z: -10.0, fronds: 9, length: [6.5, 9.5], scale: 1.0 },
    { x: -17.0, z: 2.6, fronds: 7, length: [5, 7.5], scale: 0.85 },
    { x: 18.2, z: -10.2, fronds: 7, length: [5.5, 8], scale: 0.9 },
  ];
  for (const pl of plants) {
    const y = heightAt(pl.x, pl.z) - 0.1;
    // 水槽の中央（やや手前）へ向かう方位
    const toCenter = Math.atan2(-pl.x, 2 - pl.z);
    for (let f = 0; f < pl.fronds; f++) {
      let az = (f / pl.fronds) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const L = rng.range(pl.length[0], pl.length[1]);
      const opt = {
        length: L, elev: rng.range(1.05, 1.35), droop: rng.range(1.2, 1.9), curl: rng.range(-0.25, 0.25),
        pinnaLen: L * 0.2 * pl.scale, pinnaW: 0.2 * pl.scale, pinnaAngle: rng.range(0.55, 0.8), pinnaDroop: 0.6, lobes: 5, scale: pl.scale,
      };
      const base = new THREE.Vector3(pl.x + Math.sin(az) * 0.2, y, pl.z + Math.cos(az) * 0.2);
      // ガラスを突き抜ける葉は、内側へ向けて少し短く・立たせる（壁ぎわの植物が空いている方へ伸びるように）
      for (let tries = 0; tries < 14 && frondOverflow(base, az, opt) > 0; tries++) {
        az += angDiff(toCenter, az) * 0.2;
        opt.length *= 0.94;
        opt.pinnaLen *= 0.94;
        opt.elev = Math.min(opt.elev + 0.05, 1.45);
      }
      opt.pinnae = Math.round(opt.length * 2.4);
      addFrond(b, rng, base, az, opt);
    }
  }
  containVertices(b);
  const mesh = new THREE.Mesh(b.geometry(), plantMaterial({ roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'ferns';
  scene.add(mesh);
  return mesh;
}

// ---- セキショウ（扇状に広がる細い葉） ----
export function buildAcorus(scene) {
  const b = new Builder();
  const rng = new RNG(5151);
  const clumps = [
    { x: -0.9, z: 4.8, n: 13, L: [5, 8.5] },
    { x: 13.8, z: -5.3, n: 11, L: [5, 8] },
    { x: -1.6, z: 9.9, n: 9, L: [4, 6.5] },
    { x: 8.3, z: -6.6, n: 10, L: [4.5, 7.5] },
    { x: 18.4, z: 4.6, n: 8, L: [4, 6] },
  ];
  for (const cl of clumps) {
    const y = heightAt(cl.x, cl.z) - 0.15;
    let fanAz = rng.range(0, Math.PI);
    // 壁ぎわの株は扇を壁と平行に広げる（ガラスを突き抜けないように）
    const dx = Math.min(cl.x - TANK.ix0, TANK.ix1 - cl.x), dz = Math.min(cl.z - TANK.iz0, TANK.iz1 - cl.z);
    if (dx < 3.5) fanAz = Math.PI / 2 + (fanAz - Math.PI / 2) * 0.12;
    else if (dz < 3.5) fanAz = (fanAz - Math.PI / 2) * 0.12;
    for (let i = 0; i < cl.n; i++) {
      const f = (i / (cl.n - 1)) * 2 - 1;
      const az = fanAz + rng.range(-0.25, 0.25);
      const lean = f * 0.75 + rng.range(-0.1, 0.1);
      const L = rng.range(cl.L[0], cl.L[1]) * (1 - Math.abs(f) * 0.25);
      const W = rng.range(0.13, 0.18);
      const segs = 14;
      const fanDir = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
      const faceN = new THREE.Vector3().crossVectors(fanDir, UP).normalize();
      let p = new THREE.Vector3(cl.x + fanDir.x * f * 0.25, y, cl.z + fanDir.z * f * 0.25);
      let prevRow = null;
      const droop = rng.range(0.5, 1.1);
      for (let s = 0; s <= segs; s++) {
        const u = s / segs;
        const th = Math.PI / 2 - lean * (0.6 + u * 0.4) - droop * u * u * Math.sign(lean || 1) * 0.9;
        const dir = new THREE.Vector3(fanDir.x * Math.cos(th), Math.sin(th), fanDir.z * Math.cos(th)).normalize();
        if (s > 0) p = p.clone().addScaledVector(dir, L / segs);
        const across = faceN.clone().applyAxisAngle(dir, u * 0.6 * (i % 2 ? 1 : -1));
        const w = W * (1 - Math.pow(u, 2.2)) + 0.004;
        const nrm = new THREE.Vector3().crossVectors(across, dir).normalize();
        const base = new THREE.Color(0.1, 0.16, 0.06).lerp(new THREE.Color(0.03, 0.09, 0.02), Math.min(1, u * 3));
        const col = base.clone().lerp(new THREE.Color(0.06, 0.08, 0.02), Math.max(0, u - 0.85) * 4);
        const sway = u * u * 0.9;
        const row = [
          b.v(p.clone().addScaledVector(across, w), nrm, col, sway),
          b.v(p.clone().addScaledVector(nrm, 0.012), nrm, col.clone().multiplyScalar(1.15), sway),
          b.v(p.clone().addScaledVector(across, -w), nrm, col, sway),
        ];
        if (prevRow) {
          b.tri(prevRow[0], row[0], prevRow[1]); b.tri(prevRow[1], row[0], row[1]);
          b.tri(prevRow[1], row[1], prevRow[2]); b.tri(prevRow[2], row[1], row[2]);
        }
        prevRow = row;
      }
    }
  }
  containVertices(b);
  const mesh = new THREE.Mesh(b.geometry(), plantMaterial({ roughness: 0.32 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'acorus';
  scene.add(mesh);
  return mesh;
}
