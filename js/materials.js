// Photoreal materials built from CC0 photoscans:
//  * bark: Poly Haven PBR sets (colour, OpenGL normal, roughness, AO, displacement)
//  * leaves: ambientCG LeafSet022 atlas (colour, normal, roughness, opacity, scattering)
//  * Spanish moss: procedurally drawn strand texture (no photo atlas exists)
// Shader patches add limb moss, salt burn, translucency and wind sway.

import * as THREE from 'three';
import { LEAF_RECTS } from './oakMesher.js?v=20261026185609';
import GROUND_SETS from '../assets/grounds.json?v=20261026185609' with { type: 'json' };

const loader = new THREE.TextureLoader();
const cache = new Map();

function tex(url, { srgb = false, repeat = true } = {}) {
  const key = url + srgb;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

// Shared uniforms so a single update drives every material.
export const shared = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector3(-1, 0, 0) },
  uWindStrength: { value: 0.5 },
  uSway: { value: 0.35 },
  uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
  uSunLight: { value: 1 }, // sun strength relative to a clear afternoon
};

const SWAY_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uWindDir;
  uniform float uWindStrength;
  uniform float uSway;
  vec3 windSway(vec3 world, float amount) {
    float ph = dot(world, vec3(0.37, 0.11, 0.29));
    float gust = 0.6 + 0.4 * sin(uTime * 0.7 + world.x * 0.05 + world.z * 0.04);
    float s = sin(uTime * 2.1 + ph * 3.0) * 0.6 + sin(uTime * 4.3 + ph * 7.0) * 0.25;
    vec3 side = normalize(cross(uWindDir, vec3(0.0, 1.0, 0.0)) + 1e-4);
    return amount * uSway * (uWindDir * (uWindStrength * 0.6 + s * 0.4) * gust
      + side * s * 0.35 + vec3(0.0, s * 0.15, 0.0));
  }
