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

Nothing reaches a signature that cannot become a document: `view` is a strict build and `sign` builds both once more with
the signature. `sign` freezes everything the worker saw (`frozen`: the template's file copied, the values, Form 101's
values, the marks placed, the page list with hashes, the worker's personal fields, today, the signer's language and the
builder version), and every later build and the copy use only that. If a build still fails, the request stays `signing` with `buildErrors`, the worker's page retries
`build`, and Decline or the 14 days (counted from the signature) end it: the signature and the parts, which sit under a
worker that was never created, are deleted, since nothing was copied; a path stays on the request until its delete is
confirmed (`discardPending`, tried again by `current`).

The copy resumes: `copyClaimedAt` says one build is making it (a lease, COPY_LEASE_S, so a build that died is taken over;
a failure gives it back at once), `copyCreated` that the new record exists (from there Decline and expiry are closed: only
finishing is left), and the status moves to done, with `copyDone`, when it is all made. Every status moves through
moves.move, so a Decline and a Sign at the same moment cannot overwrite each other.

transferRequests/<id> (top level — it joins two firms; no client rule opens it): fromTenant,
fromWorker, toTenant, toName, status (asked → signing → done; declined, expired, replaced),
askedAt, askedBy, expiresAt, seal {signature, stamp} (the new firm's signature and stamp frozen
when it asks, under tenants/<new firm>/transfers/<id>/ — seal.py; drawn when the new firm's
contract template has its every-page tick or marks), newWorkerId, signDate, signedAt, signedAtIso, sigPath, frozen, parts,
buildErrors, copyClaimedAt, copyCreated, copyDone, discardPending.
"""

import base64
import datetime
import hashlib
import re
import time
import uuid

import builders
import contracts
from moves import move
import seal as seal_mod
import signing

EXPIRE_DAYS = 14
COPY_LEASE_S = 5 * 60  # a copy claimed longer ago than this died with its build: another may take it over
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


def doc_key_forms(key):
    """The stored keys a typed number matches (functions-auth core.py _doc_key_forms): an Israeli ID
    may be stored with or without its leading 0 ("12345678" / "012345678" — the worker window pads
    an 8-digit ID to 9), so an all-digit key also matches its forms without leading zeros and padded to 9."""
    forms = [key]
    if key.isdigit():
        bare = key.lstrip("0")
        for k in (bare, bare.zfill(9)):
            if k and k not in forms:
                forms.append(k)
    return forms


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
        # the street and the house number apart, as form101Payload sends them: a number such as "12א" prints whole
        "street": w.get("address") or "", "houseNumber": w.get("houseNumber") or "",
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


def _freeze_seal(db, bucket, tenant, rid):
    """The new firm's signature and stamp as they are when it asks (seal.py), or None when there is no bucket."""
    if bucket is None:
        return None
    return seal_mod.freeze(db, bucket, tenant, f"tenants/{tenant}/transfers/{rid}/")


def ask(db, claims, tenant, body, bucket=None):
    """The new firm's admin asks for a worker by their ID or passport number. Always "Request sent"."""
    if claims.get("role") not in ("superadmin", "tenant_admin"):
        return {"error": "Only the firm's admin adds a worker from another firm"}
    key = doc_key(body.get("docNumber"))
    if len(key) < 5:
        return {"error": "Type the worker's ID or passport number"}
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter
        hits = list(db.collection_group("workers").where(
            filter=FieldFilter("docKeys", "array_contains_any", doc_key_forms(key))).limit(10).stream())
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
        rid = uuid.uuid4().hex[:20]
        col.document(rid).set({
            "fromTenant": from_t, "fromWorker": h.id, "toTenant": tenant, "toName": to_name, "status": "asked",
            "askedAt": _iso(now), "askedBy": claims.get("uid", ""), "expiresAt": _iso(now + datetime.timedelta(days=EXPIRE_DAYS)),
            "seal": _freeze_seal(db, bucket, tenant, rid)})
    return {"ok": True, "message": E_SENT}


def _claim_active(x):
    """A build is making the copy now."""
    at = x.get("copyClaimedAt")
    return bool(at) and str(at) > _iso(_now() - datetime.timedelta(seconds=COPY_LEASE_S))


