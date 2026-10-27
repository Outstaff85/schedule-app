"""A client's contract (functions/client_signing.py, docs/contracts.md → Client contracts): templates by kind, the
send and what it may carry (only a login with the right "Firm's signature and stamp; client contracts"; billing marks
only from a login that sees client billing — else the whole send is refused), the link's token (only its hash kept; a
wrong, replaced, withdrawn or expired one sees nothing), the client's details cleaned and laid over its marks (never the
firm's or the billing values), one signature, one signed PDF kept on the client and never built again, the firm's
signature and stamp frozen with the send, and the page sees nothing of another firm."""

import base64
import datetime
import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # after functions-auth: its main stays `main`
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import client_signing  # noqa: E402
import contracts  # noqa: E402
import signing  # noqa: E402
from test_contracts import Bucket, Db, _b64, _pdf, _seal_pngs  # noqa: E402

OWNER = {"uid": "u1", "role": "tenant_admin", "tenantId": "t1"}
STAFF_SEAL = {"uid": "u2", "role": "staff", "tenantId": "t1", "rt": ["clients", "firmSign"]}
STAFF_SEAL_BILL = {"uid": "u3", "role": "staff", "tenantId": "t1", "rt": ["clients", "firmSign", "accounting"]}
STAFF_NO_SEAL = {"uid": "u4", "role": "staff", "tenantId": "t1", "rt": ["clients", "accounting"]}
HR_SEAL = {"uid": "u5", "role": "hr", "tenantId": "t1", "rt": ["clients", "firmSign", "seePay"]}
OTHER = {"uid": "u9", "role": "tenant_admin", "tenantId": "t2"}
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


def build101(p):
    raise AssertionError("a client's contract never builds Form 101")


def _client_pdf(pages=2):
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page()
        if i == 0:
            page.insert_text((50, 100), "Client: {{client_name}}   No: {{client_company_no}}", fontsize=12)
            page.insert_text((50, 130), "Phone: {{client_phone}}   Mail: {{client_email}}", fontsize=12)
            page.insert_text((50, 160), "Firm: {{company}}   Rate: {{client_rate}}", fontsize=12)
            page.insert_text((50, 190), "Worker: {{signature}}", fontsize=12)
        page.insert_text((50, 400), "Signer: {{client_signer}}   Sign: {{client_signature}}   Date: {{client_sign_date}}", fontsize=12)
    return doc.tobytes()


def _setup(seal=True):
    db, bucket = Db(), Bucket()
    t1 = db.collection("tenants").document("t1")
    t1.set({"companyName": "Firm One"})
    t1.collection("clients").document("c1").set({"name": "Site A", "companyNumber": "512345678", "contactPhone": "0501234567"})
    t1.collection("clients").document("c2").set({"name": "Site B"})
    db.collection("tenants").document("t2").collection("clients").document("c9").set({"name": "Other"})
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_client_pdf()), "name": "Service", "kind": "client"})
    t = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Service", "kind": "client"})["template"]
    if seal:
        sig, stamp = _seal_pngs()
        t1.collection("firmSeal").document("current").set({"signature": {"path": "tenants/t1/firmSeal/signature-1.png"},
                                                            "stamp": {"path": "tenants/t1/firmSeal/stamp-1.png"}})
        bucket.store["tenants/t1/firmSeal/signature-1.png"] = sig
        bucket.store["tenants/t1/firmSeal/stamp-1.png"] = stamp
    return db, bucket, t


def _send(db, bucket, claims, t, **kw):
    body = {"action": "clientSend", "clientId": "c1", "templateId": t["id"], "values": {"company": "Firm One"},
            "details": {"email": "a@b.co"}, "origin": "http://localhost:8765"}
    body.update(kw)
    return signing.run(db, bucket, claims, body, build101)


def _token(link):
    return link.split("?t=", 1)[1]


def _pub(db, bucket, token, **kw):
    return client_signing.run_public(db, bucket, dict({"clientToken": token}, **kw))


def _reqs(db):
    return {p[-1]: d for p, d in db.data.items() if "clientSignRequests" in p}


# ---- templates by kind ------------------------------------------------------------------------

