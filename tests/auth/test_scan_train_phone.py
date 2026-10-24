"""The phone mirror (scripts/scan-train/gen/phone.py; docs/scan-training.md → "The phone mirror"): exact ports of what
the scanner lab does to a picture before a model sees it. The parity fixtures tests/scan/phone_parity.json are written
from phone.py once (`python tests/auth/test_scan_train_phone.py --write`) and checked twice: here (phone.py still gives
them) and by tests/scan/phone_parity.test.mjs (the lab's own scan-core.js corners / warpRGBA and index.html mrzFind give
them too, in both copies, scan-lab/ and scan/). The resamplers are measured against Chromium by
tests/e2e/phone-parity.test.js; here, against OpenCV where they must agree, and the profile's fit on a made-up probe."""
import json
import math
import pathlib
import random
import sys

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = ROOT / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

from gen import phone  # noqa: E402
import docfind  # noqa: E402
import mrzmodel  # noqa: E402

FIXTURE = ROOT / "tests" / "scan" / "phone_parity.json"
H, SIGMA = 128, 2.4


# ---------- the fixtures (written once from phone.py) ----------

def _maps(spots, noise=None):
    ys, xs = np.mgrid[0:H, 0:H].astype(np.float64)
    hm = np.zeros((4, H, H))
    for k, spot in enumerate(spots):
        for x, y, a in spot:
            hm[k] = np.maximum(hm[k], a * np.exp(-((xs - (x * H - 0.5)) ** 2 + (ys - (y * H - 0.5)) ** 2) / (2 * SIGMA ** 2)))
    if noise is not None:
        hm = np.maximum(hm, noise)
    return np.round(hm * 255).astype(np.uint8)   # stored in 8 bits: the same float32 map on both sides (u8 / 255)


def _hm(u8):
    return (u8.astype(np.float64) / 255).astype(np.float32)


HEATMAPS = {
    "two documents": [[(0.07, 0.29, 0.70), (0.21, 0.59, 0.63)], [(0.80, 0.58, 0.89)], [(0.80, 0.78, 0.80)],
                      [(0.21, 0.75, 0.77), (0.04, 0.84, 0.48)]],
    "card above": [[(0.04, 0.44, 0.94), (0.29, 0.18, 0.88)], [(0.78, 0.17, 0.92), (0.98, 0.43, 0.91)],
                   [(0.99, 0.96, 0.81)], [(0.03, 0.98, 0.64)]],
    "one document": [[(0.10, 0.12, 0.9)], [(0.90, 0.15, 0.8)], [(0.88, 0.85, 0.85)], [(0.12, 0.88, 0.9)]],
    "a corner missing": [[(0.10, 0.12, 0.9)], [(0.90, 0.15, 0.8)], [(0.88, 0.85, 0.17)], [(0.12, 0.88, 0.9)]],
    "edge spots": [[(0.003, 0.004, 0.95)], [(0.997, 0.01, 0.9), (0.6, 0.02, 0.6)], [(0.99, 0.995, 0.7)], [(0.0, 0.99, 0.66)]],
}


def _random_heatmaps(n=6, seed=5):
    rng = np.random.default_rng(seed)
    out = {}
    for i in range(n):
        spots = [[(float(rng.uniform(0, 1)), float(rng.uniform(0, 1)), float(rng.uniform(0.3, 0.98)))
                  for _ in range(int(rng.integers(1, 5)))] for _ in range(4)]
        noise = np.zeros((4, H, H))
        for k in range(4):   # a few weak blobs, some joined to a spot (the blob walk's window)
            for _ in range(int(rng.integers(0, 6))):
                y, x = int(rng.integers(0, H - 8)), int(rng.integers(0, H - 8))
                noise[k, y:y + int(rng.integers(2, 8)), x:x + int(rng.integers(2, 8))] = rng.uniform(0.28, 0.5)
        out[f"random {i}"] = (spots, noise)
    return out