def _may_end(x):
    """A `signing` Decline or expiry may end: no copy being made, and no new record made."""
    return x.get("status") == "signing" and not x.get("copyCreated") and not _claim_active(x)


def _page_copy(req, ref):
    """Where the copy puts a frozen page."""
    return f"tenants/{req['toTenant']}/workers/{req['newWorkerId']}/pages/{ref['fileId'].rsplit('/', 1)[-1]}"


def _kept_paths(req):
    """Every file a signing that will never be copied has made."""
    frozen = req.get("frozen") or {}
    paths = [req.get("sigPath"), frozen.get("templatePath")] + [p.get("path") for p in (req.get("parts") or {}).values()]
    paths += [_page_copy(req, r) for r in frozen.get("pages") or [] if r.get("fileId")]
    return [p for p in paths if p]


def _discard(db, ref, bucket, req):
    """A signing that will never be copied: its signature and parts, under a worker that was never created, are deleted.
    The paths leave the request only once each delete is confirmed; `current` tries the rest again."""
    left = []
    for path in req.get("discardPending") or _kept_paths(req):
        try:
            b = bucket.blob(path)
            if b.exists():
                b.delete()
        except Exception:
            left.append(path)
    if left:
        ref.update({"discardPending": left})
    else:
        ref.update({"sigPath": None, "parts": {}, "frozen": None, "discardPending": None})


def _signing_over(x, now):
    """A `signing` older than EXPIRE_DAYS from its signature (one kept before that date was written: its request's own date)."""
    since = x.get("signedAtIso")
    if not since:
        return str(x.get("expiresAt") or "") < now
    return str(since) < _iso(_now() - datetime.timedelta(days=EXPIRE_DAYS))


def current(db, tenant, wid, bucket=None):
    """The worker's open request from another firm: (id, dict) or (None, None); an old one is marked expired, also a
    signing nobody finished."""
    now = _iso(_now())
    best = (None, None)
    for d in db.collection("transferRequests").stream():
        x = d.to_dict() or {}
        if x.get("fromTenant") != tenant or x.get("fromWorker") != wid:
            continue
        ref = db.collection("transferRequests").document(d.id)
        if x.get("discardPending") and bucket is not None:
            _discard(db, ref, bucket, x)
        if x.get("status") not in ("asked", "signing"):
            continue
        if x.get("status") == "asked" and str(x.get("expiresAt") or "") < now:
            db.collection("transferRequests").document(d.id).update({"status": "expired"})
            continue
        if x.get("status") == "signing" and _signing_over(x, now):
            was = move(db, ref, _may_end, {"status": "expired", "expiredWhy": "not built"})
            if was and bucket is not None:
                _discard(db, ref, bucket, was)
            if was:
                continue
        if best[1] is None or str(x.get("askedAt")) > str(best[1].get("askedAt")):
            best = (d.id, x)
    return best


def _freeze(db, bucket, req, worker, lang):
    """Everything this signature is given on (see the module's text). The template's file is still the firm's own here:
    `sign` copies it once the gate has passed."""
    from_tpl = _template(db, req["toTenant"])[1]
    profile = db.collection("tenants").document(req["toTenant"]).get().to_dict() or {}
    date, start = signing.today_il(), datetime.date.today().isoformat()
    refs = signing.read_pages(bucket, worker, strict=True)[1]
    personal = {k: worker[k] for k in PERSONAL if k in worker}
    personal["name"] = worker.get("name") or ""
    return {"today": date, "date": date, "start": start, "pages": refs, "personal": personal, "lang": lang, "builder": builders.BUILDER_VERSION if lang else "b1", "form101": form101_payload(worker, profile, date, start),
            "values": contract_values(worker, profile, start), "templatePath": from_tpl["fileId"], "placed": from_tpl.get("placed") or [],
            "everyPage": contracts.seal_every_page(from_tpl), "contractName": (from_tpl.get("name") or "Contract") + " - " + (worker.get("name") or "").strip() + ".pdf"}


