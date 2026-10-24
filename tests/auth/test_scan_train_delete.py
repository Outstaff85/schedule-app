"""The deletion on request (scripts/scan-train/delete_data.py; docs/scan-training.md → 2): one firm's or one
worker's training data — full documents, page copies (also those of a worker's saved scan, by its session) and scan
attempts (attempts/new, used, exam and golden in the bucket, training/attempts/ in Firebase, and their owner notes in
Firestore) — is found by the firm in each attempt's answer.json or the worker in its outcome-*.json and the page
copies' records, with the pulls' copies on this PC; it prints counts per area and deletes nothing without --apply.
A blank id is refused; a bucket listing or download that fails stops the run. Hugging Face, the bucket, Firestore
and Storage are all mocks here, and this PC's work folder a temporary one."""
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
        self.files, self.deleted, self.listed, self.fail = files, [], [], None

    def list_bucket_tree(self, bucket_id, prefix="", recursive=False):
        if self.fail == "list":
            raise RuntimeError("401 Unauthorized")
        self.listed.append(prefix)
        return [types.SimpleNamespace(path=p) for p in sorted(self.files) if p.startswith(prefix)]

    def download_bucket_files(self, bucket_id, files, raise_on_missing_files=False):
        if self.fail == "read":
            raise RuntimeError("connection reset")
        for path, dest in files:
            if path not in self.files:
                if raise_on_missing_files:
                    raise FileNotFoundError(path)
                continue
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


class Query:
    def __init__(self, db, records, field, op, value):
        self.db, self.records, self.field, self.op, self.value = db, records, field, op, value

    def stream(self):
        hit = (lambda v: v == self.value) if self.op == "==" else (lambda v: v in self.value)
        return [Snap(self.db, rid, r) for rid, r in self.records.items() if self.field in r and hit(r[self.field])]


class Col:
    def __init__(self, db, name):
        self.db, self.name = db, name

    def where(self, field, op, value):
        assert op in ("==", "in") and (op == "==" or len(value) <= 30)
        self.db.asked.append((self.name, field, op, value))
        return Query(self.db, self.db.cols.get(self.name, {}), field, op, value)


class Db:
    """Firestore: {collection: {id: record}} — scanTraining and scanAttempts."""
    def __init__(self, cols):
        self.cols, self.deleted, self.asked = cols, [], []

    def collection(self, name):
        assert name in ("scanTraining", "scanAttempts")
        return Col(self, name)


js = lambda o: json.dumps(o).encode()


def attempt(area, tenant, outcome_worker=None, name="a"):
    """An attempt's folder in an area: picture, answer.json and, when told, a saved outcome."""
    d = f"{area}site/2026-10-2{len(area) % 10}/{name}"
    files = {f"{d}/picture.jpg": b"\xff\xd8", f"{d}/answer.json": js({"id": name, "tenantId": tenant})}
    if outcome_worker:
        files[f"{d}/outcome-20261024T101010000000.json"] = js({"outcome": "saved", "workerId": outcome_worker, "page": None})
    return files


def rec(rid, **kw):
    """A page copy's record in the bucket, beside its copy."""
    return {f"records/2026-10/{rid}.json": js({"id": rid, "image": None, "pageImage": f"doctype/2026-10/{rid}.jpg", **kw}),
            f"doctype/2026-10/{rid}.jpg": b"\xff\xd8"}


