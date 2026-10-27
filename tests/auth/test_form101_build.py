"""Form 101's build (functions/main.py `build_form101_pdf`, docs/form101.md → Building the PDF):
an Israeli ID typed without its leading 0 fills the 9-box comb padded to 9 digits, and a house
number with a letter ("12א") is printed whole in its own box, the street in the street box — sent
apart as `street` / `houseNumber`; an older caller's one `address`, or a street that still holds
the number (no `houseNumber`), is still split."""

import pymupdf

# functions/main.py comes from the `functions_main` fixture (conftest.py): loaded once per run


def _fields(pdf_bytes):
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    return {w.field_name: w.field_value for page in doc for w in page.widgets()}


def _build(fmain, **extra):
    p = {"isId": True, "isIsraeli": True, "surname": "כהן", "given": "דנה", "no": "12345678",
         "dob": "01/02/1990", "sex": "F", "city": "חיפה", "signDate": "01/10/2026"}
    p.update(extra)
    out = fmain.build_form101_pdf(p, flatten=False)   # the fields kept, to read their values
    assert len(out) == 2
    return out


def test_an_eight_digit_israeli_id_is_padded_to_nine(functions_main):
    pdf, name = _build(functions_main, street="הרצל", houseNumber="12א")
    f = _fields(pdf)
    assert f["employer_zeut_num"] == "012345678"
    assert "012345678" in name


def test_a_house_number_with_a_letter_stays_whole(functions_main):
    f = _fields(_build(functions_main, address="הרצל 12א", street="הרצל", houseNumber="12א")[0])
    assert f["addr_number"] == "12א"
    assert f["addr_street"] == "הרצל"


def test_an_older_caller_s_address_is_still_split(functions_main):
    f = _fields(_build(functions_main, address="הרצל 12")[0])
    assert f["addr_number"] == "12"
    assert f["addr_street"] == "הרצל"


def test_an_older_record_s_number_inside_the_street_is_split(functions_main):
    f = _fields(_build(functions_main, address="הרצל 12", street="הרצל 12", houseNumber="")[0])
    assert f["addr_number"] == "12"
    assert f["addr_street"] == "הרצל"


def test_a_passport_number_is_not_padded(functions_main):
    f = _fields(_build(functions_main, isId=False, isIsraeli=False, no="AB1234567")[0])
    assert f["passport_no"] == "AB1234567"
    assert not f.get("employer_zeut_num")


def test_the_built_pdf_is_flat_no_fillable_fields_and_the_values_on_the_page(functions_main):
    # owner, 2026-10-27: a downloaded Form 101 showed the form's blue field boxes — the PDF is flattened
    p = {"isId": True, "isIsraeli": True, "surname": "כהן", "given": "דנה", "no": "12345678",
         "dob": "01/02/1990", "sex": "F", "city": "חיפה", "signDate": "01/10/2026"}
    pdf, _ = functions_main.build_form101_pdf(p)
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    assert sum(1 for page in doc for _ in page.widgets()) == 0
    assert not doc.is_form_pdf
    text = "".join(page.get_text() for page in doc).replace(" ", "").replace(chr(10), "")
    assert "012345678" in text
