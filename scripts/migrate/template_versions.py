"""Documents plan S3, the one-off backfill (docs/documents-plan.md → S3).

  python scripts/migrate/template_versions.py dry-run|apply [--tenant T]

Every contract template with no versions/<n> record of its current version gets that record (its file as it is, its
SHA-256): the versions kept from now on start from today's file. Older versions' files are already gone; their
sign/<rid>/ copies under the workers remain. It only adds — never deletes, moves or changes a file or a record (owner,
2026-11-03: nothing is deleted on its own). dry-run lists what apply would do. Run by migrate-docs.yml
(task: template_versions-*), only with the owner's yes.
"""

import hashlib
import json
import sys

BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]


def backfill(db, bucket, mode, tenants=None, now=""):
    """→ {tenant: {versions: [...], failed: [...]}}; apply writes, dry-run only lists."""
    apply = mode == "apply"
    out = {}
    for t_snap in db.collection("tenants").stream():
        tid = t_snap.id
        if tenants and tid not in tenants:
            continue
        r = out[tid] = {"versions": [], "failed": []}
        col = db.collection("tenants").document(tid).collection("contractTemplates")
        for d in col.stream():
            x = d.to_dict() or {}
            n = int(x.get("version") or 1)
            vref = col.document(d.id).collection("versions").document(str(n))
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
    return out


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
    total = {k: sum(len(r[k]) for r in report.values()) for k in ("versions", "failed")}
    print("TOTAL", mode, json.dumps(total))
    return 1 if total["failed"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
