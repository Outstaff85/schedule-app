"""FROZEN (builder b1, docs/documents-plan.md → S1): never edit this file; a change is a new file, contract_b2.py. The
golden hashes (tests/auth/builder_golden.json) guard its output.

A copy of contracts.fill and everything it runs, as it stood at b1, never a wrapper: a later edit of functions/contracts.py
cannot change what b1 builds. Filling a worker's or a client's contract (sign_mark): each mark is whited out and its value
written in its place — Hebrew right to left (python-bidi, the Heebo font, as Form 101), shrunk to fit —, the signer's
signature a picture fitted above its mark; the firm's signature and stamp at their marks and, when every_page is set,
at the bottom right of every page — the signature first, the stamp over it. Marks on a page that is only a picture are
placed by hand (`placed`: page, x, y, w, h in PDF points from the page's top left).

The save is fixed: no new id, the trailer /ID from the input manifest's hash (else a hash of the inputs). The font
subsets' names need nothing: `doc.subset_fonts()` (MuPDF's own subsetter) names a subset from the font's data."""

import hashlib
import io
import json
import pathlib
import re

import pymupdf
from bidi.algorithm import get_display
from PIL import Image

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
# A client's contract (client_signing.py): the client's own details, its signature and signing date…
CLIENT_MARKS = ("client_name", "client_company_no", "client_address", "client_phone", "client_email", "client_signer",
                "client_signer_role", "client_signature", "client_sign_date")
# …and what the client pays — filled only from a login that sees client billing (signing.may_see_billing).
CLIENT_BILL_MARKS = ("client_rate", "client_pay_mode", "client_ot_rate", "client_shabbat_rate")
MARKS = WORKER_MARKS + WORK_MARKS + PAY_MARKS + FIRM_MARKS + SEAL_MARKS + TERMS_MARKS + SIGN_MARKS + CLIENT_MARKS + CLIENT_BILL_MARKS
MARK_RE = re.compile(r"\{\{([A-Za-z0-9_]+)\}\}")
# In a Hebrew line a PDF may keep its text in visual order: the braces come out mirrored.
MIRROR_RE = re.compile(r"\}\}([A-Za-z0-9_]+)\{\{")
HEBREW_RE = re.compile(r"[֐-׿]")

FONT_NAME = "Heebo"
MIN_SHRINK = 0.7        # a long value is shrunk to fit its place, to 70 % of the text's size at most

E_NOT_PDF = "This file is not a PDF"


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


def _sha(data):
    return hashlib.sha256(data).hexdigest() if data else None


def _file_id(template, values, placed, signature, seal, sign_mark, manifest_sha256):
    """The trailer /ID's 16 bytes in hex: from the input manifest's SHA-256, else (nothing signed yet) from a hash of the inputs."""
    if manifest_sha256:
        return str(manifest_sha256)[:32]
    seal = seal or {}
    inputs = {"template": _sha(template), "values": values, "placed": placed, "signature": _sha(signature), "signMark": sign_mark,
              "seal": {"signature": _sha(seal.get("signature")), "stamp": _sha(seal.get("stamp")), "everyPage": bool(seal.get("every_page"))}}
    return hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:32]


def _save(doc, file_id):
    doc.xref_set_key(-1, "ID", f"[<{file_id}><{file_id}>]")
    return doc.tobytes(garbage=4, deflate=True, clean=True, deflate_images=True, deflate_fonts=True, no_new_id=True)


def _font():
    return pathlib.Path(__file__).resolve().parent.parent / "assets" / "heebo-hebrew.ttf"


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


def fill(template, values, placed=None, signature=None, seal=None, sign_mark="signature", manifest_sha256=None):
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
    return _save(doc, _file_id(template, values, placed, signature, seal, sign_mark, manifest_sha256))
