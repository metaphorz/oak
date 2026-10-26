# Live Oak Explorer — Blender builder.
#
# Rebuilds the live oak from the skeleton grown in the browser (same branches,
# leaves and moss strands), at higher fidelity:
#   * denser, smoother bark tubes with 4K photoscanned PBR bark and limb moss;
#   * leaf sprigs instanced with Geometry Nodes (identical sprig layout and atlas);
#   * Spanish moss as real hair curves (many fine curly fibres per strand);
#   * HDRI sky + sun, sand or forest-litter ground, optional ocean;
#   * camera matching the browser view; Cycles or EEVEE render.
# Then exports oak.glb / oak.fbx (for Unreal) and saves oak.blend.
#
# Usage (normally run by server.js):
#   blender -b --factory-startup -P blender/build_oak.py -- <jobdir>
#   blender -P blender/build_oak.py -- <jobdir> --gui
#
# Coordinates: the skeleton is in three.js space (Y up, north = -Z); Blender is
# Z up, so (x, y, z)_three -> (x, -z, y)_blender (a pure rotation).

import bpy
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
JOB_DIR = os.path.abspath(argv[0])
GUI = "--gui" in argv
JOB = json.load(open(os.path.join(JOB_DIR, "job.json")))
SK = JOB["skeleton"]
P = SK["params"]
ASSETS = JOB["assets"]
MODE = "gui" if GUI else JOB.get("mode", "render")
RENDER = JOB.get("render", {})
LEAF = JOB["leaf"]
T0 = time.time()


def log(msg):
    print(f"OAK: {msg}  [{time.time() - T0:.1f}s]", flush=True)


def to_b(a):
    a = np.asarray(a, dtype=np.float64).reshape(-1, 3)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)


C3B = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))  # three -> blender rotation

# ------------------------------------------------------------------ scene ---


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for blocks in (bpy.data.meshes, bpy.data.materials, bpy.data.node_groups, bpy.data.lights,
                   bpy.data.cameras, bpy.data.hair_curves, bpy.data.curves):
        for d in list(blocks):
            if d.users == 0:
                blocks.remove(d)


def new_object(name, data, coll=None):
    ob = bpy.data.objects.new(name, data)
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def mesh_from_arrays(name, verts, faces_flat, face_sizes, uvs=None):
    """verts (V,3), faces_flat: concatenated vertex indices, face_sizes: per face count."""
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", np.ascontiguousarray(verts, dtype=np.float32).ravel())
    me.loops.add(len(faces_flat))
    me.loops.foreach_set("vertex_index", np.ascontiguousarray(faces_flat, dtype=np.int32))
    me.polygons.add(len(face_sizes))
    starts = np.zeros(len(face_sizes), dtype=np.int32)
    starts[1:] = np.cumsum(face_sizes)[:-1]
    me.polygons.foreach_set("loop_start", starts)
    if uvs is not None:
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", np.ascontiguousarray(uvs[faces_flat], dtype=np.float32).ravel())
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    try:
        me.shade_smooth()
    except AttributeError:
        me.polygons.foreach_set("use_smooth", np.ones(len(face_sizes), dtype=bool))
    return me


# ------------------------------------------------------------------- bark ---

RADIAL = [48, 28, 16, 10, 6, 4]
SUBDIV = [4, 4, 2, 1, 1, 1]


def flare_scale(y, alpha, trunk_r, age_f):
    """Mirror of flareScale() in js/oakGenerator.js — keep in sync."""
    h = 0.15 + 0.3 * trunk_r
    F = (0.1 + 0.55 * P["rootFlare"]) * math.exp(-max(0.0, y) / h) * age_f
    wd = math.radians(P["windDir"])
    axis = math.atan2(-math.cos(wd), math.sin(wd))
    c = np.cos(alpha - axis)
    w = P["buttress"] * P["windStrength"]
    return 1 + F * (0.55 + 1.6 * w * c * c) + F * 0.12 * np.sin(alpha * 7.0)


def catmull_rom(pts, radii, factor):
    pts = np.asarray(pts, dtype=np.float64)
    radii = np.asarray(radii, dtype=np.float64)
    if factor <= 1 or len(pts) < 3:
        return pts, radii
    ext = np.vstack([2 * pts[0] - pts[1], pts, 2 * pts[-1] - pts[-2]])
    out = [pts[0]]
    for i in range(len(pts) - 1):
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        for k in range(1, factor + 1):
            t = k / factor
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out = np.array(out)
    f = np.linspace(0, len(radii) - 1, len(out))
    return out, np.interp(f, np.arange(len(radii)), radii)


def rotate_toward(v, a, b):
    """Rotate v by the rotation taking unit a to unit b (parallel transport)."""
    axis = np.cross(a, b)
    s = np.linalg.norm(axis)
    c = float(np.dot(a, b))
    if s < 1e-9:
        return v
    axis /= s
    ang = math.atan2(s, c)
    return v * math.cos(ang) + np.cross(axis, v) * math.sin(ang) + axis * np.dot(axis, v) * (1 - math.cos(ang))


