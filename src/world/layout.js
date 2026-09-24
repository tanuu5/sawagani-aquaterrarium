// 水槽内のレイアウト（地形の高さ・水場の形・岩や植物の配置）
import { Noise } from '../core/noise.js';
import { smoothstep, clamp } from '../core/rng.js';
import { TANK, WATER_LEVEL } from '../core/shared.js';

export const noise = new Noise(20260924);
const noiseB = new Noise(771);

function ellipseSD(x, z, cx, cz, rx, rz) {
  const dx = (x - cx) / rx, dz = (z - cz) / rz;
  return (Math.sqrt(dx * dx + dz * dz) - 1) * Math.min(rx, rz);
}
function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
}

// 水場の符号付き距離（負: 水場の内側）
export function poolSD(x, z) {
  let d = ellipseSD(x, z, 11.5, 4.8, 9.8, 7.4);
  d = smin(d, ellipseSD(x, z, 3.2, 9.8, 7.2, 4.4), 3.0);
  d = smin(d, ellipseSD(x, z, 15.8, -2.6, 5.2, 4.2), 2.5);
  d += noise.fbm2(x * 0.16 + 3.1, z * 0.16 - 1.7, 3) * 1.4;
  return d;
}

function landH(x, z) {
  let h = 5.25;
  h += 3.6 * smoothstep(1.5, -12, z);
  h += 1.5 * smoothstep(3, -19.5, x) * (0.55 + 0.45 * smoothstep(9, -6, z));
  // シェルター石の下はカニが掘ったような浅いくぼみ
  h -= 0.35 * Math.exp(-((x + 11.4) ** 2 / 8 + (z - 4.0) ** 2 / 4.5));
  h += noise.fbm2(x * 0.11, z * 0.11, 4) * 0.6;
  h += noise.fbm2(x * 0.45 + 7, z * 0.45, 3) * 0.13;
  return h;
}
function poolBottomH(x, z) {
  return 1.75 + noiseB.fbm2(x * 0.2 + 5, z * 0.2, 3) * 0.35 + 0.35 * smoothstep(3, 12, z) * 0;
}

// 地形情報（高さ・砂利/土の比率）
export function terrainAt(x, z) {
  const sd = poolSD(x, z);
  const w = 3.2 + 2.2 * smoothstep(-2, 10, z); // 手前ほどなだらかな浜
  const t = smoothstep(0.9, -w, sd);
  const h = landH(x, z) * (1 - t) + poolBottomH(x, z) * t;
  const gravel = smoothstep(2.6, -0.6, sd + noiseB.fbm2(x * 0.3, z * 0.3, 2) * 0.8);
  return { h, sd, gravel, pool: t };
}
// 地形メッシュ生成後は格子から高速に引く
let fastHeight = null;
export function setHeightSampler(fn) {
  fastHeight = fn;
}
export function heightAt(x, z) {
  return fastHeight ? fastHeight(x, z) : terrainAt(x, z).h;
}

// 苔の被覆（0..1）
export function mossAt(x, z) {
  const sd = poolSD(x, z);
  let m = smoothstep(1.4, 3.4, sd);
  const n = noise.fbm2(x * 0.22 + 11, z * 0.22 - 4, 4);
  m *= smoothstep(-0.42, -0.08, n);
  // シェルター前の土の通り道と、平石の下（苔は生えない）
  m *= 1 - 0.95 * Math.exp(-((x + 10.5) ** 2 / 7 + (z - 8.8) ** 2 / 3.5));
  m *= 1 - 0.95 * Math.exp(-((x + 11.4) ** 2 / 9 + (z - 4.0) ** 2 / 3.5));
  m *= 1 - 0.9 * Math.exp(-((x + 2.5) ** 2 / 6 + (z - 2) ** 2 / 10));
  // 前面ガラス際は少し減らす
  m *= smoothstep(TANK.iz1 + 0.2, TANK.iz1 - 1.2, z);
  return clamp(m, 0, 1);
}

