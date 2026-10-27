"""A client's contract (docs/contracts.md → Client contracts).

The firm sends a client a contract to sign: a template whose kind is `client`
(contracts.py), filled with the firm's marks, what the client pays (only from a
login that sees client billing — signing.may_see_billing) and the client's own
details. The firm's signature and stamp are frozen with the send (seal.py), as
for a worker. The client opens the link without any login: a token made for
this one request (secrets.token_urlsafe, returned once, at the send; only its
SHA-256 is kept), checks and edits its details, reads the filled contract with
the firm's signature and stamp, signs with a finger; the signed PDF is built
once and kept on the client. "Sign here" in the client window does the same on
the manager's phone (way `person`, no link).

  tenants/<t>/clientSignRequests/<id>: clientId, status (sent → signing → signed;
      replaced, withdrawn), way (remote | person), templateId / templateName /
      templateVersion / templatePath (the frozen copy) / placed, values (the firm's
      and the billing marks at the send), details (the prefill), clientDetails (as
      signed), seal {signature, stamp, everyPage}, signDate, dateFixed, tokenHash,
      expiresAt (the send + 30 days), sentAt, sentBy, signedAt (server time),
      signedAtIso, sigPath, part {path, name, size}, appliedAt
  clientSignTokens/<sha256(token)>: {tenantId, requestId, expiresAt} — the link's index
  Storage: tenants/<t>/clients/<c>/sign/<id>/ (the frozen template; its seal under tenants/<t>/firmSeal/frozen/clients/<c>/sign/<id>/),
      …/clients/<c>/signature/<ms>-<random>-signature.png, …/clients/<c>/documents/<ms>-contract-<name>.pdf

No browser reads or writes either collection (firestore.rules grant nothing);
the page sees nothing of the firm but its own request — no workers, hours, other
requests or files. The function keeps no state per request.
"""

import base64
import datetime
import hashlib
import re
import secrets
import time
import uuid
from urllib.parse import urlparse

import contracts
import seal as seal_mod
import signing

# The client's details the page shows and the client may change, and the marks they fill.
DETAILS = ("name", "companyNumber", "address", "contactPhone", "email", "signerName", "signerRole")
DETAIL_MARKS = {"name": "client_name", "companyNumber": "client_company_no", "address": "client_address",
                "contactPhone": "client_phone", "email": "client_email", "signerName": "client_signer",
                "signerRole": "client_signer_role"}
# What a send may carry as values: the firm's marks and what the client pays (frozen: the client can't change them).
VALUE_MARKS = contracts.FIRM_MARKS + contracts.CLIENT_BILL_MARKS
ADMIN_ROLES = ("superadmin", "tenant_admin")
LINK_DAYS = 30          # a link waits this long for the signature
KEEP_DAYS = 30          # …and, once signed, keeps showing the signed contract this much longer
DETAIL_MAX = 120
DEFAULT_ORIGIN = "https://odinson.ltd"
HOSTS = ("odinson.ltd", "www.odinson.ltd", "schedule-odinson.web.app", "schedule-odinson.firebaseapp.com")
PREVIEW_HOST = re.compile(r"^schedule-odinson--[a-z0-9-]+\.web\.app$")
LOCAL_HOSTS = ("localhost", "127.0.0.1")

E_NO_RIGHT = "Only the firm's admin or a login with the right \"Firm's signature and stamp; client contracts\" sends contracts to clients"
E_NO_CLIENTS = "No rights to clients"
E_BILLING = "This login may not see client billing — the contract has billing marks; send it from a login that sees billing"
E_NO_CLIENT = "Client not found"
E_WORKER_TEMPLATE = "This template is for workers"
E_LINK = "This link is no longer valid"


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _parse(iso):
    try:
        return datetime.datetime.strptime(str(iso), "%Y-%m-%dT%H:%M:%S.000Z").replace(tzinfo=datetime.timezone.utc)
    except (TypeError, ValueError):
        return None


