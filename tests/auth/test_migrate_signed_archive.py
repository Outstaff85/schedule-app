"""S3's one-off backfill (scripts/migrate/signed_archive.py): the current template version's record and the signed
parts' archive copies — dry-run writes nothing, apply only adds (never deletes), and a second apply finds nothing left."""

import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "migrate"))

import signed_archive  # noqa: E402
import signing  # noqa: E402
from test_signing import _setup, _signing, build101, OWNER  # noqa: E402


def _signed_before_s3():
    db, bucket, t = _setup()
    db.collection("tenants").document("t1").set({"companyName": "Odinson"})
    f = _signing(db, bucket, t)
    for which in ("form101", "contract"):
        signing.run_worker(db, bucket, {"action": "build", "token": "tok-avi", "which": which}, build101, finder=f)
    # as it was before S3: no archive copy, no version record
    for k in [k for k in bucket.store if k.startswith("archive/")]:
        del bucket.store[k]
    for p, d in db.data.items():
        if p[:3] == ("tenants", "t1", "signRequests"):
            for part in d["parts"].values():
                part.pop("archived", None)
    for p in [p for p in db.data if "versions" in p]:
        del db.data[p]
    return db, bucket, t


def test_dry_run_lists_and_writes_nothing_apply_adds_once():
    db, bucket, t = _signed_before_s3()
    files, data = dict(bucket.store), {k: repr(v) for k, v in db.data.items()}
    r = signed_archive.backfill(db, bucket, "dry-run", now="2026-11-03T00:00:00.000Z")["t1"]
    assert r["versions"] == [t["id"] + " v1"] and len(r["archived"]) == 2 and r["failed"] == []
    assert bucket.store == files and {k: repr(v) for k, v in db.data.items()} == data
    r = signed_archive.backfill(db, bucket, "apply", now="2026-11-03T00:00:00.000Z")["t1"]
    assert r["failed"] == [] and len(r["archived"]) == 2
    assert all(k in bucket.store and bucket.store[k] == v for k, v in files.items())  # nothing removed or changed
    v = db.data[("tenants", "t1", "contractTemplates", t["id"], "versions", "1")]
    assert v["fileId"] == db.data[("tenants", "t1", "contractTemplates", t["id"])]["fileId"] and v["backfilled"]
    req = next(d for p, d in db.data.items() if p[:3] == ("tenants", "t1", "signRequests"))
    assert all(part["archived"] in bucket.store for part in req["parts"].values())
    assert sum(1 for k in bucket.store if k.startswith("archive/Odinson/")) == 5
    again = signed_archive.backfill(db, bucket, "apply")["t1"]
    assert again == {"versions": [], "archived": [], "failed": []}


def test_the_script_never_deletes():
    src = open(signed_archive.__file__, encoding="utf-8").read()
    assert ".delete(" not in src and "DELETE_FIELD" not in src
    assert OWNER  # the same firm as the signing tests
