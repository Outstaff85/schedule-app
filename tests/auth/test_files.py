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
# main.py's signed_lookup for a worker with no signing: no record kept, no requests
UNSIGNED = lambda wid: (None, [])  # noqa: E731


def test_load_assets_reply_shape():
    r = files.run(Bucket(), ADMIN, {"action": "loadWorkerAssets", "fileId": ASSETS})
    assert r == {"ok": True, "scanB64": "SCAN", "scanMediaType": "image/jpeg", "sigPng": "SIG",
                 "extraPages": [{"b64": "P2", "mediaType": "image/jpeg"}]}


def test_other_firms_file_refused():
    b = Bucket()
    for action in ("loadWorkerAssets", "deleteWorkerDoc"):  # loadWorkerPages: test_load_pages_only_pages_and_signatures_of_this_firm
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
    assert files.run(b, staff, {"action": "deleteWorkerDoc", "fileId": PDF}, None, UNSIGNED) == {"ok": True}
    assert PDF not in b.store
    # deleting again (already gone) is fine, like Drive's best-effort trash
    assert files.run(b, ADMIN, {"action": "deleteWorkerDoc", "fileId": PDF}, None, UNSIGNED) == {"ok": True}


def test_delete_needs_the_workers_tab_and_edit_workers():
    # A token with the flat rights (claim rt): the Workers tab and Edit workers.
    b = Bucket()
    view = {"role": "staff", "tenantId": T1, "rights": {"workers"}}
    assert files.run(b, view, {"action": "deleteWorkerDoc", "fileId": PDF}) == {"error": files.E_NO_RIGHT}
    assert files.run(b, dict(view, rights={"workers", "editWorkers"}), {"action": "deleteWorkerDoc", "fileId": PDF}, None, UNSIGNED) == {"ok": True}


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
    assert files.run(b, hr, {"action": "deleteWorkerDoc", "fileId": PDF}, mine, UNSIGNED) == {"ok": True}
    # Without own-only, an HR with the workers right is a workers writer for the whole firm.
    hr_all = dict(hr, own=False)
    assert files.run(Bucket(), hr_all, {"action": "deleteWorkerDoc", "fileId": PDF}, theirs, UNSIGNED) == {"ok": True}
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


# ── Signed files are kept (documents plan S0b; docs/contracts.md → Signed files are kept) ──
W = f"tenants/{T1}/workers/w1"
S101, SCTR, SSIG = W + "/form101/1-signed.pdf", W + "/docs/1-contract.pdf", W + "/signature/1-signature.png"
UPL = W + "/docs/2-visa.pdf"
REQ = {"workerId": "w1", "status": "signed", "sigPath": SSIG,
       "parts": {"form101": {"path": S101, "name": "f.pdf"}, "contract": {"path": SCTR, "name": "c.pdf"}}}
SIGNED_W = {"id": "w1", "signedAt": "2026-10-20T10:00:00Z", "signedRequestId": "r1", "docFileId": S101, "sigFileId": SSIG,
            "docs": [{"id": "d1", "fileId": SCTR, "signed": True}, {"id": "d2", "fileId": UPL}]}


def _signed_bucket():
    b = Bucket()
    b.store.update({S101: b"%PDF", SCTR: b"%PDF", SSIG: b"\x89PNG", UPL: b"%PDF"})
    return b


def _delete(b, path, lookup):
    return files.run(b, ADMIN, {"action": "deleteWorkerDoc", "fileId": path}, None, lookup)


def test_delete_refuses_a_signing_requests_parts_and_signature():
    # even when the worker's record no longer names them (replaced, or the record already gone)
    b = _signed_bucket()
    only_req = lambda wid: ({"id": "w1"}, [REQ])  # noqa: E731
    for p in (S101, SCTR, SSIG):
        assert _delete(b, p, only_req) == {"error": files.E_SIGNED}
        assert p in b.store
    gone = lambda wid: (None, [REQ])  # noqa: E731
    assert _delete(b, S101, gone) == {"error": files.E_SIGNED} and S101 in b.store


def test_delete_refuses_a_signed_workers_form101_documents_and_signature():
    b = _signed_bucket()
    rec = lambda wid: (SIGNED_W, [])  # noqa: E731  (no request kept: an older signing, or a moved worker)
    for p in (S101, SCTR, SSIG, UPL):
        assert _delete(b, p, rec) == {"error": files.E_SIGNED}
        assert p in b.store
    # signedRequestId alone marks the worker signed too
    rid_only = dict(SIGNED_W, signedAt=None)
    assert _delete(b, S101, lambda wid: (rid_only, [])) == {"error": files.E_SIGNED}


def test_delete_refuses_a_signed_document_entry_of_any_worker():
    b = _signed_bucket()
    w = {"id": "w1", "docs": [{"id": "d1", "fileId": SCTR, "signed": True}]}
    assert _delete(b, SCTR, lambda wid: (w, [])) == {"error": files.E_SIGNED} and SCTR in b.store


def test_delete_of_an_unsigned_file_still_works():
    b = _signed_bucket()
    unsigned_w = {"id": "w1", "docFileId": S101, "sigFileId": SSIG, "docs": [{"id": "d2", "fileId": UPL}]}
    # an unsigned worker's Form 101, document and signature go; a request not yet signed protects nothing
    sent = {"workerId": "w1", "status": "sent", "templatePath": W + "/sign/r2/contract-template.pdf"}
    for p in (S101, UPL, SSIG):
        assert _delete(b, p, lambda wid: (unsigned_w, [sent])) == {"ok": True}
        assert p not in b.store
    # a signed worker's other files (a scanned page, an old sidecar) are not signed files
    b2 = _signed_bucket()
    b2.store[PAGE] = b"\xff\xd8"
    assert _delete(b2, PAGE, lambda wid: (SIGNED_W, [REQ])) == {"ok": True} and PAGE not in b2.store
    assert _delete(b2, ASSETS, lambda wid: (SIGNED_W, [REQ])) == {"ok": True} and ASSETS not in b2.store


def test_delete_looks_up_the_paths_worker():
    seen = []
    _delete(_signed_bucket(), UPL, lambda wid: seen.append(wid) or (None, []))
    assert seen == ["w1"]


def test_delete_without_a_lookup_deletes_nothing():
    b = _signed_bucket()
    assert files.run(b, ADMIN, {"action": "deleteWorkerDoc", "fileId": UPL}) == {"error": files.E_SIGNED}
    assert UPL in b.store