def token_hash(token):
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def link_origin(origin):
    """The sign link's origin: the app's own (the Hosting domains, a preview channel, localhost for the tests), else the site's."""
    try:
        u = urlparse(str(origin or ""))
        host = (u.hostname or "").lower()
    except ValueError:
        return DEFAULT_ORIGIN
    if "@" in (u.netloc or ""):
        return DEFAULT_ORIGIN
    if u.scheme == "https" and (host in HOSTS or PREVIEW_HOST.match(host)):
        return "https://" + u.netloc
    if u.scheme in ("http", "https") and host in LOCAL_HOSTS:
        return u.scheme + "://" + u.netloc
    return DEFAULT_ORIGIN


def clean_details(d):
    """The client's details as typed (on the page or in the window): only the known ones, each at most 120 characters, no control characters."""
    out = {}
    if not isinstance(d, dict):
        return out
    for k in DETAILS:
        if k in d:
            out[k] = re.sub(r"[\u0000-\u001f\u007f]", "", str(d.get(k) if d.get(k) is not None else "")).strip()[:DETAIL_MAX]
    return out


def _clean_values(values):
    out = {}
    for k, v in (values or {}).items() if isinstance(values, dict) else []:
        if k in VALUE_MARKS:
            out[k] = re.sub(r"[\u0000-\u001f]", " ", str(v if v is not None else ""))[:300]
    return out


def _col(db, tenant):
    return db.collection("tenants").document(tenant).collection("clientSignRequests")


def _tokens(db):
    return db.collection("clientSignTokens")


def _drop_token(db, req):
    if req and req.get("tokenHash"):
        _tokens(db).document(req["tokenHash"]).delete()


def _move(db, ref, check, fields):
    """ref updated with fields only while check(its data) still holds, read and written in one transaction (two calls at
    once — a double tap, two tabs, a send while the client signs — never both pass) → the data as it was, or None.
    A store without transactions (the tests' stand-in) does the same check and write in a row."""
    def step(get, put):
        snap = get()
        cur = snap.to_dict() if snap.exists else None
        if not cur or not check(cur):
            return None
        put(fields)
        return cur
    if not hasattr(db, "transaction"):
        return step(ref.get, ref.update)
    from firebase_admin import firestore

    @firestore.transactional
    def go(tx):
        return step(lambda: ref.get(transaction=tx), lambda f: tx.update(ref, f))
    return go(db.transaction())


def _summary(rid, x):
    """What the manager app gets: never the token's hash or the values."""
    keys = ("clientId", "status", "way", "templateId", "templateName", "templateVersion", "signDate", "dateFixed", "sentAt", "sentBy",
            "signedAt", "signedAtIso", "part", "appliedAt", "clientDetails", "expiresAt", "withdrawnWhy")
    out = {k: x.get(k) for k in keys if k in x}
    if out.get("signedAt") is not None and not isinstance(out["signedAt"], str):
        try:
            out["signedAt"] = out["signedAt"].isoformat()
        except Exception:
            out["signedAt"] = str(out["signedAt"])
    out["id"] = rid
    return out


def withdraw_on_template(db, tenant, template_id):
    """A deleted template: the client sends still waiting on it are withdrawn and their links stop working."""
    col = _col(db, tenant)
    for r in col.stream():
        x = r.to_dict() or {}
        if x.get("templateId") == template_id and x.get("status") == "sent":
            was = _move(db, col.document(r.id), lambda y: y.get("status") == "sent", {"status": "withdrawn", "withdrawnWhy": "template deleted"})
            if was:
                _drop_token(db, was)


def _name(req, details):
    name = (req.get("templateName") or "Contract") + " - " + str((details or {}).get("name") or "").strip()
    return re.sub(r"[\\/:*?\"<>|]", " ", name).strip(" -") + ".pdf"


