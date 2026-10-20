"""A worker moves to another firm — a copy, with the worker's signed consent (docs/contracts.md →
Moving to another firm, D6).

1. The new firm's admin asks with the worker's ID or passport number (`ask`). The answer is
   always "Request sent": the new firm learns nothing about the worker until the worker
   approves, and the old firm sees nothing of the new firm.
2. The worker's own page (the old firm's punch link) shows "[new firm] asks to take your
   details" with the new firm's Form 101 and contract filled with the worker's data and the
   new firm's details (`view`), one signature with the date — the consent and the signing
   (`sign`), or Decline (`decline`). A request not answered expires after 14 days.
3. Once both signed PDFs are built (`build`, two calls at once), the server copies (`_copy`):
   a new worker record in the new firm with the personal and family fields only, the scanned
   pages and the signature, the signed Form 101 and contract; nothing else (no hours, pay,
   rates, clients, supplier, HR, punch-link token, notes). The old firm keeps the worker as
   they were, set Inactive with "Moved to another firm" (without the new firm's name). Each
   copy is logged in transferLog.

transferRequests/<id> (top level — it joins two firms; no client rule opens it): fromTenant,
fromWorker, toTenant, toName, status (asked → signing → done; declined, expired, replaced),
askedAt, askedBy, expiresAt, newWorkerId, signDate, signedAt, sigPath, parts.
"""

import base64
import datetime
import re
import time
import uuid

import contracts
import signing

EXPIRE_DAYS = 14
PERSONAL = ("docGiven", "docSurname", "docId", "passportNo", "israeliId", "docType", "docExpiry", "docDob", "docSex",
            "maritalStatus", "healthFund", "phone", "address", "houseNumber", "city", "incomeType", "otherIncomeType",
            "docChildren", "spouseSurname", "spouseGiven", "spouseId", "spouseDob", "spouseIncome")
HE_SEX = {"M": "זכר", "F": "נקבה"}
HE_MARITAL = {"marital_single": "רווק/ה", "marital_married": "נשוי/אה", "marital_divorced": "גרוש/ה", "marital_widowed": "אלמן/ה"}
HE_FUND = {"Clalit": "כללית", "Maccabi": "מכבי", "Meuhedet": "מאוחדת", "Leumit": "לאומית"}
E_SENT = "Request sent"


def doc_key(v):
    """The same standard form as docKeys (functions-auth core.py doc_keys)."""
    return "".join(c for c in str(v or "").upper() if c.isalnum())


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _dmy(s):
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(s or ""))
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else str(s or "")


def form101_payload(w, profile, sign_date, start):
    """Form 101's values for the new firm (src/manager/logic/form101.ts form101Payload, for a copy)."""
    is_id = w.get("docType") != "passport"
    p = {
        "isId": is_id, "isIsraeli": is_id, "surname": w.get("docSurname") or "", "given": w.get("docGiven") or "",
        "dob": w.get("docDob") or "", "sex": w.get("docSex") or "", "no": w.get("docId") or "", "signDate": sign_date,
        "workerPhone": w.get("phone") or "", "incomeType": w.get("incomeType"), "otherIncomeType": w.get("otherIncomeType"),
        "employer": {k: profile.get(k) for k in ("companyName", "street", "streetNumber", "city", "phone", "deductionsFileNumber")},
        "address": ((w.get("address") or "") + " " + (w.get("houseNumber") or "")).strip(), "city": w.get("city") or "",
        "marital": w.get("maritalStatus") or "", "workStart": start, "healthFund": w.get("healthFund") or "",
        "children": w.get("docChildren") or [],
    }
    if any(w.get(k) for k in ("spouseSurname", "spouseGiven", "spouseId", "spouseDob", "spouseIncome")):
        p["spouse"] = {"surname": w.get("spouseSurname") or "", "given": w.get("spouseGiven") or "", "idNo": w.get("spouseId") or "",
                       "dob": w.get("spouseDob") or "", "income": w.get("spouseIncome") or ""}
    return p