def _warp_image(seed=7):
    rng = np.random.default_rng(seed)
    h, w = 48, 64
    ys, xs = np.mgrid[0:h, 0:w]
    img = np.zeros((h, w, 4), np.uint8)
    img[..., 0] = (xs * 4) % 256
    img[..., 1] = (ys * 5) % 256
    img[..., 2] = ((xs + ys) * 3 + rng.integers(0, 3, (h, w))) % 256
    img[..., 3] = 255
    return img


WARPS = {
    "a quad": [[0.12, 0.1], [0.86, 0.16], [0.8, 0.9], [0.08, 0.82]],
    "turned": [[0.5, 0.05], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]],
    "partly outside": [[-0.1, -0.05], [0.7, 0.02], [1.15, 1.1], [0.1, 0.8]],
    "the whole picture": [[0, 0], [1, 0], [1, 1], [0, 1]],
    "small": [[0.4, 0.4], [0.47, 0.41], [0.46, 0.5], [0.41, 0.49]],
}


def _zone_page(edge=False, specks=False, w=420, h=300, letters=14, gap=10):
    page = np.full((h, w), 228, np.uint8)
    if specks:   # a fixed texture and specks: the lines must still be the zone's
        ys, xs = np.mgrid[0:h, 0:w]
        page = (page.astype(int) - (xs * 7 + ys * 13) % 9).astype(np.uint8)
        for k in range(60):
            y, x = (k * 37) % (h - 3), (k * 101) % (w - 3)
            page[y:y + 2, x:x + 3] = 40
    for y in (int(h * 0.74), int(h * 0.74) + letters + gap):
        for x in range(18, w - 24, 9):
            page[y:y + letters, x:x + 6] = 22
    if edge:
        page[h - 5:] = 25
    page[int(h * 0.2):int(h * 0.2) + 10, 30:200] = 60   # a line of the page's text above: not the zone
    return page


ZONES = {"two lines": {}, "with the page's dark edge": {"edge": True}, "texture and specks": {"specks": True},
         "tall letters": {"letters": 20, "gap": 12, "h": 360}}


def _box(b):
    return [int(b["x"]), int(b["y"]), int(b["w"]), int(b["h"])]


# More documents on one photo (index.html findNext / findInside): the model's answers scripted in call order, so the
# lab's own findNext / findInside (run with a stub canvas and engine) and docfind's must make the same calls and take
# the same frame. A 400 × 300 photo; each case: the first document found (or none) and the answers.
PW, PH = 400, 300
FIRST = [[0.05, 0.05], [0.5, 0.05], [0.5, 0.6], [0.05, 0.6]]
NEXTS = {
    "a sliver beside the first (old rule: taken)": (FIRST, [([[0.55, 0.1], [0.95, 0.1], [0.95, 0.9], [0.9, 0.9]], 0.9)]),
    "a long card, 4.8 : 1 (old rule: dropped)": (FIRST, [([[0.55, 0.3], [0.98, 0.3], [0.98, 0.42], [0.55, 0.42]], 0.9)]),
    "a triangle": (FIRST, [([[0.6, 0.1], [0.95, 0.1], [0.95, 0.1], [0.7, 0.8]], 0.9)]),
    "the first again, then on the margin": ([[0.05, 0.1], [0.45, 0.1], [0.45, 0.9], [0.05, 0.9]],
                                            [([[0.06, 0.1], [0.45, 0.11], [0.44, 0.9], [0.05, 0.88]], 0.9), (None, 0.0),
                                             ([[0.55, 0.05], [0.95, 0.05], [0.95, 0.7], [0.55, 0.7]], 0.8)]),
    "a corner missing, unsure, then a strip": ([[0.05, 0.05], [0.6, 0.05], [0.6, 0.5], [0.05, 0.5]],
                                               [(None, 0.0), ([[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]], 0.3), (None, 0.0),
                                                (None, 0.0), ([[0.1, 0.2], [0.6, 0.2], [0.6, 0.8], [0.1, 0.8]], 0.9)]),
    "nothing found yet": ([], [(None, 0.0), (None, 0.0), ([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]], 0.9)]),
    "nothing anywhere": (FIRST, []),
}
PAGE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
CARD = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.6], [0.3, 0.6]]
TURNED = [[0.5, 0.05], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]]
INSIDES = {
    "a card on its page": (PAGE, CARD, 0.9, []),
    "too big (64 %)": (PAGE, PAGE, 0.9, []),
    "a sliver": (PAGE, [[0.2, 0.3], [0.9, 0.3], [0.9, 0.4], [0.2, 0.4]], 0.9, []),
    "unsure": (PAGE, CARD, 0.4, []),
    "found already": (PAGE, CARD, 0.9, [[[0.34, 0.34], [0.66, 0.34], [0.66, 0.58], [0.34, 0.58]]]),
    "on a turned page": (TURNED, [[0.2, 0.25], [0.6, 0.2], [0.65, 0.55], [0.25, 0.6]], 0.9, []),
}


