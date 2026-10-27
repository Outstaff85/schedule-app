"""The firm's signature and stamp (functions/seal.py, docs/contracts.md → The firm's signature and
stamp): a stamp photo's paper made transparent, a drawn signature kept as drawn, who may change
them (may_firm_sign), the function's seal / sealSave / sealDelete on in-memory stand-ins for
Firestore and Storage — a firm sees only its own, the old file goes on a replace."""

import base64
import io
import math
import os
import sys

import pytest

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # after functions-auth: its main stays `main`
sys.path.insert(0, os.path.dirname(__file__))

from PIL import Image, ImageDraw  # noqa: E402
import contracts  # noqa: E402
import seal  # noqa: E402
from test_contracts import Bucket, Db  # noqa: E402

OWNER = {"uid": "u1", "role": "tenant_admin", "tenantId": "t1"}
SUPER = {"uid": "s", "role": "superadmin"}
STAFF = {"uid": "u2", "role": "staff", "tenantId": "t1", "rt": ["workers", "editWorkers"]}
STAFF_SEAL = {"uid": "u3", "role": "staff", "tenantId": "t1", "rt": ["workers", "firmSign"]}
HR_SEAL = {"uid": "u4", "role": "hr", "tenantId": "t1", "own": True, "rt": ["workers", "firmSign"]}
OTHER = {"uid": "u9", "role": "tenant_admin", "tenantId": "t2"}


