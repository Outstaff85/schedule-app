"""Fills form101_fillable.pdf with worker/employer data and returns the PDF as
base64 JSON. Python + PyMuPDF port of the client-side aiFillForm101() in
schedule-manager.html — see that function's comments for the *why* behind each
field's rect/size/quirk; this file mirrors it 1:1 unless noted otherwise.

Key difference from the pdf-lib version: PyMuPDF's own appearance-stream
generator does not shape/reorder RTL text at all (confirmed empirically — even
a single Hebrew word renders letter-reversed). So unlike the JS version, which
only redraws multi-word Hebrew values (pdf-lib's bug only drops a glyph on
multi-word text), every Hebrew-capable field here is unconditionally corrected
with bidi.algorithm.get_display() and drawn by hand — see draw_rtl_text().
"""
import base64
import json
import pathlib
import re
from datetime import date

import cv2
import numpy as np
import pymupdf
from bidi.algorithm import get_display
from firebase_functions import https_fn, options
from PIL import Image, ImageEnhance

ASSETS_DIR = pathlib.Path(__file__).parent / "assets"
TEMPLATE_PATH = ASSETS_DIR / "form101_fillable.pdf"
FONT_PATH = ASSETS_DIR / "heebo-hebrew.ttf"
FONT_NAME = "Heebo"

HEALTH_FUND_HE = {"Clalit": "כללית", "Maccabi": "מכבי", "Meuhedet": "מאוחדת", "Leumit": "לאומית"}
INCOME_TYPE_CB = {"monthly": "cb_p1_4", "secondary": "cb_p1_5", "partial": "cb_p1_6",
                  "daily": "cb_p1_7", "pension": "cb_p1_8", "scholarship": "cb_p1_9"}
OTHER_INCOME_CB = {"monthly": "cb_p1_13", "secondary": "cb_p1_15", "partial": "cb_p1_17",
                   "daily": "cb_p1_12", "pension": "cb_p1_14", "scholarship": "cb_p1_16"}
CHECK_BLUE = (0.09, 0.32, 0.85)
NUDGE = 0.75
PAGE1_EXTRA_Y = 1.5
CHECK_EXTRA_UP = 2.5  # per repeated user feedback the checkmarks kept reading slightly low — nudged up twice now, all pages

# Rects below are copied verbatim from schedule-manager.html's pdf-lib version,
# which uses PDF's native bottom-left-origin coordinates — converted to
# PyMuPDF's top-left-origin ones via pdf_rect().
TAX_YEAR_RECT = (220.4, 742.49, 64.9, 13)
EMPLOYER_ROW = {"y": 659.89, "height": 14}
NAME_RECT = (414.9, EMPLOYER_ROW["y"], 540.4 - 414.9 - 8, EMPLOYER_ROW["height"])
ADDRESS_RECT = (209.0, EMPLOYER_ROW["y"], 414.9 - 209.0 - 8, EMPLOYER_ROW["height"])
PHONE_RECT = (130.3, EMPLOYER_ROW["y"], 209.0 - 130.3, EMPLOYER_ROW["height"])
DEDUCTIONS_RECT = (39.9, EMPLOYER_ROW["y"], 130.3 - 39.9, EMPLOYER_ROW["height"])
WORK_START_RECT = (30.75, 450.42, 90.64, 21.01)
ID_BOX_RECT = (438, 607.89, 102, 13)
SIG_RECT = (34.02, 186, 87.99, 15)
# "מספר טלפון נייד" (worker's own mobile number) — page 1, section ב row below
# marital/resident status. No AcroForm field on the template (verified via
# page.get_drawings()/get_text("words") — the row's own dividers put this box
# at native x:28.7-205.4, y:305.8-328.0 in PyMuPDF's own top-origin space);
# converted here to the same bottom-origin xywh convention as every other
# custom RECT so it goes through the same pdf_rect() helper.
WORKER_PHONE_RECT = (28.7, 841.89 - 328.0, 205.4 - 28.7, 328.0 - 305.8)
# Already top-origin (see the commit history in CLAUDE.md / this port's notes):
# row i spans CHILD_ROW_Y[i]..CHILD_ROW_Y[i+1] directly, no flip needed.
CHILD_ROW_Y = [380.3115, 402.2011, 424.0908, 445.9803, 467.8701, 489.7587,
               511.6493, 533.5380, 555.4286, 577.3173, 599.2079]
