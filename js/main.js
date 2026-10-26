import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

import { defaultParams } from './params.js?v=20261026172943';
import { generateOak, skeletonToJSON, windVectors } from './oakGenerator.js?v=20261026172943';
import { buildBarkGeometry, buildLeafMesh, buildMossGeometry, SPRIG, LEAF_RECTS, LEAF_ASPECT } from './oakMesher.js?v=20261026172943';
import {
  shared, createBarkMaterial, updateBarkMaterial, createLeafMaterials, updateLeafMaterial,
  createMossTexture, createMossMaterials, setMossTone, createUnderstoryMaterial,
} from './materials.js?v=20261026172943';
import { createRenderer, createEnvironment, updateEnvironment, animateSpray, sunDirection, ATMOSPHERES } from './scene.js?v=20261026172943';
import { buildPanel, buildPresetSelect, compassName } from './ui.js?v=20261026172943';
import * as backend from './backend.js?v=20261026172943';
import { generateUnderstory, understoryToJSON } from './understory.js?v=20261026172943';

// ------------------------------------------------------------------ state ---

const STORE_KEY = 'live-live-oak-explorer-params-v1';
let params = defaultParams();
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (saved) params = { ...params, ...saved };
} catch { /* storage unavailable */ }

const $ = (id) => document.getElementById(id);
const canvas = $('viewport');
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(-22, 7, 26);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 4.5, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 2;
controls.maxDistance = 150;

const env = createEnvironment(scene, renderer);
const tree = new THREE.Group();
tree.name = 'LiveOak';
scene.add(tree);

let barkMat = createBarkMaterial(params);
const leafMats = createLeafMaterials(params);
const mossTex = createMossTexture();
const mossMats = createMossMaterials(params, mossTex);
let skeleton = null;
let meshes = {};
const understoryMat = createUnderstoryMaterial();
const undergrowth = new THREE.Group();
undergrowth.name = 'Understory';
scene.add(undergrowth);
let understory = null;
let understoryKey = '';

// Rebuilt only when ground type, density, seed or crown size change.
function rebuildUnderstory() {
  const crownR = Math.max(4, skeleton.shear.spread || params.limbLength);
  const key = `${params.ground}|${params.understory}|${params.seed}|${Math.round(crownR)}|${params.pond}|${params.pondDir}`;
  if (key === understoryKey) return;
  understoryKey = key;
  for (const c of [...undergrowth.children]) {
    undergrowth.remove(c);
    c.geometry.dispose();
  }
  understory = generateUnderstory(params, crownR);
  const plants = new THREE.Mesh(understory.geometry, understoryMat);
  plants.castShadow = plants.receiveShadow = true;
  const shrubs = buildLeafMesh({ leaves: understory.shrubLeaves }, leafMats.material, leafMats.depth);
  undergrowth.add(plants, shrubs);
}

// --------------------------------------------------------------- building ---

function rebuild(quality = params.quality) {
  skeleton = generateOak(params, { quality });
  for (const m of Object.values(meshes)) {
    tree.remove(m);
    if (m.geometry) m.geometry.dispose();
  }
  const bark = new THREE.Mesh(buildBarkGeometry(skeleton, quality), barkMat);
  bark.name = 'Bark';
  bark.castShadow = bark.receiveShadow = true;
  const leaves = buildLeafMesh(skeleton, leafMats.material, leafMats.depth);
  leaves.name = 'Leaves';
  const moss = new THREE.Mesh(buildMossGeometry(skeleton), mossMats.material);
  moss.name = 'SpanishMoss';
  moss.customDepthMaterial = mossMats.depth;
  moss.castShadow = true;
  meshes = { bark, leaves, moss };
  tree.add(bark, leaves, moss);
  if (params.showSkeleton) {
    meshes.skeleton = buildSkeletonLines(skeleton);
    tree.add(meshes.skeleton);
  }
  applyVisibility();
  updateEnvironment(env, scene, renderer, params, skeleton);
  if (quality !== 'draft' || !understory) rebuildUnderstory();
  updateStats();
}

function applyVisibility() {
  if (!meshes.bark) return;
  meshes.bark.visible = !params.showSkeleton;
  meshes.leaves.visible = !params.showSkeleton && params.showLeaves !== false;
  meshes.moss.visible = !params.showSkeleton && params.showMoss !== false;
}

