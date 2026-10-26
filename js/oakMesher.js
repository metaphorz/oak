// Turns an oak skeleton into three.js geometry.
//  * bark: one merged BufferGeometry of tubes (parallel-transport frames, so
//    limbs never twist), with the trunk base flared and buttressed;
//  * leaves: one InstancedMesh of folded leaf blades sampling a photo atlas;
//  * Spanish moss: crossed, tapering ribbons along each hanging strand.

import * as THREE from 'three';
import { flareScale } from './oakGenerator.js?v=20261026171855';

// Leaf rectangles in the ambientCG LeafSet022 atlas, in UV space (v up).
// Measured from the opacity mask (2048px): x0, x1, yTop, yBottom in pixels.
const ATLAS_PX = [
  [140, 582, 61, 933], [834, 1208, 78, 950], [1466, 1855, 113, 927],
  [140, 582, 1094, 1975], [834, 1208, 1104, 1972], [1466, 1855, 1073, 1948],
];
export const LEAF_RECTS = ATLAS_PX.map(([x0, x1, y0, y1]) => {
  const pad = 6;
  const u0 = (x0 - pad) / 2048, u1 = (x1 + pad) / 2048;
  const v0 = 1 - (y1 + pad) / 2048, v1 = 1 - (y0 - pad) / 2048;
  return new THREE.Vector4(u0, v0, u1 - u0, v1 - v0);
});
export const LEAF_ASPECT = 0.47; // width / length of the photographed leaves

const RADIAL = {
  draft: [12, 8, 6, 4, 3, 3],
  high: [28, 16, 10, 6, 4, 3],
  ultra: [40, 24, 14, 8, 5, 4],
};

function catmull(points, radii, factor) {
  if (factor <= 1 || points.length < 3) return { points, radii };
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const n = (points.length - 1) * factor;
  const outP = curve.getPoints(n);
  const outR = [];
  for (let i = 0; i <= n; i++) {
    const f = (i / n) * (radii.length - 1);
    const i0 = Math.min(radii.length - 2, Math.floor(f));
    const a = f - i0;
    outR.push(radii[i0] * (1 - a) + radii[i0 + 1] * a);
  }
  return { points: outP, radii: outR };
}

export function buildBarkGeometry(sk, quality = 'high') {
  const p = sk.params;
  const radial = RADIAL[quality] || RADIAL.high;
  const texScale = p.barkScale;
  const pos = [];
  const nor = [];
  const uv = [];
  const mossOk = [];
  const idx = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const all = [...sk.branches, ...sk.roots];
  for (const br of all) {
    const smoothF = br.root ? 2 : br.level <= 2 ? 3 : br.level === 3 ? 2 : 1;
    const { points, radii } = catmull(br.points, br.radii, quality === 'draft' ? 1 : smoothF);
    if (points.length < 2) continue;
    const seg = br.root ? Math.max(6, radial[1]) : radial[Math.min(br.level, radial.length - 1)];
    const isTrunk = br.level === 0 && !br.root;
    const base = pos.length / 3;
    const uRepeat = Math.max(1, Math.round((2 * Math.PI * radii[0]) / texScale));
    let vAcc = 0;

    // Initial frame.
    T.subVectors(points[1], points[0]).normalize();
    N.copy(Math.abs(T.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
    N.addScaledVector(T, -N.dot(T)).normalize();
    B.crossVectors(T, N);

    for (let i = 0; i < points.length; i++) {
      if (i > 0) {
        vAcc += points[i].distanceTo(points[i - 1]);
        const nextT = new THREE.Vector3().subVectors(points[Math.min(i + 1, points.length - 1)], points[i - 1]).normalize();
        // Parallel transport: rotate N by the rotation taking T to nextT.
        const q = new THREE.Quaternion().setFromUnitVectors(T, nextT);
        N.applyQuaternion(q);
        T.copy(nextT);
        N.addScaledVector(T, -N.dot(T)).normalize();
        B.crossVectors(T, N);
      }
      const c = points[i];
      const r = radii[i];
      for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        tmp.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
        let rr = r;
        if (isTrunk && c.y < 3) {
          rr *= flareScale(p, c.y, Math.atan2(tmp.z, tmp.x), sk.trunkRadius, sk.ageFactor);
        }
        pos.push(c.x + tmp.x * rr, c.y + tmp.y * rr, c.z + tmp.z * rr);
        nor.push(tmp.x, tmp.y, tmp.z);
        uv.push((j / seg) * uRepeat, vAcc / texScale);
        mossOk.push(br.root ? 0 : 1); // moss grows on limbs, never on roots
      }
    }
    const rows = points.length;
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < seg; j++) {
        const a = base + i * (seg + 1) + j;
        const b = a + seg + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1); // outward-facing
      }
    }
    // Rounded tip so no branch ends in an open, sawn-off tube. A branch that
    // continues into a leader (the trunk) needs none: the leader carries on.
    if (br.continued) continue;
    const last = points[rows - 1];
    const rEnd = radii[rows - 1];
    const tip = pos.length / 3;
    pos.push(last.x + T.x * rEnd * 0.9, last.y + T.y * rEnd * 0.9, last.z + T.z * rEnd * 0.9);
    nor.push(T.x, T.y, T.z);
    uv.push(uRepeat * 0.5, (vAcc + rEnd) / texScale);
    mossOk.push(br.root ? 0 : 1);
    const ring = base + (rows - 1) * (seg + 1);
    for (let j = 0; j < seg; j++) idx.push(ring + j, ring + j + 1, tip);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aMossOk', new THREE.Float32BufferAttribute(mossOk, 1));
  g.setIndex(idx);
  // Flare changed the trunk surface, so recompute normals for correct shading.
  g.computeVertexNormals();
  return g;
}

