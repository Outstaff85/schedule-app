"""One signature for Form 101 and the contract (docs/contracts.md → Signing, D3).

A manager sends a worker the documents to sign (`send`): the contract template is frozen
for this send (its file copied under the worker), with the values of its marks, Form 101's
values and the signing date — the day of signing unless a login with the right "Set the
signing date" fixed it. The worker signs in their own page (the punch link's token) or on
the manager's phone: both documents are shown filled (`view`), one signature is kept with
the server's time (`sign`), and the two signed PDFs are built at once, one call each
(`build`, which = form101 / contract) — the function keeps no state per request. They are
stored under the worker and never built again; the manager app puts them on the worker
record (`list` → the signed requests it has not taken yet, `applied`).

tenants/<t>/signRequests/<id>: workerId, hrId, status (sent → signing → signed; replaced,
withdrawn), way, templateId / templateName / templateVersion / templatePath (the frozen
copy) / placed, values, form101, signDate (fixed, or None = the day of signing), sentAt,
sentBy, signedAt (server time), sigPath, parts {form101, contract: {path, name, size}}.
No client reads or writes it (firestore.rules grant nothing); a firm sees only its own.
"""

import base64
import datetime
import re
import time
import uuid

import contracts

PAY_MARKS = contracts.PAY_MARKS
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")
ADMIN_ROLES = ("superadmin", "tenant_admin")
WHICH = ("form101", "contract")
MAX_SIG = 400 * 1024

E_NO_FIRM = "No firm"
E_NO_RIGHT = "No rights to workers"
E_DATE = "Only a login with the right \"Set the signing date\" sets the signing date — send it again without a date"
E_PAY = "This login may not see pay — the contract has pay marks; send it from a login that sees pay"
E_NO_WORKER = "Worker not found"
E_NO_TEMPLATE = "Template not found"
E_NO_REQUEST = "Nothing to sign"
E_SIGNED = "Already signed"
E_SIG = "No signature"
E_LINK = "Unknown worker link"


def today_il():
    """Today in Israel, DD/MM/YYYY."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.datetime.now(ZoneInfo("Asia/Jerusalem"))
    except Exception:
        now = datetime.datetime.utcnow() + datetime.timedelta(hours=3)
    return now.strftime("%d/%m/%Y")


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def _date(s):
    """A DD/MM/YYYY date, or '' when it is not one."""
    m = re.match(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$", str(s or ""))
    if not m:
        return ""
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    try:
        datetime.date(y, mo, d)
    except ValueError:
        return ""
    return f"{d:02d}/{mo:02d}/{y}"


def rights_of(claims):
    rt = claims.get("rt")
    return set(rt) if isinstance(rt, list) else set()


def may_see_pay(claims):
    """The owner and the super-admin; a staff login with Accounting or Edit pay; an HR with See workers' pay."""
    role, rt = claims.get("role"), rights_of(claims)
    if role in ADMIN_ROLES:
        return True
    if role == "staff":
        return "accounting" in rt or "editPay" in rt
    return role == "hr" and "seePay" in rt


def may_set_date(claims):
    return claims.get("role") in ADMIN_ROLES or "setSignDate" in rights_of(claims)


def may_edit_workers(claims):
    role, rt = claims.get("role"), rights_of(claims)
    return role in ADMIN_ROLES or (role in ("staff", "hr") and "workers" in rt and "editWorkers" in rt)


def find_worker(db, token):
    """(tenant id, worker id, worker dict) for a punch-link token, or (None, None, None)."""
    from google.cloud.firestore_v1.base_query import FieldFilter
    token = str(token or "").strip()
    if not token or len(token) > 200:
        return None, None, None
    hits = list(db.collection_group("workers").where(filter=FieldFilter("token", "==", token)).limit(2).stream())
    if len(hits) != 1:
        return None, None, None
    s = hits[0]
    return s.reference.parent.parent.id, s.id, s.to_dict() or {}


def _clean_values(values):
    out = {}
    for k, v in (values or {}).items() if isinstance(values, dict) else []:
        if k in contracts.MARKS and k not in ("signature", "sign_date", "today"):
            out[k] = re.sub(r"[\u0000-\u001f]", " ", str(v if v is not None else ""))[:300]
    return out


def _clean_form101(p):
    if not isinstance(p, dict):
        return {}
    out = {k: v for k, v in p.items() if k not in ("signaturePngBase64", "extraPages", "signDate")}
    import json
    return out if len(json.dumps(out, default=str)) < 30000 else {}


