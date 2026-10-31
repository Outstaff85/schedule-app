"""One signature for Form 101 and the contract (functions/signing.py, docs/contracts.md →
Signing): the send and what it may carry (the signing date only with its right, pay marks only
for a login that sees pay — else the whole send is refused), the worker's own page by the
punch link's token, the signature kept once, the two PDFs built by two calls, never again."""

import base64
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # after functions-auth: its main stays `main`
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import contracts  # noqa: E402
import signing  # noqa: E402
from test_contracts import Bucket, Db, _pdf, _b64  # noqa: E402

OWNER = {"uid": "u1", "role": "tenant_admin", "tenantId": "t1"}
STAFF_NO_PAY = {"uid": "u2", "role": "staff", "tenantId": "t1", "rt": ["workers", "editWorkers"]}
STAFF_DATE = {"uid": "u3", "role": "staff", "tenantId": "t1", "rt": ["workers", "editWorkers", "setSignDate", "accounting"]}
HR_OWN = {"uid": "u-hr", "role": "hr", "tenantId": "t1", "own": True, "rt": ["workers", "editWorkers", "seePay"]}
STAFF_RO = {"uid": "u4", "role": "staff", "tenantId": "t1", "rt": ["workers"]}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def build101(p, strict=False, report=None):
    """A stand-in for Form 101's build: a page with the date, the name and whether it is signed."""
    assert strict == bool(p.get("signaturePngBase64"))  # a signed document is built strictly, an unsigned one not
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 80), "F101 " + str(p.get("given")) + " " + str(p.get("signDate")) + (" SIGNED" if p.get("signaturePngBase64") else "")
                     + " pages=" + str(len(p.get("extraPages") or [])), fontsize=12)
    return doc.tobytes(), "f101 " + str(p.get("given")) + ".pdf"


def _setup():
    db, bucket = Db(), Bucket()
    w = db.collection("tenants").document("t1").collection("workers")
    w.document("w1").set({"name": "Avi Cohen", "token": "tok-avi", "hrId": "u-hr",
                          "scanPages": [{"fileId": "tenants/t1/workers/w1/pages/1-0-id_front.jpg", "kind": "id_front", "primary": True}]})
    w.document("w2").set({"name": "Dana", "token": "tok-dana", "hrId": "other"})
    bucket.store["tenants/t1/workers/w1/pages/1-0-id_front.jpg"] = b"\xff\xd8jpeg"
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "Hourly"})
    t = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Hourly", "category": "hourly"})["template"]
    return db, bucket, t


def finder(db):
    def f(_db, token):
        for p, d in db.data.items():
            if len(p) == 4 and p[2] == "workers" and d.get("token") == token:
                return p[1], p[3], d
        return None, None, None
    return f


def _send(db, bucket, claims, t, **kw):
    body = {"action": "send", "workerId": "w1", "templateId": t["id"], "values": {"given": "Avi", "id": "123456782"},
            "form101": {"given": "Avi", "signaturePngBase64": "x"}}
    body.update(kw)
    return signing.run(db, bucket, claims, body, build101)


def test_send_refused_as_a_whole_without_the_rights():
    db, bucket, t = _setup()
    assert _send(db, bucket, STAFF_NO_PAY, t, signDate="05/10/2026") == {"error": signing.E_DATE}
    assert _send(db, bucket, STAFF_NO_PAY, t, values={"given": "Avi", "rate": "40"}) == {"error": signing.E_PAY}
    assert _send(db, bucket, STAFF_RO, t) == {"error": signing.E_NO_RIGHT}
    # nothing reached the worker
    assert not [p for p in db.data if "signRequests" in p]
    assert signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=finder(db))["request"] is None
    # with the rights it goes; an empty pay mark is no pay mark
    assert _send(db, bucket, STAFF_NO_PAY, t, values={"given": "Avi", "rate": ""})["ok"]
    assert _send(db, bucket, STAFF_DATE, t, signDate="5/10/2026", values={"rate": "40"})["request"]["signDate"] == "05/10/2026"
    assert _send(db, bucket, OWNER, t, signDate="31/02/2026")["error"].startswith("Not a date")


def test_hr_own_only_its_workers():
    db, bucket, t = _setup()
    assert _send(db, bucket, HR_OWN, t)["ok"]
    assert _send(db, bucket, HR_OWN, t, workerId="w2") == {"error": signing.E_NO_WORKER}
    assert [r["workerId"] for r in signing.run(db, bucket, HR_OWN, {"action": "list"}, build101)["requests"]] == ["w1"]


