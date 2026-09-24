// カニのメッシュ生成を別スレッドで行う（読み込み中に他の生成と並行させる）
import { buildCrabPartsRaw } from './crabShapes.js';

function collect(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.positions && obj.index) {
    out.push(obj.positions.buffer, obj.normals.buffer, obj.zone.buffer, obj.ao.buffer, obj.index.buffer);
    return;
  }
  for (const k in obj) collect(obj[k], out);
}

self.onmessage = async () => {
  try {
    const raw = await buildCrabPartsRaw((p) => self.postMessage({ type: 'progress', p }));
    const transfers = [];
    collect(raw, transfers);
    self.postMessage({ type: 'done', raw }, transfers);
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.stack || e) });
  }
};
