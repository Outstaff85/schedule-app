"""The deletion on request (scripts/scan-train/delete_data.py; docs/scan-training.md → 2): one firm's or one
worker's training data — full documents, page copies and scan attempts (attempts/new, used, exam and golden
in the bucket, training/attempts/ in Firebase) — is found by the firm in each attempt's answer.json or the
worker in its outcome-*.json and the page copies' records; it prints counts per area and deletes nothing
without --apply. Hugging Face, the bucket, Firestore and Storage are all mocks here."""
import importlib.util
import json
import pathlib
import sys
import types

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "scan-train"
sys.path.insert(0, str(HERE))

_spec = importlib.util.spec_from_file_location("delete_data", HERE / "delete_data.py")
delete_data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(delete_data)


class Api:
    """The private bucket: {path: bytes}; deletes are recorded, never applied."""
    def __init__(self, files):
        self.files, self.deleted, self.listed = files, [], []

    def list_bucket_tree(self, bucket_id, prefix="", recursive=False):
        self.listed.append(prefix)
        return [types.SimpleNamespace(path=p) for p in sorted(self.files) if p.startswith(prefix)]

    def download_bucket_files(self, bucket_id, files, raise_on_missing_files=False):
        for path, dest in files:
            pathlib.Path(dest).write_bytes(self.files[path])

    def batch_bucket_files(self, bucket_id, add=None, delete=None):
        self.deleted += list(delete or [])


class Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def download_as_bytes(self):
        return self.store.files[self.name]

    def exists(self):
        return self.name in self.store.files

    def delete(self):
        self.store.deleted.append(self.name)


class Bucket:
    """Firebase Storage: {name: bytes}."""
    def __init__(self, files):
        self.files, self.deleted = files, []

    def list_blobs(self, prefix=""):
        return [Blob(self, n) for n in sorted(self.files) if n.startswith(prefix)]

    def blob(self, name):
        return Blob(self, name)


class Snap:
    def __init__(self, store, rid, rec):
        self.store, self.id, self.rec = store, rid, rec
        self.reference = types.SimpleNamespace(delete=lambda: store.deleted.append(rid))

    def to_dict(self):
        return dict(self.rec)


class Db:
    """Firestore scanTraining: {id: record}."""
    def __init__(self, records):
        self.records, self.deleted, self.asked = records, [], []

    def collection(self, name):
        assert name == "scanTraining"
        return self

    def where(self, field, op, value):
        self.asked.append((field, op, value))
        self._q = (field, value)
        return self

    def stream(self):
        field, value = self._q
        return [Snap(self, rid, r) for rid, r in self.records.items() if r.get(field) == value]


js = lambda o: json.dumps(o).encode()


def attempt(area, tenant, outcome_worker=None, name="a"):
    """An attempt's folder in an area: picture, answer.json and, when told, a saved outcome."""
    d = f"{area}site/2026-10-2{len(area) % 10}/{name}"
    files = {f"{d}/picture.jpg": b"\xff\xd8", f"{d}/answer.json": js({"id": name, "tenantId": tenant})}
    if outcome_worker:
        files[f"{d}/outcome-20261024T101010000000.json"] = js({"outcome": "saved", "workerId": outcome_worker, "page": None})
    return files


