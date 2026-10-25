"""Where the training data goes (functions/datastore.py, docs/hf-plan.md → H7): the private
Hugging Face bucket once the server has its token, else Firebase Storage training/."""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("datastore", pathlib.Path(__file__).resolve().parents[2] / "functions" / "datastore.py")
datastore = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(datastore)


class Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def upload_from_string(self, data, content_type=None):
        self.store[self.name] = (data, content_type)


class Bucket:
    def __init__(self):
        self.files = {}

    def blob(self, name):
        return Blob(self.files, name)


def test_without_the_token_the_files_go_to_firebase_in_their_old_places(monkeypatch):
    monkeypatch.delenv("HF_DATA_TOKEN", raising=False)
    b = Bucket()
    got = datastore.put([("edges/2026-10/a.jpg", b"1"), ("doctype/2026-10/a.jpg", b"2"), ("documents/t1/2026-10/d/record.json", b"{}")], lambda: b)
    assert got == ["training/scan/2026-10/a.jpg", "training/scan/2026-10/a-page.jpg", "training/documents/t1/2026-10/d/record.json"]
    assert b.files["training/documents/t1/2026-10/d/record.json"][1] == "application/json" and not datastore.on_hf()


def test_with_the_token_the_files_go_to_the_private_bucket(monkeypatch):
    sent = []

    class Api:
        def __init__(self, token):
            sent.append(("token", token))

        def batch_bucket_files(self, bucket_id, add):
            sent.append((bucket_id, [(p, d) for d, p in add]))
    import sys
    import types
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=Api))
    monkeypatch.setenv("HF_DATA_TOKEN", "t")
    got = datastore.put([("edges/2026-10/a.jpg", b"1")], lambda: (_ for _ in ()).throw(AssertionError("no Firebase")))
    assert got == ["edges/2026-10/a.jpg"] and sent == [("token", "t"), ("OutStaff/scanner-data", [("edges/2026-10/a.jpg", b"1")])]


def test_a_bucket_that_refuses_leaves_the_files_in_firebase(monkeypatch):
    import sys
    import types

    class Api:
        def __init__(self, token):
            pass

        def batch_bucket_files(self, bucket_id, add):
            raise RuntimeError("no such bucket")
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=Api))
    monkeypatch.setenv("HF_DATA_TOKEN", "t")
    b = Bucket()
    assert datastore.put([("edges/2026-10/a.jpg", b"1")], lambda: b) == ["training/scan/2026-10/a.jpg"] and b.files


class ReadBlob:
    def __init__(self, files, name):
        self.files, self.name = files, name

    def download_as_bytes(self):
        if self.name not in self.files:
            raise LookupError("404")
        return self.files[self.name]


class ReadBucket:
    def __init__(self, files):
        self.files = files

    def blob(self, name):
        return ReadBlob(self.files, name)


def test_a_file_is_read_back_from_where_it_went(monkeypatch):
    """get(): the bucket with the server's token; a file the bucket does not have (kept in Firebase after a refusal) from Firebase."""
    import pathlib
    import sys
    import types
    asked = []

    class Api:
        def __init__(self, token):
            pass

        def download_bucket_files(self, bucket_id, files, raise_on_missing_files=False):
            for path, dest in files:
                asked.append(path)
                if path != "attempts/new/site/2026-10-24/a/answer.json":
                    raise FileNotFoundError(path)
                pathlib.Path(dest).write_bytes(b'{"tenantId": "t1"}')
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.SimpleNamespace(HfApi=Api))
    monkeypatch.setenv("HF_DATA_TOKEN", "t")
    fb = ReadBucket({"training/attempts/new/site/2026-10-24/b/answer.json": b'{"tenantId": "t2"}'})
    assert datastore.get("attempts/new/site/2026-10-24/a/answer.json", lambda: fb) == b'{"tenantId": "t1"}'
    assert datastore.get("attempts/new/site/2026-10-24/b/answer.json", lambda: fb) == b'{"tenantId": "t2"}'
    assert datastore.get("attempts/new/site/2026-10-24/c/answer.json", lambda: fb) is None
    assert datastore.get("attempts/new/site/2026-10-24/c/answer.json") is None
    monkeypatch.delenv("HF_DATA_TOKEN")
    asked.clear()
    assert datastore.get("attempts/new/site/2026-10-24/b/answer.json", lambda: fb) == b'{"tenantId": "t2"}' and asked == []
