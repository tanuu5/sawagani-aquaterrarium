import * as THREE from 'three';
import { CrabRig, PALETTES } from './crabRig.js';
import { WATER_LEVEL, TANK } from '../core/shared.js';
import { RNG, clamp, lerp, smoothstep } from '../core/rng.js';

const D2R = Math.PI / 180;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);
const _ext = {};

// 鉗脚のポーズ（左側基準、度）
const POSES = {
  rest: { yaw: -10, lift: [0, 0, -5], elbow: [0, -62, 28], wrist: [-20, -55, -18], open: 5 },
  walk: { yaw: -8, lift: [0, 0, 2], elbow: [0, -60, 28], wrist: [-20, -52, -16], open: 4 },
  reach: { yaw: 6, lift: [0, 0, -26], elbow: [0, -46, 8], wrist: [-10, -42, -46], open: 24 },
  grab: { yaw: 6, lift: [0, 0, -24], elbow: [0, -48, 8], wrist: [-10, -44, -44], open: 0 },
  mouth: { yaw: 0, lift: [0, 0, -14], elbow: [0, -86, 20], wrist: [-25, -72, -38], open: 3 },
  threat: { yaw: -34, lift: [12, 0, 24], elbow: [0, -36, 40], wrist: [-40, -14, 26], open: 32 },
  tuck: { yaw: -6, lift: [0, 0, -14], elbow: [0, -76, 22], wrist: [-20, -62, -26], open: 0 },
};
function lerpPose(a, b, t, out) {
  out.yaw = lerp(a.yaw, b.yaw, t);
  for (const k of ['lift', 'elbow', 'wrist']) {
    out[k] = out[k] || [0, 0, 0];
    for (let i = 0; i < 3; i++) out[k][i] = lerp(a[k][i], b[k][i], t);
  }
  out.open = lerp(a.open, b.open, t);
  return out;
}
const clonePose = (p) => ({ yaw: p.yaw, lift: [...p.lift], elbow: [...p.elbow], wrist: [...p.wrist], open: p.open });

const legGroup = (side, n) => (((n % 2 === 1) === side > 0) ? 0 : 1);
const HOME_R = [0, 2.5, 2.85, 2.8, 2.45];
// 壁ぎわで脚を無理なく折りたためる、付け根からの水平距離
const FOLD_R = 1.4;
const BODY_H = 0.7;

export class Crab {
  constructor(parts, opts, env) {
    this.env = env;
    this.name = opts.name;
    this.sex = opts.sex;
    this.paletteKey = opts.palette;
    this.scale = opts.scale;
    this.rng = new RNG(opts.seed || 1);
    this.personality = { boldness: opts.boldness ?? 0.5, activity: opts.activity ?? 0.5, water: opts.water ?? 0.5 };
    this.rig = new CrabRig(parts, { sex: opts.sex, palette: PALETTES[opts.palette], bigRight: opts.bigRight !== false });
    this.group = new THREE.Group();
    this.group.add(this.rig.mesh);
    this.group.scale.setScalar(this.scale);
    this.group.name = 'crab-' + opts.name;

    this.pos = new THREE.Vector3(opts.x, 0, opts.z);
    this.heading = opts.heading ?? 0;
    this.vel = new THREE.Vector3();
    this.desiredVel = new THREE.Vector3();
    this.turnRate = 0;
    this.bodyY = 0;
    this.baseY = 0;
    this.pitch = 0; this.roll = 0;
    this.bob = 0;
    this.time = 0;
    this.wet = 0;
    this.submerged = 0;

    for (const leg of this.rig.legs) {
      leg.group = legGroup(leg.side, leg.n);
      const dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(UP, leg.theta);
      leg.homeLocal = leg.attach.clone().addScaledVector(dir, HOME_R[leg.n]);
      leg.homeLocal.y = 0;
      leg.foldLocal = leg.attach.clone().addScaledVector(dir, FOLD_R);
    }
    this.swinging = [false, false];
    this.groupLast = [0, 0];

    // 行動
    this.state = 'idle';
    this.stateT = 0;
    this.stateDur = 2;
    this.path = null;
    this.pathI = 0;
    this.moveSpeed = 2.5;
    this.moveMode = 'side';
    this.onArrive = null;
    this.target = null;
    this.food = null;
    this.startle = 0;

    // 鉗脚
    this.claws = this.rig.chelae.map((ch) => ({ ch, pose: clonePose(POSES.rest), target: POSES.rest, speed: 6, timer: 0, phase: 'idle' }));
    this.eyeUp = 1; this.eyeTarget = 1; this.nextBlink = this.rng.range(2, 6);
    this.maxT = 0;

    this.placeInitial();
  }

