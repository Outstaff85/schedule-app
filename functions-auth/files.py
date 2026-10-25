"""Worker files on Firebase Storage.

In Firestore mode the browser uploads the Form 101 PDF, the scan sidecar
(assets JSON) and worker documents straight to Storage with the Firebase SDK
(firestore-backend.js uploadWorkerFile, real byte progress; storage.rules
decide who may write). Reading the sidecar back and deleting a file go
through here instead: a browser download from the bucket needs a CORS setup
on the bucket, which this way never has to be made by hand.

  loadWorkerPages   {fileIds: [<storage path>, …]} -> {ok, pages: [{fileId, b64, mediaType}], missing: [<path>]}
                    the worker's scanned pages (pages/, one JPEG each) and signature
                    (signature/, a PNG) — docs/contracts.md → Scanned pages; at most
                    MAX_PAGES at once, each path checked like any file
  loadWorkerAssets  {fileId: <storage path>} -> {ok, scanB64, scanMediaType, sigPng, extraPages}
                    the old sidecar (one JSON with the pictures inside), read until the
                    worker's sidecar is split into pages (scripts/migrate/scan_pages.py)
  deleteWorkerDoc   {fileId: <storage path>} -> {ok: true}
                    refused (E_SIGNED) for a signed file, which is never deleted
                    (docs/contracts.md → Signed files are kept; signed_file below)

A fileId is the object's path, tenants/<tenantId>/workers/...; only a path in
the caller's own firm is accepted (a superadmin's: the firm it is viewing).
An HR login limited to its own workers (claim own) reaches only the files of
workers whose hrId is its uid (worker_hr(workerId) -> hrId, from main.py).

delete_tenant_files(bucket, tenant_id) removes every file of a firm; main.py
calls it after users_admin deleteTenant.
"""

import base64
import json

ACTIONS = ("loadWorkerAssets", "loadWorkerPages", "deleteWorkerDoc")
MAX_PAGES = 20
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")

E_NOT_FIRM = "The file doesn't belong to this firm"
E_NO_FILE = "No fileId"
E_NOT_FOUND = "File not found"
E_NO_RIGHT = "No rights to workers"
E_SIGNED = "A signed document is kept and can't be deleted"


def signed_file(path, worker, requests):
    """True when path is a signed file, which is never deleted (documents plan, S0b):
    - a part (parts.*.path) or the signature (sigPath) of any of the worker's signing
      requests (its signRequests, and the transferRequests that made this worker);
    - a docs[] entry marked signed;
    - for a signed worker (signedAt / signedRequestId): its docFileId, any docs[].fileId
      and its sigFileId."""
    for r in requests or []:
        r = r or {}
        if r.get("sigPath") and path == r.get("sigPath"):
            return True
        for part in (r.get("parts") or {}).values():
            if isinstance(part, dict) and part.get("path") == path:
                return True
    w = worker or {}
    docs = [d for d in (w.get("docs") or []) if isinstance(d, dict)]
    if any(d.get("signed") and d.get("fileId") == path for d in docs):
        return True
    if w.get("signedAt") or w.get("signedRequestId"):
        if path in (w.get("docFileId"), w.get("sigFileId")) or any(d.get("fileId") == path for d in docs):
            return True
    return False


def _path_ok(path, tenant_id):
    return (bool(tenant_id) and path.startswith("tenants/" + tenant_id + "/workers/")
            and ".." not in path.split("/") and "//" not in path)


def _page_path_ok(path):
    """A scanned page or a signature: tenants/<t>/workers/<w>/{pages|signature}/<file>."""
    parts = path.split("/")
    return len(parts) == 6 and parts[4] in ("pages", "signature")


def _media_type(path):
    return "image/png" if path.lower().endswith(".png") else "image/jpeg"


def _workers_writer(caller):
    role = caller.get("role")
    if role in ("superadmin", "tenant_admin"):
        return True
    rights = caller.get("rights") or set()  # the flat rights (core.caller_rights)
    return role in ("staff", "hr") and "workers" in rights and "editWorkers" in rights


def run(bucket, caller, body, worker_hr=None, signed_lookup=None):
    """bucket: a google.cloud.storage Bucket (or anything with .blob(path)
    returning an object with exists/download_as_bytes/delete).
    signed_lookup(workerId) -> (the worker record or None, [its signing requests]):
    what deleteWorkerDoc checks the path against (signed_file); without it,
    deleteWorkerDoc deletes nothing."""
    action = str(body.get("action") or "")
    if action not in ACTIONS:
        return {"error": "Unknown action"}
    if caller.get("role") not in MANAGER_ROLES:
        return {"error": "Not available for this role"}

    def allowed(path):
        if not _path_ok(path, caller.get("tenantId")):
            return False
        if caller.get("role") == "hr" and caller.get("own"):
            wid = path.split("/")[3] if len(path.split("/")) > 3 else ""
            if not worker_hr or not wid or worker_hr(wid) != caller.get("uid"):
                return False
        return True

    if action == "loadWorkerPages":
        ids = body.get("fileIds")
        if not isinstance(ids, list) or not ids:
            return {"error": E_NO_FILE}
        if len(ids) > MAX_PAGES:
            return {"error": "Too many files"}
        ids = [str(x or "") for x in ids]
        if not all(_page_path_ok(p) and allowed(p) for p in ids):
            return {"error": E_NOT_FIRM}
        pages, missing = [], []
        for p in ids:
            blob = bucket.blob(p)
            if not blob.exists():
                missing.append(p)
                continue
            pages.append({"fileId": p, "b64": base64.b64encode(blob.download_as_bytes()).decode("ascii"),
                          "mediaType": _media_type(p)})
        return {"ok": True, "pages": pages, "missing": missing}

    path = str(body.get("fileId") or "")
    if not path:
        return {"error": E_NO_FILE}
    if not allowed(path):
        return {"error": E_NOT_FIRM}
    blob = bucket.blob(path)
    if action == "deleteWorkerDoc":
        if not _workers_writer(caller):
            return {"error": E_NO_RIGHT}
        # one check for every browser path that deletes a file (docs/contracts.md → Signed files are kept)
        if signed_lookup is None:
            return {"error": E_SIGNED}
        worker, requests = signed_lookup(path.split("/")[3])
        if signed_file(path, worker, requests):
            return {"error": E_SIGNED}
        if blob.exists():
            blob.delete()
        return {"ok": True}
    if not blob.exists():
        return {"error": E_NOT_FOUND}
    data = json.loads(blob.download_as_bytes().decode("utf-8"))
    return {"ok": True, "scanB64": data.get("scanB64"), "scanMediaType": data.get("scanMediaType"),
            "sigPng": data.get("sigPng") or None,
            "extraPages": data.get("extraPages") if isinstance(data.get("extraPages"), list) else []}


def delete_tenant_files(bucket, tenant_id):
    """Deletes every object under tenants/<tenant_id>/ and returns how many."""
    if not tenant_id or "/" in str(tenant_id):
        return 0
    n = 0
    for blob in bucket.list_blobs(prefix="tenants/" + str(tenant_id) + "/"):
        blob.delete()
        n += 1
    return n
