"""The whole cycle, end to end on the in-memory stand-ins, with the real code of both function folders (functions/ for the
templates and the signing, functions-auth/ for the deletes and the signed archive): a template saved and replaced, a
send, the worker's signature, both documents built, the contract removed from the card, the rest of the worker
deleted, a rescan of another worker, the firm deleted — and what the archive holds at the end (owner, 2026-11-03)."""

import base64
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "functions-auth"))
sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # last: functions-auth's main stays `main`
sys.path.insert(0, os.path.dirname(__file__))

import pymupdf  # noqa: E402
import contracts  # noqa: E402
import files  # noqa: E402
import signed_archive  # noqa: E402
import signing  # noqa: E402
from test_contracts import Bucket, Db, _b64, _pdf  # noqa: E402
from test_signing import OWNER, PNG, build101, finder  # noqa: E402

T = "t1"


def _jpeg(w, h, shade):
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (w, h), (shade, shade, shade)).save(out, "JPEG")
    return out.getvalue()


class CycleBucket(Bucket):
    def list_blobs(self, prefix=""):
        bucket = self

        class Listed:
            def __init__(self, name):
                self.name = name

            def delete(self):
                bucket.store.pop(self.name)
        return [Listed(k) for k in list(self.store) if k.startswith(prefix)]


def _lookup(db, wid):
    """main.py's signed_lookup over the stand-in: the worker and its signings, with their ids."""
    t = db.collection("tenants").document(T)
    snap = t.collection("workers").document(wid).get()
    reqs = [dict(d.to_dict(), _id=d.id) for d in t.collection("signRequests").stream() if (d.to_dict() or {}).get("workerId") == wid]
    return (snap.to_dict() if snap.exists else None), reqs


def _delete(db, b, path, manual=True):
    body = {"action": "deleteWorkerDoc", "fileId": path}
    if manual:
        body["manual"] = True
    return files.run(b, {"role": "tenant_admin", "tenantId": T}, body, None, lambda wid: _lookup(db, wid),
                     lambda p, w, r: signed_archive.put(db, b, T, p, w, r))


