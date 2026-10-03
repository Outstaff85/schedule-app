"""Stage 8 tests: moving worker files from Drive to Storage (functions-auth/filemove.py)
on the Firestore emulator, with an in-memory bucket and a stand-in for Apps Script."""

import base64

from test_core import DB, _clear  # noqa: F401 — also initializes the Admin SDK

import pytest

import filemove

T1, T2 = "t-one", "t-two"


class Blob:
    def __init__(self, bucket, path):
        self.bucket, self.path = bucket, path
        self.metadata, self.content_disposition = None, None

    def upload_from_string(self, data, content_type=None):
        self.bucket.store[self.path] = {"data": data, "type": content_type, "meta": self.metadata,
                                        "disp": self.content_disposition}


class Bucket:
    name = "demo.appspot.com"

    def __init__(self):
        self.store = {}

    def blob(self, path):
        return Blob(self, path)


DRIVE = {  # drive id -> (tenant, name, mime, bytes)
    "d-pdf": (T1, "123456782_Avi_Cohen.pdf", "application/pdf", b"%PDF avi"),
    "d-old": (T1, "form101_Levi_987654321.pdf", "application/pdf", b"%PDF dana"),
    "d-assets": (T1, "123456782_Avi_Cohen_assets.json", "application/json", b'{"scanB64":"S"}'),
    "d-visa": (T1, "visa.jpg", "image/jpeg", b"JPEG"),
    "d-other": (T2, "x.pdf", "application/pdf", b"%PDF other"),
}


def fetcher(calls, superadmin=True):
    def fetch(part, tenant_id=None, file_id=None):
        calls.append((part, tenant_id, file_id))
        if not superadmin:
            return {"error": "Только супер-админ"}
        if part == "meta":
            return {"ok": True, "tenants": [{"tenantId": T1, "companyName": "One Ltd"}]}
        if file_id not in DRIVE:
            return {"error": "Файл не найден", "missing": True}
        t, name, mime, data = DRIVE[file_id]
        if t != tenant_id:
            return {"error": "Файл не принадлежит этой фирме"}
        return {"ok": True, "name": name, "mimeType": mime, "b64": base64.b64encode(data).decode()}
    return fetch


def W(tid, wid):
    return DB.collection("tenants").document(tid).collection("workers").document(wid)


@pytest.fixture(autouse=True)
def fresh():
    _clear()
    DB.collection("tenants").document(T1).set({"companyName": "One Ltd"})
    W(T1, "w1").set({"id": "w1", "name": "Avi Cohen", "docFileId": "d-pdf",
                     "docUrl": "https://drive.google.com/file/d/d-pdf/view", "assetsFileId": "d-assets",
                     "docs": [{"id": "x1", "type": "visa", "name": "visa.jpg", "fileId": "d-visa",
                               "url": "https://drive.google.com/file/d/d-visa/view", "expiry": "2027-01-01"}]})
    # an older record: only docUrl; and a file that is gone from Drive
    W(T1, "w2").set({"id": "w2", "name": "Dana Levi", "docUrl": "https://drive.google.com/file/d/d-old/view?usp=x",
                     "assetsFileId": "d-gone"})
    W(T1, "w3").set({"id": "w3", "name": "No Files"})
    yield


def test_moves_every_drive_file_and_points_the_worker_at_it():
    b, calls = Bucket(), []
    r = filemove.move_all(DB, b, fetcher(calls))
    assert r["ok"] and not r["partial"]
    t = r["tenants"][0]
    assert (t["name"], t["workers"], t["moved"], t["missing"], t["errors"]) == ("One Ltd", 3, 4, 1, [])
    w1 = W(T1, "w1").get().to_dict()
    assert w1["docFileId"].startswith(f"tenants/{T1}/workers/w1/form101/") and w1["docFileId"].endswith("123456782_Avi_Cohen.pdf")
    assert w1["docUrl"].startswith("https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/tenants%2Ft-one%2Fworkers%2Fw1%2Fform101%2F")
    assert b.store[w1["docFileId"]]["data"] == b"%PDF avi" and b.store[w1["docFileId"]]["type"] == "application/pdf"
    assert w1["docUrl"].endswith("&token=" + b.store[w1["docFileId"]]["meta"]["firebaseStorageDownloadTokens"])
    assert w1["assetsFileId"].startswith(f"tenants/{T1}/workers/w1/assets/")
    assert b.store[w1["assetsFileId"]]["disp"] is None  # the sidecar is never opened by a link
    d = w1["docs"][0]
    assert d["fileId"].startswith(f"tenants/{T1}/workers/w1/docs/") and d["url"].startswith("https://firebasestorage")
    assert (d["type"], d["expiry"], d["name"]) == ("visa", "2027-01-01", "visa.jpg")  # the rest of the entry kept
    w2 = W(T1, "w2").get().to_dict()
    assert w2["docFileId"].startswith(f"tenants/{T1}/workers/w2/form101/")  # found through docUrl
    assert w2["assetsFileId"] == "d-gone"  # missing on Drive: left as it was


def test_second_run_moves_nothing():
    b, calls = Bucket(), []
    filemove.move_all(DB, b, fetcher(calls))
    calls2 = []
    r = filemove.move_all(DB, b, fetcher(calls2))
    assert r["tenants"][0]["moved"] == 0
    assert [c for c in calls2 if c[0] == "file"] == [("file", T1, "d-gone")]  # only the one still on Drive


def test_not_superadmin_writes_nothing():
    b, calls = Bucket(), []
    r = filemove.move_all(DB, b, fetcher(calls, superadmin=False))
    assert r == {"error": "Только супер-админ"}
    assert b.store == {} and calls == [("meta", None, None)]
    assert W(T1, "w1").get().to_dict()["docFileId"] == "d-pdf"


def test_another_firms_file_is_reported_not_moved():
    W(T1, "w4").set({"id": "w4", "name": "Wrong", "docFileId": "d-other"})
    r = filemove.move_all(DB, Bucket(), fetcher([]))
    assert not r["ok"] and any("Wrong" in e for e in r["tenants"][0]["errors"])
    assert W(T1, "w4").get().to_dict()["docFileId"] == "d-other"


def test_time_budget_stops_and_reports_partial():
    r = filemove.move_all(DB, Bucket(), fetcher([]), budget_s=-1)
    assert r["partial"] and r["tenants"][0]["left"] == 5 and r["tenants"][0]["moved"] == 0
