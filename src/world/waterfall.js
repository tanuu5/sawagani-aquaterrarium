import * as THREE from 'three';
import { WATER_LEVEL, LAYER_FX, shared, addPatch, worldPosPatch } from '../core/shared.js';
import { RNG } from '../core/rng.js';

// 滝石の前面を伝って落ちる細い流れ
export function buildWaterfall(scene, { rocks, nav, post }) {
  const fallRocks = rocks.filter((m) => ['fall', 'fall2', 'fall3'].includes(m.userData.def.id));
  const main = rocks.find((m) => m.userData.def.id === 'fall');
  const ray = new THREE.Raycaster();
  // 滝の位置: 前方の地面が最も深い x を探す
  let best = null;
  for (let x = 10.0; x <= 15.5; x += 0.25) {
    ray.set(new THREE.Vector3(x, 40, main.position.z), new THREE.Vector3(0, -1, 0));
    const top = ray.intersectObject(main, false)[0];
    if (!top) continue;
    ray.set(new THREE.Vector3(x, WATER_LEVEL + 0.3, 6), new THREE.Vector3(0, 0, -1));
    const face = ray.intersectObjects(fallRocks, false)[0];
    if (!face) continue;
    const baseZ = face.point.z + 0.9;
    const depth = WATER_LEVEL - nav.groundAt(x, baseZ);
    const score = depth * 2 - Math.abs(x - 12.8) * 0.4 + Math.min(top.point.y, 16) * 0.05;
    if (!best || score > best.score) best = { x, score, topY: top.point.y };
  }
  if (!best) return null;
  const x0 = best.x;
  // 上端から水面まで前面をなぞる
  const pts = [];
  const topY = best.topY - 0.25;
  const steps = 60;
  let lastZ = null;
  for (let s = 0; s <= steps; s++) {
    const y = topY + (WATER_LEVEL - 0.05 - topY) * (s / steps);
    ray.set(new THREE.Vector3(x0, y, 8), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(fallRocks, false)[0];
    let z;
    if (hit) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      z = hit.point.z + 0.08 + Math.max(0, n.z) * 0.02;
    } else z = lastZ ?? main.position.z;
    // 張り出しの下では水が落ちる（前へ戻らない）
    if (lastZ !== null && z < lastZ - 0.05) z = lastZ - 0.05 * (1 - s / steps);
    lastZ = z;
    pts.push(new THREE.Vector3(x0 + Math.sin(s * 0.35) * 0.05, y, z));
  }
  // 最上部は岩の上面に沿って少し奥から
  pts.unshift(new THREE.Vector3(x0, topY + 0.15, pts[0].z - 0.7));
  const curve = new THREE.CatmullRomCurve3(pts);
  const N = 120;
  const pos = [], uv = [], nrm = [], idx = [];
  let len = 0, prev = null;
  const P = curve.getSpacedPoints(N);
  for (let i = 0; i <= N; i++) {
    const p = P[i];
    if (prev) len += p.distanceTo(prev);
    prev = p;
    const t = i / N;
    const tan = curve.getTangentAt(Math.min(t, 0.999));
    const side = new THREE.Vector3(1, 0, 0);
    const n = new THREE.Vector3().crossVectors(side, tan).normalize();
    if (n.z < 0) n.negate();
    const w = 0.45 + 0.5 * Math.pow(t, 0.7) + 0.1 * Math.sin(t * 17);
    for (const k of [-1, 0, 1]) {
      const q = p.clone().addScaledVector(side, k * w).addScaledVector(n, k === 0 ? 0.04 : 0);
      pos.push(q.x, q.y, q.z);
      nrm.push(n.x, n.y, n.z);
      uv.push((k + 1) / 2, len);
    }
    if (i > 0) {
      const a = (i - 1) * 3, b = i * 3;
      idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x000000, roughness: 0.04, metalness: 0, ior: 1.333, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  worldPosPatch(mat);
  const u = { uRefractTex: { value: post.refractTexture }, uResolution: { value: new THREE.Vector2(1, 1) }, uTime: shared.uTime, uLen: { value: len }, uLight: { value: 1 } };
  addPatch(mat, {
    key: 'waterfall',
    uniforms: u,
    vertexHead: 'varying vec2 vFUv;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvFUv = uv;']],
    fragmentHead: `varying vec2 vFUv; uniform sampler2D uRefractTex; uniform vec2 uResolution; uniform float uTime; uniform float uLen; uniform float uLight;
      float wfFlow(vec2 q) { return vnoise2(q) * 0.6 + vnoise2(q * 2.7 + 3.1) * 0.4; }`,
    fragment: [
      ['#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float speed = 7.0;
        vec2 fq = vec2(vFUv.x * 7.0, vFUv.y * 2.2 - uTime * speed);
        float fl = wfFlow(fq);
        float flx = wfFlow(fq + vec2(0.07, 0.0)) - fl;
        float fly = wfFlow(fq + vec2(0.0, 0.07)) - fl;
        normal = safeNormalize(normal + (flx * vec3(1.0, 0.0, 0.0) + fly * vec3(0.0, 1.0, 0.0)) * 4.0, normal);
      `],
      ['#include <transmission_fragment>', `
        {
          vec2 suv = gl_FragCoord.xy / uResolution + normal.xy * 0.012;
          vec3 behind = texture2D(uRefractTex, suv).rgb;
          totalDiffuse = behind * vec3(0.82, 0.9, 0.9);
        }`],
      ['#include <opaque_fragment>', `
        float edge = smoothstep(0.0, 0.3, vFUv.x) * smoothstep(1.0, 0.7, vFUv.x);
        float streak = smoothstep(0.35, 0.85, wfFlow(vec2(vFUv.x * 13.0, vFUv.y * 0.9 - uTime * 7.0)));
        float headFade = smoothstep(0.0, 0.6, vFUv.y);
        outgoingLight += vec3(0.9, 0.95, 1.0) * streak * 0.55 * uLight;
        gl_FragColor = vec4(outgoingLight, edge * headFade * (0.72 + 0.28 * streak));
      `],
    ],
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.layers.set(LAYER_FX);
  mesh.renderOrder = 4;
  scene.add(mesh);

  // 着水点
  const base = P[P.length - 1].clone();
  base.y = WATER_LEVEL;
  base.z += 0.15;

  // しぶき
  const rng = new RNG(99);
  const dropGeo = new THREE.SphereGeometry(1, 6, 4);
  const dropMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.7, 1.8), transparent: true, opacity: 0.55, depthWrite: false });
  const maxD = 60;
  const drops = new THREE.InstancedMesh(dropGeo, dropMat, maxD);
  drops.layers.set(LAYER_FX);
  drops.frustumCulled = false;
  drops.renderOrder = 7;
  scene.add(drops);
  const parts = [];
  const m4 = new THREE.Matrix4();

  // 泡立ち（着水点の白い泡）
  const foamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: shared.uTime },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uTime;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
      void main(){
        vec2 c = vUv - 0.5; float r = length(c) * 2.0;
        float a = atan(c.y, c.x + 1e-5);
        float f = n(vec2(a * 3.0, r * 6.0 - uTime * 3.0)) * n(vec2(a * 7.0 + 1.3, r * 11.0 - uTime * 5.0) );
        float m = smoothstep(1.0, 0.2, r) * smoothstep(0.25, 0.6, f + (1.0 - r) * 0.3);
        gl_FragColor = vec4(vec3(1.4), m * 0.55);
      }`,
  });
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.0), foamMat);
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(base.x, WATER_LEVEL + 0.02, base.z + 0.35);
  foam.layers.set(LAYER_FX);
  foam.renderOrder = 3;
  scene.add(foam);

  return {
    mesh, uniforms: u, base, curve, len,
    update(dt, ripple) {
      u.uResolution.value.set(post.width, post.height);
      // しぶきの発生
      for (let k = 0; k < 2; k++) {
        if (parts.length < maxD && rng.next() < 0.8) {
          parts.push({
            p: base.clone().add(new THREE.Vector3(rng.range(-0.4, 0.4), 0.02, rng.range(-0.1, 0.4))),
            v: new THREE.Vector3(rng.range(-6, 6), rng.range(5, 13), rng.range(-2, 7)),
            r: rng.range(0.012, 0.035),
          });
        }
      }
      let n = 0;
      for (let i = parts.length - 1; i >= 0; i--) {
        const d = parts[i];
        d.v.y -= 980 * 0.35 * dt;
        d.p.addScaledVector(d.v, dt);
        if (d.p.y < WATER_LEVEL) {
          if (ripple && rng.next() < 0.5) ripple.addDrop(d.p.x, d.p.z, 0.08, 0.003);
          parts.splice(i, 1);
          continue;
        }
        m4.makeScale(d.r, d.r, d.r).setPosition(d.p);
        drops.setMatrixAt(n++, m4);
      }
      drops.count = n;
      drops.instanceMatrix.needsUpdate = true;
      if (ripple) {
        for (let k = 0; k < 2; k++) ripple.addDrop(base.x + rng.range(-0.5, 0.5), base.z + rng.range(0, 0.7), 0.14, 0.006);
      }
    },
  };
}