`;

// ------------------------------------------------------------------ bark ---

export function createBarkMaterial(p) {
  const set = p.barkSet;
  const base = `assets/textures/bark/${set}`;
  const mat = new THREE.MeshStandardMaterial({
    map: tex(`${base}_diff_2k.jpg`, { srgb: true }),
    normalMap: tex(`${base}_nor_gl_2k.jpg`),
    roughnessMap: tex(`${base}_rough_2k.jpg`),
    aoMap: tex(`${base}_ao_2k.jpg`),
    normalScale: new THREE.Vector2(1.6, 1.6),
    aoMapIntensity: 1.0,
    roughness: 1.0,
  });
  const u = {
    uScars: { value: p.barkScars ?? 0.35 },
    uLichen: { value: p.lichen ?? 0.5 },
    uLimbMoss: { value: p.limbMoss },
    uBarkDark: { value: p.barkDarkness },
    uDisp: { value: tex(`${base}_disp_2k.jpg`) },
  };
  mat.userData.uniforms = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldN;')
      .replace('#include <common>', '#include <common>\nvarying vec3 vBarkW;\nattribute float aMossOk;\nvarying float vMossOk;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvBarkW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvMossOk = aMossOk;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWorldN;
        uniform float uLimbMoss;
        uniform float uBarkDark;
        uniform float uScars;
        uniform float uLichen;
        uniform sampler2D uDisp;
        varying vec3 vBarkW;
        varying float vMossOk;
        float bHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float bNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(bHash(i), bHash(i + vec3(1,0,0)), f.x), mix(bHash(i + vec3(0,1,0)), bHash(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(bHash(i + vec3(0,0,1)), bHash(i + vec3(1,0,1)), f.x), mix(bHash(i + vec3(0,1,1)), bHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float bFbm(vec3 p) { return 0.5 * bNoise(p) + 0.3 * bNoise(p * 2.1) + 0.2 * bNoise(p * 4.3); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float disp = texture2D(uDisp, vMapUv).r;
        diffuseColor.rgb *= mix(1.0, 0.55, uBarkDark);
        // Irregularity: gentle broad tone variation and damp streaks, so the
        // photo texture never repeats visibly.
        float tone = bFbm(vBarkW * 0.45);
        diffuseColor.rgb *= 1.0 + (tone - 0.5) * 0.35 * uScars;
        float streak = smoothstep(0.55, 0.8, bNoise(vec3(vBarkW.x * 2.5, vBarkW.y * 0.25, vBarkW.z * 2.5))) * uScars;
        diffuseColor.rgb *= 1.0 - 0.18 * streak;
        // Scars: narrow splits running along the branch (bark UV v = length),
        // showing dark weathered wood with a slightly darker lifted edge. Low
        // contrast, as on real oak bark.
        float sn = bNoise(vec3(vMapUv.x * 3.0, vMapUv.y * 0.35, 5.0)) * 0.65 + bNoise(vec3(vMapUv.x * 9.0, vMapUv.y * 1.2, 9.0)) * 0.35;
        float thr = 0.8 - 0.1 * uScars;
        float scar = smoothstep(thr, thr + 0.05, sn) * step(0.01, uScars);
        float rim = (smoothstep(thr - 0.06, thr, sn) - scar) * step(0.01, uScars);
        vec3 wood = diffuseColor.rgb * vec3(0.72, 0.66, 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, wood, scar * 0.75);
        diffuseColor.rgb *= 1.0 - 0.15 * rim;
        // Lichens. Crustose lichens: soft, blotchy pale grey-green patches,
        // mottled inside, low contrast against grey bark.
        float ln = bFbm(vBarkW * 3.2 + 7.3);
        float lmask = smoothstep(0.7 - 0.12 * uLichen, 0.8 - 0.12 * uLichen, ln) * step(0.01, uLichen);
        float speck = bNoise(vBarkW * 26.0);
        // Tinted relative to the local bark so it stays a soft mottling.
        vec3 lichenCol = mix(diffuseColor.rgb * 1.35, vec3(0.5, 0.53, 0.46), 0.45);
        diffuseColor.rgb = mix(diffuseColor.rgb, lichenCol, lmask * 0.55 * (0.5 + 0.5 * speck));
        // Christmas lichen (Cryptothecia rubrocincta), occasional: pale
        // grey-green crust with a muted red-pink rim.
        float cn = bFbm(vBarkW * 1.6 + 53.0);
        float cIn = smoothstep(0.78, 0.8, cn) * step(0.01, uLichen) * smoothstep(0.2, 0.6, uLichen);
        float cRim = (smoothstep(0.75, 0.78, cn) - cIn) * step(0.01, uLichen) * smoothstep(0.2, 0.6, uLichen);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 1.3, vec3(0.55, 0.58, 0.52), 0.5), cIn * 0.5);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.33, 0.3), cRim * 0.35);
        // Moss and resurrection fern settle on upward faces and in bark furrows.
        float up = vWorldN.y + (0.5 - disp) * 0.7;
        // Patchy, never a continuous coat; none on roots.
        float mossPatch = smoothstep(0.42, 0.62, bFbm(vBarkW * 1.7 + 19.0));
        float mossAmt = smoothstep(0.8 - uLimbMoss * 1.0, 1.1 - uLimbMoss * 0.7, up) * min(1.0, uLimbMoss * 1.15) * mossPatch * vMossOk;
        vec3 mossCol = mix(diffuseColor.rgb, mix(vec3(0.2, 0.24, 0.12), vec3(0.3, 0.33, 0.17), disp), 0.65);
        diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, mossAmt);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.95, mossAmt);
        roughnessFactor = mix(roughnessFactor, 0.85, lmask * 0.5);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Exposed wood is smooth: flatten the bark relief inside scars.
        normal = normalize(mix(normal, nonPerturbedNormal, scar * 0.4));`);
  };
  mat.customProgramCacheKey = () => 'oakbark';
  return mat;
}

export function updateBarkMaterial(mat, p) {
  mat.userData.uniforms.uScars.value = p.barkScars ?? 0.35;
  mat.userData.uniforms.uLichen.value = p.lichen ?? 0.5;
  mat.userData.uniforms.uLimbMoss.value = p.limbMoss;
  mat.userData.uniforms.uBarkDark.value = p.barkDarkness;
}

// ---------------------------------------------------------------- leaves ---

const LEAF_BASE = 'assets/textures/leaves/leafset022';

