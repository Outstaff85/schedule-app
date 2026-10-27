"""Contract templates (docs/contracts.md → Contract templates, D2).

A firm's contract is a PDF with marks typed in its text — {{given}}, {{id}},
{{signature}}… (MARKS). On upload the PDF is made light (light(): only the
letters each font needs, pictures at 200 dpi JPEG, PDF/A extras and anything
unused dropped) and checked against the original (every page looks the same
at 100 dpi, every mark is still found); only the light one is kept. Filling
(fill()) whites out each mark and writes its value in its place — Hebrew right
to left (python-bidi, the Heebo font, as Form 101), shrunk to fit the mark's
width —, the signature a picture fitted above the mark; the firm's signature and
stamp (seal.py) at their marks and, when the template has it ticked, at the bottom
right of every page — the signature first, the stamp over it. A page that is only a
picture (a scan) has no text: its marks are placed by hand (`placed`: page,
x, y, w, h in PDF points from the page's top left) and filled the same way.

The server side of Admin → Contract templates is run(): every action of the
`contracts` function (functions/main.py), with the Firestore client, the
Storage bucket and the caller's verified claims. A firm sees only its own
templates: tenants/<t>/contractTemplates/<id> (no client reads or writes it —
firestore.rules grant nothing) and the file at tenants/<t>/contracts/<id>/<ms>.pdf.
"""

import base64
import io
import re
import time
import uuid

import pymupdf
from bidi.algorithm import get_display

# The marks (docs/contracts.md → The marks), in the order the upload lists them.
WORKER_MARKS = ("given", "surname", "full_name", "id", "id_type", "id_expiry", "dob", "sex", "marital",
                "phone", "address", "city", "full_address", "health_fund")
WORK_MARKS = ("start_date", "end_date", "contract_months", "site", "supplier", "schedule")
PAY_MARKS = ("rate", "pay_mode", "ot_rate", "shabbat_rate", "travel", "bank")
FIRM_MARKS = ("company", "company_address", "company_phone", "deductions_file")
# The firm's signature and stamp (seal.py): pictures, drawn at their marks — the signature first, the stamp over it.
SEAL_MARKS = ("company_signature", "stamp")
TERMS_MARKS = ("terms_1", "terms_2", "terms_3", "terms_4", "terms_5")
SIGN_MARKS = ("signature", "sign_date", "today")
MARKS = WORKER_MARKS + WORK_MARKS + PAY_MARKS + FIRM_MARKS + SEAL_MARKS + TERMS_MARKS + SIGN_MARKS
MARK_RE = re.compile(r"\{\{([A-Za-z0-9_]+)\}\}")
# In a Hebrew line a PDF may keep its text in visual order: the braces come out mirrored.
MIRROR_RE = re.compile(r"\}\}([A-Za-z0-9_]+)\{\{")
HEBREW_RE = re.compile(r"[֐-׿]")

# Made-up values for the sample PDF the admin sees on upload.
SAMPLE_VALUES = {
    "given": "ישראל", "surname": "ישראלי", "full_name": "ישראל ישראלי", "id": "123456782", "id_type": "ת.ז.",
    "id_expiry": "01/01/2030", "dob": "01/01/1990", "sex": "זכר", "marital": "נשוי/אה", "phone": "050-1234567",
    "address": "הרצל 1", "city": "חיפה", "full_address": "הרצל 1, חיפה", "health_fund": "כללית",
    "start_date": "01/01/2026", "end_date": "01/01/2027", "contract_months": "12", "site": "אתר לדוגמה",
    "supplier": "ספק לדוגמה", "schedule": "א׳–ה׳ 08:00–17:00", "rate": "40 ₪", "pay_mode": "שעתי",
    "ot_rate": "50 ₪", "shabbat_rate": "60 ₪", "travel": "22 ₪ ליום", "bank": "לאומי 10, סניף 800, חשבון 123456",
    "company": "חברה לדוגמה בע״מ", "company_address": "הנמל 5, חיפה", "company_phone": "04-1234567",
    "deductions_file": "912345678", "terms_1": "תנאי מיוחד 1", "terms_2": "תנאי מיוחד 2", "terms_3": "תנאי מיוחד 3",
    "terms_4": "תנאי מיוחד 4", "terms_5": "תנאי מיוחד 5", "sign_date": "01/01/2026", "today": "01/01/2026",
}