def _frozen_pdf(bucket, req, which, build101, signature):
    """A document from what `sign` froze, and nothing else."""
    fz = req["frozen"]
    if which == "contract":
        values = dict(fz["values"], sign_date=fz["date"], today=fz["today"])
        frozen_seal = req.get("seal")
        seal = seal_mod.read_frozen(bucket, dict(frozen_seal, everyPage=fz["everyPage"])) if isinstance(frozen_seal, dict) else None
        return signing.fill_contract(bucket, fz["templatePath"], values, fz["placed"], signature, seal), fz["contractName"]
    p = dict(fz["form101"], extraPages=signing.frozen_pages(bucket, fz["pages"]), **signing.sheet_fields(fz.get("lang"), fz.get("builder")))
    if signature:
        p["signaturePngBase64"] = base64.b64encode(signature).decode()
    return build101(p, strict=True)


def _pdf(db, bucket, req, worker, which, build101, signature=None, strict=False, lang=None):
    if req.get("frozen"):
        return _frozen_pdf(bucket, req, which, build101, signature)
    profile = db.collection("tenants").document(req["toTenant"]).get().to_dict() or {}
    date = req.get("signDate") or signing.today_il()
    start = req.get("start") or datetime.date.today().isoformat()
    if which == "contract":
        tid, tpl = _template(db, req["toTenant"])
        if not tpl:
            return None, None
        values = dict(contract_values(worker, profile, start), sign_date=date, today=signing.today_il())
        frozen = req.get("seal")
        seal = seal_mod.read_frozen(bucket, dict(frozen, everyPage=contracts.seal_every_page(tpl))) if isinstance(frozen, dict) else None
        data = signing.fill_contract(bucket, tpl["fileId"], values, tpl.get("placed"), signature, seal)
        return data, (tpl.get("name") or "Contract") + " - " + (worker.get("name") or "").strip() + ".pdf"
    strict = strict or bool(signature)
    p = dict(form101_payload(worker, profile, date, start), extraPages=signing._stored_pages(bucket, worker, strict),
             **signing.sheet_fields(builders.sheet_lang(lang)))
    if signature:
        p["signaturePngBase64"] = base64.b64encode(signature).decode()
    return build101(p, strict=True) if strict else build101(p)


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
    rid, req = current(db, tenant, wid, bucket)
    if action == "mine":
        return {"ok": True, "transfer": {"id": rid, "firm": req.get("toName"), "status": req.get("status"), "buildError": signing.build_error(req), "stuck": signing.stuck(req)} if rid else None}
    if not rid:
        return {"error": signing.E_NO_REQUEST}
    ref = db.collection("transferRequests").document(rid)
    which = str(body.get("which") or "")
    if action == "decline":
        if move(db, ref, lambda x: x.get("status") == "asked", {"status": "declined", "answeredAt": _iso(_now())}):
            return {"ok": True}
        # the status first: from here a late build keeps nothing and no copy can be claimed; then the files
        was = move(db, ref, _may_end, {"status": "declined", "answeredAt": _iso(_now())})
        if not was:
            return {"error": signing.E_SIGNED}
        _discard(db, ref, bucket, was)
        return {"ok": True}
    if action == "view":
        if which not in signing.WHICH:
            return {"error": "Which document?"}
        try:
            data, name = _pdf(db, bucket, req, worker, which, build101, strict=True, lang=body.get("lang"))
        except Exception as e:
            return {"error": signing.problem(which, e)}
        if data is None:
            return {"error": "The new firm has no contract template yet"}
        return {"ok": True, "pdfBase64": base64.b64encode(data).decode(), "name": name, "signDate": req.get("signDate") or signing.today_il(), "signed": False}
    if action == "sign":
        if req.get("status") != "asked":
            return {"error": signing.E_SIGNED}
        sig = signing._sig_bytes(body.get("signaturePng"))
        if not sig or not signing.picture_ok(sig):
            return {"error": signing.E_SIG}
        if _template(db, req["toTenant"])[1] is None:
            return {"error": "The new firm has no contract template yet"}
        # The last gate: nothing is kept until both documents are built with this signature, from what it freezes.
        try:
            frozen = _freeze(db, bucket, req, worker, builders.sheet_lang(body.get("lang")))
        except ValueError:
            return {"error": signing.E_PAGE_DAMAGED}
        for w in signing.WHICH:
            try:
                _pdf(db, bucket, dict(req, frozen=frozen), worker, w, build101, signature=sig)
            except Exception as e:
                return {"error": signing.problem(w, e)}
        new_id = "w" + uuid.uuid4().hex[:12]
        path = f"tenants/{req['toTenant']}/workers/{new_id}/signature/{int(time.time() * 1000)}-signature.png"
        copy = seal_mod.frozen_prefix(req["toTenant"], f"tenants/{req['toTenant']}/transfers/{rid}/") + f"/contract-template-{uuid.uuid4().hex[:8]}.pdf"
        # the template's own file goes with this signature: the firm may replace or delete its template meanwhile
        bucket.blob(copy).upload_from_string(bucket.blob(frozen["templatePath"]).download_as_bytes(), content_type="application/pdf")
        bucket.blob(path).upload_from_string(sig, content_type="image/png")
        frozen["templatePath"] = copy
        # asked → signing only while it is still asked: a Decline, another device or a later state in the gate's seconds wins
        if not move(db, ref, lambda x: x.get("status") == "asked",
                    {"status": "signing", "newWorkerId": new_id, "sigPath": path, "signDate": frozen["date"], "start": frozen["start"],
                     "signedAtIso": _iso(_now()), "signedAt": server_time if server_time is not None else _iso(_now()), "frozen": frozen}):
            for loser in (path, copy):
                bucket.blob(loser).delete()
            now = ref.get().to_dict() or {}
            return {"error": signing.E_SIGNED if now.get("status") in ("signing", "done") else signing.E_NO_REQUEST}
        return {"ok": True}
    if action == "build":
        if which not in signing.WHICH or req.get("status") != "signing":
            return {"error": signing.E_NO_REQUEST}
        part = (req.get("parts") or {}).get(which)
        if not part:
            try:
                data, name = _pdf(db, bucket, req, worker, which, build101, signature=bucket.blob(req["sigPath"]).download_as_bytes())
                if data is None:  # an older request, not frozen, whose new firm has no template any more
                    raise signing.TemplateBroken("no contract template")
            except Exception as e:
                signing.problem(which, e)  # a Storage that did not answer goes up as it is: Try again finishes it
                ref.update({"buildErrors." + which: signing.E_NOT_BUILT})
                # the firm that can do something about it: the new one for its template, the worker's for the pages
                owner = req.get("toTenant") if which == "contract" else req.get("fromTenant")
                contracts.log_error(db, owner, f"A document of a worker's move could not be built ({which}, request {rid}): {e}", "transfer.build")
                return {"error": signing.E_NOT_BUILT}
            folder = "form101" if which == "form101" else "docs"
            path = f"tenants/{req['toTenant']}/workers/{req['newWorkerId']}/{folder}/{int(time.time() * 1000)}-{re.sub(r'[/#?]', '_', name)}"
            b = bucket.blob(path)
            b.upload_from_string(data, content_type="application/pdf")
            part = {"path": path, "name": name, "size": len(data)}
            if which == "form101":
                part["builder"] = (req.get("frozen") or {}).get("builder") or "b1"
            # kept only while the request is still signing: after a Decline this file is removed by the build that made it
            if not move(db, ref, lambda x: x.get("status") == "signing" and which not in (x.get("parts") or {}),
                        {"parts." + which: part, "buildErrors." + which: None}):
                kept = ref.get().to_dict() or {}
                have = (kept.get("parts") or {}).get(which)
                if not have or have.get("path") != path:
                    b.delete()
                if not have or kept.get("status") != "signing":
                    return {"error": signing.E_NO_REQUEST}
                part = have
        cur = ref.get().to_dict() or {}
        # Both parts: one build at a time makes the copy (`_claim`); a failed one is given back and tried again.
        if all(k in (cur.get("parts") or {}) for k in signing.WHICH) and cur.get("status") == "signing" and _claim(db, ref):
            try:
                _copy(db, bucket, rid, dict(cur, status="done"), worker, ref)
            except Exception as e:
                ref.update({"copyClaimedAt": None, "buildErrors.copy": signing.E_NOT_BUILT})
                contracts.log_error(db, req.get("fromTenant"), f"A worker's move could not be copied (request {rid}): {e}", "transfer.copy")
                return {"error": signing.E_NOT_BUILT}
            if move(db, ref, lambda x: x.get("status") == "signing", {"status": "done", "copyDone": True, "doneAt": _iso(_now()), "buildErrors.copy": None}):
                cur["status"] = "done"
        return {"ok": True, "part": part, "status": cur.get("status")}
    return {"error": "Unknown action"}