def contract_values(w, profile, start):
    """The contract's marks for the new firm: the worker's own data and the new firm's details (src/manager/logic/
    contract-values.ts contractValues); the work and pay marks stay empty — nothing of the old firm's is copied."""
    given, surname = (w.get("docGiven") or "").strip(), (w.get("docSurname") or "").strip()
    street = ((w.get("address") or "") + " " + (w.get("houseNumber") or "")).strip()
    firm_addr = ", ".join(x for x in [((profile.get("street") or "") + " " + (profile.get("streetNumber") or "")).strip(), profile.get("city")] if x)
    return {
        "given": given, "surname": surname, "full_name": " ".join(x for x in (given, surname) if x), "id": w.get("docId") or "",
        "id_type": "דרכון" if w.get("docType") == "passport" else "ת.ז.", "id_expiry": _dmy(w.get("docExpiry")), "dob": _dmy(w.get("docDob")),
        "sex": HE_SEX.get(w.get("docSex"), ""), "marital": HE_MARITAL.get(w.get("maritalStatus"), ""), "phone": w.get("phone") or "",
        "address": street, "city": w.get("city") or "", "full_address": ", ".join(x for x in (street, w.get("city")) if x),
        "health_fund": HE_FUND.get(w.get("healthFund"), ""), "start_date": _dmy(start),
        "company": profile.get("companyName") or "", "company_address": firm_addr, "company_phone": profile.get("phone") or "",
        "deductions_file": profile.get("deductionsFileNumber") or "",
    }


def _template(db, tenant):
    """The new firm's contract: its default template (the one without a category first), else its first."""
    rows = [(d.id, d.to_dict() or {}) for d in db.collection("tenants").document(tenant).collection("contractTemplates").stream()]
    rows = [r for r in rows if not r[1].get("workerId") and not r[1].get("deletedAt")]
    rows.sort(key=lambda r: (not r[1].get("isDefault"), bool(r[1].get("category")), str(r[1].get("name") or "")))
    return rows[0] if rows else (None, None)


def ask(db, claims, tenant, body):
    """The new firm's admin asks for a worker by their ID or passport number. Always "Request sent"."""
    if claims.get("role") not in ("superadmin", "tenant_admin"):
        return {"error": "Only the firm's admin adds a worker from another firm"}
    key = doc_key(body.get("docNumber"))
    if len(key) < 5:
        return {"error": "Type the worker's ID or passport number"}
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter
        hits = list(db.collection_group("workers").where(filter=FieldFilter("docKeys", "array_contains", key)).limit(10).stream())
    except Exception:
        hits = []
    to_name = (db.collection("tenants").document(tenant).get().to_dict() or {}).get("companyName") or ""
    now = _now()
    col = db.collection("transferRequests")
    for h in hits:
        from_t = h.reference.parent.parent.id
        if from_t == tenant or (h.to_dict() or {}).get("status") == "fired":
            continue
        for d in col.stream():
            x = d.to_dict() or {}
            if x.get("fromWorker") == h.id and x.get("fromTenant") == from_t and x.get("toTenant") == tenant and x.get("status") == "asked":
                col.document(d.id).update({"status": "replaced"})
        col.document(uuid.uuid4().hex[:20]).set({
            "fromTenant": from_t, "fromWorker": h.id, "toTenant": tenant, "toName": to_name, "status": "asked",
            "askedAt": _iso(now), "askedBy": claims.get("uid", ""), "expiresAt": _iso(now + datetime.timedelta(days=EXPIRE_DAYS))})
    return {"ok": True, "message": E_SENT}