// The bare graph: each branch is a chain of joints; colour = branch order.
const LEVEL_COLORS = [0xf2d39b, 0xe39a5b, 0x6fb7a6, 0x8fc5e8, 0xc9a7e8, 0xffffff];
function buildSkeletonLines(sk) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  for (const b of [...sk.branches, ...sk.roots]) {
    c.setHex(b.root ? 0xb07b52 : b.dead ? 0x888888 : LEVEL_COLORS[Math.min(b.level, 5)]);
    for (let i = 1; i < b.points.length; i++) {
      pos.push(...b.points[i - 1].toArray(), ...b.points[i].toArray());
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
  const joints = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.09, vertexColors: true }));
  lines.add(joints);
  lines.name = 'Skeleton';
  return lines;
}

// Keys that only touch materials or scene dressing — no regrowth needed.
const LIGHT_KEYS = new Set([
  'showLeaves', 'showMoss', 'barkScars', 'lichen', 'limbMoss', 'barkDarkness', 'leafDarkness', 'leafGloss', 'leafVariation', 'translucency',
  'mossTone', 'sway', 'showShear', 'showSpray', 'showArrow', 'timeOfDay', 'ground', 'showOcean',
  'fog', 'exposure', 'barkSet', 'understory', 'atmosphere',
]);

let pending = null;
function onParam(key, value, final) {
  params[key] = value;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* ignore */ }
  if (key === 'atmosphere' && ATMOSPHERES[value]?.time) {
    // Golden hour, dusk and so on also move the sun.
    params.timeOfDay = ATMOSPHERES[value].time;
    uiControls.timeOfDay.set(params.timeOfDay);
  }
  if (LIGHT_KEYS.has(key)) {
    applyLight(key);
    return;
  }
  // While dragging, regrow at draft quality once per frame; full quality on release.
  if (final) {
    pending = null;
    rebuild();
  } else {
    pending = 'draft';
  }
  markEngineStale();
}

function applyLight(key) {
  if (key === 'showLeaves' || key === 'showMoss') {
    applyVisibility();
    markEngineStale();
    return;
  }
  if (key === 'barkSet') {
    barkMat.dispose();
    barkMat = createBarkMaterial(params);
    if (meshes.bark) meshes.bark.material = barkMat;
  }
  updateBarkMaterial(barkMat, params);
  updateLeafMaterial(leafMats.material, params);
  setMossTone(mossMats.material, params);
  updateEnvironment(env, scene, renderer, params, skeleton);
  if (key === 'ground' || key === 'understory') rebuildUnderstory();
  markEngineStale();
}

function applyAll(newParams) {
  params = { ...params, ...newParams };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(params)); } catch { /* ignore */ }
  for (const [k, c] of Object.entries(uiControls)) c.set(params[k]);
  applyLight('barkSet');
  rebuild();
}

// ---------------------------------------------------------------- UI glue ---

const uiControls = buildPanel($('params'), params, onParam);
buildPresetSelect($('presets'), applyAll);

$('btn-reset').addEventListener('click', () => applyAll(defaultParams()));
$('btn-reseed').addEventListener('click', () => {
  const v = 1 + Math.floor(Math.random() * 9998);
  applyAll({ seed: v });
});

function updateStats() {
  const s = skeleton.stats;
  const tris = (meshes.bark.geometry.index.count / 3) + s.leaves * 40 + (meshes.moss.geometry.index ? meshes.moss.geometry.index.count / 3 : 0);
  $('stats').innerHTML = `
    <span><b>${s.branches.toLocaleString()}</b> branches</span>
    <span><b>${(s.leaves * 5).toLocaleString()}</b> leaves</span>
    <span><b>${s.moss.toLocaleString()}</b> moss strands</span>
    <span><b>${s.pruned.toLocaleString()}</b> salt-pruned tips</span>
    <span><b>${(tris / 1e6).toFixed(2)}M</b> tris</span>
    <span><b>${s.ms.toFixed(0)}</b> ms grow</span>`;
  const { from } = windVectors(params);
  $('hud-spray').hidden = !(params.showSpray && params.windStrength > 0.02);
  $('hud-age').textContent = `${Math.round(params.age)} years`;
  $('hud-wind').textContent = `Wind from ${compassName(params.windDir)} (${params.windDir}°) · ${Math.round(params.windStrength * 100)}%`;
  void from;
}

