// Live oak skeleton generator.
//
// Architecture follows ez-tree (github.com/dgreenheck/ez-tree, MIT): the tree is
// first grown as a renderer-independent *skeleton* (polylines + radii, leaf and
// moss placements), then meshed separately. The skeleton is what we ship to
// Blender and, via Blender, to Unreal, so every renderer shows the same tree.
//
// What is specific to coastal live oak (Quercus virginiana) here:
//  * low first limbs and near-horizontal, sinuous, sagging limbs that can rest
//    an elbow on the ground and turn up again;
//  * growth over time: every branch has a birth year and an exponential growth
//    curve, so the Age slider replays the tree's life smoothly;
//  * salt pruning: an inclined "shear" surface rising leeward; buds that grow
//    through it on the windward side die back, leaving a dense hedge-like crown
//    edge, dead twig stubs and salt-burned leaves;
//  * wind tropism (leeward lean), windward flagging, and wind-axis root
//    buttressing at the trunk base;
//  * Spanish moss anchored on near-horizontal sheltered limbs.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const REF_AGE = 150; // slider dimensions describe a ~150 year old tree
// Years over which a branch level sprouts along its parent (base first, tip last).
const BIRTH_SPAN = [14, 10, 6, 3, 2, 2];
// Shoots thinner than this (m) can be killed by salt; thicker wood is steered.
const SALT_KILL_RADIUS = 0.04;

// ---------------------------------------------------------------- random ----

function hash32(a, b) {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

// Each branch gets its own stream keyed by its id, so changing the age (which
// adds or removes branches) never reshuffles the rest of the tree.
function rngFor(seed, id) {
  let s = hash32(seed, id) || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.sym = (a) => (next() * 2 - 1) * a;
  return next;
}

const growth = (years, tau) => (years <= 0 ? 0 : 1 - Math.exp(-years / tau));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function anyPerpendicular(v) {
  const p = Math.abs(v.y) < 0.95 ? new THREE.Vector3().crossVectors(v, UP) : new THREE.Vector3(1, 0, 0);
  return p.normalize();
}

// Rotate dir toward target by at most `angle` radians.
function bendToward(dir, target, angle) {
  if (angle <= 0) return;
  const axis = new THREE.Vector3().crossVectors(dir, target);
  const s = axis.length();
  if (s < 1e-6) return;
  const full = Math.atan2(s, dir.dot(target));
  dir.applyAxisAngle(axis.divideScalar(s), Math.min(full, angle)).normalize();
}

// ------------------------------------------------------------- wind model ---

export function windVectors(p) {
  const t = THREE.MathUtils.degToRad(p.windDir);
  // North = -Z, East = +X.
  const from = new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));
  const lee = from.clone().negate();
  return { from, lee };
}

// The salt-shear surface: y = base + tan(shear) * (distance leeward).
// Weak exposure lifts it out of the crown entirely.
export function shearSurface(p, crownHeight, spread = 12) {
  const { lee } = windVectors(p);
  const s = p.saltExposure * (0.3 + 0.7 * p.windStrength);
  // At the trunk the surface sits at most ~1/3 below full crown height; it
  // ramps down toward the sea and up leeward, so a salt-pruned oak keeps its
  // stature on the lee side instead of being flattened into a mat.
  const base = crownHeight * (0.95 - 0.32 * s) + Math.pow(1 - s, 3) * 25;
  const slope = Math.tan(THREE.MathUtils.degToRad(p.shearAngle));
  // Salt-sheared crowns are smooth overall but billowy, never a clipped plane:
  // a few seeded long-wavelength undulations (amplitude ~0.6–1.5 m).
  const nr = rngFor(p.seed, 4711);
  const waves = [0, 1, 2, 3].map((k) => ({
    kx: nr.range(-1, 1) * (0.25 + 0.3 * k), kz: nr.range(-1, 1) * (0.25 + 0.3 * k),
    ph: nr() * 6.283, a: (0.6 + 0.06 * crownHeight) / (1 + k * 0.7),
  }));
  const billow = (x, z) => waves.reduce((acc, w) => acc + w.a * Math.sin(w.kx * x + w.kz * z + w.ph), 0);
  return {
    severity: s,
    base,
    slope,
    lee,
    spread,
    // Inclined plane plus a gentle dome, so the sheared crown edges round off.
    height(x, z) {
      const r2 = (x * x + z * z) / (spread * spread);
      return base + slope * (x * lee.x + z * lee.z) - base * 0.2 * r2 + billow(x, z);
    },
  };
}

// Retention pond beside the tree: a disc whose near shore is a few metres
// from the trunk. Shared with the scene, understory and Blender/Unreal.
export function pondGeometry(p) {
  const t = THREE.MathUtils.degToRad(p.pondDir ?? 225);
  const dir = new THREE.Vector3(Math.sin(t), 0, -Math.cos(t));
  const radius = 16;
  const shore = 4.5;
  const center = dir.clone().multiplyScalar(shore + radius);
  // Irregular shoreline: a few seeded lobes and coves around the mean radius.
  const r = rngFor(p.seed, 777);
  const lobes = [[2, 0.16], [3, 0.11], [5, 0.07], [7, 0.04]].map(([k, a]) => [k, a * r.range(0.6, 1.3), r() * Math.PI * 2]);
  const toTree = Math.atan2(-center.z, -center.x);
  const shoreAt = (ang) => {
    let f = 1;
    for (const [k, a, ph] of lobes) f += a * Math.sin(k * ang + ph);
    // Keep the shore nearest the trunk where it was placed.
    const d = Math.cos(ang - toTree);
    return radius * (d > 0.8 ? 1 + (f - 1) * (1 - (d - 0.8) * 5) : f);
  };
  const outline = [];
  for (let i = 0; i < 96; i++) {
    const ang = (i / 96) * Math.PI * 2;
    const rr = shoreAt(ang);
    outline.push([+(center.x + Math.cos(ang) * rr).toFixed(3), +(center.z + Math.sin(ang) * rr).toFixed(3)]);
  }
  return {
    dir, radius, center, outline,
    contains(x, z, margin = 0) {
      const dx = x - center.x;
      const dz = z - center.z;
      return Math.hypot(dx, dz) < shoreAt(Math.atan2(dz, dx)) + margin;
    },
  };
}

