"""The documents on a scanned photo, found on the server (docs/scan-plan.md → S1).

The same steps as the scanner lab (scan-lab/index.html, scan-lab/scan-core.js),
with the accurate model in full precision:

- a white page with photos in it (a form's page, a PDF, a screenshot) is cut
  into its photos first (`photos_on_page`);
- on each photo the accurate DocAligner model (sa24) finds the document's
  corners; when it does not confirm them, the phone's live corners are kept;
  the sides are then pulled onto the strongest edge nearby (`refine_edges`);
- more documents on the same photo (a passport and its ספח, a card…; up to 4):
  the found ones painted over, then a 10 % margin around the photo, then the
  strips beside the first (`find_next`);
- every page is cut flat (`warp`) and turned upright by the face on it (YuNet).

Pure numpy / OpenCV / ONNX Runtime: the sessions are passed in, so the tests run
it with the real models or with stand-ins.
"""
import numpy as np
import cv2

S, HM = 256, 128      # the corner model's input and heatmap sides
FN = 640              # the face finder's input side (yunet640.onnx)
MAX_DOCS = 4
REST_BUSY = 0.3   # photos_on_page: most of a white page outside its photos is white (or a black bar)


# ---------- corners ----------

def detect(sess, img):
    """The corner model on a BGR image: (pts 4×2 in 0..1 or None, conf). sess may be a
    list of models (the accurate one, then the light one): the first that is sure wins."""
    if isinstance(sess, (list, tuple)):
        best = (None, 0.0)
        for one in sess:
            pts, conf = detect(one, img)
            if good_quad(pts, conf):
                return pts, conf
            if best[0] is None:
                best = (pts, conf)
        return best
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (S, S), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    hm = sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})[0][0]
    return corners(hm)


def corners(hm):
    """Each of the 4 heatmaps: the weighted centre of the blob around its peak (>= 0.3)."""
    pts, confs = [], []
    for k in range(4):
        m = hm[k]
        confs.append(float(m.max()))
        if m.max() < 0.3:
            pts.append(None)
            continue
        n, lab = cv2.connectedComponents((m >= 0.3).astype(np.uint8), connectivity=4)
        py, px = np.unravel_index(int(np.argmax(m)), m.shape)
        sel = lab == lab[py, px]
        w = m * sel
        ys, xs = np.mgrid[0:m.shape[0], 0:m.shape[1]]
        sw = float(w.sum())
        pts.append([(float((xs * w).sum()) / sw + 0.5) / m.shape[1], (float((ys * w).sum()) / sw + 0.5) / m.shape[0]])
    return (None if any(p is None for p in pts) else np.array(pts, np.float64)), min(confs)


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


def detect_padded(sess, img, col=None):
    """detect() on the image inside a 10 % margin of its background's colour: a document
    cut off by the photo's edge (or cut to its edges already) then lies whole inside,
    its corners on the edge. The corners are given in the image's own 0..1."""
    h, w = img.shape[:2]
    pad = round(0.1 * max(w, h))
    padded = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=col or border_colour(img))
    pts, conf = detect(sess, padded)
    if pts is None:
        return None, conf
    return np.clip((pts * [w + 2 * pad, h + 2 * pad] - pad) / [w, h], 0, 1), conf


def find_next(sess, img, found):
    """The next document's corners (0..1) on the photo, or None: the found ones painted
    over in the background's colour, then a 10 % margin of that colour around the photo
    (a document cut off by the photo's edge then lies whole inside), then the widest
    strips left beside the first. A frame overlapping a found one by over 30 % is that
    one again."""
    h, w = img.shape[:2]

    def try_on(src, back):
        pts, conf = detect(sess, src)
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
    q = try_on(painted, lambda p: p)
    if q is not None:
        return q
    pts, conf = detect_padded(sess, painted, col)
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
        q = try_on(painted[Y0:Y1, X0:X1], lambda p, a=a, b=b, c2=c2, d2=d2: np.stack([a + p[:, 0] * (c2 - a), b + p[:, 1] * (d2 - b)], 1))
        if q is not None:
            return q
    return None


# ---------- photos on a white page ----------

