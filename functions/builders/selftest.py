"""The builders' fixed inputs and their hashes (docs/documents-plan.md → S1): the same inputs for
tests/auth/test_builder_determinism.py, the Tests workflow's Cloud Functions image check and production's self-check
(`fill_form_101` {"ping": true, "selftest": true}), each compared with tests/auth/builder_golden.json.

Made-up values only: nothing here is a real worker or firm. The pictures are constants, so that no case depends on
anything but the builder and its pinned libraries; the two contract templates are drawn here by the pinned PyMuPDF."""

import base64
import hashlib
import pathlib
import platform

import pymupdf
from bidi.algorithm import get_display

from . import BUILDER_VERSION, BUILDERS

ID_JPEG = "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"
TALL_JPEG = "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"
PAGE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAFAAAAA8CAIAAAB+RarbAAABc0lEQVR4nOXYsW3DMBCF4adAlUbwBtwmQ7iJizSZw02KpMkQ3oa1G9UZwYUAwjYMWSaPx3fHq6RK+PA/uPBw/j+jjwu7EOc4dAIOu7A8jOiGCiDOcexEG+e4PNyAj6ff8m98vX+AVQuvk76bMa7OIfhh2HRv6EkLT4VXZuwQ/DSsq0lv18J64Y0zdgJ+Kaz5SedpYbFwxowNg7PDmpx0uRZWChfO2BhYJKyZSctqwVxYcMYGwOJhqSddTwu2wpVmTAquGpZu0jpaMBRWmDERWC0sxaT1tWhVWHnGjcFNwrYBNwzbANw2rPaPFokWCoUZZqwH5gmrMWlCLSoVZptxXTBn2FqT/jt8M2shWDhRmbWQKpy0+59PZi1EwNda0N8oNWMTWpSAbYUtnbRRLTIKW5xxPthu2JxJO9BiY2HrM34N7CPs1kk702KlsKcZPwf7C7s2acda3BX2OuPHYPJ/KoQnHfrQAhimaUov7rVIk+6ButwFf5y+xjjNnHcAAAAASUVORK5CYII="
SIGNATURE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAYAAAA16j4lAAABaklEQVR4nO2b27HCMAxELWrYIiiL0ijrFkEP8OWB8Tg3ceI4K3nPDz8M0fpEypOUhBBCCCHEXOD+fP9+inYskVKT+vp70NbLyi0RilXHtrO0ZlSC18RKfHtD3LyNZElum3SXH9OWivyVq+Pxl9a1MHa5S9+d7YQLO086zVPBM0rGwasJ81T0TKManbIa60je+huRBKPD+pSYx+KjScYJYjNDFqb3aI0yqjEgh3ndMz1LxsDazaPcpW2wC8YFO6V5D+JBMi6cNuata7dsk0UyCGo7bVyODMTWxSAQm7EogRgkg2AdSsxr126p5TWoDkaxma7XolcHG73QIBabsWjBRoxqEOcvOXybkDHcWZLhIHvJ7pv8zAF7ioCj3DUsasijXQyHmWuEfgaLHZI9561hkfdgNMiKJjazOazXwFgRF1VsUwd7D4zKqI4uNrP6kluU0PjnHeIoGWuEDVaCSTp2aqD/PQkhhBAijeEDF+RCKhXALU0AAAAASUVORK5CYII="

MANIFEST = hashlib.sha256(b"builder selftest").hexdigest()
FONT = str(pathlib.Path(__file__).resolve().parent.parent / "assets" / "heebo-hebrew.ttf")

