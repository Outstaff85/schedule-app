"""The scanner's training examples (docs/scan-plan.md → S6): a page whose corners the
user moved in the scan window teaches the document edges model. The phone sends, per page,
a 256×256 copy of the photo the model saw (never the full photo) with the model's
corners and the user's; scan_feedback (main.py) keeps them 12 months in Storage
training/scan/<YYYY-MM>/<id>.jpg and Firestore scanTraining/<id>, and counts them in
scanTrainingStats/current for the "time to retrain" notice. Pure checks here."""
import base64
import datetime
import math

MAX_EXAMPLES = 20          # per request
MAX_IMAGE_BYTES = 80_000   # a 256×256 JPEG
MOVED_MIN = 0.005          # corners moved less than this: the model was right (counted, not kept)
RETRAIN_AT = 200           # new kept examples that make the retraining due
DOCTYPE_AT = 100           # page copies of each document type that make the first document type model due
KEEP_DAYS = 365
SOURCES = ("model", "phone", "more", "photo", "whole")
DOCTYPES = ("id_front", "id_back", "sefach", "passport", "contract", "other")
DOCTYPES_TRAINED = DOCTYPES[:5]  # the types the document type model must have enough of ("other" is rare by design)
# The names an example had before H0 (docs/hf-plan.md): a phone with the old app, or a queued example, still sends them.
OLD_NAMES = {"cornersModel": "edgesModel", "cornersFixed": "edgesFixed", "kindModel": "doctypeModel", "kindFixed": "doctypeFixed", "kindBy": "doctypeBy"}


def _corners(v):
    """4 [x, y] pairs in 0..1, else None."""
    if not isinstance(v, list) or len(v) != 4:
        return None
    out = []
    for p in v:
        if not isinstance(p, list) or len(p) != 2:
            return None
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(x) and math.isfinite(y)) or not (-0.01 <= x <= 1.01 and -0.01 <= y <= 1.01):
            return None
        out.append([round(min(max(x, 0.0), 1.0), 5), round(min(max(y, 0.0), 1.0), 5)])
    return out


def moved(a, b):
    """How far the user moved the corners: the largest corner shift, 0..1."""
    return max(math.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(a, b))


def _jpeg(v):
    try:
        b = base64.b64decode(str(v or ""), validate=True)
    except Exception:
        return None
    return b if b.startswith(b"\xff\xd8") and len(b) <= MAX_IMAGE_BYTES else None


def check(example):
    """(the example cleaned, None) or (None, why it is refused). A page is kept when its
    corners were moved (with the copy of the part the model saw) or its document type was changed
    (with a copy of the page); otherwise it is only counted."""
    if not isinstance(example, dict):
        return None, "not an object"
    example = {**{new: example[old] for old, new in OLD_NAMES.items() if old in example and new not in example}, **example}
    model, fixed = _corners(example.get("edgesModel")), _corners(example.get("edgesFixed"))
    if not model or not fixed:
        return None, "bad corners"
    source = example.get("source") if example.get("source") in SOURCES else "model"
    version = str(example.get("model") or "base-v1")[:40]
    shift = round(moved(model, fixed), 5)
    image = None
    keep_right = example.get("keep") is True and shift < MOVED_MIN
    if shift >= MOVED_MIN or keep_right:  # a corrected page, or one in five the model got right, carries its copy
        try:
            base64.b64decode(str(example.get("image") or ""), validate=True)
        except Exception:
            return None, "bad image"
        image = _jpeg(example.get("image"))
        if image is None:
            return None, "the image is not a small JPEG"
    doctype_model = example.get("doctypeModel") if example.get("doctypeModel") in DOCTYPES else None
    doctype_fixed = example.get("doctypeFixed") if example.get("doctypeFixed") in DOCTYPES else doctype_model
    doctype_by = "model" if example.get("doctypeBy") == "model" else "haiku"  # who gave doctypeModel (S7)
    page_image = None
    if doctype_model and doctype_fixed != doctype_model:
        page_image = _jpeg(example.get("pageImage"))
        if page_image is None:
            return None, "a changed document type needs a small JPEG of the page"
    elif doctype_model and keep_right:  # a sampled right page also teaches the document type model; its copy is optional
        page_image = _jpeg(example.get("pageImage"))
    return {"image": image, "edgesModel": model, "edgesFixed": fixed, "source": source, "model": version,
            "moved": shift, "doctypeModel": doctype_model, "doctypeFixed": doctype_fixed, "doctypeBy": doctype_by, "pageImage": page_image, "right": keep_right,
            # the document type model's answer in shadow mode (Admin → Scanner): only compared, never trusted
            "doctypeShadow": example.get("doctypeShadow") if example.get("doctypeShadow") in DOCTYPES else None}, None


def kept(ex):
    """Whether the example is kept (its corners moved, its document type changed, or a sampled page the
    model got right), else only counted."""
    return ex["moved"] >= MOVED_MIN or ex["pageImage"] is not None or ex["right"]


def correction(ex):
    """Whether the example corrects the model (counts toward retraining); a kept right one does not."""
    return ex["moved"] >= MOVED_MIN or (ex["doctypeModel"] is not None and ex["doctypeFixed"] != ex["doctypeModel"])


def edges_since(stats):
    """The corrections since the last document edges training (stats.edgesSince; newSince
    is its name before H0, added until a training resets both)."""
    return int(stats.get("edgesSince") or 0) + int(stats.get("newSince") or 0)