// ---- 岩の配置 ----
// type: seiryu（青龍石風の角張った石）/ river（丸い川石）/ slab（平石）
export const ROCKS = [
  // 親石
  { id: 'main', type: 'seiryu', x: -6.2, z: -7.4, sx: 9.6, sy: 16.5, sz: 7.0, rotY: 0.35, tiltX: -0.08, tiltZ: 0.1, sink: 3.6, seed: 11 },
  { id: 'main2', type: 'seiryu', x: -12.4, z: -9.0, sx: 6.6, sy: 11.0, sz: 5.2, rotY: -0.5, tiltX: 0.05, tiltZ: 0.22, sink: 2.6, seed: 27 },
  { id: 'side', type: 'seiryu', x: -16.4, z: -3.6, sx: 4.6, sy: 5.6, sz: 4.2, rotY: 1.1, tiltX: 0.1, tiltZ: -0.15, sink: 1.4, seed: 5 },
  // 滝の石（右奥）
  { id: 'fall', type: 'seiryu', x: 12.6, z: -8.8, sx: 8.8, sy: 14.0, sz: 6.0, rotY: -0.25, tiltX: -0.06, tiltZ: -0.08, sink: 3.2, seed: 41 },
  { id: 'fall2', type: 'seiryu', x: 17.4, z: -6.6, sx: 5.0, sy: 8.0, sz: 4.6, rotY: 0.6, tiltX: 0.0, tiltZ: 0.18, sink: 2.0, seed: 43 },
  { id: 'fall3', type: 'seiryu', x: 7.2, z: -9.8, sx: 5.4, sy: 9.0, sz: 4.4, rotY: 0.9, tiltX: 0.1, tiltZ: -0.2, sink: 2.2, seed: 47 },
  // シェルターの平石と支え
  // 支え石は平石の裏面に届く高さへ自動で伸縮する（rocks.js）
  { id: 'shelterA', type: 'seiryu', x: -13.8, z: 4.5, sx: 2.6, sy: 4.6, sz: 2.8, rotY: 0.3, tiltX: 0.04, tiltZ: 0.06, sink: 0.7, seed: 61, supportFor: 'slab' },
  { id: 'shelterB', type: 'seiryu', x: -9.0, z: 3.4, sx: 2.4, sy: 4.4, sz: 2.6, rotY: 1.2, tiltX: -0.05, tiltZ: -0.04, sink: 0.7, seed: 63, supportFor: 'slab' },
  { id: 'slab', type: 'slab', x: -11.4, z: 4.0, sx: 6.8, sy: 2.4, sz: 4.4, rotY: 0.22, sink: 0, seed: 65, ceiling: true, clearance: 2.4 },
  // 水場の川石
  { id: 'r1', type: 'river', x: 7.0, z: 6.2, sx: 2.6, sy: 1.5, sz: 2.1, rotY: 0.4, sink: 0.15, seed: 71 },
  { id: 'r2', type: 'river', x: 13.2, z: 2.6, sx: 1.7, sy: 1.1, sz: 1.4, rotY: 1.9, sink: 0.1, seed: 73 },
  { id: 'r3', type: 'river', x: 16.2, z: 8.6, sx: 3.0, sy: 1.6, sz: 2.4, rotY: -0.6, sink: 0.2, seed: 75 },
  { id: 'r4', type: 'river', x: 2.6, z: 10.4, sx: 1.4, sy: 0.9, sz: 1.2, rotY: 0.8, sink: 0.1, seed: 77 },
  { id: 'r5', type: 'river', x: 10.2, z: -3.2, sx: 2.3, sy: 1.6, sz: 1.9, rotY: 2.4, sink: 0.4, seed: 79 },
  { id: 'r6', type: 'river', x: 4.2, z: 2.6, sx: 1.6, sy: 1.1, sz: 1.3, rotY: 0.2, sink: 0.25, seed: 81 },
  { id: 'r7', type: 'river', x: 18.0, z: 1.5, sx: 1.5, sy: 1.2, sz: 1.8, rotY: 0.2, sink: 0.25, seed: 83 },
  // 陸の小石
  { id: 's1', type: 'seiryu', x: -1.8, z: -2.2, sx: 2.2, sy: 2.0, sz: 1.8, rotY: 0.7, tiltX: 0.1, tiltZ: 0.1, sink: 0.6, seed: 91 },
  { id: 's2', type: 'river', x: -17.4, z: 9.2, sx: 1.8, sy: 1.2, sz: 1.5, rotY: 0.5, sink: 0.4, seed: 93 },
  { id: 's3', type: 'seiryu', x: 1.8, z: -6.2, sx: 2.8, sy: 3.2, sz: 2.2, rotY: -0.4, tiltX: -0.1, tiltZ: 0.15, sink: 0.9, seed: 95 },
];

export const WATERFALL = { x: 11.0, z: -5.6, top: 12.6 };

export { WATER_LEVEL };
