"""One signature for Form 101 and the contract (functions/signing.py, docs/contracts.md →
Signing): the send and what it may carry (the signing date only with its right, pay marks only
for a login that sees pay — else the whole send is refused), the worker's own page by the
punch link's token, the signature kept once, the two PDFs built by two calls, never again."""

import base64
import os
import sys

import pytest

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


def test_the_form_is_built_with_each_page_s_kind_and_the_signing_date_s_year():
    db, bucket, t = _setup()
    seen = []

    def build(p, strict=False):
        seen.append((p, strict))
        return build101(p, strict)

    assert "taxYear" not in signing._clean_form101({"given": "Avi", "taxYear": "2001"})
    _send(db, bucket, OWNER, t, form101={"given": "Avi", "taxYear": "2001"})
    f = finder(db)
    assert signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "form101"}, build, finder=f)["ok"]
    p, strict = seen[-1]
    assert strict and "taxYear" not in p and [x.get("kind") for x in p["extraPages"]] == ["id_front"]  # what is shown can be signed
    signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": base64.b64encode(PNG).decode()}, build, finder=f)
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build, finder=f)["ok"]
    assert seen[-1][1] is True  # the signed form: strict


def _broken(p, strict=False):
    raise ValueError("The signature or a page could not be placed on Form 101")


SIG = base64.b64encode(PNG).decode()


def _status(db):
    return [r["status"] for r in signing.run(db, None, OWNER, {"action": "list"}, build101)["requests"]]


def test_a_damaged_page_stops_the_send_and_nothing_reaches_the_worker():
    db, bucket, t = _setup()
    before = set(bucket.store)
    r = signing.run(db, bucket, OWNER, {"action": "send", "workerId": "w1", "templateId": t["id"], "form101": {"given": "Avi"}}, _broken)
    assert r == {"error": signing.E_PAGE_DAMAGED}
    assert set(bucket.store) == before and _status(db) == []


def test_a_listed_page_missing_from_storage_stops_the_send():
    db, bucket, t = _setup()
    del bucket.store["tenants/t1/workers/w1/pages/1-0-id_front.jpg"]
    assert _send(db, bucket, OWNER, t) == {"error": signing.E_PAGE_DAMAGED}


def test_a_broken_template_stops_the_send():
    db, bucket, t = _setup()
    file_id = db.data[("tenants", "t1", "contractTemplates", t["id"])]["fileId"]
    bucket.store[file_id] = b"not a pdf"
    assert _send(db, bucket, OWNER, t) == {"error": signing.E_CONTRACT_BROKEN}


def test_the_send_sees_the_real_page_and_form_refusal_only():
    # Storage not answering is no judgment on the documents: the error stays what it is
    db, bucket, t = _setup()

    def down(p, strict=False):
        raise ConnectionError("no storage")

    try:
        _send_with(db, bucket, t, down)
    except ConnectionError:
        return
    raise AssertionError("expected the failure to pass through")


def _send_with(db, bucket, t, build):
    return signing.run(db, bucket, OWNER, {"action": "send", "workerId": "w1", "templateId": t["id"], "form101": {"given": "Avi"}}, build)


def test_view_and_sign_are_the_last_gates_and_nothing_is_kept():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    f = finder(db)
    assert signing.run_worker(db, bucket, {"action": "view", "token": "tok-avi", "which": "form101"}, _broken, finder=f) == {"error": signing.E_PAGE_DAMAGED}
    before = set(bucket.store)
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": SIG}, _broken, finder=f) == {"error": signing.E_PAGE_DAMAGED}
    assert set(bucket.store) == before and _status(db) == ["sent"]


def test_a_png_that_does_not_decode_is_no_signature():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    cut = base64.b64encode(PNG[:30]).decode()
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": cut}, build101, finder=finder(db)) == {"error": signing.E_SIG}


def _signing(db, bucket, t):
    _send(db, bucket, OWNER, t)
    f = finder(db)
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": SIG}, build101, finder=f)["ok"]
    return f


