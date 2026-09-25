import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { addPatch, worldPosPatch, waterFxPatch, LAYER_NAV, LAYER_CEIL, TANK } from '../core/shared.js';
import { Noise } from '../core/noise.js';
import { RNG, clamp, smoothstep } from '../core/rng.js';
import { ROCKS, heightAt } from './layout.js';

const _v = new THREE.Vector3();

function makeRockGeometry(def) {
  const rng = new RNG(def.seed * 7919 + 13);
  const nz = new Noise(def.seed * 31 + 7);
  // IcosahedronGeometry の detail は辺の分割数（三角形数 = 20 × (detail+1)^2）
  const detail = def.type === 'seiryu' ? (def.sy > 7 ? 44 : 30) : def.type === 'slab' ? 32 : 22;
  let geo = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo);
  const pos = geo.attributes.position;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const ao = new Float32Array(n);

  // 平面カット（割れ面）
  const planes = [];
  if (def.type === 'seiryu') {
    const k = 7 + rng.int(0, 4);
    for (let i = 0; i < k; i++) {
      const th = rng.range(0, Math.PI * 2);
      const ph = Math.acos(rng.range(-0.5, 0.95));
      const nn = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
      planes.push({ n: nn, c: rng.range(0.55, 0.85) });
    }
    planes.push({ n: new THREE.Vector3(0, -1, 0), c: 0.45 });
  } else if (def.type === 'river') {
    planes.push({ n: new THREE.Vector3(0, -1, 0), c: 0.55 });
  }

  // 色（線形）
  let baseA, baseB;
  if (def.type === 'seiryu') {
    baseA = new THREE.Color(0.04, 0.044, 0.047);
    baseB = new THREE.Color(0.15, 0.152, 0.148);
  } else if (def.type === 'slab') {
    baseA = new THREE.Color(0.045, 0.043, 0.04);
    baseB = new THREE.Color(0.13, 0.125, 0.115);
  } else {
    const k = rng.next();
    if (k < 0.4) { baseA = new THREE.Color(0.1, 0.095, 0.09); baseB = new THREE.Color(0.3, 0.28, 0.25); }
    else if (k < 0.7) { baseA = new THREE.Color(0.05, 0.05, 0.05); baseB = new THREE.Color(0.16, 0.155, 0.15); }
    else { baseA = new THREE.Color(0.12, 0.085, 0.06); baseB = new THREE.Color(0.3, 0.22, 0.16); }
  }

  const tmpC = new THREE.Color();
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pos, i).normalize();
    const dir = _v.clone();
    let p = _v.clone();
    // 形の揺らぎ
    const lowF = nz.fbm3(dir.x * 1.1, dir.y * 1.1, dir.z * 1.1, 3);
    p.multiplyScalar(1 + lowF * (def.type === 'river' ? 0.12 : 0.18));
    for (const pl of planes) {
      const d = p.dot(pl.n) - pl.c;
      if (d > 0) p.addScaledVector(pl.n, -d * (def.type === 'seiryu' ? 0.94 : 0.7));
    }
    let cav = 0;
    if (def.type === 'seiryu') {
      // 縦に流れる溝（青龍石の風化）
      const r = nz.ridged3(dir.x * 1.5, dir.y * 0.5 + 3.1, dir.z * 1.5, 3);
      const disp = (r - 0.6) * 0.17;
      const fine = nz.fbm3(dir.x * 5, dir.y * 2.5, dir.z * 5, 2) * 0.01;
      p.addScaledVector(dir, disp + fine);
      cav = clamp(-(disp + fine) * 7, -1, 1);
    } else if (def.type === 'slab') {
      p.y *= 0.55;
      p.addScaledVector(dir, nz.fbm3(dir.x * 3, dir.y * 3, dir.z * 3, 3) * 0.05);
      // 裏面は平らに（支え石に載る面）。上面もやや平たく
      if (p.y < -0.3) p.y = -0.3 + (p.y + 0.3) * 0.06;
      if (p.y > 0.3) p.y = 0.3 + (p.y - 0.3) * 0.5;
    } else {
      p.addScaledVector(dir, nz.fbm3(dir.x * 3.5, dir.y * 3.5, dir.z * 3.5, 3) * 0.02);
    }
    p.x *= def.sx / 2; p.y *= def.sy / 2; p.z *= def.sz / 2;
    pos.setXYZ(i, p.x, p.y, p.z);

    const t = clamp(0.5 + nz.fbm3(dir.x * 2.5 + 9, dir.y * 2.5, dir.z * 2.5, 4) * 0.9, 0, 1);
    tmpC.copy(baseA).lerp(baseB, t);
    if (def.type === 'seiryu') {
      // 稜線は白っぽく風化、溝は暗い
      tmpC.multiplyScalar(1 - cav * 0.45);
      const up = clamp(dir.y, 0, 1);
      tmpC.lerp(new THREE.Color(0.19, 0.19, 0.18), up * 0.2 * (1 - Math.max(cav, 0)));
    }
    col[i * 3] = tmpC.r; col[i * 3 + 1] = tmpC.g; col[i * 3 + 2] = tmpC.b;
    ao[i] = clamp(1 - Math.max(cav, 0) * 0.75, 0.2, 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  geo.computeVertexNormals();
  return geo;
}