// Time-lapse: replay growth from a seedling to the chosen age.
let lapse = null;
$('btn-grow').addEventListener('click', () => {
  if (lapse) {
    params.age = lapse.target;
    uiControls.age.set(params.age);
    lapse = null;
    $('btn-grow').textContent = '▶ Grow time-lapse';
    rebuild();
    return;
  }
  lapse = { target: params.age, start: performance.now(), dur: 9000 };
  $('btn-grow').textContent = '■ Stop';
});

function stepLapse(now) {
  if (!lapse) return;
  const t = Math.min(1, (now - lapse.start) / lapse.dur);
  const eased = t * t * (3 - 2 * t);
  params.age = Math.max(3, Math.round(3 + (lapse.target - 3) * eased));
  uiControls.age.set(params.age);
  rebuild('draft');
  if (t >= 1) {
    params.age = lapse.target;
    lapse = null;
    $('btn-grow').textContent = '▶ Grow time-lapse';
    rebuild();
  }
}

// Meshy reference model (geometry only — not parametric).
let meshyRef = null;
$('ref-meshy').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    if (meshyRef) meshyRef.visible = false;
    return;
  }
  if (!meshyRef) {
    $('ref-meshy-status').textContent = 'loading…';
    const draco = new DRACOLoader().setDecoderPath('vendor/three/addons/libs/draco/gltf/');
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('meshy/meshy_oak_web.glb');
    meshyRef = gltf.scene;
    const clay = new THREE.MeshStandardMaterial({ color: 0x75644f, roughness: 0.85 });
    meshyRef.traverse((o) => {
      if (o.isMesh) {
        o.material = clay;
        o.castShadow = o.receiveShadow = true;
      }
    });
    const box = new THREE.Box3().setFromObject(meshyRef);
    const size = box.getSize(new THREE.Vector3());
    const s = 12 / size.y;
    meshyRef.scale.setScalar(s);
    box.setFromObject(meshyRef);
    meshyRef.position.y -= box.min.y;
    scene.add(meshyRef);
    $('ref-meshy-status').textContent = '250k tris · not parametric';
  }
  // Stand it beside the tree, across the wind so it is not hidden by the crown.
  const { from } = windVectors(params);
  meshyRef.position.x = -from.z * 30;
  meshyRef.position.z = from.x * 30;
  meshyRef.visible = true;
});

// Photo gallery: field photos plus curated, openly licensed references
// (photos/manifest.json). Any photo can be pinned beside the viewer for
// side-by-side checking while adjusting sliders.
const CATS = { all: 'All', field: 'Field photos', form: 'Tree form', 'salt-and-coast': 'Salt & coast',
  'sand-live-oak': 'Sand live oak', 'spanish-moss': 'Spanish moss', bark: 'Bark', leaves: 'Leaves',
  pbase: 'Live Oak Society (local only)' };