  // ---- 初期配置 ----
  placeInitial() {
    const nav = this.env.nav;
    this.baseY = nav.groundAt(this.pos.x, this.pos.z);
    this.bodyY = this.baseY + BODY_H * this.scale;
    this.updateGroupTransform();
    for (const leg of this.rig.legs) {
      this.homeWorld(leg, leg.foot);
      leg.footFrom.copy(leg.foot); leg.footTo.copy(leg.foot);
      leg.swinging = false;
    }
    this.updateBody(0.016, true);
    this.applyIK();
  }

  homeWorld(leg, out) {
    out.copy(leg.homeLocal).multiplyScalar(this.scale).applyAxisAngle(UP, this.heading);
    out.x += this.pos.x; out.z += this.pos.z;
    // 足先はガラスの内側まで（壁ぎわではガラスに脚を突っ張る）
    out.x = clamp(out.x, TANK.ix0 + 0.15, TANK.ix1 - 0.15);
    out.z = clamp(out.z, TANK.iz0 + 0.15, TANK.iz1 - 0.15);
    out.y = this.env.nav.groundAt(out.x, out.z);
    return out;
  }

  updateGroupTransform() {
    this.group.position.set(this.pos.x, this.baseY, this.pos.z);
    this.group.rotation.set(0, this.heading, 0);
    this.group.updateMatrixWorld(true);
  }

  // ---- 移動 ----
  setPath(path, speed = 2.5, mode = 'side', onArrive = null) {
    this.path = path;
    this.pathI = path && path.length > 1 ? 1 : 0;
    this.moveSpeed = speed;
    this.moveMode = mode;
    this.onArrive = onArrive;
    this.progT = 0;
    this.progX = this.pos.x; this.progZ = this.pos.z;
  }

  // 進めなくなったら諦める（岩の隙間や他のカニとの押し合いで詰まった時）
  checkStuck(dt) {
    if (!this.path) return;
    this.progT += dt;
    if (this.progT < 2.5) return;
    const moved = Math.hypot(this.pos.x - this.progX, this.pos.z - this.progZ);
    this.progT = 0;
    this.progX = this.pos.x; this.progZ = this.pos.z;
    if (moved > 0.4) return;
    const last = this.path[this.path.length - 1];
    const dLast = Math.hypot(last[0] - this.pos.x, last[1] - this.pos.z);
    const cb = this.onArrive;
    this.path = null;
    this.onArrive = null;
    if (dLast < 2.5 && cb) cb();
    else if (this.state !== 'eat') {
      if (this.food) { this.food.claimedBy = null; this.food = null; }
      this.setState('idle', this.rng.range(0.8, 2.5));
    }
  }

  // 他のカニがいない（向かっていない）隠れ場所
  freeShelters() {
    const env = this.env;
    return env.shelters.filter((sp) => env.crabs.every((o) => {
      if (o === this) return true;
      if (Math.hypot(o.pos.x - sp[0], o.pos.z - sp[1]) < 2.4) return false;
      const last = o.path && o.path[o.path.length - 1];
      return !(last && Math.hypot(last[0] - sp[0], last[1] - sp[1]) < 2.4);
    }));
  }

  startHide(spot, speed, flee = false) {
    const rng = this.rng;
    const ok = this.goTo(spot[0], spot[1], speed, 'side', () => {
      // 外（水槽の手前）を向いて身を潜める
      this.hideFace = [this.pos.x + (spot.face ? spot.face[0] : 0), this.pos.z + (spot.face ? spot.face[1] : 6)];
      this.setState('hide', flee ? rng.range(8, 20) : rng.range(10, 35));
    });
    if (ok) this.setState(flee ? 'flee' : 'walk', flee ? 8 : 40);
    return ok;
  }
  goTo(x, z, speed, mode, onArrive) {
    const p = this.env.nav.findPath(this.pos.x, this.pos.z, x, z);
    if (!p) { this.setPath(null); return false; }
    this.setPath(p, speed, mode, onArrive);
    return true;
  }

