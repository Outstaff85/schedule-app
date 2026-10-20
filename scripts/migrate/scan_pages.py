"""Splits the old scan sidecars into pages, once (docs/contracts.md → Scanned pages).

Before D1 a worker's scan was kept as one JSON file in Storage (the sidecar,
`assetsFileId`: the ID card or passport, the other pages and the signature,
each as base64 inside). Since D1 every page is its own JPEG and the signature
a small PNG, listed on the worker (`scanPages`, `sigFileId`, `sigSavedAt`).
The app still reads a sidecar that was not split yet; this script splits them.

  python scripts/migrate/scan_pages.py dry-run [--tenant T]   reads and reports, writes nothing
  python scripts/migrate/scan_pages.py apply   [--tenant T]   writes the pages and the worker's
                                                              fields; keeps the sidecar file
  python scripts/migrate/scan_pages.py cleanup [--tenant T]   deletes the sidecars already split

`apply` writes the pages under tenants/<t>/workers/<w>/pages/ and the
signature under …/signature/, then updates only the worker's own fields
(`scanPages`, `sigFileId`, `sigSavedAt`, `assetsMigratedFrom` = the
sidecar's path, `assetsFileId` removed) — a field update, so an edit made at
the same time is not lost. The sidecar file stays until `cleanup`, so a
worker can be put back by hand. Run by the workflow migrate-scan-pages.yml
(workflow_dispatch, the deploy's service account) — only with the owner's yes
for `apply` and `cleanup` (real workers' data).
"""

import base64
import io
import json
import re
import sys

KINDS = ("id_front", "id_back", "sefach", "passport", "other")
MAX_DIM = 2000
BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]


def page_kind(kind, primary, doc_type):
    """The same rule as pageKind in src/manager/data/pages.ts."""
    if kind in KINDS:
        return kind
    if primary:
        return "passport" if doc_type == "passport" else "id_front"
    return "other"


def as_jpeg(raw, media_type):
    """A page as stored by the app: a JPEG at most MAX_DIM on its long side.
    A JPEG already small enough stays byte for byte; without Pillow, or for
    bytes it can't open, the page stays as it was."""
    try:
        from PIL import Image
    except ImportError:
        return raw
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return raw
    if max(im.size) <= MAX_DIM and (media_type or "image/jpeg") == "image/jpeg" and im.format == "JPEG":
        return raw
    if max(im.size) > MAX_DIM:
        s = MAX_DIM / max(im.size)
        im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
    if im.mode != "RGB":
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.getchannel("A") if "A" in im.getbands() else None)
        im = bg
    out = io.BytesIO()
    im.save(out, "JPEG", quality=85, optimize=True)
    return out.getvalue()


def _b64(s):
    s = str(s or "")
    if s.startswith("data:"):
        s = s.split(",", 1)[-1]
    return base64.b64decode(s) if s else b""