def _pdf(req, bucket, details, signature=None, date=None):
    """The client's contract filled → (bytes, file name): the frozen values (the firm's, what the client pays), the client's
    details over its marks, the date, the frozen seal; the client's signature at {{client_signature}}."""
    date = date or req.get("signDate") or signing.today_il()
    tpl = bucket.blob(req["templatePath"]).download_as_bytes()
    values = dict(req.get("values") or {})
    for k, mark in DETAIL_MARKS.items():
        values[mark] = str((details or {}).get(k) or "")
    values.update(client_sign_date=date, sign_date=date, today=signing.today_il())
    data = contracts.fill(tpl, values, req.get("placed"), signature, seal=seal_mod.read_frozen(bucket, req.get("seal")),
                          sign_mark="client_signature")
    return data, _name(req, details)


def _documents(db, bucket, tenant, rid, req, body, server_time):
    """view / sign / build — the same for the client's page and Sign here in the client window."""
    action = str(body.get("action") or "")
    ref = _col(db, tenant).document(rid)
    status = req.get("status")

    if action == "view":
        part = req.get("part")
        if status == "signed" and part:
            data = bucket.blob(part["path"]).download_as_bytes()
            return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": part.get("name"), "signed": True}
        if status != "sent":
            return {"error": signing.E_NO_REQUEST}
        details = dict(req.get("details") or {}, **clean_details(body.get("details")))
        data, name = _pdf(req, bucket, details)
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name,
                "signDate": req.get("signDate") or signing.today_il(), "dateFixed": bool(req.get("dateFixed")), "signed": False}

    if action == "sign":
        if status in ("signing", "signed"):
            return {"error": signing.E_SIGNED}
        if status != "sent":
            return {"error": signing.E_NO_REQUEST}
        sig = signing._sig_bytes(body.get("signaturePng"))
        if not sig:
            return {"error": signing.E_SIG}
        details = dict(req.get("details") or {}, **clean_details(body.get("details")))
        path = f"tenants/{tenant}/clients/{req['clientId']}/signature/{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}-signature.png"  # two at once never share a file
        bucket.blob(path).upload_from_string(sig, content_type="image/png")
        date = req.get("signDate") or signing.today_il()
        # sent → signing only while it is still sent: a second signature or a send replacing it at the same moment loses
        if not _move(db, ref, lambda x: x.get("status") == "sent",
                     {"status": "signing", "signedAt": server_time if server_time is not None else signing._now_iso(),
                      "signedAtIso": signing._now_iso(), "signDate": date, "sigPath": path, "clientDetails": details}):
            bucket.blob(path).delete()
            now = ref.get()
            cur = (now.to_dict() or {}) if now.exists else {}
            return {"error": signing.E_SIGNED if cur.get("status") in ("signing", "signed") else signing.E_NO_REQUEST}
        return {"ok": True, "id": rid, "signDate": date}

    if action == "build":
        if status not in ("signing", "signed"):
            return {"error": signing.E_NO_REQUEST}
        if req.get("part"):  # built once, never again
            return {"ok": True, "part": req["part"], "status": status}
        sig = bucket.blob(req["sigPath"]).download_as_bytes()
        details = req.get("clientDetails") or req.get("details") or {}
        data, name = _pdf(req, bucket, details, signature=sig, date=req.get("signDate"))
        path = f"tenants/{tenant}/clients/{req['clientId']}/documents/{int(time.time() * 1000)}-contract-{re.sub(r'[/#?]', '_', name)}"
        bucket.blob(path).upload_from_string(data, content_type="application/pdf")
        part = {"path": path, "name": name, "size": len(data)}
        # kept only while no other build has kept one: built once — a second build at the same moment removes its own file
        if not _move(db, ref, lambda x: x.get("status") in ("signing", "signed") and not x.get("part"), {"part": part, "status": "signed"}):
            snap = ref.get()
            kept = (snap.to_dict() or {}) if snap.exists else {}
            if path != (kept.get("part") or {}).get("path"):  # the same millisecond: the same file name, the same contract
                bucket.blob(path).delete()
            if not kept.get("part"):
                return {"error": signing.E_NO_REQUEST}
            return {"ok": True, "part": kept["part"], "status": kept.get("status")}
        return {"ok": True, "part": part, "status": "signed"}

    return {"error": "Unknown action"}