@pytest.fixture
def world(monkeypatch, tmp_path):
    hf = {}
    hf.update(attempt("attempts/new/", "t1", "w1", "n1"))
    hf.update(attempt("attempts/used/v5/", "t1", None, "u1"))
    hf.update(attempt("attempts/exam/", "t1", "w2", "e1"))
    hf.update(attempt("attempts/golden/", "t1", None, "g1"))
    hf.update(attempt("attempts/new/", "t9", "w9", "other"))   # another firm's: never touched
    hf.update({"documents/t1/2026-10/d1/page-1.jpg": b"\xff\xd8",
               "documents/t1/2026-10/d1/record.json": js({"id": "d1", "tenantId": "t1", "workerId": "w1", "sessionId": "sess1"}),
               "documents/t9/2026-10/d9/page-1.jpg": b"\xff\xd8",
               "documents/t9/2026-10/d9/record.json": js({"id": "d9", "tenantId": "t9", "workerId": "w9", "sessionId": "sess9"}),
               # a document saved with no worker (check_document keeps "" then): a blank --worker must never reach it
               "documents/t9/2026-10/d8/record.json": js({"id": "d8", "tenantId": "t9", "workerId": ""})})
    hf.update(rec("r1", tenantId="t1", workerId="w1"))
    hf.update(rec("r4", tenantId="t1", workerId=None))                      # sent before any worker was known
    hf.update(rec("r6", tenantId="t1", workerId=None, sessionId="sess1"))   # a new worker's scan, saved as w1 (d1's session)
    hf.update(rec("r5", tenantId="t9", workerId="w9"))
    hf.update(rec("r7", tenantId="t9"))                                     # an old record: no workerId at all
    fb = Bucket({**{"training/" + k: v for k, v in attempt("attempts/new/", "t1", "w1", "f1").items()},
                 **{"training/" + k: v for k, v in attempt("attempts/new/", "t9", None, "f9").items()},
                 "training/scan/2026-10/r2-page.jpg": b"\xff\xd8"})
    fs = Db({"scanTraining": {
                 "r2": {"tenantId": "t1", "workerId": "w1", "pageImage": "training/scan/2026-10/r2-page.jpg"},
                 # the bucket took its copy but refused the record: the copy is in the bucket
                 "r8": {"tenantId": "t1", "workerId": "w1", "image": None, "pageImage": "doctype/2026-10/r8.jpg"},
                 "r9": {"tenantId": "t1", "workerId": None, "sessionId": "sess1", "pageImage": None},
                 "r3": {"tenantId": "t9", "workerId": "w9", "pageImage": None}},
             "scanAttempts": {
                 "k1": {"tenantId": "t1", "dir": "attempts/new/site/2026-10-23/n1"},
                 "k2": {"tenantId": "t1", "dir": "attempts/new/site/2026-10-23/f1"},
                 "k9": {"tenantId": "t9", "dir": "attempts/new/site/2026-10-23/other"}}})
    work = tmp_path / "work"
    local = ["templates/id_front/d1-0.jpg", "templates/sefach/d1-1.jpg", "templates/id_front/d9-0.jpg", "templates/id_front/own-card.jpg",
             "doctypes/r1.jpg", "doctypes/r1-t1.jpg", "doctypes/r6.jpg", "doctypes/r5.jpg", "img/r2.jpg",
             "attempts/n1.jpg", "img/att-n1-0.jpg", "img/att-n1-1.jpg", "attempts/other.jpg", "img/att-other-0.jpg"]
    for p in local:
        (work / p).parent.mkdir(parents=True, exist_ok=True)
        (work / p).write_bytes(b"\xff\xd8")
    api = Api(hf)
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=lambda: api))
    monkeypatch.setattr(delete_data, "bucket", lambda: fb)
    monkeypatch.setattr(delete_data, "db", lambda: fs)
    monkeypatch.setattr(delete_data, "WORK", work)
    return types.SimpleNamespace(api=api, fb=fb, fs=fs, work=work)


def run(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["delete_data.py", *argv])
    delete_data.main()


def left(w):
    return sorted(str(p.relative_to(w.work)).replace("\\", "/") for p in w.work.rglob("*.jpg"))


def nothing_deleted(w, local=14):
    assert w.api.deleted == [] and w.fb.deleted == [] and w.fs.deleted == [] and len(left(w)) == local


def test_a_firm_finds_its_attempts_in_new_used_exam_and_golden_by_answer_json(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "t1")
    out = capsys.readouterr().out
    assert "attempts: Hugging Face 4 folders (10 files); Firebase 1 folders (3 files); 2 owner notes" in out
    assert "documents: Hugging Face 2 files; Firebase 0 files" in out
    # r1, r4, r6 in the bucket (with their copies) and r8's copy kept in the bucket though its record is in Firestore
    assert "page copies: Hugging Face 3 records (7 files); Firebase 3 records" in out
    assert "copies on this PC: 9 files" in out   # d1's two templates, r1 (and its turned copy), r6, r2, n1's picture and pages
    assert "Nothing deleted" in out and "t1" not in out  # counts only, never a path
    assert set(delete_data.ATTEMPT_AREAS) <= set(world.api.listed)
    nothing_deleted(world)


def test_a_firm_with_apply_deletes_exactly_its_own(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "t1", "--apply")
    gone = set(world.api.deleted)
    assert {p for p in world.api.files if "/n1/" in p or "/u1/" in p or "/e1/" in p or "/g1/" in p} <= gone
    assert not any("/other/" in p or p.startswith("documents/t9/") or "r5" in p or "r7" in p for p in gone)
    assert {"documents/t1/2026-10/d1/page-1.jpg", "records/2026-10/r1.json", "doctype/2026-10/r1.jpg", "records/2026-10/r4.json",
            "doctype/2026-10/r8.jpg"} <= gone
    assert all("/f1/" in n or n == "training/scan/2026-10/r2-page.jpg" for n in world.fb.deleted) and len(world.fb.deleted) == 4
    assert sorted(world.fs.deleted) == ["k1", "k2", "r2", "r8", "r9"] and "Deleted." in capsys.readouterr().out
    assert left(world) == ["attempts/other.jpg", "doctypes/r5.jpg", "img/att-other-0.jpg", "templates/id_front/d9-0.jpg", "templates/id_front/own-card.jpg"]


