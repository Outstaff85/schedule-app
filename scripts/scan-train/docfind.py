"""The documents on a scanned photo — once the server's finder (removed 2026-10-19: the site's
scanner is the lab's page); kept here for /scan-train's exam (exam.py: detect, good_quad).

The same steps as the scanner lab (scan-lab/index.html, scan-lab/scan-core.js),
with the accurate model in full precision:

- a white page with photos in it (a form's page, a PDF, a screenshot) is cut
  into its photos first (`photos_on_page`);
- on each photo the accurate DocAligner model (sa24) finds the document's
  corners; when it does not confirm them, the phone's live corners are kept;
  the sides are then pulled onto the strongest edge nearby (`refine_edges`);
- more documents on the same photo (a passport and its ספח, a card…; up to 4):
  the found ones painted over, then a 10 % margin around the photo, then the
  strips beside the first (`find_next`; with lab=True the lab's findNext rules
  exactly, `find_next_lab`); a document lying on a found one, on its flat cut
  (`find_inside`, the lab's findInside);
- every page is cut flat (`warp`) and turned upright by the face on it (YuNet).

The corner picking is the phone's own (gen/phone.py corners, re-exported here).
The model's 256 input is shrunk by INTER_AREA unless `resize` names a phone path
("live", "capture", "high": gen/phone.py frame_to_S — the edges exam on the
phone's path, python -m gen exam-phone).

Pure numpy / OpenCV / ONNX Runtime: the sessions are passed in, so the tests run
it with the real models or with stand-ins.
"""
from functools import cmp_to_key

import numpy as np
import cv2

# The corner picking is the phone's, ported exactly (gen/phone.py corners, from scan-lab/scan-core.js corners): one
# copy, re-exported here under its old names.
from gen.phone import PEAKS, PEAK_R, BLOB_R, SIDES, PAR, FREE, corners, _spots, _frame_score  # noqa: F401
# index.html findInside: a document lying on another covers 3–60 % of its flat cut (one copy: gen/phone.py)
from gen.phone import INSIDE_MIN, INSIDE_MAX  # noqa: F401

S, HM = 256, 128      # the document edges model's input and heatmap sides
FN = 640              # the face finder's input side (yunet640.onnx)
MAX_DOCS = 4
REST_BUSY = 0.3   # photos_on_page: most of a white page outside its photos is white (or a black bar)


# ---------- corners ----------

def quad_error(pts, right):
    """The farthest corner's distance (0..1 of the photo) between two quads, whichever corner each
    starts from (both clockwise): a document turned near 45° has two "top-left" corners, and the
    cut page is turned upright after anyway (owner, 2026-10-22)."""
    p, r = np.asarray(pts, float), np.asarray(right, float)
    return float(min(np.hypot(*(np.roll(p, k, 0) - r).T).max() for k in range(4)))


RESIZES = ("area", "live", "capture", "high")


def model_input(img, resize=None):
    """The edges model's 256 input from a BGR image: resize "area" (None; cv2.INTER_AREA, as the exam always did) or a
    phone path — "live", "capture" or "high", optionally ":<kernel>" (gen/phone.py frame_to_S; with no kernel named the
    profile's exam kernel: the measured one, else the mix's heaviest) — as float32 RGB 0..1, H × W × 3."""
    if resize in (None, "area"):
        small = cv2.resize(img, (S, S), interpolation=cv2.INTER_AREA)
    else:
        from gen import phone
        op, _, kernel = str(resize).partition(":")
        small = phone.frame_to_S(img, op, kernel=kernel or phone.kernel_for(op))
    return cv2.cvtColor(small, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0


def detect(sess, img, resize=None):
    """The document edges model on a BGR image: (pts 4×2 in 0..1 or None, conf). sess may be a
    list of models (the accurate one, then the light one): the first that is sure wins. resize: how the
    picture is shrunk to the model's 256 input (model_input: INTER_AREA by default, or the phone's path)."""
    if isinstance(sess, (list, tuple)):
        best = (None, 0.0)
        for one in sess:
            pts, conf = detect(one, img, resize)
            if good_quad(pts, conf):
                return pts, conf
            if best[0] is None:
                best = (pts, conf)
        return best
    x = model_input(img, resize)
    hm = sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})[0][0]
    return corners(hm)


