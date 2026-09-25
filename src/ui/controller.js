import * as THREE from 'three';
import { shared, TANK, WATER_LEVEL } from '../core/shared.js';
import { PALETTES } from '../crab/crabRig.js';
import { Soundscape } from './audio.js';
import { clamp, lerp } from '../core/rng.js';

const STATE_LABEL = {
  idle: 'じっとしている', walk: '歩いている', forage: '餌を探している', hide: '石の下に隠れている',
  soak: '水に浸かっている', toFood: '餌に向かっている', eat: '食べている', startled: 'びっくり',
  threat: 'はさみを振り上げている', flee: '逃げている', perch: '石の上で休んでいる',
};
const STATE_KIND = { startled: 'warn', threat: 'warn', flee: 'warn', soak: 'calm', hide: 'calm' };
const MORPH = { brown: '茶系', red: '赤系', blue: '青系' };

const toHex = (lin) => '#' + new THREE.Color(lin[0], lin[1], lin[2]).getHexString();

export class Controller {
  constructor(world) {
    this.world = world;
    this.env = world.env;
    this.camera = world.camera;
    this.controls = world.controls;
    this.post = world.post;
    this.sound = new Soundscape();
    this.camMode = 'free';
    this.followIdx = 0;
    this.lightTarget = 0;
    this.night = 0;
    this.feedMode = false;
    this.fly = null;
    this.shake = 0;
    this.autoShot = null;
    this.hintTimer = 0;
    this.lastInteract = performance.now();
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this.$ = (id) => document.getElementById(id);
    this.buildRoster();
    this.bind();
    this.gaugeT = 0;
  }

  // ---- 名札 ----
  buildRoster() {
    const roster = this.$('roster');
    roster.innerHTML = '';
    this.cards = this.world.crabs.map((c, i) => {
      const p = PALETTES[c.paletteKey];
      const b = document.createElement('button');
      b.className = 'crab-card glass';
      b.setAttribute('aria-pressed', 'false');
      b.id = 'crab-card-' + i;
      b.innerHTML = `
        <span class="swatch" style="background:${toHex(p.carapace)};--c2:${toHex(p.leg)}"></span>
        <span class="crab-name">${c.name}</span>
        <span class="crab-meta">${c.sex === 'male' ? 'オス' : 'メス'}・${MORPH[c.paletteKey]}・甲幅 ${(c.scale * 2.6).toFixed(1)}cm</span>
        <span class="crab-state"><i></i><span class="st">—</span></span>`;
      b.addEventListener('click', () => this.follow(i));
      roster.appendChild(b);
      return { el: b, st: b.querySelector('.st'), dot: b.querySelector('.crab-state i'), last: '' };
    });
  }

  updateRoster() {
    this.world.crabs.forEach((c, i) => {
      const card = this.cards[i];
      let s = STATE_LABEL[c.state] || c.state;
      if (c.submerged > 0.6 && c.state !== 'soak') s += '（水中）';
      if (card.last !== s) {
        card.st.textContent = s;
        card.dot.className = STATE_KIND[c.state] || '';
        card.last = s;
      }
      card.el.setAttribute('aria-pressed', this.camMode === 'follow' && this.followIdx === i ? 'true' : 'false');
    });
  }

