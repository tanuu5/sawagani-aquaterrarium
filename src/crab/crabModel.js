// カニのパーツ形状を three.js の BufferGeometry にする（生成は Worker で並行実行）
import * as THREE from 'three';
import { buildCrabPartsRaw, walkingLegSpec, chelaSpec, BODY } from './crabShapes.js';

export { walkingLegSpec, chelaSpec, BODY };

function toGeometry(r) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
  g.setAttribute('aZone', new THREE.BufferAttribute(r.zone, 4));
  g.setAttribute('aAO', new THREE.BufferAttribute(r.ao, 1));
  g.setIndex(new THREE.BufferAttribute(r.index, 1));
  return g;
}

function convert(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.positions && obj.index) return toGeometry(obj);
  if (Array.isArray(obj)) return obj.map(convert);
  const out = {};
  for (const k in obj) out[k] = k === 'spec' ? obj[k] : convert(obj[k]);
  return out;
}

// メインスレッドで生成（Worker が使えない環境向け）
export async function buildCrabParts(onProgress = () => {}) {
  return convert(await buildCrabPartsRaw(onProgress));
}

// Worker で生成を始め、Promise を返す
export function startCrabParts(onProgress = () => {}) {
  let worker;
  try {
    worker = new Worker(new URL('./crabWorker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    return buildCrabParts(onProgress);
  }
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(buildCrabParts(onProgress));
    };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') onProgress(d.p);
      else if (d.type === 'done' && !settled) {
        settled = true;
        worker.terminate();
        resolve(convert(d.raw));
      } else if (d.type === 'error') {
        console.warn('crab worker failed:', d.message);
        fallback();
      }
    };
    worker.onerror = (e) => { console.warn('crab worker error', e.message); fallback(); };
    worker.postMessage('go');
  });
}
