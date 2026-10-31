"""The frozen builders (functions/builders/, docs/documents-plan.md → S1, docs/backend.md → The golden hashes): the same
inputs give the same bytes, in two processes and against builder_golden.json; strict mode (a truncated picture, a date the
tax year cannot come from); the ID sheet by kind; every picture re-encoded; the manifest is canonical; the locked versions
are the builder's; the self-check runs once at a time and keeps a failure."""

import base64
import hashlib
import importlib.metadata
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import threading

import pymupdf
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FN = ROOT / "functions"
if str(FN) not in sys.path:
    sys.path.append(str(FN))

import builders  # noqa: E402
from builders import contract_b1, form101_b1, form101_b2, manifest, selftest, sheets_b1, sheets_b2  # noqa: E402
import idsheet  # noqa: E402

sys.path.append(str(ROOT / "scripts"))
import builder_selfcheck  # noqa: E402

GOLDEN = json.loads((ROOT / "tests" / "auth" / "builder_golden.json").read_text(encoding="utf-8"))
FROZEN = {"b1": ("form101_b1.py", "contract_b1.py", "sheets_b1.py"), "b2": ("form101_b2.py", "contract_b1.py", "sheets_b2.py")}
ID_JPEG, TALL = base64.b64decode(selftest.ID_JPEG), base64.b64decode(selftest.TALL_JPEG)
PNG = base64.b64decode(selftest.SIGNATURE_PNG)
SHA = hashlib.sha256(b"a manifest").hexdigest()