class _Scripted:
    """docfind.detect replaced by the scripted answers, in call order (then nothing): records which model was asked."""

    def __init__(self, answers):
        self.answers, self.calls = list(answers), []

    def __enter__(self):
        self.old = docfind.detect
        docfind.detect = self
        return self

    def __exit__(self, *_):
        docfind.detect = self.old

    def __call__(self, sess, img, resize=None):
        self.calls.append(sess)
        if not self.answers:
            return None, 0.0
        pts, conf = self.answers.pop(0)
        return (None if pts is None else np.array(pts, np.float64)), conf


def _q(q):
    return None if q is None else [[float(v) for v in p] for p in q]


def _quads(seed=11, n=12):
    rng = np.random.default_rng(seed)
    out = [(PAGE, PAGE), (PAGE, [[0.95, 0.95], [1.0, 0.95], [1.0, 1.0], [0.95, 1.0]]), (PAGE, CARD), (TURNED, PAGE),
           ([[-0.1, -0.05], [0.7, 0.02], [1.15, 1.1], [0.1, 0.8]], CARD), (FIRST, [[0.06, 0.1], [0.45, 0.11], [0.44, 0.9], [0.05, 0.88]])]
    for _ in range(n):
        c = rng.uniform(0.2, 0.8, (2, 2))
        r = rng.uniform(0.05, 0.4, (2, 2))
        ts = [sorted(rng.uniform(0, 2 * math.pi, 4)) for _ in range(2)]
        out.append(tuple([[float(c[k, 0] + r[k, 0] * math.cos(t)), float(c[k, 1] + r[k, 1] * math.sin(t))] for t in ts[k]]
                         for k in range(2)))
    return out


SHAPES = [(PAGE, 400, 300), (CARD, 400, 300), ([[0.2, 0.3], [0.9, 0.3], [0.9, 0.4], [0.2, 0.4]], 320, 240),
          ([[0.6, 0.1], [0.95, 0.1], [0.95, 0.1], [0.7, 0.8]], 400, 300), (TURNED, 400, 300), (TURNED, 100, 900),
          ([[0.55, 0.1], [0.95, 0.1], [0.95, 0.9], [0.9, 0.9]], 400, 300), ([[0.1, 0.1], [0.9, 0.1], [0.5, 0.15], [0.1, 0.9]], 400, 300)]
GOODS = [(PAGE, 0.9), (PAGE, 0.49), (None, 0.9), ([[0.1, 0.1], [0.12, 0.1], [0.12, 0.12], [0.1, 0.12]], 0.9),
         ([[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]], 0.9), ([[0.55, 0.3], [0.98, 0.3], [0.98, 0.42], [0.55, 0.42]], 0.6)]


