import * as THREE from 'three';
import { WATER_LEVEL, LAYER_FX, waterFxPatch } from '../core/shared.js';
import { clamp } from '../core/rng.js';

// ---- 餌 ----
export class Foods {
  constructor(scene, env) {
    this.scene = scene;
    this.env = env;
    this.items = [];
    this.geo = new THREE.CapsuleGeometry(0.11, 0.22, 4, 10);
    this.mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.16, 0.06), roughness: 0.75 });
    waterFxPatch(this.mat, { wetHeight: 0.2, wetDarken: 0.35, wetGloss: 0.6 });
  }

  drop(x, z) {
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const f = {
      mesh, pos: new THREE.Vector3(x, 27, z), vel: new THREE.Vector3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3),
      spin: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      state: 'air', amount: 1, restT: 0, heldBy: null, claimedBy: null, eaten: false,
    };
    mesh.position.copy(f.pos);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(mesh);
    this.items.push(f);
    return f;
  }

  update(dt) {
    const nav = this.env.nav;
    for (const f of this.items) {
      if (f.eaten) continue;
      if (f.heldBy) {
        const c = f.heldBy;
        const tip = c.clawTipWorld(c.holdClaw ?? 0, new THREE.Vector3());
        const mouth = c.mouthWorld(new THREE.Vector3());
        f.pos.lerpVectors(tip, mouth, 0.35);
        f.mesh.position.copy(f.pos);
        f.mesh.quaternion.copy(c.group.quaternion);
        f.state = 'held';
        continue;
      }
      const g = nav.groundAt(f.pos.x, f.pos.z) + 0.1;
      if (f.state === 'air') {
        f.vel.y -= 420 * dt;
        f.pos.addScaledVector(f.vel, dt);
        f.mesh.rotation.x += f.spin.x * dt; f.mesh.rotation.y += f.spin.y * dt;
        if (f.pos.y <= WATER_LEVEL && g < WATER_LEVEL) {
          f.state = 'water';
          f.pos.y = WATER_LEVEL;
          f.vel.set(f.vel.x * 0.1, -2.2, f.vel.z * 0.1);
          if (this.env.ripple) this.env.ripple.addDrop(f.pos.x, f.pos.z, 0.25, 0.05);
          if (this.env.onSplash) this.env.onSplash(f.pos);
        } else if (f.pos.y <= g) {
          f.pos.y = g;
          f.state = 'rest';
          f.mesh.rotation.set(Math.PI / 2, Math.random() * 6, 0);
        }
      } else if (f.state === 'water') {
        f.pos.addScaledVector(f.vel, dt);
        f.pos.x += Math.sin(f.restT * 3) * 0.02 * dt;
        f.restT += dt;
        f.mesh.rotation.x += dt * 0.8;
        if (f.pos.y <= g) { f.pos.y = g; f.state = 'rest'; f.restT = 0; f.mesh.rotation.set(Math.PI / 2, Math.random() * 6, 0); }
      } else if (f.state === 'rest' || f.state === 'held') {
        if (f.state === 'held') { f.state = 'rest'; f.mesh.rotation.set(Math.PI / 2, Math.random() * 6, 0); }
        f.restT += dt;
        f.pos.y = g;
      }
      f.mesh.position.copy(f.pos);
    }
    this.items = this.items.filter((f) => !f.eaten || f.mesh.parent);
  }

  // 近くの餌（到着済み・未確保）
  find(crab) {
    let best = null, bd = 1e9;
    for (const f of this.items) {
      if (f.eaten || f.state === 'air' || f.heldBy) continue;
      if (f.state === 'rest' && f.restT < 0.8) continue;
      if (f.claimedBy && f.claimedBy !== crab) continue;
      const d = Math.hypot(f.pos.x - crab.pos.x, f.pos.z - crab.pos.z);
      if (d < 24 && d < bd) { bd = d; best = f; }
    }
    return best;
  }

  bite(crab) {
    const f = crab.food;
    if (!f || f.heldBy !== crab) return;
    f.amount -= 0.075;
    const s = Math.cbrt(Math.max(f.amount, 0.01));
    f.mesh.scale.setScalar(s);
    if (f.amount <= 0.05) {
      f.eaten = true;
      f.heldBy = null;
      this.scene.remove(f.mesh);
    }
  }
}

