"""A worker moves to another firm, with the worker's signed consent (functions/transfer.py, docs/contracts.md →
Moving to another firm): the new firm learns nothing until the worker approves; the copy carries only
the personal and family fields, the scanned pages, the signature and the newly signed documents; the old
firm keeps the worker, set Inactive; a declined or expired request copies nothing."""

import base64
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import contracts  # noqa: E402
import signing  # noqa: E402
import transfer  # noqa: E402
from test_contracts import Bucket, Db, _pdf, _b64  # noqa: E402
from test_signing import PNG, build101  # noqa: E402

ADMIN2 = {"uid": "u-a2", "role": "tenant_admin", "tenantId": "t2"}


class Hit:
    def __init__(self, tenant, wid, data):
        self.id, self._d = wid, data
        self.reference = type("R", (), {"parent": type("P", (), {"parent": type("T", (), {"id": tenant})()})()})()

    def to_dict(self):
        return dict(self._d)


class GDb(Db):
    """Db with the collection-group query on workers.docKeys that ask() runs."""
    def collection_group(self, name):
        db = self

        class Q:
            def where(self, filter=None):
                # array_contains (one key) or array_contains_any (a list of keys), as Firestore runs them
                self.keys = list(filter.value) if filter.op_string == "array_contains_any" else [filter.value]
                return self

            def limit(self, n):
                return self

            def stream(self):
                return [Hit(p[1], p[3], d) for p, d in db.data.items()
                        if len(p) == 4 and p[2] == name and any(k in (d.get("docKeys") or []) for k in self.keys)]
        return Q()


def _setup():
    db, bucket = GDb(), Bucket()
    t1 = db.collection("tenants").document("t1")
    t2 = db.collection("tenants").document("t2")
    t1.set({"companyName": "Old Firm"})
    t2.set({"companyName": "New Firm", "street": "הנמל", "streetNumber": "5", "city": "חיפה", "phone": "04-1111111", "deductionsFileNumber": "912345678"})
    t1.collection("workers").document("w1").set({
        "name": "Avi Cohen", "token": "tok-avi", "docGiven": "אבי", "docSurname": "כהן", "docId": "123456782", "docKeys": ["123456782"],
        "phone": "0501234567", "maritalStatus": "marital_married", "spouseGiven": "דנה", "hourlyRate": 55, "clientIds": ["c1"],
        "supplierId": "s1", "hrId": "u-hr", "notes": "secret", "status": "active",
        "scanPages": [{"fileId": "tenants/t1/workers/w1/pages/1-0-id_front.jpg", "kind": "id_front", "primary": True}]})
    bucket.store["tenants/t1/workers/w1/pages/1-0-id_front.jpg"] = b"\xff\xd8jpeg"
    p = contracts.run(db, bucket, ADMIN2, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "New contract"})
    contracts.run(db, bucket, ADMIN2, {"action": "save", "pdfBase64": p["lightBase64"], "name": "New contract"})
    return db, bucket


def finder(db):
    def f(_db, token):
        for p, d in db.data.items():
            if len(p) == 4 and p[2] == "workers" and d.get("token") == token:
                return p[1], p[3], d
        return None, None, None
    return f


def w(db, bucket, body):
    return signing.run_worker(db, bucket, dict(body, token="tok-avi", transfer=True), build101, finder=finder(db))


