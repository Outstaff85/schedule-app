"""Our own cut (docs/scan-training.md → "The phone's own cuts: gen/phone_run.py"): the pages the document type model,
the passport zone reader, the Hebrew field reader and the face finder's exam learn on are cut by the scanner lab's own
path, not by the true corners — `python -m gen build --model doctype,mrz,he,face`.

For each scene, made up (gen/scene.py) or real (an attempt's photo with the corners a person kept, --real):
1. the lab's shot (gen/exam_phone.py shot, the phone path): frame_to_S, the lab's edges-lite on the live frame and
   edges on the capture (the version in scripts/scan-lab/models-version — only read, never changed), corners(), then
   findNext and findInside (docfind.find_next lab=True, docfind.find_inside);
2. the found documents matched to the true ones by their overlap (match: the assignment with the largest total IoU,
   tried over every permutation — at most 4 documents, so no scipy): matched, missed and false, with the corner error;
3. each true document cut from the full frame by the PREDICTED corners (gen/phone.py warp_rgba: the lab's cut), then
   turned by the face on it (phone.face_turn: the lab's faceTurn) — the frame at the camera's NATIVE size (native_scene:
   the 1920 × 1080 video or the ~4000 × 3000 photo the lab cuts from, not the 1600 px the edges sets are drawn at); a
   real attempt is cut from its stored photo (at most 1600 px, JPEG: cutFrom "stored1600");
4. its labels from the geometry: turn_k — the clockwise quarter turns the cut still needs (the document's own corner
   order against the predicted one, less the face's turn) — and every field box mapped into the cut through
   H_pred⁻¹·H_true (the camera's projection of the page's own box, then the frame → cut map of the predicted corners);
5. a document the lab missed, or found so badly (IoU under BAD_IOU) that a person would fix its corners, is cut "as in
   the editor": the true corners each moved 0.5–1 % of the frame (cut_by "editor"); a cut of IoU BAD_IOU–GOOD_IOU is a
   bad cut kept as it is. gen_write keeps the editor cuts to at most --editor-cap of the pages (the real corner-fix
   rate: a parameter until the real attempts measure it) and the bad cuts to --bad-share; the rest are dropped, and
   which ones is recorded in the run (params "dropped"), so gen verify draws the same.

The lab's answers (what the shot found, each cut's face turn) are cached in <home>/cache/cuts/<edges sha>/<run>/<n>.json,
each tied to the sha1 of the frame it was found on (frame_sha): a second build of the same run runs no model; a frame
drawn otherwise (the scene code changed) is a miss and the lab runs again; a new edges version is another folder (and
another fingerprint: its sha is in every row's labels and in run.json). The writers (gen/outputs/doctype.py, mrz.py,
he.py, face.py) make each model's files from one scene's cuts; this module draws the scenes and is the build's
generator (gen/build.py).
Pure numpy / OpenCV / ONNX Runtime; the lab's models are loaded only on a cache miss."""
import hashlib
import itertools
import json
import pathlib

import numpy as np

MODEL, CHUNK = "cuts", 10
GENERATOR = "gen.phone_run"
OUTPUTS = ("doctype", "mrz", "he", "face")
MATCH_IOU = 0.5     # a found document is a true one when they overlap this much (else: a false one, and the true missed)
GOOD_IOU = 0.8      # a cut at least this good is a phone cut as it is
BAD_IOU = 0.6       # BAD_IOU–GOOD_IOU: a bad cut, kept within BAD_SHARE; under it a person would fix the corners (editor)
EDITOR_JITTER = (0.005, 0.01)   # the editor's corners: the true ones, each moved this share of the frame
EDITOR_CAP = 0.15   # the editor cuts' share of the pages kept (the real corner-fix rate — measured from the attempts later)
BAD_SHARE = 0.1     # the bad cuts' share of the pages kept
LAB_FILES = ("edges-lite.onnx", "edges.onnx")
FACE_FILE = "face.onnx"
IOU_GRID = 256
UNIT = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]


# ---------- geometry ----------
def quad_iou(a, b, n=IOU_GRID):
    """The overlap of two quads (0..1, either order) counted at the centres of an n × n grid."""
    from .phone import in_quad
    g = (np.arange(n) + 0.5) / n
    gx, gy = np.meshgrid(g, g)
    p, q = in_quad(a, gx, gy), in_quad(b, gx, gy)
    any_ = int((p | q).sum())
    return int((p & q).sum()) / any_ if any_ else 0.0