def test_a_build_that_fails_after_the_signature_says_so_and_a_retry_finishes_it():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, _broken, finder=f) == {"error": signing.E_NOT_BUILT}
    mine = signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=f)["request"]
    assert mine["status"] == "signing" and mine["buildError"] == signing.E_NOT_BUILT and mine["stuck"] and mine["signedAtIso"]
    row = signing.run(db, bucket, OWNER, {"action": "list"}, build101)["requests"][0]
    assert row["buildError"] == signing.E_NOT_BUILT and not row.get("parts")
    assert any("could not be built" in d.get("message", "") for k, d in db.data.items() if k and k[0] == "errors")  # Admin → Errors
    # what failed was passing (the frozen pages are still there): the same request goes on, the error gone
    for which in signing.WHICH:
        assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": which}, build101, finder=f)["part"]
    mine = signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=f)["request"]
    assert mine["status"] == "signed" and not mine["buildError"]


def test_one_document_s_success_does_not_hide_the_other_s_failure():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, _broken, finder=f)
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)["part"]
    assert signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=f)["request"]["buildError"] == signing.E_NOT_BUILT


def test_a_stuck_signing_can_be_withdrawn_and_nothing_built_is_lost():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    rid = signing.run(db, bucket, OWNER, {"action": "list"}, build101)["requests"][0]["id"]
    # still being built: not yet
    assert signing.run(db, bucket, OWNER, {"action": "withdraw", "id": rid}, build101) == {"error": signing.E_STILL_SAVING}
    contract = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)["part"]
    signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, _broken, finder=f)
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    sig = r["sigPath"]
    assert signing.run(db, bucket, STAFF_RO, {"action": "withdraw", "id": rid}, build101) == {"error": signing.E_NO_RIGHT}
    assert signing.run(db, bucket, OWNER, {"action": "withdraw", "id": rid}, build101) == {"ok": True}
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert r["status"] == "withdrawn" and r["withdrawnWhy"] == "not built" and r["sigPath"] == sig and r["parts"]["contract"] == contract
    assert sig in bucket.store and contract["path"] in bucket.store  # the signature and the part built stay
    assert signing.run_worker(db, bucket, {"action": "mine", "token": "tok-avi"}, build101, finder=f)["request"] is None
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f) == {"error": signing.E_NO_REQUEST}


def test_a_signing_with_no_error_counts_as_stuck_only_after_its_time():
    import datetime
    now = datetime.datetime(2026, 10, 31, 12, tzinfo=datetime.timezone.utc)
    at = lambda m: (now - datetime.timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert not signing.stuck({"status": "signing", "signedAtIso": at(5)}, now)
    assert signing.stuck({"status": "signing", "signedAtIso": at(11)}, now)
    assert signing.stuck({"status": "signing", "signedAtIso": at(1), "buildErrors": {"form101": "x"}}, now)
    assert not signing.stuck({"status": "signing", "signedAtIso": at(1), "buildErrors": {"form101": None}}, now)
    assert not signing.stuck({"status": "signed", "signedAtIso": at(60)}, now)


# ---- nothing overwrites a status, and a signature has only what it was given on ----

def _other_first(db, bucket, t, action, then=build101):
    """A stand-in build that, during sign's dry run, lets another call win the race once."""
    done = []

    def build(p, strict=False, report=None):
        if not done:
            done.append(1)
            action()
        return then(p, strict)

    return build


def _rid(db):
    return signing.run(db, None, OWNER, {"action": "list"}, build101)["requests"][0]["id"]


def _sign(db, bucket, build, token="tok-avi"):
    return signing.run_worker(db, bucket, {"action": "sign", "token": token, "signaturePng": SIG}, build, finder=finder(db))


def _sigs(bucket):
    return [p for p in bucket.store if "/signature/" in p]


def test_a_withdraw_during_the_signature_s_gate_stays_and_the_signature_is_removed():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    rid = _rid(db)
    build = _other_first(db, bucket, t, lambda: signing.run(db, bucket, OWNER, {"action": "withdraw", "id": rid}, build101))
    assert _sign(db, bucket, build) == {"error": signing.E_NO_REQUEST}
    assert _status(db) == ["withdrawn"] and _sigs(bucket) == []


def test_a_replacing_send_during_the_gate_wins():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    old = _rid(db)
    build = _other_first(db, bucket, t, lambda: _send(db, bucket, OWNER, t, sentAt="later"))
    assert "error" in _sign(db, bucket, build)
    r = db.data[("tenants", "t1", "signRequests", old)]
    assert r["status"] == "replaced" and not r.get("sigPath") and _sigs(bucket) == []


def test_two_signatures_at_once_keep_one():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    build = _other_first(db, bucket, t, lambda: _sign(db, bucket, build101))
    assert _sign(db, bucket, build) == {"error": signing.E_SIGNED}
    rid = _rid(db)
    assert _sigs(bucket) == [db.data[("tenants", "t1", "signRequests", rid)]["sigPath"]]


def test_a_rescan_after_the_signature_changes_nothing_in_what_is_built():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    worker = db.data[("tenants", "t1", "workers", "w1")]
    bucket.store["tenants/t1/workers/w1/pages/2-0-id_front.jpg"] = b"\xff\xd8other"
    worker["scanPages"] = [{"fileId": "tenants/t1/workers/w1/pages/2-0-id_front.jpg", "kind": "id_front", "primary": True}]
    seen = []

    def build(p, strict=False):
        seen.append(base64.b64decode(p["extraPages"][0]["b64"]))
        return build101(p, strict)

    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build, finder=f)["part"]
    assert seen == [b"\xff\xd8jpeg"]


