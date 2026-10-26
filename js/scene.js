// Scene dressing: HDRI sky, sun, ground, ocean, wind arrow, salt spray and the
// salt-shear surface visualisation.

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { createGroundMaterial } from './materials.js?v=20261026172943';
import { windVectors } from './oakGenerator.js?v=20261026172943';
import ATMOSPHERES from '../assets/atmospheres.json?v=20261026172943' with { type: 'json' };

export { ATMOSPHERES };
const hdrCache = new Map();
function loadSky(scene, name) {
  const apply = (hdr) => {
    scene.background = hdr;
    scene.environment = hdr;
  };
  if (hdrCache.has(name)) {
    const v = hdrCache.get(name);
    if (v) apply(v);
    return;
  }
  hdrCache.set(name, null);
  new RGBELoader().load(`assets/hdri/${name}_2k.hdr`, (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    hdrCache.set(name, hdr);
    if (scene.userData.sky === name) apply(hdr);
  });
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export function createEnvironment(scene, renderer) {
  const env = {};
  scene.fog = new THREE.FogExp2(0xc9d3d6, 0.004);

  scene.userData.sky = ATMOSPHERES.clear.hdri;
  loadSky(scene, scene.userData.sky);
  scene.environmentIntensity = 0.75;
  scene.backgroundIntensity = 0.9;

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 1; sc.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  env.sun = sun;

  const ground = new THREE.Mesh(new THREE.CircleGeometry(160, 96), createGroundMaterial('hammock', false));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  env.ground = ground;
  env.groundKey = 'hammock|false';

  // Ocean on the windward side.
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x1f4a57, roughness: 0.32, metalness: 0.0, envMapIntensity: 0.45 }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(0, 0.03, 365); // near shore 65 m upwind
  env.ocean = new THREE.Group(); // rotated so local +Z points upwind
  env.ocean.add(ocean);
  scene.add(env.ocean);

  // Retention pond: dark, tannin-stained Florida water.
  env.pond = new THREE.Mesh(
    new THREE.CircleGeometry(1, 72),
    new THREE.MeshStandardMaterial({ color: 0x1d2a1f, roughness: 0.06, metalness: 0.0, envMapIntensity: 0.9 }),
  );
  env.pond.rotation.x = -Math.PI / 2;
  env.pond.receiveShadow = true;
  env.pond.visible = false;
  scene.add(env.pond);

  env.arrow = makeWindArrow();
  scene.add(env.arrow);
  env.spray = makeSpray();
  scene.add(env.spray.points);
  env.shearMesh = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64),
    new THREE.MeshBasicMaterial({ color: 0x3fb0c8, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
  );
  env.shearWire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.CircleGeometry(1, 32, 0, Math.PI * 2)),
    new THREE.LineBasicMaterial({ color: 0x7fd8ea, transparent: true, opacity: 0.5 }),
  );
  env.shearMesh.add(env.shearWire);
  scene.add(env.shearMesh);
  return env;
}