function rockMaterial(kind) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: kind === 'river' ? 0.5 : 0.78,
    metalness: 0,
  });
  worldPosPatch(m);
  addPatch(m, {
    key: 'rock-' + kind,
    vertexHead: 'attribute float aAO; varying float vAO; varying vec3 vObjPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvAO = aAO; vObjPos = position;']],
    fragmentHead: `varying float vAO; varying vec3 vObjPos;\n#define ROCK_${kind.toUpperCase()}`,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `#include <color_fragment>
      float rH = 0.0;
      {
        vec3 p = vWPos;
        float fw = length(fwidth(p));
        float fade = smoothstep(0.006, 0.03, fw);
        float n1 = snoise(p * 1.7);
        float n2 = snoise(p * 6.5 + 3.0);
        float n3 = mix(vnoise3(p * 26.0), 0.5, fade);
        vec3 c = diffuseColor.rgb;
        c *= 0.82 + 0.25 * n1 + 0.12 * n2;
        #ifdef ROCK_SEIRYU
          // 方解石の白い筋（一方向に伸びた割れ目）
          vec3 wq = vec3(dot(p, vec3(0.8, 0.3, 0.5)) * 0.5, dot(p, vec3(-0.3, 0.9, 0.2)) * 0.07, dot(p, vec3(0.5, -0.2, -0.8)) * 0.07);
          wq += vec3(snoise(p * 0.6) * 0.12, 0.0, 0.0);
          float vein = abs(snoise(wq));
          float vw = mix(0.02, 0.05, fade);
          float v = (1.0 - smoothstep(vw * 0.3, vw, vein)) * smoothstep(0.2, 0.5, snoise(p * 0.21 + 5.0) * 0.5 + 0.5);
          c = mix(c, vec3(0.36, 0.37, 0.36), v * 0.7);
          // 小さな窪み（風化孔）
          float pn = vnoise3(p * 5.5);
          float pit = smoothstep(0.78, 0.9, pn) * (1.0 - fade);
          c *= 1.0 - pit * 0.4;
          rH = n2 * 0.035 * (1.0 - fade * 0.6) + n3 * 0.008 * (1.0 - fade) - pit * 0.06 + v * 0.01;
          // 上面の地衣類
          float lich = smoothstep(0.55, 0.9, vWNrm.y) * smoothstep(0.35, 0.6, snoise(p * 0.9 + 40.0));
          c = mix(c, vec3(0.12, 0.13, 0.08), lich * 0.5);
        #elif defined(ROCK_RIVER)
          // 花崗岩の斑点
          float sp = hash13(floor(p * 38.0));
          c = mix(c, c * 0.35, step(0.86, sp) * (1.0 - fade));
          c = mix(c, c * 1.5 + 0.03, step(0.95, sp) * (1.0 - fade));
          rH = n2 * 0.012 + n3 * 0.004 * (1.0 - fade);
        #else
          float sp = vnoise3(p * 12.0);
          c *= 0.9 + 0.2 * sp;
          rH = n2 * 0.03 + n3 * 0.02;
        #endif
        diffuseColor.rgb = c;
      }`],
      ['#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
      {
        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
        float dhx = dFdx(rH), dhy = dFdy(rH);
        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
        float det = dot(dpdx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        normal = safeNormalize(abs(det) * normal - grad, normal);
      }`],
      ['#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= vAO;
      reflectedLight.indirectSpecular *= vAO;
      reflectedLight.directDiffuse *= mix(1.0, vAO, 0.5);`],
    ],
  });
  waterFxPatch(m, { wetHeight: 0.7, wetDarken: kind === 'river' ? 0.35 : 0.45, wetGloss: 0.9 });
  return m;
}

