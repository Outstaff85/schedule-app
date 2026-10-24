"""Scenes: flat pages with field boxes, one camera for the table and the documents (scripts/scan-train/gen/pages.py,
camera.py, scene.py, outputs/edges.py; docs/scan-training.md → "Scenes: one camera for the table and the documents").

- every drawn kind returns its field boxes inside the page, and a passport a TD3 zone whose check digits pass;
- the background and the documents go through ONE homography: a dot marked on the background and a page's corner land
  where the same camera puts them;
- the labels are where the pixels are: on 200 random scenes per recipe (single, pair, card on its ספח, painted, a bent
  page, a folded one) every page's corners and its field boxes, measured on the rendered edges (the 0.5 crossings of
  each side near the corner, two lines intersected), lie within 0.5 px of the labels;
- a card on its ספח is written as the flat cut of the outer page (the lab's findInside), never as a second answer on
  the frame; partial scenes have weight 0 by default;
- the next pictures and the painted recipe paint as the lab's findNext (gen/phone.py lab_paint: 4 % growth, the 32 × 32
  border ring's colour, an antialiased fill) on the final frame, after the light and the phone's effects;
- the table is drawn no coarser than the frame shows it (a photo's px/mm, a procedural surface's) at the point the
  camera looks at, so it is as sharp as the documents on it;
- no PyMuPDF: the PDF source is skipped and counted, another page drawn instead.
SCAN_SCENES (default 200) sets the scenes per recipe. No torch here."""
import json
import math
import os
import pathlib
import random
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")
pytest.importorskip("PIL")

from PIL import Image  # noqa: E402

from gen import camera as gcam  # noqa: E402
from gen import pages as gp  # noqa: E402
from gen import rng as grng  # noqa: E402
from gen import scene as gs  # noqa: E402

N = int(os.environ.get("SCAN_SCENES", "200"))
TOL = 0.5


# ---------- stub pages: the geometry of real ones, no drawing ----------
def stub_page(rng, kind):
    """A page of a kind's size with a few field boxes (integer pixel boxes, as the drawn ones are)."""
    if kind in ("id_front", "id_back"):
        w, h, ppm, material = 856, 540, 10, "card"
    elif kind == "passport":
        w, h, ppm, material = 1250, 880, 10, "booklet"
    elif kind == "sefach":
        w = int(rng.uniform(140, 210) * 10)
        h, ppm, material = int(w / rng.uniform(0.65, 1.6)), 10, "paper"
    else:
        w, h, ppm, material = 1050, 1485, 5, "paper"
    top = int(h * rng.uniform(0.6, 1.0)) if kind == "passport" and rng.random() < 0.6 else 0   # the booklet's other page
    im = Image.new("RGBA", (w, h + top), (255, 255, 255, 255))
    fields = []
    for _ in range(rng.randint(2, 4)):
        bw, bh = rng.randint(int(w * 0.2), int(w * 0.5)), rng.randint(int(h * 0.06), int(h * 0.14))
        x, y = rng.randint(10, w - bw - 10), rng.randint(10, h - bh - 10) + top
        fields.append(("text", "x", gp.as_quad((x, y, bw, bh))))
    doctype = {"insert": "other"}.get(kind, kind)
    return gp.Page(im, (w / ppm, h / ppm), doctype, kind, material, fields, None, None, "drawn", (0, top, w, top + h), ppm)


class StubPool:
    def page(self, rng, F, kind):
        return stub_page(rng, "insert" if kind == "other" else kind)

    def any(self, rng, F, kinds=None):
        return self.page(rng, F, rng.choice(("id_front", "id_back", "passport", "sefach", "contract", "insert")))


def scenes(recipe, n, force_bend=None, seed=11):
    out, i = [], 0
    while len(out) < n and i < n * 4:
        r = grng.streams(seed, i + (1000 * gs.RECIPES.index(recipe) if recipe in gs.RECIPES else 7777))
        i += 1
        sc = gs.plan(r, StubPool(), None, None, None, recipe=recipe, force_bend=force_bend)
        if sc is not None:
            out.append(sc)
    assert len(out) == n
    return out


