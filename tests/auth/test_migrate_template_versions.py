"""S3's one-off backfill (scripts/migrate/template_versions.py): the current template version's record — dry-run writes
nothing, apply only adds (never deletes), and a second apply finds nothing left."""

import os
import sys

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # last: functions-auth's main stays `main`
sys.path.insert(0, os.path.dirname(__file__))
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "migrate"))

import contracts  # noqa: E402
import template_versions  # noqa: E402
from test_contracts import Bucket, Db, OWNER, _b64, _pdf  # noqa: E402


def test_dry_run_lists_and_writes_nothing_apply_adds_once():
    db, bucket = Db(), Bucket()
    db.collection("tenants").document("t1").set({"companyName": "Odinson"})
    t = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": _b64(contracts.light(_pdf())[0]), "name": "A"})["template"]
    for p in [p for p in db.data if "versions" in p]:  # as saved before S3
        del db.data[p]
    files, data = dict(bucket.store), {k: repr(v) for k, v in db.data.items()}
    r = template_versions.backfill(db, bucket, "dry-run", now="2026-11-03T00:00:00.000Z")["t1"]
    assert r == {"versions": [t["id"] + " v1"], "failed": []}
    assert bucket.store == files and {k: repr(v) for k, v in db.data.items()} == data
    r = template_versions.backfill(db, bucket, "apply", now="2026-11-03T00:00:00.000Z")["t1"]
    assert r["failed"] == [] and bucket.store == files
    v = db.data[("tenants", "t1", "contractTemplates", t["id"], "versions", "1")]
    assert v["fileId"] == db.data[("tenants", "t1", "contractTemplates", t["id"])]["fileId"] and v["backfilled"] and v["sha256"]
    assert template_versions.backfill(db, bucket, "apply")["t1"] == {"versions": [], "failed": []}


def test_the_script_never_deletes():
    src = open(template_versions.__file__, encoding="utf-8").read()
    assert ".delete(" not in src and "DELETE_FIELD" not in src
