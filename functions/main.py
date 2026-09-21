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

SIG_RECT = (34.02, 186, 87.99, 15)
# Children fields on the current template (added 2026-09-21, after the user
# rebuilt the AcroForm markup themselves) — base (no suffix) + 1..5, six rows
# total. Each row is FOUR separate fields (given name, surname, dob, ID/
# passport number) rather than one combined "name" field, so a worker's
# single c["name"] string is split on the first space — good enough for the
# vast majority of names; an unusually multi-word surname could land
# partially in the wrong field, but there's no per-child given/surname split
# anywhere upstream (AI extraction, manual entry) to do better without a
# larger data-model change.
CHILD_FIELD_SUFFIXES = ["", "1", "2", "3", "4", "5"]

# Small per-field position corrections layered on top of the template's own
# AcroForm geometry — (dx, dy) in PDF points, added directly to the widget's
# rect (page-space: x right, y DOWN) before any value is written. This moves
# the actual field/annotation rectangle itself (so its generated appearance,
# comb cell spacing, etc. all shift with it), as opposed to nudging where
# hand-drawn text sits within an unchanged rect — the user specifically
# wants the former. Add further per-field tweaks here rather than re-editing
# the PDF template by hand.
FIELD_RECT_NUDGES = {
    "worker_phone": (3, 0),           # 3pt right, per user request
    "employer_deductions": (0, 1),    # 1pt down, per user request (font size bumped at its set_comb() call site)
}


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
        self._apply_rect_nudges()

    def _apply_rect_nudges(self):
        for name, (dx, dy) in FIELD_RECT_NUDGES.items():
            entry = self.widgets.get(name)
            if not entry:
                continue
            page, w = entry
            r = w.rect
            w.rect = pymupdf.Rect(r.x0 + dx, r.y0 + dy, r.x1 + dx, r.y1 + dy)
            w.update()

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

    def _draw_rtl_text(self, page, rect, text, size, right_align=True, bottom_align=False):
        disp = get_display(str(text))
        tw = self.font.text_length(disp, fontsize=size)
        x = (rect.x1 - 2 - tw) if right_align else (rect.x0 + 2)
        asc = self.font.ascender * size
        if bottom_align:
            y = rect.y0 + asc + 1  # sit near the box's bottom edge, 1pt margin so the baseline isn't flush against the border
        else:
            y = rect.y0 + (rect.height - asc) / 2 + asc
        page.insert_text((x, y), disp, fontname=FONT_NAME, fontsize=size, color=(0, 0, 0))

    def _draw_center_text(self, page, rect, text, size):
        """Center a short LTR value (e.g. a house number) both horizontally
        and vertically within its box — same vertical math as
        _draw_rtl_text's default (centered), just horizontal-centered
        instead of left/right-anchored. No bidi needed (digits only)."""
        disp = str(text)
        tw = self.font.text_length(disp, fontsize=size)
        x = rect.x0 + (rect.width - tw) / 2
        asc = self.font.ascender * size
        y = rect.y0 + (rect.height - asc) / 2 + asc
        page.insert_text((x, y), disp, fontname=FONT_NAME, fontsize=size, color=(0, 0, 0))

    # ---- field writers (mirror setH/setT/setComb/addNew*Field in the JS) ---

    def set_hebrew(self, name, value, size=None, right_align=True):
        """Existing template field with Hebrew/RTL content. right_align=False
        is for the odd field that's actually plain LTR content (a phone
        number) routed through this writer rather than set_text() only
        because it still needs the blank+redraw treatment for some other
        reason — see the worker_phone/employer_phone call sites, where the
        default right-alignment anchored the digits against the template's
        own printed "/" guide mark baked into that box (confirmed by
        rendering the same box with an empty value — the "/" is static page
        content, present either way), making the phone number look garbled/
        overlapped rather than genuinely missing."""
        if not value or name not in self.widgets:
            return
        page, w = self.widgets[name]
        size = size or (w.text_fontsize or 8)
        w.field_value = str(value)
        w.text_fontsize = size
        w.update()
        self._blank_appearance(page, w)
        self._draw_rtl_text(page, w.rect, value, size, right_align=right_align)

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

    def set_text_centered(self, name, value, size=None):
        """Same field kind as set_text (plain LTR, no RTL bug) but drawn by
        hand (blank + redraw, same trick as set_hebrew) so it can be
        centered — PyMuPDF's own generated appearance has no centering
        option, only its own left-alignment default."""
        if not value or name not in self.widgets:
            return
        page, w = self.widgets[name]
        size = size or (w.text_fontsize or 8)
        w.field_value = str(value)
        w.text_fontsize = size
        w.update()
        self._blank_appearance(page, w)
        self._draw_center_text(page, w.rect, value, size)

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

    def add_hebrew_field(self, page_h, page, name, xywh, size, value, right_align=True, bottom_align=False):
        if not value:
            return
        rect = pdf_rect(page_h, *xywh)
        w = self._new_widget(page, name, rect, size)
        w.field_value = str(value)
        page.add_widget(w)
        live = self._refetch(page, name)
        self._blank_appearance(page, live)
        self._draw_rtl_text(page, rect, value, size, right_align, bottom_align)

    def finalize(self):
        catalog = self.doc.pdf_catalog()
        # xref_set_key's dotted "AcroForm/NeedAppearances" path only works
        # when /AcroForm is embedded directly in the catalog dict — this
        # template (added 2026-09-21) stores it as its own indirect object
        # instead (a perfectly normal, common way to structure a PDF), which
        # makes the dotted-path form fail with "path to 'NeedAppearances' has
        # indirects". Resolve the AcroForm's own xref first and set the key
        # directly on it instead.
        kind, acroform_ref = self.doc.xref_get_key(catalog, "AcroForm")
        if kind == "xref":
            acroform_xref = int(acroform_ref.split()[0])
            self.doc.xref_set_key(acroform_xref, "NeedAppearances", "false")
        else:
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


