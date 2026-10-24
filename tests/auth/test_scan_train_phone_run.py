"""The phone's own cuts (scripts/scan-train/gen/phone_run.py, gen/outputs/doctype.py, mrz.py, he.py, face.py;
docs/scan-training.md → "The phone's own cuts"):

- the found documents are matched to the true ones by the assignment with the largest total IoU (every permutation:
  no scipy), not greedily; the rest are false or missed;
- turn_k comes from the geometry: a page turned k quarter turns in the frame shifts turn_k by k (all 4 k), and with a
  face the face's turn takes it over (turn_k 0, face_k shifted by k);
- H_pred⁻¹·H_true: a field box known on the page lands within 0.5 px of where its pixels are on a cut made by
  corners a little off (warp_rgba, the lab's cut);
- the editor cuts stay within their cap and the bad cuts within theirs, whatever the order; a dropped page leaves no
  file and is marked in the labels — the same when gen verify draws it again;
- a second drawing of a scene comes from the cache (no model runs) and is byte for byte the same; another edges model
  is another cache folder, and a frame drawn otherwise (the scene code changed) is a miss;
- the pages are cut from the frame at the camera's native size (the 1920 x 1080 video, the photo), not the 1600 px the
  edges sets are drawn at; the document type's 256 square is drawn from the full cut in one step, as the phone does;
- the exam and training sides stay apart: an --exam run's real attempts are the exam's only, a training run's only what
  trains, and train_doctypes refuses a cuts run of the exam;
- the Hebrew writer cuts where the layout says, writes layout_overflow.json and skips a card not upright; the zone
  writer counts its failures;
- train_doctypes' turn loss is averaged over the samples whose turn is known (the loss helper, torch only).
The lab's models are stand-ins here (no ONNX file needed); the smoke run (python -m gen build --model
doctype,mrz,he,face) runs the real ones."""
import json
import pathlib
import random
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

from gen import phone  # noqa: E402
from gen import phone_run as pr  # noqa: E402


def order_corners(q):
    import synth
    return synth.order_corners(q)


# ---------- matching ----------
def sq(x, y, s):
    return [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]


def test_matching_takes_the_best_assignment_not_the_greedy_one():
    # found 0 overlaps true 0 a little more than true 1 does; found 1 overlaps only true 0: greedy would pair found 0
    # with true 0 and leave found 1 alone — the best assignment pairs found 0 with true 1 and found 1 with true 0
    true = [sq(0.10, 0.10, 0.30), sq(0.16, 0.10, 0.30)]
    found = [sq(0.13, 0.10, 0.30), sq(0.09, 0.10, 0.30)]
    pairs, false, missed = pr.match(found, true)
    assert sorted((i, j) for i, j, _ in pairs) == [(0, 1), (1, 0)] and not false and not missed
    pairs, false, missed = pr.match([sq(0.6, 0.6, 0.2)] + found, true)
    assert false == [0] and not missed and len(pairs) == 2
    pairs, false, missed = pr.match([], true)
    assert pairs == [] and missed == [0, 1]
    pairs, false, missed = pr.match([sq(0.6, 0.6, 0.2)], [sq(0.1, 0.1, 0.2)])
    assert pairs == [] and false == [0] and missed == [0]
    assert pr.quad_iou(sq(0.1, 0.1, 0.4), sq(0.1, 0.1, 0.4)) == 1.0 and pr.quad_iou(sq(0.1, 0.1, 0.2), sq(0.5, 0.5, 0.2)) == 0.0


# ---------- a page in a frame ----------
PAGE_W, PAGE_H, FW, FH = 240, 150, 640, 480
BASE = [[170.0, 140.0], [470.0, 152.0], [462.0, 342.0], [176.0, 330.0]]   # the footprint, clockwise from its top-left


def page_picture():
    img = np.full((PAGE_H, PAGE_W, 3), 225, np.uint8)
    img[:34, :46] = (0, 0, 230)        # a red block at the page's own top-left (BGR)
    img[60:70, 60:200] = 30            # a line of "text"
    return img


