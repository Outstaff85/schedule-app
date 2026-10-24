"""Scenes: 1–4 flat pages on one plane, a phone's camera over them (docs/scan-training.md → "Scenes: one camera for the
table and the documents").

  plan(rngs, pool, F, bank, occluders, recipe) → Scene     # where everything lies, the camera, the background
  render(scene, effects=True) → the frame (BGR)            # the table and the documents through ONE homography
  doc_labels(scene) → each document's labels               # quad_doc, quad_model, inside_of, page_id, fields …

- The plane is in millimetres. A page is put on it by a similarity (its picture's pixels → mm: turned mostly by a
  quarter turn, ANY_ANGLE of them by any angle); the background photo too, at its physical size (its long side
  BG_MM, or the catalog's widthMm); a procedural surface (synth_docs.surface) at PROC_PPM pixels per mm.
- Recipes (the phone's search order): single; pair (2–4 pages apart, the larger found first — the rest "next");
  card_on_sheet (an ID card lying on its ספח or another sheet: the scanner cuts the sheet, then finds the card inside —
  the card is written as the flat cut of the outer page, gen/outputs/edges.py); painted (another document found first,
  painted over in the border's colour); none (no document; a photo with text but no document preferred half the time);
  partial (a document partly out of the frame — weight 0 until the owner confirms its label: no corners, conf 0).
- A page may be bent (lifted off the plane by a sine) or folded (a crease), paper may have worn rounded corners; a
  finger holds a page by an edge (never over a corner); occluders (the bank's cut-outs, else a pen, a phone, keys, a
  coin) lie over an edge or beside, never over a corner.
- The camera (gen/camera.py) gives one homography for the table and every page; a bent page's points go through the
  same camera with their height. Labels are projections of the pages' own corners and field boxes: exact (the tests
  measure the rendered edges against them: < 0.5 px).
- Light, a shadow under each page, a card's glare, then the phone's noise / blur / JPEG still come from synth_docs
  (light(), camera(), lay()'s shadow and glare).
Streams: scene (recipe, layout, camera, background, occluders), page (each page's drawing), camera (light and the
phone's effects) — gen.rng.streams."""
import math
from dataclasses import dataclass, field

import numpy as np

from . import camera as gcam

RECIPES = ("single", "pair", "card_on_sheet", "painted", "none", "partial")
WEIGHTS = {"single": 0.37, "pair": 0.30, "card_on_sheet": 0.15, "painted": 0.10, "none": 0.08, "partial": 0.0}
ANY_ANGLE = 0.15
BEND_SHARE, FOLD_SHARE, WORN_SHARE = 0.2, 0.12, 0.2      # of the paper pages
FINGER_SHARE, OCCLUDER_SHARE = 0.2, 0.3
BG_MM = (450.0, 1200.0)       # a background photo's long side on the table, mm
PROC_PPM, PROC_SIZE = 1.5, 1200
CORNER_KEEP = 5.0             # mm: a finger or an occluder stays this far from every document corner
SHEETS_ON = {"sefach": 0.65, "insert": 0.2, "other": 0.15}


# ---------- small geometry ----------
def _rot(deg):
    a = math.radians(deg)
    return np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])


def apply(M, pts):
    P = np.column_stack([np.asarray(pts, np.float64), np.ones(len(pts))]) @ np.asarray(M).T
    return P[:, :2] / P[:, 2:3]


def similarity(deg, scale, src_centre, dst_centre):
    """3 × 3: src → dst, turned deg, scaled, src_centre onto dst_centre."""
    R = _rot(deg) * scale
    t = np.asarray(dst_centre, np.float64) - R @ np.asarray(src_centre, np.float64)
    return np.array([[R[0, 0], R[0, 1], t[0]], [R[1, 0], R[1, 1], t[1]], [0, 0, 1]])


def poly_area(q):
    q = np.asarray(q, np.float64)
    return abs(float(np.dot(q[:, 0], np.roll(q[:, 1], -1)) - np.dot(np.roll(q[:, 0], -1), q[:, 1]))) / 2


def separated(P, Q, gap=0.0):
    """Two convex polygons more than gap apart along one of their edges' normals (SAT)."""
    for poly in (P, Q):
        n = len(poly)
        for i in range(n):
            e = np.asarray(poly[(i + 1) % n]) - np.asarray(poly[i])
            nrm = np.array([-e[1], e[0]]) / (np.hypot(*e) + 1e-12)
            a, b = np.asarray(P) @ nrm, np.asarray(Q) @ nrm
            if a.max() + gap < b.min() or b.max() + gap < a.min():
                return True
    return False