def _in_a_new_process(seed):
    code = f"import json, sys; sys.path.insert(0, {str(FN)!r}); from builders import selftest; print(json.dumps(selftest.run_all()))"
    out = subprocess.run([sys.executable, "-c", code], env=dict(os.environ, PYTHONHASHSEED=seed), capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(out.stdout.strip().splitlines()[-1])


def _frozen_files():
    """The frozen sources' hashes, line ends as git keeps them: a second tripwire behind the output hashes."""
    return {v: {n: hashlib.sha256((FN / "builders" / n).read_bytes().replace(b"\r\n", b"\n")).hexdigest() for n in names} for v, names in FROZEN.items()}


def _golden_now():
    return json.dumps({"builders": selftest.run_all(), "files": _frozen_files()}, indent=2, sort_keys=True)


def _doc(data):
    return pymupdf.open(stream=data, filetype="pdf")


def _text(data):
    return "".join(p.get_text() for p in _doc(data))


def _jpegs(data):
    d = _doc(data)
    return [d.extract_image(i[0])["image"] for p in d for i in p.get_images() if d.extract_image(i[0])["ext"] in ("jpeg", "jpg")]


# ---- the same bytes ----

def test_two_processes_give_the_same_bytes():
    assert _in_a_new_process("1") == _in_a_new_process("2") == selftest.run_all()


def test_the_output_hashes_are_the_golden_ones():
    """Golden hashes come from CI on Python 3.12 only (a PC's other Python and libraries give other bytes): this is the
    one check that runs only there. To make the file (a new builder version): run the Tests workflow, copy what this prints."""
    if not os.environ.get("CI"):
        pytest.skip("the golden hashes are compared on CI only")
    assert sys.version_info[:2] == (3, 12)
    now = json.loads(_golden_now())
    assert GOLDEN.get("builders") == now["builders"], "builder_golden.json should be:\n" + _golden_now()


def test_the_frozen_sources_did_not_change():
    if not GOLDEN:  # only while the file is first made (see above): the golden test fails with the file's content then
        pytest.fail("builder_golden.json is empty:\n" + _golden_now())
    assert GOLDEN["files"] == _frozen_files()


def test_the_file_id_comes_from_the_manifest():
    want = SHA[:32].upper()
    for data in (form101_b1.build_form101_pdf(selftest.FORM, manifest_sha256=SHA)[0],
                 contract_b1.fill(selftest.text_template(), selftest.VALUES, manifest_sha256=SHA),
                 sheets_b1.sheet_pdf([{"kind": "id_front", "data": ID_JPEG}], False, SHA)[0]):
        assert _doc(data).xref_get_key(-1, "ID")[1].upper() == f"[<{want}><{want}>]"


def test_other_inputs_give_another_file_id_without_a_manifest():
    a = form101_b1.build_form101_pdf(selftest.FORM)[0]
    b = form101_b1.build_form101_pdf(dict(selftest.FORM, city="עכו"))[0]
    assert _doc(a).xref_get_key(-1, "ID") != _doc(b).xref_get_key(-1, "ID")


def test_a_contract_s_font_subset_is_named_the_same_every_time():
    # doc.subset_fonts() (MuPDF's own subsetter) names a subset from the font's data, so no name needs fixing
    names = {f[3] for _ in range(2) for p in _doc(contract_b1.fill(selftest.text_template(), selftest.VALUES)) for f in p.get_fonts() if "Heebo" in f[3]}
    assert len(names) == 1 and "+" in names.pop()


def test_a_frozen_contract_draws_the_signature_seal_and_marks():
    data = contract_b1.fill(selftest.text_template(), selftest.VALUES, None, PNG, seal=selftest.SEAL, manifest_sha256=SHA)
    d = _doc(data)
    assert "{{" not in _text(data) and "15/03/2026" in _text(data)
    assert len(d[0].get_image_info()) == 5  # the signer, the marks' signature and stamp, and the every-page seal's two
    assert len(d[1].get_image_info()) == 2


def test_a_client_s_contract_is_signed_at_its_own_mark():
    data = contract_b1.fill(selftest.client_template(), selftest.VALUES, None, PNG, sign_mark="client_signature")
    assert "{{" not in _text(data) and _doc(data)[0].get_image_info()


def test_a_template_is_a_picture_and_its_marks_are_placed():
    data = contract_b1.fill(selftest.picture_template(), selftest.VALUES, selftest.PLACED, PNG, seal=dict(selftest.SEAL, every_page=False))
    assert len(_doc(data)[0].get_image_info()) == 3  # the page, the signature, the stamp


# ---- strict mode ----

BROKEN = base64.b64encode(b"not a picture").decode()


@pytest.mark.parametrize("extra", [{"signaturePngBase64": BROKEN},
                                   {"extraPages": [{"b64": BROKEN, "caption": "Document"}]},
                                   {"extraPages": [{"b64": selftest.ID_JPEG, "caption": "x"}, {"b64": BROKEN, "caption": "y"}]},
                                   {"extraPages": [{"b64": selftest.ID_JPEG, "kind": "id_front"}, {"b64": BROKEN, "kind": "sefach"}]},
                                   {"extraPages": [{"b64": selftest.ID_JPEG, "kind": "id_front"}, {"b64": BROKEN, "kind": "other"}]}])
def test_strict_mode_raises_and_the_lenient_build_counts(extra):
    p = dict(selftest.FORM, **extra)
    with pytest.raises(form101_b1.NotPlaced):
        form101_b1.build_form101_pdf(p, strict=True)
    report = {}
    data, _ = form101_b1.build_form101_pdf(p, report=report)
    assert report["dropped"] == 1 and _doc(data).page_count >= 2


def test_nothing_dropped_is_reported_as_none():
    report = {}
    form101_b1.build_form101_pdf(dict(selftest.FORM, signaturePngBase64=selftest.SIGNATURE_PNG), strict=True, report=report)
    assert report == {"dropped": 0}


def test_a_signature_that_is_an_error_is_a_value_error():
    assert issubclass(form101_b1.NotPlaced, ValueError)  # sign_documents answers it as a 400 with its text


# ---- the sheet by kind ----

def _kinds(*items):
    return [{"b64": base64.b64encode(data).decode(), "kind": kind, "caption": "Document"} for kind, data in items]


def test_one_sheet_holds_the_id_card_and_the_sefach():
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=_kinds(("id_front", ID_JPEG), ("id_back", ID_JPEG), ("sefach", TALL))))
    d = _doc(data)
    assert d.page_count == 3 and len(d[2].get_images(full=True)) >= 2
    assert "וספח" in _text(data) or "חפסו" in _text(data)  # the title, in logical or visual order