def frame_with(page, k, base=BASE):
    """The page laid turned k clockwise quarter turns into the footprint: its corner i on base[(i + k) % 4]."""
    src = np.float32([[0, 0], [PAGE_W, 0], [PAGE_W, PAGE_H], [0, PAGE_H]])
    dst = np.float32([base[(i + k) % 4] for i in range(4)])
    M = cv2.getPerspectiveTransform(src, dst)
    frame = np.full((FH, FW, 3), 70, np.uint8)
    mask = cv2.warpPerspective(np.full((PAGE_H, PAGE_W), 255, np.uint8), M, (FW, FH))
    warped = cv2.warpPerspective(page, M, (FW, FH))
    frame[mask > 127] = warped[mask > 127]
    return frame, M, dst


def truth_of(dst, fields=()):
    q01 = [[float(x) / FW, float(y) / FH] for x, y in dst]
    return {"index": 0, "doctype": "id_front", "kind": "id_front", "source": "drawn", "quad01": q01, "quadDoc": q01,
            "quadModel": order_corners(q01), "fields": list(fields), "face": None, "mrz": None, "pageId": "drawn:id_front",
            "templateSha1": None, "seen": True, "insideOf": None, "material": "card", "role": "answer"}


def shot_of(truths):
    def shot(frame):
        return {"shot": True, "quads": [t["quadModel"] for t in truths], "how": ["cap"] * len(truths)}
    return shot


def red_turn(cut):
    """A stand-in face finder: the quarter turns that put the red block at the top-left."""
    best, bk = -1.0, -1
    for k in range(4):
        t = phone.turned(cut, k)
        h, w = t.shape[:2]
        corner = t[: h // 4, : w // 4].astype(float)
        red = float((corner[..., 2] - corner[..., :2].mean(-1)).mean())
        if red > best:
            best, bk = red, k
    return bk


@pytest.mark.parametrize("with_face", [False, True])
def test_turn_k_shifts_with_the_scenes_turn(with_face):
    page = page_picture()
    got = {}
    for k in range(4):
        frame, _, dst = frame_with(page, k)
        t = truth_of(dst)
        res, _ = pr.cut_scene(frame, [t], shot_of([t]), red_turn if with_face else (lambda cut: -1), random.Random(1))
        d = res["docs"][0]
        assert d["cutBy"] == "phone" and d["iou"] > 0.95
        got[k] = (d["turnK"], d["faceK"], d["crop"])
    for k in range(4):
        turn, face, crop = got[k]
        if with_face:
            assert face == (got[0][1] - k) % 4 == (-k) % 4 and turn == 0   # the face's turn takes the geometry's over
        else:
            assert face == -1 and turn == (got[0][0] - k) % 4 == (-k) % 4
        upright = phone.turned(crop, turn)   # the crop turned by turn_k: the red block at its top-left
        assert red_turn(upright) == 0


def test_a_field_box_lands_within_half_a_pixel_on_a_cut_by_corners_a_little_off():
    pw, ph = 400, 250
    page = np.full((ph, pw), 255.0, np.float32)
    box = [(100.0, 80.0), (300.0, 80.0), (300.0, 160.0), (100.0, 160.0)]   # pixel centres
    yy, xx = np.mgrid[0:ph, 0:pw].astype(np.float32)
    for x, y in box:
        page -= 200 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 2.5 ** 2))
    W, H = 900, 700
    dst = np.float32([[150, 120], [760, 160], [720, 600], [180, 560]])
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw - 1, 0], [pw - 1, ph - 1], [0, ph - 1]]), dst)
    frame = cv2.warpPerspective(page, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=120)
    frame = np.repeat(np.clip(frame + 0.5, 0, 255).astype(np.uint8)[..., None], 3, 2)
    field = cv2.perspectiveTransform(np.float32([box]), M)[0] + 0.5   # the field in the frame, pixel edges
    corners = cv2.perspectiveTransform(np.float32([[[-0.5, -0.5], [pw - 0.5, -0.5], [pw - 0.5, ph - 0.5], [-0.5, ph - 0.5]]]), M)[0] + 0.5
    q01 = [[float(x) / W, float(y) / H] for x, y in corners]
    rng = np.random.default_rng(3)
    off = [[x + rng.uniform(-6, 6) / W, y + rng.uniform(-6, 6) / H] for x, y in q01]   # the model's corners, a little off
    t = {**truth_of(corners), "quad01": q01, "quadDoc": q01, "quadModel": q01,
         "fields": [{"role": "idNo", "kind": "idNo", "text": "x", "quad": field.tolist()}]}
    t["quadModel"] = q01
    res, _ = pr.cut_scene(frame, [t], lambda f: {"shot": True, "quads": [off], "how": ["cap"]}, lambda cut: -1, random.Random(0))
    d = res["docs"][0]
    assert d["cutBy"] == "phone" and d["turnK"] == 0
    grey = d["crop"][..., 0].astype(np.float64)
    worst = 0.0
    for (ex, ey) in d["fields"][0]["quad"]:
        cx, cy = ex - 0.5, ey - 0.5   # pixel centres
        x0, y0 = int(round(cx)) - 9, int(round(cy)) - 9
        win = 255.0 - grey[y0:y0 + 19, x0:x0 + 19]
        win[win < 8] = 0
        ys, xs = np.mgrid[y0:y0 + 19, x0:x0 + 19]
        mx, my = float((win * xs).sum() / win.sum()), float((win * ys).sum() / win.sum())
        worst = max(worst, float(np.hypot(mx - cx, my - cy)))
    assert worst < 0.5, worst
    b = d["fields"][0]["box"]
    assert 0 < b[0] < 1 and 0 < b[1] < 1 and b[2] > 0.3 and b[3] > 0.2