def test_kind_stored_and_listed_per_kind_and_defaults_apart():
    db, bucket, t = _setup()
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "Hourly"})
    w = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Hourly"})["template"]
    assert t["kind"] == "client" and w["kind"] == "worker"
    # the first of each kind (same empty category) is its default: the kinds are apart
    assert t["isDefault"] and w["isDefault"]
    assert [x["name"] for x in contracts.run(db, bucket, OWNER, {"action": "list"})["templates"]] == ["Hourly"]  # no kind sent: a worker's
    assert [x["name"] for x in contracts.run(db, bucket, OWNER, {"action": "list", "kind": "client"})["templates"]] == ["Service"]
    assert len(contracts.run(db, bucket, OWNER, {"action": "list", "kind": "all"})["templates"]) == 2
    # a template saved before the kind is a worker's
    db.data[("tenants", "t1", "contractTemplates", w["id"])].pop("kind")
    assert contracts.run(db, bucket, OWNER, {"action": "list"})["templates"][0]["kind"] == "worker"
    # making a client template the default leaves the worker one's default alone
    t2 = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Service 2", "kind": "client"})["template"]
    assert not t2["isDefault"]
    contracts.run(db, bucket, OWNER, {"action": "update", "id": t2["id"], "isDefault": True})
    by = {x["name"]: x for x in contracts.run(db, bucket, OWNER, {"action": "list", "kind": "all"})["templates"]}
    assert by["Service 2"]["isDefault"] and not by["Service"]["isDefault"] and by["Hourly"]["isDefault"]
    # deleting a client default passes it to another client template, never to a worker's
    contracts.run(db, bucket, OWNER, {"action": "delete", "id": t2["id"]})
    by = {x["name"]: x for x in contracts.run(db, bucket, OWNER, {"action": "list", "kind": "all"})["templates"]}
    assert by["Service"]["isDefault"] and by["Hourly"]["isDefault"]
    # a bad kind, or a worker's own template made a client's, is refused
    assert contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "kind": "supplier"}) == {"error": contracts.E_KIND}
    assert contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "kind": "client", "workerId": "w1"}) == {"error": contracts.E_KIND}


def test_a_clients_own_template_is_listed_only_with_its_client():
    db, bucket, t = _setup()
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_client_pdf()), "name": "Own", "kind": "client"})
    own = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Own", "clientId": "c1"})["template"]
    assert own["kind"] == "client" and own["clientId"] == "c1" and not own["isDefault"]
    assert [x["name"] for x in contracts.run(db, bucket, OWNER, {"action": "list", "kind": "client"})["templates"]] == ["Service"]
    assert len(contracts.run(db, bucket, OWNER, {"action": "list", "kind": "client", "clientId": "c1"})["templates"]) == 2
    assert len(contracts.run(db, bucket, OWNER, {"action": "list", "kind": "client", "clientId": "c2"})["templates"]) == 1
    # another client can't be sent it
    assert _send(db, bucket, OWNER, own, clientId="c2") == {"error": signing.E_NO_TEMPLATE}
    assert _send(db, bucket, OWNER, own)["ok"]


def test_a_worker_send_refuses_a_client_template_and_the_reverse():
    db, bucket, t = _setup()
    db.collection("tenants").document("t1").collection("workers").document("w1").set({"name": "Avi"})
    r = signing.run(db, bucket, OWNER, {"action": "send", "workerId": "w1", "templateId": t["id"], "values": {}}, build101)
    assert r == {"error": signing.E_CLIENT_TEMPLATE}
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "Hourly"})
    w = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Hourly"})["template"]
    assert _send(db, bucket, OWNER, w) == {"error": client_signing.E_WORKER_TEMPLATE}
    assert not _reqs(db)


def test_the_sample_of_a_client_template_signs_at_client_signature():
    db, bucket, t = _setup(seal=False)
    doc = pymupdf.open(stream=base64.b64decode(contracts.run(db, bucket, OWNER, {"action": "file", "id": t["id"], "sample": True})["pdfBase64"]))
    text = doc[0].get_text()
    assert "512345678" in text and "{{" not in text
    # the made-up signer's signature at {{client_signature}} (not at {{signature}}) and the made-up seal at the bottom
    sig_y = [i["bbox"][1] for i in doc[0].get_image_info() if i["bbox"][1] < doc[0].rect.height * 0.7]
    assert len(sig_y) == 1 and sig_y[0] > 300


