import * as THREE from 'three';
import { addPatch, worldPosPatch } from '../core/shared.js';

// 水槽を置いた部屋（背景・映り込み・環境光の元）
const DESK_Y = -0.8; // 天板上面

function woodPatch(mat) {
  worldPosPatch(mat);
  return addPatch(mat, {
    key: 'wood-desk',
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      {
        vec3 p = vWPos;
        float plank = floor((p.z + 200.0) / 16.0);
        float ph = hash11(plank * 1.37 + 0.2);
        float lz = (p.z + 200.0) - plank * 16.0;
        float warp = fbm3v(vec3(p.x * 0.012 + ph * 7.0, 0.0, lz * 0.05)) * 6.0;
        float rings = fract(lz * 0.55 + warp + p.x * 0.004);
        float fine = vnoise3(vec3(p.x * 0.35, 0.0, lz * 9.0));
        vec3 light = vec3(0.30, 0.16, 0.075);
        vec3 dark = vec3(0.13, 0.062, 0.028);
        vec3 c = mix(light, dark, smoothstep(0.15, 0.95, rings) * 0.75 + fine * 0.25);
        c *= 0.8 + 0.4 * ph;
        float seam = smoothstep(0.0, 0.12, lz) * smoothstep(16.0, 15.88, lz);
        c *= mix(0.45, 1.0, seam);
        diffuseColor.rgb = c;
      }`],
      ['#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = 0.42 + 0.2 * vnoise3(vWPos * vec3(0.3, 0.3, 3.0));`]],
  });
}