FONT_NAME = "Heebo"
MIN_SHRINK = 0.7        # a long value is shrunk to fit its place, to 70 % of the text's size at most
LIGHT_DPI = 200         # pictures in a light template
CHECK_DPI = 100         # the light one is compared with the original at this resolution
CHECK_MEAN = 6.0        # mean difference per channel (0..255) allowed for a page with no picture
CHECK_MEAN_PICTURE = 14.0  # …and for a page with a picture (shrunk to 200 dpi)
HEAVY_BYTES = 1024 * 1024  # a light template still over this goes to Admin → Errors
MAX_UPLOAD = 25 * 1024 * 1024
MAX_PAGES = 30
PREVIEW_DPI = 60

E_NOT_PDF = "This file is not a PDF"
E_TOO_BIG = "The file is too big (25 MB at most)"
E_TOO_MANY_PAGES = "The contract has too many pages (30 at most)"
E_CHECK = "The light copy does not look like the original"
E_MARKS_LOST = "A mark was lost when the file was made light"


def _open(data):
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception:
        raise ValueError(E_NOT_PDF)
    if not doc.is_pdf or doc.page_count == 0:
        raise ValueError(E_NOT_PDF)
    if doc.needs_pass:
        raise ValueError(E_NOT_PDF)
    return doc


# ---- marks -------------------------------------------------------------------

def _chars(page):
    """The page's characters with their boxes."""
    out = []
    for b in page.get_text("rawdict")["blocks"]:
        for line in b.get("lines", []):
            for span in line["spans"]:
                for ch in span["chars"]:
                    out.append((ch["c"], pymupdf.Rect(ch["bbox"])))
    return out


def _braces(chars, rect, side):
    """The rect of the two braces next to a mark's name on one side, or None. Spaces between are
    allowed (a Hebrew line may come out with its braces mirrored and apart from the name)."""
    h = rect.height or 10
    near = [(c, r) for c, r in chars
            if r.y1 > rect.y0 + h * 0.2 and r.y0 < rect.y1 - h * 0.2
            and ((side < 0 and r.x1 <= rect.x0 + 0.5 and r.x0 >= rect.x0 - 4 * h)
                 or (side > 0 and r.x0 >= rect.x1 - 0.5 and r.x1 <= rect.x1 + 4 * h))]
    near.sort(key=lambda cr: (rect.x0 - cr[1].x1) if side < 0 else (cr[1].x0 - rect.x1))
    got = []
    for c, r in near:
        if c in "{}":
            got.append(r)
            if len(got) == 2:
                return got[0] | got[1]
        elif not c.isspace():
            return None
    return None


def find_marks(doc):
    """Every mark in the PDF's text → (found, unknown): found = [{mark, page, rect, size, rtl}],
    unknown = the names in double braces that are not marks (a typo). A mark is its name with two
    braces on each side, whatever their direction: in a Hebrew line a PDF may keep its text in
    visual order, and the braces come out mirrored (the name in Latin letters stays as typed)."""
    found, unknown = [], []
    for pno, page in enumerate(doc):
        text = re.sub(r"\s*\n\s*", "", page.get_text())
        names = []
        for m in list(MARK_RE.finditer(text)) + list(MIRROR_RE.finditer(text)):
            n = m.group(1)
            if n not in names:
                names.append(n)
        # A Hebrew line may come out with its letters interleaved (LibreOffice's PDF): every known
        # mark whose name is in the text is a candidate; the braces around it decide (_braces).
        if "{" in text or "}" in text:
            names += [n for n in MARKS if n in text and n not in names]
        chars = None
        for name in names:
            if name not in MARKS:
                if name not in unknown:
                    unknown.append(name)
                continue
            chars = chars if chars is not None else _chars(page)
            seen = []
            for r in page.search_for(name):
                left, right = _braces(chars, r, -1), _braces(chars, r, 1)
                if not left or not right:
                    continue
                full = r | left | right
                if any(abs(full.x0 - q.x0) < 1 and abs(full.y0 - q.y0) < 1 for q in seen):
                    continue
                seen.append(full)
                size, rtl = _span_at(page, full)
                found.append({"mark": name, "page": pno, "rect": [round(full.x0, 2), round(full.y0, 2), round(full.x1, 2), round(full.y1, 2)],
                              "size": size, "rtl": rtl})
    found.sort(key=lambda f: (f["page"], f["rect"][1], f["rect"][0]))
    return found, unknown