def _stored_pages(bucket, worker):
    """The worker's scanned pages for Form 101 (docs/contracts.md → Scanned pages): the ID card or
    passport first, then the others; the old sidecar for a worker not split yet."""
    pages = worker.get("scanPages") if isinstance(worker.get("scanPages"), list) else []
    out = []
    first = [p for p in pages if p.get("primary")] + [p for p in pages if not p.get("primary")]
    for i, p in enumerate(first):
        b = bucket.blob(str(p.get("fileId") or ""))
        if p.get("fileId") and b.exists():
            out.append({"b64": base64.b64encode(b.download_as_bytes()).decode(), "mediaType": "image/jpeg",
                        "caption": "Document scan" if i == 0 else "Document"})
    if not out and worker.get("assetsFileId"):
        import json
        b = bucket.blob(worker["assetsFileId"])
        if b.exists():
            d = json.loads(b.download_as_bytes().decode("utf-8"))
            if d.get("scanB64"):
                out.append({"b64": d["scanB64"], "mediaType": d.get("scanMediaType") or "image/jpeg", "caption": "Document scan"})
            for x in d.get("extraPages") or []:
                if x and x.get("b64"):
                    out.append({"b64": x["b64"], "mediaType": x.get("mediaType") or "image/jpeg", "caption": "Document"})
    return out


def _req_ref(db, tenant, rid):
    return db.collection("tenants").document(tenant).collection("signRequests").document(rid)


def _worker(db, tenant, wid):
    s = db.collection("tenants").document(tenant).collection("workers").document(str(wid or "")).get()
    return (s.to_dict() or {}) if s.exists else None


def _current(db, tenant, wid):
    """The worker's latest request that is not replaced or withdrawn: (id, dict) or (None, None)."""
    best = (None, None)
    for d in db.collection("tenants").document(tenant).collection("signRequests").stream():
        x = d.to_dict() or {}
        if x.get("workerId") != wid or x.get("status") in ("replaced", "withdrawn"):
            continue
        if best[1] is None or str(x.get("sentAt") or "") > str(best[1].get("sentAt") or ""):
            best = (d.id, x)
    return best


def _pdf(req, which, worker, bucket, build101, signature=None, date=None):
    """One of the two documents filled for this request → (bytes, file name)."""
    date = date or req.get("signDate") or today_il()
    if which == "contract":
        tpl = bucket.blob(req["templatePath"]).download_as_bytes()
        values = dict(req.get("values") or {}, sign_date=date, today=today_il())
        data = contracts.fill(tpl, values, req.get("placed"), signature)
        name = (req.get("templateName") or "Contract") + " - " + (worker.get("name") or "").strip()
        return data, re.sub(r"[\\/:*?\"<>|]", " ", name).strip() + ".pdf"
    p = dict(req.get("form101") or {}, signDate=date, extraPages=_stored_pages(bucket, worker))
    if signature:
        p["signaturePngBase64"] = base64.b64encode(signature).decode()
    data, name, _missing = build101(p)
    return data, name


def _sig_bytes(s):
    raw = str(s or "")
    raw = raw.split(",", 1)[1] if raw.startswith("data:") else raw
    try:
        b = base64.b64decode(raw)
    except Exception:
        return None
    if not b.startswith(b"\x89PNG") or len(b) > MAX_SIG:
        return None
    return b


def _summary(rid, x):
    keys = ("workerId", "hrId", "status", "way", "templateId", "templateName", "templateVersion", "signDate", "sentAt", "sentBy",
            "signedAt", "sigPath", "parts", "appliedAt", "dateFixed", "printHash", "printPay", "printMarks")
    out = {k: x.get(k) for k in keys if k in x}
    if out.get("signedAt") is not None and not isinstance(out["signedAt"], str):
        try:
            out["signedAt"] = out["signedAt"].isoformat()
        except Exception:
            out["signedAt"] = str(out["signedAt"])
    out["id"] = rid
    return out


