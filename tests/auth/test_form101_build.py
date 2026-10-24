"""Form 101's build (functions/main.py `build_form101_pdf`, docs/form101.md → Building the PDF):
an Israeli ID typed without its leading 0 fills the 9-box comb padded to 9 digits, and a house
number with a letter ("12א") is printed whole in its own box, the street in the street box — sent
apart as `street` / `houseNumber`; an older caller's one `address` is still split."""

import importlib.util
import os
import sys

import pymupdf

_FUNCTIONS = os.path.join(os.path.dirname(__file__), "..", "..", "functions")
sys.path.append(_FUNCTIONS)  # after functions-auth: its main stays `main`
_spec = importlib.util.spec_from_file_location("form101_main", os.path.join(_FUNCTIONS, "main.py"))
fmain = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fmain)


def _fields(pdf_bytes):
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    return {w.field_name: w.field_value for page in doc for w in page.widgets()}


def _build(**extra):
    p = {"isId": True, "isIsraeli": True, "surname": "כהן", "given": "דנה", "no": "12345678",
         "dob": "01/02/1990", "sex": "F", "city": "חיפה", "signDate": "01/10/2026"}
    p.update(extra)
    out = fmain.build_form101_pdf(p)
    assert len(out) == 2
    return out


def test_an_eight_digit_israeli_id_is_padded_to_nine():
    pdf, name = _build(street="הרצל", houseNumber="12א")
    f = _fields(pdf)
    assert f["employer_zeut_num"] == "012345678"
    assert "012345678" in name


def test_a_house_number_with_a_letter_stays_whole():
    f = _fields(_build(address="הרצל 12א", street="הרצל", houseNumber="12א")[0])
    assert f["addr_number"] == "12א"
    assert f["addr_street"] == "הרצל"


def test_an_older_caller_s_address_is_still_split():
    f = _fields(_build(address="הרצל 12")[0])
    assert f["addr_number"] == "12"
    assert f["addr_street"] == "הרצל"


def test_a_passport_number_is_not_padded():
    f = _fields(_build(isId=False, isIsraeli=False, no="AB1234567")[0])
    assert f["passport_no"] == "AB1234567"
    assert not f.get("employer_zeut_num")