CHILD_COLS = {"dob": (255.55, 91.36), "id": (346.91, 101.9), "name": (448.81, 71.26)}


def pdf_rect(page_h, x, y_bottom, width, height):
    return pymupdf.Rect(x, page_h - y_bottom - height, x + width, page_h - y_bottom)


class Form101Builder:
    def __init__(self):
        self.doc = pymupdf.open(TEMPLATE_PATH)
        self.page1 = self.doc[0]
        self.page2 = self.doc[1]
        self.page1.insert_font(fontfile=str(FONT_PATH), fontname=FONT_NAME)
        self.page2.insert_font(fontfile=str(FONT_PATH), fontname=FONT_NAME)
        self.font = pymupdf.Font(fontfile=str(FONT_PATH))
        self.widgets = {}
        for page in self.doc:
            for w in page.widgets():
                self.widgets[w.field_name] = (page, w)

    # ---- low-level helpers -------------------------------------------------

    def _blank_appearance(self, page, widget, state=None):
        """Erase a widget's own (about-to-be-wrong-for-RTL) generated
        appearance stream so our own page.insert_text underneath is what's
        actually visible — same trick as setH()/chk() in the JS version."""
        key = "AP/N" if state is None else f"AP/N/{state}"
        kind, value = page.parent.xref_get_key(widget.xref, key)
        if kind == "xref":
            page.parent.update_stream(int(value.split()[0]), b"")
        elif kind == "dict":
            for m in re.finditer(r"/(\w+) (\d+) 0 R", value):
                if state is None or m.group(1) == state:
                    page.parent.update_stream(int(m.group(2)), b"")

    def _draw_rtl_text(self, page, rect, text, size, right_align=True):
        disp = get_display(str(text))
        tw = self.font.text_length(disp, fontsize=size)
        x = (rect.x1 - 2 - tw) if right_align else (rect.x0 + 2)
        asc = self.font.ascender * size
        y = rect.y0 + (rect.height - asc) / 2 + asc
        page.insert_text((x, y), disp, fontname=FONT_NAME, fontsize=size, color=(0, 0, 0))

    # ---- field writers (mirror setH/setT/setComb/addNew*Field in the JS) ---

    def set_hebrew(self, name, value, size=None):
        """Existing template field with Hebrew/RTL content."""
        if not value or name not in self.widgets:
            return
        page, w = self.widgets[name]
        size = size or (w.text_fontsize or 8)
        w.field_value = str(value)
        w.text_fontsize = size
        w.update()
        self._blank_appearance(page, w)
        self._draw_rtl_text(page, w.rect, value, size)

    def set_text(self, name, value, size=None):
        """Existing template field with plain (LTR) content — no RTL bug, so
        PyMuPDF's own generated appearance is fine, same as JS's setT()."""
        if not value or name not in self.widgets:
            return
        page, w = self.widgets[name]
        if size:
            w.text_fontsize = size
        w.field_value = str(value)
        w.update()

    def set_comb(self, name, value, max_len, size):
        if not value or name not in self.widgets:
            return
        page, w = self.widgets[name]
        w.text_maxlen = max_len
        w.field_flags = w.field_flags | pymupdf.PDF_TX_FIELD_IS_COMB
        w.text_fontsize = size
        w.field_value = str(value)[:max_len]
        w.update()

    def check(self, name):
        if name not in self.widgets:
            return
        page, w = self.widgets[name]
        w.field_value = True
        w.update()
        self._blank_appearance(page, w, state="Yes")
        r = w.rect
        thickness = max(1.1, r.height * 0.16)
        extra_up = PAGE1_EXTRA_Y if page == self.page1 else -2.0  # page-2 checkbox (resident_h) sits too high vs page-1 ones; nudge down 2pt, isolated to page 2

        def pt(fx, fy_from_bottom):
            x = r.x0 + fx * r.width + NUDGE
            y = r.y0 + (1 - fy_from_bottom) * r.height - NUDGE - extra_up - CHECK_EXTRA_UP
            return pymupdf.Point(x, y)

        p1, p2, p3 = pt(0.12, 0.55), pt(0.40, 0.18), pt(0.88, 0.82)
        page.draw_line(p1, p2, color=CHECK_BLUE, width=thickness, lineCap=1)
        page.draw_line(p2, p3, color=CHECK_BLUE, width=thickness, lineCap=1)

    def _new_widget(self, page, name, rect, size, comb=False, max_len=None):
        w = pymupdf.Widget()
        w.field_name = name
        w.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
        w.rect = rect
        w.text_fontsize = size
        w.border_width = 0
        w.fill_color = []
        if comb:
            w.field_flags = pymupdf.PDF_TX_FIELD_IS_COMB
            w.text_maxlen = max_len
        return w

    def _refetch(self, page, name):
        # A Widget object just passed to add_widget() keeps xref==0 — any
        # xref-level op (blanking an appearance, further updates) needs the
        # "live" Widget PyMuPDF hands back from the page's own widget list.
        return next(x for x in page.widgets() if x.field_name == name)

    def add_comb_field(self, page_h, page, name, xywh, max_len, size, value):
        if not value:
            return
        rect = pdf_rect(page_h, *xywh)
        w = self._new_widget(page, name, rect, size, comb=True, max_len=max_len)
        w.field_value = str(value)[:max_len]
        page.add_widget(w)

    def add_hebrew_field(self, page_h, page, name, xywh, size, value, right_align=True):
        if not value:
            return
        rect = pdf_rect(page_h, *xywh)
        w = self._new_widget(page, name, rect, size)
        w.field_value = str(value)
        page.add_widget(w)
        live = self._refetch(page, name)
        self._blank_appearance(page, live)
        self._draw_rtl_text(page, rect, value, size, right_align)

    def finalize(self):
        catalog = self.doc.pdf_catalog()
        self.doc.xref_set_key(catalog, "AcroForm/NeedAppearances", "false")
        return self.doc.tobytes()