def make_more_docs():
    """The fixtures of findNext / findInside (and their pieces) from docfind / gen/phone.py."""
    photo = np.full((PH, PW, 3), 120, np.uint8)
    nexts = []
    for name, (first, answers) in NEXTS.items():
        found = [first] if first else []   # the first document (none: nothing found yet)
        with _Scripted(answers) as sc:
            q = docfind.find_next(["cap", "live"], photo, [np.array(f, np.float64) for f in found], "capture", lab=True)
        nexts.append({"name": name, "w": PW, "h": PH, "found": found, "answers": [[a, c] for a, c in answers],
                      "calls": sc.calls, "q": _q(q)})
    insides = []
    for name, (q, pts, conf, others) in INSIDES.items():
        W, Hh, _ = phone.warp_size(PW, PH, q)
        with _Scripted([(pts, conf)]):
            c = docfind.find_inside("cap", photo, q, [np.array(q, np.float64)] + [np.array(o, np.float64) for o in others])
        insides.append({"name": name, "w": PW, "h": PH, "q": q, "pts": pts, "conf": conf, "others": others,
                        "W": W, "H": Hh, "c": _q(c)})
    return {"constants": {"INSIDE_MIN": phone.INSIDE_MIN, "INSIDE_MAX": phone.INSIDE_MAX, "MAX_DOCS": phone.LAB_MAX_DOCS},
            "nexts": nexts, "insides": insides,
            "ious": [{"a": a, "b": b, "iou": phone.lab_quad_iou(a, b)} for a, b in _quads()],
            "shapes": [{"q": q, "w": w, "h": h, "ok": phone.doc_shape(q, w, h)} for q, w, h in SHAPES],
            "goods": [{"pts": p, "conf": c, "ok": phone.lab_good_quad(p, c)} for p, c in GOODS]}


def make_fixtures():
    fx = {"about": "Written once from scripts/scan-train/gen/phone.py by tests/auth/test_scan_train_phone.py --write; "
                   "checked by that test and by tests/scan/phone_parity.test.mjs (the lab's scan-core.js and mrzFind).",
          "heatmaps": [], "warps": [], "zones": []}
    cases = {k: (v, None) for k, v in HEATMAPS.items()}
    cases.update(_random_heatmaps())
    for name, (spots, noise) in cases.items():
        u8 = _maps(spots, noise)
        hm = _hm(u8)
        pts, conf = phone.corners(hm)
        firsts = [s[0][0] if s else None for s, _ in (phone._spots(hm[k]) for k in range(4))]
        fx["heatmaps"].append({"name": name, "u8": phone.pack(u8), "pts": None if pts is None else pts.tolist(),
                               "firsts": firsts, "conf": float(conf)})
    img = _warp_image()
    fx["warpImage"] = phone.pack(img)
    for name, pts in WARPS.items():
        out = phone.warp_rgba(img, pts)
        fx["warps"].append({"name": name, "pts": pts, "out": phone.pack(out)})
    for name, kw in ZONES.items():
        page = _zone_page(**kw)
        fx["zones"].append({"name": name, "page": phone.pack(page), "boxes": [_box(b) for b in phone.mrz_find(page)],
                            "findBoxes": [[x0, y0, x1 - x0, y1 - y0] for x0, y0, x1, y1 in mrzmodel.find_boxes(page)]})
    fx["moreDocs"] = make_more_docs()
    return fx


def _fixtures():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


# ---------- the fixtures still come out of phone.py ----------

def test_the_parity_fixtures_are_phone_py():
    fx, now = _fixtures(), make_fixtures()
    for a, b in zip(fx["heatmaps"], now["heatmaps"]):
        assert a["pts"] == b["pts"] and a["firsts"] == b["firsts"] and a["conf"] == b["conf"], a["name"]
    for a, b in zip(fx["warps"], now["warps"]):
        assert np.array_equal(phone.unpack(a["out"]), phone.unpack(b["out"])), a["name"]
    for a, b in zip(fx["zones"], now["zones"]):
        assert a["boxes"] == b["boxes"] and a["findBoxes"] == b["findBoxes"], a["name"]
    assert len(fx["heatmaps"]) == len(now["heatmaps"]) and len(fx["zones"]) == len(now["zones"])
    assert fx["moreDocs"] == json.loads(json.dumps(now["moreDocs"]))


