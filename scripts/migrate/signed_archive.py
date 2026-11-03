"""Documents plan S3, the one-off backfill (docs/documents-plan.md → S3).

  python scripts/migrate/signed_archive.py dry-run|apply [--tenant T]

Two things, both only adding — it never deletes, moves or changes a file, and never deletes a record (owner,
2026-11-03: nothing is deleted on its own, only by a person's own delete):
  versions  every contract template with no versions/<n> of its current version gets that record (its file as it is,
            its SHA-256): the versions kept from now on start from today's file. Older versions' files are already gone;
            their sign/<rid>/ copies under the workers remain.
  archive   every signed part (a signing request's, or a done move's into the firm, form101 / contract) not yet copied (no parts.<which>.archived) is copied
            into the worker's archive folder (functions/archive.py: archive/<firm>/<given surname ID>/Form 101 | Contracts)
            and its path written on the part.
dry-run lists what apply would do. Run by migrate-docs.yml (task: signed_archive), only with the owner's yes.
"""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "functions"))

import archive  # noqa: E402

BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]


def backfill(db, bucket, mode, tenants=None, now="", worker_of=None):
    """→ {tenant: {versions: [...], archived: [...], failed: [...]}}; apply writes, dry-run only lists."""
    apply = mode == "apply"
    out = {}
    for t_snap in db.collection("tenants").stream():
        tid = t_snap.id
        if tenants and tid not in tenants:
            continue
        r = out[tid] = {"versions": [], "archived": [], "failed": []}
        t = db.collection("tenants").document(tid)
        for d in t.collection("contractTemplates").stream():
            x = d.to_dict() or {}
            n = int(x.get("version") or 1)
            vref = t.collection("contractTemplates").document(d.id).collection("versions").document(str(n))
            if vref.get().exists or not x.get("fileId"):
                continue
            blob = bucket.blob(x["fileId"])
            if not blob.exists():
                r["failed"].append({"template": d.id, "why": "no file " + x["fileId"]})
                continue
            r["versions"].append(d.id + " v" + str(n))
            if apply:
                data = blob.download_as_bytes()
                vref.create({"fileId": x["fileId"], "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                             "pages": x.get("pages"), "placed": x.get("placed") or [], "marks": x.get("marks") or [],
                             "unknown": x.get("unknown") or [], "pictures": x.get("pictures") or [],
                             "createdAt": x.get("updatedAt") or x.get("createdAt") or now, "createdBy": x.get("createdBy") or "",
                             "backfilled": now})
        for q in t.collection("signRequests").stream():
            req = q.to_dict() or {}
            for which, part in (req.get("parts") or {}).items():
                if not isinstance(part, dict) or not part.get("path") or part.get("archived") or which not in archive.FOLDERS:
                    continue
                r["archived"].append(q.id + " " + which)
                if not apply:
                    continue
                try:
                    worker = worker_of(tid, req.get("workerId")) if worker_of else None
                    path = archive.put_signed(db, bucket, tid, q.id, req, which, part, worker)
                    if path:
                        t.collection("signRequests").document(q.id).update({"parts." + which + ".archived": path})
                except Exception as e:
                    r["failed"].append({"request": q.id, "which": which, "why": str(e)[:300]})
        # the moves into this firm: signed by the worker's own link, kept under the new firm's worker
        for q in db.collection("transferRequests").stream():
            req = q.to_dict() or {}
            if req.get("toTenant") != tid or req.get("status") != "done":
                continue
            for which, part in (req.get("parts") or {}).items():
                if not isinstance(part, dict) or not part.get("path") or part.get("archived") or which not in archive.FOLDERS:
                    continue
                r["archived"].append("move " + q.id + " " + which)
                if not apply:
                    continue
                try:
                    path = archive.put_signed(db, bucket, tid, q.id, archive_request(req), which, part,
                                              (req.get("frozen") or {}).get("personal"))
                    if path:
                        db.collection("transferRequests").document(q.id).update({"parts." + which + ".archived": path})
                except Exception as e:
                    r["failed"].append({"move": q.id, "which": which, "why": str(e)[:300]})
    return out


def archive_request(req):
    """The same as functions/transfer.py archive_request (kept here so the script needs no Firebase Functions import)."""
    import re
    fz = req.get("frozen") or {}
    return {"workerId": req.get("newWorkerId"), "signDate": req.get("signDate") or fz.get("date"), "way": "remote",
            "signedAtIso": req.get("signedAtIso") or "", "templatePath": fz.get("templatePath"),
            "templateName": re.sub(r"\.pdf$", "", str(fz.get("contractName") or "contract"))}


def main(argv):
    mode = argv[1] if len(argv) > 1 else ""
    if mode not in ("dry-run", "apply"):
        print(__doc__)
        return 2
    tenants = [argv[argv.index("--tenant") + 1]] if "--tenant" in argv else None
    import datetime
    import firebase_admin
    from firebase_admin import firestore, storage
    firebase_admin.initialize_app(options={"projectId": "schedule-odinson"})
    bucket = None
    for name in BUCKETS:
        b = storage.bucket(name)
        try:
            b.reload()
            bucket = b
            break
        except Exception as e:
            print(f"{name}: {type(e).__name__}", file=sys.stderr)
    if bucket is None:
        print("no Storage bucket reachable", file=sys.stderr)
        return 2
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    report = backfill(firestore.client(), bucket, mode, tenants, now)
    for tid, r in report.items():
        print(tid, json.dumps(r, ensure_ascii=False))
    total = {k: sum(len(r[k]) for r in report.values()) for k in ("versions", "archived", "failed")}
    print("TOTAL", mode, json.dumps(total))
    return 1 if total["failed"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