def _span_at(page, rect):
    """The font size of the text at the mark, and whether its line is Hebrew (right to left)."""
    size, rtl = round(rect.height * 0.8, 1), False
    try:
        for b in page.get_text("dict", clip=pymupdf.Rect(rect.x0 - 2000, rect.y0, rect.x1 + 2000, rect.y1))["blocks"]:
            for line in b.get("lines", []):
                lr = pymupdf.Rect(line["bbox"])
                if lr.y1 < rect.y0 or lr.y0 > rect.y1:
                    continue
                txt = "".join(s["text"] for s in line["spans"])
                if HEBREW_RE.search(txt):
                    rtl = True
                for s in line["spans"]:
                    if "{{" in s["text"] or pymupdf.Rect(s["bbox"]).intersects(rect):
                        size = round(s["size"], 1)
    except Exception:
        pass
    return size, rtl


def picture_pages(doc):
    """The pages that are only a picture (a scan, Print to PDF): no text, an image on most of the page."""
    out = []
    for pno, page in enumerate(doc):
        if page.get_text().strip():
            continue
        area = abs(page.rect)
        covered = 0.0
        for info in page.get_image_info():
            covered += abs(pymupdf.Rect(info["bbox"]) & page.rect)
        if area and covered / area > 0.5:
            out.append(pno)
    return out


# ---- making it light -----------------------------------------------------------

def _save(doc):
    return doc.tobytes(garbage=4, deflate=True, clean=True, deflate_images=True, deflate_fonts=True)


def light(data):
    """The firm's standard light template from an uploaded PDF → (light bytes, info).
    Raises ValueError with the reason when it can't be made light safely."""
    if len(data) > MAX_UPLOAD:
        raise ValueError(E_TOO_BIG)
    orig = _open(data)
    if orig.page_count > MAX_PAGES:
        raise ValueError(E_TOO_MANY_PAGES)
    marks_before, unknown = find_marks(orig)
    pictures = picture_pages(orig)
    doc = _open(data)
    doc.subset_fonts()
    doc.rewrite_images(dpi_threshold=LIGHT_DPI + 10, dpi_target=LIGHT_DPI, quality=80, lossy=True, lossless=True, bitonal=False)
    try:
        doc.del_xml_metadata()
    except Exception:
        pass
    out = _save(doc)
    if len(out) >= len(data):  # nothing to win: the cleaned original as it was
        out = _save(_open(data))
        if len(out) >= len(data):
            out = data
    lit = _open(out)
    marks_after, _ = find_marks(lit)
    if sorted((m["mark"], m["page"]) for m in marks_after) != sorted((m["mark"], m["page"]) for m in marks_before):
        raise ValueError(E_MARKS_LOST)
    ok, worst = same_look(orig, lit)
    if not ok:
        raise ValueError(E_CHECK + " (page " + str(worst + 1) + ")")
    reasons = []
    if len(out) > HEAVY_BYTES:
        if pictures:
            reasons.append("pages that are pictures")
        if any(f[1] != "n/a" and "+" not in str(f[3]) for p in lit for f in p.get_fonts()):
            reasons.append("whole fonts")
        if any(lit.extract_image(i[0]).get("width", 0) > 2500 for p in lit for i in p.get_images()):
            reasons.append("big pictures")
    return out, {"origSize": len(data), "lightSize": len(out), "pages": lit.page_count, "pictures": pictures,
                 "found": marks_after, "unknown": unknown, "heavy": len(out) > HEAVY_BYTES, "heavyReasons": reasons}


def same_look(a, b):
    """Every page rendered at CHECK_DPI looks the same → (ok, the worst page)."""
    from PIL import Image, ImageChops, ImageStat
    if a.page_count != b.page_count:
        return False, 0
    for pno in range(a.page_count):
        pa, pb = a[pno].get_pixmap(dpi=CHECK_DPI, alpha=False), b[pno].get_pixmap(dpi=CHECK_DPI, alpha=False)
        if (pa.width, pa.height) != (pb.width, pb.height):
            return False, pno
        ia = Image.frombytes("RGB", (pa.width, pa.height), pa.samples)
        ib = Image.frombytes("RGB", (pb.width, pb.height), pb.samples)
        mean = sum(ImageStat.Stat(ImageChops.difference(ia, ib)).mean) / 3
        limit = CHECK_MEAN_PICTURE if a[pno].get_images() else CHECK_MEAN
        if mean > limit:
            return False, pno
    return True, -1


def previews(doc, dpi=PREVIEW_DPI):
    """Each page as a small PNG (placing marks by hand), with its size in points."""
    out = []
    for page in doc:
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        out.append({"w": round(page.rect.width, 2), "h": round(page.rect.height, 2),
                    "png": base64.b64encode(pix.tobytes("png")).decode()})
    return out


# ---- filling ---------------------------------------------------------------------

