// Clawd モード: カニの見た目を、Claude Code のマスコット「Clawd」（ブロック調のオレンジのカニ）の
// 二次創作版に差し替える。骨格・IK・行動はサワガニのものをそのまま使い、見た目だけを乗せ替える。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { waterFxPatch } from '../core/shared.js';
import { clamp, lerp } from '../core/rng.js';

export const CLAWD_HEX = '#C67D5F';
// 元の SVG（viewBox 150x110）の 1 単位を、カニの骨格ローカルでの長さに直す
const U = 0.026;
// 寸法（SVG 単位）。胴 86x66、脚 9x22、腕 24x22、目 13x13
const BODY_W = 86, BODY_H = 66, BODY_D = 56;
const LEG_W = 9, LEG_L = 22;
const ARM_L = 24, ARM_H = 22, ARM_D = 22, ARM_IN = 4;
const EYE = 13;
const TOTAL_H = LEG_L + BODY_H;
const D2R = Math.PI / 180;

// water: 水槽の中で使う（水中のゆらめき・濡れを付ける）。机の上の置物は false
const _mats = {};
function materials(water) {
  const key = water ? 'wet' : 'dry';
  if (_mats[key]) return _mats[key];
  const body = new THREE.MeshPhysicalMaterial({
    // AgX トーンマップで淡く見えるぶん、彩度を少し足しておく
    color: new THREE.Color(CLAWD_HEX).offsetHSL(0, 0.1, -0.03), roughness: 0.55, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.4,
  });
  const eye = new THREE.MeshPhysicalMaterial({ color: 0x141414, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 });
  if (water) {
    waterFxPatch(body, { wetHeight: 0.05, wetDarken: 0.08, wetGloss: 0.2 });
    waterFxPatch(eye, { wetHeight: 0.05, wetDarken: 0, wetGloss: 0 });
  }
  _mats[key] = { body, eye };
  return _mats[key];
}

function box(w, h, d, mat, r = 1.2) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Clawd の体を組み立てる（SVG 単位のまま。使う側で縮める）。原点は足元の中心、前（目のある面）が +z
export function buildClawd({ water = true } = {}) {
  const { body: mb, eye: me } = materials(water);
  const group = new THREE.Group();
  group.name = 'clawd';

  const body = box(BODY_W, BODY_H, BODY_D, mb);
  body.position.y = LEG_L + BODY_H / 2;
  group.add(body);

  // 目（SVG では胴の上端から 14〜27、中心から左右に約 19）
  const eyes = [];
  for (const side of [-1, 1]) {
    const e = box(EYE, EYE, 2, me, 0.6);
    const pivot = new THREE.Group();
    pivot.position.set(side * 19, LEG_L + BODY_H - 20.5, BODY_D / 2 + 0.6);
    pivot.add(e);
    group.add(pivot);
    eyes.push(pivot);
  }

  // 腕: 回転軸は腕の内側の端（胴に 4 だけ食い込んだ所）に置く。SVG 版と同じ関節位置
  const arms = {};
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * (BODY_W / 2 - ARM_IN), LEG_L + 28, 0);
    pivot.rotation.order = 'YZX';
    const a = box(ARM_L, ARM_H, ARM_D, mb);
    a.position.x = side * ARM_L / 2;
    pivot.add(a);
    group.add(pivot);
    arms[side] = pivot;
  }

  // 脚: 正面から見て 4 本（前後 2 列）。回転軸は付け根
  const legs = [];
  const slots = [
    { x: -26.5, side: -1, outer: true }, { x: -10.5, side: -1, outer: false },
    { x: 11.5, side: 1, outer: false }, { x: 27.5, side: 1, outer: true },
  ];
  for (const row of [1, -1]) {
    for (const s of slots) {
      const pivot = new THREE.Group();
      pivot.position.set(s.x, LEG_L, row * (BODY_D / 2 - 12));
      const l = box(LEG_W, LEG_L + 2, LEG_W, mb, 1);
      l.position.y = -LEG_L / 2 + 1;
      pivot.add(l);
      group.add(pivot);
      legs.push({ pivot, row, side: s.side, outer: s.outer });
    }
  }
  return { group, eyes, arms, legs };
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