# ---- the send ---------------------------------------------------------------------------------------

def test_send_needs_the_right_and_billing_needs_billing():
    db, bucket, t = _setup()
    assert _send(db, bucket, STAFF_NO_SEAL, t) == {"error": client_signing.E_NO_RIGHT}
    # billing marks from a login that may not see billing: the whole send refused, nothing stored
    assert _send(db, bucket, STAFF_SEAL, t, values={"company": "Firm One", "client_rate": "55 ₪"}) == {"error": client_signing.E_BILLING}
    assert _send(db, bucket, HR_SEAL, t, values={"client_pay_mode": "יומי"}) == {"error": client_signing.E_BILLING}
    assert _send(db, bucket, STAFF_SEAL, t, signDate="01/01/2026") == {"error": signing.E_DATE}
    assert not _reqs(db) and not [p for p in db.data if p[0] == "clientSignTokens"]
    # an empty billing mark is no billing mark; with the rights it goes
    assert _send(db, bucket, STAFF_SEAL, t, values={"client_rate": ""})["ok"]
    assert _send(db, bucket, STAFF_SEAL_BILL, t, values={"client_rate": "55 ₪"})["ok"]
    assert _send(db, bucket, OWNER, t, clientId="nope") == {"error": client_signing.E_NO_CLIENT}
    # a supplier or a client login never gets here (signing.run refuses every role but a manager's)
    for role in ("supplier", "client"):
        assert signing.run(db, bucket, {"uid": "x", "role": role, "tenantId": "t1", "rt": ["firmSign"]},
                           {"action": "clientSend", "clientId": "c1", "templateId": t["id"]}, build101) == {"error": signing.E_NO_RIGHT}
    # the list needs the Clients right
    assert client_signing.run(db, bucket, {"uid": "x", "role": "staff", "tenantId": "t1", "rt": ["firmSign"]}, {"action": "clientList"}, "t1") \
        == {"error": client_signing.E_NO_CLIENTS}
    # …and so does every other client action: firmSign alone (a template for the seal only) never reaches a client
    rid = _send(db, bucket, OWNER, t)["id"]
    for who in ({"uid": "x", "role": "staff", "tenantId": "t1", "rt": ["firmSign"]},
                {"uid": "y", "role": "hr", "tenantId": "t1", "rt": ["firmSign", "workers"]}):
        assert _send(db, bucket, who, t) == {"error": client_signing.E_NO_CLIENTS}
        for action in ("clientView", "clientSign", "clientBuild", "clientWithdraw"):
            assert signing.run(db, bucket, who, {"action": action, "id": rid, "signaturePng": base64.b64encode(PNG).decode()},
                               build101) == {"error": client_signing.E_NO_CLIENTS}
    assert _reqs(db)[rid]["status"] == "sent"


def test_the_token_only_its_hash_kept_and_the_link_is_the_apps_own():
    db, bucket, t = _setup()
    r = _send(db, bucket, OWNER, t)
    assert r["link"].startswith("http://localhost:8765/client-sign?t=")
    tok = _token(r["link"])
    req = _reqs(db)[r["id"]]
    assert req["tokenHash"] == client_signing.token_hash(tok) and tok not in str(db.data) and "tokenHash" not in r["request"]
    assert db.data[("clientSignTokens", req["tokenHash"])] == {"tenantId": "t1", "requestId": r["id"], "expiresAt": req["expiresAt"]}
    # the frozen template and seal under the client's sign folder
    assert req["templatePath"] == f"tenants/t1/clients/c1/sign/{r['id']}/contract-template.pdf"
    assert req["seal"]["signature"].startswith(f"tenants/t1/firmSeal/frozen/clients/c1/sign/{r['id']}/") and req["seal"]["everyPage"] is True
    # the prefill: the client record, then what the window sent
    assert req["details"]["name"] == "Site A" and req["details"]["contactPhone"] == "0501234567" and req["details"]["email"] == "a@b.co"
    # another origin is not trusted: the site's own
    assert _send(db, bucket, OWNER, t, origin="https://evil.example")["link"].startswith("https://odinson.ltd/client-sign?t=")
    assert client_signing.link_origin("https://schedule-odinson--pr-1-abc.web.app") == "https://schedule-odinson--pr-1-abc.web.app"
    assert client_signing.link_origin("https://user@odinson.ltd") == client_signing.DEFAULT_ORIGIN
    # in person: no link, no token
    p = _send(db, bucket, OWNER, t, way="person")
    assert "link" not in p and _reqs(db)[p["id"]]["tokenHash"] is None