def test_the_more_documents_fixtures_say_what_they_test():
    m = _fixtures()["moreDocs"]
    got = {c["name"]: c for c in m["nexts"]}
    assert got["a sliver beside the first (old rule: taken)"]["q"] is None
    assert got["a long card, 4.8 : 1 (old rule: dropped)"]["q"] is not None
    assert got["a triangle"]["q"] is None and got["nothing anywhere"]["q"] is None
    assert got["the first again, then on the margin"]["calls"] == ["cap", "live", "cap"]
    assert got["a corner missing, unsure, then a strip"]["calls"] == ["cap", "live", "cap", "live", "cap"]
    assert got["nothing found yet"]["q"] is not None and got["nothing anywhere"]["calls"] == ["cap", "live", "cap", "live", "cap", "cap"]
    ins = {c["name"]: c for c in m["insides"]}
    assert ins["a card on its page"]["c"] is not None and ins["on a turned page"]["c"] is not None
    assert all(ins[k]["c"] is None for k in ("too big (64 %)", "a sliver", "unsure", "found already"))
    assert len({round(c["iou"], 3) for c in m["ious"]}) > 5
    assert {c["ok"] for c in m["shapes"]} == {True, False} and {c["ok"] for c in m["goods"]} == {True, False}


def test_corners_are_one_copy_and_pick_the_document():
    assert docfind.corners is phone.corners and docfind._spots is phone._spots
    fx = _fixtures()
    by = {c["name"]: c for c in fx["heatmaps"]}
    assert np.allclose(by["two documents"]["pts"], [[0.21, 0.59], [0.80, 0.58], [0.80, 0.78], [0.21, 0.75]], atol=0.01)
    assert by["a corner missing"]["pts"] is None and by["a corner missing"]["firsts"][2] is None


def test_the_zone_boxes_agree_with_mrzmodel_within_a_pixel():
    for z in _fixtures()["zones"]:
        assert len(z["boxes"]) == 2 == len(z["findBoxes"]), z["name"]
        for a, b in zip(z["boxes"], z["findBoxes"]):
            assert max(abs(p - q) for p, q in zip(a, b)) <= 1, (z["name"], a, b)
    edge = next(z for z in _fixtures()["zones"] if "edge" in z["name"])
    assert edge["boxes"][1][1] + edge["boxes"][1][3] < 300 - 4   # line 2 is the zone's, not the page's dark edge
    assert phone.mrz_find(np.full((300, 420), 228, np.uint8)) == [] and mrzmodel.find_lines(np.full((300, 420), 228, np.uint8)) == []


def test_the_warp_is_the_labs():
    img = _warp_image()
    out = phone.warp_rgba(img, WARPS["a quad"])
    W, Hh, _ = phone.warp_size(64, 48, WARPS["a quad"])
    assert out.shape == (Hh, W, 4) and (out[..., 3] == 255).all()
    part = phone.warp_rgba(img, WARPS["partly outside"])
    assert (part[..., 3] == 0).any() and (part[part[..., 3] == 0][:, :3] == 0).all()   # outside: 0, alpha too
    whole = phone.warp_rgba(img, WARPS["the whole picture"])
    assert whole.shape[:2] == (48, 64) and (whole[-1, :, 3] == 0).all() and (whole[:-1, :-1] == img[:-1, :-1]).all()
    assert phone.js_round(2.5) == 3 and phone.js_round(-2.5) == -2   # Math.round, not Python's round


# ---------- the resamplers ----------

def _frame(w=320, h=240, seed=3):
    rng = np.random.default_rng(seed)
    ys, xs = np.mgrid[0:h, 0:w]
    img = np.stack([(xs * 3 + ys) % 256, (ys * 2) % 256, rng.integers(0, 256, (h, w))], -1)
    return img.astype(np.uint8)


