"""FROZEN (builder b2, docs/documents-plan.md → S1): never edit this file; a change is a new file, form101_b3.py.
form101_b1.py with one change: the attached sheet's words in `sheetLang` (sheets_b2.py). The two form pages are as in b1.
The golden hashes (tests/auth/builder_golden.json) guard its output; docs/form101-field-map.md describes it.

Form 101 (docs/form101.md): `build_form101_pdf` fills assets/form101/v1.pdf with the worker / employer values the
manager app sends (`form101Payload`, src/manager/logic/form101.ts), the scanned pages and the signature. Field
positions: docs/form101-field-map.md.

PyMuPDF's own appearance-stream generator does not shape / reorder RTL text, so every Hebrew field is corrected with
bidi.algorithm.get_display() and drawn by hand — see _draw_rtl_text().

The same inputs give the same bytes: the save is fixed (`no_new_id`, the trailer /ID from the input manifest's hash, or
a hash of the payload), the tax year comes from the inputs, and every picture goes through Pillow (pinned), decoded whole."""
import base64
import hashlib
import json
import pathlib
import re
from datetime import date

import pymupdf
from bidi.algorithm import get_display

from . import sheets_b2

ASSETS_DIR = pathlib.Path(__file__).resolve().parent.parent / "assets"
TEMPLATE_PATH = ASSETS_DIR / "form101" / "v1.pdf"
FONT_PATH = ASSETS_DIR / "heebo-hebrew.ttf"
FONT_NAME = "Heebo"

E_NOT_PLACED = "The signature or a page could not be placed on Form 101"
E_NO_YEAR = "Form 101 has no signing date to take its tax year from"


class NotPlaced(ValueError):
    """Strict mode: the signature or a page could not be placed (a signed document never goes out without it)."""


class NoTaxYear(ValueError):
    """Strict mode: neither `taxYear` nor a readable `signDate` (a signed document never takes its year from the clock)."""


HEALTH_FUND_HE = {"Clalit": "כללית", "Maccabi": "מכבי", "Meuhedet": "מאוחדת", "Leumit": "לאומית"}
INCOME_TYPE_CB = {"monthly": "cb_p1_4", "secondary": "cb_p1_5", "partial": "cb_p1_6",
                  "daily": "cb_p1_7", "pension": "cb_p1_8", "scholarship": "cb_p1_9"}
OTHER_INCOME_CB = {"monthly": "cb_p1_13", "secondary": "cb_p1_15", "partial": "cb_p1_17",
                   "daily": "cb_p1_12", "pension": "cb_p1_14", "scholarship": "cb_p1_16"}
CHECK_BLUE = (0.09, 0.32, 0.85)

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

    # ---- field writers ----

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

    def finalize(self, flatten=True, file_id=None):
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
        # Flatten (owner, 2026-10-27): the fields' appearances are baked into the page and the fields removed, so
        # a viewer shows a plain document — not a fillable form with its blue field boxes and comb marks. The
        # values drawn by hand (set_hebrew, check…) are page content already; the ones PyMuPDF drew in a field's
        # own appearance (set_text, set_comb) become page content here.
        if flatten:
            self.doc.bake(annots=False, widgets=True)
        # garbage=4 drops unused/duplicate objects (the biggest win on a doc
        # with several embedded scan/signature images), deflate*=True compresses
        # any stream that isn't already, clean=True repacks page content more
        # compactly. Pure container-level cleanup — doesn't touch pixel data,
        # safe to always apply.
        # The fixed save: no new id, the trailer's /ID given by the caller, so the same inputs give the same bytes.
        self.doc.xref_set_key(-1, "ID", f"[<{file_id}><{file_id}>]")
        return self.doc.tobytes(garbage=4, deflate=True, deflate_images=True, clean=True, no_new_id=True)


