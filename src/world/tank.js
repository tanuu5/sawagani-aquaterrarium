import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TANK, LAYER_FX, addPatch, worldPosPatch } from '../core/shared.js';

// ガラス面: フレネルで不透明度を決め、映り込みだけを乗算済みアルファで重ねる
function glassMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0.03,
    ior: 1.75,
    specularIntensity: 1,
    envMapIntensity: 1.0,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
  });
  worldPosPatch(m);
  const gu = { uGlassDirt: { value: 0.012 }, uLightI: { value: 1 } };
  m.userData.glassU = gu;
  addPatch(m, {
    key: 'glass',
    uniforms: gu,
    fragmentHead: `uniform float uGlassDirt; uniform float uLightI;
      // 結露の水滴: セル中心からのずれと距離
      vec4 dropCell(vec2 p) {
        vec2 n = floor(p), f = fract(p);
        float md = 8.0; vec2 mo = vec2(0.0); float id = 0.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = hash22(n + g);
          vec2 r = g + o - f;
          float d = dot(r, r);
          if (d < md) { md = d; mo = r; id = hash12(n + g + 3.7); }
        }
        return vec4(-mo, sqrt(md), id);
      }`,
    fragment: [['#include <opaque_fragment>', `
      float gNdV = abs(dot(normalize(normal), normalize(vViewPosition)));
      float gF = 0.082 + (1.0 - 0.082) * pow(1.0 - gNdV, 5.0);
      float dropA = 0.0; vec3 dropC = vec3(0.0);
      {
        vec3 an = abs(vWNrm);
        vec2 q = an.z > 0.5 ? vWPos.xy : vWPos.zy;
        float hum = smoothstep(21.5, 27.5, vWPos.y) * (an.y > 0.5 ? 0.0 : 1.0);
        if (hum > 0.001) {
          vec4 c = dropCell(q * 2.2);
          float present = step(0.62, fract(c.w * 17.0));
          float r = (0.1 + 0.2 * fract(c.w * 5.3)) * hum;
          float inside = smoothstep(r, r * 0.8, c.z) * present;
          float rim = smoothstep(r * 0.55, r * 0.95, c.z) * inside;
          vec2 dir = c.z > 1e-4 ? c.xy / c.z : vec2(0.0);
          float hl = smoothstep(0.6, 0.95, dot(dir, normalize(vec2(-0.6, 0.8)))) * smoothstep(0.3, 0.7, c.z / max(r, 1e-3));
          dropA = inside * 0.08 + rim * 0.12;
          dropC = vec3(0.9, 0.95, 1.0) * hl * inside * 0.12 * uLightI;
          // 細かな霧（うっすら白む）
          dropA += hum * 0.035;
        }
      }
      gl_FragColor = vec4(outgoingLight + dropC, clamp(gF * 0.9 + uGlassDirt + dropA, 0.0, 1.0));
    `]],
  });
  return m;
}