def run(db, bucket, claims, body, build101, server_time=None):
    """A manager's action. claims: the verified token's (functions/gate.py: a manager-side login)."""
    action = str(body.get("action") or "")
    role = claims.get("role")
    if role not in MANAGER_ROLES:
        return {"error": E_NO_RIGHT}
    tenant = body.get("asTenantId") if role == "superadmin" else claims.get("tenantId")
    if not tenant or "/" in str(tenant):
        return {"error": E_NO_FIRM}
    own = role == "hr" and claims.get("own") is True
    col = db.collection("tenants").document(tenant).collection("signRequests")

    if action == "list":
        rows = []
        for d in col.stream():
            x = d.to_dict() or {}
            if own and x.get("hrId") != claims.get("uid"):
                continue
            rows.append(_summary(d.id, x))
        rows.sort(key=lambda r: str(r.get("sentAt") or ""), reverse=True)
        return {"ok": True, "requests": rows[:300]}

    if action == "bundle":
        if role in ("staff", "hr") and "workers" not in rights_of(claims):
            return {"error": E_NO_RIGHT}
        return bundle(db, bucket, tenant, claims, str(body.get("workerId") or ""), own)

    if not may_edit_workers(claims):
        return {"error": E_NO_RIGHT}

    if action == "send":
        wid = str(body.get("workerId") or "")
        worker = _worker(db, tenant, wid)
        if worker is None or (own and worker.get("hrId") != claims.get("uid")):
            return {"error": E_NO_WORKER}
        sign_date = _date(body.get("signDate"))
        if body.get("signDate") and not sign_date:
            return {"error": "Not a date: " + str(body.get("signDate"))[:20]}
        values = _clean_values(body.get("values"))
        # The whole send is refused: nothing reaches the worker.
        if sign_date and not may_set_date(claims):
            return {"error": E_DATE}
        if any(values.get(m) for m in PAY_MARKS) and not may_see_pay(claims):
            return {"error": E_PAY}
        tsnap = db.collection("tenants").document(tenant).collection("contractTemplates").document(str(body.get("templateId") or "")).get()
        tpl = tsnap.to_dict() if tsnap.exists else None
        if not tpl or tpl.get("deletedAt") or (tpl.get("workerId") and tpl.get("workerId") != wid):
            return {"error": E_NO_TEMPLATE}
        rid = uuid.uuid4().hex[:20]
        frozen = f"tenants/{tenant}/workers/{wid}/sign/{rid}/contract-template.pdf"
        bucket.blob(frozen).upload_from_string(bucket.blob(tpl["fileId"]).download_as_bytes(), content_type="application/pdf")
        prev_id, prev = _current(db, tenant, wid)
        if prev_id and prev.get("status") == "sent":
            col.document(prev_id).update({"status": "replaced"})
        req = {"workerId": wid, "hrId": worker.get("hrId") or None, "status": "sent",
               "way": "person" if body.get("way") == "person" else "remote",
               "templateId": tsnap.id, "templateName": tpl.get("name") or "", "templateVersion": int(tpl.get("version") or 1),
               "templatePath": frozen, "placed": tpl.get("placed") or [], "values": values,
               "form101": _clean_form101(body.get("form101")), "signDate": sign_date or None, "dateFixed": bool(sign_date),
               # what the documents print about the worker (the app's printHash): a later change asks for a new signature (D4)
               "printHash": str(body.get("printHash") or "")[:40], "printPay": bool(body.get("printPay")) and may_see_pay(claims),
               "printMarks": [m for m in (tpl.get("marks") or []) if m in contracts.MARKS],
               "sentAt": _now_iso(), "sentBy": claims.get("uid", "")}
        col.document(rid).set(req)
        return {"ok": True, "id": rid, "request": _summary(rid, req)}

    rid = str(body.get("id") or "")
    snap = col.document(rid).get()
    req = snap.to_dict() if snap.exists else None
    if not req or (own and req.get("hrId") != claims.get("uid")):
        return {"error": E_NO_REQUEST}

    if action == "applied":
        col.document(rid).update({"appliedAt": _now_iso()})
        return {"ok": True}

    if action == "withdraw":
        if req.get("status") == "sent":
            col.document(rid).update({"status": "withdrawn"})
        return {"ok": True}

    worker = _worker(db, tenant, req["workerId"]) or {}
    return _documents(db, bucket, tenant, rid, req, worker, body, build101, server_time)


def run_worker(db, bucket, body, build101, server_time=None, finder=None):
    """The worker's own page: every call carries the punch link's token; only this worker's latest request."""
    tenant, wid, worker = (finder or find_worker)(db, body.get("token"))
    if not tenant:
        return {"error": E_LINK}
    rid, req = _current(db, tenant, wid)
    action = str(body.get("action") or "")
    if action == "mine":
        if not rid:
            return {"ok": True, "request": None}
        s = _summary(rid, req)
        return {"ok": True, "request": {k: s.get(k) for k in ("id", "status", "templateName", "signDate", "dateFixed", "signedAt")}}
    if not rid:
        return {"error": E_NO_REQUEST}
    return _documents(db, bucket, tenant, rid, req, worker, body, build101, server_time)