  steer(dt) {
    this.desiredVel.set(0, 0, 0);
    let arriving = false;
    if (this.path && this.pathI < this.path.length) {
      const wp = this.path[this.pathI];
      const dx = wp[0] - this.pos.x, dz = wp[1] - this.pos.z;
      const d = Math.hypot(dx, dz);
      const last = this.pathI === this.path.length - 1;
      if (d < (last ? 0.25 : 0.6)) {
        this.pathI++;
        if (this.pathI >= this.path.length) {
          this.path = null;
          const cb = this.onArrive; this.onArrive = null;
          if (cb) cb();
        }
      } else {
        let sp = this.moveSpeed;
        if (last) sp *= clamp(d / 1.2, 0.25, 1);
        arriving = last;
        this.desiredVel.set(dx / d * sp, 0, dz / d * sp);
      }
    }
    // 他のカニを避ける
    for (const o of this.env.crabs) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      const rr = 3.4 * (this.scale + o.scale) * 0.5;
      if (d < rr && d > 1e-3) {
        const push = (rr - d) / rr * 3.0;
        this.desiredVel.x += dx / d * push; this.desiredVel.z += dz / d * push;
      }
    }
    // 水中は遅い
    const slow = this.submerged > 0.5 ? 0.7 : 1;
    this.desiredVel.multiplyScalar(slow);
    const acc = (this.state === 'flee' ? 40 : 10) * dt;
    _v.subVectors(this.desiredVel, this.vel);
    const l = _v.length();
    if (l > acc) _v.multiplyScalar(acc / l);
    this.vel.add(_v);
    // 向き: 横歩きなら進行方向の ±90°
    const speed = Math.hypot(this.vel.x, this.vel.z);
    let targetHeading = this.heading;
    if (speed > 0.15 || this.desiredVel.lengthSq() > 0.05) {
      const vx = this.desiredVel.lengthSq() > 0.01 ? this.desiredVel.x : this.vel.x;
      const vz = this.desiredVel.lengthSq() > 0.01 ? this.desiredVel.z : this.vel.z;
      const phi = Math.atan2(vx, vz);
      if (this.moveMode === 'forward') {
        targetHeading = phi;
      } else {
        const a = phi - Math.PI / 2, b = phi + Math.PI / 2;
        const da = angDiff(a, this.heading), db = angDiff(b, this.heading);
        const best = Math.abs(da) < Math.abs(db) ? a : b;
        const dd = angDiff(best, this.heading);
        // 30° までは斜め歩きを許す
        if (Math.abs(dd) > 30 * D2R) targetHeading = this.heading + (dd - Math.sign(dd) * 30 * D2R);
      }
    }
    if (this.faceTarget) {
      targetHeading = Math.atan2(this.faceTarget[0] - this.pos.x, this.faceTarget[1] - this.pos.z);
    }
    const dh = angDiff(targetHeading, this.heading);
    const maxTurn = (this.state === 'flee' ? 5 : 1.8) * dt;
    const turn = clamp(dh, -maxTurn, maxTurn);
    this.heading += turn;
    this.turnRate = turn / Math.max(dt, 1e-4);
    // 位置
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // 他のカニと重ならない（硬い制約）
    for (const o of this.env.crabs) {
      if (o === this) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = 2.3 * (this.scale + o.scale) * 0.5;
      if (d < minD && d > 1e-4) {
        const push = (minD - d) * 0.5;
        this.pos.x += (dx / d) * push; this.pos.z += (dz / d) * push;
      }
    }
    // 水槽の壁: 直前の姿勢での外形（甲羅・ハサミ・脚の付け根）と、脚を折りたたむ場所が
    // ガラスの内側に収まる位置まで（向きによって壁に寄れる距離が変わる）
    const ex = this.rig.extents(_ext);
    const g = this.group.matrixWorld.elements, pad = 0.06;
    if (Number.isFinite(ex.x0 + ex.x1 + ex.z0 + ex.z1)) {
      let mx0 = g[12] - ex.x0, mx1 = ex.x1 - g[12], mz0 = g[14] - ex.z0, mz1 = ex.z1 - g[14];
      const ch = Math.cos(this.heading) * this.scale, sh = Math.sin(this.heading) * this.scale;
      for (const leg of this.rig.legs) {
        const f = leg.foldLocal;
        const wx = f.x * ch + f.z * sh, wz = -f.x * sh + f.z * ch;
        mx0 = Math.max(mx0, -wx); mx1 = Math.max(mx1, wx);
        mz0 = Math.max(mz0, -wz); mz1 = Math.max(mz1, wz);
      }
      this.pos.x = clamp(this.pos.x, TANK.ix0 + pad + mx0, TANK.ix1 - pad - mx1);
      this.pos.z = clamp(this.pos.z, TANK.iz0 + pad + mz0, TANK.iz1 - pad - mz1);
    } else {
      const m = 2.2 * this.scale;
      this.pos.x = clamp(this.pos.x, TANK.ix0 + m, TANK.ix1 - m);
      this.pos.z = clamp(this.pos.z, TANK.iz0 + m, TANK.iz1 - m);
    }
    return arriving;
  }

  // ---- 脚 ----
  updateLegs(dt) {
    const s = this.scale;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = speed > 0.08 || Math.abs(this.turnRate) > 0.15;
    const stepDur = clamp(0.26 - speed * 0.022, 0.085, 0.26) * (this.submerged > 0.5 ? 1.25 : 1);
    const lead = stepDur * 0.7;
    const thr = (moving ? 0.34 : 0.16) * s;
    const need = [0, 0];
    for (const leg of this.rig.legs) {
      this.homeWorld(leg, _v);
      _v.x += this.vel.x * lead; _v.z += this.vel.z * lead;
      if (Math.abs(this.turnRate) > 0.05) {
        // 回転の先読み
        const a = this.turnRate * lead;
        const rx = _v.x - this.pos.x, rz = _v.z - this.pos.z;
        const c = Math.cos(a), sn = Math.sin(a);
        _v.x = this.pos.x + rx * c + rz * sn; _v.z = this.pos.z - rx * sn + rz * c;
      }
      _v.x = clamp(_v.x, TANK.ix0 + 0.15, TANK.ix1 - 0.15);
      _v.z = clamp(_v.z, TANK.iz0 + 0.15, TANK.iz1 - 0.15);
      _v.y = this.env.nav.groundAt(_v.x, _v.z);
      leg.predicted = leg.predicted || new THREE.Vector3();
      leg.predicted.copy(_v);
      const d = Math.hypot(_v.x - leg.foot.x, _v.z - leg.foot.z);
      need[leg.group] = Math.max(need[leg.group], d);
    }
    const anySwing = this.swinging[0] || this.swinging[1];
    if (!anySwing) {
      const g = need[0] >= need[1] ? 0 : 1;
      if (need[g] > thr && this.time - this.groupLast[g] > stepDur * 0.3) {
        this.swinging[g] = true;
        for (const leg of this.rig.legs) {
          if (leg.group !== g) continue;
          leg.swinging = true;
          leg.swingT = 0;
          leg.swingDur = stepDur * this.rng.range(0.92, 1.08);
          leg.footFrom.copy(leg.foot);
          leg.footTo.copy(leg.predicted);
          leg.stepH = (0.22 + Math.min(speed, 6) * 0.02) * s * (moving ? 1 : 0.6);
        }
      }
    }
    for (let g = 0; g < 2; g++) {
      if (!this.swinging[g]) continue;
      let done = true;
      for (const leg of this.rig.legs) {
        if (leg.group !== g || !leg.swinging) continue;
        leg.swingT += dt / leg.swingDur;
        const t = Math.min(leg.swingT, 1);
        const e = t * t * (3 - 2 * t);
        const wasUnder = leg.foot.y < WATER_LEVEL;
        leg.foot.lerpVectors(leg.footFrom, leg.footTo, e);
        leg.foot.y += Math.sin(Math.PI * t) * leg.stepH;
        const isUnder = leg.foot.y < WATER_LEVEL;
        if (wasUnder !== isUnder && this.env.ripple) this.env.ripple.addDrop(leg.foot.x, leg.foot.z, 0.12, 0.006 * this.scale);
        if (t >= 1) {
          leg.swinging = false;
          leg.foot.copy(leg.footTo);
          if (this.env.onFootstep) this.env.onFootstep(this, leg);
        } else done = false;
      }
      if (done) { this.swinging[g] = false; this.groupLast[g] = this.time; }
    }
  }

  // ---- 胴体の高さ・傾き ----
  updateBody(dt, snap = false) {
    const s = this.scale;
    const nav = this.env.nav;
    let sum = 0, cnt = 0;
    for (const leg of this.rig.legs) { if (!leg.swinging) { sum += leg.foot.y; cnt++; } }
    const footAvg = cnt ? sum / cnt : nav.groundAt(this.pos.x, this.pos.z);
    const center = nav.groundAt(this.pos.x, this.pos.z);
    const ground = Math.max(footAvg * 0.7 + center * 0.3, center - 0.3 * s);
    let crouch = this.crouch || 0;
    let target = ground + (BODY_H - 0.22 * crouch) * s;
    // シェルター石の下ではかがむ
    const ceil = nav.ceilAt(this.pos.x, this.pos.z);
    const maxBody = ceil - 0.72 * s;
    if (target > maxBody) target = Math.max(maxBody, ground + 0.34 * s);
    // 歩行の上下動
    const sw = this.swinging[0] || this.swinging[1];
    this.bob = lerp(this.bob, sw ? -0.035 * s : 0, 1 - Math.exp(-dt * 20));
    const breathe = Math.sin(this.time * 2.1) * 0.006 * s;
    const k = snap ? 1 : 1 - Math.exp(-dt * 10);
    this.bodyY = lerp(this.bodyY, target + this.bob + breathe, k);
    this.baseY = lerp(this.baseY, center, snap ? 1 : 1 - Math.exp(-dt * 6));
    // 傾き
    const r = 1.3 * s;
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const lx = Math.cos(this.heading), lz = -Math.sin(this.heading);
    const hF = nav.groundAt(this.pos.x + fx * r, this.pos.z + fz * r);
    const hB = nav.groundAt(this.pos.x - fx * r, this.pos.z - fz * r);
    const hL = nav.groundAt(this.pos.x + lx * r, this.pos.z + lz * r);
    const hR = nav.groundAt(this.pos.x - lx * r, this.pos.z - lz * r);
    const tp = clamp(-Math.atan2(hF - hB, 2 * r), -0.45, 0.45) + (this.pitchAdd || 0);
    const tr = clamp(Math.atan2(hL - hR, 2 * r), -0.45, 0.45);
    this.pitch = lerp(this.pitch, tp, snap ? 1 : 1 - Math.exp(-dt * 6));
    this.roll = lerp(this.roll, tr, snap ? 1 : 1 - Math.exp(-dt * 6));
    this.updateGroupTransform();
    const root = this.rig.root;
    root.position.set(0, (this.bodyY - this.baseY) / s, 0);
    root.rotation.set(this.pitch, 0, this.roll);
    root.updateMatrix();
    // 水没
    const top = this.bodyY + 0.5 * s;
    const sub = clamp((WATER_LEVEL - (this.bodyY - 0.2 * s)) / (0.9 * s), 0, 1);
    this.submerged = sub;
    if (sub > 0.3) this.wet = 1;
    else this.wet = Math.max(0, this.wet - dt / 90);
    this.rig.material.userData.crabUniforms.uWetCoat.value = this.wet;
    this.topY = top;
  }

  applyIK() {
    const root = this.rig.root;
    root.updateMatrixWorld(true);
    const inv = _q.copy(root.quaternion).invert();
    const pad = 0.05;
    for (const leg of this.rig.legs) {
      _v.copy(leg.foot);
      this.group.worldToLocal(_v);
      _v.sub(root.position).applyQuaternion(inv);
      this.rig.solveLeg(leg, _v);
      // 脚がガラスに入り込むなら、目標を内側へずらして解き直す
      for (let it = 0; it < 4; it++) {
        leg.bones.yaw.updateMatrixWorld(true);
        const ex = this.rig.extents(_ext, leg.hull);
        const ox = Math.max(0, TANK.ix0 + pad - ex.x0) - Math.max(0, ex.x1 - (TANK.ix1 - pad));
        const oz = Math.max(0, TANK.iz0 + pad - ex.z0) - Math.max(0, ex.z1 - (TANK.iz1 - pad));
        if (ox === 0 && oz === 0) break;
        _v2.set(ox, 0, oz).applyAxisAngle(UP, -this.heading).multiplyScalar(1 / this.scale).applyQuaternion(inv);
        _v.add(_v2);
        this.rig.solveLeg(leg, _v);
      }
    }
  }

  // ---- 鉗脚・眼・顎脚 ----
  animateParts(dt) {
    const t = this.time;
    for (const c of this.claws) {
      const k = 1 - Math.exp(-dt * c.speed);
      lerpPose(c.pose, c.target, k, c.pose);
      // 歩行中の揺れ
      const sway = (Math.hypot(this.vel.x, this.vel.z) > 0.2 ? 1 : 0.3) * Math.sin(t * 5 + (c.ch.side > 0 ? 0 : 1.7));
      const p = c.pose;
      const tmp = this._tmpPose || (this._tmpPose = clonePose(p));
      tmp.yaw = p.yaw; tmp.open = p.open;
      tmp.lift[0] = p.lift[0]; tmp.lift[1] = p.lift[1]; tmp.lift[2] = p.lift[2] + sway * 1.5;
      tmp.elbow[0] = p.elbow[0]; tmp.elbow[1] = p.elbow[1]; tmp.elbow[2] = p.elbow[2];
      tmp.wrist[0] = p.wrist[0]; tmp.wrist[1] = p.wrist[1]; tmp.wrist[2] = p.wrist[2] + sway;
      this.rig.setChelaPose(c.ch, tmp);
    }
    // 眼の出し入れ
    this.nextBlink -= dt;
    if (this.nextBlink < 0) {
      this.blinkT = 0.5;
      this.nextBlink = this.rng.range(2.5, 9);
    }
    let up = this.eyeTarget;
    if (this.blinkT > 0) { this.blinkT -= dt; up = Math.min(up, this.blinkT > 0.35 ? 0 : 1 - this.blinkT / 0.35 * 0.2); }
    this.eyeUp = lerp(this.eyeUp, up, 1 - Math.exp(-dt * (up < this.eyeUp ? 30 : 7)));
    for (const e of this.rig.eyes) {
      const wob = Math.sin(t * 0.7 + e.side) * 0.05;
      e.bone.rotation.set(lerp(1.35, 0.22, this.eyeUp) + wob, 0, (-0.14 + wob * 0.5) * e.side * this.eyeUp);
    }
    // 触角をぴくぴく動かす
    if (this.rig.antennae) {
      for (const a of this.rig.antennae) {
        a.flick = (a.flick || 0) - dt;
        if (a.flick < 0) { a.flick = this.rng.range(0.4, 2.5); a.ty = this.rng.range(0.15, 0.6); a.tx = this.rng.range(-0.35, 0.1); }
        a.cy = lerp(a.cy ?? 0.35, a.ty ?? 0.35, 1 - Math.exp(-dt * 14));
        a.cx = lerp(a.cx ?? -0.1, a.tx ?? -0.1, 1 - Math.exp(-dt * 14));
        a.bone.rotation.set(a.cx, a.cy * a.side, 0);
      }
    }
    // 第3顎脚: 呼吸でゆっくり、食事中は速く
    const eating = this.state === 'eat' || this.state === 'forage';
    this.maxT += dt * (eating ? 9 : 2.2);
    for (const m of this.rig.maxillipeds) {
      const f = Math.max(0, Math.sin(this.maxT + (m.side > 0 ? 0 : 0.6)));
      m.bone.rotation.set(-0.35 - f * (eating ? 0.25 : 0.08), 0, f * 0.12 * m.side);
    }
  }

  setClaws(poseName, speed = 6) {
    for (const c of this.claws) { c.target = POSES[poseName]; c.speed = speed; c.phase = 'hold'; }
  }

  // 採餌の動作（左右交互に地面をつまんで口へ）
  forageClaws(dt, holding = false) {
    for (let i = 0; i < this.claws.length; i++) {
      const c = this.claws[i];
      c.timer -= dt;
      if (c.timer > 0) continue;
      const other = this.claws[1 - i];
      switch (c.phase) {
        case 'idle': case 'hold':
          if (other.phase === 'reach' || other.phase === 'grab') { c.target = POSES.rest; c.timer = 0.2; break; }
          if (holding && i === (this.holdClaw ?? 0)) { c.target = POSES.mouth; c.speed = 5; c.phase = 'toMouth'; c.timer = this.rng.range(0.6, 1.2); break; }
          c.target = POSES.reach; c.speed = 7; c.phase = 'reach'; c.timer = this.rng.range(0.35, 0.6); break;
        case 'reach':
          c.target = POSES.grab; c.speed = 14; c.phase = 'grab'; c.timer = 0.14; break;
        case 'grab':
          c.target = POSES.mouth; c.speed = 6; c.phase = 'toMouth'; c.timer = this.rng.range(0.45, 0.7); break;
        case 'toMouth':
          c.phase = 'chew'; c.timer = this.rng.range(0.5, 1.4);
          if (this.env.onBite) this.env.onBite(this);
          break;
        case 'chew':
          c.target = POSES.rest; c.speed = 5; c.phase = 'idle'; c.timer = this.rng.range(0.3, 1.2); break;
      }
    }
  }

  // ---- 行動 ----
  setState(s, dur) {
    this.state = s;
    this.stateT = 0;
    this.stateDur = dur ?? 3;
  }

  think(dt) {
    const env = this.env;
    const rng = this.rng;
    this.stateT += dt;
    const night = env.night || 0;
    this.crouch = lerp(this.crouch || 0, this.state === 'hide' ? 1 : 0, 1 - Math.exp(-dt * 2));
    this.faceTarget = null;
    this.pitchAdd = 0;

    // 餌の匂い
    if (this.state !== 'flee' && this.state !== 'eat' && this.state !== 'toFood' && this.state !== 'startled' && env.foods) {
      const f = env.findFood(this);
      if (f && (this.stateT > 0.6 || this.state === 'idle')) {
        this.food = f;
        f.claimedBy = this;
        this.setState('toFood', 30);
        this.goToFood(3.6 + this.personality.activity * 1.5);
      }
    }

    switch (this.state) {
      case 'idle': {
        this.setClawsIfIdle();
        this.eyeTarget = 1;
        // 陸で乾いてくると口元に泡を吹くことがある
        if (this.submerged < 0.2 && this.wet < 0.6 && env.onFoam && rng.next() < dt * 0.035) env.onFoam(this);
        if (this.stateT > this.stateDur) this.chooseActivity();
        break;
      }
      case 'walk': {
        this.setClawsIfIdle('walk');
        if (!this.path) this.setState('idle', rng.range(1.5, 5));
        if (this.stateT > 40) { this.setPath(null); this.setState('idle', 2); }
        break;
      }
      case 'forage': {
        this.forageClaws(dt, false);
        this.pitchAdd = 0.12;
        if (this.stateT > this.stateDur) { this.setClaws('rest', 4); this.setState('idle', rng.range(1, 4)); }
        break;
      }
      case 'hide': case 'soak': case 'perch': {
        this.setClawsIfIdle(this.state === 'hide' ? 'tuck' : 'rest');
        if (this.state === 'hide' && this.hideFace && this.stateT < 3) this.faceTarget = this.hideFace;
        if (this.state === 'soak' && env.onBubble && rng.next() < dt * 0.6) env.onBubble(this);
        if (this.stateT > this.stateDur) this.setState('idle', rng.range(1, 3));
        break;
      }
      case 'toFood': {
        this.setClawsIfIdle('walk');
        if (!this.food || this.food.eaten || (this.food.heldBy && this.food.heldBy !== this)) {
          this.food = null; this.setPath(null); this.setState('idle', 1);
        } else if (!this.path) {
          if (this.stateT > this.stateDur) { this.food.claimedBy = null; this.food = null; this.setState('idle', 1); }
          // 餌が動いたら追い直す
          else if (this.stateT > 0.5) this.goToFood(3.6);
        }
        break;
      }
      case 'eat': {
        this.forageClaws(dt, true);
        if (this.food) this.faceTarget = null;
        this.pitchAdd = 0.08;
        if (!this.food || this.food.eaten || this.stateT > this.stateDur) {
          if (this.food) { this.food.heldBy = null; this.food.claimedBy = null; }
          this.food = null;
          this.setClaws('rest', 4);
          this.setState('idle', rng.range(2, 5));
        }
        break;
      }
      case 'startled': {
        this.eyeTarget = 0;
        this.setClaws('tuck', 12);
        if (this.stateT > this.stateDur) {
          if (rng.next() < 0.35 + this.personality.boldness * 0.4 && this.startle < 0.9) {
            this.setState('threat', rng.range(1.5, 3.2));
          } else {
            this.fleeToShelter();
          }
        }
        break;
      }
      case 'threat': {
        this.eyeTarget = 1;
        // 石の下ではハサミを振り上げられない
        const lowCeil = env.nav.ceilAt(this.pos.x, this.pos.z) - this.bodyY < 2.2 * this.scale;
        this.setClaws(lowCeil ? 'tuck' : 'threat', 8);
        this.pitchAdd = lowCeil ? 0 : -0.12;
        if (this.threatFrom) this.faceTarget = this.threatFrom;
        if (this.stateT > this.stateDur) { this.threatFrom = null; this.setClaws('rest', 4); this.setState('idle', rng.range(1, 3)); }
        break;
      }
      case 'flee': {
        this.eyeTarget = 0.6;
        this.setClawsIfIdle('tuck');
        if (!this.path) this.setState('hide', rng.range(8, 20));
        break;
      }
    }
    // 近すぎる相手には威嚇
    if (this.state === 'idle' || this.state === 'walk' || this.state === 'forage') {
      for (const o of env.crabs) {
        if (o === this) continue;
        const d = Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
        if (d < 2.6 * (this.scale + o.scale) * 0.5 && rng.next() < dt * 0.8) {
          this.threatFrom = [o.pos.x, o.pos.z];
          this.setPath(null);
          this.setState('threat', rng.range(1.2, 2.5));
          break;
        }
      }
    }
  }

  arriveFood() {
    const f = this.food;
    if (f && !f.eaten && Math.hypot(f.pos.x - this.pos.x, f.pos.z - this.pos.z) < 2.6 * this.scale + 0.9) {
      this.setState('eat', this.rng.range(18, 32));
      f.heldBy = this;
      this.holdClaw = this.rng.next() < 0.5 ? 0 : 1;
      for (const c of this.claws) { c.phase = 'idle'; c.timer = 0.1; }
    } else {
      // 餌が動いていないのに届かないなら、そこへは行けない
      const still = f && !f.eaten && Math.hypot(f.pos.x - this.foodGoal[0], f.pos.z - this.foodGoal[1]) < 0.5;
      this.giveUpFood(still);
    }
  }

  goToFood(speed) {
    const f = this.food;
    this.foodGoal = [f.pos.x, f.pos.z];
    // 道がない（登れない岩の上など）
    if (!this.goTo(f.pos.x, f.pos.z, speed, 'side', () => this.arriveFood())) this.giveUpFood(true);
  }

  // unreachable: 届かない餌として覚え、このカニはもう狙わない
  giveUpFood(unreachable = false) {
    const f = this.food;
    if (f) {
      f.claimedBy = null;
      if (unreachable) (f.unreachable || (f.unreachable = new Set())).add(this);
    }
    this.food = null;
    this.setPath(null);
    this.setState('idle', 1);
  }

  setClawsIfIdle(name = 'rest') {
    for (const c of this.claws) {
      if (c.target !== POSES[name]) { c.target = POSES[name]; c.speed = 4; }
      c.phase = 'idle';
    }
  }

  chooseActivity() {
    const env = this.env, rng = this.rng, nav = env.nav;
    const night = env.night || 0;
    const act = this.personality.activity * 0.6 + night * 0.6;
    const w = {
      wander: 2.0 + act * 2,
      forage: 1.5 + act,
      hide: 1.4 * (1 - night * 0.6) * (1.3 - this.personality.boldness),
      soak: 1.0 + this.personality.water * 1.5,
      idle: 1.0,
    };
    const pick = weighted(rng, w);
    const speed = rng.range(1.8, 3.2) * (0.8 + act * 0.4);
    if (pick === 'wander') {
      const p = nav.randomPoint(rng, (x, z) => Math.hypot(x - this.pos.x, z - this.pos.z) > 4 && Math.hypot(x - this.pos.x, z - this.pos.z) < 16);
      if (p && this.goTo(p[0], p[1], speed, rng.next() < 0.15 ? 'forward' : 'side')) { this.setState('walk', 40); return; }
    } else if (pick === 'forage') {
      const p = nav.randomPoint(rng, (x, z) => Math.hypot(x - this.pos.x, z - this.pos.z) < 10);
      if (p && this.goTo(p[0], p[1], speed * 0.8, 'side', () => { this.setState('forage', rng.range(4, 10)); for (const c of this.claws) { c.phase = 'idle'; c.timer = rng.range(0, 0.4); } })) {
        this.setState('walk', 40); return;
      }
    } else if (pick === 'hide') {
      const free = this.freeShelters();
      if (free.length && this.startHide(rng.pick(free), speed)) return;
    } else if (pick === 'soak') {
      const p = nav.randomPoint(rng, (x, z) => nav.groundAt(x, z) < WATER_LEVEL - 1.2);
      if (p && this.goTo(p[0], p[1], speed, 'side', () => this.setState('soak', rng.range(8, 25)))) { this.setState('walk', 40); return; }
    }
    this.setState('idle', rng.range(2, 7));
  }

  fleeToShelter() {
    let best = null, bd = 1e9;
    for (const s of this.freeShelters()) {
      const d = Math.hypot(s[0] - this.pos.x, s[1] - this.pos.z);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && this.startHide(best, 9, true)) return;
    // 空いている隠れ家がなければ、その場で身を縮める
    this.hideFace = null;
    this.setState('hide', this.rng.range(4, 8));
  }

  onStartle(strength, from) {
    if (this.state === 'flee') return;
    this.startle = strength;
    this.setPath(null);
    if (this.food) { this.food.heldBy = null; this.food.claimedBy = null; this.food = null; }
    this.threatFrom = from ? [from.x, from.z] : null;
    this.setState('startled', this.rng.range(0.15, 0.5));
    this.vel.multiplyScalar(0.2);
  }

  // ---- 毎フレーム ----
  update(dt) {
    this.time += dt;
    this.think(dt);
    this.steer(dt);
    this.checkStuck(dt);
    this.updateBody(dt);
    this.updateLegs(dt);
    this.applyIK();
    this.animateParts(dt);
  }

  // 口の位置（ワールド）
  mouthWorld(out = new THREE.Vector3()) {
    out.set(0, -0.25, 1.0);
    this.rig.root.localToWorld(out);
    return out;
  }
  clawTipWorld(i, out = new THREE.Vector3()) {
    const ch = this.rig.chelae[i];
    out.set(ch.sp.fingerL * 0.7, -0.05, 0);
    ch.bones.dact.localToWorld(out);
    return out;
  }
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function weighted(rng, w) {
  let tot = 0;
  for (const k in w) tot += w[k];
  let r = rng.next() * tot;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return Object.keys(w)[0];
}