def test_the_whole_cycle():
    db, b = Db(), CycleBucket()
    t = db.collection("tenants").document(T)
    t.set({"companyName": "Odinson"})
    W = f"tenants/{T}/workers/w1"
    pages = {W + "/pages/1-0-id_front.jpg": ("id_front", _jpeg(856, 540, 30)), W + "/pages/1-1-id_back.jpg": ("id_back", _jpeg(856, 540, 90)),
             W + "/pages/1-2-sefach.jpg": ("sefach", _jpeg(600, 900, 160))}
    for p, (_, data) in pages.items():
        b.store[p] = data
    t.collection("workers").document("w1").set({
        "name": "Avi Cohen", "token": "tok-avi", "docGiven": "Avi", "docSurname": "Cohen", "docId": "123456782", "docType": "id",
        "scanPages": [{"fileId": p, "kind": k, "primary": k == "id_front"} for p, (k, _) in pages.items()]})
    b.store[W + "/docs/2-visa.pdf"] = b"%PDF visa"

    # 1. the template: saved, replaced (v1 kept), an unused one deleted for real
    light = contracts.light(_pdf())[0]
    tpl = contracts.run(db, b, OWNER, {"action": "save", "pdfBase64": _b64(light), "name": "Hourly", "category": "hourly"})["template"]
    contracts.run(db, b, OWNER, {"action": "save", "pdfBase64": _b64(light), "replaceId": tpl["id"]})
    spare = contracts.run(db, b, OWNER, {"action": "save", "pdfBase64": _b64(light), "name": "Spare"})["template"]
    contracts.run(db, b, OWNER, {"action": "delete", "id": spare["id"]})
    assert not [k for k in b.store if "/contracts/" + spare["id"] + "/" in k]
    assert [k for k in b.store if k.endswith("/contracts/" + tpl["id"] + "/v1.pdf")]

    # 2. send, sign by the worker's own link, both documents built
    sent = signing.run(db, b, OWNER, {"action": "send", "workerId": "w1", "templateId": tpl["id"], "signDate": "03/11/2026",
                                      "values": {"given": "Avi", "surname": "Cohen", "id": "123456782"},
                                      "form101": {"given": "Avi"}}, build101)
    assert sent.get("ok"), sent
    f = finder(db)
    assert signing.run_worker(db, b, {"action": "sign", "token": "tok-avi", "signaturePng": base64.b64encode(PNG).decode()}, build101, finder=f)["ok"]
    for which in ("form101", "contract"):
        signing.run_worker(db, b, {"action": "build", "token": "tok-avi", "which": which}, build101, finder=f)
    req = db.data[("tenants", T, "signRequests", sent["id"])]
    assert req["status"] == "signed"
    assert not [k for k in b.store if k.startswith("archive/")], "nothing archived at signing"
    assert db.data[("tenants", T, "contractTemplates", tpl["id"])]["signedCount"] == 1
    # the manager app puts the parts on the worker (as `applied` does)
    w = db.data[("tenants", T, "workers", "w1")]
    w.update(signedAt="x", docFileId=req["parts"]["form101"]["path"], sigFileId=req["sigPath"],
             docs=[{"id": "d1", "fileId": req["parts"]["contract"]["path"], "signed": True}, {"id": "d2", "fileId": W + "/docs/2-visa.pdf"}])

    # 3. the signed template can no longer be deleted for real: hidden, kept
    contracts.run(db, b, OWNER, {"action": "delete", "id": tpl["id"]})
    assert db.data[("tenants", T, "contractTemplates", tpl["id"])]["deletedAt"]

    # 4. the contract removed from the card: archived with its template and the scans, then deleted
    ctr = req["parts"]["contract"]["path"]
    assert _delete(db, b, ctr) == {"ok": True} and ctr not in b.store
    base = "archive/Odinson/Avi Cohen 123456782/"
    got = sorted(k[len(base):] for k in b.store if k.startswith(base))
    assert [g.split("/")[0] for g in got] == ["Contracts", "Contracts", "Contracts", "Scans"], got
    scans = pymupdf.open(stream=b.store[base + [g for g in got if g.startswith("Scans/")][0]])
    assert scans.page_count == 2  # three pictures: two on the first A4, the ספח on the second
    note = json.loads(b.store[base + [g for g in got if g.endswith(".json")][0]])
    assert note["way"] == "remote" and note["templateVersion"] == 2

    # 5. Delete worker: the signed Form 101 archived, the visa, the signature and the scans just deleted
    for p in [w["docFileId"], w["sigFileId"], W + "/docs/2-visa.pdf", *pages]:
        assert _delete(db, b, p) == {"ok": True}
    assert not [k for k in b.store if k.startswith(W + "/") and "/sign/" not in k]
    got = sorted(k[len(base):] for k in b.store if k.startswith(base))
    assert [g.split("/")[0] for g in got] == ["Contracts"] * 3 + ["Form 101"] * 2 + ["Scans"], got
    assert not [k for k in b.store if k.startswith("archive/") and ("visa" in k or "signature" in k)]

    # 6. another worker rescanned: the old pages just replaced, nothing archived
    W2 = f"tenants/{T}/workers/w2"
    b.store[W2 + "/pages/1-0-passport.jpg"] = _jpeg(800, 560, 50)
    t.collection("workers").document("w2").set({"name": "Dana", "docType": "passport"})
    assert _delete(db, b, W2 + "/pages/1-0-passport.jpg", manual=False) == {"ok": True}
    assert not [k for k in b.store if k.startswith("archive/") and "Dana" in k]

    # 7. the firm deleted: what is left signed is archived first, then every firm file goes; the archive stays
    before = sorted(k for k in b.store if k.startswith("archive/"))
    signed_archive.archive_tenant(db, b, T)
    files.delete_tenant_files(b, T)
    assert not [k for k in b.store if k.startswith("tenants/")]
    assert sorted(k for k in b.store if k.startswith("archive/")) == before
