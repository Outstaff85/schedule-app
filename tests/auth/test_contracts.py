"""Contract templates (functions/contracts.py, docs/contracts.md → Contract templates): the marks
found in a PDF's text (also in a Hebrew line whose braces come out mirrored), the light copy
checked against the original, the filling (values in place of the marks, the signature, marks
placed by hand on a picture page), and the function's actions on in-memory stand-ins for
Firestore and Storage: a firm sees only its own, only its admin manages them."""

import base64
import io
import os
import sys

import pytest

sys.path.append(os.path.join(os.path.dirname(__file__), "..", "..", "functions"))  # after functions-auth: its main stays `main`

import pymupdf  # noqa: E402
import contracts  # noqa: E402

FONT = os.path.join(os.path.dirname(__file__), "..", "..", "functions", "assets", "heebo-hebrew.ttf")


def _pdf(heavy=False, picture=False):
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_htmlbox(pymupdf.Rect(40, 60, 550, 160),
                        '<p dir="rtl" style="font-size:12pt">אני {{full_name}} ת.ז. {{id}}' + "&nbsp;" * 12 + "מסכים לתנאים. {{tpyo}}</p>")
    page.insert_text((50, 250), "Name: {{given}} {{surname}}       Start: {{start_date}}", fontsize=12)
    page.insert_text((50, 300), "Signature: {{signature}}     Date: {{sign_date}}", fontsize=12)
    if heavy:  # a big photo-like picture: made light to 200 dpi
        from PIL import Image
        im = Image.effect_noise((3000, 2000), 60).convert("RGB")
        out = io.BytesIO()
        im.save(out, "PNG")
        page.insert_image(pymupdf.Rect(50, 400, 350, 600), stream=out.getvalue())
    if picture:  # a scanned page: a picture only
        p2 = doc.new_page()
        from PIL import Image, ImageDraw
        im = Image.new("RGB", (1240, 1754), "white")
        ImageDraw.Draw(im).text((100, 100), "Scanned contract page", fill="black")
        out = io.BytesIO()
        im.save(out, "JPEG", quality=90)
        p2.insert_image(p2.rect, stream=out.getvalue())
    return doc.tobytes()


def test_marks_found_in_both_directions_and_typos_listed():
    found, unknown = contracts.find_marks(pymupdf.open(stream=_pdf()))
    names = [f["mark"] for f in found]
    assert sorted(names) == sorted(["full_name", "id", "given", "surname", "start_date", "signature", "sign_date"])
    assert unknown == ["tpyo"]
    rtl = {f["mark"]: f["rtl"] for f in found}
    assert rtl["full_name"] and rtl["id"] and not rtl["given"]


def test_light_keeps_the_look_and_the_marks_and_shrinks_pictures():
    data = _pdf(heavy=True)
    out, info = contracts.light(data)
    assert info["lightSize"] < info["origSize"] / 2, (info["origSize"], info["lightSize"])
    assert len(info["found"]) == 7 and info["unknown"] == ["tpyo"] and info["pictures"] == []
    ok, _ = contracts.same_look(pymupdf.open(stream=data), pymupdf.open(stream=out))
    assert ok


def test_light_refuses_what_is_not_a_pdf():
    with pytest.raises(ValueError, match="not a PDF"):
        contracts.light(b"hello")


def test_picture_page_found():
    out, info = contracts.light(_pdf(picture=True))
    assert info["pictures"] == [1]


def test_fill_writes_values_in_place_of_marks():
    out, _ = contracts.light(_pdf(picture=True))
    placed = [{"mark": "given", "page": 1, "x": 100, "y": 200, "w": 150, "h": 14}]
    filled = contracts.fill(out, contracts.SAMPLE_VALUES, placed, contracts.sample_signature())
    doc = pymupdf.open(stream=filled)
    t0, t1 = doc[0].get_text(), doc[1].get_text()
    assert "{{" not in t0.replace("{{tpyo}}", "").replace("}}tpyo{{", "") and "}}" not in t0.replace("}}tpyo", "").replace("tpyo}}", "")
    assert "123456782" in t0 and "01/01/2026" in t0
    assert "ישראל" in t1 or "לארשי" in t1  # placed by hand on the picture page
    assert len(doc[0].get_images()) == 1  # the signature


def test_fill_leaves_an_empty_value_empty_and_no_signature_blank():
    out, _ = contracts.light(_pdf())
    doc = pymupdf.open(stream=contracts.fill(out, {"given": "Avi"}, None, None))
    t = doc[0].get_text()
    assert "Avi" in t and "{{surname}}" not in t and not doc[0].get_images()


# ---- the function's actions -------------------------------------------------

class Blob:
    def __init__(self, store, path):
        self.store, self.path, self.metadata = store, path, None

    def exists(self):
        return self.path in self.store

    def download_as_bytes(self):
        return self.store[self.path]

    def upload_from_string(self, data, content_type=None):
        self.store[self.path] = data

    def delete(self):
        del self.store[self.path]


class Bucket:
    def __init__(self):
        self.store = {}

    def blob(self, path):
        return Blob(self.store, path)


class Snap:
    def __init__(self, id, data):
        self.id, self._d = id, data

    @property
    def exists(self):
        return self._d is not None

    def to_dict(self):
        return dict(self._d) if self._d is not None else None