# ---------- measuring the rendered edges ----------
def sample(img, pts):
    """Bilinear values of img (H × W float) at points in pixel edges (outside: 0)."""
    p = np.asarray(pts, np.float32)
    mx, my = (p[:, 0] - 0.5).reshape(-1, 1), (p[:, 1] - 0.5).reshape(-1, 1)
    return cv2.remap(img.astype(np.float32), mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0).ravel()


def crossing(img, p, nrm, span=3.5, step=0.02):
    s = np.arange(-span, span, step)
    v = sample(img, p[None] + s[:, None] * nrm[None])
    for k in range(len(v) - 1):
        if v[k] >= 0.5 > v[k + 1]:
            t = (v[k] - 0.5) / (v[k] - v[k + 1])
            return p + (s[k] + t * step) * nrm
    return None


def fit(points):
    P = np.asarray(points)
    c = P.mean(0)
    _, _, vt = np.linalg.svd(P - c)
    return c, vt[0]


def intersect(l1, l2):
    (p, u), (q, v) = l1, l2
    A = np.array([u, -v]).T
    t = np.linalg.solve(A, q - p)
    return p + t[0] * u


def measure(img, off, quad, k, near):
    """The corner k of quad as the rendered alpha (img, its top-left at off in the frame) shows it."""
    q = np.asarray(quad, np.float64) - np.asarray(off, np.float64)
    c, cen = q[k], q.mean(0)
    lines = []
    for other in (q[(k + 1) % 4], q[k - 1]):
        side = other - c
        L = np.linalg.norm(side)
        u = side / L
        nrm = np.array([-u[1], u[0]])
        if np.dot(nrm, c + side / 2 - cen) < 0:
            nrm = -nrm
        pts = [crossing(img, c + t * u, nrm) for t in np.linspace(near[0], min(near[1], 0.45 * L), 10)]
        pts = [p for p in pts if p is not None]
        if len(pts) < 5:
            return None
        lines.append(fit(pts))
    return intersect(*lines) + np.asarray(off, np.float64)


def window(cam, c, r=24):
    x, y = int(math.floor(c[0])), int(math.floor(c[1]))
    return (max(0, x - r), max(0, y - r), min(cam.W, x + r + 1), min(cam.H, y + r + 1))


def mask_rgba(page, quad=None):
    w, h = page.size_px
    a = np.zeros((h, w, 4), np.uint8)
    if quad is None:
        x0, y0, x1, y1 = page.rect
    else:
        q = np.asarray(quad)
        x0, y0, x1, y1 = int(round(q[:, 0].min())), int(round(q[:, 1].min())), int(round(q[:, 0].max())), int(round(q[:, 1].max()))
    a[y0:y1, x0:x1] = 255
    return a


def corner_errors(sc, d, label_quad, rgba, min_side=0.0):
    """The distance of each measured corner from its label (px), [] when the quad is too small to measure."""
    q = np.asarray(label_quad)
    sides = [np.linalg.norm(q[(k + 1) % 4] - q[k]) for k in range(4)]
    if min(sides) < min_side:
        return []
    errs = []
    prepared = gs.prepare(rgba)
    for k in range(4):
        c = q[k]
        if not (2 <= c[0] <= sc.cam.W - 2 and 2 <= c[1] <= sc.cam.H - 2):
            continue
        roi = window(sc.cam, c)
        got = gs.render_doc(sc.cam, d, roi=roi, prepared=prepared)
        assert got is not None
        _, _, alpha = got
        near = (1.5, 14.0) if min(sides) >= 30 else (1.0, 8.0)
        m = measure(alpha, roi[:2], q, k, near)
        if m is not None:
            errs.append(float(np.linalg.norm(m - c)))
    return errs


# ---------- drawn pages ----------
@pytest.fixture(scope="module")
def fonts():
    import synth_docs as sd
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    return sd.Fonts(sd.latin_fonts(), sd.hebrew_fonts())


