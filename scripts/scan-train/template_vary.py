"""New documents from the owner's real pages (docs/scan-training.md → 4, "Variations of the real pages"):
a real Israeli ID card, its back or a ספח whose fields are marked in template_fields.json (each field's
box as a share of the page, its kind, and — "same" — the fields that print one value, as the holder's ID
number on every part of a ספח) has every field's text rubbed out (the printed marks inpainted, the card's
ground kept) and a made-up value of its kind (synth.field_value) printed in its place, right-aligned as
the card prints it, in a Hebrew font of the PC, the colour of the text it replaced; the holder's photo
becomes a shape, a code box is scrambled ("scramble") and a number printed sideways is only rubbed out
("erase"). So no data of the real holder stays, and each call gives
another person's document — with every field's text and box known, for the field reader too.

  vary(rng, fonts, "templates/id_front/own-new_type.jpg", spec) → (page, [(kind, text, (x, y, w, h))])

template_fields.json is keyed by "<kind>/<file name>" as the owner uploaded it (templates/<kind>/<name>
in the private bucket; pull_templates.py copies it as own-<name>). A page with no entry there is laid
washed out, as before (synth_docs.washed)."""
import json
import pathlib

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import synth

HERE = pathlib.Path(__file__).resolve().parent
WIDTH = 1200   # the page is worked on at least this wide (the uploads can be small)
_SPECS = None


def specs():
    global _SPECS
    if _SPECS is None:
        p = HERE / "template_fields.json"
        _SPECS = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    return _SPECS


def spec_for(path):
    """The fields marked for a template file (by its kind folder and name, an own- prefix dropped), or None."""
    p = pathlib.Path(path)
    name = p.name[4:] if p.name.startswith("own-") else p.name
    return specs().get(f"{p.parent.name}/{name}")


def _px(box, W, H):
    x, y, w, h = box
    return int(x * W), int(y * H), max(1, int(w * W)), max(1, int(h * H))


def rub_out(img, boxes):
    """The printed marks inside the boxes inpainted away (the ground around them kept); → the image and
    the colour the marks were (the median of the darkest ones)."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mask = np.zeros(g.shape, np.uint8)
    inks = []
    for x, y, w, h in boxes:
        part = g[y:y + h, x:x + w]
        if part.size == 0:
            continue
        local = cv2.blur(part, (max(3, h | 1), max(3, h | 1)))
        ink = (part.astype(np.int16) < local.astype(np.int16) - 18).astype(np.uint8)
        mask[y:y + h, x:x + w] |= ink
        if ink.any():
            inks.append(img[y:y + h, x:x + w][ink > 0])
    mask = cv2.dilate(mask * 255, np.ones((3, 3), np.uint8), iterations=2)
    out = cv2.inpaint(img, mask, 4, cv2.INPAINT_TELEA)
    if inks:
        all_ink = np.concatenate(inks)
        dark = all_ink[all_ink.sum(1) <= np.percentile(all_ink.sum(1), 30)]
        colour = tuple(int(v) for v in np.median(dark if len(dark) else all_ink, 0))
    else:
        colour = (30, 30, 30)
    return out, colour


def fit_font(fonts, rng, text, w, h):
    """A font of the PC's Hebrew ones at the size the box takes (the text's height ~70–85 % of the box,
    no wider than the box)."""
    from synth_docs import RTL
    path = rng.choice(fonts)
    size = max(8, int(h * rng.uniform(0.7, 0.85)))
    from PIL import ImageFont
    while size > 8:
        f = ImageFont.truetype(path, size)
        kw = {"direction": "rtl"} if RTL and any("֐" <= c <= "׿" for c in text) else {}
        x0, _, x1, _ = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), _shown(text), font=f, **kw)
        if x1 - x0 <= w * 0.97:
            return f
        size -= 1
    return ImageFont.truetype(path, 8)


def _shown(text):
    """The text as drawn: with libraqm Pillow lays Hebrew right to left itself; without it, the visual order."""
    from synth_docs import RTL
    if RTL or not any("֐" <= c <= "׿" for c in text):
        return text
    from bidi.algorithm import get_display
    return get_display(text)


def vary(rng, fonts, path, spec):
    """The template at path with every marked field's value made up: (RGB PIL page, [(kind, text, box px)])."""
    from synth_docs import RTL, portrait
    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"cannot read {path}")
    s = max(1.0, WIDTH / img.shape[1])
    if s > 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    H, W = img.shape[:2]
    boxes = [_px(f["box"], W, H) for f in spec["fields"]]
    img, colour = rub_out(img, boxes + [_px(b, W, H) for b in spec.get("erase") or []])   # erase: rubbed out, nothing printed
    for b in spec.get("scramble") or []:   # a printed code (it holds the real holder's data): random squares
        x, y, w, h = _px(b, W, H)
        n = 16
        cells = (np.random.default_rng(rng.randint(0, 1 << 30)).random((n, n)) < 0.5).astype(np.uint8) * 255
        img[y:y + h, x:x + w] = cv2.cvtColor(cv2.resize(255 - cells, (w, h), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
    page = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if spec.get("photo"):
        x, y, w, h = _px(spec["photo"], W, H)
        shape = portrait(rng, w, h)
        ground = page.crop((x, y, x + w, y + h)).filter(ImageFilter.GaussianBlur(max(4, w // 12)))
        page.paste(Image.blend(ground, shape, rng.uniform(0.75, 0.95)), (x, y))
    layer = Image.new("RGBA", page.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    ink = tuple(int(np.clip(c + rng.uniform(-15, 15), 0, 255)) for c in colour[::-1])   # BGR → RGB
    same, out = {}, []
    for f, (x, y, w, h) in zip(spec["fields"], boxes):
        kind = f["kind"]
        key = f.get("same")
        if key and key in same:
            text = same[key]
        else:
            n = max(1, min(9, int(w / (h * 0.62)))) if kind == "digits" else None
            text = synth.field_value(kind, rng, n)
            if key:
                same[key] = text
        font = fit_font(fonts, rng, text, w, h)
        kw = {"direction": "rtl"} if RTL and any("֐" <= c <= "׿" for c in text) else {}
        d.text((x + w - 2, y + h / 2), _shown(text), font=font, fill=(*ink, 255), anchor="rm", **kw)
        out.append((kind, text, (x, y, w, h)))
    layer = layer.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 0.9) * s))
    page = Image.alpha_composite(page.convert("RGBA"), layer).convert("RGB")
    return page, out