def test_the_new_firm_learns_nothing_and_only_its_admin_asks():
    db, bucket = _setup()
    assert signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101) == {"ok": True, "message": transfer.E_SENT}
    assert signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "999999998"}, build101) == {"ok": True, "message": transfer.E_SENT}
    assert "error" in signing.run(db, bucket, {"uid": "s", "role": "staff", "tenantId": "t2", "rt": ["workers", "editWorkers"]},
                                  {"action": "transferAsk", "docNumber": "123456782"}, build101)
    reqs = [d for p, d in db.data.items() if p[0] == "transferRequests"]
    assert len(reqs) == 1 and reqs[0]["fromTenant"] == "t1" and reqs[0]["toName"] == "New Firm"
    # the firm can't ask for its own worker
    signing.run(db, bucket, {"uid": "a1", "role": "tenant_admin", "tenantId": "t1"}, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    assert len([p for p in db.data if p[0] == "transferRequests"]) == 1


def _reqs(db):
    return [d for p, d in db.data.items() if p[0] == "transferRequests" and d.get("status") == "asked"]


def test_an_israeli_id_is_found_with_or_without_its_leading_zero():
    # stored padded to 9 (the worker window's normDocId), asked with the 8 digits typed
    db, bucket = _setup()
    db.collection("tenants").document("t1").collection("workers").document("w1").update({"docId": "012345674", "docKeys": ["012345674"]})
    assert signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "12345674"}, build101) == {"ok": True, "message": transfer.E_SENT}
    assert len(_reqs(db)) == 1 and _reqs(db)[0]["fromWorker"] == "w1"
    # an older record stored without the 0, asked with the 9 digits
    db, bucket = _setup()
    db.collection("tenants").document("t1").collection("workers").document("w1").update({"docId": "12345674", "docKeys": ["12345674"]})
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "012345674"}, build101)
    assert len(_reqs(db)) == 1 and _reqs(db)[0]["fromWorker"] == "w1"
    assert transfer.doc_key_forms("012345674") == ["012345674", "12345674"]
    assert transfer.doc_key_forms("12345674") == ["12345674", "012345674"]
    assert transfer.doc_key_forms("AB12345") == ["AB12345"]


def test_the_form_101_payload_sends_the_street_and_house_number_apart():
    # as form101Payload does: a house number such as "12א" must print whole, not be re-split from `address`
    p = transfer.form101_payload({"address": "הרצל", "houseNumber": "12א", "city": "חיפה"}, {}, "2026-10-01", "2026-10-01")
    assert p["street"] == "הרצל" and p["houseNumber"] == "12א" and p["address"] == "הרצל 12א"
    assert transfer.form101_payload({}, {}, "", "")["street"] == "" and transfer.form101_payload({}, {}, "", "")["houseNumber"] == ""


def test_the_worker_signs_and_only_the_personal_data_is_copied():
    db, bucket = _setup()
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "1234-5678-2"}, build101)
    mine = w(db, bucket, {"action": "mine"})
    assert mine["transfer"]["firm"] == "New Firm" and mine["transfer"]["status"] == "asked"
    v = w(db, bucket, {"action": "view", "which": "contract"})
    text = pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_text()
    assert "123456782" in text
    f = w(db, bucket, {"action": "view", "which": "form101"})
    assert "pages=1" in pymupdf.open(stream=base64.b64decode(f["pdfBase64"]))[0].get_text()
    assert w(db, bucket, {"action": "sign", "signaturePng": base64.b64encode(PNG).decode()})["ok"]
    assert w(db, bucket, {"action": "build", "which": "form101"})["status"] == "signing"
    assert w(db, bucket, {"action": "build", "which": "contract"})["status"] == "done"
    new = [(p, d) for p, d in db.data.items() if len(p) == 4 and p[1] == "t2" and p[2] == "workers"]
    assert len(new) == 1
    rec = new[0][1]
    assert rec["docGiven"] == "אבי" and rec["docId"] == "123456782" and rec["spouseGiven"] == "דנה" and rec["maritalStatus"] == "marital_married"
    for k in ("hourlyRate", "clientIds", "supplierId", "hrId", "notes"):
        assert not rec.get(k), k
    assert rec["token"] != "tok-avi" and rec["status"] == "active" and rec["signedAt"] and rec["docs"][0]["signed"]
    assert rec["scanPages"][0]["fileId"].startswith("tenants/t2/workers/" + rec["id"] + "/pages/")
    assert bucket.store[rec["scanPages"][0]["fileId"]] == b"\xff\xd8jpeg" and rec["docFileId"].startswith("tenants/t2/")
    old = db.data[("tenants", "t1", "workers", "w1")]
    assert old["status"] == "fired" and old["movedToOtherFirm"] and old["hourlyRate"] == 55 and "New Firm" not in str(old)
    log = [d for p, d in db.data.items() if p[0] == "transferLog"]
    assert len(log) == 1 and log[0]["fromTenant"] == "t1" and log[0]["toTenant"] == "t2"
    assert w(db, bucket, {"action": "mine"})["transfer"] is None


