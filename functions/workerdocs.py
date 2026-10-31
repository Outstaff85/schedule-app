"""The worker's documents built on request (docs/documents-plan.md → S2; docs/workers.md → Download data):
the `worker_docs` function's actions, and the old `signing.bundle` (kept for a device that has not reloaded).

  bundle  {workerId, include: {form101, contract, scans, docs}, form101}  — one PDF, put together now, never stored:
          1. the summary page, always first (no pay);
          2. Form 101: a legacy signed worker's stored signed copy, whole; else a preview built from the values the
             app sends (`form101Payload`, src/manager/logic/form101.ts), the stored pages and the firm's block in
             those values — without its own pages when `scans` is picked too, so the photos appear once;
          3. the contract, the signed one first (pay rule below);
          4. the scans: one A4 sheet with the ID card (front and back) or the passport and the ספח, then each other
             page (idsheet.py) — left out when the stored signed Form 101 is in the bundle (it holds them already);
          5. the other documents (`docs[]`: visa, work permit, other, an older contract).
  form101 {workerId, form101}  — the preview alone, with its pages.
Both take `lang`, the language picked in the app: it sets the words of the attached sheet (idsheet.py) and nothing else;
the summary page, the two form pages and the other documents' captions stay Hebrew. None sent: English.

Who: a manager-side login (functions/gate.py) of the firm with the Workers right (the owner always; a super-admin
in the firm it views, `asTenantId`); an own-workers HR only its own workers. A supplier, a client or a worker's
punch link never (the gate refuses them). Every Storage path read must lie under tenants/<t>/workers/<w>/; another
is not read (counted as dropped). A contract may hold pay unless shown otherwise: the sign request whose contract
part is that file says whether it printed pay (`printPay`); none found (a legacy entry, an uploaded or scanned
contract) counts as holding pay — either way it needs a login that sees pay (`signing.may_see_pay`), else it is
left out (`withheld`).

A preview never carries a signing's signature: only a signature captured from a scan, for a worker with no signed
set, and only when no sign request kept it. Every preview page carries the visible mark PREVIEW_MARK, and no signing
date is filled in."""

import base64
import concurrent.futures
import re
from urllib.parse import quote

import pathlib

import idsheet

FONT = pathlib.Path(__file__).parent / "assets" / "heebo-hebrew.ttf"

MAX_BYTES = 25 * 1024 * 1024
INCLUDE = ("form101", "contract", "scans", "docs")
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")
PREVIEW_MARK = "טיוטה — לא נחתם"
HE_DOC_TYPES = {"contract": "חוזה", "visa": "ויזה", "work_permit": "היתר עבודה", "other": "מסמך"}
HE_KINDS = idsheet.HE_KINDS

E_NO_FIRM = "No firm"
E_NO_RIGHT = "No rights to workers"
E_NO_WORKER = "Worker not found"
E_NO_FORM101 = "Form 101's values are missing — reload the app"
E_TOO_BIG = "Too large to put together (over 25 MB) — pick fewer parts"
E_ACTION = "Unknown action"
# the headers a browser may read from the answer (CORS)
EXPOSE = "X-Pages, X-Parts, X-Dropped, X-Withheld, X-Name"


class Refused(Exception):
    def __init__(self, status, error):
        super().__init__(error)
        self.status, self.error = status, error


def _rights(claims):
    rt = claims.get("rt")
    return set(rt) if isinstance(rt, list) else set()


def tenant_of(claims, body):
    """The firm the caller works in, or Refused: the owner and staff / HR with the Workers right in their own firm,
    a super-admin in the firm it views."""
    role = claims.get("role")
    if role not in MANAGER_ROLES:
        raise Refused(403, E_NO_RIGHT)
    tenant = body.get("asTenantId") if role == "superadmin" else claims.get("tenantId")
    if not tenant or not isinstance(tenant, str) or "/" in tenant:
        raise Refused(400, E_NO_FIRM)
    if role in ("staff", "hr") and "workers" not in _rights(claims):
        raise Refused(403, E_NO_RIGHT)
    return tenant


def worker_of(db, tenant, claims, wid):
    """The worker record, or Refused: not found, or not an own-workers HR's own worker."""
    wid = str(wid or "")
    if not wid or "/" in wid:
        raise Refused(404, E_NO_WORKER)
    s = db.collection("tenants").document(tenant).collection("workers").document(wid).get()
    w = (s.to_dict() or {}) if s.exists else None
    if w is None or (claims.get("role") == "hr" and claims.get("own") is True and w.get("hrId") != claims.get("uid")):
        raise Refused(404, E_NO_WORKER)
    return w


def _requests(db, tenant, wid):
    """The worker's sign requests (tenants/<t>/signRequests; no client reads them)."""
    out = []
    for d in db.collection("tenants").document(tenant).collection("signRequests").stream():
        x = d.to_dict() or {}
        if x.get("workerId") == wid:
            out.append(x)
    return out


