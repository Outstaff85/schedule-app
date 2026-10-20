"""Tests for reading and deleting worker files in Storage
(functions-auth/files.py). The bucket is an in-memory stand-in: files.py only
calls blob(path).exists()/download_as_bytes()/delete() and list_blobs(prefix)."""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "functions-auth"))

import files  # noqa: E402

# The callers carry their flat rights as main.py hands them (core.caller_rights).

T1, T2 = "t-one", "t-two"
ASSETS = f"tenants/{T1}/workers/w1/assets/1-123456782_Avi_Cohen_assets.json"
PDF = f"tenants/{T1}/workers/w1/form101/1-123456782_Avi_Cohen.pdf"
OTHER = f"tenants/{T2}/workers/w9/assets/1-x_assets.json"


class Blob:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def exists(self):
        return self.path in self.store

    def download_as_bytes(self):
        return self.store[self.path]

    def delete(self):
        del self.store[self.path]


class Bucket:
    def __init__(self):
        sidecar = json.dumps({"scanB64": "SCAN", "scanMediaType": "image/jpeg", "sigPng": "SIG",
                              "extraPages": [{"b64": "P2", "mediaType": "image/jpeg"}]}).encode()
        self.store = {ASSETS: sidecar, PDF: b"%PDF", OTHER: sidecar}

    def blob(self, path):
        return Blob(self.store, path)

    def list_blobs(self, prefix=""):
        return [Blob(self.store, p) for p in list(self.store) if p.startswith(prefix)]


ADMIN = {"role": "tenant_admin", "tenantId": T1}


def test_load_assets_reply_shape():
    r = files.run(Bucket(), ADMIN, {"action": "loadWorkerAssets", "fileId": ASSETS})
    assert r == {"ok": True, "scanB64": "SCAN", "scanMediaType": "image/jpeg", "sigPng": "SIG",
                 "extraPages": [{"b64": "P2", "mediaType": "image/jpeg"}]}


def test_other_firms_file_refused():
    b = Bucket()
    for action in files.ACTIONS:
        assert files.run(b, ADMIN, {"action": action, "fileId": OTHER}) == {"error": files.E_NOT_FIRM}
    assert OTHER in b.store
    # a path that climbs out of the firm's folder, or one outside workers/
    for bad in (f"tenants/{T1}/workers/../../{T2}/workers/w9/a.json", f"tenants/{T1}/settings/x", f"tenants/{T1}"):
        assert files.run(b, ADMIN, {"action": "loadWorkerAssets", "fileId": bad}) == {"error": files.E_NOT_FIRM}


def test_superadmin_works_in_the_firm_it_views():
    sa = {"role": "superadmin", "tenantId": T2}
    assert files.run(Bucket(), sa, {"action": "loadWorkerAssets", "fileId": OTHER})["ok"]
    assert files.run(Bucket(), sa, {"action": "loadWorkerAssets", "fileId": ASSETS}) == {"error": files.E_NOT_FIRM}
    assert files.run(Bucket(), {"role": "superadmin", "tenantId": None},
                     {"action": "loadWorkerAssets", "fileId": ASSETS}) == {"error": files.E_NOT_FIRM}


def test_delete_needs_workers_right():
    b = Bucket()
    staff_ro = {"role": "staff", "tenantId": T1, "rights": {"schedule", "editSchedule", "editWorkers"}}
    assert files.run(b, staff_ro, {"action": "deleteWorkerDoc", "fileId": PDF}) == {"error": files.E_NO_RIGHT}
    assert PDF in b.store
    # but may read (the rules let any manager login of the firm read)
    assert files.run(b, staff_ro, {"action": "loadWorkerAssets", "fileId": ASSETS})["ok"]
    staff = {"role": "staff", "tenantId": T1, "rights": {"workers", "editWorkers"}}
    assert files.run(b, staff, {"action": "deleteWorkerDoc", "fileId": PDF}) == {"ok": True}
    assert PDF not in b.store
    # deleting again (already gone) is fine, like Drive's best-effort trash
    assert files.run(b, ADMIN, {"action": "deleteWorkerDoc", "fileId": PDF}) == {"ok": True}


def test_delete_needs_the_workers_tab_and_edit_workers():
    # A token with the flat rights (claim rt): the Workers tab and Edit workers.
    b = Bucket()
    view = {"role": "staff", "tenantId": T1, "rights": {"workers"}}
    assert files.run(b, view, {"action": "deleteWorkerDoc", "fileId": PDF}) == {"error": files.E_NO_RIGHT}
    assert files.run(b, dict(view, rights={"workers", "editWorkers"}), {"action": "deleteWorkerDoc", "fileId": PDF}) == {"ok": True}


def test_supplier_and_missing_refused():
    sup = {"role": "supplier", "tenantId": T1}
    assert "error" in files.run(Bucket(), sup, {"action": "loadWorkerAssets", "fileId": ASSETS})
    assert files.run(Bucket(), ADMIN, {"action": "loadWorkerAssets"}) == {"error": files.E_NO_FILE}
    assert files.run(Bucket(), ADMIN, {"action": "loadWorkerAssets",
                                       "fileId": f"tenants/{T1}/workers/w1/assets/gone.json"}) == {"error": files.E_NOT_FOUND}


