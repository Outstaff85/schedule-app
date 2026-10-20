"""Fills assets/form101_fillable.pdf with worker/employer data and returns the PDF as
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
import datetime
import io
import json
import pathlib
import re
from datetime import date

import pymupdf
from bidi.algorithm import get_display
import firebase_admin
from firebase_admin import auth as fb_auth
from firebase_functions import https_fn, options
from firebase_functions.params import SecretParam

import datastore
import feedback
import gate
from PIL import Image

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

# PDF-embed image optimization (added 2026-09-26, per user request) — applies
# ONLY here, at final PDF assembly, never earlier in the scan pipeline: OCR
# (aiReadDoc) and digit-field verification (aiVerifyField) have both already
# run upstream on the full-resolution scan by the time build_form101_pdf()
# ever sees it (see docs/scan.md), so shrinking the copy
# that gets embedded here can't affect field-extraction accuracy — it only
# affects the generated PDF's file size. The raw, unshrunk scan is preserved
# separately in the Drive asset sidecar (saveWorkerAssets) for any future
# regeneration, so this is a one-way, presentation-only downscale.
EMBED_DPI = 150  # comfortably legible on paper/screen; far below native phone-camera resolution
EMBED_JPEG_QUALITY = 82

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
# Empty since 2026-10-05: every field sits exactly at its rectangle in the
# template, and the user positions the fields in the PDF itself.
FIELD_RECT_NUDGES = {}


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
        # The mark is drawn inside the checkbox's own rectangle, with no
        # extra offset (2026-10-05): boxes are positioned in the template.

        def pt(fx, fy_from_bottom):
            x = r.x0 + fx * r.width
            y = r.y0 + (1 - fy_from_bottom) * r.height
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
        # garbage=4 drops unused/duplicate objects (the biggest win on a doc
        # with several embedded scan/signature images), deflate*=True compresses
        # any stream that isn't already, clean=True repacks page content more
        # compactly. Pure container-level cleanup — doesn't touch pixel data,
        # safe to always apply.
        return self.doc.tobytes(garbage=4, deflate=True, deflate_images=True, clean=True)


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


def _shrink_for_embed(img_bytes, target_w_pt, target_h_pt, dpi=EMBED_DPI, jpeg_quality=EMBED_JPEG_QUALITY):
    """Downscales+recompresses an image to just what's needed to look sharp at
    `dpi` inside a `target_w_pt` x `target_h_pt` PDF box — see EMBED_DPI's own
    comment above for why this is safe to do at this specific call site.
    Preserves transparency (re-encodes as PNG) if the source has an alpha
    channel (the hand-drawn signature); otherwise re-encodes as JPEG. Never
    upscales. Returns (bytes, width_px, height_px), or (img_bytes, None, None)
    unchanged on any decode failure — a corrupt/unsupported image must never
    sink PDF generation, callers fall back to the original bytes+Pixmap in
    that case."""
    try:
        im = Image.open(io.BytesIO(img_bytes))
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB")
        target_px = (max(1, int(target_w_pt / 72 * dpi)), max(1, int(target_h_pt / 72 * dpi)))
        im.thumbnail(target_px, Image.LANCZOS)
        buf = io.BytesIO()
        if has_alpha:
            im.save(buf, format="PNG", optimize=True)
        else:
            im.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
        return buf.getvalue(), im.width, im.height
    except Exception:
        return img_bytes, None, None


def _draw_extra_page_image(page, extra, box, margin=40, cap_h=24, fontsize=13):
    """Draws one extraPages entry (caption + bordered, fit-to-box image) inside
    `box` on `page`. Defaults match the original one-image-per-page sizing;
    the half-page stacked case (see build_form101_pdf's extraPages loop below)
    passes smaller values since each box is half the page's height."""
    img_bytes = base64.b64decode(extra["b64"])
    max_w, max_h = box.width - margin * 2, box.height - margin * 2 - cap_h
    embed_bytes, iw, ih = _shrink_for_embed(img_bytes, max_w, max_h)
    if iw is None:
        pix = pymupdf.Pixmap(img_bytes)
        embed_bytes, iw, ih = img_bytes, pix.width, pix.height
    fit = min(max_w / iw, max_h / ih, 1)
    w, h = iw * fit, ih * fit
    x = box.x0 + (box.width - w) / 2
    y = box.y0 + margin + cap_h
    page.insert_text((box.x0 + margin, box.y0 + margin + 16), extra.get("caption", "Document scan"),
                      fontsize=fontsize, color=(0.3, 0.3, 0.3))
    page.draw_rect(pymupdf.Rect(x - 2, y - 2, x + w + 2, y + h + 2),
                    color=(0.7, 0.7, 0.7), fill=(1, 1, 1), width=1)
    page.insert_image(pymupdf.Rect(x, y, x + w, y + h), stream=embed_bytes)


def _ddmmyyyy(value):
    """'1.2.2018', '01/02/2018' or '2018-02-01' -> '01022018' for the 8-box
    date combs; anything else falls back to its digits."""
    s = str(value or "").strip()
    m = re.fullmatch(r"(\d{1,2})\D(\d{1,2})\D(\d{4})", s)
    if m:
        return m.group(1).zfill(2) + m.group(2).zfill(2) + m.group(3)
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return m.group(3).zfill(2) + m.group(2).zfill(2) + m.group(1)
    return re.sub(r"\D", "", s)


# Section ו (spouse) checkboxes, verified by position on the template:
# cb_p1_22 "אין לבן/בת הזוג כל הכנסה", cb_p1_23 "יש לבן/בת הזוג הכנסה",
# then its type: cb_p1_24 "עבודה/קצבה/עסק", cb_p1_25 "הכנסה אחרת".
SPOUSE_INCOME_CB = {"none": ["cb_p1_22"], "work": ["cb_p1_23", "cb_p1_24"], "other": ["cb_p1_23", "cb_p1_25"]}


def fill_spouse(b, sp):
    """Form 101 section ו. `spouse_employer_deductions` is the spouse's ID
    number box despite its name (it sits under "מספר זהות (9 ספרות)")."""
    if not sp:
        return
    b.set_hebrew("spouse_surname", sp.get("surname"), 11)
    b.set_hebrew("spouse_given_name", sp.get("given"), 11)
    ident = re.sub(r"\s", "", str(sp.get("idNo") or ""))
    if re.fullmatch(r"\d{8,9}", ident):
        b.set_comb("spouse_employer_deductions", ident.zfill(9), 9, 10)
    elif ident:
        # Not an Israeli ID — the passport box is for spouses without one.
        b.set_comb("spouse_passport_no", ident.upper(), 13, 10)
    b.set_comb("spouse_dob", _ddmmyyyy(sp.get("dob")), 8, 10)
    for cb in SPOUSE_INCOME_CB.get(sp.get("income"), []):
        b.check(cb)


def build_form101_pdf(p):
    b = Form101Builder()
    page_h = b.page1.rect.height

    surname, given = p.get("surname"), p.get("given")
    dob, sex, no = p.get("dob"), p.get("sex"), p.get("no")
    is_israeli = bool(p.get("isIsraeli"))

    b.set_hebrew("surname", surname, 11)
    b.set_hebrew("given_name", given, 11)
    b.set_comb("dob", _ddmmyyyy(dob), 8, 10)
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
        b.set_hebrew("employer_phone", employer.get("phone"), 10)
        if employer.get("deductionsFileNumber"):
            # The form prints the leading "9" of the 9-digit deductions file
            # number itself; its 8 boxes take the rest — the LAST 8 digits.
            digits = re.sub(r"\D", "", str(employer["deductionsFileNumber"]))[-8:]
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
        # Foreign-passport worker: single unless a status was set by hand.
        b.check(p.get("marital") or "marital_single")
    b.check("cb_p1_1")  # kibbutz member — always "No" for this app's workers

    fill_spouse(b, p.get("spouse"))

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
        marital = p.get("marital")
        if marital:
            b.check(marital)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)
    else:
        b.set_comb("passport_no", no, 13, 10)
        fill_work_start(p.get("workStart"))
        fund = p.get("healthFund")
        if fund:
            b.check("hf_yes")
            b.set_hebrew("hf_name", HEALTH_FUND_HE.get(fund, fund), 11)

    # Address in Israel and children — both document types (a foreign
    # worker fills them in by hand; an Israeli ID worker gets them from the ספח).
    addr = p.get("address")
    if addr:
        street, number = _split_street(addr)
        b.set_hebrew("addr_street", street, 11)
        if number:
            b.set_text_centered("addr_number", number)
    b.set_hebrew("addr_city", p.get("city"), 11)
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
            dd = _ddmmyyyy(c["dob"])
            if dd:
                b.set_comb(f"child_dob{suf}", dd, 8, 10)
        if c.get("idNo"):
            # Israeli ID digits, or a foreign child's passport number.
            ident = re.sub(r"[^0-9A-Za-z]", "", str(c["idNo"])).upper()
            if ident:
                b.set_comb(f"child_passport_no{suf}", ident, 9, 10)

    phone = p.get("workerPhone")
    if phone:
        b.set_hebrew("worker_phone", phone, 10)

    sig_b64 = p.get("signaturePngBase64")
    if sig_b64:
        try:
            sig_bytes = base64.b64decode(sig_b64)
            rect = pdf_rect(page_h, *SIG_RECT)
            embed_bytes, sw, sh = _shrink_for_embed(sig_bytes, rect.width, rect.height)
            if sw is None:
                pix = pymupdf.Pixmap(sig_bytes)
                embed_bytes, sw, sh = sig_bytes, pix.width, pix.height
            scale = min(rect.width / sw, rect.height / sh)
            w, h = sw * scale, sh * scale
            img_rect = pymupdf.Rect(
                rect.x0 + (rect.width - w) / 2, rect.y0 + (rect.height - h) / 2,
                rect.x0 + (rect.width - w) / 2 + w, rect.y0 + (rect.height - h) / 2 + h,
            )
            b.page2.insert_image(img_rect, stream=embed_bytes)
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
        # Latin and Hebrew letters, digits and single spaces only. A quote
        # inside a Hebrew word (בע"מ) becomes the Hebrew gershayim (בע״מ):
        # a plain quote isn't allowed in a Windows file name.
        s = re.sub(r'(?<=[֐-׿])"(?=[֐-׿])', "״", str(s or ""))
        s = re.sub(r"(?<=[֐-׿])'", "׳", s)
        return re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9֐-׿ ]", " ", s)).strip()

    # "<given> <surname> - <ID or passport number> - <company>.pdf" (per
    # user request 2026-10-05); an empty part is left out.
    full_name = " ".join(x for x in (fn_part(given), fn_part(surname)) if x) or "worker"
    parts = [full_name, re.sub(r"[^A-Za-z0-9]", "", str(no or "")).upper(), fn_part(employer.get("companyName"))]
    file_name = " - ".join(x for x in parts if x) + ".pdf"

    return b.finalize(), file_name, firm_missing


