// 隠し機能: デスクライトの下に転がっている Clawd の置物。
// 押すと水槽のカニたちが Clawd になり、置物のほうはサワガニに入れ替わる。もう一度押すと元に戻る
import * as THREE from 'three';
import { buildClawd } from '../crab/clawd.js';
import { CrabRig, PALETTES } from '../crab/crabRig.js';

const D2R = Math.PI / 180;
const FIG_U = 0.056; // 置物の Clawd: SVG 1 単位あたりの長さ（胴の幅が約 5）
const CRAB_S = 1.25; // 置物の位置にいるサワガニの大きさ
const SWAP = 0.42; // 入れ替わりにかかる秒数

// 足元に敷く、ぼんやりした接地の影
function blobShadow(w, d) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  m.renderOrder = 1;
  return m;
}

export class DeskToy {
  // pos: 天板の上の置き場所、yaw: 向き（正面がカメラのほうを向くように）
  constructor(scene, parts, { x, y, z, yaw = 0 }) {
    this.group = new THREE.Group();
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.group.name = 'desk-toy';
    scene.add(this.group);

    // --- Clawd: 頭を左にして仰向けにごろん。正面（顔）をこちらへ少し傾け、両腕はバンザイ ---
    const fig = buildClawd({ water: false });
    fig.arms[-1].rotation.set(0, 0, -34 * D2R);
    fig.arms[1].rotation.set(0, 0, 28 * D2R);
    fig.legs.forEach((l, i) => l.pivot.rotation.set(0, 0, (i % 2 ? 1 : -1) * 7 * D2R));
    fig.group.scale.setScalar(FIG_U);
    // 顔を上に向け（x -90°）、頭を左へ（y 90°）、頭の軸まわりに顔をこちらへ少し起こす（x 14°）
    const faceUp = new THREE.Group();
    faceUp.rotation.x = -Math.PI / 2;
    faceUp.add(fig.group);
    const headLeft = new THREE.Group();
    headLeft.rotation.y = Math.PI / 2;
    headLeft.add(faceUp);
    const lie = new THREE.Group();
    lie.rotation.x = 14 * D2R;
    lie.add(headLeft);
    this.clawd = this.holder(lie, 8, 6);

    // --- サワガニ: 脚を広げて天板に立つ（水の表現はなし） ---
    const rig = new CrabRig(parts, { sex: 'male', palette: PALETTES.brown, water: false });
    const H = 0.62;
    rig.root.position.set(0, H, 0);
    const up = new THREE.Vector3(0, 1, 0);
    rig.root.updateMatrixWorld(true);
    for (const leg of rig.legs) {
      const r = [0, 2.4, 2.7, 2.65, 2.3][leg.n];
      const dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(up, leg.theta);
      rig.solveLeg(leg, leg.attach.clone().addScaledVector(dir, r).setY(-H));
    }
    rig.mesh.scale.setScalar(CRAB_S);
    rig.mesh.rotation.y = -20 * D2R;
    this.crab = this.holder(rig.mesh, 8, 6);
    this.crab.visible = false;
    this.rig = rig;
    this.fig = fig;

    this.on = false; // true: 置物がサワガニ（水槽は Clawd）
    this.t = 1;
    this.box = new THREE.Box3();
    this.time = 0;
  }

  // 天板に接するように高さを合わせ、影を敷いた入れ物にまとめる
  holder(obj, sw, sd) {
    const h = new THREE.Group();
    h.add(obj);
    this.group.add(h);
    this.group.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    obj.position.y += this.group.position.y - b.min.y;
    h.add(blobShadow(sw, sd));
    return h;
  }

  set(on, animate = true) {
    if (on === this.on) return;
    this.on = on;
    this.t = animate ? 0 : 1;
    if (!animate) this.apply(1);
  }

  // 前半で今の置物がつぶれて消え、後半でもう一方がぽんと出てくる
  apply(t) {
    const from = this.on ? this.clawd : this.crab;
    const to = this.on ? this.crab : this.clawd;
    if (t < 0.5) {
      const k = t / 0.5;
      from.visible = true; to.visible = false;
      const sy = 1 - k * k;
      from.scale.set(1 + 0.35 * k, Math.max(sy, 0.001), 1 + 0.35 * k);
    } else {
      const k = (t - 0.5) / 0.5;
      from.visible = false; to.visible = true;
      // 少し行き過ぎてから落ち着く
      const s = 1 + Math.sin(k * Math.PI) * 0.18 * (1 - k);
      const e = 1 - Math.pow(1 - k, 3);
      to.scale.set(e * s, Math.max(e * s * (1 + 0.15 * Math.sin(k * Math.PI)), 0.001), e * s);
    }
    if (t >= 1) { from.scale.set(1, 1, 1); to.scale.set(1, 1, 1); }
  }

  update(dt) {
    this.time += dt;
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / SWAP);
      this.apply(this.t);
    }
    // サワガニはときどき眼柄と顎脚を動かす
    if (this.crab.visible) {
      const w = Math.sin(this.time * 0.7) * 0.05;
      for (const e of this.rig.eyes) e.bone.rotation.set(0.22 + w, 0, -0.14 * e.side);
      for (const m of this.rig.maxillipeds) m.bone.rotation.set(-0.35 + Math.sin(this.time * 3 + m.side) * 0.12, 0, 0);
    }
  }

  // クリック判定（置物のまわりの箱）
  hit(ray) {
    const obj = this.on ? this.crab : this.clawd;
    this.box.setFromObject(obj.children[0]).expandByScalar(0.6);
    return ray.intersectsBox(this.box);
  }
}