@pytest.mark.parametrize("kind", ["id_front", "id_back", "passport", "sefach", "insert", "he_sheet", "contract"])
def test_each_drawn_kind_returns_its_field_boxes_inside_the_page(fonts, kind):
    for seed in range(6):
        p = gp.drawn(random.Random(seed), fonts, kind)
        w, h = p.size_px
        x0, y0, x1, y1 = p.rect
        assert p.doctype in ("id_front", "id_back", "passport", "sefach", "contract", "other")
        if kind != "contract":
            assert p.fields, kind
        for role, text, quad in p.fields:
            q = np.asarray(quad)
            assert q.shape == (4, 2) and role and text
            assert (q[:, 0] >= -1).all() and (q[:, 0] <= w + 1).all() and (q[:, 1] >= y0 - 1).all() and (q[:, 1] <= y1 + 1).all(), (kind, role)
            assert gs.poly_area(q) > 4
        if kind in ("id_front", "passport"):
            f = np.asarray(p.face_box)
            assert (f[:, 0] >= 0).all() and (f[:, 0] <= w).all() and (f[:, 1] >= y0).all() and (f[:, 1] <= y1).all()


def test_drawn_kinds_draw_the_same_pixels_as_before(fonts):
    """The boxes are measured, not drawn: synth_docs.DRAW still unpacks as (picture, rect) and draws the same bytes."""
    import synth_docs as sd
    for kind, fn in sd.DRAW.items():
        a = fn(random.Random(3), fonts)
        im, rect = a
        b = fn(random.Random(3), fonts, held=False)
        assert np.array_equal(np.asarray(im), np.asarray(b[0])) and rect == b[1]
        assert a.quad[0] == [rect[0], rect[1]]


def test_a_passport_returns_a_td3_zone_whose_check_digits_pass(fonts):
    import synth
    for seed in range(20):
        p = gp.drawn(random.Random(seed), fonts, "passport")
        l1, l2 = p.mrz_text.split("\n")
        assert len(l1) == len(l2) == 44 and l1[0] == "P"
        assert int(l2[9]) == synth.mrz_check(l2[0:9])
        assert int(l2[19]) == synth.mrz_check(l2[13:19])
        assert int(l2[27]) == synth.mrz_check(l2[21:27])
        assert int(l2[43]) == synth.mrz_check(l2[0:10] + l2[13:20] + l2[21:43])
        roles = {r for r, _, _ in p.fields}
        assert {"mrz1", "mrz2", "surname", "passportNo"} <= roles


def test_values_from_the_check_vocabulary_are_marked_unseen(fonts):
    import synth
    p = gp.drawn(random.Random(1), fonts, "id_front", held=True)
    assert p.seen is False
    words = {w for r, t, _ in p.fields if r in ("surname", "given") for w in t.split()}
    check = set(synth.vocab("surname", True)) | set(synth.vocab("given", True))
    assert words and words <= check


# ---------- one camera ----------
def test_the_camera_maps_the_plane_without_a_mirror_and_back():
    cam = gcam.Camera(1600, 1200, (1600, 1200), 70, (0.0, 0.0), 300, 30, 40, 5)
    pts = np.array([[-50.0, -30.0], [50.0, -30.0], [50.0, 30.0], [-50.0, 30.0]])
    uv = cam.project(pts)
    assert np.allclose(cam.back(uv), pts, atol=1e-6)
    H = cam.Hm
    P = np.column_stack([pts, np.ones(4)]) @ H.T
    assert np.allclose(P[:, :2] / P[:, 2:], uv)
    v = uv - uv.mean(0)
    cross = np.cross(np.append(v[1] - v[0], 0), np.append(v[2] - v[1], 0))[2]
    assert cross > 0      # clockwise on the screen (y down) as on the plane: not mirrored
    top = gcam.Camera(1600, 1200, (1600, 1200), 70, (0.0, 0.0), 300, 0, 0, 0)
    assert np.allclose(top.project([[0.0, 0.0]]), [[800, 600]])


