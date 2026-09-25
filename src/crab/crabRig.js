import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { walkingLegSpec, chelaSpec } from './crabModel.js';
import { addPatch, worldPosPatch, waterFxPatch } from '../core/shared.js';
import { clamp, lerp } from '../core/rng.js';

const D2R = Math.PI / 180;
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();

// 体色（線形 RGB）
export const PALETTES = {
  brown: {
    label: '茶', carapace: [0.042, 0.018, 0.013], leg: [0.6, 0.15, 0.028], pale: [0.8, 0.5, 0.25],
    tip: [0.1, 0.045, 0.02], cornea: [0.01, 0.01, 0.012], margin: [0.34, 0.07, 0.02],
  },
  red: {
    label: '赤', carapace: [0.26, 0.03, 0.012], leg: [0.72, 0.12, 0.025], pale: [0.86, 0.5, 0.28],
    tip: [0.2, 0.05, 0.02], cornea: [0.01, 0.01, 0.012], margin: [0.5, 0.08, 0.02],
  },
  blue: {
    label: '青', carapace: [0.07, 0.09, 0.15], leg: [0.3, 0.36, 0.47], pale: [0.7, 0.72, 0.76],
    tip: [0.1, 0.1, 0.13], cornea: [0.01, 0.01, 0.012], margin: [0.18, 0.21, 0.3],
  },
};