@pytest.mark.parametrize("change", ["deleted", "changed"])
def test_a_page_gone_or_changed_after_the_signature_is_not_built_and_withdraw_is_the_way_out(change):
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    page = "tenants/t1/workers/w1/pages/1-0-id_front.jpg"
    if change == "deleted":
        del bucket.store[page]
    else:
        bucket.store[page] = b"\xff\xd8other"
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f) == {"error": signing.E_NOT_BUILT}
    assert signing.run(db, bucket, OWNER, {"action": "withdraw", "id": _rid(db)}, build101) == {"ok": True}
    assert _status(db) == ["withdrawn"]


def test_today_is_the_signature_s_day_on_every_build(monkeypatch):
    db, bucket, t = _setup()
    monkeypatch.setattr(signing, "today_il", lambda: "01/11/2026")
    f = _signing(db, bucket, t)
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert r["frozen"]["today"] == "01/11/2026"
    filled = {}
    real = contracts.fill
    monkeypatch.setattr(contracts, "fill", lambda tpl, values, *a, **k: filled.update(values) or real(tpl, values, *a, **k))
    monkeypatch.setattr(signing, "today_il", lambda: "20/11/2026")
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)["part"]
    assert filled["today"] == "01/11/2026"


def test_a_signed_request_cannot_be_withdrawn_and_a_withdrawn_one_cannot_become_signed():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    rid = _rid(db)
    for which in signing.WHICH:
        signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": which}, build101, finder=f)
    assert signing.run(db, bucket, OWNER, {"action": "withdraw", "id": rid}, build101) == {"ok": True}  # signed: nothing to withdraw
    assert _status(db) == ["signed"]

    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    rid = _rid(db)
    signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, _broken, finder=f)
    built = []

    def withdrawn_during_the_build(p, strict=False):
        built.append(signing.run(db, bucket, OWNER, {"action": "withdraw", "id": rid}, build101))
        return build101(p, strict)

    before = set(bucket.store)
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, withdrawn_during_the_build, finder=f) == {"error": signing.E_NO_REQUEST}
    assert built == [{"ok": True}] and _status(db) == ["withdrawn"] and set(bucket.store) == before  # the late part is not kept


def test_try_again_finishes_a_request_whose_two_parts_are_stored():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    for which in signing.WHICH:
        signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": which}, build101, finder=f)
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    r["status"] = "signing"  # a call that died between the second part and its status
    assert signing.run(db, bucket, OWNER, {"action": "withdraw", "id": _rid(db)}, build101) == {"error": signing.E_SIGNED}
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f)["status"] == "signed"
    assert _status(db) == ["signed"]


class Blip(ConnectionError):
    pass


def test_a_storage_blip_on_the_template_is_no_judgment_on_it():
    db, bucket, t = _setup()
    file_id = db.data[("tenants", "t1", "contractTemplates", t["id"])]["fileId"]
    real = bucket.blob

    def blob(path):
        b = real(path)
        if path == file_id:
            def down():
                raise Blip("no storage")
            b.download_as_bytes = down
        return b

    bucket.blob = blob
    with pytest.raises(Blip):
        _send(db, bucket, OWNER, t)
    assert _status(db) == []


