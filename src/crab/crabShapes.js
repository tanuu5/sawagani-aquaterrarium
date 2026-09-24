// サワガニ（Geothelphusa dehaani）の形状を SDF で彫刻し、パーツごとのメッシュ（生の配列）を生成する
// three.js に依存しない（Web Worker でも動かすため）
// 座標系（カニのローカル）: +z 前方, +y 上, +x 左（カニ自身の左）。甲幅 ≈ 2.6
import {
  surfaceNets, Outline2D, smoothClosed, smin, smax, sdEllipsoid, sdSphere, sdCapsule, sdRoundCone, clamp, mix, sstep,
} from './sdf.js';

// ---------------- 甲羅 ----------------
const HALF = [
  [0.0, 0.985], [0.24, 0.99], [0.46, 0.975], [0.6, 0.94], [0.76, 0.935], [0.93, 0.84],
  [1.1, 0.64], [1.23, 0.4], [1.3, 0.13], [1.285, -0.13], [1.19, -0.42], [1.01, -0.67],
  [0.77, -0.87], [0.5, -0.985], [0.24, -1.02],
];
const outlinePts = (() => {
  // 右半分（x>=0）→ 背面中央 → 左半分
  const pts = [];
  for (const p of HALF) pts.push(p);
  pts.push([0, -1.025]);
  for (let i = HALF.length - 1; i >= 1; i--) pts.push([-HALF[i][0], HALF[i][1]]);
  return smoothClosed(pts, 10);
})();

let OUTLINE = null;
function outline() {
  if (!OUTLINE) OUTLINE = new Outline2D(outlinePts, [-1.7, -1.4, 1.7, 1.4], 0.008);
  return OUTLINE;
}

export const BODY = {
  yMargin: 0.0,
  domeH: 0.6,
  domeR: 0.95,
  yBottom: -0.37,
  eye: { x: 0.69, y: 0.02, z: 0.9 },
};

function frontDroop(x, z) {
  return 0.26 * Math.pow(sstep(0.35, 1.05, z), 1.4) + 0.08 * sstep(-0.45, -1.05, z);
}

// 2D 線分距離
function segDist(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, wx = x - ax, wz = z - az;
  const h = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1);
  const qx = wx - ex * h, qz = wz - ez * h;
  return Math.sqrt(qx * qx + qz * qz);
}
const GROOVES = [
  // [ax, az, bx, bz, depth, width]
  [0.3, 0.3, 0.2, -0.3, 0.009, 0.075], // H の縦棒
  [0.3, 0.3, 0.55, 0.4, 0.007, 0.07], // 頸溝
  [0.55, 0.4, 0.92, 0.46, 0.006, 0.07],
  [0.0, 0.0, 0.24, 0.0, 0.004, 0.07], // H の横棒
  [0.0, 0.52, 0.0, 0.82, 0.004, 0.05], // 中央の浅い溝
];

export function bodySDF(x, y0, z) {
  const O = outline();
  const B = BODY;
  const y = y0 + frontDroop(x, z);
  const d2 = O.sample(x, z);
  const u = clamp(-d2 / B.domeR, 0, 1);
  // 背面ドーム（縁でやや角張る）
  const back = sstep(-0.2, -1.0, z);
  const H = B.domeH * (1 - 0.18 * back);
  const top = B.yMargin + H * (1 - Math.pow(1 - u, 2.3));
  let fTop = (y - top) / Math.sqrt(1 + Math.pow((H * 2.3 * Math.pow(1 - u, 1.3)) / B.domeR, 2));
  // 側面（鰓域）: 縁の下で内側へ回り込む
  const s = clamp((B.yMargin - y) / 0.36, 0, 1);
  const inset = y < B.yMargin ? 0.42 * (1 - Math.sqrt(1 - s * s)) : 0;
  const fSide = d2 + inset;
  const fBot = B.yBottom - y0;
  let f = smax(fTop, fSide, 0.035);
  f = smax(f, fBot, 0.08);
  // 溝
  const ax = Math.abs(x);
  if (y > -0.05) {
    let g = 0;
    for (const [gx0, gz0, gx1, gz1, dep, w] of GROOVES) {
      const dd = segDist(ax, z, gx0, gz0, gx1, gz1);
      g += dep * Math.exp(-(dd * dd) / (w * w));
    }
    // 額域の隆起（上胃域）
    g -= 0.018 * Math.exp(-(((ax - 0.27) ** 2) / 0.018 + ((z - 0.74) ** 2) / 0.006));
    // 心域・鰓域のふくらみ
    g -= 0.012 * Math.exp(-((x * x) / 0.03 + ((z + 0.25) ** 2) / 0.06));
    f += g;
  }
  // 眼窩
  const eo = sdEllipsoid(ax - 0.7, y - 0.03, z - 0.95, 0.15, 0.12, 0.13);
  f = smax(f, -eo, 0.03);
  // 口器のくぼみ（浅く、第3顎脚で蓋をされる）
  const mx = Math.max(ax - 0.31, Math.max(-(z - 0.5), z - 1.1));
  const my = Math.max(y0 - (-0.27), -0.7 - y0);
  const mouth = Math.max(mx, my);
  f = smax(f, -mouth, 0.05);
  // 腹節（下面の板）
  const abd = sdEllipsoid(x, y0 - (B.yBottom - 0.005), z + 0.2, 0.34 - 0.12 * sstep(-0.9, 0.3, z), 0.035, 0.62);
  f = smin(f, abd, 0.02);
  return f;
}