def angle(rng):
    """A page's turn on the table: mostly a quarter turn and a little, ANY_ANGLE of them any angle."""
    if rng.random() < ANY_ANGLE:
        return rng.uniform(0, 360)
    return rng.choice((0, 0, 0, 90, 90, 180, 270)) + rng.gauss(0, 5)


# ---------- a page on the plane ----------
@dataclass
class Placed:
    page: object          # gen.pages.Page
    A: np.ndarray         # the page's pixels (edges) → the plane (mm)
    inside_of: object = None
    bend: object = None   # {"kind": bend|fold, "axis": 0|1, "amp": mm, "shade": k}
    painted: bool = False
    role: str = ""
    index: int = 0

    def plane(self, pts):
        return apply(self.A, pts)

    def corners(self):
        return self.plane(self.page.quad())

    def s_of(self, pts):
        """Where along the bend's axis points of the page lie (0..1 over its rect)."""
        x0, y0, x1, y1 = self.page.rect
        P = np.asarray(pts, np.float64)
        return (P[:, 0] - x0) / (x1 - x0) if self.bend["axis"] == 0 else (P[:, 1] - y0) / (y1 - y0)

    def z(self, pts):
        """Each point's height (mm, < 0 toward the camera): 0 everywhere on a flat page and at every corner."""
        if not self.bend:
            return np.zeros(len(pts))
        s = np.clip(self.s_of(pts), 0, 1)
        if self.bend["kind"] == "bend":
            return -self.bend["amp"] * np.sin(np.pi * s)
        return -self.bend["amp"] * (1 - np.abs(2 * s - 1))

    def lift(self, pts):
        return np.column_stack([self.plane(pts), self.z(pts)])

    def shade(self, pts):
        """The light a bend or a crease's two sides catch (a factor per point)."""
        if not self.bend:
            return np.ones(len(pts))
        s, k = np.clip(self.s_of(pts), 0, 1), self.bend["shade"]
        if self.bend["kind"] == "bend":
            return 1 + k * np.cos(np.pi * s)
        return 1 + k * np.tanh((0.5 - s) * 40)

    def boundary(self, n=12):
        """Points along the page picture's outline (for the frame's region it covers)."""
        w, h = self.page.size_px
        t = np.linspace(0, 1, n, endpoint=False)
        pts = np.concatenate([np.column_stack([t * w, 0 * t]), np.column_stack([w + 0 * t, t * h]),
                              np.column_stack([w - t * w, h + 0 * t]), np.column_stack([0 * t, h - t * h])])
        return pts


@dataclass
class Pic:
    """A flat picture that is not a page (an occluder): only its size, for render_doc."""
    size_px: tuple
    rgba: object = None
    material: str = "occluder"

    @property
    def rect(self):
        return (0, 0, self.size_px[0], self.size_px[1])


def put(page, deg, centre):
    """A page turned deg about its own rect's centre, that centre at `centre` (mm)."""
    x0, y0, x1, y1 = page.rect
    return similarity(deg, 1.0 / page.ppm, ((x0 + x1) / 2, (y0 + y1) / 2), centre)


@dataclass
class Scene:
    recipe: str
    docs: list
    cam: object
    bg: dict
    occluders: list = field(default_factory=list)
    fingers: list = field(default_factory=list)
    worn: dict = field(default_factory=dict)


# ---------- planning ----------
def pick_recipe(rng, weights=None):
    w = {**WEIGHTS, **(weights or {})}
    names = [r for r in RECIPES if w.get(r, 0) > 0]
    return rng.choices(names, [w[r] for r in names])[0]


def _bend(rng, page, force=None):
    if page.material != "paper":
        return None
    r = rng.random()
    kind = force or ("bend" if r < BEND_SHARE else "fold" if r < BEND_SHARE + FOLD_SHARE else None)
    if not kind:
        return None
    size = min(page.size_mm)
    amp = rng.uniform(0.02, 0.07) * size if kind == "bend" else rng.uniform(0.01, 0.035) * size
    return {"kind": kind, "axis": rng.randrange(2), "amp": float(amp), "shade": float(rng.uniform(0.03, 0.12))}