def match(pred, true, thr=MATCH_IOU):
    """The found documents against the true ones: the one-to-one assignment with the largest total IoU among the
    pairs overlapping at least thr, tried over every permutation (itertools: a shot finds at most 5) → (pairs [(i
    found, j true, iou)], false [i], missed [j])."""
    n, m = len(pred), len(true)
    iou = [[quad_iou(p, t) for t in true] for p in pred]
    best, pick = -1.0, ()
    k = max(n, m)
    if n and m:
        for perm in itertools.permutations(range(k), n):
            got = tuple((i, j) for i, j in enumerate(perm) if j < m and iou[i][j] >= thr)
            score = sum(iou[i][j] for i, j in got)
            if score > best + 1e-12:
                best, pick = score, got
    pairs = [(i, j, round(iou[i][j], 4)) for i, j in pick]
    used_i, used_j = {i for i, _, _ in pairs}, {j for _, j, _ in pairs}
    return pairs, [i for i in range(n) if i not in used_i], [j for j in range(m) if j not in used_j]


def turn_of(quad, doc):
    """The clockwise quarter turns a page cut by quad (its corners in the cut's order: the cut's top-left first) needs
    to stand upright, doc being the page's own corners (its own top-left first, clockwise): the shift r with quad[i]
    nearest doc[(i + r) % 4] — the cut's top-left is the page's corner r."""
    q, d = np.asarray(quad, np.float64), np.asarray(doc, np.float64)
    return int(min(range(4), key=lambda r: float(np.hypot(*(q - np.roll(d, -r, 0)).T).sum())))


def cut_map(pts, w, h):
    """The map of a frame's points (pixel edges) into the cut warp_rgba makes by pts (0..1): → (W, H of the cut, a
    function of an N × 2 array giving the cut's points in its own pixel edges). warp_rgba samples the source at pixel
    indices (pixel centres) by the homography of the cut's pixel indices onto pts × (w, h); its inverse takes a centre
    back — so a point at pixel edges e goes through e − 0.5, the inverse map, then + 0.5."""
    from .phone import apply_h, homography, warp_size
    W, H, P = warp_size(w, h, pts)
    Hi = homography(P, [[0, 0], [W, 0], [W, H], [0, H]])

    def fn(xy):
        return np.array([[c + 0.5 for c in apply_h(Hi, float(x) - 0.5, float(y) - 0.5)] for x, y in np.asarray(xy, np.float64)])
    return W, H, fn


def turn_points(pts, size, k):
    """Points (pixel edges) of a W × H picture after k clockwise quarter turns (phone.turned) → (points, new size)."""
    P = np.asarray(pts, np.float64).copy()
    W, H = size
    for _ in range(k % 4):
        P = np.stack([H - P[:, 1], P[:, 0]], 1)
        W, H = H, W
    return P, (W, H)


def box_of(quad, size):
    """A field's quad (pixel edges) as an [x, y, w, h] box in shares of the picture (its bounding box, not clipped:
    a field running past the cut's edge stays measurable)."""
    q = np.asarray(quad, np.float64)
    W, H = size
    x0, y0 = q.min(0)
    x1, y1 = q.max(0)
    return [round(float(x0 / W), 5), round(float(y0 / H), 5), round(float((x1 - x0) / W), 5), round(float((y1 - y0) / H), 5)]


def editor_quad(rng, quad):
    """The corners a person leaves in the editor: the true ones (0..1, the model's order) each moved EDITOR_JITTER of
    the frame in a random direction (rng: random.Random — always 8 draws, matched or not, so the stream stays put)."""
    out = []
    for x, y in quad:
        r, a = rng.uniform(*EDITOR_JITTER), rng.uniform(0, 2 * np.pi)
        out.append([min(1.0, max(0.0, x + r * np.cos(a))), min(1.0, max(0.0, y + r * np.sin(a)))])
    return out