def current(db, tenant, wid):
    """The worker's open request from another firm: (id, dict) or (None, None); an old one is marked expired."""
    now = _iso(_now())
    best = (None, None)
    for d in db.collection("transferRequests").stream():
        x = d.to_dict() or {}
        if x.get("fromTenant") != tenant or x.get("fromWorker") != wid or x.get("status") not in ("asked", "signing"):
            continue
        if x.get("status") == "asked" and str(x.get("expiresAt") or "") < now:
            db.collection("transferRequests").document(d.id).update({"status": "expired"})
            continue
        if best[1] is None or str(x.get("askedAt")) > str(best[1].get("askedAt")):
            best = (d.id, x)
    return best


def _pdf(db, bucket, req, worker, which, build101, signature=None):
    profile = db.collection("tenants").document(req["toTenant"]).get().to_dict() or {}
    date = req.get("signDate") or signing.today_il()
    start = req.get("start") or datetime.date.today().isoformat()
    if which == "contract":
        tid, tpl = _template(db, req["toTenant"])
        if not tpl:
            return None, None
        values = dict(contract_values(worker, profile, start), sign_date=date, today=signing.today_il())
        data = contracts.fill(bucket.blob(tpl["fileId"]).download_as_bytes(), values, tpl.get("placed"), signature)
        return data, (tpl.get("name") or "Contract") + " - " + (worker.get("name") or "").strip() + ".pdf"
    p = dict(form101_payload(worker, profile, date, start), extraPages=signing._stored_pages(bucket, worker))
    if signature:
        p["signaturePngBase64"] = base64.b64encode(signature).decode()
    data, name, _ = build101(p)
    return data, name


def _download_url(bucket, blob, path):
    """A Firebase Storage download URL for a file the server wrote (as getDownloadURL gives)."""
    from urllib.parse import quote
    tok = uuid.uuid4().hex
    blob.metadata = dict(blob.metadata or {}, firebaseStorageDownloadTokens=tok)
    try:
        blob.patch()
    except Exception:
        pass
    return f"https://firebasestorage.googleapis.com/v0/b/{getattr(bucket, 'name', '')}/o/{quote(path, safe='')}?alt=media&token={tok}"


def run_worker(db, bucket, tenant, wid, worker, body, build101, server_time=None):
    """The worker's own page: mine / view / sign / build / decline for a request of another firm."""
    action = str(body.get("action") or "")
    rid, req = current(db, tenant, wid)
    if action == "mine":
        return {"ok": True, "transfer": {"id": rid, "firm": req.get("toName"), "status": req.get("status")} if rid else None}
    if not rid:
        return {"error": signing.E_NO_REQUEST}
    ref = db.collection("transferRequests").document(rid)
    which = str(body.get("which") or "")
    if action == "decline":
        ref.update({"status": "declined", "answeredAt": _iso(_now())})
        return {"ok": True}
    if action == "view":
        if which not in signing.WHICH:
            return {"error": "Which document?"}
        data, name = _pdf(db, bucket, req, worker, which, build101)
        if data is None:
            return {"error": "The new firm has no contract template yet"}
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name, "signDate": req.get("signDate") or signing.today_il(), "signed": False}
    if action == "sign":
        if req.get("status") != "asked":
            return {"error": signing.E_SIGNED}
        sig = signing._sig_bytes(body.get("signaturePng"))
        if not sig:
            return {"error": signing.E_SIG}
        if _template(db, req["toTenant"])[1] is None:
            return {"error": "The new firm has no contract template yet"}
        new_id = "w" + uuid.uuid4().hex[:12]
        path = f"tenants/{req['toTenant']}/workers/{new_id}/signature/{int(time.time() * 1000)}-signature.png"
        bucket.blob(path).upload_from_string(sig, content_type="image/png")
        ref.update({"status": "signing", "newWorkerId": new_id, "sigPath": path, "signDate": signing.today_il(),
                    "start": datetime.date.today().isoformat(),
                    "signedAt": server_time if server_time is not None else _iso(_now())})
        return {"ok": True}
    if action == "build":
        if which not in signing.WHICH or req.get("status") != "signing":
            return {"error": signing.E_NO_REQUEST}
        part = (req.get("parts") or {}).get(which)
        if not part:
            data, name = _pdf(db, bucket, req, worker, which, build101, signature=bucket.blob(req["sigPath"]).download_as_bytes())
            folder = "form101" if which == "form101" else "docs"
            path = f"tenants/{req['toTenant']}/workers/{req['newWorkerId']}/{folder}/{int(time.time() * 1000)}-{re.sub(r'[/#?]', '_', name)}"
            bucket.blob(path).upload_from_string(data, content_type="application/pdf")
            part = {"path": path, "name": name, "size": len(data)}
            ref.update({"parts." + which: part})
        cur = ref.get().to_dict() or {}
        if all(k in (cur.get("parts") or {}) for k in signing.WHICH) and cur.get("status") == "signing":
            ref.update({"status": "done", "doneAt": _iso(_now())})
            _copy(db, bucket, rid, dict(cur, status="done"), worker)
            cur["status"] = "done"
        return {"ok": True, "part": part, "status": cur.get("status")}
    return {"error": "Unknown action"}