def test_a_missing_sefach_leaves_its_box_with_a_caption():
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=_kinds(("id_front", ID_JPEG))))
    assert _doc(data).page_count == 3
    words = _doc(data)[2].get_text()
    assert "חסר" in words or "רסח" in words
    assert not ("וספח" in words or "חפסו" in words)  # the title says only what is on the sheet


def test_a_passport_needs_no_sefach_box_and_other_pages_get_their_own():
    p = dict(selftest.PASSPORT, extraPages=_kinds(("passport", ID_JPEG), ("other", TALL), ("other", ID_JPEG)))
    data, _ = form101_b1.build_form101_pdf(p)
    d = _doc(data)
    assert d.page_count == 5
    words = d[2].get_text()
    assert not ("חסר" in words or "רסח" in words)


def test_without_a_kind_the_old_rule_by_position_stays():
    pages = [{"b64": selftest.ID_JPEG, "caption": "Document scan"}, {"b64": selftest.TALL_JPEG, "caption": "Document"}, {"b64": selftest.ID_JPEG, "caption": "Document"}]
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=pages))
    d = _doc(data)
    assert d.page_count == 4 and "Document scan" in d[2].get_text() and "Document" in d[3].get_text()


# ---- photos: decoded whole and re-encoded ----

def _big_jpeg(w, h):
    from PIL import Image
    out = io.BytesIO()
    Image.effect_noise((w, h), 40).convert("RGB").save(out, "JPEG", quality=70)
    return out.getvalue()


@pytest.mark.parametrize("pages", [lambda b: [{"b64": b, "caption": "Document"}], lambda b: [{"b64": b, "kind": "id_front"}]], ids=["by-position", "by-kind"])
def test_a_large_stored_jpeg_is_re_encoded_so_the_form_stays_small(pages):
    big = _big_jpeg(1600, 1000)
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=pages(base64.b64encode(big).decode())))
    assert big not in _jpegs(data) and len(data) < len(big)


@pytest.mark.parametrize("pages", [lambda b: [{"b64": b, "caption": "Document"}], lambda b: [{"b64": b, "kind": "id_front"}]], ids=["by-position", "by-kind"])
def test_a_truncated_jpeg_is_refused_by_strict_mode(pages):
    # the header is whole, so only decoding the whole picture finds it
    cut = _big_jpeg(600, 400)
    cut = cut[:len(cut) * 6 // 10]
    assert sheets_b1.picture_size(cut) == (600, 400)
    with pytest.raises(form101_b1.NotPlaced):
        form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=pages(base64.b64encode(cut).decode())), strict=True)


def test_a_jpeg_with_no_end_marker_is_refused_since_it_cannot_be_told_from_a_cut_one():
    # Pillow refuses both the same way, and an end marker added back makes even a 60 % file load with no error: nothing
    # here can prove the picture whole. It stops at send, where a rescan is all it costs; canvas and Pillow always write the marker.
    whole = _big_jpeg(600, 400)
    assert whole[-2:] == b"\xff\xd9"
    for cut in (whole[:-2], whole[:len(whole) * 99 // 100]):
        with pytest.raises(form101_b1.NotPlaced):
            form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=[{"b64": base64.b64encode(cut).decode(), "kind": "id_front"}]), strict=True)


