"""A read-only inventory of the workers' documents, per firm (docs/documents-plan.md → S0).

It sizes the documents plan before anything changes: what each firm keeps in
Storage under its workers (the stored Form 101 PDFs, the signed contracts, the
per-send template copies, the scan pages, the signatures, the old sidecars)
and its contract template files, and which workers and signing requests the
later stages have to take care of.

  python scripts/migrate/docs_inventory.py [--tenant T]

It never writes, moves or deletes anything. Firestore and Storage are reached
only through the read-only wrappers below (`ReadOnlyDb`, `ReadOnlyBucket`):
they expose streaming a collection, reading a document and listing a folder's
names and sizes, and nothing else, so a write call does not exist on them.
tests/auth/test_migrate_docs_inventory.py also checks that no write method is
named anywhere in this file.

For each firm it reports (counts, and bytes where a file is counted):
  form101           files under workers/<w>/form101/: signed (a signing
                    request's form101 part, or the docFileId of a signed
                    worker), unsigned (the docFileId of a worker with no
                    signedAt) and unreferenced (no record points at it)
  docs              files under workers/<w>/docs/: signed contracts (a signing
                    request's contract part, or a docs[] entry with signed:
                    true) and the other uploaded documents
  signCopies        the template copies under workers/<w>/sign/<rid>/, by the
                    request's status (unknown: no request with that id)
  pages, signature  the scan pages and signature PNGs; signatureOrphans: the
                    signatures no worker (sigFileId) or request (sigPath)
                    refers to
  assets            the old scan sidecars
  otherWorkerFiles  any other file under workers/ (also one right under
                    workers/ or workers/<w>/, in no folder)
  deletedWorkerFiles files under a worker id that has no record (also counted
                    in their folder above: an overlap, not a further share)
  templates         the template files under contracts/, and the template
                    records (kept / deleted)
  workers           the count; onSidecar (assetsFileId, no scanPages);
                    pdfOnly (docFileId, no scanPages, no assetsFileId: their
                    photos and signature may exist only inside that PDF);
                    signed (signedAt)
  requests          the signing requests by status; notApplied (signed, no
                    appliedAt: still to be put on the worker)
Lists of worker / request ids are cut at LIST_MAX.

Run by the workflow migrate-docs.yml (workflow_dispatch, the deploy's service
account). It reads real workers' data, so it is run only with the owner's yes.
"""

import json
import sys

BUCKETS = ["schedule-odinson.firebasestorage.app", "schedule-odinson.appspot.com"]
LIST_MAX = 50
STATUSES = ("sent", "signing", "signed", "replaced", "withdrawn")


class _Snap:
    """A read document: its id and its data, nothing else."""

    __slots__ = ("id", "_data")

    def __init__(self, id, data):
        self.id, self._data = id, data

    def to_dict(self):
        return dict(self._data)


class _Coll:
    __slots__ = ("_c",)

    def __init__(self, c):
        self._c = c

    def stream(self):
        for d in self._c.stream():
            yield _Snap(d.id, d.to_dict() or {})


class _DocRef:
    __slots__ = ("_d",)

    def __init__(self, d):
        self._d = d

    def collection(self, name):
        return _Coll(self._d.collection(name))


class _TopColl(_Coll):
    __slots__ = ()

    def document(self, id):
        return _DocRef(self._c.document(id))


class ReadOnlyDb:
    """A Firestore client that can only stream collections: no set, update, delete, batch or transaction."""

    __slots__ = ("_db",)

    def __init__(self, db):
        self._db = db

    def collection(self, name):
        return _TopColl(self._db.collection(name))


class ReadOnlyBucket:
    """A Storage bucket that can only list names and sizes: no upload, delete, copy, patch or hold."""

    __slots__ = ("_b",)

    def __init__(self, bucket):
        self._b = bucket

    def list(self, prefix):
        for b in self._b.list_blobs(prefix=prefix):
            yield b.name, int(b.size or 0)


def _cnt():
    return {"count": 0, "bytes": 0}


def _add(c, size):
    c["count"] += 1
    c["bytes"] += size


def _cut(ids):
    ids = sorted(ids)
    return ids[:LIST_MAX] + ([f"... {len(ids) - LIST_MAX} more"] if len(ids) > LIST_MAX else [])


