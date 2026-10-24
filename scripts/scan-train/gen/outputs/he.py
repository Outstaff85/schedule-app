"""The Hebrew field reader's fields from the phone's own cut (gen/phone_run.py; docs/scan-training.md → "The phone's own
cuts"): on each ID card's front as the lab cut and turned it, every field is cut where the PHONE reads it — the layout's
box (hemodel.layouts: he-layouts.json, the names widened toward their open side) grown by heLine's margins
(gen/phone.py he_rect) — not where the field really lies, so the offset of a real cut is in the training. The text is
the true field's of that role (as written: logical order).

  <run>/he/img/<scene>-<page>-<role>.png        grey, the strip heLine draws from
  <run>/he/labels.tsv   file, text, kind, the page's template sha1 prefix, page type, role, layout, seen, font split, page
  <run>/he/layout_overflow.json   how far the true fields run past their layout boxes: the 99th percentile per side
                                  (shares of the box's width left / right, of its height above / below), by role and
                                  overall — what heLine's margins (hemodel.MARGIN_X / MARGIN_Y) must cover

Read like the phone reads (heRead): only a card cut upright (turn_k 0 — a page the face did not set upright is
skipped and counted) and of a card's shape (1.35–1.85); the layout is the one whose boxes lie nearest the true fields,
and a card near none (mean box IoU under LAYOUT_MIN: a drawn card, another issue's layout) is skipped and counted
("otherLayout") — the phone's boxes there hold other text.
seen: the values from the training vocabulary (False: the check vocabulary); font split: train, or exam when the
scene drew a font heldout.json keeps (examFonts)."""
import functools
import json
import pathlib

DIR = "he"
ASPECT = (1.35, 1.85)   # heRead: an ID card is 85.6 × 54 mm
PCT = 99
LAYOUT_MIN = 0.3        # a card whose fields lie this near a layout's boxes (mean box IoU) is of that layout


@functools.lru_cache(maxsize=1)
def layouts():
    import hemodel
    from .. import common as gc
    marks = json.loads((gc.HERE / "template_fields.json").read_text(encoding="utf-8"))
    return hemodel.layouts(marks)


def _iou(a, b):
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def overflow(field, box):
    """How far a field's box runs past a layout box (both [x, y, w, h] shares): {left, right, top, bottom} — the
    width's sides in shares of the layout box's width, the height's in shares of its height; 0 inside."""
    fx, fy, fw, fh = field
    bx, by, bw, bh = box
    return {"left": max(0.0, (bx - fx) / bw), "right": max(0.0, (fx + fw - bx - bw) / bw),
            "top": max(0.0, (by - fy) / bh), "bottom": max(0.0, (fy + fh - by - bh) / bh)}


def pick_layout(fields, lays=None):
    """The layout whose role boxes lie nearest the true fields' (the mean box IoU over the roles both have) → (name,
    its boxes, the score) or (None, None, score) when none is nearer than LAYOUT_MIN — a card of another layout (a drawn
    card, another issue): the phone's boxes there hold other text, so its fields would be taught wrong labels."""
    lays = lays if lays is not None else layouts()
    by = {}
    for f in fields:
        by.setdefault(f["role"], f["box"])
    best, name = -1.0, None
    for n, boxes in lays.items():
        got = [_iou(by[b["role"]], b["box"]) for b in boxes if b["role"] in by]
        score = sum(got) / len(got) if got else -1.0
        if score > best:
            best, name = score, n
    return (name, lays[name], best) if name is not None and best >= LAYOUT_MIN else (None, None, max(best, 0.0))


