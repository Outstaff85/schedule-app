"""Worker files on Firebase Storage.

In Firestore mode the browser uploads the Form 101 PDF, the scan sidecar
(assets JSON) and worker documents straight to Storage with the Firebase SDK
(firestore-backend.js uploadWorkerFile, real byte progress; storage.rules
decide who may write). Reading the sidecar back and deleting a file go
through here instead: a browser download from the bucket needs a CORS setup
on the bucket, which this way never has to be made by hand.

  loadWorkerAssets  {fileId: <storage path>} -> {ok, scanB64, scanMediaType, sigPng, extraPages}
  deleteWorkerDoc   {fileId: <storage path>} -> {ok: true}

A fileId is the object's path, tenants/<tenantId>/workers/...; only a path in
the caller's own firm is accepted (a superadmin's: the firm it is viewing).
An HR login limited to its own workers (claim own) reaches only the files of
workers whose hrId is its uid (worker_hr(workerId) -> hrId, from main.py).

delete_tenant_files(bucket, tenant_id) removes every file of a firm; main.py
calls it after users_admin deleteTenant.
"""

import json

ACTIONS = ("loadWorkerAssets", "deleteWorkerDoc")
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff", "hr")

E_NOT_FIRM = "The file doesn't belong to this firm"
E_NO_FILE = "No fileId"
E_NOT_FOUND = "File not found"
E_NO_RIGHT = "No rights to workers"


def _path_ok(path, tenant_id):
    return (bool(tenant_id) and path.startswith("tenants/" + tenant_id + "/workers/")
            and ".." not in path.split("/") and "//" not in path)


def _workers_writer(caller):
    role = caller.get("role")
    if role in ("superadmin", "tenant_admin"):
        return True
    perms = caller.get("perms")
    return role in ("staff", "hr") and isinstance(perms, list) and ("*" in perms or "workers" in perms)


def run(bucket, caller, body, worker_hr=None):
    """bucket: a google.cloud.storage Bucket (or anything with .blob(path)
    returning an object with exists/download_as_bytes/delete)."""
    action = str(body.get("action") or "")
    if action not in ACTIONS:
        return {"error": "Unknown action"}
    if caller.get("role") not in MANAGER_ROLES:
        return {"error": "Not available for this role"}
    path = str(body.get("fileId") or "")
    if not path:
        return {"error": E_NO_FILE}
    if not _path_ok(path, caller.get("tenantId")):
        return {"error": E_NOT_FIRM}
    if caller.get("role") == "hr" and caller.get("own"):
        wid = path.split("/")[3] if len(path.split("/")) > 3 else ""
        if not worker_hr or not wid or worker_hr(wid) != caller.get("uid"):
            return {"error": E_NOT_FIRM}
    blob = bucket.blob(path)
    if action == "deleteWorkerDoc":
        if not _workers_writer(caller):
            return {"error": E_NO_RIGHT}
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
