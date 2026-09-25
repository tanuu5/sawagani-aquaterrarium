import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PostFX } from './core/post.js';
import { shared, LAYER_FX, WATER_LEVEL, yieldFrame } from './core/shared.js';
import { buildRoom, buildEnvScene } from './world/room.js';
import { buildTank } from './world/tank.js';
import { buildTerrain, heightSampler } from './world/terrain.js';
import { buildRocks } from './world/rocks.js';
import { buildWater, RippleSim } from './world/water.js';
import { ROCKS, setHeightSampler } from './world/layout.js';
import { buildPebbles } from './world/pebbles.js';
import { buildMossCarpet, buildSugigoke, buildRockMoss } from './world/moss.js';
import { NavMap } from './world/nav.js';
import { Foods, Bubbles } from './world/life.js';
import { buildFerns, buildAcorus } from './world/plants.js';
import { buildLeafLitter, buildDriftwood } from './world/decor.js';
import { buildWaterfall } from './world/waterfall.js';
import { startCrabParts } from './crab/crabModel.js';
import { Crab } from './crab/crab.js';

const loadbar = document.getElementById('loadbar');
const loadmsg = document.getElementById('loadmsg');
const loadTimes = [];
async function progress(p, msg) {
  loadTimes.push([msg, Math.round(performance.now())]);
  loadbar.style.width = `${Math.round(p * 100)}%`;
  if (msg) loadmsg.textContent = msg;
  await yieldFrame();
}

const app = document.getElementById('app');
if (!document.createElement('canvas').getContext('webgl2')) {
  loadmsg.textContent = 'このブラウザは WebGL2 に対応していないため表示できません。最新の Chrome・Edge・Safari・Firefox でお試しください。';
  throw new Error('WebGL2 is not available');
}
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.NoToneMapping;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 1, 1500);
camera.position.set(1.5, 26, 55);
camera.layers.enable(LAYER_FX);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.5, 7, 0.5);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 9;
controls.maxDistance = 120;
controls.maxPolarAngle = THREE.MathUtils.degToRad(96);
controls.update();

const post = new PostFX(renderer, { samples: 4 });

// 描画解像度はフレーム時間を見て自動調整する
const isMobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const maxPR = Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.75);
let pixelRatio = Math.min(maxPR, isMobile ? 1.0 : 1.3);
const perf = { acc: 0, n: 0, last: 0, good: 0, cool: 2 };
function adaptResolution(now) {
  if (!now) return;
  if (!perf.last) { perf.last = now; return; }
  const dt = now - perf.last;
  perf.last = now;
  if (dt > 250) return;
  perf.acc += dt; perf.n++;
  if (perf.acc < 1000) return;
  const avg = perf.acc / perf.n;
  perf.acc = 0; perf.n = 0;
  if (perf.cool > 0) { perf.cool--; return; }
  if (avg > 21 && pixelRatio > 0.6) {
    pixelRatio = Math.max(0.6, pixelRatio * 0.86);
    resize(); perf.cool = 1; perf.good = 0;
  } else if (avg < 17.8) {
    if (++perf.good >= 4 && pixelRatio < maxPR) {
      pixelRatio = Math.min(maxPR, pixelRatio * 1.08);
      resize(); perf.good = 0; perf.cool = 1;
    }
  } else perf.good = 0;
}
function resize() {
  const w = app.clientWidth || window.innerWidth;
  const h = app.clientHeight || window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面では画角を広げて水槽が収まりやすくする
  camera.fov = camera.aspect < 1 ? Math.min(48, 30 / Math.sqrt(camera.aspect)) : 30;
  camera.updateProjectionMatrix();
  post.setSize(Math.floor(w * pixelRatio), Math.floor(h * pixelRatio));
}
window.addEventListener('resize', resize);
resize();

const world = { scene, camera, renderer, post, controls, crabs: [], loadTimes };
const env = {
  nav: null, ripple: null, crabs: world.crabs, foods: null, shelters: [], night: 0, camera,
  findFood: (c) => (env.foods ? env.foods.find(c) : null),
  onBite: (c) => env.foods && env.foods.bite(c),
  onFoam: (c) => env.bubbles && env.bubbles.foam.start(c),
  onBubble: (c) => {
    if (!env.bubbles) return;
    const m = c.mouthWorld(new THREE.Vector3());
    if (m.y < WATER_LEVEL - 0.1) env.bubbles.emit(m, 0.03 + Math.random() * 0.04, 4 + Math.random() * 3);
  },
};
world.env = env;

