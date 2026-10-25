"""The read-only inventory of the workers' documents (scripts/migrate/docs_inventory.py,
docs/documents-plan.md → S0): the counts by prefix, and that it never writes.

The Firestore part runs on the Firestore emulator (npm run test:auth) and checks that the
emulator's documents are the same after the run; the Storage bucket is an in-memory stand-in
that fails on any write. Without the emulator the emulator test is skipped and the stand-in
tests still run."""

import ast
import os
import sys
import urllib.request

import pytest

HERE = os.path.dirname(__file__)
SCRIPT = os.path.join(HERE, "..", "..", "scripts", "migrate", "docs_inventory.py")
sys.path.insert(0, os.path.join(HERE, "..", "..", "scripts", "migrate"))

import docs_inventory as inv  # noqa: E402

T = "inv-firm"
W = f"tenants/{T}/workers"

# Writes on a Firestore client / reference / Storage bucket or blob.
WRITES = {"set", "update", "delete", "create", "batch", "transaction", "commit", "bulk_writer", "recursive_delete",
          "upload_from_string", "upload_from_file", "upload_from_filename", "patch", "copy_blob", "rename_blob",
          "rewrite", "compose", "make_public", "make_private", "delete_blob", "delete_blobs", "acl",
          "temporary_hold", "event_based_hold", "metadata"}


class Writes(Exception):
    pass


class FakeBlob:
    def __init__(self, name, size):
        self.name, self.size = name, size

    def __getattr__(self, attr):
        raise Writes(f"blob.{attr}")


class FakeBucket:
    """list_blobs only; anything else (an upload, a delete, a copy, a hold) fails the test."""

    def __init__(self, files):
        self.files = dict(files)

    def list_blobs(self, prefix=""):
        return [FakeBlob(n, s) for n, s in sorted(self.files.items()) if n.startswith(prefix)]

    def __getattr__(self, attr):
        raise Writes(f"bucket.{attr}")


FILES = {
    # Form 101: the signed one of w1 (its request's part), its earlier unsigned one (no record), w2's unsigned
    f"{W}/w1/form101/2-signed.pdf": 300,
    f"{W}/w1/form101/1-old.pdf": 200,
    f"{W}/w2/form101/1-unsigned.pdf": 150,
    # the signed contract of w1, a signed docs[] entry of w3, an uploaded document
    f"{W}/w1/docs/2-contract.pdf": 100,
    f"{W}/w3/docs/1-legacy-contract.pdf": 90,
    f"{W}/w2/docs/1-upload.pdf": 40,
    # template copies by request
    f"{W}/w1/sign/r1/contract-template.pdf": 70,
    f"{W}/w2/sign/r2/contract-template.pdf": 60,
    f"{W}/w2/sign/r3/contract-template.pdf": 50,
    f"{W}/w2/sign/rgone/contract-template.pdf": 5,
    # pages, signatures (w1's and an orphan), a sidecar, something else
    f"{W}/w1/pages/1-0-id_front.jpg": 500,
    f"{W}/w1/pages/1-1-sefach.jpg": 400,
    f"{W}/w1/signature/2-signature.png": 9,
    f"{W}/w1/signature/1-signature.png": 8,
    f"{W}/w4/assets/1-x_assets.json": 1000,
    f"{W}/w4/other/x.bin": 3,
    # a worker that has no record any more
    f"{W}/wgone/pages/1-0-id_front.jpg": 11,
    # the firm's contract templates, and a file outside workers/
    f"tenants/{T}/contracts/tpl1/1.pdf": 77,
    f"tenants/{T}/logo.png": 2,
    # another firm's file: never counted here
    "tenants/other/workers/w1/pages/1.jpg": 999,
}

WORKERS = {
    "w1": {"name": "Signed", "signedAt": "2026-10-01", "docFileId": f"{W}/w1/form101/2-signed.pdf",
           "scanPages": [{"fileId": f"{W}/w1/pages/1-0-id_front.jpg", "kind": "id_front", "primary": True}],
           "sigFileId": f"{W}/w1/signature/2-signature.png",
           "docs": [{"fileId": f"{W}/w1/docs/2-contract.pdf", "signed": True}]},
    "w2": {"name": "Unsigned", "docFileId": f"{W}/w2/form101/1-unsigned.pdf",
           "scanPages": [{"fileId": "x", "kind": "passport", "primary": True}],
           "docs": [{"fileId": f"{W}/w2/docs/1-upload.pdf"}]},
    "w3": {"name": "Pdf only", "docFileId": f"{W}/w3/form101/9-missing.pdf",
           "docs": [{"fileId": f"{W}/w3/docs/1-legacy-contract.pdf", "signed": True}]},
    "w4": {"name": "Sidecar", "assetsFileId": f"{W}/w4/assets/1-x_assets.json"},
}