def inventory_tenant(db, bucket, t):
    """One firm's inventory. db: ReadOnlyDb, bucket: ReadOnlyBucket."""
    tdoc = db.collection("tenants").document(t)
    workers = {d.id: d.to_dict() for d in tdoc.collection("workers").stream()}
    requests = {d.id: d.to_dict() for d in tdoc.collection("signRequests").stream()}
    templates = [d.to_dict() for d in tdoc.collection("contractTemplates").stream()]

    signed_101, signed_contract, sig_refs = set(), set(), set()
    for req in requests.values():
        parts = req.get("parts") or {}
        if (parts.get("form101") or {}).get("path"):
            signed_101.add(parts["form101"]["path"])
        if (parts.get("contract") or {}).get("path"):
            signed_contract.add(parts["contract"]["path"])
        if req.get("sigPath"):
            sig_refs.add(req["sigPath"])
    unsigned_101 = set()
    for w in workers.values():
        if w.get("docFileId"):
            (signed_101 if w.get("signedAt") else unsigned_101).add(w["docFileId"])
        for d in w.get("docs") or []:
            if isinstance(d, dict) and d.get("signed") and d.get("fileId"):
                signed_contract.add(d["fileId"])
        if w.get("sigFileId"):
            sig_refs.add(w["sigFileId"])

    r = {
        "form101": {"signed": _cnt(), "unsigned": _cnt(), "unreferenced": _cnt()},
        "docs": {"signedContracts": _cnt(), "other": _cnt()},
        "signCopies": {s: _cnt() for s in STATUSES + ("unknown",)},
        "pages": _cnt(), "signature": _cnt(), "signatureOrphans": _cnt(), "assets": _cnt(),
        "otherWorkerFiles": _cnt(), "deletedWorkerFiles": _cnt(),
        "templates": {"files": _cnt(), "records": len(templates),
                      "deleted": sum(1 for x in templates if x.get("deletedAt"))},
        "outsideFiles": _cnt(),
    }
    base = f"tenants/{t}/"
    for name, size in bucket.list(base):
        rest = name[len(base):].split("/")
        if rest[0] == "contracts":
            _add(r["templates"]["files"], size)
            continue
        if rest[0] != "workers":
            _add(r["outsideFiles"], size)
            continue
        wid = rest[1] if len(rest) > 2 else ""
        folder = rest[2] if len(rest) > 3 else ""  # a file right under workers/ or workers/<w>/ has no folder
        if wid and wid not in workers:
            _add(r["deletedWorkerFiles"], size)
        if folder == "form101":
            key = "signed" if name in signed_101 else "unsigned" if name in unsigned_101 else "unreferenced"
            _add(r["form101"][key], size)
        elif folder == "docs":
            _add(r["docs"]["signedContracts" if name in signed_contract else "other"], size)
        elif folder == "sign":
            status = (requests.get(rest[3]) or {}).get("status")
            _add(r["signCopies"][status if status in STATUSES else "unknown"], size)
        elif folder == "pages":
            _add(r["pages"], size)
        elif folder == "signature":
            _add(r["signature"], size)
            if name not in sig_refs:
                _add(r["signatureOrphans"], size)
        elif folder == "assets":
            _add(r["assets"], size)
        else:
            _add(r["otherWorkerFiles"], size)

    on_sidecar = [k for k, w in workers.items() if w.get("assetsFileId") and not w.get("scanPages")]
    pdf_only = [k for k, w in workers.items()
                if w.get("docFileId") and not w.get("scanPages") and not w.get("assetsFileId")]
    r["workers"] = {"count": len(workers), "signed": sum(1 for w in workers.values() if w.get("signedAt")),
                    "onSidecar": len(on_sidecar), "onSidecarIds": _cut(on_sidecar),
                    "pdfOnly": len(pdf_only), "pdfOnlyIds": _cut(pdf_only)}
    by_status = {}
    for req in requests.values():
        s = req.get("status") if req.get("status") in STATUSES else "unknown"
        by_status[s] = by_status.get(s, 0) + 1
    not_applied = [k for k, x in requests.items() if x.get("status") == "signed" and not x.get("appliedAt")]
    r["requests"] = {"count": len(requests), "byStatus": by_status,
                     "notApplied": len(not_applied), "notAppliedIds": _cut(not_applied)}
    return r


def inventory(db, bucket, tenants=None, log=print):
    """db / bucket: the real clients or stand-ins; they are wrapped read-only here. → {tenant: report}."""
    db, bucket = ReadOnlyDb(db), ReadOnlyBucket(bucket)
    tids = tenants or [d.id for d in db.collection("tenants").stream()]
    report = {}
    for t in tids:
        report[t] = inventory_tenant(db, bucket, t)
        log(t, json.dumps(report[t], sort_keys=True))
    return report


def totals(report):
    """The sum of every count and byte figure over the firms (the id lists left out)."""
    def walk(acc, x):
        for k, v in x.items():
            if k.endswith("Ids"):
                continue
            if isinstance(v, dict):
                walk(acc.setdefault(k, {}), v)
            elif isinstance(v, int):
                acc[k] = acc.get(k, 0) + v
        return acc
    acc = {}
    for r in report.values():
        walk(acc, r)
    return acc


def main(argv):
    if any(a in ("-h", "--help") for a in argv[1:]):
        print(__doc__)
        return 0
    tenants = None
    if "--tenant" in argv:
        i = argv.index("--tenant")
        if i + 1 >= len(argv) or not argv[i + 1].strip():
            print("--tenant needs a firm id", file=sys.stderr)
            return 2
        tenants = [argv[i + 1]]
    import firebase_admin
    from firebase_admin import firestore, storage
    firebase_admin.initialize_app(options={"projectId": "schedule-odinson"})
    bucket = None
    for name in BUCKETS:  # the project's default bucket: the new name or the old one
        b = storage.bucket(name)
        try:
            b.reload()  # reads the bucket's own metadata only
            bucket = b
            break
        except Exception as e:
            print(f"{name}: {type(e).__name__}", file=sys.stderr)
    if bucket is None:
        print("no Storage bucket reachable", file=sys.stderr)
        return 2
    report = inventory(firestore.client(), bucket, tenants)
    print("TOTAL", json.dumps(totals(report), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