def _font():
    import pathlib
    return pathlib.Path(__file__).parent / "assets" / "heebo-hebrew.ttf"


def _fit(font, text, size, width):
    least = size * MIN_SHRINK
    while size > least and font.text_length(text, fontsize=size) > width:
        size = max(least, round(size - 0.25, 2))
    return size


def _room(chars, rect, rtl):
    """The mark's place: its own width and the blank after it in the line's direction (up to the
    next letter, or 200 pt) — the template leaves room for a long value with spaces after the mark."""
    h = rect.height or 10
    line = [r for c, r in chars if not c.isspace() and r.y1 > rect.y0 + h * 0.2 and r.y0 < rect.y1 - h * 0.2]
    if rtl:
        nxt = [r.x1 for r in line if r.x1 <= rect.x0 + 0.5]
        return max(rect.width, rect.x1 - max(nxt + [rect.x0 - 200]) - 2)
    nxt = [r.x0 for r in line if r.x0 >= rect.x1 - 0.5]
    return max(rect.width, min(nxt + [rect.x1 + 200]) - rect.x0 - 2)


def _draw_value(page, font, rect, value, size, rtl, room=None):
    value = str(value or "").replace("\n", " ").strip()
    if not value:
        return
    disp = get_display(value) if HEBREW_RE.search(value) else value
    size = _fit(font, disp, size, room or rect.width)
    tw = font.text_length(disp, fontsize=size)
    x = rect.x1 - tw if rtl else rect.x0
    y = rect.y1 - (rect.height - font.ascender * size) / 2 - (rect.height * 0.12)
    page.insert_text((x, y), disp, fontname=FONT_NAME, fontsize=size, color=(0, 0, 0))


def _put(page, rect, png, cache, key, keep=True, rotate=0):
    """A picture drawn in rect; the file keeps each picture once (cache: key → its xref, reused on every page)."""
    if cache.get(key):
        page.insert_image(rect, xref=cache[key], keep_proportion=keep, rotate=rotate)
    else:
        cache[key] = page.insert_image(rect, stream=png, keep_proportion=keep, rotate=rotate)


def _sign_box(rect, rtl):
    """The box a signature fills above its mark: three lines high, at least 2.5 times as wide; anchored right in a Hebrew line."""
    h = max(rect.height * 3, 30)
    w = max(rect.width, h * 2.5)
    return pymupdf.Rect(rect.x1 - w, rect.y1 - h, rect.x1, rect.y1) if rtl else pymupdf.Rect(rect.x0, rect.y1 - h, rect.x0 + w, rect.y1)


def _draw_signature(page, rect, png, rtl, cache=None, key="signer"):
    _put(page, _sign_box(rect, rtl), png, cache if cache is not None else {}, key)


def _draw_stamp(page, rect, png, cache):
    """{{stamp}}: a square of 56–110 pt (five times the mark's height) centred on the mark."""
    side = min(110.0, max(56.0, rect.height * 5))
    cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
    _put(page, pymupdf.Rect(cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2), png, cache, "stamp")


def _png_size(png):
    from PIL import Image
    with Image.open(io.BytesIO(png)) as im:
        return im.size


def _fit_bottom_right(box, size):
    """The picture fitted into box keeping its proportion, aligned to the box's bottom right."""
    w, h = size
    if not w or not h:
        return box
    k = min(box.width / w, box.height / h)
    return pymupdf.Rect(box.x1 - w * k, box.y1 - h * k, box.x1, box.y1)


def seal_boxes(page):
    """Where the every-page seal goes, in what the reader sees (page.rect: rotation taken into account) →
    (the firm's signature box, the stamp box): bottom right, 120 × 48 pt and 80 × 80 pt on an A4, the stamp
    over the signature's right 60 pt; scaled with the page (k = its short side / 595, 0.6–1.6)."""
    W, H = page.rect.width, page.rect.height
    k = min(1.6, max(0.6, min(W, H) / 595))
    R, B = W - 28 * k, H - 22 * k
    return (pymupdf.Rect(R - 150 * k, B - 48 * k, R - 30 * k, B),
            pymupdf.Rect(R - 90 * k, B - 70 * k, R - 10 * k, B + 10 * k))


