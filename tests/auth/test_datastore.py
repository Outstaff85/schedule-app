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