def test_two_builds_finishing_together_copy_once():
    db, bucket = _setup()
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    w(db, bucket, {"action": "sign", "signaturePng": base64.b64encode(PNG).decode()})
    rid = next(p[1] for p, d in db.data.items() if p[0] == "transferRequests")
    req = db.data[("transferRequests", rid)]
    # both parts already there (the other build wrote its part a moment ago) and still "signing"
    w(db, bucket, {"action": "build", "which": "form101"})
    req["parts"]["contract"] = dict(req["parts"]["form101"])
    req["status"] = "signing"
    copies = []
    orig = transfer._copy
    transfer._copy = lambda *a: copies.append(1) or orig(*a)
    try:
        w(db, bucket, {"action": "build", "which": "contract"})
        req["status"] = "signing"  # the other call read "signing" too
        w(db, bucket, {"action": "build", "which": "form101"})
    finally:
        transfer._copy = orig
    assert len(copies) == 1 and len([p for p in db.data if p[0] == "transferLog"]) == 1


def test_declined_or_expired_copies_nothing():
    db, bucket = _setup()
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    assert w(db, bucket, {"action": "decline"}) == {"ok": True}
    assert w(db, bucket, {"action": "mine"})["transfer"] is None
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    for p, d in db.data.items():
        if p[0] == "transferRequests" and d["status"] == "asked":
            d["expiresAt"] = "2000-01-01T00:00:00.000Z"
    assert w(db, bucket, {"action": "mine"})["transfer"] is None
    assert not [p for p in db.data if len(p) == 4 and p[1] == "t2" and p[2] == "workers"]
    assert db.data[("tenants", "t1", "workers", "w1")]["status"] == "active"


def test_the_new_firms_seal_is_frozen_when_it_asks():
    import io
    from PIL import Image
    db, bucket = _setup()
    b = io.BytesIO()
    Image.new("RGBA", (120, 120), (30, 60, 170, 255)).save(b, "PNG")
    bucket.store["tenants/t2/firmSeal/stamp-1.png"] = b.getvalue()
    db.collection("tenants").document("t2").collection("firmSeal").document("current").set({"stamp": {"path": "tenants/t2/firmSeal/stamp-1.png"}, "signature": None})
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    (rid, req), = [(p[1], d) for p, d in db.data.items() if p[0] == "transferRequests"]
    assert req["seal"] == {"signature": None, "stamp": f"tenants/t2/firmSeal/frozen/transfers/{rid}/stamp.png"}
    del bucket.store["tenants/t2/firmSeal/stamp-1.png"]  # the firm deletes its stamp: the request keeps its copy
    v = w(db, bucket, {"action": "view", "which": "contract"})
    widths = [i[2] for i in pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_images()]
    assert widths == [120]
    # a template saved before the every-page tick (no field) draws it too; only an explicit false leaves it out
    (tkey,) = [p for p in db.data if p[:3] == ("tenants", "t2", "contractTemplates")]
    db.data[tkey].pop("sealEveryPage", None)
    v = w(db, bucket, {"action": "view", "which": "contract"})
    assert [i[2] for i in pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_images()] == [120]
    db.data[tkey]["sealEveryPage"] = False
    v = w(db, bucket, {"action": "view", "which": "contract"})
    assert [i[2] for i in pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_images()] == []


# ---- what cannot become a document never takes a signature, and a signing has a way out ----

def _broken(p, strict=False):
    raise ValueError("The signature or a page could not be placed on Form 101")


def _asked():
    db, bucket = _setup()
    signing.run(db, bucket, ADMIN2, {"action": "transferAsk", "docNumber": "123456782"}, build101)
    return db, bucket


def _call(db, bucket, build=build101, **body):
    return signing.run_worker(db, bucket, dict(body, token="tok-avi", transfer=True), build, finder=finder(db))


SIG = base64.b64encode(PNG).decode()