def _split_street(addr):
    """Street name + number can arrive in either order — same heuristic as
    the JS version's regex split."""
    m_end = re.match(r"^(.*?)(\d+)\s*$", addr or "")
    if m_end:
        return m_end.group(1).strip(), m_end.group(2).strip()
    m_start = re.match(r"^(\d+)\s+(.*)$", addr or "")
    if m_start:
        return m_start.group(2).strip(), m_start.group(1).strip()
    return addr, None


def build_form101_pdf(p):
    b = Form101Builder()
    page_h = b.page1.rect.height

    surname, given = p.get("surname"), p.get("given")
    dob, sex, no = p.get("dob"), p.get("sex"), p.get("no")
    is_israeli = bool(p.get("isIsraeli"))

    b.set_hebrew("surname", surname, 11)
    b.set_hebrew("given_name", given, 11)
    b.set_comb("dob", re.sub(r"\D", "", dob or ""), 8, 10)
    b.set_text("id_top2", no, 10)

    tax_year = str(date.today().year)
    b.add_comb_field(page_h, b.page1, "tax_year_box", TAX_YEAR_RECT, 4, 10, tax_year)
    if "tax_year" in b.widgets:
        _, w = b.widgets["tax_year"]
        w.field_flags = w.field_flags | pymupdf.PDF_FIELD_IS_READ_ONLY
        w.update()

    employer = p.get("employer") or {}
    firm_missing = p.get("firmMissing") or []
    if employer:
        b.add_hebrew_field(page_h, b.page1, "employer_name", NAME_RECT, 11, employer.get("companyName"))
        addr_parts = [employer.get("street"), employer.get("streetNumber")]
        addr = " ".join(x for x in addr_parts if x)
        if employer.get("city"):
            addr += (", " if addr else "") + employer["city"]
        b.add_hebrew_field(page_h, b.page1, "employer_address", ADDRESS_RECT, 11, addr)
        b.add_hebrew_field(page_h, b.page1, "employer_phone", PHONE_RECT, 10, employer.get("phone"))
        if employer.get("deductionsFileNumber"):
            digits = re.sub(r"\D", "", str(employer["deductionsFileNumber"]))
            b.add_comb_field(page_h, b.page1, "employer_deductions", DEDUCTIONS_RECT, 8, 10, digits)

    if sex == "M":
        b.check("sex_male")
    elif sex == "F":
        b.check("sex_female")
    if is_israeli:
        b.check("resident_yes")
        b.check("resident_h")
    else:
        b.check("resident_no")
        b.check("marital_single")
    b.check("cb_p1_1")  # kibbutz member — always "No" for this app's workers

    income_cb = INCOME_TYPE_CB.get(p.get("incomeType"))
    if income_cb:
        b.check(income_cb)
    other_type = p.get("otherIncomeType")
    if other_type == "none":
        b.check("cb_p1_10")
    elif other_type and OTHER_INCOME_CB.get(other_type):
        b.check("cb_p1_11")
        b.check(OTHER_INCOME_CB[other_type])

    def fill_work_start(iso_date):
        if not iso_date:
            return
        d = iso_date.split("-")
        if len(d) == 3:
            b.add_comb_field(page_h, b.page1, "work_start_date", WORK_START_RECT, 8, 11,
                              d[2] + d[1] + d[0])

    b.set_text("sign_date", p.get("signDate"), 10)

    if is_israeli:
        if no:
            b.add_comb_field(page_h, b.page1, "id_box", ID_BOX_RECT, 9, 10, re.sub(r"\D", "", no))
        addr = p.get("address")
        if addr:
            street, number = _split_street(addr)
            b.set_hebrew("addr_street", street, 11)
            if number:
                b.set_text("addr_number", number)
        b.set_hebrew("addr_city", p.get("city"), 11)
        marital = p.get("marital")
        if marital:
            b.check(marital)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)
        for i, c in enumerate((p.get("children") or [])[:10]):
            row_y0, row_y1 = CHILD_ROW_Y[i], CHILD_ROW_Y[i + 1]
            row_h = row_y1 - row_y0
            if c.get("idNo"):
                name = f"children_id_{i}"
                rect = pymupdf.Rect(CHILD_COLS["id"][0], row_y0, CHILD_COLS["id"][0] + CHILD_COLS["id"][1], row_y1)
                w = b._new_widget(b.page1, name, rect, 10, comb=True, max_len=9)
                w.field_value = re.sub(r"\D", "", str(c["idNo"]))
                b.page1.add_widget(w)
            if c.get("dob"):
                dd = re.sub(r"\D", "", str(c["dob"]))
                if dd:
                    name = f"children_dob_{i}"
                    rect = pymupdf.Rect(CHILD_COLS["dob"][0], row_y0, CHILD_COLS["dob"][0] + CHILD_COLS["dob"][1], row_y1)
                    w = b._new_widget(b.page1, name, rect, 10, comb=True, max_len=8)
                    w.field_value = dd
                    b.page1.add_widget(w)
            if c.get("name"):
                name = f"children_name_{i}"
                rect = pymupdf.Rect(CHILD_COLS["name"][0], row_y0, CHILD_COLS["name"][0] + CHILD_COLS["name"][1], row_y1)
                w = b._new_widget(b.page1, name, rect, 9)
                w.field_value = str(c["name"])
                b.page1.add_widget(w)
                live = b._refetch(b.page1, name)
                b._blank_appearance(b.page1, live)
                b._draw_rtl_text(b.page1, rect, c["name"], 8, right_align=True)
    else:
        b.set_comb("passport_no", no, 13, 10)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)

    phone = p.get("workerPhone")
    if phone:
        b.add_hebrew_field(page_h, b.page1, "worker_phone", WORKER_PHONE_RECT, 10, phone, right_align=True)

    sig_b64 = p.get("signaturePngBase64")
    if sig_b64:
        try:
            sig_bytes = base64.b64decode(sig_b64)
            rect = pdf_rect(page_h, *SIG_RECT)
            pix = pymupdf.Pixmap(sig_bytes)
            scale = min(rect.width / pix.width, rect.height / pix.height)
            w, h = pix.width * scale, pix.height * scale
            img_rect = pymupdf.Rect(
                rect.x0 + (rect.width - w) / 2, rect.y0 + (rect.height - h) / 2,
                rect.x0 + (rect.width - w) / 2 + w, rect.y0 + (rect.height - h) / 2 + h,
            )
            b.page2.insert_image(img_rect, pixmap=pix)
        except Exception:
            pass

    for extra in (p.get("extraPages") or []):
        try:
            img_bytes = base64.b64decode(extra["b64"])
            pw, ph = b.page1.rect.width, b.page1.rect.height
            new_page = b.doc.new_page(width=pw, height=ph)
            margin, cap_h = 40, 24
            pix = pymupdf.Pixmap(img_bytes)
            max_w, max_h = pw - margin * 2, ph - margin * 2 - cap_h
            fit = min(max_w / pix.width, max_h / pix.height, 1)
            w, h = pix.width * fit, pix.height * fit
            x, y = (pw - w) / 2, margin
            new_page.insert_text((margin, margin + 16), extra.get("caption", "Document scan"),
                                  fontsize=13, color=(0.3, 0.3, 0.3))
            new_page.draw_rect(pymupdf.Rect(x - 2, y - 2, x + w + 2, y + h + 2),
                                color=(0.7, 0.7, 0.7), fill=(1, 1, 1), width=1)
            new_page.insert_image(pymupdf.Rect(x, y, x + w, y + h), pixmap=pix)
        except Exception:
            pass

    def fn_part(s):
        return re.sub(r"[^A-Za-z0-9֐-׿]", "", s or "")

    company_suffix = ("_" + fn_part(employer.get("companyName"))) if employer.get("companyName") else ""
    file_name = ((re.sub(r"\D", "", no) if no else "noid") + "_" + fn_part(given or "worker") +
                 (("_" + fn_part(surname)) if surname else "") + company_suffix + ".pdf")

    return b.finalize(), file_name, firm_missing