function crabMaterial(palette) {
  const m = new THREE.MeshPhysicalMaterial({
    roughness: 0.45, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.28, specularIntensity: 0.7,
  });
  const col = (a) => new THREE.Color(a[0], a[1], a[2]);
  const u = {
    uCarapace: { value: col(palette.carapace) },
    uLeg: { value: col(palette.leg) },
    uPale: { value: col(palette.pale) },
    uTip: { value: col(palette.tip) },
    uCornea: { value: col(palette.cornea) },
    uMargin: { value: col(palette.margin) },
    uWetCoat: { value: 0.0 },
  };
  worldPosPatch(m);
  addPatch(m, {
    key: 'crab',
    uniforms: u,
    vertexHead: 'attribute vec4 aZone; attribute float aAO; varying vec4 vZone; varying float vAO; varying vec3 vObj; varying vec3 vObjN;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvZone = aZone; vAO = aAO; vObj = position; vObjN = normal;']],
    fragmentHead: /* glsl */ `
      varying vec4 vZone; varying float vAO; varying vec3 vObj; varying vec3 vObjN;
      uniform vec3 uCarapace; uniform vec3 uLeg; uniform vec3 uPale; uniform vec3 uTip; uniform vec3 uCornea; uniform vec3 uMargin;
      uniform float uWetCoat;
    `,
    fragment: [
      ['#include <color_fragment>', /* glsl */ `#include <color_fragment>
      float cH = 0.0;
      {
        vec3 p = vObj;
        float fw = length(fwidth(p));
        float fade = smoothstep(0.004, 0.02, fw);
        // 甲羅: 中央が濃く、縁へ向かって赤み
        float d = vZone.x;
        vec3 shell = mix(uMargin, uCarapace, smoothstep(0.0, 0.85, d));
        // 脚: 背側はやや濃く、腹側は淡く
        vec3 leg = uLeg * mix(1.18, 0.82, smoothstep(-0.3, 0.8, vObjN.y));
        leg = mix(leg, mix(uLeg, uPale, 0.35), smoothstep(0.1, -0.8, vObjN.y) * 0.6);
        leg *= 0.9 + 0.2 * vnoise3(p * 9.0);
        vec3 c = mix(leg, shell, smoothstep(0.02, 0.3, d));
        // 甲羅の雲状の斑（大きめの濃淡 + 細かな点）
        float mot = vnoise3(p * 3.2) * 0.55 + vnoise3(p * 8.0) * 0.3 + vnoise3(p * 21.0) * 0.15;
        c *= mix(1.0, 0.62 + 0.7 * mot, smoothstep(0.1, 0.6, d));
        c = mix(c, uPale, vZone.y);
        c = mix(c, uTip, vZone.z);
        c *= 0.92 + 0.16 * vnoise3(p * 40.0 + 3.0) * (1.0 - fade);
        // 細かな点刻
        float pit = step(0.94, hash13(floor(p * 150.0))) * (1.0 - fade) * smoothstep(0.1, 0.5, d);
        c *= 1.0 - pit * 0.18;
        c = mix(c, uCornea, vZone.w);
        diffuseColor.rgb = c;
        cH = (vnoise3(p * 34.0) * 0.0012 - pit * 0.0015) * (1.0 - fade) * (1.0 - vZone.w);
      }`],
      ['#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor *= 0.75 + 0.5 * vnoise3(vObj * 12.0);
      roughnessFactor = mix(roughnessFactor, 0.24, vZone.w);`],
      ['#include <normal_fragment_maps>', /* glsl */ `#include <normal_fragment_maps>
      {
        vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
        float dhx = dFdx(cH), dhy = dFdy(cH);
        vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
        float det = dot(dpdx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        normal = safeNormalize(abs(det) * normal - grad, normal);
      }`],
      ['#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
        material.clearcoat = clamp(material.clearcoat * (0.55 + 0.45 * uWetCoat) + vZone.w, 0.0, 1.0);
        material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.05, uWetCoat);
      #endif`],
      ['#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= vAO;
      reflectedLight.indirectSpecular *= mix(1.0, vAO, 0.7);
      reflectedLight.directDiffuse *= mix(1.0, vAO, 0.35);
      // 薄い脚の縁の透過感
      reflectedLight.indirectDiffuse += diffuseColor.rgb * (1.0 - vZone.x) * 0.02;`],
    ],
  });
  waterFxPatch(m, { wetHeight: 0.05, wetDarken: 0.08, wetGloss: 0.2 });
  m.userData.crabUniforms = u;
  return m;
}

function quatYZ(yaw, tilt, out = new THREE.Quaternion()) {
  _q1.setFromAxisAngle(Y, yaw);
  _q2.setFromAxisAngle(Z, tilt);
  return out.copy(_q1).multiply(_q2);
}

export class CrabRig {
  constructor(parts, { sex = 'male', palette = PALETTES.brown, bigRight = true } = {}) {
    this.sex = sex;
    this.bones = [];
    this.legs = [];
    this.chelae = [];
    this.eyes = [];
    this.maxillipeds = [];
    const pieces = [];
    const bones = this.bones;
    const mk = (parent, x, y, z, q) => {
      const b = new THREE.Bone();
      b.position.set(x, y, z);
      if (q) b.quaternion.copy(q);
      if (parent) parent.add(b);
      bones.push(b);
      return b;
    };
    const root = mk(null, 0, 0, 0);
    this.root = root;
    pieces.push({ geo: parts.body, bone: root });

    // 歩脚
    const CB_TILT = -10 * D2R;
    for (const side of [1, -1]) {
      for (let n = 1; n <= 4; n++) {
        const sp = walkingLegSpec(n);
        const legParts = parts.legs[n];
        const a = sp.yaw * D2R;
        const theta = side > 0 ? -a : Math.PI + a;
        const attach = new THREE.Vector3(side * 0.88, -0.2, sp.z);
        const yaw = mk(root, attach.x, attach.y, attach.z, quatYZ(theta, CB_TILT));
        const lift = mk(yaw, sp.Lcb, 0, 0);
        const knee = mk(lift, sp.Lm, 0, 0);
        const wrist = mk(knee, sp.Lca, 0, 0);
        const ankle = mk(wrist, sp.Lp, 0, 0);
        const mir = side < 0 ? 'z' : null;
        pieces.push({ geo: legParts.cb, bone: yaw, mirror: mir });
        pieces.push({ geo: legParts.merus, bone: lift, mirror: mir });
        pieces.push({ geo: legParts.carpus, bone: knee, mirror: mir });
        pieces.push({ geo: legParts.propodus, bone: wrist, mirror: mir });
        pieces.push({ geo: legParts.dactyl, bone: ankle, mirror: mir });
        this.legs.push({
          side, n, sp, attach, theta, tilt: CB_TILT, bones: { yaw, lift, knee, wrist, ankle },
          // 歩行用の状態
          foot: new THREE.Vector3(), footFrom: new THREE.Vector3(), footTo: new THREE.Vector3(),
          phase: 0, swinging: false, swingT: 0, swingDur: 0.2, group: 0, lastStep: 0, home: new THREE.Vector3(),
          inWater: false,
        });
      }
    }

    // 鉗脚
    for (const side of [1, -1]) {
      let size;
      if (sex === 'female') size = 0.4;
      else size = (side < 0) === bigRight ? 1.0 : 0.55;
      const cp = parts.chela[size];
      const sp = cp.spec;
      const a = sp.yaw * D2R;
      const theta = side > 0 ? -a : Math.PI + a;
      const attach = new THREE.Vector3(side * 0.66, -0.2, 0.58);
      const yaw = mk(root, attach.x, attach.y, attach.z, quatYZ(theta, -6 * D2R));
      const lift = mk(yaw, sp.Lcb, 0, 0);
      const elbow = mk(lift, sp.Lm, 0, 0);
      const wrist = mk(elbow, sp.Lca, 0, 0);
      const dact = mk(wrist, sp.palmL * 0.9, sp.palmH * 0.2, 0);
      const mir = side < 0 ? 'z' : null;
      pieces.push({ geo: cp.cb, bone: yaw, mirror: mir });
      pieces.push({ geo: cp.merus, bone: lift, mirror: mir });
      pieces.push({ geo: cp.carpus, bone: elbow, mirror: mir });
      pieces.push({ geo: cp.propodus, bone: wrist, mirror: mir });
      pieces.push({ geo: cp.dactyl, bone: dact, mirror: mir });
      this.chelae.push({ side, sp, size, theta, attach, bones: { yaw, lift, elbow, wrist, dact } });
    }

    // 眼
    for (const side of [1, -1]) {
      const e = mk(root, side * 0.69, -0.19, 0.93);
      pieces.push({ geo: parts.eye, bone: e, mirror: side < 0 ? 'x' : null });
      this.eyes.push({ side, bone: e });
    }
    // 触角
    this.antennae = [];
    for (const side of [1, -1]) {
      const b = mk(root, side * 0.45, -0.25, 0.95);
      pieces.push({ geo: parts.antenna, bone: b, mirror: side < 0 ? 'x' : null });
      this.antennae.push({ side, bone: b });
    }
    // 第3顎脚
    for (const side of [1, -1]) {
      const b = mk(root, side * 0.16, -0.36, 0.76);
      pieces.push({ geo: parts.maxilliped, bone: b, mirror: side < 0 ? 'x' : null });
      this.maxillipeds.push({ side, bone: b });
    }

    // バインドポーズでジオメトリを結合
    root.updateMatrixWorld(true);
    const geos = [];
    for (const p of pieces) {
      const g = p.geo.clone();
      if (p.offset) g.translate(p.offset.x, p.offset.y, p.offset.z);
      if (p.mirror) {
        const s = p.mirror === 'z' ? [1, 1, -1] : [-1, 1, 1];
        g.scale(s[0], s[1], s[2]);
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
        g.index.needsUpdate = true;
      }
      g.applyMatrix4(p.bone.matrixWorld);
      const n = g.attributes.position.count;
      const bi = bones.indexOf(p.bone);
      const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    this.material = crabMaterial(palette);
    const mesh = new THREE.SkinnedMesh(merged, this.material);
    mesh.add(root);
    mesh.bind(new THREE.Skeleton(bones));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.mesh = mesh;

    // ガラスとの当たり用: 骨ごとの頂点範囲（骨ローカルの箱の角）。
    // 胴に固定された部分（甲羅・ハサミ・眼・脚の付け根）と、IK で動く脚の先とに分ける
    const boxes = bones.map(() => new THREE.Box3());
    const pa = merged.attributes.position, sia = merged.attributes.skinIndex, inv = mesh.skeleton.boneInverses;
    const p = new THREE.Vector3();
    for (let i = 0; i < pa.count; i++) {
      const bi = sia.getX(i);
      boxes[bi].expandByPoint(p.fromBufferAttribute(pa, i).applyMatrix4(inv[bi]));
    }
    const hullOf = (bone) => {
      const b = boxes[bones.indexOf(bone)];
      if (b.isEmpty()) return null;
      const pts = [];
      for (let c = 0; c < 8; c++) pts.push(new THREE.Vector3(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z));
      return { bone, pts };
    };
    const legPart = new Set();
    for (const l of this.legs) {
      const chain = [l.bones.lift, l.bones.knee, l.bones.wrist, l.bones.ankle];
      for (const b of chain) legPart.add(b);
      l.hull = chain.map(hullOf).filter(Boolean);
    }
    this.hull = bones.filter((b) => !legPart.has(b)).map(hullOf).filter(Boolean);

    this.claw = { l: {}, r: {} };
    this.setRestPose();
  }

  // 直前に更新された姿勢での水平方向の広がり（ワールド座標）
  extents(out, hull = this.hull) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const h of hull) {
      const e = h.bone.matrixWorld.elements;
      for (const p of h.pts) {
        const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
        const z = e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
    out.x0 = x0; out.x1 = x1; out.z0 = z0; out.z1 = z1;
    return out;
  }

  setPalette(p) {
    const u = this.material.userData.crabUniforms;
    for (const k of ['carapace', 'leg', 'pale', 'tip', 'cornea', 'margin']) {
      const key = 'u' + k[0].toUpperCase() + k.slice(1);
      u[key].value.setRGB(p[k][0], p[k][1], p[k][2]);
    }
  }

  // 脚の IK（ターゲットは胴体ローカル座標）
  solveLeg(leg, target) {
    const sp = leg.sp;
    _v.subVectors(target, leg.attach).applyAxisAngle(Y, -leg.theta);
    let delta = Math.atan2(-_v.z, _v.x);
    delta = clamp(delta, -42 * D2R, 42 * D2R);
    const r = Math.hypot(_v.x, _v.z);
    const ty = _v.y;
    const tilt = leg.tilt;
    const Sx = sp.Lcb * Math.cos(tilt), Sy = sp.Lcb * Math.sin(tilt);
    const reach = clamp((r - 1.2) / 1.5, 0, 1);
    const psi = lerp(-82, -52, reach) * D2R;
    const Ax = r - sp.Ld * Math.cos(psi), Ay = ty - sp.Ld * Math.sin(psi);
    const beta = -16 * D2R;
    const L1 = sp.Lm;
    const lx = sp.Lca + sp.Lp * Math.cos(beta), ly = sp.Lp * Math.sin(beta);
    const L2 = Math.hypot(lx, ly);
    const gamma = Math.atan2(ly, lx);
    let dx = Ax - Sx, dy = Ay - Sy;
    let D = Math.hypot(dx, dy);
    D = clamp(D, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
    const phiSA = Math.atan2(dy, dx);
    const cosA = clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1);
    const alpha = Math.acos(cosA);
    const phi1 = phiSA + alpha;
    const Kx = Sx + L1 * Math.cos(phi1), Ky = Sy + L1 * Math.sin(phi1);
    const Ax2 = Sx + Math.cos(phiSA) * D, Ay2 = Sy + Math.sin(phiSA) * D;
    const phiKA = Math.atan2(Ay2 - Ky, Ax2 - Kx);
    const phiC = phiKA - gamma;
    const b = leg.bones;
    quatYZ(leg.theta + delta, tilt, b.yaw.quaternion);
    b.lift.rotation.set(0, 0, phi1 - tilt);
    b.knee.rotation.set(0, 0, phiC - phi1);
    b.wrist.rotation.set(0, 0, beta);
    b.ankle.rotation.set(0, 0, psi - (phiC + beta));
  }

  // 鉗脚のポーズ（Euler: 右側は x,y を反転してミラー）
  setChelaPose(ch, pose) {
    const s = ch.side;
    const b = ch.bones;
    const e = (o, arr) => o.rotation.set(arr[0] * D2R * s, arr[1] * D2R * s, arr[2] * D2R);
    quatYZ(ch.theta, -6 * D2R, b.yaw.quaternion);
    // 正の yaw で前方へ振る（左は -y 回り、右は +y 回り）
    _q1.setFromAxisAngle(Y, -pose.yaw * D2R * s);
    b.yaw.quaternion.premultiply(_q1);
    e(b.lift, pose.lift);
    e(b.elbow, pose.elbow);
    e(b.wrist, pose.wrist);
    b.dact.rotation.set(0, 0, pose.open * D2R);
  }

  setRestPose() {
    const rest = { yaw: -10, lift: [0, 0, -5], elbow: [0, -62, 28], wrist: [-20, -55, -18], open: 5 };
    for (const ch of this.chelae) this.setChelaPose(ch, rest);
    for (const e of this.eyes) e.bone.rotation.set(0.25, 0, -0.12 * e.side);
    for (const m of this.maxillipeds) m.bone.rotation.set(-0.35, 0, 0);
  }
}