options.set_global_options(region="us-central1")


def _verify_token(token):
    """The claims of a verified, not revoked Firebase ID token (gate.check)."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    return fb_auth.verify_id_token(token, check_revoked=True)


def _gate_response(req):
    """A 401 / 403 response for a caller who may not use these functions
    (gate.py: a manager-side login with a valid ID token), None otherwise."""
    status, error = gate.check(req.headers, _verify_token)
    if status:
        return https_fn.Response(json.dumps({"error": error}), status=status, mimetype="application/json")
    return None


def _ping_response(payload):
    """Warm-up call from the app ({"ping": true}, 2026-10-01): wakes a cold
    instance while the user is still taking photos / filling the worker
    form, so the real request that follows doesn't pay the cold start.
    Returns a response for a ping, None otherwise."""
    if isinstance(payload, dict) and payload.get("ping") is True:
        return https_fn.Response(json.dumps({"ok": True, "warm": True}), status=200, mimetype="application/json")
    return None


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.MB_512,
    timeout_sec=60,
)
def fill_form_101(req: https_fn.Request) -> https_fn.Response:
    if req.method != "POST":
        return https_fn.Response(json.dumps({"error": "POST only"}), status=405, mimetype="application/json")
    try:
        # force=True: parse the JSON body whatever Content-Type the caller sent
        # (Flask's get_json() otherwise returns None for text/plain).
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        denied = _gate_response(req)
        if denied:
            return denied
        pdf_bytes, file_name, firm_missing = build_form101_pdf(payload)
        body = json.dumps({
            "pdfBase64": base64.b64encode(pdf_bytes).decode(),
            "fileName": file_name,
            "firmMissing": firm_missing,
        })
        return https_fn.Response(body, status=200, mimetype="application/json")
    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


# ===== The scanner's training data (scan_feedback below) =====
# The site's scanner is the lab's page (docs/scan.md); the server keeps only the training data.
# The scanner's model version: the same as scripts/scan/models-version (tests/auth checks it),
# written into each kept example.
MODEL_PREFIX = "models/scan/" + (pathlib.Path(__file__).parent / "scan_models_version.txt").read_text().strip() + "/"
MODEL_BUCKETS = ("schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com")


def _model_bucket(storage):
    """The project's default bucket (one of its two possible names)."""
    if not firebase_admin._apps:
        firebase_admin.initialize_app()
    last = None
    for name in MODEL_BUCKETS:
        try:
            b = storage.bucket(name)
            # listing needs only the objects' read right (exists() also needs storage.buckets.get)
            next(iter(b.list_blobs(max_results=1)), None)
            return b
        except Exception as e:  # not this project's bucket name
            last = e
    raise RuntimeError(f"no Storage bucket reachable: {last}")