def test_turn_points_and_the_turn_of_a_cut():
    pts, size = pr.turn_points([[0, 0], [10, 0]], (10, 4), 1)
    assert size == (4, 10) and pts.tolist() == [[4, 0], [4, 10]]
    doc = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.6], [0.2, 0.6]]
    for r in range(4):
        assert pr.turn_of(doc[r:] + doc[:r], doc) == r


# ---------- what is kept ----------
def item(i, docs):
    return {"index": i, "entry": {"doctype": [{"doc": j, "file": f"doctype/img/{i}-{j}.jpg"} for j, _, _ in docs]},
            "files": [f"doctype/img/{i}-{j}.jpg" for j, _, _ in docs],
            "meta": {"labels": {"docs": [{"j": j, "cutBy": c, "iou": v, "kept": True} for j, c, v in docs]}}}


def test_the_editor_and_bad_cuts_stay_within_their_caps(tmp_path):
    rng = random.Random(4)
    items = []
    for i in range(300):
        docs = []
        for j in range(rng.randint(1, 3)):
            r = rng.random()
            docs.append((j, "editor", 0.9) if r < 0.35 else (j, "phone", 0.7) if r < 0.6 else (j, "phone", 0.95))
        items.append(item(i, docs))
    for cap, bad in ((0.15, 0.1), (0.0, 0.0), (0.3, 0.05)):
        out = set(pr.decide(items, cap, bad))
        kept = [(it["index"], d) for it in items for d in it["meta"]["labels"]["docs"] if f"{it['index']}:{d['j']}" not in out]
        editor = sum(d["cutBy"] == "editor" for _, d in kept)
        bads = sum(d["cutBy"] == "phone" and d["iou"] < pr.GOOD_IOU for _, d in kept)
        assert editor <= cap * len(kept) + 1e-9 and bads <= bad * len(kept) + 1e-9
        assert not any(k for k in out if next(d for d in items[int(k.split(':')[0])]["meta"]["labels"]["docs"]
                                                if d["j"] == int(k.split(":")[1]))["iou"] >= pr.GOOD_IOU
                       and next(d for d in items[int(k.split(':')[0])]["meta"]["labels"]["docs"]
                                if d["j"] == int(k.split(":")[1]))["cutBy"] == "phone")   # a good phone cut is never dropped
    it = item(7, [(0, "phone", 0.95), (1, "editor", 0.9)])
    (tmp_path / "doctype" / "img").mkdir(parents=True)
    for f in it["files"]:
        (tmp_path / f).write_bytes(b"x")
    pr.drop(it, {"7:1"}, tmp_path)
    assert it["files"] == ["doctype/img/7-0.jpg"] and not (tmp_path / "doctype/img/7-1.jpg").exists()
    assert [e["doc"] for e in it["entry"]["doctype"]] == [0] and [d["kept"] for d in it["meta"]["labels"]["docs"]] == [True, False]


