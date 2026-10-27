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

    def create(self, d):
        if self.path in self.db.data:
            raise ValueError("Already exists")
        self.db.data[self.path] = dict(d)

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



# ---- the firm's signature and stamp (seal.py) ----------------------------------------------

def _seal_pngs():
    from PIL import Image, ImageDraw
    out = []
    for size, colour in (((300, 120), (20, 20, 40, 255)), ((200, 200), (30, 60, 170, 255))):
        im = Image.new("RGBA", size, (0, 0, 0, 0))
        ImageDraw.Draw(im).ellipse((5, 5, size[0] - 5, size[1] - 5), outline=colour, width=8)
        b = io.BytesIO()
        im.save(b, "PNG")
        out.append(b.getvalue())
    return out


def _pages(n=3, rotate=0, marks=False):
    doc = pymupdf.open()
    for i in range(n):
        page = doc.new_page()
        page.insert_text((50, 100), "Page " + str(i + 1) + " {{given}}", fontsize=12)
        if marks and i == 0:
            page.insert_text((50, 300), "Firm: {{company_signature}}   Stamp: {{stamp}}", fontsize=12)
        if rotate:
            page.set_rotation(rotate)
    return doc.tobytes()


def _infos(page):
    return [(i["xref"], pymupdf.Rect(i["bbox"])) for i in page.get_image_info(xrefs=True)]


def test_seal_on_every_page_bottom_right_the_stamp_over_the_signature():
    sig, stamp = _seal_pngs()
    out = contracts.fill(_pages(3), {"given": "Avi"}, seal={"signature": sig, "stamp": stamp, "every_page": True})
    doc = pymupdf.open(stream=out)
    xrefs = set()
    for page in doc:
        info = _infos(page)
        assert len(info) == 2
        W, H = page.rect.width, page.rect.height
        assert all(r.x0 > W / 2 and r.y0 > H / 2 for _, r in info)  # bottom right
        (x_sig, r_sig), (x_stamp, r_stamp) = info  # drawn in this order: the stamp lies over the signature
        assert r_sig.width > r_sig.height and abs(r_stamp.width - r_stamp.height) < 1
        assert r_stamp.intersects(r_sig) and r_stamp.x1 > r_sig.x1
        xrefs |= {x_sig, x_stamp}
    assert len(xrefs) == 2  # each picture kept once in the file
    # a missing picture draws nothing
    one = pymupdf.open(stream=contracts.fill(_pages(2), {}, seal={"signature": None, "stamp": stamp, "every_page": True}))
    assert all(len(p.get_images()) == 1 for p in one)
    # not ticked: nothing at the bottom
    off = pymupdf.open(stream=contracts.fill(_pages(2), {}, seal={"signature": sig, "stamp": stamp, "every_page": False}))
    assert all(not p.get_images() for p in off)


def test_seal_marks_drawn_in_place_and_blank_without_a_picture():
    sig, stamp = _seal_pngs()
    doc = pymupdf.open(stream=contracts.fill(_pages(1, marks=True), {"given": "Avi"}, seal={"signature": sig, "stamp": stamp}))
    t = doc[0].get_text()
    assert "{{" not in t and "company_signature" not in t and "stamp}}" not in t and "Avi" in t
    info = _infos(doc[0])
    assert len(info) == 2 and all(r.y1 < 400 for _, r in info)  # at the marks, not at the bottom
    assert info[0][1].width > info[0][1].height  # the signature first, then the stamp
    # no seal at all: no pictures, the marks whited out and left blank
    doc = pymupdf.open(stream=contracts.fill(_pages(1, marks=True), {"given": "Avi"}))
    assert not doc[0].get_images() and "company_signature" not in doc[0].get_text() and "{{stamp}}" not in doc[0].get_text()