def test_the_background_and_a_document_share_one_homography():
    sc = scenes("single", 1, seed=5)[0]
    sc.occluders, sc.fingers = [], []
    d = sc.docs[0]
    d.page.rgba = Image.new("RGBA", d.page.size_px, (255, 255, 255, 0))
    a = np.asarray(d.page.rgba).copy()
    x0, y0, x1, y1 = d.page.rect
    a[y0:y1, x0:x1] = 255
    d.page.rgba = Image.fromarray(a)
    quad = gs.doc_quads(sc)[0]
    # a frame point away from the page: the background's dot goes there
    cen = quad.mean(0)
    far = [(x, y) for x in np.linspace(60, sc.cam.W - 60, 9) for y in np.linspace(60, sc.cam.H - 60, 9)
           if not gs._inside_poly(np.array([x, y]), quad) and min(np.linalg.norm(quad - [x, y], axis=1)) > 60]
    assert far
    p0 = np.array(max(far, key=lambda p: np.linalg.norm(np.array(p) - cen)))
    X0 = sc.cam.back(p0[None])[0]
    size = 1200
    sc.bg["A"] = gs.similarity(37.0, 0.5, (size / 2, size / 2), X0)
    dot = np.array([size / 2 + 3.3, size / 2 - 2.6])
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32) + 0.5
    blob = np.exp(-((xs - dot[0]) ** 2 + (ys - dot[1]) ** 2) / (2 * 3.0 ** 2))
    sc.bg["image"] = np.repeat((blob * 255).astype(np.uint8)[..., None], 3, 2)
    frame = gs.render(sc, effects=False).astype(np.float32)[..., 0] / 255
    want = sc.cam.project(gs.apply(sc.bg["A"], dot[None]))[0]          # the dot through the camera's one homography
    x, y = int(want[0]), int(want[1])
    win = frame[y - 20:y + 21, x - 20:x + 21]
    yy, xx = np.mgrid[y - 20:y + 21, x - 20:x + 21].astype(np.float64) + 0.5
    got = np.array([(win * xx).sum() / win.sum(), (win * yy).sum() / win.sum()])
    assert np.linalg.norm(got - want) < TOL
    # the page's corner: its label is the same camera's projection of its own corner, and the rendered edges agree
    corner = sc.cam.project(d.plane([d.page.quad()[0]]))[0]
    assert np.allclose(quad[0], corner)
    Hd = sc.cam.Hm @ d.A
    P = Hd @ np.array([x0, y0, 1.0])
    assert np.allclose(P[:2] / P[2], corner)
    errs = corner_errors(sc, d, quad, mask_rgba(d.page))
    assert errs and max(errs) < TOL


# ---------- the labels are where the pixels are ----------
@pytest.mark.parametrize("recipe,bend", [("single", None), ("pair", None), ("card_on_sheet", None), ("painted", None),
                                         ("single", "bend"), ("single", "fold")])
def test_corners_and_field_boxes_reproject_within_half_a_pixel(recipe, bend):
    worst, measured, fields = 0.0, 0, 0
    for sc in scenes(recipe, N, force_bend=bend):
        for d, q in zip(sc.docs, gs.doc_quads(sc)):
            if bend and d.page.material == "paper":
                assert d.bend and d.bend["kind"] == bend
            errs = corner_errors(sc, d, q, mask_rgba(d.page))
            assert len(errs) >= 3, (recipe, bend)
            measured += len(errs)
            worst = max(worst, max(errs))
            for role, text, fq in d.page.fields[:2]:
                lq = sc.cam.project(d.lift(fq))
                e = corner_errors(sc, d, lq, mask_rgba(d.page, fq), min_side=12)
                fields += len(e)
                worst = max([worst] + e)
    print(f"{recipe} {bend}: {measured} corners, {fields} field-box corners, worst {worst:.3f} px")
    assert measured > 3 * N and fields > N, (measured, fields)
    assert worst < TOL, f"{recipe} {bend}: worst {worst:.3f} px"