def test_bilinear_is_opencvs_linear_and_area_is_inter_area():
    f = _frame()
    for size in ((256, 256), (100, 70), (500, 400)):
        a = phone.resample(f, size, "bilinear").astype(int)
        b = cv2.resize(f, size, interpolation=cv2.INTER_LINEAR).astype(int)
        assert np.abs(a - b).max() <= 1, size
    assert np.array_equal(phone.resample(f, (64, 48), "area"), cv2.resize(f, (64, 48), interpolation=cv2.INTER_AREA))
    for k in phone.KERNELS:   # at the same size every kernel keeps the picture
        assert np.array_equal(phone.resample(f, (320, 240), k), f), k
    assert np.array_equal(phone.resample(f, (240, 180), "mipmap"), phone.resample(f, (240, 180), "bilinear"))  # < √2: no level
    assert phone.resample(f, (32, 32), "mipmap").shape == (32, 32, 3)
    assert np.array_equal(phone.resample(f, (640, 480), "high"), phone.resample(f, (640, 480), "cubic"))   # enlarged: the cubic


def test_the_profile_names_its_kernels():
    prof = phone.load_profile()
    assert prof["measured"] is False and phone.profile_id().startswith("default-mix:")
    assert phone.kernel_for("live") == "bilinear" and phone.kernel_for("high") == "high"   # the exams: the heaviest
    rng = random.Random(1)
    drawn = {phone.kernel_for("capture", rng) for _ in range(300)}
    assert drawn == set(phone.mix_kernels("capture")) and drawn <= set(phone.KERNELS)
    assert phone.kernel_for("live", rng, {"ops": {"live": {"kernel": "mipmap"}}}) == "mipmap"   # a measured profile
    assert phone.browser_kernel("chromium", "capture") == "bilinear" and phone.browser_kernel("safari", "live") is None
    with pytest.raises(ValueError):
        phone.frame_to_S(_frame(), "video")


def test_the_inputs_the_phone_makes():
    f = _frame(300, 200)
    assert phone.frame_to_S(f, "live").shape == (256, 256, 3)
    face = phone.face_input(f)               # letterboxed at the top-left, BGR
    assert face.shape == (3, 320, 320) and face.dtype == np.float32
    assert (face[:, 214:, :] == 0).all() and face[:, :213, :].any()
    red = np.zeros((40, 60, 3), np.uint8); red[..., 0] = 200
    assert phone.face_input(red)[2].max() == 200 and phone.face_input(red)[0].max() == 0
    assert phone.face_input(f, 1).shape == (3, 320, 320) and (phone.face_input(f, 1)[:, :, 214:] == 0).all()
    d = phone.doctype_input(red[..., ::-1].copy(), bgr=True)   # a BGR page → RGB 0..1, the aspect not kept
    assert d.shape == (3, 256, 256) and abs(float(d[0].max()) - 200 / 255) < 1e-6 and d[2].max() == 0
    line = phone.line_input(f, {"x": 10, "y": 20, "w": 160, "h": 20})
    assert line.shape == (1, 32, 512) and (line[0, :, 256:] > 0.9999).all() and line[0, :, :256].min() < 1
    assert phone.he_line(f, [0.1, 0.1, 0.005, 0.005]) is None and phone.he_line(f, [0.1, 0.1, 0.5, 0.1]).shape == (1, 32, 512)
    big = np.zeros((2000, 3000, 3), np.uint8)
    jpg, small = phone.store_attempt(big)
    assert small.shape[:2] == (1067, 1600) and cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR).shape == (1067, 1600, 3)
    assert phone.store_attempt(f)[1].shape == f.shape


