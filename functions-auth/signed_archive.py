"""The signed archive (owner, 2026-11-03; docs/contracts.md → The signed archive).

A document the worker signed with their own hand — a Form 101 or a contract — is never just deleted: when a person
deletes it (Remove on the worker's card, Delete worker) or deletes the firm, it is first copied into one folder per
worker outside the firm's own files, and only then deleted:

  archive/<firm name>/<given surname ID>/Form 101/<sign date> <name> <id>.pdf
  archive/<firm name>/<given surname ID>/Contracts/<sign date> <name> <id>.pdf
  archive/<firm name>/<given surname ID>/Contracts/<sign date> <template name> - template v<n> <id>.pdf   (the template
                                                                                                         it was filled from)
  archive/<firm name>/<given surname ID>/Scans/<sign date> scans <id>.pdf   (the scanned pages the worker signed on, on A4
                                                                          sheets two to a sheet — owner, 2026-11-03)
  … and beside each document <the same name>.json: the signing (request id, way, dates, the files' SHA-256).

The scans go with the documents: the pages a signing was given on (its frozen pages) are laid on A4 sheets, two pictures
to a sheet — the document (ID card or passport) first, then its back or the appendix, then any other page; a third
picture starts another sheet (scans_pdf) — and kept as one PDF with its documents. A rescan simply replaces the pages (owner,
2026-11-03: an old passport is overwritten by the new one), nothing archived; so when those pages are gone, the worker's
pages now go with the document. For a document from before the signing requests, the worker's pages. What the worker did not sign (an upload, an unsigned form, other scans, the signature picture) is
deleted with no copy. Nothing
is archived or deleted on its own: only a person's delete does it. The folder lies outside tenants/<t>/, so no delete of a
worker or a firm reaches it; no login reads it (storage.rules match nothing under archive/). A copy is never written over.

Signed by hand = a part of a signing request (the worker's own link or the manager's phone) or of a move into this firm,
or, from before the signing requests, the Form 101 of a signed worker (docFileId with signedAt) and a docs[] entry marked
signed.
"""

import base64
import hashlib
import io
import json
import re

ROOT = "archive"
FOLDERS = {"form101": "Form 101", "contract": "Contracts", "scan": "Scans"}
_BAD = re.compile(r"[\\/:*?\"<>|#\[\]\x00-\x1f]+")


E_FIRM = "The firm's signed documents could not be put in the archive, so nothing was deleted — try again"
E_WORKER = "The worker's signed documents could not be put in the archive, so nothing was deleted — try again"


class NotArchived(Exception):
    pass


def clean(s, fallback):
    """A name safe as one folder or file name: no slashes or other path characters, spaces collapsed."""
    s = re.sub(r"\s+", " ", _BAD.sub(" ", str(s or ""))).strip(" .")
    return s[:100] or fallback


def find(path, worker, requests):
    """Is path a document the worker signed by hand? → {which, req} (req: its signing or move, None for one from before
    the signing requests), or None — also for the signature picture, which is no document."""
    for r in requests or []:
        for which, part in ((r or {}).get("parts") or {}).items():
            if isinstance(part, dict) and part.get("path") == path and which in FOLDERS:
                return {"which": which, "req": r}
    w = worker or {}
    if (w.get("signedAt") or w.get("signedRequestId")) and path == w.get("docFileId"):
        return {"which": "form101", "req": None}
    if any(isinstance(d, dict) and d.get("signed") and d.get("fileId") == path for d in w.get("docs") or []):
        return {"which": "contract", "req": None}
    return None


# The order the pictures go on the sheets: the document, its back or the appendix, then the rest.
KIND_ORDER = ("passport", "id_front", "id_back", "sefach")
A4_PX = (1654, 2339)  # A4 at 200 dpi
MARGIN_PX = 80