def _saved_at(path):
    """The sidecar's time from its name (<ms>-<name>), as ISO; '' when not there."""
    m = re.match(r"^(\d{12,14})-", path.rsplit("/", 1)[-1])
    if not m:
        return ""
    import datetime
    return datetime.datetime.fromtimestamp(int(m.group(1)) / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def split_sidecar(worker, sidecar_path, data, stamp):
    """One worker's sidecar → (files, fields): files = [(path, bytes, contentType, kind)] to write,
    fields = what the worker gets. `stamp` (ms) names the new files."""
    base = sidecar_path.split("/assets/")[0]
    at = _saved_at(sidecar_path)
    files, pages = [], []
    front = _b64(data.get("scanB64"))
    if front:
        kind = page_kind(None, True, worker.get("docType"))
        path = f"{base}/pages/{stamp}-0-{kind}.jpg"
        files.append((path, as_jpeg(front, data.get("scanMediaType")), "image/jpeg", "pages"))
        pages.append({"fileId": path, "kind": kind, "primary": True, "savedAt": at})
    others = data.get("extraPages") if isinstance(data.get("extraPages"), list) else []
    for i, p in enumerate(others):
        raw = _b64((p or {}).get("b64"))
        if not raw:
            continue
        kind = page_kind((p or {}).get("kind"), False, worker.get("docType"))
        path = f"{base}/pages/{stamp}-{i + 1}-{kind}.jpg"
        files.append((path, as_jpeg(raw, (p or {}).get("mediaType")), "image/jpeg", "pages"))
        pages.append({"fileId": path, "kind": kind, "savedAt": at})
    fields = {"scanPages": pages}
    sig = _b64(data.get("sigPng"))
    if sig:
        path = f"{base}/signature/{stamp}-signature.png"
        files.append((path, sig, "image/png", "signature"))
        fields["sigFileId"] = path
        fields["sigSavedAt"] = at
    return files, fields


def plan(workers):
    """The workers to split: a sidecar and no pages yet."""
    return [w for w in workers if w.get("assetsFileId") and not w.get("scanPages")]


def migrate(db, bucket, mode, tenants=None, now_ms=None, delete_field=None, log=print):
    """db: a Firestore client; bucket: a Storage bucket. → the report {tenant: {...}}."""
    import time
    stamp = now_ms or int(time.time() * 1000)
    report = {}
    tids = tenants or [d.id for d in db.collection("tenants").stream()]
    for t in tids:
        wcol = db.collection("tenants").document(t).collection("workers")
        workers = [dict(d.to_dict() or {}, id=d.id) for d in wcol.stream()]
        r = {"workers": 0, "pages": 0, "signatures": 0, "sidecarBytes": 0, "pageBytes": 0, "failed": [], "cleaned": 0}
        if mode == "cleanup":
            for w in workers:
                old = w.get("assetsMigratedFrom")
                if not old or not w.get("scanPages") and not w.get("sigFileId"):
                    continue
                blob = bucket.blob(old)
                if blob.exists():
                    blob.delete()
                wcol.document(w["id"]).update({"assetsMigratedFrom": delete_field})
                r["cleaned"] += 1
            report[t] = r
            log(t, json.dumps(r))
            continue
        for w in plan(workers):
            path = w["assetsFileId"]
            if not path.startswith(f"tenants/{t}/workers/{w['id']}/assets/"):
                r["failed"].append({"worker": w["id"], "reason": "the sidecar is not in the worker's folder"})
                continue
            blob = bucket.blob(path)
            if not blob.exists():
                r["failed"].append({"worker": w["id"], "reason": "the sidecar is gone"})
                continue
            raw = blob.download_as_bytes()
            try:
                data = json.loads(raw.decode("utf-8"))
                files, fields = split_sidecar(w, path, data, stamp)
            except Exception as e:  # a broken sidecar is reported, never guessed
                r["failed"].append({"worker": w["id"], "reason": str(e)[:200]})
                continue
            r["workers"] += 1
            r["sidecarBytes"] += len(raw)
            r["pages"] += len(fields["scanPages"])
            r["signatures"] += 1 if fields.get("sigFileId") else 0
            r["pageBytes"] += sum(len(f[1]) for f in files)
            if mode != "apply":
                continue
            meta = {"workerId": w["id"]}
            old_meta = getattr(blob, "metadata", None) or {}
            if old_meta.get("hrId"):
                meta["hrId"] = old_meta["hrId"]
            for fpath, data_bytes, ctype, kind in files:
                nb = bucket.blob(fpath)
                nb.metadata = dict(meta, kind=kind)
                nb.upload_from_string(data_bytes, content_type=ctype)
            wcol.document(w["id"]).update(dict(fields, assetsMigratedFrom=path, assetsFileId=delete_field))
        report[t] = r
        log(t, json.dumps(r))
    return report


def main(argv):
    mode = argv[1] if len(argv) > 1 else "dry-run"
    if mode not in ("dry-run", "apply", "cleanup"):
        print(__doc__)
        return 2
    tenants = [argv[argv.index("--tenant") + 1]] if "--tenant" in argv else None
    import firebase_admin
    from firebase_admin import firestore, storage
    firebase_admin.initialize_app(options={"projectId": "schedule-odinson"})
    bucket = None
    for name in BUCKETS:  # the project's default bucket: the new name or the old one
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
    report = migrate(firestore.client(), bucket, mode, tenants, delete_field=firestore.DELETE_FIELD)
    total = {k: sum(r[k] for r in report.values()) for k in ("workers", "pages", "signatures", "sidecarBytes", "pageBytes", "cleaned")}
    total["failed"] = sum(len(r["failed"]) for r in report.values())
    print("TOTAL", mode, json.dumps(total))
    return 1 if total["failed"] else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