def _near(rng, docs, page, deg, gap=(4.0, 40.0), tries=40):
    """A place for page beside the ones laid (none overlapping, at least gap[0] mm apart) → its A, or None."""
    for _ in range(tries):
        j = rng.choice(docs)
        cj = j.corners().mean(0)
        rj = float(np.linalg.norm(j.corners() - cj, axis=1).max())
        rn = math.hypot(*page.size_mm) / 2
        th = rng.uniform(0, 2 * math.pi)
        d = (rj + rn) * rng.uniform(0.7, 1.05) + rng.uniform(*gap)
        A = put(page, deg, cj + d * np.array([math.cos(th), math.sin(th)]))
        corners = apply(A, page.quad())
        if all(separated(corners, o.corners(), gap[0]) for o in docs):
            return A
    return None


def _on_sheet(rng, sheet, card, tries=30):
    """The card lying inside the sheet (a little turned, at least 3 mm in) → its A, or None."""
    x0, y0, x1, y1 = sheet.page.rect
    ws, hs = sheet.page.size_mm
    wc, hc = card.size_mm
    for _ in range(tries):
        a = rng.gauss(0, 5) + (90 if rng.random() < 0.1 else 0)
        c = np.array([rng.uniform(0, ws), rng.uniform(0, hs)])
        local = similarity(a, 1.0 / card.ppm, ((card.rect[0] + card.rect[2]) / 2, (card.rect[1] + card.rect[3]) / 2), c)
        q = apply(local, card.quad())
        if (q[:, 0] >= 3).all() and (q[:, 0] <= ws - 3).all() and (q[:, 1] >= 3).all() and (q[:, 1] <= hs - 3).all():
            to_sheet_px = np.array([[sheet.page.ppm, 0, x0], [0, sheet.page.ppm, y0], [0, 0, 1]])
            return sheet.A @ to_sheet_px @ local
    return None


def _worn(rng, page):
    """Paper with its corners a little rounded (worn): the page's alpha only, the corners' labels stay."""
    from PIL import Image, ImageDraw
    r = int(rng.uniform(1.0, 4.0) * page.ppm)
    a = Image.new("L", page.rgba.size, 0)
    x0, y0, x1, y1 = page.rect
    ImageDraw.Draw(a).rounded_rectangle((x0, y0, x1 - 1, y1 - 1), r, fill=255)
    im = page.rgba.copy()
    alpha = np.minimum(np.asarray(im.getchannel("A")), np.asarray(a))
    im.putalpha(Image.fromarray(alpha))
    page.rgba = im
    return r / page.ppm