function patchLeafVertex(shader) {
  shader.uniforms.uRects = { value: LEAF_RECTS };
  Object.assign(shader.uniforms, shared);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      attribute vec3 aLeaf;
      attribute float aBlade;
      uniform vec4 uRects[6];
      varying vec2 vLeaf;
      varying vec2 vAtlasUv;
      ${SWAY_GLSL}`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>
      vec4 rect = uRects[int(mod(aLeaf.x + aBlade, 6.0) + 0.5)];
      vAtlasUv = rect.xy + uv * rect.zw;
      vLeaf = aLeaf.yz;
      #ifdef USE_MAP
        vMapUv = vAtlasUv;
      #endif
      #ifdef USE_NORMALMAP
        vNormalMapUv = vAtlasUv;
      #endif
      #ifdef USE_ROUGHNESSMAP
        vRoughnessMapUv = vAtlasUv;
      #endif
      #ifdef USE_ALPHAMAP
        vAlphaMapUv = vAtlasUv;
      #endif`)
    .replace('#include <project_vertex>', `
      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      vec4 worldP = modelMatrix * mvPosition;
      worldP.xyz += windSway(worldP.xyz, 0.05 + 0.03 * aBlade + 0.06 * uv.y);
      mvPosition = viewMatrix * worldP;
      gl_Position = projectionMatrix * mvPosition;`);
}

// The per-map UV varyings are pointed at the atlas in the vertex shader;
// the fragment side only needs the extra varyings declared.
function declareLeafVaryings(fragment) {
  return fragment.replace('#include <common>', '#include <common>\nvarying vec2 vAtlasUv;\nvarying vec2 vLeaf;');
}

export function createLeafMaterials(p) {
  const mat = new THREE.MeshStandardMaterial({
    map: tex(`${LEAF_BASE}_color_2k.jpg`, { srgb: true, repeat: false }),
    normalMap: tex(`${LEAF_BASE}_normalgl_2k.jpg`, { repeat: false }),
    roughnessMap: tex(`${LEAF_BASE}_roughness_2k.jpg`, { repeat: false }),
    alphaMap: tex(`${LEAF_BASE}_opacity_2k.jpg`, { repeat: false }),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 1,
  });
  const u = {
    uTint: { value: new THREE.Color() },
    uGloss: { value: p.leafGloss },
    uVariation: { value: p.leafVariation },
    uTranslucency: { value: p.translucency },
    uScatter: { value: tex(`${LEAF_BASE}_scattering_2k.jpg`, { repeat: false }) },
  };
  mat.userData.uniforms = u;
  setLeafTint(u, p);
  mat.onBeforeCompile = (shader) => {
    patchLeafVertex(shader);
    Object.assign(shader.uniforms, u);
    let f = declareLeafVaryings(shader.fragmentShader);
    f = f
      .replace('#include <common>', `#include <common>
        uniform vec3 uTint;
        uniform float uGloss;
        uniform float uVariation;
        uniform float uTranslucency;
        uniform sampler2D uScatter;
        uniform vec3 uSunDirView;
        uniform float uSunLight;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 c = diffuseColor.rgb * uTint;
        // Per-leaf hue/value variation.
        float v = (vLeaf.y - 0.5) * uVariation;
        c *= 1.0 + v * 0.5;
        c.r *= 1.0 + v * 0.35;
        // Salt burn: desaturate toward tan and brown.
        float lum = dot(c, vec3(0.3, 0.59, 0.11));
        vec3 burnt = vec3(lum) * vec3(1.9, 1.35, 0.7) + vec3(0.06, 0.035, 0.0);
        c = mix(c, burnt, smoothstep(0.0, 1.0, vLeaf.x));
        diffuseColor.rgb = c;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // Live oak leaves have a waxy, glossy upper surface.
        roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, uGloss);
        if (!gl_FrontFacing) roughnessFactor = max(roughnessFactor, 0.75);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Light passing through the blade when the sun is behind it.
        float scatter = texture2D(uScatter, vAtlasUv).r;
        float back = pow(max(0.0, dot(normalize(-vViewPosition), -uSunDirView) * 0.5 + 0.5), 4.0);
        // Translucency only exists where the sun shines through the blade.
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 1.1, 0.6) * scatter * back * uTranslucency * 0.9 * uSunLight;`);
    shader.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'oakleaf';

  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    alphaMap: mat.alphaMap,
    alphaTest: 0.5,
  });
  depth.onBeforeCompile = (shader) => {
    patchLeafVertex(shader);
    shader.fragmentShader = declareLeafVaryings(shader.fragmentShader);
  };
  depth.customProgramCacheKey = () => 'oakleafdepth';
  return { material: mat, depth };
}