def quad_area(q):
    x, y = q[:, 0], q[:, 1]
    return abs(float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))) / 2


def quad_convex(q):
    sg = 0
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if z:
            if sg and np.sign(z) != sg:
                return False
            sg = np.sign(z)
    return True


def good_quad(pts, conf, shape=None):
    """Sure corners of a sound document: convex, not tiny and — on an image of the given
    shape — no longer than 3 : 1 (a thin strip is an edge, not a document)."""
    if pts is None or conf < 0.5 or not quad_convex(pts) or quad_area(pts) <= 0.03:
        return False
    if shape is not None:
        P = pts * [shape[1], shape[0]]
        a = np.linalg.norm(P[1] - P[0]) + np.linalg.norm(P[2] - P[3])
        b = np.linalg.norm(P[3] - P[0]) + np.linalg.norm(P[2] - P[1])
        if max(a, b) > 3 * max(min(a, b), 1e-9):
            return False
    return True


def quad_iou(a, b, n=64):
    ma = np.zeros((n, n), np.uint8)
    mb = ma.copy()
    cv2.fillPoly(ma, [np.round(a * n).astype(np.int32)], 1)
    cv2.fillPoly(mb, [np.round(b * n).astype(np.int32)], 1)
    union = int((ma | mb).sum())
    return int((ma & mb).sum()) / union if union else 0.0


# ---------- the sides onto the edges ----------

def refine_edges(img, q, search=0.012):
    """Each side moved along its normal (at most `search` of the long side) onto the
    strongest edge line nearby, the corners re-intersected. Kept only when the sides
    lie on clearly stronger edges than before and the shape stays sound."""
    h, w = img.shape[:2]
    sc = min(1.0, 1200 / max(w, h))
    g = cv2.cvtColor(cv2.resize(img, (round(w * sc), round(h * sc)), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (5, 5), 0)
    mag = cv2.magnitude(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    gh, gw = mag.shape
    P = q * [gw, gh]
    reach = search * max(gw, gh)
    ts = np.linspace(0.12, 0.88, 40)

    def along(a, d, nrm, off):
        xy = a + np.outer(ts, d) + nrm * off
        xi, yi = xy[:, 0].astype(int), xy[:, 1].astype(int)
        ok = (xi >= 0) & (yi >= 0) & (xi < gw) & (yi < gh)
        return float(mag[yi[ok], xi[ok]].mean()) if ok.sum() > 10 else 0.0

    lines, before, after = [], [], []
    for i in range(4):
        a, b = P[i], P[(i + 1) % 4]
        d = b - a
        nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-9)
        offs = np.linspace(-reach, reach, 25)
        vals = [along(a, d, nrm, o) for o in offs]
        k = int(np.argmax(vals))
        before.append(vals[12])
        after.append(vals[k])
        lines.append((a + nrm * offs[k], b + nrm * offs[k]))

    def inter(l1, l2):
        (p1, p2), (p3, p4) = l1, l2
        A = np.array([[p2[0] - p1[0], p3[0] - p4[0]], [p2[1] - p1[1], p3[1] - p4[1]]])
        if abs(np.linalg.det(A)) < 1e-9:
            return None
        t = np.linalg.solve(A, p3 - p1)[0]
        return p1 + (p2 - p1) * t

    pts = [inter(lines[i - 1], lines[i]) for i in range(4)]
    if any(p is None for p in pts):
        return q
    out = np.array(pts) / [gw, gh]
    if not quad_convex(out) or np.abs(out - q).max() > 2 * search or (out < -0.01).any() or (out > 1.01).any():
        return q
    # an edge is taken only where it is clearly stronger than where the model put the side
    if sum(after) < 1.15 * sum(before):
        return q
    return np.clip(out, 0, 1)


# ---------- more documents on one photo ----------

def border_colour(img):
    t = cv2.resize(img, (32, 32), interpolation=cv2.INTER_AREA)
    ring = np.concatenate([t[0], t[-1], t[:, 0], t[:, -1]])
    return [int(v) for v in np.median(ring, axis=0)]


def detect_padded(sess, img, col=None, resize=None):
    """detect() on the image inside a 10 % margin of its background's colour: a document
    cut off by the photo's edge (or cut to its edges already) then lies whole inside,
    its corners on the edge. The corners are given in the image's own 0..1."""
    h, w = img.shape[:2]
    pad = round(0.1 * max(w, h))
    padded = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=col or border_colour(img))
    pts, conf = detect(sess, padded, resize)
    if pts is None:
        return None, conf
    return np.clip((pts * [w + 2 * pad, h + 2 * pad] - pad) / [w, h], 0, 1), conf