// ---- 口元の泡（陸にいるサワガニが吹く） ----
export class Foam {
  constructor(bubbles) {
    this.bubbles = bubbles;
    this.items = [];
  }
  start(crab) {
    if (this.items.some((f) => f.crab === crab)) return;
    const n = 7 + Math.floor(Math.random() * 7);
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        off: new THREE.Vector3((Math.random() - 0.5) * 0.5, (Math.random() - 0.3) * 0.25, Math.random() * 0.2),
        r: 0.025 + Math.random() * 0.05, t0: Math.random() * 2.5, life: 3 + Math.random() * 4,
      });
    }
    this.items.push({ crab, parts, t: 0 });
  }
  // Bubbles のインスタンスへ書き込む
  write(mesh, m4, n0, dt) {
    let n = n0;
    const alive = [];
    const q = new THREE.Quaternion();
    for (const f of this.items) {
      f.t += dt;
      const c = f.crab;
      if (c.submerged > 0.5 || f.t > 9) continue;
      alive.push(f);
      const mouth = c.mouthWorld(new THREE.Vector3());
      q.setFromEuler(new THREE.Euler(0, c.heading, 0));
      for (const p of f.parts) {
        const age = f.t - p.t0;
        if (age < 0 || age > p.life) continue;
        const grow = Math.min(1, age / 0.6) * (1 - Math.max(0, (age - p.life + 0.3) / 0.3));
        const r = p.r * grow * c.scale;
        if (r <= 0.001 || n >= mesh.instanceMatrix.count) continue;
        const pos = p.off.clone().multiplyScalar(c.scale).applyQuaternion(q).add(mouth);
        m4.makeScale(r, r, r).setPosition(pos);
        mesh.setMatrixAt(n++, m4);
      }
    }
    this.items = alive;
    return n;
  }
}

// ---- 泡 ----
export class Bubbles {
  constructor(scene, env, max = 160) {
    this.env = env;
    this.max = max;
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          float rim = pow(f, 2.5);
          vec3 L = normalize(vec3(0.2, 1.0, 0.1));
          float spec = pow(max(dot(reflect(-L, normalize(vN)), vV), 0.0), 60.0);
          vec3 c = vec3(0.85, 0.95, 1.0) * (rim * 0.9 + spec * 3.0);
          gl_FragColor = vec4(c, clamp(rim * 0.75 + spec, 0.0, 1.0));
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.layers.set(LAYER_FX);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
    this.items = [];
    this.m4 = new THREE.Matrix4();
    this.foam = new Foam(this);
  }

  emit(pos, r = 0.05, vy = 5) {
    if (this.items.length >= this.max) return;
    this.items.push({ p: pos.clone(), r, vy, t: 0, ph: Math.random() * 6 });
  }

  update(dt) {
    let n = 0;
    const alive = [];
    for (const b of this.items) {
      b.t += dt;
      b.p.y += b.vy * dt;
      b.p.x += Math.sin(b.t * 9 + b.ph) * 0.03;
      b.p.z += Math.cos(b.t * 7 + b.ph) * 0.03;
      if (b.p.y >= WATER_LEVEL - b.r * 0.5) {
        if (this.env.ripple) this.env.ripple.addDrop(b.p.x, b.p.z, 0.08, 0.002 + b.r * 0.02);
        continue;
      }
      alive.push(b);
      this.m4.makeScale(b.r, b.r * 0.9, b.r).setPosition(b.p);
      this.mesh.setMatrixAt(n++, this.m4);
    }
    this.items = alive;
    if (this.foam) n = this.foam.write(this.mesh, this.m4, n, dt);
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