options.set_global_options(region="us-central1")


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.MB_512,
    timeout_sec=60,
)
def fill_form_101(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return https_fn.Response(json.dumps({"error": "POST only"}), status=405, mimetype="application/json")
    try:
        payload = req.get_json(silent=True) or {}
        pdf_bytes, file_name, firm_missing = build_form101_pdf(payload)
        body = json.dumps({
            "pdfBase64": base64.b64encode(pdf_bytes).decode(),
            "fileName": file_name,
            "firmMissing": firm_missing,
        })
        return https_fn.Response(body, status=200, mimetype="application/json")
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


# ===== Scan preprocessing: OpenCV geometry + Pillow enhancement =====
# Tried BEFORE the client's existing AI-seeded alignment (aiDetectAlign,
# schedule-manager.html) — if this finds a confident document quad, the
# client skips that Haiku call entirely; if not, it falls back to the
# unchanged AI-seeded flow (which then still gets this function's
# contrast/sharpness-enhanced image as its input, so that part of the
# improvement applies either way). See CLAUDE.md for the full design
# rationale and the empirical tests (synthetic + real ID photos) that shaped
# the confidence thresholds below — plain OpenCV contour detection was
# confirmed to (a) have no way to tell an upside-down document from a
# right-side-up one (geometry alone can't read text) and (b) fail outright
# on a low-contrast background (locks onto a small internal box instead of
# the document's true outline) — both failure modes are exactly what the
# area-fraction + convexity checks below are guarding against; anything that
# doesn't clear them falls back to the client's existing AI path unchanged.
MAX_WORK_DIM = 1800  # generous margin above the 1568px Claude Vision actually benefits from
MIN_QUAD_AREA_FRAC = 0.20
MAX_QUAD_AREA_FRAC = 0.98
BLUR_VARIANCE_THRESHOLD = 15.0  # below this (Laplacian variance) = reject as too blurry to bother reading
# Calibrated against a real Israeli ID photo (see CLAUDE.md): the sharp original
# measured ~130, a mild Gaussian blur (still fully legible by eye) measured ~28,
# a moderate blur (small print starting to degrade) measured ~9 — 15 sits
# between those last two, closer to "reject only once it's actually a problem"
# than to "reject anything not perfectly crisp".


def _blur_variance(gray):
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _find_document_quad(img_bgr):
    h, w = img_bgr.shape[:2]
    frame_area = h * w
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:8]
    for c in contours:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        area = cv2.contourArea(approx)
        if area < MIN_QUAD_AREA_FRAC * frame_area or area > MAX_QUAD_AREA_FRAC * frame_area:
            continue
        return approx.reshape(4, 2).astype(np.float32)
    return None