def find_next(models, img, found, resize=None, lab=False):
    """The next document's corners (0..1) on the photo, or None: the found ones painted
    over in the background's colour, then a 10 % margin of that colour around the photo
    (a document cut off by the photo's edge then lies whole inside) — each with the
    accurate model, then the light one, as the scanner lab does —, then the widest strips
    left beside the first (the accurate model only). A frame overlapping a found one by
    over 30 % is that one again. models: a session, or a list (accurate, light); resize: as detect's.

    lab=False (pages(): this file's own finder) takes a frame by good_quad with the photo's shape (no longer than
    3 : 1) and paints in border_colour; lab=True runs the lab's findNext exactly (find_next_lab: E4's shot)."""
    models = list(models) if isinstance(models, (list, tuple)) else [models]
    if lab:
        return find_next_lab(models, img, found, resize)
    h, w = img.shape[:2]

    def try_on(src, back, sess):
        pts, conf = detect(sess, src, resize)
        q = back(pts) if good_quad(pts, conf) else None
        if q is None or not good_quad(q, conf, img.shape):
            return None
        return q if all(quad_iou(q, f) <= 0.3 for f in found) else None

    col = border_colour(img)
    painted = img.copy()
    for q in found:
        c = q.mean(0)
        poly = (q + (q - c) * 0.04) * [w, h]
        cv2.fillPoly(painted, [np.round(poly).astype(np.int32)], col)
    for sess in models:
        q = try_on(painted, lambda p: p, sess)
        if q is not None:
            return q
    for sess in models:
        pts, conf = detect_padded(sess, painted, col, resize)
        q = pts if good_quad(pts, conf, img.shape) and all(quad_iou(pts, f) <= 0.3 for f in found) else None
        if q is not None:
            return q
    q1 = found[0]
    x0, y0 = q1.min(0)
    x1, y1 = q1.max(0)
    strips = [s for s in [(0, 0, 1, y0), (0, y1, 1, 1), (0, 0, x0, 1), (x1, 0, 1, 1)] if s[2] - s[0] >= 0.25 and s[3] - s[1] >= 0.2]
    strips.sort(key=lambda s: -(s[2] - s[0]) * (s[3] - s[1]))
    for a, b, c2, d2 in strips[:2]:
        X0, Y0, X1, Y1 = round(a * w), round(b * h), round(c2 * w), round(d2 * h)
        if X1 - X0 < 16 or Y1 - Y0 < 16:
            continue
        q = try_on(painted[Y0:Y1, X0:X1], lambda p, a=a, b=b, c2=c2, d2=d2: np.stack([a + p[:, 0] * (c2 - a), b + p[:, 1] * (d2 - b)], 1), models[0])
        if q is not None:
            return q
    return None