def test_wrong_replaced_withdrawn_or_expired_tokens_see_nothing():
    db, bucket, t = _setup()
    first = _token(_send(db, bucket, OWNER, t)["link"])
    assert _pub(db, bucket, first, action="mine")["request"]["firm"] == "Firm One"
    assert _pub(db, bucket, "nope", action="mine") == {"error": client_signing.E_LINK}
    assert _pub(db, bucket, "", action="view") == {"error": client_signing.E_LINK}
    # a new send replaces the waiting one: the old link stops working
    second = _token(_send(db, bucket, OWNER, t)["link"])
    assert _pub(db, bucket, first, action="mine") == {"error": client_signing.E_LINK}
    assert _pub(db, bucket, second, action="mine")["ok"]
    # withdrawn
    rid = [k for k, v in _reqs(db).items() if v["status"] == "sent"][0]
    assert signing.run(db, bucket, OWNER, {"action": "clientWithdraw", "id": rid}, build101)["ok"]
    assert _pub(db, bucket, second, action="view") == {"error": client_signing.E_LINK}
    # expired: 30 days after the send
    third = _token(_send(db, bucket, OWNER, t)["link"])
    old = client_signing._now
    try:
        client_signing._now = lambda: old() + datetime.timedelta(days=31)
        assert _pub(db, bucket, third, action="mine") == {"error": client_signing.E_LINK}
    finally:
        client_signing._now = old
    # a deleted template withdraws its waiting sends and their links
    contracts.run(db, bucket, OWNER, {"action": "delete", "id": t["id"]})
    assert _pub(db, bucket, third, action="mine") == {"error": client_signing.E_LINK}
    assert all(v["status"] in ("replaced", "withdrawn") for v in _reqs(db).values())
    assert not [p for p in db.data if p[0] == "clientSignTokens"]


def test_another_firms_request_is_never_reached():
    db, bucket, t = _setup()
    r = _send(db, bucket, OWNER, t)
    # another firm's manager: neither its list nor its request
    assert client_signing.run(db, bucket, OTHER, {"action": "clientList"}, "t2")["requests"] == []
    assert signing.run(db, bucket, OTHER, {"action": "clientView", "id": r["id"]}, build101) == {"error": signing.E_NO_REQUEST}
    # a token whose index points elsewhere (a forged index) is refused: the request must carry the token's hash
    tok = _token(r["link"])
    h = client_signing.token_hash(tok)
    db.data[("clientSignTokens", h)] = {"tenantId": "t2", "requestId": r["id"], "expiresAt": "2099-01-01T00:00:00.000Z"}
    assert _pub(db, bucket, tok, action="mine") == {"error": client_signing.E_LINK}


# ---- the client's page ----------------------------------------------------------------------------