def _split_street(addr):
    """Street name + number in one string (an older caller's `address`): the
    number may come first or last."""
    m_end = re.match(r"^(.*?)(\d+)\s*$", addr or "")
    if m_end:
        return m_end.group(1).strip(), m_end.group(2).strip()
    m_start = re.match(r"^(\d+)\s+(.*)$", addr or "")
    if m_start:
        return m_start.group(2).strip(), m_start.group(1).strip()
    return addr, None


_shrink_for_embed = sheets_b2.shrink_for_embed


def _draw_extra_page_image(page, extra, box, margin=40, cap_h=24, fontsize=13, strict=False):
    """Draws one extraPages entry (caption + bordered, fit-to-box image) inside
    `box` on `page`. Defaults match the original one-image-per-page sizing;
    the half-page stacked case (see build_form101_pdf's extraPages loop below)
    passes smaller values since each box is half the page's height. strict: a picture
    Pillow cannot decode whole raises instead of going in as MuPDF reads it."""
    img_bytes = base64.b64decode(extra["b64"])
    max_w, max_h = box.width - margin * 2, box.height - margin * 2 - cap_h
    embed_bytes, iw, ih = _shrink_for_embed(img_bytes, max_w, max_h)
    if iw is None:
        if strict:
            raise NotPlaced(E_NOT_PLACED)
        pix = pymupdf.Pixmap(img_bytes)
        embed_bytes, iw, ih = img_bytes, pix.width, pix.height
    fit = min(max_w / iw, max_h / ih, 1)
    w, h = iw * fit, ih * fit
    x = box.x0 + (box.width - w) / 2
    y = box.y0 + margin + cap_h
    # An attached page, not one of the form's own two: the Hebrew-only rule does not reach it (owner, 2026-10-31)
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


def _israeli_id(no):
    """An Israeli ID's digits; one typed without its leading 0 (8 digits) is padded to 9."""
    ident = re.sub(r"\D", "", str(no or ""))
    return ident.zfill(9) if re.fullmatch(r"\d{8}", ident) else ident


def _tax_year(p, strict=False):
    """The tax year printed: `taxYear`, else the year of `signDate`; then this year, but never in strict mode."""
    if p.get("taxYear"):
        return str(p["taxYear"])
    s = str(p.get("signDate") or "")
    m = re.fullmatch(r"\s*\d{1,2}\D\d{1,2}\D(\d{4})\s*", s) or re.fullmatch(r"\s*(\d{4})\D\d{1,2}\D\d{1,2}.*", s)
    if m:
        return m.group(1)
    if strict:
        raise NoTaxYear(E_NO_YEAR)
    return str(date.today().year)


