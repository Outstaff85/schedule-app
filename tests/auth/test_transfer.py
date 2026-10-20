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
                self.key = filter.value
                return self

            def limit(self, n):
                return self

            def stream(self):
                return [Hit(p[1], p[3], d) for p, d in db.data.items()
                        if len(p) == 4 and p[2] == name and self.key in (d.get("docKeys") or [])]
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