let photos = [];
let lightboxItem = null;
function renderGallery(cat) {
  const gal = $('gallery-grid');
  gal.innerHTML = '';
  for (const ph of photos.filter((x) => cat === 'all' || x.category === cat)) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = ph.src;
    img.alt = ph.title;
    img.loading = 'lazy';
    const cap = document.createElement('figcaption');
    cap.textContent = ph.title;
    if (ph.author) {
      const by = document.createElement('small');
      by.className = 'credit';
      by.textContent = `${ph.author.replace(/\s+/g, ' ')} · ${ph.license}`;
      cap.append(by);
    }
    fig.append(img, cap);
    fig.addEventListener('click', () => {
      lightboxItem = ph;
      $('lightbox-img').src = ph.src;
      $('lightbox-cap').innerHTML = '';
      const t = document.createElement('span');
      t.textContent = ph.title + (ph.author ? ` — ${ph.author.replace(/\s+/g, ' ')}, ${ph.license}` : '');
      $('lightbox-cap').append(t);
      if (ph.source) {
        const a = document.createElement('a');
        a.href = ph.source;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = ' · source';
        $('lightbox-cap').append(a);
      }
      $('lightbox').showModal();
    });
    gal.appendChild(fig);
  }
}
// photos/manifest.local.json lists copyrighted reference photos kept only on
// this machine (git-ignored); on GitHub Pages it is simply absent.
Promise.all([
  fetch('photos/manifest.json?v=20261026172943').then((r) => r.json()),
  fetch('photos/manifest.local.json?v=20261026172943').then((r) => (r.ok ? r.json() : [])).catch(() => []),
]).then(([list, local]) => {
  photos = [...list, ...local];
  list = photos;
  const tabs = $('gallery-tabs');
  for (const [k, label] of Object.entries(CATS)) {
    const n = k === 'all' ? list.length : list.filter((x) => x.category === k).length;
    if (!n) continue;
    const b = document.createElement('button');
    b.textContent = `${label} (${n})`;
    b.dataset.cat = k;
    b.setAttribute('aria-pressed', k === 'field' ? 'true' : 'false');
    b.addEventListener('click', () => {
      for (const o of tabs.children) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      renderGallery(k);
    });
    tabs.appendChild(b);
  }
  renderGallery('field');
}).catch(() => { $('gallery-grid').textContent = 'photos/manifest.json not found'; });

$('btn-pin').addEventListener('click', () => {
  if (!lightboxItem) return;
  $('pinned-img').src = lightboxItem.src;
  $('pinned-cap').textContent = lightboxItem.title + (lightboxItem.author ? ` — ${lightboxItem.author.replace(/\s+/g, ' ')}` : '');
  $('pinned').hidden = false;
  $('lightbox').close();
  $('gallery').close();
});
$('btn-unpin').addEventListener('click', () => { $('pinned').hidden = true; });
$('btn-gallery').addEventListener('click', () => $('gallery').showModal());
$('btn-about').addEventListener('click', () => $('about').showModal());
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

// Exports.
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('btn-export-glb').addEventListener('click', async () => {
  const glb = await new GLTFExporter().parseAsync(tree, { binary: true });
  download(new Blob([glb], { type: 'model/gltf-binary' }), `live-oak-${params.seed}.glb`);
});
$('btn-export-json').addEventListener('click', () => {
  download(new Blob([JSON.stringify(skeletonToJSON(skeleton))], { type: 'application/json' }), `live-oak-skeleton-${params.seed}.json`);
});
$('btn-save-params').addEventListener('click', () => {
  download(new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' }), `live-oak-params-${params.seed}.json`);
});
$('btn-load-params').addEventListener('click', () => $('file-params').click());
$('file-params').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    applyAll(JSON.parse(await f.text()));
  } catch (err) {
    alertBar(`Could not read parameters: ${err.message}`);
  }
});

function alertBar(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(alertBar.t);
  alertBar.t = setTimeout(() => el.classList.remove('show'), 4200);
}

// --------------------------------------------------- engine selector ---

const engineTabs = document.querySelectorAll('[data-engine]');
for (const t of engineTabs) {
  t.addEventListener('click', () => {
    for (const o of engineTabs) o.setAttribute('aria-selected', o === t ? 'true' : 'false');
    document.body.dataset.engine = t.dataset.engine;
  });
}

function cameraInfo() {
  return {
    position: camera.position.toArray(),
    target: controls.target.toArray(),
    fov: camera.fov,
    aspect: camera.aspect,
  };
}

function markEngineStale() {
  $('engine-stale').hidden = !backend.state.lastJob;
}

async function buildPayload(extra) {
  const sun = sunDirection(params.timeOfDay).toArray();
  return {
    skeleton: (() => {
      const sk = skeletonToJSON(generateOak(params, { quality: 'ultra' }));
      if (params.showLeaves === false) sk.leaves = [];
      if (params.showMoss === false) sk.moss = [];
      return sk;
    })(),
    camera: cameraInfo(),
    sun,
    mossTexture: mossTex.image.toDataURL('image/png'),
    understory: understory ? understoryToJSON(understory) : null,
    leaf: { sprig: SPRIG, rects: LEAF_RECTS.map((r) => r.toArray()), aspect: LEAF_ASPECT },
    ...extra,
  };
}