@pytest.fixture
def world(monkeypatch):
    hf = {}
    hf.update(attempt("attempts/new/", "t1", "w1", "n1"))
    hf.update(attempt("attempts/used/v5/", "t1", None, "u1"))
    hf.update(attempt("attempts/exam/", "t1", "w2", "e1"))
    hf.update(attempt("attempts/golden/", "t1", None, "g1"))
    hf.update(attempt("attempts/new/", "t9", "w9", "other"))   # another firm's: never touched
    hf.update({"documents/t1/2026-10/d1/page-1.jpg": b"\xff\xd8", "documents/t1/2026-10/d1/record.json": js({"tenantId": "t1", "workerId": "w1"}),
               "documents/t9/2026-10/d9/page-1.jpg": b"\xff\xd8", "documents/t9/2026-10/d9/record.json": js({"tenantId": "t9", "workerId": "w9"})})
    fb = Bucket({**{"training/" + k: v for k, v in attempt("attempts/new/", "t1", "w1", "f1").items()},
                 **{"training/" + k: v for k, v in attempt("attempts/new/", "t9", None, "f9").items()},
                 "training/scan/2026-10/r2-page.jpg": b"\xff\xd8"})
    fs = Db({"r2": {"tenantId": "t1", "workerId": "w1", "pageImage": "training/scan/2026-10/r2-page.jpg"},
             "r3": {"tenantId": "t9", "workerId": "w9", "pageImage": None}})
    records = [("r1", {"tenantId": "t1", "workerId": "w1", "image": None, "pageImage": "doctype/2026-10/r1.jpg", "_path": "records/2026-10/r1.json"}),
               ("r4", {"tenantId": "t1", "workerId": None, "image": None, "pageImage": "doctype/2026-10/r4.jpg", "_path": "records/2026-10/r4.json"}),
               ("r5", {"tenantId": "t9", "workerId": "w9", "image": None, "pageImage": "doctype/2026-10/r5.jpg", "_path": "records/2026-10/r5.json"})]
    api = Api(hf)
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=lambda: api))
    monkeypatch.setattr(delete_data, "bucket", lambda: fb)
    monkeypatch.setattr(delete_data, "db", lambda: fs)
    monkeypatch.setattr(delete_data, "data_records", lambda prefix="records/": records)
    return types.SimpleNamespace(api=api, fb=fb, fs=fs)


def run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["delete_data.py", *argv])
    delete_data.main()


def nothing_deleted(w):
    assert w.api.deleted == [] and w.fb.deleted == [] and w.fs.deleted == []


def test_a_firm_finds_its_attempts_in_new_used_exam_and_golden_by_answer_json(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "t1")
    out = capsys.readouterr().out
    assert "attempts: Hugging Face 4 folders (10 files); Firebase 1 folders (3 files)" in out
    assert "documents: Hugging Face 2 files; Firebase 0 files" in out
    assert "page copies: Hugging Face 2 records (4 files); Firebase 1 records" in out
    assert "Nothing deleted" in out and "t1" not in out  # counts only, never a path
    assert set(delete_data.ATTEMPT_AREAS) <= set(world.api.listed)
    nothing_deleted(world)


def test_a_firm_with_apply_deletes_exactly_its_own(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "t1", "--apply")
    gone = set(world.api.deleted)
    assert {p for p in world.api.files if "/n1/" in p or "/u1/" in p or "/e1/" in p or "/g1/" in p} <= gone
    assert not any("/other/" in p or p.startswith("documents/t9/") for p in gone)
    assert {"documents/t1/2026-10/d1/page-1.jpg", "records/2026-10/r1.json", "doctype/2026-10/r1.jpg", "records/2026-10/r4.json"} <= gone
    assert all("/f1/" in n or n == "training/scan/2026-10/r2-page.jpg" for n in world.fb.deleted) and len(world.fb.deleted) == 4
    assert world.fs.deleted == ["r2"] and "Deleted." in capsys.readouterr().out


def test_a_worker_finds_the_attempts_told_their_id_and_their_page_copies(world, monkeypatch, capsys):
    run(monkeypatch, "--worker", "w1")
    out = capsys.readouterr().out
    # n1 (told w1 in the bucket) and f1 (told w1 in Firebase); e1 was told w2, u1 and g1 never told
    assert "attempts: Hugging Face 1 folders (3 files); Firebase 1 folders (3 files)" in out
    assert "page copies: Hugging Face 1 records (2 files); Firebase 1 records" in out
    assert "documents: Hugging Face 2 files; Firebase 0 files" in out
    assert ("workerId", "==", "w1") in world.fs.asked and "Nothing deleted" in out
    nothing_deleted(world)
    run(monkeypatch, "--worker", "w1", "--apply")
    assert {p for p in world.api.files if "/n1/" in p} <= set(world.api.deleted)
    assert not any("/e1/" in p or "/u1/" in p or "/g1/" in p or "/other/" in p for p in world.api.deleted)
    assert world.fs.deleted == ["r2"]


def test_no_such_firm_finds_nothing(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "smoke-no-such-firm")
    out = capsys.readouterr().out
    assert "attempts: Hugging Face 0 folders (0 files); Firebase 0 folders (0 files)" in out and "Nothing deleted" in out
    nothing_deleted(world)