def run(db, bucket, claims, body, tenant, server_time=None):
    """A manager's action on client contracts (signing.run passes the firm: the caller's own, a super-admin's the one it views)."""
    action = str(body.get("action") or "")
    role, rt = claims.get("role"), signing.rights_of(claims)
    col = _col(db, tenant)
    sees_clients = role in ADMIN_ROLES or (role in ("staff", "hr") and "clients" in rt)

    if action == "clientList":
        if not sees_clients:
            return {"error": E_NO_CLIENTS}
        cid = body.get("clientId")
        rows = [_summary(d.id, d.to_dict() or {}) for d in col.stream() if not cid or (d.to_dict() or {}).get("clientId") == cid]
        rows.sort(key=lambda r: str(r.get("sentAt") or ""), reverse=True)
        return {"ok": True, "requests": rows[:300], "canFirmSign": seal_mod.may_firm_sign(claims),
                "canSeeBilling": signing.may_see_billing(claims)}

    if action == "clientApplied":
        if not sees_clients:
            return {"error": E_NO_CLIENTS}
        rid = str(body.get("id") or "")
        snap = col.document(rid).get() if rid else None
        if not snap or not snap.exists:
            return {"error": signing.E_NO_REQUEST}
        col.document(rid).update({"appliedAt": signing._now_iso()})
        return {"ok": True}

    if not seal_mod.may_firm_sign(claims):
        return {"error": E_NO_RIGHT}
    if not sees_clients:  # firmSign alone (a template for the seal only) never reaches a client
        return {"error": E_NO_CLIENTS}

    if action == "clientSend":
        return _send(db, bucket, claims, body, tenant)

    rid = str(body.get("id") or "")
    snap = col.document(rid).get() if rid else None
    req = snap.to_dict() if snap and snap.exists else None
    if not req:
        return {"error": signing.E_NO_REQUEST}

    if action == "clientWithdraw":
        was = _move(db, col.document(rid), lambda x: x.get("status") == "sent", {"status": "withdrawn"})
        if was:
            _drop_token(db, was)
        return {"ok": True}

    if action in ("clientView", "clientSign", "clientBuild"):
        return _documents(db, bucket, tenant, rid, req, dict(body, action=action[6:].lower()), server_time)

    return {"error": "Unknown action"}


def _send(db, bucket, claims, body, tenant):
    cid = str(body.get("clientId") or "")
    if not cid or "/" in cid:
        return {"error": E_NO_CLIENT}
    tref = db.collection("tenants").document(tenant)
    csnap = tref.collection("clients").document(cid).get()
    client = csnap.to_dict() if csnap.exists else None
    if client is None:
        return {"error": E_NO_CLIENT}
    sign_date = signing._date(body.get("signDate"))
    if body.get("signDate") and not sign_date:
        return {"error": "Not a date: " + str(body.get("signDate"))[:20]}
    values = _clean_values(body.get("values"))
    # The whole send is refused: nothing reaches the client.
    if sign_date and not signing.may_set_date(claims):
        return {"error": signing.E_DATE}
    if any(values.get(m) for m in contracts.CLIENT_BILL_MARKS) and not signing.may_see_billing(claims):
        return {"error": E_BILLING}
    tid = str(body.get("templateId") or "")
    tsnap = tref.collection("contractTemplates").document(tid).get() if tid and "/" not in tid else None
    tpl = tsnap.to_dict() if tsnap and tsnap.exists else None
    if not tpl or tpl.get("deletedAt") or (tpl.get("clientId") and tpl.get("clientId") != cid):
        return {"error": signing.E_NO_TEMPLATE}
    if contracts.kind_of(tpl) != "client":
        return {"error": E_WORKER_TEMPLATE}
    rid = uuid.uuid4().hex[:20]
    prefix = f"tenants/{tenant}/clients/{cid}/sign/{rid}/"
    frozen = prefix + "contract-template.pdf"
    bucket.blob(frozen).upload_from_string(bucket.blob(tpl["fileId"]).download_as_bytes(), content_type="application/pdf")
    # the firm's signature and stamp as they are now: a later change never changes this send
    seal = dict(seal_mod.freeze(db, bucket, tenant, prefix), everyPage=bool(tpl.get("sealEveryPage")))
    # a waiting send of the same client is replaced, and its link stops working
    col = _col(db, tenant)
    for r in col.stream():
        x = r.to_dict() or {}
        if x.get("clientId") == cid and x.get("status") == "sent":
            # only while it still waits: a signature made at this moment is never overwritten
            was = _move(db, col.document(r.id), lambda y: y.get("status") == "sent", {"status": "replaced"})
            if was:
                _drop_token(db, was)
    remote = body.get("way") != "person"
    token = secrets.token_urlsafe(32) if remote else None
    now = _now()
    expires = _iso(now + datetime.timedelta(days=LINK_DAYS))
    details = {k: str(client.get(k) or "").strip()[:DETAIL_MAX] for k in DETAILS}
    details.update(clean_details(body.get("details")))
    req = {"clientId": cid, "status": "sent", "way": "remote" if remote else "person",
           "templateId": tsnap.id, "templateName": tpl.get("name") or "", "templateVersion": int(tpl.get("version") or 1),
           "templatePath": frozen, "placed": tpl.get("placed") or [], "values": values, "details": details, "seal": seal,
           "signDate": sign_date or None, "dateFixed": bool(sign_date), "tokenHash": token_hash(token) if token else None,
           "expiresAt": expires, "sentAt": _iso(now), "sentBy": claims.get("uid", "")}
    col.document(rid).set(req)
    out = {"ok": True, "id": rid, "request": _summary(rid, req)}
    if token:
        _tokens(db).document(req["tokenHash"]).set({"tenantId": tenant, "requestId": rid, "expiresAt": expires})
        out["link"] = link_origin(body.get("origin")) + "/client-sign?t=" + token
    return out


