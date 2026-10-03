"""Worker files on Firebase Storage (FIRESTORE_PLAN.md stage 7b).

In Firestore mode the browser uploads the Form 101 PDF, the scan sidecar
(assets JSON) and worker documents straight to Storage with the Firebase SDK
(firestore-backend.js uploadWorkerFile, real byte progress; storage.rules
decide who may write). Reading the sidecar back and deleting a file go
through here instead: a browser download from the bucket needs a CORS setup
on the bucket, which this way never has to be made by hand.

  loadWorkerAssets  {fileId: <storage path>} -> same reply as Apps Script
  deleteWorkerDoc   {fileId: <storage path>} -> {ok: true}

A fileId is the object's path, tenants/<tenantId>/workers/...; only a path in
the caller's own firm is accepted (a superadmin's: the firm it is viewing),
the same guard Apps Script's _fileBelongsToTenant gives Drive files.
"""

import json

ACTIONS = ("loadWorkerAssets", "deleteWorkerDoc")
MANAGER_ROLES = ("superadmin", "tenant_admin", "staff")

E_NOT_FIRM = "Файл не принадлежит этой фирме"
E_NO_FILE = "Нет fileId"
E_NOT_FOUND = "Файл не найден"
E_NO_RIGHT = "Нет прав на работников"


def _path_ok(path, tenant_id):
    return (bool(tenant_id) and path.startswith("tenants/" + tenant_id + "/workers/")
            and ".." not in path.split("/") and "//" not in path)


def _workers_writer(caller):
    role = caller.get("role")
    if role in ("superadmin", "tenant_admin"):
        return True
    perms = caller.get("perms")
    return role == "staff" and isinstance(perms, list) and ("*" in perms or "workers" in perms)


def run(bucket, caller, body):
    """bucket: a google.cloud.storage Bucket (or anything with .blob(path)
    returning an object with exists/download_as_bytes/delete)."""
    action = str(body.get("action") or "")
    if action not in ACTIONS:
        return {"error": "Unknown action"}
    if caller.get("role") not in MANAGER_ROLES:
        return {"error": "Недоступно для этой роли"}
    path = str(body.get("fileId") or "")
    if not path:
        return {"error": E_NO_FILE}
    if not _path_ok(path, caller.get("tenantId")):
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