def plan(rngs, pool, F, bank=None, occluders=None, recipe=None, weights=None, force_bend=None):
    """A scene: rngs {"scene", "page"} (random.Random each), pool (gen.pages.Pool), F (synth_docs.Fonts), bank
    (gen.backgrounds.Bank or None: procedural only), occluders (gen.backgrounds.Occluders or None). None when the
    camera found no pose (the caller draws the next recipe)."""
    rs, rp = rngs["scene"], rngs["page"]
    recipe = recipe or pick_recipe(rs, weights)
    docs, worn = [], {}
    if recipe in ("single", "partial"):
        pg = pool.any(rp, F)
        docs.append(Placed(pg, put(pg, angle(rs), (0.0, 0.0)), bend=_bend(rs, pg, force_bend)))
    elif recipe in ("pair", "painted"):
        n = 2 if recipe == "painted" else rs.choices((2, 3, 4), (0.75, 0.2, 0.05))[0]
        first = pool.any(rp, F)
        base = angle(rs)
        docs.append(Placed(first, put(first, base, (0.0, 0.0)), bend=_bend(rs, first, force_bend)))
        for _ in range(n - 1):
            pg = pool.any(rp, F)
            deg = base + rs.gauss(0, 6) if rs.random() < 0.6 else angle(rs)
            A = _near(rs, docs, pg, deg)
            if A is not None:
                docs.append(Placed(pg, A, bend=_bend(rs, pg, force_bend)))
        if len(docs) < 2:
            return None
        if recipe == "painted":
            docs[rs.randrange(2)].painted = True
    elif recipe == "card_on_sheet":
        kind = rs.choices(list(SHEETS_ON), list(SHEETS_ON.values()))[0]
        sheet_page = pool.page(rp, F, kind)
        if sheet_page.material == "card":   # a licence among the "other" pages: a sheet is wanted
            sheet_page = pool.page(rp, F, "sefach")
        sheet = Placed(sheet_page, put(sheet_page, angle(rs), (0.0, 0.0)))
        card_page = pool.page(rp, F, rs.choice(("id_front", "id_front", "id_back")))
        A = _on_sheet(rs, sheet, card_page)
        if A is None:
            return None
        docs = [sheet, Placed(card_page, A, inside_of=0)]
    elif recipe != "none":
        raise ValueError(f"unknown recipe {recipe!r}")
    for i, d in enumerate(docs):
        d.index = i
        if d.page.material == "paper" and not d.bend and rs.random() < WORN_SHARE:
            worn[i] = round(_worn(rs, d.page), 2)
    # the camera: every page in sight (partial: some of it out)
    if docs:
        pts = np.concatenate([d.lift(d.boundary(6))[:, :2] for d in docs] + [d.corners() for d in docs])
    else:
        w, h = rs.uniform(90, 300), rs.uniform(60, 220)
        pts = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    cam = gcam.sample(rs, pts, partial=recipe == "partial")
    if cam is None or (docs and not all((cam.depth(d.lift(d.boundary(6))) > 1).all() for d in docs)):
        return None
    # the background: on the same plane, at its physical size
    entry = bank.sample(rs, hard=recipe == "none" and rs.random() < 0.5) if bank is not None else None
    centre = np.array(cam.target) + np.array([rs.uniform(-100, 100), rs.uniform(-100, 100)])
    if entry:
        w, h = entry["size"]
        mm = float(entry.get("widthMm") or rs.uniform(*BG_MM))
        bg = {"entry": entry, "sha1": entry["sha1"], "category": entry.get("category"), "series": entry.get("series"),
              "A": similarity(rs.uniform(0, 360), mm / max(w, h), (w / 2, h / 2), centre), "kind": None, "mm": mm}
    else:
        seed = rs.randrange(1 << 30)
        bg = {"entry": None, "sha1": None, "category": "procedural", "seed": seed, "kind": None,
              "A": similarity(rs.uniform(0, 360), 1.0 / PROC_PPM, (PROC_SIZE / 2, PROC_SIZE / 2), centre)}
    sc = Scene(recipe, docs, cam, bg, worn=worn)
    _add_fingers(rs, sc)
    _add_occluders(rs, sc, occluders)
    return sc


def _corners_all(sc):
    return np.concatenate([d.corners() for d in sc.docs]) if sc.docs else np.zeros((0, 2))


def _far(poly, corners, keep=CORNER_KEEP):
    poly = np.asarray(poly)
    for c in corners:
        if _inside_poly(c, poly):
            return False
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            ab = b - a
            t = np.clip(np.dot(c - a, ab) / (np.dot(ab, ab) + 1e-12), 0, 1)
            if np.linalg.norm(a + t * ab - c) < keep:
                return False
    return True


def _inside_poly(p, poly):
    x, y, n, inside = p[0], p[1], len(poly), False
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def _ellipse(c, ax, half_len, half_w, n=24):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    u = np.array(ax) / (np.linalg.norm(ax) + 1e-12)
    v = np.array([-u[1], u[0]])
    return np.array([c + half_len * math.cos(a) * u + half_w * math.sin(a) * v for a in t])


def _add_fingers(rs, sc):
    tops = [d for d in sc.docs if d.inside_of is None and not d.painted]
    if not tops or sc.recipe == "partial" or rs.random() >= FINGER_SHARE:
        return
    d = rs.choice(tops)
    q = d.corners()
    corners = _corners_all(sc)
    for _ in range(10):
        i = rs.randrange(4)
        a, b = q[i], q[(i + 1) % 4]
        p = a + (b - a) * rs.uniform(0.3, 0.7)
        out = p - q.mean(0)
        out = out / (np.linalg.norm(out) + 1e-12)
        out = _rot(rs.uniform(-20, 20)) @ out
        half_len, half_w = rs.uniform(25, 42), rs.uniform(7, 10)
        inside = rs.uniform(6, 18)
        c = p + out * (half_len - inside)
        poly = _ellipse(c, out, half_len, half_w)
        if _far(poly, corners):
            skin = rs.choice(((150, 180, 225), (110, 150, 200), (80, 110, 160), (60, 80, 120)))
            sc.fingers.append({"poly": poly, "colour": skin, "doc": d.index})
            return