def _req(db):
    return next(v for k, v in db.data.items() if k[0] == "transferRequests")


def test_view_and_sign_refuse_a_damaged_page_and_keep_nothing():
    db, bucket = _asked()
    assert _call(db, bucket, _broken, action="view", which="form101") == {"error": signing.E_PAGE_DAMAGED}
    before = set(bucket.store)
    assert _call(db, bucket, _broken, action="sign", signaturePng=SIG) == {"error": signing.E_PAGE_DAMAGED}
    assert set(bucket.store) == before and _req(db)["status"] == "asked"


def test_a_failed_build_is_told_and_a_retry_finishes_the_move():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    assert _call(db, bucket, _broken, action="build", which="form101") == {"error": signing.E_NOT_BUILT}
    t = _call(db, bucket, action="mine")["transfer"]
    assert t["buildError"] == signing.E_NOT_BUILT and t["stuck"]
    for which in signing.WHICH:
        assert _call(db, bucket, action="build", which=which)["part"]
    assert _req(db)["status"] == "done" and _call(db, bucket, action="mine")["transfer"] is None


def test_decline_after_the_signature_leaves_nothing_under_the_worker_never_created():
    db, bucket = _asked()
    _call(db, bucket, action="sign", signaturePng=SIG)
    part = _call(db, bucket, action="build", which="contract")["part"]
    sig = _req(db)["sigPath"]
    assert sig in bucket.store and part["path"] in bucket.store
    assert _call(db, bucket, action="decline") == {"ok": True}
    r = _req(db)
    assert r["status"] == "declined" and not r["sigPath"] and sig not in bucket.store and part["path"] not in bucket.store


def test_decline_cannot_undo_a_move_being_copied():
    db, bucket = _asked()
    _call(db, bucket, action="sign", signaturePng=SIG)
    _req(db)["copyClaimedAt"] = transfer._iso(transfer._now())
    assert _call(db, bucket, action="decline") == {"error": signing.E_SIGNED}
    _req(db).update(copyClaimedAt=None, copyCreated=True)  # the new record is made: only finishing is left
    assert _call(db, bucket, action="decline") == {"error": signing.E_SIGNED}
    _req(db)["signedAtIso"] = "2020-01-01T00:00:00.000Z"
    assert _call(db, bucket, action="mine")["transfer"]["status"] == "signing"  # and it does not expire either


def test_a_signing_nobody_finishes_expires_after_its_days_with_its_signature():
    db, bucket = _asked()
    _call(db, bucket, action="sign", signaturePng=SIG)
    sig = _req(db)["sigPath"]
    assert _call(db, bucket, action="mine")["transfer"]["status"] == "signing"
    _req(db)["signedAtIso"] = "2020-01-01T00:00:00.000Z"
    assert _call(db, bucket, action="mine")["transfer"] is None
    assert _req(db)["status"] == "expired" and sig not in bucket.store


def test_a_signing_kept_before_its_date_was_written_expires_by_the_request_s_date():
    db, bucket = _asked()
    _call(db, bucket, action="sign", signaturePng=SIG)
    r = _req(db)
    r.pop("signedAtIso")
    assert _call(db, bucket, action="mine")["transfer"]  # within the 14 days
    r["expiresAt"] = "2020-01-01T00:00:00.000Z"
    assert _call(db, bucket, action="mine")["transfer"] is None and _req(db)["status"] == "expired"


def _during_gate(action):
    done = []

    def build(p, strict=False, report=None):
        if not done:
            done.append(1)
            action()
        return build101(p, strict)

    return build


def _sigs(bucket):
    return [p for p in bucket.store if "/signature/" in p or "contract-template-" in p]


def test_a_decline_during_the_signature_s_gate_stays_and_nothing_is_copied():
    db, bucket = _asked()
    build = _during_gate(lambda: _call(db, bucket, action="decline"))
    assert _call(db, bucket, build, action="sign", signaturePng=SIG) == {"error": signing.E_NO_REQUEST}
    assert _req(db)["status"] == "declined" and _sigs(bucket) == [] and not _req(db).get("newWorkerId")