def test_the_page_details_view_sign_once_build_once():
    db, bucket, t = _setup()
    r = _send(db, bucket, STAFF_SEAL_BILL, t, values={"company": "Firm One", "client_rate": "55 ₪"})
    tok = _token(r["link"])
    mine = _pub(db, bucket, tok, action="mine")["request"]
    assert mine["status"] == "sent" and mine["details"]["companyNumber"] == "512345678" and "values" not in mine and "tokenHash" not in mine
    # the client's details cleaned (control characters out, 120 at most) and laid over its marks; billing and firm values frozen
    v = _pub(db, bucket, tok, action="view", details={"companyNumber": "5\u000012\u0007999", "email": "x" * 300 + "@y",
                                                      "client_rate": "1 ₪"})
    doc = pymupdf.open(stream=base64.b64decode(v["pdfBase64"]))
    text = "".join(p.get_text() for p in doc)
    assert "512999" in text and "55" in text and "1 ₪" not in text and "Firm One" in text and "{{" not in text
    assert client_signing.clean_details({"email": "x" * 300, "name": " A\u0000B ", "client_rate": "1"}) == {"email": "x" * 120, "name": "AB"}
    assert v["signDate"] and not v["signed"]
    # the seal frozen and drawn on every page: 2 pages, the signature and the stamp on each
    assert all(len(p.get_image_info()) == 2 for p in doc)
    # a later change of the firm's seal does not change this send
    bucket.store["tenants/t1/firmSeal/stamp-1.png"] = _seal_pngs()[0]
    again = pymupdf.open(stream=base64.b64decode(_pub(db, bucket, tok, action="view")["pdfBase64"]))
    assert sorted(i["width"] for i in again[1].get_image_info()) == sorted(i["width"] for i in doc[1].get_image_info())
    # no signature yet: building is refused; a bad signature too
    assert _pub(db, bucket, tok, action="build") == {"error": signing.E_NO_REQUEST}
    assert _pub(db, bucket, tok, action="sign", signaturePng="nope") == {"error": signing.E_SIG}
    s = _pub(db, bucket, tok, action="sign", signaturePng=base64.b64encode(PNG).decode(), details={"signerName": "Moshe", "email": "m@s.co"})
    assert s["ok"] and s["signDate"]
    assert _pub(db, bucket, tok, action="sign", signaturePng=base64.b64encode(PNG).decode()) == {"error": signing.E_SIGNED}
    req = _reqs(db)[r["id"]]
    assert req["status"] == "signing" and req["clientDetails"]["signerName"] == "Moshe" and req["clientDetails"]["name"] == "Site A"
    assert req["sigPath"].startswith("tenants/t1/clients/c1/signature/")
    b = _pub(db, bucket, tok, action="build")
    assert b["ok"] and b["status"] == "signed" and b["part"]["path"].startswith("tenants/t1/clients/c1/documents/") and "-contract-" in b["part"]["path"]
    pdf = bucket.store[b["part"]["path"]]
    signed = pymupdf.open(stream=pdf)
    assert "Moshe" in signed[1].get_text() and s["signDate"] in signed[1].get_text() and "m@s.co" in signed[0].get_text()
    # the client's signature at {{client_signature}} on both pages (+ the seal), {{signature}} left blank
    assert [len(p.get_image_info()) for p in signed] == [3, 3]
    assert all("signature" not in p.get_text() for p in signed)
    # never built again: the same part
    assert _pub(db, bucket, tok, action="build")["part"] == b["part"] and len([k for k in bucket.store if "/documents/" in k]) == 1
    # after signing the page still shows it (the stored PDF), with its details as signed
    assert _pub(db, bucket, tok, action="view")["signed"] is True
    assert _pub(db, bucket, tok, action="mine")["request"]["details"]["signerName"] == "Moshe"
    # 30 days after the link's end the signed contract is no longer shown
    old = client_signing._now
    try:
        client_signing._now = lambda: old() + datetime.timedelta(days=45)
        assert _pub(db, bucket, tok, action="mine")["ok"]
        client_signing._now = lambda: old() + datetime.timedelta(days=61)
        assert _pub(db, bucket, tok, action="mine") == {"error": client_signing.E_LINK}
    finally:
        client_signing._now = old
    # the manager's list: summaries without the token or the values; taken on once
    rows = signing.run(db, bucket, OWNER, {"action": "clientList", "clientId": "c1"}, build101)["requests"]
    assert rows[0]["status"] == "signed" and rows[0]["part"] and "values" not in rows[0] and "tokenHash" not in rows[0]
    assert signing.run(db, bucket, OWNER, {"action": "clientApplied", "id": r["id"]}, build101)["ok"]
    assert _reqs(db)[r["id"]]["appliedAt"]


def test_sign_here_in_the_client_window():
    db, bucket, t = _setup(seal=False)
    r = _send(db, bucket, STAFF_SEAL, t, way="person")
    v = signing.run(db, bucket, STAFF_SEAL, {"action": "clientView", "id": r["id"], "details": {"signerName": "Dana"}}, build101)
    assert v["ok"] and "Dana" in "".join(p.get_text() for p in pymupdf.open(stream=base64.b64decode(v["pdfBase64"])))
    assert signing.run(db, bucket, STAFF_SEAL, {"action": "clientSign", "id": r["id"], "signaturePng": base64.b64encode(PNG).decode(),
                                                "details": {"signerName": "Dana"}}, build101)["ok"]
    b = signing.run(db, bucket, STAFF_SEAL, {"action": "clientBuild", "id": r["id"]}, build101)
    assert b["status"] == "signed"
    # without the right: none of it
    assert signing.run(db, bucket, STAFF_NO_SEAL, {"action": "clientView", "id": r["id"]}, build101) == {"error": client_signing.E_NO_RIGHT}
    # no seal uploaded: only the client's signature
    assert [len(p.get_image_info()) for p in pymupdf.open(stream=bucket.store[b["part"]["path"]])] == [1, 1]