def test_a_bent_page_keeps_its_corners_on_the_plane_and_moves_its_inside():
    sc = scenes("single", 30, force_bend="bend", seed=3)
    bent = [s for s in sc if s.docs[0].bend]
    assert bent
    d = bent[0].docs[0]
    assert np.allclose(d.z(d.page.quad()), 0)
    x0, y0, x1, y1 = d.page.rect
    assert d.z([[(x0 + x1) / 2, (y0 + y1) / 2]])[0] < -1


def test_a_card_on_its_sefach_is_the_flat_cut_of_the_outer_page():
    from gen import phone
    from gen.outputs import edges as ge
    for sc in scenes("card_on_sheet", 12, seed=21):
        labels = gs.doc_labels(sc)
        roles = gs.roles(sc, labels)
        assert [r for _, r in roles] == ["answer", "inside"]
        assert roles[0][0]["insideOf"] is None and roles[1][0]["insideOf"] == 0
        sheet, card = labels
        frame = np.zeros((sc.cam.H, sc.cam.W, 3), np.uint8)
        got = gs.render_doc(sc.cam, sc.docs[1], rgba=mask_rgba(sc.docs[1].page))
        roi, _, alpha = got
        x0, y0, x1, y1 = roi
        frame[y0:y1, x0:x1] = np.round(alpha * 255).astype(np.uint8)[..., None]
        cut = phone.warp_rgba(frame, sheet["quadModel"])[..., 0].astype(np.float32) / 255
        Hq = phone.homography(sheet["quadModel"], [[0, 0], [1, 0], [1, 1], [0, 1]])
        doc = [list(phone.apply_h(Hq, x, y)) for x, y in card["quad01"]]
        assert np.allclose(phone.unwarp(sheet["quadModel"], doc), card["quad01"], atol=1e-9)   # the lab's way back
        assert all(0 <= v <= 1 for p in doc for v in p)
        px = np.array([[x * cut.shape[1], y * cut.shape[0]] for x, y in doc])
        errs = [float(np.linalg.norm(m - px[k])) for k in range(4)
                for m in [measure(cut, (0, 0), px, k, (1.5, 12.0))] if m is not None]
        assert len(errs) >= 3 and max(errs) < 1.0     # warp_rgba samples at pixel indices (the lab's half pixel)
    # the writer: the frame's answer is the sheet, the card only on the cut
    sc = scenes("card_on_sheet", 1, seed=4)[0]
    labels = gs.doc_labels(sc)
    frame = gs.render(sc, effects=False)
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        (pathlib.Path(t) / "img").mkdir()
        ents, files = ge.entries_of(sc, frame, labels, gs.roles(sc, labels), t, 0, 1, "train", {})
        assert [e["role"] for e in ents] == ["answer", "inside"]
        assert ents[0]["fixed"] == labels[0]["quadModel"] and ents[0]["kind"] == labels[0]["doctype"]
        assert files == ["img/0.jpg", "img/0-in1.jpg"]
        assert all(max(cv2.imread(str(pathlib.Path(t) / f)).shape[:2]) <= 1600 for f in files)


def test_a_pair_writes_the_next_page_with_the_answer_painted_over():
    from gen.outputs import edges as ge
    import tempfile
    sc = next(s for s in scenes("pair", 10, seed=8) if len(s.docs) == 2)
    labels = gs.doc_labels(sc)
    roles = gs.roles(sc, labels)
    assert [r for _, r in roles] == ["answer", "next"] and roles[0][0]["area"] >= roles[1][0]["area"]
    frame = gs.render(sc, effects=False)
    with tempfile.TemporaryDirectory() as t:
        (pathlib.Path(t) / "img").mkdir()
        ents, files = ge.entries_of(sc, frame, labels, roles, t, 3, 1, "train", {})
        assert [e["role"] for e in ents] == ["answer", "next"] and files == ["img/3.jpg", "img/3-n1.jpg"]
        nxt = cv2.imread(str(pathlib.Path(t) / "img" / "3-n1.jpg")).astype(np.float32)
        q = np.array(roles[0][0]["quadDoc"])
        c = q.mean(0).astype(int)
        patch = nxt[c[1] - 3:c[1] + 4, c[0] - 3:c[0] + 4]
        assert patch.std(axis=(0, 1)).max() < 6          # the answer painted over in one colour