# ---------- the lab's models ----------
def lab_paths(version=None):
    """{file: path} of the lab's edges models and face finder (the lab's version unless named; common.model_path
    fetches a file not on this PC). scripts/scan-lab/models-version is only read."""
    from common import model_path, version_of
    version = version or version_of("scan-lab")
    return version, {n: model_path(version, n) for n in LAB_FILES + (FACE_FILE,)}


def free_face(path):
    """The face finder as the lab runs it: YuNet's file is fixed at 640 × 640, the lab frees its size at deploy
    (scripts/scan-lab/yunet_dyn.py free) and runs it at 320 × 320 — the same here, in memory → the model's bytes."""
    import importlib.util
    import onnx
    from . import common as gc
    spec = importlib.util.spec_from_file_location("yunet_dyn", gc.HERE.parent / "scan-lab" / "yunet_dyn.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.free(onnx.load(str(path))).SerializeToString()


def edges_sha(paths):
    """One sha256 of the lab's two edges models (each file's sha256, in LAB_FILES order)."""
    from home import sha256_of
    return hashlib.sha256("".join(sha256_of(paths[n]) for n in LAB_FILES).encode()).hexdigest()


class Lab:
    """The lab's models, loaded on first use (a cached scene loads none): shot(frame) → {"shot", "quads", "how"} (the
    lab's whole shot on the phone path, gen/exam_phone.py shot), face(cut BGR) → the face finder's turn (-1: none)."""
    runs = 0   # model calls in this process (shots and face turns) — none when every scene comes from the cache

    def __init__(self, params):
        self.params, self.s = params, None

    def _load(self):
        if self.s is None:
            import multiprocessing
            import onnxruntime as ort
            so = ort.SessionOptions()
            so.intra_op_num_threads = 1 if multiprocessing.current_process().name != "MainProcess" else 0   # one per process in a pool
            _, paths = lab_paths(self.params.get("labVersion"))
            self.s = {n: ort.InferenceSession(str(paths[n]), so, providers=["CPUExecutionProvider"]) for n in LAB_FILES}
            self.s[FACE_FILE] = ort.InferenceSession(free_face(paths[FACE_FILE]), so, providers=["CPUExecutionProvider"])
        return self.s

    def shot(self, frame):
        from .exam_phone import shot
        s = self._load()
        Lab.runs += 1
        r = shot((s["edges-lite.onnx"], s["edges.onnx"]), frame, "phone")
        return {"shot": bool(r["shot"]), "quads": r["quads"], "how": r["how"]}

    def face(self, cut):
        from .phone import face_turn
        Lab.runs += 1
        return int(face_turn(self._load()[FACE_FILE], cut, bgr=True))


def run_key(params):
    """The run's own key for the cache: everything that draws its frames and cuts (not its folder, nor what gen_write
    dropped)."""
    from .manifest import canonical
    keep = {k: v for k, v in params.items() if k not in ("out", "dropped", "show", "jobs")}
    return hashlib.sha256(canonical(keep).encode("utf-8")).hexdigest()


def frame_sha(frame):
    """The sha1 of a frame's bytes and shape: a cache record holds only for the frame it was found on."""
    h = hashlib.sha1(repr((frame.shape, str(frame.dtype))).encode())
    h.update(np.ascontiguousarray(frame).tobytes())
    return h.hexdigest()


def native_scene(sc):
    """The scene seen by the same camera at its native frame size (gen/camera.py frame_size: the size before
    RENDER_MAX): the lab cuts from the full frame — the 1920 × 1080 video (takeShot) or the picked photo at its natural
    size (analyzePicture) —, so the cuts are made from it. The projection scales with the frame (K: the focal length
    and the centre in pixels of the long side), so the pages' 0..1 corners stay where they were and their pixels scale."""
    import dataclasses
    from .camera import Camera
    c = sc.cam
    w, h = (int(v) for v in c.native)
    if (w, h) == (c.W, c.H):
        return sc
    return dataclasses.replace(sc, cam=Camera(w, h, c.native, c.fov, c.target, c.distance, c.tilt, c.azimuth, c.roll))


class Cache:
    """<home>/cache/cuts/<edges sha>/<run key>/<n>.json: a scene's shot and face turns, and the sha1 of the frame they
    were found on ("frame": a record for another frame is a miss)."""

    def __init__(self, params, work=None):
        import home
        root = pathlib.Path(work or home.WORK) / "cache" / "cuts"
        self.dir = root / str(params.get("edgesSha", "none"))[:16] / run_key(params)[:16]

    def get(self, i):
        try:
            return json.loads((self.dir / f"{i}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def put(self, i, rec):
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = self.dir / f"{i}.json.tmp"
        tmp.write_text(json.dumps(rec), encoding="utf-8")
        tmp.replace(self.dir / f"{i}.json")


# ---------- one scene ----------
def truths_of(labels, W, H):
    """A scene's true documents a phone could find (gen/scene.py doc_labels: not painted over, wholly in the frame):
    each with quad01 (pixel edges / size, the page's own order), quadDoc (the same, its top-left first), quadModel (the
    model's order), its fields and face in frame pixels, its mrz and where it came from."""
    out = []
    for l in labels:
        if l["painted"] or not l["visible"]:
            continue
        out.append({"index": l["index"], "doctype": l["doctype"], "kind": l["kind"], "source": l["source"],
                    "quad01": l["quad01"], "quadDoc": l["quad01"], "quadModel": l["quadModel"], "fields": l["fields"],
                    "face": l["face"], "mrz": l["mrz"], "pageId": l["pageId"], "templateSha1": l["templateSha1"],
                    "seen": l["seen"], "insideOf": l["insideOf"], "material": l["material"]})
    return out


def _centre(quad01, w, h):
    """0..1 at pixel edges → 0..1 at pixel centres (warp_rgba's: the page's own corner lands on its own pixel)."""
    return [[(x * w - 0.5) / w, (y * h - 0.5) / h] for x, y in quad01]


def cut_scene(frame, truths, shot, face, rng, cached=None):
    """One frame (BGR) cut as the lab cuts it: → (result, the cache record). shot(frame) and face(cut) are the lab's
    (Lab) or stand-ins; rng: the scene's "phone" stream (the editor's corners); cached: a record from Cache.get (then
    neither is called). result: {"shot", "found", "matched", "missed", "false", "docs": [one per truth: {"j", "cutBy",
    "iou", "cornerErr", "how", "quad", "faceK", "geomTurn", "turnK", "cut" (BGR, before the face's turn), "crop" (BGR,
    after it), "size", "fields": [{role, kind, text, quad, box}], "face" (quad px in the crop or None), "truth"}]}."""
    import docfind
    from . import phone
    h, w = frame.shape[:2]
    pred = cached["pred"] if cached else shot(frame)
    faces = dict((cached or {}).get("faces") or {})
    quads = [np.asarray(q, np.float64) for q in pred.get("quads") or []]
    pairs, false, missed = match(quads, [t["quad01"] for t in truths])
    by_true = {j: (i, v) for i, j, v in pairs}
    docs = []
    for j, t in enumerate(truths):
        ed = editor_quad(rng, _centre(t["quadModel"], w, h))
        i, v = by_true.get(j, (None, 0.0))
        if i is not None and v >= BAD_IOU:
            q, how, cut_by = quads[i].tolist(), pred["how"][i] if i < len(pred.get("how") or []) else "found", "phone"
        else:
            q, how, cut_by = ed, "editor", "editor"
        iou = v if cut_by == "phone" else round(quad_iou(q, t["quad01"]), 4)
        cut = np.ascontiguousarray(phone.warp_rgba(frame, q)[..., :3])
        key = f"{cut_by}:{j}"
        if key not in faces:
            faces[key] = face(cut) if cut.size else -1
        fk = int(faces[key])
        r = turn_of(q, _centre(t["quadDoc"], w, h)) if t.get("quadDoc") is not None else None
        turn_k = (r - max(fk, 0)) % 4 if r is not None else None
        crop = phone.turned(cut, fk) if fk > 0 else cut
        W, H, fn = cut_map(q, w, h)
        fields = []
        for f in t.get("fields") or []:
            pts, size = turn_points(fn(f["quad"]), (W, H), max(fk, 0))
            fields.append({"role": f["role"], "kind": f.get("kind", f["role"]), "text": f["text"], "quad": pts.tolist(),
                           "box": box_of(pts, size)})
        face_q = None
        if t.get("face"):
            fq, _ = turn_points(fn(t["face"]), (W, H), max(fk, 0))
            face_q = fq.tolist()
        docs.append({"j": j, "cutBy": cut_by, "iou": iou, "cornerErr": round(docfind.quad_error(q, t["quadModel"]), 5),
                     "how": how, "quad": [[round(float(x), 6), round(float(y), 6)] for x, y in q], "faceK": fk,
                     "geomTurn": r, "turnK": turn_k, "cut": cut, "crop": crop,
                     "size": [int(crop.shape[1]), int(crop.shape[0])], "fields": fields, "face": face_q, "truth": t})
    result = {"shot": bool(pred.get("shot")), "found": len(quads), "matched": len(pairs), "missed": len(missed),
              "false": len(false), "falseIou": [round(max([quad_iou(quads[i], t["quad01"]) for t in truths] or [0.0]), 4) for i in false],
              "docs": docs}
    return result, {"pred": {"shot": bool(pred.get("shot")), "quads": [np.asarray(q).tolist() for q in quads],
                             "how": list(pred.get("how") or [])}, "faces": faces}


# ---------- gen build (gen/build.py): the generator ----------
def gen_args(ap):
    from .outputs import edges as ge
    ge.gen_args(ap)   # the scenes' own options (templates, backgrounds, recipes, --exam …)
    ap.add_argument("--models", default=",".join(OUTPUTS), help="the writers: doctype,mrz,he,face (python -m gen build --model)")
    ap.add_argument("--cuts", action="store_true", help="(python -m gen build) a single doctype or he through the phone's cut")
    ap.add_argument("--version", help="the lab's models' version (default: scripts/scan-lab/models-version — only read)")
    ap.add_argument("--editor-cap", type=float, default=EDITOR_CAP,
                    help="the editor cuts' largest share of the pages kept (the real corner-fix rate; default %(default)s)")
    ap.add_argument("--bad-share", type=float, default=BAD_SHARE, help="the bad cuts' (IoU 0.6–0.8) largest share (default %(default)s)")
    ap.add_argument("--real", type=int, default=0, help="also cut up to N real attempts (examples.json: the photos with the "
                    "corners a person kept, the run's side only)")


def real_scenes(work, exam, limit):
    """Up to limit real attempts (pull.py's examples.json) on the run's side — the exam's only (exam: True) for an
    --exam run, only what trains (gen.common.trains) for a training run — with the corners a person kept: [{path,
    sha1, fixed, doc, doctype, key}]; a photo with no document or no corners is left out."""
    from . import common as gc
    f = pathlib.Path(work) / "examples.json"
    if not limit or not f.exists():
        return []
    out = []
    for e in json.loads(f.read_text(encoding="utf-8")):
        if not e.get("attempt") or e.get("none") or not e.get("fixed"):
            continue
        if (not e.get("exam")) if exam else not gc.trains(e):   # the exam side: only the exam's; training: only gc.trains
            continue
        p = pathlib.Path(e["file"])
        if not p.exists():
            continue
        out.append({"path": str(p), "sha1": gc.file_sha1(p), "fixed": e["fixed"], "doc": e.get("doc"),
                    "doctype": e.get("doctype") if e.get("doctype") in gc.DOCTYPES else None, "key": e.get("key")})
        if len(out) >= limit:
            break
    return out


def gen_params(a):
    from home import WORK
    from .outputs import edges as ge
    a.count = a.count or (300 if a.exam else 2000)
    out = a.out
    a.out = a.out or "-"   # edges' default name is not ours
    p = ge.gen_params(a)
    seed = p["seed"]
    models = [m for m in a.models.split(",") if m]
    bad = [m for m in models if m not in OUTPUTS]
    if bad:
        raise SystemExit(f"no cut writer for {', '.join(bad)} (one of {', '.join(OUTPUTS)})")
    version, paths = lab_paths(a.version)
    from home import sha256_of
    p.update({"model": MODEL, "generator": GENERATOR, "models": models, "labVersion": version, "edgesSha": edges_sha(paths),
              "faceSha": sha256_of(paths[FACE_FILE]), "editorCap": a.editor_cap, "badShare": a.bad_share,
              "real": real_scenes(WORK, a.exam, a.real),
              "out": out or str(WORK / "gen" / "runs" / f"cuts-s{seed}-n{p['count']}{'-exam' if a.exam else ''}")})
    print(f"the lab's models {version} (edges {p['edgesSha'][:12]}); writers {', '.join(models)}; "
          f"{len(p['real'])} real attempts; editor cuts at most {a.editor_cap:.0%}, bad cuts at most {a.bad_share:.0%}")
    return p


def indices(params):
    """Every item of the run: the made-up scenes, then the real attempts (--real)."""
    return range(params["count"] + len(params.get("real") or []))


def gen_prepare(folder, params):
    folder = pathlib.Path(folder)
    for m in params["models"]:
        (folder / m / "img").mkdir(parents=True, exist_ok=True)


def gen_jobs(params, indices, folder):
    return [(params, chunk, folder) for chunk in (indices[k:k + CHUNK] for k in range(0, len(indices), CHUNK))]


def writers(models):
    import importlib
    return {m: importlib.import_module(f"gen.outputs.{m}") for m in models}


def _real_truth(e, w, h):
    return [{"index": 0, "doctype": e.get("doctype"), "kind": e.get("doctype") or "unknown", "source": "attempt",
             "quad01": e["fixed"], "quadDoc": e.get("doc"), "quadModel": e["fixed"], "fields": [], "face": None, "mrz": None,
             "pageId": f"attempt:{(e.get('sha1') or '')[:12]}", "templateSha1": None, "seen": True, "insideOf": None,
             "material": None}]


def _batch(job):
    import cv2
    from . import pages as gp
    from . import rng as grng
    from . import scene as gs
    from .outputs import edges as ge
    params, indices, folder = job
    folder = pathlib.Path(folder)
    F, pool, bank, occ = ge.tools(params)
    lab, cache, out_mods = Lab(params), Cache(params), writers(params["models"])
    from . import common as gc
    dropped = set(params.get("dropped") or [])
    seed, count = params["seed"], params["count"]
    exam_fonts = {str(f).lower() for f in gc.heldout().get("examFonts") or []}
    out = []
    for i in indices:
        runs0 = Lab.runs
        if i < count:
            skipped0 = gp.SKIPPED["pdf"]
            r, sc = ge.scene_of(params, i, F, pool, bank, occ)
            if sc is None:
                F.used()
                out.append({"index": i, "id": f"cut-{seed}-{i}", "entry": {}, "files": [], "runs": 0,
                            "meta": {"class": "none", "source": "none", "rng": grng.STAGED, "labels": {"noPose": True}}})
                continue
            sc = native_scene(sc)   # cut from the full frame, as the lab does
            frame = gs.render(sc, r["camera"])
            labels = gs.doc_labels(sc)
            roles = gs.roles(sc, labels)
            meta = ge.scene_meta(params, sc, labels, roles, F, skipped0)
            truths = truths_of(labels, sc.cam.W, sc.cam.H)
            role_of = {l["index"]: rl for l, rl in roles}
            for t in truths:
                t["role"] = role_of.get(t["index"], "painted")
            rng = r["phone"]
            cut_from = "native"
        else:
            e = params["real"][i - count]
            frame = cv2.imread(e["path"])
            truths = _real_truth(e, *(frame.shape[1::-1] if frame is not None else (1, 1))) if frame is not None else []
            meta = {"templates": [], "class": e.get("doctype") or "unknown", "source": "attempt", "rng": grng.STAGED,
                    "vocabulary": "check" if params.get("held") else "train",
                    "scene": {"recipe": "real", "attempt": (e.get("sha1") or "")[:12]}}
            cut_from = "stored1600"   # the attempt's stored photo: at most 1600 px, JPEG 0.85 (phone.store_attempt)
            if e.get("key"):
                meta["key"] = e["key"]
            rng = grng.py_stream(seed, i, "phone")
            for t in truths:
                t["role"] = "answer"
            if frame is None:
                out.append({"index": i, "id": f"cut-{seed}-{i}", "entry": {}, "files": [], "runs": 0, "meta": meta})
                continue
        fsha = frame_sha(frame)
        rec = cache.get(i)
        if rec is not None and rec.get("frame") != fsha:   # found on another frame (the drawing changed): run the lab again
            rec = None
        res, rec2 = cut_scene(frame, truths, lab.shot, lab.face, rng, rec)
        if rec is None:
            cache.put(i, {**rec2, "frame": fsha})
        ctx = {"seed": seed, "index": i, "edgesSha": params["edgesSha"], "split": params["split"], "held": params.get("held", False),
               "cutFrom": cut_from,
               "fontSplit": "exam" if any(pathlib.Path(f).name.lower() in exam_fonts for f in meta.get("fonts") or []) else "train",
               **({"key": meta["key"]} if meta.get("key") else {})}
        entry, files = {}, []
        for d in res["docs"]:
            d["id"] = f"cut-{seed}-{i}-d{d['j']}"
        for m, mod in out_mods.items():
            ents, fs = mod.write(folder, res, ctx)
            entry[m] = ents
            files += fs
        docs = [{"j": d["j"], "pageId": d["truth"]["pageId"], "doctype": d["truth"]["doctype"], "role": d["truth"].get("role"),
                 "source": d["truth"]["source"], "cutBy": d["cutBy"], "iou": d["iou"], "cornerErr": d["cornerErr"],
                 "how": d["how"], "faceK": d["faceK"], "geomTurn": d["geomTurn"], "turnK": d["turnK"], "kept": True}
                for d in res["docs"]]
        first = res["docs"][0] if res["docs"] else None
        if i < count:   # a made-up scene's class and source: its first document's (the largest in sight)
            meta.update({"class": first["truth"]["doctype"] if first else "none", "source": first["truth"]["source"] if first else "none"})
        meta.update({"labels": {"edgesSha": params["edgesSha"][:16], "cutFrom": cut_from,
                                "frame": [int(frame.shape[1]), int(frame.shape[0])], "shot": res["shot"], "found": res["found"],
                                "matched": res["matched"], "missed": res["missed"], "false": res["false"],
                                "falseIou": res["falseIou"], "turn": first["turnK"] if first else None, "docs": docs}})
        item = {"index": i, "id": f"cut-{seed}-{i}", "entry": entry, "files": files, "meta": meta, "runs": Lab.runs - runs0}
        drop(item, {d for d in dropped if d.startswith(f"{i}:")}, folder)
        out.append(item)
    return out


# ---------- what is kept: the editor cuts and the bad cuts bounded ----------
def decide(items, editor_cap, bad_share):
    """The pages to drop, in index order ("<index>:<j>"): an editor cut is kept while the editor cuts stay at most
    editor_cap of the pages kept so far, a bad cut (IoU BAD_IOU–GOOD_IOU) while the bad ones stay at most bad_share;
    a good phone cut is always kept. Kept so far only grows, so the shares at the end are within their caps."""
    kept = editor = bad = 0
    out = []
    for it in sorted(items, key=lambda it: it["index"]):
        for d in (it["meta"].get("labels") or {}).get("docs") or []:
            key = f"{it['index']}:{d['j']}"
            if d["cutBy"] == "editor":
                if editor + 1 <= editor_cap * (kept + 1):
                    editor += 1
                    kept += 1
                else:
                    out.append(key)
            elif d["iou"] < GOOD_IOU:
                if bad + 1 <= bad_share * (kept + 1):
                    bad += 1
                    kept += 1
                else:
                    out.append(key)
            else:
                kept += 1
    return out


def drop(item, keys, folder):
    """Leave the pages keys ("<index>:<j>") out of an item: their files deleted, their entries removed, each doc's
    "kept" in the labels set — the same whether gen_write decides it or gen verify draws the item again."""
    if not keys:
        return item
    folder = pathlib.Path(folder)
    js = {int(k.split(":")[1]) for k in keys}
    gone = set()
    for m, ents in item["entry"].items():
        keep = []
        for e in ents:
            if e.get("doc") in js:
                gone.update(e.get("files") or [e.get("file")])
            else:
                keep.append(e)
        item["entry"][m] = keep
    for f in gone:
        if f:
            (folder / f).unlink(missing_ok=True)
    item["files"] = [f for f in item["files"] if f not in gone]
    for d in (item["meta"].get("labels") or {}).get("docs") or []:
        if d["j"] in js:
            d["kept"] = False
    return item


def gen_write(folder, params, items):
    folder = pathlib.Path(folder)
    out = decide(items, params.get("editorCap", EDITOR_CAP), params.get("badShare", BAD_SHARE))
    by = {}
    for k in out:
        by.setdefault(int(k.split(":")[0]), set()).add(k)
    for it in items:
        drop(it, by.get(it["index"], set()), folder)
    params["dropped"] = out   # into run.json: gen verify draws the same
    summary = summarise(items, params)
    for m, mod in writers(params["models"]).items():
        summary[m] = mod.finish(folder, [e for it in items for e in it["entry"].get(m, [])], params)
    (folder / "cuts.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    c = summary["cuts"]
    print(f"{len(items)} scenes in {folder}: documents {c['documents']} — matched {c['matched']}, missed {c['missed']}, "
          f"false {c['false']}; pages kept {c['kept']} (editor {c['keptByCut'].get('editor', 0)}, "
          f"share {c['editorShare']:.1%} ≤ cap {c['editorCap']:.0%}); model runs {summary['modelRuns']}"
          + (" (every scene from the cache)" if not summary["modelRuns"] else ""))
    if "doctype" in summary:
        d = summary["doctype"]
        print("  doctype crops by class: " + ", ".join(f"{k} {v['crops']} ({v['templates']} templates)" for k, v in d["byClass"].items())
              + (f" — short: {', '.join(d['short'])}" if d["short"] else ""))
    if "mrz" in summary:
        z = summary["mrz"]
        print(f"  zone: {z['passports']} passports, lines found right on {z['ok']}, failed {z['failed']}")
    if "he" in summary:
        print(f"  Hebrew fields: {summary['he']['crops']} crops, skipped {summary['he']['skipped']}; layout_overflow.json")
    if "face" in summary:
        f = summary["face"]
        print(f"  face exam crops: {f['crops']} (the face finder right on {f['right']}, no face on {f['noFace']})")


IOU_BINS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001)


def summarise(items, params):
    """cuts.json's "cuts": the shot's counts and the IoU of every page cut, by how it was cut."""
    docs = [d for it in items for d in (it["meta"].get("labels") or {}).get("docs") or []]
    labs = [it["meta"].get("labels") or {} for it in items]
    kept = [d for d in docs if d.get("kept")]
    hist = {}
    for d in docs:
        if d["cutBy"] != "phone":
            continue
        for lo, hi in zip(IOU_BINS, IOU_BINS[1:]):
            if lo <= d["iou"] < hi:
                hist[f"{lo:.2f}-{min(hi, 1):.2f}"] = hist.get(f"{lo:.2f}-{min(hi, 1):.2f}", 0) + 1
    from collections import Counter
    cut = lambda d: d["cutBy"] if d["cutBy"] == "editor" else ("phone" if d["iou"] >= GOOD_IOU else "bad")
    return {"cuts": {"scenes": len(items), "shots": sum(bool(l.get("shot")) for l in labs), "documents": len(docs),
                     "matched": sum(int(l.get("matched") or 0) for l in labs), "missed": sum(int(l.get("missed") or 0) for l in labs),
                     "false": sum(int(l.get("false") or 0) for l in labs), "kept": len(kept),
                     "byCut": {k: sum(1 for d in docs if cut(d) == k) for k in ("phone", "bad", "editor")},
                     "keptByCut": {k: sum(1 for d in kept if cut(d) == k) for k in ("phone", "bad", "editor")},
                     "editorShare": round(sum(1 for d in kept if d["cutBy"] == "editor") / max(1, len(kept)), 4),
                     "badShare": round(sum(1 for d in kept if cut(d) == "bad") / max(1, len(kept)), 4),
                     "editorCap": params.get("editorCap", EDITOR_CAP), "badCap": params.get("badShare", BAD_SHARE),
                     "iouHist": hist, "cornerErrMean": round(float(np.mean([d["cornerErr"] for d in docs if d["cutBy"] == "phone"] or [0])), 5),
                     "byHow": dict(sorted(Counter(str(d["how"]) for d in docs).items())), "turnKnown": sum(d.get("turnK") is not None for d in docs),
                     "edgesSha": params.get("edgesSha"), "labVersion": params.get("labVersion")},
            "modelRuns": sum(int(it.get("runs") or 0) for it in items), "dropped": len(params.get("dropped") or [])}