def _claim(db, ref):
    """The copy's turn: True for the one build that may make it now, a build that died (its lease over) taken over."""
    now = _iso(_now())
    return bool(move(db, ref, lambda x: x.get("status") == "signing" and not x.get("copyDone") and not _claim_active(x)
                     and all(k in (x.get("parts") or {}) for k in signing.WHICH), {"copyClaimedAt": now}))


def _copy(db, bucket, rid, req, worker, ref):
    """The copy, only after the worker's signed approval: the new record in the new firm, the old one set Inactive. It can
    be run again after a failure: the pages go to fixed paths, and the record, once made, is never written over."""
    to_t, new_id = req["toTenant"], req["newWorkerId"]
    fz = req.get("frozen") or {}
    who = fz.get("personal") or worker
    rec = {k: who[k] for k in PERSONAL if k in who}
    rec["name"] = " ".join(x for x in ((who.get("docGiven") or "").strip(), (who.get("docSurname") or "").strip()) if x) or who.get("name") or ""
    pages = []
    for p in (fz.get("pages") if "pages" in fz else worker.get("scanPages")) or []:
        src = bucket.blob(str(p.get("fileId") or ""))
        if not p.get("fileId") or not src.exists():
            continue
        dst = _page_copy(req, p)
        bucket.blob(dst).upload_from_string(src.download_as_bytes(), content_type="image/jpeg")
        pages.append({k: v for k, v in dict(p, fileId=dst).items() if k != "sha256"})
    now = _iso(_now())
    f101, ctr = req["parts"]["form101"], req["parts"]["contract"]
    rec.update({
        "id": new_id, "status": "active", "clientIds": [], "schedule": [{"type": "off", "start": None, "end": None} for _ in range(7)],
        "colorIdx": 0, "token": hashlib.sha256(rid.encode()).hexdigest()[:8], "createdAt": now, "startDate": req.get("start"), "workStartDate": req.get("start"),
        "scanPages": pages, "sigFileId": req.get("sigPath"), "sigSavedAt": now,
        "docFileId": f101["path"], "docUrl": _download_url(bucket, bucket.blob(f101["path"]), f101["path"]), "docSavedAt": now,
        "docHasSignature": True, "signedAt": now, "signDate": req.get("signDate"), "movedFromOtherFirm": True,
        "docs": [{"id": "d" + hashlib.sha256(rid.encode()).hexdigest()[:10], "type": "contract", "name": ctr["name"], "fileId": ctr["path"],
                  "url": _download_url(bucket, bucket.blob(ctr["path"]), ctr["path"]), "mediaType": "application/pdf",
                  "uploadedAt": now, "expiry": "", "signed": True}],
        "docKeys": [k for k in (doc_key(who.get(f)) for f in ("docId", "passportNo", "israeliId")) if k],
        "sortIndex": 1e6 + int(time.time()) % 1000000,
    })
    new = db.collection("tenants").document(to_t).collection("workers").document(new_id)
    if not new.get().exists:
        new.set(rec)
    ref.update({"copyCreated": True})
    db.collection("transferLog").document(rid).set({
        "at": now, "requestId": rid, "fromTenant": req["fromTenant"], "fromWorker": req["fromWorker"],
        "toTenant": to_t, "newWorker": new_id, "askedBy": req.get("askedBy")})
    db.collection("tenants").document(req["fromTenant"]).collection("workers").document(req["fromWorker"]).update(
        {"status": "fired", "movedToOtherFirm": True, "movedAt": now})
