"""The one-time split of the old scan sidecars into pages (scripts/migrate/scan_pages.py,
docs/contracts.md → Scanned pages), on in-memory stand-ins for Firestore and Storage."""

import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "migrate"))

import scan_pages  # noqa: E402

T = "t1"
SIDE = f"tenants/{T}/workers/w1/assets/1760000000000-x_assets.json"
DEL = object()


class Blob:
    def __init__(self, store, path):
        self.store, self.path, self.metadata = store, path, None

    def exists(self):
        return self.path in self.store

    def download_as_bytes(self):
        return self.store[self.path][0]

    def upload_from_string(self, data, content_type=None):
        self.store[self.path] = (data, content_type, self.metadata)

    def delete(self):
        del self.store[self.path]


class Bucket:
    def __init__(self, store):
        self.store = store

    def blob(self, path):
        b = Blob(self.store, path)
        if path in self.store:
            b.metadata = self.store[path][2]
        return b


class Doc:
    def __init__(self, coll, id):
        self.coll, self.id = coll, id

    def to_dict(self):
        return dict(self.coll[self.id])

    def update(self, fields):
        for k, v in fields.items():
            if v is DEL:
                self.coll[self.id].pop(k, None)
            else:
                self.coll[self.id][k] = v


class Coll:
    def __init__(self, data):
        self.data = data

    def stream(self):
        return [Doc(self.data, k) for k in self.data]

    def document(self, id):
        return Doc(self.data, id) if id in self.data else Ref(self.data, id)


class Ref:
    def __init__(self, data, id):
        self.data, self.id = data, id

    def collection(self, name):
        return Coll(self.data[self.id][name])


class Db:
    def __init__(self, tenants):
        self.tenants = tenants

    def collection(self, name):
        return TenantColl(self.tenants)


class TenantColl:
    def __init__(self, tenants):
        self.tenants = tenants

    def stream(self):
        return [type("D", (), {"id": t})() for t in self.tenants]

    def document(self, t):
        return type("R", (), {"collection": lambda _s, n: Coll(self.tenants[t][n])})()


def _png(w, h, alpha=False):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGBA" if alpha else "RGB", (w, h), (10, 20, 30, 0) if alpha else (10, 20, 30)).save(out, "PNG")
    return out.getvalue()


def _setup():
    sidecar = {"scanB64": base64.b64encode(b"FRONTJPEG").decode(), "scanMediaType": "image/jpeg",
               "sigPng": "data:image/png;base64," + base64.b64encode(b"SIGPNG").decode(),
               "extraPages": [{"b64": base64.b64encode(b"SEF").decode(), "mediaType": "image/jpeg", "kind": "sefach"},
                              {"b64": base64.b64encode(b"PAGE2").decode(), "mediaType": "image/jpeg"}]}
    store = {SIDE: (json.dumps(sidecar).encode(), "application/json", {"hrId": "u-hr", "workerId": "w1"})}
    tenants = {T: {"workers": {
        "w1": {"name": "Avi", "docType": "israeli_id", "assetsFileId": SIDE, "phone": "050"},
        "w2": {"name": "Dana", "scanPages": [{"fileId": "x", "kind": "passport", "primary": True}]},
        "w3": {"name": "No scan"},
        "w4": {"name": "Gone", "assetsFileId": f"tenants/{T}/workers/w4/assets/1-gone.json"},
    }}}
    return Db(tenants), Bucket(store), tenants, store


def test_dry_run_writes_nothing():
    db, bucket, tenants, store = _setup()
    before = json.dumps(tenants, sort_keys=True), dict(store)
    rep = scan_pages.migrate(db, bucket, "dry-run", now_ms=5, delete_field=DEL, log=lambda *a: None)
    assert (json.dumps(tenants, sort_keys=True), store) == before
    r = rep[T]
    assert r["workers"] == 1 and r["pages"] == 3 and r["signatures"] == 1
    assert r["failed"] == [{"worker": "w4", "reason": "the sidecar is gone"}]


def test_apply_splits_into_pages_and_keeps_the_sidecar():
    db, bucket, tenants, store = _setup()
    scan_pages.migrate(db, bucket, "apply", now_ms=5, delete_field=DEL, log=lambda *a: None)
    w = tenants[T]["workers"]["w1"]
    base = f"tenants/{T}/workers/w1"
    assert w["scanPages"] == [
        {"fileId": f"{base}/pages/5-0-id_front.jpg", "kind": "id_front", "primary": True, "savedAt": "2025-10-09T08:53:20.000Z"},
        {"fileId": f"{base}/pages/5-1-sefach.jpg", "kind": "sefach", "savedAt": "2025-10-09T08:53:20.000Z"},
        {"fileId": f"{base}/pages/5-2-other.jpg", "kind": "other", "savedAt": "2025-10-09T08:53:20.000Z"}]
    assert w["sigFileId"] == f"{base}/signature/5-signature.png" and w["sigSavedAt"] == "2025-10-09T08:53:20.000Z"
    assert "assetsFileId" not in w and w["assetsMigratedFrom"] == SIDE and w["phone"] == "050"
    # the bytes as they were (not images Pillow can open), with the type and the HR's stamp
    assert store[f"{base}/pages/5-1-sefach.jpg"] == (b"SEF", "image/jpeg", {"workerId": "w1", "hrId": "u-hr", "kind": "pages"})
    assert store[f"{base}/signature/5-signature.png"][:2] == (b"SIGPNG", "image/png")
    assert SIDE in store  # kept until cleanup
    # a second run finds nothing more to split
    rep = scan_pages.migrate(db, bucket, "apply", now_ms=6, delete_field=DEL, log=lambda *a: None)
    assert rep[T]["workers"] == 0
    # cleanup deletes the sidecar and its mark
    rep = scan_pages.migrate(db, bucket, "cleanup", delete_field=DEL, log=lambda *a: None)
    assert rep[T]["cleaned"] == 1 and SIDE not in store and "assetsMigratedFrom" not in w


def test_page_kind_matches_the_app():
    assert scan_pages.page_kind(None, True, "passport") == "passport"
    assert scan_pages.page_kind("contract", True, "israeli_id") == "id_front"
    assert scan_pages.page_kind("contract", False, None) == "other"
    assert scan_pages.page_kind("id_back", False, None) == "id_back"


def test_big_page_shrunk_to_a_jpeg():
    from PIL import Image
    out = scan_pages.as_jpeg(_png(3000, 1500, alpha=True), "image/png")
    im = Image.open(io.BytesIO(out))
    assert im.format == "JPEG" and im.size == (2000, 1000)
    small = _png(800, 600)
    assert Image.open(io.BytesIO(scan_pages.as_jpeg(small, "image/png"))).format == "JPEG"


def test_sidecar_outside_the_workers_folder_refused():
    db, bucket, tenants, store = _setup()
    tenants[T]["workers"]["w1"]["assetsFileId"] = f"tenants/{T}/workers/w9/assets/1760000000000-x_assets.json"
    store[tenants[T]["workers"]["w1"]["assetsFileId"]] = store[SIDE]
    rep = scan_pages.migrate(db, bucket, "apply", now_ms=5, delete_field=DEL, log=lambda *a: None)
    assert rep[T]["failed"][0]["worker"] == "w1" and "scanPages" not in tenants[T]["workers"]["w1"]