def _copy(db, bucket, rid, req, worker):
    """The copy, only after the worker's signed approval: the new record in the new firm, the old one set Inactive."""
    to_t, new_id = req["toTenant"], req["newWorkerId"]
    rec = {k: worker[k] for k in PERSONAL if k in worker}
    rec["name"] = " ".join(x for x in ((worker.get("docGiven") or "").strip(), (worker.get("docSurname") or "").strip()) if x) or worker.get("name") or ""
    pages = []
    for p in worker.get("scanPages") or []:
        src = bucket.blob(str(p.get("fileId") or ""))
        if not p.get("fileId") or not src.exists():
            continue
        dst = f"tenants/{to_t}/workers/{new_id}/pages/{p['fileId'].rsplit('/', 1)[-1]}"
        bucket.blob(dst).upload_from_string(src.download_as_bytes(), content_type="image/jpeg")
        pages.append(dict(p, fileId=dst))
    now = _iso(_now())
    f101, ctr = req["parts"]["form101"], req["parts"]["contract"]
    rec.update({
        "id": new_id, "status": "active", "clientIds": [], "schedule": [{"type": "off", "start": None, "end": None} for _ in range(7)],
        "colorIdx": 0, "token": uuid.uuid4().hex[:8], "createdAt": now, "startDate": req.get("start"), "workStartDate": req.get("start"),
        "scanPages": pages, "sigFileId": req.get("sigPath"), "sigSavedAt": now,
        "docFileId": f101["path"], "docUrl": _download_url(bucket, bucket.blob(f101["path"]), f101["path"]), "docSavedAt": now,
        "docHasSignature": True, "signedAt": now, "signDate": req.get("signDate"), "movedFromOtherFirm": True,
        "docs": [{"id": "d" + uuid.uuid4().hex[:10], "type": "contract", "name": ctr["name"], "fileId": ctr["path"],
                  "url": _download_url(bucket, bucket.blob(ctr["path"]), ctr["path"]), "mediaType": "application/pdf",
                  "uploadedAt": now, "expiry": "", "signed": True}],
        "docKeys": [k for k in (doc_key(worker.get(f)) for f in ("docId", "passportNo", "israeliId")) if k],
        "sortIndex": 1e6 + int(time.time()) % 1000000,
    })
    db.collection("tenants").document(to_t).collection("workers").document(new_id).set(rec)
    db.collection("tenants").document(req["fromTenant"]).collection("workers").document(req["fromWorker"]).update(
        {"status": "fired", "movedToOtherFirm": True, "movedAt": now})
    db.collection("transferLog").add({"at": now, "requestId": rid, "fromTenant": req["fromTenant"], "fromWorker": req["fromWorker"],
                                      "toTenant": to_t, "newWorker": new_id, "askedBy": req.get("askedBy")})