# ---------- the cache ----------
class StubPool:
    def __init__(self):
        from PIL import Image
        self.Image = Image

    def page(self, rng, F, kind):
        from gen import pages as gp
        w, h, ppm = (856, 540, 10) if kind != "sefach" else (1500, 2100, 10)
        im = self.Image.new("RGBA", (w, h), (235, 235, 230, 255))
        return gp.Page(im, (w / ppm, h / ppm), "id_front" if kind != "sefach" else "sefach", kind, "card" if kind != "sefach" else "paper",
                       [("idNo", "123456782", gp.as_quad((500, 400, 300, 50)))], None, None, "drawn", (0, 0, w, h), ppm)

    def any(self, rng, F, kinds=None):
        return self.page(rng, F, rng.choice(("id_front", "sefach")))


class StubFonts:
    def used(self):
        return []


def batch_params(edges="a" * 64):
    return {"seed": 5, "count": 3, "split": "train", "held": False, "weights": {"single": 1.0, "pair": 0.0, "card_on_sheet": 0.0, "painted": 0.0, "none": 0.0, "partial": 0.0}, "models": ["doctype", "face"],
            "edgesSha": edges, "faceSha": "f" * 64, "editorCap": 0.15, "badShare": 0.1, "real": [], "out": "x"}


def test_a_second_drawing_comes_from_the_cache_and_another_edges_model_does_not(tmp_path, monkeypatch):
    import home
    from gen.outputs import edges as ge
    monkeypatch.setattr(home, "WORK", tmp_path / "home")
    monkeypatch.setattr(ge, "tools", lambda params: (StubFonts(), StubPool(), None, None))
    calls = {"shot": 0, "face": 0}

    def shot(self, frame):
        calls["shot"] += 1
        pr.Lab.runs += 1
        return {"shot": True, "quads": [[[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]], "how": ["cap"]}

    def face(self, cut):
        calls["face"] += 1
        pr.Lab.runs += 1
        return -1
    monkeypatch.setattr(pr.Lab, "shot", shot)
    monkeypatch.setattr(pr.Lab, "face", face)

    def draw(folder, params):
        pr.gen_prepare(folder, params)
        out = pr._batch((params, [0, 1, 2], str(folder)))
        return out, {f: (folder / f).read_bytes() for it in out for f in it["files"]}
    a, files_a = draw(tmp_path / "a", batch_params())
    n = dict(calls)
    assert n["shot"] == 3 and sum(it["runs"] for it in a) > 0
    b, files_b = draw(tmp_path / "b", batch_params())
    assert calls == n and sum(it["runs"] for it in b) == 0            # the second drawing: no model ran
    assert files_a == files_b and [it["meta"] for it in a] == [it["meta"] for it in b]
    c, _ = draw(tmp_path / "c", batch_params(edges="b" * 64))
    assert calls["shot"] == n["shot"] + 3                             # another edges model: drawn again, its own folder
    assert pr.Cache(batch_params()).dir != pr.Cache(batch_params(edges="b" * 64)).dir
    from gen import scene as gs
    render = gs.render

    def drawn_otherwise(sc, rng=None, effects=True):   # the scene code changed: another frame for the same params
        f = render(sc, rng, effects)
        f[0, 0] = 255 - f[0, 0]
        return f
    monkeypatch.setattr(gs, "render", drawn_otherwise)
    shots = calls["shot"]
    d, _ = draw(tmp_path / "d", batch_params())
    assert calls["shot"] == shots + 3 and sum(it["runs"] for it in d) > 0   # the cached answers were for other frames
    monkeypatch.setattr(gs, "render", render)
    assert pr.run_key({**batch_params(), "out": "y", "dropped": ["1:0"]}) == pr.run_key(batch_params())
    assert all(it["meta"]["labels"]["edgesSha"] == "a" * 16 for it in a)   # the edges model is in every row's labels


def test_the_pages_are_cut_from_the_frame_at_its_native_size(tmp_path, monkeypatch):
    import home
    from gen import scene as gs
    from gen.camera import Camera
    from gen.outputs import edges as ge
    cam = Camera(1600, 900, (1920, 1080), 70.0, (0.0, 0.0), 300.0, 10.0, 30.0, 2.0)
    sc = gs.Scene("single", [], cam, {})
    big = pr.native_scene(sc).cam
    assert (big.W, big.H) == (1920, 1080) and pr.native_scene(gs.Scene("single", [], big, {})).cam is big
    pts = np.array([[10.0, -20.0], [-35.0, 15.0], [0.0, 0.0]])
    assert np.allclose(big.project(pts), cam.project(pts) * 1.2)   # the same view: 0..1 corners stay, pixels scale
    monkeypatch.setattr(home, "WORK", tmp_path / "home")
    monkeypatch.setattr(ge, "tools", lambda params: (StubFonts(), StubPool(), None, None))
    frames = []

    def shot(self, frame):
        frames.append(frame.shape)
        return {"shot": True, "quads": [], "how": []}
    monkeypatch.setattr(pr.Lab, "shot", shot)
    monkeypatch.setattr(pr.Lab, "face", lambda self, cut: -1)
    params = {**batch_params(), "count": 4}
    pr.gen_prepare(tmp_path / "run", params)
    out = pr._batch((params, [0, 1, 2, 3], str(tmp_path / "run")))
    cams = [it["meta"]["camera"] for it in out if it["meta"].get("camera")]
    assert cams and len(frames) == len(cams)
    for (h, w, _), c, it in zip(frames, cams, [it for it in out if it["meta"].get("camera")]):
        assert [w, h] == c["native"] == c["size"] == it["meta"]["labels"]["frame"]   # the lab's frame, not RENDER_MAX
        assert max(w, h) in (1920, 1280, 4000) and it["meta"]["labels"]["cutFrom"] == "native"


def test_the_exam_and_training_sides_of_the_real_attempts_stay_apart(tmp_path):
    rows = []
    for k, (exam, hard, split) in enumerate([(True, False, "exam"), (False, False, "train"), (False, True, "train"),
                                             (False, False, "none"), (True, True, "exam")]):
        f = tmp_path / f"{k}.jpg"
        f.write_bytes(b"x")
        rows.append({"file": str(f), "attempt": True, "fixed": UNIT_Q, "exam": exam, "hard": hard, "split": split, "key": f"k{k}"})
    (tmp_path / "examples.json").write_text(json.dumps(rows), encoding="utf-8")
    exam = pr.real_scenes(tmp_path, True, 10)
    train = pr.real_scenes(tmp_path, False, 10)
    assert [e["key"] for e in exam] == ["k0", "k4"]       # the exam's attempts only, hard or not
    assert [e["key"] for e in train] == ["k1"]            # only what trains: not the exam's, not hard, not split none


UNIT_Q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]