def photo(w=900, h=700):
    """A phone photo of a stamp: grey paper lit unevenly (a gradient), a blue ring in the middle."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            v = int(150 + 80 * x / w + 15 * y / h)
            px[x, y] = (v, v, v - 5)
    d = ImageDraw.Draw(im)
    d.ellipse((w / 2 - 200, h / 2 - 200, w / 2 + 200, h / 2 + 200), outline=(30, 60, 180), width=14)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=92)
    return out.getvalue()


def drawn():
    """What the signature pad gives: a dark stroke on a transparent PNG."""
    im = Image.new("RGBA", (600, 240), (0, 0, 0, 0))
    ImageDraw.Draw(im).line([(40 + x, 120 + 50 * math.sin(x / 30)) for x in range(0, 500, 5)], fill=(10, 10, 40, 255), width=6)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def _b64(b):
    return base64.b64encode(b).decode()


def test_a_stamp_photo_loses_its_paper():
    png, w, h = seal.clean_stamp(photo())
    im = Image.open(io.BytesIO(png))
    assert im.mode == "RGBA" and (w, h) == im.size and max(w, h) <= seal.OUT_PX and len(png) <= seal.OUT_BYTES
    # cropped to the ring (400 px + its width + 4 px padding), not the whole photo
    assert 400 <= w <= 440 and 400 <= h <= 440
    a = im.getchannel("A")
    assert a.getpixel((0, 0)) == 0 and a.getpixel((w - 1, h - 1)) == 0 and a.getpixel((w // 2, h // 2)) == 0  # paper: transparent
    ring = max(a.getpixel((x, h // 2)) for x in range(0, 30))
    assert ring > 200  # the ring: ink
    r, g, b, _ = im.getpixel(next((x, h // 2) for x in range(30) if a.getpixel((x, h // 2)) > 200))
    assert b > r and b > g  # still blue


def test_a_big_photo_is_scaled_down():
    png, w, h = seal.clean_stamp(photo(2400, 1800))
    assert max(w, h) <= seal.OUT_PX


def test_not_a_picture_and_too_big_are_refused():
    with pytest.raises(ValueError, match=seal.E_NOT_PICTURE):
        seal.clean_stamp(b"%PDF-1.4 not a picture")
    with pytest.raises(ValueError, match=seal.E_TOO_BIG):
        seal.clean_stamp(b"\x89PNG" + b"0" * (seal.MAX_IN + 1))
    big = io.BytesIO()
    Image.new("L", (6100, 10), 255).save(big, "PNG")
    with pytest.raises(ValueError, match=seal.E_TOO_BIG):
        seal.clean_stamp(big.getvalue())
    blank = io.BytesIO()
    Image.new("RGB", (300, 300), (240, 240, 240)).save(blank, "PNG")
    with pytest.raises(ValueError, match=seal.E_EMPTY):
        seal.clean_stamp(blank.getvalue())


def test_a_drawn_signature_is_kept_as_drawn():
    png, w, h = seal.clean_signature(drawn(), drawn=True)
    im = Image.open(io.BytesIO(png))
    assert im.mode == "RGBA" and w < 600 and h < 240  # cropped to the stroke
    src = Image.open(io.BytesIO(drawn()))
    assert im.getchannel("A").getextrema()[1] == 255
    # its colour is the pad's: the darkest pixel is the stroke's
    import numpy as np
    a, b = np.asarray(im), np.asarray(src)
    assert a[a[..., 3] == 255][:, 0].min() == b[b[..., 3] == 255][:, 0].min()
    with pytest.raises(ValueError, match=seal.E_NOT_PICTURE):
        seal.clean_signature(photo(), drawn=True)  # the pad gives a PNG
    png2, _, _ = seal.clean_signature(photo(), drawn=False)  # an uploaded picture is cleaned as a stamp
    assert Image.open(io.BytesIO(png2)).getchannel("A").getpixel((0, 0)) == 0


def test_who_may():
    assert seal.may_firm_sign(OWNER) and seal.may_firm_sign(SUPER)
    assert seal.may_firm_sign(STAFF_SEAL) and seal.may_firm_sign(HR_SEAL)
    assert not seal.may_firm_sign(STAFF) and not seal.may_firm_sign({"role": "hr", "rt": ["workers"]})
    assert not seal.may_firm_sign({"role": "supplier", "rt": ["firmSign"]}) and not seal.may_firm_sign({"role": "client", "rt": ["firmSign"]})


def _run(db, bucket, claims, body):
    return contracts.run(db, bucket, claims, body)


def test_save_replace_delete_and_the_previews():
    db, bucket = Db(), Bucket()
    st = _run(db, bucket, STAFF, {"action": "seal"})
    assert st == {"ok": True, "hasStamp": False, "hasSignature": False, "canFirmSign": False}
    # without the right: refused, nothing stored
    assert _run(db, bucket, STAFF, {"action": "sealSave", "kind": "stamp", "imageBase64": _b64(photo())}) == {"error": seal.E_NO_RIGHT}
    assert _run(db, bucket, STAFF, {"action": "sealDelete", "kind": "stamp"}) == {"error": seal.E_NO_RIGHT}
    assert not bucket.store
    # the owner uploads a stamp, a staff login with the right draws the signature
    r = _run(db, bucket, OWNER, {"action": "sealSave", "kind": "stamp", "imageBase64": "data:image/jpeg;base64," + _b64(photo())})
    assert r["ok"] and r["preview"] and r["hasStamp"] and not r["hasSignature"]
    r = _run(db, bucket, STAFF_SEAL, {"action": "sealSave", "kind": "signature", "imageBase64": _b64(drawn()), "drawn": True})
    assert r["ok"] and r["hasSignature"]
    rec = db.data[("tenants", "t1", "firmSeal", "current")]
    assert rec["stamp"]["path"].startswith("tenants/t1/firmSeal/stamp-") and rec["signature"]["way"] == "drawn"
    assert rec["signature"]["by"] == "u3" and rec["stamp"]["w"] > 0
    assert sorted(bucket.store) == sorted([rec["stamp"]["path"], rec["signature"]["path"]])
    # a bad picture: refused, the stored one stays
    assert _run(db, bucket, OWNER, {"action": "sealSave", "kind": "stamp", "imageBase64": _b64(b"nope")}) == {"error": seal.E_NOT_PICTURE}
    assert rec["stamp"]["path"] in bucket.store
    assert _run(db, bucket, OWNER, {"action": "sealSave", "kind": "logo", "imageBase64": _b64(photo())}) == {"error": seal.E_KIND}
    # the previews: only for a login that may change them
    st = _run(db, bucket, STAFF, {"action": "seal"})
    assert st["hasStamp"] and st["hasSignature"] and "previews" not in st and not st["canFirmSign"]
    st = _run(db, bucket, HR_SEAL, {"action": "seal"})
    assert st["previews"]["stamp"] and st["previews"]["signature"] and st["signatureWay"] == "drawn"
    assert max(Image.open(io.BytesIO(base64.b64decode(st["previews"]["stamp"]))).size) <= seal.PREVIEW_PX
    # the list tells the app too
    lst = _run(db, bucket, STAFF, {"action": "list"})
    assert lst["seal"] == {"hasStamp": True, "hasSignature": True} and not lst["canFirmSign"]
    # another firm sees nothing of it
    assert _run(db, bucket, OTHER, {"action": "seal"})["hasStamp"] is False
    assert seal.load(db, bucket, "t2") == {"signature": None, "stamp": None}
    # a replace deletes the old file
    old = rec["stamp"]["path"]
    import time
    time.sleep(0.002)
    _run(db, bucket, OWNER, {"action": "sealSave", "kind": "stamp", "imageBase64": _b64(photo(800, 600))})
    new = db.data[("tenants", "t1", "firmSeal", "current")]["stamp"]["path"]
    assert new != old and old not in bucket.store and new in bucket.store
    # delete: the file and the field go
    assert _run(db, bucket, OWNER, {"action": "sealDelete", "kind": "stamp"})["hasStamp"] is False
    assert new not in bucket.store and db.data[("tenants", "t1", "firmSeal", "current")]["stamp"] is None
    # a super-admin works in the firm it views
    assert _run(db, bucket, SUPER, {"action": "seal", "asTenantId": "t1"})["hasSignature"]


def test_freeze_copies_and_read_frozen():
    db, bucket = Db(), Bucket()
    _run(db, bucket, OWNER, {"action": "sealSave", "kind": "stamp", "imageBase64": _b64(photo())})
    f = seal.freeze(db, bucket, "t1", "tenants/t1/workers/w1/sign/r1/")
    # under firmSeal/ (storage.rules: no browser reads it), never in the send's own folder, which managers read
    assert f == {"signature": None, "stamp": "tenants/t1/firmSeal/frozen/workers/w1/sign/r1/stamp.png"}
    assert seal.frozen_prefix("t1", "tenants/t1/transfers/r2/") == "tenants/t1/firmSeal/frozen/transfers/r2"
    got = seal.read_frozen(bucket, dict(f, everyPage=True))
    assert got["stamp"] == bucket.store[f["stamp"]] and got["signature"] is None and got["every_page"]
    assert seal.read_frozen(bucket, None) is None