// 甲羅の色ゾーン（x: 背面の暗色, y: 淡色, z: 先端の暗色, w: 角膜）
function bodyZone(x, y, z, nx, ny, nz) {
  const O = outline();
  const d2 = O.sample(x, z);
  const yy = y + frontDroop(x, z);
  const inside = clamp(-d2 / 0.16, 0, 1);
  const dorsal = sstep(0.0, 0.5, ny) * sstep(-0.04, 0.06, yy) * sstep(0.0, 1.0, inside);
  const pale = sstep(-0.15, -0.6, ny) * 0.9;
  return [dorsal, pale, 0, 0];
}

// ---------------- 脚の節 ----------------
// x 方向に長さ L の節。prof は t=0..1 の断面プロファイル
function segSDF(x, y, z, L, prof) {
  const t = clamp(x / L, 0, 1);
  const hy = prof.h(t), hz = prof.w(t);
  const cy = prof.cy ? prof.cy(t) : 0;
  const dy = (y - cy) / hy, dz = z / hz;
  const q = Math.sqrt(dy * dy + dz * dz);
  let d = (q - 1) * Math.min(hy, hz) * (q > 1 ? 1 : 0.8);
  const x0 = prof.x0 ?? -0.02, x1 = L + (prof.x1 ?? 0.02);
  const dc = Math.max(x0 - x, x - x1);
  d = smax(d, dc, prof.cap ?? 0.05);
  return d;
}

const bump = (t, a, b) => Math.sin(Math.PI * clamp((t - a) / (b - a), 0, 1));

export function walkingLegSpec(n) {
  // n = 1..4（前から）
  const S = [
    null,
    { z: 0.34, yaw: 36, Lcb: 0.46, Lm: 1.06, Lca: 0.44, Lp: 0.62, Ld: 0.58, mh: 0.33 },
    { z: 0.06, yaw: 9, Lcb: 0.46, Lm: 1.23, Lca: 0.49, Lp: 0.71, Ld: 0.63, mh: 0.35 },
    { z: -0.25, yaw: -18, Lcb: 0.45, Lm: 1.21, Lca: 0.48, Lp: 0.7, Ld: 0.61, mh: 0.35 },
    { z: -0.53, yaw: -44, Lcb: 0.42, Lm: 1.0, Lca: 0.42, Lp: 0.61, Ld: 0.55, mh: 0.32 },
  ][n];
  return S;
}

function coxaBasisSDF(L, hh) {
  return (x, y, z) => {
    const t = clamp(x / L, 0, 1);
    const h = hh * (0.95 - 0.15 * t);
    let d = segSDF(x, y, z, L, { h: () => h, w: () => h * 0.85, x0: -0.08, x1: 0.03, cap: 0.06 });
    // 節の境目の浅いくびれ
    const ring = Math.exp(-((x - L * 0.42) ** 2) / 0.0012) * 0.012;
    return d + ring;
  };
}