backend.init({
  onStatus(st) {
    $('st-blender').textContent = st.blender ? `Blender ${st.blender.version}` : 'Blender not found';
    $('st-blender').dataset.ok = !!st.blender;
    $('st-unreal').textContent = st.unreal ? `Unreal ${st.unreal.version}` : 'Unreal not found';
    $('st-unreal').dataset.ok = !!st.unreal;
    $('engine-offline').hidden = true;
    for (const b of document.querySelectorAll('.needs-server')) b.disabled = false;
    $('btn-unreal').disabled = !st.unreal || !st.blender;
    $('btn-blender-render').disabled = $('btn-blender-open').disabled = !st.blender;
  },
  onOffline(localUrl) {
    $('engine-offline').hidden = false;
    $('engine-offline').innerHTML = localUrl
      ? `Blender and Unreal run on your own computer, not on this website.<br>Your local server is running: <a class="open-local" href="${localUrl}">Open the local app</a>`
      : `Blender and Unreal run on your own computer, not on this website.<br>In the project folder run <code>./start</code>; it opens the local app, where these engines work.`;
    $('st-blender').textContent = 'Blender: local only';
    $('st-unreal').textContent = 'Unreal: local only';
    for (const b of document.querySelectorAll('.needs-server')) b.disabled = true;
  },
});