def test_a_storage_blip_after_the_signature_records_nothing_and_try_again_finishes():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    real = bucket.blob

    def blob(path):
        b = real(path)
        if path == r["templatePath"]:
            def down():
                raise Blip("no storage")
            b.download_as_bytes = down
        return b

    bucket.blob = blob
    with pytest.raises(Blip):
        signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)
    assert not signing.build_error(r)
    bucket.blob = real
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "contract"}, build101, finder=f)["part"]


def test_a_worker_on_an_old_sidecar_is_not_refused_for_a_page_listed_and_gone():
    import json
    db, bucket, t = _setup()
    w = db.data[("tenants", "t1", "workers", "w1")]
    del bucket.store["tenants/t1/workers/w1/pages/1-0-id_front.jpg"]
    w["assetsFileId"] = "tenants/t1/workers/w1/assets/1.json"
    bucket.store[w["assetsFileId"]] = json.dumps({"scanB64": "AAAA", "scanMediaType": "image/jpeg"}).encode()
    assert _send(db, bucket, OWNER, t)["ok"]
    f = finder(db)
    assert _sign(db, bucket, build101)["ok"]
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert r["frozen"]["pages"][0]["sidecar"] == w["assetsFileId"]
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build101, finder=f)["part"]


# ---- the attached sheet's language is the signer's ----

def _seen(out):
    def build(p, strict=False):
        out.append(p)
        return build101(p, strict)
    return build


def _view(db, bucket, build, lang=None):
    body = {"action": "view", "token": "tok-avi", "which": "form101"}
    return signing.run_worker(db, bucket, dict(body, lang=lang) if lang else body, build, finder=finder(db))


def test_view_sign_and_a_retry_after_the_language_changed_all_use_the_signer_s():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    seen = []
    build = _seen(seen)
    assert _view(db, bucket, build, "he")["ok"]
    assert (seen[-1]["sheetLang"], seen[-1]["builder"]) == ("he", "b2")
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": SIG, "lang": "he"}, build, finder=finder(db))["ok"]
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert (r["frozen"]["lang"], r["frozen"]["builder"]) == ("he", "b2")
    # the worker's page is now in English: nothing a later call sends reaches what was signed
    for which in signing.WHICH:
        b = signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": which, "lang": "en"}, build, finder=finder(db))
    assert (seen[-1]["sheetLang"], seen[-1]["builder"]) == ("he", "b2")
    assert r["parts"]["form101"]["builder"] == "b2" and "builder" not in r["parts"]["contract"]  # the contract is contracts.fill until S4


def test_russian_at_the_signature_freezes_english():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    assert signing.run_worker(db, bucket, {"action": "sign", "token": "tok-avi", "signaturePng": SIG, "lang": "ru"}, build101, finder=finder(db))["ok"]
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert r["frozen"]["lang"] == "en"


def test_a_page_with_no_language_stays_on_b1_s_hebrew():
    db, bucket, t = _setup()
    _send(db, bucket, OWNER, t)
    seen = []
    build = _seen(seen)
    assert _view(db, bucket, build)["ok"]
    assert seen[-1]["builder"] == "b1" and "sheetLang" not in seen[-1]
    f = finder(db)
    assert _sign(db, bucket, build)["ok"]
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    assert not r["frozen"]["lang"] and r["frozen"]["builder"] == "b1"
    signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, build, finder=f)
    assert seen[-1]["builder"] == "b1" and r["parts"]["form101"]["builder"] == "b1"


def test_a_signature_kept_before_the_language_stays_on_b1():
    db, bucket, t = _setup()
    f = _signing(db, bucket, t)
    r = next(v for k, v in db.data.items() if k[:3] == ("tenants", "t1", "signRequests"))
    r["frozen"].pop("lang"), r["frozen"].pop("builder")
    seen = []
    assert signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": "form101"}, _seen(seen), finder=f)["part"]
    assert seen[-1]["builder"] == "b1"


def test_the_values_sent_cannot_choose_a_builder():
    assert signing._clean_form101({"given": "Avi", "sheetLang": "he", "builder": "b1"}) == {"given": "Avi"}