def test_delete_tenant_files_only_that_firm():
    b = Bucket()
    assert files.delete_tenant_files(b, T1) == 2
    assert list(b.store) == [OTHER]
    assert files.delete_tenant_files(b, "") == 0 and files.delete_tenant_files(b, "a/b") == 0
    assert list(b.store) == [OTHER]


def test_hr_own_only_reaches_its_own_workers_files():
    b = Bucket()
    hr = {"uid": "u-hr", "role": "hr", "tenantId": T1, "rights": {"workers", "editWorkers"}, "own": True}
    mine = lambda wid: "u-hr" if wid == "w1" else "other"
    assert files.run(b, hr, {"action": "loadWorkerAssets", "fileId": ASSETS}, mine)["ok"]
    theirs = lambda wid: "other"
    assert files.run(b, hr, {"action": "loadWorkerAssets", "fileId": ASSETS}, theirs) == {"error": files.E_NOT_FIRM}
    assert files.run(b, hr, {"action": "deleteWorkerDoc", "fileId": PDF}, theirs) == {"error": files.E_NOT_FIRM}
    assert PDF in b.store
    assert files.run(b, hr, {"action": "deleteWorkerDoc", "fileId": PDF}, mine) == {"ok": True}
    # Without own-only, an HR with the workers right is a workers writer for the whole firm.
    hr_all = dict(hr, own=False)
    assert files.run(Bucket(), hr_all, {"action": "deleteWorkerDoc", "fileId": PDF}, theirs) == {"ok": True}
    assert files.run(Bucket(), dict(hr_all, rights={"commission"}), {"action": "deleteWorkerDoc", "fileId": PDF}, theirs) == {"error": files.E_NO_RIGHT}


PAGE = f"tenants/{T1}/workers/w1/pages/1-0-id_front.jpg"
SEF = f"tenants/{T1}/workers/w1/pages/1-1-sefach.jpg"
SIG = f"tenants/{T1}/workers/w1/signature/1-signature.png"


def _pages_bucket():
    b = Bucket()
    b.store.update({PAGE: b"\xff\xd8front", SEF: b"\xff\xd8sef", SIG: b"\x89PNGsig"})
    return b


def test_load_pages_in_one_call():
    r = files.run(_pages_bucket(), ADMIN, {"action": "loadWorkerPages", "fileIds": [PAGE, SEF, SIG]})
    assert r["ok"] and r["missing"] == []
    assert [(p["fileId"], p["mediaType"]) for p in r["pages"]] == [
        (PAGE, "image/jpeg"), (SEF, "image/jpeg"), (SIG, "image/png")]
    assert base64.b64decode(r["pages"][2]["b64"]) == b"\x89PNGsig"


def test_load_pages_reports_a_missing_one():
    gone = f"tenants/{T1}/workers/w1/pages/2-0-passport.jpg"
    r = files.run(_pages_bucket(), ADMIN, {"action": "loadWorkerPages", "fileIds": [gone, PAGE]})
    assert r["ok"] and r["missing"] == [gone] and [p["fileId"] for p in r["pages"]] == [PAGE]


def test_load_pages_only_pages_and_signatures_of_this_firm():
    b = _pages_bucket()
    # one bad path refuses the whole call: another firm, the PDF, the old sidecar, a climb out
    for bad in (f"tenants/{T2}/workers/w9/pages/1-0-id_front.jpg", PDF, ASSETS,
                f"tenants/{T1}/workers/w1/pages/../form101/1-x.pdf"):
        assert files.run(b, ADMIN, {"action": "loadWorkerPages", "fileIds": [PAGE, bad]}) == {"error": files.E_NOT_FIRM}
    assert files.run(b, ADMIN, {"action": "loadWorkerPages", "fileIds": []}) == {"error": files.E_NO_FILE}
    assert files.run(b, ADMIN, {"action": "loadWorkerPages", "fileIds": PAGE}) == {"error": files.E_NO_FILE}
    assert "error" in files.run(b, ADMIN, {"action": "loadWorkerPages", "fileIds": [PAGE] * (files.MAX_PAGES + 1)})
    assert "error" in files.run(b, {"role": "supplier", "tenantId": T1}, {"action": "loadWorkerPages", "fileIds": [PAGE]})


def test_load_pages_hr_own_only():
    hr = {"uid": "u-hr", "role": "hr", "tenantId": T1, "rights": {"workers"}, "own": True}
    assert files.run(_pages_bucket(), hr, {"action": "loadWorkerPages", "fileIds": [PAGE]}, lambda wid: "u-hr")["ok"]
    assert files.run(_pages_bucket(), hr, {"action": "loadWorkerPages", "fileIds": [PAGE]},
                     lambda wid: "other") == {"error": files.E_NOT_FIRM}