function merusSDF(L, mh) {
  return (x, y, z) => {
    const prof = {
      h: (t) => mh * (0.62 + 0.38 * Math.pow(bump(t, -0.15, 1.1), 0.7)) * 0.5,
      w: (t) => mh * 0.5 * (0.64 + 0.1 * bump(t, 0, 1)),
      cy: (t) => 0.012 * Math.sin(Math.PI * t),
      x0: -0.04, x1: 0.03, cap: 0.06,
    };
    let d = segSDF(x, y, z, L, prof);
    // 背縁の稜線
    d -= 0.008 * Math.exp(-((z * z) / 0.0015)) * sstep(-0.02, 0.05, y);
    return d;
  };
}

function carpusSDF(L, mh) {
  return (x, y, z) => {
    const prof = {
      h: (t) => mh * 0.5 * (0.68 + 0.18 * bump(t, -0.1, 0.9)),
      w: (t) => mh * 0.5 * 0.58,
      cy: (t) => 0.02 * Math.sin(Math.PI * t),
      x0: -0.05, x1: 0.03, cap: 0.05,
    };
    return segSDF(x, y, z, L, prof);
  };
}

function propodusSDF(L, mh) {
  return (x, y, z) => {
    const prof = {
      h: (t) => mh * 0.5 * (0.6 - 0.12 * t),
      w: (t) => mh * 0.5 * (0.52 - 0.08 * t),
      x0: -0.04, x1: 0.02, cap: 0.045,
    };
    return segSDF(x, y, z, L, prof);
  };
}

function dactylSDF(L, mh) {
  return (x, y, z) => {
    const prof = {
      h: (t) => mh * 0.5 * 0.5 * Math.pow(1 - t, 0.75) + 0.006,
      w: (t) => mh * 0.5 * 0.4 * Math.pow(1 - t, 0.8) + 0.005,
      cy: (t) => -0.07 * t * t,
      x0: -0.035, x1: 0.0, cap: 0.02,
    };
    let d = segSDF(x, y, z, L, prof);
    // 刺毛の列（細い稜）
    const t = clamp(x / L, 0, 1);
    d -= 0.004 * (Math.sin(t * 60) * 0.5 + 0.5) * sstep(0.6, 0.1, t);
    return d;
  };
}

// ---------------- 鉗脚（ハサミ） ----------------
export function chelaSpec(size) {
  // size: 1 = 雄の大鋏
  return {
    z: 0.6, yaw: 58, Lcb: 0.44,
    Lm: 0.6 + 0.1 * size, Lca: 0.46 + 0.06 * size,
    palmL: 0.62 + 0.28 * size, palmH: 0.36 + 0.26 * size, palmW: 0.28 + 0.14 * size,
    fingerL: 0.58 + 0.2 * size, size,
  };
}

function chelaMerusSDF(sp) {
  const L = sp.Lm;
  return (x, y, z) => {
    const prof = {
      h: (t) => (0.13 + 0.05 * sp.size) * (0.72 + 0.28 * bump(t, -0.1, 1.05)),
      w: (t) => (0.1 + 0.035 * sp.size) * (0.8 + 0.2 * bump(t, 0, 1)),
      cy: (t) => 0.02 * Math.sin(Math.PI * t),
      x0: -0.05, x1: 0.03, cap: 0.06,
    };
    return segSDF(x, y, z, L, prof);
  };
}

function chelaCarpusSDF(sp) {
  const L = sp.Lca;
  return (x, y, z) => {
    let d = sdEllipsoid(x - L * 0.5, y - 0.02, z, L * 0.62, 0.13 + 0.04 * sp.size, 0.11 + 0.04 * sp.size);
    // 内側の棘（前方内側を向く）
    const sp1 = sdRoundCone(x, y, z, L * 0.62, 0.05, 0.08, L * 0.8, 0.08, 0.2 + 0.03 * sp.size, 0.035, 0.006);
    d = smin(d, sp1, 0.03);
    // 稜
    d -= 0.01 * Math.exp(-(((y - 0.12) ** 2) / 0.002));
    return d;
  };
}