export function sunDirection(timeOfDay) {
  // Simple solar arc for ~30.6°N (Amelia Island) in late spring: east -> south -> west.
  const t = (timeOfDay - 6) / 13.5; // 0 sunrise, 1 sunset
  const az = THREE.MathUtils.degToRad(70 + t * 220); // compass azimuth
  const el = Math.max(0.03, Math.sin(Math.PI * t)) * THREE.MathUtils.degToRad(72);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export function updateEnvironment(env, scene, renderer, p, sk) {
  const dir = sunDirection(p.timeOfDay);
  env.sun.position.copy(dir).multiplyScalar(70);
  env.sun.target.position.set(0, 4, 0);
  const warm = THREE.MathUtils.smoothstep(dir.y, 0.05, 0.5);
  const atm = ATMOSPHERES[p.atmosphere] || ATMOSPHERES.clear;
  const [tr, tg, tb] = atm.sunTint;
  env.sun.color.setRGB(tr, (0.72 + 0.22 * warm) * tg, (0.5 + 0.38 * warm) * tb);
  env.sun.intensity = (0.6 + 2.8 * warm) * atm.sun;
  renderer.toneMappingExposure = p.exposure * atm.exposure;
  scene.fog.color.set(atm.fogColor);
  scene.fog.density = (0.0015 + p.fog * 0.012) * atm.fog;
  scene.environmentIntensity = atm.env;
  scene.backgroundIntensity = atm.bg;
  if (scene.userData.sky !== atm.hdri) {
    scene.userData.sky = atm.hdri;
    loadSky(scene, atm.hdri);
  }

  const canopyR = Math.max(4, sk.shear.spread || p.limbLength);
  const key = `${p.ground}|${p.rootXray}`;
  if (env.groundKey !== key) {
    env.ground.material.dispose();
    env.ground.material = createGroundMaterial(p.ground, p.rootXray, canopyR);
    env.groundKey = key;
  }
  env.ground.material.userData.uniforms.uCanopyR.value = canopyR;
  env.ground.renderOrder = p.rootXray ? 2 : 0;

  const { from, lee } = windVectors(p);
  env.ocean.visible = p.showOcean;
  env.ocean.rotation.y = Math.atan2(from.x, from.z);

  env.pond.visible = !!sk.pond;
  if (sk.pond) {
    const key = JSON.stringify(sk.pond.outline[0]) + sk.pond.outline.length;
    if (env.pondKey !== key) {
      // Shape is drawn in XY, then laid flat: shape y = -world z.
      const shape = new THREE.Shape(sk.pond.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
      env.pond.geometry.dispose();
      env.pond.geometry = new THREE.ShapeGeometry(shape, 4);
      env.pondKey = key;
    }
    env.pond.position.set(0, 0.05, 0);
    env.pond.scale.setScalar(1);
  }

  // Arrow sits upwind of the tree pointing downwind.
  env.arrow.visible = p.showArrow;
  env.arrow.position.set(from.x * 22, 0.3, from.z * 22);
  env.arrow.rotation.y = Math.atan2(lee.x, lee.z);
  env.arrow.scale.setScalar(0.6 + p.windStrength * 0.8);

  env.spray.points.visible = p.showSpray && p.windStrength > 0.02;
  env.spray.lee.copy(lee);
  env.spray.speed = 3 + p.windStrength * 14;
  env.spray.points.material.opacity = 0.03 + 0.09 * p.saltExposure;

  // Shear surface: the actual (inclined, domed) salt-pruning envelope, drawn
  // over the crown footprint.
  const sh = sk.shear;
  env.shearMesh.visible = p.showShear && sh.severity > 0.01;
  if (env.shearMesh.visible) {
    const R = Math.max(6, sh.spread * 1.15);
    const g = new THREE.CircleGeometry(R, 48, 0, Math.PI * 2);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r2 = (x * x + z * z) / (sh.spread * sh.spread);
      pos.setY(i, sh.base + sh.slope * (x * sh.lee[0] + z * sh.lee[2]) - sh.base * 0.2 * r2);
    }
    g.computeVertexNormals();
    env.shearMesh.geometry.dispose();
    env.shearMesh.geometry = g;
    env.shearWire.geometry.dispose();
    env.shearWire.geometry = new THREE.WireframeGeometry(g);
    env.shearMesh.scale.set(1, 1, 1);
    env.shearMesh.quaternion.identity();
    env.shearMesh.position.set(0, 0, 0);
  }
}

function makeWindArrow() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x4fb6d0, emissiveIntensity: 0.6, roughness: 0.4 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5, 16), mat);
  shaft.rotation.x = Math.PI / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 20), mat);
  head.rotation.x = Math.PI / 2;
  head.position.z = 3.2;
  g.add(shaft, head);
  return g;
}

function makeSpray() {
  const N = 4000;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 60;
    pos[i * 3 + 1] = Math.pow(Math.random(), 2.5) * 12;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
    seed[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d');
  const grd = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grd;
  c.fillRect(0, 0, 32, 32);
  const m = new THREE.PointsMaterial({
    size: 0.022, map: new THREE.CanvasTexture(cv), transparent: true, opacity: 0.1, depthWrite: false, color: 0xf4fbff,
  });
  const points = new THREE.Points(g, m);
  points.frustumCulled = false;
  return { points, seed, lee: new THREE.Vector3(-1, 0, 0), speed: 8 };
}

export function animateSpray(spray, dt) {
  if (!spray.points.visible) return;
  const pos = spray.points.geometry.attributes.position;
  const a = pos.array;
  const L = spray.lee;
  for (let i = 0; i < spray.seed.length; i++) {
    const s = spray.seed[i];
    const v = spray.speed * (0.6 + 0.8 * s) * dt;
    a[i * 3] += L.x * v;
    a[i * 3 + 2] += L.z * v;
    a[i * 3 + 1] += Math.sin((a[i * 3] + a[i * 3 + 2]) * 0.3 + s * 10) * dt * 0.6;
    // Recycle particles that have blown 30 m past the tree.
    const along = a[i * 3] * L.x + a[i * 3 + 2] * L.z;
    if (along > 30 || a[i * 3 + 1] < 0) {
      const side = (Math.random() - 0.5) * 60;
      a[i * 3] = -L.x * 30 + -L.z * side;
      a[i * 3 + 2] = -L.z * 30 + L.x * side;
      a[i * 3 + 1] = Math.pow(Math.random(), 2.5) * 12;
    }
  }
  pos.needsUpdate = true;
}