// Light field: the direction a shoot at `pos` receives most light from.
//  * diffuse skylight from the open dome above;
//  * the sun's path, which at Amelia Island (~30.6°N) runs through the southern
//    sky (south = +Z here; mean elevation ~50°);
//  * over open water, skylight from the canopy gap plus light reflected off the
//    surface (strong at low sun angles), arriving from the pond side and below.
// Returns the horizontal pull (x, z) and a relative light level for leaves.
const SUN_MEAN = new THREE.Vector3(0, Math.sin(0.87), Math.cos(0.87));
export function lightField(pos, pond) {
  const v = new THREE.Vector3(0, 1, 0).addScaledVector(SUN_MEAN, 0.55);
  let water = 0;
  if (pond) {
    const dx = pond.center.x - pos.x;
    const dz = pond.center.z - pos.z;
    const d = Math.hypot(dx, dz);
    const toShore = Math.max(0, d - pond.radius);
    water = 0.9 * Math.exp(-toShore / 10);
    if (d > 1e-3) v.add(new THREE.Vector3((dx / d) * water, -0.25 * water, (dz / d) * water));
  }
  return { pull: new THREE.Vector2(v.x, v.z), level: 1 + 0.3 * SUN_MEAN.z * Math.sign(pos.z) * Math.min(1, Math.abs(pos.z) / 6) + water };
}

// Radial scale of the trunk cross-section near the ground: base flare plus
// buttressing elongated along the wind axis (both windward and leeward).
// `alpha` is the world-horizontal angle of a surface point around the trunk.
// Duplicated verbatim in blender/build_oak.py — keep the two in sync.
export function flareScale(p, y, alpha, trunkR, ageF) {
  // A short root collar where the roots meet the trunk, not a tall cone.
  const h = 0.15 + 0.3 * trunkR;
  const F = (0.1 + 0.55 * p.rootFlare) * Math.exp(-Math.max(0, y) / h) * ageF;
  const axis = Math.atan2(-Math.cos(THREE.MathUtils.degToRad(p.windDir)), Math.sin(THREE.MathUtils.degToRad(p.windDir)));
  const c = Math.cos(alpha - axis);
  const w = p.buttress * p.windStrength;
  return 1 + F * (0.55 + 1.6 * w * c * c) + F * 0.12 * Math.sin(alpha * 7.0);
}

// ---------------------------------------------------------- the generator ---