function plasterPatch(mat, base) {
  worldPosPatch(mat);
  return addPatch(mat, {
    key: 'plaster',
    uniforms: { uBase: { value: base } },
    fragmentHead: 'uniform vec3 uBase;',
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      {
        float n = fbm3v(vWPos * 0.08) * 0.5 + vnoise3(vWPos * 1.3) * 0.12;
        diffuseColor.rgb = uBase * (0.92 + n * 0.16);
      }`]],
  });
}

export function buildRoom(scene) {
  const group = new THREE.Group();
  group.name = 'room';

  // 机
  const deskMat = woodPatch(new THREE.MeshStandardMaterial({ color: 0x5a3a24, roughness: 0.5 }));
  const desk = new THREE.Mesh(new THREE.BoxGeometry(170, 4, 80), deskMat);
  desk.position.set(0, DESK_Y - 2, 14);
  desk.receiveShadow = true;
  group.add(desk);

  // 水槽マット
  const mat = new THREE.Mesh(
    new THREE.BoxGeometry(41, 0.3, 26),
    new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.85 })
  );
  mat.position.set(0, DESK_Y + 0.15, 0);
  mat.receiveShadow = true;
  group.add(mat);

  // 壁・床・天井
  const wallMat = plasterPatch(new THREE.MeshStandardMaterial({ roughness: 0.95 }), new THREE.Color(0x8f877c));
  const back = new THREE.Mesh(new THREE.PlaneGeometry(400, 300), wallMat);
  back.position.set(0, 70, -48);
  group.add(back);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-130, 70, 60);
  group.add(left);
  const right = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), wallMat);
  right.rotation.y = -Math.PI / 2;
  right.position.set(150, 70, 60);
  group.add(right);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.7 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, -76, 60);
  group.add(floor);

  // 窓（左手前）
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 110),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.98, 0.95).multiplyScalar(3.2) })
  );
  win.rotation.y = Math.PI / 2;
  win.position.set(-129.5, 55, 55);
  group.add(win);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.6 });
  for (const [w, h, y, z] of [[4, 118, 55, 55 - 47], [4, 118, 55, 55 + 47], [4, 98, 55, 55], [0, 0, 0, 0]]) {
    if (!w) continue;
    const f = new THREE.Mesh(new THREE.BoxGeometry(3, h, w), frameMat);
    f.position.set(-128.5, y, z);
    group.add(f);
  }
  const sill = new THREE.Mesh(new THREE.BoxGeometry(8, 3, 100), frameMat);
  sill.position.set(-127, -3, 55);
  group.add(sill);

  // 背面の棚と小物（ボケて映る）
  const shelfMat = woodPatch(new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.5 }));
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(90, 2.5, 22), shelfMat);
  shelf.position.set(18, 42, -36);
  group.add(shelf);
  const bookColors = [0x2f4a5c, 0x8a3b2a, 0xc9b58f, 0x3e5a3a, 0x6b5a8a, 0xd8d0c0, 0x303030, 0xa0522d];
  let bx = -18;
  for (let i = 0; i < 11; i++) {
    const w = 2 + (i * 37 % 5) * 0.6;
    const h = 20 + (i * 53 % 9) * 1.2;
    const book = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 15),
      new THREE.MeshStandardMaterial({ color: bookColors[i % bookColors.length], roughness: 0.7 })
    );
    book.position.set(bx + w / 2, 43.25 + h / 2, -36);
    if (i === 10) { book.rotation.z = -0.25; book.position.x += 2; }
    bx += w + 0.3;
    group.add(book);
  }
  // 陶器の鉢と観葉植物
  const potProfile = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    potProfile.push(new THREE.Vector2(6.5 + 2.2 * t + Math.sin(t * Math.PI) * 0.8, t * 13));
  }
  potProfile.push(new THREE.Vector2(8.2, 13));
  const pot = new THREE.Mesh(new THREE.LatheGeometry(potProfile, 40), new THREE.MeshStandardMaterial({ color: 0xd9d2c5, roughness: 0.35 }));
  pot.position.set(50, 43.25, -36);
  group.add(pot);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f5a22, roughness: 0.5, side: THREE.DoubleSide });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + i * 0.7;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), leafMat);
    leaf.scale.set(5, 0.4, 2.2);
    leaf.position.set(50 + Math.cos(a) * 6, 60 + (i % 4) * 3.5, -36 + Math.sin(a) * 6);
    leaf.rotation.set(0.3 * Math.sin(i), -a, 0.5 + 0.2 * Math.cos(i * 3));
    group.add(leaf);
  }

  // 机の奥のランプ（夜に灯る）
  const lampShadeMat = new THREE.MeshStandardMaterial({ color: 0xf2e6d0, roughness: 0.6, emissive: new THREE.Color(1.0, 0.72, 0.42), emissiveIntensity: 0 });
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 12, 32, 1, true), lampShadeMat);
  shade.position.set(-52, 26, -30);
  group.add(shade);
  const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 26, 12), new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: 0.4, metalness: 0.6 }));
  lampBase.position.set(-52, 12.5, -30);
  group.add(lampBase);
  const lampFoot = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.5, 1.2, 32), lampBase.material);
  lampFoot.position.set(-52, DESK_Y + 0.6, -30);
  group.add(lampFoot);
  const lampLight = new THREE.PointLight(0xffb070, 0, 0, 2);
  lampLight.position.set(-52, 24, -30);
  lampLight.layers.enableAll();
  group.add(lampLight);

  group.traverse((o) => {
    if (o.isMesh && o !== desk && o !== mat) o.receiveShadow = false;
  });
  scene.add(group);

  // 窓からの光
  const windowLight = new THREE.DirectionalLight(0xfff4e8, 0.9);
  windowLight.position.set(-80, 60, 70);
  windowLight.target.position.set(0, 5, 0);
  windowLight.layers.enableAll();
  scene.add(windowLight, windowLight.target);

  return { group, windowLight, lampLight, lampShadeMat, win, DESK_Y };
}

// 環境マップ用の簡易シーン（映り込み・環境光）
export function buildEnvScene({ night = 0 } = {}) {
  const s = new THREE.Scene();
  const day = 1 - night;
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(280, 250, 220),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })
  );
  // 窓側（-x, +z）が明るいグラデーション
  const g = room.geometry;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const toWin = THREE.MathUtils.clamp(0.5 - x / 280 + z / 440, 0, 1);
    const up = THREE.MathUtils.clamp(0.5 + y / 250, 0, 1);
    const base = (0.1 + 0.32 * toWin + 0.12 * up) * day + 0.004 * night;
    col[i * 3] = base * 1.0;
    col[i * 3 + 1] = base * 0.95;
    col[i * 3 + 2] = base * (0.88 + 0.08 * night);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  room.position.set(0, 40, 30);
  s.add(room);

  // 窓
  const win = new THREE.Mesh(new THREE.PlaneGeometry(90, 110), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.98, 0.95).multiplyScalar(6 * day + 0.05 * night) }));
  win.rotation.y = Math.PI / 2;
  win.position.set(-110, 55, 55);
  s.add(win);

  // 机
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(170, 80), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.05, 0.025).multiplyScalar(day + 0.05) }));
  desk.rotation.x = -Math.PI / 2;
  desk.position.set(0, -0.8, 14);
  s.add(desk);

  // 水槽上の LED バー
  const led = new THREE.Mesh(new THREE.BoxGeometry(38, 0.4, 3.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(day * 8) }));
  led.position.set(0, 31.5, -1.5);
  s.add(led);
  // 夜の青い月光 LED
  if (night > 0) {
    const moon = new THREE.Mesh(new THREE.BoxGeometry(30, 0.3, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.45, 1.0).multiplyScalar(night * 6) }));
    moon.position.set(0, 31.4, 1.5);
    s.add(moon);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.7, 0.4).multiplyScalar(night * 2.5) }));
    lamp.position.set(-52, 26, -30);
    s.add(lamp);
  }
  return s;
}