def shadow_counts(ex):
    """What a page tells about the document type model in shadow: (pages, the model right,
    Haiku right) — right meaning the type the user left; nothing when it has no shadow answer."""
    if ex.get("doctypeShadow") is None or ex.get("doctypeFixed") is None:
        return {}
    return {"shadowPages": 1, "shadowModelRight": int(ex["doctypeShadow"] == ex["doctypeFixed"]),
            "shadowHaikuRight": int(ex.get("doctypeBy") == "haiku" and ex.get("doctypeModel") == ex["doctypeFixed"])}


def doctype_counts(stats):
    """The page copies of each document type since the last document type training
    (stats.doctypesSince; kindsSince is its name before H0, added until a training resets both)."""
    new, old = (stats.get(k) if isinstance(stats.get(k), dict) else {} for k in ("doctypesSince", "kindsSince"))
    return {k: int(new.get(k) or 0) + int(old.get(k) or 0) for k in DOCTYPES}


def doctypes_due(stats):
    """Whether the document type model can be trained: DOCTYPE_AT copies of every trained type."""
    counts = doctype_counts(stats)
    return all(counts[k] >= DOCTYPE_AT for k in DOCTYPES_TRAINED)


def record(ex, tenant_id, now, path, page_path=None):
    """The Firestore record of a kept example (deleted by the TTL policy on deleteAt).
    path: the corners' copy (None when only the document type was changed); page_path: the page's."""
    return {"edgesModel": ex["edgesModel"], "edgesFixed": ex["edgesFixed"], "moved": ex["moved"],
            "source": ex["source"], "model": ex["model"], "tenantId": tenant_id or "", "image": path,
            "doctypeModel": ex["doctypeModel"], "doctypeFixed": ex["doctypeFixed"], "doctypeBy": ex.get("doctypeBy", "haiku"), "pageImage": page_path, "right": ex["right"],
            "doctypeShadow": ex.get("doctypeShadow"),
            "createdAt": now, "deleteAt": now + datetime.timedelta(days=KEEP_DAYS)}


def image_path(now, doc_id, suffix=""):
    return f"training/scan/{now:%Y-%m}/{doc_id}{suffix}.jpg"


# ---------- full documents for the field reader model (docs/hf-plan.md → H8a) ----------
# On the save of the worker window after a scan: the scan's pages as the AI read them, the
# AI's read, and what the user saved — the right answer, and where the AI was wrong.
DOC_MAX_PAGES = 6
DOC_MAX_PAGE_BYTES = 3_000_000
DOC_MAX_READ_BYTES = 200_000
# the worker fields a document fills (src/scan-process/worker.ts workerFields)
DOC_FIELDS = ("docType", "docGiven", "docSurname", "docId", "docDob", "docSex", "docExpiry", "address", "houseNumber", "city",
              "maritalStatus", "docChildren", "children", "spouseGiven", "spouseSurname", "spouseId")


def _doc_jpeg(v):
    try:
        b = base64.b64decode(str(v or ""), validate=True)
    except Exception:
        return None
    return b if b.startswith(b"\xff\xd8") and len(b) <= DOC_MAX_PAGE_BYTES else None


def _fields(v):
    if not isinstance(v, dict):
        return {}
    return {k: v[k] for k in DOC_FIELDS if k in v and v[k] not in (None, "")}


def check_document(p):
    """(the document cleaned, None) or (None, why it is refused)."""
    import json
    pages = p.get("pages")
    if not isinstance(pages, list) or not pages or len(pages) > DOC_MAX_PAGES:
        return None, "no pages"
    out = []
    for pg in pages:
        data = _doc_jpeg(pg.get("b64") if isinstance(pg, dict) else None)
        if data is None:
            return None, "a page is not a JPEG"
        dt = pg.get("doctype") if pg.get("doctype") in DOCTYPES else None
        out.append({"image": data, "doctype": dt, "primary": pg.get("primary") is True})
    read = p.get("read") if isinstance(p.get("read"), dict) else {}
    if len(json.dumps(read, default=str)) > DOC_MAX_READ_BYTES:
        return None, "the read is too large"
    reads = [r for r in (p.get("reads") or []) if isinstance(r, dict)][:DOC_MAX_PAGES]
    if len(json.dumps(reads, default=str)) > DOC_MAX_READ_BYTES:
        return None, "the reads are too large"
    scanned, saved = _fields(p.get("scanned")), _fields(p.get("saved"))
    if not saved:
        return None, "nothing saved"
    corrected = sorted(k for k in set(scanned) | set(saved) if str(scanned.get(k, "")) != str(saved.get(k, "")))
    return {"pages": out, "read": read, "reads": reads, "scanned": scanned, "saved": saved, "corrected": corrected,
            "workerId": str(p.get("workerId") or "")[:64]}, None


def document_record(doc, tenant_id, now, doc_id, page_paths):
    """The record kept beside a document's pages."""
    return {"id": doc_id, "tenantId": tenant_id or "", "workerId": doc["workerId"], "createdAt": now,
            "pages": [{"path": path, "doctype": pg["doctype"], "primary": pg["primary"]} for path, pg in zip(page_paths, doc["pages"])],
            "read": doc["read"], "reads": doc["reads"], "scanned": doc["scanned"], "saved": doc["saved"], "corrected": doc["corrected"]}