REQUESTS = {
    "r1": {"workerId": "w1", "status": "signed", "sigPath": f"{W}/w1/signature/2-signature.png",
           "parts": {"form101": {"path": f"{W}/w1/form101/2-signed.pdf"},
                     "contract": {"path": f"{W}/w1/docs/2-contract.pdf"}}},
    "r2": {"workerId": "w2", "status": "replaced"},
    "r3": {"workerId": "w2", "status": "sent"},
    "r4": {"workerId": "w1", "status": "signed", "appliedAt": "2026-10-02", "parts": {}},
}

TEMPLATES = {"tpl1": {"name": "Main", "fileId": f"tenants/{T}/contracts/tpl1/1.pdf"},
             "tpl0": {"name": "Old", "deletedAt": "2026-09-01"}}


def _expect(r):
    assert r["form101"] == {"signed": {"count": 1, "bytes": 300}, "unsigned": {"count": 1, "bytes": 150},
                            "unreferenced": {"count": 1, "bytes": 200}}
    assert r["docs"] == {"signedContracts": {"count": 2, "bytes": 190}, "other": {"count": 1, "bytes": 40}}
    sc = r["signCopies"]
    assert (sc["signed"], sc["replaced"], sc["sent"], sc["unknown"]) == (
        {"count": 1, "bytes": 70}, {"count": 1, "bytes": 60}, {"count": 1, "bytes": 50}, {"count": 1, "bytes": 5})
    assert sc["signing"] == sc["withdrawn"] == {"count": 0, "bytes": 0}
    assert r["pages"] == {"count": 3, "bytes": 911}
    assert r["signature"] == {"count": 2, "bytes": 17}
    assert r["signatureOrphans"] == {"count": 1, "bytes": 8}
    assert r["assets"] == {"count": 1, "bytes": 1000}
    assert r["otherWorkerFiles"] == {"count": 1, "bytes": 3}
    assert r["deletedWorkerFiles"] == {"count": 1, "bytes": 11}
    assert r["outsideFiles"] == {"count": 1, "bytes": 2}
    assert r["templates"] == {"files": {"count": 1, "bytes": 77}, "records": 2, "deleted": 1}
    assert r["workers"] == {"count": 4, "signed": 1, "onSidecar": 1, "onSidecarIds": ["w4"],
                            "pdfOnly": 1, "pdfOnlyIds": ["w3"]}
    assert r["requests"] == {"count": 4, "byStatus": {"signed": 2, "replaced": 1, "sent": 1},
                             "notApplied": 1, "notAppliedIds": ["r1"]}


# ---- in-memory Firestore stand-in that fails on any write ----

class FakeSnap:
    def __init__(self, id, data):
        self.id, self._data = id, data

    def to_dict(self):
        return dict(self._data)


class FakeColl:
    def __init__(self, data):
        self.data = data

    def stream(self):
        return [FakeSnap(k, v) for k, v in self.data.items()]

    def __getattr__(self, attr):
        raise Writes(f"collection.{attr}")


class FakeDoc:
    def __init__(self, data):
        self.data = data

    def collection(self, name):
        return FakeColl(self.data.get(name, {}))

    def __getattr__(self, attr):
        raise Writes(f"document.{attr}")


class FakeDb:
    def __init__(self, tenants):
        self.tenants = tenants

    def collection(self, name):
        assert name == "tenants"
        return FakeTenants(self.tenants)

    def __getattr__(self, attr):
        raise Writes(f"db.{attr}")


class FakeTenants(FakeColl):
    def stream(self):
        return [FakeSnap(t, {}) for t in self.data]

    def document(self, id):
        return FakeDoc(self.data[id])


def _fake_db():
    return FakeDb({T: {"workers": WORKERS, "signRequests": REQUESTS, "contractTemplates": TEMPLATES}})


def test_counts_by_prefix_on_stand_ins():
    rep = inv.inventory(_fake_db(), FakeBucket(FILES), log=lambda *a: None)
    assert list(rep) == [T]
    _expect(rep[T])
    tot = inv.totals(rep)
    assert tot["pages"] == {"count": 3, "bytes": 911}
    assert "onSidecarIds" not in tot["workers"]


