import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { waterFxPatch, worldPosPatch, addPatch, TANK } from '../core/shared.js';
import { Noise } from '../core/noise.js';
import { RNG, clamp } from '../core/rng.js';
import { terrainAt, heightAt, ROCKS } from './layout.js';

function pebbleGeo(seed, detail) {
  const nz = new Noise(seed);
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  const rng = new RNG(seed);
  const sy = rng.range(0.45, 0.75), sz = rng.range(0.65, 1.0);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = nz.fbm3(v.x * 1.3, v.y * 1.3, v.z * 1.3, 3);
    v.multiplyScalar(1 + n * 0.22);
    v.y *= sy; v.z *= sz;
    if (v.y < -0.25 * sy) v.y = -0.25 * sy + (v.y + 0.25 * sy) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// 岩の足元を避ける
function insideRock(x, z, r) {
  for (const d of ROCKS) {
    if (d.type === 'slab') continue;
    const dx = (x - d.x) / (d.sx * 0.42 + r), dz = (z - d.z) / (d.sz * 0.42 + r);
    if (dx * dx + dz * dz < 1) return true;
  }
  return false;
}

export function buildPebbles(scene) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  worldPosPatch(mat);
  addPatch(mat, {
    key: 'pebble',
    fragment: [['#include <color_fragment>', `#include <color_fragment>
      {
        float fw = length(fwidth(vWPos));
        float fade = smoothstep(0.006, 0.03, fw);
        float n = vnoise3(vWPos * 9.0) * 0.5 + vnoise3(vWPos * 31.0) * 0.5 * (1.0 - fade);
        diffuseColor.rgb *= 0.8 + 0.4 * n;
        float sp = hash13(floor(vWPos * 60.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.4, step(0.9, sp) * (1.0 - fade));
      }`]],
  });
  waterFxPatch(mat, { wetHeight: 0.5, wetDarken: 0.4, wetGloss: 0.95 });

  const rng = new RNG(4242);
  const palette = [
    [0.32, 0.3, 0.27], [0.2, 0.19, 0.18], [0.09, 0.09, 0.09], [0.42, 0.4, 0.36], [0.26, 0.2, 0.15],
    [0.34, 0.24, 0.16], [0.15, 0.16, 0.15], [0.5, 0.48, 0.44], [0.12, 0.11, 0.1], [0.28, 0.27, 0.22],
  ];
  const tiers = [
    { count: 700, rMin: 0.2, rMax: 0.55, detail: 2, variants: 4, where: 'gravel' },
    { count: 2600, rMin: 0.09, rMax: 0.22, detail: 1, variants: 4, where: 'gravel' },
    { count: 260, rMin: 0.12, rMax: 0.4, detail: 1, variants: 2, where: 'land' },
  ];
  const meshes = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const bb = new THREE.Box3();
  const up = new THREE.Vector3(0, 1, 0), nrm = new THREE.Vector3(), q2 = new THREE.Quaternion();
  const col = new THREE.Color();
  let seed = 100;
  for (const tier of tiers) {
    const per = Math.ceil(tier.count / tier.variants);
    for (let v = 0; v < tier.variants; v++) {
      const geo = pebbleGeo(seed++, tier.detail);
      geo.computeBoundingBox();
      const im = new THREE.InstancedMesh(geo, mat, per);
      let n = 0, guard = 0;
      while (n < per && guard++ < per * 60) {
        const x = rng.range(TANK.ix0 + 0.3, TANK.ix1 - 0.3);
        const z = rng.range(TANK.iz0 + 0.3, TANK.iz1 - 0.2);
        const info = terrainAt(x, z);
        let pAccept;
        if (tier.where === 'gravel') pAccept = Math.pow(info.gravel, 1.5);
        else pAccept = (1 - info.gravel) * 0.25;
        if (rng.next() > pAccept) continue;
        const r = tier.rMin + (tier.rMax - tier.rMin) * Math.pow(rng.next(), 2.2);
        if (insideRock(x, z, r)) continue;
        const h = info.h;
        // 地形の法線に沿わせる
        const e = 0.3;
        nrm.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
        q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
        q2.setFromUnitVectors(up, nrm);
        q.premultiply(q2);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.25, 0.25), 0, rng.range(-0.25, 0.25)));
        q.multiply(tilt);
        s.set(r, r, r);
        t.set(x, h - r * 0.18 * (0.5 + rng.next()), z);
        m4.compose(t, q, s);
        // ガラスにめり込まないよう内側へ寄せる
        bb.copy(geo.boundingBox).applyMatrix4(m4);
        const gx = Math.max(0, TANK.ix0 + 0.02 - bb.min.x) - Math.max(0, bb.max.x - (TANK.ix1 - 0.02));
        const gz = Math.max(0, TANK.iz0 + 0.02 - bb.min.z) - Math.max(0, bb.max.z - (TANK.iz1 - 0.02));
        if (gx || gz) {
          t.x += gx; t.z += gz;
          t.y += heightAt(t.x, t.z) - heightAt(x, z);
          m4.compose(t, q, s);
        }
        im.setMatrixAt(n, m4);
        const c = palette[Math.floor(rng.next() * palette.length)];
        const k = 0.8 + rng.next() * 0.4;
        col.setRGB(c[0] * k, c[1] * k, c[2] * k);
        im.setColorAt(n, col);
        n++;
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = tier.rMax > 0.3;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      scene.add(im);
      meshes.push(im);
    }
  }
  return { meshes, material: mat };
}