def _seal_page(page, seal, cache, sizes):
    """The firm's signature and then its stamp over it, bottom right of the page as the reader sees it."""
    sig_box, stamp_box = seal_boxes(page)
    for key, box in (("company_signature", sig_box), ("stamp", stamp_box)):
        png = seal.get("signature" if key == "company_signature" else "stamp")
        if not png:
            continue
        if key not in sizes:
            sizes[key] = _png_size(png)
        fitted = _fit_bottom_right(box, sizes[key]) if key == "company_signature" else _fit_centre(box, sizes[key])
        # page.rect is what the reader sees; the picture goes in the page's own (unrotated) space, turned with the page
        _put(page, fitted * page.derotation_matrix, png, cache, key, keep=False, rotate=page.rotation)


def _fit_centre(box, size):
    w, h = size
    if not w or not h:
        return box
    k = min(box.width / w, box.height / h)
    cx, cy = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
    return pymupdf.Rect(cx - w * k / 2, cy - h * k / 2, cx + w * k / 2, cy + h * k / 2)


# Marks that are pictures, never text.
PICTURE_MARKS = ("signature", "company_signature", "stamp")


def fill(template, values, placed=None, signature=None, seal=None, sign_mark="signature"):
    """The template filled → PDF bytes. values: {mark: text}; signature: the signer's PNG or None
    (its mark, sign_mark, is left blank); placed: the marks placed by hand; seal: the firm's pictures
    {"signature": PNG | None, "stamp": PNG | None, "every_page": bool} or None. A missing picture draws
    nothing and its mark is left blank, like an empty value. On each page, after the values: the signer's
    signature, every {{company_signature}}, every {{stamp}}, then (every_page) the bottom-right seal —
    so a stamp always lies over a signature."""
    seal = seal or {}
    cache, sizes = {}, {}
    doc = _open(template)
    found, _ = find_marks(doc)
    font = pymupdf.Font(fontfile=str(_font()))
    by_page = {}
    for f in found:
        by_page.setdefault(f["page"], []).append(dict(f, hand=False))
    for p in placed or []:
        try:
            pno, x, y, w, h = int(p["page"]), float(p["x"]), float(p["y"]), float(p["w"]), float(p["h"])
        except (KeyError, TypeError, ValueError):
            continue
        if p.get("mark") not in MARKS or not (0 <= pno < doc.page_count) or w <= 0 or h <= 0:
            continue
        by_page.setdefault(pno, []).append({"mark": p["mark"], "page": pno, "rect": [x, y, x + w, y + h],
                                            "size": round(min(h * 0.8, 14), 1), "rtl": bool(p.get("rtl", True)), "hand": True})
    for pno, items in by_page.items():
        page = doc[pno]
        typed = [it for it in items if not it["hand"]]
        chars = _chars(page) if typed else []
        marks = [pymupdf.Rect(it["rect"]) for it in typed]
        # the blank after each mark, measured with the marks themselves taken out of the line
        rest = [(c, r) for c, r in chars if not any(r.intersects(m) for m in marks)]
        for it in items:
            it["room"] = _room(rest, pymupdf.Rect(it["rect"]), it["rtl"]) if not it["hand"] else None
        for it in typed:
            r = pymupdf.Rect(it["rect"])
            page.add_redact_annot(pymupdf.Rect(r.x0 + 0.4, r.y0, r.x1 - 0.4, r.y1), fill=(1, 1, 1))
        if typed:
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
        page.insert_font(fontfile=str(_font()), fontname=FONT_NAME)
        pictures = set(PICTURE_MARKS) | {sign_mark}
        for it in items:
            if it["mark"] not in pictures:
                _draw_value(page, font, pymupdf.Rect(it["rect"]), values.get(it["mark"], ""), it["size"], it["rtl"], it["room"])
        if signature:
            for it in items:
                if it["mark"] == sign_mark:
                    _draw_signature(page, pymupdf.Rect(it["rect"]), signature, it["rtl"], cache)
        if seal.get("signature"):
            for it in items:
                if it["mark"] == "company_signature":
                    _put(page, _sign_box(pymupdf.Rect(it["rect"]), it["rtl"]), seal["signature"], cache, "company_signature")
        if seal.get("stamp"):
            for it in items:
                if it["mark"] == "stamp":
                    _draw_stamp(page, pymupdf.Rect(it["rect"]), seal["stamp"], cache)
    if seal.get("every_page") and (seal.get("signature") or seal.get("stamp")):
        for page in doc:
            _seal_page(page, seal, cache, sizes)
    doc.subset_fonts()
    return _save(doc)


