// Maritime-hammock understory around the oak.
//
// Coastal live oaks on Amelia Island grow in maritime hammock / maritime
// forest: a live oak canopy over saw palmetto, yaupon holly and wax myrtle,
// a sparse herb layer (wood-oats in sunny gaps) and a floor of oak leaf
// litter on sandy soil, grading seaward into dune scrub with sea oats.
// (NPS Timucuan Preserve "Maritime Hammock"; FNAI Maritime Hammock profile;
// USGS NVCS live oak – cabbage palmetto alliance.)
//
// Saw palmetto and grasses are built as one vertex-coloured mesh; yaupon and
// wax myrtle shrubs reuse the photographed leaf sprigs as instances.

import * as THREE from 'three';
import { windVectors, pondGeometry } from './oakGenerator.js?v=20261026172345';

export const GROUND_TYPES = {
  hammock: 'Maritime hammock (litter, palmetto)',
  edge: 'Forest edge (litter, grasses)',
  dune: 'Dune scrub (sand, sea oats)',
};

const MIX = {
  hammock: { palmetto: 1.0, shrub: 0.7, grass: 0.25, oats: 0 },
  edge: { palmetto: 0.6, shrub: 0.5, grass: 1.0, oats: 0.1 },
  dune: { palmetto: 0.35, shrub: 0.35, grass: 0.2, oats: 1.0 },
};

function rng(seed) {
  let s = seed >>> 0 || 1;
  const r = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  return r;
}

class MeshBuilder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.sway = [];
    this.idx = [];
  }

  vert(p, c, s) {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c.r, c.g, c.b);
    this.sway.push(s);
    return this.pos.length / 3 - 1;
  }

  // A tapered, slightly folded strip along a polyline.
  strip(points, widths, side, color, swayBase = 0) {
    const n = points.length;
    const base = this.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const w = widths[i] * 0.5;
      const t = i / (n - 1);
      const shade = color.clone().multiplyScalar(0.75 + 0.35 * t);
      this.vert(points[i].clone().addScaledVector(side, -w), shade, swayBase + t);
      this.vert(points[i].clone().addScaledVector(side, w), shade, swayBase + t);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// Saw palmetto (Serenoa repens): fronds on long petioles, each a palmate fan
// of ~20 stiff, folded leaflets. Coastal plants are often silvery blue-green.
function sawPalmetto(mb, at, r, scale) {
  const fronds = Math.round(r.range(9, 16));
  const base = new THREE.Color().setHSL(r.range(0.2, 0.29), r.range(0.3, 0.5), r.range(0.12, 0.18));
  for (let f = 0; f < fronds; f++) {
    const az = r() * Math.PI * 2;
    const tilt = r.range(0.35, 1.05); // from vertical
    const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
    const petiole = r.range(0.5, 1.1) * scale;
    const start = at.clone().add(new THREE.Vector3(r.range(-0.15, 0.15), 0, r.range(-0.15, 0.15)));
    const tip = start.clone().addScaledVector(dir, petiole);
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    mb.strip([start, start.clone().lerp(tip, 0.5), tip], [0.025, 0.02, 0.015], side, base.clone().multiplyScalar(0.7), 0);
    // Fan: leaflets spread over ~200° around the frond's facing direction.
    const facing = dir.clone().applyAxisAngle(side, -0.6).normalize();
    const up = new THREE.Vector3().crossVectors(side, facing).normalize();
    const leaflets = Math.round(r.range(14, 20));
    const radius = r.range(0.45, 0.75) * scale;
    const col = base.clone().offsetHSL(r.range(-0.02, 0.02), 0, r.range(-0.04, 0.04));
    for (let k = 0; k < leaflets; k++) {
      const a = -1.75 + (3.5 * k) / (leaflets - 1) + r.range(-0.05, 0.05);
      const ld = facing.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).addScaledVector(up, 0.25).normalize();
      const pts = [];
      const L = radius * r.range(0.85, 1.1);
      for (let s = 0; s <= 3; s++) {
        const t = s / 3;
        // Leaflet tips droop under their own weight.
        pts.push(tip.clone().addScaledVector(ld, L * t).add(new THREE.Vector3(0, -0.18 * L * t * t, 0)));
      }
      const lside = new THREE.Vector3().crossVectors(ld, up).normalize();
      mb.strip(pts, [0.014, 0.05, 0.035, 0.005].map((w) => w * scale), lside, col, 0.3);
    }
  }
}

