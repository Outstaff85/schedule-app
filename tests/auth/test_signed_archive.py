"""The signed archive (functions-auth/signed_archive.py, docs/contracts.md → The signed archive; owner, 2026-11-03): a
document the worker signed by hand — and the scans it was signed on — is copied into
archive/<firm>/<given surname ID>/Form 101 | Contracts | Scans when a person deletes it, the worker or the firm, and
only then deleted; what was not signed by hand is deleted with no copy; a copy that fails stops the delete."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "functions-auth"))
sys.path.insert(0, os.path.dirname(__file__))

import files  # noqa: E402
import signed_archive  # noqa: E402
from test_contracts import Bucket, Db  # noqa: E402

T = "t1"
W = f"tenants/{T}/workers/w1"
F101, CTR, SIG, UPL = W + "/form101/1700-f101 Avi.pdf", W + "/docs/1700-Hourly - Avi.pdf", W + "/signature/1-sig.png", W + "/docs/2-visa.pdf"
PAGE1, PAGE2, NEWPAGE = W + "/pages/1-0-id_front.jpg", W + "/pages/1-1-appendix.jpg", W + "/pages/2-0-id_front.jpg"
TPL = W + "/sign/r1abcdef/contract-template.pdf"
REQ = {"_id": "r1abcdef", "workerId": "w1", "status": "signed", "way": "person", "sigPath": SIG, "signDate": "03/11/2026",
       "signedAtIso": "2026-11-03T10:00:00Z", "templateId": "tp", "templateName": "Hourly", "templateVersion": 2, "templatePath": TPL,
       "values": {"given": "Avi", "surname": "Cohen", "id": "123456782"},
       "frozen": {"pages": [{"fileId": PAGE1, "sha256": "x", "kind": "id_front"}, {"fileId": PAGE2, "sha256": "y"}]},
       "parts": {"form101": {"path": F101, "name": "f101 Avi.pdf"}, "contract": {"path": CTR, "name": "Hourly - Avi.pdf"}}}
WORKER = {"id": "w1", "name": "Avi", "docGiven": "Avi", "docSurname": "Cohen", "docId": "123456782", "signedAt": "x",
          "docFileId": F101, "sigFileId": SIG, "scanPages": [{"fileId": NEWPAGE}],
          "docs": [{"id": "d1", "fileId": CTR, "signed": True}, {"id": "d2", "fileId": UPL}]}
BASE = "archive/Odinson Ltd/Avi Cohen 123456782/"
ADMIN = {"role": "tenant_admin", "tenantId": T}


class ListBucket(Bucket):
    def list_blobs(self, prefix=""):
        bucket = self

        class Listed:
            def __init__(self, name):
                self.name = name

            def delete(self):
                bucket.store.pop(self.name)
        return [Listed(k) for k in list(self.store) if k.startswith(prefix)]


def _jpeg(w, h, shade):
    import io
    from PIL import Image
    out = io.BytesIO()
    Image.new("RGB", (w, h), (shade, shade, shade)).save(out, "JPEG")
    return out.getvalue()


def _world():
    db, b = Db(), ListBucket()
    db.collection("tenants").document(T).set({"companyName": "Odinson / Ltd"})
    for p in (F101, CTR, SIG, UPL, TPL):
        b.store[p] = ("bytes of " + p).encode()
    b.store[PAGE1], b.store[PAGE2], b.store[NEWPAGE] = _jpeg(856, 540, 40), _jpeg(600, 900, 120), _jpeg(856, 540, 200)
    return db, b


def _sheets(pdf):
    import pymupdf
    doc = pymupdf.open(stream=pdf)
    return [(round(p.rect.width), round(p.rect.height), len(p.get_images())) for p in doc]


def _delete(db, b, path, worker=WORKER, reqs=(REQ,), manual=True):
    def keep(p, w, r):
        signed_archive.put(db, b, T, p, w, r)
    body = {"action": "deleteWorkerDoc", "fileId": path}
    if manual:
        body["manual"] = True
    return files.run(b, ADMIN, body, None, lambda wid: (worker, list(reqs)), keep)


def _archived(b):
    return sorted(k[len(BASE):] for k in b.store if k.startswith(BASE))


def test_removing_a_signed_contract_archives_it_with_its_template_and_scans_then_deletes_it():
    db, b = _world()
    assert _delete(db, b, CTR) == {"ok": True}
    assert CTR not in b.store
    got = _archived(b)
    assert got == ["Contracts/2026-11-03 Hourly - Avi r1abcd.json", "Contracts/2026-11-03 Hourly - Avi r1abcd.pdf",
                   "Contracts/2026-11-03 Hourly - template v2 r1abcd.pdf", "Scans/2026-11-03 scans r1abcd.pdf"], got
    # the two pages it was signed on on one A4 sheet (A4 at 200 dpi read as points: 1654 x 2339 / 200 * 72)
    assert _sheets(b.store[BASE + "Scans/2026-11-03 scans r1abcd.pdf"]) == [(595, 842, 1)]
    assert b.store[BASE + "Contracts/2026-11-03 Hourly - Avi r1abcd.pdf"] == ("bytes of " + CTR).encode()
    assert b.store[BASE + "Contracts/2026-11-03 Hourly - template v2 r1abcd.pdf"] == ("bytes of " + TPL).encode()
    note = json.loads(b.store[BASE + "Contracts/2026-11-03 Hourly - Avi r1abcd.json"])
    assert note["way"] == "person" and note["requestId"] == "r1abcdef" and note["templateVersion"] == 2 and len(note["files"]) == 3
    assert note["files"][2]["from"] == [PAGE1, PAGE2]  # the scans it was signed on, not today's


def test_form_101_goes_to_its_own_folder_and_a_second_copy_never_overwrites():
    db, b = _world()
    assert _delete(db, b, F101) == {"ok": True}
    assert "Form 101/2026-11-03 f101 Avi r1abcd.pdf" in _archived(b)
    b.store[F101] = b"changed"
    _delete(db, b, F101)
    assert b.store[BASE + "Form 101/2026-11-03 f101 Avi r1abcd.pdf"] == ("bytes of " + F101).encode()


def test_what_was_not_signed_by_hand_is_deleted_with_no_copy():
    db, b = _world()
    for p in (UPL, SIG, NEWPAGE):
        assert _delete(db, b, p) == {"ok": True} and p not in b.store
    assert _archived(b) == []
    # an unsigned worker's Form 101 too
    db, b = _world()
    assert _delete(db, b, F101, {"id": "w1", "docFileId": F101}, ()) == {"ok": True}
    assert F101 not in b.store and _archived(b) == []


def test_a_rescan_just_replaces_the_pages_and_a_later_delete_takes_the_new_ones():
    db, b = _world()
    for p in (PAGE1, PAGE2):  # the rescan's deletes on their own: nothing archived (owner, 2026-11-03)
        assert _delete(db, b, p, manual=False) == {"ok": True} and p not in b.store
    assert _archived(b) == []
    assert _delete(db, b, CTR) == {"ok": True}
    note = json.loads(b.store[BASE + "Contracts/2026-11-03 Hourly - Avi r1abcd.json"])
    assert note["files"][2]["from"] == [NEWPAGE]  # the worker's pages now
    assert _sheets(b.store[BASE + "Scans/2026-11-03 scans r1abcd.pdf"]) == [(595, 842, 1)]


def test_the_worker_record_gone_names_the_folder_from_the_signing():
    db, b = _world()
    assert _delete(db, b, CTR, None) == {"ok": True}
    assert any(k.startswith(BASE + "Contracts/") for k in b.store)


def test_a_signing_from_before_the_requests_is_archived_from_the_worker_record():
    db, b = _world()
    assert _delete(db, b, F101, dict(WORKER, signDate="01/02/2026"), ()) == {"ok": True}
    got = _archived(b)
    assert [g for g in got if g.startswith("Form 101/2026-02-01 f101 Avi ")] and [g for g in got if g.startswith("Scans/2026-02-01 scans ")]


def test_a_copy_that_fails_stops_the_delete():
    db, b = _world()
    real = b.blob

    def blob(path):
        x = real(path)
        if path.startswith("archive/"):
            def up(*a, **k):
                raise ConnectionError("no storage")
            x.upload_from_string = up
        return x
    b.blob = blob
    assert _delete(db, b, CTR) == {"error": files.E_NOT_ARCHIVED} and CTR in b.store


def test_a_firm_s_delete_archives_every_signed_document_first_and_the_archive_stays():
    db, b = _world()
    t = db.collection("tenants").document(T)
    t.collection("workers").document("w1").set({k: v for k, v in WORKER.items() if k != "id"})
    t.collection("signRequests").document("r1abcdef").set({k: v for k, v in REQ.items() if k != "_id"})
    assert signed_archive.archive_tenant(db, b, T) == 2
    files.delete_tenant_files(b, T)
    assert not any(k.startswith("tenants/") for k in b.store)
    got = _archived(b)
    assert [g.split("/")[0] for g in got] == ["Contracts"] * 3 + ["Form 101"] * 2 + ["Scans"], got


def test_a_firm_s_delete_stops_when_a_copy_fails():
    db, b = _world()
    t = db.collection("tenants").document(T)
    t.collection("signRequests").document("r1abcdef").set({k: v for k, v in REQ.items() if k != "_id"})
    real = b.blob

    def blob(path):
        x = real(path)
        if path.startswith("archive/"):
            def up(*a, **k):
                raise ConnectionError("no storage")
            x.upload_from_string = up
        return x
    b.blob = blob
    try:
        signed_archive.archive_tenant(db, b, T)
        assert False, "should stop"
    except signed_archive.NotArchived:
        pass


def test_two_pictures_to_an_a4_sheet_the_document_first_a_third_starts_another():
    from PIL import Image
    import io
    front, back, sefach, other = _jpeg(856, 540, 10), _jpeg(856, 540, 90), _jpeg(600, 900, 170), _jpeg(700, 1000, 250)
    pdf = signed_archive.scans_pdf([front, back, sefach])
    assert _sheets(pdf) == [(595, 842, 1), (595, 842, 1)]
    # the order on the sheets: the document, then its back or the appendix, then the rest — whatever the scan's order
    b = ListBucket()
    for name, data in (("o", other), ("s", sefach), ("f", front), ("k", back)):
        b.store[name] = data
    pics = signed_archive._pictures(b, [{"path": "o", "kind": "other"}, {"path": "s", "kind": "sefach"},
                                        {"path": "f", "kind": "id_front"}, {"path": "k", "kind": "id_back"}])
    assert pics == [front, back, sefach, other]
    import pymupdf
    page = pymupdf.open(stream=signed_archive.scans_pdf([front, sefach]))[0]
    im = Image.open(io.BytesIO(page.get_pixmap(dpi=20).tobytes("png"))).convert("L")
    assert im.getpixel((im.width // 2, im.height // 4)) < 60 and im.getpixel((im.width // 2, im.height * 3 // 4)) > 120  # front above
    assert signed_archive.scans_pdf([b"not a picture"]) is None