def _border_kernel(resize):
    """The kernel findNext's 32 × 32 paint colour is drawn with: drawImage at the default smoothing (the capture op's
    kernel — the one resize names, else the profile's), INTER_AREA on the "area" path."""
    from gen import phone
    if resize in (None, "area"):
        return "area"
    _, _, kernel = str(resize).partition(":")
    return kernel or phone.kernel_for("capture")


def find_next_lab(models, img, found, resize=None):
    """index.html findNext, step by step: the found ones (each grown 4 % from its centre) painted over in the colour of
    the photo's border (phone.lab_border_colour), each model on it (the accurate one, then the light one), then the
    same inside a margin of that colour (Math.round of 10 % of the long side; the corners taken back and clamped to
    the photo), then — when one is found already — the two widest strips beside the first (at least 25 % wide and
    20 % high, Math.round sides, no smallest size), the accurate model only. A frame is taken when the model's answer
    is phone.lab_good_quad (no aspect rule) and, back on the photo, phone.doc_shape in its pixels and overlapping
    no found one by over 30 % (phone.lab_quad_iou). The painting is antialiased like a canvas fill; every model input
    is smallRGBA's (resize, "capture" on the phone's path). models: a list (accurate, light) or one session."""
    from gen import phone
    models = list(models) if isinstance(models, (list, tuple)) else [models]
    h, w = img.shape[:2]
    found = [np.asarray(f, np.float64) for f in found]

    def fresh(q):
        return phone.doc_shape(q, w, h) and all(phone.lab_quad_iou(q, f) <= 0.3 for f in found)

    def try_it(sess, src, back):
        pts, conf = detect(sess, src, resize)
        if not phone.lab_good_quad(pts, conf):
            return None
        q = back(np.asarray(pts, np.float64))
        return q if fresh(q) else None

    col = phone.lab_border_colour(img, _border_kernel(resize))
    painted = phone.lab_paint(img, found, colour=col)   # each found one grown 4 %, an antialiased canvas fill
    for sess in models:
        q = try_it(sess, painted, lambda p: p)
        if q is not None:
            return q
    P = phone.js_round(0.1 * max(w, h))
    padded = cv2.copyMakeBorder(painted, P, P, P, P, cv2.BORDER_CONSTANT, value=col)
    pw, ph = w + 2 * P, h + 2 * P
    for sess in models:
        q = try_it(sess, padded, lambda p: np.clip((p * [pw, ph] - P) / [w, h], 0, 1))
        if q is not None:
            return q
    if not found:
        return None
    q1 = found[0]
    x0, y0 = q1.min(0)
    x1, y1 = q1.max(0)
    strips = [s for s in [(0, 0, 1, y0), (0, y1, 1, 1), (0, 0, x0, 1), (x1, 0, 1, 1)] if s[2] - s[0] >= 0.25 and s[3] - s[1] >= 0.2]
    strips.sort(key=lambda s: -(s[2] - s[0]) * (s[3] - s[1]))
    for a, b, c2, d2 in strips[:2]:
        sw, sh = phone.js_round((c2 - a) * w), phone.js_round((d2 - b) * h)
        X0, Y0 = phone.js_round(a * w), phone.js_round(b * h)
        if sw < 1 or sh < 1:
            continue
        strip = np.zeros((sh, sw, 3), np.uint8)   # drawImage of a source rectangle past the photo's edge: left blank
        part = painted[Y0:Y0 + sh, X0:X0 + sw]
        strip[:part.shape[0], :part.shape[1]] = part
        q = try_it(models[0], strip, lambda p, a=a, b=b, c2=c2, d2=d2: np.stack([a + p[:, 0] * (c2 - a), b + p[:, 1] * (d2 - b)], 1))
        if q is not None:
            return q
    return None