export function generateOak(p, opts = {}) {
  const t0 = performance.now();
  const quality = opts.quality || p.quality || 'high';
  const leafCap = { draft: 35000, high: 150000, ultra: 260000 }[quality];
  const full = p.fullness ?? 0.75;
  const age = p.age;
  const wind = windVectors(p);
  const ageF = growth(age, 60) / growth(REF_AGE, 60);
  const windYears = smooth(0, 80, age); // wind shaping accumulates with age

  const trunkR = Math.max(0.03, p.trunkRadius * Math.pow(age / REF_AGE, 0.8));
  const pond = p.pond ? pondGeometry(p) : null;
  const pondToward = (d) => {
    const h = Math.hypot(d.x, d.z);
    return h > 1e-3 ? Math.max(0, (d.x * pond.dir.x + d.z * pond.dir.z) / h) : 0;
  };
  const crownH = (p.trunkLength + 0.45 * p.limbLength) * ageF + 1;
  const shear = shearSurface(p, crownH, Math.max(4, p.limbLength * ageF * 1.1));

  const branches = [];
  const leaves = [];
  const moss = [];
  const prunedTips = [];
  const queue = [];

  const tau = [70, 45, 22, 11, 6, 4];
  const sections = [16, 14, 9, 6, 4, 3];

  // Trunk: leans leeward as the years go by.
  const lean = THREE.MathUtils.degToRad(30) * p.windLean * p.windStrength * windYears;
  const trunkDir = UP.clone();
  bendToward(trunkDir, wind.lee, lean * 0.3); // the rest accrues as curvature
  queue.push({
    id: 1, level: 0, birth: 0, origin: new THREE.Vector3(0, -0.4, 0), dir: trunkDir, parent: -1, joint: 0,
    maxLen: p.trunkLength * (1 - 0.65 * (p.lowSplit ?? 0)) + 0.4, radius: trunkR, parentRadius: trunkR,
  });

  while (queue.length) {
    const b = queue.shift();
    growBranch(b);
  }

  function growBranch(b) {
    const rng = rngFor(p.seed, b.id);
    const years = age - b.birth;
    if (years <= 0) return;
    const lvl = Math.min(b.level, tau.length - 1); // clamp table lookups
    const isTwig = lvl >= p.levels;

    // Length from the growth curve, normalised so sliders mean "at 150 years".
    let len = b.maxLen * Math.min(1.15, growth(years, tau[lvl]) / growth(REF_AGE - b.birth * 0.5, tau[lvl]));
    // Windward flagging: branches heading into the wind are stunted.
    const hd = new THREE.Vector3(b.dir.x, 0, b.dir.z);
    const hl = hd.length();
    const windward = hl > 1e-3 ? Math.max(0, hd.dot(wind.from) / hl) : 0;
    const leeward = hl > 1e-3 ? Math.max(0, -hd.dot(wind.from) / hl) : 0;
    if (lvl >= 1) {
      len *= 1 - 0.65 * p.flagging * p.windStrength * windward * windYears;
      len *= 1 + 0.3 * p.windLean * p.windStrength * leeward * windYears;
    }
    if (lvl >= 1 && lvl <= 2 && pond) len *= 1 + 0.35 * pondToward(b.dir);
    if (len < 0.02) return;

    const n = sections[Math.min(lvl, sections.length - 1)];
    const segLen = len / n;
    const pos = b.origin.clone();
    const dir = b.dir.clone();
    const omega = new THREE.Vector3();
    // Branch collar: the branch starts on its parent's axis heading partly
    // along the parent, curves out to its own direction, and its base swells
    // where it meets the parent, tapering back over a couple of diameters.
    // This makes the junction grow out of the parent instead of being a tube
    // pushed into it.
    const collar = { pts: [], radii: [], dirs: [] };
    if (b.continuation) {
      // The leader carrying on from the trunk: same point, width and heading
      // as the trunk's end, bending gradually to its own direction. The trunk
      // has no end cap, so there is no stump.
      const m = 6;
      const Lc = b.parentRadius * 2.5;
      const cd = b.parentDir.clone();
      for (let k = 0; k < m; k++) {
        const u = k / m;
        collar.pts.push(pos.clone());
        collar.radii.push(b.parentRadius + (b.radius - b.parentRadius) * u * u * (3 - 2 * u));
        collar.dirs.push(cd.clone());
        bendToward(cd, b.dir, 1.2 / m);
        pos.addScaledVector(cd, Lc / m);
      }
      dir.copy(cd);
      bendToward(dir, b.dir, 1);
    } else if (b.parentDir && lvl >= 1 && lvl <= 3) {
      const pr0 = b.parentRadius;
      const r0 = b.radius;
      const Lc = pr0 + 2.5 * r0;
      const m = lvl === 1 ? 7 : 4;
      const cd = b.parentDir.clone().lerp(b.dir, 0.35).normalize();
      for (let k = 0; k < m; k++) {
        const sDist = (k / m) * Lc;
        const outside = Math.max(0, sDist - pr0 * 0.8);
        const swell = 1 + 0.75 * Math.exp(-outside / (1.2 * r0));
        collar.pts.push(pos.clone());
        collar.radii.push(Math.min(pr0 * 0.97, r0 * swell));
        collar.dirs.push(cd.clone());
        bendToward(cd, b.dir, 1.4 / m);
        pos.addScaledVector(cd, Lc / m);
      }
      dir.copy(cd);
      bendToward(dir, b.dir, 1);
    }
    const pts = [pos.clone()];
    const radii = [b.radius];
    const dirs = [dir.clone()];
    // Live oak limbs stay thick for a long way (low taper).
    // A live oak trunk is close to a cylinder, never a tapering cone.
    const taper = lvl === 0 ? 0.06 : isTwig ? 0.92 : lvl === 1 ? 0.5 : 0.62;
    let pruned = false;

    // Limbs heading toward open water get more light: longer, lower, and they
    // may dip below the surface.
    const towardPond = pond && hl > 1e-3 ? Math.max(0, (hd.x * pond.dir.x + hd.z * pond.dir.z) / hl) : 0;
    const groundClear = (p.limbClearance ?? 1) * rng.range(0.6, 1.4) * (1 - towardPond);
    let stunt = 1;
    const wavePhase = rng() * Math.PI * 2;
    const waveFreq = rng.range(5, 9);
    const gnarl = lvl === 0 ? 0.05 + 0.12 * p.trunkGnarl : (0.05 + 0.16 * p.sinuosity) * (lvl === 1 ? 1 : 1.25);

    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // Linear taper, then the last quarter narrows smoothly to twig size so
      // no limb ends in a blunt, sawn-off tip (the trunk ends inside its fork).
      const tail = lvl >= 1 ? smooth(0.72, 1, t) : 0;
      const r = (b.radius * (1 - taper * t) * (1 - tail) + Math.max(0.006, Math.min(0.02, b.radius * 0.15)) * tail) * stunt;

      // Sinuous wandering: random angular impulses with momentum give the
      // serpentine limbs typical of live oak instead of a jittery random walk.
      const perp = anyPerpendicular(dir).applyAxisAngle(dir, rng() * Math.PI * 2);
      omega.addScaledVector(perp, rng.range(0.4, 1) * gnarl);
      omega.multiplyScalar(0.72);
      const w = omega.length();
      if (w > 1e-5) dir.applyAxisAngle(omega.clone().divideScalar(w), w).normalize();

      // Crooked, zig-zag growth: oaks grow sympodially, so the axis kinks
      // where a terminal bud died and a lateral took over.
      if (lvl >= 1 && rng() < 0.12 + 0.3 * p.sinuosity) {
        const k = anyPerpendicular(dir).applyAxisAngle(dir, rng() * Math.PI * 2);
        dir.applyAxisAngle(k, THREE.MathUtils.degToRad(rng.range(10, 18 + 22 * p.sinuosity))).normalize();
      }
      // Big limbs undulate up and down like waves along their length.
      if (lvl >= 1 && lvl <= 2) {
        const side = new THREE.Vector3().crossVectors(dir, UP);
        if (side.lengthSq() > 1e-4) {
          side.normalize();
          dir.applyAxisAngle(side, Math.sin(wavePhase + t * waveFreq) * (lvl === 1 ? 0.15 : 0.09) * p.sinuosity).normalize();
          // ...and snake side to side as well.
          dir.applyAxisAngle(UP, Math.sin(wavePhase * 1.7 + t * waveFreq * 0.7) * (lvl === 1 ? 0.1 : 0.05) * p.sinuosity).normalize();
        }
      }

      // Tropisms.
      const flex = 0.05 / (r + 0.05); // thin wood bends more
      if (lvl === 0) {
        // Wind-trained trunks curve progressively leeward with height.
        if (lean > 0.001) bendToward(dir, wind.lee, (lean * 0.7 * 1.6) / n);
        else bendToward(dir, UP, 0.03);
      } else if (lvl <= 2) {
        // Limbs leave the trunk rising, then arch outward under their own
        // weight (sag peaks a third of the way out).
        // Over open water heavy limbs droop from the start.
        const archBase = lvl === 1 ? smooth(0.08, 0.35, t) * (1.15 - t) : 1 - t;
        const arch = archBase + (1 - archBase) * towardPond * 0.8;
        // Very long, heavy main limbs bow to the ground over the decades (the
        // Alachua champion's twelve limbs all do) — only when clearance allows.
        const lengthSag = lvl === 1 ? smooth(8, 22, b.maxLen) * smooth(0.55, 0.9, hl) * Math.max(0, 1 - (p.limbClearance ?? 1)) : 0;
        const sag = p.limbSag * (lvl === 1 ? 1.25 : 0.5) * arch * 0.16 * (0.3 + flex + 1.6 * lengthSag) * (1 + 2.2 * towardPond);
        const up = p.tipUpturn * t * t * (lvl === 1 ? 0.22 : 0.12) * (1 - 0.85 * towardPond);
        bendToward(dir, DOWN, sag);
        bendToward(dir, UP, up);
      } else {
        bendToward(dir, UP, 0.06); // twigs reach for light
      }
      // Light seeking: shoots swing toward the brighter side of the light
      // field (vertical light is already in the up-turn terms above).
      if (lvl >= 1 && p.lightSeeking > 0) {
        const lf = lightField(pos, pond).pull;
        const m = lf.length();
        if (m > 0.02) {
          const cp = Math.sqrt(Math.max(0, 1 - dir.y * dir.y));
          const target = new THREE.Vector3((lf.x / m) * cp, dir.y, (lf.y / m) * cp).normalize();
          bendToward(dir, target, p.lightSeeking * 0.04 * m * (0.4 + 2 * flex));
        }
      }
      // Wind: steady leeward growth bias, strongest in flexible young wood.
      if (lvl >= 1) {
        // Mostly young, flexible wood is trained by the wind; old limbs barely move.
        const k = p.windLean * p.windStrength * windYears * 0.045 * (0.15 + 2.5 * flex);
        const leeTarget = wind.lee.clone().addScaledVector(UP, 0.15).normalize();
        bendToward(dir, leeTarget, k);
      }

      pos.addScaledVector(dir, segLen);

      // Ground clearance: most low limbs hang a metre or two up; only very
      // heavy sag lets an elbow rest on the ground before it turns upward.
      // Over the pond the "floor" is below the water surface.
      const overWater = pond && pond.contains(pos.x, pos.z);
      const clear = overWater ? -0.35 : r + 0.04 + groundClear;
      if (lvl >= 1 && pos.y < clear) {
        pos.y = clear;
        if (dir.y < 0.12) {
          dir.y = 0.12 + rng() * 0.15;
          dir.normalize();
          omega.multiplyScalar(0.3);
        }
      }

      // Salt pruning. Salt kills buds and young shoots, never old wood: thick
      // limbs ended up below the surface because their tips kept dying back
      // while young, so they are steered leeward and under the surface. Only
      // thin shoots that poke through actually die.
      if (lvl >= 1 && shear.severity > 0) {
        const surf = shear.height(pos.x, pos.z);
        const over = pos.y - surf;
        if (over > -0.3 && r > SALT_KILL_RADIUS) {
          // Growth checked by salt means less leaf area and so less wood:
          // the limb thins quickly instead of staying trunk-sized.
          stunt *= 0.82;
          pos.addScaledVector(dir, -segLen);
          // Flatten out along the surface, keeping the limb's own heading
          // with only a slight leeward drift.
          const flat = new THREE.Vector3(dir.x, 0, dir.z);
          if (flat.lengthSq() < 1e-4) flat.copy(wind.lee);
          flat.normalize().addScaledVector(wind.lee, 0.35);
          flat.y = -0.12 - 0.3 * smooth(-0.3, 1, over);
          bendToward(dir, flat.normalize(), 0.25 + 0.35 * shear.severity);
          pos.addScaledVector(dir, segLen);
          pos.y = Math.min(pos.y, shear.height(pos.x, pos.z) - 0.25);
          pos.y = Math.max(pos.y, r + 0.04 + groundClear);
        } else if (over > 0) {
          const pDie = smooth(0, 0.8, over) * (0.4 + 0.6 * shear.severity);
          if (rng() < pDie + 0.15) {
            pruned = true;
            pos.addScaledVector(dir, -segLen * 0.5);
            // Dieback leaves a tapering shoot, not a sawn-off end.
            if (radii.length > 1) radii[radii.length - 1] *= 0.7;
            pts.push(pos.clone());
            radii.push(Math.max(0.003, r * 0.25));
            dirs.push(dir.clone());
            break;
          }
        }
      }

      pts.push(pos.clone());
      radii.push(i === n && isTwig ? r * 0.3 : r);
      dirs.push(dir.clone());
    }

    const index = branches.length;
    // parent/joint make the skeleton a true graph: this branch hangs off
    // joint `joint` of branch `parent` (-1 for the trunk).
    branches.push({
      level: lvl, pruned, root: false, parent: b.parent, joint: b.joint,
      points: [...collar.pts, ...pts], radii: [...collar.radii, ...radii], dirs: [...collar.dirs, ...dirs],
    });
    const jointOffset = collar.pts.length;

    if (pruned && !b.hedge) {
      const tip = pts[pts.length - 1];
      prunedTips.push(tip.clone());
      // Dieback stimulates a dense tuft of short shoots just below the cut —
      // this is what makes salt-sheared crowns look clipped like a hedge.
      const tuft = Math.round(3 + 4 * shear.severity);
      for (let k = 0; k < tuft; k++) {
        const d = dirs[dirs.length - 1].clone();
        d.applyAxisAngle(anyPerpendicular(d).applyAxisAngle(d, rng() * 6.283), rng.range(0.6, 1.4));
        d.y = Math.min(d.y, 0.25);
        d.addScaledVector(wind.lee, 0.6).normalize();
        queue.push({
          id: hash32(b.id, 1000 + k), level: Math.min(tau.length - 1, Math.max(lvl + 1, p.levels)), birth: b.birth + 1,
          origin: tip.clone().addScaledVector(DOWN, 0.1), dir: d,
          maxLen: rng.range(0.35, 0.8), radius: Math.max(0.006, radii[radii.length - 1] * 0.5), hedge: true,
          parent: index, joint: pts.length - 1,
        });
      }
      // Dead grey stubs pointing into the wind.
      if (rng() < p.deadTwigs * 0.4) {
        const d = dirs[dirs.length - 1].clone().addScaledVector(wind.from, 0.8).addScaledVector(UP, 0.3).normalize();
        const L = rng.range(0.08, 0.25);
        branches.push({
          level: lvl + 1, root: false, pruned: true, dead: true, parent: index, joint: pts.length - 1,
          points: [tip.clone(), tip.clone().addScaledVector(d, L)],
          radii: [Math.max(0.003, Math.min(0.012, radii[radii.length - 1])), 0.0015],
          dirs: [d.clone(), d.clone()],
        });
      }
    }

    // Children.
    let childCount = 0;
    if (lvl < p.levels && !b.hedge) {
      const count = lvl === 0 ? p.limbCount : lvl === 1 ? p.children + 3 : p.children + Math.round(2.5 * full);
      const split = p.lowSplit ?? 0;
      const trunkLen = p.trunkLength * (1 - 0.65 * split);
      const startFrac = lvl === 0 ? clamp((p.trunkHeight * (1 - 0.6 * split)) / Math.max(0.5, trunkLen), 0.04, 0.95) : 0.18;
      const builtLen = segLen * (pts.length - 1);
      const radial0 = rng() * Math.PI * 2;
      for (let c = 0; c < count; c++) {
        const crng = rngFor(p.seed, hash32(b.id, c + 1));
        // The trunk does not simply stop: its top divides into two co-dominant
        // leaders (a fork), so the last two limbs start right at the tip.
        const fork = lvl === 0 && count >= 3 && c >= count - 2;
        const s = fork
          ? 0.985
          : startFrac + (fork ? 0 : (1 - startFrac) * (c + crng.range(0.15, 0.85)) / (lvl === 0 && count >= 3 ? count - 2 : count));
        // Born once the parent has grown past this point.
        const birth = b.birth + 1 + s * BIRTH_SPAN[lvl] + crng.range(0, 2);
        if (birth >= age) continue;
        const at = s * len;
        if (at > builtLen) continue; // that part of the parent was pruned away
        const f = (at / builtLen) * (pts.length - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(pts.length - 1, i0 + 1);
        const a = f - i0;
        const origin = pts[i0].clone().lerp(pts[i1], a);
        const pdir = dirs[i0].clone().lerp(dirs[i1], a).normalize();
        const pr = radii[i0] * (1 - a) + radii[i1] * a;

        // Golden-angle spiral with jitter keeps limbs well spread.
        const phi = fork ? radial0 + (c - count + 2) * Math.PI + crng.sym(0.4) : radial0 + c * 2.39996 + crng.sym(0.5);
        const side = anyPerpendicular(pdir).applyAxisAngle(pdir, phi);
        let angle;
        if (lvl === 0) {
          // Lower limbs are more horizontal; the top ones more upright.
          // One fork leader continues almost in line with the trunk (so the
          // trunk flows into it), the other diverges.
          angle = fork ? (c === count - 2 ? 10 + crng.sym(4) : 40 + crng.sym(8)) : p.limbAngle + (0.5 - s) * 22 + crng.sym(8);
        } else {
          angle = p.childAngle + crng.sym(12);
        }
        const cdir = pdir.clone().applyAxisAngle(side, THREE.MathUtils.degToRad(angle)).normalize();
        // Open water is a light gap (open sky plus reflected light): main limbs swing toward it.
        if (lvl === 0 && pond && !fork) {
          const h = new THREE.Vector3(cdir.x, 0, cdir.z);
          // The lowest limbs, nearest the water, respond most.
          const low = c < 3;
          if (h.lengthSq() > 1e-4 && h.normalize().dot(pond.dir) > (low ? -0.7 : -0.3)) {
            const y = cdir.y;
            bendToward(h, pond.dir, THREE.MathUtils.degToRad((low ? 70 : 30) * (0.4 + 1.2 * (p.lightSeeking ?? 0.5))));
            cdir.set(h.x * Math.sqrt(1 - y * y), y, h.z * Math.sqrt(1 - y * y)).normalize();
          }
        }
        // Make sure the rotation went away from the parent axis in a consistent sense.
        if (lvl === 0) {
          const h = new THREE.Vector3(cdir.x, 0, cdir.z);
          if (h.lengthSq() < 1e-4) cdir.copy(side);
        }

        let maxLen;
        let radius;
        if (lvl === 0) {
          maxLen = p.limbLength * crng.range(0.75, 1.15) * (1 - 0.25 * (s - startFrac));
          // Low division: the first limbs are trunk-sized, so there is no
          // obvious single trunk (common in big open-grown live oaks).
          radius = Math.max(0.02, pr * (fork ? (c === count - 2 ? 0.8 : 0.68)
            : Math.min(0.85, (p.radiusRatio + 0.08 + 0.3 * split) * crng.range(0.7, 1.05))));
        } else {
          maxLen = b.maxLen * p.lengthRatio * crng.range(0.7, 1.1) * (1 - 0.45 * s);
          radius = Math.max(0.006, pr * p.radiusRatio * crng.range(0.8, 1));
        }
        // Embed the base slightly in the parent so junctions have no gaps.
        // The continuing leader starts exactly where the trunk ends, at its
        // width, so the trunk flows into it.
        const continuation = fork && c === count - 2;
        if (continuation) {
          radius = Math.max(radius, radii[radii.length - 1] * 0.9);
          branches[index].continued = true;
        }
        queue.push({
          id: hash32(b.id, c + 1), level: lvl + 1, birth, dir: cdir, maxLen, radius,
          origin: continuation ? pts[pts.length - 1].clone() : origin,
          parent: index, joint: continuation ? pts.length - 1 + jointOffset : i0 + jointOffset,
          parentDir: continuation ? dirs[dirs.length - 1].clone() : pdir.clone(),
          parentRadius: continuation ? radii[radii.length - 1] : pr,
          continuation,
        });
        childCount++;
      }
    }

    // Leaves on twigs, on branches with no children yet (young trees), and densely on hedge tufts.
    const terminal = lvl >= 1 && (isTwig || childCount === 0 || b.hedge);
    const subTerminal = lvl >= 2 && lvl === p.levels - 1;
    if ((terminal || subTerminal) && p.leafDensity > 0 && !pruned) {
      const lrng = rngFor(p.seed, hash32(b.id, 7777));
      const scale = (b.hedge ? 1.6 : 1) * (terminal ? 1 : 0.35);
      const count = Math.round(p.leafDensity * scale * clamp(len / 1.2, 0.3, 2.5) * (0.45 + 0.9 * full));
      const total = pts.length - 1;
      for (let k = 0; k < count; k++) {
        // Bias toward the tip: live oak leaves cluster at shoot ends.
        const u = 1 - Math.pow(lrng(), 1 + 2.5 * p.clumping);
        const f = 0.25 * (1 - p.clumping) + u * (1 - 0.25 * (1 - p.clumping));
        const fi = f * total;
        const i0 = Math.min(total - 1, Math.floor(fi));
        const a = fi - i0;
        const at = pts[i0].clone().lerp(pts[i0 + 1], a);
        const bd = dirs[i0].clone().lerp(dirs[i0 + 1], a).normalize();
        // Petiole direction: out from the twig, slightly forward.
        const out = anyPerpendicular(bd).applyAxisAngle(bd, lrng() * Math.PI * 2);
        const fwd = out.clone().multiplyScalar(0.8).addScaledVector(bd, 0.6).normalize();
        // Leaf blade faces mostly up toward the sky, with variation.
        const nrm = UP.clone().multiplyScalar(0.7)
          .add(new THREE.Vector3(lrng.sym(0.6), lrng.sym(0.3), lrng.sym(0.6)))
          .addScaledVector(fwd, -fwd.dot(UP));
        nrm.addScaledVector(fwd, -nrm.dot(fwd)).normalize();
        if (!Number.isFinite(nrm.x) || nrm.lengthSq() < 0.5) nrm.copy(anyPerpendicular(fwd));
        at.addScaledVector(out, radii[i0] * 0.8);

        // Salt burn on windward, exposed leaves near the shear surface.
        const hp = new THREE.Vector3(at.x, 0, at.z);
        const radial = hp.length();
        const exposure = radial > 0.1 ? Math.max(0, hp.dot(wind.from) / radial) : 0;
        const nearSurface = shear.severity > 0 ? smooth(-2.5, 0, at.y - shear.height(at.x, at.z)) : 0;
        const burn = clamp(p.saltBurn * shear.severity * (0.8 * exposure + 0.6 * nearSurface) * (0.6 + 0.8 * lrng()), 0, 1);

        leaves.push({
          pos: at, fwd, nrm,
          size: p.leafSize * lrng.range(0.75, 1.25) * (b.hedge ? 0.85 : 1) * (0.85 + 0.35 * full),
          atlas: Math.floor(lrng() * 6) % 6,
          burn,
          vary: lrng(),
        });
      }
    }

    // Spanish moss on sheltered, near-horizontal limbs of decent girth.
    if (lvl >= 1 && lvl <= 3 && p.mossDensity > 0 && age > 12 && !b.hedge) {
      const mrng = rngFor(p.seed, hash32(b.id, 4242));
      for (let i = 1; i < pts.length; i++) {
        const d = dirs[i];
        const r = radii[i];
        if (r < 0.025 || Math.abs(d.y) > 0.6) continue;
        const a = pts[i];
        const hp = new THREE.Vector3(a.x, 0, a.z);
        const radial = hp.length();
        const windwardness = radial > 0.1 ? Math.max(0, hp.dot(wind.from) / radial) : 0;
        const shelter = 1 - p.mossShelter * windwardness * (0.4 + 0.6 * shear.severity);
        const segLenHere = a.distanceTo(pts[i - 1]);
        const pAnchor = p.mossDensity * 0.85 * segLenHere * shelter * smooth(12, 40, age);
        if (mrng() > pAnchor) continue;
        const anchor = a.clone().lerp(pts[i - 1], mrng()).addScaledVector(DOWN, r * 0.85);
        const clump = Math.max(1, Math.round(p.mossClump * mrng.range(0.5, 1.3)));
        for (let k = 0; k < clump; k++) {
          const L = p.mossLength * mrng.range(0.35, 1.25) * smooth(10, 60, age + 10);
          const offs = new THREE.Vector3(mrng.sym(1), 0, mrng.sym(1)).multiplyScalar(p.mossWidth * 0.7);
          const start = anchor.clone().add(offs).addScaledVector(d, mrng.sym(p.mossWidth));
          const drift = wind.lee.clone().multiplyScalar(0.25 * p.windStrength)
            .add(new THREE.Vector3(mrng.sym(0.15), 0, mrng.sym(0.15)));
          const strand = [start.clone()];
          const segs = 7;
          const q = start.clone();
          for (let s = 1; s <= segs; s++) {
            const tt = s / segs;
            q.y -= L / segs;
            q.addScaledVector(drift, (L / segs) * tt * 1.4);
            q.x += mrng.sym(0.02);
            q.z += mrng.sym(0.02);
            if (q.y < 0.05) break;
            strand.push(q.clone());
          }
          if (strand.length > 2) {
            moss.push({ points: strand, width: p.mossWidth * mrng.range(0.6, 1.2), seed: mrng() });
          }
        }
      }
    }
  }

  // Roots: an irregular set of buttress and surface roots. Count, spacing,
  // thickness and length all vary; the ones on the wind axis are larger.
  // Each root tapers fast near the trunk (the zone of rapid taper), then
  // slowly; it snakes, rises and dips along the surface and may fork.
  const roots = [];
  if (p.rootSpread > 0 || p.rootXray) {
    const rr = rngFor(p.seed, 99);
    const n = 6 + Math.floor(rr() * 6);
    const axis = Math.atan2(wind.from.z, wind.from.x);
    const wAxis = p.buttress * p.windStrength * windYears;
    // Uneven spacing: random gaps, normalised to a full circle.
    const gaps = Array.from({ length: n }, () => rr.range(0.4, 1.6));
    const gsum = gaps.reduce((x, y) => x + y, 0);
    let phi = rr() * Math.PI * 2;
    const grow = (start, dir0, R0, L, depth, rootRng) => {
      const ns = Math.max(4, Math.round((p.rootXray ? 16 : 10) * Math.min(1, L / 4) + 3));
      const pos = start.clone();
      const dir = dir0.clone();
      const pts = [pos.clone()];
      const radii = [R0];
      const dirs = [dir.clone()];
      let turn = 0;
      const wavePh = rootRng() * 6.28;
      const waveF = rootRng.range(2, 5);
      for (let s = 1; s <= ns; s++) {
        const t = s / ns;
        turn = turn * 0.7 + rootRng.sym(0.35);
        dir.applyAxisAngle(UP, turn);
        dir.y = p.rootXray ? -0.1 - 0.25 * t * rootRng() : -0.05;
        dir.normalize();
        pos.addScaledVector(dir, L / ns);
        // Rapid taper for the first ~20%, then slow.
        const r = R0 * (0.35 + 0.65 * Math.exp(-t * 7)) * (1 - 0.8 * t);
        if (!p.rootXray) {
          // Surface roots ride along the sand, humping up and sinking in.
          const hump = Math.max(0, Math.sin(wavePh + t * waveF * Math.PI)) * r * 0.6;
          pos.y = Math.max(-r * 0.6, r * (0.45 - 1.2 * t) + hump);
        }
        pts.push(pos.clone());
        radii.push(Math.max(0.008, r));
        dirs.push(dir.clone());
        // Occasional fork into a smaller lateral root.
        if (depth === 0 && s > 1 && s < ns - 2 && rootRng() < 0.18) {
          const side = rootRng() < 0.5 ? 1 : -1;
          const d2 = dir.clone().applyAxisAngle(UP, side * rootRng.range(0.5, 1.1));
          grow(pos.clone(), d2, r * rootRng.range(0.45, 0.7), L * (1 - t) * rootRng.range(0.4, 0.8), 1, rootRng);
        }
      }
      roots.push({ level: 1 + depth, points: pts, radii, dirs, root: true, parent: 0, joint: 0 });
    };
    for (let i = 0; i < n; i++) {
      phi += (gaps[i] / gsum) * Math.PI * 2;
      const ac = Math.abs(Math.cos(phi - axis));
      // Log-normal size variation plus wind-axis reinforcement.
      const size = (0.45 + 0.6 * p.rootSpread) * Math.exp(rr.sym(0.45)) * (0.65 + 1.1 * wAxis * ac * ac) * ageF;
      const R0 = trunkR * 0.5 * size;
      if (R0 < 0.01) continue;
      const L = ((p.rootXray ? 6 : 2.2) * trunkR * (0.8 + size) + 0.5) * rr.range(0.45, 1.4);
      const dir = new THREE.Vector3(Math.cos(phi), -0.05, Math.sin(phi)).normalize();
      const start = new THREE.Vector3(Math.cos(phi) * trunkR * 0.3, 0.25 * trunkR, Math.sin(phi) * trunkR * 0.3);
      grow(start, dir, R0, L, 0, rngFor(p.seed, 990 + i));
    }
  }

  // Self-shading: shoots deep beneath the canopy top get too little light and
  // shed, so the foliage forms a roof over bare inner limbs (as in the field
  // photos). Canopy top height is tracked on a 1 m grid.
  let litLeaves = leaves;
  if (p.interiorShade > 0 && leaves.length) {
    const cell = 1.0;
    const top = new Map();
    const key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    for (const l of leaves) {
      const k = key(l.pos.x, l.pos.z);
      top.set(k, Math.max(top.get(k) ?? -1e9, l.pos.y));
    }
    // Blur the top surface a little so single high twigs do not shade a column.
    const topAt = (x, z) => {
      let sum = 0;
      let w = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const v = top.get(key(x + dx * cell, z + dz * cell));
          if (v !== undefined) {
            sum += v;
            w++;
          }
        }
      }
      return w ? sum / w : -1e9;
    };
    const srng = rngFor(p.seed, 31);
    // Open-grown live oaks show a clear trunk and a lifted crown base; on a
    // salt-sheared dune tree the hedge reaches the ground instead.
    const crownBase = (1.2 + 1.6 * p.interiorShade) * ageF * (1 - 0.8 * shear.severity);
    litLeaves = leaves.filter((l) => {
      const depth = topAt(l.pos.x, l.pos.z) - l.pos.y;
      const bright = (p.lightSeeking ?? 0.5) * Math.max(0, lightField(l.pos, pond).level - 1);
      const shade = Math.max(smooth(1.2, 3.5, depth), 1 - smooth(crownBase * 0.6, crownBase * 1.25, l.pos.y)) * p.interiorShade * (1 - 0.5 * Math.min(1, bright));
      return srng() > shade * (1.1 - 0.45 * full);
    });
  }

  // Leaf budget per quality level.
  let keptLeaves = litLeaves;
  if (litLeaves.length > leafCap) {
    const keep = leafCap / litLeaves.length;
    const r = rngFor(p.seed, 5);
    keptLeaves = litLeaves.filter(() => r() < keep);
    const grow = Math.sqrt(1 / keep);
    for (const l of keptLeaves) l.size *= Math.min(1.8, grow);
  }

  return {
    params: { ...p },
    branches,
    roots,
    leaves: keptLeaves,
    moss,
    prunedTips,
    trunkRadius: trunkR,
    ageFactor: ageF,
    windYears,
    crownHeight: crownH,
    shear: { base: shear.base, slope: shear.slope, severity: shear.severity, lee: shear.lee.toArray(), spread: shear.spread },
    pond: pond ? { center: pond.center.toArray(), radius: pond.radius, outline: pond.outline } : null,
    stats: {
      branches: branches.length,
      leaves: keptLeaves.length,
      moss: moss.length,
      pruned: prunedTips.length,
      ms: performance.now() - t0,
    },
  };
}

// Plain-JSON version of the skeleton for Blender (rounded to keep it small).
export function skeletonToJSON(sk) {
  const r3 = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
  const branch = (b) => ({
    level: b.level, root: !!b.root, dead: !!b.dead, parent: b.parent, joint: b.joint, continued: !!b.continued,
    points: b.points.map(r3), radii: b.radii.map((x) => +x.toFixed(4)),
  });
  return {
    version: 1,
    params: sk.params,
    trunkRadius: sk.trunkRadius,
    ageFactor: sk.ageFactor,
    windYears: sk.windYears,
    shear: sk.shear,
    pond: sk.pond,
    branches: sk.branches.map(branch),
    roots: sk.roots.map(branch),
    leaves: sk.leaves.map((l) => [...r3(l.pos), ...r3(l.fwd), ...r3(l.nrm), +l.size.toFixed(4), l.atlas, +l.burn.toFixed(3), +l.vary.toFixed(3)]),
    moss: sk.moss.map((m) => ({ points: m.points.map(r3), width: +m.width.toFixed(3), seed: +m.seed.toFixed(4) })),
  };
}