def test_next_pictures_and_the_painted_recipe_paint_as_the_lab_on_the_final_frame():
    from gen import phone
    from gen.outputs import edges as ge
    import tempfile
    sc = next(s for s in scenes("pair", 10, seed=8) if len(s.docs) == 2)
    labels = gs.doc_labels(sc)
    roles = gs.roles(sc, labels)
    frame = gs.render(sc, random.Random(5))          # with shadows, light and the phone's effects
    found = [roles[0][0]["quad01"]]
    nxt = gs.paint(frame, found)
    assert np.array_equal(nxt, phone.lab_paint(frame, found))      # the scenes' next picture is the lab's paint of its frame
    col = phone.lab_border_colour(frame, phone.kernel_for("capture"))
    grown = phone.lab_paint_polys(found, sc.cam.W, sc.cam.H)[0]
    inner = np.zeros(frame.shape[:2], np.uint8)
    c = grown.mean(0)
    cv2.fillPoly(inner, [np.round((c + (grown - c) * 0.98 - 0.5) * 16).astype(np.int32)], 1, cv2.LINE_8, shift=4)
    q = np.array(roles[0][0]["quadDoc"])
    rim = np.zeros_like(inner)
    cv2.polylines(rim, [np.round((q - 0.5) * 16).astype(np.int32)], True, 1, 3, cv2.LINE_8, shift=4)
    rim &= inner
    assert rim.sum() > 100 and (nxt[rim > 0] == col).all()          # the page's edge is painted over: no outline left
    assert (nxt[inner > 0] == col).all()
    with tempfile.TemporaryDirectory() as t:
        (pathlib.Path(t) / "img").mkdir()
        ge.entries_of(sc, frame, labels, roles, t, 3, 1, "train", {})
        data, _ = phone.store_attempt(nxt)
        assert (pathlib.Path(t) / "img" / "3-n1.jpg").read_bytes() == data
    # the painted recipe: painted on the final frame, a flat fill (no light, blur, noise or JPEG inside it)
    seen = 0
    for sc in scenes("painted", 6, seed=13):
        frame = gs.render(sc, random.Random(7))
        k = next(i for i, d in enumerate(sc.docs) if d.painted)
        q01 = gs.doc_quads01(sc)[k]
        grown = phone.lab_paint_polys([q01], sc.cam.W, sc.cam.H)[0]
        c = grown.mean(0)
        inner = np.zeros(frame.shape[:2], np.uint8)
        cv2.fillPoly(inner, [np.round((c + (grown - c) * 0.97 - 0.5) * 16).astype(np.int32)], 1, cv2.LINE_8, shift=4)
        others = np.zeros_like(inner)
        for j, d in enumerate(sc.docs):
            if j != k:
                cv2.fillPoly(others, [np.round(gs.doc_quads(sc)[j] * 16).astype(np.int32)], 1, cv2.LINE_8, shift=4)
        for f in sc.fingers:
            cv2.fillPoly(others, [np.round(sc.cam.project(f["poly"]) * 16).astype(np.int32)], 1, cv2.LINE_8, shift=4)
        inner &= 1 - others
        if inner.sum() < 50:
            continue
        seen += 1
        px = frame[inner > 0].reshape(-1, 3)
        assert (px == px[0]).all()
    assert seen


