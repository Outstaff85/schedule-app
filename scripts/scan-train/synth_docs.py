"""Made-up photos of documents for the document edges models (docs/scan-training.md → 4, "Made-up
documents"): an ID card (front, back), a passport's data page (often with the booklet's other page
above it), a ספח (a folded printed sheet) and a loose sheet put into a passport — each drawn flat
with made-up data (synth.py: no real person, every one marked SPECIMEN, no state's emblem), then
laid on a table, a cloth, a sheet or the owner's own background photos by a perspective of its own,
so its four corners are known exactly. Then what a phone does to a photo: a shadow under the page,
uneven light, a glare on a card, a finger on an edge, blur, noise, JPEG (Albumentations — colours
and quality only, never the geometry, so the corners stay true).

Real pages can be laid the same way (--templates, ~/.scan-train/templates/<kind>/: the cut pages of
the documents the site collected — pull_templates.py — or the owner's own photos of Israeli
documents, cut straight): a template is laid on the made-up photos like a drawn document — another
person's each time when its fields are marked (template_fields.json, template_vary.py: every value made
up, the photo a shape), else with its face and text washed out (a worker's data; --sharp keeps them), so a few real pages teach the
models how the firm's own documents look at the edge — the card's colour, the laminate, the ספח's
paper.

Some photos teach the other cases the site's examples teach: the first document found painted
over in the border's colour (as the next document search sees it — pull.painted) and "nothing
here" (no document; empty maps, as a deleted page).

Run on the owner's PC before train.py --synth; nothing is uploaded — the same seed draws the same
photos again, so only this script is kept.

  python synth_docs.py --count 20000                         # → ~/.scan-train/synth/docs/
  python synth_docs.py --count 20000 --backgrounds D:/backgrounds   # own table / floor photos too
  python synth_docs.py --count 20000 --templates             # + the real pages in ~/.scan-train/templates/
  python synth_docs.py --count 40 --show                     # + show/: the corners drawn, to look at
  python synth_docs.py --templates --exam                    # the exam photos of the real pages kept apart (exam.py)

Writes <out>/img/<n>.jpg (the long side 640) and <out>/examples.json in pull.py's form (fixed:
the corners 0..1, top-left first clockwise as the model gives them; null: nothing here).
Needs: pip install -r requirements-synth.txt."""
import argparse
import json
import pathlib
import random

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

import synth
from home import WORK, gentle
from synth_lines import hebrew_fonts

HERE = pathlib.Path(__file__).resolve().parent
OUT = WORK / "synth" / "docs"
EXAM_OUT = WORK / "synth" / "docs-exam"   # the exam photos of the real pages kept apart (exam.py)
OCRB = HERE / "fonts" / "OCRB.otf"
PX = 10            # pixels per millimetre of the flat documents
LONG = 640         # the saved photo's long side (the model sees it squeezed to 256×256)
SIZES = ((960, 1280), (1280, 960), (720, 1280), (1080, 1080), (1200, 900), (900, 1200))
KINDS = {"id_front": 0.24, "id_back": 0.16, "passport": 0.3, "sefach": 0.2, "insert": 0.1}
NONE_SHARE, PAINTED_SHARE = 0.05, 0.1
TEMPLATES = WORK / "templates"   # deleted by clean / publish
TEMPLATE_KINDS = ("id_front", "id_back", "passport", "sefach", "insert", "licence")   # a licence: "other" to the page kinds
WIDTH = {"id_front": 85.6, "id_back": 85.6, "licence": 85.6, "passport": 125.0}  # mm; a sheet keeps its own size
CARDS = ("id_front", "id_back", "licence")   # ID-1 cards: rounded corners, a laminate's glare
WIN_LATIN = ("arial.ttf", "arialbd.ttf", "times.ttf", "calibri.ttf", "verdana.ttf", "tahoma.ttf", "segoeui.ttf")
RTL = features.check("raqm")   # without libraqm (Pillow on Windows) the Hebrew is put in visual order by python-bidi


def latin_fonts():
    found = [str(p) for p in (pathlib.Path("C:/Windows/Fonts") / n for n in WIN_LATIN) if p.exists()]
    if found:
        return found
    return [str(p) for p in pathlib.Path("/usr/share/fonts").rglob("*.ttf")
            if p.name.startswith(("DejaVuSans", "LiberationSans", "LiberationSerif", "FreeSans"))][:8]


class Fonts:
    def __init__(self, latin, hebrew):
        self.latin, self.hebrew, self.cache = latin, hebrew, {}

    def get(self, which, size, rng):
        path = rng.choice(self.latin if which == "latin" else self.hebrew) if which != "mrz" else str(OCRB)
        key = (path, size)
        if key not in self.cache:
            self.cache[key] = ImageFont.truetype(path, size)
        return self.cache[key]


