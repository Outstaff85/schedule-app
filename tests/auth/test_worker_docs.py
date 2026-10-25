"""The worker's documents built on request (functions/workerdocs.py, the `worker_docs` function; docs/workers.md →
Download data; docs/documents-plan.md → S2): who may ask (the rights matrix), every subset of the picker in its order,
one A4 ID sheet with the photos once, a legacy signed Form 101 served whole, no pay without the right, a preview with
its mark and never a signing's signature, no file outside the worker's folder, the size cap — and the old device's
`signing.bundle`, put together by the same code. On the in-memory stand-ins for Firestore and Storage."""

import base64
import io
import itertools
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # after functions-auth: its main stays `main`
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import gate  # noqa: E402
import idsheet  # noqa: E402
import signing  # noqa: E402
import workerdocs  # noqa: E402
from test_contracts import Bucket, Db  # noqa: E402

OWNER = {"uid": "u1", "role": "tenant_admin", "tenantId": "t1"}
SUPER = {"uid": "su", "role": "superadmin", "tenantId": None}
STAFF_RO = {"uid": "u4", "role": "staff", "tenantId": "t1", "rt": ["workers"]}
STAFF_NONE = {"uid": "u5", "role": "staff", "tenantId": "t1", "rt": ["today"]}
STAFF_PAY = {"uid": "u6", "role": "staff", "tenantId": "t1", "rt": ["workers", "accounting"]}
HR_OWN = {"uid": "u-hr", "role": "hr", "tenantId": "t1", "own": True, "rt": ["workers"]}
HR_ALL = {"uid": "u-hr2", "role": "hr", "tenantId": "t1", "own": False, "rt": ["workers"]}
OTHER_FIRM = {"uid": "u9", "role": "tenant_admin", "tenantId": "t2"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
F101 = {"given": "Avi", "surname": "Cohen", "employer": {"companyName": "Firm One"}, "signDate": "01/01/2020",
        "signaturePngBase64": "should-not-pass", "extraPages": [{"b64": "x"}]}
P = "tenants/t1/workers/w1/"


def build101(p):
    """A stand-in for Form 101's build: two pages; the first says what it was given."""
    doc = pymupdf.open()
    doc.new_page().insert_text((50, 80), "F101 " + str(p.get("given")) + " date=" + str(p.get("signDate"))
                               + (" SIGNED" if p.get("signaturePngBase64") else "") + " extra=" + str(len(p.get("extraPages") or [])), fontsize=12)
    doc.new_page().insert_text((50, 80), "F101 page 2", fontsize=12)
    return doc.tobytes(), "f101.pdf"


def jpeg(w, h, colour="white"):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(out, "JPEG")
    return out.getvalue()


def one_page(text):
    d = pymupdf.open()
    d.new_page().insert_text((50, 50), text)
    return d.tobytes()


CARD, SEFACH, PASSPORT, OTHER = jpeg(856, 540), jpeg(600, 900, "gray"), jpeg(1250, 880, "blue"), jpeg(800, 1100, "green")


def setup(**over):
    db, bucket = Db(), Bucket()
    t = db.collection("tenants").document("t1")
    t.collection("clients").document("c1").set({"name": "Site A"})
    w = {"name": "Avi Cohen", "hrId": "u-hr", "docGiven": "אבי", "docSurname": "כהן", "docId": "123456782", "clientIds": ["c1"],
         "hourlyRate": 55, "phone": "0501234567",
         "scanPages": [{"fileId": P + "pages/1-2-sefach.jpg", "kind": "sefach"},
                       {"fileId": P + "pages/1-0-id_front.jpg", "kind": "id_front", "primary": True},
                       {"fileId": P + "pages/1-1-id_back.jpg", "kind": "id_back"},
                       {"fileId": P + "pages/1-3-other.jpg", "kind": "other"}],
         "docs": [{"id": "d1", "type": "visa", "fileId": P + "docs/1-visa.pdf"},
                  {"id": "d2", "type": "contract", "fileId": P + "docs/2-c.pdf"}]}
    w.update(over)
    t.collection("workers").document("w1").set(w)
    t.collection("workers").document("w2").set({"name": "Dana", "hrId": "other"})
    bucket.store.update({P + "pages/1-0-id_front.jpg": CARD, P + "pages/1-1-id_back.jpg": jpeg(856, 540, "yellow"),
                         P + "pages/1-2-sefach.jpg": SEFACH, P + "pages/1-3-other.jpg": OTHER,
                         P + "docs/1-visa.pdf": one_page("VISA"), P + "docs/2-c.pdf": one_page("CONTRACT"),
                         "tenants/t1/workers/w2/docs/x.pdf": one_page("OTHER WORKER"), "tenants/t2/workers/w1/docs/x.pdf": one_page("OTHER FIRM")})
    return db, bucket


def call(db, bucket, claims, include=None, action="bundle", **body):
    b = {"action": action, "workerId": "w1", "form101": F101}
    if include is not None:
        b["include"] = include
    b.update(body)
    return workerdocs.run(db, bucket, claims, b, build101)


def text(out):
    d = pymupdf.open(stream=out["pdf"], filetype="pdf")
    return [pg.get_text() for pg in d], d


ALL = {"form101": True, "contract": True, "scans": True, "docs": True}


def test_who_may_ask():
    db, bucket = setup()
    assert call(db, bucket, OWNER, ALL)["pages"]
    assert call(db, bucket, dict(SUPER), ALL, asTenantId="t1")["pages"]
    assert call(db, bucket, SUPER, ALL)["status"] == 400  # a super-admin only in the firm it views
    assert call(db, bucket, STAFF_RO, ALL)["pages"]
    assert call(db, bucket, STAFF_NONE, ALL) == {"error": workerdocs.E_NO_RIGHT, "status": 403}
    assert call(db, bucket, HR_OWN, ALL)["pages"]
    assert call(db, bucket, HR_OWN, ALL, workerId="w2") == {"error": workerdocs.E_NO_WORKER, "status": 404}
    assert call(db, bucket, HR_ALL, ALL, workerId="w2")["pages"]
    assert call(db, bucket, OTHER_FIRM, ALL)["status"] == 404  # another firm never finds this firm's worker
    for role in ("supplier", "client", "worker"):
        assert call(db, bucket, {"uid": "x", "role": role, "tenantId": "t1", "rt": ["workers"]}, ALL)["status"] == 403
    # the gate in front of the function: a supplier, a client, a punch link's token (no ID token) never get in
    assert gate.claims_of({"Authorization": "Bearer t"}, lambda _t: {"role": "supplier"})[0] == 403
    assert gate.claims_of({"Authorization": "Bearer t"}, lambda _t: {"role": "client"})[0] == 403
    assert gate.claims_of({}, lambda _t: {"role": "tenant_admin"})[0] == 401
    assert call(db, bucket, OWNER, ALL, action="nope")["status"] == 400


def test_every_subset_in_order_with_its_pages():
    db, bucket = setup()
    pages_of = {"form101": 2, "contract": 1, "scans": 2, "docs": 1}  # Form 101's two; the ID sheet and the other page
    keys_of = {"form101": ["form101-preview"], "contract": ["contract"], "scans": ["id-sheet,scan"], "docs": ["doc"]}
    for n in range(5):
        for picked in itertools.combinations(workerdocs.INCLUDE, n):
            out = call(db, bucket, OWNER, {k: True for k in picked})
            want = 1 + sum(pages_of[k] for k in picked)
            if "form101" in picked and "scans" not in picked:
                want += 2  # the preview keeps its own pages when the scans are not picked
            assert out["pages"] == want, (picked, out["pages"])
            assert out["parts"] == ["summary"] + [x for k in workerdocs.INCLUDE if k in picked for x in keys_of[k]], picked
            assert out["dropped"] == 0 and out["withheld"] == []
            texts, _ = text(out)
            assert "Avi Cohen" in texts[0] and "55" not in texts[0]  # the summary first, never pay
    texts, _ = text(call(db, bucket, OWNER, ALL))
    assert "F101 Avi" in texts[1] and "CONTRACT" in texts[3] and "VISA" in texts[6]


def _placements(doc):
    """[(page number, image bbox)] of every picture in the document."""
    out = []
    for pg in doc:
        for img in pg.get_images(full=True):
            for r in pg.get_image_rects(img[0]):
                out.append((pg.number, r))
    return out


def test_one_id_sheet_and_the_photos_once():
    db, bucket = setup()
    out = call(db, bucket, OWNER, {"form101": True, "scans": True})
    _, doc = text(out)
    places = _placements(doc)
    assert len(places) == 4  # front, back, ספח, the other page — each once
    sheet = [r for n, r in places if n == 3]
    assert len(sheet) == 3  # one A4: the front, the back and the ספח
    for a, b in itertools.combinations(sheet, 2):
        assert (a & b).is_empty or (a & b).get_area() < 1  # none over another
    assert all(r in doc[3].rect for r in sheet)
    assert doc[3].rect.width == 595 and doc[3].rect.height == 842
    # the photos are not inside the preview when the scans are picked too
    assert "extra=0" in doc[1].get_text()
    # with only Form 101, the preview carries them (once)
    _, doc2 = text(call(db, bucket, OWNER, {"form101": True}))
    assert len(_placements(doc2)) == 4 and doc2.page_count == 5


def test_a_missing_sefach_leaves_its_box_empty_and_a_passport_takes_the_sheet():
    db, bucket = setup(scanPages=[{"fileId": P + "pages/1-0-id_front.jpg", "kind": "id_front", "primary": True}])
    _, doc = text(call(db, bucket, OWNER, {"scans": True}))
    assert doc.page_count == 2 and len(_placements(doc)) == 1
    t = doc[1].get_text()
    assert "חסר" in t or "רסח" in t  # the Hebrew caption says the ספח is missing
    assert len(doc[1].get_drawings()) >= 2  # the picture's frame and the empty box
    db, bucket = setup(docType="passport", scanPages=[{"fileId": P + "pages/p.jpg", "kind": "passport", "primary": True},
                                                      {"fileId": P + "pages/1-3-other.jpg", "kind": "other"}])
    bucket.store[P + "pages/p.jpg"] = PASSPORT
    out = call(db, bucket, OWNER, {"scans": True})
    _, doc = text(out)
    assert out["parts"] == ["summary", "id-sheet,scan"] and doc.page_count == 3
    t = doc[1].get_text()
    assert not ("חסר" in t or "רסח" in t)  # a passport worker has no ספח box


def test_the_layout_follows_the_pictures_shapes():
    W, H = 539, 756
    # the card's two sides one above the other, a tall ספח beside them
    side = idsheet.layout([1.58, 1.58, 0.66], [True, True, True], W, H)
    assert side[0][1] == side[1][1] and side[1][2] > side[0][2] and side[2][1] >= side[0][1] + side[0][3]
    # a wide ספח: all three down the page, each wider than half the sheet
    wide = idsheet.layout([1.58, 1.58, 1.4], [True, True, True], W, H)
    assert all(b[3] > W / 2 for b in wide) and wide[0][2] < wide[1][2] < wide[2][2]
    tall = idsheet.layout([0.7, 0.66], [True, True], W, H)
    assert abs(tall[0][2] - tall[1][2]) < 1  # two tall pages side by side, not stacked
    # an empty box does not decide: the real pictures as large as without it
    alone = idsheet.layout([1.58], [True], W, H)[0]
    assert alone[3] == W
    for boxes in (side, wide, tall):
        for _i, x, y, w, h in boxes:
            assert x >= -0.01 and y >= 0 and x + w <= W + 0.01 and y + h <= H + 0.01


def test_a_legacy_signed_worker_gets_the_stored_form101_whole():
    stored = pymupdf.open()
    for i in range(3):
        stored.new_page().insert_text((50, 50), f"STORED101 page {i}")
    db, bucket = setup(signedAt="2026-09-01T10:00:00Z", signDate="01/09/2026", docFileId=P + "form101/1-signed.pdf")
    bucket.store[P + "form101/1-signed.pdf"] = stored.tobytes()
    out = call(db, bucket, OWNER, {"form101": True, "scans": True})
    texts, doc = text(out)
    assert out["parts"] == ["summary", "form101-signed"] and doc.page_count == 4  # whole; its photos are already inside
    assert all(f"STORED101 page {i}" in texts[i + 1] for i in range(3)) and not _placements(doc)
    assert "01/09/2026" in texts[0]
    out = call(db, bucket, OWNER, {"scans": True})  # only the scans: the ID sheet
    assert out["parts"] == ["summary", "id-sheet,scan"]
    # signed, but its copy is not found: never a preview in its place
    db, bucket = setup(signedAt="2026-09-01T10:00:00Z")
    out = call(db, bucket, OWNER, {"form101": True})
    assert out["parts"] == ["summary"] and out["dropped"] == 1


def test_no_pay_without_the_right():
    # an uploaded contract, no sign request behind it: it may hold pay
    db, bucket = setup()
    for claims, shown in ((STAFF_RO, False), (HR_OWN, False), (STAFF_PAY, True), (OWNER, True)):
        out = call(db, bucket, claims, {"contract": True, "docs": True})
        assert ("contract" in out["parts"]) is shown and (out["withheld"] == ([] if shown else ["contract"])), claims
        assert any("CONTRACT" in t for t in text(out)[0]) is shown
    # a signed contract whose request printed pay / did not
    db, bucket = setup(docs=[{"id": "d2", "type": "contract", "signed": True, "fileId": P + "docs/2-c.pdf"}])
    req = db.collection("tenants").document("t1").collection("signRequests").document("r1")
    req.set({"workerId": "w1", "status": "signed", "printPay": True, "parts": {"contract": {"path": P + "docs/2-c.pdf"}}})
    assert call(db, bucket, STAFF_RO, {"contract": True})["withheld"] == ["contract"]
    req.update({"printPay": False})
    out = call(db, bucket, STAFF_RO, {"contract": True})
    assert out["parts"] == ["summary", "contract"] and out["withheld"] == []


def test_a_preview_has_its_mark_and_never_a_signings_signature():
    # a signature captured from a scan, a worker with no signed set: the preview may carry it
    db, bucket = setup(sigFileId=P + "signature/1-signature.png")
    bucket.store[P + "signature/1-signature.png"] = PNG
    out = call(db, bucket, OWNER, action="form101")
    texts, doc = text(out)
    assert out["parts"] == ["form101-preview"] and "SIGNED" in texts[0] and "date=None" in texts[0]  # no signing date
    assert all(("לא נחתם" in t or "םתחנ אל" in t) for t in texts[:2])  # every form page carries the mark
    assert doc.page_count == 4  # the two form pages, the ID sheet, the other page
    # the same signature kept by a sign request: never
    db.collection("tenants").document("t1").collection("signRequests").document("r1").set(
        {"workerId": "w1", "status": "signing", "sigPath": P + "signature/1-signature.png"})
    assert "SIGNED" not in text(call(db, bucket, OWNER, action="form101"))[0][0]
    # a signed worker's signature: never, even in a preview
    db, bucket = setup(sigFileId=P + "signature/1-signature.png", signedAt="2026-09-01T10:00:00Z")
    bucket.store[P + "signature/1-signature.png"] = PNG
    assert "SIGNED" not in text(call(db, bucket, OWNER, action="form101"))[0][0]
    # no values sent: refused, not a guess
    db, bucket = setup()
    assert call(db, bucket, OWNER, action="form101", form101=None)["status"] == 400
    assert call(db, bucket, OWNER, {"form101": True}, form101=None)["status"] == 400


def test_a_path_outside_the_worker_is_not_read():
    db, bucket = setup(docs=[{"id": "a", "type": "visa", "fileId": "tenants/t1/workers/w2/docs/x.pdf"},
                             {"id": "b", "type": "other", "fileId": "tenants/t2/workers/w1/docs/x.pdf"},
                             {"id": "c", "type": "other", "fileId": P + "../w2/docs/x.pdf"},
                             {"id": "d", "type": "visa", "fileId": P + "docs/1-visa.pdf"}],
                       scanPages=[{"fileId": "tenants/t1/workers/w2/pages/x.jpg", "kind": "id_front", "primary": True}])
    bucket.store["tenants/t1/workers/w2/pages/x.jpg"] = CARD
    out = call(db, bucket, OWNER, {"docs": True, "scans": True})
    texts, doc = text(out)
    assert not any("OTHER WORKER" in t or "OTHER FIRM" in t for t in texts) and not _placements(doc)
    assert out["parts"] == ["summary", "doc"] and out["dropped"] == 4


def test_the_size_cap(monkeypatch):
    db, bucket = setup()
    monkeypatch.setattr(workerdocs, "MAX_BYTES", 2000)
    out = call(db, bucket, OWNER, ALL)
    assert out == {"error": workerdocs.E_TOO_BIG, "status": 413}


def test_the_answer_headers():
    db, bucket = setup()
    out = call(db, bucket, OWNER, ALL)
    h = workerdocs.headers(out)
    assert h["Content-Type"] == "application/pdf" and h["X-Pages"] == str(out["pages"]) and h["X-Parts"].startswith("summary,")
    assert all(x in h["Access-Control-Expose-Headers"] for x in ("X-Pages", "X-Parts", "X-Dropped"))
    h["X-Name"].encode("latin-1")  # a header stays ASCII, a Hebrew name included


def test_the_old_devices_bundle_is_the_same_code_in_the_plan_order():
    """signing.bundle (a device that has not reloaded): everything, Form 101 the stored file, as base64 JSON."""
    db, bucket = setup(docFileId=P + "form101/1-f.pdf", signDate="01/09/2026",
                       docs=[{"type": "visa", "fileId": P + "docs/1-visa.pdf"},
                             {"type": "contract", "signed": True, "fileId": P + "docs/2-c.pdf"}])
    bucket.store[P + "form101/1-f.pdf"] = one_page("FORM101")
    r = signing.run(db, bucket, OWNER, {"action": "bundle", "workerId": "w1"}, build101)
    assert r["parts"] == ["טופס 101", "חוזה (חתום)", "ויזה"] and r["pages"] == 4  # the stored Form 101 holds the photos
    doc = pymupdf.open(stream=base64.b64decode(r["pdfBase64"]))
    first = doc[0].get_text()
    assert "123456782" in first and "Site A" in first and "01/09/2026" in first and "55" not in first  # never pay
    assert "FORM101" in doc[1].get_text() and "CONTRACT" in doc[2].get_text() and "VISA" in doc[3].get_text()
    # a contract with no request behind it, for a login without pay: left out
    r = signing.run(db, bucket, STAFF_RO, {"action": "bundle", "workerId": "w1"}, build101)
    assert "חוזה (חתום)" not in r["parts"]
    # an own-workers HR only its own; a login without the Workers tab nothing
    assert signing.run(db, bucket, dict(HR_OWN, rt=["workers"]), {"action": "bundle", "workerId": "w2"}, build101) == {"error": signing.E_NO_WORKER}
    assert signing.run(db, bucket, STAFF_NONE, {"action": "bundle", "workerId": "w1"}, build101) == {"error": signing.E_NO_RIGHT}


def test_the_functions_settings(functions_main):
    ep = functions_main.worker_docs.__firebase_endpoint__
    assert ep.concurrency == 4 and ep.availableMemoryMb == 1024 and ep.timeoutSeconds == 120 and ep.cpu == 1
    assert ep.region == ["europe-west3"]
