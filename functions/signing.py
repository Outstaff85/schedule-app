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

Nothing reaches a signature that cannot become a document: `send` builds both documents strictly and throws the result
away (not_ready), `view` shows only a strict build, and `sign` builds them once more with the signature before keeping
it. `sign` freezes what was signed (`frozen`: today, the page list with each page's hash, the signer's language and the
builder version), and every later build uses only that: the pages never change under a signature, a rescan included. If a build still fails after the signature, the request
stays `signing` with `buildErrors`; `build` can be tried again from what was frozen, and when that cannot be built the way
out is the manager's Withdraw and a new send, which the worker views and signs again. Withdraw deletes nothing: the
signature and any part already built stay stored and on the request. Every status moves through moves.move, so a
Withdraw, a replacing send or a second signature at the same moment cannot be overwritten.

tenants/<t>/signRequests/<id>: workerId, hrId, status (sent → signing → signed; replaced,
withdrawn), frozen {today, pages, workerName, lang, builder}, buildErrors {form101, contract: text | None}, way, templateId / templateName / templateVersion / templatePath (the frozen
copy) / placed, values, form101, signDate (fixed, or None = the day of signing), seal
{signature, stamp: the firm's pictures frozen at the send (seal.py) | None, everyPage: the
template's tick} (a send made before it has none and draws no seal), sentAt, sentBy,
signedAt (server time), sigPath, parts {form101, contract: {path, name, size}}.
No client reads or writes it (firestore.rules grant nothing); a firm sees only its own.
"""

import base64
import datetime
import hashlib
import io
import json
import re
import time
import uuid

import builders
import contracts
from moves import move
import seal as seal_mod

PAY_MARKS = contracts.PAY_MARKS
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")
ADMIN_ROLES = ("superadmin", "tenant_admin")
WHICH = ("form101", "contract")
MAX_SIG = 400 * 1024
STUCK_AFTER_S = 10 * 60  # a `signing` with no error recorded counts as stuck after this: a build still running is over by then

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
E_CLIENT_TEMPLATE = "This template is for clients"
E_PAGE_DAMAGED = "A scanned page is damaged: it must be scanned again, then the documents sent again"
E_CONTRACT_BROKEN = "The contract could not be filled: check its template, then send the documents again"
E_NOT_BUILT = "The signed documents could not be built: withdraw them and send the documents again"
E_STILL_SAVING = "The documents are still being saved: try again in a few minutes"


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


def may_see_billing(claims):
    """Sees what clients pay (a client contract's billing marks): the owner and the super-admin; a staff login with
    Accounting — an HR never (it never gets Accounting). canSeeBilling in src/manager/logic/access.ts is the same rule."""
    role = claims.get("role")
    return role in ADMIN_ROLES or (role == "staff" and "accounting" in rights_of(claims))


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
        if k in contracts.MARKS and k not in ("signature", "sign_date", "today") + contracts.SEAL_MARKS:
            out[k] = re.sub(r"[\u0000-\u001f]", " ", str(v if v is not None else ""))[:300]
    return out


def _clean_form101(p):
    if not isinstance(p, dict):
        return {}
    out = {k: v for k, v in p.items() if k not in ("signaturePngBase64", "extraPages", "signDate", "taxYear", "sheetLang", "builder")}
    import json
    return out if len(json.dumps(out, default=str)) < 30000 else {}


class MissingPage(ValueError):
    """Strict: a page the worker's record lists is not in Storage, or not the page that was signed."""


class TemplateBroken(ValueError):
    """The contract template itself cannot be filled (never a Storage that did not answer)."""


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _caption(i):
    return "Document scan" if i == 0 else "Document"


def _sidecar_pages(raw):
    """The pages of an old sidecar (no kinds)."""
    d = json.loads(raw.decode("utf-8"))
    out = []
    if d.get("scanB64"):
        out.append({"b64": d["scanB64"], "mediaType": d.get("scanMediaType") or "image/jpeg", "caption": _caption(0)})
    for x in d.get("extraPages") or []:
        if x and x.get("b64"):
            out.append({"b64": x["b64"], "mediaType": x.get("mediaType") or "image/jpeg", "caption": _caption(1)})
    return out


def read_pages(bucket, worker, strict=False):
    """The worker's scanned pages for Form 101 (docs/contracts.md → Scanned pages), the ID card or passport first, each with
    its kind → (pages, what freezes them: refs). The old sidecar (no kinds) for a worker not split yet, or, strict, one
    whose listed pages are not all there; strict: a listed page with neither raises MissingPage."""
    pages = worker.get("scanPages") if isinstance(worker.get("scanPages"), list) else []
    first = [p for p in pages if p.get("primary")] + [p for p in pages if not p.get("primary")]
    out, refs, missing = [], [], False
    for p in first:
        file_id = p.get("fileId")
        b = bucket.blob(str(file_id or ""))
        if file_id and b.exists():
            data = b.download_as_bytes()
            page = {"b64": base64.b64encode(data).decode(), "mediaType": "image/jpeg", "caption": _caption(len(out))}
            if p.get("kind"):  # the builder lays the pages out by their kind (the A4 ID sheet)
                page["kind"] = p["kind"]
            out.append(page)
            refs.append({"fileId": file_id, "kind": p.get("kind"), "primary": bool(p.get("primary")), "sha256": _sha(data)})
        elif file_id:
            missing = True
    if worker.get("assetsFileId") and (not out or (strict and missing)):
        b = bucket.blob(worker["assetsFileId"])
        if b.exists():
            raw = b.download_as_bytes()
            return _sidecar_pages(raw), [{"sidecar": worker["assetsFileId"], "sha256": _sha(raw)}]
    if strict and missing:
        raise MissingPage("a listed page is not in Storage")
    return out, refs


def frozen_pages(bucket, refs):
    """The pages a signature was given on (read_pages' refs), these very files → pages; MissingPage when one is gone or changed."""
    out = []
    for r in refs:
        path = r.get("sidecar") or r.get("fileId")
        b = bucket.blob(str(path or ""))
        if not path or not b.exists():
            raise MissingPage(str(path))
        data = b.download_as_bytes()
        if _sha(data) != r.get("sha256"):
            raise MissingPage(str(path))
        if r.get("sidecar"):
            out += _sidecar_pages(data)
            continue
        page = {"b64": base64.b64encode(data).decode(), "mediaType": "image/jpeg", "caption": _caption(len(out))}
        if r.get("kind"):
            page["kind"] = r["kind"]
        out.append(page)
    return out


def _stored_pages(bucket, worker, strict=False):
    """The worker's scanned pages as they are now (read_pages)."""
    return read_pages(bucket, worker, strict)[0]


def sheet_fields(lang, builder=None):
    """What a Form 101 payload carries for the attached sheet: its language and the builder. A page that sent no language
    (open since before b2), or a signature frozen without one, stays on b1's Hebrew."""
    return {"sheetLang": lang, "builder": builder or builders.BUILDER_VERSION} if lang else {"builder": "b1"}


def fill_contract(bucket, path, values, placed, signature, seal):
    """The contract filled from a template file → bytes. What cannot be filled is TemplateBroken; the file's own read and
    a Storage that does not answer are not: they stay what they are (problem)."""
    b = bucket.blob(path)
    if not b.exists():
        raise TemplateBroken("the template's file is gone")
    tpl = b.download_as_bytes()
    try:
        return contracts.fill(tpl, values, placed, signature, seal=seal)
    except Exception as e:
        raise TemplateBroken(str(e)) from e


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


def _pdf(req, which, worker, bucket, build101, signature=None, date=None, strict=False, lang=None):
    """One of the two documents filled for this request → (bytes, file name). A document with the signature (or strict)
    is built strictly: a signature or a page that cannot be placed stops it (a ValueError), never a signed form without it."""
    date = date or req.get("signDate") or today_il()
    frozen = req.get("frozen") or {}
    if which == "contract":
        values = dict(req.get("values") or {}, sign_date=date, today=frozen.get("today") or today_il())
        data = fill_contract(bucket, req["templatePath"], values, req.get("placed"), signature, seal_mod.read_frozen(bucket, req.get("seal")))
        name = (req.get("templateName") or "Contract") + " - " + (frozen.get("workerName") or worker.get("name") or "").strip()
        return data, re.sub(r"[\\/:*?\"<>|]", " ", name).strip() + ".pdf"
    strict = strict or bool(signature)
    # after the signature only what it was given on: a rescan never changes it (an older request has no `frozen`)
    pages = frozen_pages(bucket, frozen["pages"]) if "pages" in frozen else _stored_pages(bucket, worker, strict)
    # the sheet's language: the signer's, frozen; before the signature the language it is being viewed in
    sheet = sheet_fields(frozen.get("lang"), frozen.get("builder")) if frozen else sheet_fields(builders.sheet_lang(lang))
    p = dict(req.get("form101") or {}, signDate=date, extraPages=pages, **sheet)
    if signature:
        p["signaturePngBase64"] = base64.b64encode(signature).decode()
    return build101(p, strict=True) if strict else build101(p)


def problem(which, e):
    """What a failed strict build of a document means, for the people who can act on it. A refusal is a ValueError (Form
    101's pages, signature or date; a template that cannot be filled); anything else is no judgment on the documents
    (Storage not answering): raised again, so the caller's own error says what happened."""
    if not isinstance(e, ValueError):
        raise e
    return E_PAGE_DAMAGED if which == "form101" else E_CONTRACT_BROKEN


def not_ready(req, worker, bucket, build101, signature=None):
    """A dry run of both documents, strict, thrown away → None, or the error that stops the send or the signature."""
    for which in WHICH:
        try:
            _pdf(req, which, worker, bucket, build101, signature=signature, strict=True)
        except Exception as e:
            return problem(which, e)
    return None


def picture_ok(data):
    """A PNG that decodes whole (`_sig_bytes` reads only its first bytes)."""
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
        return True
    except Exception:
        return False


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
            "signedAt", "signedAtIso", "sigPath", "parts", "appliedAt", "dateFixed", "printHash", "printPay", "printMarks")
    out = {k: x.get(k) for k in keys if k in x}
    out["buildError"] = build_error(x)
    out["stuck"] = stuck(x)
    if out.get("signedAt") is not None and not isinstance(out["signedAt"], str):
        try:
            out["signedAt"] = out["signedAt"].isoformat()
        except Exception:
            out["signedAt"] = str(out["signedAt"])
    out["id"] = rid
    return out


def build_error(x):
    """The first error of a document not built yet (`buildErrors`), or None."""
    return next((v for v in (x.get("buildErrors") or {}).values() if v), None)


def stuck(x, now=None):
    """A `signing` nobody is finishing: a build failed, or it has been going for longer than any build takes."""
    if x.get("status") != "signing":
        return False
    if build_error(x):
        return True
    try:
        at = datetime.datetime.fromisoformat(str(x.get("signedAtIso")).replace("Z", "+00:00"))
    except ValueError:
        return True
    return ((now or datetime.datetime.now(datetime.timezone.utc)) - at).total_seconds() > STUCK_AFTER_S


def _both(x):
    """Both documents are built."""
    return all(k in (x.get("parts") or {}) for k in WHICH)


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

    if action.startswith("client"):  # a client's contract (client_signing.py)
        import client_signing
        return client_signing.run(db, bucket, claims, body, tenant, server_time)

    if action == "transferAsk":  # D6: add a worker from another firm (transfer.py)
        import transfer
        return transfer.ask(db, claims, tenant, body, bucket)

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
        if contracts.kind_of(tpl) == "client":
            return {"error": E_CLIENT_TEMPLATE}
        # Both documents built now and thrown away: a damaged page is the manager's to put right, before the worker signs.
        rec = seal_mod.record(db, tenant)
        error = not_ready({"templatePath": tpl["fileId"], "templateName": tpl.get("name") or "", "values": values, "placed": tpl.get("placed") or [],
                           "form101": _clean_form101(body.get("form101")), "signDate": sign_date or None,
                           "seal": {"signature": (rec.get("signature") or {}).get("path"), "stamp": (rec.get("stamp") or {}).get("path"),
                                    "everyPage": contracts.seal_every_page(tpl)}}, worker, bucket, build101)
        if error:
            return {"error": error}
        rid = uuid.uuid4().hex[:20]
        frozen = f"tenants/{tenant}/workers/{wid}/sign/{rid}/contract-template.pdf"
        bucket.blob(frozen).upload_from_string(bucket.blob(tpl["fileId"]).download_as_bytes(), content_type="application/pdf")
        # the firm's signature and stamp as they are now: a later change never changes this send
        seal = dict(seal_mod.freeze(db, bucket, tenant, f"tenants/{tenant}/workers/{wid}/sign/{rid}/"),
                    everyPage=contracts.seal_every_page(tpl))
        prev_id, prev = _current(db, tenant, wid)
        if prev_id and prev.get("status") == "sent":
            move(db, col.document(prev_id), lambda x: x.get("status") == "sent", {"status": "replaced"})
        req = {"workerId": wid, "hrId": worker.get("hrId") or None, "status": "sent",
               "way": "person" if body.get("way") == "person" else "remote",
               "templateId": tsnap.id, "templateName": tpl.get("name") or "", "templateVersion": int(tpl.get("version") or 1),
               "templatePath": frozen, "placed": tpl.get("placed") or [], "values": values, "seal": seal,
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
            if move(db, col.document(rid), lambda x: x.get("status") == "sent", {"status": "withdrawn"}):
                return {"ok": True}
            req = col.document(rid).get().to_dict() or {}  # signed in the meantime: as below
        if req.get("status") == "signing":
            # Nothing is deleted: the signature and any part built stay stored and on this request, kept as it is.
            if move(db, col.document(rid), lambda x: stuck(x) and not _both(x),
                    {"status": "withdrawn", "withdrawnWhy": "not built", "withdrawnAt": _now_iso(), "withdrawnBy": claims.get("uid", "")}):
                return {"ok": True}
            cur = col.document(rid).get().to_dict() or {}
            if cur.get("status") == "signing" and not _both(cur):
                return {"error": E_STILL_SAVING}
            return {"error": E_SIGNED}
        return {"ok": True}

    worker = _worker(db, tenant, req["workerId"]) or {}
    return _documents(db, bucket, tenant, rid, req, worker, body, build101, server_time)


def run_worker(db, bucket, body, build101, server_time=None, finder=None):
    """The worker's own page: every call carries the punch link's token; only this worker's latest request."""
    tenant, wid, worker = (finder or find_worker)(db, body.get("token"))
    if not tenant:
        return {"error": E_LINK}
    if body.get("transfer"):  # another firm asks to take the worker's details (D6, transfer.py)
        import transfer
        return transfer.run_worker(db, bucket, tenant, wid, worker, body, build101, server_time)
    rid, req = _current(db, tenant, wid)
    action = str(body.get("action") or "")
    if action == "mine":
        if not rid:
            return {"ok": True, "request": None}
        s = _summary(rid, req)
        return {"ok": True, "request": {k: s.get(k) for k in ("id", "status", "templateName", "signDate", "dateFixed", "signedAt", "signedAtIso", "buildError", "stuck")}}
    if not rid:
        return {"error": E_NO_REQUEST}
    return _documents(db, bucket, tenant, rid, req, worker, body, build101, server_time)


def _finish(db, ref):
    """Whoever sees both parts marks it signed, never a request withdrawn or replaced meanwhile → its status now."""
    move(db, ref, lambda x: x.get("status") == "signing" and _both(x), {"status": "signed"})
    return (ref.get().to_dict() or {}).get("status")


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
        try:
            data, name = _pdf(req, which, worker, bucket, build101, strict=True, lang=body.get("lang"))
        except Exception as e:
            return {"error": problem(which, e)}
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name, "signDate": req.get("signDate") or today_il(),
                "dateFixed": bool(req.get("dateFixed")), "signed": False}

    if action == "sign":
        if req.get("status") in ("signing", "signed"):
            return {"error": E_SIGNED}
        if req.get("status") != "sent":
            return {"error": E_NO_REQUEST}
        sig = _sig_bytes(body.get("signaturePng"))
        if not sig or not picture_ok(sig):
            return {"error": E_SIG}
        # The last gate: nothing changes until both documents are built with this signature, from what it freezes.
        date = req.get("signDate") or today_il()
        try:
            refs = read_pages(bucket, worker, strict=True)[1]
        except ValueError:
            return {"error": E_PAGE_DAMAGED}
        lang = builders.sheet_lang(body.get("lang"))
        frozen = {"today": today_il(), "pages": refs, "workerName": (worker.get("name") or "").strip(), "lang": lang,
                  "builder": builders.BUILDER_VERSION if lang else "b1"}
        error = not_ready(dict(req, frozen=frozen, signDate=date), worker, bucket, build101, signature=sig)
        if error:
            return {"error": error}
        # two at once never share a file: the one that loses below removes its own
        path = f"tenants/{tenant}/workers/{req['workerId']}/signature/{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}-signature.png"
        b = bucket.blob(path)
        if req.get("hrId"):
            b.metadata = {"hrId": req["hrId"], "workerId": req["workerId"], "kind": "signature"}
        b.upload_from_string(sig, content_type="image/png")
        # sent → signing only while it is still sent: a Withdraw, a replacing send or a second signature in the gate's seconds wins
        if not move(db, ref, lambda x: x.get("status") == "sent",
                    {"status": "signing", "signedAt": server_time if server_time is not None else _now_iso(),
                     "signedAtIso": _now_iso(), "signDate": date, "sigPath": path, "frozen": frozen}):
            b.delete()
            now = ref.get()
            cur = (now.to_dict() or {}) if now.exists else {}
            return {"error": E_SIGNED if cur.get("status") in ("signing", "signed") else E_NO_REQUEST}
        return {"ok": True, "id": rid, "signDate": date}

    if action == "build":
        if which not in WHICH:
            return {"error": "Which document?"}
        if req.get("status") not in ("signing", "signed"):
            return {"error": E_NO_REQUEST}
        part = (req.get("parts") or {}).get(which)
        if part:
            return {"ok": True, "part": part, "status": _finish(db, ref)}
        sig = bucket.blob(req["sigPath"]).download_as_bytes()
        try:
            data, name = _pdf(req, which, worker, bucket, build101, signature=sig, date=req.get("signDate"))
        except Exception as e:
            problem(which, e)  # a Storage that did not answer goes up as it is, with no error kept: Try again finishes it
            ref.update({"buildErrors." + which: E_NOT_BUILT})
            contracts.log_error(db, tenant, f"A signed document could not be built ({which}, request {rid}): {e}", "signing.build")
            return {"error": E_NOT_BUILT}
        folder = "form101" if which == "form101" else "docs"
        path = f"tenants/{tenant}/workers/{req['workerId']}/{folder}/{int(time.time() * 1000)}-{re.sub(r'[/#?]', '_', name)}"
        b = bucket.blob(path)
        if req.get("hrId"):
            b.metadata = {"hrId": req["hrId"], "workerId": req["workerId"], "kind": folder}
        b.upload_from_string(data, content_type="application/pdf")
        part = {"path": path, "name": name, "size": len(data)}
        if which == "form101":  # the version that made it; the contract stays on contracts.fill until S4
            part["builder"] = (req.get("frozen") or {}).get("builder") or "b1"
        # kept only while this request is still signing and has no such part: a Withdraw or another build won removes this file
        if not move(db, ref, lambda x: x.get("status") in ("signing", "signed") and which not in (x.get("parts") or {}),
                    {"parts." + which: part, "buildErrors." + which: None}):
            kept = ref.get().to_dict() or {}
            have = (kept.get("parts") or {}).get(which)
            if not have or have.get("path") != path:
                b.delete()
            if not have or kept.get("status") not in ("signing", "signed"):
                return {"error": E_NO_REQUEST}
            part = have
        return {"ok": True, "part": part, "status": _finish(db, ref)}

    return {"error": "Unknown action"}


# ---- "Download data" (D5): the old device's call ----------------------------------------------

def bundle(db, bucket, tenant, claims, wid, own):
    """The old `bundle` {workerId} of a device that has not reloaded since `worker_docs` came (docs/documents-plan.md
    → S2; removed in S10): everything kept under the worker in one PDF, put together by the same code as `worker_docs`
    (workerdocs.py: the summary, the ID sheet, the captions, the pay rule for contracts) — Form 101 is the stored
    `docFileId`, since an old device sends no values. Answered as base64 JSON, as before."""
    import workerdocs
    try:
        worker = workerdocs.worker_of(db, tenant, dict(claims, own=own), wid)
    except workerdocs.Refused:
        return {"error": E_NO_WORKER}
    try:
        out = workerdocs.build_bundle(db, bucket, tenant, claims, wid, worker, {k: True for k in workerdocs.INCLUDE}, None,
                                      None, old_device=True)
    except workerdocs.Refused as e:
        return {"error": e.error}
    return {"ok": True, "pdfBase64": base64.b64encode(out["pdf"]).decode(), "name": out["name"], "pages": out["pages"],
            "parts": out["labels"]}
