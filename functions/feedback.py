"""The scanner's training examples (docs/scan-plan.md → S6): a page whose corners the
user moved in the scan window teaches the corner model. The phone sends, per page,
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
KIND_AT = 100              # page copies of each kind that make the first page-kind model due
KEEP_DAYS = 365
SOURCES = ("model", "phone", "more", "photo", "whole")
KINDS = ("id_front", "id_back", "sefach", "passport", "contract", "other")
KINDS_TRAINED = KINDS[:5]  # the kinds the page-kind model must have enough of ("other" is rare by design)


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
    corners were moved (with the copy of the part the model saw) or its kind was changed
    (with a copy of the page); otherwise it is only counted."""
    if not isinstance(example, dict):
        return None, "not an object"
    model, fixed = _corners(example.get("cornersModel")), _corners(example.get("cornersFixed"))
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
    kind_model = example.get("kindModel") if example.get("kindModel") in KINDS else None
    kind_fixed = example.get("kindFixed") if example.get("kindFixed") in KINDS else kind_model
    kind_by = "model" if example.get("kindBy") == "model" else "haiku"  # who gave kindModel (S7)
    page_image = None
    if kind_model and kind_fixed != kind_model:
        page_image = _jpeg(example.get("pageImage"))
        if page_image is None:
            return None, "a changed kind needs a small JPEG of the page"
    elif kind_model and keep_right:  # a sampled right page also teaches the kind model; its copy is optional
        page_image = _jpeg(example.get("pageImage"))
    return {"image": image, "cornersModel": model, "cornersFixed": fixed, "source": source, "model": version,
            "moved": shift, "kindModel": kind_model, "kindFixed": kind_fixed, "kindBy": kind_by, "pageImage": page_image, "right": keep_right}, None


def kept(ex):
    """Whether the example is kept (its corners moved, its kind changed, or a sampled page the
    model got right), else only counted."""
    return ex["moved"] >= MOVED_MIN or ex["pageImage"] is not None or ex["right"]


def correction(ex):
    """Whether the example corrects the model (counts toward retraining); a kept right one does not."""
    return ex["moved"] >= MOVED_MIN or (ex["kindModel"] is not None and ex["kindFixed"] != ex["kindModel"])


def kind_counts(stats):
    """The page copies of each kind since the last page-kind training (stats.kindsSince)."""
    got = stats.get("kindsSince") if isinstance(stats.get("kindsSince"), dict) else {}
    return {k: int(got.get(k) or 0) for k in KINDS}


def kinds_due(stats):
    """Whether the page-kind model can be trained: KIND_AT copies of every trained kind."""
    counts = kind_counts(stats)
    return all(counts[k] >= KIND_AT for k in KINDS_TRAINED)


def record(ex, tenant_id, now, path, page_path=None):
    """The Firestore record of a kept example (deleted by the TTL policy on deleteAt).
    path: the corners' copy (None when only the kind was changed); page_path: the page's."""
    return {"cornersModel": ex["cornersModel"], "cornersFixed": ex["cornersFixed"], "moved": ex["moved"],
            "source": ex["source"], "model": ex["model"], "tenantId": tenant_id or "", "image": path,
            "kindModel": ex["kindModel"], "kindFixed": ex["kindFixed"], "kindBy": ex.get("kindBy", "haiku"), "pageImage": page_path, "right": ex["right"],
            "createdAt": now, "deleteAt": now + datetime.timedelta(days=KEEP_DAYS)}


def image_path(now, doc_id, suffix=""):
    return f"training/scan/{now:%Y-%m}/{doc_id}{suffix}.jpg"
