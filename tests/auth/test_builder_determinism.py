"""The frozen builders (functions/builders/, docs/documents-plan.md → S1, docs/backend.md → The golden hashes): the same
inputs give the same bytes, in two processes and against builder_golden.json; strict mode; the ID sheet by kind; a stored
JPEG goes in with its own bytes; the manifest is canonical; the locked versions are the builder's."""

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

import pymupdf
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
FN = ROOT / "functions"
if str(FN) not in sys.path:
    sys.path.append(str(FN))

import builders  # noqa: E402
from builders import contract_b1, form101_b1, manifest, selftest, sheets_b1  # noqa: E402

sys.path.append(str(ROOT / "scripts"))
import builder_selfcheck  # noqa: E402

GOLDEN = json.loads((ROOT / "tests" / "auth" / "builder_golden.json").read_text(encoding="utf-8"))
FROZEN = ("form101_b1.py", "contract_b1.py", "sheets_b1.py")
ID_JPEG, TALL = base64.b64decode(selftest.ID_JPEG), base64.b64decode(selftest.TALL_JPEG)
PNG = base64.b64decode(selftest.SIGNATURE_PNG)
SHA = hashlib.sha256(b"a manifest").hexdigest()


def _in_a_new_process(seed):
    code = f"import json, sys; sys.path.insert(0, {str(FN)!r}); from builders import selftest; print(json.dumps(selftest.run()))"
    out = subprocess.run([sys.executable, "-c", code], env=dict(os.environ, PYTHONHASHSEED=seed), capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(out.stdout.strip().splitlines()[-1])


def _frozen_files():
    """The frozen sources' hashes, line ends as git keeps them: a second tripwire behind the output hashes."""
    return {n: hashlib.sha256((FN / "builders" / n).read_bytes().replace(b"\r\n", b"\n")).hexdigest() for n in FROZEN}


def _golden_now():
    return json.dumps({"builders": {builders.BUILDER_VERSION: selftest.run()}, "files": {builders.BUILDER_VERSION: _frozen_files()}}, indent=2, sort_keys=True)


def _doc(data):
    return pymupdf.open(stream=data, filetype="pdf")


def _text(data):
    return "".join(p.get_text() for p in _doc(data))


def _jpegs(data):
    d = _doc(data)
    return [d.extract_image(i[0])["image"] for p in d for i in p.get_images() if d.extract_image(i[0])["ext"] in ("jpeg", "jpg")]


# ---- the same bytes ----

def test_two_processes_give_the_same_bytes():
    assert _in_a_new_process("1") == _in_a_new_process("2") == selftest.run()


def test_the_output_hashes_are_the_golden_ones():
    """Golden hashes come from CI on Python 3.12 only (a PC's other Python and libraries give other bytes): this is the
    one check that runs only there. To make the file (a new builder version): run the Tests workflow, copy what this prints."""
    if not os.environ.get("CI"):
        pytest.skip("the golden hashes are compared on CI only")
    assert sys.version_info[:2] == (3, 12)
    now = json.loads(_golden_now())
    assert GOLDEN.get("builders", {}).get(builders.BUILDER_VERSION) == now["builders"][builders.BUILDER_VERSION], "builder_golden.json should be:\n" + _golden_now()


def test_the_frozen_sources_did_not_change():
    if not GOLDEN:  # only while the file is first made (see above): the golden test fails with the file's content then
        pytest.fail("builder_golden.json is empty:\n" + _golden_now())
    assert GOLDEN["files"][builders.BUILDER_VERSION] == _frozen_files()


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


# ---- photos as they are ----

def _big_jpeg(w, h):
    from PIL import Image
    out = io.BytesIO()
    Image.effect_noise((w, h), 40).convert("RGB").save(out, "JPEG", quality=70)
    return out.getvalue()


@pytest.mark.parametrize("extra", [[{"b64": selftest.ID_JPEG, "caption": "Document scan"}], _kinds(("id_front", ID_JPEG), ("sefach", TALL))])
def test_a_stored_jpeg_goes_in_with_its_own_bytes(extra):
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=extra))
    assert ID_JPEG in _jpegs(data)


def test_a_jpeg_over_the_stored_size_and_a_png_are_shrunk():
    big = _big_jpeg(2100, 1400)
    assert sheets_b1.plain_jpeg_size(big) is None
    assert sheets_b1.plain_jpeg_size(_big_jpeg(2000, 1400)) == (2000, 1400)
    data, _ = form101_b1.build_form101_pdf(dict(selftest.FORM, extraPages=[{"b64": base64.b64encode(big).decode(), "caption": "Document"}]))
    assert big not in _jpegs(data) and len(data) < len(big)
    assert sheets_b1.plain_jpeg_size(base64.b64decode(selftest.PAGE_PNG)) is None


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
    assert lock.count("==") == len(pins) and len(re.findall(r"^[a-z0-9].*==.*\\$", lock, re.M | re.I)) == len(pins)  # each pin carries --hash lines
    assert "--hash=sha256:" in lock
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
    golden = {"builders": {"b1": {"a": "1", "b": "2"}}}
    assert builder_selfcheck.differences({"builder": "b1", "hashes": {"a": "1", "b": "2"}}, golden) == []
    assert len(builder_selfcheck.differences({"builder": "b1", "hashes": {"a": "1", "b": "9"}}, golden)) == 1
    assert len(builder_selfcheck.differences({"builder": "b1", "hashes": {"a": "1"}}, golden)) == 1
    assert builder_selfcheck.differences({"builder": "b2", "hashes": {}}, golden)
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
    assert out["builder"] == "b1" and set(out["hashes"]) == set(selftest.cases())


def test_fill_form_101_keeps_its_answer_and_prints_this_year(functions_main, monkeypatch):
    p = dict(selftest.FORM, signDate="15/03/2019", extraPages=[{"b64": BROKEN, "caption": "Document"}])
    r = _call(functions_main, p, monkeypatch)
    out = json.loads(r.get_data())
    assert set(out) == {"pdfBase64", "fileName"} and r.headers["X-Dropped"] == "1"
    doc = _doc(base64.b64decode(out["pdfBase64"]))
    assert functions_main._this_year() in doc[0].get_text().replace(" ", "").replace("\n", "")


def test_a_ping_alone_stays_a_ping(functions_main, monkeypatch):
    assert json.loads(_call(functions_main, {"ping": True}, monkeypatch).get_data()) == {"ok": True, "warm": True}