function setLeafTint(u, p) {
  // Darken toward the deep olive-green of Quercus virginiana.
  const d = p.leafDarkness;
  u.uTint.value.setRGB(1 - 0.85 * d, 1 - 0.68 * d, 1 - 0.9 * d);
}

export function updateLeafMaterial(mat, p) {
  const u = mat.userData.uniforms;
  setLeafTint(u, p);
  u.uGloss.value = p.leafGloss;
  u.uVariation.value = p.leafVariation;
  u.uTranslucency.value = p.translucency;
}

// ---------------------------------------------------------- Spanish moss ---

// Draws 4 columns of hanging, curly Tillandsia strands with alpha.
export function createMossTexture(seed = 7) {
  const W = 1024;
  const H = 2048;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.clearRect(0, 0, W, H);
  g.lineCap = 'round';
  for (let col = 0; col < 4; col++) {
    const x0 = col * 256;
    const strands = 70;
    for (let k = 0; k < strands; k++) {
      // Strands fan out from near the top centre of the column.
      let x = x0 + 128 + (rnd() - 0.5) * 90;
      let y = rnd() * 60;
      const len = H * (0.45 + 0.55 * rnd());
      const drift = (rnd() - 0.5) * 1.6;
      const shade = 140 + rnd() * 70;
      g.strokeStyle = `rgba(${shade | 0},${(shade + 8) | 0},${(shade - 18) | 0},${0.75 + rnd() * 0.25})`;
      g.lineWidth = 1.2 + rnd() * 2.2;
      g.beginPath();
      g.moveTo(x, y);
      const step = 9;
      let phase = rnd() * 6.28;
      for (let t = 0; t < len; t += step) {
        phase += 0.5 + rnd() * 0.9;
        x += drift * 0.8 + Math.sin(phase) * 3.2 + (rnd() - 0.5) * 2;
        y += step;
        x = Math.min(x0 + 250, Math.max(x0 + 6, x));
        g.lineTo(x, y);
        // Tiny side scales/branchlets typical of Spanish moss.
        if (rnd() < 0.08) {
          g.moveTo(x, y);
          g.lineTo(x + (rnd() - 0.5) * 22, y + 6 + rnd() * 14);
          g.moveTo(x, y);
        }
      }
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  return t;
}

export function createMossMaterials(p, mossTex) {
  const mat = new THREE.MeshStandardMaterial({
    map: mossTex,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
    roughness: 0.95,
    color: new THREE.Color(),
  });
  setMossTone(mat, p);
  const patch = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aSway;\n${SWAY_GLSL}`)
      .replace('#include <project_vertex>', `
        vec4 worldP = modelMatrix * vec4(transformed, 1.0);
        // Spanish moss weighs almost nothing: large, slower swing plus a quick flutter.
        float flutter = sin(uTime * 7.3 + worldP.x * 3.1 + worldP.z * 2.7) * 0.06 * aSway;
        worldP.xyz += windSway(worldP.xyz, aSway * aSway * 1.15) + vec3(flutter, 0.0, flutter * 0.7) * (0.4 + uSway);
        vec4 mvPosition = viewMatrix * worldP;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.onBeforeCompile = patch;
  mat.customProgramCacheKey = () => 'oakmoss';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: mossTex, alphaTest: 0.3 });
  depth.onBeforeCompile = patch;
  depth.customProgramCacheKey = () => 'oakmossdepth';
  return { material: mat, depth };
}

export function setMossTone(mat, p) {
  // Grey (dry) to green (freshly rained on).
  const t = p.mossTone;
  mat.color.setRGB(0.78 - 0.18 * t, 0.8 - 0.02 * t, 0.68 - 0.2 * t);
}