FORM = {
    "isId": True, "isIsraeli": True, "surname": "כהן", "given": "דנה", "no": "12345678", "dob": "01/02/1990", "sex": "F",
    "signDate": "15/03/2026", "workerPhone": "050-1234567", "incomeType": "monthly", "otherIncomeType": "none",
    "employer": {"companyName": "חברה לדוגמה בע\"מ", "street": "הנמל", "streetNumber": "5", "city": "חיפה", "phone": "04-1234567",
                 "deductionsFileNumber": "912345678"},
    "street": "הרצל", "houseNumber": "12א", "address": "הרצל 12א", "city": "חיפה", "marital": "marital_married",
    "workStart": "2026-03-01", "healthFund": "Clalit",
    "children": [{"name": "יעל כהן", "dob": "2015-06-01", "idNo": "123456782"}, {"name": "רון", "dob": "2018-07-02", "idNo": ""}],
    "spouse": {"surname": "כהן", "given": "משה", "idNo": "12345674", "dob": "02/03/1988", "income": "work"},
}
PASSPORT = {"isId": False, "isIsraeli": False, "surname": "SMITH", "given": "JOHN", "no": "AB1234567", "dob": "1985-01-20", "sex": "M",
            "signDate": "15/03/2026", "employer": FORM["employer"], "workStart": "2026-03-01", "city": "חיפה", "street": "הרצל", "houseNumber": "1"}
VALUES = {"given": "דנה", "surname": "כהן", "id": "012345678", "company": "חברה לדוגמה בע\"מ", "today": "15/03/2026", "sign_date": "15/03/2026",
          "rate": "45 ₪", "client_name": "לקוח לדוגמה"}
SEAL = {"signature": base64.b64decode(SIGNATURE_PNG), "stamp": base64.b64decode(SIGNATURE_PNG), "every_page": True}


def _b(s):
    return base64.b64decode(s)


def _pages(*items):
    return [{"b64": data, "mediaType": "image/jpeg", "kind": kind, "caption": "Document"} for kind, data in items]


def text_template():
    """A contract template with typed marks, Hebrew text set in the Heebo font (which the fill subsets) and two pages."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontfile=FONT, fontname="Heebo")
    page.insert_text((72, 90), get_display("חוזה העסקה"), fontname="Heebo", fontsize=16)
    page.insert_text((72, 130), "Name: {{given}} {{surname}}   ID: {{id}}", fontsize=12)
    page.insert_text((72, 160), "Firm: {{company}}   Rate: {{rate}}   Date: {{today}}", fontsize=12)
    page.insert_text((72, 240), "Signed: {{signature}}", fontsize=12)
    page.insert_text((320, 240), "{{company_signature}}", fontsize=12)
    page.insert_text((320, 300), "{{stamp}}", fontsize=12)
    doc.new_page(width=595, height=842).insert_text((72, 90), "Second page, on {{sign_date}}", fontsize=12)
    return doc.tobytes(garbage=4, deflate=True, no_new_id=True)


def picture_template():
    """A contract template that is only a picture: its marks are placed by hand."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=_b(ID_JPEG), keep_proportion=False)
    return doc.tobytes(garbage=4, deflate=True, no_new_id=True)


PLACED = [{"mark": "given", "page": 0, "x": 300.0, "y": 100.0, "w": 120.0, "h": 18.0, "rtl": True},
          {"mark": "signature", "page": 0, "x": 80.0, "y": 300.0, "w": 120.0, "h": 18.0, "rtl": False},
          {"mark": "stamp", "page": 0, "x": 300.0, "y": 400.0, "w": 60.0, "h": 18.0, "rtl": False}]


def client_template():
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 100), "Client: {{client_name}}   {{client_signature}}", fontsize=12)
    return doc.tobytes(garbage=4, deflate=True, no_new_id=True)