def test_two_devices_signing_keep_one_signature_and_one_new_worker():
    db, bucket = _asked()
    build = _during_gate(lambda: _call(db, bucket, action="sign", signaturePng=SIG))
    assert _call(db, bucket, build, action="sign", signaturePng=SIG) == {"error": signing.E_SIGNED}
    r = _req(db)
    assert sorted(_sigs(bucket)) == sorted([r["sigPath"], r["frozen"]["templatePath"]])


def test_a_late_signature_does_not_undo_a_finished_move():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    for which in signing.WHICH:
        _call(db, bucket, action="build", which=which)
    assert _req(db)["status"] == "done"
    assert _call(db, bucket, action="sign", signaturePng=SIG) == {"error": signing.E_NO_REQUEST}
    assert _req(db)["status"] == "done"


def _template_doc(db):
    return next(v for k, v in db.data.items() if k[:3] == ("tenants", "t2", "contractTemplates"))


def test_a_retry_builds_only_what_the_worker_saw(monkeypatch):
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    r = _req(db)
    seen = {}
    real = contracts.fill
    monkeypatch.setattr(contracts, "fill", lambda tpl, values, placed=None, *a, **k: seen.update(tpl=tpl, values=dict(values), placed=placed) or real(tpl, values, placed, *a, **k))
    pages = []

    def build(p, strict=False):
        pages.append((p["given"], p["signDate"], base64.b64decode(p["extraPages"][0]["b64"])))
        return build101(p, strict)

    # everything moves afterwards: the firm's template and name, the worker, the pages, the date
    frozen_template = bucket.store[r["frozen"]["templatePath"]]
    t = _template_doc(db)
    live = bucket.store.pop(t["fileId"])
    db.data[("tenants", "t2")]["companyName"] = "Renamed"
    w = db.data[("tenants", "t1", "workers", "w1")]
    w["docGiven"] = "Changed"
    bucket.store["tenants/t1/workers/w1/pages/9-0-id_front.jpg"] = b"\xff\xd8new"
    w["scanPages"] = [{"fileId": "tenants/t1/workers/w1/pages/9-0-id_front.jpg", "kind": "id_front", "primary": True}]
    monkeypatch.setattr(signing, "today_il", lambda: "30/12/2030")
    assert _call(db, bucket, build, action="build", which="form101")["part"]
    assert _call(db, bucket, build, action="build", which="contract")["part"]
    assert seen["tpl"] == frozen_template == live
    assert seen["values"]["given"] != "Changed" and seen["values"]["company"] != "Renamed" and seen["values"]["today"] != "30/12/2030"
    assert pages[0][0] != "Changed" and pages[0][1] != "30/12/2030" and pages[0][2] == b"\xff\xd8jpeg"
    moved = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t2", "workers"))
    assert moved["docGiven"] != "Changed" and moved["scanPages"][0]["kind"] == "id_front" and "sha256" not in moved["scanPages"][0]


def test_a_deleted_template_after_the_signature_does_not_stop_the_build():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    for k in [k for k in db.data if k[:3] == ("tenants", "t2", "contractTemplates")]:
        del db.data[k]
    assert _call(db, bucket, action="build", which="contract")["part"]


def test_an_older_signing_with_no_template_left_says_so_instead_of_failing():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    _req(db).pop("frozen")
    for k in [k for k in db.data if k[:3] == ("tenants", "t2", "contractTemplates")]:
        del db.data[k]
    assert _call(db, bucket, action="build", which="contract") == {"error": signing.E_NOT_BUILT}
    assert _call(db, bucket, action="mine")["transfer"]["buildError"] == signing.E_NOT_BUILT
    # the firm whose template it is hears of it
    assert any(d.get("tenantId") == "t2" and "could not be built" in d.get("message", "") for k, d in db.data.items() if k[0] == "errors")