# The server's Hugging Face token, in Secret Manager (docs/hf-plan.md → H1): it may only write to
# the private bucket; scan_feedback gets it as the environment variable datastore.py reads.
HF_DATA_TOKEN = SecretParam("HF_DATA_TOKEN")


# How the scan window uses the document type model on the phone (Admin → Scanner, docs/hf-plan.md →
# The way a model replaces the AI): "off" — not used; "shadow" — Haiku types the page, the model's
# answer only recorded (doctypeShadow), never trusted; "mixed" — a page it is sure of needs no Haiku.
# scanSettings/current.doctypeMode, read by the scan window ("mode"); shadow until the super-admin moves it on.
DOCTYPE_MODES = ("off", "shadow", "mixed")


def _json(obj, status=200):
    return https_fn.Response(json.dumps(obj, default=str), status=status, mimetype="application/json")


def collects_documents(db, tenant_id):
    """Whether a firm's full documents are collected (docs/hf-plan.md → H8a): on unless the
    super-admin turned it off (tenants/<id>/settings/scan.collectDocuments == false)."""
    if not tenant_id:
        return False
    snap = db.collection("tenants").document(tenant_id).collection("settings").document("scan").get()
    return (snap.to_dict() or {}).get("collectDocuments") is not False


def _scan_settings(payload, db):
    """Admin → Scanner (a super-admin): {"action": "settings"} → the document type model's mode and
    every firm's full-document collection; {"action": "setSettings", "doctypeMode"?, "collect"?: {tenantId: bool}}."""
    ref = db.collection("scanSettings").document("current")
    if payload.get("action") == "setSettings":
        mode = payload.get("doctypeMode")
        if mode is not None:
            if mode not in DOCTYPE_MODES:
                return _json({"error": "unknown mode"}, 400)
            ref.set({"doctypeMode": mode}, merge=True)
        for tid, on in (payload.get("collect") or {}).items():
            if isinstance(tid, str) and tid and isinstance(on, bool):
                db.collection("tenants").document(tid).collection("settings").document("scan").set({"collectDocuments": on}, merge=True)
    cur = ref.get().to_dict() or {}
    collect = {}
    for t in db.collection("tenants").stream():
        collect[t.id] = collects_documents(db, t.id)
    return _json({"ok": True, "doctypeMode": cur.get("doctypeMode") if cur.get("doctypeMode") in DOCTYPE_MODES else "shadow", "collect": collect})