def find_inside(sess, img, q, found, resize="capture"):
    """A document lying on the found one q (an ID card on its ספח; index.html findInside), or None: q cut flat from
    the photo as the phone cuts it (gen/phone.py warp_rgba: not turned, no exact proportion, what falls outside the
    photo black), the model on the cut, and a sure frame of a document's shape (phone.doc_shape) covering 3–60 % of
    the cut taken back onto the photo through the cut's homography — unless it is a document found already (q itself
    left out; the overlap by phone.lab_quad_iou, the lab's quadIoU). sess: one model (the lab uses its capture model, the
    light one when it has none); img: BGR; resize: as detect's ("capture": the lab's smallRGBA)."""
    from gen import phone
    q = np.asarray(q, np.float64)
    flat = phone.warp_rgba(img, q.tolist())[..., :3]
    H, W = flat.shape[:2]
    if W < 2 or H < 2:
        return None
    pts, conf = detect(sess, flat, resize)
    if not phone.lab_good_quad(pts, conf) or not phone.doc_shape(pts, W, H):
        return None
    pts = np.asarray(pts, np.float64)
    a = quad_area(pts)
    if a < INSIDE_MIN or a > INSIDE_MAX:
        return None
    c = np.array(phone.unwarp(q.tolist(), pts.tolist()), np.float64)
    return c if all(np.array_equal(np.asarray(f), q) or phone.lab_quad_iou(c, np.asarray(f)) <= 0.3 for f in found) else None


# ---------- photos on a white page ----------

def photos_on_page(img):
    """The photos and printed documents on a white page as boxes (x0, y0, x1, y1) in pixels,
    in reading order: every band of rows where most of the page is not white, at least 12 %
    high; inside each, every run of columns mostly not white and a quarter of the page wide
    gives a photo's sides; then the blocks of ink (ink_blocks: a ספח, a black-and-white copy)
    not already in a photo. None when the picture is (nearly) one photo already. A band mostly
    dark (a screenshot's bar) is not a photo; a picture whose rest is not mostly white is not a
    white page (none). The phone's copy: src/scan/find.ts photosOnPage."""
    H, W = img.shape[:2]
    sc = 300 / max(W, H)
    w, h = max(1, round(W * sc)), max(1, round(H * sc))
    small = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
    busy = (small.min(axis=2) < 225).astype(np.float32)
    rows = busy.mean(1) > 0.45
    out = []
    y = 0
    while y < h:
        if not rows[y]:
            y += 1
            continue
        y0 = y
        while y < h and rows[y]:
            y += 1
        y1 = y
        if y1 - y0 < 0.12 * h:
            continue
        cols = busy[y0:y1].mean(0) > 0.6
        # every wide run of columns: two photos side by side in one band are two photos
        runs, x = [], 0
        while x < w:
            if not cols[x]:
                x += 1
                continue
            x0 = x
            while x < w and cols[x]:
                x += 1
            if x - x0 >= 0.25 * w:
                runs.append((x0, x))
        for run in runs:
            # a phone's or browser's bar in a screenshot: mostly dark, not a photo
            if (small[y0:y1, run[0]:run[1]].max(axis=2) < 60).mean() > 0.5:
                continue
            out.append(((run[1] - run[0]) * (y1 - y0) / (w * h),
                        (int(run[0] / sc), int(y0 / sc), min(W, int(np.ceil(run[1] / sc))), min(H, int(np.ceil(y1 / sc))))))
    for b in ink_blocks(small):
        if any(_overlap(_small_box(box, sc), b) > 0.5 for _, box in out):
            continue
        x0, y0, x1, y1 = b
        out.append(((x1 - x0) * (y1 - y0) / (w * h),
                    (int(x0 / sc), int(y0 / sc), min(W, int(np.ceil(x1 / sc))), min(H, int(np.ceil(y1 / sc))))))
    out.sort(key=cmp_to_key(_reading_order))
    if not out or (len(out) == 1 and out[0][0] > 0.9):
        return []
    # a white page: what lies outside the photos is mostly white (a photo of a white
    # sheet on a dark table is not one — its bands would be strips of the table)
    rest = np.ones((h, w), bool)
    for _, (x0, y0, x1, y1) in out:
        rest[int(y0 * sc):int(np.ceil(y1 * sc)), int(x0 * sc):int(np.ceil(x1 * sc))] = False
    mid = busy * (small.max(axis=2) >= 60)   # not white and not a screenshot's black bar
    if rest.sum() and mid[rest].mean() > REST_BUSY:
        return []
    return [box for _, box in out]