def _file_id(p, manifest_sha256):
    """The trailer /ID's 16 bytes in hex: from the input manifest's SHA-256, else (nothing signed yet) from a hash of the payload."""
    if manifest_sha256:
        return str(manifest_sha256)[:32]
    return hashlib.sha256(json.dumps(p, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()[:32]


def _add_pages_by_kind(b, extra_pages, passport_worker, lang):
    """extraPages with a `kind` (id_front, id_back, sefach, passport, other): the A4 sheet, then each other page → dropped count."""
    pages, dropped = [], 0
    for extra in extra_pages:
        try:
            pages.append({"kind": extra.get("kind"), "data": base64.b64decode(extra["b64"])})
        except Exception:
            dropped += 1
    return dropped + sheets_b2.add_scans(b.doc, pages, passport_worker, FONT_PATH, lang)[2]


def build_form101_pdf(p, flatten=True, strict=False, manifest_sha256=None, report=None):
    """→ (pdf bytes, file name). flatten=False keeps the form's fields (the tests read the values from them); every
    caller gets a flat PDF. strict: raises NotPlaced when the signature or a page cannot be placed, and NoTaxYear when
    the tax year would come from the clock (signing and rebuilds); otherwise what could not be placed is left out and
    counted in report["dropped"] (report: a dict, when given)."""
    dropped = 0

    def not_placed(e):
        nonlocal dropped
        if strict:
            raise NotPlaced(E_NOT_PLACED) from e
        dropped += 1

    b = Form101Builder()
    page_h = b.page1.rect.height

    surname, given = p.get("surname"), p.get("given")
    dob, sex, no = p.get("dob"), p.get("sex"), p.get("no")
    is_israeli = bool(p.get("isIsraeli"))
    if is_israeli and no:
        no = _israeli_id(no) or no

    b.set_hebrew("surname", surname, 11)
    b.set_hebrew("given_name", given, 11)
    b.set_comb("dob", _ddmmyyyy(dob), 8, 10)
    b.set_text("id_top2", no, 10)

    tax_year = _tax_year(p, strict)
    b.set_comb("tax_year", tax_year, 4, 10)

    employer = p.get("employer") or {}
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
            b.set_comb("employer_zeut_num", _israeli_id(no), 9, 10)
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
    # The street and the house number come apart (a number such as "12א" or "12/3" stays
    # whole); an older caller sends them as one `address`, split by _split_street.
    if p.get("street") or p.get("houseNumber"):
        street, number = str(p.get("street") or "").strip(), str(p.get("houseNumber") or "").strip()
        # No house number of its own: an older record keeps it inside the street ("הרצל 12").
        if street and not number:
            street, number = _split_street(street)
    else:
        street, number = _split_street(p.get("address")) if p.get("address") else (None, None)
    if street:
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
                if strict:
                    raise NotPlaced(E_NOT_PLACED)
                pix = pymupdf.Pixmap(sig_bytes)
                embed_bytes, sw, sh = sig_bytes, pix.width, pix.height
            scale = min(rect.width / sw, rect.height / sh)
            w, h = sw * scale, sh * scale
            img_rect = pymupdf.Rect(
                rect.x0 + (rect.width - w) / 2, rect.y0 + (rect.height - h) / 2,
                rect.x0 + (rect.width - w) / 2 + w, rect.y0 + (rect.height - h) / 2 + h,
            )
            b.page2.insert_image(img_rect, stream=embed_bytes)
        except Exception as e:
            not_placed(e)

    extra_pages = p.get("extraPages") or []
    pw, ph = b.page1.rect.width, b.page1.rect.height
    if any(isinstance(e, dict) and e.get("kind") for e in extra_pages):
        # By kind: one A4 with the ID card (front, back) or the passport and the ספח, then each other page.
        lost = _add_pages_by_kind(b, extra_pages, not is_israeli, p.get("sheetLang"))
        if lost and strict:
            raise NotPlaced(E_NOT_PLACED)
        dropped += lost
        remaining_pages = []
    # No page says its kind (an older caller): the first two entries are, in the overwhelming common case, the
    # document's own two sides — the ID front ("Document scan") and its ספח appendix card (captioned "Document") — so
    # they go stacked on ONE page instead of two separate ones. This is a heuristic keyed on position, not content;
    # any further entries (a contract, etc.) still get one page each.
    elif len(extra_pages) >= 2:
        combo_page = b.doc.new_page(width=pw, height=ph)
        half_h = ph / 2
        for extra, box in ((extra_pages[0], pymupdf.Rect(0, 0, pw, half_h)),
                            (extra_pages[1], pymupdf.Rect(0, half_h, pw, ph))):
            try:
                _draw_extra_page_image(combo_page, extra, box, margin=24, cap_h=20, fontsize=12, strict=strict)
            except Exception as e:
                not_placed(e)
        remaining_pages = extra_pages[2:]
    else:
        remaining_pages = extra_pages

    for extra in remaining_pages:
        try:
            new_page = b.doc.new_page(width=pw, height=ph)
            _draw_extra_page_image(new_page, extra, pymupdf.Rect(0, 0, pw, ph), strict=strict)
        except Exception as e:
            not_placed(e)

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

    if isinstance(report, dict):
        report["dropped"] = dropped
    return b.finalize(flatten, _file_id(p, manifest_sha256)), file_name