def test_a_failed_copy_resumes_and_is_made_once(monkeypatch):
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    _call(db, bucket, action="build", which="form101")
    real = transfer._download_url
    fail = [1]

    def flaky(*a):
        if fail:
            fail.pop()
            raise ConnectionError("no storage")
        return real(*a)

    monkeypatch.setattr(transfer, "_download_url", flaky)
    assert _call(db, bucket, action="build", which="contract") == {"error": signing.E_NOT_BUILT}
    r = _req(db)
    assert r["status"] == "signing" and not r.get("copyClaimedAt") and not r.get("copyDone")
    assert _call(db, bucket, action="mine")["transfer"]["buildError"] == signing.E_NOT_BUILT
    assert _call(db, bucket, action="build", which="contract")["status"] == "done"
    r = _req(db)
    assert r["copyDone"] and not signing.build_error(r) and _call(db, bucket, action="mine")["transfer"] is None
    assert len([k for k in db.data if k[:3] == ("tenants", "t2", "workers")]) == 1


def test_a_copy_that_died_is_taken_over_after_its_lease_and_a_new_record_is_not_written_over(monkeypatch):
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    _call(db, bucket, action="build", which="form101")
    r = _req(db)
    r["copyClaimedAt"] = transfer._iso(transfer._now())
    assert _call(db, bucket, action="build", which="contract")["status"] == "signing"  # another build has it
    assert _req(db)["status"] == "signing"
    r = _req(db)
    r["copyClaimedAt"] = "2020-01-01T00:00:00.000Z"
    new = ("tenants", "t2", "workers", r["newWorkerId"])
    db.data[new] = {"name": "edited since"}
    assert _call(db, bucket, action="build", which="contract")["status"] == "done"
    assert db.data[new] == {"name": "edited since"}


def test_a_late_build_after_a_decline_keeps_nothing():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]

    def declined_during_the_build(p, strict=False):
        assert _call(db, bucket, action="decline") == {"ok": True}
        return build101(p, strict)

    assert _call(db, bucket, declined_during_the_build, action="build", which="form101") == {"error": signing.E_NO_REQUEST}
    r = _req(db)
    assert r["status"] == "declined" and not r.get("parts") and not [p for p in bucket.store if "/form101/" in p or "/signature/" in p]


def test_a_delete_that_fails_keeps_its_path_and_is_tried_again():
    db, bucket = _asked()
    assert _call(db, bucket, action="sign", signaturePng=SIG)["ok"]
    sig = _req(db)["sigPath"]
    real = bucket.blob

    def blob(path):
        b = real(path)
        if path == sig:
            def no():
                raise ConnectionError("no storage")
            b.delete = no
        return b

    bucket.blob = blob
    assert _call(db, bucket, action="decline") == {"ok": True}
    r = _req(db)
    assert r["status"] == "declined" and r["sigPath"] == sig and r["discardPending"] == [sig] and sig in bucket.store
    bucket.blob = real
    _call(db, bucket, action="mine")
    r = _req(db)
    assert not r["discardPending"] and not r["sigPath"] and sig not in bucket.store and not r["frozen"]


def test_a_move_is_viewed_and_signed_in_the_signer_s_language_and_a_retry_keeps_it():
    db, bucket = _asked()
    seen = []

    def build(p, strict=False):
        seen.append(p)
        return build101(p, strict)

    assert _call(db, bucket, build, action="view", which="form101", lang="he")["ok"]
    assert (seen[-1]["sheetLang"], seen[-1]["builder"]) == ("he", "b2")
    assert _call(db, bucket, build, action="sign", signaturePng=SIG, lang="he")["ok"]
    r = _req(db)
    assert (r["frozen"]["lang"], r["frozen"]["builder"]) == ("he", "b2")
    assert _call(db, bucket, build, action="build", which="form101", lang="en")["part"]["builder"] == "b2"
    assert seen[-1]["sheetLang"] == "he"


def test_a_move_signed_with_no_language_stays_on_b1():
    db, bucket = _asked()
    seen = []

    def build(p, strict=False):
        seen.append(p)
        return build101(p, strict)

    assert _call(db, bucket, build, action="sign", signaturePng=SIG)["ok"]
    assert _call(db, bucket, build, action="build", which="form101")["part"]["builder"] == "b1"
    assert seen[-1]["builder"] == "b1" and "sheetLang" not in seen[-1]