// One blade: 3 x 4 grid, V-folded along the midrib and arched. Local frame:
// +Y petiole -> tip, +Z blade normal; unit length, LEAF_ASPECT wide.
function bladeGrid() {
  const cols = [-0.5, 0, 0.5];
  const rows = [0, 0.33, 0.66, 1];
  const pos = [];
  const uv = [];
  for (const y of rows) {
    for (const x of cols) {
      const fold = -0.12 * Math.abs(x) * LEAF_ASPECT;
      const arch = 0.1 * y * y - 0.04 * y;
      pos.push([x * LEAF_ASPECT, y, fold - arch]);
      uv.push([x + 0.5, y]);
    }
  }
  const idx = [];
  for (let r = 0; r < rows.length - 1; r++) {
    for (let c = 0; c < cols.length - 1; c++) {
      const a = r * cols.length + c;
      const b = a + cols.length;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return { pos, uv, idx };
}

// A live oak shoot carries leaves alternately along a short twig, so each
// instance is a sprig of blades. Each entry: offset along the stem (leaf
// lengths), yaw from the stem axis, roll around the stem, scale.
// Shared with blender/build_oak.py through the skeleton JSON.
export const SPRIG = [
  { at: 0.0, yaw: 52, roll: 18, scale: 0.85 },
  { at: 0.22, yaw: -48, roll: -15, scale: 0.92 },
  { at: 0.42, yaw: 44, roll: 12, scale: 1.0 },
  { at: 0.6, yaw: -38, roll: -10, scale: 1.0 },
  { at: 0.76, yaw: 6, roll: 0, scale: 1.05 },
];

export function leafSprigGeometry(blades = SPRIG) {
  const grid = bladeGrid();
  const pos = [];
  const uv = [];
  const bladeIdx = [];
  const idx = [];
  const v = new THREE.Vector3();
  blades.forEach((b, k) => {
    const m = new THREE.Matrix4()
      .makeTranslation(0, b.at, 0)
      .multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(b.yaw)))
      .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(b.roll)))
      .multiply(new THREE.Matrix4().makeScale(b.scale, b.scale, b.scale));
    const base = pos.length / 3;
    grid.pos.forEach((p, i) => {
      v.set(p[0], p[1], p[2]).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      uv.push(grid.uv[i][0], grid.uv[i][1]);
      bladeIdx.push(k);
    });
    for (const i of grid.idx) idx.push(base + i);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(bladeIdx, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildLeafMesh(sk, material, depthMaterial) {
  const n = sk.leaves.length;
  const geo = leafSprigGeometry();
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, n));
  mesh.count = n;
  const data = new Float32Array(Math.max(1, n) * 3);
  const m = new THREE.Matrix4();
  const X = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const l = sk.leaves[i];
    X.crossVectors(l.fwd, l.nrm).normalize();
    const Y = l.fwd;
    const Z = l.nrm;
    const s = l.size;
    m.set(
      X.x * s, Y.x * s, Z.x * s, l.pos.x,
      X.y * s, Y.y * s, Z.y * s, l.pos.y,
      X.z * s, Y.z * s, Z.z * s, l.pos.z,
      0, 0, 0, 1,
    );
    mesh.setMatrixAt(i, m);
    data[i * 3] = l.atlas;
    data[i * 3 + 1] = l.burn;
    data[i * 3 + 2] = l.vary;
  }
  geo.setAttribute('aLeaf', new THREE.InstancedBufferAttribute(data, 3));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
  mesh.frustumCulled = false;
  return mesh;
}

// Each strand becomes two perpendicular ribbons, wider at the top.
export function buildMossGeometry(sk) {
  const pos = [];
  const uv = [];
  const sway = [];
  const idx = [];
  const side = new THREE.Vector3();
  for (const m of sk.moss) {
    const pts = m.points;
    const col = Math.floor(m.seed * 4); // one of 4 strand patterns in the texture
    for (let rib = 0; rib < 2; rib++) {
      const ang = m.seed * 6.283 + rib * Math.PI / 2;
      side.set(Math.cos(ang), 0, Math.sin(ang));
      const base = pos.length / 3;
      let acc = 0;
      const total = pts.reduce((s, q, i) => (i ? s + q.distanceTo(pts[i - 1]) : 0), 0);
      for (let i = 0; i < pts.length; i++) {
        if (i) acc += pts[i].distanceTo(pts[i - 1]);
        const t = acc / total;
        const w = m.width * (1 - 0.55 * t) * 0.5;
        const q = pts[i];
        pos.push(q.x - side.x * w, q.y, q.z - side.z * w, q.x + side.x * w, q.y, q.z + side.z * w);
        uv.push(col * 0.25, 1 - t, col * 0.25 + 0.25, 1 - t);
        sway.push(t, t);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