def test_the_table_is_as_sharp_as_the_frame_shows_it():
    class OnePhoto:
        def sample(self, rng, hard=False):
            return {"sha1": "a" * 40, "size": [1600, 1200], "category": "wood", "series": "w", "path": "x"}
    for bank in (None, OnePhoto()):
        n = 0
        for i in range(60):
            r = grng.streams(41, i)
            sc = gs.plan(r, StubPool(), None, bank, None, recipe="single")
            if sc is None:
                continue
            n += 1
            ppm = sc.cam.ppm_at()
            assert abs(sc.bg["framePpm"] - ppm) < 1e-9
            if bank is None:
                assert sc.bg["ppm"] >= ppm * gs.PROC_MARGIN - 1e-9 and sc.bg["size"] <= gs.PROC_MAX
            else:
                assert sc.bg["mm"] <= sc.bg["mmDrawn"] and 1600 / sc.bg["mm"] >= ppm - 1e-9
            # the background's pixels per frame pixel at the point the camera looks at: never enlarged past its own
            t = sc.cam.project([list(sc.cam.target)])[0]
            P = gs.apply(np.linalg.inv(sc.bg["A"]), sc.cam.back(np.array([t, t + [1, 0], t + [0, 1]])))
            J = np.array([P[1] - P[0], P[2] - P[0]])
            assert math.sqrt(abs(np.linalg.det(J))) >= 0.9
        assert n > 30
    # a procedural surface drawn at the frame's resolution keeps its patterns' size in mm
    import synth_docs as sd
    a = sd.surface(random.Random(3), 300, 300, scale=1.0)
    b = sd.surface(random.Random(3), 600, 600, scale=2.0)
    small = cv2.resize(b, (300, 300), interpolation=cv2.INTER_AREA).astype(np.float32)
    assert np.abs(small - a.astype(np.float32)).mean() < 12


def test_partial_scenes_weigh_nothing_by_default_and_put_a_corner_out():
    rng = random.Random(0)
    assert "partial" not in {gs.pick_recipe(rng) for _ in range(3000)}
    assert gs.pick_recipe(random.Random(1), {"single": 0, "pair": 0, "card_on_sheet": 0, "painted": 0, "none": 0, "partial": 1}) == "partial"
    for sc in scenes("partial", 10, seed=2):
        q = gs.doc_quads(sc)[0]
        assert not gs.in_frame(sc, q)
        assert sc.docs and not sc.fingers and not sc.occluders


def test_fingers_and_occluders_never_cover_a_corner():
    seen_f = seen_o = 0
    for sc in scenes("pair", 120, seed=31):
        corners = np.concatenate([d.corners() for d in sc.docs])
        for f in sc.fingers:
            seen_f += 1
            assert gs._far(f["poly"], corners)
        for o in sc.occluders:
            seen_o += 1
            h, w = o["img"].shape[:2]
            assert gs._far(gs.apply(o["A"], [[0, 0], [w, 0], [w, h], [0, h]]), corners)
    assert seen_f and seen_o