class Doc:
    def __init__(self, db, path):
        self.db, self.path, self.id = db, path, path[-1]

    def get(self):
        return Snap(self.id, self.db.data.get(self.path))

    def set(self, d):
        self.db.data[self.path] = dict(d)

    def update(self, d):
        for k, v in d.items():  # a dotted key is a field inside a map, as in Firestore
            cur = self.db.data[self.path]
            *head, last = k.split(".")
            for h in head:
                cur = cur.setdefault(h, {})
            cur[last] = v

    def delete(self):
        self.db.data.pop(self.path, None)

    def collection(self, name):
        return Coll(self.db, self.path + (name,))


class Coll:
    def __init__(self, db, path):
        self.db, self.path = db, path

    def document(self, id):
        return Doc(self.db, self.path + (id,))

    def stream(self):
        return [Snap(p[-1], d) for p, d in list(self.db.data.items()) if p[:-1] == self.path]

    def add(self, d):
        self.db.data[self.path + (str(len(self.db.data)),)] = dict(d)


class Db:
    def __init__(self):
        self.data = {}

    def collection(self, name):
        return Coll(self, (name,))


OWNER = {"uid": "u1", "role": "tenant_admin", "tenantId": "t1"}
STAFF = {"uid": "u2", "role": "staff", "tenantId": "t1"}
OTHER = {"uid": "u9", "role": "tenant_admin", "tenantId": "t2"}


def _b64(b):
    return base64.b64encode(b).decode()


def test_prepare_save_list_sample_update_delete():
    db, bucket = Db(), Bucket()
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf(heavy=True)), "name": "Hourly"})
    assert p["ok"] and p["lightSize"] < p["origSize"] and "full_name" in p["marks"] and p["unknown"] == ["tpyo"]
    assert p["sampleBase64"] and len(p["pages"]) == 1 and p["pages"][0]["png"]
    s = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Hourly", "category": "hourly", "origSize": p["origSize"]})
    t = s["template"]
    assert t["isDefault"] and t["category"] == "hourly" and t["version"] == 1 and t["signedCount"] == 0
    assert list(bucket.store) == [k for k in bucket.store if k.startswith("tenants/t1/contracts/" + t["id"] + "/")]
    s2 = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Hourly 2", "category": "hourly"})
    assert not s2["template"]["isDefault"]  # the category already has its default
    # a worker's own template: listed only with that worker
    s3 = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "Avi's", "workerId": "w1"})
    assert not s3["template"]["isDefault"] and s3["template"]["workerId"] == "w1"
    firm = contracts.run(db, bucket, STAFF, {"action": "list"})
    assert [x["name"] for x in firm["templates"]] == ["Hourly", "Hourly 2"] and not firm["canManage"]
    assert len(contracts.run(db, bucket, OWNER, {"action": "list", "workerId": "w1"})["templates"]) == 3
    # another firm sees none of them, and can't open one
    assert contracts.run(db, bucket, OTHER, {"action": "list"})["templates"] == []
    assert contracts.run(db, bucket, OTHER, {"action": "file", "id": t["id"]}) == {"error": contracts.E_NOT_FOUND}
    # the sample: filled with made-up data
    f = contracts.run(db, bucket, STAFF, {"action": "file", "id": t["id"], "sample": True})
    assert "123456782" in pymupdf.open(stream=base64.b64decode(f["pdfBase64"]))[0].get_text()
    # only the firm's admin changes them
    assert contracts.run(db, bucket, STAFF, {"action": "update", "id": t["id"], "name": "x"}) == {"error": contracts.E_NO_RIGHT}
    assert contracts.run(db, bucket, STAFF, {"action": "prepare", "pdfBase64": p["lightBase64"]}) == {"error": contracts.E_NO_RIGHT}
    # make the second the default: the first stops being it
    contracts.run(db, bucket, OWNER, {"action": "update", "id": s2["template"]["id"], "isDefault": True})
    by = {x["name"]: x for x in contracts.run(db, bucket, OWNER, {"action": "list"})["templates"]}
    assert by["Hourly 2"]["isDefault"] and not by["Hourly"]["isDefault"]
    # a new version replaces the file
    old_file = db.data[("tenants", "t1", "contractTemplates", t["id"])]["fileId"]
    r = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "replaceId": t["id"]})
    assert r["template"]["version"] == 2 and r["template"]["name"] == "Hourly" and old_file not in bucket.store
    # delete: the file goes, the default passes on
    contracts.run(db, bucket, OWNER, {"action": "delete", "id": s2["template"]["id"]})
    left = contracts.run(db, bucket, OWNER, {"action": "list"})["templates"]
    assert [x["name"] for x in left] == ["Hourly"] and left[0]["isDefault"]


def test_a_super_admin_works_in_the_firm_it_views():
    db, bucket = Db(), Bucket()
    sa = {"uid": "s", "role": "superadmin"}
    assert contracts.run(db, bucket, sa, {"action": "list"}) == {"error": contracts.E_NO_FIRM}
    assert contracts.run(db, bucket, sa, {"action": "list", "asTenantId": "t2"})["canManage"]


def test_heavy_or_broken_upload_goes_to_admin_errors():
    db, bucket = Db(), Bucket()
    r = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(b"not a pdf"), "name": "bad"})
    assert r == {"error": contracts.E_NOT_PDF}
    errs = [d for p, d in db.data.items() if p[0] == "errors"]
    assert len(errs) == 1 and "bad" in errs[0]["message"] and errs[0]["tenantId"] == "t1"
    old = contracts.HEAVY_BYTES
    contracts.HEAVY_BYTES = 1000
    try:
        r = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "big"})
    finally:
        contracts.HEAVY_BYTES = old
    assert r["ok"] and r["heavy"]
    errs = [d for p, d in db.data.items() if p[0] == "errors"]
    assert len(errs) == 2 and "Heavy contract template: big" in errs[1]["message"]