// ---------------------------------------------------------------- ground ---

// Ground sets live in assets/grounds.json so Blender and Unreal use the same
// textures, tint, desaturation and blending.
export function createGroundMaterial(type, xray, canopyR = 12) {
  const set = GROUND_SETS[type] || GROUND_SETS.hammock;
  const rep = 40;
  const load = (name, m) => {
    const t = tex(`assets/textures/ground/${name}_${m}_2k.jpg`, { srgb: m === 'diff' }).clone();
    t.repeat.set(rep, rep);
    t.needsUpdate = true;
    return t;
  };
  const mat = new THREE.MeshStandardMaterial({
    map: load(set.a, 'diff'), normalMap: load(set.a, 'nor_gl'), roughnessMap: load(set.a, 'rough'),
    transparent: xray, opacity: xray ? 0.28 : 1, depthWrite: !xray,
  });
  const u = {
    uMapB: { value: load(set.b, 'diff') },
    uNorB: { value: load(set.b, 'nor_gl') },
    uRoughB: { value: load(set.b, 'rough') },
    uTintA: { value: new THREE.Color(...set.tintA) },
    uBAmount: { value: set.bAmount },
    uCanopyR: { value: canopyR },
    uLitterUnderCanopy: { value: set.litterUnderCanopy },
    uDesat: { value: set.desat },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGroundW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGroundW;
        uniform sampler2D uMapB, uNorB, uRoughB;
        uniform vec3 uTintA;
        uniform float uBAmount, uCanopyR, uLitterUnderCanopy, uDesat;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
        }
        float gFbm(vec2 p) { return 0.55 * gNoise(p) + 0.3 * gNoise(p * 2.3) + 0.15 * gNoise(p * 5.1); }`)
      .replace('#include <map_fragment>', `
        float gr = length(vGroundW.xz);
        float gm = smoothstep(0.62 - uBAmount * 0.6, 0.75 - uBAmount * 0.6, 1.0 - gFbm(vGroundW.xz * 0.09));
        // Under the canopy, leaf fall covers the sand on dunes (and keeps the hammock floor littered).
        float canopy = 1.0 - smoothstep(uCanopyR * 0.7, uCanopyR * 1.15, gr);
        gm = mix(gm, uLitterUnderCanopy, canopy * 0.85);
        #ifdef USE_MAP
          vec4 gA = texture2D(map, vMapUv);
          vec4 gB = texture2D(uMapB, vMapUv * 0.83);
          // Live oaks are evergreen: their litter is tan/grey-brown, never
          // autumn orange, so the photoscanned leaves are desaturated.
          float lumA = dot(gA.rgb, vec3(0.3, 0.59, 0.11));
          gA.rgb = mix(gA.rgb, vec3(lumA) * vec3(1.08, 0.98, 0.84), uDesat) * uTintA;
          float lumB = dot(gB.rgb, vec3(0.3, 0.59, 0.11));
          gB.rgb = mix(gB.rgb, vec3(lumB) * vec3(1.08, 0.98, 0.84), uDesat * 0.7);
          diffuseColor *= mix(gA, gB, gm);
        #endif`)
      .replace('vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        'vec3 mapN = mix(texture2D( normalMap, vNormalMapUv ).xyz, texture2D( uNorB, vNormalMapUv * 0.83 ).xyz, gm) * 2.0 - 1.0;')
      .replace('vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );',
        'vec4 texelRoughness = mix(texture2D( roughnessMap, vRoughnessMapUv ), texture2D( uRoughB, vRoughnessMapUv * 0.83 ), gm);');
  };
  mat.customProgramCacheKey = () => 'oakground';
  mat.userData.uniforms = u;
  return mat;
}

// Saw palmetto and grasses: vertex-coloured, swaying a little in the wind.
export function createUnderstoryMaterial() {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aSway;\n${SWAY_GLSL}`)
      .replace('#include <project_vertex>', `
        vec4 worldP = modelMatrix * vec4(transformed, 1.0);
        worldP.xyz += windSway(worldP.xyz, aSway * 0.06);
        vec4 mvPosition = viewMatrix * worldP;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => 'oakunderstory';
  return mat;
}