def put(d, xy, s, font, fill, rtl=False):
    """Text at xy (its left top; for Hebrew its right top)."""
    if not rtl:
        d.text(xy, s, font=font, fill=fill)
    elif RTL:
        d.text(xy, s, font=font, fill=fill, direction="rtl", anchor="ra")
    else:
        from bidi.algorithm import get_display
        d.text(xy, get_display(s), font=font, fill=fill, anchor="ra")


# ---------- the flat documents ----------

def pastel(rng, light=(200, 245)):
    return tuple(rng.randint(*light) for _ in range(3))


def security_print(rng, w, h, base):
    """A security-print-like ground: a soft gradient of a pale colour under fine wavy lines (a
    guilloche-like pattern of the document's own) — nothing of a real document's."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.ones((h, w, 3), np.float32) * np.array(base, np.float32)
    tint = np.array(pastel(rng, (150, 230)), np.float32)
    g = (xs / w * rng.uniform(-1, 1) + ys / h * rng.uniform(-1, 1)) * 0.5 + 0.5
    img = img * (1 - 0.35 * g[..., None]) + tint * 0.35 * g[..., None]
    for _ in range(rng.randint(1, 3)):
        k1, k2, a = rng.uniform(0.01, 0.05), rng.uniform(0.003, 0.02), rng.uniform(10, 60)
        phase = np.sin(xs * k1 + a * np.sin(ys * k2 + rng.uniform(0, 6)))
        if rng.random() < 0.5:
            cx, cy = rng.uniform(0, w), rng.uniform(0, h)
            phase = np.sin(np.hypot(xs - cx, ys - cy) * k1 * 2 + 4 * np.sin(np.arctan2(ys - cy, xs - cx) * rng.randint(6, 18)))
        line = (np.abs(phase) < rng.uniform(0.04, 0.12)).astype(np.float32)
        col = np.array(pastel(rng, (110, 210)), np.float32)
        img = img * (1 - 0.5 * line[..., None]) + col * 0.5 * line[..., None]
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def portrait(rng, w, h):
    """A holder's photo as a shape: a pale ground, a head and shoulders (no face of anyone)."""
    im = Image.new("RGB", (w, h), pastel(rng, (170, 235)))
    d = ImageDraw.Draw(im)
    skin = rng.choice(((224, 190, 160), (198, 150, 110), (150, 105, 75), (110, 75, 55), (235, 205, 180)))
    cloth = tuple(rng.randint(20, 120) for _ in range(3))
    d.ellipse((w * 0.05, h * 0.68, w * 0.95, h * 1.4), fill=cloth)
    d.ellipse((w * 0.27, h * 0.15, w * 0.73, h * 0.72), fill=skin)
    hair = tuple(rng.randint(10, 70) for _ in range(3))
    d.chord((w * 0.25, h * 0.1, w * 0.75, h * 0.55), 180, 360, fill=hair)
    return im.filter(ImageFilter.GaussianBlur(1.2))


def rounded(im, r):
    """The card with its corners rounded (the alpha), as an ID-1 card's are."""
    a = Image.new("L", im.size, 0)
    ImageDraw.Draw(a).rounded_rectangle((0, 0, im.size[0] - 1, im.size[1] - 1), r, fill=255)
    im = im.convert("RGBA")
    im.putalpha(a)
    return im