def _small_box(box, sc):
    x0, y0, x1, y1 = box
    return (x0 * sc, y0 * sc, x1 * sc, y1 * sc)


def _overlap(a, b):
    """Of two boxes, the share of the smaller one that lies in both."""
    iw, ih = min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1])
    if iw <= 0 or ih <= 0:
        return 0.0
    return iw * ih / min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))


def _reading_order(a, b):
    """Side by side (sharing most of their height) left to right, else top to bottom."""
    (_, (ax0, ay0, _, ay1)), (_, (bx0, by0, _, by1)) = a, b
    share = min(ay1, by1) - max(ay0, by0)
    return ax0 - bx0 if share > 0.5 * min(ay1 - ay0, by1 - by0) else ay0 - by0


def ink_blocks(small):
    """On a mostly white page (at least half of it paper), the blocks of ink — the dark strokes
    joined by a closing of 2 % of the page — each at least a 20th of the page and at most nine
    tenths of it: the printed documents on it, as boxes on the small picture. The phone's copy:
    src/scan/find.ts inkBlocks."""
    h, w = small.shape[:2]
    m = small.min(axis=2)
    if (m >= 225).mean() < 0.5:
        return []
    r = max(2, round(0.02 * max(w, h)))
    grown = cv2.dilate((m < 160).astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(grown)
    out = []
    for j in range(1, n):
        x, y, bw, bh = (int(v) for v in st[j, :4])
        x0, y0 = min(x + bw - 1, x + r), min(y + bh - 1, y + r)        # back to the ink's own edges
        x1, y1 = max(x0, x + bw - r), max(y0, y + bh - r)
        bw, bh = x1 - x0, y1 - y0
        if 0.05 * w * h <= bw * bh <= 0.9 * w * h and bw >= 0.15 * w and bh >= 0.1 * h:
            out.append((x0, y0, x1, y1))
    return out


def _inside(q, box, shape, n=64):
    """Whether most of the quad (0..1) lies inside the box (pixels)."""
    h, w = shape[:2]
    mq = np.zeros((n, n), np.uint8)
    cv2.fillPoly(mq, [np.round(q * n).astype(np.int32)], 1)
    mb = np.zeros((n, n), np.uint8)
    x0, y0, x1, y1 = box
    mb[int(y0 / h * n):int(np.ceil(y1 / h * n)), int(x0 / w * n):int(np.ceil(x1 / w * n))] = 1
    return mq.sum() and (mq & mb).sum() / mq.sum() >= 0.7


# ---------- cut and upright ----------

# The documents' real proportions (long side / short side): an ID card (ID-1, 85.6 × 54 mm),
# a passport page (ID-3, 125 × 88 mm), an A4 page (the ספח, a contract). A cut whose
# sides come out within RATIO_TOL of one of them was foreshortened by the camera's angle
# and is set to the exact one; anything else keeps its measured sides.
RATIOS = (85.6 / 54, 125 / 88, 297 / 210)
RATIO_TOL = 0.055


def exact_size(W, Hh):
    """(width, height) of a cut, set to a document's exact proportion when close to one."""
    long, short = max(W, Hh), min(W, Hh)
    r = long / max(1, short)
    best = min(RATIOS, key=lambda t: abs(r / t - 1))
    if abs(r / best - 1) > RATIO_TOL:
        return W, Hh
    short = max(1, round(long / best))
    return (long, short) if W >= Hh else (short, long)


def warp(img, q, exact=True):
    """The quad (0..1) of the image cut out flat (exact: in a document's exact proportion
    when its sides are close to one — never for a whole picture kept as it is)."""
    h, w = img.shape[:2]
    P = (q * [w, h]).astype(np.float32)
    d = lambda a, b: float(np.linalg.norm(a - b))
    W = max(1, round(max(d(P[0], P[1]), d(P[3], P[2]))))
    Hh = max(1, round(max(d(P[0], P[3]), d(P[1], P[2]))))
    if exact:
        W, Hh = exact_size(W, Hh)
    M = cv2.getPerspectiveTransform(P, np.float32([[0, 0], [W, 0], [W, Hh], [0, Hh]]))
    return cv2.warpPerspective(img, M, (W, Hh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


ROT = {1: cv2.ROTATE_90_CLOCKWISE, 2: cv2.ROTATE_180, 3: cv2.ROTATE_90_COUNTERCLOCKWISE}


def turned(img, k):
    return cv2.rotate(img, ROT[k]) if k else img


def face_score(sess, img):
    """How surely a face stands upright on the image: its score × sin of the eyes → mouth
    angle (1 when the mouth is straight below the eyes); 0 when no face is found."""
    s = FN / max(img.shape[:2])
    small = cv2.resize(img, (max(1, round(img.shape[1] * s)), max(1, round(img.shape[0] * s))), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((FN, FN, 3), np.float32)
    canvas[:small.shape[0], :small.shape[1]] = small
    out = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {sess.get_inputs()[0].name: canvas.transpose(2, 0, 1)[None]})))
    best = None
    for st in (8, 16, 32):
        cols = FN // st
        cls = np.clip(out[f"cls_{st}"].reshape(-1), 0, 1)
        obj = np.clip(out[f"obj_{st}"].reshape(-1), 0, 1)
        sc = np.sqrt(cls * obj)
        i = int(np.argmax(sc))
        if best is None or sc[i] > best[0]:
            kps = out[f"kps_{st}"].reshape(-1, 10)[i]
            r, c = divmod(i, cols)
            best = (float(sc[i]), [((kps[2 * m] + c) * st, (kps[2 * m + 1] + r) * st) for m in range(5)])
    if best is None or best[0] < 0.5:
        return 0.0
    er, el, _, mr, ml = best[1]
    a = np.arctan2((mr[1] + ml[1]) / 2 - (er[1] + el[1]) / 2, (mr[0] + ml[0]) / 2 - (er[0] + el[0]) / 2)
    return best[0] * max(0.0, float(np.sin(a)))


def face_turn(sess, img):
    """Clockwise quarter-turns that put the page upright by its face; -1 when none is found."""
    bk, bs = -1, 0.0
    for k in range(4):
        sc = face_score(sess, turned(img, k))
        if sc > bs:
            bk, bs = k, sc
    return bk


# ---------- the whole photo ----------

# ---------- the document type (docs/scan-plan.md → S7) ----------
# The firm's own document type model, once one is trained (models/scan/<version>/doctype.onnx):
# input "img" [1, 3, 256, 256], RGB 0..1, the page stretched to the square (as the
# training copies are); outputs "doctype" [1, 6] (DOCTYPES, probabilities) and "turn" [1, 4]
# (the clockwise turn the page needs: 0, 90, 180, 270°). A page it is sure of
# (DOCTYPE_SURE on both) needs no Haiku.
DOCTYPES = ("id_front", "id_back", "sefach", "passport", "contract", "other")
KS = 256
DOCTYPE_SURE = 0.9


def doctype_of(sess, img):
    """The page's document type and the turn it needs, with how sure the model is."""
    x = cv2.cvtColor(cv2.resize(img, (KS, KS), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    out = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})))
    kp, tp = np.asarray(out["doctype"], np.float64).reshape(-1), np.asarray(out["turn"], np.float64).reshape(-1)
    k, t = int(kp.argmax()), int(tp.argmax())
    return {"doctype": DOCTYPES[k], "doctypeConf": round(float(kp[k]), 4), "doctypeTurn": 90 * t, "doctypeTurnConf": round(float(tp[t]), 4)}


