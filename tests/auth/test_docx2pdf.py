"""The docx2pdf service (services/docx2pdf, docs/contracts.md → Word templates): a Word file with marks
becomes a PDF whose marks the contract templates find (Hebrew right to left), each conversion with
its own LibreOffice profile; only a firm's admin or the super-admin may call it."""

import io
import os
import sys
import zipfile

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "services", "docx2pdf"))
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import convert  # noqa: E402
import contracts  # noqa: E402

DOC = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">אני {{full_name}} ת.ז. {{id}} מסכים לתנאים</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Signature: {{signature}}   Date: {{sign_date}}</w:t></w:r></w:p>
</w:body></w:document>"""


def docx():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", DOC)
    return out.getvalue()


def test_a_word_file_becomes_a_pdf_with_its_marks():
    pdf = convert.convert(docx())
    found, unknown = contracts.find_marks(pymupdf.open(stream=pdf))
    assert sorted(f["mark"] for f in found) == ["full_name", "id", "sign_date", "signature"] and not unknown
    assert any(f["rtl"] for f in found if f["mark"] == "full_name")
    filled = contracts.fill(pdf, {"full_name": "ישראל ישראלי", "id": "123456782", "sign_date": "01/01/2026"})
    assert "123456782" in pymupdf.open(stream=filled)[0].get_text()


def test_not_a_word_file_refused():
    for bad in (b"%PDF-1.4", b"PK\x03\x04garbage", b""):
        try:
            convert.convert(bad)
            assert False
        except convert.ConvertError as e:
            assert "Word" in str(e)


def test_each_conversion_its_own_profile():
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        open(os.path.join(cmd[cmd.index("--outdir") + 1], "in.pdf"), "wb").write(b"%PDF-1.4 x")
    convert.convert(docx(), run=run)
    convert.convert(docx(), run=run)
    profiles = [c[1] for c in calls]
    assert all(p.startswith("-env:UserInstallation=file://") for p in profiles) and profiles[0] != profiles[1]


def test_check_rules():
    import importlib.util
    spec = importlib.util.spec_from_file_location("docx2pdf_main", os.path.join(os.path.dirname(__file__), "..", "..", "services", "docx2pdf", "main.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    ok = lambda role: (lambda t: {"role": role, "tenantId": "t1"})
    assert m.check({"Authorization": "Bearer x"}, ok("tenant_admin")) == (None, {"role": "tenant_admin", "tenantId": "t1"})
    assert m.check({"Authorization": "Bearer x"}, ok("staff"))[0] == 403
    assert m.check({}, ok("tenant_admin"))[0] == 401
    assert m.check({"Authorization": "Bearer x"}, lambda t: (_ for _ in ()).throw(ValueError()))[0] == 401


def test_prepare_takes_a_word_file_through_the_service():
    from test_contracts import Bucket, Db, OWNER, _b64
    import base64 as b64
    db, bucket = Db(), Bucket()
    r = contracts.run(db, bucket, OWNER, {"action": "prepare", "docxBase64": _b64(docx()), "name": "Word"}, docx=convert.convert)
    assert r["ok"] and "full_name" in r["marks"] and b64.b64decode(r["lightBase64"])[:4] == b"%PDF"
    # without the service (its address not written yet): refused with the way out, and an Admin → Errors entry
    r = contracts.run(db, bucket, OWNER, {"action": "prepare", "docxBase64": _b64(docx()), "name": "Word"})
    assert r == {"error": contracts.E_NO_DOCX} and any("Word" in d.get("message", "") for p, d in db.data.items() if p[0] == "errors")