def _order_quad(quad):
    s = quad.sum(axis=1)
    diff = np.diff(quad, axis=1).flatten()
    tl, br = quad[np.argmin(s)], quad[np.argmax(s)]
    tr, bl = quad[np.argmin(diff)], quad[np.argmax(diff)]
    return np.float32([tl, tr, br, bl])


def _warp_quad(img_bgr, quad):
    tl, tr, br, bl = _order_quad(quad)
    w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    if w < 20 or h < 20:
        return None
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    m = cv2.getPerspectiveTransform(np.float32([tl, tr, br, bl]), dst)
    return cv2.warpPerspective(img_bgr, m, (w, h))


def _enhance_contrast_sharpness(img_bgr):
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    pil = ImageEnhance.Contrast(pil).enhance(1.15)
    pil = ImageEnhance.Sharpness(pil).enhance(1.4)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _resize_max_dim(img_bgr, max_dim):
    h, w = img_bgr.shape[:2]
    scale = min(1.0, max_dim / max(h, w))
    if scale >= 1.0:
        return img_bgr
    return cv2.resize(img_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def preprocess_scan_image(image_bytes):
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return {"ok": False, "reason": "decode_failed"}

    img = _resize_max_dim(img, MAX_WORK_DIM)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur_variance = _blur_variance(gray)
    if blur_variance < BLUR_VARIANCE_THRESHOLD:
        return {"ok": False, "reason": "blurry", "blurVariance": blur_variance}

    quad = _find_document_quad(img)
    geometry_applied = False
    result = img
    if quad is not None:
        warped = _warp_quad(img, quad)
        if warped is not None:
            result = warped
            geometry_applied = True

    result = _enhance_contrast_sharpness(result)
    ok, buf = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return {"ok": False, "reason": "encode_failed"}
    return {
        "ok": True,
        "geometryApplied": geometry_applied,
        "imageBase64": base64.b64encode(buf.tobytes()).decode(),
        "mediaType": "image/jpeg",
    }


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.MB_512,
    timeout_sec=30,
)
def preprocess_scan(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return https_fn.Response(json.dumps({"error": "POST only"}), status=405, mimetype="application/json")
    try:
        payload = req.get_json(silent=True) or {}
        b64 = payload.get("image")
        if not b64:
            return https_fn.Response(json.dumps({"error": "no image"}), status=400, mimetype="application/json")
        result = preprocess_scan_image(base64.b64decode(b64))
        return https_fn.Response(json.dumps(result), status=200, mimetype="application/json")
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")