def test_a_worker_finds_the_attempts_told_their_id_and_their_page_copies(world, monkeypatch, capsys):
    run(monkeypatch, "--worker", "w1")
    out = capsys.readouterr().out
    # n1 (told w1 in the bucket) and f1 (told w1 in Firebase); e1 was told w2, u1 and g1 never told
    assert "attempts: Hugging Face 1 folders (3 files); Firebase 1 folders (3 files); 2 owner notes" in out
    # r1 by its worker, r6 by the session of w1's document d1 (never r4: no worker, another scan); Firestore r2, r8, r9
    assert "page copies: Hugging Face 2 records (5 files); Firebase 3 records" in out
    assert "documents: Hugging Face 2 files; Firebase 0 files" in out
    assert ("scanTraining", "workerId", "==", "w1") in world.fs.asked and ("scanTraining", "sessionId", "in", ["sess1"]) in world.fs.asked
    assert "Nothing deleted" in out
    nothing_deleted(world)
    run(monkeypatch, "--worker", "w1", "--apply")
    gone = set(world.api.deleted)
    assert {p for p in world.api.files if "/n1/" in p} | {"records/2026-10/r6.json", "doctype/2026-10/r6.jpg", "doctype/2026-10/r8.jpg"} <= gone
    assert not any("/e1/" in p or "/u1/" in p or "/g1/" in p or "/other/" in p or "r4" in p or "r7" in p for p in gone)
    assert sorted(world.fs.deleted) == ["k1", "k2", "r2", "r8", "r9"]
    assert "doctypes/r6.jpg" not in left(world) and "templates/id_front/d1-0.jpg" not in left(world) and "img/att-n1-1.jpg" not in left(world)


@pytest.mark.parametrize("flag", ["--firm", "--worker"])
@pytest.mark.parametrize("blank", ["", "  "])
def test_a_blank_id_is_refused_without_listing_anything(world, monkeypatch, capsys, flag, blank):
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, flag, blank, "--apply")
    assert "needed" in str(e.value) and world.api.listed == [] and world.fs.asked == []
    nothing_deleted(world)
    # and find() itself never takes a blank one
    with pytest.raises(ValueError):
        delete_data.find(world.api, world.fb, world.fs, firm="")
    assert not delete_data._matches({"workerId": None}, None, None) and not delete_data._matches({"workerId": ""}, None, "")
    assert not delete_data._matches({"tenantId": ""}, "", None)


@pytest.mark.parametrize("fail", ["list", "read"])
def test_a_bucket_that_cannot_be_listed_or_read_stops_the_run(world, monkeypatch, capsys, fail):
    world.api.fail = fail
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, "--worker", "w1", "--apply")
    assert "nothing deleted" in str(e.value) and "Deleted." not in capsys.readouterr().out
    nothing_deleted(world)


def test_a_marker_that_does_not_parse_is_counted_and_blocks_apply(world, monkeypatch, capsys):
    world.api.files["attempts/new/site/2026-10-23/bad/answer.json"] = b"{not json"
    run(monkeypatch, "--firm", "t1")
    assert "could not be read: 1" in capsys.readouterr().out
    with pytest.raises(SystemExit) as e:
        run(monkeypatch, "--firm", "t1", "--apply")
    assert "Nothing deleted" in str(e.value)
    nothing_deleted(world)


def test_no_such_firm_finds_nothing(world, monkeypatch, capsys):
    run(monkeypatch, "--firm", "smoke-no-such-firm")
    out = capsys.readouterr().out
    assert "attempts: Hugging Face 0 folders (0 files); Firebase 0 folders (0 files); 0 owner notes" in out and "Nothing deleted" in out
    assert "copies on this PC: 0 files" in out
    nothing_deleted(world)


def test_pull_templates_drops_the_pages_whose_document_left_the_bucket(tmp_path):
    spec = importlib.util.spec_from_file_location("pull_templates", HERE / "pull_templates.py")
    pt = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pt)
    kept, gone = "A" * 20, "B" * 20
    names = [f"id_front/{kept}-0.jpg", f"sefach/{gone}-1.jpg", f"id_front/{gone}-0.jpg", "id_front/own-card.jpg", "passport/my-own-scan.jpg"]
    for n in names:
        (tmp_path / n).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / n).write_bytes(b"\xff\xd8")
    stale = [str(p.relative_to(tmp_path)).replace("\\", "/") for p in pt.stale(tmp_path, {kept})]
    # only pulled pages (<a Firestore id>-<n>.jpg) of a document no longer there; the owner's and hand-put pages stay
    assert stale == [f"id_front/{gone}-0.jpg", f"sefach/{gone}-1.jpg"]


def test_the_copies_of_gen_real_and_the_documents_pages_are_found_on_this_pc(tmp_path):
    names = ["real/img/doc-d1-0.jpg", "doctypes/doc-d1-2.jpg", "real/img/copy-r1.jpg", "real/copies/r1.jpg", "real/img/r1.jpg", "real/attempts/n1.jpg",
             "real/img/att-n1-0.jpg", "real/img/att-n1-3.jpg", "real/img/doc-d10-0.jpg", "real/img/copy-r10.jpg", "real/img/att-n10-0.jpg"]
    for n in names:
        (tmp_path / n).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / n).write_bytes(b"\xff\xd8")
    got = delete_data.local_copies({"documents": ["d1"], "copies": ["r1"], "attempts": ["n1"]}, tmp_path)
    assert sorted(str(p.relative_to(tmp_path)).replace("\\", "/") for p in got) == sorted(names[:8])   # never another's (d10, r10, n10)