def cases(version=BUILDER_VERSION):
    """{case name: a function building its PDF bytes} of one builder version. Every name is in builder_golden.json. A case
    has the same inputs in every version; from b2 on the sheet has a language (none given: English), so its Hebrew has cases too."""
    b = BUILDERS[version]
    form, contract, sheet = b["form101"], b["contract"], b["sheet"]
    jpg, tall, png, sig = ID_JPEG, TALL_JPEG, PAGE_PNG, SIGNATURE_PNG
    signed = dict(FORM, signaturePngBase64=sig)
    he = {} if version == "b1" else {
        "form101_by_kind_he": lambda: form(dict(signed, sheetLang="he", extraPages=_pages(("id_front", jpg), ("id_back", jpg), ("sefach", tall), ("other", png))),
                                           strict=True, manifest_sha256=MANIFEST)[0],
        "form101_no_sefach_he": lambda: form(dict(signed, sheetLang="he", extraPages=_pages(("id_front", jpg))), strict=True, manifest_sha256=MANIFEST)[0],
        "form101_passport_he": lambda: form(dict(PASSPORT, signaturePngBase64=sig, sheetLang="he", extraPages=_pages(("passport", tall), ("other", jpg))),
                                            strict=True, manifest_sha256=MANIFEST)[0],
        "sheet_id_he": lambda: sheet([{"kind": "id_front", "data": _b(jpg)}, {"kind": "id_back", "data": _b(jpg)}, {"kind": "sefach", "data": _b(tall)},
                                      {"kind": "other", "data": _b(png)}], False, MANIFEST, "he")[0],
        "sheet_passport_he": lambda: sheet([{"kind": "passport", "data": _b(tall)}], True, MANIFEST, "he")[0],
    }
    return {
        **he,
        "form101_empty_pages": lambda: form(FORM)[0],
        "form101_positional": lambda: form(dict(signed, extraPages=[{"b64": jpg, "caption": "Document scan"}, {"b64": tall, "caption": "Document"},
                                                                    {"b64": png, "caption": "Document"}]), strict=True, manifest_sha256=MANIFEST)[0],
        "form101_by_kind": lambda: form(dict(signed, extraPages=_pages(("id_front", jpg), ("id_back", jpg), ("sefach", tall), ("other", png))),
                                        strict=True, manifest_sha256=MANIFEST)[0],
        "form101_no_sefach": lambda: form(dict(signed, extraPages=_pages(("id_front", jpg))), strict=True, manifest_sha256=MANIFEST)[0],
        "form101_passport": lambda: form(dict(PASSPORT, signaturePngBase64=sig, extraPages=_pages(("passport", tall), ("other", jpg))),
                                         strict=True, manifest_sha256=MANIFEST)[0],
        "contract_text": lambda: contract(text_template(), VALUES, None, _b(sig), seal=SEAL, manifest_sha256=MANIFEST),
        "contract_text_unsigned": lambda: contract(text_template(), VALUES),
        "contract_picture": lambda: contract(picture_template(), VALUES, PLACED, _b(sig), seal=dict(SEAL, every_page=False), manifest_sha256=MANIFEST),
        "contract_client": lambda: contract(client_template(), VALUES, None, _b(sig), seal=SEAL, sign_mark="client_signature", manifest_sha256=MANIFEST),
        "sheet_id": lambda: sheet([{"kind": "id_front", "data": _b(jpg)}, {"kind": "id_back", "data": _b(jpg)}, {"kind": "sefach", "data": _b(tall)},
                                   {"kind": "other", "data": _b(png)}], False, MANIFEST)[0],
        "sheet_passport": lambda: sheet([{"kind": "passport", "data": _b(tall)}], True, MANIFEST)[0],
    }


def run(version=BUILDER_VERSION):
    """{case: the SHA-256 of its PDF}."""
    return {name: hashlib.sha256(build()).hexdigest() for name, build in cases(version).items()}


def run_all():
    """{builder version: its hashes}: every version a signed document may name."""
    return {version: run(version) for version in BUILDERS}


def answer():
    """`fill_form_101` {"ping", "selftest"}'s answer."""
    return {"ok": True, "warm": True, "builder": BUILDER_VERSION, "python": platform.python_version(), "pymupdf": pymupdf.VersionBind,
            "mupdf": pymupdf.VersionFitz, "builders": run_all()}
