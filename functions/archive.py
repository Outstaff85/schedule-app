"""The signed archive (owner, 2026-11-03; docs/documents-plan.md → S3 → The signed archive).

Every document a worker signed with their own hand — by their own link or on the manager's phone, the signing's two
ways — is copied, the moment it is built, into one folder per worker outside the firm's own files:

  archive/<firm name>/<given surname ID>/Form 101/<sign date> <name>.pdf
  archive/<firm name>/<given surname ID>/Contracts/<sign date> <name>.pdf
  archive/<firm name>/<given surname ID>/Contracts/<sign date> <template name> - template v<n>.pdf   (the template it was
                                                                                                      filled from)
  … and beside each document <the same name>.json: the signing (request id, way, dates, the files' SHA-256).

Nothing else of the worker goes there: what the worker did not sign (scans, uploads, unsigned forms) is deleted with
the worker or the firm (owner, 2026-11-03). The folder lies outside tenants/<t>/, so deleting a worker or a firm
(files.delete_tenant_files) never reaches it; no client reads it (storage.rules match nothing under archive/).
A copy is never overwritten (if_generation_match=0): the same document copied twice keeps its first copy.
"""

import hashlib
import json
import re

ROOT = "archive"
FOLDERS = {"form101": "Form 101", "contract": "Contracts"}
_BAD = re.compile(r"[\\/:*?\"<>|#\[\]\x00-\x1f]+")


def clean(s, fallback):
    """A name safe as one folder or file name: no slashes or other path characters, spaces collapsed."""
    s = re.sub(r"\s+", " ", _BAD.sub(" ", str(s or ""))).strip(" .")
    return s[:100] or fallback


def worker_folder(worker, wid):
    """<given surname ID>: the names and the number as read from the worker's document, else the worker's name."""
    w = worker or {}
    name = " ".join(x for x in (str(w.get("docGiven") or "").strip(), str(w.get("docSurname") or "").strip()) if x)
    name = name or str(w.get("name") or "").strip()
    number = str(w.get("docId") or w.get("passportNo") or w.get("israeliId") or "").strip()
    return clean(" ".join(x for x in (name, number) if x), "worker " + str(wid))


def firm_folder(db, tenant):
    snap = db.collection("tenants").document(tenant).get()
    return clean(((snap.to_dict() or {}) if snap.exists else {}).get("companyName"), "firm " + str(tenant))


def _date(s):
    """The sign date (DD/MM/YYYY) as YYYY-MM-DD, so a folder sorts by it."""
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(s or ""))
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else ""


def _put(bucket, path, data, content_type):
    try:
        bucket.blob(path).upload_from_string(data, content_type=content_type, if_generation_match=0)
    except Exception as e:  # already there (PreconditionFailed): the first copy stays
        if "412" not in str(e) and type(e).__name__ != "PreconditionFailed":
            raise
    return path


def put_signed(db, bucket, tenant, rid, req, which, part, worker=None):
    """Copies one signed part (parts[which] of request rid) into the worker's archive folder → its path there."""
    if which not in FOLDERS or not part or not part.get("path"):
        return None
    wid = str(req.get("workerId") or "")
    if worker is None:
        snap = db.collection("tenants").document(tenant).collection("workers").document(wid).get()
        worker = snap.to_dict() if snap.exists else {}
    base = "/".join((ROOT, firm_folder(db, tenant), worker_folder(worker, wid), FOLDERS[which]))
    day = _date(req.get("signDate"))
    stem = clean(" ".join(x for x in (day, re.sub(r"\.pdf$", "", str(part.get("name") or ""), flags=re.I)) if x), which)
    stem += " " + str(rid)[:6]  # two signings on one day never share a name
    data = bucket.blob(part["path"]).download_as_bytes()
    files = [{"file": stem + ".pdf", "from": part["path"], "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}]
    doc = _put(bucket, base + "/" + stem + ".pdf", data, "application/pdf")
    if which == "contract" and req.get("templatePath"):
        tb = bucket.blob(req["templatePath"])
        if tb.exists():
            t = tb.download_as_bytes()
            tname = clean(" ".join(x for x in (day, str(req.get("templateName") or "contract")) if x), "contract")
            tname += " - template" + (" v" + str(int(req["templateVersion"])) if req.get("templateVersion") else "") + " " + str(rid)[:6] + ".pdf"
            _put(bucket, base + "/" + tname, t, "application/pdf")
            files.append({"file": tname, "from": req["templatePath"], "sha256": hashlib.sha256(t).hexdigest(), "size": len(t)})
    note = {"requestId": rid, "workerId": wid, "document": which, "way": req.get("way") or "remote",
            "signDate": req.get("signDate") or "", "signedAt": req.get("signedAtIso") or "",
            "templateId": req.get("templateId") or "", "templateName": req.get("templateName") or "",
            "templateVersion": req.get("templateVersion") or None, "files": files}
    _put(bucket, base + "/" + stem + ".json", json.dumps(note, ensure_ascii=False, indent=1).encode("utf-8"), "application/json")
    return doc