def _documents(db, bucket, tenant, rid, req, worker, body, build101, server_time):
    """view / sign / build — the same for the worker's page and the manager's phone."""
    action = str(body.get("action") or "")
    ref = _req_ref(db, tenant, rid)
    which = str(body.get("which") or "")

    if action == "view":
        if which not in WHICH:
            return {"error": "Which document?"}
        part = (req.get("parts") or {}).get(which)
        if req.get("status") == "signed" and part:
            data = bucket.blob(part["path"]).download_as_bytes()
            return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": part.get("name"), "signed": True}
        if req.get("status") != "sent":
            return {"error": E_NO_REQUEST}
        data, name = _pdf(req, which, worker, bucket, build101)
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name, "signDate": req.get("signDate") or today_il(),
                "dateFixed": bool(req.get("dateFixed")), "signed": False}

    if action == "sign":
        if req.get("status") in ("signing", "signed"):
            return {"error": E_SIGNED}
        if req.get("status") != "sent":
            return {"error": E_NO_REQUEST}
        sig = _sig_bytes(body.get("signaturePng"))
        if not sig:
            return {"error": E_SIG}
        path = f"tenants/{tenant}/workers/{req['workerId']}/signature/{int(time.time() * 1000)}-signature.png"
        b = bucket.blob(path)
        if req.get("hrId"):
            b.metadata = {"hrId": req["hrId"], "workerId": req["workerId"], "kind": "signature"}
        b.upload_from_string(sig, content_type="image/png")
        date = req.get("signDate") or today_il()
        ref.update({"status": "signing", "signedAt": server_time if server_time is not None else _now_iso(),
                    "signedAtIso": _now_iso(), "signDate": date, "sigPath": path})
        return {"ok": True, "id": rid, "signDate": date}

    if action == "build":
        if which not in WHICH:
            return {"error": "Which document?"}
        if req.get("status") not in ("signing", "signed"):
            return {"error": E_NO_REQUEST}
        part = (req.get("parts") or {}).get(which)
        if part:
            return {"ok": True, "part": part, "status": req.get("status")}
        sig = bucket.blob(req["sigPath"]).download_as_bytes()
        data, name = _pdf(req, which, worker, bucket, build101, signature=sig, date=req.get("signDate"))
        folder = "form101" if which == "form101" else "docs"
        path = f"tenants/{tenant}/workers/{req['workerId']}/{folder}/{int(time.time() * 1000)}-{re.sub(r'[/#?]', '_', name)}"
        b = bucket.blob(path)
        if req.get("hrId"):
            b.metadata = {"hrId": req["hrId"], "workerId": req["workerId"], "kind": folder}
        b.upload_from_string(data, content_type="application/pdf")
        part = {"path": path, "name": name, "size": len(data)}
        ref.update({"parts." + which: part})
        # The other build may finish at the same moment: whoever sees both parts marks it signed.
        cur = ref.get().to_dict() or {}
        parts = cur.get("parts") or {}
        if all(k in parts for k in WHICH) and cur.get("status") != "signed":
            ref.update({"status": "signed"})
            cur["status"] = "signed"
        return {"ok": True, "part": part, "status": cur.get("status")}

    return {"error": "Unknown action"}


# ---- "Download data" (D5): one PDF of everything kept under the worker -----------------------

HE_DOC_TYPES = {"contract": "חוזה", "visa": "ויזה", "work_permit": "היתר עבודה", "other": "מסמך"}
HE_KINDS = {"id_front": "תעודת זהות", "id_back": "תעודת זהות (גב)", "passport": "דרכון", "sefach": "ספח", "other": "מסמך"}


def _dmy(s):
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(s or ""))
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else str(s or "")


def _summary_page(doc, rows, listing, title):
    """The first page: the worker's data and the list of the documents that follow — Hebrew labels, right to left."""
    import pymupdf
    from bidi.algorithm import get_display
    page = doc.new_page(width=595, height=842)
    font_path = str(contracts._font())
    page.insert_font(fontfile=font_path, fontname="Heebo")
    font = pymupdf.Font(fontfile=font_path)
    right, y = 555, 70

    def line(text, size=11, x_right=right):
        nonlocal y
        disp = get_display(str(text))
        page.insert_text((x_right - font.text_length(disp, fontsize=size), y), disp, fontname="Heebo", fontsize=size)
        y += size + 9

    line(title, 16)
    y += 6
    for label, value in rows:
        if value:
            line(label + ": " + str(value))
    y += 8
    line("המסמכים בקובץ:", 12)
    for i, name in enumerate(listing, 1):
        line(f"{i}. {name}", 11, right - 12)