def test_a_truncated_signature_is_refused_by_strict_mode():
    with pytest.raises(form101_b1.NotPlaced):
        form101_b1.build_form101_pdf(dict(selftest.FORM, signaturePngBase64=base64.b64encode(PNG[:len(PNG) // 2]).decode()), strict=True)


def test_a_truncated_page_on_its_own_sheet_is_counted_by_a_lenient_build():
    cut = _big_jpeg(600, 400)
    report = {}
    form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=[{"b64": base64.b64encode(cut[:len(cut) // 2]).decode(), "kind": "id_front"}]), report=report)
    assert report["dropped"] == 1


# ---- the tax year ----

@pytest.mark.parametrize("sign_date", ["", "soon", None])
def test_strict_mode_never_takes_the_tax_year_from_the_clock(sign_date):
    with pytest.raises(form101_b1.NoTaxYear):
        form101_b1.build_form101_pdf(dict(selftest.FORM, signDate=sign_date), strict=True)
    assert form101_b1.build_form101_pdf(dict(selftest.FORM, signDate=sign_date, taxYear="2026"), strict=True)[0]
    assert form101_b1.build_form101_pdf(dict(selftest.FORM, signDate=sign_date))[0]  # a preview has no signing date


# ---- the manifest ----

def test_the_manifest_is_canonical():
    a = {"b": [1, {"z": "ספח", "a": None}], "a": "x"}
    b = json.loads('{ "a" : "x",\n "b": [1, {"a": null, "z": "ספח"}] }')
    assert manifest.canonical(a) == manifest.canonical(b) == '{"a":"x","b":[1,{"a":null,"z":"ספח"}]}'.encode("utf-8")
    assert manifest.sha256(a) == manifest.sha256(b) == hashlib.sha256(manifest.canonical(a)).hexdigest()


def test_the_manifest_takes_only_plain_values():
    with pytest.raises(TypeError):
        manifest.canonical({"d": object()})
    with pytest.raises(ValueError):
        manifest.canonical({"n": float("nan")})


# ---- the template, the font, the libraries ----

def test_the_template_and_the_font_are_the_frozen_files():
    builders.check_assets()
    assert hashlib.sha256((FN / "assets" / "form101" / "v1.pdf").read_bytes()).hexdigest() == builders.FORM101_TEMPLATES["v1"]


def test_the_registry_names_the_current_builder():
    assert set(builders.BUILDERS[builders.BUILDER_VERSION]) == {"form101", "contract", "sheet"}
    assert set(selftest.run()) == set(selftest.cases())
    assert set(selftest.run_all()) == set(builders.BUILDERS)


def _locked():
    pins = re.findall(r"^([A-Za-z0-9._-]+)==([^ \\\n]+)", (FN / "requirements.lock").read_text(encoding="utf-8"), re.M)
    return {re.sub(r"[-_.]+", "-", n).lower(): v for n, v in pins}


def test_every_direct_requirement_is_locked_with_a_hash():
    lock = (FN / "requirements.lock").read_text(encoding="utf-8")
    pins = _locked()
    for line in (FN / "requirements.in").read_text(encoding="utf-8").splitlines():
        name = re.match(r"^[A-Za-z0-9._-]+", line)
        if name:
            assert re.sub(r"[-_.]+", "-", name.group()).lower() in pins, line
    assert len(re.findall(r"^[a-z0-9].*==.*\\$", lock, re.M | re.I)) == len(pins)  # each pin carries --hash lines
    assert "--hash=sha256:" in lock
    assert re.search(r"^colorama==.*sys_platform == 'win32'", lock, re.M)  # universal: it installs on the owner's PC too
    assert (FN / "requirements.txt").read_text(encoding="utf-8").splitlines()[-1] == "-r requirements.lock"


def test_the_locked_versions_are_the_builder_s():
    want, pins = builders.LOCKED[builders.BUILDER_VERSION], _locked()
    for name in ("pymupdf", "python-bidi", "pillow"):
        assert pins[name] == want[name], f"{name} moved: that is a new builder version (functions/builders/__init__.py)"


def test_the_installed_versions_are_the_locked_ones_on_ci():
    if not os.environ.get("CI"):
        pytest.skip("a PC's own environment is not the lock's")
    want = builders.LOCKED[builders.BUILDER_VERSION]
    assert (pymupdf.VersionBind, pymupdf.VersionFitz) == (want["pymupdf"], want["mupdf"])
    assert importlib.metadata.version("python-bidi") == want["python-bidi"]
    assert importlib.metadata.version("pillow") == want["pillow"]


# ---- the self-check's comparison ----

def test_the_self_check_compares_every_hash():
    golden = {"builders": {"b1": {"a": "1", "b": "2"}, "b2": {"a": "3"}}}
    both = lambda **b1: {"builder": "b2", "builders": {"b1": b1, "b2": {"a": "3"}}}
    assert builder_selfcheck.differences(both(a="1", b="2"), golden) == []
    assert len(builder_selfcheck.differences(both(a="1", b="9"), golden)) == 1  # an older version counts too
    assert len(builder_selfcheck.differences(both(a="1"), golden)) == 1
    assert builder_selfcheck.differences({"builder": "b3", "builders": {"b3": {}}}, golden)
    assert builder_selfcheck.differences({"builder": "b2", "builders": {"b1": {"a": "1", "b": "2"}}}, golden)  # none for its own version
    assert builder_selfcheck.differences({"ok": True, "warm": True}, golden)  # an older deploy's plain ping


# ---- the function ----

def _call(functions_main, body, monkeypatch):
    import flask
    monkeypatch.setattr(functions_main, "_gate_response", lambda req: None)
    with flask.Flask(__name__).test_request_context("/", method="POST", json=body):
        return functions_main.fill_form_101(flask.request)


def test_the_self_check_needs_no_login_and_answers_hashes(functions_main, monkeypatch):
    monkeypatch.setattr(functions_main, "_gate_response", lambda req: pytest.fail("the gate is not for the self-check"))
    import flask
    with flask.Flask(__name__).test_request_context("/", method="POST", json={"ping": True, "selftest": True}):
        out = json.loads(functions_main.fill_form_101(flask.request).get_data())
    assert out["builder"] == builders.BUILDER_VERSION and {v: set(h) for v, h in out["builders"].items()} == {v: set(selftest.cases(v)) for v in builders.BUILDERS}


def test_fill_form_101_keeps_its_answer_and_prints_this_year(functions_main, monkeypatch):
    p = dict(selftest.FORM, signDate="15/03/2019", extraPages=[{"b64": BROKEN, "caption": "Document"}])
    r = _call(functions_main, p, monkeypatch)
    out = json.loads(r.get_data())
    assert set(out) == {"pdfBase64", "fileName"} and r.headers["X-Dropped"] == "1"
    doc = _doc(base64.b64decode(out["pdfBase64"]))
    assert functions_main._this_year() in doc[0].get_text().replace(" ", "").replace("\n", "")


def test_the_self_check_is_built_once_at_a_time_and_a_failure_is_kept(functions_main, monkeypatch):
    calls = []

    def boom():
        calls.append(1)
        raise RuntimeError("the secret path /x")

    monkeypatch.setattr(functions_main, "_selftest_answer", None)
    monkeypatch.setattr(selftest, "answer", boom)
    got = []
    threads = [threading.Thread(target=lambda: got.append(functions_main._selftest())) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(calls) == 1 and got == [{"ok": False, "error": "RuntimeError"}] * 8  # no message: the caller has no login
    assert builder_selfcheck.differences(got[0], {"builders": {}})


def test_the_dropped_count_is_readable_by_the_app(functions_main, monkeypatch):
    r = _call(functions_main, dict(selftest.FORM), monkeypatch)
    assert r.headers["Access-Control-Expose-Headers"] == "X-Dropped"


def test_a_ping_alone_stays_a_ping(functions_main, monkeypatch):
    assert json.loads(_call(functions_main, {"ping": True}, monkeypatch).get_data()) == {"ok": True, "warm": True}


# ---- the attached sheet's language (builder b2) ----

SHEET = {"isId": True}


def _with_pages(lang=None, **over):
    p = dict(selftest.FORM, extraPages=_kinds(("id_front", ID_JPEG), ("sefach", TALL), ("other", ID_JPEG)), **over)
    return dict(p, sheetLang=lang) if lang else p


def _has_hebrew(text):
    return any("\u0590" <= c <= "\u05ff" for c in text)


def test_the_sheet_is_in_the_language_asked_for():
    en = _doc(form101_b2.build_form101_pdf(_with_pages("en"))[0])
    he = _doc(form101_b2.build_form101_pdf(_with_pages("he"))[0])
    assert en.page_count == he.page_count == 4
    assert "ID card and appendix" in en[2].get_text() and "Document" in en[3].get_text()
    assert not _has_hebrew(en[2].get_text()) and not _has_hebrew(en[3].get_text())
    assert _has_hebrew(he[2].get_text()) and "ID card" not in he[2].get_text()


def test_a_missing_appendix_and_a_passport_in_english():
    no = _doc(form101_b2.build_form101_pdf(dict(selftest.FORM, sheetLang="en", extraPages=_kinds(("id_front", ID_JPEG))))[0])[2].get_text()
    assert "Appendix — missing, not scanned" in no and "ID card and appendix" not in no
    pp = _doc(form101_b2.build_form101_pdf(dict(selftest.PASSPORT, sheetLang="en", extraPages=_kinds(("passport", ID_JPEG))))[0])[2].get_text()
    assert "Passport" in pp and not _has_hebrew(pp)


@pytest.mark.parametrize("lang", ["ru", "fr", "", None])
def test_any_other_language_reads_english(lang):
    assert sheets_b2.lang_of(lang) == "en" and idsheet.lang_of(lang) == "en"
    assert "ID card" in _doc(sheets_b2.sheet_pdf([{"kind": "id_front", "data": ID_JPEG}], False, SHA, lang)[0])[0].get_text()


def test_an_app_language_is_kept_and_none_sent_stays_on_b1():
    assert builders.sheet_lang("he") == "he" and builders.sheet_lang("en") == "en" and builders.sheet_lang("ru") == "en"
    assert builders.sheet_lang(None) is None and builders.sheet_lang("") is None and builders.sheet_lang(5) is None


def test_the_two_form_pages_are_the_same_in_every_language_and_in_b1():
    def looks(data):
        d = _doc(data)
        return [d[i].get_pixmap(dpi=100, alpha=False).samples for i in (0, 1)]

    base = looks(form101_b1.build_form101_pdf(_with_pages())[0])
    assert looks(form101_b2.build_form101_pdf(_with_pages("en"))[0]) == base == looks(form101_b2.build_form101_pdf(_with_pages("he"))[0])
    assert _has_hebrew(_doc(form101_b2.build_form101_pdf(_with_pages("en"))[0])[0].get_text())


def test_hebrew_in_b2_is_b1_to_the_byte_and_the_contract_stays_b1_s_file():
    b1, b2 = selftest.run("b1"), selftest.run("b2")
    assert all(b2[k + "_he"] == b1[k] for k in ("form101_by_kind", "form101_no_sefach", "form101_passport", "sheet_id", "sheet_passport"))
    assert b2["form101_by_kind"] != b1["form101_by_kind"]  # English is what is new
    assert builders.BUILDERS["b2"]["contract"] is contract_b1.fill
    assert all(b2[k] == b1[k] for k in b1 if k.startswith("contract"))


def test_a_payload_names_its_builder_and_the_name_changes_no_byte():
    p = _with_pages()
    assert builders.build_form101(dict(p, builder="b1"))[0] == form101_b1.build_form101_pdf(p)[0]
    assert builders.build_form101(dict(p, sheetLang="en", builder="b2"))[0] == form101_b2.build_form101_pdf(dict(p, sheetLang="en"))[0]
    assert builders.build_form101(dict(p, sheetLang="en"))[0] == form101_b2.build_form101_pdf(dict(p, sheetLang="en"))[0]  # none named: the current one


def test_the_sheet_s_words_are_the_dictionary_s():
    he = json.loads((ROOT / "i18n" / "he.json").read_text(encoding="utf-8"))
    assert sheets_b2.CAPTIONS == idsheet.CAPTIONS
    for key, english in sheets_b2.CAPTIONS["en"].items():
        assert he[english] == sheets_b2.CAPTIONS["he"][key], english


def test_russian_lives_only_in_its_dictionary():
    for path in (FN / "idsheet.py", FN / "builders" / "sheets_b2.py"):
        assert not any("\u0400" <= c <= "\u04ff" for c in path.read_text(encoding="utf-8"))


def test_a_caller_cannot_pick_the_builder_of_the_stored_form(functions_main, monkeypatch):
    r = _call(functions_main, dict(selftest.FORM, builder="b9", sheetLang="he"), monkeypatch)
    assert r.status_code == 200 and set(json.loads(r.get_data())) == {"pdfBase64", "fileName"}