def _scan_document(payload, claims, db, stats_ref, storage):
    """A full document with the fields the user saved (H8a): kept when the firm collects them."""
    from firebase_admin import firestore
    tenant = claims.get("tenantId") or ""
    if not collects_documents(db, tenant):
        return _json({"ok": True, "kept": False, "why": "off for this firm"})
    doc, why = feedback.check_document(payload)
    if not doc:
        return _json({"error": why}, 400)
    now = datetime.datetime.now(datetime.timezone.utc)
    doc_id = db.collection("scanTraining").document().id
    base = f"documents/{tenant}/{now:%Y-%m}/{doc_id}"
    paths = datastore.put([(f"{base}/page-{i + 1}.jpg", pg["image"]) for i, pg in enumerate(doc["pages"])], lambda: _model_bucket(storage))
    datastore.put([(f"{base}/record.json", datastore.as_json(feedback.document_record(doc, tenant, now, doc_id, paths)))], lambda: _model_bucket(storage))
    stats_ref.set({"documentsSince": firestore.Increment(1), "documents": firestore.Increment(1),
                   "fieldsCorrected": firestore.Increment(len(doc["corrected"])), "updatedAt": now}, merge=True)
    return _json({"ok": True, "kept": True})


@https_fn.on_request(
    cors=options.CorsOptions(cors_origins="*", cors_methods=["post"]),
    memory=options.MemoryOption.MB_512,
    cpu=1,
    concurrency=20,
    timeout_sec=60,
    secrets=[HF_DATA_TOKEN],  # write-only to the private training-data bucket (datastore.py)
)
def scan_feedback(req: https_fn.Request) -> https_fn.Response:
    """The scanner's training examples (feedback.py; docs/scan-plan.md → S6).
    {"action": "add", "examples": [...]} from the scan window's Done (any manager
    login): pages whose corners the user moved are kept, the rest only counted.
    {"action": "document", "pages", "read", "reads", "scanned", "saved", "workerId"} from the
    save of the worker window after a scan: a full document for the field reader model (H8a).
    {"action": "stats"} (a super-admin): the counts, and whether retraining is due.
    The files go to the private Hugging Face bucket once the server has its token, else to
    Firebase Storage training/ (datastore.py)."""
    if req.method != "POST":
        return _json({"error": "POST only"}, 405)
    try:
        payload = req.get_json(silent=True, force=True) or {}
        pong = _ping_response(payload)
        if pong:
            return pong
        status, error, claims = gate.claims_of(req.headers, _verify_token)
        if status:
            return _json({"error": error}, status)
        from firebase_admin import firestore, storage
        db = firestore.client()
        stats_ref = db.collection("scanTrainingStats").document("current")
        if payload.get("action") in ("settings", "setSettings"):
            if claims.get("role") != "superadmin":
                return _json({"error": "Only the super-admin sees the scanner's training"}, 403)
            return _scan_settings(payload, db)
        if payload.get("action") == "mode":  # the scan window (any manager login): how to use the document type model
            cur = db.collection("scanSettings").document("current").get().to_dict() or {}
            return _json({"ok": True, "doctypeMode": cur.get("doctypeMode") if cur.get("doctypeMode") in DOCTYPE_MODES else "shadow"})
        if payload.get("action") == "stats":
            if claims.get("role") != "superadmin":
                return _json({"error": "Only the super-admin sees the scanner's training"}, 403)
            stats = (stats_ref.get().to_dict() or {})
            return _json({"ok": True, "stats": stats, "due": feedback.edges_since(stats) >= feedback.RETRAIN_AT, "edgesSince": feedback.edges_since(stats),
                          "doctypes": feedback.doctype_counts(stats), "doctypesDue": feedback.doctypes_due(stats)})
        if payload.get("action") == "document":
            return _scan_document(payload, claims, db, stats_ref, storage)
        examples = payload.get("examples")
        if not isinstance(examples, list) or not examples:
            return _json({"error": "no examples"}, 400)
        now = datetime.datetime.now(datetime.timezone.utc)
        bucket = []
        fb = lambda: bucket[0] if bucket else (bucket.append(_model_bucket(storage)) or bucket[0])
        kept = right = bad = fixes = 0
        moved_sum = 0.0
        doctypes, shadow = {}, {}
        for raw in examples[:feedback.MAX_EXAMPLES]:
            ex, why = feedback.check(raw)
            if not ex:
                bad += 1
                continue
            if not feedback.correction(ex):
                right += 1
            for k, n in feedback.shadow_counts(ex).items():
                shadow[k] = shadow.get(k, 0) + n
            if not feedback.kept(ex):
                continue
            ex["model"] = MODEL_PREFIX.rstrip("/").rsplit("/", 1)[-1]  # the version that found these corners
            ref = db.collection("scanTraining").document()
            files = []
            if ex["image"] is not None:
                files.append((f"edges/{now:%Y-%m}/{ref.id}.jpg", ex["image"]))
            if ex["pageImage"] is not None:
                files.append((f"doctype/{now:%Y-%m}/{ref.id}.jpg", ex["pageImage"]))
                doctypes[ex["doctypeFixed"]] = doctypes.get(ex["doctypeFixed"], 0) + 1
            stored = dict(zip([f[0].split("/", 1)[0] for f in files], datastore.put(files, fb)))
            rec = feedback.record(ex, claims.get("tenantId"), now, stored.get("edges"), stored.get("doctype"))
            if all(not str(p or "").startswith("training/") for p in (rec.get("image"), rec.get("pageImage"))) and datastore.on_hf():
                # the copies went to the bucket: the record goes beside them; nothing about the example stays in Firebase
                rec.pop("deleteAt", None)
                if datastore.put([(f"records/{now:%Y-%m}/{ref.id}.json", datastore.as_json({"id": ref.id, **rec}))], fb)[0].startswith("training/"):
                    ref.set(rec)  # the bucket refused the record: it stays in Firestore with its copies' paths
            else:
                ref.set(rec)
            kept += 1
            fixes += feedback.edges_correction(ex)
            moved_sum += ex["moved"]
        # edgesSince counts the corrections only: they make a retraining due, the kept right pages do not
        # doctypesSince: the page copies of each document type (by the type the user left), for the document type model
        update = {"edgesSince": firestore.Increment(fixes), "kept": firestore.Increment(kept),
                  "right": firestore.Increment(right), "movedSum": firestore.Increment(moved_sum), "updatedAt": now}
        if doctypes:  # an empty map under merge would wipe the counts
            update["doctypesSince"] = {k: firestore.Increment(n) for k, n in doctypes.items()}
        update.update({k: firestore.Increment(n) for k, n in shadow.items()})
        stats_ref.set(update, merge=True)
        return _json({"ok": True, "kept": kept, "right": right, "refused": bad})
    except Exception as e:
        return _json({"error": str(e)}, 500)