def photos_on_page(img):
    """The photos on a white page as boxes (x0, y0, x1, y1) in pixels, top to bottom:
    every band of rows where most of the page is not white, at least 12 % high; inside
    each, the longest run of columns mostly not white gives its sides. None when the
    picture is (nearly) one photo already. A band mostly dark (a screenshot's bar) is not
    a photo; a picture whose rest is not mostly white is not a white page (none)."""
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
        run, x = None, 0
        while x < w:
            if not cols[x]:
                x += 1
                continue
            x0 = x
            while x < w and cols[x]:
                x += 1
            if not run or x - x0 > run[1] - run[0]:
                run = (x0, x)
        if not run or run[1] - run[0] < 0.25 * w:
            continue
        # a phone's or browser's bar in a screenshot: mostly dark, not a photo
        if (small[y0:y1, run[0]:run[1]].max(axis=2) < 60).mean() > 0.5:
            continue
        out.append(((run[1] - run[0]) * (y1 - y0) / (w * h),
                    (int(run[0] / sc), int(y0 / sc), min(W, int(np.ceil(run[1] / sc))), min(H, int(np.ceil(y1 / sc))))))
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

# ---------- the page kind (docs/scan-plan.md → S7) ----------
# The firm's own page-kind model, once one is trained (models/scan/<version>/kind.onnx):
# input "img" [1, 3, 256, 256], RGB 0..1, the page stretched to the square (as the
# training copies are); outputs "kind" [1, 6] (KINDS, probabilities) and "turn" [1, 4]
# (the clockwise turn the page needs: 0, 90, 180, 270°). A page it is sure of
# (KIND_SURE on both) needs no Haiku.
KINDS = ("id_front", "id_back", "sefach", "passport", "contract", "other")
KS = 256
KIND_SURE = 0.9


def kind_of(sess, img):
    """The page's kind and the turn it needs, with how sure the model is."""
    x = cv2.cvtColor(cv2.resize(img, (KS, KS), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    out = dict(zip([o.name for o in sess.get_outputs()], sess.run(None, {sess.get_inputs()[0].name: x.transpose(2, 0, 1)[None]})))
    kp, tp = np.asarray(out["kind"], np.float64).reshape(-1), np.asarray(out["turn"], np.float64).reshape(-1)
    k, t = int(kp.argmax()), int(tp.argmax())
    return {"kind": KINDS[k], "kindConf": round(float(kp[k]), 4), "kindTurn": 90 * t, "kindTurnConf": round(float(tp[t]), 4)}


def with_kind(sess, page, turn):
    """(page, turn, kind fields): the kind read; a page with no face (turn < 0) is set
    upright by the kind model when it is sure of the turn (turn then ≥ 0). Nothing changes when there is no model or
    it fails."""
    if sess is None:
        return page, turn, {}
    try:
        kd = kind_of(sess, page)
    except Exception:
        return page, turn, {}
    if turn < 0 and kd["kindTurnConf"] >= KIND_SURE:  # sure of the turn (0 too: already upright)
        turn = kd["kindTurn"] // 90
        page = turned(page, turn)
        kd["kindTurn"] = 0
    kd["kindSure"] = kd["kindConf"] >= KIND_SURE and (turn >= 0 or kd["kindTurnConf"] >= KIND_SURE)
    return page, turn, kd


def find_documents(img, model, face=None, hint=None, kind=None):
    """The pages on a photo: [{"quad", "box", "source", "turn", "image"}], in order.

    img: BGR; model: the corner model's session, or a list (accurate, light); face: the face finder's (None: no turn);
    hint: the phone's live corners (0..1) of the first document, kept when the model does
    not confirm its own. quad is in 0..1 of its photo (box: the photo's place on the
    page, None for the whole picture); source says where the corners came from."""
    boxes = photos_on_page(img)
    if boxes:
        # a document the model sees on the whole picture, outside the photos found:
        # a plain photo after all (a white sheet on a table), not a page of photos
        pts, conf = detect(model, img)
        if good_quad(pts, conf, img.shape) and not any(_inside(pts, box, img.shape) for box in boxes):
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
            # the light model finds false second documents: the split is the accurate model's
            q = find_next(model[0] if isinstance(model, (list, tuple)) else model, part, found)
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
            page, turn, kd = with_kind(kind, page, turn)
            pages.append({"quad": q.tolist(), "box": box, "source": src, "turn": turn, "image": page, **kd})
    return pages