def test_a_marked_real_page_gets_new_values_with_their_boxes_and_an_unmarked_one_is_washed(tmp_path, monkeypatch, fonts):
    import template_vary
    folder = tmp_path / "templates" / "id_front"
    folder.mkdir(parents=True)
    page = np.full((540, 856, 3), 200, np.uint8)
    cv2.putText(page, "OLD VALUE 123", (420, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (30, 30, 30), 3)
    cv2.imwrite(str(folder / "marked.png"), page)
    cv2.imwrite(str(folder / "plain.png"), page)
    spec = {"fields": [{"box": [0.45, 0.2, 0.5, 0.12], "kind": "surname"}, {"box": [0.45, 0.4, 0.4, 0.1], "kind": "idNo"}]}
    monkeypatch.setattr(template_vary, "_SPECS", {"id_front/marked.png": spec})
    p = gp.real(random.Random(2), fonts, str(folder / "marked.png"), "id_front", held=True)
    assert p.source == "template" and p.doctype == "id_front" and p.material == "card" and p.seen is False
    assert p.template_sha1 and len(p.fields) == 2 and p.size_px == (856, 540)
    for role, text, q in p.fields:
        q = np.asarray(q)
        assert (q[:, 0] >= 0).all() and (q[:, 0] <= 856).all() and (q[:, 1] >= 0).all() and (q[:, 1] <= 540).all()
    surname = np.asarray(p.fields[0][2])
    assert abs(surname[0, 0] - 0.45 * 856) < 2 and abs(surname[2, 1] - 0.32 * 540) < 2     # the box carried at the page's scale
    w = gp.real(random.Random(2), fonts, str(folder / "plain.png"), "id_front")
    assert w.source == "washed" and w.fields == []


def test_no_pymupdf_skips_the_pdf_source_and_counts_it(monkeypatch, fonts):
    monkeypatch.setattr(gp, "_fitz", lambda: None)
    before = gp.SKIPPED["pdf"]
    pool = gp.Pool(pdfs=[("form101.pdf", "form101"), ("c.pdf", "contract")], pdf_share=1.0)
    p = pool.page(random.Random(0), fonts, "contract")
    assert p.source == "drawn" and p.doctype == "contract"
    q = pool.page(random.Random(1), fonts, "other")
    assert q.source == "drawn" and q.doctype == "other"
    assert gp.SKIPPED["pdf"] == before + 2


def test_form_101_renders_as_an_other_page_when_pymupdf_is_here():
    if not gp.has_pdf():
        pytest.skip("no PyMuPDF here")
    form = HERE.parents[1] / "functions" / "assets" / "form101_fillable.pdf"
    p = gp.pdf(random.Random(0), str(form), "form101")
    assert p.doctype == "other" and p.source == "pdf" and p.template_sha1 is None and p.file_sha1
    assert abs(p.size_mm[0] - 210) < 2 and abs(p.size_mm[1] - 297) < 2


def test_contract_and_other_template_folders_are_pulled_and_labelled():
    import pull_templates
    from gen import common as gc
    assert {"contract", "other"} <= set(pull_templates.KINDS)
    assert gc.label("template", "contract") == "contract" and gc.label("template", "other") == "other"
    assert gc.label("pdf", "form101") == "other" and gc.label("drawn", "he_sheet") == "other"


def test_gen_build_edges_writes_frames_examples_and_strata(tmp_path, monkeypatch):
    pytest.importorskip("albumentations")
    import home
    import synth_docs as sd
    if not sd.latin_fonts() or not sd.hebrew_fonts():
        pytest.skip("no Latin or Hebrew font on this machine")
    from gen import build, manifest, qa
    from gen.outputs import edges as ge
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(home, "WORK", work)
    a = types.SimpleNamespace(count=10, seed=3, out=str(tmp_path / "run"), jobs=1, templates="", template_share=0.4, pdf_share=0.5,
                              procedural_share=0.15, recipes="single=1,pair=1,card_on_sheet=1,painted=1,none=1", partial_weight=0.0,
                              sharp=False, exam=False, latin=None, hebrew=None)
    params = ge.gen_params(a)
    assert params["generator"] == "gen.outputs.edges" and params["weights"]["partial"] == 0.0
    folder, rows, info = build.build("edges", params, 1)
    ex = json.loads((folder / "examples.json").read_text(encoding="utf-8"))
    assert {e["manifest"] for e in ex} == {r["id"] for r in rows}
    assert {e["role"] for e in ex} <= {"answer", "next", "inside"}
    for e in ex:
        img = cv2.imread(e["file"])
        assert img is not None and max(img.shape[:2]) <= 1600
        if e["fixed"]:
            assert e["doc"][0] == e["fixed"][e["upright"]]
    assert info["counts"]["byRecipe"] and info["counts"]["bySource"] and info["counts"]["byBackground"]
    assert all(r["recipe"] in gs.RECIPES and r["rng"] == grng.STAGED for r in rows)
    again = build.regenerate(manifest.read_run(folder), [r["index"] for r in rows[:3]], tmp_path / "again", 1, work)
    assert [x["outputs"] for x in again] == [r["outputs"] for r in rows[:3]]
    p = qa.qa(folder, sample=3, jobs=1, work=work)
    assert p["passed"]
    html = (folder / "qa" / "index.html").read_text(encoding="utf-8")
    assert "Recipe × background category" in html and "Recipe × class" in html
    assert any(f.name.startswith("sheet-recipe-") for f in (folder / "qa").iterdir())