def _by_token(db, token):
    """(tenant, request id, request) for a link's token that still works, else (None, None, None): the request must be this
    token's (its hash), waiting and not past its 30 days, or signed and not past 30 days more."""
    token = str(token or "").strip()
    if not token or len(token) > 200:
        return None, None, None
    h = token_hash(token)
    snap = _tokens(db).document(h).get()
    idx = snap.to_dict() if snap.exists else None
    if not idx or not idx.get("tenantId") or not idx.get("requestId"):
        return None, None, None
    tenant, rid = str(idx["tenantId"]), str(idx["requestId"])
    rs = _col(db, tenant).document(rid).get()
    req = rs.to_dict() if rs.exists else None
    if not req or req.get("tokenHash") != h:
        return None, None, None
    exp = _parse(req.get("expiresAt"))
    status = req.get("status")
    if exp is None:
        return None, None, None
    if status in ("signed", "signing"):  # signing: signed, its PDF not built yet — the page builds it when opened
        exp = exp + datetime.timedelta(days=KEEP_DAYS)
    elif status != "sent":
        return None, None, None
    if _now() > exp:
        return None, None, None
    return tenant, rid, req


def run_public(db, bucket, body, server_time=None):
    """The client's sign page: every call carries the link's token (`clientToken`) and reaches only its own request."""
    tenant, rid, req = _by_token(db, body.get("clientToken"))
    if not tenant:
        return {"error": E_LINK}
    action = str(body.get("action") or "")
    if action == "mine":
        firm = (req.get("values") or {}).get("company") or ""
        if not firm:
            t = db.collection("tenants").document(tenant).get()
            firm = ((t.to_dict() or {}).get("companyName") or "") if t.exists else ""
        signed = req.get("status") in ("signing", "signed")
        return {"ok": True, "request": {"status": req.get("status"), "templateName": req.get("templateName") or "", "firm": firm,
                                        "details": (req.get("clientDetails") if signed else None) or req.get("details") or {},
                                        "signDate": req.get("signDate"), "dateFixed": bool(req.get("dateFixed"))}}
    if action not in ("view", "sign", "build"):
        return {"error": "Unknown action"}
    return _documents(db, bucket, tenant, rid, req, body, server_time)