// Bunch grass: wood-oats in the forest edge, sea oats (with seed heads) on dunes.
function grassTuft(mb, at, r, scale, oats) {
  const blades = Math.round(r.range(14, 26));
  const col = oats
    ? new THREE.Color().setHSL(r.range(0.12, 0.16), 0.35, r.range(0.42, 0.52))
    : new THREE.Color().setHSL(r.range(0.2, 0.26), 0.45, r.range(0.28, 0.36));
  for (let b = 0; b < blades; b++) {
    const az = r() * Math.PI * 2;
    const lean = r.range(0.1, 0.7);
    const L = r.range(0.4, 0.9) * scale * (oats ? 1.4 : 1);
    const dir = new THREE.Vector3(Math.sin(lean) * Math.cos(az), Math.cos(lean), Math.sin(lean) * Math.sin(az));
    const pts = [];
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      pts.push(at.clone().addScaledVector(dir, L * t).add(new THREE.Vector3(dir.x * L * t * t * 0.4, -L * t * t * 0.25, dir.z * L * t * t * 0.4)));
    }
    const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
    mb.strip(pts, [0.012, 0.011, 0.009, 0.006, 0.001].map((w) => w * scale), side, col, 0.1);
  }
  if (oats) {
    // Tall arching stalks with drooping seed panicles.
    const stalks = Math.round(r.range(2, 5));
    for (let k = 0; k < stalks; k++) {
      const az = r() * Math.PI * 2;
      const H = r.range(1.1, 1.6) * scale;
      const top = at.clone().add(new THREE.Vector3(Math.cos(az) * 0.25, H, Math.sin(az) * 0.25));
      const side = new THREE.Vector3(-Math.sin(az), 0, Math.cos(az));
      const stalkCol = new THREE.Color(0.66, 0.58, 0.38);
      mb.strip([at, at.clone().lerp(top, 0.5), top], [0.008, 0.006, 0.004], side, stalkCol, 0.2);
      const seeds = new THREE.Color(0.72, 0.62, 0.4);
      for (let s = 0; s < 7; s++) {
        const p0 = top.clone().add(new THREE.Vector3(r.range(-0.03, 0.03), -s * 0.05, r.range(-0.03, 0.03)));
        const p1 = p0.clone().add(new THREE.Vector3(Math.cos(az + s) * 0.07, -0.08, Math.sin(az + s) * 0.07));
        mb.strip([p0, p1], [0.022, 0.012], side, seeds, 0.9);
      }
    }
  }
}

// Yaupon / wax myrtle: a rounded shrub of small evergreen leaf sprigs.
function shrubLeaves(out, at, r, scale) {
  const n = Math.round(r.range(140, 260) * scale);
  const H = r.range(1.2, 2.6) * scale;
  const R = r.range(0.8, 1.6) * scale;
  for (let i = 0; i < n; i++) {
    const u = r();
    const v = r() * Math.PI * 2;
    const rad = Math.sqrt(u) * R;
    const y = H * (0.25 + 0.75 * Math.sqrt(1 - u)) * r.range(0.6, 1);
    const pos = at.clone().add(new THREE.Vector3(Math.cos(v) * rad, y, Math.sin(v) * rad));
    const out_ = new THREE.Vector3(Math.cos(v), r.range(-0.2, 0.6), Math.sin(v)).normalize();
    const nrm = new THREE.Vector3(r.range(-0.4, 0.4), 1, r.range(-0.4, 0.4));
    nrm.addScaledVector(out_, -nrm.dot(out_)).normalize();
    out.push({ pos, fwd: out_, nrm, size: r.range(0.035, 0.055), atlas: Math.floor(r() * 6), burn: 0, vary: r() });
  }
}

export function generateUnderstory(p, crownRadius) {
  const mix = MIX[p.ground] || MIX.hammock;
  const r = rng(p.seed * 7 + 3);
  const mb = new MeshBuilder();
  const shrubs = [];
  const density = p.understory;
  const { from } = windVectors(p);
  const pond = p.pond ? pondGeometry(p) : null;
  if (density <= 0) return { geometry: mb.geometry(), shrubLeaves: shrubs, mesh: mb };
  const Rmax = 38;
  const tries = Math.round(170 * density);
  for (let i = 0; i < tries; i++) {
    // Uniform over a disc, but keep the trunk area clear.
    const rad = Math.sqrt(r.range(0.01, 1)) * Rmax;
    if (rad < 2.2) continue;
    const a = r() * Math.PI * 2;
    const at = new THREE.Vector3(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    if (pond && pond.contains(at.x, at.z, 1.5)) continue;
    const under = rad < crownRadius * 0.95;
    const seaward = Math.max(0, (at.x * from.x + at.z * from.z) / rad);
    const pick = r();
    // Saw palmetto loves the canopy edge; grasses the open, sunny ground;
    // sea oats the seaward dune side.
    const wPal = mix.palmetto * (under ? 0.8 : 1.2);
    const wShrub = mix.shrub * (under ? 0.5 : 1);
    const wGrass = mix.grass * (under ? 0.3 : 1.3);
    const wOats = mix.oats * (under ? 0.05 : 0.4 + 1.6 * seaward);
    const total = wPal + wShrub + wGrass + wOats;
    let x = pick * total;
    const scale = r.range(0.75, 1.25);
    if ((x -= wPal) < 0) {
      // Saw palmetto spreads by creeping stems into colonies.
      const n = Math.round(r.range(3, 8));
      for (let k = 0; k < n; k++) {
        const off = new THREE.Vector3(r.range(-1.6, 1.6), 0, r.range(-1.6, 1.6));
        sawPalmetto(mb, at.clone().add(off), r, scale * r.range(0.8, 1.15));
      }
    }
    else if ((x -= wShrub) < 0) shrubLeaves(shrubs, at, r, scale);
    else if ((x -= wGrass) < 0) grassTuft(mb, at, r, scale, false);
    else grassTuft(mb, at, r, scale, true);
  }
  return { geometry: mb.geometry(), shrubLeaves: shrubs, mesh: mb };
}

// Compact JSON for Blender: flat arrays in three.js coordinates.
export function understoryToJSON(u) {
  const round = (a, d) => Array.from(a, (v) => +v.toFixed(d));
  return {
    positions: round(u.mesh.pos, 3),
    colors: round(u.mesh.col, 3),
    indices: u.mesh.idx,
    leaves: u.shrubLeaves.map((l) => [l.pos.x, l.pos.y, l.pos.z, l.fwd.x, l.fwd.y, l.fwd.z, l.nrm.x, l.nrm.y, l.nrm.z, l.size, l.atlas, 0, l.vary].map((v) => +(+v).toFixed(4))),
  };
}
