import * as THREE from 'three';
import { TANK, LAYER_NAV, LAYER_CEIL, WATER_LEVEL } from '../core/shared.js';
import { clamp } from '../core/rng.js';

// 上から見た「歩ける面の高さ」と、シェルター石の「天井の高さ」を GPU で焼く
export class NavMap {
  constructor(renderer, scene, res = 0.1) {
    this.x0 = TANK.ix0; this.x1 = TANK.ix1; this.z0 = TANK.iz0; this.z1 = TANK.iz1;
    this.res = res;
    this.nx = Math.ceil((this.x1 - this.x0) / res);
    this.nz = Math.ceil((this.z1 - this.z0) / res);
    this.ground = this._bake(renderer, scene, LAYER_NAV, false);
    this.ceil = this._bake(renderer, scene, LAYER_CEIL, true);
    this._buildGrid();
  }

  _bake(renderer, scene, layer, fromBelow) {
    const rt = new THREE.WebGLRenderTarget(this.nx, this.nz, { type: THREE.FloatType, depthBuffer: true });
    const cam = new THREE.OrthographicCamera(this.x0, this.x1, this.z1, this.z0, 0.1, 200);
    // 上から: x→右, z→下（画像の行）になるよう設定
    if (fromBelow) {
      cam.position.set(0, -50, 0);
      cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
      cam.left = -this.x1; cam.right = -this.x0; cam.top = -this.z0; cam.bottom = -this.z1;
    } else {
      cam.position.set(0, 100, 0);
      cam.up.set(0, 0, -1);
      cam.lookAt(0, 0, 0);
      cam.left = this.x0; cam.right = this.x1; cam.top = -this.z0; cam.bottom = -this.z1;
    }
    cam.updateProjectionMatrix();
    cam.layers.set(layer);
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying float vY; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vY = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'varying float vY; void main(){ gl_FragColor = vec4(vY + 50.0, 0.0, 0.0, 1.0); }',
      side: THREE.DoubleSide,
    });
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    scene.overrideMaterial = mat;
    scene.background = null;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    const buf = new Float32Array(this.nx * this.nz * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, this.nx, this.nz, buf);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    rt.dispose();
    mat.dispose();
    const out = new Float32Array(this.nx * this.nz);
    // 行: 画像の下 (row 0) が z1 側（手前）→ z = z1 - (row+0.5)*res
    for (let j = 0; j < this.nz; j++) {
      for (let i = 0; i < this.nx; i++) {
        const src = (j * this.nx + i) * 4;
        // row j は z = z1 - (j + 0.5) * res に対応。z0 から数えた行へ並べ替え
        const zj = this.nz - 1 - j;
        const raw = buf[src];
        let v;
        if (raw <= 0.001) v = fromBelow ? 100 : -10;
        else v = raw - 50;
        // 下からのカメラは左右が反転する
        const ii = fromBelow ? this.nx - 1 - i : i;
        out[zj * this.nx + ii] = v;
      }
    }
    return out;
  }

  _sample(arr, x, z) {
    let fx = (x - this.x0) / this.res - 0.5, fz = (z - this.z0) / this.res - 0.5;
    fx = clamp(fx, 0, this.nx - 1.001); fz = clamp(fz, 0, this.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const a = arr[j * this.nx + i], b = arr[j * this.nx + i + 1], c = arr[(j + 1) * this.nx + i], d = arr[(j + 1) * this.nx + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
  groundAt(x, z) { return this._sample(this.ground, x, z); }
  ceilAt(x, z) { return this._sample(this.ceil, x, z); }
  normalAt(x, z, e = 0.25, out = new THREE.Vector3()) {
    const hx = this.groundAt(x + e, z) - this.groundAt(x - e, z);
    const hz = this.groundAt(x, z + e) - this.groundAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }
  inWater(x, z) { return this.groundAt(x, z) < WATER_LEVEL - 0.3; }

  // A* 用の粗いグリッド
  _buildGrid() {
    const cs = 0.5;
    this.cs = cs;
    this.gx = Math.floor((this.x1 - this.x0) / cs);
    this.gz = Math.floor((this.z1 - this.z0) / cs);
    const n = this.gx * this.gz;
    this.gH = new Float32Array(n);
    this.gCost = new Float32Array(n);
    this.gClear = new Float32Array(n);
    for (let j = 0; j < this.gz; j++) {
      for (let i = 0; i < this.gx; i++) {
        const cx = this.x0 + (i + 0.5) * cs, cz = this.z0 + (j + 0.5) * cs;
        let hmax = -1e9, hmin = 1e9, cmin = 1e9;
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
          const h = this.groundAt(cx + a * cs * 0.3, cz + b * cs * 0.3);
          hmax = Math.max(hmax, h); hmin = Math.min(hmin, h);
          cmin = Math.min(cmin, this.ceilAt(cx + a * cs * 0.3, cz + b * cs * 0.3));
        }
        const k = j * this.gx + i;
        this.gH[k] = hmax;
        this.gClear[k] = cmin - hmax;
      }
    }
    // 斜面コスト
    for (let j = 0; j < this.gz; j++) {
      for (let i = 0; i < this.gx; i++) {
        const k = j * this.gx + i;
        let steep = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
          if (!a && !b) continue;
          const ii = i + a, jj = j + b;
          if (ii < 0 || jj < 0 || ii >= this.gx || jj >= this.gz) continue;
          const d = Math.hypot(a, b) * cs;
          steep = Math.max(steep, Math.abs(this.gH[jj * this.gx + ii] - this.gH[k]) / d);
        }
        const cx = this.x0 + (i + 0.5) * cs, cz = this.z0 + (j + 0.5) * cs;
        const edge = Math.min(cx - this.x0, this.x1 - cx, cz - this.z0, this.z1 - cz);
        let cost = 1 + steep * 1.6;
        if (steep > 1.35) cost = Infinity;
        if (this.gClear[k] < 0.95) cost = Infinity;
        if (edge < 1.0) cost = Infinity;
        else if (edge < 2.0) cost += 1.5;
        this.gCost[k] = cost;
      }
    }
  }

  cellOf(x, z) {
    return [clamp(Math.floor((x - this.x0) / this.cs), 0, this.gx - 1), clamp(Math.floor((z - this.z0) / this.cs), 0, this.gz - 1)];
  }
  cellCenter(i, j) {
    return [this.x0 + (i + 0.5) * this.cs, this.z0 + (j + 0.5) * this.cs];
  }
  passable(x, z) {
    const [i, j] = this.cellOf(x, z);
    return this.gCost[j * this.gx + i] < Infinity;
  }

  // 最寄りの通行可能セル
  nearestPassable(x, z) {
    const [ci, cj] = this.cellOf(x, z);
    for (let r = 0; r < 20; r++) {
      for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
        const i = ci + a, j = cj + b;
        if (i < 0 || j < 0 || i >= this.gx || j >= this.gz) continue;
        if (this.gCost[j * this.gx + i] < Infinity) return this.cellCenter(i, j);
      }
    }
    return [x, z];
  }

  findPath(sx, sz, tx, tz) {
    const [si, sj] = this.cellOf(sx, sz);
    let [ti, tj] = this.cellOf(tx, tz);
    const gx = this.gx, n = this.gx * this.gz;
    if (this.gCost[tj * gx + ti] === Infinity) {
      const p = this.nearestPassable(tx, tz);
      [ti, tj] = this.cellOf(p[0], p[1]);
    }
    const g = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const open = [];
    const start = sj * gx + si, goal = tj * gx + ti;
    g[start] = 0;
    const h = (k) => { const i = k % gx, j = (k / gx) | 0; return Math.hypot(i - ti, j - tj); };
    open.push([h(start), start]);
    let iter = 0;
    while (open.length && iter++ < 6000) {
      // 小規模なので線形探索で十分
      let bi = 0;
      for (let q = 1; q < open.length; q++) if (open[q][0] < open[bi][0]) bi = q;
      const [, cur] = open.splice(bi, 1)[0];
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = cur % gx, cj = (cur / gx) | 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        if (!a && !b) continue;
        const ni = ci + a, nj = cj + b;
        if (ni < 0 || nj < 0 || ni >= gx || nj >= this.gz) continue;
        const nk = nj * gx + ni;
        const c = this.gCost[nk];
        if (c === Infinity && nk !== start) continue;
        const ng = g[cur] + Math.hypot(a, b) * (c === Infinity ? 50 : c);
        if (ng < g[nk]) {
          g[nk] = ng;
          came[nk] = cur;
          open.push([ng + h(nk), nk]);
        }
      }
    }
    if (came[goal] === -1 && goal !== start) return null;
    const cells = [];
    for (let k = goal; k !== -1 && k !== start; k = came[k]) cells.push(k);
    cells.reverse();
    const pts = cells.map((k) => this.cellCenter(k % gx, (k / gx) | 0));
    pts.push([tx, tz]);
    if (!this.passable(tx, tz)) pts[pts.length - 1] = this.cellCenter(ti, tj);
    return this._smooth([[sx, sz], ...pts]);
  }

  _lineClear(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (this.cs * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (!this.passable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
  _smooth(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this._lineClear(pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  randomPoint(rng, pred, tries = 200) {
    for (let t = 0; t < tries; t++) {
      const x = rng.range(this.x0 + 1.5, this.x1 - 1.5);
      const z = rng.range(this.z0 + 1.5, this.z1 - 1.5);
      if (!this.passable(x, z)) continue;
      if (pred && !pred(x, z)) continue;
      return [x, z];
    }
    return null;
  }
}