// 掌部 + 不動指
function chelaPropodusSDF(sp) {
  const L = sp.palmL, H = sp.palmH, W = sp.palmW, F = sp.fingerL;
  return (x, y, z) => {
    // 掌（側扁した箱型。基部は細い）
    const tp = clamp(x / L, 0, 1);
    const hh = H * 0.5 * (0.66 + 0.34 * sstep(0.0, 0.5, tp));
    const ww = W * 0.5 * (0.78 + 0.22 * sstep(0.0, 0.45, tp));
    const cyP = 0.02 * sstep(0.2, 1.0, tp);
    const qy = Math.abs(y - cyP) / hh, qz = Math.abs(z) / ww;
    const cs = Math.pow(Math.pow(qy, 3.0) + Math.pow(qz, 2.3), 1 / 2.7) - 1;
    let d = cs * Math.min(hh, ww) * 0.95;
    d = smax(d, Math.max(-0.02 - x, x - (L + 0.02)), 0.1);
    // 外面の縦の稜
    d -= 0.008 * Math.exp(-((y - hh * 0.55) ** 2) / 0.002) * sstep(0.1, 0.4, tp);
    const neck = sdEllipsoid(x - 0.02, y, z, 0.14, H * 0.26, W * 0.3);
    d = smin(d, neck, 0.06);
    // 不動指
    const fx0 = L * 0.92, fy0 = -H * 0.18;
    const t = clamp((x - fx0) / F, 0, 1);
    const fcy = fy0 + (0.05 + 0.02 * sp.size) * t - 0.07 * t * t * t;
    const fh = (H * 0.24) * (1 - t) + 0.01;
    const fw = (W * 0.3) * (1 - 0.85 * t) + 0.008;
    let ff = sdEllipsoid(0, (y - fcy) / fh, z / fw, 1, 1, 1) * Math.min(fh, fw);
    ff = smax(ff, (x - fx0) - F, 0.02);
    ff = smax(ff, fx0 - 0.15 - x, 0.02);
    d = smin(d, ff, 0.07);
    // 歯（上縁の突起）
    if (x > fx0 && x < fx0 + F * 0.92 && y > fcy) {
      const k = (x - fx0) / 0.075;
      const tooth = Math.exp(-Math.pow((k - Math.round(k)) * 2.2, 2)) * 0.022 * (1 - t * 0.6) * sstep(0.02, 0.08, x - fx0);
      d -= tooth * sstep(fcy + fh * 0.2, fcy + fh * 0.9, y) * 1.4;
    }
    return d;
  };
}

// 可動指（x: 0 が関節）
function chelaDactylSDF(sp) {
  const F = sp.fingerL + 0.06, H = sp.palmH;
  return (x, y, z) => {
    const t = clamp(x / F, 0, 1);
    const cy = -0.05 * t - (0.06 + 0.02 * sp.size) * t * t * t;
    const fh = H * 0.2 * (1 - t) + 0.01;
    const fw = sp.palmW * 0.26 * (1 - 0.85 * t) + 0.008;
    let d = sdEllipsoid(0, (y - cy) / fh, z / fw, 1, 1, 1) * Math.min(fh, fw);
    d = smax(d, x - F, 0.02);
    d = smax(d, -0.06 - x, 0.04);
    const knob = sdEllipsoid(x - 0.02, y + 0.01, z, 0.1, fh * 1.05, fw * 1.05);
    d = smin(d, knob, 0.04);
    if (x > 0.05 && y < cy) {
      const k = x / 0.075;
      const tooth = Math.exp(-Math.pow((k - Math.round(k)) * 2.2, 2)) * 0.02 * (1 - t * 0.5);
      d -= tooth * sstep(cy - fh * 0.2, cy - fh * 0.9, y) * 1.4;
    }
    return d;
  };
}

// ---------------- 眼・顎脚 ----------------
function eyeSDF(x, y, z) {
  // 眼柄: 原点から +y 方向（やや前）
  const stalk = sdRoundCone(x, y, z, 0, -0.06, 0, 0, 0.16, 0.035, 0.085, 0.075);
  const cornea = sdEllipsoid(x, y - 0.24, z - 0.05, 0.105, 0.1, 0.105);
  return smin(stalk, cornea, 0.035);
}
function eyeZone(x, y, z) {
  const c = sstep(0.19, 0.24, y + 0.35 * (z - 0.05));
  return [0, 0.12 * (1 - c) + 0.2 * sstep(0.1, -0.1, y), 0, c];
}

