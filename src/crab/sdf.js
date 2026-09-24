// SDF ユーティリティと Surface Nets によるメッシュ化

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const mix = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}
export function smax(a, b, k) {
  return -smin(-a, -b, k);
}
export function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.sqrt((x * x) / (rx * rx) + (y * y) / (ry * ry) + (z * z) / (rz * rz));
  const k1 = Math.sqrt((x * x) / (rx * rx * rx * rx) + (y * y) / (ry * ry * ry * ry) + (z * z) / (rz * rz * rz * rz));
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}
export function sdSphere(x, y, z, r) {
  return Math.sqrt(x * x + y * y + z * z) - r;
}
// 線分カプセル
export function sdCapsule(x, y, z, ax, ay, az, bx, by, bz, r) {
  const px = x - ax, py = y - ay, pz = z - az;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const h = clamp((px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz), 0, 1);
  const qx = px - dx * h, qy = py - dy * h, qz = pz - dz * h;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
}
// 円錐台（丸め付き）: a から b へ半径 ra→rb
export function sdRoundCone(x, y, z, ax, ay, az, bx, by, bz, ra, rb) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yv = pax * bax + pay * bay + paz * baz;
  const zv = yv - l2;
  const xx = pax * l2 - bax * yv, xy = pay * l2 - bay * yv, xz = paz * l2 - baz * yv;
  const x2 = xx * xx + xy * xy + xz * xz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - ra;
}

// 2D 閉曲線の符号付き距離場（グリッドに焼いて双線形補間）
export class Outline2D {
  constructor(points, bounds, res) {
    // points: [[x,z],...] 閉曲線
    this.x0 = bounds[0]; this.z0 = bounds[1]; this.x1 = bounds[2]; this.z1 = bounds[3];
    this.res = res;
    this.nx = Math.ceil((this.x1 - this.x0) / res) + 1;
    this.nz = Math.ceil((this.z1 - this.z0) / res) + 1;
    this.grid = new Float32Array(this.nx * this.nz);
    const n = points.length;
    for (let j = 0; j < this.nz; j++) {
      const pz = this.z0 + j * res;
      for (let i = 0; i < this.nx; i++) {
        const px = this.x0 + i * res;
        let d = 1e9, s = 1;
        for (let k = 0, l = n - 1; k < n; l = k++) {
          const ax = points[l][0], az = points[l][1], bx = points[k][0], bz = points[k][1];
          const ex = bx - ax, ez = bz - az;
          const wx = px - ax, wz = pz - az;
          const h = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1);
          const qx = wx - ex * h, qz = wz - ez * h;
          d = Math.min(d, qx * qx + qz * qz);
          const c1 = pz >= az, c2 = pz < bz, c3 = ex * wz > ez * wx;
          if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
        }
        this.grid[j * this.nx + i] = s * Math.sqrt(d);
      }
    }
  }
  sample(x, z) {
    let fx = (x - this.x0) / this.res, fz = (z - this.z0) / this.res;
    const outside = Math.max(0, -fx, fx - (this.nx - 1), -fz, fz - (this.nz - 1)) * this.res;
    fx = clamp(fx, 0, this.nx - 1.001); fz = clamp(fz, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const g = this.grid, nx = this.nx;
    const a = g[j * nx + i], b = g[j * nx + i + 1], c = g[(j + 1) * nx + i], d = g[(j + 1) * nx + i + 1];
    return mix(mix(a, b, tx), mix(c, d, tx), tz) + outside;
  }
}

// Catmull-Rom で閉曲線を滑らかに
export function smoothClosed(pts, perSeg = 8) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

// Surface Nets
export function surfaceNets(sdf, bmin, bmax, h, { project = true } = {}) {
  const nx = Math.ceil((bmax[0] - bmin[0]) / h) + 1;
  const ny = Math.ceil((bmax[1] - bmin[1]) / h) + 1;
  const nz = Math.ceil((bmax[2] - bmin[2]) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  const idx = (i, j, k) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) {
    const z = bmin[2] + k * h;
    for (let j = 0; j < ny; j++) {
      const y = bmin[1] + j * h;
      let o = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        F[o++] = sdf(bmin[0] + i * h, y, z);
      }
    }
  }
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1;
  const cellV = new Int32Array(cnx * cny * cnz).fill(-1);
  const cidx = (i, j, k) => (k * cny + j) * cnx + i;
  const pos = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < cnz; k++) {
    for (let j = 0; j < cny; j++) {
      for (let i = 0; i < cnx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const cc = corners[c];
          v[c] = F[idx(i + cc[0], j + cc[1], k + cc[2])];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of edges) {
          const va = v[a], vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ca = corners[a], cb = corners[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          cnt++;
        }
        cellV[cidx(i, j, k)] = pos.length / 3;
        pos.push(bmin[0] + (i + sx / cnt) * h, bmin[1] + (j + sy / cnt) * h, bmin[2] + (k + sz / cnt) * h);
      }
    }
  }
  const index = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const in0 = F[idx(i, j, k)] < 0;
        if (in0 !== (F[idx(i + 1, j, k)] < 0)) {
          quad(cellV[cidx(i, j - 1, k - 1)], cellV[cidx(i, j, k - 1)], cellV[cidx(i, j, k)], cellV[cidx(i, j - 1, k)], !in0);
        }
        if (in0 !== (F[idx(i, j + 1, k)] < 0)) {
          quad(cellV[cidx(i - 1, j, k - 1)], cellV[cidx(i - 1, j, k)], cellV[cidx(i, j, k)], cellV[cidx(i, j, k - 1)], !in0);
        }
        if (in0 !== (F[idx(i, j, k + 1)] < 0)) {
          quad(cellV[cidx(i - 1, j - 1, k)], cellV[cidx(i, j - 1, k)], cellV[cidx(i, j, k)], cellV[cidx(i - 1, j, k)], !in0);
        }
      }
    }
  }
  // 法線（SDF 勾配）と面への投影
  const n = pos.length / 3;
  const normals = new Float32Array(n * 3);
  const e = h * 0.5;
  const P = new Float32Array(pos);
  for (let q = 0; q < n; q++) {
    let x = P[q * 3], y = P[q * 3 + 1], z = P[q * 3 + 2];
    for (let it = 0; it < (project ? 2 : 1); it++) {
      const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
      const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
      const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      if (project && it === 0) {
        const f = sdf(x, y, z);
        const s = (f * 2 * e) / (gl * gl);
        const mx = clamp(-gx * s, -h, h), my = clamp(-gy * s, -h, h), mz = clamp(-gz * s, -h, h);
        x += mx; y += my; z += mz;
      } else {
        normals[q * 3] = gx / gl; normals[q * 3 + 1] = gy / gl; normals[q * 3 + 2] = gz / gl;
      }
    }
    P[q * 3] = x; P[q * 3 + 1] = y; P[q * 3 + 2] = z;
  }
  return { positions: P, normals, index: new Uint32Array(index) };
}