def test_seal_lands_bottom_right_of_a_turned_page():
    from PIL import Image
    sig, stamp = _seal_pngs()
    for rot in (90, 180, 270):
        doc = pymupdf.open(stream=contracts.fill(_pages(1, rotate=rot), {}, seal={"signature": sig, "stamp": stamp, "every_page": True}))
        pix = doc[0].get_pixmap(dpi=40)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        # what is drawn in colour (the text is black, the pictures are dark blue / blue)
        px = im.load()
        pts = [(x, y) for y in range(pix.height) for x in range(pix.width) if px[x, y][2] > px[x, y][0] + 40]
        assert pts, rot
        assert min(x for x, _ in pts) > pix.width / 2 and min(y for _, y in pts) > pix.height / 2, (rot, pix.width, pix.height)


def test_the_every_page_tick_on_templates():
    db, bucket = Db(), Bucket()
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "A"})
    on = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "A"})["template"]
    off = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "B", "sealEveryPage": False})["template"]
    assert on["sealEveryPage"] is True and off["sealEveryPage"] is False
    # a template saved before the tick: no field, which is on too (owner, 2026-10-27) — only an explicit false is off
    db.data[("tenants", "t1", "contractTemplates", on["id"])].pop("sealEveryPage")
    assert contracts.run(db, bucket, OWNER, {"action": "list"})["templates"][0]["sealEveryPage"] is True
    assert contracts.seal_every_page({}) and contracts.seal_every_page({"sealEveryPage": None}) and not contracts.seal_every_page({"sealEveryPage": False})
    # its sample draws the seal (the made-up signature and stamp + the worker's signature at its mark)
    smp = contracts.run(db, bucket, OWNER, {"action": "file", "id": on["id"], "sample": True})
    assert len(pymupdf.open(stream=base64.b64decode(smp["pdfBase64"]))[0].get_images()) == 3
    # the ⋮ toggle of such a template turns it off
    assert contracts.run(db, bucket, OWNER, {"action": "update", "id": on["id"], "sealEveryPage": False})["template"]["sealEveryPage"] is False
    # a new version keeps the old value unless it sends one; update toggles it
    assert contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "replaceId": off["id"]})["template"]["sealEveryPage"] is False
    assert contracts.run(db, bucket, OWNER, {"action": "update", "id": off["id"], "sealEveryPage": True})["template"]["sealEveryPage"] is True
    assert contracts.run(db, bucket, STAFF, {"action": "update", "id": off["id"], "sealEveryPage": False}) == {"error": contracts.E_NO_RIGHT}


def test_the_sample_shows_the_firms_real_seal_or_made_up_ones():
    db, bucket = Db(), Bucket()
    p = contracts.run(db, bucket, OWNER, {"action": "prepare", "pdfBase64": _b64(_pdf()), "name": "A"})
    # prepare's sample: made-up signature and stamp at the bottom, and the worker's made-up signature at its mark
    assert len(pymupdf.open(stream=base64.b64decode(p["sampleBase64"]))[0].get_images()) == 3
    t = contracts.run(db, bucket, OWNER, {"action": "save", "pdfBase64": p["lightBase64"], "name": "A"})["template"]

    def widths(claims=OWNER):
        doc = pymupdf.open(stream=base64.b64decode(contracts.run(db, bucket, claims, {"action": "file", "id": t["id"], "sample": True})["pdfBase64"]))
        return sorted(i[2] for i in doc[0].get_images())

    made_up = widths()
    assert len(made_up) == 3
    sig, stamp = _seal_pngs()
    db.collection("tenants").document("t1").collection("firmSeal").document("current").set(
        {"stamp": {"path": "tenants/t1/firmSeal/stamp-1.png"}, "signature": None})
    bucket.store["tenants/t1/firmSeal/stamp-1.png"] = stamp
    real = widths()
    assert 200 in real and 200 not in made_up  # the firm's own stamp (200 px wide)
    # a login with the right firmSign sees the real one; a login without it (staff, HR) only the made-up ones
    assert widths(dict(STAFF, rt=["firmSign"])) == real
    assert widths(STAFF) == made_up and widths({"uid": "u5", "role": "hr", "tenantId": "t1", "rt": ["workers"]}) == made_up
    # unticked: only the worker's made-up signature at its mark
    contracts.run(db, bucket, OWNER, {"action": "update", "id": t["id"], "sealEveryPage": False})
    assert len(widths()) == 1