// 第2触角（眼の内側から前へ伸びる短い触角。+z 方向）
function antennaSDF(x, y, z) {
  let d = sdRoundCone(x, y, z, 0, 0, 0, 0, 0.02, 0.12, 0.022, 0.015);
  d = smin(d, sdRoundCone(x, y, z, 0, 0.02, 0.12, 0.025, 0.045, 0.25, 0.015, 0.01), 0.01);
  d = smin(d, sdRoundCone(x, y, z, 0.025, 0.045, 0.25, 0.06, 0.055, 0.36, 0.01, 0.005), 0.008);
  return d;
}

function maxillipedSDF(x, y, z) {
  // 板状: x が内外, y が厚み, z が前後
  const px = Math.pow(Math.abs(x / 0.15), 3), pz = Math.pow(Math.abs(z / 0.24), 3), py = (y / 0.03) ** 2;
  const plate = (Math.pow(px + pz + py, 1 / 3) - 1) * 0.03;
  const groove = Math.exp(-((z - 0.02) ** 2) / 0.0006) * 0.006;
  return plate + groove;
}

// ---------------- メッシュ生成 ----------------
// メッシュ化の解像度倍率（大きいほど軽い）
const CRAB_RES = 2.0;
function makeGeometry(sdf, bmin, bmax, h, zoneFn, { aoRadius = 0.06, res = CRAB_RES } = {}) {
  const r = surfaceNets(sdf, bmin, bmax, h * res);
  const n = r.positions.length / 3;
  const zone = new Float32Array(n * 4);
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = r.positions[i * 3], y = r.positions[i * 3 + 1], z = r.positions[i * 3 + 2];
    const nx = r.normals[i * 3], ny = r.normals[i * 3 + 1], nz = r.normals[i * 3 + 2];
    const zz = zoneFn ? zoneFn(x, y, z, nx, ny, nz) : [0, 0, 0, 0];
    zone.set(zz, i * 4);
    // SDF による簡易 AO
    let occ = 0;
    for (let k = 1; k <= 4; k++) {
      const dist = aoRadius * k;
      const dd = sdf(x + nx * dist, y + ny * dist, z + nz * dist);
      occ += (dist - dd) / Math.pow(2, k);
    }
    ao[i] = clamp(1 - occ * (2.2 / aoRadius), 0.25, 1);
  }
  return { positions: r.positions, normals: r.normals, zone, ao, index: r.index };
}

// 節の色ゾーン（淡い関節・暗い先端）
function legZone(L, { tipDark = 0, paleEnds = 0.8, pale0 = 0.1 } = {}) {
  return (x, y, z, nx, ny, nz) => {
    const t = x / L;
    const ends = Math.max(sstep(0.12, -0.04, t), sstep(0.9, 1.04, t));
    const ventral = sstep(0.1, -0.7, ny) * 0.35;
    const pale = clamp(ends * paleEnds + ventral + pale0, 0, 1);
    const tip = tipDark ? sstep(0.72, 1.0, t) * tipDark : 0;
    return [0, pale, tip, 0];
  };
}

function chelaFingerZone(startX, len) {
  return (x, y, z, nx, ny, nz) => {
    const t = clamp((x - startX) / len, 0, 1);
    const pale = sstep(0.0, 0.55, t) * 0.95;
    const tip = sstep(0.82, 1.0, t) * 0.5;
    return [0, pale, tip, 0];
  };
}