def sample_signature():
    """A made-up signature for the sample: a blue stroke on a transparent PNG, as the signature pad draws."""
    import math
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (300, 90), (0, 0, 0, 0))
    ImageDraw.Draw(im).line([(10 + x, 45 + 22 * math.sin(x / 18)) for x in range(0, 280, 4)], fill=(20, 40, 160, 255), width=4)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def sample_company_signature():
    """A made-up firm's signature for the sample: a dark loop and stroke."""
    import math
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (360, 140), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.line([(20 + t * 3.2, 80 - 40 * math.sin(t / 9) * math.exp(-t / 120)) for t in range(0, 100)], fill=(25, 25, 45, 255), width=5)
    d.line([(60, 110), (330, 95)], fill=(25, 25, 45, 255), width=4)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def sample_stamp():
    """A made-up stamp for the sample: a blue double ring with "חותמת לדוגמה"."""
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    blue = (30, 60, 170, 230)
    d.ellipse((8, 8, 292, 292), outline=blue, width=8)
    d.ellipse((34, 34, 266, 266), outline=blue, width=4)
    try:
        font = ImageFont.truetype(str(_font()), 34)
    except Exception:
        font = ImageFont.load_default()
    for text, y in (("חותמת", 120), ("לדוגמה", 165)):
        disp = get_display(text)
        w = d.textlength(disp, font=font)
        d.text((150 - w / 2, y - 20), disp, fill=blue, font=font)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def sample_seal(db, bucket, tenant, every_page):
    """The seal of a sample: the firm's real signature and stamp when uploaded, else made-up ones — the admin sees the placement."""
    import seal as seal_mod
    try:
        real = seal_mod.load(db, bucket, tenant)
    except Exception:
        real = {}
    return {"signature": real.get("signature") or sample_company_signature(), "stamp": real.get("stamp") or sample_stamp(),
            "every_page": bool(every_page)}


# ---- the function's actions (Admin → Contract templates) ---------------------

MANAGE_ROLES = ("superadmin", "tenant_admin")
E_NO_RIGHT = "Only the firm's admin manages contract templates"
E_NO_FIRM = "No firm"
E_NOT_FOUND = "Template not found"


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def _b64(s):
    try:
        return base64.b64decode(str(s or "").split(",")[-1], validate=False)
    except Exception:
        return b""


def _clean(s, n=80):
    return re.sub(r"[\u0000-\u001f]", " ", str(s or "")).strip()[:n]


def _placed(lst):
    out = []
    for p in (lst if isinstance(lst, list) else [])[:200]:
        try:
            out.append({"mark": str(p["mark"]), "page": int(p["page"]), "x": round(float(p["x"]), 2), "y": round(float(p["y"]), 2),
                        "w": round(float(p["w"]), 2), "h": round(float(p["h"]), 2), "rtl": bool(p.get("rtl", True))})
        except (KeyError, TypeError, ValueError):
            continue
    return [p for p in out if p["mark"] in MARKS and p["w"] > 0 and p["h"] > 0]


def _public(doc_id, d):
    keys = ("name", "category", "isDefault", "size", "origSize", "pages", "createdAt", "updatedAt", "version",
            "marks", "unknown", "placed", "workerId", "signedCount", "pictures", "sealEveryPage")
    return dict({k: d.get(k) for k in keys if k in d}, id=doc_id)


def log_error(db, tenant_id, message, source):
    """An entry in Admin → Errors (the `errors` collection the app's telemetry writes)."""
    db.collection("errors").add({"when": _now(), "page": "contracts", "role": "server", "worker": "",
                                 "message": str(message)[:500], "source": str(source)[:300], "stack": "", "tenantId": tenant_id or ""})


def _sizes(a, b):
    kb = lambda n: (str(round(n / 1024 / 1024, 1)) + " MB") if n >= 1024 * 1024 else (str(max(1, round(n / 1024))) + " KB")
    return kb(a) + " → " + kb(b)


E_NO_DOCX = "Word files can't be converted yet — in Word, save it as PDF and upload that"


def docx_service_url(db):
    """The docx2pdf Cloud Run service's address, written by its deploy (appConfig/docx2pdf.url); '' until then."""
    try:
        return str((db.collection("appConfig").document("docx2pdf").get().to_dict() or {}).get("url") or "")
    except Exception:
        return ""