function logTo(text) {
  const el = $('engine-log');
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function elapsed(t0) {
  const s = Math.round((Date.now() - t0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Blender/Unreal need the local server (./start); never start a job without it.
function requireLocal() {
  if (backend.state.online) return true;
  $('engine-progress').hidden = true;
  alertBar('Blender and Unreal run on your computer: run ./start and use the local app.');
  return false;
}

async function runBlender(mode) {
  const samples = +$('bl-samples').value;
  const res = $('bl-res').value;
  const engine = $('bl-engine').value;
  const device = $('bl-device').value;
  $('engine-progress').hidden = false;
  logTo('Growing ultra-quality skeleton and sending it to Blender…');
  const payload = await buildPayload({ mode, render: { samples, resolution: res, engine, device } });
  const job = await backend.blenderBuild(payload);
  const t0 = Date.now();
  return backend.watch(job.id, (st) => {
    logTo(st.log);
    $('engine-progress-label').textContent = st.state === 'running'
      ? `Blender: ${(st.phase || 'working').replace(/\s*\[[\d.]+s\]$/, '')} · ${elapsed(t0)}`
      : `Blender: ${st.state}`;
  });
}

$('btn-blender-render').addEventListener('click', async () => {
  if (!requireLocal()) return;
  try {
    const st = await runBlender('render');
    $('engine-progress').hidden = true;
    if (st.state !== 'done') throw new Error('Blender job failed — see log');
    showResult(st);
    await saveToDownloads(st.outputs.render, 'cycles');
  } catch (err) {
    $('engine-progress').hidden = true;
    alertBar(err.message);
  }
});

$('btn-blender-open').addEventListener('click', async () => {
  if (!requireLocal()) return;
  try {
    const payload = await buildPayload({ mode: 'gui', render: { samples: 64, resolution: '1920x1080', engine: $('bl-engine').value } });
    await backend.blenderOpen(payload);
    alertBar('Blender is opening with the oak scene (Material Preview).');
  } catch (err) {
    alertBar(err.message);
  }
});

$('btn-unreal').addEventListener('click', async () => {
  if (!requireLocal()) return;
  try {
    const st = await runBlender('export');
    if (st.state !== 'done') {
      $('engine-progress').hidden = true;
      throw new Error('Blender export failed — see log');
    }
    logTo(st.log + '\n\nLaunching Unreal Engine… (first launch compiles shaders and can take several minutes)');
    const u = await backend.unrealSend({ jobId: st.id, camera: cameraInfo(), sun: sunDirection(params.timeOfDay).toArray(), params });
    $('engine-progress-label').textContent = 'Unreal: launching editor…';
    const t0 = Date.now();
    let lastShot = null;
    backend.watchUnreal(u.id, (us) => {
      logTo(us.log);
      $('engine-progress-label').textContent = `Unreal: ${us.phase || us.state} · ${elapsed(t0)}`;
      if (us.screenshot) {
        $('engine-progress').hidden = true;
        // Later screenshots (after shaders finish compiling) replace the image quietly.
        if (us.screenshot !== lastShot) {
          if (!lastShot) showResult({ outputs: { render: us.screenshot } }, 'Unreal Engine 5 (Lumen)');
          else $('result-img').src = us.screenshot;
          lastShot = us.screenshot;
          // The last screenshot is taken once shaders have compiled; save that one.
          if (/screenshot 5\/5/.test(us.log || '')) saveToDownloads(us.screenshot, 'unreal');
        }
      } else if (us.state === 'failed' || us.state === 'exited') {
        // The editor ended without producing a screenshot: never leave "Working…" up.
        $('engine-progress').hidden = true;
        alertBar(`Unreal ${us.state === 'failed' ? 'failed' : 'closed'} before a screenshot was saved — see the log.`);
      }
    });
  } catch (err) {
    $('engine-progress').hidden = true;
    alertBar(err.message);
  }
});

// Save a finished render into the browser's Downloads folder (Chrome shows its
// "download complete" notice), named after the tree and time.
async function saveToDownloads(url, engine) {
  if (!url) return;
  try {
    const blob = await (await fetch(url)).blob();
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    download(blob, `live-oak-${engine}-seed${params.seed}-${Math.round(params.age)}yr-${stamp}.png`);
  } catch (err) {
    alertBar(`Render saved in the project (output/jobs) but could not be downloaded: ${err.message}`);
  }
}

function showResult(st, title = 'Blender Cycles render') {
  const o = st.outputs || {};
  $('result-title').textContent = title;
  $('result-img').src = `${o.render}?t=${Date.now()}`;
  $('result-links').innerHTML = [
    o.render && `<a href="${o.render}" download>PNG</a>`,
    o.glb && `<a href="${o.glb}" download>GLB</a>`,
    o.fbx && `<a href="${o.fbx}" download>FBX</a>`,
    o.blend && `<a href="${o.blend}" download>.blend</a>`,
  ].filter(Boolean).join(' · ');
  $('btn-load-blender-glb').hidden = !o.glb;
  $('btn-load-blender-glb').onclick = () => loadBlenderGlb(o.glb);
  $('result').showModal();
}

// Load the Blender-built model into the live viewer (heavier, more detailed).
let blenderModel = null;
async function loadBlenderGlb(url) {
  $('result').close();
  alertBar('Loading Blender model…');
  const gltf = await new GLTFLoader().loadAsync(url);
  if (blenderModel) scene.remove(blenderModel);
  blenderModel = gltf.scene;
  blenderModel.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = true;
      if (o.material.map) o.material.alphaTest = o.material.alphaTest || 0;
    }
  });
  scene.add(blenderModel);
  tree.visible = false;
  $('blender-model-bar').hidden = false;
}
$('btn-show-procedural').addEventListener('click', () => {
  if (blenderModel) scene.remove(blenderModel);
  blenderModel = null;
  tree.visible = true;
  $('blender-model-bar').hidden = true;
});

// ---------------------------------------------------------------- loop ---

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

const clock = new THREE.Clock();
let fpsAcc = 0;
let fpsN = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  resize();
  stepLapse(now);
  if (pending) {
    rebuild(pending);
    pending = null;
  }
  shared.uTime.value += dt;
  const { lee } = windVectors(params);
  shared.uWindDir.value.copy(lee);
  shared.uWindStrength.value = params.windStrength;
  shared.uSway.value = params.sway;
  shared.uSunLight.value = Math.min(1.2, env.sun.intensity / 3.4);
  shared.uSunDirView.value.copy(env.sun.position).normalize().transformDirection(camera.matrixWorldInverse);
  animateSpray(env.spray, dt);
  controls.update();
  renderer.render(scene, camera);
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    $('fps').textContent = `${Math.round(fpsN / fpsAcc)} fps`;
    fpsAcc = 0;
    fpsN = 0;
  }
}

rebuild();
requestAnimationFrame(frame);
window.oak = { get params() { return params; }, get skeleton() { return skeleton; }, rebuild, apply: applyAll, scene, camera, controls, renderer };