def _image_page(doc, data):
    import pymupdf
    page = doc.new_page(width=595, height=842)
    try:
        page.insert_image(pymupdf.Rect(30, 30, 565, 812), stream=data, keep_proportion=True)
    except Exception:
        page.insert_text((40, 60), "?")


def bundle(db, bucket, tenant, claims, wid, own):
    """The worker's data as one PDF, put together now and not kept: a summary, Form 101, the
    contract, the ID card or passport, the ספח, the other documents (docs/contracts.md → Download data)."""
    import pymupdf
    worker = _worker(db, tenant, wid)
    if worker is None or (own and worker.get("hrId") != claims.get("uid")):
        return {"error": E_NO_WORKER}
    t = db.collection("tenants").document(tenant)

    def names(coll, ids):
        out = []
        for i in ids:
            s = t.collection(coll).document(str(i)).get()
            if s.exists:
                out.append((s.to_dict() or {}).get("name") or "")
        return ", ".join(x for x in out if x)

    def blob(path):
        b = bucket.blob(str(path or ""))
        return b.download_as_bytes() if path and b.exists() else None

    parts = []  # (label, kind, bytes): kind pdf / image
    f101 = blob(worker.get("docFileId"))
    if f101:
        parts.append(("טופס 101", "pdf", f101))
    docs = worker.get("docs") if isinstance(worker.get("docs"), list) else []
    contracts_ = sorted([d for d in docs if d.get("type") == "contract"], key=lambda d: (not d.get("signed"), str(d.get("uploadedAt") or "")))
    for d in contracts_[:1]:
        data = blob(d.get("fileId"))
        if data:
            parts.append(("חוזה" + (" (חתום)" if d.get("signed") else ""), "pdf" if data[:4] == b"%PDF" else "image", data))
    pages = worker.get("scanPages") if isinstance(worker.get("scanPages"), list) else []
    for kinds in (("id_front", "id_back", "passport"), ("sefach",), ("other",)):
        for p in pages:
            if p.get("kind") in kinds:
                data = blob(p.get("fileId"))
                if data:
                    parts.append((HE_KINDS.get(p.get("kind"), "מסמך"), "image", data))
        if kinds == ("sefach",):
            for d in [d for d in docs if d.get("type") != "contract"] + contracts_[1:]:
                data = blob(d.get("fileId"))
                if data:
                    parts.append((HE_DOC_TYPES.get(d.get("type"), "מסמך"), "pdf" if data[:4] == b"%PDF" else "image", data))
    passport = worker.get("docType") == "passport"
    sign_date = worker.get("signDate") or ""
    rows = [
        ("שם פרטי", worker.get("docGiven")), ("שם משפחה", worker.get("docSurname")),
        ("מספר דרכון" if passport else "מספר זהות", worker.get("docId") or worker.get("passportNo") or worker.get("israeliId")),
        ("תוקף", worker.get("docExpiry")), ("תאריך לידה", worker.get("docDob")), ("טלפון", worker.get("phone")),
        ("כתובת", ", ".join(x for x in [" ".join(x for x in [worker.get("address"), worker.get("houseNumber")] if x), worker.get("city")] if x)),
        ("תאריך תחילת עבודה", _dmy(worker.get("startDate") or worker.get("workStartDate"))),
        ("לקוח / אתר", names("clients", worker.get("clientIds") or [])),
        ("ספק", names("suppliers", [worker["supplierId"]]) if worker.get("supplierId") else ""),
        ("תאריך החתימה", sign_date),
    ]
    out = pymupdf.open()
    _summary_page(out, rows, [p[0] for p in parts], (worker.get("name") or "").strip() or "עובד")
    for _label, kind, data in parts:
        if kind == "pdf":
            try:
                out.insert_pdf(pymupdf.open(stream=data, filetype="pdf"))
                continue
            except Exception:
                pass
        _image_page(out, data)
    data = out.tobytes(garbage=4, deflate=True)
    name = re.sub(r"[\\/:*?\"<>|]", " ", (worker.get("name") or "worker").strip()) + " - data.pdf"
    return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name, "pages": out.page_count, "parts": [p[0] for p in parts]}