def test_the_worker_signs_once_in_their_own_page_and_both_pdfs_are_built():
    db, bucket, t = _setup()
    sent = _send(db, bucket, OWNER, t, signDate="01/09/2026")
    rid = sent["id"]
    f = finder(db)
    mine = signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=f)["request"]
    assert mine["status"] == "sent" and mine["signDate"] == "01/09/2026" and mine["templateName"] == "Hourly"
    # another worker's link sees nothing of it; an unknown link nothing at all
    assert signing.run_worker(db, bucket, {"action": "mine", "token": "tok-dana"}, build101, finder=f)["request"] is None
    assert signing.run_worker(db, bucket, {"action": "view", "token": "nope", "which": "form101"}, build101, finder=f) == {"error": signing.E_LINK}
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    text = pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_text()
    assert "123456782" in text and "01/09/2026" in text and not v["signed"] and v["dateFixed"]
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "form101"}, build101, finder=f)
    assert "F101 Avi 01/09/2026 pages=1" in pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))[0].get_text()
    # the template replaced after the send: the worker still signs the one sent
    contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": _b64(_pdf(picture=True)), "replaceId": t["id"]})
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": "data:image/png;base64,AAAA"}, build101, finder=f) == {"error": signing.E_SIG}
    s = signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": "data:image/png;base64," + base64.b64encode(PNG).decode()},
                           build101, server_time="SERVER", finder=f)
    assert s["ok"] and s["signDate"] == "01/09/2026"
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": base64.b64encode(PNG).decode()}, build101, finder=f) == {"error": signing.E_SIGNED}
    req = db.data[("tenants", "t1", "signRequests", rid)]
    assert req["status"] == "signing" and req["signedAt"] == "SERVER" and bucket.store[req["sigPath"]] == PNG
    # two calls, one per document
    a = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f)
    assert a["status"] == "signing"
    b = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert b["status"] == "signed"
    req = db.data[("tenants", "t1", "signRequests", rid)]
    f101 = pymupdf.open(stream=bucket.store[req["parts"]["form101"]["path"]])[0].get_text()
    contract = pymupdf.open(stream=bucket.store[req["parts"]["contract"]["path"]])
    assert "SIGNED" in f101 and "01/09/2026" in f101
    assert len(contract[0].get_images()) == 1 and "01/09/2026" in contract[0].get_text() and contract.page_count == 1
    assert req["parts"]["form101"]["path"].startswith("tenants/t1/workers/w1/form101/") and req["parts"]["contract"]["path"].startswith("tenants/t1/workers/w1/docs/")
    # never built again: a second build answers what is stored
    again = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert again["part"] == req["parts"]["contract"]
    # the worker reads what they signed
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert v["signed"] and base64.b64decode(v["pdfBase64"]) == bucket.store[req["parts"]["contract"]["path"]]
    # the manager app takes it once
    lst = signing.run(db, bucket, OWNER, {"action": "list"}, build101)["requests"]
    assert lst[0]["status"] == "signed" and lst[0]["parts"]["form101"]["path"] and "values" not in lst[0]
    assert signing.run(db, bucket, OWNER, {"action": "applied", "id": rid}, build101) == {"ok": True}


def test_signing_date_is_the_day_of_signing_by_default_and_a_new_send_replaces_the_old():
    db, bucket, t = _setup()
    first = _send(db, bucket, OWNER, t)["id"]
    second = _send(db, bucket, OWNER, t)["id"]
    assert db.data[("tenants", "t1", "signRequests", first)]["status"] == "replaced"
    f = finder(db)
    s = signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": base64.b64encode(PNG).decode()}, build101, finder=f)
    assert s["id"] == second and s["signDate"] == signing.today_il()


def test_deleting_the_template_withdraws_a_waiting_send():
    db, bucket, t = _setup()
    rid = _send(db, bucket, OWNER, t)["id"]
    contracts.run(db, bucket, OWNER, {"action": "delete", "id": t["id"]})
    assert db.data[("tenants", "t1", "signRequests", rid)]["status"] == "withdrawn"
    assert signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=finder(db))["request"] is None


def test_rights_rules():
    assert signing.may_see_pay(OWNER) and not signing.may_see_pay(STAFF_NO_PAY) and signing.may_see_pay(STAFF_DATE) and signing.may_see_pay(HR_OWN)
    assert signing.may_set_date(OWNER) and signing.may_set_date(STAFF_DATE) and not signing.may_set_date(HR_OWN)
    assert signing.run(Db(), Bucket(), {"role": "supplier", "tenantId": "t1"}, {"action": "list"}, build101) == {"error": signing.E_NO_RIGHT}