def _signed(w):
    return bool(w.get("signedAt") or w.get("signedRequestId") or w.get("signed"))


class Reader:
    """Reads the worker's files: only paths under tenants/<t>/workers/<w>/, several at once, within MAX_BYTES."""

    def __init__(self, bucket, tenant, wid):
        self.bucket, self.prefix = bucket, f"tenants/{tenant}/workers/{wid}/"
        self.total, self.dropped = 0, 0

    def ok(self, path):
        p = str(path or "")
        return p.startswith(self.prefix) and ".." not in p.split("/") and "//" not in p and "\\" not in p

    def _one(self, path):
        try:
            b = self.bucket.blob(path)
            return b.download_as_bytes() if b.exists() else None
        except Exception:
            return None

    def read(self, paths):
        """{path: bytes or None}; a path outside the worker's folder is not read (None, counted as dropped)."""
        want = [p for p in dict.fromkeys(str(x or "") for x in paths) if p]
        out = {p: None for p in want}
        good = []
        for p in want:
            if self.ok(p):
                good.append(p)
            else:
                self.dropped += 1
        if good:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(good))) as pool:
                for p, data in zip(good, pool.map(self._one, good)):
                    out[p] = data
        for p in good:
            if out[p] is None:
                self.dropped += 1
            else:
                self.total += len(out[p])
        if self.total > MAX_BYTES:
            raise Refused(413, E_TOO_BIG)
        return out


def _pages_of(w, reader):
    """The worker's scanned pages [{kind, data}], the ID card or passport first: scanPages, or the old sidecar."""
    pages = w.get("scanPages") if isinstance(w.get("scanPages"), list) else []
    pages = [p for p in pages if isinstance(p, dict) and p.get("fileId")]
    pages = [p for p in pages if p.get("primary")] + [p for p in pages if not p.get("primary")]
    if pages:
        got = reader.read([p["fileId"] for p in pages])
        return [{"kind": p.get("kind") or "other", "data": got[p["fileId"]]} for p in pages if got.get(p["fileId"])]
    if w.get("assetsFileId"):
        import json
        raw = reader.read([w["assetsFileId"]]).get(w["assetsFileId"])
        try:
            d = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            d = {}
        out = []
        if d.get("scanB64"):
            out.append({"kind": "passport" if w.get("docType") == "passport" else "id_front", "data": base64.b64decode(d["scanB64"])})
        for x in d.get("extraPages") or []:
            if x and x.get("b64"):
                out.append({"kind": "other", "data": base64.b64decode(x["b64"])})
        return out
    return []


def _clean_form101(p):
    """The values the app sent, without what the server decides itself: no signature, no pages, no signing date."""
    if not isinstance(p, dict):
        return None
    out = {k: v for k, v in p.items() if k not in ("signaturePngBase64", "extraPages", "signDate", "taxYear")}
    import json
    return out if len(json.dumps(out, default=str)) < 30000 else None


def preview_signature(w, requests, reader):
    """The signature a preview may carry: one captured from a scan (`sigFileId`) of a worker with no signed set,
    and that no sign request kept — never a signing's own. → PNG bytes or None."""
    sig = str(w.get("sigFileId") or "")
    if not sig or _signed(w) or any(str(r.get("sigPath") or "") == sig for r in requests):
        return None
    return reader.read([sig]).get(sig)


def _mark_preview(pdf_bytes):
    """Every page of a preview gets the visible Hebrew mark "preview, not signed" at its top."""
    import pymupdf
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    writer = idsheet.Writer(FONT)
    for page in doc:
        r = page.rect
        writer.text(page, r.x1 - 20, 16, PREVIEW_MARK, size=12, color=(0.8, 0.1, 0.1))
    return doc


def _form101_preview(w, payload, requests, reader, build101, with_pages, lang=None):
    """→ (pymupdf document of the preview, dropped count): the sent values, the stored pages (with_pages) and a scan's
    signature when allowed, built by build101 (builders/form101_b1.py build_form101_pdf, not strict: a signature it
    could not place is counted) and marked as a preview."""
    import pymupdf
    p = dict(payload, extraPages=[])
    sig = preview_signature(w, requests, reader)
    if sig:
        p["signaturePngBase64"] = base64.b64encode(sig).decode()
    report = {}
    data, _name = build101(p, report=report)
    doc = _mark_preview(data)
    dropped = report.get("dropped", 0)
    if with_pages:
        pages = _pages_of(w, reader)
        if pages:
            tail = pymupdf.open()
            _l, _k, lost = idsheet.add_scans(tail, pages, w.get("docType") == "passport", FONT, lang)
            dropped += lost
            doc.insert_pdf(tail)
    return doc, dropped