def build_bark():
    tex_scale = P["barkScale"]
    V, UV, F, FS = [], [], [], []
    nv = 0
    for br in SK["branches"] + SK["roots"]:
        lvl = min(br["level"], 5)
        is_root = br["root"]
        is_trunk = lvl == 0 and not is_root
        pts, radii = catmull_rom(br["points"], br["radii"], 3 if is_root else SUBDIV[lvl])
        n = len(pts)
        if n < 2:
            continue
        seg = 20 if is_root else RADIAL[lvl]
        u_rep = max(1, round(2 * math.pi * radii[0] / tex_scale))
        ang = np.linspace(0, 2 * math.pi, seg + 1)
        ca, sa = np.cos(ang)[:, None], np.sin(ang)[:, None]
        T = pts[1] - pts[0]
        T /= np.linalg.norm(T) + 1e-12
        N = np.array([0.0, 1.0, 0.0]) if abs(T[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
        N = N - T * np.dot(N, T)
        N /= np.linalg.norm(N)
        v_acc = 0.0
        rings = np.empty((n, seg + 1, 3))
        ring_uv = np.empty((n, seg + 1, 2))
        for i in range(n):
            if i > 0:
                v_acc += float(np.linalg.norm(pts[i] - pts[i - 1]))
                nT = pts[min(i + 1, n - 1)] - pts[i - 1]
                nT /= np.linalg.norm(nT) + 1e-12
                N = rotate_toward(N, T, nT)
                T = nT
                N = N - T * np.dot(N, T)
                N /= np.linalg.norm(N) + 1e-12
            B = np.cross(T, N)
            offs = ca * N + sa * B
            r = np.full(seg + 1, radii[i])
            if is_trunk and pts[i][1] < 3:
                r = r * flare_scale(pts[i][1], np.arctan2(offs[:, 2], offs[:, 0]), SK["trunkRadius"], SK["ageFactor"])
            rings[i] = pts[i] + offs * r[:, None]
            ring_uv[i, :, 0] = np.linspace(0, 1, seg + 1) * u_rep
            ring_uv[i, :, 1] = v_acc / tex_scale
        V.append(rings.reshape(-1, 3))
        UV.append(ring_uv.reshape(-1, 2))
        i_idx = np.arange(n - 1)[:, None]
        j_idx = np.arange(seg)[None, :]
        a = nv + i_idx * (seg + 1) + j_idx
        b = a + seg + 1
        quads = np.stack([a, a + 1, b + 1, b], axis=-1).reshape(-1, 4)
        F.append(quads.ravel())
        FS.append(np.full(len(quads), 4))
        # Rounded tip (matches the three.js cap).
        tip = nv + n * (seg + 1)
        V.append((pts[-1] + T * radii[-1] * 0.9)[None, :])
        UV.append(np.array([[u_rep * 0.5, (v_acc + radii[-1]) / tex_scale]]))
        ring = nv + (n - 1) * (seg + 1)
        tris = np.stack([ring + np.arange(seg), ring + np.arange(seg) + 1, np.full(seg, tip)], axis=-1)
        F.append(tris.ravel())
        FS.append(np.full(seg, 3))
        nv = tip + 1
    verts = to_b(np.vstack(V))
    me = mesh_from_arrays("OakBark", verts, np.concatenate(F), np.concatenate(FS), np.vstack(UV))
    ob = new_object("OakBark", me)
    log(f"bark: {len(me.polygons):,} faces")
    return ob


# ----------------------------------------------------------------- leaves ---


def blade_grid():
    asp = LEAF["aspect"]
    cols, rows = [-0.5, 0, 0.5], [0, 0.33, 0.66, 1]
    pos, uv = [], []
    for y in rows:
        for x in cols:
            fold = -0.12 * abs(x) * asp
            arch = 0.1 * y * y - 0.04 * y
            pos.append((x * asp, y, fold - arch))
            uv.append((x + 0.5, y))
    quads = []
    for r in range(3):
        for c in range(2):
            a = r * 3 + c
            b = a + 3
            quads.append((a, a + 1, b + 1, b))
    return np.array(pos), np.array(uv), np.array(quads)


def sprig_arrays(atlas):
    """One sprig (5 blades) in leaf-local space with atlas UVs. Mirrors leafSprigGeometry()."""
    gp, guv, gq = blade_grid()
    V, UV, F = [], [], []
    for k, b in enumerate(LEAF["sprig"]):
        m = (Matrix.Translation((0, b["at"], 0))
             @ Matrix.Rotation(math.radians(b["yaw"]), 4, "Z")
             @ Matrix.Rotation(math.radians(b["roll"]), 4, "Y")
             @ Matrix.Scale(b["scale"], 4))
        rect = LEAF["rects"][(atlas + k) % 6]
        base = len(V) and sum(len(v) for v in V)
        V.append(np.array([tuple(m @ Vector(p)) for p in gp]))
        UV.append(np.stack([rect[0] + guv[:, 0] * rect[2], rect[1] + guv[:, 1] * rect[3]], axis=1))
        F.append(gq + base)
    return np.vstack(V), np.vstack(UV), np.vstack(F)


UNDER = JOB.get("understory") or {}


def leaf_frames(leaves=None):
    L = np.asarray(SK["leaves"] if leaves is None else leaves, dtype=np.float64).reshape(-1, 13)
    pos, fwd, nrm = L[:, 0:3], L[:, 3:6], L[:, 6:9]
    side = np.cross(fwd, nrm)
    side /= np.linalg.norm(side, axis=1, keepdims=True) + 1e-12
    return L, pos, side, fwd, nrm


def build_leaves_instanced(coll_hidden, leaves=None, name="OakLeaves"):
    """Render version: Geometry Nodes instancing of 6 sprig variants (one per atlas start)."""
    L, pos, side, fwd, nrm = leaf_frames(leaves)
    if len(L) == 0:
        return None
    if not coll_hidden.objects:
        for a in range(6):
            v, uv, f = sprig_arrays(a)
            me = mesh_from_arrays(f"Sprig_{a}", v, f.ravel(), np.full(len(f), 4), uv)
            new_object(f"Sprig_{a}", me, coll_hidden)

    # Point cloud carrying per-leaf transform and colour data.
    me = bpy.data.meshes.new(name + "Points")
    me.vertices.add(len(L))
    me.vertices.foreach_set("co", to_b(pos).astype(np.float32).ravel())
    eul = np.empty((len(L), 3), dtype=np.float32)
    for i in range(len(L)):
        m = C3B @ Matrix((side[i], fwd[i], nrm[i])).transposed()
        eul[i] = m.to_euler("XYZ")
    for aname, kind, data in (("rot", "FLOAT_VECTOR", eul.ravel()), ("scl", "FLOAT", L[:, 9]),
                             ("atlas", "INT", L[:, 10].astype(np.int32)), ("burn", "FLOAT", L[:, 11]),
                             ("vary", "FLOAT", L[:, 12])):
        at = me.attributes.new(aname, kind, "POINT")
        at.data.foreach_set("vector" if kind == "FLOAT_VECTOR" else "value", np.ascontiguousarray(data))
    ob = new_object(name, me)
    ng = bpy.data.node_groups.get("LeafScatter")
    if ng:
        ob.modifiers.new("LeafScatter", "NODES").node_group = ng
        log(f"{name}: {len(L):,} sprigs instanced")
        return ob

    ng = bpy.data.node_groups.new("LeafScatter", "GeometryNodeTree")
    ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    nd, ln = ng.nodes, ng.links
    gi = nd.new("NodeGroupInput")
    go = nd.new("NodeGroupOutput")
    inst = nd.new("GeometryNodeInstanceOnPoints")
    coll = nd.new("GeometryNodeCollectionInfo")
    coll.inputs["Collection"].default_value = coll_hidden
    coll.inputs["Separate Children"].default_value = True
    coll.inputs["Reset Children"].default_value = True

    def attr(name, dtype):
        n = nd.new("GeometryNodeInputNamedAttribute")
        n.data_type = dtype
        n.inputs["Name"].default_value = name
        return n.outputs["Attribute"]

    e2r = nd.new("FunctionNodeEulerToRotation")
    ln.new(attr("rot", "FLOAT_VECTOR"), e2r.inputs["Euler"])
    ln.new(gi.outputs[0], inst.inputs["Points"])
    ln.new(coll.outputs["Instances"], inst.inputs["Instance"])
    inst.inputs["Pick Instance"].default_value = True
    ln.new(attr("atlas", "INT"), inst.inputs["Instance Index"])
    ln.new(e2r.outputs["Rotation"], inst.inputs["Rotation"])
    ln.new(attr("scl", "FLOAT"), inst.inputs["Scale"])
    ln.new(inst.outputs["Instances"], go.inputs[0])
    mod = ob.modifiers.new("LeafScatter", "NODES")
    mod.node_group = ng
    log(f"{name}: {len(L):,} sprigs ({len(L) * 5:,} leaves) instanced")
    return ob


def build_leaves_realized(max_sprigs=40000):
    """Export version: real geometry, capped; burn/vary in a colour attribute for Unreal.
    Includes the understory shrubs (yaupon / wax myrtle) which share the leaf material."""
    L, pos, side, fwd, nrm = leaf_frames(list(SK["leaves"]) + list(UNDER.get("leaves", [])))
    if len(L) == 0:
        return None
    keep = np.arange(len(L))
    grow = 1.0
    if len(L) > max_sprigs:
        rng = np.random.default_rng(7)
        keep = np.sort(rng.choice(len(L), max_sprigs, replace=False))
        grow = min(1.8, math.sqrt(len(L) / max_sprigs))
    variants = [sprig_arrays(a) for a in range(6)]
    nvs = len(variants[0][0])
    V = np.empty((len(keep) * nvs, 3))
    UV = np.empty((len(keep) * nvs, 2))
    COL = np.empty((len(keep) * nvs, 4), dtype=np.float32)
    Fs = []
    for k, i in enumerate(keep):
        v, uv, f = variants[int(L[i, 10]) % 6]
        M = np.stack([side[i], fwd[i], nrm[i]], axis=1) * (L[i, 9] * grow)
        V[k * nvs:(k + 1) * nvs] = v @ M.T + pos[i]
        UV[k * nvs:(k + 1) * nvs] = uv
        COL[k * nvs:(k + 1) * nvs] = (L[i, 11], L[i, 12], 0, 1)
        Fs.append(f + k * nvs)
    F = np.vstack(Fs)
    me = mesh_from_arrays("OakLeavesExport", to_b(V), F.ravel(), np.full(len(F), 4), UV)
    ca = me.color_attributes.new("leafdata", "FLOAT_COLOR", "POINT")
    ca.data.foreach_set("color", COL.ravel())
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.find("leafdata")
    return new_object("OakLeavesExport", me)


# ----------------------------------------------------------- Spanish moss ---


def build_moss_hair():
    """Each strand from the browser becomes a bundle of fine, curly fibres."""
    strands = SK["moss"]
    if not strands:
        return None
    rng = np.random.default_rng(int(P["seed"]))
    FIBRES = 70
    curves_pts, sizes, radii = [], [], []
    for s in strands:
        pts, _ = catmull_rom(s["points"], np.zeros(len(s["points"])), 3)
        n = len(pts)
        t = np.linspace(0, 1, n)[:, None]
        for _ in range(FIBRES):
            spread = s["width"] * 0.5
            off = np.array([rng.uniform(-1, 1), 0, rng.uniform(-1, 1)]) * spread
            ph = rng.uniform(0, 6.28)
            freq = rng.uniform(18, 30)
            curl = np.stack([np.sin(t[:, 0] * freq + ph), np.zeros(n), np.cos(t[:, 0] * freq + ph)], axis=1) * 0.012
            length = rng.uniform(0.45, 1.0)
            m = max(3, int(n * length))
            p = pts[:m] + off * (1 - 0.5 * t[:m]) + curl[:m]
            curves_pts.append(p)
            sizes.append(m)
            radii.append(np.linspace(0.0022, 0.0008, m))
    hc = bpy.data.hair_curves.new("SpanishMoss")
    hc.add_curves(sizes)
    hc.position_data.foreach_set("vector", to_b(np.vstack(curves_pts)).astype(np.float32).ravel())
    r = hc.attributes.get("radius") or hc.attributes.new("radius", "FLOAT", "POINT")
    r.data.foreach_set("value", np.concatenate(radii).astype(np.float32))
    ob = new_object("SpanishMoss", hc)
    log(f"Spanish moss: {len(sizes):,} hair fibres from {len(strands)} strands")
    return ob


def build_moss_ribbons():
    """Export version: crossed alpha ribbons, as in three.js."""
    V, UV, F = [], [], []
    nv = 0
    for s in SK["moss"]:
        pts = np.asarray(s["points"])
        col = int(s["seed"] * 4)
        seglen = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        acc = np.concatenate([[0], np.cumsum(seglen)])
        t = acc / max(acc[-1], 1e-6)
        for rib in range(2):
            ang = s["seed"] * 6.283 + rib * math.pi / 2
            side = np.array([math.cos(ang), 0, math.sin(ang)])
            w = (s["width"] * (1 - 0.55 * t) * 0.5)[:, None]
            left, right = pts - side * w, pts + side * w
            vv = np.empty((len(pts) * 2, 3))
            vv[0::2], vv[1::2] = left, right
            uu = np.empty((len(pts) * 2, 2))
            uu[0::2, 0], uu[1::2, 0] = col * 0.25, col * 0.25 + 0.25
            uu[0::2, 1] = uu[1::2, 1] = 1 - t
            V.append(vv)
            UV.append(uu)
            for i in range(len(pts) - 1):
                a = nv + i * 2
                F.append((a, a + 1, a + 3, a + 2))
            nv += len(vv)
    if not V:
        return None
    F = np.array(F)
    me = mesh_from_arrays("SpanishMossExport", to_b(np.vstack(V)), F.ravel(), np.full(len(F), 4), np.vstack(UV))
    return new_object("SpanishMossExport", me)


# -------------------------------------------------------------- understory ---


def build_understory():
    """Saw palmetto and grasses, built in the browser (js/understory.js)."""
    if not UNDER.get("positions"):
        return None
    pos = to_b(UNDER["positions"])
    col = np.asarray(UNDER["colors"], dtype=np.float32).reshape(-1, 3)
    idx = np.asarray(UNDER["indices"], dtype=np.int32)
    me = mesh_from_arrays("Understory", pos, idx, np.full(len(idx) // 3, 3))
    ca = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    ca.data.foreach_set("color", np.hstack([col, np.ones((len(col), 1), np.float32)]).ravel())
    # The FBX exporter writes only the active colour attribute.
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = me.color_attributes.find("Col")
    ob = new_object("Understory", me)
    log(f"understory: {len(me.polygons):,} faces")
    return ob


def understory_material():
    m = bpy.data.materials.new("Understory")
    nt = m.node_tree
    b = principled(nt)
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    nt.links.new(ca.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.85
    b.inputs["Subsurface Weight"].default_value = 0.1
    return m


# -------------------------------------------------------------- materials ---


def img(path, non_color=False):
    im = bpy.data.images.load(path, check_existing=True)
    if non_color:
        im.colorspace_settings.name = "Non-Color"
    return im


def node_tex(nt, path, non_color=False, x=-900, y=0):
    n = nt.nodes.new("ShaderNodeTexImage")
    n.image = img(path, non_color)
    n.location = (x, y)
    return n


def principled(nt):
    return next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")


def output(nt):
    return next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")


def math_node(nt, op, a=None, b=None, x=0, y=0):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.location = (x, y)
    if a is not None:
        if isinstance(a, (int, float)):
            n.inputs[0].default_value = a
        else:
            nt.links.new(a, n.inputs[0])
    if b is not None:
        if isinstance(b, (int, float)):
            n.inputs[1].default_value = b
        else:
            nt.links.new(b, n.inputs[1])
    return n


def mix_rgb(nt, blend, fac, a, b, x=0, y=0):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = blend
    n.location = (x, y)
    for sock, val in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
        if isinstance(val, (int, float)):
            sock.default_value = val
        elif isinstance(val, tuple):
            sock.default_value = val
        else:
            nt.links.new(val, sock)
    return n


def bark_material(res):
    s = P["barkSet"]
    base = os.path.join(ASSETS, "textures", "bark", f"{s}_%s_{res}.jpg")
    m = bpy.data.materials.new("OakBark")
    nt = m.node_tree
    bsdf = principled(nt)
    diff = node_tex(nt, base % "diff", y=300)
    rough = node_tex(nt, base % "rough", True, y=0)
    nor = node_tex(nt, base % "nor_gl", True, y=-300)
    disp = node_tex(nt, base % "disp", True, y=-600)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.inputs["Strength"].default_value = 1.4
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    # Normal wired below, after the scar mask exists (scars flatten the relief).
    # Darkness
    dark = mix_rgb(nt, "MULTIPLY", 1.0, diff.outputs["Color"], (1 - 0.45 * P["barkDarkness"],) * 3 + (1,), -500, 300)
    # Limb moss on upward faces and in furrows (mirrors the three.js shader).
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(geo.outputs["Normal"], sep.inputs[0])
    furrow = math_node(nt, "SUBTRACT", 0.5, disp.outputs["Color"])
    up = math_node(nt, "MULTIPLY_ADD", furrow.outputs[0], 0.7)
    nt.links.new(sep.outputs["Z"], up.inputs[2])
    lm = P["limbMoss"]
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.interpolation_type = "SMOOTHSTEP"
    mr.inputs["From Min"].default_value = 0.8 - lm * 1.0
    mr.inputs["From Max"].default_value = 1.1 - lm * 0.7
    nt.links.new(up.outputs[0], mr.inputs["Value"])
    moss_amt = math_node(nt, "MULTIPLY", mr.outputs["Result"], min(1.0, lm * 1.15))
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.16, 0.22, 0.07, 1)
    ramp.color_ramp.elements[1].color = (0.32, 0.38, 0.13, 1)
    nt.links.new(disp.outputs["Color"], ramp.inputs["Fac"])
    col = mix_rgb(nt, "MIX", moss_amt.outputs[0], dark.outputs[2], ramp.outputs["Color"], -250, 300)
    # Scars and irregularity (mirrors js/materials.js): tone variation, lichen,
    # and occasional wounds of smooth grey wood with a dark callus rim.
    sc_amt = P.get("barkScars", 0.45)
    pos = geo.outputs["Position"]

    def noise(scale, offset=(0, 0, 0), stretch=(1, 1, 1)):
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Location"].default_value = offset
        mp.inputs["Scale"].default_value = tuple(scale * k for k in stretch)
        nt.links.new(pos, mp.inputs["Vector"])
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 1.0
        nz.inputs["Detail"].default_value = 2.0
        nt.links.new(mp.outputs["Vector"], nz.inputs["Vector"])
        return nz.outputs["Fac"]

    tone = math_node(nt, "MULTIPLY_ADD", math_node(nt, "SUBTRACT", noise(0.45), 0.5).outputs[0], 0.35 * sc_amt)
    tone.inputs[2].default_value = 1.0
    tone_rgb = nt.nodes.new("ShaderNodeCombineColor")
    for k in range(3):
        nt.links.new(tone.outputs[0], tone_rgb.inputs[k])
    toned = mix_rgb(nt, "MULTIPLY", 1.0, col.outputs[2], tone_rgb.outputs[0], -150, 300)
    lich = nt.nodes.new("ShaderNodeMapRange")
    lich.interpolation_type = "SMOOTHSTEP"
    lich.inputs["From Min"].default_value, lich.inputs["From Max"].default_value = 0.7 - 0.12 * P.get("lichen", 0.5), 0.8 - 0.12 * P.get("lichen", 0.5)
    lich.inputs["To Max"].default_value = 0.4 * P.get("lichen", 0.5) / 0.5 * 0.55
    nt.links.new(noise(3.2, (7.3, 7.3, 7.3)), lich.inputs["Value"])
    lichened = mix_rgb(nt, "MIX", lich.outputs["Result"], toned.outputs[2], (0.45, 0.48, 0.41, 1), -50, 300)
    thr = 0.8 - 0.1 * sc_amt
    sn = noise(2.5, (31, 31, 31), (1, 1, 0.12))  # narrow splits stretched along the (Z-up) height
    scar = nt.nodes.new("ShaderNodeMapRange")
    scar.inputs["From Min"].default_value, scar.inputs["From Max"].default_value = thr, thr + 0.02
    scar.inputs["To Max"].default_value = 1.0 if sc_amt > 0.01 else 0.0
    nt.links.new(sn, scar.inputs["Value"])
    rim = nt.nodes.new("ShaderNodeMapRange")
    rim.inputs["From Min"].default_value, rim.inputs["From Max"].default_value = thr - 0.05, thr
    rim.inputs["To Max"].default_value = 0.15 if sc_amt > 0.01 else 0.0
    nt.links.new(sn, rim.inputs["Value"])
    rim_only = math_node(nt, "SUBTRACT", rim.outputs["Result"], math_node(nt, "MULTIPLY", scar.outputs["Result"], 0.15).outputs[0])
    rim_dark = math_node(nt, "SUBTRACT", 1.0, rim_only.outputs[0])
    rim_rgb = nt.nodes.new("ShaderNodeCombineColor")
    for k in range(3):
        nt.links.new(rim_dark.outputs[0], rim_rgb.inputs[k])
    dark_wood = mix_rgb(nt, "MULTIPLY", 1.0, lichened.outputs[2], (0.72, 0.66, 0.6, 1), 0, 200)
    scarred = mix_rgb(nt, "MIX", math_node(nt, "MULTIPLY", scar.outputs["Result"], 0.75).outputs[0], lichened.outputs[2], dark_wood.outputs[2], 50, 300)
    final_bark = mix_rgb(nt, "MULTIPLY", 1.0, scarred.outputs[2], rim_rgb.outputs[0], 150, 300)
    nt.links.new(final_bark.outputs[2], bsdf.inputs["Base Color"])
    flat = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nor.outputs["Color"], flat.inputs["Color"])
    nstr = math_node(nt, "MULTIPLY_ADD", scar.outputs["Result"], -0.55)
    nstr.inputs[2].default_value = 1.4
    nt.links.new(nstr.outputs[0], flat.inputs["Strength"])
    nt.links.new(flat.outputs["Normal"], bsdf.inputs["Normal"])
    nt.nodes.remove(nm)
    rmix = math_node(nt, "MAXIMUM", rough.outputs["Color"], moss_amt.outputs[0])
    nt.links.new(rmix.outputs[0], bsdf.inputs["Roughness"])
    dn = nt.nodes.new("ShaderNodeDisplacement")
    dn.inputs["Scale"].default_value = 0.04
    dn.inputs["Midlevel"].default_value = 0.5
    nt.links.new(disp.outputs["Color"], dn.inputs["Height"])
    nt.links.new(dn.outputs["Displacement"], output(nt).inputs["Displacement"])
    try:
        m.displacement_method = "BUMP"
    except (AttributeError, TypeError):
        pass
    return m


def leaf_material(res):
    base = os.path.join(ASSETS, "textures", "leaves", f"leafset022_%s_{res}.jpg")
    m = bpy.data.materials.new("OakLeaf")
    nt = m.node_tree
    bsdf = principled(nt)
    out = output(nt)
    color = node_tex(nt, base % "color", y=400)
    opac = node_tex(nt, base % "opacity", True, y=100)
    rough = node_tex(nt, base % "roughness", True, y=-150)
    nor = node_tex(nt, base % "normalgl", True, y=-400)
    scat = node_tex(nt, base % "scattering", True, y=-650)
    d = P["leafDarkness"]
    # Same tint as three.js, plus a little extra darkening because Cycles has
    # no tone-mapped emissive translucency term brightening the canopy.
    tint = (0.8 * (1 - 0.85 * d), 0.8 * (1 - 0.68 * d), 0.8 * (1 - 0.9 * d), 1)
    c = mix_rgb(nt, "MULTIPLY", 1.0, color.outputs["Color"], tint, -500, 400)
    # Per-leaf data: instancer attributes (render) or colour attribute (export).
    burn_i = nt.nodes.new("ShaderNodeAttribute")
    burn_i.attribute_type = "INSTANCER"
    burn_i.attribute_name = "burn"
    vary_i = nt.nodes.new("ShaderNodeAttribute")
    vary_i.attribute_type = "INSTANCER"
    vary_i.attribute_name = "vary"
    geo_d = nt.nodes.new("ShaderNodeAttribute")
    geo_d.attribute_type = "GEOMETRY"
    geo_d.attribute_name = "leafdata"
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(geo_d.outputs["Color"], sep.inputs[0])
    burn = math_node(nt, "ADD", burn_i.outputs["Fac"], sep.outputs[0])
    vary = math_node(nt, "ADD", vary_i.outputs["Fac"], sep.outputs[1])
    v = math_node(nt, "MULTIPLY", math_node(nt, "SUBTRACT", vary.outputs[0], 0.5).outputs[0], P["leafVariation"] * 0.5)
    vgain = math_node(nt, "ADD", v.outputs[0], 1.0)
    gain_rgb = nt.nodes.new("ShaderNodeCombineColor")
    for k in range(3):
        nt.links.new(vgain.outputs[0], gain_rgb.inputs[k])
    c2b = mix_rgb(nt, "MULTIPLY", 1.0, c.outputs[2], gain_rgb.outputs[0], -250, 400)
    # Salt burn: desaturate toward tan.
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(c2b.outputs[2], bw.inputs[0])
    tan = nt.nodes.new("ShaderNodeCombineColor")
    for k, f in enumerate((1.9, 1.35, 0.7)):
        nt.links.new(math_node(nt, "MULTIPLY_ADD", bw.outputs[0], f, (0.06, 0.035, 0.0)[k]).outputs[0], tan.inputs[k])
    burnf = nt.nodes.new("ShaderNodeMapRange")
    burnf.interpolation_type = "SMOOTHSTEP"
    nt.links.new(burn.outputs[0], burnf.inputs["Value"])
    final = mix_rgb(nt, "MIX", burnf.outputs["Result"], c2b.outputs[2], tan.outputs[0], -50, 400)
    nt.links.new(final.outputs[2], bsdf.inputs["Base Color"])
    g = P["leafGloss"]
    r = math_node(nt, "MULTIPLY", rough.outputs["Color"], 1 - 0.55 * g)
    nt.links.new(r.outputs[0], bsdf.inputs["Roughness"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    nt.links.new(opac.outputs["Color"], bsdf.inputs["Alpha"])
    # Translucency: light through the blade.
    tr = nt.nodes.new("ShaderNodeBsdfTranslucent")
    nt.links.new(final.outputs[2], tr.inputs["Color"])
    mixs = nt.nodes.new("ShaderNodeMixShader")
    tf = math_node(nt, "MULTIPLY", scat.outputs["Color"], 0.45 * P["translucency"])
    nt.links.new(tf.outputs[0], mixs.inputs[0])
    nt.links.new(bsdf.outputs[0], mixs.inputs[1])
    nt.links.new(tr.outputs[0], mixs.inputs[2])
    # Keep the opacity cut-out when mixing in the translucent lobe.
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    cut = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(opac.outputs["Color"], cut.inputs[0])
    nt.links.new(transp.outputs[0], cut.inputs[1])
    nt.links.new(mixs.outputs[0], cut.inputs[2])
    nt.links.new(cut.outputs[0], out.inputs["Surface"])
    m.surface_render_method = "DITHERED"
    return m


def moss_tone():
    t = P["mossTone"]
    return (0.78 - 0.18 * t, 0.8 - 0.02 * t, 0.68 - 0.2 * t, 1)


def moss_hair_material():
    m = bpy.data.materials.new("SpanishMossHair")
    nt = m.node_tree
    b = principled(nt)
    base = tuple(c * 0.7 for c in moss_tone()[:3]) + (1,)
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 40
    col = mix_rgb(nt, "MULTIPLY", 0.35, base, noise.outputs["Color"], -300, 0)
    nt.links.new(col.outputs[2], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.75
    b.inputs["Sheen Weight"].default_value = 0.4
    b.inputs["Subsurface Weight"].default_value = 0.15
    return m


def moss_ribbon_material():
    m = bpy.data.materials.new("SpanishMoss")
    nt = m.node_tree
    b = principled(nt)
    t = node_tex(nt, os.path.join(JOB_DIR, "moss.png"))
    col = mix_rgb(nt, "MULTIPLY", 1.0, t.outputs["Color"], moss_tone(), -300, 0)
    nt.links.new(col.outputs[2], b.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 0.95
    m.surface_render_method = "DITHERED"
    return m


# ---------------------------------------------------------- environment ---


def build_environment():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("OakSky")
    sc.world = world
    if world.node_tree is None:
        world.use_nodes = True
    nt = world.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    # Atmosphere shared with three.js and Unreal (assets/atmospheres.json).
    atms = json.load(open(os.path.join(ASSETS, "atmospheres.json")))
    atm = atms.get(P.get("atmosphere", "clear"), atms["clear"])
    hdri = os.path.join(ASSETS, "hdri", f"{atm['hdri']}_4k.hdr")
    if not os.path.exists(hdri):
        hdri = hdri.replace("_4k.hdr", "_2k.hdr")
    env.image = img(hdri)
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = atm["env"]
    if atm["fog"] >= 2:
        # Sea fog / storm haze: a thin world volume.
        vol = nt.nodes.new("ShaderNodeVolumePrincipled")
        vol.inputs["Density"].default_value = 0.0012 * atm["fog"] * (0.3 + P.get("fog", 0.3))
        h = atm["fogColor"].lstrip("#")
        vol.inputs["Color"].default_value = tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1,)
        wout = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")
        nt.links.new(vol.outputs[0], wout.inputs["Volume"])

    sun_dir = Vector(tuple(to_b(JOB["sun"])[0])).normalized()
    sd = bpy.data.lights.new("Sun", "SUN")
    warm = min(1, max(0, (sun_dir.z - 0.05) / 0.45))
    tr, tg, tb = atm["sunTint"]
    sd.color = (tr, (0.72 + 0.22 * warm) * tg, (0.5 + 0.38 * warm) * tb)
    sd.energy = (0.8 + 2.6 * warm) * atm["sun"]  # matched to the three.js sun
    sd.angle = math.radians(1.2)
    sun = new_object("Sun", sd)
    sun.rotation_euler = sun_dir.to_track_quat("Z", "Y").to_euler()

    # Ground: two texture sets blended by noise, litter concentrated under the
    # canopy (mirrors createGroundMaterial in js/materials.js).
    grounds = json.load(open(os.path.join(ASSETS, "grounds.json")))
    gset = grounds.get(P["ground"], grounds["hammock"])
    ga, gbn, tint = gset["a"], gset["b"], tuple(gset["tintA"])
    b_amt, litter_under, desat = gset["bAmount"], gset["litterUnderCanopy"], gset["desat"]
    gm = bpy.data.materials.new("Ground")
    gnt = gm.node_tree
    gb = principled(gnt)
    tc = gnt.nodes.new("ShaderNodeTexCoord")
    mp = gnt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (40, 40, 40)
    gnt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
    mpb = gnt.nodes.new("ShaderNodeMapping")
    mpb.inputs["Scale"].default_value = (33, 33, 33)
    gnt.links.new(tc.outputs["UV"], mpb.inputs["Vector"])
    path = os.path.join(ASSETS, "textures", "ground", "%s_%s_2k.jpg")
    texs = {}
    for key, name, mapping in (("a", ga, mp), ("b", gbn, mpb)):
        for kind in ("diff", "rough", "nor_gl"):
            t = node_tex(gnt, path % (name, kind), kind != "diff")
            gnt.links.new(mapping.outputs["Vector"], t.inputs["Vector"])
            texs[key + kind] = t
    # Mask: fbm noise on world position, plus canopy radius.
    geo = gnt.nodes.new("ShaderNodeNewGeometry")
    nmap = gnt.nodes.new("ShaderNodeMapping")
    nmap.inputs["Scale"].default_value = (0.09, 0.09, 0.09)
    gnt.links.new(geo.outputs["Position"], nmap.inputs["Vector"])
    noise = gnt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 1.0
    noise.inputs["Detail"].default_value = 3.0
    gnt.links.new(nmap.outputs["Vector"], noise.inputs["Vector"])
    mr = gnt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.62 - b_amt * 0.6 - 0.05
    mr.inputs["From Max"].default_value = 0.75 - b_amt * 0.6 + 0.05
    inv = math_node(gnt, "SUBTRACT", 1.0, noise.outputs["Fac"])
    gnt.links.new(inv.outputs[0], mr.inputs["Value"])
    radius = gnt.nodes.new("ShaderNodeVectorMath")
    radius.operation = "LENGTH"
    gnt.links.new(geo.outputs["Position"], radius.inputs[0])
    canopy_r = max(4.0, SK["shear"].get("spread", P["limbLength"]))
    cmr = gnt.nodes.new("ShaderNodeMapRange")
    cmr.interpolation_type = "SMOOTHSTEP"
    cmr.inputs["From Min"].default_value = canopy_r * 0.7
    cmr.inputs["From Max"].default_value = canopy_r * 1.15
    cmr.inputs["To Min"].default_value = 0.85
    cmr.inputs["To Max"].default_value = 0.0
    gnt.links.new(radius.outputs["Value"], cmr.inputs["Value"])
    mask = gnt.nodes.new("ShaderNodeMix")  # mix(noiseMask, litterUnder, canopy)
    mask.data_type = "FLOAT"
    gnt.links.new(cmr.outputs["Result"], mask.inputs[0])
    gnt.links.new(mr.outputs["Result"], mask.inputs[2])
    mask.inputs[3].default_value = litter_under
    # Same colour math as js/materials.js:
    #   mix(rgb, luminance * (1.08, 0.98, 0.84), desat) * tintA    (B: desat * 0.7)
    def tan_desat(color_out, amount, y):
        bw = gnt.nodes.new("ShaderNodeRGBToBW")
        gnt.links.new(color_out, bw.inputs[0])
        tan = gnt.nodes.new("ShaderNodeCombineColor")
        for k, f in enumerate((1.08, 0.98, 0.84)):
            gnt.links.new(math_node(gnt, "MULTIPLY", bw.outputs[0], f).outputs[0], tan.inputs[k])
        return mix_rgb(gnt, "MIX", amount, color_out, tan.outputs[0], -450, y)

    a_col = tan_desat(texs["adiff"].outputs["Color"], desat, 450)
    b_col = tan_desat(texs["bdiff"].outputs["Color"], desat * 0.7, 250)
    tinted = mix_rgb(gnt, "MULTIPLY", 1.0, a_col.outputs[2], tint + (1,), -300, 300)
    col = mix_rgb(gnt, "MIX", mask.outputs[0], tinted.outputs[2], b_col.outputs[2], -100, 300)
    gnt.links.new(col.outputs[2], gb.inputs["Base Color"])
    rough = mix_rgb(gnt, "MIX", mask.outputs[0], texs["arough"].outputs["Color"], texs["brough"].outputs["Color"], -100, 0)
    gnt.links.new(rough.outputs[2], gb.inputs["Roughness"])
    nor = mix_rgb(gnt, "MIX", mask.outputs[0], texs["anor_gl"].outputs["Color"], texs["bnor_gl"].outputs["Color"], -100, -300)
    gnm = gnt.nodes.new("ShaderNodeNormalMap")
    gnt.links.new(nor.outputs[2], gnm.inputs["Color"])
    gnt.links.new(gnm.outputs["Normal"], gb.inputs["Normal"])
    bpy.ops.mesh.primitive_plane_add(size=320)
    ground = bpy.context.active_object
    ground.name = "Ground"
    ground.data.materials.append(gm)

    if SK.get("pond"):
        outline = SK["pond"]["outline"]
        verts = to_b([[x, 0.05, z] for x, z in outline])
        # Reverse the loop so the face points up (+Z) after the axis change.
        me = mesh_from_arrays("Pond", verts, np.arange(len(verts))[::-1].copy(), np.array([len(verts)]))
        pond = new_object("Pond", me)
        pm = bpy.data.materials.new("Pond")
        pb = principled(pm.node_tree)
        pb.inputs["Base Color"].default_value = (0.012, 0.022, 0.014, 1)
        pb.inputs["Roughness"].default_value = 0.04
        pond.data.materials.append(pm)

    if P.get("showOcean"):
        wd = math.radians(P["windDir"])
        frm = Vector(tuple(to_b([math.sin(wd), 0, -math.cos(wd)])[0]))
        bpy.ops.mesh.primitive_plane_add(size=600, location=frm * 365 + Vector((0, 0, 0.03)))
        ocean = bpy.context.active_object
        ocean.name = "Ocean"
        om = bpy.data.materials.new("Ocean")
        ob = principled(om.node_tree)
        ob.inputs["Base Color"].default_value = (0.02, 0.07, 0.09, 1)
        ob.inputs["Roughness"].default_value = 0.08
        ocean.data.materials.append(om)


def build_camera():
    c = JOB["camera"]
    cam_d = bpy.data.cameras.new("Camera")
    cam = new_object("Camera", cam_d)
    pos = Vector(tuple(to_b(c["position"])[0]))
    tgt = Vector(tuple(to_b(c["target"])[0]))
    cam.location = pos
    cam.rotation_euler = (tgt - pos).to_track_quat("-Z", "Y").to_euler()
    cam_d.sensor_fit = "VERTICAL"
    cam_d.angle_y = math.radians(c["fov"])
    cam_d.clip_end = 2000
    bpy.context.scene.camera = cam


def setup_render():
    sc = bpy.context.scene
    want = RENDER.get("engine", "CYCLES")
    engine = "CYCLES" if want == "CYCLES" else "BLENDER_EEVEE"
    try:
        sc.render.engine = engine
    except TypeError as e:
        log(f"engine {engine} unavailable ({e}); using CYCLES")
        sc.render.engine = "CYCLES"
    w, h = (int(x) for x in RENDER.get("resolution", "1920x1080").split("x"))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    atm = json.load(open(os.path.join(ASSETS, "atmospheres.json"))).get(P.get("atmosphere", "clear"), {"exposure": 1.0})
    sc.view_settings.exposure = math.log2(max(0.05, P.get("exposure", 1.0) * atm["exposure"]))
    samples = int(RENDER.get("samples", 128))
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.cycles.use_adaptive_sampling = True
        # Metal kernel compilation can hang in background mode on some
        # Blender/macOS combinations, so the device is selectable (default CPU).
        device = os.environ.get("OAK_DEVICE") or RENDER.get("device", "CPU")
        if device == "CPU":
            sc.cycles.device = "CPU"
            log("Cycles device: CPU")
            return_device = True
        else:
            return_device = False
        try:
            if return_device:
                raise StopIteration
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for t in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = t
                    break
                except TypeError:
                    continue
            prefs.get_devices()
            for d in prefs.devices:
                d.use = True
            sc.cycles.device = "GPU"
            log(f"Cycles device: {prefs.compute_device_type}")
        except StopIteration:
            pass
        except Exception as e:  # noqa: BLE001
            sc.cycles.device = "CPU"
            log(f"GPU setup failed ({e}); CPU render")
    else:
        try:
            sc.eevee.taa_render_samples = samples
        except AttributeError:
            pass
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(JOB_DIR, "render.png")


# -------------------------------------------------------------------- run ---


def main():
    log("building scene")
    clear_scene()
    res = "2k" if MODE == "export" else "4k"
    hidden = bpy.data.collections.new("LeafSprigs")
    bpy.context.scene.collection.children.link(hidden)

    bark = build_bark()
    bark.data.materials.append(bark_material(res))
    leaf_mat = leaf_material(res)
    leaves = build_leaves_instanced(hidden)
    for ob in hidden.objects:
        ob.data.materials.append(leaf_mat)
    hidden.hide_render = True
    hidden.hide_viewport = True
    moss = build_moss_hair()
    if moss:
        moss.data.materials.append(moss_hair_material())
    under = build_understory()
    if under:
        under.data.materials.append(understory_material())
    build_leaves_instanced(hidden, UNDER.get("leaves") or [], "UnderstoryShrubs")
    build_environment()
    build_camera()
    setup_render()

    if MODE == "gui":
        def to_material_view():
            for win in bpy.context.window_manager.windows:
                for area in win.screen.areas:
                    if area.type == "VIEW_3D":
                        for sp in area.spaces:
                            if sp.type == "VIEW_3D":
                                sp.shading.type = "MATERIAL"
                                sp.region_3d.view_perspective = "CAMERA"
            return None
        bpy.app.timers.register(to_material_view, first_interval=1.0)
        log("scene ready in Blender GUI")
        return

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(JOB_DIR, "oak.blend"), copy=True)
    log("saved oak.blend")

    if MODE == "render":
        log(f"rendering {bpy.context.scene.render.engine} {RENDER.get('resolution')} @ {RENDER.get('samples')} spp")
        bpy.ops.render.render(write_still=True)
        log("render saved")

    # Export meshes: realized leaves and moss ribbons (instances and hair curves don't export).
    log("exporting GLB/FBX")
    leaves_x = build_leaves_realized()
    if leaves_x:
        leaves_x.data.materials.append(leaf_mat)
    moss_x = build_moss_ribbons()
    if moss_x:
        moss_x.data.materials.append(moss_ribbon_material())
    # Smaller textures for the exports.
    for im in bpy.data.images:
        if im.filepath and "_4k" in im.filepath:
            alt = im.filepath.replace("_4k", "_2k")
            if os.path.exists(bpy.path.abspath(alt)):
                im.filepath = alt
    bpy.ops.object.select_all(action="DESELECT")
    for ob in (bark, leaves_x, moss_x, under, bpy.data.objects.get("Pond")):
        if ob:
            ob.select_set(True)
    bpy.context.view_layer.objects.active = bark
    bpy.ops.export_scene.gltf(filepath=os.path.join(JOB_DIR, "oak.glb"), export_format="GLB",
                              use_selection=True, export_image_format="JPEG", export_apply=True)
    log("wrote oak.glb")
    bpy.ops.export_scene.fbx(filepath=os.path.join(JOB_DIR, "oak.fbx"), use_selection=True,
                             path_mode="COPY", embed_textures=False, mesh_smooth_type="FACE",
                             add_leaf_bones=False, colors_type="SRGB")  # 8-bit colours need sRGB precision; UE decodes
    log("wrote oak.fbx")
    open(os.path.join(JOB_DIR, "done.txt"), "w").write("ok")
    log("finished")


main()