def scans_pdf(pictures):
    """Pictures (JPEG/PNG bytes, in sheet order) -> one PDF of A4 sheets, two pictures to a sheet, one above the other,
    each fitted into its half keeping its shape (owner, 2026-11-03). A picture that does not open is left out."""
    from PIL import Image
    W, H = A4_PX
    half = (H - 3 * MARGIN_PX) // 2
    box = (W - 2 * MARGIN_PX, half)
    images = []
    for data in pictures:
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            images.append(im.convert("RGB"))
        except Exception:
            continue
    sheets = []
    for i in range(0, len(images), 2):
        sheet = Image.new("RGB", (W, H), "white")
        for j, im in enumerate(images[i:i + 2]):
            scale = min(box[0] / im.width, box[1] / im.height)
            size = (max(1, int(im.width * scale)), max(1, int(im.height * scale)))
            fit = im.resize(size, Image.LANCZOS)
            top = MARGIN_PX + j * (half + MARGIN_PX)
            sheet.paste(fit, ((W - size[0]) // 2, top + (half - size[1]) // 2))
        sheets.append(sheet)
    if not sheets:
        return None
    out = io.BytesIO()
    sheets[0].save(out, "PDF", resolution=200.0, save_all=True, append_images=sheets[1:], quality=90)
    return out.getvalue()


def _pictures(bucket, refs):
    """The page refs ([{path, kind}]) -> the pictures of the files still there, in sheet order; an old sidecar gives its own."""
    out = []
    for r in refs:
        b = bucket.blob(r["path"])
        if not b.exists():
            continue
        data = b.download_as_bytes()
        if r["path"].endswith(".json"):
            try:
                side = json.loads(data.decode("utf-8"))
            except Exception:
                continue
            pics = [side.get("scanB64")] + [p.get("b64") for p in side.get("extraPages") or [] if isinstance(p, dict)]
            out += [(None, base64.b64decode(x)) for x in pics if x]
        else:
            out.append((r.get("kind"), data))
    first = [x for k in KIND_ORDER for x in out if x[0] == k]
    return [d for _, d in first] + [d for k, d in out if k not in KIND_ORDER]


def _page_refs(req, worker):
    """The pages a signing was given on, with their kinds; one from before the signing requests: the worker's own."""
    refs = ((req or {}).get("frozen") or {}).get("pages")
    if isinstance(refs, list):
        return [{"path": str(r.get("fileId") or r.get("sidecar")), "kind": r.get("kind")}
                for r in refs if isinstance(r, dict) and (r.get("fileId") or r.get("sidecar"))]
    w = worker or {}
    out = [{"path": str(p["fileId"]), "kind": p.get("kind")} for p in w.get("scanPages") or [] if isinstance(p, dict) and p.get("fileId")]
    return out or ([{"path": w["assetsFileId"], "kind": None}] if w.get("assetsFileId") else [])


def _put_scans(bucket, base, day, key, req, worker):
    """The signing's scans as A4 sheets in Scans/ (never written over) -> its note entry, or None when no page is left.
    The pages it was signed on while they are all there; replaced by a rescan, the worker's pages now."""
    refs = _page_refs(req, worker)
    if not refs or not all(bucket.blob(r["path"]).exists() for r in refs):
        refs = _page_refs(None, worker)
    pdf = scans_pdf(_pictures(bucket, refs)) if refs else None
    if not pdf:
        return None
    name = clean(" ".join(x for x in (day, "scans") if x), "scans") + " " + key + ".pdf"
    _put(bucket, base + "/" + name, pdf, "application/pdf")
    return {"file": "../" + FOLDERS["scan"] + "/" + name, "from": [r["path"] for r in refs],
            "sha256": hashlib.sha256(pdf).hexdigest(), "size": len(pdf)}


def worker_folder(worker, req, wid):
    """<given surname ID>: as read from the worker's document; the worker record gone, as the signing kept it."""
    w = worker or ((req or {}).get("frozen") or {}).get("personal") or {}
    vals = (req or {}).get("values") or {}
    given = str(w.get("docGiven") or vals.get("given") or "").strip()
    surname = str(w.get("docSurname") or vals.get("surname") or "").strip()
    name = " ".join(x for x in (given, surname) if x) or str(w.get("name") or ((req or {}).get("frozen") or {}).get("workerName") or "").strip()
    number = str(w.get("docId") or w.get("passportNo") or w.get("israeliId") or vals.get("id") or "").strip()
    return clean(" ".join(x for x in (name, number) if x), "worker " + str(wid))


def firm_folder(db, tenant):
    snap = db.collection("tenants").document(tenant).get()
    return clean(((snap.to_dict() or {}) if snap.exists else {}).get("companyName"), "firm " + str(tenant))


def _date(s):
    """DD/MM/YYYY as YYYY-MM-DD, so a folder sorts by it."""
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(s or ""))
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else ""


def _put(bucket, path, data, content_type):
    try:
        bucket.blob(path).upload_from_string(data, content_type=content_type, if_generation_match=0)
    except Exception as e:  # already there (PreconditionFailed): the first copy stays
        if "412" not in str(e) and type(e).__name__ != "PreconditionFailed":
            raise


def put(db, bucket, tenant, path, worker, requests, firm=None):
    """Copies path into the worker's archive folder when it is a document they signed by hand → its archive path, or None
    (not signed by hand: nothing to keep). Raises NotArchived when it should be kept and cannot be: the delete then stops."""
    hit = find(path, worker, requests)
    if not hit:
        return None
    which, req = hit["which"], hit["req"] or {}
    wid = path.split("/")[3] if len(path.split("/")) > 3 else ""
    src = bucket.blob(path)
    if not src.exists():
        return None  # already gone: nothing left to keep
    try:
        data = src.download_as_bytes()
        fz = req.get("frozen") or {}
        rid = str(req.get("_id") or "")
        sign_date = req.get("signDate") or fz.get("date") or (worker or {}).get("signDate") or ""
        day = _date(sign_date)
        key = rid[:6] or hashlib.sha256(path.encode()).hexdigest()[:6]  # two signings on one day never share a name
        sbase = "/".join((ROOT, firm or firm_folder(db, tenant), worker_folder(worker, req, wid), FOLDERS["scan"]))
        base = "/".join((ROOT, firm or firm_folder(db, tenant), worker_folder(worker, req, wid), FOLDERS[which]))
        stem = clean(" ".join(x for x in (day, re.sub(r"\.pdf$", "", path.rsplit("/", 1)[-1].split("-", 1)[-1], flags=re.I)) if x), which)
        stem += " " + key
        files = [{"file": stem + ".pdf", "from": path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}]
        _put(bucket, base + "/" + stem + ".pdf", data, "application/pdf")
        tpath = req.get("templatePath") or fz.get("templatePath")
        if which == "contract" and tpath and bucket.blob(tpath).exists():
            t = bucket.blob(tpath).download_as_bytes()
            tname = clean(" ".join(x for x in (day, str(req.get("templateName") or re.sub(r"\.pdf$", "", str(fz.get("contractName") or "contract")))) if x), "contract")
            tname += " - template" + (" v" + str(int(req["templateVersion"])) if req.get("templateVersion") else "") + " " + stem.rsplit(" ", 1)[-1] + ".pdf"
            _put(bucket, base + "/" + tname, t, "application/pdf")
            files.append({"file": tname, "from": tpath, "sha256": hashlib.sha256(t).hexdigest(), "size": len(t)})
        got = _put_scans(bucket, sbase, day, key, hit["req"], worker)  # the scans go with it
        if got:
            files.append(got)
        note = {"requestId": rid, "workerId": wid, "document": which,
                "way": req.get("way") or ("remote" if req.get("toTenant") else ("" if not rid else "remote")),
                "signDate": sign_date, "signedAt": req.get("signedAtIso") or "",
                "templateId": req.get("templateId") or "", "templateName": req.get("templateName") or "",
                "templateVersion": req.get("templateVersion") or None, "files": files}
        _put(bucket, base + "/" + stem + ".json", json.dumps(note, ensure_ascii=False, indent=1).encode("utf-8"), "application/json")
        return base + "/" + stem + ".pdf"
    except Exception as e:
        raise NotArchived(str(e)) from e


def _signings(db, tenant, wid=None):
    """The firm's signings and moves into it, by worker id (each with its id as _id); one worker's alone with wid."""
    t = db.collection("tenants").document(tenant)
    by_worker = {}
    for d in t.collection("signRequests").stream():
        x = dict(d.to_dict() or {}, _id=d.id)
        if wid is None or str(x.get("workerId") or "") == wid:
            by_worker.setdefault(str(x.get("workerId") or ""), []).append(x)
    for d in db.collection("transferRequests").stream():
        x = dict(d.to_dict() or {}, _id=d.id)
        if x.get("toTenant") == tenant and x.get("newWorkerId") and (wid is None or x["newWorkerId"] == wid):
            by_worker.setdefault(str(x["newWorkerId"]), []).append(x)
    return by_worker


def archive_worker(db, bucket, tenant, wid, worker, requests, firm=None):
    """Every document the worker signed by hand (with its scans) copied into the archive -> how many. Raises
    NotArchived on the first that cannot be kept."""
    paths = [p.get("path") for r in requests for p in (r.get("parts") or {}).values() if isinstance(p, dict)]
    if worker:
        paths += [worker.get("docFileId")] + [d.get("fileId") for d in worker.get("docs") or [] if isinstance(d, dict)]
    n = 0
    for p in dict.fromkeys(x for x in paths if x):
        if put(db, bucket, tenant, p, worker, requests, firm):
            n += 1
    return n


def delete_worker(db, bucket, tenant, wid):
    """A person's Delete worker in one call (documents plan N1; owner, 2026-11-03): what the worker signed by hand into
    the archive first, then every file under tenants/<t>/workers/<w>/, then the record. Raises NotArchived before anything
    is deleted when a copy fails. The signing requests stay (they are the firm's record of each signing)."""
    if not wid or "/" in wid:
        raise ValueError("No worker")
    ref = db.collection("tenants").document(tenant).collection("workers").document(wid)
    snap = ref.get()
    worker = snap.to_dict() if snap.exists else None
    archived = archive_worker(db, bucket, tenant, wid, worker, _signings(db, tenant, wid).get(wid, []))
    files = 0
    for blob in bucket.list_blobs(prefix=f"tenants/{tenant}/workers/{wid}/"):
        blob.delete()
        files += 1
    ref.delete()
    return {"ok": True, "archived": archived, "files": files}


def archive_tenant(db, bucket, tenant):
    """Before a firm is deleted: every document its workers signed by hand copied into the archive -> how many. Raises
    NotArchived on the first that cannot be kept, so the firm is not deleted."""
    t = db.collection("tenants").document(tenant)
    workers = {d.id: d.to_dict() or {} for d in t.collection("workers").stream()}
    by_worker = _signings(db, tenant)
    firm = firm_folder(db, tenant)
    n = 0
    for wid in sorted(set(workers) | set(by_worker)):
        n += archive_worker(db, bucket, tenant, wid, workers.get(wid), by_worker.get(wid, []), firm)
    return n