def with_doctype(sess, page, turn):
    """(page, turn, doctype fields): the document type read; a page with no face (turn < 0) is set
    upright by the document type model when it is sure of the turn (turn then ≥ 0). Nothing changes when there is no model or
    it fails."""
    if sess is None:
        return page, turn, {}
    try:
        kd = doctype_of(sess, page)
    except Exception:
        return page, turn, {}
    if turn < 0 and kd["doctypeTurnConf"] >= DOCTYPE_SURE:  # sure of the turn (0 too: already upright)
        turn = kd["doctypeTurn"] // 90
        page = turned(page, turn)
        kd["doctypeTurn"] = 0
    kd["doctypeSure"] = kd["doctypeConf"] >= DOCTYPE_SURE and (turn >= 0 or kd["doctypeTurnConf"] >= DOCTYPE_SURE)
    return page, turn, kd


def find_documents(img, model, face=None, hint=None, doctype=None):
    """The pages on a photo: [{"quad", "box", "source", "turn", "image"}], in order.

    img: BGR; model: the document edges model's session, or a list (accurate, light); face: the face finder's (None: no turn);
    hint: the phone's live corners (0..1) of the first document, kept when the model does
    not confirm its own. quad is in 0..1 of its photo (box: the photo's place on the
    page, None for the whole picture); source says where the corners came from."""
    # a camera shot (the phone's live corners with it) is one photo, as in the scanner lab: only
    # a picked file can be a white page of photos (a form's page, a PDF, a screenshot)
    boxes = photos_on_page(img) if hint is None else []
    if boxes:
        # a document the model sees on the whole picture, outside the photos found:
        # a plain photo after all (a white sheet on a table), not a page of photos
        pts, conf = detect(model, img)
        # (a frame around two or more of them is the sheet they are printed on: they stay apart)
        holds = sum(cv2.pointPolygonTest((pts * [img.shape[1], img.shape[0]]).astype(np.float32), ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), False) >= 0
                    for b in boxes) if pts is not None else 0
        if good_quad(pts, conf, img.shape) and not any(_inside(pts, box, img.shape) for box in boxes) and holds < 2:
            boxes = []
    parts = [(img[y0:y1, x0:x1], (x0, y0, x1, y1)) for x0, y0, x1, y1 in boxes] or [(img, None)]
    pages = []
    for part, box in parts:
        pts, conf = detect(model, part)
        if not good_quad(pts, conf, part.shape):
            pts, conf = detect_padded(model, part)
        if good_quad(pts, conf, part.shape):
            first, source = refine_edges(part, pts), "model"
        elif box is None and hint is not None:
            first, source = np.array(hint, np.float64), "phone"
        else:
            # a photo with no document frame in it is a document already cut to its edges
            first, source = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float64), "photo" if box else "whole"
        found = [first]
        sources = [source]
        while len(found) < MAX_DOCS:
            q = find_next(model, part, found)
            if q is None:
                break
            found.append(refine_edges(part, q))
            sources.append("more")
        for q, src in zip(found, sources):
            page = warp(part, q, exact=src not in ("photo", "whole"))
            turn = -1
            if face is not None:
                try:
                    turn = face_turn(face, page)
                except Exception:
                    turn = -2
                if turn > 0:
                    page = turned(page, turn)
            page, turn, kd = with_doctype(doctype, page, turn)
            pages.append({"quad": q.tolist(), "box": box, "source": src, "turn": turn, "image": page, **kd})
    return pages