def _signed_form101_path(w, requests):
    """A legacy signed worker's stored signed Form 101: the worker's `docFileId`, else the latest signed request's
    Form 101 part not taken onto the worker yet. None for a worker not signed."""
    if w.get("signedAt") and w.get("docFileId"):
        return w["docFileId"]
    done = [r for r in requests if r.get("status") == "signed" and ((r.get("parts") or {}).get("form101") or {}).get("path")]
    done.sort(key=lambda r: str(r.get("signedAtIso") or r.get("sentAt") or ""), reverse=True)
    if done:
        return done[0]["parts"]["form101"]["path"]
    return None


def contract_needs_pay(file_id, requests):
    """Whether a contract file may hold pay: its sign request's `printPay`; with no request behind it, yes."""
    for r in requests:
        if ((r.get("parts") or {}).get("contract") or {}).get("path") == file_id:
            return bool(r.get("printPay"))
    return True


def _dmy(s):
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(s or ""))
    return f"{m.group(3)}/{m.group(2)}/{m.group(1)}" if m else str(s or "")


def summary_page(doc, rows, listing, title):
    """The first page: the worker's data and the list of the documents that follow — Hebrew labels, right to left."""
    import pymupdf
    from bidi.algorithm import get_display
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontfile=str(FONT), fontname="Heebo")
    font = pymupdf.Font(fontfile=str(FONT))
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


def summary_rows(db, tenant, w):
    """The summary page's facts (never pay or rates)."""
    t = db.collection("tenants").document(tenant)

    def names(coll, ids):
        out = []
        for i in ids:
            if not i or "/" in str(i):
                continue
            s = t.collection(coll).document(str(i)).get()
            if s.exists:
                out.append((s.to_dict() or {}).get("name") or "")
        return ", ".join(x for x in out if x)

    passport = w.get("docType") == "passport"
    return [
        ("שם פרטי", w.get("docGiven")), ("שם משפחה", w.get("docSurname")),
        ("מספר דרכון" if passport else "מספר זהות", w.get("docId") or w.get("passportNo") or w.get("israeliId")),
        ("תוקף", w.get("docExpiry")), ("תאריך לידה", w.get("docDob")), ("טלפון", w.get("phone")),
        ("כתובת", ", ".join(x for x in [" ".join(x for x in [w.get("address"), w.get("houseNumber")] if x), w.get("city")] if x)),
        ("תאריך תחילת עבודה", _dmy(w.get("startDate") or w.get("workStartDate"))),
        ("לקוח / אתר", names("clients", w.get("clientIds") or [])),
        ("ספק", names("suppliers", [w["supplierId"]]) if w.get("supplierId") else ""),
        ("תאריך החתימה", w.get("signDate") or ""),
    ]


def _pdf_or_page(out, data, writer, caption):
    """A stored document into the bundle: a PDF as it is, a picture on a page of its own. → 1 when it failed."""
    import pymupdf
    if data[:4] == b"%PDF":
        try:
            out.insert_pdf(pymupdf.open(stream=data, filetype="pdf"))
            return 0
        except Exception:
            return 1
    return idsheet.add_page(out, data, writer, caption)