def test_the_profile_is_fitted_to_a_browsers_outputs(tmp_path):
    frames = [_frame(640, 480, 1), _frame(480, 640, 2)]
    use = {"live": "mipmap", "capture": "nearest", "high": "cubic"}
    probe = {"browser": "test", "device": "made-up", "frames": []}
    for i, f in enumerate(frames):
        name = f"{i}.png"
        cv2.imwrite(str(tmp_path / name), f[..., ::-1])
        paths = {}
        for p in ("live", "capture", "doctype", "face", "he:0"):
            ref = phone.probe_reference(p, f, use[phone.PATH_OP[p.split(":")[0]]])
            if p in ("live", "capture"):
                a = np.concatenate([ref.astype(np.uint8), np.full((256, 256, 1), 255, np.uint8)], 2)
            elif p == "face":
                a = ref.astype(np.float32)
            else:
                a = (ref / 255).astype(np.float32)
            paths[p] = {"shape": list(a.shape), "dtype": str(a.dtype), "b64": __import__("base64").b64encode(a.tobytes()).decode()}
        probe["frames"].append({"name": name, "paths": paths})
    fit = phone.fit_profile(probe, tmp_path)
    assert {op: r["kernel"] for op, r in fit["ops"].items()} == use
    assert fit["ops"]["live"]["min"] >= 60 and fit["measured"] and fit["name"] == "test-made-up"


# ---------- docfind on the phone's path, and E4's shot ----------

class QuadModel:
    """A stand-in edges model: heatmaps peaking at a fixed quad (0..1), whatever the picture."""

    def __init__(self, quad, top=0.9):
        self.quad, self.top, self.seen = quad, top, []

    def get_inputs(self):
        return [type("I", (), {"name": "x"})()]

    def run(self, _, feeds):
        self.seen.append(feeds["x"].shape)
        ys, xs = np.mgrid[0:H, 0:H].astype(np.float32)
        hm = np.zeros((4, H, H), np.float32)
        for k, (x, y) in enumerate(self.quad):
            hm[k] = self.top * np.exp(-((xs - (x * H - 0.5)) ** 2 + (ys - (y * H - 0.5)) ** 2) / (2 * SIGMA ** 2))
        return [hm[None]]


def test_detect_takes_the_phones_path():
    m = QuadModel([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]])
    f = _frame()[..., ::-1].copy()
    a = docfind.model_input(f, None)
    assert a.shape == (256, 256, 3) and a.dtype == np.float32 and a.max() <= 1
    assert np.array_equal(docfind.model_input(f, "live"), docfind.model_input(f, "live:bilinear"))
    assert not np.array_equal(docfind.model_input(f, "live"), a)   # the phone's bilinear is not INTER_AREA
    pts, conf = docfind.detect(m, f, "capture")
    assert np.allclose(pts, m.quad, atol=0.01) and conf > 0.8 and m.seen[-1] == (1, 3, 256, 256)


def test_the_labs_shot_on_a_photo(monkeypatch):
    monkeypatch.setitem(sys.modules, "onnxruntime", None)   # as in CI: not installed (exam.py imports it only to run a model)
    monkeypatch.delitem(sys.modules, "exam", raising=False)
    from gen import exam_phone
    quad = [[0.05, 0.05], [0.95, 0.07], [0.93, 0.95], [0.07, 0.93]]   # 80 % of the photo: nothing lies on it
    lite, acc = QuadModel(quad, 0.7), QuadModel(quad, 0.95)
    f = _frame()[..., ::-1].copy()
    for path in ("phone", "area"):
        r = exam_phone.shot((lite, acc), f, path)
        assert r["shot"] and r["confirmed"] and r["found"] == 1 and r["next"] == 0 and r["inside"] == 0, path
    none = exam_phone.shot((QuadModel(quad, 0.1), acc), f, "phone")
    assert not none["shot"] and none["found"] == 0
    counts = exam_phone.shot_counts([r, none], [{"fixed": quad, "kind": "template:sefach+2"}, {"none": True, "fixed": None}])
    assert counts["shots"] == 1 and counts["pairs"] == {"n": 1, "bothFound": 0} and counts["none"] == {"n": 1, "shot": 0}
    assert counts["first"]["n"] == 1 and counts["first"]["mean"] < 0.01


