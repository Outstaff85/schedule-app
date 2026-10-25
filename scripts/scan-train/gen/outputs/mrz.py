"""The passport zone reader's lines from the phone's own cut (gen/phone_run.py; docs/scan-training.md → "The phone's own
cuts"): on each passport page as the lab cut and turned it, the zone's two lines are found as the phone finds them
(gen/phone.py mrz_find, the lab's mrzFind) and cut out as mrzRead takes them (the box, grey).

  <run>/mrz/img/<scene>-<page>-<line>.png
  <run>/mrz/labels.tsv       file, text, the page's id, find_ok (1: both boxes on their true lines)
  <run>/mrz/pages.json       one entry per passport page: its id, td3, the boxes found, ok, why it failed, how it was
                             cut (cut_by, turn_k, iou) and its two true lines (made-up values) — exam_mrz.py's phone-path
                             exam reads it (photo → edges → cut → turn → find → read: the stage that failed)

A page is TD3 when its zone is two lines of 44. A failed find is counted, not hidden: "none" (fewer than two lines
found), "wrong" (two boxes, not on the true lines — their crops are written with find_ok 0, never to train on as they
are) and "notUpright" (the face did not set the page upright: turn_k ≠ 0)."""
import pathlib

DIR = "mrz"
ROLES = ("mrz1", "mrz2")


def _hit(box, quad):
    """Is the found box (x, y, w, h px) on the true line (its quad in the crop's pixels): the line's middle inside the
    box's height and at least half the line's width under the box."""
    import numpy as np
    q = np.asarray(quad, np.float64)
    x0, y0 = q.min(0)
    x1, y1 = q.max(0)
    cy = (y0 + y1) / 2
    over = min(x1, box["x"] + box["w"]) - max(x0, box["x"])
    return box["y"] <= cy <= box["y"] + box["h"] and over >= 0.5 * (x1 - x0)


def write(folder, res, ctx):
    import cv2
    import numpy as np
    from .. import phone
    folder = pathlib.Path(folder)
    ents, files = [], []
    for d in res["docs"]:
        t = d["truth"]
        if t.get("doctype") != "passport" or not t.get("mrz"):
            continue
        lines = t["mrz"].split("\n")
        td3 = len(lines) == 2 and all(len(x) == 44 for x in lines)
        rgb = np.ascontiguousarray(d["crop"][..., ::-1])
        boxes = phone.mrz_find(rgb) if rgb.size else []
        true = sorted([f for f in d["fields"] if f["role"] in ROLES], key=lambda f: f["role"])
        ok = len(boxes) == 2 and len(true) == 2 and all(_hit(b, f["quad"]) for b, f in zip(boxes, true))
        why = None if ok else ("notUpright" if d["turnK"] not in (0, None) else "none" if len(boxes) < 2 else "wrong")
        ents.append({"doc": d["j"], "page": d["id"], "td3": td3, "found": len(boxes), "ok": ok, "why": why, "cut_by": d["cutBy"],
                     "turn_k": d["turnK"], "iou": d["iou"], "lines": lines if td3 else None})
        if len(boxes) != 2 or not td3:
            continue
        for k, (b, text) in enumerate(zip(boxes, lines)):
            part = rgb[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]]
            if not part.size:
                continue
            name = f"{DIR}/img/{ctx['index']}-{d['j']}-{k + 1}.png"
            cv2.imwrite(str(folder / name), np.clip(np.rint(phone._grey(part)), 0, 255).astype(np.uint8))
            ents.append({"doc": d["j"], "file": name, "text": text, "page": d["id"], "find_ok": ok, "line": k + 1})
            files.append(name)
    return ents, files


def finish(folder, entries, params):
    folder = pathlib.Path(folder)
    lines = [e for e in entries if e.get("file")]
    (folder / DIR / "labels.tsv").write_text("".join(f"{e['file'].rsplit('/', 1)[-1]}\t{e['text']}\t{e['page']}\t{int(e['find_ok'])}\n"
                                                     for e in lines), encoding="utf-8")
    pages = [e for e in entries if not e.get("file")]
    import json
    (folder / DIR / "pages.json").write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    failed = {}
    for e in pages:
        if e["why"]:
            failed[e["why"]] = failed.get(e["why"], 0) + 1
    return {"passports": len(pages), "td3": sum(e["td3"] for e in pages), "ok": sum(e["ok"] for e in pages),
            "failed": failed, "lines": len(lines), "linesFoundRight": sum(bool(e["find_ok"]) for e in lines)}