// 全パーツを生成（左側。右側は z ミラー）
export async function buildCrabPartsRaw(onProgress = () => {}) {
  const parts = {};
  const tick = async (p, m) => { onProgress(p, m); await new Promise((r) => setTimeout(r, 0)); };

  await tick(0.0, 'body');
  parts.body = makeGeometry(bodySDF, [-1.5, -0.62, -1.25], [1.5, 0.8, 1.2], 0.02, bodyZone, { aoRadius: 0.08, res: 1.3 });

  await tick(0.3, 'eyes');
  parts.eye = makeGeometry(eyeSDF, [-0.15, -0.14, -0.15], [0.15, 0.4, 0.22], 0.008, eyeZone, { aoRadius: 0.02, res: 1.5 });
  parts.maxilliped = makeGeometry(maxillipedSDF, [-0.22, -0.08, -0.32], [0.22, 0.08, 0.34], 0.01, () => [0, 0.7, 0, 0], { aoRadius: 0.03, res: 1.6 });
  parts.antenna = makeGeometry(antennaSDF, [-0.05, -0.05, -0.05], [0.1, 0.1, 0.4], 0.005, (x, y, z) => [0, 0.35 + z * 0.8, 0, 0], { aoRadius: 0.01, res: 1.2 });

  // 歩脚（4 対ぶんの形は脚ごとに違う）
  parts.legs = [];
  for (let n = 1; n <= 4; n++) {
    await tick(0.35 + n * 0.1, 'leg' + n);
    const s = walkingLegSpec(n);
    const hh = s.mh * 0.5;
    const by = hh + 0.06, bz = hh * 0.8 + 0.05;
    const L = {
      cb: makeGeometry(coxaBasisSDF(s.Lcb, hh * 0.78), [-0.2, -by, -bz], [s.Lcb + 0.1, by, bz], 0.014, legZone(s.Lcb, { paleEnds: 0.3, pale0: 0.25 })),
      merus: makeGeometry(merusSDF(s.Lm, s.mh), [-0.1, -by, -bz], [s.Lm + 0.1, by, bz], 0.012, legZone(s.Lm, { paleEnds: 0.6, pale0: 0.02 })),
      carpus: makeGeometry(carpusSDF(s.Lca, s.mh), [-0.1, -by, -bz], [s.Lca + 0.08, by, bz], 0.011, legZone(s.Lca, { paleEnds: 0.7, pale0: 0.05 })),
      propodus: makeGeometry(propodusSDF(s.Lp, s.mh), [-0.08, -by, -bz], [s.Lp + 0.06, by, bz], 0.01, legZone(s.Lp, { paleEnds: 0.6, pale0: 0.08 })),
      dactyl: makeGeometry(dactylSDF(s.Ld, s.mh), [-0.06, -by, -bz], [s.Ld + 0.04, 0.1, bz], 0.007, legZone(s.Ld, { tipDark: 1.0, paleEnds: 0.3, pale0: 0.05 }), { res: 1.6 }),
    };
    parts.legs[n] = L;
  }

  // 鉗脚: 雄の大鋏(1.0)・小鋏(0.55)・雌(0.45)
  parts.chela = {};
  let k = 0;
  for (const size of [1.0, 0.55, 0.4]) {
    await tick(0.8 + k++ * 0.06, 'chela');
    const sp = chelaSpec(size);
    const pal = sp.palmL + sp.fingerL;
    parts.chela[size] = {
      spec: sp,
      cb: makeGeometry(coxaBasisSDF(sp.Lcb, 0.12 + 0.02 * size), [-0.2, -0.2, -0.18], [sp.Lcb + 0.1, 0.2, 0.18], 0.014, legZone(sp.Lcb, { paleEnds: 0.3, pale0: 0.25 })),
      merus: makeGeometry(chelaMerusSDF(sp), [-0.12, -0.25, -0.2], [sp.Lm + 0.1, 0.28, 0.2], 0.013, legZone(sp.Lm, { paleEnds: 0.5, pale0: 0.02 })),
      carpus: makeGeometry(chelaCarpusSDF(sp), [-0.25, -0.25, -0.25], [sp.Lca + 0.25, 0.28, 0.35], 0.012, legZone(sp.Lca, { paleEnds: 0.4, pale0: 0.02 })),
      propodus: makeGeometry(chelaPropodusSDF(sp), [-0.2, -sp.palmH * 0.7 - 0.05, -sp.palmW * 0.7 - 0.02], [pal + 0.08, sp.palmH * 0.7 + 0.05, sp.palmW * 0.7 + 0.02], 0.011, (x, y, z, nx, ny, nz) => {
        const f = chelaFingerZone(sp.palmL * 0.85, sp.fingerL + 0.1)(x, y, z, nx, ny, nz);
        f[1] = clamp(f[1] + sstep(0.1, -0.8, ny) * 0.3, 0, 1);
        return f;
      }),
      dactyl: makeGeometry(chelaDactylSDF(sp), [-0.2, -sp.palmH * 0.6 - 0.1, -sp.palmW * 0.5 - 0.02], [sp.fingerL + 0.12, sp.palmH * 0.35, sp.palmW * 0.5 + 0.02], 0.009, chelaFingerZone(-0.02, sp.fingerL + 0.08)),
    };
  }
  await tick(1, 'done');
  return parts;
}
