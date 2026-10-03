"""Move worker files from Google Drive to Firebase Storage (FIRESTORE_PLAN.md stage 8).

Started by a super-admin from Admin -> Firms -> "Move files to Firebase"
(migrate_files in main.py). For every worker of every firm in Firestore, each
file still on Drive — the Form 101 PDF (docFileId, or the id inside docUrl
for older records), the scan sidecar (assetsFileId) and every document in
docs[] — is read through Apps Script (exportForMigration part 'file', a
super-admin's session token, only a file in that firm's own Workers folders)
and written to the same Storage paths the app uses (firestore-backend.js
uploadWorkerFile). The worker record then points at the Storage copy.

Nothing on Drive is changed or trashed. A file already in Storage (a
tenants/... id) is skipped, so running it again only moves what is left; a
run that nears the function's time limit stops and says so (partial).
"""

import base64
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

TIME_BUDGET_S = 420     # the function has 540 s; stop early and report partial
WORKERS = 6             # files fetched/uploaded in parallel

DRIVE_ID_IN_URL = re.compile(r"/d/([a-zA-Z0-9_-]+)")


def _is_storage(fid):
    return isinstance(fid, str) and fid.startswith("tenants/")


def _safe(name):
    return (re.sub(r"[/\\#?\[\]*\x00-\x1f]", "_", str(name or "file"))[:150]) or "file"


def download_url(bucket_name, path, token):
    return ("https://firebasestorage.googleapis.com/v0/b/" + bucket_name + "/o/" + quote(path, safe="")
            + "?alt=media&token=" + token)


def _jobs(wid, w):
    """(field, drive id, kind, docs index) for every file of this worker still on Drive."""
    out = []
    doc_id = w.get("docFileId")
    if not doc_id and w.get("docUrl"):
        m = DRIVE_ID_IN_URL.search(str(w.get("docUrl")))
        doc_id = m.group(1) if m else None
    if doc_id and not _is_storage(doc_id):
        out.append(("doc", doc_id, "form101", None))
    if w.get("assetsFileId") and not _is_storage(w.get("assetsFileId")):
        out.append(("assets", w["assetsFileId"], "assets", None))
    for i, d in enumerate(w.get("docs") or []):
        if isinstance(d, dict) and d.get("fileId") and not _is_storage(d.get("fileId")):
            out.append(("docs", d["fileId"], "docs", i))
    return out


def _move_one(bucket, fetch, tid, wid, w, job, now_ms):
    field, drive_id, kind, idx = job
    r = fetch("file", tid, drive_id)
    if not r or r.get("error"):
        return job, None, (r or {}).get("error") or "no reply", bool((r or {}).get("missing"))
    name = r.get("name") or "file"
    if field == "docs":
        name = (w["docs"][idx].get("name") or name)
    path = f"tenants/{tid}/workers/{_safe(wid)}/{kind}/{now_ms}-{_safe(name)}"
    token = str(uuid.uuid4())
    blob = bucket.blob(path)
    blob.metadata = {"firebaseStorageDownloadTokens": token, "workerId": wid, "kind": kind, "driveId": drive_id}
    if kind != "assets":
        blob.content_disposition = "inline; filename*=UTF-8''" + quote(_safe(name))
    blob.upload_from_string(base64.b64decode(r.get("b64") or ""),
                            content_type=r.get("mimeType") or "application/octet-stream")
    return job, {"id": path, "url": None if kind == "assets" else download_url(bucket.name, path, token)}, None, False


def move_firm(db, bucket, fetch, tid, deadline, now_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    rep = {"tenantId": tid, "workers": 0, "moved": 0, "missing": 0, "left": 0, "errors": []}
    workers = [(s.id, s.reference, s.to_dict() or {}) for s in
               db.collection("tenants").document(tid).collection("workers").stream()]
    rep["workers"] = len(workers)
    for wid, ref, w in workers:
        jobs = _jobs(wid, w)
        if not jobs:
            continue
        if time.time() > deadline:
            rep["left"] += len(jobs)
            continue
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            results = list(pool.map(lambda j: _safe_move(bucket, fetch, tid, wid, w, j, now_ms), jobs))
        upd, docs = {}, [dict(d) if isinstance(d, dict) else d for d in (w.get("docs") or [])]
        for job, new, err, missing in results:
            field, drive_id, _, idx = job
            if err:
                if missing:
                    rep["missing"] += 1
                else:
                    rep["errors"].append(f"{w.get('name') or wid}: {err}")
                continue
            rep["moved"] += 1
            if field == "doc":
                upd.update(docFileId=new["id"], docUrl=new["url"])
            elif field == "assets":
                upd["assetsFileId"] = new["id"]
            else:
                docs[idx]["fileId"], docs[idx]["url"] = new["id"], new["url"]
                upd["docs"] = docs
        if upd:
            ref.update(upd)
    return rep


def _safe_move(bucket, fetch, tid, wid, w, job, now_ms):
    try:
        return _move_one(bucket, fetch, tid, wid, w, job, now_ms)
    except Exception as e:  # one bad file never stops the rest
        return job, None, str(e)[:200], False


def move_all(db, bucket, fetch, budget_s=TIME_BUDGET_S):
    """fetch(part, tenant_id=None, file_id=None) -> Apps Script exportForMigration reply."""
    t0 = time.time()
    meta = fetch("meta")
    if not meta or meta.get("error"):
        return {"error": (meta or {}).get("error") or "Apps Script did not answer"}
    names = {str(t.get("TenantId") or t.get("tenantId") or ""): t.get("CompanyName") or t.get("companyName") or ""
             for t in (meta.get("tenants") or []) if isinstance(t, dict)}
    out = {"ok": True, "tenants": [], "partial": False}
    for snap in db.collection("tenants").stream():
        rep = move_firm(db, bucket, fetch, snap.id, t0 + budget_s)
        rep["name"] = names.get(snap.id) or (snap.to_dict() or {}).get("companyName") or snap.id
        out["tenants"].append(rep)
        if rep["left"]:
            out["partial"] = True
        if rep["errors"]:
            out["ok"] = False
    out["seconds"] = round(time.time() - t0, 1)
    return out