export function buildRocks(scene) {
  const mats = {
    seiryu: rockMaterial('seiryu'),
    river: rockMaterial('river'),
    slab: rockMaterial('slab'),
  };
  const rocks = [];
  // シェルター（平石）の裏面の高さを先に決める: 足元の地面の最高点 + カニが通れる隙間
  const shelterUnder = {};
  for (const def of ROCKS) {
    if (def.type !== 'slab' || !def.clearance) continue;
    const c = Math.cos(def.rotY || 0), s = Math.sin(def.rotY || 0);
    let gmax = -Infinity;
    for (let i = -4; i <= 4; i++) {
      for (let j = -3; j <= 3; j++) {
        const lx = (i / 4) * def.sx * 0.4, lz = (j / 3) * def.sz * 0.38;
        gmax = Math.max(gmax, heightAt(def.x + lx * c + lz * s, def.z - lx * s + lz * c));
      }
    }
    shelterUnder[def.id] = gmax + def.clearance;
  }
  const extentY = (geo, m4) => {
    let lo = Infinity, hi = -Infinity;
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m4);
      if (_v.y < lo) lo = _v.y;
      if (_v.y > hi) hi = _v.y;
    }
    return [lo, hi];
  };
  for (const def of ROCKS) {
    const geo = makeRockGeometry(def);
    const mesh = new THREE.Mesh(geo, mats[def.type]);
    mesh.rotation.set(def.tiltX || 0, def.rotY || 0, def.tiltZ || 0, 'YXZ');
    // 足元の地形の最低点に合わせて沈める
    let minH = Infinity;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      minH = Math.min(minH, heightAt(def.x + Math.cos(ang) * def.sx * 0.35, def.z + Math.sin(ang) * def.sz * 0.35));
    }
    minH = Math.min(minH, heightAt(def.x, def.z));
    mesh.position.set(def.x, 0, def.z);
    mesh.updateMatrixWorld(true);
    geo.computeBoundingBox();
    // 回転後の最下点
    let lowest = Infinity;
    const p = geo.attributes.position;
    const m4 = new THREE.Matrix4().makeRotationFromEuler(mesh.rotation);
    for (let i = 0; i < p.count; i += 7) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m4);
      lowest = Math.min(lowest, _v.y);
    }
    if (def.type === 'slab' && shelterUnder[def.id] !== undefined) {
      // 平らな裏面を決めた高さに水平に置く
      mesh.position.y = shelterUnder[def.id] - extentY(geo, m4)[0];
    } else if (def.supportFor && shelterUnder[def.supportFor] !== undefined) {
      // 支え石: 頂上がちょうど平石の裏面に届く（わずかにめり込む）高さに伸縮させる
      const [lo, hi] = extentY(geo, m4);
      const base = minH - def.sink;
      const top = shelterUnder[def.supportFor] + 0.1;
      const k = clamp((top - base) / (hi - lo), 0.6, 2.6);
      geo.scale(1, k, 1);
      geo.computeVertexNormals();
      mesh.position.y = base - extentY(geo, m4)[0];
    } else if (def.type === 'slab') {
      mesh.position.y = minH + (def.lift || 0) - lowest;
    } else {
      mesh.position.y = minH - lowest - def.sink;
    }
    // ガラスを突き抜けないよう内側へずらす（ガラスに触れるのはかまわない）
    {
      mesh.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(mesh, true);
      const mg = 0.05;
      mesh.position.x += Math.max(0, TANK.ix0 + mg - bb.min.x) - Math.max(0, bb.max.x - (TANK.ix1 - mg));
      mesh.position.z += Math.max(0, TANK.iz0 + mg - bb.min.z) - Math.max(0, bb.max.z - (TANK.iz1 - mg));
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.def = def;
    mesh.updateMatrixWorld(true);
    // 地面との接触による AO
    const aoAttr = geo.attributes.aAO;
    const wm = mesh.matrixWorld;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(wm);
      const g = heightAt(_v.x, _v.z);
      const dy = _v.y - g;
      aoAttr.setX(i, aoAttr.getX(i) * (0.35 + 0.65 * smoothstep(-0.2, 1.6, dy)));
    }
    aoAttr.needsUpdate = true;

    if (def.ceiling) mesh.layers.enable(LAYER_CEIL);
    else mesh.layers.enable(LAYER_NAV);
    scene.add(mesh);
    rocks.push(mesh);
  }
  return { rocks, materials: mats };
}