def build_bundle(db, bucket, tenant, claims, wid, w, include, payload, build101, old_device=False, lang=None):
    """The bundle (see the module's text). old_device: the old `signing.bundle` — no values are sent, so Form 101
    is the stored `docFileId` whatever it is. lang: the sheet's language, the viewer's (English when none is sent). → {pdf, name, pages, parts (keys), labels (Hebrew), dropped, withheld}."""
    import pymupdf
    from signing import may_see_pay
    reader = Reader(bucket, tenant, wid)
    requests = _requests(db, tenant, wid)
    writer = idsheet.Writer(FONT)
    sections = []  # (Hebrew label, key, pymupdf document) in order
    withheld = []
    dropped = 0
    stored_101 = False

    if include.get("form101"):
        stored = w.get("docFileId") if old_device else _signed_form101_path(w, requests)
        if stored:
            data = reader.read([stored]).get(stored)
            if data:
                try:
                    sections.append(("טופס 101" + (" (חתום)" if _signed(w) else ""), "form101-signed" if _signed(w) else "form101-stored",
                                     pymupdf.open(stream=data, filetype="pdf")))
                    stored_101 = True
                except Exception:
                    dropped += 1
        elif not old_device and _signed(w):
            dropped += 1  # signed, but its signed copy is not found: never a preview in its place
        elif not old_device:
            if payload is None:
                raise Refused(400, E_NO_FORM101)
            doc, d = _form101_preview(w, payload, requests, reader, build101, with_pages=not include.get("scans"), lang=lang)
            dropped += d
            sections.append(("טופס 101 (טיוטה)", "form101-preview", doc))

    docs = [d for d in (w.get("docs") if isinstance(w.get("docs"), list) else []) if isinstance(d, dict)]
    contracts_ = sorted([d for d in docs if d.get("type") == "contract"], key=lambda d: (not d.get("signed"), str(d.get("uploadedAt") or "")))
    sees_pay = may_see_pay(claims)

    def allowed(d):
        if contract_needs_pay(d.get("fileId"), requests) and not sees_pay:
            withheld.append("contract")
            return False
        return True

    if include.get("contract"):
        for d in contracts_[:1]:
            if not allowed(d):
                continue
            data = reader.read([d.get("fileId")]).get(str(d.get("fileId") or ""))
            if data:
                one = pymupdf.open()
                dropped += _pdf_or_page(one, data, writer, "חוזה")
                if one.page_count:
                    sections.append(("חוזה" + (" (חתום)" if d.get("signed") else ""), "contract", one))

    if include.get("scans") and not stored_101:
        pages = _pages_of(w, reader)
        if pages:
            one = pymupdf.open()
            labels, keys, d = idsheet.add_scans(one, pages, w.get("docType") == "passport", FONT, lang)
            dropped += d
            if one.page_count:
                sections.append((" · ".join(labels), ",".join(keys), one))

    if include.get("docs"):
        rest = [d for d in docs if d.get("type") != "contract"] + [d for d in contracts_[1:] if allowed(d)]
        got = reader.read([d.get("fileId") for d in rest])
        for d in rest:
            data = got.get(str(d.get("fileId") or ""))
            if not data:
                continue
            one = pymupdf.open()
            label = HE_DOC_TYPES.get(d.get("type"), "מסמך")
            dropped += _pdf_or_page(one, data, writer, label)
            if one.page_count:
                sections.append((label, "doc", one))

    out = pymupdf.open()
    summary_page(out, summary_rows(db, tenant, w), [s[0] for s in sections], (w.get("name") or "").strip() or "עובד")
    for _label, _key, doc in sections:
        out.insert_pdf(doc)
    data = out.tobytes(garbage=4, deflate=True)
    if len(data) > MAX_BYTES:
        raise Refused(413, E_TOO_BIG)
    name = re.sub(r"[\\/:*?\"<>|]", " ", (w.get("name") or "worker").strip()) + " - data.pdf"
    return {"pdf": data, "name": name, "pages": out.page_count, "parts": ["summary"] + [s[1] for s in sections],
            "labels": [s[0] for s in sections], "dropped": dropped + reader.dropped, "withheld": sorted(set(withheld))}


def build_preview(db, bucket, tenant, wid, w, payload, build101, lang=None):
    """The Form 101 preview alone, with its pages. → as build_bundle."""
    if payload is None:
        raise Refused(400, E_NO_FORM101)
    reader = Reader(bucket, tenant, wid)
    doc, dropped = _form101_preview(w, payload, _requests(db, tenant, wid), reader, build101, with_pages=True, lang=lang)
    data = doc.tobytes(garbage=4, deflate=True)
    if len(data) > MAX_BYTES:
        raise Refused(413, E_TOO_BIG)
    name = re.sub(r"[\\/:*?\"<>|]", " ", (w.get("name") or "worker").strip()) + " - Form 101.pdf"
    return {"pdf": data, "name": name, "pages": doc.page_count, "parts": ["form101-preview"], "labels": ["טופס 101 (טיוטה)"],
            "dropped": dropped + reader.dropped, "withheld": []}


def run(db, bucket, claims, body, build101):
    """One call of `worker_docs` → {pdf, name, pages, parts, dropped, withheld}, or {error, status}."""
    try:
        tenant = tenant_of(claims, body)
        action = str(body.get("action") or "")
        if action not in ("bundle", "form101"):
            raise Refused(400, E_ACTION)
        wid = str(body.get("workerId") or "")
        w = worker_of(db, tenant, claims, wid)
        payload = _clean_form101(body.get("form101"))
        if action == "form101":
            return build_preview(db, bucket, tenant, wid, w, payload, build101, body.get("lang"))
        raw = body.get("include") if isinstance(body.get("include"), dict) else {}
        include = {k: raw.get(k) is True for k in INCLUDE}
        return build_bundle(db, bucket, tenant, claims, wid, w, include, payload, build101, lang=body.get("lang"))
    except Refused as e:
        return {"error": e.error, "status": e.status}


def headers(out):
    """The answer's headers for a built PDF (raw application/pdf, read by the app through CORS)."""
    return {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"data.pdf\"; filename*=UTF-8''" + quote(out["name"]),
        "X-Pages": str(out["pages"]), "X-Parts": ",".join(out["parts"]), "X-Dropped": str(out["dropped"]),
        "X-Withheld": ",".join(out["withheld"]), "X-Name": quote(out["name"]),
        "Access-Control-Expose-Headers": EXPOSE, "Cache-Control": "no-store",
    }