  hint(text, ms = 3200) {
    const h = this.$('hint');
    h.textContent = text;
    h.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => h.classList.remove('show'), ms);
  }

  // ---- 操作 ----
  bind() {
    const $ = this.$;
    $('btn-feed').addEventListener('click', () => this.setFeed(!this.feedMode));
    $('btn-tap').addEventListener('click', () => this.tapGlass());
    $('btn-day').addEventListener('click', () => this.setLight('day'));
    $('btn-night').addEventListener('click', () => this.setLight('night'));
    $('btn-cam').addEventListener('click', () => this.cycleCamera());
    $('btn-sound').addEventListener('click', () => this.toggleSound());
    $('btn-info').addEventListener('click', () => this.toggleInfo());
    $('btn-info-close').addEventListener('click', () => this.toggleInfo(false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.setFeed(false); this.toggleInfo(false); }
      if (e.target.tagName === 'INPUT') return;
      if (e.key === 'f' || e.key === 'F') this.setFeed(!this.feedMode);
      if (e.key === 't' || e.key === 'T') this.tapGlass();
      if (e.key === 'n' || e.key === 'N') this.setLight(this.lightTarget > 0.5 ? 'day' : 'night');
      if (e.key === 'c' || e.key === 'C') this.cycleCamera();
    });
    const canvas = this.world.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      this.lastInteract = performance.now();
      if (this.camMode === 'auto') this.setCamMode('free');
      this.fly = null;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved < 6 && dt < 500) this.click(e.clientX, e.clientY);
    });
    this.controls.addEventListener('start', () => { this.lastInteract = performance.now(); this.fly = null; });
    const touch = () => { this.lastInteract = performance.now(); };
    window.addEventListener('pointerdown', touch, { passive: true });
    window.addEventListener('keydown', touch);
    window.addEventListener('wheel', touch, { passive: true });
  }

  ray(clientX, clientY) {
    const r = this.world.renderer.domElement.getBoundingClientRect();
    this._ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    return this._raycaster.ray;
  }

  // 地形の高さマップに沿ってレイを進める
  pickGround(ray) {
    const nav = this.env.nav;
    const p = new THREE.Vector3();
    // 水槽の上面付近から始める
    let t0 = 0;
    const o = ray.origin, d = ray.direction;
    if (o.y > TANK.h && d.y < 0) t0 = (o.y - TANK.h) / -d.y;
    for (let t = t0; t < t0 + 250; t += 0.12) {
      p.copy(o).addScaledVector(d, t);
      if (p.x < TANK.ix0 || p.x > TANK.ix1 || p.z < TANK.iz0 || p.z > TANK.iz1) {
        if (t > t0 + 5) {
          // 水槽外へ抜けた
          const inside = p.x > TANK.ix0 - 30 && p.x < TANK.ix1 + 30;
          if (!inside) return null;
        }
        continue;
      }
      if (p.y <= Math.max(nav.groundAt(p.x, p.z), WATER_LEVEL)) return p.clone();
      if (p.y < -2) return null;
    }
    return null;
  }

  click(x, y) {
    const ray = this.ray(x, y);
    // カニを選ぶ
    let best = -1, bd = 1e9;
    this.world.crabs.forEach((c, i) => {
      const center = new THREE.Vector3(c.pos.x, c.bodyY, c.pos.z);
      const d = ray.distanceToPoint(center);
      const along = center.clone().sub(ray.origin).dot(ray.direction);
      if (d < 2.4 * c.scale && along > 0 && along < bd) { bd = along; best = i; }
    });
    if (this.feedMode) {
      const p = this.pickGround(ray);
      if (!p) { this.hint('水槽の中をクリックしてください'); return; }
      // どのカニも届かない餌（やがて消える）は数えない
      const alive = this.env.foods.items.filter((f) => !f.eaten && !f.abandoned).length;
      if (alive >= 5) { this.hint('えさが残っています。食べ終わるまで待ちましょう'); return; }
      this.env.foods.drop(p.x, p.z);
      this.hint('えさの匂いに気づくと、カニが寄ってきます');
      return;
    }
    if (best >= 0) this.follow(best);
  }

  setFeed(on) {
    this.feedMode = on;
    this.$('btn-feed').setAttribute('aria-pressed', on ? 'true' : 'false');
    document.getElementById('app').classList.toggle('feeding', on);
    if (on) this.hint('水槽の中をクリックすると、そこにえさが落ちます', 4200);
  }

  tapGlass() {
    const env = this.env;
    this.shake = 0.35;
    for (const c of this.world.crabs) {
      const dz = TANK.iz1 - c.pos.z;
      const strength = clamp(1.1 - dz / 30, 0.3, 1);
      c.onStartle(strength, new THREE.Vector3(c.pos.x, 0, TANK.iz1 + 5));
    }
    if (env.ripple) {
      for (let x = -8; x <= 19; x += 1.5) env.ripple.addDrop(x, TANK.iz1 - 0.3, 0.3, 0.01);
    }
    this.sound.tap();
    this.hint('トントン。カニたちが驚いています');
  }

  setLight(mode) {
    this.lightTarget = mode === 'night' ? 1 : 0;
    this.$('btn-day').setAttribute('aria-pressed', mode === 'day' ? 'true' : 'false');
    this.$('btn-night').setAttribute('aria-pressed', mode === 'night' ? 'true' : 'false');
    if (mode === 'night') this.hint('夜になると、サワガニは活発に歩き回ります');
  }

  async toggleSound() {
    const b = this.$('btn-sound');
    if (this.sound.on) { this.sound.disable(); b.setAttribute('aria-pressed', 'false'); }
    else {
      try { await this.sound.enable(); b.setAttribute('aria-pressed', 'true'); this.hint('滝の水音を再生しています'); }
      catch { this.hint('この環境では音を再生できません'); }
    }
  }

  toggleInfo(force) {
    const el = this.$('info');
    const show = force ?? el.hidden;
    el.hidden = !show;
    this.$('btn-info').setAttribute('aria-pressed', show ? 'true' : 'false');
  }

  // ---- カメラ ----
  cycleCamera() {
    if (this.camMode === 'free') this.follow(this.followIdx);
    else if (this.camMode === 'follow') this.setCamMode('auto');
    else this.setCamMode('free');
  }

  setCamMode(m) {
    this.camMode = m;
    const label = { free: '自由視点', follow: '追いかける', auto: '自動' }[m];
    this.$('cam-label').textContent = label;
    if (m !== 'follow') this.post.params.focusOverride = -1;
    if (m === 'auto') { this.autoShot = null; this.hint('自動カメラ。画面に触れると自由視点に戻ります'); }
    this.lastInteract = performance.now();
    if (m === 'free') this.fly = null;
    this.updateRoster();
  }

  follow(i) {
    this.followIdx = i;
    this.setCamMode('follow');
    const c = this.world.crabs[i];
    const target = new THREE.Vector3(c.pos.x, c.bodyY, c.pos.z);
    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-3) dir.set(0, 0, 1);
    dir.normalize();
    if (dir.z < 0.2) { dir.z = 0.2; dir.normalize(); }
    dir.multiplyScalar(Math.cos(0.62)).setY(Math.sin(0.62));
    const to = target.clone().addScaledVector(dir, 14);
    // 前面ガラスより内側に入らない
    this.fly = { fromP: this.camera.position.clone(), fromT: this.controls.target.clone(), toP: to, t: 0, dur: 1.4 };
    this.hint(`${c.name} を追いかけています`);
  }

  updateCamera(dt, time) {
    const cam = this.camera, ctl = this.controls;
    if (this.camMode === 'follow') {
      const c = this.world.crabs[this.followIdx];
      const target = new THREE.Vector3(c.pos.x, c.bodyY, c.pos.z);
      if (this.fly) {
        const f = this.fly;
        f.t = Math.min(1, f.t + dt / f.dur);
        const e = f.t * f.t * (3 - 2 * f.t);
        const toP = f.toP.clone().add(target).sub(f.toT || (f.toT = target.clone()));
        cam.position.lerpVectors(f.fromP, toP, e);
        ctl.target.lerpVectors(f.fromT, target, e);
        if (f.t >= 1) this.fly = null;
      } else {
        const delta = target.clone().sub(ctl.target).multiplyScalar(1 - Math.exp(-dt * 4));
        ctl.target.add(delta);
        cam.position.add(delta);
      }
      this.post.params.focusOverride = cam.position.distanceTo(target);
    } else if (this.camMode === 'auto') {
      this.updateAuto(dt, time);
    }
    // 画面の揺れ（トントン）
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.25;
      cam.position.x += Math.sin(time * 90) * a;
      cam.position.y += Math.cos(time * 77) * a * 0.6;
    }
  }

  updateAuto(dt, time) {
    const cam = this.camera, ctl = this.controls;
    const crabs = this.world.crabs;
    if (!this.autoShot || this.autoShot.t > this.autoShot.dur) {
      const kinds = ['orbit', 'crab', 'crab', 'fall', 'shelter'];
      const k = kinds[Math.floor(Math.random() * kinds.length)];
      const shot = { kind: k, t: 0, dur: k === 'crab' ? 14 : 12, fromP: cam.position.clone(), fromT: ctl.target.clone(), ph: Math.random() * 6.28 };
      if (k === 'crab') shot.crab = Math.floor(Math.random() * crabs.length);
      this.autoShot = shot;
    }
    const s = this.autoShot;
    s.t += dt;
    let P = new THREE.Vector3(), T = new THREE.Vector3();
    const u = s.t / s.dur;
    if (s.kind === 'orbit') {
      const a = s.ph + u * 0.5;
      P.set(Math.sin(a) * 58, 22 + Math.sin(u * 3) * 3, Math.cos(a) * 58 * 0.9 + 12);
      P.z = Math.max(P.z, 30);
      T.set(0, 7, 0);
    } else if (s.kind === 'crab') {
      const c = crabs[s.crab];
      T.set(c.pos.x, c.bodyY, c.pos.z);
      const a = s.ph + u * 0.6;
      // 前面ガラスの外から、ゆっくり横へ流しながら狙う
      P.set(T.x + Math.sin(a) * 7, T.y + 5 + u * 1.5, Math.max(T.z + 11, TANK.iz1 + 5.5));
      this.post.params.focusOverride = P.distanceTo(T);
    } else if (s.kind === 'fall') {
      const b = this.world.waterfall ? this.world.waterfall.base : new THREE.Vector3(12, 5, -5);
      T.set(b.x - 1, b.y + 2.5, b.z);
      P.set(b.x - 6 + u * 4, 8 + u * 1.5, 22);
    } else {
      T.set(-11, 6.5, 4);
      P.set(-16 + u * 8, 8.5, 24);
    }
    if (s.kind !== 'crab') this.post.params.focusOverride = -1;
    // 水槽の中にはカメラを入れない
    if (P.x > TANK.ix0 - 2 && P.x < TANK.ix1 + 2 && P.z < TANK.iz1 + 4 && P.y < TANK.h + 2) P.z = TANK.iz1 + 4;
    // 入りの補間
    const e = Math.min(1, s.t / 2.5);
    const ee = e * e * (3 - 2 * e);
    cam.position.lerpVectors(s.fromP, P, ee);
    ctl.target.lerpVectors(s.fromT, T, ee);
    if (e >= 1) { cam.position.copy(P); ctl.target.copy(T); }
  }

  // ---- 照明 ----
  updateLight(dt) {
    const w = this.world;
    const k = 1 - Math.exp(-dt * 1.3);
    this.night = lerp(this.night, this.lightTarget, k);
    if (Math.abs(this.night - this.lightTarget) < 0.002) this.night = this.lightTarget;
    const n = this.night;
    const d = 1 - n;
    w.tank.led.intensity = 19000 * d;
    w.tank.ledPanelMat.color.setScalar(18 * d + 0.05);
    w.tank.moon.intensity = 9000 * n;
    w.tank.moonPanelMat.color.setRGB(0.45 * 7 * n, 0.6 * 7 * n, 7 * n);
    w.room.windowLight.intensity = 0.9 * d + 0.02;
    w.room.win.material.color.setRGB(3.2 * d + 0.05, 3.1 * d + 0.07, 3.0 * d + 0.12);
    w.room.lampLight.intensity = 900 * n;
    w.room.lampShadeMat.emissiveIntensity = 1.6 * n;
    const envTex = n > 0.5 ? w.envNight : w.envDay;
    if (w.scene.environment !== envTex) w.scene.environment = envTex;
    w.scene.environmentIntensity = lerp(0.38, 0.9, n);
    this.post.params.exposure = lerp(1.0, 2.6, n);
    this.post.params.bloomStrength = lerp(0.045, 0.07, n);
    this.post.params.warmth = lerp(0.0, -0.4, n);
    shared.uCaustic.value = lerp(1, 0.55, n);
    shared.uCausticLight.value.setRGB(lerp(1, 0.25, n), lerp(1, 0.4, n), lerp(1, 0.9, n));
    if (w.waterfall) w.waterfall.uniforms.uLight.value = lerp(1, 0.25, n);
    w.tank.glassMat.userData.glassU.uLightI.value = lerp(1, 0.3, n);
    this.env.night = n;
  }

  updateGauges(dt, time) {
    this.gaugeT -= dt;
    if (this.gaugeT > 0) return;
    this.gaugeT = 1;
    const temp = 19.4 + 0.35 * Math.sin(time / 90) + 0.5 * (1 - this.night);
    const hum = 84 + 3 * Math.sin(time / 70 + 1) - 2 * (1 - this.night);
    this.$('g-temp').textContent = temp.toFixed(1);
    this.$('g-hum').textContent = Math.round(hum);
    this.$('g-light').textContent = this.night > 0.5 ? '月光' : 'LED';
    this.updateRoster();
  }

  update(dt, time) {
    // しばらく操作がなければ自動カメラへ
    if (this.camMode === 'free' && !this.feedMode && performance.now() - this.lastInteract > 45000) {
      this.setCamMode('auto');
    }
    this.updateLight(dt);
    this.updateCamera(dt, time);
    this.updateGauges(dt, time);
  }
}