def test_find_next_lab_drops_a_sliver_the_old_rule_takes():
    f = _frame()[..., ::-1].copy()
    first = [np.array(FIRST, np.float64)]
    sliver = QuadModel([[0.55, 0.1], [0.95, 0.1], [0.95, 0.9], [0.9, 0.9]])
    assert docfind.find_next(sliver, f, first, "capture", lab=True) is None
    assert docfind.find_next(sliver, f, first, "capture") is not None   # good_quad's 3 : 1 rule keeps it
    long_card = QuadModel([[0.55, 0.3], [0.98, 0.3], [0.98, 0.42], [0.55, 0.42]])
    assert docfind.find_next(long_card, f, first, "capture") is None
    q = docfind.find_next(long_card, f, first, "capture", lab=True)
    assert q is not None and np.allclose(q, long_card.quad, atol=0.01)


def test_the_labs_paint_colour_is_the_upper_middle():
    t = np.zeros((32, 32, 3), np.uint8)
    t[0, 1:] = 10   # with (0, 31) and (31, 0) counted again: 64 of the border's 128 values are 10, 64 are 0
    t[1:, 0] = 10
    assert phone.lab_border_colour(t) == [10, 10, 10]   # a.sort()[n >> 1]; np.median would give 5
    assert docfind.border_colour(t) == [5, 5, 5]
    big = np.repeat(np.repeat(t, 4, 0), 4, 1)
    assert phone.lab_border_colour(big, "nearest") == [10, 10, 10]


def test_find_inside_takes_a_card_on_its_page_back_onto_the_photo():
    page = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]
    card = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.6], [0.3, 0.6]]   # on the flat cut: 12 % of it
    c = docfind.find_inside(QuadModel(card), _frame()[..., ::-1].copy(), page, [np.array(page)])
    assert c is not None and np.allclose(c, [[0.34, 0.34], [0.66, 0.34], [0.66, 0.58], [0.34, 0.58]], atol=0.01)
    assert docfind.find_inside(QuadModel(page), _frame()[..., ::-1].copy(), page, [np.array(page)]) is None   # 64 %: too big
    assert phone.doc_shape(card, 100, 100) and not phone.doc_shape([[0, 0], [1, 0], [1, 0.01], [0, 0.01]], 100, 100)


def test_exam_sets_are_the_same_every_run(tmp_path, monkeypatch):
    from gen import exam_phone
    d = tmp_path / "synth" / "docs-exam"
    d.mkdir(parents=True)
    (d / "examples.json").write_text(json.dumps([{"id": f"syn-7-{i}", "file": f"C:\\x\\img\\{i}.jpg", "fixed": None, "none": True}
                                                  for i in range(30)]), encoding="utf-8")
    a, b = exam_phone.exam_sets(tmp_path, 10), exam_phone.exam_sets(tmp_path, 10)
    assert list(a) == ["templates"] and [e["id"] for e in a["templates"]] == [e["id"] for e in b["templates"]]
    assert all(e["file"] == str(d / "img" / e["file"].replace("\\", "/").rsplit("/", 1)[-1]) for e in a["templates"])


# ---------- training resamples like the phone ----------

def test_training_makes_the_256_input_like_the_phone():
    pytest.importorskip("torch")
    pytest.importorskip("onnx2torch")
    pytest.importorskip("timm")
    pytest.importorskip("onnxruntime")
    import train
    import train_doctypes
    f = _frame()[..., ::-1].copy()
    rng = random.Random(0)
    got = [train.model_input(f, "phone", rng) for _ in range(40)]
    assert all(g.shape == (256, 256, 3) for g in got)
    area = train.model_input(f, "area", rng)
    assert np.array_equal(area, cv2.cvtColor(cv2.resize(f, (256, 256), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB))
    assert len({g.tobytes() for g in got}) > 1   # live / capture and the mix's kernels: not one input
    sq = cv2.resize(f, (256, 256), interpolation=cv2.INTER_AREA)   # a site copy is 256 already: kept as it is
    assert np.array_equal(train_doctypes.square(sq, "phone", rng), cv2.cvtColor(sq, cv2.COLOR_BGR2RGB))


if __name__ == "__main__":
    if "--write" in sys.argv:
        FIXTURE.write_text(json.dumps(make_fixtures(), indent=1) + "\n", encoding="utf-8")
        print(f"wrote {FIXTURE}")