def test_train_doctypes_refuses_a_cuts_run_of_the_exam(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    pytest.importorskip("timm")
    pytest.importorskip("onnxruntime")
    import importlib.util
    import types
    spec = importlib.util.spec_from_file_location("train_doctypes_ex", HERE / "train_doctypes.py")
    td = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(td)
    monkeypatch.setattr(td, "WORK", tmp_path / "home")
    monkeypatch.setattr(td, "require_qa", lambda *a, **k: None)   # its QA passed: the guard is the split
    monkeypatch.setattr(td, "assert_clean", lambda *a, **k: None)

    def run(name, split, entry_split=None):
        r = tmp_path / name
        (r / "doctype" / "img").mkdir(parents=True)
        e = {"id": "cut-1-0-d0", "file": "doctype/img/0-0.png", "doctype": "id_front", "turn_k": 0, "split": entry_split or split,
             "exam": (entry_split or split) == "exam"}
        (r / "doctype" / "pages.json").write_text(json.dumps([e]), encoding="utf-8")
        (r / "run.json").write_text(json.dumps({"model": "cuts", "split": split}), encoding="utf-8")
        return r
    with pytest.raises(SystemExit, match="not a training run"):
        td.gather(types.SimpleNamespace(synth=5, synth_run=str(run("cuts-exam", "exam"))))
    with pytest.raises(SystemExit, match="exam's side"):
        td.gather(types.SimpleNamespace(synth=5, synth_run=str(run("cuts-mixed", "train", "exam"))))
    got = td.gather(types.SimpleNamespace(synth=5, synth_run=str(run("cuts-train", "train"))))
    assert [e["id"] for e in got] == ["cut-1-0-d0"]


# ---------- the writers ----------
def doc_result(turn=0, fields=None, size=(856, 540), doctype="id_front", mrz=None):
    crop = np.full((size[1], size[0], 3), 230, np.uint8)
    t = {"doctype": doctype, "kind": doctype, "source": "drawn", "pageId": "drawn:x", "templateSha1": None, "seen": True,
         "role": "answer", "mrz": mrz, "face": None}
    return {"docs": [{"j": 0, "id": "cut-5-0-d0", "cutBy": "phone", "iou": 0.97, "cornerErr": 0.01, "how": "cap", "faceK": -1,
                      "geomTurn": turn, "turnK": turn, "cut": crop, "crop": crop, "size": list(size), "fields": fields or [],
                      "face": None, "truth": t}]}


def test_the_hebrew_writer_cuts_by_the_layout_and_writes_layout_overflow(tmp_path):
    from gen.outputs import he
    lay = he.layouts()
    name = sorted(lay)[0]
    fields = []
    for b in lay[name]:
        x, y, w, h = b["box"]
        fields.append({"role": b["role"], "kind": b["role"], "text": "123456782" if b["role"] == "idNo" else "כהן",
                       "box": [x - 0.02, y + 0.01, w + 0.03, h], "quad": []})
    (tmp_path / "he" / "img").mkdir(parents=True)
    ctx = {"index": 3, "edgesSha": "a" * 64, "split": "train", "fontSplit": "train"}
    ents, files = he.write(tmp_path, doc_result(0, fields), ctx)
    crops = [e for e in ents if e.get("file")]
    assert files and len(crops) == len(lay[name]) and all((tmp_path / f).exists() for f in files)
    assert {e["layout"] for e in crops} == {name} and all(e["pageType"] == "id_front" for e in crops)
    e = crops[0]
    assert e["overflow"]["left"] > 0 and e["overflow"]["top"] == 0
    ents2, files2 = he.write(tmp_path, doc_result(1, fields), ctx)   # a card the face did not set upright: skipped
    assert not files2 and ents2[0]["why"] == "notUpright"
    summary = he.finish(tmp_path, ents + ents2, {})
    over = json.loads((tmp_path / "he" / "layout_overflow.json").read_text(encoding="utf-8"))
    assert over["percentile"] == 99 and over["n"] == len(crops) and over["x"] > 0 and set(over["all"]) == {"left", "right", "top", "bottom"}
    assert summary["skipped"] == {"notUpright": 1}
    cols = (tmp_path / "he" / "labels.tsv").read_text(encoding="utf-8").splitlines()[0].split("\t")
    assert len(cols) == 10 and cols[4] == "id_front" and cols[5] in {b["role"] for b in lay[name]} and cols[9] == "cut-5-0-d0"


def test_the_doctype_square_is_drawn_from_the_full_cut_as_the_phone_draws_it(tmp_path):
    from gen.outputs import doctype
    rng = np.random.default_rng(3)
    res = doc_result(0, size=(1730, 1090))
    crop = rng.integers(0, 256, (1090, 1730, 3)).astype(np.uint8)
    crop[200:600, 300:900] = (20, 60, 200)
    res["docs"][0]["crop"] = res["docs"][0]["cut"] = crop
    (tmp_path / "doctype" / "img").mkdir(parents=True)
    kernels = set()
    for seed in range(12):
        ctx = {"seed": seed, "index": 4, "edgesSha": "a" * 64, "split": "train", "cutFrom": "native"}
        ents, files = doctype.write(tmp_path, res, ctx)
        e = ents[0]
        img = cv2.imread(str(tmp_path / e["file"]))
        assert e["file"].endswith(".png") and img.shape == (256, 256, 3) and e["cut_size"] == [1730, 1090] and e["cut_from"] == "native"
        want = phone.doctype_input(crop, bgr=True, kernel=e["kernel"])     # index.html doctypeAnswer on the full cut
        assert np.array_equal(np.ascontiguousarray(img[..., ::-1].transpose(2, 0, 1)).astype(np.float32) / 255.0, want)
        assert e["kernel"] == phone.kernel_for("capture", doctype.kernel_rng(ctx, 0))   # its own stream: the same every drawing
        kernels.add(e["kernel"])
    assert kernels <= set(phone.KERNELS)


def test_the_zone_writer_counts_what_it_did_not_find(tmp_path):
    from gen.outputs import mrz
    (tmp_path / "mrz" / "img").mkdir(parents=True)
    l1, l2 = "P<ISRCOHEN<<DAVID" + "<" * 27, "1234567897ISR8001014M3001012" + "<" * 14 + "04"
    ctx = {"index": 0, "edgesSha": "a" * 64, "split": "train"}
    ents, files = mrz.write(tmp_path, doc_result(0, [], (1250, 880), "passport", f"{l1}\n{l2}"), ctx)   # a blank page: no zone
    assert not files and ents[0]["found"] == 0 and ents[0]["why"] == "none" and ents[0]["td3"]
    ents2, _ = mrz.write(tmp_path, doc_result(2, [], (1250, 880), "passport", f"{l1}\n{l2}"), ctx)
    assert ents2[0]["why"] == "notUpright"
    s = mrz.finish(tmp_path, ents + ents2, {})
    assert s["passports"] == 2 and s["failed"] == {"none": 1, "notUpright": 1} and s["ok"] == 0
    assert mrz._hit({"x": 10, "y": 100, "w": 500, "h": 30}, [[20, 105], [480, 105], [480, 125], [20, 125]])
    assert not mrz._hit({"x": 10, "y": 100, "w": 500, "h": 30}, [[20, 140], [480, 140], [480, 160], [20, 160]])


# ---------- train_doctypes: the turn loss over the known samples only ----------
def test_the_turn_loss_is_averaged_over_the_known_samples_only():
    torch = pytest.importorskip("torch")
    pytest.importorskip("timm")
    pytest.importorskip("onnxruntime")
    import importlib.util
    spec = importlib.util.spec_from_file_location("train_doctypes_pr", HERE / "train_doctypes.py")
    td = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(td)
    torch.manual_seed(0)
    logits = torch.randn(6, 4)
    target = torch.tensor([0, 3, td.TURN_IGNORE, 1, td.TURN_IGNORE, 2])
    known = target != td.TURN_IGNORE
    got = td.turn_loss(logits, target, known)
    want = torch.nn.functional.cross_entropy(logits[known], target[known])
    assert torch.allclose(got, want)
    # an unknown sample's logits never move the loss
    logits2 = logits.clone()
    logits2[2] = 100 * torch.randn(4)
    assert torch.allclose(td.turn_loss(logits2, target, known), got)
    none = td.turn_loss(logits, torch.full((6,), td.TURN_IGNORE), torch.zeros(6, dtype=torch.bool))
    assert float(none) == 0.0 and not torch.isnan(none)
    # who counts as known: made-up and phone-cut pages; a real copy only by the face or the owner
    assert td.turn_known({"synthPage": True}) and td.turn_known({"turn_k": 2}) and not td.turn_known({"turn_k": None})
    assert td.turn_known({"turnBy": "face"}) and td.turn_known({"turnBy": "owner"}) and td.turn_known({"turnFixed": 1})
    assert not td.turn_known({"turnBy": "haiku"}) and not td.turn_known({"turnBy": "model"}) and not td.turn_known({})
    # a phone-cut page that needs 2 turns, shown turned k more: its answer is (2 - k) % 4
    assert [td.turn_answer(k, True, 2) for k in range(4)] == [2, 1, 0, 3]


def test_which_models_go_through_the_phones_cut():
    from gen.build import cut_models
    assert cut_models("doctype,mrz,he,face") == ["doctype", "mrz", "he", "face"]
    assert cut_models("mrz") == ["mrz"] and cut_models("face") == ["face"] and cut_models("cuts") == list(pr.OUTPUTS)
    assert cut_models("doctype") is None and cut_models("he") is None and cut_models("edges") is None   # today's generators
    assert cut_models("doctype", force=True) == ["doctype"]
    with pytest.raises(SystemExit):
        cut_models("edges,doctype")