# ---- two calls at once ------------------------------------------------------------------------------

def test_a_status_moves_only_while_it_still_holds():
    db, bucket, t = _setup()
    r = _send(db, bucket, OWNER, t)
    ref = db.collection("tenants").document("t1").collection("clientSignRequests").document(r["id"])
    assert client_signing._move(db, ref, lambda x: x.get("status") == "signed", {"status": "replaced"}) is None
    assert _reqs(db)[r["id"]]["status"] == "sent"
    assert client_signing._move(db, ref, lambda x: x.get("status") == "sent", {"status": "withdrawn"})["status"] == "sent"
    assert _reqs(db)[r["id"]]["status"] == "withdrawn"


def test_a_signature_racing_another_loses_without_a_trace():
    """Each call read the request as 'sent'; the other one has signed (or a new send replaced it) since: the late one is
    refused, its uploaded signature removed, the first one's kept."""
    db, bucket, t = _setup()
    r = _send(db, bucket, OWNER, t)
    tok = _token(r["link"])
    _, rid, stale = client_signing._by_token(db, tok)
    assert _pub(db, bucket, tok, action="sign", signaturePng=base64.b64encode(PNG).decode(), details={"signerName": "First"})["ok"]
    first = _reqs(db)[rid]["sigPath"]
    late = client_signing._documents(db, bucket, "t1", rid, stale, {"action": "sign", "signaturePng": base64.b64encode(PNG).decode(),
                                                                     "details": {"signerName": "Late"}}, None)
    assert late == {"error": signing.E_SIGNED}
    assert _reqs(db)[rid]["sigPath"] == first and _reqs(db)[rid]["clientDetails"]["signerName"] == "First"
    assert [k for k in bucket.store if "/signature/" in k] == [first]
    # a new send while the client signs: the signing request is never turned into 'replaced'
    _send(db, bucket, OWNER, t)
    assert _reqs(db)[rid]["status"] == "signing" and _pub(db, bucket, tok, action="mine")["ok"]
    # a stale 'sent' read of a request a send has replaced since: refused as no request
    r3 = _send(db, bucket, OWNER, t)
    _, rid3, stale3 = client_signing._by_token(db, _token(r3["link"]))
    _send(db, bucket, OWNER, t)
    assert client_signing._documents(db, bucket, "t1", rid3, stale3, {"action": "sign", "signaturePng": base64.b64encode(PNG).decode()},
                                     None) == {"error": signing.E_NO_REQUEST}
    assert len([k for k in bucket.store if "/signature/" in k]) == 1


def test_two_builds_at_once_keep_one_signed_contract():
    db, bucket, t = _setup()
    r = _send(db, bucket, OWNER, t)
    tok = _token(r["link"])
    _pub(db, bucket, tok, action="sign", signaturePng=base64.b64encode(PNG).decode())
    _, rid, stale = client_signing._by_token(db, tok)  # read as 'signing', no part yet
    b = _pub(db, bucket, tok, action="build")
    late = client_signing._documents(db, bucket, "t1", rid, stale, {"action": "build"}, None)
    assert late["ok"] and late["part"] == b["part"]
    assert [k for k in bucket.store if "/documents/" in k] == [b["part"]["path"]]


def test_a_signed_contract_waiting_for_its_pdf_keeps_its_link():
    """Signed, its PDF not built (the build failed): the link still opens after the 30 days, so the page builds it."""
    db, bucket, t = _setup()
    tok = _token(_send(db, bucket, OWNER, t)["link"])
    _pub(db, bucket, tok, action="sign", signaturePng=base64.b64encode(PNG).decode())
    old = client_signing._now
    try:
        client_signing._now = lambda: old() + datetime.timedelta(days=45)
        assert _pub(db, bucket, tok, action="build")["status"] == "signed"
    finally:
        client_signing._now = old
