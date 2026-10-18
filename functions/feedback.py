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
KEEP_DAYS = 365
SOURCES = ("model", "phone", "more", "photo", "whole")


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


def check(example):
    """(the example cleaned, None) or (None, why it is refused)."""
    if not isinstance(example, dict):
        return None, "not an object"
    model, fixed = _corners(example.get("cornersModel")), _corners(example.get("cornersFixed"))
    if not model or not fixed:
        return None, "bad corners"
    source = example.get("source") if example.get("source") in SOURCES else "model"
    version = str(example.get("model") or "base-v1")[:40]
    shift = round(moved(model, fixed), 5)
    image = None
    if shift >= MOVED_MIN:  # only a corrected page is kept, so only it carries its copy
        try:
            image = base64.b64decode(str(example.get("image") or ""), validate=True)
        except Exception:
            return None, "bad image"
        if not image.startswith(b"\xff\xd8") or len(image) > MAX_IMAGE_BYTES:
            return None, "the image is not a small JPEG"
    return {"image": image, "cornersModel": model, "cornersFixed": fixed, "source": source, "model": version,
            "moved": shift}, None


def record(ex, tenant_id, now, path):
    """The Firestore record of a kept example (deleted by the TTL policy on deleteAt)."""
    return {"cornersModel": ex["cornersModel"], "cornersFixed": ex["cornersFixed"], "moved": ex["moved"],
            "source": ex["source"], "model": ex["model"], "tenantId": tenant_id or "", "image": path,
            "createdAt": now, "deleteAt": now + datetime.timedelta(days=KEEP_DAYS)}


def image_path(now, doc_id):
    return f"training/scan/{now:%Y-%m}/{doc_id}.jpg"