def write(folder, res, ctx):
    import cv2
    import numpy as np
    import hemodel
    from .. import phone
    folder = pathlib.Path(folder)
    ents, files = [], []
    for d in res["docs"]:
        t = d["truth"]
        if t.get("doctype") != "id_front" or not d["fields"]:
            continue
        crop = d["crop"]
        H, W = crop.shape[:2]
        why = None
        if d["turnK"] != 0:
            why = "notUpright"
        elif not ASPECT[0] <= W / max(1, H) <= ASPECT[1]:
            why = "aspect"
        name, boxes, score = pick_layout(d["fields"]) if not why else (None, None, None)
        if not why and name is None:
            why = "otherLayout"
        ents.append({"doc": d["j"], "page": d["id"], "why": why, "layout": name,
                     "layoutScore": None if score is None else round(score, 3)})
        if why:
            continue
        by = {}
        for f in d["fields"]:
            by.setdefault(f["role"], f)
        grey = np.clip(np.rint(phone._grey(np.ascontiguousarray(crop[..., ::-1]))), 0, 255).astype(np.uint8)
        for b in boxes:
            f = by.get(b["role"])
            if f is None or not hemodel.readable(f["text"]):
                continue
            rect = phone.he_rect(W, H, b["box"])
            if rect is None:
                continue
            x0, y0, w, h = rect
            part = grey[int(y0):int(np.ceil(y0 + h)), int(x0):int(np.ceil(x0 + w))]
            if not part.size:
                continue
            fname = f"{DIR}/img/{ctx['index']}-{d['j']}-{b['role']}.png"
            cv2.imwrite(str(folder / fname), part)
            files.append(fname)
            ents.append({"doc": d["j"], "file": fname, "text": f["text"], "kind": f.get("kind", f["role"]), "role": b["role"],
                         "tpl": (t.get("templateSha1") or "drawn")[:10], "pageType": t["doctype"], "layout": name,
                         "seen": bool(t.get("seen", True)), "font": ctx.get("fontSplit", "train"), "page": d["id"],
                         "cut_by": d["cutBy"], "overflow": {k: round(v, 4) for k, v in overflow(f["box"], b["box"]).items()}})
    return ents, files


def finish(folder, entries, params):
    import numpy as np
    folder = pathlib.Path(folder)
    crops = [e for e in entries if e.get("file")]
    cols = ("file", "text", "kind", "tpl", "pageType", "role", "layout", "seen", "font", "page")
    (folder / DIR / "labels.tsv").write_text("".join("\t".join(str(e[c] if c != "file" else e[c].rsplit("/", 1)[-1]) for c in cols) + "\n"
                                                     for e in crops), encoding="utf-8")
    sides = ("left", "right", "top", "bottom")

    def pct(vals):
        return round(float(np.percentile(vals, PCT)), 4) if vals else None
    by_role = {}
    for e in crops:
        by_role.setdefault(e["role"], []).append(e["overflow"])
    over = {"percentile": PCT, "n": len(crops), "unit": "left/right: shares of the layout box's width; top/bottom: of its height",
            "byRole": {r: {s: pct([o[s] for o in os]) for s in sides} | {"n": len(os)} for r, os in sorted(by_role.items())},
            "all": {s: pct([e["overflow"][s] for e in crops]) for s in sides},
            "x": pct([max(e["overflow"]["left"], e["overflow"]["right"]) for e in crops]),
            "y": pct([max(e["overflow"]["top"], e["overflow"]["bottom"]) for e in crops])}
    import hemodel
    over["margins"] = {"x": hemodel.MARGIN_X, "y": hemodel.MARGIN_Y,
                       "covers": (over["x"] is None or over["x"] <= hemodel.MARGIN_X) and (over["y"] is None or over["y"] <= hemodel.MARGIN_Y)}
    (folder / DIR / "layout_overflow.json").write_text(json.dumps(over, indent=1), encoding="utf-8")
    skipped = {}
    for e in entries:
        if not e.get("file") and e.get("why"):
            skipped[e["why"]] = skipped.get(e["why"], 0) + 1
    return {"crops": len(crops), "pages": sum(1 for e in entries if not e.get("file")), "skipped": skipped,
            "byRole": {r: len(v) for r, v in sorted(by_role.items())}, "overflow": {"x": over["x"], "y": over["y"],
                                                                               "covered": over["margins"]["covers"]}}