export function buildTank(scene) {
  const group = new THREE.Group();
  group.name = 'tank';
  const { w, d, h, glass: t } = TANK;

  const gMat = glassMaterial();
  const edgeMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.62, 0.86, 0.8), roughness: 0.12, metalness: 0, transparent: true, opacity: 0.55,
    depthWrite: false,
  });

  const panels = [];
  const addPanel = (sx, sy, sz, x, y, z, bigAxis) => {
    // bigAxis: 大きな面の軸（'x' | 'y' | 'z'）
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const mats = [edgeMat, edgeMat, edgeMat, edgeMat, edgeMat, edgeMat];
    const idx = { x: [0, 1], y: [2, 3], z: [4, 5] }[bigAxis];
    mats[idx[0]] = gMat; mats[idx[1]] = gMat;
    const mesh = new THREE.Mesh(geo, mats);
    mesh.position.set(x, y, z);
    mesh.layers.set(LAYER_FX);
    mesh.renderOrder = 10;
    group.add(mesh);
    panels.push(mesh);
    return mesh;
  };
  // 前後
  addPanel(w, h + t, t, 0, (h + t) / 2 - t, d / 2 - t / 2, 'z');
  addPanel(w, h + t, t, 0, (h + t) / 2 - t, -d / 2 + t / 2, 'z');
  // 左右（前後の間）
  addPanel(t, h + t, d - 2 * t, -w / 2 + t / 2, (h + t) / 2 - t, 0, 'x');
  addPanel(t, h + t, d - 2 * t, w / 2 - t / 2, (h + t) / 2 - t, 0, 'x');
  // 底
  const bottom = addPanel(w - 2 * t, t, d - 2 * t, 0, -t / 2, 0, 'y');
  bottom.renderOrder = 9;

  // 背面のバックスクリーン（外側に貼った黒いフィルム）
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(w - 0.2, h - 0.2),
    new THREE.MeshStandardMaterial({ color: 0x060707, roughness: 0.55, metalness: 0 })
  );
  back.position.set(0, h / 2 - 0.3, -d / 2 - 0.02);
  group.add(back);

  // シリコン目地（内側の縦の角）
  const silMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.8, 0.82, 0.8), roughness: 0.35, transparent: true, opacity: 0.32, depthWrite: false,
  });
  const silGeo = new THREE.CylinderGeometry(0.22, 0.22, h - 0.2, 8, 1);
  for (const [x, z] of [[TANK.ix0, TANK.iz0], [TANK.ix1, TANK.iz0], [TANK.ix0, TANK.iz1], [TANK.ix1, TANK.iz1]]) {
    const s = new THREE.Mesh(silGeo, silMat);
    s.position.set(x, h / 2, z);
    s.layers.set(LAYER_FX);
    s.renderOrder = 11;
    group.add(s);
  }

  // LED 照明（アルミ筐体 + 発光面）
  const alu = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 1.0, roughness: 0.38 });
  const ledBody = new THREE.Mesh(new RoundedBoxGeometry(38, 1.1, 4.2, 3, 0.35), alu);
  ledBody.position.set(0, 32.3, -1.5);
  ledBody.castShadow = false;
  group.add(ledBody);
  const ledPanelMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(18) });
  const ledPanel = new THREE.Mesh(new THREE.PlaneGeometry(36.5, 3.2), ledPanelMat);
  ledPanel.rotation.x = Math.PI / 2;
  ledPanel.position.set(0, 31.72, -1.5);
  group.add(ledPanel);
  // 月光 LED（夜用の細い青いライン）
  const moonPanelMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 0.5, 1.0).multiplyScalar(0) });
  const moonPanel = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.5), moonPanelMat);
  moonPanel.rotation.x = Math.PI / 2;
  moonPanel.position.set(0, 31.71, 0.2);
  group.add(moonPanel);
  // 脚（側面ガラスの縁に乗る）
  const legMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, metalness: 0.5, roughness: 0.45 });
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.2, 3.0), legMat);
    leg.position.set(sx * (w / 2 - 0.25), h + 2.0, -1.5);
    leg.castShadow = false;
    group.add(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.6, 3.0), legMat);
    arm.position.set(sx * (w / 2 - 1.0), 31.9, -1.5);
    group.add(arm);
  }
  // 電源コード
  const cordCurve = new THREE.CatmullRomCurve3([
    // 照明の後ろから机の上を這い、奥の縁（z=-26）から机の裏へ垂れ下がる
    new THREE.Vector3(18.5, 32.4, -3.3), new THREE.Vector3(21, 33.2, -8), new THREE.Vector3(23, 20, -14), new THREE.Vector3(24, -0.55, -19),
    new THREE.Vector3(25, -0.62, -24.8), new THREE.Vector3(25.4, -2.2, -26.4), new THREE.Vector3(25.8, -20, -26.6), new THREE.Vector3(26, -60, -27),
  ], false, 'centripetal');
  const cord = new THREE.Mesh(new THREE.TubeGeometry(cordCurve, 160, 0.18, 8, false), new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5 }));
  group.add(cord);

  scene.add(group);

  // 照明: メイン LED（影あり）
  const led = new THREE.SpotLight(0xfff6ec, 19000, 0, THREE.MathUtils.degToRad(40), 0.75, 2);
  led.position.set(0, 72, -1.5);
  led.target.position.set(0, 0, 0);
  led.castShadow = true;
  led.shadow.mapSize.set(2048, 2048);
  led.shadow.camera.near = 30;
  led.shadow.camera.far = 90;
  led.shadow.bias = -0.00015;
  led.shadow.normalBias = 0.02;
  led.shadow.radius = 2.5;
  led.layers.enableAll();
  scene.add(led, led.target);

  // 夜の月光 LED
  const moon = new THREE.SpotLight(0x8aa6ff, 0, 0, THREE.MathUtils.degToRad(42), 0.9, 2);
  moon.position.set(0, 60, 1);
  moon.target.position.set(0, 0, 0);
  moon.layers.enableAll();
  scene.add(moon, moon.target);

  return { group, led, moon, ledPanelMat, moonPanelMat, panels, glassMat: gMat };
}