def _draw_extra_page_image(page, extra, box, margin=40, cap_h=24, fontsize=13):
    """Draws one extraPages entry (caption + bordered, fit-to-box image) inside
    `box` on `page`. Defaults match the original one-image-per-page sizing;
    the half-page stacked case (see build_form101_pdf's extraPages loop below)
    passes smaller values since each box is half the page's height."""
    img_bytes = base64.b64decode(extra["b64"])
    pix = pymupdf.Pixmap(img_bytes)
    max_w, max_h = box.width - margin * 2, box.height - margin * 2 - cap_h
    fit = min(max_w / pix.width, max_h / pix.height, 1)
    w, h = pix.width * fit, pix.height * fit
    x = box.x0 + (box.width - w) / 2
    y = box.y0 + margin + cap_h
    page.insert_text((box.x0 + margin, box.y0 + margin + 16), extra.get("caption", "Document scan"),
                      fontsize=fontsize, color=(0.3, 0.3, 0.3))
    page.draw_rect(pymupdf.Rect(x - 2, y - 2, x + w + 2, y + h + 2),
                    color=(0.7, 0.7, 0.7), fill=(1, 1, 1), width=1)
    page.insert_image(pymupdf.Rect(x, y, x + w, y + h), pixmap=pix)


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
    b.set_comb("tax_year", tax_year, 4, 10)

    employer = p.get("employer") or {}
    firm_missing = p.get("firmMissing") or []
    if employer:
        b.set_hebrew("employer_name", employer.get("companyName"), 11)
        addr_parts = [employer.get("street"), employer.get("streetNumber")]
        addr = " ".join(x for x in addr_parts if x)
        if employer.get("city"):
            addr += (", " if addr else "") + employer["city"]
        b.set_hebrew("employer_address", addr, 11)
        b.set_hebrew("employer_phone", employer.get("phone"), 10, right_align=False)
        if employer.get("deductionsFileNumber"):
            digits = re.sub(r"\D", "", str(employer["deductionsFileNumber"]))
            b.set_comb("employer_deductions", digits, 8, 11)

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
            b.set_comb("Date_start_work", d[2] + d[1] + d[0], 8, 11)

    b.set_text("sign_date", p.get("signDate"), 10)

    if is_israeli:
        if no:
            # "employer_zeut_num" — despite the name (from the user's own
            # AcroForm markup), this field sits right next to surname/
            # given_name/dob/passport_no, not near anything employer-related,
            # and its nearby printed label reads "9 digits, for those who
            # don't have..." — a strong match for the WORKER's own Israeli ID
            # number rather than an employer field. Using it as such; revisit
            # if the field ever gets renamed to something clearer.
            b.set_comb("employer_zeut_num", re.sub(r"\D", "", no), 9, 10)
        addr = p.get("address")
        if addr:
            street, number = _split_street(addr)
            b.set_hebrew("addr_street", street, 11)
            if number:
                b.set_text_centered("addr_number", number)
        b.set_hebrew("addr_city", p.get("city"), 11)
        marital = p.get("marital")
        if marital:
            b.check(marital)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)
        for i, c in enumerate((p.get("children") or [])[:len(CHILD_FIELD_SUFFIXES)]):
            suf = CHILD_FIELD_SUFFIXES[i]
            full_name = str(c.get("name") or "").strip()
            if full_name:
                # Split on the first space: given name first, everything
                # else treated as surname — matches the given/surname order
                # already used for the worker's own name. See
                # CHILD_FIELD_SUFFIXES's own comment for the tradeoff.
                parts = full_name.split(None, 1)
                given_n = parts[0]
                surname_n = parts[1] if len(parts) > 1 else ""
                if given_n:
                    b.set_hebrew(f"child_given_name{suf}", given_n, 9)
                if surname_n:
                    b.set_hebrew(f"child_surname{suf}", surname_n, 9)
            if c.get("dob"):
                dd = re.sub(r"\D", "", str(c["dob"]))
                if dd:
                    b.set_comb(f"child_dob{suf}", dd, 8, 10)
            if c.get("idNo"):
                digits = re.sub(r"\D", "", str(c["idNo"]))
                if digits:
                    b.set_comb(f"child_passport_no{suf}", digits, 9, 10)
    else:
        b.set_comb("passport_no", no, 13, 10)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)

    phone = p.get("workerPhone")
    if phone:
        b.set_hebrew("worker_phone", phone, 10)

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

    extra_pages = p.get("extraPages") or []
    pw, ph = b.page1.rect.width, b.page1.rect.height
    # The first two extraPages entries are, in the overwhelming common case, the
    # document's own two sides — the ID front ("Document scan") and its ספח
    # appendix card (captioned "Document") — so they go stacked on ONE page
    # instead of two separate ones. There's no explicit "this is the ספח" tag
    # on an extraPages entry, so this is a heuristic keyed on position, not
    # content; any further entries (a contract, etc.) still get one page each,
    # unchanged from before.
    if len(extra_pages) >= 2:
        combo_page = b.doc.new_page(width=pw, height=ph)
        half_h = ph / 2
        for extra, box in ((extra_pages[0], pymupdf.Rect(0, 0, pw, half_h)),
                            (extra_pages[1], pymupdf.Rect(0, half_h, pw, ph))):
            try:
                _draw_extra_page_image(combo_page, extra, box, margin=24, cap_h=20, fontsize=12)
            except Exception:
                pass
        remaining_pages = extra_pages[2:]
    else:
        remaining_pages = extra_pages

    for extra in remaining_pages:
        try:
            new_page = b.doc.new_page(width=pw, height=ph)
            _draw_extra_page_image(new_page, extra, pymupdf.Rect(0, 0, pw, ph))
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

    # Geometric auto-crop (_find_document_quad/_warp_quad) is DELIBERATELY
    # NOT applied here anymore (removed 2026-09-21, per user request) — it
    # used to crop the photo down to whatever quad it found BEFORE the
    # client's manual corner-adjustment editor ever ran, which silently
    # discarded content when a single photo held two documents at once (e.g.
    # a passport and its ספח insert photographed together): the geometry
    # detector locks onto one rectangular contour and the other document is
    # simply gone by the time the user sees the editor, defeating the whole
    # point of the earlier "user crops first, manually" reorder (see
    # CLAUDE.md's "manual crop/straighten now happens BEFORE the OCR call"
    # note). The functions themselves are left defined, dormant, in case a
    # single-document-only fast path is wanted again later. Only the blur
    # rejection and contrast/sharpness enhancement still run — the user
    # always gets the full (enhanced, downscaled) original photo to crop
    # themselves.
    result = _enhance_contrast_sharpness(img)
    ok, buf = cv2.imencode(".jpg", result, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        return {"ok": False, "reason": "encode_failed"}
    return {
        "ok": True,
        "geometryApplied": False,
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