export class ClawdSkin {
  constructor(crab) {
    this.crab = crab;
    const f = buildClawd();
    this.group = f.group;
    this.eyes = f.eyes;
    this.arms = {};
    for (const side of [-1, 1]) this.arms[side] = { pivot: f.arms[side], raise: 0, fwd: 0 };
    // サワガニの歩脚（左右 4 対）に 1 本ずつ対応させ、その足先の動きに合わせて振る
    this.legs = f.legs.map((l) => {
      const n = (l.row > 0 ? 1 : 3) + (l.outer ? 1 : 0);
      const ik = crab.rig.legs.find((k) => k.side === l.side && k.n === n);
      return { pivot: l.pivot, ik, ax: 0, az: 0, lift: 0 };
    });
    this.group.scale.setScalar(U);
    this.squash = 1;
    crab.rig.root.add(this.group);
  }

  update(dt) {
    const c = this.crab;
    const s = c.scale;
    const root = c.rig.root;
    const k = 1 - Math.exp(-dt * 14);

    // 石の下など天井が低い所では、ぺたんとつぶれる
    const nav = c.env.nav;
    const room = nav ? (nav.ceilAt(c.pos.x, c.pos.z) - c.baseY) / s - 0.06 : Infinity;
    let sq = clamp(room / (TOTAL_H * U), 0.5, 1);
    sq *= 1 - 0.12 * (c.crouch || 0);
    this.squash = lerp(this.squash, sq, 1 - Math.exp(-dt * 10));
    const wide = 1 + (1 - this.squash) * 0.35;
    this.group.scale.set(U * wide, U * this.squash, U * wide);
    // 足元を地面に合わせる（胴の上下動はサワガニの骨格から受け継がない）
    this.group.position.y = (c.baseY - c.bodyY) / s;
    // 箱の体は傾くと目立つので、坂や前かがみの傾きは半分だけ受ける
    this.group.rotation.set(-root.rotation.x * 0.5, 0, -root.rotation.z * 0.5);

    // 脚: 対応するサワガニの足先が、定位置からどれだけずれているかで振る
    const inv = _q.copy(root.quaternion).invert();
    const legLen = LEG_L * U;
    for (const L of this.legs) {
      if (!L.ik) continue;
      _v.copy(L.ik.foot);
      c.group.worldToLocal(_v);
      _v.sub(root.position).applyQuaternion(inv);
      const dx = _v.x - L.ik.homeLocal.x, dz = _v.z - L.ik.homeLocal.z;
      const tx = clamp(Math.atan2(dz * 0.55, legLen * 2), -0.55, 0.55);
      const tz = clamp(Math.atan2(dx * 0.55, legLen * 2), -0.55, 0.55);
      L.ax = lerp(L.ax, tx, k);
      L.az = lerp(L.az, tz, k);
      L.lift = lerp(L.lift, L.ik.swinging ? 1 : 0, k);
      L.pivot.rotation.set(-L.ax, 0, L.az);
      L.pivot.scale.y = 1 - 0.22 * L.lift;
    }

    // 腕: はさみのポーズを、上げ下げ（威嚇でバンザイ）と前への振り（餌を取る・口へ運ぶ）に読み替える
    for (const cl of c.claws) {
      const side = cl.ch.side;
      const arm = this.arms[side];
      if (!arm) continue;
      const p = cl.pose;
      // 威嚇は SVG 版のバンザイ（32°）を少し強めた角度で、小刻みに振る
      const up = clamp((p.lift[2] + 5) / 29, 0, 1);
      const raise = up * (36 + 8 * Math.sin(c.time * 16 + (side > 0 ? 0 : 1.2)));
      const fwd = clamp((-p.lift[2] - 5) / 21, 0, 1) * 50 + Math.max(0, p.yaw) * 1.5;
      const moving = Math.hypot(c.vel.x, c.vel.z) > 0.2 ? 1 : 0.3;
      const sway = moving * Math.sin(c.time * 5 + (side > 0 ? 0 : 1.7)) * 5;
      arm.raise = lerp(arm.raise, raise + sway, k);
      arm.fwd = lerp(arm.fwd, fwd, k);
      arm.pivot.rotation.set(0, -side * arm.fwd * D2R, side * arm.raise * D2R);
    }

    // 目: まばたき・引っ込めたときは細くなる
    const open = clamp(c.eyeUp, 0, 1);
    for (const e of this.eyes) e.scale.y = lerp(0.12, 1, open);
  }

  setVisible(on) {
    this.group.visible = on;
  }
}