def test_one_tenant_only():
    db = _fake_db()
    db.tenants["other"] = {"workers": {}, "signRequests": {}, "contractTemplates": {}}
    rep = inv.inventory(db, FakeBucket(FILES), tenants=["other"], log=lambda *a: None)
    assert list(rep) == ["other"]
    assert rep["other"]["pages"] == {"count": 1, "bytes": 999}


def test_id_lists_are_cut():
    many = {f"w{i:03}": {"assetsFileId": "a"} for i in range(inv.LIST_MAX + 7)}
    rep = inv.inventory(FakeDb({T: {"workers": many}}), FakeBucket({}), log=lambda *a: None)
    ids = rep[T]["workers"]["onSidecarIds"]
    assert rep[T]["workers"]["onSidecar"] == inv.LIST_MAX + 7
    assert len(ids) == inv.LIST_MAX + 1 and ids[-1] == "... 7 more"


def test_wrappers_have_no_write():
    """The script reaches Firestore and Storage only through wrappers that cannot write."""
    db = inv.ReadOnlyDb(_fake_db())
    top = db.collection("tenants")
    doc = top.document(T)
    sub = doc.collection("workers")
    bucket = inv.ReadOnlyBucket(FakeBucket(FILES))
    snap = next(iter(sub.stream()))
    banned = WRITES | {"add", "blob", "get_blob", "list_blobs", "reference", "collections"}
    for obj in (db, top, doc, sub, bucket, snap):
        for name in banned:
            assert not hasattr(obj, name), f"{type(obj).__name__}.{name}"
    # a read snapshot's data is a copy: changing it changes nothing stored
    d = snap.to_dict()
    d["name"] = "changed"
    assert snap.to_dict()["name"] != "changed"


def test_source_names_no_write_method():
    """No write method is called anywhere in the script (comments and docstrings aside)."""
    tree = ast.parse(open(SCRIPT, encoding="utf-8").read())
    called = {n.func.attr for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}
    assigned = {t.attr for n in ast.walk(tree) if isinstance(n, (ast.Assign, ast.AugAssign))
                for t in (n.targets if isinstance(n, ast.Assign) else [n.target]) if isinstance(t, ast.Attribute)}
    assert not (called & WRITES), sorted(called & WRITES)
    # only the wrappers' own fields are set (in their __init__), never a blob's or a document's
    assert assigned <= {"id", "_data", "_c", "_d", "_db", "_b"}, sorted(assigned)


# ---- the Firestore emulator ----

def _emulator_db():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("needs the Firestore emulator (npm run test:auth)")
    import firebase_admin
    from firebase_admin import credentials, firestore
    if not firebase_admin._apps:
        class _Anon(credentials.Base):
            def get_credential(self):
                from google.auth.credentials import AnonymousCredentials
                return AnonymousCredentials()
        firebase_admin.initialize_app(_Anon(), {"projectId": os.environ.get("GCLOUD_PROJECT", "demo-schedule")})
    return firestore.client()


def _clear():
    project = os.environ.get("GCLOUD_PROJECT", "demo-schedule")
    req = urllib.request.Request(
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/emulator/v1/projects/{project}/databases/(default)/documents",
        method="DELETE")
    urllib.request.urlopen(req).read()


def _dump(db):
    """Every document in the emulator, with its update time: a write shows as a change."""
    out = {}

    def walk(colls):
        for c in colls:
            for d in c.stream():
                out[d.reference.path] = (d.to_dict(), d.update_time)
                walk(d.reference.collections())
    walk(db.collections())
    return out


def test_emulator_counts_and_no_writes():
    db = _emulator_db()
    _clear()
    db.collection("tenants").document(T).set({"name": "Inventory firm"})
    db.collection("tenants").document("other").set({"name": "Other"})
    tref = db.collection("tenants").document(T)
    for coll, docs in (("workers", WORKERS), ("signRequests", REQUESTS), ("contractTemplates", TEMPLATES)):
        for k, v in docs.items():
            tref.collection(coll).document(k).set(v)
    before = _dump(db)
    bucket = FakeBucket(FILES)
    rep = inv.inventory(db, bucket, log=lambda *a: None)
    assert _dump(db) == before
    assert bucket.files == FILES
    assert set(rep) == {T, "other"}
    _expect(rep[T])
    assert rep["other"]["pages"] == {"count": 1, "bytes": 999}
    assert rep["other"]["workers"]["count"] == 0
    _clear()