def convert_docx(db, data, authorization):
    """A .docx to PDF through the docx2pdf service (D7), with the caller's own ID token; raises ValueError."""
    import json as _json
    import urllib.request
    url = docx_service_url(db)
    if not url:
        raise ValueError(E_NO_DOCX)
    req = urllib.request.Request(url, data=_json.dumps({"docxBase64": base64.b64encode(data).decode()}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": authorization or ""}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=110) as r:
            out = _json.loads(r.read().decode("utf-8"))
    except Exception as e:
        try:
            out = _json.loads(e.read().decode("utf-8"))  # an HTTP error with the service's reason
        except Exception:
            raise ValueError("Converting the Word file failed: " + str(e)[:200])
    if not out.get("ok"):
        raise ValueError(out.get("error") or "Converting the Word file failed")
    return base64.b64decode(out["pdfBase64"])


def run(db, bucket, claims, body, authorization="", docx=None):
    """One action of the `contract_templates` function. claims: the caller's verified token claims;
    authorization: the caller's own "Bearer <ID token>", forwarded to the docx2pdf service for a Word file
    (docx: a stand-in converter for the tests)."""
    action = str(body.get("action") or "")
    role = claims.get("role")
    tenant = body.get("asTenantId") if role == "superadmin" else claims.get("tenantId")
    if not tenant or "/" in str(tenant):
        return {"error": E_NO_FIRM}
    col = db.collection("tenants").document(tenant).collection("contractTemplates")
    manage = role in MANAGE_ROLES

    import seal as seal_mod
    if action in seal_mod.ACTIONS:  # the firm's signature and stamp (seal.py)
        return seal_mod.run(db, bucket, claims, body, tenant)

    if action == "list":
        rows = []
        for d in col.stream():
            x = d.to_dict() or {}
            if x.get("deletedAt"):
                continue
            wid = body.get("workerId")
            if x.get("workerId") and x.get("workerId") != wid:
                continue
            rows.append(_public(d.id, x))
        rows.sort(key=lambda r: (str(r.get("category") or ""), str(r.get("name") or "")))
        rec = seal_mod.record(db, tenant)
        return {"ok": True, "templates": rows, "canManage": manage, "canFirmSign": seal_mod.may_firm_sign(claims),
                "seal": {"hasStamp": bool(rec.get("stamp")), "hasSignature": bool(rec.get("signature"))}}

    if action == "file":
        snap = col.document(str(body.get("id") or "")).get()
        if not snap.exists or (snap.to_dict() or {}).get("deletedAt"):
            return {"error": E_NOT_FOUND}
        d = snap.to_dict()
        data = bucket.blob(d["fileId"]).download_as_bytes()
        if body.get("sample"):
            data = fill(data, SAMPLE_VALUES, d.get("placed"), sample_signature(),
                        seal=sample_seal(db, bucket, tenant, d.get("sealEveryPage")))
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": d.get("name")}

    if not manage:
        return {"error": E_NO_RIGHT}

    if action == "prepare":
        data = _b64(body.get("pdfBase64"))
        name = _clean(body.get("name"), 120) or "contract"
        try:
            if body.get("docxBase64"):  # a Word file (D7): turned into a PDF first, then the same way
                raw = _b64(body.get("docxBase64"))
                data = (docx or (lambda d: convert_docx(db, d, authorization)))(raw)
            out, info = light(data)
        except ValueError as e:
            log_error(db, tenant, "Contract template not made light: " + str(e) + " — " + name + " (" + _sizes(len(data), len(data)) + ")",
                      "contracts.prepare")
            return {"error": str(e)}
        if info["heavy"]:
            log_error(db, tenant, "Heavy contract template: " + name + " (" + _sizes(info["origSize"], info["lightSize"]) + ")"
                      + (" — " + ", ".join(info["heavyReasons"]) if info["heavyReasons"] else ""), "contracts.prepare")
        doc = _open(out)
        placed = _placed(body.get("placed"))
        sample = fill(out, SAMPLE_VALUES, placed, sample_signature(), seal=sample_seal(db, bucket, tenant, body.get("sealEveryPage", True)))
        return {"ok": True, "lightBase64": base64.b64encode(out).decode(), "sampleBase64": base64.b64encode(sample).decode(),
                "origSize": info["origSize"], "lightSize": info["lightSize"], "pictures": info["pictures"],
                "marks": sorted({f["mark"] for f in info["found"]}, key=MARKS.index), "unknown": info["unknown"],
                "pages": previews(doc), "heavy": info["heavy"]}

    if action == "sample":
        data = _b64(body.get("pdfBase64"))
        _open(data)
        sample = fill(data, SAMPLE_VALUES, _placed(body.get("placed")), sample_signature(),
                      seal=sample_seal(db, bucket, tenant, body.get("sealEveryPage", True)))
        return {"ok": True, "sampleBase64": base64.b64encode(sample).decode()}

    if action == "save":
        data = _b64(body.get("pdfBase64"))
        if len(data) > MAX_UPLOAD:
            return {"error": E_TOO_BIG}
        try:
            doc = _open(data)
        except ValueError as e:
            return {"error": str(e)}
        found, unknown = find_marks(doc)
        placed = _placed(body.get("placed"))
        name = _clean(body.get("name"), 120) or "contract"
        category = _clean(body.get("category"), 60)
        worker_id = _clean(body.get("workerId"), 80) or None
        replace = str(body.get("replaceId") or "")
        now = _now()
        if replace:
            ref = col.document(replace)
            snap = ref.get()
            if not snap.exists or (snap.to_dict() or {}).get("deletedAt"):
                return {"error": E_NOT_FOUND}
            old = snap.to_dict()
            tid = replace
        else:
            tid = uuid.uuid4().hex[:20]
            ref = col.document(tid)
            old = None
        path = f"tenants/{tenant}/contracts/{tid}/{int(time.time() * 1000)}.pdf"
        blob = bucket.blob(path)
        blob.upload_from_string(data, content_type="application/pdf")
        rec = {"name": name if not old or body.get("name") else old.get("name"), "fileId": path, "size": len(data),
               "origSize": int(body.get("origSize") or len(data)), "pages": doc.page_count,
               "marks": sorted({f["mark"] for f in found} | {p["mark"] for p in placed}, key=MARKS.index),
               "unknown": unknown, "placed": placed, "pictures": picture_pages(doc), "updatedAt": now}
        if old:
            rec["version"] = int(old.get("version") or 1) + 1
            if "sealEveryPage" in body:  # a new version keeps the old one's tick unless it sends its own
                rec["sealEveryPage"] = bool(body.get("sealEveryPage"))
            ref.update(rec)
            if old.get("fileId") and old["fileId"] != path:
                b = bucket.blob(old["fileId"])
                if b.exists():
                    b.delete()
        else:
            same = [d for d in col.stream() if not (d.to_dict() or {}).get("deletedAt")
                    and not (d.to_dict() or {}).get("workerId") and (d.to_dict() or {}).get("category", "") == category]
            rec.update({"category": category, "isDefault": not worker_id and not same, "createdAt": now, "version": 1,
                        "workerId": worker_id, "signedCount": 0, "createdBy": claims.get("uid", ""),
                        # the firm's signature and stamp on every page: on unless the upload unticked it
                        "sealEveryPage": bool(body.get("sealEveryPage", True))})
            ref.set(rec)
        return {"ok": True, "template": _public(tid, ref.get().to_dict())}

    ref = col.document(str(body.get("id") or ""))
    snap = ref.get()
    if not snap.exists:
        return {"error": E_NOT_FOUND}
    d = snap.to_dict() or {}

    if action == "update":
        ch = {"updatedAt": _now()}
        if "name" in body and _clean(body.get("name"), 120):
            ch["name"] = _clean(body.get("name"), 120)
        if "category" in body:
            ch["category"] = _clean(body.get("category"), 60)
            if ch["category"] != d.get("category", ""):
                ch["isDefault"] = False
        if "sealEveryPage" in body:
            ch["sealEveryPage"] = bool(body.get("sealEveryPage"))
        if body.get("isDefault") is True and not d.get("workerId"):
            cat = ch.get("category", d.get("category", ""))
            for o in col.stream():
                x = o.to_dict() or {}
                if o.id != snap.id and x.get("isDefault") and x.get("category", "") == cat and not x.get("workerId"):
                    col.document(o.id).update({"isDefault": False})
            ch["isDefault"] = True
        ref.update(ch)
        return {"ok": True, "template": _public(snap.id, ref.get().to_dict())}

    if action == "delete":
        # The Undo snack has already run out: the template and its file go. Signed contracts are
        # kept in the workers' documents (D3); a default passes to another of its category.
        if d.get("fileId"):
            b = bucket.blob(d["fileId"])
            if b.exists():
                b.delete()
        ref.delete()
        # Sends still waiting for a signature on it are withdrawn (the worker needs sending again).
        for r in db.collection("tenants").document(tenant).collection("signRequests").stream():
            x = r.to_dict() or {}
            if x.get("templateId") == snap.id and x.get("status") == "sent":
                db.collection("tenants").document(tenant).collection("signRequests").document(r.id).update({"status": "withdrawn", "withdrawnWhy": "template deleted"})
        if d.get("isDefault") and not d.get("workerId"):
            for o in col.stream():
                x = o.to_dict() or {}
                if not x.get("workerId") and x.get("category", "") == d.get("category", ""):
                    col.document(o.id).update({"isDefault": True})
                    break
        return {"ok": True}

    return {"error": "Unknown action"}
