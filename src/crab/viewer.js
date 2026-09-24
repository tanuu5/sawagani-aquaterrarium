// デバッグ用: カニ単体のスタジオビュー（?crab）
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildCrabParts } from './crabModel.js';
import { CrabRig, PALETTES } from './crabRig.js';
import { shared } from '../core/shared.js';

export async function runCrabViewer(renderer, post, app) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, app.clientWidth / app.clientHeight, 0.1, 200);
  camera.position.set(3.2, 4.2, 6.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.update();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(2, 6, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -4; key.shadow.camera.right = 4; key.shadow.camera.top = 4; key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0003;
  key.shadow.radius = 2;
  key.layers.enableAll();
  scene.add(key);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x6b655c, roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  shared.uWaterLevel.value = -100;

  const t0 = performance.now();
  const parts = await buildCrabParts();
  console.log('crab parts built in', (performance.now() - t0).toFixed(0), 'ms');
  const params = new URLSearchParams(location.search);
  const pal = PALETTES[params.get('pal') || 'brown'];
  const rig = new CrabRig(parts, { sex: params.get('sex') || 'male', palette: pal });
  const group = new THREE.Group();
  group.add(rig.mesh);
  scene.add(group);
  const H = 0.7;
  rig.root.position.set(0, H, 0);
  const homes = rig.legs.map((leg) => {
    const r = [0, 2.5, 2.85, 2.8, 2.45][leg.n];
    const dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), leg.theta);
    return leg.attach.clone().addScaledVector(dir, r).setY(-H);
  });
  let tri = 0;
  rig.mesh.geometry.index && (tri = rig.mesh.geometry.index.count / 3);
  console.log('crab triangles', tri);
  window.__crab = { rig, scene, camera, controls, homes, group };

  const clock = new THREE.Timer();
  post.params.fstop = 11;
  const loop = () => {
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.getElapsed();
    shared.uTime.value = t;
    rig.legs.forEach((leg, i) => {
      const lift = Math.max(0, Math.sin(t * 3 + (leg.n + (leg.side > 0 ? 0 : 1)) * Math.PI)) * 0.25 * (params.has('walk') ? 1 : 0);
      rig.solveLeg(leg, homes[i].clone().add(new THREE.Vector3(0, lift, 0)));
    });
    camera.aspect = app.clientWidth / app.clientHeight;
    camera.updateProjectionMatrix();
    controls.update();
    post.render(scene, camera, dt, t);
  };
  window.__frame = loop;
  renderer.setAnimationLoop(loop);
  document.getElementById('loader').classList.add('done');
}
