"""The firm's signature and stamp (docs/contracts.md → The firm's signature and stamp).

A firm keeps one stamp (a picture: a photo or a scan, its paper made transparent here)
and one signature (drawn with a finger in the app, or a picture) — each a transparent
PNG cropped to its ink, at most 800 px on its long side and 400 KB:

  Firestore tenants/<t>/firmSeal/current
      {stamp: {path, w, h, size, at, by} | None,
       signature: {path, w, h, size, at, by, way: 'drawn' | 'upload'} | None}
  Storage   tenants/<t>/firmSeal/stamp-<ms>.png, tenants/<t>/firmSeal/signature-<ms>.png

Both are written and read only here (the `contract_templates` function): firestore.rules
have no match for firmSeal (deny) and storage.rules keep every browser out of
tenants/<t>/firmSeal/ — another firm never reads them, and inside the firm only the
function does. They stay under tenants/<t>/ so that deleting the firm removes them.

Who may upload, replace or delete them (may_firm_sign — the UI's canFirmSign in
src/manager/logic/access.ts is the same rule): the firm's owner and the super-admin;
a staff or HR login with the right "Firm's signature and stamp; client contracts"
(firmSign). A contract sent to sign carries a frozen copy of both (freeze, at the send:
signing.py; under tenants/<t>/firmSeal/frozen/, as closed to browsers as the originals), so a later change never changes what was sent; contracts.fill draws them —
the signature first, the stamp over it.
"""

import base64
import io
import time

KINDS = ("stamp", "signature")
ACTIONS = ("seal", "sealSave", "sealDelete")
ADMIN_ROLES = ("superadmin", "tenant_admin")
MAX_IN = 8 * 1024 * 1024    # an uploaded picture
MAX_IN_PX = 6000            # …and its long side
OUT_PX = 800                # the stored picture's long side, at most
OUT_BYTES = 400 * 1024      # …and its size
PREVIEW_PX = 400            # the preview the app shows
PAPER = 0.93                # a normalised pixel brighter than this (its darkest channel) is paper
INK = 0.55                  # …and darker than this, full ink

E_NOT_PICTURE = "This file is not a picture"
E_TOO_BIG = "The picture is too big"
E_EMPTY = "Nothing found on the picture"
E_NO_RIGHT = "Only the firm's admin or a login with the right \"Firm's signature and stamp\" changes them"
E_KIND = "Stamp or signature?"


def rights_of(claims):
    rt = claims.get("rt")
    return set(rt) if isinstance(rt, list) else set()


def may_firm_sign(claims):
    """The owner and the super-admin; a staff or HR login with the right firmSign (canFirmSign in access.ts)."""
    role = claims.get("role")
    if role in ADMIN_ROLES:
        return True
    return role in ("staff", "hr") and "firmSign" in rights_of(claims)


# ---- cleaning a picture ----------------------------------------------------------

def _image(data):
    from PIL import Image
    if not data:
        raise ValueError(E_NOT_PICTURE)
    if len(data) > MAX_IN:
        raise ValueError(E_TOO_BIG)
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
        if fmt not in ("PNG", "JPEG", "MPO", "WEBP"):
            raise ValueError(E_NOT_PICTURE)
        if max(im.size) > MAX_IN_PX:
            raise ValueError(E_TOO_BIG)
        im.load()
    except ValueError:
        raise
    except Exception:
        raise ValueError(E_NOT_PICTURE)
    return im, fmt


def _crop_scale(rgba):
    """Cropped to the box of its ink (alpha > 10) plus 4 px, scaled to OUT_PX at most → PIL RGBA; ValueError when empty."""
    from PIL import Image
    a = rgba.getchannel("A").point(lambda v: 255 if v > 10 else 0)
    box = a.getbbox()
    if not box:
        raise ValueError(E_EMPTY)
    x0, y0, x1, y1 = box
    w, h = rgba.size
    out = rgba.crop((max(0, x0 - 4), max(0, y0 - 4), min(w, x1 + 4), min(h, y1 + 4)))
    if max(out.size) > OUT_PX:
        k = OUT_PX / max(out.size)
        out = out.resize((max(1, round(out.width * k)), max(1, round(out.height * k))), Image.LANCZOS)
    return out