async function init() {
  if (location.search.includes('crab')) {
    const { runCrabViewer } = await import('./crab/viewer.js');
    await runCrabViewer(renderer, post, app);
    return;
  }
  // カニの形状生成は別スレッドで先に始めておく
  let crabProgress = 0;
  const crabPartsPromise = startCrabParts((p) => { crabProgress = p; });
  await progress(0.04, '部屋を整えています…');
  world.room = buildRoom(scene);
  world.tank = buildTank(scene);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envOpts = { size: 256, position: new THREE.Vector3(0, 10, 0) };
  world.envDay = pmrem.fromScene(buildEnvScene({ night: 0 }), 0.02, 0.1, 1000, envOpts).texture;
  world.envNight = pmrem.fromScene(buildEnvScene({ night: 1 }), 0.02, 0.1, 1000, envOpts).texture;
  scene.environment = world.envDay;
  scene.environmentIntensity = 0.38;
  world.pmrem = pmrem;

  await progress(0.1, '底床を敷いています…');
  world.terrain = buildTerrain(scene);
  setHeightSampler(heightSampler(world.terrain.field));

  await progress(0.18, '石を組んでいます…');
  world.rocks = buildRocks(scene);

  await progress(0.26, '砂利をまいています…');
  world.pebbles = buildPebbles(scene);

  await progress(0.32, '苔を育てています…');
  world.moss = buildMossCarpet(scene, world.terrain.field);
  world.rockMoss = buildRockMoss(scene, world.rocks.rocks);
  world.sugigoke = buildSugigoke(scene);

  await progress(0.35, 'シダを植えています…');
  world.ferns = buildFerns(scene);
  world.acorus = buildAcorus(scene);
  world.litter = buildLeafLitter(scene);
  world.wood = buildDriftwood(scene);

  await progress(0.38, '水を張っています…');
  world.water = buildWater(scene, { terrainField: world.terrain.field, post });
  world.ripple = new RippleSim(renderer, world.water.rect, 0.09);
  env.ripple = world.ripple;

  await progress(0.42, '地形を測っています…');
  env.nav = new NavMap(renderer, scene);
  world.ripple.setMask((x, z) => env.nav.groundAt(x, z) < WATER_LEVEL - 0.02);
  world.waterfall = buildWaterfall(scene, { rocks: world.rocks.rocks, nav: env.nav, post });
  // 隠れ家（シェルター石の下と岩陰）
  const slab = ROCKS.find((r) => r.id === 'slab');
  const ax = Math.cos(slab.rotY), az = -Math.sin(slab.rotY);
  const spots = [
    // 平石の下（長手方向に3か所）
    [slab.x, slab.z, 0, 6], [slab.x + ax * 1.6, slab.z + az * 1.6, 0, 6], [slab.x - ax * 1.6, slab.z - az * 1.6, 0, 6],
    // 岩陰
    [-6.0, -3.6, 0.5, 6], [-14.0, -2.0, 3, 5], [6.0, -6.6, -1, 6],
  ];
  env.shelters = spots.map(([x, z, fx, fz]) => {
    const p = env.nav.nearestWalkable(x, z);
    p.face = [fx, fz];
    return p;
  });

  await progress(0.46, 'サワガニを起こしています…');
  const tick = setInterval(() => { loadbar.style.width = `${Math.round((0.46 + crabProgress * 0.44) * 100)}%`; }, 200);
  const parts = await crabPartsPromise;
  clearInterval(tick);
  const defs = [
    { name: 'チャコ', sex: 'male', palette: 'brown', scale: 0.95, x: -4, z: 3.5, heading: 0.4, seed: 11, boldness: 0.7, activity: 0.6, water: 0.4 },
    { name: 'ベニ', sex: 'female', palette: 'red', scale: 0.84, x: -9.5, z: 7.5, heading: -0.6, seed: 23, boldness: 0.4, activity: 0.5, water: 0.6 },
    { name: 'アオ', sex: 'male', palette: 'blue', scale: 0.86, x: 3.5, z: 6.8, heading: 2.2, seed: 37, boldness: 0.55, activity: 0.7, water: 0.8, bigRight: false },
  ];
  for (const d of defs) {
    const [x, z] = env.nav.nearestWalkable(d.x, d.z, true);
    const c = new Crab(parts, { ...d, x, z }, env);
    scene.add(c.group);
    world.crabs.push(c);
  }

  env.foods = new Foods(scene, env);
  env.bubbles = new Bubbles(scene, env);

  const { Controller } = await import('./ui/controller.js');
  world.ui = new Controller(world);
  env.onSplash = () => world.ui.sound.splash();

  await progress(0.96, '仕上げています…');
  // 最初のフレームで固まらないよう、シェーダーを先にコンパイルしておく
  try {
    camera.layers.enableAll();
    // 実際の描画先（HDR のレンダーターゲット）と同じ条件でコンパイルする
    renderer.setRenderTarget(post.rtScene);
    renderer.compile(scene, camera);
    renderer.setRenderTarget(null);
    camera.layers.set(0);
    camera.layers.enable(LAYER_FX);
  } catch (e) { console.warn(e); }
  await progress(1, '');
  document.getElementById('loader').classList.add('done');
  start();
}

const clock = new THREE.Timer();
function start() {
  renderer.setAnimationLoop(frame);
}

let simTime = 0;
// シミュレーションだけを進める（描画なし）
function simulate(dt) {
  simTime += dt;
  const t = simTime;
  shared.uTime.value = t;
  for (const c of world.crabs) c.update(dt);
  if (env.foods) env.foods.update(dt);
  if (env.bubbles) env.bubbles.update(dt);
  if (world.ui) world.ui.update(dt, t);
  controls.update();
  return t;
}
function frame(now) {
  adaptResolution(now);
  clock.update();
  const dt = window.__fixedDt || Math.min(clock.getDelta(), 1 / 20);
  const t = simulate(dt);
  if (world.ripple) {
    if (world.waterfall) world.waterfall.update(dt, world.ripple);
    world.ripple.step(5);
    world.water.uniforms.uResolution.value.set(post.width, post.height);
  }
  post.render(scene, camera, dt, t);
}
world.frame = frame;
world.simulate = (seconds, dt = 1 / 30) => {
  for (let s = 0; s < seconds; s += dt) { simulate(dt); scene.updateMatrixWorld(); }
};

window.__kani = world;
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  import('./core/debug.js').then(({ installShot }) => installShot(renderer, () => (window.__frame ? window.__frame() : frame())));
}
init().catch((e) => {
  console.error(e);
  const el = document.getElementById('err');
  el.hidden = false;
  el.textContent += (e.stack || e.message || e) + '\n';
});