def fields(d, F, rng, x, y, w, rows, rtl, size, gap):
    """Label / value pairs down a column (the labels small and grey)."""
    for label, value in rows:
        lf, vf = F.get("hebrew" if rtl else "latin", size // 2, rng), F.get("hebrew" if rtl else "latin", size, rng)
        xx = x + w if rtl else x
        put(d, (xx, y), label, lf, (90, 90, 100), rtl)
        put(d, (xx, y + size // 2 + 4), value, vf, (15, 15, 25), rtl)
        y += size + size // 2 + gap
    return y


def he_value(rng, kind):
    while True:
        t, k = synth.he_line(rng)
        if k == kind:
            return t


def date(rng, y0, y1):
    y, m, dd = synth._yymmdd(rng, y0, y1)
    return f"{dd:02d}.{m:02d}.{y}"


def id_front(rng, F):
    w, h = int(85.6 * PX), int(54 * PX)
    im = security_print(rng, w, h, pastel(rng))
    d = ImageDraw.Draw(im)
    band = pastel(rng, (60, 160))
    d.rectangle((0, 0, w, int(h * rng.uniform(0.1, 0.16))), fill=band)
    title = rng.choice(("IDENTITY CARD", "תעודת זהות", "ID CARD", "תעודת זהות · IDENTITY CARD"))
    put(d, (w - 30, 12), title, F.get("hebrew", 30, rng), (250, 250, 250), True)
    photo_left = rng.random() < 0.6
    pw, ph = int(w * 0.28), int(h * 0.55)
    px = 30 if photo_left else w - pw - 30
    im.paste(portrait(rng, pw, ph), (px, int(h * 0.25)))
    if rng.random() < 0.5:
        g = portrait(rng, pw // 3, ph // 3).convert("L").convert("RGB")
        im.paste(Image.blend(g, Image.new("RGB", g.size, (235, 235, 235)), 0.6), (w // 2, h - ph // 3 - 20))
    tx0 = (px + pw + 30) if photo_left else 30
    tw = w - pw - 90
    rows = [("שם משפחה", he_value(rng, "surname")), ("שם פרטי", he_value(rng, "given")),
            ("תאריך לידה", date(rng, 1955, 2007)), ("מספר זהות", synth.israeli_id(rng))]
    fields(d, F, rng, tx0, int(h * 0.22), tw, rows, True, rng.randint(26, 34), 6)
    if rng.random() < 0.6:
        d.rounded_rectangle((px + pw // 4, int(h * 0.82), px + pw // 4 + 90, int(h * 0.82) + 70), 10, fill=(205, 175, 90))
    put(d, (w // 2 - 120, h // 2), "SPECIMEN", F.get("latin", 60, rng), tuple((c + 3 * 230) // 4 for c in band))
    return rounded(im, 3 * PX), (0, 0, w, h)


def id_back(rng, F):
    w, h = int(85.6 * PX), int(54 * PX)
    im = security_print(rng, w, h, pastel(rng))
    d = ImageDraw.Draw(im)
    y = 30
    for label in ("כתובת", "מקום לידה", "תאריך הנפקה", "מין"):
        v = {"כתובת": f"{he_value(rng, 'street')}, {he_value(rng, 'city')}", "מקום לידה": he_value(rng, "city"),
             "תאריך הנפקה": date(rng, 2010, 2025), "מין": rng.choice(("זכר", "נקבה"))}[label]
        y = fields(d, F, rng, 30, y, w - 60, [(label, v)], True, rng.randint(24, 30), 4)
    if rng.random() < 0.7:   # a barcode-like strip
        x, bw = 40, rng.randint(300, 500)
        while x < 40 + bw:
            t = rng.choice((2, 3, 4, 6))
            d.rectangle((x, h - 120, x + t, h - 40), fill=(20, 20, 20))
            x += t + rng.choice((2, 3, 5))
    else:                    # or three lines of a card's zone
        mf = F.get("mrz", 34, rng)
        for k in range(3):
            put(d, (30, h - 150 + k * 42), "".join(rng.choice(synth.MRZ_CHARS) for _ in range(30)), mf, (20, 20, 20))
    return rounded(im, 3 * PX), (0, 0, w, h)


def passport(rng, F):
    """The data page; often with the booklet's other page above it (the passport lies open): the
    corners are the data page's only."""
    w, h = int(125 * PX), int(88 * PX)
    im = security_print(rng, w, h, pastel(rng, (215, 245)))
    d = ImageDraw.Draw(im)
    l1, l2, f = synth.td3(rng)
    put(d, (40, 20), rng.choice(("PASSPORT", "PASSEPORT", "PASSPORT / PASAPORTE")), F.get("latin", 34, rng), (40, 40, 70))
    put(d, (w // 2, 24), "SPECIMEN", F.get("latin", 26, rng), (120, 60, 60))
    pw, ph = int(w * 0.26), int(h * 0.5)
    im.paste(portrait(rng, pw, ph), (40, 80))
    rows = [("Surname", f["surname"]), ("Given names", f["given"]), ("Nationality", f["nationality"] or f["country"]),
            ("Date of birth", f["dob"]), ("Sex", f["sex"] or "X"), ("Date of expiry", f["expiry"]), ("Passport No.", f["passportNo"])]
    sz = rng.randint(24, 30)
    half = (len(rows) + 1) // 2
    fields(d, F, rng, pw + 80, 80, 0, rows[:half], False, sz, 4)
    fields(d, F, rng, pw + 80 + int(w * 0.3), 80, 0, rows[half:], False, sz, 4)
    zone = int(h * 0.24)
    d.rectangle((0, h - zone, w, h), fill=pastel(rng, (225, 250)))
    mf = F.get("mrz", int(w / 44 * 1.55), rng)
    put(d, (36, h - zone + 20), l1, mf, (20, 20, 20))
    put(d, (36, h - zone + 20 + int(zone * 0.42)), l2, mf, (20, 20, 20))
    if rng.random() < 0.35:
        return im.convert("RGBA"), (0, 0, w, h)
    hu = int(h * rng.uniform(0.6, 1.0))   # the other page, part of it in the photo
    top = security_print(rng, w, hu, pastel(rng, (220, 248)))
    td = ImageDraw.Draw(top)
    for k in range(rng.randint(0, 3)):    # stamps
        cx, cy, r = rng.randint(100, w - 100), rng.randint(60, hu - 60), rng.randint(50, 110)
        col = rng.choice(((60, 70, 150), (150, 40, 50), (40, 110, 60)))
        td.ellipse((cx - r, cy - r, cx + r, cy + r), outline=col, width=4)
        put(td, (cx - r + 20, cy - 10), date(rng, 2018, 2026), F.get("latin", 22, rng), col)
    book = Image.new("RGB", (w, hu + h), (0, 0, 0))
    book.paste(top, (0, 0))
    book.paste(im, (0, hu))
    bd = ImageDraw.Draw(book)
    for k in range(10):                   # the gutter's fold
        c = 150 + k * 9
        bd.line((0, hu - 5 + k, w, hu - 5 + k), fill=(c, c, c))
    return book.convert("RGBA"), (0, hu, w, hu + h)


def paper(rng, w, h):
    base = rng.choice(((250, 250, 248), (245, 248, 252), (252, 249, 240), (240, 246, 250)))
    im = Image.new("RGB", (w, h), base)
    if rng.random() < 0.5:
        im = Image.blend(im, security_print(rng, w, h, base), 0.4)
    return im


def sefach(rng, F):
    """The ספח: a printed form on paper, folded; the part photographed varies in shape."""
    w = int(rng.uniform(140, 210) * PX)
    h = int(w / rng.uniform(0.65, 1.6))
    im = paper(rng, w, h)
    d = ImageDraw.Draw(im)
    sz = rng.randint(22, 30)
    put(d, (w - 40, 30), rng.choice(("ספח לתעודת זהות", "ספח", "פרטים אישיים")), F.get("hebrew", sz + 8, rng), (30, 30, 60), True)
    y = fields(d, F, rng, 40, 90, w - 80, [("שם משפחה", he_value(rng, "surname")), ("שם פרטי", he_value(rng, "given")),
                                         ("מספר זהות", synth.israeli_id(rng)), ("כתובת", f"{he_value(rng, 'street')} {he_value(rng, 'city')}")],
               True, sz, 8)
    rows = rng.randint(2, 6)              # a table: children / spouse
    cols = (0.3, 0.55, 0.8, 1.0)
    for r in range(rows + 1):
        yy = y + r * (sz + 18)
        if yy > h - 40:
            break
        d.line((40, yy, w - 40, yy), fill=(80, 80, 90), width=2)
        if r:
            put(d, (w - 50, yy - sz - 12), he_value(rng, "given"), F.get("hebrew", sz, rng), (20, 20, 30), True)
            put(d, (int(w * 0.5), yy - sz - 12), synth.israeli_id(rng), F.get("latin", sz, rng), (20, 20, 30))
            put(d, (60, yy - sz - 12), date(rng, 1995, 2024), F.get("latin", sz, rng), (20, 20, 30))
    for c in cols:
        x = 40 + int((w - 80) * c)
        d.line((x, y, x, min(h - 40, y + rows * (sz + 18))), fill=(80, 80, 90), width=2)
    put(d, (60, h - 60), "SPECIMEN", F.get("latin", 30, rng), (150, 80, 80))
    return folded(rng, im).convert("RGBA"), (0, 0, w, h)


def insert(rng, F):
    """A loose sheet put into a passport (a form, a residence notice): a passport page's size or a
    little bigger, printed, sometimes a stamp."""
    w = int(rng.uniform(120, 150) * PX)
    h = int(w / rng.uniform(1.25, 1.55)) if rng.random() < 0.7 else int(w * rng.uniform(1.2, 1.5))
    im = paper(rng, w, h)
    d = ImageDraw.Draw(im)
    rtl = rng.random() < 0.6
    sz = rng.randint(22, 30)
    y = 40
    for _ in range(rng.randint(5, 14)):
        if y > h - 60:
            break
        n = rng.randint(2, 7)
        if rtl:
            s = " ".join(he_value(rng, rng.choice(("given", "surname", "city", "street"))) for _ in range(n // 2 + 1))
        else:
            s = " ".join(rng.choice(synth.SURNAMES + synth.GIVEN) for _ in range(n))
        put(d, (w - 40 if rtl else 40, y), s, F.get("hebrew" if rtl else "latin", sz, rng), (25, 25, 35), rtl)
        y += sz + rng.randint(10, 26)
    if rng.random() < 0.6:
        cx, cy, r = rng.randint(120, w - 120), rng.randint(120, h - 120), rng.randint(60, 110)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(60, 70, 150), width=5)
    put(d, (40, h - 50), "SPECIMEN", F.get("latin", 26, rng), (150, 80, 80))
    return folded(rng, im).convert("RGBA"), (0, 0, w, h)


def folded(rng, im):
    """Paper as photographed: its fold lines and a gentle bow (the corners stay where they are)."""
    a = np.asarray(im).astype(np.float32)
    h, w = a.shape[:2]
    for _ in range(rng.randint(0, 2)):
        if rng.random() < 0.5:
            x = int(w * rng.uniform(0.3, 0.7))
            a[:, x - 2:x + 2] *= 0.85
            a[:, :x] *= rng.uniform(0.93, 1.0)
        else:
            y = int(h * rng.uniform(0.3, 0.7))
            a[y - 2:y + 2] *= 0.85
            a[:y] *= rng.uniform(0.93, 1.0)
    if rng.random() < 0.6:
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        amp = rng.uniform(0.004, 0.015)
        dy = amp * h * np.sin(np.pi * xs / w) * np.sin(np.pi * ys / h)   # zero on the sides: the corners stay
        dx = amp * w * 0.5 * np.sin(np.pi * ys / h) * np.sin(2 * np.pi * xs / w)
        a = cv2.remap(a, xs + dx, ys + dy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def templates_in(folder):
    """The real pages: [(path, kind)] — the kind by the folder each lies in (id_front, id_back,
    passport, sefach, insert; any other folder: a sheet)."""
    folder = pathlib.Path(folder)
    if not folder.is_dir():
        return []
    out = []
    for p in sorted(folder.rglob("*")):
        if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            import template_vary
            k = template_vary.kind_of(p, p.parent.name if p.parent.name in TEMPLATE_KINDS else "insert")
            out.append((str(p), k if k in TEMPLATE_KINDS else "insert"))
    return out


def kind_of_page(path, wanted):
    """A real page's own template kind (a licence, a loose sheet) — for the page kind it was picked as."""
    import template_vary
    p = pathlib.Path(path)
    return template_vary.kind_of(p, p.parent.name if p.parent.name in TEMPLATE_KINDS else ("insert" if wanted == "other" else wanted))


def washed(rng, F, im, kind):
    """A real page with its data washed out: everything blurred past reading (the layout's colours
    stay), then made-up text laid on it so it still looks printed."""
    w, h = im.size
    small = im.resize((max(8, w // 28), max(8, h // 28)), Image.BILINEAR)
    im = small.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
    d = ImageDraw.Draw(im)
    sz = max(14, h // 22)
    for _ in range(rng.randint(4, 10)):
        x, y = rng.randint(int(w * 0.35), int(w * 0.95)), rng.randint(int(h * 0.1), int(h * 0.85))
        t = he_value(rng, rng.choice(("given", "surname", "city", "date", "idNo")))
        put(d, (x, y), t, F.get("hebrew", sz, rng), (25, 25, 35), True)
    return im


def template(rng, F, path, kind, sharp):
    """A real page as a document to lay: (RGBA, its rect) — another person's document when its fields are
    marked (template_vary.py: every value made up, the photo a shape), else the page with its data washed
    out; at the drawn documents' scale, a card's corners rounded, its colours a little changed."""
    import template_vary
    spec = template_vary.spec_for(path)
    if spec and spec.get("fields"):
        im = template_vary.vary(rng, F.hebrew, path, spec)[0]
    else:
        im = Image.fromarray(cv2.cvtColor(template_vary.load_page(path, spec), cv2.COLOR_BGR2RGB))
    w, h = im.size
    if w < h and kind in WIDTH:
        im, (w, h) = im.rotate(90, expand=True), (h, w)   # a card or a passport page lies wide
    tw = int(WIDTH.get(kind, rng.uniform(140, 200)) * PX)
    im = im.resize((tw, max(8, round(h * tw / w))), Image.LANCZOS)
    if not sharp and not (spec and spec.get("fields")):
        im = washed(rng, F, im, kind)
    a = np.asarray(im).astype(np.float32) * np.array([rng.uniform(0.9, 1.1) for _ in range(3)], np.float32)
    im = Image.fromarray(np.clip(a + rng.uniform(-12, 12), 0, 255).astype(np.uint8))
    if kind in CARDS:
        return rounded(im, 3 * PX), (0, 0, im.size[0], im.size[1])
    return (folded(rng, im) if kind in ("sefach", "insert") else im).convert("RGBA"), (0, 0, im.size[0], im.size[1])


DRAW = {"id_front": id_front, "id_back": id_back, "passport": passport, "sefach": sefach, "insert": insert}


# ---------- the photo ----------

def background(rng, W, H, photos):
    if photos and rng.random() < 0.6:
        img = cv2.imread(rng.choice(photos))
        if img is not None:
            h, w = img.shape[:2]
            s = max(W / w, H / h) * rng.uniform(1.0, 1.6)
            img = cv2.resize(img, (int(w * s) + 1, int(h * s) + 1), interpolation=cv2.INTER_AREA)
            y, x = rng.randint(0, img.shape[0] - H), rng.randint(0, img.shape[1] - W)
            return img[y:y + H, x:x + W].copy()
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    kind = rng.choice(("plain", "wood", "cloth", "check", "dark", "sheet"))
    col = np.array([rng.randint(30, 230) for _ in range(3)], np.float32)
    noise = cv2.resize(np.random.default_rng(rng.randint(0, 1 << 30)).random((H // 16 + 1, W // 16 + 1)).astype(np.float32), (W, H))
    if kind == "wood":
        col = np.array(rng.choice(((60, 100, 150), (40, 70, 110), (90, 140, 190), (120, 160, 200))), np.float32)
        g = np.sin((ys * rng.uniform(0.02, 0.08) + 8 * noise) + np.sin(xs * 0.01) * 3) * 0.5 + 0.5
        img = col * (0.75 + 0.35 * g[..., None])
    elif kind == "cloth":
        g = (np.sin(xs * rng.uniform(0.8, 1.6)) * np.sin(ys * rng.uniform(0.8, 1.6))) * 0.5 + 0.5
        img = col * (0.8 + 0.25 * g[..., None])
    elif kind == "check":
        c2 = np.array([rng.randint(30, 230) for _ in range(3)], np.float32)
        s = rng.randint(30, 120)
        m = (((xs // s) + (ys // s)) % 2)[..., None]
        img = col * m + c2 * (1 - m)
    elif kind == "dark":
        img = np.ones((H, W, 3), np.float32) * rng.randint(10, 60)
    elif kind == "sheet":
        img = np.ones((H, W, 3), np.float32) * np.array(pastel(rng, (225, 252)), np.float32)
    else:
        img = np.ones((H, W, 3), np.float32) * col
    img = img * (0.85 + 0.3 * noise[..., None])
    img = np.clip(img, 0, 255).astype(np.uint8)
    for _ in range(rng.randint(0, 3)):    # things lying about: a sheet, a phone, a pen
        c = tuple(rng.randint(0, 255) for _ in range(3))
        x, y = rng.randint(-W // 4, W), rng.randint(-H // 4, H)
        if rng.random() < 0.3:
            cv2.line(img, (x, y), (x + rng.randint(-300, 300), y + rng.randint(-300, 300)), c, rng.randint(4, 12))
        else:
            box = cv2.boxPoints(((x, y), (rng.randint(60, W // 3), rng.randint(60, H // 3)), rng.uniform(0, 90)))
            cv2.fillPoly(img, [box.astype(np.int32)], c)
    return img


def lay(rng, img, doc, rect, quad, card):
    """The flat document laid on the photo: its rect (x0, y0, x1, y1) of the flat picture onto quad,
    with a shadow under it, and a glare on a card. → the document's mask on the photo."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = rect
    M = cv2.getPerspectiveTransform(np.float32([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), np.float32(quad))
    a = np.asarray(doc)
    rgb = cv2.warpPerspective(cv2.cvtColor(a[..., :3], cv2.COLOR_RGB2BGR), M, (W, H), flags=cv2.INTER_AREA)
    alpha = cv2.warpPerspective(a[..., 3], M, (W, H), flags=cv2.INTER_LINEAR).astype(np.float32) / 255
    if rng.random() < 0.7:
        dx, dy = rng.randint(-15, 15), rng.randint(2, 20)
        sh = cv2.GaussianBlur(np.roll(np.roll(alpha, dy, 0), dx, 1), (0, 0), rng.uniform(4, 14))
        img[:] = (img * (1 - rng.uniform(0.25, 0.55) * sh[..., None])).astype(np.uint8)
    out = img.astype(np.float32) * (1 - alpha[..., None]) + rgb.astype(np.float32) * alpha[..., None]
    if card and rng.random() < 0.4:      # the laminate's glare
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        cx, cy = np.mean([p[0] for p in quad]) + rng.uniform(-80, 80), np.mean([p[1] for p in quad]) + rng.uniform(-60, 60)
        r = rng.uniform(40, 160)
        gl = np.exp(-((xs - cx) ** 2 + (ys - cy) ** 2 * rng.uniform(0.3, 3)) / (2 * r * r)) * alpha * rng.uniform(0.3, 0.8)
        out = out * (1 - gl[..., None]) + 255 * gl[..., None]
    img[:] = np.clip(out, 0, 255).astype(np.uint8)
    return alpha


def light(rng, img):
    """Uneven light: a slope or a pool of it, a colour cast."""
    H, W = img.shape[:2]
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    if rng.random() < 0.5:
        g = 1 + rng.uniform(-0.35, 0.35) * ((xs / W - 0.5) * rng.uniform(-1, 1) + (ys / H - 0.5) * rng.uniform(-1, 1))
    else:
        cx, cy = rng.uniform(0, W), rng.uniform(0, H)
        g = 1.15 - rng.uniform(0.2, 0.5) * np.hypot((xs - cx) / W, (ys - cy) / H)
    cast = np.array([rng.uniform(0.9, 1.1) for _ in range(3)], np.float32)
    img[:] = np.clip(img * g[..., None] * cast, 0, 255).astype(np.uint8)


def finger(rng, img, quad):
    """A finger holding the page by one side (not over a corner)."""
    i = rng.randint(0, 3)
    a, b = np.array(quad[i]), np.array(quad[(i + 1) % 4])
    t = rng.uniform(0.3, 0.7)
    p = a + (b - a) * t
    out = p - np.array([np.mean([q[0] for q in quad]), np.mean([q[1] for q in quad])])
    out = out / (np.linalg.norm(out) + 1e-6)
    skin = rng.choice(((150, 180, 225), (110, 150, 200), (80, 110, 160), (60, 80, 120)))
    L, Wd = rng.uniform(90, 200), rng.uniform(40, 70)
    c = p + out * L * 0.35
    ang = float(np.degrees(np.arctan2(out[1], out[0])))
    cv2.ellipse(img, (int(c[0]), int(c[1])), (int(L / 2), int(Wd / 2)), ang, 0, 360, skin, -1, cv2.LINE_AA)


def camera(seed):
    """What a phone does to a photo — colours and quality only (the corners stay true)."""
    import albumentations as A
    return A.Compose([
        A.RandomBrightnessContrast(brightness_limit=0.25, contrast_limit=0.25, p=0.8),
        A.RandomGamma(gamma_limit=(70, 140), p=0.4),
        A.HueSaturationValue(hue_shift_limit=8, sat_shift_limit=20, val_shift_limit=10, p=0.4),
        A.RandomShadow(shadow_roi=(0, 0, 1, 1), num_shadows_limit=(1, 2), shadow_dimension=5, shadow_intensity_range=(0.15, 0.4), p=0.15),
        A.OneOf([A.GaussianBlur(blur_limit=(3, 7)), A.MotionBlur(blur_limit=(3, 9)), A.Defocus(radius=(1, 3))], p=0.5),
        A.OneOf([A.GaussNoise(std_range=(0.02, 0.08)), A.ISONoise(color_shift=(0.01, 0.05), intensity=(0.1, 0.5))], p=0.5),
        A.Downscale(scale_range=(0.4, 0.9), p=0.2),
        A.ImageCompression(quality_range=(45, 95), p=0.7),
    ], seed=seed)


def border_colour(img):
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    return [int(v) for v in np.median(border, axis=0)]


def document(rng, F, tpl):
    """A document to lay: (RGBA, rect, kind, card) — a real page (tpl: (pages, share, sharp)) or a drawn one."""
    pages, share, sharp = tpl
    if pages and rng.random() < share:
        path, kind = rng.choice(pages)
        doc, rect = template(rng, F, path, kind, sharp)
        return doc, rect, "template:" + kind, kind in CARDS
    kind = rng.choices(list(KINDS), list(KINDS.values()))[0]
    doc, rect = DRAW[kind](rng, F)
    return doc, rect, kind, kind.startswith("id")


def photo(rng, F, photos, tpl=((), 0, False)):
    """One made-up photo: (BGR image at LONG, the corners 0..1 or None, the kind)."""
    W, H = rng.choice(SIZES)
    img = background(rng, W, H, photos)
    none = rng.random() < NONE_SHARE
    two = not none and rng.random() < PAINTED_SHARE   # another document found first, painted over
    quad = painted = None
    if not none:
        doc, rect, kind, card = document(rng, F, tpl)
        quad = synth.scene_quad(rng, (rect[2] - rect[0]) / (rect[3] - rect[1]), W, H, fill=(0.15, 0.45) if two else (0.18, 0.8))
        none = quad is None
    if two and quad:
        d2, r2, _, card2 = document(rng, F, tpl)
        for _ in range(10):
            q2 = synth.scene_quad(rng, (r2[2] - r2[0]) / (r2[3] - r2[1]), W, H, fill=(0.1, 0.3))
            if q2 and not _overlaps(quad, q2, W, H):
                lay(rng, img, d2, r2, q2, card2)
                painted = [q2]
                break
    if quad:
        lay(rng, img, doc, rect, quad, card)
        if rng.random() < 0.25:
            finger(rng, img, quad)
    if painted:
        col = border_colour(img)
        for q in painted:
            cv2.fillPoly(img, [np.array(q, np.int32)], col)
    light(rng, img)
    img = camera(rng.randint(0, 1 << 30))(image=img)["image"]
    s = LONG / max(W, H)
    img = cv2.resize(img, (round(W * s), round(H * s)), interpolation=cv2.INTER_AREA)
    if none:
        return img, None, "none"
    return img, synth.order_corners([[x / W, y / H] for x, y in quad]), kind


def _overlaps(a, b, W, H):
    m1, m2 = np.zeros((H // 8, W // 8), np.uint8), np.zeros((H // 8, W // 8), np.uint8)
    cv2.fillPoly(m1, [(np.array(a) / 8).astype(np.int32)], 1)
    cv2.fillPoly(m2, [(np.array(b) / 8).astype(np.int32)], 1)
    return (m1 & m2).sum() > 0.02 * m1.sum()


def _batch(job):
    seed, start, n, folder, latin, hebrew, photos, show, tpl = job
    F = Fonts(latin, hebrew)
    out = []
    for i in range(start, start + n):
        rng = random.Random(seed * 1_000_003 + i)
        img, corners, kind = photo(rng, F, photos, tpl)
        f = pathlib.Path(folder) / "img" / f"{i}.jpg"
        cv2.imwrite(str(f), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if show:
            v = img.copy()
            if corners:
                P = np.array([[x * v.shape[1], y * v.shape[0]] for x, y in corners], np.int32)
                cv2.polylines(v, [P], True, (0, 255, 0), 2)
                cv2.circle(v, tuple(int(c) for c in P[0]), 7, (0, 0, 255), -1)   # the first corner
            cv2.putText(v, kind, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
            cv2.imwrite(str(pathlib.Path(folder) / "show" / f"{i}.jpg"), v)
        out.append({"id": f"syn-{seed}-{i}", "file": str(f), "model": None, "fixed": corners, "moved": 0,
                    "exam": False, "synth": True, "kind": kind, "none": corners is None})
    return out


def draw(count, out, seed=1, jobs=1, photos=(), show=False, latin=None, hebrew=None, tpl=((), 0, False)):
    folder = pathlib.Path(out)
    (folder / "img").mkdir(parents=True, exist_ok=True)
    if show:
        (folder / "show").mkdir(exist_ok=True)
    latin, hebrew = latin or latin_fonts(), hebrew or hebrew_fonts()
    if not latin or not hebrew:
        raise SystemExit("no Latin or Hebrew font found: give --latin / --hebrew")
    work = [(seed, s, min(200, count - s), str(folder), latin, hebrew, list(photos), show, tpl) for s in range(0, count, 200)]
    if jobs > 1:
        from multiprocessing import Pool
        with Pool(jobs) as pool:
            done = pool.map(_batch, work)
    else:
        done = [_batch(w) for w in work]
    ex = [e for b in done for e in b]
    (folder / "examples.json").write_text(json.dumps(ex, ensure_ascii=False), encoding="utf-8")
    return folder, ex


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--jobs", type=int, default=gentle())
    ap.add_argument("--backgrounds", help="a folder of background photos (tables, floors, cloths — no documents in them)")
    ap.add_argument("--show", action="store_true", help="also show/<n>.jpg with the corners drawn (green; red: the first)")
    ap.add_argument("--templates", nargs="?", const=str(TEMPLATES), help="real pages laid like the drawn ones "
                    "(a folder with id_front/, id_back/, passport/, sefach/, insert/; default ~/.scan-train/templates)")
    ap.add_argument("--template-share", type=float, default=0.4, help="the share of photos with a real page")
    ap.add_argument("--sharp", action="store_true", help="keep the real pages' face and text as they are (not washed out)")
    ap.add_argument("--exam", action="store_true", help="the exam photos: only the real pages kept apart (synth.held_out), "
                    "every photo with one; default out ~/.scan-train/synth/docs-exam, 300 photos, its own seed")
    ap.add_argument("--latin", nargs="*")
    ap.add_argument("--hebrew", nargs="*")
    a = ap.parse_args()
    photos = []
    if a.backgrounds:
        photos = [str(p) for p in pathlib.Path(a.backgrounds).rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    pages = templates_in(a.templates) if a.templates else []
    if a.templates and not pages:
        raise SystemExit(f"no pages in {a.templates} — run pull_templates.py or put photos into its id_front/, sefach/… folders")
    kept = [pg for pg in pages if synth.held_out(pg[0])]
    if a.exam:
        if not kept:
            raise SystemExit("no real page is kept apart for the exam — put more pages into the templates folder")
        if a.out == str(OUT):
            a.out = str(EXAM_OUT)
        if a.count == 20000:
            a.count = 300
        if a.seed == 1:
            a.seed = 7
        pages, a.template_share = kept, 1.0
        print(f"exam photos from {len(kept)} real pages kept apart: " + ", ".join(pathlib.Path(p).name for p, _ in kept))
    elif kept:
        pages = [pg for pg in pages if not synth.held_out(pg[0])]
        print(f"{len(kept)} real pages kept apart for the exam (synth_docs.py --templates --exam), {len(pages)} laid here")
    folder, ex = draw(a.count, a.out, a.seed, a.jobs, photos, a.show, a.latin, a.hebrew, (pages, a.template_share, a.sharp))
    by = {}
    for e in ex:
        by[e["kind"]] = by.get(e["kind"], 0) + 1
    print(f"{len(ex)} photos in {folder}: " + ", ".join(f"{k} {n}" for k, n in sorted(by.items())))


if __name__ == "__main__":
    main()