def _png(im):
    """A PNG of OUT_BYTES at most → (bytes, w, h)."""
    from PIL import Image
    while True:
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        if len(data) <= OUT_BYTES or max(im.size) < 80:
            return data, im.width, im.height
        im = im.resize((max(1, round(im.width * 0.8)), max(1, round(im.height * 0.8))), Image.LANCZOS)


def _ink(im):
    """A photo or scan of ink on paper → RGBA with the paper transparent. The light is flattened first:
    each pixel is divided by the paper around it (the picture with its ink taken out by a max filter
    on a small copy, then heavily blurred: radius = the long side / 25), so a phone photo's uneven
    paper reads as 1.0; the darkest channel of the result gives the ink's alpha (PAPER → 0, INK → 255)
    and the colour is the normalised colour a little darker."""
    import numpy as np
    from PIL import Image, ImageFilter, ImageOps
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        bg.alpha_composite(rgba)
        im = bg
    im = im.convert("RGB")
    if max(im.size) > 2 * OUT_PX:  # what is kept is OUT_PX at most: work on a copy twice that
        k = 2 * OUT_PX / max(im.size)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    w, h = im.size
    small_k = min(1.0, 200 / max(w, h))
    small = im.resize((max(1, round(w * small_k)), max(1, round(h * small_k))), Image.BILINEAR)
    small = small.filter(ImageFilter.MaxFilter(5))
    small = small.filter(ImageFilter.GaussianBlur(max(1.0, max(small.size) / 25)))
    paper = np.asarray(small.resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0
    rgb = np.asarray(im, dtype=np.float32) / 255.0
    norm = np.clip(rgb / np.maximum(paper, 0.05), 0.0, 1.0)
    m = norm.min(axis=2)
    alpha = np.clip((PAPER - m) / (PAPER - INK), 0.0, 1.0) * 255.0
    colour = np.clip(norm * 0.85, 0.0, 1.0) * 255.0
    out = np.dstack([colour, alpha]).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def clean_stamp(data):
    """An uploaded stamp (PNG, JPEG or WebP, 8 MB and 6000 px at most) → (transparent PNG, w, h); ValueError."""
    im, _ = _image(data)
    return _png(_crop_scale(_ink(im)))


def clean_signature(data, drawn=False):
    """The firm's signature: drawn on the pad (a transparent PNG — only cropped and scaled) or a picture
    (cleaned as a stamp) → (PNG, w, h); ValueError."""
    im, fmt = _image(data)
    if drawn:
        if fmt != "PNG":
            raise ValueError(E_NOT_PICTURE)
        rgba = im.convert("RGBA")
        if rgba.getchannel("A").getextrema()[0] < 255:  # transparent: the pad's own drawing
            return _png(_crop_scale(rgba))
    return _png(_crop_scale(_ink(im)))


# ---- the record and the files ------------------------------------------------------

def _ref(db, tenant):
    return db.collection("tenants").document(tenant).collection("firmSeal").document("current")


def record(db, tenant):
    s = _ref(db, tenant).get()
    return (s.to_dict() or {}) if s.exists else {}


def _read(bucket, path):
    if not path:
        return None
    b = bucket.blob(str(path))
    try:
        return b.download_as_bytes() if b.exists() else None
    except Exception:
        return None


def load(db, bucket, tenant):
    """The firm's current pictures → {"signature": bytes | None, "stamp": bytes | None}."""
    rec = record(db, tenant)
    return {k: _read(bucket, (rec.get(k) or {}).get("path")) for k in ("signature", "stamp")}


FROZEN = {"signature": "company-signature.png", "stamp": "stamp.png"}


def frozen_prefix(tenant, prefix):
    """Where a send's copies go: its folder tenants/<t>/<rest>/ moved under tenants/<t>/firmSeal/frozen/<rest>/, so that
    storage.rules keep every browser out of them as out of the originals."""
    base = f"tenants/{tenant}/"
    rest = prefix[len(base):] if prefix.startswith(base) else prefix
    return base + "firmSeal/frozen/" + rest.strip("/")


def freeze(db, bucket, tenant, prefix):
    """The firm's current pictures copied for a send (prefix: the send's folder) → {"signature": path | None, "stamp": path | None}:
    what the send draws, whatever the firm changes later. The copies sit under tenants/<t>/firmSeal/frozen/ (frozen_prefix),
    never in the send's own folder, which the firm's managers may read."""
    cur = load(db, bucket, tenant)
    out = {}
    for k, name in FROZEN.items():
        if cur.get(k):
            path = frozen_prefix(tenant, prefix) + "/" + name
            bucket.blob(path).upload_from_string(cur[k], content_type="image/png")
            out[k] = path
        else:
            out[k] = None
    return out


def read_frozen(bucket, seal_field):
    """A send's frozen seal (its `seal` field) → {"signature", "stamp", "every_page"} for contracts.fill, or None
    for a send made before the seal (it draws nothing)."""
    if not isinstance(seal_field, dict):
        return None
    return {"signature": _read(bucket, seal_field.get("signature")), "stamp": _read(bucket, seal_field.get("stamp")),
            "every_page": bool(seal_field.get("everyPage"))}


def _preview(png):
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("RGBA")
    if max(im.size) > PREVIEW_PX:
        k = PREVIEW_PX / max(im.size)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def _b64(s):
    try:
        return base64.b64decode(str(s or "").split(",")[-1], validate=False)
    except Exception:
        return b""


def _state(db, bucket, tenant, claims):
    rec = record(db, tenant)
    out = {"ok": True, "hasStamp": bool(rec.get("stamp")), "hasSignature": bool(rec.get("signature")),
           "canFirmSign": may_firm_sign(claims)}
    if out["canFirmSign"]:
        previews = {}
        for k in KINDS:
            png = _read(bucket, (rec.get(k) or {}).get("path"))
            previews[k] = _preview(png) if png else None
        out["previews"] = previews
        out["signatureWay"] = (rec.get("signature") or {}).get("way")
    return out


def run(db, bucket, claims, body, tenant):
    """seal / sealSave / sealDelete of the `contract_templates` function (contracts.run passes the firm:
    the caller's own, a super-admin's the one it views)."""
    action = str(body.get("action") or "")
    if action == "seal":
        return _state(db, bucket, tenant, claims)
    if not may_firm_sign(claims):
        return {"error": E_NO_RIGHT}
    kind = str(body.get("kind") or "")
    if kind not in KINDS:
        return {"error": E_KIND}
    ref = _ref(db, tenant)
    rec = record(db, tenant)
    old = (rec.get(kind) or {}).get("path")

    if action == "sealSave":
        data = _b64(body.get("imageBase64"))
        drawn = kind == "signature" and bool(body.get("drawn"))
        try:
            png, w, h = clean_signature(data, drawn) if kind == "signature" else clean_stamp(data)
        except ValueError as e:
            return {"error": str(e)}
        path = f"tenants/{tenant}/firmSeal/{kind}-{int(time.time() * 1000)}.png"
        bucket.blob(path).upload_from_string(png, content_type="image/png")
        item = {"path": path, "w": w, "h": h, "size": len(png), "at": _now(), "by": claims.get("uid", "")}
        if kind == "signature":
            item["way"] = "drawn" if drawn else "upload"
        rec[kind] = item
        if ref.get().exists:
            ref.update({kind: item})
        else:
            ref.set({k: rec.get(k) for k in KINDS})
        if old and old != path:
            b = bucket.blob(old)
            if b.exists():
                b.delete()
        return dict(_state(db, bucket, tenant, claims), preview=_preview(png))

    if action == "sealDelete":
        if old:
            b = bucket.blob(old)
            if b.exists():
                b.delete()
        if ref.get().exists:
            ref.update({kind: None})
        return _state(db, bucket, tenant, claims)

    return {"error": "Unknown action"}