def test_the_print_hash_is_kept_with_the_send():
    db, bucket, t = _setup()
    r = _send(db, bucket, STAFF_NO_PAY, t, printHash="abc123", printPay=True)
    req = db.data[("tenants", "t1", "signRequests", r["id"])]
    # a login that doesn't see pay never marks the hash as with pay
    assert req["printHash"] == "abc123" and req["printPay"] is False and "full_name" in req["printMarks"]
    lst = signing.run(db, bucket, OWNER, {"action": "list"}, build101)["requests"]
    assert lst[0]["printHash"] == "abc123" and lst[0]["printMarks"] == req["printMarks"]



# ---- the firm's signature and stamp, frozen at the send (seal.py) ----------------------------

def _seal_firm(db, bucket, n):
    """The firm's signature and stamp, the stamp n px wide (a later change is another width)."""
    from PIL import Image, ImageDraw
    import io
    paths = {}
    for kind, size in (("signature", (300, 120)), ("stamp", (n, n))):
        im = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(im).ellipse((4, 4, size[0] - 4, size[1] - 4), outline=(30, 60, 170, 255), width=6)
        b = io.BytesIO()
        im.save(b, "PNG")
        paths[kind] = {"path": f"tenants/t1/firmSeal/{kind}-{n}.png"}
        bucket.store[paths[kind]["path"]] = b.getvalue()
    db.collection("tenants").document("t1").collection("firmSeal").document("current").set(paths)


def _widths(b64):
    doc = pymupdf.open(stream=base64.b64decode(b64))
    return [sorted(i[2] for i in p.get_images()) for p in doc]


def test_the_send_freezes_the_firms_seal():
    db, bucket, t = _setup()  # a template saved now: the every-page tick on
    _seal_firm(db, bucket, 200)
    rid = _send(db, bucket, OWNER, t)["id"]
    req = db.data[("tenants", "t1", "signRequests", rid)]
    assert req["seal"] == {"signature": f"tenants/t1/firmSeal/frozen/workers/w1/sign/{rid}/company-signature.png",
                           "stamp": f"tenants/t1/firmSeal/frozen/workers/w1/sign/{rid}/stamp.png", "everyPage": True}
    f = finder(db)
    view = lambda: signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert _widths(view()["pdfBase64"]) == [[200, 300]]
    # the firm changes its stamp after the send: this send still shows the one it was sent with
    _seal_firm(db, bucket, 180)
    assert _widths(view()["pdfBase64"]) == [[200, 300]]
    signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": base64.b64encode(PNG).decode()}, build101, finder=f)
    b = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    signed = bucket.store[b["part"]["path"]]
    assert [x for x in _widths(base64.b64encode(signed))[0] if x != 1] == [200, 300]  # the worker's 1 px signature too
    # never built again, whatever the firm changes
    _seal_firm(db, bucket, 150)
    again = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert again["part"] == b["part"] and bucket.store[b["part"]["path"]] == signed
    # Form 101 never gets the seal
    a = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f)
    assert _widths(base64.b64encode(bucket.store[a["part"]["path"]])) == [[]]


def test_a_send_made_before_the_seal_draws_none():
    db, bucket, t = _setup()
    _seal_firm(db, bucket, 200)
    rid = _send(db, bucket, OWNER, t)["id"]
    db.data[("tenants", "t1", "signRequests", rid)].pop("seal")  # as an old send
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=finder(db))
    assert _widths(v["pdfBase64"]) == [[]]


def test_a_template_saved_before_the_tick_freezes_every_page_on():
    """No sealEveryPage field (a template saved before the tick) reads as on; a send already made keeps what it froze."""
    db, bucket, t = _setup()
    db.data[("tenants", "t1", "contractTemplates", t["id"])].pop("sealEveryPage", None)
    _seal_firm(db, bucket, 200)
    rid = _send(db, bucket, OWNER, t)["id"]
    assert db.data[("tenants", "t1", "signRequests", rid)]["seal"]["everyPage"] is True
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=finder(db))
    assert _widths(v["pdfBase64"]) == [[200, 300]]
    # the template turned off later: the send keeps its frozen tick
    db.data[("tenants", "t1", "contractTemplates", t["id"])]["sealEveryPage"] = False
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=finder(db))
    assert _widths(v["pdfBase64"]) == [[200, 300]]


def test_a_template_without_the_tick_draws_no_seal_and_values_never_carry_it():
    db, bucket, t = _setup()
    db.data[("tenants", "t1", "contractTemplates", t["id"])]["sealEveryPage"] = False
    _seal_firm(db, bucket, 200)
    rid = _send(db, bucket, OWNER, t, values={"given": "Avi", "stamp": "x", "company_signature": "y"})["id"]
    req = db.data[("tenants", "t1", "signRequests", rid)]
    assert req["seal"]["everyPage"] is False and "stamp" not in req["values"] and "company_signature" not in req["values"]
    v = signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "contract"}, build101, finder=finder(db))
    assert _widths(v["pdfBase64"]) == [[]]