PROC_OCCLUDERS = ("pen", "phone", "keys", "coin")


def _proc_occluder(rs, kind):
    """A drawn occluder (RGBA numpy at 4 px/mm) and its long side (mm)."""
    import cv2
    ppm = 4
    if kind == "pen":
        L, W = rs.uniform(120, 150), rs.uniform(8, 11)
    elif kind == "phone":
        L, W = rs.uniform(140, 165), rs.uniform(68, 78)
    elif kind == "keys":
        L, W = rs.uniform(50, 80), rs.uniform(25, 40)
    else:
        L = W = rs.uniform(18, 28)
    w, h = int(L * ppm), int(W * ppm)
    img = np.zeros((h, w, 4), np.uint8)
    col = tuple(int(c) for c in (rs.randint(0, 255), rs.randint(0, 255), rs.randint(0, 255)))
    if kind == "phone":
        col = tuple(rs.randint(10, 50) for _ in range(3))
    if kind in ("pen", "phone"):
        r = h // 2 if kind == "pen" else int(8 * ppm)
        cv2.rectangle(img, (r, 0), (w - r, h - 1), (*col, 255), -1)
        cv2.circle(img, (r, h // 2), min(r, h // 2), (*col, 255), -1, cv2.LINE_AA) if kind == "pen" else None
        if kind == "phone":
            cv2.rectangle(img, (0, r), (w - 1, h - r), (*col, 255), -1)
            for cx, cy in ((r, r), (w - r, r), (r, h - r), (w - r, h - r)):
                cv2.circle(img, (cx, cy), r, (*col, 255), -1, cv2.LINE_AA)
            cv2.rectangle(img, (int(w * 0.05), int(h * 0.08)), (int(w * 0.95), int(h * 0.92)), (25, 25, 30, 255), -1)
        else:
            cv2.circle(img, (w - r, h // 2), h // 2, (*col, 255), -1, cv2.LINE_AA)
    elif kind == "keys":
        metal = tuple(rs.randint(140, 200) for _ in range(3))
        cv2.circle(img, (h // 2, h // 2), h // 2 - 2, (*metal, 255), 3, cv2.LINE_AA)
        cv2.rectangle(img, (h // 2, h // 3), (w - 2, 2 * h // 3), (*metal, 255), -1)
    else:
        metal = tuple(rs.randint(120, 210) for _ in range(3))
        cv2.circle(img, (w // 2, h // 2), w // 2 - 1, (*metal, 255), -1, cv2.LINE_AA)
    return img, L, kind, None


def _add_occluders(rs, sc, bank):
    if sc.recipe == "partial" or rs.random() >= OCCLUDER_SHARE:
        return
    corners = _corners_all(sc)
    for _ in range(rs.choice((1, 1, 2))):
        got = bank.sample(rs) if bank is not None and len(bank) and rs.random() < 0.7 else None
        img, L, kind, sha = got if got else _proc_occluder(rs, rs.choice(PROC_OCCLUDERS))
        h, w = img.shape[:2]
        for _ in range(12):
            if sc.docs and rs.random() < 0.6:   # over an edge of a page
                d = rs.choice(sc.docs)
                q = d.corners()
                i = rs.randrange(4)
                c = q[i] + (q[(i + 1) % 4] - q[i]) * rs.uniform(0.25, 0.75)
            else:
                c = np.array(sc.cam.target) + np.array([rs.uniform(-150, 150), rs.uniform(-150, 150)])
            A = similarity(rs.uniform(0, 360), L / max(w, h), (w / 2, h / 2), c)
            poly = apply(A, [[0, 0], [w, 0], [w, h], [0, h]])
            if _far(poly, corners):
                sc.occluders.append({"img": img, "A": A, "kind": kind, "sha1": sha, "mm": float(L)})
                break


# ---------- rendering ----------
def _pyramid(src, levels, out=None):
    """src and its halvings (INTER_AREA), up to `levels` of them; out: the list built so far (grown in place)."""
    import cv2
    out = out if out is not None else [src]
    if not out:
        out.append(src)
    for _ in range(levels - (len(out) - 1)):
        h, w = out[-1].shape[:2]
        if w < 2 or h < 2:
            break
        out.append(cv2.resize(out[-1], (max(1, round(w / 2)), max(1, round(h / 2))), interpolation=cv2.INTER_AREA))
    return out


def warp_mip(src, mx, my, border, max_level=7, pyr=None):
    """src sampled at (mx, my) — pixel edges of src, one per output pixel — through a mip pyramid (its level from the
    local scale of the map; two levels blended), so a page shrunk far is not aliased; pyr: src's pyramid so far (a list,
    grown and kept by the caller). → float32 output."""
    import cv2
    h, w = mx.shape
    if h >= 2 and w >= 2:
        dxx, dxy = np.gradient(mx, axis=1), np.gradient(mx, axis=0)
        dyx, dyy = np.gradient(my, axis=1), np.gradient(my, axis=0)
        s = np.sqrt(np.abs(dxx * dyy - dxy * dyx))
        lam = np.clip(np.log2(np.maximum(s, 1e-6)), 0, max_level)
    else:
        lam = np.zeros_like(mx)
    top = int(math.ceil(float(lam.max())))
    pyr = _pyramid(src, top, pyr)
    H0, W0 = src.shape[:2]
    ch = 1 if src.ndim == 2 else src.shape[2]
    out = np.zeros((h, w, ch), np.float32)
    lo = int(math.floor(float(lam.min())))
    for k in range(lo, min(top, len(pyr) - 1) + 1):
        wk = np.maximum(0.0, 1.0 - np.abs(lam - k)).astype(np.float32)
        if k == len(pyr) - 1:
            wk = np.where(lam >= k, 1.0, wk).astype(np.float32)
        if not wk.any():
            continue
        lv = pyr[k]
        fx, fy = lv.shape[1] / W0, lv.shape[0] / H0
        smp = cv2.remap(lv, (mx * fx - 0.5).astype(np.float32), (my * fy - 0.5).astype(np.float32), cv2.INTER_LINEAR,
                        borderMode=border, borderValue=0)
        if smp.ndim == 2:
            smp = smp[..., None]
        out += wk[..., None] * smp.astype(np.float32)
    return out


def _grid(x0, y0, x1, y1):
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    return xs + 0.5, ys + 0.5    # pixel centres in pixel-edge coordinates


def _to_plane(cam, xs, ys):
    Hi = np.linalg.inv(cam.Hm)
    P = np.stack([xs.ravel(), ys.ravel(), np.ones(xs.size)], 1) @ Hi.T
    return P[:, :2] / P[:, 2:3]


def doc_maps(cam, d, roi):
    """For the frame region roi (x0, y0, x1, y1): where each pixel's ray meets the page — the page's pixel edges
    (u, v), the page point the ray hits (a bent page: a few fixed-point steps through the camera with the heights)."""
    x0, y0, x1, y1 = roi
    xs, ys = _grid(x0, y0, x1, y1)
    Q = _to_plane(cam, xs, ys)
    X = Q.copy()
    Ai = np.linalg.inv(d.A)
    if d.bend:
        for _ in range(8):
            page = apply(Ai, X)
            g = cam.back(cam.project(np.column_stack([X, d.z(page)])))
            X = X + (Q - g)
    page = apply(Ai, X)
    return page[:, 0].reshape(xs.shape), page[:, 1].reshape(xs.shape)


def roi_of(cam, d, pad=0):
    uv = cam.project(d.lift(d.boundary(24)))
    x0, y0 = np.floor(uv.min(0)).astype(int) - 2 - pad
    x1, y1 = np.ceil(uv.max(0)).astype(int) + 2 + pad
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(cam.W, x1), min(cam.H, y1)
    return (x0, y0, x1, y1) if x1 > x0 + 1 and y1 > y0 + 1 else None


def prepare(rgba):
    """A picture (H × W × 4, BGR + alpha) ready to warp: premultiplied float32 and its pyramid (filled as needed)."""
    src = np.asarray(rgba).astype(np.float32)
    src[..., :3] *= src[..., 3:4] / 255.0
    return {"src": src, "pyr": [src]}


def render_doc(cam, d, rgba=None, pad=0, roi=None, prepared=None):
    """A page through the camera: (roi, its premultiplied BGR float32, its alpha 0..1 float32); rgba: an H × W × 4
    picture to put in place of the page's own (the tests' masks); roi: only this part of the frame (x0, y0, x1, y1) —
    each pixel is drawn the same as in the whole page's region; prepared: prepare(rgba) kept by a caller warping one
    picture many times."""
    import cv2
    roi = roi or roi_of(cam, d, pad)
    if roi is None:
        return None
    if prepared is None:
        if rgba is None:
            a = np.asarray(d.page.rgba)
            rgba = np.dstack([cv2.cvtColor(a[..., :3], cv2.COLOR_RGB2BGR), a[..., 3]])
        prepared = prepare(rgba)
    mu, mv = doc_maps(cam, d, roi)
    out = warp_mip(prepared["src"], mu, mv, cv2.BORDER_CONSTANT, pyr=prepared["pyr"])
    alpha = np.clip(out[..., 3] / 255.0, 0, 1)
    rgb = out[..., :3]
    if d.bend:
        rgb = rgb * d.shade(np.column_stack([mu.ravel(), mv.ravel()])).reshape(mu.shape)[..., None].astype(np.float32)
    return roi, rgb, alpha


def background_image(sc):
    import synth_docs as sd
    import random
    from . import backgrounds as gb
    if sc.bg.get("image") is not None:
        return sc.bg["image"]
    if sc.bg.get("entry"):
        img = gb.Bank.image(sc.bg["entry"])
        if img is not None:
            return img
    meta = {}
    img = sd.surface(random.Random(sc.bg.get("seed", 0)), PROC_SIZE, PROC_SIZE, meta)
    sc.bg["kind"] = meta.get("bgKind")
    return img


def render_background(sc):
    import cv2
    cam = sc.cam
    img = background_image(sc)
    xs, ys = _grid(0, 0, cam.W, cam.H)
    P = apply(np.linalg.inv(sc.bg["A"]), _to_plane(cam, xs, ys))
    out = warp_mip(img, P[:, 0].reshape(xs.shape), P[:, 1].reshape(xs.shape), cv2.BORDER_REFLECT_101)
    return out


def _shadow(frame, roi, alpha, rng, size):
    import cv2
    x0, y0, x1, y1 = roi
    dx, dy = int(round(size * rng.uniform(-0.02, 0.02))), int(round(size * rng.uniform(0.005, 0.03)))
    sh = np.zeros(frame.shape[:2], np.float32)
    H, W = sh.shape
    sx0, sy0 = max(0, x0 + dx), max(0, y0 + dy)
    sx1, sy1 = min(W, x1 + dx), min(H, y1 + dy)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    sh[sy0:sy1, sx0:sx1] = alpha[sy0 - y0 - dy:sy1 - y0 - dy, sx0 - x0 - dx:sx1 - x0 - dx]
    sh = cv2.GaussianBlur(sh, (0, 0), max(1.0, size * rng.uniform(0.004, 0.015)))
    frame *= (1 - rng.uniform(0.25, 0.55) * sh)[..., None]


def _glare(rgb, alpha, rng):
    h, w = alpha.shape
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2 + rng.uniform(-0.25, 0.25) * w, h / 2 + rng.uniform(-0.25, 0.25) * h
    r = rng.uniform(0.1, 0.35) * max(w, h)
    gl = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2 * rng.uniform(0.3, 3)) / (2 * r * r)) * alpha * rng.uniform(0.3, 0.8)
    return rgb * (1 - gl[..., None]) + 255 * gl[..., None] * alpha[..., None]


def paint(img, quads01):
    """The frame with quads (0..1) painted over in its border's colour (the lab's findNext): the scenes' next pictures and
    pull.painted (the scan attempts' painted pages) both paint this way."""
    import cv2
    img = img.copy()
    if quads01:
        h, w = img.shape[:2]
        border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
        colour = [int(v) for v in np.median(border, axis=0)]
        for q in quads01:
            cv2.fillPoly(img, [np.array([[x * w, y * h] for x, y in q], np.int32)], colour)
    return img


def render(sc, rng=None, effects=True):
    """The frame (BGR uint8, the camera's W × H): the background, each page (sheets before the cards on them) with its
    shadow and a card's glare, the occluders, a finger, a painted-over page, then (effects) light and the phone."""
    import cv2
    import random
    import synth_docs as sd
    rng = rng or random.Random(0)
    frame = render_background(sc)
    order = sorted(sc.docs, key=lambda d: (d.inside_of is not None, d.index))
    for d in order:
        got = render_doc(sc.cam, d)
        if got is None:
            continue
        roi, rgb, alpha = got
        x0, y0, x1, y1 = roi
        if effects and rng.random() < 0.7:
            _shadow(frame, roi, alpha, rng, max(x1 - x0, y1 - y0))
        if effects and d.page.material == "card" and rng.random() < 0.4:
            rgb = _glare(rgb, alpha, rng)
        part = frame[y0:y1, x0:x1]
        frame[y0:y1, x0:x1] = part * (1 - alpha[..., None]) + rgb
    for o in sc.occluders:
        img = o["img"]
        got = render_doc(sc.cam, Placed(Pic((img.shape[1], img.shape[0])), o["A"]), rgba=img)
        if got is None:
            continue
        roi, rgb, alpha = got
        x0, y0, x1, y1 = roi
        if effects:
            _shadow(frame, roi, alpha, rng, max(x1 - x0, y1 - y0))
        frame[y0:y1, x0:x1] = frame[y0:y1, x0:x1] * (1 - alpha[..., None]) + rgb
    img = np.clip(frame, 0, 255).astype(np.uint8)
    for f in sc.fingers:
        P = sc.cam.project(f["poly"])
        cv2.fillPoly(img, [np.round(P * 16).astype(np.int32)], f["colour"], cv2.LINE_AA, shift=4)
    painted = [q for d, q in zip(sc.docs, doc_quads01(sc)) if d.painted]
    if painted:
        img = paint(img, painted)
    if effects:
        sd.light(rng, img)
        img = sd.camera(rng.randrange(1 << 30))(image=img)["image"]
    return img


# ---------- labels ----------
def doc_quads(sc):
    """Each page's corners in the frame (pixel edges), its own top-left first."""
    return [sc.cam.project(d.corners()) for d in sc.docs]


def doc_quads01(sc):
    return [[[float(x) / sc.cam.W, float(y) / sc.cam.H] for x, y in q] for q in doc_quads(sc)]


def in_frame(sc, q):
    q = np.asarray(q)
    return bool(((q[:, 0] >= 0) & (q[:, 0] <= sc.cam.W) & (q[:, 1] >= 0) & (q[:, 1] <= sc.cam.H)).all())


def page_id(d):
    p = d.page
    if p.template_sha1:
        return "tpl:" + p.template_sha1[:12]
    return f"pdf:{p.file_sha1[:12]}" if getattr(p, "file_sha1", None) else f"{p.source}:{p.kind}"


def doc_labels(sc):
    """[{index, doctype, kind, source, material, quadDoc (px), quad01, quadModel (order_corners, 0..1), upright, insideOf,
    pageId, painted, visible, area, fields [{role, text, quad px}], face (quad px), mrz}] — the text as it is (the
    writers hash it before it reaches a manifest)."""
    import synth
    import synth_docs as sd
    out = []
    for d, q in zip(sc.docs, doc_quads(sc)):
        q01 = [[float(x) / sc.cam.W, float(y) / sc.cam.H] for x, y in q]
        model = synth.order_corners(q01)
        fields = []
        for role, text, fq in d.page.fields:
            fields.append({"role": role, "text": text, "quad": sc.cam.project(d.lift(fq)).tolist()})
        face = sc.cam.project(d.lift(d.page.face_box)).tolist() if d.page.face_box else None
        out.append({"index": d.index, "doctype": d.page.doctype, "kind": d.page.kind, "source": d.page.source,
                    "material": d.page.material, "quadDoc": q.tolist(), "quad01": q01, "quadModel": model,
                    "upright": sd.upright_index(model, q01[0]), "insideOf": d.inside_of, "pageId": page_id(d),
                    "painted": d.painted, "visible": in_frame(sc, q), "area": poly_area(q), "fields": fields,
                    "face": face, "mrz": d.page.mrz_text, "bend": d.bend, "templateSha1": d.page.template_sha1,
                    "fileSha1": getattr(d.page, "file_sha1", None), "seen": d.page.seen})
    return out


def roles(sc, labels=None):
    """The phone's order: the answer (the largest page in sight, not painted, not lying inside another), then the next
    ones (larger first), then the pages inside another (found on its flat cut). → [(label, role)]."""
    labels = labels or doc_labels(sc)
    tops = sorted([l for l in labels if l["insideOf"] is None and not l["painted"]], key=lambda l: -l["area"])
    out = [(l, "answer" if i == 0 else "next") for i, l in enumerate(tops)]
    out += [(l, "inside") for l in labels if l["insideOf"] is not None]
    return out
